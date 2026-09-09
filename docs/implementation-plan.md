# Implementation plan

This repository implements the v6 design in four public delivery slices plus the protocol spike.

## Phase 0: protocol proof

Pin the extension to `host_protocols: [1]` and `process-event-adapter/1`.
Verify retry-stable source polling, classification, silent handling, restart survival, re-announcement, and CLI-only acknowledgement against the current Firstmate host.

## Phase 1: installable read path

Provide the SQLite schema, migration backup boundary, polling service, local socket, extension package, receipt-gated inbox, report cursor, config fallback, doctor, installer, LaunchAgent, cutover lease, fixture recorder, and standalone build.

## Phase 2: inbound writes and relay

Apply exact approvals and gate feedback mechanically.
Render checked replies through templates.
Relay captain answers only when one live primary task and an unambiguous decision key prove the destination.
Retry all side effects through the outbox and escalate overdue events at capped deterministic rungs.

## Phase 3: mirror and review

Tail fleet records, fold keyed task signals, inspect SHA-bound pull-request checks, mirror conditional state and model labels, preserve captain drags, report missing links, validate review walkthroughs, and enforce configured progress and promise deadlines.

## Phase 4: public and multi-team

Make teams and projects config-only, provide a generic example, test multiple teams, ship CI and native release binaries, document clean installation and rollback, and keep personal identity and machine paths out of runtime defaults.

The implementation remains inert until `cutover enable` is run.
Feature modes default to `shadow` so relay, mirror, and escalation can be observed before activation.
