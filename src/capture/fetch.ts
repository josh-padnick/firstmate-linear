import type { LinearTransport } from "../transport.ts";
import { compareIso, overlapTimestamp } from "../time.ts";
import type { LinearComment, LinearHistory, LinearIssue } from "./types.ts";

const DEFAULT_MAX_PAGES = 100;

function commentsQuery(team: string, since: string | null): string {
  const updated = since ? `,updatedAt:{gte:"${since}"}` : "";
  const filter = `,filter:{issue:{team:{key:{eq:"${team}"}}}${updated}}`;
  return `query($after:String){viewer{id displayName} comments(first:50,after:$after,orderBy:updatedAt${filter}){pageInfo{hasNextPage endCursor} nodes{id createdAt updatedAt body user{id displayName} issue{identifier assignee{id displayName} project{name slugId}} parent{id}}}}`;
}

function issuesQuery(team: string, since: string | null): string {
  const updated = since ? `,updatedAt:{gte:"${since}"}` : "";
  return `query($after:String){issues(first:50,after:$after,orderBy:updatedAt,filter:{team:{key:{eq:"${team}"}}${updated}}){pageInfo{hasNextPage endCursor} nodes{identifier title description updatedAt createdAt state{name} assignee{id displayName} creator{id displayName} project{name slugId} labels{nodes{name}} history(first:10){pageInfo{hasNextPage endCursor} nodes{id createdAt actor{displayName} fromState{name} toState{name} fromAssignee{displayName} toAssignee{displayName} updatedDescription addedLabels{name} removedLabels{name}}}}}}`;
}

const HISTORY_QUERY =
  "query($id:String!,$after:String){issue(id:$id){history(first:10,after:$after){pageInfo{hasNextPage endCursor} nodes{id createdAt actor{displayName} fromState{name} toState{name} fromAssignee{displayName} toAssignee{displayName} updatedDescription addedLabels{name} removedLabels{name}}}}}";

export type FetchCommentsResult = {
  comments: LinearComment[];
  viewer: string | null;
  resumeAfter: string | null;
};

export async function fetchComments(
  transport: LinearTransport,
  cursor: string | null,
  options: { team?: string; forceSince?: string | null; maxPages?: number; after?: string | null } = {},
): Promise<FetchCommentsResult> {
  if (!options.team) throw new Error("team key is required");
  const since = options.forceSince ?? (cursor ? overlapTimestamp(cursor) : null);
  if (cursor && !since && !options.forceSince) {
    throw new Error("invalid comments cursor");
  }
  const comments: LinearComment[] = [];
  let after = options.after ?? "";
  let viewer: string | null = null;
  const maxPages = options.maxPages ?? Number(process.env.FM_LINEAR_MAX_PAGES ?? DEFAULT_MAX_PAGES);
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await transport.call("comments", {
      query: commentsQuery(options.team, since),
      variables: { after: after || null },
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const data = result.value.data as {
      viewer?: { displayName?: string };
      comments?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: LinearComment[];
      };
    };
    if (!Array.isArray(data.comments?.nodes)) {
      throw new Error("malformed comments response");
    }
    if (data.viewer?.displayName) {
      viewer = data.viewer.displayName;
    }
    comments.push(...data.comments.nodes);
    if (!data.comments.pageInfo?.hasNextPage) {
      return { comments, viewer, resumeAfter: null };
    }
    const endCursor = data.comments.pageInfo.endCursor;
    if (!endCursor) {
      throw new Error("comments pagination omitted endCursor");
    }
    after = endCursor;
  }
  return { comments, viewer, resumeAfter: after };
}

export type FetchIssuesResult = {
  issues: LinearIssue[];
  history: LinearHistory[];
};

export async function fetchIssues(
  transport: LinearTransport,
  cursor: string | null,
  historyCutoff: string | null,
  options: { team?: string; forceSince?: string | null; maxPages?: number } = {},
): Promise<FetchIssuesResult> {
  const since = options.forceSince ?? (cursor ? overlapTimestamp(cursor) : null);
  if (cursor && !since && !options.forceSince) {
    throw new Error("invalid issues cursor");
  }
  const team = options.team;
  if (!team) {
    throw new Error("team key is required");
  }
  const issues: LinearIssue[] = [];
  const history: LinearHistory[] = [];
  const pending: Array<{ identifier: string; after: string }> = [];
  let after = "";
  let exhausted = false;
  const maxPages = options.maxPages ?? Number(process.env.FM_LINEAR_MAX_PAGES ?? DEFAULT_MAX_PAGES);
  const threshold = historyCutoff ?? cursor ?? "";

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await transport.call("issues", {
      query: issuesQuery(team, since),
      variables: { after: after || null },
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const data = result.value.data as {
      issues?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: LinearIssue[];
      };
    };
    if (!Array.isArray(data.issues?.nodes)) {
      throw new Error("malformed issues response");
    }
    for (const issue of data.issues.nodes) {
      issues.push(issue);
      for (const node of issue.history?.nodes ?? []) {
        history.push({ ...node, issue: issue.identifier });
      }
      const pageInfo = issue.history?.pageInfo;
      const nodes = issue.history?.nodes ?? [];
      const oldest = nodes.reduce<string | null>((min, node) => {
        if (!min || compareIso(node.createdAt, min) === -1) {
          return node.createdAt;
        }
        return min;
      }, null);
      if (
        pageInfo?.hasNextPage &&
        nodes.length === 10 &&
        (!threshold || (oldest && (compareIso(oldest, threshold) ?? -1) >= 0))
      ) {
        if (!pageInfo.endCursor) {
          throw new Error(`history pagination omitted endCursor for ${issue.identifier}`);
        }
        pending.push({ identifier: issue.identifier, after: pageInfo.endCursor });
      }
    }
    if (!data.issues.pageInfo?.hasNextPage) {
      exhausted = true;
      break;
    }
    const endCursor = data.issues.pageInfo.endCursor;
    if (!endCursor) {
      throw new Error("issues pagination omitted endCursor");
    }
    after = endCursor;
  }
  if (!exhausted) {
    throw new Error("issues pagination exceeded limit");
  }

  const maxHistoryPages = Number(process.env.FM_LINEAR_MAX_HISTORY_PAGES ?? DEFAULT_MAX_PAGES);
  for (const item of pending) {
    let historyAfter = item.after;
    for (let page = 1; page <= maxHistoryPages; page += 1) {
      const result = await transport.call("history", {
        query: HISTORY_QUERY,
        variables: { id: item.identifier, after: historyAfter },
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const data = result.value.data as {
        issue?: {
          history?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: LinearHistory[];
          };
        };
      };
      if (!Array.isArray(data.issue?.history?.nodes)) {
        throw new Error(`malformed history response for ${item.identifier}`);
      }
      for (const node of data.issue.history.nodes) {
        history.push({ ...node, issue: item.identifier });
      }
      const crossedCutoff = Boolean(threshold && data.issue.history.nodes.some((node) => {
        const compared = compareIso(node.createdAt, threshold);
        return compared !== null && compared <= 0;
      }));
      if (crossedCutoff) break;
      if (!data.issue.history.pageInfo?.hasNextPage) {
        break;
      }
      if (!data.issue.history.pageInfo.endCursor) {
        throw new Error(`history pagination omitted endCursor for ${item.identifier}`);
      }
      historyAfter = data.issue.history.pageInfo.endCursor;
      if (page === maxHistoryPages) {
        throw new Error(`history pagination exceeded limit for ${item.identifier}`);
      }
    }
  }

  return { issues, history };
}

const ISSUE_SNAPSHOT_QUERY =
  "query($id:String!){viewer{displayName} issue(id:$id){identifier title description updatedAt createdAt state{name} assignee{id displayName} creator{id displayName} project{name slugId} labels{nodes{name}} history(first:10){pageInfo{hasNextPage endCursor} nodes{id createdAt actor{displayName} fromState{name} toState{name} fromAssignee{displayName} toAssignee{displayName} updatedDescription addedLabels{name} removedLabels{name}}}}}";

export async function fetchIssueSnapshot(
  transport: LinearTransport,
  identifier: string,
  options: { historyCutoff?: string | null; maxPages?: number } = {},
): Promise<{ issue: LinearIssue; history: LinearHistory[]; viewer: string | null } | null> {
  const result = await transport.call("canary-issue", {
    query: ISSUE_SNAPSHOT_QUERY,
    variables: { id: identifier },
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const data = result.value.data as { viewer?: { displayName?: string | null }; issue?: LinearIssue };
  if (!data.issue?.identifier) {
    return null;
  }
  const history: LinearHistory[] = (data.issue.history?.nodes ?? []).map((node) => ({
    ...node,
    issue: data.issue!.identifier,
  }));
  let pageInfo = data.issue.history?.pageInfo;
  let after = pageInfo?.endCursor ?? null;
  const maxPages = options.maxPages ?? Number(process.env.FM_LINEAR_MAX_HISTORY_PAGES ?? DEFAULT_MAX_PAGES);
  for (let page = 1; page <= maxPages && pageInfo?.hasNextPage; page += 1) {
    const oldest = history.reduce<string | null>((minimum, item) => !minimum || compareIso(item.createdAt, minimum) === -1 ? item.createdAt : minimum, null);
    if (options.historyCutoff && oldest && (compareIso(oldest, options.historyCutoff) ?? -1) <= 0) break;
    if (!after) throw new Error(`history pagination omitted endCursor for ${identifier}`);
    const next = await transport.call("history", { query: HISTORY_QUERY, variables: { id: identifier, after } });
    if (!next.ok) throw new Error(next.error.message);
    const nextData = next.value.data as { issue?: { history?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: LinearHistory[] } } };
    if (!Array.isArray(nextData.issue?.history?.nodes)) throw new Error(`malformed history response for ${identifier}`);
    history.push(...nextData.issue.history.nodes.map((node) => ({ ...node, issue: identifier })));
    pageInfo = nextData.issue.history.pageInfo;
    after = pageInfo?.endCursor ?? null;
    if (page === maxPages && pageInfo?.hasNextPage) throw new Error(`history pagination exceeded limit for ${identifier}`);
  }
  return { issue: data.issue, history, viewer: data.viewer?.displayName ?? null };
}
