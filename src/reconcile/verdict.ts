import type { WorkflowConfig } from "../config/schema.ts";
import type { Observation, StateDatabase } from "../db/database.ts";
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
    const value = JSON.parse(observation.note ?? "null") as VerdictDetail;
    return value && typeof value.url === "string" && typeof value.verdict === "string" ? value : null;
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

export function reconcileVerdicts(db: StateDatabase, config: WorkflowConfig, observations: Observation[], env: NodeJS.ProcessEnv = process.env): { handled: number; stalled: number } {
  if (config.validation.mode !== "verdict") return { handled: 0, stalled: 0 };
  let handled = 0;
  let stalled = 0;
  const at = nowIso(env);
  for (const observation of observations.filter((item) => item.source === "pr" && item.verb === "verdict")) {
    if (db.latestSnapshot(observation.issue)?.role !== "validating") continue;
    const team = config.teams.find((item) => item.key === observation.issue.split("-")[0]);
    const detail = parseDetail(observation);
    if (!team || !detail) continue;
    if (detail.source && detail.source !== config.validation.source) continue;
    if (detail.source === "check" && detail.checkName && detail.checkName !== config.validation.check_name) continue;
    const policy = detail.verdict === "auto-mergeable" ? policyReason(config, detail) : null;
    const verdict = policy ? "needs-human" : detail.verdict;
    const reason = policy ?? detail.reason;
    const gateConclusion = detail.checkConclusions?.[config.validation.gate_check_name] ?? detail.gateConclusion ?? "";
    const gateGreen = gateConclusion.toLowerCase() === "success";
    if (policy) db.raw.query("UPDATE pr_events SET policy_downgrade=1,reason=? WHERE id=?").run(reason, observation.id);
    if (detail.autoMergeArmed && gateGreen && policy) {
      db.capture({
        id: `linear:${sha256(`policy-disagreement:${observation.id}`)}`, team: team.key, issue: observation.issue,
        type: "verdict", token: "verdict", author: "fm-linear", body_sha: null, created_at: at, captured_at: at,
        disposition: "waiting-for-core", note: `policy-disagreement: ${reason}; captain must review ${detail.url}`,
        raw_ref: JSON.stringify({ kind: "policy-disagreement", required: `review the policy disagreement for ${detail.url}`, ...detail, policy_downgrade: true }),
      });
    }
    if (verdict === "auto-mergeable") {
      if (detail.autoMergeArmed && gateGreen) {
        db.enqueueReconciliation({
          key: `${observation.id}:promise:pr-merged`, kind: "promise.implicit", target: observation.issue,
          payload: { issue: observation.issue, source_event_id: observation.id, expected_event: "pr-merged", deadline: "merge" },
        }, at);
        handled += 1;
        continue;
      }
      const id = `linear:${sha256(`verdict-merge:${observation.id}`)}`;
      db.capture({
        id, team: team.key, issue: observation.issue, type: "verdict", token: "verdict", author: "fm-linear",
        body_sha: null, created_at: at, captured_at: at, disposition: "waiting-for-core",
        note: `required: merge ${detail.url} (auto-mergeable, ${detail.risk ?? "n/a"})`,
        raw_ref: JSON.stringify({ kind: "verdict", ...detail, verdict, required: `merge ${detail.url}` }),
      }, [{
        key: `${id}:promise:pr-merged`, kind: "promise.implicit", target: observation.issue,
        payload: { issue: observation.issue, source_event_id: id, expected_event: "pr-merged", deadline: "merge" },
      }]);
      handled += 1;
      continue;
    }
    if (verdict === "needs-human") {
      const target = team.roles["merge-gate"] ? "merge-gate" : team.roles["review-gate"] ? "review-gate" : null;
      if (target) db.enqueueReconciliation({
        key: `${observation.id}:verdict:${target}`, kind: "linear.issue-role", target: observation.issue,
        payload: {
          issue: observation.issue, role: target, expected_role: "validating", actor: "service", requires_managed: true,
          comment: `validated, green on ${detail.headSha}, risk ${detail.risk ?? "n/a"}; needs your merge word because ${reason}.`,
        },
      }, at);
      handled += 1;
      continue;
    }
    const links = db.taskLinks(observation.issue, true).filter((item) => item.role === "primary");
    db.enqueueReconciliation({
      key: `${observation.id}:verdict:building`, kind: "linear.issue-role", target: observation.issue,
      payload: { issue: observation.issue, role: "building", expected_role: "validating", actor: "service", requires_managed: true },
    }, at);
    if (links.length) {
      db.enqueueReconciliation({
        key: `${observation.id}:findings:${links[0]!.lifecycle_id}`, kind: "fleet.send", target: links[0]!.task,
        payload: { task: links[0]!.task, issue: observation.issue, message: `Validation requested changes on ${detail.url}: ${reason}` },
      }, at);
    } else {
      const id = `linear:${sha256(`verdict-no-worker:${observation.id}`)}`;
      if (db.capture({
        id, team: team.key, issue: observation.issue, type: "stalled", token: "stalled", author: "fm-linear",
        body_sha: null, created_at: at, captured_at: at, disposition: "waiting-for-core",
        note: `stalled ${observation.issue}: validation requested changes but no live primary task exists`,
        raw_ref: JSON.stringify({ kind: "verdict", required: `dispatch a worker to address validation findings for ${detail.url}` }),
      })) stalled += 1;
    }
    handled += 1;
  }
  return { handled, stalled };
}
