# Workflow roles

fm-linear addresses workflow positions by role, never by a Linear status name.
The contract loader is the only boundary that translates between the fixed role vocabulary and a team's existing status names.

The required roles are `building`, `done`, and `canceled`.
Optional Firstmate-owned roles are `plan`, `waiting`, `validating`, and `decision-firstmate`.
Optional captain-owned roles are `plan-gate`, `review-gate`, `merge-gate`, and `decision-captain`.

Signals follow tested fallback chains.
For example, `needs-decision` targets `decision-captain` and otherwise stays with a comment, while `dispatch-scout` targets `plan` and then `building`.
Every chain ends in a mapped role or an explicit stay action.

A zero-gate workflow dispatches into `building`, leaves a green PR in place with a comment, and moves to `done` only after `pr-merged` is observed.
A one-gate workflow commonly maps `review-gate` to Linear's `In Review`; a pass there authorizes merge and starts the merge promise without moving the issue to `done`.
The full example uses plan, review, and merge gates, plus decision roles.

`fm-linear init` starts from [the minimal example](../examples/minimal.yaml) and never creates statuses.
To create one chosen status, run `fm-linear contract apply-states --team KEY --role ROLE --name STATUS` and confirm the prompt.
Non-interactive creation requires `--yes`.
Use `fm-linear contract lint` after editing mappings.

See [minimal.yaml](../examples/minimal.yaml) and [full.yaml](../examples/full.yaml).
