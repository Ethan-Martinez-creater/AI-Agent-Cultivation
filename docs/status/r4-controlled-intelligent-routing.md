# R4 — Controlled Intelligent Routing

## 基线与范围

基线 `main@a9f6482760d236541e3bb0e1ffde6494e4f1f195`。依据 AP-006、AP-005 与已审批 R0–R3.3。只实现受控任务执行分配及现有自由历练集成；没有 Workflow/W1/R5、自动 Runtime switch、动态评分或新 Agent 能力。

## 架构与持久化

- 通用 `RoutingTaskContext / RoutingPlanner / TaskExecutionAssignment` 不接收 Mission 实体。可带 objective、用户声明 requiredCapabilities、executionConstraint、bounded artifact metadata/output contract 和 opaque execution context；测试中的未来 Step-shaped context 不改变当前选择语义。
- `RoutingMissionService` 适配原有 SOLO、Party、Collaboration 状态机。主动 Party 为两个真实持久道友的 AD_HOC Party；显式已有 Party 保留 2–4 人约束、Coordinator 和选择模式。
- 新增 `0016_r4_controlled_routing.sql`，0001–0015 原文未修改。新增 `routing_policy_config`、append-only `routing_decision_receipts`、不可变 `routing_mission_assignments`，含 FK、receipt/Mission 身份校验及有界 JSON。
- 0016 重新定义 ExternalWork INSERT trigger，完整保留 R2 的内容、capability、actor、当前 Run 与 lifecycle 校验；仅对持久化 HUMAN_BRIDGE assignment 对应的无 Party SOLO，允许本尊同时作为 requester/assignee。无 assignment 的 self-request、未启用能力与 traversal 仍拒绝。
- R4 ACTIVE 记录独立保存，未放宽原 R3 SHADOW-only trigger。主动 Cloud 默认关闭；必须另行启用并有 Main-held Jev key。配置入口复用现有 safeStorage/剪贴板安全路径，不导出 Key/ciphertext。
- Receipt 描述需求、过滤原因、Benchmark、语义信号、availability/probe、最终选择，记录 hash、question/policy version 和实际返回的 latency/input tokens。未返回的计量为 null。`routing.decided` Audit 和 `routing.assigned` Event/Audit 可关联同一 receipt。
- Assignment 与实际执行分开。被选中不会产生 Experience/Usage。已路由任务目标不能再编辑，标题可编辑；Retry 保留原 assignment，创建新 Run。

## 确定性规则

集中策略 `r4-controlled-routing-v1`：Top-K=4，semantic bonus≤8，UNSTABLE penalty=10，choice confidence≥0.7；task relevance≥0.5，低概率硬需求最小权重0.25。版本化 Jev question/policy 独立于排序策略。

1. 用户明确 capabilities 时使用其硬需求；否则 Jev 对 14 维给出有界估计。缺失、错误、超时、低置信度或没有可信硬需求时要求用户确认，绝不补造默认维度/基准分。Cloud 关闭仍可通过用户明确能力需求进行本地确定性选择，显式道友/队伍不依赖 Jev。
2. 共享 Eligibility 检查 ACTIVE、sealed binding、Provider/Endpoint/Credential 结构、required capability、routing policy 和 last-known Availability。本尊先排除；MANUAL_ONLY/FALLBACK_ONLY 模型不进入自动候选。
3. 分数只来自当前固定 Runtime 的有效 Benchmark prior，沿用 USER_OVERRIDE→CATALOG→USER_ESTIMATE 的 resolver。supported 0 分和 unsupported/null 不同；没有有效 prior 不生成默认分。历史 Evidence/currentScore 不参与。
4. 按 task demand 权重求 Benchmark 加权平均，再对确定性 Top-K 请求 Jev semantic fit。只有候选内、高置信度推荐得到最多8分；NONE/低置信度记录 IGNORED。Skill/Experience 只作 bounded 语义摘要，不能改变 Benchmark。
5. 自动候选排序后逐个 `prepare(freshProbe=true)`。包括缓存 AVAILABLE 也只复探当前准备使用者；失败继续下一位，新发现 UNSTABLE 后重新比较排名。无全队 Promise.all probe、后台 ping 或长期 health history。
6. 显式道友或 Party 不可用返回 USER_ACTION_REQUIRED，保留选择、不替换。用户重新检测只检查明确对象；自动失败界面先重检一个最高排名失败候选，再重新规划。
7. 高置信度 COLLABORATION_NEED 与确定性人数/eligibility 决定 SOLO 或两人 AD_HOC Party。首版自动 Party 每位成员均需满足全部硬能力要求，未实现互补能力集合覆盖优化。具体子任务仍由现有 Coordinator 提案，经原 INVITE_TEAMMATE Permission/Approval。
8. 无满足硬能力要求的可用 MODEL_RUNTIME，且本尊全部相关 capability enabled 时，才自动 Human Bridge fallback。没有可信需求/本尊能力未启用则 USER_ACTION_REQUIRED。显式对象失效不会触发 fallback。

首版有界 receipt 最多128道友候选，超过上限返回明确错误。Workspace 未配置时可记录已选中的本尊 assignment，但不创建 Mission，要求用户选 Workspace 后重新规划；选择事实不等于已执行。

## Human Bridge 与恢复

SOLO 本尊使用同一 MissionRun：RUNNING→WAITING_EXTERNAL_WORK，创建原 R2 ExternalWorkRequest；等待状态重启保持。Run 已创建而请求尚未建立的窗口可从 durable assignment 重建同 Run 的请求。ACCEPT 后以原 durable continuation 的 bounded publicResult 完成；claim、Run/Mission terminalization、CONSUMED 在同一 SQLite transaction 内，重复消费无模型或外部副作用。

首版交付默认 `deliverables/result.txt`（可配置文件名/扩展名/大小），要求用户在显式选择的 Workspace 内保存并提交产物。不会隐式 mkdir、写文件或绕过原 Workspace canonical-path 验证。

取消/拒绝不产生成功事实；取消 Mission 同步取消仍待处理的请求。全程不调用 ModelGateway/Tool，不伪造 Usage 或成员 artifact。旧 Party 本尊路径、R3.1 CONSUMING 有实际 synthesis/tool evidence 时不自动重放的防线保持。

## UI 与安全兼容

历练增加真正可工作的自动分配、指定道友、指定队伍及可选硬能力确认、交付约定；详情提供可展开的 receipt 比较。Settings Advanced 增加独立“智能分配”开关与 Cloud 发送范围说明。没有 Workflow 死入口，也没有 UI 全面重构。

fixed model、sealed Settings readonly、Credential rotation、Avatar/Chat、Memory SQL scope、每成员独立 Skill/Runtime、权限优先级/exact grant、untrusted tool transcript、MCP env whitelist、协作 depth/调用上限、Experience provenance、Human Bridge 系统身份和 Benchmark-only 保持。Renderer→typed Preload IPC→Main 边界不变。没有新增依赖。

## 验证证据

验收日期：2026-10-01。六项最终验证均退出 0：

| 命令                    | 结果                                                      |
| ----------------------- | --------------------------------------------------------- |
| `npm run test`          | 50 个文件、375 项全部通过；Gate 0–6、R0–R3.3 回归包含在内 |
| `npm run typecheck`     | 通过                                                      |
| `npm run lint`          | 通过                                                      |
| `npm run format:check`  | 通过                                                      |
| `npm run package`       | Windows x64 / Electron 44.4.3；native dependencies 1/1    |
| `npm run smoke:package` | Gate 0–6、R0–R4 完整真实 package 回归通过                 |

新增 34 项测试包括 Eligibility hard filter、supported 0/unsupported、Benchmark/有界 semantic bonus、UNKNOWN/AVAILABLE/UNSTABLE/UNAVAILABLE、顺序复探、显式对象不替换、SOLO/PARTY、无能力 action、未来 Step-shaped context、私有字段拒绝、独立 consent、schema 升级/append-only、同 Run Human Bridge continuation 与任务目标不可变。UNSTABLE 仍可调用：下一更高排名者失败时保留已检查的可用候选，不误触发 fallback。

真实 `TypeSafeDecisionGateway` 的 Fetch seam 契约测试经生产 R4DecisionService 与 builder，验证 14 维 TASK 和 eligible TEAMMATE_FIT、固定 `jev-1.13.0`、版本/hash、bounded advisory 内容和 token 字段；不调用外网。R4 Noul 请求只发送合法 instructions，不继承旧 builder 的 named probability criterion，修复 Fake 未暴露的生产 adapter 格式冲突。

Windows packaged R4 专项真实验证：

- 90/60 Benchmark 顺序选择 SOLO，执行 Usage 对应真实 sealed Runtime。
- 自动 AD_HOC Party 复用原邀请审批；DENY 的目标零 model call/Usage，APPROVE 后成员使用自己的 Runtime，并分别记录 Usage/Audit。
- 无模型支持 VIDEO_GENERATION 时 fallback 本尊；WAITING_EXTERNAL_WORK 关闭/重启保持原 Run，提交合法 Workspace artifact 后 ACCEPT 完成同 Run、continuation CONSUMED；模型/工具/Usage 为零。
- MUSIC_GENERATION 无可用模型且本尊未启用时不创建 Mission；显式 UNAVAILABLE 对象在另一个模型可用时仍不改派。
- 直接只读查询 native SQLite 验证 ACTIVE receipt、immutable assignment、routing Event/Audit、ExternalWork/Run/continuation 事实，旧 SHADOW 开关仍关闭。
- 真实 UI 点击自动分配、查看候选/receipt、归档对象 deep-link 保留选择、重新检测保护、独立 Cloud consent 与隐私文案。R4 补充 900/1180 viewport；旧 1440/1180/900 实际窗口回归及 35 张截图全部保持。

[提交的证据](../evidence/r4/README.md) 包含 4 张原始截图和完整 manifest。完整本轮历史 UI 原件位于 `.test-data/r3-3-ui-85da8c6e-4f2e-44c2-8d75-a2b02028cd8b`；R4 成功 profile 为 `.test-data/r4-packaged-cab53d7c-fd23-453f-8995-4b53cbaf6ad7`。

初轮 packaged 验证发现并修复：归档选择的 exact label 测试定位错误，以及旧 ExternalWork self-request trigger 与 SOLO fallback 冲突。修复后重新 package 并完整 smoke 通过，没有删减安全断言。所有缓存、worktree、profile 与截图均在仓库 `.tmp/.test-data`；R: 仅是 `.tmp` 短路径映射，没有在 C 盘写入测试目录。没有新增依赖。

## 未实现与限制

- 没有 Workflow domain/table/service/UI、Skill/Memory/Tool routing、Scheduler、Browser/Computer Use、Shell 或新 Agent 能力。
- 没有恢复动态 Capability、任务评价、自动 Realm 晋级或 Runtime switching。
- Jev 仅有界 advisory；错误不会给它执行 authority。Cloud 关闭/不可用且需求不明确时需要用户确认。
- 自动 Party 当前为两个均符合硬能力要求的成员；没有互补能力组合求解、成本优化或自建隐藏 Agent。
- Windows packaged 联调用 FakeModelGateway/Fake Decision fixture 验证真实 IPC/SQLite/状态机；不宣称外网 Jev/Provider 在线结果，不要求仓库包含 API Key。
