# Generation V1 software v2 — software and live acceptance

Baseline: `main@630dfb89029aa8fb359048d547d861bb35b1b721`.

唯一实施依据：`docs/AI_Agent_Cultivation_Generation_V1_Software_Final_Plan_v2.md`。本轮不恢复已取消的 H3 GPU 联调，不实现下一阶段能力。

## Scope

Four code-owned adapters: GEN_HTTP_V1, APIMART_ASYNC, MIMO_TTS and TOKENRHYTHM_ASYNC. Legacy H3 remains separate. All adapters use the existing GenerationTask / GenerationJob / Artifact chain, sealed identity, Availability, Permission and recovery. The Renderer receives no credential or local media storage path.

The supplied credentials remain in ignored `private/keys.txt`. The confirmed order is API Mart, MiMo, Jev, TokenRhythm. No credential is copied into this document or evidence.

## Implementation

- GEN_HTTP_V1 为独立、生产接线的固定 HTTP 协议，覆盖图片、视频、音乐、TTS。独立 HTTP fixture 使用正式 adapter，不依赖 FakeGenerationGateway 冒充生产协议。契约见 `docs/architecture/gen-http-v1.md`。
- 四个 adapter 复用 GenerationTask/Job/Service、sealed Runtime、ArtifactStore、Availability 和 G3。异步与同步 Provider 都有 durable PREPARED → SUBMITTING → SUBMITTED / REJECTED / UNKNOWN 屏障；UNKNOWN 不自动 POST。
- 创建入口、Settings、Generation Chat 按 descriptor 展示能力、参数、输入 role 和图片/视频/音频结果。当前 descriptor 不再被历史 Job descriptor 覆盖。媒体通过 opaque protocol 展示，Renderer 不获得软件存储绝对路径。
- `0033_generation_artifact_sharing.sql` 只扩展用户明确授权的已完成 APP_ARTIFACT_STORE 媒体分享。Main 检查原文件/hash、当前 Run 和真实生成事实，在事务中写 USER Event、Audit、ArtifactRef；DB trigger 同样验证来源。分享不授予 Workspace 或 FILE_READ 权限。
- 完整旧 migration 0001–0032 未修改。旧 H3 adapter、sealed identity、历史 UNKNOWN/FAILED 记录不改写。
- 真实 MP4 暴露 B-frame presentation/edit-list、标准 AVC/AAC 容器兼容问题；现在仍使用 bounded container ranges 验证，未引入 codec 解码或全量媒体 Buffer。
- Suno 的 Provider duration 为百分之一秒精度，真实 WAV 比该值多约 13.5 ms。只有可信 Suno adapter 设置最多 20 ms 容差；容器推导值为最终 metadata。GEN_HTTP_V1 不接受 Provider 注入此字段。
- 下载仅允许固定精确 Provider/CDN host，拒绝 redirect；API credential 不发送至 CDN。TokenRhythm 真实认证图片响应使用 `tokenrhythm-prod-backup-oss.oss-cn-beijing.aliyuncs.com`，只允许该精确 bucket 的图片 MIME，不授予其他 Aliyun host 或视频访问。
- OpenAI-compatible proposal 使用 AI SDK JSON mode 时需要明确 JSON/schema 提示。Main 提供固定 schema 文本，再执行原 Zod validation；Jev/模型不获得 Permission 或状态 authority。普通 LANGUAGE streaming 回归保留 `stream:true`。
- 实际 NEEDS_INPUT 等 ParticipantOutcome 没有 artifactRefs；修复 G3 页面假设，只有 RESULT 才显示成果，补真实无数组 outcome 回归。
- Main 生成 HTTP 写请求使用单次 Node HTTP/HTTPS 传输，并沿用 Electron session 的代理选择。真实 Windows fixture 证明 Chromium net.fetch/net.request 会在 accepted POST 响应丢失后自动重发；新传输不复用连接、不跟随 redirect、不重试。HTTP CONNECT + TLS 验证与流式上传保留，UNKNOWN 首次 POST = 1、重启 POST = 0。当前支持 DIRECT / HTTP proxy；其他代理类型 fail closed。
- Windows Forge workaround 固化为项目内、版本限定的 runner；标准 package 自行执行。没有临时 NODE_OPTIONS/preload、额外 CLI 绕过或依赖升级。

## Live discipline

真实验收按 API Mart → MiMo → Jev → TokenRhythm 执行。每个 PASS 案例均完成 API、Adapter、Integration、Windows packaged 四层。证据保存原始失败/UNKNOWN 尝试及后续明确的新 attempt；不把失败记录覆盖成成功。

Use one minimal generation per case; uncertainty must stop automatic POST. Known provider Jobs are queried rather than recreated. H3 GPU live is NOT_RUN because the user cancelled the previous deployment test; no previous incomplete task will be resumed.

## Acceptance matrix

| Case                             | Status  | Evidence / boundary                                                                                                                    |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SOFTWARE_OFFLINE                 | PASS    | 164 files / 1,510 tests; full historical packaged chain                                                                                |
| GEN_HTTP_V1_OFFLINE              | PASS    | Independent HTTP fixture, four capabilities, streaming, faults, lineage, restart                                                       |
| LIVE_APIMART_IMAGE               | PASS    | One real JPEG Artifact, packaged preview and restart                                                                                   |
| LIVE_APIMART_VIDEO_T2V           | PASS    | wan2.7, 2 s / 720P; old validation failure retained; corrected explicit attempt playable                                               |
| LIVE_APIMART_VIDEO_I2V           | PASS    | Real G3 user-approved original image → same hash FIRST_FRAME → real video → Coordinator; original UNKNOWN Chat attempt remains UNKNOWN |
| LIVE_APIMART_MUSIC               | PASS    | Suno v6, both real WAV tracks saved and played; old rejected/validation-failed attempts retained                                       |
| LIVE_MIMO_TTS                    | PASS    | mimo-v2.5-tts, preset 冰糖, short original Chinese text, real WAV playback/restart                                                     |
| LIVE_JEV_R3                      | PASS    | Four real SUCCESS Shadow receipts; draft Mission control flow unchanged                                                                |
| LIVE_JEV_R4                      | PASS    | Real bounded semantic signal, SOLO assignment, receipt and route Event/Audit                                                           |
| LIVE_JEV_R5_1                    | PASS    | Real bounded skill relevance → actual prompt Skill selection                                                                           |
| LIVE_JEV_R5_2                    | PASS    | Real SKIP → extractor calls = 0; no fabricated extracted Memory                                                                        |
| LIVE_JEV_R5_3                    | PASS    | Separate focused Memory Mission: owned retrieval → real rerank → final prompt selection Event/Audit                                    |
| LIVE_JEV_R5_4                    | PASS    | Real shortlist → actual offered tools → FILE_READ approval/tool execution                                                              |
| LIVE_JEV_R5_5                    | PASS    | Real completion.advisory; advisory cannot change terminal authority                                                                    |
| LIVE_TOKENRHYTHM_QWEN_IMAGE      | PASS    | Original synchronous response restored after precise CDN fix, no second generation POST; PNG preview/restart                           |
| LIVE_TOKENRHYTHM_WAN_IMAGE       | PASS    | One real PNG, preview/restart                                                                                                          |
| LIVE_TOKENRHYTHM_WAN_VIDEO_CHECK | BLOCKED | Authenticated models/history GET = 200, but no account-specific Wan generation entitlement/current price proof                         |
| LIVE_TOKENRHYTHM_WAN_VIDEO_GEN   | NOT_RUN | CHECK not passed; billable video POST = 0                                                                                              |
| WINDOWS_PACKAGED_LIVE            | PASS    | Production fake flags absent; image/video/music/TTS/Jev/G3; 1440/1180/900 and restart                                                  |
| LEGACY_H3_OFFLINE                | PASS    | Existing H3 adapter/contract/recovery regression retained                                                                              |
| H3_GPU_LIVE                      | NOT_RUN | User cancelled prior GPU test; no query to old deployment or incomplete Jobs                                                           |

## Live facts and limitations

- Main generation facts: `docs/evidence/gen-v1-live-software-v2/packaged/live-generation-facts.json`. Four-level I2V success is recorded separately in `artifact-collaboration-facts.json`; the earlier I2V Chat UNKNOWN remains untouched.
- G3 Mission `6f05f048-bee9-4c1a-8fdc-3c49907a20bc`, Run `a14e4174-ac83-4b70-b29f-c9a1d7b5c319`, real video Job `40eb5b6f-90a6-418e-9b44-ee3be8d0f117`. Source image Artifact `ec4a84a6753d87280c7200ff919c4db92b7d7796fe72a7be6b5619d879f52504` retains hash `32ee8be56630182a9e75ab292fdb19e3583d9a90d4fb34133dda45875b2a3cf0` throughout USER share, task input and resulting lineage.
- Jev facts are actual packaged R3/R4/R5 chains (`jev-facts.json`), using jev-1.13.0. R5.3 uses a distinct focused Mission because the original broad task did not retrieve the selected Memory; its Run attribution is explicit. The fallback Memory is user-created, not falsely claimed as extracted.
- TokenRhythm Wan CHECK is a real bounded authenticated read-only check. HTTP 200 on model/history listing does not prove generation permission or price. No Wan video live generation is claimed.
- Suno custom=false does not support a duration parameter. The real two returned tracks are approximately 3.5 minutes despite a short music prompt; UI does not promise or submit a fabricated 10-second control. This path made no continuation/cover/remix calls.
- 真实 I2V 返回 960×960、约 2 秒的视频，保留了方形输入的比例；请求中虽指定 16:9，Provider 并未输出该比例。证据保留实际容器尺寸，PASS 表示接入、授权、lineage、播放和恢复链通过，不表示画面规格或内容已通过制作审查。
- Old failed media attempts and language proposal failures remain in SQLite. Repairs requiring a new terminal Job used explicit new intent; uncertain submissions were never reused for a second generation.
- The generic H3-compatible software contract is offline-verified; a future deployment must conform and undergo its own live check. No GPU live claim is made here.

## Standard validation

Exact commands, without extra arguments or temporary preloads:

| Command               | Result                                            | Log                          |
| --------------------- | ------------------------------------------------- | ---------------------------- |
| npm run test          | PASS — 1,510 tests / 164 files                    | validation/test.txt          |
| npm run typecheck     | PASS                                              | validation/typecheck.txt     |
| npm run lint          | PASS                                              | validation/lint.txt          |
| npm run format:check  | PASS                                              | validation/format-check.txt  |
| npm run package       | PASS — Windows x64, Electron 44.4.3/native module | validation/package.txt       |
| npm run smoke:package | PASS — complete historical chain + GEN_HTTP_V1    | validation/smoke-package.txt |

Logs live under `docs/evidence/gen-v1-live-software-v2/`. `release-integrity.json` contains SQLite integrity/FK checks, historical migration hashes, unchanged W2 manifest/content hashes and preserved UNKNOWN. Normal packaged startup loads no Fake provider. New dependencies: **none**; lockfile unchanged.

## Screenshots

`docs/evidence/gen-v1-live-software-v2/packaged/`: real image/video/music/TTS, TokenRhythm images, Jev and original-Artifact G3 reuse at 1440/1180/900. `*-restart-*` verifies durable history. `gen-http-v1/` separately contains offline HTTP fixture evidence. Screenshots are native BrowserWindow captures; Windows 125% scaling may make physical PNG width 1.25× the requested content width. Historical diagnostic screenshots are labelled as failures, never counted as acceptance.
