# FM Linear development status

**FM Linear is in development.**
The public documentation is written for the eventual product release.
It does not establish that described capabilities are already implemented.

## Ready to explore

The product goals, architecture, technology choices, and implementation guidance are documented.
The guides describe setup, requesting work, progress tracking, reviews, and workflow configuration.
The homepage uses a generic screenshot from Linear’s documentation.
It does not show a running FM Linear integration.

## Firstmate adapter ready for review

The adapter now reads full inventories in the primary and directly registered secondmate homes through Firstmate's existing transport.
It retains home identity, source age, incomplete coverage, and last-known work in SQLite, and exposes `fleet` and secondmate-qualified `task` commands.
The [secondmate review guide](SECONDMATE_REVIEW.md) records the scope, limitations, live evidence, and manual checks.

The adapter implements installation checks, task reads, brief updates, launch checks, message delivery, and response capture.
The [adapter review guide](ADAPTER_REVIEW.md) describes its seven interfaces and four runnable manual checks.
Automated coverage uses real SQLite, process termination, and installed Firstmate scripts in isolated fixtures.
Local macOS checks pass against Firstmate commit `6ee33265b6232ecca5821dbb5a0f08952e133bb5`.
Linux CI is configured but remains unverified until it runs.

Firstmate must call the brief-update command before launch.
The adapter can inspect available launch evidence but cannot force preparation or agent compliance.
Missing dependency evidence remains unknown, and ambiguous message delivery stays held for the caller to resolve.
The adapter does not implement a service, Linear synchronization, workflow rules, or a setup wizard.
Further subsystem work waits for human review of this adapter.

## Planned next

The [reporting guide](../../docs/src/content/docs/guides/troubleshooting.mdx) proposes automatic incident detection, report drafts, user approval, and confirmed GitHub submission.
Runtime detection and submission remain unimplemented; the docs provide a copyable prompt and a separate agent investigation procedure.

- Work and conversation context, followed by workflow requirements and rules.
- Durable delivery and recovery after restarts.
- Linear intake through polling every 30 seconds by default, with a configurable interval.
- Workflow configuration, publication, and reconciliation.
- Configurable issue details, including Herdr panel references.

These are development goals, not released capabilities.

## Platform targets

FM Linear targets macOS and Linux.
The runtime and Firstmate integration need verification on each platform before we claim support.
Windows is outside the supported platform scope.

## Follow development

The [source repository](https://github.com/josh-padnick/fm-linear) contains the design documents and work in progress.
The project is open source under the MIT license.

## Remaining implementation decisions

Authentication and credential storage, configuration schema and commands, issue enrollment, Herdr panel lookup, artifact hosting, polling bounds, and merge observation still require implementation validation.
Keep these decisions in internal development records rather than repeating product-preview notices in the public guides.
Firstmate compatibility limitations and project affiliation remain relevant public documentation.

## Setup journey assumptions

The setup guide now specifies a concrete user journey at the user's request, using best-guess product decisions for unfinished behavior.
These are proposed interfaces to implement and validate, not verified commands in the current repository.

- Provide a curl-to-shell installer for macOS and Linux, with manual release packages as a fallback.
  Reject unsupported operating systems with a clear message.
- Publish `install.sh` as a GitHub release asset so the documented `releases/latest/download/` URL resolves at launch.
- Install a self-contained executable for the current user, detect the operating system and processor, verify the downloaded release, and explain any required PATH changes; do not require Bun for end users.
- Provide `fm-linear --version`, an interactive and repeatable `fm-linear setup`, and `fm-linear status`.
- Have users create or reuse a dedicated Linear account for Firstmate before starting the setup wizard, separate from the captain's account and shared across crewmates.
- Use that account's personal Linear API key in a masked credential prompt; verify account, workspace, team access, and required write capabilities.
- Default to requests started through Firstmate, leaving unrelated existing issues untouched.
- Detect or request the Firstmate home, inspect compatibility, and review any integration changes before activation; this does not resolve the pre-dispatch instruction hook.
- Let the wizard map the full recommended workflow, assign reviewers, approve label/status creation, save instructions, and choose managed issue details and artifact access.
- Offer a 30-second polling default, start-at-login, and Save and start for a persistent background service.
- Verify installation with a small planning task and a reply in the same Linear thread.

Exact release packaging, credential storage, service installation per platform, CLI behavior, and wizard prompts need implementation and end-to-end validation.
The installer scripts and release assets described in the setup guide are not implemented or published yet.
Linear recommends OAuth for applications distributed to others; the API-key journey is a concrete initial design for the user's account-based workflow, not a decision to exclude OAuth permanently.

## Workflow YAML reference assumptions

The public workflow reference specifies a proposed YAML shape for the intended user experience.
It builds on the homepage example: `team`, `teammates`, and a `workflow` mapping containing `linear_status`, `linear_assignee`, and `instructions` per stage.
It documents keys for the thirteen predefined stages.
The proposed generic `required_outputs` field is deferred and has been removed from the public configuration examples and reference.
These fields, stage keys, default merging, and identity resolution still require a validated schema and implementation.
The introductory plan-review example and the separate build-stage recap example are excerpts, not complete standalone configurations.
YAML order is not a transition rule.
Optional instructions apply to work during their own stage and must reach the assignment before that work starts.
The concrete customization is an interactive recap produced during build; its reported artifact identity, accessible link, and handoff verification still need design and implementation.

## Runtime compatibility-check proposal

The [CLI reference](../../docs/src/content/docs/reference/cli.md) defines the proposed human-facing command set.
Alongside setup, status, and compatibility checks, it proposes start, stop, restart, logs, metrics, update, help, and an explicit configuration path.
These commands are not implemented; service control, updater recovery, diagnostic output, and metrics filters still need concrete contracts and validation.
Read-only `fm-linear incidents list`, `show`, and `export` operations are also proposed, with privacy and ownership rules in [ERRORS.md](../ERRORS.md).
Their implementation must not imply report publication or automatic retry authority.
Agent-facing brief preparation and report submission remain separate interfaces whose command names and schemas are not yet defined.

Add `fm-linear test` to verify versioned adapter contracts against the actual installed Firstmate checkout and relevant local changes.
The command and automated change detection are not implemented.
Setup and the service should reuse its safe local checks, persist results in SQLite, invalidate stale results, and surface new incompatibilities without repeated agent interruptions.
The behavioral fixture design, required-check policy, and validation boundaries are specified in [the implementation notes](IMPLEMENTATION_NOTES.md#fm-linear-test-compatibility-command).
