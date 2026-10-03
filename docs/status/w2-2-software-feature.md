# W2.2 — 软件功能开发 Official Built-in Workflow

## 范围与架构

以 AP-007 v1.1 为正式规格；AP-006 保留总体边界。新增 `official.software-feature@1`，通过 OFFICIAL Registry 与事务 installer 安装。用户界面展示理解、规划、开发、验证、审查、交付六阶段，S01–S11 与 Contract/Receipt/Hash 在 Advanced。

- 复用 W1/W2 Definition、冻结 Version、Run input snapshot、Artifact lineage、Checkpoint、Revision 与 Operation Receipt。
- TASK/REVIEW 继续走 R4 → 既有 Mission/Party/Human Bridge。未建立另一套模型、Tool、Permission 或状态机。
- `software-integrity-v1` 通过可信 `WorkflowValidationPolicyRegistry` 注册；Renderer 没有 policy、Contract 或 BUILTIN 注册入口。
- 保留 fixed binding、Benchmark-only、Availability、Memory scope 与 Jev bounded advisory。
- 未实现 W2.3、G1/G2/G3、GenerationGateway、GenerationJob、MiniMax H3、Workflow 编辑器或自动发布。

## 正式 Contracts 与分支

Version 1 冻结 `software.repo_context/spec/acceptance/plan/plan_scope/changes/tests/review/fix/delivery`。

- S01–S03：仓库上下文、需求/验收项、实施方案与结构化允许路径/命令。
- S04：独立于方案作者的审查候选；REVISE → S03，`software.plan_revision` 总预算 2。
- S05/S10：动态 WORKSPACE_MUTATION；每次 attempt 有独立 Operation Receipt。
- S06：用户确认的 Tool scope + Repo/已审查 Plan command；真实 Tool/MCP execution fact 记录命令、状态、验收项和输出哈希。
- S07：确定性派生 PASS / REVISE / BLOCKED。模型自报成功不能替代持久化执行与验收证据。
- S08：排除所有实际实现/修复 actor；没有独立候选时保持用户动作或本尊交付流程。
- S09：PASS → S11、REVISE → S10、FAIL → WAITING_USER。
- S07/S09 共用 `software.fix_cycle` 总预算 3；S10 回 S06 重新验证。
- S11：真实 Run mutation lineage 的最终 manifest + delivery summary；不 push/merge/deploy/release。

## Migration 与恢复

仅追加 `0022_w22_software_feature.sql`，0001–0021 不变。

新增 path-specific mutation journal 与 append-only verification facts。动态路径由可信 Main 从真实 Tool execution 收集，不使用虚构固定 effectPaths：

1. PermissionEngine/Approval 通过后，确认当前 Workspace、已审查 plan scope、当前 MissionRun。
2. 在修改前持久化 PREPARED，记录实际 relativePath、before hash 与预计 after hash。
3. 既有 FileWorkspace/ToolRuntime 执行写入后读取实际哈希，记录 APPLIED 或 UNKNOWN。
4. Step 完成前重新检查当前文件、同 Run Tool event、Contract、exit 与 receipt。
5. APPLIED 后崩溃仅验证既有状态；未确定结果等待用户，不静默重做。S11 聚合同 Run 实际修改链，保留各 actor/event provenance。

未引入任意 Shell。MCP verification 仍是用户手动配置的 stdio server，经过既有 Permission/Approval。当前动态变更仅支持受控 `file.writeText`，MCP 任意 Workspace mutation fail closed；目录需用户预先准备，删除操作不在本版范围。

验证 MCP 需要接收已确认的 `commandId / command / acceptanceCriterionIds`，并提供 bounded `structuredContent.workflowEvidence.verification`。Main 将其规范化为 append-only verification fact；只有同时匹配真实 `tool.result` 的 actor、MissionRun、Tool call ID 和输出 hash 才是有效证据。无需 cultivation 自定义 discovery metadata；无可用验证工具或人工验收项时使用现有 Human Bridge。

为避免不可变 Run 缺失写入授权范围，本版启动表单要求明确填写 `targetArea` 和 `allowedToolScope`，不从 objective 猜测范围，也不将这些输入当成 Permission grant。这比 AP-007 可选输入建议更严格；constraints、人工验收要求和受限参考 Artifact metadata 仍可选。

## 验证证据

确定性回归：80 个测试文件、665 项测试通过。覆盖 OFFICIAL canonical manifest、合同/版本冻结、静态 revision group、independent reviewer hard filter、真实 mutation 前 PREPARED、DENY/ASK、计划外路径与 junction escape、APPLIED/hash 恢复、伪造 verification 拒绝、实际 SQL provenance trigger、append-only verification facts，以及 Gate 0–6/R0–R4/W1/W2 全量旧测试。

| Acceptance                      | 真实执行与验证                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A：小型 bug fix                 | Renderer 表单创建；S04 打回 S03 一次；S05 写入后真实命令失败；S07 → S10 → S06；S08 finding → S09 → S10 → S06；最终独立审查与交付。plan traversal=1，shared fix traversal=2。 |
| B：带 migration 的功能          | 受控新建 SQL migration，MCP 固定 verifier 实际执行该 SQL 并验证 insert/query，保留创建前无文件与写入后 hash。                                                                |
| C：Renderer + IPC + persistence | 三个相对路径均通过独立 FILE_WRITE 审批、真实写入、模块加载验证与独立审查；最终 change set 与实际文件 hash 一致。                                                             |
| Mutation crash                  | S05 Mission terminal、Operation Receipt APPLIED 后强制退出；重新启动核对原 Mission 的模型/Tool event 数量和文件 hash 不变，再完成既有结果校验。                              |
| Independent review              | 两名 sealed MODEL_RUNTIME 道友具有独立 Runtime/Provider；每次 S08 的 actor 不在任何实际 S05/S10 actor 集合中。                                                               |
| Restart                         | 已完成案例重启后 model call、mutation journal、checkpoint 数量全部不变；不重跑 completed Step。                                                                              |
| Authority                       | Workspace/Permission/Tool Runtime 原链路保留；DENY 无写入，越界路径与 junction 拒绝；无自动 push/merge/deploy/release。                                                      |

所有自动验收使用离线 FakeModelGateway 与普通 stdio MCP fixture。fixture 的 verifier 只运行预先放入测试 Workspace 的固定 `node verify.mjs`，使用 `execFile` 且 `shell=false`；它不是产品新增 Shell Tool。

### 六项结果（2026-10-03）

| 命令                                            | 结果                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `npm run test -- --reporter=dot --maxWorkers=4` | PASS：80 files / 665 tests，含全部旧 Gate/Routing/Workflow 回归。 |
| `npm run typecheck`                             | PASS                                                              |
| `npm run lint`                                  | PASS                                                              |
| `npm run format:check`                          | PASS                                                              |
| `npm run package`                               | PASS：Windows x64、Electron 44.4.3、native SQLite。               |
| `npm run smoke:package`                         | PASS：Gate 0–6、R0–R4、W1/W2.0、Product UI、W2.1、W2.2 全套。     |

最终日志位于项目 `.tmp/w22-test-final.log`、`w22-typecheck-final.log`、`w22-lint-final.log`、`w22-format-check-final.log`、`w22-package-final.log`、`w22-smoke-full.log`。额外 W2.2 evidence 复验日志为 `.tmp/w22-evidence-final.log`。

Windows package：`out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`。新增依赖：无。

### Packaged evidence

- 最终三案例截图与 `w22-facts.json`：`.test-data/w22-packaged-75d0e09e-8cbc-45b3-8433-dcbc59e4a124/evidence/`。
- 全量套件中的 W2.2 evidence：`.test-data/w22-packaged-1d07dda7-6cc9-482a-bd07-3228788ec926/evidence/`。
- 旧 W2 foundation/revision/Operation Receipt evidence：`.test-data/w2-packaged-8cdbbce1-03c3-411c-a12a-b653d40d0dbc/evidence/`。
- W2.1 三案例/Human Bridge/restart evidence：`.test-data/w21-packaged-45c79b15-a0b1-42a9-819c-872a96afbbe8/evidence/`。
- Product UI：`.test-data/ui-product-system-3012cf4d-cc1d-4677-b23b-424db02a38e0/`，83 张截图，1440/1180/900。

`w22-facts.json` 记录每个 Run/Step attempt、审批、revision traversal、真实 actor、mutation journal、S11 change manifest 和命令执行事实。A 的实际命令退出状态为 `[1,0,0]`，B/C 为 `[0]`；每条 verification fact 都直接匹配持久化 `tool.result` 的 tool-call ID、actor、MissionRun 与输出 hash。APPLIED crash 前后事件计数与文件 hash 相同，已完成 Run 重启的 model/mutation/checkpoint 计数相同，发布操作为 0。

验收过程中发现并修正两项 fixture/integration 问题：S06 SQL trigger 对 `json_each` 文本项使用 `criterion.type`；Windows crash fixture 等待实际 WAL checkpoint 可写后再注入下一窗口。后者仅处理强制退出后的短暂文件句柄释放，不重新执行应用、模型或 Tool。

证据与测试 profile 全部保存在当前项目目录，未新增 C 盘测试数据、仓库外工作区或运行依赖。

Reference Basis：[software-feature-v1-reference-basis](../architecture/software-feature-v1-reference-basis.md)。采用需求追踪、仓库分析、可验证验收、独立审查、有界修复/重验原则；不绑定厂商运行时、源码托管或 CI SaaS。
