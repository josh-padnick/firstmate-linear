# FM Linear

## Purpose

[FirstMate](https://github.com/kunchenguid/firstmate) orchestrates software work through a first mate and its crewmates.
But it can be confusing to keep track of all the work FirstMate is handling, so while FirstMate works well as a way to dispatch requests and manage many agents, human users also need a place to track all work, understand progress, and provide feedback or approvals.
Many third-party systems can serve that purpose; FM Linear is a FirstMate plugin specifically for Linear.

FM Linear lets users track all work in progress according to their own customizable workflows directly in Linear.
It also lets users communicate with FirstMate through Linear, including requesting work, answering questions, reviewing plans, and approving next steps.
FirstMate remains responsible for orchestration and execution.
FM Linear reliably translates between FirstMate's work and the user's Linear workflow, so tracking stays current without relying on agents to remember bookkeeping.

## Design principles

Use these principles to guide implementation and review.
They describe the intended behavior of FM Linear, not a claim that every capability already exists.

### 1. Deterministic rules belong in code; interpretation belongs with agents.

When recorded facts and configured policy determine what should happen, code performs the action.
Agents handle questions that require interpretation.
An agent reports "the plan is ready for review."
FM Linear creates the review thread, updates the status, assigns the captain, and tracks the unanswered request.

### 2. FirstMate owns execution; FM Linear remains an independently installable plugin.

FirstMate owns accepted work, scheduling, delegation, worker supervision, and execution state.
FM Linear owns correspondence with Linear and reliable information delivery.
Use existing FirstMate interfaces, isolate compatibility code, and require no upstream modifications.

### 3. Give each fact and tracking field a precise meaning.

Define what each signal establishes and what each field represents.
A worker stopping, a PR opening, and a PR merging mean different things.
Likewise, who is doing the work and who owes the next action are distinct facts.
Define those meanings explicitly and apply them consistently.
When the evidence is unclear, preserve that uncertainty and ask FirstMate to interpret it.

### 4. Once information is accepted, keep it until its handoff is confirmed.

Save incoming messages and pending actions so they survive crashes and restarts.
Retrying a delivery must not repeat an already completed action.
Distinguish receiving a comment, delivering it to FirstMate, and resolving its request.
Confirmation of one does not establish the others.

### 5. Keep checking that Linear reflects the intended state.

Apply updates when events arrive, then periodically check for missed or incomplete changes.
Check status, assignee, and managed labels separately.
A correct status does not mean the assignee is correct.
Give captain edits an explicit meaning so automation knows when to preserve them or resume updating.

### 6. Keep related discussion in the same comment thread.

Replies stay in the thread they answer.
Keep feedback, revisions, and follow-up questions about the same topic together.
Start a new thread for a distinct topic, and make that choice explicit.

### 7. Let users customize and maintain their workflow.

Let users configure teams, people, statuses, labels, approval rules, and notifications without editing code.
Support changes to that configuration over time while preserving history, pending work, and reliability guarantees.

### 8. Provide opinionated defaults that users can change.

Offer a coherent starting workflow and setup experience, including recommended labels and mappings.
Separate underlying identities, such as model identifiers, from their presentation in Linear.
Preserve user customizations during updates.
Offer new defaults for review without overwriting existing choices or historical meaning.

### 9. Make problems diagnosable and improvements easy to report.

Show when delivery is pending, information is stale, or an update has failed.
Preserve enough context to explain what happened.
Help users distinguish a bug, a supported customization, and a feature request.
With their approval, prepare and submit a report containing relevant evidence while excluding secrets and unrelated private content.
Verify fixes through the complete workflow, including retries and restarts.

### 10. Make each Linear issue sufficient to understand and continue its work.

Keep the issue's relevant context available in its description, comment threads, attachments, or labeled links.
Include the objective, requirements, acceptance criteria, plans, decisions, artifacts, current progress, and remaining work as applicable.
Identify the current plan and artifact versions while preserving the history behind them.
A future first mate or crewmate should be able to retrieve what it needs without access to an earlier agent's conversation or temporary worktree.
Use durable links accessible to the intended participants, and keep secrets out of issue content.

### 11. Give agents the workflow requirements before they need to act on them.

Include applicable instructions and expected outputs in the task assignment.
Make later changes explicit.
Check required outputs before handing work to the next participant, so missing requirements become visible.
