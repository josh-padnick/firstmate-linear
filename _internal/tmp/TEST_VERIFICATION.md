# First-release test verification notes

Use these scenarios when implementing and reviewing FM Linear's first release.
They include proposed coverage for capabilities that do not exist yet; they are not a record of completed verification.

[TESTING.md](../TESTING.md) explains how to choose tests.
[TEST_REQUIREMENTS.md](../TEST_REQUIREMENTS.md) defines the lasting risks and required evidence.
The [test harness notes](IMPLEMENTATION_NOTES.md#test-harness-construction) describe fixture construction and isolation.
Use only the scenarios relevant to the capability being implemented.

As tests land, replace proposed scenarios with links to tests or documentation beside the harness.
Before retiring this directory, preserve any still-needed procedures there and move unfinished work into tracked issues.
Do not delete a lasting requirement when retiring these notes.

## Structured contracts

Verify the required fields and meanings of the [shared error contract](../ERRORS.md#use-a-shared-error-contract), including unknown and partial outcomes.
Exercise the operation-specific results defined in [ordinary results and incomplete evidence](../ERRORS.md#ordinary-results-and-incomplete-evidence).
Validate catalog-backed log events against their [event definitions](../LOGGING.md#scopes-and-event-names), and test emergency diagnostic formats separately.

Use supported prior serialized fixtures to verify current readers and declared migration or version boundaries.
Cover required, optional, and unknown fields according to each interface's compatibility policy.
Do not turn a permitted additive field or irrelevant key order into a breaking change.
A version note alone does not prove compatibility.

## Linear intake

Exercise partial GraphQL failures, interrupted pagination, rate limits, cancellation, malformed responses, and delayed observations at the HTTP boundary.

## Firstmate integration

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

## Durable delivery and recovery

Test both fresh databases and upgrades from supported prior schemas when existing records or obligations are affected.
Verify transaction rollback, locking, and migration behavior against actual SQLite connections.
An interrupted or failed upgrade must leave a recoverable database without discarding pending delivery or unresolved incidents.
Verify that a second service process cannot deliver the same pending action concurrently.
A mocked storage error proves caller handling, not SQLite durability or recovery behavior.

## Setup, configuration, and lifecycle

Exercise startup, configuration loading, diagnostic commands, and orderly shutdown with the actual executable.
Check command results and externally visible effects rather than private function calls.

## Diagnostics, incidents, and privacy

Prove incident grouping and notification suppression with injected repeated and concurrent failures, then restart during grouping and notification and assert one incident and one operational issue.
Prove condition entry, aggregation at the configured interval, and recovery only on evidence.
Prove that retained entries preceding incident grouping remain reachable through occurrence and operation IDs.
Test rotation, installation changes, capture-level changes, dropped entries, and unavailable correlation storage.
Missing or never-captured history must remain distinct from no matching activity.
Verify that `fm-linear logs`, `status`, and incident inspection do not notify Firstmate, dispatch workers, retry actions, or change pending work.
Use recording boundaries together with the [fault-injection and isolation controls](IMPLEMENTATION_NOTES.md#test-harness-construction).
For commands supporting `--json`, verify the documented stdout schema with diagnostics enabled on stderr.
Check that progress output does not corrupt the structured result and that fallback diagnostics respect the documented stream format.
Verify that an incident export contains the safe evidence and references required by the [agent reporting procedure](../../docs/src/content/docs/for-agents/reporting-bugs.md).
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
