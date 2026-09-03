import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { planReviewDeadlines } from "./reconcile.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const statuses = { backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting", plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building", validating_code: "Validating Code", approve_deliverable: "Approve Deliverable", needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision", done: "Done", canceled: "Canceled", duplicate: "Duplicate" } as const;
const config: WorkflowConfig = { version: 1, captain: { display_name: "Captain" }, teams: [{ key: "ABC", projects: [], managed: "all", statuses: { ...statuses }, agent_labels: {} }], features: { relay: "off", mirror: "on", escalation: "off" }, templates: { reply: "", report: "", review_walkthrough: "" }, sourcePath: "test" };

describe("review deadline reconciler", () => {
  test("nags at 15 minutes and mentions the captain at 45 minutes", () => {
    const root = mkdtempSync("/private/tmp/fml-review-deadline-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: "service", last_signal: "pr-green", observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.observe({ id: "obs:green", source: "pr", task: "task", issue: "ABC-1", verb: "pr-green", key: "pr", note: "https://example.test/pr/1", observed_at: "2026-01-01T00:00:00Z" });
    const fifteen = planReviewDeadlines(root, db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:16:00Z") / 1000) });
    expect(fifteen.jobs[0]?.key).toEndWith(":15m");
    const fortyFive = planReviewDeadlines(root, db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T00:46:00Z") / 1000) });
    expect(fortyFive.jobs[0]?.key).toEndWith(":45m");
    expect((fortyFive.jobs[0]?.payload as { body: string }).body).toStartWith("Captain:");
    const dir = join(root, "data", "abc-1"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review-walkthrough.html"), '<section id="outcome">Good</section><section id="changes">Good</section><section id="verification">Good</section><section id="review">Good</section>');
    expect(planReviewDeadlines(root, db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T01:00:00Z") / 1000) }).jobs).toHaveLength(0);
    db.close();
  });

  test("a withdrawn current PR state suppresses historical green reminders", () => {
    const root = mkdtempSync("/private/tmp/fml-review-deadline-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: "service", last_signal: "pr-green", observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.observe({ id: "obs:green", source: "pr", task: "task", issue: "ABC-1", verb: "pr-green", key: "pr", note: "https://example.test/pr/1", observed_at: "2026-01-01T00:00:00Z" });
    db.observe({ id: "obs:withdrawn", source: "pr", task: "task", issue: "ABC-1", verb: "pr-withdrawn", key: "pr", note: "https://example.test/pr/1", observed_at: "2026-01-01T00:01:00Z" });
    const plan = planReviewDeadlines(root, db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T01:00:00Z") / 1000) });
    expect(plan).toEqual({ jobs: [], findings: [] });
    db.close();
  });

  test("merged primary and green support PRs cannot reactivate reminders", () => {
    const root = mkdtempSync("/private/tmp/fml-review-deadline-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: "service", last_signal: "pr-green", observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "primary", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.linkTask({ task: "support", issue: "ABC-1", role: "support", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.observe({ id: "green-primary", source: "pr", task: "primary", issue: "ABC-1", verb: "pr-green", key: "pr", note: null, observed_at: "2026-01-01T00:00:00Z" });
    db.observe({ id: "merged-primary", source: "pr", task: "primary", issue: "ABC-1", verb: "pr-merged", key: "pr", note: null, observed_at: "2026-01-01T00:01:00Z" });
    db.observe({ id: "green-support", source: "pr", task: "support", issue: "ABC-1", verb: "pr-green", key: "pr", note: null, observed_at: "2026-01-01T00:02:00Z" });
    expect(planReviewDeadlines(root, db, config, { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T01:00:00Z") / 1000) })).toEqual({ jobs: [], findings: [] });
    db.close();
  });
});
