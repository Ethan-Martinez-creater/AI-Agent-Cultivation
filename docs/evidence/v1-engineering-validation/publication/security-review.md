# Publication safety and integrity review

Scope: 214 E0/E1/E3 original text files, published as 101 original-byte files and 113 **DERIVED/REDACTED** counterparts. Additional publication indexes, audit receipts, frozen byte extracts, scoped Git attributes and the new read-only verifier are reviewed separately before staging. This is a safety review of this archive, not a universal guarantee of absence of secrets.

The explicit allowlist and publication manifest identify every counterpart. Automated checks cover private-key blocks, known GitHub/provider token formats, JWTs, personal home/repository paths, full inherited environment dumps, machine identity fields, binary NUL bytes and JSON parseability. The 214 counterparts have zero matches under these checks; 115 JSON files parse successfully. Independent read-only reviews separately examined E0/E1 semantics, E3 failure/recovery history, and privacy context.

Credential-like values retained in source/evidence are documented synthetic loopback test API keys and literal one-use experiment authorization sentinels, not account credentials or authentication headers. Generic E-drive policy regular expressions and `E:\isolated` / `E:\other.exe` policy-test fixtures are synthetic. No real Provider request, private memory export, user profile directory, raw database, packaged binary or unrelated workspace file is selected.

Redaction is confined to new publication copies:

- Machine-specific roots become stable placeholders, preserving cross-file profile identity, PID/creation-time associations and command structure needed for process ownership review.
- Full inherited environment dumps in the historical package log are omitted as complete lines; adjacent build diagnostics and the actual failure remain. Environment dumps are not reconstructed from an allowlist of guessed safe values.
- Unrelated worktree inventory arrays are replaced with a marked summary, original/omitted counts and retained in-scope entries.
- Nonfrozen Markdown is published as a labeled reader copy with relative links rebased to published counterparts. Local-only dependency references are delinked and labeled. Statuses, evidence identities, timestamps, counters and failure text are retained.
- Original local files remain byte-identical. The publication map records both SHA-256 values and byte counts. Original manifest hashes apply only to originals, not to redacted counterparts.

The frozen E0 v0.2 document and its canonical Dataset/ToolFixtureMapping are preserved with their approved hashes. It contains a historical link to the unpublished, unredacted E1 feasibility original. That one frozen navigation link is retained unchanged; the archive index provides the published redacted E1 target. All other reviewed links between archived reports resolve to published files or unchanged baseline source. This historical exception does not change the frozen design or its hash.

Original SQLite/WAL/SHM, isolated profiles, EXE/app.asar, ignored temporary build/runtime directories and unrelated untracked files remain local. Public snapshots, ledger/event records, integrity results, file hashes and assertive checks allow documentary review. Public readers cannot recompute unpublished raw database bytes. No application or provider was run to manufacture missing evidence during publication.

Failure history remains visible: original CR-A BLOCKED; historical E3_CONDITIONAL; old REC-01 legacyDiagnostic FAIL; initial REC-03 analyzer FAIL and its schema correction; old CR-B REC-09 wording and corrected interpretation; REC-08's independent offline-test origin. Global lint/format failures and package/smoke limitations remain in the reports.

`docs/.gitattributes` and `scripts/engineering-validation/.gitattributes` preserve archived bytes across Windows checkout conversion. No frozen documentation, original JSON or executed controller source is formatted. No production logic, migration, workflow definition, main ref, original evidence or unrelated user file is changed.
