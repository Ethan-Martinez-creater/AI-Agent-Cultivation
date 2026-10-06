# G2 — H3 Integration

基线：`a23a0e3c32db7d731f4bf7274dce8b213807a6e0`。范围为 H3 HTTP Adapter、Generation Single Chat 和 Generation Availability；未进入 G3、R5 或 W3。

## 正式契约与架构

软件契约采用 Generative Model Execution Spec v0.2 第 15–16 节。部署侧计划仅作联调参考，真实 Endpoint 由部署侧提供，代码不猜测或内置部署地址。

- `GENERATION_HTTP` + bounded `adapterId` 为 Provider identity；当前 trusted Main dispatch 提供 `H3`。普通道友仍为 `MODEL_RUNTIME`，固定 Runtime 的 `executionProtocol=GENERATION`；没有新增 executor kind。
- `H3GenerationGateway` 仅位于 agent-runtime，复用 G1 的 streaming Gateway、Job lifecycle 和存储链；本轮进一步明确 Provider-neutral submission outcome。Main 解析 sealed identity、解密 Credential 并提供受控媒体 source。Domain/Application 不使用 H3 SDK、GPU 或部署节点类型。
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

## 主体验收历史（以本轮 corrective 原命令结果为准）

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

### 主体历史验证环境（已被本轮正式配置替代）

Windows 文件 I/O 使少量冻结的 G1 测试超过 Vitest 默认 5 秒；最终全量命令使用 `npm run test -- --testTimeout=15000`，没有跳过测试、修改断言或调整正式软件的请求超时策略。

本机 Forge 7.11.2 native 前置扫描将反斜杠 glob 的 base 解析为整个项目，因缓存/worktree 扫描而停滞。通过 `fast-glob.generateTasks` 对比验证后，本轮构建使用项目内临时 NODE_OPTIONS preload，只规范化 Forge package API 发起的 Windows absolute glob；未修改安装依赖、rebuild 逻辑或产品 bundle。shim 原文归档在 `docs/evidence/g2-h3-integration/validation/forge-windows-glob-preload.cjs.txt`。TEMP 使用项目内短路径映射，npm/Electron/node-gyp cache 也显式指向项目。

Prettier 先遍历再应用 ignore；本轮 `format:check` 使用额外 negative glob 显式排除已忽略的缓存、临时数据和输出目录，源码检查范围不变。

## G2 corrective repair

修复基线：`09527e3282a113b7207e59036840f1345511ab6e`。以下为本轮最终有效验收；上文带额外参数和临时 preload 的历史验证不作为本轮通过依据。

### Durable chat preparation

已持久化的 user message、inputs 和 parameters 是唯一准备意图。启动只扫描一次未绑定且无确定性准备失败的 entry，复用现有 GenerationService 创建原逻辑 Job；自动 Chat refresh 不重复执行准备。进程内按 messageId 合并并发准备，SQL 同时拒绝重复 Job，失败的创建事务不会留下多余 Task。消息及输入快照不变，确定性准备错误不可清空或改写，COMPLETED/UNKNOWN 不创建替代 Job。

追加 `0029_g2_submission_continuation.sql`：保留现有 adapter submission facts，增加 REJECTED terminal mapping、chat preparation terminal guard 和一条消息最多一个 submission 的数据库防线。0001–0028 未修改。

### Definitive rejection 与 uncertainty

Provider-neutral `GenerationSubmission` 现在明确区分 SUBMITTED / REJECTED / UNKNOWN。REJECTED 使软件 Job 进入 FAILED，保留稳定 errorCode；不确定提交保持 UNKNOWN。拒绝 key 的 durable mapping 不会重新 POST，同一 key 的不同 request 仍拒绝，新的重试必须创建新 GenerationTask。

软件规格 v0.2 §15–16 的原始 error envelope 本身不证明“没有创建 Job”。本轮增加可选的严格响应扩展 `error.accepted:false`，要求同时具备支持的稳定错误码、bounded message 和 boolean retryable，且没有接受/Job identity 矛盾。缺少该证明、格式不完整、网络中断或响应丢失时继续 UNKNOWN。`retryable:true` 只表示新任务可能可重试，不能复用已拒绝 key。此扩展需要部署侧显式支持；未假设现有真实部署已经实现它。

AUTH_FAILED、MODEL_NOT_FOUND、INVALID_INPUT、UNSUPPORTED_FEATURE、UNSUPPORTED_INPUT_ROLE、MODEL_DURATION_LIMIT、QUEUE_FULL、IDEMPOTENCY_CONFLICT 均有确定性覆盖，另覆盖缺失/矛盾 acceptance、durable rejection replay、UNKNOWN zero replay。

### Product presentation 与标准构建

Generation Chat 主层使用“状态待确认 / 服务繁忙 / 认证失败 / 参数不受支持 / 时长超过模型限制”等文案。errorCode、provider status、软件/Provider Job ID 仅在默认折叠的技术详情显示；SSR 与 packaged UI 同时验证该边界。

Vitest 的 15 秒 testTimeout 固化在仓库配置。format:check 用 Git 枚举 tracked/non-ignored 文件，并继续按原 `.prettierignore` 和 Prettier public API 检查，避免缓存遍历；Windows CRLF 使用 endOfLine:auto。Forge 7.11.2 的兼容 runner 仅规范化 package API 的 Windows absolute `.bin` cleanup glob，有独立测试和版本校验，标准 package 自动调用，不依赖 NODE_OPTIONS。正式 packager 配置保留 Vite bundle/native-only whitelist，关闭会绕过 ignore 的 dependency pruner，并保留 native addon headers。

验证使用项目内干净 detached checkout；TEMP 位于该 checkout 之外、仍在项目内，避免 Packager 的 source→自身子目录复制问题。已有 Electron ZIP/headers 只读复用，临时 build home/cache 在项目内。

### 最终六项原命令

所有命令在干净 detached checkout 中执行，无额外 CLI flags、无 NODE_OPTIONS preload。最终 packaged smoke 完成后该 checkout 的 `git status --porcelain` 为空；自动生成证据进入 ignored `.test-data`。代码验证完成后只归档证据和更新本状态文档。

| 原命令                  | 结果                                                         | 归档日志                                                                                   |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `npm run test`          | PASS：115 files / 952 tests                                  | [test.txt](../evidence/g2-h3-integration/corrective/validation/test.txt)                   |
| `npm run typecheck`     | PASS                                                         | [typecheck.txt](../evidence/g2-h3-integration/corrective/validation/typecheck.txt)         |
| `npm run lint`          | PASS                                                         | [lint.txt](../evidence/g2-h3-integration/corrective/validation/lint.txt)                   |
| `npm run format:check`  | PASS                                                         | [format.txt](../evidence/g2-h3-integration/corrective/validation/format.txt)               |
| `npm run package`       | PASS：Windows x64，native rebuild 1/1                        | [package.txt](../evidence/g2-h3-integration/corrective/validation/package.txt)             |
| `npm run smoke:package` | PASS：Gate 0–6、R0–R4、UI、W1/W2.0–W2.4、G1/G2 及 corrective | [smoke-package.txt](../evidence/g2-h3-integration/corrective/validation/smoke-package.txt) |

### Crash / outcome / UI 证据

真实 Windows package 使用生产 H3 adapter + 离线 HTTP fixture，按顺序打开和关闭测试进程。Main 的测试专用 fault hook 在 ENTRY_COMMITTED / JOB_CREATED 精确终止进程；正常 production bootstrap 不启用该 hook。

| 场景                                     | 持久化事实与重启结果                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| Message/entry 已提交，Job 创建前退出     | crash 时 job_id=null、无 Job/POST；恢复后 1 Job / 1 POST / 1 Artifact，第二次重启稳定      |
| Job 创建后、send 返回前退出              | 原 PENDING Job 绑定不变；恢复原 Job，1 POST / 1 Artifact，第二次重启稳定                   |
| 确定性 preparation validation failure    | entry 保留 INVALID_INPUT，无 Job/Artifact；重启不反复准备或 POST                           |
| 明确 AUTH_FAILED / QUEUE_FULL 拒绝       | durable REJECTED、软件 FAILED、0 Artifact；重启 0 额外 POST，retryable=true 不放宽 key     |
| 缺少 non-acceptance proof 的 AUTH_FAILED | durable UNKNOWN、软件 UNKNOWN、0 Artifact；重启 0 额外 POST                                |
| Archived/unavailable pending preparation | application regression：0 probe / 0 Job；启动恢复不会阻断其他已有 Job 的恢复               |
| 普通 UNKNOWN / FAILED Chat               | 1440/900 共 6 张截图；主层为中文错误，technical details 默认折叠；展开后可检查 code/Job ID |

直接 SQLite/HTTP counter 证据见 [packaged/facts.json](../evidence/g2-h3-integration/corrective/packaged/facts.json)。原 G2 prompt/首帧/video playback/断线/UNKNOWN/offline 场景再通过，14 张截图及 facts 归档于 `corrective/baseline/`。最终标准 smoke 同时验证 G1 crash A–F、partial download、verified staging、commit recovery、streaming 和 Workspace permission。

三个 W2 frozen release/definition hash 在本轮 clean production database 中再次匹配，重启持久化事实未新增；见 [frozen-hashes.json](../evidence/g2-h3-integration/corrective/frozen-hashes.json)。证据索引见 [corrective/README.md](../evidence/g2-h3-integration/corrective/README.md)。Live Integration 仍为 **BLOCKED / NOT RUN**；未提供部署 Endpoint，不将 HTTP fixture 称为 live evidence。

## 保持与未实现

G1 streaming/state machine、0001–0028、三个 W2 frozen v1 packages、LANGUAGE Chat、R4/Permission/Memory/Human Bridge/Party authority 均保持。未将 Generation 接入 Workflow/Party；未实现 G3、R5/W3、自动多段视频、部署安装、GPU控制或新的 Agent 能力。无新增依赖。
