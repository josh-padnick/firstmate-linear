# Insights plan

Analytics are deliberately separate from the operational runtime.
This release captures the durable inputs an insights system needs without adding dashboard or aggregation complexity to the service.

`task_links` records issue, task, role, worktree, harness, spawn time, and teardown time.
`observations` is append-only and retains status, summary, pull-request, and reconciliation signals.
`issue_snapshots` retains board-state history.
`events` retains captain activity and lifecycle disposition.
`jobs` retains attempts, completion, native identifiers, and dead-letter errors.

A future insights consumer should maintain its own `consumer_cursors` row, join harness transcripts by each task link's time window, resolve model and token usage from those transcripts, and produce durations, waiting stages, cost, throughput, and model-quality comparisons.
It must not advance the operational report cursor or prune source tables.
