import { describe, expect, test } from "bun:test";
import { classifyEvent, isExactGatePhrase, normalizedComment } from "./classify.ts";
import { FULL_ROLES, testWorkflowConfig } from "../testing/config.ts";
import type { WorkflowRole } from "../config/schema.ts";

const config = testWorkflowConfig();
const comment = { id: "event:1", team: "ABC", issue: "ABC-1", type: "comment", author: "Captain", body: "let's merge it", created_at: "2026-01-01T00:00:00Z" };

function snapshot(role: WorkflowRole) {
  return { issue: "ABC-1", role, assignee: "Captain", labels: [], agent_label: null, last_actor: null, last_signal: null, observed_at: "2026-01-01T00:00:00Z" };
}

describe("status-scoped gate classification", () => {
  test("a gate phrase must be the entire normalized comment", () => {
    expect(normalizedComment(" **Approved**! \n")).toBe("approved");
    expect(isExactGatePhrase("LGTM.", ["lgtm"])).toBe(true);
    expect(isExactGatePhrase("Approved if you fix X", ["approved"])).toBe(false);
  });

  test("the same phrase has a different action at each gate", () => {
    const plan = classifyEvent(comment, config, snapshot("plan-gate"));
    const review = classifyEvent(comment, config, snapshot("review-gate"));
    const merge = classifyEvent(comment, config, snapshot("merge-gate"));
    expect(plan).toMatchObject({ token: "gate-pass", gate: "plan-gate", next: "building" });
    expect(plan.jobs[0]?.payload).toMatchObject({ role: "building", expected_role: "plan-gate" });
    expect(review).toMatchObject({ token: "gate-pass", gate: "review-gate", next: "validating" });
    expect(review.jobs[0]?.payload).toMatchObject({ role: "validating", expected_role: "review-gate" });
    expect(merge).toMatchObject({ token: "gate-pass", gate: "merge-gate", next: "merge" });
    expect(merge.note).toContain("required: merge");
    expect(merge.jobs.map((job) => job.kind)).toEqual(["linear.comment", "promise.implicit"]);
  });

  test("approved at merge-gate remains a comment and does not promise a merge", () => {
    const result = classifyEvent({ ...comment, body: "approved" }, config, snapshot("merge-gate"));
    expect(result).toMatchObject({ token: "comment", jobs: [] });
    expect(result.note).toContain("ask whether");
  });

  test("configured generic approval never authorizes the merge gate", () => {
    const configured = { ...config, gates: { ...config.gates, "merge-gate": { ...config.gates["merge-gate"], phrases: ["approved", "lgtm"] } } };
    for (const body of ["approved", "LGTM."]) {
      expect(classifyEvent({ ...comment, body }, configured, snapshot("merge-gate"))).toMatchObject({ token: "comment", jobs: [] });
    }
  });

  test("a minimal review gate authorizes merge without moving the board", () => {
    const minimal = testWorkflowConfig({ roles: {
      building: "In Progress",
      "review-gate": "In Review",
      done: "Done",
      canceled: "Canceled",
    } });
    const result = classifyEvent({ ...comment, body: "approved" }, minimal, snapshot("review-gate"));
    expect(result).toMatchObject({ token: "gate-pass", gate: "review-gate", next: "merge" });
    expect(result.jobs.map((job) => job.kind)).toEqual(["linear.comment", "promise.implicit"]);
  });

  test("a conditional phrase is feedback and returns ownership to building", () => {
    const result = classifyEvent({ ...comment, body: "Approved if you fix X" }, config, snapshot("review-gate"));
    expect(result.token).toBe("ball-returned");
    expect(result.jobs[0]?.payload).toMatchObject({ role: "building", expected_role: "review-gate" });
  });

  test("an unmapped gate does not make its phrases special", () => {
    const noGates = testWorkflowConfig({ roles: {
      building: FULL_ROLES.building,
      done: FULL_ROLES.done,
      canceled: FULL_ROLES.canceled,
    } });
    const result = classifyEvent({ ...comment, body: "approved" }, noGates, snapshot("building"));
    expect(result).toMatchObject({ token: "comment", jobs: [] });
  });
});
