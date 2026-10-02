# UI corrective packaged evidence

基线：`b493acc0fd1e69d42ae649a83a2f4e57821664cf`。日期：2026-10-02。

本目录是最终 corrective repair 的当前视觉证据；父目录保留主体实施阶段的历史记录。

## 指定画面人工复核

| 页面          | 证据                                         | 结果                                                       |
| ------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Routing 1440  | [截图](screenshots/routing-1440.png)         | Cloud 智能分配使用统一 Switch，无裸 setting checkbox。     |
| Routing 900   | [截图](screenshots/routing-900.png)          | Switch 与 Jev 凭据按钮可见、未挤压。                       |
| 道友详情 1440 | [截图](screenshots/teammate-detail-1440.png) | 最近对话使用中文内容，无 FAKE/TEST_ONLY/fixture 前缀。     |
| Mission 1440  | [截图](screenshots/mission-1440.png)         | 结果使用中文需求与验收要点。                               |
| Workflow 1440 | [截图](screenshots/workflow-1440.png)        | Primary Result 显示“文本结果”，无内部 logical key/source。 |
| Workflow 900  | [截图](screenshots/workflow-900.png)         | 结果名称可读；Advanced 默认折叠。                          |
| Jev 1440      | [截图](screenshots/jev-1440.png)             | Cloud Shadow 复用 Switch；未配置/未同意时禁用。            |
| MCP 900       | [截图](screenshots/mcp-create-900.png)       | 开关开启状态与键盘 focus 可辨；Space/Enter 切换已验证。    |

## 自动与功能证据

[83 张截图清单](evidence-manifest.json)覆盖 1440/1180/900 的完整页面矩阵；本轮人工逐张复核上表的关键画面。每次捕获均断言普通可见文字没有 `FAKE:` / `TEST_ONLY` / `fixture`，并沿用 overflow、字号、scrollbar 和 Drawer 操作区检查。

Routing Switch 使用原 typed IPC/config。MCP 的 Space/Enter 控制受控开关；Workflow 普通结果展开后无 key/source，Advanced 展开仍可查看 `summary`、`MISSION` 与冻结 Contract 事实。

截图来自真实 Windows x64 package、隔离项目 userData。当前视觉响应通过已有 OpenAI-compatible 本地 HTTP/AI SDK fixture 路径提供正常中文；FakeModelGateway 与 Gate 核心 fixtures 未修改。不是公开 API 联调，也没有替换 Renderer IPC 返回值、修改 persisted Artifact 内容/Hash 或禁用 DB 约束。

PNG 使用本机 125% DPI。未复制 SQLite、明文/ciphertext、用户 profile 或日志中的敏感数据。无新增依赖、migration、W2.1 或任何后端能力。
