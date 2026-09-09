---
title: Workflow configuration
description: Understand the workflow YAML, its fields and predefined stages, and the recommended workflow you can customize.
---

Your workflow defines how work moves from an idea to a deployed change or completed deliverable.
It describes the stages, who is responsible at each stage, and what must happen before work can move forward.

Workflow configuration captures that process and the instructions that accompany each stage.
FM Linear represents your workflow in Linear and tells Firstmate what its crew needs to do along the way, such as preparing a plan, waiting for approval, or producing a review guide.

## A minimal example

Suppose your team wants Maya to approve a plan before implementation starts.
This YAML configures that review stage:

```yaml
team: Engineering

teammates:
  captain: Maya
  firstmate: Firstmate

workflow:
  plan_review:
    linear_status: Approve Plan
    linear_assignee: captain
```

This is a small excerpt focused on one stage, rather than a complete workflow from idea to delivery.
The team and account names stand for the selections you make during setup.

### Read it line by line

<div class="workflow-line-table" role="region" aria-label="YAML line-by-line explanation" tabindex="0">

| Line | How to read it |
| --- | --- |
| `team: Engineering` | Use the `Engineering` team in Linear. |
| `teammates:` | Start the list of roles and the Linear accounts that fill them. |
| `captain: Maya` | The account named `Maya` fills the `captain` role. |
| `firstmate: Firstmate` | The dedicated account named `Firstmate` fills the `firstmate` role. |
| `workflow:` | Start the workflow's stage settings. |
| `plan_review:` | A reserved FM Linear stage key. FM Linear interprets it to mean that the designated reviewer must approve the plan before implementation proceeds. Here, `linear_assignee: captain` selects the `captain` (`Maya`) as that reviewer. |
| `linear_status: Approve Plan` | Represent this stage with the Linear status named `Approve Plan`. You can use another name from your team's workflow. |
| `linear_assignee: captain` | Assign this handoff to the `captain` role, which resolves to `Maya` above. |

</div>

Indentation shows which settings belong together.
For example, `linear_status` and `linear_assignee` are inside `plan_review`, so they apply to that stage.

### What this means in practice

When the plan is ready for review, the issue is set to the "Approve Plan" status and is assigned to Maya.
The reviewer can request changes or approve the specific plan for implementation.
The presence of a plan makes it reviewable; it does not make it approved.

To adapt this example, change `Maya` to your reviewer or `Approve Plan` to your team's status name.
Keep `plan_review` to retain the meaning of plan approval.

### Add an instruction when you need one

You do not need to repeat Firstmate's normal planning or implementation instructions.
However, you may want to add an instruction for something specific you want the crew to do, such as creating an interactive recap of its work:

```yaml
workflow:
  build:
    linear_status: Building
    linear_assignee: firstmate
    instructions: |
      Create an interactive HTML recap of the completed work.
      Explain what changed, how to review it, and the verification results.
      Include the recap link in your completion report.
```

This adds a `build` stage to the example above; keep both stages under the same `workflow` section.
`instructions` applies to work done during `build`, so the crewmate receives the recap request with its implementation assignment.
The captain reads the recap later, during deliverable review.
The `plan_review` stage needs no agent instructions in this example.

### How does FM Linear communicate with Firstmate?

The [task-brief guide](/reference/firstmate/#workflow-instructions-before-work-starts) explains how instructions are delivered and the current limitations.

## Reference

The following sections describe all predefined stages and configuration fields.
The setup wizard saves your choices in YAML; you can [ask Firstmate to update them](/reference/configuration/#maintain-the-workflow) or edit the configuration directly.
See [configuration locations](/reference/configuration/#where-configuration-lives) for where your settings live.

### Predefined workflow stages

A workflow stage tells FM Linear what is happening and what kind of action is needed next.
Its **stage key** connects that meaning to integration rules: which stage-specific instructions to give Firstmate, who needs to respond, and what an approval authorizes.

See [how instructions reach Firstmate and the crew](/reference/firstmate/#workflow-instructions-before-work-starts) for the delivery mechanisms and their limits.

For example, `plan` means the crew should prepare an approach.
`plan_review` means a person must approve that approach before implementation proceeds.
FM Linear uses that distinction to supply planning instructions during preparation, then present the plan to the reviewer and relay approval of that specific plan to Firstmate.

Your Linear status might call plan review `Approve Plan`, `Design Review`, or something else.
The `plan_review` key gives FM Linear a consistent meaning to act on across those names.
The example status names below illustrate one team's workflow.
The final column identifies the integration action and gives example text where a message is needed:

- **Prepare brief:** add text to the task's authored brief before Firstmate dispatches the relevant work.
- **Message Firstmate:** deliver a request, decision, or approval with its issue, thread, task, and artifact context.
- **Update Linear:** change the issue's status, assignee, or review information to reflect confirmed progress.

The examples describe the intended integration behavior, not fixed prompts.
Custom `instructions` supplement the workflow's approval boundaries.
Approval boundaries must reach the preceding work assignment before it starts; entering a review status is too late to introduce them.

<div class="workflow-stage-table" role="region" aria-label="Workflow stage mappings and actions" tabindex="0">

| FM Linear Stage Key | Example Linear Status Name | What FM Linear sends or updates |
| --- | --- | --- |
| `backlog` | Backlog | **No dispatch action.** The idea stays in Linear until you request work. Being in Backlog does not require an additional state write, a brief edit, or a message to Firstmate. |
| `todo` | ToDo | **Message Firstmate:** When new work is requested through Linear, send: “The captain requests [objective] in [repository]. Here is the issue context; organize this work.” If Firstmate already accepted the request, link the issue and record that it is waiting to start instead of sending the request again. |
| `plan` | Plan In Progress | **Prepare brief.** Include any configured `plan.instructions`. If plan approval is part of the workflow, include the boundary: “Prepare the plan and return it for review. Do not begin implementation before the designated reviewer's approval.” |
| `plan_review` | Approve Plan | **Update Linear:** add the plan link to the issue, set its status to the configured plan-review status (for example, “Approve Plan”), and assign the designated reviewer.<br /><br />**Message Firstmate:** When the designated reviewer approves, send: “Maya approved plan [version/link]. You may proceed with implementation of this plan.” For feedback, deliver the actual comment and ask Firstmate to address it. No new worker brief is needed merely to wait for review. |
| `build` | Building | **Prepare brief.** Include configured `build.instructions`, for example: “Create an interactive HTML recap of the completed work, including verification results, and report its link.” Include applicable delivery boundaries, such as “Return the deliverable for review; do not merge before merge approval.” |
| `deliverable_review` | Approve Deliverable | **Update Linear:** Add the deliverable link and any supporting materials reported with it to the issue, and assign the reviewer.<br /><br />**Message Firstmate:** When the designated reviewer approves, send: “Maya accepted deliverable [version/link]. Proceed to validation; this does not authorize a merge.” For revisions, deliver the reviewer's feedback. |
| `validate` | Validating Code | **Message Firstmate:** When validation is authorized, send: “Validate revision [SHA] using the configured checks and report the findings. Return for merge approval before merging.”<br /><br />**Prepare brief:** If Firstmate dispatches a validation worker, include any `validate.instructions`. If validation is already underway, record progress rather than requesting it again. |
| `merge_review` | Approve Merge | **Update Linear:** Attach the relevant PR to the Linear issue and present the PR revision and validation results to the merge approver.<br /><br />**Message Firstmate:** When the designated reviewer approves, send: “Maya approved merging PR [number] at revision [SHA], subject to the required checks.” A changed revision requires a new approval decision. |
| `done` | Done | **Update Linear** after the configured delivery condition is confirmed, such as the approved PR being merged. No brief edit or new work directive; a stopped worker or approval alone does not establish completion. |
| `waiting` | Waiting | **Update Linear:** Show what is preventing progress and the condition needed to resume. If an explicit task dependency is responsible, include the connected issue’s blocks / blocked-by relationship; see [dependency synchronization](/reference/synchronization/#dependencies-connect-the-issues).<br /><br />**Message Firstmate:** When new evidence arrives, send it for assessment. For example: “The deployment dependency is available. Reassess whether [task] can resume.” Do not infer readiness from the status name alone. |
| `decision` | Needs Decision | **Update Linear:** present the specific question and assign the designated person.<br /><br />**Message Firstmate:** When the designated person answers, send: “For question [ID], Maya answered: [comment]. Apply this answer to that question.” Preserve unrelated open decisions. |
| `firstmate_decision` | Needs Firstmate Decision | **Message Firstmate:** When a new orchestration decision is needed, send: “Task [ID] needs an orchestration decision: [problem and evidence]. Decide how to proceed and report the outcome.” For a decision Firstmate already knows about, record that it owes the next action without duplicating the request. |
| `canceled` | Canceled | **Message Firstmate:** When cancellation is requested, send: “The captain requests cancellation of [task]. Stop or wind down its active work and confirm the outcome.”<br /><br />**Update Linear:** Set the issue to the configured canceled status only after Firstmate confirms cancellation; moving the Linear card alone does not stop a worker. |

</div>

Review examples above follow the recommended approval sequence.
Use the next action permitted by the configured workflow for other kinds of work.
Names, links, revisions, and comments in these messages come from the actual request and its evidence; they must not be invented from a status change.

These rules apply to work enrolled in FM Linear.
An existing Linear issue does not become a Firstmate request just because its status matches a configured stage.
Firstmate continues to schedule and execute work; FM Linear supplies the workflow requirements and tracks the resulting handoffs.

The table describes what each stage means, not proof that the work has reached it.
FM Linear uses observed progress and authorized decisions to establish that, and applies your configured policy to manual status changes.
You can customize the Linear names, responsible people, and instructions while retaining each stage's meaning.

### YAML fields

| Field | Purpose |
| --- | --- |
| `team` | The Linear team whose issues and statuses this workflow uses. |
| `teammates` | Names roles such as `captain` and `firstmate` and connects them to Linear accounts. |
| `workflow` | Contains stage settings under predefined keys such as `plan` and `plan_review`. |
| `linear_status` | The Linear status mapped to that stage. |
| `linear_assignee` | A role from `teammates` identifying who owes the next action. |
| `instructions` | Optional guidance for work performed during this stage, supplied before the agent begins that work. |

Indentation groups each stage's settings.

### Stage keys and Linear statuses

In `plan_review:`, the key identifies plan approval to FM Linear.
In `linear_status: Approve Plan`, the value identifies the corresponding status in your Linear team.
Rename the `linear_status` value to match your team's language; keep the stage key so its meaning stays explicit.
When you select the recommended workflow during setup, the wizard reads your selected team's existing statuses and proposes reusing compatible matches.
It lists any missing statuses and asks for permission to create them.
Only approved additions are created; existing statuses are preserved.
You can decline creation and map stages to your existing statuses or customize the workflow instead.

Setup resolves your selected team, accounts, and statuses to their Linear identities.
Display names alone should not select between ambiguous matches.
The order of entries in YAML does not advance an issue; observed progress and authorized approvals determine when it moves.

### Instructions

Use `instructions` for additions to the crew's normal behavior, such as producing an interactive recap during `build`.
Leave it out when no custom guidance is needed.
Instructions belong to the stage where the work is performed, even if the result will be reviewed in a later stage.

The recap request and checking that a recap was delivered are separate concerns.
We still need to define how the crew reports the recap link and how FM Linear confirms it is accessible before review.
Writing an instruction alone does not establish that it was followed or that the recap is useful.
The [task-brief guide](/reference/firstmate/#workflow-instructions-before-work-starts) describes how instructions reach the crew.

## Recommended workflow

For code changes, start with:

**Plan In Progress → Approve Plan → Building → Approve Deliverable → Validating Code → Approve Merge → Done**

This separates approval of the approach, acceptance of the deliverable, and authorization to merge.
Feedback can send work back for revision, and waiting or decision states can interrupt the main path.
A **Done** issue means the configured delivery conditions have been confirmed.

For non-code work, choose an appropriate completion condition, such as acceptance of a report, without requiring a PR.
Use the default workflow as a starting point and customize it to match your team's process.

## People and assignments

| Wizard choice | Recommended selection |
| --- | --- |
| Crew work | Your dedicated Firstmate user. |
| Plan approval | You, or your designated plan reviewer. |
| Deliverable approval | You, or your designated deliverable reviewer. |
| Merge approval | The person authorized to approve merges. |
| Captain decisions | You. |

For a solo setup, the same person can own all four human handoffs.
The assignee changes when responsibility passes between Firstmate and a reviewer.

## Change the workflow

Ask Firstmate to change a status mapping, reviewer, or instruction, then review and save the proposed configuration.
Specify whether changes should apply to assignments already underway.
Invalid changes leave the last valid configuration active.

For team and repository connections, crewmate labels, issue details, and polling settings, see [Configuration](/reference/configuration/).
