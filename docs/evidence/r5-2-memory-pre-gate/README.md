# R5.2 offline acceptance evidence

Baseline: `27700ab42d4d781153f5c48c0b2c54df2a44d629`.

This directory contains exact npm command logs, bounded packaged facts, frozen W2 hashes and prior-stage regression summaries. Live Jev was **NOT RUN**. FakeDecisionGateway is used only under explicit acceptance flags; normal production launch is tested separately.

Chat requests use metadata-only evidence facts. Packaged observer records hashes/counts/allowlisted field names and receipts, never raw Chat/Memory/Skill/file/provider error bodies. Free/Party/Workflow checks use a read-only Main test harness; they do not represent production automatic extraction.

No migration or dependency was added. No UI change was required. User Accept/Reject remains the only activation path for extracted PROPOSED Memory.

## Evidence index

- [acceptance.json](acceptance.json): 130 files / 1093 tests; six original commands; RUN/SKIP/fallback, owner isolation and read-only execution compatibility.
- [Final packaged facts](d3225ed9-f640-49aa-b005-e9974cefe430/facts.json): actual extractor counts, bounded requests/receipts and SQLite provenance checks.
- [frozen-hashes.json](frozen-hashes.json): unchanged OFFICIAL news/software/research v1 manifest and content hashes.
- [skill-regression.json](skill-regression.json): R5.1 actual calls and persisted selections across Free/Party/Workflow/fallback.
- [generation-regression.json](generation-regression.json): G1/G2/G3 recovery, UNKNOWN zero replay, Human Bridge and LANGUAGE-only Skill boundary.
- [validation/](validation/): full logs for the six original npm commands. `smoke-package.txt` is the final full PASS; the separately retained interrupted run is not acceptance evidence of success.

RUN and explicit fallback each invoke the real existing extractor once; SKIP invokes it zero times. The two extraction Usage rows match these actual calls. No live Jev request was made, and compatibility harness evaluation does not create production automatic extraction.
