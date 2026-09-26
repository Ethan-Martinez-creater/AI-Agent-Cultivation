# Gate 3 状态

状态：实现及全套验证完成，待审批。

## 本 Gate 完成内容

- SOLO Mission CRUD、独立 MissionRun attempt 与 Timeline UI。Mission 与普通 Conversation 分开，Run 结果归属 Mission，不写入 Chat 会话。
- MissionRuntime 只经 domain state machine 改变 Mission 状态；复用道友当前 Runtime、PromptComposer、ACTIVE scoped Memory、已启用 Skill、ModelGateway 与 UsageRecord。
- PermissionEngine 精确处理 GLOBAL、TEAMMATE、MISSION scope，显式 DENY 优先；Gate 3 使用确定性 `SPEND_BUDGET` fixture 验证 ASK/Approval 链，不接入 File Tool 或 MCP。
- ApprovalRequest 一次性 resolve；WAITING_APPROVAL 暂停原 Run，批准后恢复该 Run，拒绝后向 Runtime 记录明确的 denial result。MissionEvent/AuditEvent 追加记录状态、模型调用、Usage、审批、错误和 Retry，不存隐藏 Chain-of-Thought 或原始密钥。
- 启动时保留 WAITING_APPROVAL/PAUSED；持久化 RUNNING 转 INTERRUPTED，Retry 生成新 attempt 且保留旧 Run 与事件。

## Gate 边界

File Tool、MCP、Party、多 Agent 协作属于后续 Gate，未在本 Gate 实现。

## 架构偏差与约束

现有 Mission state machine 保留为唯一状态转换入口。审批 fixture 是独立 capability check，用户可在启动时选择；它用于验证授权机制，不执行外部工具动作。Mission 可见最终结果属于 Run；Event/Audit 只记录安全元数据。

## 新增依赖

无新增运行时依赖；沿用 Gate 1 的 AI SDK 6、Gate 2 的 SQLite/FTS5/sqlite-vec 及 FakeModelGateway。

## DB migration

`migrations/0004_gate3.sql` 增加 MissionRun 可见结果、审批/事件/用量查询索引、Run 与 Mission 归属约束、Approval 一次性处理及 Audit append-only 约束。`0001_initial.sql` 至 `0003_gate2.sql` 未修改。

## 测试列表与输出

验证命令及结果（Windows x64，Electron 44.4.3）：

- `npm run test`：15 个测试文件、73 个测试通过。确定性测试覆盖 SOLO、非法转换、Usage 四重归属、Permission scope、审批及重复审批、重启恢复与迟到结果、Retry、Memory/Skill 隔离。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run format:check`：通过。
- `npm run package`：通过，Electron Forge 完成 Windows x64 打包及 `better-sqlite3` native dependency 准备。
- `npm run smoke:package`：通过。真实 packaged app 验证九页导航、typed IPC、native SQLite 查询及 Gate 1/2 回归；Gate 3 额外验证 SOLO、Memory/Skill/Permission scope、Mission/Run Usage、Approval 一次性处理、WAITING_APPROVAL/PAUSED/RUNNING 重启行为、Retry 新 attempt、Audit append-only。

## 已知问题

- 真实 Provider 调用需要用户自己的 Credential；核心与 packaged 测试使用 FakeModelGateway，不要求仓库存放 API Key。
- Gate 3 的审批能力使用内置 deterministic fixture。File Tool/MCP 的真实动作和资源授权将在后续 Gate 接入，不在此阶段执行。

## 下一 Gate

Gate 3 推送后停止，等待审批；不提前推进 Gate 4。
