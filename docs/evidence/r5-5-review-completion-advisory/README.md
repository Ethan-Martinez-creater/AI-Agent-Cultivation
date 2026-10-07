# R5.5 验收证据

本轮新增严格 Completion Advisory，不赋予状态或执行 authority。

- `validation/`：最终六项原命令日志；`dev-*` 是开发 focused 日志，不能代替最终轮。
- 最终 packaged UUID 子目录：SOLO satisfied/concern/contradiction、Cloud-off、Party actor、Workflow hard validation/review、G3 structured outcome、restart zero replay，以及三档 Privacy 截图。
- `acceptance.json`：最终结果与测试数量。
- `frozen-hashes.json`：三个 OFFICIAL v1 原始 manifest/content hash 对比。
- 阶段 regression JSON：从最终完整旧链 facts/SQLite 投影安全元数据；不保存私有正文、Key、env 或 Tool output。

所有离线 profile/Workspace/TEMP 在项目目录。正常 production bootstrap 不启用 fixture observer、fixture Workflow 或测试 Main/Renderer authority。Live Jev = NOT RUN。

最终六项只接受最后一个完整成功轮；失败/开发日志按实际记录保留。

## 最终验收

142 files / **1290 tests**，六项原命令全部 PASS。无 migration、无新增依赖；Live Jev = NOT RUN。

- 最终事实与三档截图：[21e88284-32f7-42ac-a6c5-a5adb3c8368d](./21e88284-32f7-42ac-a6c5-a5adb3c8368d/)。其他 UUID 是开发 focused evidence，不作为最终轮。
- [acceptance.json](./acceptance.json)：原命令、exitCode、日志 hash、测试数量。
- [state-authority-isolation.json](./state-authority-isolation.json)、[cloud-off-fallback.json](./cloud-off-fallback.json)：相反建议不会改变原终态/调用计数，Cloud off 零 Jev。
- [party-actor-isolation.json](./party-actor-isolation.json)、[g3-structured-outcome.json](./g3-structured-outcome.json)：实际 actor、原 structured RESULT、零新增 continuation。
- [workflow-deterministic-over-advisory.json](./workflow-deterministic-over-advisory.json)、[restart-no-replay.json](./restart-no-replay.json)：validation/REVISE 优先，无重放。
- [completion-advisory-scope.json](./completion-advisory-scope.json)：实际 SQLite 的 GENERATION/Human Bridge target 零建议。
- [legacy-regressions.json](./legacy-regressions.json)、[generation-human-unknown-regressions.json](./generation-human-unknown-regressions.json)：最终 R5.1–R5.4、Generation/Human Bridge/UNKNOWN/W2 回归摘要。
- [frozen-hashes.json](./frozen-hashes.json)、[build-provenance.json](./build-provenance.json)：冻结 hash 与 root/隔离构建源码核对。只有 tsconfig.base.json 换行格式不同，语义相同；原始 hash 分别记录。

原始隔离 profile/SQLite 位于未入库的 `.test-data`。本目录保留可分享的安全 metadata 摘要和日志，原始正文与密钥不归档。`dev-full-test-superseded.txt` 为 async dispatch 修复前的中间全量轮，最终采用 `validation/test.txt` 的 1290 项结果。
