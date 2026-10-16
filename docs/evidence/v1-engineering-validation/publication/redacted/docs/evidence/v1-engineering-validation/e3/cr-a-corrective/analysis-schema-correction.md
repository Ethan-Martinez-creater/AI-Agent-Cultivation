> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `5e4d203131328b3f7d359f3e37c1d1b9fb7c111989e56486817c766b859ae46f`. See the publication derivation map for both hashes and removed field categories.

# Corrective analysis schema correction

The actual formal experiment completed all five stages on its only approved application instance. The first offline analysis returned REC-03 FAIL because the **new analysis adapter** tried to locate a Run final-validation receipt through singular `artifact_id` / `output_artifact_id` fields. Those fields do not exist in the production `workflow_run_output_validations` schema.

The first failed analysis remains unchanged in:

- `analysis-history/recovery-invariants-corrective.json.b004e999-dfab-4ec6-8a2b-cd6eb8530a40.json`
- `analysis-history/result-summary.json.b8bd8369-e434-49b7-990d-622fea4fdff4.json`

Production evidence:

- `migrations/0018_w1_workflow_io.sql:24` defines this as a **Run-level** table, with `workflow_run_id`, `definition_version` and `output_bindings_json`.
- `packages/persistence/src/w1-workflow.ts:961`, `appendFinalValidation`, persists the final binding array rather than a single-Step Artifact reference.
- Actual receipt `a2840c08-4049-42a6-8af3-5f15a7c73ea1` belongs to Run `bda77f9a-ee99-44bf-8cd4-0892e72c5b1f`, version 1, valid=1, errors=[]; its seven output bindings include preserved early outputs and the newly produced review/delivery outputs.

The adapter now checks the actual schema. It accepts a new final aggregate only after explicit continuation, on the same completed Run/version, with no validation errors, unique nonempty binding keys, existing same-Run Artifacts, exact content Hash matches and actual OUTPUT bindings. At least one bound Artifact must come from an originally unfinished StepRun that executed after the user's explicit continuation. Earlier Artifact/Validation/Checkpoint rows still must remain unchanged; first and second startup windows still cannot add rows.

Seven additional in-memory negative controls reject a different Run, wrong version, validation errors, missing Artifact, wrong Hash, an old-output-only aggregate, and duplicate binding keys. The positive case models the real aggregate structure. Semantic type checking, syntax, scoped lint and sensitivity tests were rerun after this analyzer correction.

No application was relaunched, advanced, retried, or forcibly terminated after the formal five-stage experiment. No product code, original Snapshot, SQLite business row, historical assertion, CR-B evidence or historical report was changed. This is an explicitly recorded analysis-tool schema correction, not a recovery retry or a relaxed production invariant.
