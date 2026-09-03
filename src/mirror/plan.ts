import type { WorkflowConfig } from "../config/schema.ts";
import type { NewJob, Observation, StateDatabase } from "../db/database.ts";
import { foldSignals, reduceTaskState, type TaskSignal } from "./reducer.ts";

export type MirrorAction = { issue: string; cause: string; description: string; job: NewJob };
export type MirrorFinding = { code: string; issue: string; detail: string };

function signal(verb: string): TaskSignal | null {
  if (["working", "dispatch", "model-resolved", "pr-reported", "pr-green"].includes(verb)) return "working";
  if (verb === "needs-decision") return "needs-decision";
  if (verb === "blocked") return "blocked";
  if (verb === "failed") return "failed";
  if (verb === "done" || verb === "pr-merged") return "done";
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
    const relevant = db.observations(issue);
    const latest = relevant.at(-1);
    if (!latest) continue;
    if (snapshot.last_actor === config.captain.display_name && latest.observed_at <= snapshot.observed_at) {
      findings.push({ code: "CAPTAIN_DRAG", issue, detail: `captain set ${snapshot.state}; no newer fleet signal permits repair` });
      continue;
    }
    const links = new Map(db.taskLinks(issue).map((link) => [link.task, link.role]));
    const taskSignals = relevant
      .map((item) => ({ item, signal: signal(item.verb) }))
      .filter((row): row is { item: Observation; signal: TaskSignal } => row.signal !== null && row.item.task !== null)
      .map((row) => ({ task: row.item.task!, role: links.get(row.item.task!) ?? "primary", signal: row.signal, key: row.item.key }));
    const reduced = reduceTaskState(foldSignals(taskSignals));
    let target: string | null = null;
    if (latest.verb === "dispatch") {
      const building = db.latestSnapshots().filter((item) => item.state === team.statuses.building).length;
      target = building >= laneCap ? team.statuses.waiting : team.statuses.building;
    } else if (latest.verb === "dispatch-scout") target = team.statuses.plan_in_progress;
    else if (latest.verb === "pr-green") target = team.statuses.approve_deliverable;
    else if (latest.verb === "pr-merged") target = team.statuses.done;
    else if (latest.verb === "pr-withdrawn" && snapshot.state === team.statuses.approve_deliverable) target = team.statuses.building;
    else if (latest.verb === "lane-cap") target = team.statuses.waiting;
    else if (reduced === "needs-decision") target = team.statuses.needs_decision;
    else if (reduced === "blocked" || reduced === "failed") target = team.statuses.needs_firstmate_decision;
    else if (reduced === "working") target = team.statuses.building;

    if (latest.verb === "pr-reported") {
      const url = latest.note?.match(/https:\/\/\S+/)?.[0];
      if (url) actions.push({ issue, cause: latest.id, description: `attach ${url}`, job: { key: `${latest.id}:attachment`, kind: "linear.attachment", target: issue, payload: { issue, url, title: "Pull request" } } });
    }
    if (latest.verb === "model-resolved" || latest.verb === "dispatch") {
      const modelObservation = [...db.observations(issue)].reverse().find((item) => item.verb === "model-resolved");
      const model = modelFrom(modelObservation ?? latest);
      const label = team.agent_labels[model] ?? team.agent_labels.unknown;
      if (!team.agent_labels[model]) findings.push({ code: "UNKNOWN_MODEL", issue, detail: `unmapped model ${model}; using unknown` });
      if (label) actions.push({ issue, cause: latest.id, description: `set agent label ${label}`, job: { key: `${latest.id}:agent-label:${label}`, kind: "linear.agent-label", target: issue, payload: { issue, label, known_labels: Object.values(team.agent_labels) } } });
    }
    if (target && target !== snapshot.state) {
      actions.push({ issue, cause: latest.id, description: `${snapshot.state} -> ${target}`, job: { key: `${latest.id}:state:${target}`, kind: "linear.issue-state", target: issue, payload: { issue, state: target, expected_state: snapshot.state, cause_observation: latest.id, actor: "service", comment: latest.verb === "pr-green" ? "Required checks passed for the current PR head. Walkthrough: pending." : undefined } } });
    }
  }
  return { actions, findings };
}

export function applyMirrorPlan(db: StateDatabase, config: WorkflowConfig, plan: { actions: MirrorAction[] }): number {
  if (config.features.mirror !== "on") return 0;
  return db.transaction(() => {
    for (const action of plan.actions) db.enqueue(action.job);
    return plan.actions.length;
  });
}
