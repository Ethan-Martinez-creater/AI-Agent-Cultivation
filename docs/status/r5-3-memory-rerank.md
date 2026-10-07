# R5.3 — Memory Rerank

冻结基线：`36ac835283b29a05b3e2d7b492511bdbfbf707c0`。仅实现可选 Memory relevance rerank，不推进 R5.4/R5.5、W3/R6。

## 公共检索路径

`实际 LANGUAGE 执行者 → SQL owner/status/expiry scope → 既有 FTS / scoped sqlite-vec → 原 RRF 融合 → bounded shortlist → 可选 Jev → 当前事实复查 → Top 6 → PromptComposer → ModelGateway`。

公共 `Gate2HybridMemoryService.retrieve` 供 Single Chat、SOLO、Party Coordinator/Participant 和 Workflow LANGUAGE Step 使用。保持原 lexical 6、vector 12、`1/(60+rank)` 融合及其稳定 insertion tie 顺序，不另建检索 Runtime。融合阶段保留候选以形成 bounded shortlist；fallback 的前 6 与冻结 R5.2 算法等价。

本地 retrieval query 与云端 rerank task query 可独立传递。Party 的可信执行边界只把当前 Mission objective 作为 cloud query，公开结果、协作 outcome、synthesis Artifact body 不进入云端 query；原 `task.memoryQuery ?? task.task` 仍用于既有本地 FTS/vector，因此不改变冻结 fallback。该可选 context 仅在 application/Main 使用，不增加 Renderer authority 或 IPC。

进入 Jev 前，application 再检查 TEAMMATE owner、实际 teammate ID、ACTIVE 和有效且未过期的 expiresAt，即使 lexical/vector adapter 返回跨 owner 或非法状态也无法越过边界。Jev 返回 ID 只能来自当次集合，不用于任意 DB lookup。await 后使用 scoped SQL 当前记录重新核对 owner/status/expiry，仅从原 shortlist 补位，不使用旧对象直接注入。PromptComposer 的独立 owner/status/expiry、5 项默认及 4000 characters Memory section 上限保持不变，并保留 relevance order。

GENERATION 与 Human Bridge 不取得 LANGUAGE Memory authority。Main 公共 prompt context 只为 ACTIVE、有效 sealed LANGUAGE ModelBinding 读取 Memory；不修改 G3 Task/Job/Gateway/UNKNOWN/continuation。

Human Bridge target 不接收其他道友的私有 Memory。接受外部交付后的 Coordinator LANGUAGE synthesis 仍由真实 Coordinator 独立检索自己的 Memory；这不向 Human Bridge 转交 Memory，也不改变既有 continuation authority。

## Decision 与隐私

新增独立 `MEMORY_RELEVANCE`，R3 SHADOW 继续只接受原四类 Decision，R4 authority 不扩大。Main 复用用户主动开启的现有 `cloudEnabled`、safeStorage Jev Credential 和固定 `jev-1.13.0`。

Jev 仅收到 bounded query 和候选 `{id, memoryType, text}`：优先 summary，空 summary 才使用脱敏、规范化、截断的 content excerpt。不发送 owner 私有历史、完整 Memory、Skill instructions、Tool output、Artifact/文件正文、Credential 或隐藏推理。Workflow 只使用现有当前 Step query，不附加历史。Cloud disabled / 无 Key 完全不向 Jev 发送这些字段，不自动开启 Cloud。

`r5-3-memory-rerank-policy-v1` / `r5-3-memory-relevance-question-v1` 集中维护 shortlist ≤12、最终检索 Top K 6、query ≤600 characters / 1200 UTF-8 bytes、每条 semantic text ≤240 characters / 720 bytes、state ≤11000 bytes、完整 request ≤16000 bytes、response ≤8192 bytes、6 秒超时和无 retry。超出总预算先确定性缩减文本，再裁剪尾部候选。每候选一个 `memory.<id>` numeric Noul 0–1 问题；严格绑定 version/hash/candidate IDs。响应必须覆盖当前候选且每个 ID 恰好一次；拒绝未知/跨 owner/重复/非有限分数、extra field/action/rationale 和超大 envelope。Application 按 score DESC、baseline rank、ID 排序。

Settings 的 Cloud 高级隐私说明同步披露 bounded Memory summary/excerpt；仅修改文案，不改变 config authority 或界面结构。

## Fallback 与可观察性

Cloud disabled、无 Key、gateway unavailable、timeout/network/SDK/schema/score/ID 错误均按同一 deterministic baseline 排序，不返回伪造 Jev success，不阻塞正常执行。空候选不调用 gateway。

无新增 migration、无新增依赖。生产不持久化 transient rerank response。仅显式 `--gate1-fake-model --r5-3-fixture` 创建观察器与 Main-only acceptance seam；正常生产无 Fake、无观察器。证据只保存 ID、rank、有限 score、query/text hash 和长度、shape/bytes、version/mode/reason，不复制语义正文或完整 Prompt。

旧阶段的离线 Fake model profile 未启用 R5.3 fixture 时，新增 rerank 使用原 deterministic fallback，避免旧测试 Key 引发新网络调用。R5.3 packaged profile 另显式启用 R5.1 fixture，以离线覆盖共享 Party/Workflow Skill 路径；这不改变正常生产的 Cloud opt-in。

R5.2 RUN/SKIP、USER_EXPLICIT fallback RUN、HARNESS fallback SKIP、extractor、PROPOSED/Accept/Reject、生产提取入口均不变。普通 retrieval 不调用 extractor、不写 Memory。

## 验证

六项原命令及 packaged 结果归档至 `docs/evidence/r5-3-memory-rerank/validation/`：

| 原命令                  | 最终结果                     | 证据                           |
| ----------------------- | ---------------------------- | ------------------------------ |
| `npm run test`          | PASS：132 files / 1133 tests | `validation/test.txt`          |
| `npm run typecheck`     | PASS                         | `validation/typecheck.txt`     |
| `npm run lint`          | PASS                         | `validation/lint.txt`          |
| `npm run format:check`  | PASS                         | `validation/format-check.txt`  |
| `npm run package`       | PASS：Windows x64            | `validation/package.txt`       |
| `npm run smoke:package` | PASS：完整旧链 + R5.3        | `validation/smoke-package.txt` |

最终验收使用完整原命令，无临时 timeout 参数、无 NODE_OPTIONS preload、无跳过旧 smoke。Electron native rebuild 使用项目内物理 dependency 副本 `.tmp/g3-verify` 隔离 Node 测试 ABI；命令仍为 `npm run package`。`build-provenance.json` 记录 source/build 输入 hash 相等及实际验收 `app.asar` SHA-256 `3c740acfe2759cd18b5f0469dbb34676bdc9b60a08b7ccb4b44b23ba68cb1ef9`。缓存、临时目录和测试 profile 均位于项目内。

完整 packaged run：`2368706c-d4c7-44e3-8e95-ca97de284333/facts.json`。观察到 8 次离线 Jev rerank、3 次 deterministic fallback、11 次 retrieval、9 次真实 packaged LANGUAGE model call；Memory rows 13 → 13，extractor 0。最大观察 request 4971 bytes、state 1594 bytes。实际 Chat relevance order 与最终 Prompt Top 5 对应，Cloud-off ID/order 完全等于原 fusion；SOLO、Party 和 Workflow 均 COMPLETED。A/B 独立 owner；Party 所有 cloud query hash 都等于当前 objective hash，不包含 synthesis 的 public-result body。

`acceptance.json`、`final-packaged-facts.json`、`deterministic-baseline.json` 汇总候选、排序、最终 Prompt ID、owner 隔离与 stale recheck。R5.1 Skill、R5.2 RUN/SKIP/显式 fallback/Accept、G3 LANGUAGE/GENERATION/UNKNOWN/continuation 回归分别见 `skill-regression.json`、`memory-pre-gate-regression.json`、`generation-regression.json`。三个 OFFICIAL v1 的 manifestHash/contentHash 从本次 packaged production SQLite 读取，与冻结基线逐一相同，见 `frozen-hashes.json`。

1440 / 1180 / 900 DIP 的真实 packaged 隐私披露截图位于最终 run 目录；Windows 125% DPI 对应 1800 / 1475 / 1125 像素。已检查文字和控件无裁切。正常 production launch 无 R5.3 Main acceptance seam、Renderer acceptance IPC 或 fixture observer 文件。

保留早期截图导航 selector、旧隐私文案断言和 lint helper 的失败日志；另外保留为修正 Party query 边界主动中断的整链 smoke 日志。首轮最终 format check 发现本次旧阶段 smoke 新生成的 4 个 JSON 未格式化，保留失败日志并仅格式化这 4 个生成文件后重新运行原命令。它们不是最终验收结果，最终 packaged 证据仅引用重新完整通过的 `validation/smoke-package.txt`，未删除失败日志。

确定性测试包括冻结融合 golden order、恶意 adapter、最终 Prompt scope/order、await 期间 archive/expire/owner/status/delete、严格协议和各类 fallback。Packaged 验收覆盖实际 Chat/SOLO/Party/Workflow model call、owner isolation、排序生效及禁用 Cloud 后的基线等价。

Live Jev = **NOT RUN**，按用户此前离线验收选择。完整旧 Gate/R/W/G/R5.1/R5.2 smoke 已通过；三个 OFFICIAL v1 manifest/content hash 与冻结基线逐一相同。

## 已知限制

Jev relevance 是 advisory 分数，不提供正确性保证，不赋予 Memory/Permission/Tool authority。Cloud 请求可能含 bounded 私有 Memory 摘要或脱敏摘录，仍需要用户现有 opt-in；脱敏规则和长度限制不等于消除所有语义隐私信息。Live Jev 未执行，SDK 协议使用离线 deterministic transport mock 验证。

不实现 R5.4 Tool shortlist、R5.5 Review/Completion advisory、W3、R6；不改变 Skill Routing、Memory extraction、官方 Workflow 图、Generation 协议或产品评分语义。
