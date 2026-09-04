import type { WorkflowConfig } from "../config/schema.ts";
import type { Observation, StateDatabase, TaskLink } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { nowIso } from "../time.ts";

type VerdictDetail = {
  verdict: "auto-mergeable" | "needs-human" | "changes-requested";
  risk: "low" | "medium" | "high" | null;
  reason: string;
  url: string;
  headSha: string;
  changedFiles: Array<{ path: string; additions: number; deletions: number }>;
  lines: number;
  autoMergeArmed: boolean;
  gateConclusion?: string;
  checkName?: string;
  checkConclusions?: Record<string, string>;
  source?: "check" | "labels" | "review";
};

function parseDetail(observation: Observation): VerdictDetail | null {
  try {
    const value = JSON.parse(observation.note ?? "null") as Partial<VerdictDetail> | null;
    if (!value || !["auto-mergeable", "needs-human", "changes-requested"].includes(value.verdict ?? "")) return null;
    if (value.risk !== null && !["low", "medium", "high"].includes(value.risk ?? "")) return null;
    if (![value.reason, value.url, value.headSha].every((item) => typeof item === "string" && item.length > 0)) return null;
    if (!Array.isArray(value.changedFiles) || value.changedFiles.some((file) => !file || typeof file.path !== "string"
      || !Number.isSafeInteger(file.additions) || file.additions < 0
      || !Number.isSafeInteger(file.deletions) || file.deletions < 0)) return null;
    if (!Number.isSafeInteger(value.lines) || value.lines! < 0 || typeof value.autoMergeArmed !== "boolean") return null;
    if (value.gateConclusion !== undefined && typeof value.gateConclusion !== "string") return null;
    if (value.checkName !== undefined && typeof value.checkName !== "string") return null;
    if (value.source !== undefined && !["check", "labels", "review"].includes(value.source)) return null;
    if (value.checkConclusions !== undefined && (!value.checkConclusions || typeof value.checkConclusions !== "object"
      || Array.isArray(value.checkConclusions) || Object.values(value.checkConclusions).some((item) => typeof item !== "string"))) return null;
    return value as VerdictDetail;
  } catch { return null; }
}

function glob(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`).test(path);
}

export function policyReason(config: WorkflowConfig, detail: VerdictDetail): string | null {
  const path = detail.changedFiles.find((file) => config.merge.never_auto_paths.some((pattern) => glob(pattern, file.path)))?.path;
  if (path) return `policy: ${path}`;
  if (detail.lines > config.merge.max_auto_lines) return `policy: ${detail.lines} changed lines exceeds ${config.merge.max_auto_lines}`;
  return null;
}

type ActiveVerdict = {
  observation: Observation;
  detail: VerdictDetail;
  link: TaskLink;
  policy: string | null;
};

function validationBoundary(db: StateDatabase, issue: string, links: TaskLink[]): string {
  const snapshots = db.snapshots(issue);
  let currentStart = snapshots.length - 1;
  while (currentStart > 0 && snapshots[currentStart - 1]?.role === "validating") currentStart -= 1;
  let priorValidation = currentStart - 1;
  while (priorValidation >= 0 && snapshots[priorValidation]?.role !== "validating") priorValidation -= 1;
  if (priorValidation >= 0) return snapshots[priorValidation + 1]!.observed_at;
  return links.map((link) => link.spawned_at).sort()[0] ?? snapshots[currentStart]?.observed_at ?? "";
}

function currentPrHead(db: StateDatabase, issue: string, lifecycleId: string, url: string): string | null {
  const observations = db.observations(issue)
    .filter((item) => item.source === "pr" && item.task_lifecycle_id === lifecycleId);
  const reported = observations.filter((item) => item.verb === "pr-reported").at(-1);
  if (reported?.note !== url) return null;
  const state = observations
    .filter((item) => item.source === "pr" && item.task_lifecycle_id === lifecycleId
      && ["pr-green", "pr-withdrawn", "pr-merged"].includes(item.verb)
      && (item.note === url || item.note?.startsWith(`${url} `)))
    .at(-1);
  if (state?.verb !== "pr-green" || !state.note) return null;
  return /(?:head|current)=([^\s]+)/.exec(state.note)?.[1] ?? null;
}

function configuredVerdict(config: WorkflowConfig, observation: Observation): VerdictDetail | null {
  const detail = parseDetail(observation);
  if (!detail || (detail.source && detail.source !== config.validation.source)) return null;
  if (detail.source === "check" && detail.checkName && detail.checkName !== config.validation.check_name) return null;
  return detail;
}

export function reconcileVerdicts(db: StateDatabase, config: WorkflowConfig, observations: Observation[], env: NodeJS.ProcessEnv = process.env): { handled: number; stalled: number } {
  if (config.validation.mode !== "verdict" || config.features.mirror !== "on") return { handled: 0, stalled: 0 };
  let handled = 0;
  let stalled = 0;
  const at = nowIso(env);
  const allVerdicts = [...db.observations(), ...observations]
    .filter((item) => item.source === "pr" && item.verb === "verdict");
  for (const snapshot of db.latestSnapshots().filter((item) => item.role === "validating")) {
    const links = db.taskLinks(snapshot.issue, true).filter((item) => item.role === "primary");
    if (!links.length) continue;
    const boundary = validationBoundary(db, snapshot.issue, links);
    const byLifecycle = new Map<string, ActiveVerdict>();
    for (const observation of allVerdicts) {
      const link = links.find((item) => item.lifecycle_id === observation.task_lifecycle_id && item.task === observation.task);
      if (!link || observation.observed_at < boundary || observation.observed_at < link.spawned_at) continue;
      const detail = configuredVerdict(config, observation);
      if (!detail || currentPrHead(db, snapshot.issue, link.lifecycle_id, detail.url) !== detail.headSha) continue;
      const prior = byLifecycle.get(link.lifecycle_id);
      if (!prior || observation.observed_at >= prior.observation.observed_at) {
        byLifecycle.set(link.lifecycle_id, {
          observation, detail, link,
          policy: detail.verdict === "auto-mergeable" ? policyReason(config, detail) : null,
        });
      }
    }
    const team = config.teams.find((item) => item.key === snapshot.issue.split("-")[0]);
    if (!team) continue;
    const available = links.flatMap((link) => {
      const candidate = byLifecycle.get(link.lifecycle_id);
      return candidate ? [candidate] : [];
    });
    const aggregateIdentity = (candidates: ActiveVerdict[]) => sha256(JSON.stringify({
      issue: snapshot.issue,
      boundary,
      lifecycles: candidates.map((item) => item.link.lifecycle_id),
      verdicts: candidates.map((item) => item.observation.id),
    }));
    const changesRequested = available.filter((item) => item.detail.verdict === "changes-requested");
    if (changesRequested.length) {
      const aggregateId = aggregateIdentity(changesRequested);
      const handledKey = `verdict-aggregate-handled:${aggregateId}`;
      if (db.serviceState(handledKey)) continue;
      db.enqueueReconciliation({
        key: `verdict-aggregate:${aggregateId}:building`, kind: "linear.issue-role", target: snapshot.issue,
        payload: { issue: snapshot.issue, role: "building", expected_role: "validating", actor: "service", requires_managed: true },
      }, at);
      for (const candidate of changesRequested) {
        db.enqueueReconciliation({
          key: `verdict-aggregate:${aggregateId}:findings:${candidate.link.lifecycle_id}`,
          kind: "fleet.send", target: candidate.link.task,
          payload: {
            task: candidate.link.task, issue: snapshot.issue, lifecycle_id: candidate.link.lifecycle_id,
            message: `Validation requested changes on ${candidate.detail.url}: ${candidate.detail.reason}`,
          },
        }, at);
      }
      db.setServiceState(handledKey, at, at);
      handled += available.length;
      continue;
    }
    if (byLifecycle.size !== links.length) continue;
    const candidates = links.map((link) => byLifecycle.get(link.lifecycle_id)!);
    const aggregateId = aggregateIdentity(candidates);
    const handledKey = `verdict-aggregate-handled:${aggregateId}`;
    if (db.serviceState(handledKey)) continue;
    for (const candidate of candidates.filter((item) => item.policy)) {
      db.raw.query("UPDATE pr_events SET policy_downgrade=1,reason=? WHERE id=?")
        .run(candidate.policy, candidate.observation.id);
      if (candidate.detail.autoMergeArmed
        && candidate.detail.checkConclusions?.[config.validation.gate_check_name]?.toLowerCase() === "success") {
        db.capture({
          id: `linear:${sha256(`policy-disagreement:${candidate.observation.id}`)}`,
          team: team.key, issue: snapshot.issue, type: "verdict", token: "verdict", author: "fm-linear",
          body_sha: null, created_at: at, captured_at: at, disposition: "waiting-for-core",
          note: `policy-disagreement: ${candidate.policy}; captain must review ${candidate.detail.url}`,
          raw_ref: JSON.stringify({
            kind: "policy-disagreement", required: `review the policy disagreement for ${candidate.detail.url}`,
            ...candidate.detail, policy_downgrade: true,
          }),
        });
      }
    }
    const needsHuman = candidates.filter((item) => item.detail.verdict === "needs-human" || item.policy);
    if (needsHuman.length) {
      const target = team.roles["merge-gate"] ? "merge-gate" : team.roles["review-gate"] ? "review-gate" : null;
      const reasons = needsHuman.map((item) => item.policy ?? item.detail.reason).join("; ");
      if (target) {
        db.enqueueReconciliation({
          key: `verdict-aggregate:${aggregateId}:${target}`, kind: "linear.issue-role", target: snapshot.issue,
          payload: {
            issue: snapshot.issue, role: target, expected_role: "validating", actor: "service", requires_managed: true,
            comment: `Validation needs your merge word because ${reasons}.`,
          },
        }, at);
      } else {
        const id = `linear:${sha256(`verdict-needs-human:${aggregateId}`)}`;
        db.capture({
          id, team: team.key, issue: snapshot.issue, type: "verdict", token: "verdict", author: "fm-linear",
          body_sha: null, created_at: at, captured_at: at, disposition: "waiting-for-core",
          note: `validation needs human review: ${reasons}`,
          raw_ref: JSON.stringify({ kind: "verdict-needs-human", required: "review the validation verdicts", reasons }),
        });
      }
      db.setServiceState(handledKey, at, at);
      handled += candidates.length;
      continue;
    }
    const unsafe = candidates.filter((item) => item.detail.checkConclusions?.[config.validation.gate_check_name]?.toLowerCase() !== "success");
    if (unsafe.length) {
      const id = `linear:${sha256(`verdict-gate-wait:${aggregateId}`)}`;
      db.capture({
        id, team: team.key, issue: snapshot.issue, type: "verdict", token: "verdict", author: "fm-linear",
        body_sha: null, created_at: at, captured_at: at, disposition: "waiting-for-core",
        note: `validation found all active PRs auto-mergeable, but ${config.validation.gate_check_name} is not successful for every PR`,
        raw_ref: JSON.stringify({ kind: "verdict-gate-wait", required: `make ${config.validation.gate_check_name} successful for every active PR` }),
      });
      db.setServiceState(handledKey, at, at);
      handled += candidates.length;
      continue;
    }
    for (const candidate of candidates) {
      if (candidate.detail.autoMergeArmed) {
        db.enqueueReconciliation({
          key: `${candidate.observation.id}:promise:pr-merged`, kind: "promise.implicit", target: snapshot.issue,
          payload: { issue: snapshot.issue, source_event_id: candidate.observation.id, expected_event: "pr-merged", deadline: "merge" },
        }, at);
        continue;
      }
      const id = `linear:${sha256(`verdict-merge:${candidate.observation.id}`)}`;
      db.capture({
        id, team: team.key, issue: snapshot.issue, type: "verdict", token: "verdict", author: "fm-linear",
        body_sha: null, created_at: at, captured_at: at, disposition: "waiting-for-core",
        note: `required: merge ${candidate.detail.url} (auto-mergeable, ${candidate.detail.risk ?? "n/a"})`,
        raw_ref: JSON.stringify({ kind: "verdict", ...candidate.detail, required: `merge ${candidate.detail.url}` }),
      }, [{
        key: `${id}:promise:pr-merged`, kind: "promise.implicit", target: snapshot.issue,
        payload: { issue: snapshot.issue, source_event_id: id, expected_event: "pr-merged", deadline: "merge" },
      }]);
    }
    db.setServiceState(handledKey, at, at);
    handled += candidates.length;
  }
  return { handled, stalled };
}
