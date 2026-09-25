# Gate 0 状态

状态：完成，等待代码评审。

## 本 Gate 完成内容

- npm workspaces、Electron Forge/Vite/React/TypeScript、Tailwind CSS、Lint/Format/Vitest 与 Playwright Electron 烟雾测试。
- Electron 安全配置、最小 typed IPC、九页可导航 UI 壳。
- 核心领域契约、Mission 状态机、应用端口和 Fake Model。
- SQLite 路径抽象、显式迁移和 26 张 P0 表；打包版已验证原生模块加载。
- Electron 固定至 44.4.3；Mission 权限作用域增加目标 ID，能够区分同一主体在不同 Mission 下的规则。

## 未完成内容

无 Gate 0 未完成项。真实 Provider、Chat、Mission Runtime、Permission Engine、Memory 检索与业务 CRUD 属于后续 Gate，未提前实现。

## 架构偏差

`PAUSED`、`READY → CANCELLED` 转移和部分未定义状态枚举由 Gate 0 补齐，详见 `docs/architecture/domain-model.md`。PostgreSQL 已存在，但基于计划的 Local First 要求选用 SQLite。Forge Vite 默认只复制 `.vite`，本项目额外显式复制 `better-sqlite3` 并从 ASAR 解包 `.node`。

Gate 0 复核时发现原 Electron 40.0.0 已结束支持，依要求升级到 44.4.3。原 `PermissionRule.scope = MISSION` 缺少 Mission 身份，无法区分不同任务；领域契约、权限查询端口与 `0001_initial.sql` 同步增加 `scopeId`/`scope_id`，并验证目标 Mission 存在。数据库仍处初始化阶段，因此直接修正初始 migration。

## 新增依赖

Electron Forge、Vite、React、React Router、Tailwind CSS、Zod、better-sqlite3、Vitest、Playwright Core、TypeScript、ESLint、Prettier。所有直接依赖版本在 `package.json` 固定，传递依赖由 `package-lock.json` 锁定。

## DB migration

`migrations/0001_initial.sql`；`schema_migrations` 记录应用版本。Mission 作用域权限须提供现存 Mission 的 ID，查询时按 `scope` 与 `scope_id` 精确匹配。

## 测试列表与输出

2026-09-25，Windows x64，Node 24.15.0：

| 验证                    | 结果                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run test`          | 3 个测试文件、8 个测试通过；新增不同 Mission 规则的隔离命中及无效 Mission ID 校验。                                     |
| `npm run typecheck`     | 通过。                                                                                                                  |
| `npm run lint`          | 通过。                                                                                                                  |
| `npm run package`       | Electron 44.4.3 打包通过，生成 `out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`。                          |
| `npm run smoke:package` | `GATE0_PACKAGED_SMOKE_OK navigation=9 ipc=ok native_sqlite=ok`。真实启动打包版、导航九页、调用 IPC 并执行 SQLite 查询。 |
| `npm run dev`           | 开发模式正常构建并启动，E 盘指定 `userData` 下生成 SQLite；验证后关闭。                                                 |

在本机执行 `npm run package` 时，Electron 44.4.3 ZIP 从可访问镜像下载，按 `node_modules/electron/checksums.json` 中的 SHA-256 校验后复制至 E 盘 `.electron-dist`，并通过 `CULTIVATION_ELECTRON_ZIP_DIR` 指定本地输入。打包器临时目录设为仓库外的 `E:\AI-Agent-Cultivation-Gate0-Temp`，以符合 Packager 对源/目标路径的要求。Electron 44.4.3 与现有 `better-sqlite3` 的打包组合通过了真实查询，无需额外兼容性改动。

## 已知问题

本机 Node 24 原生源码编译需要 ClangCL，但现有 Build Tools 未安装该组件。`better-sqlite3` 提供的 Windows x64 预编译模块在 Node 和打包后的 Electron 中均已通过真实查询；若未来升级版本导致无法使用预编译模块，需要重新评估工具链。GitHub Electron 大文件直连曾出现连接重置，本机镜像打包路径已验证。开发初期下载器曾在默认 C 盘缓存/临时目录留下文件；按本项目限制未自行清理，后续命令已把缓存和临时目录指向 E 盘。

## 下一 Gate

等待代码评审和用户下一步命令；当前不实现 Gate 1。
