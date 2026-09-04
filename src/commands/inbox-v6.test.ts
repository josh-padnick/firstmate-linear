import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("inbox commands", () => {
  test("a service event receipt rejects newer captain input", () => {
    const home = mkdtempSync("/private/tmp/fml-inbox-"); roots.push(home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "linear-workflow.yaml"), "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: all\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    const db = StateDatabase.open({ FM_HOME: home });
    db.capture({ id: "event:stall", team: "ABC", issue: "ABC-1", type: "stalled", token: "stalled", author: "fm-linear", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:00Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    const receipt = db.issueReceipt(["event:stall"], "2026-01-01T00:01:00Z");
    db.capture({ id: "event:captain", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:02:00Z", captured_at: "2026-01-01T00:02:00Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    db.close();

    const result = spawnSync(join(process.cwd(), "bin", "fm-linear"), ["inbox", "handle", "event:stall", "--receipt", receipt], {
      env: { ...process.env, FM_HOME: home }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale receipt");
    expect(result.stderr).toContain("fm-linear inbox show event:captain");
    expect(result.stderr).not.toContain("at StateDatabase");
  });
});
