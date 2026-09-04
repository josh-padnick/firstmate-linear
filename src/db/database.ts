import { copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { ensurePrivateDir } from "../fsutil.ts";
import { sha256, uuid } from "../hash.ts";
import { runtimePaths } from "../paths.ts";
import { compareIso, formatIso, nowIso, parseIso } from "../time.ts";
import { MIGRATE_TO_V2_SQL, MIGRATE_TO_V4_SQL, MIGRATE_TO_V5_SQL, MIGRATE_TO_V6_SQL, MIGRATE_TO_V7_SQL, MIGRATE_TO_V8_SQL, MIGRATE_TO_V9_SQL, MIGRATE_TO_V10_SQL, MIGRATE_TO_V11_SQL, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

export type EventDisposition =
  | "captured"
  | "classified"
  | "waiting-for-core"
  | "handled-by-service"
  | "ignored"
  | "handled-by-core"
  | "failed";

export type DomainEvent = {
  id: string;
  team: string;
  issue: string;
  type: string;
  token: string;
  author: string;
  body_sha: string | null;
  created_at: string;
  captured_at: string;
  disposition: EventDisposition;
  disposition_at: string;
  note: string | null;
  receipt_id: string | null;
  raw_ref: string;
};

export type NewEvent = Omit<DomainEvent, "disposition_at" | "receipt_id"> & {
  disposition_at?: string;
  receipt_id?: string | null;
};

export type JobState = "pending" | "running" | "retry" | "done" | "dead";

export type Job = {
  id: string;
  key: string;
  kind: string;
  target: string;
  payload: string;
  state: JobState;
  attempts: number;
  next_attempt_at: string;
  native_id: string | null;
  last_error: string | null;
  created_at: string;
  done_at: string | null;
};

export type NewJob = {
  key: string;
  kind: string;
  target: string;
  payload: unknown;
  nextAttemptAt?: string;
};

export type PromiseState = "pending" | "open" | "kept" | "overdue" | "superseded" | "failed";

export type PromiseSourceWatermarks = Record<string, {
  status?: { identity: string | null; offset: number };
  pr?: { reported: string | null; state: string | null; stateKnown: boolean };
}>;

export type PromiseRecord = {
  id: string;
  issue: string;
  source_event_id: string;
  expected_event: string;
  deadline_at: string;
  reply_job_id: string;
  reply_comment_id: string | null;
  created_at: string;
  state: PromiseState;
  observation_id: string | null;
  superseded_by: string | null;
  stalled_event_id: string | null;
  source_watermarks: string | null;
};

export type NewPromise = Pick<PromiseRecord, "issue" | "source_event_id" | "expected_event" | "deadline_at" | "reply_job_id" | "created_at">;

export type IssueSnapshot = {
  issue: string;
  state: string;
  assignee: string | null;
  labels: string[];
  agent_label: string | null;
  last_actor: string | null;
  last_signal: string | null;
  managed: boolean;
  observed_at: string;
};

export type NewIssueSnapshot = Omit<IssueSnapshot, "managed"> & { managed?: boolean };

export type TaskLink = {
  lifecycle_id: string;
  task: string;
  issue: string;
  role: "primary" | "support";
  worktree: string | null;
  harness: string | null;
  spawned_at: string;
  torn_down_at: string | null;
  status_start_offset: number | null;
  status_end_offset: number | null;
  status_start_identity: string | null;
  status_end_identity: string | null;
  meta_generation: string | null;
  busy_generation: string | null;
  blocked_meta_generation: string | null;
  blocked_busy_generation: string | null;
};

export type NewTaskLink = Omit<TaskLink, "lifecycle_id" | "status_start_offset" | "status_end_offset" | "status_start_identity" | "status_end_identity" | "meta_generation" | "busy_generation" | "blocked_meta_generation" | "blocked_busy_generation"> & {
  lifecycle_id?: string;
  status_start_offset?: number | null;
  status_end_offset?: number | null;
  status_start_identity?: string | null;
  status_end_identity?: string | null;
  meta_generation?: string | null;
  busy_generation?: string | null;
  blocked_meta_generation?: string | null;
  blocked_busy_generation?: string | null;
};

export type Observation = {
  id: string;
  source: "status" | "summary" | "pr" | "linear";
  task: string | null;
  task_spawned_at?: string | null;
  task_lifecycle_id?: string | null;
  issue: string;
  verb: string;
  key: string;
  note: string | null;
  source_identity?: string | null;
  source_offset?: number | null;
  observed_at: string;
};

export function observationBelongsToTaskLink(observation: Observation, link: TaskLink): boolean {
  if (observation.issue !== link.issue || observation.task !== link.task) return false;
  if (observation.task_lifecycle_id) return observation.task_lifecycle_id === link.lifecycle_id;
  if (observation.task_spawned_at && observation.task_spawned_at !== link.spawned_at) return false;
  const afterSpawn = compareIso(observation.observed_at, link.spawned_at);
  if (afterSpawn === null || afterSpawn < 0) return false;
  if (!link.torn_down_at) return true;
  const beforeTeardown = compareIso(observation.observed_at, link.torn_down_at);
  return beforeTeardown !== null && (observation.task_spawned_at ? beforeTeardown <= 0 : beforeTeardown < 0);
}

function stampForPath(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function currentVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
  return Number(row?.user_version ?? 0);
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function backupBeforeMigration(path: string, backupDir: string, version: number): string | null {
  if (!existsSync(path) || version === 0) return null;
  ensurePrivateDir(backupDir);
  const destination = join(backupDir, `${basename(path)}.v${version}.${stampForPath()}.backup`);
  copyFileSync(path, destination);
  return destination;
}

export class StateDatabase {
  readonly raw: Database;
  readonly path: string;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(path: string, backupDir: string) {
    ensurePrivateDir(path.slice(0, path.lastIndexOf("/")));
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const from = currentVersion(db);
    if (from > SCHEMA_VERSION) {
      db.close();
      throw new Error(`database schema ${from} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    if (from < SCHEMA_VERSION) {
      if (from > 0) {
        db.exec("PRAGMA wal_checkpoint(FULL)");
        backupBeforeMigration(path, backupDir, from);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(SCHEMA_SQL);
        if (from === 1) db.exec(MIGRATE_TO_V2_SQL);
        if (from === 3) db.exec(MIGRATE_TO_V4_SQL);
        if (from > 0 && from < 5 && !tableHasColumn(db, "task_links", "lifecycle_id")) db.exec(MIGRATE_TO_V5_SQL);
        if (from > 0 && from < 6 && !tableHasColumn(db, "observations", "task_spawned_at")) db.exec(MIGRATE_TO_V6_SQL);
        if (from > 0 && from < 7 && !tableHasColumn(db, "task_links", "lifecycle_id")) db.exec(MIGRATE_TO_V7_SQL);
        if (from > 0 && from < 8 && !tableHasColumn(db, "issue_snapshots", "managed")) db.exec(MIGRATE_TO_V8_SQL);
        if (from > 0 && from < 9 && !tableHasColumn(db, "task_links", "status_start_offset")) db.exec(MIGRATE_TO_V9_SQL);
        if (from > 0 && from < 10 && !tableHasColumn(db, "task_links", "status_start_identity")) db.exec(MIGRATE_TO_V10_SQL);
        if (from > 0 && from < 11 && !tableHasColumn(db, "observations", "source_identity")) db.exec(MIGRATE_TO_V11_SQL);
        if (from > 0 && from < 11 && !tableHasColumn(db, "promises", "source_watermarks")) db.exec("ALTER TABLE promises ADD COLUMN source_watermarks TEXT");
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
      }
    }
    this.raw = db;
    this.path = path;
  }

  static open(env: NodeJS.ProcessEnv = process.env): StateDatabase {
    const paths = runtimePaths(env);
    return new StateDatabase(paths.database, paths.databaseBackups);
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const savepoint = `nested_${this.savepointSequence += 1}`;
      this.raw.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const value = fn();
        this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const value = fn();
      this.raw.exec("COMMIT");
      return value;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  cursor(name: string): string | null {
    const row = this.raw.query("SELECT value FROM source_cursors WHERE name = ?").get(name) as { value: string } | null;
    return row?.value ?? null;
  }

  setCursor(name: string, value: string, at = nowIso()): void {
    this.raw.query(`INSERT INTO source_cursors(name,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(name, value, at);
  }

  capture(event: NewEvent, jobs: NewJob[] = []): boolean {
    return this.transaction(() => {
      const result = this.raw.query(`INSERT OR IGNORE INTO events(
        id,team,issue,type,token,author,body_sha,created_at,captured_at,
        disposition,disposition_at,note,receipt_id,raw_ref
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        event.id, event.team, event.issue, event.type, event.token, event.author,
        event.body_sha, event.created_at, event.captured_at, event.disposition,
        event.disposition_at ?? event.captured_at, event.note, event.receipt_id ?? null,
        event.raw_ref,
      );
      if (result.changes === 0) return false;
      for (const job of jobs) this.enqueue(job, event.captured_at);
      return true;
    });
  }

  event(id: string): DomainEvent | null {
    return this.raw.query("SELECT * FROM events WHERE id = ?").get(id) as DomainEvent | null;
  }

  findEvent(idOrPrefix: string): DomainEvent | null {
    const exact = this.event(idOrPrefix);
    if (exact) return exact;
    const rows = this.raw.query("SELECT * FROM events WHERE id LIKE ? ORDER BY created_at").all(`${idOrPrefix}%`) as DomainEvent[];
    if (rows.length > 1) throw new Error(`ambiguous event id prefix: ${idOrPrefix}`);
    return rows[0] ?? null;
  }

  listEvents(dispositions?: EventDisposition[], since?: string): DomainEvent[] {
    const clauses: string[] = [];
    const args: Array<string> = [];
    if (dispositions?.length) {
      clauses.push(`disposition IN (${dispositions.map(() => "?").join(",")})`);
      args.push(...dispositions);
    }
    if (since) {
      clauses.push("created_at > ?");
      args.push(since);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.raw.query(`SELECT * FROM events${where} ORDER BY created_at,id`).all(...args) as DomainEvent[];
  }

  eventsAfterRowid(rowid: number): Array<{ rowid: number; event: DomainEvent }> {
    const rows = this.raw.query("SELECT rowid AS _rowid,* FROM events WHERE rowid>? ORDER BY rowid").all(rowid) as Array<DomainEvent & { _rowid: number }>;
    return rows.map(({ _rowid, ...event }) => ({ rowid: _rowid, event }));
  }

  setDisposition(id: string, disposition: EventDisposition, note: string | null = null, at = nowIso()): void {
    this.raw.query("UPDATE events SET disposition=?,disposition_at=?,note=COALESCE(?,note) WHERE id=?")
      .run(disposition, at, note, id);
  }

  delivery(requestId: string, sequence: number, eventId: string, at = nowIso()): void {
    this.raw.query(`INSERT INTO core_deliveries(core_request_id,core_seq,event_id,delivered_at)
      VALUES(?,?,?,?) ON CONFLICT(core_request_id,core_seq) DO NOTHING`).run(requestId, sequence, eventId, at);
  }

  deliveredEvent(requestId: string, sequence: number): DomainEvent | null {
    return this.raw.query(`SELECT e.* FROM core_deliveries d JOIN events e ON e.id=d.event_id
      WHERE d.core_request_id=?`).get(requestId) as DomainEvent | null;
  }

  bindDeliverySequence(eventId: string, sequence: number, at = nowIso()): void {
    this.transaction(() => {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`invalid core sequence: ${sequence}`);
      const current = this.raw.query("SELECT core_seq FROM core_deliveries WHERE event_id=?").get(eventId) as { core_seq: number } | null;
      if (!current) throw new Error(`core delivery not found: ${eventId}`);
      if (current.core_seq !== 0 && current.core_seq !== sequence) {
        throw new Error(`core sequence conflict for ${eventId}: ${current.core_seq} != ${sequence}`);
      }
      if (current.core_seq === 0) this.raw.query("UPDATE core_deliveries SET core_seq=? WHERE event_id=?").run(sequence, eventId);
      this.enqueueCoreAckIfBound(eventId, at);
    });
  }

  deliveryForEvent(eventId: string): { core_request_id: string; core_seq: number; handled_at: string | null } | null {
    return this.raw.query("SELECT core_request_id,core_seq,handled_at FROM core_deliveries WHERE event_id=?")
      .get(eventId) as { core_request_id: string; core_seq: number; handled_at: string | null } | null;
  }

  markDeliveryHandled(eventId: string, at = nowIso()): void {
    this.raw.query("UPDATE core_deliveries SET handled_at=? WHERE event_id=?").run(at, eventId);
  }

  private enqueueCoreAckIfBound(eventId: string, at: string): void {
    const delivery = this.deliveryForEvent(eventId);
    const event = this.event(eventId);
    if (!delivery || delivery.core_seq <= 0 || delivery.handled_at || event?.disposition !== "handled-by-core") return;
    this.enqueue({ key: `${eventId}:core-ack`, kind: "core.ack", target: eventId, payload: { event_id: eventId, source_id: "linear-main" } }, at);
  }

  nextForCore(requestId: string, sequence: number, at = nowIso()): DomainEvent | null {
    return this.transaction(() => {
      const prior = this.deliveredEvent(requestId, sequence);
      if (prior) return prior;
      const event = this.raw.query(`SELECT * FROM events WHERE disposition IN ('waiting-for-core','handled-by-service','ignored')
        AND id NOT IN (SELECT event_id FROM core_deliveries) ORDER BY rowid LIMIT 1`).get() as DomainEvent | null;
      if (!event) return null;
      this.delivery(requestId, sequence, event.id, at);
      return event;
    });
  }

  markCoreHandled(eventId: string, note: string | null, at = nowIso()): void {
    this.transaction(() => {
      this.setDisposition(eventId, "handled-by-core", note, at);
      this.raw.query("UPDATE core_deliveries SET handled_at=? WHERE event_id=?").run(at, eventId);
    });
  }

  issueReceipt(eventIds: string[], at = nowIso()): string {
    if (eventIds.length === 0) throw new Error("cannot issue an empty receipt");
    return this.transaction(() => {
      for (const eventId of eventIds) {
        const event = this.event(eventId);
        if (!event || event.disposition !== "waiting-for-core") {
          throw new Error(`event is not awaiting core handling: ${eventId}`);
        }
      }
      const id = uuid();
      const watermark = this.raw.query("SELECT COALESCE(MAX(rowid),0) AS rowid FROM events").get() as { rowid: number };
      this.raw.query("INSERT INTO receipts(id,event_ids,issued_at,event_rowid) VALUES(?,?,?,?)")
        .run(id, JSON.stringify(eventIds), at, watermark.rowid);
      for (const eventId of eventIds) {
        this.raw.query("UPDATE events SET receipt_id=? WHERE id=?").run(id, eventId);
      }
      return id;
    });
  }

  receipt(id: string): { id: string; event_ids: string[]; issued_at: string; event_rowid: number; consumed_at: string | null } | null {
    const row = this.raw.query("SELECT * FROM receipts WHERE id=?").get(id) as { id: string; event_ids: string; issued_at: string; event_rowid: number; consumed_at: string | null } | null;
    return row ? { ...row, event_ids: JSON.parse(row.event_ids) as string[] } : null;
  }

  consumeReceipt(id: string, at = nowIso()): void {
    const result = this.raw.query("UPDATE receipts SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(at, id);
    if (result.changes !== 1) throw new Error(`receipt missing or already consumed: ${id}`);
  }

  handleWithReceipt(eventId: string, receiptId: string, captain: string, note: string | null, at = nowIso()): void {
    this.transaction(() => {
      const receipt = this.receipt(receiptId);
      if (!receipt || receipt.consumed_at || !receipt.event_ids.includes(eventId)) {
        throw new Error("receipt does not authorize that event");
      }
      const authorized = this.event(eventId);
      if (!authorized) throw new Error(`event not found: ${eventId}`);
      this.assertReceiptFresh(authorized.issue, captain, receipt);
      const result = this.raw.query("UPDATE events SET disposition='handled-by-core',disposition_at=?,note=COALESCE(?,note) WHERE id=? AND disposition='waiting-for-core'")
        .run(at, note, eventId);
      if (result.changes !== 1) throw new Error(`event is not awaiting core handling: ${eventId}`);
      this.enqueueCoreAckIfBound(eventId, at);
      this.raw.query("UPDATE receipts SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(at, receiptId);
    });
  }

  actWithReceipt(options: {
    receiptId: string;
    issue: string;
    captain: string;
    jobs: NewJob[];
    promise?: Omit<NewPromise, "source_event_id" | "reply_job_id">;
    note: string;
    at?: string;
  }): string[] {
    const at = options.at ?? nowIso();
    return this.transaction(() => {
      const receipt = this.receipt(options.receiptId);
      if (!receipt || receipt.consumed_at) throw new Error(`receipt missing or already consumed: ${options.receiptId}`);
      const events = receipt.event_ids.map((id) => this.event(id)).filter((event): event is DomainEvent => event !== null);
      const relevant = events.filter((event) => event.issue === options.issue && event.disposition === "waiting-for-core");
      if (!relevant.length) throw new Error(`receipt does not contain an event for ${options.issue}`);
      this.assertReceiptFresh(options.issue, options.captain, receipt);
      const enqueued = options.jobs.map((job) => this.enqueue(job, at));
      if (options.promise) {
        const reply = enqueued.find((job) => job.kind === "linear.comment");
        if (!reply) throw new Error("a promise requires a captain-facing reply job");
        this.stagePromise({ ...options.promise, source_event_id: relevant.at(-1)!.id, reply_job_id: reply.id });
      }
      for (const event of relevant) {
        this.raw.query("UPDATE events SET disposition='handled-by-core',disposition_at=?,note=? WHERE id=?")
          .run(at, options.note, event.id);
        this.enqueueCoreAckIfBound(event.id, at);
      }
      this.raw.query("UPDATE receipts SET consumed_at=? WHERE id=?").run(at, options.receiptId);
      return relevant.map((event) => event.id);
    });
  }

  newerCaptainEvent(issue: string, after: string, captain: string): DomainEvent | null {
    return this.raw.query(`SELECT * FROM events WHERE issue=? AND author=? AND created_at>?
      AND type='comment' ORDER BY created_at DESC LIMIT 1`).get(issue, captain, after) as DomainEvent | null;
  }

  newerCaptainEventAfterRowid(issue: string, afterRowid: number, captain: string): DomainEvent | null {
    return this.raw.query(`SELECT * FROM events WHERE issue=? AND author=? AND rowid>?
      AND type='comment' ORDER BY rowid DESC LIMIT 1`).get(issue, captain, afterRowid) as DomainEvent | null;
  }

  private newestAuthorizedRowid(issue: string, eventIds: string[]): number {
    const rows = eventIds.map((id) => this.raw.query("SELECT rowid,issue FROM events WHERE id=?").get(id) as { rowid: number; issue: string } | null);
    return Math.max(0, ...rows.filter((row): row is { rowid: number; issue: string } => row?.issue === issue).map((row) => row.rowid));
  }

  private assertReceiptFresh(issue: string, captain: string, receipt: { event_ids: string[]; event_rowid: number }): void {
    for (const boundary of [this.newestAuthorizedRowid(issue, receipt.event_ids), receipt.event_rowid]) {
      const newer = this.newerCaptainEventAfterRowid(issue, boundary, captain);
      if (newer && !receipt.event_ids.includes(newer.id)) throw new Error(`stale receipt: newer captain event ${newer.id} must be read first`);
    }
  }

  enqueue(job: NewJob, at = nowIso()): Job {
    const id = `job:${sha256(job.key)}`;
    this.raw.query(`INSERT INTO jobs(id,key,kind,target,payload,state,attempts,next_attempt_at,created_at)
      VALUES(?,?,?,?,?,'pending',0,?,?) ON CONFLICT(key) DO NOTHING`).run(
        id, job.key, job.kind, job.target, JSON.stringify(job.payload), job.nextAttemptAt ?? at, at,
      );
    return this.raw.query("SELECT * FROM jobs WHERE key=?").get(job.key) as Job;
  }

  enqueueReconciliation(job: NewJob, at = nowIso()): Job {
    const existing = this.raw.query("SELECT state FROM jobs WHERE key=?").get(job.key) as { state: JobState } | null;
    if (existing && (existing.state === "done" || existing.state === "dead")) {
      this.raw.query(`UPDATE jobs SET kind=?,target=?,payload=?,state='pending',attempts=0,next_attempt_at=?,last_error=NULL,native_id=NULL,done_at=NULL WHERE key=?`)
        .run(job.kind, job.target, JSON.stringify(job.payload), job.nextAttemptAt ?? at, job.key);
    } else this.enqueue(job, at);
    return this.raw.query("SELECT * FROM jobs WHERE key=?").get(job.key) as Job;
  }

  rebindWaitingEventJobs(fromEventId: string, toEventId: string): void {
    const rows = this.raw.query("SELECT id,payload FROM jobs WHERE state IN ('pending','retry','running')").all() as Array<{ id: string; payload: string }>;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
      if (payload.waiting_event_id !== fromEventId) continue;
      this.raw.query("UPDATE jobs SET payload=? WHERE id=?").run(JSON.stringify({ ...payload, waiting_event_id: toEventId }), row.id);
    }
  }

  claimDueJobs(limit = 20, at = nowIso()): Job[] {
    const epoch = parseIso(at);
    if (epoch === null) throw new Error(`invalid job claim time: ${at}`);
    const leaseUntil = formatIso(epoch + 5 * 60);
    return this.transaction(() => {
      const jobs = this.raw.query(`SELECT * FROM jobs WHERE state IN ('pending','retry','running')
        AND next_attempt_at<=? ORDER BY created_at LIMIT ?`).all(at, limit) as Job[];
      for (const job of jobs) {
        this.raw.query("UPDATE jobs SET state='running',attempts=attempts+1,next_attempt_at=? WHERE id=?").run(leaseUntil, job.id);
      }
      return jobs.map((job) => ({ ...job, state: "running", attempts: job.attempts + 1, next_attempt_at: leaseUntil }));
    });
  }

  finishJob(id: string, nativeId: string | null = null, at = nowIso(), sourceWatermarks: PromiseSourceWatermarks | null = null): void {
    this.transaction(() => {
      this.raw.query("UPDATE jobs SET state='done',native_id=COALESCE(?,native_id),done_at=?,last_error=NULL WHERE id=?")
        .run(nativeId, at, id);
      if (!nativeId) return;
      const pending = this.raw.query("SELECT rowid AS _rowid,id,issue,created_at,deadline_at FROM promises WHERE reply_job_id=? AND state='pending'").get(id) as {
        _rowid: number;
        id: string;
        issue: string;
        created_at: string;
        deadline_at: string;
      } | null;
      if (pending) {
        const stagedAt = parseIso(pending.created_at);
        const stagedDeadline = parseIso(pending.deadline_at);
        const deliveredAt = parseIso(at);
        if (stagedAt === null || stagedDeadline === null || deliveredAt === null || stagedDeadline <= stagedAt) {
          throw new Error(`invalid staged promise window: ${pending.id}`);
        }
        const newer = this.raw.query(`SELECT id FROM promises WHERE issue=? AND rowid>?
          AND state IN ('open','overdue','kept') ORDER BY rowid DESC LIMIT 1`).get(pending.issue, pending._rowid) as { id: string } | null;
        if (newer) {
          this.raw.query("UPDATE promises SET state='superseded',superseded_by=?,reply_comment_id=? WHERE id=? AND state='pending'")
            .run(newer.id, nativeId, pending.id);
          return;
        }
        const deliveredDeadline = formatIso(deliveredAt + stagedDeadline - stagedAt);
        this.raw.query("UPDATE promises SET state='superseded',superseded_by=? WHERE issue=? AND state IN ('open','overdue') AND id<>?")
          .run(pending.id, pending.issue, pending.id);
        this.raw.query("UPDATE promises SET state='open',reply_comment_id=?,created_at=?,deadline_at=?,source_watermarks=? WHERE id=? AND state='pending'")
          .run(nativeId, at, deliveredDeadline, sourceWatermarks ? JSON.stringify(sourceWatermarks) : null, pending.id);
      } else {
        this.raw.query("UPDATE promises SET reply_comment_id=? WHERE reply_job_id=?").run(nativeId, id);
      }
    });
  }

  skipJob(id: string, reason: string, at = nowIso()): void {
    this.transaction(() => {
      this.raw.query("UPDATE jobs SET state='done',done_at=?,last_error=? WHERE id=?")
        .run(at, `skipped: ${reason}`.slice(0, 2000), id);
      this.raw.query("UPDATE promises SET state='failed' WHERE reply_job_id=? AND state='pending'").run(id);
    });
  }

  retryJob(id: string, error: string, nextAttemptAt: string, dead = false): void {
    this.raw.query("UPDATE jobs SET state=?,last_error=?,next_attempt_at=? WHERE id=?")
      .run(dead ? "dead" : "retry", error.slice(0, 2000), nextAttemptAt, id);
    if (dead) this.raw.query("UPDATE promises SET state='failed' WHERE reply_job_id=? AND state='pending'").run(id);
  }

  jobs(states?: JobState[]): Job[] {
    if (!states?.length) return this.raw.query("SELECT * FROM jobs ORDER BY created_at").all() as Job[];
    return this.raw.query(`SELECT * FROM jobs WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`).all(...states) as Job[];
  }

  snapshot(value: NewIssueSnapshot): void {
    this.raw.query(`INSERT INTO issue_snapshots(
      issue,state,assignee,labels,agent_label,last_actor,last_signal,managed,observed_at
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(issue,observed_at) DO UPDATE SET
      state=excluded.state,assignee=excluded.assignee,labels=excluded.labels,agent_label=excluded.agent_label,
      last_actor=excluded.last_actor,last_signal=excluded.last_signal,managed=excluded.managed`).run(
      value.issue, value.state, value.assignee, JSON.stringify(value.labels), value.agent_label,
      value.last_actor, value.last_signal, value.managed === false ? 0 : 1, value.observed_at,
    );
  }

  latestSnapshot(issue: string): IssueSnapshot | null {
    const row = this.raw.query("SELECT * FROM issue_snapshots WHERE issue=? ORDER BY observed_at DESC LIMIT 1").get(issue) as (Omit<IssueSnapshot, "labels" | "managed"> & { labels: string; managed: number }) | null;
    return row ? { ...row, labels: JSON.parse(row.labels) as string[], managed: row.managed === 1 } : null;
  }

  latestSnapshots(): IssueSnapshot[] {
    const rows = this.raw.query(`SELECT s.* FROM issue_snapshots s JOIN (
      SELECT issue,MAX(observed_at) observed_at FROM issue_snapshots GROUP BY issue
    ) latest ON latest.issue=s.issue AND latest.observed_at=s.observed_at ORDER BY s.issue`).all() as Array<Omit<IssueSnapshot, "labels" | "managed"> & { labels: string; managed: number }>;
    return rows.map((row) => ({ ...row, labels: JSON.parse(row.labels) as string[], managed: row.managed === 1 }));
  }

  snapshots(issue: string): IssueSnapshot[] {
    const rows = this.raw.query("SELECT * FROM issue_snapshots WHERE issue=? ORDER BY rowid").all(issue) as Array<Omit<IssueSnapshot, "labels" | "managed"> & { labels: string; managed: number }>;
    return rows.map((row) => ({ ...row, labels: JSON.parse(row.labels) as string[], managed: row.managed === 1 }));
  }

  linkTask(value: NewTaskLink): void {
    this.transaction(() => {
      if (!value.torn_down_at) {
        const active = this.raw.query(`SELECT * FROM task_links WHERE task=? AND issue=? AND torn_down_at IS NULL
          ORDER BY spawned_at LIMIT 1`).get(value.task, value.issue) as TaskLink | null;
        if (active) {
          if (active.role === value.role) {
            this.raw.query("UPDATE task_links SET worktree=?,harness=? WHERE lifecycle_id=?")
              .run(value.worktree, value.harness, active.lifecycle_id);
            this.raw.query("DELETE FROM task_links WHERE task=? AND issue=? AND torn_down_at IS NULL AND lifecycle_id<>?")
              .run(active.task, active.issue, active.lifecycle_id);
            return;
          }
          if (compareIso(value.spawned_at, active.spawned_at) !== 1) {
            throw new Error(`task role change requires a later lifecycle start: ${value.task} ${value.issue}`);
          }
          this.raw.query("UPDATE task_links SET torn_down_at=?,status_end_offset=?,status_end_identity=?,meta_generation=?,busy_generation=? WHERE task=? AND issue=? AND torn_down_at IS NULL")
            .run(value.spawned_at, value.status_start_offset ?? null, value.status_start_identity ?? null, value.meta_generation ?? null, value.busy_generation ?? null, value.task, value.issue);
        }
      }
      this.raw.query(`INSERT INTO task_links(lifecycle_id,task,issue,role,worktree,harness,spawned_at,torn_down_at,status_start_offset,status_end_offset,status_start_identity,status_end_identity,meta_generation,busy_generation,blocked_meta_generation,blocked_busy_generation)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lifecycle_id) DO UPDATE SET
        task=excluded.task,issue=excluded.issue,role=excluded.role,worktree=excluded.worktree,
        harness=excluded.harness,spawned_at=excluded.spawned_at,torn_down_at=excluded.torn_down_at,
        status_start_offset=excluded.status_start_offset,status_end_offset=excluded.status_end_offset,
        status_start_identity=excluded.status_start_identity,status_end_identity=excluded.status_end_identity,
        meta_generation=excluded.meta_generation,busy_generation=excluded.busy_generation,
        blocked_meta_generation=excluded.blocked_meta_generation,blocked_busy_generation=excluded.blocked_busy_generation`).run(
          value.lifecycle_id ?? `link:${uuid()}`, value.task, value.issue, value.role, value.worktree, value.harness,
          value.spawned_at, value.torn_down_at, value.status_start_offset ?? null, value.status_end_offset ?? null,
          value.status_start_identity ?? null, value.status_end_identity ?? null, value.meta_generation ?? null,
          value.busy_generation ?? null, value.blocked_meta_generation ?? null, value.blocked_busy_generation ?? null,
        );
    });
  }

  closeTask(task: string, at = nowIso(), boundary: { statusOffset?: number | null; statusIdentity?: string | null; metaGeneration?: string | null; busyGeneration?: string | null } = {}): void {
    this.raw.query("UPDATE task_links SET torn_down_at=?,status_end_offset=?,status_end_identity=?,meta_generation=?,busy_generation=? WHERE task=? AND torn_down_at IS NULL")
      .run(at, boundary.statusOffset ?? null, boundary.statusIdentity ?? null, boundary.metaGeneration ?? null, boundary.busyGeneration ?? null, task);
  }

  taskLinks(issue?: string, activeOnly = false): TaskLink[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (issue) {
      clauses.push("issue=?");
      args.push(issue);
    }
    if (activeOnly) clauses.push("torn_down_at IS NULL");
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.raw.query(`SELECT * FROM task_links${where} ORDER BY spawned_at,lifecycle_id,task`).all(...args) as TaskLink[];
  }

  observe(value: Observation): boolean {
    const activeLink = value.task && (!value.task_spawned_at || !value.task_lifecycle_id)
      ? this.raw.query(`SELECT spawned_at,lifecycle_id FROM task_links
          WHERE task=? AND issue=? AND torn_down_at IS NULL ORDER BY spawned_at DESC LIMIT 1`)
        .get(value.task, value.issue) as { spawned_at: string; lifecycle_id: string } | null
      : null;
    const taskSpawnedAt = value.task_spawned_at ?? activeLink?.spawned_at ?? null;
    const taskLifecycleId = value.task_lifecycle_id ?? activeLink?.lifecycle_id ?? null;
    const result = this.raw.query(`INSERT OR IGNORE INTO observations(
      id,source,task,task_spawned_at,task_lifecycle_id,issue,verb,key,note,source_identity,source_offset,observed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      value.id, value.source, value.task, taskSpawnedAt, taskLifecycleId, value.issue, value.verb,
      value.key, value.note, value.source_identity ?? null, value.source_offset ?? null, value.observed_at,
    );
    return result.changes === 1;
  }

  observations(issue?: string, since?: string): Observation[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (issue) {
      clauses.push("issue=?");
      args.push(issue);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.raw.query(`SELECT rowid AS _rowid,* FROM observations${where}`).all(...args) as Array<Observation & { _rowid: number }>;
    return rows
      .filter((row) => !since || compareIso(row.observed_at, since) === 1)
      .sort((left, right) => (compareIso(left.observed_at, right.observed_at) ?? 0) || left._rowid - right._rowid)
      .map(({ _rowid: _ignored, ...observation }) => observation);
  }

  observationsAfterRowid(rowid: number): Array<{ rowid: number; observation: Observation }> {
    const rows = this.raw.query("SELECT rowid AS _rowid,* FROM observations WHERE rowid>? ORDER BY rowid").all(rowid) as Array<Observation & { _rowid: number }>;
    return rows.map(({ _rowid, ...observation }) => ({ rowid: _rowid, observation }));
  }

  consumerCursor(name: string): string | null {
    const row = this.raw.query("SELECT value FROM consumer_cursors WHERE name=?").get(name) as { value: string } | null;
    return row?.value ?? null;
  }

  setConsumerCursor(name: string, value: string, at = nowIso()): void {
    this.raw.query(`INSERT INTO consumer_cursors(name,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(name, value, at);
  }

  createPromise(value: NewPromise): PromiseRecord {
    const id = `promise:${sha256(`${value.issue}:${value.source_event_id}:${value.expected_event}:${value.deadline_at}:${value.reply_job_id}`)}`;
    this.raw.query("UPDATE promises SET state='superseded',superseded_by=? WHERE issue=? AND state IN ('open','overdue') AND id<>?")
      .run(id, value.issue, id);
    this.raw.query(`INSERT OR IGNORE INTO promises(
      id,issue,source_event_id,expected_event,deadline_at,reply_job_id,created_at,state
    ) VALUES(?,?,?,?,?,?,?,'open')`).run(
      id, value.issue, value.source_event_id, value.expected_event, value.deadline_at,
      value.reply_job_id, value.created_at,
    );
    return this.promise(id)!;
  }

  stagePromise(value: NewPromise): PromiseRecord {
    const id = `promise:${sha256(`${value.issue}:${value.source_event_id}:${value.expected_event}:${value.deadline_at}:${value.reply_job_id}`)}`;
    this.raw.query(`INSERT OR IGNORE INTO promises(
      id,issue,source_event_id,expected_event,deadline_at,reply_job_id,created_at,state
    ) VALUES(?,?,?,?,?,?,?,'pending')`).run(
      id, value.issue, value.source_event_id, value.expected_event, value.deadline_at,
      value.reply_job_id, value.created_at,
    );
    return this.promise(id)!;
  }

  promise(id: string): PromiseRecord | null {
    return this.raw.query("SELECT * FROM promises WHERE id=?").get(id) as PromiseRecord | null;
  }

  promises(issue?: string, states?: PromiseState[]): PromiseRecord[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (issue) { clauses.push("issue=?"); args.push(issue); }
    if (states?.length) {
      clauses.push(`state IN (${states.map(() => "?").join(",")})`);
      args.push(...states);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.raw.query(`SELECT * FROM promises${where} ORDER BY created_at,id`).all(...args) as PromiseRecord[];
  }

  keepPromise(id: string, observationId: string): void {
    this.raw.query("UPDATE promises SET state='kept',observation_id=? WHERE id=? AND state IN ('open','overdue')")
      .run(observationId, id);
  }

  markPromiseOverdue(id: string, stalledEventId: string): void {
    this.raw.query("UPDATE promises SET state='overdue',stalled_event_id=? WHERE id=? AND state IN ('open','overdue')")
      .run(stalledEventId, id);
  }

  cancelPromise(id: string): void {
    this.raw.query("UPDATE promises SET state='superseded',superseded_by=NULL WHERE id=? AND state IN ('pending','open','overdue')")
      .run(id);
  }
}
