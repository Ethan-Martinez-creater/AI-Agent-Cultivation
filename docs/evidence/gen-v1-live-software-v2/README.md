# Generation V1 evidence

This directory contains sanitized evidence for Generation V1 software v2, baseline `630dfb89029aa8fb359048d547d861bb35b1b721`. Earlier standalone raw-provider preflights are not software or Windows packaged PASS.

Credentials, ciphertext, authorization headers, signed download query strings and raw private Memory are excluded. H3 GPU live is NOT_RUN. The six-command logs use the exact standard npm commands.

## Evidence map

- `validation/`: six original command logs and explicitly invoked live harness logs.
- `packaged/live-generation-facts.json`: real API Mart, MiMo and TokenRhythm Jobs/Artifacts, four-level results, original attempts and restart playback. Original I2V Chat remains UNKNOWN; its successful later, explicit G3 case is separate.
- `packaged/artifact-collaboration-facts.json`: real USER share Event/Audit → original image identity/hash → approved generation participant → real video → Coordinator, opaque playback and restart preservation. No test fake flags.
- `packaged/jev-facts.json`: real Jev Shadow, routing, skill, Memory gate/rerank, shortlist, final prompt and advisory facts. R5.3 attribution is to its separate focused Mission, not the earlier broad tool Mission.
- `packaged/tokenrhythm-video-check.json`: authenticated read-only model/history results. Current Wan price and account generation entitlement are unproven: CHECK BLOCKED, GEN NOT_RUN, video POST count zero.
- `packaged/gen-http-v1/`: independent offline HTTP fixture, not live Provider evidence. It exercises the production adapter for four media capabilities.
- `transport-replay.json`: 本机 HTTPS/CONNECT 与 accepted response-loss 单次 POST 检查，TLS 校验启用；G2 packaged facts 同时断言真实网络 postAttempts=1。
- `release-integrity.json`: SQLite integrity/foreign keys, migration 33, unchanged historical 32 files, unchanged three W2 release/content hashes, original UNKNOWN preserved.
- `acceptance-matrix.json`: final 21 statuses and four live levels.

## Screenshots

PNG names identify provider/capability, restart where applicable, and content width (1440/1180/900). Native Windows capture at 125% scaling has a larger physical pixel width. `collaboration-playback-diagnostic.png` documents the detected and repaired non-RESULT Renderer crash; it is not an acceptance screenshot. Real accepted G3 preview uses `live-artifact-collaboration-*.png`.

## Reproduction

Run the six original npm commands. `npm run smoke:package` retains the complete historical chain and appends GEN_HTTP_V1. Live harnesses are explicit scripts, not production bootstrap or ordinary offline tests; they require the ignored local credential file in API Mart/MiMo/Jev/TokenRhythm order and use an isolated persistent profile under `.test-data/gen-v1-live/`.

Do not rerun live stages as a generic CI task: requests may be billable. Existing entry/Job IDs are reused, UNKNOWN is never automatically POSTed, and completed history playback needs no new generation. The historical cancelled H3 GPU test is not resumed.

## Actual compatibility findings

- Real video required bounded B-frame presentation/edit-list and standard AVC/AAC validation; no decoder or full-buffer media path was introduced.
- Suno reports truncated hundredth-second duration. A trusted adapter-only 20 ms tolerance accepts the actual WAV container duration; untrusted Provider metadata cannot raise it.
- Exact API Mart delivery host `getapib.org` and exact TokenRhythm image bucket `tokenrhythm-prod-backup-oss.oss-cn-beijing.aliyuncs.com` were verified from authenticated task results. CDN requests omit API credentials; wildcards/redirects remain refused.
- Compatible language proposal JSON mode needs a static Main-owned JSON/schema instruction. Zod and original permission/state validation remain authoritative.
- NEEDS_INPUT/NEEDS_CAPABILITY/FAILED outcomes do not own an Artifact array. Product rendering now distinguishes them from RESULT, avoiding the real completed-Mission page crash.

Source contracts and public references: [GEN_HTTP_V1](../../architecture/gen-http-v1.md), [TokenRhythm API guide](https://tokenrhythm.studio/docs/api-integration), [API Mart docs](https://docs.apimart.ai/), [Xiaomi MiMo docs](https://platform.xiaomimimo.com/), [TypeSafe docs](https://docs.typesafe.ai/).
