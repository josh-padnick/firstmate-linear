import { classifyEvent, type ClassifiableEvent } from "../classify/classify.ts";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase, type IssueSnapshot } from "../db/database.ts";
import { loadKey, resolveHome } from "../env.ts";
import { sha256 } from "../hash.ts";
import { formatIso, nowEpoch, nowIso, overlapTimestamp, parseIso } from "../time.ts";
import { LinearTransport } from "../transport.ts";
import { decideRelay } from "../relay/decide.ts";
import { deriveComments, deriveHistory, deriveIssueCreation, type SeenStore } from "./derive.ts";
import { fetchComments, fetchIssues } from "./fetch.ts";
import type { LedgerEvent, LinearHistory, LinearIssue } from "./types.ts";

export type CaptureCycleResult = {
  captured: number;
  ignored: number;
  waiting: number;
  jobs: number;
  commentsMax: string | null;
  issuesMax: Record<string, string | null>;
};

function maxIso(values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => Boolean(value));
  return present.length ? present.sort().at(-1) ?? null : null;
}

function minIso(values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => Boolean(value));
  return present.length ? present.sort().at(0) ?? null : null;
}

function snapshotAtRevision(current: IssueSnapshot | null, event: LedgerEvent, history: LinearHistory[]): IssueSnapshot | null {
  if (!current || event.event.type !== "comment") return current;
  let state = current.state;
  const later = history
    .filter((item) => item.issue === event.event.issue && item.fromState?.name && item.toState?.name && item.createdAt > event.updated_at)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  for (const transition of later) {
    if (transition.toState?.name !== state) throw new Error(`cannot reconstruct state for ${event.event.issue} at comment revision`);
    state = transition.fromState?.name ?? state;
  }
  return { ...current, state };
}

class DatabaseSeenStore implements SeenStore {
  private readonly local = new Set<string>();
  constructor(private readonly db: StateDatabase) {}
  has(key: string): boolean {
    return this.local.has(key) || this.db.event(eventId(key)) !== null;
  }
  add(key: string): void { this.local.add(key); }
}

export function eventId(dedupeKey: string): string {
  return `linear:${sha256(dedupeKey)}`;
}

function teamFromIssue(issue: string): string {
  return issue.includes("-") ? issue.slice(0, issue.indexOf("-")).toUpperCase() : "";
}

function managed(issue: LinearIssue, scope: "assignee:self" | "all", self: string, projects: string[]): boolean {
  const inScope = scope === "all" || issue.assignee?.displayName === self;
  if (!inScope || projects.length === 0) return inScope;
  const allowed = new Set(projects.map((item) => item.toLowerCase()));
  return allowed.has(issue.project?.name?.toLowerCase() ?? "") || allowed.has(issue.project?.slugId?.toLowerCase() ?? "");
}

function snapshot(issue: LinearIssue, agentLabels: Record<string, string>, observedAt: string): IssueSnapshot {
  const labels = (issue.labels?.nodes ?? []).map((item) => item.name ?? "").filter(Boolean);
  const knownLabels = new Set(Object.values(agentLabels));
  const history = [...(issue.history?.nodes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    issue: issue.identifier,
    state: issue.state?.name ?? "",
    assignee: issue.assignee?.displayName ?? null,
    labels,
    agent_label: labels.find((label) => knownLabels.has(label)) ?? null,
    last_actor: history[0]?.actor?.displayName ?? null,
    last_signal: null,
    observed_at: observedAt,
  };
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

export async function captureCycle(options: {
  config: WorkflowConfig;
  db: StateDatabase;
  env?: NodeJS.ProcessEnv;
  transport?: LinearTransport;
}): Promise<CaptureCycleResult> {
  const env = options.env ?? process.env;
  const observedAt = nowIso(env);
  const storedCommentsCursor = options.db.cursor("linear.comments");
  const commentsCursor = storedCommentsCursor && parseIso(storedCommentsCursor) !== null ? storedCommentsCursor : null;
  const bootstrapCutoff = commentsCursor ? null : formatIso(nowEpoch(env) - 7200);
  const forceSince = env.FM_LINEAR_FORCE_SINCE?.trim() || null;
  const commentsEventCutoff = forceSince ?? (commentsCursor ? overlapTimestamp(commentsCursor) : bootstrapCutoff);
  const transport = options.transport ?? new LinearTransport({
    apiKey: loadKey(resolveHome(env), env),
    fixtureDir: env.FM_LINEAR_FIXTURE_DIR,
    fixtureLog: env.FM_LINEAR_FIXTURE_LOG,
  });
  const comments = await fetchComments(transport, commentsCursor, { forceSince });
  const self = comments.viewer || env.FM_LINEAR_SELF_NAME?.trim() || "firstmate";
  const seen = new DatabaseSeenStore(options.db);
  const allEvents: LedgerEvent[] = [];
  const allHistory: LinearHistory[] = [];
  const issueMax: Record<string, string | null> = {};

  for (const team of options.config.teams) {
    const cursorName = `linear.issues.${team.key}`;
    const storedCursor = options.db.cursor(cursorName);
    const cursor = storedCursor && parseIso(storedCursor) !== null ? storedCursor : null;
    const lastFull = options.db.cursor(`linear.full.${team.key}`);
    const fullDue = !lastFull || nowEpoch(env) - (parseIso(lastFull) ?? 0) >= 900;
    const eventCutoff = forceSince ?? (cursor ? overlapTimestamp(cursor) : bootstrapCutoff);
    const commentCutoff = minIso(comments.comments
      .filter((comment) => teamFromIssue(comment.issue?.identifier ?? "") === team.key)
      .map((comment) => comment.updatedAt));
    const historyCutoff = minIso([eventCutoff, commentCutoff]);
    const result = await fetchIssues(transport, fullDue ? null : cursor, historyCutoff, {
      team: team.key,
      forceSince: fullDue ? null : forceSince,
    });
    const managedIssues = result.issues.filter((issue) => managed(issue, team.managed, self, team.projects));
    const managedIds = new Set(managedIssues.map((issue) => issue.identifier));
    const managedHistory = result.history.filter((item) => managedIds.has(item.issue ?? ""));
    allHistory.push(...managedHistory);
    for (const issue of managedIssues) options.db.snapshot(snapshot(issue, team.agent_labels, observedAt));
    allEvents.push(...deriveHistory(managedHistory, seen, observedAt, eventCutoff, self, bootstrapCutoff !== null));
    allEvents.push(...deriveIssueCreation(managedIssues, seen, observedAt, eventCutoff, self, bootstrapCutoff !== null));
    issueMax[team.key] = maxIso(result.issues.map((issue) => issue.updatedAt));
    if (fullDue) options.db.setCursor(`linear.full.${team.key}`, observedAt, observedAt);
  }

  const relevantComments = comments.comments.filter((comment) => {
    const issue = comment.issue?.identifier ?? "";
    const team = options.config.teams.find((item) => item.key === teamFromIssue(issue));
    if (!team || !comment.issue) return false;
    return managed({
      identifier: issue,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      assignee: comment.issue.assignee,
      project: comment.issue.project,
    }, team.managed, self, team.projects);
  });
  allEvents.push(...deriveComments(relevantComments, seen, observedAt, commentsEventCutoff, self, bootstrapCutoff !== null));

  let captured = 0;
  let ignored = 0;
  let waiting = 0;
  let jobs = 0;
  allEvents.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.dedupe_key.localeCompare(b.dedupe_key));
  for (const legacy of allEvents) {
    const event = toClassifiable(legacy);
    const currentSnapshot = options.db.latestSnapshot(event.issue);
    const eventSnapshot = snapshotAtRevision(currentSnapshot, legacy, allHistory);
    const classification = classifyEvent(event, options.config, eventSnapshot);
    const team = options.config.teams.find((item) => item.key === event.team);
    const relayEligible = classification.token === "comment"
      || (classification.token === "ball-returned" && eventSnapshot?.state === team?.statuses.needs_decision);
    const relay = classification.disposition === "waiting-for-core" && relayEligible
      ? decideRelay({ event, db: options.db, config: options.config, home: resolveHome(env) })
      : null;
    const disposition = relay?.disposition ?? classification.disposition;
    const eventJobs = [...classification.jobs, ...(relay?.job ? [relay.job] : [])];
    if (options.db.capture({
      id: event.id,
      team: event.team,
      issue: event.issue,
      type: event.type,
      token: classification.token,
      author: event.author,
      body_sha: legacy.event.body_sha256,
      created_at: event.created_at,
      captured_at: observedAt,
      disposition,
      note: relay?.note ?? classification.note,
      raw_ref: JSON.stringify(legacy.event),
    }, eventJobs)) {
      captured += 1;
      jobs += eventJobs.length;
      if (disposition === "ignored") ignored += 1;
      if (disposition === "waiting-for-core") waiting += 1;
    }
  }

  const commentsMax = maxIso(comments.comments.map((comment) => comment.updatedAt));
  if (commentsMax) {
    if (commentsCursor && commentsMax < commentsCursor) throw new Error("comments cursor would move backwards");
    options.db.setCursor("linear.comments", commentsMax, observedAt);
  }
  for (const team of options.config.teams) {
    const value = issueMax[team.key];
    if (!value) continue;
    const name = `linear.issues.${team.key}`;
    const previous = options.db.cursor(name);
    if (previous && value < previous) throw new Error(`${team.key} issue cursor would move backwards`);
    options.db.setCursor(name, value, observedAt);
  }
  return { captured, ignored, waiting, jobs, commentsMax, issuesMax: issueMax };
}
