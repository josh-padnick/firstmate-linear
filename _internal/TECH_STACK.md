# FM Linear technology stack

## Scope

This document records the recommended technologies, their purpose, and the reasons for choosing them.
Subsystem responsibilities, data ownership, and core design decisions belong in [ARCHITECTURE.md](ARCHITECTURE.md).
Concrete implementation guidance and verification expectations belong in [IMPLEMENTATION_NOTES.md](tmp/IMPLEMENTATION_NOTES.md).
These are choices for the new design, not a claim that every integration or dependency is implemented.

## Technologies

| Technology | Purpose | Rationale |
| --- | --- | --- |
| FirstMate | Orchestrate software work and execute tasks through agents. | FM Linear extends the orchestrator users already operate. |
| Linear GraphQL API | Read and update issues, conversations, assignments, statuses, labels, and artifact references. | Provides programmatic access for deterministic integration behavior. |
| TypeScript | Implement the service, workflow rules, adapters, and CLI. | Static types make subsystem contracts explicit and help catch incompatible changes. |
| Bun | Run the application, manage dependencies, execute tests, and compile release binaries. | Provides an integrated toolchain with built-in SQLite access. |
| SQLite | Persist operational integration data. | Provides local transactional storage without a separate database server. |
| Zod | Validate configuration and external data at runtime. | Defines runtime schemas with inferred TypeScript types. |
| Biome | Lint and format TypeScript code. | Provides a consistent automated tool for code checks and formatting. |
| GitHub Actions | Run automated checks and build releases. | Supports repository-based CI with jobs for the target operating systems. |

## Integration choices

Use [FirstMate's supported interfaces](https://github.com/kunchenguid/firstmate) as the integration surface.
Supported upstream versions and any additional adapter runtime dependencies require verification.
The unresolved dispatch capability is documented in [IMPLEMENTATION_NOTES.md](tmp/IMPLEMENTATION_NOTES.md#firstmate-compatibility-and-dispatch).

Use the built-in `fetch` API with explicit operations for the [Linear GraphQL API](https://linear.app/developers/graphql).
A separate GraphQL SDK is not selected at this stage.

## Runtime and database choices

Enable strict TypeScript checking and run `tsc --noEmit` separately from Bun execution.
[Bun executes TypeScript without performing typechecking](https://bun.com/docs/runtime/typescript).
Use [Bun's test runner](https://bun.com/docs/test) and [executable bundler](https://bun.com/docs/bundler/executables) as part of the toolchain.

Use [`bun:sqlite`](https://bun.com/docs/runtime/sqlite), Bun's built-in SQLite driver, with prepared SQL and explicit migrations.
This choice couples database access code to Bun while retaining SQLite as the database format.
An ORM is not selected.
SQLite is the selected engine; Turso remains an alternative to reconsider only if a concrete requirement warrants it.

## Validation and tooling

Use [Zod](https://zod.dev/) for runtime schema validation and TypeScript type inference.
Use [Biome](https://biomejs.dev/) for linting and formatting, alongside the TypeScript compiler.
Use GitHub Actions for CI and release automation.
Follow [TESTING.md](TESTING.md) for test layers and CI coverage, [LOGGING.md](LOGGING.md) for diagnostic output, and [ERRORS.md](ERRORS.md) for failure contracts.
These practices do not require a hosted telemetry service or a separate logging database.
Pin tool versions and commit the dependency lockfile for reproducible builds.

## Platform support

Target macOS and Linux.
Verify the chosen runtime, FirstMate integration, and release toolchain on both platforms.
Specific operating-system versions and CPU architectures remain to be defined.
Platform service mechanisms and artifact hosting technologies remain open selections; their requirements are in [IMPLEMENTATION_NOTES.md](tmp/IMPLEMENTATION_NOTES.md).
