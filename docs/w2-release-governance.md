# W2 official v1 release governance

This index accompanies the immutable packages. It does not rewrite their hashed metadata. AP-007 v1.1 defines the official templates; AP-006 retains the wider architecture boundaries.

| Definition                | Version | Contracts | Validation policy     | Reference Basis                                                 |
| ------------------------- | ------- | --------- | --------------------- | --------------------------------------------------------------- |
| official.ai-news-video    | 1       | 20        | news-integrity-v1     | [News](reference-basis/ai-news-video-v1.md)                     |
| official.software-feature | 1       | 10        | software-integrity-v1 | [Software](architecture/software-feature-v1-reference-basis.md) |
| official.research         | 1       | 21        | research-integrity-v1 | [Research](reference-basis/research-v1.md)                      |

## Frozen hashes

| Definition                | manifestHash                                                     | Complete version contentHash                                     |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| official.ai-news-video    | ae37a04bf0156c42adea41d8d0418de2f942d6dc677803727af7db41ab36e4cd | 4763d276b85362096db1085ebc458c76ea731c243d72df6069da302ca75ce153 |
| official.software-feature | 30eb30ce957ef3bad798d1046bd45835322b645d97e49ca5affcac4e16cd348d | a5a9982824db796dc4843d68558b4874067d551eff878132c78c94e881e2ea5a |
| official.research         | 199c675c91c1c7d15709141be9a7dc6ce1e776f3c1b0af7c66c2ff9e1f3b03d3 | b264c0448470b12473c0e39f21cf7e1c40c1d9b4b6e1c945f9ffb5ccc2a305b7 |

`manifestHash` hashes the canonical version excluding the hash itself. `contentHash` hashes the complete canonical persisted version. The W2.4 clean-profile audit compares code, installed releases, complete version JSON, every Contract JSON and its hash.

## Per-version release materials

All three versions are initial v1 releases: **Breaking Changes: none; no predecessor version**. Their immutable release metadata includes structured Reference Basis, adopted principles, excluded mechanisms, Design Rationale, and exact Contract / Revision / Side-effect manifests. Those full manifests and references are also exported in `evidence/w2-4-cross-workflow/cross-workflow-facts.json`.

| Version     | Fixture Tasks / expected behavior                                                                                                                                                                                                            | Acceptance Evidence                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| AI news v1  | 60-second single topic, 300-second weekly 3–5 stories, product explainer; claim/source grounding, human assets/narration, assembly recovery, user final confirmation; W2.4 adds two different QA revision edges exhausting the shared budget | [W2.1](evidence/w2-1-ai-news-video/), [W2.4](evidence/w2-4-cross-workflow/)    |
| Software v1 | bugfix, migration feature, Renderer/IPC/persistence feature, mixed command/manual verification; plan review, fix/reverify, independent review, dynamic mutation recovery; W2.4 adds journal APPLIED while operation remains PREPARED         | [W2.2](evidence/w2-2-software-feature/), [W2.4](evidence/w2-4-cross-workflow/) |
| Research v1 | algorithm experiment, imported dataset, human external experiment, mixed experiment, shared refinement budget, uncertain external action; malicious citations and consumed-input facts fail closed                                           | [W2.3](evidence/w2-3-research/), [W2.4](evidence/w2-4-cross-workflow/)         |

Fixture definitions are in `scripts/w21-packaged-smoke.mjs`, `w22-packaged-smoke.mjs`, `w23-packaged-smoke.mjs` and their explicitly enabled offline gateways. They are not official/user templates and are not loaded by normal production bootstrap. W2.4 drives these acceptance families through a **single new profile** and then restarts without fixture flags.

## Revision and side-effect inventory

| Version  | Shared revision groups                                                                                                        | Side effects                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| News     | news.script_revision=2; news.final_qa_revision=2 (STORYBOARD / ASSETS / ASSEMBLY)                                             | N10/N11/N12 FILE_OUTPUT                                                                                                                                |
| Software | software.plan_revision=2; software.fix_cycle=3 (verification and review repair share it)                                      | S05/S10 DYNAMIC WORKSPACE_MUTATION                                                                                                                     |
| Research | research.hypothesis_revision=2; research.experiment_cycle=2 (frozen Run input narrows to 1–2); research.manuscript_revision=2 | R08 static FILE_OUTPUT; trusted frozen-mode mapping: COMPUTATIONAL=file, HUMAN_OR_EXTERNAL=EXTERNAL_ACTION, MIXED=file plus secondary external receipt |

All budget exhaustion waits for user action; traversal is a committed append-only fact. The research conditional effect variants are documented here alongside the static v1 manifest; this release does not pretend the static manifest contains a conditional-effect schema or alter its hash. A future version may encode those variants explicitly.

## Authority and release limits

- Only trusted Main code installs OFFICIAL packages transactionally: Contracts → release fact → immutable Version. Renderer has no registration API.
- R4 `AUTO` may fall back to Human Bridge; `SOLO`, `PARTY`, explicit identity and forced Human Bridge retain their hard constraints. No automatic replacement violates an explicit selection.
- A planner receipt is a decision fact. Only a persisted `routing_mission_assignments` binding proves which Mission actually uses that decision.
- Tool purpose and ArtifactRef metadata do not grant Permission. Human Bridge ACCEPT uses the existing same-Run durable continuation.
- No template uploads, pushes, merges, deploys, releases, or submits research automatically. Workflow completion is delivery completion, not certification of scientific truth.

Final evidence and the sixteen release gates are recorded in [W2.4 status](status/w2-4-cross-workflow-acceptance.md).
