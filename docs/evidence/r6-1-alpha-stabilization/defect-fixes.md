# R6.1 Confirmed Defects and Coverage Repairs

## HIGH: ToolRuntime authority after asynchronous preparation

Before the fix, ToolRuntime captured a validated/allowed registration, awaited `executionGuard.before`, and executed without checking whether its permission, registry, descriptor, input or resolved resource had changed. A held guard reproduces five failures against pre-fix production source (`30a004c`): newly inserted DENY, replaced registration, changed descriptor, changed input and changed resource. The isolated repro log is preserved in `validation/tool-guard-before.txt`; five old tests pass and five new race tests fail.

The final boundary rechecks the same PermissionEngine and registry/descriptor/input/resource immediately before execution with no intervening await. DENY and revoked ALLOW→ASK return structured denial/approval-required results without executing. Registration/function/descriptor/input/resource drift fails closed and invokes the guard's failure completion. Existing permission scope priority, exact grants and Tool output transcript semantics remain unchanged. R5.4 assertions now correctly expect two authority checks for successful execution, with one actual Tool execution.

Evidence: `packages/application/src/tool-runtime.test.ts` (11 tests, including six held-guard cases), affected regression and full suite. No schema change or new permission authority.

## MEDIUM: Mission/Workflow keyboard navigation

Horizontal page tabs lacked Arrow/Home/End navigation and roving tab focus. A small shared Renderer helper now wraps ArrowLeft/ArrowRight and handles Home/End using existing selection callbacks. It changes presentation and focus only. Eleven deterministic tests and the actual packaged keyboard actions prove selection/focus; no Mission or Workflow state is written by this helper.

## HIGH verification gap: W3.2 real capacity/input combinations

Four application tests cover 16 sources, source 17 rejection, duplicate canonical identity, invalid/reused source prefix, required typed/nested bounded inputs, frozen v1/v2 inputs and reopen/idempotent confirmation. The real production package repeats the reachable 16-prefix/32-Step case with native dialogs, Main FileWorkspace reads and SQLite. Over-limit proposals cannot leave a partially confirmed Run.

The policy is unchanged: formal prefix-array bound 32; graph budget 32 with a required following executable Step gives structural bound 31; distinct evidence per output plus source budget 16 gives a reachable imported prefix of 16. Claiming 32 imported Steps would misstate the shipped policy.

## HIGH verification gap: actual compiled IPC sender gate

The production packaged handler rejects a foreign sender, a foreign equal-URL frame and a null frame before any import work. This invokes the real compiled Main handler through a test harness, rather than injecting a permissive authorization predicate. It is not represented as a live foreign-process exploit attempt. Formal counts are unchanged.

## Persistence and recovery coverage

An on-disk SQLite 0031→0032 migration test preserves legitimate Draft, Version, READY Run, Mission event, official release and Contract facts, applies the expected completion-origin default, checks immutable guards, reopens twice and obtains clean FK/integrity results. No historical migration was changed.

An H3 fixture holds an accepted POST response at durable adapter SUBMITTING; adapter recreation returns UNKNOWN and sends no second POST. This test uses an in-memory state-store double: it proves adapter restart behavior at the exact barrier, not SQLite process-kill durability at that same barrier. Existing G2 persisted UNKNOWN and G1/G3 packaged crash windows remain separate evidence. No H3 live test was performed.

## Scope

No new migration, dependency, Agent feature, routing policy, Workflow engine, scheduler, Realm logic or live deployment. R5.1–R5.5 implemented harnesses were audited; no hypothetical R5.6 implementation is inferred from a phase label.
