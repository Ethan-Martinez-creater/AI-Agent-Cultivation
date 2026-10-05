import { createHash, randomUUID } from 'node:crypto';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { ModelRequest, ModelToolResponse } from '@cultivation/application';
import type {
  ToolDescriptor,
  WorkflowArtifact,
  WorkflowDetail,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from '@cultivation/domain';
import { isSafeWorkflowRelativePath } from '@cultivation/domain';

export const RESEARCH_WORKFLOW_ID = 'official.research';

type FixtureContext = { detail: WorkflowDetail; step: WorkflowStepRun };
type ContextResolver = (request: ModelRequest) => FixtureContext | null;
type InputRecord = Record<string, unknown>;
export type FixtureFile = {
  outputKey: string;
  relativePath: string;
  bytes: Uint8Array;
  contentHash: string;
  mediaType: string;
};
export type ResearchFixtureOutputs = {
  outputs: Readonly<Record<string, unknown>>;
  files: readonly FixtureFile[];
};

type TranscriptToolCall = {
  toolCallId: string;
  toolId: string;
  input: InputRecord;
};
type TranscriptToolResult = TranscriptToolCall & {
  ok: boolean;
  content: InputRecord | null;
  rawContent: string;
};
type ResearchSource = {
  sourceId: string;
  sourceArtifactId: string;
  title: string;
  authors: string[];
  year: number;
  source: string;
  url: string;
  doi: string;
  identifier: string;
  discoveryMethod: 'RESEARCH_TOOL' | 'USER_SOURCE_ARTIFACT';
  discoveryToolId: string;
  sourceContentHash: string;
  summary: string;
};
export type ResearchExperimentFixtureEvidence = {
  attemptNumber: number;
  attemptId: string;
  operationKey: string;
  planArtifactId: string;
  status: 'COMPLETED' | 'FAILED';
  method: string;
  negativeResult: boolean;
  rawResult: { relativePath: string; contentHash: string };
  experimentLog: { relativePath: string; contentHash: string };
  metrics: Array<{ name: string; value: string; unit: string; uncertainty: string }>;
  failureDetails: string[];
  limitations: string[];
  reproducibilityNotes: string[];
};
type ExperimentEvidence = ResearchExperimentFixtureEvidence;

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_TOOL_RESULTS = 20;
const TOOL_NAMES = { sources: 'research_sources', experiment: 'run_experiment' } as const;

function record(value: unknown): value is InputRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const result = { ...value };
  delete result[key];
  return result;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`W2.3 fixture received invalid ${label}`);
  return value;
}

function inputs(detail: WorkflowDetail): InputRecord {
  return detail.run.inputSnapshot ?? {};
}

function stringInput(detail: WorkflowDetail, key: string, fallback = ''): string {
  const value = inputs(detail)[key];
  return typeof value === 'string' ? value : fallback;
}

function boundedText(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function stepDefinition(detail: WorkflowDetail, step: WorkflowStepRun): WorkflowStepDefinition {
  const definition = detail.version.steps.find((candidate) => candidate.id === step.stepId);
  if (!definition)
    throw new Error(`W2.3 fixture step ${step.stepId} is absent from frozen version`);
  return definition;
}

function workflowOutputText(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  values: Readonly<Record<string, unknown>>,
): string {
  const definition = stepDefinition(detail, step);
  const textOutputs = definition.outputs.filter(
    (output) => output.kind === 'TEXT' || output.kind === 'JSON',
  );
  if (textOutputs.length === 0) return JSON.stringify({ ok: true });
  const declaredValues = Object.fromEntries(
    textOutputs
      .filter((output) => Object.hasOwn(values, output.key))
      .map((output) => [output.key, values[output.key]]),
  );
  if (definition.outputs.length > 1) return JSON.stringify({ outputs: declaredValues });
  const only = textOutputs[0]!;
  if (!Object.hasOwn(declaredValues, only.key))
    throw new Error(`W2.3 fixture did not produce declared output ${only.key}`);
  return JSON.stringify(declaredValues[only.key]);
}

function toolTranscript(request: ModelRequest): TranscriptToolResult[] {
  const calls = new Map<string, TranscriptToolCall>();
  for (const message of request.messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call' && record(part.input))
        calls.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          toolId: part.toolName,
          input: part.input,
        });
    }
  }
  const results: TranscriptToolResult[] = [];
  for (const message of request.messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      const call = calls.get(part.toolCallId);
      const value = part.output.value;
      if (!call || call.toolId !== part.toolName || value.toolId !== part.toolName) continue;
      results.push({
        ...call,
        ok: value.ok,
        content: record(parseJson(value.content))
          ? (parseJson(value.content) as InputRecord)
          : null,
        rawContent: value.content,
      });
    }
  }
  return results.slice(-MAX_TOOL_RESULTS);
}

function structuredWorkflowEvidence(result: TranscriptToolResult): InputRecord | null {
  const structured = result.content?.structuredContent;
  const workflowEvidence = record(structured) ? structured.workflowEvidence : null;
  return record(workflowEvidence) ? workflowEvidence : null;
}

function response(
  request: ModelRequest,
  text: string,
  toolCalls: ModelToolResponse['toolCalls'] = [],
): ModelToolResponse {
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: request.messages.reduce(
        (total, message) =>
          total + (typeof message.content === 'string' ? message.content.length : 0),
        0,
      ),
      outputTokens: text.length + toolCalls.length,
      cachedInputTokens: null,
      reasoningTokens: null,
    },
  };
}

function caseKind(
  detail: WorkflowDetail,
): 'ALGORITHM' | 'DATASET' | 'EXTERNAL' | 'MIXED' | 'LIMIT' {
  const question = stringInput(detail, 'researchQuestion').toLowerCase();
  if (/case[-_ ]?limit|budget[-_ ]?limit|循环上限/.test(question)) return 'LIMIT';
  const mode = stringInput(detail, 'experimentMode');
  if (mode === 'HUMAN_OR_EXTERNAL') return 'EXTERNAL';
  if (mode === 'MIXED') return 'MIXED';
  if (
    /case[-_ ]?b|dataset|数据集/.test(question) ||
    (Array.isArray(inputs(detail).existingData) &&
      (inputs(detail).existingData as unknown[]).length > 0)
  )
    return 'DATASET';
  return 'ALGORITHM';
}

function currentInputs(detail: WorkflowDetail, step: WorkflowStepRun): string[] {
  return detail.bindings
    .filter((binding) => binding.stepRunId === step.id && binding.role === 'INPUT')
    .map((binding) => binding.artifactId);
}

function inputArtifact(detail: WorkflowDetail, step: WorkflowStepRun, keys: readonly string[]) {
  const binding = detail.bindings.find(
    (candidate) =>
      candidate.stepRunId === step.id && candidate.role === 'INPUT' && keys.includes(candidate.key),
  );
  return detail.artifacts.find((artifact) => artifact.id === binding?.artifactId);
}

function artifactValue(artifact: WorkflowArtifact | undefined): unknown {
  return artifact ? parseJson(artifact.content) : null;
}

function artifactsForOutput(
  detail: WorkflowDetail,
  outputKeys: readonly string[],
): WorkflowArtifact[] {
  const boundIds = new Set(
    detail.bindings
      .filter((binding) => binding.role === 'OUTPUT' && outputKeys.includes(binding.key))
      .map((binding) => binding.artifactId),
  );
  return detail.artifacts
    .filter((artifact) => {
      const key = artifact.metadata.outputKey ?? artifact.metadata.logicalKey;
      return boundIds.has(artifact.id) || (typeof key === 'string' && outputKeys.includes(key));
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function latestArtifact(
  detail: WorkflowDetail,
  outputKeys: readonly string[],
): WorkflowArtifact | undefined {
  return artifactsForOutput(detail, outputKeys).at(-1);
}

function literatureSourceArtifactIds(detail: WorkflowDetail): string[] {
  const literature = latestArtifact(detail, ['research.literature']);
  const value = artifactValue(literature);
  return record(value) && Array.isArray(value.sources)
    ? value.sources
        .flatMap((source) =>
          record(source) && typeof source.sourceArtifactId === 'string'
            ? [source.sourceArtifactId]
            : [],
        )
        .slice(0, 20)
    : [];
}

function researchSourcesFromResult(result: TranscriptToolResult): ResearchSource[] {
  const evidence = structuredWorkflowEvidence(result);
  const evidenceRows = Array.isArray(evidence?.researchSources) ? evidence.researchSources : [];
  const parsed = result.content?.content;
  const textParts = Array.isArray(parsed)
    ? parsed.flatMap((part) => (record(part) && typeof part.text === 'string' ? [part.text] : []))
    : [];
  const payload = textParts.map(parseJson).find(record);
  const sourceRows = Array.isArray(payload?.sources) ? payload.sources : [];
  const factByHash = new Map<string, InputRecord>();
  for (const row of evidenceRows) {
    if (
      record(row) &&
      typeof row.contentHash === 'string' &&
      /^[a-f0-9]{64}$/.test(row.contentHash) &&
      typeof row.url === 'string'
    )
      factByHash.set(row.contentHash, row);
  }
  return sourceRows.flatMap((row) => {
    if (
      !record(row) ||
      typeof row.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.contentHash) ||
      typeof row.url !== 'string'
    )
      return [];
    const fact = factByHash.get(row.contentHash);
    if (!fact || fact.url !== row.url) return [];
    const sourceArtifactId =
      typeof fact.sourceArtifactId === 'string'
        ? fact.sourceArtifactId
        : `source-${row.contentHash}`;
    if (sourceArtifactId !== `source-${row.contentHash}`) return [];
    return [
      {
        sourceId: sourceArtifactId,
        sourceArtifactId,
        title: boundedText(row.title, 500),
        authors: Array.isArray(row.authors)
          ? row.authors
              .filter((author): author is string => typeof author === 'string')
              .slice(0, 30)
          : [],
        year: Number.isInteger(row.year) ? (row.year as number) : 2000,
        source: boundedText(row.source, 300),
        url: row.url,
        doi: boundedText(row.doi, 300),
        identifier: boundedText(row.identifier || row.url, 500),
        discoveryMethod: 'RESEARCH_TOOL' as const,
        discoveryToolId: result.toolId,
        sourceContentHash: row.contentHash,
        summary: boundedText(row.summary, 1800),
      },
    ];
  });
}

function toolByName(
  request: ModelRequest & { tools: ToolDescriptor[] },
  name: string,
): ToolDescriptor {
  const found = request.tools.find((candidate) => {
    const withWireName = candidate as ToolDescriptor & { toolName?: string };
    return (
      withWireName.toolName === name ||
      candidate.id.endsWith(`:${name}`) ||
      candidate.id.endsWith(`.${name}`)
    );
  });
  if (!found || found.source !== 'MCP' || !found.workflowPurposes?.includes('RESEARCH'))
    throw new Error(`W2.3 fixture is missing a user-bound RESEARCH MCP tool: ${name}`);
  return found;
}

function proposeTool(
  request: ModelRequest & { tools: ToolDescriptor[] },
  tool: ToolDescriptor,
  input: InputRecord,
): ModelToolResponse {
  return response(request, '', [{ id: `w23-${randomUUID()}`, toolId: tool.id, input }]);
}

function sourceRows(detail: WorkflowDetail, request: ModelRequest): ResearchSource[] {
  const toolResults = toolTranscript(request);
  const sourceResult = toolResults.find((result) =>
    result.toolId.endsWith(`:${TOOL_NAMES.sources}`),
  );
  if (sourceResult && !sourceResult.ok)
    throw new Error('W2.3 R02 research Tool failed; refusing to use model-memory citations');
  if (!sourceResult) return [];
  return researchSourcesFromResult(sourceResult).filter((source) => {
    const timeRange = inputs(detail).literatureTimeRange;
    if (!record(timeRange) || typeof timeRange.from !== 'string' || !Number.isInteger(source.year))
      return true;
    const fromYear = Number(timeRange.from.slice(0, 4));
    const toYear = typeof timeRange.to === 'string' ? Number(timeRange.to.slice(0, 4)) : Infinity;
    return source.year >= fromYear && source.year <= toYear;
  });
}

function literatureOutput(detail: WorkflowDetail, request: ModelRequest) {
  const sources = sourceRows(detail, request);
  if (sources.length === 0)
    throw new Error(
      'W2.3 R02 cannot emit citations without a matching successful research Tool fact',
    );
  const toolId = sources[0]!.discoveryToolId;
  return {
    sources: sources.map((source) => omit(source, 'summary')),
    searchMethods: [
      {
        methodId: 'offline-mcp-source-discovery',
        description: '通过本地 Research MCP 搜索来源并记录稳定 URL 与来源内容哈希。',
        discoveryToolId: toolId,
        sourceArtifactIds: sources.map((source) => source.sourceArtifactId),
      },
    ],
    searchLimitations: ['离线验收仅使用固定来源快照，不代表实时文献检索或完整覆盖。'],
  };
}

// Read a producer output by its stable logical key from the current run's durable Artifact facts.
function producerValue(detail: WorkflowDetail, keys: readonly string[]): unknown {
  return artifactValue(latestArtifact(detail, keys));
}

function screeningAndEvidence(detail: WorkflowDetail) {
  const literature = producerValue(detail, ['research.literature']);
  const sources = record(literature) && Array.isArray(literature.sources) ? literature.sources : [];
  const kind = caseKind(detail);
  const screenings = sources.flatMap((entry, index) => {
    if (!record(entry)) return [];
    const include =
      kind === 'DATASET'
        ? String(entry.title).toLowerCase().includes('iris')
        : String(entry.title).toLowerCase().includes('tail at scale');
    const sourceId = String(entry.sourceId ?? '');
    const sourceArtifactId = String(entry.sourceArtifactId ?? '');
    if (!sourceId || !sourceArtifactId) return [];
    return [
      {
        sourceId,
        sourceArtifactId,
        decision: include ? 'INCLUDED' : 'EXCLUDED',
        reason: include
          ? '该来源与冻结研究范围直接相关，且具有可核验的来源 Artifact。'
          : '该来源主题与本次冻结研究范围不符，保留排除记录以供审计。',
        criteria: [include ? '主题相关' : '主题不匹配', '来源标识与内容哈希可追溯'],
        include,
        index,
      },
    ];
  });
  const claims = screenings.flatMap((screening) => {
    if (!screening.include) return [];
    const source = sources.find((entry) => record(entry) && entry.sourceId === screening.sourceId);
    const title = record(source) ? String(source.title) : '来源记录';
    return [
      {
        evidenceId: `evidence-${screening.sourceArtifactId.slice('source-'.length, 25)}`,
        sourceId: screening.sourceId,
        sourceArtifactId: screening.sourceArtifactId,
        claim:
          kind === 'DATASET'
            ? `${title} 是一个可追溯来源所列的分类数据集。`
            : `${title} 讨论大型在线服务中的尾延迟问题。`,
        evidence:
          '此内容是离线 Source Artifact 中来源元数据与摘要的受限概述，不代表完整论文或独立实验结果。',
        method: '来源页面元数据与离线快照摘要核对。',
        populationOrDataset:
          kind === 'DATASET' ? 'Iris 数据集条目' : '大型在线服务（来源摘要所述）',
        metric: '来源条目主题与可追溯标识',
        result:
          kind === 'DATASET'
            ? '来源目录将 Iris 标识为分类数据集；未声称复现实验。'
            : '来源出版记录描述尾延迟问题；未声称复现实验。',
        limitations: ['离线快照不包含完整全文；不能据此声称已复现原研究。'],
        status: 'EVIDENCE',
      },
    ];
  });
  return {
    screening: {
      sources: screenings.map((source) => omit(omit(source, 'include'), 'index')),
      screeningNotes: ['Included 与 Excluded 来源均保留单独理由。'],
    },
    evidence: { claims },
  };
}

function gapsOutput(detail: WorkflowDetail) {
  const evidence = producerValue(detail, ['research.evidence']);
  const ids =
    record(evidence) && Array.isArray(evidence.claims)
      ? evidence.claims.flatMap((claim) =>
          record(claim) && typeof claim.evidenceId === 'string' ? [claim.evidenceId] : [],
        )
      : [];
  return {
    landscape: `# 已有证据\n\n离线来源快照提供了可追溯的背景线索，但不是本次实验结果。\n\n# 推断\n\n当前证据可帮助提出可检验问题，不能证明实验假设。\n\n# 未知\n\n${ids.length ? '样本范围、运行环境差异与结果不确定性仍需实验验证。' : '当前没有通过筛选的证据来源；研究结论保持未知。'}`,
    gaps: {
      gaps: [
        {
          gapId: 'gap-measurement-variability',
          description: '在给定运行条件下量化目标方法的效果与不确定性。',
          classification: 'UNKNOWN',
          evidenceIds: ids,
          rationale: '现有来源不能替代本 Workflow 的可复现实验。',
          uncertainty: '样本量和环境差异可能显著影响观察结果。',
        },
      ],
    },
  };
}

function hypothesesOutput(detail: WorkflowDetail) {
  const evidence = producerValue(detail, ['research.evidence']);
  const evidenceIds =
    record(evidence) && Array.isArray(evidence.claims)
      ? evidence.claims.flatMap((claim) =>
          record(claim) && typeof claim.evidenceId === 'string' ? [claim.evidenceId] : [],
        )
      : [];
  const question = stringInput(detail, 'researchQuestion', '冻结研究问题');
  return {
    hypotheses: [
      {
        hypothesisId: 'hypothesis-primary',
        statement: `在冻结研究范围内，所选方案相对基线会对“${question.slice(0, 180)}”产生可测量影响。`,
        rationale: '现有来源用于提出可检验问题，不作为本实验结果。',
        supportingEvidenceIds: evidenceIds,
        contradictingEvidenceIds: [],
        assumptions: ['运行条件和样本记录足以支持有限比较。'],
        testability: '使用冻结计划中的基线、指标和重复试验检验。',
        proposedEvaluation: '记录每次运行、指标、失败情况与不确定性。',
      },
    ],
  };
}

function planArtifact(detail: WorkflowDetail, step: WorkflowStepRun): WorkflowArtifact | undefined {
  const bound = inputArtifact(detail, step, ['experiment_plan', 'plan']);
  if (bound) return bound;
  return latestArtifact(detail, ['research.experiment_plan']);
}

function executionPaths(detail: WorkflowDetail, step: WorkflowStepRun) {
  const runId = safeId(detail.run.id, 'Workflow Run ID');
  const stepRunId = safeId(step.id, 'Step Run ID');
  const base = `workflows/${runId}/${stepRunId}/research`;
  return { raw: `${base}/raw-result.json`, log: `${base}/experiment-log.txt` };
}

function experimentIds(detail: WorkflowDetail, step: WorkflowStepRun, planId: string) {
  const runId = safeId(detail.run.id, 'Workflow Run ID');
  const stepRunId = safeId(step.id, 'Step Run ID');
  return {
    attemptNumber: step.attempt,
    operationKey: `workflow:${runId}:${stepRunId}`,
    planArtifactId: planId,
  };
}

function experimentEvidenceFromResult(
  result: TranscriptToolResult,
  detail: WorkflowDetail,
  step: WorkflowStepRun,
): ExperimentEvidence | null {
  const evidence = structuredWorkflowEvidence(result);
  if (!evidence || !record(evidence.experiment)) return null;
  const candidate = evidence.experiment;
  const expectedPlan = planArtifact(detail, step);
  const expectedPaths = executionPaths(detail, step);
  const expectedOperationKey = `workflow:${detail.run.id}:${step.id}`;
  if (
    result.input.workflowRunId !== detail.run.id ||
    result.input.stepRunId !== step.id ||
    result.input.attempt !== step.attempt ||
    result.input.planArtifactId !== expectedPlan?.id ||
    result.input.operationKey !== expectedOperationKey ||
    result.input.mode !== stringInput(detail, 'experimentMode', 'COMPUTATIONAL') ||
    result.input.rawResultPath !== expectedPaths.raw ||
    result.input.experimentLogPath !== expectedPaths.log ||
    candidate.planArtifactId !== expectedPlan?.id
  )
    return null;
  const artifactFiles = Array.isArray(evidence.artifactFiles) ? evidence.artifactFiles : [];
  const fileFacts = artifactFiles.flatMap((entry) =>
    record(entry) &&
    typeof entry.path === 'string' &&
    isSafeWorkflowRelativePath(entry.path) &&
    typeof entry.contentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.contentHash)
      ? [{ relativePath: entry.path, contentHash: entry.contentHash }]
      : [],
  );
  if (fileFacts.length !== 2 || new Set(fileFacts.map((entry) => entry.relativePath)).size !== 2)
    return null;
  const rawResult = fileFacts.find((entry) => entry.relativePath === expectedPaths.raw);
  const experimentLog = fileFacts.find((entry) => entry.relativePath === expectedPaths.log);
  if (
    typeof candidate.planArtifactId !== 'string' ||
    !['SUCCEEDED', 'FAILED'].includes(String(candidate.status)) ||
    typeof candidate.method !== 'string' ||
    typeof candidate.negativeResult !== 'boolean' ||
    !rawResult ||
    !experimentLog
  )
    return null;
  const metrics = Array.isArray(candidate.metrics)
    ? candidate.metrics.flatMap((metric) =>
        record(metric) && typeof metric.name === 'string' && typeof metric.value === 'string'
          ? [
              {
                name: metric.name.slice(0, 200),
                value: metric.value.slice(0, 500),
                unit: typeof metric.unit === 'string' ? metric.unit.slice(0, 100) : '',
                uncertainty:
                  typeof metric.uncertainty === 'string' ? metric.uncertainty.slice(0, 500) : '',
              },
            ]
          : [],
      )
    : [];
  return {
    attemptNumber: step.attempt,
    attemptId: `${detail.run.id}-${step.id}-attempt-${step.attempt}`,
    operationKey: `workflow:${detail.run.id}:${step.id}`,
    planArtifactId: candidate.planArtifactId,
    status: candidate.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED',
    method: candidate.method.slice(0, 2000),
    negativeResult: candidate.negativeResult,
    rawResult,
    experimentLog,
    metrics,
    failureDetails: Array.isArray(candidate.failureDetails)
      ? candidate.failureDetails
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 30)
      : [],
    limitations: Array.isArray(candidate.limitations)
      ? candidate.limitations
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 30)
      : [],
    reproducibilityNotes: Array.isArray(candidate.reproducibilityNotes)
      ? candidate.reproducibilityNotes
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 30)
      : [],
  };
}

function experimentRecord(evidence: ExperimentEvidence, mode: string) {
  return {
    attemptNumber: evidence.attemptNumber,
    mode,
    planArtifactId: evidence.planArtifactId,
    operationKey: evidence.operationKey,
    status: evidence.status,
    rawResult: evidence.rawResult,
    experimentLog: evidence.experimentLog,
    metrics: evidence.metrics,
    negativeResults: evidence.negativeResult
      ? ['预设比较中未观察到预期改善；该结果已保留并纳入分析。']
      : [],
    failureDetails: evidence.failureDetails,
    limitations: evidence.limitations,
    reproducibilityNotes: evidence.reproducibilityNotes,
  };
}

function allExperimentRecords(
  detail: WorkflowDetail,
): Array<{ artifact: WorkflowArtifact; value: InputRecord }> {
  return artifactsForOutput(detail, ['research.experiment_record']).flatMap((artifact) => {
    const value = parseJson(artifact.content);
    return record(value) ? [{ artifact, value }] : [];
  });
}

function attemptIdFor(artifact: WorkflowArtifact, value: InputRecord): string {
  const attemptNumber = Number.isInteger(value.attemptNumber) ? value.attemptNumber : 1;
  return `${artifact.workflowRunId}:R08:${attemptNumber}`;
}

function experimentAttemptSummaries(detail: WorkflowDetail) {
  const experimentSteps = detail.steps
    .filter((step) => step.stepId === 'R08')
    .sort((left, right) => left.attempt - right.attempt || left.id.localeCompare(right.id));
  return experimentSteps.map((step) => {
    if (!step.missionRunId)
      throw new Error(`W2.3 final package requires MissionRun provenance for ${step.id}`);
    if (!Number.isInteger(step.attempt) || step.attempt < 1 || step.attempt > 5)
      throw new Error(`W2.3 final package received invalid attempt number for ${step.id}`);

    const recordArtifact = detail.artifacts.find(
      (artifact) =>
        artifact.producerStepRunId === step.id &&
        (artifact.metadata.outputKey ?? artifact.metadata.logicalKey) ===
          'research.experiment_record',
    );
    const recordValue = parseJson(recordArtifact?.content);
    const outcome = record(recordValue)
      ? recordValue.status === 'COMPLETED'
        ? 'COMPLETED'
        : recordValue.status === 'FAILED'
          ? 'FAILED'
          : null
      : step.state === 'FAILED'
        ? 'FAILED'
        : step.state === 'CANCELLED'
          ? 'CANCELLED'
          : null;
    if (!outcome)
      throw new Error(
        `W2.3 final package cannot infer a terminal experiment outcome for ${step.id}`,
      );
    if (step.state === 'COMPLETED' && !recordArtifact)
      throw new Error(
        `W2.3 completed experiment ${step.id} is missing its durable record Artifact`,
      );

    const files = ['research.raw_result', 'research.experiment_log'].flatMap((key) => {
      const artifact = detail.artifacts.find(
        (candidate) =>
          candidate.producerStepRunId === step.id &&
          (candidate.metadata.outputKey ?? candidate.metadata.logicalKey) === key,
      );
      return artifact ? [artifact] : [];
    });
    const rawPaths: string[] = [];
    const rawHashes: string[] = [];
    for (const artifact of files) {
      const path = artifact.metadata.path;
      const hash = artifact.metadata.contentHash;
      if (typeof path !== 'string' || typeof hash !== 'string')
        throw new Error(`W2.3 experiment file Artifact ${artifact.id} lacks path/hash provenance`);
      rawPaths.push(path.slice(0, 512));
      rawHashes.push(hash.slice(0, 64));
    }
    if (recordArtifact && files.length < 2)
      throw new Error(`W2.3 experiment record ${recordArtifact.id} lacks raw/log Artifact lineage`);

    return {
      stepRunId: step.id,
      missionRunId: step.missionRunId,
      attempt: step.attempt,
      outcome,
      recordArtifactId: recordArtifact?.id ?? '',
      errorCode: step.errorCode?.slice(0, 128) ?? '',
      rawPaths,
      rawHashes,
    };
  });
}

function decisionCount(detail: WorkflowDetail): number {
  return detail.steps.filter((step) => step.stepId === 'R10' && step.state === 'COMPLETED').length;
}

function refinementTarget(detail: WorkflowDetail): 'NONE' | 'EXPERIMENT' | 'HYPOTHESIS' {
  const kind = caseKind(detail);
  const completedDecisions = decisionCount(detail);
  const maxCycles = inputs(detail).maxExperimentCycles;
  const budget =
    Number.isInteger(maxCycles) && Number(maxCycles) >= 1 && Number(maxCycles) <= 2
      ? Number(maxCycles)
      : 2;
  if (kind === 'LIMIT') {
    if (completedDecisions === 0 && budget >= 1) return 'EXPERIMENT';
    if (completedDecisions === 1 && budget >= 2) return 'HYPOTHESIS';
    // The trusted policy sees this signal and exhausted durable traversals, then returns BLOCKED.
    return 'HYPOTHESIS';
  }
  if (kind === 'DATASET' && completedDecisions === 0 && budget > 1) return 'EXPERIMENT';
  return 'NONE';
}

function referencesForClaimMap(detail: WorkflowDetail): Array<{
  claimId: string;
  claim: string;
  classification: string;
  artifactIds: string[];
  note: string;
}> {
  const evidenceArtifact = latestArtifact(detail, ['research.evidence']);
  const recordArtifacts = artifactsForOutput(detail, ['research.experiment_record']);
  const analysisArtifact = latestArtifact(detail, ['research.analysis_results']);
  const artifactIds = [
    evidenceArtifact?.id,
    ...recordArtifacts.map((a) => a.id),
    analysisArtifact?.id,
  ].filter((id): id is string => typeof id === 'string');
  const uniqueIds = [...new Set(artifactIds)].slice(0, 20);
  if (uniqueIds.length === 0)
    throw new Error('W2.3 manuscript requires real same-Run evidence and result Artifacts');
  return [
    {
      claimId: 'claim-observed-result',
      claim: '本次实验观察到的结果仅适用于记录的样本与运行条件。',
      classification: 'EVIDENCE',
      artifactIds: uniqueIds,
      note: '该结论限定于本 Run 的来源、实验记录与分析 Artifact。',
    },
  ];
}

function reviewOutput(detail: WorkflowDetail, step: WorkflowStepRun, verdict: 'PASS' | 'REVISE') {
  return {
    verdict,
    findings: verdict === 'PASS' ? [] : ['请补充证据范围与方法局限的对应说明，并保持结论边界。'],
    evidence: verdict === 'PASS' ? ['已逐项检查方法、引用依据、负面结果、局限与可复现性。'] : [],
    summary:
      verdict === 'PASS'
        ? '审查通过；结论仍受本次数据和方法范围限制。'
        : '需要一次有界修订，重点补充可追溯的局限说明。',
    reviewedArtifactIds: currentInputs(detail, step),
  };
}

function outputValues(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  request: ModelRequest,
  evidence?: ExperimentEvidence,
): Record<string, unknown> {
  const question = stringInput(detail, 'researchQuestion', '冻结研究问题');
  const field = stringInput(detail, 'field', '未指定研究领域');
  const scope = stringInput(detail, 'scope');
  const experiments = allExperimentRecords(detail);
  const negativeResults = experiments.flatMap(({ artifact, value }) =>
    Array.isArray(value.negativeResults)
      ? value.negativeResults
          .filter((item): item is string => typeof item === 'string')
          .map((observation) => ({
            attemptId: attemptIdFor(artifact, value),
            metric: 'observed metric',
            observation,
            interpretation: '未观察到预期改善；该结果保留，不作为支持性证据。',
          }))
      : [],
  );
  const failedRuns = experiments.flatMap(({ artifact, value }) =>
    value.status === 'FAILED'
      ? [
          {
            attemptId: attemptIdFor(artifact, value),
            reason: (Array.isArray(value.failureDetails)
              ? value.failureDetails.join('; ')
              : '实验运行失败'
            ).slice(0, 1000),
          },
        ]
      : [],
  );
  const allExperimentArtifactIds = experiments.map(({ artifact }) => artifact.id);
  const mode = stringInput(detail, 'experimentMode', 'COMPUTATIONAL');

  switch (step.stepId) {
    case 'R01':
      return {
        'research.brief': {
          researchQuestion: question,
          field,
          scope,
          definitions: [{ term: '实验范围', definition: scope || '由研究问题和冻结输入限定。' }],
          constraints: [
            '只使用本 Run 的可追溯来源与实验 Artifact。',
            '不要把模型内部知识当作引用或实验事实。',
            '结论不超出给定样本、程序和运行环境。',
          ],
          successCriteria: [
            '每条文献 citation 能追溯实际 Source Artifact。',
            '保留 included/excluded 理由、负面结果和失败实验。',
            '关键 manuscript claim 能映射到本 Run Artifact。',
          ],
          knownAssumptions: ['数据和执行资源由用户或已授权 Tool 提供。'],
        },
      };
    case 'R02':
      return { 'research.literature': literatureOutput(detail, request) };
    case 'R03': {
      const values = screeningAndEvidence(detail);
      return { 'research.screening': values.screening, 'research.evidence': values.evidence };
    }
    case 'R04': {
      const values = gapsOutput(detail);
      return { 'research.landscape': values.landscape, 'research.gaps': values.gaps };
    }
    case 'R05':
      return { 'research.hypotheses': hypothesesOutput(detail) };
    case 'R06': {
      return {
        'research.review': reviewOutput(detail, step, step.attempt === 1 ? 'REVISE' : 'PASS'),
      };
    }
    case 'R07': {
      const hypotheses = producerValue(detail, ['research.hypotheses']);
      const first =
        record(hypotheses) && Array.isArray(hypotheses.hypotheses)
          ? hypotheses.hypotheses[0]
          : null;
      const hypothesisId =
        record(first) && typeof first.hypothesisId === 'string'
          ? first.hypothesisId
          : 'hypothesis-primary';
      const dataValue = inputs(detail).existingData;
      const codeValue = inputs(detail).existingCode;
      const dataRefs: InputRecord[] = Array.isArray(dataValue) ? dataValue.filter(record) : [];
      const codeRefs: InputRecord[] = Array.isArray(codeValue) ? codeValue.filter(record) : [];
      const datasetName = dataRefs.flatMap((entry) =>
        typeof entry.name === 'string' ? [entry.name] : [],
      )[0];
      return {
        'research.experiment_plan': {
          hypothesisId,
          method:
            caseKind(detail) === 'DATASET'
              ? '对冻结 Workspace 中用户指定的受限 CSV 样本计算分组均值，并与基线比较。'
              : '对固定小型工作负载重复运行基线与候选策略，比较尾延迟指标。',
          variables: [
            { variableId: 'strategy', role: 'independent', description: '基线与候选策略。' },
            { variableId: 'measurement', role: 'dependent', description: '预先声明的数值指标。' },
          ],
          datasetOrSamples:
            datasetName ??
            (codeRefs.length
              ? '用户提供的代码 Artifact 元数据；实际读取仍须经已授权 Tool。'
              : '本地确定性小型工作负载。'),
          controls: ['使用同一 Workspace、输入样本与计算规则。'],
          baselines: ['将基线组与候选组逐项比较。'],
          metrics: [
            {
              name: 'mean',
              definition: '各组测量值的算术平均。',
              unit: 'ms或数据原单位',
              expectedDirection: '依研究问题判定，不预设改善。',
            },
          ],
          procedure: [
            {
              step: 1,
              action: '校验输入和实验模式。',
              expectedObservation: '输入范围和 Artifact 元数据可追溯。',
            },
            {
              step: 2,
              action: '执行冻结方法并记录全部原始结果。',
              expectedObservation: '每个 attempt 独立保存结果与日志。',
            },
            {
              step: 3,
              action: '计算指标并保留失败、负面与不确定结果。',
              expectedObservation: '分析引用每个相关 attempt。',
            },
          ],
          expectedArtifacts: ['experiment_record', 'raw_result', 'experiment_log'],
          failureConditions: ['输入 CSV 不符合有界列格式。', 'Tool 无法在 Workspace 内写入结果。'],
          resourceRequirements: [
            '用户选择的 Workspace。',
            '经 PermissionEngine 授权的 Research MCP。',
          ],
          reproducibilityNotes: [
            '固定算法版本、输入哈希、attempt ID 和 operationKey。',
            ...dataRefs.map(
              (ref) => `输入 Artifact: ${String(ref.id)}, SHA-256: ${String(ref.contentHash)}`,
            ),
          ],
          externalExecutionRequirements:
            mode === 'COMPUTATIONAL'
              ? []
              : ['按冻结 experimentMode 由本尊或外部执行并上传验收产物。'],
        },
      };
    }
    case 'R08': {
      if (!evidence)
        throw new Error(
          'W2.3 R08 cannot emit an experiment record without durable MCP/Human execution evidence',
        );
      return { 'research.experiment_record': experimentRecord(evidence, mode) };
    }
    case 'R09': {
      const target = refinementTarget(detail);
      const allMetrics = experiments.flatMap(({ artifact, value }) =>
        (Array.isArray(value.metrics) && value.metrics.length
          ? value.metrics.filter(record)
          : [
              {
                name: 'execution_status',
                value: String(value.status),
                unit: '',
                uncertainty: '没有有效数值测量，仅保留实际执行状态。',
              },
            ]
        ).map((metric) => ({
          name: String(metric.name ?? 'metric'),
          value: String(metric.value ?? 'unknown'),
          unit: String(metric.unit ?? ''),
          uncertainty: String(metric.uncertainty ?? '未量化'),
          attemptIds: [attemptIdFor(artifact, value)],
          evidenceArtifactIds: [
            artifact.id,
            ...artifactsForOutput(detail, ['research.raw_result', 'research.experiment_log'])
              .filter((file) => file.producerStepRunId === artifact.producerStepRunId)
              .map((file) => file.id),
          ].slice(0, 20),
        })),
      );
      const analysis = `# 分析方法\n\n结合所有实验 attempt 的原始结果，按冻结指标逐项比较，不丢弃失败或负面结果。\n\n# 指标\n\n${allMetrics.map((metric) => `- ${metric.name}：${metric.value} ${metric.unit}（${metric.uncertainty}）`).join('\n') || '当前没有可验证的数值指标。'}\n\n# 不确定性\n\n样本量、运行环境与测量噪声限制外推。\n\n# 负面结果\n\n${negativeResults.map((item) => `- ${item.attemptId}：${item.observation}`).join('\n') || '没有负面结果；此记录不表示已证明假设。'}\n\n# 失败实验\n\n${failedRuns.map((item) => `- ${item.attemptId}：${item.reason}`).join('\n') || '没有失败实验。'}\n\n# 局限\n\n结果仅适用于已记录输入、方法和运行条件。`;
      return {
        'research.analysis': analysis,
        'research.analysis_results': {
          method: '逐 attempt 读取原始记录，计算预先声明的指标并保留偏差、不确定性和局限。',
          metrics: allMetrics,
          uncertainty: ['本地小样本无法支持广泛外推。', '重复试验与环境差异仍可能改变观察值。'],
          negativeResults,
          failedRuns,
          limitations: ['结果受数据和运行环境限制。', '本 Workflow 不代表同行评审或结论最终证实。'],
          dataComplete: experiments.length > 0,
          executionValid: experiments.at(-1)?.value.status === 'COMPLETED',
          refinementTarget: target,
          decisionRationale:
            target === 'NONE'
              ? '分析保留所有完成、失败和负面尝试；可信 Main 决定是否进入撰写。'
              : `分析建议在冻结的共享预算内进一步调整：${target === 'EXPERIMENT' ? '实验' : '假设'}。`,
          supportingArtifactIds: [
            ...allExperimentArtifactIds,
            ...artifactsForOutput(detail, ['research.raw_result', 'research.experiment_log']).map(
              (artifact) => artifact.id,
            ),
          ].slice(0, 20),
        },
        'research.figures': { figures: [] },
      };
    }
    case 'R11': {
      const map = referencesForClaimMap(detail);
      const manuscript = `# Abstract\n\n本文围绕“${question}”开展有界实验。所有结论限于已记录来源、样本和运行条件。\n\n# Introduction\n\n研究领域：${field}。范围：${scope || '由冻结研究问题限定'}。\n\n# Methods\n\n使用已记录的基线、指标和实验方法；来源、实验 attempt 与原始结果保留可追溯标识。\n\n# Results\n\n${negativeResults.map((item) => `${item.attemptId} 出现负面观察：${item.observation}`).join('\n') || '结果按本 Run 的 analysis Artifact 报告。'}\n\n# Discussion\n\n结果支持有限的、与已记录样本对应的观察，不代表普遍因果结论。\n\n# Limitations\n\n样本规模、环境差异、来源快照范围及不确定性限制解释；失败与负面运行不会被省略。`;
      return { 'research.manuscript': manuscript, 'research.claim_evidence_map': { claims: map } };
    }
    case 'R12': {
      return {
        'research.review': reviewOutput(detail, step, step.attempt === 1 ? 'REVISE' : 'PASS'),
      };
    }
    case 'R13': {
      const original = latestArtifact(detail, [
        'research.manuscript',
        'research.revised_manuscript',
      ]);
      const originalText =
        original?.content ??
        '# Abstract\n\nNo prior manuscript.\n\n# Introduction\n\n\n# Methods\n\n\n# Results\n\n\n# Discussion\n\n\n# Limitations\n\n';
      const claims = referencesForClaimMap(detail);
      return {
        'research.revised_manuscript': `${originalText}\n\n# Revision note\n\n已根据审查补充范围限制，并保留负面结果与不确定性。`,
        'research.revision_response': {
          responses: [
            {
              finding: '请补充证据范围与方法局限的对应说明，并保持结论边界。',
              response: '已补充数据、运行条件和来源快照的适用范围，并保持结论克制。',
              manuscriptSection: 'Limitations',
              evidenceArtifactIds: claims[0]!.artifactIds,
            },
          ],
          unresolvedFindings: [],
        },
        'research.claim_evidence_map': { claims },
      };
    }
    case 'R14': {
      const finalManuscript = latestArtifact(detail, [
        'research.revised_manuscript',
        'research.manuscript',
      ]);
      const evidenceTable = latestArtifact(detail, ['research.evidence']);
      const reproducibility = `# Environment\n\n离线本地 Workspace 与确定性计算 fixture。\n\n# Procedure\n\n每次实验使用冻结模式、稳定 operationKey、独立 attempt 目录和内容哈希。\n\n# Inputs\n\n记录研究问题、数据/代码 Artifact 元数据与实验方案。\n\n# Known Limitations\n\n此 Workflow 不替代伦理、安全、系统综述或领域专家审查，不自动投稿，完成不代表结论已被最终证实。`;
      return {
        'research.final_package': {
          finalManuscriptArtifactId: finalManuscript?.id ?? '',
          evidenceTableArtifactId: evidenceTable?.id ?? '',
          claimEvidenceMapArtifactIds: artifactsForOutput(detail, [
            'research.claim_evidence_map',
          ]).map((artifact) => artifact.id),
          experimentAttempts: experimentAttemptSummaries(detail),
          rawResultArtifactIds: artifactsForOutput(detail, ['research.raw_result']).map(
            (artifact) => artifact.id,
          ),
          experimentLogArtifactIds: artifactsForOutput(detail, ['research.experiment_log']).map(
            (artifact) => artifact.id,
          ),
          analysisArtifactIds: artifactsForOutput(detail, [
            'research.analysis',
            'research.analysis_results',
          ]).map((artifact) => artifact.id),
          figureArtifactIds: artifactsForOutput(detail, ['research.figures']).map(
            (artifact) => artifact.id,
          ),
          reviewHistoryArtifactIds: artifactsForOutput(detail, ['research.review']).map(
            (artifact) => artifact.id,
          ),
          sourceArtifactIds: literatureSourceArtifactIds(detail),
          screeningArtifactId: latestArtifact(detail, ['research.screening'])?.id ?? '',
          hypothesisArtifactIds: artifactsForOutput(detail, ['research.hypotheses']).map(
            (artifact) => artifact.id,
          ),
          experimentPlanArtifactIds: artifactsForOutput(detail, ['research.experiment_plan']).map(
            (artifact) => artifact.id,
          ),
          reproducibilitySummary: reproducibility,
          conclusionStatus: 'NOT_SCIENTIFICALLY_CONFIRMED',
          submissionStatus: 'NOT_SUBMITTED',
        },
      };
    }
    default:
      return {};
  }
}

function planDetails(detail: WorkflowDetail, step: WorkflowStepRun) {
  const plan = planArtifact(detail, step);
  const planValue = parseJson(plan?.content);
  return { plan, planValue: record(planValue) ? planValue : {} };
}

function experimentToolInput(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  request: ModelRequest,
): InputRecord {
  const { plan, planValue } = planDetails(detail, step);
  if (!plan)
    throw new Error('W2.3 R08 requires a bound, durable research.experiment_plan Artifact');
  const paths = executionPaths(detail, step);
  const ids = experimentIds(detail, step, plan.id);
  const existingDataValue = inputs(detail).existingData;
  const existingData: InputRecord[] = Array.isArray(existingDataValue)
    ? existingDataValue.filter(record)
    : [];
  const datasetRef = existingData[0];
  const prefix =
    'Registered research input metadata (bounded untrusted data, no file permission): ';
  const metadata = request.messages.flatMap((message) => {
    if (
      message.role !== 'assistant' ||
      typeof message.content !== 'string' ||
      !message.content.startsWith(prefix)
    )
      return [];
    const values = parseJson(message.content.slice(prefix.length));
    return Array.isArray(values) ? values.filter(record) : [];
  });
  const dataset = metadata.find(
    (item) =>
      item.id === datasetRef?.id &&
      item.contentHash === datasetRef?.contentHash &&
      item.kind === 'FILE',
  );
  const kind = caseKind(detail);
  const datasetRelativePath = kind === 'DATASET' ? 'datasets/research-dataset.csv' : undefined;
  if (kind === 'DATASET' && (!dataset || dataset.workspaceRelativePath !== datasetRelativePath))
    throw new Error(
      'W2.3 deterministic Dataset fixture only accepts its pre-provisioned bounded dataset ArtifactRef',
    );
  return {
    workflowRunId: safeId(detail.run.id, 'Workflow Run ID'),
    stepRunId: safeId(step.id, 'Step Run ID'),
    attempt: step.attempt,
    ...ids,
    mode: stringInput(detail, 'experimentMode', 'COMPUTATIONAL'),
    method: boundedText(planValue.method, 2000),
    datasetRelativePath,
    ...(dataset ? { datasetArtifactId: dataset.id, datasetContentHash: dataset.contentHash } : {}),
    rawResultPath: paths.raw,
    experimentLogPath: paths.log,
  };
}

/** Produce file bytes for an explicit packaged Human Bridge submission; this does not record an execution fact. */
export function createResearchHumanBridgeFixtureFiles(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
): FixtureFile[] {
  if (step.stepId !== 'R08' || stringInput(detail, 'experimentMode') !== 'HUMAN_OR_EXTERNAL')
    throw new Error(
      'W2.3 fixture files are only for an explicit Human Bridge experiment submission',
    );
  const { plan, planValue } = planDetails(detail, step);
  if (!plan) throw new Error('W2.3 Human Bridge fixture requires the persisted experiment Plan');
  const paths = executionPaths(detail, step);
  const kind = caseKind(detail);
  const rawBytes = new TextEncoder().encode(
    JSON.stringify(
      {
        attemptNumber: step.attempt,
        planArtifactId: plan.id,
        method: boundedText(planValue.method, 2000),
        status: 'COMPLETED',
        negativeResult: kind === 'DATASET',
        observations:
          kind === 'EXTERNAL'
            ? ['本尊提交了有界观察记录；该结果仅代表模拟验收数据。']
            : ['工具计算结果由上一步 MCP 执行保存，人工续接仅补充外部验收观察。'],
        metrics: [],
        fixtureDisclosure: '用户显式提交的离线验收 Artifact；不代表真实领域实验。',
      },
      null,
      2,
    ),
  );
  const logBytes = new TextEncoder().encode(
    `attempt=${step.attempt}\nstatus=COMPLETED\nmethod=${boundedText(planValue.method, 200)}\nsource=explicit-user-bridge-submission\n`,
  );
  return [
    {
      outputKey: 'research.raw_result',
      relativePath: paths.raw,
      bytes: rawBytes,
      contentHash: sha256(rawBytes),
      mediaType: 'application/json',
    },
    {
      outputKey: 'research.experiment_log',
      relativePath: paths.log,
      bytes: logBytes,
      contentHash: sha256(logBytes),
      mediaType: 'text/plain',
    },
  ];
}

/** Deterministic output projector. Execution facts and FILE bytes must already be durable inputs. */
export function generateResearchFixtureOutputs(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  executionEvidence?: ExperimentEvidence,
): ResearchFixtureOutputs {
  const request = {
    runtimeProfileId: 'fixture-runtime',
    teammateId: 'fixture-teammate',
    messages: [
      { role: 'user' as const, content: 'Continue the deterministic research workflow fixture.' },
    ],
  };
  if (step.stepId === 'R08' && !executionEvidence)
    throw new Error('W2.3 fixture refuses to emit R08 without a durable accepted execution fact');
  const outputs = outputValues(detail, step, request, executionEvidence);
  return {
    outputs,
    files: [],
  };
}

/** Deterministic offline W2.3 adapter. Main supplies the actual persisted active Step. */
export class ResearchWorkflowFixtureGateway extends FakeModelGateway {
  constructor(private readonly resolveContext: ContextResolver) {
    super();
  }

  override async generate(request: ModelRequest) {
    const base = await super.generate(request);
    const context = this.resolveContext(request);
    if (!context || context.detail.version.definition.id !== RESEARCH_WORKFLOW_ID) return base;
    if (request.externalWorkContext && context.step.stepId === 'R08')
      throw new Error(
        'W2.3 R08 Human Bridge execution is consumed by durable Main facts, never a model call',
      );
    if (request.externalWorkContext)
      return {
        ...base,
        text: '本尊实验材料已提交，等待可信 Main 校验 Artifact 与实验边界。',
      };
    if (context.step.stepId === 'R10') return { ...base, text: '' };
    return {
      ...base,
      text: workflowOutputText(
        context.detail,
        context.step,
        outputValues(context.detail, context.step, request),
      ),
    };
  }

  override async generateWithTools(
    request: Parameters<NonNullable<FakeModelGateway['generateWithTools']>>[0],
  ): Promise<ModelToolResponse> {
    const context = this.resolveContext(request);
    if (!context || context.detail.version.definition.id !== RESEARCH_WORKFLOW_ID)
      return super.generateWithTools(request);
    if (request.externalWorkContext && context.step.stepId === 'R08')
      throw new Error(
        'W2.3 R08 Human Bridge execution is consumed by durable Main facts, never a model call',
      );
    if (request.externalWorkContext)
      return {
        ...(await super.generateWithTools(request)),
        text: '本尊实验材料已提交，等待可信 Main 校验。',
        toolCalls: [],
      };

    const { detail, step } = context;
    const results = toolTranscript(request);
    if (step.stepId === 'R02') {
      const sourceResult = results.find((result) =>
        result.toolId.endsWith(`:${TOOL_NAMES.sources}`),
      );
      if (sourceResult && !sourceResult.ok)
        throw new Error('W2.3 R02 research Tool failed; refusing to fabricate citations');
      if (!sourceResult) {
        const tool = toolByName(request, TOOL_NAMES.sources);
        return proposeTool(request, tool, {
          workflowRunId: safeId(detail.run.id, 'Workflow Run ID'),
          stepRunId: safeId(step.id, 'Step Run ID'),
          researchQuestion: stringInput(detail, 'researchQuestion').slice(0, 3000),
          field: stringInput(detail, 'field').slice(0, 200),
          scope: stringInput(detail, 'scope').slice(0, 2000),
          literatureTimeRange: inputs(detail).literatureTimeRange ?? {},
          maxResults: 8,
        });
      }
      const sources = researchSourcesFromResult(sourceResult);
      if (!sources.length)
        throw new Error('W2.3 R02 successful MCP result has no matching source Artifact evidence');
      const base = await super.generate(request);
      return {
        ...base,
        text: workflowOutputText(detail, step, {
          'research.literature': literatureOutput(detail, request),
        }),
        toolCalls: [],
      };
    }

    if (step.stepId === 'R08') {
      const mode = stringInput(detail, 'experimentMode', 'COMPUTATIONAL');
      if (mode === 'HUMAN_OR_EXTERNAL')
        throw new Error('W2.3 HUMAN_OR_EXTERNAL execution must use the durable Human Bridge path');
      const experimentTool = results.find((result) =>
        result.toolId.endsWith(`:${TOOL_NAMES.experiment}`),
      );
      if (experimentTool && !experimentTool.ok)
        throw new Error('W2.3 R08 experiment Tool failed; refusing to fabricate a success result');
      if (!experimentTool) {
        const tool = toolByName(request, TOOL_NAMES.experiment);
        return proposeTool(request, tool, experimentToolInput(detail, step, request));
      }
      const evidence = experimentEvidenceFromResult(experimentTool, detail, step);
      if (!evidence)
        throw new Error(
          'W2.3 R08 cannot continue without bounded durable experiment Tool evidence',
        );
      if (evidence.attemptNumber !== step.attempt)
        throw new Error('W2.3 R08 MCP evidence does not match this frozen Plan and Step attempt');
      const values = outputValues(detail, step, request, evidence);
      return response(request, workflowOutputText(detail, step, values), []);
    }

    const base = await super.generate(request);
    return {
      ...base,
      text: workflowOutputText(detail, step, outputValues(detail, step, request)),
      toolCalls: [],
    };
  }
}
