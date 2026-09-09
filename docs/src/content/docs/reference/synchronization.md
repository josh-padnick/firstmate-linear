---
title: Synchronizing issues
description: How FM Linear reads work evidence, updates Linear issues and dependencies, and recovers from interrupted delivery.
---

FM Linear translates Firstmate's recorded work into Linear issues you can follow and respond to.
It keeps the issue connected to the right tasks, attempts, and conversations while Firstmate retains control of execution.
For the user-facing workflow, see [Track progress](/guides/track-work/).

## Reading progress from Firstmate

The adapter reads available evidence and preserves the source, task identity, and execution attempt.
FM Linear applies the workflow rules to that evidence, saves the intended Linear changes, and records confirmed publication.
Periodic reconciliation repairs missed or incomplete updates while respecting the configured policy for manual edits.

A worker stopping, a deliverable being accepted, and a PR merging are different facts.
Approval permits a particular next action on a particular version; it does not prove that action happened.
Unknown or stale observations should remain visible as such.

Task and backlog records and `bin/fm-crew-state.sh <task-id>` provide different kinds of evidence.
If a necessary outcome is still missing, FM Linear can use the [proposed report-request flow](/reference/messages/#requesting-a-report-from-firstmate) to ask Firstmate to inspect the work.
It should first allow relevant records time to arrive and avoid repeated questions about the same missing fact.

## Publishing the issue update

The saved issue-to-task mapping identifies which Linear issue an observation concerns.
Workflow rules determine its status, assignee, and managed labels from confirmed progress and authorized decisions.
FM Linear writes those changes through the Linear API and retains the confirmed results.

The issue also collects reported plan and deliverable links, review decisions, and supporting materials.
At merge review, FM Linear attaches the relevant PR and presents the reviewed revision and validation results.
A recap is included when it was produced; its existence is not assumed.
[Issue-detail configuration](/reference/configuration/#customize-linear-issue-details) controls optional context such as Herdr panel references.

A comment reply stays in its originating thread.
Replacement workers continue using the saved work connection, while an observation from an old execution attempt must not overwrite a newer attempt's state.
Status, assignee, labels, and managed relationships are reconciled independently, preserving unrelated content and following the configured policy for manual edits.

## Dependencies connect the issues

Firstmate owns dependencies between its work items.
The inspected version records them in its configured backlog and reads blocker IDs through its task-query interfaces.
FM Linear should read those explicit records, map the tasks to connected Linear issues, and maintain their **blocks / blocked by** relationships.
See Firstmate's [backlog configuration](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/configuration.md#L90-L113) and [dependency-handling code](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-decision-hold.sh#L147-L174).

For example, UI integration can be blocked by an API task while some UI work continues.
A Waiting status alone does not identify a dependency, and a dependency does not necessarily stop all work on the issue.

Persistent integration guidance should ask Firstmate to keep dependency records current using stable task IDs.
If it cannot record a relationship there, it should explicitly report the blocked task, prerequisite task, and condition needed to proceed.
That reporting fallback and coverage across backlog backends still need implementation and verification.
Missing information must stay unresolved rather than being treated as removal of a dependency.
You can [ask Firstmate to record a dependency](/guides/track-work/#ask-firstmate-to-record-a-dependency) in your normal conversation.

## What happens if something stops

FM Linear's local SQLite database stores issue-to-task mappings, retrieved inputs, pending deliveries, and confirmed results.
Accepted integration inputs survive service restarts, and retries must not repeat a confirmed action.
The service catches up after downtime, subject to the history Linear still exposes.
It keeps captured information, delivered messages, and resolved requests distinct.

The machine running the service must be awake and connected to synchronize.
Pending delivery, stale information, and persistent failures should remain visible.
Firstmate retains responsibility for recovering its workers.

## Metrics for synchronization

Read attempts, failures, duration, and observation availability help explain gaps in progress information.
Publication attempts, confirmed writes, retries, and pending update age show whether a Linear change is delayed.
Neither a routine read nor a successful Linear write counts as a notification to Firstmate.
See the [activity-to-metrics mapping](/reference/metrics/#metrics-by-integration-activity) for the definitions and collection requirements.

Read [Compatibility](/reference/compatibility/) for the remaining observation and platform limits.
For an unexplained missing or incorrect update, see [Reporting bugs](/guides/troubleshooting/).
