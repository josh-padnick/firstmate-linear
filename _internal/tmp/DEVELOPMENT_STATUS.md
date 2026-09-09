# FM Linear development status

**FM Linear is in development.**
The public documentation is written for the eventual product release.
It does not establish that described capabilities are already implemented.

## Ready to explore

The product goals, architecture, technology choices, and implementation guidance are documented.
The guides describe setup, requesting work, progress tracking, reviews, and workflow configuration.
The homepage uses a generic screenshot from Linear’s documentation.
It does not show a running FM Linear integration.

## What we are proving first

The first implementation milestone is the Firstmate adapter.
The compatibility investigation is complete; the working adapter milestone is not.

Firstmate's dispatch tests confirm that prepared brief content reaches worker launch instructions.
Its extension contract does not provide a general hook to add instructions before every dispatch.
The selected approach is an explicit preparation handshake plus detection and message recovery when available launch evidence shows missing requirements.
Universal dispatch coverage remains unproven; the initial adapter must report that limit accurately.

Start with installed-home discovery, revision and configuration fingerprints, compatibility checks, and read-only task observations.
Prove home and execution-attempt isolation before those observations drive Linear changes.
Then add prepared briefs and process-event delivery with explicit confirmation and recovery contracts.
Introduce the shared error, logging, and testing interfaces with this first slice rather than building a separate infrastructure framework first.
Use SQLite as soon as the slice needs persistent compatibility results or accepted delivery obligations.

## Planned next

The [reporting guide](../../docs/src/content/docs/guides/troubleshooting.mdx) proposes automatic incident detection, report drafts, user approval, and confirmed GitHub submission.
Runtime detection and submission remain unimplemented; the docs provide a copyable prompt and a separate agent investigation procedure.

- A tested Firstmate adapter with explicit delivery and observation contracts.
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
