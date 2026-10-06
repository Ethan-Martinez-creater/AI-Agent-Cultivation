# G2 corrective acceptance

This evidence uses the production H3 HTTP adapter against an offline deterministic HTTP server.
Live Integration: **BLOCKED / NOT RUN**; no deployment endpoint has been supplied.

## Submission and recovery boundaries

- The immutable user message, input identities and parameters are the only chat preparation intent.
- Startup recovers unbound preparations once, before normal GenerationJob recovery. Automatic chat polling does not repeat preparation.
- A SQL guard rejects a second Job for the same message. Creation is transactional, so the losing attempt leaves no extra GenerationTask.
- Stable preparation errors are terminal. COMPLETED and UNKNOWN Jobs are not replaced.
- Provider-neutral `GenerationSubmission` distinguishes SUBMITTED, REJECTED and UNKNOWN.
- The H3 v0.2 error envelope alone does not prove non-acceptance. An optional bounded extension, `error.accepted:false`, provides that proof alongside a supported stable code and a boolean `retryable`. Without this extension, ambiguous non-2xx responses remain UNKNOWN. `retryable:true` does not permit reusing a rejected key for another POST.
- Adapter REJECTED facts are immutable. New retry intent requires a new GenerationTask.

## Exact commands

The six original commands run in a clean detached checkout of the committed implementation, inside this project. Dependencies are reused locally; caches and temporary outputs stay inside the project. No temporary NODE_OPTIONS preload or extra command flags are used.

```text
npm run test
npm run typecheck
npm run lint
npm run format:check
npm run package
npm run smoke:package
```

All six commands passed. Vitest: **115 files / 952 tests**. Windows x64 native rebuild: **1/1**. The final standard smoke includes all Gate/Routing/Workflow/G1 regressions and the appended G2 corrective acceptance. The verification checkout remains clean after the commands.

- [Validation results](validation/results.json) and exact command logs under `validation/`.
- [Corrective SQLite/HTTP facts](packaged/facts.json): ENTRY_COMMITTED and JOB_CREATED each recover one Job, one POST and one Artifact; stable preparation failure creates no Job; REJECTED/UNKNOWN terminal restarts have zero additional POST.
- `packaged/`: six actual 1440/900 screenshots for authentication failure, queue rejection and uncertain submission. Ordinary status is Chinese; technical facts remain in closed details.
- [Baseline G2 facts](baseline/facts.json) and fourteen screenshots: prompt, first frame, running, playback, recovered video, UNKNOWN and offline no-reroute.
- [Frozen W2 hashes](frozen-hashes.json): canonical and persisted production release hashes, content hashes and final production restart counters.

The packaged corrective script terminates Main at ENTRY_COMMITTED and JOB_CREATED, restarts the same profile, then checks unique Job binding and exactly one POST. It also checks stable preparation failure, definitive rejection, ambiguous submission, terminal restart, and closed technical details on 1440/900 windows.

The crash hook is enabled only by explicit acceptance environment flags. These are deterministic fixture requests through the production adapter, not live GPU generation. No database, credentials or media binaries are included in this archive.

## Scope

Migration 0029 appends submission outcome and chat continuation guards. Migrations 0001–0028 and the three W2 v1 packages remain unchanged. No new dependencies, live deployment, G3, Workflow generation integration, R5 or W3 are implemented.
