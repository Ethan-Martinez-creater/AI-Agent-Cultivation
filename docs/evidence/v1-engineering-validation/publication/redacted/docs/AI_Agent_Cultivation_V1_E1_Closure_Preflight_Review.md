> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `ca53e0eca27201f2d48076e06ba03824654d97b1ca249a06fcacabfc522b1a0b`. See the publication derivation map for both hashes and removed field categories.

# AI Agent Cultivation V1 — E1 Closure / Preflight Review

执行日期：2026-10-15 至 2026-10-16（Asia/Shanghai）。依据：`AAC-ENGVAL-E0-v0.2`，Canonical Dataset `AAC-E0-BENCH-v0.1`。本文记录真实执行前检查，不包含正式 Jev Live 成绩或正式进程强杀恢复成绩。

**最终结论：E1_CLOSURE_CONDITIONAL。** 输入、公式、离线安全分支和本地传输观察已有可重复证据；E2 仍需独立 Gold 签署、账号价格与金额上限，以及一次提交/停止合同的独立放行。E3 的两个窗口分别按下表判定。没有自动开始 E2/E3。

| 检查项                           | 状态    | 证据边界 / 未完成条件                                                                                                         |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATASET_INTEGRITY`              | PASS    | 基线、三个冻结 Hash、33 migration 和三个官方 Workflow 核验通过。                                                              |
| `SKILL_INPUT_COMPATIBILITY`      | PASS    | 10/10；真实 SkillService / select，隔离内存 owner DTO，不包含 Gate1 持久化。                                                  |
| `MEMORY_INPUT_COMPATIBILITY`     | PASS    | 10/10；真实 rank，范围仅 R5.3 RERANK_ONLY。                                                                                   |
| `TOOL_MAPPING_COMPATIBILITY`     | PASS    | 10/10；16 个冻结合成 descriptor、真实 registry/select；执行回调 0 次。                                                        |
| `TO09_CAPACITY_CONTRACT`         | PASS    | 原生 fallback 12、Jev 上限 8、派生 K=8 分开；保持非 Live。                                                                    |
| `METRICS_CONTRACT`               | PASS    | 11 个合成测试通过；固定 Live 分母、fallback、NOT_RUN 和未知成本独立保留。                                                     |
| `JEV_TRANSPORT_OBSERVABILITY`    | PASS    | 17 个 loopback 场景；区分 logical/dispatch/wire。未测真实 Jev TLS 或计费。                                                    |
| `JEV_COST_GUARD_READINESS`       | BLOCKED | 需账号真实价格、金额上限，以及拒绝 replay/redirect 和迟到 factory 的执行合同审核。                                            |
| `CR_A_PACKAGED_BREAKPOINT`       | PASS    | 真实 Windows 既有打包产物、官方 Workflow、TypeScript 隔离工程；S06 提交后精确命中，S07 READY / Mission 未创建。               |
| `CR_B_PACKAGED_BREAKPOINT`       | PASS    | 独立 TS Profile；真实 S05、权限/Guard、writeText 入口 9848:7612 与写后 return 9848:13661；文件改写、两 PREPARED、无成功结果。 |
| `CRASH_CONTROLLER_OBSERVABILITY` | PASS    | Preflight：独立入口/写后命中各1、S06 verifier外部ledger1/1、Main身份及SQLite/WAL采集已验证。正式重启后计数 NOT_RUN。          |
| `GOLD_INDEPENDENT_REVIEW`        | BLOCKED | 15 个 Live Case 均待用户或独立评审者签署；原 Gold 未修改。                                                                    |

## A. 基线与文档完整性

HEAD：`a2551bbc9dbd87ec4701183a53a2635966326df4`，与批准的 V1 基线一致。本轮未提交、Push、修改生产选择算法、官方工作流定义/Contract/Manifest、历史 migration 或正式 Profile。最终跟踪文件差异见 [工作树审计](evidence/v1-engineering-validation/preflight/final-worktree-audit.json)。开始及 P0 审计时存在大量用户未跟踪文档、图片和历史证据，均保留；本轮新增文件以该审计清单为准，未批量删除或清理。

| 校验范围                        | 实际 SHA-256                                                       | 结果 |
| ------------------------------- | ------------------------------------------------------------------ | ---- |
| E0 v0.2 Markdown 原始字节       | `2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c` | PASS |
| 唯一 JSON 代码块约定范围        | `ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602` | PASS |
| ToolFixtureMapping TSV 约定范围 | `04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62` | PASS |

根目录原有 EXE、app.asar、实际 Main bundle 的最终 SHA 均与预检前一致，见 [打包产物完整性](evidence/v1-engineering-validation/preflight/packaged-artifact-integrity-final.json)。这不代表本轮重打包成功。

30 个唯一 Case，三家族各 10 个；预注册 Live 各 5 个、共 15 个、合计 91 个 question。候选引用、重复引用、grade 0–3、Live ID 列表均通过。未修改 Gold 或候选以改善分数。TO-09 仍不在 Live。

33 个 migration 全部存在。20 个工作副本的原始字节 SHA 与 Git 内容不同，但全部 33 个 LF 规范化内容与基线一致，未认定纯 CRLF 差异为内容篡改，也未改写 migration。[dataset-integrity.json](evidence/v1-engineering-validation/preflight/dataset-integrity.json) 逐文件保留原始 SHA-256、Git blob object ID、Git 内容 SHA-256 和明确标注的 LF SHA-256。

用生产 `openDatabase()` 创建全新 E 盘 SQLite，实际应用全部 33 个 migration；实际安装三个官方 workflow，逐一比较治理记录中的 content/manifest hash；`integrity_check=ok`、FK 违规 0。

| 官方 Workflow @version      | content_hash                                                       | manifest_hash                                                      |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| official.ai-news-video@1    | `4763d276b85362096db1085ebc458c76ea731c243d72df6069da302ca75ce153` | `ae37a04bf0156c42adea41d8d0418de2f942d6dc677803727af7db41ab36e4cd` |
| official.research@1         | `b264c0448470b12473c0e39f21cf7e1c40c1d9b4b6e1c945f9ffb5ccc2a305b7` | `199c675c91c1c7d15709141be9a7dc6ce1e776f3c1b0af7c66c2ff9e1f3b03d3` |
| official.software-feature@1 | `a5a9982824db796dc4843d68558b4874067d551eff878132c78c94e881e2ea5a` | `30eb30ce957ef3bad798d1046bd45835322b645d97e49ca5affcac4e16cd348d` |

## B. 30 组逐案验证

Skill 实际调用 `SkillService.create/assign/enable` 和 `SkillRoutingService.select`。每案有唯一、类型正确、固定时间的 Teammate owner fixture，assignment 前检查 owner 存在；存储端口使用独立内存实现，**不宣称验证了 Gate1 创建、连接探测或 Teammate 持久化**。初始 assignment 默认 disabled，再通过服务 enable。Gateway factory 为 null；生产词汇排序及候选快照由原选择器生成，未复写词汇排序算法。

Memory 使用固定 owner、ACTIVE、MANUAL、空 source IDs、`expiresAt=null`、固定时间、summary=content 的合法记录，按 E0 顺序调用真实 `MemoryRerankService.rank()`。证据等级是 **R5.3 RERANK_ONLY**，不包含 Gate2 检索召回或最终 Prompt 注入。生产 NFKC/清洗会改变部分文本 Hash；记录的是原 Catalog Hash 与生产 request-builder 投影 Hash，不把两者混为一谈。无候选因输入错误丢失。

Tool 使用真实 `ToolRegistry`，按冻结 TSV 和 E0 中文元数据构造 16 个合成 descriptor；source=BUILTIN、`workflowPurposes=[]`、有序 schema properties/required 和拒绝执行的 resource/execute callbacks。`bench.*` 与本轮 `file.*` 均只是评测目录，不是新增的产品正式工具。真实工具执行次数为 0。完整 descriptor 列表 SHA：`3df46e4341a1de6f9e337e33bf8fa8ffced47f476a4de4882287b1ca6743269f`。

下表候选顺序均来自实际服务回执；每条的完整输入/投影/receipt Hash、pre/post eligibility IDs、mode/reason/policy 与文本事实保存在对应 JSON。`DTO PASS` 表示本轮 selector 输入合同通过，不扩大为全产品端到端输入链通过。

### Skill

| Case  | DTO / 结果  | Eligibility 前                                                  | Eligibility 后                                                  | production candidateIds                                         | 原生 baseline result            | 过滤 / 截断              | input/state Hash                                                   |
| ----- | ----------- | --------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| SK-01 | 合法 / PASS | csv-clean, sql-join, anomaly, markdown, chart, notes            | csv-clean, markdown, anomaly, chart, notes, sql-join            | csv-clean, markdown, anomaly, chart, notes, sql-join            | csv-clean, markdown, anomaly    | 无丢候选；无候选预算截断 | `18dbb0d32a704f96aad85002d314a2245eabcfb7552feb60abf1b5d0a630981c` |
| SK-02 | 合法 / PASS | csv-clean, anomaly, chart, sql-join, perf, notes                | chart, anomaly, csv-clean, notes, perf, sql-join                | chart, anomaly, csv-clean, notes, perf, sql-join                | chart, anomaly, csv-clean       | 无丢候选；无候选预算截断 | `ec2b9c1221b81d94a28a826b589c4877a3f8203d798d43cc92f50200e9516e7b` |
| SK-03 | 合法 / PASS | log-debug, security, api-design, unit-test, markdown, translate | api-design, log-debug, markdown, security, translate, unit-test | api-design, log-debug, markdown, security, translate, unit-test | api-design, log-debug, markdown | 无丢候选；无候选预算截断 | `432cd74bb2434b1b25293b691f4e6fca134d8a2f6b6f42c13362b570304c5285` |
| SK-04 | 合法 / PASS | api-design, unit-test, requirements, log-debug, notes, chart    | api-design, unit-test, chart, log-debug, notes, requirements    | api-design, unit-test, chart, log-debug, notes, requirements    | api-design, unit-test, chart    | 无丢候选；无候选预算截断 | `197773f09a612d9ad9ffd2ff40485329686ff171948f574e396540868977a1e0` |
| SK-05 | 合法 / PASS | research, markdown, privacy, benchmark, translate, chart        | research, markdown, benchmark, chart, privacy, translate        | research, markdown, benchmark, chart, privacy, translate        | research, markdown, benchmark   | 无丢候选；无候选预算截断 | `1c457ae9f255d1f0d22e272696ba1a20f8d0620ce2639e3cf5e16b861ffc8822` |
| SK-06 | 合法 / PASS | benchmark, perf, unit-test, chart, api-design, sql-join         | benchmark, perf, api-design, unit-test, chart, sql-join         | benchmark, perf, api-design, unit-test, chart, sql-join         | benchmark, perf, api-design     | 无丢候选；无候选预算截断 | `a6be2430ec9ac2d0c2bd369cae89bd285278cabfde10192199d609d8c6e14efb` |
| SK-07 | 合法 / PASS | notes, markdown, requirements, unit-test, api-design, log-debug | notes, api-design, log-debug, markdown, requirements, unit-test | notes, api-design, log-debug, markdown, requirements, unit-test | notes, api-design, log-debug    | 无丢候选；无候选预算截断 | `7b95395932566488d93fdafa63aeed56de558b82fbf315b6c2809d3f39d6e5b2` |
| SK-08 | 合法 / PASS | privacy, security, log-debug, markdown, notes, translate        | log-debug, markdown, notes, privacy, security, translate        | log-debug, markdown, notes, privacy, security, translate        | log-debug, markdown, notes      | 无丢候选；无候选预算截断 | `d5f0761398e23d5c5040dea09b7040c390249932291ad4c275c3a5b47b284987` |
| SK-09 | 合法 / PASS | api-design, markdown, translate, security, unit-test, chart     | api-design, markdown, chart, security, translate, unit-test     | api-design, markdown, chart, security, translate, unit-test     | api-design, markdown, chart     | 无丢候选；无候选预算截断 | `264c6b15978eb4f67ae5a1164f5e2f9c99aed75afec716968bd68c0a072b821a` |
| SK-10 | 合法 / PASS | benchmark, perf, anomaly, research, notes, api-design           | anomaly, api-design, benchmark, notes, perf, research           | anomaly, api-design, benchmark, notes, perf, research           | anomaly, api-design, benchmark  | 无丢候选；无候选预算截断 | `1e4a6fde73345f10baf36c06e83d1677280fcacd4cf2e23402444567f890f8e2` |

### Memory

| Case  | DTO / 结果  | Eligibility 前                                                         | Eligibility 后                                                         | production candidateIds                                                | 原生 baseline result                                                   | 过滤 / 截断              | input/state Hash                                                   |
| ----- | ----------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| ME-01 | 合法 / PASS | api-old, api-current, mimo, workflow, music, recovery                  | api-old, api-current, mimo, workflow, music, recovery                  | api-old, api-current, mimo, workflow, music, recovery                  | api-old, api-current, mimo, workflow, music, recovery                  | 无丢候选；无候选预算截断 | `740e049dc190e0e4f126ec53e31a47516486f07fa6309324e8b378c564b5c429` |
| ME-02 | 合法 / PASS | csv-example, csv-policy, ui-size, api-old, privacy, code-review        | csv-example, csv-policy, ui-size, api-old, privacy, code-review        | csv-example, csv-policy, ui-size, api-old, privacy, code-review        | csv-example, csv-policy, ui-size, api-old, privacy, code-review        | 无丢候选；无候选预算截断 | `d322febd23e5c2130ac0ae8ce29a8397a98bbb3b5ec8babd228919e706843575` |
| ME-03 | 合法 / PASS | outdated-cost, recovery, workflow, jev-tool, music, ui-theme           | outdated-cost, recovery, workflow, jev-tool, music, ui-theme           | outdated-cost, recovery, workflow, jev-tool, music, ui-theme           | outdated-cost, recovery, workflow, jev-tool, music, ui-theme           | 无丢候选；无候选预算截断 | `1f8177f79b933de7d654799a5393e2f08f1bb0c61111642aca3c6380f5e17bc7` |
| ME-04 | 合法 / PASS | jev-shadow, jev-tool, permission, privacy, code-review, api-current    | jev-shadow, jev-tool, permission, privacy, code-review, api-current    | jev-shadow, jev-tool, permission, privacy, code-review, api-current    | jev-shadow, jev-tool, permission, privacy, code-review, api-current    | 无丢候选；无候选预算截断 | `7111829a822216d037ec7b8c6cab0e2be02eaf675899bd3236933b92b7179619` |
| ME-05 | 合法 / PASS | outdated-cost, cost, privacy, recovery, ui-theme, music                | outdated-cost, cost, privacy, recovery, ui-theme, music                | outdated-cost, cost, privacy, recovery, ui-theme, music                | outdated-cost, cost, privacy, recovery, ui-theme, music                | 无丢候选；无候选预算截断 | `82e18071d4421ce08233767bde22264943365d79092fec2385473d4f53189723` |
| ME-06 | 合法 / PASS | research-cite, code-review, workflow, csv-policy, api-current, ui-size | research-cite, code-review, workflow, csv-policy, api-current, ui-size | research-cite, code-review, workflow, csv-policy, api-current, ui-size | research-cite, code-review, workflow, csv-policy, api-current, ui-size | 无丢候选；无候选预算截断 | `046bd5a4ebe0e0189a9ca4ea4e2043c1555cb9fa88c632eeed5e2513d1df6355` |
| ME-07 | 合法 / PASS | ui-theme, ui-size, music, mimo, api-old, privacy                       | ui-theme, ui-size, music, mimo, api-old, privacy                       | ui-theme, ui-size, music, mimo, api-old, privacy                       | ui-theme, ui-size, music, mimo, api-old, privacy                       | 无丢候选；无候选预算截断 | `4360cc66740be00fdd0232ec54c86c611c75073a81f68a155809adb32965f5a6` |
| ME-08 | 合法 / PASS | api-old, api-current, recovery, mimo, csv-example, jev-shadow          | api-old, api-current, recovery, mimo, csv-example, jev-shadow          | api-old, api-current, recovery, mimo, csv-example, jev-shadow          | api-old, api-current, recovery, mimo, csv-example, jev-shadow          | 无丢候选；无候选预算截断 | `ef119c3dccd1b0f84749909f374d1155680b820e5765838104e4e4289606e920` |
| ME-09 | 合法 / PASS | mimo, api-current, music, privacy, cost, workflow                      | mimo, api-current, music, privacy, cost, workflow                      | mimo, api-current, music, privacy, cost, workflow                      | mimo, api-current, music, privacy, cost, workflow                      | 无丢候选；无候选预算截断 | `ac3a2ff7d0acd237e443bf99a26bdf1d87e28179ebdfb6be9a233a77a5ea13c5` |
| ME-10 | 合法 / PASS | permission, workflow, recovery, api-current, jev-tool, ui-theme        | permission, workflow, recovery, api-current, jev-tool, ui-theme        | permission, workflow, recovery, api-current, jev-tool, ui-theme        | permission, workflow, recovery, api-current, jev-tool, ui-theme        | 无丢候选；无候选预算截断 | `998f9fa8464868b1493db9a9894485260827770bd05f29a99d0190b285703bc3` |

### Tool

| Case  | DTO / 结果  | Eligibility 前                                                                                                                                                                                                            | Eligibility 后                                                                                                                                                                                                            | production candidateIds                                                                                                                                                                                                   | 原生 baseline result                                                                                                                                                                                                      | 过滤 / 截断              | input/state Hash                                                   |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| TO-01 | 合法 / PASS | file.list, file.readText, file.writeText, file.createDirectory, bench.log.inspect, bench.docs.search                                                                                                                      | file.list, file.readText, file.writeText, file.createDirectory, bench.log.inspect, bench.docs.search                                                                                                                      | file.list, file.readText, file.writeText, file.createDirectory, bench.log.inspect, bench.docs.search                                                                                                                      | file.list, file.readText, file.writeText, file.createDirectory, bench.log.inspect, bench.docs.search                                                                                                                      | 无丢候选；无候选预算截断 | `256c5c3ab0e879eae308e32414a3aaac7cdc45f4ccaaca7f775ed407767404b0` |
| TO-02 | 合法 / PASS | file.list, file.readText, file.writeText, bench.docs.search, bench.log.inspect, bench.csv.validate                                                                                                                        | file.list, file.readText, file.writeText, bench.docs.search, bench.log.inspect, bench.csv.validate                                                                                                                        | file.list, file.readText, file.writeText, bench.docs.search, bench.log.inspect, bench.csv.validate                                                                                                                        | file.list, file.readText, file.writeText, bench.docs.search, bench.log.inspect, bench.csv.validate                                                                                                                        | 无丢候选；无候选预算截断 | `135aa2656fa4c3baae0119ce1d314074ddd596197bbfc4ca41454ba8b7a26f0e` |
| TO-03 | 合法 / PASS | file.readText, bench.csv.validate, bench.csv.aggregate, file.writeText, bench.chart.render, bench.stats.anomaly                                                                                                           | file.readText, bench.csv.validate, bench.csv.aggregate, file.writeText, bench.chart.render, bench.stats.anomaly                                                                                                           | file.readText, bench.csv.validate, bench.csv.aggregate, file.writeText, bench.chart.render, bench.stats.anomaly                                                                                                           | file.readText, bench.csv.validate, bench.csv.aggregate, file.writeText, bench.chart.render, bench.stats.anomaly                                                                                                           | 无丢候选；无候选预算截断 | `67a8138de3e366c7537f56b9a03584010f050a9f723e5f16d1fe3b7071539a5d` |
| TO-04 | 合法 / PASS | bench.tests.run, bench.release.notes, bench.api.check, file.createDirectory, bench.docs.cite, bench.disk.remove                                                                                                           | bench.tests.run, bench.release.notes, bench.api.check, file.createDirectory, bench.docs.cite, bench.disk.remove                                                                                                           | bench.tests.run, bench.release.notes, bench.api.check, file.createDirectory, bench.docs.cite, bench.disk.remove                                                                                                           | bench.tests.run, bench.release.notes, bench.api.check, file.createDirectory, bench.docs.cite, bench.disk.remove                                                                                                           | 无丢候选；无候选预算截断 | `ed74b0af4dd368b64f75b5116d39ec05121e468960987345af7829b4dfc9fa4c` |
| TO-05 | 合法 / PASS | bench.log.inspect, bench.secrets.redact, file.readText, bench.docs.search, file.writeText, bench.disk.remove                                                                                                              | bench.log.inspect, bench.secrets.redact, file.readText, bench.docs.search, file.writeText, bench.disk.remove                                                                                                              | bench.log.inspect, bench.secrets.redact, file.readText, bench.docs.search, file.writeText, bench.disk.remove                                                                                                              | bench.log.inspect, bench.secrets.redact, file.readText, bench.docs.search, file.writeText, bench.disk.remove                                                                                                              | 无丢候选；无候选预算截断 | `309285ff3fc174292e9a3636f44a513b02fe62a20243f8ea296d6f39c8028bfb` |
| TO-06 | 合法 / PASS | bench.docs.search, bench.docs.cite, file.list, bench.csv.aggregate, bench.api.check, bench.log.inspect                                                                                                                    | bench.docs.search, bench.docs.cite, file.list, bench.csv.aggregate, bench.api.check, bench.log.inspect                                                                                                                    | bench.docs.search, bench.docs.cite, file.list, bench.csv.aggregate, bench.api.check, bench.log.inspect                                                                                                                    | bench.docs.search, bench.docs.cite, file.list, bench.csv.aggregate, bench.api.check, bench.log.inspect                                                                                                                    | 无丢候选；无候选预算截断 | `6c32710a14174db9b7f5bd8161760bd45cecf488c38e85c16cb32c3e3b41c279` |
| TO-07 | 合法 / PASS | bench.tests.run, file.readText, file.writeText, bench.docs.search, bench.chart.render, bench.disk.remove                                                                                                                  | bench.tests.run, file.readText, file.writeText, bench.docs.search, bench.chart.render, bench.disk.remove                                                                                                                  | bench.tests.run, file.readText, file.writeText, bench.docs.search, bench.chart.render, bench.disk.remove                                                                                                                  | bench.tests.run, file.readText, file.writeText, bench.docs.search, bench.chart.render, bench.disk.remove                                                                                                                  | 无丢候选；无候选预算截断 | `e9688f6c683a543263ee94979861211edcb184cdc4af489f393b8bddf80f0f7b` |
| TO-08 | 合法 / PASS | bench.stats.anomaly, bench.chart.render, bench.csv.aggregate, bench.csv.validate, file.readText, bench.docs.cite                                                                                                          | bench.stats.anomaly, bench.chart.render, bench.csv.aggregate, bench.csv.validate, file.readText, bench.docs.cite                                                                                                          | bench.stats.anomaly, bench.chart.render, bench.csv.aggregate, bench.csv.validate, file.readText, bench.docs.cite                                                                                                          | bench.stats.anomaly, bench.chart.render, bench.csv.aggregate, bench.csv.validate, file.readText, bench.docs.cite                                                                                                          | 无丢候选；无候选预算截断 | `04d87650d5f5f86f33a7c4cb20997de749c0c740e9c47d2b769d05e37fe984a0` |
| TO-09 | 合法 / PASS | file.list, file.readText, bench.csv.validate, bench.csv.aggregate, bench.chart.render, bench.tests.run, bench.docs.search, bench.docs.cite, bench.log.inspect, bench.secrets.redact, bench.api.check, bench.release.notes | file.list, file.readText, bench.csv.validate, bench.csv.aggregate, bench.chart.render, bench.tests.run, bench.docs.search, bench.docs.cite, bench.log.inspect, bench.secrets.redact, bench.api.check, bench.release.notes | file.list, file.readText, bench.csv.validate, bench.csv.aggregate, bench.chart.render, bench.tests.run, bench.docs.search, bench.docs.cite, bench.log.inspect, bench.secrets.redact, bench.api.check, bench.release.notes | file.list, file.readText, bench.csv.validate, bench.csv.aggregate, bench.chart.render, bench.tests.run, bench.docs.search, bench.docs.cite, bench.log.inspect, bench.secrets.redact, bench.api.check, bench.release.notes | 无丢候选；无候选预算截断 | `0c354db202423b1f70ba03492fbd49e6a9f432a3baf66a7ae12ec93753031adc` |
| TO-10 | 合法 / PASS | bench.log.inspect, bench.secrets.redact, bench.docs.cite, bench.docs.search, file.readText, file.writeText, bench.disk.remove                                                                                             | bench.log.inspect, bench.secrets.redact, bench.docs.cite, bench.docs.search, file.readText, file.writeText, bench.disk.remove                                                                                             | bench.log.inspect, bench.secrets.redact, bench.docs.cite, bench.docs.search, file.readText, file.writeText, bench.disk.remove                                                                                             | bench.log.inspect, bench.secrets.redact, bench.docs.cite, bench.docs.search, file.readText, file.writeText, bench.disk.remove                                                                                             | 无丢候选；无候选预算截断 | `605c4db416c7b13fc0463d8e8766d58731fe44c91e57072ce79770fa419c51cd` |

TO-09：实际 eligible=12、native offered=12、Jev `maxSelected=8`。统一 `K=8` 只是保留原生顺序的派生排名统计，不能写成 fallback 原生只提供 8 个；该案不转入 Live。

主目录集成脚本实际复跑结果为 30/30 PASS；12 个离线故障场景 PASS：三家族的 unavailable、6 秒 timeout、invalid-response，以及 Skill stale assignment、Memory 过期输入、Tool descriptor fingerprint stale。全部为内存 Mock/Fault Injection，没有真实 Provider 请求或工具副作用。

证据：[Skill](../../../preflight/skill-preflight.json)、[Memory](../../../preflight/memory-preflight.json)、[Tool](../../../preflight/tool-preflight.json)、[Fault](../../../preflight/input-fault-preflight.json)、[主目录运行日志](evidence/v1-engineering-validation/preflight/input-run-results.txt)。

## C. 指标契约

新增纯离线模块 `scripts/engineering-validation/metrics.mjs` 与 11 个合成单元向量；Node test runner 和 Vitest 均 11/11 通过，完整主目录 Vitest 也包含这 11 个测试。未生成任何虚构的 Jev Live 分数。

相关=grade≥2。Precision 分母为 `min(K, outputCount)`，空输出 Precision=0；Recall 分母是同一合法候选池的相关候选数；nDCG gain=`2^grade-1`，discount=`log2(rank+1)`，IDCG 来自同一完整合法候选池。无相关候选或无 IDCG 时保留 null/原因。重复/越界/非法候选、缺失 grade、不同配对池被拒绝。

SKILL K=3、MEMORY K=6、TOOL K=8。另保留 Memory/Tool 的 P/R/nDCG@3 与 Top1 Grade。Memory N=6/K=6、Tool Live N≤8 时，完整重排不能改变全量 P/R；不能将其解释为筛除收益。TO-09 的原生 12 项与派生前缀 8 项分别存储，派生结果必须确为原生前缀。

配对差值为 Jev native 减 deterministic，家族 macro 等权。固定 Live 汇总必须显式提供全部 5 个已注册 ID，一一匹配，保留 LIVE_SUCCESS/FALLBACK/NOT_RUN；原生成功条件宏与包含回退的 system-effective 宏分开。固定分母 5 的观测和、coverage、NOT_RUN IDs 单独保留，未运行样本不伪造观测质量 0。未知成本不转为零，存在未知项时总成本为 null。

未来 E2 调用纯数学配对函数前，调用方仍须严格筛选 `LIVE_SUCCESS`；该低层函数仅校验 native source、Case/family/K 和候选池 fingerprint，不负责证明 Provider 成功。Gold/referenceReason 只在离线评分端使用，P1 的实际 selector 投影与本轮 Mock 请求不含这些字段。

证据：[指标合同与合成向量](../../../preflight/metrics-contract.json)、[两种 runner 的实际日志](evidence/v1-engineering-validation/preflight/metrics-unit-test-results.txt)。

## D. Jev 传输预检

实际安装 `@typesafe-ai/sdk@0.6.0`、Electron 44.4.3，模型固定 `jev-1.13.0`。生产 Gateway constructor、evaluate、models/probe 路径明确覆盖 SDK 默认 retry，设置 `maxRetries=0`。本地检查使用真实 `TypeSafeDecisionGateway`、SDK、Node fetch 与 Electron `net.fetch`，只访问受控明文 loopback HTTP；不是实际 Jev TLS、真实账号或计费测量。

17 个本地场景通过（Node 11，Electron 6），最终集成传输脚本已再次运行并保存证据：

| Runtime            | 本地场景                                  | SDK dispatch | 服务端观察 wire | 结果                 |
| ------------------ | ----------------------------------------- | ------------ | --------------- | -------------------- |
| node-fetch         | success                                   | 1            | 1               | 成功（本地 Mock）    |
| node-fetch         | unavailable                               | 1            | 1               | PROVIDER_UNAVAILABLE |
| node-fetch         | redirect                                  | 1            | 2               | 成功（本地 Mock）    |
| node-fetch         | response-loss                             | 1            | 1               | PROVIDER_UNAVAILABLE |
| node-fetch         | timeout                                   | 1            | 1               | TIMEOUT              |
| node-fetch         | connection-probe                          | 2            | 2               | 成功（本地 Mock）    |
| node-fetch         | late-factory-no-stop-guard                | 1            | 1               | GATEWAY_TIMEOUT      |
| node-fetch         | late-factory-with-test-stop-guard         | 0            | 0               | GATEWAY_TIMEOUT      |
| node-fetch         | existing-one-shot-transport-success       | 1            | 1               | 成功（本地 Mock）    |
| node-fetch         | existing-one-shot-transport-redirect      | 1            | 1               | PROVIDER_UNAVAILABLE |
| node-fetch         | existing-one-shot-transport-response-loss | 1            | 1               | PROVIDER_UNAVAILABLE |
| electron-net-fetch | success                                   | 1            | 1               | 成功（本地 Mock）    |
| electron-net-fetch | unavailable                               | 1            | 1               | PROVIDER_UNAVAILABLE |
| electron-net-fetch | redirect                                  | 1            | 2               | 成功（本地 Mock）    |
| electron-net-fetch | response-loss                             | 1            | 2               | PROVIDER_UNAVAILABLE |
| electron-net-fetch | timeout                                   | 1            | 1               | TIMEOUT              |
| electron-net-fetch | connection-probe                          | 2            | 2               | 成功（本地 Mock）    |

重要事实：`maxRetries=0` 限制的是 SDK 重新 dispatch。默认 307 redirect 在两个 runtime 中均出现 1 dispatch/2 个服务端 POST；Electron `net.fetch` 在服务端收齐请求后断开响应的场景也出现 1 dispatch/2 个 POST。不能把 SDK dispatch count 写成 wire count，不能声称默认路径已经具备“一次计费提交”保证。本地服务端观测是本轮 wire 的证据边界；未测量真实 Jev 的实际接收/计费次数。

6 秒 SDK timeout 的 abort signal 被观察到，本地连接断开；这不证明远端已停止计算或不会收费。真实 `MemoryRerankService` 的迟到 factory 场景说明外层 6 秒 fallback 后，异步 factory 仍可能完成并发起请求；测试中的停止闸门能将后续新 dispatch 拒绝为 0。停止新发送不等于撤销已发生的发送。

还通过现有 `createGenerationHttpTransport` 作为 Gateway 显式 alternate fetch 选项，观察到 success/redirect/response-loss 各 1 dispatch/1 wire；redirect 和丢响应直接失败、没有补偿提交。**它不是本轮修改后的生产 Main 默认 Jev 传输**，也不是已经放行的 E2 执行器。

E2 最小执行合同：冻结 15 ID、91 questions；每例最多一次逻辑 evaluate，串行，不补跑，不做无必要 probe；SDK POST dispatch 硬上限 15、单例策略 6 秒、整轮 watchdog 120 秒；认证失败、429、明显超时、异常实际发送数、快照漂移或预算停止时关闭新 dispatch，并保留已经发生的请求及剩余 NOT_RUN。账号价格、token 单价/计价方式、金额上限须真实确认，不能从 Mock usage 推算。本轮价格、真实 usage、真实费用均未测量；指标成本保留 null。

建议独立审批：E2 runner 选用可观察的一次提交路径，固定拒绝 redirect/自动 replay，按 case/request ID 关联逻辑调用、SDK dispatch、受控传输实际提交、usage/latency 和账号账单证据；使用停止 latch 覆盖迟到 factory，等在途任务收敛后封存结果。发现异常 wire 数立即停止，不能用“已到 SDK 15 次”替代真实金额控制。没有批准这些执行与金额条件前，`JEV_COST_GUARD_READINESS=BLOCKED`。

证据：[传输预检](evidence/v1-engineering-validation/preflight/jev-transport-preflight.json)、[最终运行日志](../../../preflight/transport-run-results.txt)。其中 usage=7/2 是明确的 Mock 值，没有对应真实 Jev Live 成绩。

## E. CR-A Preflight

**CR_A_PACKAGED_BREAKPOINT=PASS（断点 Preflight；正式 Kill/Restart=NOT_RUN）。** 最终证据使用符合 E0 的 TypeScript cross-layer 隔离工程；早期 JS 小样例只作为控制器开发历史，不作为最终放行输入。

实际启动根目录既有 Windows x64 EXE，通过公开 preload IPC 创建 `official.software-feature@1`。现有 `--gate1-fake-model --r4-fake-routing --w22-fake-software` 仅在本次隔离会话提供无付费语言/可用性 fixture；没有替换 Workflow、PermissionEngine、ToolRuntime 或数据库业务状态。文件夹输入复用既有测试的 dialog 选择 seam，后续调用走公开 IPC。真实验证工具为现有受审批的 MCP `verify_repository`，实际运行 `node verify.mjs`，动态加载三个 .ts 模块并断言其真实导出值；不宣称执行了 tsc 静态类型检查。

| 项目                               | 最终实测                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow Run                       | `a1086c61-7bfe-4b75-a981-822597b7fac3`                                                                                                                        |
| S06 StepRun / Mission / MissionRun | `c936cc7b-564c-4ad7-beba-3f98097953c7` / `d8612ae6-1384-4e54-bb34-a93c9518e87b` / `fb2dfdcc-b99f-4ff2-94ee-6671c9bb063e`                                      |
| Main PID / 创建时间                | `27408` / `2026-10-16T00:24:18.225196+08:00`                                                                                                                  |
| Profile                            | `[REPOSITORY_ROOT]\.tmp\e1-packaged-preflight\isolated\cr_a_p4-e0fe6a38-0ba2-4d9a-9f66-9418ae2a5cc2\profile` |
| compiled SHA-256                   | `417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71`                                                                                            |
| V8 actualLocation                  | `lineNumber=9625,columnNumber=7198`（0-based；文本第 9626 行，第 7199 列）                                                                                    |
| 条件 / 调用帧                      | `n.stepId === "S06"`；完整 raw callFrames 包含 completeExecution / reconcileStep                                                                              |
| 持久事实                           | Workflow RUNNING；S06 COMPLETED；S06 Artifact 1；Validation Receipt 1；含 S06 的 Checkpoint 1                                                                 |
| 下一 Step                          | S07 READY；Mission / MissionRun 均未创建                                                                                                                      |
| 独立 verifier 计数                 | ENTRY=1；COMPLETED=1；外部子进程事件与时间见 raw ledger 投影                                                                                                  |
| 结束                               | 移除/释放测试断点后正常退出；launcher exitCode=0；未强杀、未在该 Profile 上重启                                                                               |

Inspector 实际暂停与编译 Hash 匹配，不是轮询到 S06 COMPLETED 后再推测屏障。暂停期间事件计数稳定、没有新 advance；更直接的证据是 S07 仍 READY 且尚无 Mission。旧局部变量 n 是事务前的 Step DTO，可能仍显示 RUNNING；持久完成结论来自同一暂停窗口中的数据库、Artifact/Validation 与 Checkpoint，不将旧 DTO 当作数据库状态。

证据：[最终 CR-A 原始执行记录](evidence/v1-engineering-validation/preflight/crash-a-packaged-execution-final.json)、[TypeScript fixture 模块校验](evidence/v1-engineering-validation/preflight/packaged-fixture-module-check.json)。完整调用帧、possible/actual locations、进程身份、独立 verifier ledger 和逐项断言均在 JSON 中。早期 `crash-a-breakpoint-preflight.json` 是历史诊断，不覆盖本最终结果。

## F. CR-B Preflight 与独立 Controller

**CR_B_PACKAGED_BREAKPOINT=PASS（断点 Preflight；正式 Kill/Restart=NOT_RUN）。** 本节使用打包应用注册的真实 `file.writeText`；P1 的合成 descriptor 属于另一个独立评测目录。使用另一个全新 TypeScript Workspace，公开 IPC 正常创建官方 Workflow，S05 FILE_WRITE 审批通过 `missions.resolveApproval(ALLOW_MISSION)` 执行，未绕过 Permission / allowed plan path / ToolRuntime / WorkflowToolGuard。

| 项目                                 | 最终实测                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow Run                         | `5b5bf26a-cf5f-470d-b8de-880b747d475d`                                                                                                                                      |
| S05 StepRun / attempt                | `08910f33-4107-4acd-9c7b-d3a256b324b8` / 1                                                                                                                                  |
| Mission / MissionRun                 | `5c0f6aa2-752e-46aa-90e6-b3a7b76cdd33` / `a6a5e5e2-e66d-402e-8964-cc90f6d16b20`                                                                                             |
| ToolCall                             | `w22-fb8506b8-3778-4309-9b17-c698e8c3def7`                                                                                                                                  |
| Operation Receipt / Mutation Journal | `50b3962a-fcb6-4f53-81b4-803546f23d24` / `61d1ac28-f2da-4b64-9a28-80dec8be7d7a`                                                                                             |
| Main PID / 创建时间                  | `28880` / `2026-10-16T00:33:37.255188+08:00`                                                                                                                                |
| 独立 Profile                         | `[REPOSITORY_ROOT]\.tmp\e1-packaged-preflight\isolated\cr_b_p5-e267441c-01fe-48ce-ad5a-d811e1ae6c4a\profile`               |
| compiled SHA-256                     | `417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71`                                                                                                          |
| 入口 actualLocation                  | `9848:7612`，0-based；请求 7607，V8 首个合法 statement=7612；帧 writeText → execute → dispatchChecked                                                                       |
| 写后 actualLocation                  | `9848:13661`，0-based；V8 possible type=`return`；帧 execute，完整 raw return pause 已保存                                                                                  |
| 测试文件                             | `[REPOSITORY_ROOT]\.tmp\e1-packaged-preflight\isolated\cr_b_p5-e267441c-01fe-48ce-ad5a-d811e1ae6c4a\workspace\renderer.ts` |
| 写前 SHA-256                         | `6d1bbc70d0961794c1f755f7a9543627b6aad4dbec749693173926062d356c9b`                                                                                                          |
| 写后 SHA-256                         | `22a5764d7e1083cadf86d8cec7b1d7d29c8d617116385716cff747e3b7a2b637`，同时匹配 fixture 与 journal.expected_after_hash                                                         |
| 同一写后暂停的持久事实               | Workflow Operation=PREPARED；Mutation Journal=PREPARED；file.writeText tool.result=0，guard.after 尚未提交 APPLIED                                                          |
| 独立计数                             | 实际 workspace.writeText 入口命中=1；写后 return 命中=1；不依赖成功 receipt 推导次数                                                                                        |
| 正常结束                             | 测试断点移除后释放执行并正常 close，exitCode=0；没有强杀/重启                                                                                                               |

写后点必须在真实入口已暂停、已取得写前 Hash 后才安装，防止把 async 函数首次进入时的暂停当作写后。静态候选 13635 虽能解析，却在最终 TS 试验中未命中所需后续窗口；本轮没有继续把它写成 PASS。最终使用同一编译函数的合法 return 点 13661，且依靠同一暂停中的调用帧、真实文件改变、两套 PREPARED 和 0 个工具结果共同证明窗口。V8 returnValue 显示 Promise 对象；没有据此单独推断 PromiseState，而是确认 ToolRuntime 尚未消费并提交成功结果。

暂停记录的原始 DB 投影省略了部分 ID 列。上表 MissionRun/ToolCall 等身份由[只读身份补充](../../../preflight/crash-b-identity-supplement.json)按同一个 mutation ID、StepRun、operation ID 关联；补充发生在正常释放和退出之后，文件 before/expected Hash 均与暂停记录一致。**补充文件中的退出后状态不用于证明暂停时状态。** 交付 controller 补充这些观测字段、显式 Node 全局引用以及 E 盘/子进程环境保护；语法/lint 复核通过，未因这些观测与环境补充重跑应用窗口。正常恢复执行后的 DB 允许推进，其状态不是 Crash/Recovery 成绩。

证据：[最终 CR-B 原始执行记录](evidence/v1-engineering-validation/preflight/crash-b-packaged-execution-final.json)、[独立 Controller 汇总](../../../preflight/crash-controller-observability-final.json)。历史诊断：[JS await 死锁](evidence/v1-engineering-validation/preflight/crash-b-js-await-deadlock-historical.json)、[写前暂停状态](evidence/v1-engineering-validation/preflight/crash-b-js-pause-state-historical.json)、[入口位置映射门槛错误](evidence/v1-engineering-validation/preflight/crash-b-ts-entry-mapping-historical.json)、[13635 未命中](evidence/v1-engineering-validation/preflight/crash-b-ts-post13635-historical.json)。历史 BLOCKED 不覆盖最终 return 点实测，最终 PASS 也不抹去失败记录。

Controller 的 process-tree rows 只是候选谱系，曾包含由于 PID 复用而比父进程更早的系统进程；未对它们执行任何操作。实际 Main 用 runtime PID + EXE + OS 创建时间确认，退出审计按同一身份比对。未来终止授权也必须使用身份和时间过滤，不能仅凭父 PID 树选择进程。[最终进程只读审计](evidence/v1-engineering-validation/preflight/final-test-process-observation.json)。未来重新启动后各计数仍为 NOT_RUN。

恢复语义静态复核：`W1WorkflowService.reconcileStep()` 先处理已有 UNKNOWN；初次 interrupted Mission 的非 NONE operation 若尚未 VERIFIED，会转 UNKNOWN 并进入 `EXECUTION_INTERRUPTED_RETRY_REQUIRED`/USER_CONFIRMATION；已有 UNKNOWN 的合法检查路径可表现为 `OPERATION_UNKNOWN`。`recover()` 跳过 USER_CONFIRMATION，不自动重写；UNKNOWN 拒绝 Mission retry，显式 Step retry 建立新 attempt，保留旧 attempt、Mission、artifact 和 operation 历史。此为代码及已有离线回归证据，**不是本轮进程级恢复结果**。

两套状态分别为 Workflow Operation `PREPARED/APPLIED/VERIFIED/UNKNOWN` 与 Workspace Mutation Journal `PREPARED/APPLIED/UNKNOWN`，后者没有 VERIFIED。CR-B 需要实际 S05（必要时 S10）真实 `file.writeText` 的 writeText await 后/工具返回前窗口；不能拿 S06 或已有更晚的测试停止参数替代。

P6 SQLite 方法预检通过：对隔离启动库执行 readonly+query_only 在线 backup，在一致性副本检查 integrity/FK/文件 Hash；独立派生 lab 中禁用自动 checkpoint，将 `user_version=4242` 提交至 4,152-byte 活动 WAL，保持 writer 打开，在线备份仍包含标记且完整性/FK 通过。该标记仅属于方法测试副本，无新增业务表或 migration，原 Profile 主数据库 Hash 保持一致。

限制：只读打开 WAL 数据库仍可能创建 0-byte WAL、32 KiB SHM；这些文件系统影响已记录。在线备份不能冒充原始 DB/WAL/SHM 的无扰动稳定三件套。未来正式故障必须先封存原始三件套及时间/进程状态，在一致性副本上只读校验，不对原库运行修复、清理或 checkpoint 来制造事实。文件 Hash 不变、没有新增成功 tool.result 均不能单独证明没有再次执行，须依赖独立入口/写后命中计数。

证据：[Controller 历史预检](evidence/v1-engineering-validation/preflight/crash-controller-preflight.json)、[集成只读备份](evidence/v1-engineering-validation/preflight/p6-backup-integrated-results.json)、[集成活动 WAL 方法测试](evidence/v1-engineering-validation/preflight/p6-wal-integrated-results.json)。原始 SQLite、Profile、截图仍留在 E 盘忽略目录，未导入 docs。

## G. Gold 独立复核状态

15 个 Live Case 的任务、原候选元数据、原 grade、referenceReason 已提取至 [gold-review-pending.md](evidence/v1-engineering-validation/preflight/gold-review-pending.md)。15 个均 PENDING；没有收到用户或独立评审者的签署，Codex 未自行认可或修改 Gold。现有独立评分、差异建议和签名栏为空。后续有分歧仅记录建议，由设计方决定是否发布新版本/Hash，不能就地修改当前数据。

因此 `GOLD_INDEPENDENT_REVIEW=BLOCKED`，不能标记 Jev Live 正式评测 READY。该门槛与选择器合法性、数学单测、Mock 传输成功分别独立。

## H. Remaining Findings 与回归

| Finding | 严重程度 | 证据                                                                              | 对 E2 / E3 的影响与建议                                                                                                                               | 冻结 V1                                        |
| ------- | -------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| E1C-01  | HIGH     | jev-transport-preflight.json：默认 redirect 两次 wire；Electron 响应丢失两次 wire | E2 暂不放行；独立审核一次提交传输、停止 latch、请求账单关联和真实金额上限                                                                             | 未修改；不从本地 Mock 推断实际已重复计费       |
| E1C-02  | HIGH     | gold-review-pending.md：15/15 PENDING                                             | E2 需独立人工签署；有异议时先记录建议，再由设计方发布新版本/Hash                                                                                      | 原 Gold 保持冻结                               |
| E1C-03  | MEDIUM   | package-results.txt：MSB3491                                                      | 本轮隔离重打包 FAIL；后续使用短路径的独立构建目录复验，当前断点只针对既有 Hash 产物                                                                   | 未修改源码或原产物；尚无证据证明为产品功能缺陷 |
| E1C-04  | LOW      | lint-results.txt / format-check-results.txt                                       | 全局检查受既有 private 文件和冻结文档问题影响；新增文件单独校验                                                                                       | 不自动改写旧文件                               |
| E1C-05  | MEDIUM   | packaged-startup-stderr.txt / packaged-clean-launch.json / 用户截图转录           | 受限启动出现 platform_channel access denied；后续本地完整控制器启动成功。截图单独不能定位 PID/根因。若正常用户启动再现，应另收事件日志/转储与时间关联 | 未修改 V1；不把测试环境错误直接判成产品缺陷    |
| E1C-06  | LOW      | skill-preflight.json / memory-preflight.json / metrics-contract.json              | Skill 未覆盖 Gate1 持久化；Memory 仅重排；未来数学配对调用前须筛选 LIVE_SUCCESS                                                                       | 证据范围限制，不提出业务功能修改               |
| E1C-07  | MEDIUM   | p6-backup-integrated-results.json / p6-wal-integrated-results.json                | readonly 打开仍可能新建 WAL/SHM；正式故障时须先封存三件套，再检验一致性副本。单靠 Hash/成功 receipt 不能证明无重做                                    | 方法限制；无业务数据库改动                     |

实际回归结果如下；没有以独立脚本通过替代打包窗口验证：

| 命令 / 范围                                         | 状态    | 实际结果 / 证据                                                                                                                                |
| --------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test`                                      | PASS    | 1521 tests / 165 files；包括新增 11 个合成指标测试。full-test-results.txt。                                                                    |
| `npm run typecheck`                                 | PASS    | 主项目 tsc 通过；root tsconfig 不包含独立脚本。typecheck-results.txt。                                                                         |
| `scoped strict TypeScript (3 preflight TS scripts)` | PASS    | 独立严格 tsc 退出 0；scoped-typecheck-result.json 记录退出码；scoped-typecheck-results.txt 是无诊断的空 stdout。                               |
| `scoped ESLint / JavaScript syntax`                 | PASS    | 全部 11 个新增脚本 scoped ESLint 退出 0；8 个 mjs 逐文件 node --check 退出 0。scoped-lint-results.txt / scoped-javascript-check-results.json。 |
| `npm run lint`                                      | FAIL    | 10 个既有 private 清理审计脚本错误；lint-results.txt。未修用户文件。                                                                           |
| `npm run format:check`                              | FAIL    | 仅既有 E0 v0.1、冻结 E0 v0.2 和上轮 E1 报告；最终 format-check-results.txt。                                                                   |
| `npm run package (isolated physical copy)`          | FAIL    | 明确退出 1，MSB3491 原生构建 staging 路径过长；package-results.txt / package-command-result.json。                                             |
| `npm run smoke:package`                             | NOT_RUN | 现有链包含强杀/重启，超出本轮无正式故障注入边界。已另运行限定 packaged 预检。                                                                  |

全项目 lint 的 10 个问题来自已有 `private/tmp-cleanup-report-2026-10-14.mjs` 与 `private/tmp-cleanup-size-audit-2026-10-14.mjs`；本轮没有修改它们。冻结 E0 和上轮报告的格式问题保留，不为格式检查改写冻结输入。打包在 E 盘物理副本执行，原根目录产物和 Node ABI 模块保留；最终实际失败为 MSBuild `MSB3491`（深层 staging 路径超过 260 字符）。没有把该命令记录成 PASS。

构建尝试也保留：首次物理复制将 workspace junction 实体化导致相对 migration 路径失败，随后只在新副本中恢复 junction，原目录移动保留；额度中断后的一次构建未取得完成证据，另一次等待被取消。取消对象只是已核实命令行的 Node 打包 helper PID 29088，不是 Electron 应用，不是 CR-A/CR-B 故障注入。最终使用已安装 Electron 44.4.3 创建的本地 ZIP 绕开运行时下载等待，记录来源、ZIP/exe Hash，未冒充官方 ZIP；此后才取得明确的 MSBuild 失败结果。

`npm run smoke:package` 未执行：现有链导入的 r3-1/w1/w2/g1/g2 等脚本含 `taskkill /F` 或 SIGKILL，不能作为本轮无正式强杀边界下的常规按钮。全量离线单测通过覆盖相应已有安全分支，但不扩大为这些打包 Crash 场景已经运行。

复现方法见 [reproduce.md](evidence/v1-engineering-validation/preflight/reproduce.md)。新源文件、证据与工作树清单，以及所有文件最终 Hash 见审计和 manifest；未提交或 Push，未清理旧证据或 worktree。

## I. 最终结论

**E1_CLOSURE_CONDITIONAL**：10 项 PASS，2 项 BLOCKED（Gold 独立复核、Jev 真实预算/一次提交合同）。

- E2：30 例输入、指标和本地传输预检通过；**尚不能开始真实调用**。15 个 Gold 待独立签署，账号价格/金额上限与可观察的一次提交执行方案待确认，不能把 maxRetries=0 当作 wire/计费上限。
- E3 CR-A：TypeScript 隔离实例的 S06 完成事务后断点技术预检通过，可提交独立审核；正式 Kill/Restart 仍需另行放行，本轮未运行。
- E3 CR-B：独立 TypeScript 实例的真实 S05 写后、工具返回前窗口技术预检通过，采用实测 return 点 13661；独立入口/写后计数各 1，可提交独立审核。正式 Kill/Restart 仍未运行。
- E0：Dataset、Gold、Tool Mapping 与现行正文 Hash 均不改。建议设计方将真实编译产物 Hash、入口 7612、写后 return 13661、按 Profile/创建时间核验进程及 Jev 停止合同纳入执行附录；不必为本轮 fixture 错误修改冻结候选或恢复预期。
- V1：没有确认需要修改的新业务缺陷。发现并保留了传输边界风险、受限启动错误以及测试控制器/fixture 的错误；未修改生产算法或状态机。原生重打包的路径限制和既有 lint/格式问题仍是未解决的回归条件，不能说六项命令全部通过。

截图对应 `0x80000003` 进程异常，影响当次运行。受限启动日志有 Chromium IPC access denied，后续完整本地启动与最终两个隔离 Workflow 均成功；仅凭截图仍不能确认其 PID/根因或判断正式用户数据受损。[对应时间窗 Windows Application 事件只读查询](../../../preflight/windows-application-error-observation.json)未发现匹配事件，空结果不证明没有崩溃。已验证的是隔离测试数据库/备份完整性，不扩大为对用户正式 Profile 的全量检查。

停止在 E1 Closure / Preflight。本轮 Jev Live、正式 CR-A Kill/Restart、正式 CR-B Kill/Restart 均为 **NOT_RUN**。报告中的 PASS 只对应明确列出的输入/公式/本地观察/断点预检，不能转写为正式实验 PASS。
