import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { LinearTransport } from "../transport.ts";
import { captureCycle } from "./cycle.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const config: WorkflowConfig = {
  version: 1,
  captain: { display_name: "Captain" },
  teams: [{
    key: "ABC", projects: [], managed: "assignee:self", agent_labels: {},
    statuses: {
      backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting",
      plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building",
      validating_code: "Validating Code", approve_deliverable: "Approve Deliverable",
      needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision",
      done: "Done", canceled: "Canceled", duplicate: "Duplicate",
    },
  }],
  features: { relay: "shadow", mirror: "shadow", escalation: "shadow" },
  templates: { reply: "reply.md", report: "report.md", review_walkthrough: "review.html" },
  sourcePath: "test.yaml",
};

describe("SQLite capture cycle", () => {
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
    const result = await captureCycle({
      config, db, transport: new LinearTransport({ fixtureDir: fixtures }),
      env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225720" },
    });
    expect(result.captured).toBe(1);
    expect(db.listEvents()[0]?.token).toBe("approval");
    expect(db.jobs()[0]?.kind).toBe("linear.issue-state");
    expect(JSON.parse(db.jobs()[0]!.payload)).toMatchObject({ expected_state: "Approve Deliverable" });
    expect(db.latestSnapshot("ABC-1")?.state).toBe("Approve Deliverable");
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
    expect(db.latestSnapshot("ABC-1")?.state).toBe("Building");
    db.close();
  });
});
