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
- Built-in/MCP 工具统一经 ToolRegistry、input validation、PermissionEngine、Approval 和 Audit；exact Mission grant 不扩为 wildcard，tool-call/result transcript 保持 untrusted tool data。Memory 按 owner scope 在 SQL 先过滤，候选只经用户审核转 ACTIVE。

## R4 Cloud 与路由权限

- R4 Cloud 主动路由单独 opt-in，默认关闭，旧 R3 SHADOW 启用不等于主动路由许可。Jev key 继续由 Main safeStorage/受控环境读取；Renderer 只见配置状态。
- 发往云端的内容限于脱敏、有界 task summary、确定性合格 Top-K 身份/角色、Benchmark band、enabled Skill metadata 与已核验 Experience summary；不查询私有 Memory、聊天历史、文件正文或 Tool output。
- Jev 不能把不合格候选重新加入，也不能绕过用户显式选择、PermissionEngine 或协作审批。新增 AD_HOC Party 仍由真实持久道友执行，成员 grant 不继承 Coordinator。
- Receipt/Audit 只追加安全选择元数据。USER_ACTION_REQUIRED 不创建或启动 Mission；选中模型后仍由原执行链再次检查 sealed identity/Availability。Human Bridge fallback 使用原 Workspace artifact validation、用户 ACCEPT 和 durable continuation，不执行 Shell、Browser 或自动安装操作。
