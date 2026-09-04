import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";
import { StateDatabase } from "../db/database.ts";
import { renderEvent } from "./inbox-v6.ts";
import { buildIssueStatus, isCaptainStatusQuery, runStatus } from "./status.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("issue status context", () => {
  test("recognizes only the small normalized captain status-query set", () => {
    for (const body of ["status", "Status?", " current   status ", "UPDATE?"]) expect(isCaptainStatusQuery(body)).toBe(true);
    for (const body of ["status please", "can I get an update?", "approved"]) expect(isCaptainStatusQuery(body)).toBe(false);
  });

  test("reports observed progress, promises, and strict primary busy state", () => {
    const root = mkdtempSync("/private/tmp/fml-status-"); roots.push(root); mkdirSync(join(root, "state"));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    writeFileSync(join(root, "state", "worker.busy-state"), "v1 gen=g1.1.1 seq=1 state=busy source=test event=turn ts=1\n");
    db.observe({ id: "obs:working", source: "status", task: "worker", issue: "ABC-1", verb: "working", key: "run", note: "validation", observed_at: "2026-01-01T12:10:00Z" });
    db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });
    const text = buildIssueStatus(root, db, "ABC-1");
    expect(text).toContain("working validation");
    expect(text).toContain("pr-green open");
    expect(text).toContain("worker (primary, busy)");
    db.close();
  });

  test("inbox rendering uses a stalled event's concrete required action", () => {
    const event = {
      id: "event:stall", team: "ABC", issue: "ABC-1", type: "stalled", token: "stalled", author: "fm-linear",
      body_sha: null, created_at: "2026-01-01T12:31:00Z", captured_at: "2026-01-01T12:31:00Z",
      disposition: "waiting-for-core" as const, disposition_at: "2026-01-01T12:31:00Z", note: "overdue",
      receipt_id: null, raw_ref: JSON.stringify({ required: "inspect validation and send a nudge" }),
    };
    expect(renderEvent(event)).toContain("required: inspect validation and send a nudge");
  });

  test("the issue status command reads busy state from Firstmate home", () => {
    const root = mkdtempSync("/private/tmp/fml-status-"); roots.push(root);
    const runtimeState = join(root, "runtime");
    mkdirSync(join(root, "state"), { recursive: true });
    const env = { FM_HOME: root, FM_STATE_OVERRIDE: runtimeState };
    const db = StateDatabase.open(env);
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    db.close();
    writeFileSync(join(root, "state", "worker.busy-state"), "v1 gen=g1.1.1 seq=1 state=busy source=test event=turn ts=1\n");
    let output = "";
    const write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { output += String(chunk); return true; });
    try { expect(runStatus(["--issue", "ABC-1"], env)).toBe(0); }
    finally { write.mockRestore(); }
    expect(output).toContain("worker (primary, busy)");
  });
});
