# V1 工程验证归档索引

Windows 检出本分支时，证据目录可能超过默认路径长度；使用 Git 原生的单次 `-c core.longpaths=true` 参数。归档未改动全局 Git 配置，也未改名或截断历史证据路径。

归档分支：`engineering-validation/v1`。冻结生产基线：`main@a2551bbc9dbd87ec4701183a53a2635966326df4`。本索引只说明证据入口与当前认可状态，不改写历史报告，也不授予新的真实调用或进程终止权限。

| 阶段 | 当前认可状态 | 入口 |
|---|---|---|
| E0 v0.1 / v0.2 | v0.2 设计冻结；Gold **PROVISIONAL / INDEPENDENT_REVIEW_PENDING** | [v0.1 历史设计](../AI_Agent_Cultivation_V1_E0_Evaluation_Design.md)、[v0.2 冻结设计](../AI_Agent_Cultivation_V1_E0_Evaluation_Design_v0.2.md) |
| E1 Feasibility / Closure | 10 PASS、2 BLOCKED；Gold 复核与 Jev 真实成本/单次提交合同仍未通过 | [可行性审查](../evidence/v1-engineering-validation/publication/redacted/docs/AI_Agent_Cultivation_V1_E1_Feasibility_Review.md)、[Closure 审查](../evidence/v1-engineering-validation/publication/redacted/docs/AI_Agent_Cultivation_V1_E1_Closure_Preflight_Review.md) |
| E3 历史 | 原 CR-A BLOCKED；CR-B PASS；旧 Overall E3_CONDITIONAL | [历史报告](../evidence/v1-engineering-validation/publication/redacted/docs/status/v1-engineering-validation-e3.md) |
| E3 CR-A Corrective | 报告级 PASS；新隔离 Run，一次 Main 强杀、两次重启和显式继续 | [Corrective 详细报告](../evidence/v1-engineering-validation/publication/redacted/docs/status/v1-engineering-validation-e3-cr-a-corrective.md) |
| E3 Historical CR-B | PASS；一次强杀、两次重启；UNKNOWN 不自动重发 | [历史恢复断言](../evidence/v1-engineering-validation/e3/recovery-invariants.json) |
| E3 Overall | 报告级 PASS；公开证据归档后仍需终审 | [最终汇总](../evidence/v1-engineering-validation/publication/redacted/docs/status/v1-engineering-validation-e3-final.md)、[英文案例](../evidence/v1-engineering-validation/publication/redacted/docs/status/workflow-crash-recovery-case-study-final.md) |
| E2 Jev Live | **NOT_RUN / 未授权**；授权及成本合同仍阻塞 | 不执行真实 Jev，不推断成本或 Live 提升 |

E0 包含 30 Case、15 Live Case、91 question；TO-09 非 Live；Memory 仅为 RERANK_ONLY。Synthetic Tool Fixture 不代表正式产品 Tool。[数据核验](../evidence/v1-engineering-validation/publication/redacted/docs/evidence/v1-engineering-validation/preflight/input-dataset-integrity.json) 与 [Gold 待复核记录](../evidence/v1-engineering-validation/publication/redacted/docs/evidence/v1-engineering-validation/preflight/gold-review-pending.md)。

三个冻结 Hash（提取时不添加末尾换行、不格式化）：

| 对象 | SHA-256 |
|---|---|
| E0 v0.2 Markdown | `2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c` |
| [Canonical Dataset](../evidence/v1-engineering-validation/publication/e0/canonical-dataset.json) | `ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602` |
| [ToolFixtureMapping](../evidence/v1-engineering-validation/publication/e0/tool-fixture-mapping.tsv) | `04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62` |

真实调用、模拟与打包运行的边界：E1 selector/rank/registry 使用生产离线组件与合成输入；metrics 是合成测试；Jev transport 为 loopback 17 场景，没有真实 Provider/计费。E3 使用既有 Windows packaged 二进制、真实 Workflow/SQLite 状态及隔离工作区，模型侧为离线 fixture，不代表真实 Jev Live。未公开 EXE/app.asar、Profile、原始 SQLite/WAL/SHM。

六项标准命令的**历史真实状态**（本次仅归档，未重跑全套）：

| 命令 | E1 Closure | E3 Corrective |
|---|---|---|
| npm run test | PASS，165 files / 1521 tests | PASS，165 files / 1521 tests |
| npm run typecheck | PASS | PASS |
| npm run lint | FAIL，private 清理脚本既有 10 errors | FAIL，同类既有 10 errors |
| npm run format:check | FAIL，3 文档 | FAIL，25 文件；包括新 Controller/snapshots/types 的格式欠项 |
| npm run package | FAIL，MSBuild 长路径；中断/取消尝试另有原始日志 | NOT_RUN，复用已核验既有包 |
| npm run smoke:package | BLOCKED / NOT_RUN，正式强杀未在 E1 执行 | BLOCKED / NOT_RUN，旧完整链身份核验与额外强杀不在授权范围 |

[E1 gates](../evidence/v1-engineering-validation/preflight/preflight-statuses.json)、[E3 命令回执](../evidence/v1-engineering-validation/e3/cr-a-corrective/quality-command-statuses.json)。新增发布核验工具仅执行只读 Hash 检查，不修正这些历史状态。

恢复证据的入口与失败历史：

- [Corrective 复现说明](../evidence/v1-engineering-validation/publication/redacted/docs/evidence/v1-engineering-validation/e3/cr-a-corrective/reproduce.md)、[历史复现说明](../evidence/v1-engineering-validation/publication/redacted/docs/evidence/v1-engineering-validation/e3/reproduce.md)、[E1 复现说明](../evidence/v1-engineering-validation/publication/redacted/docs/evidence/v1-engineering-validation/preflight/reproduce.md)。
- 原 CR-A 身份异常、旧 REC-01 legacyDiagnostic FAIL、REC-03 修正前 FAIL 全部保留。[Schema 修正说明](../evidence/v1-engineering-validation/publication/redacted/docs/evidence/v1-engineering-validation/e3/cr-a-corrective/analysis-schema-correction.md)；REC-01 只接受预先存在的未完成 StepRun 合法首次分配 Mission，反向测试保留。
- REC-08 来自独立离线测试（3 PASS / 34 skipped），不是正式案例内重试。CR-B 的 REC-09 旧措辞 Final continuation 仍在原始断言中；最终报告解释为 FirstRestart 与 SecondRestart 的确认等待对照，CR-B 没有显式继续或重试。
- 已完成 Step 的 ID、attempt、事件及持久事实没有重放；CR-B UNKNOWN 没有自动重发。Artifact/Validation/Checkpoint 及各阶段 integrity=ok、FK=0 可从快照和对账核对。

历史三份 Manifest 保持原始字节：

| Manifest | Entries | SHA-256 |
|---|---:|---|
| [E1](../evidence/v1-engineering-validation/preflight/evidence-manifest.json) | 71 | `0e0327f2de13917fca85f2c117c9e5f5cab4bf7548ead3f274ce93cbd178d2db` |
| [历史 E3](../evidence/v1-engineering-validation/e3/evidence-manifest.json) | 59 | `e7ce69c19ed366a52e4c7f19d8f18f79e9abab6cd59bce5af1b8a7c98af9eb17` |
| [CR-A Corrective](../evidence/v1-engineering-validation/e3/cr-a-corrective/evidence-manifest.json) | 76 | `44ca22930afd86724aef4a95090ba56742f4ea3564a292b6426fa0fa071c82f4` |

公开证据的 Hash 边界：[发布映射](../evidence/v1-engineering-validation/publication/publication-manifest.json)逐文件列出本地原件与公开副本路径、字节数、双份 SHA 及删减类别。`redacted/` 下均为 **DERIVED/REDACTED**，不声称与原件逐字节相同。原始 Manifest 引用原件 Hash；不能直接拿它校验已脱敏副本。路径使用稳定 root 标记保留 Profile/Run 身份比较；PID、创建时间、案例 UUID、次数、状态和完整断言保留。删去完整继承环境转储与无关工作区文件清单，不上传个人资料。原始文件均在本地保留，未替换。

GitHub 可独立重算公开文本与执行源码 Hash、三个冻结 E0 Hash，并检查历史 Manifest 与发布映射的原件 Hash 是否对应。原始 SQLite/WAL/SHM 仅保留本地，公开 JSON 是实验时生成的快照/对账，GitHub 无法独立重算未公开的数据库字节或重现实验外的 exactly-once 保证。

只读公开核验：在仓库根目录执行 `node scripts/engineering-validation/publication-verify.mjs`。正式 controller 不能据此再次运行；新强杀或真实 Jev 调用仍需另行授权。新增 `docs/.gitattributes` 与脚本目录属性只用于防止换行转换损坏封存字节，没有修改生产逻辑。

[完整发布白名单](../evidence/v1-engineering-validation/publication/publication-allowlist.md)；[安全与删减说明](../evidence/v1-engineering-validation/publication/security-review.md)。
