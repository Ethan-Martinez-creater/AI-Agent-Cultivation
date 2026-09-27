# Gate 5 状态

状态：Party + Multi-Teammate Collaboration 已实现并完成 Gate 0–5 验证，等待审批。

## 实现范围

- Party 为持久记录，支持 FIXED / AD_HOC 的创建、编辑、归档、列表。每队 2–4 名不同的持久 Teammate，且 Coordinator 必须在成员中。创建 Mission 和启动 Run 时重新检查 Party、Teammate、RuntimeProfile 与 Provider 可用性；Coordinator 不生成隐藏 Agent。
- Party Mission 明确使用 CONSULTATION / REVIEW / DELEGATION，SOLO 继续使用 Gate 3/4 原运行时。Party Mission 记录参与者快照与独立 MissionRun attempt，所有状态变化经既有 domain state machine 和持久层 compare-and-transition。
- CONSULTATION 按成员次序逐一请求用户批准；每名成员用自己的 RuntimeProfile、TEAMMATE ACTIVE Memory、enabled Skills 独立生成有界公开意见，Coordinator 最后综合。REVIEW 持久保存 Coordinator Draft、Reviewer Review、Coordinator Final。DELEGATION 仅允许 Coordinator 申请一层具体子任务；被委托者的文本不会被解释为新的协作授权。
- Coordinator 的协作提议使用 AI SDK 6 structured output + Zod schema，字段为目标 Teammate、原因、任务与预期收益。目标必须属于当前 Party 且未参与本 Run 的该轮协作。`INVITE_TEAMMATE` 经 PermissionEngine；显式 DENY 直接拒绝，默认 ASK 或已有 ALLOW 仍需用户明确处理 CollaborationRequest。拒绝不会调用目标模型；批准继续原 Mission/Run。
- 每次模型调用记录实际执行的 Teammate、RuntimeProfile、Provider、Model 与 Provider 实报 token 数。工具仍通过同一 ToolRegistry / ToolRuntime / PermissionEngine；成员工具审批以成员为 requester，Coordinator 的 Mission grant 不继承。工具结果保持 assistant tool-call → tool result 消息结构，标记为不可信外部数据；不经 user role 传输。
- 每 Run 最多 3 次协作请求、12 次模型调用；每位参与者最多 8 个工具 step / 8 次工具调用。错误和拒绝用结构化公开结果交还 Coordinator。MissionEvent/AuditEvent 记录提议、批准/拒绝、开始、完成/失败、成员模型调用、Usage、Tool/Approval；只保存有界摘要，不写隐藏推理或私有 Memory 原文。
- Parties 页面提供固定队伍和 AD_HOC 配置；Mission 创建支持四种 mode；Timeline 区分成员、协作请求、审批和 Draft/Review/Final artifact。

## 数据与依赖

- 新增 `migrations/0006_gate5.sql`，扩展既有 Party、Mission participant、CollaborationRequest 结构并加入 Run 归属/一次性 resolve 约束、append-only 公开 artifact、成员工具审批的重启续跑快照。该 migration 还替换 Gate 3 的 Usage 触发器：SOLO 仍只接受 Coordinator，Party 则接受当前 Mission 的实际参与者，并拒绝非参与者；旧 migration 0001–0005 未修改。
- 无新增第三方依赖；沿用 Electron 44.4.3、AI SDK 6 Core、SQLite、Zod、既有 Provider adapter 和 FakeModelGateway。

## 验证证据

- `npm run test`：22 个文件、138 个测试通过。覆盖 Party 2–4 人校验、三人 Consultation、独立 Runtime/Memory/Skill、Usage/Audit 归属、Party 成员 Usage SQLite 约束、SOLO 原有约束、Review/Delegation、被委托者无法自动再次邀请、拒绝时目标零模型调用、审批重启后续用原 Run、成员工具 grant 隔离、恶意工具输出保持 tool 角色、step/model-call 上限与 Retry 保留旧 Run。
- `npm run typecheck`、`npm run lint`、`npm run format:check`：通过。
- `npm run package`：Windows x64 Electron 包构建通过，包含可用的 `better-sqlite3` native module。
- `npm run smoke:package`：真实 Windows packaged app 中 Gate 1–5 全部通过。Gate 5 使用两个持久 Teammate、两个不同 Provider/RuntimeProfile；拒绝时目标零模型调用，批准后 B 独立读取自己的 ACTIVE Memory/Skill 并产生结果，A 最后综合，Usage/Audit 各自归属。九页导航、IPC、SQLite 及 Gate 1–4 packaged 回归亦通过。

## 已知问题与架构偏差

- Consultation 逐一审批并顺序执行成员，保持可审计的有界流程；目前未并行调用。Review 和 Delegation 选择一个成员执行；Party 其余成员在这些模式下不自动调用。
- Memory 使用既有 Gate 2 scoped FTS5 检索；查询和记忆文本相关时才注入，并受 Top-K 与长度上限控制。无相关结果时继续执行 Mission。
- 真实 Provider 联调需用户自行配置 Credential；确定性测试和 packaged smoke 使用 FakeModelGateway，无需仓库内 API Key。

## Gate 边界

未实现 Cultivation/Evaluation、Scheduler、Browser/Computer Use 或其他 Gate 6+ 功能。推送 `main` 后停止等待审批。
