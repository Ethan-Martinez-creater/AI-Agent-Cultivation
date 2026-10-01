# 领域模型约束

`Teammate.id` 是持久身份。普通道友的 sealed ModelBinding 永久固定 Provider Kind / Endpoint / Model；`currentRuntimeProfileId` 指向该道友的私有执行配置。产品不再提供 Runtime switch。Credential 可安全轮换，Memory owner、Skill、经历和历史 Mission/Usage 不变。Human Bridge 永久 ACTIVE + USER_BRIDGE + FALLBACK_ONLY + HUMAN_BRIDGE，没有 Runtime/ModelBinding。

Gate 1 的持续聊天通过 `Conversation.id + teammateId` 绑定身份。Chat `Message.missionId` 为 `null`，不能把 Conversation 当作 Mission。Usage 记录真实调用时的 RuntimeProfile、Provider 配置 ID 和 model ID，历史迁移引用不重写。Provider 未返回的 token 字段存为 `null`，不伪造零值。

R4 `TaskExecutionAssignment` 是通用选择结果；Mission adapter 才创建执行单元。路由选择和实际执行分开，选中不等于执行过，不产生 Experience 或 CapabilityEvidence。普通候选必须经过确定性 Eligibility；Jev 只建议、不能更改事实或权限。已持久化 assignment 的任务目标不可修改；改任务需创建新 Mission 重新选择。Retry 的新 Run 复用原 assignment，保持既有 Run 隔离与执行事实归属。

`Mission` 是执行边界，`MissionRun` 是一次尝试。状态只能通过 `packages/domain/src/mission-state.ts` 的 `transition` 转移；应用命令层使用该函数，Renderer 不直接更新状态。`MissionEvent` 与 `AuditEvent` 分别记录业务执行和安全/系统行为。

计划未指定 `PAUSED` 的进出边。Gate 0 为使暂停状态可用，补充 `RUNNING → PAUSED → RUNNING`、`PAUSED → CANCELLED`；同时允许 `READY → CANCELLED`。`COMPLETED` 与 `CANCELLED` 为终态。后续评审可在运行时接入前调整。

计划未完整列举 `Skill.status`、`Party.status`、`MissionRun.status` 与 `CollaborationRequest.state`，本阶段给出最小枚举并在 SQL 中同步。Realm 只列入计划明确示例的四项，不实现自动升级。

Memory 候选默认 `PROPOSED`。检索在 SQL 查询中按 `owner_type + owner_id + status` 先过滤，不得仅在结果返回后过滤。FTS/向量索引不能代替作用域过滤。

`PermissionRule` 的 `scope` 与 `scopeId` 共同标识规则作用域：`GLOBAL` 的 `scopeId` 必须为 `null`，`TEAMMATE` 和 `MISSION` 必须提供各自实体的 ID。尤其是 `MISSION`，仅有枚举值无法区分不同 Mission 的规则；权限查询端口因此要求显式传入作用域，持久层查询需同时匹配 `scope` 和 `scope_id`。初始 migration 要求目标 Mission 存在，并阻止删除仍被规则引用的 Mission。此约束在 Gate 0 初始化阶段修订。现有 PermissionEngine 先检查适用 DENY，再按 MISSION > TEAMMATE > GLOBAL，最高 scope 中 ASK > ALLOW；exact Mission grant 不扩为 wildcard。
