# R4 corrective packaged evidence

基线 `main@5ddc4429cef02948239b335395ddcdc46780bfb6`；验收 2026-10-01。

[运行 manifest](evidence-manifest.json) 记录 401 项测试、六项验证、真实 Mission/Run IDs、本尊明确选择的 receipt 与 packaged 检查。新 [本尊创建截图](mission-human-bridge-1180.png) 展示独立执行方式和显式能力选择，另外四张为本轮自动分配/receipt/不可用选择/Cloud 设置回归原件。

测试真实点击本尊执行；缺少能力时不能提交。选择与两个 AVAILABLE 模型共同支持的通用推理后，本尊直接取得 assignment，模型 Availability 投影不变、候选/probe/Jev signals 为零。该 UI Mission 和原 AUTO fallback 均经过 WAITING_EXTERNAL_WORK → 关闭/重启 → artifact 提交 → ACCEPT，使用原 MissionRun 完成，SQLite continuation 为 CONSUMED、Usage 为零。

9 个 incompatible explicit constraint 经 typed IPC 拒绝并验证零新 receipt/probe；SOLO/PARTY 不得降级；Workspace 未配置仍要求用户处理。原 Gate 0–6/R0–R4 与 35 张旧 UI 回归全部通过。

R4 补充截图为 900/1180 viewport，历史 UI 回归继续覆盖实际 1440/1180/900 窗口。使用 FakeModelGateway/Fake Decision 与本地 HTTP fixture，不访问真实收费 API。SQLite profile、Credential/API Key、raw Memory 未提交。
