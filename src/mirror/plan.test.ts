import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase, type Observation } from "../db/database.ts";
import { planMirror } from "./plan.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const statuses = { backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting", plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building", validating_code: "Validating Code", approve_deliverable: "Approve Deliverable", needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision", done: "Done", canceled: "Canceled", duplicate: "Duplicate" } as const;
const config: WorkflowConfig = { version: 1, captain: { display_name: "Captain" }, teams: [{ key: "ABC", projects: [], managed: "all", statuses: { ...statuses }, agent_labels: { unknown: "Agent: unknown" } }], features: { relay: "off", mirror: "shadow", escalation: "off" }, templates: { reply: "", report: "", review_walkthrough: "" }, sourcePath: "test" };

describe("mirror plan", () => {
  test("one done primary and one working primary does not advance", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    for (const task of ["a", "b"]) db.linkTask({ task, issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const done: Observation = { id: "o1", source: "status", task: "a", issue: "ABC-1", verb: "done", key: "default", note: null, observed_at: "2026-01-01T00:01:00Z" };
    const working: Observation = { ...done, id: "o2", task: "b", verb: "working", observed_at: "2026-01-01T00:02:00Z" };
    db.observe(done); db.observe(working);
    expect(planMirror(db, config, [done, working]).actions.filter((action) => action.job.kind === "linear.issue-state")).toHaveLength(0);
    db.close();
  });

  test("captain hand drag without a newer file signal is reported, not repaired", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Prioritized", assignee: "Captain", labels: [], agent_label: null, last_actor: "Captain", last_signal: null, observed_at: "2026-01-01T00:02:00Z" });
    db.linkTask({ task: "a", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const observation: Observation = { id: "o1", source: "status", task: "a", issue: "ABC-1", verb: "working", key: "default", note: null, observed_at: "2026-01-01T00:01:00Z" };
    db.observe(observation);
    const plan = planMirror(db, config, []);
    expect(plan.actions).toHaveLength(0);
    expect(plan.findings[0]?.code).toBe("CAPTAIN_DRAG");
    db.close();
  });

  test("same-second observations retain source insertion order", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "a", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const working: Observation = { id: "z-first", source: "status", task: "a", issue: "ABC-1", verb: "working", key: "default", note: null, observed_at: "2026-01-01T00:01:00Z" };
    const decision: Observation = { ...working, id: "a-second", verb: "needs-decision" };
    db.observe(working); db.observe(decision);
    const stateJob = planMirror(db, config, [working, decision]).actions.find((action) => action.job.kind === "linear.issue-state");
    expect(stateJob?.job.payload).toMatchObject({ state: "Needs Decision" });
    db.close();
  });

  test("support PR transitions do not drive issue state", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "support", issue: "ABC-1", role: "support", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const green: Observation = { id: "support-green", source: "pr", task: "support", issue: "ABC-1", verb: "pr-green", key: "pr", note: null, observed_at: "2026-01-01T00:01:00Z" };
    db.observe(green);
    expect(planMirror(db, config, [green]).actions.filter((action) => action.job.kind === "linear.issue-state")).toHaveLength(0);
    db.close();
  });

  test("signals from torn-down tasks no longer affect reduction", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "closed", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: "2026-01-01T00:01:00Z" });
    db.linkTask({ task: "replacement", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null });
    const failed: Observation = { id: "closed-failed", source: "status", task: "closed", issue: "ABC-1", verb: "failed", key: "default", note: null, observed_at: "2026-01-01T00:01:00Z" };
    const working: Observation = { ...failed, id: "replacement-working", task: "replacement", verb: "working", observed_at: "2026-01-01T00:03:00Z" };
    db.observe(failed); db.observe(working);
    expect(planMirror(db, config, [working]).actions.filter((action) => action.job.kind === "linear.issue-state")).toHaveLength(0);
    db.close();
  });

  test("support control signals never drive issue state", () => {
    for (const verb of ["dispatch", "dispatch-scout", "lane-cap"]) {
      const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
      const db = new StateDatabase(join(root, "db"), join(root, "backups"));
      db.snapshot({ issue: "ABC-1", state: "Prioritized", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
      db.linkTask({ task: "support", issue: "ABC-1", role: "support", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
      const observation: Observation = { id: `support-${verb}`, source: "summary", task: "support", issue: "ABC-1", verb, key: null, note: null, observed_at: "2026-01-01T00:01:00Z" };
      db.observe(observation);
      expect(planMirror(db, config, [observation]).actions.filter((action) => action.job.kind === "linear.issue-state")).toHaveLength(0);
      db.close();
    }
  });

  test("an active green primary PR preserves the approval gate", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "primary", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const green: Observation = { id: "green", source: "pr", task: "primary", issue: "ABC-1", verb: "pr-green", key: "pr", note: null, observed_at: "2026-01-01T00:01:00Z" };
    const working: Observation = { ...green, id: "later-working", source: "status", verb: "working", key: "default", observed_at: "2026-01-01T00:02:00Z" };
    db.observe(green); db.observe(working);
    expect(planMirror(db, config, [working]).actions.filter((action) => action.job.kind === "linear.issue-state")).toHaveLength(0);
    db.close();
  });

  test("a completed primary task advances the issue to done", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "primary", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const done: Observation = { id: "done", source: "status", task: "primary", issue: "ABC-1", verb: "done", key: "default", note: null, observed_at: "2026-01-01T00:01:00Z" };
    db.observe(done);
    const state = planMirror(db, config, [done]).actions.find((action) => action.job.kind === "linear.issue-state");
    expect(state?.job.payload).toMatchObject({ state: "Done" });
    db.close();
  });

  test("a new model observation labels the issue even when another signal is newer", () => {
    const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const mapped = structuredClone(config);
    mapped.teams[0]!.agent_labels = { opus: "Agent: opus", unknown: "Agent: unknown" };
    db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "primary", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const model: Observation = { id: "model", source: "meta", task: "primary", issue: "ABC-1", verb: "model-resolved", key: "model", note: "model=opus", observed_at: "2026-01-01T00:01:00Z" };
    const working: Observation = { ...model, id: "working", source: "status", verb: "working", key: "default", note: null, observed_at: "2026-01-01T00:02:00Z" };
    db.observe(model); db.observe(working);
    const label = planMirror(db, mapped, [model, working]).actions.find((action) => action.job.kind === "linear.agent-label");
    expect(label?.job.payload).toMatchObject({ label: "Agent: opus" });
    expect(label?.cause).toBe("model");
    db.close();
  });

  test("one primary PR cannot bypass unfinished primary tasks", () => {
    for (const verb of ["pr-green", "pr-merged"]) {
      const root = mkdtempSync("/private/tmp/fml-plan-"); roots.push(root);
      const db = new StateDatabase(join(root, "db"), join(root, "backups"));
      db.snapshot({ issue: "ABC-1", state: "Building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
      for (const task of ["a", "b"]) db.linkTask({ task, issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
      const pr: Observation = { id: `a-${verb}`, source: "pr", task: "a", issue: "ABC-1", verb, key: "pr", note: null, observed_at: "2026-01-01T00:01:00Z" };
      const working: Observation = { ...pr, id: `b-working-${verb}`, source: "status", task: "b", verb: "working", key: "default", observed_at: "2026-01-01T00:02:00Z" };
      db.observe(pr); db.observe(working);
      expect(planMirror(db, config, [pr, working]).actions.filter((action) => action.job.kind === "linear.issue-state")).toHaveLength(0);
      db.close();
    }
  });
});
