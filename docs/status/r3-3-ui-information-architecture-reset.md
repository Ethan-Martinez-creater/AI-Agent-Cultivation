# R3.3 — Visual / Product UI Revision

## 范围与基线

基线 `main@db71a32`。本次按完整阅读后的 `AI-Agent-Cultivation_R3.3_Visual_Product_UI_Revision_Plan_v1.1.md`、AP-006 和上一轮状态记录实施。上一轮的信息架构提交未获视觉审批；本文件记录本轮修订后的交付，替代上一轮验收结论。参考图用于视觉方向，计划文档优先。

本轮只收束 Windows 桌面产品界面和三个已确认的 consistency 问题。没有 migration，没有 Workflow、R4、自动路由、Runtime switch、动态能力或 Mission 评分。

## Desktop Shell 与统一视觉

- Frameless Electron 窗口，自定义标题栏；Main 移除默认菜单。唯一品牌区位于标题栏，Sidebar 不重复软件名称。
- 标题栏拖动区与按钮区域分离；最小化、最大化/恢复、关闭通过受 sender 校验的 typed IPC 执行。
- 六项主导航：首页、道友、队伍、历练、记忆、设置；折叠后保留可访问名称与 tooltip。
- `product.css` 集中维护浅灰背景、白色内容面、蓝色主操作、语义状态色、8/12/16 圆角和克制阴影；字体为 24px 页面标题、16px 区块标题、14px 正文、12px 辅助文字。
- 统一 `Icon`、`Avatar`、`Button`、`Drawer`、`EmptyState`、`Section`、`StatusBadge`、`SplitView`，Shell 与页面分离。功能图标使用本地 tree-shaken Lucide，不使用远程字体/图标 CDN。
- Logo 为独立蓝色连接/成长 mark；验收覆盖 16/24/32/48px。

## Avatar 与安全边界

10 个预置头像使用用户确认的 `docs/avatar` 图片，以 `-1` 至 `-10` 对应 `preset:01` 至 `preset:10`。应用资源保留原像素，使用 CSS 圆形裁切；原始文件没有被修改。Human Bridge 和用户有独立专用头像。新建道友默认预置头像；旧 null 头像稳定映射到预置图，首字母只作为无效资源/加载失败 fallback。

本地头像导入路径：Renderer → typed IPC → Main 原生文件选择 → 扩展名/magic bytes/2 MB 大小/2048px 尺寸校验 → native decoder → 中心裁切与 256px PNG 规范化 → `userData/avatars` → opaque `local:<uuid>.png`。不接收 Renderer 指定的原始路径，不允许 SVG/HTML 或任意 URL；读取只接受 UUID ref，校验 canonical path，图片来源路径和元数据不持久化。资源缺失不会使页面崩溃。

新增 `desktop:copyText` 仅提供受大小约束的 Main 剪贴板写入，服务于 Chat 代码复制；不新增 Renderer 剪贴板读取能力。头像 Main tests 覆盖持久化/重启、格式伪装、大小/尺寸、非法 ref、坏 decoder 输出；desktop IPC tests 覆盖 sender、路径注入、取消和剪贴板长度上限。

## 核心用户流程

| 页面     | 默认体验                                                                                            | 保留的高级能力                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 首页     | 空状态仅一个“创建第一位道友”主 CTA；正常首页显示发起历练、最近/进行中任务、待我处理、本尊待办       | 高级设置次级入口                                                                                                |
| 道友     | 紧凑名单与当前档案；正式头像、固定模型、Availability、已配置 Benchmark 能力、启用功法、真实最近活动 | 身份详情、所有能力来源、Skill 分配、经历/能力记录                                                               |
| 创建道友 | 身份 → 模型 → 确认；已有配置或内嵌 Provider/Endpoint/API Key/Model ID 配置与测试                    | Identity/Behavior prompt 折叠                                                                                   |
| Chat     | 会话列表、固定 Header、独立消息滚动、固定 Composer；用户/道友头像与左右区别                         | Memory candidate 提取、代码复制、持久会话                                                                       |
| 队伍     | 队伍列表、Coordinator、成员头像及身份状态                                                           | Drawer 创建/编辑，归档与发起队伍历练                                                                            |
| 历练     | Objective、执行者、结果、Pending Approval/Collaboration、最近动态                                   | Run、Usage、Audit、完整时间线与公开 artifact                                                                    |
| 记忆     | 当前道友归属置顶、紧凑列表                                                                          | Drawer 新增/编辑、候选 Accept/Edit/Reject、归档                                                                 |
| 设置     | 分组侧栏和右侧管理页                                                                                | Provider、Credential rotation、模型模板、Benchmark、Embedding、Jev Shadow、Tool/MCP、Skill、Usage、Human Bridge |

创建流程继续复用 Provider/Credential/Runtime/private sealed binding。API Key 通过现有 Main 剪贴板安全导入并立即清空，Renderer 不读取明文或 ciphertext。测试期间锁定模型相关字段；字段变化使测试状态失效；最终创建仍由 Main 重新测试并原子 seal，不能测试 A 封存 B。关闭流程不会自动删除已经保存的 Provider/Credential/Runtime 模板，仍可在高级设置管理。

Chat 流式消息保留实际 request/teammate/conversation 归属；异步历史加载也检查当前身份，避免快速切换时显示旧会话。代码围栏作为 React text nodes 渲染，无 HTML 注入。失败保留草稿，不可用模型显示明确重新检测/选择其他道友/取消，不自动改派；900px 下会话列表通过可达的抽屉入口展示。

真实 packaged 验收中发现并修复了创建流程向 strict IPC 多传身份字段的错误；这些字段仍由 Main 决定。Settings 更新列表不再卸载正在使用的表单，轮换成功提示和选中服务商保持；Memory 切换归属时清除上一个道友的保存提示。

## 三个阻塞问题

1. Human Bridge 的模型 Availability 在共享组件与页面调用处双重排除；道友、Party、Mission、Chat 和待办只显示其非模型身份，不提供 UNKNOWN 或 Recheck。
2. `AvailabilityService.recheck` 在 probe 前拒绝 ARCHIVED；若手动 probe 期间归档，也不写新的结果。原模型 projection 保持，不把归档记为 HARD_FAILURE/UNAVAILABLE。UI 仅显示“已归档”。真实已经在飞行中的模型请求结果仍保留原有执行事实语义。
3. Settings 按具体 `currentRuntimeProfileId` 识别封存配置，包含已归档道友；Provider/Endpoint/Model/Credential identity 显示为只读详情，没有编辑/测试连接按钮。未绑定模板仍可编辑；API Key 轮换仍走独立 Credential 流程。Main/DB 的 sealed identity 防线保持。

## 架构与兼容性

没有移动业务 authority。Renderer 仍只使用 typed Preload IPC；没有 Node、SQLite、Provider SDK 直接访问。fixed model、Benchmark-only、Memory ownership、Skill assignment、Permission、Tool/MCP tool transcript、Collaboration depth、Experience provenance、Human Bridge continuation、Mission state machine、Jev SHADOW 保持。

新增依赖仅 `lucide-react@1.49.0`（ISC），固定版本并更新 lockfile；没有前端框架或无关依赖升级。资源出处见 `apps/desktop/src/renderer/src/assets/avatars/ATTRIBUTION.md`。没有历史 migration 修改。

## 完整验证与视觉证据

验收日期：2026-09-30。以下六项均退出 0：

| 命令                    | 结果                                                  |
| ----------------------- | ----------------------------------------------------- |
| `npm run test`          | 43 个文件、331 项测试全部通过                         |
| `npm run typecheck`     | 通过                                                  |
| `npm run lint`          | 通过                                                  |
| `npm run format:check`  | 通过                                                  |
| `npm run package`       | Windows x64、Electron 44.4.3；native dependencies 1/1 |
| `npm run smoke:package` | Gate 0–6、R0–R3.2 和 R3.3 统一 packaged 回归全部通过  |

产物：`out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe`。构建使用仓库 `.electron-dist` 中的 Electron ZIP，避免失败的下载路径。验收启动实际 exe，真实执行 typed IPC、native SQLite 查询和 UI 操作；没有改用浏览器开发页。

可提交证据：[截图索引](../evidence/r3-3-visual-product/README.md)。共 32 张原始 PNG：v1.1 的 16 张核心截图、6 张 Chat 截图，以及 Logo 16/24/32/48px、新模型测试/确认、Human Bridge Party、Credential rotation、900px Settings 内容和 Chat 抽屉补充截图。`evidence-manifest.json` 保留运行 ID、原始位置、窗口尺寸与断言；`ui-measurements.json` 保留布局指标。

窗口通过真实 `BrowserWindow.setSize` 设置为 1440×900、1180×780、900×600，Renderer viewport 与之对应。本机 Windows 125% DPI 下原始 PNG 分别为 1800×1125、1475×975、1125×750；没有为凑尺寸缩放或加工截图。逐张检查核心页面、Chat、窄窗口的层级、头像、对齐、按钮、滚动、长代码和错误提示；最终视觉审批仍由用户完成。900px Settings 可纵向滚动，补充图展示滚动后的实际模型表单；Chat 同时提供抽屉展开与关闭后的真实回复图。

| 验收项                      | 确定性 / packaged 证据                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Shell                       | 默认菜单为 null；唯一品牌；drag/no-drag 区；实际最小化、最大化、恢复、关闭                                    |
| 导航 / 窗口                 | 六项导航与折叠；三种实际窗口尺寸；可见字段有外部 Label、无 placeholder、无页面横向溢出                        |
| Avatar                      | 10 个用户预置图；原生导入、opaque ref、规范化；重启仍能读取并显示本地图                                       |
| 创建道友                    | 已有模型和内嵌新 Provider/Endpoint/Key/Model 两条完整流程；测试连接、确认、创建、封存                         |
| Credential / sealed Runtime | Main 导入与轮换，剪贴板清空；Renderer 无明文；轮换前后身份 tuple 相同；sealed 无编辑按钮                      |
| Chat                        | 可见 PING/PONG；左右头像；真实 IPC delta streaming；长代码容器滚动、Main 复制；历史持久化；900px 实际回复     |
| Availability                | typed unavailable 不改派、不新增被阻止消息、草稿保留；显式重检按既有两次成功策略恢复                          |
| Archived                    | Service tests 含 probe 期间归档；package 中重检拒绝、projection 不变、无新增模型调用                          |
| Human Bridge                | Party 显示可接收委托；详情/待办没有模型状态、UNKNOWN 或重新检测                                               |
| Memory / Skill              | UI A/B 两向列表隔离；Gate 2 scoped retrieval、candidate review、Skill enable/assignment 回归                  |
| Mission / Party             | UI 批准同 Run 并完成；SOLO、Consultation、Review、Delegation、deny 零调用/零 artifact 回归                    |
| Permission / Tool / MCP     | exact grant 不扩权；DENY 不执行；tool transcript、env whitelist、restart Approval、actor audit 回归           |
| Experience / Benchmark      | participant outcome 与 Run outcome 分离；重建幂等；Benchmark-only、unsupported、无评分 IPC/新 Evidence        |
| R2 / R3.1                   | ACCEPT continuation 同 Run、幂等；CONSUMING 已开始但无 FINAL 时中断且不自动重放                               |
| R3 / R3.2                   | SHADOW receipt/fallback 不改变 Mission；真实 SDK 本地 HTTP fixture、Availability actor 归属与明确不可用不改派 |

FakeModelGateway 的同步流会在一次 microtask burst 中完成。仅为 streaming 截图，packaged harness 在首个真实 `chat:event` delta 后设置 IPC 屏障，截图后按原顺序释放其余真实事件；不伪造 DOM、消息或 Usage，不修改生产行为。真实 AI SDK streaming 由 R3.2 的本地 HTTP fixture 继续验证。视觉 fixture 中的 86 分明确标记为验收数据，不是内置联网榜单分数。

所有 profile、缓存、截图、worktree 和临时目录均位于仓库 `.test-data` / `.tmp`；R: 只是 `.tmp` 的短路径映射，用于 Windows native packaging。未在 C 盘安装依赖或建立测试目录。验收使用 FakeModelGateway、MCP fixture 和本地 SDK HTTP fixture，不要求真实收费 API Key。

## 已知限制与未实现内容

头像导入上限为 2 MB/2048px；预置资源与用户本地导入是不同入口。完整 Audit、Benchmark provenance 与长期事件仍需展开高级区。验收覆盖三种常用窗口尺寸，不宣称覆盖所有多屏/DPI 组合。本轮交付 Windows x64 packaged app，不重新生成 installer。

未实现 R4、Workflow/W1、自动路由、Human Bridge 自动 fallback、Skill/Memory/Tool shortlist、Availability 后台轮询、动态能力/评分、Runtime switch、Scheduler、Browser/Computer Use、Shell 或其他新 Agent 能力。完成后等待 R3.3 审批。
