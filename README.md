# firstmate-linear

`firstmate-linear` makes Linear the durable system of record for a [Firstmate](https://github.com/josh-padnick/firstmate) software fleet.

One local service captures captain activity, delivers actionable events through Firstmate's extension protocol, relays answers to mapped workers, and mirrors deterministic fleet and pull-request state back to Linear.
It uses one SQLite database, one LaunchAgent, one YAML config, and one small extension package.

## Requirements

- macOS with a working Firstmate home in `FM_HOME`.
- Node.js, which the Firstmate extension host also requires.
- Bun 1.2 or newer when building from source.
- `gh` authenticated for pull-request reconciliation.
- `linear-axi` on `PATH` for read-only Linear context.
- A Linear personal API key with access to the configured teams.
- Current Firstmate extension bindings with `process-event-adapter/1`.

## Install

Download the release binary for Apple silicon:

```sh
curl -L -o fm-linear https://github.com/josh-padnick/firstmate-linear/releases/download/v1.0.0/fm-linear-darwin-arm64
chmod 0755 fm-linear
```

Use `fm-linear-darwin-x64` on an Intel Mac.
You can instead build the same standalone binary from a checkout with `bun install --frozen-lockfile && bun run build`.

Initialize and install it:

```sh
export FM_HOME=/absolute/path/to/firstmate-home
./fm-linear init --captain "Your Linear display name" --team ENG
./fm-linear install --harness claude
```

Use `--harness grok` or `--harness codex` instead, or repeat the flag to install several optional accelerators.
The core workflow does not depend on a harness-specific hook.

Store `LINEAR_API_KEY` in the macOS Keychain under service `fm-linear` and your local account name.
For unattended or test homes, `$FM_HOME/.env` with mode `0600` is also supported.

Put `~/.local/share/fm-linear/bin` before other tool directories on `PATH`.
That directory contains the standalone service binary and a guarded `linear-axi` reader that refuses mutation commands outside the `fm-linear act` workflow.

Review the generated config, then queue the workflow contract checks:

```sh
fm-linear config show --effective
fm-linear contract lint
fm-linear contract apply-states --team ENG
fm-linear contract apply-labels
fm-linear doctor
fm-linear cutover enable
```

`apply-labels` creates the workspace-level `Agent` group when absent.
It never creates label values, so configured model labels must already exist.

To apply private configuration and templates after initialization:

```sh
fm-linear config import /absolute/path/to/private/linear-config
```

## Daily workflow

```sh
fm-linear inbox list
fm-linear inbox show EVENT_ID
fm-linear act reply ENG-123 --receipt RECEIPT --comment "..." --verdict changes-requested --to firstmate
fm-linear inbox handle EVENT_ID --receipt RECEIPT --note "no write needed"
fm-linear report
fm-linear status
```

`inbox show` prints the complete captured event and issues a receipt bound to exact event IDs.
Every mutating `act` requires that receipt.
If a newer captain comment arrives between reading and acting, the write is refused and the newer event is printed.

The exact normalized comments `approved` and `lgtm` are approvals only while an issue is in an approval status.
Conditional text such as `Approved if you fix X` is feedback and returns ownership to Firstmate.

Link fleet tasks explicitly so relay and mirror operations never guess:

```sh
fm-linear task link TASK_ID ENG-123 --role primary --worktree /absolute/worktree --harness claude
fm-linear task list --active
fm-linear task close TASK_ID
```

## Configuration

The only runtime config is `$FM_HOME/config/linear-workflow.yaml`.
See [the complete example](examples/linear-workflow.example.yaml) and [the contract reference](docs/contract-reference.md).

Every team defaults to `managed: assignee:self`.
`managed: all` is an explicit opt-in, and `projects` can narrow a team by project name or slug.

Automation features have three modes:

- `off` disables planning and writes.
- `shadow` computes and reports intent without applying it.
- `on` enqueues the deterministic operation.

An invalid config edit leaves the last-known-good config active, and `doctor` names the invalid file.

## Reliability model

The service database owns domain events, dispositions, snapshots, task links, observations, receipts, and the mutation outbox.
Firstmate core owns durable process-event capture, wake publication, re-announcement, and `(source, sequence)` handling.
`core_deliveries` joins those ledgers without copying either one's responsibilities.

Linear capture uses overlap polling, pagination, periodic full resync, revision-level deduplication, and cursor advancement only after successful processing.
Writes use deterministic job keys, conditional state updates, client-generated comment IDs, verification after ambiguous failures, exponential backoff with jitter, and `Retry-After` support.

See [the design](docs/design.md), [implementation plan](docs/implementation-plan.md), and [protocol spike](docs/spike-report.md).

## Rollback and uninstall

```sh
fm-linear cutover disable
fm-linear uninstall
```

Uninstall removes the service, installed extension package, binary, write guard, and harness accelerators.
It preserves the YAML config, templates, SQLite journal, and recorded history.
Running `init` again reuses that state.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

Set `FM_LINEAR_FIXTURE_DIR` to replay redacted GraphQL fixtures.
Set `FM_LINEAR_RECORD_DIR` only in a trusted local session to record automatically redacted responses for later replay.
Fixture identity values and human-authored content are replaced before they reach disk.

This project is licensed under the MIT License.
