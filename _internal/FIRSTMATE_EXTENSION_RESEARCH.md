# Firstmate extension and instruction customization research

Reviewed on 2026-09-08 against upstream `origin/main`, commit [`b84e0e362face25f3dd8945297a3df1320d7668c`](https://github.com/kunchenguid/firstmate/tree/b84e0e362face25f3dd8945297a3df1320d7668c).
This note examines whether existing customization surfaces provide a supported, deterministic opportunity to insert FM Linear requirements before every worker launch.
It is a source review, not verification of a working FM Linear adapter.

## Conclusion

Firstmate supports task-specific instructions in its native brief and persistent operator preferences in its home.
Its current external extension contract does not provide a callback that prepares or validates workflow instructions before dispatch.
The distinction is between instructions being included after someone prepares the brief and code guaranteeing that preparation occurs for every launch.

## Existing customization surfaces

| Surface | What it supports | What it does not establish |
| --- | --- | --- |
| `data/<task-id>/brief.md` | Firstmate fills the task request and its implementation instructions; existing contents are copied into the launch brief. | No external instruction-provider callback prepares those contents automatically. |
| `data/captain.md` | Local captain preferences printed into Firstmate's session-start context. | The agent must interpret and apply them; no per-dispatch workflow validation follows from storing a preference. |
| `data/captain-shared.md` | Primary-owned preferences propagated to secondmate homes and printed into their session-start context. | Propagation to a supervisor's context does not directly insert task-specific text into each crewmate's brief. |
| `config/crew-dispatch.json` | Natural-language selection rules for harness, model, and reasoning effort. | No workflow instruction field or executable instruction-provider field is documented; rule selection is agent judgment. |
| `config/extensions.d/` | Explicitly enabled external process-event adapters. | No launch hook, instruction injection, task mutation, or general plugin lifecycle. |

The native brief contract names `## Captain's intent` and `## Firstmate spec` as its task-specific fill locations.
It permits other changes when a task genuinely differs from the scaffold.
See [AGENTS.md, lines 525-538](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/AGENTS.md#L525-L538) and [fm-brief.sh, lines 1-15](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-brief.sh#L1-L15).

The preferences contract is documented in [configuration.md, lines 215-221](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/configuration.md#L215-L221).
Their session-start inclusion is implemented by [fm-session-start.sh, lines 926-927](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-session-start.sh#L926-L927).
The primary-to-secondmate inheritance contract has an explicit allowlist and a separate shared-preferences file, not arbitrary plugin configuration discovery: [fm-config-inherit-lib.sh, lines 35-66](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-config-inherit-lib.sh#L35-L66).

Dispatch profiles explicitly leave rule matching to Firstmate and pass resolved launch flags to the shell: [configuration.md, lines 390-428](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/configuration.md#L390-L428).
A setup command could record a preference to call an FM Linear preparation command, but that would remain an instruction to an agent, not a guaranteed interception point.

## Compatible preparation approach

A proposed FM Linear preparation command can preserve Firstmate's existing file contract without replacing its scaffold.
After Firstmate creates and fills `brief.md`, the command would insert a bounded, clearly marked FM Linear section under `## Firstmate spec` and leave `## Captain's intent` unchanged.
This keeps the user's own request separate from integration-generated implementation requirements.
The source brief is the appropriate input; `launch-brief.md` is generated during spawn and should not be edited by the integration.
The preparation must finish before `fm-spawn.sh` reads the source brief.

This is compatibility through an editable file, not an existing Firstmate command or extension API for FM Linear.
The documented task-specific customization permission supports that placement, but does not promise an external writer coordination protocol.
An implementation would still need to prevent concurrent edits, preserve the scaffold's machine-readable fields, record the applied workflow version, and refuse invalid or stale preparation.
These checks can make a preparation command reliable when called; they cannot prove that Firstmate called it before every dispatch.

## External extensions cannot supply a launch hook

The extension specification explicitly excludes before/after hooks, instruction injection, worker-launch grants, and task mutation.
It describes one narrow process-event capability: [extension-bindings.md, lines 7-24](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md#L7-L24).

This is enforced by code, not just documentation.
The manifest validator accepts exactly one capability named `process-event-adapter` and rejects unknown fields: [fm-extension.mjs, lines 540-560](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-extension.mjs#L540-L560).
Invocation accepts only `source.poll`, `result.classify`, `result.terminal`, and `result.silent`: [fm-extension.mjs, lines 1693-1697](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-extension.mjs#L1693-L1697).

An extension executable runs as trusted same-user code and could physically edit accessible files outside this protocol.
That operating-system permission is not a supported task mutation API or a guarantee that an edit precedes a launch.
The trust boundary explicitly makes that distinction: [extension-bindings.md, lines 16-24](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/extension-bindings.md#L16-L24).

## The automatic backlog gate is not an instruction callback

Firstmate does have deterministic lifecycle checks.
Its automatic backlog gate refuses missing, held, dependency-blocked, or completed work items and owns transitions during dispatch/completion.
It excludes persistent secondmates, manual homes, and markdown homes without a backlog: [configuration.md, lines 89-110](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/docs/configuration.md#L89-L110).

That gate checks backlog facts, not the presence or version of FM Linear instructions.
`config/backlog-backend` recognizes `manual`; other values retain the `tasks-axi` route rather than selecting an arbitrary extension command: [fm-tasks-axi-lib.sh, lines 156-180](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-tasks-axi-lib.sh#L156-L180).
Selection of the task storage backend is delegated to `tasks-axi` configuration: [fm-tasks-axi-lib.sh, lines 136-154](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-tasks-axi-lib.sh#L136-L154).
This review did not assess third-party `tasks-axi` backend extensibility.

There is also a decisive ordering constraint: `fm-spawn.sh` copies the source brief to `launch-brief.md` at [lines 2195-2213](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-spawn.sh#L2195-L2213), before the backlog preflight at [lines 2537-2564](https://github.com/kunchenguid/firstmate/blob/b84e0e362face25f3dd8945297a3df1320d7668c/bin/fm-spawn.sh#L2537-L2564).
Changing the source brief as a side effect of that later backlog read would not update the already-rendered launch brief.
Using task storage reads as mutation hooks would also conflate two unrelated responsibilities.

## Documentation implications

- Explain that Firstmate creates a native task brief and FM Linear's proposed preparation step would add task-specific requirements before Firstmate renders its launch brief.
- Describe persistent captain preferences as an available way to teach Firstmate how to use an integration command, with an explicit agent-compliance limitation.
- Do not describe a configurable Firstmate instruction provider, generic launch hook, or universally installed brief shim as an existing capability.
- Do not describe a file watcher as a guarantee: brief creation and launch are not synchronized with an external watcher.
- Keep proposed wrapper or shim designs separate from the supported external process-event capability.
- Any future guarantee must identify the exact intercepted launch path, fail-closed behavior, and verified coverage for relaunches, secondmate homes, raw launch commands, and supported harnesses.
