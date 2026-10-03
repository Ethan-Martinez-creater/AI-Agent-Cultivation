import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ModelRequest,
  ModelToolCall,
  ModelToolCallPart,
  ModelToolResultPart,
} from '@cultivation/application';
import type {
  ToolDescriptor,
  WorkflowArtifact,
  WorkflowArtifactBinding,
  WorkflowDetail,
  WorkflowInputs,
  WorkflowStepRun,
} from '@cultivation/domain';
import { createAiNewsAcceptanceOutput } from '../../../../packages/application/src/builtin/ai-news-video/test-data.js';
import {
  AI_NEWS_VIDEO_ACCEPTANCE_INPUTS,
  AI_NEWS_VIDEO_VERSION_1,
} from '../../../../packages/application/src/builtin/ai-news-video/v1.js';
import { NewsWorkflowFixtureGateway } from './w21-fixture.js';

const createdAt = '2026-10-03T00:00:00.000Z';
const workflowRunId = 'fixture-news-run';
const inputs = AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short as unknown as WorkflowInputs;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidence(key: string, artifactId: string, value: unknown) {
  const content = JSON.stringify(value);
  return {
    key,
    artifactId,
    kind: 'JSON' as const,
    content,
    contentHash: sha256(content),
    metadata: {},
  };
}

function makeArtifact(stepId: string, item: ReturnType<typeof evidence>) {
  const stepRunId = `fixture-${stepId}`;
  const definition = AI_NEWS_VIDEO_VERSION_1.steps.find((step) => step.id === stepId);
  const output = definition?.outputs.find((spec) => spec.key === item.key);
  if (!output) throw new Error(`Missing frozen output binding for ${stepId}.${item.key}`);

  const artifact: WorkflowArtifact = {
    id: item.artifactId,
    workflowRunId,
    producerStepRunId: stepRunId,
    missionId: `mission-${stepId}`,
    missionRunId: `mission-run-${stepId}`,
    actorId: 'fixture-editor',
    sourceId: `source-${stepId}`,
    source: 'MISSION',
    kind: item.kind,
    content: item.content,
    contentHash: item.contentHash,
    metadata: {},
    inputArtifactIds: [],
    createdAt,
  };
  const binding: WorkflowArtifactBinding = {
    id: `binding-${stepId}`,
    workflowRunId,
    stepRunId,
    key: item.key,
    artifactId: item.artifactId,
    role: 'OUTPUT',
    contractId: output.contractId,
    contractVersion: output.contractVersion,
    createdAt,
  };
  return { artifact, binding, evidence: item };
}

function stepRun(stepId: string, state: WorkflowStepRun['state']): WorkflowStepRun {
  return {
    id: `fixture-${stepId}`,
    workflowRunId,
    stepId,
    attempt: 1,
    state,
    missionId: `mission-${stepId}`,
    missionRunId: `mission-run-${stepId}`,
    waitReason: null,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeDetail(
  activeStepId: 'N01' | 'N03',
  priorArtifacts: ReturnType<typeof makeArtifact>[] = [],
): { detail: WorkflowDetail; step: WorkflowStepRun } {
  const stepRuns = [
    stepRun('N01', activeStepId === 'N01' ? 'RUNNING' : 'COMPLETED'),
    stepRun('N02', activeStepId === 'N03' ? 'COMPLETED' : 'PENDING'),
    stepRun('N03', activeStepId === 'N03' ? 'RUNNING' : 'PENDING'),
  ];
  const step = stepRuns.find((candidate) => candidate.stepId === activeStepId)!;
  const bindings = priorArtifacts.map((item) => item.binding);

  if (activeStepId === 'N03') {
    const clusterArtifact = priorArtifacts.find(
      (item) => item.evidence.key === 'news.story_clusters',
    );
    const clusterOutput = AI_NEWS_VIDEO_VERSION_1.steps
      .find((candidate) => candidate.id === 'N02')!
      .outputs.find((candidate) => candidate.key === 'news.story_clusters')!;
    if (!clusterArtifact) throw new Error('N03 fixture requires N02 story cluster artifact');
    bindings.push({
      id: 'binding-N03-clusters-input',
      workflowRunId,
      stepRunId: step.id,
      key: 'clusters',
      artifactId: clusterArtifact.artifact.id,
      role: 'INPUT',
      contractId: clusterOutput.contractId,
      contractVersion: clusterOutput.contractVersion,
      createdAt,
    });
  }

  const detail = {
    run: {
      id: workflowRunId,
      definitionId: AI_NEWS_VIDEO_VERSION_1.definition.id,
      definitionVersion: AI_NEWS_VIDEO_VERSION_1.version,
      inputSnapshot: inputs,
      state: 'RUNNING',
      waitReason: null,
      createdAt,
      updatedAt: createdAt,
    },
    version: AI_NEWS_VIDEO_VERSION_1,
    steps: stepRuns,
    artifacts: priorArtifacts.map((item) => item.artifact),
    bindings,
    validations: [],
    decisions: [],
    checkpoints: [],
    events: [],
  } as unknown as WorkflowDetail;
  return { detail, step };
}

const researchTool = {
  id: 'news.fixture.research',
  source: 'MCP',
  name: 'research_news',
  description: 'Deterministic test research tool',
  inputSchema: { type: 'object' },
  riskLevel: 'READ_ONLY',
  sideEffect: 'NONE',
  capability: 'TOOL_USE',
  workflowPurposes: ['RESEARCH'],
} as unknown as ToolDescriptor;

function requestForStep(): ModelRequest & { tools: ToolDescriptor[] } {
  return {
    runtimeProfileId: 'fixture-runtime',
    teammateId: 'fixture-editor',
    messages: [{ role: 'user', content: 'Continue the official news workflow step.' }],
    tools: [researchTool],
  };
}

function successfulToolTranscript(
  call: ModelToolCall,
  researchSources: readonly { url: string; contentHash: string }[],
): ModelRequest['messages'] {
  const callPart: ModelToolCallPart = {
    type: 'tool-call',
    toolCallId: call.id,
    toolName: call.toolId,
    input: call.input,
  };
  const structuredContent = {
    workflowEvidence: {
      researchSources: researchSources.map(({ url, contentHash }) => ({ url, contentHash })),
    },
  };
  const resultPart: ModelToolResultPart = {
    type: 'tool-result',
    toolCallId: call.id,
    toolName: call.toolId,
    output: {
      type: 'json',
      value: {
        classification: 'UNTRUSTED_EXTERNAL_DATA',
        toolId: call.toolId,
        ok: true,
        code: null,
        content: JSON.stringify({ structuredContent }),
      },
    },
  };
  return [
    { role: 'assistant', content: [callPart] },
    { role: 'tool', content: [resultPart] },
  ];
}

async function expectResearchContinuation(
  activeStepId: 'N01' | 'N03',
  expected: ReturnType<typeof createAiNewsAcceptanceOutput>,
  context: ReturnType<typeof makeDetail>,
): Promise<void> {
  const gateway = new NewsWorkflowFixtureGateway(() => context, process.cwd());
  const request = requestForStep();
  const proposal = await gateway.generateWithTools(request);
  const call = proposal.toolCalls[0];
  expect(call).toBeDefined();
  expect(call!.toolId).toBe(researchTool.id);
  expect((call!.input as { stepId?: string }).stepId).toBe(activeStepId);

  // Reconstruct the durable assistant-call/tool-result pair returned by MCP after success.
  const resumedRequest: ModelRequest = {
    ...request,
    messages: [...request.messages, ...successfulToolTranscript(call!, expected.researchSources)],
  };
  const response = await gateway.generate(resumedRequest);
  const outputKey = activeStepId === 'N01' ? 'news.candidates' : 'news.source_packets';
  expect(JSON.parse(response.text)).toEqual(expected.outputs[outputKey]);
}

describe('NewsWorkflowFixtureGateway research transcript', () => {
  it('accepts the durable N01 and resumed N03 MCP tool transcript', async () => {
    const candidateOutput = createAiNewsAcceptanceOutput({
      stepId: 'N01',
      workflowInputs: inputs,
      priorArtifacts: [],
    });
    const candidateArtifact = makeArtifact(
      'N01',
      evidence(
        'news.candidates',
        'artifact-news-candidates',
        candidateOutput.outputs['news.candidates'],
      ),
    );
    await expectResearchContinuation('N01', candidateOutput, makeDetail('N01'));

    const clusterOutput = createAiNewsAcceptanceOutput({
      stepId: 'N02',
      workflowInputs: inputs,
      priorArtifacts: [candidateArtifact.evidence],
    });
    const clusterArtifact = makeArtifact(
      'N02',
      evidence(
        'news.story_clusters',
        'artifact-news-story-clusters',
        clusterOutput.outputs['news.story_clusters'],
      ),
    );
    const sourcePacketOutput = createAiNewsAcceptanceOutput({
      stepId: 'N03',
      workflowInputs: inputs,
      priorArtifacts: [candidateArtifact.evidence, clusterArtifact.evidence],
      inputArtifactIds: [clusterArtifact.evidence.artifactId],
    });

    await expectResearchContinuation(
      'N03',
      sourcePacketOutput,
      makeDetail('N03', [candidateArtifact, clusterArtifact]),
    );
  });
});
