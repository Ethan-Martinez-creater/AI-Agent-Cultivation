# R5.3 offline Memory Rerank evidence

Baseline: `36ac835283b29a05b3e2d7b492511bdbfbf707c0`.

Evidence records bounded IDs/hashes/ranks/counts, not Memory/query/Prompt bodies. Live Jev is NOT RUN. FakeDecisionGateway is enabled only under explicit acceptance flags; normal production is checked separately.

## Final acceptance

- `acceptance.json`: exact six original commands, 132 files / 1133 tests, policy budgets and regression index.
- `validation/{test,typecheck,lint,format-check,package,smoke-package}.txt`: final command logs. Full smoke retains all prior stages; no temporary arguments or NODE_OPTIONS preload.
- `2368706c-d4c7-44e3-8e95-ca97de284333/facts.json`: authoritative final full-smoke facts, candidate/baseline/reranked/selected IDs, actual actor and final Prompt Memory IDs. Other local focused-run directories are diagnostic and not the authoritative run.
- `final-packaged-facts.json`: bounded summary: 8 Jev calls, 3 fallbacks, 11 retrievals, 9 LANGUAGE calls, Memory rows 13 → 13, extractor calls 0.
- `deterministic-baseline.json`: approved lexical/vector fusion golden order and Cloud-off equality.
- `skill-regression.json`, `memory-pre-gate-regression.json`, `generation-regression.json`: same full command's R5.1/R5.2/G1–G3 compatibility facts. Original older-stage run paths remain in the command log; bounded copies are archived here.
- `frozen-hashes.json`: actual packaged SQLite release/version hashes compared with approved baseline, all three OFFICIAL v1 unchanged.
- `build-provenance.json`: project-local physical dependency build isolation and source/build hash equality, including the exact tested app.asar hash.

The final run's three `routing-privacy-{1440,1180,900}.png` captures are real Windows packaged screenshots. Sizes are Electron DIP; Windows 125% DPI produces 1800/1475/1125 pixel widths. Privacy disclosure is the only Renderer copy change; no layout or config authority change.

## Safety and reproduction

Run the six standard npm commands from the repository. `smoke:package` runs the full chain serially and invokes the R5.3 script with explicit test flags. Production launch does not expose the observer, Main-only retrieval seam or Renderer acceptance IPC. Fake results are offline evidence, not live Jev evidence.

Owner/ACTIVE/expiry filtering precedes Jev. Final scoped records are reread after await; PromptComposer retains its independent check and default 5/4000-character limit. Party cloud query contains only the objective, while local lexical/vector query preserves the frozen behavior. REQUEST fields contain only bounded query and owned candidate ID/type/summary or redacted excerpt.

Earlier navigation-selector, privacy-assertion and lint-helper failure logs, plus the smoke intentionally interrupted for the Party query fix, remain under `validation/`. Final PASS is from a new complete `npm run smoke:package`, not an interrupted run. Test/build temporary data stays within the project; no bulk deletion was performed.

No migration or dependency is added. The only UI change is an accurate disclosure of bounded Memory summaries/excerpts in the existing Cloud privacy section; it grants no execution authority.
