import type { WorkflowConfig } from "../config/schema.ts";
import { roleForState } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { loadKey, resolveHome } from "../env.ts";
import { sha256 } from "../hash.ts";
import { isManagedIssue } from "../managed.ts";
import { compareIso, formatIso, nowEpoch, nowIso, overlapTimestamp, parseIso } from "../time.ts";
import { LinearTransport } from "../transport.ts";
import { deriveComments, deriveHistory, deriveIssueCreation, type SeenStore } from "./derive.ts";
import { fetchComments, fetchIssues } from "./fetch.ts";
import { captureCanonicalEvent, eventId, snapshotFromLinearIssue } from "./ingest.ts";
import type { LedgerEvent, LinearHistory } from "./types.ts";

export { eventId } from "./ingest.ts";

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

class DatabaseSeenStore implements SeenStore {
  private readonly local = new Set<string>();
  constructor(private readonly db: StateDatabase) {}
  has(key: string): boolean {
    return this.local.has(key) || this.db.event(eventId(key)) !== null;
  }
  add(key: string): void { this.local.add(key); }
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
    gatePhrases: Object.values(options.config.gates).flatMap((gate) => gate.phrases),
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
    requiresFullHistory: boolean;
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
      requiresFullHistory: resume !== null || result.resumeAfter !== null,
    });
  }
  const self = viewer || env.FM_LINEAR_SELF_NAME?.trim() || "firstmate";
  const seen = new DatabaseSeenStore(options.db);
  const allEvents: LedgerEvent[] = [];
  const allHistory: LinearHistory[] = [];
  const issueMax: Record<string, string | null> = {};
  const fullScanMarkers = new Map<string, string>();

  for (const team of options.config.teams) {
    const cursorName = `linear.issues.${team.key}`;
    const storedCursor = options.db.cursor(cursorName);
    const cursor = storedCursor && parseIso(storedCursor) !== null ? storedCursor : null;
    const lastFull = options.db.cursor(`linear.full.${team.key}`);
    const fullDue = commentCheckpoints.get(team.key)?.requiresFullHistory === true
      || !lastFull
      || nowEpoch(env) - (parseIso(lastFull) ?? 0) >= 900;
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
      const role = roleForState(team, item.toState.name);
      if (!role) continue;
      options.db.observe({
        id: `obs:${sha256(`linear-board:${item.id}`)}`,
        source: "linear", task: null, issue: item.issue, verb: "board-transition", key: role,
        note: roleForState(team, item.fromState?.name) ?? null, observed_at: item.createdAt,
      });
    }
    for (const issue of result.issues) {
      const isManaged = managedIds.has(issue.identifier);
      if (isManaged || options.db.latestSnapshot(issue.identifier)) {
        options.db.snapshot(snapshotFromLinearIssue(issue, team, observedAt, isManaged, options.config.captain.display_name));
      }
    }
    allEvents.push(...deriveHistory(managedHistory, seen, observedAt, eventCutoff, self, bootstrapCutoff !== null));
    allEvents.push(...deriveIssueCreation(managedIssues, seen, observedAt, eventCutoff, self, bootstrapCutoff !== null));
    issueMax[team.key] = maxIso(result.issues.map((issue) => issue.updatedAt));
    if (fullDue) fullScanMarkers.set(team.key, observedAt);
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
    const result = captureCanonicalEvent({ config: options.config, db: options.db, env, event: legacy, history: allHistory });
    if (result.captured) {
      captured += 1;
      jobs += result.jobs;
      if (result.disposition === "ignored") ignored += 1;
      if (result.disposition === "waiting-for-core") waiting += 1;
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
  for (const team of options.config.teams) {
    const value = issueMax[team.key];
    if (!value) continue;
    const previous = options.db.cursor(`linear.issues.${team.key}`);
    if (previous && compareIso(value, previous) === -1) throw new Error(`${team.key} issue cursor would move backwards`);
  }
  options.db.transaction(() => {
    for (const checkpoint of commentCheckpoints.values()) {
      options.db.setCursor(checkpoint.resumeName, checkpoint.resumeValue, observedAt);
      if (checkpoint.completed && checkpoint.highWater) options.db.setCursor(checkpoint.cursorName, checkpoint.highWater, observedAt);
    }
    if (commentsMax && commentsComplete) options.db.setCursor("linear.comments", commentsMax, observedAt);
    for (const [teamKey, marker] of fullScanMarkers) options.db.setCursor(`linear.full.${teamKey}`, marker, observedAt);
    for (const team of options.config.teams) {
      const value = issueMax[team.key];
      if (value) options.db.setCursor(`linear.issues.${team.key}`, value, observedAt);
    }
  });
  return { captured, ignored, waiting, jobs, commentsMax, issuesMax: issueMax };
}
