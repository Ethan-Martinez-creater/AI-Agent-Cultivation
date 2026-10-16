> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `ba7c04443a205548b240f9c9927b275dee3e88ecf9d99d50e6f082619771bf57`. See the publication derivation map for both hashes and removed field categories.

# Gold 独立复核待办

状态：**BLOCKED — 尚无用户或独立评审者签署确认。**

此表从已验证的 E0 v0.2 原样提取 15 个 Live Case，仅供人工复核；Codex 未认可、修改或替换原 Gold。

Dataset SHA-256：`ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602`

| Case  | 当前确认状态 | 评审者 | 确认时间 | 差异建议 |
| ----- | ------------ | ------ | -------- | -------- |
| SK-02 | PENDING      | 待填写 | 待填写   | 待填写   |
| SK-03 | PENDING      | 待填写 | 待填写   | 待填写   |
| SK-05 | PENDING      | 待填写 | 待填写   | 待填写   |
| SK-08 | PENDING      | 待填写 | 待填写   | 待填写   |
| SK-10 | PENDING      | 待填写 | 待填写   | 待填写   |
| ME-02 | PENDING      | 待填写 | 待填写   | 待填写   |
| ME-03 | PENDING      | 待填写 | 待填写   | 待填写   |
| ME-05 | PENDING      | 待填写 | 待填写   | 待填写   |
| ME-08 | PENDING      | 待填写 | 待填写   | 待填写   |
| ME-10 | PENDING      | 待填写 | 待填写   | 待填写   |
| TO-02 | PENDING      | 待填写 | 待填写   | 待填写   |
| TO-03 | PENDING      | 待填写 | 待填写   | 待填写   |
| TO-05 | PENDING      | 待填写 | 待填写   | 待填写   |
| TO-08 | PENDING      | 待填写 | 待填写   | 待填写   |
| TO-10 | PENDING      | 待填写 | 待填写   | 待填写   |

## SK-02

任务：识别经营数据里突然偏离常态的月份，并画出变化趋势。

原设计参考理由：异常检测和趋势图两个能力都必要；语言中未直接出现统计技能名。

| 候选 ID   | 原始候选元数据                                                                                                | 原 Gold | 独立评分建议 | 确认/分歧 |
| --------- | ------------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| csv-clean | {"name":"CSV 数据清洗","description":"规范日期、缺失值、重复行并输出清洗报告","tags":["CSV","data-cleaning"]} |       1 | 待填写       | PENDING   |
| anomaly   | {"name":"统计异常识别","description":"通过稳健统计量定位离群点与突变","tags":["statistics","anomaly"]}        |       3 | 待填写       | PENDING   |
| chart     | {"name":"趋势可视化","description":"将时间序列数据绘制成清晰的图表","tags":["visualization","chart"]}         |       3 | 待填写       | PENDING   |
| sql-join  | {"name":"SQL 查询与关联","description":"使用关系型查询进行过滤、聚合及表连接","tags":["SQL","database"]}      |       1 | 待填写       | PENDING   |
| perf      | {"name":"性能瓶颈剖析","description":"定位慢查询、网络延迟和资源热点","tags":["performance","profiling"]}     |       0 | 待填写       | PENDING   |
| notes     | {"name":"版本发布说明","description":"根据已验证变更撰写发布文档","tags":["release","documentation"]}         |       0 | 待填写       | PENDING   |

## SK-03

任务：接口偶发返回 502，排查请求链路并确认是否暴露了访问令牌。

原设计参考理由：日志诊断与凭据审查直接相关；API 契约校验可辅助。

| 候选 ID    | 原始候选元数据                                                                                             | 原 Gold | 独立评分建议 | 确认/分歧 |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| log-debug  | {"name":"日志根因分析","description":"从调用轨迹和错误日志定位故障来源","tags":["logging","debugging"]}    |       3 | 待填写       | PENDING   |
| security   | {"name":"安全边界审查","description":"检查权限、凭据与输入校验风险","tags":["security","permission"]}      |       3 | 待填写       | PENDING   |
| api-design | {"name":"API 契约设计","description":"定义 HTTP API 输入输出与错误协议","tags":["API","contract"]}         |       2 | 待填写       | PENDING   |
| unit-test  | {"name":"单元测试设计","description":"编写可重复的边界与回归单元测试","tags":["testing","test"]}           |       1 | 待填写       | PENDING   |
| markdown   | {"name":"Markdown 排版","description":"整理标题、列表、代码块和文档格式","tags":["markdown","formatting"]} |       0 | 待填写       | PENDING   |
| translate  | {"name":"双语翻译","description":"中英双向翻译并保持术语一致","tags":["translation","language"]}           |       0 | 待填写       | PENDING   |

## SK-05

任务：将研究访谈笔记整理成有来源依据的证据表，禁止编造引用。

原设计参考理由：证据链优先，格式和隐私处理辅助；翻译不是需求。

| 候选 ID   | 原始候选元数据                                                                                             | 原 Gold | 独立评分建议 | 确认/分歧 |
| --------- | ---------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| research  | {"name":"文献证据整理","description":"组织研究来源、主张与证据映射","tags":["research","evidence"]}        |       3 | 待填写       | PENDING   |
| markdown  | {"name":"Markdown 排版","description":"整理标题、列表、代码块和文档格式","tags":["markdown","formatting"]} |       2 | 待填写       | PENDING   |
| privacy   | {"name":"敏感数据脱敏","description":"删除或匿名化不应外发的敏感字段","tags":["privacy","redaction"]}      |       2 | 待填写       | PENDING   |
| benchmark | {"name":"实验评测设计","description":"定义对照组、指标、样本和误差分析","tags":["benchmark","evaluation"]} |       1 | 待填写       | PENDING   |
| translate | {"name":"双语翻译","description":"中英双向翻译并保持术语一致","tags":["translation","language"]}           |       0 | 待填写       | PENDING   |
| chart     | {"name":"趋势可视化","description":"将时间序列数据绘制成清晰的图表","tags":["visualization","chart"]}      |       0 | 待填写       | PENDING   |

## SK-08

任务：把内部排障日志作为面试材料，但所有密钥和客户标识必须移除。

原设计参考理由：脱敏与安全核对共同关键，根因分析仅间接相关。

| 候选 ID   | 原始候选元数据                                                                                             | 原 Gold | 独立评分建议 | 确认/分歧 |
| --------- | ---------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| privacy   | {"name":"敏感数据脱敏","description":"删除或匿名化不应外发的敏感字段","tags":["privacy","redaction"]}      |       3 | 待填写       | PENDING   |
| security  | {"name":"安全边界审查","description":"检查权限、凭据与输入校验风险","tags":["security","permission"]}      |       3 | 待填写       | PENDING   |
| log-debug | {"name":"日志根因分析","description":"从调用轨迹和错误日志定位故障来源","tags":["logging","debugging"]}    |       2 | 待填写       | PENDING   |
| markdown  | {"name":"Markdown 排版","description":"整理标题、列表、代码块和文档格式","tags":["markdown","formatting"]} |       1 | 待填写       | PENDING   |
| notes     | {"name":"版本发布说明","description":"根据已验证变更撰写发布文档","tags":["release","documentation"]}      |       0 | 待填写       | PENDING   |
| translate | {"name":"双语翻译","description":"中英双向翻译并保持术语一致","tags":["translation","language"]}           |       0 | 待填写       | PENDING   |

## SK-10

任务：用同一输入比较规则排序与语义排序，统计准确性和耗时，报告负面案例。

原设计参考理由：实验设计最重要，延迟/性能度量是主要辅助。

| 候选 ID    | 原始候选元数据                                                                                             | 原 Gold | 独立评分建议 | 确认/分歧 |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| benchmark  | {"name":"实验评测设计","description":"定义对照组、指标、样本和误差分析","tags":["benchmark","evaluation"]} |       3 | 待填写       | PENDING   |
| perf       | {"name":"性能瓶颈剖析","description":"定位慢查询、网络延迟和资源热点","tags":["performance","profiling"]}  |       2 | 待填写       | PENDING   |
| anomaly    | {"name":"统计异常识别","description":"通过稳健统计量定位离群点与突变","tags":["statistics","anomaly"]}     |       1 | 待填写       | PENDING   |
| research   | {"name":"文献证据整理","description":"组织研究来源、主张与证据映射","tags":["research","evidence"]}        |       1 | 待填写       | PENDING   |
| notes      | {"name":"版本发布说明","description":"根据已验证变更撰写发布文档","tags":["release","documentation"]}      |       1 | 待填写       | PENDING   |
| api-design | {"name":"API 契约设计","description":"定义 HTTP API 输入输出与错误协议","tags":["API","contract"]}         |       0 | 待填写       | PENDING   |

## ME-02

任务：按照此前销售报表的日期和空金额处理口径继续清洗新 CSV。

原设计参考理由：优先提取固定清洗政策，而不是曾经的单次案例。

| 候选 ID     | 原始候选元数据                                                                                      | 原 Gold | 独立评分建议 | 确认/分歧 |
| ----------- | --------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| csv-example | {"memoryType":"EPISODE","text":"某次销售日报发现重复订单，人工去重后生成对账文件。"}                |       2 | 待填写       | PENDING   |
| csv-policy  | {"memoryType":"PROCEDURE","text":"清洗销售 CSV 时，日期用 UTC，空金额保留并标记，不填零。"}         |       3 | 待填写       | PENDING   |
| ui-size     | {"memoryType":"FACT","text":"生成对话的验收宽度覆盖 1440、1180、900。"}                             |       0 | 待填写       | PENDING   |
| api-old     | {"memoryType":"EPISODE","text":"较早的内部草案计划将图片生成写成同步接口，已被更新的方案取代。"}    |       0 | 待填写       | PENDING   |
| privacy     | {"memoryType":"PROCEDURE","text":"对外发送诊断材料之前必须移除 API Key、签名 URL 和原始客户标识。"} |       1 | 待填写       | PENDING   |
| code-review | {"memoryType":"PROCEDURE","text":"软件功能开发先记录接受范围，再执行受限修改、测试和独立审查。"}    |       0 | 待填写       | PENDING   |

## ME-03

任务：向招聘面试官解释重启任务为何不自动再付费调用。

原设计参考理由：UNKNOWN 防重复发送与 Workflow 事实恢复共同相关。

| 候选 ID       | 原始候选元数据                                                                                   | 原 Gold | 独立评分建议 | 确认/分歧 |
| ------------- | ------------------------------------------------------------------------------------------------ | ------: | ------------ | --------- |
| outdated-cost | {"memoryType":"FACT","text":"上一轮预算草案写的是每个视频生成十秒，未与当前价格核对。"}          |       0 | 待填写       | PENDING   |
| recovery      | {"memoryType":"PROCEDURE","text":"外部付费提交结果为 UNKNOWN 时禁止自动重发 POST。"}             |       3 | 待填写       | PENDING   |
| workflow      | {"memoryType":"FACT","text":"Workflow 完成的 Step 保存 Checkpoint，重启时只对账已提交事实。"}    |       3 | 待填写       | PENDING   |
| jev-tool      | {"memoryType":"FACT","text":"Tool Shortlist 只能在确定性合法工具集合之内选择，不授予执行权限。"} |       1 | 待填写       | PENDING   |
| music         | {"memoryType":"EPISODE","text":"一次 Suno 基础生成返回两条 WAV，最终均注册为 Artifact。"}        |       0 | 待填写       | PENDING   |
| ui-theme      | {"memoryType":"PREFERENCE","text":"用户希望桌面应用保持低对比度界面，紧凑卡片展示。"}            |       0 | 待填写       | PENDING   |

## ME-05

任务：为视频验收制定最低预算策略，不要长视频，也不要公开密钥。

原设计参考理由：当前预算偏好与凭据脱敏优先；过时十秒预算不可当作事实。

| 候选 ID       | 原始候选元数据                                                                                      | 原 Gold | 独立评分建议 | 确认/分歧 |
| ------------- | --------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| outdated-cost | {"memoryType":"FACT","text":"上一轮预算草案写的是每个视频生成十秒，未与当前价格核对。"}             |       0 | 待填写       | PENDING   |
| cost          | {"memoryType":"PREFERENCE","text":"真实模型验收以尽可能低的预算进行，不生成长视频。"}               |       3 | 待填写       | PENDING   |
| privacy       | {"memoryType":"PROCEDURE","text":"对外发送诊断材料之前必须移除 API Key、签名 URL 和原始客户标识。"} |       3 | 待填写       | PENDING   |
| recovery      | {"memoryType":"PROCEDURE","text":"外部付费提交结果为 UNKNOWN 时禁止自动重发 POST。"}                |       2 | 待填写       | PENDING   |
| ui-theme      | {"memoryType":"PREFERENCE","text":"用户希望桌面应用保持低对比度界面，紧凑卡片展示。"}               |       0 | 待填写       | PENDING   |
| music         | {"memoryType":"EPISODE","text":"一次 Suno 基础生成返回两条 WAV，最终均注册为 Artifact。"}           |       0 | 待填写       | PENDING   |

## ME-08

任务：旧资料建议图片立即返回文件，应该按现行方案如何处理？

原设计参考理由：旧方案应识别为历史而非权威；现行异步优先。

| 候选 ID     | 原始候选元数据                                                                                   | 原 Gold | 独立评分建议 | 确认/分歧 |
| ----------- | ------------------------------------------------------------------------------------------------ | ------: | ------------ | --------- |
| api-old     | {"memoryType":"EPISODE","text":"较早的内部草案计划将图片生成写成同步接口，已被更新的方案取代。"} |       1 | 待填写       | PENDING   |
| api-current | {"memoryType":"FACT","text":"当前图片生成版本使用异步任务查询，完成后再获取输出。"}              |       3 | 待填写       | PENDING   |
| recovery    | {"memoryType":"PROCEDURE","text":"外部付费提交结果为 UNKNOWN 时禁止自动重发 POST。"}             |       2 | 待填写       | PENDING   |
| mimo        | {"memoryType":"FACT","text":"MiMo TTS 文字内容放在 assistant 消息中，音频从指定字段解析。"}      |       0 | 待填写       | PENDING   |
| csv-example | {"memoryType":"EPISODE","text":"某次销售日报发现重复订单，人工去重后生成对账文件。"}             |       0 | 待填写       | PENDING   |
| jev-shadow  | {"memoryType":"FACT","text":"Jev Shadow 模式只记录 Decision Receipt，不改变 Mission 控制流。"}   |       0 | 待填写       | PENDING   |

## ME-10

任务：当前协作任务读取共享媒体前，是否自动拥有本地 Workspace 文件权限？

原设计参考理由：分享不授予 FILE_READ；Workflow 和 Tool 边界提供上下文。

| 候选 ID     | 原始候选元数据                                                                                             | 原 Gold | 独立评分建议 | 确认/分歧 |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| permission  | {"memoryType":"FACT","text":"Workspace 文件读取需要 FILE_READ 审批，生成 Artifact 分享不自动授予此权限。"} |       3 | 待填写       | PENDING   |
| workflow    | {"memoryType":"FACT","text":"Workflow 完成的 Step 保存 Checkpoint，重启时只对账已提交事实。"}              |       2 | 待填写       | PENDING   |
| recovery    | {"memoryType":"PROCEDURE","text":"外部付费提交结果为 UNKNOWN 时禁止自动重发 POST。"}                       |       1 | 待填写       | PENDING   |
| api-current | {"memoryType":"FACT","text":"当前图片生成版本使用异步任务查询，完成后再获取输出。"}                        |       0 | 待填写       | PENDING   |
| jev-tool    | {"memoryType":"FACT","text":"Tool Shortlist 只能在确定性合法工具集合之内选择，不授予执行权限。"}           |       2 | 待填写       | PENDING   |
| ui-theme    | {"memoryType":"PREFERENCE","text":"用户希望桌面应用保持低对比度界面，紧凑卡片展示。"}                      |       0 | 待填写       | PENDING   |

## TO-02

任务：读取配置文件并找到指定字段，然后把找到的行显示给我，不要写回文件。

原设计参考理由：读取文本直接完成目标；用户禁止写回。

| 候选 ID            | 原始候选元数据                                                                                                                                                   | 原 Gold | 独立评分建议 | 确认/分歧 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| file.list          | {"name":"列目录","description":"列出当前 Workspace 允许访问目录中的条目","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                |       1 | 待填写       | PENDING   |
| file.readText      | {"name":"读取文本","description":"安全读取受限文本文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                                 |       3 | 待填写       | PENDING   |
| file.writeText     | {"name":"写入文本","description":"写入或覆盖 Workspace 允许路径中的文本文件","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"WORKSPACE_MUTATION"} |       0 | 待填写       | PENDING   |
| bench.docs.search  | {"name":"搜索文档","description":"在限定文档快照中查找相关段落","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                         |       1 | 待填写       | PENDING   |
| bench.log.inspect  | {"name":"日志检索","description":"检索指定任务的脱敏执行日志","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                           |       1 | 待填写       | PENDING   |
| bench.csv.validate | {"name":"表格校验","description":"仅检查 CSV 列、类型和缺失数据，不改写原文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}          |       0 | 待填写       | PENDING   |

## TO-03

任务：校验月度 CSV 各列类型，再计算月度订单总额，不改变源数据。

原设计参考理由：表格校验与统计汇总两个工具必要，均只读。

| 候选 ID             | 原始候选元数据                                                                                                                                                   | 原 Gold | 独立评分建议 | 确认/分歧 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| file.readText       | {"name":"读取文本","description":"安全读取受限文本文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                                 |       2 | 待填写       | PENDING   |
| bench.csv.validate  | {"name":"表格校验","description":"仅检查 CSV 列、类型和缺失数据，不改写原文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}          |       3 | 待填写       | PENDING   |
| bench.csv.aggregate | {"name":"统计汇总","description":"只读方式计算按月汇总数据","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                             |       3 | 待填写       | PENDING   |
| file.writeText      | {"name":"写入文本","description":"写入或覆盖 Workspace 允许路径中的文本文件","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"WORKSPACE_MUTATION"} |       0 | 待填写       | PENDING   |
| bench.chart.render  | {"name":"绘图输出","description":"根据已验证数据生成可视化图表文件","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"FILE_OUTPUT"}                 |       0 | 待填写       | PENDING   |
| bench.stats.anomaly | {"name":"异常检测","description":"读取已清洗数据并标记异常值","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                           |       1 | 待填写       | PENDING   |

## TO-05

任务：检查故障日志并整理可以安全分享的排查证据，不能泄露密钥。

原设计参考理由：日志读取和脱敏一起构成任务；任意写入或删除不是安全捷径。

| 候选 ID              | 原始候选元数据                                                                                                                                                   | 原 Gold | 独立评分建议 | 确认/分歧 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| bench.log.inspect    | {"name":"日志检索","description":"检索指定任务的脱敏执行日志","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                           |       3 | 待填写       | PENDING   |
| bench.secrets.redact | {"name":"证据脱敏","description":"在隔离副本中清除可能泄露的凭据字段","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"FILE_OUTPUT"}               |       3 | 待填写       | PENDING   |
| file.readText        | {"name":"读取文本","description":"安全读取受限文本文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                                 |       1 | 待填写       | PENDING   |
| bench.docs.search    | {"name":"搜索文档","description":"在限定文档快照中查找相关段落","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                         |       1 | 待填写       | PENDING   |
| file.writeText       | {"name":"写入文本","description":"写入或覆盖 Workspace 允许路径中的文本文件","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"WORKSPACE_MUTATION"} |       0 | 待填写       | PENDING   |
| bench.disk.remove    | {"name":"删除文件","description":"删除 Workspace 中的文件，存在不可逆风险","capabilityHint":"FILE_WRITE","riskHint":"HIGH","effectHint":"WORKSPACE_MUTATION"}    |       0 | 待填写       | PENDING   |

## TO-08

任务：从已清洗的数据中找出异常订单并画一张离群值可视化图表。

原设计参考理由：异常检测与绘图为互补工具。

| 候选 ID             | 原始候选元数据                                                                                                                                          | 原 Gold | 独立评分建议 | 确认/分歧 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| bench.stats.anomaly | {"name":"异常检测","description":"读取已清洗数据并标记异常值","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                  |       3 | 待填写       | PENDING   |
| bench.chart.render  | {"name":"绘图输出","description":"根据已验证数据生成可视化图表文件","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"FILE_OUTPUT"}        |       3 | 待填写       | PENDING   |
| bench.csv.aggregate | {"name":"统计汇总","description":"只读方式计算按月汇总数据","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                    |       1 | 待填写       | PENDING   |
| bench.csv.validate  | {"name":"表格校验","description":"仅检查 CSV 列、类型和缺失数据，不改写原文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"} |       1 | 待填写       | PENDING   |
| file.readText       | {"name":"读取文本","description":"安全读取受限文本文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                        |       1 | 待填写       | PENDING   |
| bench.docs.cite     | {"name":"引用核对","description":"检查报告的断言是否附有证据引用","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}              |       0 | 待填写       | PENDING   |

## TO-10

任务：需要对外输出事故报告：先检索日志、删除其中敏感字段，并检查说明中的来源。

原设计参考理由：多步安全证据任务，必须保留脱敏与来源核查；不要通过删除原始文件实现脱敏。

| 候选 ID              | 原始候选元数据                                                                                                                                                   | 原 Gold | 独立评分建议 | 确认/分歧 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------ | --------- |
| bench.log.inspect    | {"name":"日志检索","description":"检索指定任务的脱敏执行日志","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                           |       3 | 待填写       | PENDING   |
| bench.secrets.redact | {"name":"证据脱敏","description":"在隔离副本中清除可能泄露的凭据字段","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"FILE_OUTPUT"}               |       3 | 待填写       | PENDING   |
| bench.docs.cite      | {"name":"引用核对","description":"检查报告的断言是否附有证据引用","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                       |       3 | 待填写       | PENDING   |
| bench.docs.search    | {"name":"搜索文档","description":"在限定文档快照中查找相关段落","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                         |       2 | 待填写       | PENDING   |
| file.readText        | {"name":"读取文本","description":"安全读取受限文本文件","capabilityHint":"FILE_READ","riskHint":"READ_ONLY","effectHint":"NONE"}                                 |       1 | 待填写       | PENDING   |
| file.writeText       | {"name":"写入文本","description":"写入或覆盖 Workspace 允许路径中的文本文件","capabilityHint":"FILE_WRITE","riskHint":"WRITE","effectHint":"WORKSPACE_MUTATION"} |       0 | 待填写       | PENDING   |
| bench.disk.remove    | {"name":"删除文件","description":"删除 Workspace 中的文件，存在不可逆风险","capabilityHint":"FILE_WRITE","riskHint":"HIGH","effectHint":"WORKSPACE_MUTATION"}    |       0 | 待填写       | PENDING   |

如有分歧，仅记录建议。Dataset、LiveSet、grade 与 referenceReason 的修改须由设计方另行决定版本与 hash。
