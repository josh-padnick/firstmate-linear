import { describe, expect, test } from "bun:test";
import { classifyEvent, isExactApproval, normalizedComment } from "./classify.ts";
import type { WorkflowConfig } from "../config/schema.ts";

const statuses = {
  backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting",
  plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building",
  validating_code: "Validating Code", approve_deliverable: "Approve Deliverable",
  needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision",
  done: "Done", canceled: "Canceled", duplicate: "Duplicate",
} as const;

const config: WorkflowConfig = {
  version: 1,
  captain: { display_name: "Captain" },
  teams: [{ key: "ABC", projects: [], managed: "assignee:self", statuses: { ...statuses }, agent_labels: {} }],
  features: { relay: "shadow", mirror: "shadow", escalation: "shadow" },
  templates: { reply: "reply.md", report: "report.md", review_walkthrough: "review.html" },
  sourcePath: "test.yaml",
};

const comment = { id: "event:1", team: "ABC", issue: "ABC-1", type: "comment", author: "Captain", body: "approved", created_at: "2026-01-01T00:00:00Z" };

describe("classification", () => {
  test("approval is an exact normalized comment", () => {
    expect(normalizedComment(" **Approved** \n")).toBe("approved");
    expect(isExactApproval("LGTM")).toBe(true);
    expect(isExactApproval("Approved if you fix X")).toBe(false);
  });

  test("exact deliverable approval queues validating and still wakes core", () => {
    const result = classifyEvent(comment, config, { issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: null, last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    expect(result.token).toBe("approval");
    expect(result.disposition).toBe("waiting-for-core");
    expect(result.jobs[0]?.payload).toMatchObject({ state: "Validating Code", expected_state: "Approve Deliverable" });
  });

  test("conditional approval is feedback and returns the ball", () => {
    const result = classifyEvent({ ...comment, body: "Approved if you fix X" }, config, { issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: null, last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    expect(result.token).toBe("ball-returned");
    expect(result.jobs[0]?.payload).toMatchObject({ state: "Building" });
  });

  test("approved is not an approval verdict while waiting on a decision", () => {
    const result = classifyEvent(comment, config, { issue: "ABC-1", state: "Needs Decision", assignee: "Captain", labels: [], agent_label: null, last_actor: null, last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    expect(result.token).toBe("ball-returned");
    expect((result.jobs[0]?.payload as { state: string }).state).toBe("Building");
  });
});
