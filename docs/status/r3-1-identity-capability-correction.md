# R3.1 — Identity & Capability Correction

## 范围

本轮按 AP-005 的 R3.1 修正道友与模型身份、能力分来源、Human Bridge 系统身份，以及 R2 ExternalWork 验收后的崩溃续跑。Mission 仍由用户明确选择执行者；Jev 仍是 SHADOW。Availability probe、自动路由、整体 UI Reset 和 R4 均未实现。

## 持久化与身份

`0014_r3_1_identity_capability.sql` 在既有 0001–0013 之后新增 sealed `teammate_model_bindings` 与 durable `r2_external_work_continuations`。普通 `MODEL_RUNTIME` 道友创建时先在 Main 完成连接测试，再原子地复制 Runtime、保存道友并封存 Provider kind、Endpoint、Model ID、Runtime/Credential ID 与验证时间。已绑定的模型身份不能通过 Teammate、Runtime 或 Provider 更新路径更改；Credential 可以经 Main `safeStorage` 路径轮换。Renderer 只接收凭据摘要，不接收明文或密文。

迁移为每个旧普通道友复制独立 Runtime 与当前模型 Benchmark 快照，保留旧 Runtime 与全部 Mission、Usage、Event、Audit、CapabilityEvidence 的原始关联。旧数据没有可证明的历史连接测试结果；迁移以明确的 legacy structural provenance 标记封存来源，不伪造网络验证。旧共享 Runtime 在迁移后不能继续共同改变已绑定道友。用户若要更换 Provider、Endpoint 或 Model，需新建道友。

Human Bridge 继续不绑定 Runtime 或 ModelBinding，始终为 `ACTIVE + USER_BRIDGE + FALLBACK_ONLY + HUMAN_BRIDGE`；应用服务和 SQLite 共同阻止归档、删除及系统身份修改，仅开放安全展示字段。

## 退出正式行为的接口与数据

- `teammates:switchRuntime` 不再注册，Preload/Renderer 不再提供入口；Service 拒绝直接调用。
- Mission 与 ExternalWork 评分卡、`capability:ratingTargets`、`capability:submitRating`、`r2:submitRating` IPC 不再提供。应用层评分方法也拒绝写入新 CapabilityEvidence。
- R3 TEAMMATE_FIT 与道友能力画像只读当前固定 Runtime 的有效 Benchmark。`unsupported` 与有效的 0 分保持不同语义。Experience 和 Skill 仍作有界语义上下文，不修改能力分。
- 旧 CapabilityEvidence、TeammateCapabilityState 及 `priorStrength/transferWeight/ratingCount/evidenceWeight` 字段暂留作为 legacy 历史，不参与产品能力分、R3 输入或路由判断。Human Bridge 已启用维度固定为 1。

## R2 continuation 与隐私

ExternalWork ACCEPT 与 pending continuation 在同一 SQLite 事务落盘。应用重启时先检查这些 Run 绑定的 pending/consuming continuation，再处理一般 RUNNING 中断；原 MissionRun 继续，不新建 attempt。协调者 Final artifact 与 Run 终态用于避免已落盘结果再次 synthesis。CANCELLED/REJECTED 不产生成功 continuation。Cloud Shadow 页面明确展示主动启用后发送的有界任务摘要、候选身份/角色、Benchmark band、Skill 元数据和 Experience 摘要，以及不会发送的凭据、原始 Memory、完整文件/聊天和 Tool secret/output。

## 验证

2026-09-29 在 Windows x64 本机完成：

| 命令                    | 结果                        | 证据重点                                                                                                                |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run test`          | 通过，37 个文件、258 个测试 | 旧库升级、封存后模型身份不可变、凭据轮换、Benchmark-only、legacy Evidence 无效化、Human Bridge 身份与 continuation 幂等 |
| `npm run typecheck`     | 通过                        | Main、Application、Repository 与 typed IPC 一致                                                                         |
| `npm run lint`          | 通过                        | 全仓 ESLint                                                                                                             |
| `npm run format:check`  | 通过                        | 全仓 Prettier                                                                                                           |
| `npm run package`       | 通过                        | Electron 44.4.3 Windows x64、`better-sqlite3` native module；使用仓库内已有 Electron ZIP                                |
| `npm run smoke:package` | 通过                        | 真实 package 启动、九页导航、IPC/SQLite、Gate 0–6 与 R0–R3 链路、R3.1 固定绑定与 Benchmark-only                         |

专门的 `R3_1_CRASH_PACKAGED_SMOKE_OK` 场景先提交真实外部 artifact，再在 `ACCEPTED + RUNNING + PENDING` 状态强制终止进程。重启后仍为原 MissionRun、只产生一次 coordinator synthesis 和一个 FINAL artifact，continuation 最终成为 `CONSUMED`。Application/SQLite 测试还覆盖 ACCEPT 前后、continuation 消费前后以及重复恢复的幂等性。Packaged 回归同时验证 Credential 轮换后密文改变但 ModelBinding 不变、旧共享 Runtime 已隔离、Mission 完成无新 CapabilityEvidence、Human Bridge 不可归档、R3 默认不将 Human Bridge 纳入普通候选。

## 已知限制

没有 Availability 状态与探测、自动执行者或 Human Bridge fallback；Jev 建议不改变 Mission、Permission 或协作。Legacy CapabilityEvidence 保留为历史事实，不再作为能力分输入。
