import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../commands/task.ts";
import { StateDatabase } from "../db/database.ts";
import { parseStatusLine, scanFleet } from "./scan.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("fleet scanner", () => {
  test("parses both supported keyed status forms", () => {
    expect(parseStatusLine("needs-decision [key=color]: choose one")?.key).toBe("color");
    expect(parseStatusLine("resolved: [key=color] answered")?.key).toBe("color");
  });

  test("tails status append-only without replay", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "harness=codex\nworktree=/tmp/work\n");
    writeFileSync(join(home, "state", "task.status"), "working: started\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const first = scanFleet(home, db).observations;
    expect(first.filter((item) => item.source === "status")).toHaveLength(1);
    expect(first.filter((item) => item.verb === "model-resolved")).toHaveLength(1);
    expect(scanFleet(home, db).observations).toHaveLength(0);
    db.close();
  });

  test("one task linked to multiple issues records every task-derived signal", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "model=codex\n");
    writeFileSync(join(home, "state", "task.status"), "working: started\n");
    writeFileSync(join(home, "state", "home-summary.json"), JSON.stringify({ generated: "2026-01-01T00:01:00Z", active_children: [{ id: "task", state: "working" }] }));
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    for (const issue of ["ABC-1", "ABC-2"]) db.linkTask({ task: "task", issue, role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const observations = scanFleet(home, db).observations;
    expect(observations.filter((item) => item.source === "status").map((item) => item.issue).sort()).toEqual(["ABC-1", "ABC-2"]);
    expect(observations.filter((item) => item.key === "summary").map((item) => item.issue).sort()).toEqual(["ABC-1", "ABC-2"]);
    expect(observations.filter((item) => item.verb === "model-resolved").map((item) => item.issue).sort()).toEqual(["ABC-1", "ABC-2"]);
    db.close();
  });

  test("relinked tasks emit fresh model and truncated status evidence", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.meta"), "model=codex\n");
    writeFileSync(join(home, "state", "task.status"), "working: started\nworking: filler\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanFleet(home, db);
    db.closeTask("task", "2026-01-01T00:01:00Z");
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null });
    writeFileSync(join(home, "state", "task.status"), "working: started\n");

    const observations = scanFleet(home, db).observations;
    expect(observations.filter((item) => item.verb === "model-resolved")).toHaveLength(1);
    expect(observations.filter((item) => item.source === "status")).toHaveLength(1);
    db.close();
  });

  test("relinking does not replay an unchanged status file", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    writeFileSync(join(home, "state", "task.status"), "done: old lifecycle\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanFleet(home, db);
    db.closeTask("task", "2026-01-01T00:01:00Z");
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null });

    expect(scanFleet(home, db).observations.filter((item) => item.source === "status")).toHaveLength(0);
    db.close();
  });

  test("replacing a status file resets its cursor", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: old\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanFleet(home, db);
    unlinkSync(path);
    writeFileSync(path, "needs-decision: choose a direction\nworking: replacement is longer\n");

    const observations = scanFleet(home, db).observations;
    expect(observations).toContainEqual(expect.objectContaining({ verb: "needs-decision", note: "choose a direction" }));
    db.close();
  });

  test("an in-place status replacement resets its cursor", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: old\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanFleet(home, db);
    writeFileSync(path, "needs-decision: choose a direction\nworking: replacement is longer\n");

    const observations = scanFleet(home, db).observations;
    expect(observations).toContainEqual(expect.objectContaining({ verb: "needs-decision", note: "choose a direction" }));
    db.close();
  });

  test("legacy status cursors resume from their validated offset", () => {
    for (const format of ["offset", "identity"] as const) {
      const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
      const path = join(home, "state", "task.status");
      writeFileSync(path, "done: old lifecycle\nworking: current\n");
      const db = new StateDatabase(join(home, "db"), join(home, "backups"));
      db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
      const stat = statSync(path);
      const legacy = format === "offset" ? { offset: 20 } : { offset: 20, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:old-lifecycle` };
      db.setCursor(`status:${path}`, JSON.stringify(legacy));

      const observations = scanFleet(home, db).observations.filter((item) => item.source === "status");
      expect(observations.map((item) => item.verb)).toEqual(["working"]);
      db.close();
    }
  });

  test("status appended while unlinked is not attributed after relinking", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: first lifecycle\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    scanFleet(home, db);
    db.closeTask("task", "2026-01-01T00:01:00Z");
    writeFileSync(path, "working: first lifecycle\ndone: closed lifecycle\n");

    expect(scanFleet(home, db).observations.filter((item) => item.source === "status")).toHaveLength(0);
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null });
    expect(scanFleet(home, db).observations.filter((item) => item.source === "status")).toHaveLength(0);
    db.close();
  });

  test("task relinking baselines status appended between service scans", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: first lifecycle\n");
    const firstEnv = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], firstEnv)).toBe(0);
    let db = StateDatabase.open(firstEnv);
    scanFleet(home, db, firstEnv);
    db.close();

    expect(runTask(["close", "task"], { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225660" })).toBe(0);
    writeFileSync(path, "working: first lifecycle\ndone: closed lifecycle\n");
    const secondEnv = { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225720" };
    expect(runTask(["link", "task", "ABC-1"], secondEnv)).toBe(0);
    db = StateDatabase.open(secondEnv);

    expect(scanFleet(home, db, secondEnv).observations.filter((item) => item.source === "status")).toHaveLength(0);
    db.close();
  });

  test("a status written before close is ingested for the closed lifecycle", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: started\n");
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], env)).toBe(0);
    let db = StateDatabase.open(env);
    scanFleet(home, db, env);
    db.close();
    writeFileSync(path, "working: started\ndone: finished\n");
    expect(runTask(["close", "task"], { ...env, FM_LINEAR_NOW_EPOCH: "1767225660" })).toBe(0);
    db = StateDatabase.open(env);

    expect(scanFleet(home, db, env).observations).toContainEqual(expect.objectContaining({ verb: "done", issue: "ABC-1" }));
    db.close();
  });

  test("a replacement status file is not constrained by the prior file offset", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: first lifecycle has a long status line\n");
    const firstEnv = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], firstEnv)).toBe(0);
    expect(runTask(["close", "task"], { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225660" })).toBe(0);
    expect(runTask(["link", "task", "ABC-1"], { ...firstEnv, FM_LINEAR_NOW_EPOCH: "1767225720" })).toBe(0);
    unlinkSync(path);
    writeFileSync(path, "working: new\n");
    const db = StateDatabase.open(firstEnv);

    expect(scanFleet(home, db, firstEnv).observations).toContainEqual(expect.objectContaining({ verb: "working", note: "new" }));
    db.close();
  });

  test("a replacement present before relink starts at its beginning", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: old lifecycle\n");
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], env)).toBe(0);
    let db = StateDatabase.open(env);
    scanFleet(home, db, env);
    db.close();
    expect(runTask(["close", "task"], env)).toBe(0);
    unlinkSync(path);
    writeFileSync(path, "working: new lifecycle\n");
    expect(runTask(["link", "task", "ABC-1"], env)).toBe(0);
    db = StateDatabase.open(env);

    expect(scanFleet(home, db, env).observations).toContainEqual(expect.objectContaining({ verb: "working", note: "new lifecycle" }));
    db.close();
  });

  test("a reset incarnation retains status written before close", () => {
    const home = mkdtempSync("/private/tmp/fml-scan-"); roots.push(home); mkdirSync(join(home, "state"));
    const path = join(home, "state", "task.status");
    writeFileSync(path, "working: original\n");
    const env = { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225600" };
    expect(runTask(["link", "task", "ABC-1"], env)).toBe(0);
    let db = StateDatabase.open(env);
    scanFleet(home, db, env);
    writeFileSync(path, "working: replacement\n");
    scanFleet(home, db, env);
    db.close();
    writeFileSync(path, "working: replacement\ndone: before close\n");
    expect(runTask(["close", "task"], env)).toBe(0);
    db = StateDatabase.open(env);

    expect(scanFleet(home, db, env).observations).toContainEqual(expect.objectContaining({ verb: "done", note: "before close" }));
    db.close();
  });
});
