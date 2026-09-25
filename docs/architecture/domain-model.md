# 领域模型约束

`Teammate.id` 是持久身份；`currentRuntimeProfileId` 仅指向当前运行配置。更换 Provider、Credential 或 Model 不应重建 Teammate，也不应修改 Memory owner、Mission 记录、Skill 或经历。

`Mission` 是执行边界，`MissionRun` 是一次尝试。状态只能通过 `packages/domain/src/mission-state.ts` 的 `transition` 转移；应用命令层会在后续 Gate 使用该函数，Renderer 不应直接更新状态。`MissionEvent` 与 `AuditEvent` 分别记录业务执行和安全/系统行为。

计划未指定 `PAUSED` 的进出边。Gate 0 为使暂停状态可用，补充 `RUNNING → PAUSED → RUNNING`、`PAUSED → CANCELLED`；同时允许 `READY → CANCELLED`。`COMPLETED` 与 `CANCELLED` 为终态。后续评审可在运行时接入前调整。

计划未完整列举 `Skill.status`、`Party.status`、`MissionRun.status` 与 `CollaborationRequest.state`，本阶段给出最小枚举并在 SQL 中同步。Realm 只列入计划明确示例的四项，不实现自动升级。

Memory 候选默认 `PROPOSED`。后续检索必须在 SQL 查询中按 `owner_type + owner_id` 过滤，不得仅在结果返回后过滤。`memory_fts` 仅为检索索引，不能代替作用域过滤。

`PermissionRule` 的 `scope` 与 `scopeId` 共同标识规则作用域：`GLOBAL` 的 `scopeId` 必须为 `null`，`TEAMMATE` 和 `MISSION` 必须提供各自实体的 ID。尤其是 `MISSION`，仅有枚举值无法区分不同 Mission 的规则；权限查询端口因此要求显式传入作用域，持久层查询需同时匹配 `scope` 和 `scope_id`。初始 migration 要求目标 Mission 存在，并阻止删除仍被规则引用的 Mission。此约束在 Gate 0 初始 migration 中直接修订，未引入补丁 migration；Permission Engine 留待后续 Gate。
