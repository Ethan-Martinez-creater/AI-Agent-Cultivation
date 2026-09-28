# R3 — Jev Shadow Decision Plane

## 范围与行为边界

R3 只观察已有选择。用户创建 Mission 时，Main 异步评估 `TASK_CAPABILITY`、`TEAMMATE_FIT`、`COLLABORATION_NEED`、`REVIEW_NEED`。`TEAMMATE_FIT` 对照用户已经指定的 Coordinator 和当时可用道友；其他三类对照用户已有的 Mission mode。调用结果写入独立的 SHADOW Receipt/attempt，Mission 创建、状态、Run、Party、Collaboration、Human Bridge、Runtime、Permission 均不读取建议作为控制输入。失败时原操作照常完成。

这轮尚未在 Party 协作请求阶段单独触发 Jev；创建 Party Mission 时仍可观察当时的用户选择。R4 的主动路由和推荐执行没有实现。

## Decision API 与模型固定

- 决策 Provider 为独立 TypeSafe 配置，不进入生成式 Provider/RuntimeProfile 表。
- 使用 `@typesafe-ai/sdk` **0.6.0**，生产决策模型固定为 `jev-1.13.0`，并验证官方 [OpenAPI](https://api.typesafe.ai/openapi.json) 的 `POST /v1/systemone` Bearer 请求、`GET /v1/models` 连接探测以及 [SDK 源码](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/client.ts)。不使用可移动模型 alias。
- 本轮只有 `SHADOW` 模式；数据库约束拒绝其他 mode，UI 没有切换到执行模式的入口。
- Gateway 返回标准化结果、有限错误码和耗时；timeout、网络、HTTP、schema 错误不进入 Mission 控制流，也不把响应正文或异常消息写入日志/SQLite。

## 数据与密钥

- `0013_r3_decision_plane.sql` 增加独立决策 Provider 配置、Shadow policy、DecisionReceipt 的查询字段/索引、append-only attempt 记录。0001–0012 保持原样。
- Main 用 Electron `safeStorage` 加密 TypeSafe Key；SQLite 只存密文字节。Renderer 只有 `configured/keySource/enabled` 等状态，经 typed IPC 提交“从系统剪贴板读取并清空”的请求。也支持显式 Main 环境变量 `TYPESAFE_API_KEY`，不写入 SQLite。安装包无需 Key 可正常工作。
- `DecisionStateBuilder` 仅允许有界任务摘要、候选 ID/角色、当前 Capability band、已启用 Skill 的有界元数据、可核实 Experience 摘要。读取候选时不查询 Memory、消息、文件、Tool 输出或完整 Mission Event/Audit；原始私有 Memory 与凭据无字段入口。最多 8 名候选、每人 6 个 Skill 与 6 条 Experience，state 上限 24,000 字节；14 维能力各用概率及 required 的独立问题。
- `stateHash` 对有界、规范排序的 state 连同 policy/question version 作 SHA-256；Receipt 只存有界摘要、标准化答案和置信度，不存隐藏推理。`actualAction` 与 `selectedAction` 分列，避免把建议误认为执行。

## 验证

自动化测试使用 FakeDecisionGateway，不需要互联网或真实 Key。2026-09-28 的验证结果：

| 命令                    | 结果                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `npm run test`          | 34 文件、244 测试通过；与 lint 并行的一次 SQLite 测试达到 5 秒超时，单独完整重跑通过。 |
| `npm run typecheck`     | 通过。                                                                                 |
| `npm run lint`          | 通过。                                                                                 |
| `npm run format:check`  | 通过。                                                                                 |
| `npm run package`       | Windows x64 Electron package 构建成功，含 native SQLite。                              |
| `npm run smoke:package` | Gate 0–6、R1–R3 packaged smoke 全部通过。                                              |

R3 packaged smoke 使用真实 Windows package、FakeDecisionGateway 和独立 userData，验证九页导航等旧 Gate、Main IPC、safeStorage 密文、四类异步 Receipt/attempt、`mode=SHADOW`、用户指定 Coordinator、Mission DRAFT、Run/Collaboration/ExternalWork 零新增。重启同一 package 后注入确定性的 provider failure，再创建 Mission，验证四条安全错误观察、零成功 Receipt、Mission 仍为 DRAFT。Gateway 的网络/timeout/schema 失败也在确定性单元测试中转换为有界错误码与无 Receipt 的 fallback。

R3 Eval 数据集覆盖中、英、中英混合及多能力场景；CLI 输出 capability precision/recall、required accuracy、Teammate Top-1/Top-2、collaboration/review、Human Bridge 检出、低置信度、耗时、输入大小和错误率。`node scripts/r3-eval.mjs` 的确定性运行覆盖 **18 cases / 72 decision calls**，输入最大 11,342 字节，错误率 0；这些指标只检验报告接线，Fake 的预测准确率不代表 Jev 性能。真实运行命令为 `node scripts/r3-eval.mjs --real`，需要用户在运行进程显式提供 `TYPESAFE_API_KEY`。目前没有真实 Key，因此真实 Provider 的中英 Eval **待用户环境执行**，没有伪造线上结果，也没有设定 ACTIVE threshold。

## 已知限制与未实现内容

- Shadow 仅在 Mission 创建处采样，没有独立的 Party 协作请求时点评估；不会覆盖 Gate 5 的原有 proposal。
- 任务摘要是用户填写的 Mission objective 的有界版本，并进行常见密钥形态脱敏。用户应避免把额外私密原文写入 objective；R3 不从私有 Memory、文件或聊天中取料。
- Benchmark 算术仍由确定性代码处理。未实现自动 Teammate/Human Bridge/Skill/Memory/Tool/Runtime 路由、completion verifier、Browser/Computer Use、Shell 或自动境界晋级。
