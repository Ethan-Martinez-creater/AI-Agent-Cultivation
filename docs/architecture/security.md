# 安全基线

## Electron 边界

- Renderer：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`。
- Preload：只暴露 `app.getVersion()` 和 `health.ping()`，不暴露通用 `send`、`invoke` 或明文密钥。
- Main：IPC 校验 sender、主 frame 与来源 URL，并用 Zod 校验参数数量。
- 窗口禁止任意导航、弹窗和 WebView；所有网页权限请求默认拒绝。
- CSP 限制脚本、资源、连接和嵌入。开发模式经 HTTP 响应头允许 Vite 本地 HMR WebSocket；打包后的 `file://` 页面在构建时写入更严格的 CSP meta。

## 数据与凭证

- SQLite 保存于 Electron `userData`，不写入安装目录或仓库。
- `provider_credentials.ciphertext` 是 BLOB；未来仅由 Main 使用 OS `safeStorage` 加密后写入。Gate 0 不实现凭证设置，不存真实 API Key。
- `mission_events` 是 append-only 业务事件；`audit_events` 是独立安全审计表。后续业务实现须补充只增写入策略和脱敏日志。
- 工具调用与 Memory 写入功能尚未开放，后续必须先经过权限/审批链路。
