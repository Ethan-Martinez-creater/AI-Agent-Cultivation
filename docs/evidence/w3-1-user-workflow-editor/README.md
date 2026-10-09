# W3.1 evidence

范围：USER Draft 编辑与 immutable version 发布，复用现有 W1/R4/Mission/Permission 执行链。自动化采用离线模型 fixture，正式启动不会安装用户 fixture Workflow 或加载 fake Provider。

- `validation/`：最后一轮六项原命令的完整日志。
- `packaged/facts.json`：真实 Windows Electron + native SQLite 的正常生产启动、UI Draft/实际拖拽/审核分支/发布、v1/v2 pinning、实际 USER Run、官方复制、非法发布和重启无重放事实。
- `packaged/*.png`：1440/1180/900 三档真实窗口截图，不是浏览器替代或静态 mockup。
- `acceptance.json`：最终验收矩阵、数量与兼容性证据索引。
- `frozen-hashes.json`：三个正式 W2 v1 的 content/manifest hash；从 native SQLite 读取并与前阶段冻结证据比较。
- `draft-version-facts.json`：Draft 保存、v1/v2 Run pinning、真实 USER 执行和重启事实。
- `builtin-copy-isolation.json`：官方复制后的 USER identity、authority 隔离与冻结 hash。
- `invalid-input-rejection.json`：非法图、约定和 authority intent 被拒绝，未新增非法发布或执行。
- `migration-upgrade.json`：0030→0031 升级测试、历史 migration 不变和 production profile 事实。
- `compatibility.json`：真实 persisted R4 Workflow context、Permission/Approval 与全链 packaged regression。
- `build-provenance.json`：源码与项目内 Electron ABI 构建副本逐文件一致性，以及 package hash。
- `development/`：开发定向测试及受影响回归日志，独立于最终六项成功验收。

命令日志保留原始输出（包括末尾空行）；目录内 `.gitattributes` 禁止日志的 Git 换行转换，保证 `acceptance.json` 的日志字节数/hash 与提交内容一致。

所有测试 profile、Workspace、缓存和构建暂存均在项目 `.test-data`/`.tmp` 内；应用测试串行启动并在 finally 关闭。截图仅含测试内容，不记录 API Key、private Memory 或隐藏 CoT。
