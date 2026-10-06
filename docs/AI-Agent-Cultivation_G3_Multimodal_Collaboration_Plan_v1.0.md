# AI-Agent-Cultivation — G3 Multimodal Collaboration Plan v1.0

- Date: 2026-10-06
- Applies to baseline: `main@108a1154ad4a92f36e8ea60dd898f3bd0c6235bc`
- Depends on:
  - `docs/AI-Agent-Cultivation_Generative_Model_Execution_Software_Spec_v0.2.md`
  - G1 Generation Foundation
  - G2 H3 Integration
  - R4 Routing / Availability
  - Gate 5 Party Collaboration / Human Bridge / Permission
  - W1/W2 Workflow Foundation
- Scope: G3 only. Do not enter R5/W3.
- Main objective: make `MODEL_RUNTIME + GENERATION` a first-class participant in Mission / Party / Workflow-compatible execution, while adding durable, bounded Participant → Coordinator structured continuation.

---

## 1. Core design

G3 does not turn Party into a free-form multi-agent group chat.

The collaboration graph remains coordinator-centric:

```text
Coordinator
  ↓ bounded ExecutionTask
Participant
  ↓ structured outcome
Coordinator
  ↓ resolve / route / resume
Participant or another executor
  ↓
Result / Artifact
  ↓
Coordinator synthesis
```

The important G3 extension is that Participant execution is no longer limited to a one-way final result.

A Participant may durably return:

```text
RESULT
NEEDS_INPUT
NEEDS_CAPABILITY
FAILED_RETRYABLE
FAILED_TERMINAL
```

These are control-plane facts, not free-form natural-language commands.

Participant cannot:
- invite another teammate directly;
- create nested Party / Collaboration requests;
- grant permissions;
- choose arbitrary Runtime / Provider;
- change Workflow edges;
- silently retry side effects.

All continuation decisions remain in trusted Main/Application + Coordinator policy.

---

## 2. Executor model

Do not add a new Teammate executor kind.

```text
MODEL_RUNTIME
├─ executionProtocol = LANGUAGE
└─ executionProtocol = GENERATION

USER_BRIDGE
└─ Human Bridge
```

First G3 release keeps Party Coordinator restricted to an eligible `LANGUAGE` Runtime.

`GENERATION` teammates are first-class participants/executors, but are not coordinators in G3 v1.

Reason:
- current Coordinator path requires reasoning/synthesis;
- a generation model is an execution endpoint, not a general planner;
- this prevents provider-specific generation behavior from leaking into Party orchestration.

Future versions may revisit this only through a new explicit contract.

---

## 3. Workflow-compatible ExecutionTask

Introduce a Provider-neutral execution envelope above Language / Generation / Human Bridge.

Conceptually:

```ts
ExecutionTask {
  id
  missionId
  runId
  requesterTeammateId
  targetTeammateId

  requiredCapability
  executionProtocol

  publicTask
  publicContext
  artifactInputs

  generationRequirements?
  acceptanceCriteria?

  createdAt
}
```

Execution-specific payload:

```text
LANGUAGE
→ existing bounded Mission/Collaboration prompt + Tool path

GENERATION
→ GenerationTask
   capability
   requiredFeatures
   prompt
   GenerationInputBinding[]
   parameters
   expectedOutput
   outputDestination

USER_BRIDGE
→ existing durable Human Bridge / External Work
```

Mission / Party / Workflow orchestration must not know:
- MiniMax H3;
- ComfyUI;
- fl2va / ref2va;
- Suno;
- image-provider-specific options.

Those remain behind existing execution adapters.

Do not replace the existing GenerationJob state machine.

---

## 4. Structured Participant Outcome

Add a durable collaboration execution outcome.

Recommended logical shape:

```ts
ParticipantOutcome =
  | ResultOutcome
  | NeedsInputOutcome
  | NeedsCapabilityOutcome
  | RetryableFailureOutcome
  | TerminalFailureOutcome
```

### 4.1 RESULT

```ts
{
  kind: "RESULT"
  publicResult?: string
  artifactRefs: ArtifactRef[]
}
```

Rules:
- bounded public text only;
- Artifact refs must be trusted persisted artifacts belonging to the same Mission/Run or explicitly imported into it;
- no raw binary/base64;
- no private Memory.

### 4.2 NEEDS_INPUT

```ts
{
  kind: "NEEDS_INPUT"
  requirements: [{
    role: string
    artifactKinds?: string[]
    mimeTypes?: string[]
    required: boolean
  }]
  reason: string
}
```

Example:

```text
Video Participant
→ NEEDS_INPUT
→ role = FIRST_FRAME
```

Coordinator resolution order:

```text
existing trusted Mission Artifact
→ another approved participant can produce it
→ Human Bridge
→ BLOCKED
```

For `GENERATION` participants, role/kind/mime must be validated against the frozen `GenerationModelDescriptor`.

Participant cannot invent a role not supported by its Descriptor.

### 4.3 NEEDS_CAPABILITY

```ts
{
  kind: "NEEDS_CAPABILITY"
  capability: CapabilityDimension
  requiredFeatures?: string[]
  requestedInputs?: [...]
  reason: string
}
```

Coordinator/Main uses R4 + Availability + deterministic feature eligibility.

Participant may request a capability, but may not choose the teammate.

Example:

```text
Video Participant needs FIRST_FRAME
↓
NEEDS_CAPABILITY IMAGE_GENERATION
↓
Coordinator / R4 selects eligible image teammate
↓
Image Artifact
↓
resume original video Participant
```

For fixed Party:
- existing Party membership remains authoritative;
- do not silently add an outside teammate;
- if no eligible member exists, use the existing collaboration/invite approval path or Human Bridge.

### 4.4 FAILED_RETRYABLE

```ts
{
  kind: "FAILED_RETRYABLE"
  errorCode: stableCode
  reason: string
}
```

This means a new attempt may be created.

It does not authorize automatic replay.

Rules:
- new attempt = new logical ExecutionTask;
- generation retry = new GenerationTask / idempotency key;
- never reuse an UNKNOWN generation submission;
- retry budget is bounded;
- Coordinator/Main decides retry / alternate executor / Human Bridge.

Examples:
- provider `QUEUE_FULL` with proven REJECTED outcome;
- temporary format/parameter issue that can be corrected deterministically.

### 4.5 FAILED_TERMINAL

```ts
{
  kind: "FAILED_TERMINAL"
  errorCode: stableCode
  reason: string
}
```

Coordinator may:
- route another eligible participant;
- request Human Bridge;
- fail the collaboration/Mission.

No same-attempt retry.

---

## 5. Outcome trust boundary

Free-form model text must never directly mutate collaboration state.

For LANGUAGE participants:
- require a bounded validated structured completion envelope;
- invalid/missing envelope fails closed;
- public explanatory text may be retained, but only the parsed typed outcome drives continuation.

For GENERATION participants:
- Main derives outcome from `GenerationJob`, Descriptor validation, Artifact facts and stable adapter error facts;
- provider text does not drive collaboration routing.

For Human Bridge:
- use existing durable accepted/rejected continuation facts.

All outcomes bind:

```text
missionId
runId
collaborationRequestId
executionAttemptId
participantTeammateId
executionProtocol
```

and when applicable:

```text
generationTaskId
generationJobId
artifactIds
providerJobId (Advanced/audit only)
```

---

## 6. Durable collaboration execution state

Do not overload `CollaborationRequest.state`, which currently represents approval.

Add a separate durable execution/attempt model.

Suggested states:

```text
PREPARED
RUNNING
WAITING_INPUT
WAITING_CAPABILITY
WAITING_USER
COMPLETED
FAILED
UNKNOWN
```

Each logical delegated task owns immutable attempts.

Minimum facts:

```text
collaborationRequestId
missionId
runId
coordinatorTeammateId
participantTeammateId
executionProtocol
attemptNo
executionTaskSnapshot
state
outcomeKind
generationJobId?
createdAt
updatedAt
```

Historical attempts remain retained.

No overwrite of previous result/Artifact lineage.

---

## 7. Continuation budget and cycle prevention

Keep existing delegation depth bounded.

Participant still cannot delegate onward.

G3 adds coordinator-mediated continuation, not recursive agents.

Use a shared per-collaboration continuation budget.

Recommended initial bounds:

```text
maxParticipantAttempts = 3
maxContinuationRounds = 3
maxRetryAttemptsPerParticipantTask = 1
```

Existing global collaboration/model/tool budgets still apply.

Prevent cycles:

- same unresolved `NEEDS_INPUT` requirement cannot repeat without a new Artifact;
- same `NEEDS_CAPABILITY` request cannot repeatedly select the same failed attempt with no new evidence;
- UNKNOWN never consumes an automatic retry;
- participant cannot request the Coordinator itself as a new participant;
- no participant → participant direct edge.

Budget exhaustion:

```text
WAITING_USER / Human Bridge
```

not infinite retry.

---

## 8. Artifact-first collaboration

Artifact is the primary medium for multimodal handoff.

Correct:

```text
Image Generator
→ IMAGE Artifact
→ Video Generator FIRST_FRAME
→ VIDEO Artifact
→ Reviewer
→ Coordinator
```

Incorrect:

```text
image base64 in prompt
video bytes in Chat Message
provider URL passed between agents
local absolute path passed between agents
```

Coordinator receives only bounded public facts:

```text
artifactId
kind
mimeType
contentHash
size
safe metadata
bounded summary
```

All Artifact references must be checked for:
- existence;
- same Mission/Run or approved import;
- content hash;
- allowed role;
- no path authority escalation.

---

## 9. Generation execution inside Mission / Party

A Generation participant must use the existing G1/G2 path:

```text
Collaboration ExecutionTask
↓
GenerationTask
↓
GenerationService
↓
GenerationGateway
↓
GenerationJob
↓
safe Artifact commit
↓
ParticipantOutcome.RESULT
↓
Coordinator resumes
```

Output destination:

```text
Mission has trusted Workspace + delivery contract
→ MISSION_WORKSPACE

No explicit trusted Workspace
→ APP_ARTIFACT_STORE
```

Never fabricate a Workspace merely because the execution is a Mission.

The Mission/Run/Collaboration identity must be persisted in GenerationTask requester/provenance.

---

## 10. R4 / Availability / Feature eligibility

Routing remains layered:

```text
Capability hard constraints
↓
R4 candidate ranking
↓
Availability
↓
sealed executionProtocol
↓
Generation Descriptor feature/input-role eligibility
↓
execution
```

Feature eligibility is deterministic.

Do not add Feature values to Benchmark.

Examples:

```text
VIDEO_GENERATION
+ FIRST_FRAME_CONDITIONING
```

R4 selects VIDEO_GENERATION candidates; trusted Generation eligibility then rejects candidates without the required feature/role.

Explicit user/Party target:
- if unavailable or incompatible, do not silently substitute;
- surface failure / Coordinator continuation according to existing execution constraint.

---

## 11. Review handoff

Generation model output is not automatically accepted as reviewed.

After generation, optional review is a separate execution.

```text
Generated Artifact
↓
review requirement
↓
eligible reviewer
├─ VISUAL_UNDERSTANDING
├─ SPEECH_UNDERSTANDING
├─ other relevant capability
└─ Human Bridge
↓
Review Artifact / bounded result
↓
Coordinator
```

Generator must not review its own output merely because it produced it.

If current Language adapter cannot consume the required media Artifact safely, route to Human Bridge rather than pretending review occurred.

Review output should bind:
- reviewed Artifact IDs/hashes;
- reviewer teammate;
- run/attempt;
- verdict;
- bounded findings.

---

## 12. Workflow compatibility

Do not modify the three frozen OFFICIAL v1 Workflows.

G3 should expose a generic Workflow-compatible execution bridge so future Workflow versions/TEST_ONLY fixtures can dispatch:

```text
LANGUAGE ExecutionTask
GENERATION ExecutionTask
HUMAN_BRIDGE ExecutionTask
```

Acceptance uses TEST_ONLY Workflow definitions.

Required proof:

```text
Workflow Step
→ Generation ExecutionTask
→ GenerationJob
→ Artifact
→ Step resume
```

Restart must not duplicate the GenerationTask/Job/Artifact.

Do not retrofit generation steps into:
- `official.ai-news-video@1`
- `official.software-feature@1`
- `official.research@1`

Their hashes remain frozen.

---

## 13. Provider-neutral compatibility fixtures

G3 must prove the abstraction is not H3-specific.

Add deterministic test-only adapters/descriptors for at least:

### Image

```text
capability = IMAGE_GENERATION
features:
TEXT_TO_IMAGE
REFERENCE_CONDITIONING

output:
image/png
```

### Music

```text
capability = MUSIC_GENERATION
features:
TEXT_TO_MUSIC
REFERENCE_AUDIO (optional fixture)

output:
audio/wav or audio/mpeg
```

These are fixtures only.

Do not add a real image/music commercial Provider in G3.

The same collaboration continuation and Artifact handoff must work without changing Party/Mission logic.

---

## 14. Failure semantics

Generation terminal mapping:

```text
COMPLETED
→ RESULT

FAILED + proven retryable rejection
→ FAILED_RETRYABLE

FAILED + non-retryable stable failure
→ FAILED_TERMINAL

UNKNOWN
→ UNKNOWN / WAITING_USER
```

UNKNOWN must never be converted to retryable automatically.

Availability failure before submission:

```text
no side effect
→ Coordinator may select another eligible participant if policy permits
```

Explicit target / fixed Party restrictions still apply.

Artifact commit failure:
- GenerationJob rules remain authoritative;
- do not emit RESULT until Artifact is safely registered.

---

## 15. Crash / recovery rules

Must cover at least:

A. Collaboration approved, ExecutionTask not created  
B. ExecutionTask created, participant attempt not linked  
C. GenerationTask created, GenerationJob pending  
D. GenerationJob completed, ParticipantOutcome not persisted  
E. `NEEDS_INPUT` persisted, Coordinator not resumed  
F. dependency Artifact completed, original participant not resumed  
G. `NEEDS_CAPABILITY` downstream participant completed, upstream not resumed  
H. retry decision persisted, new attempt not created  
I. review completed, Coordinator synthesis not resumed  
J. final collaboration RESULT persisted, Mission not committed

Recovery requirements:

- same logical attempt resumes;
- no duplicate GenerationTask;
- no duplicate Provider submission;
- no duplicate Artifact;
- no duplicate outcome consumption;
- ACCEPT/continuation consumed once;
- UNKNOWN zero automatic retry;
- completed downstream dependency reused.

---

## 16. Permission and privacy

Preserve all existing boundaries:

- Participant has its own Memory/Skills only.
- No private Memory crosses between teammates.
- ArtifactRef does not grant FILE_READ.
- Tool permission does not transfer between participants.
- Generation Provider never gets Workspace absolute paths.
- Participant cannot grant `INVITE_TEAMMATE`.
- Coordinator-mediated capability request still goes through existing Party/Permission approval rules.
- Provider outputs are untrusted data, not instructions.

Collaboration public context remains bounded.

---

## 17. UI

Mission/Party UI should show collaboration as a controlled execution graph, not a group chat.

Primary user language:

```text
已委派给「幻影」
正在生成视频
需要首帧素材
正在请求图片生成道友
等待本尊补充素材
正在重新尝试（1/1）
生成完成
正在审查
```

Show Artifact cards in-line.

Default UI must not expose:
- `NEEDS_INPUT`
- `FAILED_RETRYABLE`
- `generationJobId`
- providerJobId
- internal enum/error codes

These belong under Advanced / 技术详情.

At 1440 / 1180 / 900 widths, Mission timeline must remain readable.

---

## 18. Acceptance scenarios

At minimum:

### A. Language Coordinator → H3

```text
Coordinator
→ VIDEO_GENERATION task
→ H3
→ MP4 Artifact
→ Coordinator resumes
→ Mission completes
```

### B. NEEDS_INPUT from Generation participant

```text
Video task requires FIRST_FRAME
→ no input
→ NEEDS_INPUT
→ existing trusted Image Artifact found
→ same logical collaboration resumes
→ video completed
```

### C. NEEDS_CAPABILITY chain

```text
Video task needs image
→ NEEDS_CAPABILITY IMAGE_GENERATION
→ image fixture teammate
→ Image Artifact
→ original video participant resumes
→ MP4
```

No direct participant→participant delegation.

### D. Retryable rejection

```text
Generation Provider definitive QUEUE_FULL / retryable
→ FAILED_RETRYABLE
→ Coordinator creates new attempt
→ new GenerationTask / new idempotency key
→ bounded one retry
```

### E. Terminal failure

```text
AUTH/unsupported terminal failure
→ FAILED_TERMINAL
→ alternate eligible executor or Human Bridge
```

No same-attempt replay.

### F. Human Bridge missing input

```text
NEEDS_INPUT
→ no automatic source
→ Human Bridge
→ user supplies/imports Artifact
→ resume exact collaboration
```

### G. LANGUAGE participant structured continuation

Language participant returns validated `NEEDS_INPUT` or `NEEDS_CAPABILITY`; invalid free-form control output must fail closed.

### H. Review handoff

Video Artifact:
- route to eligible reviewer when safe media understanding path exists;
- otherwise Human Bridge;
- reviewer is distinct from generator where policy requires independence.

### I. Workflow-compatible TEST_ONLY generation step

```text
TEST_ONLY Workflow
→ Generation ExecutionTask
→ Artifact
→ Step resume
```

Frozen OFFICIAL v1 hashes unchanged.

### J. Provider neutrality

The same Party/Continuation path works with:
- H3 video fixture;
- generic image fixture;
- generic music fixture.

---

## 19. Required adversarial tests

- participant tries to choose arbitrary teammate → reject;
- participant tries to grant permission → reject;
- participant returns unsupported Feature/role → reject before submit;
- other Run Artifact → reject;
- changed Artifact hash → reject;
- repeated NEEDS_INPUT with no new Artifact → bounded stop;
- repeated NEEDS_CAPABILITY cycle → bounded stop;
- UNKNOWN GenerationJob → no auto retry;
- REJECTED retry uses new task/key;
- fixed Party cannot silently add outsider;
- participant cannot delegate at depth > 1;
- generator cannot self-review by default;
- restart after each continuation window → zero duplicated execution;
- output Artifact not safely committed → no RESULT.

---

## 20. Migration and persistence

Prefer one additive migration:

```text
0030_g3_multimodal_collaboration.sql
```

Do not modify 0001–0029.

Expected new durable facts may include:

```text
collaboration_execution_attempts
collaboration_participant_outcomes
collaboration_continuation_state
collaboration_artifact_refs
```

Exact table names may follow repository conventions.

All identity/state transitions require SQLite integrity guards where practical.

---

## 21. Evidence and status

Add:

```text
docs/status/g3-multimodal-collaboration.md
docs/evidence/g3-multimodal-collaboration/
```

Evidence must include:
- SQLite facts;
- generation counters;
- restart counters;
- continuation attempts;
- Artifact lineage;
- fixed/ad-hoc Party behavior;
- Human Bridge resume;
- 1440 / 1180 / 900 screenshots;
- exact six-command logs.

Real H3 live integration may remain:

```text
BLOCKED / NOT RUN
```

until deployment endpoint is provided.

Do not call offline H3 fixture live evidence.

---

## 22. Release gate

G3 passes only if all are true:

```text
Generation participant in Party
Language participant still works
Coordinator remains LANGUAGE
Participant→Coordinator structured continuation
NEEDS_INPUT
NEEDS_CAPABILITY
FAILED_RETRYABLE
FAILED_TERMINAL
Artifact-first handoff
R4 + Availability compatibility
Feature eligibility
Permission isolation
Human Bridge fallback
Generation retry/idempotency safety
Crash/restart zero replay
Review handoff
Workflow-compatible TEST_ONLY execution
Image fixture compatibility
Music fixture compatibility
W2 frozen hashes unchanged
G1/G2 regressions pass
Windows packaged UI passes
```

---

## 23. Non-goals

G3 does not implement:

- free-form group chat;
- recursive autonomous sub-agents;
- participant direct delegation;
- arbitrary provider-specific workflow UI;
- real Suno/APIMart integration;
- real image Provider integration;
- auto-publishing;
- automatic infinite retry;
- modification of OFFICIAL Workflow v1;
- R5/W3.

---

## 24. Final target behavior

Example:

```text
Coordinator:
“制作一个 5 秒产品宣传镜头。”

↓
Video Participant

NEEDS_INPUT:
FIRST_FRAME

↓
Coordinator

No existing image
↓
NEEDS_CAPABILITY:
IMAGE_GENERATION

↓
Image Participant
→ image Artifact

↓
Coordinator
→ resume original Video Participant

↓
GenerationTask
→ H3
→ MP4 Artifact

↓
Review handoff
→ visual reviewer / Human Bridge

↓
Coordinator synthesis
→ Mission result
```

The key invariant:

> Participants can report what they need or why they failed, but only the Coordinator/trusted orchestration layer decides what happens next.
