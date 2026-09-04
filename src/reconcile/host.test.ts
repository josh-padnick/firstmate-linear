import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import { collectHostSamples, reconcileHostHealth, remoteSampleScript } from "./host.ts";
import { reconcileSteers } from "./steer.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("sustained host starvation emits once and clears only after a healthy window", () => {
  const root = mkdtempSync("/private/tmp/fml-host-"); roots.push(root);
  const db = new StateDatabase(join(root, "db"), join(root, "backups"));
  const config = testWorkflowConfig();
  const steer = db.recordSteer({ issue: "ABC-1", home: "mini", task: "worker", record_path: "/remote/state/worker.inbox/one.json", sent_at: "2026-01-01T11:50:00Z" });
  db.updateSteer(steer.id, { waitingOnHost: true, redeliveredAt: "2026-01-01T11:53:00Z" });
  db.raw.query("INSERT INTO remote_rings(home,installed_at,checked_at) VALUES(?,?,?)").run("mini", "2026-01-01T11:00:00Z", "2026-01-01T11:00:00Z");
  db.recordHostSample({ host: "mini", observed_at: "2026-01-01T12:00:00Z", load1: 181, cores: 10, free_mb: 60, top_processes: JSON.stringify(["95 node big-plan review"]) });
  expect(reconcileHostHealth(db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:04:00Z") / 1000) }).emitted).toBe(0);
  db.recordHostSample({ host: "mini", observed_at: "2026-01-01T12:06:00Z", load1: 181, cores: 10, free_mb: 60, top_processes: JSON.stringify(["95 node big-plan review"]) });
  const unhealthy = reconcileHostHealth(db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:06:00Z") / 1000) });
  expect(unhealthy.emitted).toBe(1);
  expect(unhealthy.degraded.has("mini")).toBe(true);
  expect(db.listEvents(["waiting-for-core"])[0]?.note).toContain("95 node big-plan review");
  expect(reconcileHostHealth(db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:07:00Z") / 1000) }).emitted).toBe(0);
  db.recordHostSample({ host: "mini", observed_at: "2026-01-01T12:07:00Z", load1: 3, cores: 10, free_mb: 4096, top_processes: "[]" });
  expect(reconcileHostHealth(db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:11:00Z") / 1000) }).degraded.has("mini")).toBe(true);
  expect(reconcileHostHealth(db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:12:00Z") / 1000) }).cleared).toBe(1);
  expect(db.steers()[0]).toMatchObject({ waiting_on_host: 0, redelivered_at: null });
  expect(reconcileSteers(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:12:00Z") / 1000) }, new Set(), () => "unacknowledged").redelivered).toBe(1);
  expect(reconcileSteers(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:13:00Z") / 1000) }, new Set(), () => "unacknowledged").redelivered).toBe(0);
  db.close();
});

test("the remote host probe collects only the four smoke-detector fields", () => {
  const script = remoteSampleScript();
  const encoded = /b64decode\('([^']+)'\)/.exec(script)?.[1] ?? "";
  const program = Buffer.from(encoded, "base64").toString("utf8");
  expect(program).toContain("load1");
  expect(program).toContain("cores");
  expect(program).toContain("free_mb");
  expect(program).toContain("top_processes");
  expect(program).not.toContain("kill");
});

test("remote host sampling uses the structured registry host", () => {
  const root = mkdtempSync("/private/tmp/fml-host-"); roots.push(root);
  mkdirSync(join(root, "data")); mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "data", "secondmates.md"), "- big-plan - owns planning (host: fm-mini; root: /remote/root; home: /remote/home; scope: plans; projects: big-plan; added 2026-01-01)\n");
  const calls = join(root, "calls");
  writeFileSync(join(root, "bin", "fm-on.sh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nprintf '{"load1":2,"cores":10,"free_mb":4096,"top_processes":["2 node worker"]}\\n'\n`);
  chmodSync(join(root, "bin", "fm-on.sh"), 0o755);
  const db = new StateDatabase(join(root, "db"), join(root, "backups"));

  expect(collectHostSamples(root, db, testWorkflowConfig(), { FM_HOME: root, FM_ROOT_OVERRIDE: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:00:00Z") / 1000) })).toContainEqual(expect.objectContaining({ host: "fm-mini", load1: 2 }));
  expect(readFileSync(calls, "utf8")).toStartWith("fm-mini sh -c ");
  db.close();
});
