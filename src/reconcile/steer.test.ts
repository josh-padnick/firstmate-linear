import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import { reconcileSteers } from "./steer.ts";

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
  db.recordSteer({ issue: "ABC-1", home: "local", task: "worker", record_path: record, sent_at: "2026-01-01T12:00:00Z" });
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
