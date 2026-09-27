# R0 — Routing Foundation

状态：R0 实现及验收通过；0010 CapabilityEvidence provenance 修复及本轮打包验收通过。

## 范围与不变量

基线为 `main@5a946973`。R0 不接入现有 Mission/Party 执行路径，不改变用户选定道友、Runtime、PermissionEngine、Memory scope、Tool/MCP 审批链、协作深度或 Experience provenance。现有普通道友在升级后保持 `MODEL_RUNTIME + NORMAL`；系统 Human Bridge 仅预留显式 bootstrap，应用启动时不自动创建。

## 领域与端口

- 道友新增 `executorKind`、`routingPolicy`、`systemKind`。旧道友迁移默认 `MODEL_RUNTIME + NORMAL`；`USER_BRIDGE` 可以没有 RuntimeProfile。现有 Teammate 创建、复制、Runtime 切换仍按原有模型执行路径处理。
- 新增 14 个 `CapabilityDimension`，并定义 Runtime 归属的 `ModelCapabilityBenchmark`、道友归属的 `TeammateCapabilityState`、带 Mission/Run provenance 的 `CapabilityEvidence`、`TaskCapabilityDemand`、`DecisionReceipt`、`ExternalWorkRequest`、artifact 和外部应用配置类型。
- `DecisionGateway.evaluate(request): Promise<DecisionResult>` 与生成模型的 `ModelGateway` 独立。确定性 `FakeDecisionGateway` 只用于测试；没有真实 Decision Provider 调用。
- 新增 Capability、DecisionReceipt、ExternalWork 和 Human Bridge bootstrap 的 application ports。R0 没有把这些接口接入 Mission/Party 执行。
- Mission state machine 允许 `RUNNING → WAITING_EXTERNAL_WORK → RUNNING/FAILED/CANCELLED`；重启恢复仍只处理中断的 `RUNNING`，保留等待状态。

## 持久化

`0009_routing_foundation.sql` 增加 `model_capability_benchmarks`、`teammate_capability_states`、`capability_evidence`、`decision_receipts`、`external_work_requests`、`external_work_artifacts`、`external_app_profiles` 七张表，及 Teammate 执行类型字段。Benchmark 用 `supported` 与可空的分数区分不支持和低分，绑定 Runtime + model alias、来源/版本/快照；不自动抓取或推算。DecisionReceipt 仅存有长度上限的摘要与结构化答案，不要求原始私有 Memory。请求生命周期、外键、唯一约束和 append-only 事实由 SQLite 约束。

SQLite 无法直接扩大旧 Mission state `CHECK`，迁移在外键完整性验证保护下重建该表，保留旧 Mission/Run/Event/Audit、Permission、Experience 事实。系统 Human Bridge 的 bootstrap 是显式、幂等的 repository 操作；应用启动不调用它。

### 0010：CapabilityEvidence provenance 修复

0009 只验证了 Mission participant/Run 归属，因此未执行成员可被评价，MODEL_RUNTIME 也能以空 Runtime 写入。`0010_r0_capability_evidence_provenance.sql` 只替换 Evidence 的 INSERT 校验 trigger，保留 0009 和原有 UPDATE/DELETE append-only 限制。新评价必须指向已终结的精确 MissionRun。`MODEL_RUNTIME` 道友必须是 Mission coordinator/participant，并提供非空历史 Runtime ID；同一 Run 中该道友的 `model.call_started` 事件（payload 中匹配 Runtime ID）或 Usage 记录必须证明执行。当前 Runtime 不参与历史 ID 推断。`USER_BRIDGE` 必须使用空 Runtime ID，且同一 MissionRun 中存在以其为 assignee 的 `ACCEPTED` ExternalWorkRequest。Party membership、DENIED collaboration proposal、未完成外部工作都不足以产生 Evidence。旧 Evidence 行不被重写；R0 尚无用户评分 UI。

## 验证证据

本轮在 Windows x64 主工作区完成：

| 命令                    | 结果                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run test`          | 27 个测试文件、175 项测试通过；包含 Gate 0–6 全量回归。                                                   |
| `npm run typecheck`     | 通过。                                                                                                    |
| `npm run lint`          | 通过。                                                                                                    |
| `npm run format:check`  | 通过。                                                                                                    |
| `npm run package`       | 通过，产物为 `out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`。                              |
| `npm run smoke:package` | 真实 Windows 包启动并通过 Gate 1–6 smoke，以及 R0 migration 10、旧创建路径道友默认字段、SQLite 外键检查。 |

确定性测试验证 1→9、带 Mission/Run/Event/Permission/Audit/Experience 事实的 8→9 迁移，旧道友默认值，无 Runtime 的 USER_BRIDGE，Benchmark Runtime 归属与 unsupported/低分区分，receipt 摘要长度边界，ExternalWorkRequest lifecycle、artifact 和 app profile 约束，以及 `WAITING_EXTERNAL_WORK` 重启保留。Migration 8→9 的表重建前后均执行 SQLite 外键完整性检查，旧事实保持原样。

0010 的 12 项聚焦测试还验证 MODEL_RUNTIME 空/错误 Runtime 拒绝、participant 与 DENIED target 未执行拒绝、历史 Runtime 与 Usage provenance 接受、USER_BRIDGE 未完成/已接受外部工作、RUNNING Run 拒绝、Retry 不跨 Run 借用事实、9→10 迁移保留旧事实及 Evidence append-only。

## 已知问题与后续边界

R0 的新表和端口不暴露用户操作流程，因此不能在界面录入 Benchmark、能力评价或外部工作。R0 不包含动态能力计算、Benchmark 联网抓取、真实 TypeSafe/Jev 调用、自动路由、Human Bridge 执行/Windows 通知/artifact 提交 UI、Skill/Memory/Tool/Runtime 路由。上述工作须在 R1+ 单独评审。

本机 Electron Packager 的临时封装目录不能位于源码树的常规路径。验收时临时将项目 `.tmp` 映射为 `R:`，使封装文件物理上仍只写入项目目录；打包及 smoke 结束后已解除映射。首次尝试未正确传入本地 Electron ZIP 路径而停滞，纠正环境变量后重跑通过；未添加依赖或改动打包配置。
