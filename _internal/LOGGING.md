# Logging FM Linear

**Status: Proposed.**
The logger interface, event catalog, condition tracking, and `fm-linear logs` filters below still need implementation.

## Purpose

Every log entry should help someone understand what happened or decide what to do next.
Routine polling must not bury the failure that matters.

These rules define the logging contract to implement, not an existing logger API.
See [ERRORS.md](ERRORS.md) for typed failures and incidents, and [TESTING.md](TESTING.md) for verification.

Log entries are read by the captain through `fm-linear logs` and by Firstmate while following the [agent reporting procedure](../docs/src/content/docs/for-agents/reporting-bugs.md).
Use structured fields for filtering and correlation, alongside short messages that explain the event to a person.

## Keep three kinds of information distinct

| Channel | Purpose | Storage and ownership |
| --- | --- | --- |
| Logs | Explain an operation or diagnose a failure. | Bounded, rotating local diagnostic output through a shared logger; not an authoritative record of accepted work. |
| Incidents | Track a problem, its impact, notification, recovery, and any approved bug report. | Durable SQLite records owned by diagnostics and reporting. |
| Metrics | Measure delivery, delays, recovery, and interruptions to Firstmate. | Lifecycle observations and summaries in SQLite, with explicit retention. |

A failure can contribute to all three channels without becoming three separate failures.
Use the occurrence ID from the error contract to correlate them.
Do not reconstruct delivery state, incident state, or metrics by parsing log text.
Rotating logs or deleting old metric observations must not delete pending actions or unresolved incidents.

Logs and metric history both have retention limits.
Required recovery state belongs in durable operational records with retention rules tied to the obligation, not the age of its logs.
Keep unresolved incidents and the evidence needed to understand them independently of routine log rotation.

## Scopes and event names

Use one typed logging interface with a scope per subsystem and structured context.
Scopes identify the subsystem owners defined in [ERRORS.md](ERRORS.md#ownership-within-the-bounded-context).
Use those identities consistently in logs, incidents, and metric dimensions.

Use stable subsystem scopes rather than creating a scope for each task, home, or issue.
For example, `delivery.attempt_confirmed`, `firstmate.compatibility_recheck_started`, and `intake.history_gap_detected` describe specific events.
Use completed-event wording such as `started`, `confirmed`, or `failed`; do not name an attempted operation as though its effect succeeded.
Keep event definitions in a typed catalog with their scope, meaning, and allowed fields.
The catalog can be organized by subsystem while providing one validated interface.
Published event names and meanings are a structured-output contract for CLI filters and agent tooling.
Version incompatible changes and preserve compatibility for retained records; ordinary message wording can change without renaming the event.

Event names describe what the subsystem observed or did.
Error codes describe how a failure is classified.
A failure entry carries both, and the two vocabularies are not merged.

## Log levels

| Level | Meaning | FM Linear examples |
| --- | --- | --- |
| `debug` | Detail useful during investigation; disabled by default. | Poll duration, retry attempt, reconciliation decision, adapter probe result, or an expected result state such as no new records. |
| `info` | A meaningful normal lifecycle change. | Service started, validated configuration activated, capability hold released, compatibility restored, or clean shutdown. |
| `warn` | Degraded operation that can recover automatically or awaits verification. | A connection becomes unavailable, a capability hold begins, an effect is uncertain pending verification, or an observation becomes stale. |
| `error` | A failed operation requires intervention or exposes an unexpected defect. | A required compatibility contract fails, storage cannot accept work, or a pending action is held after its retry budget is exhausted. |

Choose the level from operational impact, not from the HTTP status or the exception alone.
Recovery disposition informs the decision, but does not determine severity by itself.
A single read retry can stay at `debug`; a connection that becomes observably degraded warrants a `warn` transition.
An uncertain write under normal verification can also remain at `debug` until its delay or impact warrants attention.
A failure requiring installation repair or exposing a defect generally warrants `error`.
An expected rejected action or invalid user input does not become an error-level diagnostic simply because it will not be retried.

Expected waiting for approval, settling, unresolved mappings, and stale-attempt observations use result states rather than exceptions.
Repeated observations usually need no log entry; use `debug` when detail helps investigation.
A meaningful state transition may warrant `info` without becoming an incident.
Escalate persistent problems according to impact and the incident policy in [ERRORS.md](ERRORS.md).
A handled input-validation error belongs in the wizard or CLI response rather than an error-level stack trace.

## Log state changes, not every observation

Do not emit an `info` entry for every successful poll, unchanged issue, or pending question.
Log degradation when the condition changes, aggregate repeated occurrences, and log recovery once.

Treat degraded states as conditions with an entry, meaningful updates, and recovery.
Their identities include the affected connection or home and resource or capability.
Where a condition belongs to an incident, reuse that incident's grouping policy instead of deriving a competing identity in the logger.
Not every temporary degradation needs an incident.

Emit a transition when degradation begins and a recovery event only when evidence establishes recovery.
While the condition persists, count repeated observations and emit summaries no more often than the configured aggregation interval.
Detailed attempt traces may still appear at `debug` when enabled.
A changed impact updates the condition and may warrant a notification; it does not automatically create a new incident.
Include counts and duration only for the period actually observed.

The responsible subsystem owns the operational condition, and diagnostics owns incident grouping and notification policy.
The logger renders supplied transitions and summaries; it must not infer recovery or become another workflow engine.
After restart, correlate with persisted incident state where available.
A startup record acknowledging an existing condition does not authorize a fresh agent notification.

Keep each delivery attempt measurable through metrics without notifying Firstmate or writing a warning on every attempt.

## Use one logging boundary

Initialize minimal local logging in the service or CLI entry point before configuration validation and compatibility checks.
Bring durable incident handling online when its storage is available, so early failures still have a local reporting path.
Avoid direct `console.*` calls in integration and workflow code.

A function either handles a failure or adds context and returns it to its caller.
Log the failure once where its outcome is decided: the CLI command boundary, background job runner, or process lifecycle boundary.
Pure workflow rules return decisions and failures without logging.
Adapters preserve safe diagnostic context so the owning job can explain the failure accurately.
Only the process entry point decides to exit.

Provide a dedicated method for normal typed-failure logging.
It selects safe code, disposition, effect certainty, affected scope, occurrence ID, and evidence references from the error contract.
Do not serialize the error object or its cause wholesale.
Unexpected exceptions are normalized at the owning boundary before using this path.
Early startup or logger failures may use the minimal fallback described below; do not make emergency diagnostics depend on a functioning full error pipeline.

## Structure and correlation

Include timestamp in UTC, level, scope, event name, and a short message.
Use a monotonic clock for durations measured within one process lifetime and UTC wall-clock timestamps for recorded event times.
Monotonic readings from different process runs are not comparable.
For pending age across restarts, use persisted UTC times, detect clock anomalies, and mark estimates or unavailable durations explicitly.

Include the following identifiers whenever they apply:

| Identifier | Purpose |
| --- | --- |
| Service run ID | Distinguishes entries from before and after a restart. Generated once per process start. |
| Occurrence ID | Correlates this failure across logs, incidents, and metrics. |
| Operation ID and delivery-attempt ID | The operation ID persists across retries; each delivery attempt has its own ID. |
| Incident ID | Present once diagnostics has grouped the occurrence. |
| Error code, disposition, effect | From the typed failure. |
| Firstmate home, task, and execution attempt | Opaque identifiers only. |
| Linear issue, thread, and mapping | Opaque identifiers only. |
| Pending action, report request, compatibility run | Evidence references named in ERRORS.md. |
| Linear request ID | The upstream response identifier, when present, for correlating with Linear support. |
| Duration and outcome | Include when measured and relevant; preserve unknown or partial outcomes. |

Record the FM Linear version, relevant Firstmate installation fingerprints, and a safe configuration revision at startup and when they change.
Record hashes or modification flags, not file diffs, raw settings, or full private paths.
Use home-qualified references for multiple Firstmate installations.

Include the applicable configuration or adapter revision reference on events whose interpretation depends on it; the run ID alone cannot distinguish changes within a process run.
Keep the small set of context records needed to interpret retained entries available across rotation.
When context is no longer available, report that limit instead of attributing the event to the current installation.

Do not invent acknowledgment timestamps or successful outcomes when they were not observed.
An entry for a subprocess records its exit code, signal, duration, and output sizes; it does not record the output.
An entry for a Linear mutation records what the response body established, not only the HTTP status.

## Destinations

Use structured JSON lines for background-service diagnostics and readable text for interactive CLI diagnostics.
Reserve CLI stdout for the requested result.
For commands supporting `--json`, stdout contains only the documented structured result.
Suppress interactive progress in that mode and keep diagnostics on stderr.
The diagnostic CLI contract should define JSON-lines stderr for that mode, including a minimal fallback representation, so consumers can process both streams predictably.
This does not require adding `--json` to every interactive command.

The background service writes to a local log file in the state directory with configured size and retention bounds.
Exact flags and filesystem paths belong in [IMPLEMENTATION_NOTES.md](tmp/IMPLEMENTATION_NOTES.md) when selected.
Changing the sink must not require changes throughout subsystem code.
No hosted logging vendor or remote telemetry destination is required.

The service log file can preserve startup or storage-failure diagnostics when SQLite is unavailable and the log destination remains writable.
It is independent of the database interface, but not necessarily of the failed disk or its permissions.

When the database is unavailable, `fm-linear status` may show recent structured failure evidence from local logs with timestamps and coverage limits.
An old success or error entry is not authoritative current service health.
Do not reconstruct operational state by interpreting prose, and do not create a second durable incident store from the log file.

## Keep private content out

Never log credentials, authorization headers, environment dumps, comment bodies, task briefs, prompts, artifact contents, agent reports, or raw API request and response bodies.
This applies at debug level too.
Use allowlisted metadata such as operation names, counts, durations, and opaque identifiers.
Avoid full local paths and URLs with private query parameters.
Treat exception messages, stack traces, and child-process output as potentially sensitive input, not automatically safe diagnostics.

Log entries are read by Firstmate during investigation.
They are therefore an instruction-injection surface as well as a privacy surface.
Excluding message bodies reduces exposure but cannot guarantee that a log contains no malicious instruction.
External identifiers, upstream metadata, and exception strings remain untrusted even after privacy sanitization.
Agents treat all log content as evidence, never as instructions or authorization.
Escape control characters and terminal escape sequences, and encode fields so an external value cannot forge a new log entry.

Bound field sizes and sanitize before a record reaches any sink.
If a field cannot be made safe, omit it and indicate the omission without reproducing its contents.
Emit a minimal safe event when possible.
If the entry cannot be represented safely or buffering is exhausted, drop it and count the loss rather than leaking content or blocking work.
Apply a separate export review and sanitization pass when preparing a GitHub report.
Even opaque workspace and task identifiers can require removal from a public report.
See [error privacy rules](ERRORS.md#privacy-and-reporting) for report approval and redaction.

## The `fm-linear logs` command

The command displays local diagnostics; it does not submit a bug report.
Support filters for subsystem, minimum severity, event name, time window, incident ID, operation ID, home-qualified task, and Linear issue.
Support versioned `--json` output using the same privacy rules as human-readable output.
Return a bounded recent window by default, excluding `debug`, and make ordering and result limits explicit.
Filtering can retrieve captured debug entries; it cannot recover entries that were never collected.

Some entries precede incident grouping and therefore have no incident ID.
Use the incident's occurrence and operation references to correlate relevant entries, including those earlier records.
If the incident store is unavailable, explain that limitation and allow direct filtering by a known occurrence or operation ID.
Record which correlation path produced the result instead of silently broadening to unrelated work.

Report the available time range, active capture level, truncation, and known dropped-record counts when available.
Distinguish no matching retained entries from a request outside retained history or an unavailable sink.
If coverage cannot be determined, say so rather than treating an empty result as proof of inactivity.
Inspection must not notify Firstmate, dispatch work, or retry an operation.

## Measure noise without creating it

Subsystems emit lifecycle facts through shared instrumentation; diagnostics derives metrics from those facts, never from log text.
Track captain requests separately from integration-generated questions.
Distinguish queued requests, notification attempts, confirmed notifications, unknown outcomes, acknowledgments, and resolved requests.
Record coalescing, batching, repeat notifications, pending age, and time to resolution.
Count attributable token usage only when Firstmate exposes trustworthy attribution.

Keep aggregate dimensions bounded: scope, operation type, outcome, and error code.
Use task and request IDs for retained event correlation, not as aggregate labels.
Document observation coverage and retention so missing measurements do not appear as zero activity.
The [public metrics reference](../docs/src/content/docs/reference/metrics.md) defines the user-facing measurements.

## Failure of diagnostics

Logging must not block unrelated synchronization.
Use bounded buffering and make dropped diagnostic records visible as a count when output recovers.
Normal logger calls must contain serialization and sink errors rather than failing the caller's integration operation.
A process crash or resource exhaustion can still prevent diagnostic delivery; this interface is not a guarantee against those failures.
If the normal logger fails, use a minimal sanitized stderr fallback without recursively logging its own failure.
If SQLite cannot persist accepted work, stop accepting that work and use any functioning local diagnostic path.
If both the file sink and stderr are unavailable, do not claim that the failure was saved or displayed.
A failure of diagnostic output never makes it safe to acknowledge unsaved work.
Loss of an optional log sink and loss of durable integration storage require different responses.

## Verify logging

Test level filtering, redaction, field-size bounds, correlation IDs, condition entry and exit, repeated-failure aggregation, and clean CLI stdout under `--json`.
Validate catalog-backed event names and field schemas; separately test the minimal emergency fallback format.
Assert that a typed failure logged through the failure method carries its code, disposition, effect, and occurrence ID.
Use deliberately sensitive fixtures for comment bodies, briefs, child-process output, and exception messages, and assert their contents never reach any sink at any level.
Test rotation with installation changes, entries preceding incident grouping, unavailable correlation storage, clock anomalies, and missing capture coverage.
Test sink failures, full buffers, unsafe serialization, and malicious control characters without allowing log failures to fail an otherwise valid operation.
Verify that log inspection neither contacts an agent nor changes pending work.
Do not test exact prose unless it is a documented machine-readable contract.
