import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LinearTransport } from "../transport.ts";
import { fetchComments, fetchIssues } from "./fetch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("capture pagination", () => {
  test("comment pagination is team-scoped and resumes after a bounded batch", async () => {
    const root = mkdtempSync("/private/tmp/fml-fetch-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-comments.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, comments: {
      pageInfo: { hasNextPage: true, endCursor: "managed-next" },
      nodes: [{ id: "c1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
    } } }));
    writeFileSync(join(fixtures, "02-comments.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, comments: {
      pageInfo: { hasNextPage: false },
      nodes: [{ id: "c2", createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z" }],
    } } }));
    const log = join(root, "calls.log");
    const transport = new LinearTransport({ fixtureDir: fixtures, fixtureLog: log });
    const first = await fetchComments(transport, null, { team: "ABC", forceSince: "2026-01-01T00:00:00Z", maxPages: 1 });
    const second = await fetchComments(transport, null, { team: "ABC", forceSince: "2026-01-01T00:00:00Z", after: first.resumeAfter, maxPages: 1 });
    expect(first.resumeAfter).toBe("managed-next");
    expect(second.comments.map((comment) => comment.id)).toEqual(["c2"]);
    expect(second.resumeAfter).toBeNull();
    const calls = (await Bun.file(log).text()).trim().split("\n").map((line) => JSON.parse(line.split("\t")[1]!));
    expect(calls[0].query).toContain('issue:{team:{key:{eq:"ABC"}}}');
    expect(calls[1].variables.after).toBe("managed-next");
  });

  test("issue pagination fails closed before returning a partial page", async () => {
    const root = mkdtempSync("/private/tmp/fml-fetch-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-issues.json"), JSON.stringify({ data: {
      issues: {
        pageInfo: { hasNextPage: true, endCursor: "next-page" },
        nodes: [{ identifier: "ABC-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z", history: { pageInfo: { hasNextPage: false }, nodes: [] } }],
      },
    } }));
    await expect(fetchIssues(new LinearTransport({ fixtureDir: fixtures }), null, null, { team: "ABC", maxPages: 1 }))
      .rejects.toThrow("issues pagination exceeded limit");
  });

  test("fractional history at the cutoff boundary is paginated", async () => {
    const root = mkdtempSync("/private/tmp/fml-fetch-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      id: `history-${index}`, createdAt: index === 9 ? "2026-01-01T00:00:00.123Z" : `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}Z`,
    }));
    writeFileSync(join(fixtures, "01-issues.json"), JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: false },
      nodes: [{ identifier: "ABC-1", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z", history: { pageInfo: { hasNextPage: true, endCursor: "history-next" }, nodes } }],
    } } }));
    writeFileSync(join(fixtures, "02-history.json"), JSON.stringify({ data: { issue: { history: {
      pageInfo: { hasNextPage: false }, nodes: [{ id: "history-last", createdAt: "2025-12-31T23:59:59Z" }],
    } } } }));
    const result = await fetchIssues(new LinearTransport({ fixtureDir: fixtures }), null, "2026-01-01T00:00:00Z", { team: "ABC" });
    expect(result.history).toHaveLength(11);
  });

  test("history pagination stops when a fetched page crosses the cutoff", async () => {
    const root = mkdtempSync("/private/tmp/fml-fetch-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const initial = Array.from({ length: 10 }, (_, index) => ({ id: `initial-${index}`, createdAt: `2026-01-01T00:01:${String(index).padStart(2, "0")}Z` }));
    writeFileSync(join(fixtures, "01-issues.json"), JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: false },
      nodes: [{ identifier: "ABC-1", createdAt: "2025-01-01T00:00:00Z", updatedAt: "2026-01-01T00:02:00Z", history: { pageInfo: { hasNextPage: true, endCursor: "history-next" }, nodes: initial } }],
    } } }));
    writeFileSync(join(fixtures, "02-history.json"), JSON.stringify({ data: { issue: { history: {
      pageInfo: { hasNextPage: true, endCursor: "unneeded" },
      nodes: [{ id: "at-cutoff", createdAt: "2026-01-01T00:00:00Z" }],
    } } } }));
    const result = await fetchIssues(new LinearTransport({ fixtureDir: fixtures }), null, "2026-01-01T00:00:00Z", { team: "ABC", maxPages: 1 });
    expect(result.history.at(-1)?.id).toBe("at-cutoff");
  });
});
