import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { transcriptTail } from "./transcript.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("Claude transcript tail selects only the session in the task window", () => {
  const root = mkdtempSync("/private/tmp/fml-transcript-"); roots.push(root);
  const userHome = join(root, "user");
  const worktree = "/code/reused";
  const sessions = join(userHome, ".claude", "projects", "-code-reused"); mkdirSync(sessions, { recursive: true });
  const old = join(sessions, "old.jsonl"); writeFileSync(old, "old session\n");
  const current = join(sessions, "current.jsonl"); writeFileSync(current, "one\ntwo\nthree\n");
  utimesSync(old, new Date("2026-01-01T10:00:00Z"), new Date("2026-01-01T10:00:00Z"));
  utimesSync(current, new Date("2026-01-01T12:10:00Z"), new Date("2026-01-01T12:10:00Z"));
  const db = new StateDatabase(join(root, "db"), join(root, "backups"));
  db.linkTask({ task: "worker", issue: "ABC-1", role: "primary", worktree, harness: "claude", spawned_at: "2026-01-01T12:00:00Z", torn_down_at: "2026-01-01T12:20:00Z" });
  const tail = transcriptTail(db, "ABC-1", 2, { FM_LINEAR_USER_HOME: userHome, FM_LINEAR_NOW_EPOCH: String(Date.parse("2026-01-01T12:30:00Z") / 1000) });
  expect(tail).toContain("two\nthree");
  expect(tail).not.toContain("old session");
  db.close();
});
