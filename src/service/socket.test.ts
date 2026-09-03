import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { handleLongPollRequest, handleServiceRequest } from "./protocol.ts";
import { runtimePaths } from "../paths.ts";
import { createSocketServer } from "./socket.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

describe("service protocol", () => {
  test("long runtime paths use a private per-user socket directory", async () => {
    const root = mkdtempSync("/private/tmp/fml-");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const paths = runtimePaths({ FM_HOME: join(root, "x".repeat(140)) });
    const server = createSocketServer(paths.socket, db);
    if (!server.listening) await new Promise<void>((resolve, reject) => server.once("error", reject).once("listening", resolve));
    expect(statSync(join(paths.socket, "..")).mode & 0o777).toBe(0o700);
    cleanup.push(() => { server.close(); db.close(); rmSync(join(paths.socket, ".."), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  });

  test("delivers a stable event over the adapter request boundary", () => {
    const root = mkdtempSync("/private/tmp/fml-");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.capture({ id: "event:1", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:01Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    const first = handleServiceRequest(db, { op: "source.poll", request_id: "request:1", sequence: 0 });
    const retry = handleServiceRequest(db, { op: "source.poll", request_id: "request:1", sequence: 0 });
    expect(first).toEqual(retry);
    expect(first.ok && first.result.status).toBe("result");
    const classified = handleServiceRequest(db, { op: "result.classify", event_id: "event:1", sequence: 7 });
    expect(classified).toEqual({ ok: true, result: { classification: "comment" } });
    expect(db.deliveryForEvent("event:1")?.core_seq).toBe(7);
    expect(handleServiceRequest(db, { op: "source.poll", request_id: "request:1", sequence: 0 })).toEqual(first);
    db.markCoreHandled("event:1", "done");
    db.capture({ id: "event:ignored", team: "ABC", issue: "ABC-2", type: "board", token: "noise", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:02Z", captured_at: "2026-01-01T00:00:03Z", disposition: "ignored", note: "noise", raw_ref: "{}" });
    const ignored = handleServiceRequest(db, { op: "source.poll", request_id: "request:2", sequence: 0 });
    expect(ignored.ok && ignored.result.status).toBe("result");
    expect(handleServiceRequest(db, { op: "result.silent", event_id: "event:ignored", sequence: 8 })).toEqual({ ok: true, result: { value: true } });
    expect(db.deliveryForEvent("event:ignored")).toMatchObject({ core_seq: 8 });
    expect(db.deliveryForEvent("event:ignored")?.handled_at).not.toBeNull();
  });

  test("a pending source poll discovers an event captured during its bounded wait", async () => {
    const root = mkdtempSync("/private/tmp/fml-");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    const pending = handleLongPollRequest(db, { op: "source.poll", request_id: "request:waiting", sequence: 0 }, 500);
    setTimeout(() => {
      db.capture({ id: "event:later", team: "ABC", issue: "ABC-3", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:01Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    }, 20);
    const response = await pending;
    expect(response.ok && response.result.status).toBe("result");
    expect(db.deliveryForEvent("event:later")).not.toBeNull();
  });

  test("an installed but inactive cutover does not deliver recorded events", async () => {
    const root = mkdtempSync("/private/tmp/fml-");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    db.capture({ id: "event:parked", team: "ABC", issue: "ABC-4", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:01Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    const response = await handleLongPollRequest(db, { op: "source.poll", request_id: "request:inactive", sequence: 0 }, 0, () => false);
    expect(response).toEqual({ ok: true, result: { status: "no-result", output: "" } });
    expect(db.deliveryForEvent("event:parked")).toBeNull();
  });
});
