import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { captureCycle, eventId, type CaptureCycleResult } from "../capture/cycle.ts";
import { loadConfig } from "../config/load.ts";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { loadKey, resolveHome } from "../env.ts";
import { atomicWriteFile, ensurePrivateDir, lockAcquire, lockRelease, readText } from "../fsutil.ts";
import { processJobs } from "../jobs/worker.ts";
import { runtimePaths } from "../paths.ts";
import { nowEpoch, nowIso, parseIso } from "../time.ts";
import { LinearTransport } from "../transport.ts";
import { createSocketServer } from "./socket.ts";
import { scanFleet } from "../mirror/scan.ts";
import { applyMirrorPlan, planMirror } from "../mirror/plan.ts";
import { inspectPr, scanPullRequests } from "../mirror/pr.ts";
import { applyEscalations } from "../escalation/escalation.ts";
import { applyReviewDeadlines, planReviewDeadlines } from "../review/reconcile.ts";
import { sha256 } from "../hash.ts";
import { reconcileStalls } from "../reconcile/stall.ts";
import { reconcileIdleWorkers } from "../reconcile/idle.ts";
import { reconcileSteers } from "../reconcile/steer.ts";
import { collectHostSamples, reconcileHostHealth } from "../reconcile/host.ts";
import { reconcileVerdicts } from "../reconcile/verdict.ts";

export type ServiceHealth = {
  schema: "fm-linear.health.v1";
  pid: number;
  started_at: string;
  cycle_started_at: string | null;
  cycle_completed_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  captured: number;
  jobs_done: number;
  resumed: boolean;
  mirrorActions: number;
  findings: number;
  escalations: number;
  stalls: number;
};

export type ServiceCycleResult = {
  captured: number;
  jobsDone: number;
  jobsRetried: number;
  jobsDead: number;
  resumed: boolean;
  mirrorActions: number;
  findings: number;
  escalations: number;
  stalls: number;
};

class LinearPollFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "LinearPollFailure";
  }
}

function intervalSeconds(env: NodeJS.ProcessEnv): number {
  const value = Number(env.FM_LINEAR_POLL_INTERVAL_SECONDS ?? 30);
  return Number.isFinite(value) && value >= 5 ? Math.floor(value) : 30;
}

function readHealth(path: string): ServiceHealth | null {
  const text = readText(path);
  if (!text) return null;
  try {
    const value = JSON.parse(text) as ServiceHealth;
    return value.schema === "fm-linear.health.v1" ? value : null;
  } catch { return null; }
}

function writeHealth(path: string, health: ServiceHealth): void {
  atomicWriteFile(path, `${JSON.stringify(health, null, 2)}\n`);
}

function log(path: string, message: string): void {
  appendFileSync(path, `${nowIso()} ${message}\n`, { mode: 0o600 });
}

export function activationActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FM_LINEAR_FORCE_ACTIVE === "1") return true;
  return readText(`${resolveHome(env)}/config/linear-cutover`)?.trim() === "service";
}

function resumeEvent(db: StateDatabase, config: WorkflowConfig, previous: ServiceHealth | null, env: NodeJS.ProcessEnv): boolean {
  const restartReason = db.serviceState("restart_reason");
  if (restartReason) {
    const created = nowIso(env);
    db.observe({
      id: `obs:${sha256(`service-restarted:${restartReason}:${created}`)}`,
      source: "summary", task: "service", issue: "SYSTEM-0", verb: "service-restarted",
      key: "watchdog", note: restartReason, observed_at: created,
    });
    db.raw.query("DELETE FROM service_state WHERE key='restart_reason'").run();
    return true;
  }
  if (!previous?.cycle_completed_at) return false;
  const completed = parseIso(previous.cycle_completed_at);
  if (completed === null || nowEpoch(env) - completed <= intervalSeconds(env) * 2) return false;
  const created = nowIso(env);
  const team = config.teams[0]?.key ?? "SYSTEM";
  const key = `resumed:${previous.cycle_completed_at}:${created}`;
  return db.capture({
    id: eventId(key), team, issue: `${team}-RESUME`, type: "resumed", token: "resumed",
    author: config.captain.display_name, body_sha: null, created_at: created, captured_at: created,
    disposition: "waiting-for-core", note: `service resumed after ${previous.cycle_completed_at}`,
    raw_ref: JSON.stringify({ previous_cycle_completed_at: previous.cycle_completed_at, resumed_at: created }),
  });
}

export async function serviceCycle(options: {
  db: StateDatabase;
  config: WorkflowConfig;
  env?: NodeJS.ProcessEnv;
  transport?: LinearTransport;
  resumed?: boolean;
}): Promise<ServiceCycleResult> {
  const env = options.env ?? process.env;
  if (!activationActive(env)) {
    return { captured: 0, jobsDone: 0, jobsRetried: 0, jobsDead: 0, resumed: false, mirrorActions: 0, findings: 0, escalations: 0, stalls: 0 };
  }
  const skipCapture = env.FM_LINEAR_SKIP_CAPTURE === "1";
  const transport = options.transport ?? new LinearTransport({ apiKey: skipCapture ? "offline-spike" : loadKey(resolveHome(env), env) });
  let capture: CaptureCycleResult = { captured: 0, ignored: 0, waiting: 0, jobs: 0, commentsMax: null, issuesMax: {} };
  if (!skipCapture) {
    try { capture = await captureCycle({ config: options.config, db: options.db, env, transport }); }
    catch (error) { throw new LinearPollFailure(error); }
  }
  const scan = scanFleet(resolveHome(env), options.db, env);
  const pr = env.FM_LINEAR_SKIP_GH ? { observations: [], findings: [] } : scanPullRequests(
    resolveHome(env),
    options.db,
    (url) => inspectPr(url, undefined, options.config.validation),
    env,
  );
  const mirror = planMirror(options.db, options.config, [...scan.observations, ...pr.observations]);
  const verdicts = reconcileVerdicts(options.db, options.config, pr.observations, env);
  const mirrorActions = applyMirrorPlan(options.db, options.config, mirror);
  const review = planReviewDeadlines(resolveHome(env), options.db, options.config, env);
  const reviewActions = applyReviewDeadlines(options.db, options.config, review);
  for (const finding of [...scan.findings.map((item) => ({ ...item, issue: "SYSTEM-0" })), ...pr.findings, ...mirror.findings, ...review.findings]) {
    const task = "task" in finding && typeof finding.task === "string" ? finding.task : "service";
    options.db.observe({
      id: `obs:${sha256(`finding:${finding.code}:${task}:${finding.issue}:${finding.detail}`)}`,
      source: "summary", task, issue: finding.issue, verb: `finding-${finding.code.toLowerCase()}`,
      key: finding.code, note: finding.detail, observed_at: nowIso(env),
    });
  }
  const home = resolveHome(env);
  collectHostSamples(home, options.db, options.config, env);
  const hostHealth = reconcileHostHealth(options.db, options.config, env);
  const idle = reconcileIdleWorkers(home, options.db, options.config, env, hostHealth.degraded);
  const steers = reconcileSteers(home, options.db, options.config, env, hostHealth.degraded);
  const stalls = reconcileStalls(home, options.db, options.config, env, hostHealth.degraded);
  const escalations = applyEscalations(options.db, options.config, env);
  const before = await processJobs({ db: options.db, config: options.config, env, transport });
  const after = await processJobs({ db: options.db, config: options.config, env, transport });
  return {
    captured: capture.captured,
    jobsDone: before.done + after.done,
    jobsRetried: before.retried + after.retried,
    jobsDead: before.dead + after.dead,
    resumed: options.resumed ?? false,
    mirrorActions: mirrorActions + reviewActions,
    findings: scan.findings.length + pr.findings.length + mirror.findings.length + review.findings.length,
    escalations,
    stalls: stalls.emitted + hostHealth.emitted + idle.stalled + steers.stalled + verdicts.stalled,
  };
}

export async function controlProbe(url: string, fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch { return false; }
}

export function watchdogShouldRestart(failures: number, threshold: number, probeSucceeded: boolean): boolean {
  return failures >= threshold && probeSucceeded;
}

export async function runServiceOnce(options: { env?: NodeJS.ProcessEnv; transport?: LinearTransport } = {}): Promise<ServiceCycleResult> {
  const env = options.env ?? process.env;
  let config = loadConfig(env);
  const db = StateDatabase.open(env);
  const paths = runtimePaths(env);
  const previous = readHealth(paths.serviceHealth);
  const resumed = activationActive(env) && resumeEvent(db, config, previous, env);
  const started = nowIso(env);
  try {
    const result = await serviceCycle({ db, config, env, transport: options.transport, resumed });
    writeHealth(paths.serviceHealth, {
      schema: "fm-linear.health.v1", pid: process.pid, started_at: previous?.started_at ?? started,
      cycle_started_at: started, cycle_completed_at: nowIso(env), last_success_at: nowIso(env),
      consecutive_failures: 0, last_error: null, captured: result.captured,
      jobs_done: result.jobsDone, resumed, mirrorActions: result.mirrorActions,
      findings: result.findings, escalations: result.escalations, stalls: result.stalls,
    });
    return result;
  } catch (error) {
    writeHealth(paths.serviceHealth, {
      schema: "fm-linear.health.v1", pid: process.pid, started_at: previous?.started_at ?? started,
      cycle_started_at: started, cycle_completed_at: nowIso(env), last_success_at: previous?.last_success_at ?? null,
      consecutive_failures: (previous?.consecutive_failures ?? 0) + 1,
      last_error: error instanceof Error ? error.message : String(error), captured: 0, jobs_done: 0, resumed,
      mirrorActions: 0, findings: 0, escalations: 0, stalls: 0,
    });
    throw error;
  } finally {
    db.close();
  }
}

export async function runService(env: NodeJS.ProcessEnv = process.env): Promise<never> {
  const paths = runtimePaths(env);
  ensurePrivateDir(paths.root);
  const held = lockAcquire(paths.serviceLock);
  if (held !== "ok") throw new Error(`service singleton lease ${held}`);
  let config = loadConfig(env);
  const db = StateDatabase.open(env);
  const previous = readHealth(paths.serviceHealth);
  const resumed = activationActive(env) && resumeEvent(db, config, previous, env);
  let server: Server;
  try {
    server = createSocketServer(paths.socket, db, () => activationActive(env));
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    db.close();
    lockRelease(paths.serviceLock);
    throw error;
  }

  const cleanup = () => {
    server.close();
    db.close();
    lockRelease(paths.serviceLock);
    try { if (existsSync(paths.socket)) unlinkSync(paths.socket); } catch { /* best effort */ }
  };
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  let first = true;
  let consecutivePollFailures = 0;
  while (true) {
    let delay = intervalSeconds(env);
    const started = nowIso(env);
    const health = readHealth(paths.serviceHealth);
    try {
      config = loadConfig(env);
      const result = await serviceCycle({ db, config, env, resumed: first && resumed });
      writeHealth(paths.serviceHealth, {
        schema: "fm-linear.health.v1", pid: process.pid, started_at: health?.started_at ?? started,
        cycle_started_at: started, cycle_completed_at: nowIso(env), last_success_at: nowIso(env),
        consecutive_failures: 0, last_error: null, captured: result.captured,
        jobs_done: result.jobsDone, resumed: first && resumed, mirrorActions: result.mirrorActions,
        findings: result.findings, escalations: result.escalations, stalls: result.stalls,
      });
      log(paths.serviceLog, `ok captured=${result.captured} jobs=${result.jobsDone} retry=${result.jobsRetried} dead=${result.jobsDead} mirror=${result.mirrorActions} stalls=${result.stalls} escalations=${result.escalations} findings=${result.findings}`);
      consecutivePollFailures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeHealth(paths.serviceHealth, {
        schema: "fm-linear.health.v1", pid: process.pid, started_at: health?.started_at ?? started,
        cycle_started_at: started, cycle_completed_at: nowIso(env), last_success_at: health?.last_success_at ?? null,
        consecutive_failures: (health?.consecutive_failures ?? 0) + 1, last_error: message,
        captured: 0, jobs_done: 0, resumed: first && resumed,
        mirrorActions: 0, findings: 0, escalations: 0, stalls: 0,
      });
      log(paths.serviceLog, `fail ${message}`);
      consecutivePollFailures = error instanceof LinearPollFailure ? consecutivePollFailures + 1 : 0;
      const thresholdReached = consecutivePollFailures >= config.service.poll_failures_before_restart;
      const probeSucceeded = thresholdReached ? await controlProbe(config.service.probe_url) : false;
      if (watchdogShouldRestart(consecutivePollFailures, config.service.poll_failures_before_restart, probeSucceeded)) {
        const reason = `${consecutivePollFailures} consecutive Linear poll failures while control probe succeeded: ${message}`;
        db.setServiceState("restart_reason", reason, nowIso(env));
        log(paths.serviceLog, `watchdog restart ${reason}`);
        cleanup();
        throw new Error(reason);
      }
      if (thresholdReached && !probeSucceeded) delay = Math.min(5 * 60, intervalSeconds(env) * (2 ** Math.min(4, consecutivePollFailures - config.service.poll_failures_before_restart + 1)));
    }
    first = false;
    await Bun.sleep(delay * 1000);
  }
}
