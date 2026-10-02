# Product UI System & Information Architecture Reset

基线：`bcf1acd90752560e6c90426c6771ec15c49566a5`（W2.0 已审批）。依据 [UI Product System Reset v1.0](../AI-Agent-Cultivation_UI_Product_System_Reset_Plan_v1.0.md)，并保留 AP-006/AP-007 与 Generative Model Execution v0.2 的架构边界。

## 范围与设计系统

本轮只调整 Renderer 结构、显示、导航、CSS 与表单/覆盖层状态。没有新增依赖或 migration；Main、Preload、Domain、Application、Persistence 和 0001–0019 不变。

- `styles/tokens.css` 是唯一 `:root` semantic token source。Typography：Page 24/32、Section 18/26、Body 14/22、Control 13/20、Caption 12/18；spacing 4/8/12/16/24/32。字体、色彩、圆角、surface、control、scrollbar 与 overlay 参数均集中定义。
- CSS cascade 固定为 `tokens → foundation → components → layouts → pages`，Shell 最先导入层顺序。`style.css` 仅负责入口；`product.css` 与原 `product-pages.css` 不再重复定义设计系统。
- 基础层统一 focus-visible、表格、表单文字与低对比 thin scrollbar；公共层统一 Button、Status、Avatar、Form、Empty State、Drawer/Dialog 和 Tooltip。
- 页面消费 semantic token。旧页面辅助样式合并为 `page-support.css`，移除无引用 legacy selector 与重复规则；页面 CSS 保留布局、消息和图像等必要差异。
- 图像尺寸、边界 1px、进度条、媒体断点、窗口/容器几何是明确例外，不是额外字体体系。普通文字没有 10/11px 标签。

## 信息架构与页面覆盖

| 页面                            | 迁移结果                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell / Home                    | 六项核心导航；首页保留任务、待处理与本尊待办；减去重复 eyebrow 和说明，section 用间距/divider 组织。                                                                                                  |
| 道友 / 创建                     | 紧凑名单与固定模型详情；900px 名单/详情切换。身份→模型→确认保留；Avatar、keyless compatible、固定身份与轮换路径继续工作。                                                                             |
| Chat                            | Header、Conversation List、Message Stream、Composer 使用同一字体/色彩；消息流与长输入承担必要滚动；窄窗口对话名单使用共用 native Drawer。                                                             |
| 队伍 / 历练                     | 统一列表/详情布局、对象头、成员与状态；Approval/Collaboration 仍由原 typed IPC 操作；Timeline 普通层显示可读事件及实际 actor，完整 payload 下沉。                                                     |
| Workflow                        | 普通层聚焦名称、状态、进度、步骤、动作和交付结果。新建运行通过 Drawer；重试/取消使用共用 Dialog。Run/Definition ID、Contract、Validator、Checkpoint、Receipt、Hash、effect enum、raw event 默认折叠。 |
| Memory                          | owner 选择、列表、详情及创建/编辑/审核 Drawer；来源标识下沉；所有操作继续携带当前 teammateId。                                                                                                        |
| Settings                        | 模型与连接、AI 能力、工具与集成、隐私与高级；900px 分类导航换为紧凑行，不占满首屏；内部不再嵌套第二个 main scroll。                                                                                   |
| Provider / Credential / Runtime | list-first；添加/编辑/轮换 Drawer。sealed Runtime identity 只读，专用密钥轮换继续经 Main clipboard + safeStorage。                                                                                    |
| Embedding / Benchmark           | 现有检索配置保留；Benchmark 录入通过 Drawer，来源/历史与参考入口折叠；只消费 Benchmark-only 能力语义。                                                                                                |
| Routing / Jev                   | 显示连接/凭据/启用状态与必要控制；策略与数据范围默认折叠。主动隐私同意及原 R4/Jev authority 保留。                                                                                                    |
| Tools / MCP / Skills / Usage    | list-first 管理；MCP/Skill 创建编辑 Drawer；指令、内部标识和详细用量归属下沉，保留现有工作区/权限/环境白名单操作。                                                                                    |
| Human Bridge                    | 待办状态与下一步突出；安全展示配置和应用管理按需打开；原交付、验收、拒绝和 continuation 调用不变，没有模型 availability。                                                                             |

独立滚动限制于 Main document、Chat stream/list、Drawer body、长输入、宽表格与 Advanced code/log。普通 section/card 不再建立额外滚动容器。空状态保留可工作的下一步；没有增加三个未来官方模板的入口。

## 兼容性与边界

Teammate identity、sealed ModelBinding、Benchmark-only、Availability（包括 archived/Human Bridge 规则）、R4 选择与 sequential probe、Memory scope、Permission、Tool transcript/MCP、Party/Collaboration、Human Bridge durable continuation、W1/W2 Artifact/Revision/Operation 状态均由既有 Main 服务负责。Renderer 不直接访问 Node/SQLite，也不写正式执行状态。

道友对象头/主体/动作区保持独立，现有 Chat 只是目前已实现的内容入口；没有将 MODEL_RUNTIME 的领域身份改成永久 LANGUAGE-only。未实现 GenerationGateway、GenerationJob、G1/G2/G3、MiniMax H3、W2.1–W2.4、用户 Workflow 编辑器或新 Agent 能力。

## 用户截图反馈收口

- 队伍描述不再与成员清单争用横向空间。列表列收窄、详情列展开，成员行使用详情宽度；packaged 回归要求成员行宽度至少为详情的 85%。
- Jev 的导入密钥、测试连接、启用 Cloud Shadow 分别对齐凭据、连接、Cloud Shadow 行，不再作为同级三按钮堆在段落后。去掉按钮下方的重复原理说明，隐私范围与主动同意仍保留。
- Routing、Provider、Runtime、Benchmark 与本尊页移除重复 helper copy；MCP 停用状态只显示一次。工作区主层仅显示目录名称，完整 canonical path 在高级详情中。
- 用量主层显示 Provider 名称，不直接显示其 UUID；统计采用四列/窄窗两列，宽表格保留必要水平滚动。
- 修复本尊待办重复 grid 与 Mission overview 横向布局造成的挤压；普通 Task/Result/Timeline 不再嵌套 card 滚动。
- 较矮窗口的创建 Drawer 允许 body 滚动；新增滚动到底部后的 Action 可见性断言与截图，验证继续/取消按钮可达。

## 验证与真实 Windows 证据

最终验证（2026-10-02）：

| 命令                    | 结果 | 证据                                                     |
| ----------------------- | ---- | -------------------------------------------------------- |
| `npm run test`          | PASS | 63 files / 547 tests，包含四项 UI System 架构回归。      |
| `npm run typecheck`     | PASS | TypeScript 全仓校验。                                    |
| `npm run lint`          | PASS | ESLint 全仓校验。                                        |
| `npm run format:check`  | PASS | 原始计划文档不做格式改写。                               |
| `npm run package`       | PASS | Windows x64 / Electron 44.4.3，native dependencies 1/1。 |
| `npm run smoke:package` | PASS | Gate 0–6、R0–R4、W1/W2、完整三档 UI。                    |

packaged 功能回归继续验证：SQLite/safeStorage、Streaming/代码复制、keyless compatible 创建与 sealed identity、Credential rotation、Memory A/B 隔离、Permission exact grant/DENY、MCP env whitelist、Party collaboration actor provenance、Experience outcome、Availability/归档 guard、本尊同 Run continuation/crash recovery、R4 constraints/sequential probe、W1 frozen I/O 与 W2 Contract/Revision/Operation zero-replay。

截图与人工检查归档于 [Windows UI Evidence](../evidence/ui-product-system-reset/README.md)，文件名按页面与 1440/1180/900 窗口宽度排列，清单保存实际尺寸、字号及允许滚动容器。共 87 张截图，包含 MCP Drawer 底部动作区，以及 Chat Streaming/长代码/错误/空状态。

新增 `product-system.test.ts` 四项架构回归，保护唯一 token 源、固定 cascade、字体/色彩/圆角来源与 scrollbar 基础层。`ui-product-system-packaged-smoke.mjs` 使用隔离 userData、正常中文名称与合理模型名称，覆盖全部页面和 1440/1180/900 三档实际 BrowserWindow；检查 overflow、普通层内部 enum/TEST_ONLY、字号、允许滚动容器、默认隐藏表单、Drawer Action/Tab/Escape/return focus、900 Settings 导航与 focus-visible。

视觉 fixture 仅由 smoke 写入其隔离 profile：普通 USER Workflow（需求整理），没有注册官方 Builtin，也没有增加生产模板。模型使用 FakeModelGateway；IPC、safeStorage/native SQLite、Workflow/Mission/ExternalWork 仍由真实 Windows package 执行。证据不包含 SQLite、Credential 或用户 profile，不宣称真实云模型联调。

所有任务专用 cache/profile/temp/evidence 位于当前项目。打包临时 R: 仅映射当前项目 `.tmp` 并在结束后解除。未进行目录批量删除。

## 已知限制与明确例外

宽用量表格、Chat 消息流、代码和长 Drawer 保留必要滚动；较矮窗口的长表单需要滚动到操作区。截图受本机 Windows 125% DPI 与约 2px 窄窗取整影响，不作为 pixel-perfect 测试。未验证真实云模型/Jev 网络质量；现有本地 HTTP SDK fixture 与 FakeModelGateway 提供确定性回归。

旧 functional smoke 只调整标题/按钮/列表 selector、打开 Advanced 或 Drawer/Escape 的交互路径；没有移除 Permission、provenance、restart、secret、fixed identity 或 routing assertions。生产 bootstrap 仍为零官方/测试模板，截图里的普通 USER Workflow 仅在隔离 smoke profile 中生成。
