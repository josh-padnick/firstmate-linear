import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { WorkflowConfig } from "../config/schema.ts";
import type { HostSample, StateDatabase } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { formatIso, nowEpoch, parseIso } from "../time.ts";
import { emitStall } from "./stall.ts";

export type HostHealthResult = { degraded: Set<string>; emitted: number; cleared: number };

function topProcesses(): string[] {
  const result = spawnSync("sh", ["-c", "ps -axo command | awk 'NF {print $1, $2}' | sort | uniq -c | sort -rn | head -5"], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
}

export function configuredRemoteHosts(home: string): string[] {
  const path = join(home, "data", "secondmates.md");
  if (!existsSync(path)) return [];
  const names = new Set<string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^-\s+[A-Za-z0-9._-]+\s+-\s+.+\(host:\s*([A-Za-z0-9._-]+);\s*root:/i.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

function parseRemoteSample(host: string, text: string, at: string): HostSample | null {
  try {
    const value = JSON.parse(text) as { load1: number; cores: number; free_mb: number; top_processes?: string[] };
    if (![value.load1, value.cores, value.free_mb].every(Number.isFinite) || value.cores <= 0) return null;
    return { host, observed_at: at, load1: value.load1, cores: value.cores, free_mb: value.free_mb, top_processes: JSON.stringify(value.top_processes ?? []) };
  } catch { return null; }
}

export function remoteSampleScript(): string {
  const program = [
    "import collections,json,os,re,subprocess",
    "vm=subprocess.check_output(['vm_stat'],text=True)",
    "page=int((re.search(r'page size of (\\d+)',vm) or [None,'4096'])[1])",
    "fields={m.group(1):int(m.group(2)) for m in re.finditer(r'^([^:]+):\\s+(\\d+)\\.',vm,re.M)}",
    "free=(fields.get('Pages free',0)+fields.get('Pages inactive',0))*page/1048576",
    "commands=subprocess.check_output(['ps','-axo','command'],text=True).splitlines()[1:]",
    "families=collections.Counter(' '.join(line.split()[:2]) for line in commands if line.split())",
    "top=[f'{count} {name}' for name,count in families.most_common(5)]",
    "print(json.dumps({'load1':os.getloadavg()[0],'cores':os.cpu_count() or 1,'free_mb':free,'top_processes':top}))",
  ].join("\n");
  const encoded = Buffer.from(program, "utf8").toString("base64");
  return `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
}

export function collectHostSamples(home: string, db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): HostSample[] {
  const now = nowEpoch(env);
  const at = formatIso(now);
  const out: HostSample[] = [];
  const due = (host: string): boolean => now - (parseIso(db.serviceState(`host-sampled:${host}`) ?? "") ?? 0) >= config.hosts.check_interval;
  if (due("local")) {
    out.push({ host: "local", observed_at: at, load1: loadavg()[0] ?? 0, cores: availableParallelism(), free_mb: freemem() / 1024 / 1024, top_processes: JSON.stringify(topProcesses()) });
  }
  const fmOn = join(env.FM_ROOT_OVERRIDE?.trim() || home, "bin", "fm-on.sh");
  for (const host of configuredRemoteHosts(home)) {
    if (!due(host)) continue;
    const result = spawnSync(fmOn, [host, "sh", "-c", remoteSampleScript()], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ...env, FM_HOME: home } });
    const sample = result.status === 0 ? parseRemoteSample(host, result.stdout, at) : null;
    if (sample) out.push(sample);
  }
  for (const sample of out) {
    db.recordHostSample(sample);
    db.setServiceState(`host-sampled:${sample.host}`, at, at);
  }
  return out;
}

function unhealthy(sample: HostSample, config: WorkflowConfig): boolean {
  return sample.load1 / sample.cores > config.hosts.load_factor || sample.free_mb < config.hosts.min_free_mb;
}

function formatTop(sample: HostSample): string {
  try { return (JSON.parse(sample.top_processes) as string[]).join(", ") || "unavailable"; }
  catch { return "unavailable"; }
}

export function reconcileHostHealth(db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): HostHealthResult {
  const now = nowEpoch(env);
  const at = formatIso(now);
  const hosts = new Set((db.raw.query("SELECT DISTINCT host FROM host_samples").all() as Array<{ host: string }>).map((row) => row.host));
  const degraded = new Set<string>();
  let emitted = 0;
  let cleared = 0;
  for (const host of hosts) {
    const samples = db.hostSamples(host);
    const latest = samples.at(-1);
    if (!latest) continue;
    const cutoff = now - config.hosts.window;
    const before = samples.filter((sample) => (parseIso(sample.observed_at) ?? 0) < cutoff).at(-1);
    const recent = [...(before ? [before] : []), ...samples.filter((sample) => (parseIso(sample.observed_at) ?? 0) >= cutoff)];
    const spansWindow = recent.length > 0 && (parseIso(recent[0]!.observed_at) ?? now) <= now - config.hosts.window;
    const sustained = spansWindow && recent.every((sample) => unhealthy(sample, config));
    const state = db.raw.query("SELECT * FROM host_states WHERE host=?").get(host) as { degraded_at: string | null; recovery_started_at: string | null; cleared_at: string | null; signature: string | null; event_id: string | null } | null;
    if (sustained) {
      degraded.add(host);
      const ratioMultiple = Math.max(1, Math.floor((latest.load1 / latest.cores) / config.hosts.load_factor));
      const memoryMultiple = Math.max(1, Math.floor(config.hosts.min_free_mb / Math.max(1, latest.free_mb)));
      const signature = `${formatTop(latest).split(",")[0]}:${Math.max(ratioMultiple, memoryMultiple)}`;
      const issue = `SYSTEM-HOST-${sha256(host).slice(0, 8)}`;
      let eventId = state?.event_id ?? null;
      if (!state?.degraded_at || state.signature !== signature) {
        const result = emitStall(db, {
          team: "SYSTEM", issue, reasonKey: `host:${host}:${signature}`, seriesKey: `host:${host}`,
          stalledAt: recent[0]!.observed_at,
          note: `stalled host ${host}: load ${latest.load1.toFixed(1)}/${latest.cores} cores, ${Math.round(latest.free_mb)} MB free for ${Math.floor(config.hosts.window / 60)}m; top: ${formatTop(latest)}`,
          required: `identify and stop orphaned processes on ${host}; do not resubmit steers until load is below ${config.hosts.load_factor * latest.cores}`,
          kind: "host", progress: null, at,
        });
        eventId = result.id;
        if (result.captured) emitted += 1;
      }
      db.raw.query(`INSERT INTO host_states(host,degraded_at,recovery_started_at,cleared_at,signature,event_id)
        VALUES(?,?,NULL,NULL,?,?) ON CONFLICT(host) DO UPDATE SET degraded_at=COALESCE(host_states.degraded_at,excluded.degraded_at),recovery_started_at=NULL,cleared_at=NULL,signature=excluded.signature,event_id=excluded.event_id`)
        .run(host, state?.degraded_at ?? recent[0]!.observed_at, signature, eventId);
      continue;
    }
    if (!state?.degraded_at || state.cleared_at) continue;
    if (unhealthy(latest, config)) {
      degraded.add(host);
      continue;
    }
    const recovery = state.recovery_started_at ?? latest.observed_at;
    if (!state.recovery_started_at) db.raw.query("UPDATE host_states SET recovery_started_at=? WHERE host=?").run(recovery, host);
    if (now - (parseIso(recovery) ?? now) < config.hosts.window) {
      degraded.add(host);
      continue;
    }
    db.raw.query("UPDATE host_states SET degraded_at=NULL,recovery_started_at=NULL,cleared_at=? WHERE host=?").run(at, host);
    if (state.event_id && db.event(state.event_id)?.disposition === "waiting-for-core") db.setDisposition(state.event_id, "handled-by-service", `host ${host} recovered`, at);
    db.releaseHeldSteers(host);
    cleared += 1;
  }
  return { degraded, emitted, cleared };
}
