import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { activationActive, serviceCycle } from "./service.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const statuses = { backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting", plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building", validating_code: "Validating Code", approve_deliverable: "Approve Deliverable", needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision", done: "Done", canceled: "Canceled", duplicate: "Duplicate" } as const;
const config: WorkflowConfig = { version: 1, captain: { display_name: "Captain" }, teams: [{ key: "ABC", projects: [], managed: "all", statuses: { ...statuses }, agent_labels: {} }], features: { relay: "on", mirror: "on", escalation: "on" }, templates: { reply: "", report: "", review_walkthrough: "" }, sourcePath: "test" };

describe("service activation", () => {
  test("installation is inert until cutover is enabled", async () => {
    const root = mkdtempSync("/private/tmp/fml-service-"); roots.push(root);
    const env = { FM_HOME: root };
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "would-write", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "do not send" } });
    expect(activationActive(env)).toBe(false);
    const result = await serviceCycle({ db, config, env });
    expect(result).toMatchObject({ captured: 0, jobsDone: 0, mirrorActions: 0, escalations: 0 });
    expect(db.jobs()[0]?.state).toBe("pending");
    db.close();
  });

  test("missing-link findings retain each task identity", async () => {
    const root = mkdtempSync("/private/tmp/fml-service-"); roots.push(root);
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", "alpha.meta"), "model=test\n");
    writeFileSync(join(root, "state", "beta.meta"), "model=test\n");
    const env = { FM_HOME: root, FM_LINEAR_FORCE_ACTIVE: "1", FM_LINEAR_SKIP_CAPTURE: "1", FM_LINEAR_SKIP_GH: "1" };
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    await serviceCycle({ db, config, env });
    expect(db.observations("SYSTEM-0").filter((item) => item.key === "TASK_WITHOUT_LINK").map((item) => item.task).sort()).toEqual(["alpha", "beta"]);
    db.close();
  });
});
