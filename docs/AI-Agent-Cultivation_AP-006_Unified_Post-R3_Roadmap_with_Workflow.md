# AI-Agent-Cultivation AP-006
## Unified Post-R3 Roadmap with Workflow Architecture

- 日期：2026-09-30
- 当前基线：R3.1 已完成并通过
- 替代：
  - `AI-Agent-Cultivation_AP-005_Post-R3_Architecture_UI_Revision.md`
  - `AI-Agent-Cultivation_Workflow_Architecture_Plan_v0.1.md` 的实施路线部分
- 原则：保留 AP-005 尚未实现的能力，同时把 Workflow 正式纳入总体架构；Workflow 不提前成为第二套 Runtime。

---

# 1. 总体目标

最终产品形成两种“历练”方式：

```text
自由历练
→ 用户给目标
→ Routing 动态决定单道友 / 多道友 / Human Bridge
→ Mission Runtime 执行

工作流历练
→ 用户选择 Workflow
→ Workflow Engine 按确定结构推进
→ 每个执行 Step 复用同一 Routing / Mission / Human Bridge / Artifact / Permission
```

底层统一：

```text
Workflow（可选）
↓
Task / Step Execution Contract
↓
Routing
↓
Teammate / Party / Human Bridge
↓
Mission Runtime
↓
Skill / Memory / Tool / MCP
↓
Artifact
↓
State / Audit / Checkpoint
```

Workflow 只负责：

```text
做哪些步骤
何时进入下一步
需要什么输入
应产生什么输出
是否满足退出条件
```

Workflow 不负责重新实现：

```text
模型调用
Agent Runtime
权限
工具
MCP
Human Bridge
Memory
Skill
Routing
```

---

# 2. 已确定的不变量

## 2.1 道友与模型

普通道友：

```text
一个普通道友 = 一个封存后的固定 LLM 执行身份
```

创建并测试成功后：

```text
Provider / Endpoint / Model → 不可更换
Credential / API Key       → 可安全轮换
```

换模型必须新建道友。

Human Bridge 是唯一非模型道友。

## 2.2 Capability

普通道友：

```text
Capability Score = Benchmark
```

不再使用：

```text
Mission 用户评分
CapabilityEvidence 动态评分
Runtime Migration transferWeight
```

Memory / Skill / Experience 不修改 Benchmark。

Human Bridge：

```text
enabled capability → score = 1
disabled           → unsupported
routingPolicy      → FALLBACK_ONLY
```

## 2.3 Availability

模型可用性与 Benchmark 独立：

```text
UNKNOWN
AVAILABLE
UNSTABLE
UNAVAILABLE
```

只在：

```text
真正准备发送请求前
用户手动检测
真实请求完成后
```

更新。

V1 不做后台轮询。

## 2.4 Workflow 与 Mission

```text
Workflow ≠ Mission Runtime
Workflow Step ≠ 新模型执行引擎
```

执行型 Step 必须复用 Mission。

V1 采用：

```text
一个 WorkflowStepRun
→ 最多绑定一个 Mission identity
→ Mission 内部允许多个 MissionRun / Retry
```

禁止一个普通 Step 自己偷偷创建多个互不相关 Mission。

如果需要多人工作：

```text
由该 Mission 进入 Party / Collaboration
```

而不是 Workflow 自己实现另一套多 Agent 调度。

---

# 3. Workflow 核心模型

## 3.1 WorkflowDefinition

```ts
WorkflowDefinition {
  id
  name
  description
  category
  source        // BUILTIN | USER | IMPORTED
  version
  inputSchema
  outputSchema
  createdAt
  updatedAt
}
```

每次发布修改生成新 version。

运行中的 WorkflowRun 永远绑定启动时版本。

V1 不支持运行中自动迁移模板版本。

## 3.2 WorkflowStepDefinition

V1 收敛为三种核心 Step：

```text
TASK
REVIEW
DECISION
```

暂不把 `HUMAN` 作为独立 Runtime Step。

Human Bridge 是：

```text
TASK / REVIEW 的一种合法 Executor
```

可以来自：

```text
executionPolicy = HUMAN_BRIDGE
或
Routing fallback
```

这样 Human Bridge 继续走现有 Mission / ExternalWork 语义，不引入第二条执行链。

`SUBWORKFLOW` 延后到 W3+，避免 W1 状态机过早递归化。

定义：

```ts
WorkflowStepDefinition {
  id
  workflowDefinitionId
  type

  title
  objectiveTemplate

  requiredCapabilities
  inputContracts
  outputContracts

  entryConditions
  exitConditions

  executionPolicy
  reviewPolicy

  maxAttempts
}
```

---

# 4. Step 类型边界

## 4.1 TASK

正常任务：

```text
Step
↓
Routing
↓
SOLO / PARTY / Human Bridge
↓
Mission
↓
Artifact Output
```

## 4.2 REVIEW

输入必须是已有 Artifact。

用于：

```text
质量检查
事实核验
代码 Review
稿件 Review
验收
修改建议
```

REVIEW 本质仍是 Mission，只是具有明确：

```text
input artifact
review criteria
structured verdict
```

输出至少包含：

```text
PASS
REVISE
FAIL
```

以及 bounded review summary。

## 4.3 DECISION

DECISION 不调用 Mission Runtime。

只允许从 WorkflowDefinition 声明的合法分支中选择。

首版两种模式：

```text
DETERMINISTIC
JEV_ASSISTED
```

`DETERMINISTIC`：

```text
根据结构化字段 / validation result / review verdict
选择分支
```

`JEV_ASSISTED`：

```text
Jev 对 bounded structured state 分类
↓
输出 declared branch candidate + confidence
↓
Domain Validator 检查候选是否合法
↓
低置信度或无法验证 → WAITING_USER
```

禁止：

```text
LLM 动态创造新 Step
LLM 改写 Workflow Graph
LLM 自己修改正式状态
```

---

# 5. Artifact Contract

Workflow 不能只保存“文件列表”。

需要正式区分：

```text
Artifact Spec
Artifact Instance
Artifact Binding
Artifact Lineage
```

## 5.1 ArtifactSpec

```ts
WorkflowArtifactSpec {
  key
  kind          // FILE | DIRECTORY | TEXT | JSON | EXTERNAL_REFERENCE
  required
  mimeTypes?
  extensions?
  schema?
  maxSizeBytes?
  description
}
```

## 5.2 ArtifactBinding

```ts
WorkflowArtifactBinding {
  workflowRunId
  stepRunId
  specKey

  artifactId
  role          // INPUT | OUTPUT

  source        // MISSION | USER | HUMAN_BRIDGE | IMPORTED

  workspacePath?
  contentHash?
  metadata

  createdAt
}
```

文件内容本身仍受现有 Workspace / Tool / Permission 安全边界控制。

Workflow 不因持有 Artifact path 就获得读取权限。

## 5.3 Artifact Lineage

每个输出应能回答：

```text
谁产生
在哪个 WorkflowRun
哪个 StepRun
哪个 Mission / MissionRun
基于哪些输入
```

用于：

```text
Resume
Review
Retry
Import Existing Work
Audit
```

---

# 6. Workflow 状态机

## 6.1 WorkflowRun

```text
DRAFT
READY
RUNNING
WAITING
PAUSED
COMPLETED
FAILED
CANCELLED
```

## 6.2 WorkflowStepRun

```text
PENDING
READY
RUNNING
WAITING
COMPLETED
FAILED
SKIPPED
CANCELLED
```

等待原因单独记录：

```text
APPROVAL
EXTERNAL_WORK
USER_CONFIRMATION
MISSION
DECISION
```

避免复制 Mission 所有细粒度状态。

## 6.3 正式状态来源

Workflow 状态必须来自持久化事实：

```text
StepRun state
Artifact bindings
Mission state
validation result
Decision result
Checkpoint
```

禁止依赖模型聊天上下文推断当前运行状态。

Renderer 不直接写状态。

---

# 7. Step 完成事务

Step 完成不能简单：

```text
Mission 完成
→ 下一 Step
```

必须：

```text
Mission terminal
↓
收集 output Artifact
↓
验证 Output Contract
↓
验证 Exit Conditions
↓
事务性提交：
  output bindings
  validation result
  Step COMPLETED
  Checkpoint
  Next Step READY
```

要求幂等。

如果：

```text
Mission 已完成
但 Artifact / Exit Condition 不满足
```

则：

```text
Step FAILED / WAITING_USER
```

禁止伪造完成。

---

# 8. Workflow Checkpoint

Checkpoint 不是整个数据库快照。

只记录可验证的逻辑状态：

```ts
WorkflowCheckpoint {
  id
  workflowRunId
  sequence

  workflowVersion
  completedStepIds
  activeStepIds
  artifactBindingHashes
  decisionHashes

  stateHash
  createdAt
}
```

目的：

```text
检测状态漂移
支持重启恢复
保证已完成 Step 不重复执行
```

---

# 9. Resume 与 Crash Recovery

恢复原则：

```text
恢复已有执行事实
而不是重新“问模型现在做到哪了”
```

启动时按 StepRun 分类：

### COMPLETED

直接保留，不重跑。

### RUNNING + Mission still active/waiting

重新绑定已有 Mission。

### RUNNING + Mission terminal

重新执行 Artifact / Exit validation。

### RUNNING + Mission 中存在可能产生外部副作用但结果不确定

进入：

```text
WAITING / NEEDS_USER_CONFIRMATION
```

不得静默自动重放。

继承 R3.1 ExternalWork 的 replay-safety 原则。

---

# 10. Retry

## 10.1 Mission Retry

同一个 StepRun 中：

```text
同一 Mission
→ 新 MissionRun
```

适合模型失败、临时错误。

## 10.2 Step Retry

仅当 Step 的输入或策略发生改变时：

```text
旧 StepRun 保留
→ 新建新的 Step attempt
```

历史 Artifact 不覆盖。

---

# 11. Import Existing Work

这是 W3，不在 W1 首版实现。

导入：

```text
项目目录
文件
代码
已有稿件
实验结果
+
用户描述
```

## 11.1 State Resolver

输入：

```text
WorkflowDefinition version
Artifact metadata
bounded summaries
用户描述
```

输出：

```ts
WorkflowStateResolution {
  suggestedCompletedSteps
  suggestedCurrentStep
  candidateArtifactBindings
  missingRequirements
  confidence
  explanationSummary
}
```

State Resolver 可以用 Jev / Generative Model。

但输出只是一份 proposal。

## 11.2 Deterministic Validator

对 proposal 验证：

```text
Artifact contract
Required input
Exit condition
Dependency
Workflow graph legality
```

## 11.3 用户确认

```text
AI 建议
+
确定性 validation
+
用户确认
↓
创建 WorkflowRun
```

对于被视为已完成的导入 Step，记录：

```text
completionOrigin = IMPORTED_CONFIRMED
```

与真正执行完成区分。

---

# 12. Workflow Graph 范围

W1 不实现通用 DAG 调度系统。

W1 支持：

```text
顺序 Step
条件分支
Step Retry
```

不支持：

```text
并行 DAG
任意循环
递归 Subworkflow
动态生成节点
```

W2 如确有需求，可以增加：

```text
有界 revision loop
```

必须：

```text
显式 maxIterations
```

禁止无限 Agent loop。

---

# 13. 与 Routing 的融合

Workflow 不实现自己的 routing。

统一调用 R4 的：

```text
RoutingEligibilityService
Routing Planner
Availability Probe
```

输入：

```ts
RoutingTaskContext {
  objective
  requiredCapabilities
  executionConstraint

  inputArtifactMetadata
  expectedOutputContract

  explicitTeammateId?
  explicitPartyId?

  workflowContext? {
    workflowRunId
    stepId
    stepType
  }
}
```

输出：

```text
SOLO assignment
PARTY assignment
HUMAN_BRIDGE fallback
USER_ACTION_REQUIRED
```

---

# 14. 与 Availability 的融合

Workflow Step 不批量探测所有模型。

执行前沿用 R3.2：

```text
候选排序
↓
准备实际使用候选
↓
即时 probe
```

行为：

```text
AVAILABLE   → 使用
UNSTABLE    → stability penalty
UNAVAILABLE → 下一个候选
UNKNOWN     → probe
```

显式指定不可用道友：

```text
WAITING_USER
```

不静默替换。

---

# 15. 与 Human Bridge 的融合

Human Bridge 不再需要独立 HUMAN Step。

例如视频生成：

```text
TASK: Generate Video
requiredCapabilities = VIDEO_GENERATION
↓
无可用 MODEL_RUNTIME
↓
Routing fallback
↓
Human Bridge
↓
ExternalWorkRequest
↓
WAITING
↓
用户提交 Artifact
↓
Mission Resume
↓
Step Output Validation
↓
Next Step
```

这样完全复用 R2/R3.1 已有能力。

---

# 16. 与 R5 Harness 的融合

Workflow 必须先有 W1/W2，再做 R5。

原因：

```text
真实 Step 是最好的 Skill / Memory / Tool 优化场景
```

每个 Step 只向 Harness 提供 bounded context：

```text
Step objective
required capabilities
input artifact summaries
expected output contract
current Mission public state
```

禁止默认把完整 Workflow 历史塞进模型上下文。

## 16.1 Skill Routing

```text
Enabled Skill metadata
↓
deterministic shortlist
↓
Jev relevance
↓
Top 1–3
```

Workflow Step type / capability 可以成为 shortlist 特征。

## 16.2 Memory

```text
Owner scope
↓
是否需要 Memory
↓
FTS / vector
↓
Jev rerank
```

WorkflowRun 不改变 Memory owner isolation。

## 16.3 Tool

```text
Step capability
+
Artifact contract
↓
eligible tools
↓
Jev shortlist
↓
Model tool call
↓
PermissionEngine
```

Workflow 永远不能直接给 Tool 权限。

---

# 17. UI 总体融合

继续执行 AP-005 的 UI Reset：

```text
白色亮色主题
减少文字
4 级字体
无 placeholder
低卡片密度
```

## 17.1 “历练”成为统一任务中心

最终：

```text
历练

[+ 发起历练]

自由历练
工作流
运行中
历史
```

## 17.2 发起历练

第一层选择：

```text
自由历练
使用工作流
```

自由历练：

```text
任务
[空白输入]

执行方式
自动分配
指定道友
指定队伍
```

工作流：

```text
选择 Workflow
填写 Workflow Inputs
启动
```

## 17.3 R3.3 只预留

R3.3 不实现 Workflow Engine。

要求 UI 架构允许后续增加：

```text
自由历练 / 工作流
```

但在 W1 feature 未启用前，不展示无法工作的死入口。

## 17.4 Workflow Run 页面

W1 后：

左侧：

```text
Step 列表
状态
```

主体：

```text
当前 Step
输入
输出
执行者
Mission 状态
必要操作
```

右侧或抽屉：

```text
Artifact
Decision
Audit / Advanced
```

默认界面不展示复杂底层技术数据。

---

# 18. 内置 Workflow 策略

W2 第一批不直接做 5 个。

先做 3 个互补场景：

## 18.1 深度研究报告

验证：

```text
Research
Source Review
Artifact chain
Review
```

## 18.2 软件功能开发

验证：

```text
代码 Workspace
Tool
MCP
Review
Retry
```

## 18.3 AI 视频制作

验证：

```text
多步骤
多 Agent
跨模态 capability
Human Bridge
Artifact
Review
```

稳定后增加：

```text
科研 Workflow
内容创作 Workflow
```

避免同时维护过多模板。

---

# 19. 新的统一实施路线

当前：

```text
R3.1 ✅
```

之后：

```text
R3.2 Availability Foundation
↓
R3.3 UI Information Architecture Reset
↓
R4 Controlled Intelligent Routing
↓
W1 Workflow Foundation
↓
W2 Built-in Workflow MVP
↓
R5 Harness Optimization
↓
W3 User Workflow + Import & Resume
↓
R6 Alpha Acceptance & V1 Hardening
```

---

# 20. R3.2 — Availability Foundation

保持 AP-005 目标。

实现：

```text
UNKNOWN / AVAILABLE / UNSTABLE / UNAVAILABLE
ModelAvailabilityProbe
request-before-send probe
真实请求结果更新状态
UNAVAILABLE hard exclude
UNSTABLE penalty signal
状态 UI
RoutingEligibilityService
```

Workflow 兼容要求：

```text
AvailabilityService 不绑定具体 UI/Mission
未来 Workflow Step 可以调用同一 eligibility / probe API
```

本阶段不实现 Workflow。

---

# 21. R3.3 — UI Information Architecture Reset

保持 AP-005 全部 UI 目标：

```text
白色亮色
统一 Sidebar
4 级字体
删除冗余文字
输入框无 placeholder
道友页重构
首页简化
队伍页简化
本尊待办优化
高级功能下沉
Availability 状态可视化
```

新增 Workflow 兼容要求：

```text
历练成为统一任务中心
页面结构可扩展“自由历练 / 工作流”
不要让导航结构锁死为 Mission-only
```

不实现 Workflow Engine。

---

# 22. R4 — Controlled Intelligent Routing

保持 AP-005 路由目标：

```text
Jev Task Capability
↓
Deterministic Eligibility
↓
Benchmark Ranking
↓
Jev Semantic Fit
↓
Availability Probe
↓
SOLO / PARTY
↓
Human Bridge fallback
```

新增重要要求：

Routing 不能只接受“自由历练 Mission”。

必须抽象为可复用：

```text
Task Execution Assignment
```

供：

```text
自由历练
Workflow Step
```

共同调用。

R4 不实现 Workflow。

---

# 23. W1 — Workflow Foundation

目标：

```text
建立可恢复、可审计的顺序 Workflow Engine
```

实现：

```text
WorkflowDefinition + Version
WorkflowStepDefinition
WorkflowEdge
WorkflowRun
WorkflowStepRun
ArtifactSpec
ArtifactBinding
Checkpoint
Domain state machine
Mission binding
Resume
Retry
DECISION
```

范围：

```text
TASK
REVIEW
DECISION

顺序执行
条件分支
Step Retry
```

不做：

```text
用户编辑器
Import Existing Work
SUBWORKFLOW
并行 DAG
任意循环
```

验收：

```text
重启不重复已完成 Step
Mission WAITING 可恢复
Human Bridge WAITING 可恢复
Exit Condition 不满足不完成
Artifact lineage 正确
WorkflowVersion 不漂移
```

---

# 24. W2 — Built-in Workflow MVP

加入：

```text
深度研究报告
软件功能开发
AI 视频制作
```

必须真实覆盖：

```text
SOLO
PARTY
Human Bridge
Artifact
Review
Approval
Tool
Availability
Routing
Crash recovery
```

目的不是模板数量，而是验证 Workflow Engine。

W2 完成后才认为 Workflow 基础可用于优化 Harness。

---

# 25. R5 — Harness Optimization

保留 AP-005：

```text
Skill Routing
Memory Pre-Gate
Memory Rerank
Tool Shortlist
Review / Completion Advisory
```

但所有设计必须同时覆盖：

```text
自由历练
Workflow Step
```

新增测试：

```text
Workflow Step 不注入完整 Workflow 历史
Skill shortlist 可利用 Step type / capability
Memory owner scope 不被 Workflow 打破
Tool Permission 不被 Workflow 绕过
```

---

# 26. W3 — User Workflow + Import & Resume

在 Engine 与 Harness 都稳定后实现。

包括：

```text
创建 Workflow
编辑 Step
拖动排序
条件分支
输入输出 Contract
Capability
执行约束
Review policy
保存 / 复制
版本化
```

编辑器第一版：

```text
结构化步骤列表
```

不做无限画布。

同时实现：

```text
Import Existing Work
State Resolver
Deterministic validation
用户确认
从指定状态继续
```

这是 Workflow V1 完整产品闭环。

---

# 27. R6 — Alpha Acceptance & V1 Hardening

最终真实验收：

```text
固定模型绑定
Credential rotation
Availability
自由历练自动路由
SOLO / PARTY
Human Bridge fallback
Workflow W1/W2/W3
Import Existing Work
Skill / Memory / Tool optimization
Jev
Permission / Approval
Crash recovery
Windows package upgrade
```

---

# 28. 暂不实现

V1 明确不做：

```text
无限画布节点编辑器
并行通用 DAG
任意脚本节点
通用 HTTP automation
任意代码执行节点
无限 Agent loop
分布式 Workflow
后台无限运行
Marketplace
公开 Workflow 分享平台
自动跨版本迁移运行中的 Workflow
```

---

# 29. 数据与迁移原则

继续从当前最新 migration 之后追加。

禁止修改历史 migration。

要求：

```text
Workflow 只新增自己的 Definition / Run / Binding 数据
Mission / Usage / Event / Audit 原始事实保持不变
Workflow 不复制 Mission 真相
WorkflowStepRun 只保存关联 ID 与 orchestration state
```

Workflow 的事实源：

```text
Definition Version
StepRun
Artifact Binding
Decision
Checkpoint
Mission facts
```

---

# 30. 关键安全不变量

1. Workflow 不替代 Mission Runtime。
2. Workflow 不直接调用 ModelGateway。
3. Workflow 不直接执行 Tool。
4. Workflow 不绕过 Permission / Approval。
5. Workflow 不自己选择 Provider / Model。
6. Workflow Step routing 使用与自由历练相同的 R4 服务。
7. Human Bridge 仍是 `FALLBACK_ONLY` 系统道友。
8. Artifact path 不等于文件读取权限。
9. State Resolver 不能直接修改正式 Workflow 状态。
10. DECISION 只能选择预定义分支。
11. Jev 不能动态改 Workflow Graph。
12. WorkflowVersion 在一个 Run 中固定。
13. 已完成 Step 不因重启重复执行。
14. 有潜在副作用且结果不确定时禁止自动重放。
15. Step completion 必须通过 output + exit validation。
16. Workflow 不突破 Workspace boundary。
17. Memory owner isolation 不因 Workflow 改变。
18. Renderer 不直接修改 Run / Step 状态。
19. Workflow 不自动扩大模型上下文到完整历史。
20. 显式用户选择优先于自动 routing。

---

# 31. 关键产品不变量

1. “历练”是统一任务入口。
2. 用户无需先理解 SOLO / PARTY。
3. 自由历练适合开放目标。
4. 工作流历练适合固定或半固定重复任务。
5. Human Bridge 对工作流用户是普通执行体验，不暴露底层特殊实现。
6. Workflow 默认以 Artifact 而非完整聊天记录交接。
7. 页面默认只展示当前需要用户理解和操作的信息。
8. Workflow 编辑器首版保持结构化和可理解，不追求 n8n/ComfyUI 式复杂度。

---

# 32. 最终产品闭环

```text
用户
↓
历练
├─ 自由历练
│   ↓
│   R4 Routing
│   ↓
│   Mission
│
└─ 工作流历练
    ↓
    Workflow Definition
    ↓
    Workflow Step
    ↓
    R4 Routing
    ↓
    Mission / Human Bridge
    ↓
    Artifact
    ↓
    Exit Validation
    ↓
    Checkpoint
    ↓
    Next Step

共同底层：
Benchmark
Availability
Jev
Permission
Skill
Memory
Tool / MCP
Experience
Audit
```

Workflow 的价值不是让系统多出一套自动化引擎，而是把现有 Agent 能力组织成：

```text
可重复
可恢复
可检查
可交接
可接手
```

的长期任务执行体系。
