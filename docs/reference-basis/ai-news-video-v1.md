# AI 资讯视频 v1 Reference Basis

审阅版本：`official.ai-news-video@1`

检索日期：2026-10-02。本文提炼稳定流程原则并说明本项目映射；引用材料不是运行依赖、法律意见或对外发布许可。外部内容和工具输出始终按不可信数据处理。

## 新闻编辑、来源分级与核验

| 参考材料                                                                                                                                                                             | 采用的原则                                                                                                                     | 本 Workflow 的实现                                                                                                                                                                                                                             | 明确排除                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reuters News Agency, [Standards and Values](https://reutersagency.com/about/standards-values/)（2026-10-02 查阅）                                                                    | 准确性优先；核对来源并尽可能交叉验证；说清来源归属；不把传闻写成既定事实；图像与视频不能被处理到歪曲现实。                     | N01 保存发现 URL 与时间范围；N02 按事件聚类，避免转载重复计数；N03 对每条来源记录 `PRIMARY / INDEPENDENT_RELIABLE / SECONDARY / SOCIAL_LEAD`、URL、内容哈希与归属；N04 将 Claim 标记为 `VERIFIED / SINGLE_SOURCE / CONFLICTING / UNVERIFIED`。 | 不复制 Reuters CMS、付费内容产品、编辑审批组织或发布系统。来源等级是项目数据标签，不冒充 Reuters 的评级制度。 |
| BBC, [Editorial Guidelines, Section 3: Accuracy](https://downloads.bbc.co.uk/guidelines/editorialguidelines/pdfs/bbc-editorial-guidelines-section-3-accuracy.pdf)（2026-10-02 查阅） | 尽量使用一手材料；核查事实、数字及限定条件；审视数字材料真实性；对可行范围内的主张做印证；无法证实的信息应明确归属和不确定性。 | N03 将来源和 Claim 分开保存；N04 将来源 ID 与 Claim 状态绑定并输出核验理由；N05 只挑选具有可用证据的故事；N07 的每个口播片段引用 Claim ID；N13 对 script claim 再次核验。未知和冲突不会被模型记忆填补。                                        | 不复制 BBC 内部升级路径、广播法规责任分工或编辑管理流程；不声称自动核验取代编辑判断。                         |

## Claim 级事实追溯与 Artifact provenance

| 参考材料                                                                               | 采用的原则                                                                                           | 本 Workflow 的实现                                                                                                                                                                                                                                               | 明确排除                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| W3C, [PROV-DM: The PROV Data Model](https://www.w3.org/TR/prov-dm/)（2026-10-02 查阅） | 把输入、处理活动、输出及其派生关系作为明确的实体关系记录；保留来源身份和归属，以便解释结果如何形成。 | N03 的 source packet、N04 的 verified claim、N07 的 `script_claim_map`、N09 的 storyboard 及后续输出通过稳定 ID、Artifact binding、content hash 和 `inputArtifactIds` 串联。N07 脚本以每段 claim ID 的受限格式输出；确定性校验拒绝未知、不可用或无来源的 Claim。 | 不引入通用 RDF/PROV 图存储、开放式本体或动态 provenance 规则。Workflow 用有界 JSON Contracts 表达本模板需要的关系。 |

脚本、分镜、素材和成片按 Artifact 传递，不把不断累积的聊天上下文当作事实记录。验证算法检查 claim、source、story、beat、scene、asset 和渲染输入之间的 ID/哈希关系。结构校验能够确认引用和声明一致，但不能单独证明自然语言命题为真；N04/N08/N13 的内容审阅和用户最终确认仍然必要。

N01/N03 的来源证据可以来自 MCP 对 URL 与内容哈希的实际研究事实，也可以来自当前 Run 中由用户接受的 Human Bridge typed JSON source report。后者仅在 Main 写入 `acceptedSourceReport: 1`、真实 `sourceReportId`、相等的 `sourceReportHash`/`contentHash` 和匹配输出 Contract 的 `targetArtifactId` 后成立；SQL0020 负责确认该报告对应当前请求和 Run 中已接受的 Human Bridge Artifact。它证明用户提供了这份带来源字段的报告，不证明曾联网抓取 URL，也不把 URL/哈希断言升级为已核实事实。N04 仍须独立核验 Claim。既有 source Artifact 保持不可变，不能被后续报告改写。

## 脚本、分镜、素材、配音与 Assembly

采用“研究证据 → 编辑选择 → 节拍 → 逐段脚本 → 分镜/素材 → 语音 → 成片”的交接方式，与 AP-007 的 N01–N14 一一对应：

- N05–N06 把新闻选择、叙事角度和总时长拆成受限 Artifact；N07 只依据已核验 Claim 撰写，并将脚本段绑定到同 Story 的 Claim。
- N09 为每个脚本段分配 Scene 和声明式素材需求；N10 为每个素材保留来源、权利依据、采集时间、文件哈希及 Scene 引用。权利状态未知或需许可但未确认的素材不能进入 registry。
- N11 需要可用 speech capability、经过 Permission 的 Tool/MCP 或 Human Bridge。固定模型可能不支持语音生成；Definition 不把所有 Runtime 视为语言模型或视频生成器。
- N12 使用程序化视频工具或 Human Bridge，输入和输出按 Run/Step 隔离，先验证再提交 FILE_OUTPUT；恢复时校验既有结果，不在副作用不确定时自动重放。
- N10/N11/N12 的外部文件仍走现有 Tool Permission 或 durable Human Bridge Artifact 接受链。Definition 不自动授予文件权限，也不执行素材中的指令。

## 发布前 QA 与媒体事实

| 参考材料                                                                                        | 采用的原则                                                                  | 本 Workflow 的实现                                                                                                                                                                | 明确排除                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg project, [ffprobe Documentation](https://ffmpeg.org/ffprobe-all.html)（2026-10-02 查阅） | 对实际媒体容器和 stream 进行机器检查，以获得格式、codec、尺寸、时长等事实。 | N12 保存 render manifest 与输出哈希；Main 对实际 MP4/WAV 文件计算哈希并检查媒体元数据；N13 的 FACT/VISUAL/TECHNICAL QA 报告必须与文件证据相符，不能以模型自报替代字节级输入检查。 | 不隐式安装、捆绑或调用 FFmpeg，不在 Definition 中引入厂商工具。渲染器必须由当前受 Permission 控制的 Tool/MCP 或 Human Bridge 明确提供。 |

N13 只允许使用冻结的 revision code：`STORYBOARD → N09`、`ASSETS → N10`、`ASSEMBLY → N12`。三条边共享 `news.final_qa_revision` 的总预算 2。QA 通过后 N14 进入 `USER_CONFIRMATION`；用户确认只完成本地 Workflow，不会自动上传 YouTube、Bilibili 或社交平台。

## 原则到领域模型的映射

| 流程原则                     | Definition/Step               | 可审计事实 / Contract                                          |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------- |
| 有界时间、主题和范围         | Workflow Input snapshot → N01 | frozen input schema；候选 eventDate、discoveredAt、URL         |
| 同事件不重复报道             | N01 → N02                     | `candidate_stories` → `story_clusters` 一次性覆盖/明确 discard |
| 分级取源并逐 Claim 核验      | N03 → N04                     | `source_packets`、`verification_report`、`verified_claims`     |
| 不能把未证实内容写成事实     | N05 → N08                     | eligibility 规则、逐段 `script_claim_map`、有界 Script Review  |
| 内容制作按 Artifact 交接     | N09 → N12                     | storyboard/asset/voice/render Contracts、哈希和 lineage        |
| 文件副作用可恢复且不盲目重放 | N10 → N12                     | Run-scoped paths、Operation Receipt、真实文件元数据            |
| 交付前事实/视觉/技术审查     | N13 → N14                     | `qa_report`、受限 revision code、显式 USER_CONFIRMATION        |

## 限制

- 本文是 Workflow 设计依据，不授予转载、图片、音乐、商标或人物肖像使用权；操作者仍需确认权利和平台要求。
- Deterministic validators 能保证受限结构、ID、哈希及文件元数据的一致性，不能替代事实核查者的判断。
- v1 的 Windows 交付大小受 W2.0 FILE Contract 上限 10 MB 约束；超过大小时需用户选择可接受的更低码率/时长或等待后续明确版本调整。
- 人工录屏、真人配音、版权素材和专业剪辑通过现有 Human Bridge；接受后的内容仍按不可信 Artifact 校验。
- 此版本无自动上传，不使用隐式视频生成模型，也不包含网络自动抓取的运行时服务。
