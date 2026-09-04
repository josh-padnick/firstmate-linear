import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", host: "mini", worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null });
  const steer = db.recordSteer({
    issue: "ABC-1", home: "mini", task: "worker", record_path: "/remote/state/worker.inbox/one.json",
    lifecycle_id: db.taskLinks("ABC-1", true)[0]!.lifecycle_id, sent_at: "2026-01-01T11:50:00Z",
  });
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

test("the remote host probe emits a normalized smoke-detector sample", () => {
  const root = mkdtempSync("/private/tmp/fml-host-probe-"); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "vm_stat"), "#!/bin/sh\nprintf 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\\nPages free: 256.\\nPages inactive: 512.\\n'\n");
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nprintf 'COMMAND\\nnode worker.js\\nnode worker.js\\npython service.py\\n'\n");
  chmodSync(join(bin, "vm_stat"), 0o755); chmodSync(join(bin, "ps"), 0o755);
  const script = remoteSampleScript();
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  expect(result.status).toBe(0);
  const sample = JSON.parse(result.stdout);
  expect(Object.keys(sample).sort()).toEqual(["cores", "free_mb", "load1", "top_processes"]);
  expect(sample).toMatchObject({ free_mb: 3, top_processes: ["2 node worker.js", "1 python service.py"] });
  expect(sample.cores).toBeGreaterThan(0);
  expect(Number.isFinite(sample.load1)).toBe(true);
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

test("host sampling retains only the active window and one preceding sample", () => {
  const root = mkdtempSync("/private/tmp/fml-host-"); roots.push(root);
  const db = new StateDatabase(join(root, "db"), join(root, "backups"));
  const config = testWorkflowConfig();
  for (const observed_at of ["2026-01-01T11:00:00Z", "2026-01-01T11:50:00Z", "2026-01-01T11:56:00Z"]) {
    db.recordHostSample({ host: "local", observed_at, load1: 1, cores: 10, free_mb: 4096, top_processes: "[]" });
  }
  collectHostSamples(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:00:00Z") / 1000) });
  expect(db.hostSamples("local").map((sample) => sample.observed_at)).toEqual([
    "2026-01-01T11:50:00Z", "2026-01-01T11:56:00Z", "2026-01-01T12:00:00Z",
  ]);
  db.close();
});
