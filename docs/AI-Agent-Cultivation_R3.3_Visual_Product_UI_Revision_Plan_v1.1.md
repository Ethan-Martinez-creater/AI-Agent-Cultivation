# AI Agent Cultivation — R3.3 Visual / Product UI Revision Plan v1.1

- 日期：2026-09-30
- 当前代码基线：`main@db71a32`
- 上位规划：`docs/AI-Agent-Cultivation_AP-006_Unified_Post-R3_Roadmap_with_Workflow.md`
- 定位：R3.3 信息架构完成后的产品级视觉与交互修订
- 参考：用户提供的当前产品截图与 `reference.png`
- 禁止范围：R4 自动路由、Workflow Engine、W1、R5、动态 Capability、Runtime switching、Mission 用户评分
- v1.1 补充：Chat / 对话页作为最高频核心界面纳入产品级视觉重构

---

## 1. 目标

当前 R3.3 已完成导航、页面拆分和功能下沉，但实际截图仍明显呈现“后台管理 Demo”特征。本轮不是简单增加圆角，而是补齐：

```text
Information Architecture
+ Visual System
+ Desktop Shell
+ Object Identity
+ Primary User Flow
```

完成后才允许进入 R4。

---

## 2. 视觉原则

参考图只作为方向，不机械复制。

目标：现代 Windows Desktop、轻量、清晰、有层级、有统一图标语言、有对象身份感。

统一视觉：浅色背景、白色内容面、轻边框、柔和阴影、中等圆角、蓝色主操作、绿色/黄色/红色状态、统一线性图标、人物头像。

禁止继续使用：大量裸文字+矩形框、重复软件名、首字母正式头像、页面功能块随意堆放、所有内容都套同一种 Card、开发术语占据默认主界面。

---

## 3. Desktop Shell

采用自定义顶部标题栏：

```text
┌──────────────────────────────────────────────┐
│ Logo  AI Agent Cultivation          — □ ×   │
├──────────────┬───────────────────────────────┤
│ Sidebar      │ Content                       │
└──────────────┴───────────────────────────────┘
```

要求：

- 移除默认 `File / Edit / View / Window` 菜单。
- Sidebar 不再重复显示产品名和 `Windows V1 Alpha`。
- 品牌只保留在 Title Bar。
- Title Bar 支持拖动、最小化、最大化/恢复、关闭。
- 应用内部统一圆角语言；窗口外框最终表现遵循 Windows/Electron 能力。

---

## 4. Logo 与 Icon System

### 4.1 Logo

使用独立 Logo Mark，不能是单个字母 A、Emoji、Unicode 或临时手绘 path。建议表达 Agent / Connection / Growth / Cultivation，主色蓝色，至少验证 16/24/32/48px。

### 4.2 功能图标

建议引入 `lucide-react`，建立统一 Icon 组件与尺寸规范。禁止每页自行手写不同 SVG。

覆盖：首页、道友、队伍、历练、记忆、设置、Chat、Mission、Skill、Capability、History、Human Bridge、Provider、Credential、Model、Benchmark、Embedding、Jev、Tool、MCP、Usage、Approval、Artifact、Review、Refresh、Add、Edit、Archive、More、Upload、Folder、Copy。

---

## 5. Design Tokens

统一维护：

```text
color-bg / surface / surface-subtle
border / border-strong
text / text-secondary / text-muted
primary / primary-hover / primary-soft
success / warning / danger
radius-sm=8 / radius-md=12 / radius-lg=16
shadow-sm / shadow-md
8px spacing system
```

页面不得自行定义大量近似值。

字体建议：Page Title 22–24、Section Title 16–18、Body 14、Caption 12。默认主标题优先中文，减少 `洞府 Home / 设置 Settings` 这类重复双语标题。

---

## 6. Avatar System

道友头像升级为正式产品资产。

### 6.1 预置头像

至少提供 8–12 个统一画风人物头像：正方形、适合圆形裁切、人物之间明显可区分。首字母仅作为 legacy/resource failure fallback，新建道友不得以首字母作为默认主体验。

Human Bridge 使用独立专用头像。

### 6.2 本地上传

创建/编辑道友允许从电脑选择 PNG/JPEG/WebP。

安全路径：

```text
Renderer
→ typed IPC
→ Main file dialog
→ 校验类型/大小/magic bytes
→ copy 到 userData/avatars
→ 返回 opaque avatarRef
```

禁止 Renderer 直接读取任意文件、长期保存绝对路径、允许 SVG/HTML。

优先复用现有 `avatar: string | null`：

```text
preset:<id>
local:<asset-id>.<ext>
```

尽量不新增 migration。

新增统一 `<Avatar />`，负责 preset/local/Human Bridge/legacy fallback/status dot，并在道友、Party、Chat、Mission actor 等所有位置复用。

---

## 7. Sidebar

继续六项：

```text
首页 / 道友 / 队伍 / 历练 / 记忆 / 设置
```

统一 Icon + Label；Active 浅蓝底；Hover 克制；折叠态只显示图标并提供 Tooltip。底部数据库状态、版本、折叠按钮降为次要视觉。

---

## 8. 首页

废弃“配置 Provider”和“创建道友”并列为两个主 CTA 的结构。

### 无道友

只保留一个主要动作：

```text
[ + 创建第一位道友 ]
```

说明：创建道友时会同时完成模型连接配置。`高级设置`作为次级链接。

### 正常首页

结构：

```text
顶部：[ + 发起历练 ]
进行中 / 等待用户操作
最近历练
本尊待办
```

不再使用大面积灰色 onboarding Card。

---

## 9. 创建道友流程

普通用户不应先理解 `Provider → Credential → Runtime → Teammate`。

统一流程：

```text
新建道友
→ 身份
→ 模型
→ 确认
```

### Step 1 身份

- 头像：预置头像 / 本地上传
- 名称
- 称号（可选）
- 简介（可选）
- Identity Prompt / Behavior Prompt 下沉到“高级设定”

### Step 2 模型

两条路径：

```text
A. 使用已有模型配置
B. 添加新的模型
```

已有模型以用户语言显示 Provider、Model、Availability，不暴露 Runtime ID。

新增模型在当前流程内填写：Provider 类型、Endpoint（需要时）、API Key、Model ID，并执行 `[测试连接]`。测试成功后才可创建。

底层仍复用现有 Provider/Credential/Runtime/Sealed Teammate 服务，不建立新模型体系。

### 完成

明确告知：Provider/Endpoint/Model 对该道友创建后固定；API Key 可轮换；换模型需创建新道友。

Settings 仍保留高级统一管理能力，但不是首次创建必经路径。

---

## 10. 道友页

宽屏采用参考图类似的“名单 + 详情”工作台：

```text
左：道友名单
右：选中道友详情
```

名单每行：Avatar、Name、Model、Availability dot；不要使用大 Card。

Human Bridge 显示专用头像、`本尊 / Human Bridge / 可接收委托`，不显示模型 Availability。

详情 Header：大头像、名称、Availability、Model；右侧 `开始对话 / 发起历练 / 更多`。

能力：Benchmark 以能力条展示，只默认显示主要已配置能力；来源和底层 ID 下沉 Advanced。

Skills：默认显示已启用 skill chips，完整管理按需展开。

最近记录：Mission、Chat、Experience、等待状态组成简洁列表/时间线。

---

## 11. Chat / 对话页

Chat 是用户最高频的核心界面之一，必须作为独立重点页面设计，而不是普通功能页。

目标结构：

```text
Conversation List
+
Chat Header
+
Message Stream
+
Composer
```

宽屏：

```text
┌───────────────┬──────────────────────────────────┐
│ Conversations │ 道友头像 名称 Model Availability │
│               ├──────────────────────────────────┤
│ 最近会话       │ Avatar + Assistant Message       │
│               │                     User + Avatar │
│               │ Avatar + Assistant Message       │
│               │                                  │
│               ├──────────────────────────────────┤
│               │ Composer                         │
└───────────────┴──────────────────────────────────┘
```

### 11.1 Chat Header

显示：道友头像、名称、固定 Model、Availability。

操作保持克制：查看道友、重新检测（仅 ACTIVE MODEL_RUNTIME）、现有会话操作。

Human Bridge 不进入普通 Model Availability 逻辑。

### 11.2 Message Row

每条普通消息都使用“头像 + 消息内容”的对象化结构。

Assistant：

```text
左侧
Avatar
Name
Message Bubble / Content Surface
```

User：

```text
右侧
Message Bubble / Content Surface
User Avatar
```

所有头像统一复用全局 `<Avatar />`。如当前没有用户自定义头像能力，使用统一的 User Avatar asset，不使用首字母。

禁止继续使用只有纯文本、缺少说话者身份、所有消息视觉完全相同的表现。

### 11.3 Message Visual Language

Assistant 与 User 明确区分但保持克制：

```text
Assistant：白色 / 极浅灰、轻边框、左对齐
User：浅蓝内容面、右对齐
```

圆角建议 12–16px。

长文本优先阅读性，不应形成巨大高饱和气泡。

代码/结构化内容使用独立内容面、等宽字体、Copy 操作；横向滚动限制在代码容器。不得为视觉效果引入不安全 HTML 渲染。

### 11.4 Metadata

每条消息默认只展示必要信息：道友名称 / 用户。时间采用次要样式或 message footer。Model ID 不要在每条消息重复出现，只在 Chat Header 展示。

### 11.5 Streaming

Streaming 状态必须明确：

```text
Avatar
道友名称
正在生成…
```

开始产生 token 后自然变为消息。

禁止全页面 Loading 或弹窗式生成状态。Composer 始终可见，发送按钮显示生成状态。

### 11.6 System / Tool / Memory Events

普通 User / Assistant Message 与系统事件必须视觉区分。

现有 Chat 中的 Availability 错误、Memory action/proposal 等使用：

```text
Icon + 简短说明
```

组成小型 inline event row / notice，不伪装成 Assistant Message。原始高级信息继续下沉。

### 11.7 Conversation List

左侧使用轻量列表，不使用大量 Card。

每项显示：

```text
简短可识别内容
最近时间
选中态
```

顶部：

```text
+ 新建对话
```

如果当前后端不支持重命名、删除、搜索，本轮不得伪造这些能力。

### 11.8 Composer

Composer 固定在 Chat 主区域底部，不再表现为普通表单 textarea。

要求：

```text
多行输入
大圆角输入容器
轻边框
清晰 Focus
发送按钮
必要状态提示
```

继续保持：

```text
Enter 发送
Shift+Enter 换行
```

发送失败就地显示，不清空未发送内容。

Availability 阻断继续提供：

```text
重新检测
选择其他道友
取消
```

禁止静默改派。

### 11.9 Empty State

没有 Conversation：

```text
大头像
道友名称
简短提示
[ 开始新对话 ]
```

不要留下大片空白。

已有 Conversation 但没有消息：使用头像 + 一句轻量引导。

### 11.10 Responsive

1440 / 1180：

```text
Conversation List + Chat Pane
```

900 宽度：

```text
Conversation List 可收起 / Drawer
Chat 为主
```

必须保证 Composer 始终可操作、消息区域独立滚动、Header 稳定、代码块不撑破页面。

### 11.11 Chat Visual Acceptance

新增真实 packaged 截图：

```text
chat-empty-1440.png
chat-conversation-1440.png
chat-streaming-1440.png
chat-long-content-1440.png
chat-unavailable-1440.png
chat-conversation-900.png
```

人工检查：头像与说话者关系、消息层级、长文本阅读性、Composer 质感、Conversation List 密度、Availability 错误表现。

## 12. 队伍页

左：队伍列表；右：队伍详情。

队伍列表：队伍名、Coordinator、成员头像 stack、状态。

详情：类型、Coordinator、成员、成员状态、发起队伍历练。

创建/编辑使用 Drawer/Panel，不在主页面临时塞入大表单。

Human Bridge 成员不得显示 Model Availability / UNKNOWN / Recheck。

---

## 13. 历练页

继续作为统一任务中心，但 R3.3 仅展示当前真实可用的自由历练，不提前显示 Workflow 死入口。

左：历练列表/筛选；右：当前历练详情。

默认详情只显示：状态、目标、执行者、结果、当前需要用户操作、Timeline 摘要。

Run、Usage、Audit、raw metadata 下沉 Advanced。

发起历练第一层只显示：目标、指定道友/指定队伍；选择队伍后再显示咨询/审查/委托。R4 后再加入自动分配，W1 后再加入工作流入口。

---

## 14. 记忆页

减少后台表单感：顶部选择当前道友；主体显示 Memory List；新增/编辑放到 Drawer/Side Panel。

每条 Memory：Type icon、Summary、短内容、状态、日期。PROPOSED 保留接受/编辑后接受/拒绝。完整元数据放 Advanced。

---

## 15. 设置页

设置重新定位为高级管理，不再在顶部排列一串裸文本链接。

建议分组：

```text
模型与连接：Provider / Credential / Model Profiles / Embedding
AI 能力：Benchmark / Jev Shadow
工具与集成：Tools / MCP / Skills
隐私与高级：Usage / Audit / Diagnostics / Human Bridge 配置
```

采用 Settings 左侧子导航 + 右侧详情。

---

## 16. Sealed Runtime UI

如果 Runtime 已被普通道友封存使用：Provider / Endpoint / Model ID / Credential identity 在 UI 中必须只读，不再呈现成可修改表单。Credential/API Key 轮换走 Credential 专用流程。

未绑定 Runtime Template 可继续编辑，用于创建新道友。

---

## 17. Human Bridge 与 Availability 修复

### Human Bridge

所有页面保持：Human Bridge 是非模型道友，没有 ModelAvailability。Party、Teammate、Mission 等位置均不得出现 UNKNOWN、Availability dot 或 Recheck。

### Archived Teammate

归档是 Teammate lifecycle，不是 ModelAvailability failure。

归档后：

```text
不提供 recheck
不 probe
不写 HARD_FAILURE
不把 projection 改成 UNAVAILABLE
```

原 Availability projection 保留为历史模型事实；UI 只显示“已归档”。

---

## 18. Card / Button / Empty State

Card 只用于真正的独立信息组或交互区。普通列表优先 divider + whitespace，不再“所有东西都套 card”。

按钮只保留 Primary / Secondary / Ghost / Danger / Icon Button；每个区域尽量只有一个主操作。

Empty State 必须简短回答：这里是什么、为什么为空、下一步做什么。禁止两个或三个技术 CTA 并排。

---

## 19. Responsive

重点验收：1440×900、1180×780、900×600。

宽屏：Sidebar + List + Detail；窄屏允许 Sidebar collapsed 和 List→Detail/上下布局。

要求：无页面级横向滚动；长 ID/Model ID 不撑破；主操作始终可达。

---

## 20. Renderer 结构建议

新增统一组件：

```text
components/
  Avatar.tsx
  Icon.tsx
  Button.tsx
  EmptyState.tsx
  StatusBadge.tsx
  Section.tsx
  SplitView.tsx

layout/
  AppTitleBar.tsx
  Sidebar.tsx
  SettingsLayout.tsx
```

`main.tsx` 继续只负责 Shell + Routing；pages 负责组合。禁止再次回到巨型单文件和每页一套 CSS 语言。

允许新增 `lucide-react`，不引入大型 UI Framework、在线 Icon CDN、远程字体或复杂状态库。

---

## 21. 不可改变的系统边界

本轮不得改变：固定模型身份、Benchmark-only Capability、Availability 语义、Memory owner isolation、Skill enable/assignment、Permission、Tool/MCP boundary、Human Bridge continuation、Jev SHADOW、Mission/Party state machine、typed Preload IPC、Renderer 无 Node/SQLite。

---

## 22. Packaged Visual Acceptance

不能再仅凭 DOM/overflow 数值认定 UI 完成。

至少输出截图：

```text
01-home-empty-1440.png
02-home-active-1440.png
03-teammates-list-1440.png
04-teammate-detail-1440.png
05-create-teammate-identity-1440.png
06-create-teammate-model-1440.png
07-party-detail-1440.png
08-mission-detail-1440.png
09-memory-1440.png
10-settings-models-1440.png
11-human-bridge-1440.png
12-teammate-detail-1180.png
13-mission-detail-1180.png
14-home-900.png
15-teammates-900.png
16-settings-900.png
```

人工审批关注：层级、对齐、留白、按钮优先级、图标一致性、头像、Card 密度、空状态、长内容、窗口结构。

---

## 23. Functional Acceptance

继续要求：

```text
npm run test
npm run typecheck
npm run lint
npm run format:check
npm run package
npm run smoke:package
```

新增重点回归：

```text
自定义 title bar 控件
六项导航和折叠
预置头像
本地头像导入/持久化/重启恢复
创建道友+内嵌模型配置
已有模型创建道友
固定模型 UI 不可修改
Credential rotation
Human Bridge Party 状态
Archived teammate 无 recheck 且不污染 projection
三种窗口尺寸
```

---

## 24. 建议实施顺序

```text
V1 Design System / Shell
→ V2 Icon + Avatar System
→ V3 Teammate Page + Create Teammate Flow
→ V4 Home
→ V5 Party / Mission
→ V6 Memory / Settings / Human Bridge
→ V7 Availability / Sealed Runtime correctness fixes
→ V8 Packaged Visual Acceptance
```

---

## 25. 审批标准

本轮通过必须同时满足：

```text
实际截图不再像后台管理 Demo
品牌层级只有一套
图标统一
道友有正式头像体系
首页主路径只有清晰主 CTA
创建道友过程中可完成模型配置
Settings 回归高级管理定位
Human Bridge 无 ModelAvailability
Archived != UNAVAILABLE
Sealed Runtime UI 不可修改模型身份
Windows packaged smoke 与视觉截图通过
```

只有本轮审批通过后再进入：

```text
R4 Controlled Intelligent Routing
→ W1 Workflow Foundation
```
