import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { resolveHome, resolveStateDir } from "../env.ts";
import { fileIncarnation, sidecarGeneration } from "../mirror/generation.ts";
import { nowIso } from "../time.ts";
import { optionValue } from "./args.ts";

export function runTask(args: string[], env: NodeJS.ProcessEnv = process.env): number {
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
      const prior = db.taskLinks().filter((link) => link.task === task).at(-1);
      const statusStartOffset = prior && existsSync(statusPath) ? statSync(statusPath).size : 0;
      const statusIdentity = fileIncarnation(statusPath);
      const metaGeneration = sidecarGeneration(metaPath, "spawn_gen");
      const busyGeneration = sidecarGeneration(busyPath, "gen");
      db.linkTask({
        task, issue, role, worktree: optionValue(args, "--worktree"), harness: optionValue(args, "--harness"),
        spawned_at: optionValue(args, "--spawned-at") ?? nowIso(env), torn_down_at: null,
        status_start_offset: statusStartOffset, status_start_identity: statusIdentity,
        meta_generation: metaGeneration, busy_generation: busyGeneration,
        blocked_meta_generation: prior?.meta_generation ?? null,
        blocked_busy_generation: prior?.busy_generation ?? null,
      });
      process.stdout.write(`fm-linear task: linked ${task} -> ${issue} (${role})\n`);
      return 0;
    }
    if (sub === "close") {
      const task = args[1];
      if (!task) return 2;
      const state = resolveStateDir(resolveHome(env), env);
      const statusPath = join(state, `${task}.status`);
      db.closeTask(task, nowIso(env), {
        statusOffset: existsSync(statusPath) ? statSync(statusPath).size : 0,
        statusIdentity: fileIncarnation(statusPath),
        metaGeneration: sidecarGeneration(join(state, `${task}.meta`), "spawn_gen"),
        busyGeneration: sidecarGeneration(join(state, `${task}.busy-state`), "gen"),
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
