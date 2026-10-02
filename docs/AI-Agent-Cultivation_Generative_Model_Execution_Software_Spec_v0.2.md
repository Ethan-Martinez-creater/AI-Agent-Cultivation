# AI-Agent-Cultivation — Generative Model Execution Foundation
## 软件侧执行智能体实施与联调规范 v0.2

- 日期：2026-10-01
- 修订版本：v0.2
- 基于 v0.1 修订：保持普通道友 `MODEL_RUNTIME` 身份不扩张，新增 `executionProtocol=GENERATION`；补充显式 `requiredFeatures`；将幂等责任明确落到 Adapter Contract；引入 App Artifact Store / Mission Workspace 双输出落点。
- 适用仓库：AI-Agent-Cultivation
- 目标：让视频、图片、音乐、语音等“生成型模型”成为正式道友，能够像语言模型一样被用户单独调用，也能够在 Mission / Party / Workflow 中被其他道友委派任务。
- 首个真实 Provider：自建 MiniMax H3 视频生成服务
- 本文与《MiniMax H3 Provider Adapter 执行与联调规范 v0.1》共同构成联调契约。
- 核心原则：**统一产品体验，不强行统一底层模型调用形态。**

---

# 1. 最终架构

软件层统一把“道友”视为 Executor，而不是默认所有普通道友都是 Chat Model。

**不新增 `MEDIA_GENERATOR` 作为 Teammate executorKind。**

现有普通模型道友继续保持：

```text
Teammate
├─ MODEL_RUNTIME
└─ USER_BRIDGE
```

其中封存后的普通 `MODEL_RUNTIME` 再声明执行协议：

```text
RuntimeProfile / ModelBinding
└─ executionProtocol
   ├─ LANGUAGE
   └─ GENERATION
```

因此：

```text
MODEL_RUNTIME + LANGUAGE
→ 现有文本模型执行

MODEL_RUNTIME + GENERATION
→ 图片 / 视频 / 音乐 / 语音等生成型执行

USER_BRIDGE
→ 现有 Human Bridge
```

这样生成模型不会重新打开已经稳定的 Teammate identity / sealed Runtime 体系，也不会随着未来模型类型增加继续扩张 `executorKind`。

产品层：

```text
Teammate
Mission
Collaboration
Workflow
Artifact
Routing
```

执行协议层：

```text
MODEL_RUNTIME
├─ LanguageExecution
└─ GenerationExecution

USER_BRIDGE
└─ HumanBridgeExecution
```

`executionProtocol` 属于固定 Runtime 执行身份的一部分；普通道友创建并封存后不得在 `LANGUAGE / GENERATION` 之间动态切换。

Provider 层：

```text
OpenAI / Anthropic / Gemini / ...
MiniMax H3 Adapter
Image Generator Adapter
Music Generator Adapter
...
```

Mission / Workflow 不得感知：

```text
ComfyUI workflow 名称
t2va / fl2va / ref2va / v2a
GPU 显存调优
模型具体节点图
```

这些全部属于 Provider Adapter。

---

# 2. 与现有“道友=固定模型”原则的关系

普通生成型道友仍遵守：

```text
一个普通道友 = 一个封存后的固定模型执行身份
```

例如：

```text
幻影
executorKind = MODEL_RUNTIME
executionProtocol = GENERATION
provider = SELF_HOSTED_H3
model = MiniMax-H3
capability = VIDEO_GENERATION
```

创建并验证后：

```text
Provider / Endpoint / Model / executionProtocol → 锁定
Credential                                     → 可轮换
```

换底层模型必须新建道友。

Human Bridge 仍是唯一：

```text
USER_BRIDGE
```

---

# 3. 不扩张 Benchmark 维度

现有 Capability Taxonomy 保持不变。

MiniMax H3 的主 Benchmark 维度：

```text
VIDEO_GENERATION
```

未来图片：

```text
IMAGE_GENERATION
IMAGE_EDITING
```

未来音乐：

```text
MUSIC_GENERATION
```

以下能力不得新增为 Benchmark 维度：

```text
FIRST_FRAME_CONDITIONING
REFERENCE_IMAGE
REFERENCE_VIDEO
REFERENCE_AUDIO
NATIVE_AUDIO
MASK
INPAINT
COMPOSITION_PLAN
```

它们属于：

```text
Generation Feature / Execution Support
```

路由应分两层：

```text
Capability eligibility
↓
Feature eligibility
↓
Availability
↓
Benchmark / semantic fit
```

其中：

```text
Capability
→ 使用现有 Benchmark / Capability Taxonomy

Feature
→ 使用 GenerationModelDescriptor.featureTags / inputRoles 做确定性过滤
```

Feature 不进入 Benchmark 分数，也不由 Jev/LLM 猜测。

`GenerationTask.requiredFeatures` 是本次执行的显式 Feature 需求；所有值都必须是当前 Descriptor 已声明的 feature。输入 Artifact 的 role 仍独立按 `inputRoles` 校验。

---

# 4. 新增领域抽象

## 4.1 GenerationModelDescriptor

Provider/Model 必须声明：

```ts
GenerationModelDescriptor {
  modelId: string

  outputCapability:
    | "IMAGE_GENERATION"
    | "IMAGE_EDITING"
    | "VIDEO_GENERATION"
    | "SPEECH_GENERATION"
    | "MUSIC_GENERATION"

  executionMode: "ASYNC_JOB" | "SYNC"

  featureTags: string[]

  inputRoles: GenerationInputRoleDescriptor[]

  parameterSchema: JsonSchema

  outputTypes: string[]

  limits: {
    maxDurationSeconds?: number
    minDurationSeconds?: number
    maxInputFiles?: number
    maxInputBytes?: number
  }
}
```

首个 H3 Descriptor 至少表达：

```text
outputCapability = VIDEO_GENERATION
executionMode = ASYNC_JOB

features:
TEXT_TO_VIDEO
FIRST_FRAME_CONDITIONING
REFERENCE_CONDITIONING
VIDEO_TO_AUDIO
NATIVE_AUDIO

input media:
image
video
audio

verified runtime:
832x480
24fps
4–15s
```

## 4.2 GenerationTask

Application 层统一生成：

```ts
GenerationTask {
  id: string
  targetTeammateId: string
  capability: CapabilityDimension
  requiredFeatures: string[]
  prompt: string
  inputs: GenerationInputBinding[]
  parameters: Record<string, unknown>
  expectedOutput: {
    artifactKind: string
    mimeTypes: string[]
  }
  outputDestination: {
    scope: "APP_ARTIFACT_STORE" | "MISSION_WORKSPACE"
    logicalPathHint?: string | null
  }
  requester: {
    actorType: "USER" | "TEAMMATE" | "WORKFLOW"
    actorId: string | null
  }
  missionId?: string | null
  runId?: string | null
  workflowRunId?: string | null
  workflowStepRunId?: string | null
  createdAt: string
}
```

`requiredFeatures` 的验证规则：

```text
GenerationTask.requiredFeatures
⊆
GenerationModelDescriptor.featureTags
```

例如：

```text
纯文本生成视频
requiredFeatures = ["TEXT_TO_VIDEO"]

首帧图生成并要求原生音频
requiredFeatures = [
  "FIRST_FRAME_CONDITIONING",
  "NATIVE_AUDIO"
]
```

输入 role 同时必须满足：

```text
GenerationTask.inputs[*].role
∈
GenerationModelDescriptor.inputRoles
```

`outputDestination` 只描述软件侧 Artifact 最终存储域，不暴露真实绝对路径给 Provider Adapter。

- 普通 Chat 默认 `APP_ARTIFACT_STORE`；
- 已绑定 Workspace 的 Mission / Workflow 可以使用 `MISSION_WORKSPACE`；
- 没有显式 Workspace 时不得为了生成文件临时伪造 Workspace。

## 4.3 GenerationInputBinding

```ts
GenerationInputBinding {
  artifactId: string
  role: string
}
```

role 不在核心 Domain 中写死为有限 enum，由当前 `GenerationModelDescriptor.inputRoles` 校验。

H3 常见 role：

```text
FIRST_FRAME
LAST_FRAME
REFERENCE_IMAGE
REFERENCE_VIDEO
REFERENCE_AUDIO
SOURCE_VIDEO
```

未来图片模型可能：

```text
REFERENCE
STYLE_REFERENCE
INIT_IMAGE
MASK
```

未来音乐模型可能：

```text
REFERENCE_AUDIO
MELODY
VOCAL_REFERENCE
```

---

# 5. Artifact 是模型间交接的主要语言

禁止：

```text
把大文件转 base64 塞进聊天 Message
把视频内容放进 LLM 上下文
把其他道友生成的文件复制成 prompt 文本
```

正确路径：

```text
Artifact
↓
GenerationInputBinding
↓
Provider upload / reference
↓
GenerationJob
↓
Output Artifact
```

其他道友只获得：

```text
artifactId
type
mimeType
metadata
bounded summary
```

如果需要理解视频/图片：

```text
路由到具备 VISUAL_UNDERSTANDING 的道友
```

生成模型本身不得自动被当成 Reviewer。

---

# 6. GenerationGateway

新增独立于 ModelGateway 的：

```ts
interface GenerationGateway {
  getDescriptor(runtimeProfileId: string):
    Promise<GenerationModelDescriptor>

  submit(
    runtimeProfileId: string,
    request: ProviderGenerationRequest
  ): Promise<GenerationSubmission>

  getJob(
    runtimeProfileId: string,
    providerJobId: string
  ): Promise<ProviderGenerationJob>

  cancel?(
    runtimeProfileId: string,
    providerJobId: string
  ): Promise<void>

  downloadOutput(
    runtimeProfileId: string,
    providerJobId: string,
    outputId?: string
  ): Promise<Readable | Buffer | FileHandle>
}
```

Application / Domain 不暴露 ComfyUI、RunningHub 或 MiniMax H3 SDK 类型。

---

# 7. GenerationJob

必须持久化长任务。

```ts
GenerationJob {
  id: string
  generationTaskId: string
  teammateId: string
  runtimeProfileId: string
  providerJobId: string | null
  idempotencyKey: string
  state:
    | "PENDING"
    | "SUBMITTING"
    | "QUEUED"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED"
    | "UNKNOWN"
  providerStatus?: string | null
  outputArtifactIds: string[]
  errorCode?: string | null
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
  completedAt?: string | null
}
```

必须 append Audit/Event，但不得写隐藏 CoT。

---

# 8. Idempotency

H3 单条视频可能耗时数分钟，因此提交必须幂等。

软件为每个 `GenerationTask` 创建稳定：

```text
Idempotency-Key = GenerationTask.id
```

**幂等保证属于 `Application → Provider Adapter` 的正式契约。**

软件不能假设所有未来上游 Provider 都原生支持 idempotency。Adapter 必须保证：

```text
同一 Idempotency-Key + 同一 request fingerprint
→ 永远关联同一个逻辑 Generation submission
→ 返回同一个 providerJobId / adapter job identity
```

如果上游 Provider 原生支持幂等：

```text
Adapter
→ 透传 / 映射原生 idempotency
```

如果上游 Provider 不支持：

```text
Adapter
→ 持久化本地 idempotency mapping
→ idempotencyKey
→ requestFingerprint
→ providerJobId / submission state
```

同一 key 但 payload 不同：

```text
→ IDEMPOTENCY_CONFLICT
```

提交响应丢失 / timeout 时：

```text
软件使用同一 Idempotency-Key 再次 submit
↓
Adapter 先查询自身 durable mapping / upstream status
↓
返回原逻辑 job
```

Adapter 不得因为网络重试无脑创建第二个 GPU 任务。

若 Adapter 在 crash 后也无法确定首次提交是否已经到达上游：

```text
→ 返回稳定的 UNKNOWN / submission-uncertain 状态
→ 软件 GenerationJob 进入 UNKNOWN
→ 不自动再次生成
```

禁止：

```text
超时
→ 换一个 key
→ 无脑重新 POST
→ GPU 重复生成
```

---

# 9. Async Job 与 Mission 状态

生成型执行不能让 Application `await` 数分钟。

```text
Mission / Chat
↓
GenerationTask
↓
GenerationJob submit
↓
providerJobId
↓
持久化
↓
进入等待
```

Mission 可新增 `WAITING_GENERATION`，或使用 `RUNNING + durable pending generation continuation` 的等价表达，但必须满足：

- 应用关闭后可恢复；
- 原 MissionRun 不丢；
- 不重复 submit；
- 完成后恢复原 Run；
- FAILED 不伪造 Artifact；
- UNKNOWN 不自动重复生成。

实现时优先复用 R3.1 durable continuation 的思想，但不要强行把 Human Bridge 和 GenerationJob 共用同一张表/状态机。

---

# 10. 单聊体验

用户打开生成型道友：

```text
幻影 · MiniMax H3
```

用户发送自然语言，后台转换为：

```text
User Message
↓
GenerationTask
↓
GenerationJob
```

生成中 UI 显示：

```text
正在生成
Queued / Running
```

完成后显示 Artifact result card，例如：

```text
[视频预览]
5.2s · 832×480 · 24fps
```

用户体验是 conversation-like，但底层协议不是 messages/chat completion。

---

# 11. 单聊附件

生成型道友输入框支持 Artifact attachment。

例如：

```text
product.png
role = FIRST_FRAME
```

用户请求：

```text
用这张图片做一个 8 秒产品镜头。
```

生成：

```text
GenerationTask.inputs = [
  {artifactId:"...", role:"FIRST_FRAME"}
]
```

H3 Adapter 决定调用 `fl2va`。

UI 不出现 `fl2va/ref2va/ComfyUI workflow`，除非 Advanced/Developer View。

---

# 12. Collaboration

其他道友委派生成型道友时不应发送普通 Chat Message，而应生成结构化 ExecutionTask/CollaborationTask。

示例：

```json
{
  "targetTeammateId": "h3-teammate",
  "capability": "VIDEO_GENERATION",
  "requiredFeatures": ["FIRST_FRAME_CONDITIONING"],
  "objective": "Generate shot 03",
  "prompt": "A premium black laptop floating in a bright white studio...",
  "inputs": [
    {
      "artifactId": "artifact-product-hero",
      "role": "FIRST_FRAME"
    }
  ],
  "parameters": {
    "duration": 5,
    "aspect": "16:9"
  }
}
```

完成后：

```text
shot03.mp4 Artifact
↓
Collaboration result metadata
↓
Coordinator
```

Coordinator 不获得视频二进制。

---

# 13. Workflow

未来 Workflow Step 使用同一 GenerationExecution。

```text
TASK: Produce Visual Shot
requiredCapabilities = VIDEO_GENERATION
requiredGenerationFeatures = FIRST_FRAME_CONDITIONING
input Artifact = storyboard.scene03 + hero.png
↓
R4 Routing
↓
幻影
↓
GenerationTask
↓
Artifact shot03.mp4
↓
Output Contract validation
```

Workflow 不需要 MiniMax H3 专用节点。

---

# 14. Availability

R3.2 Availability 必须覆盖生成型 Runtime。

H3 Provider：

```text
GET /health
```

映射：

```text
200 + status=ok → AVAILABLE
连接拒绝 / provider disabled / auth hard failure → UNAVAILABLE
timeout / transient 5xx → UNSTABLE
```

执行前仍走 request-before-send probe。

自动路由：

```text
H3 UNAVAILABLE
→ 下一个 VIDEO_GENERATION 道友
→ 无正常候选时 Human Bridge
```

用户显式指定 H3 时，若 UNAVAILABLE 不得静默换人。

---

# 15. Provider API — 共享联调契约

## 15.1 Health

```http
GET /health
```

```json
{
  "status": "ok",
  "service": "minimax-h3-adapter",
  "version": "0.1.0"
}
```

## 15.2 Model Descriptor

```http
GET /v1/models
```

至少返回：

```json
{
  "data": [
    {
      "id": "minimax-h3",
      "output_capability": "VIDEO_GENERATION",
      "execution_mode": "ASYNC_JOB",
      "features": [
        "TEXT_TO_VIDEO",
        "FIRST_FRAME_CONDITIONING",
        "REFERENCE_CONDITIONING",
        "VIDEO_TO_AUDIO",
        "NATIVE_AUDIO"
      ],
      "input_roles": [
        "FIRST_FRAME",
        "LAST_FRAME",
        "REFERENCE_IMAGE",
        "REFERENCE_VIDEO",
        "REFERENCE_AUDIO",
        "SOURCE_VIDEO"
      ],
      "limits": {
        "min_duration_seconds": 4,
        "max_duration_seconds": 15
      },
      "output_types": ["video/mp4"]
    }
  ]
}
```

## 15.3 Upload

```http
POST /v1/files
Content-Type: multipart/form-data
```

```json
{
  "file_id": "file_xxx",
  "mime_type": "image/png",
  "size_bytes": 123456,
  "sha256": "...",
  "created_at": "..."
}
```

大文件默认走 upload + file_id，不使用 base64 作为主要传输方式。

## 15.4 Submit Video

```http
POST /v1/videos
Idempotency-Key: <GenerationTask.id>
Content-Type: application/json
```

```json
{
  "model": "minimax-h3",
  "prompt": "...",
  "duration": 5,
  "aspect": "16:9",
  "seed": 42,
  "task": "auto",
  "media": [
    {
      "role": "first_frame",
      "file_id": "file_xxx"
    }
  ]
}
```

```json
{
  "task_id": "gen_xxx",
  "status": "queued"
}
```

## 15.5 Job Status

```http
GET /v1/videos/{task_id}
```

```json
{
  "task_id": "gen_xxx",
  "status": "queued|running|completed|failed|cancelled",
  "progress": null,
  "outputs": [
    {
      "id": "output_0",
      "mime_type": "video/mp4",
      "size_bytes": 123,
      "duration_seconds": 5.2,
      "width": 832,
      "height": 480,
      "fps": 24
    }
  ],
  "error": null
}
```

## 15.6 Download

```http
GET /v1/videos/{task_id}/content
```

或：

```http
GET /v1/videos/{task_id}/outputs/{output_id}
```

返回 binary MP4。

---

# 16. Error Contract

统一：

```json
{
  "error": {
    "code": "MODEL_DURATION_LIMIT",
    "message": "Requested duration exceeds model limit.",
    "retryable": false
  }
}
```

至少支持：

```text
AUTH_FAILED
MODEL_NOT_FOUND
MODEL_UNAVAILABLE
INVALID_INPUT
UNSUPPORTED_FEATURE
UNSUPPORTED_INPUT_ROLE
UNSUPPORTED_MEDIA_TYPE
INPUT_TOO_LARGE
MODEL_DURATION_LIMIT
IDEMPOTENCY_CONFLICT
QUEUE_FULL
GENERATION_FAILED
GENERATION_TIMEOUT
SUBMISSION_STATE_UNKNOWN
OUTPUT_MISSING
INTERNAL_ERROR
```

软件只依赖稳定 error code，不解析 Provider 文本。

---

# 17. 超过 15 秒

默认：

```text
duration <= model max → 正常提交
duration > model max  → MODEL_DURATION_LIMIT
```

除非未来软件显式请求：

```text
continuationMode = AUTO_CONTINUE
```

Adapter 不得默认把 30 秒叙事任务自动复制同一个 prompt 分段。

叙事型长视频应由软件 / Workflow 做 Shot Plan，再产生多个 GenerationTask。

---

# 18. Artifact 存储与安全

生成输出不要求一律写入 Mission Workspace。

软件提供两个正式存储域：

```text
APP_ARTIFACT_STORE
MISSION_WORKSPACE
```

## 18.1 APP_ARTIFACT_STORE

用于：

```text
普通 Chat
没有 Workspace 的独立生成任务
可被后续 Mission / Workflow 引用的通用媒体 Artifact
```

由 Main 管理应用私有受控目录。

Renderer 和 Provider Adapter 都不能获得任意文件系统写权限。

## 18.2 MISSION_WORKSPACE

仅在：

```text
Mission / Workflow 已显式绑定 Workspace
且 Output Contract 要求文件落入该 Workspace
```

时使用。

不得为了生成输出而伪造一个临时 Mission Workspace。

## 18.3 输出提交流程

Provider output 下载后先进入 Main 管理的受控 staging：

1. 下载到 run-scoped staging；
2. canonicalize staging path；
3. 验证 MIME / extension；
4. 验证 size；
5. 读取可靠 metadata；
6. 计算 hash；
7. 按 `GenerationTask.outputDestination.scope` 原子提交到：
   - App Artifact Store；或
   - 允许的 Mission Workspace；
8. 注册 Artifact；
9. 持久化 `outputArtifactIds`；
10. 再标 GenerationJob `COMPLETED`。

```text
Provider status = completed
≠
软件 Artifact 已安全完成
```

任何下载、校验、commit、Artifact registration 失败：

```text
GenerationJob 不得进入 COMPLETED
```

Provider Adapter 不接收软件绝对 Workspace 路径，也不直接向软件 Workspace 写文件；Adapter 只提供受控 upload / job / download 协议。

---

# 19. Security

- Credential 继续 Main-only + safeStorage。
- Renderer 不读取 H3 API key。
- 上传输入文件前仍经过 Workspace / App Artifact Store / Artifact policy。
- Provider URL 使用已有安全 URL policy。
- `http://127.0.0.1:*` 可作为 localhost exception。
- Provider 返回 URL 不由 Renderer 任意 fetch。
- 下载由 Main/Adapter client 完成。
- Output 不作为 system/user instruction。

---

# 20. Telemetry / Audit

至少记录：

```text
generation.task_created
generation.job_submitted
generation.job_queued
generation.job_running
generation.job_completed
generation.job_failed
generation.output_registered
```

Audit 不记录 Credential、文件二进制或完整参考素材。

---

# 21. 软件侧实施拆分

建议未来以三个阶段落地：

```text
G1 — Generation Foundation
G2 — H3 Integration
G3 — Multimodal Collaboration
```

具体排期与当前 R3.2/R3.3/R4 总路线统一决定。

## G1

```text
MODEL_RUNTIME executionProtocol = GENERATION
GenerationModelDescriptor
GenerationTask + requiredFeatures
GenerationInputBinding
GenerationGateway
GenerationJob persistence
App Artifact Store / Mission Workspace output commit
Artifact output registration
async recovery
```

## G2

```text
H3 Adapter client
health
descriptor
upload
submit
poll
download
single-chat UX
availability
```

## G3

```text
Party Collaboration
Workflow-compatible ExecutionTask
generation review handoff
image/music provider compatibility fixtures
```

---

# 22. 软件侧验收

必须覆盖：

- Single Chat：纯 prompt → H3 → MP4。
- First Frame：image Artifact + FIRST_FRAME → H3 → MP4。
- Collaboration：Language Teammate → GenerationTask → H3 → MP4 Artifact → Coordinator resumes。
- Restart：submit 后应用退出，重启后使用同一 logical job / providerJobId，不重复生成。
- Idempotency：同一 key + 同一 payload 重试不重复 GPU 任务；同一 key + 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。
- Feature Eligibility：缺少 requiredFeature 时在提交前 deterministic reject；Adapter 同时 fail closed。
- Availability：GPU offline → H3 UNAVAILABLE。
- Explicit User Selection：显式指定 offline H3 不静默改派。
- Artifact Safety：invalid/missing output 不得 job COMPLETED。
- Artifact Storage：普通 Chat 输出可以安全落入 App Artifact Store；绑定 Workspace 的 Mission/Workflow 可按 contract 落入 Mission Workspace。

---

# 23. Non-goals

首版不做：

```text
ComfyUI 通用节点编辑器
在软件里暴露 H3 workflow 名称
任意 Provider-specific UI
自动启动/关闭云 GPU
批量 GPU scheduler
通用媒体编辑器
长视频自动导演
无限 generation retry
```

---

# 24. v0.2 修订摘要

本次不改变 v0.1 的主要架构方向，只修正四个长期兼容性问题：

```text
1. 不新增 MEDIA_GENERATOR executorKind
   → 普通生成模型仍是 MODEL_RUNTIME
   → 使用 sealed executionProtocol = GENERATION

2. GenerationTask 增加 requiredFeatures
   → Capability 与 Feature eligibility 明确分层
   → Feature 不扩张 Benchmark

3. 幂等责任明确落在 Provider Adapter Contract
   → 不假定未来上游 Provider 原生支持
   → Adapter 必须用原生能力或 durable mapping 保证

4. Artifact 输出不强制依赖 Mission Workspace
   → 普通 Chat 使用 App Artifact Store
   → 有显式 Workspace 的 Mission/Workflow 可提交到 Mission Workspace
```

MiniMax H3 的现有 `/health / models / files / videos / status / download` API 形态继续保留；Provider Adapter 需要按本修订加强 idempotency、feature validation 和“只提供下载、不直接写软件 Workspace”的边界。

---

# 25. 最终体验

用户：

```text
“幻影，用这张图生成一个 5 秒宣传视频。”
```

或其他 Agent：

```text
“幻影，请根据 storyboard scene 03 和 hero image 生成镜头。”
```

软件内部统一为：

```text
Intent
↓
GenerationTask
├─ Capability
├─ requiredFeatures
├─ Artifact Inputs
└─ outputDestination
↓
Capability / Feature Eligibility
↓
Availability
↓
GenerationGateway
↓
Durable GenerationJob
↓
Provider Adapter idempotent submission
↓
Main staging + safe Artifact commit
↓
App Artifact Store / Mission Workspace
↓
Output Artifact
↓
Chat / Mission / Workflow Resume
```
