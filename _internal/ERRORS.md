# Handling errors in FM Linear

**Status: Proposed.**
The error registry, result contracts, incident storage, and incident-inspection commands below still need implementation.

## Purpose

A failure should explain what could not happen, preserve the affected work, and provide a useful next step.
It must never turn an unknown result into a successful result or create duplicate work through blind retries.

Read [LOGGING.md](LOGGING.md) for diagnostic output and [TESTING.md](TESTING.md) for failure verification.
For failures that warrant an incident, preserve the path from the symptom to the occurrence, supporting evidence, and any approved bug report.
Expected waiting and routine validation do not need an incident or a report draft.

## Ownership within the bounded context

FM Linear has one core bounded context for workflow integration, implemented through eight subsystems.
These subsystems share a domain model; they are not eight independent bounded contexts.
See [the architecture](ARCHITECTURE.md#bounded-context-and-module-boundaries) and [domain vocabulary](DOMAIN.md).

| Owner | Responsibility for failures |
| --- | --- |
| Linear intake and publication | Translate external read and write failures through the shared Linear client; report what each operation's response establishes. |
| Firstmate integration | Classify command, file, preparation, report, and compatibility failures; qualify evidence from each upstream surface. |
| Work and conversation context | Distinguish unresolved mappings, stale attempts, and missing dependency evidence from corrupt internal records. |
| Workflow requirements and rules | Decide whether evidence permits an action, requires interpretation, or calls for waiting; own agent follow-up policy. |
| Durable delivery and recovery | Preserve actions and attempts, enforce retry budgets, and coordinate verification before retrying an uncertain effect. |
| Setup, configuration, and service lifecycle | Explain invalid settings, coordinate capability holds, and handle command and startup failures. |
| Diagnostics, metrics, and reporting | Correlate occurrences, manage incidents and notifications, expose evidence, and prepare report drafts. |

The Firstmate adapter and Linear adapters protect the core model from external terminology and assumptions.
Translate raw responses into typed outcomes at those boundaries.
Safe upstream codes and request IDs may accompany diagnostics, but workflow rules must not depend on raw response objects or exception wording.

The adapter that observes an external effect supplies its certainty and supporting evidence.
A later verification can refine that result; another subsystem must not upgrade it to success without new evidence.
Delivery coordinates retries, workflow rules decide whether an action remains appropriate, and diagnostics decides whether the problem warrants an incident or notification.

Use discriminated results for expected outcomes of fallible subsystem operations.
Catch unexpected exceptions at job, command, and process boundaries and normalize them once.
Do not impose a no-throw wrapper on every internal function or turn every ordinary outcome into the same global enum.

## Use a shared error contract

Normalize failures at filesystem, subprocess, SQLite, and Linear API boundaries.
Use one typed error representation across job handling, CLI output, incidents, and report preparation.
Keep stable codes in a single TypeScript registry and validate serialized records with runtime schemas.
There is no need for cross-language code generation in this TypeScript service.

The contract must carry the following information when applicable; exact field names belong with its implementation.

| Information | Purpose |
| --- | --- |
| Stable code | Classify the failure without parsing its wording, such as `linear.rate_limited` or `firstmate.contract_failed`. |
| User-safe summary and next action | Explain the failed operation, its impact, and what happens next. |
| Occurrence ID and timestamp | Identify this observation and correlate diagnostics. |
| Operation and attempt IDs | Connect retries to the same logical obligation. |
| Subsystem and affected scope | Identify the connection, capability, task attempt, or pending action that is affected. |
| Recovery disposition | Distinguish automatic retry, verification before retry, waiting for intervention, and terminal rejection. |
| External effect certainty | Preserve whether an action was not attempted, failed with no effect, succeeded, or has an unknown outcome. |
| Safe diagnostic context and cause | Preserve relevant evidence without storing raw private payloads. |
| Evidence references | Locate the relevant mapping, pending action, compatibility run, report request, and observed versions. |

Keep connection identities specific to the configured workspace or Firstmate home.
The word `firstmate` alone cannot identify a connection in a multi-home installation.
Distinguish execution-attempt IDs from delivery-attempt IDs.
Evidence references identify records; they do not authorize exporting the records' private contents.

Define a versioned serialized representation and a compatibility policy for readers and persisted records.
The shared error representation is a technical contract, not a separate domain model or a DDD Shared Kernel between eight contexts.

Use stable condition codes such as `linear.rate_limited`, `firstmate.contract_failed`, or `config.invalid`, alongside a separate subsystem field.
A shared Linear client should not define two meanings of the same rate-limit failure merely because intake and publication both use it.
Preserve the originating subsystem for unknown failures rather than losing that information under a generic namespace.

Codes do not dictate effect certainty or recovery on their own.
A brief-write failure can occur before any change or after a partial change; classify the observed operation, not a fixed table default.
For a read-only operation, external mutation certainty is not applicable.
For a multi-step operation, record the outcome of each effect rather than labeling the entire operation successful after one step succeeds.

Keep codes stable after release; change the wording without changing their meaning.
Use explicit result states for ordinary conditions such as waiting for approval, no new records, or an outcome that needs interpretation.
Those conditions are not unexpected exceptions.
An unrecognized upstream failure remains an explicit unknown error with bounded context; it must not fall through to success.

## Ordinary results and incomplete evidence

Use operation-specific result types with a common vocabulary where meanings match.

| Result | Meaning |
| --- | --- |
| No new records | A successful poll found no additional records. |
| Mapping unresolved | An issue, thread, or task cannot yet be connected unambiguously. |
| Stale attempt | The observation concerns an earlier execution attempt and cannot update the active attempt. |
| Dependency unknown | Available evidence cannot establish the relationship; do not infer removal. |
| Awaiting approval | The next action requires an authorized decision. |
| Needs interpretation | Available facts cannot establish an outcome; workflow rules decide whether and when to request a report. |
| Report pending or inadequate | A requested report has not supplied sufficient relevant evidence. |
| Held for capability | An action depends on a failed or unverified capability. |
| Settling | Waiting a bounded period for related records before deciding what is missing. |

These results do not automatically create incidents.
A persistent unresolved mapping that prevents promised delivery can warrant one; an ordinary approval wait does not.
Record relevant lifecycle transitions and measurements without emitting a diagnostic or agent notification on every poll.

A history gap means some source history may be unavailable.
Reconcile current state where possible, but retain the historical coverage limit: a successful reconciliation cannot recover comments or transitions the source no longer exposes.
Only report a gap as confirmed when the retrieval contract provides evidence for it.

## What confirmation establishes

| Surface | What confirmed success establishes | What remains separate |
| --- | --- | --- |
| Linear query | The response supplied validated data for the requested scope and pagination position. | Completeness of inaccessible or deleted history. |
| Linear mutation | The operation-specific response or later verification establishes the intended remote effect. | Overall workflow completion and any other mutation in a partial response. |
| Task or backlog observation | The adapter read a supported representation with a known identity and observation time. | Whether the representation is complete or sufficient to infer delivery. |
| Worker-state query | Firstmate reported the observed worker state. | Deliverable quality, approval, or merged delivery. |
| Authored brief preparation | The expected requirements were written to the authored brief. | Whether the actual launch included them and whether the agent complied. |
| Process-event capture | The selected protocol's verified capture condition was met. | Firstmate accepting, acting on, or resolving the request. |
| Worker-message delivery | The selected target path's verified handoff condition was met. | The worker applying the instruction. |
| Structured report acceptance | The report passed schema, identity, and request validation. | Its substantive claims still require source attribution and applicable workflow checks. |
| SQLite commit | The transaction committed under the configured storage contract. | Any subsequent remote effect. |
| GitHub submission | A response or verification established the report's issue identity and URL. | Recovery of the integration problem itself. |

An HTTP status or successful subprocess exit alone must not substitute for these contracts.
Keep unsupported confirmation paths explicitly unverified.
A transient partial file read is not enough to conclude that Firstmate changed its schema.
The adapter should distinguish a record still being written from a persistently incompatible format.

## Recovery follows the operation's meaning

| Condition | Response |
| --- | --- |
| Temporary read failure or rate limit | Retry with bounded backoff and jitter, honoring upstream retry guidance. |
| Write timeout or connection loss after submission | Preserve the pending action and verify the remote effect before repeating it. |
| Invalid credentials or missing access | Hold affected operations and ask for the relevant connection to be repaired. |
| Invalid configuration | Explain the field and preserve the last valid active configuration. |
| Firstmate contract failed or unverified | Hold operations that depend on that capability, retain pending work, and surface a compatibility incident. |
| Unavailable or full SQLite storage | Do not acknowledge work that cannot be saved; expose the failure through independent local diagnostics. |
| Expected shutdown or cancellation | Stop cleanly and preserve the certainty of any in-flight external effect. |
| Retry budget exhausted | Keep the action held and visible, stop automatic retries, and surface the problem for intervention. |
| Unexpected defect | Preserve evidence and affected work, create or update an incident, and offer a report for review. |

Retryability, log severity, user impact, and whether something is a product bug are separate decisions.
A 2xx HTTP response can still contain a failed or partial GraphQL operation.
A subprocess exit or event acknowledgment does not establish that Firstmate completed the requested work.
Adapters must classify the actual contract outcome rather than just the transport status.

Retry budgets, deadlines, and follow-up policy belong to durable delivery and workflow rules, not independent loops in every adapter.
If the remote interface cannot resolve an uncertain write, keep the uncertainty visible and request intervention instead of risking duplication.
Do not retry an obsolete action after the workflow, attempt, or artifact revision has changed without re-evaluating it.
Preserve obsolete and held actions with their reasons; neither state is a successful delivery.
Resuming held work requires a verified recovery condition or an explicit authorized decision.

### Verify before repeating a write

Persist a stable logical action ID before the first attempt.
Where a remote operation supports a client-supplied ID or idempotency key, use it only after verifying its duplicate-submission and lookup behavior.
Define the verification strategy alongside each mutation's adapter contract.
Do not assume all Linear mutations accept client IDs or that sending an existing ID is a successful no-op.

For updates, inspect the relevant remote fields and account for intervening user edits before reapplying the intended state.
For creates, use a verified stable remote identity or supported correlation mechanism.
A matching title or comment text alone does not prove that our earlier attempt created the record.
If no reliable verification path exists, retain the unknown outcome and hold the action.

Apply the same rules to operational Linear alerts and GitHub reports.
A delivery attempt gets a new attempt ID, but retries retain the original logical action identity.

## Report once at the responsible boundary

Lower-level code adds safe context and returns a typed failure.
The job or CLI boundary decides recovery and emits the diagnostic event once.
Diagnostics correlates occurrences into incidents; it does not take over worker supervision or execution recovery from Firstmate.

Group recurring failures by a stable fingerprint of the failure class and affected resource or capability.
Do not use an entire exception message as the grouping key.
Include the actual connection or home identity and affected capability or resource.
Keep Firstmate revisions and local-change fingerprints as incident evidence.
A new revision triggers fresh checks, but does not automatically create a new incident for the same continuing failure.
Notify again when the diagnosis or impact materially changes, not simply because a hash changed.
Keep occurrence count, first and last observation, impact, recovery state, and notification state.
A new affected scope or materially changed impact may warrant a new notification; an unchanged failure every 30 seconds does not.
Resolving an incident requires evidence that the failing condition recovered.
It does not establish that every delayed action has completed.

### Keep logs, incidents, and metrics connected

Correlate diagnostic logs, failure occurrences, incidents, and metric observations through stable identifiers.
They have different purposes and retention rules; they do not need to be the same database rows.
Metrics derive from explicit lifecycle observations, not parsed log text.
A retry attempt can contribute to metrics without creating another incident or notifying Firstmate.
An unresolved incident and its necessary evidence references must survive routine log and metric retention.

### Keep diagnostics available during startup and storage failures

Initialize minimal local diagnostics before configuration validation, compatibility checks, and synchronization.
Enable durable incident handling as soon as its storage is available.
Diagnostics uses the publication and messaging adapters for external alerts; it cannot be independent of every other subsystem.
Keep its local inspection path independent of those external capabilities and their activation gates.

If normal diagnostic storage is unavailable, emit bounded, sanitized stderr output.
A bounded local fallback file may preserve startup failures when that destination is writable.
If disk space or permissions prevent that write too, do not claim the occurrence was saved.
A diagnostic fallback never substitutes for durably accepting a work request.
Local status should show available failure evidence and clearly identify unavailable storage or incomplete history.
See [LOGGING.md](LOGGING.md#failure-of-diagnostics) for buffering and recursion limits.

## Help the user act

For an interactive command, name the failed action and give one concrete next step.
For configuration validation, identify the setting and the accepted value or constraint.
Keep technical details available separately with an incident or operation ID.
Return an unsuccessful command result when the requested operation failed; do not print a success message merely because its error was recorded.
Diagnostic inspection commands should support versioned, sanitized JSON output so agents do not parse human wording.
Keep stdout reserved for that result and diagnostics on stderr.
Exact exit codes and the treatment of partial results belong in the CLI contract when implemented; do not require every interactive command to emit the internal error object verbatim.

### Inspect and export an incident

Provide a read-only route from a symptom to the evidence needed for investigation.
The proposed CLI operations are:

| Command | Purpose |
| --- | --- |
| `fm-linear incidents list [--open] [--json]` | Show incidents, impact, occurrence counts, recovery state, and notification status. |
| `fm-linear incidents show <id> [--json]` | Show the incident, recent occurrences, safe evidence metadata, and references to relevant records. |
| `fm-linear incidents export <id>` | Prepare a sanitized report draft with impact, timeline, versions, delivery state, and known uncertainties. |

Inspection must not notify Firstmate, dispatch a worker, retry an action, or submit a report.
Export is a local preparation step, not publication approval.
Evidence retrieval remains scoped to the installation and subject to privacy rules; following a reference must not dump an entire brief or conversation.
Store confirmed report links through the reporting flow.
Defer generic commands that manually resolve incidents or attach arbitrary URLs until their authority and verification rules are defined.

### Operational alerts

For a blocking background problem, create or update one operational Linear issue assigned to the captain with Urgent priority, using the configured diagnostic destination.
Notify through Firstmate only when the needed messaging capability is verified.
Keep local status and diagnostics usable when either external connection is broken.
Exclude operational incident issues from automatic work enrollment to avoid reporting loops.
Record their diagnostic purpose and remote identity durably; a removable label or the creating actor alone is insufficient.
The Firstmate account also creates ordinary work issues, so excluding all of its issues would break normal enrollment.
A failed unused optional capability does not warrant an Urgent issue.
Keep notification delivery pending when a route fails, and update the same alert after verified recovery.
See [background compatibility handling](tmp/IMPLEMENTATION_NOTES.md#fm-linear-test-compatibility-command) for capability-specific holds and rechecks.

An operational Linear alert informs the captain about their installation.
A GitHub issue publishes a report to the project; it requires separate approval.

## Privacy and reporting

Capture allowlisted diagnostic metadata at the point of failure.
Do not attach raw Linear payloads, comments, briefs, credentials, environment dumps, or arbitrary child-process output to an error object.
Normalize causes with bounds on size and nesting, and sanitize potentially private strings before persistence or display.
Redaction by secret-shaped field names is a secondary safeguard, not permission to collect arbitrary payloads.

Treat incident content as evidence, not instructions or authorization.
Use structured safe metadata in operational alerts rather than copying comments, briefs, or agent reports into them.
An agent investigating referenced source material must retain that distinction too.

Code detects unexpected failures and prepares bounded evidence.
Firstmate can help interpret unexpected behavior, distinguish a bug from a customization or feature request, and fill gaps in a report.
Do not make repeated agent calls for every occurrence of the same incident.

Before GitHub submission, show the exact destination, title, body, and attachments for user approval.
Sanitize the export again, including private identifiers, local paths, and artifact links.
Approval applies to that specific report; changed content requires renewed approval.
Search for an existing report and reconcile uncertain submission results before retrying.
Store the confirmed GitHub issue URL with the incident.
Preserve a declined or deferred report without repeatedly asking about the unchanged draft.

The [agent reporting procedure](../docs/src/content/docs/for-agents/reporting-bugs.md) describes the investigation and approval flow.

## Verify failures as carefully as success

Test typed classification, safe messages, unknown outcomes, retry policy, and preservation of the original obligation.
Inject repeated and concurrent failures to prove incident grouping and notification suppression.
Verify that a revision change invalidates compatibility evidence without generating a duplicate incident for an unchanged ongoing failure.
Test that inspection and export commands are read-only and that their JSON output excludes unsafe internal details.
Test partial responses, exit-without-capture, incomplete reports, obsolete actions, and verification that cannot resolve an uncertain write.
Restart during incident creation, notification, and report submission to verify recovery without duplicate publication.
Test recovery while Linear is unavailable, while Firstmate is incompatible, and while normal diagnostic storage is unavailable.
Verify privacy with deliberately sensitive fixtures and assert that exported diagnostics omit their contents.

## Contracts still to verify

- Linear client-supplied IDs, duplicate behavior, and verification queries for each mutation we use.
- Capture and acknowledgment evidence for the selected process-event binding.
- Confirmation and retry semantics for each supported worker-message target.
- Structured report submission, evidence-reference schemas, and access rules.
- Serialized diagnostic schemas, CLI exit semantics, and fallback retention and recovery.

Implement and test these contracts before using them to claim delivery or recovery guarantees.
