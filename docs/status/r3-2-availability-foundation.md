# R3.2 — Availability Foundation

## 范围与基线

基线为 `main@cc2623c`，总体实施依据切换为 AP-006。本轮只实现固定模型身份的 Availability / Eligibility 基础，并在现有页面补充状态与重新检测入口。Jev 继续 SHADOW；用户明确选择执行者，应用不自动改派。

## 持久化

新增 `0015_r3_2_availability.sql`，不修改 0001–0014。`teammate_model_availability` 为每个 sealed MODEL_RUNTIME 道友保存当前投影：四态、最近检测/成功/失败时间、至多 8 条 outcome、policy version。绑定初始化和旧库迁移均为 UNKNOWN，不伪造历史探测。SQLite 校验精确 teammate/runtime binding，拒绝 Human Bridge、错误 Runtime、缺失 outcome 字段、额外 payload 字段及超过 4096 字节的 outcome JSON。

Credential ID 或实际加密 Key 轮换使状态重新 UNKNOWN，旧认证结果不继续阻塞新 Key；异步旧 credential revision 的探测/请求结果不能覆盖新投影。原 sealed Provider/Endpoint/Model 身份保持不变。

## 应用边界与状态规则

独立 `ModelAvailabilityProbe` port、`AvailabilityService`、`RoutingEligibilityService` 和 `AvailabilityAwareModelGateway` 不依赖 Renderer、自由历练对象或 Mission service。调用上下文只需 teammate/runtime 执行身份，未来 Step 可以直接复用。

策略 `r3-2-availability-v1` 集中配置：窗口 8 条；首次正常成功为 AVAILABLE；明确硬失败立即 UNAVAILABLE；短期 transient failure 为 UNSTABLE；连续 3 次 transient failure 为 UNAVAILABLE；异常后连续 2 次成功恢复 AVAILABLE。没有后台轮询、定时 ping、Circuit Breaker 或长期健康日志。

UNKNOWN 在使用前进行 bounded metadata probe。AVAILABLE 正常调用，UNSTABLE 仍可调用并暴露 qualitative stability penalty，UNAVAILABLE 返回 typed `MODEL_UNAVAILABLE` 和 `RECHECK / SELECT_OTHER / CANCEL`，不选择其他道友。手动重新检测可恢复故障身份。

Eligibility 统一检查 ACTIVE、MODEL_RUNTIME、有效 sealed binding、Provider 结构/启用状态、调用方可选 required capabilities、last-known availability 与 routing policy。普通候选为 NORMAL；MANUAL_ONLY 仅在明确指定时可执行，FALLBACK_ONLY 不参与普通候选。Human Bridge 不建立模型 availability。

## Provider 与调用集成

Main 用同一安全 Runtime resolver 解密 Credential；probe 仅 GET 模型元数据：OpenAI / Anthropic / Google 查询模型详情，DeepSeek / Generic OpenAI-compatible 查询模型列表并匹配精确 Model ID。请求禁止 redirect，默认 5 秒 timeout，读取上限 128 KiB。不用生成 Token 作为探测，也不把探测计为任务 Usage。兼容端点未提供模型列表时返回 transient metadata-unavailable；实际请求仍可确定其成功/失败。

Provider SDK / HTTP / transport 错误在 adapter 转换为稳定错误种类和 code，application/domain 不含 SDK 专有类型。Credential、响应错误 body、原始异常不进入 Availability 投影或 Renderer。

统一 Gateway decorator 覆盖 Chat stream、SOLO / Party / Coordinator / Participant / Synthesis 的 generate/tool loop、collaboration proposal、Memory extraction；另一个 Runtime 的 ancillary embedding 不污染固定模型身份。服务在持久化 `model.call_started` / Skill 使用前检查 Availability，最终 Gateway guard 通过后才触发 call-start callback。未执行的不可用成员仅形成公开 unavailable outcome，不拥有执行 artifact/Usage/Experience。在途请求即使道友随后被归档，仍记录真实结果；归档道友不能开始新请求。

R3 Shadow candidate builder 只调用 read-only eligibility，不批量 probe；排除 UNAVAILABLE、无 binding、结构无效或 disabled Provider。Benchmark band 与 Experience/Skill 元数据保持各自语义，Availability 不改变 Benchmark、CapabilityEvidence 或 Realm。新增模型 availability/stability 元数据进入显式隐私 allowlist，DecisionState schema version 为 `r3-decision-state-v2-availability`；历史 receipt 不重写。

## UI

道友固定模型区域、Chat 和已绑定 Runtime 显示小状态点及短文字，提供“重新检测”。Chat typed unavailable 保留明确“选择其他道友 / 取消”入口。页面挂载只读投影。未绑定 Runtime 模板没有道友 Availability。

## 验证

2026-09-30 完成全部要求验证，均 exit 0：

- `npm run test`：41 files / 320 tests 全部通过。
- `npm run typecheck`、`npm run lint`、`npm run format:check`：通过。
- `npm run package`：Windows x64 / Electron 44.4.3 打包通过，native better-sqlite3 重建通过。
- `npm run smoke:package`：Gate 0–6、R0–R3.1 及 R3.2 完整串行 packaged suite 通过，包括真实启动、九页导航、typed IPC、native SQLite、sqlite-vec、Tool/MCP、审批重启与 continuation crash recovery。

新增输出标记：`R3_2_SDK_PACKAGED_SMOKE_OK`、`R3_2_PACKAGED_SMOKE_OK`。前者在实际 Windows package 中通过真实 AI SDK adapter 访问本机 HTTP fixture，验证 metadata / Streaming / SOLO 成功、401 hard failure、零请求改派与恢复；后者验证 Fake 核心路径及 SQLite restart 后的 unavailable guard。

验收 package：`out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`，246,236,672 bytes，最终构建时间 2026-09-30 14:26（本地时间）。这是 R3.2 package 验收产物，本轮未重新生成 installer。构建产物不提交 Git。

| 验收内容                                                                                                        | 证据                                   |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| UNKNOWN、成功、hard/transient failure、混合与连续恢复、bounded window                                           | domain/application deterministic tests |
| Human Bridge 无 availability、精确 sealed Runtime、旧库迁移、Credential reset、非法 payload 拒绝                | persistence migration 1→15 tests       |
| Provider metadata、认证、timeout、transport、大小/redirect 限制、Anthropic alias、分页未命中不误判              | agent-runtime fixture tests            |
| Chat、SOLO tool loop、Consultation/Review/Delegation 的 proposal/member/synthesis 正确归属                      | application + SQLite execution tests   |
| disabled exclude、explicit unavailable 零调用/零 Usage、不改派、最终 guard race 无伪执行事实                    | execution tests                        |
| Benchmark unchanged、无新 CapabilityEvidence、Shadow unavailable exclude 且不批量 probe                         | execution/candidate/shadow tests       |
| Windows 真 package：UNKNOWN→AVAILABLE、SOLO/Party、UI badge、restart 后 hard unavailable/no Usage、恢复         | R3.2 packaged smoke                    |
| Windows 真 package + 真实 AI SDK：本机 HTTP metadata、Chat Streaming、SOLO、401→UNAVAILABLE、blocked send、恢复 | R3.2 SDK packaged smoke                |
| Gate 0–6、R0–R3.1 历史安全与恢复场景                                                                            | 全量 test + 完整 smoke:package         |

未新增依赖或升级现有依赖。构建缓存、临时文件及 smoke userData 均位于仓库 `.tmp` / `.test-data`；无需真实 API Key，不向外部收费模型发送请求。

验收过程中将历史 R1/R2/R3/R3.1 smoke 的最新 migration 断言从 14 对齐到 15。Windows 强制终止 crash fixture 等待子进程 `close`，并对短暂的 `SQLITE_IOERR_TRUNCATE` 做至多 5 秒的 write-readiness 检查；不重试模型/Tool 执行，不改变生产 continuation 恢复语义，持久数据库错误仍使验收失败。

## 已知限制与未实现内容

metadata probe 表示当前访问/模型存在性，不能保证后续生成请求必定成功；故实际请求结果仍会更新状态。第三方 OpenAI-compatible 服务可能不提供 metadata endpoint，此时以 transient 状态继续真实调用。没有使用真实收费 Provider Key 执行联调，核心验证使用 Fake / HTTP fixtures。

未建立 Workflow table/domain/service/UI；未实现 R3.3 UI Reset、R4 自动路由、Human Bridge 自动 fallback、Skill/Memory/Tool routing、R5 或新 Agent 能力。
