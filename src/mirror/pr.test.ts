import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { scanPullRequests } from "./pr.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("PR signals", () => {
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
});
