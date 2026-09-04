# Progress contract

Captain-facing replies on Firstmate-owned issues must declare `--next` and `--by`.
Use `--next none` when no observable follow-up is expected.
Promises are durable, a newer promise supersedes an older one, and an overdue promise emits one structured `stalled` event.

The progress heartbeat considers primary-task status, Firstmate comments, board transitions, PR observations, relays, and dispatches.
It checks only Firstmate-owned roles and exempts a genuinely busy worker unless its host is degraded.

Idle detection watches upstream's busy-state, turn-ended, status, and inbox contracts.
It first sends one mechanical nudge.
If the worker remains silent, `proxyStatusLine` appends exactly one `blocked [key=idle] [service]` line and emits a stall.
That function is fm-linear's only direct write into upstream state.

Every steer is tracked until recipient-side evidence acknowledges it.
An unacknowledged steer is redelivered once and eventually stalls with a direct-submit action.
Remote homes can install `state/fm-linear-inbox-ring.check.sh` through `fm-linear install --remote-ring HOME`.
That registered check is fm-linear's only remote-home file.

Host sampling records one-minute load, core count, free memory, and the five largest process families.
A sustained threshold breach creates one host stall, holds steers, suspends the busy exemption, and suppresses idle nudges for that host.
The service never kills or signals processes.

After repeated Linear poll failures, a successful control probe causes the daemon to record a restart reason and exit nonzero so LaunchAgent restarts it.
If the control probe also fails, the service treats the condition as a network outage, keeps running, and backs off.
The next process records `service-restarted` evidence for the report.

`inbox show` includes a transcript tail when a session can be located by harness, worktree, and task time window.
It does not classify transcript prose or infer blockers from signatures.

Service-authored progress updates live in one per-issue activity thread.
Replies to captain comments stay under the captain's thread root.
