# W1 packaged evidence

验收日期：2026-10-01；基线 `main@1bd326479aa3a248f63eb6b7ff0e139a6e0d1aa2`。

[运行 manifest](manifest.json) 来自真实 Windows x64 / Electron 44.4.3 packaged app，记录 Workflow、Step、Mission/Run、真实 actor/runtime Usage 与只读 SQLite 检查。使用明确开启的 FakeModelGateway / Fake Decision / W1 Definition 夹具；正常启动不会注册这些定义，也没有官方 Built-in 模板。

截图原件：

- [待启动，1180×780](01-workflow-ready.png)
- [顺序运行完成，1440×900](02-workflow-completed.png)
- [窄窗口，900×600](03-workflow-completed-900.png)
- [本尊产物验收后完成，1180×780](04-human-bridge-workflow.png)

窗口尺寸以 Electron `BrowserWindow.setSize` 设置；截图受 Windows DPI 影响，像素尺寸可大于逻辑窗口尺寸。对应 `*-layout.json` 记录实际 viewport、零页面横向溢出及可滚动检查。截图经过人工视觉检查。

真实场景包括：UI 创建固定版本 Run；TASK→R4→原 Mission；REVIEW structured verdict；DECISION 声明分支；Artifact lineage/validation/checkpoint；原 Party collaboration approval 与成员独立 Runtime Usage；原 Tool approval 关闭/重启后同 Run 恢复；本尊 WAITING_EXTERNAL_WORK 关闭/重启、提交 Workspace 文件、ACCEPT、同 Run 完成与实际文件 hash；Step Retry 保留旧 Artifact。

两处强制终止场景分别验证：Mission 已 COMPLETED 而 Step 尚未提交时，启动补做验证/checkpoint，零重复 model call；model.call_started 后未产出结果时，启动进入 USER_CONFIRMATION，零自动模型/工具重放。再次重启保持 checkpoint/Artifact 幂等，foreign_key_check 为空，schema=17。

完整 `npm run smoke:package` 同时回归 Gate 0–6/R0–R4。完整原始 profile 为项目内 `.test-data/w1-packaged-a7511547-5ab6-4971-b3c1-d8439681bd36`；旧 UI 回归 35 张原件位于 `.test-data/r3-3-ui-ca192b26-40a4-451f-91b9-826a85de6a1d`。SQLite、Credential、私有 Memory 与缓存不提交。
