import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { resolveHome, resolveStateDir } from "../env.ts";
import { sidecarGeneration, statusCursorValue, statusFileState } from "../mirror/generation.ts";
import { capturePullRequestsAtBoundary, inspectPr, type PrInspect } from "../mirror/pr.ts";
import { nowIso } from "../time.ts";
import { optionValue } from "./args.ts";

export function runTask(args: string[], env: NodeJS.ProcessEnv = process.env, dependencies: { inspectPr?: PrInspect } = {}): number {
  const sub = args[0];
  const db = StateDatabase.open(env);
  try {
    if (sub === "link") {
      const task = args[1];
      const issue = args[2];
      const role = optionValue(args, "--role") ?? "primary";
      if (!task || !issue || (role !== "primary" && role !== "support")) {
        process.stderr.write("Usage: fm-linear task link TASK ISSUE [--role primary|support] [--worktree path] [--harness name]\n");
        return 2;
      }
      const state = resolveStateDir(resolveHome(env), env);
      const statusPath = join(state, `${task}.status`);
      const metaPath = join(state, `${task}.meta`);
      const busyPath = join(state, `${task}.busy-state`);
      const lifecycles = db.taskLinks().filter((link) => link.task === task);
      const active = lifecycles.find((link) => link.issue === issue && link.torn_down_at === null);
      const prior = active ?? (lifecycles.some((link) => link.torn_down_at === null) ? undefined : lifecycles.at(-1));
      const status = statusFileState(statusPath, db.cursor(`status:${statusPath}`));
      const statusIdentity = status?.incarnationIdentity ?? null;
      const statusStartOffset = !prior ? 0
        : active || !prior.status_end_identity || prior.status_end_identity === statusIdentity
          ? status?.content.length ?? 0
          : 0;
      const metaGeneration = sidecarGeneration(metaPath, "spawn_gen");
      const busyGeneration = sidecarGeneration(busyPath, "gen");
      const roleChange = Boolean(active && active.role !== role);
      const spawnedAt = optionValue(args, "--spawned-at") ?? nowIso(env);
      if (roleChange) {
        const capture = capturePullRequestsAtBoundary(resolveHome(env), db, task, spawnedAt, dependencies.inspectPr ?? inspectPr);
        if (capture.findings.length) {
          for (const finding of capture.findings) process.stderr.write(`fm-linear task: ${finding.detail}\n`);
          return 1;
        }
      }
      db.transaction(() => {
        if (status?.needsPersistence) db.setCursor(`status:${statusPath}`, statusCursorValue(status, 0));
        db.linkTask({
          task, issue, role, worktree: optionValue(args, "--worktree"), harness: optionValue(args, "--harness"),
          spawned_at: spawnedAt, torn_down_at: null,
          status_start_offset: statusStartOffset, status_start_identity: statusIdentity,
          meta_generation: metaGeneration, busy_generation: busyGeneration,
          blocked_meta_generation: roleChange ? metaGeneration : prior?.meta_generation ?? null,
          blocked_busy_generation: roleChange ? busyGeneration : prior?.busy_generation ?? null,
        });
      });
      process.stdout.write(`fm-linear task: linked ${task} -> ${issue} (${role})\n`);
      return 0;
    }
    if (sub === "close") {
      const task = args[1];
      if (!task) return 2;
      const state = resolveStateDir(resolveHome(env), env);
      const statusPath = join(state, `${task}.status`);
      const status = statusFileState(statusPath, db.cursor(`status:${statusPath}`));
      const closedAt = nowIso(env);
      const capture = capturePullRequestsAtBoundary(resolveHome(env), db, task, closedAt, dependencies.inspectPr ?? inspectPr);
      if (capture.findings.length) {
        for (const finding of capture.findings) process.stderr.write(`fm-linear task: ${finding.detail}\n`);
        return 1;
      }
      db.transaction(() => {
        if (status?.needsPersistence) db.setCursor(`status:${statusPath}`, statusCursorValue(status, 0));
        db.closeTask(task, closedAt, {
          statusOffset: status?.content.length ?? 0,
          statusIdentity: status?.incarnationIdentity ?? null,
          metaGeneration: sidecarGeneration(join(state, `${task}.meta`), "spawn_gen"),
          busyGeneration: sidecarGeneration(join(state, `${task}.busy-state`), "gen"),
        });
      });
      process.stdout.write(`fm-linear task: closed ${task}\n`);
      return 0;
    }
    if (sub === "list") {
      for (const link of db.taskLinks(undefined, args.includes("--active"))) {
        process.stdout.write(`${link.task}\t${link.issue}\t${link.role}\t${link.harness ?? "-"}\t${link.torn_down_at ?? "active"}\n`);
      }
      return 0;
    }
    process.stderr.write("Usage: fm-linear task link|close|list\n");
    return 2;
  } finally { db.close(); }
}
