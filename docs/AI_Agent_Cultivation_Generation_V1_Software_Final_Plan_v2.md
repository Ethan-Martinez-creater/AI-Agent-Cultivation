# AI Agent Cultivation — Generation V1 软件侧最终实施计划（含 Jev / API Mart / MiMo / TokenRhythm 真实验收）

## 1. 文档定位

本文件是本轮交付给软件实现方 Codex 的**唯一计划文档**。

用途：

1. 指导 AI Agent Cultivation 在现有 R6.1 基线上完成多模态生成模型与 TTS 的软件侧实现。
2. 要求通过**真实 Provider**验证这些模型是否能在正式软件中被创建、调用、产出 Artifact、被查看/播放/试听，并参与既有协作链路。
3. 要求对 **Jev** 完成真实接入验证，确认软件中所有依赖 Jev 的功能能够正常工作。
4. 保证本轮完成后，未来自部署 MiniMax H3 GPU 服务恢复时，原则上不需要再做额外的软件侧功能开发；只需让服务端按约定协议实现并完成联调。

本文件替代此前仅要求 Mock/OFFLINE 验收的计划。Mock 仍保留用于故障注入和合同测试，但**不能替代真实 Provider 验收**。

---

## 2. 基线与硬性不变量

仓库：

`Ethan-Martinez-creater/AI-Agent-Cultivation`

已审批基线：

`main@630dfb89029aa8fb359048d547d861bb35b1b721`

本轮必须遵守：

- 不修改历史 migration `0001–0032`。
- 如确需数据库变更，只能新增 append-only migration `0033+`。
- 三个 OFFICIAL W2 v1 的 frozen manifest/content hash 必须保持不变。
- 旧 H3 sealed identity、历史 Job、Artifact、UNKNOWN 记录不得破坏。
- 现有 Permission、Workspace、ArtifactStore、安全 IPC、Credential 边界必须保持。
- 六项原命令最终必须原样执行并通过：

```bash
npm run test
npm run typecheck
npm run lint
npm run format:check
npm run package
npm run smoke:package
```

不得通过跳过检查、临时 preload、绕过打包流程、禁用回归或篡改旧证据来换取通过。

---

## 3. 本轮目标

本轮必须同时实现并验收以下目标。

### A. 四类真实生成能力

在正式软件中接入并真实验证：

1. 图片生成（Image Generation）
2. 视频生成（Video Generation）
3. 音乐生成（Music Generation）
4. TTS 文字转语音（Speech Generation / TTS）

### B. Jev 真实接入验证

Jev 不仅要能连接，还要证明当前软件中依赖 Jev 的既有功能链路可正常工作。

### C. H3 未来无额外软件开发

本轮必须完整实现 `GEN_HTTP_V1` 通用生产 Adapter 与合同测试，使得未来 MiniMax H3 云服务器恢复后，只要部署方让服务端遵守该协议，即可直接通过软件配置与联调接入，不应再要求额外的软件侧功能开发。

---

## 4. 本轮真实测试授权与预算约束

用户已在本轮**明确授权**使用真实 API 对以下对象进行测试：

- API Mart
- Xiaomi MiMo
- Jev
- TokenRhythm（基元律动）

无需在发起每次真实 API 测试前再次向用户逐次申请授权。

但必须遵守：

1. 以**尽可能低的预算**完成真实测试；
2. 不做过度测试；
3. 不生成明显偏长、高成本或高分辨率的视频；
4. 每类能力只做达到验收所需的最小真实调用次数；
5. 先实现、先离线验证，再做真实调用；
6. 对于可能高成本或可用性不确定的模型，先做最小可用性探测，再决定是否发起实际生成。

建议执行策略：

- 图片：每个待验收 Provider/模型 1 次最小化真实生成；
- 视频：每个待验收 Provider/模型 1 次最短合法时长、最低合适档位的真实生成；
- 音乐：每个待验收 Provider 1 次最小真实生成；
- TTS：每个待验收 Provider 1 次简短文本朗读；
- Jev：每个功能点 1 次最小真实任务验证，不做无谓重复。

如果某一模型在探测阶段即发现当前账号无权限、文档与实际不符或费用异常升高，应记录为 `BLOCKED` 或 `FAIL`，不得为了“凑齐 PASS”继续进行高成本尝试。

---

## 5. 凭据与本地密钥文件

用户会在交付给 Codex 的提示词中，补充本地密钥文件路径。

软件实现方必须支持从本地安全文件或现有安全配置路径读取这些密钥，不得把明文 Key 写入：

- Git 提交；
- 项目源码；
- 测试日志；
- 文档证据；
- Renderer；
- 任意普通 Tool 输出。

本轮预留的凭据路径占位项如下：

- `{{JEV_KEY_FILE}}`
- `{{APIMART_KEY_FILE}}`
- `{{MIMO_KEY_FILE}}`
- `{{TOKENRHYTHM_KEY_FILE}}`

必要时也可补充：

- `{{APIMART_BASE_URL}}`
- `{{MIMO_BASE_URL}}`
- `{{TOKENRHYTHM_BASE_URL}}`

如果 Provider 要求额外组织 ID、Project ID 或 model whitelist，也应以本地配置文件方式提供，而不是写入仓库。

---

## 6. 冻结的 V1 功能范围

### 6.1 图片生成

必须支持：

- 文本生成图片；
- 获取真实图片；
- 保存 IMAGE Artifact；
- 在正式软件中预览与复用。

可选支持：

- 单图参考图输入；
- 基础编辑。

不做：

- LoRA；
- 训练；
- 蒙版局部编辑；
- 多参考图复杂编排；
- 供应商专属高级工作流。

### 6.2 视频生成

必须支持：

- 文生视频；
- 单图生视频；
- 异步任务查询；
- 获取真实视频；
- 保存 VIDEO Artifact；
- 在正式软件中播放与复用。

不做：

- 视频到视频复杂编辑；
- 多镜头脚本自动化；
- 高级轨道合成；
- 长视频；
- 不必要的高画质/高费用测试。

### 6.3 音乐生成

必须支持：

- 文本生成音乐；
- 获取真实音频；
- 保存 AUDIO Artifact；
- 在正式软件中试听与复用。

可选支持：

- 纯音乐；
- 歌词字段；
- 版本选择。

不做：

- 续写；
- 翻唱；
- Remix；
- 分轨；
- 母带；
- MIDI。

### 6.4 TTS

必须支持：

- 输入需要朗读的原文；
- 选择模型支持的音色；
- 获取真实语音；
- 保存 AUDIO Artifact；
- 在正式软件中试听与复用。

不做：

- ASR；
- 音色克隆；
- 音色设计；
- 实时流式语音；
- 多角色配音；
- 长文本自动拆分。

---

## 7. Provider 与真实验收顺序

本轮真实验收顺序固定如下：

### 第一批（必须先完成）

1. API Mart
2. Xiaomi MiMo
3. Jev

### 第二批（在第一批完成后再做）

4. TokenRhythm（基元律动）

这样做的原因是：

- API Mart + MiMo 覆盖主要多模态接入路径；
- Jev 覆盖现有智能决策相关路径；
- TokenRhythm 是第二批补充验证，用于确认“同类模型的另一家 Provider”也能接入。

---

## 8. API Mart 真实验收范围

### 8.1 API Mart 图片

先选择一个尽量稳定、低成本、文档清晰的图片模型做主验证。

可选优先级由实现方结合当前账号可用性决定，例如：

- `gpt-image-2`
- 其他当前账号已开通且文档明确的图片模型

官方图片生成文档显示其异步图片接口为 `POST /v1/images/generations`，返回任务 ID 用于后续查询【turn199517view4†L568-L576】【turn199517view4†L582-L595】。

### 8.2 API Mart 视频

至少完成：

- 1 次文生视频；
- 1 次单图生视频。

优先选择文档清晰、成本较低、支持最短合法时长的模型，例如：

- `kling-v3`
- 或其他当前账号可用、成本更低的同类模型

官方视频文档显示其视频生成接口为 `POST /v1/videos/generations`，支持 text-to-video 与 image-to-video【turn199517view5†L501-L505】【turn199517view5†L509-L523】。

### 8.3 API Mart 音乐

至少完成 1 次 Suno 音乐生成。

官方音乐文档显示其音乐接口为 `POST /v1/music/generations`【turn199517view6†L823-L833】。

---

## 9. Xiaomi MiMo TTS 真实验收范围

MiMo TTS 必须使用真实接口完成 1 次最小真实朗读。

当前官方文档显示：

- base URL 为 `https://api.xiaomimimo.com/v1`【turn199517view0†L494-L497】；
- `mimo-v2.5-tts` 是使用内置高质量音色的 TTS 模型【turn199517view2†L110-L113】；
- 响应中的音频数据可从 `message.audio.data` 解码【turn199517view1†L398-L406】；
- 文档示例中用于朗读的文本位于 `assistant` message【turn199517view1†L394-L401】。

因此实现时必须：

1. 严格按官方当前文档核实请求结构；
2. 安全解码返回音频；
3. 校验 MIME、大小、Hash；
4. 注册为正式 AUDIO Artifact；
5. 在打包软件中真实试听。

---

## 10. TokenRhythm（基元律动）真实验收范围

TokenRhythm 放在第二批执行。

用户要求重点测试：

1. `Qwen Image` 图片模型；
2. `Wan Image` 图片模型；
3. `Wan` 视频模型（文档中存在，但模型页未必展示，需先验证是否可调用）。

### 10.1 TokenRhythm 图片

用户说明：其 `Qwen Image` 与 `Wan Image` 的请求协议与此前讨论的图片生成接口族相近，可按与 API Mart 图片同类的方式先实现适配，但**上线前仍需再次核对官方当前文档和实际账号返回**。

因此软件实现建议：

- 设计一个可复用的“图片异步 Provider Adapter”；
- 让 API Mart 与 TokenRhythm 图片尽可能共享请求/轮询/下载的通用流程；
- 但不要在未核实前硬编码“完全相同”。

### 10.2 TokenRhythm 视频

Wan 视频模型必须先做两步：

1. **可用性探测**：核对文档、测试列模型或最小调用前置检查；
2. **最低成本真实生成**：仅在确认当前账号可调用且费用可接受后，做 1 次最短合法视频生成。

如果模型虽见于文档但当前账号不可用，记录为 `BLOCKED`，这仍然是有效验收结论。

---

## 11. Jev 真实验收范围

本轮必须真实验证 Jev 的连接与所有依赖 Jev 的功能链路。

### 11.1 必测功能清单

1. **R3 — Jev Shadow Decision Plane**
   - 验证真实 Jev 可被调用；
   - 记录 SHADOW receipt；
   - 不改变 Mission 控制流；
   - 证明真实 key 可用，而不只是 Fake Gateway。

2. **R4 — Controlled Intelligent Routing**
   - 验证启用 cloud 后，真实 Jev 可参与受控智能分配；
   - 至少完成 1 次最小实际任务分配；
   - 证明结果进入既有 receipt / assignment / audit 流程。

3. **R5.1 — Skill Routing**
   - 真实 Jev 参与 bounded skill relevance；
   - 至少完成 Free / Party / Workflow 中覆盖 1 组有效路径即可，但要证明真正命中该功能。

4. **R5.2 — Memory Pre-Gate**
   - 真实 Jev 参与 RUN / SKIP 决策；
   - 至少验证 1 次实际调用，并确认 extractor 行为与 gate 结果一致。

5. **R5.3 — Memory Rerank**
   - 真实 Jev 参与 bounded rerank；
   - 至少验证 1 次从 retrieval shortlist 到最终 prompt 的真实影响。

6. **R5.4 — Tool Shortlist**
   - 真实 Jev 参与 tool shortlist；
   - 至少验证 1 次 offered tools 选择结果与实际模型可见集合有关联。

7. **R5.5 — Completion Advisory**
   - 真实 Jev 参与 advisory；
   - 至少验证 1 次 advisory event 被真实记录；
   - 仍需保持仅 advisory、无额外执行 authority。

### 11.2 Jev Live 验收原则

- 必须使用真实 Jev key；
- 不得用 FakeDecisionGateway 充当 Live 证据；
- 不得只做 `/models` 探测后宣称 Live PASS；
- 必须以尽量少的真实任务完成上述功能覆盖；
- 可将多个功能验证串联在少量任务中，减少调用次数；
- 要明确区分 OFFLINE PASS 与 LIVE PASS。

---

## 12. 软件架构要求

### 12.1 继续复用既有执行链路

必须继续复用：

- `GenerationTask`
- `GenerationGateway`
- `GenerationJob`
- `Artifact`
- `GenerationService`
- Provider / RuntimeProfile / Sealed Binding
- PermissionEngine
- SOLO / PARTY / Workflow
- G3 structured collaboration
- Artifact lineage
- 恢复与 UNKNOWN 防重放

不得新建与现有体系平行的“第二套生成系统”。

### 12.2 本轮需要支持的三类接入路径

#### A. `GEN_HTTP_V1`

这是未来给自部署 H3 使用的通用生成协议。

本轮虽然不做真实 H3 live，但必须完整实现软件侧生产 Adapter 与合同测试。

#### B. `APIMART_ASYNC`

实现 API Mart 的生产接入。

#### C. `MIMO_TTS`

实现 MiMo TTS 的生产接入。

#### D. `TOKENRHYTHM_ASYNC`

实现 TokenRhythm 的图片/视频接入。

建议尽量复用与 API Mart 相同或相近的异步通路，但仍须以官方文档和真实返回为准。

---

## 13. H3 的要求

本轮不进行真实 H3 GPU 验收，因为 GPU 实例当前不可用。

但是本轮必须保证：

1. `GEN_HTTP_V1` 软件侧实现完整；
2. 视频、图片、音乐、TTS 四类能力都能经该通用协议表达；
3. 未来 H3 服务端只需遵守该协议即可接入；
4. 不需要未来再做一次 H3 专用软件功能开发。

同时：

- 不得删除 legacy H3 Adapter；
- 不得破坏旧 H3 sealed identity；
- 不得破坏旧 H3 Job / Artifact / UNKNOWN 历史记录。

---

## 14. 真实验收案例矩阵

### 14.1 第一批必须完成

1. `LIVE-APIMART-IMG`
   - 1 次 API Mart 图片生成
   - 结果进入 IMAGE Artifact
   - 正式软件可预览

2. `LIVE-APIMART-VID-T2V`
   - 1 次 API Mart 文生视频
   - 结果进入 VIDEO Artifact
   - 正式软件可播放

3. `LIVE-APIMART-VID-I2V`
   - 1 次 API Mart 单图生视频
   - 输入图片具有合法 Artifact 身份
   - 输出视频具有 lineage 记录

4. `LIVE-APIMART-MUSIC`
   - 1 次 API Mart Suno 音乐生成
   - 结果进入 AUDIO Artifact
   - 正式软件可试听

5. `LIVE-MIMO-TTS`
   - 1 次 MiMo TTS
   - 使用简短中文文本
   - 结果进入 AUDIO Artifact
   - 正式软件可试听

6. `LIVE-JEV-R3`
7. `LIVE-JEV-R4`
8. `LIVE-JEV-R5-1`
9. `LIVE-JEV-R5-2`
10. `LIVE-JEV-R5-3`
11. `LIVE-JEV-R5-4`
12. `LIVE-JEV-R5-5`

### 14.2 第二批补充完成

13. `LIVE-TR-QWEN-IMAGE`
14. `LIVE-TR-WAN-IMAGE`
15. `LIVE-TR-WAN-VIDEO-CHECK`
16. `LIVE-TR-WAN-VIDEO-GEN`（仅当 CHECK 通过且可接受成本时）

---

## 15. Live 通过标准

每个真实案例必须分别记录四级状态：

1. `API_PASS`
2. `ADAPTER_PASS`
3. `INTEGRATION_PASS`
4. `PACKAGED_PASS`

只有四级都通过，才能声明该案例 `LIVE PASS`。

以下情况都**不能**算 Live PASS：

- 只连通 API；
- 只有任务 ID；
- 只有 curl 或脚本成功；
- 只有开发模式成功；
- 只有 Mock 成功；
- 未在正式软件中形成 Artifact；
- 未能在打包软件中预览/播放/试听。

---

## 16. 打包软件要求

必须使用正式 Windows x64 打包软件完成真实验收，包括：

- Provider 创建；
- 凭据配置；
- 生成道友创建；
- 发起真实任务；
- 查看/播放/试听真实结果；
- 重启后读取历史结果；
- 至少验证一个 Artifact 的协作复用；
- Jev 相关功能至少在打包软件中完成最关键的 live evidence。

仍需覆盖：

- 1440 宽度；
- 1180 宽度；
- 900 宽度。

---

## 17. 安全要求

### 17.1 UNKNOWN 与防重复收费

所有可能收费的外部提交必须保留 durable `PREPARED → SUBMITTING → SUBMITTED / UNKNOWN` 语义。

- POST 后响应丢失，不得自动重发；
- 已获得任务 ID 只能查询原任务；
- UNKNOWN 不得伪装成功；
- 对真实 Provider 的重复提交必须严格避免。

### 17.2 媒体安全

- 下载 URL 不可信，必须限制与校验；
- 必须验证 MIME、大小、Hash；
- 必须通过 ArtifactStore 受控写入；
- 不得把本地文件系统暴露给 Provider。

### 17.3 密钥安全

- Key 只允许在可信 Main 使用；
- 不得出现在 Renderer、日志、截图、仓库中；
- 文档证据必须脱敏。

### 17.4 Jev 边界

必须保持原有 bounded state、隐私过滤与无执行 authority 原则。

Live Jev 验收的目标是“真实可用”，不是扩大 Jev 权限。

---

## 18. 推荐执行顺序

### S0 — 基线与文档核对

- 核对 main HEAD；
- 阅读本计划；
- 核对 API Mart / MiMo / TokenRhythm 当前官方文档；
- 核对 Jev 当前代码路径与功能点；
- 确认本地密钥文件位置；
- 建立最小 live 验收预算与执行顺序。

### S1 — 软件实现与离线合同测试

- 实现 `GEN_HTTP_V1`；
- 实现 `APIMART_ASYNC`；
- 实现 `MIMO_TTS`；
- 实现 `TOKENRHYTHM_ASYNC`；
- 修复创建模型、任务构造、媒体展示、参数界面中的 H3/视频专用假设；
- 完成离线合同测试和故障注入。

### S2 — API Mart / MiMo 真实验收

- 完成第一批真实生成案例；
- 记录 Artifact 与打包证据。

### S3 — Jev 真实验收

- 逐项验证 R3、R4、R5.1–R5.5；
- 尽量复用少量真实任务降低成本。

### S4 — TokenRhythm 验收

- 先做图片；
- 再做 Wan 视频可用性检查；
- 最后在条件满足时做 1 次最小视频生成。

### S5 — Windows 打包与完整回归

- 完成所有打包软件证据；
- 执行六项原命令；
- 确认 frozen hashes、legacy H3、migration、SQLite 完整性。

### S6 — 证据整理与提交

输出：

- 状态文档；
- 证据目录；
- 最终 SHA；
- 风险与限制清单。

---

## 19. 最终交付要求

建议至少生成：

- `docs/status/gen-v1-live-software-v2.md`
- `docs/evidence/gen-v1-live-software-v2/`

最终必须分别报告以下状态：

1. `SOFTWARE_OFFLINE`
2. `GEN_HTTP_V1_OFFLINE`
3. `LIVE_APIMART_IMAGE`
4. `LIVE_APIMART_VIDEO_T2V`
5. `LIVE_APIMART_VIDEO_I2V`
6. `LIVE_APIMART_MUSIC`
7. `LIVE_MIMO_TTS`
8. `LIVE_JEV_R3`
9. `LIVE_JEV_R4`
10. `LIVE_JEV_R5_1`
11. `LIVE_JEV_R5_2`
12. `LIVE_JEV_R5_3`
13. `LIVE_JEV_R5_4`
14. `LIVE_JEV_R5_5`
15. `LIVE_TOKENRHYTHM_QWEN_IMAGE`
16. `LIVE_TOKENRHYTHM_WAN_IMAGE`
17. `LIVE_TOKENRHYTHM_WAN_VIDEO_CHECK`
18. `LIVE_TOKENRHYTHM_WAN_VIDEO_GEN`
19. `WINDOWS_PACKAGED_LIVE`
20. `LEGACY_H3_OFFLINE`
21. `H3_GPU_LIVE`

状态值只允许：

- `PASS`
- `FAIL`
- `BLOCKED`
- `NOT_RUN`

本轮 `H3_GPU_LIVE` 预期为 `BLOCKED` 或 `NOT_RUN`，但这不影响本轮通过。

---

## 20. 本轮完成定义

只有在以下条件全部满足时，本轮才算完成：

1. 软件侧实现了通用多模态能力与所需 Provider Adapter；
2. API Mart 图片、视频、音乐在正式软件中完成真实验收；
3. MiMo TTS 在正式软件中完成真实验收；
4. Jev 相关依赖功能完成真实验收；
5. TokenRhythm 的 Qwen Image、Wan Image 完成真实验收，Wan 视频至少完成可用性检查，并在条件允许时完成最低成本真实生成；
6. `GEN_HTTP_V1` 软件侧完整实现，为未来 H3 做好准备；
7. 打包软件真实验收通过；
8. 六项原命令全部通过；
9. Legacy H3 与 frozen hashes 等历史不变量保持。

