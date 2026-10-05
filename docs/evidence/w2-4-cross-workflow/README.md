# W2.4 packaged acceptance evidence

Verified on 2026-10-05 with Windows x64 / Electron 44.4.3, native better-sqlite3 and the final package. All six required commands passed: 817 tests in 98 files, typecheck, lint, format:check, package and smoke:package. No dependency was added.

## Clean profile

Project-relative profile: `.test-data/w24-clean-packaged-32f742a1-c8d2-4213-b624-4afe85dadbb7`.

The database did not exist before the first normal production launch. Migrations 1–26 and all three OFFICIAL v1 packages installed; initial Run count was zero. The news, software and research drivers then used this SAME SQLite and Workspace. Each template was created through the Renderer form. No database copy/reset was used. Prior fixture model actors were archived and MCP servers disabled through typed IPC; their histories remain intact.

The final normal production restart used no FakeModel/workflow/routing flags. Event, Artifact, checkpoint, decision, traversal, operation/audit and final-validation counts stayed exactly equal. See [cross-workflow facts](cross-workflow-facts.json).

## Evidence index

| Evidence                                          | Contents                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cross-template facts](cross-workflow-facts.json) | Empty-profile proof, migrations, installed release hashes, 22 Runs, common integrity assertions and final restart counts                                                         |
| [Release facts](release-facts.json)               | Exact manifest/content hashes, Contracts, revision/effect manifests, Reference Basis and Design Rationale                                                                        |
| [News facts](news/w21-facts.json)                 | Short / weekly / explainer, source→claim→script, Tool purpose/approval, Human Bridge, N12 recovery, two QA edges exhausting one shared group, final-confirmation restart         |
| [Software facts](software/w22-facts.json)         | Bugfix / migration / cross-layer / mixed acceptance, independent review, S05/S10 journals, APPLIED restart and journal-APPLIED/receipt-PREPARED recovery                         |
| [Research facts](research/facts.json)             | Algorithm / real imported dataset / external / mixed, negative attempts, source/input→Tool fact→experiment chain, shared budget, UNKNOWN, seven adversarial input cases, restart |
| [Validation results](verification/results.json)   | Six commands, migration, counts and exact clean profile; raw logs are alongside it                                                                                               |
| [Screenshot manifest](visual-manifest.json)       | 132 real screenshots, logical width, physical dimensions and SHA-256 for each file                                                                                               |

## Visual acceptance

Screenshots are actual BrowserWindow captures at logical widths 1440 / 1180 / 900 and height 900. Physical dimensions reflect Windows display scaling. Creation/inputs, approval, Human Bridge, revision/blocked, delivery/history and Advanced were inspected. Narrow captures focus the current task/detail rather than hiding it below a long history list. Required scrolling remains within the existing Product UI System; there is no horizontal page overflow.

- News: [creation](news/visual/03-w21-ui-create-1440.png), [Human Bridge](news/visual/06-w21-human-bridge-acceptance-900.png), [budget exhausted](news/visual/qa-budget-blocked-900.png).
- Software: [inputs and Tool scope](software/visual/01-software-inputs-900.png), [mixed verification](software/visual/04-mixed-command-human-verification-1180.png).
- Research: [trusted dataset selection](research/visual/B-dataset-artifact-selected-1440.png), [range rejected](research/visual/B-reversed-literature-range-rejected-900.png), [cycle limit](research/visual/F-shared-cycle-limit-waiting-900.png).
- Final normal-production delivery and Advanced: `visual/official.*-{delivery-history,advanced}-{1440,1180,900}.png`.

Primary surfaces use normal product names. Fixture infrastructure and offline disclosure remain in test code/evidence and full technical data. Artifact IDs/Contracts/receipts/hashes are retained in Advanced. Human Bridge delivery paths remain available in its full specification. The explicit Workspace location is still displayed where choosing Workspace is necessary.

## Release gates and limits

All 16 release gates PASS; see [status and crash matrix](../../status/w2-4-cross-workflow-acceptance.md) and [governance](../../w2-release-governance.md). New 0026 closes duplicate/missing-path and timestamp-tied stale-afterHash dynamic manifest defects, preserving 0025 uncertainty rules. The three official package hashes and historical migrations are unchanged.

These are deterministic offline acceptance cases; their source/media/scientific data are fixtures, not live research or certified findings. No API key or internet is required. No automatic upload/push/merge/deploy/submission is performed. R5/W3/GenerationGateway/G1–G3/MiniMax integration remain outside this release.
