# R3.3 Windows Packaged Visual Evidence

2026-09-30，真实 Windows x64 packaged app：Electron 44.4.3。

- 原始运行 ID：`2c80e8e2-be2d-4599-a93e-2bb95ef2d501`。
- `npm run smoke:package` 的最终完整 Gate 0–6 / R0–R3.3 回归退出 0。
- 32 张原始 PNG；没有重新绘制或缩放。窗口使用实际 `BrowserWindow.setSize`，不是浏览器开发页或仅修改 viewport。
- Windows 125% DPI：1440×900 / 1180×780 / 900×600 DIP 对应 1800×1125 / 1475×975 / 1125×750 PNG。
- [完整状态与验收矩阵](../../status/r3-3-ui-information-architecture-reset.md)
- [原始证据 manifest](evidence-manifest.json)：原始路径、窗口大小、交互断言。
- [布局测量](ui-measurements.json)：无页面横向溢出、可见字段外部 Label、无 placeholder。

所有人物、模型回复、Memory 和 Benchmark 是确定性验收 fixture；86 分明确标记为测试数据，不是产品内置榜单。Credential 内容没有进入截图。Streaming 图使用真实 IPC delta 的测试屏障稳定捕获，随后原序释放事件；没有伪造 DOM 或消息。视觉审批仍待用户确认。

## 截图索引

| Screenshot                                                                               | Window (DIP) |
| ---------------------------------------------------------------------------------------- | ------------ |
| [01-home-empty-1440.png](01-home-empty-1440.png)                                         | 1440 × 900   |
| [shell-logo-16.png](shell-logo-16.png)                                                   | 1440 × 900   |
| [shell-logo-24.png](shell-logo-24.png)                                                   | 1440 × 900   |
| [shell-logo-32.png](shell-logo-32.png)                                                   | 1440 × 900   |
| [shell-logo-48.png](shell-logo-48.png)                                                   | 1440 × 900   |
| [02-home-active-1440.png](02-home-active-1440.png)                                       | 1440 × 900   |
| [03-teammates-list-1440.png](03-teammates-list-1440.png)                                 | 1440 × 900   |
| [04-teammate-detail-1440.png](04-teammate-detail-1440.png)                               | 1440 × 900   |
| [05-create-teammate-identity-1440.png](05-create-teammate-identity-1440.png)             | 1440 × 900   |
| [06-create-teammate-model-1440.png](06-create-teammate-model-1440.png)                   | 1440 × 900   |
| [create-teammate-new-model-tested-1440.png](create-teammate-new-model-tested-1440.png)   | 1440 × 900   |
| [create-teammate-new-model-confirm-1440.png](create-teammate-new-model-confirm-1440.png) | 1440 × 900   |
| [07-party-detail-1440.png](07-party-detail-1440.png)                                     | 1440 × 900   |
| [party-human-bridge-1440.png](party-human-bridge-1440.png)                               | 1440 × 900   |
| [08-mission-detail-1440.png](08-mission-detail-1440.png)                                 | 1440 × 900   |
| [09-memory-1440.png](09-memory-1440.png)                                                 | 1440 × 900   |
| [10-settings-models-1440.png](10-settings-models-1440.png)                               | 1440 × 900   |
| [settings-credential-rotation-1440.png](settings-credential-rotation-1440.png)           | 1440 × 900   |
| [11-human-bridge-1440.png](11-human-bridge-1440.png)                                     | 1440 × 900   |
| [12-teammate-detail-1180.png](12-teammate-detail-1180.png)                               | 1180 × 780   |
| [13-mission-detail-1180.png](13-mission-detail-1180.png)                                 | 1180 × 780   |
| [14-home-900.png](14-home-900.png)                                                       | 902 × 602    |
| [15-teammates-900.png](15-teammates-900.png)                                             | 902 × 602    |
| [16-settings-900.png](16-settings-900.png)                                               | 902 × 602    |
| [settings-model-content-900.png](settings-model-content-900.png)                         | 902 × 602    |
| [chat-empty-1440.png](chat-empty-1440.png)                                               | 1440 × 900   |
| [chat-conversation-1440.png](chat-conversation-1440.png)                                 | 1440 × 900   |
| [chat-streaming-1440.png](chat-streaming-1440.png)                                       | 1440 × 900   |
| [chat-long-content-1440.png](chat-long-content-1440.png)                                 | 1440 × 900   |
| [chat-unavailable-1440.png](chat-unavailable-1440.png)                                   | 1440 × 900   |
| [chat-conversation-drawer-900.png](chat-conversation-drawer-900.png)                     | 902 × 602    |
| [chat-conversation-900.png](chat-conversation-900.png)                                   | 902 × 602    |
