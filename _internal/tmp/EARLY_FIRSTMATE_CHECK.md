# Historical Firstmate compatibility check

## Result

On September 10, 2026, FM Linear correctly rejected Firstmate's initial commit, `ccdea30b8c89e5725695e35c54b414e5b3509b5d` from June 11, 2026.
The source was fetched directly from `https://github.com/kunchenguid/firstmate.git` into a separate temporary checkout.
No Firstmate source files were edited, and no test outcomes were injected.

The current checkout at `861b5dad2baaa0a64703a1b0c14fb4da9bda5269` served as the positive control.
The check used a disposable Firstmate home, a real SQLite database, and the compiled FM Linear CLI.
The same home and database were used across both source revisions to test whether earlier passing evidence could incorrectly authorize another installation fingerprint.

## Observations

| Check | Observed result |
| --- | --- |
| Current revision | All three capabilities passed; `fm-linear test` exited `0`. |
| Early revision before checking it | Task read rejected with `firstmate.capability_held`; exit `2`. |
| Early revision compatibility check | Task state, briefs, and messages failed; `fm-linear test` exited `1`. |
| Task read after the failed check | Rejected with `firstmate.capability_held`; exit `2`. |
| Brief update and launch-brief check | Both rejected with `firstmate.capability_held`; exit `2`. |
| Message send | Rejected before acceptance, with no request row created in SQLite; exit `2`. |
| Switch back to current revision | Task read succeeded using the matching earlier passing evidence; exit `0`. |
| Source integrity | Content hashes remained unchanged; both Git working trees were clean. |

All blocked operations reported effect `not-attempted` and produced no result on stdout.
The early source lacks `fm-crew-state.sh` and `fm-extension.sh`; its older brief/launch contract also failed the current probe.
The message binding had already been established using the current revision in the disposable home, so the negative check was not merely testing an unconfigured home.

## Limits and follow-up

This is macOS evidence for one historical revision and the current local revision, not a guarantee about every upstream change or supported platform.
It verifies the installed compatibility checks and operation gates, not a background installation watcher or incident notifications.
Some check diagnostics remain too generic: a failed probe may report only that the isolated contract could not execute.
A future diagnostic improvement should identify the failed contract step without exposing raw subprocess output.

## Local evidence

The temporary experiment directory is `/private/tmp/fm-linear-early-sBTreU`.
It contains the untouched early checkout in `source/`, the driver in `check.ts`, and full CLI results in `results.json`.
The disposable Firstmate home and its test database were cleaned up after the assertions passed.
The driver calls the production CLI and existing isolated probes; it does not use the review scenario that deliberately edits a copied state script.
