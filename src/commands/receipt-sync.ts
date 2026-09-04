import type { TeamConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { loadKey, resolveHome } from "../env.ts";
import { sha256 } from "../hash.ts";
import { identityMatches } from "../identity.ts";
import { nowIso, overlapTimestamp } from "../time.ts";
import { LinearTransport } from "../transport.ts";

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
  team: TeamConfig;
  captain: string;
  env: NodeJS.ProcessEnv;
  transport?: LinearTransport;
}): Promise<void> {
  const receipt = options.db.receipt(options.receiptId);
  if (!receipt || receipt.consumed_at) throw new Error(`receipt missing or already consumed: ${options.receiptId}`);
  const authorized = receipt.event_ids
    .map((id) => options.db.event(id))
    .filter((event) => event?.issue === options.issue);
  if (!authorized.length) throw new Error(`receipt does not contain an event for ${options.issue}`);
  const oldest = authorized.reduce((value, event) => event!.created_at < value ? event!.created_at : value, authorized[0]!.created_at);
  const since = overlapTimestamp(oldest);
  if (!since) throw new Error(`authorized event has invalid chronology: ${authorized[0]!.id}`);

  const transport = options.transport ?? transportFor(options.env);
  let after: string | null = null;
  const maxPages = Number(options.env.FM_LINEAR_MAX_PAGES ?? 100);
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await transport.call("receipt-comments", { query: receiptCommentsQuery(since), variables: { issue: options.issue, after } });
    if (!result.ok) throw new Error(result.error.message);
    const comments = (result.value.data as any)?.comments;
    if (!Array.isArray(comments?.nodes)) throw new Error("malformed receipt comments response");
    for (const comment of comments.nodes) {
      if (!comment?.id || !comment.updatedAt || comment.issue?.identifier !== options.issue || !identityMatches(comment.user?.displayName, options.captain)) continue;
      const body = typeof comment.body === "string" ? comment.body : "";
      const bodySha = sha256(body);
      const raw = {
        type: "comment", issue: options.issue, author: options.captain, comment_id: comment.id, history_id: null,
        parent_id: comment.parent?.id ?? null, body_sha256: bodySha, excerpt: body.slice(0, 300), body,
        from_state: null, to_state: null, from_assignee: null, to_assignee: null,
        description_updated: false, added_labels: [], removed_labels: [], title: null, labels: [],
      };
      options.db.capture({
        id: `linear:${sha256(`comment:${comment.id}:${comment.updatedAt}:${bodySha}`)}`,
        team: options.team.key, issue: options.issue, type: "comment", token: "comment", author: options.captain,
        body_sha: bodySha, created_at: comment.updatedAt, captured_at: nowIso(options.env), disposition: "waiting-for-core", note: null, raw_ref: JSON.stringify(raw),
      });
    }
    if (!comments.pageInfo?.hasNextPage) return;
    if (!comments.pageInfo.endCursor) throw new Error("receipt comments pagination omitted endCursor");
    after = comments.pageInfo.endCursor;
  }
  throw new Error("receipt comments pagination exceeded limit");
}
