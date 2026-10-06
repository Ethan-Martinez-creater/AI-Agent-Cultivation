# R5.1 Skill Routing evidence

基线：`ad2f61fb57453b6c0ff5c5bdebf751c2aa5ca077`。

- `validation/`：六项标准 npm 命令的完整日志。
- `acceptance.json`：127 个测试文件 / 1041 项测试、六项原命令和完整 packaged regression markers。
- `c91aec95-4137-478c-8c9e-dda748478350/`：最终完整 smoke 的 Windows facts 与截图；9 次实际调用 / 9 条 selection，真实 Mission、Party、Workflow execution、SQLite Event/Audit 与最终 Prompt 注入观察。
- `1b619bc5-4f85-4dfd-a250-623823b5209d/`：此前单独执行本轮 packaged 场景的补充证据。
- `frozen-hashes.json`：三个 OFFICIAL v1 的 manifest/content hash。
- `generation-regression.json`：旧 G1/G2/G3 packaged 恢复摘要，以及实际 SQLite 的 LANGUAGE-only selection 查询；GENERATION 无 LANGUAGE selection/injection。旧 Gate/R/W 全量证据同时记录于原 smoke 日志。

所有 Fake 使用显式测试 flag；正常 production bootstrap 单独验证，不加载 R5.1 Fake。真实 Jev API 本轮由用户选择不联调，状态为 NOT RUN。

测试数据、build cache 和隔离打包目录保存在项目内的 ignored `.test-data/`、`.tmp/`、cache 目录；截图与可审计摘要另行提交本目录。没有复制用户 Key、数据库 secret、Skill instructions 或 Memory 正文进入 evidence。
