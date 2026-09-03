import { describe, expect, test } from "bun:test";
import { foldSignals, reduceTaskState } from "./reducer.ts";

describe("task reducer", () => {
  test("existential gates outrank completion", () => {
    expect(reduceTaskState([
      { task: "a", role: "primary", signal: "done" },
      { task: "b", role: "primary", signal: "needs-decision" },
    ])).toBe("needs-decision");
  });

  test("done is universal over primary tasks and support never drives state", () => {
    expect(reduceTaskState([
      { task: "a", role: "primary", signal: "done" },
      { task: "b", role: "primary", signal: "working" },
      { task: "s", role: "support", signal: "failed" },
    ])).toBe("working");
  });

  test("resolved clears one task signal", () => {
    const state = foldSignals([
      { task: "a", role: "primary", signal: "blocked" },
      { task: "a", role: "primary", signal: "resolved" },
    ]);
    expect(reduceTaskState(state)).toBe("working");
  });

  test("resolved clears only the matching key", () => {
    const state = foldSignals([
      { task: "a", role: "primary", signal: "needs-decision", key: "color" },
      { task: "a", role: "primary", signal: "needs-decision", key: "size" },
      { task: "a", role: "primary", signal: "resolved", key: "color" },
    ]);
    expect(reduceTaskState(state)).toBe("needs-decision");
  });
});
