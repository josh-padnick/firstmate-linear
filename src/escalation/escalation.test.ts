import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import { planEscalations } from "./escalation.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("legacy approval events retain the five-minute escalation deadline", () => {
  const root = mkdtempSync("/private/tmp/fml-escalation-"); roots.push(root);
  const db = new StateDatabase(join(root, "db"), join(root, "backups"));
  for (const [index, token] of ["plan-approved", "approval"].entries()) {
    db.capture({
      id: `event:${token}`, team: "ABC", issue: `ABC-${index + 1}`, type: "comment", token,
      author: "Captain", body_sha: null, created_at: "2026-01-01T12:00:00Z", captured_at: "2026-01-01T12:00:00Z",
      disposition: "waiting-for-core", note: null, raw_ref: "{}",
    });
  }
  const plan = planEscalations(db, testWorkflowConfig(), { FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:06:00Z") / 1000) });
  expect(plan.map((item) => item.issue).sort()).toEqual(["ABC-1", "ABC-2"]);
  db.close();
});
