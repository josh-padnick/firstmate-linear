# FM Linear test requirements

**Status: Proposed.**
These requirements define the evidence needed as each integration capability is implemented.
They do not claim that the runtime test harness or capability already exists.

## How to use this document

Start with [TESTING.md](TESTING.md) to choose the lowest testing rung that can prove the behavior.
Read the sections below for the capability you are changing; do not repeat this entire document for every PR.
One test may satisfy several requirements when it demonstrates each relevant outcome.
Add coverage with the implementation that makes the requirement applicable.

[ARCHITECTURE.md](ARCHITECTURE.md) defines subsystem ownership and intended behavior.
[ERRORS.md](ERRORS.md) and [LOGGING.md](LOGGING.md) define the error, result, incident, and diagnostic contracts.
This document specifies evidence for those contracts rather than redefining them.
When expectations disagree, resolve the intended behavior in the owning document before changing assertions.

Concrete fixture setup and isolation guidance live in [the test harness notes](IMPLEMENTATION_NOTES.md#test-harness-construction).

## Structured contracts

Verify the required fields and meanings of the [shared error contract](ERRORS.md#use-a-shared-error-contract), including unknown and partial outcomes.
Exercise the operation-specific results defined in [ordinary results and incomplete evidence](ERRORS.md#ordinary-results-and-incomplete-evidence).
Validate catalog-backed log events against their [event definitions](LOGGING.md#scopes-and-event-names), and test emergency diagnostic formats separately.

Use supported prior serialized fixtures to verify current readers and declared migration or version boundaries.
Cover required, optional, and unknown fields according to each interface's compatibility policy.
Do not turn a permitted additive field or irrelevant key order into a breaking change.
A version note alone does not prove compatibility.

## Linear intake

Verify the capture and retrieval promises of [Linear intake](ARCHITECTURE.md#1-linear-intake).

| Risk | Required evidence |
| --- | --- |
| Duplicate input | Repeated polls and overlapping pages produce one logical action. |
| Lost input | A crash between capture and cursor advancement loses no accepted record. |
| History gap | When a source exposes evidence of missing history, record the gap and reconcile current state where possible. Preserve historical coverage limits even after reconciliation succeeds; absent evidence does not prove complete history. |

Also exercise partial GraphQL failures, interrupted pagination, rate limits, cancellation, malformed responses, and delayed observations at the HTTP boundary.

## Firstmate integration

Verify the [Firstmate adapter's contracts](ARCHITECTURE.md#2-firstmate-integration) and preserve the distinction between observation, capture, delivery, and completed work.

| Risk | Required evidence |
| --- | --- |
| Broken compatibility | A failed or unverified required contract holds affected operations and preserves work. A revision change refreshes evidence without creating a duplicate incident for the same ongoing failure; unused optional capabilities do not trigger urgent alerts. |
| Checkout change | Installed code changes pause affected operations and trigger bounded settling and rechecking. Resume only after a successful check of the matching installation fingerprint, without restarting the service; unstable or unverified code remains held. |

Exercise the versioned suite specified by [the compatibility-check contract](IMPLEMENTATION_NOTES.md#fm-linear-test-compatibility-command).
Run probes under the [fixture isolation rules](IMPLEMENTATION_NOTES.md#test-isolation).
Test observable contracts: brief creation and preservation, preparation before launch copying, worker-state output, event capture and acknowledgment, and supported message delivery.
Include alternate launch paths as their support is added.

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

## Work context and workflow rules

Verify [identity and conversation context](ARCHITECTURE.md#3-work-and-conversation-context) together with the [workflow rules](ARCHITECTURE.md#4-workflow-requirements-and-rules) that consume it.
Test decisions at the unit level and routing across components where composition matters.

| Risk | Required evidence |
| --- | --- |
| Wrong recipient | Identical task names in different homes, old execution attempts, and different issue threads cannot cross-route messages; a reply lands in its originating thread. |
| False completion | Worker exit, message acknowledgment, artifact availability, approval, and merged delivery remain distinct facts. |
| Invalid approval | An unauthorized actor or an approval for an earlier artifact revision cannot authorize the current action. |
| Missing evidence | An unreadable dependency source or unknown outcome does not become an empty dependency set or a successful result. |
| Expected states | Ordinary waits, settling, temporarily unresolved mappings, and stale observations do not automatically become errors or incidents. A persistent condition that blocks promised delivery escalates according to its impact and policy. |
| Agent noise | Repeated observations produce one outstanding report request, bounded follow-ups, and accurate notification counts. |

## Linear publication and reconciliation

Verify [publication and reconciliation](ARCHITECTURE.md#5-linear-publication-and-reconciliation) against each supported mutation's confirmed effect and recovery contract.

| Risk | Required evidence |
| --- | --- |
| Uncertain writes | A timeout after a remote effect triggers verification before another write. Exercise each supported mutation's verified recovery strategy, including duplicates and intervening edits; an outcome with no reliable verification path stays held. |
| Incorrect synchronization | Status, assignee, labels, PR links, and dependency relationships reconcile independently while preserving unmanaged data and respecting the manual-edit policy. |

## Durable delivery and recovery

Verify the [durable-delivery obligations](ARCHITECTURE.md#6-durable-delivery-and-recovery) with real persistence and process boundaries where required.

| Risk | Required evidence |
| --- | --- |
| Restart recovery | Kill and restart around persistence, delivery, incident creation, notification, and report submission. Safe work resumes without duplicate effects; unresolved effects remain held and visible. |
| Obsolete action | A workflow, attempt, or artifact revision change while an action is pending causes re-evaluation, not a blind retry. |
| Exhausted retry budget | The action remains held, preserved, visible in `status`, and associated with the relevant incident. Automatic retries stop until an explicit recovery policy or authorized decision permits resumption. |

Test both fresh databases and upgrades from supported prior schemas when existing records or obligations are affected.
Verify transaction rollback, locking, and migration behavior against actual SQLite connections.
An interrupted or failed upgrade must leave a recoverable database without discarding pending delivery or unresolved incidents.
Verify that a second service process cannot deliver the same pending action concurrently.
A mocked storage error proves caller handling, not SQLite durability or recovery behavior.

## Setup, configuration, and lifecycle

Verify [configuration and service lifecycle](ARCHITECTURE.md#7-setup-configuration-and-service-lifecycle) through unit tests for decisions and process tests for executable wiring.

| Risk | Required evidence |
| --- | --- |
| Invalid configuration | The field and constraint are named; the last valid configuration remains active. |

Exercise startup, configuration loading, diagnostic commands, and orderly shutdown with the actual executable.
Check command results and externally visible effects rather than private function calls.

## Diagnostics, incidents, and privacy

Verify the behavior defined in [ERRORS.md](ERRORS.md) and [LOGGING.md](LOGGING.md) at the lowest layer that can establish each result.

| Risk | Required evidence |
| --- | --- |
| Duplicate incidents | Repeated and concurrent failures with one fingerprint produce one incident, bounded notifications, and one operational Linear issue; recovery requires evidence. |
| Alert loop | Operational incident issues are never enrolled as work, even after their managed label is removed. |
| Diagnostics failure | Normal logger calls contain sink and serialization failures. Unsaved work is never acknowledged; local status shows available failure evidence or explicitly reports that storage or diagnostic history is unavailable. |
| Private information leakage | Credentials and sample private comments, briefs, paths, reports, and error payloads do not appear in logs, incidents, operational issues, or report exports at any level. |
| Injection resistance | Prohibited source content is omitted, unsafe fields are removed, and control characters cannot forge entries in structured or terminal output. Sanitized external metadata remains untrusted evidence; these tests do not prove universal agent resistance to malicious instructions. |

Prove incident grouping and notification suppression with injected repeated and concurrent failures, then restart during grouping and notification and assert one incident and one operational issue.
Prove condition entry, aggregation at the configured interval, and recovery only on evidence.
Prove that retained entries preceding incident grouping remain reachable through occurrence and operation IDs.
Test rotation, installation changes, capture-level changes, dropped entries, and unavailable correlation storage.
Missing or never-captured history must remain distinct from no matching activity.
Verify that `fm-linear logs`, `status`, and incident inspection do not notify Firstmate, dispatch workers, retry actions, or change pending work.
Use recording boundaries together with the [fault-injection and isolation controls](IMPLEMENTATION_NOTES.md#test-harness-construction).
For commands supporting `--json`, verify the documented stdout schema with diagnostics enabled on stderr.
Check that progress output does not corrupt the structured result and that fallback diagnostics respect the documented stream format.
Verify that an incident export contains the safe evidence and references required by the [agent reporting procedure](../docs/src/content/docs/for-agents/reporting-bugs.md).
Unresolved references must be labeled as missing evidence, not silently replaced with guesses or private payloads.
Test simultaneous SQLite and log-sink failure without claiming that unavailable diagnostics were saved or displayed.

Exercise privacy cases with the [canary fixtures](IMPLEMENTATION_NOTES.md#privacy-canary-fixtures), alongside focused allowlist, redaction, and escaping tests.
Record unavailable capture surfaces rather than claiming they were clean.

## Controlled live checks

Live checks verify selected assumptions that local fixtures cannot establish.
Keep an assumption list beside each check, including its source, observed behavior, and limits.
Run live checks under [the live-check fixture rules](IMPLEMENTATION_NOTES.md#live-check-fixtures), separately from ordinary CI and the safe local `fm-linear test` command.

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
