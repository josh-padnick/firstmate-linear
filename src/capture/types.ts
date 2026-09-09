export type LinearComment = {
  id: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  user?: { id?: string | null; displayName?: string | null } | null;
  issue?: {
    identifier?: string | null;
    assignee?: { id?: string | null; displayName?: string | null } | null;
    project?: { name?: string | null; slugId?: string | null } | null;
  } | null;
  parent?: { id?: string | null } | null;
};

export type LinearHistory = {
  id: string;
  createdAt: string;
  actor?: { displayName?: string | null } | null;
  fromState?: { name?: string | null } | null;
  toState?: { name?: string | null } | null;
  fromAssignee?: { displayName?: string | null } | null;
  toAssignee?: { displayName?: string | null } | null;
  updatedDescription?: unknown;
  addedLabels?: Array<{ name?: string | null }> | null;
  removedLabels?: Array<{ name?: string | null }> | null;
  issue?: string;
};

export type LinearIssue = {
  identifier: string;
  title?: string | null;
  description?: string | null;
  updatedAt: string;
  createdAt: string;
  state?: { name?: string | null } | null;
  assignee?: { id?: string | null; displayName?: string | null } | null;
  creator?: { id?: string | null; displayName?: string | null } | null;
  project?: { name?: string | null; slugId?: string | null } | null;
  labels?: { nodes?: Array<{ name?: string | null }> | null } | null;
  history?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    nodes?: LinearHistory[] | null;
  } | null;
};

export type EventType = "comment" | "board" | "description" | "label" | "issue-created";

export type LedgerEvent = {
  kind: "fm-linear-event";
  version: 1;
  event: {
    type: EventType;
    issue: string;
    author: string;
    comment_id: string | null;
    history_id: string | null;
    parent_id: string | null;
    body_sha256: string | null;
    excerpt: string | null;
    // Full comment body, stored at capture time so handling never depends on an
    // ad-hoc API slice. Absent (undefined) means the record predates full-body
    // capture; `inbox show` then says so instead of passing the excerpt off as
    // complete. Historical records are never mutated.
    body?: string | null;
    from_state: string | null;
    to_state: string | null;
    from_assignee: string | null;
    to_assignee: string | null;
    description_updated: boolean;
    added_labels: string[];
    removed_labels: string[];
    title: string | null;
    labels: string[];
  };
  created_at: string;
  updated_at: string;
  captured_at: string;
  announced_at: string | null;
  // Which producer surfaced this event: the capture-time push or the timed
  // sweep. Absent on records written before push-at-capture existed.
  announced_via?: "push" | "sweep" | null;
  read_at: string | null;
  handled_at: string | null;
  handled_by: string | null;
  handled_note: string | null;
  observed_at: string;
  bootstrap: boolean;
  dedupe_key: string;
};

export type CursorState = {
  kind: "fm-linear-cursor";
  version: 1;
  comments_updated_at: string | null;
  issues_updated_at: string | null;
};

export type PollResult = {
  newEvents: LedgerEvent[];
  commentsMax: string | null;
  issuesMax: string | null;
  selfName: string;
  cursor: CursorState;
};
