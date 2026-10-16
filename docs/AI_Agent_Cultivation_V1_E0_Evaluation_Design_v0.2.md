# AI Agent Cultivation V1 — E0 工程验证预注册方案与 Benchmark Dataset

**状态：E0 v0.2 已吸收 E1_CONDITIONAL 审查；等待工具映射运行时复核、Gold 独立评审以及打包版精确断点预检。尚未执行 Benchmark Live 或本轮进程级崩溃实验。**

- 文档版本：`AAC-ENGVAL-E0-v0.2`
- 被测软件基线：`main@a2551bbc9dbd87ec4701183a53a2635966326df4`
- 生成日期：2026-10-15
- Jev Benchmark 基准数据格式：`AAC-E0-BENCH-v0.1`
- 下方 JSON 代码块（从首个 `{` 到最后一个 `}`，UTF-8，不含代码围栏）SHA-256：`ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602`
- 代码和流程调查依据：见文末「源码锚点」。
- **数据集完整保留**：`AAC-E0-BENCH-v0.1`、30 例、15 个预注册 Live ID、所有任务/候选/Gold 未改变，因而 Dataset SHA 未变。修改仅涉及评测边界、生产 Tool fixture 映射、统计口径与故障实验合同。
- 设计变更来源：Codex 2026-10-15 `E1_CONDITIONAL` 静态可行性审查；详见本文末「E1 发现与 v0.2 变更记录」。

## 1. 范围和证据等级

本阶段**只设计实验**：冻结候选数据、初始独立参考评分、预选 Live 样本、评测指标、故障注入窗、验证条件与报告格式。它**不是**已执行的 Live 测试，也不构成对 Jev 准确率、系统恢复成功率的任何结论。

E0 使用构造的**非生产、非隐私**数据。真实产品的 R5.1 Skill Routing、R5.3 Memory Rerank、R5.4 Tool Shortlist 负责跑现有确定性基线与真实 Jev。R5.2 Memory Pre-Gate 属于二分类 gate，不在这次“三类候选选择”评测的 30 例内；不能把它混入候选排序的统计。

比较单位是一个**相同上下文 + 相同资格筛选后候选快照**。确定性分支不能替换成自写玩具排序器。Jev 的答案只能影响现有 bounded relevance/shortlist，不新增工具执行权或绕过 Permission。

E0 不实现代码、不修改历史 Migration/W2 官方冻结版本、不调用 Jev、不启动外部付费 API、不产生实测数字。

## 2. 已核实的生产边界

| 选择器 | 代码中的确定性路径 | Jev 路径 | 评测窗口 |
|---|---|---|---|
| R5.1 Skill | Eligibility + 词汇打分 Top 3 | bounded Skill 相关性评分，最终 recheck | `maxCandidates=24`、`maxSelectedSkills=3`、gateway timeout 6s |
| R5.3 Memory | **固定、合法、已经排序的候选快照**原序 `baselineIds`（本实验不执行 Gate2 检索） | 对同一快照打分 rerank；`rank()` 返回顺序与 Hybrid/PROMPT 下游不可混为一谈 | `maxShortlist=12`、`finalTopK=6`、gateway timeout 6s |
| R5.4 Tool | Registry + workflow scope/Eligibility 后的全部确定性可用工具，不是词汇 TopK | 对相同合法候选评分、最多选 8，再核对 fingerprint | `maxCandidates=24`、`maxSelected=8`、gateway timeout 6s |

重要：TOOL baseline 有时会 offer 超过 8 个工具。它与 Jev 输出规模本就不一致。**必须同时记录原生 offer 集、实际数量以及统一截断到 K 的描述性相关性指标**；不得把规则路径擅自改成新的 Top8 算法。Memory 的候选输入由测试预注册快照明确给定，不能声称这些候选一定会由真实 Gate2 检索召回；不得使用隐藏 Gold 来调整快照或基线。安全资格集合不得由 Jev 扩大。

## 3. Dataset 的数据语义

本文件附带唯一 canonical JSON，构成 **30 组逻辑候选数据**：

| 家族 | 总案例 | 预注册 Live | 每例候选数 |
|---|---:|---:|---:|
| SKILL | 10 | 5 | 6–6 |
| MEMORY | 10 | 5 | 6–6 |
| TOOL | 10 | 5 | 6–12 |

**证据范围和退化事实（预先声明）：**

- MEMORY 的 10 例均为 `N=6`、生产重排窗口 `K=6`：若候选集合稳定，Precision@6 与 Recall@6 的配对差值必然为 0；有效区分指标是 nDCG、Top3 诊断排序、延迟和失败率。这里检验的是 **R5.3 rerank-only**，不是 Gate2 检索/召回、Memory 提议生成、Prompt 最终注入质量。PromptComposer 默认最多选 5 条且仍受字符预算约束。
- 预注册的 5 个 TOOL Live 案例 N 分别为 6/6/6/6/7，均不超过 K=8：成功路径仍提供全部合法候选，因此 P/R@8 不能证明候选过滤收益；能检验 Jev 排序、时间开销和安全回退。`TO-09` N=12 是 **offline-only**，可测候选容量差异但不得擅自改成 Live。
- TOOL 候选使用单独的、标明 **synthetic fixture catalog** 的实际 `ToolRegistry`；所有 16 个 Catalog ID（包括四个 `file.*`）使用 E0 的中文 name/description，不宣称是生产内置 Tool 的原始英文描述，也不执行任何工具。

字段定义：

- `catalogs`：候选元数据；Skill 的 `name/description/tags`、Memory 的 `memoryType/text`、Tool 的 `name/description` 与**语义性的**能力/风险/副作用提示。Tool hints 不是 TypeScript 枚举，E1 必须映射成仓库当前合法 `ToolDescriptor` 并经过实际 registry + eligibility 过滤，不能直接伪装成生产形状。
- `cases[].candidateGrades`：固定顺序的候选 ID + 预注册 relevance grade。**这是金标准标签，不得发给 Jev**。对输入给 Jev 或 deterministic 的有效负载只取 `task`、对应 catalog 的候选元数据、固定顺序和受测生产允许的上下文字段。
- `task`：简短的中文目标，必须经真实生产的 bounded context 投影；本 Dataset 不主张可以绕过生产 schema。
- `stratum`：用例分层，支持单独报告精确匹配、语义关联、干扰项、安全语义、多步骤和大候选集。
- `live`：预先选定的 15 个真实 Jev 对照任务；不许按离线分数事后挑选案例。
- `referenceReason`：人工设计者的可审核评分理由，禁止传给 Jev。

**评分口径（预注册）：** `grade=3` 为执行当前任务不可或缺/直接核心，`2` 为明显相关、合理补充，`1` 为弱相关或可选，`0` 为当前任务不适用。`grade>=2` 定义二值相关，用于 Precision/Recall。一个任务可以有多个正确选项；不强迫等长金标准列表。评审须检查这些标签；发现分歧先人工复核并版本升级，再运行任何真实 Jev 对照。

**数据独立性：** 这是我构建的 provisional gold，不是既有人工专家标注或真实用户分布抽样。建议在 E1 后，由用户或第二名独立评审者复核至少全部 15 个 Live 案例的 candidate/grade；若存在不同意见，公开记录变更理由、标注者与新 hash。不要在运行 Live 后修改 Gold 以迁就 Jev 输出。

### 3.1 Canonical Dataset JSON（唯一数据源）

```json
{
  "schema": "AAC-E0-BENCH-v0.1",
  "baseCommit": "a2551bbc9dbd87ec4701183a53a2635966326df4",
  "labels": "human-designed provisional expert reference: grade 0/1/2/3",
  "liveSet": [
    "SK-02",
    "SK-03",
    "SK-05",
    "SK-08",
    "SK-10",
    "ME-02",
    "ME-03",
    "ME-05",
    "ME-08",
    "ME-10",
    "TO-02",
    "TO-03",
    "TO-05",
    "TO-08",
    "TO-10"
  ],
  "catalogs": {
    "SKILL": {
      "csv-clean": {
        "name": "CSV 数据清洗",
        "description": "规范日期、缺失值、重复行并输出清洗报告",
        "tags": [
          "CSV",
          "data-cleaning"
        ]
      },
      "sql-join": {
        "name": "SQL 查询与关联",
        "description": "使用关系型查询进行过滤、聚合及表连接",
        "tags": [
          "SQL",
          "database"
        ]
      },
      "anomaly": {
        "name": "统计异常识别",
        "description": "通过稳健统计量定位离群点与突变",
        "tags": [
          "statistics",
          "anomaly"
        ]
      },
      "chart": {
        "name": "趋势可视化",
        "description": "将时间序列数据绘制成清晰的图表",
        "tags": [
          "visualization",
          "chart"
        ]
      },
      "unit-test": {
        "name": "单元测试设计",
        "description": "编写可重复的边界与回归单元测试",
        "tags": [
          "testing",
          "test"
        ]
      },
      "api-design": {
        "name": "API 契约设计",
        "description": "定义 HTTP API 输入输出与错误协议",
        "tags": [
          "API",
          "contract"
        ]
      },
      "notes": {
        "name": "版本发布说明",
        "description": "根据已验证变更撰写发布文档",
        "tags": [
          "release",
          "documentation"
        ]
      },
      "translate": {
        "name": "双语翻译",
        "description": "中英双向翻译并保持术语一致",
        "tags": [
          "translation",
          "language"
        ]
      },
      "security": {
        "name": "安全边界审查",
        "description": "检查权限、凭据与输入校验风险",
        "tags": [
          "security",
          "permission"
        ]
      },
      "log-debug": {
        "name": "日志根因分析",
        "description": "从调用轨迹和错误日志定位故障来源",
        "tags": [
          "logging",
          "debugging"
        ]
      },
      "requirements": {
        "name": "需求拆解",
        "description": "将产品需求转化成验收任务与约束",
        "tags": [
          "requirements",
          "planning"
        ]
      },
      "markdown": {
        "name": "Markdown 排版",
        "description": "整理标题、列表、代码块和文档格式",
        "tags": [
          "markdown",
          "formatting"
        ]
      },
      "privacy": {
        "name": "敏感数据脱敏",
        "description": "删除或匿名化不应外发的敏感字段",
        "tags": [
          "privacy",
          "redaction"
        ]
      },
      "research": {
        "name": "文献证据整理",
        "description": "组织研究来源、主张与证据映射",
        "tags": [
          "research",
          "evidence"
        ]
      },
      "benchmark": {
        "name": "实验评测设计",
        "description": "定义对照组、指标、样本和误差分析",
        "tags": [
          "benchmark",
          "evaluation"
        ]
      },
      "perf": {
        "name": "性能瓶颈剖析",
        "description": "定位慢查询、网络延迟和资源热点",
        "tags": [
          "performance",
          "profiling"
        ]
      }
    },
    "MEMORY": {
      "api-current": {
        "memoryType": "FACT",
        "text": "当前图片生成版本使用异步任务查询，完成后再获取输出。"
      },
      "api-old": {
        "memoryType": "EPISODE",
        "text": "较早的内部草案计划将图片生成写成同步接口，已被更新的方案取代。"
      },
      "csv-policy": {
        "memoryType": "PROCEDURE",
        "text": "清洗销售 CSV 时，日期用 UTC，空金额保留并标记，不填零。"
      },
      "csv-example": {
        "memoryType": "EPISODE",
        "text": "某次销售日报发现重复订单，人工去重后生成对账文件。"
      },
      "privacy": {
        "memoryType": "PROCEDURE",
        "text": "对外发送诊断材料之前必须移除 API Key、签名 URL 和原始客户标识。"
      },
      "ui-theme": {
        "memoryType": "PREFERENCE",
        "text": "用户希望桌面应用保持低对比度界面，紧凑卡片展示。"
      },
      "ui-size": {
        "memoryType": "FACT",
        "text": "生成对话的验收宽度覆盖 1440、1180、900。"
      },
      "jev-shadow": {
        "memoryType": "FACT",
        "text": "Jev Shadow 模式只记录 Decision Receipt，不改变 Mission 控制流。"
      },
      "jev-tool": {
        "memoryType": "FACT",
        "text": "Tool Shortlist 只能在确定性合法工具集合之内选择，不授予执行权限。"
      },
      "recovery": {
        "memoryType": "PROCEDURE",
        "text": "外部付费提交结果为 UNKNOWN 时禁止自动重发 POST。"
      },
      "workflow": {
        "memoryType": "FACT",
        "text": "Workflow 完成的 Step 保存 Checkpoint，重启时只对账已提交事实。"
      },
      "music": {
        "memoryType": "EPISODE",
        "text": "一次 Suno 基础生成返回两条 WAV，最终均注册为 Artifact。"
      },
      "research-cite": {
        "memoryType": "PROCEDURE",
        "text": "研究报告的关键论点必须关联来源证据和内容哈希。"
      },
      "cost": {
        "memoryType": "PREFERENCE",
        "text": "真实模型验收以尽可能低的预算进行，不生成长视频。"
      },
      "code-review": {
        "memoryType": "PROCEDURE",
        "text": "软件功能开发先记录接受范围，再执行受限修改、测试和独立审查。"
      },
      "outdated-cost": {
        "memoryType": "FACT",
        "text": "上一轮预算草案写的是每个视频生成十秒，未与当前价格核对。"
      },
      "permission": {
        "memoryType": "FACT",
        "text": "Workspace 文件读取需要 FILE_READ 审批，生成 Artifact 分享不自动授予此权限。"
      },
      "mimo": {
        "memoryType": "FACT",
        "text": "MiMo TTS 文字内容放在 assistant 消息中，音频从指定字段解析。"
      }
    },
    "TOOL": {
      "file.list": {
        "name": "列目录",
        "description": "列出当前 Workspace 允许访问目录中的条目",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "file.readText": {
        "name": "读取文本",
        "description": "安全读取受限文本文件",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "file.writeText": {
        "name": "写入文本",
        "description": "写入或覆盖 Workspace 允许路径中的文本文件",
        "capabilityHint": "FILE_WRITE",
        "riskHint": "WRITE",
        "effectHint": "WORKSPACE_MUTATION"
      },
      "file.createDirectory": {
        "name": "新建目录",
        "description": "在允许的 Workspace 路径下创建目录",
        "capabilityHint": "FILE_WRITE",
        "riskHint": "WRITE",
        "effectHint": "WORKSPACE_MUTATION"
      },
      "bench.csv.validate": {
        "name": "表格校验",
        "description": "仅检查 CSV 列、类型和缺失数据，不改写原文件",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "bench.csv.aggregate": {
        "name": "统计汇总",
        "description": "只读方式计算按月汇总数据",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "bench.chart.render": {
        "name": "绘图输出",
        "description": "根据已验证数据生成可视化图表文件",
        "capabilityHint": "FILE_WRITE",
        "riskHint": "WRITE",
        "effectHint": "FILE_OUTPUT"
      },
      "bench.tests.run": {
        "name": "运行隔离测试",
        "description": "执行已批准的隔离项目单元测试",
        "capabilityHint": "TOOL_EXEC",
        "riskHint": "WRITE",
        "effectHint": "EXTERNAL_ACTION"
      },
      "bench.docs.search": {
        "name": "搜索文档",
        "description": "在限定文档快照中查找相关段落",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "bench.docs.cite": {
        "name": "引用核对",
        "description": "检查报告的断言是否附有证据引用",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "bench.log.inspect": {
        "name": "日志检索",
        "description": "检索指定任务的脱敏执行日志",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "bench.secrets.redact": {
        "name": "证据脱敏",
        "description": "在隔离副本中清除可能泄露的凭据字段",
        "capabilityHint": "FILE_WRITE",
        "riskHint": "WRITE",
        "effectHint": "FILE_OUTPUT"
      },
      "bench.api.check": {
        "name": "接口结构校验",
        "description": "离线核对 API 请求与错误 Schema",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      },
      "bench.release.notes": {
        "name": "发布记录生成",
        "description": "写出已验证变更的发布说明",
        "capabilityHint": "FILE_WRITE",
        "riskHint": "WRITE",
        "effectHint": "FILE_OUTPUT"
      },
      "bench.disk.remove": {
        "name": "删除文件",
        "description": "删除 Workspace 中的文件，存在不可逆风险",
        "capabilityHint": "FILE_WRITE",
        "riskHint": "HIGH",
        "effectHint": "WORKSPACE_MUTATION"
      },
      "bench.stats.anomaly": {
        "name": "异常检测",
        "description": "读取已清洗数据并标记异常值",
        "capabilityHint": "FILE_READ",
        "riskHint": "READ_ONLY",
        "effectHint": "NONE"
      }
    }
  },
  "cases": [
    {
      "id": "SK-01",
      "family": "SKILL",
      "stratum": "lexical",
      "live": false,
      "task": "清理季度销售 CSV 中的重复订单和日期格式，产出可追溯清洗报告。",
      "candidateGrades": [
        {
          "id": "csv-clean",
          "grade": 3
        },
        {
          "id": "sql-join",
          "grade": 1
        },
        {
          "id": "anomaly",
          "grade": 1
        },
        {
          "id": "markdown",
          "grade": 1
        },
        {
          "id": "chart",
          "grade": 0
        },
        {
          "id": "notes",
          "grade": 0
        }
      ],
      "referenceReason": "CSV 清洗直接相关；关联、异常和排版仅是次要辅助。"
    },
    {
      "id": "SK-02",
      "family": "SKILL",
      "stratum": "semantic",
      "live": true,
      "task": "识别经营数据里突然偏离常态的月份，并画出变化趋势。",
      "candidateGrades": [
        {
          "id": "csv-clean",
          "grade": 1
        },
        {
          "id": "anomaly",
          "grade": 3
        },
        {
          "id": "chart",
          "grade": 3
        },
        {
          "id": "sql-join",
          "grade": 1
        },
        {
          "id": "perf",
          "grade": 0
        },
        {
          "id": "notes",
          "grade": 0
        }
      ],
      "referenceReason": "异常检测和趋势图两个能力都必要；语言中未直接出现统计技能名。"
    },
    {
      "id": "SK-03",
      "family": "SKILL",
      "stratum": "semantic",
      "live": true,
      "task": "接口偶发返回 502，排查请求链路并确认是否暴露了访问令牌。",
      "candidateGrades": [
        {
          "id": "log-debug",
          "grade": 3
        },
        {
          "id": "security",
          "grade": 3
        },
        {
          "id": "api-design",
          "grade": 2
        },
        {
          "id": "unit-test",
          "grade": 1
        },
        {
          "id": "markdown",
          "grade": 0
        },
        {
          "id": "translate",
          "grade": 0
        }
      ],
      "referenceReason": "日志诊断与凭据审查直接相关；API 契约校验可辅助。"
    },
    {
      "id": "SK-04",
      "family": "SKILL",
      "stratum": "lexical",
      "live": false,
      "task": "将新版 REST 接口字段冻结成契约，并为输入异常补回归测试。",
      "candidateGrades": [
        {
          "id": "api-design",
          "grade": 3
        },
        {
          "id": "unit-test",
          "grade": 3
        },
        {
          "id": "requirements",
          "grade": 2
        },
        {
          "id": "log-debug",
          "grade": 1
        },
        {
          "id": "notes",
          "grade": 0
        },
        {
          "id": "chart",
          "grade": 0
        }
      ],
      "referenceReason": "契约设计及测试为共同关键技能。"
    },
    {
      "id": "SK-05",
      "family": "SKILL",
      "stratum": "distractor",
      "live": true,
      "task": "将研究访谈笔记整理成有来源依据的证据表，禁止编造引用。",
      "candidateGrades": [
        {
          "id": "research",
          "grade": 3
        },
        {
          "id": "markdown",
          "grade": 2
        },
        {
          "id": "privacy",
          "grade": 2
        },
        {
          "id": "benchmark",
          "grade": 1
        },
        {
          "id": "translate",
          "grade": 0
        },
        {
          "id": "chart",
          "grade": 0
        }
      ],
      "referenceReason": "证据链优先，格式和隐私处理辅助；翻译不是需求。"
    },
    {
      "id": "SK-06",
      "family": "SKILL",
      "stratum": "semantic",
      "live": false,
      "task": "评估两种缓存算法的延迟差异，设计公平对照并分析瓶颈。",
      "candidateGrades": [
        {
          "id": "benchmark",
          "grade": 3
        },
        {
          "id": "perf",
          "grade": 3
        },
        {
          "id": "unit-test",
          "grade": 2
        },
        {
          "id": "chart",
          "grade": 1
        },
        {
          "id": "api-design",
          "grade": 0
        },
        {
          "id": "sql-join",
          "grade": 0
        }
      ],
      "referenceReason": "评测设计与性能剖析共同必要；单元测试仅辅助。"
    },
    {
      "id": "SK-07",
      "family": "SKILL",
      "stratum": "constraint",
      "live": false,
      "task": "把本轮已批准的变更写成可发布说明，不修改任何程序文件。",
      "candidateGrades": [
        {
          "id": "notes",
          "grade": 3
        },
        {
          "id": "markdown",
          "grade": 2
        },
        {
          "id": "requirements",
          "grade": 1
        },
        {
          "id": "unit-test",
          "grade": 0
        },
        {
          "id": "api-design",
          "grade": 0
        },
        {
          "id": "log-debug",
          "grade": 0
        }
      ],
      "referenceReason": "文档交付而非代码开发；编写测试并非当前目标。"
    },
    {
      "id": "SK-08",
      "family": "SKILL",
      "stratum": "semantic",
      "live": true,
      "task": "把内部排障日志作为面试材料，但所有密钥和客户标识必须移除。",
      "candidateGrades": [
        {
          "id": "privacy",
          "grade": 3
        },
        {
          "id": "security",
          "grade": 3
        },
        {
          "id": "log-debug",
          "grade": 2
        },
        {
          "id": "markdown",
          "grade": 1
        },
        {
          "id": "notes",
          "grade": 0
        },
        {
          "id": "translate",
          "grade": 0
        }
      ],
      "referenceReason": "脱敏与安全核对共同关键，根因分析仅间接相关。"
    },
    {
      "id": "SK-09",
      "family": "SKILL",
      "stratum": "ambiguous",
      "live": false,
      "task": "需要只解释现有代码中的接口类型并写出中文说明，不更改接口协议。",
      "candidateGrades": [
        {
          "id": "api-design",
          "grade": 3
        },
        {
          "id": "markdown",
          "grade": 2
        },
        {
          "id": "translate",
          "grade": 1
        },
        {
          "id": "security",
          "grade": 0
        },
        {
          "id": "unit-test",
          "grade": 0
        },
        {
          "id": "chart",
          "grade": 0
        }
      ],
      "referenceReason": "需要解释现有契约和文档组织；不是重新设计协议。"
    },
    {
      "id": "SK-10",
      "family": "SKILL",
      "stratum": "semantic",
      "live": true,
      "task": "用同一输入比较规则排序与语义排序，统计准确性和耗时，报告负面案例。",
      "candidateGrades": [
        {
          "id": "benchmark",
          "grade": 3
        },
        {
          "id": "perf",
          "grade": 2
        },
        {
          "id": "anomaly",
          "grade": 1
        },
        {
          "id": "research",
          "grade": 1
        },
        {
          "id": "notes",
          "grade": 1
        },
        {
          "id": "api-design",
          "grade": 0
        }
      ],
      "referenceReason": "实验设计最重要，延迟/性能度量是主要辅助。"
    },
    {
      "id": "ME-01",
      "family": "MEMORY",
      "stratum": "version",
      "live": false,
      "task": "当前图片生成任务怎样查询异步状态并保存输出？",
      "candidateGrades": [
        {
          "id": "api-old",
          "grade": 0
        },
        {
          "id": "api-current",
          "grade": 3
        },
        {
          "id": "mimo",
          "grade": 0
        },
        {
          "id": "workflow",
          "grade": 1
        },
        {
          "id": "music",
          "grade": 0
        },
        {
          "id": "recovery",
          "grade": 2
        }
      ],
      "referenceReason": "当前图片异步协议与 UNKNOWN 安全性相关；过时草案不应占前列。"
    },
    {
      "id": "ME-02",
      "family": "MEMORY",
      "stratum": "semantic",
      "live": true,
      "task": "按照此前销售报表的日期和空金额处理口径继续清洗新 CSV。",
      "candidateGrades": [
        {
          "id": "csv-example",
          "grade": 2
        },
        {
          "id": "csv-policy",
          "grade": 3
        },
        {
          "id": "ui-size",
          "grade": 0
        },
        {
          "id": "api-old",
          "grade": 0
        },
        {
          "id": "privacy",
          "grade": 1
        },
        {
          "id": "code-review",
          "grade": 0
        }
      ],
      "referenceReason": "优先提取固定清洗政策，而不是曾经的单次案例。"
    },
    {
      "id": "ME-03",
      "family": "MEMORY",
      "stratum": "semantic",
      "live": true,
      "task": "向招聘面试官解释重启任务为何不自动再付费调用。",
      "candidateGrades": [
        {
          "id": "outdated-cost",
          "grade": 0
        },
        {
          "id": "recovery",
          "grade": 3
        },
        {
          "id": "workflow",
          "grade": 3
        },
        {
          "id": "jev-tool",
          "grade": 1
        },
        {
          "id": "music",
          "grade": 0
        },
        {
          "id": "ui-theme",
          "grade": 0
        }
      ],
      "referenceReason": "UNKNOWN 防重复发送与 Workflow 事实恢复共同相关。"
    },
    {
      "id": "ME-04",
      "family": "MEMORY",
      "stratum": "security",
      "live": false,
      "task": "为什么 Jev 排序结果不能让道友越权执行文件写入？",
      "candidateGrades": [
        {
          "id": "jev-shadow",
          "grade": 2
        },
        {
          "id": "jev-tool",
          "grade": 3
        },
        {
          "id": "permission",
          "grade": 3
        },
        {
          "id": "privacy",
          "grade": 1
        },
        {
          "id": "code-review",
          "grade": 0
        },
        {
          "id": "api-current",
          "grade": 0
        }
      ],
      "referenceReason": "候选资格/执行权限边界是直接答案。"
    },
    {
      "id": "ME-05",
      "family": "MEMORY",
      "stratum": "distractor",
      "live": true,
      "task": "为视频验收制定最低预算策略，不要长视频，也不要公开密钥。",
      "candidateGrades": [
        {
          "id": "outdated-cost",
          "grade": 0
        },
        {
          "id": "cost",
          "grade": 3
        },
        {
          "id": "privacy",
          "grade": 3
        },
        {
          "id": "recovery",
          "grade": 2
        },
        {
          "id": "ui-theme",
          "grade": 0
        },
        {
          "id": "music",
          "grade": 0
        }
      ],
      "referenceReason": "当前预算偏好与凭据脱敏优先；过时十秒预算不可当作事实。"
    },
    {
      "id": "ME-06",
      "family": "MEMORY",
      "stratum": "lexical",
      "live": false,
      "task": "检查科研报告中每一条结论能否追溯到来源材料。",
      "candidateGrades": [
        {
          "id": "research-cite",
          "grade": 3
        },
        {
          "id": "code-review",
          "grade": 1
        },
        {
          "id": "workflow",
          "grade": 1
        },
        {
          "id": "csv-policy",
          "grade": 0
        },
        {
          "id": "api-current",
          "grade": 0
        },
        {
          "id": "ui-size",
          "grade": 0
        }
      ],
      "referenceReason": "来源证据链最相关。"
    },
    {
      "id": "ME-07",
      "family": "MEMORY",
      "stratum": "lexical",
      "live": false,
      "task": "测试生成页在三种窗口大小下的可读性，遵循既定展示习惯。",
      "candidateGrades": [
        {
          "id": "ui-theme",
          "grade": 3
        },
        {
          "id": "ui-size",
          "grade": 3
        },
        {
          "id": "music",
          "grade": 0
        },
        {
          "id": "mimo",
          "grade": 0
        },
        {
          "id": "api-old",
          "grade": 0
        },
        {
          "id": "privacy",
          "grade": 1
        }
      ],
      "referenceReason": "界面偏好和验收宽度均重要。"
    },
    {
      "id": "ME-08",
      "family": "MEMORY",
      "stratum": "version",
      "live": true,
      "task": "旧资料建议图片立即返回文件，应该按现行方案如何处理？",
      "candidateGrades": [
        {
          "id": "api-old",
          "grade": 1
        },
        {
          "id": "api-current",
          "grade": 3
        },
        {
          "id": "recovery",
          "grade": 2
        },
        {
          "id": "mimo",
          "grade": 0
        },
        {
          "id": "csv-example",
          "grade": 0
        },
        {
          "id": "jev-shadow",
          "grade": 0
        }
      ],
      "referenceReason": "旧方案应识别为历史而非权威；现行异步优先。"
    },
    {
      "id": "ME-09",
      "family": "MEMORY",
      "stratum": "semantic",
      "live": false,
      "task": "排查文字转语音请求为什么没有拿到音频文件。",
      "candidateGrades": [
        {
          "id": "mimo",
          "grade": 3
        },
        {
          "id": "api-current",
          "grade": 1
        },
        {
          "id": "music",
          "grade": 1
        },
        {
          "id": "privacy",
          "grade": 1
        },
        {
          "id": "cost",
          "grade": 0
        },
        {
          "id": "workflow",
          "grade": 0
        }
      ],
      "referenceReason": "MiMo TTS 请求和响应协议直接相关。"
    },
    {
      "id": "ME-10",
      "family": "MEMORY",
      "stratum": "security",
      "live": true,
      "task": "当前协作任务读取共享媒体前，是否自动拥有本地 Workspace 文件权限？",
      "candidateGrades": [
        {
          "id": "permission",
          "grade": 3
        },
        {
          "id": "workflow",
          "grade": 2
        },
        {
          "id": "recovery",
          "grade": 1
        },
        {
          "id": "api-current",
          "grade": 0
        },
        {
          "id": "jev-tool",
          "grade": 2
        },
        {
          "id": "ui-theme",
          "grade": 0
        }
      ],
      "referenceReason": "分享不授予 FILE_READ；Workflow 和 Tool 边界提供上下文。"
    },
    {
      "id": "TO-01",
      "family": "TOOL",
      "stratum": "lexical",
      "live": false,
      "task": "只列出测试工程根目录有哪些文件，不读取正文也不要修改。",
      "candidateGrades": [
        {
          "id": "file.list",
          "grade": 3
        },
        {
          "id": "file.readText",
          "grade": 1
        },
        {
          "id": "file.writeText",
          "grade": 0
        },
        {
          "id": "file.createDirectory",
          "grade": 0
        },
        {
          "id": "bench.log.inspect",
          "grade": 0
        },
        {
          "id": "bench.docs.search",
          "grade": 0
        }
      ],
      "referenceReason": "只需目录枚举；写权限工具不应优先。"
    },
    {
      "id": "TO-02",
      "family": "TOOL",
      "stratum": "semantic",
      "live": true,
      "task": "读取配置文件并找到指定字段，然后把找到的行显示给我，不要写回文件。",
      "candidateGrades": [
        {
          "id": "file.list",
          "grade": 1
        },
        {
          "id": "file.readText",
          "grade": 3
        },
        {
          "id": "file.writeText",
          "grade": 0
        },
        {
          "id": "bench.docs.search",
          "grade": 1
        },
        {
          "id": "bench.log.inspect",
          "grade": 1
        },
        {
          "id": "bench.csv.validate",
          "grade": 0
        }
      ],
      "referenceReason": "读取文本直接完成目标；用户禁止写回。"
    },
    {
      "id": "TO-03",
      "family": "TOOL",
      "stratum": "multi-step",
      "live": true,
      "task": "校验月度 CSV 各列类型，再计算月度订单总额，不改变源数据。",
      "candidateGrades": [
        {
          "id": "file.readText",
          "grade": 2
        },
        {
          "id": "bench.csv.validate",
          "grade": 3
        },
        {
          "id": "bench.csv.aggregate",
          "grade": 3
        },
        {
          "id": "file.writeText",
          "grade": 0
        },
        {
          "id": "bench.chart.render",
          "grade": 0
        },
        {
          "id": "bench.stats.anomaly",
          "grade": 1
        }
      ],
      "referenceReason": "表格校验与统计汇总两个工具必要，均只读。"
    },
    {
      "id": "TO-04",
      "family": "TOOL",
      "stratum": "semantic",
      "live": false,
      "task": "为研发变更生成发布说明，内容只能基于已通过验证的变更。",
      "candidateGrades": [
        {
          "id": "bench.tests.run",
          "grade": 2
        },
        {
          "id": "bench.release.notes",
          "grade": 3
        },
        {
          "id": "bench.api.check",
          "grade": 1
        },
        {
          "id": "file.createDirectory",
          "grade": 0
        },
        {
          "id": "bench.docs.cite",
          "grade": 2
        },
        {
          "id": "bench.disk.remove",
          "grade": 0
        }
      ],
      "referenceReason": "生成发布说明优先，核对验证与证据辅助。"
    },
    {
      "id": "TO-05",
      "family": "TOOL",
      "stratum": "security",
      "live": true,
      "task": "检查故障日志并整理可以安全分享的排查证据，不能泄露密钥。",
      "candidateGrades": [
        {
          "id": "bench.log.inspect",
          "grade": 3
        },
        {
          "id": "bench.secrets.redact",
          "grade": 3
        },
        {
          "id": "file.readText",
          "grade": 1
        },
        {
          "id": "bench.docs.search",
          "grade": 1
        },
        {
          "id": "file.writeText",
          "grade": 0
        },
        {
          "id": "bench.disk.remove",
          "grade": 0
        }
      ],
      "referenceReason": "日志读取和脱敏一起构成任务；任意写入或删除不是安全捷径。"
    },
    {
      "id": "TO-06",
      "family": "TOOL",
      "stratum": "semantic",
      "live": false,
      "task": "查找报告中的引用来源并验证每个关键论断都有依据。",
      "candidateGrades": [
        {
          "id": "bench.docs.search",
          "grade": 3
        },
        {
          "id": "bench.docs.cite",
          "grade": 3
        },
        {
          "id": "file.list",
          "grade": 1
        },
        {
          "id": "bench.csv.aggregate",
          "grade": 0
        },
        {
          "id": "bench.api.check",
          "grade": 0
        },
        {
          "id": "bench.log.inspect",
          "grade": 0
        }
      ],
      "referenceReason": "文档检索和引用核对均关键。"
    },
    {
      "id": "TO-07",
      "family": "TOOL",
      "stratum": "constraints",
      "live": false,
      "task": "对已有隔离测试项目执行已批准的单元测试，不允许改写业务代码。",
      "candidateGrades": [
        {
          "id": "bench.tests.run",
          "grade": 3
        },
        {
          "id": "file.readText",
          "grade": 1
        },
        {
          "id": "file.writeText",
          "grade": 0
        },
        {
          "id": "bench.docs.search",
          "grade": 0
        },
        {
          "id": "bench.chart.render",
          "grade": 0
        },
        {
          "id": "bench.disk.remove",
          "grade": 0
        }
      ],
      "referenceReason": "测试工具高度相关；写入与删除不是必需。"
    },
    {
      "id": "TO-08",
      "family": "TOOL",
      "stratum": "multi-step",
      "live": true,
      "task": "从已清洗的数据中找出异常订单并画一张离群值可视化图表。",
      "candidateGrades": [
        {
          "id": "bench.stats.anomaly",
          "grade": 3
        },
        {
          "id": "bench.chart.render",
          "grade": 3
        },
        {
          "id": "bench.csv.aggregate",
          "grade": 1
        },
        {
          "id": "bench.csv.validate",
          "grade": 1
        },
        {
          "id": "file.readText",
          "grade": 1
        },
        {
          "id": "bench.docs.cite",
          "grade": 0
        }
      ],
      "referenceReason": "异常检测与绘图为互补工具。"
    },
    {
      "id": "TO-09",
      "family": "TOOL",
      "stratum": "over-capacity",
      "live": false,
      "task": "为本轮审计读取日志、检查 API Schema、确认引用并导出发布记录。",
      "candidateGrades": [
        {
          "id": "file.list",
          "grade": 1
        },
        {
          "id": "file.readText",
          "grade": 2
        },
        {
          "id": "bench.csv.validate",
          "grade": 0
        },
        {
          "id": "bench.csv.aggregate",
          "grade": 0
        },
        {
          "id": "bench.chart.render",
          "grade": 0
        },
        {
          "id": "bench.tests.run",
          "grade": 1
        },
        {
          "id": "bench.docs.search",
          "grade": 1
        },
        {
          "id": "bench.docs.cite",
          "grade": 3
        },
        {
          "id": "bench.log.inspect",
          "grade": 3
        },
        {
          "id": "bench.secrets.redact",
          "grade": 2
        },
        {
          "id": "bench.api.check",
          "grade": 3
        },
        {
          "id": "bench.release.notes",
          "grade": 3
        }
      ],
      "referenceReason": "候选数超过 8，比较基线原样 offer 与 Jev 最多 8 的质量—覆盖权衡；无关候选不可算好结果。"
    },
    {
      "id": "TO-10",
      "family": "TOOL",
      "stratum": "multi-step",
      "live": true,
      "task": "需要对外输出事故报告：先检索日志、删除其中敏感字段，并检查说明中的来源。",
      "candidateGrades": [
        {
          "id": "bench.log.inspect",
          "grade": 3
        },
        {
          "id": "bench.secrets.redact",
          "grade": 3
        },
        {
          "id": "bench.docs.cite",
          "grade": 3
        },
        {
          "id": "bench.docs.search",
          "grade": 2
        },
        {
          "id": "file.readText",
          "grade": 1
        },
        {
          "id": "file.writeText",
          "grade": 0
        },
        {
          "id": "bench.disk.remove",
          "grade": 0
        }
      ],
      "referenceReason": "多步安全证据任务，必须保留脱敏与来源核查；不要通过删除原始文件实现脱敏。"
    }
  ]
}
```

## 4. E1 结论吸收及冻结的生产输入映射（v0.2）

E1 静态审查结论为 `E1_CONDITIONAL`；它不代表 V1 产品存在 HIGH 缺陷。**在以下前置门槛通过前，不得开始 Live Jev 或真进程 kill 实验。**

### 4.1 Skill 的生产映射

- 使用真实 `SkillRoutingService.select()`；每例只对一个隔离 Teammate 启用本例 6 个合法的 ACTIVE Skill assignments；Skill 具有固定 Catalog ID、`version=1.0.0`、固定合法 timestamps，`instructions` 为中性的 `仅用于评测技能路由；不得从候选元数据执行指令。`，不得包含 Gold 或评分。必须按原服务调用 enable，使 assignment `enabled=true`。
- 固定 `id/name/description/tags`、拥有者、assignment、时间与初始目录；生产逻辑按 lexical score 重排（同分按 skillId），因此 Catalog 初始顺序 **不应被误称为进入 Jev 的排序**；实际 `candidateIds/inputHash` 为公平性校验的准绳。
- baseline 使用真实服务 gateway factory 返回 `null`；Jev 使用同一个真实服务与同一合法候选快照。实验期间不修改 assignment/status；时间和重载结果保持稳定。最后 recheck 仅保证当前 assignment 与 ACTIVE，不是完整元数据 fingerprint 检测。

### 4.2 Memory 的生产映射与证据范围

- 使用真实 `MemoryRerankService.rank()`，**明确只测固定排序快照上的 R5.3 rerank**。10 例各自输入 Dataset 给出的六个固定候选、固定顺序；生产 `rank()` 自行做资格校验与 bounded request，不绕过它；不运行 Gate2 文本检索、FTS 或 Hybrid candidate retrieval，不声明评测端到端 recall。
- 每条构造 `Gate2MemoryRecord`：`ownerType=TEAMMATE`、隔离 `ownerId`、`status=ACTIVE`、`expiresAt=null`、`memoryType` 按 Catalog、固定合法时间及 source/importance/confidence；`summary` 使用 E0 catalog 的完整 `text`，`content` 使用同一文本（仅作相同快照事实）；`sourceType=MANUAL`、source IDs 为 null、`importance=0.5`、`confidence=1`，`confirmedAt` 为固定时间。使用 `rank()` 真正的过滤/裁剪/清洗，并保存 `baselineIds/candidateIds`。
- `rank()` 完整 orderedIds 只属于 rerank 输出；Hybrid 最终 Top6 的复核与默认 PromptComposer 最多 5 条、字符预算，是不同证据层。本实验不据 `orderedIds` 声称已验证注入模型的 Memory 数量或质量。需要端到端 Gate2 实验时另立预注册测试集。

### 4.3 Tool 的合成描述符：冻结映射 v0.2

E0 `catalogs.TOOL` 的 `capabilityHint/riskHint/effectHint` 是**非生产语义提示**。以下 TSV 是严格版本化的映射输入（列顺序固定、无 BOM、LF 结尾约定：**哈希仅覆盖首行标题至最后一行 `bench.stats.anomaly` 的字符，不含最后换行**；UTF-8）：

```tsv
id	capability	riskLevel	sideEffect	propertyOrder
file.list	FILE_READ	READ_ONLY	NONE	path
file.readText	FILE_READ	READ_ONLY	NONE	path
file.writeText	FILE_WRITE	MEDIUM	LOCAL_WRITE	path,content
file.createDirectory	FILE_WRITE	LOW	LOCAL_WRITE	path
bench.csv.validate	FILE_READ	READ_ONLY	NONE	file
bench.csv.aggregate	FILE_READ	READ_ONLY	NONE	file,groupBy
bench.chart.render	FILE_WRITE	MEDIUM	LOCAL_WRITE	inputFile,outputFile
bench.tests.run	EXECUTE_COMMAND	HIGH	PROCESS_EXECUTION	commandId
bench.docs.search	FILE_READ	READ_ONLY	NONE	query
bench.docs.cite	FILE_READ	READ_ONLY	NONE	claimId,sourceId
bench.log.inspect	FILE_READ	READ_ONLY	NONE	traceId
bench.secrets.redact	FILE_WRITE	MEDIUM	LOCAL_WRITE	inputFile,outputFile
bench.api.check	FILE_READ	READ_ONLY	NONE	specFile
bench.release.notes	FILE_WRITE	MEDIUM	LOCAL_WRITE	releaseId,outputFile
bench.disk.remove	FILE_WRITE	HIGH	LOCAL_WRITE	path
bench.stats.anomaly	FILE_READ	READ_ONLY	NONE	inputFile
```

**ToolFixtureMappingSha256:** `04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62`。E2 在运行前必须从唯一 `tsv` 代码块提取上述文本并验证 Hash；如实际编译后的 `ToolDescriptor` 投影/枚举不兼容，报告 `BLOCKED`，不得私自改 Catalog、Gold 或此映射。

映射规则与语义边界：

1. **所有 16 个条目都是合成 fixture descriptor**，包括与内置 ID 同名的四个 `file.*`。使用只为评测建立的独立 `ToolRegistry`，不会与实际产品内置工具同时注册，也不会启动正式产品的工具执行。`source=BUILTIN` 仅是供合法 Registry 接受的生产枚举值，不表示真实产品扩展了 builtin 功能。
2. 每条 `id` 与对应 E0 Catalog key 完全相同，`name`、`description` 逐字取原有 E0 中文 Catalog；不得混用真实内置英文元数据。`workflowPurposes=[]`；不附加 workflow purpose、Main allowlist 过滤或动态外部 MCP 状态；Eligibility 回调缺省，以 Registry 的合法候选全集为输入。**这只检验候选选择器，不构成生产环境某项工具实际就可用/已获授权的结论。**
3. 用上表 `propertyOrder` 的顺序构造严格 JSON Schema：`type='object'`，`properties` 对每个列出的字段依序加入 `{'type':'string'}`，`required` 为同顺序字段数组，`additionalProperties=false`。不得加入未冻结的 schema 描述、默认值或额外字段；这套 schema 会影响 Jev 的 `inputShape`，因此属于评测输入。
4. `capability/riskLevel/sideEffect` 使用上表的生产合法枚举，即使执行桩不会写入，也不得将 `file.writeText`、删除或运行命令等危险候选降级为 `READ_ONLY`。fixture 的 `resource/execute` 仅为 Registry 类型接线的**永不调用**桩；对任何调用都应拒绝，不允许真实文件操作/命令执行。
5. 每一例仅在隔离 Registry 按 `cases[].candidateGrades` 的顺序注册当前 Case 候选；这就是 Tool baseline 的初始 offered 顺序。不得依据 Gold 过滤、重排。TO-09 需验证 12 个均进入实际 `eligibleIds`，记录原生 baseline 12 与 Jev 最多 8（仅 offline）。
6. 记录 Catalog SHA、映射 SHA、完整 descriptor 列表 SHA、每条 fingerprint、Registry 顺序、实际 eligibleIds；Gold 评分保存在与 Gateway 输入隔离的评分数据结构中。

### 4.4 仍需通过的入口门槛

- 数据集 SHA 对照无变更；SK/ME/TO 每例产出的**真实生产输入形状**和请求大小可由 dry-run 验证。所有 case 的 eligibility/candidate ID 差异必须记录，无法与冻结数据一致时不进入该 case Live。
- 15 个预注册 Live Case 的候选 grade 必须在 Jev 调用前获得第二名独立评审者复核；分歧需在结果揭盲前形成独立修改版本与 Hash，不可事后按 Jev 输出修正。
- CR-A/CR-B 的 packaged 精确 debugger 断点必须先 dry-run 命中真实调用帧并通过执行序列证明；仅 SQLite 轮询不足以构成精确故障屏障。
- Jev 需先核验无自动 SDK Retry 的实际路径、可观察的 wire 请求、超时取消范围、当前计费依据与执行停止护栏；不能把逻辑 evaluate 次数当成物理 HTTP 次数。

## 5. 评测执行方法与指标（实施合同）

### 5.1 必须产生三个互相区分的数据层

**A. Deterministic：** 对 30 例逐案调用生产选择器的真正 deterministic 分支，并记录候选实际顺序、结果、receipt 的 mode/reason、开始和结束的单调时钟、Policy Version。可强制 gateway unavailable，但不能改写选择/排序本身；其结果与 context projection 均必须独立保存。

**B. Jev Live：** 仅对 `live=true` 的 15 例、在合法凭据可用时调用真实 TypeSafeDecisionGateway，保留 runtime/model 版本、完整 request/response 哈希、result mode/reason、实测延迟、Gateway 报告的 token usage（如有）、实际最小化成本估算。独立记录 15 个 evaluate/91 个 question 的预计数量，和实际 SDK POST dispatch / wire 数量；不得用 FakeDecisionGateway、Mock HTTP 或重放记录充当 Live。记录每案真正发起的 HTTP 数量，注意一次 gateway evaluate 可能存在多个 question，不要假定 15 例 = 15 次计费。

**C. Fault Injection：** 三家族至少分别覆盖 unavailable、timeout、invalid response、stale candidate/fingerprint。单列为模拟结果，不计入 Jev Live 质量得分，不向真实 Jev 注入错误来浪费 API。

### 5.2 预注册核心指标

- **Precision@K**：在前 K 个被选/排序候选中 `grade>=2` 的数量 / `min(K, 实际提供的候选数)`；当输出为空时按 `0` 并记录 empty 原因，禁止偷偷跳过。
- **Recall@K**：前 K 中 `grade>=2` 的数量 / 本案候选集中全部 `grade>=2` 的数量；如果样本没有正例需标为 N/A（本数据集至少有一个正例）。
- **nDCG@K**：DCG 用 `sum((2^grade-1)/log2(rank+1))`（rank 从 1 起），除以同一候选多重集理想排序的 IDCG；无 IDCG 记 N/A。未选项没有贡献；报告同时保留实际原生 selection/offered 数量。
- **家族生产 K**：Skill = 3、Memory = 6、Tool = 8。Skill/Tool 属于集合选择，缺乏显式顺序时，用可观测返回顺序计算 nDCG，但明确说明它只是选择输出排序的代理指标，不代表 Tool 实际执行优先级。Memory 需要保存完整排序和 downstream Top6 两套数据。
- **相对增益**：配对逐例差值 `Jev 指标 - deterministic 指标`；给出改善/持平/下降数量，不用小样本夸大统计显著性。
- **预注册诊断性排名切口（不是产品选择上限）**：Memory、Tool 额外计算 `nDCG@3`、`Precision@3`、`Recall@3` 和 `Top1 Grade`，用于在 N≤生产 K 的用例中刻画顺序差异。禁止把这些指标解释为生产选择器只提供 3 条 Memory 或 3 个 Tool。生产 K 下的 P/R 必须照实保留，明确其退化性。TO-09 的产品 K=8、N=12 容量差异仅作离线容量案例分析；Tool 的 baseline 返回顺序不表示执行优先级。
- **退化情况**：Memory N=6、K=6 时，资格不变则 `Recall@6=1`、`Precision@6=正例数/6`，这两个数的组间差值必为 0；全部预注册 Tool Live N≤8，所以其 P/R@8 同样无法证明 Jev 筛掉了无关工具。评测主结论应强调 graded ranking、时延、可靠性与安全边界，而非虚称“提升筛除率”。
- **宏平均、失败与分母**：逐例计算相同 Case 的配对差值，再对家族内已成功 Jev 原生响应样本做等权宏平均；不把所有候选合并做微平均来掩盖不同 Case。Precision 分母是 `min(K, nativeOutputIds.length)`（空输出按 0，并注明）；Recall 分母是该 Case 的合法候选快照中 `grade≥2` 个数。额外对全部固定 5 个 Live Case 记录系统有效结果（失败落回生产 fallback），并始终报告 LIVE_SUCCESS/FALLBACK/NOT_RUN 分母。
- **指标性质**：Skill 的 3 项输出属于 relevance selection；Memory rerank 的排名属于语义相关性排序；Tool fallback 是 deterministic eligible offer，不是词汇排序。Tool 的 P/R、nDCG 仅反映“注册顺序与 Jev 评分排序”的 proxy 相关性，不等同于真实 Permission 约束下的执行收益。

- **延迟**：使用单调时钟分别记录完整 selector 耗时、Gateway evaluate 耗时和 SDK transport 耗时；当前 `TypeSafeDecisionGateway.latencyMs` 是**本地测量**，不是 Provider 服务端报告。每个样本的实测值、P50、最小/最大值均保留；小样本 P95 只作描述。
- **可靠性与边界**：区分 Gateway 原生成功、selector 采用 Jev、selector fallback 与 stale recheck；分别记录原始非法建议数、最终非法候选数（必须是 0）、实际非授权 Tool 执行数（必须是 0）、SDK dispatch/wire 计数、token usage 已知值及失败费用未知值，不能把失败 usage=null 当作 0 费用。

**缺失/超时统计：** Jev 错误、超时或自动 fallback 不得冒充“Jev 自身质量得分”；`live=true` 样本要分别汇总：`JEV_NATIVE_SUCCESS` 的条件质量、`JEV_SYSTEM_EFFECTIVE`（成功加 fallback）的系统可用质量、fail/fallback rate。对失败者保留异常，不删除样本。不要因单次失败自动新增新 Jev Live 请求；修复代码后重跑需显式新实验轮次，保留旧记录。

**费用护栏：** 首轮 15 个 Live Case，按原顺序串行，每案最多 1 个逻辑 `gateway.evaluate()`，**总计 15 个 evaluate、91 个 question、预期最多 15 次 SDK POST dispatch**；`testConnection()`/model probe 不属于样本，不得偷偷加作免费预热。当前实现 `maxRetries=0` 只能说明 SDK 层不开内建 Retry，**并不能保证底层实际 wire 次数恰好 15**。Live 前必须测量重定向/底层代理等是否可能增加请求，以独立 instrumentation 报告 SDK 调用与 wire-level 请求；若无法构建符合费用边界的防重发可观测方案，Live 标为 BLOCKED。单 Case 6 秒策略超时不保证服务端撤销计费；设整体预算、约 120 秒轮次看门狗和认证失败/429/timeout/输入漂移即止的停止条件；任何 NOT_RUN 不得自动补跑。真实 Jev 费用金额需实施前按账号当前价格和计费信息作出有来源估算，未知费用不得冒充零。用户既有的低预算测试授权不能视为无限授权。

**环境固定：** 同一基线 SHA、Node/Electron、配置、timezone/locale（与文本编码）、Jev SDK/model id、Gateway timeout、候选快照 Hash；如果测量运行 warm-up，应将 warm-up 与正式计费分开并尽量不使用付费 warm-up。不得将 Gold、`referenceReason`、评测结论、密钥或结果模板传入 Jev。不得让 Jev 获得 Tool 执行权。

### 5.3 报告不能省略的分析

- 每家族 10 个离线/基线用例、5 个配对真实 Jev 用例的逐例表。
- 对真实 Jev 成功的配对样本输出 Precision/Recall/nDCG 的原始值和差值，按 stratum 分类讨论，尤其报告下降案例。
- 记录两个路径实际候选顺序及 native selected/offered 数量，避免只报告聚合平均值。
- 对异常/超时的 fallback 收集 reason/errorCode、是否存在不合格候选、是否发生越权。
- 如收益主要集中于长语义任务而简单任务无收益，应明确写；如没有收益或表现较差，同样客观写出。
- 第三方 API/模型调用成本与质量改进之间的取舍，不能脱离测试数据编造结论。

## 6. Workflow 进程级崩溃实验：真实产品路径

选用 `official.software-feature@1`（W2.2 冻结版），不修改它的 Definition、Schema、Contract、Manifest、Hash、分支条件。为了避免在真实项目中写入副作用，只在临时的**隔离 Workspace** 中放一个小型 TypeScript 示例工程（例如单个 `formatLabel` 函数和对应测试）。测试工具必须通过现有 Permission / Approval / ToolRuntime 路径运行。禁止修改用户真实项目、调用付费生成服务或启动真实外部发布。

**关键前提：** `WorkflowService.recover()` 的启动恢复只对账持久化 facts，不会自动启动或重试 Model/Tool；正常继续须进入现有 `advance`/`resume`/人工确认入口。`COMPLETED` Step 的 Artifact/Checkpoint 不重做；遇到结果不明的副作用则 `UNKNOWN` + `USER_CONFIRMATION`，不能自动新建 retry。

### 6.1 试验 CR-A（已提交完成事实，重启零重放）

- 创建隔离 profile，新建一个 `official.software-feature@1` Run，通过真实 UI/IPC 正常启动。
- 选择 S06 验证 Step 的**完成事务返回后、`completeExecution()` 返回调用者之前**作为首选屏障，确保 Artifact/Validation/Checkpoint 已持久提交、下一 S07 只处于 READY、还未发起后续调用。`advance()` 可能连续执行后续 Step，因此 **DB 轮询 S06=COMPLETED 后才 kill 存在竞态，不可作为正式屏障**。只能在 packaged compiled code 中由外部 Inspector/CDP 控制的精确暂停断点，先 dry-run 验证源码映射、compiled script hash 与实际 call frame；若无法精确命中，报告 BLOCKED 或另行提出经独立审批的同 Workflow 可达屏障，不准改 official definition。
- 外部 Harness 在持久化屏障被确认后，按实际 PID 对隔离 Electron App 的主进程 `taskkill /F`（或者平台等价强杀）。不得只在 JS 中 throw 异常冒充进程崩溃。
- 由 Controller 校验主进程 PID、创建时间、隔离 Profile 与可执行路径，终止隔离主进程及相关子进程；进程完全退出后连同 `.sqlite/-wal/-shm` 采集一致性副本，对副本运行只读 integrity/FK 检查，不在正式运行库上触发 checkpoint。然后重启**同一 userData profile**。记录 WorkflowRun/StepRun/MissionRun ID、step/mission 状态、Artifact id/hash/count、validation、checkpoint、event、model.call_started、tool.result、effect receipt 与文件 hash。
- 不点击任何人工继续之前，断言上述已完成事实不变、没有任何新的 model/tool/generation POST，**本阶段不要求未完成 Step 自动继续**。
- 若显示合法等待/READY 状态，再走现有 UI/IPC 的人工继续（或经正常已允许的 advance）完成后续步骤；检查只执行一次后续必要动作。再次重启，计数与 Hash 继续不变。

### 6.2 试验 CR-B（S05/S10 动态 Workspace Mutation 的副作用结果不明确）

- 必须创建**另一个**隔离 `official.software-feature@1` Run。**S05/S10 才是已声明的动态 `WORKSPACE_MUTATION` Step；S06 属于验证 TASK，不得用 S06 的 MCP 写入冒充经过生产 `WorkflowToolGuard` 的 Workspace Mutation。**
- 使用真实、经过现有 Permission/Approval、allowed plan path 和同一 MissionRun 限制的 `file.writeText`，先保证 Workflow **Operation Receipt = PREPARED**、**Workspace Mutation Journal = PREPARED**。这两套状态体系不同：后者只有 `PREPARED/APPLIED/UNKNOWN`，没有 `VERIFIED`。
- packaged 控制器事先证实可在编译后的 `gate4-builtins.ts` 对应的真实 `file.writeText` 执行器中，**`await workspace.writeText(...)` 返回后、`return { content: 'Text written.' }` 前**命中单次 Inspector 断点。此时磁盘可能已完成原子写，Tool Promise 尚未结束，`ToolRuntime.executionGuard.after()` 尚未回写，成功的 `tool.result` 尚不存在。不能用延迟轮询或新建假工具模拟此关键时间窗。
- Controller 与产品 DB 分离，记录断点调用帧/compiled hash、step/mission/toolCall IDs、文件预期和实测 hash、写入前的执行器入口次数、杀进程 PID/creation time。**Controller 记录的是独立观察到的写入，不是产品的 APPLIED 回执**。在验证命中并暂停后，由外部控制器只终止隔离 App/子进程，不修改产品状态。
- 恢复按真实生产状态机验收：建议窗口 Main 首先把未完成 Mission 置为 `INTERRUPTED`，Workflow 对未获证实的 effect 设置 UNKNOWN 并进入 `WAITING / USER_CONFIRMATION`；首轮 `errorCode` 预计为 **`EXECUTION_INTERRUPTED_RETRY_REQUIRED`**，而非一律 `OPERATION_UNKNOWN`。若已有 UNKNOWN 在 reconciliation 入口，或以后用户主动 advance 到 UNKNOWN 阻断分支，才可能展示 `OPERATION_UNKNOWN`。都禁止任何自动写入/重复 Tool 执行。
- 单独分析变体：仅当 Mission/MissionRun 确实 `COMPLETED`，实际 Tool fact、journal/manifest 与 Workspace hash 均存在并可验证时，才可核验原 operation 的 APPLIED/VERIFIED；**如果 Mission 已中断，即使 Operation APPLIED，也不能保证会自动核验成功**，仍可能进入 UNKNOWN。文件存在或 hash 与预期一致，**不能单独证明**产品曾确证 Tool 完成。
- 两次重启分别比较 Run/Step/attempt/Operation、原 Event、实际执行次数与文件 hash。Controller 必须有独立的工具执行入口计数或等价可靠观察机制；**文件 hash 未变或缺少新增 `tool.result` 均不足以单独证明写入未重复**。若不能精确证明 `REC-04`，不得判 PASS。
- `retryMission()` 对 UNKNOWN Operation 必须拒绝；若后续人工明确重试，应通过现有 `retryStep()` 新建 attempt 并保留旧证据。Harness **不得自动调用**任何重试。
- 若 debugger/CDP 断点不能在真实打包主进程定位到符合上述状态的调用帧，CR-B packaged=BLOCKED；可另外执行服务层 fault injection，但不能用其替代真正的进程级 Case。

### 6.3 进程级与故障注入证据必须分开

1. **纯离线服务级 fault injection**：在明确 `PREPARED`/`APPLIED`/`VERIFIED`、Mission terminal→Step commit、Step COMPLETE→next READY 等屏障中故意抛错/停止；可反复测试，验证数据库 transition/rollback、pre-commit guard 与 retry policy。
2. **Windows packaged 真进程实验**：使用正式 `npm run package` 生成的可执行主程序，独立隔离 userData + workspace，外部控制器精确 PID kill→等待全退出→同 profile 启动→从 SQLite 及 UI/IPC 读回事实。

二者都必须记录：真实屏障名称、时间戳、日志位置、run/step/attempt/operation key、`before/after/secondRestart` 对照及失败时的原始证据。

### 6.4 恢复不变量（必须写成自动断言）

| ID | 不变量 | 判定 |
|---|---|---|
| REC-01 | Run 固定 `definitionId/version` 与 identity；旧 Step attempt 不改写 | 同一 Run/Step/attempt |
| REC-02 | 已提交 COMPLETED Step 不重新执行模型或工具 | 原 `model.call_started` / `tool.result` / 外部请求计数不增 |
| REC-03 | 原 Artifact 与 Validation Receipt/Checkpoint 的 ID/Hash 不变，零重复 | 批次 ID 集合及 Hash/计数对账 |
| REC-04 | 外部副作用真实执行次数不超过原始一次（无人工新请求） | Controller 独立观测 file.writeText 执行器入口/写入完成断点次数 + app journal/Event 对账；文件 hash 不变本身不充分 |
| REC-05 | 不确定操作不会在启动 `recover()` 时自动重试 | 原 operation state/相应等待原因，新增 POST/Tool 执行次数 = 0 |
| REC-06 | 仅在 Mission/MissionRun 完成且 Operation/APPLIED、Tool fact、journal/Manifest 均可核实时才推进验证；中断/UNKNOWN 不推定可验证 | 必须由现有生产验证逻辑复核，零额外写入 |
| REC-07 | 无合法权限或证据缺失不能伪装完成 | Permission/Receipt/Contract 校验 fail closed |
| REC-08 | 显式重试使用受限的、全新 Step attempt 并保留旧尝试 | attempt ID / 事件链不可覆盖 |
| REC-09 | 第二次 restart 仍无重复创建 | 与第一次 restart 的 ID/Hash/计数一致 |
| REC-10 | SQLite `integrity_check=ok`、`foreign_key_check` 无错误，隔离档案不污染正式 profile | 独立只读校验 |

**演示边界：** 不称作“所有外部系统端到端 exactly-once”。软件保证的范围是 persist/reconcile、防盲重发和显式人工接管；如果远端不支持幂等确认或查询，`UNKNOWN` 可能长期无法自动确定。本实验不用 H3 GPU、不用真实付费视频，不需要再次扩展 Generation 适配。

## 7. 可重复执行的报告与证据合同

建议 Codex 在**E1 条件项通过相应运行前预检、Gold 冻结后**建立独立目录，不要求在 E0 阶段提前创建：

```
docs/evidence/v1-engineering-validation/
  benchmark-baseline.jsonl
  benchmark-jev-live.jsonl
  benchmark-fault-injection.jsonl
  benchmark-metrics.json
  crash-A-before-after.json
  crash-B-before-after.json
  crash-process-controller.log
  recovery-sqlite-manifest.json
  README.md
```

每条 Benchmark 记录至少包括 `datasetVersion/datasetSha/caseId/branch/productionMode/candidateIds/selectedIds/orderedIds/stateHash/policyVersion/modelId/gatewayStatus/receiptReason/errorCode/elapsedMs/actualNetworkRequests/estimatedCost/source`；任何含个人记忆内容、Key 或签名 URL 的信息不得写入公开证据。

每条 Crash 记录至少包括 `baseCommit/definitionVersion/runId/stepRunId/attempt/missionRunId/operationKey/faultBarrier/killPid/killExit/restartPid/stateBefore/stateAfter/stateSecondRestart/counters/artifactHashes/fileHashes/sqliteCheck`。

建议形成两份**由实际数据自动支持**的面试报告：

- `Jev vs Deterministic Baseline Evaluation`：30 例设计、15 例真实配对、风险、成本、负面案例、Fallback。
- `Workflow Crash & Recovery Case Study`：同一正式模板两次隔离故障、kill/restart 实证、未知副作用、不会盲重发的局限。

E0 v0.2 的数据集 Hash 固定，不得因为实际 Jev 分数低而改写 Gold。后续若仍有实验设计错误，应另发 E0 v0.3 + change log，并继续保存 v0.1/v0.2 历史供面试追溯。

## 8. E1_CONDITIONAL 后的 E2/E3 入口复核（不得跳过）

E1 的只读审查已经完成并返回 `CONDITIONAL`；下列 checklist 属于**下一轮独立数据/断点预检**，未全部满足则禁止进入相应 Live/packaged Case：

- 30 例 JSON 与 SHA 完整性；
- 参考评分人工复核待办；
- Skill/Memory/Tool 的真实输入与描述符映射、Eligibility 前/后 ID 集合；
- 确认 fallback 对照不被 runner 的人工行为污染；
- `TO-09` 12 候选及 K=8 的比较口径；
- Jev 逻辑请求量与实际网络计费风险；
- `official.software-feature@1` S06 **完成事务后**精确断点（CR-A）、S05/S10 `file.writeText` **写后返回前**精确断点（CR-B）；compiled hash/调用帧、隔离进程 PID、WAL 全副本方案；
- 故障 CR-B 的实际两套 journal 与 Mission interrupted 的恢复顺序：预计 `EXECUTION_INTERRUPTED_RETRY_REQUIRED`，入口已有 UNKNOWN 或后续主动推进可能为 `OPERATION_UNKNOWN`；
- 历史 W2 frozen hash、现有 0033 migration、旧 H3/UNKNOWN 的隔离与保护；
- 发现偏差只开 issue/提交差异草案，不得先执行测试或改 Gold。

E0 v0.2 修订**不自动升级**原来的 `E1_CONDITIONAL` 到 READY。待独立 Gold 复核、Tool 映射执行前校验、Jev transport 预算预检与 packaged 精确断点 preflight 全部给出证据后，方能分别放行相应 E2/E3 案例。

## 9. E1 Findings 对照与 v0.2 变更记录

| E1 Finding | 决策 | v0.2 对应处理 | 是否需实际执行前再验 |
|---|---|---|---|
| E1-01 | 接受 | ME 定位为固定快照 rerank-only，删除“Gate2 已按顺序检索”的前提 | 是：生产 `rank()` dry-run |
| E1-02 | 接受 | 显式声明生产 K 的 P/R 退化，增补预注册排名诊断 @3 | 是：指标 Runner 单测 |
| E1-03 | 接受 | 冻结 16 个合成 ToolDescriptor 的 TSV 映射、schema 构造及 hash | 是：Registry/投影/eligibility 校验 |
| E1-04 | 接受 | CR-B 改 S05/S10 动态 Workspace Mutation + 真实 builtin `file.writeText` | 是：隔离真实步骤与 journal 路径 |
| E1-05 | 接受 | CR-A/B 必须先通过 packaged compiled 断点 preflight，SQL 轮询不得替代 | 是：最关键 BLOCKED 门槛 |
| E1-06 | 接受 | 15 evaluate/91 question、无 probe、SDK dispatch/wire 分层、可观测请求与停止规则 | 是：真实价格/transport 预检 |
| E1-07 | 接受 | 固定 Precision 分母、宏平均及失败分母 | 是：指标单测 |
| E1-08 | 接受 | `latencyMs` 标为本地时延，失败费用未知单列 | 是：Runner 仪表检查 |
| E1-09 | 接受 | 区分 Skill assignment recheck、Memory rank-only 与 Tool fingerprint | 是：输入/资格快照核对 |
| E1-10 | 保留待办 | Gold 仍为 provisional，15 Live Case 必须独立复核 | **是：Live 阻塞项** |
| E1-11 | 接受 | migration raw-bytes 与规范化 LF hash 同时报出，绝不改写历史文件 | 是：只读归档核对 |

**版本与数据变更声明：** 原 E0 v0.1 Markdown 必须保留。v0.2 修改实施契约和附属合成映射，**不更动** `AAC-E0-BENCH-v0.1` canonical JSON、任务、候选、Gold 或预注册 Live ID。Dataset SHA 应继续为 `ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602`；v0.2 Markdown 全文 SHA 与 Tool 映射 SHA 分别按当前文件及上述 TSV 计算。若评分/候选要变，必须再发有独立版本与 Hash 的新 Dataset，不得事后更改。

**E1 最终审批：** 接受 Codex `E1_CONDITIONAL`，确认**静态可行、仍有运行前门槛**；当前没有任何真实 E2 Jev 质量数据或新的 E3 packaged 进程强杀结果，不得宣称这两项 PASS。

## 10. 源码锚点（已检查的现有版本）

- [`packages/application/src/r5-1-skill-routing.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/r5-1-skill-routing.ts) — `rankEligibleSkills` / `maxSelectedSkills` / `recheckSelection`
- [`packages/application/src/r5-3-memory-rerank.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/r5-3-memory-rerank.ts) — `baselineIds` / `maxShortlist` / `finalTopK`
- [`packages/application/src/r5-4-tool-shortlist.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/r5-4-tool-shortlist.ts) — Eligibility/Registry / `maxSelected` / fingerprint recheck
- [`packages/application/src/w1-workflow-service.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/w1-workflow-service.ts) — `advance/recover/retryMission/retryStep`、`reconcileStep`、`operation.prepared` / `OPERATION_UNKNOWN` / checkpoint
- [`docs/status/w2-2-software-feature.md`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/docs/status/w2-2-software-feature.md) — 官方工作流、文件变更/命令验证与历史恢复边界

---

本 E0 文件是**实验设计与初始参考答案**，不是可声称“Jev 优于规则”或“进程故障已恢复”的结果报告。

- [E1 Feasibility Review](AI_Agent_Cultivation_V1_E1_Feasibility_Review.md) — 2026-10-15 Codex 静态审查，`E1_CONDITIONAL`，11 项 Findings；内链只作为背景，不要求把 E1 报告作为本轮额外计划文档。
