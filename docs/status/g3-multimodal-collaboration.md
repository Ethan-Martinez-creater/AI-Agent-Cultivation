# G3 — Multimodal Collaboration

基线：`108a1154ad4a92f36e8ea60dd898f3bd0c6235bc`。范围按 Generation Spec v0.2 和 G3 Multimodal Collaboration Plan v1.0；不进入 R5/W3。

## 架构与持久化

- 新增 `0030_g3_multimodal_collaboration.sql`，0001–0029 不变。独立保存 immutable ExecutionTask、execution attempt、typed outcome、continuation decision 和 trusted ArtifactRef。CollaborationRequest 仍只表达用户审批。
- `G3ExecutionService` 作为 provider-neutral dispatcher：LANGUAGE 使用现有 Gate5 + ModelGateway；GENERATION 使用 G1/G2 GenerationTask/Job/Gateway/Artifact Store；USER_BRIDGE 使用 R2 ExternalWork。未复制 GenerationJob 状态机或 Permission authority。
- Party Coordinator 必须为 sealed LANGUAGE；GENERATION 为正式成员。本尊保持 ACTIVE / USER_BRIDGE / FALLBACK_ONLY / HUMAN_BRIDGE、无 Runtime。
- LANGUAGE outcome 使用 AI SDK structured output + schema validation。支持 RESULT、NEEDS_INPUT、NEEDS_CAPABILITY、FAILED_RETRYABLE、FAILED_TERMINAL；模型不能指定新增成员、修改状态或授予权限。
- Task/attempt/outcome 均绑定 Mission、Run、获准请求、实际 actor 和 sealed Runtime。准备阶段不可用者不生成虚假的执行产出。
- attempt / continuation / retry 上限分别为 3 / 3 / 1，并受现有 collaboration/model/tool budgets 约束。重试生成新的 Task 和 idempotency key；已提交 continuation 重启时先复用，再检查新决策预算。UNKNOWN 不自动重提。

## 交接与恢复

- ArtifactRef 只含 id/kind/mime/hash/size；不传媒体二进制、Provider URL、绝对路径或文件权限。交接校验实际 Artifact、Run provenance、角色和 frozen Descriptor；工作区素材读取走实际参与者的 FILE_READ / exact Mission grant。
- NEEDS_INPUT：先复用可信本 Run 素材，再由 R4 在固定 Party 成员中选择依赖执行者并独立审批；无法满足时由本尊补交或暂停。NEEDS_CAPABILITY 只请求能力，不直接选择道友或递归委派。
- 本尊 ACCEPT 回调与数据库 authoritative envelope 精确核对：最新 Run、真实系统身份、ACCEPTED request、Artifact 清单和 public result。消费使用 CAS；伪造回调不解锁执行。
- 生成成果需要审查时独立创建本尊审查待办。当前 LANGUAGE adapter 不具备安全媒体输入能力，不伪造视觉/音频自审。用户接受的审查属于 ExternalWork 事实。
- 直接分配本尊的协作也先建立 G3 Task/attempt，沿用 R3.1 synthesis crash barrier：CONSUMING 且已有执行事实但无 FINAL 时不重放；已有 FINAL 则完成原 Run 并消费对应 continuation，旧 Run 不受影响。
- 启动恢复保护只读取当前 Run 的 Task/APPROVED request。历史 Run 留有协作不会让一个尚无 G3 intent 的新 Retry Run 获得自动重放资格；此情况继续走既有 interrupted recovery。
- Workflow bridge 使用冻结的 GENERATION execution requirements，复用 R4 → 原 Mission → Generation → W1 deterministic validation/checkpoint。Main 输出符合既有 W1 Mission 文本承载 JSON Contract 的协议；测试模板明确 test-only，正常生产只安装既有官方模板。
- R4 默认自动/SOLO 继续使用 LANGUAGE 候选；显式固定 Party 仅对非 Coordinator 允许 Generation，prepare 按 sealed executionProtocol 使用对应 Availability。await 后重新检查同一 eligibility。Workflow/dependency 的明确 Generation 协议请求使用同一 R4 入口。
- LANGUAGE continuation 的检索 query 保持原始获准 public task，媒体元数据单独作为 bounded/untrusted context 交给模型；避免元数据包装改变 Memory FTS 查询。检索和 Skill scope 始终属于实际执行的道友。

## UI 与验收

Mission/Party 展示参与者、生成/缺素材/缺能力/等待本尊/重试/审查状态与 image/audio/video Artifact 卡片。内部 IDs/error codes 下沉 Advanced；1440、1180、900 真实 Windows package 截图归档于 evidence。

最终源码测试：**124 个文件、1012 项全部通过**。新增 persistence/application/Main/UI regression，同时保留旧 G1 crash 断言。日志目录：`docs/evidence/g3-multimodal-collaboration/validation/`。

| 命令                    | 结果                                |
| ----------------------- | ----------------------------------- |
| `npm run test`          | PASS，1012/1012                     |
| `npm run typecheck`     | PASS                                |
| `npm run lint`          | PASS                                |
| `npm run format:check`  | PASS                                |
| `npm run package`       | PASS，Windows x64 / Electron 44.4.3 |
| `npm run smoke:package` | PASS，真实 Windows 全量回归         |

最终 packaged evidence：`9582b922-c4e6-4869-94eb-a51a1de6228d/facts.json` 与 `human-833daaf7-3550-44ec-94e5-2f1483e9cfc5/facts.json`，均位于 `docs/evidence/g3-multimodal-collaboration/`。`acceptance.json` 汇总 A–J、权限/归属、Workflow 和本尊恢复事实。共 18 张真实截图覆盖三档窗口，包括媒体播放器近景；测试应用已全部关闭。

## Crash / restart 矩阵

重建 service 的确定性测试与真实 packaged process kill/restart 配合验证。每个窗口保留原 MissionRun、Task、attempt 和 providerJobId，并在完成后再次重启核对稳定计数。

| 窗口 | durable 边界                             | 断言                                                           |
| ---- | ---------------------------------------- | -------------------------------------------------------------- |
| A    | APPROVAL_COMMITTED                       | 原审批恢复，只建立一项逻辑 Task                                |
| B    | TASK_CREATED                             | 原 Task 建立一个 attempt                                       |
| C    | JOB_BOUND                                | 原 PENDING Job 续跑；原 key 一次逻辑提交                       |
| D    | GENERATION_COMPLETED                     | 复用安全 Artifact，生成一次 outcome                            |
| E    | NEEDS_INPUT 的 OUTCOME_CREATED           | 恢复原需求，依赖独立批准                                       |
| F    | DEPENDENCY_COMPLETED                     | 复用依赖 Artifact，上游恢复一次                                |
| G    | NEEDS_CAPABILITY 的 DEPENDENCY_COMPLETED | LANGUAGE 上游得到同 Run 媒体事实，无递归成员邀请               |
| H    | CONTINUATION_CREATED                     | 原 retry decision 生效，新 Task/key 一次；不重用拒绝 key       |
| I    | REVIEW_COMMITTED                         | 本尊审查 ACCEPTED 已持久化，重启只做一次 Coordinator synthesis |
| J    | RESULT 的 OUTCOME_CREATED                | 原 RESULT 事务性提交 Gate5，outcome 仅消费一次                 |

额外覆盖 direct Human Bridge `CONSUMING + FINAL` 恢复：不重复模型调用，只完成原 Run 和对应 continuation。旧 Run 事实不被消费。

## 冻结边界

0001–0029 和三个 OFFICIAL v1 package 未修改。真实 package SQLite 中 release manifest 与 version content hash 均与 G2 审批证据一致，详见 `docs/evidence/g3-multimodal-collaboration/frozen-hashes.json`。

| OFFICIAL v1  | manifestHash                                                       |
| ------------ | ------------------------------------------------------------------ |
| AI 资讯视频  | `ae37a04bf0156c42adea41d8d0418de2f942d6dc677803727af7db41ab36e4cd` |
| 软件功能开发 | `30eb30ce957ef3bad798d1046bd45835322b645d97e49ca5affcac4e16cd348d` |
| 科研         | `199c675c91c1c7d15709141be9a7dc6ce1e776f3c1b0af7c66c2ff9e1f3b03d3` |

## 已知限制与未实现

- **Live H3 Integration = BLOCKED / NOT RUN**：未提供真实 endpoint；验收使用离线 H3 HTTP fixture，图片/音乐为显式 test-only gateway，正常生产不加载。
- 当前媒体审查使用 durable Human Bridge；不宣称文本 adapter 已具备视觉/音频消费能力。
- 三个 W2 OFFICIAL v1 Definition/Contract/manifest 保持冻结；本轮不将它们改造成生成 Workflow。
- 没有新增真实图片/音乐 Provider、递归协作、自由群聊、R5/W3 能力或依赖。
