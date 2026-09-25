# Gate 1 状态

状态：实现与本机验证完成，待用户审批。

## 本 Gate 完成内容

- Provider/Credential → RuntimeProfile → Teammate → 单道友 Conversation → Streaming → Usage → Runtime Migration 闭环。
- Main 从系统剪贴板读取新 Credential，并用 Electron `safeStorage` 加密后清空剪贴板；数据库只存 BLOB 密文。Renderer 只提交 Provider ID 与标签，既不接触新输入的明文，也无法读取已保存的明文或密文。
- AI SDK 6 Core 与 OpenAI、Anthropic、Google、DeepSeek、Generic OpenAI-Compatible adapter。领域 Agent 与 SDK 调用层分离。
- Settings、Teammates、单道友 Chat、Usage 页面；其余页面保持 Gate 0 壳，不接入后续 Gate 业务。

## 未完成内容

Memory、Mission Runtime、Tool/MCP、多 Agent 协作等 Gate 2+ 功能尚未实现。

## 架构偏差与约束

Gate 0 的 `messages.conversation_id` 没有道友归属，Gate 1 新增 `conversations` 并在 Chat 消息中固定 `teammate_id`，复合外键与查询双重限制跨道友读取。Conversation 与 Mission 分离：Chat 消息的 `mission_id` 为 `NULL`，既有 Mission 消息不被移入 Chat。无法安全判定归属的旧消息保存在 `legacy_unscoped_messages`，供后续人工检查。

Provider 没有返回 token 数时，`UsageRecord.inputTokens`/`outputTokens` 保留 `NULL`，不写虚构的零。Provider 字段保存 Provider 配置 ID，Model 字段保存调用当时的 model ID；切换 Runtime 不会重写旧 Usage。连接测试只向 Provider 的 models 目录发送不生成内容的 GET 请求，不产生模型 Usage；每次 Chat 模型调用均写入对应道友的 UsageRecord。

## 新增依赖

AI SDK Core `ai@6.0.291`；Provider adapter `@ai-sdk/openai@3.0.118`、`@ai-sdk/anthropic@3.0.122`、`@ai-sdk/google@3.0.127`、`@ai-sdk/deepseek@2.0.67`、`@ai-sdk/openai-compatible@2.0.78`。均固定精确版本，详见 `package-lock.json`。

## DB migration

`migrations/0002_gate1.sql`：新增 Conversation 归属及索引，重建 Message 表以约束 Chat 归属、保留旧 Mission 消息，重建 Usage 表使缺失 token 字段可存 `NULL`。`0001_initial.sql` 不变。

## 测试列表与输出

- `npm run test`：6 个文件、32 个确定性测试全部通过；覆盖五种 Provider adapter 的 mock fetch、SecretStore、凭证摘要、Conversation 隔离、Runtime 切换与 Usage 归属、SQLite migration。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run format:check`：通过。
- `npm run package`：Windows x64 Electron 44.4.3 打包完成，`better-sqlite3` native dependency 成功处理。
- `npm run smoke:package`：启动已打包应用，通过九页导航、typed IPC、真实 SQLite 查询、Main safeStorage 加密及 BLOB 检查、Renderer 凭证边界、双 Provider/Runtime、切换后历史会话、并行流隔离和 Usage 归属。

## 已知问题

- 未在仓库或 CI 中配置真实 API Key；五种真实 Provider 的外部连通性由用户自行在 Settings 中测试。核心测试与打包烟雾测试使用 FakeModelGateway，无网络依赖。
- `safeStorage` 的保护强度取决于本机操作系统账户与密钥存储；系统加密不可用时创建 Credential 会失败，不降级为明文。
- Settings 的 Test Connection 验证 Provider 的 models 目录与认证，不运行手工填写的 model ID；目录可用并不保证该 model ID 能生成回复。部分 Generic OpenAI-Compatible 服务没有 models 目录，可能无法通过此诊断，但仍可在 Chat 中使用。

## 下一 Gate

等待 Gate 1 审批；不提前推进 Gate 2。
