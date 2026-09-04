import { classifyEvent, isExactApproval, type ClassifiableEvent } from "../classify/classify.ts";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase, type IssueSnapshot } from "../db/database.ts";
import { loadKey, resolveHome } from "../env.ts";
import { sha256 } from "../hash.ts";
import { identityMatches } from "../identity.ts";
import { isManagedIssue } from "../managed.ts";
import { compareIso, formatIso, nowEpoch, nowIso, overlapTimestamp, parseIso } from "../time.ts";
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
  return present.reduce<string | null>((maximum, value) => {
    if (compareIso(value, value) === null) throw new Error(`invalid timestamp: ${value}`);
    if (maximum === null) return value;
    const comparison = compareIso(value, maximum);
    if (comparison === null) throw new Error(`invalid timestamp: ${value}`);
    return comparison > 0 ? value : maximum;
  }, null);
}

function minIso(values: Array<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => Boolean(value));
  return present.reduce<string | null>((minimum, value) => {
    if (compareIso(value, value) === null) throw new Error(`invalid timestamp: ${value}`);
    if (minimum === null) return value;
    const comparison = compareIso(value, minimum);
    if (comparison === null) throw new Error(`invalid timestamp: ${value}`);
    return comparison < 0 ? value : minimum;
  }, null);
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

function snapshot(issue: LinearIssue, agentLabels: Record<string, string>, observedAt: string, isManaged: boolean, captain: string): IssueSnapshot {
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
    managed: isManaged,
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
  const legacyCommentsCursor = options.db.cursor("linear.comments");
  const validLegacyCommentsCursor = legacyCommentsCursor && parseIso(legacyCommentsCursor) !== null ? legacyCommentsCursor : null;
  const bootstrapCutoff = validLegacyCommentsCursor ? null : formatIso(nowEpoch(env) - 7200);
  const forceSince = env.FM_LINEAR_FORCE_SINCE?.trim() || null;
  const maxPages = env.FM_LINEAR_MAX_PAGES ? Number(env.FM_LINEAR_MAX_PAGES) : undefined;
  const transport = options.transport ?? new LinearTransport({
    apiKey: loadKey(resolveHome(env), env),
    fixtureDir: env.FM_LINEAR_FIXTURE_DIR,
    fixtureLog: env.FM_LINEAR_FIXTURE_LOG,
  });
  const commentsByTeam = new Map<string, Awaited<ReturnType<typeof fetchComments>>>();
  const commentCutoffs = new Map<string, string | null>();
  const commentCheckpoints = new Map<string, {
    resumeName: string;
    resumeValue: string;
    cursorName: string;
    previous: string | null;
    completed: boolean;
    highWater: string | null;
  }>();
  let viewer: string | null = null;
  for (const team of options.config.teams) {
    const cursorName = `linear.comments.${team.key}`;
    const stored = options.db.cursor(cursorName) ?? validLegacyCommentsCursor;
    const cursor = stored && parseIso(stored) !== null ? stored : null;
    const resumeName = `linear.comments.page.${team.key}`;
    let resume: { since: string | null; after: string; highWater: string | null } | null = null;
    try {
      const parsed = JSON.parse(options.db.cursor(resumeName) ?? "null") as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as any).after === "string") {
        resume = {
          since: typeof (parsed as any).since === "string" ? (parsed as any).since : null,
          after: (parsed as any).after,
          highWater: typeof (parsed as any).highWater === "string" ? (parsed as any).highWater : null,
        };
      }
    } catch {}
    const since = resume?.since ?? forceSince ?? (cursor ? overlapTimestamp(cursor) : bootstrapCutoff);
    const result = await fetchComments(transport, cursor, { team: team.key, forceSince: since, after: resume?.after, maxPages });
    commentsByTeam.set(team.key, result);
    commentCutoffs.set(team.key, since);
    viewer ??= result.viewer;
    const highWater = maxIso([resume?.highWater, ...result.comments.map((comment) => comment.updatedAt)]);
    commentCheckpoints.set(team.key, {
      resumeName,
      resumeValue: result.resumeAfter ? JSON.stringify({ since, after: result.resumeAfter, highWater }) : "",
      cursorName,
      previous: cursor,
      completed: result.resumeAfter === null,
      highWater: highWater ?? cursor,
    });
  }
  const self = viewer || env.FM_LINEAR_SELF_NAME?.trim() || "firstmate";
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
    const teamComments = commentsByTeam.get(team.key)?.comments ?? [];
    const commentCutoff = minIso(teamComments
      .map((comment) => comment.updatedAt));
    const historyCutoff = minIso([eventCutoff, commentCutoff]);
    const result = await fetchIssues(transport, fullDue ? null : cursor, historyCutoff, {
      team: team.key,
      forceSince: fullDue ? null : forceSince,
      maxPages,
    });
    const managedIssues = result.issues.filter((issue) => isManagedIssue(team, self, issue));
    const managedIds = new Set(managedIssues.map((issue) => issue.identifier));
    const managedHistory = result.history.filter((item) => managedIds.has(item.issue ?? ""));
    allHistory.push(...managedHistory);
    for (const item of managedHistory) {
      if (!item.issue || !item.toState?.name) continue;
      options.db.observe({
        id: `obs:${sha256(`linear-board:${item.id}`)}`,
        source: "linear", task: null, issue: item.issue, verb: "board-transition", key: item.toState.name,
        note: item.fromState?.name ?? null, observed_at: item.createdAt,
      });
    }
    for (const issue of result.issues) {
      const isManaged = managedIds.has(issue.identifier);
      if (isManaged || options.db.latestSnapshot(issue.identifier)) {
        options.db.snapshot(snapshot(issue, team.agent_labels, observedAt, isManaged, options.config.captain.display_name));
      }
    }
    allEvents.push(...deriveHistory(managedHistory, seen, observedAt, eventCutoff, self, bootstrapCutoff !== null));
    allEvents.push(...deriveIssueCreation(managedIssues, seen, observedAt, eventCutoff, self, bootstrapCutoff !== null));
    issueMax[team.key] = maxIso(result.issues.map((issue) => issue.updatedAt));
    if (fullDue) options.db.setCursor(`linear.full.${team.key}`, observedAt, observedAt);
  }

  for (const team of options.config.teams) {
    const relevantComments = (commentsByTeam.get(team.key)?.comments ?? []).filter((comment) => Boolean(comment.issue && isManagedIssue(team, self, comment.issue)));
    allEvents.push(...deriveComments(relevantComments, seen, observedAt, commentCutoffs.get(team.key) ?? null, self, bootstrapCutoff !== null));
  }

  let captured = 0;
  let ignored = 0;
  let waiting = 0;
  let jobs = 0;
  allEvents.sort((a, b) => (compareIso(a.created_at, b.created_at) ?? 0) || a.dedupe_key.localeCompare(b.dedupe_key));
  for (const legacy of allEvents) {
    const event = toClassifiable(legacy);
    if (identityMatches(event.author, options.config.captain.display_name)) event.author = options.config.captain.display_name;
    const currentSnapshot = options.db.latestSnapshot(event.issue);
    const revision = snapshotAtRevision(
      currentSnapshot,
      legacy,
      allHistory,
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

  const commentsMax = maxIso([...commentCheckpoints.values()].map((checkpoint) => checkpoint.highWater));
  for (const [teamKey, checkpoint] of commentCheckpoints) {
    if (checkpoint.completed && checkpoint.highWater && checkpoint.previous && compareIso(checkpoint.highWater, checkpoint.previous) === -1) {
      throw new Error(`${teamKey} comments cursor would move backwards`);
    }
  }
  const commentsComplete = [...commentCheckpoints.values()].every((checkpoint) => checkpoint.completed);
  if (commentsMax && commentsComplete) {
    if (validLegacyCommentsCursor && compareIso(commentsMax, validLegacyCommentsCursor) === -1) throw new Error("comments cursor would move backwards");
  }
  options.db.transaction(() => {
    for (const checkpoint of commentCheckpoints.values()) {
      options.db.setCursor(checkpoint.resumeName, checkpoint.resumeValue, observedAt);
      if (checkpoint.completed && checkpoint.highWater) options.db.setCursor(checkpoint.cursorName, checkpoint.highWater, observedAt);
    }
    if (commentsMax && commentsComplete) options.db.setCursor("linear.comments", commentsMax, observedAt);
  });
  for (const team of options.config.teams) {
    const value = issueMax[team.key];
    if (!value) continue;
    const name = `linear.issues.${team.key}`;
    const previous = options.db.cursor(name);
    if (previous && compareIso(value, previous) === -1) throw new Error(`${team.key} issue cursor would move backwards`);
    options.db.setCursor(name, value, observedAt);
  }
  return { captured, ignored, waiting, jobs, commentsMax, issuesMax: issueMax };
}
