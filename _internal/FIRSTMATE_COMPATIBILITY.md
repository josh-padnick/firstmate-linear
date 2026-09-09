# FirstMate adapter compatibility checkpoint

## Scope

This checkpoint records the upstream contracts relevant to the first adapter milestone.
It informs [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md#firstmate-compatibility-and-dispatch); it does not establish that the adapter has been implemented.
The inspected upstream revision is `b84e0e362face25f3dd8945297a3df1320d7668c`, also returned as `origin/main` when refreshed for this investigation.
The remote was fetched again on 2026-09-08 for the task-brief insertion review and still resolved to that revision.
See [the extension and customization research](FIRSTMATE_EXTENSION_RESEARCH.md) for the source-cited review of captain preferences, dispatch configuration, extension validation, and backlog gates.

## Requirements before dispatch

FirstMate has an operator-editable task brief at `data/<task-id>/brief.md` in its effective home.
Its [brief command](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-brief.sh) scaffolds the brief and refuses to overwrite an existing one.
The task content separates the captain's intent from FirstMate's execution specification.

The [spawn command](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-spawn.sh) reads that brief before launch, checks required task content, and copies it into a launch brief alongside FirstMate's worker contract.
Consequently, workflow requirements already included in the task brief can reach the worker at launch.
This is a supported content path rather than a modification to upstream source code.

The proposed preparation operation must edit the authored `brief.md` before spawn reads it, placing integration-generated requirements under `## Firstmate spec` while preserving `## Captain's intent` and the scaffold's existing contracts.
It must not edit generated `launch-brief.md`, which spawn regenerates for ship/scout launches and relaunches.
The current code copies the source at [fm-spawn.sh lines 2195-2213](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-spawn.sh#L2195-L2213).
No FM Linear preparation command or guaranteed invocation mechanism is implemented yet.

Firstmate can receive standing instructions through `data/captain.md` and inherited `data/captain-shared.md`.
Those could instruct the supervisor to call a preparation command, but they do not enforce invocation.
An external file watcher cannot guarantee it edits the source before the launch copy occurs.

Scout promotion is a distinct delivery path: [fm-promote.sh lines 161-217](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-promote.sh#L161-L217) render `ship-instructions.md` and print the follow-up send command without executing it.
Requirements for the new phase must be prepared and delivered explicitly; the original brief alone cannot establish that they arrived.

The [extension contract](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md) explicitly excludes instruction injection, before/after hooks, task mutation, and worker-launch grants.
It supplies no general pre-dispatch hook that requires every task to pass through FM Linear's brief preparation.
Preparing a brief for one task therefore does not establish coverage for independently created tasks, decomposition into new tasks, or replacement briefs.
Asking FirstMate to remember a preparation command would not close this gap.

### Selected implementation boundary

The bounded implementation can prepare requirements for an identified task and verify the content that the upstream launch path receives.
FirstMate must retain scheduling, delegation, and worker supervision.
That implementation must describe its guarantee as applying to prepared briefs, with coverage of other dispatch paths unresolved.
Use the [explicit handshake and recovery approach](IMPLEMENTATION_NOTES.md#brief-preparation-handshake-and-recovery) for the first adapter implementation.
Detect missed preparation from available launch evidence and request a corrective message through Firstmate.
Universal dispatch coverage remains unproven; recovery cannot undo work already performed.
Do not silently introduce command interception, an upstream fork, or plugin-owned scheduling to satisfy that requirement.

## Other adapter contracts

| Capability | Available upstream surface | Limitation to preserve |
| --- | --- | --- |
| Inbound work requests and feedback to FirstMate | `process-event-adapter/1` extension. | Captured evidence is not task acceptance, dispatch, approval, or completed handling. |
| Current worker state | `fm-crew-state.sh <task-id>`. | Preserve the reported source and unknown state; its `done` verdict does not establish Linear review readiness or a merged PR. |
| Steering an existing worker | `fm-send.sh <task-id> <text>`. | Durable inbox delivery is distinct from the worker acting on the message; uncertain outcomes need explicit recovery. |
| Prepared initial instructions | `fm-brief.sh` and `fm-spawn.sh`. | The brief path exists, but extensions cannot enforce its preparation on every dispatch. |

Do not generalize retry guarantees between these surfaces.
The process-event protocol provides a stable request identity across a retry before capture.
The send command has target-dependent delivery and correlation behavior; ordinary reruns must not be assumed idempotent.
The selected adapter paths need explicit tests for restart recovery and task identity before exposing automatic retries.

## Platform scope

FM Linear targets macOS and Linux only.
The inspected FirstMate README advertises macOS and Linux, and its lifecycle commands depend on a shell and other host tools.
Windows, including a Windows-to-WSL integration, is outside the supported platform scope.
Verify both the runtime and the Firstmate integration on each supported platform before claiming release support.

## Verification boundary

Upstream's `tests/fm-spawn-dispatch-profile.test.sh` drives the real spawn script with fake terminal and agent tools and isolated Git worktrees.
Its worker-role test executes generated launch commands against an argument-capturing fake harness and checks that authored brief content survives.
The complete dispatch-profile test suite passed during this investigation, including that case.
The suite was rerun successfully on 2026-09-08 after the source refresh with `bash tests/fm-spawn-dispatch-profile.test.sh`.
The restricted sandbox prevented the fixture library from reading process identity, so the successful run used permission for that access with the upstream fake-agent and temporary-worktree fixtures unchanged.
It verifies launch construction, not a live agent's compliance with instructions or universal inclusion of FM Linear requirements.
No live agent or user FirstMate home was used for this check.
