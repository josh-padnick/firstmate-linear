import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearTransport, redactFixture } from "./transport.ts";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fm-linear-transport-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fixture transport", () => {
  test("consumes lexically ordered files and logs compact payloads", async () => {
    const dir = tempDir();
    const fixtures = join(dir, "fixtures");
    mkdirSync(fixtures);
    writeFileSync(
      join(fixtures, "02-second.json"),
      JSON.stringify({ data: { ok: 2 } }),
    );
    writeFileSync(
      join(fixtures, "01-first.json"),
      JSON.stringify({ data: { ok: 1 } }),
    );
    const log = join(dir, "log.tsv");
    const transport = new LinearTransport({ fixtureDir: fixtures, fixtureLog: log });
    const first = await transport.call("comments", { query: "q1", variables: { after: null } });
    const second = await transport.call("issues", { query: "q2" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.value.data).toEqual({ ok: 1 });
    if (second.ok) expect(second.value.data).toEqual({ ok: 2 });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]?.startsWith("comments\t")).toBe(true);
    expect(lines[1]?.startsWith("issues\t")).toBe(true);
    expect(JSON.parse(lines[0]!.split("\t")[1]!)).toEqual({
      query: "q1",
      variables: { after: null },
    });
  });

  test("fail-N fixtures become HTTP failures of that class", async () => {
    const fixtures = join(tempDir(), "fixtures");
    mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-fail-503.json"), "{}");
    const result = await new LinearTransport({ fixtureDir: fixtures }).call("comments", {
      query: "q",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http");
      expect(result.error.httpStatus).toBe(503);
      expect(result.error.classification.class).toBe("retryable");
    }
  });

  test("malformed fixtures do not parse as success", async () => {
    const fixtures = join(tempDir(), "fixtures");
    mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-malformed.json"), "{not-json");
    const result = await new LinearTransport({ fixtureDir: fixtures }).call("comments", {
      query: "q",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      expect(result.error.classification.class).toBe("retryable");
    }
  });

  test("expands __COMMENT_ID__ from variables.comment or variables.id", async () => {
    const fixtures = join(tempDir(), "fixtures");
    mkdirSync(fixtures);
    writeFileSync(
      join(fixtures, "01-comment.json"),
      JSON.stringify({ data: { commentCreate: { comment: { id: "__COMMENT_ID__" } } } }),
    );
    const result = await new LinearTransport({ fixtureDir: fixtures }).call("commentCreate", {
      query: "m",
      variables: { comment: "abc-uuid", id: "abc-uuid" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toEqual({
        commentCreate: { comment: { id: "abc-uuid" } },
      });
    }
  });

  test("GraphQL errors classify through the shared taxonomy", async () => {
    const fixtures = join(tempDir(), "fixtures");
    mkdirSync(fixtures);
    writeFileSync(
      join(fixtures, "01-errors.json"),
      JSON.stringify({
        errors: [{ message: "Entity not found", extensions: { code: "NOT_FOUND" } }],
      }),
    );
    const result = await new LinearTransport({ fixtureDir: fixtures }).call("resolve", {
      query: "q",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("graphql");
      expect(result.error.classification.class).toBe("precondition-changed");
    }
  });

  test("missing next fixture fails closed", async () => {
    const fixtures = join(tempDir(), "fixtures");
    mkdirSync(fixtures);
    const result = await new LinearTransport({ fixtureDir: fixtures }).call("comments", {
      query: "q",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("fixture");
      expect(result.error.message).toContain("fixture response missing");
    }
  });

  test("recording redacts identity and content while preserving stable references", () => {
    const redacted = redactFixture({ data: { viewer: { displayName: "Firstmate" }, issue: { id: "secret-id", identifier: "ABC-123", title: "Secret title", state: { name: "Approve Plan" }, project: { name: "Runtime" }, labels: { nodes: [{ name: "Agent: Codex" }] }, assignee: { id: "secret-id", displayName: "Firstmate", email: "person@example.com" } } } }) as any;
    expect(redacted.data.issue.id).toStartWith("redacted-");
    expect(redacted.data.issue.identifier).toBe("ABC-123");
    expect(redacted.data.issue.assignee.id).toBe(redacted.data.issue.id);
    expect(redacted.data.issue.title).toBe("[redacted]");
    expect(redacted.data.issue.assignee.email).toBe("redacted@example.invalid");
    expect(redacted.data.viewer.displayName).toBe(redacted.data.issue.assignee.displayName);
    expect(redacted.data.viewer.displayName).not.toBe("Firstmate");
    expect(redacted.data.issue.state.name).toBe("Approve Plan");
    expect(redacted.data.issue.project.name).toBe("Runtime");
    expect(redacted.data.issue.labels.nodes[0].name).toBe("Agent: Codex");
  });

  test("recorded issue identifiers remain routable when replayed", async () => {
    const dir = tempDir();
    const recorded = join(dir, "recorded");
    const response = { data: { issue: { id: "secret-id", identifier: "ABC-123", title: "Secret title" } } };
    const live = new LinearTransport({
      apiKey: "test-key",
      recordDir: recorded,
      fetchImpl: async () => new Response(JSON.stringify(response), { status: 200 }),
    });
    expect((await live.call("issue", { query: "query Issue" })).ok).toBe(true);

    const replayed = await new LinearTransport({ fixtureDir: recorded }).call("issue", { query: "query Issue" });

    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect((replayed.value.data as any).issue.identifier.split("-")[0]).toBe("ABC");
  });
});
