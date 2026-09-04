import type { WorkflowConfig } from "../config/schema.ts";
import { type NewJob, type Observation, observationBelongsToTaskLink, type StateDatabase } from "../db/database.ts";
import { compareIso } from "../time.ts";
import { foldSignals, reduceTaskState, type TaskSignal } from "./reducer.ts";

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
      findings.push({ code: "CAPTAIN_DRAG", issue, detail: `captain set ${snapshot.state}; no newer fleet signal permits repair` });
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
    let target: string | null = null;
    if (reduced === "needs-decision") target = team.statuses.needs_decision;
    else if (reduced === "blocked" || reduced === "failed") target = team.statuses.needs_firstmate_decision;
    else if (latestPrimary?.verb === "dispatch") {
      const building = db.latestSnapshots().filter((item) => {
        const snapshotTeam = item.issue.slice(0, item.issue.indexOf("-")).toUpperCase();
        return snapshotTeam === team.key && item.state === team.statuses.building;
      }).length;
      target = building >= laneCap ? team.statuses.waiting : team.statuses.building;
    } else if (latestPrimary?.verb === "dispatch-scout") target = team.statuses.plan_in_progress;
    else if (latestPrimary?.verb === "lane-cap") target = team.statuses.waiting;
    else if (reduced === "done") {
      target = team.statuses.done;
      cause = primaryObservations.filter((item) => item.verb === "pr-merged").at(-1) ?? cause;
    } else if (reduced === "review-ready") {
      target = team.statuses.approve_deliverable;
      cause = primaryObservations.filter((item) => item.verb === "pr-green").at(-1) ?? cause;
    }
    else if (reduced === "working") target = team.statuses.building;

    for (const observation of currentNewObservations.filter((item) => item.verb === "pr-reported")) {
      const url = observation.note?.match(/https:\/\/\S+/)?.[0];
      if (url) actions.push({ issue, cause: observation.id, description: `attach ${url}`, job: { key: `${observation.id}:attachment`, kind: "linear.attachment", target: issue, payload: { issue, url, title: "Pull request" } } });
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
      if (label) actions.push({ issue, cause: labelCause.id, description: `set agent label ${label}`, job: { key: `${labelCause.id}:agent-label:${label}`, kind: "linear.agent-label", target: issue, payload: { issue, label, known_labels: Object.values(team.agent_labels) } } });
    }
    if (target && target !== snapshot.state) {
      actions.push({ issue, cause: cause.id, description: `${snapshot.state} -> ${target}`, job: { key: `${cause.id}:state:${target}`, kind: "linear.issue-state", target: issue, payload: { issue, state: target, expected_state: snapshot.state, cause_observation: cause.id, actor: "service", comment: cause.verb === "pr-green" ? "Required checks passed for the current PR head. Walkthrough: pending." : undefined } } });
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
