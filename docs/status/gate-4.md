# Gate 4 状态

状态：Tool Runtime + File Workspace + MCP Client 已实现，待审批。

## 实现范围

- `ToolRegistry` 保存声明式 `ToolDescriptor`（来源、JSON inputSchema、capability、风险、sideEffect）；`ToolRuntime` 对 Built-in 和 MCP 调用统一执行 schema 校验、PermissionEngine、Approval、执行与结构化结果。模型通过 AI SDK 6 Core 的 tool call 提议工具，Renderer 没有直接执行工具或 MCP 的 IPC。
- SOLO Mission 使用原有 domain state machine 运行最多 8 个模型 step、8 个 tool call。每次模型调用均记录归属 Mission/Run/Teammate/Runtime 的 Usage；工具提议、审批、结果及失败进入 append-only MissionEvent/AuditEvent。拒绝和执行失败作为结构化 `TOOL_RESULT` 返回模型。单步多个 tool call 被拒绝并计入上限。
- 用户经 Tools 页面显式选择 Workspace Root。`file.list`、`file.readText`、`file.writeText`、`file.createDirectory` 仅接受相对路径；实际文件系统层检查 canonical root、路径组件、symlink/junction、traversal、Windows 特殊路径与 UTF-8/64 KiB 上限。资源授权包含 root 指纹与相对路径，切换根目录后旧授权不匹配。
- “Allow This Mission”创建 Mission-scope ALLOW grant，默认 ASK 和显式 DENY 沿用 Gate 3 优先级。Pending tool call 与 ApprovalRequest 一同持久化；重启后 WAITING_APPROVAL 保持，批准或拒绝只可处理一次并继续原 Run。审批等待期间工具资源若发生变化，返回 `TOOL_CHANGED`，不执行也不生成 grant。
- 用户手动配置 stdio MCP server 的 command/args/cwd/enabled/environment whitelist。Main 使用 MCP TypeScript SDK v2 Client 发现工具并转换为内部 descriptor；执行只从 ToolRuntime 进入。子进程不继承完整环境；Windows Node 启动所需 `SYSTEMROOT`/`WINDIR` 为固定引导项。连接、超时、schema 与崩溃错误均安全失败，错误详情和白名单环境值不写 Event/Audit。
- Tools 页面展示 Workspace、内置工具、MCP 配置与连接状态；Mission Timeline 展示 Tool 和 Approval 的有界安全摘要。

## 数据与依赖

- 新增 `migrations/0005_gate4.sql`：MCP 配置时间戳/索引、审批恢复用 `pending_tool_calls` 及归属和一次性处理约束。Workspace Root 使用既有 `app_meta`。未改动 0001–0004。
- 精确新增 `@modelcontextprotocol/client@2.1.0` 与 `ajv@6.15.0`，并更新 lockfile；未升级无关依赖。沿用 AI SDK 6 Core、Electron 44.4.3、SQLite 与 FakeModelGateway。

## 验证证据

Windows x64，真实 Electron package：

- `npm run test`：19 个文件、105 个测试通过。覆盖文件工具正常路径与覆盖写入、traversal/junction、ToolRuntime 校验/拒绝/授权、Mission grant 隔离、原 Run 审批恢复、配置变化时不执行、工具失败、step 上限、MCP discovery/execution、环境白名单、schema、crash/timeout、migration 与归属。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run format:check`：通过。
- `npm run package`：通过，Forge 完成 Windows x64 打包及 native dependency 准备。
- `npm run smoke:package`：通过。真实 packaged app 验证 Gate 1–3 回归，以及 Workspace 选择、四个 Built-in、traversal/junction 拒绝、DENY 不写文件、Mission grant 复用及跨 Mission 隔离、审批重启恢复原 Run、MCP discovery/执行/审批/环境白名单、Usage/Event/Audit 归属与敏感值脱敏。

## 已知问题与架构偏差

- MCP tool 统一按 `MCP_TOOL_EXECUTE`、HIGH 风险、PROCESS_EXECUTION 标记；尚未按外部 server 的自报信息降低风险级别。用户可显式配置本地 stdio server，但 Agent 无权安装或修改 server。
- 工具循环要求一次仅提出一个 tool call；模型若同时提出多个，会收到 `MULTIPLE_TOOL_CALLS` 结果，仍受总上限约束。
- 文件路径在执行前做 canonical 检查，并在打开/替换前复查。Windows/Node 不提供本实现可用的目录句柄相对原子路径 API；拥有同一目录写权限的外部进程若在检查与操作之间恶意替换父目录，仍可能产生 TOCTOU 竞争。用户应选择自己控制的 Workspace Root。
- 真实 Provider 与第三方 MCP server 需要用户自己的配置；确定性测试和 packaged smoke 使用 FakeModelGateway 与仓库内的 stdio fixture，不要求仓库包含 API Key。

## Gate 边界

未实现 Shell/PowerShell、Browser Control、Computer Use、Agent 自动安装 MCP、Party 或多 Agent 协作。提交并推送 `main` 后停止，等待 Gate 4 审批。
