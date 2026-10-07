# R5.2 — Memory Pre-Gate

冻结基线：`27700ab42d4d781153f5c48c0b2c54df2a44d629`。本轮仅增加 candidate extraction 前的选择门，不实施 R5.3 rerank 或新的自动 Memory 行为。

## 正式执行路径

`现有用户请求 → owner / conversation / message / sealed LANGUAGE identity 校验 → bounded Pre-Gate → RUN 才调用既有 MemoryCandidateExtractor → 最多 3 个 PROPOSED → 用户 Accept / Reject`。

唯一生产提取入口仍是 typed IPC `memories.proposeFromMessage`。Main 构造可信 owner；用户自己的 USER 消息与当前道友自己的 ASSISTANT 消息可作为证据，其他角色、跨 conversation、Mission 消息、归档道友、Human Bridge、GENERATION Runtime 或无有效 sealed binding 均在 Jev 前拒绝。每次异步调用之后重新验证来源、运行身份及证据文本，防止 await 期间归属/证据变化。

SKIP 返回原 API 的正常空数组。Renderer 保持原“没有需要长期保存的内容”提示；不调用 extractor、不写 PROPOSED、不伪造 Usage。RUN 保持原提取器与 Usage 路径，模型不能把候选变为 ACTIVE。Jev 没有 Memory content/type/importance/owner、Permission、Skill、Tool 或状态写权限。

## 输入与机器边界

Chat 使用 **metadata-only** gate representation，发送：

- sourceType、trigger、messageRole；
- evidenceCharacters；
- trusted local code 生成的 durableStatement / questionOnly / codeOrStructured 三个布尔信号。

不发送 raw message、摘要/摘录、Memory、完整 conversation、Skill instructions、Tool output、文件正文、Credential 或隐藏推理。原始 evidence 仅交给现有 trusted extractor。布尔信号是有限启发式，无法表达所有复杂语义；不代表提取结果或能力评价。

Free Mission / Workflow 的兼容投影另外允许当前 objectiveSummary、Step type、最多 8 个 required capabilities、最多 4 个当前 input Artifact metadata、最多 4 个 output Contract metadata 和 publicState。文本经 secret-like redaction、字符及 UTF-8 限制；总预算不足时确定性裁剪尾部 metadata/summary。没有历史、Artifact content、Workflow input snapshot 或 authority 字段。

独立 `MemoryPreGateService` 固定 `r5-2-memory-pre-gate-policy-v1` / `r5-2-memory-extraction-need-question-v1`，canonical SHA-256 state hash，state ≤4096 UTF-8 bytes、完整 request ≤8192 bytes、response ≤2048 bytes、timeout 6 秒、无 retry。TypeSafe adapter 和 application 共享 request validator，并分别严格验证 response：仅 RUN_EXTRACTION / SKIP_EXTRACTION 与 0–1 confidence，selectedAction 必须 null；未知字段、非法 action/owner、额外答案、超大响应均拒绝。日志不保留 provider raw error body。

Main 复用现有 safeStorage Jev credential、用户主动启用的 Cloud config 与固定 `jev-1.13.0`。R3 validator 仍只接受原四种 SHADOW decision；新增 MEMORY_EXTRACTION_NEED 不增加 R4 authority。

## Fallback

| 来源          | 未配置 / Cloud disabled / 无 Key / timeout / network / schema error |
| ------------- | ------------------------------------------------------------------- |
| USER_EXPLICIT | RUN_EXTRACTION，保持用户原有提取能力                                |
| HARNESS       | SKIP_EXTRACTION，不新增自动提取                                     |

Receipt 明确区分 JEV 与 DETERMINISTIC_FALLBACK，记录 bounded stable reason/error code、version/hash、source/owner IDs、extractorInvoked 和 candidateCount，不复制正文。生产没有持久化 receipt 的新业务需求，因此**无新增 migration、无新增依赖**；0001–0030 不变。

Live Jev = **NOT RUN**，沿用用户离线验收选择。Packaged Fake 只在显式 `--gate1-fake-model --r5-2-fixture` 下启用，不能作为 live API 证据。

## Free / Party / Workflow 兼容性

只读 provenance adapter 要求真实 terminal MissionRun、相同 actor 的 model.call_started/completed 与准确 sealed Runtime。SOLO source 属于 Coordinator 的 Run result；Party source 必须是实际 actor 的 collaboration Artifact，不能通过 membership 推测 owner。

Workflow 额外要求冻结 definition/version、最新 COMPLETED Step attempt、正确 Mission/Run/actor、真实 TEXT/JSON Artifact、contentHash、OUTPUT binding、frozen Contract 和 PASS validation receipt。仅投影当前 Step 的 bounded metadata。

上述 adapter 通过 **Main-only TEST_ONLY harness** 验证，不存在 Renderer 注册入口，不调用 extractor、不写 Memory、不改变 Mission/Workflow。没有 production Mission/Workflow extraction trigger，本轮没有创建自动流程。G3 GENERATION 没有 LANGUAGE Memory authority，原 Generation/continuation/UNKNOWN 路径不改。

## 验证证据

六项原命令全部通过，完整日志归档于 `docs/evidence/r5-2-memory-pre-gate/validation/`。

| 原命令                  | 结果                                   |
| ----------------------- | -------------------------------------- |
| `npm run test`          | PASS：130 个测试文件，1093 项测试      |
| `npm run typecheck`     | PASS                                   |
| `npm run lint`          | PASS                                   |
| `npm run format:check`  | PASS                                   |
| `npm run package`       | PASS：Windows x64                      |
| `npm run smoke:package` | PASS：完整旧 Gate/R/W/G/R5.1 链及 R5.2 |

最终 packaged facts：`docs/evidence/r5-2-memory-pre-gate/d3225ed9-f640-49aa-b005-e9974cefe430/facts.json`。`acceptance.json` 汇总实际 observer 与只读 SQLite 检查：

- Chat RUN：实际 extractor 1 次、1 个 PROPOSED；用户 Accept 后为 ACTIVE。
- Chat SKIP：extractor 0 次、候选 0、没有 extraction Usage。
- 关闭 Cloud 后 explicit fallback：实际 extractor 1 次、1 个 PROPOSED，mode 为 DETERMINISTIC_FALLBACK。
- 总计 2 次实际 extraction，与 2 条 Usage 和各自 source hash 对应；其他 gate/harness 未伪造 Usage。
- B 无法列出、伪造来源、Accept 或 Reject A 的候选。Party participant 的真实 MEMBER_RESULT 只能使用该 participant owner，不能改属 Coordinator。
- Free SOLO、Party Coordinator/Participant、Workflow 已验证 Step Artifact 的四个只读 gate source，均没有自动 extractor/Memory side effect。Workflow hash 使用既有 `workflowHash({content, metadata})`，并检查最新 attempt、OUTPUT binding、冻结 Contract 及 PASS receipt。
- 正常 production 启动没有本轮 Fake、观察器文件或 Main acceptance seam；上述能力只在显式 fixture flags 下启用。

`skill-regression.json` 记录 R5.1 9 次实际调用对应 9 个 durable Skill selection；Free/Party/Workflow/fallback 均完成。`generation-regression.json` 归档 G1/G2 streaming/crash 与 G3 UNKNOWN、retry、Human Bridge continuation 回归。G3 SQLite 的 33 次 LANGUAGE model.call_started 对应 33 个 Skill selection，GENERATION selection/injection 为 0。三个 W2 OFFICIAL v1 manifest/content hash 与审批基线一致，完整值见 `frozen-hashes.json`。

一次完整 smoke 因窗口提前关闭而中断，日志保留为 `validation/smoke-package-interrupted.txt`，不计为通过；随后重新执行完整原命令通过，最终依据为 `validation/smoke-package.txt`。

确定性测试覆盖 RUN/SKIP、PROPOSED/Accept/Reject、触发来源 fallback、timeout/network、非法/超大/额外字段、UTF-8/redaction/hash、跨道友/角色/Runtime、await 期间来源变化、Free/Party/Workflow forged provenance、最新 attempt/Contract/receipt/hash、R3 SHADOW 拒绝本轮 decision。

Windows package 沿用仓库 Forge 配置，在项目内隔离 native dependency 目录执行原 `npm run package`，隔离 Electron rebuild 与 Node 测试 ABI，无临时 preload。完整 `npm run smoke:package` 保留旧 Gate/R/W/G/R5.1 链，新增实际 Chat extraction 与 SQLite 来源检查；正常 production 启动没有本轮 Fake/观察器/Main fixture seam。缓存与测试 profiles 在项目内，未删除用户文件。

## 明确未实现

不修改 owner-first retrieval、FTS/vector/RRF/Top-K 或 PromptComposer Memory ranking，不改 R5.1 Skill selection。不实现 Mission/Workflow 自动 Memory、自动 ACTIVE、Tool shortlist、Review advisory、W3/R6。没有 UI 变化，不为证据另造界面或强制截图。
