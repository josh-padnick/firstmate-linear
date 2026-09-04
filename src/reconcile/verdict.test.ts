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
  db.linkTask({
    lifecycle_id: "link:worker", task: "worker", issue: "ABC-1", role: "primary",
    worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null,
  });
  db.snapshot({ issue: "ABC-1", role: "validating", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T12:00:00Z" });
  recordHead(db, "link:worker", "worker", "https://github.test/pr/1", "abc");
  return { root, db };
}

function recordHead(db: StateDatabase, lifecycle: string, task: string, url: string, head: string): void {
  db.observe({
    id: `reported:${lifecycle}:${url}`, source: "pr", task, task_lifecycle_id: lifecycle,
    issue: "ABC-1", verb: "pr-reported", key: "pr", note: url,
    observed_at: "2026-01-01T12:01:00Z",
  });
  db.observe({
    id: `head:${lifecycle}:${head}`, source: "pr", task, task_lifecycle_id: lifecycle,
    issue: "ABC-1", verb: "pr-green", key: "pr", note: `${url} head=${head}`,
    observed_at: "2026-01-01T12:01:00Z",
  });
}

function observation(detail: Record<string, unknown>, fields: Partial<Observation> = {}): Observation {
  return {
    id: "obs:verdict", source: "pr", task: "worker", task_lifecycle_id: "link:worker",
    issue: "ABC-1", verb: "verdict", key: String(detail.verdict),
    note: JSON.stringify({ risk: "low", reason: "reviewed", url: "https://github.test/pr/1", headSha: "abc", changedFiles: [], lines: 10, autoMergeArmed: false, ...detail }),
    observed_at: "2026-01-01T12:01:00Z", ...fields,
  };
}

function verdictConfig(options: Parameters<typeof testWorkflowConfig>[0] = {}) {
  return testWorkflowConfig({ ...options, validationMode: "verdict", features: { ...options.features, mirror: "on" } });
}

test("auto-mergeable verdict waits visibly until the configured gate check succeeds", () => {
  const { db } = setup();
  const config = verdictConfig();
  expect(reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable" })]).handled).toBe(1);
  expect(db.listEvents(["waiting-for-core"])[0]?.note).toContain("is not successful");
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("service policy downgrades auto merge to the merge gate", () => {
  const { db } = setup();
  const base = verdictConfig();
  const config = { ...base, merge: { ...base.merge, never_auto_paths: ["infra/**"] } };
  reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable", changedFiles: [{ path: "infra/prod.tf", additions: 1, deletions: 0 }] })]);
  expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
  expect(JSON.parse(db.jobs()[0]!.payload)).toMatchObject({ role: "merge-gate", expected_role: "validating" });
  expect(JSON.parse(db.jobs()[0]!.payload).comment).toContain("policy: infra/prod.tf");
  db.close();
});

test("changes-requested relays findings to a live primary task and returns to building", () => {
  const { db } = setup();
  reconcileVerdicts(db, verdictConfig(), [observation({ verdict: "changes-requested", reason: "fix tests" })]);
  expect(db.jobs().map((job) => job.kind).sort()).toEqual(["fleet.send", "linear.issue-role"]);
  db.close();
});

test("hands-off auto merge stays silent only when the configured gate check is green", () => {
  const { db } = setup();
  const config = verdictConfig();
  reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable", autoMergeArmed: true, checkConclusions: { "fleet-merge-gate": "success" } })]);
  expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
  expect(db.jobs().map((job) => job.kind)).toEqual(["promise.implicit"]);
  db.close();
});

test("a durable verdict is consumed after the issue reaches validating", () => {
  const root = mkdtempSync("/private/tmp/fml-verdict-"); roots.push(root);
  const db = new StateDatabase(join(root, "db"), join(root, "backups"));
  db.linkTask({
    lifecycle_id: "link:worker", task: "worker", issue: "ABC-1", role: "primary",
    worktree: null, harness: null, spawned_at: "2026-01-01T11:00:00Z", torn_down_at: null,
  });
  db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T12:00:00Z" });
  recordHead(db, "link:worker", "worker", "https://github.test/pr/1", "abc");
  const item = observation({ verdict: "auto-mergeable", checkConclusions: { "fleet-merge-gate": "success" } });
  db.observe(item);
  expect(reconcileVerdicts(db, verdictConfig(), [item]).handled).toBe(0);
  db.snapshot({ issue: "ABC-1", role: "validating", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T12:03:00Z" });
  expect(reconcileVerdicts(db, verdictConfig(), []).handled).toBe(1);
  expect(reconcileVerdicts(db, verdictConfig(), []).handled).toBe(0);
  db.close();
});

test("a verdict cannot cross into a replacement primary lifecycle", () => {
  const { db } = setup();
  const item = observation({ verdict: "auto-mergeable", checkConclusions: { "fleet-merge-gate": "success" } });
  db.observe(item);
  db.closeTask("worker", "2026-01-01T12:02:00Z");
  db.linkTask({
    lifecycle_id: "link:replacement", task: "worker", issue: "ABC-1", role: "primary",
    worktree: null, harness: null, spawned_at: "2026-01-01T12:03:00Z", torn_down_at: null,
  });
  expect(reconcileVerdicts(db, verdictConfig(), []).handled).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("a verdict cannot cross into a later validation episode", () => {
  const { db } = setup();
  const item = observation({ verdict: "auto-mergeable", checkConclusions: { "fleet-merge-gate": "success" } });
  db.observe(item);
  db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T12:02:00Z" });
  db.snapshot({ issue: "ABC-1", role: "validating", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T12:03:00Z" });
  expect(reconcileVerdicts(db, verdictConfig(), []).handled).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("changes requested dominates an auto-mergeable sibling PR", () => {
  const { db } = setup();
  db.linkTask({
    lifecycle_id: "link:sibling", task: "sibling", issue: "ABC-1", role: "primary",
    worktree: null, harness: null, spawned_at: "2026-01-01T11:30:00Z", torn_down_at: null,
  });
  recordHead(db, "link:sibling", "sibling", "https://github.test/pr/2", "def");
  const requested = observation({ verdict: "changes-requested", reason: "fix security" });
  const safe = observation({
    verdict: "auto-mergeable", url: "https://github.test/pr/2", headSha: "def",
    checkConclusions: { "fleet-merge-gate": "success" },
  }, { id: "obs:sibling", task: "sibling", task_lifecycle_id: "link:sibling" });
  expect(reconcileVerdicts(db, verdictConfig(), [requested, safe]).handled).toBe(2);
  expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
  expect(db.jobs().map((job) => job.kind).sort()).toEqual(["fleet.send", "linear.issue-role"]);
  expect(JSON.parse(db.jobs().find((job) => job.kind === "fleet.send")!.payload)).toMatchObject({ lifecycle_id: "link:worker" });
  db.close();
});

test("merge authorization waits for every active primary verdict", () => {
  const { db } = setup();
  db.linkTask({
    lifecycle_id: "link:sibling", task: "sibling", issue: "ABC-1", role: "primary",
    worktree: null, harness: null, spawned_at: "2026-01-01T11:30:00Z", torn_down_at: null,
  });
  expect(reconcileVerdicts(db, verdictConfig(), [observation({
    verdict: "auto-mergeable", checkConclusions: { "fleet-merge-gate": "success" },
  })]).handled).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("a verdict must match the latest observed PR head", () => {
  const { db } = setup();
  db.observe({
    id: "head:replacement", source: "pr", task: "worker", task_lifecycle_id: "link:worker",
    issue: "ABC-1", verb: "pr-withdrawn", key: "pr",
    note: "https://github.test/pr/1 current=def expected=def", observed_at: "2026-01-01T12:02:00Z",
  });
  expect(reconcileVerdicts(db, verdictConfig(), [observation({
    verdict: "auto-mergeable", checkConclusions: { "fleet-merge-gate": "success" },
  })]).handled).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("a verdict for a superseded PR cannot authorize its replacement", () => {
  const { db } = setup();
  db.observe({
    id: "reported:replacement", source: "pr", task: "worker", task_lifecycle_id: "link:worker",
    issue: "ABC-1", verb: "pr-reported", key: "pr", note: "https://github.test/pr/2",
    observed_at: "2026-01-01T12:02:00Z",
  });
  recordHead(db, "link:worker", "worker", "https://github.test/pr/2", "def");
  expect(reconcileVerdicts(db, verdictConfig(), [observation({
    verdict: "auto-mergeable", checkConclusions: { "fleet-merge-gate": "success" },
  })]).handled).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
  db.close();
});

test("changes requested acts before every sibling has published a verdict", () => {
  const { db } = setup();
  db.linkTask({
    lifecycle_id: "link:sibling", task: "sibling", issue: "ABC-1", role: "primary",
    worktree: null, harness: null, spawned_at: "2026-01-01T11:30:00Z", torn_down_at: null,
  });
  recordHead(db, "link:sibling", "sibling", "https://github.test/pr/2", "def");
  expect(reconcileVerdicts(db, verdictConfig(), [observation({
    verdict: "changes-requested", reason: "fix security",
  })]).handled).toBe(1);
  expect(db.jobs().map((job) => job.kind).sort()).toEqual(["fleet.send", "linear.issue-role"]);
  db.close();
});

test("needs-human remains visible when no captain gate is mapped", () => {
  const { db } = setup();
  const config = verdictConfig({ roles: {
    building: "Building", validating: "Validating", done: "Done", canceled: "Canceled",
  } });
  expect(reconcileVerdicts(db, config, [observation({ verdict: "needs-human", reason: "security review" })]).handled).toBe(1);
  expect(db.listEvents(["waiting-for-core"])[0]?.note).toContain("security review");
  expect(db.latestSnapshot("ABC-1")?.role).toBe("validating");
  db.close();
});

test("a verdict from a differently named check is ignored", () => {
  const { db } = setup();
  const config = verdictConfig();
  expect(reconcileVerdicts(db, config, [observation({ verdict: "auto-mergeable", source: "check", checkName: "untrusted-check" })]).handled).toBe(0);
  expect(db.jobs()).toHaveLength(0);
  db.close();
});

test("verdict actions obey mirror off and shadow modes", () => {
  for (const mirror of ["off", "shadow"] as const) {
    const { db } = setup();
    const config = testWorkflowConfig({ validationMode: "verdict", features: { mirror } });
    expect(reconcileVerdicts(db, config, [observation({
      verdict: "auto-mergeable", checkConclusions: { "fleet-merge-gate": "success" },
    })])).toEqual({ handled: 0, stalled: 0 });
    expect(db.jobs()).toHaveLength(0);
    expect(db.listEvents(["waiting-for-core"])).toHaveLength(0);
    db.close();
  }
});
