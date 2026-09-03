import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { runActV6 } from "./act-v6.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(): { home: string; env: NodeJS.ProcessEnv; receipt: string } {
  const home = mkdtempSync("/private/tmp/fml-act-"); roots.push(home); mkdirSync(join(home, "config"));
  writeFileSync(join(home, "config", "linear-workflow.yaml"), `version: 1\ncaptain:\n  display_name: Captain\nteams:\n  - key: ABC\n    managed: all\n    projects: []\n    statuses:\n      approve_deliverable: Approve Deliverable\n      building: Building\n      validating_code: Validating Code\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n`);
  const env = { FM_HOME: home };
  const db = StateDatabase.open(env);
  db.snapshot({ issue: "ABC-1", state: "Approve Deliverable", assignee: "Captain", labels: [], agent_label: null, last_actor: "Captain", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
  db.capture({ id: "event:one", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:01Z", captured_at: "2026-01-01T00:00:02Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
  const receipt = db.issueReceipt(["event:one"], "2026-01-01T00:00:03Z"); db.close();
  return { home, env, receipt };
}

describe("v6 act read gate", () => {
  test("gate replies require a verdict and ownership", async () => {
    const { env, receipt } = setup();
    expect(runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it"], env)).toBe(1);
  });

  test("a valid gate reply enqueues jobs and consumes exact receipt", async () => {
    const { env, receipt } = setup();
    expect(runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate"], env)).toBe(0);
    const db = StateDatabase.open(env);
    expect(db.jobs()).toHaveLength(2);
    expect(db.jobs().map((job) => job.kind)).not.toContain("core.ack");
    expect(db.receipt(receipt)?.consumed_at).not.toBeNull();
    expect(db.event("event:one")?.disposition).toBe("handled-by-core"); db.close();
  });

  test("reply policy rejects status-verb leads", async () => {
    const { env, receipt } = setup();
    expect(runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Done: fixed", "--verdict", "approved", "--to", "firstmate"], env)).toBe(1);
  });

  test("reply policy rejects more than eight rendered lines", () => {
    const { env, receipt } = setup();
    const text = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", text, "--verdict", "approved", "--to", "firstmate"], env)).toBe(1);
  });

  test("the public CLI cannot claim the service actor exemption", () => {
    const { env } = setup();
    expect(runActV6(["status", "ABC-1", "--status", "Building", "--actor", "service"], env)).toBe(1);
    const db = StateDatabase.open(env);
    expect(db.jobs()).toHaveLength(0);
    db.close();
  });

  test("status requires a non-empty target before consuming its receipt", () => {
    const { env, receipt } = setup();
    expect(runActV6(["status", "ABC-1", "--receipt", receipt], env)).toBe(1);
    expect(runActV6(["status", "ABC-1", "--receipt", receipt, "--status", "   "], env)).toBe(1);
    expect(runActV6(["status", "ABC-1", "--status", "--receipt", receipt], env)).toBe(1);
    const db = StateDatabase.open(env);
    expect(db.receipt(receipt)?.consumed_at).toBeNull();
    expect(db.event("event:one")?.disposition).toBe("waiting-for-core");
    expect(db.jobs()).toHaveLength(0);
    db.close();
  });

  test("a newer captain comment makes a receipt stale", () => {
    const { env, receipt } = setup();
    const db = StateDatabase.open(env);
    db.capture({ id: "event:new", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:04Z", captured_at: "2026-01-01T00:00:05Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    db.close();
    expect(runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate"], env)).toBe(1);
    const after = StateDatabase.open(env);
    expect(after.jobs()).toHaveLength(0);
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    after.close();
  });
});
