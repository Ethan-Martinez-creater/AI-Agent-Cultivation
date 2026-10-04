# W2.3 — 科研 Official Built-in Workflow

## 范围与架构

基线 `8de0e20690c7d8e943e023e534faa314cb3b2a6f`。以 AP-007 v1.1 的 R01–R14 为正式规格；AP-006 保留总体架构边界。`official.research@1` 通过现有 OFFICIAL Registry 与事务 installer 安装，版本、Contract 和 release manifest 冻结。

普通界面只显示探索、假设、实验、分析、写作、审查六阶段；内部 Step、Contract、Receipt、Hash 和 lineage 保留在 Advanced。输入展示中文实验模式，已有资料是受限 ArtifactRef 元数据，不因此授予文件读取或其他权限。

- TASK/REVIEW 继续使用 R4 → Mission/Party/Human Bridge，没有新增 Agent Runtime 或另一套 Permission/Tool 执行系统。
- `research-integrity-v1` 由 Main 注册到现有 `WorkflowValidationPolicyRegistry`；Renderer 没有注册代码、Contract 或 BUILTIN 的入口。
- 保留 fixed binding、Benchmark-only、Availability、Memory isolation、Jev bounded advisory 和 typed IPC。
- 未实现 W2.4、G1/G2/G3、GenerationGateway、GenerationJob、MiniMax H3、自动投稿或发布。

## 科研事实与 Contracts

正式 Contract 覆盖研究问题、文献、筛选、证据、领域概况与缺口、假设、实验方案、实验记录、原始结果、日志、分析与图表、稿件、claim-evidence map、审查、修改回复和最终资料包。

R02 的来源句柄由 Main 从真实、成功且经过 Permission 的 Research MCP result 生成，保存 URL、内容哈希、Tool call、actor、MissionRun 与 StepRun。普通 MCP 返回的 `sources` 可以规范化，不要求 discovery metadata 携带 cultivation 用途字段。本地 purpose binding 继续只影响 eligibility，不授予 Permission。模型内部知识不能注册 citation。明确提供的已有 Source Artifact 必须能解析到真实持久化来源；本尊交付的来源包必须有实际 ACCEPTED 事实。

R03 included/excluded 都要求理由和来源引用。R09 保留各实验 attempt 的方法、指标、不确定性、失败、阴性结果和局限。R11/R13 的关键 claim 必须引用同 Run 的真实 evidence/result Artifact。R14 清单保留全部实验记录、raw/log lineage、分析/图表和审查历史；资料包完成不代表研究结论已被最终证实。

## Revision 与审查

- `research.hypothesis_revision`：R06 → R05，总预算 2。
- `research.experiment_cycle`：R10 的 REFINE_EXPERIMENT / REFINE_HYPOTHESIS 共用预算。Run 输入冻结 `maxExperimentCycles`，范围 1–2，默认 2；数据库与 application 均检查。
- `research.manuscript_revision`：R12 → R13 → R12，总预算 2。
- R10 由可信 policy 根据已校验分析信号与持久化事实选择声明分支，模型不写正式 decision 或修改 Graph。BLOCKED、审查 FAIL 或预算耗尽等待明确用户动作。
- 调整假设的依据可以是可追溯的文献反证，或真实 Tool / ACCEPTED 外部实验记录中的阴性结果；模型自报阴性结果而无对应 durable fact 不足以触发此分支。
- R06/R12 优先排除实际作者 actor；只有一个合格道友时允许继续，并从实际执行归属记录 `reviewIndependence=false`，不伪造独立审查。
- R05–R10 链路的 attempt 上限覆盖初次执行及两个声明的 revision group；允许的回环仍受 group/edge 预算限制，不能用 attempt 上限绕过冻结预算。

## 实验副作用与恢复

R08 的模式只取冻结 Run 输入，模型不能改变：

| 模式              | 执行与回执                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| COMPUTATIONAL     | 真实 Tool/MCP、Workspace、Permission/Approval；每 Step attempt 独立 PREPARED FILE_OUTPUT receipt，原始 JSON 与日志写入独立目录。                      |
| HUMAN_OR_EXTERNAL | 原有 durable Human Bridge；有效 effect 为 EXTERNAL_ACTION，必须有实际 ACCEPTED 交付，不能用模型自报替代。                                             |
| MIXED             | 先真实计算执行，再由可信 Mission completion boundary 请求人工补充；同 MissionRun，独立稳定 external receipt，Main 合并事实，不再调用模型或重复 Tool。 |

Mission completion boundary 已泛化为可信注册表，保留 W2.2 mixed command/manual 验收路径。APPLIED-but-uncommitted 只检查已有文件/哈希/事件；UNKNOWN 外部动作等待用户，不自动重做。Completed Step 不重跑，原始 Artifact identity 和历史实验文件不覆盖。

UNKNOWN 检查覆盖仍在等待外部交付的 Mission，而非只在 Mission terminal 后检查。启动恢复与用户推进都保留原 MissionRun / ExternalWork / receipt，进入 `USER_CONFIRMATION + OPERATION_UNKNOWN`，不创建新的执行。MIXED 从 Tool Approval 恢复时，创建第二个外部回执必须有同 MissionRun 的真实成功 Tool fact；该特例不放宽其他 Step 的 PREPARED 校验。

R08 显式重试必须创建新的 Step attempt，而非在旧目录重跑 Mission。最终交付再次核对所有历史 raw/log 的实际 Workspace 文件哈希。失败经历只由真实执行事实派生；只有外部请求、但未开始或未执行的拒绝交付不会被伪造为实验 attempt。

科研 MCP 仅可在 R02/R08 经本地 RESEARCH purpose binding、ToolRuntime 与 Permission 调用；其他科研 Step 不因此获得写入或执行权限。Purpose 不授予 Permission。计算型 v1 的 FILE_OUTPUT receipt 证明本次声明的原始结果/日志，不构成任意 Workspace mutation 授权。用户配置的 MCP 是外部进程，本轮未新增操作系统级进程沙箱。

追加 `0023_w23_research.sql`，不修改 0001–0022：保存 append-only 真实来源 facts，按冻结实验模式验证 operation effect，并对共享实验预算与所有相关回执完成状态建立数据库防线。

## 验证与证据

2026-10-04 最终验证：

| 命令                    | 结果                                | 证据                                                                          |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `npm run test`          | PASS，92 文件 / 760 tests           | `verification-results.json`；包含 Gate 0–6、R0–R4、W1/W2.0/W2.1/W2.2 全量回归 |
| `npm run typecheck`     | PASS                                | 同上                                                                          |
| `npm run lint`          | PASS                                | 同上                                                                          |
| `npm run format:check`  | PASS                                | 同上                                                                          |
| `npm run package`       | PASS，Windows x64 / Electron 44.4.3 | 实际 packaged exe 与 native SQLite 启动通过                                   |
| `npm run smoke:package` | PASS                                | `docs/evidence/w2-3-research/smoke-package.log`                               |

最终科研 profile 为项目内 `.test-data/w23-packaged-1948057d-0529-45ca-8178-164f94ec68e2`。13 张真实 Windows 截图、durable facts、六项验证与全量 smoke 日志已归档到 `docs/evidence/w2-3-research/`，不依赖临时目录作为唯一证据。

| 验收                | 最终结果                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A 算法/系统实验     | Renderer 创建并完成 R01–R14；Hypothesis/Scientific Review 打回与修改；所有 review actor 均独立；APPLIED 恢复核对已有 raw/log，无模型/Tool 重放 |
| B 已有数据集        | 首次失败/阴性结果保留；第二 attempt 新 raw identity；analysis/final package 保留两次实验；单合格道友 review 如实记录非独立                     |
| C 外部/现实实验模拟 | 本尊提交记录/raw/log并 ACCEPT；PENDING continuation 崩溃后原 MissionRun 恢复、只消费一次                                                       |
| D MIXED             | 真实 MCP 计算 + 原 Run 人工补充；secondary receipt VERIFIED；ACCEPT 后恢复零模型/Tool 重放                                                     |
| F 共享预算          | REFINE_EXPERIMENT / REFINE_HYPOTHESIS 各一次，共用预算 2；第三次停止为 `WAITING + DECISION_BLOCKED`                                            |
| E 外部 UNKNOWN      | 原 PREPARED 在隔离验收库模拟不确定；重启保留 UNKNOWN / 原请求 / 原 MissionRun，`USER_CONFIRMATION`，零重放                                     |

最终重启计数完全相同：`model.call_started 107→107`、`tool.result 13→13`、`CONSUMED continuation 2→2`。四个完成案例均为 `NOT_SUBMITTED / NOT_SCIENTIFICALLY_CONFIRMED`。来源与 claim 引用、Approval、immutable raw/log、审查归属均核对 SQLite / typed IPC 事实。

确定性 policy/application/persistence 测试另外覆盖 fabricated citation、其他 Run 来源、缺失筛选理由、伪造 claim 引用、虚构阴性结果、回执/模式/预算约束、失败历史与 UNKNOWN pending Mission 恢复。测试 fixture 与 FakeModelGateway 不参与普通生产 bootstrap。

新增依赖：无。历史 migration 0001–0022、W2.1/W2.2 frozen package/manifest 均未修改。旧 smoke 的 schema/官方安装数量断言同步到 migration 23 / 三个正式 Workflow；不是更改旧执行语义。

## 当前边界

自动验收使用离线 FakeModelGateway 与用户配置的 stdio MCP fixture，不依赖互联网/API Key。实际科研工具仍需用户提供并授权；本版不增加 Shell、自动装工具、伦理审批或实验安全审批。计算型 MCP 应提供可核对的 bounded experiment/file evidence；Main 仍核对实际文件与同 Run/Step 的 Tool fact。

Reference Basis 见 `docs/reference-basis/research-v1.md`。本 Workflow 不替代系统综述规范、伦理审批、实验安全审批或领域专家判断。

## W2.3 corrective repair（2026-10-04）

修复基线 `555b6731f118058abc39ac053587dd39f6223e15`。`official.research@1` Definition、Contracts、manifest 与 0001–0023 完全不修改；W2.1/W2.2 frozen packages 保持原样。本轮没有新增依赖，也没有进入 W2.4 或 Generation 实现。

### Research Delivery Projection

Main/application 的可信投影只选择同 Run 的实际 Artifact，逐项核对冻结官方版本、精确 output binding、Contract/version/validator 回执、W1 envelope hash、completed producer/checkpoint，以及真实 Mission/MissionRun/actor 来源。最终包里的字符串 ID 不用于推断 Artifact 存在。

普通交付列表展示研究摘要、证据表、研究版图、当前有效假设和实验计划、全部有效实验记录、当前有效分析、最终稿件、全部假设与科学审查记录及最终资料包。R13 已完成后只选最高有效 attempt 的修订稿；若该最新稿损坏，不退回旧 R11 稿冒充最终稿。实验记录保留全部 completed producer attempts，包括记录中的 FAILED/negative result；历史假设、计划、分析及所有 Artifact 技术事实继续保留在 Advanced，未删除原事实。

### Trusted Input Artifact 与 0024

追加 `0024_w23_input_artifacts.sql`：

- `workflow_input_artifacts`：Main 登记的不可变 DATA/CODE 文件事实，关联真实 USER Tool read audit、相对路径、内部 Workspace identity、已读取内容和 SHA-256。
- `workflow_research_input_bindings`：同 Run input key/index 与可信 Artifact 的不可变关联；INSERT trigger 校验 frozen input snapshot 的 id/kind/hash 与真实资料/Source provenance。创建 Run、快照及 input binding 同一事务提交。

科研创建界面只接受 Main 候选。已有来源来自先前真实 Research Tool 成功结果的持久化 Source facts；数据/代码通过 Main 原生文件选择与读取确认，在当前 Workspace 中经 `file.readText → ToolRuntime → PermissionEngine` 登记。USER 导入不伪造 Mission/道友行为，不生成 Agent grant；显式 DENY 仍优先。Renderer 不能指定导入绝对路径、批准权限、执行任意 Tool 或登记身份字段。名称由 Main 规范化为展示字段，不构成文件授权。

创建 Run 前同步校验资料可解析、kind/category/hash、存储内容及实际文件 SHA-256，并重新验证 canonical root、路径组件、symlink/junction、打开文件身份和大小；不存在、跨类别、伪造类型/哈希、改变/删除的文件均 fail closed。资料及绑定 append-only，Run snapshot 继续由既有 0018 防线冻结。

Step 仅收到其已声明 input keys 的 bounded/untrusted 引用及 Workspace-relative metadata，绝对路径和文件内容不由 opaque Ref 自动注入模型。R07/R08 的实际文件使用仍经过原 Tool/MCP/Permission 链，验收同时核对实际 raw result 的 inputArtifactId/inputContentHash 与 frozen snapshot。导入不是新的文件读取权限。当前本地资料登记支持不超过 64 KiB 的 UTF-8 FILE；未新增目录导入或 W3 Import Existing Work。修复前未受信的旧引用不会被自动补造 provenance。

### 日期范围与产品展示

可信 `research-integrity-v1` 校验 `literatureTimeRange.from <= to`，支持仅 from、仅 to、合法双边界；倒序在 Main 拒绝创建。UI 保持 frozen `{from,to}` shape，以一组并排日期控件展示，没有重复清除按钮。资料选择器只展示名称；验证错误显示在创建抽屉内。

### Corrective 验证与证据

最终验证与实际截图归档至 `docs/evidence/w2-3-research/corrective/`，由 `verification-results.json`、`facts.json` 和 `smoke-package.log` 记录最终六项命令与真实 packaged profile。包括 UI 导入 dataset、可信 Run snapshot、R07/R08 实際 Artifact 使用、完整交付投影、倒序日期拒绝及原 A/B/C/D/F/E 回归。完整数据库、Credential/ciphertext、私人文件与应用 profile 不提交。

最终 corrective 验证：95 个测试文件 / **789 tests 全部通过**；`test / typecheck / lint / format:check / package / smoke:package` 六项均 PASS。最终 Windows profile 为项目内 `.test-data/w23-packaged-eab90f3f-4dbe-4891-bf86-49f212a97fe1`，17 张真实截图已归档。B 场景展示 2 条实验记录与 4 条假设/科学审查历史，并保留最终 R13 稿件；原 A/B/C/D/F/E 及完整前置阶段回归均通过。实际 SQLite OFFICIAL release manifestHash 与 version contentHash 均与原批准 v1 完全一致，见 corrective/release-facts.json。
