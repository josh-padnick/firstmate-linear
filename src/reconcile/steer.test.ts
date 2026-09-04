import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import { discoverLocalSteers, reconcileSteers } from "./steer.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("recipient-side handled evidence acknowledges a steer", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const inbox = join(home, "state", "worker.inbox"); mkdirSync(join(inbox, "handled"), { recursive: true });
  const record = join(inbox, "one.json"); writeFileSync(record, "{}\n");
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  const steer = db.recordSteer({ issue: "ABC-1", home: "local", task: "worker", record_path: record, sent_at: "2026-01-01T12:00:00Z" });
  renameSync(record, join(inbox, "handled", "one.json"));
  expect(reconcileSteers(home, db, testWorkflowConfig(), { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:01:00Z") / 1000) }).acked).toBe(1);
  expect(db.steers().find((item) => item.id === steer.id)?.acked_at).not.toBeNull();
  db.close();
});

test("an unacknowledged steer redelivers once and then stalls once", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const inbox = join(home, "state", "worker.inbox"); mkdirSync(inbox, { recursive: true });
  const record = join(inbox, "one.json"); writeFileSync(record, "{}\n");
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null });
  db.recordSteer({
    issue: "ABC-1", home: "local", task: "worker", record_path: record,
    lifecycle_id: db.taskLinks("ABC-1", true)[0]!.lifecycle_id, sent_at: "2026-01-01T12:00:00Z",
  });
  const config = testWorkflowConfig();
  expect(reconcileSteers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:04:00Z") / 1000) }).redelivered).toBe(1);
  expect(reconcileSteers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:05:00Z") / 1000) }).redelivered).toBe(0);
  expect(reconcileSteers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:11:00Z") / 1000) }).stalled).toBe(1);
  expect(reconcileSteers(home, db, config, { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:12:00Z") / 1000) }).stalled).toBe(0);
  expect(db.listEvents(["waiting-for-core"])[0]?.note).toContain("doorbell may not be landing");
  db.close();
});

test("remote recipient activity acknowledges through the remote probe interval", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  const steer = db.recordSteer({ issue: "ABC-1", home: "mini", task: "worker", record_path: "/remote/state/worker.inbox/one.json", sent_at: "2026-01-01T12:00:00Z" });
  let probes = 0;
  const probe = () => { probes += 1; return "acknowledged" as const; };

  expect(reconcileSteers(home, db, testWorkflowConfig(), { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:01:00Z") / 1000) }, new Set(), probe).acked).toBe(1);
  expect(probes).toBe(1);
  expect(db.steers().find((item) => item.id === steer.id)?.acked_at).not.toBeNull();
  db.close();
});

test("remote probes are limited per host and rotate fairly", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  db.recordSteer({ issue: "ABC-1", home: "mini", task: "first", record_path: "/remote/state/first.inbox/one.json", sent_at: "2026-01-01T12:00:00Z" });
  db.recordSteer({ issue: "ABC-2", home: "mini", task: "second", record_path: "/remote/state/second.inbox/two.json", sent_at: "2026-01-01T12:00:00Z" });
  const probed: string[] = [];
  const probe = (steer: { task: string }) => { probed.push(steer.task); return steer.task === "second" ? "acknowledged" as const : "unacknowledged" as const; };
  expect(reconcileSteers(home, db, testWorkflowConfig(), { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:01:00Z") / 1000) }, new Set(), probe).acked).toBe(0);
  expect(probed).toEqual(["first"]);
  expect(reconcileSteers(home, db, testWorkflowConfig(), { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:01:01Z") / 1000) }, new Set(), probe).acked).toBe(1);
  expect(probed).toEqual(["first", "second"]);
  db.close();
});

test("local discovery skips records removed between listing and inspection", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const inbox = join(home, "state", "worker.inbox"); mkdirSync(inbox, { recursive: true });
  symlinkSync(join(home, "already-moved.msg"), join(inbox, "missing.msg"));
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  expect(discoverLocalSteers(home, db)).toBe(0);
  expect(db.steers()).toHaveLength(0);
  db.close();
});

test("redelivery does not cross a replacement task lifecycle", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null });
  const lifecycle = db.taskLinks("ABC-1", true)[0]!.lifecycle_id;
  db.recordSteer({ issue: "ABC-1", home: "local", task: "worker", record_path: join(home, "missing.msg"), lifecycle_id: lifecycle, sent_at: "2026-01-01T12:00:00Z" });
  db.closeTask("worker", "2026-01-01T12:01:00Z");
  db.linkTask({ task: "worker", issue: "ABC-2", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:02:00Z", torn_down_at: null });
  expect(reconcileSteers(home, db, testWorkflowConfig(), { FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:04:00Z") / 1000) }).redelivered).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("local discovery attributes a record to the lifecycle active when it was written", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const inbox = join(home, "state", "worker.inbox"); mkdirSync(inbox, { recursive: true });
  const record = join(inbox, "one.msg"); writeFileSync(record, "schema=fm-task-inbox.v1\n--\nOld request\n");
  utimesSync(record, new Date("2026-01-01T12:00:00Z"), new Date("2026-01-01T12:00:00Z"));
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  db.linkTask({ lifecycle_id: "link:old", task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null });
  db.closeTask("worker", "2026-01-01T12:01:00Z");
  db.linkTask({ lifecycle_id: "link:new", task: "worker", issue: "ABC-2", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:02:00Z", torn_down_at: null });

  expect(discoverLocalSteers(home, db)).toBe(1);
  expect(db.steers()[0]).toMatchObject({ issue: "ABC-1", lifecycle_id: "link:old" });
  expect(reconcileSteers(home, db, testWorkflowConfig(), {
    FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:04:00Z") / 1000),
  }).redelivered).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("an unresolved legacy steer is never redelivered to a current task", () => {
  const home = mkdtempSync("/private/tmp/fml-steer-"); roots.push(home);
  const db = new StateDatabase(join(home, "db"), join(home, "backups"));
  db.linkTask({ lifecycle_id: "link:new", task: "worker", issue: "ABC-2", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:02:00Z", torn_down_at: null });
  db.recordSteer({ issue: "ABC-1", home: "local", task: "worker", record_path: join(home, "missing.msg"), sent_at: "2026-01-01T12:00:00Z" });

  expect(reconcileSteers(home, db, testWorkflowConfig(), {
    FM_HOME: home, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:04:00Z") / 1000),
  }).redelivered).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});
