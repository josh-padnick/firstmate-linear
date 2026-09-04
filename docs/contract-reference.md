# Workflow contract reference

The runtime reads exactly `$FM_HOME/config/linear-workflow.yaml` unless a test-only environment override is supplied.

`version` must be `1`.
`captain.display_name` must exactly match the captain's Linear display name.

Each `teams` entry requires a unique key.
`managed` is `assignee:self` by default and can be set to `all` explicitly.
An empty `projects` list includes every project in the team, while a nonempty list matches project names or slugs case-insensitively.

Each team maps its Linear status names under `roles`.
The fixed role keys are `plan`, `plan-gate`, `waiting`, `building`, `review-gate`, `validating`, `merge-gate`, `decision-captain`, `decision-firstmate`, `done`, and `canceled`.
The `building`, `done`, and `canceled` roles are required.
Every other role is optional, and runtime transitions follow documented fallback chains when an optional role is unmapped.
Gate behavior exists only for mapped `plan-gate`, `review-gate`, and `merge-gate` roles.

`agent_labels` maps resolved model IDs to existing labels in the workspace-level `Agent` group.
The runtime never creates values automatically.
Include an `unknown` value to make unmapped models visible without inventing labels.

`features.relay`, `features.mirror`, and `features.escalation` each accept `off`, `shadow`, or `on`.

Template paths can be absolute or relative to the YAML file.
`reply` supports `{{body}}`, `{{next}}`, and `{{verdict}}`.
`report` supports `{{summary}}`, `{{events}}`, and `{{drift}}`.
The review template must include `{{issue}}` and `{{title}}` and sections with IDs `outcome`, `changes`, `verification`, and `review`.
A completed walkthrough must retain those sections and contain no unresolved template or placeholder text.

`deadlines.progress` maps Firstmate-owned role keys to service-side inactivity durations.
The default deadlines are 30 minutes for `plan`, 45 minutes for `building`, 60 minutes for `validating`, 4 hours for `waiting`, and 15 minutes for `decision-firstmate`.
Because deadlines target roles, a team can rename its Linear statuses without changing progress behavior.
`deadlines.stalled.mention` controls the one-time in-thread captain mention for an unhandled stalled event and defaults to 30 minutes.

`promises.required_on_firstmate_owned` defaults to `true`.
When enabled, `act reply`, `act comment`, and `act handoff-to-captain` require `--next EVENT --by DURATION` on Firstmate-owned issues, while `--next none` records no promise.
The default closed vocabulary is `status:*`, `board:*`, `pr-reported`, `pr-green`, `pr-merged`, `comment`, `dispatch`, and `none`.

Run `fm-linear contract lint` after every config change.
Run `fm-linear contract apply-states --team KEY --role ROLE [--name STATUS]` to idempotently ensure one explicitly approved workflow status.
Run `fm-linear contract apply-labels` to idempotently ensure the workspace `Agent` group only.
