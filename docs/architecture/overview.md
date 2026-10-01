# Windows Alpha / W1 架构总览

## W1 Workflow Foundation

Workflow 只管理冻结 Definition version、顺序 Step、Artifact 交接、声明分支和恢复。TASK/REVIEW 经通用 R4 context 创建原 Mission；Step→Mission 与创建事务原子绑定。DECISION 读取已验证的结构化事实，不调用模型或修改 graph。完成必须验证原 Mission terminal、required output、exit 与 checkpoint；未知执行结果等待用户，不能自动重放。详情见 [W1 状态](../status/w1-workflow-foundation.md)。

```text
React Renderer --方法级 typed IPC--> Preload --> Electron Main
                                               ├── Gate1Service
                                               ├── SecretStore (safeStorage)
                                               ├── ModelGateway (AI SDK 6 / Fake)
                                               ├── MemoryService + PromptComposer
                                               ├── SkillService + HybridMemoryService
                                               ├── MissionRuntime + PermissionEngine
                                               ├── Availability + RoutingEligibility
                                               ├── RoutingPlanner + DecisionGateway
                                               └── SQLite repositories + durable ExternalWork
shared <- domain <- application <- agent-runtime
```

`Teammate` 是持久身份。R3.1 起，普通道友通过 sealed ModelBinding 固定 Provider Kind / Endpoint / Model，并使用私有 Runtime 执行；换模型必须新建道友，Credential 仅走安全轮换。Main 为唯一组合根，Renderer 经 typed Preload IPC 调用，不能访问 Node、SQLite 或 Provider SDK。

Gate 1 用 AI SDK 6 Core 实现五种 Provider adapter，同时保留 `FakeModelGateway` 进行无真实 API 的测试。`Conversation` 归属一个 Teammate，与 Mission 执行分开；流事件带请求、道友与会话 ID，Usage 固定为调用时的 Runtime/Provider/Model 快照。Mission Runtime 与 PermissionEngine 在 Main application 层执行。

存储使用 Electron 用户数据目录。SQL 迁移版本记录在 `schema_migrations`，初始化配置 `foreign_keys=ON` 和 `journal_mode=WAL`。Gate 1 的 `0002_gate1.sql` 增加 Conversation 归属，并允许 Provider 未返回的 token 数为 `NULL`。

Gate 2 将 Memory 视为有 owner 与审核状态的证据记录。聊天证据经 AI SDK 6 structured output + Zod 最多生成三条 `PROPOSED`，只有用户明确接受才转为 `ACTIVE`；手工创建视为用户直接确认。`PromptComposer` 分层放置平台规则、道友身份、相关 Memory、已启用 Skill 与会话上下文，并限制 Memory Top-K 和字符预算。Skill 仅保存声明式文本、版本快照和逐道友启用状态，不执行代码。

Memory 检索首先在 SQL 中按 `owner_type + owner_id + status` 缩小到当前道友的 ACTIVE 集合，再为这个集合建立临时 FTS5 索引。可选的 `sqlite-vec` 扩展通过 Main 装载；向量查询同样先物化当前道友的 ACTIVE scope，再计算距离。embedding Runtime 未配置或向量路径失败时直接使用 FTS5。向量模型调用写入 UsageRecord；历史 Runtime/Usage 引用保持原始事实，Memory/Skill 继续按持久道友归属。

## R4 受控路由

`RoutingTaskContext → RoutingPlanner → TaskExecutionAssignment` 不依赖 Mission；上下文可带 bounded artifact metadata、output contract 和 opaque execution context。单独的 `RoutingMissionService` 将 assignment 适配为原有 SOLO 或 AD_HOC Party Mission，复用既有状态机、Permission/Approval、工具、安全 transcript 与协作深度限制。W1 从外层复用 R4，不在路由层引入 Workflow 执行器。

Jev 任务需求经 schema/confidence 校验；代码使用共享 Eligibility 和有效 Benchmark prior 过滤、排序，再把 Top-4 的 bounded 公共摘要交给 Jev。语义加分最多 8，UNSTABLE 罚分 10，均不修改 Benchmark。按排序顺序仅复探准备使用的模型，绝不并发批量探测全队。显式选择失败返回 USER_ACTION_REQUIRED。无满足硬能力要求的可用模型且本尊启用了全部必要能力时，复用 ExternalWork 交付；SOLO 本尊验收以同 Run 的幂等 continuation 完成，不产生模型调用或伪造模型 Usage。

R4 Cloud 默认关闭，和 R3 SHADOW 独立。`0016_r4_controlled_routing.sql` 保存配置、append-only ACTIVE routing receipt 与不可变 Mission assignment；旧 SHADOW 表和开关不改变。Receipt 记录过滤、Benchmark、语义信号、探测、结果、请求 hash/版本及 Provider 实际返回的计量，不保存 CoT、原始 Memory、文件或 Tool output。Capability 只来自 Benchmark，legacy Evidence/CapabilityState 不参与产品路由。

Gate 3 的 SOLO Mission 是独立于普通 Conversation 的执行单元。每次执行创建新的 MissionRun attempt；Mission 状态只通过 domain state machine 转换，Main 中的 MissionRuntime 复用道友当前 Runtime、PromptComposer、按 owner 检索的 ACTIVE Memory、已启用 Skill 与 ModelGateway。模型 Usage 同时绑定 Mission、Run、Teammate 和 RuntimeProfile。PermissionEngine 精确匹配 GLOBAL、TEAMMATE、MISSION scope，显式 DENY 优先，ASK 创建一次性 ApprovalRequest 并暂停原 Run。MissionEvent 和 AuditEvent 是追加日志，只保留安全元数据；用户可见最终结果保存在 Run。应用启动时只把持久化 RUNNING 转为 INTERRUPTED，保留 WAITING_APPROVAL 与 PAUSED，并以新 attempt 重试中断任务。
