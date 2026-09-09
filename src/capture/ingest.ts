import { classifyEvent, isExactApproval, type ClassifiableEvent } from "../classify/classify.ts";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase, type IssueSnapshot } from "../db/database.ts";
import { resolveHome } from "../env.ts";
import { sha256 } from "../hash.ts";
import { identityMatches } from "../identity.ts";
import { decideRelay } from "../relay/decide.ts";
import { compareIso } from "../time.ts";
import type { LedgerEvent, LinearHistory, LinearIssue } from "./types.ts";

export function eventId(dedupeKey: string): string {
  return `linear:${sha256(dedupeKey)}`;
}

function teamFromIssue(issue: string): string {
  return issue.includes("-") ? issue.slice(0, issue.indexOf("-")).toUpperCase() : "";
}

function toClassifiable(event: LedgerEvent): ClassifiableEvent {
  return {
    id: eventId(event.dedupe_key),
    team: teamFromIssue(event.event.issue),
    issue: event.event.issue,
    type: event.event.type,
    author: event.event.author,
    body: event.event.body,
    from_state: event.event.from_state,
    to_state: event.event.to_state,
    from_assignee: event.event.from_assignee,
    to_assignee: event.event.to_assignee,
    created_at: event.created_at,
  };
}

function snapshotAtRevision(current: IssueSnapshot | null, event: LedgerEvent, history: LinearHistory[], failOnAmbiguous: boolean): { snapshot: IssueSnapshot | null; ambiguous: boolean } {
  if (!current || event.event.type !== "comment") return { snapshot: current, ambiguous: false };
  let state = current.state;
  const transitions = history.filter((item) => item.issue === event.event.issue && item.fromState?.name && item.toState?.name);
  if (transitions.some((item) => compareIso(item.createdAt, event.updated_at) === null)) {
    throw new Error(`cannot reconstruct state for ${event.event.issue} at comment revision`);
  }
  if (failOnAmbiguous && transitions.some((item) => compareIso(item.createdAt, event.updated_at) === 0)) return { snapshot: current, ambiguous: true };
  const later = transitions
    .filter((item) => compareIso(item.createdAt, event.updated_at) === 1)
    .sort((a, b) => -(compareIso(a.createdAt, b.createdAt) ?? 0) || b.id.localeCompare(a.id));
  for (const transition of later) {
    if (transition.toState?.name !== state) throw new Error(`cannot reconstruct state for ${event.event.issue} at comment revision`);
    state = transition.fromState?.name ?? state;
  }
  return { snapshot: { ...current, state }, ambiguous: false };
}

export function snapshotFromLinearIssue(issue: LinearIssue, agentLabels: Record<string, string>, observedAt: string, managed: boolean, captain: string): IssueSnapshot {
  const labels = (issue.labels?.nodes ?? []).map((item) => item.name ?? "").filter(Boolean);
  const knownLabels = new Set(Object.values(agentLabels));
  const history = [...(issue.history?.nodes ?? [])].sort((a, b) => -(compareIso(a.createdAt, b.createdAt) ?? 0) || b.id.localeCompare(a.id));
  return {
    issue: issue.identifier,
    state: issue.state?.name ?? "",
    assignee: issue.assignee?.displayName ?? null,
    labels,
    agent_label: labels.find((label) => knownLabels.has(label)) ?? null,
    last_actor: identityMatches(history[0]?.actor?.displayName, captain) ? captain : history[0]?.actor?.displayName ?? null,
    last_signal: null,
    managed,
    observed_at: observedAt,
  };
}

export function captureCanonicalEvent(options: {
  config: WorkflowConfig;
  db: StateDatabase;
  env: NodeJS.ProcessEnv;
  event: LedgerEvent;
  history: LinearHistory[];
}): { captured: boolean; disposition: string; jobs: number } {
  const event = toClassifiable(options.event);
  if (identityMatches(event.author, options.config.captain.display_name)) event.author = options.config.captain.display_name;
  const currentSnapshot = options.db.latestSnapshot(event.issue);
  const revision = snapshotAtRevision(
    currentSnapshot,
    options.event,
    options.history,
    event.type === "comment" && event.author === options.config.captain.display_name && isExactApproval(event.body ?? ""),
  );
  const eventSnapshot = revision.snapshot;
  const classification = revision.ambiguous
    ? { token: "approval" as const, disposition: "waiting-for-core" as const, jobs: [], note: "approval chronology is ambiguous; automatic transition withheld" }
    : classifyEvent(event, options.config, eventSnapshot);
  const team = options.config.teams.find((item) => item.key === event.team);
  const relayEligible = classification.token === "comment"
    || (classification.token === "ball-returned" && eventSnapshot?.state === team?.statuses.needs_decision);
  const relay = classification.disposition === "waiting-for-core" && relayEligible
    ? decideRelay({ event, db: options.db, config: options.config, home: resolveHome(options.env) })
    : null;
  const disposition = relay?.disposition ?? classification.disposition;
  const eventJobs = [...classification.jobs, ...(relay?.job ? [relay.job] : [])];
  const captured = options.db.capture({
    id: event.id,
    team: event.team,
    issue: event.issue,
    type: event.type,
    token: classification.token,
    author: event.author,
    body_sha: options.event.event.body_sha256,
    created_at: event.created_at,
    captured_at: options.event.captured_at,
    disposition,
    note: relay?.note ?? classification.note,
    raw_ref: JSON.stringify(options.event.event),
  }, eventJobs);
  return { captured, disposition, jobs: captured ? eventJobs.length : 0 };
}
