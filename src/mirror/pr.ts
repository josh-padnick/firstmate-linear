import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Observation, observationBelongsToTaskLink, type PromiseSourceWatermarks, type StateDatabase, type TaskLink } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { nowIso } from "../time.ts";
import { sidecarGeneration } from "./generation.ts";

export type PrSnapshot = {
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefOid: string;
  baseRefName: string;
  requiredChecks: Array<{ name: string; state: string }>;
};

export type PrInspect = (url: string) => PrSnapshot;
type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type CommandRunner = (command: string, args: string[], options: { encoding: "utf8"; timeout: number }) => CommandResult;

const runCommand: CommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, options);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
};

function meta(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([^=]+)=(.*)$/.exec(line);
    if (match?.[1]) out[match[1]] = match[2] ?? "";
  }
  return out;
}

function expectedBase(link: TaskLink, values: Record<string, string>): string | null {
  if (values.pr_base) return values.pr_base;
  if (!link.worktree) return null;
  const result = spawnSync("git", ["-C", link.worktree, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) return null;
  return result.stdout.trim().replace(/^origin\//, "") || null;
}

function prSourceIdentity(generation: string | null, url: string, snapshot: PrSnapshot): string {
  const checks = [...snapshot.requiredChecks]
    .map((check) => ({ name: check.name, state: check.state.toLowerCase() }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.state.localeCompare(right.state));
  return `pr:${sha256(JSON.stringify({ generation, url, state: snapshot.state, head: snapshot.headRefOid, base: snapshot.baseRefName, checks }))}`;
}

function prReportedIdentity(generation: string | null, url: string): string {
  return `pr-reported:${sha256(JSON.stringify({ generation, url }))}`;
}

export function capturePrSourceWatermarks(home: string, db: StateDatabase, issue: string, inspect: PrInspect = inspectPr): PromiseSourceWatermarks {
  const watermarks: PromiseSourceWatermarks = {};
  for (const link of db.taskLinks(issue, true).filter((item) => item.role === "primary")) {
    const path = join(home, "state", `${link.task}.meta`);
    const generation = sidecarGeneration(path, "spawn_gen");
    if (!existsSync(path) || (generation && generation === link.blocked_meta_generation)) {
      watermarks[link.lifecycle_id] = { pr: { reported: null, state: null, stateKnown: true } };
      continue;
    }
    const values = meta(path);
    if (!values.pr) {
      watermarks[link.lifecycle_id] = { pr: { reported: null, state: null, stateKnown: true } };
      continue;
    }
    const reported = prReportedIdentity(generation, values.pr);
    watermarks[link.lifecycle_id] = { pr: { reported, state: prSourceIdentity(generation, values.pr, inspect(values.pr)), stateKnown: true } };
  }
  return watermarks;
}

export function inspectPr(url: string, run: CommandRunner = runCommand): PrSnapshot {
  const view = run("gh", ["pr", "view", url, "--json", "state,mergedAt,baseRefName,headRefOid"], { encoding: "utf8", timeout: 20_000 });
  if (view.status !== 0) throw new Error((view.stderr || view.stdout || view.error?.message || "gh pr view failed").trim());
  const checks = run("gh", ["pr", "checks", url, "--required", "--json", "name,state,bucket"], { encoding: "utf8", timeout: 20_000 });
  if (!checks.stdout.trim()) throw new Error((checks.stderr || checks.error?.message || "gh pr checks failed").trim());
  let requiredChecks: Array<{ name: string; state: string }> = [];
  try {
    requiredChecks = (JSON.parse(checks.stdout) as Array<{ name?: string; state?: string; bucket?: string }>).map((item) => ({ name: item.name ?? "check", state: item.bucket ?? item.state ?? "unknown" }));
  } catch { throw new Error("gh pr checks returned malformed JSON"); }
  const data = JSON.parse(view.stdout) as { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt?: string | null; baseRefName: string; headRefOid: string };
  return { state: data.mergedAt ? "MERGED" : data.state, headRefOid: data.headRefOid, baseRefName: data.baseRefName, requiredChecks };
}

function record(db: StateDatabase, observation: Observation, out: Observation[]): void {
  if (db.observe(observation)) out.push(observation);
}

function recordPrState(db: StateDatabase, observation: Observation, link: TaskLink, identity: string, out: Observation[]): void {
  const previous = db.observations(observation.issue)
    .filter((item) => item.source === "pr"
      && item.key === "pr"
      && observationBelongsToTaskLink(item, link)
      && ["pr-green", "pr-withdrawn"].includes(item.verb))
    .at(-1);
  if (previous?.verb === observation.verb && previous.note === observation.note) return;
  record(db, { ...observation, id: `obs:${sha256(`${identity}:${previous?.id ?? "initial"}`)}` }, out);
}

type PrScanResult = { observations: Observation[]; findings: Array<{ code: string; issue: string; detail: string }> };

function scanLinks(home: string, db: StateDatabase, links: TaskLink[], inspect: PrInspect, observedAt: string): PrScanResult {
  const observations: Observation[] = [];
  const findings: Array<{ code: string; issue: string; detail: string }> = [];
  for (const link of links) {
    const path = join(home, "state", `${link.task}.meta`);
    if (!existsSync(path)) continue;
    const generation = sidecarGeneration(path, "spawn_gen");
    if (generation && generation === link.blocked_meta_generation) continue;
    const values = meta(path);
    const url = values.pr;
    const expectedHead = values.pr_head;
    if (!url) continue;
    try {
      const snapshot = inspect(url);
      const sourceIdentity = prSourceIdentity(generation, url, snapshot);
      const reportedIdentity = prReportedIdentity(generation, url);
      const base = expectedBase(link, values);
      const lifecycle = `${link.task}:${link.issue}:${link.lifecycle_id}`;
      record(db, {
        id: `obs:${sha256(`${lifecycle}:${url}:reported`)}`, source: "pr", task: link.task,
        task_spawned_at: link.spawned_at, task_lifecycle_id: link.lifecycle_id, issue: link.issue, verb: "pr-reported", key: "pr", note: url, source_identity: reportedIdentity, observed_at: observedAt,
      }, observations);
      if (snapshot.state === "MERGED" && base && snapshot.baseRefName === base) {
        record(db, {
          id: `obs:${sha256(`${lifecycle}:${url}:${snapshot.headRefOid}:merged:${snapshot.baseRefName}`)}`, source: "pr", task: link.task,
          task_spawned_at: link.spawned_at, task_lifecycle_id: link.lifecycle_id, issue: link.issue, verb: "pr-merged", key: "pr", note: url, source_identity: sourceIdentity, observed_at: observedAt,
        }, observations);
        continue;
      }
      if (snapshot.state === "MERGED" && !base) {
        recordPrState(db, { id: "", source: "pr", task: link.task, task_spawned_at: link.spawned_at, task_lifecycle_id: link.lifecycle_id, issue: link.issue, verb: "pr-withdrawn", key: "pr", note: `${url} base unverified`, source_identity: sourceIdentity, observed_at: observedAt }, link, `${lifecycle}:${url}:${snapshot.headRefOid}:base-unverified`, observations);
        findings.push({ code: "PR_BASE_UNKNOWN", issue: link.issue, detail: `cannot verify expected base for ${url}` });
        continue;
      }
      if (snapshot.state === "MERGED" && snapshot.baseRefName !== base) {
        recordPrState(db, { id: "", source: "pr", task: link.task, task_spawned_at: link.spawned_at, task_lifecycle_id: link.lifecycle_id, issue: link.issue, verb: "pr-withdrawn", key: "pr", note: `${url} base=${snapshot.baseRefName} expected=${base}`, source_identity: sourceIdentity, observed_at: observedAt }, link, `${lifecycle}:${url}:${snapshot.headRefOid}:base-mismatch:${snapshot.baseRefName}`, observations);
        findings.push({ code: "PR_BASE_MISMATCH", issue: link.issue, detail: `${url} merged into ${snapshot.baseRefName}, expected ${base}` });
        continue;
      }
      const green = snapshot.state === "OPEN" && Boolean(expectedHead) && snapshot.headRefOid === expectedHead
        && snapshot.requiredChecks.length > 0
        && snapshot.requiredChecks.every((check) => ["pass", "success", "skipping"].includes(check.state.toLowerCase()));
      recordPrState(db, {
        id: "", source: "pr", task: link.task,
        task_spawned_at: link.spawned_at, task_lifecycle_id: link.lifecycle_id, issue: link.issue, verb: green ? "pr-green" : "pr-withdrawn", key: "pr",
        note: green ? `${url} head=${snapshot.headRefOid}` : `${url} current=${snapshot.headRefOid} expected=${expectedHead ?? "missing"}`,
        source_identity: sourceIdentity, observed_at: observedAt,
      }, link, `${lifecycle}:${url}:${snapshot.headRefOid}:${green ? "green" : "not-green"}`, observations);
    } catch (error) {
      findings.push({ code: "PR_INSPECTION_FAILED", issue: link.issue, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { observations, findings };
}

export function capturePullRequestsAtBoundary(home: string, db: StateDatabase, task: string, observedAt: string, inspect: PrInspect = inspectPr): PrScanResult {
  return scanLinks(home, db, db.taskLinks(undefined, true).filter((link) => link.task === task), inspect, observedAt);
}

export function scanPullRequests(home: string, db: StateDatabase, inspect: PrInspect = inspectPr, env: NodeJS.ProcessEnv = process.env): PrScanResult {
  return scanLinks(home, db, db.taskLinks(undefined, true), inspect, nowIso(env));
}
