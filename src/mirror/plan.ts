import type { WorkflowConfig, WorkflowRole } from "../config/schema.ts";
import { type NewJob, type Observation, observationBelongsToTaskLink, type StateDatabase } from "../db/database.ts";
import { compareIso } from "../time.ts";
import { sha256 } from "../hash.ts";
import { foldSignals, reduceTaskState, type TaskSignal } from "./reducer.ts";
import { resolveSignalRole } from "../workflow/roles.ts";

export type MirrorAction = { issue: string; cause: string; description: string; job: NewJob };
export type MirrorFinding = { code: string; issue: string; detail: string };

function signal(verb: string): TaskSignal | null {
  if (["working", "dispatch", "model-resolved", "pr-reported"].includes(verb)) return "working";
  if (verb === "needs-decision") return "needs-decision";
  if (verb === "blocked") return "blocked";
  if (verb === "failed") return "failed";
  if (verb === "done") return "done";
  if (verb === "resolved") return "resolved";
  return null;
}

function modelFrom(observation: Observation): string {
  const match = observation.note?.match(/(?:model=|model\s+)([A-Za-z0-9._-]+)/i);
  return match?.[1]?.toLowerCase() ?? "unknown";
}

export function planMirror(db: StateDatabase, config: WorkflowConfig, newObservations: Observation[]): { actions: MirrorAction[]; findings: MirrorFinding[] } {
  const actions: MirrorAction[] = [];
  const findings: MirrorFinding[] = [];
  const issues = [...new Set([
    ...newObservations.map((item) => item.issue),
    ...db.taskLinks(undefined, true).map((item) => item.issue),
  ])];
  const laneCap = Number(process.env.FM_LINEAR_LANE_CAP ?? 8);
  for (const issue of issues) {
    const teamKey = issue.slice(0, issue.indexOf("-")).toUpperCase();
    const team = config.teams.find((item) => item.key === teamKey);
    const snapshot = db.latestSnapshot(issue);
    if (!team || !snapshot) {
      findings.push({ code: "MISSING_SNAPSHOT", issue, detail: "cannot mirror without a current managed issue snapshot" });
      continue;
    }
    if (!snapshot.managed) continue;
    const activeLinks = db.taskLinks(issue, true);
    const relevant = db.observations(issue)
      .filter((item) => item.task === null || activeLinks.some((link) => observationBelongsToTaskLink(item, link)));
    const currentNewObservations = newObservations
      .filter((item) => item.issue === issue && (item.task === null || activeLinks.some((link) => observationBelongsToTaskLink(item, link))));
    const latest = relevant.at(-1);
    if (!latest) continue;
    const links = new Map(activeLinks.map((link) => [link.task, link.role]));
    const primary = new Set([...links].filter(([, role]) => role === "primary").map(([task]) => task));
    const primaryObservations = relevant.filter((item) => item.task !== null && primary.has(item.task));
    const latestPrimary = primaryObservations.at(-1);
    if (snapshot.last_actor === config.captain.display_name && (!latestPrimary || (compareIso(latestPrimary.observed_at, snapshot.observed_at) ?? -1) <= 0)) {
      findings.push({ code: "CAPTAIN_DRAG", issue, detail: `captain set ${snapshot.role ?? "an unmapped status"}; no newer fleet signal permits repair` });
      continue;
    }
    const taskSignals: Array<{ task: string; role: "primary" | "support"; signal: TaskSignal; key?: string }> = [
      ...[...primary].map((task) => ({ task, role: "primary" as const, signal: "working" as const, key: "default" })),
      ...relevant
      .map((item) => ({ item, signal: signal(item.verb) }))
      .filter((row): row is { item: Observation; signal: TaskSignal } => row.signal !== null && row.item.task !== null && links.has(row.item.task))
      .map((row) => ({ task: row.item.task!, role: links.get(row.item.task!)!, signal: row.signal, key: row.item.key })),
    ];
    const latestPrByTask = new Map<string, Observation>();
    for (const observation of primaryObservations) {
      if (["pr-green", "pr-withdrawn", "pr-merged"].includes(observation.verb)) latestPrByTask.set(observation.task!, observation);
    }
    for (const [task, observation] of latestPrByTask) {
      taskSignals.push({ task, role: "primary", signal: observation.verb === "pr-merged" ? "done" : observation.verb === "pr-green" ? "review-ready" : "working", key: "pr" });
    }
    const reduced = primary.size > 0 && latestPrimary ? reduceTaskState(foldSignals(taskSignals)) : null;
    let cause = latestPrimary ?? latest;
    let target: WorkflowRole | null = null;
    let stayReason: string | null = null;
    if (reduced === "needs-decision") {
      const openDecisions = new Map<string, Observation>();
      for (const observation of primaryObservations) {
        const decisionKey = `${observation.task}\0${observation.key}`;
        if (observation.verb === "resolved") openDecisions.delete(decisionKey);
        if (observation.verb === "needs-decision") {
          openDecisions.delete(decisionKey);
          openDecisions.set(decisionKey, observation);
        }
      }
      cause = [...openDecisions.values()].at(-1) ?? cause;
      const resolution = resolveSignalRole(team, "needs-decision");
      if (resolution.kind === "move") target = resolution.role;
      else stayReason = "Worker needs a captain decision, but decision-captain is unmapped.";
    } else if (reduced === "blocked" || reduced === "failed") {
      const resolution = resolveSignalRole(team, reduced);
      if (resolution.kind === "move") target = resolution.role;
      else stayReason = `Worker reported ${reduced}, but decision-firstmate is unmapped.`;
    }
    else if (latestPrimary?.verb === "dispatch") {
      const building = db.latestSnapshots().filter((item) => {
        const snapshotTeam = item.issue.slice(0, item.issue.indexOf("-")).toUpperCase();
        return item.managed && snapshotTeam === team.key && item.role === "building";
      }).length;
      const dispatch = resolveSignalRole(team, building >= laneCap ? "lane-cap" : "dispatch");
      target = dispatch.kind === "move" ? dispatch.role : null;
      if (dispatch.kind === "stay") stayReason = building >= laneCap ? "Lane cap reached, but waiting is unmapped." : null;
    } else if (latestPrimary?.verb === "dispatch-scout") {
      const resolution = resolveSignalRole(team, "dispatch-scout");
      target = resolution.kind === "move" ? resolution.role : null;
      if (resolution.kind === "stay") stayReason = "Scout dispatched, but neither plan nor building is mapped.";
    } else if (latestPrimary?.verb === "lane-cap") {
      const resolution = resolveSignalRole(team, "lane-cap");
      target = resolution.kind === "move" ? resolution.role : null;
      if (resolution.kind === "stay") stayReason = "Lane cap reached, but waiting is unmapped.";
    }
    else if (reduced === "done") {
      target = "done";
      cause = primaryObservations.filter((item) => item.verb === "pr-merged").at(-1) ?? cause;
    } else if (reduced === "review-ready") {
      if (snapshot.role === "validating" && config.validation.mode === "verdict") continue;
      const preferred: WorkflowRole | null = snapshot.role === "validating" && config.validation.mode === "word"
        ? (team.roles["merge-gate"] ? "merge-gate" : team.roles["review-gate"] ? "review-gate" : null)
        : team.roles["review-gate"] ? "review-gate"
          : team.roles["merge-gate"] ? "merge-gate"
            : team.roles.validating ? "validating" : null;
      target = preferred;
      if (!preferred) stayReason = "PR is green; no review-gate, merge-gate, or validating role is mapped.";
      cause = primaryObservations.filter((item) => item.verb === "pr-green").at(-1) ?? cause;
    }
    else if (reduced === "working") target = "building";

    for (const observation of currentNewObservations.filter((item) => item.verb === "pr-reported")) {
      const url = observation.note?.match(/https:\/\/\S+/)?.[0];
      if (url) actions.push({ issue, cause: observation.id, description: `attach ${url}`, job: { key: `${observation.id}:attachment`, kind: "linear.attachment", target: issue, payload: { issue, url, title: "Pull request", requires_managed: true } } });
    }
    const newModels = currentNewObservations.filter((item) => item.verb === "model-resolved" && item.task !== null && primary.has(item.task));
    const labelCauses = newModels.length > 0
      ? newModels.map((observation) => ({ cause: observation, model: observation }))
      : latestPrimary?.verb === "dispatch"
        ? [{ cause: latestPrimary, model: [...primaryObservations].reverse().find((item) => item.verb === "model-resolved") ?? latestPrimary }]
        : [];
    for (const { cause: labelCause, model: modelObservation } of labelCauses) {
      const model = modelFrom(modelObservation);
      const label = team.agent_labels[model] ?? team.agent_labels.unknown;
      if (!team.agent_labels[model]) findings.push({ code: "UNKNOWN_MODEL", issue, detail: `unmapped model ${model}; using unknown` });
      if (label) actions.push({ issue, cause: labelCause.id, description: `set agent label ${label}`, job: { key: `${labelCause.id}:agent-label:${label}`, kind: "linear.agent-label", target: issue, payload: { issue, label, known_labels: Object.values(team.agent_labels), requires_managed: true } } });
    }
    if (stayReason) {
      actions.push({
        issue,
        cause: cause.id,
        description: `stay in ${snapshot.role ?? "unmapped status"}; ${stayReason}`,
        job: {
          key: `${cause.id}:stay-comment:${sha256(stayReason)}`,
          kind: "linear.comment",
          target: issue,
          payload: { issue, body: stayReason, actor: "service", requires_managed: true },
        },
      });
    }
    if (target && target !== snapshot.role) {
      const decision = cause.verb === "needs-decision";
      const decisionLink = decision ? activeLinks.find((link) => link.task === cause.task) : null;
      actions.push({
        issue,
        cause: cause.id,
        description: `${snapshot.role ?? "unmapped status"} -> ${target}`,
        job: {
          key: `${cause.id}:role:${target}`,
          kind: "linear.issue-role",
          target: issue,
          payload: {
            issue,
            role: target,
            expected_role: snapshot.role,
            cause_observation: cause.id,
            actor: "service",
            requires_managed: true,
            comment: decision ? cause.note || "Worker needs a captain decision."
              : cause.verb === "pr-green" ? "Required checks passed for the current PR head. Walkthrough: pending."
                : undefined,
            ...(decision ? {
              decision_new_thread: config.comments.decision_new_thread,
              decision_key: cause.key,
              decision_task: cause.task,
              decision_lifecycle_id: decisionLink?.lifecycle_id ?? null,
            } : {}),
          },
        },
      });
    }
  }
  return { actions, findings };
}

export function applyMirrorPlan(db: StateDatabase, config: WorkflowConfig, plan: { actions: MirrorAction[] }): number {
  if (config.features.mirror !== "on") return 0;
  return db.transaction(() => {
    for (const action of plan.actions) db.enqueueReconciliation(action.job);
    return plan.actions.length;
  });
}
