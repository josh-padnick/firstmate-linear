export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source_cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  issue TEXT NOT NULL,
  type TEXT NOT NULL,
  token TEXT NOT NULL,
  author TEXT NOT NULL,
  body_sha TEXT,
  created_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN (
    'captured', 'classified', 'waiting-for-core', 'handled-by-service',
    'ignored', 'handled-by-core', 'failed'
  )),
  disposition_at TEXT NOT NULL,
  note TEXT,
  receipt_id TEXT,
  raw_ref TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_pending_idx ON events(disposition, created_at);
CREATE INDEX IF NOT EXISTS events_issue_idx ON events(issue, created_at);

CREATE TABLE IF NOT EXISTS core_deliveries (
  core_request_id TEXT NOT NULL,
  core_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  delivered_at TEXT NOT NULL,
  handled_at TEXT,
  PRIMARY KEY (core_request_id, core_seq),
  UNIQUE (event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS core_deliveries_request_idx ON core_deliveries(core_request_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  native_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);

CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS issue_snapshots (
  issue TEXT NOT NULL,
  state TEXT NOT NULL,
  assignee TEXT,
  labels TEXT NOT NULL,
  agent_label TEXT,
  last_actor TEXT,
  last_signal TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (issue, observed_at)
);

CREATE INDEX IF NOT EXISTS issue_snapshots_latest_idx ON issue_snapshots(issue, observed_at DESC);

CREATE TABLE IF NOT EXISTS task_links (
  task TEXT NOT NULL,
  issue TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'support')),
  worktree TEXT,
  harness TEXT,
  spawned_at TEXT NOT NULL,
  torn_down_at TEXT,
  PRIMARY KEY (task, issue)
);

CREATE INDEX IF NOT EXISTS task_links_issue_idx ON task_links(issue, role, torn_down_at);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('status', 'summary', 'pr')),
  task TEXT,
  issue TEXT NOT NULL,
  verb TEXT NOT NULL,
  key TEXT NOT NULL,
  note TEXT,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS observations_issue_idx ON observations(issue, observed_at);

CREATE TABLE IF NOT EXISTS consumer_cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  event_ids TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  event_rowid INTEGER NOT NULL,
  consumed_at TEXT
);
`;

export const MIGRATE_TO_V2_SQL = `
ALTER TABLE receipts ADD COLUMN event_rowid INTEGER NOT NULL DEFAULT 0;
UPDATE receipts SET consumed_at=COALESCE(consumed_at,issued_at);
`;
