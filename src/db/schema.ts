export const SCHEMA_VERSION = 16;

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
  role TEXT,
  assignee TEXT,
  labels TEXT NOT NULL,
  agent_label TEXT,
  last_actor TEXT,
  last_signal TEXT,
  managed INTEGER NOT NULL DEFAULT 1,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (issue, observed_at)
);

CREATE INDEX IF NOT EXISTS issue_snapshots_latest_idx ON issue_snapshots(issue, observed_at DESC);

CREATE TABLE IF NOT EXISTS task_links (
  lifecycle_id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  issue TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'support')),
  worktree TEXT,
  harness TEXT,
  host TEXT,
  spawned_at TEXT NOT NULL,
  torn_down_at TEXT,
  status_start_offset INTEGER,
  status_end_offset INTEGER,
  status_start_identity TEXT,
  status_end_identity TEXT,
  meta_generation TEXT,
  busy_generation TEXT,
  blocked_meta_generation TEXT,
  blocked_busy_generation TEXT
);

CREATE INDEX IF NOT EXISTS task_links_issue_idx ON task_links(issue, role, torn_down_at);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('status', 'summary', 'pr', 'linear')),
  task TEXT,
  task_spawned_at TEXT,
  task_lifecycle_id TEXT,
  issue TEXT NOT NULL,
  verb TEXT NOT NULL,
  key TEXT NOT NULL,
  note TEXT,
  source_identity TEXT,
  source_offset INTEGER,
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

CREATE TABLE IF NOT EXISTS promises (
  id TEXT PRIMARY KEY,
  issue TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  expected_event TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  reply_job_id TEXT NOT NULL,
  reply_comment_id TEXT,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'open', 'kept', 'overdue', 'superseded', 'failed')),
  observation_id TEXT,
  superseded_by TEXT,
  stalled_event_id TEXT,
  source_watermarks TEXT
);

CREATE INDEX IF NOT EXISTS promises_issue_state_idx ON promises(issue,state,created_at);

CREATE TABLE IF NOT EXISTS steers (
  id TEXT PRIMARY KEY,
  issue TEXT,
  home TEXT NOT NULL,
  task TEXT NOT NULL,
  record_path TEXT NOT NULL,
  message TEXT,
  delivery_id TEXT,
  sent_at TEXT NOT NULL,
  acked_at TEXT,
  redelivered_at TEXT,
  stalled_event_id TEXT,
  waiting_on_host INTEGER NOT NULL DEFAULT 0,
  UNIQUE(home,task,record_path)
);

CREATE TABLE IF NOT EXISTS idle_episodes (
  id TEXT PRIMARY KEY,
  issue TEXT NOT NULL,
  task TEXT NOT NULL,
  lifecycle_id TEXT NOT NULL,
  turn_ended_at TEXT NOT NULL,
  status_identity TEXT,
  status_offset INTEGER NOT NULL,
  nudged_at TEXT,
  proxied_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS host_samples (
  host TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  load1 REAL NOT NULL,
  cores INTEGER NOT NULL,
  free_mb REAL NOT NULL,
  top_processes TEXT NOT NULL,
  PRIMARY KEY(host,observed_at)
);

CREATE TABLE IF NOT EXISTS host_states (
  host TEXT PRIMARY KEY,
  degraded_at TEXT,
  recovery_started_at TEXT,
  cleared_at TEXT,
  signature TEXT,
  event_id TEXT
);

CREATE TABLE IF NOT EXISTS service_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_rings (
  home TEXT PRIMARY KEY,
  installed_at TEXT,
  last_error TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_events (
  id TEXT PRIMARY KEY,
  issue TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  verdict TEXT NOT NULL,
  risk TEXT,
  reason TEXT,
  findings_count INTEGER,
  reviewers TEXT,
  review_cost REAL,
  policy_downgrade INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL
);
`;

export const MIGRATE_TO_V2_SQL = `
ALTER TABLE receipts ADD COLUMN event_rowid INTEGER NOT NULL DEFAULT 0;
UPDATE receipts SET consumed_at=COALESCE(consumed_at,issued_at);
`;

export const MIGRATE_TO_V4_SQL = `
ALTER TABLE promises RENAME TO promises_v3;
DROP INDEX promises_issue_state_idx;
CREATE TABLE promises (
  id TEXT PRIMARY KEY,
  issue TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  expected_event TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  reply_job_id TEXT NOT NULL,
  reply_comment_id TEXT,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'open', 'kept', 'overdue', 'superseded', 'failed')),
  observation_id TEXT,
  superseded_by TEXT,
  stalled_event_id TEXT
);
INSERT INTO promises(id,issue,source_event_id,expected_event,deadline_at,reply_job_id,reply_comment_id,created_at,state,observation_id,superseded_by,stalled_event_id)
SELECT id,issue,source_event_id,expected_event,deadline_at,reply_job_id,reply_comment_id,created_at,state,observation_id,superseded_by,stalled_event_id FROM promises_v3;
DROP TABLE promises_v3;
CREATE INDEX promises_issue_state_idx ON promises(issue,state,created_at);
`;

export const MIGRATE_TO_V5_SQL = `
ALTER TABLE task_links RENAME TO task_links_v4;
DROP INDEX task_links_issue_idx;
CREATE TABLE task_links (
  task TEXT NOT NULL,
  issue TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'support')),
  worktree TEXT,
  harness TEXT,
  spawned_at TEXT NOT NULL,
  torn_down_at TEXT,
  PRIMARY KEY (task, issue, spawned_at)
);
INSERT INTO task_links SELECT * FROM task_links_v4;
DROP TABLE task_links_v4;
CREATE INDEX task_links_issue_idx ON task_links(issue, role, torn_down_at);
`;

export const MIGRATE_TO_V6_SQL = `
ALTER TABLE observations ADD COLUMN task_spawned_at TEXT;
`;

export const MIGRATE_TO_V7_SQL = `
ALTER TABLE task_links RENAME TO task_links_v6;
DROP INDEX task_links_issue_idx;
CREATE TABLE task_links (
  lifecycle_id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  issue TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'support')),
  worktree TEXT,
  harness TEXT,
  spawned_at TEXT NOT NULL,
  torn_down_at TEXT
);
INSERT INTO task_links(lifecycle_id,task,issue,role,worktree,harness,spawned_at,torn_down_at)
SELECT 'link:' || lower(hex(randomblob(16))),task,issue,role,worktree,harness,spawned_at,torn_down_at FROM task_links_v6;
DROP TABLE task_links_v6;
CREATE INDEX task_links_issue_idx ON task_links(issue, role, torn_down_at);
ALTER TABLE observations ADD COLUMN task_lifecycle_id TEXT;
UPDATE observations SET task_lifecycle_id=(
  SELECT lifecycle_id FROM task_links
  WHERE task_links.task=observations.task
    AND task_links.issue=observations.issue
    AND task_links.spawned_at=observations.task_spawned_at
) WHERE task_spawned_at IS NOT NULL;
`;

export const MIGRATE_TO_V8_SQL = `
ALTER TABLE issue_snapshots ADD COLUMN managed INTEGER NOT NULL DEFAULT 1;
`;

export const MIGRATE_TO_V9_SQL = `
ALTER TABLE task_links ADD COLUMN status_start_offset INTEGER;
ALTER TABLE task_links ADD COLUMN status_end_offset INTEGER;
`;

export const MIGRATE_TO_V10_SQL = `
ALTER TABLE task_links ADD COLUMN status_start_identity TEXT;
ALTER TABLE task_links ADD COLUMN status_end_identity TEXT;
ALTER TABLE task_links ADD COLUMN meta_generation TEXT;
ALTER TABLE task_links ADD COLUMN busy_generation TEXT;
ALTER TABLE task_links ADD COLUMN blocked_meta_generation TEXT;
ALTER TABLE task_links ADD COLUMN blocked_busy_generation TEXT;
`;

export const MIGRATE_TO_V11_SQL = `
ALTER TABLE observations RENAME TO observations_v10;
DROP INDEX observations_issue_idx;
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('status', 'summary', 'pr', 'linear')),
  task TEXT,
  task_spawned_at TEXT,
  task_lifecycle_id TEXT,
  issue TEXT NOT NULL,
  verb TEXT NOT NULL,
  key TEXT NOT NULL,
  note TEXT,
  source_identity TEXT,
  source_offset INTEGER,
  observed_at TEXT NOT NULL
);
INSERT INTO observations(id,source,task,task_spawned_at,task_lifecycle_id,issue,verb,key,note,observed_at)
SELECT id,source,task,task_spawned_at,task_lifecycle_id,issue,verb,key,note,observed_at FROM observations_v10;
DROP TABLE observations_v10;
CREATE INDEX observations_issue_idx ON observations(issue, observed_at);
`;

export const MIGRATE_TO_V12_SQL = `
ALTER TABLE issue_snapshots RENAME TO issue_snapshots_v11;
DROP INDEX issue_snapshots_latest_idx;
CREATE TABLE issue_snapshots (
  issue TEXT NOT NULL,
  role TEXT,
  assignee TEXT,
  labels TEXT NOT NULL,
  agent_label TEXT,
  last_actor TEXT,
  last_signal TEXT,
  managed INTEGER NOT NULL DEFAULT 1,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (issue, observed_at)
);
INSERT INTO issue_snapshots(issue,role,assignee,labels,agent_label,last_actor,last_signal,managed,observed_at)
SELECT issue,NULL,assignee,labels,agent_label,last_actor,last_signal,managed,observed_at FROM issue_snapshots_v11;
DROP TABLE issue_snapshots_v11;
CREATE INDEX issue_snapshots_latest_idx ON issue_snapshots(issue, observed_at DESC);
`;

export const MIGRATE_TO_V13_SQL = `
CREATE TABLE IF NOT EXISTS steers (
  id TEXT PRIMARY KEY, issue TEXT, home TEXT NOT NULL, task TEXT NOT NULL, record_path TEXT NOT NULL,
  sent_at TEXT NOT NULL, acked_at TEXT, redelivered_at TEXT, stalled_event_id TEXT,
  waiting_on_host INTEGER NOT NULL DEFAULT 0, UNIQUE(home,task,record_path)
);
CREATE TABLE IF NOT EXISTS idle_episodes (
  id TEXT PRIMARY KEY, issue TEXT NOT NULL, task TEXT NOT NULL, lifecycle_id TEXT NOT NULL,
  turn_ended_at TEXT NOT NULL, status_identity TEXT, status_offset INTEGER NOT NULL,
  nudged_at TEXT, proxied_at TEXT, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS host_samples (
  host TEXT NOT NULL, observed_at TEXT NOT NULL, load1 REAL NOT NULL, cores INTEGER NOT NULL,
  free_mb REAL NOT NULL, top_processes TEXT NOT NULL, PRIMARY KEY(host,observed_at)
);
CREATE TABLE IF NOT EXISTS host_states (
  host TEXT PRIMARY KEY, degraded_at TEXT, recovery_started_at TEXT, cleared_at TEXT,
  signature TEXT, event_id TEXT
);
CREATE TABLE IF NOT EXISTS service_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_rings (
  home TEXT PRIMARY KEY, installed_at TEXT, last_error TEXT, checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_events (
  id TEXT PRIMARY KEY, issue TEXT NOT NULL, pr_url TEXT NOT NULL, head_sha TEXT NOT NULL,
  verdict TEXT NOT NULL, risk TEXT, reason TEXT, findings_count INTEGER, reviewers TEXT,
  review_cost REAL, policy_downgrade INTEGER NOT NULL DEFAULT 0, observed_at TEXT NOT NULL
);
`;

export const MIGRATE_TO_V14_SQL = `
ALTER TABLE task_links ADD COLUMN host TEXT;
`;

export const MIGRATE_TO_V15_SQL = `
ALTER TABLE steers ADD COLUMN message TEXT;
`;

export const MIGRATE_TO_V16_SQL = `
ALTER TABLE steers ADD COLUMN delivery_id TEXT;
`;
