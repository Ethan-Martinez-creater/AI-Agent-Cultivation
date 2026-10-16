> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `9e40da6a6ed9299b367e368dff057a4354cb130cf39b96a3284462ac56c6fc91`. See the publication derivation map for both hashes and removed field categories.

# E3 reproduction and evidence review

本轮结论为 **E3_CONDITIONAL**：CR-B PASS，CR-A 因子进程身份复核异常停止，未完成恢复。以下首先给出不会再次强杀应用的离线复核命令。现有 CR-A Profile 不得再次启动或重复强杀来补成本轮 PASS；正式重做应在独立审阅后另行安排新证据链。

## Environment

- Windows x64, PowerShell 7+, Node 24.15.0, Electron 44.4.3.
- Baseline `a2551bbc9dbd87ec4701183a53a2635966326df4`.
- Existing E1-verified EXE: `out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`.
- EXE SHA-256: `8a4cdbce704b86297dfee1bc0e22c9b92fc225bdb31eda6501aa668108e4b42c`.
- app.asar SHA-256: `7deaf487916b0d0a65d723151c87658ce8e65588a37328c0add88e7ceac073b8`.
- Runtime Main SHA-256: `417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71`.
- No paid API or private key is required. All fixture/profile/cache paths use E:.

## Offline review, without application execution

```powershell
Set-Location -LiteralPath '[REPOSITORY_ROOT]'
$taskTemp = Join-Path (Get-Location) '.tmp/e3-runtime'
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
$env:npm_config_cache = Join-Path $taskTemp 'npm-cache'
$env:NODE_COMPILE_CACHE = Join-Path $taskTemp 'controller-node-cache'

node scripts/engineering-validation/e3-assertion-sensitivity.mjs
node scripts/engineering-validation/e3-evidence-audit.mjs
```

`e3-assertion-sensitivity.mjs` reads the complete original CR-B stage JSON files, checks real evidence, removes one phase to require BLOCKED, and injects ten violations into in-memory copies. It never mutates a product database. The first run exposed an assertion distinction: a provided non-ok integrity result must be FAIL rather than missing-evidence BLOCKED; that distinction was corrected. Another initial negative control changed operation verification rather than introducing the automatic resend targeted by REC-05; it was replaced with an extra target model-call event. The initial result remains in `assertion-sensitivity-initial.json`, and the final ten negative controls all pass in `assertion-sensitivity.json`.

`e3-evidence-audit.mjs` opens only derived consistency copies, verifies raw archive hashes, recomputes canonical Artifact hashes, evaluates REC-01–10, and regenerates derived summary/audit JSON. It also republishes identical raw controller text ledgers. It does not launch, restart, advance, retry, or kill an application. To verify SQLite/raw archives, retain the original `.tmp/e3-runtime` directories identified in each execution record; the textual evidence by itself is not a binary database backup.

```powershell
node scripts/engineering-validation/e3-baseline.mjs
npm run test
npm run typecheck
npx vitest run packages/application/src/w1-workflow-service.test.ts -t 'does not replay a completed Mission|waits for user action after interrupted|creates a new Step attempt'
npx eslint scripts/engineering-validation/e3-baseline.mjs scripts/engineering-validation/e3-snapshots.mjs scripts/engineering-validation/e3-packaged-controller.mjs scripts/engineering-validation/e3-invariants.mjs scripts/engineering-validation/e3-evidence-audit.mjs scripts/engineering-validation/e3-assertion-sensitivity.mjs
```

The independent checkJs command and its actual diagnostics are saved separately; application `typecheck` excludes these `.mjs` harnesses. Do not claim that application's PASS establishes semantic typing of the controller.

## Experimental controller, reference only

The controller CLI has `PROBE`, `CR_A`, and `CR_B` modes. `PROBE` verifies bootstrap observation, offline fixture setup, the workspace chooser stub and normal close, without a workflow crash. Each invocation creates new UUID-named directories and refuses fixture or stage overwrite. Formal modes perform their single planned Main kill internally after all barrier assertions pass, then restart twice; they do not read an existing case as a resumable run.

For a separately authorized future experiment, the invocation is `node scripts/engineering-validation/e3-packaged-controller.mjs CR_A` or `CR_B` from an unsandboxed approved process. This is **not** an instruction to rerun the stopped CR-A during the current review. Ordinary restricted-sandbox app launch previously produced unhealthy Chromium IPC behavior, so the actual E3 launches used the approved elevated execution environment with all application data paths explicitly isolated on E:.

Initial startup and both restarts use `--inspect-brk=127.0.0.1:<port>`. Before `Runtime.runIfWaitingForDebugger`, the independent controller arms the Workspace.writeText entry breakpoint in the verified bundle. The main PID comes from direct `spawn(..., shell:false)`, not a shell wrapper. Runtime PID/EXE/UserData/flags and OS creation ticks/EXE/command line are cross-checked. Only the public workspace chooser dialog is stubbed; workflow and approval actions use the existing preload IPC.

E1 helper locations are unchanged for the approved bundle:

| Case        | V8 location, 0-based | Evidence boundary                                                                        |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------- |
| CR-A        | 9625:7198            | S06 transaction committed; S07 READY with no Mission                                     |
| CR-B entry  | 9848:7612            | Workspace.writeText before local mutation                                                |
| CR-B return | 9848:13661           | Actual local write complete; successful ToolRuntime result/guard.after not yet committed |

Formal termination uses the scoped request literal `USER_APPROVED_E3_ONE_PLANNED_KILL` and ordinal 1. The PowerShell helper validates every original identity before Main termination, revalidates individual identities before exact-PID Stop-Process, and journals requests. After Main exits, unreadable draining children are excluded from termination and only awaited. There is no process-name kill, `/T`, fallback kill on normal-close timeout, or retry kill.

## Evidence map

| Evidence                                 | Location under this directory                |
| ---------------------------------------- | -------------------------------------------- |
| CR-A formal stopped case                 | `CR_A-64e44b53-bcc2-44c9-8d07-352fade461ac/` |
| CR-A preliminary setup failure, no kill  | `CR_A-e214746e-00ef-4703-bba7-553382c891c2/` |
| CR-B full experiment                     | `CR_B-219de96c-32de-4534-b909-7de476dcc490/` |
| Case-independent raw ledger/fact checks  | `sqlite-and-fact-audit.json`                 |
| REC assertions                           | `recovery-invariants.json`                   |
| Six-command statuses                     | `validation-command-statuses.json`           |
| Full smoke safety review                 | `full-smoke-safety-audit.json`               |
| Final isolated application process audit | `final-process-audit.json`                   |
| Baseline before experiment               | `baseline-2026-10-16T02-42-24-073Z.json`     |
| Baseline after experiment                | `baseline-2026-10-16T03-13-50-519Z.json`     |
| Sealed file hashes                       | `evidence-manifest.json`                     |

Each stage JSON contains actual raw DB/WAL/SHM source-before/source-after hashes, raw directory, consistency-copy path, process identity context, workspace file hashes, full facts and external ledger records. Raw database files remain under ignored `.tmp/e3-runtime/<case>/`; no original database is checkpointed, repaired or edited by the audit.

The raw `execution.json` files retain their original controller serialization and therefore contribute to the global formatter FAIL. Their contents have not been rewritten to improve a verification number. Global lint's pre-existing private-script errors and E1's long-path packaging failure are likewise retained.

There is no universal exactly-once claim. This experiment observes one real local uncertain write with two bounded recovery windows and controlled model responses. CR-A's missing recovery chain remains an explicit limitation.
