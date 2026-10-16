# E0/E1/E3 public archive

This directory is a publication layer over locally retained, sealed evidence. It does not replace those originals or change their experiment outcomes. E0/E1 and E3 are archived in separate commits on `engineering-validation/v1`; `main` remains frozen.

- `e0/` contains exact byte extracts of the frozen canonical dataset and ToolFixtureMapping. No trailing newline was added. Gold is **PROVISIONAL / INDEPENDENT_REVIEW_PENDING**.
- `e0-e1-publication-manifest.json` maps the 75 E0/E1 originals to their public counterparts. `publication-manifest.json` adds the complete 214-file E0/E1/E3 map.
- `redacted/` contains **DERIVED/REDACTED** public copies. JSON objects carry a publication marker; Markdown carries a banner. NDJSON/text are classified by their path and map. Each entry records the original SHA-256, public SHA-256, byte counts, and removed field categories.
- Original manifests describe original bytes. A redacted public file is checked against its **public** hash, never claimed to match an original hash. Original identities, statuses, counters, timestamps, failure records, and assertion results remain available for cross-file review.
- Machine-specific roots use stable placeholders. Full inherited environment dumps and unrelated worktree inventory entries are omitted. Reader Markdown links are rebased to published counterparts. Local dependency references are labeled local-only.
- Original SQLite databases, WAL/SHM, isolated profiles, application binaries, packaged archives, private workspace content, credentials, unrelated untracked files and scratch data are excluded. Original database hashes and JSON reconciliations are public; recomputing those database hashes requires the locally retained database files.

Start with the [engineering validation index](../../../status/v1-engineering-validation-index.md). On the completed archive, run `node scripts/engineering-validation/publication-verify.mjs` from the repository root for read-only public/hash-map verification. This command does not start the application, rerun an experiment, contact a provider, or grant permission for another process termination.

Frozen E0 v0.2 retains its historical link to the local original E1 feasibility report; that original is not published because it contains local paths. Use the index and publication map to open the redacted E1 report. Frozen Markdown is not rewritten to repair this historical link.

E2 is **NOT_RUN / NOT_AUTHORIZED**. E1 has two BLOCKED gates. E3 is report-level PASS pending final review of this archived evidence. Global lint/format failures and historical package/smoke limitations are retained; this archive does not declare all standard commands green.
