# R1 — Dynamic Capability + Feedback

状态：R1 实现与 Windows packaged smoke 通过，等待 R1 审批。

## 范围

R1 将 Runtime Benchmark 事实与真实 MissionRun 的用户评价组合为可重建的道友能力投影。Benchmark 属于 Runtime/Model；评价属于实际执行的 Teammate、MissionRun 与当时的 Runtime。R1 不改变 Mission/Party 的执行者选择、模型调用、PermissionEngine、Memory/Skill scope、Tool/MCP 安全链或 Experience provenance。

## 领域与持久化

`0011_r1_dynamic_capability.sql` 在不修改 0001–0010 的前提下增加 Benchmark 创建事实时间、能力投影策略版本元数据，以及模型调用和 Usage 归属查询索引。旧 Benchmark 的创建事实时间确定性回填为已有快照日期。Benchmark 与 CapabilityEvidence 保留历史事实；Evidence 继续 append-only。能力投影仅由 Benchmark 和 Evidence 重建，用户不能直接编辑 currentScore。一次评价卡的 1–3 条 Evidence 在 SQLite 事务中原子写入。

14 个维度均区分未配置、明确不支持、支持且 0–100 分。基准录入保留 Runtime/Model、归一化/原始分数、来源、榜单、版本、快照日期、URL 与 provenance。内置目录只给公开参考入口，不打包任何动态榜单分数或联网抓取逻辑。

## 评分策略与评价流程

独立的 `BenchmarkPriorResolver` 在当前 Runtime/Model/维度下按 `USER_OVERRIDE > CATALOG > USER_ESTIMATE` 选基准；同类以快照日期、创建事实时间及 ID 稳定排序。无受支持 prior 时不创建可供未来路由使用的分数。

Mission 评价卡只展示该终结 Run 中有真实模型执行事实的 `MODEL_RUNTIME` 道友及其历史 Runtime。未执行成员、被拒绝的协作目标和 `USER_BRIDGE` 不在 R1 评价目标中。用户明确选择 1–3 个该 Runtime 已配置且支持的维度，可跳过。快速整体 1–5 星映射至所选维度；高级单维评分覆盖相应整体投影。1–5 星固定映射为 0、25、50、75、100；单维 Evidence 权重更高。同一 Teammate/Run/Runtime 防重复提交，不能以当前 Runtime 猜历史执行 Runtime。

策略版本为 `r1-progressive-v1`：prior strength `P=8`，明确选择维度的 demandWeight `1`，高级单维 evidenceWeight `1`，整体投影 evidenceWeight `0.4`，历史 Runtime transferWeight `0.35`。按 `U=Σ(w×r)/Σw`、`α=E/(P+E)`、`score=(1−α)B+αU` 计算，单次极端评分有限影响分数。迁移后 Teammate ID、Memory、Skill、Experience、Evidence 仍留在原主权域，当前 prior 改为新 Runtime，旧 Runtime Evidence 按迁移权重参与。`updatedAt` 取获选 Benchmark/Evidence 的 durable 创建时间，重复 rebuild 与重启结果一致。

## UI 与安全边界

Settings 的 Runtime 能力画像提供手工基准录入和 14 维状态；Teammate Detail 显示 prior、当前分数、评分数、证据权重、Runtime 与来源；Mission 终结 Run 的评价卡可跳过且不阻塞 Mission。Typed IPC 在 Main 校验输入；Renderer 不直接写 SQLite 或修改能力投影分数。用户评价仍受 0010 的 Mission/Run/实际 Runtime provenance trigger 保护。

## 验证证据

| 命令                    | 结果                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm run test`          | 28 个文件、193 项通过；包含 Gate 0–6/R0 全量回归与 R1 确定性测试。                                            |
| `npm run typecheck`     | 通过。                                                                                                        |
| `npm run lint`          | 通过。                                                                                                        |
| `npm run format:check`  | 通过。                                                                                                        |
| `npm run package`       | Windows x64 Electron 打包通过，`out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`。                |
| `npm run smoke:package` | 真实 Windows 包的 Gate 1–6/R0 smoke 与 R1 Benchmark、实际执行者评价、错归属拒绝、Runtime 迁移、重启重建通过。 |

确定性测试覆盖 prior 优先级及同类排序、unsupported/0 区分、极端与连续评价、单维权重、跳过与重复提交、未执行成员、错误历史 Runtime、Evidence 批量事务回滚、幂等重建、删投影重建、Runtime 迁移、0011 迁移升级，以及 Gate 0–6/R0 全量回归。Packaged smoke 从全新数据库经 typed IPC 创建两个 Runtime，评价真实 SOLO 执行者并拒绝未执行道友，验证 SQLite Evidence 历史 Runtime 归属、旧 Evidence 保留、新 prior 生效、删除投影后重启重建；同时检查 Settings、Teammate 和 Mission 评价卡实际显示。

## 已知限制与明确未实现

R1 由用户手工选择本次涉及的维度；系统尚无 Jev TaskCapabilityDemand，不能推断任务能力需求。Benchmark 参考目录只提供已验证的官方入口，不自动抓榜单；归一化分数由用户手工输入，评分参数是版本化的首版策略，尚未经过 Shadow 数据校准。Human Bridge 动态评分留待真实 ExternalWork 流程建立后再启用。已提交的评价为 append-only 事实，R1 不提供修改或删除入口。

本轮不实现 Human Bridge 自动创建/通知/artifact 工作流、TypeSafe/Jev 网络调用、自动道友路由、Skill/Memory/Tool shortlist、Runtime 路由或自动境界晋级。
