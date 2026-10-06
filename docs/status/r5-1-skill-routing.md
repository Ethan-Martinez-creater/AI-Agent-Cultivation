# R5.1 — Skill Routing

基线：`ad2f61fb57453b6c0ff5c5bdebf751c2aa5ca077`。仅实现 Skill relevance selection，不进入 R5.2–R5.5、W3 或 R6。

## 执行边界

`当前执行者的 enabled ACTIVE assignments → deterministic shortlist → bounded Jev relevance / deterministic fallback → Top 1–3 → 既有 PromptComposer`。

- 独立 application `SkillRoutingService` 只依赖当前道友 assignment 查询、按 ID 读取 Skill 和 `DecisionGateway`。没有修改 Permission、Tool、Runtime、Capability、Workflow 或 assignment 的写端口。
- 最多检查 512 个当前道友已启用 assignment；以 ID 排序后读取，按 metadata 文本相关度排序，最多 24 个候选。相同相关度按 ID 固定排序。
- 只发送 id/name/description/tags 与当前任务或冻结 Step 的 allowlisted metadata。完整 instructions、Memory、聊天、文件正文、Tool output、Workflow 历史、Artifact content、Credential 不进入 Jev。
- Jev state 最多 6000 UTF-8 bytes，context 最多 1500 bytes。返回 envelope 最多 4096 bytes，只接受当前候选内的 0–1 有限 score、唯一 ID、最多 3 项；没有自由 action 或 rationale。
- `r5-1-skill-routing-policy-v1` 集中维护候选、预算、超时和 lexical 权重。`r5-1-skill-relevance-question-v1` 使用每候选一个 numeric Noul 问题。
- await 后重新读取 Skill 和 assignment；PromptComposer 再验证 ACTIVE、当前道友归属、enabled、selected subset。R5.1 注入最多 3 个 Skill，整个 Skill section 最多 6000 characters，调用者不能提高此上限。

## Jev 与 fallback

Main 复用现有 safeStorage credential resolver 和固定 `jev-1.13.0` adapter。R5.1 使用独立 `SKILL_RELEVANCE` typed 请求路径；R3 validator 明确拒绝该类型，旧 Decision Plane 继续 SHADOW。R4 接受的 decision types 未扩大。

R5.1 Cloud 路径要求用户已主动启用现有 R4 `cloudEnabled`，且 Main 能取得 Jev credential。没有配置、timeout（6 秒）、网络/SDK error、非法 schema/ID/重复项/过量/超大结果，都按同一 deterministic candidate 集合的 metadata relevance 取前 1–3。fallback 不扩权、不修改原 execution assignment、不伪装 Jev 成功。候选为空则不注入 Skill；ownership 查询失败则 EMPTY，不利用旧 snapshot 推测权限。

本轮用户选择仅离线验收：**Live Jev = NOT RUN**。FakeDecisionGateway 仅用于显式测试；正常 production 不启用 R5.1 fixture。

## 覆盖路径与持久化

- 自由 SOLO LANGUAGE Mission。
- Party Coordinator proposal、DRAFT、PARTICIPANT、SYNTHESIS；每次使用实际执行者自己的 assignment。Coordinator Skill 不传播给成员。
- Workflow LANGUAGE Step 复用 R4/Mission/Party adapter，使用冻结 Step objective/type/capabilities、当前 Step input binding 的 Artifact metadata、expected output contract；不发送完整 Workflow detail/history。
- G3 LANGUAGE Participant 继续使用 `g3-v1` structured ParticipantOutcome。GENERATION 分支绕过 LANGUAGE PromptComposer，不修改 GenerationTask/Job/Gateway/continuation。
- 普通 Single Chat 保持原 Gate1 Skill composition，R5.1 未扩大到 Chat 或 Generation Chat。
- selection evidence 复用 append-only MissionEvent/AuditEvent：`skill.selection` 保存实际 actor/Run、candidate IDs、selected IDs、有限 score、input hash、policy/question version、mode/reason/error code。`skill.used` 仍来自实际发起的模型调用，不把一次选择当作执行经历。
- **无新增 migration、无新增依赖**。0001–0030 与 W2 OFFICIAL v1 package 均保持不变。

## 验证证据

最终六项原命令均通过，完整日志归档于 `docs/evidence/r5-1-skill-routing/validation/`：

| 原命令                  | 结果                                      |
| ----------------------- | ----------------------------------------- |
| `npm run test`          | PASS：127 个测试文件，1041 项测试         |
| `npm run typecheck`     | PASS                                      |
| `npm run lint`          | PASS                                      |
| `npm run format:check`  | PASS                                      |
| `npm run package`       | PASS：Windows x64 Electron package        |
| `npm run smoke:package` | PASS：完整 Gate/R/W/G/R5.1 packaged chain |

Windows 本轮最终执行证据位于 `docs/evidence/r5-1-skill-routing/c91aec95-4137-478c-8c9e-dda748478350/`，包含 facts 与真实窗口截图。9 次实际模型调用对应 9 条 durable selection，逐一核对 actor、Mission/Run、selection hash、最终注入 Skill IDs 与预算；自由 Mission、Party、Workflow TASK/REVIEW、冻结 input Workflow 与禁用 Cloud 后的 fallback 均完成。成员保留自己的 Runtime/Skill，G3 LANGUAGE Participant 的 `g3-v1` contract 保持。

独立 selector/adapter/application 测试覆盖跨道友、disabled/archived/unassigned、await 期间 assignment 变化、非法/重复/未知 ID、超量/超大返回、超时与网络错误、deterministic tie/fallback、metadata-only 请求、最终 Prompt 再验证和 R3 SHADOW 拒绝 R5.1 请求。

`generation-regression.json` 归档原六项 smoke 中的 G1/G2/G3 恢复摘要。G3 packaged SQLite 中 33 次 LANGUAGE model call 对应 33 次 selection；GENERATION 的 LANGUAGE selection/injection 为 0。UNKNOWN 零重提、streaming、安全提交、pre-Job 恢复、REJECTED/UNKNOWN 区分、Human Bridge continuation 和 Workflow generation bridge 均通过原回归。

`frozen-hashes.json` 从正常 production packaged SQLite 读取三个 OFFICIAL v1 manifest/content hash，与已审批 G3 基线逐项相等。生产启动未加载本轮 Fake，官方模板仍只有三个，migration 仍为 0030。

Windows 打包在项目内隔离目录运行原 `npm run package`，复制本轮全部源代码以隔离 Electron native rebuild 与 Node 测试 ABI；使用仓库已有 Forge 配置，没有临时 preload、额外测试参数或外部目录写入。测试 profile/cache 位于项目内 ignored 目录，截图与 bounded facts 单独归档。证据观察器只保存任务 metadata 的 hash/shape 和有限枚举/ID，不保存 objective、Skill instructions 或 Memory 正文。

## 未实现与限制

没有 Memory pre-gate/rerank、Tool shortlist、Review/Completion advisory、Benchmark 修改、Runtime switching、Workflow graph 修改或新 Agent/Skill Runtime。metadata relevance 是选择辅助，不代表能力评分或 Permission。

实时 Jev 返回没有本轮 live API 证据；离线 TypeSafe transport tests 验证正式请求/响应 schema，packaged Fake 则验证 Main 到真实执行 Prompt 的完整链路。
