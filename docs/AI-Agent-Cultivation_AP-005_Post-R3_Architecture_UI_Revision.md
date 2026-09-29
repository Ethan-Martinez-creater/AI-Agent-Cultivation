# AI-Agent-Cultivation Post-R3 Architecture & UI Revision Plan
## AP-005 — 固定模型道友、即时可用性、界面重构与后续智能路由

- 日期：2026-09-28
- 当前代码基线：`main@eb6827c`
- 前置完成：Gate 0–6、R0–R3
- 本文替代：`AI-Agent-Cultivation_Intelligent_Routing_Human_Bridge_v0.4.md` 中与动态任务评分、Runtime Migration、R3 后实施顺序相关的内容
- 目标：在进入 R4 自动路由前，先修正模型身份语义、清理动态评分、补齐模型可用性与 Human Bridge 恢复边界，并完成 Windows V1 的整体 UI 信息架构重构。

---

# 1. 最终产品模型

## 1.1 普通道友与 LLM 固定绑定

新的核心不变量：

```text
一个普通道友 = 一个固定的 LLM 执行身份
```

普通道友创建时确定：

```text
Provider Kind
Endpoint / Base URL
Model ID
Credential
Benchmark Capability Profile
```

创建并成功完成连接测试后：

```text
Provider / Endpoint / Model ID → 永久锁定
Credential / API Key          → 允许更新或轮换
```

想使用新的模型：

```text
新建一个新的道友
```

禁止：

```text
Teammate.switchRuntime(...)
将已绑定模型 A 的道友改成模型 B
直接修改已封存绑定的 Provider / Endpoint / Model ID
```

内部可继续保留 `runtimeProfileId` 作为执行、Usage、Audit 的稳定技术 ID，但它不再是用户可自由切换的产品概念。

建议新增一等对象：

```ts
TeammateModelBinding {
  teammateId
  runtimeProfileId
  providerKind
  endpoint
  modelId
  credentialId
  verifiedAt
  sealedAt
}
```

要求：

- `MODEL_RUNTIME` 道友必须恰好一个绑定；
- 一个 sealed Runtime/Binding 只属于一个普通道友；
- `USER_BRIDGE` 不存在 ModelBinding；
- ModelGateway、Mission、Usage、R3/R4 routing 均读取 sealed binding；
- Credential 可以轮换，但不得借此改变 Provider/Endpoint/Model。

---

## 1.2 Capability 只等于 Benchmark

废止旧设计：

```text
Benchmark + User Mission Rating → Dynamic Capability
```

新的 V1 规则：

```text
Teammate Capability Score = 当前固定 LLM 的 Benchmark Score
```

Experience、Memory、Skill 继续保留，但不修改 Benchmark 分数。

它们分别表示：

```text
Benchmark → 模型基础能力
Skill     → 可使用的功法/操作规则
Memory    → 道友长期上下文
Experience→ 做过什么、参与过什么
```

其中 Experience 可作为 Jev 的语义匹配上下文，但不能修改 Benchmark。

因此 R1 以下内容全部退出正式产品逻辑：

```text
Mission 结束用户星级评价
CapabilityEvidence 写入
TeammateCapabilityState 动态 currentScore
priorStrength
transferWeight
Runtime Migration 评分继承
ratingCount / evidenceWeight
```

已有 R1 数据可保留为 legacy 数据，但：

- 不再写入；
- 不再参与路由；
- 不再在普通 UI 显示；
- R3/R4 读取能力时直接读取有效 Benchmark。

后续稳定后可再决定是否物理删除 legacy 表。

---

## 1.3 Benchmark Profile 保留

14 维 Capability Taxonomy 保留：

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

每维：

```text
supported
normalizedScore 0–100
rawScore
source
benchmark
benchmarkVersion
snapshotDate
sourceUrl
provenanceType
```

必须继续区分：

```text
unsupported
```

与：

```text
supported + low score
```

Benchmark 可以随着公开榜单更新而由用户更新；更新 Benchmark 不等于更换模型。

Human Bridge：

```text
enabled dimension → score = 1
disabled dimension → unsupported
routingPolicy = FALLBACK_ONLY
```

Human Bridge 分数不再动态变化。

---

# 2. 模型即时可用性

## 2.1 四个状态

每个普通道友的固定 ModelBinding 具有：

```text
UNKNOWN
AVAILABLE
UNSTABLE
UNAVAILABLE
```

含义：

- `UNKNOWN`：尚未检测；
- `AVAILABLE`：最近即时检查可正常请求；
- `UNSTABLE`：近期存在超时/瞬时错误，但仍有成功记录；
- `UNAVAILABLE`：当前检查确认无法调用。

Availability 与 Benchmark 完全独立。

禁止：

```text
模型连接失败 → 降低 Coding / Reasoning Benchmark
```

---

## 2.2 检查时机

V1 不做后台轮询，不做高频健康监控。

只在以下场景检测：

```text
1. 一个请求即将真正发送给该模型之前；
2. 用户手动点击“重新检测”；
3. 实际模型请求成功/失败后更新状态。
```

自动路由时无需提前检查所有模型。

流程：

```text
按任务匹配得到候选顺序
↓
准备使用候选 A
↓
probe A
├─ AVAILABLE → 使用 A
├─ UNAVAILABLE → 排除 A，检查下一个候选
└─ UNSTABLE → 作为稳定性因素重新比较
```

---

## 2.3 Probe

定义：

```ts
interface ModelAvailabilityProbe {
  probe(bindingId): Promise<AvailabilityProbeResult>
}
```

优先采用 Provider 的低成本连接方式。

若 Provider 没有合适的免费/轻量接口，可以让实际请求结果作为最终可用性事实，避免为了检测产生大量额外费用。

不引入：

```text
后台定时器
Circuit Breaker
复杂健康事件系统
持续 ping
```

---

## 2.4 UNSTABLE

只维护少量近期连接结果即可，例如最近若干次 probe/真实调用。

无需建立完整历史健康账本。

路由行为：

```text
AVAILABLE   → 正常候选
UNSTABLE    → 保留候选，但加入稳定性 penalty
UNAVAILABLE → 直接排除
UNKNOWN     → 真正使用前 probe
```

稳定性 penalty 是 Routing Policy 参数，不修改 Benchmark。

---

## 2.5 显式指定与自动路由

用户明确指定道友：

```text
probe → AVAILABLE / UNSTABLE
→ 正常执行
```

若：

```text
probe → UNAVAILABLE
```

禁止偷偷换人。

UI 应提示：

```text
该道友当前不可用

[重新检测]
[选择其他道友]
[取消]
```

自动路由可以自动尝试下一个 eligible candidate。

---

# 3. Human Bridge 保留并修正

## 3.1 系统身份

Human Bridge：

```text
systemKind = HUMAN_BRIDGE
executorKind = USER_BRIDGE
routingPolicy = FALLBACK_ONLY
status = ACTIVE
```

必须由 Application + DB 双层保证：

- 唯一；
- 不可删除；
- 不可归档；
- 不可绑定 Runtime；
- 不可更换 executor/routing/system kind；
- 仅允许修改显示名称、头像等安全展示属性。

---

## 3.2 自动 fallback

R4 后的最终规则：

```text
普通 MODEL_RUNTIME 候选中
不存在“支持必要能力且当前可用”的模型
↓
检查 Human Bridge 是否启用对应能力
↓
Human Bridge
```

只要存在正常 eligible 模型，Human Bridge 不自动抢占任务。

用户始终可以显式指定 Human Bridge。

---

## 3.3 修复 ACCEPT 后的重启窗口

R0–R3 审计发现：

```text
ExternalWork 已 ACCEPTED
Mission 已回 RUNNING
Coordinator 尚未消费 continuation
↓
应用退出
↓
Gate3 recovery 把 Run 标为 INTERRUPTED
```

必须改成 durable continuation。

推荐：

```text
ExternalWork ACCEPTED
↓
写入 durable continuation = PENDING
↓
Mission 保持 WAITING_EXTERNAL_WORK 或进入可恢复中间状态
↓
Coordinator 开始消费 continuation
↓
转 RUNNING
↓
完成 synthesis
↓
continuation = CONSUMED
```

启动恢复必须识别：

```text
ACCEPTED + PENDING continuation
```

并恢复原 MissionRun，而不是当作普通 RUNNING crash 直接 INTERRUPT。

要求 exactly-once / idempotent：

- 同一 ExternalWork 不得重复进入 synthesis；
- 重启后继续同一 Run；
- ACCEPTED Artifact/Experience 不丢失；
- CANCELLED/REJECTED 不产生成功 continuation。

---

# 4. R3 Decision Plane 修正

R3 的 Jev SHADOW 架构继续保留。

仍然保持：

```text
DecisionGateway != ModelGateway
Jev = SHADOW
Permission = deterministic authority
```

---

## 4.1 R3 Capability 输入改为 Benchmark-only

当前 TEAMMATE_FIT 不再读取动态 `currentScore`。

改为：

```text
有效 Benchmark normalizedScore
→ LOW / MEDIUM / HIGH band
```

Human Bridge 固定 score=1，仅在真正 fallback 语义需要时出现。

---

## 4.2 Candidate Eligibility

R0–R3 审计发现当前 candidate builder 仅检查：

```text
ACTIVE + Runtime exists
```

不够。

R3/R4 统一使用 `RoutingEligibilityService`。

至少过滤：

```text
Teammate ACTIVE
ModelBinding sealed
Provider binding structurally valid
Capability supported
不是 FALLBACK_ONLY（普通候选阶段）
last-known availability != UNAVAILABLE
```

`UNKNOWN` 不需要为了 SHADOW 批量 probe。

真正发请求前再即时 probe。

Human Bridge 不再默认参加普通 `TEAMMATE_FIT`；它是确定性的 fallback executor。

---

## 4.3 Cloud Decision 隐私提示

启用 TypeSafe Cloud Shadow 前，UI 必须明确告诉用户可能发送：

```text
有界任务摘要
候选 ID/角色名
Benchmark capability band
Skill 元数据
Experience 摘要
```

明确不会发送：

```text
API Key / Credential
raw private Memory
完整文件
完整聊天历史
完整 Mission Event/Audit
Tool secret/output 原文
```

必须由用户主动开启 Cloud Shadow。

---

# 5. UI Information Architecture Reset

参考方向：

```text
Windows Fluent 2
+ Linear 的低视觉噪声
+ Notion 的简洁导航
+ Raycast 的紧凑操作
```

视觉示意图仅作为方向参考，不要求像素级复刻。

---

## 5.1 全局视觉

主题：

```text
Light only for V1
主背景：白色
次级区域：极浅灰
品牌色：只用于主操作 / 选中态 / 少量修仙视觉元素
```

禁止：

```text
大面积深色背景
大量渐变
每个区块不同色块
过度 Card 化
```

---

## 5.2 字体层级

全应用原则上只保留 4 级：

```text
页面标题    20px Semibold
区块标题    14px Semibold
正文/字段   14px Regular
辅助信息    12px Regular
```

避免：

```text
Eyebrow
大标题
副标题
解释段
卡片标题
卡片说明
再叠状态文字
```

同一页面不应出现大量不同字号。

---

## 5.3 文案规则

默认只显示完成任务所必需的文字。

说明文字只在：

```text
首次使用
错误
危险操作
用户明确展开“帮助/高级”
```

时出现。

输入字段：

```text
必须有外部 Label
输入框默认为空
禁止 placeholder
禁止默认示例内容占据输入框
```

---

## 5.4 左侧导航

建议固定：

```text
首页
道友
队伍
历练
记忆
设置
```

每项：

```text
Icon + 短标签
```

不显示解释句。

支持折叠。

---

## 5.5 道友页

采用：

```text
左：紧凑道友列表
右：当前道友详情
```

道友列表只显示：

```text
头像
名称
模型名
Availability 状态点
```

详情顶部：

```text
头像 + 名称 + 固定 Model + 状态
[开始对话] [发起历练] [更多]
```

能力区域直接显示 Benchmark：

```text
编程        92
推理        86
工具        89
长上下文    84
```

不再显示：

```text
用户评分
evidence weight
rating count
transferWeight
Runtime 切换
```

Provider/Endpoint/Benchmark 来源等进入详情/高级区域。

---

## 5.6 历练页是统一任务入口

用户不应该先判断“这是单 Agent 还是多 Agent”。

入口：

```text
历练
[+ 发起历练]
```

新建：

```text
任务
[空白输入区域，无 placeholder]

执行方式
○ 自动分配
○ 指定道友
○ 指定队伍

[开始]
```

自动分配最终可以：

```text
单道友
或
临时 Party / 多道友协作
```

用户显式指定只是限制路由范围，不改变 Mission 本质。

Mission 执行过程中仍可通过审批动态邀请新的道友。

---

## 5.7 首页

首页只保留高价值信息：

```text
[发起历练]

最近历练
正在执行 / 等待用户动作
本尊待办
少量系统异常状态
```

不做大而全 Dashboard。

---

## 5.8 队伍页

只显示：

```text
队伍名
Coordinator
成员头像
Availability 小状态点
```

创建/编辑时保持紧凑。

成员详细能力不在列表页展开。

---

## 5.9 Human Bridge UI

Human Bridge 仍作为“本尊”出现在道友列表。

详情页：

```text
本尊
Human Bridge
启用的外部能力
外部工具
待办
```

首页/历练详情可显示简洁“本尊待办”。

Windows 系统通知继续保持无敏感内容。

---

## 5.10 高级功能下沉

以下不应占据普通工作流主页面：

```text
Jev Shadow
Decision Receipt
Benchmark provenance
MCP 详细配置
Audit
原始 Usage
开发诊断
```

放入：

```text
Settings / Advanced
详情抽屉
开发者视图
```

---

# 6. 修订后的路由架构

最终自动任务流程：

```text
用户发起历练
↓
Jev TASK_CAPABILITY
↓
Deterministic Capability Eligibility
↓
Benchmark Candidate Ranking
↓
Jev Semantic Fit / Collaboration Need
↓
准备选择候选
↓
Just-in-time Availability Probe
├─ AVAILABLE → 可执行
├─ UNSTABLE → 加 stability penalty 后比较
└─ UNAVAILABLE → 排除并尝试下一个
↓
无普通候选
→ Human Bridge fallback
↓
Permission / Approval
↓
执行
↓
Result / Experience
```

路由输入：

```text
Benchmark
Availability
Skill metadata
Experience summary
Jev semantic decision
Policy constraints
```

明确不包含：

```text
用户任务星级评分
动态 CapabilityEvidence
Runtime Migration score
```

---

# 7. R3 后实施阶段

## R3.1 — Identity & Capability Correction

目标：先修正数据语义，不做自动路由。

实施：

1. 增加 sealed `TeammateModelBinding`；
2. 普通道友与 ModelBinding 变成 1:1；
3. 迁移现有 Runtime，共享 Runtime 必须安全拆分/复制；
4. 移除 `switchRuntime`；
5. sealed 后禁止修改 Provider / Endpoint / Model；
6. 增加 Credential/API Key rotation；
7. 移除任务评价 UI / IPC / write path；
8. Capability 改为 Benchmark-only；
9. R3 TEAMMATE_FIT 改读 Benchmark band；
10. Human Bridge 禁止归档；
11. 修复 R2 ACCEPT/continuation crash consistency；
12. 增加 Cloud Shadow 隐私说明；
13. 保持 Jev 纯 SHADOW。

完成后停止审批。

---

## R3.2 — Availability Foundation

目标：增加即时可用性，不做后台监控。

实施：

```text
UNKNOWN / AVAILABLE / UNSTABLE / UNAVAILABLE
ModelAvailabilityProbe
request-before-send probe
真实请求结果更新状态
UNAVAILABLE hard exclude
UNSTABLE routing penalty data
状态 UI
```

同时建立：

```text
RoutingEligibilityService
```

R3 Shadow candidate 也使用该 Eligibility，但不为了 Shadow 主动 probe 所有模型。

完成后停止审批。

---

## R3.3 — UI Information Architecture Reset

目标：不改变核心业务语义，重构 Windows V1 界面。

实施：

```text
白色亮色 Design Tokens
4 级字体体系
统一 Sidebar
删除冗余解释文字
取消输入 placeholder
道友页重构
历练统一入口
首页简化
队伍页简化
本尊待办优化
Settings/Advanced 下沉高级功能
Availability 状态可视化
```

视觉示意图作为参考，不要求一比一复刻。

完成后做 Windows packaged visual/function smoke，再停止审批。

---

## R4 — Controlled Intelligent Routing

只有 R3.1–R3.3 全部通过后进入。

R4 实现真正自动路由：

### R4.1 Task Capability

Jev：

```text
Task → TaskCapabilityDemand
```

---

### R4.2 Candidate Eligibility

代码过滤：

```text
ACTIVE
sealed ModelBinding
required capability supported
routing policy
last-known availability
permission/policy constraints
```

Human Bridge 先排除。

---

### R4.3 Benchmark Ranking

代码使用：

```text
TaskCapabilityDemand × Benchmark
```

得到基础候选顺序。

不使用动态任务评价。

---

### R4.4 Semantic Fit

Top-K 交给 Jev：

```text
Benchmark bands
Skill metadata
Experience summary
task summary
```

得到语义 fit。

---

### R4.5 Availability Probe

真正选定候选前：

```text
probe
```

失败则尝试下一个。

UNSTABLE 作为额外 penalty。

---

### R4.6 SOLO / Collaboration

Jev `COLLABORATION_NEED` + deterministic policy 判断：

```text
单道友
或
临时 Party
```

Coordinator 仍负责生成具体子任务。

跨道友邀请继续遵守现有 Permission / Approval。

---

### R4.7 Human Bridge Fallback

仅当：

```text
所有普通模型均：
unsupported
或 unavailable
```

且 Human Bridge 对应能力 enabled 时自动 fallback。

---

### R4.8 用户显式选择

用户指定：

```text
指定道友
指定队伍
```

具有最高路由优先级。

若指定道友不可用：

```text
提示用户
不静默改派
```

---

### R4.9 Decision Receipt

所有 ACTIVE 路由必须解释：

```text
任务需要什么能力
哪些候选被过滤
Benchmark 比较
Jev recommendation
Availability
最终选择
```

但不保存 CoT。

---

## R5 — Harness Optimization

在 R4 稳定后逐项启用。

### R5.1 Skill Routing

```text
Enabled Skills
→ deterministic shortlist
→ Jev relevance
→ Top 1–3
→ PromptComposer
```

避免 Skill 数量增长造成 context rot。

---

### R5.2 Memory Pre-Gate

Jev 只判断：

```text
是否值得进入昂贵 Memory extraction
```

不直接生成 Memory。

---

### R5.3 Memory Rerank

```text
Owner scope filter
→ FTS/sqlite-vec
→ Jev rerank
→ Top K
```

Owner scope 永远先于 Jev。

---

### R5.4 Tool Shortlist

```text
Tool eligibility
→ Jev shortlist
→ Generative Model 生成 args
→ ToolRuntime
→ PermissionEngine
```

Jev 永远不能绕过 Permission。

---

### R5.5 Review / Completion Advisory

Jev 可以判断：

```text
needs_review
objective_satisfied
should_continue
```

但 Mission transition 最终仍由 deterministic code/policy 控制。

---

### R5.6 删除旧 Runtime Routing 计划

旧 v0.4 中：

```text
根据复杂度给同一个道友切换底层 Runtime
```

正式废止。

模型选择发生在：

```text
选择哪个道友
```

而不是：

```text
同一个道友换哪个模型
```

---

# 8. R6 — Alpha Acceptance & V1 Hardening

完成 R5 后进入最终真实验收。

至少验证：

```text
真实 OpenAI/Anthropic/Google/DeepSeek/OpenAI-Compatible
固定模型绑定
Credential rotation
即时 availability
单人自动路由
多人自动协作
Human Bridge fallback
外部 Artifact 恢复
Windows 通知
Jev Cloud Shadow/Active
Skill/Memory/Tool 优化
重启恢复
安装包升级
```

之后：

```text
Alpha Stabilization
→ Real Provider Acceptance
→ V1 Release Hardening
```

---

# 9. 数据迁移原则

不得修改 0001–0013。

从：

```text
0014+
```

继续。

要求：

- 现有用户数据不静默丢失；
- 共享 Runtime 在 1:1 binding migration 时必须显式复制或建立稳定映射；
- 历史 Mission / Usage / Event / Audit 保留原始事实；
- R1 CapabilityEvidence 可保留为 legacy，不再参与产品逻辑；
- 不重写旧 Mission/Experience 历史以迎合新评分模型；
- Human Bridge 历史 ExternalWork/Experience 保留。

---

# 10. 关键验收不变量

1. 普通道友创建并 seal 后不能更换模型。
2. Provider/Endpoint/Model 不能通过任何 IPC 绕过锁定。
3. API Key/Credential 可以安全轮换。
4. 一个 sealed model binding 只属于一个普通道友。
5. Benchmark 是普通道友唯一能力分来源。
6. Mission 用户评价不再产生 CapabilityEvidence。
7. 旧 CapabilityEvidence 不影响任何路由。
8. Human Bridge 永远不绑定模型。
9. Human Bridge 永远不能归档。
10. Human Bridge enabled capability = score 1。
11. Availability 不修改 Benchmark。
12. UNAVAILABLE 模型不参与自动执行。
13. UNSTABLE 只作为路由附加因素。
14. 不做后台模型轮询。
15. 用户显式指定不可用模型时不静默换人。
16. ExternalWork ACCEPT 后任意 crash 点都能恢复同一 Run。
17. ExternalWork continuation 不重复消费。
18. R3/R4 candidate 不包含结构上不可执行的模型。
19. Human Bridge 不默认进入普通 TEAMMATE_FIT。
20. TypeSafe Cloud 发送范围在 UI 明示。
21. Jev 不能修改 Permission。
22. 道友页面不存在 Runtime switch。
23. 输入框没有 placeholder/default 示例文本。
24. 全局界面保持白色亮色体系。
25. 普通页面不堆叠大段说明文案。
26. 历练是统一任务入口。
27. 自动历练可形成单人或多人执行。
28. Advanced 技术信息不占据普通用户主流程。

---

# 11. 新旧计划对照

正式保留：

```text
Decision Plane
Benchmark Catalog
Human Bridge
ExternalWork
Skill routing
Memory gate/rerank
Tool shortlist
Review advisory
Decision Receipt
```

正式废止：

```text
Teammate 可自由切换 Runtime
Runtime Migration
Mission 用户评分
Dynamic Capability Learning
CapabilityEvidence 参与评分
Human Bridge 动态评分
同一道友按复杂度自动切模型
```

新增：

```text
Sealed TeammateModelBinding
Just-in-time Model Availability
RoutingEligibilityService
Human Bridge durable continuation recovery
UI Information Architecture Reset
统一“历练”任务入口
```

---

# 12. 最终系统闭环

```text
创建道友
↓
配置 Provider / Model / Credential
↓
连接测试成功
↓
ModelBinding seal
↓
填写 Benchmark
↓
长期 Memory / Skill / Experience

用户发起历练
↓
Jev 理解任务能力需求
↓
Benchmark + Policy 生成候选
↓
即时 Availability Probe
↓
单人 / Party
↓
必要时 Human Bridge fallback
↓
Permission / Approval
↓
执行
↓
结果与 Experience
```

能力评分始终保持：

```text
Benchmark = 模型能力事实
```

而不是让模型历史、网络稳定性或用户主观评价污染同一个分数。

这使“道友”真正成为：

```text
一个固定模型
+ 一个持续身份
+ Memory
+ Skill
+ Experience
```

而整个队伍的智能来自：

```text
Jev Decision Plane
+ Benchmark
+ Availability
+ Collaboration
+ Human Bridge
+ Deterministic Safety
```
