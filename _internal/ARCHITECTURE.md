# FM Linear architecture

## Status and scope

This document describes the intended architecture of FM Linear.
It defines subsystem responsibilities rather than a final directory structure or a claim that every capability exists.
The [design principles](../AGENTS.md#design-principles) guide these responsibilities.

The initial assessment examined FM Linear's `feat/comment-threading` branch at `0325c6cbfa0b7adf8dbee74d65c54e349b411461` and upstream FirstMate at `b84e0e362face25f3dd8945297a3df1320d7668c`.
Those revisions are reference points, not a supported-version guarantee.
Verify compatibility against the FirstMate versions supported by each release.

## System ownership

FirstMate is a third-party orchestrator that FM Linear extends through existing interfaces.
Users interact through Linear to request work, observe progress, provide feedback, and approve next steps.
FM Linear translates those interactions into inputs for FirstMate and presents execution facts through the user's configured workflow.

| System | Owns |
| --- | --- |
| FirstMate | Accepted work, execution queue, scheduling, dependencies, delegation, worker supervision, and execution state. |
| Linear | Native issues, comments, reactions, labels, and field changes. |
| FM Linear | Issue/task correspondence, workflow requirements and mappings, synchronization state, and reliable delivery. |

Creating an issue expresses a request; FirstMate determines how to accept and execute it.
A captain's board edit becomes input interpreted under explicit workflow rules.
Moving an issue to Done does not itself establish that its workers finished or that a PR merged.

FM Linear keeps synchronization operational without requiring the agent to remember Linear bookkeeping commands.
It asks agents to supply interpretations or semantic reports when available evidence cannot determine the next action.

## Subsystem relationships

The eight subsystems are logical modules that can run within one local service.
They do not imply eight separately deployed processes or eight databases.

```mermaid
flowchart LR
    linear[Linear] --> intake[1. Linear intake]
    intake --> context[3. Work and conversation context]
    context --> workflow[4. Workflow requirements and rules]
    workflow --> fm[2. FirstMate integration]
    fm --> firstmate[FirstMate and its crew]
    firstmate --> fm
    fm --> context
    workflow --> publish[5. Linear publication and reconciliation]
    publish --> linear
    publish -->|Confirmed effects| context
    setup[7. Setup and configuration] -.-> workflow
    recovery[6. Durable delivery and recovery] -.-> shared[Shared support for subsystems 1-5]
    setup -.-> shared
    diagnostics[8. Diagnostics and feedback] -.-> shared
```

Solid arrows show the main information flow.
Dashed arrows identify shared support rather than event ordering.
The FirstMate integration owns the external interfaces; FirstMate continues to decide worker assignments and execution.

## 1. Linear intake

Capture comments, reactions, issue creation, and relevant field changes.
Preserve author identity, workspace, issue, thread, entity revision, and available occurrence timestamps.
Record input durably and deduplicate repeated delivery.

Use prompt notifications where available, with reconciliation to recover missed changes and downtime.
The notification transport and its deployment are separate implementation decisions.
Verify incoming notifications and identify integration-authored updates so they do not create feedback loops.

Intake establishes what Linear reported.
Workflow rules or an agent determine what the input means and what action follows.

## 2. FirstMate integration

Deliver work requests, feedback, and workflow requirements through existing FirstMate interfaces.
Observe execution facts, progress, open decisions, and delivery outcomes.
Normalize those observations for the rest of FM Linear while preserving their source, freshness, and task identity.

Keep upstream-specific commands, state formats, and compatibility checks in this adapter.
Prefer FirstMate's structured state interfaces over independent interpretations of raw status history.
Keep unknown execution state explicitly unknown.

FirstMate's process-event extension is the established candidate for inbound evidence delivery.
That extension does not provide a general instruction-injection or worker-launch capability.
The dispatch integration described below requires further verification.

This module does not take over worker supervision or write synthetic execution states into FirstMate's records.
When execution evidence is missing, deliver an inspection request through FirstMate.

## 3. Work and conversation context

Maintain the relationships between Linear issues, FirstMate homes, tasks, execution attempts, comment threads, and artifacts.
Use stable identifiers and distinguish successive attempts even when a task name is reused.
An issue can involve several tasks; an old attempt must not drive the active attempt's state.

Keep issue enrollment separate from the assignee so captain handoffs preserve synchronization.
Record the thread a response belongs to independently of board status.
Several questions and answers may share one review conversation.

Assemble the issue context a newly assigned crewmate needs, including plans, decisions, current artifacts, and remaining work.
Preserve accessible artifact references and identify their versions.
Artifact storage or hosting is a separate choice; a temporary local path is not sufficient for future retrieval.

This module owns correspondence and collected context, while FirstMate owns the execution queue.
Agents supply substantive summaries and interpretations; code preserves and publishes their recorded results.

## 4. Workflow requirements and rules

Apply configured policy to recorded facts to determine instructions, expected outputs, approval conditions, next responsible actor, and intended Linear updates.
Keep those decisions separate from transport and database mechanics.

Resolve applicable requirements before task dispatch so the assignment includes the instructions and outputs the worker will need.
Record which configuration and instruction versions applied to each assignment.
Make changes to an active assignment explicit rather than silently changing its requirements.

Before a handoff, check the required evidence.
For example, captain review might require a linked PR, verification results, and an accessible HTML review guide.
Code can check those outputs and their recorded approvals; artifact quality or ambiguous feedback may require agent or captain judgment.

Distinguish worker completion, review readiness, and delivery completion according to the task's delivery contract.
A PR awaiting review, a delivered investigation report, and an authorized local merge have different completion conditions.
Bind approval to the relevant actor, scope, task attempt, and artifact revision.

Workflow rules determine the intended state of each managed Linear field and the meaning of captain overrides.
They return actions for delivery rather than performing external writes themselves.

## 5. Linear publication and reconciliation

Apply intended comments, status changes, assignments, managed labels, and artifact links to Linear.
Use stable action identities and verify ambiguous results before repeating a write.
Record confirmed effects for subsequent processing.

Keep replies in their originating thread unless an explicit decision starts a distinct conversation.
Preserve unrelated labels and respect configured handling of captain edits.
Check the current issue state before applying an action that could have become stale.

Reconcile status, assignee, and managed labels independently.
A matching status must not prevent repair of an incorrect assignee.
Periodic checks repair missed or incomplete effects under the same workflow rules used for event-driven updates.

This module owns how to publish an intended result correctly; workflow rules own which result is intended.

## 6. Durable delivery and recovery

Provide persistent events, pending actions, delivery mappings, acknowledgements, retries, and restart recovery across the integration.
Persist each accepted obligation before acknowledging the corresponding handoff.
Keep captured, delivered, acknowledged, and resolved states distinct.

Use stable identities to make repeated processing safe.
Preserve pending work across schema upgrades and configuration changes.
Escalate persistent delivery failures without reporting success or discarding the original input.

Schedule intake, FirstMate delivery, observations, external checks, and outgoing writes independently with bounded work per cycle.
Slow PR checks or an unavailable source must not prevent unrelated queued work from progressing.
Measure capture and delivery delays separately from agent scheduling and response time.

## 7. Setup and configuration

Own installation, credential configuration, team and user mappings, workflow profiles, instruction templates, and configuration versions.
Provide supported operations that FirstMate can invoke when the user requests a workflow change.
Persist those changes so they survive the conversation.

Validate configuration before activation and preserve a usable configuration when an edit is invalid.
Provide opinionated defaults with explicit, replaceable mappings.
Keep stable identities separate from display names.

For example, map an observed model identifier to a Linear label ID.
Users can rename the label or change the mapping without changing the recorded model identity.
Offer mappings for new models without relabeling historical work or overwriting user choices.

Show proposed changes to managed Linear resources before applying them with user approval.
Users choose separately whether to update the software and whether to adopt new workflow defaults.

## 8. Diagnostics and feedback

Expose pending delivery, stale observations, missing outputs, retries, and persistent failures.
Retain enough provenance to explain the path from a source event to an intended action and its result.
Avoid claiming an agent acted merely because it received a message.

Help agents distinguish a product bug, a supported customization, and a missing capability.
Prepare relevant diagnostic evidence for a bug report or feature request and submit it with user approval.
Exclude credentials and unrelated private content.

This module reports integration health and supports investigation.
FirstMate retains responsibility for worker recovery and execution judgments.

## Workflow requirements at dispatch

A review guide illustrates how requirements should accompany execution.

1. Setup and configuration supplies the user's review-guide instructions.
2. Workflow requirements and rules resolves those instructions and expected outputs for the task.
3. FirstMate integration provides the requirements for FirstMate's initial crewmate assignment.
4. The crewmate completes the work, creates the guide, and reports its artifacts.
5. FM Linear records the artifacts and checks the required handoff evidence.
6. Linear publication links the guide and applies the configured captain handoff.

Missing-output detection is recovery for an incomplete assignment, not the normal time to introduce the requirement.
FirstMate chooses a replacement worker if the original crewmate is unavailable.

### Integration question to resolve

The inspected FirstMate version launches workers with task briefs.
Its [extension contract](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md) explicitly excludes instruction injection and before/after hooks.
The brief is a candidate integration point.
We have not demonstrated a reliable way for the plugin to include its requirements before dispatch.

Verify a supported path that includes the applicable requirements before the worker begins, including restart and alternate-dispatch cases.
An instruction telling FirstMate to remember a template is insufficient proof.
If the existing interfaces cannot enforce inclusion, document the limitation and revisit the mechanism without making upstream changes a prerequisite.

## Persistence and the wider tool suite

FM Linear owns one operational SQLite database for its integration state.
Subsystems share that database through owned interfaces rather than introducing separate databases for each module.
Retain SQLite as the default unless a demonstrated requirement justifies another engine.

Each independently useful tool owns its operational data and migrations.
FirstMate retains its existing storage.
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

## Relationship to existing work

The [reference implementation](https://github.com/josh-padnick/fm-linear/tree/0325c6cbfa0b7adf8dbee74d65c54e349b411461) already contains intake, classification, task links, publication, retryable jobs, configuration, and diagnostics.
Its [insights plan](https://github.com/josh-padnick/fm-linear/blob/0325c6cbfa0b7adf8dbee74d65c54e349b411461/docs/insights-plan.md) separates analytics from operational synchronization.
Preserve those useful foundations while evaluating behavior against the responsibilities in this document.

The proposed subsystem names do not assert that matching directories or public interfaces already exist.
The next design work is to define those interfaces and demonstrate the dispatch integration, rather than assuming the current implementation satisfies the architecture.
