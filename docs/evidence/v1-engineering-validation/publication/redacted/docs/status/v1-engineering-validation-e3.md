> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `7acd6f3984622c30b86c8a8c2f06b4b67d15a64982a21f4f46ecc3894934c7b4`. See the publication derivation map for both hashes and removed field categories.

# AI Agent Cultivation V1 — E3 Workflow Crash & Recovery

日期：2026-10-16（Asia/Shanghai）。总体结论：**E3_CONDITIONAL**。CR-B 已完成正式进程级崩溃与两次恢复；CR-A 因终止控制器的子进程身份复核异常按停止条件终止，未执行恢复，不能视为通过。未发现已完成 CR-B 证据中的产品恢复不变量违例。

## 最终状态

| 项目                     | 状态    |
| ------------------------ | ------- |
| E3_CR_A_PACKAGED         | BLOCKED |
| E3_CR_B_PACKAGED         | PASS    |
| E3_RECOVERY_INVARIANTS   | BLOCKED |
| E3_REPRODUCIBILITY       | BLOCKED |
| E3_SQLITE_INTEGRITY      | BLOCKED |
| E3_BASELINE_PRESERVATION | PASS    |

完整恢复不变量、复现覆盖及 SQLite 阶段覆盖因 CR-A 缺失重启阶段而 BLOCKED。已经取得的 7 个阶段一致性副本均 integrity_check=ok、foreign_key_check=0；这不等于两个案例的完整覆盖通过。

## 基线、环境与产物

- Windows x64，Node v24.15.0，Electron 44.4.3；分支 main，HEAD `a2551bbc9dbd87ec4701183a53a2635966326df4`。
- 复用 E1 验证的现有 Windows x64 打包产物，没有重新构建产品。
- EXE：`out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`，SHA-256 `8a4cdbce704b86297dfee1bc0e22c9b92fc225bdb31eda6501aa668108e4b42c`。
- app.asar：`7deaf487916b0d0a65d723151c87658ce8e65588a37328c0add88e7ceac073b8`。
- Main Bundle：`417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71`；运行时 Inspector 读取的脚本 Hash 同样匹配。
- E0 v0.2 文档：`2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c`；Dataset：`ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602`；TSV：`04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62`。
- 0001–0033 Migration 与 HEAD 逐项 LF 规范化比较一致；原始 CRLF 差异仅记录，不改写文件。三个官方 Workflow 的 content/manifest frozen hash 与正式治理记录一致。
- 前后 P0 复核均 PASS，E1 的 71 项封存文件逐一保持原 Hash。详情见 [最终基线审计](../evidence/v1-engineering-validation/e3/baseline-2026-10-16T03-13-50-519Z.json)。

## 实验路径与边界

测试 Profile、Workspace、用户环境目录、缓存、临时文件全部配置到 E 盘 `.tmp/e3-runtime/<case-uuid>/`。未访问正式 Profile 或用户 API Key。三个既有离线 Fixture 标志在 Main argv 中逐一验证；Workflow 创建、推进、批准均走公开 preload IPC，工具仍经过 PermissionEngine、ToolRuntime、WorkflowToolGuard、真实 Workspace 写入和 SQLite。只复用 E1 的目录选择对话框测试桩，不修改 Workflow 业务状态。

沿用 E1 的 Fixture、驱动、断点解析和暂停检查函数。E3 增加原始三件套封存、严格外部终止与两次重启对账。为在恢复开始前布设观察点，使用 shell:false 直接启动相同 EXE，Node Inspector 在 --inspect-brk 屏障上先设置写入口断点，然后才放行 bootstrap；避免正常窗口出现后才开始观察而漏掉启动重放。Chromium CDP 仅负责现有 UI/IPC。

## CR-A：BLOCKED，按停止条件保留现场

正式 Run：`ef2d69de-90c8-4ff0-97db-512f2548f757`。原 Main PID：25156。精确屏障：Main Bundle **9625:7198**（V8 0-based），`completeExecution()` 提交之后、条件 S06。所有崩溃前断言通过：S06 COMPLETED、持久 Artifact/Validation/Checkpoint 存在、S07 READY 且无 Mission，独立 verifier ENTRY=1、COMPLETED=1。

唯一一次终止请求后，PowerShell 控制器报告 **Process identity mismatch for 17256; refusing termination**。该 PID 是已枚举的子进程；控制器按照 Main-first 顺序执行，但未能返回完整终止回执，因此不能把 killOrdinal=1 这一请求字段单独当作完整终止成功证据。后续独立 CIM 审计确认原 Main 25156 与四个原已验证子进程均已不存在。已封存原始崩溃前与终止后数据；**没有再强杀、没有重启该 Profile、没有人工继续**。

疑似 Main 退出后子进程正在退出，导致 CIM 的可执行路径/命令行暂不可读；原异常没有留下当时的 current 身份对象，故这一原因仅为推断，不能确证 PID 复用或产品崩溃缺陷。用户指令要求身份不符时停止案例，本案据此 BLOCKED。First Restart、Explicit Continue、Second Restart 均 NOT_RUN。

后续控制器补充逐项外部日志，并对 Main 退出后身份不可读的子进程只等待其消失、绝不终止未确认身份；其严格保护在 CR-B 使用。本轮没有用修正后的控制器重新强杀 CR-A。

现场记录：

- [原执行记录](../evidence/v1-engineering-validation/e3/CR_A-64e44b53-bcc2-44c9-8d07-352fade461ac/execution.json)
- [进程审计与停止说明](../evidence/v1-engineering-validation/e3/CR_A-64e44b53-bcc2-44c9-8d07-352fade461ac/termination-audit-followup.json)
- [终止后完整 Ledger 快照](../evidence/v1-engineering-validation/e3/CR_A-64e44b53-bcc2-44c9-8d07-352fade461ac/AfterKillVerifiedLedger.json)

初次终止后封存脚本引用了错误 verifier 文件名，导致该次 AfterKill.json 的 verifierLedger 为空。原记录保留；新增 AfterKillVerifiedLedger.json 重新封存并读取真实 verification-events.ndjson，修正说明见 ledger-path-correction.json。没有重启应用或改写业务表。

## CR-B：PASS

正式 Run：`1986ed84-12ed-4ba5-b94e-00c9419f76b1`；S05 StepRun：`f56253a4-1b40-4aa0-adf1-7608f0cfcf5e`，attempt=1；Mission：`0b65126a-0d61-4cdc-b64b-2a36526dfd0b`；MissionRun：`c3e4a430-03ba-4d6b-bcc1-53074328d2b6`。Operation：`0e25f076-4223-4044-bf3b-3b1efc586b9c`；Journal：`7dcc2ea6-3c5d-40a8-adcd-f0e1df4145c9`。

Main PID 依次为 **13864 → 18428 → 7048**。每代均记录创建时间、EXE、命令行、实际 UserData 和 Fixture argv。唯一强制终止 Main=13864，严格复核后执行一次 Stop-Process -Id exactPID -Force；其余已验证子进程自行退出，控制器确认所有原身份消失。后两代经公开 desktop.close IPC 正常关闭。

真实写入口：**9848:7612**，暂停帧 writeText；真实写后：**9848:13661**，暂停帧 execute。脚本 Hash、原始暂停帧与 E1 已确认的 return-typed 位置一致。写后仍停在 ToolRuntime 成功返回 / guard.after 完成之前：

- Operation=PREPARED，Journal=PREPARED；Mission 与 MissionRun 仍 RUNNING。
- renderer.ts 由 `6d1bbc70d0961794c1f755f7a9543627b6aad4dbec749693173926062d356c9b` 变为期望 `22a5764d7e1083cadf86d8cec7b1d7d29c8d617116385716cff747e3b7a2b637`。
- 独立外部 Ledger：WRITE_ENTRY=1，WRITE_RETURN=1；S05 成功 file.writeText tool.result=0。
- 当时 Workflow/S05 持久状态为 WAITING/APPROVAL；公开批准请求尚未返回。这与 Mission 正在运行同时成立，不应误写为 Step 必须 RUNNING。

第一次恢复在任何 advance/retry 之前读出：Mission/MissionRun INTERRUPTED，MissionRun error=APP_RESTARTED，原 Operation UNKNOWN，Workflow 与原 S05 WAITING/USER_CONFIRMATION，Step error=EXECUTION_INTERRUPTED_RETRY_REQUIRED。原 Journal 仍 PREPARED，observed_after_hash/result_code 均 null，原文件保持已写值。**没有调用额外 advance 把错误码改为 OPERATION_UNKNOWN，也没有自动 Retry。**

第二次重启与第一次恢复保持上述事实；业务身份、Artifact/Validation/Checkpoint、模型/工具执行事实均未新增。初始总 model.call_started=6、tool.result=1，两次恢复仍为 6/1；该 1 条 tool.result 是更早的工具事实，不是目标 file.writeText 的成功回执。完整 Artifact=6、Validation=6、Checkpoint=4，逐项 ID 与内容 Hash 保持。独立观察器在两次启动放行 bootstrap 之前均已布设，累计写入口/写后仍为 1/1。

[完整执行与断点记录](../evidence/v1-engineering-validation/e3/CR_B-219de96c-32de-4534-b909-7de476dcc490/execution.json) · [终止后](../evidence/v1-engineering-validation/e3/CR_B-219de96c-32de-4534-b909-7de476dcc490/AfterKill.json) · [首次恢复](../evidence/v1-engineering-validation/e3/CR_B-219de96c-32de-4534-b909-7de476dcc490/FirstRestart.json) · [二次恢复](../evidence/v1-engineering-validation/e3/CR_B-219de96c-32de-4534-b909-7de476dcc490/SecondRestart.json) · [独立 Controller Ledger](../evidence/v1-engineering-validation/e3/CR_B-219de96c-32de-4534-b909-7de476dcc490/independent-controller.ndjson)。

## SQLite 与事实对账

所有阶段先记录源 DB/WAL/SHM 信息并逐字节复制到 raw；复制前后 Hash 必须一致。随后仅复制 raw 到 consistency-seed，再由种子副本使用 SQLite backup 生成 consistent.sqlite。integrity_check / foreign_key_check 和业务查询只对一致性副本执行，不对原件做 checkpoint、repair 或业务写入。原始 raw 三件套 Hash 在备份后及最终审计中重新验证，Artifact 使用产品 canonical content+metadata 算法独立重算。

| Case | 阶段                    | Run 状态/等待原因         | 目标 Step 状态/错误                          | model | tool | Artifact/Validation/Checkpoint | integrity/FK |
| ---- | ----------------------- | ------------------------- | -------------------------------------------- | ----: | ---: | ------------------------------ | ------------ |
| CR_A | BeforeCrash             | RUNNING/—                 | COMPLETED/—                                  |    11 |    5 | 8/8/6                          | ok / 0       |
| CR_A | AfterKillVerifiedLedger | RUNNING/—                 | COMPLETED/—                                  |    11 |    5 | 8/8/6                          | ok / 0       |
| CR_B | WriteEntry              | WAITING/APPROVAL          | WAITING/—                                    |     6 |    1 | 6/6/4                          | ok / 0       |
| CR_B | BeforeCrash             | WAITING/APPROVAL          | WAITING/—                                    |     6 |    1 | 6/6/4                          | ok / 0       |
| CR_B | AfterKill               | WAITING/APPROVAL          | WAITING/—                                    |     6 |    1 | 6/6/4                          | ok / 0       |
| CR_B | FirstRestart            | WAITING/USER_CONFIRMATION | WAITING/EXECUTION_INTERRUPTED_RETRY_REQUIRED |     6 |    1 | 6/6/4                          | ok / 0       |
| CR_B | SecondRestart           | WAITING/USER_CONFIRMATION | WAITING/EXECUTION_INTERRUPTED_RETRY_REQUIRED |     6 |    1 | 6/6/4                          | ok / 0       |

原始二进制数据库和 Workspace 保留在各 execution.json 的 runRoot 指向的 E 盘忽略目录；docs 提供文本事实、完整 Hash、Ledger 和原路径，不将一致性备份冒充原始三件套。完整对账见 [sqlite-and-fact-audit.json](../evidence/v1-engineering-validation/e3/sqlite-and-fact-audit.json)。

## REC-01–REC-10 自动断言

CR-A 因缺失所需恢复阶段保持 BLOCKED；REC-08 独立离线测试可以另行通过，不把它替代正式恢复链。

### CR-A

| 不变量 | 状态    | 自动断言说明                                                                   |
| ------ | ------- | ------------------------------------------------------------------------------ |
| REC-01 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-02 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-03 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-04 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-05 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-06 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-07 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-09 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-10 | BLOCKED | Required CR-A phases are incomplete.                                           |
| REC-08 | PASS    | Independent offline retry test passed; CR-A recovery snapshots are incomplete. |

### CR-B

| 不变量 | 状态 | 自动断言说明                                                                                                                                                       |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REC-01 | PASS | Preserved 11 prior Step attempt(s); no new attempt was added.                                                                                                      |
| REC-02 | PASS | No additional model/tool execution events were recorded for the interrupted target MissionRun.                                                                     |
| REC-03 | PASS | Prior durable row IDs and hashes are preserved across 6 table(s). No rows were added.                                                                              |
| REC-04 | PASS | Target operation and journal identities persist across phases without duplicate rows.                                                                              |
| REC-05 | PASS | No explicitContinue snapshot or retry/advance evidence exists in CR-B; both restarts preserve the confirmation wait.                                               |
| REC-06 | PASS | Each restart preserves the exact interrupted UNKNOWN/PREPARED waiting contract.                                                                                    |
| REC-07 | PASS | Before recovery Mission/MissionRun remain RUNNING with PREPARED evidence; after recovery the uncertain mutation stays UNKNOWN/PREPARED and waits for confirmation. |
| REC-08 | PASS | Independent offline retry test passed; CR-B itself contains no retry or new Step attempt.                                                                          |
| REC-09 | PASS | Final continuation and second restart have stable Run identity/state, Step rows, durable IDs/hashes, events, and workspace hashes.                                 |
| REC-10 | PASS | SQLite checks passed; raw triplet was copied before SQLite open; runtime verified one isolated profile/workspace across generations 0, 1, and 2.                   |

断言模块及输入见 [recovery-invariants.json](../../../../e3/recovery-invariants.json) 和 scripts/engineering-validation/e3-invariants.mjs。REC-08 来自既有离线测试 creates a new Step attempt and preserves prior attempt artifacts on explicit retry，不在 CR-B 内重试。

## 回归与六项原命令

| 命令                    | E1 原状态（保留）                        | E3 状态                                                                        |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run test`          | PASS：1521 / 165                         | PASS：1521 / 165                                                               |
| `npm run typecheck`     | PASS                                     | PASS                                                                           |
| `npm run lint`          | FAIL：既有 private 脚本 10 项            | FAIL：既有 private 脚本 10 项（最终日志为准）                                  |
| `npm run format:check`  | FAIL：3 份既有冻结/历史 Markdown         | FAIL：既有 3 份文档，另含保留原样的 E3 原始 execution.json                     |
| `npm run package`       | FAIL：隔离构建 MSBuild 路径超过 260 字符 | NOT_RUN：依本轮授权复用已验证产物；无重新打包 PASS 声明                        |
| `npm run smoke:package` | NOT_RUN：当时禁止强杀                    | BLOCKED / NOT_RUN：本轮重新审查发现链内缺少严格身份复核和部分环境/历史输出隔离 |

额外：三项相关 Recovery 测试 3 PASS、34 SKIPPED；新增脚本 node --check、PowerShell AST 语法解析、scoped ESLint 通过。新增 JavaScript 单独 checkJs 类型检查 **FAIL**：控制器动态 Inspector、session、renderer Window bridge 以及部分数据库返回值缺少完整类型声明，详情见 javascript-typecheck-final-results.txt；应用 npm run typecheck 的 PASS 不覆盖这些独立 .mjs 脚本。初次 JavaScript 类型诊断、全局 lint/format 初次结果均保留，不把它们改为 PASS。

最终全局格式检查为 12 项：3 份既有文档、6 份原始 execution.json、2 份原始终止请求 JSON，以及 1 份派生 SQLite 对账 JSON；完整原始输出保留在 format-check-final-results.txt。报告及新增脚本已单独格式化，不修改原始实验记录来改变全局检查数字。

完整 smoke:package 已重新递归审查：r3-1/w1/w2 采用 PID-only taskkill /T /F，g1/g2 使用 process.kill SIGKILL，部分链路由测试标志触发应用自杀，缺少本轮要求的创建时间、EXE 与 Profile 复核，且存在继承环境和固定历史证据输出路径。因此本轮不运行整链。不是沿用 E1 的强杀禁令；独立 CR-B 的结果不替代整链验收。见 full-smoke-safety-audit.json。

## 失败、复现与审计边界

原始失败均保留：两个无强杀 PROBE/初始 CR-A 启动控制器的目录选择桩错误、正式 CR-A 子进程身份复核失败、首次 format:check 的沙箱 EPERM、初次新增脚本 lint/type 诊断。已通过额外无强杀 PROBE 验证 Electron Inspector 必须 includeCommandLineAPI:true 才能使用 require('electron') 安装测试对话框桩。

复现说明见 [reproduce.md](../evidence/v1-engineering-validation/e3/reproduce.md)。当前代码可以在新的隔离 Profile 创建实验，**本轮停止条件不授权再次运行 CR-A 强杀**；重做需在独立审阅后明确安排，不能覆盖本轮 BLOCKED 记录。

最终跟踪文件 diff 为空；新增实验脚本、报告与证据均为未跟踪文件，未 Commit/Push。E1 与此前用户未跟踪资料均保留。最终进程审计 E3 应用实例为 0。没有付费 Provider、Gold 修改、E2 Live、Transport 修复或核心架构变更。

## 可解释的结论与限制

CR-B 实测支持：已发生但未确认的本地副作用被隔离为 UNKNOWN，并交由明确人工决策；启动恢复不把文件存在当成成功回执，也不盲目重发工具。CR-A 的完整完成事实恢复及合法继续链本轮尚未完成验证。

这不构成所有第三方服务的端到端 Exactly-Once Execution 证明。观察范围是两个启动窗口及其已封存事实，模型响应来自既有离线 Fixture，本地 file.writeText 和生产持久化/权限路径真实执行。最终停在独立审核边界。
