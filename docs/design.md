# Firstmate and Linear: the essential design

## Purpose

Linear is the captain-facing system of record for every task performed by a Firstmate fleet.
Firstmate's files remain the local execution record, while the integration makes meaningful work, waits, decisions, and delivery state visible remotely within one service cycle.

The runtime guarantees workflow mechanics in code instead of relying on model memory.
Models interpret work and decisions, but scripts capture events, enforce read-before-write, relay keyed answers, derive board state, and retry side effects.

## Architecture

```text
Linear GraphQL
    | poll                         ^ conditional jobs
    v                              |
capture -> classify -> SQLite -> outbox worker
                         |
                         +-> local socket -> extension -> Firstmate process-event core
                         |
Firstmate .meta/.status ---------> mirror reducer
GitHub PR head/check/base --------> mirror reducer
```

There is one compiled `fm-linear` process under one LaunchAgent.
SQLite runs in WAL mode with full synchronization and is isolated behind `src/db/`.
The extension is a separate, immutable package bound by Firstmate and communicates with the service only through a private local socket.

## The two-ledger boundary

The service ledger owns Linear-domain facts and pending side effects.
Firstmate core owns transport durability, wake delivery, deduplication, and re-announcement.

For each source poll, `core_deliveries` binds Firstmate's stable request ID to one event.
A retry receives the same event.
When Firstmate classifies the captured result, the adapter records the actual core sequence.
An `act` or `inbox handle` transaction marks the domain event handled and creates a durable `core.ack` job.
Only that job invokes Firstmate's public `handled` command, so a crash cannot falsely complete both ledgers.

Silenced events are limited to `ignored` and successfully relayed `handled-by-service` records.
The adapter records their transport completion when Firstmate accepts the silent verdict.

## Inbound decisions

Captain authorship is matched against the configured Linear display name.
Only the complete normalized comment `approved` or `lgtm` is an approval, and only in a plan or deliverable approval status.
Every other captain comment in a gate returns ownership to Firstmate and remains meaningful input.

`inbox show` is the read gate.
It prints the full captured event and creates a receipt for exact IDs.
Text-bearing actions require the receipt, and a newer captain comment invalidates it before any job is committed.

A reply to one live mapped primary task can bypass the primary model when the relay preconditions prove the route.
The relay uses Firstmate's durable steering inbox and `--resolve-key` when a keyed decision is open.

## Outbound derivation

The scanner tails append-only `.status` files transactionally with per-file byte cursors.
It also reads task metadata and summary snapshots, and inspects pull requests by current head SHA.

The reducer treats decision, blocked, and failed signals existentially.
Completion is universal over primary tasks, support tasks never drive issue state, and `resolved` closes only its matching task key.

A pull request becomes reviewable only when it is open, its current head equals the recorded head, and every required check has passed or been skipped for that head.
A merge becomes done only when the target matches the expected base from task metadata or the worktree's origin default branch.

Every mutation is conditional on the last observed issue state and carries a causal event or observation in its deterministic key.
Captain-authored board transitions without a newer fleet signal are reported and never repaired.

Promises are staged with their reply jobs and become active only after Linear confirms the reply comment.
A terminal reply failure marks its staged promise failed, while a confirmed newer reply supersedes the prior active promise.
Promise reconciliation ignores earlier progress and the reply comment itself, and it requires a real transition for an expected board state.

## Failure behavior

Capture, classification, and initial jobs share a transaction.
Cursor overlap makes a crash before cursor advancement replay-safe.
Periodic full snapshots retain the incremental event overlap bound, so resyncs do not reinterpret older history as new activity.
Native Linear comment IDs let the worker verify an ambiguous success without posting twice.

Jobs retry with exponential backoff, deterministic jitter, server `Retry-After`, and a bounded dead-letter transition.
Claimed jobs carry a five-minute lease, so a service restart can recover work left in the running state without duplicating a confirmed side effect.
Escalation rungs have deterministic keys, so repeated cycles cannot flood a thread.

On a service gap longer than two poll intervals, the first cycle performs normal capture and reconciliation and records a `resumed` event for Firstmate.
Reports consume events and observations in database insertion order through independent row cursors and never mutate capture state.
