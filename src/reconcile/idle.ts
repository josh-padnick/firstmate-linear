import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import type { StateDatabase, TaskLink } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { statusFileState } from "../mirror/generation.ts";
import { formatIso, nowEpoch, parseIso } from "../time.ts";
import { parseStatusLine } from "../mirror/scan.ts";
import { emitStall } from "./stall.ts";

const TERMINAL = new Set(["done", "failed", "blocked", "needs-decision", "paused"]);

function fileTime(path: string): string | null {
  try { return statSync(path).mtime.toISOString().replace(/\.\d{3}Z$/, "Z"); }
  catch { return null; }
}

function busyState(path: string): "busy" | "idle" | "unknown" {
  try {
    const match = /\bstate=(busy|idle)\b/.exec(readFileSync(path, "utf8"));
    return match?.[1] === "busy" ? "busy" : match?.[1] === "idle" ? "idle" : "unknown";
  } catch { return "unknown"; }
}

function pendingInbox(home: string, task: string): boolean {
  const path = join(home, "state", `${task}.inbox`);
  try { return readdirSync(path).some((name) => name !== "handled" && !name.startsWith(".")); }
  catch { return false; }
}

function lastStatus(path: string): { verb: string | null; offset: number; identity: string | null; at: string | null } {
  if (!existsSync(path)) return { verb: null, offset: 0, identity: null, at: null };
  const state = statusFileState(path, null);
  const lines = state?.content.toString("utf8").split(/\r?\n/).filter(Boolean) ?? [];
  const parsed = lines.length ? parseStatusLine(lines.at(-1)!) : null;
  return {
    verb: parsed?.verb ?? null,
    offset: state?.content.length ?? 0,
    identity: state?.incarnationIdentity ?? null,
    at: fileTime(path),
  };
}

export function proxyStatusLine(path: string, line: string, alreadyProxied: boolean): void {
  if (alreadyProxied) throw new Error("proxy status line already written for this idle episode");
  if (!/^blocked\s+\[key=idle\]\s+\[service\]:\s+\S/.test(line)) {
    throw new Error("proxyStatusLine permits only blocked [key=idle] [service]");
  }
  appendFileSync(path, `${line.replace(/\n+$/g, "")}\n`, { mode: 0o600 });
}

function episodeId(link: TaskLink, turnEndedAt: string, identity: string | null, offset: number): string {
  return `idle:${sha256(`${link.lifecycle_id}:${turnEndedAt}:${identity ?? "none"}:${offset}`)}`;
}

export function reconcileIdleWorkers(home: string, db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env, degradedHosts: ReadonlySet<string> = new Set()): { nudged: number; proxied: number; stalled: number } {
  const now = nowEpoch(env);
  const at = formatIso(now);
  let nudged = 0;
  let proxied = 0;
  let stalled = 0;
  const active = db.taskLinks(undefined, true).filter((link) => link.role === "primary");
  const activeLifecycles = new Set(active.map((link) => link.lifecycle_id));
  for (const episode of db.openIdleEpisodes()) {
    if (!activeLifecycles.has(episode.lifecycle_id)) db.updateIdleEpisode(episode.id, "closed_at", at);
  }
  for (const link of active) {
    const host = link.host ?? "local";
    if (degradedHosts.has(host)) continue;
    const stateDir = join(home, "state");
    const statusPath = join(stateDir, `${link.task}.status`);
    const turnPath = join(stateDir, `${link.task}.turn-ended`);
    const turnEndedAt = fileTime(turnPath);
    if (!turnEndedAt) continue;
    const turnEpoch = parseIso(turnEndedAt);
    if (turnEpoch === null || now - turnEpoch < config.deadlines.idle.silent) continue;
    const status = lastStatus(statusPath);
    if (status.at && (parseIso(status.at) ?? 0) >= turnEpoch) continue;
    if (status.verb && TERMINAL.has(status.verb)) continue;
    if (pendingInbox(home, link.task)) continue;
    const busy = busyState(join(stateDir, `${link.task}.busy-state`));
    if (busy === "busy") continue;
    const spawned = parseIso(link.spawned_at) ?? now;
    if (busy === "unknown" && now - Math.max(turnEpoch, spawned) < config.deadlines.idle.unknown_grace) continue;
    const id = episodeId(link, turnEndedAt, status.identity, status.offset);
    let episode = db.idleEpisode(id) ?? db.createIdleEpisode({
      id, issue: link.issue, task: link.task, lifecycle_id: link.lifecycle_id,
      turn_ended_at: turnEndedAt, status_identity: status.identity, status_offset: status.offset,
    });
    if (!episode.nudged_at) {
      db.enqueue({
        key: `${id}:nudge`, kind: "fleet.send", target: link.task,
        payload: {
          task: link.task, issue: link.issue, home: host, lifecycle_id: link.lifecycle_id,
          message: config.messages.idle_nudge, idle_episode_id: id,
        },
      }, at);
      db.updateIdleEpisode(id, "nudged_at", at);
      nudged += 1;
      continue;
    }
    const nudgeEpoch = parseIso(episode.nudged_at);
    if (nudgeEpoch === null || now - nudgeEpoch < config.deadlines.idle.after_nudge) continue;
    const current = lastStatus(statusPath);
    const latestTurn = fileTime(turnPath);
    if (current.identity !== episode.status_identity || current.offset > episode.status_offset || latestTurn !== episode.turn_ended_at) {
      db.updateIdleEpisode(id, "closed_at", at);
      continue;
    }
    episode = db.idleEpisode(id)!;
    if (episode.proxied_at) continue;
    const line = `blocked [key=idle] [service]: idle since ${episode.turn_ended_at}, nudged ${episode.nudged_at}, no response`;
    proxyStatusLine(statusPath, line, false);
    db.updateIdleEpisode(id, "proxied_at", at);
    proxied += 1;
    const result = emitStall(db, {
      team: link.issue.split("-")[0] ?? "SYSTEM", issue: link.issue,
      reasonKey: `idle:${id}`, seriesKey: `idle:${link.lifecycle_id}`,
      stalledAt: at, note: `stalled ${link.issue}: ${link.task} stopped without a report after an idle nudge`,
      required: `inspect ${link.task} and either resume it or dispatch replacement work`, kind: "idle", progress: null, at,
    });
    if (result.captured) stalled += 1;
  }
  return { nudged, proxied, stalled };
}
