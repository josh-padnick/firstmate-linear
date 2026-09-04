import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { runReport } from "./report.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("report command", () => {
  test("groups comment activity by issue thread", () => {
    const home = mkdtempSync("/private/tmp/fml-report-"); roots.push(home);
    mkdirSync(join(home, "config"));
    writeFileSync(join(home, "config", "linear-workflow.yaml"), "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: all\n    roles: { building: Building, done: Done, canceled: Canceled }\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    writeFileSync(join(home, "config", "report.md"), "{{summary}}\n{{events}}\n{{drift}}\n");
    const db = StateDatabase.open({ FM_HOME: home });
    for (const [index, value] of [
      { commentId: "thread-root", parentId: null, author: "Captain", body: "Question" },
      { commentId: "reply-one", parentId: "thread-root", author: "Firstmate", body: "Answer" },
      { commentId: "reply-two", parentId: "thread-root", author: "Captain", body: "Follow-up" },
    ].entries()) db.capture({
      id: `event:${index}`, team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: value.author,
      body_sha: null, created_at: `2026-01-01T00:0${index}:00Z`, captured_at: `2026-01-01T00:0${index}:00Z`,
      disposition: "handled-by-service", note: null,
      raw_ref: JSON.stringify({ comment_id: value.commentId, parent_id: value.parentId, body: value.body }),
    });
    db.close();
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(runReport([], { FM_HOME: home, FM_LINEAR_NOW_EPOCH: "1767225800" })).toBe(0);

    const output = stdout.mock.calls.map(([value]) => String(value)).join("");
    stdout.mockRestore();
    expect(output.match(/ABC-1 thread thread-root/g)).toHaveLength(1);
    expect(output).toContain("3 comments");
  });
});
