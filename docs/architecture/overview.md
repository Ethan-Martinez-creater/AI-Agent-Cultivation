# Gate 0–1 架构总览

```text
React Renderer --方法级 typed IPC--> Preload --> Electron Main
                                               ├── Gate1Service
                                               ├── SecretStore (safeStorage)
                                               ├── ModelGateway (AI SDK 6 / Fake)
                                               └── Gate1SqliteRepository (SQLite)
shared <- domain <- application <- agent-runtime
```

`Teammate` 是核心身份，`RuntimeProfile` 是可替换运行配置。Main 为唯一组合根。Renderer 不能导入 Node、SQLite 或 Provider SDK。Gate 1 的 Settings、Teammates、单道友 Chat、Usage 页面通过专用 IPC 方法访问应用服务，业务状态以 Main/本地 DB 为准。

Gate 1 用 AI SDK 6 Core 实现五种 Provider adapter，同时保留 `FakeModelGateway` 进行无真实 API 的测试。`Conversation` 归属一个 Teammate，与未来的 Mission 执行分开；流事件带请求、道友与会话 ID，Usage 固定为调用时的 Runtime/Provider/Model 快照。Permission Engine 与 Mission Runtime 留待后续 Gate。

存储使用 Electron 用户数据目录。SQL 迁移版本记录在 `schema_migrations`，初始化配置 `foreign_keys=ON` 和 `journal_mode=WAL`。Gate 1 的 `0002_gate1.sql` 增加 Conversation 归属，并允许 Provider 未返回的 token 数为 `NULL`。
