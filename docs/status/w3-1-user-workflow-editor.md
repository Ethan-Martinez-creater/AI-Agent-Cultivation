# W3.1 — User Workflow Editor + Versioning

实施基线：`212f1a5133a36256ad1d60805b55b6878bc27a8a`。范围仅为 W3.1；W3.2 的 Import Existing Work、State Resolver、从中间步骤恢复不在本轮范围内。

## 领域与持久化

- 新增 `0031_w31_workflow_drafts.sql`，历史 0001–0030 不变。`workflow_user_drafts` 保存独立 Draft ID、稳定 definition ID、baseVersion、revision、结构化内容和时间；不复制 Run/Mission/Usage 状态。
- Draft 可以保存尚未填写完成的结构化内容。Main 重新解析有界字段，发布时进行完整 domain validation。未知或带 authority 的字段在保存时就被拒绝。
- revision 是并发编辑控制；SQLite 保护 Draft identity/base/createdAt，并要求更新 revision 严格加一。基于旧 head 的发布拒绝。
- 发布在同一个 SQLite 事务内写入现有 immutable WorkflowVersion 并删除对应 Draft。任一步失败回滚，不能留下半发布版本。
- 新版本可以更新名称、说明、分类、输入 schema、图和输出约定；旧版本与 Run version pin 永不改写。

## 编辑器与 authority

工作流页面分为运行记录、官方工作流、我的工作流。结构化列表支持基本信息、输入 schema、步骤增删、实际拖拽和键盘排序、输入产物绑定、输出 inline contract、能力要求、执行方式、审核策略与条件分支。

Draft intent 不接受 source/version、Provider/Model/Runtime/Credential、Permission、MCP env、Tool arguments、release metadata/hash、官方 validation policy 或 generation requirements。Main 编译 source=USER、分配 version，并通过原 WorkflowService 发布。

用户步骤只开放现有 TASK/REVIEW/DECISION 和 inline TEXT/JSON/METADATA validator，编译 effectType=NONE。这不会授予 Tool/File 权限：执行仍由 W1 → R4 → Mission → ToolRuntime/Permission/Artifact 路径承担；实际 Tool 副作用与 UNKNOWN 恢复保持现有 authority。

## 发布规则

- 32 Steps、96 Edges、12 inputs/outputs/final outputs 上限；attempt 为 1–5；内容总量受现有版本存储限制。
- 拒绝重复 ID、dangling/self edge、不可达 Step、任意 cycle、歧义条件和未经声明的条件类型。
- 产物输入必须引用真实 upstream output；必需输入只能引用必需 producer output，producer 必须在所有到达 consumer 的路径上存在。
- 必需最终结果必须由正常完成路径上的 producer 提供；最终 schema 由 producer 精确投影，不建立独立更强 contract。
- REVIEW 消费真实产物并产生结构化 verdict/findings/evidence/summary/reviewedArtifactIds，沿用现有 lineage validation。REVIEW_PASS 不允许非 PASS 的向前执行目标。
- DECISION 读取声明的 JSON 输入，只选择 frozen declared branch，不调用新决策引擎或生成 graph。
- 普通线性列表排序由可信 application 重建 sequential edges；条件 graph 和破坏输入顺序的排序拒绝，不能仅修改显示数组。

## USER / BUILTIN 边界

官方版本只读，普通 Renderer 无 BUILTIN 注册/发布接口。复制产生新的 USER definition/history，官方 release/version/hash 不变。USER 复制保留安全通用图与约定；官方复制剥离官方 policy、revision/effect/generation/tool authority，并转换为可编辑的通用顺序草稿。它是修改起点，不承诺保留官方特殊执行保障；复制确认界面明确说明。

## 验证与证据

最终六项验证、Windows packaged UI/SQLite 事实和 1440/1180/900 截图统一归档于 `docs/evidence/w3-1-user-workflow-editor/`。最终结果完成后记录于该目录的 acceptance 与 validation logs。

开发内循环仅运行本轮 domain/service/persistence/IPC/Renderer focused tests，稳定后运行 W1/W2、R4、Permission/Tool、R5 Harness、G3 与恢复的受影响回归，再运行六项最终原命令。

开发定向测试 43 项通过；受影响回归 84 文件 / 833 项通过。新增 on-disk profile 升级测试固定 30 秒超时（完整历史 migration、正式 release 安装和两次打开 profile），不改变原测试命令或全局 timeout。

首轮全量验收发现测试用 FakeGenerationGateway 在状态文件原子替换时的临时占用失败。仅该 test-only adapter 对 EPERM/EACCES/EBUSY 做最多五次、总等待 375ms 的同一份事实保存重试；不重试 submission/generation。新增临时占用恢复、上限 fail-closed、非占用错误不重试测试，保留原幂等/UNKNOWN 测试；G1/G3 受影响回归 49 项通过后，从全量测试重新开始最终六项。正式 Provider 和 GenerationJob 状态语义不变。

Windows package 沿用项目内 `.tmp/g3-verify` native ABI 隔离：根目录保留 Node SQLite 供 test/smoke，副本使用 Electron SQLite。执行原 `npm run package`；最终 `build-provenance.json` 逐文件验证源码、migration、构建配置与副本字节一致，并记录 app.asar/EXE hash。无临时 NODE_OPTIONS preload、无真实 Jev/Provider API 依赖。

packaged W2.4 shared release audit 的 latest-migration 断言同步为 31；历史 migration 和三个正式 package 不变。用同一份已经跑完新闻/软件/科研场景的真实 SQLite 进行定向 audit，冻结 hash、所有完成 Step 的 Artifact/Receipt/Checkpoint、revision budget、Operation Receipt、Routing/Usage 与 FK/integrity 全部通过，再从 test 重跑最终完整六项。

官方复制是有提示的通用草稿转换：官方 bounded revision 回边不开放给编辑器，循环内的未来输入会去除；其余真实 upstream 依赖保留。三个正式 package 的 copy → USER publish 均有 persistence 测试，原 content/manifest 不变。

### 最终冻结验收（2026-10-09）

验证源码提交：`ae3f3c214674493bfe1a66252fcd2706dc3d3f7b`。以下仅使用最后一轮完整成功结果；此前失败轮次不作为通过证据。

| 原命令                  | 结果                                                           | 证据                           |
| ----------------------- | -------------------------------------------------------------- | ------------------------------ |
| `npm run test`          | PASS，147 文件 / 1336 项                                       | `validation/test.txt`          |
| `npm run typecheck`     | PASS                                                           | `validation/typecheck.txt`     |
| `npm run lint`          | PASS                                                           | `validation/lint.txt`          |
| `npm run format:check`  | PASS                                                           | `validation/format-check.txt`  |
| `npm run package`       | PASS，Windows x64 Electron package                             | `validation/package.txt`       |
| `npm run smoke:package` | PASS，完整 Gate / Routing / Workflow / Generation / Harness 链 | `validation/smoke-package.txt` |

证据路径均相对于 `docs/evidence/w3-1-user-workflow-editor/`。`build-provenance.json` 核对 489 个源码及配置文件与构建副本逐文件一致，记录 package hash；`acceptance.json` 记录六项日志 hash、退出码和验收矩阵。

Windows packaged 验收从正常 production profile 启动，三个正式 Workflow 存在、无用户 fixture Run/Draft。通过可见 Renderer 创建和编辑草稿、真实拖动步骤、配置产物约定/能力/审核分支、发布 v1、创建 Run A，再发布 v2 并创建 Run B。Run A 固定 v1，Run B 固定 v2；两者均经现有 W1/R4/Mission 路径完成 TASK → REVIEW → 条件结束，三个实际执行步骤与一个未选中分支有独立持久化事实。

官方复制产生新的 USER identity，修改及发布副本后，三个正式 v1 content/manifest hash 不变。非法 graph/contract/authority intent 被 Main 拒绝，未产生非法 published Version 或执行。重启保持 Draft、版本与 Run binding；审批重启仍绑定原 Run，DENIED 后目标文件不变，再次正常生产启动没有 Mission/Tool 重放。

`compatibility.json` 从 native SQLite 导出六个实际 Routing context：`origin=WORKFLOW`，`executionId` 对应 WorkflowRun，`stepId` 对应 WorkflowStepRun。全链 smoke 继续覆盖 R4、W1/W2、G1–G3、R5.1–R5.5、Memory/Skill actor scope、Tool/Permission 和 Human Bridge continuation。

24 张真实 Windows 窗口截图覆盖 1440 / 1180 / 900：我的工作流、编辑器、展开步骤、输出约定、审核分支、发布版本、完成的 USER Run、重启后的列表。已检查三档布局与滚动，主要编辑无需横向滚动；截图、尺寸与 hash 见 `packaged/facts.json`。

## 明确未实现

无 Import Existing Work/IMPORTED 产品流程、State Resolver、无限画布、任意 DAG/循环、用户 revision group 编辑器、SUBWORKFLOW、脚本/HTTP automation、模型生成 Graph、官方模板修改、Runtime 切换或新 Agent Runtime。没有新增依赖。

## 首版边界

- 拖动排序只对可安全重建的线性步骤列表开放；有分支或会破坏 upstream binding 的移动由 Main 拒绝。
- 输出约定编辑限于现有 inline TEXT/JSON/METADATA 子集，不开放官方 Contract Registry、release policy 或 side-effect authority。
- 官方复制生成通用编辑起点，会去除官方特殊执行语义；用户必须重新检查并发布自己的版本。官方原件及历史运行事实保持不变。
- 本轮实际执行验收使用离线 fixture。没有新增真实 Provider/Jev 联调，也不需要仓库保存 API Key。
