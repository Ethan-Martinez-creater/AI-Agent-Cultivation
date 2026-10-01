# W1 — Workflow Foundation

## 范围与依据

基线 `main@1bd326479aa3a248f63eb6b7ff0e139a6e0d1aa2`。AP-006 定义 W1 Foundation 与现有业务边界；AP-007 v1.1 定义未来 W2 的正式规格，替代 AP-006 旧 W2 模板。未来官方模板仅为 AI 资讯视频、软件功能开发、科研。本次不发布任何官方模板。

## 领域与持久化

新增 `0017_w1_workflow_foundation.sql`，不修改 0001–0016。保存 Definition 身份、不可变 Version/Step/Edge、固定版本 Run、独立 StepRun attempt、Artifact/Binding/Input lineage、ValidationReceipt、DecisionFact、Checkpoint 与 append-only WorkflowEvent。

Graph 是预先声明、有界、无环、单活动路径的定义；TASK、REVIEW、DECISION 使用同一状态机。DECISION 根据已有 JSON Artifact 的字段与声明规则确定分支，零模型/Jev 调用；不匹配或多个匹配时等待处理，不猜测分支。REVIEW 必须通过 Zod 验证 PASS/REVISE/FAIL、bounded findings/evidence/summary 与实际 input Artifact IDs；不保存隐藏推理。

Definition/Version/产物/回执/分支/检查点/事件不可修改或删除；Run/Step 状态按 domain transition + SQLite CAS/trigger 修改。Renderer 仅有方法级 IPC，没有 graph 发布、SQL 或任意 state setter。

## R4 与 Mission 集成

`WorkflowService → WorkflowMissionPort → RoutingMissionService → 原 SOLO/Party/Human Bridge`。没有新增 Agent Runtime、ModelGateway、Permission、工具或 ExternalWork 执行系统。每个 StepRun 最多绑定一个 Mission identity；同 Mission 的显式 Retry 建立新 MissionRun，Step Retry 建立新的 StepRun/Mission，保留旧 attempt/Artifact。

R4 收到 objective、requiredCapabilities、executionConstraint、inputArtifactMetadata、expectedOutputContract 与 opaque executionContext。路由 receipt 不包含输入产物正文；执行约定只在 Mission 创建边界加入。现有 Mission/Party Runtime 加载本 Run 声明绑定的 bounded public Artifact，以 assistant 的 untrusted data report 提供，不提升为 user/system 指令。不读取其他道友 Memory、Chat、文件正文或 Tool output；普通 Chat 不接入此上下文。

R4 Mission/assignment/event/audit 与 Step→Mission 绑定通过同一 SQLite connection、同一事务提交。规划期间崩溃最多遗留审计 receipt，不会创建没有 Step 绑定的 Mission；并发绑定冲突使 Mission 创建事务回滚。fixed model、Benchmark-only、Availability、Jev advisory、Permission 与每成员 Memory/Skill authority 保持。

## 完成事务与恢复

Mission 先独立持久化终态。Workflow 再从精确当前 MissionRun 采集公开 final result；required output 必须通过冻结版本的 deterministic validator、Review/exit 条件，之后一次事务提交 Artifact、验证、OUTPUT Binding、声明分支、checkpoint、Step COMPLETED 与下一 Step READY。校验失败不会推进，即使模型声称已完成。

W1 提供 inline 文本长度/章节、JSON 必需字段及外部文件 metadata/hash 校验，不实现 W2 Artifact Contract Registry。当前 Main 输出采集支持 Mission TEXT/JSON、用户 ACCEPT 的 Human Bridge FILE；其他 Artifact kind 留在领域/port 中，但缺少可验证来源时 fail closed。外部文件必须在绑定时的 Workspace Root 重新 canonical/no-follow 检查并计算实际字节 SHA-256；manifest hash 明确是 W1 验证时点，不冒充 R2 提交时已保存的内容哈希。文件正文不复制进模型。

启动先执行原 Mission/ExternalWork 恢复，再 reconcile Workflow：

- COMPLETED Step 不重跑，不重复生成 Artifact/checkpoint。
- 原 Mission 的 WAITING_APPROVAL、WAITING_COLLABORATION、WAITING_EXTERNAL_WORK、PAUSED 保持绑定。
- Mission 已 COMPLETED 时补做确定性验证及原子提交，不重新调用模型。
- RUNNING 已被原恢复转为 INTERRUPTED 时，Workflow 等待 USER_CONFIRMATION；没有自动 retry 或 token stream 重放。
- 无 Mission 绑定的中断规划等待用户显式 Step Retry。
- 运行结果/副作用未知时等待用户处理；声明 Workspace/external side effect 而没有可核验交付时不因模型声明提交成功。

暂停只暂停 orchestration，不隐式修改原 Mission；审批/交付在原流程完成后，由继续/同步命令检查事实。重试必须用户主动确认。

## AP-007 compatibility

冻结版本保存 Artifact key、contractId/contractVersion、validator、effectType、Reference Basis metadata；Edge 有声明 branch 与 future revisionCode 扩展点，W1 拒绝实际 revision traversal。未来 Registry 可复用 Main publish port 注册同一 Version 模型。没有 OperationReceipt 执行流程、Revision Group/loop、W2 Contract Registry、BuiltinWorkflowRegistry 实现或模板。

## UI

历练中心增加自由历练/工作流历练切换。基础运行页提供已注册版本启动、历史/步骤/原 Mission 链接、输入输出、等待原因、显式 retry/resume/cancel，详细验证、checkpoint 与事件可展开。完成的 Step 没有重跑入口。生产包没有预置定义；Definition authoring/注册面向 Main application port，用户编辑器留待后续阶段。验收夹具仅在显式 test flag 下注册，正常启动没有测试定义或官方模板死入口。

## 验证记录

验收日期：2026-10-01。新增 39 项确定性测试；全量共 55 文件、440 项。覆盖 domain transition/graph bounds、immutable version/run pin、TASK→REVIEW→DECISION、declared branch、Artifact provenance/lineage、验证失败不推进、checkpoint 事务回滚、真实 WorkflowService + SQLite 完成事务、Mission 创建与 Step binding 同事务回滚、Retry 保留旧事实、attempt limit、并发 advance、审批/外部交付重绑、启动零重放及 typed IPC sender/input boundary。

| 命令                    | 最终结果                                               |
| ----------------------- | ------------------------------------------------------ |
| `npm run test`          | 55 文件、440 项全部通过                                |
| `npm run typecheck`     | 通过                                                   |
| `npm run lint`          | 通过                                                   |
| `npm run format:check`  | 通过                                                   |
| `npm run package`       | Windows x64 / Electron 44.4.3；native dependencies 1/1 |
| `npm run smoke:package` | Gate 0–6、R0–R4 与 W1 全量真实 packaged 回归通过       |

[Packaged evidence](../evidence/w1-foundation/README.md) 提交四张原始截图、三尺寸布局数据和 SQLite manifest。真实 UI 创建固定版本运行并完成 TASK→REVIEW→DECISION；Party Step 继续原 collaboration approval，成员 Usage 归属独立 sealed Runtime。本尊 Step 在 WAITING_EXTERNAL_WORK 重启后提交/ACCEPT Workspace 文件，原 MissionRun 完成并核验真实内容 hash。Tool approval 同 Run 重启后恢复；Step retry 保留旧 Artifact。

强制关闭覆盖 Mission terminal→Step commit 前、model.call_started→result 前两个窗口：前者仅补做 deterministic validation/checkpoint，后者进入 USER_CONFIRMATION；均没有重新调用模型或工具。再次重启 Artifact/checkpoint 不重复。页面在 1440/1180/900 窗口可滚动、无页面横向溢出，并人工检查原始截图。旧 R3.3 35 张 UI 及原安全回归全部通过。

产物：`out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`，SHA-256 `CCD140601BECDDEBE1869AE0F8A7C73319688676AA7C2471A6D5E171ADE0AE7E`。exe、测试 profile 和缓存未提交。所有本轮临时目录均在项目内；短路径 R: 临时映射在构建后移除。无新增依赖。验证使用 Fake fixture 与旧 Provider SDK 本地 HTTP fixture，不宣称外网收费 API 联调。

整合过程中修正 smoke 的旧导航标识/label，并将旧阶段“最新 schema 总数”断言由 16 同步为 17；不修改其业务测试断言或任何历史 migration。最终六项以上表为准。

## W1 corrective repair：I/O contract 与版本语义

修复基线 `main@06b122829013fd0af0bf2a42cefecc24a1798fdd`，验收日期 2026-10-01。新增 `0018_w1_workflow_io.sql`；0001–0017 完全不改。没有新增依赖。

### 冻结输入与最终输出

Version 正式支持 `inputSchema` 和 `outputSchema`。W1 使用 closed、bounded 的声明式 schema subset：string、number/integer、boolean、enum、array、object、ISO date/dateRange 和 opaque ArtifactRef metadata。禁止未知字段、类型强制转换、默认补值、任意表达式或路径权限。集中策略 `w1-io-v1` 限制 schema 深度 4、object 字段 16、array 项 20、string 长度 4000、Run 输入 32768 UTF-8 bytes、单 Step 输入 8000 UTF-8 bytes。不是完整 JSON Schema，也没有文件导入流程。

`createRun` 在写入任何 Run/Step 前按冻结版本校验 `inputs`，持久化独立 `input_snapshot_json`。repository 再验证，SQLite UPDATE trigger 禁止改写；typed IPC 仅提供创建入口，没有修改 snapshot 或任意状态入口。Renderer 显示 schema-driven 外部 Label 表单与只读快照。旧无输入 Version 等价于空 closed schema，旧 Run 升级获得 `{}`，继续正常运行。

Step 必须通过 `workflowInputKeys` 明确声明可见字段；默认看不到任何 Workflow Input。原始输入只进入 bounded assistant untrusted data report，不做模板插值，不放入 system/user instruction、Mission objective 或 R4 routing context。ArtifactRef 仅有 id/kind/name/contentHash 元数据，不查找文件或获得读取、Permission、状态修改 authority。

`outputSchema.outputs` 指向冻结版本明确声明的 Step/outputKey，可指定 required 和独立的最终 validator。所有 Step 完成后重新验证最新 attempt 的真实 Artifact、Step validation、Mission/Run provenance 与 final validator；失败时 Run 保持 WAITING/USER_CONFIRMATION，不因模型声称完成而推进。final receipt 与 Run 完成同事务提交。新增 append-only `workflow_run_output_validations` 保存 input/state hash、精确 output bindings 和错误；SQL 完成 guard 要求 valid receipt，验证当前 producer/MissionRun/hash，禁止缺失 required final output。final contract 与 producer Step contract 可以不同。重复 reconcile/restart 不重复生成相同 receipt，不重放模型/工具。既有 COMPLETED Run 不回填或重跑。

### Version 演进

Definition ID/source 保持稳定；每个 `(definitionId, version)` 完全 immutable。name/description/category、I/O schema、Reference Basis metadata、Step Graph 在新 Version 中可合法变更，旧 Run 永远读取自己的 pinned version。原 `workflow_definitions` 保留 bootstrap metadata，不作为所有版本的展示真相；版本化 metadata 从 `version_json` 读取。旧 Version UPDATE/DELETE、相同版本改内容及跨版本改 source 仍拒绝。

### 本轮完整验证

新增 29 项测试，总计 57 文件、469 项全部通过。覆盖 missing/unknown、enum/range/array bounds、日期与 opaque reference、snapshot immutable/restart、Step allowlist、Renderer/IPC 边界、final output 不满足不完成、真实 SQLite receipt guard、v1 Run 启动后发布 v2、版本化 metadata/I-O/graph、旧 Version UPDATE/DELETE 与旧 W1/Gate 0–6/R0–R4 全量回归。

| 命令                    | 结果                                                   |
| ----------------------- | ------------------------------------------------------ |
| `npm run test`          | 57 文件、469 项通过                                    |
| `npm run typecheck`     | 通过                                                   |
| `npm run lint`          | 通过                                                   |
| `npm run format:check`  | 通过                                                   |
| `npm run package`       | Windows x64 / Electron 44.4.3；native dependencies 1/1 |
| `npm run smoke:package` | Gate 0–6、R0–R4、W1 全量真实 packaged 通过             |

[本轮 packaged evidence](../evidence/w1-corrective-io/README.md) 包含六张截图、三尺寸布局与 SQLite I/O facts。UI 实际提交输入，验证 malicious data role、未声明字段隔离、v1 frozen snapshot、Renderer mutation/DB trigger、最终校验失败和重启幂等。原 Party/Tool/Human Bridge 审批同 Run 恢复及两处 crash zero replay 再次通过。首次专项 smoke 的历史列表取第一项假设已修成按 definition/version 找当前 Run，随后专项和完整 smoke 均通过。

Package exe SHA-256：`ED9AEE90E5BF8696A6CE83EB8E7E17423899552892147E562AF974435818A394`。所有本轮 profile/缓存/worktree 在项目内；构建的 R: 临时映射已解除。测试环境曾被子代理误用 pnpm 移动部分原依赖目录，已逐个恢复原位置；未安装/升级依赖，package.json/lockfile 无变化。旧阶段 schema 总数断言同步为 18，不修改业务断言或历史 migration。

## 明确未实现

无 Built-in Workflow、用户编辑器、Import Existing Work、SUBWORKFLOW、并行 DAG、任意循环、Revision Group、W2 Artifact Contract Registry、R5 Harness optimization 或动态生成节点。没有新的 Agent 能力、Runtime switch、动态 Capability/评价、Realm 晋级或自动副作用重放。没有新增依赖。
