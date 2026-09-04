import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { loadKey, resolveHome } from "../env.ts";
import { identityMatches } from "../identity.ts";
import { isManagedIssue } from "../managed.ts";
import { nowIso, overlapTimestamp } from "../time.ts";
import { LinearTransport } from "../transport.ts";
import { deriveComments, type SeenStore } from "../capture/derive.ts";
import { fetchIssueSnapshot } from "../capture/fetch.ts";
import { captureCanonicalEvent, eventId, snapshotFromLinearIssue } from "../capture/ingest.ts";
import type { LinearComment } from "../capture/types.ts";
import type { IssueSnapshot } from "../db/database.ts";

function receiptCommentsQuery(since: string): string {
  return `query($issue:String!,$after:String){comments(first:50,after:$after,orderBy:updatedAt,filter:{issue:{identifier:{eq:$issue}},updatedAt:{gte:${JSON.stringify(since)}}}){pageInfo{hasNextPage endCursor} nodes{id createdAt updatedAt body user{displayName} issue{identifier} parent{id}}}}`;
}

function transportFor(env: NodeJS.ProcessEnv): LinearTransport {
  const fixtureDir = env.FM_LINEAR_FIXTURE_DIR;
  return new LinearTransport({
    apiKey: fixtureDir ? undefined : loadKey(resolveHome(env), env),
    fixtureDir,
    fixtureLog: env.FM_LINEAR_FIXTURE_LOG,
  });
}

export async function synchronizeReceiptCaptainComments(options: {
  db: StateDatabase;
  receiptId: string;
  issue: string;
  config: WorkflowConfig;
  env: NodeJS.ProcessEnv;
  transport?: LinearTransport;
}): Promise<IssueSnapshot> {
  const receipt = options.db.receipt(options.receiptId);
  if (!receipt || receipt.consumed_at) throw new Error(`receipt missing or already consumed: ${options.receiptId}`);
  const authorized = receipt.event_ids
    .map((id) => options.db.event(id))
    .filter((event) => event?.issue === options.issue);
  if (!authorized.length) throw new Error(`receipt does not contain an event for ${options.issue}`);
  const oldest = authorized.reduce((value, event) => event!.created_at < value ? event!.created_at : value, authorized[0]!.created_at);
  const since = overlapTimestamp(oldest);
  if (!since) throw new Error(`authorized event has invalid chronology: ${authorized[0]!.id}`);
  const team = options.config.teams.find((item) => item.key === authorized[0]!.team);
  if (!team) throw new Error(`unmanaged team: ${authorized[0]!.team}`);

  const transport = options.transport ?? transportFor(options.env);
  let after: string | null = null;
  const maxPages = Number(options.env.FM_LINEAR_MAX_PAGES ?? 100);
  const discovered: LinearComment[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await transport.call("receipt-comments", { query: receiptCommentsQuery(since), variables: { issue: options.issue, after } });
    if (!result.ok) throw new Error(result.error.message);
    const comments = (result.value.data as any)?.comments;
    if (!Array.isArray(comments?.nodes)) throw new Error("malformed receipt comments response");
    for (const comment of comments.nodes) {
      if (!comment?.id || !comment.updatedAt || comment.issue?.identifier !== options.issue || !identityMatches(comment.user?.displayName, options.config.captain.display_name)) continue;
      discovered.push(comment as LinearComment);
    }
    if (!comments.pageInfo?.hasNextPage) break;
    if (!comments.pageInfo.endCursor) throw new Error("receipt comments pagination omitted endCursor");
    after = comments.pageInfo.endCursor;
    if (page === maxPages) throw new Error("receipt comments pagination exceeded limit");
  }
  const maxHistoryPages = Number(options.env.FM_LINEAR_MAX_HISTORY_PAGES ?? 100);
  const issueState = await fetchIssueSnapshot(transport, options.issue, { historyCutoff: since, maxPages: maxHistoryPages });
  if (!issueState) throw new Error(`issue not found during receipt synchronization: ${options.issue}`);
  const viewer = issueState.viewer || options.env.FM_LINEAR_SELF_NAME?.trim() || "firstmate";
  const managed = isManagedIssue(team, viewer, issueState.issue);
  const observedAt = nowIso(options.env);
  const snapshot = snapshotFromLinearIssue(
    issueState.issue,
    team.agent_labels,
    observedAt,
    managed,
    options.config.captain.display_name,
  );
  options.db.snapshot(snapshot);
  if (!managed) throw new Error(`issue is no longer managed: ${options.issue}`);
  if (!discovered.length) return snapshot;

  const localSeen = new Set<string>();
  const seen: SeenStore = {
    has: (key) => localSeen.has(key) || options.db.event(eventId(key)) !== null,
    add: (key) => { localSeen.add(key); },
  };
  const events = deriveComments(discovered, seen, observedAt, since, viewer);
  for (const event of events) {
    captureCanonicalEvent({ config: options.config, db: options.db, env: options.env, event, history: issueState.history });
  }
  return snapshot;
}
