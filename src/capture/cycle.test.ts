import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testWorkflowConfig } from "../testing/config.ts";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { LinearTransport, redactFixture } from "../transport.ts";
import { planMirror } from "../mirror/plan.ts";
import { captureCycle } from "./cycle.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const config = testWorkflowConfig({ managed: "assignee:self", features: { relay: "shadow", mirror: "shadow", escalation: "shadow" } });

describe("SQLite capture cycle", () => {
  test("a failed cycle does not commit its resumed comment checkpoint", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: { pageInfo: { hasNextPage: true, endCursor: "page-two" }, nodes: [{
        id: "comment-1", createdAt: "2026-01-01T00:05:00Z", updatedAt: "2026-01-01T00:05:00Z",
        body: "continue", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
      }] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:06:00Z",
        state: { name: "Approve Deliverable" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [{
          id: "inconsistent-transition", createdAt: "2026-01-01T00:05:30Z", actor: { displayName: "Captain" },
          fromState: { name: "Building" }, toState: { name: "Approve Plan" },
        }] },
      }],
    } } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));

    await expect(captureCycle({
      config,
      db,
      transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767226200", FM_LINEAR_MAX_PAGES: "1" },
    })).rejects.toThrow("cannot reconstruct role for ABC-1 at comment revision");

    expect(db.cursor("linear.comments.page.ABC")).toBeNull();
    expect(db.cursor("linear.full.ABC")).toBeNull();
    expect(db.listEvents()).toHaveLength(0);
    db.close();
  });

  test("resumed comment capture commits the maximum timestamp across batches", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const comment = (id: string, updatedAt: string) => ({
      id, createdAt: updatedAt, updatedAt, body: "continue", user: { displayName: "Captain" },
      issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
    });
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: {
        pageInfo: { hasNextPage: true, endCursor: "page-two" }, nodes: [comment("newer", "2026-01-01T00:05:00Z")],
      },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } }));
    await Bun.write(join(fixtures, "03-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: {
        pageInfo: { hasNextPage: false }, nodes: [comment("older", "2026-01-01T00:04:00Z")],
      },
    } }));
    await Bun.write(join(fixtures, "04-issues.json"), JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    const transport = new LinearTransport({ fixtureDir: fixtures });
    const first = await captureCycle({
      config,
      db,
      transport,
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767226200", FM_LINEAR_MAX_PAGES: "1" },
    });

    expect(first.commentsMax).toBe("2026-01-01T00:05:00Z");
    expect(db.cursor("linear.comments.ABC")).toBeNull();
    expect(JSON.parse(db.cursor("linear.comments.page.ABC")!)).toMatchObject({ after: "page-two", highWater: "2026-01-01T00:05:00Z" });

    const second = await captureCycle({
      config,
      db,
      transport,
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767226260", FM_LINEAR_MAX_PAGES: "1" },
    });

    expect(second.commentsMax).toBe("2026-01-01T00:05:00Z");
    expect(db.cursor("linear.comments.ABC")).toBe("2026-01-01T00:05:00Z");
    expect(db.cursor("linear.comments")).toBe("2026-01-01T00:05:00Z");
    expect(db.cursor("linear.comments.page.ABC")).toBe("");
    expect(db.listEvents()).toHaveLength(2);
    db.close();
  });

  test("resumed comments use full history to classify their revision state", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const comment = (id: string, updatedAt: string, body: string, author: string) => ({
      id, createdAt: updatedAt, updatedAt, body, user: { displayName: author },
      issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
    });
    const issue = {
      identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:05:00Z",
      state: { name: "Approve Deliverable" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
      history: { pageInfo: { hasNextPage: false }, nodes: [{
        id: "deliverable-gate", createdAt: "2026-01-01T00:04:00Z", actor: { displayName: "Captain" },
        fromState: { name: "Approve Plan" }, toState: { name: "Approve Deliverable" },
      }] },
    };
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: {
        pageInfo: { hasNextPage: true, endCursor: "older-comments" },
        nodes: [comment("newer-self", "2026-01-01T00:05:00Z", "working", "Firstmate")],
      },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [issue] } } }));
    await Bun.write(join(fixtures, "03-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: {
        pageInfo: { hasNextPage: false }, nodes: [comment("older-approval", "2026-01-01T00:03:00Z", "approved", "Captain")],
      },
    } }));
    await Bun.write(join(fixtures, "04-issues.json"), JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [issue] } } }));
    const log = join(root, "calls.log");
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    const transport = new LinearTransport({ fixtureDir: fixtures, fixtureLog: log });

    await captureCycle({
      config, db, transport,
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767226200", FM_LINEAR_MAX_PAGES: "1" },
    });
    await captureCycle({
      config, db, transport,
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767226260", FM_LINEAR_MAX_PAGES: "1" },
    });

    const approval = db.listEvents().find((event) => event.type === "comment");
    expect(approval).toMatchObject({ token: "gate-pass", disposition: "waiting-for-core" });
    expect(JSON.parse(db.jobs().find((job) => job.key.includes(approval!.id))!.payload)).toMatchObject({
      role: "building", expected_role: "plan-gate",
    });
    const issueCalls = (await Bun.file(log).text()).trim().split("\n")
      .filter((line) => line.startsWith("issues\t"))
      .map((line) => JSON.parse(line.split("\t")[1]!));
    expect(issueCalls[1].query).not.toContain("updatedAt:{gte:");
    db.close();
  });

  test("redacted recordings retain production approval classification", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const comments = { data: {
      viewer: { displayName: "Firstmate" },
      comments: { pageInfo: { hasNextPage: false }, nodes: [{
        id: "comment-1", createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z",
        body: "approved", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: { name: "Runtime" } }, parent: null,
      }] },
    } };
    const issues = { data: { issues: { pageInfo: { hasNextPage: false }, nodes: [{
      identifier: "ABC-1", title: "Ship", description: "", createdAt: "2025-12-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z", state: { name: "Approve Deliverable" },
      assignee: { displayName: "Firstmate" }, project: { name: "Runtime" }, creator: { displayName: "Captain" }, labels: { nodes: [{ name: "Agent: Codex" }] },
      history: { pageInfo: { hasNextPage: false }, nodes: [] },
    }] } } };
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify(redactFixture(comments)));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify(redactFixture(issues)));
    const replayConfig: WorkflowConfig = { ...config, teams: config.teams.map((team) => ({ ...team, projects: ["Runtime"] })) };
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));

    const result = await captureCycle({ config: replayConfig, db, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225720" } });

    expect(result.captured).toBe(1);
    expect(db.listEvents()[0]).toMatchObject({ author: "Captain", token: "gate-pass" });
    expect(db.jobs()[0]?.kind).toBe("linear.issue-role");
    expect(db.latestSnapshot("ABC-1")).toMatchObject({ role: "review-gate", managed: true });
    db.close();
  });

  test("captures, classifies, snapshots, and queues a gate job in one cycle", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-");
    roots.push(root);
    const fixtures = join(root, "fixtures");
    mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      comments: { pageInfo: { hasNextPage: false }, nodes: [{
        id: "comment-1", createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z",
        body: "approved", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
      }] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: {
      issues: { pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", description: "", createdAt: "2025-12-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z", state: { name: "Approve Deliverable" },
        assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [] },
      }] },
    } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    const fixtureLog = join(root, "fixture.log");
    const result = await captureCycle({
      config, db, transport: new LinearTransport({ fixtureDir: fixtures, fixtureLog }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225720" },
    });
    expect(result.captured).toBe(1);
    expect(db.listEvents()[0]?.token).toBe("gate-pass");
    expect(db.jobs()[0]?.kind).toBe("linear.issue-role");
    expect(JSON.parse(db.jobs()[0]!.payload)).toMatchObject({ expected_role: "review-gate" });
    expect(db.latestSnapshot("ABC-1")?.role).toBe("review-gate");
    const commentsRequest = JSON.parse(readFileSync(fixtureLog, "utf8").split("\n")[0]!.split("\t")[1]!);
    expect(commentsRequest.query).toContain('updatedAt:{gte:"2025-12-31T22:02:00Z"}');
    db.close();
  });

  test("a periodic full snapshot refresh does not ingest history older than the overlap window", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-");
    roots.push(root);
    const fixtures = join(root, "fixtures");
    mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: {
      issues: { pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", description: "", createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:06:00Z", state: { name: "Building" },
        assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [{
          id: "old-history", createdAt: "2025-01-01T00:00:00Z", actor: { displayName: "Captain" },
          fromState: { name: "Backlog" }, toState: { name: "Building" },
        }] },
      }] },
    } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    db.setCursor("linear.comments", "2026-01-01T00:05:00Z");
    db.setCursor("linear.issues.ABC", "2026-01-01T00:05:00Z");
    const result = await captureCycle({
      config, db, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767226020" },
    });
    expect(result.captured).toBe(0);
    expect(db.listEvents()).toHaveLength(0);
    expect(db.observations("ABC-1")).toContainEqual(expect.objectContaining({
      source: "linear", verb: "board-transition", key: "building", observed_at: "2025-01-01T00:00:00Z",
    }));
    expect(db.latestSnapshot("ABC-1")?.role).toBe("building");
    db.close();
  });

  test("classifies approval against the state at the comment revision", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-");
    roots.push(root);
    const fixtures = join(root, "fixtures");
    mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" },
      comments: { pageInfo: { hasNextPage: false }, nodes: [{
        id: "comment-before-gate", createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z",
        body: "approved", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
      }] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: {
      issues: { pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", description: "", createdAt: "2025-12-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00.123Z", state: { name: "Approve Plan" },
        assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [{
          id: "move-to-gate", createdAt: "2026-01-01T00:01:00.123Z", actor: { displayName: "Captain" },
          fromState: { name: "Building" }, toState: { name: "Approve Plan" },
        }] },
      }] },
    } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    await captureCycle({
      config, db, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225780" },
    });
    const comment = db.listEvents().find((event) => event.type === "comment");
    expect(comment?.token).toBe("comment");
    expect(db.jobs()).toHaveLength(0);
    expect(db.latestSnapshot("ABC-1")?.role).toBe("plan-gate");
    db.close();
  });

  test("persists exact approval for core review when state chronology is ambiguous", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: { pageInfo: { hasNextPage: false }, nodes: [{
        id: "comment-ambiguous", createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z",
        body: "approved", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
      }] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
        state: { name: "Approve Plan" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [{
          id: "same-time-gate", createdAt: "2026-01-01T00:01:00Z", actor: { displayName: "Captain" },
          fromState: { name: "Building" }, toState: { name: "Approve Plan" },
        }] },
      }],
    } } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    const result = await captureCycle({
      config, db, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225780" },
    });
    expect(result.captured).toBe(2);
    const approval = db.listEvents().find((event) => event.type === "comment");
    expect(approval).toMatchObject({ token: "comment", disposition: "waiting-for-core" });
    expect(approval?.note).toContain("chronology is ambiguous");
    expect(db.jobs()).toHaveLength(0);
    expect(db.cursor("linear.comments")).toBe("2026-01-01T00:01:00Z");
    db.close();
  });

  test("an ordinary same-time comment does not wedge capture", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: { pageInfo: { hasNextPage: false }, nodes: [{
        id: "comment-feedback", createdAt: "2026-01-01T00:01:00Z", updatedAt: "2026-01-01T00:01:00Z",
        body: "please revise", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
      }] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
        state: { name: "Approve Plan" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [{
          id: "same-time-gate", createdAt: "2026-01-01T00:01:00Z", actor: { displayName: "Captain" },
          fromState: { name: "Building" }, toState: { name: "Approve Plan" },
        }] },
      }],
    } } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    const result = await captureCycle({ config, db, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225780" } });
    expect(result.captured).toBe(2);
    expect(db.listEvents().find((event) => event.type === "comment")?.token).toBe("ball-returned");
    expect(db.cursor("linear.comments")).toBe("2026-01-01T00:01:00Z");
    db.close();
  });

  test("fractional updates advance whole-second cursors", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: { pageInfo: { hasNextPage: false }, nodes: [{
        id: "fractional-comment", createdAt: "2026-01-01T00:00:00.123Z", updatedAt: "2026-01-01T00:00:00.123Z",
        body: "continue", user: { displayName: "Captain" },
        issue: { identifier: "ABC-1", assignee: { displayName: "Firstmate" }, project: null }, parent: null,
      }] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00.123Z",
        state: { name: "Building" }, assignee: { displayName: "Firstmate" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [] },
      }],
    } } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    db.setCursor("linear.comments", "2026-01-01T00:00:00Z");
    db.setCursor("linear.issues.ABC", "2026-01-01T00:00:00Z");
    db.setCursor("linear.full.ABC", "2026-01-01T00:00:00Z");
    const result = await captureCycle({
      config, db, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225660" },
    });
    expect(result.commentsMax).toBe("2026-01-01T00:00:00.123Z");
    expect(db.cursor("linear.comments")).toBe("2026-01-01T00:00:00.123Z");
    expect(db.cursor("linear.issues.ABC")).toBe("2026-01-01T00:00:00.123Z");
    db.close();
  });

  test("leaving managed scope suppresses later fleet-driven state repair", async () => {
    const root = mkdtempSync("/private/tmp/fml-capture-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-comments.json"), JSON.stringify({ data: {
      viewer: { displayName: "Firstmate" }, comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    } }));
    await Bun.write(join(fixtures, "02-issues.json"), JSON.stringify({ data: { issues: {
      pageInfo: { hasNextPage: false }, nodes: [{
        identifier: "ABC-1", title: "Ship", createdAt: "2025-12-01T00:00:00Z", updatedAt: "2026-01-01T00:02:00Z",
        state: { name: "Building" }, assignee: { displayName: "Someone Else" }, creator: { displayName: "Captain" }, labels: { nodes: [] },
        history: { pageInfo: { hasNextPage: false }, nodes: [] },
      }],
    } } }));
    const db = new StateDatabase(join(root, "state.db"), join(root, "backups"));
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: "Firstmate", last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.linkTask({ task: "task", issue: "ABC-1", role: "primary", worktree: null, harness: null, spawned_at: "2026-01-01T00:00:30Z", torn_down_at: null });
    const done = { id: "obs:scope-exit", source: "status" as const, task: "task", issue: "ABC-1", verb: "done", key: "default", note: null, observed_at: "2026-01-01T00:01:00Z" };
    db.observe(done);

    await captureCycle({
      config, db, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225780" },
    });

    expect(db.latestSnapshot("ABC-1")).toMatchObject({ assignee: "Someone Else", managed: false });
    expect(planMirror(db, config, [done]).actions).toHaveLength(0);
    db.close();
  });
});
