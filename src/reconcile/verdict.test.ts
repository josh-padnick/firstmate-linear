import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase, type Observation } from "../db/database.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import { reconcileVerdicts } from "./verdict.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync("/private/tmp/fml-verdict-"); roots.push(root);
  const db = new StateDatabase(join(root, "db"), join(root, "backups"));
  db.snapshot({ issue: "ABC-1", role: "validating", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T12:00:00Z" });
  return { root, db };
}

function observation(detail: Record<string, unknown>): Observation {
  return {
    id: "obs:verdict", source: "pr", task: "worker", issue: "ABC-1", verb: "verdict", key: String(detail.verdict),
    note: JSON.stringify({ risk: "low", reason: "reviewed", url: "https://github.test/pr/1", headSha: "abc", changedFiles: [], lines: 10, autoMergeArmed: false, ...detail }),
    observed_at: "2026-01-01T12:01:00Z",
  };
}

test("auto-mergeable verdict creates a merge wake and promise without a board move", () => {
  const { db } = setup();
  const config = testWorkflowConfig({ validationMode: "verdict" });
  expect(reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable" })]).handled).toBe(1);
  expect(db.listEvents(["waiting-for-core"])[0]?.note).toContain("required: merge");
  expect(db.jobs().map((job) => job.kind)).toEqual(["promise.implicit"]);
  db.close();
});

test("service policy downgrades auto merge to the merge gate", () => {
  const { db } = setup();
  const base = testWorkflowConfig({ validationMode: "verdict" });
  const config = { ...base, merge: { ...base.merge, never_auto_paths: ["infra/**"] } };
  reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable", changedFiles: [{ path: "infra/prod.tf", additions: 1, deletions: 0 }] })]);
  expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
  expect(JSON.parse(db.jobs()[0]!.payload)).toMatchObject({ role: "merge-gate", expected_role: "validating" });
  expect(JSON.parse(db.jobs()[0]!.payload).comment).toContain("policy: infra/prod.tf");
  db.close();
});

test("changes-requested relays findings to a live primary task and returns to building", () => {
  const { db } = setup();
  db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null });
  reconcileVerdicts(db, testWorkflowConfig({ validationMode: "verdict" }), [observation({ verdict: "changes-requested", reason: "fix tests" })]);
  expect(db.jobs().map((job) => job.kind).sort()).toEqual(["fleet.send", "linear.issue-role"]);
  db.close();
});

test("hands-off auto merge stays silent only when the configured gate check is green", () => {
  const { db } = setup();
  const config = testWorkflowConfig({ validationMode: "verdict" });
  reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable", autoMergeArmed: true, gateConclusion: "success" })]);
  expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
  expect(db.jobs().map((job) => job.kind)).toEqual(["promise.implicit"]);
  db.close();
});

test("a verdict from a differently named check is ignored", () => {
  const { db } = setup();
  const config = testWorkflowConfig({ validationMode: "verdict" });
  expect(reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable", source: "check", checkName: "untrusted-check" })]).handled).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});
