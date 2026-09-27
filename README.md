# AI Agent Cultivation

AI Agent Cultivation 是面向 Windows x64 的本地优先 AI 队友桌面应用。Gate 6 将现有 Gate 0–5 功能作为可安装 Alpha 版本发布；它是桌面打包与发布阶段，不新增 Agent 能力。应用提供 Provider、道友、Chat、Mission、受控文件工具和手动配置的 MCP stdio Server。模型调用只会发送到用户配置并主动使用的 Provider。

## 安装 Alpha

从可信的 Alpha 发布包中运行 `AI Agent Cultivation Setup.exe`。安装器使用 Squirrel.Windows 进行当前 Windows 用户范围的安装，不需要管理员权限，并创建开始菜单快捷方式。`RELEASES` 与 `AiAgentCultivation-<version>-full.nupkg` 是 Forge 为 Squirrel 发布生成的配套文件；Alpha 当前没有配置自动更新服务。

卸载请使用 Windows“已安装的应用”。卸载只移除应用安装文件，用户数据保留在本机。若需要迁移或删除数据，请先退出应用，再备份或自行处理下方 `userData` 目录。

安装包尚未进行代码签名。Windows 可能对未知发布者显示提示；只安装你信任的构建来源。

## 配置 Provider

首次使用时打开“设置 Settings”，添加 OpenAI 或 Anthropic Provider。保存凭据前，先在其他应用复制 API Key，再选择对应 Provider、填写凭据标签并点击“从剪贴板安全导入”。接着创建包含 Provider、凭据和模型 ID 的 Runtime；模型 ID 由你填写，并应与 Provider 支持的模型一致。随后在“道友 Teammates”中为道友选择该 Runtime。未配置 Provider 时，应用不会执行真实模型请求。

API Key 由 Main 进程管理。应用通过 Electron `safeStorage` 将密钥加密后保存；数据库只保存密文，Renderer API 不返回密钥或密文。加密能力依赖当前 Windows 用户账户，本 Alpha 不提供跨账户的密钥迁移。

## 本地数据与安全边界

SQLite 数据库位于 Electron `app.getPath('userData')/data/cultivation.sqlite`。Windows 默认将 `userData` 放在当前用户的 `%APPDATA%` 下；它不位于安装目录、项目目录或发布包中。升级和卸载都不会清除该目录。请自行定期备份。

MCP 在此版本中仅作为客户端。用户手动配置本地 stdio MCP Server；应用不会替 Agent 安装、下载或修改 MCP Server。发现和执行的 MCP 工具都经过 schema 校验、统一工具运行时、权限判断及审计，MCP 执行按高风险处理。MCP 子进程只获得 Windows 启动所需的固定环境项和用户允许的环境变量。

## 开发与验证

开发环境：Windows x64、Node.js 24、npm 11。`better-sqlite3` 缺少匹配的预编译包时需要 C++ Build Tools。

```sh
npm ci
npm run dev
npm run test
npm run typecheck
npm run lint
npm run package
npm run make
npm run smoke:package
npm run smoke:installer
```

`npm run package` 生成可直接运行的目录 `out/AI Agent Cultivation-win32-x64/`。`npm run make` 生成 Squirrel 安装器、完整 `.nupkg` 和 `RELEASES` 文件，位于 `out/make/squirrel.windows/x64/`。`npm run smoke:package` 验证已打包的应用；`npm run smoke:installer` 会生成安装包，在隔离的本地数据目录中安装、启动、关闭、重启、卸载并重装，核对数据保留，不需要 Provider 或 API Key。Smoke 目录默认位于 `E:\a6\`（源码目录之外；短路径用于兼容 Windows 原生构建工具）；可通过 `CULTIVATION_INSTALLER_SMOKE_ROOT` 指定 E: 上的其他隔离目录。目录保留供检查。

## 已知限制

- Alpha 仅提供 Windows x64 安装包；没有 macOS/Linux 版本、自动更新服务或代码签名。
- Provider API Key、Provider 账户和模型服务由用户自行提供；真实请求需要网络连接。
- 本地数据没有云同步。备份和恢复由用户负责；`safeStorage` 密文受当前 Windows 用户账户保护。
- MCP Server 由用户配置；应用不会自动下载或安装 Server。
- 不包含 Gate 7 或之后的 Agent 能力。

## 工程结构

- `apps/desktop`：Electron Main、Preload、React Renderer。Main 是组合根。
- `packages/domain`：纯 TypeScript 领域类型与状态机。
- `packages/application`：不依赖 Electron、数据库或 Provider 的应用服务。
- `packages/agent-runtime`：真实 Provider 与确定性 Fake Model adapter。
- `packages/persistence`：SQLite 仓库与显式迁移执行器。
- `migrations`：版本化 SQL。
- `docs/architecture` 与 `docs/decisions`：架构约束和决策。
