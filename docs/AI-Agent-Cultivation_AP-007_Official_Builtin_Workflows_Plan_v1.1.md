# AI-Agent-Cultivation AP-007
## Official Built-in Workflows Plan — AI 资讯视频 / 软件功能开发 / 科研
### Revision v1.1 — Contract / Revision Budget / Side-effect Recovery / Reference Basis

- 日期：2026-10-01
- 修订版本：v1.1
- 本次修订：补齐机器可校验 Artifact Contract、Grouped Revision Budget、明确 Revision Target、Side-effect Receipt/Recovery、Reference Basis 治理。
- 上位规划：`AI-Agent-Cultivation_AP-006_Unified_Post-R3_Roadmap_with_Workflow.md`
- 对应实施阶段：W2 — Built-in Workflow MVP
- 前置条件：R3.2、R3.3、R4、W1 已审批通过
- 本文目标：把三个首发官方 Workflow 从“场景名称”收敛为可实现、可测试、可版本化的正式规格。
- 首发 Workflow：
  1. AI 资讯视频
  2. 软件功能开发
  3. 科研

---

# 1. 官方 Workflow 的设计方法

三个官方 Workflow 统一采用：

```text
Reference-Derived
+
Architecture-Native
```

含义：

```text
成熟行业流程 / 学术系统 / 社区实践
↓
提取稳定共识步骤
↓
去除特定 Vendor / Provider / Model 绑定
↓
重构为 AI Agent Cultivation 原生：
Step
Capability
Routing
Mission
Artifact Contract
Review
Decision
Human Bridge
Permission
Checkpoint
↓
真实任务验收
```

禁止：

```text
复制某个 n8n / ComfyUI / GitHub / SaaS Workflow
然后直接翻译成节点
```

官方 Workflow 必须吸收“流程知识”，但执行能力只能来自本项目自己的 Runtime。

## 1.1 Reference Basis 治理

`Reference-Derived` 不能只停留在口号。

每个 Built-in Workflow 的每个 immutable version 必须同时附带：

```text
reference-basis.md
```

至少记录：

```ts
ReferenceBasisEntry {
  title: string
  organizationOrCommunity?: string
  referenceType:
    | "INDUSTRY_PRACTICE"
    | "ACADEMIC_METHOD"
    | "STANDARD_OR_GUIDE"
    | "COMMUNITY_PRACTICE"
  uri?: string
  retrievedAt?: datetime
  adoptedPrinciples: string[]
  intentionallyExcludedMechanisms?: string[]
  notes?: string
}
```

要求：

1. Reference Basis 只说明“为什么采用这些稳定流程原则”，不把外部系统变成本项目运行依赖；
2. 不允许因为某个参考使用特定 Vendor / Model / SaaS，就把该绑定带入 Definition；
3. 必须区分：
   - `adopted principle`
   - `project-native implementation`
4. 若模板流程发生结构性变化，必须同步更新 Reference Basis 与 Design Rationale；
5. W2 发布前，Reference Basis 必须经过人工审查，不允许空文件或只有 URL 列表。

## 1.2 三个首发 Workflow 的初始 Reference Basis 范围

首版至少覆盖以下“流程知识族”，具体引用条目在 W2.0/W2.x 实施时固化到各版本 `reference-basis.md`：

### AI 资讯视频

```text
新闻编辑流程
来源分级与交叉核验
claim-level fact checking
编辑选题与叙事编排
脚本 → storyboard → asset → voice → assembly
发布前事实 / 视觉 / 技术 QA
```

不复制具体媒体机构 CMS、剪辑软件或发布平台流程。

### 软件功能开发

```text
需求澄清与可验证 acceptance criteria
repository/context analysis
implementation planning
workspace-bounded implementation
CI-style verification
independent code review
bounded fix/re-verify loop
delivery summary
```

不绑定 GitHub Flow、某个 Coding Agent、某个 CI SaaS 或特定代码托管平台。

### 科研

```text
research question framing
文献发现与筛选
证据抽取与 provenance
gap / hypothesis
experiment design
reproducible execution
analysis with negative results
claim-evidence traceability
scientific review
```

不把 Workflow 声称为替代系统综述规范、学术伦理审批或领域专家判断。

---

# 2. 三个 Workflow 的产品定位

| Workflow | 核心形态 | 重点验证 |
|---|---|---|
| AI 资讯视频 | 内容生产 | Web Research、事实核验、多 Agent、Artifact、音频/视频 Tool、Human Bridge、Review |
| 软件功能开发 | 工程生产 | Workspace、Coding、Tool/MCP、Plan、Test、Independent Review、Retry |
| 科研 | 知识发现 | 文献证据、假设、实验、数据分析、有界科研循环、Human Bridge、Scientific Review |

三个 Workflow 不应只是三个不同 Prompt。

它们必须覆盖三类明显不同的长期任务执行模式：

```text
内容生产
工程生产
知识发现
```

---

# 3. 共用 Workflow 约束

## 3.1 Step 类型

首发模板只使用 W1 已定义的：

```text
TASK
REVIEW
DECISION
```

Human Bridge 不是独立 Step 类型。

Human Bridge 是：

```text
TASK / REVIEW 的合法执行者
```

可能来自：

```text
显式 execution constraint
或
R4 Routing fallback
```

## 3.2 Step 与 Mission

```text
一个 WorkflowStepRun
→ 最多绑定一个 Mission identity
→ Mission 内允许多个 MissionRun / Retry
```

需要多人执行时：

```text
Step
→ R4
→ Party Mission
```

Workflow 不自己实现第二套多 Agent Runtime。

## 3.3 Artifact-first

Step 之间默认通过 Artifact 交接。

禁止默认：

```text
把之前所有聊天内容
不断追加给后续模型
```

后续 Step 只获得：

```text
必要 Artifact
bounded summary
结构化 Decision / Review 结果
```

## 3.4 Artifact Contract 与机器校验

Artifact Contract 必须是一等、版本化、机器可执行的定义，不能只写在 Workflow 文档描述里。

建议：

```ts
ArtifactContract {
  key: string
  contractId: string
  contractVersion: string
  kind:
    | "JSON"
    | "TEXT"
    | "BINARY"
    | "DIRECTORY"
    | "WORKSPACE_CHANGESET"
  mediaType?: string
  required: boolean
  immutable?: boolean
  validator:
    | { type: "JSON_SCHEMA"; schemaRef: string }
    | { type: "TEXT_RULES"; rules: TextValidationRule[] }
    | { type: "FILE_METADATA"; rules: FileValidationRule[] }
    | { type: "DIRECTORY_MANIFEST"; manifestSchemaRef: string }
    | { type: "WORKSPACE_MANIFEST"; manifestSchemaRef: string }
}
```

结构化 Artifact：

```text
JSON Schema / 等价确定性 schema validator
```

建议使用仓库固定版本的 JSON Schema 方言，并在 build/test 时完成 schema compile。

文本 Artifact：

```text
存在性
编码
大小
必须章节 / machine-readable front matter（如定义）
```

文本内容的“质量”不由 schema 假装判断，仍交给 REVIEW / DECISION。

二进制 Artifact：

```text
media type
文件存在
大小
container / codec（需要时）
duration / dimensions（需要时）
hash
```

目录 / Workspace mutation：

```text
manifest
relative path
hash / before-after hash
declared output set
```

每次校验必须持久化：

```ts
ArtifactValidationReceipt {
  artifactId: string
  contractId: string
  contractVersion: string
  validatorVersion: string
  contentHash?: string
  valid: boolean
  errors: StructuredValidationError[]
  validatedAt: datetime
}
```

禁止：

```text
模型说“格式正确”
→ 直接视为 Artifact Contract validation PASS
```

## 3.5 Step Completion

每个 Step 必须满足：

```text
Mission terminal
+
required output Artifact 存在
+
Artifact Contract deterministic validation PASS
+
Exit Condition
+
若有副作用：Side-effect Receipt 已达到可安全提交状态
```

才能进入：

```text
COMPLETED
```

模型声称“完成了”不能直接完成 Step。

## 3.6 Review

所有 REVIEW 输出统一要求：

```ts
{
  verdict: "PASS" | "REVISE" | "FAIL",
  findings: [...],
  evidence: [...],
  summary: "...",
  reviewedArtifactIds: [],
  revisionCode?: string
}
```

其中：

- `verdict` 为正式 Workflow 控制输入；
- `revisionCode` 不是 Step ID；
- 当一个 REVIEW 的 `REVISE` 存在多个合法修订方向时，Definition 必须声明允许的 `revisionCode` enum；
- Workflow Engine 根据 `revisionCode → declared edge` 的静态映射决定目标；
- 未声明的 code、任意 Step ID、自由文本跳转全部拒绝。

长篇隐藏推理不保存。

## 3.7 Decision

DECISION 只能从 WorkflowDefinition 声明的分支中选择。

例如：

```text
PASS
REVISE
BLOCKED
```

允许：

```text
DETERMINISTIC
JEV_ASSISTED
```

即使使用 `JEV_ASSISTED`：

```text
Jev / Model
→ 只能返回声明过的 Decision enum
→ Domain validator
→ Workflow state transition
```

禁止：

```text
模型创建新的 Step
模型修改 Workflow Graph
模型自由跳转任意 Step
模型直接提交未声明的 revision target
```

## 3.8 有副作用 Step 的 Operation Receipt 与 Crash Recovery

只要 Step 可能产生 Workspace mutation、文件渲染、付费/外部动作、现实世界操作，就不能只依赖“Mission 是否完成”。

统一定义最小副作用记录：

```ts
StepOperationReceipt {
  workflowRunId: string
  stepRunId: string
  attempt: number
  operationKey: string
  effectType:
    | "NONE"
    | "FILE_OUTPUT"
    | "WORKSPACE_MUTATION"
    | "EXTERNAL_ACTION"
  state:
    | "PREPARED"
    | "APPLIED"
    | "VERIFIED"
    | "UNKNOWN"
  inputHash?: string
  mutationManifestArtifactId?: string
  outputArtifactIds?: string[]
  externalReference?: string
  startedAt: datetime
  completedAt?: datetime
}
```

执行规则：

```text
持久化 PREPARED
↓
执行真实副作用
↓
持久化 APPLIED + evidence
↓
Artifact / mutation validation
↓
VERIFIED
↓
Step Completion
```

Crash / Restart：

### `NONE`

允许按普通 Mission retry 规则恢复。

### `FILE_OUTPUT`

优先：

```text
临时目标
→ 校验
→ atomic rename / commit
```

重启时先检查既有 output hash / manifest；能验证已有结果则恢复，不重复生成。

### `WORKSPACE_MUTATION`

必须保存：

```text
affected paths
before hash（可获得时）
after hash
change manifest
```

若 `APPLIED` 后崩溃：

```text
先验证 Workspace 当前状态
```

禁止盲目再次执行 S05 / S10。

### `EXTERNAL_ACTION`

若系统无法确定外部动作是否已经发生：

```text
Receipt → UNKNOWN
Workflow → WAITING_USER
```

禁止自动重放可能产生重复副作用的动作。

Human Bridge 继续复用现有 durable continuation；其提交 Artifact 仍必须经过同样 Contract validation。

---

# 4. W2 需要增加的最小有界回环

三个正式 Workflow 都需要 Revision。

W1 不实现任意循环，因此 W2 只增加受限的“边 + Revision Group 总预算”。

```ts
BoundedRevisionGroup {
  id: string
  maxTotalTraversals: number
  onExhausted: "WAITING_USER" | "FAILED"
}

BoundedRevisionEdge {
  id: string
  fromStepId: string
  toStepId: string
  condition: string
  groupId?: string
  maxTraversals?: number
}
```

为什么必须有 Group：

```text
QA
├─ REVISE_STORYBOARD → N09
├─ REVISE_ASSETS     → N10
└─ REVISE_ASSEMBLY   → N12
```

如果只给每条 Edge 单独 `maxTraversals = 2`，理论上可能累计自动修订 6 次。

因此：

```text
Edge budget
+
Group total budget
```

必须同时满足。

计数规则：

1. 只有当 Decision / Review transition 被 durable commit 时才计数；
2. 应用重启恢复不得重复计数；
3. Retry 同一个尚未提交的 transition 不增加 traversal；
4. 任一 Edge 达到自身上限或 Group 达到总上限，都禁止继续自动回跳；
5. 超限后按 `onExhausted` 进入 `WAITING_USER` 或 `FAILED`；
6. 每次穿越写入 durable Decision fact，包含 `edgeId / groupId / traversalIndex / reason`；
7. 不支持动态创建循环；
8. 不支持无限 Agent loop。

首发模板建议固定以下 Revision Group：

| Group | 回环 | 总预算 |
|---|---|---:|
| `news.script_revision` | N08 → N07 | 2 |
| `news.final_qa_revision` | N13 → N09 / N10 / N12 | 2 |
| `software.plan_revision` | S04 → S03 | 2 |
| `software.fix_cycle` | S07/S09 → S10 → S06 | 3 |
| `research.hypothesis_revision` | R06 → R05 | 2 |
| `research.experiment_cycle` | R10 → R07 / R05 | `maxExperimentCycles`，且首版 ≤ 2 |
| `research.manuscript_revision` | R12 → R13 → R12 | 2 |

这不是通用 DAG/循环引擎。

它只用于：

```text
Review → Fix
Analysis → Refine Experiment
QA → targeted revision
```

---

# 5. Built-in Workflow 定义方式

官方模板不要散落在 UI 或 migration SQL 中。

建议：

```text
packages/workflows/builtin/
  ai-news-video/
    v1/
      definition.json
      reference-basis.md
      contracts/
        *.schema.json
  software-feature/
    v1/
      definition.json
      reference-basis.md
      contracts/
        *.schema.json
  research/
    v1/
      definition.json
      reference-basis.md
      contracts/
        *.schema.json

packages/workflows/contracts/
  common-review-result.schema.json
  common-operation-receipt.schema.json
  common-artifact-validation-receipt.schema.json
```

或语义等价结构。

要求：

1. 每个 Definition 有稳定 ID；
2. 每个版本 immutable；
3. Definition 引用的 Contract version 同样 immutable；
4. 应用启动时由 BuiltinWorkflowRegistry 注册；
5. DB 保存运行时绑定的 Definition ID + Version；
6. 新模板版本不修改旧 WorkflowRun；
7. Definition 与所有 Artifact Contract 在 build/test 阶段经过 schema validator；
8. `reference-basis.md` 与 Design Rationale 属于版本发布材料；
9. 内置模板和未来用户模板使用相同领域结构；
10. Artifact key、Contract ID、Contract Version 分离，禁止用物理文件名充当 schema identity。

---

# 6. Workflow 1 — AI 资讯视频

## 6.1 定位

本 Workflow 不是：

```text
Prompt
→ 视频生成模型
→ AI 视频
```

而是：

```text
新闻 / 科技资讯研究
→ 事实核验
→ 编辑策划
→ 脚本
→ 视觉素材
→ 配音
→ 程序化 / 外部剪辑
→ QA
→ 成片
```

首版完全不依赖 `VIDEO_GENERATION` 模型。

主要适用于：

```text
AI 新闻
科技周报
产品更新
行业资讯
研究动态
YouTube / Bilibili / Shorts 资讯视频
```

## 6.2 Workflow Inputs

```ts
AiNewsVideoInput {
  topicScope: string
  timeRange: { from: datetime; to: datetime }
  language: string
  targetPlatform: "YOUTUBE_LONG" | "YOUTUBE_SHORTS" | "BILIBILI" | "GENERIC"
  targetDurationSeconds: number
  targetStoryCount: { min: number; max: number }
  editorialStyle?: string
  sourcePreferences?: string[]
  excludedSources?: string[]
  narrationMode: "AUTO" | "MODEL_OR_TOOL" | "HUMAN"
  existingAssets?: ArtifactRef[]
}
```

限制：

- 时间范围必须明确；
- targetDuration 必须 bounded；
- 首版不允许无限新闻数量；
- 默认发布前必须用户确认。

## 6.3 最终输出

```text
final_video
source_attribution
final_script
storyboard
asset_registry
qa_report
production_summary
```

建议交付包：

```text
output/
  final.mp4
  script.md
  storyboard.json
  sources.json
  asset_registry.json
  qa_report.json
```

---

# 7. AI 资讯视频 — 用户可见阶段

UI 不展示十几层工程节点。

用户看到：

```text
1. 搜集
2. 核验
3. 策划
4. 脚本
5. 素材
6. 制作
7. 审核
```

内部仍保存完整 Step。

---

# 8. AI 资讯视频 — 内部 Step

## N01 — News Discovery

```text
Type: TASK
Required Capability: GENERAL_REASONING, TOOL_USE
```

目标：在明确时间范围和主题内发现候选新闻事件。

典型执行：Web/Search MCP、RSS、官方 Blog/Release、GitHub Release、论文检索、可信新闻站点。

社交媒体只作为 `discovery lead`，不能自动成为最终事实依据。

Output：`candidate_stories.json`

每个 Candidate 至少：

```text
id
title
eventDate
discoveredAt
discoverySource
url
entities
initialSummary
```

Exit：候选达到最低数量，且每个候选存在 source URL。

无 Research Tool 时：`WAITING_USER`，允许用户提供 sources Artifact。

## N02 — Deduplicate & Cluster

```text
Type: TASK
Required Capability: GENERAL_REASONING, LONG_CONTEXT_REASONING
```

Input：`candidate_stories.json`

Output：`story_clusters.json`

同一事件不能因为多篇转载被当成多条新闻。

Exit：所有候选均归属 cluster 或被明确 discarded。

## N03 — Source Research

```text
Type: TASK
```

Source 优先级：

```text
Primary / Official Source
↓
Independent Reliable Source
↓
Secondary Reporting
↓
Social Lead
```

Input：`story_clusters.json`

Output：`source_packets.json`

每条 Story：

```text
primarySources
independentSources
keyClaims
dates
numbers
attribution
sourceUrls
```

Exit：每条进入核验的 Story 至少有可追踪 Source。

## N04 — Fact Verification

```text
Type: REVIEW
```

Input：`source_packets.json`

Output：

```text
verification_report.json
verified_claims.json
```

Claim 状态：

```text
VERIFIED
SINGLE_SOURCE
CONFLICTING
UNVERIFIED
```

硬规则：

```text
UNVERIFIED → 不允许进入正式 Script
CONFLICTING → 默认不使用，或明确描述存在争议
```

## N05 — Story Selection & Editorial Angle

```text
Type: TASK
```

目标：形成真正的编辑角度，而不是把新闻逐条朗读。

Input：verified claims + source packets + Workflow brief。

Output：`editorial_plan.json`

至少：

```text
selectedStoryIds
storyOrder
editorialAngle
audienceValue
estimatedDuration
discardedStories + reason
```

考虑：Importance、Novelty、Audience relevance、Evidence strength、Narrative coherence、Visual potential。

## N06 — Beat Map

```text
Type: TASK
```

Output：`beat_map.json`

每个 Beat：

```text
purpose
storyId
targetDuration
keyClaims
transition
```

Exit：总时长接近目标，且所有 selected stories 被覆盖。

## N07 — Script Draft

```text
Type: TASK
```

Input：beat map + verified claims + editorial plan。

Output：

```text
script.md
script_claim_map.json
```

硬规则：不得新增 verified_claims 中不存在的事实型断言。

## N08 — Script Review

```text
Type: REVIEW
```

检查：事实一致性、时间、数字、归属、叙事连贯、长度、重复。

Output：`script_review.json`

Branch：

```text
PASS → N09
REVISE → N07
FAIL → WAITING_USER
```

Revision 最大 2 次。

## N09 — Storyboard & Asset Plan

```text
Type: TASK
```

Output：

```text
storyboard.json
asset_manifest.json
```

Visual Type：

```text
SOURCE_SCREENSHOT
PRODUCT_SCREENSHOT
CHART
LOGO
STOCK_BROLL
SCREEN_RECORDING
TYPOGRAPHY
USER_PROVIDED
```

首版默认不需要 `VIDEO_GENERATION`。

## N10 — Asset Collection

```text
Type: TASK
```

Output：

```text
asset_registry.json
assets/*
```

每个 Asset 至少记录 source、usageMetadata、capturedAt、storyboardSceneIds。

登录态页面、人工录屏、版权素材、无法自动获取的 Demo → Human Bridge。

ExternalWorkRequest 必须说明：录什么、时长、分辨率、保存路径、验收条件。

## N11 — Voiceover

```text
Type: TASK
```

执行优先：可用 speech capability / Tool/MCP / Human Bridge。

Output：

```text
voice.wav / voice.mp3
voice_timing.json
```

Exit：音频可读取、时长合理、timing 可用于字幕/timeline。

## N12 — Video Assembly

```text
Type: TASK
```

首版优先程序化视频 Tool，例如 Remotion/FFmpeg 类能力，而不是视频生成模型。

Input：storyboard + assets + voice + script。

Output：

```text
draft.mp4
render_manifest.json
```

无可用 Tool → Human Bridge，输出完整编辑说明、素材目录、timeline plan 和目标路径。

Side-effect policy：

```text
effectType = FILE_OUTPUT
```

程序化渲染必须优先输出到 run-scoped 临时路径；通过视频 Artifact Contract 后再提交为 `news.video.draft`。重启时如 `render_manifest + output hash` 已验证，直接恢复结果，不重复渲染。

## N13 — Final QA

```text
Type: REVIEW
```

Review：

```text
FACT
VISUAL
TECHNICAL
```

FACT：旁白与 source、数字、日期、字幕事实。

VISUAL：画面与 narration、错误截图、来源标签、误导性图表。

TECHNICAL：音画同步、字幕、空白帧、时长、分辨率、音频。

Output：`qa_report.json`

当：

```text
verdict = REVISE
```

必须同时输出 schema-bounded：

```text
revisionCode =
  STORYBOARD
  | ASSETS
  | ASSEMBLY
```

`revisionCode` 不能是 Step ID，也不能是自由文本。

WorkflowDefinition 静态映射：

```text
PASS                → User Final Approval
REVISE + STORYBOARD → N09
REVISE + ASSETS     → N10
REVISE + ASSEMBLY   → N12
FAIL                → WAITING_USER
```

所有三条 REVISE Edge 共用：

```text
revisionGroup = news.final_qa_revision
maxTotalTraversals = 2
```

因此模型只能报告“问题属于哪类”，不能自由选择 Workflow 跳转目标。

## N14 — Final Approval & Export

最终不自动发布。

Workflow：

```text
WAITING_USER
reason = USER_CONFIRMATION
```

Approve 后 Workflow COMPLETED。

首版不自动上传 YouTube/Bilibili/社交平台；未来发布必须是单独高风险 Action + Permission/Approval。

---

# 9. AI 资讯视频 — Human Bridge 典型位置

```text
人工录屏
真人配音
外部 TTS
版权素材
专业剪辑
登录态应用操作
最终人工 QA
```

不是因为缺少视频生成模型而自动触发。

---

# 10. AI 资讯视频 — 验收案例

至少：

```text
A. 60 秒单主题 AI 新闻 Short
B. 5 分钟 3–5 条 AI 新闻周报
C. 某产品发布事件 Explainer
```

必须验证：重复新闻不重复入选；UNVERIFIED claim 不进入 script；script claim 可追溯 source；缺素材时 Human Bridge；中途重启恢复；QA revise 有上限；最终不自动发布。

---

# 11. Workflow 2 — 软件功能开发

## 11.1 定位

目标：从用户需求到可验证的 Workspace 变更。

不绑定 GitHub、Claude、Codex 或任何单一 Provider。

核心：

```text
理解
→ Spec
→ Plan
→ 实现
→ 验证
→ 独立 Review
→ Fix
→ 交付
```

## 11.2 Inputs

```ts
SoftwareFeatureInput {
  objective: string
  workspaceRoot: string
  constraints?: string[]
  targetArea?: string[]
  userAcceptanceNotes?: string[]
  allowedToolScope?: string[]
}
```

可选已有 Artifact：issue、design document、screenshots、API spec、failing logs。

## 11.3 Final Outputs

```text
workspace change set
feature_spec.md
acceptance_criteria.json
implementation_plan.md
test_report.json
code_review.json
delivery_summary.md
```

---

# 12. 软件功能开发 — 用户可见阶段

```text
1. 理解
2. 规划
3. 开发
4. 验证
5. 审查
6. 交付
```

---

# 13. 软件功能开发 — 内部 Step

## S01 — Repository / Context Analysis

```text
Type: TASK
Required Capability: CODING, LONG_CONTEXT_REASONING, TOOL_USE
```

Output：`repository_context.json`

至少：相关模块、架构摘要、change surface、现有测试、发现的 build/test commands、风险、未知项。

只允许通过 ToolRuntime 读取 Workspace。

## S02 — Feature Specification

```text
Type: TASK
```

Output：

```text
feature_spec.md
acceptance_criteria.json
```

Acceptance criteria 必须可判断；“体验良好”“代码优雅”不能作为唯一标准。

## S03 — Implementation Plan

```text
Type: TASK
```

Output：`implementation_plan.md`

至少：files/modules、ordered steps、test strategy、migration impact、security/permission impact、rollback considerations。

## S04 — Plan Review

```text
Type: REVIEW
```

优先由独立于 S03 executor 的道友执行。

检查：requirement coverage、安全边界、scope、测试、兼容性。

Branch：

```text
PASS → S05
REVISE → S03
FAIL → WAITING_USER
```

最大 2 次。

## S05 — Implementation

```text
Type: TASK
Required Capability: CODING, TOOL_USE
```

Input：spec + acceptance + plan + workspace。

Output：

```text
change_manifest.json
workspace mutations
```

所有文件操作必须经过 ToolRuntime + PermissionEngine + Workspace boundary。

Side-effect policy：

```text
effectType = WORKSPACE_MUTATION
```

S05 必须在 mutation 前生成 `operationKey` 并持久化 `PREPARED` receipt；完成后输出：

```text
change_manifest.json
affected relative paths
before/after hash（可获得时）
```

若应用在 mutation 后、Step commit 前崩溃，恢复时先验证 Workspace 是否已经处于目标状态；禁止直接重新执行整个 Implementation。

## S06 — Verification

```text
Type: TASK
```

执行 test / typecheck / lint / build / 项目声明的 verification commands。

Output：`test_report.json`

至少记录 commands、exit status、failures、affected acceptance criteria。

## S07 — Verification Decision

```text
Type: DECISION
Mode: DETERMINISTIC
```

Branch：

```text
PASS → S08
REVISE → S10
BLOCKED → WAITING_USER
```

PASS 必须由 required verification success + required acceptance evidence 确定性产生。

## S08 — Independent Code Review

```text
Type: REVIEW
```

输入：spec + plan + change set + test report + relevant context。

Review：correctness、security、regressions、maintainability、scope、test sufficiency。

Output：`code_review.json`

## S09 — Review Decision

```text
Type: DECISION
```

```text
PASS → S11
REVISE → S10
FAIL → WAITING_USER
```

## S10 — Fix

```text
Type: TASK
```

Input：test failures + review findings + workspace。

Output：updated change manifest + `fix_summary.json`。

S10 同样属于：

```text
effectType = WORKSPACE_MUTATION
```

每个 Fix attempt 必须有独立 operation receipt，并把实际变更合并到 run-level change lineage。

完成后回到 S06。

S07/S09 进入 S10 的所有修复共用：

```text
revisionGroup = software.fix_cycle
maxTotalTraversals = 3
```

超过进入 `WAITING_USER`。

## S11 — Delivery

```text
Type: TASK
```

Output：`delivery_summary.md`

包含：what changed、files/modules、tests、known limitations、remaining risks、manual verification。

首版不自动 git push / merge / deploy / release；未来必须作为显式 Permission/Approval Action。

---

# 14. 软件功能开发 — Human Bridge

典型触发：人工 UI 视觉确认、真实设备、验证码、第三方系统、业务判断。

Human Bridge 输出必须重新进入 Artifact → Validation → Workflow Resume。

---

# 15. 软件功能开发 — 验收案例

至少：

```text
A. 小型 bug fix
B. 新增一个带 migration 的功能
C. 跨前后端 UI + IPC + persistence 功能
```

必须验证：Plan Review 可打回；测试失败进入 Fix；Review findings 进入 Fix；Fix 后重新 Verification；循环有上限；Workspace 越界不可执行；Permission 不被绕过；重启后不重复成功 mutation。

---

# 16. Workflow 3 — 科研

## 16.1 定位

科研 Workflow 不等于“AI 自动写论文”。

核心：

```text
Research Question
→ Evidence
→ Gap
→ Hypothesis
→ Experiment
→ Analysis
→ Evidence Decision
→ Manuscript
→ Review
```

适用于计算机科研、数据实验、可程序化科研，以及带 Human Bridge 的现实实验流程。

## 16.2 Inputs

```ts
ResearchWorkflowInput {
  researchQuestion: string
  field: string
  scope?: string
  literatureTimeRange?: { from?: date; to?: date }
  existingSources?: ArtifactRef[]
  existingData?: ArtifactRef[]
  existingCode?: ArtifactRef[]
  experimentMode: "COMPUTATIONAL" | "HUMAN_OR_EXTERNAL" | "MIXED"
  maxExperimentCycles?: number
}
```

`maxExperimentCycles` 必须 bounded，首版上限建议 2。

## 16.3 Final Outputs

```text
research_brief.json
evidence_table.json
research_landscape.md
hypotheses.json
experiment_plan.json
experiment_record.json
analysis.md
manuscript.md
scientific_review.json
final_research_package
```

---

# 17. 科研 — 用户可见阶段

```text
1. 探索
2. 假设
3. 实验
4. 分析
5. 写作
6. 审查
```

---

# 18. 科研 — 内部 Step

## R01 — Research Question Framing

```text
Type: TASK
```

Output：`research_brief.json`

至少：question、scope、definitions、constraints、success criteria、known assumptions。

## R02 — Literature Discovery

```text
Type: TASK
Required Capability: GENERAL_REASONING, TOOL_USE, LONG_CONTEXT_REASONING
```

Output：`literature_candidates.json`

每条文献必须保留 title、authors、year、source、URL/DOI/identifier、discovery method。

不得凭模型记忆伪造 citation。

## R03 — Evidence Screening & Extraction

```text
Type: TASK
```

Output：

```text
evidence_table.json
screening_report.json
```

每条记录：sourceId、included/excluded、reason、claim/evidence、method、population/dataset、metric、result、limitations。

## R04 — Research Landscape & Gap

```text
Type: TASK
```

Output：

```text
research_landscape.md
candidate_gaps.json
```

要求明确区分：已有证据、推断、未知。

## R05 — Candidate Hypotheses

```text
Type: TASK
```

Output：`hypotheses.json`

每个 Hypothesis：statement、rationale、supportingEvidenceIds、contradictingEvidenceIds、assumptions、testability、proposedEvaluation。

## R06 — Hypothesis Review

```text
Type: REVIEW
```

建议独立道友执行。

Review：novelty、evidence grounding、testability、assumptions、contradictions、experiment feasibility。

Branch：

```text
PASS → R07
REVISE → R05
FAIL → WAITING_USER
```

最大 revision 2。

## R07 — Experiment Design

```text
Type: TASK
```

Output：`experiment_plan.json`

必须包含 hypothesisId、method、variables、dataset/samples、controls/baselines、metrics、procedure、expected artifacts、failure conditions、resource requirements、reproducibility notes。

涉及现实世界时必须标出 Human Bridge / external requirement。

## R08 — Experiment Execution

```text
Type: TASK
```

Computational：Tool/MCP + Workspace + Code + Experiment。

Human/External：Human Bridge。

ExternalWorkRequest 必须明确实验步骤、输入、记录要求、输出位置、接受标准。

Output：

```text
experiment_record.json
raw_results/*
logs/*
```

Side-effect policy：

- Computational experiment：根据实际行为标记 `FILE_OUTPUT` 或 `WORKSPACE_MUTATION`；
- Human / External experiment：标记 `EXTERNAL_ACTION`；
- 每个 experiment attempt 必须有稳定 `operationKey` 与独立 receipt；
- 外部实验状态不确定时进入 `WAITING_USER`，禁止自动重做；
- 每轮 raw result 使用新的 immutable Artifact identity，不覆盖上一轮。

原始结果不可被分析 Step 静默覆盖。

## R09 — Data Analysis

```text
Type: TASK
```

Output：

```text
analysis.md
analysis_results.json
figures/*
```

必须保留 analysis method、metrics、uncertainty、negative results、failed runs、limitations。

禁止只挑有利结果。

## R10 — Evidence Decision

```text
Type: DECISION
```

Declared Branch：

```text
SUFFICIENT
REFINE_EXPERIMENT
REFINE_HYPOTHESIS
BLOCKED
```

```text
SUFFICIENT → R11
REFINE_EXPERIMENT → R07
REFINE_HYPOTHESIS → R05
BLOCKED → WAITING_USER
```

`REFINE_EXPERIMENT` 与 `REFINE_HYPOTHESIS` 共用同一个：

```text
revisionGroup = research.experiment_cycle
maxTotalTraversals = maxExperimentCycles
```

不能分别计数。

`maxExperimentCycles` 首版必须 `<= 2`；达到 Group 上限必须 `WAITING_USER`。

## R11 — Manuscript Draft

```text
Type: TASK
```

Input：research brief + evidence + hypothesis + experiment plan/record + analysis。

Output：

```text
manuscript.md
claim_evidence_map.json
```

关键科研结论必须能追溯 evidence/result。

## R12 — Scientific Review

```text
Type: REVIEW
```

检查：claim/evidence consistency、methodology、experiment validity、limitations、citation grounding、overclaiming、reproducibility、internal contradictions。

Output：`scientific_review.json`

Branch：

```text
PASS → R14
REVISE → R13
FAIL → WAITING_USER
```

## R13 — Revision

```text
Type: TASK
```

Output：

```text
revised_manuscript.md
revision_response.json
```

之后回 R12，最大 2 次。

## R14 — Final Package

正式输出：final manuscript、evidence table、experiment records、analysis、figures、review history、reproducibility summary。

Workflow 完成不意味着自动投稿，也不意味着自动宣称研究结论已被最终证实。

---

# 19. 科研诚信不变量

1. Citation 必须来自实际 Source Artifact。
2. 模型内部知识不能直接变成 citation。
3. Evidence 必须保留 provenance。
4. Raw experiment result 不被覆盖。
5. Negative result 不应静默删除。
6. Manuscript claim 应尽量映射到 evidence/result。
7. AI suggestion 与 verified evidence 必须区分。
8. 实验回环有上限。
9. 现实实验需要用户/外部执行时必须使用 Human Bridge。
10. Workflow 不代替学术伦理、实验安全或机构审批。

---

# 20. 科研 — 验收案例

至少：

```text
A. 计算机领域算法/系统实验
B. 已有数据集上的实验分析
C. 需要 Human Bridge 的外部/现实实验模拟
```

必须验证：Citation 不可伪造；screening 有 included/excluded reason；hypothesis review 可打回；实验结果 immutable；analysis 可触发 refine；循环到上限停止；论文 claim 可追溯；Human Bridge 成果可恢复。

---

# 21. 三个 Workflow 的统一 Artifact 命名原则

Artifact key 必须稳定、机器可引用。

避免：

```text
final2.md
new_final.json
latest_script.md
```

采用逻辑 key：

```text
news.candidates
news.source_packets
news.verified_claims
news.script
news.storyboard
news.video.draft
news.video.final

software.repo_context
software.spec
software.acceptance
software.plan
software.changes
software.tests
software.review
software.delivery

research.brief
research.literature
research.evidence
research.gaps
research.hypotheses
research.experiment_plan
research.experiment_record
research.analysis
research.manuscript
research.review
```

具体物理文件名由 Artifact service 管理。

## 21.1 Artifact Contract Registry

每个稳定 Artifact key 必须绑定显式 Contract：

```text
artifact key
→ contractId
→ contractVersion
→ deterministic validator
```

示例：

```text
news.verified_claims
→ ai-news.verified-claims
→ 1
→ JSON_SCHEMA

software.changes
→ software.change-manifest
→ 1
→ WORKSPACE_MANIFEST

research.experiment_record
→ research.experiment-record
→ 1
→ JSON_SCHEMA
```

运行时 ArtifactBinding 必须同时记录：

```text
artifactId
logicalKey
contractId
contractVersion
contentHash
producerStepRunId
```

Definition 新版本可以升级 Contract，但：

```text
旧 WorkflowRun
→ 永远使用启动时冻结的 Definition + Contract Version
```

不得因为应用升级而使用新 schema 重新解释旧 Run。

### 首发必须机器校验的 Contract

至少包括：

#### AI 资讯视频

```text
candidate_stories
source_packets
verified_claims
editorial_plan
beat_map
script_claim_map
storyboard
asset_manifest
asset_registry
voice_timing
render_manifest
qa_report
```

#### 软件功能开发

```text
repository_context
acceptance_criteria
change_manifest
test_report
code_review
fix_summary
```

#### 科研

```text
research_brief
literature_candidates
evidence_table
screening_report
hypotheses
experiment_plan
experiment_record
analysis_results
claim_evidence_map
scientific_review
revision_response
```

Markdown / binary / directory Artifact 不强行转换成 JSON；它们由对应 `TEXT_RULES / FILE_METADATA / DIRECTORY_MANIFEST / WORKSPACE_MANIFEST` validator 负责。

---

# 22. Routing 规则

Workflow Template 不写死具体道友。

每个 Step 只声明：

```text
objective
required capability
execution constraint
artifact context
review independence requirement
```

R4 决定：

```text
SOLO
PARTY
Human Bridge
USER_ACTION_REQUIRED
```

Independent Review：软件的 Plan Review/Code Review、科研的 Hypothesis Review/Scientific Review 应尽量由不同于主要产出 executor 的道友完成。

若团队只有一个合格道友：允许同道友 Review，但 Receipt 标记 `reviewIndependence=false`，不能伪造独立审查。

---

# 23. Availability

每个真正需要调用模型的 Step：

```text
R4 candidate
↓
R3.2 availability
↓
request-before-send probe
```

```text
UNAVAILABLE → 下一个候选
UNSTABLE → penalty
```

显式指定 UNAVAILABLE → WAITING_USER。

Workflow 不复制 Availability 逻辑。

---

# 24. Human Bridge

Human Bridge 是正式 Executor，不是错误兜底页面。

### AI 资讯视频
人工录屏、配音、版权素材、专业剪辑、登录态应用操作。

### 软件开发
人工 UI 验收、真实设备、验证码、第三方系统、业务判断。

### 科研
现实实验、专业仪器、人工采样、外部软件、无法自动访问的数据。

Human Bridge 结束后仍必须经过 Artifact Contract validation。

---

# 25. Permission

Workflow Definition 只声明需求，不能声明 ALLOW。

真实 Tool / MCP / External Action 始终：

```text
ToolRuntime
↓
PermissionEngine
↓
Approval
```

官方模板也不能自动获得高权限。

---

# 26. UI

W2 内置 Workflow 页面保持 R3.3 的低文字密度。

模板卡只显示：名称、一句用途、预计阶段、主要能力。

```text
AI 资讯视频
从近期资讯到核验、脚本、素材和成片。

软件功能开发
从需求到实现、测试与独立 Review。

科研
从问题、文献和假设到实验、分析与论文。
```

不在首页显示全部内部 Step。

运行页默认显示：当前阶段、进度、当前执行者、当前 Artifact、需要用户操作。

详细 Step / Audit 放入展开视图。

---

# 27. W2 实施拆分

## W2.0 — Built-in Workflow Contract

先完成：

```text
BuiltinWorkflowRegistry
Definition schema validation
Artifact Contract Registry + deterministic validators
BoundedRevisionGroup + BoundedRevisionEdge
common REVIEW result schema + revisionCode validation
StepOperationReceipt + side-effect recovery policy
Reference Basis metadata / release validation
common Workflow fixture/test harness
```

W2.0 必须先验证：

```text
Group revision budget 在重启后不重复计数
多条 revision edge 共享同一个总预算
未声明 revisionCode 被拒绝
Artifact Contract version 冻结
APPLIED-but-uncommitted side effect 能恢复/验证而非盲目重放
UNKNOWN external action → WAITING_USER
```

不增加模板。

## W2.1 — AI 资讯视频

优先验证 Research、Artifact、Human Bridge、非文本输出、Review。

完成真实“资讯 → 成片”后审批。

## W2.2 — 软件功能开发

重点验证 Workspace、Tool/MCP、Permission、Retry、Independent Review。

## W2.3 — 科研

最后加入 Evidence provenance、Experiment、Bounded research loop、Scientific review。

它是三个模板中状态逻辑最复杂的。

## W2.4 — Cross-Workflow Acceptance

统一验收：重启恢复、模板版本、Artifact lineage、Availability、Routing、Human Bridge、Permission、Revision loop、UI、Windows packaged smoke。

通过后进入 R5 Harness Optimization。

---

# 28. 官方 Workflow 版本治理

每个模板版本必须附带：

```text
Reference Basis
Design Rationale
Breaking Changes
Fixture Tasks
Acceptance Evidence
Artifact Contract Manifest
Revision Group Manifest
Side-effect Step Manifest
```

`Reference Basis` 至少说明：

```text
参考了哪些流程知识
采用了哪些原则
刻意没有复制哪些 Vendor-specific 机制
这些原则如何映射到本项目 Step / Artifact / Review / Decision
```

不要求所有 Reference 都是标准，但必须可审计；不能只写“参考业界最佳实践”。

新增版本必须说明：为什么修改流程、参考了什么成熟实践、是否改变 Step/Artifact Contract、Revision budget、副作用恢复规则，以及旧 Run 如何处理。

运行中永远继续其启动版本与绑定的 Contract versions。

---

# 29. Workflow Fixture Library

每个官方模板必须随代码附带测试任务。

建议：

```text
fixtures/workflows/ai-news-video/*
fixtures/workflows/software-feature/*
fixtures/workflows/research/*
```

fixture 包含：

```text
input
mock source/tool results
expected artifact contracts
expected artifact validation receipts
expected decisions
expected revisionGroup counters
expected state transitions
expected operation receipts
expected recovery behavior
```

每个有副作用的官方 Workflow 至少包含：

```text
A. 副作用前崩溃
B. 副作用已发生、Step 尚未 commit 时崩溃
C. 重启后验证既有结果并继续
D. 外部副作用状态未知 → WAITING_USER
```

生产测试不依赖互联网；真实 provider / Tool / MCP 用 packaged/manual acceptance 补充。

---

# 30. W2 发布门槛

三个模板不能因为“能跑完”就算成功。

必须同时满足：

```text
Deterministic state
Resume
Machine-enforced Artifact Contract validation
Definition + Contract version immutability
Edge + Revision Group bounded retry
Declared revision target only
No duplicate side effects
Operation Receipt / crash recovery
Permission safety
Routing compatibility
Availability compatibility
Human Bridge compatibility
Review traceability
Reference Basis completeness
```

---

# 31. 与 AP-006 的关系

AP-006 中 W2 的三个模板正式修订为：

```text
AI 资讯视频
软件功能开发
科研
```

本文 v1.1 作为 W2 的详细实施规格；原 AP-007 内容若与本修订新增约束冲突，以 v1.1 为准。

实施顺序：

```text
R3.2
↓
R3.3
↓
R4
↓
W1
↓
W2.0
↓
W2.1 AI 资讯视频
↓
W2.2 软件功能开发
↓
W2.3 科研
↓
W2.4 Cross-Workflow Acceptance
↓
R5
↓
W3
↓
R6
```

---

# 32. 暂不纳入首发模板

```text
纯 AI 视频生成
普通内容写作
营销自动发布
财务自动化
通用办公自动化
无限 Autonomous Research
自动论文投稿
自动代码 Merge / Deploy
```

后续根据真实用户使用数据决定是否增加。

---

# 33. v1.1 修订摘要

本次在原 AP-007 基础上只补齐执行契约，没有改变三个首发 Workflow 的产品定位与主流程。

新增五类正式约束：

```text
1. Revision Group 总预算
2. schema-bounded revisionCode → declared edge
3. 机器可校验 Artifact Contract + validation receipt
4. Side-effect Operation Receipt + crash recovery
5. 每个模板版本的 Reference Basis 治理
```

这些约束优先在 `W2.0 — Built-in Workflow Contract` 落地，再进入三个模板实现。

---

# 34. 最终定位

三个预置 Workflow 不是 Prompt 模板。

它们是：

```text
经过成熟流程验证的任务结构
+
AI Agent Cultivation 的 Routing
+
固定模型道友
+
Benchmark
+
Availability
+
Mission
+
Artifact
+
Human Bridge
+
Permission
+
Review
+
Checkpoint
```

最终形成：

```text
AI 资讯视频
→ 可靠的内容生产流水线

软件功能开发
→ 可验证的工程执行流水线

科研
→ 有证据、有实验、有审查边界的知识发现流水线
```

这三个 Workflow 共同构成 AI Agent Cultivation 第一批正式的“可复用历练模板”。
