---
title: Sending messages
description: How Linear feedback and approvals reach Firstmate, how Firstmate steers a worker, and what delivery confirms.
---

Messages carry feedback, answers, approvals, and changes to work already underway.
FM Linear delivers the Linear conversation to Firstmate, which decides how to respond and whether the crew needs new instructions.

## When it's useful

FM Linear sends messages to Firstmate when you use Linear to give feedback, answer a question, approve a next step, or request changes to work already underway.
For example, you might comment on a Linear issue to request a revision to the current implementation or approve the plan presented for review.
Firstmate interprets your message and decides whether to reply, start a new assignment, or update an existing crewmate's instructions.

FM Linear supplies stage-specific instructions known before an assignment starts by [updating task briefs](/reference/firstmate/).

The [integration overview](/reference/architecture/) explains how both methods fit together and their integration boundaries.

## From a Linear comment to Firstmate

There are two different interfaces in this path: an external process event brings information to Firstmate, and a worker-message command lets Firstmate steer an existing crewmate.
FM Linear does not replace Firstmate's judgment by forwarding every comment directly to a worker.

1. **Retrieve and save the comment.**
   FM Linear polls Linear every 30 seconds by default.
   It preserves the author, issue, thread, and relevant plan or artifact references.
2. **Find the connected work.**
   The saved mapping identifies the Firstmate home and task the comment concerns.
   An ambiguous or missing mapping stays unresolved rather than selecting a worker by a similar name.
3. **Present the information to Firstmate.**
   The adapter supplies the saved conversation through Firstmate's `process-event-adapter/1` extension interface.
   Firstmate owns event capture, announcement, and handling.
4. **Interpret and respond.**
   Firstmate decides whether the comment needs an answer, a clarification, a new assignment, or a change to existing work.
   FM Linear retains the original thread reference for publishing the response.

The [polling explanation](#why-polling-instead-of-webhooks) covers the timing tradeoff.
The polling interval is not a promise that Firstmate will respond within 30 seconds.

## Why polling instead of webhooks?

Webhooks would be ideal for notifying FM Linear as soon as something changes in Linear.
However, receiving them requires a publicly reachable endpoint, which adds setup complexity and security responsibilities.

Polling every 30 seconds is a practical tradeoff: it picks up feedback soon enough for this workflow without requiring an inbound endpoint.
The interval is configurable, and Firstmate may need additional time to respond after your comment is retrieved.

## The scripts involved

The main runtime entry point is [`bin/fm-procevent.sh`](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-procevent.sh).
It runs a registered event source, durably captures the adapter's results, and announces them for Firstmate to handle.
It is an event runner rather than a command that directly sends arbitrary chat text.

The connection also requires an FM Linear adapter package, explicitly enabled through Firstmate's `bin/fm-extension.sh` tooling.
`fm-procevent.sh register-extension` registers that adapter as an event source for the home.
The runner invokes the registered adapter to obtain information for Firstmate; FM Linear's adapter implementation and its handoff from the polling service still need to be completed and verified.

`bin/fm-send.sh` serves a different purpose: Firstmate uses it to send an instruction to an existing worker after deciding what action is needed.

## The process-event extension boundary

The [Firstmate extension contract](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md) (commit `b84e0e3`) lets an independently installed, explicitly enabled package provide external process-event information to a Firstmate home.
It is a narrow extension capability, not a first-class plugin system for the entire FM Linear integration.

Captured event content is evidence for Firstmate to handle.
The extension response itself cannot approve a decision, select an arbitrary destination, launch a worker, or authorize a merge.
A Linear approval still needs interpretation, an authorized reviewer, and a match to the relevant plan or artifact revision.

## From Firstmate to a crewmate

When the current worker needs new information, Firstmate can use `fm-send.sh <task-id> <text>`.
For ordinary text sent to a supported task target, Firstmate's [send command](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-send.sh) uses a durable task inbox and notifies the worker to read it.
This is separate from the external process-event interface that informs Firstmate.

For example, after you comment on an invitation flow, Firstmate might tell the worker:

> Make the invitation expiry clearer and add a way to revoke an invitation.
> Show the revised screen for review before continuing.

Firstmate decides which crewmate should act on your feedback and how to adjust the work.
FM Linear publishes the resulting updates to the linked Linear issue and replies in the original comment thread.

Delivering a message does not mean Firstmate or a crewmate has acted on it.
FM Linear tracks delivery separately from the response and the resulting work.
If a reply is missing or appears in the wrong thread, see [Reporting bugs](/guides/troubleshooting/).

The send command has target-dependent behavior, including different handling for harness-native commands and explicit backend targets.
The adapter must verify the selected path and its confirmation semantics before assuming it is safe to retry.
An uncertain result must not trigger blind resending.

## Changes to running work

Editing workflow YAML affects the saved requirements; it does not rewrite an active worker's context.
If you want a new instruction applied to current work, tell Firstmate explicitly.
Firstmate can send an update and ask the worker to confirm how it will incorporate the change.

This is also the recovery path when [brief preparation was missed](/reference/firstmate/#detecting-and-recovering-from-missed-preparation).
A later message can request a missing recap, but it cannot undo an action already taken.
If an approval boundary was missed, Firstmate must assess what happened and coordinate a pause or correction.

Some stage changes reuse a worker instead of launching a new one.
For example, [Firstmate's promotion command](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-promote.sh#L161-L217) writes `ship-instructions.md` and prints a follow-up send command without executing it.
Preparing the original investigation brief is therefore insufficient to establish that later implementation instructions reached the worker.

## The reply returns to the same thread

Firstmate supplies the substantive response or progress report.
FM Linear publishes it to the corresponding Linear issue using the saved thread relationship.
An answer to your feedback stays in that conversation; a distinct topic can start a new thread explicitly.

The issue should retain relevant decisions and reported artifact links so a later reader can understand the outcome.
The reporting interface, including how the crew supplies artifact links, still needs implementation and verification.
The [report-request contract](#requesting-a-report-from-firstmate) below describes the proposed path for obtaining a missing task outcome; it does not yet define the submission interface for every conversational reply.

## Requesting a report from Firstmate

Sometimes the available records establish that a worker stopped but do not explain the outcome.
FM Linear needs Firstmate's interpretation before it can decide which update belongs in Linear.
It should request the missing information explicitly, instead of asking the agent to remember to report everything.

The proposed exchange is:

1. **Read the available evidence.**
   FM Linear checks the task records and worker-state observations first.
   It does not request information it can already establish reliably.
2. **Save and send a specific question.**
   FM Linear records a pending report request tied to the Firstmate home, task, and execution attempt, then presents it through the process-event path.
   For example: “What was the outcome of this task, and where is its deliverable?”
3. **Firstmate inspects and reports.**
   Firstmate reviews the worker's result and supplies a structured report identifying the request, task, attempt, outcome, and relevant artifact links.
   If the outcome is still unclear, it reports that uncertainty rather than inventing a result.
4. **Validate, save, and apply.**
   FM Linear checks that the report is well formed and belongs to the expected request and attempt, then saves it durably.
   Workflow rules determine which Linear changes the accepted information supports.

### Avoiding unnecessary interruptions

Ask only when the missing fact prevents a meaningful integration action.
Allow a short settling period for task records or a completion report to arrive, and resolve the question from that evidence when possible.
Repeated observations should reuse the same outstanding request for the fact and execution attempt.
Nonurgent questions can be grouped for the same Firstmate home; captain feedback, approvals, and pause requests should receive priority.

An acknowledged question can remain unresolved without being announced again on every poll.
Follow-up reminders should be bounded, with persistent problems visible in diagnostics.
FM Linear's [metrics](/reference/metrics/) track requests, observed notifications, repeats, batching, and response delays so we can assess whether this policy is working.

### Metrics for report requests

The reporting design records the following measurements for this activity.
They are integration-generated clarification metrics, separate from captain feedback and approvals.

| Activity | Measurements |
| --- | --- |
| Record a missing fact | Distinct information gaps opened; gaps resolved from existing evidence before a request is sent. |
| Ask Firstmate for the outcome | Distinct requests first sent, including their contribution to integration requests per active task. Saving a pending question alone does not count as sending it. |
| Notify Firstmate | Observed notifications, questions per notification, and notification frequency. Queued delivery or event capture does not prove notification emission. |
| Follow up on the same question | Repeat notifications, separated into reminders and delivery retries. The underlying request keeps the same identity. |
| Receive a report | Adequate reports accepted; incomplete, uncertain, invalid, or stale-attempt responses requiring further handling. Duplicate submissions do not count as new accepted reports. |
| Resolve or continue waiting | First-notification-to-adequate-report turnaround, plus outstanding request count and age. An acknowledgment does not stop the unresolved-request clock. |
| Account for model usage | Input and output tokens only when they can be attributed to servicing this request. Otherwise usage is unavailable. |

See [Metrics](/reference/metrics/) for time windows, observation coverage, and rate definitions.
These are collection requirements; instrumentation and the reporting command still need implementation.

### How the report would be submitted

An explicit FM Linear reporting command is the proposed submission option.
Firstmate would call it to return the structured result to the integration.
This would be an FM Linear interface, separate from Firstmate's existing state-query and message scripts.
The command name, report schema, and implementation are not defined yet.

A report that parses correctly is not automatically proof that all of its claims are true.
For example, a reported artifact link does not prove the captain approved it, and an agent saying it intends to merge does not establish a completed merge.
Each reported fact must retain its source and satisfy the applicable workflow rule.

### When a report does not arrive

FM Linear keeps the report request pending until the necessary information is supplied.
Delivery of the question, or an acknowledgment from Firstmate, does not resolve it.
An incomplete, uncertain, or mismatched response keeps the missing fact visible and may require a follow-up question.

Pending requests must survive a restart.
Retries should reuse the request identity, and a repeated accepted report must not publish the same Linear update twice.
A response about an older execution attempt must not change the current attempt's state.
While waiting for the report, FM Linear can continue unrelated synchronization work and show which update is awaiting clarification.

## Metrics for other message activities

| Activity | Measurements |
| --- | --- |
| Deliver captain feedback, an answer, or approval | Distinct captured inputs, capture-to-confirmed-handoff delay, pending delivery count and age, observed notifications, and retries. Attribute these to captain requests, not integration-generated clarification. |
| Steer a running crewmate | Observed worker-message attempts, confirmed inbox handoffs, uncertain results, and acknowledgments where available. Count these separately from notifications to Firstmate. |
| Publish a reply in Linear | Publication attempts, confirmed replies, retries, and pending publication age, tied to the original issue and thread. A successful API write is not a Firstmate notification. |

Group each message by its origin and purpose, such as captain feedback, report clarification, or correction of a missed brief instruction.
A correction initiated by FM Linear remains integration overhead even when it eventually reaches a worker through Firstmate.
A later report about a worker message does not establish the exact time that message was delivered; unavailable timing remains unavailable.
All measurements follow the shared [metric definitions and storage policy](/reference/metrics/).
