# Testing FM Linear

**Status: Proposed.**
This document specifies the testing approach to implement; the runtime test harness, fault-injection fakes, and compatibility suite do not exist yet.

## Purpose

Tests should let us change FM Linear confidently without losing work, repeating actions, or sending information to the wrong task.
Choose tests by the likelihood and consequence of failure, then use the lowest layer that can prove the behavior.
Do not optimize for a coverage percentage or test private implementation details.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for subsystem ownership, [ERRORS.md](ERRORS.md) for failure and recovery semantics, and [LOGGING.md](LOGGING.md) for diagnostic contracts.
Those documents state what must hold; this document states where and how it is proven.
When a test and a source document disagree, identify the intended behavior before changing either.
Correct an inaccurate document or implementation explicitly; do not weaken a contract merely to make a test pass.

## Test at the layer that owns the promise

| Layer | What it proves | Approach |
| --- | --- | --- |
| Pure decisions | Workflow transitions, approval scope, configuration resolution, deduplication keys, incident fingerprints, condition transitions, and notification policy. | Colocated `bun:test` tests with explicit inputs and outcomes. |
| Structured contracts | Stable error codes, operation-specific results, event definitions, serialized CLI output, and incident export schemas. | Schema validation and versioned fixtures that prove required fields, meanings, and reader compatibility. |
| SQLite integration | Constraints, atomic capture, pending actions, cursor advancement, incidents, metric observations, migrations, and recovery. | Real `bun:sqlite`, production migrations, and an isolated temporary database. |
| External adapters | Linear response handling and Firstmate command, file, and event contracts. | Controlled HTTP responses; actual Firstmate scripts in isolated homes with fake harnesses. |
| Service and CLI journeys | Startup checks, routing, persistence, delivery, restart, diagnostics, and user-visible failure handling work together. | Launch the real executable with a temporary configuration and database, a local Linear test server, and an isolated Firstmate fixture. |
| Documentation journeys | Navigation, examples, links, and essential interactions work in the built site. | A small browser suite plus focused visual inspection. |
| Live integration checks | Selected assumptions still hold against the real external service. | Explicitly enabled checks in a disposable Linear team and Firstmate home, separate from ordinary CI. |

Mock the external boundary, not the modules whose composition the test is intended to prove.
A fake HTTP server can prove retry handling; it cannot prove that Linear supports a particular query or mutation.
A fake Firstmate script can prove our parser; it cannot prove the upstream script's behavior.
Label those limits in test names and reports.

## Shared fault injection

Build small controllable fakes at external I/O boundaries as the corresponding adapters are implemented.
Reuse fixture builders and failure scenarios where they express the same contract, while giving each test isolated state.
Do not require a complete integration simulator before the first subsystem can be tested.
Each fake exposes relevant failure modes from ERRORS.md so tests can name the scenario without duplicating response construction.
Use explicit fault injection at these boundaries instead of production flags that manufacture failures on real tasks.

| Boundary | Scenarios to exercise as support is implemented |
| --- | --- |
| Linear test server | Validated success; GraphQL errors in a successful HTTP response; partial effects; rate limits with verified retry guidance; timeout before or after a write takes effect; interrupted pagination; malformed responses; unresolved write outcomes. Model duplicate-submission and history-gap behavior only for interfaces whose contracts establish it. |
| Firstmate fixture | Parseable task and backlog files; schema-changed files; `fm-crew-state.sh` non-zero exit or unparseable output; `fm-procevent.sh` exit 0 without capture confirmation; `fm-send.sh` path with unverified confirmation; report that is incomplete, mismatched, or for a stale attempt; installed checkout change during a run. |
| Real SQLite and storage fault injection | Transaction rollback, lock contention, read-only access, capacity limits, interrupted migrations, and corrupt temporary files. Exercise SQLite behavior with real databases; inject failures at the storage boundary when the physical condition is impractical to reproduce. |
| Log sink and stderr | Unwritable file; unavailable stderr; both sinks failing; buffer exhaustion; serialization failure; control characters and terminal escapes. |
| GitHub submission | Success with URL; auth unavailable; timeout after creation; search unavailable. |
| Clock | Injected wall clock and monotonic clock; backwards wall-clock step across a restart. |

Record relevant calls at controlled boundaries so tests can assert that prohibited mutations, launches, or notifications were not attempted through them.
Call recording supplements isolation; it does not prove that code could not bypass a fake.
Remove inherited credentials and live destinations, constrain filesystem and process access, and restrict network access to the test endpoints.
Verify those restrictions with negative probes before running upstream behavioral fixtures.
If the required isolation cannot be established, do not run the probe or report its contract as verified.

## High-value failure cases

Cover these cases as the corresponding subsystem is implemented.
Avoid duplicating every case at every layer.

| Risk | Required evidence |
| --- | --- |
| Duplicate input | Repeated polls and overlapping pages produce one logical action. |
| Lost input | A crash between capture and cursor advancement loses no accepted record. |
| History gap | When a source exposes evidence of missing history, record the gap and reconcile current state where possible. Preserve historical coverage limits even after reconciliation succeeds; absent evidence does not prove complete history. |
| Uncertain writes | A timeout after a remote effect triggers verification before another write. Exercise each supported mutation's verified recovery strategy, including duplicates and intervening edits; an outcome with no reliable verification path stays held. |
| Restart recovery | Kill and restart around persistence, delivery, incident creation, notification, and report submission. Safe work resumes without duplicate effects; unresolved effects remain held and visible. |
| Obsolete action | A workflow, attempt, or artifact revision change while an action is pending causes re-evaluation, not a blind retry. |
| Exhausted retry budget | The action remains held, preserved, visible in `status`, and associated with the relevant incident. Automatic retries stop until an explicit recovery policy or authorized decision permits resumption. |
| Wrong recipient | Identical task names in different homes, old execution attempts, and different issue threads cannot cross-route messages; a reply lands in its originating thread. |
| False completion | Worker exit, message acknowledgment, artifact availability, approval, and merged delivery remain distinct facts. |
| Invalid approval | An unauthorized actor or an approval for an earlier artifact revision cannot authorize the current action. |
| Incorrect synchronization | Status, assignee, labels, PR links, and dependency relationships reconcile independently while preserving unmanaged data and respecting the manual-edit policy. |
| Missing evidence | An unreadable dependency source or unknown outcome does not become an empty dependency set or a successful result. |
| Expected states | Ordinary waits, settling, temporarily unresolved mappings, and stale observations do not automatically become errors or incidents. A persistent condition that blocks promised delivery escalates according to its impact and policy. |
| Agent noise | Repeated observations produce one outstanding report request, bounded follow-ups, and accurate notification counts. |
| Broken compatibility | A failed or unverified required contract holds affected operations and preserves work. A revision change refreshes evidence without creating a duplicate incident for the same ongoing failure; unused optional capabilities do not trigger urgent alerts. |
| Checkout change | Installed code changes pause affected operations and trigger bounded settling and rechecking. Resume only after a successful check of the matching installation fingerprint, without restarting the service; unstable or unverified code remains held. |
| Invalid configuration | The field and constraint are named; the last valid configuration remains active. |
| Duplicate incidents | Repeated and concurrent failures with one fingerprint produce one incident, bounded notifications, and one operational Linear issue; recovery requires evidence. |
| Alert loop | Operational incident issues are never enrolled as work, even after their managed label is removed. |
| Diagnostics failure | Normal logger calls contain sink and serialization failures. Unsaved work is never acknowledged; local status shows available failure evidence or explicitly reports that storage or diagnostic history is unavailable. |
| Private information leakage | Credentials and sample private comments, briefs, paths, reports, and error payloads do not appear in logs, incidents, operational issues, or report exports at any level. |
| Injection resistance | Prohibited source content is omitted, unsafe fields are removed, and control characters cannot forge entries in structured or terminal output. Sanitized external metadata remains untrusted evidence; these tests do not prove universal agent resistance to malicious instructions. |

Also test partial GraphQL failures, pagination interruption, rate limits, cancellation, malformed responses, and delayed observations at the adapter boundary.

## Privacy canaries

Maintain reusable sentinel values: fake credentials, a comment body, a brief excerpt, a report body, a private path, and an environment value.
Give each value a unique marker so tests can identify where it escaped.
Use them in relevant adapter and service journeys, including failure paths.

Provide a shared assertion helper for diagnostic sinks, incident records, operational alert payloads, and report exports.
Run it during journey teardown, including when a journey fails, without hiding the original assertion failure.
Check the surfaces exercised by the journey and report any unavailable capture surface instead of silently assuming it was clean.
Normal task storage and authorized message delivery may legitimately contain work content; do not apply a blanket ban to those destinations.

Marker scans detect the sampled leaks, not every possible disclosure.
Also test field allowlists, nested causes, truncation, unsafe serialization, control-character escaping, and export redaction.
Keep focused privacy tests for cases that ordinary journeys do not exercise.

## SQLite and process tests

Use a real file-backed database for restart, locking, and migration tests.
An in-memory database is suitable only when file and process behavior are irrelevant to the assertion.
Apply the same migrations and connection settings used by the service.

Test both a fresh database and upgrades from supported prior schemas when stored obligations or their interpretation change.
Verify that an interrupted or failed upgrade leaves a recoverable database and does not discard pending delivery or unresolved incidents.
Exercise transaction rollback, locking, and migration semantics against actual SQLite connections.
Use isolated capacity or permission constraints where practical and controlled storage-boundary failures for other cases.
A mocked storage error proves caller handling, not SQLite durability or recovery behavior.

Give every test its own home, configuration, database, and external identifiers.
Ensure a second service process cannot deliver the same pending action concurrently.
Clean up processes and files even when an assertion fails.
Never load the developer's normal credentials or operate on their live Firstmate home.

## Diagnostics tests

Diagnostics has its own contracts and is tested at the layers above, not as an afterthought of feature tests.

Prove incident grouping and notification suppression with injected repeated and concurrent failures, then restart during grouping and notification and assert one incident and one operational issue.
Prove condition entry, aggregation at the configured interval, and recovery only on evidence.
Prove that retained entries preceding incident grouping remain reachable through occurrence and operation IDs.
Test rotation, installation changes, capture-level changes, dropped entries, and unavailable correlation storage.
Missing or never-captured history must remain distinct from no matching activity.
Verify that `fm-linear logs`, `status`, and incident inspection do not notify Firstmate, dispatch workers, retry actions, or change pending work.
Use recording boundaries together with the isolation controls described above.
For commands supporting `--json`, verify the documented stdout schema with diagnostics enabled on stderr.
Check that progress output does not corrupt the structured result and that fallback diagnostics respect the documented stream format.
Verify that an incident export contains the safe evidence and references required by the [agent reporting procedure](../docs/src/content/docs/for-agents/reporting-bugs.md).
Unresolved references must be labeled as missing evidence, not silently replaced with guesses or private payloads.
Test simultaneous SQLite and log-sink failure without claiming that unavailable diagnostics were saved or displayed.

## Firstmate compatibility tests

The Firstmate adapter owns a versioned suite reused by CI and the proposed `fm-linear test` command.
Test observable contracts: brief creation and preservation, preparation before launch copying, worker-state output, event capture and acknowledgment, and supported message delivery.
Include alternate launch paths as their support is added.

Run behavioral probes against isolated copies of the code being checked, with controlled homes and harnesses.
Run probes within the verified isolation controls described above.
Assert that they neither write to live Linear nor launch live agents, and that a successful or unchanged check does not notify Firstmate.
Message-contract probes may exercise controlled capture and send paths inside their isolated fixtures.
Test incident notification after a failed check separately from the probe itself.
Record the Firstmate revision, relevant local changes, adapter version, suite version, configuration, and platform with the results.
Use known compatible fixtures for reproducible CI and the installed checkout for local compatibility checks.
Missing required coverage is an unverified result, not a passing result.
A relevant code or configuration change during a run prevents that result from authorizing operations on the changed installation.
See [the compatibility-check specification](IMPLEMENTATION_NOTES.md#fm-linear-test-compatibility-command) for activation and invalidation rules.

A passing prepared-brief test establishes that prepared text reaches the worker.
It cannot establish that an agent will always call the preparation command.
Test the skipped-preparation detection and message fallback separately, and preserve that distinction in reports.

## Live integration checks

Live checks verify selected assumptions that local fixtures cannot establish.
Keep an assumption list beside each check, including its source, observed behavior, and limits.
Use explicitly configured disposable resources, bounded requests, and cleanup of only the resources the check owns.
These checks are separate from ordinary CI and from the safe local `fm-linear test` command.

Verify the actual queries and mutations we use, permission behavior, pagination, and the remote identity used to confirm a write.
If an operation supports client-supplied IDs, verify its duplicate-submission and lookup behavior before relying on it for recovery.
Do not generalize that behavior to other operations.
Verify retry metadata where it can be exercised safely; do not deliberately exhaust a user's API allowance to manufacture a rate-limit response.
Keep unexercised behavior explicitly unverified and distinguish documented contracts from sampled observations.

A successful history query does not guarantee future retention or reveal every deleted record.
Verify the retrieval behavior we can observe, and preserve coverage uncertainty where the source offers no guarantee.
A current-state reconciliation can repair a projection without recovering its missing history.

When a live check fails, investigate whether the fixture, credentials, environment, upstream contract, or adapter assumption was wrong.
Update the fixture and implementation according to that evidence; do not automatically redefine expected behavior to match one unexpected response.

## Writing and maintaining tests

Before a bug fix, reproduce the problem through the user's actual entry point as closely as possible.
When an incident export is available, use its timeline and evidence references to help build the reproduction.
If privacy limits or missing observations leave gaps, record them and obtain the minimum additional evidence needed.
Then add the smallest meaningful regression test, observe it fail, and verify the fix through that entry point again.
Name regression tests for the behavior and include an incident or GitHub issue reference when available.
Do not make an opaque fingerprint the only description of what the test proves.
Simple reversible copy or styling changes need focused visual verification rather than tests that merely restate the markup.

Use descriptive behavior names and table-driven cases where the variants matter.
Assert results and externally visible effects, not private calls or broad snapshots.
Assert documented machine-readable fields and semantics, including which unknown or optional fields readers must accept.
Test backward compatibility with supported persisted and serialized versions.
Do not make harmless additive fields, object-key order, or incidental prose into contracts unless the interface explicitly requires them.
Inject a clock for polling, backoff, settling windows, pending age, and retention tests.
Wait for observable conditions with bounded deadlines in process and browser tests; avoid arbitrary sleeps.
Refactoring without a behavior change should usually leave assertions intact.

## Docs and CI

For documentation changes, use the existing commands:

```sh
bun run docs:check
bun run docs:build
```

Check relevant internal links and anchors.
For layout changes, inspect desktop and 390px widths, keyboard focus, contrast, and 200% zoom.
Browser journeys should fail on unexpected page errors and broken required resources.
Screenshots and showcase animations aid review but do not prove runtime integration behavior.

As runtime code lands, wire lint, strict typechecking, unit tests, structured-contract validation, real SQLite tests, adapter contracts, service smoke tests, and builds into CI for pull requests and `main`.
Validate FM Linear-owned error codes and catalog-backed events against their declared contracts, with separate coverage for emergency diagnostic formats.
Use operation-specific result schemas instead of a global result-state registry.
Exercise supported old fixtures against current readers; a version note alone does not prove compatibility.
Intentional breaking changes require an explicit version or migration policy and tests for it.
Run platform-sensitive contracts and executable smoke tests on macOS and Linux.
Required suites must fail clearly when their fixtures cannot run; optional live checks must report their absence explicitly.
Keep the normal suite deterministic and fast by placing assertions at the right layer, not by removing recovery coverage.
Document runnable commands when they exist rather than presenting planned scripts as available tools.
