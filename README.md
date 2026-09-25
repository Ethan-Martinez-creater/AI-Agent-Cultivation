# AI Agent Cultivation

面向 Windows 的本地优先 AI 队友应用。目前只实现 [Gate 0](docs/status/gate-0.md) 工程基线，尚无真实 Provider、Chat 或 Mission 执行。

## 开发环境

- Windows x64
- Node.js 24 与 npm 11
- C++ Build Tools（仅在 `better-sqlite3` 没有匹配预编译包时需要）

```sh
npm install
npm run dev
npm run test
npm run typecheck
npm run lint
npm run package
```

应用数据位于 Electron `app.getPath('userData')/data/cultivation.sqlite`，不会写入仓库或安装目录。`npm run package` 产物位于 `out/AI Agent Cultivation-win32-x64/`。运行 `AI-Agent-Cultivation.exe --gate0-smoke` 可以验证打包后的 Electron 主进程和原生 SQLite 模块。

## 工程结构

- `apps/desktop`：Electron Main、Preload、React Renderer。Main 是组合根。
- `packages/domain`：纯 TypeScript 领域类型与 Mission 状态机。
- `packages/application`：不依赖 Electron/DB/Provider 的端口接口。
- `packages/agent-runtime`：Gate 0 的确定性 Fake Model。
- `packages/persistence`：SQLite 路径和显式迁移执行器。
- `migrations`：版本化 SQL。
- `docs/architecture` 与 `docs/decisions`：架构约束和决策。

UI 只提供导航壳。道友身份通过 `currentRuntimeProfileId` 引用可替换运行配置，没有直接嵌入 Provider 或 Model。数据库凭证表仅为后续 `safeStorage` 密文预留；Gate 0 不写入真实密钥。

## 常见问题

- **Windows 原生模块安装失败**：确认当前 Node 版本和 C++ Build Tools，然后重新运行 `npm install`。Forge 打包时会对 Electron ABI 执行 rebuild。
- **开发页面空白**：检查主进程和 Vite 控制台日志；Renderer 仅通过 Preload 暴露的 `app.getVersion()` 与 `health.ping()` 调用 Main。
- **数据库路径**：Windows 下位于 Electron 用户数据目录，可通过 `--gate0-smoke` 验证打开和迁移。不要删除有业务数据的数据库。
