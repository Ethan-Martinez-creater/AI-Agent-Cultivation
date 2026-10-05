# G1 Windows packaged acceptance

Baseline: `174df7968921234640beb7b5bdc0aded014533ab`. Evidence is generated offline from the actual Windows x64 packaged Electron application. The explicit test-only FakeGenerationGateway uses durable adapter mappings. Normal production starts without a generation adapter or test Job.

## Evidence map

- `facts.json`: SQLite Job/Artifact facts, adapter counters, crash boundaries, fail-closed results, Workspace grants/denials and frozen official package hashes.
- `artifact-store-output.png`: the actual first recovered APP_ARTIFACT_STORE output; SHA-256 matches `facts.json` (`5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15`).
- `screenshots/`: packaged Runtime creation/detail, generation teammate presentation and recovered Generation Job result cards.
- `validation/`: the six required command outputs, retained as UTF-8 text.

## Acceptance matrix

| Requirement                                  | Verification                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Runtime identity                    | Full legacy migration and LANGUAGE regression; generation Runtime creation/sealing in packaged UI                                             |
| Feature / input eligibility                  | Unsupported feature, role, MIME, input count/size and immutable registered input hash tests; strict typed IPC rejects authority/path spoofing |
| State authority                              | Domain machine, persistence CAS, immutable snapshots and terminal output guards                                                               |
| Idempotency                                  | Same key/body resolves the original Provider Job; changed fingerprint/body conflicts                                                          |
| A: before submission                         | Real Main process exit; original PENDING task completes once after restart                                                                    |
| B: submission response uncertain             | Same task/key resolves durable adapter mapping; genuinely uncertain adapter stays UNKNOWN with zero restart activity                          |
| C: Provider identity durable                 | Restart queries the original Job                                                                                                              |
| D: Provider completed before download        | Software remains incomplete until validated storage and Artifact registration finish                                                          |
| E: staging / committed bytes                 | Existing validated output is reused, not downloaded or generated again                                                                        |
| F: Artifact registered before Job completion | Original Artifact is verified and the exact persisted manifest completes once                                                                 |
| Artifact Store                               | Real canonical APP_ARTIFACT_STORE file hash matches registered Artifact; invalid MIME/hash/missing output cannot complete                     |
| Mission Workspace                            | Actual FILE_WRITE grant permits safe commit; DENY leaves no file or Artifact                                                                  |
| Security boundary                            | Renderer cannot choose filesystem destination, actor, Mission authority, bytes or formal Job state                                            |
| Product scope                                | Basic model-type/Job/result views; generation teammate opens Jobs rather than ordinary Chat/Availability                                      |
| Compatibility                                | Gate 0–6, R0–R4 and W1/W2 packaged regressions; all three frozen official v1 hashes unchanged                                                 |

Each recovered normal task has one logical Provider submission, one download and one registered Artifact. A second restart leaves adapter counters and durable generation events unchanged. Test processes are started sequentially and the actual Main PID is terminated for crash cases; finalizers close the active test window.

## Limits

G1 does not contain a production generation Provider, H3 integration, generation Chat, collaboration integration or automatic UNKNOWN retry. Input resolution currently accepts already registered Generation Artifacts. Media validation is bounded: PNG pixels, PCM WAV, and a narrow self-contained non-fragmented AVC/AAC MP4 container subset. MP4 validation does not decode samples or certify playback. Hard-link publication requires supported same-volume filesystem semantics and fails closed otherwise. No new dependency is introduced.
