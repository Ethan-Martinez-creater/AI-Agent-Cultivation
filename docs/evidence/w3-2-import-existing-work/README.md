# W3.2 Import Existing Work evidence

Frozen baseline: `d106185de21b4a4e988b03e08d69d7f4d0e84cf3`. Only migration `0032_w32_workflow_import.sql` is appended. No new dependency.

## Evidence layout

- `packaged/acceptance.json`: Windows packaged A–K assertions, source limits, user confirmation, immutable version, real REVIEW/Mission continuation, restart, authority and official hashes.
- `packaged/rawfacts.json`: controlled offline fixture SQLite facts. Imported artifacts have null Mission/Run/actor; subsequent execution has real Mission/Run/Usage/Audit.
- `packaged/*.png`: actual packaged Renderer at nominal 1440 / 1180 / 900 window widths. Windows DPI rounding gives a 902 CSS pixel viewport at nominal 900; recorded viewport/document widths verify no horizontal overflow.
- `validation/`: the final successful six original command logs and affected regression.
- `acceptance.json`: final validation summary and migration compatibility.
- `build-source-manifest.json`: 505 delivery/build input hashes, checked against the physical native-ABI build mirror.
- `compatibility/w31-packaged-facts.json`: this round's W3.1 packaged regression; previously approved screenshots are preserved.

Final original six commands all passed. Full test: 153 files / 1375 tests. Affected regression: 78 files / 774 tests. The complete smoke includes Gate 0–6, R0–R5, W1/W2, G1–G3, W3.1 and W3.2. No new dependency; only 0032 is appended. H3 live integration remains unrun because no live endpoint is configured.

## What is proven

Confirmation commits one new Run, imported prefix, validation receipts, dependency/output bindings and checkpoints in one transaction. Repeated confirmation returns the same Run. A hard process exit after the first imported Artifact insertion rolls back all partial formal facts; restarting restores the unconfirmed proposal, not an execution. A later explicit confirmation commits it once.

Two imported TEXT steps continue through an actual structured REVIEW and final TASK using W1 → R4 → Mission. Imported content remains untrusted data, does not grant permission, and does not fabricate ModelCall/Usage/Experience or Human Bridge acceptance. Confirming and cancelling are separate explicit UI operations. Completed restart preserves facts; interrupted execution retains the original Mission/Run without a new model call.

Sources are selected by the Main native picker and read through existing ToolRuntime authority. Canonical Workspace, symlink escape, size, UTF-8/JSON, content hash and modification time are checked and rechecked. Renderer cannot provide source paths/body, write official state or grant permissions. All packaged data is synthetic and offline; no API keys or live private files are included.

## Deliberate limits

The resolver is deterministic and supports user mapping; no online AI resolver. Import is limited to bounded Workspace TEXT/JSON snapshots and a continuous safe TASK prefix. REVIEW/DECISION/effects/generation cannot be imported as executed. Official import is restricted to research v1 R01 brief; unsupported official complex graphs are explicitly rejected. Directory/binary/recursive project import is not implemented. Per-file 64 KiB, 16-source and 32-prefix limits are enforced; packaged evidence directly exercises the byte boundary and two sources, not the maximum count.

Original side-effect UNKNOWN recovery remains unchanged. Import never creates an Operation Receipt or permits replay. Existing frozen package hashes and old EXECUTED completion guards remain authoritative.
