import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LinearTransport } from "../transport.ts";
import { fetchIssues } from "./fetch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("capture pagination", () => {
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
});
