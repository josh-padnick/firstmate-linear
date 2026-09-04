import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testWorkflowConfig } from "../testing/config.ts";
import { StateDatabase } from "../db/database.ts";
import { decideRelay } from "./decide.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = testWorkflowConfig({ features: { relay: "on" } });

describe("relay decision", () => {
  test("a mapped reply goes straight to the one live primary task", () => {
    const home = mkdtempSync("/private/tmp/fml-relay-"); roots.push(home);
    mkdirSync(join(home, "state")); writeFileSync(join(home, "state", "task-1.meta"), "backend=tmux\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task-1", issue: "ABC-1", role: "primary", worktree: null, harness: "claude", spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.snapshot({ issue: "ABC-1", role: "decision-captain", assignee: "Captain", labels: [], agent_label: null, last_actor: null, last_signal: null, observed_at: "2026-01-01T00:00:00Z" });
    db.observe({ id: "o1", source: "status", task: "task-1", issue: "ABC-1", verb: "needs-decision", key: "choice", note: null, observed_at: "2026-01-01T00:00:00Z" });
    const result = decideRelay({ event: { id: "e1", team: "ABC", issue: "ABC-1", type: "comment", author: "Captain", body: "A", created_at: "2026-01-01T00:01:00Z" }, db, config: base, home });
    expect(result.disposition).toBe("classified");
    expect(result.job?.payload).toMatchObject({ task: "task-1", lifecycle_id: db.taskLinks("ABC-1", true)[0]!.lifecycle_id, key: "choice", requires_managed: true });
    db.close();
  });

  test("a replacement task does not inherit unresolved keys from a closed task", () => {
    const home = mkdtempSync("/private/tmp/fml-relay-"); roots.push(home);
    mkdirSync(join(home, "state")); writeFileSync(join(home, "state", "replacement.meta"), "backend=tmux\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "closed", issue: "ABC-1", role: "primary", worktree: null, harness: "claude", spawned_at: "2026-01-01T00:00:00Z", torn_down_at: "2026-01-01T00:01:00Z" });
    db.linkTask({ task: "replacement", issue: "ABC-1", role: "primary", worktree: null, harness: "claude", spawned_at: "2026-01-01T00:02:00Z", torn_down_at: null });
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, observed_at: "2026-01-01T00:02:00Z" });
    db.observe({ id: "closed-key", source: "status", task: "closed", issue: "ABC-1", verb: "needs-decision", key: "obsolete", note: null, observed_at: "2026-01-01T00:01:00Z" });
    const result = decideRelay({ event: { id: "e1", team: "ABC", issue: "ABC-1", type: "comment", author: "Captain", body: "continue", created_at: "2026-01-01T00:03:00Z" }, db, config: base, home });
    expect(result.job?.payload).toMatchObject({ task: "replacement", key: null });
    db.close();
  });

  test("a relinked task does not inherit unresolved keys from its prior lifecycle", () => {
    const home = mkdtempSync("/private/tmp/fml-relay-"); roots.push(home);
    mkdirSync(join(home, "state")); writeFileSync(join(home, "state", "task-1.meta"), "backend=tmux\n");
    const db = new StateDatabase(join(home, "db"), join(home, "backups"));
    db.linkTask({ task: "task-1", issue: "ABC-1", role: "primary", worktree: null, harness: "claude", spawned_at: "2026-01-01T00:00:00Z", torn_down_at: null });
    db.observe({ id: "old-key", source: "status", task: "task-1", issue: "ABC-1", verb: "needs-decision", key: "obsolete", note: null, observed_at: "2026-01-01T00:01:00Z" });
    db.closeTask("task-1", "2026-01-01T00:02:00Z");
    db.linkTask({ task: "task-1", issue: "ABC-1", role: "primary", worktree: null, harness: "claude", spawned_at: "2026-01-01T00:03:00Z", torn_down_at: null });
    db.snapshot({ issue: "ABC-1", role: "building", assignee: "Firstmate", labels: [], agent_label: null, last_actor: null, last_signal: null, observed_at: "2026-01-01T00:03:00Z" });

    const result = decideRelay({ event: { id: "e1", team: "ABC", issue: "ABC-1", type: "comment", author: "Captain", body: "continue", created_at: "2026-01-01T00:04:00Z" }, db, config: base, home });

    expect(result.job?.payload).toMatchObject({ task: "task-1", key: null });
    db.close();
  });
});
