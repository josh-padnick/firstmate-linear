# Workflow contract reference

The runtime reads exactly `$FM_HOME/config/linear-workflow.yaml` unless a test-only environment override is supplied.

`version` must be `1`.
`captain.display_name` must exactly match the captain's Linear display name.

Each `teams` entry requires a unique key.
`managed` is `assignee:self` by default and can be set to `all` explicitly.
An empty `projects` list includes every project in the team, while a nonempty list matches project names or slugs case-insensitively.

The status keys are `backlog`, `todo`, `prioritized`, `waiting`, `plan_in_progress`, `approve_plan`, `building`, `validating_code`, `approve_deliverable`, `needs_decision`, `needs_firstmate_decision`, `done`, `canceled`, and `duplicate`.
Omitted mappings use the names in the public example.

`agent_labels` maps resolved model IDs to existing labels in the workspace-level `Agent` group.
The runtime never creates values automatically.
Include an `unknown` value to make unmapped models visible without inventing labels.

`features.relay`, `features.mirror`, and `features.escalation` each accept `off`, `shadow`, or `on`.

Template paths can be absolute or relative to the YAML file.
`reply` supports `{{body}}` and `{{verdict}}`.
`report` supports `{{summary}}`, `{{events}}`, and `{{drift}}`.
The review template must include `{{issue}}` and `{{title}}` and sections with IDs `outcome`, `changes`, `verification`, and `review`.
A completed walkthrough must retain those sections and contain no unresolved template or placeholder text.

Run `fm-linear contract lint` after every config change.
Run `fm-linear contract apply-states --team KEY` to idempotently ensure configured workflow states.
Run `fm-linear contract apply-labels` to idempotently ensure the workspace `Agent` group only.
