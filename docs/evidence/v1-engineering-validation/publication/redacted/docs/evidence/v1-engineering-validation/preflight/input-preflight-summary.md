> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `d47a4f48ff6df1684e58559f66bc3df0a992518e1e6508b6b349dc145dce1583`. See the publication derivation map for both hashes and removed field categories.

# E1 Closure / Preflight — P1 Production Inputs and Offline Fault Injection

Scope: E0 v0.2 P1 only, plus offline fault injection for Skill, Memory and Tool selectors. This is not Jev Live, not a production Tool execution, and not a packaged crash/recovery experiment.

## Integrity

| Check                     | Result | SHA-256                                                          |
| ------------------------- | ------ | ---------------------------------------------------------------- |
| E0 v0.2 Markdown          | PASS   | 2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c |
| Canonical Dataset JSON    | PASS   | ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602 |
| ToolFixtureMapping TSV    | PASS   | 04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62 |
| Structural Dataset checks | PASS   | —                                                                |

## P1 case results

Skill production input: **PASS** (10/10). Each case has a typed, fixed-ID/fixed-time Teammate domain DTO in its own in-memory fixture registry; owner existence is asserted before every SkillService assignment. Skill IDs are created and assigned/enabled through SkillService, and SkillRoutingService.select() runs with a null gateway factory. The receipt order is the actual selector order; it is not rewritten to Dataset order. No Gate1 persistence or provider probe is used.

| Case  | Result | Candidate count | Receipt / reason    |
| ----- | -----: | --------------: | ------------------- |
| SK-01 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-02 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-03 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-04 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-05 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-06 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-07 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-08 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-09 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| SK-10 |   PASS |               6 | GATEWAY_UNAVAILABLE |

Memory production input: **PASS** (10/10), evidence level `R5.3 RERANK_ONLY`. Each six-record immutable snapshot is passed in Dataset order to MemoryRerankService.rank(); no Gate2 retrieval is claimed.

| Case  | Result | Candidate count | Receipt / reason    |
| ----- | -----: | --------------: | ------------------- |
| ME-01 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-02 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-03 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-04 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-05 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-06 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-07 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-08 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-09 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| ME-10 |   PASS |               6 | GATEWAY_UNAVAILABLE |

Tool production input: **PASS** (10/10). Each case uses a separate actual ToolRegistry with synthetic descriptors created from the frozen TSV and E0 Chinese metadata. Resource and execute callbacks reject; both call counters must stay at zero.

| Case  | Result | Candidate count | Receipt / reason    |
| ----- | -----: | --------------: | ------------------- |
| TO-01 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-02 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-03 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-04 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-05 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-06 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-07 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-08 |   PASS |               6 | GATEWAY_UNAVAILABLE |
| TO-09 |   PASS |              12 | GATEWAY_UNAVAILABLE |
| TO-10 |   PASS |               7 | GATEWAY_UNAVAILABLE |

TO-09 contract: PASS; its native fallback offer remains 12, while the production JEV selection cap is 8. TO-09 remains offline-only.

## Offline fault injection

| Family / case  | Injected condition                    | Result | Receipt / note      |
| -------------- | ------------------------------------- | -----: | ------------------- |
| SKILL / SK-01  | invalid-response                      |   PASS | INVALID_RESPONSE    |
| SKILL / SK-01  | stale-assignment-before-final-recheck |   PASS | STALE_SELECTION     |
| SKILL / SK-01  | timeout                               |   PASS | GATEWAY_TIMEOUT     |
| MEMORY / ME-01 | invalid-response                      |   PASS | INVALID_RESPONSE    |
| MEMORY / ME-01 | expired-candidate-at-rank-input       |   PASS | GATEWAY_UNAVAILABLE |
| MEMORY / ME-01 | timeout                               |   PASS | GATEWAY_TIMEOUT     |
| TOOL / TO-01   | invalid-response                      |   PASS | INVALID_RESPONSE    |
| TOOL / TO-01   | stale-descriptor-fingerprint          |   PASS | STALE_RECHECK       |
| TOOL / TO-01   | timeout                               |   PASS | GATEWAY_TIMEOUT     |
| SKILL / SK-01  | unavailable                           |   PASS | GATEWAY_UNAVAILABLE |
| MEMORY / ME-01 | unavailable                           |   PASS | GATEWAY_UNAVAILABLE |
| TOOL / TO-01   | unavailable                           |   PASS | GATEWAY_UNAVAILABLE |

Timeouts are simulated by never-resolving in-memory gateways against the production 6-second deadline. Invalid responses are local malformed DecisionResult values. Stale Skill assignment, expired Memory input, and changed Tool descriptor are isolated fixture mutations. No real provider call or Tool execution occurred.

## Boundaries and next gates

- Dataset/live-set contents and Gold were read-only; grades/reference reasons are excluded from selector inputs.
- All evidence is generated from production selector/service receipts or their production request-builder projections. No selector ranking algorithm was reimplemented.
- `SKILL_INPUT_COMPATIBILITY`, `MEMORY_INPUT_COMPATIBILITY`, `TOOL_MAPPING_COMPATIBILITY`, and `TO09_CAPACITY_CONTRACT` are reported by this P1 run only. E0 v0.2 full E1 closure remains conditional on independent Gold review, Jev transport/price preflight, packaged CR-A/CR-B breakpoint preflight, and crash-controller observability.
- No Jev Live request, paid Provider request, file write/delete/command Tool, package build, or process kill was performed by this P1 run.
