# Gate 0–3 架构总览

```text
React Renderer --方法级 typed IPC--> Preload --> Electron Main
                                               ├── Gate1Service
                                               ├── SecretStore (safeStorage)
                                               ├── ModelGateway (AI SDK 6 / Fake)
                                               ├── MemoryService + PromptComposer
                                               ├── SkillService + HybridMemoryService
                                               ├── MissionRuntime + PermissionEngine
                                               └── Gate1/Gate2/Gate3 SQLite repositories
shared <- domain <- application <- agent-runtime
```

`Teammate` 是核心身份，`RuntimeProfile` 是可替换运行配置。Main 为唯一组合根。Renderer 不能导入 Node、SQLite 或 Provider SDK。Gate 1 的 Settings、Teammates、单道友 Chat、Usage 页面通过专用 IPC 方法访问应用服务，业务状态以 Main/本地 DB 为准。

Gate 1 用 AI SDK 6 Core 实现五种 Provider adapter，同时保留 `FakeModelGateway` 进行无真实 API 的测试。`Conversation` 归属一个 Teammate，与未来的 Mission 执行分开；流事件带请求、道友与会话 ID，Usage 固定为调用时的 Runtime/Provider/Model 快照。Permission Engine 与 Mission Runtime 留待后续 Gate。

存储使用 Electron 用户数据目录。SQL 迁移版本记录在 `schema_migrations`，初始化配置 `foreign_keys=ON` 和 `journal_mode=WAL`。Gate 1 的 `0002_gate1.sql` 增加 Conversation 归属，并允许 Provider 未返回的 token 数为 `NULL`。

Gate 2 将 Memory 视为有 owner 与审核状态的证据记录。聊天证据经 AI SDK 6 structured output + Zod 最多生成三条 `PROPOSED`，只有用户明确接受才转为 `ACTIVE`；手工创建视为用户直接确认。`PromptComposer` 分层放置平台规则、道友身份、相关 Memory、已启用 Skill 与会话上下文，并限制 Memory Top-K 和字符预算。Skill 仅保存声明式文本、版本快照和逐道友启用状态，不执行代码。

Memory 检索首先在 SQL 中按 `owner_type + owner_id + status` 缩小到当前道友的 ACTIVE 集合，再为这个集合建立临时 FTS5 索引。可选的 `sqlite-vec` 扩展通过 Main 装载；向量查询同样先物化当前道友的 ACTIVE scope，再计算距离。embedding Runtime 未配置或向量路径失败时直接使用 FTS5。向量模型调用写入 UsageRecord；Runtime Migration 只改变道友当前运行配置，不改变 Memory/Skill 的道友归属。

Gate 3 的 SOLO Mission 是独立于普通 Conversation 的执行单元。每次执行创建新的 MissionRun attempt；Mission 状态只通过 domain state machine 转换，Main 中的 MissionRuntime 复用道友当前 Runtime、PromptComposer、按 owner 检索的 ACTIVE Memory、已启用 Skill 与 ModelGateway。模型 Usage 同时绑定 Mission、Run、Teammate 和 RuntimeProfile。PermissionEngine 精确匹配 GLOBAL、TEAMMATE、MISSION scope，显式 DENY 优先，ASK 创建一次性 ApprovalRequest 并暂停原 Run。MissionEvent 和 AuditEvent 是追加日志，只保留安全元数据；用户可见最终结果保存在 Run。应用启动时只把持久化 RUNNING 转为 INTERRUPTED，保留 WAITING_APPROVAL 与 PAUSED，并以新 attempt 重试中断任务。
