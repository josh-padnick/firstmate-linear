import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { resolveHome, resolveStateDir } from "../env.ts";
import { sidecarGeneration, statusCursorValue, statusFileState, statusFileVersion } from "../mirror/generation.ts";
import { inspectPr, preparePullRequestsAtBoundary, type PrInspect } from "../mirror/pr.ts";
import { nowIso } from "../time.ts";
import { optionValue } from "./args.ts";

class BoundaryChanged extends Error {}
class BoundaryRejected extends Error {}

function linkState(db: StateDatabase, task: string): string {
  return db.taskLinks().filter((link) => link.task === task)
    .map((link) => [link.lifecycle_id, link.issue, link.role, link.torn_down_at]).sort().join("\0");
}

export function runTask(args: string[], env: NodeJS.ProcessEnv = process.env, dependencies: { inspectPr?: PrInspect; beforeBoundaryCommit?: (attempt: number) => void } = {}): number {
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
      let committed = false;
      for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
        const lifecycles = db.taskLinks().filter((link) => link.task === task);
        const active = lifecycles.find((link) => link.issue === issue && link.torn_down_at === null);
        const roleChange = Boolean(active && active.role !== role);
        const prepared = roleChange ? preparePullRequestsAtBoundary(resolveHome(env), db, task, dependencies.inspectPr ?? inspectPr, env) : null;
        if (prepared?.findings.length) throw new BoundaryRejected(prepared.findings.map((finding) => finding.detail).join("; "));
        const concurrent = !active && lifecycles.some((link) => link.torn_down_at === null);
        const prior = active ?? (concurrent ? undefined : lifecycles.at(-1));
        const status = statusFileState(statusPath, db.cursor(`status:${statusPath}`));
        const statusIdentity = status?.incarnationIdentity ?? null;
        const statusStartOffset = concurrent ? status?.content.length ?? 0
          : !prior ? 0
            : active || !prior.status_end_identity || prior.status_end_identity === statusIdentity
            ? status?.content.length ?? 0
            : 0;
        const metaGeneration = sidecarGeneration(metaPath, "spawn_gen");
        const busyGeneration = sidecarGeneration(busyPath, "gen");
        const initialLinks = linkState(db, task);
        const spawnedAt = optionValue(args, "--spawned-at") ?? prepared?.observedAt ?? nowIso(env);
        dependencies.beforeBoundaryCommit?.(attempt);
        try {
          db.transaction(() => {
            if (linkState(db, task) !== initialLinks || (prepared && !prepared.valid())) throw new BoundaryChanged();
            const recorded = prepared?.record(spawnedAt);
            if (recorded?.findings.length) throw new BoundaryRejected(recorded.findings.map((finding) => finding.detail).join("; "));
            db.linkTask({
              task, issue, role, worktree: optionValue(args, "--worktree"), harness: optionValue(args, "--harness"),
              spawned_at: spawnedAt, torn_down_at: null,
              status_start_offset: statusStartOffset, status_start_identity: statusIdentity,
              meta_generation: metaGeneration, busy_generation: busyGeneration,
              blocked_meta_generation: roleChange ? metaGeneration : prior?.meta_generation ?? null,
              blocked_busy_generation: roleChange ? busyGeneration : prior?.busy_generation ?? null,
            });
            if (statusFileVersion(statusFileState(statusPath, db.cursor(`status:${statusPath}`))) !== statusFileVersion(status)
              || sidecarGeneration(metaPath, "spawn_gen") !== metaGeneration
              || sidecarGeneration(busyPath, "gen") !== busyGeneration
              || (prepared && !prepared.sourcesValid())) throw new BoundaryChanged();
            if (status?.needsPersistence) db.setCursor(`status:${statusPath}`, statusCursorValue(status, 0));
          });
          committed = true;
        } catch (error) {
          if (!(error instanceof BoundaryChanged) || attempt === 2) throw error;
        }
      }
      process.stdout.write(`fm-linear task: linked ${task} -> ${issue} (${role})\n`);
      return 0;
    }
    if (sub === "close") {
      const task = args[1];
      if (!task) return 2;
      const state = resolveStateDir(resolveHome(env), env);
      const statusPath = join(state, `${task}.status`);
      const metaPath = join(state, `${task}.meta`);
      const busyPath = join(state, `${task}.busy-state`);
      let committed = false;
      for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
        const prepared = preparePullRequestsAtBoundary(resolveHome(env), db, task, dependencies.inspectPr ?? inspectPr, env);
        if (prepared.findings.length) throw new BoundaryRejected(prepared.findings.map((finding) => finding.detail).join("; "));
        const status = statusFileState(statusPath, db.cursor(`status:${statusPath}`));
        const metaGeneration = sidecarGeneration(metaPath, "spawn_gen");
        const busyGeneration = sidecarGeneration(busyPath, "gen");
        const initialLinks = linkState(db, task);
        dependencies.beforeBoundaryCommit?.(attempt);
        try {
          db.transaction(() => {
            if (linkState(db, task) !== initialLinks || !prepared.valid()) throw new BoundaryChanged();
            const recorded = prepared.record();
            if (recorded.findings.length) throw new BoundaryRejected(recorded.findings.map((finding) => finding.detail).join("; "));
            db.closeTask(task, prepared.observedAt, {
              statusOffset: status?.content.length ?? 0,
              statusIdentity: status?.incarnationIdentity ?? null,
              metaGeneration,
              busyGeneration,
            });
            if (statusFileVersion(statusFileState(statusPath, db.cursor(`status:${statusPath}`))) !== statusFileVersion(status)
              || sidecarGeneration(metaPath, "spawn_gen") !== metaGeneration
              || sidecarGeneration(busyPath, "gen") !== busyGeneration
              || !prepared.sourcesValid()) throw new BoundaryChanged();
            if (status?.needsPersistence) db.setCursor(`status:${statusPath}`, statusCursorValue(status, 0));
          });
          committed = true;
        } catch (error) {
          if (!(error instanceof BoundaryChanged) || attempt === 2) throw error;
        }
      }
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
  } catch (error) {
    if (error instanceof BoundaryChanged) process.stderr.write("fm-linear task: lifecycle inputs did not stabilize\n");
    else if (error instanceof BoundaryRejected) process.stderr.write(`fm-linear task: ${error.message}\n`);
    else throw error;
    return 1;
  } finally { db.close(); }
}
