## Linear workflow

Linear is the system of record.
Before handling captain input, run `fm-linear inbox show`.
Make every Linear mutation through `fm-linear act`.
When no Linear write is needed, run `fm-linear inbox handle` with the issued receipt.
When the captain says "Report", run `fm-linear report`.
