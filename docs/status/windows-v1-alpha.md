# Windows V1 Alpha 状态

状态：Gate 6 完成，等待最终 Alpha 审批。

## 范围

Windows V1 Alpha 将 Gate 0–5 的本地工作流收束为可安装的 Windows x64 应用。Experience Ledger 从 Mission/Run/Tool/Collaboration 的持久化事实重建；CapabilityProfile 只是可重建的客观统计。Realm 保持现有值，新道友默认 `QI_REFINING`；V1 不自动晋级，不使用 Token 或聊天次数给能力打分。

## Alpha Acceptance Matrix

| 场景                        | 验收点                                                                                   | 证据                                            | 状态       |
| --------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------- |
| 1 身份与模型解耦            | Runtime 迁移后 ID、Memory、Mission、Skill、Experience 保持                               | Gate 1/2 packaged + Gate 6 packaged             | 通过       |
| 2 Memory 隔离               | A/B owner 过滤，B prompt 无 A 私有内容                                                   | Gate 2/5 tests + packaged                       | 通过       |
| 3 SOLO Mission              | Run、Model、Usage、Audit、Experience 同源归属                                            | Gate 3 tests + packaged + Gate 6 ledger tests   | 通过       |
| 4 Memory Proposal           | Reject 不进入 ACTIVE，Accept 可检索                                                      | Gate 2 tests + packaged                         | 通过       |
| 5 Runtime Migration         | 更换 Provider/Runtime 后沿用记忆与经历                                                   | Gate 1/2/6 packaged                             | 通过       |
| 6 Permission Deny           | Tool 不执行，结构化 denial、Audit，文件不变                                              | Gate 4 tests + packaged                         | 通过       |
| 7 Mission Grant             | 精确 grant 仅在当前 Mission 复用                                                         | Gate 3/4 tests + packaged                       | 通过       |
| 8 主动协作                  | deny 目标零调用/零 artifact/零 Experience；approve 使用目标自己的 Runtime/Memory/Skill   | Gate 5/6 tests + packaged                       | 通过       |
| 9 Delegation 深度           | 深度 1，成员无法自动继续 delegate                                                        | Gate 5 tests + Gate 6 packaged                  | 通过       |
| 10 Party Consultation       | 成员独立调用、Usage 归属、Coordinator synthesis                                          | Gate 5 tests + packaged                         | 通过       |
| 11 Restart Waiting Approval | 同一 Run 的审批可重启后恢复                                                              | Gate 3/4/5 tests + packaged                     | 通过       |
| 12 Crash Running            | 重启转 INTERRUPTED，Retry 新 attempt                                                     | Gate 3 tests + packaged                         | 通过       |
| Alpha Review                | REVIEW Draft/Review/Final 与真实作者归属                                                 | Gate 5 tests + Gate 6 packaged                  | 通过       |
| Ledger 幂等                 | 重复处理、刷新、重启不重复生成；Retry Run 隔离                                           | Gate 6 tests + packaged                         | 通过       |
| 协作 outcome                | 成员 completed/failed 由自身终止事件决定；与 Coordinator 后续 Run 结果相反时仍保持原结果 | Gate 6 persistence/application tests + packaged | 待本轮复验 |
| 安装生命周期                | 安装、启动、关闭、重启、卸载/重装后数据语义                                              | Windows installer smoke                         | 通过       |
| Tool/MCP                    | 文件根约束、stdio MCP、Permission/Audit 共同链路                                         | Gate 4 tests + packaged                         | 通过       |
| Usage/Audit/Experience      | 实际 actor、Mission、Run 精确归属                                                        | Gate 3–6 tests + packaged                       | 通过       |
| 首次使用                    | Provider → 道友 → Chat → Memory/Skill → SOLO → Party/Collaboration                       | UI 引导 + Gate 1–6 packaged 组合路径            | 通过       |

## 验证命令

在 Windows x64 本机执行：

- `npm run test`：24 个文件、146 项测试通过。包含 Gate 0–5 全量回归、Gate 6 实际 actor/Run/source 归属、SOLO 未执行排除、denied target 排除、Retry 隔离、幂等与 append-only 保护。
- `npm run typecheck`、`npm run lint`、`npm run format:check`：通过。
- `npm run package`：Electron 44.4.3 和 `better-sqlite3` native module 构建通过。
- `npm run smoke:package`：真实打包程序中 Gate 1–6 smoke 全部通过；九页导航、IPC、SQLite、Memory scope、Permission/Tool/MCP、SOLO/Party、Usage/Audit 与 Gate 6 Experience 均通过。
- `npm run smoke:installer`：Squirrel 安装、启动、关闭、再次启动、卸载、重装通过；开始菜单快捷方式在安装时创建、卸载时移除、重装时恢复。`userData` 位于隔离的 `%USERPROFILE%/AppData/Roaming/AI Agent Cultivation`，SQLite 数据在卸载后保留并在重装后重新读取。测试目录 `E:\a6\mujijeul-754ec412` 保留供核查。

## 数据与架构

`0007_gate6.sql` 将此前未使用的通用 `experience_events` 原表保留为 `legacy_experience_events`，建立具有 `teammate_id / mission_id / run_id / source / source_id` 的新账本。唯一约束和 SQLite trigger 保证相同来源幂等、来源归属有效、账本行不可修改或删除。旧表中的自由格式记录不会被当成已验证经历。

`Gate6SqliteRepository` 仅从终结 Run 与真实 model/tool/usage/artifact 证据重建 Experience；被拒绝且未执行的目标没有经历。`CapabilityProfile` 每次由账本统计生成，不读取旧 `capability_profiles` 缓存，不生成主观分数。`skill.used` 来自实际 Mission prompt 注入事件。UI 展示来源 Mission/Run、角色、结果与时间。Realm 保持 `QI_REFINING`，不自动晋级。无 Gate 7 能力或预期外架构偏差。

`0008_gate6_collaboration_outcome.sql` 修正 `COLLABORATION` 的来源校验和既有派生行：成员的 completed/failed 以同一 Run、同一协作请求和实际目标道友的终止事件为准，不继承 Coordinator 最终 Run status。已开始但没有成员终止事件的协作，只在 Run `CANCELLED` / `INTERRUPTED` 时记录相应结果。`MISSION_RESULT` 仍以 Run status 为准。迁移仅重建可从 Mission/Event/Audit 持久事实派生的 Experience，不改动这些原始事实；Retry 继续按 Run 隔离。

## 发布产物

本机生成的 Windows x64 Alpha 产物位于 `out/make/`，版本 `0.0.1`：

| 产物                                                        | 大小             | SHA-256                                                            |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `squirrel.windows/x64/AI Agent Cultivation-0.0.1 Setup.exe` | 165,074,944 字节 | `e334313f0034fd5a0adc11a0b154acaa243a52d1ce32f3b44655ed0c2a7612d9` |
| `squirrel.windows/x64/AiAgentCultivation-0.0.1-full.nupkg`  | 164,322,296 字节 | `70f75c815946e3a5580b003048f746480266ccd8073676ce2751e33c9b50aacc` |
| `zip/win32/x64/AI Agent Cultivation-win32-x64-0.0.1.zip`    | 170,071,799 字节 | `0887d88dc7ed330e7b8b78ee7b9849eeab792952d8670385e18c6860da163368` |

Squirrel `RELEASES` 同目录生成。产物为本机未签名 Alpha，位于被 Git 忽略的 `out/`；本轮只推送源码与可复现构建配置，不发布 GitHub Release。

## 已知限制

安装包未签名，也没有自动更新服务。真实 Provider 请求需要用户自己的 API Key 与网络连接；自动化验收使用 FakeModelGateway，不以任何仓库密钥联调真实 Provider。MCP Server 仍由用户手动配置，用户须自行维护本地数据备份。`sqlite-vec` 不可用时仍可使用 FTS5 Memory。V1 不实现自动晋级、模型主观能力评分、Scheduler、Browser/Computer Use、Shell、Marketplace、云同步或 Web。
