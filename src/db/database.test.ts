import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
