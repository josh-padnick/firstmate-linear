---
title: Overview
description: The integration's big picture, its two ways of supplying instructions to Firstmate, and the limits of the available interfaces.
---

FM Linear connects Firstmate's work to Linear issues and brings your Linear conversations back to Firstmate.

It runs as a local background service that checks Linear for new comments and relevant issue changes every 30 seconds by default, and monitors Firstmate's task records and worker state for progress updates.
It routes feedback and approvals to Firstmate, updates connected Linear issues as the work changes, and retries pending deliveries when a connection is interrupted.

## The big picture

- **Firstmate coordinates the work; Linear makes it visible and gives you a place to respond.**
  Firstmate owns the work queue, task dependencies, delegation, and worker supervision.
  Linear holds the issues, review conversations, and supporting materials you use to follow that work.

- **FM Linear reads Firstmate's records to understand the work.**
  Its local background service reads task and backlog records and uses Firstmate's `bin/fm-crew-state.sh <task-id>` script to query a crewmate's current state.
  When those records do not establish what happened, FM Linear needs an explicit report from Firstmate.
  The [proposed reporting contract](/reference/messages/#requesting-a-report-from-firstmate) defines the intended exchange; its submission interface still needs implementation.

- **FM Linear supplies instructions through [task briefs](/reference/firstmate/) and [messages](/reference/messages/).**
  It adds initial workflow requirements to the authored `brief.md` that Firstmate uses when launching a crewmate.
  For feedback and approvals, Firstmate's `bin/fm-procevent.sh` runs a registered FM Linear event adapter and presents its results to Firstmate for handling.
  Firstmate can then use `bin/fm-send.sh <task-id> <text>` and its worker-message inbox to steer an existing crewmate.

- **Saved connections keep issues and conversations tied to the right work.**
  FM Linear maps Linear issues and threads to Firstmate tasks and execution attempts.
  It reads comments and publishes updates through Linear's API, keeping replies in the right thread and replacement workers connected to the same issue.
  Pending deliveries and confirmed updates are stored locally so the integration can recover after a restart.

- **Your workflow determines how work appears in Linear and what each handoff requires.**
  Configuration maps stages to Linear statuses, selects who owes the next action, and supplies optional crew instructions.
  FM Linear applies those rules to observed progress and authorized decisions while Firstmate retains control of execution.

## Two ways to supply instructions

| Method | When it applies | What FM Linear taps into |
| --- | --- | --- |
| [Updating task briefs](/reference/firstmate/) | Requirements known before a new assignment starts, such as creating a recap during building. | The authored `brief.md` that Firstmate copies into its launch instructions. |
| [Sending messages](/reference/messages/) | Feedback, approvals, answers, and changes to work already underway. | The process-event extension brings information to Firstmate; Firstmate can then use its worker-message command and inbox. |

These are the two ways to supply instructions, not the only information exchanged.
FM Linear also reads task records, worker observations, dependencies, and agent reports to determine what should appear in Linear.

Your [workflow configuration](/reference/workflow/) describes your process and maps FM Linear stage keys to Linear status names and assignees.
Instructions are optional additions for the stage doing the work.
A recap requested during `build` is one example; deliverable review does not assume every task produces one.

## Firstmate's extension boundary

Firstmate does not have a general-purpose, first-class plugin system for the complete FM Linear integration.
It offers a narrowly scoped `process-event-adapter/1` capability alongside existing commands and task files.
FM Linear combines those surfaces in a dedicated adapter without requiring an upstream fork.

The current [Firstmate integration contract](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md) excludes instruction injection, before/after hooks, task mutation, and worker-launch grants.
The brief-preparation method therefore relies on Firstmate calling an explicit preparation step before launch.
Persistent captain preferences can ask Firstmate to follow that sequence, but cannot force it on every dispatch.

The message interface captures external information for Firstmate to handle.
Capturing that information does not itself authorize a decision, start work, or prove a requested change was completed.
Each method page explains its exact sequence and remaining verification needs.

## Explore the integration

- [Synchronizing issues](/reference/synchronization/) explains how observations become Linear updates, how dependencies are linked, and how synchronization recovers from interruptions.
- [Metrics](/reference/metrics/) describes how we measure integration overhead, delivery delays, and unresolved requests.
- [Compatibility](/reference/compatibility/) describes version checks, platform support, and coverage that still needs verification.
- [Reporting bugs](/guides/troubleshooting/) explains how to investigate and report an unexpected result.
