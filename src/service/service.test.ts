import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { planEscalations } from "../escalation/escalation.ts";
import { processJobs } from "../jobs/worker.ts";
import { reconcileStalls } from "../reconcile/stall.ts";
import { LinearTransport } from "../transport.ts";
import { activationActive, serviceCycle } from "./service.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const statuses = { backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting", plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building", validating_code: "Validating Code", approve_deliverable: "Approve Deliverable", needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision", done: "Done", canceled: "Canceled", duplicate: "Duplicate" } as const;
const config: WorkflowConfig = { version: 1, captain: { display_name: "Captain" }, teams: [{ key: "ABC", projects: [], managed: "all", statuses: { ...statuses }, agent_labels: {} }], features: { relay: "on", mirror: "on", escalation: "on" }, templates: { reply: "", report: "", review_walkthrough: "" }, sourcePath: "test" };

describe("service activation", () => {
  test("installation is inert until cutover is enabled", async () => {
    const root = mkdtempSync("/private/tmp/fml-service-"); roots.push(root);
    const env = { FM_HOME: root };
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "would-write", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "do not send" } });
    expect(activationActive(env)).toBe(false);
    const result = await serviceCycle({ db, config, env });
    expect(result).toMatchObject({ captured: 0, jobsDone: 0, mirrorActions: 0, escalations: 0 });
    expect(db.jobs()[0]?.state).toBe("pending");
    db.close();
  });

  test("missing-link findings retain each task identity", async () => {
    const root = mkdtempSync("/private/tmp/fml-service-"); roots.push(root);
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", "alpha.meta"), "model=test\n");
    writeFileSync(join(root, "state", "beta.meta"), "model=test\n");
    const env = { FM_HOME: root, FM_LINEAR_FORCE_ACTIVE: "1", FM_LINEAR_SKIP_CAPTURE: "1", FM_LINEAR_SKIP_GH: "1" };
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    await serviceCycle({ db, config, env });
    expect(db.observations("SYSTEM-0").filter((item) => item.key === "TASK_WITHOUT_LINK").map((item) => item.task).sort()).toEqual(["alpha", "beta"]);
    db.close();
  });

  test("an overdue promise is reconciled into one stalled wake", async () => {
    const root = mkdtempSync("/private/tmp/fml-service-"); roots.push(root);
    const env = {
      FM_HOME: root,
      FM_LINEAR_FORCE_ACTIVE: "1",
      FM_LINEAR_SKIP_CAPTURE: "1",
      FM_LINEAR_SKIP_GH: "1",
      FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000),
    };
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });
    const result = await serviceCycle({ db, config, env, transport: new (await import("../transport.ts")).LinearTransport({ fixtureDir: join(root, "unused") }) });
    expect(result.stalls).toBe(1);
    expect(db.listEvents(["waiting-for-core"])).toContainEqual(expect.objectContaining({ token: "stalled", issue: "ABC-1" }));
    db.close();
  });

  test("a delivered reply activates but does not satisfy its own comment promise", async () => {
    const root = mkdtempSync("/private/tmp/fml-service-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    writeFileSync(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const env = {
      FM_HOME: root,
      FM_LINEAR_FORCE_ACTIVE: "1",
      FM_LINEAR_SKIP_CAPTURE: "1",
      FM_LINEAR_SKIP_GH: "1",
      FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000),
    };
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const job = db.enqueue({ key: "reply", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "Update", actor: "core" } }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "comment", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z" });
    const result = await serviceCycle({ db, config, env, transport: new (await import("../transport.ts")).LinearTransport({ fixtureDir: fixtures }) });
    expect(result.stalls).toBe(0);
    expect(db.promise(promise.id)).toMatchObject({ state: "open", deadline_at: "2026-01-01T13:01:00Z" });
    expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
    db.close();
  });

  test("promise reconciliation cancels a stale escalation retry", async () => {
    const root = mkdtempSync("/private/tmp/fml-service-"); roots.push(root);
    const failed = join(root, "failed"); mkdirSync(failed);
    writeFileSync(join(failed, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    writeFileSync(join(failed, "02-fail-500.json"), "{}");
    writeFileSync(join(failed, "03-verify.json"), JSON.stringify({ data: { comment: null } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const promise = db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000) });
    const escalation = planEscalations(db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T13:01:00Z") / 1000) })[0]!;
    db.enqueue(escalation.job, "2026-01-01T13:01:00Z");
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: failed }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T13:01:00Z") / 1000) } });
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    db.observe({ id: "green", source: "pr", task: "worker", issue: "ABC-1", verb: "pr-green", key: "pr", note: null, observed_at: "2026-01-01T13:01:30Z" });
    const delivered = join(root, "delivered"); mkdirSync(delivered);
    writeFileSync(join(delivered, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    writeFileSync(join(delivered, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true } } }));
    const log = join(root, "calls.log");
    const env = { FM_HOME: root, FM_LINEAR_FORCE_ACTIVE: "1", FM_LINEAR_SKIP_CAPTURE: "1", FM_LINEAR_SKIP_GH: "1", FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T13:02:00Z") / 1000) };

    await serviceCycle({ db, config, env, transport: new LinearTransport({ fixtureDir: delivered, fixtureLog: log }) });

    expect(db.promise(promise.id)?.state).toBe("kept");
    expect(existsSync(log)).toBe(false);
    expect(db.jobs().find((job) => job.key.includes(":escalation:"))?.state).toBe("done");
    db.close();
  });

  test("CLI lifecycle commands isolate old signals during service reconciliation", () => {
    const root = mkdtempSync("/private/tmp/fml-service-cli-"); roots.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    const configPath = join(root, "config", "linear-workflow.yaml");
    const yaml = (mirror: "shadow" | "on") => `version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: all\nfeatures: { relay: off, mirror: ${mirror}, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n`;
    writeFileSync(configPath, yaml("shadow"));
    writeFileSync(join(root, "state", "worker.meta"), "model=codex\n");
    const statusPath = join(root, "state", "worker.status");
    writeFileSync(statusPath, "working: old lifecycle\n");
    writeFileSync(join(root, "state", "home-summary.json"), JSON.stringify({ generated: "2026-01-01T00:01:00Z", active_children: [{ id: "worker", state: "done" }] }));
    let db = StateDatabase.open({ FM_HOME: root });
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.close();
    const command = join(process.cwd(), "bin", "fm-linear");
    const env = { ...process.env, FM_HOME: root, FM_LINEAR_FORCE_ACTIVE: "1", FM_LINEAR_SKIP_CAPTURE: "1", FM_LINEAR_SKIP_GH: "1", FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:00:00Z") / 1000) };
    const run = (...args: string[]) => spawnSync(command, args, { env, encoding: "utf8" });
    expect(run("task", "link", "worker", "ABC-1", "--spawned-at", "2026-01-01T00:00:00Z").status).toBe(0);
    expect(run("service", "once").status).toBe(0);
    appendFileSync(statusPath, "done: closed lifecycle\n");
    expect(run("task", "close", "worker").status).toBe(0);
    expect(run("task", "link", "worker", "ABC-1", "--spawned-at", "2026-01-01T00:02:00Z").status).toBe(0);
    writeFileSync(configPath, yaml("on"));
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "service.log");
    const result = spawnSync(command, ["service", "once"], { env: { ...env, FM_LINEAR_FIXTURE_DIR: fixtures, FM_LINEAR_FIXTURE_LOG: log }, encoding: "utf8" });
    expect(result.status).toBe(0);
    db = StateDatabase.open({ FM_HOME: root });
    expect(db.jobs().filter((job) => job.kind === "linear.issue-state")).toHaveLength(0);
    expect(existsSync(log)).toBe(false);
    db.close();
  });
});
