# W1 corrective repair — packaged evidence

验收日期：2026-10-01；基线 `main@06b122829013fd0af0bf2a42cefecc24a1798fdd`。来自本轮完整 `npm run smoke:package` 的真实 Windows x64 / Electron 44.4.3 应用。

[Manifest](manifest.json) 记录运行、原 Mission/Run、实际 actor/runtime Usage、schema=18 与恢复场景。[I/O SQLite facts](io-acceptance.json) 直接导出冻结输入、Step/Mission 关联、实际输出及 final validation：合法输入 Run COMPLETED；Step 已 COMPLETED 但最终 required output 未通过的 Run 保持 WAITING/USER_CONFIRMATION。

截图原件及对应 `*-layout.json`：

- [待启动，1180×780](01-workflow-ready.png)
- [顺序完成，1440×900](02-workflow-completed.png)
- [窄窗口，900×600](03-workflow-completed-900.png)
- [本尊交付后完成，1180×780](04-human-bridge-workflow.png)
- [schema-driven 输入表单，1180×900](05-workflow-input-form.png)
- [冻结输入只读展开，1440×900](06-workflow-frozen-input.png)

表单截图为滚动后的元数据/引用区域；使用真实 UI 填写 string、enum、number 和仅保存备注并创建 Run。恶意测试文本只在声明的 assistant untrusted data 中出现，未声明备注不进入 Step，原 Mission objective 和 routing context 不含原始输入。Renderer 修改返回对象与 SQLite UPDATE 均不能改变持久快照；重启后输入、版本、final receipt 完全一致。

原 TASK/REVIEW/DECISION、Party 审批、Tool 同 Run 重启、本尊 WAITING/ACCEPT continuation、Retry 保留历史及两处强制终止恢复也再次通过。截图人工检查，三尺寸无页面横向溢出。

完整 profile：项目内 `.test-data/w1-packaged-8d40b31b-b36e-4e7d-85f3-5e18aef72882`。旧 UI 全量 35 张回归原件：`.test-data/r3-3-ui-aa10cd79-5a8b-4da3-8771-a6bf49df82cc`。数据库、Credential、缓存和 exe 不提交；此处仅包含合成验收数据。FakeModel/FakeDecision/test-only definition 明确启用，正常生产启动仍没有预置 Workflow 或官方模板。
