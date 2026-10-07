# R5.4 — Tool Shortlist

冻结基线：`98dd00c9676858335deea1555359d3beca940a31`。仅优化已有 LANGUAGE Tool loop，不进入 R5.5、W3、R6。

## 执行边界

`实际 actor / 当前可信 task → 当前 registry → deterministic eligibility → 可选 Jev relevance → fresh descriptor recheck → offered descriptors → 模型 args → offered-set / fingerprint 检查 → 原 ToolRuntime → schema → resource → Permission → Approval / Guard → execution`。

接入 Gate3 SOLO 和 Gate5 Coordinator/Participant 每次 model step；Workflow 继续通过同一 Mission/Party runtime 执行。普通 Single Chat 不增加 Tool calling。GENERATION、Human Bridge target 与 G1/G2 内部 Artifact Permission 不进入 shortlist；Human Bridge 后的 LANGUAGE Coordinator synthesis 独立使用自己的 actor。

Main 的候选来自当前注册工具。MCP readiness 只读本地已连接 session，不触发发现、连接、探测或安装。普通 Mission 不发明 capability→Tool 授权模型；Workflow 描述符预筛只投影现有 frozen software/research scope、当前 Step/Run 与必要 PREPARED receipt。实际路径、命令、Workspace、mutation journal 和 guard 仍在模型产生 args 后经 ToolRuntime 检查。新闻 Workflow 的既有执行 guard 没有新增目的限制，不能由 objective 文本推断权限。

## Decision / 隐私 / fallback

独立 `TOOL_RELEVANCE`；R3 Shadow 仍仅接受原四类 decision。Main 只在既有 Cloud opt-in 且 safeStorage 凭据存在时创建固定 `jev-1.13.0` adapter。不自动启用 Cloud。

Cloud opt-in 在安全存储密钥读取前、读取完成后和实际发送前分别复核；用户在异步准备期间关闭 Cloud 不会发出新的 Tool metadata 请求。已发送的请求不撤回，返回后仍受 fresh registry / fingerprint / response 校验。

Jev state 仅含当前 actor/phase、bounded objective、当前 Step capability 与有限 Artifact/output metadata，以及候选 id/source、有限 name/description、capability/riskLevel/sideEffect/workflowPurposes、顶层 input shape。shape 仅 property name/type 与 required names，不含完整 schema/default/enum/example。描述和 schema summary 是不可信数据，问题指令明确禁止服从其中指令或返回 args、resource、action、approval。

不发送 Tool output、文件/Artifact body、Member result、synthesis body、Memory、Skill instructions、完整聊天/Workflow history、MCP command/cwd/env、Credential、审批正文或隐藏推理。Settings 数据范围同步披露 Tool metadata、MCP env 排除和推荐不授予 Permission。

`r5-4-tool-shortlist-policy-v1` / `r5-4-tool-relevance-question-v1`：候选 ≤24，Jev selected ≤8，state ≤16000 UTF-8 bytes，request ≤30000，response ≤16000，6 秒、无 retry。每候选使用 `tool.<index>` Noul 0–1，index 到精确 ID 的映射由 application 固定，避免任意 MCP 名称变成问题结构。按 score DESC、baseline rank、ID 确定性排序。

严格校验 version/hash/完整候选、重复或额外 ID、非有限/越界 score、额外字段、action/rationale、telemetry 和 envelope bytes。任何 invalid response 整体 fallback，不部分接受。Cloud off、无 Key、timeout/network/SDK/schema 失败均返回当前完整 deterministic eligible 集合及原 registry 顺序。eligible 超过 24 时完全跳过 Jev，保留全部工具，不 first-24 截断；fallback 不应用 selected 8 上限。空集合继续无工具 LANGUAGE response，不失败整个 Mission。

## TOCTOU / 审批恢复

fingerprint 覆盖 id/source/capability/riskLevel/sideEffect/inputSchema/workflowPurposes，以及 name/description。Jev await 后重新取得 registry/eligibility，只提供仍存在且 fingerprint 相同的 fresh descriptor。每个模型 step 重新选择，不将第一次 selection 缓存为 Run authority。

失败或 invalid response 的 fallback 同样进行 await 后的复核。await 期间新注册或改变语义的 descriptor 本次不提供，下一模型 step 重新选择后才可参与；不会将新的 authority 塞回旧 offer。没有异步变化时，fallback 与完整 deterministic registry 集合及稳定顺序完全一致。

Model call 必须属于当次 exact offered set；否则返回原生 tool transcript 的 bounded `TOOL_NOT_OFFERED`，零 dispatch、零 Permission evaluation、零 Approval、零 execution。dispatch 前再核对当前 fingerprint，改变返回 `TOOL_CHANGED`。提供给模型的 descriptor 与 offer 被冻结，application 内部 offer/context identity 防止不同 actor 的 offer 复用。

新 pending call 在既有 continuation JSON 保存 fingerprint；批准/重启时再核对 schema/risk/sideEffect/purpose，复用原 Run/call/transcript。旧 pending JSON 没有该字段时保留冻结的 source/capability/resource 检查。Approval 不触发新的 Jev decision，不允许变更 descriptor 获得 grant。原 ToolRuntime 安全顺序和 Permission DENY 优先、ASK、exact Mission grant 均保持。

生产 MissionEvent/Audit 保存 bounded selection IDs、score、fingerprint、mode/reason、hash/version/bytes，不保存完整 schema/args/response/body。显式离线 fixture 使用独立 project-local profile 与 ID/hash/shape observer；正常生产无 fixture Workflow、Fake observer、Main acceptance seam 或 Renderer fixture IPC。

## 验证与交付

无 migration，无新增依赖，不修改 0001–0030 或三个 OFFICIAL v1。普通 Chat、GenerationGateway、ToolRuntime 和 PermissionEngine 不变。

| 原命令                  | 最终结果                                                  |
| ----------------------- | --------------------------------------------------------- |
| `npm run test`          | PASS：138 files / 1225 tests，287.34 秒                   |
| `npm run typecheck`     | PASS                                                      |
| `npm run lint`          | PASS                                                      |
| `npm run format:check`  | PASS                                                      |
| `npm run package`       | PASS：Windows x64 / Electron native rebuild               |
| `npm run smoke:package` | PASS：完整 Gate 0–6 / R0–R4 / W1–W2.4 / G1–G3 / R5.1–R5.4 |

测试重点包括 bounded/redacted request、严格 SDK envelope、候选溢出 full fallback、invalid/timeout fallback、异步 unregister/descriptor mutation、exact offer/context、每 model step 重选、schema-before-Permission、FILE/MCP/EXECUTE_COMMAND DENY、Guard DENY、pending fingerprint / native transcript 重启恢复、Party 实际 actor、只读 Workflow scope 和 Cloud 撤销。

Windows packaged acceptance 使用 4 个 Built-in + 12 个真实 stdio MCP 注册 descriptor，SOLO/Party 在 16 个 eligible 中仅向模型提供 8 个；Workflow 的可信 fixture scope 仅允许 `file.readText`。Cloud off 同一 read task 保留完整 16 个及原顺序，Jev = 0。普通 production 不加载 fixture observer/Workflow。

package 在项目内既有物理 native dependency 副本 `.tmp/g3-verify` 执行原 `npm run package`，防止 Node 测试和 Electron ABI 相互污染；完整基线与当前源码复制，运行源码 hash 与 root 对比记录在 `build-provenance.json`。TEMP、缓存、所有 profile/Workspace 均在当前项目，无 NODE_OPTIONS preload 或机器 monkey patch。六项命令不附加 CLI flags；离线 packaged 子实例按本阶段要求使用显式 fixture flags，正常 production 无这些 flags。未跳过任何旧 smoke。

证据入口：`docs/evidence/r5-4-tool-shortlist/README.md`。开发阶段失败/interim/focused 日志保留，不替代最终六项原命令结果。首轮完整 smoke 已通过；最终审核补 Cloud 撤销复核后重新完整执行并重新生成最终证据。

Live Jev = **NOT RUN**，沿用用户离线验收选择。已知限制：relevance 不保证正确性；脱敏和上限不消除所有语义信息，Cloud 仍需用户主动开启。fallback 可能向模型提供超过 8 个合法工具，以保留原有功能。

最终 packaged run：`42ac6ed1-0e55-4e78-a761-c7d4f0b0f53b`。A–G 事实、Privacy 1440/1180/900 PNG 与 layout JSON 已提交到本轮 evidence。三档截图已实际核看，无横向溢出或隐私说明裁切。275 个运行构建输入逐文件一致；app.asar SHA-256：`9f5a7d8911d6305298dbce87dd1b8142d35e42651662bde524d6ebfef66f0243`。

完整旧链重新验证 R5.1 Skill actor/fallback、R5.2 RUN/SKIP/PROPOSED、R5.3 owner-first/stale/Cloud-off、Gate4 文件/MCP/ASK/exact grant、W2 mutation PREPARED/APPLIED/UNKNOWN 和 production restart zero replay、G3 LANGUAGE/GENERATION isolation、Human Bridge/UNKNOWN。三个 OFFICIAL v1 的 manifest/content hash 与冻结基线完全一致，见 `frozen-hashes.json`。
