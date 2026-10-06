# G3 验收证据

基线：`108a1154ad4a92f36e8ea60dd898f3bd0c6235bc`。迁移仅追加 `0030`。

## 执行方式

- Windows x64 Electron package，真实 typed IPC / Main / SQLite；测试应用按场景串行关闭、重启。
- H3 使用离线 HTTP fixture 和正式 HTTP adapter。图片、音乐使用显式 `--g3-fixture` 的 test-only gateway。正常启动不加载这些 gateway 或测试 Workflow。
- Fixture 记录 provider submission / download / idempotency key digest；SQLite 记录 Task、attempt、outcome、continuation、GenerationJob 和 Artifact。
- 没有真实部署 endpoint。**Live Integration = BLOCKED / NOT RUN**。

## 原始验证日志

`validation/` 保存六项原命令：`npm run test`、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run package`、`npm run smoke:package`。

构建在项目内隔离 checkout 完成，以保持 Node 单元测试与 Electron 的 native ABI 分离。TEMP / TMP、userData、构建缓存和测试工作区均在项目目录。没有使用机器外的临时 preload。

## 场景与事实

最终成功证据：

- `9582b922-c4e6-4869-94eb-a51a1de6228d/`：H3/image/music、权限拒绝、依赖、retry/UNKNOWN、Workflow 与 A–H/J；9 张截图。
- `human-833daaf7-3550-44ec-94e5-2f1483e9cfc5/`：本尊补素材、实际 actor FILE_READ、独立审查、I 窗口和一次性 synthesis；9 张截图。
- `acceptance.json`：两个成功运行的事实汇总，1012 项测试、A–J matrix 与截图尺寸清单。
- `frozen-hashes.json`：最终 Windows package SQLite 中三个 OFFICIAL v1 的 manifest/content hash，与 G2 冻结基线逐一核对。

18 张截图覆盖 1440 / 1180 / 900，包括 Mission、Party、媒体播放器近景、本尊待办与审查后原 Run synthesis。未成功的调试目录不作为通过证据。六项原命令全部 PASS，源代码测试为 124 个文件、1012 项。全部测试应用已关闭。

| 范围                | 检查事实                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------- |
| H3 协作             | LANGUAGE Coordinator → approved Generation participant → MP4 → 原 MissionRun synthesis    |
| Provider-neutral    | IMAGE / MUSIC fixture，独立 Runtime，结果为已注册媒体 Artifact                            |
| 结构化 continuation | NEEDS_INPUT / NEEDS_CAPABILITY，独立批准依赖；role/hash/provenance 校验后恢复上游         |
| Retry / UNKNOWN     | 确认拒绝后新 Task/key，预算有界；UNKNOWN 零自动重提                                       |
| Human Bridge        | 补素材、实际 actor FILE_READ 授权、独立媒体审查、原 Run 恢复                              |
| Workflow            | 明确 test-only 定义 → R4 → 原 Mission → Generation → Artifact → W1 validation/checkpoint  |
| 权限和归属          | DENY 未执行 target 零 Job/Artifact/Experience；固定队伍不加入外人；ArtifactRef 不授予权限 |
| 重启                | A–J 持久化边界，历史 Task/attempt/Job 保留，outcome/continuation 消费一次                 |
| UI                  | Mission / Party / media card，1440 / 1180 / 900；内部事实在 Advanced                      |
| 回归                | Gate 0–6、R0–R4、W1/W2、G1/G2；三个 OFFICIAL v1 hash 不变                                 |

截图为真实 Windows package，未通过绘图替代应用界面。Fixture 内容仅用于离线验收，不宣称真实媒体 Provider 联调通过。
