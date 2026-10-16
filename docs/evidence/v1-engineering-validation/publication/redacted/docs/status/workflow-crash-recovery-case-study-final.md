> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `43894a3d03a7414c8a489feb2c7cfb34fd839fae79bc194806c65dd02882beea`. See the publication derivation map for both hashes and removed field categories.

# Workflow Crash & Recovery Case Study — Final Combined Evidence

AI Agent Cultivation V1 · Windows Electron / SQLite · 16 October 2026

## Outcome

**E3_PASS, submitted for independent review.** A fresh CR-A corrective experiment completes the previously missing completed-step recovery chain. Historical CR-B remains a separately sealed PASS and was not rerun. The original CR-A BLOCKED and E3_CONDITIONAL reports remain unchanged.

## Architecture and baseline

Baseline: main@a2551bbc9dbd87ec4701183a53a2635966326df4. Reused E1-verified Windows x64 EXE SHA-256 8a4cdbce704b86297dfee1bc0e22c9b92fc225bdb31eda6501aa668108e4b42c; runtime Main SHA-256 417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71. No workflow, permission, tool, migration, manifest, or production recovery logic was changed.

Existing offline --gate1-fake-model / --r4-fake-routing / --w22-fake-software fixtures; actual public IPC, permission, tool, filesystem and SQLite paths.

## CR-A corrective: completed facts survive a real process crash

Fresh WorkflowRun **bda77f9a-ee99-44bf-8cd4-0892e72c5b1f**, S06 StepRun **9260a547-7c31-4507-b17f-00423f416a14**, attempt 1, MissionRun **0c1ed74a-83a8-492c-8cc7-e2a0f6c3e347**. The controller verified the actual loaded Main source and paused at V8 9625:7198, after S06 completion was committed and before S07 execution. S06 artifact, validation and checkpoint were durable; S07 was READY without a Mission. The independent verifier had exactly one entry and one completion. This was an actual debugger barrier, not state polling or a simulated exception.

The controller rechecked PID, OS creation time, executable, full command line, actual Electron UserData and its own launch record, then requested exactly one Main forced termination. Every original child was individually reconciled. Unknown identity permitted bounded waiting only; PID reuse or mismatch refused termination. An exclusive authorization-used record prevents another Main kill, and per-process logs retain actual fields even on exceptions.

The same new profile restarted under a pre-bootstrap observer. Before any user continuation, preserved completed-Step identities, durable rows, model/tool event IDs and independent verifier records were asserted. Only after that check did public workflow/approval IPC advance the unfinished steps. The Run reached **COMPLETED**. New MissionRun assignments belonged to previously unfinished StepRuns; they did not replace or rerun S06. The app then closed normally and restarted again; existing and newly committed business facts stayed stable.

| Stage                      | Run state/wait | S06 model/tool | Original completed set model/tool | Whole Run model/tool | Artifact/validation/checkpoint | Independent verifier entry/completion | SQLite integrity/FK |
| -------------------------- | -------------- | -------------: | --------------------------------: | -------------------: | ------------------------------ | ------------------------------------- | ------------------- |
| BeforeCrash                | RUNNING/—      |            2/1 |                              11/5 |                 11/5 | 8/8/6                          | 1/1                                   | ok/0                |
| AfterKill                  | RUNNING/—      |            2/1 |                              11/5 |                 11/5 | 8/8/6                          | 1/1                                   | ok/0                |
| FirstRestartBeforeContinue | RUNNING/—      |            2/1 |                              11/5 |                 11/5 | 8/8/6                          | 1/1                                   | ok/0                |
| ExplicitContinue           | COMPLETED/—    |            2/1 |                              11/5 |                 13/5 | 11/11/10                       | 1/1                                   | ok/0                |
| SecondRestart              | COMPLETED/—    |            2/1 |                              11/5 |                 13/5 | 11/11/10                       | 1/1                                   | ok/0                |

## A transparent assertion compatibility correction

The sealed evaluator is still used and its unmodified result remains in legacyDiagnostic (FAIL). Its REC-01 projection treats a legitimate null-to-new-Mission assignment on an already allocated unfinished StepRun as an identity mismatch. The corrective rule accepts only that specific transition after explicit continuation, while preserving Run/version/StepRun/attempt/creation time and all completed identities. New Mission IDs must be fresh and bound to the unfinished step; unauthorized new attempts or startup assignments fail. Other legacy failures are never swallowed.

The new adapter additionally constrains continuation artifacts, receipts, checkpoints and events by unfinished-Step lineage. Pure in-memory negative controls reject altered completed identities, new attempts, automatic startup calls, stale Mission reuse and wrong output ownership. These simulated fixtures validate assertions; they are not the process-level experiment. REC-08 relies on the independently rerun offline retry test, not a retry in formal CR-A.

One initial offline REC-03 result failed because the new analyzer expected a single Artifact ID on a Run-level final-validation row. The production schema instead stores output_bindings_json. The analyzer now checks the actual Run/version, output Artifact hashes, OUTPUT bindings and continuation lineage, with seven additional negative controls. The initial failed result remains in analysis-history; no application run or original Snapshot was repeated or altered. See the [schema correction record](../evidence/v1-engineering-validation/e3/cr-a-corrective/analysis-schema-correction.md).

## CR-B: uncertain effects remain isolated

Historical CR-B paused after an actual local file write and before the successful ToolRuntime result: Operation/Journal were PREPARED and the Mission was running. After its original one-time forced termination, both restarts preserved Mission/MissionRun INTERRUPTED, Operation UNKNOWN, Journal PREPARED and Workflow/Step WAITING/USER_CONFIRMATION with EXECUTION_INTERRUPTED_RETRY_REQUIRED. Independent write entry/return stayed at one each. No manual advance or retry occurred.

The corrected REC-09 description is **FirstRestart versus SecondRestart confirmation-wait stability**. CR-B had no final continuation; the historical raw wording and evidence remain intact. It was only read for combined analysis during this corrective task.

## Integrity, quality and limitations

All five new CR-A raw DB/WAL/SHM stages were sealed before SQLite was opened. Queries and integrity/FK checks used separately derived consistency copies; raw hashes and canonical Artifact hashes were independently rechecked. The original historical CR-B evidence remains separately sealed. All 733 historical untracked files, 59 prior E3 manifest entries and 71 E1 entries retained their original hashes.

New Controller strict checkJs, separate audit/adapter semantic checking, syntax, scoped lint and policy/sensitivity tests passed, alongside 1,521 application tests across 165 files and three focused recovery tests. Existing private-script lint and frozen/raw-document formatter failures remain. The existing package was reused; neither a new package PASS nor a full legacy extra-crash smoke PASS is claimed. No paid APIs, production edits, cleanup, commit or push occurred.

The final formatter also reports style differences in the new controller, snapshot helper and type declarations. Their executed bytes were retained for source-hash provenance; independent type checking, syntax and scoped lint pass. This style debt remains explicit alongside the preserved historical/raw-document failures.

The evidence demonstrates durable completed-step recovery, legal user-directed continuation, restart idempotence and containment of an uncertain local effect with no blind startup resend in the observed windows. It does **not** establish universal end-to-end exactly-once execution across third-party services or benchmark real model quality.

[Detailed corrective report](v1-engineering-validation-e3-cr-a-corrective.md) · [Combined status](v1-engineering-validation-e3-final.md) · [Machine-readable evidence](../../../../e3/cr-a-corrective/result-summary.json) · [Reproduction and boundaries](../evidence/v1-engineering-validation/e3/cr-a-corrective/reproduce.md).
