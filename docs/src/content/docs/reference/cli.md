---
title: CLI commands
description: Set up FM Linear, control synchronization, check compatibility, and inspect problems from your terminal.
---

Use the `fm-linear` CLI to set up your connection and manage the local background service on macOS and Linux.
You can continue requesting work and discussing issues through Firstmate and Linear.

This page defines the proposed command interface.
The commands below still need implementation.

## Command summary

| Command | What it does |
| --- | --- |
| `fm-linear setup` | Walk through connecting Firstmate and Linear, choosing a workflow, and starting synchronization. |
| `fm-linear start` | Start the background service using your saved configuration. |
| `fm-linear stop` | Stop the background service while preserving pending deliveries and history. |
| `fm-linear restart` | Stop and start the service using your saved configuration. |
| `fm-linear status` | Show service health, connection status, and work waiting to synchronize. |
| `fm-linear test` | Check whether the installed Firstmate code satisfies FM Linear's integration assumptions. |
| `fm-linear logs` | Show recent diagnostics to help explain a problem. |
| `fm-linear metrics` | Summarize synchronization performance and how often FM Linear interrupts Firstmate. |
| `fm-linear incidents` | Inspect integration problems and prepare a local report draft. |
| `fm-linear update` | Update FM Linear while preserving your configuration and pending work. |
| `fm-linear --version` | Print the installed FM Linear version. |
| `fm-linear --help` | List available commands and options. |

## Setup and configuration

### `fm-linear setup`

Run the setup wizard for a new connection or to review an existing one.
The wizard checks your Firstmate installation, connects your dedicated Firstmate account in Linear, and helps you choose teams, teammates, statuses, and labels.

Choose the recommended workflow or customize your own.
The wizard detects existing Linear statuses and asks before creating any that are missing.
Review the proposed changes before saving settings and starting the service.

Follow [Set up FM Linear](/guides/setup/) for the complete steps, including creating the dedicated Linear account before running the wizard.

### `--config <path>`

Use a specific configuration file instead of the default:

```sh
fm-linear --config /path/to/config.yaml setup
fm-linear --config /path/to/config.yaml status
```

The default file is `~/.config/fm-linear/config.yaml`.
If you set `XDG_CONFIG_HOME`, FM Linear uses `$XDG_CONFIG_HOME/fm-linear/config.yaml` instead.
An explicit `--config` path takes precedence.

Commands must address the service using that same configuration file.
See [Where configuration lives](/reference/configuration/#where-configuration-lives) and [Workflow configuration](/reference/workflow/) for the settings you can change.

## Control synchronization

### `fm-linear start`

Start synchronization in the background using saved settings.
On every service start, FM Linear validates the configuration and runs Firstmate compatibility checks before enabling dependent synchronization.
Diagnostics remain available if a check fails.
Running the command again reports the existing service rather than starting a duplicate.

### `fm-linear stop`

Stop polling Linear and delivering new integration updates.
Preserve accepted messages, pending actions, and issue history so synchronization can resume later.

Stopping FM Linear does not stop Firstmate or its crewmates.
Their work can continue while Linear updates wait for synchronization to resume.

### `fm-linear restart`

Stop and start the service with the saved configuration.
Run the compatibility checks again before resuming dependent synchronization.
Pending work survives the restart; confirmed deliveries must not repeat.
A restart does not update instructions already given to a running crewmate.

## Check health and compatibility

### `fm-linear status`

Show whether the service is running, which configuration it uses, and whether its Firstmate and Linear connections are healthy.
Include the last successful sync, pending deliveries, unresolved report requests, and any compatibility failures that prevent an operation.
Show when observations were collected so an old successful check does not appear current.

Use this command for a quick health check.
Reading status should not notify Firstmate or dispatch work.

### `fm-linear test`

Run the compatibility checks against the configured Firstmate checkout, including relevant local changes.
Report which integration assumptions passed, failed, or could not be verified.

Behavioral checks use isolated task data and simulated agents and services.
They do not launch live crewmates or write to Linear.
A pass confirms the tested contracts for that checkout; it does not guarantee that agents follow every instruction.

See [Compatibility](/reference/compatibility/) for when checks run automatically, what they cover, and how failures affect synchronization.

## Inspect diagnostics and metrics

### `fm-linear logs`

Show recent integration activity and errors, including the affected connection, task, or pending delivery when available.
Use logs to investigate a problem reported by `fm-linear status`.
Exclude credentials and avoid including private issue or conversation content by default.

The command displays local diagnostics; it does not submit a bug report.
See [Reporting bugs](/guides/troubleshooting/) for collecting and reviewing information before sharing it.

### `fm-linear metrics`

Summarize locally recorded metrics for synchronization and Firstmate interactions.
Include delivery delays, failures and retries, report requests, repeated notifications, and unresolved request ages.
Show the reporting period and distinguish unavailable measurements from zero.

Read existing records from SQLite without asking Firstmate to generate a summary.
See [Metrics](/reference/metrics/) for each measurement's meaning and limitations.

### `fm-linear incidents`

Inspect a problem and its supporting evidence without asking Firstmate to investigate it first.

| Command | What it does |
| --- | --- |
| `fm-linear incidents list --open` | List unresolved incidents and their impact. |
| `fm-linear incidents show <id>` | Show a problem's timeline, delivery state, and available diagnostic evidence. |
| `fm-linear incidents export <id>` | Prepare a sanitized local report draft for review. |

The list and show commands support `--json` for structured output.
These commands do not retry work, notify Firstmate, or submit a GitHub issue.
Exporting a draft does not authorize publication.
See [Reporting bugs](/guides/troubleshooting/) for the review and approval process.

## Update FM Linear

### `fm-linear update`

Install the latest FM Linear release and preserve saved configuration, credentials, issue mappings, and pending deliveries.
Check compatibility again when the updated adapter changes the integration assumptions.
Updating FM Linear does not update Firstmate's checkout.

If a release offers new workflow defaults or model labels, present those changes separately for review.
Keep existing customizations unless you choose to adopt the changes.
Do not relabel historical work as though a newer model performed it.

## Get help

Use `fm-linear --version` when checking your installation or reporting a problem.
Use `fm-linear --help` for the command list, or request help for one command:

```sh
fm-linear test --help
```

## Commands used by agents

Firstmate also needs a way to request [brief preparation](/reference/firstmate/) and [submit structured reports](/reference/messages/#how-the-report-would-be-submitted).
Those operations belong to the integration rather than your everyday terminal workflow.
Their command names and input formats remain to be defined.
