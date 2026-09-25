# 安全基线

## Electron 边界

- Renderer：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`。
- Preload：只暴露按功能命名的 Provider、Credential、Runtime、Teammate、Chat 与 Usage 方法，不暴露通用 `send`、`invoke`、密钥或密文；Chat 事件回调不传递 Electron event 对象。
- Main：IPC 校验 sender、主 frame 与来源 URL，并用 Zod 校验参数数量。
- 窗口禁止任意导航、弹窗和 WebView；所有网页权限请求默认拒绝。
- CSP 限制脚本、资源、连接和嵌入。开发模式经 HTTP 响应头允许 Vite 本地 HMR WebSocket；打包后的 `file://` 页面在构建时写入更严格的 CSP meta。

## 数据与凭证

- SQLite 保存于 Electron `userData`，不写入安装目录或仓库。
- `provider_credentials.ciphertext` 是 BLOB；Main 从系统剪贴板读取新 API Key，清空剪贴板后使用 OS `safeStorage` 加密写入。Renderer 只提交 Provider ID 与标签，不接收新 Key、已保存的明文或密文；系统加密不可用时拒绝保存。
- Provider 调用由 Main 解密并发起；Provider HTTP 请求拒绝重定向，避免认证头被转发。IPC 校验来源及输入，错误消息固定为脱敏文本；不记录 Key、密文或 Provider 原始异常。Provider Base URL 禁止用户名、密码、查询参数及片段，避免把密钥误存为明文配置。
- `mission_events` 是 append-only 业务事件；`audit_events` 是独立安全审计表。后续业务实现须补充只增写入策略和脱敏日志。
- 工具调用与 Memory 写入功能尚未开放，后续必须先经过权限/审批链路。
