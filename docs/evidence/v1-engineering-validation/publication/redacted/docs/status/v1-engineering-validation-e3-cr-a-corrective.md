> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `5324c5a23c847019bbbbf114224a12b8b9d06be8f2274b2cabf30f49364fd1c4`. See the publication derivation map for both hashes and removed field categories.

# V1 E3 — CR-A Corrective Completion

日期：2026-10-16（Asia/Shanghai）。执行结论：**E3_PASS**，提交独立审核。本轮仅对一个全新的 CR-A 测试实例进行一次正式 Main 强制终止；未重做 CR-B。

## 状态

| 检查项                   | 状态 |
| ------------------------ | ---- |
| E3_CR_A_CORRECTIVE       | PASS |
| E3_CR_B_HISTORICAL       | PASS |
| E3_RECOVERY_INVARIANTS   | PASS |
| E3_REPRODUCIBILITY       | PASS |
| E3_SQLITE_INTEGRITY      | PASS |
| E3_BASELINE_PRESERVATION | PASS |

历史结果不变：原 CR-A BLOCKED、原 CR-B PASS、原 E3_CONDITIONAL 报告及其原始 JSON/断言均保留。本次是独立补充证据，不回填原 Run，不覆盖原失败。

## 基线、保留与环境

HEAD/分支：`main@a2551bbc9dbd87ec4701183a53a2635966326df4`。Windows x64，Node v24.15.0，Electron 44.4.3。继续复用 E1/E3 已验证打包产物，未重新打包。

| 产物         | SHA-256                                                          |
| ------------ | ---------------------------------------------------------------- |
| EXE          | 8a4cdbce704b86297dfee1bc0e22c9b92fc225bdb31eda6501aa668108e4b42c |
| app.asar     | 7deaf487916b0d0a65d723151c87658ce8e65588a37328c0add88e7ceac073b8 |
| Main Bundle  | 417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71 |
| E0 v0.2 文档 | 2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c |
| Dataset      | ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602 |
| TSV          | 04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62 |

Migration 0001–0033 全部与基线 LF 内容一致，未改写既有 CRLF；三个官方 Workflow frozen content/manifest hash 与正式治理记录一致。E1 的71项、历史E3的59项封存文件全部保持原Hash；本轮开始额外记录的 **733 个历史未跟踪文件**逐一保持原字节。最终 tracked diff 为空，没有 Commit/Push，也没有清理用户文件。

P0详情：[baseline-2026-10-16T04-57-41-026Z.json](../evidence/v1-engineering-validation/e3/cr-a-corrective/baseline-2026-10-16T04-57-41-026Z.json)。所有新 Profile、Workspace、TEMP、用户目录、缓存位于 E 盘 `.tmp/e3-corrective-runtime/`。实际 Electron app.getPath('userData')、运行时环境和OS启动命令均与该实例一致，未访问正式 Profile 或真实 Provider Key。

## Controller 安全与类型修正

保留原 Controller 与历史类型失败日志，新增独立 corrective 控制器及快照模块。Session、ProcessIdentity、ControllerLaunch、SQLite投影和协议边界有独立类型检查；不以应用typecheck替代，不用 ts-nocheck/ts-ignore，不关闭 checkJs。

十项非破坏性 policy tests覆盖：EXITED、MATCHED、UNKNOWN/WAIT_ONLY、PID复用、EXE/完整命令行不符、Main退出后子进程自然消失、持续未知身份阻塞等；测试本身强杀进程数为0。实际helper逐项记录expected/current完整身份及异常，Main终止前再次核对PID、创建时间、EXE、完整命令行、actual UserData与Controller启动记录。

唯一授权使用排他性 `formal-authorization-used.json` 记录；不得删除或绕过它再次运行。Main退出后不可读的子进程只能有限等待，不可终止；确认PID复用/身份不符立即BLOCKED；子进程在Stop请求间隙自行消失则记录EXITED且不重试。没有按进程名全局kill、仅按Parent PID清理、/T或正常关闭超时后的强杀fallback。

## 新 CR-A 身份与精确屏障

Run：`bda77f9a-ee99-44bf-8cd4-0892e72c5b1f`；S06 StepRun：`9260a547-7c31-4507-b17f-00423f416a14`，attempt=1；S06 Mission：`3b3d1cdd-539a-4217-8fdf-ae1c10fff503`；MissionRun：`0c1ed74a-83a8-492c-8cc7-e2a0f6c3e347`。

| 代次 | Main PID | OS 创建时间                  | 实际 Electron UserData                                                                                                                                              | bootstrap之前观察器已布设 |
| ---- | -------: | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 0    |    29940 | 2026-10-16T04:51:53.7623460Z | [REPOSITORY_ROOT]\.tmp\e3-corrective-runtime\CR_A_CORRECTIVE-e6a631e0-30f4-417e-98a3-f32c12e8a377\profile\UserData | 是                        |
| 1    |    29848 | 2026-10-16T04:52:32.2009350Z | [REPOSITORY_ROOT]\.tmp\e3-corrective-runtime\CR_A_CORRECTIVE-e6a631e0-30f4-417e-98a3-f32c12e8a377\profile\UserData | 是                        |
| 2    |    30476 | 2026-10-16T04:52:49.7097970Z | [REPOSITORY_ROOT]\.tmp\e3-corrective-runtime\CR_A_CORRECTIVE-e6a631e0-30f4-417e-98a3-f32c12e8a377\profile\UserData | 是                        |

断点从实际Inspector脚本解析并重算Main Hash，精确命中 **9625:7198（V8 0-based）** 的 completeExecution() S06事务提交之后。不是数据库轮询推断；完整 rawPaused/callFrames、原始V8断点解析、调用帧变量和SQLite副本均在 [execution.json](../evidence/v1-engineering-validation/e3/cr-a-corrective/CR_A_CORRECTIVE-e6a631e0-30f4-417e-98a3-f32c12e8a377/execution.json)。

同时验证 S06 COMPLETED、S06 Artifact/Validation/Checkpoint已提交、S07 READY且没有Mission、独立verifier ENTRY=1/COMPLETED=1，全部断言通过后才执行唯一强杀。Main终止回执状态 **TERMINATED**，Main强杀序号 **1**；原已验证进程均消失。逐项回执/日志与完整OS字段随本案例一起封存。

S06持久事实：

- Artifact：`e83bc930-6027-40c6-9d42-fe90607c6794` / SHA-256 `614d60c4dccd6bb2d8a9134bc3b8a7389cef2a9fc4c48a0c06d97bd3907f917c`。
- Validation：`5243c4a3-75b2-4a99-bf7f-0f5ef22e954c` / valid=1 / hash `614d60c4dccd6bb2d8a9134bc3b8a7389cef2a9fc4c48a0c06d97bd3907f917c`。
- 包含S06的Checkpoint：`95ea3ae4-a0f1-40ec-93fa-3ff38fe5a86b` / sequence=6 / state_hash `08e4c95dbe0c5dec6405fe2a590313f9cba5c22e2a3ba54cff5aab2807ce0ebd`。

以上原行身份、内容Hash和关联关系在后续阶段全部保留；额外 Artifact canonical content+metadata Hash 由独立审计重算。

## 五阶段事实与继续边界

进程谱系审计还记录了三个创建时间早于“当前同号父进程”的旧候选，EXE/命令行不可读；它们在强杀前即因 validTime=false 被明确排除，绝不能仅按 Parent PID 视为本实例子进程。后续只读审计显示这些无归属候选仍在，而本实例5个已验证身份全部消失，另一个未终止的console候选自然退出。部分数值PID此后已被其他新进程复用，没有对它们再发信号。宽泛观察清单的 allOriginallyObservedProcessesAbsent=false 包含这些非实验对象，不能与已验证归属清单混用；分类对账见 [进程归属复核](../../../../e3/cr-a-corrective/final-process-ownership-reconciliation.json)。实际 corrective 应用剩余进程数为0。

| 阶段                       | Run状态/等待 | S06 model/tool | 崩溃前完成集 model/tool | 全Run model/tool | Artifact/Validation/Checkpoint | verifier入口/完成 | integrity/FK |
| -------------------------- | ------------ | -------------: | ----------------------: | ---------------: | ------------------------------ | ----------------- | ------------ |
| BeforeCrash                | RUNNING/—    |            2/1 |                    11/5 |             11/5 | 8/8/6                          | 1/1               | ok/0         |
| AfterKill                  | RUNNING/—    |            2/1 |                    11/5 |             11/5 | 8/8/6                          | 1/1               | ok/0         |
| FirstRestartBeforeContinue | RUNNING/—    |            2/1 |                    11/5 |             11/5 | 8/8/6                          | 1/1               | ok/0         |
| ExplicitContinue           | COMPLETED/—  |            2/1 |                    11/5 |             13/5 | 11/11/10                       | 1/1               | ok/0         |
| SecondRestart              | COMPLETED/—  |            2/1 |                    11/5 |             13/5 | 11/11/10                       | 1/1               | ok/0         |

首次重启的 FirstRestartBeforeContinue 在任何显式继续之前封存，随后先执行 firstRestartChecks：旧完成Step及MissionRun身份不变、旧Artifact/Validation/Checkpoint不新增或变化、旧完成MissionRun的model/tool事件保持、verifier Ledger不变，全部通过才记录 USER_EXPLICIT_CONTINUE 并调用公开推进/审批IPC。该先验检查不是事后用最终成功替代。

显式继续时间：2026-10-16T04:52:46.621Z；入口：window.cultivation.workflows.advance + public approval IPC。本次后续运行最终状态：**COMPLETED**。后续新Mission按原未完成StepRun关联如下；它们属于人工继续后的正常业务，不计为已完成S06重放。

| 后续Step | 原StepRun                            | attempt | 新Mission                            | 新MissionRun                         | 结束状态  |
| -------- | ------------------------------------ | ------: | ------------------------------------ | ------------------------------------ | --------- |
| S08      | e0a64c49-37a2-462a-b4c6-d746de09281f |       1 | 47a04116-93e6-4672-8920-a83f00b5288f | 6dce1d93-29bb-4414-a338-1610cfd01d1c | COMPLETED |
| S11      | b76207de-6007-41dd-9f5b-258a34f9d7a5 |       1 | 7bfe72a4-74f9-417c-86c2-9397841aa0f4 | 8b17a202-6134-46ca-9a4c-8bc1d997c3ff | COMPLETED |

再次重启在正常关闭之后进行，比较的是 ExplicitContinue 与 SecondRestart：原Run/Step/attempt、后续Mission、Artifact/Validation/Checkpoint、执行事实及Workspace Hash均保持，不再发起业务执行。独立写入口/写后观察器在每次bootstrap前布设；S05原三条路径各写一次，恢复时不重复；独立验证器全程仍1/1。

## REC-01–REC-10

| REC    | 状态 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REC-01 | PASS | No new attempts; all completed pre-crash StepRuns retained their identities. 2 new Mission/MissionRun assignment(s) occurred only after explicit continuation on pre-existing unfinished StepRuns and persisted through SecondRestart. The sealed REC-01 identity projection reports the expected unfinished-StepRun Mission assignment as a mismatch for S08#1; this is the sole compatibility delta accepted by the corrective rule. |
| REC-02 | PASS | All 6 pre-crash completed StepRun(s), their Mission/MissionRun rows, and their complete event histories are unchanged. Startup windows afterKill→firstRestart and explicitContinue→secondRestart add no Mission, MissionRun, or MissionEvent rows. Legacy REC status: PASS (Completed Step execution events stayed stable: afterKill=21, firstRestart=21, explicitContinue=21, secondRestart=21.).                                     |
| REC-03 | PASS | New continuation facts are confined to the explicitContinue window and linked to pre-existing unfinished StepRuns (5 eligible StepRun IDs); prior rows remain byte-stable. Legacy REC status: PASS (Prior durable row IDs and hashes are preserved across 6 table(s). No rows were added.).                                                                                                                                            |
| REC-04 | PASS | Target operation and journal identities persist across phases without duplicate rows.                                                                                                                                                                                                                                                                                                                                                  |
| REC-05 | PASS | Target operation and journal identities persist across phases without duplicate rows.                                                                                                                                                                                                                                                                                                                                                  |
| REC-06 | PASS | The invariant is true in every required phase.                                                                                                                                                                                                                                                                                                                                                                                         |
| REC-07 | PASS | The invariant is true in every required phase.                                                                                                                                                                                                                                                                                                                                                                                         |
| REC-08 | PASS | Independent offline retry test passed: creates a new Step attempt and preserves prior attempt artifacts on explicit retry.                                                                                                                                                                                                                                                                                                             |
| REC-09 | PASS | Final continuation and second restart have stable Run identity/state, Step rows, durable IDs/hashes, events, and workspace hashes.                                                                                                                                                                                                                                                                                                     |
| REC-10 | PASS | SQLite checks passed; raw triplet was copied before SQLite open; runtime verified one isolated profile/workspace across generations 0, 1, and 2.                                                                                                                                                                                                                                                                                       |

### 旧断言投影差异（保留原结果）

封存旧模块的实际结果为 **FAIL**。旧 REC-01 把尚未执行的既有StepRun中 mission_id/mission_run_id 从null合法赋为新ID也算成身份变化；它还将“允许后续新增事实”和“允许新增attempt”混在一起。

新的补充规则只接受：崩溃前未完成、首次恢复时无Mission的同一StepRun，在明确人工继续后单调绑定一组全新的Mission/MissionRun；Run/定义版本/StepRun/attempt/created_at不变，全部已完成身份不变，不允许本次未授权新增attempt。只有严格新规则通过且旧FAIL恰好是该特定投影差异时才接受REC-01，其余旧FAIL不得被吞掉。完整旧输出仍在 legacyDiagnostic，输入原始Snapshot没有投影、伪造或改写。

新REC-02/03同时约束旧完成Mission执行事实和新增业务行的后续Step血缘。纯内存反例验证了正常赋值通过、完成Step变造/新增attempt/启动调用/复用Mission/错误产物归属失败、缺阶段BLOCKED；这些Mock仅验证断言工具，不冒充进程级实验。

离线分析另有一次工具自身的 schema 误判：新分析器最初把 Run 级最终验证当成带单个 artifact_id 的 Step 行，产生 REC-03 FAIL。核对 migration 0018 与 appendFinalValidation 后，改为验证实际 output_bindings_json 中的同 Run/version、Artifact Hash、OUTPUT 绑定和新后续输出血缘，并新增七项反例。初次失败 JSON 和 E3_FAIL 分析汇总原样保留在 analysis-history；没有重跑应用或修改原始快照。详见 [分析器结构修正记录](../evidence/v1-engineering-validation/e3/cr-a-corrective/analysis-schema-correction.md)。

REC-08复用本轮三项离线Recovery测试中的显式retry新attempt保留旧证据测试；本次正式CR-A没有Retry。

## SQLite、独立Ledger及历史CR-B

五阶段均先封存原始DB/WAL/SHM及文件信息，复制前后Hash一致；仅从raw的第二份seed生成一致性备份，再做integrity_check/FK和业务查询。原件没有checkpoint、repair、业务表写入或补造成功Receipt。原三件套Hash再次对账，二进制原件留在execution.json指向的E盘忽略目录，文本证据保留完整来源路径。

历史CR-B不重跑，仅以原完整Snapshot和封存Hash只读引用，其REC-01–10保持PASS。**新的汇总说明修正CR-B REC-09措辞：它比较FirstRestart与SecondRestart的USER_CONFIRMATION等待状态；CR-B没有Final continuation，也没有任何人工continue/retry。**旧JSON与原报告中的原句保持原样，未为措辞修改原始测试断言。

## 回归与原六项命令

| 检查                         | 本轮结果             | 边界                                                         |
| ---------------------------- | -------------------- | ------------------------------------------------------------ |
| Controller policy tests      | PASS，10/10          | 无真实强杀；实际正式kill另有独立回执                         |
| 新Controller独立严格类型检查 | PASS                 | checkJs/strict，具体Session与进程类型；协议JSON边界显式标注  |
| 新audit/adapter独立类型检查  | PASS                 | 与应用typecheck分开                                          |
| 新脚本语法、scoped lint      | PASS                 | PowerShell AST + Node syntax + ESLint                        |
| Adapter sensitivity          | PASS                 | 纯内存正反例；保留legacy结果                                 |
| 相关Recovery                 | PASS：3，SKIPPED：34 | 包含REC-08独立retry测试                                      |
| npm run test                 | PASS：1521 / 165文件 | 本轮重新运行                                                 |
| npm run typecheck            | PASS                 | 应用工程检查                                                 |
| npm run lint                 | FAIL                 | 既有private脚本10项；不改用户私有文件                        |
| npm run format:check         | FAIL                 | 冻结/历史文档与原始JSON等；实际日志保留                      |
| npm run package              | NOT_RUN              | 复用相同已验证产物，原E1长路径FAIL不改写                     |
| npm run smoke:package        | BLOCKED / NOT_RUN    | 完整链含额外kill及缺严格身份核验路径，不在本次唯一CR-A授权内 |

所有本轮及历史失败/未执行状态均保留，不把主应用typecheck PASS当作新Controller类型检查。最终 formatter 除既有冻结文档及原始 JSON 外，还报告新增 controller.mjs、snapshots.mjs、types.d.ts 的格式差异；这是本轮保留的样式欠项。三份文件的实际执行/检查字节保持原样，不在正式实验后为改格式数字重写源码；独立类型、语法及 scoped lint 均通过。没有为让全局formatter通过改写原始JSON或冻结E0。复现命令、环境隔离、一次授权保护及离线分析见 [reproduce.md](../evidence/v1-engineering-validation/e3/cr-a-corrective/reproduce.md)。

## 证据与结论限制

- [新案例原始证据目录](../evidence/v1-engineering-validation/e3/cr-a-corrective/CR_A_CORRECTIVE-e6a631e0-30f4-417e-98a3-f32c12e8a377/execution.json)
- [机器可读汇总](../../../../e3/cr-a-corrective/result-summary.json)
- [SQLite与逐阶段事实对账](../evidence/v1-engineering-validation/e3/cr-a-corrective/sqlite-and-fact-audit.json)
- [历史CR-B引用与措辞修正](../../../../e3/cr-a-corrective/historical-cr-b-reference.json)

Existing offline --gate1-fake-model / --r4-fake-routing / --w22-fake-software fixtures; actual public IPC, permission, tool, filesystem and SQLite paths.

本次证据支持已完成步骤的持久事实恢复、合法人工继续与再次启动幂等；结合既有CR-B，支持不确定本地副作用进入UNKNOWN并等待明确人工决策，避免盲重发。观察器与两次重启是有限观测窗口，模型响应仍是离线Fixture，不构成真实模型能力评测或所有第三方服务的端到端Exactly-Once Execution保证。未自动进入E2、Jev、Gold调整、Transport修复或V1业务变更。执行到此结束，等待独立审核。
