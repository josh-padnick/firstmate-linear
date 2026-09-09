# Testing FM Linear

**Status: Proposed.**
This guide describes the intended testing approach.
Runtime test commands and fixtures still need implementation; the existing docs commands are listed below.

## Purpose

Use this guide to decide which tests a change needs and where those tests belong.
Use [TEST_REQUIREMENTS.md](TEST_REQUIREMENTS.md) to find the verification requirements for the capability you are changing.
Consult only the relevant sections after choosing a test level.
Harness construction belongs in [the implementation notes](IMPLEMENTATION_NOTES.md#test-harness-construction).

Read [ARCHITECTURE.md](ARCHITECTURE.md) for subsystem ownership, [ERRORS.md](ERRORS.md) for failure semantics, and [LOGGING.md](LOGGING.md) for diagnostic contracts.
When a test and a source document disagree, establish the intended behavior before changing either.
Do not weaken a contract merely to make a test pass.

## Philosophy: agility requires safety

FM Linear's testing approach follows the argument in Yevgeniy Brikman's "Agility Requires Safety": **you can't go faster by being reckless - speed is limited by safety.**
A car can only drive fast because it has brakes.
For software, automated tests are the brakes: a self-testing build that runs on every commit stops buggy code before it reaches users, which is exactly what gives us the confidence to change code quickly.
Without it, "your software is broken until somebody proves it works"; with it, the software is proven to work with every change and you know the moment it breaks.

Three principles fall out of that framing:

1. **The build is self-testing.**
   As runtime implementation lands, every commit should receive the required checks (lint, typecheck, unit and integration tests, and build) in CI.
   A red build is fixed ASAP or the commit is reverted - never left red.
   Small, frequent commits keep each failure easy to bisect and revert.
2. **What to test is a trade-off**, weighing three factors:

   - **Likelihood of bugs** - higher for complex logic (parsing, tree building, draft/version/archive/Trash lifecycle, sync) than for declarative glue.
   - **Cost of bugs** - higher where users lose data (drafts, versions, Trash restore/purge, migrations) or where web and desktop transports can silently diverge.
   - **Cost of tests** - unit tests are cheap to write and run; integration tests cost more; browser/UI tests cost the most to write, run, and maintain.
     Spend accordingly: many unit tests, some integration tests, few end-to-end tests.

3. **Tests are code, and code is the enemy.**
   Every test has a maintenance cost.
   A test earns its place only if it would fail on a plausible real regression.
   Do not write tests that restate the implementation, re-test the framework, or chase a coverage number - delete tests like that when you find them.

## The testing ladder

**Start at the lowest rung that can prove the behavior.**
Move higher only when the behavior depends on something the lower rung cannot exercise.
A type check cannot prove a transaction commits, and a mocked store cannot prove recovery after a process crash.

| Rung | What it proves | Approach |
| --- | --- | --- |
| 1. Static and schema checks | Type consistency, accepted configuration shapes, and compatibility of documented serialized contracts. | Strict typechecking, lint, schema validation, and versioned reader fixtures. |
| 2. Unit tests | Workflow decisions, approval scope, identity rules, configuration resolution, and notification policy. | Colocated `bun:test` tests with explicit inputs and outcomes, without real external I/O. |
| 3. Component integration tests | A storage component or external adapter satisfies its observable contract. | Real SQLite with production migrations; controlled HTTP responses; actual Firstmate scripts in isolated homes with fake harnesses. |
| 4. Process smoke tests | The executable starts, loads configuration, and exposes basic service and diagnostic commands. | Launch the real executable with temporary configuration and state; check startup, command results, and shutdown. |
| 5. Service journeys | Routing, persistence, delivery, and restart recovery work together across components. | Real service processes and SQLite, a local Linear test server, and isolated Firstmate fixtures. |
| 6. Controlled live checks | Selected assumptions hold against the actual external system. | Explicitly enabled checks in disposable Linear and Firstmate resources, separate from ordinary CI. |

The ladder guides test selection; it is not a requirement to repeat every assertion at all six rungs.
A higher-level journey may verify composition while lower-level tests cover detailed cases.
Explain the additional failure a higher-level test catches in the [validation handoff](#explain-the-test-choice).
Do not move an assertion downward if doing so removes the dependency that actually causes the bug.

FM Linear depends heavily on persistence and external interfaces, so substantial integration coverage is appropriate.
Do not prescribe a fixed ratio of unit tests to integration tests.
As working tests are added, link one representative example per rung here so contributors can follow an established pattern.

Browser testing is a separate concern for the docs site.
Use a small set of browser journeys for essential navigation and interactions, with focused visual inspection for layout changes.
A browser test does not prove the background service's synchronization behavior.

## What to test where

### When adding or changing a feature

Identify the behavior promised by the change and the plausible failures that would violate it.
Check whether existing tests already protect those behaviors.
Extend the smallest suitable test before adding a new journey or fixture framework.

| Change | Test to choose |
| --- | --- |
| Approval, workflow, mapping, or notification rule | A unit test with relevant allowed, rejected, and uncertain cases. Extract the decision from I/O code if needed. |
| Configuration schema or serialized output | Schema and reader-compatibility tests for documented fields and meanings, including supported prior versions. |
| SQL, constraints, cursor persistence, or migrations | A component integration test against real SQLite. Include upgrades when existing records or obligations are affected. |
| Linear parsing, pagination, or retry classification | An adapter test at the HTTP boundary. Use a live check only for an assumption that local responses cannot establish. |
| Firstmate command, file, or extension behavior | An adapter contract test using the actual relevant upstream code in an isolated fixture. A fake script tests only our handling of its response. |
| Executable startup, configuration loading, or command wiring | A process smoke test. Do not duplicate every workflow case through the CLI. |
| Cross-component routing or crash recovery | A service journey that exercises the real composition, including the process or persistence boundary relevant to the failure. |
| A docs navigation or interaction bug | A browser regression when a lower layer cannot reproduce the problem. |
| Simple documentation wording or visual styling | Content and link checks, plus focused visual inspection where relevant. Do not add tests that merely repeat the edited markup. |

Use the [validation handoff](#explain-the-test-choice) to record which regression the test catches and why its rung is necessary.
A test without a distinct answer needs a better assertion, a different layer, or no new test.

### When fixing a bug

1. Reproduce the problem through the user's actual entry point as closely as possible.
2. Add the smallest meaningful regression test at the lowest rung that reproduces the failure.
3. Observe the regression test fail for the expected reason, then fix the implementation.
4. Run the relevant checks and verify the fix through the user's entry point again.

Reproducing a bug end to end does not require keeping every regression assertion in an end-to-end test.
Simple reversible copy or styling fixes can use focused visual verification instead of an automated test that restates the markup.

When an incident export is available, use its timeline and evidence references to help build the reproduction.
If privacy limits or missing observations leave gaps, record them and obtain the minimum additional evidence needed.
Name the test for the behavior and include an incident or GitHub issue reference when available.
An opaque fingerprint should not be the only description of what the test proves.

### When refactoring

Behavior-preserving refactors should usually leave behavioral assertions unchanged.
If many tests break because private calls or module structure changed, examine whether they were coupled to implementation details.
Improve those tests without removing the behavior they protect.
Do not rewrite expected results merely to match the refactored code.

## Explain the test choice

For behavior whose tests you add or materially change, include the following in the PR description's **Validation** section.
When there is no PR, include it in the implementation handoff or final summary.
Group the rationale by behavior rather than listing every test separately.

```text
Behavior protected: Accepted comments survive a process crash.
Test level: Service journey, because the failure depends on process termination and persisted cursor state.
Validation: [Test file or command, result, and any coverage limits.]
```

Describe the plausible regression and why a lower rung cannot provide the needed evidence.
For unit or static checks, name the rule or contract being checked; no elaborate defense of the lowest rung is needed.
When existing tests already cover a change, identify that coverage instead of inventing a new test to fill out the template.
For copy or styling changes, report the content or visual verification performed.

Use descriptive test names.
Add an in-test comment only when the failure mechanism, fixture, or choice of level is not obvious from the test.
A mandatory `// Catches:` comment on every test is not required.

## Writing assertions

Use descriptive behavior names and table-driven cases where the variants matter.
Assert results and externally visible effects, not private calls or broad snapshots.
Assert documented machine-readable fields and semantics, including which unknown or optional fields readers must accept.
Test backward compatibility with supported persisted and serialized versions.
Do not make harmless additive fields, object-key order, or incidental prose into contracts unless the interface explicitly requires them.
Inject a clock for polling, backoff, settling windows, pending age, and retention tests.
Wait for observable conditions with bounded deadlines in process and browser tests; avoid arbitrary sleeps.

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
Verify the [error and result contracts](ERRORS.md#use-a-shared-error-contract) and [logging contracts](LOGGING.md#scopes-and-event-names) through their supported-version fixtures.
See [structured-contract requirements](TEST_REQUIREMENTS.md#structured-contracts) for the required evidence.
Run platform-sensitive contracts and executable smoke tests on macOS and Linux.
Required suites must fail clearly when their fixtures cannot run; optional live checks must report their absence explicitly.
Keep the normal suite deterministic and fast by placing assertions at the right layer, not by removing recovery coverage.
Document runnable commands when they exist rather than presenting planned scripts as available tools.
