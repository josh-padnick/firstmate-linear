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
    const fixtures = join(home, "fixtures"); mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-comments.json"), JSON.stringify({ data: { comments: { pageInfo: { hasNextPage: false }, nodes: [] } } }));
    writeFileSync(join(home, "config", "linear-workflow.yaml"), "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: all\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    const db = StateDatabase.open({ FM_HOME: home });
    db.capture({ id: "event:stall", team: "ABC", issue: "ABC-1", type: "stalled", token: "stalled", author: "fm-linear", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:00Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    const receipt = db.issueReceipt(["event:stall"], "2026-01-01T00:01:00Z");
    db.capture({ id: "event:captain", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:02:00Z", captured_at: "2026-01-01T00:02:00Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    db.close();

    const result = spawnSync(join(process.cwd(), "bin", "fm-linear"), ["inbox", "handle", "event:stall", "--receipt", receipt], {
      env: { ...process.env, FM_HOME: home, FM_LINEAR_FIXTURE_DIR: fixtures }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale receipt");
    expect(result.stderr).toContain("fm-linear inbox show event:captain");
    expect(result.stderr).not.toContain("at StateDatabase");
  });

  test("handle synchronizes uncaptured captain input before committing", () => {
    const home = mkdtempSync("/private/tmp/fml-inbox-"); roots.push(home);
    mkdirSync(join(home, "config"), { recursive: true });
    const fixtures = join(home, "fixtures"); mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-comments.json"), JSON.stringify({ data: { comments: {
      pageInfo: { hasNextPage: false },
      nodes: [{
        id: "linear-comment-new", createdAt: "2026-01-01T00:00:02Z", updatedAt: "2026-01-01T00:00:02Z",
        body: "Wait for the revised direction", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1" }, parent: null,
      }],
    } } }));
    writeFileSync(join(fixtures, "02-issue.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      issue: {
        identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:00:02Z",
        state: { name: "Building" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" },
        project: null, labels: { nodes: [] }, history: { pageInfo: { hasNextPage: false }, nodes: [] },
      },
    } }));
    writeFileSync(join(home, "config", "linear-workflow.yaml"), "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: all\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    const db = StateDatabase.open({ FM_HOME: home });
    db.capture({ id: "event:stall", team: "ABC", issue: "ABC-1", type: "stalled", token: "stalled", author: "fm-linear", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:00Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    const receipt = db.issueReceipt(["event:stall"], "2026-01-01T00:01:00Z");
    db.close();

    const result = spawnSync(join(process.cwd(), "bin", "fm-linear"), ["inbox", "handle", "event:stall", "--receipt", receipt], {
      env: { ...process.env, FM_HOME: home, FM_LINEAR_FIXTURE_DIR: fixtures }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale receipt");
    const after = StateDatabase.open({ FM_HOME: home });
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    expect(after.event("event:stall")?.disposition).toBe("waiting-for-core");
    expect(after.listEvents().some((event) => event.created_at === "2026-01-01T00:00:02Z")).toBe(true);
    after.close();
  });

  test("synchronized approvals retain canonical historical classification", () => {
    const home = mkdtempSync("/private/tmp/fml-inbox-"); roots.push(home);
    mkdirSync(join(home, "config"), { recursive: true });
    const fixtures = join(home, "fixtures"); mkdirSync(fixtures);
    writeFileSync(join(fixtures, "01-comments.json"), JSON.stringify({ data: { comments: {
      pageInfo: { hasNextPage: false },
      nodes: [{
        id: "linear-approval", createdAt: "2026-01-01T00:00:02Z", updatedAt: "2026-01-01T00:00:02Z",
        body: "approved", user: { displayName: "Captain" }, issue: { identifier: "ABC-1" }, parent: null,
      }],
    } } }));
    writeFileSync(join(fixtures, "02-issue.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      issue: {
        identifier: "ABC-1", title: "Ship", description: null,
        createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:00:03Z",
        state: { name: "Building" }, assignee: { displayName: "Firstmate" }, project: null,
        creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [{
          id: "after-approval", createdAt: "2026-01-01T00:00:03Z", actor: { displayName: "Captain" },
          fromState: { name: "Approve Deliverable" }, toState: { name: "Building" },
        }] },
      },
    } }));
    writeFileSync(join(home, "config", "linear-workflow.yaml"), "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: assignee:self\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    const db = StateDatabase.open({ FM_HOME: home });
    db.capture({ id: "event:stall", team: "ABC", issue: "ABC-1", type: "stalled", token: "stalled", author: "fm-linear", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:00Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    const receipt = db.issueReceipt(["event:stall"], "2026-01-01T00:01:00Z");
    db.close();

    const result = spawnSync(join(process.cwd(), "bin", "fm-linear"), ["inbox", "handle", "event:stall", "--receipt", receipt], {
      env: { ...process.env, FM_HOME: home, FM_LINEAR_FIXTURE_DIR: fixtures }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    const after = StateDatabase.open({ FM_HOME: home });
    const approval = after.listEvents().find((event) => event.created_at === "2026-01-01T00:00:02Z");
    expect(approval?.token).toBe("approval");
    expect(after.jobs()).toHaveLength(1);
    expect(JSON.parse(after.jobs()[0]!.payload)).toMatchObject({ state: "Validating Code", cause_event: approval?.id });
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    expect(after.event("event:stall")?.disposition).toBe("waiting-for-core");
    after.close();
  });
});
