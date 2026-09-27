# AI-Agent-Cultivation 智能路由、动态能力与 Human Bridge 实施计划

## Intelligent Routing & Human Bridge Architecture v0.4

- 日期：2026-09-27
- 基线：`main@5a946973`（Windows V1 Alpha Approved）
- 定位：在真实 Provider 验收与 V1 Release Hardening 前完成的最后一次架构级增强
- 核心目标：把“谁来做、用什么能力做、何时需要用户本人介入”从生成式模型的隐式判断，升级为**可解释、可校准、可持续学习**的 Harness 能力。

---

# 0. 最终目标

现有系统已经具备：

```text
Persistent Teammate
+ Replaceable Runtime
+ Memory / Skill
+ Mission Runtime
+ Permission / Tool / MCP
+ Party Collaboration
+ Experience / Capability history
```

本计划增加：

```text
Decision Plane
+ Multi-dimensional Capability Profile
+ Dynamic Capability Learning
+ Human Bridge Teammate
+ Routing Policy
```

目标架构：

```text
User Request
    ↓
Task Capability Analysis
(Jev / Decision Gateway)
    ↓
Deterministic Eligibility
    ↓
Capability + Experience Routing
    ↓
Teammate
 ┌──────────────┴──────────────┐
 ▼                             ▼
MODEL_RUNTIME               USER_BRIDGE
 ▼                             ▼
LLM / Tool / MCP           ExternalWorkRequest
 ▼                             ▼
Artifact / Result          User external software
 └──────────────┬──────────────┘
                ▼
             Mission
                ↓
          User Evaluation
                ↓
     Dynamic Capability Update
                ↓
       Better next routing
```

---

# 1. 不变量

## 1.1 Teammate 仍然不等于 Model

```text
Teammate ≠ Runtime ≠ Model ≠ Provider
```

公共 Benchmark 属于 **Runtime / Model**。

真实任务积累属于 **Teammate**。

路由看到的最终能力是二者的组合。

## 1.2 Jev 不是新的生成 Provider

Jev 属于独立 `DecisionGateway`。

不得塞进现有 `ModelGateway`。

Jev 负责：

- 语义分类；
- 需求能力识别；
- Choice / Score / Noul 类型判断；
- 路由建议；
- shortlist / rerank；
- completion/review advisory。

Jev 不负责：

- 文本/图片/音频内容生成；
- 权限授权；
- 文件边界；
- Mission 状态机；
- 精确算术；
- 强安全判断。

## 1.3 Code 保留 Authority

必须始终由确定性代码控制：

```text
Mission State
Permission
Tool Validation
Filesystem Boundary
Budget
Executor Eligibility
Fallback Policy
Routing hard constraints
```

Decision Model 可以让系统更谨慎，但不得把 `ASK / DENY` 自动降级为 `ALLOW`。

## 1.4 Human Bridge 是正式 Teammate

特殊道友不是假的 Provider，也不是聊天消息转发器。

它是：

```text
Teammate
executorKind = USER_BRIDGE
routingPolicy = FALLBACK_ONLY
```

与普通 Teammate 一样拥有 Identity、Memory、Skills、Experience、Capability、Party membership 和 Mission history；区别仅在执行通过：

```text
ExternalWorkRequest → User → Artifact → Resume Mission
```

---

# 2. 新增核心领域对象

## 2.1 TeammateExecutor

```ts
type ExecutorKind = 'MODEL_RUNTIME' | 'USER_BRIDGE';

type RoutingPolicy = 'NORMAL' | 'FALLBACK_ONLY' | 'MANUAL_ONLY';
```

普通道友：`MODEL_RUNTIME + NORMAL`。

特殊道友：`USER_BRIDGE + FALLBACK_ONLY`。

## 2.2 CapabilityDimension

V1 建议统一维度：

```text
GENERAL_REASONING
LONG_CONTEXT_REASONING
AGENTIC_EXECUTION
CODING
TOOL_USE

VISUAL_UNDERSTANDING
IMAGE_GENERATION
IMAGE_EDITING

VIDEO_GENERATION
VIDEO_EDITING

SPEECH_UNDERSTANDING
SPEECH_GENERATION
SPEECH_TO_SPEECH
MUSIC_GENERATION
```

后续可扩展：

```text
DATA_ANALYSIS
SCIENTIFIC_REASONING
DOCUMENT_REASONING
WEB_RESEARCH
```

每个维度用户界面最终只显示一个 `0–100` 当前分数。

内部必须区分：

```text
supported = false
```

与：

```text
supported = true
score = 20
```

“不能做”不能等价于“做得很差”。

## 2.3 ModelBenchmarkProfile

绑定 Runtime / Model Alias，而不是 Teammate。

```ts
ModelCapabilityBenchmark {
  runtimeProfileId
  dimension
  supported
  normalizedScore        // 0..100
  rawScore?
  source
  benchmark
  benchmarkVersion
  snapshotDate
  sourceUrl?
  provenanceType         // CATALOG / USER_OVERRIDE / USER_ESTIMATE
}
```

公共榜单只是冷启动先验，不是真实用户环境下的最终能力。

## 2.4 TeammateCapabilityState

代表某个道友在当前个人环境中的动态能力。

```ts
TeammateCapabilityState {
  teammateId
  dimension
  currentScore
  evidenceWeight
  ratingCount
  currentRuntimeProfileId?
  updatedAt
}
```

`currentScore` 是路由系统读取的唯一动态分数。

## 2.5 CapabilityEvidence

所有动态变化必须有事实来源。

```ts
CapabilityEvidence {
  id
  teammateId
  runtimeProfileId
  missionId
  runId
  dimension
  sourceType
  ratingValue
  demandWeight
  evidenceWeight
  createdAt
}
```

首版 `sourceType`：

```text
USER_DIMENSION_RATING
USER_OVERALL_RATING
```

未来可增加：

```text
PRIVATE_EVAL
VERIFIED_TASK_RESULT
```

但 V1 不允许模型自己给自己打能力分。

## 2.6 TaskCapabilityDemand

Decision Plane 对一个任务的结构化理解。

```ts
TaskCapabilityDemand {
  dimension
  probability
  required
}
```

例如：

```text
VIDEO_GENERATION  0.97 required=true
MUSIC_GENERATION  0.82 required=true
GENERAL_REASONING 0.43 required=false
CODING            0.03 required=false
```

## 2.7 DecisionReceipt

所有影响路由的智能判断必须可追踪。

```ts
DecisionReceipt {
  id
  missionId?
  runId?
  decisionType
  provider
  model
  modelVersion
  questionVersion
  stateHash
  inputSummary
  answersJson
  confidenceJson
  policyVersion
  selectedAction?
  mode             // SHADOW / ADVISORY / ACTIVE
  createdAt
}
```

不得保存无必要的原始 private Memory / file 内容。

## 2.8 ExternalWorkRequest

Human Bridge 的正式执行对象。

```ts
ExternalWorkRequest {
  id
  missionId
  runId
  requesterTeammateId
  assigneeTeammateId
  capability
  title
  prompt
  requirementsJson
  targetArtifactsJson
  acceptanceCriteriaJson
  state
  createdAt
  submittedAt?
  resolvedAt?
}
```

状态：

```text
PENDING
IN_PROGRESS
SUBMITTED
ACCEPTED
REJECTED
CANCELLED
```

---

# 3. Benchmark Catalog

创建 Runtime / Model 时必须能填写多维 Benchmark。

## 3.1 数据来源原则

优先使用：

- Artificial Analysis Intelligence Index
- Artificial Analysis Coding Agent Index
- AA-LCR
- Artificial Analysis Image Arena
- Artificial Analysis Video Arena
- Artificial Analysis Speech / TTS / Speech-to-Speech
- Artificial Analysis Music Arena
- 其他领域成熟 benchmark

Benchmark Catalog 必须：版本化、保留 raw score、snapshot date、source URL 和 model alias。

不得只保存一个最终数字。

## 3.2 归一化

不同榜单原始尺度不可直接比较，例如 Intelligence Index、百分比、Elo、pass@1。

统一显示为 `0–100`。

首版采用**榜单快照内相对百分位/排名归一化**，避免直接 min-max 混合不同尺度。

含义近似：

```text
95 → 当前该领域 benchmark population 中非常强
50 → 中位附近
10 → 明显较弱
```

原始分数永久保留，可随 normalization 算法变化重新计算。

## 3.3 用户覆盖

系统识别 model alias 时自动建议 Benchmark Profile，用户可覆盖。

UI 显示：

```text
系统参考：92
你的设置：87
来源：Artificial Analysis · Coding Agent Index vX
```

系统不得静默覆盖用户配置。

---

# 4. 动态能力评分

静态 Benchmark 只作为**先验**。

每次真实任务完成后，通过用户评价逐渐修正当前能力。

## 4.1 用户反馈 UX

Mission 结束后出现非阻塞评价卡。

只评价：

```text
实际参与的 Teammate
+
本 Mission 实际涉及的 1–3 个主要 CapabilityDimension
```

默认快速模式：

```text
整体表现：
1 2 3 4 5
```

系统把整体评价投影到主要能力维度。

高级模式允许用户分别调整：

```text
编程              ★★★★☆
长上下文推理      ★★★★★
工具使用          ★★★☆☆
```

评价可跳过，不阻塞 Mission 完成。

## 4.2 评分映射

首版：

```text
1 → 0
2 → 25
3 → 50
4 → 75
5 → 100
```

显式单维评价权重高于从整体评价投影出的维度分。

## 4.3 更新模型

不要使用简单平均，也不要一次差评让能力骤降。

对每个维度维护：

```text
Benchmark Prior B
Prior Strength P
User Evidence E
```

个人评价均值：

```text
U = Σ(weight_i × rating_i) / Σ(weight_i)
```

当前分数：

```text
alpha = E / (P + E)

CurrentScore =
  (1 - alpha) × BenchmarkScore
  + alpha × UserEvidenceMean
```

其中：

```text
evidenceWeight
=
taskDemandWeight
× ratingConfidence
```

原则：

- 新模型：Benchmark 占主导；
- 真实评价逐渐增多：用户自己的经验逐渐占主导；
- 少量极端评价不能瞬间改写模型画像；
- 所有参数必须配置化并记录 `scoringPolicyVersion`；
- 首版不引入复杂机器学习。

## 4.4 Runtime Migration

用户更换道友底层模型时：

```text
Teammate identity / Skill / Memory / Experience 不变
Benchmark Prior 改为新 Runtime 的 profile
```

历史 CapabilityEvidence 不删除，并记录 `runtimeProfileId`。

路由计算时：

```text
当前 Runtime 产生的证据 = full weight
历史 Runtime 证据 = transfer weight
```

`transferWeight` 必须配置化、通过 Shadow 数据校准，不写死为产品真理。

原因：长期 Skill / Memory 能迁移，但底层模型能力已经改变。

## 4.5 Human Bridge 动态分数

Human Bridge 所有用户启用的能力初始：

```text
score = 1
```

仍可记录真实评价并动态变化。

但：

```text
routingPolicy = FALLBACK_ONLY
```

保证即使动态分数升高，也不会自动击败正常 `MODEL_RUNTIME` 候选。

---

# 5. Human Bridge 特殊道友

## 5.1 生命周期

首次安装自动创建一个系统 Teammate：

```text
本尊 / Human Bridge
```

建议：

- 不允许删除；
- 可以改显示名称、头像；
- ExecutorKind 不允许修改；
- RoutingPolicy 默认锁定 `FALLBACK_ONLY`；
- 用户可以配置其可用外部能力。

## 5.2 外部能力

用户配置：

```text
☑ IMAGE_GENERATION
☑ IMAGE_EDITING
☐ VIDEO_GENERATION
☑ MUSIC_GENERATION
☐ SPEECH_GENERATION
```

可选记录外部工具：

```text
ChatGPT Plus
Suno
Midjourney
Photoshop
DaVinci Resolve
...
```

这些记录不是 Provider，不保存 API Key，只用于生成更合适的 ExternalWorkRequest。

## 5.3 External Work Flow

示例：Mission 需要 30 秒音乐。

```text
Coordinator
↓
发现 MUSIC_GENERATION 硬需求
↓
普通 MODEL_RUNTIME 无 eligible candidate
↓
Router 选择 Human Bridge
↓
生成 ExternalWorkRequest
↓
Mission → WAITING_EXTERNAL_WORK
↓
Windows 系统通知 + 应用内待办
↓
用户打开外部软件生成
↓
放入指定 Workspace 路径
↓
用户提交
↓
Artifact validation
↓
ExternalWorkRequest ACCEPTED
↓
原 Mission/Run Resume
↓
Coordinator / Party 继续
```

## 5.4 通知规则

Windows Notification 只显示：

```text
“有一项外部工作等待处理”
任务标题
```

禁止在锁屏通知中显示完整 Prompt、private Memory、文件内容或项目敏感信息。

完整请求只在应用内打开。

## 5.5 Artifact

ExternalWorkRequest 应明确：目标文件位置、格式、数量、尺寸/时长、验收条件、参考文件。

提交时至少验证：

```text
文件存在
路径仍在 Workspace
扩展名
文件大小
基本 metadata（能力允许时）
```

复杂质量判断仍由 Coordinator / Reviewer 或用户完成。

## 5.6 Mission State

新增：

```text
WAITING_EXTERNAL_WORK
```

不要复用 `WAITING_APPROVAL`。

```text
Approval = 是否允许执行
External Work = 等待用户完成工作
```

重启后必须保持并可恢复。

---

# 6. Decision Plane / Jev

## 6.1 Port

新增：

```ts
interface DecisionGateway {
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}
```

Adapter：`TypeSafeDecisionGateway`。

领域与 Application 层不得出现 TypeSafe/Jev 专有类型。

## 6.2 Jev 第一实现

首版：

```text
@typesafe-ai/sdk
jev-1.13.0
```

固定版本，不使用移动的 `latest` 作为生产路由依据。

## 6.3 Jev 适合做什么

P0：

```text
Task capability demand
Need collaboration?
Need review?
Teammate semantic fit
Skill relevance
```

P1：

```text
Memory pre-gate
Memory rerank
Tool shortlist
Runtime complexity tier
Completion/review advisory
```

## 6.4 Jev 不做什么

禁止：

```text
Permission final decision
Capability score arithmetic
Budget calculation
Mission transition
Filesystem decision
Secret / credential handling
```

## 6.5 Minimal State

每种 Decision 必须有独立 `DecisionStateBuilder`，只发送最小必要信息。

例如 Teammate Routing：

```text
User request
candidate IDs
role summaries
capability summary bands
enabled skill summaries
recent verified experience summary
```

默认不发送：

```text
API key
raw private Memory
full files
full Mission history
tool secret output
```

---

# 7. Routing Pipeline

## 7.1 Stage A：明确用户指定

用户明确指定某 Teammate：直接使用。

除非该执行方式事实上无法满足硬能力要求，应明确提示而不是偷偷换人。

## 7.2 Stage B：Task Capability Analysis

Jev 将自然语言请求转为 `TaskCapabilityDemand[]`，使用 atomic Noul/Choice 问题。

Jev 不进行精确分数运算。

## 7.3 Stage C：Deterministic Eligibility

代码首先过滤：

```text
Teammate ACTIVE
Executor available
Runtime available
Capability supported
required modality satisfied
Party/member constraints
Permission/policy constraints
```

`USER_BRIDGE + FALLBACK_ONLY` 暂时排除。

## 7.4 Stage D：Capability Utility

代码根据 `TaskCapabilityDemand × Teammate Current Capability Score` 计算候选 Utility。

基础形式：

```text
Utility(candidate)
=
Σ(
  normalizedDemandWeight[d]
  × currentCapabilityScore[candidate,d]
)
```

禁止让 Jev 自己比较大量原始分值。

## 7.5 Stage E：Semantic Tie-break / Fit

对于 Utility 接近的 Top-K，可让 DecisionGateway 判断哪个候选的角色 / Skill / Experience 与当前请求更匹配。

低 confidence 时保留代码排序或让用户选择。

## 7.6 Stage F：Human Bridge Fallback

只有以下情况进入 Human Bridge：

```text
用户明确指定
OR
所有正常 MODEL_RUNTIME 对某硬需求均 unsupported / unavailable
```

然后检查 Human Bridge 是否启用该 capability。

若也没有，则明确告诉用户当前队伍没有可执行该任务的能力，不得伪造执行。

---

# 8. Collaboration 与 Jev

现有 Gate 5 把“找谁”和“让他做什么”混在生成模型中。

改成：

```text
Coordinator LLM
↓
产生 capability gap / subtask
↓
Decision Plane 判断：
  need collaboration?
  target capability?
↓
Deterministic Router 选 candidate
↓
Permission INVITE_TEAMMATE
↓
User Approval
↓
Target executes
```

生成式 LLM 仍负责具体子任务说明、Prompt / expected artifact、复杂上下文表达。

Decision Plane 负责是否协作、谁更匹配、是否需要 Review。

---

# 9. Skill / Memory / Tool Harness 优化

以下能力必须在 Routing 基础稳定后逐步启用。

## 9.1 Skill Routing

```text
enabled Skills
↓
deterministic candidate filter
↓
Decision Plane shortlist
↓
Top 1–3
↓
PromptComposer
```

目标：道友未来拥有几十/几百个功法时避免 context rot。

## 9.2 Memory Gate

```text
Conversation evidence
↓
Jev:
值得长期记忆？
属于 preference/fact/procedure/episode？
↓
低价值 → skip expensive extraction
高价值 → existing MemoryCandidateExtractor
↓
PROPOSED
```

Jev 不直接生成 Memory 内容。

## 9.3 Memory Rerank

```text
FTS / sqlite-vec Top 20
↓
Decision rerank
↓
Top 4–6
↓
PromptComposer
```

Owner scope 过滤仍必须发生在任何 Decision 调用之前。

## 9.4 Tool Shortlist

```text
ToolRegistry
↓
deterministic eligibility
↓
Decision shortlist
↓
Top K tools
↓
Generative model chooses tool + args
↓
ToolRuntime
↓
PermissionEngine
```

Decision Model 永远不能绕过 ToolRuntime / Permission。

---

# 10. Capability Feedback Loop

形成完整闭环：

```text
Benchmark Catalog
↓
Cold-start Capability Score
↓
Decision Routing
↓
Mission
↓
Experience
↓
User Evaluation
↓
CapabilityEvidence
↓
Dynamic Score
↓
Better Routing
```

这是后续产品最重要的长期数据资产之一。

---

# 11. SQLite 计划

从当前 migration 8 开始。

建议新增：

```text
0009_routing_foundation.sql
```

表：

```text
model_capability_benchmarks
teammate_capability_states
capability_evidence
decision_receipts
external_work_requests
external_work_artifacts
external_app_profiles
```

给 `teammates` 增加：

```text
executor_kind
routing_policy
system_kind?
```

Mission state schema 增加：

```text
WAITING_EXTERNAL_WORK
```

所有新事实型表优先 append-only 或具备清晰 lifecycle。

---

# 12. 隐私与安全

## 12.1 Decision Cloud 明示

Settings：

```text
Decision Provider
[ ] 启用 TypeSafe Jev 云端决策
```

必须明确会发送什么、不会发送什么。

## 12.2 Shadow Mode 默认

考虑中文/CJK 准确率和产品尚未拥有自己的 calibration 数据，首版 Jev 默认：

```text
SHADOW
```

记录建议，不改变行为。

达到内部 eval 门槛后才允许：

```text
ADVISORY
ACTIVE
```

## 12.3 Decision Failure

任何 timeout、network error、schema error、low confidence、provider unavailable 都必须 fallback 到当前确定性 / 原有 Harness 行为，不得阻塞 Mission。

---

# 13. 中文 Eval

必须建立自己的中英混合 routing set。

最低包含：

```text
中文任务
英文任务
中英混合任务
模糊任务
多能力任务
纯图片生成
纯视频生成
纯音乐生成
代码
研究
长文档
Tool/MCP
需要多人协作
不需要多人协作
明确指定道友
需要 Human Bridge fallback
```

指标：

```text
Capability demand accuracy
Top-1 teammate agreement
Top-2 recall
Human Bridge fallback precision
Unnecessary collaboration rate
Low-confidence calibration
Latency
Cost
```

Jev 未通过自己的 Eval 前，不开启自动路由。

---

# 14. 实施阶段

## R0 — Routing Foundation

只建立领域和数据基础，不改变现有 Mission 行为。

实现：

- ExecutorKind / RoutingPolicy
- CapabilityDimension
- Benchmark Profile
- Capability State / Evidence
- DecisionGateway
- DecisionReceipt
- ExternalWorkRequest domain
- migration 0009
- benchmark catalog skeleton

完成后停止评审。

## R1 — Dynamic Capability + Feedback

实现：

- Runtime Benchmark 表单
- Benchmark Catalog reference
- 0–100 normalized score
- Mission 完成评价卡
- per-dimension evidence
- 动态评分计算
- Runtime Migration score recomposition
- Capability UI

验证：

```text
新模型以 benchmark 为主
多次用户评价逐步改变当前 score
单次极端评分不会剧烈漂移
切 Runtime 后 benchmark 立即改变
历史 evidence 保留且按 policy transfer
```

完成后停止评审。

## R2 — Human Bridge

实现：

- 自动创建 Human Bridge
- Capability toggles
- external app profiles
- `WAITING_EXTERNAL_WORK`
- ExternalWorkRequest
- Windows notification
- in-app task center
- artifact submission / validation
- Mission resume

验证完整：

```text
Party 发现需要音乐
→ 无普通 candidate
→ Human Bridge
→ 用户收到系统通知
→ 完成外部生成
→ artifact 放入 Workspace
→ 提交
→ Mission 原 Run 继续
→ 其他成员继续工作
```

完成后停止评审。

## R3 — Jev Shadow Decision Plane

实现：

- TypeSafeDecisionGateway
- 固定 `jev-1.13.0`
- TaskCapabilityDemand
- teammate semantic fit
- need collaboration / review
- DecisionReceipt
- shadow logging
- Chinese/English eval harness

要求：

```text
不改变正式路由
不改变 Permission
不阻塞 Mission
```

完成后以真实 Eval 结果决定是否推进 R4。

## R4 — Controlled Routing Activation

只有 R3 达标后开启。

顺序：

1. Teammate recommendation
2. Human Bridge fallback
3. Skill routing
4. Collaboration target routing

自动路由必须有：

```text
confidence threshold
fallback
user override
DecisionReceipt
```

低 confidence：只建议，不自动执行。

## R5 — Harness Optimization

在前述稳定后再启用：

- Memory pre-gate
- Memory rerank
- Tool shortlist
- Runtime complexity routing
- completion/review advisory

本阶段完成后重新进入：

```text
Alpha Stabilization
→ Real Provider Acceptance
→ V1 Release Hardening
```

---

# 15. 关键验收场景

至少覆盖：

1. Model Benchmark Profile 属于 Runtime，不属于 Teammate。
2. Runtime Migration 改 benchmark prior，但 Teammate Identity/Memory/Skill/Experience 不变。
3. 用户连续评价后能力分数可解释地动态变化。
4. 被跳过评价的 Mission 不伪造 evidence。
5. unsupported capability 永远不会因分数被路由。
6. Human Bridge 默认 fallback-only。
7. 正常候选存在时 Human Bridge 不自动抢占任务。
8. 所有正常候选缺失硬能力时 Human Bridge 可被选中。
9. Human Bridge capability 未启用时明确失败，不伪造结果。
10. ExternalWorkRequest 不进入 Chat message。
11. Windows notification 不泄漏完整 Prompt。
12. 重启后 `WAITING_EXTERNAL_WORK` 可恢复。
13. Artifact 必须位于 Workspace 允许位置。
14. Jev failure 不阻塞 Mission。
15. Jev 不影响 PermissionEngine authority。
16. Jev shadow receipt 不含 raw private Memory。
17. 中文 routing eval 达标前不可 ACTIVE。
18. Skill routing 不注入非选中 Skill。
19. Memory rerank 前必须完成 owner scope filter。
20. Tool shortlist 不能绕过 ToolRuntime。
21. User explicit teammate selection 优先。
22. Routing decision 可从 Receipt 重放/解释。
23. 动态能力变化有完整 evidence provenance。
24. Human Bridge 执行也可形成真实 Experience，但未执行/取消不得获得成功经历。

---

# 16. V1 范围限制

本计划完成前后仍不进入：

- Browser / Computer Use
- Shell autonomous execution
- Scheduler
- Marketplace
- Cloud sync
- Web
- 自动境界晋级
- LLM 自评能力
- 自动修改 Benchmark
- 无界 Agent recursion

---

# 17. 参考资料

当前方案参考以下公开资料，Benchmark 仅作为冷启动先验，真实路由最终应由用户自己的 Experience/Evaluation 校准。

## TypeSafe / Jev

- TypeSafe — Introducing System One Models & Jev — https://typesafe.ai/blog/introducing-system-one-models-and-jev
- TypeSafe Documentation — https://docs.typesafe.ai/
- TypeSafe JavaScript SDK — https://docs.typesafe.ai/sdk/javascript

## Benchmark Catalog

- Artificial Analysis Intelligence Index — https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index
- Artificial Analysis Intelligence Benchmarking Methodology — https://artificialanalysis.ai/methodology/intelligence-benchmarking
- Artificial Analysis Long Context Reasoning — https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning
- Artificial Analysis Coding Agent Index — https://artificialanalysis.ai/agents/coding-agents
- Artificial Analysis Image / Video / Speech / Music leaderboards — https://artificialanalysis.ai/

---

# 18. 最终产品闭环

完成本计划后，AI-Agent-Cultivation 的核心将从：

```text
“选择一个模型完成任务”
```

升级为：

```text
任务被理解成能力需求
↓
系统知道每个模型理论上擅长什么
↓
系统知道每个道友过去实际做得怎么样
↓
Decision Plane 理解当前任务
↓
Routing Policy 选择最合适的执行者
↓
没有合适模型时用户本人作为 Human Bridge 接手
↓
任务完成
↓
用户评价
↓
能力画像更新
↓
下一次路由更准确
```

最终形成：

```text
Benchmark = 冷启动天赋
Skill = 功法
Memory = 记忆
Experience = 历练
User Evaluation = 实战反馈
Dynamic Capability = 当前实力
Decision Plane = 调度判断
Human Bridge = 主角本人
```

这才是“培养一支属于自己的 AI 队伍”在工程上的完整闭环。
