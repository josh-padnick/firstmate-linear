---
title: Updating task briefs
description: How FM Linear supplies workflow requirements before Firstmate launches a crewmate, and where that preparation can be skipped.
---

A task brief tells a crewmate what to do when it starts.
FM Linear adds the applicable workflow requirements to that brief so the crew knows them before doing the work.

## When it's useful

Brief preparation supplies specific instructions a crewmate should follow while working in a given workflow stage.
For example, a `build.instructions` entry can ask the crewmate to create an interactive recap during implementation.
FM Linear adds those instructions to the task brief before the assignment starts.

FM Linear delivers feedback or changes to work already underway by [sending messages](/reference/messages/).

The [integration overview](/reference/architecture/) explains how both methods fit together and why neither is a general-purpose Firstmate plugin hook.

## Workflow instructions before work starts

Firstmate does not read FM Linear's workflow YAML directly.
FM Linear needs to translate the applicable requirements into text in a task brief before dispatch.
Our approach is an explicit preparation handshake, with detection and recovery for missed preparation.
This is the integration design; the preparation command and recovery checks are not implemented yet.

### Firstmate's existing brief and launch sequence

Firstmate creates and launches a crewmate through the following sequence ([source: `b84e0e3`](https://github.com/kunchenguid/firstmate/tree/b84e0e362face25f3dd8945297a3df1320d7668c)):

1. **Create the brief.** `fm-brief.sh` scaffolds `data/<task-id>/brief.md` and refuses to overwrite an existing brief.
2. **Fill in the assignment.** Firstmate writes the user's request under `## Captain's intent` and its execution instructions under `## Firstmate spec`.
3. **Prepare the launch.** `fm-spawn.sh` validates the brief, copies it into `launch-brief.md`, and appends Firstmate's current worker contract.
4. **Start the worker.** Firstmate passes the generated launch brief to the selected harness as its initial instructions.

Ship and scout relaunches rebuild the launch brief from the authored source.
Persistent secondmate charters follow a separate path.
See Firstmate's [brief-authoring instructions](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/AGENTS.md#L525-L538) and [launch-brief construction](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-spawn.sh#L2168-L2213).

### The preparation handshake

Here is the same launch sequence with FM Linear's preparation step inserted between authoring the brief and preparing the launch:

1. **Create the brief.** `fm-brief.sh` scaffolds `data/<task-id>/brief.md` and refuses to overwrite an existing brief.
2. **Fill in the assignment.** Firstmate writes the user's request under `## Captain's intent` and its execution instructions under `## Firstmate spec`.
3. <span class="fm-inserted-label">Added by FM Linear</span>
   **Prepare workflow requirements.** Firstmate calls FM Linear's preparation command for that task and waits for it to finish.
   FM Linear adds the applicable workflow requirements to `brief.md` and returns success only after the brief is ready.
   Firstmate proceeds to the next step only after successful preparation.
4. **Prepare the launch.** `fm-spawn.sh` validates the brief, copies it into `launch-brief.md`, and appends Firstmate's current worker contract.
5. **Start the worker.** Firstmate passes the generated launch brief to the selected harness as its initial instructions.

:::note[Firstmate may forget to call FM Linear]
Firstmate is an agent that follows instructions, so asking it to call FM Linear's preparation command cannot guarantee every dispatch includes that step.
Firstmate's integration contract does not provide a hook that enforces the call before launch.

As a fallback, FM Linear's proposed recovery checks compare the launched brief with the expected workflow instructions.
If instructions are missing, FM Linear asks Firstmate to send them to the running crewmate.
This fallback cannot undo work already performed, and detecting every missed preparation still needs verification.
See [Detecting and recovering from missed preparation](#detecting-and-recovering-from-missed-preparation) for details.
:::

For example, if you configured a recap instruction for `build`, the prepared implementation brief could contain:

```markdown
## Firstmate spec
Implement the invitation flow described above.

### FM Linear workflow requirements
Create an interactive HTML recap of the completed work.
Explain what changed, how to review it, and the verification results.
Include the recap link in your completion report.
```

FM Linear must preserve the captain's words and the existing Firstmate instructions and safety contracts.
It edits the authored `brief.md`, not the generated `launch-brief.md`.
When Firstmate follows this sequence, preparation finishes before the launch copy, so the integration does not depend on a file watcher winning a race.
A failed preparation must be resolved before proceeding with dispatch.

### How Firstmate learns the sequence

Firstmate supports persistent local preferences in `data/captain.md` and inherited supervisor preferences in `data/captain-shared.md`.
Its session-start code includes those preferences in the supervisor's context.
An FM Linear setup command could record the instruction to prepare each applicable brief and wait for success before dispatch.
See [Firstmate's captain preferences](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/configuration.md#L215-L221).

`config/crew-dispatch.json` selects harness, model, and effort; it does not register an instruction provider.
The external extension manifest accepts the process-event adapter capability, not a general launch hook.
Firstmate's built-in backlog gate checks work-item eligibility, and runs after the launch brief is rendered; it does not check FM Linear requirements.
A supported upstream preparation hook could close this gap.
A separately designed wrapper or shim would need verified coverage, including paths that could bypass it.

### Detecting and recovering from missed preparation

As a fallback, FM Linear should record which task, authored brief version, and workflow requirements were prepared, then compare that record with the brief used for the observed launch.
If requirements were missing, it should notify Firstmate and request a [corrective message to the running worker](/reference/messages/#changes-to-running-work).
The design must also distinguish missing evidence from a confirmed mismatch.
Checking the actual launch attempt matters because a later relaunch can replace `launch-brief.md`.
Reliable detection of every launch still needs implementation and verification.

Recovery can supply a missing review-guide instruction, but cannot undo work already performed.
If the missing requirement was to wait for approval, Firstmate needs to assess what happened and pause or correct the work as appropriate.
Observation is a fallback for omissions, not the mechanism that edits briefs just in time.

## Custom review tools


Your workflow can ask the crew to use a tool such as Validatus during validation.
FM Linear owns when that request applies and the instruction supplied with the assignment.
Firstmate's execution environment must provide the installed tool, access, credentials, and usage guidance needed to run it.
Adding a tool's name to workflow instructions does not install or configure that tool.

For example, a `validate.instructions` entry could say:

> Use Validatus to review the proposed changes.
> Address its findings and include the review report when requesting merge approval.

FM Linear supplies that instruction before the relevant validation assignment; Firstmate coordinates the tool use.
If you require proof that Validatus ran before merge approval, instructions alone are insufficient.
That would need explicit integration support to verify a result tied to the reviewed revision and apply a rule that prevents proceeding without it.
There is no dedicated Validatus integration or such result-checking rule specified by this example.

## Metrics for task-brief preparation

| Activity | Measurements |
| --- | --- |
| Prepare an authored brief | Preparation attempts, successful and failed results, and operation duration, associated with the task, attempt, and workflow version. |
| Check an observed launch | Launches with verified matching requirements, confirmed mismatches, and unknown preparation evidence. Only verifiable launches belong in a verified-coverage rate. |
| Recover from missing instructions | Distinct corrective requests, observed notifications, repeat notifications, and pending correction age, attributed to brief-preparation recovery. |

Writing a brief is a code operation and does not itself count as a notification to Firstmate or a new agent turn.
If recovery requires a message, that message also follows the [message activity metrics](/reference/messages/#metrics-for-other-message-activities); retain its request identity so summaries do not count it as two different requests.
Verified text in a launch brief establishes instruction delivery, not agent compliance.

Collection and complete launch observation still need implementation.
See [Metrics](/reference/metrics/) for coverage and missing-data rules, including when token usage must remain unavailable.

## What brief preparation guarantees

Successful preparation means FM Linear added the workflow instructions to the task brief.
Checking the launch brief confirms whether those instructions reached the crewmate at the start of that assignment.
Neither check proves that the crewmate followed the instructions or produced the requested result.
FM Linear publishes the supporting materials actually reported with the work; it does not assume every deliverable has a recap.

If an instruction changes after dispatch, Firstmate must explicitly [update the running assignment](/reference/messages/#changes-to-running-work).
Editing the saved YAML or source brief alone does not update the worker's existing context.

For a missing instruction or an incorrect preparation result, see [Reporting bugs](/guides/troubleshooting/).
