import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../commands/task.ts";
import { StateDatabase } from "../db/database.ts";
import { inspectPr, scanPullRequests } from "./pr.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("PR signals", () => {
  test("check command failures fail closed while failed-check JSON remains inspectable", () => {
    const view = JSON.stringify({ state: "OPEN", mergedAt: null, baseRefName: "main", headRefOid: "abc123" });
    const failedCommand = (_command: string, args: string[]) => args[1] === "view"
      ? { status: 0, stdout: view, stderr: "" }
      : { status: 1, stdout: "", stderr: "authentication failed" };
    expect(() => inspectPr("https://example.test/pr/1", failedCommand)).toThrow("authentication failed");
    const failedChecks = (_command: string, args: string[]) => args[1] === "view"
      ? { status: 0, stdout: view, stderr: "" }
      : { status: 1, stdout: JSON.stringify([{ name: "ci", bucket: "fail" }]), stderr: "" };
    expect(inspectPr("https://example.test/pr/1", failedChecks).requiredChecks).toEqual([{ name: "ci", state: "fail" }]);
  });

  test("green is bound to the mapped current head SHA", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "pr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const result = scanPullRequests(home, db, () => ({ state: "OPEN", headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] }));
    expect(result.observations.some((item) => item.verb === "pr-green")).toBe(true);
    db.close();
  });

  test("a later head withdraws an earlier green signal", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "pr=https://github.com/acme/repo/pull/1\npr_head=new456\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const result = scanPullRequests(home, db, () => ({ state: "OPEN", headRefOid: "old123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] }));
    expect(result.observations.some((item) => item.verb === "pr-withdrawn")).toBe(true);
    db.close();
  });

  test("green is recorded again after checks regress and recover on the same head", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "pr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const snapshots = ["pass", "fail", "pass"];
    for (const state of snapshots) {
      scanPullRequests(home, db, () => ({ state: "OPEN", headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state }] }), { FM_LINEAR_NOW_EPOCH: "1767225600" });
    }
    const transitions = db.observations("ABC-1").filter((item) => ["pr-green", "pr-withdrawn"].includes(item.verb));
    expect(transitions.map((item) => item.verb)).toEqual(["pr-green", "pr-withdrawn", "pr-green"]);
    expect(new Set(transitions.map((item) => item.id)).size).toBe(3);
    db.close();
  });

  test("a relinked task records fresh PR evidence for its new lifecycle", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "pr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const inspect = () => ({ state: "OPEN" as const, headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] });
    scanPullRequests(home, db, inspect, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:01:00Z") / 1000) });
    db.closeTask("task", "2026-01-01T00:02:00Z");
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:03:00Z", torn_down_at: null });

    const current = scanPullRequests(home, db, inspect, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:04:00Z") / 1000) });

    expect(current.observations.map((item) => item.verb)).toEqual(["pr-reported", "pr-green"]);
    expect(db.observations("ABC-1").filter((item) => item.verb === "pr-green")).toHaveLength(2);
    db.close();
  });

  test("a relinked task waits for a new metadata producer generation", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    const metaPath = join(home, "state", "task.meta");
    writeFileSync(metaPath, "spawn_gen=old\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const firstEnv = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], firstEnv)).toBe(0);
    expect(runTask(["close", "task"], { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225660" })).toBe(0);
    expect(runTask(["link", "task", "ABC-1"], { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225720" })).toBe(0);
    const db = StateDatabase.open(firstEnv);
    const inspect = () => ({ state: "OPEN" as const, headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] });

    expect(scanPullRequests(home, db, inspect).observations).toHaveLength(0);
    writeFileSync(metaPath, "spawn_gen=new\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    expect(scanPullRequests(home, db, inspect).observations.map((item) => item.verb)).toEqual(["pr-reported", "pr-green"]);
    db.close();
  });

  test("one task linked to multiple issues records every PR state", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "pr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    for (const issue of ["ABC-1", "ABC-2"]) db.linkTask({ task: "task", issue, role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanPullRequests(home, db, () => ({ state: "OPEN", headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] }));
    scanPullRequests(home, db, () => ({ state: "MERGED", headRefOid: "abc123", baseRefName: "main", requiredChecks: [] }));
    for (const verb of ["pr-reported", "pr-green", "pr-merged"]) {
      expect(db.observations().filter((item) => item.verb === verb).map((item) => item.issue).sort()).toEqual(["ABC-1", "ABC-2"]);
    }
    db.close();
  });

  test("multiple tasks on one issue record independent PR states", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    for (const task of ["primary", "support"]) writeFileSync(join(home, "state", `${task}.meta`), "pr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "primary", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.linkTask({ task: "support", issue: "ABC-1", role: "support", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanPullRequests(home, db, () => ({ state: "OPEN", headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] }));
    scanPullRequests(home, db, () => ({ state: "MERGED", headRefOid: "abc123", baseRefName: "main", requiredChecks: [] }));
    for (const verb of ["pr-green", "pr-merged"]) {
      expect(db.observations("ABC-1").filter((item) => item.verb === verb).map((item) => item.task).sort()).toEqual(["primary", "support"]);
    }
    db.close();
  });

  test("an invalid merged base withdraws a previously green PR", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "pr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanPullRequests(home, db, () => ({ state: "OPEN", headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] }));
    const result = scanPullRequests(home, db, () => ({ state: "MERGED", headRefOid: "abc123", baseRefName: "release", requiredChecks: [] }));
    expect(result.findings[0]?.code).toBe("PR_BASE_MISMATCH");
    expect(db.observations("ABC-1").filter((item) => ["pr-green", "pr-withdrawn"].includes(item.verb)).at(-1)?.verb).toBe("pr-withdrawn");
    db.close();
  });
});
