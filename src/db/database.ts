import { copyFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { ensurePrivateDir } from "../fsutil.ts";
import { sha256, uuid } from "../hash.ts";
import { runtimePaths } from "../paths.ts";
import { nowIso } from "../time.ts";
import { MIGRATE_TO_V2_SQL, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

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

export type IssueSnapshot = {
  issue: string;
  state: string;
  assignee: string | null;
  labels: string[];
  agent_label: string | null;
  last_actor: string | null;
  last_signal: string | null;
  observed_at: string;
};

export type TaskLink = {
  task: string;
  issue: string;
  role: "primary" | "support";
  worktree: string | null;
  harness: string | null;
  spawned_at: string;
  torn_down_at: string | null;
};

export type Observation = {
  id: string;
  source: "status" | "summary" | "pr";
  task: string | null;
  issue: string;
  verb: string;
  key: string;
  note: string | null;
  observed_at: string;
};

function stampForPath(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function currentVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
  return Number(row?.user_version ?? 0);
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
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.raw.exec("COMMIT");
      return value;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
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
        AND id NOT IN (SELECT event_id FROM core_deliveries) ORDER BY created_at,id LIMIT 1`).get() as DomainEvent | null;
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

  handleWithReceipt(eventId: string, receiptId: string, note: string | null, at = nowIso()): void {
    this.transaction(() => {
      const receipt = this.receipt(receiptId);
      if (!receipt || receipt.consumed_at || !receipt.event_ids.includes(eventId)) {
        throw new Error("receipt does not authorize that event");
      }
      const authorized = this.event(eventId);
      if (!authorized) throw new Error(`event not found: ${eventId}`);
      const newer = this.newerCaptainEventAfterRowid(authorized.issue, receipt.event_rowid, authorized.author);
      if (newer && !receipt.event_ids.includes(newer.id)) {
        throw new Error(`stale receipt: newer captain event ${newer.id} must be read first`);
      }
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
      const newer = this.newerCaptainEventAfterRowid(options.issue, receipt.event_rowid, options.captain);
      if (newer && !receipt.event_ids.includes(newer.id)) {
        throw new Error(`stale receipt: newer captain event ${newer.id} must be read first`);
      }
      for (const job of options.jobs) this.enqueue(job, at);
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

  enqueue(job: NewJob, at = nowIso()): Job {
    const id = `job:${sha256(job.key)}`;
    this.raw.query(`INSERT INTO jobs(id,key,kind,target,payload,state,attempts,next_attempt_at,created_at)
      VALUES(?,?,?,?,?,'pending',0,?,?) ON CONFLICT(key) DO NOTHING`).run(
        id, job.key, job.kind, job.target, JSON.stringify(job.payload), job.nextAttemptAt ?? at, at,
      );
    return this.raw.query("SELECT * FROM jobs WHERE key=?").get(job.key) as Job;
  }

  claimDueJobs(limit = 20, at = nowIso()): Job[] {
    return this.transaction(() => {
      const jobs = this.raw.query(`SELECT * FROM jobs WHERE state IN ('pending','retry')
        AND next_attempt_at<=? ORDER BY created_at LIMIT ?`).all(at, limit) as Job[];
      for (const job of jobs) {
        this.raw.query("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?").run(job.id);
      }
      return jobs.map((job) => ({ ...job, state: "running", attempts: job.attempts + 1 }));
    });
  }

  finishJob(id: string, nativeId: string | null = null, at = nowIso()): void {
    this.raw.query("UPDATE jobs SET state='done',native_id=COALESCE(?,native_id),done_at=?,last_error=NULL WHERE id=?")
      .run(nativeId, at, id);
  }

  retryJob(id: string, error: string, nextAttemptAt: string, dead = false): void {
    this.raw.query("UPDATE jobs SET state=?,last_error=?,next_attempt_at=? WHERE id=?")
      .run(dead ? "dead" : "retry", error.slice(0, 2000), nextAttemptAt, id);
  }

  jobs(states?: JobState[]): Job[] {
    if (!states?.length) return this.raw.query("SELECT * FROM jobs ORDER BY created_at").all() as Job[];
    return this.raw.query(`SELECT * FROM jobs WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`).all(...states) as Job[];
  }

  snapshot(value: IssueSnapshot): void {
    this.raw.query(`INSERT OR IGNORE INTO issue_snapshots(
      issue,state,assignee,labels,agent_label,last_actor,last_signal,observed_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      value.issue, value.state, value.assignee, JSON.stringify(value.labels), value.agent_label,
      value.last_actor, value.last_signal, value.observed_at,
    );
  }

  latestSnapshot(issue: string): IssueSnapshot | null {
    const row = this.raw.query("SELECT * FROM issue_snapshots WHERE issue=? ORDER BY observed_at DESC LIMIT 1").get(issue) as (Omit<IssueSnapshot, "labels"> & { labels: string }) | null;
    return row ? { ...row, labels: JSON.parse(row.labels) as string[] } : null;
  }

  latestSnapshots(): IssueSnapshot[] {
    const rows = this.raw.query(`SELECT s.* FROM issue_snapshots s JOIN (
      SELECT issue,MAX(observed_at) observed_at FROM issue_snapshots GROUP BY issue
    ) latest ON latest.issue=s.issue AND latest.observed_at=s.observed_at ORDER BY s.issue`).all() as Array<Omit<IssueSnapshot, "labels"> & { labels: string }>;
    return rows.map((row) => ({ ...row, labels: JSON.parse(row.labels) as string[] }));
  }

  linkTask(value: TaskLink): void {
    this.raw.query(`INSERT INTO task_links(task,issue,role,worktree,harness,spawned_at,torn_down_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(task,issue) DO UPDATE SET
      role=excluded.role,worktree=excluded.worktree,harness=excluded.harness,
      spawned_at=excluded.spawned_at,torn_down_at=excluded.torn_down_at`).run(
        value.task, value.issue, value.role, value.worktree, value.harness,
        value.spawned_at, value.torn_down_at,
      );
  }

  closeTask(task: string, at = nowIso()): void {
    this.raw.query("UPDATE task_links SET torn_down_at=? WHERE task=? AND torn_down_at IS NULL").run(at, task);
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
    return this.raw.query(`SELECT * FROM task_links${where} ORDER BY spawned_at,task`).all(...args) as TaskLink[];
  }

  observe(value: Observation): boolean {
    const result = this.raw.query(`INSERT OR IGNORE INTO observations(
      id,source,task,issue,verb,key,note,observed_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      value.id, value.source, value.task, value.issue, value.verb,
      value.key, value.note, value.observed_at,
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
    if (since) {
      clauses.push("observed_at>?");
      args.push(since);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.raw.query(`SELECT * FROM observations${where} ORDER BY observed_at,rowid`).all(...args) as Observation[];
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
}
