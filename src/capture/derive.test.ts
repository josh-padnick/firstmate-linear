import { describe, expect, test } from "bun:test";
import { deriveComments, deriveHistory, deriveIssueCreation, type SeenStore } from "./derive.ts";

function seenStore(): SeenStore {
  const values = new Set<string>();
  return { has: (key) => values.has(key), add: (key) => { values.add(key); } };
}

describe("capture derivation cutoffs", () => {
  test("fractional timestamps inside the cutoff second are retained", () => {
    const comments = deriveComments([{
      id: "comment-1", createdAt: "2026-01-01T00:00:00.123Z", updatedAt: "2026-01-01T00:00:00.123Z",
      body: "go", user: { displayName: "Captain" }, issue: { identifier: "ABC-1" },
    }], seenStore(), "2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z", "Firstmate");
    const history = deriveHistory([{
      id: "history-1", issue: "ABC-1", createdAt: "2026-01-01T00:00:00.123Z",
      actor: { displayName: "Captain" }, fromState: { name: "Building" }, toState: { name: "Done" },
    }], seenStore(), "2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z", "Firstmate");
    expect(comments).toHaveLength(1);
    expect(history).toHaveLength(1);
    const issues = deriveIssueCreation([{
      identifier: "ABC-1", createdAt: "2026-01-01T00:00:00.123Z", updatedAt: "2026-01-01T00:00:01Z",
      creator: { displayName: "Captain" },
    }], seenStore(), "2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z", "Firstmate");
    expect(issues).toHaveLength(1);
  });

  test("edited comments are aged from their revision time", () => {
    const comments = deriveComments([{
      id: "comment-edited", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      body: "updated answer", user: { displayName: "Captain" }, issue: { identifier: "ABC-1" },
    }], seenStore(), "2026-01-01T00:01:00Z", null, "Firstmate");
    expect(comments[0]?.created_at).toBe("2026-01-01T00:00:00Z");
  });
});
