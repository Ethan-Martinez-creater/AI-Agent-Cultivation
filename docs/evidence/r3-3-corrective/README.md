# R3.3 corrective repair — packaged evidence

验收日期：2026-09-30；代码基线：`main@91b5e35`。

成功运行 ID：`b923b1b3-b10b-4334-a3fc-b241a399f57f`。
`npm run smoke:package` 退出 0，完整 UI harness 生成 35 张截图并通过 Gate 0–6 / R0–R3.3 回归。本目录仅提交本轮修复相关的四张原始截图，上一轮完整视觉索引保留在 [R3.3 visual/product evidence](../r3-3-visual-product/README.md)。

| 截图                                                       | 检查内容                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| [已有模型](06-create-teammate-model-1440.png)              | A/B 已封存同模型后，radio 仅有未绑定模板，不展示两个私有 Runtime  |
| [无模板空状态](create-teammate-no-template-1440.png)       | 明确空状态与可操作的“添加新模型”入口                              |
| [无密钥连接成功](create-teammate-keyless-tested-1440.png)  | Compatible API Key 可选，Endpoint + Model ID 测试成功，未导入 Key |
| [无密钥创建确认](create-teammate-keyless-confirm-1440.png) | 固定模型确认步骤；随后真实点击创建并查询 SQLite sealed binding    |

所有截图来自 Windows packaged exe，真实窗口 1440×900 DIP；本机 125% DPI，PNG 为 1800×1125，未经缩放/裁切。所有 35 张截图和布局指标原件保留在仓库 `.test-data/r3-3-ui-b923b1b3-b10b-4334-a3fc-b241a399f57f`。

[evidence-manifest.json](evidence-manifest.json) 是成功运行的完整 manifest，保留全部原始路径/尺寸/断言，其中其余截图未在本目录重复提交。关键断言：

- `creation-empty-template-guides-to-new-model`
- `creation-only-unbound-template-no-duplicate-private-runtimes`
- `keyless-ui-test-create-sealed-sqlite-identity`
- `embedded-provider-model-test-and-seal`
- `credential-rotation-ui-preserves-sealed-model-identity`

无密钥创建全程走真实 Renderer → typed Preload IPC → Main → native SQLite，ModelGateway 使用确定性 Fake。只读 SQL 同时校验 Provider/Endpoint/Model、`LIVE_TEST` 与 verified/sealed 时间、binding/runtime Credential 为 null、该 Provider 无 Credential 行。不是外网 Provider 联调；完整 smoke 另含 R3.2 的真实 AI SDK 本地 HTTP fixture 回归。
