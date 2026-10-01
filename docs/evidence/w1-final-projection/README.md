# W1 final projection — packaged evidence

验收日期 2026-10-01，基线 `main@0c7092f1cde21017756708b137eeb4531185376b`。来自本轮完整 `npm run smoke:package` 的真实 Windows x64 / Electron 44.4.3 应用；明确开启 FakeModel/FakeDecision/test-only definitions，不发布官方 Workflow。

[Manifest](manifest.json) 保存冻结输入、final receipt、Mission/Run 与真实 actor/runtime Usage。[SQLite projection facts](projection-acceptance.json) 显示 v1 producer 与 final Contract 一致、v1/v2 分别完成、final receipt 每 Run 一次、两种不兼容 Definition 均未写入以及 foreign_key_check 为空。

Main 夹具在 publish 尝试中验证更强 final validator、required final 引用 optional producer 被拒绝；若意外接受，应用验收启动直接失败。真实 UI 提交输入并完成 exact final projection；typed IPC 创建并执行 v2，v1 仍保持原 schema/输入/版本。真实 SQLite UPDATE 尝试修改 Artifact hash、binding provenance 和 completed Step attempt 均拒绝。关闭/重启后 completed Step 不重跑，final receipt 不重复，原 Mission/Tool 调用计数不增加。

Artifact/hash/receipt/contract/MissionRun/latest attempt 的损坏，以及 final receipt 持久化失败的 quarantine，由确定性 application tests 使用故障 adapter 验证：FAILED + WORKFLOW_INTEGRITY_ERROR，零 silent replay。packaged SQLite 保持正式 append-only 防线，不为模拟损坏而放宽或移除正式 trigger。

截图原件：

- [待启动，1180×780](01-workflow-ready.png)
- [顺序完成，1440×900](02-workflow-completed.png)
- [窄窗口，900×600](03-workflow-completed-900.png)
- [本尊同 Run 交付完成，1180×780](04-human-bridge-workflow.png)
- [输入表单，1180×900](05-workflow-input-form.png)
- [只读冻结输入，1440×900](06-workflow-frozen-input.png)

对应 `*-layout.json` 检查可滚动、无页面横向溢出；Windows DPI 使截图像素尺寸可能大于窗口逻辑尺寸。原 Party/Tool approval、本尊 WAITING/ACCEPT continuation、Retry 历史以及 terminal→Step commit/in-flight 两处 crash recovery 全部回归。

完整 profile 在项目 `.test-data/w1-packaged-0ccbb16d-e17c-43a4-b021-1380ef07b796`。旧 UI 35 张回归原件在 `.test-data/r3-3-ui-2a094c38-d023-4298-815e-2dbfa86ef096`。数据库、缓存、Credential 和 exe 不提交，此目录仅合成验收数据。
