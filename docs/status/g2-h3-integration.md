# G2 — H3 Integration

基线：`a23a0e3c32db7d731f4bf7274dce8b213807a6e0`。范围为 H3 HTTP Adapter、Generation Single Chat 和 Generation Availability；未进入 G3、R5 或 W3。

## 正式契约与架构

软件契约采用 Generative Model Execution Spec v0.2 第 15–16 节。部署侧计划仅作联调参考，真实 Endpoint 由部署侧提供，代码不猜测或内置部署地址。

- `GENERATION_HTTP` + bounded `adapterId` 为 Provider identity；当前 trusted Main dispatch 提供 `H3`。普通道友仍为 `MODEL_RUNTIME`，固定 Runtime 的 `executionProtocol=GENERATION`；没有新增 executor kind。
- `H3GenerationGateway` 仅位于 agent-runtime，沿用冻结的 G1 `GenerationGateway`。Main 解析 sealed identity、解密 Credential 并提供受控媒体 source。Domain/Application 不使用 H3 SDK、GPU 或部署节点类型。
- `/health` + `/v1/models` 验证服务与模型 identity；异步链为 `/v1/files` → `/v1/videos` → job status → output binary。请求字段采用正式 HTTP contract，Feature 是本地 deterministic eligibility，不添加未经约定的 HTTP 字段。
- Descriptor 对 capability、feature、role、duration、MP4 output 与 optional parameter schema 严格校验；未知、不一致或不安全描述 fail closed。参数来自用户控件或公开 Adapter 默认值，未使用隐藏 LLM 推断。
- Submit 固定 `Idempotency-Key=GenerationTask.id`；持久化 request fingerprint、exact request body、upload file identity 和提交 phase。同 key 不同 fingerprint 拒绝；无法确认提交结果进入 UNKNOWN，重启不自动 POST。

## Migration 0028

仅追加 `0028_g2_generation_http.sql`，0001–0027 不变。

新增 Provider/Binding adapter identity。旧 ModelBinding 的 Provider CHECK 无法容纳 GENERATION_HTTP，因此在独立 migration transaction 中重建该表并恢复原 identity、availability、credential 和 generation triggers；升级前后检查 foreign keys。LANGUAGE 旧数据及其历史 Runtime/Usage/Mission 事实保留。

新增 Main-only `generation_adapter_submissions`、immutable `generation_input_artifacts`、`generation_chat_entries`。用户 Message 与 conversation ownership 冻结；G1 创建 Job 的同一事务将该 Job 绑定到真实 user message，避免聊天绑定 crash window。没有第二套 Job state machine。

## Streaming、存储与安全

- 原生文件选择器显式导入，Renderer 只获得 id/kind/MIME/hash/size/name；不能提交任意文件路径或软件输出目录。当前可验证输入为 PNG、WAV、MP4；不宣称已支持所有媒体编码。
- 逐块 multipart 上传，增量 hash 与 byte count 校验 Artifact identity/size/MIME；Provider file_id 不替代软件 Artifact identity。Credential 继续 safeStorage Main-only，IPC 不返回明文或 ciphertext。
- H3 status contract 不提供 output hash，因此 Main 首先将 HTTP binary stream 写入受控 cache partial，增量 SHA-256、精确 size 和冻结 G1 container validation 后才获得 verified source；再交给原 G1 run-scoped staging → atomic commit → Artifact registration。没有整媒体 Buffer 主路径。
- 保留 G1 category safety ceilings：image 128 MiB、audio 1 GiB、video 4 GiB。H3 当前 client fallback 限制更保守：单输入 128 MiB、输出 512 MiB、最多 4 个输入、每 role 1 个输入、1 个输出；远端 descriptor 可进一步收紧。Duration 使用远端 4–15 秒内的合法范围。
- Preview 使用 Main-issued exact opaque token 的 `cultivation-media:` 协议和受限 byte ranges；不暴露 Provider URL 或 storage path，Renderer `connect-src` 边界不放宽。仅允许 trusted Renderer origin、GET/HEAD；Electron stream/corsEnabled scheme 能力使真实 package 能播放媒体，没有启用 bypassCSP 或关闭 webSecurity。参见 [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol)。Provider 无本地目标路径 authority。
- Partial cache 无完整验证事实，不得注册；完整 verified cache 可复用，注册失败或重启不重复下载。临时 partial 保留用于诊断，当前没有自动清理/长期媒体管理界面。

## Single Chat 与 Availability

生成对话持久化真实 User Message → G1 Job → Artifact，不伪造 assistant 文本。UI 支持 prompt、受控素材导入/选择、显式 role、descriptor duration/aspect/seed/原生音频要求、状态卡及可播放视频。UNKNOWN 只展示待确认状态，不自动重新提交。

重启后查询原 providerJobId，已完成 Artifact 从原登记事实恢复。归档或 Provider 停用仍能读取历史，但不执行/probe/重提。LANGUAGE Chat 路径保持原服务。

Generation Availability 使用独立 health/descriptor probe，复用 R3.2 projection/policy；不使用 LANGUAGE ping。真实调用成功/失败更新同一个 sealed Teammate projection；offline 明确 UNAVAILABLE，显式选择不改派。Human Bridge 没有模型 Availability，Benchmark/Evidence 不受影响。

## 验收

自动验收离线，通过实际 H3-compatible HTTP fixture 驱动生产 Adapter，而非将 FakeGenerationGateway 作为正式 Provider。

| 验证          | 结果与证据                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| test          | PASS：113 files / 935 tests；`validation/test.txt`                             |
| typecheck     | PASS；`validation/typecheck.txt`                                               |
| lint          | PASS；`validation/lint.txt`                                                    |
| format:check  | PASS；源码范围不变，显式排除已忽略的缓存目录；`validation/format.txt`          |
| package       | PASS：Windows x64，native dependency 1/1；`validation/package.txt`             |
| smoke:package | PASS：Gate 0–6、R0–R4、UI、W1/W2.0–W2.4、G1/G2；`validation/smoke-package.txt` |

独立 packaged evidence：`docs/evidence/g2-h3-integration/4fa8ca3a-248e-4442-9506-da1738c9e091/`，14 张真实窗口截图覆盖 1440/900、纯 prompt、首帧、运行中、重启后视频、UNKNOWN 和 offline。两个视频均实际 `play()` 并达到 `readyState=4`；opaque scheme token 不包含 Provider URL 或本地路径。包内 Main response CSP 与 HTML meta CSP 均仅允许受控媒体 scheme，未放宽 Renderer network authority。

完整命令于 2026-10-06 成功结束（exit 0），G2 尾部证据归档在 `docs/evidence/g2-h3-integration/305e09ad-4ac2-4df8-8ecd-03706cfe5dc0/`，同样含 14 张截图与 SQLite/HTTP counter facts。旧 smoke 脚本仅同步新增 migration 28 的精确版本断言，以及创建向导 Endpoint label 定位；原业务、安全与 frozen hash 断言保留。

持久化查询确认：3 条真实 user message、2 个 COMPLETED Job 各 1 个 Artifact、1 个 UNKNOWN Job 无 Artifact；首帧仅上传一次。中断下载后复用原 Job；UNKNOWN 重启增加的 submit/status/download 均为 0；offline 增加的 message/Job/submission/reroute 均为 0。完整 verified cache 与 registration-pending crash 的零重复下载另由 application test 覆盖。

三个 W2 v1 frozen manifest hash 保持：

- AI 资讯视频：`ae37a04bf0156c42adea41d8d0418de2f942d6dc677803727af7db41ab36e4cd`
- 软件功能开发：`30eb30ce957ef3bad798d1046bd45835322b645d97e49ca5affcac4e16cd348d`
- 科研：`199c675c91c1c7d15709141be9a7dc6ce1e776f3c1b0af7c66c2ff9e1f3b03d3`

### Live deployment

**BLOCKED / NOT RUN**：部署侧尚未提供真实 Endpoint/访问凭据。未连接真实 GPU，也未将 fixture 视频称为真实模型输出。部署侧提供 Endpoint 后，通过创建道友/高级模型设置配置生成服务，Credential 如需使用仍由 Main 剪贴板安全导入；真实 health/models、prompt、FIRST_FRAME、restart poll 和 GPU 幂等计数需要单独联调。

### 本机验证环境

Windows 文件 I/O 使少量冻结的 G1 测试超过 Vitest 默认 5 秒；最终全量命令使用 `npm run test -- --testTimeout=15000`，没有跳过测试、修改断言或调整正式软件的请求超时策略。

本机 Forge 7.11.2 native 前置扫描将反斜杠 glob 的 base 解析为整个项目，因缓存/worktree 扫描而停滞。通过 `fast-glob.generateTasks` 对比验证后，本轮构建使用项目内临时 NODE_OPTIONS preload，只规范化 Forge package API 发起的 Windows absolute glob；未修改安装依赖、rebuild 逻辑或产品 bundle。shim 原文归档在 `docs/evidence/g2-h3-integration/validation/forge-windows-glob-preload.cjs.txt`。TEMP 使用项目内短路径映射，npm/Electron/node-gyp cache 也显式指向项目。

Prettier 先遍历再应用 ignore；本轮 `format:check` 使用额外 negative glob 显式排除已忽略的缓存、临时数据和输出目录，源码检查范围不变。

## 保持与未实现

G1 contract/state machine、0001–0027、三个 W2 frozen v1 packages、LANGUAGE Chat、R4/Permission/Memory/Human Bridge/Party authority 均保持。未将 Generation 接入 Workflow/Party；未实现 G3、R5/W3、自动多段视频、部署安装、GPU控制或新的 Agent 能力。无新增依赖。
