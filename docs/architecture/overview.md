# Gate 0 架构总览

```text
React Renderer --窄口 typed IPC--> Preload --> Electron Main
                                             ├── application ports
                                             ├── agent-runtime (Fake Model)
                                             └── persistence (SQLite)
shared <- domain <- application <- agent-runtime
```

`Teammate` 是核心身份，`RuntimeProfile` 是可替换运行配置。Main 为唯一组合根。Renderer 不能导入 Node、SQLite 或 Provider SDK。业务状态以 Main/本地 DB 为准；当前 UI 只有静态页面壳。

Gate 0 的 `ModelGateway` 接口与 `FakeModelGateway` 可用于未来不访问真实 LLM 的运行时测试。后续 Gate 才实现 Provider、Chat、Permission Engine 与 Mission Runtime。

存储使用 Electron 用户数据目录。SQL 迁移版本记录在 `schema_migrations`，初始化配置 `foreign_keys=ON` 和 `journal_mode=WAL`。Schema 包含计划中的 26 张 P0 表及迁移元数据表。
