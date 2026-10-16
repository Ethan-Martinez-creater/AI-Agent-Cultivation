> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `6c13e149ff96567babfc00f0c4e1c371d566b4ecab5c88cdfae59b5ee90a07f5`. See the publication derivation map for both hashes and removed field categories.

# CR-A corrective reproduction and review

本目录是独立补充实验，不覆盖原 E3_CONDITIONAL、原 CR-A BLOCKED、原 CR-B PASS 或其断言/报告。正式实验只能使用全新 Profile/Workspace；本次授权最多一次 Main 强制终止，不能通过再次运行命令绕过一次性授权记录。

## Prerequisites and boundaries

- Windows x64, PowerShell 7+, Node 24.15.0, Electron 44.4.3.
- Frozen V1 `main@a2551bbc9dbd87ec4701183a53a2635966326df4`.
- Reuse existing `out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`.
- EXE SHA-256 `8a4cdbce704b86297dfee1bc0e22c9b92fc225bdb31eda6501aa668108e4b42c`.
- app.asar SHA-256 `7deaf487916b0d0a65d723151c87658ce8e65588a37328c0add88e7ceac073b8`.
- Main SHA-256 `417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71`.
- No real provider calls, keys, production profile, workflow mutation, manual database edits, commit or push.

```powershell
Set-Location -LiteralPath '[REPOSITORY_ROOT]'
$taskTemp = Join-Path (Get-Location) '.tmp/e3-corrective-runtime'
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
$env:npm_config_cache = Join-Path $taskTemp 'npm-cache'
$env:NODE_COMPILE_CACHE = Join-Path $taskTemp 'node-cache'
```

## Non-destructive checks

```powershell
pwsh -NoProfile -File scripts/engineering-validation/e3-corrective/process-policy.tests.ps1 -OutputPath (Join-Path (Get-Location) 'docs/evidence/v1-engineering-validation/e3/cr-a-corrective/controller-policy-tests-review.json')
node scripts/engineering-validation/e3-corrective/adapter-sensitivity.mjs
node node_modules/typescript/bin/tsc -p scripts/engineering-validation/e3-corrective/tsconfig.json
npm run typecheck
npm run test
npx vitest run packages/application/src/w1-workflow-service.test.ts -t 'does not replay a completed Mission|waits for user action after interrupted|creates a new Step attempt'
```

Policy tests use in-memory identities and never terminate a process. They distinguish EXITED, exact MATCHED, unreadable UNKNOWN/WAIT_ONLY, mismatched EXE/complete command, PID_REUSED, natural child disappearance after Main exit, and persistent unknown identities. The real process helper uses the same disposition policy and bounded OS observations; exceptions preserve both expected and current identity fields.

The adapter sensitivity script uses pure in-memory snapshot fixtures. It tests legal new Mission assignment only after explicit continue, completed-Step immutability, no unauthorized attempts, no startup assignment/model event, new fact lineage, Mission freshness and missing-phase blocking. It also checks that the one known legacy identity-projection mismatch can be accepted only when the stricter new identity rule passes, while unrelated legacy FAIL results remain FAIL. Mock sensitivity cases are not packaged recovery results.

## Application execution

The following describes the executed interface, not authorization for another formal kill after this corrective case. Repeating the formal experiment requires a new independent approval and evidence chain; do not delete or bypass the authorization-used file.

- Noncrash interface: `node scripts/engineering-validation/e3-corrective/controller.mjs PROBE`.
- Formal interface: `node scripts/engineering-validation/e3-corrective/controller.mjs CR_A_CORRECTIVE`.
- CR_B is refused by this controller. Old `.tmp/e3-runtime` profiles are refused by the new process helper.
- All new data lives in `.tmp/e3-corrective-runtime/<new-token>/`, with textual evidence in this directory's matching `<new-token>/`.
- Approved elevated execution is needed for healthy packaged-app startup and CIM identity queries on this machine. Ordinary restricted-sandbox launch was previously unhealthy; the baseline has not been rebuilt to hide that environment issue.

Node Inspector starts with `--inspect-brk` so the independent write observer is armed before bootstrap/recovery. Chromium CDP connects to the same actual EXE. Public workflow/approval IPC and the E1-approved workspace chooser test dialog are used; no business state is changed through Inspector evaluation. The S06 post-transaction breakpoint is derived from the verified runtime source and resolves to V8 **9625:7198**, not a SQLite polling result.

Before the single Main stop, the controller records its own source and safety helper hashes, spawn record, runtime PID/EXE/UserData/fixture flags, OS creation time, exact command line, and the full BeforeCrash facts. S06 completion, artifact, validation, checkpoint, S07 READY without Mission and verifier ENTRY/COMPLETED=1 are mandatory.

The safety helper consumes an exclusive one-use file at `.tmp/e3-corrective-runtime/formal-authorization-used.json`. It revalidates Main against the original startup observation and complete controller/runtime records. Known children are rechecked individually: exited children receive EXITED; unreadable children are only bounded-waited; identity mismatch/PID reuse blocks without termination. Every request, actual identity, decision and stop result is durably journaled. There is no global process-name kill, `/T`, repeat kill, or fallback kill on normal-close timeout.

The first restart is captured as **FirstRestartBeforeContinue**. Old completed identities, artifacts/validations/checkpoints, completed-Mission model/tool facts, and independent verifier records are checked before any explicit continue request. Legal later steps may create their own model/Mission/tool facts. SecondRestart is compared with ExplicitContinue; it must not add new business facts.

## Offline evidence evaluation

After retaining the matching raw `.tmp/e3-corrective-runtime` directory, run:

```powershell
# Supply the actual CR_A_CORRECTIVE-<uuid> directory name, not a historical token.
node scripts/engineering-validation/e3-corrective/evidence-audit.mjs 'CR_A_CORRECTIVE-<actual-uuid>'
```

This is a derived-analysis command; it never launches or terminates an app. It reads the full original five-stage JSON, verifies raw SQLite/WAL/SHM hashes, opens only consistency copies for integrity/FK checks, recomputes canonical Artifact hashes, and writes new corrective analysis. Historical CR-B is read only and is not rerun.

The unchanged sealed evaluator is preserved in `legacyDiagnostic`. The new REC-01 handles the specific legitimate null-to-new-Mission binding on an existing unfinished StepRun after explicit continue, while preserving Run/version/StepRun/attempt and every completed identity. New REC-02/03 strengthen completed event and new-fact lineage checks. The old evaluator's actual FAIL/PASS outputs remain visible rather than being rewritten.

CR-B REC-09 wording is corrected only in the new combined report: its stable confirmation wait is compared between **FirstRestart** and **SecondRestart**. CR-B never performed explicit continuation. The historical `Final continuation` text remains unchanged in its raw assertion output.

Raw DB/WAL/SHM are sealed before any SQLite open. A separate consistency seed produces the queried backup; original databases are never checkpointed, repaired, or edited. Missing WAL/SHM files are recorded as absent, not invented. Old evidence, frozen documents and raw JSON are not reformatted to improve global quality-check numbers.
