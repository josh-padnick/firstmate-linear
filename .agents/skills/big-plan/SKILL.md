---
name: big-plan
description: >
  Research and produce grounded implementation, architecture, migration,
  refactor, rollout, or product plans before code changes using Big Plan's
  local MDX plan-review workflow. Use when the user asks for a plan, plan
  review, Big Plan, $big-plan, or /big-plan, or when a non-trivial change
  needs human acceptance of the approach before implementation.
---

# Big Plan

Use this skill for **stage 3 plan review**: the human must understand, give feedback on, and accept the agent's intended approach **before** implementation begins.

Big Plan does not own sandboxing, execution, post-execution validation, code review, project management, or merging.
Plan source is MDX on disk; plan-authored code never executes.

## Mandatory first step every session

Before authoring or revising a plan, run the installed CLI and follow its live output:

```sh
npx -y big-plan@latest guidance
```

If the project already depends on `big-plan`, prefer the local binary (`bunx big-plan`, `pnpm exec big-plan`, `npx big-plan`, or `./node_modules/.bin/big-plan`) over a global install.
Use `npx -y big-plan@latest` when you want the newest published CLI without a local pin.

**The CLI is authoritative.**
Do not invent authoring rules, component shapes, or lint policy from memory.
Do not re-copy long guidance into chat, project memory, or this skill as standing policy.
When guidance or a component changes, the package upgrade carries the new text; re-run `guidance` to receive it.

For component judgment (when to use a component and what belongs in it):

```sh
npx -y big-plan@latest guidance <Component>
```

Example: `npx -y big-plan@latest guidance QuickSummary`.

Before drawing any product UI, read `npx -y big-plan@latest guidance Wireframe`.
It owns the fixed device envelopes a drawing must fit and the visual fundamentals a drawing is judged by.

## Install or refresh this skill shell

This file is a thin shell.
Fast-changing authoring rules live only in `big-plan guidance` (and per-component guidance), not here.

Print the skill text shipped with the installed CLI:

```sh
npx -y big-plan@latest skill
```

Write it to a harness skill path only when the human asks, or when first setting up:

```sh
npx -y big-plan@latest skill write <path/to/SKILL.md>
```

After upgrading the Big Plan package, guidance updates automatically on the next `big-plan guidance`.
Re-run `skill write` only when this thin shell itself changed (rare).

## Workflow

1. **Read live guidance.** Run `npx -y big-plan@latest guidance` and follow it.
2. **Research.** Inspect the real repository: files, commands, constraints, and current behavior.
3. **Author.** Write one MDX plan on disk (for example `.big-plan/<descriptive-name>.mdx` or `plan.mdx`).
   Prefer the repository's native planning location when instructions name one.
4. **Validate.** `npx -y big-plan@latest validate <plan.mdx>` until clean.
   Details: `npx -y big-plan@latest validate --help` if available, otherwise top-level `npx -y big-plan@latest --help` and the guidance text.
5. **Review.** `npx -y big-plan@latest review <plan.mdx>`.
6. **Present.** Give the human the stable plan address the command prints.
   Treat it as the plan's address; the session address is only for debugging.
7. **Wait for approval.** Do not implement until an `approval` request arrives.
   Re-read `work.planPath`, confirm its digest matches `work.pinnedSnapshot`, acknowledge without editing the plan, and begin execution.
   A missing path, a missing file, or a digest mismatch is a hard stop: report it through the response by adding `hardStop` (one line naming what you found), and do not search for another copy.
   On feedback before approval, revise the MDX source, re-validate, and ask again in the live review.

`compile` produces machine-readable JSON for tools; it does not replace human review of the HTML document.

## Presenting the review document

Always surface the stable `http://127.0.0.1:<port>/plan/<plan-id>` address
printed by `big-plan review`. It remains the plan's address across review-runtime
restarts. Do not substitute the ephemeral session address unless the command
reports that the review-link service is unavailable.

## Package upgrades and update propagation

| What changed                                                 | What the end user does                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Authoring principles, component guidance, lint, CLI behavior | Upgrade the package (or use `npx -y big-plan@latest`); re-run `npx -y big-plan@latest guidance`      |
| This thin skill shell (workflow framing only)                | Upgrade the package, then re-run `npx -y big-plan@latest skill write <path>` if a copy was installed |

Prefer `npx -y big-plan@latest ...` for always-current one-off runs.
The CLI also exposes a built-in `update` command for global installs; use it only when the human wants a global upgrade.
Never overwrite installed skill files unless the human (or an explicit `skill write`) requested it.

## Failure modes

- **Pinned old version:** local or lockfile pins keep old guidance; use `@latest` or bump the dependency when freshness matters.
- **Offline / no registry:** use the already-installed local binary; skill text and guidance still match that installed version.
- **Skill not installed in the harness:** the agent can still run `npx -y big-plan@latest skill` and follow this workflow without a harness skill entry.
- **Missing guidance acknowledgment:** `validate`, `render`, and `review` stay locked until `big-plan guidance` is run for the working directory.

## Out of scope for this skill

Do not use this skill as a substitute for execution, PR review, or product QA after the plan is accepted.
Those stages come after plan acceptance.
