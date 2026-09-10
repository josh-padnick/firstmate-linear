# FM Linear implementation notes

## Scope

This document records concrete implementation guidance, unresolved integration details, and verification expectations for the new design.
Read [ARCHITECTURE.md](../ARCHITECTURE.md) for subsystem responsibilities and core design decisions, and [TECH_STACK.md](../TECH_STACK.md) for technology choices.
These notes describe intended behavior and research findings, not a claim that the implementation is complete.
Reference code informs the design without defining it.
Shared practices for [testing](../TESTING.md), [logging](../LOGGING.md), and [error handling](../ERRORS.md) apply across the subsystems.

## Setup: refer to work by Linear issue identifier

Offer a setup preference, enabled by default, asking Firstmate to refer to linked work by its Linear issue identifier and a short description, such as `BIG-299: Add team invitations`.
Let users customize or disable this preference independently of stage-specific workflow instructions.

Setup owns the option; the Firstmate adapter installs the standing instruction in the selected home's `data/captain.md`, preserving existing preferences and avoiding duplicate entries when setup is rerun.
Firstmate's `bin/fm-session-start.sh` includes these preferences in its startup context.
The work and conversation context subsystem supplies the actual issue identifier and URL with applicable briefs and messages; the adapter carries that context without owning the Linear mapping.

Suggested instruction:

> When discussing work linked to Linear, identify it by its Linear issue identifier and a short description, for example, “BIG-299: Add team invitations.”
> Link the identifier to the issue when possible.
> If no Linear issue is linked yet, use the task's description; never invent an identifier.

Code supplies verified identifiers consistently, but following the communication preference remains agent behavior and cannot be guaranteed for every response.
This is a setup requirement for a later milestone, not an expansion of the first adapter milestone.

## Polling and retrieval

Poll each configured Linear connection every 30 seconds by default.
Expose a configurable interval, validate supported bounds, and honor API rate limits regardless of the requested cadence.
The setting name and bounds remain to be selected.

Run a catch-up scan on startup before beginning the regular polling schedule.
Do not overlap scans for the same connection or build an unbounded backlog of missed poll ticks.
Keep slow scans from blocking delivery and publication for other work.
Respect API rate limits and use bounded retries with backoff during failures, making any resulting delay visible.
The configured interval is the normal retrieval cadence, not a guarantee of agent response time.

Persist retrieval progress, use overlapping query windows where needed, and advance progress only after fetched records are durably accepted.
Verify coverage for comments, edits, reactions, and issue fields rather than assuming every change advances the parent issue's timestamp.
Handle pagination and interrupted scans without skipping records.
Polling cannot reconstruct deleted content or intermediate transitions that Linear's retrieval interfaces no longer expose.
Preserve uncertainty when evidence is unavailable.

## API boundaries and publication

Preserve author identity, workspace, issue, thread, entity revision, and available occurrence timestamps.
Record input durably and deduplicate repeated delivery.

The local service uses its own credentials and configured Linear API destination to retrieve records.
Validate API responses and apply configured workspace, enrollment, actor, and approval-scope checks before taking action.
Identify integration-authored updates so they do not create feedback loops.
Keep external API operations in a narrow client shared with intake, with explicit handling of pagination, rate limits, timeouts, and ambiguous write results.
Keep response validation and operation types beside that client.
Use stable action identities and verify ambiguous results before repeating a write.
Check the current issue state before applying an action that could have become stale.

## FirstMate compatibility and dispatch

See [FIRSTMATE_COMPATIBILITY.md](FIRSTMATE_COMPATIBILITY.md) for the current contract investigation and the prepared-brief coverage decision.

Keep the extension adapter thin and verify its installation and runtime requirements against the supported upstream contract.

FirstMate's process-event extension is the established candidate for inbound evidence delivery.
That extension does not provide a general instruction-injection or worker-launch capability.
The dispatch integration described below requires further verification.

The inspected FirstMate version launches workers with task briefs.
Its [extension contract](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md) explicitly excludes instruction injection and before/after hooks.
The brief is a candidate integration point.
Use the [preparation handshake and recovery design](#brief-preparation-handshake-and-recovery).
Prepared text can reach the worker, but Firstmate must choose to call the preparation command; the extension contract cannot enforce that choice.

Verify a supported path that includes the applicable requirements before the worker begins, including restart and alternate-dispatch cases.
An instruction telling FirstMate to remember a template is insufficient proof.
If the existing interfaces cannot enforce inclusion, document the limitation and revisit the mechanism without making upstream changes a prerequisite.

## Assisted bug reporting

Extend durable incident handling beyond compatibility checks to unexpected errors and persistent integration failures.
Code captures bounded diagnostic evidence and groups repeated failures by stable incident identity.
Normal retries for transient connectivity problems should not create repeated bug-report prompts.
Use the configured notification routes to surface a draft and request publication approval; keep a local draft available when Firstmate or Linear cannot receive the notification.
Persist incident, draft revision, approval scope, submission attempts, and confirmed GitHub URL separately.
An approval applies to the reviewed destination and exact report content, including attachments; material changes require renewed review.
Preserve declined drafts without prompting again for the same unchanged incident.
An uncertain GitHub response requires checking for a successful prior submission before retrying.
Automatic operational Linear issues remain outside normal task enrollment and do not authorize public GitHub publication.
Use [the agent reporting procedure](../../docs/src/content/docs/for-agents/reporting-bugs.md) for investigation, duplicate checks, data minimization, classification, and review.
Do not require an agent call merely to collect every low-level error or metric; request investigation only when it helps resolve or explain the incident.
Runtime detection, authenticated GitHub submission, and approval delivery still require implementation.

## Message delivery milestones

Track these milestones separately when recording delivery progress and diagnosing a delay.

| Milestone | What it establishes |
| --- | --- |
| Comment captured by FM Linear | The integration has saved the Linear input. |
| External event captured by Firstmate | Firstmate has captured the supplied evidence; handling may still be pending. |
| Message recorded for a worker | The applicable inbox handoff succeeded; the worker may not have acted yet. |
| Agent response received | The agent supplied a response; acknowledgment alone does not establish completion. |
| Requested change verified | The relevant result supports closing that particular request. |

Approval grants scoped permission; it does not prove that implementation started, validation passed, or a PR merged.

## Reports for missing task outcomes

Prefer existing task records and worker-state observations when they establish the required facts.
When a necessary outcome is missing, persist a report request before asking Firstmate to inspect the task through the process-event path.
Identify the request, Firstmate home, task, execution attempt, specific missing information, and evidence already observed.
For example, a worker stopping can trigger a question about its outcome and deliverable without establishing that implementation completed.

Firstmate should inspect the result and submit a structured report tied to that request and attempt, including the outcome, uncertainty, and relevant artifact references.
An explicit FM Linear reporting command is the proposed submission mechanism.
Its name, input schema, and invocation contract remain to be designed and implemented; do not document it as an existing command or assume Firstmate's event handler automatically returns this report.
The missing-outcome contract does not by itself define delivery of every conversational reply or unsolicited progress update.

Validate report structure, request correspondence, source, and attempt before saving the response and applying workflow rules.
Schema validity does not establish semantic truth, artifact accessibility, captain approval, or completed delivery.
Keep unresolved facts open when a report is incomplete or uncertain, and preserve older-attempt reports without letting them drive a newer attempt.
Track question delivery separately from receipt and acceptance of an adequate report.
Expose pending requests and follow-up needs while allowing unrelated synchronization to continue.

Persist request identities across retries and restarts, and deduplicate repeated accepted reports and their publication effects.
Verify missing replies, acknowledgments without answers, invalid and partial reports, stale-attempt responses, repeated submissions, and crashes between saving a report and publishing its resulting updates.

## Task dependency synchronization

The inspected Firstmate revision already models dependencies through its backlog.
Its [backlog configuration](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/configuration.md#L90-L113) selects a default `tasks-axi` backend and describes the dependency-aware dispatch gate and manual-backend exceptions.
Its [decision-hold implementation](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-decision-hold.sh#L70-L73) reads `blocked_by` from task records and [removes specific dependency edges](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-decision-hold.sh#L147-L174) when routing a recorded decision.
These are source findings, not a completed FM Linear dependency adapter.

Prefer a compatible task-query interface against the home's configured backlog backend.
Do not assume every home uses `data/backlog.md`, or that a display-only list of currently unresolved blockers is the complete dependency graph.
Verify whether the selected interface returns declared edges, unresolved edges, or both, including how completed and archived tasks affect the result.
Qualify identities by Firstmate home and preserve identity through supported task transfers.
Derive Linear's blocks and blocked-by views from one directed relationship, then deduplicate edges when several tasks map to the same issue.
Keep unresolved issue mappings visible and retry once both ends are connected; do not enroll unrelated work or create self-links merely to complete the graph.

Suggested persistent Firstmate guidance, to be installed through the same documented preferences mechanism as other integration guidance:

> When organizing work, record explicit task dependencies in your configured backlog using stable task IDs.
> Update those records when dependencies change, and distinguish task dependencies from other reasons for waiting.
> If a dependency cannot be recorded there, report the blocked task, the prerequisite task, and what must happen before work can proceed.
> Leave Linear relationship updates to FM Linear.

This is proposed FM Linear guidance, not a built-in Firstmate instruction or a guarantee that all dependencies will be reported.
Do not ask Firstmate to rewrite dependency lists that the adapter can already read.
If fallback reporting is needed, define a validated report with home-qualified task IDs, source and freshness, and explicit add/remove or complete-snapshot semantics.
An omitted dependency in a partial report must not delete an existing relationship.
The exact command or report schema is deferred until the dependency adapter is implemented.
Missing or unsupported observations remain unknown and diagnosable.

Reconcile only relationships FM Linear owns, with explicit handling for captain edits and incoming Linear dependency requests.
Do not release a running task or declare it ready solely because a Linear relationship was removed.
Verify dependency addition, confirmed removal, completed prerequisites, unreadable sources, duplicate delivery, missing issue mappings, multiple tasks per issue, manual relationships, and handoffs between Firstmate homes.

## Issue execution context

Support configurable publication of the Herdr panel name in an issue's managed execution-context section.
Resolve panel display data through the FirstMate adapter using the recorded backend endpoint, home, host, task, and attempt identity.
Verify the exact upstream lookup before implementing it; a label alone must never select a delivery target.
Distinguish pane, tab, and workspace labels in the adapter while presenting a clear panel reference to the user.
Retain enough host or session context to distinguish similarly named panels.
Mark unavailable observations and historical attempts explicitly; refresh the current reference when a worker is replaced.
Preserve human-authored issue content and retain multiple task references when an issue has several contributors.
Only publish a clickable panel link when a supported navigation mechanism is verified.
Herdr-specific display information is optional and must not prevent another FirstMate backend from working.

## Linear identity and handoffs

Keep the authenticated publishing actor distinct from the account mapped to the next action.
Support selecting an existing dedicated FirstMate user in the recommended assignee-switching workflow; do not silently provision a workspace member.
Linear's [app actor authorization](https://linear.app/developers/oauth-actor-authorization) can provide application authorship without a separate human account.
Its [agent model](https://linear.app/developers/agents) uses delegation rather than replacing the human assignee, so it needs an explicit workflow mapping rather than pretending the identities are interchangeable.
Do not imply that OAuth app authorship implements the webhook-driven agent-session experience.
Validate the final authentication, permission, and assignment paths against the polling-only design before documenting them as supported setup options.

## Wizard workflow selection and status creation

Offer both the recommended workflow and a custom workflow in setup.
After the user selects a Linear team, fetch that team's actual workflow statuses rather than assuming the recommended names exist or that every status must be created.
Show the proposed stage-to-status mappings, distinguish reusable existing statuses from missing ones, and resolve ambiguous or incompatible matches explicitly.
Keep this operation scoped to the selected team.

When recommended statuses are missing, show the exact proposed additions and ask: “Would you like us to create the following Linear statuses to match the recommended workflow?”
Include each proposed name and Linear status category in the review so creation does not hide consequential settings.
Create only the approved missing statuses after the user selects “Yes, create these statuses.”
Preserve existing statuses and issue assignments; setup must not rename, delete, or migrate existing statuses without a separate explicit request.
If no statuses are missing, skip the creation prompt.
If the user declines, allow mapping to existing statuses or returning to workflow customization.

Verify that the publishing account and its credentials permit the requested creation.
When they do not, explain the missing access and allow the user to create the listed statuses manually and refresh the inventory.
Resolve final mappings to confirmed Linear status IDs before saving the active configuration.
Recheck for statuses created since the initial inventory, and reconcile partial or ambiguous creation results before retrying so rerunning setup does not create duplicates.
Do not report incomplete provisioning as a successfully configured workflow.

## Configuration files and activation

Expose configuration operations through the CLI so FirstMate can validate and activate user-requested changes.
Keep configuration and instruction templates readable and editable.
Executable rules remain in code; arbitrary user scripts are not required for the initial customization model.
Select authentication and credential storage during installation design, and keep credentials out of workflow files and diagnostic exports.

Use a per-user configuration directory outside project repositories so one installation can serve several projects and FirstMate homes.
Use `config.yaml` in these locations:

| Platform | Default path |
| --- | --- |
| macOS | `$XDG_CONFIG_HOME/fm-linear/config.yaml`, falling back to `~/.config/fm-linear/config.yaml`. |
| Linux | `$XDG_CONFIG_HOME/fm-linear/config.yaml`, falling back to `~/.config/fm-linear/config.yaml`. |

These paths describe the intended design, not an implemented interface.
On macOS and Linux, `XDG_CONFIG_HOME` is an optional environment variable specifying the user's configuration directory.
Use it when it contains an absolute path; otherwise use `~/.config` when it is unset or empty and report a relative value as invalid configuration.
Users do not need to set the variable for normal operation.
An explicit `--config` path takes precedence over the platform default.
Record the resolved configuration path when installing the service so the service and CLI use the same file even when their environments differ.
Provide CLI operations to show that path, inspect effective configuration, and validate or activate edits.
Do not automatically load operational settings from an untrusted repository.
Keep credentials in a separate protected credential store, referenced by configuration rather than embedded in it.
Keep database state and delivery cursors separate from user-editable configuration.

No intake-mode selection or endpoint configuration is needed.
Store workflow profiles and instruction templates alongside configuration as needed, without mixing instructions into credential storage.
Activate validated changes atomically and retain the last valid configuration and its version.
Preserve pending work and retrieval progress across configuration changes.

## Persistence and scheduling

Store the database in a persistent user data directory outside the compiled executable.
Use WAL mode, foreign keys, bounded lock waits, and durable transaction settings.
Record observations and their required actions atomically where they form one accepted obligation.
Keep transactions short and avoid holding them open across network requests.
Persistent inbox and outbox records provide delivery recovery without requiring a separate queue service.

Schedule intake, FirstMate delivery, observations, external checks, and outgoing writes independently with bounded work per cycle.
Slow PR checks or an unavailable source must not prevent unrelated queued work from progressing.
Measure capture and delivery delays separately from agent scheduling and response time.

## Platform installation and local interfaces

Support installation, startup, shutdown, upgrades, and diagnostics on macOS and Linux.
Keep operating-system-specific service management behind platform adapters with consistent CLI behavior.
Choose and verify the service mechanism for each platform during implementation.
Handle filesystem paths, permissions, process control, and local communication without assuming Unix behavior.

Provide human-readable CLI output and a versioned JSON mode for agents and other tools.
Local process messages need explicit request identities, protocol versions, and error responses.
Keep their protocol independent of the platform-specific transport.

## Artifacts

Support textual plans and reports and self-contained interactive HTML review guides when the workflow requests them.
Planning tools and presentation frameworks remain configurable rather than mandatory plugin dependencies.

Durable artifact storage and hosting remain to be selected.
Verify that future agents and intended reviewers can access each delivered artifact outside the originating worktree.

## Diagnostics

Use structured logs with event, action, task, and issue identifiers.
Keep durable delivery records independent of log retention so clearing logs cannot lose pending work.
Ordinary operation must not require a hosted telemetry service.

## Integration metrics and attention policy

Diagnostics owns metric definitions, aggregation, local summaries, and the structured export.
Reuse the operational SQLite database for lightweight event history and derived aggregates.
Record lifecycle facts in code without requesting extra agent reports for the sole purpose of measurement.
Use the public [Metrics reference](../../docs/src/content/docs/reference/metrics.md) as the human-readable definition of each measure.
Its activity mapping and the task-brief and message pages define the instrumentation required for each integration path.
Also collect preparation attempt/result/duration, launch comparison verdicts, poll/query attempt/result/duration and observation coverage, and Linear publication attempt/result/pending age.
Keep worker inbox handoffs distinct from notifications to Firstmate; missing upstream observations remain unavailable.
Separate adequate report acceptance from partial, uncertain, invalid, or stale-attempt responses and deduplicate repeated accepted submissions.
For launch preparation, report matching, mismatched, and unknown observed cases, with verified coverage computed only over matches plus confirmed mismatches and unknown coverage shown alongside it.

Collect request creation and first send, candidate resolution from existing records, batch membership, delivery attempt, observed notification emission, acknowledgment, adequate report acceptance, and unresolved follow-up state.
Record stable event, request, attempt, and batch IDs; Firstmate home and task identity; request origin and purpose; urgency and workflow stage; timestamps; result and resolution source; and optional source-backed usage attribution.
Track notification observation coverage and event-schema version so unavailable periods and changed definitions do not silently become zero activity.
Keep full message bodies, prompts, artifact contents, and credentials out of metric records.

One logical request may have several delivery attempts, and one notification may carry several requests.
Deduplicate reprocessed lifecycle events by their event identities without collapsing distinct retry attempts.
Count notification batches once and preserve their request membership, including mixed captain/integration batches.
Do not count enqueueing, process-event capture, or a successful API poll as an observed notification to Firstmate.
The exact notification observation point must be verified against the upstream adapter; unavailable evidence produces an unknown value.
Do not infer agent turns, attention time, or attributable tokens from notification counts.

Count tasks with observed activity during the requested interval, qualified by home and stable task identity, independently of how many execution attempts they used.
Count integration requests first sent during that interval and show both numerator and denominator.
Normalize notification frequency by monitored hours, with explicit missing-coverage information.
Return unavailable for a zero or unknown denominator.
For report turnaround, use first notification to accepted adequate report, group by first-notification cohort, and show unfinished request counts and ages as of the summary time.
Requests answered by existing evidence before any send belong in the avoided-contact count; do not estimate counterfactual avoided questions.

Persist metric facts with the operational transition when they describe the same local transaction, or derive them from the durable transition record so a crash cannot silently lose one side.
External side effects retain their attempted/confirmed/unknown distinction; local commit alone cannot establish remote notification.
Keep aggregates reproducible from retained events, and version definitions and time-window semantics in exports.
Bound storage with a retention policy that keeps required operational deduplication records and unresolved requests independently of completed metric-history retention.
Choose concrete retention defaults and export commands during implementation, and identify incomplete history in summaries.
Console consumes a versioned read-only summary/event export, not private database tables.

Avoid creating noise in the measurement mechanism or the workflow it observes.
Allow a bounded settling period for native task records before sending a missing-outcome question, coalesce repeated observations by fact and attempt, and group routine questions for one Firstmate home.
Prioritize human feedback, approvals, and pause/cancel requests; do not hold them behind routine batches.
Once Firstmate has acknowledged the intake question, track the unresolved report separately without repeated announcements merely because its outcome is still pending.
Verify the event-handling contract before mapping that acknowledgment to any upstream `handled` operation; do not claim the substantive question is resolved.
Use bounded follow-up and surface persistent pending work through diagnostics rather than unlimited reminders.
Recognize integration-authored Linear updates to prevent echo loops.
Exact settling windows, batch limits, and reminder budgets remain implementation choices informed by measured usage.

Verify batch attribution, mixed origins, duplicate capture, retries, restart boundaries, response-before-notification cases, stale-attempt responses, missing observation coverage, zero activity, retained pending requests, and token usage that cannot be attributed.
Confirm that enabling local metrics does not create any Firstmate notifications, agent calls, or hosted telemetry uploads.

## Verification

Test workflow rules, adapter contracts, and integration behavior with real temporary database files.
Exercise duplicate input, crashes, restart recovery, stale actions, threaded replies, and partial publication failures.
Test the actual FirstMate extension process and supported upstream versions, especially requirement delivery before dispatch.
Test the default 30-second cadence, configured intervals, invalid-interval rejection, non-overlapping scans, pagination, rate-limit backoff, and offline catch-up.
Verify authorization checks on fetched records and shared configuration between CLI and service.

Run automated checks, integration tests, and compiled-binary smoke tests on macOS and Linux.
Verify installation, service lifecycle, local communication, and restart recovery on each operating system before claiming release support.
Document supported operating-system versions and CPU architectures explicitly.
Add browser tests if FM Linear introduces its own browser UI.

## Maintainer compatibility verification

Complete compatibility verification before claiming support in a release.
Rerun affected suites when the FM Linear adapter, its contracts, or supported Firstmate code changes.
Maintainers own these checks; users should receive supported capabilities, useful runtime diagnostics, and known limitations rather than a development checklist.

The coverage checklist moved from the public Compatibility page is:


- **Task-brief preparation.**
  The existing brief-copy path is verified, but ensuring preparation on every dispatch remains unresolved.
  See [Updating task briefs](/reference/firstmate/).
- **Task tracking.**
  Automatic coverage for independently created child tasks, replacement attempts, and work moved between homes still needs verification.
- **Observations and dependencies.**
  Task queries must be verified for the selected backlog backend, including whether they return a complete dependency graph or only unresolved blockers.
  Missing observations remain unknown.
  See [Synchronizing issues](/reference/synchronization/).
- **Message delivery.**
  The process-event binding, selected worker-message path, acknowledgment, and retry semantics need verification for each supported target.
  See [Sending messages](/reference/messages/).
- **Reports and optional execution details.**
  The structured reporting interface and Herdr panel lookup still need implementation and verification.
  An available upstream script does not establish coverage of the entire integration.

Use actual upstream commands against isolated Firstmate homes, temporary task data, repositories, and SQLite databases.
Verify content and behavior, not only the presence of filenames or matching source text.
Exercise brief and launch paths, message and event handling, state and dependency queries, identity mapping, retries, and restart recovery.
Run the applicable tests and compiled-binary smoke checks on macOS and Linux.
Perform an explicitly authorized end-to-end validation using a task, worker assignment, Linear update, comment, and response before claiming that live integration path works.
That live validation is separate from the safe local compatibility command.
Passing sample dispatches cannot establish universal agent invocation of the preparation step; an enforceable mechanism or a documented limitation is still required.

## `fm-linear test` compatibility command

Define `fm-linear test` as the user-facing entry point for checking the installed Firstmate integration contracts.
This is a proposed command, not an implemented CLI feature.
Use a versioned contract suite owned by the Firstmate adapter, shared by setup, change-triggered service checks, and the manual command.
Resolve the configured Firstmate home and its actual code root; never test a newly fetched remote revision in place of the code the integration will use.

Record the FM Linear build and suite version, Firstmate commit, relevant dirty-file fingerprints, selected backend and harness profile, capability selection, platform, tool prerequisites, and check timestamps.
A commit hash alone is insufficient when locally modified integration files or relevant configuration differ.
Keep results in the existing SQLite database and expose a human-readable capability report plus a versioned structured form.
Use stable check IDs and show expected versus observed behavior with passed, failed, or not-verified outcomes.
A required capability that fails, lacks prerequisites, or could not be exercised must prevent an overall success result; optional unchecked capabilities must remain explicitly labeled.
Return success only when all required applicable checks pass, and define stable nonzero failure/inconclusive exit semantics during implementation.

Separate read-only inventory checks from behavioral probes.
Run behavioral probes against an isolated snapshot of the exact relevant installed code, including applicable local changes, with temporary homes, repositories, inboxes, and databases.
Use fake harnesses and external services; do not pass live credentials or inherited destinations to the fixture environment.
Constrain probes to their isolated data and processes so upstream scripts cannot target live homes, workers, projects, or Linear.
Use time and output bounds, preserve useful failure evidence, and clean up only resources the test owns.
Verify brief preservation and launch-copy behavior, state-query response meaning, process-event handshake and capture, selected worker-message confirmations and retries, and dependency retrieval semantics.
Unavailable fixtures or unsupported paths are not verified, not silently passed.
A filesystem or source-pattern check alone does not establish behavioral compatibility.

Run applicable checks on every service start and restart before enabling dependent synchronization, including setup's Save and start path.
Start diagnostics and incident handling before the capability gate so failure does not prevent reporting.
Detect installed code and configuration changes during normal service operation and invalidate affected cached results, including after FM Linear or its suite changes.
Monitor the actual installed HEAD, relevant local file fingerprints, and configuration; a change on remote main alone does not require action.
During a service session, coalesce repeated observations into one bounded run for a stable installation fingerprint rather than probing every polling cycle.
Use a short settling period for an in-progress checkout update, with a bounded wait and a visible not-verified result if it never stabilizes.
Pause affected operations immediately on invalidation, rerun checks within the service, and resume only after a matching successful result.
Do not restart the entire service merely to rerun tests; reload adapter-specific cached state as needed without losing pending work or diagnostics.
Snapshot the inputs consistently and compare the fingerprint again before publishing a result; a concurrent upstream update must not receive a pass for different code.
Do not fetch, reset, checkout, or update Firstmate as part of testing.

Gate only operations depending on failed or unverified required contracts, preserving their pending actions while independent supported work continues.
Verify the relevant fingerprint before relying on a cached result, and document how unavoidable concurrent code changes are handled safely at the invocation boundary.
Emit one meaningful diagnostic for a new incompatibility, update its resolution state, and avoid repeated Firstmate prompts for unchanged failures.
Compatibility runs should add check count, duration, and verdict metrics without additional agent calls; identify any failure notifications separately from routine clarification requests.

### Background compatibility incidents

Persist a compatibility incident and its notification attempts in SQLite before attempting any external delivery.
Setup should confirm the notification policy, captain identity, Linear destination, and local desktop notification preference.
For failures blocking configured synchronization, recommend one Urgent Linear issue assigned to the captain, plus a Firstmate notification when the selected messaging capability remains verified.
Do not classify an unused optional capability as an urgent outage.
Include expected and observed behavior, versions, affected operations, and actionable next steps while excluding credentials and unrelated private issue content.
Keep the direct Linear diagnostic publication path independent of the Firstmate adapter and its failed capability gate.
If Firstmate messaging is affected or unverified, skip that route and record why; do not assume the broken integration can raise its own alarm.
Support a local desktop notification when enabled and permitted, with persistent status and logs as the baseline when external channels cannot deliver.
Use stable incident identities across checks and restarts, update the same Linear issue, and verify ambiguous creation results before retrying.
Exclude diagnostic issues from normal task enrollment to prevent recursive incident creation or automatic repair dispatch.
Retry undelivered alerts within bounded backoff and surface their delivery state separately from the compatibility failure.
Publish a recovery update only after fresh checks pass for the installed fingerprint, preserving the incident history.
Quiet unchanged incidents; notify on material impact changes or recovery rather than every failed probe.
Creating an operational workspace issue is distinct from submitting a public GitHub report, which still requires the user's review and approval.

Keep the guarantee bounded: tested local contracts do not prove universal brief preparation, agent compliance, live authorization, every task-discovery path, or every remote backend.
Maintain the public [Compatibility page](../../docs/src/content/docs/reference/compatibility.md) around that distinction.
Exact runtime hooks, fingerprint dependencies, report schema, and command implementation remain work to complete.

## Test harness construction

[TESTING.md](../TESTING.md) guides test selection and [TEST_REQUIREMENTS.md](../TEST_REQUIREMENTS.md) identifies the required evidence by capability.
This section records construction guidance for the proposed fixtures; those fixtures are not implemented yet.
Move concrete commands and helper usage beside the harness when it exists, retaining a pointer here.

### Boundary fixtures

Build small controllable fakes at external I/O boundaries as the corresponding adapters are implemented.
Reuse fixture builders and failure scenarios where they express the same contract, while giving each test isolated state.
Do not require a complete integration simulator before the first subsystem can be tested.
Each fake exposes relevant failure modes from ERRORS.md so tests can name the scenario without duplicating response construction.
Mock the external boundary, not the modules whose composition the test is intended to prove.
A fake HTTP server can prove retry handling; it cannot prove that Linear accepts the query or mutation.
Label these limits in test names and reports.
Use explicit fault injection at these boundaries instead of production flags that manufacture failures on real tasks.

| Boundary | Scenarios to exercise as support is implemented |
| --- | --- |
| Linear test server | Validated success; GraphQL errors in a successful HTTP response; partial effects; rate limits with verified retry guidance; timeout before or after a write takes effect; interrupted pagination; malformed responses; unresolved write outcomes. Model duplicate-submission and history-gap behavior only for interfaces whose contracts establish it. |
| Firstmate fixture | Parseable task and backlog files; schema-changed files; `fm-crew-state.sh` non-zero exit or unparseable output; `fm-procevent.sh` exit 0 without capture confirmation; `fm-send.sh` path with unverified confirmation; report that is incomplete, mismatched, or for a stale attempt; installed checkout change during a run. |
| Real SQLite and storage fault injection | Transaction rollback, lock contention, read-only access, capacity limits, interrupted migrations, and corrupt temporary files. Exercise SQLite behavior with real databases; inject failures at the storage boundary when the physical condition is impractical to reproduce. |
| Log sink and stderr | Unwritable file; unavailable stderr; both sinks failing; buffer exhaustion; serialization failure; control characters and terminal escapes. |
| GitHub submission | Success with URL; auth unavailable; timeout after creation; search unavailable. |
| Clock | Injected wall clock and monotonic clock; backwards wall-clock step across a restart. |

### Test isolation

Record relevant calls at controlled boundaries so tests can assert that prohibited mutations, launches, or notifications were not attempted through them.
Call recording supplements isolation; it does not prove that code could not bypass a fake.
Remove inherited credentials and live destinations, constrain filesystem and process access, and restrict network access to the test endpoints.
Verify those restrictions with negative probes before running upstream behavioral fixtures.
If the required isolation cannot be established, do not run the probe or report its contract as verified.

Give every test its own home, configuration, database, and external identifiers.
Clean up processes and files even when an assertion fails.
Never load the developer's normal credentials or operate on their live Firstmate home.

Run Firstmate behavioral probes against isolated copies of the exact relevant code, with controlled homes and harnesses.
Keep the code fingerprint associated with the result; a fixture must not silently test a different revision from the installation being checked.

### SQLite fixtures

Use a real file-backed database for restart, locking, and migration tests.
An in-memory database is suitable only when file and process behavior are irrelevant to the assertion.
Apply the same migrations and connection settings used by the service.
Use isolated capacity or permission constraints where practical and controlled storage-boundary failures for other cases.
Follow the [durable-delivery requirements](../TEST_REQUIREMENTS.md#durable-delivery-and-recovery) for migration and restart evidence.

### Privacy canary fixtures

Maintain reusable sentinel values: fake credentials, a comment body, a brief excerpt, a report body, a private path, and an environment value.
Give each value a unique marker so tests can identify where it escaped.
Use them in relevant adapter and service journeys, including failure paths.

Provide a shared assertion helper for diagnostic sinks, incident records, operational alert payloads, and report exports.
Run it during journey teardown, including when a journey fails, without hiding the original assertion failure.
Check the surfaces exercised by the journey and report any unavailable capture surface instead of silently assuming it was clean.
Normal task storage and authorized message delivery may legitimately contain work content; do not apply a blanket ban to those destinations.

Marker scans detect the sampled leaks, not every possible disclosure.
Also test field allowlists, nested causes, truncation, unsafe serialization, control-character escaping, and export redaction.
Keep focused privacy tests for cases that ordinary journeys do not exercise.

### Live-check fixtures

Use explicitly configured disposable Linear and Firstmate resources with bounded requests.
Do not inherit the developer's normal credentials or destinations; live credentials must be explicitly supplied for the check.
Clean up only resources the check owns, including after failures.
Keep live checks opt-in and separate from ordinary CI and local compatibility probes.
Follow [controlled live-check requirements](../TEST_REQUIREMENTS.md#controlled-live-checks) for what their results can establish.

## Reference material

The initial assessment examined FM Linear's `feat/comment-threading` branch at `0325c6cbfa0b7adf8dbee74d65c54e349b411461` and upstream FirstMate at `b84e0e362face25f3dd8945297a3df1320d7668c`.
Those revisions are reference points, not a supported-version guarantee.
Verify compatibility against the FirstMate versions supported by each release.

The [reference implementation](https://github.com/josh-padnick/fm-linear/tree/0325c6cbfa0b7adf8dbee74d65c54e349b411461) already contains intake, classification, task links, publication, retryable jobs, configuration, and diagnostics.
Its [insights plan](https://github.com/josh-padnick/fm-linear/blob/0325c6cbfa0b7adf8dbee74d65c54e349b411461/docs/insights-plan.md) separates analytics from operational synchronization.
Use that work as a reference while evaluating behavior against the responsibilities in [ARCHITECTURE.md](../ARCHITECTURE.md).

The proposed subsystem names do not assert that matching directories or public interfaces already exist.
The next design work is to define those interfaces and demonstrate the dispatch integration, rather than assuming the current implementation satisfies the architecture.

## Brief preparation handshake and recovery

Use an explicit preparation handshake as the proposed temporary integration approach: Firstmate creates and fills the authored task brief, invokes FM Linear preparation, waits for success, and only then calls upstream spawn.
A standing captain preference can teach the sequence but does not guarantee the agent invokes it.
Keep Firstmate as the owner of dispatch; do not rely on a file watcher editing the generated launch brief before it is consumed.

Record the task identity, authored brief version, and workflow requirements used for preparation.
As a fallback, compare prepared requirements with evidence from the actual launch attempt, preserving unknown outcomes and accounting for launch-brief regeneration on relaunch.
Missing requirements should prompt an explicit corrective handoff to Firstmate, not a claim that the original launch was compliant.
An instruction delivered late cannot undo work already performed, especially when a missed requirement prohibited starting without approval.
The handshake command, capture of launch evidence, and recovery guarantees still require implementation and verification.
