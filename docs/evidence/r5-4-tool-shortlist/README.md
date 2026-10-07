# R5.4 Tool Shortlist evidence

基线：`98dd00c9676858335deea1555359d3beca940a31`。本轮仅覆盖既有 LANGUAGE Tool loop。Live Jev **NOT RUN**，验收使用显式 test flags 的 FakeDecisionGateway / FakeModelGateway 与真实 Windows Electron package、SQLite、文件和 stdio MCP fixture。

## 最终验收

最终 Windows packaged run：`42ac6ed1-0e55-4e78-a761-c7d4f0b0f53b/`，包含本轮事实与 1440/1180/900 三档截图。

| 文件                                  | 证明                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `acceptance.json`                     | A–G、测试数、正式生产隔离                                                    |
| `final-packaged-facts.json`           | 当前完整 `npm run smoke:package` 最后 R5.4 run 的 bounded ID/hash/shape 事实 |
| `deterministic-fallback.json`         | Cloud off 零 Jev、完整 registry 顺序；超过候选预算不截断                     |
| `offered-set-enforcement.json`        | 已注册但未 offered 的 ID：零 dispatch / Permission / Guard / execution       |
| `permission-proof.json`               | 实际 Permission DENY、用户 DENY、ASK 重启原 Run/call、批准后一次执行         |
| `party-actor-isolation.json`          | A/B 各自 shortlist/runtime/Permission，B 不继承 A grant                      |
| `workflow-toolguard.json`             | 可信 Step eligibility，原 Permission 与 WorkflowToolGuard 执行               |
| `skill-regression.json`               | R5.1 actor isolation / fallback                                              |
| `memory-pre-gate-regression.json`     | R5.2 RUN/SKIP/fallback/PROPOSED review                                       |
| `memory-rerank-regression.json`       | R5.3 owner-first、Cloud-off、stale recheck、Party/Workflow scope             |
| `generation-regression.json`          | G1/G2/G3 UNKNOWN / recovery / LANGUAGE vs GENERATION isolation               |
| `w2-mutation-restart-regression.json` | 官方 Workflow、operation receipt 与 UNKNOWN zero replay                      |
| `frozen-hashes.json`                  | 生产 SQLite 中三个 OFFICIAL v1 manifest/content hash                         |
| `build-provenance.json`               | root 与 ABI 隔离构建目录的运行源码一致性、app.asar hash                      |

`validation/` 保留六项原命令日志。`*-interim*`、`*-failed*` 和 `smoke-focused-*` 为开发记录，不替代最终 `test.txt / typecheck.txt / lint.txt / format-check.txt / package.txt / smoke-package.txt`。Focused #02 曾使用尚未包含 observer responseBytes 的旧 package；重新 package 后 focused #03 与最终完整链通过。

`*-before-cloud-recheck*` 是最终 Cloud 复核修复前的完整通过记录，随后六项验证重新执行。最终格式检查曾发现旧 smoke 新生成的十个未跟踪 JSON 未格式化；只格式化列出的文件后重新执行原命令，未新增 ignore 或删除证据。

## 隔离与证据边界

所有 profile、Workspace、TEMP 和 native ABI 构建副本位于当前项目目录。Windows app 串行启动/关闭；不存在 Renderer fixture SQL/权限接口。Permission DENY 的数据库准备仅由离线测试 harness 在关闭 app 后写入独立 profile；生产无该入口。

事件/审计只存有限 ID、score、fingerprint、version/hash/byte count，归档不保存 args、Tool output、文件/Artifact/Memory/Skill body、Credential、完整 schema 或隐藏推理。测试源码中的 spy 断言用于证明 Permission/dispatch 的零调用；packaged 事实用于证明真实 state、Approval、文件/MCP result 与 SQLite 归属。

路由隐私说明的真实 packaged 截图覆盖 1440/1180/900；文件名为 `routing-tool-shortlist-privacy-<width>.png`，同目录 layout JSON 保存实际窗口和布局测量。Windows 125% DPI 会使 PNG 像素尺寸不同于逻辑窗口尺寸。

无 migration，无新增依赖，不进入 R5.5/W3/R6。
