import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { WorkflowConfig } from "../config/schema.ts";
import type { StateDatabase, SteerRecord } from "../db/database.ts";
import { formatIso, nowEpoch, parseIso } from "../time.ts";
import { emitStall } from "./stall.ts";

function recipientEvidence(db: StateDatabase, steer: SteerRecord): string | null {
  const observation = db.observations(steer.issue ?? undefined, steer.sent_at)
    .find((item) => item.task === steer.task && (item.source === "status" || item.source === "summary"));
  return observation?.observed_at ?? null;
}

function handledLocally(steer: SteerRecord): boolean {
  if (existsSync(steer.record_path)) return false;
  return existsSync(join(dirname(steer.record_path), "handled", basename(steer.record_path)));
}

function recordMessage(path: string): string | null {
  try {
    const contents = readFileSync(path, "utf8");
    const separator = contents.indexOf("\n--\n");
    return separator >= 0 ? contents.slice(separator + 4) : null;
  } catch { return null; }
}

function lifecycleAt(db: StateDatabase, task: string, sentAt: string) {
  const sent = parseIso(sentAt);
  if (sent === null) return null;
  const candidates = db.taskLinks().filter((link) => {
    if (link.task !== task) return false;
    const spawned = parseIso(link.spawned_at);
    const closed = link.torn_down_at ? parseIso(link.torn_down_at) : null;
    return spawned !== null && spawned <= sent && (closed === null || sent <= closed);
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export type RemoteSteerProbe = (steer: SteerRecord, home: string, env: NodeJS.ProcessEnv) => "acknowledged" | "unacknowledged" | "failed";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const probeRemoteSteer: RemoteSteerProbe = (steer, home, env) => {
  const handled = join(dirname(steer.record_path), "handled", basename(steer.record_path));
  const state = dirname(dirname(steer.record_path));
  const status = join(state, `${steer.task}.status`);
  const turnEnded = join(state, `${steer.task}.turn-ended`);
  const busyState = join(state, `${steer.task}.busy-state`);
  const sentEpoch = parseIso(steer.sent_at) ?? 0;
  const script = [
    `ls -ld ${shellQuote(steer.record_path)} ${shellQuote(handled)} ${shellQuote(status)} ${shellQuote(turnEnded)} ${shellQuote(busyState)} >/dev/null 2>&1 || true`,
    `if test ! -e ${shellQuote(steer.record_path)} && test -e ${shellQuote(handled)}; then echo acknowledged; exit 0; fi`,
    `for file in ${shellQuote(status)} ${shellQuote(turnEnded)} ${shellQuote(busyState)}; do if test -e "$file"; then stamp=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null || echo 0); if test "$stamp" -gt ${sentEpoch}; then echo acknowledged; exit 0; fi; fi; done`,
    "echo unacknowledged",
  ].join("; ");
  const fmOn = join(env.FM_ROOT_OVERRIDE?.trim() || home, "bin", "fm-on.sh");
  const result = spawnSync(fmOn, [steer.home, "sh", "-c", script], {
    encoding: "utf8", timeout: 20_000, env: { ...process.env, ...env, FM_HOME: home },
  });
  if (result.status !== 0) return "failed";
  return result.stdout.trim().split(/\s+/).includes("acknowledged") ? "acknowledged" : "unacknowledged";
};

export function discoverLocalSteers(home: string, db: StateDatabase): number {
  const state = join(home, "state");
  let names: string[] = [];
  try { names = readdirSync(state); } catch { return 0; }
  let found = 0;
  for (const name of names.filter((item) => item.endsWith(".inbox"))) {
    const task = name.slice(0, -".inbox".length);
    const directory = join(state, name);
    let records: string[] = [];
    try { records = readdirSync(directory).filter((item) => item !== "handled" && !item.startsWith(".")); } catch { continue; }
    for (const record of records) {
      const path = join(directory, record);
      const sentAt = statSync(path).mtime.toISOString().replace(/\.\d{3}Z$/, "Z");
      const link = lifecycleAt(db, task, sentAt);
      const issue = link?.issue ?? null;
      const before = db.steers().length;
      db.recordSteer({ issue, home: "local", task, record_path: path, message: recordMessage(path), lifecycle_id: link?.lifecycle_id ?? null, sent_at: sentAt });
      if (db.steers().length > before) found += 1;
    }
  }
  return found;
}

export function reconcileSteers(home: string, db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env, degradedHosts: ReadonlySet<string> = new Set(), remoteProbe: RemoteSteerProbe = probeRemoteSteer): { acked: number; redelivered: number; stalled: number } {
  discoverLocalSteers(home, db);
  const now = nowEpoch(env);
  const at = formatIso(now);
  let acked = 0;
  let redelivered = 0;
  let stalled = 0;
  for (const steer of db.steers(true)) {
    if (steer.lifecycle_id && !db.taskLinks(steer.issue ?? undefined, true)
      .some((link) => link.lifecycle_id === steer.lifecycle_id && link.task === steer.task)) {
      db.acknowledgeSteer(steer.id, at);
      continue;
    }
    const evidence = recipientEvidence(db, steer);
    let remoteEvidence = false;
    if (steer.home !== "local") {
      const checkedKey = `steer-remote-checked:${steer.id}`;
      const lastChecked = parseIso(db.serviceState(checkedKey) ?? "") ?? 0;
      if (now - lastChecked >= config.deadlines.steer.remote_check) {
        const probe = remoteProbe(steer, home, env);
        db.setServiceState(checkedKey, at, at);
        remoteEvidence = probe === "acknowledged";
        if (probe === "failed" && !db.serviceState(`steer-remote-failed:${steer.home}`)) {
          process.stderr.write(`fm-linear: remote steer acknowledgement check failed for ${steer.home}; stalled detection remains active\n`);
          db.setServiceState(`steer-remote-failed:${steer.home}`, at, at);
        }
      }
    }
    if (evidence || remoteEvidence || (steer.home === "local" && handledLocally(steer))) {
      db.acknowledgeSteer(steer.id, evidence ?? at);
      acked += 1;
      continue;
    }
    if (!steer.lifecycle_id) continue;
    const sent = parseIso(steer.sent_at);
    if (sent === null) continue;
    if (degradedHosts.has(steer.home)) {
      db.updateSteer(steer.id, { waitingOnHost: true });
      continue;
    }
    if (steer.waiting_on_host) db.updateSteer(steer.id, { waitingOnHost: false });
    const age = now - sent;
    if (age >= config.deadlines.steer.redeliver && !steer.redelivered_at) {
      db.enqueue({
        key: `${steer.id}:redeliver`, kind: "fleet.send", target: steer.task,
        payload: {
          task: steer.task, issue: steer.issue ?? "SYSTEM-0", home: steer.home, record_path: steer.record_path,
          delivery_id: steer.delivery_id, lifecycle_id: steer.lifecycle_id,
          message: steer.message ?? `An earlier fm-linear steer is still unacknowledged. Read ${steer.record_path} and act on it.`,
        },
      }, at);
      db.updateSteer(steer.id, { redeliveredAt: at });
      if (steer.home !== "local") {
        const ring = db.raw.query("SELECT installed_at,last_error FROM remote_rings WHERE home=?").get(steer.home) as { installed_at: string | null; last_error: string | null } | null;
        if ((!ring?.installed_at || ring.last_error) && !db.serviceState(`steer-ring-degraded:${steer.home}`)) {
          process.stderr.write(`fm-linear: no working alternate inbox ring for ${steer.home}; stalled detection remains active\n`);
          db.setServiceState(`steer-ring-degraded:${steer.home}`, at, at);
        }
      }
      redelivered += 1;
    }
    if (age < config.deadlines.steer.stalled) continue;
    const issue = steer.home === "local" && steer.issue
      ? steer.issue
      : `SYSTEM-STEER-${steer.home.replace(/[^A-Za-z0-9]/g, "-")}`;
    const multiple = Math.max(1, Math.floor(age / config.deadlines.steer.stalled));
    const reasonKey = steer.home === "local" ? `steer:${steer.id}:${multiple}` : `steer-host:${steer.home}:${multiple}`;
    const result = emitStall(db, {
      team: issue.includes("-") ? issue.split("-")[0]! : "SYSTEM", issue,
      reasonKey, seriesKey: `steer-host:${steer.home}`,
      stalledAt: formatIso(sent + config.deadlines.steer.stalled),
      note: `stalled ${issue}: steer to ${steer.home}/${steer.task} unacknowledged since ${steer.sent_at}; doorbell may not be landing`,
      required: `submit directly with ${join(home, "bin", "fm-on.sh")} ${steer.home} fm-send ${steer.task}`,
      kind: "steer", progress: null, at,
    });
    if (result.captured) stalled += 1;
    db.updateSteer(steer.id, { stalledEventId: result.id });
  }
  return { acked, redelivered, stalled };
}
