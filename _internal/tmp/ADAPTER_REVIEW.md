# Review the Firstmate adapter

The first subsystem connects FM Linear code to Firstmate's files and process-event extension.
The adapter does not connect to Linear, choose workflow actions, run a service, or launch a real agent.

## Scope and interfaces

Callers supply task identities, resolved instruction text, and contextual messages.
The adapter owns Firstmate-specific validation, brief edits, transport receipts, and response capture.
Callers retain Linear issue and thread mappings, approval rules, and retry scheduling.

| Interface | Input | Result |
| --- | --- | --- |
| `getFirstmateInstallation` | Explicit home and code-root paths | Home identity, checked-out commit, and content fingerprint. |
| `testFirstmateInstallation` | Installation and selected capabilities | Passed, failed, or not verified for each capability, with evidence. |
| `getFirstmateTask` | Home-qualified task reference | Activity, source, observation time, attempt identity when known, and brief revision. |
| `updateFirstmateBrief` | Task, expected revision, instruction text, and instruction version | A durable receipt identifying the updated authored brief. |
| `checkFirstmateBrief` | Update receipt and execution attempt | Included, missing, or not verified against available launch evidence. |
| `sendFirstmateMessage` | Request ID, destination, text, context, and expected response kind | A durable receipt: queued, offered to Firstmate, or captured by Firstmate. |
| `receiveFirstmateMessage` | Reply or unsolicited task report | A durable response with correlation and current, historical, or unknown relevance. |

The typed interface lives in [adapter.ts](../../src/firstmate/adapter.ts).
[types.ts](../../src/firstmate/types.ts) defines the request and result objects.
The CLI supplies a small command surface for development and review.
The development CLI does not implement the full CLI described by the product documentation.

## Before running the checks

From the repository root, install dependencies and select your existing Firstmate checkout:

```sh
bun install --frozen-lockfile
export FIRSTMATE_SOURCE=/Users/personal/Code/kunchenguid/firstmate
bun run scripts/build.ts
```

On another computer, set `FIRSTMATE_SOURCE` to its local Firstmate checkout.
The checks copy upstream scripts into disposable fixtures.
They use synthetic data and a terminal double that cannot launch a crewmate.
They do not use your live Firstmate home or contact Linear.

The fixture verifies filesystem and network isolation before executing upstream scripts.
macOS uses `sandbox-exec`; Linux requires `bubblewrap` and permission to create an isolated user namespace.
Bun, Node, Bash, Python 3, and Git must be available.
Unavailable isolation produces `not-verified`, never a pass.

## Review output and exit codes

Human-readable output is the default.
It shows the selected Firstmate source path and checkout revision at the start and in the final summary, and indicates local script changes.
The checks use disposable copies of that source, not your live Firstmate home.
Each numbered step reports whether the observed result matches its expectation.
A deliberately broken contract is a successful review step only when the helper confirms the expected failure.
Any mismatch stops the review and exits nonzero, including a missing, failed, or unverified initial capability and a failed restoration check.

```sh
bun run scripts/review.ts compatibility
bun run scripts/review.ts compatibility --verbose
bun run scripts/review.ts compatibility --format json
bun run scripts/review.ts compatibility --format toon
```

All four review scenarios support these options.
`--verbose` shows fixture paths and full details in human output.
Interactive pauses and the optional fixture reply prompt appear only in human mode when both input and output are terminals.
JSON and TOON run without prompts and write one result document to stdout after cleanup.
They encode the same object using JSON or the official `@toon-format/toon` library.

The version 1 result contains `scenario`, overall `status`, numbered `steps` with their checks, full `details`, and safe `errors`.
Each check contains `name`, `expected`, `actual`, and a `status` describing whether those values match.
For an intentionally broken contract, `actual: failed` and `expected: failed` produce check `status: passed`.
Readers should tolerate additive fields.
Fixture paths in the details refer to disposable files removed at the end of the run.

Exit codes are `0` when all expectations pass, `1` for an assertion, execution, or cleanup failure, and `2` for invalid arguments or a missing `FIRSTMATE_SOURCE` setting.
The helper retains completed steps in failed machine-readable results.
These options apply to `scripts/review.ts`; the adapter CLI's existing JSON contract is unchanged.

## Four manual checks

Run each command from the repository root.
In an interactive terminal, the helper pauses so you can inspect files and results.
Press Enter to continue.
The helper removes only its disposable fixtures when the check finishes.

### 1. Compatibility and changes

```sh
bun run scripts/review.ts compatibility
```

First, expect all three capabilities to pass.
The helper then changes the copied worker-state script.
Expect `firstmate.capability_held` before another task read and a failed state-contract check.
After restoring the script, the helper reruns that check and reports a pass.

A matching prior fingerprint can reuse its earlier passing evidence.
The adapter does not fetch Firstmate or automatically schedule rechecks.

### 2. Task identity and uncertainty

```sh
bun run scripts/review.ts tasks
```

The initial compatibility check exercises a known working task, a transition to awaiting a decision, and stale or missing lifecycle evidence.
Add `--verbose` to see the individual observations.
Expect different home IDs for the two fixtures, even with the same task name.
Missing task metadata produces `unknown`, with source `none` and no execution attempt.
Passing the other home's task to the first adapter produces `firstmate.scope_mismatch`.

### 3. Brief instructions and missing preparation

```sh
<```

Open the authored and launch brief paths printed by the helper.
The captain's assignment remains intact, and the recap instruction appears once in the managed section.
The first result should be `included`.

The second fixture deliberately removes the prepared instruction before launch.
Expect `missing` for that launch.
An unavailable or different execution attempt instead produces `not-verified`.
Neither result establishes that an agent followed the instruction.

### 4. Messages, replies, and restart recovery

```sh
bun run scripts/review.ts messages
```

Enter a short fixture reply, or press Enter to use the sample.
Read the request's text and context.
The request contains enough information for Firstmate to understand the question without looking up a Linear thread.
Expect one captured event after reopening SQLite and retrying the request.
The response retains the original request ID, and replaying the response returns its original receipt.
The adapter rejects an unknown request ID.

The helper submits your fixture reply through the compiled `respond` command.
The response in this fixture is synthetic.
The check proves transport and correlation, not how an LLM will answer.
A future caller uses the returned request ID to retrieve its own Linear issue and thread mapping.

## Commands and local integration

Build the executable with `bun run build`.
For command usage, run `./dist/fm-linear help`.
Except for package creation, commands require explicit `--home`, `--code-root`, and `--state` paths.
The database must live in a private directory with mode `700`.

| Command | Purpose |
| --- | --- |
| `installation` | Inspect the selected installation without changing it. |
| `test` | Check the selected message binding, run isolated capability probes, and save their results. |
| `task TASK_ID` | Read one identified task. |
| `brief-update --input FILE` | Read a `FirstmateBriefUpdateRequest` JSON file and update the authored brief. |
| `brief-check --receipt FILE --input FILE` | Compare a saved update receipt with a task-attempt JSON file. |
| `send --input FILE` | Save a contextual request and register its Firstmate event source. |
| `receive --input FILE` | Validate and retain a reply or unsolicited report. |
| `respond REQUEST_ID --input FILE` | Submit a response content object, such as `{"kind":"text","text":"The plan is ready."}`. |
| `extension-package DIRECTORY --executable PATH` | Create an installable package in a new directory outside Git projects and Firstmate homes. |

`respond` derives a stable message ID from the request and answer.
For a distinct follow-up with identical text, supply a new `--message-id`.
Commands print readable results and errors by default.
Use `--format json` or `--format toon` for structured results; `--json` remains an alias for JSON.
Successful results go to stdout; errors go to stderr in the selected format, with no extra human text.
Both machine formats preserve the same result fields and diagnostic schema.
The Firstmate extension protocol always uses JSON.
Exit codes remain `0` for success, `1` for failed or unverified compatibility checks, and `2` for command errors.
Exit codes are `0` for success, `1` for failed or unverified compatibility checks, and `2` for command errors.
Safe diagnostics go to stderr.

Package creation does not enable the extension in a live home.
After reviewing the package, an operator can bind it using Firstmate's command:

```sh
FM_HOME=/path/to/home /path/to/firstmate/bin/fm-extension.sh bind \
  /path/to/package --adapter fm-linear --trust-same-user-code
```

The package calls the compiled FM Linear executable at its recorded path.
End users do not need Bun to run that executable.
Run `fm-linear test` after binding or changing installation inputs.
The messages check resolves and handshakes the selected home’s installed extension before running disposable transport probes.
It does not send a work request to that home, but Firstmate may create extension handshake state there.
A missing or invalid binding fails the message capability check.
Firstmate's watcher starts registered event sources through its normal reconciliation cycle.
Saving a request alone does not mean Firstmate captured or answered it.

## Validation and limits

Run the automated checks with:

```sh
FIRSTMATE_SOURCE=/path/to/firstmate bun run check
bun run build
./dist/fm-linear help
```

CI checks macOS and Linux against Firstmate commit `6ee33265b6232ecca5821dbb5a0f08952e133bb5`.
Linux coverage remains unverified until the CI workflow passes.
The expanded task-state probe passes locally on macOS against both that pinned revision and checkout `861b5dad2baaa0a64703a1b0c14fb4da9bda5269`.

| Behavior protected | Test level and reason | Evidence |
| --- | --- | --- |
| Brief preservation, stale edits, and missing launch instructions | Unit tests for section editing; real files and SQLite for revision and receipt behavior. | `tests/briefs.test.ts` |
| Request identity, duplicate replies, and stale-attempt handling | Component tests need real persistence and task metadata. | `tests/messages.test.ts` |
| Upstream changes and transport capture | Actual upstream scripts in OS-isolated fixtures; mocks cannot establish compatibility. | `tests/contracts.test.ts` |
| Acceptance before process death and clean CLI errors | Process tests exercise termination and the executable's stream boundary. | `tests/cli.test.ts` |

The brief probe covers Firstmate's ship/local-only launch with a fake tmux terminal.
The probe does not verify every backend, remote execution, or agent compliance.
The state probe runs Firstmate's actual state-query and lifecycle-event scripts against a disposable local Claude/scout task with a fake readable tmux endpoint.
It verifies the task identity and execution attempt through FM Linear's task reader, then checks:

- An absent task returns `unknown` without an execution attempt.
- A known task with current lifecycle evidence returns `working`.
- After an idle event and a `needs-decision` status, the next query returns `parked`.
- Lifecycle evidence from a previous incarnation returns `unknown`, even when an old status still exists.
- Missing lifecycle evidence returns `unknown` rather than trusting that old status.
- Removing task metadata returns `unknown` without retaining the previous execution attempt.

These cases run as part of `fm-linear test`, not just the manual review helper.
The compatibility suite is version `2`; results from the earlier, narrower suite do not authorize task reads.
This checks state interpretation with controlled evidence, not live backend health, remote tasks, other harnesses, or no-mistakes run attribution.
Dependencies remain explicitly unknown because no reliable dependency-reporting contract has been selected.

Brief edits serialize FM Linear writers using SQLite and reject changed source revisions.
Firstmate must finish authoring before calling the update command and wait before launching.
The independent Firstmate writer does not participate in FM Linear's lock, so arbitrary simultaneous external edits remain a limitation.
Launch checks report a point-in-time observation, not an immutable history of every dispatch.

If a different host invocation appears before capture is confirmed, the adapter holds the ambiguous delivery instead of blindly offering the message again.
A future delivery subsystem will own intervention and retry policy.
Automatic installation monitoring, incident notifications, Linear updates, metrics reports, and the setup wizard remain outside this milestone.

## First-pass review evidence

`autoreview --mode local --engine codex` identified one selected-home message-binding gap.
The adapter now verifies that binding before marking messages usable, with a regression check for an unbound home.
All 9 tests and 42 assertions, lint, and typechecking pass locally on macOS.
A second external review attempt was blocked by automatic approval review because it could transmit repository source; the fix received local review instead.
No clean second external-review result is claimed.

## Review-helper validation

Format tests verify that JSON and TOON preserve the same result, including multiline text and punctuation.
Assertion tests distinguish an expected failure from incomplete evidence.
A process test injects an unverified compatibility result at the adapter boundary and verifies that the actual review command exits `1` with a failed result instead of continuing.
Process checks also verify a parseable JSON or TOON error and exit `2` when configuration is missing.
These tests live in `tests/review.test.ts`; process coverage is necessary to prove stdout and exit-code behavior.

## Expanded task-state validation

The known-task regression in `tests/contracts.test.ts` replaces only a disposable copy of the state-query script with one that always returns a valid `unknown` answer.
That script passed the earlier missing-task probe and now fails the known-working-task check.
The test belongs at the component integration level because it must exercise the compatibility gate, the production task reader, and Firstmate's actual lifecycle scripts together.
The full local check passes with 14 tests and 65 assertions, plus lint and typechecking.
The manual task review also passes against the CI-pinned Firstmate scripts.
