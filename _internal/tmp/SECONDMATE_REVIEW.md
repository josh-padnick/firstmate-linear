# Review secondmate support

FM Linear can discover and inspect work in the primary Firstmate home and its directly registered secondmate homes.
Remote reads use the primary's `fm-on.sh`; secondmates need no FM Linear installation.

## Scope and interfaces

| Interface | What it does |
| --- | --- |
| `getFirstmateFleet(options)` | Reads full inventories, returns home-qualified work and coverage, and saves observations in SQLite. |
| `getFirstmateTask(task)` | Reads the exact task in its owning home, including presence, state, brief revision, and verified execution generation. |
| `checkFirstmateBrief(receipt, attempt)` | Reads local or routed launch evidence and checks the instruction block between generation checks. |
| `testFirstmateInstallation(capabilities)` | Separately tests local task state, briefs, messages, fleet inventory, and routed reads. |
| `sendFirstmateMessage(message)` | Continues sending requests to the primary, which owns forwarding to secondmates. |

`FirstmateHomeRef` identifies an operational home within a primary connection.
`FirstmateHomeRoute` records how Firstmate reaches that home.
`FirstmateWorkObservation` distinguishes a worker, a secondmate record, and a backlog item.
`FirstmateHomeObservation` carries freshness, coverage, and current or last-known work.
`FirstmateFleetSnapshot` groups those observations and reports read metrics.

The adapter does not create Linear issues, resolve workflow policy, schedule polling, or forward instructions independently of Firstmate.
Remote brief writes remain unsupported.
Instruction checks verify an exact managed instruction block; they do not certify a paraphrase or agent compliance.

## Before you start

Build the executable:

```sh
bun run build
```

Use your existing `fml` shell function, or define it with explicit paths:

```sh
fml() {
  ./dist/fm-linear "$@" \
    --home /Users/personal/Code/kunchenguid/firstmate \
    --code-root /Users/personal/Code/kunchenguid/firstmate \
    --state "$HOME/.local/state/fm-linear/adapter.sqlite"
}
```

The following checks use disposable copies of the installed code and do not launch agents:

```sh
fml test --capability task-state --capability fleet --capability routed-reads
```

All three selected checks must pass.
Run them again after rebuilding FM Linear or changing Firstmate; a prior build's check does not authorize the new build.
The full `fml test` also checks briefs and the configured message extension.

## 1. Find and inspect delegated work

```sh
fml fleet
fml fleet --secondmate big-plan --format json
fml task TASK_ID --secondmate big-plan
```

Replace `TASK_ID` with an exact task ID from the fleet output.
Check that the secondmate task has a different home ID from the primary and that its execution generation matches its owning home.
The `big-plan` selector is an example from the current setup, not a built-in name.

Repeat with `--format toon` if you want machine-readable output for agents.
Fleet exit code `1` means some inventory is incomplete; the output still includes usable observations.
Unstructured backlog entries produce partial coverage rather than disappearing silently.

Task presence is separate from activity.
An existing brief can establish `found` even when the worker metadata is gone.
Missing metadata and an unreadable remote file do not prove deletion; the task may return `not-verified`.
Exact IDs are preserved, including a trailing period if supplied.

## 2. Check freshness during ordinary work

```sh
fml fleet --secondmate big-plan --refresh --format json
```

Run this before and after a task changes during work you already authorized.
Compare the home's `observedAt`, `collectedAt`, `ageSeconds`, and its separate `summary.observedAt`.
The full inventory can be newer than the published summary.
The adapter records observed timing; it cannot infer when an unseen change actually happened.

No test assignment is required.
The adapter does not alter Firstmate's summary refresh interval.

## 3. Verify outage and recovery safely

```sh
FIRSTMATE_SOURCE=/Users/personal/Code/kunchenguid/firstmate \
  bun test tests/fleet.test.ts tests/fleet-contract.test.ts
```

The storage test simulates an unavailable read route, checks last-known work, verifies backoff, and restores the route.
It also checks that a changed route is held and that no message requests were created.
The contract test runs actual Firstmate scripts with simulated SSH, including more tasks than fit in a summary.
It exercises the compiled CLI, so build `.build/fm-linear` first with `bun run scripts/build.ts` after source changes.

These tests leave your actual SSH configuration and remote tasks alone.
Ordinary scans back off for 30 seconds after a home read fails, increasing to at most five minutes.
`fleet --refresh` and explicit task inspection bypass that wait.

## 4. Review instruction forwarding separately

The existing message interface addresses the primary Firstmate.
Include the owning secondmate, exact task, requested instruction, and instruction version in the message context.
Firstmate remains responsible for carrying the instruction into the delegated assignment.

The automated fixture proves that a routed launch brief can be read and its exact instruction block checked without a remote FM Linear install.
A live forwarding test requires a captain-approved harmless assignment.
That live agent test has not been run; delivery to the primary is not a guarantee of timely forwarding.

## Limits and recovery

- Only directly registered children are enrolled; nested delegation is reported but not traversed by FM Linear.
- Each scan has a 60-second budget, a 2 MiB limit per command, two concurrent home reads, and at most 20 selected child reads.
  Larger fleets return partial coverage; select a particular secondmate to inspect it directly.
- Home IDs survive process restarts and SQLite upgrades.
  A changed route remains held: restore the original route, or register a replacement home under a new secondmate ID to keep old task links intact.
- A missing task in a later inventory remains last-known, not completed or canceled.
- Successful transport does not certify the remote checkout's complete compatibility.
  The local suite verifies routing at a simulated SSH boundary; live schemas and task generations are checked on every read.
- No service scheduler, Linear publication, or unsolicited agent requests are part of this increment.

## Live evidence from September 10, 2026

The primary checkout was `861b5dad2baaa0a64703a1b0c14fb4da9bda5269`.
The compiled adapter passed both fleet and routed-read probes.
One full primary-plus-secondmate scan took 17.5 seconds and made two snapshot calls.
It reported the primary's unstructured backlog as partial coverage and the registered Mac Mini home's inventory as complete.
It read `bp-big299-table-controls` through the primary as `parked`, with generation `s1789062933.15854.13428` and a brief digest.
No FM Linear installation, configuration change, or agent message was made on the Mac Mini.

This is a point-in-time read check, not a measurement of every task transition or a remote installation fingerprint.

## Validation and test choices

| Behavior protected | Test level and reason |
| --- | --- |
| Clock skew, stale evidence, and exact identities | Unit tests establish these rules without an external process. |
| Home identity, migration, lost visibility, backoff, and route holds | Component tests use real SQLite because mocked storage cannot prove retained records or migration. |
| Full inventories, registered routing, known task state, and launch evidence | Contract tests run actual upstream scripts with fake SSH and terminal boundaries; response-only mocks cannot establish the upstream contract. |
| `task --secondmate` routing | A process test runs the compiled executable to catch argument, format, and home-selection wiring errors. |

The full suite, lint, strict type checking, executable builds, and docs checks passed on macOS.
CI is pinned to the inspected upstream commit and runs the adapter suite on macOS and Linux.
Linux execution has not been observed in this local review.
