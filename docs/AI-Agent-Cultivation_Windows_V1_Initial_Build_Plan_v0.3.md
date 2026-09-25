# AI-Agent-Cultivation Windows V1 初版构建计划
## Architecture & Execution Plan v0.3

- 日期：2026-09-25
- 目标仓库：`Ethan-Martinez-creater/AI-Agent-Cultivation`
- 当前仓库状态：空仓库，默认分支 `main`
- 面向对象：执行智能体 + 后续代码评审
- 文档定位：第三轮产品收敛后的**首版工程基线**。除非后续评审明确修改，本文件中的领域边界、依赖方向、状态机和安全约束视为 V1 的架构约束。
- 首要目标：尽快构建一个可以真实使用、可以验证“长期 AI 队友”核心假设的 Windows Alpha，而不是一次性实现完整 AI Agent 平台。

---

# 0. 执行摘要

AI-Agent-Cultivation 不是一个“多 Provider 聊天客户端”，也不是把多个一次性 Subagent 包装成修仙主题的 Agent Swarm。

V1 必须证明下面五件事情：

1. **Teammate Identity 独立于 Model / Provider / API Key。**
   - 用户拥有的是“道友”，模型只是道友当前的 Runtime。
   - 更换 Provider 或模型后，道友身份、记忆、技能、经历、任务历史必须保持。

2. **每个 Teammate 有真正隔离的长期 Memory。**
   - A 道友的私有记忆不得默认泄漏给 B。
   - Memory 必须有来源、作用域、生命周期和可审计记录。

3. **单道友可以完成完整 Mission。**
   - Mission 不是 Chat 的别名。
   - Mission 必须拥有状态、运行记录、事件、Token 使用、失败原因和可恢复的审批状态。

4. **多个 Teammate 可以以受控方式协作。**
   - 支持 Consultation、Review、Delegation 三种基础协作。
   - V1 禁止无限递归代理和无约束 Swarm。
   - 默认 Single Teammate First，确有收益时再扩编。

5. **Agent 可以提出主动请求，但执行权属于 User。**
   - Agent 可提出使用工具、邀请队友、写入 Memory 等请求。
   - 敏感动作必须经过 Permission Engine。
   - 所有动作形成 Audit Trail。

如果某项实现不能直接加强上述五点，应降低优先级。

---

# 1. V1 产品边界

## 1.1 V1 P0

Windows V1 必须包含：

- Provider 配置与凭证安全存储
- OpenAI / Anthropic / Google / DeepSeek 基础适配
- Generic OpenAI-Compatible Provider
- Teammate 创建、编辑、归档、复制
- Teammate 与 Runtime 解耦
- 单 Teammate 持续 Chat
- Mission 模型与 Mission Runtime
- 每个 Teammate 独立长期 Memory
- Skill（声明式、非可执行代码）
- Built-in Tool
- MCP Client 接入
- Permission / Approval
- Party
- Consultation / Review / Delegation
- Agent 主动提出 Collaboration Request
- Audit Timeline
- Token Usage
- 基础经历册 / 能力档案
- Windows 打包产物

## 1.2 V1 明确不做

以下功能不得在 V1 核心链路完成前提前实现：

- Browser Control
- Computer Use
- Shell / PowerShell 自主执行
- Agent Marketplace
- Skill Marketplace
- 云同步
- 多真实用户协作
- Web 版本
- Mobile
- 完整 A2A 网络
- 无限 Subagent
- 自动递归 Delegation
- Agent 自动安装未知 MCP Server
- Agent 自修改 Skill
- Agent 自修改权限
- Background daemon
- 复杂 Scheduler
- “AI 公司 / 宗门组织树”
- 3D Avatar
- 自动社交关系模拟
- 纯聊天次数驱动的升级系统

这些功能均可以在架构中预留扩展位，但禁止成为当前迭代的阻塞项。

---

# 2. 固定产品原则

后续实现必须遵守以下不变量。

## P-01 Teammate First

领域模型中 `Teammate` 是第一实体。

禁止把 Teammate 实现为：

```text
provider + model + system_prompt
```

正确关系：

```text
Teammate
   |
   +-- Identity
   +-- Behavior
   +-- Memory
   +-- Skills
   +-- Tool Grants
   +-- Experience
   +-- Relationships (future)
   |
   +-- RuntimeBinding ---> RuntimeProfile ---> Provider / Model / Credential
```

`RuntimeProfile` 可替换，Teammate ID 不变化。

---

## P-02 Local First

以下数据默认保存在本地：

- Teammate
- Memory
- Skill
- Party
- Mission
- Message
- Approval
- Audit Event
- Usage
- Provider Configuration

除模型请求和用户主动配置的外部 MCP 之外，不增加隐藏云服务。

---

## P-03 Human Authority

允许：

```text
Agent -> Proposal -> User Approval -> Execution
```

禁止：

```text
Agent -> 自己提升权限 -> 执行
Agent -> 自己创建 Credential
Agent -> 未经授权邀请大量 Agent
Agent -> 自动安装 MCP
```

---

## P-04 Single Teammate First

一个任务默认先由一个最合适的 Teammate 工作。

只有出现以下情形才建议 Collaboration：

- 能力缺口
- 需要独立 Review
- 明确可以并行分解
- 用户直接要求多方讨论

V1 中：

- Party 最大 4 个 Teammate。
- Delegation 深度最大 1 层。
- 被 Delegation 的 Teammate 不得继续自动 Delegation。
- 若需要继续扩编，必须回到 Coordinator 并产生新的 Collaboration Request。

---

## P-05 Auditable

所有下列操作必须可追踪：

- Model Call
- Tool Call
- Permission Request
- Permission Decision
- Collaboration Request
- Memory Proposal
- Memory Commit
- Runtime Change
- Mission State Change
- Token Usage
- Error / Retry

---

## P-06 Cultivation = Verified Capability

修仙元素必须映射真实系统能力。

禁止：

```text
聊天 100 次 -> 筑基
```

V1 的“成长”先实现：

- 经历册
- 完成 Mission 数
- 成功/失败记录
- 用户反馈
- 使用过的 Skill
- 能力标签
- 境界字段

V1 **不自动升级境界**。境界升级机制在 Evaluation 系统完成前保持锁定，避免制造虚假的能力评分。

---

# 3. 技术栈决策

## 3.1 Desktop：Electron

采用：

- Electron
- Electron Forge
- Vite + TypeScript
- React
- Windows x64 首发

选择 Electron，而不是 Tauri，原因：

1. V1 最大复杂度在 Node 侧：
   - AI Provider
   - MCP
   - SQLite
   - 文件工具
   - Child Process
   - Permission
   - Streaming
2. TypeScript/Node 可以贯穿 Renderer 之外的主要运行时。
3. MCP 官方 TypeScript SDK 直接运行于 Node。
4. AI SDK Core 直接运行于 Node。
5. Electron 后续仍可支持 macOS / Linux。
6. 避免 V1 同时维护 TypeScript + Rust + Node Sidecar 三套边界。

代价：

- 安装包和内存占用高于 Tauri。
- Electron 主进程拥有高权限，因此安全隔离必须从 Phase 0 就完成。

### 强制 Electron 安全配置

Renderer：

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
```

必须：

- Renderer 只加载本地应用内容。
- 禁止把 `ipcRenderer` 整体暴露给 Renderer。
- Preload 每个功能定义独立的 typed wrapper。
- 所有 IPC 参数使用 Zod 校验。
- 校验 IPC sender。
- 设置严格 CSP。
- 禁止任意 Navigation / Window Open。
- 禁止 Renderer 直接访问 DB / fs / child_process。
- 禁止 Renderer 获取明文 API Key。

---

## 3.2 Frontend

采用：

- React
- TypeScript
- Vite
- React Router
- Zustand（仅 UI / ephemeral state）
- Tailwind CSS
- Radix UI primitives 或等价无业务耦合 primitive

要求：

- 业务数据以 Main Process / Local DB 为 Source of Truth。
- Zustand 不得充当持久化数据库。
- UI 只通过 typed IPC API 获取/修改业务状态。
- 修仙词汇和技术词汇同时出现，例如：
  - `道友 Teammate`
  - `功法 Skills`
  - `历练 Missions`
  - `法宝 Tools`

不要让世界观影响功能可发现性。

---

## 3.3 AI Provider Abstraction

采用 AI SDK 6 Core 作为 Provider 抽象层。

首批 Provider：

- OpenAI
- Anthropic
- Google Generative AI
- DeepSeek
- OpenAI-Compatible

使用：

- `createProviderRegistry`
- 官方 provider packages
- `@ai-sdk/openai-compatible`
- `generateText` / `streamText`
- Tool Calling
- Structured Output
- Embedding API（Memory 后期）

### 重要约束

不要直接把 AI SDK 的 Agent / ToolLoopAgent 当成我们的领域 Agent。

我们的：

```text
Teammate
Mission
Party
Permission
Collaboration
Memory
```

必须由自己的 Runtime 管理。

AI SDK 只负责：

```text
Model invocation
Streaming
Tool schema
Structured output
Usage normalization
Provider abstraction
```

Agent Loop 采用我们自己的 `MissionRuntime` 控制。

原因：

- 需要持久 Mission State。
- 需要自己的 Approval State。
- 需要 Collaboration。
- 需要重启恢复。
- 需要严格 Audit。
- 需要限制 Delegation Depth。
- 需要独立 Teammate Identity。

---

## 3.4 MCP

采用 MCP TypeScript SDK v2 stable line。

V1 只作为 **MCP Client / Host**：

```text
AI-Agent-Cultivation
       |
       +--> MCP Server A
       +--> MCP Server B
```

支持：

- stdio transport
- 后续可扩展 Streamable HTTP

V1 不需要开发通用 MCP Server。

### MCP 安全要求

用户手动添加 MCP Server：

```text
name
command
args
env whitelist
working directory
enabled
```

Agent 不得：

- 自行安装 MCP Server
- 自行修改 command
- 自行扩大 env
- 直接读取系统全部环境变量

MCP Tool 发现后统一转换成内部 `ToolDescriptor`。

---

## 3.5 Persistence

采用：

- SQLite
- `better-sqlite3`
- 显式 SQL Migration
- Repository Pattern

暂时不引入大型 ORM。

原因：

- Schema 是产品核心，应该显式可审查。
- SQLite 本地部署简单。
- `better-sqlite3` 成熟。
- Electron Forge 可自动执行 Electron native module rebuild。
- 后续可以加载 sqlite-vec。
- 避免 ORM 当前版本变化影响初期 Schema。

### Native Module

Electron Native Module 必须：

- 使用 Electron Forge 自动 rebuild。
- 使用 `@electron-forge/plugin-auto-unpack-natives`。
- Windows 打包测试必须在引入 `better-sqlite3` 的第一个 Gate 完成，不得等项目结束再验证。

---

## 3.6 Memory Search

分两步。

### V1-A

SQLite：

- Structured filter
- FTS5
- Recency
- Importance
- Scope

### V1-B

在 Windows 打包验证通过后加入：

- `sqlite-vec`
- Embedding
- Hybrid Retrieval

没有配置 Embedding Provider 时，Memory 必须仍可用。

禁止将“能否配置 embedding”作为 Memory 功能的前置条件。

---

## 3.7 Validation

统一采用 Zod：

- IPC
- Tool input
- Provider config
- Runtime config
- Structured LLM output
- Memory candidate
- Collaboration request
- Skill manifest

---

## 3.8 Test

采用：

- Vitest：domain / application / runtime / repositories
- Mock Language Model：确定性 AI Runtime 测试
- MCP fixture server：MCP integration
- Playwright Electron：关键桌面 E2E

所有核心业务逻辑必须可在**不启动真实 LLM API**的情况下测试。

---

# 4. 总体架构

采用 Hexagonal / Ports and Adapters 思路。

```text
┌─────────────────────────────────────────┐
│             React Renderer              │
│     UI / ViewModel / UI State only      │
└─────────────────┬───────────────────────┘
                  │ typed IPC
┌─────────────────▼───────────────────────┐
│                Preload                  │
│      narrow contextBridge surface       │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼──────────────────────────────────┐
│                Electron Main                       │
│                                                   │
│ Application Kernel                                │
│ ├─ TeammateService                                │
│ ├─ ProviderService                                │
│ ├─ MissionService                                 │
│ ├─ PartyService                                   │
│ ├─ MemoryService                                  │
│ ├─ SkillService                                   │
│ ├─ PermissionService                              │
│ └─ AuditService                                   │
│                                                   │
│ Runtime                                           │
│ ├─ PromptComposer                                 │
│ ├─ ModelGateway                                   │
│ ├─ MissionRuntime                                 │
│ ├─ CollaborationEngine                            │
│ ├─ ToolRuntime                                    │
│ └─ MemoryRetriever                                │
│                                                   │
│ Infrastructure                                    │
│ ├─ SQLite                                         │
│ ├─ SecretStore                                    │
│ ├─ AI SDK Providers                               │
│ ├─ MCP Client                                     │
│ └─ File Tools                                     │
└───────────────────────────────────────────────────┘
```

核心 Runtime 不允许 import Electron API。

Electron 只负责：

- 应用生命周期
- 窗口
- IPC
- OS secure storage
- OS 文件选择
- 打包
- Main Process composition root

这样未来 Web 版本可以重新组合：

```text
Web UI
   |
HTTP/WebSocket
   |
same domain/application/runtime packages
```

---

# 5. 推荐仓库结构

采用 npm workspaces。

```text
AI-Agent-Cultivation/
├─ apps/
│  └─ desktop/
│     ├─ src/
│     │  ├─ main/
│     │  │  ├─ bootstrap/
│     │  │  ├─ ipc/
│     │  │  └─ electron/
│     │  ├─ preload/
│     │  └─ renderer/
│     │     ├─ app/
│     │     ├─ pages/
│     │     ├─ features/
│     │     ├─ components/
│     │     └─ styles/
│     └─ forge.config.ts
│
├─ packages/
│  ├─ domain/
│  │  ├─ teammate/
│  │  ├─ runtime/
│  │  ├─ mission/
│  │  ├─ party/
│  │  ├─ memory/
│  │  ├─ skill/
│  │  ├─ tool/
│  │  ├─ permission/
│  │  └─ audit/
│  │
│  ├─ application/
│  │  ├─ commands/
│  │  ├─ queries/
│  │  ├─ ports/
│  │  └─ services/
│  │
│  ├─ agent-runtime/
│  │  ├─ mission-runtime/
│  │  ├─ prompt/
│  │  ├─ collaboration/
│  │  └─ events/
│  │
│  ├─ providers/
│  ├─ persistence/
│  ├─ memory-engine/
│  ├─ tool-runtime/
│  └─ shared/
│
├─ migrations/
├─ tests/
│  ├─ fixtures/
│  └─ e2e/
├─ docs/
│  ├─ architecture/
│  ├─ decisions/
│  └─ status/
├─ package.json
├─ package-lock.json
├─ tsconfig.base.json
└─ README.md
```

### 依赖方向

严格限制为：

```text
shared
   ↑
domain
   ↑
application
   ↑
agent-runtime
```

Adapters：

```text
providers ------┐
persistence ----┤
memory-engine --┤--> application ports
tool-runtime ---┘
```

Desktop 是 Composition Root：

```text
desktop -> all required packages
```

禁止：

```text
domain -> electron
domain -> sqlite
domain -> ai-sdk
domain -> mcp
application -> React
runtime -> Electron
```

---

# 6. P0 领域对象

---

## 6.1 Teammate

### Entity

```ts
Teammate {
  id
  name
  avatar
  title
  description
  identityPrompt
  behaviorPrompt
  status
  realm
  currentRuntimeProfileId
  createdAt
  updatedAt
}
```

### Status

```text
ACTIVE
ARCHIVED
```

禁止物理删除已经参与 Mission 的 Teammate。

删除操作应转为 Archive。

---

## 6.2 RuntimeProfile

```ts
RuntimeProfile {
  id
  name
  providerId
  credentialId
  modelId
  parameters
  capabilityOverrides
  createdAt
  updatedAt
}
```

`Teammate.currentRuntimeProfileId` 可以修改。

必须提供测试证明：

```text
switchRuntime(teammate A)
```

不会修改：

- teammate.id
- memory ownership
- mission history
- skills
- experience

---

## 6.3 Memory

```ts
MemoryRecord {
  id
  ownerType
  ownerId
  memoryType
  content
  summary
  sourceType
  sourceId
  importance
  confidence
  status
  createdAt
  updatedAt
  expiresAt?
}
```

### ownerType

V1：

```text
USER
TEAMMATE
MISSION
```

预留：

```text
PARTY
WORKSPACE
RELATIONSHIP
```

### memoryType

```text
IDENTITY
PREFERENCE
FACT
EPISODE
PROCEDURE
OBSERVATION
```

### status

```text
PROPOSED
ACTIVE
REJECTED
ARCHIVED
```

V1 默认流程：

```text
LLM / Runtime
   ↓
MemoryCandidate
   ↓
PROPOSED
   ↓
User Accept / Edit / Reject
   ↓
ACTIVE / REJECTED
```

禁止模型直接静默写入长期 Memory。

可以在后续设置中加入自动写入模式，但不是 V1 默认。

---

## 6.4 Skill

V1 Skill 是声明式 procedure，不是任意代码。

```ts
Skill {
  id
  name
  description
  instructions
  version
  tags
  status
  createdAt
  updatedAt
}
```

Link：

```text
teammate_skills
```

V1 Skill 可以描述：

- 任务流程
- 检查步骤
- 输出要求
- Tool 使用建议

V1 Skill 不允许包含：

- 任意 JS eval
- 可执行 PowerShell
- 自动安装 package
- 修改权限

---

## 6.5 Tool

内部统一接口：

```ts
ToolDescriptor {
  id
  source
  name
  description
  inputSchema
  riskLevel
  sideEffect
}
```

### source

```text
BUILTIN
MCP
```

### riskLevel

```text
READ_ONLY
LOW
MEDIUM
HIGH
```

### sideEffect

```text
NONE
LOCAL_WRITE
EXTERNAL_WRITE
PROCESS_EXECUTION
```

首批 Built-in Tools：

```text
file.list
file.readText
file.writeText
file.createDirectory
```

其中 write / create 必须默认 Ask。

Shell Tool 不进入 V1 P0。

---

## 6.6 Party

```ts
Party {
  id
  name
  description
  coordinatorTeammateId
  type
  status
  createdAt
}
```

type：

```text
FIXED
AD_HOC
```

members：

```ts
PartyMember {
  partyId
  teammateId
  role
  order
}
```

V1：

- 2～4 人。
- 必须有一个 Coordinator。
- Coordinator 本身也是 Teammate，不是隐藏系统 Agent。

---

## 6.7 Mission

Mission 是执行边界。

```ts
Mission {
  id
  title
  objective
  initiatorType
  initiatorId
  coordinatorTeammateId
  partyId?
  mode
  state
  createdAt
  updatedAt
  completedAt?
}
```

### mode

```text
SOLO
CONSULTATION
REVIEW
DELEGATION
```

### state

```text
DRAFT
READY
RUNNING
WAITING_APPROVAL
WAITING_COLLABORATION
PAUSED
COMPLETED
FAILED
CANCELLED
INTERRUPTED
```

---

## 6.8 Permission

不要把 Permission 写死在 Tool 中。

```ts
PermissionRule {
  id
  subjectType
  subjectId
  capability
  resourcePattern
  decision
  scope
}
```

### capability

至少：

```text
MEMORY_READ
MEMORY_WRITE
FILE_READ
FILE_WRITE
MCP_TOOL_EXECUTE
INVITE_TEAMMATE
CREATE_MISSION
SPEND_BUDGET
```

预留：

```text
WEB_ACCESS
BROWSER_CONTROL
EXECUTE_COMMAND
EXTERNAL_MESSAGE
INSTALL_TOOL
```

### decision

```text
ALLOW
DENY
ASK
```

### scope

```text
GLOBAL
TEAMMATE
MISSION
```

---

# 7. 支撑实体

虽然产品核心是 8 个 P0 对象，但工程上必须增加以下实体。

## 7.1 ProviderConfig

```text
providers
provider_credentials
runtime_profiles
```

Credential 明文禁止进入 DB。

DB 只保存 `safeStorage` 加密后的 ciphertext。

---

## 7.2 MissionRun

Mission 和某一次执行分开。

```ts
MissionRun {
  id
  missionId
  attempt
  status
  startedAt
  endedAt
  errorCode?
  errorMessage?
}
```

这样可以：

- Retry
- Compare runs
- Crash recovery
- Audit

---

## 7.3 Message

不要直接使用 UI Chat message 作为 Runtime truth。

```ts
Message {
  id
  missionId?
  conversationId
  actorType
  actorId
  role
  content
  createdAt
}
```

---

## 7.4 MissionEvent

Append-only。

```ts
MissionEvent {
  id
  missionId
  runId?
  eventType
  actorType
  actorId?
  payloadJson
  createdAt
}
```

---

## 7.5 ApprovalRequest

```ts
ApprovalRequest {
  id
  missionId
  runId
  requesterTeammateId
  capability
  actionType
  actionPayload
  riskLevel
  state
  createdAt
  resolvedAt?
}
```

state：

```text
PENDING
APPROVED
DENIED
CANCELLED
EXPIRED
```

---

## 7.6 CollaborationRequest

```ts
CollaborationRequest {
  id
  missionId
  requesterTeammateId
  targetTeammateId
  reason
  proposedTask
  estimatedUsage?
  state
}
```

---

## 7.7 AuditEvent

与 MissionEvent 不同：

- MissionEvent 描述业务执行流。
- AuditEvent 描述安全/系统行为。

---

## 7.8 UsageRecord

```ts
UsageRecord {
  id
  missionId?
  runId?
  teammateId
  runtimeProfileId
  provider
  model
  inputTokens
  outputTokens
  cachedInputTokens?
  reasoningTokens?
  providerMetadata?
  estimatedCost?
  currency?
  createdAt
}
```

不要把成本计算写死在模型名称中。

价格数据可配置，Usage 原始 Token 必须永久保留。

---

# 8. SQLite 初始 Schema

至少建立以下表：

```text
app_meta

providers
provider_credentials
runtime_profiles

teammates

memories
memory_fts

skills
teammate_skills

tools
mcp_servers
teammate_tool_grants

parties
party_members

missions
mission_runs
mission_participants
messages
mission_events

approval_requests
permission_rules
collaboration_requests

audit_events
usage_records

experience_events
capability_profiles
```

后期增加：

```text
memory_embeddings
party_memories
relationships
workspaces
```

---

# 9. Secret Storage

Windows：

```text
Electron safeStorage
    ↓
Windows DPAPI
```

流程：

```text
User enters API key
       ↓
Main Process
       ↓
safeStorage.encryptStringAsync
       ↓
ciphertext
       ↓
SQLite
```

读取：

```text
SQLite ciphertext
       ↓
Main Process
       ↓
decrypt
       ↓
Provider adapter
```

Renderer 永远只看到：

```text
credentialId
label
masked status
```

禁止返回：

```text
apiKey
ciphertext
```

日志也必须 redact。

---

# 10. Prompt Composition

禁止把所有内容拼成一个不可测试的大字符串。

建立 `PromptComposer`。

顺序固定：

```text
1. Platform Policy
2. Teammate Identity
3. Teammate Behavior
4. Mission Objective
5. Current Role
6. Relevant Memory
7. Active Skills
8. Available Tools
9. Collaboration Rules
10. Current Mission Context
```

每一层独立函数：

```ts
composePlatformPolicy()
composeIdentity()
composeMission()
composeMemoryContext()
composeSkillContext()
composeToolContext()
composeCollaborationPolicy()
```

必须可单测。

Memory 不得无上限全部加入 prompt。

---

# 11. Mission Runtime

MissionRuntime 是 V1 的核心。

不要直接：

```ts
while(true) generateText()
```

定义明确的执行步骤。

概念接口：

```ts
interface MissionRuntime {
  start(missionId: string): Promise<void>
  resume(missionId: string): Promise<void>
  cancel(missionId: string): Promise<void>
}
```

内部：

```text
Load Mission
↓
Load Coordinator
↓
Resolve Runtime
↓
Retrieve Memory
↓
Resolve Skills
↓
Resolve Tools + Permissions
↓
Compose Prompt
↓
Model Step
↓
Interpret Result
├─ Final Answer -> Complete
├─ Tool Call -> Permission / Tool Runtime
├─ Collaboration Proposal -> Collaboration Engine
├─ Memory Proposal -> Queue
└─ Error -> Failure / Retry policy
```

---

# 12. Mission State Machine

合法转移必须集中定义。

示例：

```text
DRAFT -> READY

READY -> RUNNING

RUNNING -> WAITING_APPROVAL
RUNNING -> WAITING_COLLABORATION
RUNNING -> COMPLETED
RUNNING -> FAILED
RUNNING -> CANCELLED
RUNNING -> INTERRUPTED

WAITING_APPROVAL -> RUNNING
WAITING_APPROVAL -> CANCELLED

WAITING_COLLABORATION -> RUNNING
WAITING_COLLABORATION -> CANCELLED

INTERRUPTED -> READY
INTERRUPTED -> CANCELLED

FAILED -> READY
```

禁止 UI 直接 update Mission state。

只能通过 Application Command。

---

# 13. Crash / Restart 语义

V1 不实现后台持久 Agent daemon。

应用退出时：

### 如果 Mission 是：

```text
WAITING_APPROVAL
WAITING_COLLABORATION
PAUSED
```

重启后保持原状态。

### 如果 Mission 是：

```text
RUNNING
```

重启后转换：

```text
INTERRUPTED
```

用户可以：

```text
Retry
Cancel
```

不要试图从模型生成的中间 token 自动恢复。

---

# 14. Collaboration Engine

## 14.1 Consultation

```text
User
 ↓
Coordinator
 ├─ Teammate B
 ├─ Teammate C
 └─ Teammate D
 ↓
collect opinions
 ↓
Coordinator synthesis
```

成员调用可以并行。

最后合并由 Coordinator 完成。

---

## 14.2 Review

```text
Coordinator / Author
 ↓
Draft
 ↓
Reviewer
 ↓
Review Result
 ↓
Coordinator Revision / Final
```

V1 保留：

- Draft
- Review Result
- Final

三个 artifact/message。

---

## 14.3 Delegation

```text
Coordinator
 ↓
Delegation Proposal
 ↓
Permission
 ↓
Target Teammate
 ↓
Result
 ↓
Coordinator
```

被委托 Teammate：

- 可以使用其自己的 Memory。
- 可以使用其自己的 Skill。
- 使用其自己的 RuntimeProfile。
- 只能使用当前 Mission 授权范围内的 Tool。
- 不得继续自动委托。

这条规则必须测试。

---

# 15. Agent Initiative

V1 主动性只允许产生 Proposal，不允许静默执行。

Proposal 类型：

```text
COLLABORATION_REQUEST
MEMORY_PROPOSAL
TOOL_REQUEST
RISK_ALERT
```

V1 暂时不做：

```text
BACKGROUND_TASK_PROPOSAL
SCHEDULE_PROPOSAL
```

主动 Collaboration 采用 Structured Output：

```ts
{
  targetTeammateId,
  reason,
  task,
  expectedBenefit
}
```

必须经过 schema validation。

---

# 16. Permission Engine

流程统一：

```text
Action proposed
↓
Permission Engine
↓
Check explicit DENY
↓
Check mission grant
↓
Check teammate/global grant
↓
If ASK -> ApprovalRequest
↓
User decision
↓
persist decision
↓
execute / reject
```

### 默认策略

```text
MEMORY_READ own teammate       -> ALLOW
MEMORY_READ other teammate     -> DENY

MEMORY_WRITE long-term         -> ASK

FILE_READ workspace            -> ASK first time / mission grant possible
FILE_WRITE                     -> ASK

MCP read-only tool             -> ASK
MCP side-effect tool           -> ASK

INVITE_TEAMMATE                -> ASK
```

未来可以提供：

```text
Always Ask
Allow This Mission
Always Allow
Deny
```

但数据库底层必须从 V1 开始支持 scope。

---

# 17. Tool Runtime

统一：

```text
Model Tool Call
↓
ToolRegistry lookup
↓
Validate Input
↓
Permission Engine
↓
Execute
↓
Normalize Output
↓
Audit
↓
Return to model
```

## File Tool 安全

用户必须选择 Workspace Root。

所有路径：

1. normalize
2. resolve
3. canonicalize
4. 检查是否位于 Workspace Root

禁止：

```text
..\ traversal
symlink escape（需要验证 real path）
任意系统目录写入
```

写入操作设置文件大小限制。

---

# 18. MCP Runtime

数据模型：

```ts
McpServerConfig {
  id
  name
  command
  args
  envWhitelist
  cwd?
  enabled
}
```

启动由 Main Process 完成。

MCP tool 转换：

```text
MCP Tool
  ↓
normalize
  ↓
ToolDescriptor
  ↓
Permission Engine
```

MCP 不允许绕过 Permission Engine。

这是硬约束。

---

# 19. Memory Engine

## 19.1 Write Pipeline

```text
Mission / Conversation
↓
Candidate Extraction
↓
Zod validation
↓
Deduplication
↓
Memory Proposal
↓
User Accept/Edit/Reject
↓
Persist
↓
Index
```

---

## 19.2 Retrieval Pipeline

V1-A：

```text
query
↓
owner/scope filter
↓
FTS5
↓
recency
↓
importance
↓
top K
```

V1-B：

```text
query
├─ FTS
└─ embedding/vector
      ↓
hybrid merge
      ↓
scope + recency + importance
      ↓
top K
```

任何检索前首先做 Owner / Scope Filter。

不能：

```text
vector search all memory
↓
再过滤 owner
```

避免跨 Teammate 泄漏。

---

## 19.3 Memory Provenance

Memory UI 必须显示：

```text
来源
创建时间
Owner
类型
关联 Mission
是否经过用户确认
```

---

# 20. Skill Engine

V1 不做自动 Skill 学习。

支持：

```text
Create Skill
Edit Skill
Version Skill
Assign to Teammate
Enable / Disable
```

PromptComposer 只注入当前 Teammate 已启用 Skill。

Skill Version 变更不能修改过去 Mission 的审计记录。

MissionRun 应记录当时使用的 Skill IDs + version。

---

# 21. Provider Layer

定义统一接口：

```ts
interface ModelGateway {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
  generate(request: ModelRequest): Promise<ModelResult>
  testConnection(runtimeProfileId: string): Promise<ConnectionTestResult>
}
```

内部 Provider Adapter：

```text
OpenAIAdapter
AnthropicAdapter
GoogleAdapter
DeepSeekAdapter
OpenAICompatibleAdapter
```

尽量基于 AI SDK provider registry 实现。

不要自己重复实现 HTTP protocol，除非某个 Provider 需要特殊能力。

---

# 22. Model Capability

每个 Model / RuntimeProfile 记录能力：

```text
text
vision
tools
structuredOutput
embedding
reasoning
```

Provider 层不能假设所有 OpenAI-Compatible model 都支持 tools。

如果功能依赖能力：

```text
Mission requires Tool Calling
+
model.tools = false
```

应在执行前报明确错误，而不是让 Prompt 猜测。

---

# 23. IPC Contract

Preload 暴露：

```ts
window.cultivation.providers.*
window.cultivation.teammates.*
window.cultivation.missions.*
window.cultivation.memories.*
window.cultivation.parties.*
window.cultivation.skills.*
window.cultivation.tools.*
window.cultivation.approvals.*
window.cultivation.usage.*
```

禁止：

```ts
window.electron.send(...)
window.fs
window.db
window.shell
```

示例：

```ts
teammates.list()
teammates.create(input)
teammates.update(id, input)
teammates.switchRuntime(id, runtimeProfileId)

missions.create(input)
missions.start(id)
missions.cancel(id)

approvals.resolve(id, decision)

missionEvents.subscribe(missionId, callback)
```

subscribe 必须返回 unsubscribe。

---

# 24. Streaming

不要让 Renderer 直接请求 Provider。

流程：

```text
Provider
 ↓
Main Runtime
 ↓
MissionEvent / Stream Delta
 ↓
IPC
 ↓
Renderer
```

Stream event 包含：

```text
missionId
runId
teammateId
sequence
eventType
payload
```

避免不同 Teammate 的 stream 混淆。

---

# 25. Audit

Audit Timeline 至少显示：

```text
15:02 Mission started
15:02 青玄使用 Claude ...
15:02 Retrieved 4 memories
15:03 Model requested file.readText
15:03 User approved FILE_READ for this mission
15:03 Tool completed
15:04 青玄 requested 墨衡 collaboration
15:04 User approved
15:05 墨衡 started
15:06 墨衡 returned result
15:07 Mission completed
```

不要展示或要求模型输出隐藏 Chain-of-Thought。

Audit 展示：

- Action
- Actor
- Result
- Inputs summary
- Usage
- Permission
- Error

---

# 26. Usage / Cost

Usage 是 P0。

真实保存 Provider 返回的 Usage。

UI 显示：

```text
Input tokens
Output tokens
Total
By teammate
By mission
By model
```

Cost：

- 若用户配置价格，则估算。
- 若没有可靠价格，不显示虚假成本。
- Cost 记录保存价格快照，避免未来价格变化重算历史。

---

# 27. Cultivation Layer

V1 UI 映射：

```text
Teammate      -> 道友
Mission       -> 历练
Skill         -> 功法
Tool          -> 法宝 / 法术
Memory        -> 记忆
Usage Budget  -> 灵石
Workspace     -> 洞府（P1）
```

基础经历页：

```text
完成 Mission
失败 Mission
使用 Skill
合作次数
用户反馈
代表性经历
```

### Realm

Schema 保留：

```text
QI_REFINING
FOUNDATION
CORE
NASCENT_SOUL
...
```

但 V1：

```text
default = QI_REFINING
```

不实现自动晋级。

UI 可以显示：

```text
炼气 · 能力评估体系尚未开启
```

避免使用虚假 XP。

---

# 28. Windows 数据目录

禁止把运行数据写到安装目录或 Git repo。

使用：

```ts
app.getPath("userData")
```

推荐：

```text
<userData>/
├─ data/
│  └─ cultivation.sqlite
├─ logs/
├─ cache/
└─ mcp/
```

用户 Workspace 文件保存在用户选择的实际目录中，不复制进 DB。

---

# 29. Error Model

统一错误：

```ts
AppError {
  code
  message
  retryable
  details?
  cause?
}
```

必须定义稳定 code，例如：

```text
PROVIDER_AUTH_FAILED
PROVIDER_RATE_LIMITED
MODEL_CAPABILITY_MISSING
MISSION_INVALID_STATE
MISSION_INTERRUPTED
PERMISSION_DENIED
TOOL_VALIDATION_FAILED
TOOL_EXECUTION_FAILED
MCP_SERVER_START_FAILED
MCP_TOOL_FAILED
MEMORY_SCOPE_VIOLATION
DATABASE_ERROR
```

UI 根据 code 呈现，不解析英文 message。

---

# 30. Logging

Main Process 使用结构化日志。

必须 redact：

```text
Authorization
API key
Credential
MCP secret env
full sensitive tool output
```

日志默认不记录完整 Prompt。

开发模式可通过明确开关开启调试日志。

---

# 31. 首版 UI 信息架构

左侧：

```text
洞府 Home
道友 Teammates
队伍 Parties
历练 Missions
功法 Skills
法宝 Tools
记忆 Memory
灵石 Usage
设置 Settings
```

## Home

V1 显示：

- 最近 Teammates
- Active Missions
- Pending Approvals
- 最近经历

## Teammate Detail

Tabs：

```text
对话
档案
记忆
功法
权限
经历
运行模型
```

## Mission Detail

核心是 Timeline，不只是 Chat。

显示：

```text
Objective
Participants
State
Timeline
Artifacts
Usage
Pending Approval
```

## Party Detail

显示：

```text
Coordinator
Members
Collaboration Mode
Start Mission
```

---

# 32. 必须通过的 V1 场景测试

## Scenario 1：身份与模型解耦

1. 创建 `青玄`。
2. Runtime = Provider A / Model A。
3. 产生 Memory。
4. 完成 Mission。
5. 切换到 Provider B / Model B。

验证：

- teammate.id 相同。
- Memory 相同。
- Mission history 相同。
- Skill 相同。
- 新 Runtime 正常使用。

---

## Scenario 2：Memory 隔离

1. A 记录私有 Memory `secret-A`。
2. B 执行普通 Mission。

验证：

- B retrieval 中绝不能出现 `secret-A`。
- DB 层有 owner filter 测试。
- Runtime 层有 integration test。

---

## Scenario 3：单人 Mission

验证完整链：

```text
Create
Start
Model Call
Stream
Usage
Complete
Audit
```

---

## Scenario 4：Memory Proposal

1. Agent 认为一个信息值得长期保存。
2. 生成 Proposal。
3. User Reject。

验证：

- Memory 不进入 ACTIVE。
- Audit 中记录拒绝。

再次 Accept：

- ACTIVE。
- 后续同一 Teammate 可检索。

---

## Scenario 5：Runtime Migration

更换 Runtime 后重新执行包含已保存 Memory 的任务。

验证 Memory 可正确使用。

---

## Scenario 6：Permission Deny

Agent 请求 `file.writeText`。

User Deny。

验证：

- 文件未变化。
- Mission 收到 denial result。
- Audit 有记录。
- Agent 不得无限重复相同请求。

---

## Scenario 7：Mission Grant

User 选择：

```text
Allow FILE_READ for this mission
```

后续同 Mission 的相同 scope read 不再重复询问。

新 Mission 必须重新询问。

---

## Scenario 8：主动协作

A 发现需要 B。

A 生成 CollaborationRequest。

User Deny：

- B 不产生任何 Model Call。

User Approve：

- B 运行。
- B 使用自己的 Runtime。
- B 的结果回到 A。
- Audit 可追踪。

---

## Scenario 9：Delegation Depth

A -> B。

B 尝试 delegate C。

V1 Runtime 必须拒绝并告诉 B：

```text
delegation depth exceeded
```

---

## Scenario 10：Party Consultation

A/B/C 组成 Party。

执行 Consultation。

验证：

- 三人的调用独立。
- RuntimeProfile 可以不同 Provider。
- 每个 Usage 归属各自 Teammate。
- Coordinator 最终 synthesis。

---

## Scenario 11：Restart Waiting Approval

Mission 在 WAITING_APPROVAL 时关闭 App。

重新打开：

- 仍是 WAITING_APPROVAL。
- 原 ApprovalRequest 存在。
- User 可以继续 Resolve。

---

## Scenario 12：Crash Running

RUNNING 时异常退出。

重新打开：

```text
RUNNING -> INTERRUPTED
```

用户可以 Retry。

---

# 33. 开发阶段门

执行智能体不得一次推进完整 V1。

每个 Gate：

1. 完成本 Gate。
2. 运行全量测试。
3. 更新状态文档。
4. Git commit。
5. Push。
6. **停止。**
7. 等待代码评审后再推进下一 Gate。

---

# Gate 0：Repository Bootstrap + Architecture Contracts

这是下一次立即执行的工作。

## G0-01 初始化

创建 npm workspace。

初始化：

- Electron Forge
- Vite TypeScript
- React
- packages structure
- base tsconfig
- lint
- format
- Vitest

确保：

```bash
npm install
npm run dev
npm run test
npm run typecheck
npm run lint
npm run package
```

可执行。

---

## G0-02 Electron 安全基线

设置：

```text
nodeIntegration false
contextIsolation true
sandbox true
CSP
navigation blocking
window-open blocking
```

Preload 只暴露最小：

```text
app.getVersion()
health.ping()
```

禁止通用 IPC。

---

## G0-03 Domain Contracts

实现纯 TypeScript 类型：

- Teammate
- RuntimeProfile
- Memory
- Skill
- ToolDescriptor
- Party
- Mission
- Permission
- MissionRun
- ApprovalRequest
- CollaborationRequest

状态 enum 必须与本文一致。

---

## G0-04 Mission State Machine

实现：

```ts
canTransition(from, to)
transition(mission, to)
```

加入 unit tests。

---

## G0-05 Persistence Skeleton

引入：

- better-sqlite3
- migration runner
- DB location abstraction

创建 migration `0001_initial.sql`。

此阶段至少创建 P0 表结构。

测试：

- fresh DB migrate
- reopen DB
- migration idempotence
- foreign key on
- WAL configuration

---

## G0-06 Native Packaging Check

必须在 Gate 0 验证：

```text
better-sqlite3
+
Electron
+
Windows packaged app
```

可以正常启动并访问 DB。

这是 Gate 0 硬性验收项。

---

## G0-07 Port Interfaces

定义但不实现真实业务：

```text
SecretStore
ProviderRegistry
ModelGateway
TeammateRepository
MissionRepository
MemoryRepository
SkillRepository
PartyRepository
AuditRepository
UsageRepository
PermissionRepository
ToolRegistry
```

---

## G0-08 Fake Model

建立 deterministic FakeModelGateway。

例如：

```text
input "PING"
-> output "PONG"
```

支持 fake stream。

后续所有 Runtime test 优先用 fake。

---

## G0-09 UI Shell

只建立页面框架：

- Home
- Teammates
- Parties
- Missions
- Skills
- Tools
- Memory
- Usage
- Settings

不要在 Gate 0 做真实 AI Chat。

---

## G0-10 Architecture Docs

创建：

```text
docs/architecture/overview.md
docs/architecture/domain-model.md
docs/architecture/security.md
docs/decisions/0001-electron.md
docs/decisions/0002-teammate-runtime-separation.md
docs/decisions/0003-sqlite.md
docs/status/gate-0.md
```

---

## Gate 0 Done Criteria

全部满足后才算完成：

- Windows Dev App 正常启动。
- Packaged App 正常启动。
- Native SQLite 正常。
- Security config 正确。
- Core domain types 已存在。
- Mission state test 通过。
- DB migration test 通过。
- Fake Model 测试通过。
- UI shell 可导航。
- `npm run test/typecheck/lint/package` 全部成功。
- 无真实 Provider API Key。
- 无业务捷径把 Teammate 绑定到 Model。
- 提交 GitHub。

### Gate 0 完成后必须停止。

---

# Gate 1：Provider + Teammate + Single Chat Vertical Slice

目标：

```text
Provider
→ RuntimeProfile
→ Teammate
→ Conversation
→ Stream
→ Usage
```

## G1-01 SecretStore

实现 Electron safeStorage adapter。

测试：

- encrypt
- decrypt
- renderer cannot retrieve secret

---

## G1-02 Provider Config

实现 UI：

```text
Add Provider
Add Credential
Test Connection
Add RuntimeProfile
```

首批：

- OpenAI
- Anthropic
- Google
- DeepSeek
- OpenAI-Compatible

不需要自动抓取所有模型列表。

允许用户手动输入 model ID。

---

## G1-03 Teammate CRUD

创建道友：

```text
name
avatar
title
description
identityPrompt
behaviorPrompt
runtimeProfile
```

支持：

- create
- edit
- archive
- duplicate
- switch runtime

---

## G1-04 Single Chat

实现最小持续对话。

Chat 仍然不是 Mission，但复用 ModelGateway。

保存 Message。

支持 streaming。

---

## G1-05 Usage

每次 model call 写 UsageRecord。

---

## G1-06 Runtime Migration Test

必须完成 Scenario 1 的基础部分。

---

## Gate 1 Done Criteria

用户可以：

1. 配 Provider。
2. 创建青玄。
3. 与青玄对话。
4. 切换模型。
5. 历史身份仍然存在。
6. 查看 Token Usage。

完成后提交并停止。

---

# Gate 2：Memory + Skill

目标：

```text
Teammate
→ Chat/Mission evidence
→ Memory Proposal
→ User Approval
→ Retrieve
```

## G2-01 Memory CRUD

实现：

- list
- create manual
- edit
- archive
- accept proposal
- reject proposal

---

## G2-02 FTS5

先做 FTS5。

不要直接上 vector。

---

## G2-03 Memory Isolation

实现 Scenario 2。

这是硬性测试。

---

## G2-04 Memory Candidate

通过 structured output 抽取 candidate。

禁止直接自动写 ACTIVE。

---

## G2-05 Skill

实现声明式 Skill。

支持 assign to teammate。

PromptComposer 注入。

---

## G2-06 sqlite-vec Spike

单独技术验证：

- Development
- Packaged Windows

如果稳定：

加入 semantic retrieval。

如果不稳定：

记录 ADR，V1 保持 FTS5，不允许阻塞产品。

---

# Gate 3：Mission Runtime + Permission + Audit

这是从“AI Chat”进入“Agent”的关键 Gate。

## G3-01 Mission CRUD

实现创建和状态 UI。

---

## G3-02 MissionRuntime

基于 FakeModel 完成完整 state flow。

---

## G3-03 Approval Engine

实现：

- ApprovalRequest
- resolve
- mission waiting
- resume

---

## G3-04 Audit

Timeline。

---

## G3-05 Restart Recovery

实现：

- WAITING_APPROVAL persistence
- RUNNING -> INTERRUPTED

---

# Gate 4：Tool + MCP

## G4-01 File Workspace

用户选择 workspace root。

---

## G4-02 Built-in File Tools

实现：

- list
- read
- write
- mkdir

严格 path guard。

---

## G4-03 Tool Permission

所有 side-effect tool 都经过 Permission Engine。

---

## G4-04 MCP Client

接 stdio MCP。

用户手动配置 server。

---

## G4-05 MCP Permission

所有 MCP tool 经统一 ToolRuntime。

禁止绕过。

---

# Gate 5：Party + Multi-Teammate Collaboration

## G5-01 Party CRUD

2～4 Teammate。

Coordinator 必填。

---

## G5-02 Consultation

成员独立回答，Coordinator synthesis。

---

## G5-03 Review

Draft -> Review -> Final。

---

## G5-04 Delegation

Coordinator -> Member。

深度 1。

---

## G5-05 Initiative

模型可以生成 CollaborationRequest。

必须 user approval。

---

## G5-06 Cost / Usage Attribution

每个调用必须归属：

```text
Mission
Run
Teammate
Runtime
```

---

# Gate 6：Cultivation Layer + Alpha Packaging

## G6-01 Experience Ledger

Mission 完成后形成 ExperienceEvent。

---

## G6-02 Capability Profile

基础统计，不做虚假评分。

---

## G6-03 Realm UI

默认炼气。

标明尚未开启正式考核。

---

## G6-04 Visual Polish

加入克制的修仙设计语言。

避免游戏 HUD 化。

产品首先是工作工具。

---

## G6-05 Installer

生成 Windows installer。

---

## G6-06 Alpha Acceptance

完整执行 12 个 Scenario。

输出：

```text
docs/status/windows-v1-alpha.md
```

---

# 34. 首批模板道友

为了验证产品，不应让用户必须从零写 Prompt。

V1 建议内置 4 个 template，但 template 只是初始配置。

## Researcher / 青玄

```text
职责：调研、资料归纳、方案比较
```

## Builder / 墨衡

```text
职责：实现、工程拆解、技术问题处理
```

## Reviewer / 凌霄

```text
职责：批判性审查、风险识别、质量检查
```

## Planner / 云策

```text
职责：需求澄清、计划制定、任务分解
```

用户创建后得到独立 Teammate 实体。

不是共享系统 Agent。

---

# 35. 不允许的实现捷径

执行智能体必须特别避免：

### 错误 1

```ts
Teammate {
  model: "gpt-x"
}
```

没有 Runtime abstraction。

### 错误 2

所有 Agent 共用一个 Memory vector store，检索后再做逻辑过滤。

### 错误 3

UI 直接调用 Provider SDK。

### 错误 4

把 API Key 放 LocalStorage。

### 错误 5

Tool 直接 execute，没有 Permission Engine。

### 错误 6

把 MCP tool 与 internal tool 分成完全不同的授权体系。

### 错误 7

Party 实现成“把所有 Agent Prompt 一起塞进一个上下文”。

### 错误 8

Delegation 无限递归。

### 错误 9

Mission 只是 Conversation 表加一个 title。

### 错误 10

Agent Memory 只存聊天全文。

### 错误 11

ContextBridge 暴露：

```ts
send(channel, payload)
```

### 错误 12

Gate 0 就开始开发 Browser / Shell / Computer Use。

---

# 36. 每 Gate 提交要求

每次阶段提交需要：

```text
1. 本 Gate 完成内容
2. 未完成内容
3. 架构偏差
4. 新增依赖
5. DB migration
6. 测试列表
7. 测试输出
8. 已知问题
9. 下一 Gate 不要提前实现
```

写入：

```text
docs/status/gate-X.md
```

Git commit 建议：

```text
feat(gate-0): bootstrap desktop architecture
feat(gate-1): add provider teammate chat vertical slice
feat(gate-2): add isolated teammate memory and skills
feat(gate-3): add mission runtime permissions and audit
feat(gate-4): add tool and mcp runtime
feat(gate-5): add party collaboration
feat(gate-6): prepare windows alpha
```

---

# 37. Code Review 红线

后续每一轮评审优先检查：

1. Teammate / Runtime 是否仍解耦。
2. Renderer 是否越权。
3. Credential 是否泄漏。
4. Mission State 是否可被任意修改。
5. Memory 是否跨 Owner 泄漏。
6. Tool 是否绕过 Permission。
7. MCP 是否绕过 ToolRuntime。
8. Delegation 是否突破深度。
9. Event / Audit 是否缺失。
10. Usage 是否可归属具体 Teammate。
11. 新依赖是否有必要。
12. 是否提前开发非 V1 功能。

---

# 38. Alpha 成功标准

Windows V1 Alpha 不以“功能很多”为成功。

必须可以完成这一条真实链路：

```text
User
↓
配置两个不同 Provider
↓
创建两个长期 Teammate
↓
分别积累不同 Memory
↓
Teammate A 独立完成 Mission
↓
A 判断需要 B
↓
A 提出 Collaboration Request
↓
User Approve
↓
B 使用自己的模型、Skill、Memory 完成子任务
↓
结果回到 A
↓
A 交付最终结果
↓
系统保存 Mission、Experience、Usage、Audit
↓
User 将 A 换到另一个 Provider
↓
A 保持原身份与 Memory 继续工作
```

如果这条链路可靠成立，V1 的核心产品假设即得到验证。

---

# 39. Gate 0 执行指令

收到本文后，执行智能体应：

1. 阅读完整文档。
2. **只执行 Gate 0。**
3. 不提前实现 Gate 1+。
4. 任何实现细节冲突时，以以下顺序判断：
   1. 产品不变量
   2. 安全边界
   3. 领域模型
   4. Gate 0 Done Criteria
   5. 技术便利性
5. 不得为了“更快”把 Provider / Model 写进 Teammate identity。
6. 完成 Gate 0 后：
   - 运行所有要求的命令；
   - 提交测试证据；
   - 更新 `docs/status/gate-0.md`；
   - Commit；
   - Push 到 GitHub；
   - 停止继续开发。
7. 等待下一轮架构/代码评审。

---

# 40. 技术依据（截至 2026-09-25）

本计划的技术选择参考以下官方资料；实现时应锁定 package version，不使用 floating `latest` 作为发布依赖。

## Electron

- Electron Documentation  
  https://www.electronjs.org/docs/latest
- Electron Security  
  https://www.electronjs.org/docs/latest/tutorial/security
- Context Isolation  
  https://www.electronjs.org/docs/latest/tutorial/context-isolation
- safeStorage  
  https://www.electronjs.org/docs/latest/api/safe-storage
- Native Node Modules  
  https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- Electron Forge  
  https://www.electronforge.io/
- Forge Vite Plugin  
  https://www.electronforge.io/config/plugins/vite
- Auto Unpack Native Modules  
  https://www.electronforge.io/config/plugins/auto-unpack-natives

## AI SDK

- AI SDK  
  https://ai-sdk.dev/
- AI SDK 6 Migration / package line  
  https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0
- Provider Management  
  https://ai-sdk.dev/docs/ai-sdk-core/provider-management
- OpenAI-Compatible Provider  
  https://ai-sdk.dev/providers/openai-compatible-providers
- Tool Calling / Approval  
  https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling

## MCP

- MCP TypeScript SDK v2  
  https://ts.sdk.modelcontextprotocol.io/v2/
- MCP TypeScript SDK repository  
  https://github.com/modelcontextprotocol/typescript-sdk

## SQLite Vector

- sqlite-vec  
  https://github.com/asg017/sqlite-vec

---

# 41. 最终架构结论

Windows V1 的核心不是 UI，也不是 Provider 数量，而是：

```text
Persistent Teammate Identity
+
Replaceable Runtime
+
Isolated Memory
+
Mission Runtime
+
Human-controlled Permission
+
Bounded Collaboration
+
Auditability
```

整个项目在 V1 阶段必须围绕这七件事构建。

第一轮工程工作只执行 **Gate 0**。
