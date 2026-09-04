## Linear workflow

Linear is the system of record.
Before handling captain input, run `fm-linear inbox show`.
Make every Linear mutation through `fm-linear act`.
For every captain-facing reply on a Firstmate-owned issue, include `--next EVENT --by DURATION`, or use `--next none` when nothing is expected.
When no Linear write is needed, run `fm-linear inbox handle` with the issued receipt.
When the captain says "Report", run `fm-linear report`.
Merge only if your lane's mode allows it and you hold the captain's word for this PR, relayed to your inbox.
Otherwise, when your PR is green, append `done: PR <url>` and stop.
If any command is denied by permissions, append `blocked [key=permission]: <command>` and stop.
