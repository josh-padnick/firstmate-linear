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

Expect different home IDs for the two fixtures, even with the same task name.
Missing task metadata produces `unknown`, with source `none` and no execution attempt.
Passing the other home's task to the first adapter produces `firstmate.scope_mismatch`.

### 3. Brief instructions and missing preparation

```sh
bun run scripts/review.ts briefs
```

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
`--json` keeps stdout machine-readable.
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
The local macOS run exercises the same installed revision.

| Behavior protected | Test level and reason | Evidence |
| --- | --- | --- |
| Brief preservation, stale edits, and missing launch instructions | Unit tests for section editing; real files and SQLite for revision and receipt behavior. | `tests/briefs.test.ts` |
| Request identity, duplicate replies, and stale-attempt handling | Component tests need real persistence and task metadata. | `tests/messages.test.ts` |
| Upstream changes and transport capture | Actual upstream scripts in OS-isolated fixtures; mocks cannot establish compatibility. | `tests/contracts.test.ts` |
| Acceptance before process death and clean CLI errors | Process tests exercise termination and the executable's stream boundary. | `tests/cli.test.ts` |

The brief probe covers Firstmate's ship/local-only launch with a fake tmux terminal.
The probe does not verify every backend, remote execution, or agent compliance.
The state probe verifies the output contract for missing evidence; it does not validate live backend health.
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
