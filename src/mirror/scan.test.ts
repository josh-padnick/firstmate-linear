import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
});
