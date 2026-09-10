# First-release working documents

Use this directory to guide implementation and verification of FM Linear's first release.
It holds development status, implementation proposals, and research checkpoints whose usefulness depends on the current development phase.
These documents guide the work; they do not establish that a capability is implemented or verified.

Lasting architecture, domain definitions, technology choices, and engineering practices belong in the parent [`_internal`](../) directory.
Lasting test requirements also stay there because they describe behavior that future changes must continue to protect.
Detailed first-release verification scenarios belong here; reusable harness procedures should move beside the tests as they are implemented.

## Working documents

| Document | Purpose |
| --- | --- |
| [TEST_VERIFICATION.md](TEST_VERIFICATION.md) | Detailed first-release test scenarios, separate from lasting risks and required evidence. |
| [Secondmate support plan](../../plan.md) | Active Markdown plan for extending the adapter to registered secondmate homes. |
| [SECONDMATE_REVIEW.md](SECONDMATE_REVIEW.md) | Implemented adapter scope, live read evidence, and manual secondmate checks. |
| [WORK_CONTEXT_PLAN.mdx](WORK_CONTEXT_PLAN.mdx) | Pending work and conversation context plan, preserved while secondmate adapter support is reviewed. |
| [FIRSTMATE_ADAPTER_PLAN.mdx](FIRSTMATE_ADAPTER_PLAN.mdx) | Approved plan for the first-pass adapter, preserved before planning the next subsystem. |
| [EARLY_FIRSTMATE_CHECK.md](EARLY_FIRSTMATE_CHECK.md) | Historical-source compatibility check and operation-gate evidence. |
| [ADAPTER_REVIEW.md](ADAPTER_REVIEW.md) | Firstmate adapter scope, validation evidence, and four manual checks. |
| [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) | Current progress, planned work, and assumptions to validate before release. |
| [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md) | Concrete implementation guidance, unresolved choices, and proposed verification mechanisms. |
| [FIRSTMATE_COMPATIBILITY.md](FIRSTMATE_COMPATIBILITY.md) | Compatibility findings and boundaries for the first adapter milestone. |
| [FIRSTMATE_EXTENSION_RESEARCH.md](FIRSTMATE_EXTENSION_RESEARCH.md) | Source-cited research into Firstmate's customization and extension interfaces. |

Keep these documents current while building the first release.
Put additional first-release plans and investigations here, and add them to this list when they help others navigate the work.
Record lasting decisions in the appropriate parent document as they are settled.

## Retire this directory after the first release

Before deleting this directory:

1. Review each document for information that still matters.
2. Extract and preserve confirmed contracts, decisions, compatibility evidence, and operational guidance in lasting internal docs, public docs, or documentation beside the relevant code and tests.
3. Transfer unresolved work that remains relevant into tracked issues or a maintained plan.
4. Update links and agent instructions to point to the retained material, and check that they resolve.
5. Delete `_internal/tmp` once no needed information or active references depend on it.

Git history preserves the original working documents; ongoing guidance must remain accessible without searching that history.
