# R6.1 Risk Register (initial audit)

Baseline `7aad12e`; recorded before code changes.

| ID | Level | Finding / evidence | Required disposition |
| --- | --- | --- | --- |
| R61-01 | HIGH | W3.2 accepted evidence explicitly left source-count, maximum-prefix and required USER input combination untested (`w3-2/acceptance.json` coverageLimits). | Test exact source and reachable prefix boundaries, frozen inputs and absence of partial formal facts. |
| R61-02 | HIGH audit | Cross-layer authority and recovery boundaries have distributed historical tests; current consolidated audit not yet complete. | Read actual assertions/implementation; add only tests/fixes for reproducible gaps. |
| R61-03 | MEDIUM | All real model/Jev/H3 remote acceptance remains NOT RUN/BLOCKED. Offline fixtures cannot establish live correctness. | Prepare explicit R6.2 provider matrix; do not perform paid calls. |
| R61-04 | MEDIUM audit | Large lists, focus/error handling and bounded SQL capacity require current inspection. | Measure bounded scenarios and verify packaged layouts; no speculative caching/redesign. |

No new feature proposal or confirmed BLOCKER has been established at this initial checkpoint. Final risk disposition will preserve the distinction between discovered defects, coverage gaps, external release prerequisites and nonblocking technical debt.
