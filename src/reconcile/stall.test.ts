import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { planEscalations } from "../escalation/escalation.ts";
import { reconcileStalls } from "./stall.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const config: WorkflowConfig = {
  version: 1,
  captain: { display_name: "Captain" },
  teams: [{
    key: "ABC", projects: [], managed: "all", agent_labels: {},
    statuses: {
      backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting",
      plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building",
      validating_code: "Validating Code", approve_deliverable: "Approve Deliverable",
      needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision",
      done: "Done", canceled: "Canceled", duplicate: "Duplicate",
    },
  }],
  features: { relay: "off", mirror: "off", escalation: "on" },
  templates: { reply: "reply.md", report: "report.md", review_walkthrough: "review.html" },
  deadlines: {
    progress: { "Plan In Progress": 1800, Building: 2700, "Validating Code": 3600, Waiting: 14400, "Needs Firstmate Decision": 900 },
    stalled: { mention: 1800 },
  },
  promises: { required_on_firstmate_owned: true, vocabulary: ["status:*", "board:*", "pr-reported", "pr-green", "pr-merged", "comment", "dispatch", "none"] },
  sourcePath: "test",
};

function setup(): { root: string; db: StateDatabase } {
  const root = mkdtempSync("/private/tmp/fml-stall-"); roots.push(root);
  return { root, db: new StateDatabase(join(root, "db.sqlite"), join(root, "backups")) };
}

describe("stall reconciliation", () => {
  test("a pr-green promise observed before its deadline is kept without a wake", () => {
    const { root, db } = setup();
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    const promise = db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });
    db.observe({ id: "obs:green", source: "pr", task: "worker", issue: "ABC-1", verb: "pr-green", key: "pr", note: null, observed_at: "2026-01-01T12:20:00Z" });

    const result = reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000) });

    expect(result.emitted).toBe(0);
    expect(db.promise(promise.id)).toMatchObject({ state: "kept", observation_id: "obs:green" });
    expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
    db.close();
  });

  test("an overdue pr-green promise emits one specific stalled wake", () => {
    const { root, db } = setup();
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T11:52:00Z" });
    db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });

    const result = reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000) });
    const event = db.listEvents(["waiting-for-core"])[0]!;

    expect(result.emitted).toBe(1);
    expect(event).toMatchObject({ issue: "ABC-1", type: "stalled", token: "stalled" });
    expect(event.note).toContain("promised pr-green");
    expect(event.note).toContain("last progress 11:52");
    expect(event.note).toContain(event.id);
    expect(JSON.parse(event.raw_ref).required).toContain("validation runs");
    db.close();
  });

  test("a late observation keeps the promise and resolves its pending stall", () => {
    const { root, db } = setup();
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    const promise = db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });
    const env = { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000) };
    reconcileStalls(root, db, config, env);
    const stalledId = db.promise(promise.id)?.stalled_event_id;
    db.observe({ id: "obs:green-late", source: "pr", task: "worker", issue: "ABC-1", verb: "pr-green", key: "pr", note: null, observed_at: "2026-01-01T12:32:00Z" });
    reconcileStalls(root, db, config, { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:33:00Z") / 1000) });
    expect(db.promise(promise.id)).toMatchObject({ state: "kept", observation_id: "obs:green-late" });
    expect(db.event(stalledId!)?.disposition).toBe("handled-by-service");
    db.close();
  });

  test("a newer promise supersedes the earlier commitment", () => {
    const { root, db } = setup();
    const first = db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "status:done", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:first", created_at: "2026-01-01T12:00:00Z" });
    const second = db.createPromise({ issue: "ABC-1", source_event_id: "event:two", expected_event: "pr-green", deadline_at: "2026-01-01T13:00:00Z", reply_job_id: "job:second", created_at: "2026-01-01T12:10:00Z" });

    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000) });

    expect(db.promise(first.id)).toMatchObject({ state: "superseded", superseded_by: second.id });
    expect(db.promise(second.id)).toMatchObject({ state: "open" });
    expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
    db.close();
  });

  test("a busy primary worker suppresses the heartbeat while the same idle issue stalls", () => {
    const { root, db } = setup();
    mkdirSync(join(root, "state"));
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T12:00:00Z" });
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    writeFileSync(join(root, "state", "worker.busy-state"), "v1 gen=g1.1.1 seq=1 state=busy source=test event=turn ts=1\n");
    const env = { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:46:00Z") / 1000) };

    expect(reconcileStalls(root, db, config, env).emitted).toBe(0);
    rmSync(join(root, "state", "worker.busy-state"));
    expect(reconcileStalls(root, db, config, env).emitted).toBe(1);
    expect(db.listEvents(["waiting-for-core"])[0]?.note).toContain("Building 46m");
    db.close();
  });

  test("captain-owned statuses never emit progress heartbeats", () => {
    const { root, db } = setup();
    db.snapshot({ issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: "Captain", last_signal: null, observed_at: "2026-01-01T09:00:00Z" });
    expect(reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:00:00Z") / 1000) }).emitted).toBe(0);
    db.close();
  });

  test("a stall deduplicates within one overdue multiple and re-emits at the next", () => {
    const { root, db } = setup();
    db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });
    const at31 = { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000) };
    expect(reconcileStalls(root, db, config, at31).emitted).toBe(1);
    expect(reconcileStalls(root, db, config, at31).emitted).toBe(0);
    expect(reconcileStalls(root, db, config, { ...at31, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T13:01:00Z") / 1000) }).emitted).toBe(1);
    expect(db.listEvents(["waiting-for-core"]).filter((event) => event.token === "stalled")).toHaveLength(1);
    db.close();
  });

  test("an unhandled stall mentions the captain once after thirty minutes", () => {
    const { root, db } = setup();
    db.createPromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: "job:reply", created_at: "2026-01-01T12:00:00Z" });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:31:00Z") / 1000) });

    const plan = planEscalations(db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T13:02:00Z") / 1000) });

    expect(plan).toHaveLength(1);
    expect(plan[0]?.job.key).toContain(":escalation:mention");
    expect(JSON.stringify(plan[0]?.job.payload)).toContain("Captain");
    db.enqueue(plan[0]!.job, "2026-01-01T13:02:00Z");
    expect(planEscalations(db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T14:02:00Z") / 1000) })).toHaveLength(0);
    db.close();
  });
});
