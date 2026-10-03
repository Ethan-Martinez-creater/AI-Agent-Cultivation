# W2.2 corrective evidence

基线：`78eca696288fbd98026f76d5ea199090417bd10e`。全部截图来自真实 Windows x64 packaged app，使用离线 FakeModelGateway 和用户配置的 stdio MCP verifier。没有真实 API Key、互联网依赖或自动发布。

## 界面

| 文件                                                                               | 验证内容                                                                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [01-software-inputs.png](01-software-inputs.png)                                   | Renderer 新建软件工作流；当前 canonical Workspace 自动写入，工具按名称选择。           |
| [03-tool-scope-selection.png](03-tool-scope-selection.png)                         | 中文内置工具与 MCP 服务/工具名称；三个选中项原样成为 frozen Tool IDs，ID 在 Advanced。 |
| [04-mixed-command-human-verification.png](04-mixed-command-human-verification.png) | 命令已真实执行后，同一个 S06 MissionRun 等待本尊人工验收。                             |
| [02-mixed-completed.png](02-mixed-completed.png)                                   | COMMAND + MANUAL 合并证据后，六阶段完成。                                              |
| [02-bugfix-completed.png](02-bugfix-completed.png)                                 | 原 A：plan review 打回、verification fail/fix、code review finding/fix/reverify。      |
| [02-migration-completed.png](02-migration-completed.png)                           | 原 B：实际创建 SQL migration 并由 MCP 执行 SQL 验收。                                  |
| [02-crossLayer-completed.png](02-crossLayer-completed.png)                         | 原 C：Renderer + IPC + persistence 三文件真实受控修改与验证。                          |

## 持久化事实

[`corrective-facts.json`](corrective-facts.json) 保存四个 Run 的 Step attempt、decision、revision traversal、审批、真实 verification fact、mutation journal 和 final change manifest。另保存 mixed Run 的 accepted Artifact、合并产物 provenance 与 durable continuation。JSON 中技术 ID 用于核对归属，普通界面不要求用户输入这些 ID。

- A 实际命令 exit status 为 `[1, 0, 0]`；B/C/mixed 为 `[0]`。
- A 的 plan revision traversal 为 1，shared fix-cycle traversal 为 2。
- 每个 S08 reviewer 均不属于该 Run 任何实际 S05/S10 implementer 集合；actor/runtime 与审批保留在事实记录中。
- 原 S05 的 APPLIED crash 恢复，Tool/model event 数与 Workspace 文件 hash 不变，随后验证已有结果，没有重做 mutation。
- Mixed S06 有一条真实 MCP command fact，关联当前 Step、Run、actor、call ID 与 output hash。合并报告的 COMMAND 和 MANUAL 均 PASS；S07 的持久化 decision 为 PASS。
- WAITING_EXTERNAL_WORK 时强制退出后保持原 Run；ACCEPTED/PENDING、未消费 continuation 时再次退出，重启后完成原 Run并标记 CONSUMED。S06 model call 始终为 2、Tool result 为 1，没有追加执行。
- 完成四案例后重启：model call `57 → 57`，mutation journal `8 → 8`，checkpoint `50 → 50`。
- 发布类事件为 0；migration version 仍为 22；foreign key check 无错误。

确定性测试另外覆盖 COMMAND FAIL + manual ACCEPT → REVISE、人工声称 PASS 但无 command fact → BLOCKED、跨 Run/Step/actor → BLOCKED，以及 command PASS 但人工项未验收 → BLOCKED。

## 最终六项

| 命令                                            | 结果                                                      |
| ----------------------------------------------- | --------------------------------------------------------- |
| `npm run test -- --reporter=dot --maxWorkers=4` | PASS：82 files / 686 tests                                |
| `npm run typecheck`                             | PASS                                                      |
| `npm run lint`                                  | PASS                                                      |
| `npm run format:check`                          | PASS                                                      |
| `npm run package`                               | PASS：Electron 44.4.3 / Windows x64 / native SQLite       |
| `npm run smoke:package`                         | PASS：Gate 0–6、R0–R4、W1/W2.0/W2.1/W2.2、Product UI 全套 |

机器可读结果见 [`verification-results.json`](verification-results.json)。项目内日志为 `.tmp/w22-corrective-{test,typecheck,lint,format,package,smoke-full}.log`，详细日志仅作辅助，以上事实与截图已经纳入仓库。

未修改冻结的软件 Workflow v1、Contract、manifest 或历史 migration；没有新增依赖，不进入 W2.3。
