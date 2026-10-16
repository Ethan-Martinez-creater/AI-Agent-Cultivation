> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `0fc517b3b54bd651c8ee5399d36409361ba94238c2d401b8952ba70b4dfb4b76`. See the publication derivation map for both hashes and removed field categories.

# E1 离线预检复现说明

本目录是执行前证据，不是 Jev Live 成绩或正式 Crash/Recovery 结果。冻结输入是 `docs/AI_Agent_Cultivation_V1_E0_Evaluation_Design_v0.2.md`，基线为 `a2551bbc9dbd87ec4701183a53a2635966326df4`。保持原始 E0 文件不变，不运行全目录格式化。

## 环境与范围

使用 PowerShell 7，在仓库根目录执行。已有本地依赖，不需要安装 Provider、输入 API Key 或连接真实服务。普通受限执行环境可能阻止 esbuild、Electron 或 Chromium 子进程；本轮成功的相应执行记录使用经批准的本地执行环境。不要通过关闭应用安全机制来掩盖这个差异。

```powershell
$env:TEMP = Join-Path (Get-Location).Path '.tmp/e1-main-preflight'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path (Get-Location).Path '.npm-cache'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
```

## 已实现的检查

```powershell
node scripts/engineering-validation/run-preflight.mjs integrity
node scripts/engineering-validation/run-preflight.mjs inputs
node --test scripts/engineering-validation/metrics.test.mjs
node scripts/engineering-validation/run-preflight.mjs transport
```

`integrity` 对三个冻结 Hash、33 个 migration、全新隔离数据库以及官方 workflow content/manifest hash 进行核验；已有人工 Gold 复核文件会保留。`inputs` 调用真实选择器处理全部 30 例，并执行 12 个离线故障注入。Skill 存储端口及 owner 使用独立内存 fixture，owner 是类型正确的 Teammate DTO；不宣称完成了 Gate1 创建和数据库持久化。Memory 范围仅为 R5.3 RERANK_ONLY。工具执行回调一律拒绝调用。

`metrics` 只使用明确的合成向量。真实 Live 接线时必须先按 `LIVE_SUCCESS` 过滤成功原生配对；纯数学配对函数不负责验证 Provider 状态。固定 Live 分母汇总器另行保留 fallback、NOT_RUN、coverage 和未知费用。

`transport` 只访问临时 `127.0.0.1` HTTP fixture，分别运行真实 Gateway/SDK 的 Node fetch 与 Electron net.fetch 路径；Electron 无窗口并正常退出。它会观察连接丢失、307 redirect、6 秒超时、probe 以及迟到 factory，不会向真实 Jev 发送请求。JSON 中的 Token Usage 是服务端 Mock 值，不能用于真实计费结论。

## SQLite / WAL 采集方法

两个 P6 脚本只能指向 E 盘 `.tmp` 或 `.test-data` 中明确隔离的源 Profile 和新输出目录；默认缺失时拒绝运行，不会覆盖已有备份。原始库、备份、WAL/SHM、截图不得放进本目录或提交仓库。

```powershell
$env:E1_PROFILE_ROOT = '[LOCAL_PATH_ROOT]\.test-data\example-profile'
$env:E1_EVIDENCE_ROOT = '[LOCAL_PATH_ROOT]\.test-data\new-backup-output'
New-Item -ItemType Directory -Path $env:E1_EVIDENCE_ROOT | Out-Null
node scripts/engineering-validation/packaged-breakpoint-preflight.mjs
node scripts/engineering-validation/p6-live-wal-method-test.mjs
```

源数据库位置为 `$env:E1_PROFILE_ROOT\UserData\data\cultivation.sqlite`。第一个脚本实际上是只读在线备份助手，不是已经实现完整 CR-A/CR-B 控制器的声明。第二个脚本在备份的独立派生副本中写入 `user_version=4242` 作为方法测试标记，不修改原 Profile 业务数据。

只读打开 WAL 数据库仍可能创建空 WAL 和 SHM；副本通过完整性/FK 检查，不等于已获得稳定的原始 DB/WAL/SHM 三件套。未来故障实验必须另行保留三件套及采集时间、进程状态、独立断点命中计数，不以文件 Hash 不变推断“没有再次执行”。

## 回归与原始打包产物

完整命令、退出结果及限制见最终审查报告与同目录文本日志。新增脚本不会提交或 Push。构建采用 E 盘物理副本，保留根目录 Node ABI 原生模块以及原 Windows 打包产物；其工作区 junction 必须指向副本中的 packages，以保持 persistence 相对 migration 路径正确。

本轮隔离构建实际遇到 Windows MSBuild 路径长度限制；不得将其记为成功打包。首次下载等待、取消记录、使用本机 Electron 44.4.3 创建的 ZIP 来源和 SHA 均保留。该 ZIP 不冒充官方发布 ZIP。

不要直接运行 `npm run smoke:package` 来替代本轮断点预检：现有链会导入包含强杀/重启的脚本。本轮没有授权正式 CR-A/CR-B 强杀。正式 Jev、正式 Kill/Restart 和 Gold 修改均需后续独立放行，本轮脚本没有相应执行模式。

## 实际打包断点 Controller

从仓库根目录执行，每次自动创建新的 E 盘 UUID Profile/Workspace；不会在上次 Profile 上重启。使用已有 `out/AI Agent Cultivation-win32-x64` 产物，compiled Hash 固定为 `417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71`。产物变化时拒绝沿用旧断点，须重新审查。

```powershell
$env:E1_REPOSITORY_ROOT = (Get-Location).Path
node scripts/engineering-validation/packaged-breakpoint-ui-controller.mjs CR_A_P4
node scripts/engineering-validation/packaged-breakpoint-ui-controller.mjs CR_B_P5
```

这两个模式只做 Preflight，正常释放断点并退出，没有 kill/restart 模式或真实 Provider 调用。启动参数是现有 `--gate1-fake-model --r4-fake-routing --w22-fake-software`；真实权限审批、ToolRuntime、Workflow Guard 与内置文件写入保留。文件夹选择只复用现有测试的 dialog 输入 seam，Workflow 创建、审批、推进均走公开 preload IPC。普通受限启动可能触发 Chromium IPC 权限错误；本轮最终成功执行使用已批准的完整本地控制器环境。

独立 `packaged-workspace-fixture.mjs` 创建带 tsconfig 的三文件 TypeScript 工程，动态 import 真实 .ts exports 的 verifier 通过已有 MCP 工具执行。外部 verifier ledger 记录 ENTRY/FAILED/COMPLETED，保存在忽略目录，不以产品成功 receipt 代替计数。Node 24 原生 TypeScript 加载已单独实测；未执行 tsc 静态类型检查。

CR-A 实测位置为 CDP 0-based `9625:7198`，条件 S06；CR-B 实测入口为 `9848:7612`，写后为 V8 `type=return` 的 `9848:13661`。仅在真实入口暂停后安装后者，同时要求真实文件 Hash、两套 PREPARED 和 0 个工具结果。13635 旧候选不能作为已验证的写后屏障。`Debugger.resume` 回复不能阻塞对下一 pause 的取证。

最终证据优先级：`crash-a-packaged-execution-final.json`、`crash-b-packaged-execution-final.json`、`crash-controller-observability-final.json`。原 `crash-*-breakpoint-preflight.json` 与 `*-historical.json` 是历史诊断。`crash-b-identity-supplement.json` 是正常退出后的只读身份关联补充，不用于证明暂停时状态。最终进程审计按 PID、创建时间和 EXE 核验，不使用含 PID 复用风险的候选父进程树来终止进程。

最后交付的 controller 在已实测逻辑上只补充捕获字段、E 盘路径保护和 pwsh 子进程环境；这些补充已通过语法/lint，未为观测投影和环境保护重新启动应用。原始 SQLite、Profile、WAL/SHM、截图、NDJSON ledger 均留在 `.tmp/e1-packaged-preflight`，不应提交；本目录只发布 JSON/文本投影。
