import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import { proxyStatusLine, reconcileIdleWorkers } from "./idle.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setTime(path: string, iso: string): void {
  const date = new Date(iso);
  utimesSync(path, date, date);
}

test("idle worker gets one nudge and then one attributed proxy block", () => {
  const home = mkdtempSync("/private/tmp/fml-idle-"); roots.push(home);
  mkdirSync(join(home, "state"));
  const status = join(home, "state", "worker.status");
  const turn = join(home, "state", "worker.turn-ended");
  writeFileSync(status, "working: implementing\n"); setTime(status, "2026-01-01T12:00:00Z");
  writeFileSync(turn, "turn ended\n"); setTime(turn, "2026-01-01T12:01:00Z");
  writeFileSync(join(home, "state", "worker.busy-state"), "v1 gen=g seq=1 state=idle source=test event=turn ts=1\n");
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null });
  const config = testWorkflowConfig();
  expect(reconcileIdleWorkers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:06:00Z") / 1000) })).toMatchObject({ nudged: 1, proxied: 0 });
  expect(JSON.parse(db.jobs()[0]!.payload)).toMatchObject({ lifecycle_id: db.taskLinks("ABC-1", true)[0]!.lifecycle_id });
  expect(reconcileIdleWorkers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:07:00Z") / 1000) }).nudged).toBe(0);
  expect(reconcileIdleWorkers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:12:00Z") / 1000) })).toMatchObject({ nudged: 0, proxied: 1, stalled: 1 });
  expect(readFileSync(status, "utf8").match(/blocked \[key=idle\] \[service\]/g)).toHaveLength(1);
  expect(reconcileIdleWorkers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:00Z") / 1000) }).proxied).toBe(0);
  db.close();
});

describe("proxyStatusLine", () => {
  test("rejects other verbs, missing attribution, and duplicate writes", () => {
    const home = mkdtempSync("/private/tmp/fml-proxy-"); roots.push(home);
    const path = join(home, "status");
    expect(() => proxyStatusLine(path, "done: guessed", false)).toThrow("permits only blocked");
    expect(() => proxyStatusLine(path, "blocked [key=idle]: no response", false)).toThrow("permits only blocked");
    expect(() => proxyStatusLine(path, "blocked [key=idle] [service]: no response", true)).toThrow("already written");
  });
});
