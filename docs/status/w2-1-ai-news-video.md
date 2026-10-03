# W2.1 — AI 资讯视频 Official Built-in Workflow

## 范围

基线 `main@0ae15361b1eb865b57a7533986081496bd343efa`。本轮采用 AP-007 v1.1 的 AI 资讯视频 N01–N14；AP-006 继续约束整体架构。不实现软件功能开发、科研模板、W2.2、G1/G2/G3 或 MiniMax 接入。

## 实现与安全边界

官方 v1 通过应用静态 OFFICIAL catalog、Registry release validation 和事务化 installer 安装。Renderer 无 BUILTIN 注册接口。Definition、Artifact Contract、Reference Basis 和运行版本继续冻结。

用户主要阶段为：搜集 → 核验 → 策划 → 脚本 → 素材 → 制作 → 审核。内部步骤、Contract、Receipt、Hash 和历史 attempt 保留在 Advanced。

Step 仍通过 R4 → Mission/Party/Human Bridge 执行，不新增第二套模型、Permission 或 Tool Runtime。缺 Research/素材/配音/制作工具时使用既有 Human Bridge；交付文件必须经 ACCEPT、真实文件检查和正式 Contract 校验。普通模型研究结果必须有同 Run 成功 MCP research reference 事实；人工报告的来源是用户验收的交付报告，不伪称网络抓取证据。

新增 `0020_w21_ai_news_video.sql`，不修改 0001–0019：按 Run/Step attempt 计算冻结的文件作用路径；强化 accepted typed JSON/TEXT report、MCP 文件和目录来源校验；最终确认步骤必须有显式用户确认事件。

0020 同时将新闻 REVIEW 的完成条件与 W2 bounded revision 对齐：PASS 继续要求正式 Review receipt；REVISE 只有在对应的 declared decision、revisionCode 和预算内 traversal 均已持久化后才允许完成。不得仅凭模型输出 REVISE 写入完成状态。旧 W1 inline Run 的 PASS 防线保留。

脚本引用冻结的 source/claim Artifact，UNVERIFIED 或缺少来源的 claim 不得进入脚本。素材需要来源与许可。三条 Final QA revision edge 使用 STORYBOARD / ASSETS / ASSEMBLY，共享 `news.final_qa_revision` 总预算 2；Script revision 另有预算 2。计数与状态迁移继续事务提交。

N12 使用 PREPARED → APPLIED → VERIFIED Operation Receipt；重启优先检查真实文件及 after hash，不自动重放已完成副作用。最终 QA 后停在 USER_CONFIRMATION，需显式确认交付；没有任何自动发布/上传接口。

## 实现映射

| 步骤    | 内容与主要产物                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------- |
| N01–N03 | 发现、事件级去重/聚类、分级来源与 claim packet；普通模型研究输出须匹配同 Run 的成功 MCP URL/hash 事实 |
| N04     | 标准 Review + verification report + verified claims；UNVERIFIED 不可进入脚本                          |
| N05–N06 | 编辑选择、排序和叙事节拍；覆盖选中故事与时长约束                                                      |
| N07–N08 | claim-linked script 与 script claim map；Script Review 最多自动修订两次                               |
| N09–N11 | 分镜/素材计划、来源与许可 registry、真实目录 manifest、配音文件与时间轴                               |
| N12     | 真实 MP4、render manifest、制作摘要；与声明的输入 Artifact、路径和实际媒体元数据对齐                  |
| N13–N14 | FACT/VISUAL/TECHNICAL QA、有界修订、用户最终确认与本地交付                                            |

最终七项输出是冻结 producer Artifact 的选择/投影。`final_video` 指向通过 QA 且用户已确认的 N12 MP4，不再复制或重新渲染文件；原 Artifact identity/hash/lineage 保留。AP-007 的 `output/final.mp4` 是建议交付包名称，本版保留 Run/attempt 隔离的实际路径。

Reference Basis：[ai-news-video-v1.md](../reference-basis/ai-news-video-v1.md)。Registry release metadata 同时保存参考原则、实现映射、排除的厂商机制及 Contract/Revision/Side-effect manifests。正常生产 bootstrap 只安装本轮 AI 资讯视频 v1，不加载测试模板。无新增依赖。

## 恢复与边界收口

- Windows 实际检查路径按冻结 Contract 的分隔符表达匹配，canonical filesystem 检查和 Workspace containment 不变。
- 区分文件字节 SHA-256 与 Workflow Artifact envelope hash：前者关联真实交付文件/Tool fact，后者关联 Artifact/Validation Receipt。
- Human Bridge structured report 只有同 Mission/Run、当前提交批次、ACCEPTED 状态、真实 actor、固定 target 和文件哈希相符时才有效；最终投影再次检查这些持久事实。
- 来源 metadata 按既有单值/总量上限分块保存 URL/hash/event/actor，不扩大 SQLite 限制、不丢弃引用；超限 fail closed。
- 只在 R4 实际选择 Human Bridge 后构造其有界交付草稿，普通模型路径不受人工交付上下文上限干扰。
- 普通 Chat、SOLO/Party、native tool-call/tool-result、exact grant、Memory isolation、Availability、sealed identity、Experience provenance 继续复用既有实现。

## 初版验证

2026-10-03，Windows x64 / Electron 44.4.3：

| 命令                    | 实际结果                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- |
| `npm run test`          | PASS：71 个文件、605 项测试                                                     |
| `npm run typecheck`     | PASS                                                                            |
| `npm run lint`          | PASS                                                                            |
| `npm run format:check`  | PASS                                                                            |
| `npm run package`       | PASS：`out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`             |
| `npm run smoke:package` | PASS：Gate 0–6、R0–R4、W1、W2.0、Product UI System、W2.1 全量真实 packaged 回归 |

新增/强化 deterministic 测试包括：官方 immutable package/Contract、三个 AP-007 case、去重覆盖、source evidence、claim→script trace、UNVERIFIED 拒绝、素材权利/文件 manifest、真实媒体解析、固定 INPUT binding、bounded QA code、确认一次性、Main provenance、Windows 路径表达及有界来源 metadata。W2.0 共享预算、restart 幂等与旧 W1 I/O/final projection 回归继续通过。

### 真实 Windows packaged acceptance

所有案例均经过真实 Renderer → typed IPC → Main → SQLite、普通 MCP Permission/Approval、现有 Human Bridge submit/ACCEPT 和正式 Contract 校验。Provider/Research 使用离线 fixture，成片与音频使用实际文件；不依赖互联网或真实 API Key。

| Case                      | 结果                                              | Step attempt / PASS receipt | 人工交付                             | 成片文件                            |
| ------------------------- | ------------------------------------------------- | --------------------------- | ------------------------------------ | ----------------------------------- |
| A：60 秒单主题 Short      | COMPLETED；用户确认前 WAITING / USER_CONFIRMATION | 14 / 22                     | N10 素材、N11 配音；N10 等待重启保持 | MP4 135,131 bytes，60 秒，720×1280  |
| B：5 分钟三条新闻周报     | COMPLETED；一次 ASSEMBLY QA revision              | 16 / 27                     | N10 素材、N11 配音                   | MP4 633,690 bytes，300 秒，1280×720 |
| C：单一产品发布 Explainer | COMPLETED；用户确认前 WAITING / USER_CONFIRMATION | 14 / 22                     | N10 素材、显式 HUMAN 的 N11 配音     | MP4 382,675 bytes，180 秒，1280×720 |

三例均直接校验：重复候选合并、script claim 全部回溯 source、UNVERIFIED script claim=0、真实文件 hash 与 metadata 相符、全部 14 个声明 Step 持久化、显式确认才完成、social publish action=0。

周报 N12 在 durable APPLIED 后强制终止进程。重启后同 WorkflowRun/Mission/Run 绑定，检查既有文件并达到 VERIFIED；前后 model/tool event 数量完全一致。随后合法 QA revision 创建 N12/N13 新 attempt，原 Artifact/Receipt 保留。Short 的 N10 WAITING_EXTERNAL_WORK 重启保持原请求，不新增调用。

### Evidence

仓库证据：[docs/evidence/w2-1-ai-news-video](../evidence/w2-1-ai-news-video/)。包含人工素材等待截图、真正的七阶段工作流完成页、三个 case 的运行/文件/hash/approval/restart 事实、全量 packaged 日志与单测计数。

最终原始 profile：`.test-data/w21-packaged-3776164f-aeb4-4d84-b045-551cee38e8bd/`，成片在其 `workspace/workflows/<run>/<step-attempt>/output/draft.mp4`。不提交数据库或用户凭据。

兼容性 UI 回归另生成 35 张 R3.3 截图与 83 张 Product System 截图，覆盖 1440 / 1180 / 900。Product System 原始 profile：`.test-data/ui-product-system-0420f4d4-ecd3-4e71-b970-67e04e1d7019/`。

## 当前限制

- 自动化采用离线合成新闻、独立来源 fixture 和测试媒体，不将 fixture 作为真实新闻或生产模板事实。
- 媒体首版校验 PCM WAV、MP4 容器/轨道与 PNG；结构检查不能替代人工音画、版权和事实审阅。
- 单文件与上下文有明确上限；大型专业项目需要用户交付适配本版本约定的文件。
- 单文件上限 10 MB；N10 最多 11 个素材文件，加 registry 保持既有 Human Bridge 12-target 上限；研究证据 metadata 超限要求缩小范围，不截断后假装完整。
- 不内置 Research 服务或剪辑软件，不安装 MCP，不执行任意 Shell。外部能力由用户手动配置的 Tool/MCP 或 Human Bridge 提供。
- 不实现 VIDEO_GENERATION、GenerationGateway/GenerationJob、自动发布和其他两个官方 Workflow。
- 生成模型执行规范 v0.2 仅作为未来兼容约束；本轮未实现 G1/G2/G3、MiniMax H3、W2.2/W2.3/W2.4、编辑器或 Import Existing Work。

## W2.1 corrective repair — 2026-10-03

修复基线 `main@86beeac40954e27240ecabd89d96cfb0a37d940f`。仅修复 Foundation integration；`official.ai-news-video@1` 的 Definition、Contract、manifestHash 和 0001–0020 均未修改。无新增依赖。

### Tool Purpose 与执行准备

- 新增 `0021_w21_tool_purpose_bindings.sql`，以 Tool ID + purpose 保存本地多选用途；用途允许 RESEARCH / ASSET_COLLECTION / VOICEOVER / VIDEO_ASSEMBLY。
- Tools & MCP 对已发现 Tool 提供多选用途，经过 typed IPC、Main discovery 检查和 SQLite 持久化；重新发现或启动恢复本地绑定。MCP 自定义 metadata 不能自行赋予 Workflow eligibility，普通无 metadata 的 server 同样可用。
- 用途只影响 eligibility，不写 PermissionRule，不授予执行权限。所有调用仍经过 ToolRegistry → input validation → PermissionEngine → Approval/exact grant → ToolRuntime → Event/Audit。
- RESEARCH 保持 GENERAL_REASONING + TOOL_USE。N11/N12 有对应工具时，在 trusted preparation 覆盖执行要求为 SOLO MODEL_RUNTIME + TOOL_USE；不要求 SPEECH_GENERATION / VIDEO_EDITING Benchmark，不假装 ModelGateway 生成媒体。无工具继续 Human Bridge，HUMAN 配音仍强制本尊。

### UI 与可信校验策略

- 官方新闻输入使用 Renderer-only 中文 presentation mapping：平台、配音方式、时间范围、目标条数等；冻结枚举值和 Run input snapshot 不变。
- Short 验收真实点击“工作流历练 → 新建运行 → AI 资讯视频 → 填写输入 → 创建运行 → 开始/推进 → 确认交付，不发布”。创建和最终确认均不使用直接调用 create/confirm 的替代路径。
- 本尊主层展示任务、交付物、保存位置、验收重点；完整 objective、claimSafety、deterministic Contract 和 Artifact ID 保留在默认折叠的“完整交付规范 / 高级信息”。复制完整说明、提交、验收与 continuation authority 保持。
- 新增 `WorkflowValidationPolicyRegistry`，Main 静态注册 `news-integrity-v1`；领域只允许 BUILTIN 引用有界 policy ID。未知策略 fail closed，无 Renderer 注册接口，无 USER/IMPORTED 执行代码入口。
- WorkflowService 按 Registry dispatch，不再写死新闻 policy ID；已注册 policy 的严格输出绑定/provenance 防线保持，旧无 policy 的 W1 inline Run 继续兼容。测试另用非新闻 policy ID 证明通用 dispatch，不注册新的生产模板。

### 最终验证

| 命令                    | 结果                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `npm run test`          | PASS：74 个文件、615 项测试                                   |
| `npm run typecheck`     | PASS                                                          |
| `npm run lint`          | PASS                                                          |
| `npm run format:check`  | PASS                                                          |
| `npm run package`       | PASS：Windows x64 / Electron 44.4.3                           |
| `npm run smoke:package` | PASS：Gate 0–6、R0–R4、W1、W2.0、Product UI System、W2.1 全量 |

新增测试覆盖本地用途持久化、未发现 Tool 拒绝、远端用途不可自行生效、绑定不绕过 Approval、N11/N12 TOOL_USE 准备、显式 HUMAN、Registry 未知/重复拒绝与非新闻 policy dispatch，以及输入中文显示和本尊主层/完整约束分层。

| Case           | 配音 / 制作路径                                             | 其他关键结果                                                  |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| 60 秒 Short    | N11 voiceover MCP；N12 assemble_video MCP                   | UI 创建、推进、最终确认；N10 Human Bridge 重启保持；COMPLETED |
| 5 分钟周报     | N11 voiceover MCP；N12 assemble_video MCP，两次独立 attempt | APPLIED 后终止/恢复零重放；一次 ASSEMBLY revision；COMPLETED  |
| 产品 Explainer | 显式 HUMAN 的 N11 本尊；N12 assemble_video MCP              | 本尊 ACCEPT 后继续原执行；COMPLETED                           |

上述 MODEL_RUNTIME 未配置 SPEECH_GENERATION / VIDEO_EDITING Benchmark；普通 MCP descriptors 无 cultivation metadata，用途通过可见 UI 绑定。工具验收精确匹配 Step 的 MissionRun、MCP source、Tool ID、success 与实际 MODEL_RUNTIME actor，不借用其他 Run 或其他 Tool 的事件。三例继续验证 dedup、claim/source trace、Artifact/file hash、正式 validation、revision budget 和零自动发布。

### 新证据与限制

证据：[corrective](../evidence/w2-1-ai-news-video/corrective/)，包含 6 张真实 Windows 截图、`w21-facts.json`、完整 packaged log、测试计数和 package log。原始 profile：`.test-data/w21-packaged-95f2fbcb-b40a-422c-b30e-d81b8a5b771a/`；交付媒体仍在其 Workspace Run/attempt 路径。另生成 35 张 R3.3 和 83 张 Product UI System 回归截图。

工具用途由用户声明，不保证第三方工具能履行交付；实际操作仍需审批，产物仍须 Contract 和真实文件校验。不新增联网研究能力、语音/视频生成 Gateway、官方其他模板或 W2.2。旧版本事实与历史 Artifact 保留，不重写已发布版本。
