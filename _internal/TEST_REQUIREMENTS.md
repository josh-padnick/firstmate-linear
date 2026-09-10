# FM Linear test requirements

Use this reference to identify failures to protect against when implementing or changing a capability.
The requirements do not claim that every capability or test already exists.

## How to use this document

Use [TESTING.md](TESTING.md) to choose the lowest test level that can prove the behavior.
Read only the requirements relevant to your change; one test can satisfy several requirements.
Add coverage with the implementation that makes a requirement applicable.

[ARCHITECTURE.md](ARCHITECTURE.md), [ERRORS.md](ERRORS.md), and [LOGGING.md](LOGGING.md) define the behavior these tests protect.
Resolve disagreements in the owning document before changing assertions.
The tables summarize required evidence rather than define a second set of contracts.

Detailed first-release scenarios live in [verification notes](tmp/TEST_VERIFICATION.md).
Fixture construction belongs in [the harness notes](tmp/IMPLEMENTATION_NOTES.md#test-harness-construction).
The test links below illustrate individual requirements; they do not establish coverage of an entire section.

## Structured contracts

See the [error contract](ERRORS.md#use-a-shared-error-contract), [operation results](ERRORS.md#ordinary-results-and-incomplete-evidence), and [log event definitions](LOGGING.md#scopes-and-event-names).

| Risk | Required evidence |
| --- | --- |
| Invalid serialized output | Errors, results, and log events retain their documented fields and meanings, including partial and unknown outcomes. |
| Broken reader compatibility | Readers accept supported prior records and permitted additive fields without depending on irrelevant key order. |

## Linear intake

See [Linear intake](ARCHITECTURE.md#1-linear-intake).

| Risk | Required evidence |
| --- | --- |
| Duplicate input | Repeated polls and overlapping pages produce one logical action. |
| Lost input | A crash between capture and cursor advancement loses no accepted record. |
| History gap | Detectable gaps remain visible even after current-state reconciliation succeeds. Missing evidence never proves complete history. |
| Interrupted retrieval | Partial responses, interrupted pagination, rate limits, cancellation, and malformed input preserve accepted records and accurate retrieval progress. |

## Firstmate integration

See [Firstmate integration](ARCHITECTURE.md#2-firstmate-integration).

| Risk | Required evidence |
| --- | --- |
| Broken compatibility | Failed or unverified required checks hold affected operations and preserve work. Unused optional capabilities do not cause urgent alerts. |
| Installation changes | Only checks for the matching installation fingerprint authorize operations. Changes during a check invalidate its result; rechecking holds affected operations without restarting the service. |
| Unsafe probes | Compatibility probes do not write to live Linear or launch live agents. Successful or unchanged checks do not notify Firstmate. |
| Missing brief instructions | Prepared text reaches the launch brief without damaging authored content. Skipped preparation and fallback delivery have separate coverage. |
| Overstated guarantees | Reports distinguish observed task state, message delivery, and completed work. A successful brief update does not prove every agent will request preparation. |

Example: [installation contract tests](../tests/contracts.test.ts) exercise isolated checks and invalidate prior results after a script changes.

## Work context and workflow rules

See [work context](ARCHITECTURE.md#3-work-and-conversation-context) and [workflow rules](ARCHITECTURE.md#4-workflow-requirements-and-rules).

| Risk | Required evidence |
| --- | --- |
| Wrong recipient | Identical task names, different homes, old attempts, and separate threads cannot cross-route messages. Replies return to their originating thread. |
| False completion | Worker exit, acknowledgment, artifact availability, approval, and delivery remain distinct facts. |
| Invalid approval | An unauthorized actor or approval for an earlier artifact revision cannot authorize the current action. |
| Missing evidence | Unknown outcomes and unreadable dependency sources never become success or an empty dependency set. |
| Expected states | Ordinary waits and stale observations do not automatically become incidents. Persistent conditions escalate according to their impact and policy. |
| Agent noise | Repeated observations produce one outstanding report request, bounded follow-ups, and accurate notification counts. |

Example: [message tests](../tests/messages.test.ts) check response correlation and stale attempts at the adapter boundary.

## Linear publication and reconciliation

See [publication and reconciliation](ARCHITECTURE.md#5-linear-publication-and-reconciliation).

| Risk | Required evidence |
| --- | --- |
| Uncertain writes | Each mutation verifies uncertain effects before retrying, accounting for duplicates and intervening edits. Unverifiable outcomes stay held. |
| Incorrect synchronization | Status, assignee, labels, PR links, and dependencies reconcile independently while preserving unmanaged data and respecting manual edits. |

## Durable delivery and recovery

See [durable delivery](ARCHITECTURE.md#6-durable-delivery-and-recovery).

| Risk | Required evidence |
| --- | --- |
| Restart recovery | Crashes around persistence and external actions lose no accepted obligation. Safe work resumes without duplicate effects; uncertain outcomes remain held and visible. |
| Obsolete action | Changes to workflow, attempt, or artifact revision cause pending actions to be re-evaluated before retrying. |
| Exhausted retries | Work remains preserved, held, and visible with its incident until policy or an authorized decision permits resumption. |
| Failed upgrade | Supported database upgrades and interrupted migrations preserve pending work and unresolved incidents in a recoverable database. |
| Concurrent delivery | Transactions and ownership controls prevent two service processes from delivering the same pending action concurrently. |

Example: [fleet persistence tests](../tests/fleet.test.ts) exercise a SQLite upgrade and retained home identity through restarts and outages.

## Setup, configuration, and lifecycle

See [setup and lifecycle](ARCHITECTURE.md#7-setup-configuration-and-service-lifecycle).

| Risk | Required evidence |
| --- | --- |
| Invalid configuration | Errors name the field and constraint; the last valid configuration remains active. |
| Broken executable wiring | The executable loads configuration, starts, exposes commands, and shuts down with the documented results and effects. |

## Diagnostics, incidents, and privacy

See [ERRORS.md](ERRORS.md) and [LOGGING.md](LOGGING.md).

| Risk | Required evidence |
| --- | --- |
| Duplicate incidents | Repeated and concurrent failures produce one incident and operational issue, with bounded notifications across restarts. Recovery requires evidence. |
| Alert loop | Operational incident issues never become work, even after removal of their managed labels. |
| Diagnostics failure | Sink and serialization failures stay contained. Unsaved work is never acknowledged; unavailable storage or history is reported honestly. |
| Misleading history | Retained events remain traceable; dropped or missing history stays distinct from no matching activity. |
| Read commands causing actions | Diagnostic inspection does not notify Firstmate, dispatch workers, retry actions, or change pending work. |
| Corrupted CLI output | Progress and diagnostics do not corrupt documented machine-readable results, including fallback output. |
| Private information leakage | Prohibited credentials and private payloads stay out of logs, incidents, operational issues, and report exports. |
| Injection through output | Unsafe fields and control characters cannot forge diagnostic entries. Sanitized external metadata remains untrusted evidence. |
| Incomplete reports | Exports include the required safe evidence and identify missing references without inventing facts or exposing private payloads. |

Privacy tests establish the behavior of the surfaces and samples exercised, not universal protection against malicious agent instructions.

## Controlled live checks

To decide whether live checks are necessary, use [the testing ladder](TESTING.md#the-testing-ladder).

| Risk | Required evidence |
| --- | --- |
| Incorrect external assumptions | Checks exercise actual supported operations and record their source, observed behavior, and limits. One operation's recovery behavior does not establish another's. |
| Accidental live effects | Live checks are opt-in, use explicitly supplied disposable resources, and remain separate from ordinary CI and safe local compatibility checks. |
| Overstated coverage | Unexercised behavior remains unverified. A successful query proves neither future history retention nor recovery of deleted records. |

Unexpected live results require investigation before changing either the implementation or expected behavior.
