import { sha256 } from "../hash.ts";
import { compareIso, isoAtOrAfter } from "../time.ts";
import type { LedgerEvent, LinearComment, LinearHistory, LinearIssue } from "./types.ts";

export type SeenStore = {
  has(key: string): boolean;
  add(key: string, observedAt: string): void;
};

function names(list: Array<{ name?: string | null }> | null | undefined): string[] {
  return (list ?? []).map((item) => item.name ?? "").filter(Boolean);
}

function commentEvent(
  comment: LinearComment,
  observedAt: string,
  bootstrap: boolean,
): LedgerEvent {
  const body = comment.body ?? "";
  const hash = sha256(body);
  const author = comment.user?.displayName || "unknown";
  const issue = comment.issue?.identifier || "unknown";
  return {
    kind: "fm-linear-event",
    version: 1,
    event: {
      type: "comment",
      issue,
      author,
      comment_id: comment.id,
      history_id: null,
      parent_id: comment.parent?.id ?? null,
      body_sha256: hash,
      excerpt: body.slice(0, 300),
      body,
      from_state: null,
      to_state: null,
      from_assignee: null,
      to_assignee: null,
      description_updated: false,
      added_labels: [],
      removed_labels: [],
      title: null,
      labels: [],
    },
    created_at: comment.updatedAt,
    updated_at: comment.updatedAt,
    captured_at: observedAt,
    announced_at: null,
    read_at: null,
    handled_at: null,
    handled_by: null,
    handled_note: null,
    observed_at: observedAt,
    bootstrap,
    dedupe_key: `comment:${comment.id}:${hash}`,
  };
}

function historyEvent(
  item: LinearHistory,
  kind: "board" | "description" | "label",
  observedAt: string,
  bootstrap: boolean,
): LedgerEvent {
  const author = item.actor?.displayName || "unknown";
  const issue = item.issue || "unknown";
  return {
    kind: "fm-linear-event",
    version: 1,
    event: {
      type: kind,
      issue,
      author,
      comment_id: null,
      history_id: item.id,
      parent_id: null,
      body_sha256: null,
      excerpt: null,
      from_state: item.fromState?.name ?? null,
      to_state: item.toState?.name ?? null,
      from_assignee: item.fromAssignee?.displayName ?? null,
      to_assignee: item.toAssignee?.displayName ?? null,
      description_updated: item.updatedDescription != null,
      added_labels: names(item.addedLabels),
      removed_labels: names(item.removedLabels),
      title: null,
      labels: [],
    },
    created_at: item.createdAt,
    updated_at: item.createdAt,
    captured_at: observedAt,
    announced_at: null,
    read_at: null,
    handled_at: null,
    handled_by: null,
    handled_note: null,
    observed_at: observedAt,
    bootstrap,
    dedupe_key: `history:${item.id}`,
  };
}

function issueEvent(issue: LinearIssue, observedAt: string, bootstrap: boolean): LedgerEvent {
  const author = issue.creator?.displayName || "unknown";
  const labels = names(issue.labels?.nodes ?? []);
  return {
    kind: "fm-linear-event",
    version: 1,
    event: {
      type: "issue-created",
      issue: issue.identifier,
      author,
      comment_id: null,
      history_id: null,
      parent_id: null,
      body_sha256: null,
      excerpt: issue.title ?? null,
      from_state: null,
      to_state: null,
      from_assignee: null,
      to_assignee: null,
      description_updated: false,
      added_labels: [],
      removed_labels: [],
      title: issue.title ?? null,
      labels,
    },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    captured_at: observedAt,
    announced_at: null,
    read_at: null,
    handled_at: null,
    handled_by: null,
    handled_note: null,
    observed_at: observedAt,
    bootstrap,
    dedupe_key: `issue-created:${issue.identifier}`,
  };
}

export function deriveComments(
  comments: LinearComment[],
  seen: SeenStore,
  observedAt: string,
  cutoff: string | null,
  self: string,
  bootstrap = false,
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const sorted = [...comments].sort((a, b) =>
    (compareIso(a.updatedAt, b.updatedAt) ?? 0) || a.id.localeCompare(b.id),
  );
  for (const comment of sorted) {
    if (!comment.id || !comment.updatedAt) {
      throw new Error("malformed comment node");
    }
    const event = commentEvent(comment, observedAt, bootstrap);
    if (seen.has(event.dedupe_key)) {
      continue;
    }
    if (cutoff && !isoAtOrAfter(comment.updatedAt, cutoff)) {
      seen.add(event.dedupe_key, observedAt);
      continue;
    }
    if (event.event.author === self) {
      seen.add(event.dedupe_key, observedAt);
      continue;
    }
    seen.add(event.dedupe_key, observedAt);
    events.push(event);
  }
  return events;
}

export function deriveHistory(
  items: LinearHistory[],
  seen: SeenStore,
  observedAt: string,
  cutoff: string | null,
  self: string,
  bootstrap = false,
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const sorted = [...items].sort((a, b) =>
    (compareIso(a.createdAt, b.createdAt) ?? 0) || a.id.localeCompare(b.id),
  );
  for (const item of sorted) {
    if (!item.id || !item.createdAt) {
      throw new Error("malformed history node");
    }
    const key = `history:${item.id}`;
    const hasBoard = Boolean(item.fromState || item.toState || item.fromAssignee || item.toAssignee);
    const hasDescription = item.updatedDescription != null;
    const hasLabels = names(item.addedLabels).length + names(item.removedLabels).length > 0;
    if (seen.has(key)) {
      continue;
    }
    if (cutoff && !isoAtOrAfter(item.createdAt, cutoff)) {
      seen.add(key, observedAt);
      continue;
    }
    if ((item.actor?.displayName || "unknown") === self) {
      seen.add(key, observedAt);
      continue;
    }
    const kind = hasBoard ? "board" : hasDescription ? "description" : hasLabels ? "label" : null;
    if (!kind) {
      seen.add(key, observedAt);
      continue;
    }
    seen.add(key, observedAt);
    events.push(
      historyEvent(
        item,
        kind,
        observedAt,
        bootstrap,
      ),
    );
  }
  return events;
}

export function deriveIssueCreation(
  issues: LinearIssue[],
  seen: SeenStore,
  observedAt: string,
  creationCutoff: string | null,
  self: string,
  bootstrap = false,
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const sorted = [...issues].sort((a, b) =>
    (compareIso(a.createdAt, b.createdAt) ?? 0) || a.identifier.localeCompare(b.identifier),
  );
  for (const issue of sorted) {
    if (!issue.identifier || !issue.createdAt) {
      continue;
    }
    if (creationCutoff && !isoAtOrAfter(issue.createdAt, creationCutoff)) {
      continue;
    }
    const key = `issue-created:${issue.identifier}`;
    if (seen.has(key)) {
      continue;
    }
    const creator = issue.creator?.displayName || "unknown";
    // The configured team and managed scope were applied by the caller.
    // Self-created issues stay suppressed to prevent an echo.
    if (creator === self) {
      seen.add(key, observedAt);
      continue;
    }
    seen.add(key, observedAt);
    events.push(
      issueEvent(issue, observedAt, bootstrap),
    );
  }
  return events;
}
