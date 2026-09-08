# FM Linear implementation notes

## Scope

This document records concrete implementation guidance, unresolved integration details, and verification expectations for the new design.
Read [ARCHITECTURE.md](ARCHITECTURE.md) for subsystem responsibilities and core design decisions, and [TECH_STACK.md](TECH_STACK.md) for technology choices.
These notes describe intended behavior and research findings, not a claim that the implementation is complete.
Reference code informs the design without defining it.

## Polling and retrieval

Poll each configured Linear connection every 30 seconds.

Run a catch-up scan on startup before beginning the regular polling schedule.
Do not overlap scans for the same connection or build an unbounded backlog of missed poll ticks.
Keep slow scans from blocking delivery and publication for other work.
Respect API rate limits and use bounded retries with backoff during failures, making any resulting delay visible.
The 30-second interval is the normal retrieval cadence, not a guarantee of agent response time.

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

Keep the extension adapter thin and verify its installation and runtime requirements against the supported upstream contract.

FirstMate's process-event extension is the established candidate for inbound evidence delivery.
That extension does not provide a general instruction-injection or worker-launch capability.
The dispatch integration described below requires further verification.

The inspected FirstMate version launches workers with task briefs.
Its [extension contract](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md) explicitly excludes instruction injection and before/after hooks.
The brief is a candidate integration point.
We have not demonstrated a reliable way for the plugin to include its requirements before dispatch.

Verify a supported path that includes the applicable requirements before the worker begins, including restart and alternate-dispatch cases.
An instruction telling FirstMate to remember a template is insufficient proof.
If the existing interfaces cannot enforce inclusion, document the limitation and revisit the mechanism without making upstream changes a prerequisite.

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
| Windows | `%LOCALAPPDATA%\fm-linear\config.yaml` |
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

Support installation, startup, shutdown, upgrades, and diagnostics on macOS, Windows, and Linux.
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

## Verification

Test workflow rules, adapter contracts, and integration behavior with real temporary database files.
Exercise duplicate input, crashes, restart recovery, stale actions, threaded replies, and partial publication failures.
Test the actual FirstMate extension process and supported upstream versions, especially requirement delivery before dispatch.
Test the 30-second polling schedule, non-overlapping scans, pagination, rate-limit backoff, and offline catch-up.
Verify authorization checks on fetched records and shared configuration between CLI and service.

Run automated checks, integration tests, and compiled-binary smoke tests on macOS, Windows, and Linux.
Verify installation, service lifecycle, local communication, and restart recovery on each operating system before claiming release support.
Document supported operating-system versions and CPU architectures explicitly.
Add browser tests if FM Linear introduces its own browser UI.

## Reference material

The initial assessment examined FM Linear's `feat/comment-threading` branch at `0325c6cbfa0b7adf8dbee74d65c54e349b411461` and upstream FirstMate at `b84e0e362face25f3dd8945297a3df1320d7668c`.
Those revisions are reference points, not a supported-version guarantee.
Verify compatibility against the FirstMate versions supported by each release.

The [reference implementation](https://github.com/josh-padnick/fm-linear/tree/0325c6cbfa0b7adf8dbee74d65c54e349b411461) already contains intake, classification, task links, publication, retryable jobs, configuration, and diagnostics.
Its [insights plan](https://github.com/josh-padnick/fm-linear/blob/0325c6cbfa0b7adf8dbee74d65c54e349b411461/docs/insights-plan.md) separates analytics from operational synchronization.
Use that work as a reference while evaluating behavior against the responsibilities in [ARCHITECTURE.md](ARCHITECTURE.md).

The proposed subsystem names do not assert that matching directories or public interfaces already exist.
The next design work is to define those interfaces and demonstrate the dispatch integration, rather than assuming the current implementation satisfies the architecture.
