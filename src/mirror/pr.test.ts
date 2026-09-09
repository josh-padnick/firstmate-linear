import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

  test("one failed PR inspection does not suppress another lifecycle", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "broken.meta"), "pr=https://github.com/acme/repo/pull/1\npr_head=broken\npr_base=main\n");
    writeFileSync(join(home, "state", "healthy.meta"), "pr=https://github.com/acme/repo/pull/2\npr_head=healthy\npr_base=main\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "broken", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.linkTask({ task: "healthy", issue: "ABC-2", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });

    const result = scanPullRequests(home, db, (url) => {
      if (url.endsWith("/1")) throw new Error("invalid PR reference");
      return { state: "OPEN", headRefOid: "healthy", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] };
    });

    expect(result.findings).toContainEqual({ code: "PR_INSPECTION_FAILED", issue: "ABC-1", detail: "invalid PR reference" });
    expect(result.observations.map((item) => [item.issue, item.verb])).toEqual([["ABC-2", "pr-reported"], ["ABC-2", "pr-green"]]);
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

  test("a closed lifecycle retains PR evidence through its close boundary", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "spawn_gen=g1\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:00:00Z") / 1000) };
    const inspect = () => ({ state: "OPEN" as const, headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] });
    expect(runTask(["link", "task", "ABC-1"], env)).toBe(0);
    const closeEnv = { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:10:00Z") / 1000) };
    expect(runTask(["close", "task"], closeEnv, { inspectPr: () => {
      closeEnv.FM_LINEAR_NOW_EPOCH = String(Date.parse("2026-01-01T00:11:00Z") / 1000);
      return inspect();
    } })).toBe(0);
    const db = StateDatabase.open(env);

    const result = scanPullRequests(home, db, inspect, { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:11:00Z") / 1000) });

    expect(result.observations).toHaveLength(0);
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({ verb: "pr-green", observed_at: "2026-01-01T00:11:00Z" }));
    expect(db.taskLinks("ABC-1")[0]?.torn_down_at).toBe("2026-01-01T00:11:00Z");
    expect(scanPullRequests(home, db, () => ({ state: "MERGED", headRefOid: "abc123", baseRefName: "main", requiredChecks: [] }), { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:12:00Z") / 1000) }).observations).toHaveLength(0);
    db.close();
  });

  test("a PR change after close is not backdated into the closed lifecycle", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "spawn_gen=g1\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:00:00Z") / 1000) };
    const snapshot = (state: string) => ({ state: "OPEN" as const, headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state }] });
    expect(runTask(["link", "task", "ABC-1"], env)).toBe(0);
    expect(runTask(["close", "task"], { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:10:00Z") / 1000) }, { inspectPr: () => snapshot("fail") })).toBe(0);
    expect(runTask(["link", "task", "ABC-1"], { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:11:00Z") / 1000) })).toBe(0);
    const db = StateDatabase.open(env);
    const [closed, active] = db.taskLinks("ABC-1");

    expect(scanPullRequests(home, db, () => snapshot("pass"), { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:12:00Z") / 1000) }).observations).toHaveLength(0);
    expect(db.observations("ABC-1").filter((item) => item.task_lifecycle_id === closed?.lifecycle_id && item.verb === "pr-green")).toHaveLength(0);
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({ task_lifecycle_id: closed?.lifecycle_id, verb: "pr-withdrawn", observed_at: "2026-01-01T00:10:00Z" }));
    expect(db.observations("ABC-1").filter((item) => item.task_lifecycle_id === active?.lifecycle_id)).toHaveLength(0);
    db.close();
  });

  test("a task boundary retries when PR metadata changes during inspection", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    const metaPath = join(home, "state", "task.meta");
    const url = "https://github.com/acme/repo/pull/1";
    writeFileSync(metaPath, `spawn_gen=g1\npr=${url}\npr_head=head1\npr_base=main\n`);
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], env)).toBe(0);
    let inspections = 0;

    expect(runTask(["close", "task"], env, { inspectPr: () => {
      inspections += 1;
      if (inspections === 1) {
        writeFileSync(metaPath, `spawn_gen=g2\npr=${url}\npr_head=head2\npr_base=main\n`);
        return { state: "OPEN", headRefOid: "head1", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] };
      }
      return { state: "OPEN", headRefOid: "head2", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] };
    } })).toBe(0);

    const db = StateDatabase.open(env);
    const states = db.observations("ABC-1").filter((item) => item.source === "pr" && item.verb !== "pr-reported");
    expect(inspections).toBe(2);
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual(expect.objectContaining({ verb: "pr-green", note: `${url} head=head2` }));
    expect(db.taskLinks("ABC-1")[0]?.meta_generation).toBe("gen:g2");
    db.close();
  });

  test("a task boundary retries when active worktree base changes", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    const firstWorktree = join(home, "first");
    const secondWorktree = join(home, "second");
    const worktrees: Array<[string, string]> = [[firstWorktree, "main"], [secondWorktree, "release"]];
    for (const [worktree, branch] of worktrees) {
      expect(spawnSync("git", ["init", "-q", worktree]).status).toBe(0);
      expect(spawnSync("git", ["-C", worktree, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]).status).toBe(0);
    }
    const url = "https://github.com/acme/repo/pull/1";
    writeFileSync(join(home, "state", "task.meta"), `spawn_gen=g1\npr=${url}\npr_head=head1\n`);
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1", "--role", "support", "--worktree", firstWorktree], env)).toBe(0);
    let inspections = 0;
    let changed = false;

    expect(runTask(["link", "task", "ABC-1", "--role", "primary", "--worktree", secondWorktree, "--spawned-at", "2026-01-01T00:01:00Z"], env, {
      inspectPr: () => {
        inspections += 1;
        return { state: "MERGED", headRefOid: "head1", baseRefName: inspections === 1 ? "main" : "release", requiredChecks: [] };
      },
      beforeBoundaryCommit: () => {
        if (changed) return;
        changed = true;
        const concurrent = StateDatabase.open(env);
        concurrent.linkTask({ task: "task", issue: "ABC-1", role: "support", worktree: secondWorktree, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
        concurrent.close();
      },
    })).toBe(0);

    const db = StateDatabase.open(env);
    expect(inspections).toBe(2);
    expect(db.observations("ABC-1").filter((item) => item.verb === "pr-merged")).toHaveLength(1);
    expect(db.taskLinks("ABC-1", true)[0]?.worktree).toBe(secondWorktree);
    db.close();
  });

  test("a relinked task waits for a new metadata producer generation", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    const metaPath = join(home, "state", "task.meta");
    writeFileSync(metaPath, "spawn_gen=old\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const firstEnv = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], firstEnv)).toBe(0);
    const inspect = () => ({ state: "OPEN" as const, headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] });
    expect(runTask(["close", "task"], { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225660" }, { inspectPr: inspect })).toBe(0);
    expect(runTask(["link", "task", "ABC-1"], { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225720" })).toBe(0);
    const db = StateDatabase.open(firstEnv);
    expect(scanPullRequests(home, db, inspect).observations).toHaveLength(0);
    writeFileSync(metaPath, "spawn_gen=new\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    expect(scanPullRequests(home, db, inspect).observations.map((item) => item.verb)).toEqual(["pr-reported", "pr-green"]);
    db.close();
  });

  test("a role change blocks the sidecar generation present at the boundary", () => {
    const home = mkdtempSync("/private/tmp/fml-pr-"); roots.push(home); mkdirSync(join(home, "state"));
    const metaPath = join(home, "state", "task.meta");
    writeFileSync(metaPath, "spawn_gen=old\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    const inspect = () => ({ state: "OPEN" as const, headRefOid: "abc123", baseRefName: "main", requiredChecks: [{ name: "ci", state: "pass" }] });
    expect(runTask(["link", "task", "ABC-1", "--role", "support"], env)).toBe(0);
    writeFileSync(metaPath, "spawn_gen=current\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
    expect(runTask(["link", "task", "ABC-1", "--role", "primary", "--spawned-at", "2026-01-01T00:01:00Z"], env, { inspectPr: inspect })).toBe(0);
    const db = StateDatabase.open(env);
    expect(scanPullRequests(home, db, inspect).observations).toHaveLength(0);
    writeFileSync(metaPath, "spawn_gen=next\npr=https://github.com/acme/repo/pull/1\npr_head=abc123\npr_base=main\n");
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
