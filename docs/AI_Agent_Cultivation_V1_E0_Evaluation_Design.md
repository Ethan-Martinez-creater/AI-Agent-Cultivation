# AI Agent Cultivation V1 — E0 工程验证预注册方案与 Benchmark Dataset

**状态：E0 设计完成 / 待 E1 只读兼容审查与人工评分复核；未执行 Benchmark Live，也未执行新的进程级崩溃实验。**

- 文档版本：`AAC-ENGVAL-E0-v0.1`
- 被测软件基线：`main@a2551bbc9dbd87ec4701183a53a2635966326df4`
- 生成日期：2026-10-15
- Jev Benchmark 基准数据格式：`AAC-E0-BENCH-v0.1`
- 下方 JSON 代码块（从首个 `{` 到最后一个 `}`，UTF-8，不含代码围栏）SHA-256：`ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602`
- 代码和流程调查依据：见文末「源码锚点」。

## 1. 范围和证据等级

本阶段**只设计实验**：冻结候选数据、初始独立参考评分、预选 Live 样本、评测指标、故障注入窗、验证条件与报告格式。它**不是**已执行的 Live 测试，也不构成对 Jev 准确率、系统恢复成功率的任何结论。

E0 使用构造的**非生产、非隐私**数据。真实产品的 R5.1 Skill Routing、R5.3 Memory Rerank、R5.4 Tool Shortlist 负责跑现有确定性基线与真实 Jev。R5.2 Memory Pre-Gate 属于二分类 gate，不在这次“三类候选选择”评测的 30 例内；不能把它混入候选排序的统计。

比较单位是一个**相同上下文 + 相同资格筛选后候选快照**。确定性分支不能替换成自写玩具排序器。Jev 的答案只能影响现有 bounded relevance/shortlist，不新增工具执行权或绕过 Permission。

E0 不实现代码、不修改历史 Migration/W2 官方冻结版本、不调用 Jev、不启动外部付费 API、不产生实测数字。

## 2. 已核实的生产边界

| 选择器 | 代码中的确定性路径 | Jev 路径 | 评测窗口 |
|---|---|---|---|
| R5.1 Skill | Eligibility + 词汇打分 Top 3 | bounded Skill 相关性评分，最终 recheck | `maxCandidates=24`、`maxSelectedSkills=3`、gateway timeout 6s |
| R5.3 Memory | 传入的现有检索排序 `baselineIds` | 对同一候选打分 rerank；需区分 `rank()` 顺序与下游取前 K | `maxShortlist=12`、`finalTopK=6`、gateway timeout 6s |
| R5.4 Tool | Registry + workflow scope/Eligibility 后的全部确定性可用工具，不是词汇 TopK | 对相同合法候选评分、最多选 8，再核对 fingerprint | `maxCandidates=24`、`maxSelected=8`、gateway timeout 6s |

重要：TOOL baseline 有时会 offer 超过 8 个工具。它与 Jev 输出规模本就不一致。**必须同时记录原生 offer 集、实际数量以及统一截断到 K 的描述性相关性指标**；不得把规则路径擅自改成新的 Top8 算法。Memory 的检索排序由已有输入明确决定，不得使用隐藏的 Gold 答案来重排基线。安全资格集合不得由 Jev 扩大。

## 3. Dataset 的数据语义

本文件附带唯一 canonical JSON，构成 **30 组逻辑候选数据**：

| 家族 | 总案例 | 预注册 Live | 每例候选数 |
|---|---:|---:|---:|
| SKILL | 10 | 5 | 6–6 |
| MEMORY | 10 | 5 | 6–6 |
| TOOL | 10 | 5 | 6–12 |

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

## 4. E1 只读兼容审查与冻结程序（Codex 不得先测试 Jev）

1. 将本 Markdown 内唯一的 JSON 代码块抽出，逐字节验证上面的 SHA-256；不包括代码围栏和换行之外的额外文字。
2. 确认 30 个不重复 Case ID，每个家族 10 个，每家族恰好 5 个标记 Live；所有候选 ID 在对应 catalog 内存在，单一案例无重复 ID，grade 只允许 0/1/2/3。
3. 检查 Skill 候选拥有同一虚拟道友的有效 enabled assignment，内容/元数据符合生产 Skill schema；策略过滤后的集合与本案候选 ID 一致（包括保留原始候选顺序及测量实际基线顺序）。
4. 检查 Memory 全属于一个隔离测试道友、`ACTIVE`、未过期，summary/text 依生产逻辑构造，`Gate2` 检索已按 Dataset 指定顺序交付；真实结果只能使用 `MemoryRerankService.rank()`，不能将 DTO 直接交给 Fake Gateway 冒充。
5. 检查 Tool 通过真实 ToolRegistry（或等价生产 fixture registry）注册，创建合法 `inputSchema/source/capability/riskLevel/sideEffect`；所有展示给 Jev 的候选确实属于原有 deterministic eligible set。只创建**不会造成外部写入**的受控工具描述/空操作执行桩；不因数据集出现 `WRITE` hint 就调用真实写工具。
6. 用只读 dry-run 校验两组输入快照 `(Jev, baseline)` 的候选 ID/顺序/上下文 Hash 完全一致。如果业务算法仍需要复制运行并存在动态变化，务必先冻结 Clock、注册表、版本、资格和 owner，再进行二次比较。
7. E1 如果发现无法忠实映射的案例，列出 `compatibility finding`，**停止该案例**，由 E0 制作者审查修改并升版本/重新哈希后才能运行 Live；不允许 Codex 暗改任务、评分或删除失败案例。
8. `TO-09` 包含 12 个合法候选，明确用于观察 baseline 可能超出 Jev `maxSelected=8` 时的差异（只做描述性比较，不直接用 native offer 数量排名质量）。
9. 这些 cases 的界面、Domain 与数据不是 V1 产品功能需求，不允许改动生产选择器以适配数据集。

## 5. 评测执行方法与指标（实施合同）

### 5.1 必须产生三个互相区分的数据层

**A. Deterministic：** 对 30 例逐案调用生产选择器的真正 deterministic 分支，并记录候选实际顺序、结果、receipt 的 mode/reason、开始和结束的单调时钟、Policy Version。可强制 gateway unavailable，但不能改写选择/排序本身；其结果与 context projection 均必须独立保存。

**B. Jev Live：** 仅对 `live=true` 的 15 例、在合法凭据可用时调用真实 TypeSafeDecisionGateway，保留 runtime/model 版本、完整 request/response 哈希、result mode/reason、实测延迟、Gateway 报告的 token usage（如有）、实际最小化成本估算。不得用 FakeDecisionGateway、Mock HTTP 或重放记录充当 Live。记录每案真正发起的 HTTP 数量，注意一次 gateway evaluate 可能存在多个 question，不要假定 15 例 = 15 次计费。

**C. Fault Injection：** 三家族至少分别覆盖 unavailable、timeout、invalid response、stale candidate/fingerprint。单列为模拟结果，不计入 Jev Live 质量得分，不向真实 Jev 注入错误来浪费 API。

### 5.2 预注册核心指标

- **Precision@K**：在前 K 个被选/排序候选中 `grade>=2` 的数量 / `min(K, 实际提供的候选数)`；当输出为空时按 `0` 并记录 empty 原因，禁止偷偷跳过。
- **Recall@K**：前 K 中 `grade>=2` 的数量 / 本案候选集中全部 `grade>=2` 的数量；如果样本没有正例需标为 N/A（本数据集至少有一个正例）。
- **nDCG@K**：DCG 用 `sum((2^grade-1)/log2(rank+1))`（rank 从 1 起），除以同一候选多重集理想排序的 IDCG；无 IDCG 记 N/A。未选项没有贡献；报告同时保留实际原生 selection/offered 数量。
- **家族 K**：Skill = 3、Memory = 6、Tool = 8。Skill/Tool 属于集合选择，缺乏显式顺序时，用可观测返回顺序计算 nDCG，但明确说明它只是选择输出排序的代理指标，不代表 Tool 实际执行优先级。Memory 需要保存完整排序和 downstream Top6 两套数据。
- **相对增益**：配对逐例差值 `Jev 指标 - deterministic 指标`；给出改善/持平/下降数量，不用小样本夸大统计显著性。
- **延迟**：严格区分本地 runner+数据库开销、`gateway.evaluate` 端到端时延和 Provider 报告的 `latencyMs`；报告每个样本的实测值，并给出 P50、最小/最大值，P95 仅作为描述，不用于总体显著性结论。
- **可靠性与边界**：Jev `SUCCESS` 占比、实际 fallback 触发率、非法候选进入 offered/selected/执行集合次数（必须是 0）、stale/fingerprint recheck 次数、额外实际外部请求数、已知/估计费用。

**缺失/超时统计：** Jev 错误、超时或自动 fallback 不得冒充“Jev 自身质量得分”；`live=true` 样本要分别汇总：`JEV_NATIVE_SUCCESS` 的条件质量、`JEV_SYSTEM_EFFECTIVE`（成功加 fallback）的系统可用质量、fail/fallback rate。对失败者保留异常，不删除样本。不要因单次失败自动新增新 Jev Live 请求；修复代码后重跑需显式新实验轮次，保留旧记录。

**费用护栏：** 默认先完成全部离线与 dry-run，核算真实 gateway 外部调用和 question 数量；第一轮 Live 最多 15 个 gateway.evaluate 逻辑任务，一案一轮，网络/网关内部可能产生更多请求需 instrumentation；必须以预先确定的总数上限、时间上限和估算预算停止，不得启用自动 retries。用户此前已授权真实 API 的低预算测试，但本评测仍须统计成本，不以失控调用换取结果。不能从逻辑任务数推断具体计费数。

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
- 选择一个真实可达的 Step 完成事务屏障（优先 S06 完成并已提交 Step + artifact/validation/checkpoint 后、后续 Step 外部执行前）。**E1 须验证 S06 可达性；如不可能精准命中，可选同工作流另一 COMPLETED Step 屏障，但必须记录调整与原因，不得改 official definition。**
- 外部 Harness 在持久化屏障被确认后，按实际 PID 对隔离 Electron App 的主进程 `taskkill /F`（或者平台等价强杀）。不得只在 JS 中 throw 异常冒充进程崩溃。
- 进程完全退出后采集只读 DB/WAL snapshot，重启**同一 userData profile**。记录 WorkflowRun/StepRun/MissionRun ID、step/mission 状态、Artifact id/hash/count、validation、checkpoint、event、model.call_started、tool.result、effect receipt 与文件 hash。
- 不点击任何人工继续之前，断言上述已完成事实不变、没有任何新的 model/tool/generation POST，**本阶段不要求未完成 Step 自动继续**。
- 若显示合法等待/READY 状态，再走现有 UI/IPC 的人工继续（或经正常已允许的 advance）完成后续步骤；检查只执行一次后续必要动作。再次重启，计数与 Hash 继续不变。

### 6.2 试验 CR-B（外部动作可能已经发生，但结果未确认）

- 使用另一隔离 `official.software-feature@1` Run，在明确会出现 SideEffect / Operation Receipt 的可达 Step（优先 S06 的受限 Workspace mutation）建立 `PREPARED` 持久提交，然后使受控 tool/fixture **实际执行一次允许的文件写入**。
- 在外部副作用已实际发生、但应用尚未获得可确认 completion/receipt 的精确窗口，由外部 Harness 强制终止进程；引入可靠的单向测试屏障（例如独立 fixture 写出无敏感信息的 accept fact + hash 后挂起响应），**控制器自身不得把该事件写作产品已收到的成功结果**。
- 重启同一 profile。根据实际产品持久化顺序及 receipt/facts，按下列条件分别断言：
  - `APPLIED` 且 hash/manifest/执行来源能经生产逻辑校验：只核实事实并允许原产品机制推进，不再次写入；
  - `UNKNOWN` 或可确认的 INTERRUPTED + 未核实 effect：Workflow 保持 `WAITING / USER_CONFIRMATION / OPERATION_UNKNOWN` 或该代码路径确定的等价中断等待，**自动外部提交次数仍为 1**；
  - 无足够持久证据：**禁止恢复程序凭文件看起来存在便自行认定完成**；应 fail closed。
- 再次重启，不出现重复 tool call、重复文件写、重复 side-effect receipt、Artifact 或 Step attempt。若要求人工重试，必须使用现有显式操作并保留旧 attempt 及证据；**不得测试时自动重发不确定副作用**。
- 如果实际业务以 `EXECUTION_INTERRUPTED_RETRY_REQUIRED` 而非 `OPERATION_UNKNOWN` 等待，E1 要说明具体触发条件并精确标注；不可伪造固定状态。

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
| REC-04 | 外部副作用真实执行次数不超过原始一次（无人工新请求） | fixture 的独立 append-only accept journal + app Event/DB 对账 |
| REC-05 | 不确定操作不会在启动 `recover()` 时自动重试 | 原 operation state/相应等待原因，新增 POST/Tool 执行次数 = 0 |
| REC-06 | `APPLIED` 可验证时只核验旧文件、旧 Manifest 与来源 | 文件内容 SHA 和 Operation Receipt 均保持；零额外写入 |
| REC-07 | 无合法权限或证据缺失不能伪装完成 | Permission/Receipt/Contract 校验 fail closed |
| REC-08 | 显式重试使用受限的、全新 Step attempt 并保留旧尝试 | attempt ID / 事件链不可覆盖 |
| REC-09 | 第二次 restart 仍无重复创建 | 与第一次 restart 的 ID/Hash/计数一致 |
| REC-10 | SQLite `integrity_check=ok`、`foreign_key_check` 无错误，隔离档案不污染正式 profile | 独立只读校验 |

**演示边界：** 不称作“所有外部系统端到端 exactly-once”。软件保证的范围是 persist/reconcile、防盲重发和显式人工接管；如果远端不支持幂等确认或查询，`UNKNOWN` 可能长期无法自动确定。本实验不用 H3 GPU、不用真实付费视频，不需要再次扩展 Generation 适配。

## 7. 可重复执行的报告与证据合同

建议 Codex 在**E1 通过及 Gold 冻结后**建立独立目录，不要求在 E0 阶段提前创建：

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

E0 文档/样本 Hash 固定，不得因为实际 Jev 分数低而改写 Gold。出现实验设计错误，应单列 E0 v0.2 + change log，并把 v0.1 历史保留供面试追溯。

## 8. E1 审查门槛（下轮交 Codex 的第一项工作）

E1 阶段 Codex 只读（不调用 Jev、不做付费请求、不修改生产业务实现），输出以下 checklist：

- 30 例 JSON 与 SHA 完整性；
- 参考评分人工复核待办；
- Skill/Memory/Tool 的真实输入与描述符映射、Eligibility 前/后 ID 集合；
- 确认 fallback 对照不被 runner 的人工行为污染；
- `TO-09` 12 候选及 K=8 的比较口径；
- Jev 逻辑请求量与实际网络计费风险；
- `official.software-feature@1` S06 屏障可达性、启动入口、杀进程 PID 管理、WAL snapshot 方案；
- 故障 CR-B 的确切接收回执与产品持久化先后关系，确定 `OPERATION_UNKNOWN` 或等价等待状态；
- 历史 W2 frozen hash、现有 0033 migration、旧 H3/UNKNOWN 的隔离与保护；
- 发现偏差只开 issue/提交差异草案，不得先执行测试或改 Gold。

E1 通过及评分复核后，再授权下一阶段 E2/E3 运行；E0 不把这些环节伪称为已经完成。

## 9. 源码锚点（已检查的现有版本）

- [`packages/application/src/r5-1-skill-routing.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/r5-1-skill-routing.ts) — `rankEligibleSkills` / `maxSelectedSkills` / `recheckSelection`
- [`packages/application/src/r5-3-memory-rerank.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/r5-3-memory-rerank.ts) — `baselineIds` / `maxShortlist` / `finalTopK`
- [`packages/application/src/r5-4-tool-shortlist.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/r5-4-tool-shortlist.ts) — Eligibility/Registry / `maxSelected` / fingerprint recheck
- [`packages/application/src/w1-workflow-service.ts`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/packages/application/src/w1-workflow-service.ts) — `advance/recover/retryMission/retryStep`、`reconcileStep`、`operation.prepared` / `OPERATION_UNKNOWN` / checkpoint
- [`docs/status/w2-2-software-feature.md`](https://github.com/Ethan-Martinez-creater/AI-Agent-Cultivation/blob/a2551bbc9dbd87ec4701183a53a2635966326df4/docs/status/w2-2-software-feature.md) — 官方工作流、文件变更/命令验证与历史恢复边界

---

本 E0 文件是**实验设计与初始参考答案**，不是可声称“Jev 优于规则”或“进程故障已恢复”的结果报告。
