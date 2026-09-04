import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { StateDatabase } from "./database.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(): StateDatabase {
  const root = mkdtempSync(join(tmpdir(), "fm-linear-db-"));
  roots.push(root);
  return new StateDatabase(join(root, "state.db"), join(root, "backups"));
}

function event(id: string, disposition: "waiting-for-core" | "handled-by-service" = "waiting-for-core") {
  return {
    id,
    team: "ABC",
    issue: "ABC-1",
    type: "comment",
    token: "comment",
    author: "captain",
    body_sha: "abc",
    created_at: "2026-01-01T00:00:00Z",
    captured_at: "2026-01-01T00:00:01Z",
    disposition,
    note: null,
    raw_ref: JSON.stringify({ body: "go" }),
  } as const;
}

describe("state database", () => {
  test("nested transactions preserve outer work and isolate inner rollback", () => {
    const db = database();
    db.transaction(() => {
      db.capture(event("event:outer"));
      try {
        db.transaction(() => {
          db.capture(event("event:inner"));
          throw new Error("rollback inner work");
        });
      } catch {}
    });
    expect(db.listEvents().map((item) => item.id)).toEqual(["event:outer"]);
    db.close();
  });

  test("relinking an active task updates one lifecycle interval", () => {
    const db = database();
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: "old", harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: "new", harness: "codex", spawned_at: "2026-01-01T00:01:00Z", torn_down_at: null });

    expect(db.taskLinks("ABC-1", true)).toEqual([expect.objectContaining({ role: "primary", worktree: "new", harness: "codex", spawned_at: "2026-01-01T00:00:00Z" })]);
    db.close();
  });

  test("changing an active task role starts a new lifecycle interval", () => {
    const db = database();
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: "tree", harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.linkTask({ task: "worker", issue: "ABC-1", role: "support", worktree: "tree", harness: null, spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null });

    expect(db.taskLinks("ABC-1")).toEqual([
      expect.objectContaining({ role: "primary", spawned_at: "2026-01-01T00:00:00Z", torn_down_at: "2026-01-01T00:02:00Z" }),
      expect.objectContaining({ role: "support", spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null }),
    ]);
    db.close();
  });

  test("closing and relinking within one second creates a distinct lifecycle", () => {
    const db = database();
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.observe({ id: "old", source: "status", task: "worker", issue: "ABC-1", verb: "done", key: "default", note: null, observed_at: "2026-01-01T00:00:00Z" });
    db.closeTask("worker", "2026-01-01T00:00:00Z");
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });

    const links = db.taskLinks("ABC-1");
    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.lifecycle_id)).size).toBe(2);
    expect(links.filter((link) => link.torn_down_at === null)).toHaveLength(1);
    db.close();
  });

  test("capture and its deterministic jobs commit together", () => {
    const db = database();
    expect(db.capture(event("event:1"), [{ key: "event:1:relay", kind: "relay", target: "ABC-1", payload: { event: "event:1" } }])).toBe(true);
    expect(db.capture(event("event:1"), [{ key: "event:1:relay", kind: "relay", target: "ABC-1", payload: {} }])).toBe(false);
    expect(db.listEvents()).toHaveLength(1);
    expect(db.jobs()).toHaveLength(1);
    db.close();
  });

  test("a failed capture transaction leaves neither event nor job", () => {
    const db = database();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => db.capture(event("event:bad"), [{ key: "bad:job", kind: "relay", target: "ABC-1", payload: cyclic }])).toThrow();
    expect(db.listEvents()).toHaveLength(0);
    expect(db.jobs()).toHaveLength(0);
    db.close();
  });

  test("source poll retries return the same delivered event", () => {
    const db = database();
    db.capture(event("event:1"));
    const first = db.nextForCore("request:1", 7);
    const retry = db.nextForCore("request:1", 7);
    expect(first?.id).toBe("event:1");
    expect(retry?.id).toBe("event:1");
    db.markCoreHandled("event:1", "done");
    expect(db.nextForCore("request:2", 8)).toBeNull();
    db.close();
  });

  test("core delivery follows ledger insertion order", () => {
    const db = database();
    db.capture({ ...event("event:first"), created_at: "2026-01-01T00:00:01Z" });
    db.capture({ ...event("event:second"), created_at: "2025-01-01T00:00:00Z" });
    expect(db.nextForCore("request:first", 1)?.id).toBe("event:first");
    db.markCoreHandled("event:first", "done");
    expect(db.nextForCore("request:second", 2)?.id).toBe("event:second");
    db.close();
  });

  test("receipts bind exact events and detect newer captain input", () => {
    const db = database();
    db.capture(event("event:1"));
    const receipt = db.issueReceipt(["event:1"], "2026-01-01T00:00:02Z");
    expect(db.receipt(receipt)?.event_ids).toEqual(["event:1"]);
    db.capture({ ...event("event:2"), created_at: "2026-01-01T00:00:03Z" });
    expect(db.newerCaptainEvent("ABC-1", "2026-01-01T00:00:02Z", "captain")?.id).toBe("event:2");
    db.consumeReceipt(receipt);
    expect(db.receipt(receipt)?.consumed_at).not.toBeNull();
    db.close();
  });

  test("handling an event before core delivery creates no impossible acknowledgement", () => {
    const db = database();
    db.capture(event("event:early"));
    const receipt = db.issueReceipt(["event:early"]);
    db.handleWithReceipt("event:early", receipt, "captain", "handled");
    expect(db.jobs()).toHaveLength(0);
    expect(db.nextForCore("request:later", 0)).toBeNull();
    db.close();
  });

  test("receipt-gated actions only acknowledge events already delivered to core", () => {
    const db = database();
    db.capture(event("event:delivered"));
    db.capture({ ...event("event:early"), issue: "ABC-2" });
    db.nextForCore("request:delivered", 0);
    db.bindDeliverySequence("event:delivered", 12);
    const deliveredReceipt = db.issueReceipt(["event:delivered"]);
    const earlyReceipt = db.issueReceipt(["event:early"]);
    db.actWithReceipt({ receiptId: deliveredReceipt, issue: "ABC-1", captain: "captain", jobs: [], note: "done" });
    db.actWithReceipt({ receiptId: earlyReceipt, issue: "ABC-2", captain: "captain", jobs: [], note: "done" });
    expect(db.jobs().map((job) => job.target)).toEqual(["event:delivered"]);
    db.close();
  });

  test("binding a delayed delivery sequence creates the deferred acknowledgement", () => {
    const db = database();
    db.capture(event("event:delayed"));
    db.nextForCore("request:delayed", 0);
    const receipt = db.issueReceipt(["event:delayed"]);
    db.handleWithReceipt("event:delayed", receipt, "captain", "done");
    expect(db.jobs()).toHaveLength(0);
    db.bindDeliverySequence("event:delayed", 9);
    expect(db.jobs()).toHaveLength(1);
    expect(db.jobs()[0]).toMatchObject({ kind: "core.ack", target: "event:delayed" });
    db.close();
  });

  test("events captured after receipt issuance invalidate it regardless of source time", () => {
    const db = database();
    db.capture(event("event:read"));
    const receipt = db.issueReceipt(["event:read"], "2026-01-01T00:00:02Z");
    db.capture({ ...event("event:late"), created_at: "2025-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:02Z" });
    expect(() => db.actWithReceipt({ receiptId: receipt, issue: "ABC-1", captain: "captain", jobs: [], note: "done" })).toThrow("stale receipt");
    expect(() => db.handleWithReceipt("event:read", receipt, "captain", "done")).toThrow("stale receipt");
    expect(db.event("event:read")?.disposition).toBe("waiting-for-core");
    db.close();
  });

  test("a receipt for an older event cannot authorize past unread captain input", () => {
    const db = database();
    db.capture(event("event:old"));
    db.capture({ ...event("event:new"), created_at: "2026-01-01T00:00:02Z" });
    const receipt = db.issueReceipt(["event:old"]);
    expect(() => db.actWithReceipt({ receiptId: receipt, issue: "ABC-1", captain: "captain", jobs: [], note: "done" })).toThrow("event:new must be read first");
    expect(() => db.handleWithReceipt("event:old", receipt, "captain", "done")).toThrow("event:new must be read first");
    expect(db.receipt(receipt)?.consumed_at).toBeNull();
    db.close();
  });

  test("v1 migration invalidates receipts without a trustworthy watermark", () => {
    const db = database();
    const path = db.path;
    db.capture(event("event:read"));
    const receipt = db.issueReceipt(["event:read"]);
    db.capture({ ...event("event:newer"), created_at: "2025-01-01T00:00:00Z" });
    db.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE receipts DROP COLUMN event_rowid; PRAGMA user_version = 1;");
    legacy.close();
    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    expect(migrated.receipt(receipt)?.consumed_at).not.toBeNull();
    expect(() => migrated.actWithReceipt({ receiptId: receipt, issue: "ABC-1", captain: "captain", jobs: [], note: "done" })).toThrow("already consumed");
    expect(migrated.event("event:read")?.disposition).toBe("waiting-for-core");
    migrated.close();
  });

  test("v2 migration creates durable promise storage", () => {
    const db = database();
    const path = db.path;
    db.close();
    const legacy = new Database(path);
    legacy.exec("DROP TABLE promises; PRAGMA user_version = 2;");
    legacy.close();
    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    expect(migrated.createPromise({
      issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green",
      deadline_at: "2026-01-01T00:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T00:00:00Z",
    })).toMatchObject({ issue: "ABC-1", state: "open" });
    migrated.close();
  });

  test("v3 migration preserves active promises and adds delivery states", () => {
    const db = database();
    const path = db.path;
    const promise = db.createPromise({
      issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green",
      deadline_at: "2026-01-01T00:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T00:00:00Z",
    });
    db.close();
    const legacy = new Database(path);
    legacy.exec("PRAGMA user_version = 3;");
    legacy.close();
    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    expect(migrated.promise(promise.id)?.state).toBe("open");
    expect(migrated.stagePromise({
      issue: "ABC-2", source_event_id: "event:two", expected_event: "comment",
      deadline_at: "2026-01-01T01:00:00Z", reply_job_id: "job:reply-two", created_at: "2026-01-01T00:30:00Z",
    }).state).toBe("pending");
    migrated.close();
  });

  test("v5 migration adds task lifecycle identity to observations", () => {
    const db = database();
    const path = db.path;
    db.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE observations DROP COLUMN task_spawned_at; PRAGMA user_version = 5;");
    legacy.close();
    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    migrated.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    migrated.observe({ id: "observed", source: "status", task: "worker", issue: "ABC-1", verb: "working", key: "default", note: null, observed_at: "2026-01-01T00:01:00Z" });
    expect(migrated.observations("ABC-1")[0]?.task_spawned_at).toBe("2026-01-01T00:00:00Z");
    migrated.close();
  });

  test("v6 migration assigns durable lifecycle identities", () => {
    const root = mkdtempSync(join(tmpdir(), "fm-linear-db-")); roots.push(root);
    const path = join(root, "state.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`CREATE TABLE task_links (
      task TEXT NOT NULL, issue TEXT NOT NULL, role TEXT NOT NULL, worktree TEXT, harness TEXT,
      spawned_at TEXT NOT NULL, torn_down_at TEXT, PRIMARY KEY (task, issue, spawned_at)
    );
    CREATE INDEX task_links_issue_idx ON task_links(issue, role, torn_down_at);
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, task TEXT, task_spawned_at TEXT,
      issue TEXT NOT NULL, verb TEXT NOT NULL, key TEXT NOT NULL, note TEXT, observed_at TEXT NOT NULL
    );
    INSERT INTO task_links VALUES ('worker','ABC-1','primary',NULL,NULL,'2026-01-01T00:00:00Z',NULL);
    INSERT INTO observations VALUES ('observed','status','worker','2026-01-01T00:00:00Z','ABC-1','working','default',NULL,'2026-01-01T00:01:00Z');
    PRAGMA user_version = 6;`);
    legacy.close();

    const migrated = new StateDatabase(path, join(root, "backups"));
    const link = migrated.taskLinks("ABC-1")[0]!;
    expect(link.lifecycle_id).toStartWith("link:");
    expect(migrated.observations("ABC-1")[0]?.task_lifecycle_id).toBe(link.lifecycle_id);
    migrated.close();
  });

  test("v13 migration adds host ownership to task links", () => {
    const db = database();
    const path = db.path;
    db.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE task_links DROP COLUMN host; PRAGMA user_version = 13;");
    legacy.close();

    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    migrated.linkTask({ task: "remote-worker", issue: "ABC-1", role: "primary", host: "mini", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    expect(migrated.taskLinks("ABC-1")[0]?.host).toBe("mini");
    migrated.close();
  });

  test("v14 migration preserves the original steer message for idempotent redelivery", () => {
    const db = database();
    const path = db.path;
    db.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE steers DROP COLUMN message; PRAGMA user_version = 14;");
    legacy.close();

    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    expect(migrated.recordSteer({ issue: "ABC-1", home: "mini", task: "worker", record_path: "/remote/001.msg", message: "Report status", sent_at: "2026-01-01T00:00:00Z" }).message).toBe("Report status");
    migrated.close();
  });

  test("v15 migration adds the remote steer delivery identity", () => {
    const db = database();
    const path = db.path;
    db.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE steers DROP COLUMN delivery_id; PRAGMA user_version = 15;");
    legacy.close();

    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    expect(migrated.recordSteer({
      issue: "ABC-1", home: "mini", task: "worker", record_path: "/remote/001.msg",
      message: "Report status", delivery_id: "delivery-1", sent_at: "2026-01-01T00:00:00Z",
    }).delivery_id).toBe("delivery-1");
    migrated.close();
  });

  test("v16 migration adds steer lifecycle identity", () => {
    const db = database();
    const path = db.path;
    db.linkTask({
      lifecycle_id: "link:one", task: "worker", issue: "ABC-1", role: "primary",
      worktree: null, harness: null, spawned_at: "2025-12-31T23:00:00Z", torn_down_at: null,
    });
    db.recordSteer({
      issue: "ABC-1", home: "local", task: "worker", record_path: "/local/legacy.msg",
      lifecycle_id: "link:one", sent_at: "2026-01-01T00:00:00Z",
    });
    db.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE steers DROP COLUMN lifecycle_id; PRAGMA user_version = 16;");
    legacy.close();

    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    expect(migrated.steers()[0]?.lifecycle_id).toBe("link:one");
    expect(migrated.recordSteer({
      issue: "ABC-1", home: "local", task: "worker", record_path: "/local/001.msg",
      lifecycle_id: "link:one", sent_at: "2026-01-01T00:00:00Z",
    }).lifecycle_id).toBe("link:one");
    migrated.close();
  });

  test("v17 migration backfills an unambiguous legacy steer lifecycle", () => {
    const db = database();
    const path = db.path;
    db.linkTask({
      lifecycle_id: "link:one", task: "worker", issue: "ABC-1", role: "primary",
      worktree: null, harness: null, spawned_at: "2025-12-31T23:00:00Z", torn_down_at: null,
    });
    db.recordSteer({
      issue: "ABC-1", home: "local", task: "worker", record_path: "/local/unresolved.msg",
      sent_at: "2026-01-01T00:00:00Z",
    });
    db.close();
    const legacy = new Database(path);
    legacy.exec("PRAGMA user_version = 17;");
    legacy.close();

    const migrated = new StateDatabase(path, join(path, "..", "backups"));
    expect(migrated.steers()[0]?.lifecycle_id).toBe("link:one");
    migrated.close();
  });

  test("running jobs are reclaimed only after their lease expires", () => {
    const db = database();
    db.enqueue({ key: "leased", kind: "linear.comment", target: "ABC-1", payload: {} }, "2026-01-01T00:00:00Z");
    expect(db.claimDueJobs(20, "2026-01-01T00:00:00Z")).toHaveLength(1);
    expect(db.claimDueJobs(20, "2026-01-01T00:04:59Z")).toHaveLength(0);
    expect(db.claimDueJobs(20, "2026-01-01T00:05:00Z")).toMatchObject([{ state: "running", attempts: 2 }]);
    db.close();
  });

  test("promise activation starts its original duration at successful reply delivery", () => {
    const db = database();
    const job = db.enqueue({ key: "reply-delayed", kind: "linear.comment", target: "ABC-1", payload: {} }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({
      issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green",
      deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z",
    });
    db.finishJob(job.id, "comment:delivered", "2026-01-01T12:20:00Z");
    expect(db.promise(promise.id)).toMatchObject({
      state: "open",
      reply_comment_id: "comment:delivered",
      created_at: "2026-01-01T12:20:00Z",
      deadline_at: "2026-01-01T12:50:00Z",
    });
    db.close();
  });

  test("an older reply delivered late cannot supersede a newer commitment", () => {
    const db = database();
    const olderJob = db.enqueue({ key: "reply-older", kind: "linear.comment", target: "ABC-1", payload: {} }, "2026-01-01T12:00:00Z");
    const older = db.stagePromise({ issue: "ABC-1", source_event_id: "event:older", expected_event: "pr-reported", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: olderJob.id, created_at: "2026-01-01T12:00:00Z" });
    const newerJob = db.enqueue({ key: "reply-newer", kind: "linear.comment", target: "ABC-1", payload: {} }, "2026-01-01T12:05:00Z");
    const newer = db.stagePromise({ issue: "ABC-1", source_event_id: "event:newer", expected_event: "pr-green", deadline_at: "2026-01-01T12:35:00Z", reply_job_id: newerJob.id, created_at: "2026-01-01T12:05:00Z" });
    db.finishJob(newerJob.id, "comment:newer", "2026-01-01T12:06:00Z");

    db.finishJob(olderJob.id, "comment:older", "2026-01-01T12:10:00Z");

    expect(db.promise(newer.id)?.state).toBe("open");
    expect(db.promise(older.id)).toMatchObject({ state: "superseded", superseded_by: newer.id, reply_comment_id: "comment:older" });
    db.close();
  });

  test("report consumption follows insertion order when a late event has an old source timestamp", () => {
    const db = database();
    db.capture(event("event:first"));
    const first = db.eventsAfterRowid(0);
    expect(first.map((item) => item.event.id)).toEqual(["event:first"]);
    db.capture({ ...event("event:late"), created_at: "2025-01-01T00:00:00Z", captured_at: "2026-01-01T00:10:00Z" });
    expect(db.eventsAfterRowid(first[0]!.rowid).map((item) => item.event.id)).toEqual(["event:late"]);
    db.close();
  });

  test("observations use chronological instants with insertion-order ties", () => {
    const db = database();
    db.observe({ id: "whole", source: "status", task: "a", issue: "ABC-1", verb: "working", key: "default", note: null, observed_at: "2026-01-01T00:00:00Z" });
    db.observe({ id: "fractional", source: "status", task: "a", issue: "ABC-1", verb: "done", key: "default", note: null, observed_at: "2026-01-01T00:00:00.123Z" });
    db.observe({ id: "tie", source: "status", task: "a", issue: "ABC-1", verb: "blocked", key: "default", note: null, observed_at: "2026-01-01T00:00:00.123Z" });
    expect(db.observations("ABC-1").map((item) => item.id)).toEqual(["whole", "fractional", "tie"]);
    expect(db.observations("ABC-1", "2026-01-01T00:00:00Z").map((item) => item.id)).toEqual(["fractional", "tie"]);
    db.close();
  });
});
