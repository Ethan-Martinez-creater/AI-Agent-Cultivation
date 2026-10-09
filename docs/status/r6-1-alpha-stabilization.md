# R6.1 — Alpha Stabilization

Baseline: `main@7aad12ee3e3895dd70d2f7e6ae4996862add8637`.

The initial audit matrix and risk register were committed as `30a004c` before implementation changes. R6.1 audits the existing Alpha and repairs confirmed boundaries; it does not enter R6.2 or expand the product feature surface.

## Changes

- ToolRuntime revalidates registry, descriptor, input, resource and exact actor permission after asynchronous execution preparation, immediately before execution. Six controlled races fail closed, including DENY and revoked ALLOW→ASK.
- Mission/Workflow tabs support keyboard arrows, Home/End and roving focus through a small shared Renderer helper.
- W3.2 source/prefix/required-input combinations, real compiled IPC sender guards, on-disk migration preservation and H3 abandoned SUBMITTING restart behavior receive targeted evidence.
- A normal production Windows package checks native Main import authority, immutable input snapshots, 300 Mission records, 121 Workflow Runs / 3,872 Step Runs, 100 Drafts, keyboard actions and restart without replay.

No new migration or dependency. Historical migrations 0001–0032 and the three official W2 v1 Definitions/Contracts/manifests remain unchanged. Runtime, Benchmark, Memory, Permission, Tool/MCP, Human Bridge, Party, Workflow and Generation authority remain with their existing services and state machines.

## W3.2 capacity interpretation

The formal imported-prefix array limit is 32. A 32-Step graph that must retain a following executable Step has a structural prefix ceiling of 31. Each imported output requires distinct source evidence, and the source cap is 16: the maximum reachable confirmed prefix under current policy is therefore 16. Tests accept 16, reject source 17, reject alias/reused-source tricks, and confirm that rejection creates no partial formal Run. Required USER inputs and frozen version/input snapshots remain exact across restart and v2 publication.

## Verification

Final original six-command results and actual test counts are generated in the acceptance section below after validation. Targeted and affected results are preserved separately; they are not substituted for final acceptance. Live external results are independently NOT RUN; H3 is BLOCKED / NOT RUN because its real endpoint is absent.

The first final attempt passed 1,398 tests and typecheck, then stopped at Lint: new smoke code used undeclared environment globals and two new tests retained unused imports/variables. These were repaired without behavior changes; the 26 affected tests and scoped Lint/format checks passed. The final sequence restarts from `npm run test`. The failed attempt is retained in `validation/attempt-1-lint.txt` and `attempt-1-test.txt`.

Windows package uses the existing physical build mirror at project-local `.tmp/g3-verify` to separate Electron native-module rebuilding from the Node test environment. It runs the unchanged `npm run package` script with matching source, project-local caches/temporary paths and no temporary NODE_OPTIONS preload. The executable is copied back to project `out` for the unchanged root `npm run smoke:package` command. This is an environment isolation measure, not an alternative package command or dependency upgrade.

See [audit matrix](../evidence/r6-1-alpha-stabilization/audit-matrix.md), [risk register](../evidence/r6-1-alpha-stabilization/risk-register.md), [defect evidence](../evidence/r6-1-alpha-stabilization/defect-fixes.md) and [R6.2 provider prerequisites](../evidence/r6-1-alpha-stabilization/provider-live-readiness.md).

## Limits and release gates

Large Mission/Workflow/Draft list queries remain unpaginated. At 900 width the existing responsive layout stacks the entire list above the detail; 300 Missions / 121 Runs therefore require long scrolling to reach the selected detail. This is recorded as nonblocking UX debt, not certified convenient operation at that scale. This round measures bounded data, without claiming a performance improvement or unlimited capacity. H3 exact accepted-response-loss proof uses adapter recreation with a state-store double; existing persisted UNKNOWN and packaged crash evidence do not turn it into a live provider proof. Test profiles stay isolated: manually reusing a fixture profile can retain its fixture data. The fixed Gate3 budget-approval demo remains a nonblocking presentation debt and cannot grant File/MCP authority.

No unresolved confirmed offline BLOCKER/HIGH defect remains after the final passing acceptance. Real provider access/cost authorization and H3 deployment remain R6.2 prerequisites; offline PASS is not approval for a live release. No R6.2 work is started.

<!-- FINAL_ACCEPTANCE -->

## Final acceptance record

Status: **OFFLINE PASS**. Test count: 1398; files: 156.

| Original command        | Result | Log                                                                                                   |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `npm run test`          | PASS   | [validation/final-test.txt](../evidence/r6-1-alpha-stabilization/validation/final-test.txt)           |
| `npm run typecheck`     | PASS   | [validation/final-typecheck.txt](../evidence/r6-1-alpha-stabilization/validation/final-typecheck.txt) |
| `npm run lint`          | PASS   | [validation/final-lint.txt](../evidence/r6-1-alpha-stabilization/validation/final-lint.txt)           |
| `npm run format:check`  | PASS   | [validation/final-format.txt](../evidence/r6-1-alpha-stabilization/validation/final-format.txt)       |
| `npm run package`       | PASS   | [validation/final-package.txt](../evidence/r6-1-alpha-stabilization/validation/final-package.txt)     |
| `npm run smoke:package` | PASS   | [validation/final-smoke.txt](../evidence/r6-1-alpha-stabilization/validation/final-smoke.txt)         |

Normal production packaged dataset: 300 Missions, 121 Workflow Runs, 3872 Step Runs, 100 Drafts. Recorded startup 1693.9 ms; dataset creation 4432.2 ms; list-query/typed-IPC round trip 13.1 ms. These are observations on one machine, without a comparative improvement claim.

Nine new real Windows screenshots: `docs/evidence/r6-1-alpha-stabilization/packaged/` (Home empty / Mission volume / Workflow volume × 1440, 1180, 900). All document/viewport widths match; the 900 request has 902 CSS pixels under the desktop minimum-size/DPI behavior. Keyboard actions and restart facts are in `packaged/facts.json`.

Full final smoke preserves and reruns Gate0–6, R0–R4, R5.1–R5.5, W1/W2/W3 and G1/G2/G3 chains. The exact marker inventory is in `acceptance.json`. New JSON indexes distinguish newly added proof from existing regressions and from unperformed live tests.
