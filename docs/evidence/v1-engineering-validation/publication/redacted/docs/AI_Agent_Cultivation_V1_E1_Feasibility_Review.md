> **DERIVED/REDACTED public copy** — original local bytes retained. Original SHA-256: `4fb0104da0603b26525a8343444a44358b9a39d8b3cf82947ef44f4d2dcc688d`. See the publication derivation map for both hashes and removed field categories.

# AI Agent Cultivation V1 — E1 Feasibility Review

审查日期：2026-10-15  
审查结论：**E1_CONDITIONAL**

现有 V1 代码能够支持基于生产选择器的对照评测，以及隔离环境中的 Windows 进程恢复研究。但 E0 对真实 Memory 检索、Tool 描述符、集合指标有效性及 CR-B 步骤的部分假设需要先修订；两个精确故障窗口还需要验证打包产物的断点可控性。

本报告属于静态可行性审查。**E1 审查轮未修改文件，未运行选择器、Benchmark、应用或故障注入，未调用 Jev 或其他 Provider，也未提交或 push。** 本文档依据随后用户要求，将该轮完整报告整理保存；本次仅新增报告文档。

## A. 基线审计

| 项目 | 本轮核对结果 |
|---|---|
| HEAD | `a2551bbc9dbd87ec4701183a53a2635966326df4` |
| 本地 `main` | 与批准基线一致 |
| 本地 `origin/main` 引用 | 与批准基线一致；本轮未执行 fetch |
| 跟踪文件 | 相对批准基线无差异，暂存区无差异 |
| 整体工作树 | **不干净**：存在原有未跟踪文档、素材、证据及 E0 文件，均未覆盖或清理 |
| E0 文档版本 | `AAC-ENGVAL-E0-v0.1` |
| Dataset Schema | `AAC-E0-BENCH-v0.1` |
| Migration | `0001–0033`，未修改 |
| 正式 Profile、Workspace | 未打开或修改 |

审查文件：[E0 Evaluation Design](../../../../../AI_Agent_Cultivation_V1_E0_Evaluation_Design.md)。

按唯一 JSON 围栏内首个 `{` 至最后一个 `}` 提取，未包含围栏或额外末尾换行，UTF-8 长度为 **34,366 字节**。

```text
预期 SHA-256：
ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602

实际 SHA-256：
ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602

结果：MATCH
```

完整 E0 Markdown 文件的 SHA-256 为：

```text
3fac164963d9cdc84545c90f9f76eff03af485b02cb8041ca6bf7a008f9fa17f
```

另有一个需要保留的审计事实：历史证据中的 `0001–0032` migration hash 有 20 项与当前工作副本的**原始字节 hash**不同；这些文件存在 CRLF。将文本仅在内存中规范化为 LF 后，32 项全部匹配历史记录，Git 内容比较也无差异。这是换行格式差异，不能报告为 migration 被修改，也不能隐去字节差异。后续应同时记录原始字节 hash 与明确标注的规范化 hash，不能改写文件来“修复”审计结果。

## B. Dataset 与逐案兼容性

### B.1 完整性检查

| 检查 | 结果 |
|---|---|
| 唯一 Canonical JSON 代码块、合法 JSON | PASS |
| 总 Case 数 | 30 |
| SKILL / MEMORY / TOOL | 各 10 |
| 每家族 Live 数 | 各 5 |
| Case ID 唯一 | PASS |
| 候选存在于对应 Catalog | PASS |
| 单个 Case 无重复候选 | PASS |
| grade 仅为整数 `0/1/2/3` | PASS |
| `live=true` 与 `liveSet` 成员及顺序一致 | PASS |
| 每例至少一个 `grade>=2` 候选 | PASS |

预注册 Live 列表保持原样：

| 家族 | Live Case |
|---|---|
| Skill | SK-02、SK-03、SK-05、SK-08、SK-10 |
| Memory | ME-02、ME-03、ME-05、ME-08、ME-10 |
| Tool | TO-02、TO-03、TO-05、TO-08、TO-10 |

现有文本较短：Skill task 最长 33 字符，Memory task 最长 38 字符、候选文本最长 53 字符，Tool task 最长 36 字符。未发现单凭这些原始文本就必然触发生产长度上限的问题。工具完整投影后的 schema、枚举和请求大小仍需在映射冻结后检查。

**完整性通过不代表 Gold 正确性已获独立人工确认。** 本轮未修改任何评分或参考理由。

以下状态表示静态兼容性，不表示获准进入 E2/E3。

### B.2 Skill Routing

生产依据：[SkillRoutingService](../../../../../../packages/application/src/r5-1-skill-routing.ts#L193)、[SkillService](../../../../../../packages/application/src/skill-service.ts#L72)。

合法映射可以保持 Catalog 的 `id/name/description/tags`。还需要补齐生产 Skill 要求的固定版本、时间、`status=ACTIVE` 和非空 `instructions`：

- `instructions` 使用不含 Gold 的固定中性内容，并纳入输入映射清单；它不进入 R5.1 相关性请求。
- 每例只有对应 6 个候选对同一个隔离 Teammate 启用，避免其他 Catalog Skill 混入。
- `assign()` 默认生成 `enabled=false`，必须通过既有 `enable()` 显式启用。
- fixture ID 或 Catalog→生产 ID 映射必须固定；随机重建 ID 会影响同分排序。

真实生产路径为：

```text
同 owner 的 enabled assignment
→ ACTIVE Skill
→ 生产词汇打分
→ 分数降序、同分按 skillId 升序
→ 候选预算限制
→ Jev 或确定性 fallback
→ 最终 assignment / ACTIVE 复核
```

这批每例只有 6 个合法候选，低于 `maxCandidates=24`，现有短元数据可容纳；**零词汇分不会导致候选被删除**。Dataset 顺序与生产词汇排序后的顺序可能不同，必须分别记录。

| Case | 状态 | 逐案判断 |
|---|---|---|
| SK-01 | READY | 6 个清洗及干扰 Skill 均合法；零分候选保留。 |
| SK-02 | READY | 异常识别、趋势图等候选合法；语义匹配效果属于评测结果。 |
| SK-03 | READY | 日志、安全、接口候选均可映射，无资格冲突。 |
| SK-04 | READY | 契约、测试及其余候选均可进入真实排序。 |
| SK-05 | READY | 证据、排版、隐私和干扰项均保留；不得按 Gold 预过滤。 |
| SK-06 | READY | Benchmark、性能及辅助候选均合法。 |
| SK-07 | READY | “不修改程序”不构成删除其他 Skill 候选的理由。 |
| SK-08 | READY | 脱敏、安全、日志候选均合法。 |
| SK-09 | READY | 解释接口与重新设计的语义区别可交由评测观察。 |
| SK-10 | READY | 评测、性能等 6 个候选均可进入选择器。 |

基线必须调用真实 `SkillRoutingService.select()`，令 Gateway factory 返回 `null`，取得生产 `DETERMINISTIC_FALLBACK` 结果。不得另写词汇排序器。

Jev 前的候选是生产过滤、排序、预算处理后的集合；最多选 3。最终复核检查当前 assignment 和 Skill 状态，**不应把它描述为对所有元数据版本变化的完整 fingerprint 校验**。

### B.3 Memory Rerank

生产依据：[MemoryRerankService](../../../../../../packages/application/src/r5-3-memory-rerank.ts#L225)、[Hybrid 检索与最终选择](../../../../../../packages/application/src/gate2-hybrid-memory-service.ts#L219)。

可以建立合法 `Gate2MemoryRecord` 快照：

- `ownerType=TEAMMATE`，`ownerId` 为同一个隔离 Teammate；
- `status=ACTIVE`，建议 `expiresAt=null`，避免两分支跨越到期时间；
- `content/summary` 从原 Catalog 文本确定性构造，固定使用哪一个作为语义输入；
- 补齐合法的 source、importance、confidence、时间及确认字段，两个分支完全一致；
- 保持 Dataset 类型和候选顺序，不把历史内容或低 Gold 候选改成 ARCHIVED。

类型缩写：`F=FACT`、`E=EPISODE`、`P=PROCEDURE`、`R=PREFERENCE`。下表类型顺序与原 Case 候选顺序一致。

| Case | 状态 | 类型映射与条件 |
|---|---|---|
| ME-01 | CONDITIONAL | E/F/F/F/E/P；直接快照重排合法，真实检索集合及顺序不保证。 |
| ME-02 | CONDITIONAL | E/P/F/E/P/P；同上，不能用 Gold 将 policy 提前。 |
| ME-03 | CONDITIONAL | F/P/F/F/E/R；同上，过时预算仍保持合法干扰项。 |
| ME-04 | CONDITIONAL | F/F/F/P/P/F；同上，权限主题不改变 owner 规则。 |
| ME-05 | CONDITIONAL | F/R/P/P/R/E；同上，不能预先剔除旧预算。 |
| ME-06 | CONDITIONAL | P/P/F/P/F/F；直接重排合法，端到端检索需另行定义。 |
| ME-07 | CONDITIONAL | R/F/E/F/E/P；类型合法，无需更改文本。 |
| ME-08 | CONDITIONAL | E/F/P/F/E/F；历史方案作为 ACTIVE 参考候选可保留。 |
| ME-09 | CONDITIONAL | F/F/E/P/R/F；直接重排合法，不代表真实检索必然召回这六项。 |
| ME-10 | CONDITIONAL | F/F/P/F/F/R；同上，分享与权限事实不产生实际文件授权。 |

这些案例在 **`rank()` 固定快照输入层均为 READY**；表中的 CONDITIONAL 针对 E0 同时要求“Gate2 按 Dataset 顺序交付候选”的完整表述。

实际问题是：`rank()` 明确只重排，不检索。真实 Gate2 会按查询、相关性和其他字段检索、排序；其中文 `unicode61` 分支还会使用完整 query 的字面子串检索。这批 task 不保证能召回全部六项，更不保证原 Dataset 顺序。依据：[中文检索分支](../../../../../../packages/persistence/src/gate2.ts#L241)。

因此应由 E0 设计方确认：

> 本实验评估固定、合法、已排序候选快照上的 R5.3 重排器；不宣称验证 Gate2 端到端召回。

若要评估端到端检索，需要另行预注册真实检索与候选生成办法，不能为了获得预定顺序修改生产检索。

其他边界：

- `maxShortlist=12`，文本优先取非空 summary，否则取 content excerpt，裁剪至 240 字符/720 字节，并执行清洗。
- `baselineIds` 是同一资格过滤快照的原顺序；Jev 必须对同一快照评分。
- `rank()` 返回完整排序；Hybrid 再进行资格复核并选 Top6。
- 默认 PromptComposer 最多注入 **5 条 Memory**，还受字符预算约束。因此 Top6 不等于最终 prompt 中一定出现六条。依据：[默认 Prompt 限制](../../../../../../packages/application/src/prompt-composer.ts#L48)。

### B.4 Tool Shortlist

生产依据：[ToolShortlistService](../../../../../../packages/application/src/r5-4-tool-shortlist.ts#L409)、[ToolRegistry](../../../../../../packages/application/src/tool-runtime.ts#L104)、[实际内置文件工具](../../../../../../apps/desktop/src/main/gate4-builtins.ts#L39)。

Catalog 不能直接强制转换为 `ToolDescriptor`：

- `WRITE` 不是合法 RiskLevel。
- `TOOL_EXEC` 不是合法 PermissionCapability。
- `WORKSPACE_MUTATION/FILE_OUTPUT/EXTERNAL_ACTION` 不是 ToolDescriptor 的 SideEffect 枚举。
- Catalog 缺少 `source/inputSchema/workflowPurposes`。
- 只有四个 `file.*` 是现有内置工具；12 个 `bench.*` 没有生产定义。
- 真实 `file.*` 的英文 name/description 与 E0 中文 Catalog 不同。

也不能把 `bench.*` 简单标成真实 MCP 工具。MCP Host 会生成带 Server 前缀的 ID，并使用 `MCP_TOOL_EXECUTE/HIGH/PROCESS_EXECUTION` 等实际描述符，改变原输入。依据：[MCP 描述符构造](../../../../../../apps/desktop/src/main/mcp-host.ts#L414)。

可行方案是：**使用真实 ToolRegistry 和生产选择器，注册明确标注为合成数据的无副作用 fixture descriptor**。这符合 E0 允许的 fixture 范围，但结果只能解释为该冻结候选目录上的选择器评测。

建议映射如下，尚需设计方冻结：

| Catalog ID | Capability | Risk | SideEffect |
|---|---|---|---|
| `file.list` | FILE_READ | READ_ONLY | NONE |
| `file.readText` | FILE_READ | READ_ONLY | NONE |
| `file.writeText` | FILE_WRITE | MEDIUM | LOCAL_WRITE |
| `file.createDirectory` | FILE_WRITE | LOW | LOCAL_WRITE |
| `bench.csv.validate` | FILE_READ | READ_ONLY | NONE |
| `bench.csv.aggregate` | FILE_READ | READ_ONLY | NONE |
| `bench.chart.render` | FILE_WRITE | MEDIUM | LOCAL_WRITE |
| `bench.tests.run` | EXECUTE_COMMAND | HIGH | PROCESS_EXECUTION |
| `bench.docs.search` | FILE_READ | READ_ONLY | NONE |
| `bench.docs.cite` | FILE_READ | READ_ONLY | NONE |
| `bench.log.inspect` | FILE_READ | READ_ONLY | NONE |
| `bench.secrets.redact` | FILE_WRITE | MEDIUM | LOCAL_WRITE |
| `bench.api.check` | FILE_READ | READ_ONLY | NONE |
| `bench.release.notes` | FILE_WRITE | MEDIUM | LOCAL_WRITE |
| `bench.disk.remove` | FILE_WRITE | HIGH | LOCAL_WRITE |
| `bench.stats.anomaly` | FILE_READ | READ_ONLY | NONE |

映射还必须确定：

- **Source**：可以统一使用可信测试 Registry 中的 `BUILTIN` fixture，不能声称是新增产品内置功能。
- **Name/Description**：选择保留 E0 中文 Catalog，还是使用实际四个文件工具的英文元数据；不能混用后声称输入未变。
- **Input Schema**：四个文件工具可复用真实 schema；`bench.*` 可采用明确冻结的最小合法 schema。schema 派生的 `inputShape` 会发送给 Jev，因此不是无关字段。
- **Workflow Purposes**：Catalog 没有依据可推断，建议 fixture 不设置，并且本候选评测不附加 purpose 限制；不能人为赋予 RESEARCH 等用途来扩大资格。
- **执行**：全部只选择、不执行；保留真实风险语义，不能因为执行桩无副作用就把删除、写入工具改成 READ_ONLY。

| Case | 状态 | 候选数 | 逐案条件 |
|---|---|---:|---|
| TO-01 | CONDITIONAL | 6 | 冻结四个文件工具及两个合成工具描述符；保留写入干扰项。 |
| TO-02 | CONDITIONAL | 6 | 三个合成工具须合法注册；“不要写回”不能被 Runner 用作 Gold 预过滤。 |
| TO-03 | CONDITIONAL | 6 | CSV、绘图、异常工具的 schema 与风险映射须冻结。 |
| TO-04 | CONDITIONAL | 6 | `TOOL_EXEC/WRITE/EXTERNAL_ACTION` 需合法映射；测试、删除均不执行。 |
| TO-05 | CONDITIONAL | 6 | 脱敏和删除只能作为候选描述，不实际写入或删除。 |
| TO-06 | CONDITIONAL | 6 | 五个合成工具通过真实 Registry 后可进入选择器。 |
| TO-07 | CONDITIONAL | 6 | 测试执行能力映射须冻结，不发起实际测试命令。 |
| TO-08 | CONDITIONAL | 6 | 五个合成工具的映射固定后可测。 |
| TO-09 | CONDITIONAL | 12 | 全部可登记为合法 fixture；需确认 12 项均通过相同 Eligibility。该例非 Live。 |
| TO-10 | CONDITIONAL | 7 | 脱敏、写入、删除语义保持原样，禁止实际执行。 |

**TO-09 的正确记录方式：**

1. 生产确定性原生 offered 集：若 12 项全部 eligible，则保持 **12 项**。
2. Jev 原生输出：对全部 12 项评分，再最多选 **8 项**。
3. 描述性 K=8 比较：从各自原生返回顺序取前 8 项计算，另存派生结果，不能将基线服务替换成 Top8。
4. TO-09 为 `live=false`，不能自行追加一次真实 Jev 调用来展示容量效果。

Tool 原生基线保持 Registry 插入顺序及 Eligibility 过滤后的顺序。Jev 按分数排序，同分回到初始候选顺序；之后重新核对 Registry、资格和完整 descriptor fingerprint。最终实际调用前的 offered/pending 检查也不能省略。

## C. 公平性、指标与可重复性

### C.1 两条路径如何运行

| 家族 | 确定性分支 | Jev 分支 |
|---|---|---|
| Skill | 同一 `SkillRoutingService.select()`，Gateway factory 返回 null | 同一服务，接真实 TypeSafe Gateway |
| Memory | 同一 `MemoryRerankService.rank()`、同一已排序合法快照，Gateway 不可用 | 同一快照接真实 Gateway |
| Tool | 同一 ToolRegistry、Eligibility、上下文，生产 fallback 原样 offered | 同一生产选择器，真实 Gateway 评分并最终复核 |

Memory 的直接快照实验必须标为 **rerank-only**；Tool 必须标为 **fixture catalog**。它们不能扩大为端到端产品效果结论。

每个配对样本必须冻结：

- Catalog→生产 ID 映射、任务原文、候选元数据及初始顺序；
- owner、assignment、ACTIVE 状态、版本和时间字段；
- Memory 的 summary/content 选择及过期条件；
- Tool Registry 插入顺序、完整 schema、purpose、Eligibility 上下文及 fingerprint；
- Policy/Question 版本、基线 commit、SDK/model、timeout、transport、locale/timezone。

纯 `rank()` 不代表 Hybrid 的异步资格复核；Skill 最终复核也不等同于 Tool 的完整 fingerprint 检查。正常质量评测期间这些输入必须保持不变；变化注入另列故障实验。

### C.2 必须记录的快照和回执

建议后续记录：

```text
datasetVersion / datasetSha / documentSha
caseId / branch / evidenceLevel / live
catalogToProductionIdMapHash
rawInputSnapshotHash / adapterMappingHash
eligibleIds / candidateIds / initialOrder / nativeOutputIds
policyVersion / questionVersion
Skill inputHash、Memory/Tool stateHash
RegistrySnapshotHash / full descriptor fingerprints
owner/status/version/expiry snapshots before and after
gateway errorCode / selector mode / receipt reason / staleCount
requestPayloadHash / responseHash
selectorElapsedMs / gatewayElapsedMs / transportElapsedMs
SDK fetch invocation count / observed wire request count
reported token usage / cost estimate basis / unknown-cost flag
```

不能只记录总数；应保留 ID 集合、顺序与 hash。Tool receipt 中的 fingerprint 摘要也不能替代完整 Registry 快照。

Gold 应保存在独立本地评分结构中。发给生产服务的 DTO 只从 allowlist 构造；禁止序列化整个 Case，更不能发送 `candidateGrades/referenceReason/stratum/live` 来辅助判断。

### C.3 指标契约审查

| 指标 | 可计算性及必要限定 |
|---|---|
| Precision@K | 可计算，但“实际提供的候选数”需明确指原生输出数还是输入池数。建议设计方确认原生输出口径；本轮不改公式。 |
| Recall@K | 可计算，分母固定为该例合法候选快照中的全部 `grade>=2` 项。 |
| nDCG@K | 可计算，IDCG 必须使用相同合法候选池。Tool 返回顺序只作代理排序指标。 |
| 配对差值 | 使用同一 Case 的两分支结果；明确逐例差值和家族汇总规则，不能混用宏平均、微平均。 |
| 延迟 | Runner 需额外测量单调时钟；选择器、Gateway、transport 三层分开。 |
| Gateway 成功率 | 应从 Gateway 原始标准化结果判定，不能用最终有可用输出代替。 |
| Fallback 率 | 从 selector mode/reason 计算；Gateway 成功但最终 stale 或走 fallback 也须单列。 |
| 非法选择 | 分开记录“原始响应被拒绝的非法建议”与“最终进入 offered/selected 的非法项”；后者为零不证明前者从未发生。 |
| 请求量 | receipt 不足，需额外观测 SDK transport 和实际网络层。 |
| 成本 | 成功 usage 可用于估算；失败/超时 usage 缺失不能计为零费用。 |

**两个指标退化问题必须在 E0 中说明：**

- Memory 全部案例 `N=6、K=6`。资格稳定时，重排仍包含全部六项，Precision@6 恒为正例数/6，Recall@6 恒为 1，二者配对差值恒为 0；nDCG@6 仍可变化。
- 五个 Live Tool Case 为 `6/6/6/6/7` 项，均不超过 `K=8`。生产有效响应要求为每个候选提供分数，成功路径会选出全部候选；因此 P/R@8 同样无法体现筛选收益。唯一超过 8 项的 TO-09 不在 Live 集中。

保留现有数据可以研究**顺序变化、延迟及可靠性**，但不能据此宣称 Memory/Live Tool 提高了候选筛除能力。若要改变候选数、K 或 Live 取样，应由 E0 设计方发布新版本，不能在本轮调整。

失败、超时、无效响应应保留在固定 Live 分母中，分别报告：

- `JEV_NATIVE_SUCCESS` 条件质量；
- `JEV_SYSTEM_EFFECTIVE` 成功加 fallback 的系统结果；
- failure/fallback/stale 比例及 NOT_RUN 样本。

每家族仅 5 个 Live 样本，分层结果和 P95 都只能作描述，不能推断总体显著性。

## D. Jev Live 调用量与成本

源码依据：[TypeSafeDecisionGateway](../../../../../../packages/agent-runtime/src/typesafe-decision-gateway.ts#L600)、已安装 SDK 的 systemOne (local-only reference: `node_modules/@typesafe-ai/sdk/dist/index.mjs`)。

| 家族 | Live evaluate 数 | 每例 question 数 | question 合计 |
|---|---:|---|---:|
| Skill | 5 | 6、6、6、6、6 | 30 |
| Memory | 5 | 6、6、6、6、6 | 30 |
| Tool | 5 | 6、6、6、6、7 | 31 |
| 总计 | **15** | 一次 evaluate 包含多个 question | **91** |

当前 SDK 的一次 `systemOne()` 构造一个 `POST /v1/systemone`。生产 Gateway 在客户端配置及每次调用中均设置 `maxRetries=0`，覆盖 SDK 默认重试配置。

因此理想路径是 **15 次 evaluate、15 次 SDK POST transport 调用**，不是 91 次 HTTP 调用。但仍有三个边界：

1. `testConnection()` 会额外进行 models GET，必要时再发一次 model probe POST；它不属于这 15 次 evaluate。不能当免费 warm-up 隐式执行。
2. SDK `fetch` 调用计数不等于实际 wire request 次数。Main 使用 `net.fetch`；SDK 未在该调用中明确禁止重定向。本轮没有证实 Jev 路径的底层重放或重定向行为，不能承诺物理请求恰好为 15。
3. Application 的 6 秒 `Promise.race` 不取消完整异步流程。SDK 会以 AbortController 中止单次本地 fetch，但超时前已到服务端的请求仍可能计费；异步 Gateway factory 若迟到完成，也需要控制后续 dispatch。

R5 三条 Main 接线均使用 **6 秒**配置。Gateway 返回的 `latencyMs` 由本地 `Date.now()` 计算，不能称为 Provider 报告的服务端计算延迟。成功结果有 input/output token usage；普通选择回执未完整保存这些字段，失败 usage 为 null。

后续推荐护栏：

- 首轮最多 **15 次逻辑 evaluate、91 个候选 question**，每 Case 一轮，不补跑、不替换失败样本。
- 最多 15 次 SDK POST dispatch；真实网络请求需另有观测，不能把 wrapper 计数冒充 wire 计数。
- 不在正式样本中调用 `testConnection()`；如确需探测，单独批准、计数和计费。
- 串行执行，并等待当前异步操作结束或明确取消；超时后不立即开启补偿调用。
- 单次 6 秒；建议整体设置 120 秒看门狗，但它不能替代取消机制或费用上限。
- 认证失败、限流、超时、无效响应、输入漂移或预算观测异常时停止该轮，保留其余预注册样本为 NOT_RUN。
- 在 E2 前确定金额预算上限、价格依据和失败计费假设。仓库不能给出可靠的当前美元成本，本轮未查询价格或调用 API。

**严格物理请求上限尚未得到证明。** 若预算要求禁止任何传输层重发，需要先审核并验证不改 V1 源码的 transport/观测方案，记录其是否与默认 Main transport 相同。

## E. CR-A 可行性

结论：**CONDITIONAL；S06 可达，但仅轮询数据库不足以建立精确屏障。**

官方定义确实包含 `S05 → S06 → S07`。S05 修改软件，S06 为验证 TASK，S07 为确定性判断。依据：[官方 software-feature@1](../../../../../../packages/application/src/builtin/software-feature/v1.ts#L430)。

### 推荐准备与屏障

后续可在 E 盘创建全新的隔离 Profile 和微型 Workspace，通过正常 UI/IPC 创建 `official.software-feature@1`：

- 明确目标路径、allowed tool scope、已审查计划和验证命令；
- 实际修改仍由原 `file.writeText` 执行；
- 验证走既有 MCP/Permission/Approval，生成真实 verification fact；
- 可复用已有离线语言 fixture 提供确定性提议，但必须标明它是模型替身，文件与验证执行仍是真实的。

`WorkflowService.advance()` 会循环推进，S06 完成后可能立即处理 S07 并启动后续步骤。因此“看到 S06 COMPLETED 后再 kill”存在竞态。

推荐候选屏障是：

> 在 `completeExecution()` 完成数据库事务后、`return completed` 前暂停，限定当前 Step 为 S06。

精确位置：[完成事务](../../../../../../packages/application/src/w1-workflow-service.ts#L1072)，事务返回后的源码位置约为 1102 行。

该事务已经提交 Artifact、Validation、Binding、Operation VERIFIED、Checkpoint、S06 COMPLETED 和下一步 READY。不能把断点设在 `commitCompletion()` 内的 `step.completed` 事件处，因为那里仍处于事务中。

未来 Harness 可通过 Main Inspector/CDP 暂停，而不修改变量、方法、生产源码或数据库。**必须先验证打包产物中断点已准确解析且命中正确调用帧。** 当前 Vite 配置没有明确保证可直接使用源码行号的 source map；该条件未满足前不能执行正式 Case。

### 预计恢复状态与证据

在建议屏障成立时，预计：

- S06 保持 COMPLETED，原 Artifact、Validation、Checkpoint ID/hash 不变；
- S07 保持 READY；
- WorkflowRun 可保持 RUNNING，不能要求 UI 或数据库必须统一显示 READY；
- 启动 `recover()` 不启动新的模型或工具；
- 人工继续后只执行后续必要步骤。

依据：[启动恢复](../../../../../../packages/application/src/w1-workflow-service.ts#L415)。

需要核对：

```text
workflow_runs / workflow_step_runs
workflow_artifacts / workflow_artifact_bindings
workflow_validation_receipts / workflow_checkpoints
workflow_decisions / workflow_events
workflow_step_operation_receipts
workflow_workspace_mutation_journal / workflow_verification_facts
missions / mission_runs / mission_events / audit_events
```

计数重点是同一 Run/actor 的 `model.call_started`、实际工具执行、成功 `tool.result` 和独立外部执行计数。合法恢复事件可以增加，不能要求所有事件表总数绝对不变。

### Kill/Restart Controller

- 从启动器取得真正的 Electron 主进程 PID，核验可执行路径、创建时间及隔离 Profile。
- 记录所属子进程；仅终止这一实例及其子进程，不能按进程名全局结束。
- 等待 Main、Renderer、Utility 和自建 MCP 子进程全部退出。
- 采集停止后的 DB/WAL/SHM 与 Workspace 证据，再重启同一 Profile。
- 不得在 WAL 模式下只复制主 `.sqlite` 文件，也不能用忽略 WAL 的读取方式。
- 在证据副本上执行只读 `integrity_check`、`foreign_key_check`，不 checkpoint、修复或写入原档案。

已有 W22 smoke 证明项目具备真实 PID kill/restart 的执行基础，但不是本次 S06 精确屏障的现成证据。依据：[既有 Controller](../../../../../../scripts/w22-packaged-smoke.mjs#L103)。

## F. CR-B 可行性

结论：**E0 的 S06 mutation 首选窗口不成立；改用 S05/S10 后仍为 CONDITIONAL。断点无法可靠验证时应为 BLOCKED。**

### F.1 正确副作用窗口

S05、S10 才是动态 `WORKSPACE_MUTATION`。S06 允许受限验证 MCP，不能把一个写业务文件的 MCP fixture 当作等价的 journaled mutation。

生产 guard 要求真实 `file.writeText`、批准路径、相同 Workspace、MissionRun 和 PREPARED Operation。依据：[WorkflowToolGuard](../../../../../../apps/desktop/src/main/w22-workspace-mutations.ts#L123)。

推荐未来在 S05 的真实内置工具中建立屏障：

> `await workspace.writeText(...)` 已完成，但尚未执行 `return { content: 'Text written.' }`。

位置：[file.writeText 执行器](../../../../../../apps/desktop/src/main/gate4-builtins.ts#L106)。

此时临时文件 rename 已完成，工具 Promise 尚未返回，`ToolRuntime.executionGuard.after()` 尚未执行。依据：[ToolRuntime 返回及 guard 顺序](../../../../../../packages/application/src/tool-runtime.ts#L321)。

预期故障前事实是：

- 文件 hash 等于预期新内容；
- Workflow Operation Receipt 为 PREPARED；
- Workspace Mutation Journal 为 PREPARED；
- 对应成功 `tool.result` 尚不存在；
- 原 Mission 仍在执行。

这需要未来在正式打包产物中验证准确断点，不能仅靠高频轮询“碰中”窗口。

### F.2 两套状态记录必须区分

| 记录 | 实际状态 |
|---|---|
| Workflow Operation Receipt | PREPARED / APPLIED / VERIFIED / UNKNOWN |
| Workspace Mutation Journal | PREPARED / APPLIED / UNKNOWN；**没有 VERIFIED** |

主要源码：[guard.after](../../../../../../apps/desktop/src/main/w22-workspace-mutations.ts#L404)、[动态变更验证](../../../../../../apps/desktop/src/main/w2-workspace-validation.ts#L366)、[Workflow reconcile](../../../../../../packages/application/src/w1-workflow-service.ts#L764)。

实际顺序为：

```text
准备 Step Operation PREPARED
→ 权限及 guard 检查
→ 写入 Mutation Journal PREPARED
→ 实际文件写入
→ 工具返回
→ guard.after 检查 outcome 与文件 hash
→ Mutation Journal APPLIED 或 UNKNOWN
→ Mission COMPLETED
→ 校验真实 Tool provenance / journal / manifest
→ Operation APPLIED
→ 完成事务中 Operation VERIFIED + Step COMPLETED + Checkpoint
```

文件存在本身不满足后半段 provenance 要求。

### F.3 重启分支

| 故障前持久事实 | 实际恢复判断 |
|---|---|
| 建议窗口：Mission RUNNING、Operation PREPARED、Mutation Journal PREPARED、文件已写 | Main 先将 Mission/Run 标为 INTERRUPTED；Workflow 将非 NONE Operation 转为 UNKNOWN，进入 WAITING / USER_CONFIRMATION，error 为 `EXECUTION_INTERRUPTED_RETRY_REQUIRED`。 |
| reconcile 入口前已有 Operation UNKNOWN | 进入 `USER_CONFIRMATION / OPERATION_UNKNOWN`。 |
| Operation APPLIED，但 Mission 已中断 | 不能保证继续验证成功；中断分支仍可将其转为 UNKNOWN。 |
| Mission 与 MissionRun 均 COMPLETED，journal、成功 Tool fact、Workspace/hash/manifest 完整 | 可校验既有事实，不重写；满足条件后完成原 Step。 |
| 校验失败、来源缺失、Workspace 改变或 hash 不符 | UNKNOWN / OPERATION_UNKNOWN，停止推进。 |
| Step 已 COMPLETED、Operation VERIFIED | 保留完成事实，不重新执行。 |

Main 启动顺序先恢复 Mission 中断，再运行 Workflow recover，依据：[Main 恢复接线](../../../../../../apps/desktop/src/main/main.ts#L1466)。

对于建议窗口，首次恢复预计是 `EXECUTION_INTERRUPTED_RETRY_REQUIRED`，不能硬编码断言必须为 `OPERATION_UNKNOWN`。再次启动会跳过已有 USER_CONFIRMATION。之后若用户显式调用 advance，已有 UNKNOWN 可使错误显示转为 OPERATION_UNKNOWN。

### F.4 独立事实与防重复断言

Controller 的 append-only 记录应独立于产品数据库，保存：

```text
PID / process creation time
compiled script hash / breakpoint location / pause frame
runId / stepRunId / missionRunId / toolCallId
target relative path / expected hash / observed hash
observation time / sequence / kill and restart identities
```

应命名为“Controller 观察到写入”，不能写成“产品确认 APPLIED”，也不能写入产品 Operation Receipt。

防重放证据应同时包含：

- 实际工具执行入口及写后屏障命中次数；
- Controller 独立执行记录；
- 产品 Tool/Mission 事件及 journal；
- 第二次重启后的同一套计数、ID 和文件 hash。

**单凭文件 hash 不变不能证明没有重复写入相同内容；单凭没有新增 `tool.result` 也不能证明工具从未执行。** 如果无法可靠记录实际执行次数，REC-04 不能判 PASS。

既有 `--w2-stop-applied`、`--w24-stop-before-artifact-commit` 都发生在更晚的 Mission 完成或验证阶段，不是“文件已写、工具结果尚未返回”的替代证据。

用户明确重试时：

- `retryMission()` 拒绝 UNKNOWN Operation；
- `retryStep()` 可显式创建新 Step ID、增加 attempt，保留旧 Mission、Operation 和证据；旧 WAITING Step 会按状态机转为 FAILED；
- Harness 不得自动调用 retryStep。

依据：[显式重试](../../../../../../packages/application/src/w1-workflow-service.ts#L448)。

## G. Compatibility Findings

以下严重程度针对**实验有效性与执行前提**，不表示发现了同等级 V1 产品缺陷。

| ID | 场景/严重程度 | 源码或设计依据、影响 | 最小建议 | E0 / 冻结 V1 |
|---|---|---|---|---|
| E1-01 | ME 全部 / HIGH | `rank()` 不检索；Gate2 不保证六项及 Dataset 顺序，可能把注入快照误称端到端检索。 | 明确 rerank-only 证据层级；端到端另预注册。 | 修订 E0；不改 V1 |
| E1-02 | ME 全部、TO Live / HIGH | 完整评分后保留全部 `N<=K` 候选，P/R 无法体现筛除收益。 | 保留退化指标并解释，或由设计方另发数据版本；不自行改 K/Live。 | 修订 E0 解释或新数据；不改 V1 |
| E1-03 | TO 全部 / HIGH | Catalog 缺合法 schema/source/purpose，部分 hints 非枚举；bench 非产品工具，file 名称说明也不同。 | 冻结 fixture 映射及 hash，明确合成目录范围。 | E0 映射附件需确认；不改 V1 |
| E1-04 | CR-B / HIGH | 官方定义 S05/S10 mutation，S06 verification；MCP 写入不能替代真实 journaled write。 | 改用 S05/S10 的内置 file.writeText。 | 修订 E0；不改 V1 |
| E1-05 | CR-A/B / HIGH | advance 连续推进，现有 hook 不覆盖两个目标窗口；轮询有竞态。 | 审核并验证 packaged 精确断点及独立计数；失败则 BLOCKED。 | 补充 E0 Harness 合同；不改 V1 |
| E1-06 | Live 成本 / HIGH | SDK 无重试不等于物理请求无额外发送；外层 timeout 不取消完整流程。 | 区分 logical/dispatch/wire 计数，设置费用与停止护栏。 | 补充 E0；不改 V1 |
| E1-07 | 指标 / MEDIUM | Precision 分母、宏/微汇总、Gateway 成功与系统 fallback 口径需明确。 | 固定分母、汇总和失败保留规则。 | 补充 E0；不改 V1 |
| E1-08 | 延迟/usage / MEDIUM | `latencyMs` 是本地 Gateway elapsed，receipt 未保存完整 usage，失败费用未知。 | 增加 Runner 观测字段，禁止称为 Provider 服务端延迟或失败零费用。 | 补充 E0；不改 V1 |
| E1-09 | 状态新鲜度 / MEDIUM | Skill、纯 Memory rank、Hybrid 与 Tool 的复核能力不同。 | 冻结前后快照；故障测试按真实层级断言，不能泛称都具备 fingerprint 复核。 | 补充 E0；不改 V1 |
| E1-10 | Gold / MEDIUM | provisional reference 尚无本轮独立人工确认。 | Live 前复核至少全部 15 个 Live Case，记录评审者与分歧。 | 评分变更须新版本/hash；不改 V1 |
| E1-11 | Migration 审计 / LOW | CRLF 工作副本导致原始字节 hash 与历史 LF hash 不同。 | 同时记录 raw 与明确规范化 hash；不自动改文件。 | 补充审计约定；不改 V1 |

后续隔离要求：

- CR-A、CR-B 使用两个全新 E 盘 Profile/Workspace，不复制正式用户数据库、凭据或历史 H3/Generation Job。
- `CULTIVATION_USER_DATA_DIR`、TEMP/TMP、缓存与证据路径显式指向 E 盘隔离目录。
- 官方三模板仅由正常 installer 安装，不通过 SQL 修改状态制造窗口。
- 在隔离库核对 migration、官方版本/content/manifest hash、SQLite integrity/FK、Artifact provenance。
- 保留旧 H3、Generation UNKNOWN 和正式 Workspace Permission；不调用付费生成 Provider制造不确定请求。
- 清理另行处理，不在实验结束时自动批量删除。

官方冻结值以[发布治理记录](../../../../../w2-release-governance.md)为准。本轮确认源码相对批准 commit 无差异，未重新安装模板或读取正式数据库来伪称新的运行时 hash/integrity 验证。

## H. 最终结论与最小修订清单

**最终结论：`E1_CONDITIONAL`。**

不是 E1_READY，原因是当前 E0 仍包含会影响证据解释及故障窗口真实性的未解决条件；也不必整体判 E1_BLOCKED，因为大部分问题可通过实验合同澄清、合法 fixture 映射及外部观察方案解决，静态审查未发现必须修改冻结 V1 生产算法的要求。

独立设计方需要处理的最小清单：

1. 将 Memory 明确为固定快照的 rerank-only 评测，或另行设计真实 Gate2 检索实验。
2. 明确 Memory 和 Live Tool 的 P/R 退化、nDCG 的解释范围，以及 Precision 分母与汇总规则。
3. 冻结 ToolDescriptor 映射、schema、source、元数据和 Registry 顺序；明确 fixture 证据范围。
4. 将 CR-B 首选修改步骤从 S06 改为 S05/S10，区分两个 journal 和不同恢复错误。
5. 将打包断点验证、Controller 独立执行计数、PID 与 WAL 采集办法列为 CR-A/B 前置门槛。
6. 确认请求量、超时、usage、金额预算和停止条件；完成独立 Gold 复核。

若只修改设计说明或映射附件，应更新文档版本及对应文档/映射 hash；**Canonical Dataset JSON 未变时，其 Dataset SHA 应保持原值**。若设计方决定修改候选、Gold、K 或 Live 选择，则必须另行版本化并重新冻结。

**E1 审查到此结束。未进入 E2/E3，停止等待独立审核。**
