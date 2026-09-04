import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ValidationSource } from "../config/schema.ts";
import { type Observation, observationBelongsToTaskLink, type PromiseSourceWatermarks, type StateDatabase, type TaskLink } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { nowIso } from "../time.ts";
import { sidecarGeneration } from "./generation.ts";

export type PrSnapshot = {
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefOid: string;
  baseRefName: string;
  requiredChecks: Array<{ name: string; state: string }>;
  verdict?: {
    verdict: "auto-mergeable" | "needs-human" | "changes-requested";
    risk: "low" | "medium" | "high" | null;
    reason: string;
    findingsCount?: number;
    reviewers?: string[];
    reviewCost?: number;
    gateConclusion?: string;
    checkName?: string;
    checkConclusions?: Record<string, string>;
    source?: "check" | "labels" | "review";
  };
  changedFiles?: Array<{ path: string; additions: number; deletions: number }>;
  autoMergeArmed?: boolean;
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
  return `pr:${sha256(JSON.stringify({ generation, url, state: snapshot.state, head: snapshot.headRefOid, base: snapshot.baseRefName, checks, verdict: snapshot.verdict ?? null }))}`;
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

export function inspectPr(
  url: string,
  run: CommandRunner = runCommand,
  validation?: { source: ValidationSource; check_name: string; gate_check_name?: string },
): PrSnapshot {
  const view = run("gh", ["pr", "view", url, "--json", "state,mergedAt,baseRefName,headRefOid,statusCheckRollup,files,additions,deletions,autoMergeRequest,labels,reviews"], { encoding: "utf8", timeout: 20_000 });
  if (view.status !== 0) throw new Error((view.stderr || view.stdout || view.error?.message || "gh pr view failed").trim());
  const checks = run("gh", ["pr", "checks", url, "--required", "--json", "name,state,bucket"], { encoding: "utf8", timeout: 20_000 });
  if (!checks.stdout.trim()) throw new Error((checks.stderr || checks.error?.message || "gh pr checks failed").trim());
  let requiredChecks: Array<{ name: string; state: string }> = [];
  try {
    requiredChecks = (JSON.parse(checks.stdout) as Array<{ name?: string; state?: string; bucket?: string }>).map((item) => ({ name: item.name ?? "check", state: item.bucket ?? item.state ?? "unknown" }));
  } catch { throw new Error("gh pr checks returned malformed JSON"); }
  const data = JSON.parse(view.stdout) as any;
  const checksRollup = data.statusCheckRollup ?? [];
  const summaryCheck = checksRollup.find((item: any) => /\bverdict=/.test(item.output?.summary ?? item.summary ?? "")
    && (!validation || validation.source !== "check" || (item.name ?? item.context) === validation.check_name));
  const summary = summaryCheck?.output?.summary ?? summaryCheck?.summary;
  const reviewBody = [...(data.reviews ?? [])].reverse().map((item: any) => item.body ?? "").find((item: string) => /\bverdict=/.test(item));
  const selectedText = validation?.source === "labels" ? ""
    : validation?.source === "review" ? reviewBody
      : validation?.source === "check" ? summary
        : typeof summary === "string" ? summary : reviewBody;
  const text = typeof selectedText === "string" ? selectedText : "";
  const match = /\bverdict=(auto-mergeable|needs-human|changes-requested)\s+risk=(low|medium|high)\s+reason=([^\n]+)/.exec(text);
  const verdictLabel = (data.labels ?? []).map((item: any) => item.name).find((name: string) => /^verdict:/.test(name));
  const riskLabel = (data.labels ?? []).map((item: any) => item.name).find((name: string) => /^risk:/.test(name));
  const labeledVerdict = verdictLabel?.slice("verdict:".length);
  const labeledRisk = riskLabel?.slice("risk:".length);
  const allowedVerdicts = ["auto-mergeable", "needs-human", "changes-requested"];
  const allowedRisks = ["low", "medium", "high"];
  const checkConclusions = Object.fromEntries(checksRollup
    .filter((item: any) => typeof (item.name ?? item.context) === "string")
    .map((item: any) => [item.name ?? item.context, String(item.conclusion ?? item.state ?? "")]));
  const gateCheckName = validation?.gate_check_name ?? "fleet-merge-gate";
  const parsedVerdict = match ? {
    verdict: match[1] as "auto-mergeable" | "needs-human" | "changes-requested",
    risk: match[2] as "low" | "medium" | "high",
    reason: match[3]!.trim(),
    gateConclusion: checksRollup.find((item: any) => (item.name ?? item.context) === gateCheckName)?.conclusion ?? null,
    checkName: summaryCheck?.name ?? summaryCheck?.context,
    checkConclusions,
    source: validation?.source ?? (typeof summary === "string" ? "check" as const : "review" as const),
  } : allowedVerdicts.includes(labeledVerdict) ? {
    verdict: labeledVerdict as "auto-mergeable" | "needs-human" | "changes-requested",
    risk: allowedRisks.includes(labeledRisk) ? labeledRisk as "low" | "medium" | "high" : null,
    reason: "published as PR labels",
    gateConclusion: checksRollup.find((item: any) => (item.name ?? item.context) === gateCheckName)?.conclusion ?? null,
    checkConclusions,
    source: "labels" as const,
  } : undefined;
  const verdict = validation?.source === "labels"
    ? (parsedVerdict?.source === "labels" ? parsedVerdict : undefined)
    : validation?.source === "review"
      ? (parsedVerdict?.source === "review" ? parsedVerdict : undefined)
      : validation?.source === "check"
        ? (parsedVerdict?.source === "check" ? parsedVerdict : undefined)
        : parsedVerdict;
  return {
    state: data.mergedAt ? "MERGED" : data.state,
    headRefOid: data.headRefOid,
    baseRefName: data.baseRefName,
    requiredChecks,
    verdict,
    changedFiles: (data.files ?? []).map((file: any) => ({ path: file.path, additions: Number(file.additions ?? 0), deletions: Number(file.deletions ?? 0) })),
    autoMergeArmed: Boolean(data.autoMergeRequest),
  };
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

type PrMetadata = {
  generation: string | null;
  url: string | null;
  expectedHead: string | null;
  expectedBase: string | null;
  blocked: boolean;
};

type PreparedPrLink = { link: TaskLink; metadata: PrMetadata; snapshot: PrSnapshot | null };

export type PreparedPullRequests = {
  observedAt: string;
  findings: PrScanResult["findings"];
  sourcesValid: () => boolean;
  valid: () => boolean;
  record: (observedAt?: string) => PrScanResult;
};

function prMetadata(home: string, link: TaskLink): PrMetadata {
  const path = join(home, "state", `${link.task}.meta`);
  if (!existsSync(path)) return { generation: null, url: null, expectedHead: null, expectedBase: null, blocked: false };
  const generation = sidecarGeneration(path, "spawn_gen");
  const values = meta(path);
  return {
    generation,
    url: values.pr ?? null,
    expectedHead: values.pr_head ?? null,
    expectedBase: expectedBase(link, values),
    blocked: Boolean(generation && generation === link.blocked_meta_generation),
  };
}

function sameMetadata(left: PrMetadata, right: PrMetadata): boolean {
  return left.generation === right.generation
    && left.url === right.url
    && left.expectedHead === right.expectedHead
    && left.expectedBase === right.expectedBase
    && left.blocked === right.blocked;
}

function prLinkIdentity(link: TaskLink): string {
  return JSON.stringify({
    lifecycleId: link.lifecycle_id,
    task: link.task,
    issue: link.issue,
    role: link.role,
    worktree: link.worktree,
    harness: link.harness,
    host: link.host,
    spawnedAt: link.spawned_at,
    blockedMetaGeneration: link.blocked_meta_generation,
  });
}

function recordPreparedLinks(db: StateDatabase, prepared: PreparedPrLink[], observedAt: string): PrScanResult {
  const observations: Observation[] = [];
  const findings: Array<{ code: string; issue: string; detail: string }> = [];
  for (const { link, metadata, snapshot } of prepared) {
    const { generation, url, expectedHead } = metadata;
    if (metadata.blocked || !url || !snapshot) continue;
    try {
      const sourceIdentity = prSourceIdentity(generation, url, snapshot);
      const reportedIdentity = prReportedIdentity(generation, url);
      const base = metadata.expectedBase;
      const lifecycle = `${link.task}:${link.issue}:${link.lifecycle_id}`;
      record(db, {
        id: `obs:${sha256(`${lifecycle}:${url}:reported`)}`, source: "pr", task: link.task,
        task_spawned_at: link.spawned_at, task_lifecycle_id: link.lifecycle_id, issue: link.issue, verb: "pr-reported", key: "pr", note: url, source_identity: reportedIdentity, observed_at: observedAt,
      }, observations);
      if (snapshot.verdict) {
        const detail = {
          ...snapshot.verdict,
          url,
          headSha: snapshot.headRefOid,
          changedFiles: snapshot.changedFiles ?? [],
          lines: (snapshot.changedFiles ?? []).reduce((sum, file) => sum + file.additions + file.deletions, 0),
          autoMergeArmed: snapshot.autoMergeArmed ?? false,
        };
        const verdictObservation: Observation = {
          id: `obs:${sha256(`${lifecycle}:${url}:${snapshot.headRefOid}:verdict:${JSON.stringify(snapshot.verdict)}`)}`,
          source: "pr", task: link.task, task_spawned_at: link.spawned_at, task_lifecycle_id: link.lifecycle_id,
          issue: link.issue, verb: "verdict", key: snapshot.verdict.verdict, note: JSON.stringify(detail),
          source_identity: sourceIdentity, observed_at: observedAt,
        };
        record(db, verdictObservation, observations);
        db.raw.query(`INSERT OR IGNORE INTO pr_events(id,issue,pr_url,head_sha,verdict,risk,reason,findings_count,reviewers,review_cost,policy_downgrade,observed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,0,?)`).run(
          verdictObservation.id, link.issue, url, snapshot.headRefOid, snapshot.verdict.verdict,
          snapshot.verdict.risk, snapshot.verdict.reason, snapshot.verdict.findingsCount ?? null,
          JSON.stringify(snapshot.verdict.reviewers ?? []), snapshot.verdict.reviewCost ?? null, observedAt,
        );
      }
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

function prepareLinks(home: string, db: StateDatabase, links: TaskLink[], inspect: PrInspect, env: NodeJS.ProcessEnv): PreparedPullRequests {
  const prepared: PreparedPrLink[] = links.map((link) => ({ link, metadata: prMetadata(home, link), snapshot: null }));
  const snapshots = new Map<string, PrSnapshot>();
  const findings: PrScanResult["findings"] = [];
  for (const item of prepared) {
    if (item.metadata.blocked || !item.metadata.url) continue;
    const key = JSON.stringify(item.metadata);
    if (!snapshots.has(key)) {
      try { snapshots.set(key, inspect(item.metadata.url)); }
      catch (error) { findings.push({ code: "PR_INSPECTION_FAILED", issue: item.link.issue, detail: error instanceof Error ? error.message : String(error) }); }
    }
    item.snapshot = snapshots.get(key) ?? null;
  }
  const observedAt = nowIso(env);
  const linkState = links.map(prLinkIdentity).sort().join("\0");
  const sourcesValid = () => prepared.every((item) => sameMetadata(item.metadata, prMetadata(home, item.link)));
  return {
    observedAt,
    findings,
    sourcesValid,
    valid: () => {
      const currentState = db.taskLinks(undefined, true).filter((link) => links.some((item) => item.task === link.task)).map(prLinkIdentity).sort().join("\0");
      return currentState === linkState && sourcesValid();
    },
    record: (at = observedAt) => {
      const recorded = recordPreparedLinks(db, prepared, at);
      return { observations: recorded.observations, findings: [...findings, ...recorded.findings] };
    },
  };
}

export function preparePullRequestsAtBoundary(home: string, db: StateDatabase, task: string, inspect: PrInspect = inspectPr, env: NodeJS.ProcessEnv = process.env): PreparedPullRequests {
  return prepareLinks(home, db, db.taskLinks(undefined, true).filter((link) => link.task === task), inspect, env);
}

export function scanPullRequests(home: string, db: StateDatabase, inspect: PrInspect = inspectPr, env: NodeJS.ProcessEnv = process.env): PrScanResult {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prepared = prepareLinks(home, db, db.taskLinks(undefined, true), inspect, env);
    if (prepared.valid()) return prepared.record();
  }
  return { observations: [], findings: [{ code: "PR_METADATA_CHANGED", issue: "fleet", detail: "PR metadata changed during inspection" }] };
}
