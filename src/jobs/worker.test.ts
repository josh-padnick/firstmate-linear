import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyEvent } from "../classify/classify.ts";
import { runTask } from "../commands/task.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { redactedIdentity } from "../identity.ts";
import { LinearTransport, type GraphqlPayload, type TransportResult } from "../transport.ts";
import { scanFleet } from "../mirror/scan.ts";
import { scanPullRequests } from "../mirror/pr.ts";
import { reconcileStalls } from "../reconcile/stall.ts";
import { nextAttempt, processJobs } from "./worker.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const config = testWorkflowConfig();

describe("job worker", () => {
  test("Retry-After extends exponential backoff", () => {
    const job = { id: "job:1", key: "key", kind: "test", target: "ABC-1", payload: "{}", state: "running", attempts: 1, next_attempt_at: "", native_id: null, last_error: null, created_at: "", done_at: null } as const;
    expect(nextAttempt(job, { FM_LINEAR_NOW_EPOCH: "1000" }, 120)).toBe("1970-01-01T00:18:40Z");
  });
  test("a state job conditionally updates and comments", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "00-managed-state.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null } } }));
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { viewer: { id: "me", displayName: "Firstmate" }, issue: { id: "issue-id", identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null, state: { id: "old", name: "Approve Deliverable" }, team: { states: { nodes: [{ id: "new", name: "Validating Code" }] }, members: { nodes: [] } } } } }));
    await Bun.write(join(fixtures, "02-update.json"), JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "issue-id", state: { name: "Validating Code" } } } } }));
    await Bun.write(join(fixtures, "02z-managed-comment.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null } } }));
    await Bun.write(join(fixtures, "03-resolve-comment.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, issue: { id: "issue-id", identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null } } }));
    await Bun.write(join(fixtures, "04-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", role: "review-gate", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T00:00:00Z" });
    db.enqueue({ key: "approve:1", kind: "linear.issue-role", target: "ABC-1", payload: { issue: "ABC-1", role: "validating", expected_role: "review-gate", comment: "Approved.", requires_managed: true } }, "2026-01-01T00:00:00Z");
    const transport = new LinearTransport({ fixtureDir: fixtures });
    expect((await processJobs({ db, config, transport, env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } })).done).toBe(1);
    expect(db.jobs().map((job) => [job.kind, job.state])).toEqual([["linear.issue-role", "done"], ["linear.comment", "pending"], ["promise.implicit", "pending"]]);
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({ source: "linear", verb: "board-transition", key: "validating" }));
    expect(JSON.parse(db.jobs()[1]!.payload).requires_managed).toBe(true);
    expect((await processJobs({ db, config, transport, env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } })).done).toBe(2);
    expect(db.jobs().map((job) => job.state)).toEqual(["done", "done", "done"]);
    expect(db.promises("ABC-1", ["open"])[0]?.expected_event).toBe("pr-green");
    db.close();
  });

  test("a legacy state job is translated through the current role mapping", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: {
      viewer: { id: "me", displayName: "Firstmate" },
      issue: {
        id: "issue-id", identifier: "ABC-1", state: { id: "old", name: "Approve Deliverable" },
        team: { states: { nodes: [{ id: "new", name: "Validating Code" }] }, members: { nodes: [] } },
      },
    } }));
    await Bun.write(join(fixtures, "02-update.json"), JSON.stringify({ data: { issueUpdate: { success: true } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({
      key: "legacy-state", kind: "linear.issue-state", target: "ABC-1",
      payload: { issue: "ABC-1", state: "Validating Code", expected_state: "Approve Deliverable" },
    }, "2026-01-01T00:00:00Z");
    const result = await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" },
    });
    expect(result).toMatchObject({ done: 1, dead: 0 });
    expect(db.jobs()[0]).toMatchObject({ kind: "linear.issue-state", state: "done" });
    db.close();
  });

  test("pending, retry, and running legacy state jobs remain executable", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const resolved = JSON.stringify({ data: {
      viewer: { id: "me", displayName: "Firstmate" },
      issue: {
        id: "issue-id", identifier: "ABC-1", state: { id: "current", name: "Validating Code" },
        team: { states: { nodes: [{ id: "current", name: "Validating Code" }] }, members: { nodes: [] } },
      },
    } });
    for (const index of [1, 2, 3]) await Bun.write(join(fixtures, `0${index}-resolve.json`), resolved);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    for (const state of ["pending", "retry", "running"] as const) {
      const job = db.enqueue({ key: `legacy-${state}`, kind: "linear.issue-state", target: "ABC-1", payload: { issue: "ABC-1", state: "Validating Code" } }, "2026-01-01T00:00:00Z");
      db.raw.query("UPDATE jobs SET state=? WHERE id=?").run(state, job.id);
    }
    const result = await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" },
    });
    expect(result).toMatchObject({ done: 3, dead: 0 });
    expect(db.jobs().map((job) => job.state)).toEqual(["done", "done", "done"]);
    db.close();
  });

  test("a retried gate mutation is discarded after the issue leaves scope", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const log = join(root, "calls.log");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", role: "review-gate", assignee: "Captain", labels: [], agent_label: null, last_actor: "Captain", last_signal: null, managed: true, observed_at: "2026-01-01T00:00:00Z" });
    const classification = classifyEvent({ id: "event:approval", team: "ABC", issue: "ABC-1", type: "comment", author: "Captain", body: "approved", created_at: "2026-01-01T00:00:01Z" }, config, db.latestSnapshot("ABC-1"));
    const job = db.enqueue(classification.jobs[0]!, "2026-01-01T00:00:01Z");
    db.claimDueJobs(1, "2026-01-01T00:00:01Z");
    db.retryJob(job.id, "temporary failure", "2026-01-01T00:00:02Z");
    db.snapshot({ issue: "ABC-1", role: "review-gate", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T00:00:02Z" });
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-managed.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, issue: { identifier: "ABC-1", assignee: { displayName: "Someone Else" }, project: null } } }));
    const scopedConfig: WorkflowConfig = { ...config, teams: config.teams.map((team) => ({ ...team, managed: "assignee:self" })) };

    const result = await processJobs({
      db, config: scopedConfig, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225602" },
    });

    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.state).toBe("done");
    expect(readFileSync(log, "utf8").split("\n")[0]).toStartWith("job-resolve-managed\t");
    db.close();
  });

  test("a mutation-specific read closes the managed-scope race", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-managed.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null } } }));
    await Bun.write(join(fixtures, "02-resolve-state.json"), JSON.stringify({ data: { viewer: { id: "me", displayName: "Firstmate" }, issue: { id: "issue-id", identifier: "ABC-1", assignee: { displayName: "Someone Else" }, project: null, state: { name: "Approve Deliverable" }, team: { states: { nodes: [{ id: "building", name: "Building" }] }, members: { nodes: [] } } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", role: "review-gate", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T00:00:00Z" });
    db.enqueue({ key: "state:race", kind: "linear.issue-role", target: "ABC-1", payload: { issue: "ABC-1", role: "building", requires_managed: true } }, "2026-01-01T00:00:00Z");

    const result = await processJobs({ db, config: { ...config, teams: config.teams.map((team) => ({ ...team, managed: "assignee:self" })) }, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" }, maxAttempts: 1 });

    expect(result.done).toBe(1);
    expect(readFileSync(log, "utf8")).not.toContain("job-update-state");
    db.close();
  });

  test("a failed state explanation retries without repeating the state update", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-resolve-state.json"), JSON.stringify({ data: { viewer: { id: "me" }, issue: { id: "issue-id", state: { name: "Building" }, team: { states: { nodes: [{ id: "done-id", name: "Done" }] }, members: { nodes: [] } } } } }));
    await Bun.write(join(fixtures, "02-update.json"), JSON.stringify({ data: { issueUpdate: { success: true } } }));
    await Bun.write(join(fixtures, "03-resolve-comment.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "04-fail-500.json"), "{}");
    await Bun.write(join(fixtures, "05-verify-missing.json"), JSON.stringify({ data: { comment: null } }));
    await Bun.write(join(fixtures, "06-resolve-comment.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "07-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "state:done", kind: "linear.issue-role", target: "ABC-1", payload: { issue: "ABC-1", role: "done", comment: "Finished." } }, "2026-01-01T00:00:00Z");
    const transport = new LinearTransport({ fixtureDir: fixtures, fixtureLog: log });
    await processJobs({ db, config, transport, env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect((await processJobs({ db, config, transport, env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } })).retried).toBe(1);
    expect((await processJobs({ db, config, transport, env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225610" } })).done).toBe(1);
    const operations = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("\t")[0]);
    expect(operations.filter((operation) => operation === "job-update-state")).toHaveLength(1);
    expect(db.jobs().find((job) => job.kind === "linear.comment")?.state).toBe("done");
    db.close();
  });

  test("an ambiguous comment failure verifies the native client id and does not duplicate", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-fail-500.json"), "{}");
    const expectedId = "0f425027-ec05-4429-a159-e981bb14f01c";
    await Bun.write(join(fixtures, "03-verify.json"), JSON.stringify({ data: { comment: { id: expectedId } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const log = join(root, "calls.log");
    db.enqueue({ key: "comment:key", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "Hello", actor: "core" } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.native_id).toBe(expectedId);
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({ verb: "firstmate-comment", issue: "ABC-1" }));
    const createCall = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line.split("\t")[1]!)).find((call) => call.variables?.body === "Hello");
    expect(createCall?.variables.issue).toBe("issue-id");
    db.close();
  });

  test("a comment job sends its thread root to Linear", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({
      key: "comment:threaded", kind: "linear.comment", target: "ABC-1",
      payload: { issue: "ABC-1", body: "Threaded reply", parent_id: "thread-root", actor: "core" },
    }, "2026-01-01T00:00:00Z");

    expect((await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" },
    })).done).toBe(1);

    const create = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line.split("\t")[1]!))
      .find((call) => call.variables?.body === "Threaded reply");
    expect(create?.variables.parentId).toBe("thread-root");
    db.close();
  });

  test("a rejected parent retries once as a top-level comment with the same identity and body", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-parent-rejected.json"), JSON.stringify({
      errors: [{ message: "Entity not found: Parent comment", extensions: { code: "ENTITY_NOT_FOUND" } }],
    }));
    await Bun.write(join(fixtures, "03-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({
      key: "comment:downgrade", kind: "linear.comment", target: "ABC-1",
      payload: { issue: "ABC-1", body: "Do not lose this body", parent_id: "deleted-parent", actor: "core" },
    }, "2026-01-01T00:00:00Z");

    expect((await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" },
    })).done).toBe(1);

    const creates = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line.split("\t")[1]!))
      .filter((call) => call.variables?.body === "Do not lose this body");
    expect(creates).toHaveLength(2);
    expect(creates.map((call) => call.variables.parentId)).toEqual(["deleted-parent", null]);
    expect(new Set(creates.map((call) => call.variables.id)).size).toBe(1);
    expect(db.jobs()[0]).toMatchObject({ state: "done", last_error: expect.stringContaining("parent-downgraded") });
    db.close();
  });

  test("service comments share one lazily created activity thread", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    for (const [index, response] of [
      { data: { issue: { id: "issue-id" } } },
      { data: { commentCreate: { success: true, comment: { id: "__COMMENT_ID__" } } } },
      { data: { commentCreate: { success: true, comment: { id: "first" } } } },
      { data: { issue: { id: "issue-id" } } },
      { data: { commentCreate: { success: true, comment: { id: "second" } } } },
      { data: { issue: { id: "issue-id" } } },
      { data: { commentCreate: { success: true, comment: { id: "third" } } } },
      { data: { issue: { id: "issue-id" } } },
      { data: { commentCreate: { success: true, comment: { id: "fourth" } } } },
    ].entries()) await Bun.write(join(fixtures, `${String(index + 1).padStart(2, "0")}.json`), JSON.stringify(response));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({
      issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null,
      last_actor: null, last_signal: null, observed_at: "2026-01-01T00:00:00Z",
    });
    for (const [index, body] of ["Gate passed", "Plan stage complete", "Build stage complete", "Merge-gate notice"].entries()) {
      db.enqueue({
        key: `service:${index}`, kind: "linear.comment", target: "ABC-1",
        payload: { issue: "ABC-1", body, actor: "service" },
      }, `2026-01-01T00:00:0${index}Z`);
    }

    expect((await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225610" },
    })).done).toBe(4);

    const creates = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line.split("\t")[1]!))
      .filter((call) => call.variables?.body);
    const activityRoot = creates.find((call) => call.variables.body === config.comments.activity_root_body)!;
    expect(creates.filter((call) => call.variables.parentId === null)).toHaveLength(1);
    expect(creates.filter((call) => call.variables.parentId === activityRoot.variables.id)).toHaveLength(4);
    expect(db.latestSnapshot("ABC-1")?.activity_root_id).toBe(activityRoot.variables.id);
    db.close();
  });

  test("service comments remain top-level when activity threading is disabled", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    for (const index of [1, 3, 5]) {
      await Bun.write(join(fixtures, `${String(index).padStart(2, "0")}-resolve.json`), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
      await Bun.write(join(fixtures, `${String(index + 1).padStart(2, "0")}-comment.json`), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: `comment-${index}` } } } }));
    }
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    for (const [index, body] of ["One", "Two", "Three"].entries()) {
      db.enqueue({ key: `top:${index}`, kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body, actor: "service" } }, `2026-01-01T00:00:0${index}Z`);
    }

    expect((await processJobs({
      db, config: { ...config, comments: { ...config.comments, activity_thread: false } },
      transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225610" },
    })).done).toBe(3);

    const creates = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line.split("\t")[1]!))
      .filter((call) => call.variables?.body);
    expect(creates.map((call) => call.variables.parentId)).toEqual([null, null, null]);
    db.close();
  });

  test("a deleted activity root is replaced once and the service reply stays threaded", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-parent-rejected.json"), JSON.stringify({
      errors: [{ message: "Entity not found: Parent comment", extensions: { code: "ENTITY_NOT_FOUND" } }],
    }));
    await Bun.write(join(fixtures, "03-root.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "__COMMENT_ID__" } } } }));
    await Bun.write(join(fixtures, "04-reply.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "reply" } } } }));
    await Bun.write(join(fixtures, "05-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "06-reply.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "following-reply" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({
      issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null,
      last_actor: null, last_signal: null, activity_root_id: "deleted-root", observed_at: "2026-01-01T00:00:00Z",
    });
    db.enqueue({
      key: "service:replace-root", kind: "linear.comment", target: "ABC-1",
      payload: { issue: "ABC-1", body: "Service update", actor: "service" },
    }, "2026-01-01T00:00:00Z");
    db.enqueue({
      key: "service:following-reply", kind: "linear.comment", target: "ABC-1",
      payload: { issue: "ABC-1", body: "Following update", actor: "service" },
    }, "2026-01-01T00:00:00Z");

    expect((await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" },
    })).done).toBe(2);

    const creates = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line.split("\t")[1]!))
      .filter((call) => call.variables?.body);
    const rootCreate = creates.find((call) => call.variables.body === config.comments.activity_root_body)!;
    const replies = creates.filter((call) => call.variables.body === "Service update");
    expect(replies.map((call) => call.variables.parentId)).toEqual(["deleted-root", rootCreate.variables.id]);
    expect(creates.find((call) => call.variables.body === "Following update")?.variables.parentId).toBe(rootCreate.variables.id);
    expect(creates.filter((call) => call.variables.body === config.comments.activity_root_body)).toHaveLength(1);
    expect(db.latestSnapshot("ABC-1")?.activity_root_id).toBe(rootCreate.variables.id);
    db.close();
  });

  test("a decision question starts a top-level thread and records its mapping", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "question-comment" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({
      issue: "ABC-1", role: "decision-captain", assignee: "Captain", labels: [], agent_label: null,
      last_actor: null, last_signal: null, observed_at: "2026-01-01T00:00:00Z",
    });
    db.linkTask({
      lifecycle_id: "link:worker", task: "worker", issue: "ABC-1", role: "primary",
      worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null,
    });
    db.enqueue({
      key: "decision:question", kind: "linear.comment", target: "ABC-1",
      payload: {
        issue: "ABC-1", body: "Pick red or blue", actor: "service", decision_new_thread: true,
        decision_key: "color", decision_task: "worker", decision_lifecycle_id: "link:worker",
      },
    }, "2026-01-01T00:00:00Z");

    expect((await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" },
    })).done).toBe(1);

    const create = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line.split("\t")[1]!))
      .find((call) => call.variables?.body === "Pick red or blue");
    expect(create?.variables.parentId).toBeNull();
    expect(db.latestSnapshot("ABC-1")?.activity_root_id).toBeNull();
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({
      source: "summary", task: "worker", task_lifecycle_id: "link:worker",
      verb: "decision-comment", key: "color", note: create?.variables.id,
    }));
    db.close();
  });

  test("promise activation rejects status produced before reply delivery", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures); mkdirSync(join(root, "state"));
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const statusPath = join(root, "state", "worker.status");
    writeFileSync(statusPath, "done: before promise\n");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    const job = db.enqueue({ key: "comment:promise", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will finish", actor: "core" } }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "status:done", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z" });
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:00Z") / 1000) } });
    scanFleet(root, db, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:21:00Z") / 1000) });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:21:00Z") / 1000) });
    expect(db.promise(promise.id)?.state).toBe("open");

    appendFileSync(statusPath, "done: after promise\n");
    scanFleet(root, db, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:22:00Z") / 1000) });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:22:00Z") / 1000) });
    expect(db.promise(promise.id)?.state).toBe("kept");
    db.close();
  });

  test("promise rejects status from the ambiguous delivery interval", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures); mkdirSync(join(root, "state"));
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const statusPath = join(root, "state", "worker.status");
    writeFileSync(statusPath, "");
    class DeliveryProgressTransport extends LinearTransport {
      override async call(operation: string, request: GraphqlPayload): Promise<TransportResult> {
        const result = await super.call(operation, request);
        if (operation === "job-comment" && result.ok) appendFileSync(statusPath, "done: after delivery\n");
        return result;
      }
    }
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    const job = db.enqueue({ key: "comment:same-second-promise", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will finish", actor: "core" } }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "status:done", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z" });
    const env = { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:00Z") / 1000) };

    await processJobs({ db, config, transport: new DeliveryProgressTransport({ fixtureDir: fixtures }), env });
    scanFleet(root, db, env);
    reconcileStalls(root, db, config, env);

    expect(db.promise(promise.id)).toMatchObject({ state: "open", created_at: "2026-01-01T12:20:00Z" });
    appendFileSync(statusPath, "done: confirmed after delivery\n");
    scanFleet(root, db, env);
    reconcileStalls(root, db, config, env);
    expect(db.promise(promise.id)?.state).toBe("kept");
    db.close();
  });

  test("promise recovery rejects progress without authoritative occurrence time", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures); mkdirSync(join(root, "state"));
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-fail-500.json"), "{}");
    await Bun.write(join(fixtures, "03-verify-missing.json"), JSON.stringify({ data: { comment: null } }));
    await Bun.write(join(fixtures, "04-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "05-fail-500.json"), "{}");
    const expectedId = "25b190d9-5082-4a6d-abd7-d66c0a3c1d78";
    await Bun.write(join(fixtures, "06-verify-delivered.json"), JSON.stringify({ data: { comment: { id: expectedId, createdAt: "2026-01-01T12:20:00Z" } } }));
    const statusPath = join(root, "state", "worker.status");
    writeFileSync(statusPath, "");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    const job = db.enqueue({ key: "comment:crash-recovery", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will finish", actor: "core" } }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:crash", expected_event: "status:done", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z" });
    const transport = new LinearTransport({ fixtureDir: fixtures });

    await processJobs({ db, config, transport, env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:00Z") / 1000) } });
    appendFileSync(statusPath, "done: after accepted comment\n");
    scanFleet(root, db, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:21:00Z") / 1000) });
    await processJobs({ db, config, transport, env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:22:00Z") / 1000) } });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:22:00Z") / 1000) });

    expect(db.promise(promise.id)).toMatchObject({ state: "open", created_at: "2026-01-01T12:20:00Z", reply_comment_id: expectedId });
    appendFileSync(statusPath, "done: after conservative recovery boundary\n");
    scanFleet(root, db, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:23:00Z") / 1000) });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:23:00Z") / 1000) });
    expect(db.promise(promise.id)?.state).toBe("kept");
    db.close();
  });

  test("promise source identities disambiguate same-second board and dispatch progress", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    for (const index of [1, 3]) {
      await Bun.write(join(fixtures, `${index.toString().padStart(2, "0")}-resolve.json`), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
      await Bun.write(join(fixtures, `${(index + 1).toString().padStart(2, "0")}-comment.json`), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    }
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const deliveredAt = "2026-01-01T12:20:00Z";
    const env = { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse(deliveredAt) / 1000) };
    db.linkTask({ task: "before", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: deliveredAt, torn_down_at: null });
    db.observe({ id: "obs:done-before", source: "linear", task: null, issue: "ABC-1", verb: "board-transition", key: "Done", note: null, observed_at: deliveredAt });

    const dispatchJob = db.enqueue({ key: "comment:dispatch-identity", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will dispatch", actor: "core" } }, "2026-01-01T12:00:00Z");
    const dispatchPromise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:dispatch", expected_event: "dispatch", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: dispatchJob.id, created_at: "2026-01-01T12:00:00Z" });
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env });
    reconcileStalls(root, db, config, env);
    expect(db.promise(dispatchPromise.id)?.state).toBe("open");
    db.linkTask({ task: "after", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: deliveredAt, torn_down_at: null });
    reconcileStalls(root, db, config, env);
    expect(db.promise(dispatchPromise.id)?.state).toBe("kept");

    const boardJob = db.enqueue({ key: "comment:board-identity", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will finish", actor: "core" } }, deliveredAt);
    const boardPromise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:board", expected_event: "board:Done", deadline_at: "2026-01-01T12:50:00Z", reply_job_id: boardJob.id, created_at: deliveredAt });
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env });
    reconcileStalls(root, db, config, env);
    expect(db.promise(boardPromise.id)?.state).toBe("open");
    db.observe({ id: "obs:done-after", source: "linear", task: null, issue: "ABC-1", verb: "board-transition", key: "Done", note: null, observed_at: "2026-01-01T12:20:01Z" });
    reconcileStalls(root, db, config, { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:01Z") / 1000) });
    expect(db.promise(boardPromise.id)?.state).toBe("kept");

    const commentJob = db.enqueue({ key: "comment:comment-identity", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will comment again", actor: "core" } }, deliveredAt);
    const commentPromise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:comment", expected_event: "comment", deadline_at: "2026-01-01T12:50:00Z", reply_job_id: commentJob.id, created_at: deliveredAt });
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env });
    reconcileStalls(root, db, config, env);
    expect(db.promise(commentPromise.id)?.state).toBe("open");
    db.enqueue({ key: "comment:after-promise", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "Follow-up", actor: "core" } }, deliveredAt);
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env });
    reconcileStalls(root, db, config, env);
    expect(db.promise(commentPromise.id)?.state).toBe("kept");
    db.close();
  });

  test("a missing PR boundary retries before sending the promise reply", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures); mkdirSync(join(root, "state"));
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    writeFileSync(join(root, "state", "worker.meta"), "spawn_gen=g1\npr=https://github.com/acme/repo/pull/1\npr_head=head1\npr_base=main\n");
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    const job = db.enqueue({ key: "comment:missing-pr-boundary", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will keep it green", actor: "core" } }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z" });

    const result = await processJobs({
      db,
      config,
      transport: new LinearTransport({ fixtureDir: fixtures }),
      inspectPr: () => { throw new Error("PR unavailable"); },
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:00Z") / 1000) },
    });

    expect(result.retried).toBe(1);
    expect(db.jobs()[0]).toMatchObject({ state: "retry", native_id: null });
    expect(db.promise(promise.id)).toMatchObject({ state: "pending", source_watermarks: null });
    db.close();
  });

  test("promise activation rejects an unchanged pre-delivery PR state", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures); mkdirSync(join(root, "state"));
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const metaPath = join(root, "state", "worker.meta");
    writeFileSync(metaPath, "spawn_gen=g1\npr=https://github.com/acme/repo/pull/1\npr_head=head1\npr_base=main\n");
    const green = (headRefOid: string) => ({ state: "OPEN" as const, headRefOid, baseRefName: "main", requiredChecks: [{ name: "test", state: "pass" }] });
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T12:00:00Z", torn_down_at: null });
    const job = db.enqueue({ key: "comment:pr-promise", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will keep it green", actor: "core" } }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z" });
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), inspectPr: () => green("head1"), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:00Z") / 1000) } });
    scanPullRequests(root, db, () => green("head1"), { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:21:00Z") / 1000) });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:21:00Z") / 1000) });
    expect(db.promise(promise.id)?.state).toBe("open");

    writeFileSync(metaPath, "spawn_gen=g1\npr=https://github.com/acme/repo/pull/1\npr_head=head2\npr_base=main\n");
    scanPullRequests(root, db, () => green("head2"), { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:22:00Z") / 1000) });
    reconcileStalls(root, db, config, { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:22:00Z") / 1000) });
    expect(db.promise(promise.id)?.state).toBe("kept");
    db.close();
  });

  test("PR progress survives close and relink before the next service scan", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures); mkdirSync(join(root, "state"));
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    writeFileSync(join(root, "state", "worker.meta"), "spawn_gen=g1\npr=https://github.com/acme/repo/pull/1\npr_head=head1\npr_base=main\n");
    const env = { FM_HOME: root, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:00:00Z") / 1000) };
    expect(runTask(["link", "worker", "ABC-1"], env)).toBe(0);
    let db = StateDatabase.open(env);
    const originalLifecycle = db.taskLinks("ABC-1", true)[0]!.lifecycle_id;
    const job = db.enqueue({ key: "comment:close-relink-pr", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "I will get CI green", actor: "core" } }, "2026-01-01T12:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "pr-green", deadline_at: "2026-01-01T12:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T12:00:00Z" });
    const snapshot = (state: string) => ({ state: "OPEN" as const, headRefOid: "head1", baseRefName: "main", requiredChecks: [{ name: "test", state }] });
    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), inspectPr: () => snapshot("fail"), env: { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:20:00Z") / 1000) } });
    db.close();

    expect(runTask(["close", "worker"], { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:21:00Z") / 1000) }, { inspectPr: () => snapshot("pass") })).toBe(0);
    expect(runTask(["link", "worker", "ABC-1"], { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:22:00Z") / 1000) })).toBe(0);
    db = StateDatabase.open(env);
    const result = scanPullRequests(root, db, () => snapshot("pass"), { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:23:00Z") / 1000) });
    reconcileStalls(root, db, config, { ...env, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:23:00Z") / 1000) });

    expect(result.observations).toHaveLength(0);
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({ verb: "pr-green", task_lifecycle_id: originalLifecycle, observed_at: "2026-01-01T12:21:00Z" }));
    expect(result.observations.some((item) => item.task_lifecycle_id === db.taskLinks("ABC-1", true)[0]!.lifecycle_id)).toBe(false);
    expect(db.promise(promise.id)?.state).toBe("kept");
    db.close();
  });

  test("an already-satisfied retried state job records no transition", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { viewer: { id: "me" }, issue: { id: "issue-id", state: { name: "Done" }, team: { states: { nodes: [] }, members: { nodes: [] } } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const job = db.enqueue({ key: "state:retry", kind: "linear.issue-role", target: "ABC-1", payload: { issue: "ABC-1", role: "done" } }, "2026-01-01T00:00:00Z");
    db.claimDueJobs(1, "2026-01-01T00:00:00Z");
    db.retryJob(job.id, "lost acknowledgement", "2026-01-01T00:00:01Z");

    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225601" } });

    expect(db.observations("ABC-1").filter((item) => item.verb === "board-transition")).toHaveLength(0);
    db.close();
  });

  test("a managed-scope skip fails its staged promise without progress", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Someone Else", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: false, observed_at: "2026-01-01T00:00:00Z" });
    const job = db.enqueue({ key: "comment:skipped", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "Not delivered", actor: "core", requires_managed: true } }, "2026-01-01T00:00:00Z");
    const promise = db.stagePromise({ issue: "ABC-1", source_event_id: "event:one", expected_event: "comment", deadline_at: "2026-01-01T00:30:00Z", reply_job_id: job.id, created_at: "2026-01-01T00:00:00Z" });

    await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });

    expect(db.jobs()[0]).toMatchObject({ state: "done", native_id: null });
    expect(db.jobs()[0]?.last_error).toContain("skipped: issue is outside managed scope");
    expect(db.promise(promise.id)?.state).toBe("failed");
    expect(db.observations("ABC-1").filter((item) => item.verb === "firstmate-comment")).toHaveLength(0);
    db.close();
  });

  test("an unsuccessful comment mutation retries instead of completing", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: false, comment: null } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "comment:unsuccessful", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "Hello" } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.retried).toBe(1);
    expect(db.jobs()[0]).toMatchObject({ state: "retry", native_id: null });
    db.close();
  });

  test("a dead reply job fails its pending promise without superseding the active promise", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id" } } }));
    await Bun.write(join(fixtures, "02-comment.json"), JSON.stringify({ data: { commentCreate: { success: false, comment: null } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    const active = db.createPromise({ issue: "ABC-1", source_event_id: "event:active", expected_event: "pr-green", deadline_at: "2026-01-01T00:30:00Z", reply_job_id: "job:active", created_at: "2026-01-01T00:00:00Z" });
    const job = db.enqueue({ key: "comment:dead", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "Hello", actor: "core" } }, "2026-01-01T00:00:00Z");
    const pending = db.stagePromise({ issue: "ABC-1", source_event_id: "event:new", expected_event: "pr-merged", deadline_at: "2026-01-01T01:00:00Z", reply_job_id: job.id, created_at: "2026-01-01T00:00:00Z" });
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" }, maxAttempts: 1 });
    expect(result.dead).toBe(1);
    expect(db.promise(pending.id)?.state).toBe("failed");
    expect(db.promise(active.id)?.state).toBe("open");
    db.close();
  });

  test("an ambiguous attachment failure verifies the URL and does not duplicate", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const url = "https://github.com/example/repo/pull/42";
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id", attachments: { nodes: [] } } } }));
    await Bun.write(join(fixtures, "02-fail-500.json"), "{}");
    await Bun.write(join(fixtures, "03-verify.json"), JSON.stringify({ data: { issue: { id: "issue-id", attachments: { nodes: [{ id: "attachment-id", url }] } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "attachment:key", kind: "linear.attachment", target: "ABC-1", payload: { issue: "ABC-1", url } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.native_id).toBe("attachment-id");
    db.close();
  });

  test("a receipt acknowledgement reaches Firstmate core through the outbox", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const firstmate = join(root, "firstmate");
    const bin = join(firstmate, "bin");
    mkdirSync(bin, { recursive: true });
    const calls = join(root, "handled.txt");
    const script = join(bin, "fm-procevent.sh");
    writeFileSync(script, `#!/bin/sh\nprintf '%s %s %s\\n' "$1" "$2" "$3" >> "${calls}"\n`);
    chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.capture({ id: "event:ack", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:01Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    db.nextForCore("request:ack", 0);
    db.bindDeliverySequence("event:ack", 9);
    const receipt = db.issueReceipt(["event:ack"]);
    db.handleWithReceipt("event:ack", receipt, "Captain", "handled", "2026-01-01T00:00:02Z");
    const env = { FM_HOME: root, FM_ROOT_OVERRIDE: firstmate, FM_LINEAR_NOW_EPOCH: "1767225603" };
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env });
    expect(result.done).toBe(1);
    expect(readFileSync(calls, "utf8")).toBe("handled linear-main 9\n");
    expect(db.deliveryForEvent("event:ack")?.handled_at).not.toBeNull();
    db.close();
  });

  test("relay becomes silently handled only after durable steering succeeds", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const script = join(bin, "fm-send.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n"); chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "task-1", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const lifecycle = db.taskLinks("ABC-1", true)[0]!.lifecycle_id;
    db.capture({ ...eventRecord("event:relay"), disposition: "classified" }, [{ key: "event:relay:relay", kind: "relay", target: "ABC-1", payload: { event_id: "event:relay", issue: "ABC-1", task: "task-1", lifecycle_id: lifecycle, key: "choice" } }]);
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root }, maxAttempts: 1 });
    expect(result.done).toBe(1);
    expect(db.event("event:relay")?.disposition).toBe("handled-by-service");
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({ verb: "relay", task: "task-1" }));
    db.close();
  });

  test("fleet send uses the linked remote home and records recipient-side evidence", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const calls = join(root, "remote-calls");
    const script = join(bin, "fm-send.sh");
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nprintf '/remote/state/worker.inbox/one.json\\n'\n`); chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", host: "mini", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.enqueue({ key: "remote-send", kind: "fleet.send", target: "worker", payload: { task: "worker", issue: "ABC-1", message: "Report status" } }, "2026-01-01T00:00:00Z");

    expect((await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root, FM_ROOT_OVERRIDE: root, FM_LINEAR_NOW_EPOCH: "1767225600" } })).done).toBe(1);
    const firstCall = readFileSync(calls, "utf8").trim();
    const deliveryId = firstCall.match(/^worker --fire-and-forget ([a-f0-9]{16}) Report status$/)?.[1];
    expect(deliveryId).toBeTruthy();
    const steer = db.steers()[0]!;
    expect(steer).toMatchObject({ home: "mini", task: "worker", record_path: "/remote/state/worker.inbox/one.json", delivery_id: deliveryId });

    db.enqueue({
      key: `${steer.id}:redeliver`, kind: "fleet.send", target: "worker",
      payload: { task: "worker", issue: "ABC-1", home: "mini", record_path: steer.record_path, message: "Report status", delivery_id: steer.delivery_id },
    }, "2026-01-01T00:01:00Z");
    expect((await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root, FM_ROOT_OVERRIDE: root, FM_LINEAR_NOW_EPOCH: "1767225660" } })).done).toBe(1);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([firstCall, firstCall]);
    db.close();
  });

  test("a local steer redelivery reuses the durable inbox record", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const inbox = join(root, "state", "worker.inbox"); mkdirSync(inbox, { recursive: true });
    const record = join(inbox, "001.msg"); writeFileSync(record, "schema=fm-task-inbox.v1\n--\nReport status");
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const calls = join(root, "local-calls");
    writeFileSync(join(bin, "fm-send.sh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`); chmodSync(join(bin, "fm-send.sh"), 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "redeliver", kind: "fleet.send", target: "worker", payload: { task: "worker", issue: "ABC-1", home: "local", record_path: record, message: "Report status" } }, "2026-01-01T00:00:00Z");

    expect((await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } })).done).toBe(1);
    expect(db.steers()).toContainEqual(expect.objectContaining({ record_path: record, message: "Report status" }));
    expect(readFileSync(calls, "utf8").trim()).toMatch(/^worker --fire-and-forget [a-f0-9]{16} Report status$/);
    expect(readFileSync(record, "utf8")).toContain("Report status");
    db.close();
  });

  test("a terminal relay failure falls back to a core-visible event", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const script = join(bin, "fm-send.sh");
    writeFileSync(script, "#!/bin/sh\necho refused >&2\nexit 1\n"); chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "task-1", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const lifecycle = db.taskLinks("ABC-1", true)[0]!.lifecycle_id;
    db.capture({ ...eventRecord("event:relay-failed"), disposition: "classified" }, [{ key: "event:relay-failed:relay", kind: "relay", target: "ABC-1", payload: { event_id: "event:relay-failed", issue: "ABC-1", task: "task-1", lifecycle_id: lifecycle, key: "choice" } }]);
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root }, maxAttempts: 1 });
    expect(result.dead).toBe(1);
    expect(db.event("event:relay-failed")?.disposition).toBe("waiting-for-core");
    db.close();
  });

  test("a relay refuses to cross into a replacement task lifecycle", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const calls = join(root, "relay-calls");
    const script = join(bin, "fm-send.sh");
    writeFileSync(script, `#!/bin/sh\nprintf called >> "${calls}"\n`); chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({ task: "task-1", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    const originalLifecycle = db.taskLinks("ABC-1", true)[0]!.lifecycle_id;
    db.capture({ ...eventRecord("event:stale-relay"), disposition: "classified" }, [{ key: "event:stale-relay:relay", kind: "relay", target: "ABC-1", payload: { event_id: "event:stale-relay", issue: "ABC-1", task: "task-1", lifecycle_id: originalLifecycle, key: null } }]);
    db.closeTask("task-1", "2026-01-01T00:01:00Z");
    db.linkTask({ task: "task-1", issue: "ABC-2", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null });

    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root } });

    expect(result.done).toBe(1);
    expect(existsSync(calls)).toBe(false);
    expect(db.event("event:stale-relay")).toMatchObject({ disposition: "waiting-for-core", note: "relay task lifecycle is no longer active" });
    db.close();
  });

  test("a lifecycle-bound steer redelivers to an active support task", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const calls = join(root, "support-calls");
    writeFileSync(join(bin, "fm-send.sh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    chmodSync(join(bin, "fm-send.sh"), 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.linkTask({
      lifecycle_id: "link:support", task: "support", issue: "ABC-1", role: "support",
      worktree: null, harness: null, spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null,
    });
    db.enqueue({
      key: "support-redelivery", kind: "fleet.send", target: "support",
      payload: {
        task: "support", issue: "ABC-1", lifecycle_id: "link:support", record_path: "/remote/support.inbox/001.msg",
        delivery_id: "delivery-support", message: "Report status",
      },
    }, "2026-01-01T00:01:00Z");

    expect((await processJobs({
      db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root },
    })).done).toBe(1);
    expect(readFileSync(calls, "utf8").trim()).toBe("support --fire-and-forget delivery-support Report status");
    db.close();
  });

  test("recorded captain identity resolves captain-owned state assignment", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { viewer: { id: "me" }, issue: { id: "issue-id", state: { name: "Building" }, team: { states: { nodes: [{ id: "decision", name: "Needs Decision" }] }, members: { nodes: [{ id: "captain-id", displayName: redactedIdentity("Captain") }] } } } } }));
    await Bun.write(join(fixtures, "02-update.json"), JSON.stringify({ data: { issueUpdate: { success: true } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "state:captain", kind: "linear.issue-role", target: "ABC-1", payload: { issue: "ABC-1", role: "decision-captain" } }, "2026-01-01T00:00:00Z");
    expect((await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } })).done).toBe(1);
    expect(db.jobs()[0]?.state).toBe("done");
    db.close();
  });

  test("resolves a configured team key before creating workflow state", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-team.json"), JSON.stringify({ data: { teams: { nodes: [{ id: "team-uuid", key: "ABC", states: { nodes: [] } }] } } }));
    await Bun.write(join(fixtures, "02-state.json"), JSON.stringify({ data: { workflowStateCreate: { success: true, workflowState: { id: "state-id", name: "Building" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "state:building", kind: "linear.workflow-state", target: "ABC", payload: { team: "ABC", role: "building", name: "Building" } }, "2026-01-01T00:00:00Z");

    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });

    expect(result.done).toBe(1);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => ({ operation: line.split("\t")[0], payload: JSON.parse(line.split("\t")[1]!) }));
    expect(calls.find((call) => call.operation === "job-create-state")?.payload.variables.team).toBe("team-uuid");
    db.close();
  });

  test("resolves Agent labels from the workspace collection", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const log = join(root, "calls.log");
    await Bun.write(join(fixtures, "01-managed.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null } } }));
    await Bun.write(join(fixtures, "02-labels.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      issue: { id: "issue-id", identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null, labels: { nodes: [{ id: "old-label", name: "Agent: Old" }] } },
      issueLabels: { nodes: [
        { id: "workspace-label", name: "Agent: Codex", team: null },
        { id: "team-label", name: "Agent: Codex", team: { id: "team-uuid" } },
      ] },
    } }));
    await Bun.write(join(fixtures, "03-update.json"), JSON.stringify({ data: { issueUpdate: { success: true } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: ["Agent: Old"], agent_label: "Agent: Old", last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T00:00:00Z" });
    db.enqueue({ key: "label:codex", kind: "linear.agent-label", target: "ABC-1", payload: { issue: "ABC-1", label: "Agent: Codex", known_labels: ["Agent: Old", "Agent: Codex"], requires_managed: true } }, "2026-01-01T00:00:00Z");

    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog: log }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });

    expect(result.done).toBe(1);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => ({ operation: line.split("\t")[0], payload: JSON.parse(line.split("\t")[1]!) }));
    expect(calls.find((call) => call.operation === "job-update-labels")?.payload.variables).toMatchObject({
      issue: "issue-id", added: ["workspace-label"], removed: ["old-label"],
    });
    db.close();
  });

  test("rejects ambiguous workspace Agent label matches", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-managed.json"), JSON.stringify({ data: { viewer: { displayName: "Firstmate" }, issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null } } }));
    await Bun.write(join(fixtures, "02-labels.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      issue: { id: "issue-id", identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null, labels: { nodes: [] } },
      issueLabels: { pageInfo: { hasNextPage: false }, nodes: [
        { id: "workspace-one", name: "Agent: Codex", team: null },
        { id: "workspace-two", name: "Agent: Codex", team: null },
      ] },
    } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: true, observed_at: "2026-01-01T00:00:00Z" });
    db.enqueue({ key: "label:ambiguous", kind: "linear.agent-label", target: "ABC-1", payload: { issue: "ABC-1", label: "Agent: Codex", known_labels: ["Agent: Codex"], requires_managed: true } }, "2026-01-01T00:00:00Z");

    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" }, maxAttempts: 1 });

    expect(result.dead).toBe(1);
    expect(db.jobs()[0]?.last_error).toBe("multiple workspace Agent labels named: Agent: Codex");
    db.close();
  });

  test("apply-labels creates only the workspace Agent group", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-labels.json"), JSON.stringify({ data: { issueLabels: { nodes: [] } } }));
    await Bun.write(join(fixtures, "02-create.json"), JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "agent-group", name: "Agent", isGroup: true } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "labels:agent", kind: "linear.label-group", target: "Agent", payload: { name: "Agent" } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.native_id).toBe("agent-group");
    db.close();
  });
});

function eventRecord(id: string) {
  return {
    id, team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain",
    body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:01Z",
    disposition: "waiting-for-core" as const, note: null, raw_ref: "{}",
  };
}
