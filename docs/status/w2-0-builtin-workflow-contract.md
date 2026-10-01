# W2.0 — Built-in Workflow Contract

## 范围与依据

基线 `main@cd1f33774bb35f818b653e7eb1f214b5ea50e461`。AP-006 保持总体 Roadmap 和既有边界；原样纳入 AP-007 v1.1，作为 W2 正式详细规格，替代旧三个预置 Workflow 定义。本轮仅 Contract/Foundation，不发布 AI 资讯视频、软件功能开发或科研模板。

## Contract 与 Registry

新增 `0019_w2_builtin_workflow_contract.sql`，不修改 0001–0018。增加 immutable Artifact Contract Registry、BUILTIN release fact、有界 revision traversal、Operation Receipt 与 append-only lifecycle audit，并补充实际 filesystem Artifact 的来源防线。

`BuiltinWorkflowRegistry` 正常环境为空。测试 package 和 registry 必须分别声明 test-only。应用 publish 拒绝普通模板获取 BUILTIN 身份；Main 可信注册先验证 Reference Basis、adopted principles、excluded mechanisms、Design Rationale、精确 Contract/Revision/Effect manifests 和 canonical release hash。

`ArtifactContractRegistry` 按 `contractId + contractVersion` 冻结。TEXT 使用长度/章节规则；JSON 使用封闭、有界结构 schema；FILE 检查 canonical inspection metadata/extension/media type/hash；DIRECTORY 和 WORKSPACE 检查有界 path/size/hash manifest。Validator 版本固定 `w2-deterministic-v1`，未知解释器版本 fail closed。回执记录 contract/version、validator version 与 Artifact content hash；真实文件 bytes hash 单独保存，不能与 metadata envelope hash 混淆。

Run 固定 Definition Version 内的 Contract manifest；新增 Contract version 不改变旧 Run。旧 W1 inline validators 和输入快照、最终输出 projection、版本语义保持，不追溯改写旧事实。

## 有界修订与 REVIEW

普通边仍是 DAG；只对显式声明、目标经普通路径能返回 source 的 Revision Edge 放宽。REVIEW 的多个 REVISE 目标必须有唯一 revisionCode enum，静态映射到声明 edge；DECISION 仍只根据已有 Artifact 的声明条件选择分支，不调用模型修改 Graph。

每条边与共享 Group 同时计数。Decision、Traversal、Checkpoint、旧 Step 完成及新 attempt 创建在同一事务提交；事务失败无计数，restart 不重复提交。达到任一预算后按 Group policy 进入等待用户或 FAILED。W1 每 Step 最多 5 attempts 的独立硬上限仍保留，不构建通用循环或无限重试。旧 Artifact/Mission/attempt 全部保留，新输入绑定到最新完成 attempt。

## 副作用与恢复

TASK/REVIEW 在原 Mission 创建前持久化 PREPARED 与输入 hash；FILE/WORKSPACE 记录冻结 relative effect paths 和可获得的 before hash。路径声明不等于权限；实际操作仍走 R4 → Mission/Party/Human Bridge → Permission/Approval → ToolRuntime。

Main 只检查文件，不另建写入引擎。现有 FileWorkspace 的临时文件/atomic rename 保持；Workflow 在真正 Tool 成功后执行冻结 contract 校验。同 Run 的成功 FILE_WRITE exact resource、实际 actor、canonical root 和 bytes hash 才能形成文件结果；聚合 manifest 保留各文件的来源。模型声称“已写入”不构成事实。

`PREPARED → APPLIED → VERIFIED`；不能确认则 `UNKNOWN`。APPLIED evidence 冻结，VERIFIED/UNKNOWN 不可重放；audit 自动追加 lifecycle 快照。Artifact/验证/VERIFIED/binding/checkpoint/Step COMPLETED 同事务。APPLIED crash 后重新核对已有文件/Workspace 与 after hash，零模型/工具重放；结果变动或外部动作无可验证 ACCEPTED fact，停在 UNKNOWN/等待用户。Human Bridge 复用原 ACCEPTED artifact 与 durable continuation。

显式 Step Retry 保留旧 receipt/artifact/Mission，新建 attempt，并显示重复副作用风险确认。UNKNOWN 原 Mission 不可直接 retry；不会自动 graph rewind。正式外部动作连接器、目录递归操作和三个模板的专有产物规则未实现。

## 验证证据

2026-10-02，Windows x64，Electron 44.4.3。最终完整回归为 **61 个文件 / 529 项测试全部通过**（基线 490，本轮新增 39）。新增测试分布：Contract/Release 14、SQLite 9、application/SQLite harness 9、canonical filesystem 7。

| 验证命令                | 结果                             |
| ----------------------- | -------------------------------- |
| `npm run test`          | PASS，529/529                    |
| `npm run typecheck`     | PASS                             |
| `npm run lint`          | PASS                             |
| `npm run format:check`  | PASS，包含整理后的 JSON evidence |
| `npm run package`       | PASS，Windows x64/native SQLite  |
| `npm run smoke:package` | PASS，Gate 0–6、R0–R4、W1、W2.0  |

| Acceptance                                                                      | 证据                                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Contract 不可变、Run 固定版本、deterministic JSON/TEXT/FILE/DIRECTORY/WORKSPACE | Contract tests + SQLite tests；真实 package 的 JSON/FILE/WORKSPACE 回执                                                                 |
| BUILTIN 身份与 release metadata                                                 | 普通 publish 拒绝、可信 release fact/manifest hash、test-only opt-in；正常 fresh production 启动 versions 为 `[]`                       |
| edge + shared group budget                                                      | 两条不同 REVISE 边各提交一次，共享 Group 达 2 后等待；SQLite 拒绝超限                                                                   |
| transition commit / restart 幂等                                                | 注入 checkpoint failure 整体回滚；未提交 traversal 为 0，恢复只提交一次                                                                 |
| revisionCode / graph authority                                                  | 未声明 code、自由目标、普通 cycle 被拒绝；只允许冻结边                                                                                  |
| FILE_OUTPUT APPLIED crash                                                       | permission-gated file.writeText → 原 Mission terminal → APPLIED 后真实终止进程 → 原 Run 恢复 VERIFIED/COMPLETED，模型调用数和文件不增加 |
| WORKSPACE_MUTATION APPLIED crash                                                | 实际 before/after hash、成功 Tool resource/actor → DIRECTORY Artifact +冻结 WORKSPACE manifest PASS；恢复不重写 Workspace、不调用模型   |
| EXTERNAL_ACTION 不确定                                                          | 模型完成声明不能代替 ACCEPTED fact，receipt UNKNOWN、Workflow 等待用户；重启零新增调用                                                  |
| receipt/empty manifest 幂等                                                     | PREPARED/APPLIED/VERIFIED/UNKNOWN lifecycle；持久化 `[]` 不被改成 NULL；重复重启 audit/traversal 数量不增加                             |
| W1/R4/Mission/Party/Human Bridge                                                | 原版本/输入快照/最终 projection/lineage/Retry/restart 回归；完整 Windows package 继续完成旧 SOLO/Party/外部交付与安全 smoke             |
| Renderer/IPC                                                                    | 原方法级 typed IPC；真实 UI 能读取冻结回执、VERIFIED 状态与等待结果，没有新增发布/SQL/state setter                                      |

提交的 evidence 位于 [目录](../evidence/w2-0-builtin-workflow-contract/)：运行界面、VERIFIED operation 界面、`w2-facts.json`（fixture public facts、Contract/release hash、validation、actor lineage、operation audit 和 traversal）。使用项目内独立 userData/Workspace，真实 Windows packaged exe；没有真实 API Key，也没有提交 SQLite、Credential 或用户 profile。界面截图已实际查看。

本地产物为 `out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`；完整原始 profile/evidence 保留在 `.test-data`，不纳入 Git。所有本轮临时目录和缓存位于项目内，未清理既有目录。AP-007 原文 SHA-256：`BDB8E48721959E7E6438551E5B9D49EE012858047EA1CECF4B3A762C872BC2C2`。

## 已知限制

- JSON 使用 W1 的封闭、有界 schema subset，不执行用户代码/表达式；未知 validator version 拒绝解释。
- FILE 最大 10 MB，manifest 内容最大 1 MB，effect paths 最多 32；实际输出还受冻结 Contract、Metadata 与旧 Tool 大小限制约束。Workspace hash 是验证时点的事实，不保证用户之后不会修改文件。
- 每 Step 独立最多 5 attempts；共享 Group 有预算也不能绕过该上限。用户 Retry 不重置同 Run 的 revision 计数。
- EXTERNAL_ACTION 目前只能复用可证明的 Human Bridge ACCEPTED 交付；没有新增外部动作执行器。未知结果不提供强制 VERIFIED 或自动重放接口。
- 仅验证 test-only release package；未来正式模板仍需独立 Reference Basis 人工审查与审批。

## 明确未实现

没有三个正式模板、Builtin 编辑器、Import Existing Work、SUBWORKFLOW、并行 DAG、通用循环、动态节点或 R5 Harness Optimization。没有改变 fixed model、Benchmark-only、Availability、Jev advisory、Permission、Memory isolation、Tool/MCP transcript、Human Bridge continuation、Party/Mission 状态机和 typed IPC 安全边界。未新增依赖。
