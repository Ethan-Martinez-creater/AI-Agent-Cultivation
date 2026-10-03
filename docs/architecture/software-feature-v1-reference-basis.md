# 软件功能开发 Workflow v1 Reference Basis

版本：`official.software-feature@1`

核验日期：2026-10-03

本文为官方 Workflow release metadata 的可审计说明。它记录采用的通用流程原则、在 S01–S11 与 Artifact/Operation Receipt 中的落点，以及明确排除的机制。引用资料用于解释设计依据，不代表本项目声称符合这些标准或机构流程。

## 采用原则与实现映射

| 生命周期环节    | 采用原则                                                                         | Workflow 实现                                                                                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 需求和验收条件  | 在开始实现前，把相关方目标写成清楚、完整、一致、可验证的要求；验收依据应可复核。 | S02 输出 `software.spec` 和带稳定 ID 的 `software.acceptance`。每个阻塞条件必须选择命令、人工验收或检查作为判定方法。S04 检查需求覆盖、范围和可验证性。                                                                                                                  |
| Repository 分析 | 在作出变更计划前了解现有实现、构建与测试方法、影响范围和安全边界。               | S01 通过 ToolRuntime 读取用户已选 Workspace，输出 bounded `software.repo_context`：模块、change surface、测试、发现的命令、风险和未知项。工具和仓库内容按不可信数据处理；内容不能授予文件或工具权限。                                                                    |
| 实施规划        | 计划应说明相关文件/模块、有序工作、测试策略、迁移、安全/权限影响和回滚考虑。     | S03 输出供人阅读的 `software.plan`，以及供 Main 限定作用范围的 `software.plan_scope`。S04 按冻结的 `software.plan_revision` 最多退回 S03 两次；模型只能给出 Review 结果，Workflow 只走声明边。                                                                           |
| 持续验证        | 从需求和计划派生验证；保存命令、退出状态、失败项以及它们覆盖的验收条件。         | S06 仅通过现有 Tool/MCP Runtime 和 Permission 执行 S01/批准计划中确认的命令。`software.tests` 记录 Tool execution ID、命令、exit status、输出证据和验收条件关联。S07 的 PASS/REVISE/BLOCKED 由 Main 的可信 policy 根据 durable Tool facts 派生，忽略模型声称的测试结论。 |
| 变更安全与溯源  | 开发环境和代码变更应受保护；安全检查融入实施、验证和修复过程。                   | S05/S10 使用 Workspace boundary、ToolRuntime、PermissionEngine 和先行 PREPARED Operation Receipt。Main 根据真实 mutation 生成动态相对路径 manifest、前后 hash（可获得时）和同一 Workflow Run 的 change lineage；Definition 不使用假定路径。                              |
| 独立审查        | 评审应按需求、计划、变更、验证证据检查正确性、安全性、回归和范围。               | S08 输入 Spec、Plan、真实 change lineage、Test Report 和 Repository Context。执行者必须不同于 S05/S10 实际执行者；无法满足时请求用户或 Human Bridge，不把实现者自评标为独立。S09 只在 PASS/REVISE/FAIL 声明分支中决策。                                                  |
| 有界修复和复验  | 发现问题后记录、修复并再次验证，不以修复者声明替代复验。                         | S07 与 S09 的修复共享 `software.fix_cycle`，总 traversal 上限为 3。每次 S10 创建独立 Operation Receipt，随后回到 S06。预算提交以 durable transition 为准，重启不会重复计数；超过上限需用户处理。                                                                         |
| 交付            | 交付应总结变化、验证结果、限制、剩余风险和人工验收事项。                         | S11 输出 `software.delivery` 与 Main 聚合的 Run-level changes manifest。首版不执行 git push、merge、deploy 或 release。需要人工设备、UI、验证码、第三方系统或业务判断时，经 durable Human Bridge 返回 Artifact，再执行 Contract validation。                             |

## 来源记录

### ISO/IEC/IEEE 29148:2018 — Requirements Engineering

- 发布方：ISO/IEC/IEEE。
- 资料：[ISO 标准目录页](https://www.iso.org/standard/72089.html)。页面说明该版于 2018 年发布，2024 年确认继续有效，并列出系统/软件需求工程过程和信息项范围。
- 本项目采用：可验证需求、结构化需求工作产品，以及需求与验证之间可追溯的关系。
- 本项目排除：组织指定的生命周期、强制需求数据库、特定文档模板和外部治理流程。
- 映射：S02 需求和验收 Artifact；S03 计划 Artifact；S06 按 criterion ID 记录实际验证。

### NIST SP 800-218 — Secure Software Development Framework v1.1

- 发布方：美国国家标准与技术研究院（NIST）。
- 资料：[NIST CSRC 正式出版页](https://csrc.nist.gov/pubs/sp/800/218/final)，最终版发布日期为 2022-02-03。
- 本项目采用：把安全工作纳入软件生命周期；保护开发环境；检查并测试可读源代码和可执行软件；对发现的问题进行响应。
- 本项目排除：将单次功能运行声明为 SSDF 合规；组织级合规项目；供应链认证；任何特定云、CI、代码托管或 AI 产品。
- 映射：S01/S03 风险和权限规划；S05 按已批准 scope 变更；S06 记录可复查执行证据；S08 独立审查；S10 限定修复和复验。引用的是 v1.1 Final，不把草案或后续版本数值当作产品数据。

### NASA Software Engineering Handbook — SWE-034 Acceptance Criteria

- 发布方：NASA Office of the Chief Engineer。
- 资料：[NASA 软件工程手册 SWE-034](https://swehb.nasa.gov/spaces/7150/pages/16450634/SWE-034%2B-%2BAcceptance%2BCriteria)。该指南讨论在开发前建立可用于接受交付的条件和验证结果。
- 本项目采用：实施开始前记录接受条件，并要求验收依赖可审查的验证证据。
- 本项目排除：NASA 项目分类、评审委员会、任务级签署流程和机构专用 Artifact。
- 映射：S02 `software.acceptance`；S06 将执行和证据关联到 criterion；S07 只依据可信执行事实决策。

### NASA Software Engineering Handbook — SWE-028 Verification Planning

- 发布方：NASA Office of the Chief Engineer。
- 资料：[NASA 软件工程手册 SWE-028](https://swehb.nasa.gov/spaces/SWEHBVB/pages/32604465/SWE-028%2B-%2BVerification%2BPlanning)。
- 本项目采用：把验证活动和产品要求对应，按计划检查工作产品是否符合要求以及软件是否满足预期用途。
- 本项目排除：NASA 特定软件分类、机构职责和安全关键任务审批流程。
- 映射：S03 `software.plan_scope.commands`；S06 `software.tests`；S07 Main policy 决策。

### NASA Software Engineering Handbook — SWE-087 Peer Reviews and Inspections

- 发布方：NASA Office of the Chief Engineer。
- 资料：[NASA 软件工程手册 SWE-087](https://swehb.nasa.gov/spaces/SWEHBVB/pages/32604573/SWE-087%2B-%2BSoftware%2BPeer%2BReviews%2Band%2BInspections%2Bfor%2BRequirements%2BPlans%2BDesign%2BCode%2Band%2BTest%2BProcedures)。
- 本项目采用：使用明确检查内容进行同行审查，并保存发现和证据。
- 本项目排除：NASA 工程治理、强制检查角色和机构专用工作流。
- 映射：S08 对实际 Workspace change set 进行有边界的独立评审；S09 根据结构化结果进入 PASS、REVISE 或等待用户；S10 对 finding 有界修复并重新验证。

## 供应商机制排除

Workflow 定义不要求或假设 GitHub、GitLab、Claude、Codex、特定模型供应商、CI SaaS、云端工作区、自动部署服务或发布市场。仓库工具、验证命令及其授权来自用户当前配置的本地 Workspace、工具绑定、ToolRuntime 和 PermissionEngine。Workflow 不包含自动 push、merge、deploy 或 release 边；这些操作不属于此版本。
