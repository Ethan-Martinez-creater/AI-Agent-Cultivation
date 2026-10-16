> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `ddb5c01d8f5df15b53faf07a44d4b1ec4b4e5b53360444d344b733aa78a9e689`. See the publication derivation map for both hashes and removed field categories.

# V1 E3 final combined validation

**E3_PASS — submitted for independent review.**

| Evidence chain      | Result  | Boundary                                                                                                           |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Original CR-A       | BLOCKED | Preserved; no old-profile restart or repeat kill                                                                   |
| Original CR-B       | PASS    | Historical evidence only; not rerun                                                                                |
| New CR-A corrective | PASS    | New Run bda77f9a-ee99-44bf-8cd4-0892e72c5b1f; one Main kill, first recovery, explicit continuation, second restart |

- E3_CR_A_CORRECTIVE: **PASS**
- E3_CR_B_HISTORICAL: **PASS**
- E3_RECOVERY_INVARIANTS: **PASS**
- E3_REPRODUCIBILITY: **PASS**
- E3_SQLITE_INTEGRITY: **PASS**
- E3_BASELINE_PRESERVATION: **PASS**

The original [E3 report](v1-engineering-validation-e3.md) and [case study](workflow-crash-recovery-case-study.md) remain unchanged as the historical E3_CONDITIONAL record. See the independent [CR-A corrective report](v1-engineering-validation-e3-cr-a-corrective.md) and [new combined case study](workflow-crash-recovery-case-study-final.md) for the completed coverage.

CR-B REC-09 means **FirstRestart versus SecondRestart**, with stable USER_CONFIRMATION and no explicit continuation. The old wording remains visible in historical raw assertion output; it has not been silently rewritten.

New Controller strict type checking, separate audit/adapter type checking, syntax/lint, policy/sensitivity tests, 1,521 application tests and focused recovery tests passed. Global private-script lint and historical/raw-evidence formatter failures remain; no packaging rerun or full extra-crash smoke chain was claimed. No production logic, frozen workflow/migration, historical untracked file, commit or push was changed.

Machine-readable evidence: [corrective result summary](../../../../e3/cr-a-corrective/result-summary.json).

The final formatter also flags the new controller, snapshot helper and type declarations; their executed bytes were retained, and this style debt is recorded in the corrective report. No global format PASS is claimed.
