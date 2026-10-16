> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `50d832ca24c9f50e3f9270a6ae33c44de0ccbe12582eed2abe7d63b4ad64b549`. See the publication derivation map for both hashes and removed field categories.

# Workflow Crash & Recovery Case Study

AI Agent Cultivation V1 · Windows Electron / SQLite · 16 October 2026

## Outcome / 实验结论

**E3_CONDITIONAL. CR-B PASS; CR-A BLOCKED.** One official workflow was terminated after a real local file write but before its successful tool receipt. Two restarts preserved an interrupted Mission, an UNKNOWN Operation, and explicit user confirmation, with no independently observed write replay. The completed-step recovery experiment stopped at a controller identity-check failure and must not be presented as a successful end-to-end case.

## System and experiment

Baseline commit: `a2551bbc9dbd87ec4701183a53a2635966326df4`. Existing Windows x64 packaged EXE: `8a4cdbce704b86297dfee1bc0e22c9b92fc225bdb31eda6501aa668108e4b42c`. Runtime Main bundle: `417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71`. The experiment reused the E1-verified build and breakpoint helpers; it did not change production code, official workflow definitions, contracts, migrations, or frozen hashes.

An isolated TypeScript fixture supplied renderer.ts, ipc.ts, store.ts and a bounded verifier. Existing offline model flags supplied deterministic responses; actual public IPC, Mission execution, PermissionEngine, ToolRuntime, WorkflowToolGuard, filesystem mutation and SQLite persistence remained in the path. No paid provider or user profile was used.

## Why the crash window matters

The critical execution path was Workflow Step → Permission/Approval → ToolRuntime → WorkflowToolGuard → Mutation Journal → builtin file.writeText. The local write can finish before the tool result and the confirming transaction are durable. Replaying the call merely because a successful receipt is missing would risk duplicating a side effect; treating the file as success would invent a receipt that was never committed.

## CR-B: uncertain effect, explicit handover

The Main process was paused at V8 location 9848:7612 on entry to Workspace.writeText, then at 9848:13661 after the awaited write. The runtime script hash matched the approved build and raw call frames confirmed both sites. Before termination, the file hash changed from `6d1bbc70d0961794c1f755f7a9543627b6aad4dbec749693173926062d356c9b` to `22a5764d7e1083cadf86d8cec7b1d7d29c8d617116385716cff747e3b7a2b637`, while Operation and Mutation Journal remained PREPARED and the Mission/MissionRun remained RUNNING. An external controller recorded exactly one entry and one write return; there was no successful target file.writeText tool.result.

Main PID 13864 was verified by OS creation time, executable, command line and runtime profile, then forcibly terminated once. Known children exited, and the controller confirmed their original identities absent. The same profile restarted as PID 18428 and later PID 7048; both subsequently closed normally. The write observer was armed under --inspect-brk before application bootstrap on every generation, covering startup recovery rather than only the visible UI interval.

| Fact                                   | Before crash       | First restart                             | Second restart   |
| -------------------------------------- | ------------------ | ----------------------------------------- | ---------------- |
| Target Mission/MissionRun              | RUNNING            | INTERRUPTED / APP_RESTARTED               | unchanged        |
| Operation                              | PREPARED           | UNKNOWN                                   | UNKNOWN          |
| Mutation Journal                       | PREPARED           | PREPARED; no observed hash/result receipt | unchanged        |
| Workflow / S05                         | WAITING / APPROVAL | WAITING / USER_CONFIRMATION               | unchanged        |
| Step error                             | none               | EXECUTION_INTERRUPTED_RETRY_REQUIRED      | unchanged        |
| Independent write entry / return       | 1 / 1              | 1 / 1 cumulative                          | 1 / 1 cumulative |
| Model starts / tool results, whole Run | 6 / 1              | 6 / 1                                     | 6 / 1            |
| Artifacts / validations / checkpoints  | 6 / 6 / 4          | unchanged IDs and hashes                  | unchanged        |

No manual advance or retry was issued after this crash. The remaining file content was evidence of a possible side effect, not a verified operation receipt. The first-start error was recorded as observed; no extra advance was used to manufacture OPERATION_UNKNOWN.

## CR-A: honest stop instead of a fabricated success

The official workflow reached the exact post-commit S06 breakpoint at 9625:7198. S06 was COMPLETED with persisted artifacts, validation and checkpoint; S07 was READY without a Mission and the independent verifier ran once.

The single termination attempt then encountered a child-process identity mismatch. A later read-only audit found the original Main and all enumerated children absent, but the controller did not return a complete termination receipt. The user-defined stop condition therefore applied: no repeat kill, no restart, and no claimed completed-step recovery PASS. Before-crash and after-stop evidence were preserved. The likely child-exit/CIM race is an inference because the failed current identity was not captured at that instant.

The controller subsequently gained durable per-process stop records and exclusion of unreadable draining children from termination. CR-B exercised the corrected controller; CR-A was not rerun.

## Evidence and validation

Raw DB/WAL/SHM files were copied and hashed before SQLite was opened. Consistent backups were derived from a second copy; integrity and foreign-key checks never touched the original databases. Every captured consistency copy passed, raw archive hashes were rechecked, and artifact hashes were recomputed with the production canonical content-and-metadata scheme. Missing CR-A restart stages remain a coverage gap.

The full existing test suite passed 1,521 tests across 165 files. Three focused recovery tests passed, including new-attempt identity with retained artifacts on explicit retry; that retry test was offline and separate from CR-B. Application TypeScript checking and scoped script syntax/lint passed. Independent JavaScript semantic checking still reports missing dynamic harness types. Existing private-script lint and frozen-document format failures remain; package rebuilding was not run, and the full legacy smoke chain was blocked by its weaker process identity guards.

All ten REC assertions and the case-level status are machine-readable in [recovery-invariants.json](../../../../e3/recovery-invariants.json). See the [full Chinese report](v1-engineering-validation-e3.md), [source evidence](../../../../e3/result-summary.json), and [reproduction instructions](../evidence/v1-engineering-validation/e3/reproduce.md).

## What this demonstrates

The completed CR-B experiment demonstrates recovery from durable facts, isolation of an uncertain local effect, no blind startup resend within the observed windows, and explicit user control. It does **not** establish universal end-to-end exactly-once execution across third-party services. CR-A still needs a separately reviewed follow-up experiment before the overall E3 validation can pass.
