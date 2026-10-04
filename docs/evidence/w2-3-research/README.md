# W2.3 Windows packaged acceptance evidence

本目录归档真实 Windows x64 packaged app 的截图与 SQLite/typed IPC 核对事实。执行入口为 `npm run smoke:package`，科研子集为 `scripts/w23-packaged-smoke.mjs`。模型和 stdio MCP 使用离线确定性 fixture；应用、原生 SQLite、Workspace 文件、Permission/Approval、Workflow 与 Human Bridge 状态链是真实执行。这里只验证软件执行与科研 provenance 边界，不把样例计算当作真实科研结论。

## 验收场景

| 场景                  | 主要检查                                                                                          | 截图                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A 计算机算法/系统实验 | Renderer 表单创建；R01–R14；独立审查；APPLIED 崩溃后核验已有 raw/log，模型与 Tool 零重放          | `A-algorithm-create.png` / `A-algorithm-completed.png`                                       |
| B 已有数据集分析      | 首次失败/阴性结果保留；新实验 attempt 与不可变 raw Artifact；重新分析；单合格审查者如实记录非独立 | `B-dataset-create.png` / `B-dataset-completed.png`                                           |
| C 外部实验模拟        | 本尊交付记录/raw/log；ACCEPT 后 PENDING continuation 崩溃；原 MissionRun 恢复与幂等消费           | `C-external-human-bridge-human-bridge-pending.png` / `C-external-human-bridge-completed.png` |
| D MIXED               | 真实 Tool 计算后同 Run 人工补充；secondary receipt；ACCEPT 后恢复不再调用模型/Tool                | `D-mixed-human-bridge-human-bridge-pending.png` / `D-mixed-human-bridge-completed.png`       |
| F 共享回环上限        | REFINE_EXPERIMENT 与 REFINE_HYPOTHESIS 各提交一次，共用冻结预算 2；下一次停止等待用户             | `F-shared-cycle-limit-waiting.png`                                                           |
| E UNKNOWN 外部动作    | 真实 PREPARED 后在隔离验收库模拟结果不确定；重启保留原请求与 receipt，等待用户，零重放            | `E-unknown-external-action-create.png`；事实见 JSON                                          |

## 持久事实与验证

- `facts.json`：Run/Step/MissionRun 标识、来源句柄、claim→Artifact 引用、实际审查 actor、实验 attempts、失败/阴性结果、共享 traversal、回执恢复与 restart 前后调用计数。
- `release-facts.json`：真实 SQLite 的 OFFICIAL release / manifestHash、冻结 Version hash、14 个 Step、21 个 Contract 与 revision manifest。
- `verification-results.json`：六项最终命令及测试数量。
- `smoke-package.log`：全量 Gate 0–6、R0–R4、W1/W2.0/W2.1/W2.2/W2.3 packaged 回归结果。
- 截图来自真实 packaged UI；科研 Run 经“工作流历练 → 新建运行 → 科研 → 填写输入 → 创建 → 推进 → 最终确认”启动。

完整数据库、Credential、ciphertext 与应用 profile 不纳入仓库。`facts.json` 内 Workspace 路径仅标识项目内隔离验收位置，不是生产数据路径。正常应用继续使用 `app.getPath('userData')`。

## 限制

科研来源 fixture 提供有明确标识的离线来源快照；生产 Research Tool/MCP 和外部实验需用户配置与授权。MCP 为用户配置的外部进程，本轮不提供操作系统级沙箱。最终资料包始终 `NOT_SUBMITTED / NOT_SCIENTIFICALLY_CONFIRMED`，无自动投稿或发布。

## 最终 corrective evidence

`corrective/` 保存 W2.3 最后一轮修复的真实 Windows package 验收；本目录原始 evidence 保留为实现阶段的历史记录。

- `corrective/facts.json`：Main 导入后可信 dataset ID/kind/hash、不可变 Run snapshot、输入 binding、导入前后 PermissionRule 数量不变、R07/R08 的实际使用，以及每个 Run 的完整可信 delivery projection。
- `corrective/B-dataset-artifact-selected.png`：Renderer UI 通过原生选择/确认导入真实 Workspace CSV，仅显示可选名称。
- `corrective/B-complete-research-delivery-projection.png`：完整交付列表与全部实验/审查尝试，最终 R13 稿件。
- `corrective/B-reversed-literature-range-rejected.png` / `corrective/B-literature-date-range.png`：倒序日期被拒绝，紧凑控件保留 frozen shape。
- `corrective/verification-results.json` 与 `corrective/smoke-package.log`：最终六项及 Gate 0–6、R0–R4、W1/W2.0/W2.1/W2.2/W2.3 全量 packaged 回归。

不存在引用、伪造 kind/hash、创建前文件改变均由 Main 拒绝且不创建 Run；输入事实不会授予额外模型/工具权限。原 A/B/C/D/F/E 场景截图及 restart/mutation/Human Bridge/independent review 的 durable facts 也归档在该子目录。

### R08 consumed-input provenance 闭环

最新 `corrective/facts.json` 的 `datasetInput.durableExperimentInputChain` 为每个 B/R08 attempt 记录：frozen id/kind/hash、同 Run input binding、真实 MissionEvent ID、ToolCall/toolId/outputHash、actor/MissionRun/StepRun、以及可信策略接受后的 Artifact/validation receipt。`durableInputFactsRestartSafe` 与 restart 前后调用计数证明原事实保持且不重放。

`adversarialExperimentInputs` 记录生产 Main 对 missing、forged、foreign input facts 及执行前后改变/删除文件的拒绝：没有已接受的 R08 Artifact；已执行副作用的后置失败保存 UNKNOWN receipt。新增测试也覆盖不能通过过滤无效条目/截断溢出声明来让不合法 consumed-input 集合通过。raw-result.json 的自报字段仅是补充，不再承担安全边界。
