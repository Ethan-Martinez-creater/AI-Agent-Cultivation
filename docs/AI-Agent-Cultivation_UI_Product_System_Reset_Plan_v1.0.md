# AI-Agent-Cultivation — Product UI System & Information Architecture Reset Plan v1.0

- 日期：2026-10-02
- 阶段定位：插入 W2.0 与 W2.1 之间的独立产品界面收口阶段
- 基线：W2.0 审批通过后的 `main`
- 范围：Desktop Renderer / Product UI / CSS / interaction presentation
- 不修改：Domain、Application 正式状态机、Persistence 语义、Migration、R4 Routing、W1/W2 Workflow authority、Permission、Tool/MCP、Memory isolation、Human Bridge、安全边界
- 目标：从“已组件化但视觉与信息架构不统一的 Alpha”升级为具有统一设计语言、清晰层级、合理密度和成熟桌面软件体验的产品界面

---

# 1. 背景

R3.3 已解决早期的 Demo 风格问题，但随着 R4、W1、W2.0 持续增加页面和状态，当前 UI 再次出现系统性漂移。

目前问题并非“缺少圆角、图标或卡片”，而是：

```text
组件有设计
但整体系统缺少统一设计规则
```

本阶段禁止继续采用“看到一个页面不顺眼就单独调 CSS”的方式。必须先建立统一 Product UI System，再批量迁移所有页面。

---

# 2. 当前主要问题

## 2.1 Typography 失控

当前 `style.css`、`product.css` 与各页面 CSS 同时定义 typography / color / spacing / radius，并存在大量页面级硬编码字号。

同一界面常同时出现 10、11、12、13、14、15、16、18、20、22、24、26px。结果是中英文视觉高度不一致、文字权重混乱、层级不明确，且大量极小字号造成后台工具感。

## 2.2 Helper Copy 过量

大量界面采用“标题 → 灰色解释 → 字段 → 灰色解释 → 状态 → 灰色解释”的方式。提示信息承担了本应由布局、label、状态组件、tooltip、progressive disclosure、validation 承担的职责。

## 2.3 Card 化过度

大量区域统一使用白色矩形 + border + radius，甚至 Card 中再套 Card。视觉层级主要依赖边框，而不是信息结构。

## 2.4 空间利用失衡

多个页面左上角少量内容 + 大面积空白；复杂页面又因固定 Card / list pane 产生拥挤和嵌套滚动。

## 2.5 Settings IA 不成熟

当前 Settings 存在“主导航 → Settings 二级导航 → 页面标题 → Card → 大段说明”。AI 能力中的“智能分配 / Jev 观察”主要表现为工程说明文字，而不是成熟设置界面。

## 2.6 创建/编辑表单暴露方式不合理

Provider / Credential / Runtime / Skill 等管理页面不应永久处于“创建对象”状态。创建和编辑应由显式 Action 打开 Drawer / Dialog / Wizard。

## 2.7 Scroll 体系割裂

Main、list、workflow history、drawer、chat 等多个独立滚动区仍大量使用浏览器/Electron 默认 scrollbar。需要先减少 nested scrolling，再统一视觉。

## 2.8 工程信息进入普通产品层

TEST_ONLY、Run ID、operation receipt、effect type、contract id、internal enum 等审计事实应下沉到 Advanced / Diagnostics / Audit，而不是占据普通用户主层。

## 2.9 页面布局规则不统一

不同页面自行决定 page width、heading margin、action placement、card density、list/detail ratio、empty state、badge、button size、section spacing。

## 2.10 CSS 来源过多

基础 CSS 与 page CSS 同时重定义相同语义，Design Token 未成为 single source of truth。

---

# 3. 本阶段设计原则

1. Content first：优先表达对象、状态、用户当前能做什么。
2. Progressive disclosure：复杂细节进入详情 / 高级 / 诊断。
3. Fewer surfaces：禁止“所有内容都放 Card”。
4. List first, form on demand：管理页面默认列表/状态/操作，创建编辑按 Action 打开。
5. One visual grammar：所有页面共享 typography、spacing、surface、radius、icon、button、form、status、scrollbar、empty state、overlay、page shell。

---

# 4. Design Token Reset

建立唯一 Product Token source，至少统一：Typography、Color、Spacing、Radius、Border、Shadow、Control height、Page width、Z-index、Motion、Scrollbar。

页面 CSS 只能引用 semantic token。除明确特殊组件外，不允许 arbitrary font/color/radius value。

---

# 5. Typography System

只保留主要语义层级：

```text
Page Title      24 / 32
Section Title   18 / 26
Body            14 / 22
Control/Label   13 / 20
Caption         12 / 18
Code            monospace
```

要求：

- 普通产品 UI 禁止 10px；
- 11px 仅允许极少 compact metadata，并优先消除；
- 同一 semantic role 不得因页面不同改变字号；
- font weight 使用有限档位；
- 中英文使用同一语义尺寸/line-height；
- monospace 仅用于 code / ID / hash 等 Advanced 信息；
- 删除无意义 uppercase eyebrow；
- 中文界面优先中文产品文案。

---

# 6. Spacing / Density

建立稳定 spacing scale：

```text
4 / 8 / 12 / 16 / 24 / 32
```

采用中等偏紧凑的桌面密度。相关元素靠近，section 之间明显分组；不通过大面积空白掩盖布局问题，也不为了“填满页面”强行拉伸文本。

---

# 7. Page Shell

统一三类页面：

## Standard Page

```text
Page header
├─ title
├─ optional concise subtitle
└─ primary action
```

## List + Detail

用于道友、队伍、历练、Workflow history。

大屏：`List Pane | Detail Pane`

窄屏：`List → Detail`

## Settings

`Category navigation → setting group → concise status/control`

禁止大段工程说明作为主要内容。

---

# 8. Settings Reset

重点重构 Provider、Credential、Runtime、Embedding、Benchmark、Routing、Jev、Tool/MCP、Skills、Usage、Human Bridge。

要求：

- Settings 主层体现当前状态，而不是堆解释文字；
- Provider / Credential / Runtime 默认显示已有对象；
- 创建/轮换按 Action 打开 Drawer/Dialog；
- Routing 展示当前 mode/status + 关键 toggle；
- Jev 展示 connection/status/必要设置，原理说明进入帮助或 Advanced；
- destructive action 保留明确说明和 confirmation；
- 900px 不允许 Settings navigation 变成占据大半首屏的巨大卡片。

---

# 9. Skills Reset

当前常驻创建 Form 改为“功法列表 + 新建功法”。点击“新建功法”后打开 Drawer / Dialog。编辑同样使用 Drawer。主页面优先展示名称、状态、tags、version、assigned usage（若已有）；指令正文仅在 Detail / Advanced 展开。

---

# 10. Workflow UI Reset

Primary：Workflow name、状态、当前步骤、进度、等待原因、用户需要执行的 Action、主要结果。

Secondary：步骤历史、Artifact、Mission link、Revision status。

Advanced：Run ID、Contract、Validator、Checkpoint、Decision receipt、Operation receipt、Effect type、Hash、Raw event。

生产 UI 不显示 TEST_ONLY fixture。

---

# 11. Mission / Party / Teammate / Memory

统一 object header、status、primary action、section hierarchy、empty state、list row density。删除“只显示已配置能力”等解释 UI 本身的重复文案。

---

# 12. Form Pattern

统一 Field：`Label → Control → Error（仅需要时） → Help（仅复杂字段需要时）`。

禁止每个字段默认带 Hint。长 Form 使用 section 或 wizard，不堆成无限长页面。

---

# 13. Overlay Pattern

统一 Dialog / Drawer / Confirmation / Popover / Tooltip。

- 创建复杂对象 → Drawer
- 简短确认 → Dialog
- 补充说明 → Tooltip
- Context action → Popover/menu

---

# 14. Scroll Strategy

首先减少 scrollbar，而不是只换皮。

允许独立滚动的主要区域：Main document、Chat message stream、确有必要的 List pane、Drawer body、large code/log Advanced content。

尽量避免 page scroll + card scroll + inner list scroll 同时存在。

所有可见 scrollbar 使用统一 Product Scrollbar：细、透明/低对比 track、低对比 thumb、hover 增强，禁止粗黑/深灰长条。

---

# 15. Empty State

区分真正 empty state、内容较少、列表无结果、尚未配置、等待用户 Action。

Empty state 只需要明确对象、一句说明、最多一个主 Action，不使用教程式长文。

---

# 16. Status / Icon System

统一 Success / Warning / Danger / Neutral / Info status grammar。

继续使用 `lucide-react`，统一尺寸和 stroke。同一概念全局只使用同一 icon。

---

# 17. Copy / Terminology

删除 UI 自我解释、重复标题、工程内部描述、无必要英文 eyebrow、无价值“此处用于……”文案。

普通界面优先用户可理解的中文。Jev / Skill / Provider / Workflow 等必要产品词可保留，但同一概念不得混用多套称呼。

---

# 18. Advanced / Diagnostics

工程信息统一进入“高级记录” disclosure，默认折叠：IDs、hashes、contracts、receipts、internal enum、raw event、provider technical data。

---

# 19. Responsive / Window Width

验收至少：1440、1180、900。

- 1440：充分利用空间但不拉伸文本；
- 1180：主要布局完整；
- 900：secondary panes 合理 collapse，Settings 不形成巨大导航块，不出现横向页面 scrollbar。

---

# 20. CSS Architecture

完成后 CSS 明确分层：

```text
tokens
foundation
components
layouts
page-specific exceptions
```

要求：

- 删除 style.css / product.css 中冲突 token；
- 只保留一个 root semantic token source；
- 共性组件不得继续复制到 page CSS；
- 页面 CSS 不再大量 hardcode font/color/radius；
- 清理无引用 legacy styles；
- 不引入大型 UI framework；
- 不进行 Tailwind 全量迁移；
- 不新增重量级视觉依赖。

---

# 21. 页面覆盖范围

必须人工审查全部：Home、Teammates、Create Teammate、Chat、Parties、Missions、Workflows、Memory、Settings、Providers、Credentials、Runtime、Embedding、Benchmark、Routing、Jev、Tools/MCP、Skills、Usage、Human Bridge。

不是只修改当前截图暴露问题的页面。

---

# 22. 功能边界

本阶段仅允许 Renderer structure、CSS、display composition、navigation presentation、Drawer/Dialog state、UI copy、read-only derived presentation。

不得改变 Domain state machine、Workflow semantics、Routing decision、Mission authority、Artifact validation、Availability truth、Permission truth、Persistence truth、IPC authority。

若 UI 需要新的只读 projection，可增加最小 typed read IPC；Renderer 不得自己推导正式状态。

---

# 23. Future Generation Compatibility

本阶段必须阅读：

```text
docs/AI-Agent-Cultivation_Generative_Model_Execution_Software_Spec_v0.2.md
```

但只作为未来架构约束。

本阶段不实现 G1 / G2 / G3 / GenerationGateway / GenerationJob / MiniMax H3 software integration。

UI 不得写死“所有 MODEL_RUNTIME 都一定是 LANGUAGE Chat Model”。Teammate layout 应允许未来 GENERATION teammate 使用不同 primary action/content area，而无需推翻页面架构。

---

# 24. W2 Compatibility

UI Reset 不实现 W2.1–W2.4。

Workflow UI 必须为未来 AI 资讯视频、软件功能开发、科研保留产品化表达空间，但当前 production 不显示尚未实现的官方模板。

---

# 25. Visual Acceptance

必须从真实 Windows packaged app 截图。

至少覆盖：Home、Teammate list/detail、Chat、Party、Mission、Workflow、Memory、Settings、Provider list、Provider create Drawer、Routing、Jev、Skills list、Skill create Drawer、Human Bridge。

尺寸：1440、1180、900。

关键视觉截图使用接近真实产品的 fixture：正常中文名称、合理模型名称、不出现 TEST_ONLY、不把 UUID/hash 放在主层。

---

# 26. Automated UI Regression

保留现有 functional smoke，并增加 deterministic assertions：

- 页面无横向 overflow；
- production 不出现 TEST_ONLY；
- primary UI 不暴露列出的内部 enum；
- Provider/Skill create form 默认不可见；
- 点击 Action 后 Drawer 出现；
- 900px Settings navigation 不占满首屏；
- scrollbar 只出现在允许的 scroll container；
- Dialog/Drawer 可键盘关闭/导航；
- focus-visible 保持。

不要用脆弱 pixel-perfect screenshot test 取代人工视觉验收。

---

# 27. 发布门槛

必须满足：Typography single source of truth、Semantic spacing/token、No major arbitrary font-size drift、No raw/default prominent scrollbar、No permanent create form on management pages、Reduced helper-copy noise、No excessive nested cards、No TEST_ONLY/internal IDs in primary production UI、Settings productized、Workflow technical facts moved to Advanced、900/1180/1440 usable、No domain/security regression。

并运行完整六项：

```text
npm run test
npm run typecheck
npm run lint
npm run format:check
npm run package
npm run smoke:package
```

---

# 28. 状态文档

新增：

```text
docs/status/ui-product-system-reset.md
```

记录 token architecture、typography scale、layout/scroll/form/overlay rules、Settings IA、page migration coverage、screenshots/evidence、intentional exceptions。

---

# 29. 阶段结束后的路线

```text
W2.0
↓
UI Product System Reset
↓
W2.1 AI 资讯视频
↓
W2.2 软件功能开发
↓
W2.3 科研
↓
W2.4 Cross-Workflow Acceptance
↓
Generation Foundation G1/G2/G3
```

本阶段结束后，不再允许后续 W2 页面自行创建新的视觉体系。
