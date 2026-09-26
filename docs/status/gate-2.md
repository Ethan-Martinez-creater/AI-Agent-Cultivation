# Gate 2 状态

状态：实现与本机验证完成，待用户审批。

## 本 Gate 实现

- Main 中的 Memory repository/application service/typed IPC 与 Renderer 页面支持手工创建、列表、编辑、归档，以及从 Chat 证据提取 `PROPOSED` 后显式接受、编辑或拒绝。provenance 包含 owner、类型、来源、conversation/message、创建时间和确认时间。
- 候选提取使用 AI SDK 6 `Output.object` 与 Zod。模型只返回内容草稿；应用服务固定 owner 和 `PROPOSED`，不允许模型直接写入 ACTIVE。提取失败只影响附加流程，不回滚已保存 Chat。
- FTS5 检索先在 SQL 按 `owner_type + owner_id + status=ACTIVE` 限定当前道友，再为限定集合建立临时索引；相关度、recency 和 importance 用于排序。PromptComposer 再检查 owner/status，并限制 Top-K 与注入字符数。
- PromptComposer 分开处理 platform policy、道友身份/行为、相关 Memory、已启用 Skill 与会话上下文。Skill 是纯声明式 instructions/metadata，支持版本快照、归档，以及逐道友分配/启停。
- `sqlite-vec` 是可选扩展。只在 Main 中装载 DLL；向量 SQL 先物化当前道友 ACTIVE scope，再计算距离，与 FTS5 结果融合。未配置 embedding Runtime 或向量调用失败时保持 FTS5 完整可用。embedding 调用单独记录 Usage。

## 第一红线：Memory owner 隔离

`Gate2SqliteRepository.searchActiveMemories` 的第一次读取为 indexed `memories(owner_type, owner_id, status)` 查询。只有该查询返回的行进入临时 FTS5 表。向量路径使用 `WITH scoped AS MATERIALIZED` 对同一 owner/status 做 SQL 限定。应用服务与 PromptComposer 再防御性复核，拒绝把其他道友、未确认、已拒绝、已归档或过期记忆送入 Chat。

## 依赖和迁移

- 新依赖：`sqlite-vec-windows-x64@0.1.9`，固定版本；DLL 作为 Electron extraResource 打包。AI SDK 6、Zod 与原有 Provider adapter 延用 Gate 1 版本。
- `migrations/0003_gate2.sql`：Memory provenance/确认状态、逐道友 Skill 启停、不可变 Skill revision、embedding 设置与向量缓存。`0001_initial.sql` 和 `0002_gate1.sql` 保持不变。
- 技术 Spike：开发态和 Windows packaged Electron 均实际装载 `vec0.dll`，执行 `vec_version()` 与近邻查询，版本 `v0.1.9`。上游 vec0 virtual table 在 Windows JS binding 的 rowid 输入需要 BigInt；本实现采用普通 SQLite BLOB 表及 `vec_distance_cosine`，避免 rowid 兼容问题。未配置 embedding Provider 无任何外部请求。

## 测试与验证

- `npm run test`：12 个文件、52 个确定性测试通过。覆盖 Memory SQL scope、应用层二次隔离、review 状态迁移、Chat 附加提取失败、Skill 版本与分配、PromptComposer、真实 sqlite-vec 开发态 DLL 装载和 owner/status 向量隔离、embedding 回退与 Usage。
- `npm run typecheck`、`npm run lint`、`npm run format:check`：全部通过。
- `npm run package`：Windows x64 Electron 44.4.3 打包通过，`better-sqlite3` native module 与 `vec0.dll` 已进入包。打包使用仓库内现有的 Electron zip、本机 E: 临时目录；直连下载的 `ECONNRESET` 不影响离线打包。
- `npm run smoke:package`：已打包应用真实启动，九页导航、typed IPC、Main Credential 边界和 SQLite 查询继续通过；Gate 2 通过 Memory create/edit/archive、PROPOSED accept/reject、跨道友 IPC 拒绝、Chat prompt owner/status 隔离、Skill 版本/分配/启停、Runtime Migration 后原 Memory/Skill 注入、embedding Usage 归属与真实 packaged DLL 装载及向量持久化断言。核心流程使用 FakeModelGateway，无外部 API。

## 已知问题和架构偏差

- embedding 为用户显式配置的可选 Runtime，支持 OpenAI、Google 和 Generic OpenAI-Compatible；Anthropic/DeepSeek 没有在本 Gate 扩展 embedding adapter。创建或切换 embedding Runtime 后，现有 ACTIVE 记忆需要在设置页按道友重建索引。FTS5 始终可用。
- 实际 Provider 联调需要用户自己的 Credential；仓库和确定性测试不包含 API Key。向量服务端未报告的 token 字段保持 `NULL`。
- Skill 的版本写入有 SQLite 事务和不可变 revision 约束；跨进程并发编辑没有单独的预期版本 CAS。当前应用是单 Main 进程。
- 保留 Gate 0 Mission/Tool/Party 等领域壳；本 Gate 没有实现 Mission Runtime、Tool/MCP、多 Agent 协作。

## 下一 Gate

Gate 2 完成并 push 后停止，等待用户审批。
