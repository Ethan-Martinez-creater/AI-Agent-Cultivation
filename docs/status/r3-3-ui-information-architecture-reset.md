# R3.3 — UI Information Architecture Reset

## 范围与依据

基线 `main@e8a97ca`。完整阅读 AP-006，以其 R3.3 和所继承的 AP-005 UI 目标实施；`docs/ai_agent_cultivation_dashboard.png` 只作为视觉方向。只调整 Renderer 的信息架构、组件组织和交互呈现，以及对应 packaged 验收脚本。

没有 migration、依赖增删或前端框架替换。Domain、Application、SQLite adapters、Main、Preload、历史 migration 均保持原有实现。Renderer 继续通过 typed Preload IPC 请求 Main，权限、模型身份、Availability、Memory scope、Human Bridge continuation、Jev SHADOW 的 authority 均未迁移到 UI。

## 信息架构

| 主导航 | 默认内容                                                                  | 下沉入口                                      |
| ------ | ------------------------------------------------------------------------- | --------------------------------------------- |
| 首页   | 发起历练、进行中/等待动作、最近历练、本尊待办、首次使用路径               | 通过真实任务链接进入历练/本尊详情             |
| 道友   | 紧凑名单、头像/名称、固定 Model、Availability、Benchmark 能力             | 功法分配、经历、身份/Runtime/Provider 信息    |
| 队伍   | 固定/临时队伍、Coordinator、成员、Availability                            | 创建/编辑/归档和队伍历练入口                  |
| 历练   | 自由历练筛选、Objective、状态、审批、公开结果、执行 Timeline              | Run 历史、Usage、Audit、持久协作 artifact     |
| 记忆   | 按道友选择的记忆、候选审核、创建/编辑/归档                                | 保留既有 scope、Accept/Edit/Reject 操作       |
| 设置   | Provider / Credential / Runtime / Benchmark / Embedding / Jev Shadow 分区 | 功法 Skills、法宝 Tools、灵石 Usage、本尊待办 |

左侧导航可收起为图标栏，保持可访问名称。Chat 从道友详情进入，仍有独立 Conversation。旧 Skills/Tools/Usage/External Work 路由继续可访问；高级页面提供返回设置和相邻页面导航。没有不可用的 Workflow 标签或空入口。

历练是任务中心：当前页面保留指定道友、指定队伍及 CONSULTATION / REVIEW / DELEGATION，创建表单与列表/详情已拆分到独立页面。后续任务类型可以扩展页面结构；本轮没有 Workflow domain/table/service/UI，也没有提前模拟 Step。

## 视觉与交互

- 白色主体、低对比灰色分隔、蓝色主操作。统一颜色、边框、圆角和字体 tokens；四级字体为 20px 页面标题、14px semibold 区块标题、14px 正文、12px 次要信息。
- 减少大面积统计卡、重复说明和嵌套卡片。默认显示实际任务/身份/操作；底层 ID、Audit、Benchmark 来源、MCP 配置和 Shadow 诊断采用明确的高级入口或折叠区。
- 输入保留外部 Label，移除 placeholder 和示例预填文字。日期、版本、已有设置等有业务含义的默认值保留；新建道友的描述等文本为空。
- 道友固定模型只读；没有 Runtime switch、Mission rating 或动态 evidence 入口。能力显示直接来自 effective Benchmark，支持 0 分与 unsupported 仍可区分。
- Availability 的颜色点、短文字和“重新检测”融入道友、Chat、Runtime、队伍与历练相关区域。本尊仍是 Human Bridge，没有模型 availability。显式不可用道友保留“重新检测 / 选择其他道友 / 取消”，不静默改派。
- 本尊待办优先展示工作队列与交付详情；资料/能力与外部应用配置下沉。任务显示请求道友名称，首页和详情支持 requestId 深链接。开始、提交、验收、退回和取消沿用既有 R2/R3.1 语义。
- Cloud Shadow 继续默认不启用。启用前须用户明确勾选已阅读发送范围；隐私说明和现有 observation/诊断均可展开，Jev 仍严格 SHADOW。
- 窄窗口保持单列侧栏；道友名单先于详情，各表单/详情区按宽度调整，长表格在自身容器内滚动。

## Renderer 拆分

`main.tsx` 从约 5900 行缩减到 175 行，负责 Shell、路由和导航。首页、道友、Chat、队伍、历练、记忆、设置、Skills、Tools、Usage 分别进入 `pages/`；typed UI contracts 和共享展示工具移至 `ui-shared.tsx`。道友和历练/队伍的局部样式独立，使用全局 Design Tokens。

拆分后仍使用原 React / React Router 和 typed IPC；没有新状态管理框架，也没有把 Provider SDK、Node 或 SQLite 放入 Renderer。

## 验证

2026-09-30 最终验证均 exit 0：

- `npm run test`：41 files / 320 tests。
- `npm run typecheck`、`npm run lint`、`npm run format:check`：通过。
- `npm run package`：Windows x64 / Electron 44.4.3，native better-sqlite3 准备通过。
- `npm run smoke:package`：完整 Gate 0–6、R0–R3.2 和新增 R3.3 UI suite 通过。包含 SQLite、secret boundary、Memory/Skill、Tool/MCP、协作 deny provenance、Experience、Human Bridge、Shadow 和 continuation crash/restart 回归。

最终包为 `out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`，246,236,672 bytes，构建时间 2026-09-30 16:11（本地时间）。构建后仅继续修正验收脚本和文档，没有再修改生产 Renderer。

新增成功标记为 `R3_3_UI_PACKAGED_SMOKE_OK`。最终截图和 30 组合布局测量在 `.test-data/r3-3-ui-65fc4746-4324-43fd-89ca-f0d5d4d76f2e/`，包含 `screenshots/` 与 `ui-measurements.json`。人工复核了实际 package 的首页、道友、队伍、历练、设置、本尊待办、窄窗口布局与不可用 Chat 错误截图；修复了窄窗口继承旧导航网格和名单顺序的问题。

| 场景                                 | 验证方式                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Gate 0–6、R0–R3.2 安全与业务不变量   | 完整 deterministic test 和历史 packaged suite                                         |
| 六项导航、收起/展开、设置高级入口    | 实际 Windows package UI 点击                                                          |
| Chat Streaming 与持久 Conversation   | UI 新建、发送 PING、显示 PONG，重启保留                                               |
| Memory A/B 隔离                      | UI 为 A 创建私有记忆，切换 B 后不可见                                                 |
| Skill 分配/启用/停用                 | 道友详情 UI 操作，保留默认停用语义                                                    |
| Benchmark 绑定与支持 0 分            | 设置表单保存，检查 effective 展示及 typed 持久事实                                    |
| SOLO/Party、审批、Timeline、公开结果 | 历史 suite + 新 UI 批准协作并完成原 Mission                                           |
| Tool/MCP                             | 真实工作区、MCP fixture、UI 连接发现、可见 Timeline，保留 Gate 4 安全断言             |
| Human Bridge 重启后的提交/验收       | R2 packaged UI 标记开始、提交文件、填写摘要、验收，检查同 Run/continuation/provenance |
| Availability 不可用错误              | 持久 hard failure 后重启，UI 拒绝发送、不持久化阻塞消息、不改派；手动重检恢复         |
| 布局/滚动/Label/空状态               | 1180×780、1440×900、900×600 三种真实窗口尺寸，10 页面共 30 组合；截图与布局测量       |

新脚本 `scripts/r3-3-ui-packaged-smoke.mjs` 已进入 `npm run smoke:package`。`ui-navigation.mjs` 通过新的可见导航访问旧功能；历史 smoke 使用真实“全部”筛选和高级展开动作，保留原 SQLite/执行/安全断言。

验收数据、截图、测量、缓存和临时目录均位于仓库 `.test-data` / `.tmp`。没有要求真实 API Key，没有向外部收费模型发送验收请求。未重新生成 installer，本轮交付为 Windows x64 packaged app。

## 已知限制与明确未实现

没有改变已有长内容的语义；Timeline 的原始安全元数据、完整 Audit 和 Benchmark provenance 仍需展开高级区域查看。窗口验收覆盖常用三种尺寸，未宣称覆盖全部 DPI/多屏组合。

未实现 Workflow Engine、Workflow 编辑/执行界面、R4 自动路由、自动换道友、本尊自动 fallback、Skill/Memory/Tool routing、R5 或其他新 Agent 能力。没有恢复动态任务评分、Realm 自动晋级或修改 sealed ModelBinding。
