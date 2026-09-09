# FM Linear architecture

## Status and scope

This document describes FM Linear's intended subsystem responsibilities, relationships, and ownership.
It does not claim that every capability is implemented.
The [design principles](../AGENTS.md#design-principles) guide these responsibilities.
Technology selections and their rationale are maintained in [TECH_STACK.md](TECH_STACK.md).
Concrete implementation guidance, configuration paths, compatibility findings, and verification expectations are in [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md).
Shared engineering practices live in [TESTING.md](TESTING.md), [LOGGING.md](LOGGING.md), and [ERRORS.md](ERRORS.md).

## System ownership

Firstmate is a third-party orchestrator that FM Linear extends through existing interfaces.
Users interact through Linear to request work, observe progress, provide feedback, and approve next steps.
FM Linear translates those interactions into inputs for Firstmate and presents execution facts through the user's configured workflow.

| System | Owns |
| --- | --- |
| Firstmate | Accepted work, execution queue, scheduling, dependencies, delegation, worker supervision, and execution state. |
| Linear | Native issues, comments, reactions, labels, and field changes. |
| FM Linear | Issue/task correspondence, workflow requirements and mappings, synchronization state, and reliable delivery. |

Creating an issue expresses a request; Firstmate determines how to accept and execute it.
A captain's board edit becomes input interpreted under explicit workflow rules.
Moving an issue to Done does not itself establish that its workers finished or that a PR merged.

FM Linear keeps synchronization operational without requiring the agent to remember Linear bookkeeping commands.
It asks agents to supply interpretations or semantic reports when available evidence cannot determine the next action.

## Bounded context and module boundaries

Treat FM Linear's workflow integration as one core bounded context: a boundary within which its domain terms and rules have consistent meanings.
The [domain vocabulary](DOMAIN.md) defines those terms.
Firstmate's execution model and Linear's issue model remain external models that FM Linear translates through adapters.
Neither external application's internal bounded-context structure is prescribed by this design.

For example, an observed worker exit, an accepted deliverable, and a Linear status named `Done` establish different facts.
The adapters preserve those differences rather than importing an external status as an internal completion rule.
They act as anti-corruption layers: translation boundaries that protect FM Linear's model from external assumptions.

The eight subsystems below are modules within this architecture, not eight bounded contexts.
Work and conversation context and workflow requirements and rules contain the core domain model.
The Firstmate and Linear adapters translate external inputs and effects.
Delivery, lifecycle, and diagnostics provide supporting capabilities.
The word "context" in the work-and-conversation subsystem refers to collected work information, not a separate DDD bounded context.

Keep module interfaces and ownership explicit without inventing separate domain models for polling, publication, or persistence.
Shared technical error and instrumentation contracts do not require separate bounded contexts.
Incident management could become a separate bounded context if its language and rules develop independently; it remains a supporting module for now.
Bounded-context boundaries do not inherently require separate processes or databases.

## Subsystem relationships

The eight subsystems are logical modules that can run within one local service.
They do not imply eight separately deployed processes or eight databases.
FM Linear targets macOS and Linux.
Keep platform-specific installation, process control, filesystem handling, and local communication behind explicit interfaces so subsystem behavior stays consistent across operating systems.

```mermaid
flowchart LR
    intake[1. Linear intake] -->|Authenticated API polling| linear[Linear]
    linear -->|Fetched records| intake
    intake --> context[3. Work and conversation context]
    context --> workflow[4. Workflow requirements and rules]
    workflow --> fm[2. Firstmate integration]
    fm --> firstmate[Firstmate and its crew]
    firstmate --> fm
    fm --> context
    workflow --> publish[5. Linear publication and reconciliation]
    publish --> linear
    publish -->|Confirmed effects| context
    setup[7. Setup, configuration, and service lifecycle] -.-> workflow
    recovery[6. Durable delivery and recovery] -.-> shared[Shared support for subsystems 1-5]
    setup -.-> shared
    diagnostics[8. Diagnostics, metrics, and reporting] -.-> shared
```

| Subsystem | Owns | Produces |
| --- | --- | --- |
| 1. Linear intake | Authenticated polling and durable capture of relevant Linear changes. | Source records with provenance and retrieval progress. |
| 2. Firstmate integration | Firstmate commands, task observations, brief preparation, message delivery, report acceptance, and compatibility contracts. | Qualified observations and explicit delivery outcomes. |
| 3. Work and conversation context | Relationships between homes, tasks, attempts, issues, threads, artifacts, and dependencies. | The identities and context needed to route each action. |
| 4. Workflow requirements and rules | User workflow semantics, stage instructions, approvals, field mappings, and quiet follow-up policy. | Intended actions based on recorded facts and configuration. |
| 5. Linear publication and reconciliation | Comments, fields, artifacts, PR attachments, and dependency relationships. | Confirmed effects and repair of differences from intended state. |
| 6. Durable delivery and recovery | Accepted obligations, attempts, acknowledgments, retries, and restart recovery. | Recoverable pending work and safe progress through delivery. |
| 7. Setup, configuration, and service lifecycle | Installation, connections, configuration changes, CLI entry points, startup, and shutdown. | A validated running installation with explicit capability holds. |
| 8. Diagnostics, metrics, and reporting | Health, incident lifecycle, notification tracking, noise measurements, and approved bug reports. | Local diagnostics, actionable alerts, and reviewable report drafts. |

Solid arrows show the main information flow.
Dashed arrows identify shared support rather than event ordering.
The Firstmate integration owns the external interfaces; Firstmate continues to decide worker assignments and execution.

## 1. Linear intake

Fetch comments, reactions, issue creation, and relevant field changes directly from Linear's authenticated API.

Polling is the sole intake mechanism and requires only outbound API access.
The retrieval cadence is configurable with a default of 30 seconds.
Intake owns reliable capture of source records; it preserves their provenance and enforces configured access boundaries.
Fetched content does not grant permissions beyond the author's configured authority.

Capture records before advancing retrieval progress, and identify integration-authored changes to prevent feedback loops.
Polling records observations; it cannot reconstruct deleted content or intermediate changes the API no longer exposes.

Intake establishes what Linear reported.
Workflow rules or an agent determine what the input means and what action follows.

## 2. Firstmate integration

Deliver work requests, feedback, and workflow requirements through existing Firstmate interfaces.
Observe execution facts, progress, explicit task dependencies, open decisions, and delivery outcomes.
Normalize those observations for the rest of FM Linear while preserving their source, freshness, and task identity.

Keep upstream-specific commands, state formats, and compatibility checks in this adapter.
Prefer Firstmate's structured state interfaces over independent interpretations of raw status history.
Keep unknown execution state explicitly unknown.
Own a versioned behavioral contract suite for the installed Firstmate code, exposed through the proposed `fm-linear test` command and reused by setup and change-triggered checks.
Scope results to the actual revision, relevant local changes, configuration, and environment; isolated test probes must not operate on live tasks or services.
Invalidate results when their inputs change and hold only affected integration operations when a required contract fails or cannot be verified.

Use two explicit delivery paths: prepare the authored task brief before launch, or provide messages through Firstmate's process-event extension.
Firstmate can then steer an existing crewmate through its worker-message interfaces.
The adapter owns the preparation handshake and comparison with available launch evidence.
A skipped preparation can require a corrective message; neither universal detection nor agent compliance follows from a successful brief edit.

This module does not take over worker supervision or write synthetic execution states into Firstmate's records.
When a missing execution fact prevents a meaningful integration action, deliver a tracked inspection request through Firstmate after checking existing evidence.
Accept structured reports through an explicit, validated adapter interface when Firstmate must interpret a missing fact.
The report identifies the home, task attempt, request, outcome, and supporting artifact references.
Its command name and schema still need definition; a free-form comment is not automatically a validated report.
Workflow rules decide when a report is needed, context retains its identity, and durable delivery preserves the unanswered obligation.
Expose observed notification emission and acknowledgment separately from queued delivery, retaining unknown notification outcomes as unknown.
Import request-attributable usage only when the upstream interface exposes reliable attribution.

## 3. Work and conversation context

Maintain the relationships between Linear issues, Firstmate homes, tasks, execution attempts, comment threads, and artifacts.
Retain explicit dependency identities and their source so task dependencies can be mapped to relationships between connected issues.
Use stable identifiers and distinguish successive attempts even when a task name is reused.
An issue can involve several tasks; an old attempt must not drive the active attempt's state.

Keep issue enrollment separate from the assignee so captain handoffs preserve synchronization.
Record the thread a response belongs to independently of board status.
Several questions and answers may share one review conversation.
Maintain stable request identities, origin and purpose, execution-attempt scope, and batch membership so repeated delivery can be distinguished from new work.

Assemble the issue context a newly assigned crewmate needs, including plans, decisions, current artifacts, and remaining work.
Preserve accessible artifact references and identify their versions.
Artifact access must survive the originating conversation and worktree.
Include configured execution context, such as a Herdr panel name, alongside task and artifact references.
Treat display names as optional presentation data associated with a stable execution identity, not as delivery addresses.

This module owns correspondence and collected context, while Firstmate owns the execution queue.
Agents supply substantive summaries and interpretations; code preserves and publishes their recorded results.

## 4. Workflow requirements and rules

Apply configured policy to recorded facts to determine stage instructions, approval conditions, next responsible actor, and intended Linear updates.
Keep those decisions separate from transport and database mechanics.

Resolve applicable requirements before task dispatch so the assignment includes instructions for the stage the worker will perform.
Instructions are optional; users do not need to repeat Firstmate's normal planning or implementation guidance.
Record which configuration and instruction versions applied to each assignment.
Make changes to an active assignment explicit rather than silently changing its requirements.

Before a handoff, check the required evidence.
For example, merge approval must identify the PR revision and relevant verification results.
Publish supporting artifacts actually reported with the work; do not assume a recap exists for every deliverable.
The generic `required_outputs` configuration field is deferred.
An instruction can request an interactive recap or a custom review tool, but enforceable artifact checks require an explicit result contract.
Artifact quality and ambiguous feedback require agent or captain judgment.

Distinguish worker completion, review readiness, and delivery completion according to the task's delivery contract.
A PR awaiting review, a delivered investigation report, and an authorized local merge have different completion conditions.
Bind approval to the relevant actor, scope, task attempt, and artifact revision.

Workflow rules determine the intended state of each managed Linear field and the meaning of captain overrides.
They return actions for delivery rather than performing external writes themselves.
Keep routine synchronization silent and request clarification only when existing evidence cannot resolve a necessary decision.
Coalesce repeated observations into one outstanding question for the same fact and attempt, allow relevant records time to arrive, and batch nonurgent questions while prioritizing captain input.

## 5. Linear publication and reconciliation

Apply intended comments, status changes, assignments, managed labels, artifact links, PR attachments, and blocks / blocked-by relationships to Linear.
Record confirmed effects for subsequent processing.

Keep replies in their originating thread unless an explicit decision starts a distinct conversation.
Preserve unrelated labels and respect configured handling of captain edits.

Reconcile status, assignee, managed labels, and managed dependency relationships independently.
A matching status must not prevent repair of an incorrect assignee.
Periodic checks repair missed or incomplete effects under the same workflow rules used when new facts arrive.

This module owns how to publish an intended result correctly; workflow rules own which result is intended.

### Task dependencies

Firstmate owns dependencies between work items and decides how they affect scheduling.
The Firstmate adapter reads explicit dependency records from the configured backlog when a compatible interface is available.
Work and conversation context maps each end of the dependency to its connected Linear issue; publication maintains the corresponding blocks / blocked-by relationship.
A dependency can exist at any stage and can coexist with useful work in progress.
The Waiting status describes a current impediment; it does not itself identify a dependency or prove that all work has stopped.

Prefer recorded dependency information over asking the agent to repeat it in comments.
When a necessary relationship cannot be observed, ask Firstmate to inspect or explicitly report it, preserving uncertainty until that information is available.
An instruction to maintain dependency records supports this process but is not evidence that the records are complete.

Preserve unrelated, manually created Linear relationships under the configured edit policy.
An unreadable source or missing issue mapping must not be interpreted as removal of a dependency.
Dependencies within a single mapped issue must not create a self-blocking Linear relationship.
A dependency edited in Linear is input for Firstmate to assess, not an automatic change to its execution queue.
Concrete source interfaces, reporting fallback, and verification cases belong in [the implementation notes](IMPLEMENTATION_NOTES.md#task-dependency-synchronization).

## 6. Durable delivery and recovery

Provide persistent events, pending actions, delivery mappings, acknowledgements, retries, and restart recovery across the integration.
Persist each accepted obligation before acknowledging the corresponding handoff.
Keep captured, delivered, acknowledged, and resolved states distinct.
Record delivery attempts, observed notifications, acknowledgments, and request resolutions with stable identities for diagnostics and metrics.
A pending question must not cause a fresh reminder on every poll; bounded follow-up policy must respect Firstmate's event-handling contract.

Use stable identities to make repeated processing safe.
Keep logical actions separate from their delivery attempts.
After an uncertain external write, verify its effect before retrying; local deduplication alone cannot guarantee a single remote effect.
Preserve pending work across schema upgrades and configuration changes.
Escalate persistent delivery failures without reporting success or discarding the original input.
Keep independent work progressing when a source or destination is slow or unavailable.

## 7. Setup, configuration, and service lifecycle

Own CLI entry points, installation, service startup and shutdown, credential configuration, team and user mappings, workflow profiles, instruction templates, issue-detail presentation, polling cadence, and configuration versions.
Provide supported operations that Firstmate can invoke when the user requests a workflow change.
Persist those changes so they survive the conversation.
Configuration belongs to the user installation and can serve multiple projects and Firstmate homes.
Keep workflow configuration, credentials, and operational state separate.

Run the adapter's applicable compatibility checks before enabling dependent synchronization on every service start.
Coordinate change detection and capability holds without restarting the whole service merely to recheck Firstmate.
Keep diagnostics available while affected integration operations are held.
Stop intake and preserve pending work during orderly shutdown; scope service ownership so duplicate processes cannot deliver the same work.

Validate configuration before activation and preserve a usable configuration when an edit is invalid.
Provide opinionated defaults with explicit, replaceable mappings.
Keep stable identities separate from display names.

For example, map an observed model identifier to a Linear label ID.
Users can rename the label or change the mapping without changing the recorded model identity.
Offer mappings for new models without relabeling historical work or overwriting user choices.

Setup verifies a dedicated Firstmate Linear account separately from the captain's identity.
Inspect the team's existing statuses and let the user select the recommended workflow or customize its mappings.
Show the missing statuses and labels before creating them with user approval.
Show proposed changes to other managed Linear resources before applying them with user approval.
Users choose separately whether to update the software and whether to adopt new workflow defaults.

## 8. Diagnostics, metrics, and reporting

Expose pending delivery, stale observations, missing evidence, retries, and persistent failures.
Own a common incident model and instrumentation interface; individual subsystems supply typed failures and lifecycle facts.
Logs explain operations, incidents track problems, and metrics measure behavior; none substitutes for durable delivery records.
Provide read-only incident inspection and sanitized report export so users and agents can follow a symptom to its evidence.
Diagnostic issues carry an explicit integration-owned purpose and identity, independently of their display labels or author.
Retain enough provenance to explain the path from a source event to an intended action and its result.
Avoid claiming an agent acted merely because it received a message.

Help agents distinguish a product bug, a supported customization, and a missing capability.
Prepare relevant diagnostic evidence for a bug report or feature request and submit it with user approval.
Detect unexpected errors and persistent failures in code, and create durable incidents with focused evidence and a reviewable report draft.
Ask the captain to approve the exact GitHub report before publication, using Firstmate for investigation and interpretation when its verified messaging path is available.
Coalesce repeated failures into the same incident and keep transient errors within normal recovery policy.
Preserve draft, approval, and submission state separately from operational Linear alerts; a Linear alert does not authorize a public GitHub report.
Exclude credentials and unrelated private content.

Own the definitions and local summaries of integration metrics, including questions per active task, observed notification frequency, repeat notifications, batching, questions resolved without contacting Firstmate, report turnaround, and attributable token usage when available.
Other subsystems supply lifecycle facts through a shared instrumentation interface; this module derives the measurements rather than independently inferring task state.
Separate captain-originated requests from integration-generated clarification and distinguish attempted, confirmed, and unknown delivery outcomes.
Pair noise measurements with pending-request age and delivery delays so quiet operation does not conceal stalled work.

Store lightweight metric events and derived summaries in FM Linear's existing SQLite database.
No ninth subsystem, separate metrics database, hosted telemetry service, or additional agent call is required.
Provide a supported local summary and versioned structured export for Console.
Store compatibility-check results and expose new failures without repeatedly notifying Firstmate about an unchanged condition.
Model background compatibility failures as durable incidents with separate notification delivery state.
Use the configured Linear destination and captain identity for blocking-failure alerts, verified Firstmate messaging when available, and local diagnostics when remote channels fail.
Keep incident reporting independent of a failed Firstmate capability and exclude diagnostic issues from normal work enrollment.
The Firstmate adapter checks compatibility before dependent synchronization on every service start and when the installed integration code changes.
Rechecking pauses affected operations without requiring a full service restart.
Console owns its cross-tool reporting and dashboard, while FM Linear owns the semantics of these integration measurements.

This module reports integration health and supports investigation.
Firstmate retains responsibility for worker recovery and execution judgments.

## Workflow requirements at dispatch

A review guide illustrates how requirements should accompany execution.

1. Setup and configuration supplies the user's review-guide instructions.
2. Workflow requirements and rules resolves the optional build-stage instruction for the task.
3. Firstmate integration provides the requirements for Firstmate's initial crewmate assignment.
4. The crewmate completes the work, creates the guide, and reports its artifacts.
5. FM Linear records the artifacts and checks the required handoff evidence.
6. Linear publication links the guide and applies the configured captain handoff.

The selected design uses an explicit preparation handshake and a message fallback when available launch evidence reveals missed instructions.
Firstmate's agentic invocation cannot be guaranteed by its extension contract, and fallback cannot undo work already performed.
See [the handshake and recovery notes](IMPLEMENTATION_NOTES.md#brief-preparation-handshake-and-recovery) for the implementation and verification boundaries.
Firstmate chooses a replacement worker if the original crewmate is unavailable.

## Persistence and the wider tool suite

FM Linear owns one operational SQLite database for its integration state.
Subsystems share that database through owned interfaces rather than introducing separate databases for each module.
The database also holds integration metric history and summaries, with explicit retention and observation coverage.
Metrics retention must not delete pending obligations or delivery identities required for safe retries.

Each independently useful tool owns its operational data and migrations.
Firstmate retains its existing storage.
Validatus would own review runs, findings, reviewed revisions, and validation outcomes.
Console would own collected reporting history, cross-tool relationships, metric definitions, aggregates, and dashboard preferences.

Console should consume supported snapshots and incremental changes where available, then query its own reporting database.
A local CLI returning structured data can provide that interface; a separate network server is not inherently required.
Console should not depend on FM Linear's private table layout or write its operational records.

Use stable source identities, timestamps, and relationships to avoid counting the same outcome more than once.
Console owns reporting definitions such as what counts as a completed work item or a unit of throughput.
Retain reporting history deliberately because current snapshots cannot reconstruct events a source has already removed.

A shared database service is not required for this design.
SQLite remains an implementation choice within each tool, rather than the interface connecting the suite.
