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
    db.handleWithReceipt("event:early", receipt, "handled");
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

  test("events captured after receipt issuance invalidate it regardless of source time", () => {
    const db = database();
    db.capture(event("event:read"));
    const receipt = db.issueReceipt(["event:read"], "2026-01-01T00:00:02Z");
    db.capture({ ...event("event:late"), created_at: "2025-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:02Z" });
    expect(() => db.actWithReceipt({ receiptId: receipt, issue: "ABC-1", captain: "captain", jobs: [], note: "done" })).toThrow("stale receipt");
    expect(() => db.handleWithReceipt("event:read", receipt, "done")).toThrow("stale receipt");
    expect(db.event("event:read")?.disposition).toBe("waiting-for-core");
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

  test("report consumption follows insertion order when a late event has an old source timestamp", () => {
    const db = database();
    db.capture(event("event:first"));
    const first = db.eventsAfterRowid(0);
    expect(first.map((item) => item.event.id)).toEqual(["event:first"]);
    db.capture({ ...event("event:late"), created_at: "2025-01-01T00:00:00Z", captured_at: "2026-01-01T00:10:00Z" });
    expect(db.eventsAfterRowid(first[0]!.rowid).map((item) => item.event.id)).toEqual(["event:late"]);
    db.close();
  });
});
