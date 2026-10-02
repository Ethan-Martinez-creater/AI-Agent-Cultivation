# Windows packaged UI 人工验收

最新小范围修复与指定截图见 [Corrective Evidence](corrective-2026-10-02/README.md)。本页保留主体实施阶段的历史记录。

日期：2026-10-02。基线：`bcf1acd`。全部截图来自本轮最终 Windows x64 package（Electron 44.4.3），不是浏览器 mockup。

## 证据范围

- 83 张全页面矩阵：隔离 profile `ui-product-system-201daf5f-a60a-4fd4-815c-954fd76d7371`，正常中文名称、合理模型 ID、普通 USER Workflow。
- 4 张 Chat 功能补充：Streaming、长代码、不可用错误、空状态，来自同一 package 的 R3.3 全量功能 smoke。
- [清单与测量](evidence-manifest.json) 保存窗口宽度、实际 document width、字号与滚动容器。PNG 受本机 Windows 125% DPI 影响，物理像素不等于 CSS 窗口宽度；窄窗存在约 2px 的系统取整。
- 没有复制 SQLite、Credential、用户 profile 或完整测试数据。模型主流程使用 FakeModelGateway；这组图片不代表真实云 Provider 或 Jev 联调。

## 人工复核记录

逐张复核 1440 / 1180 / 900 矩阵；1180 与 900 由独立只读复核协助，主线程复核 1440、补充 Chat 及修复后的新增画面。

| 页面              | 1440 | 1180 | 900  | 检查结果                                                                    |
| ----------------- | ---- | ---- | ---- | --------------------------------------------------------------------------- |
| Home              | 通过 | 通过 | 通过 | 状态与任务优先，无大而全 Dashboard；额外保留新安装空状态。                  |
| 道友 list/detail  | 通过 | 通过 | 通过 | 固定模型、头像、Availability 清晰；900 名单/详情切换。                      |
| 创建道友          | 通过 | 通过 | 通过 | 预置头像无外层套卡；较矮窗口滚动后取消/继续完整可见。                       |
| Chat              | 通过 | 通过 | 通过 | 用户/道友头像与消息分离；900 对话名单 Drawer；Streaming、长代码与错误可读。 |
| Party             | 通过 | 通过 | 通过 | 描述独占段落，不挤压成员；成员行使用详情宽度。                              |
| Mission           | 通过 | 通过 | 通过 | Executor、Objective、结果、Timeline 分层；Run/Audit/Receipt 默认折叠。      |
| Workflow          | 通过 | 通过 | 通过 | 名称/进度/结果优先；内部 ID、Hash、Receipt、Contract 在高级记录。           |
| Memory            | 通过 | 通过 | 通过 | 列表优先，创建/编辑按需打开；内容不贴边，无双层卡框。                       |
| Settings          | 通过 | 通过 | 通过 | 分类清晰；900 分类导航不占据大半首屏。                                      |
| Provider / create | 通过 | 通过 | 通过 | 名称与类型分行；默认不展示创建表单，原生 Drawer 操作。                      |
| Credential        | 通过 | 通过 | 通过 | 列表与专用轮换入口；不展示明文/ciphertext。                                 |
| Runtime           | 通过 | 通过 | 通过 | 已封存身份只读，模板可编辑；Availability 与重新检测保留。                   |
| Embedding         | 通过 | 通过 | 通过 | 状态/选择/保存操作；会调用付费 Provider 的重建保留必要说明。                |
| Benchmark         | 通过 | 通过 | 通过 | 页面纵向组织；能力清单宽窗两列，窄内容区单列；没有动态评分。                |
| Routing           | 通过 | 通过 | 通过 | Toggle 与状态优先，数据范围/策略按需展开。                                  |
| Jev               | 通过 | 通过 | 通过 | 凭据/连接/Cloud 三行分别对应单一操作；重复按钮下说明已删除。                |
| Tools / MCP       | 通过 | 通过 | 通过 | 工作区名称不挤按钮；内置工具中文名称；MCP 停用信息只显示一次。              |
| Skills / create   | 通过 | 通过 | 通过 | 默认列表，创建/编辑 Drawer；指令正文按需查看。                              |
| Usage             | 通过 | 通过 | 通过 | Provider 名称替代主层 UUID；四列/两列统计，窄窗表格可水平滚动。             |
| Human Bridge      | 通过 | 通过 | 通过 | 队列与详情宽度恢复；无 UNKNOWN/ModelAvailability/Recheck。                  |

## 允许的例外

- 较矮窗口的长 Drawer 表单需要滚动。`create-teammate-actions-*` 保存滚动到底部的操作区；smoke 同时检查其 bounding box 在 viewport 内。
- Chat 消息流、长 textarea、Drawer body、Advanced code 和宽用量表格保留独立滚动；普通卡片/结果/Timeline 不再嵌套滚动。
- Artifact/合同/回执等高级事实仍保留原始名称，普通层使用可读状态。用户自己提供的 description/task/content 继续展示，不作为多余 helper copy 删除。
- 必要的隐私同意、验证错误、头像格式/大小限制和外部工作交付要求继续保留。

本轮没有新增依赖、migration、官方 Workflow 模板或任何 G1/G2/G3 功能。

MCP 创建面板补充三档滚动到底部画面，添加/取消操作区完整可见；共归档 87 张 PNG。
