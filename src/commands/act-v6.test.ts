import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { LinearTransport } from "../transport.ts";
import { runActV6 } from "./act-v6.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(options: { liveState?: string; liveAssignee?: string; managed?: "all" | "assignee:self" } = {}): { home: string; env: NodeJS.ProcessEnv; receipt: string } {
  const home = mkdtempSync("/private/tmp/fml-act-"); roots.push(home); mkdirSync(join(home, "config"));
  const fixtures = join(home, "fixtures"); mkdirSync(fixtures);
  const liveState = options.liveState ?? "Approve Deliverable";
  const liveAssignee = options.liveAssignee ?? "Captain";
  writeFileSync(join(fixtures, "01-comments.json"), JSON.stringify({ data: { comments: { pageInfo: { hasNextPage: false }, nodes: [] } } }));
  writeFileSync(join(fixtures, "02-issue.json"), JSON.stringify({ data: {
    viewer: { displayName: "Firstmate" },
    issue: {
      identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:00:03Z",
      state: { name: liveState }, assignee: { displayName: liveAssignee }, creator: { displayName: "Captain" },
      project: null, labels: { nodes: [] }, history: { pageInfo: { hasNextPage: false }, nodes: [] },
    },
  } }));
  writeFileSync(join(home, "config", "linear-workflow.yaml"), `version: 1\ncaptain:\n  display_name: Captain\nteams:\n  - key: ABC\n    managed: ${options.managed ?? "all"}\n    projects: []\n    roles:\n      plan-gate: Approve Plan\n      building: Building\n      review-gate: Approve Deliverable\n      validating: Validating Code\n      merge-gate: Approve Merge\n      decision-captain: Needs Decision\n      decision-firstmate: Needs Firstmate Decision\n      done: Done\n      canceled: Canceled\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n`);
  const env = { FM_HOME: home, FM_LINEAR_FIXTURE_DIR: fixtures };
  const db = StateDatabase.open(env);
  db.snapshot({ issue: "ABC-1", role: "review-gate", assignee: "Captain", labels: [], agent_label: null, last_actor: "Captain", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
  db.capture({ id: "event:one", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:01Z", captured_at: "2026-01-01T00:00:02Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
  const receipt = db.issueReceipt(["event:one"], "2026-01-01T00:00:03Z"); db.close();
  return { home, env, receipt };
}

describe("v6 act read gate", async () => {
  test("captain-facing replies on firstmate-owned issues require a next promise", async () => {
    const { env, receipt } = setup({ liveState: "Building", liveAssignee: "Firstmate" });
    const db = StateDatabase.open(env);
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:01:00Z" });
    db.close();

    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "I will validate it"], env)).toBe(1);

    const after = StateDatabase.open(env);
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    expect(after.jobs()).toHaveLength(0);
    after.close();
  });

  test("next none allows a reply without recording a promise", async () => {
    const { env, receipt } = setup({ liveState: "Building", liveAssignee: "Firstmate" });
    const db = StateDatabase.open(env);
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:01:00Z" });
    db.close();

    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Nothing else is expected", "--next", "none"], env)).toBe(0);

    const after = StateDatabase.open(env);
    expect(after.promises("ABC-1")).toHaveLength(0);
    expect(JSON.parse(after.jobs().find((job) => job.kind === "linear.comment")!.payload).body).toContain("Next: none");
    after.close();
  });

  test("send records a durable fleet delivery job without inventing a promise", async () => {
    const { env, receipt } = setup({ liveState: "Building", liveAssignee: "Firstmate" });
    expect(await runActV6(["send", "ABC-1", "--receipt", receipt, "--task", "worker", "--home", "mini", "--comment", "Please report status"], env)).toBe(0);
    const db = StateDatabase.open(env);
    expect(db.jobs()[0]?.kind).toBe("fleet.send");
    expect(JSON.parse(db.jobs()[0]!.payload)).toMatchObject({ issue: "ABC-1", task: "worker", home: "mini", message: "Please report status" });
    expect(db.promises("ABC-1")).toHaveLength(0);
    db.close();
  });

  test("next and by create a durable promise with the rendered commitment", async () => {
    const { env, receipt } = setup({ liveState: "Building", liveAssignee: "Firstmate" });
    const db = StateDatabase.open(env);
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:01:00Z" });
    const previous = db.createPromise({ issue: "ABC-1", source_event_id: "event:previous", expected_event: "status:done", deadline_at: "2026-01-01T00:20:00Z", reply_job_id: "job:previous", created_at: "2026-01-01T00:01:00Z" });
    db.close();
    env.FM_LINEAR_NOW_EPOCH = String(Date.parse("2026-01-01T00:02:00Z") / 1000);

    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Validation is running", "--next", "pr-green", "--by", "30m"], env)).toBe(0);

    const after = StateDatabase.open(env);
    const pending = after.promises("ABC-1").find((item) => item.expected_event === "pr-green")!;
    expect(pending).toMatchObject({ deadline_at: "2026-01-01T00:32:00Z", state: "pending" });
    expect(after.promise(previous.id)?.state).toBe("open");
    const comment = after.jobs().find((job) => job.kind === "linear.comment")!;
    expect(JSON.parse(comment.payload).body).toContain("Next: pr-green by 30m");
    after.finishJob(comment.id, "linear-comment-1", "2026-01-01T00:03:00Z");
    expect(after.promise(pending.id)).toMatchObject({
      state: "open",
      reply_comment_id: "linear-comment-1",
      created_at: "2026-01-01T00:03:00Z",
      deadline_at: "2026-01-01T00:33:00Z",
    });
    expect(after.promise(previous.id)).toMatchObject({ state: "superseded", superseded_by: pending.id });
    after.close();
  });

  test("next none rejects a meaningless deadline", async () => {
    const { env, receipt } = setup();
    const db = StateDatabase.open(env);
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:01:00Z" });
    db.close();
    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "No follow-up", "--next", "none", "--by", "30m"], env)).toBe(1);
    const after = StateDatabase.open(env);
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    after.close();
  });

  test("gate replies require a verdict and ownership", async () => {
    const { env, receipt } = setup();
    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it"], env)).toBe(1);
  });

  test("live gate state overrides a stale firstmate-owned snapshot", async () => {
    const { env, receipt } = setup();
    const db = StateDatabase.open(env);
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:01:00Z" });
    db.close();

    expect(await runActV6([
      "reply", "ABC-1", "--receipt", receipt, "--comment", "Continuing", "--next", "none",
    ], env)).toBe(1);

    const after = StateDatabase.open(env);
    expect(after.latestSnapshot("ABC-1")?.role).toBe("review-gate");
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    expect(after.jobs()).toHaveLength(0);
    after.close();
  });

  test("live managed state overrides a stale unmanaged snapshot", async () => {
    const { env, receipt } = setup();
    const db = StateDatabase.open(env);
    db.snapshot({ issue: "ABC-1", role: "review-gate", assignee: "Someone Else", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: false, observed_at: "2026-01-01T00:01:00Z" });
    db.close();

    expect(await runActV6([
      "reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate",
    ], env)).toBe(0);

    const after = StateDatabase.open(env);
    expect(after.latestSnapshot("ABC-1")?.managed).toBe(true);
    expect(after.receipt(receipt)?.consumed_at).not.toBeNull();
    after.close();
  });

  test("a valid gate reply enqueues jobs and consumes exact receipt", async () => {
    const { env, receipt } = setup();
    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate"], env)).toBe(0);
    const db = StateDatabase.open(env);
    expect(db.jobs()).toHaveLength(2);
    expect(db.jobs().map((job) => job.kind)).not.toContain("core.ack");
    expect(db.receipt(receipt)?.consumed_at).not.toBeNull();
    expect(db.event("event:one")?.disposition).toBe("handled-by-core"); db.close();
  });

  test("reply policy rejects status-verb leads", async () => {
    const { env, receipt } = setup();
    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Done: fixed", "--verdict", "approved", "--to", "firstmate"], env)).toBe(1);
  });

  test("reply policy rejects more than eight rendered lines", async () => {
    const { env, receipt } = setup();
    const text = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", text, "--verdict", "approved", "--to", "firstmate"], env)).toBe(1);
  });

  test("the public CLI cannot claim the service actor exemption", async () => {
    const { env } = setup();
    expect(await runActV6(["status", "ABC-1", "--role", "building", "--actor", "service"], env)).toBe(1);
    const db = StateDatabase.open(env);
    expect(db.jobs()).toHaveLength(0);
    db.close();
  });

  test("status requires a non-empty target before consuming its receipt", async () => {
    const { env, receipt } = setup();
    expect(await runActV6(["status", "ABC-1", "--receipt", receipt], env)).toBe(1);
    expect(await runActV6(["status", "ABC-1", "--receipt", receipt, "--role", "   "], env)).toBe(1);
    expect(await runActV6(["status", "ABC-1", "--role", "--receipt", receipt], env)).toBe(1);
    const db = StateDatabase.open(env);
    expect(db.receipt(receipt)?.consumed_at).toBeNull();
    expect(db.event("event:one")?.disposition).toBe("waiting-for-core");
    expect(db.jobs()).toHaveLength(0);
    db.close();
  });

  test("a newer captain comment makes a receipt stale", async () => {
    const { env, receipt } = setup();
    const db = StateDatabase.open(env);
    db.capture({ id: "event:new", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:04Z", captured_at: "2026-01-01T00:00:05Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    db.close();
    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate"], env)).toBe(1);
    const after = StateDatabase.open(env);
    expect(after.jobs()).toHaveLength(0);
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    after.close();
  });

  test("an uncaptured captain comment makes an action receipt stale", async () => {
    const { home, env, receipt } = setup();
    writeFileSync(join(home, "fixtures", "01-comments.json"), JSON.stringify({ data: { comments: {
      pageInfo: { hasNextPage: false }, nodes: [{
        id: "linear-comment-new", createdAt: "2026-01-01T00:00:04Z", updatedAt: "2026-01-01T00:00:04Z", body: "Use the other approach",
        user: { displayName: "Captain" }, issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
      }],
    } } }));
    writeFileSync(join(home, "fixtures", "02-issue.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      issue: {
        identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:00:04Z",
        state: { name: "Building" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" },
        project: null, labels: { nodes: [] }, history: { pageInfo: { hasNextPage: false }, nodes: [] },
      },
    } }));

    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate"], env)).toBe(1);

    const after = StateDatabase.open(env);
    expect(after.jobs()).toHaveLength(0);
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    expect(after.listEvents().some((event) => event.author === "Captain" && event.created_at === "2026-01-01T00:00:04Z")).toBe(true);
    after.close();
  });

  test("receipt synchronization starts from authorized event chronology", async () => {
    const { env, receipt } = setup();
    const transport = new LinearTransport({
      apiKey: "test",
      fetchImpl: async (_input, init) => {
        const payload = JSON.parse(String(init?.body)) as { query: string };
        if (payload.query.includes("issue(id:$id)")) {
          return new Response(JSON.stringify({ data: {
            viewer: { displayName: "Firstmate" },
            issue: {
              identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:00:02Z",
              state: { name: "Building" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" },
              project: null, labels: { nodes: [] }, history: { pageInfo: { hasNextPage: false }, nodes: [] },
            },
          } }), { status: 200 });
        }
        const since = /updatedAt:\{gte:"([^"]+)"/.exec(payload.query)?.[1] ?? "";
        const nodes = since <= "2026-01-01T00:00:02Z" ? [{
          id: "linear-comment-between-event-and-receipt",
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:02Z",
          body: "Use the other approach",
          user: { displayName: "Captain" },
          issue: { identifier: "ABC-1" },
          parent: null,
        }] : [];
        return new Response(JSON.stringify({ data: { comments: { pageInfo: { hasNextPage: false }, nodes } } }), { status: 200 });
      },
    });

    expect(await runActV6(
      ["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate"],
      env,
      { transport },
    )).toBe(1);

    const after = StateDatabase.open(env);
    expect(after.jobs()).toHaveLength(0);
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    expect(after.listEvents().some((event) => event.created_at === "2026-01-01T00:00:02Z")).toBe(true);
    after.close();
  });

  test("an action receipt cannot mutate an issue after it leaves scope", async () => {
    const { env, receipt } = setup({ liveAssignee: "Someone Else", managed: "assignee:self" });
    const db = StateDatabase.open(env);
    db.snapshot({ issue: "ABC-1", role: "review-gate", assignee: "Someone Else", labels: [], agent_label: null, last_actor: null, last_signal: null, managed: false, observed_at: "2026-01-01T00:01:00Z" });
    db.close();

    expect(await runActV6(["reply", "ABC-1", "--receipt", receipt, "--comment", "Please fix it", "--verdict", "changes-requested", "--to", "firstmate"], env)).toBe(1);
    const after = StateDatabase.open(env);
    expect(after.receipt(receipt)?.consumed_at).toBeNull();
    expect(after.jobs()).toHaveLength(0);
    after.close();
  });
});
