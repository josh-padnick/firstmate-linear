# Merge gate

Gate phrases are exact, normalized, full-comment matches scoped to the issue's current gate role.
The same words can approve a plan, approve a deliverable, or authorize a merge depending on that role.
Conditional prose such as "approved if you fix X" is feedback, not approval.

The service never merges and never runs `gh pr merge`.
A merge authorization wakes the Firstmate with the required action and creates a durable `pr-merged` promise with a ten-minute default deadline.
The issue reaches `done` only after GitHub supplies the `pr-merged` observation.

In `validation.mode: word`, a green PR advances to `merge-gate`, or falls back to `review-gate`, and waits for the captain's configured phrase.
In `validation.mode: verdict`, fm-linear consumes the external validator's result from the PR.

The validator publishes two checks.
`fleet-validation` carries findings and a summary containing `verdict`, `risk`, and `reason`.
`fleet-merge-gate` carries merge authorization and succeeds only for an auto-mergeable verdict that passes policy, or after a captain gate pass.
Branch protection should require only the authorization check for merge gating.

Captain-free auto-merge wakes an authorized agent to merge and holds that action to the promise deadline.
Hands-off auto-merge is armed by the agent that opened the PR, then GitHub merges when the authorization check succeeds.
fm-linear only observes the outcome in both modes.

The service applies `never_auto_paths` and `max_auto_lines` preventively before a captain-free merge wake.
For hands-off auto-merge, that copy is advisory because GitHub can merge before the service acts.
A mismatch is recorded as `policy-disagreement` and surfaced to the captain, while the validator's policy and required authorization check remain the preventive control.
