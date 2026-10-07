# R5.5 — Review / Completion Advisory

冻结基线：`main@c0f0ec5e8201f0c65eaec1462c002526fe4bddee`。范围仅 R5.5；无 R5.6、W3、R6、自动 Review 或自主继续执行。

## Contract 与 authority

LANGUAGE 的候选最终结果且没有新 Tool call 时，代码构造有界 context，调用独立 `COMPLETION_ADVISORY` DecisionGateway。SDK 固定 Jev `jev-1.13.0`，三个严格 Choice：`needs_review / objective_satisfied / should_continue`，每项只能是 `YES / NO / UNCERTAIN`。未知维度、rationale、action、reviewer、计划、非空 selectedAction、模型漂移、extra telemetry、超预算或非法 confidence/probabilities 均整体 fallback。

`ADVISORY_ONLY_V1` 只产生 `NO_ADVISORY / REVIEW_RECOMMENDED / OBJECTIVE_UNCERTAIN / CONTINUE_RECOMMENDED / MULTIPLE_CONCERNS`，没有执行接口。矛盾组合保留为 MULTIPLE_CONCERNS；不请求 Reviewer、不创建 Mission/Party/Approval、不继续模型循环、不改 Workflow verdict/branch/Contract/exit/Checkpoint、不改 Permission。fallback 三项都是 UNCERTAIN、mode=DETERMINISTIC_FALLBACK、disposition=NO_ADVISORY，继续 R5.4 执行语义。

Main 复用用户主动开启的 Cloud 配置与 safeStorage Key。在 SecretStore await 前后及实际 evaluate 前复核 opt-in；关闭、缺 key、配置撤销、超时、schema/SDK/network 错误均不影响正常执行。超时同时关闭该次 dispatch，迟到的 Key/gateway 不得再调用 evaluate；发送前再次复核原 Run active。上下文 metadata 读取异常也 fallback，异常正文不入日志。审计持久化本身仍遵守原有 persistence authority。

## 输入与隐私预算

集中策略：`r5-5-completion-advisory-policy-v1`；question `r5-5-completion-advisory-question-v1`；6 秒、零 retry。

| 内容                                         | 上限                                      |
| -------------------------------------------- | ----------------------------------------- |
| 脱敏 objective                               | 640 Unicode characters / 1600 UTF-8 bytes |
| 脱敏最终公开结果摘录                         | 960 characters / 2400 bytes               |
| state / request / response                   | 8000 / 16000 / 8000 bytes                 |
| Artifact metadata / Tool IDs / failure codes | 4 / 8 / 8 项                              |

context 只包含当前 Mission/Run/实际 actor/phase/mode、有界目标；result 是公开摘录及原始公开结果的 Unicode 字符数/UTF-8 SHA-256。Tool 只投影同 actor/run 的调用计数、成功计数、有限 ID/errorCode、approval bool。Artifact 仅 ID/hash/kind/mime/验证状态/contract/version/lineage count。Workflow 只投影当前冻结 Step 的类型、required capability、output contract、review policy 和确定性验证状态。

不发送 Memory、Skill instructions、对话历史、完整文件/Artifact、Tool input/output、MCP env、Credential、CoT 或 ExternalWork 私有说明。生产 Event/Audit 仅存 choices/disposition/mode/reason、actor/phase/run、hash/版本/字节数/安全错误码，无原始目标或结果正文。Settings 披露新增脱敏目标和公开结果摘录，以及建议不改变状态。

## 接入与兼容

Gate3 SOLO 的普通模型和 Tool loop final 分支、Gate5 实际 COORDINATOR/PARTICIPANT/SYNTHESIS LANGUAGE final 分支接入。实际模型 Usage 在可选 Cloud await 前持久化，返回后重新检查 Run，不能覆盖用户 pause/cancel/restart。记录 append-only `completion.advisory` MissionEvent/Audit。

G3 的 `RESULT` 仅提取 publicResult；其他合法 outcome 仅投影固定 kind，不发送 requirements/reason/requestedInputs；非法 structured outcome 不成为 advisory candidate。原 `g3-v1` outcome、attempt、continuation 仍是 control plane。GENERATION、Human Bridge target、普通 Chat 和 collaboration proposal 不调用此 advisory；本尊交付后实际 LANGUAGE Coordinator synthesis 可记录。

原 MissionCompletionBoundary、人工验收、Verification、Artifact deterministic validation、Review verdict、side-effect UNKNOWN 和 Workflow 状态机继续先决控制完成。R3 SHADOW 仍只有原四种 DecisionType。没有迁移、没有新增依赖，不改 0001–0030 或三个 OFFICIAL v1。

## 分层测试规则

按本轮用户正式要求，开发循环执行新增/受影响 targeted tests，接口变化时 typecheck；稳定后执行受影响阶段回归。冻结后顺序执行一次完整六项原命令。若任一最终项失败，退出验收、定向修复并回归，再从 `npm run test` 重启最终完整轮。最后一轮全部成功才是最终 evidence；中间或失败日志不能替代最终验证。后续阶段沿用此规则，完整旧链仍是冻结前必需验证。

## 验证状态

开发阶段受影响回归：19 files / 352 tests PASS；摘录边界修复后的 6 files / 113 tests PASS；异步 dispatch 修复后的 4 files / 91 tests PASS。最终轮从第一项重新开始，结果如下。

| 原命令                  | 最终结果                                                  |
| ----------------------- | --------------------------------------------------------- |
| `npm run test`          | PASS：142 files / 1290 tests，175.01 秒；较基线增加 65 项 |
| `npm run typecheck`     | PASS                                                      |
| `npm run lint`          | PASS                                                      |
| `npm run format:check`  | PASS：646 个可格式化文件                                  |
| `npm run package`       | PASS：Windows x64 / Electron native rebuild               |
| `npm run smoke:package` | PASS：完整 Gate 0–6 / R0–R4 / W1–W2.4 / G1–G3 / R5.1–R5.5 |

原命令日志见 [validation](../evidence/r5-5-review-completion-advisory/validation/)，最后完整成功轮的文件 hash、命令及 exitCode 见 [acceptance.json](../evidence/r5-5-review-completion-advisory/acceptance.json)。此前 1288 项全量测试是 dispatch 修复前的中间轮，保存在 `dev-full-test-superseded.txt`，不作为最终验收。

## Windows packaged 证据

最终 fixture：`21e88284-32f7-42ac-a6c5-a5adb3c8368d`。正常 production launch 只有三个 OFFICIAL v1，没有 R5.5 observer 或 fixture Workflow；显式 fixture launch 才加载 FakeDecisionGateway。

- SOLO satisfied、concern、inconsistent 均保持 COMPLETED，各只有一次模型调用，没有新 Tool/Approval/Collaboration；Cloud off 没有 Jev call，原结果 hash 不变。
- Party 的 COORDINATOR/PARTICIPANT/SYNTHESIS 绑定实际 A/B/A，私有 Memory/Skill marker 不进入 observer；G3 LANGUAGE RESULT 仍按原 schema 持久化、消费，无新 continuation。
- Jev 声称满足目标时，invalid JSON output 和 REVIEW REVISE 仍进入原 Workflow WAITING，确定性 validation/exit 获胜，没有建议驱动的推进。
- restart 的 model/tool/advisory 计数与事件、G3 outcome hash 不变。旧 W2 mutation、EXTERNAL UNKNOWN、G1/G2 UNKNOWN 和 Workflow generation bridge 完整回归。
- 旧 G3 实际 SQLite 中 GENERATION advisory=0、Human Bridge target advisory=0；本尊交付后的实际 LANGUAGE Coordinator synthesis 仍允许记录，按实际 actor 归属。
- Privacy 1440/1180/900 三档真实截图及 layout facts 均无横向溢出，已人工检查。

详见 [事实与截图](../evidence/r5-5-review-completion-advisory/21e88284-32f7-42ac-a6c5-a5adb3c8368d/)、[状态 authority 隔离](../evidence/r5-5-review-completion-advisory/state-authority-isolation.json)、[Workflow 确定性优先](../evidence/r5-5-review-completion-advisory/workflow-deterministic-over-advisory.json)、[LANGUAGE-only scope](../evidence/r5-5-review-completion-advisory/completion-advisory-scope.json) 和 [旧链回归](../evidence/r5-5-review-completion-advisory/legacy-regressions.json)。

package 在项目内既有物理 native dependency 副本 `.tmp/g3-verify` 执行原 `npm run package`，避免 Node/Electron ABI 污染。280 个构建输入核对中，运行源码逐字节一致；`tsconfig.base.json` 只有 CRLF/LF 差异，规范化 UTF-8 文本及 JSON 完全相同，两份原始 hash 如实保留。无 NODE_OPTIONS preload，所有 TEMP/cache/profile/Workspace 在项目内。详见 [build-provenance.json](../evidence/r5-5-review-completion-advisory/build-provenance.json)。

三个 OFFICIAL v1 manifestHash/contentHash 与冻结基线完全一致，见 [frozen-hashes.json](../evidence/r5-5-review-completion-advisory/frozen-hashes.json)。无 migration、无新增依赖，latest migration 仍为 0030。

## 限制与审批范围

只有建议事实，没有用户 Review 创建/自动继续策略；不修改既有事件历史。Cloud 配置关闭或建议失败可独立完成原执行。真实 Jev 的准确性/延迟未在本轮验证；后续如需联调须单独提供安全导入的 Key。

Live Jev：**NOT RUN**，按用户选择仅离线验收。完成后 push main 并等待审批。
