# G1 bounded streaming corrective evidence

Baseline: `9b6f8cbcc8056c8383d529a764a7370ae6518ab2`. This correction changes media transport/storage validation only. Migration 27, execution identity, idempotency, authority, UI scope and official W2 hashes remain frozen.

## Evidence

- `facts.json`: actual packaged SQLite Job/Artifact facts and durable Fake adapter counters for nine real process-exit/restart boundaries; unchanged official release hashes; production without Fake adapter/test Jobs; fail-closed output and Workspace permission checks.
- `screenshots/`: actual Windows packaged Generation results after recovery, including download interruption, plus model-type UI. Widths 900 and 1440.
- `validation/`: all six command outputs. Full regression runs with one worker to avoid Windows SQLite/file fixture disk contention; all tests execute and no assertion is relaxed.

## Recovery assertions

| Boundary                     | Required persisted result                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Mid-download crash           | Partial bytes greater than zero and smaller than advertised; no complete stage; zero registered Artifacts                                |
| Partial restart              | Same Task/idempotency key and Provider Job; one logical submission; two downloads total (interrupted + successful); exactly one Artifact |
| Verified stage restart       | No additional download; exact size/hash/media validation before publication                                                              |
| Committed/registered restart | Same Artifact ID; no re-download/registration; second restart leaves counters and events unchanged                                       |
| UNKNOWN                      | Zero automatic submission/download/query on restart                                                                                      |
| Mission Workspace            | FILE_WRITE remains mandatory; DENY leaves no output/Artifact                                                                             |

## Bounded-media proof

The unit command log covers a real 17 MiB PCM WAV round trip through Mission Workspace, file-backed input streaming and authorization on source reopen. Buffer allocation assertions cap storage reads at 64 KiB and reject complete-media concatenation. Synthetic seekable WAV/MP4 readers validate 32 MiB payloads without reading the payload into container metadata; descriptors above 16 MiB are accepted. Tests also cover size/hash mismatch, overflow cancellation, stalled-source cancellation, incomplete staging, corrupt Workspace staging, and input cancellation.

Application policy `g1-media-v1`: image 128 MiB, audio 1 GiB, video 4 GiB for both input and output, combined with tighter descriptor limits. Adapter source chunks are bounded to 1 MiB; Main I/O is 64 KiB; metadata is bounded to 8 MiB and 100,000 records/table entries. PNG decoded pixels are capped at 256 MiB. These are safety limits, not claims of Provider support or codec compatibility.

The packaged test adapter streams its small PNG in 8-byte chunks and advertises legal 32 MiB descriptor limits. No live Provider, codec decode, G2/G3, new dependency or migration is introduced.

## Final commands

All six pass: test (887 tests / 107 files), typecheck, lint, format:check, Windows x64 package, and the complete packaged smoke. `facts.json` records the partial boundary as 8/68 bytes with zero complete stage/Artifacts; only that boundary performs a second download. Every normal recovery has one logical submission and one Artifact. The three official package hashes are unchanged. Default tests run serially; timeouts and assertions remain intact.
