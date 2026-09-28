# R2 — Human Bridge

状态：实现与 Windows packaged smoke 通过，等待 R2 审批。

## 范围与领域边界

R2 将“本尊”作为唯一、持久的系统 Teammate 接入 Party Mission。应用启动时幂等 bootstrap `systemKind=HUMAN_BRIDGE`、`executorKind=USER_BRIDGE`、`routingPolicy=FALLBACK_ONLY`，不绑定 RuntimeProfile；数据库保护系统身份，显示名称可修改。本尊只能作为 Party 成员，不能作为 Coordinator。普通 `MODEL_RUNTIME` 道友的执行与能力画像保持原有语义。

`human_bridge_capabilities` 保存 14 维启用状态，是配置事实；`teammate_capability_states` 仍是可重建投影。启用维度的独立冷启动 prior 为 1，不创建虚假的 ModelBenchmark。接受真实 ExternalWork 后，用户可对该请求的明确能力维度给 1–5 星；Evidence 绑定 Mission/Run/本尊且 Runtime 为 null。禁用维度没有能力投影。评分改变不会解除 `FALLBACK_ONLY`。

## 持久化与执行

新增 `0012_r2_human_bridge.sql`，未改动 0001–0011。Migration 增加 Human Bridge 能力配置、ExternalWork 的 Workspace 目标路径、应用建议及公开结果，强化请求结构/长度、当前 Run、能力启用、应用建议归属、Artifact 当前 submission 与状态流转约束；Party 可容纳没有 Runtime 的系统本尊，同时普通成员仍需可用 Runtime/Provider。CapabilityEvidence trigger 只接受同 Run 中已接受且有实际 Artifact 的本尊工作。Experience 表增加 `EXTERNAL_WORK` 类型及来源校验，保留旧账本行、唯一约束和 append-only 保护。`REJECTED`/`CANCELLED` 不产生成功 Experience。

用户明确选择 capability 并填写结构化任务、完整可复制 Prompt、要求、Artifact 目标、Workspace 路径、验收标准和可选 ExternalAppProfile；不从自然语言自动猜能力。协作批准后创建 ExternalWorkRequest，使 Mission 从 `RUNNING` 进入 `WAITING_EXTERNAL_WORK`，原 Run 保持。`PENDING → IN_PROGRESS → SUBMITTED → ACCEPTED/REJECTED` 及取消均由 Application Service 控制。接受或取消后恢复原 Run，Coordinator 获得有界的 `UNTRUSTED_EXTERNAL_DATA` continuation；文件内容不进入模型，读取仍须经过原 ToolRuntime/PermissionEngine。Human Bridge 不发生 ModelGateway 调用、Usage，也没有伪造的 `MEMBER_RESULT`。

Artifact 提交在 Main 通过 Gate 4 Workspace Root 的 canonical/realpath 边界复核存在性、普通文件、路径、扩展名与大小；Renderer 提供的路径和元数据不作为事实。通知只含通用安全标题与通用提示，点击可打开应用内本尊待办；通知失败不影响持久待办。UI 支持开始、复制 Prompt、打开 Workspace 目标目录、提交、验证错误、驳回后重新提交、接受或取消，Mission Timeline 展示对应事件。

## 验证证据

| 命令                    | 结果                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `npm run test`          | 29 个文件、210 项通过；Gate 0–6/R0/R1 回归及 R2 应用/持久化测试。 |
| `npm run typecheck`     | 通过。                                                            |
| `npm run lint`          | 通过。                                                            |
| `npm run format:check`  | 通过。                                                            |
| `npm run package`       | Windows x64 包生成于 `out/AI Agent Cultivation-win32-x64/`。      |
| `npm run smoke:package` | Gate 1–6/R0/R1/R2 真实 Windows package 全部通过。                 |

R2 packaged smoke 从新数据库 bootstrap 本尊并启用图像能力，以普通道友和本尊组成 Party：批准明确的 ExternalWork、验证等待状态与通知安全内容，关闭重启后确认原 Run 仍等待；从 Workspace 提交 Artifact、接受并恢复同一 Run，Coordinator 完成 synthesis。测试直接查 SQLite：本尊 Usage/model call 与 collaboration artifact 为零，真实 ExternalWork Artifact、Experience、Runtime null 的 CapabilityEvidence 入账；注入样本文本仍作为非 user/tool 的受限外部数据。定向测试覆盖系统身份唯一性、能力启停、prior=1、请求与 lifecycle 约束、错误路径/扩展名/大小、跨 Run provenance、已接受与被拒绝工作的经历差异、旧 migration 升级及 Party REVIEW 兼容性。

## 已知限制与明确未实现

首版只做可靠的文件路径、类型、扩展名与大小验证；不声称校验图像实际像素、音视频时长或外部应用产物真实性。Windows 通知是辅助提醒，应用内持久待办是真相源。Human Bridge prior=1 和评分权重是首版显式策略，未经过真实使用校准。ExternalAppProfile 只记录建议，不存 API Key，不作为 Provider；本轮不自动调用外部应用。

R2 不实现 TypeSafe/Jev、自动 TaskCapabilityDemand 或道友路由、Benchmark 自动抓取、Skill/Memory/Tool shortlist、Runtime 路由、Browser/Computer Use、Shell 或自动境界晋级。
