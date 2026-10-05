# G1 — Generation Foundation

Baseline: `174df7968921234640beb7b5bdc0aded014533ab`. Specification: Generative Model Execution Software Spec v0.2. Scope is G1 only; no real generation Provider, generation Chat or collaboration integration.

## Execution identity

`MODEL_RUNTIME` remains the ordinary teammate kind. `executionProtocol` distinguishes LANGUAGE and GENERATION. The protocol belongs to the immutable Runtime and sealed ModelBinding identity; old Runtime rows default to LANGUAGE. Connection verification and cloning preserve the protocol snapshot. Generation models cannot enter the Language ModelGateway or current R4/Mission execution chain.

Production has an unconfigured GenerationGateway and loads no active Fake provider. The explicit `--g1-fake-generation` packaged-test mode uses a durable deterministic adapter. Its descriptor is provider-neutral; no provider SDK types enter domain/application.

## Contracts and persistence

GenerationTask freezes capability, required Features, prompt, trusted Artifact bindings, parameters, output expectation, destination and execution context. Capability and Features remain separate. Feature/role/parameter/type/size validation runs before submission. Input references resolve from Main-owned registered Artifact facts, with byte hash verification; they create no File permission.

`0027_g1_generation_foundation.sql` is append-only. Historical migrations and all three official W2 packages remain untouched. Generation Jobs use a domain state machine, SQLite state/identity/terminal-output defenses, CAS and append-only output/event facts. Adapter idempotency key is exactly GenerationTask.id. Same key/request returns the same provider identity; changed request conflicts. Audit facts contain bounded identity/state/error information, not prompt, credentials, source bytes or CoT.

## Output and recovery

Gateway binary source → Main streamed staging → canonical boundary → media/size/metadata/hash validation → safe atomic commit → immutable Artifact registration → persisted output IDs → COMPLETED.

Provider completion is recorded independently of software completion. A provider-completed Job stays unfinished until the actual bytes pass validation and the exact Artifact manifest is durable. PNG validation includes bounded decompression and pixel row/filter structure; PCM WAV validates the media layout; MP4 validates bounded self-contained non-fragmented AVC/AAC container metadata, timelines, sample tables and ranges inside nonempty media payload. Header-only, truncated, unsupported or conflicting provider metadata fails closed. MP4 validation does not decode samples or claim playback quality.

Standalone IPC uses APP_ARTIFACT_STORE. MISSION_WORKSPACE is a trusted Main-only context requiring the original Mission/Run, explicit output binding and PermissionEngine authorization; Renderer cannot supply paths or grant authority. Workspace root is frozen locally and rechecked. Provider sees no software storage path.

| Crash boundary                       | Recovery                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| A: PENDING before submit             | Continue the same Task/key                                                                                                     |
| B: submit sent, response not durable | Resolve the original logical submission through the adapter with the same key/fingerprint; adapter uncertainty becomes UNKNOWN |
| C: providerJobId persisted           | Query original Provider Job                                                                                                    |
| D: provider complete, no download    | Download and safely validate original output                                                                                   |
| E: validated staging exists          | Verify and reuse staging; no repeat download                                                                                   |
| committed file, registration pending | Verify and reuse committed file                                                                                                |
| F: Artifact registered, Job pending  | Verify exact registered output, finish Job transaction                                                                         |
| COMPLETED/UNKNOWN restart            | Zero automatic generation/Artifact replay                                                                                      |

## Product boundary

Runtime creation/detail uses 文本模型 / 生成模型. A basic Generation Jobs view provides status and result cards, with IDs/hashes in Advanced. No generation Chat UX, Provider-specific UI, G2/H3, G3, R5, W3 or Workflow package changes.

Generation teammates use the job viewer rather than the LANGUAGE Chat/Mission actions. Their UI does not expose the LANGUAGE Availability recheck; LANGUAGE Availability rules remain unchanged.

## Frozen W2 identities

The production bootstrap still installs the same three OFFICIAL v1 packages. Packaged verification reads these hashes directly from the persisted release/version facts:

| Package                       | Manifest hash                                                      | Version content hash                                               |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `official.ai-news-video@1`    | `ae37a04bf0156c42adea41d8d0418de2f942d6dc677803727af7db41ab36e4cd` | `4763d276b85362096db1085ebc458c76ea731c243d72df6069da302ca75ce153` |
| `official.software-feature@1` | `30eb30ce957ef3bad798d1046bd45835322b645d97e49ca5affcac4e16cd348d` | `a5a9982824db796dc4843d68558b4874067d551eff878132c78c94e881e2ea5a` |
| `official.research@1`         | `199c675c91c1c7d15709141be9a7dc6ce1e776f3c1b0af7c66c2ff9e1f3b03d3` | `b264c0448470b12473c0e39f21cf7e1c40c1d9b4b6e1c945f9ffb5ccc2a305b7` |

## Scope limits

- Production has no generation adapter in G1. GENERATION templates can be configured, but verification/sealing requires an installed adapter; only explicit packaged/unit test mode loads FakeGenerationGateway. No real API is called.
- Input resolution currently accepts registered Generation Artifacts. It does not import arbitrary paths or grant Workspace read authority.
- Safe publication uses a same-volume hard link with no overwrite. A filesystem without the required atomic publication support fails closed.
- Media input/output byte counts use centralized category ceilings and tighter descriptor limits; at most 16 inputs / 8 outputs. The packaged fixture uses PNG; no codec execution or video generation Provider is added.
- UNKNOWN stays terminal for automatic recovery. A changed request requires a new explicit Task, never an automatic replay of the uncertain one.

## Initial G1 verification (before streaming correction)

Final verification on Windows, 2026-10-05:

| Command                 | Result                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `npm run test`          | PASS: 874 tests / 105 files (817 W2 baseline + 57 added tests) |
| `npm run typecheck`     | PASS                                                           |
| `npm run lint`          | PASS                                                           |
| `npm run format:check`  | PASS                                                           |
| `npm run package`       | PASS: Windows x64, Electron 44.4.3, native SQLite packaged     |
| `npm run smoke:package` | PASS: Gate 0–6, R0–R4, W1/W2, all official workflows and G1    |

Committed evidence is in `docs/evidence/g1-generation-foundation/`: six command logs, `facts.json`, and 11 actual packaged screenshots (900/1440 widths). All eight crash boundaries finish with one logical submission, one download and one Artifact; the second restart leaves counters/events unchanged. UNKNOWN restart records zero submissions/downloads/queries. APP_ARTIFACT_STORE and MISSION_WORKSPACE hashes match registered output facts; Workspace DENY produces no output. Normal production has migration 27 and zero test Jobs. Runtime creation and generation teammate navigation are tested through Renderer UI; generation teammates show no ordinary Chat action or LANGUAGE Availability recheck.

Test concurrency is bounded to four workers to avoid simultaneous SQLite fixture disk contention; no assertion or test is skipped. No historical migration or official package was changed. Packaged evidence verifies all three release/content hashes against the frozen baseline.

Packaged crash tests run sequentially. They terminate the actual Electron Main PID rather than Playwright's launcher wrapper and close the active application in a finalizer on test failure. This fixes the leftover test windows observed during the first recovery run.

No dependency has been added. Real Provider integration and media adapters beyond the supported validated foundation formats remain G2/future work.

## Final G1 corrective: bounded media I/O

Corrective baseline: `9b6f8cbcc8056c8383d529a764a7370ae6518ab2`. No new migration; 0001–0027 and the three W2 frozen packages remain unchanged.

`GenerationBinarySource` exposes `open(signal): AsyncIterable<Uint8Array>` and `cancel()`. `downloadOutput()` returns that controlled source, never a software destination or a whole-media byte array. `GenerationResolvedInput` carries Artifact identity, role, kind, MIME, hash, size and a Main-controlled source. Opening an input rechecks canonical identity, registered metadata/hash and the consumer's FILE_READ authority; a reference creates no permission. Input preflight accepts a cancellation signal.

Main writes chunks directly into a run/output-scoped `.stage.partial`, enforces descriptor/application limits while receiving bytes, hashes incrementally, checks exact advertised size/hash, and validates media through a seekable file reader. Only a completely verified file obtains `.stage` identity. Source overflow, abort or failure cancels the source and leaves no registered Artifact. Provider completion alone remains insufficient.

The versioned `GENERATION_MEDIA_POLICY` (`g1-media-v1`) is the unique safety configuration:

| Category | Input ceiling | Output ceiling |
| -------- | ------------- | -------------- |
| Image    | 128 MiB       | 128 MiB        |
| Audio    | 1 GiB         | 1 GiB          |
| Video    | 4 GiB         | 4 GiB          |

Descriptor aggregate input/output limits still apply. Main file I/O uses 64 KiB chunks; adapter chunks above 1 MiB are rejected. Container metadata is bounded to 8 MiB and 100,000 records/table entries. PNG decompression is streamed with a 256 MiB decoded-pixel ceiling; WAV validates headers/layout and skips PCM payload; MP4 seeks past `mdat` and loads only bounded container metadata. No complete-media Buffer allocation is used in production storage/validation. The only whole-file helper is explicitly restricted to Main's 16 KiB Workspace binding JSON.

Partial staging is never treated as complete. Restart downloads the original Provider output again without creating another logical generation. Verified staging and committed outputs are checked and reused without download or Artifact duplication; Workspace staging is validated before final publication. UNKNOWN continues to perform zero automatic submissions. Existing idempotency keys, request fingerprints, state transitions and FILE_WRITE authority are preserved.

Corrective evidence and final verification are recorded under `docs/evidence/g1-generation-foundation/streaming-corrective/`. Tests exercise a real 17 MiB Workspace WAV with bounded allocations and read/write permission checks, synthetic 32 MiB WAV/MP4 readers, descriptor limits above 16 MiB, size/hash failures, overflow cancellation, stalled-source cancellation, partial recovery, verified-stage reuse and corrupted Workspace staging rejection. No production Provider, G2/G3 or dependency is added.

### Corrective final verification — Windows, 2026-10-05

| Command                 | Result                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| `npm run test`          | PASS: 887 tests / 107 files                                            |
| `npm run typecheck`     | PASS                                                                   |
| `npm run lint`          | PASS                                                                   |
| `npm run format:check`  | PASS                                                                   |
| `npm run package`       | PASS: Windows x64 / Electron 44.4.3 / native SQLite                    |
| `npm run smoke:package` | PASS: full Gate/R/W regression plus nine G1 process-exit/restart cases |

The default test configuration now runs files serially. The initial four-worker run had two Windows disk-contention timeouts (R0 migration and G1 file recovery); serial verification passes without changing timeouts, assertions or test coverage. The default `npm run test` was run again and passes all 887 tests.

Packaged partial-download facts: 8 bytes of 68 received, no complete stage, zero Artifacts before exit; restart finishes the original Provider Job with one logical submission, two total downloads (interrupted and successful), and one Artifact. Validated stage, committed file and registered Artifact boundaries have zero additional downloads. A second restart changes no counters/events. UNKNOWN remains zero automatic submission/download/query. The twelve screenshots and SQLite facts are committed in the corrective archive with all six logs; all three W2 release/version hashes still match the frozen baseline.
