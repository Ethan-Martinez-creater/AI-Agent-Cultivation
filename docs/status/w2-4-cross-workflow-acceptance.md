# W2.4 — Cross-Workflow Acceptance

Baseline: `52bb73a094653bfc78c2438a41a541b62d9d1744`. Scope: W2.0 and the three already published official v1 templates, under AP-007 v1.1. No fourth template or future execution capability is added.

## Changes

- Added unified real-SQLite tests over all three OFFICIAL packages: installed version/Contract hashes, immutable Run inputs across reopen, frozen version retention, closed REVIEW targets and final producer Contract projections.
- Added a cross-template R4/Permission matrix using the shared deterministic planner harness: ranked sequential probes, AUTO fallback, unsupported capability zero-probe exclusion, purpose versus authority, Mission grant isolation, DENY no execution, and template-specific review independence.
- `w24-packaged-smoke.mjs` creates a new project-local profile and launches normal production first: migrations, three official installations, zero Runs. The existing news/software/research acceptance drivers then share its SQLite and Workspace. Previous fixture actors are archived and servers disabled through typed IPC; no Run facts or databases are reset/copied.
- All three drivers retain their standalone behavior. In W2.4 mode, real BrowserWindow captures at 1440 / 1180 / 900 cover creation, inputs, approval, Human Bridge, revision/blocked, delivery/history and Advanced. The final restart uses normal production, without fake execution flags.
- Added news QA multi-edge budget exhaustion and final-confirmation restart; added software journal-APPLIED / operation-PREPARED crash recovery.
- Human Bridge keeps opaque delivery paths in Advanced; the primary surface shows the Workspace delivery location without Run/Step IDs. Fixture actor/service labels use normal product names. Full paths and all deterministic delivery constraints remain accessible.
- The Windows forced-close harness now waits for the Renderer dispatch acknowledgement before killing the process, and allows up to 30 seconds for the existing SQLite handle-release check. Errors are not suppressed and the database is not reset.
- Added [release governance](../w2-release-governance.md), including initial-release Breaking Changes and per-version Fixture Tasks/evidence indexes, without editing hashed package metadata.

## Confirmed persistence defect and migration

`0026_w24_dynamic_manifest_integrity.sql` is append-only. The old dynamic manifest guard accepted duplicate path entries covering up another modified journal path, and could accept a stale afterHash for timestamp ties. The supplemental trigger requires a path bijection and the latest `(created_at,id)` journal hash. Main already uses that deterministic ordering.

Tests exercise the shipped 0025+0026 SQL with duplicate/missing paths, timestamp-tied stale hashes, correct manifests, VERIFIED, PREPARED→UNKNOWN empty manifests, and APPLIED→UNKNOWN original evidence. The original fixed-path and transition guards remain active. No historical migration, official Definition, Contract, manifest or package hash changed.

## Acceptance and evidence

Verification: 98 test files / **817 tests** (22 added), plus typecheck, lint, format:check, Windows x64 package and full smoke:package. Final command results and the exact clean profile are archived in the evidence index below.

Final packaged profile (2026-10-05): `.test-data/w24-clean-packaged-32f742a1-c8d2-4213-b624-4afe85dadbb7`. The same database contains news 4 Runs, software 5 Runs and research 13 Runs: three primary news cases plus QA budget exhaustion; four primary software cases plus pre-commit mutation recovery; research A/B/C/D/F/E plus seven adversarial input cases. **132 screenshots** are committed, with logical/physical dimensions and SHA-256 in `visual-manifest.json`. Final production restart preserved all eight audited fact-table counts.

Evidence directory: `docs/evidence/w2-4-cross-workflow/`. The detailed audit compares installed hashes with code, every completed producer binding/Contract/hash/receipt/checkpoint, declared decisions, edge/group counts, VERIFIED effects, final machine validation, FK/integrity checks and Usage Run ownership. Stage facts retain the source/claim, command/manual, raw-result/input, Tool, continuation and recovery checks.

The final audit rebuilds output bindings from the latest completed producer attempts and selects the receipt by its recomputed current state hash. It also checks present optional outputs, all operation receipts (including the MIXED external receipt), and the persisted entry-step identity. It does not select an arbitrary older successful final receipt.

### Cross-Workflow release gates

| Gate                             | Result | Evidence                                                                                                                                                 |
| -------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic state              | PASS   | Unified SQLite audit of completed Step checkpoints, terminal Missions and final machine validation; 22 Runs across three definitions                     |
| Resume                           | PASS   | Same-profile crashes, preserved waits, final production restart counts unchanged                                                                         |
| Contract validation              | PASS   | Frozen contract/version/validator/hash PASS receipts; source/claim, command and experiment-input adversarial cases                                       |
| Definition/Contract immutability | PASS   | Three-package SQLite reopen tests, rejected UPDATE/DELETE, installed JSON/hash equality                                                                  |
| Revision budgets                 | PASS   | News three QA targets share total 2; software shared fix budget; research two refine targets share frozen-input budget                                   |
| Declared revision target         | PASS   | Unified rejected unknown REVIEW targets; durable decisions reference declared edges only                                                                 |
| No duplicate side effects        | PASS   | News N12, software S05/S10 and research R08 recovery facts; final restart produces no new execution facts                                                |
| Operation Receipt recovery       | PASS   | FILE_OUTPUT, dynamic WORKSPACE_MUTATION and EXTERNAL_ACTION matrix below; all completed effect receipts VERIFIED                                         |
| Permission safety                | PASS   | Purpose does not grant; Mission grants isolated; denied Tool does not execute; dataset import creates no FILE_READ grant                                 |
| Routing compatibility            | PASS   | R4 reused by all templates; bound receipt equals actual Mission coordinator/mode; explicit constraints retained                                          |
| Availability compatibility       | PASS   | Ranked sequential probe, unavailable first candidate then next, AUTO-only Human Bridge fallback, unsupported zero probe                                  |
| Human Bridge compatibility       | PASS   | News assets/voice, software command/manual composition and research external/MIXED; ACCEPT continuation/restart once, rejected/unknown work not replayed |
| Review traceability              | PASS   | Software strict independent review; research actual reviewer/author records including honest single-author independence=false                            |
| Reference Basis completeness     | PASS   | Three immutable release metadata records and governance index cover adopted/excluded principles, rationale and manifests                                 |
| UI                               | PASS   | Actual packaged screenshots at 1440/1180/900; creation, trusted input selection, approval, Human Bridge, revision/blocked, delivery and Advanced         |
| Windows packaged                 | PASS   | Empty profile → migrations 1–26 → three official installs → Renderer-created Runs → final normal production restart; native SQLite/FK/integrity verified |

### Side-effect / crash matrix

| Boundary                            | FILE_OUTPUT                                                                                   | WORKSPACE_MUTATION                                                                                        | EXTERNAL_ACTION                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Before effect                       | News waiting Human Bridge and research PREPARED recovery retain the original execution        | Software PREPARED journal and Permission DENY tests do not mutate                                         | Research PREPARED crash becomes UNKNOWN; no external action replay              |
| Effect happened, Step not committed | News N12 and research R08 APPLIED recovery verify existing files                              | Added S05 journal APPLIED / operation PREPARED process kill; same file hash and call counts after restart | Research MIXED ACCEPT continuation and software manual ACCEPT are consumed once |
| APPLIED restart                     | News assembly and computational raw output hashes preserved                                   | S05 APPLIED restart verifies dynamic journal; S10 keeps distinct mutation lineage                         | Existing accepted durable work supplies the result; no automatic resubmission   |
| UNKNOWN                             | W2 operation tests fail closed; changed/missing research inputs accept zero R08 Artifact      | 0025→0026 preserves PREPARED→UNKNOWN and original journal evidence                                        | Research unknown-action case waits for user, retains request and raw facts      |
| Retry/loop identity                 | Research attempts keep separate immutable raw results                                         | S05/S10 and fix attempts have independent receipts; no overwritten history                                | Explicit attempts use stable independent operation keys                         |
| VERIFIED restart                    | Unified final production restart preserves all receipts, Artifact/checkpoint and event counts | Same                                                                                                      | Same                                                                            |

Detailed case facts: [news](../evidence/w2-4-cross-workflow/news/w21-facts.json), [software](../evidence/w2-4-cross-workflow/software/w22-facts.json), [research](../evidence/w2-4-cross-workflow/research/facts.json), [cross-template](../evidence/w2-4-cross-workflow/cross-workflow-facts.json). The [evidence index](../evidence/w2-4-cross-workflow/README.md) records the final profile, verification logs and screenshot manifest.

## Boundaries and known limits

- AUTO fallback and explicit hard constraints remain the approved R4 semantics. Single qualified research authors may review with honest independence=false; software implementation authors are excluded from independent S08 review.
- Research effect variants are derived by trusted code from frozen inputs; the original static v1 manifest remains frozen. Governance documents both static and effective effects.
- Offline fixture results are acceptance evidence, not actual news/clinical/scientific findings. Production tests require no internet/API key.
- No R5, W3, GenerationGateway, G1/G2/G3, MiniMax integration, new editor or general loop engine.
