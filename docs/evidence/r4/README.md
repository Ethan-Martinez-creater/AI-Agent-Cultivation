# R4 Windows packaged evidence

验收：2026-10-01；基线 `main@a9f6482760d236541e3bb0e1ffde6494e4f1f195`。

[运行 manifest](evidence-manifest.json) 记录六项验证、375 项测试、实际 Mission/Run IDs 与 UI 检查。截图来自真实 Windows x64 packaged app，未伪造 DOM。R4 使用 FakeModelGateway/Fake Decision fixture 验证实际 typed IPC、Main、native SQLite、状态机与归属；真实 Jev adapter 使用确定性 Fetch seam 契约测试，不宣称外网 API 联调。

- [自动分配创建](missions-auto-create-1180.png)：能力选项默认无勾选，由独立 consent 下的任务分析提供需求。
- [分配 receipt](mission-receipt-1180.png)：Benchmark 90/60、bounded semantic signal、顺序 Availability 与最终执行者。
- [不可用的显式选择](mission-unavailable-choice-1180.png)：归档道友仍保持明确选择，不自动替换，不 probe 归档身份。
- [Cloud 设置](settings-routing-900.png)：独立主动路由开关、私密内容排除与旧 SHADOW 隔离。

R4 补充截图使用 900/1180 内容 viewport。原 R3.3 全量 packaged 回归继续覆盖实际 1440/1180/900 窗口和 35 张截图，完整原件路径见 manifest。测试 profile/SQLite 未提交，仓库中不含 API Key、Credential 或 raw Memory。
