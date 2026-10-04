import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelToolCall } from '@cultivation/application';
import type {
  ToolDescriptor,
  WorkflowArtifact,
  WorkflowDetail,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from '@cultivation/domain';
import {
  createResearchHumanBridgeFixtureFiles,
  ResearchWorkflowFixtureGateway,
} from './w23-fixture.js';

const createdAt = '2026-10-04T00:00:00.000Z';
const runId = 'research-fixture-run';
const outputKeys: Record<string, string[]> = {
  R01: ['research.brief'],
  R02: ['research.literature'],
  R03: ['research.screening', 'research.evidence'],
  R04: ['research.landscape', 'research.gaps'],
  R05: ['research.hypotheses'],
  R06: ['research.review'],
  R07: ['research.experiment_plan'],
  R08: ['research.experiment_record'],
  R09: ['research.analysis', 'research.analysis_results', 'research.figures'],
  R11: ['research.manuscript', 'research.claim_evidence_map'],
  R12: ['research.review'],
  R13: ['research.revised_manuscript', 'research.revision_response', 'research.claim_evidence_map'],
  R14: ['research.final_package'],
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeArtifact(
  outputKey: string,
  value: unknown,
  options: { id?: string; producerStepRunId?: string; kind?: WorkflowArtifact['kind'] } = {},
): WorkflowArtifact {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    id: options.id ?? `artifact-${outputKey.replaceAll('.', '-')}`,
    workflowRunId: runId,
    producerStepRunId: options.producerStepRunId ?? `producer-${outputKey}`,
    missionId: `mission-${outputKey}`,
    missionRunId: `mission-run-${outputKey}`,
    actorId: 'research-fixture-teammate',
    sourceId: `source-${outputKey}`,
    source: 'MISSION',
    kind:
      options.kind ??
      (outputKey === 'research.analysis' || outputKey === 'research.manuscript' ? 'TEXT' : 'JSON'),
    content,
    contentHash: sha256(content),
    metadata: { outputKey, logicalKey: outputKey },
    inputArtifactIds: [],
    createdAt,
  } as WorkflowArtifact;
}

function makeContext(
  stepId: string,
  options: {
    attempt?: number;
    inputs?: Record<string, unknown>;
    artifacts?: WorkflowArtifact[];
    bindings?: WorkflowDetail['bindings'];
    steps?: WorkflowStepRun[];
  } = {},
): { detail: WorkflowDetail; step: WorkflowStepRun } {
  const step: WorkflowStepRun = {
    id: `step-${stepId}-${options.attempt ?? 1}`,
    workflowRunId: runId,
    stepId,
    attempt: options.attempt ?? 1,
    state: 'RUNNING',
    missionId: `mission-${stepId}`,
    missionRunId: `mission-run-${stepId}`,
    waitReason: null,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
  } as WorkflowStepRun;
  const definitions = Object.entries(outputKeys).map(([id, keys]) => ({
    id,
    outputs: keys.map((key) => ({
      key,
      kind: key === 'research.analysis' || key === 'research.manuscript' ? 'TEXT' : 'JSON',
    })),
  })) as WorkflowStepDefinition[];
  const detail = {
    run: {
      id: runId,
      definitionId: 'official.research',
      definitionVersion: 1,
      inputSnapshot: {
        researchQuestion: 'Compare a bounded research fixture experiment',
        field: 'Computer systems',
        scope: 'Offline deterministic acceptance fixture',
        experimentMode: 'COMPUTATIONAL',
        maxExperimentCycles: 2,
        ...options.inputs,
      },
      state: 'RUNNING',
      waitReason: null,
      createdAt,
      updatedAt: createdAt,
    },
    version: { definition: { id: 'official.research' }, steps: definitions },
    steps: options.steps ?? [step],
    artifacts: options.artifacts ?? [],
    bindings: options.bindings ?? [],
    validations: [],
    decisions: [],
    checkpoints: [],
    events: [],
  } as unknown as WorkflowDetail;
  return { detail, step };
}

function tool(id: string, name: string): ToolDescriptor {
  return {
    id,
    source: 'MCP',
    name,
    description: 'Offline research fixture Tool',
    inputSchema: { type: 'object' },
    riskLevel: 'READ_ONLY',
    sideEffect: 'NONE',
    capability: 'MCP_TOOL_EXECUTE',
    workflowPurposes: ['RESEARCH'],
  } as unknown as ToolDescriptor;
}

function request(tools: ToolDescriptor[] = []): ModelRequest & { tools: ToolDescriptor[] } {
  return {
    runtimeProfileId: 'fixture-runtime',
    teammateId: 'fixture-teammate',
    messages: [{ role: 'user', content: 'Continue the deterministic research fixture.' }],
    tools,
  };
}

function toolTranscript(call: ModelToolCall, output: unknown, ok = true) {
  return [
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: call.id,
          toolName: call.toolId,
          input: call.input,
        },
      ],
    },
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: call.id,
          toolName: call.toolId,
          output: {
            type: 'json' as const,
            value: {
              classification: 'UNTRUSTED_EXTERNAL_DATA' as const,
              toolId: call.toolId,
              ok,
              code: ok ? null : 'FIXTURE_TOOL_FAILED',
              content: JSON.stringify(output),
            },
          },
        },
      ],
    },
  ];
}

function sourceToolResult() {
  const sourceText = 'Offline source snapshot for the deterministic research fixture.';
  const url = 'https://research.example.test/paper';
  const contentHash = sha256(sourceText);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          sources: [
            {
              title: 'Bounded fixture source',
              authors: ['Research Fixture'],
              year: 2024,
              source: 'Deterministic test catalog',
              url,
              doi: '',
              identifier: url,
              summary: sourceText,
              contentHash,
            },
          ],
        }),
      },
    ],
    structuredContent: { workflowEvidence: { researchSources: [{ url, contentHash }] } },
  };
}

describe('ResearchWorkflowFixtureGateway', () => {
  it('requires a real tool transcript before emitting literature citations', async () => {
    const context = makeContext('R02');
    const researchTool = tool('mcp:research-fixture:research_sources', 'research_sources');
    const gateway = new ResearchWorkflowFixtureGateway(() => context);
    const initial = request([researchTool]);
    const proposal = await gateway.generateWithTools(initial);
    expect(proposal.toolCalls).toHaveLength(1);
    expect(proposal.toolCalls[0]).toMatchObject({
      toolId: researchTool.id,
      input: { maxResults: 8 },
    });

    const sourcesWithoutFacts = { content: sourceToolResult().content };
    await expect(
      gateway.generateWithTools({
        ...initial,
        messages: [
          ...initial.messages,
          ...toolTranscript(proposal.toolCalls[0]!, sourcesWithoutFacts),
        ],
      }),
    ).rejects.toThrow('no matching source Artifact evidence');

    const completed = await gateway.generateWithTools({
      ...initial,
      messages: [
        ...initial.messages,
        ...toolTranscript(proposal.toolCalls[0]!, sourceToolResult()),
      ],
    });
    const literature = JSON.parse(completed.text) as { sources: Array<Record<string, unknown>> };
    expect(literature.sources).toHaveLength(1);
    expect(literature.sources[0]).toMatchObject({
      sourceId: `source-${sha256('Offline source snapshot for the deterministic research fixture.')}`,
      sourceArtifactId: `source-${sha256('Offline source snapshot for the deterministic research fixture.')}`,
      discoveryMethod: 'RESEARCH_TOOL',
      discoveryToolId: researchTool.id,
    });
  });

  it('records explicit included and excluded reasons and evidence-to-source lineage', async () => {
    const literature = makeArtifact('research.literature', {
      sources: [
        {
          sourceId: 'source-included',
          sourceArtifactId: 'source-included',
          title: 'The Tail at Scale',
        },
        { sourceId: 'source-excluded', sourceArtifactId: 'source-excluded', title: 'Iris' },
      ],
    });
    const context = makeContext('R03', { artifacts: [literature] });
    const response = await new ResearchWorkflowFixtureGateway(() => context).generate(request());
    const values = JSON.parse(response.text) as { outputs: Record<string, unknown> };
    const screening = values.outputs['research.screening'] as {
      sources: Array<Record<string, unknown>>;
    };
    const evidence = values.outputs['research.evidence'] as {
      claims: Array<Record<string, unknown>>;
    };
    expect(screening.sources).toHaveLength(2);
    expect(screening.sources.map((row) => row.decision)).toEqual(['INCLUDED', 'EXCLUDED']);
    expect(
      screening.sources.every((row) => typeof row.reason === 'string' && row.reason.length > 0),
    ).toBe(true);
    expect(evidence.claims[0]).toMatchObject({
      sourceId: 'source-included',
      sourceArtifactId: 'source-included',
      status: 'EVIDENCE',
    });
  });

  it('produces bounded hypothesis and manuscript reviews without claiming review independence', async () => {
    for (const stepId of ['R06', 'R12']) {
      const first = makeContext(stepId, { attempt: 1 });
      const firstValue = JSON.parse(
        (await new ResearchWorkflowFixtureGateway(() => first).generate(request())).text,
      ) as Record<string, unknown>;
      expect(firstValue).toMatchObject({ verdict: 'REVISE' });
      expect(firstValue).not.toHaveProperty('reviewIndependence');
      const retry = makeContext(stepId, { attempt: 2 });
      const retryValue = JSON.parse(
        (await new ResearchWorkflowFixtureGateway(() => retry).generate(request())).text,
      ) as Record<string, unknown>;
      expect(retryValue).toMatchObject({ verdict: 'PASS' });
    }
  });

  it('requires exact same Run/step/attempt/tool facts for R08 before building a record', async () => {
    const plan = makeArtifact(
      'research.experiment_plan',
      { method: 'Run a deterministic bounded calculation.' },
      { id: 'plan-1' },
    );
    const context = makeContext('R08', { artifacts: [plan] });
    const experimentTool = tool('mcp:research-fixture:run_experiment', 'run_experiment');
    const gateway = new ResearchWorkflowFixtureGateway(() => context);
    const initial = request([experimentTool]);
    const proposal = await gateway.generateWithTools(initial);
    expect(proposal.toolCalls[0]?.input).toMatchObject({
      workflowRunId: runId,
      stepRunId: context.step.id,
      planArtifactId: plan.id,
      mode: 'COMPUTATIONAL',
      operationKey: `workflow:${runId}:${context.step.id}`,
    });
    const call = proposal.toolCalls[0]!;
    const rawPath = String((call.input as Record<string, unknown>).rawResultPath);
    const logPath = String((call.input as Record<string, unknown>).experimentLogPath);
    const output = {
      structuredContent: {
        workflowEvidence: {
          researchExperiment: {
            planArtifactId: plan.id,
            status: 'SUCCEEDED',
            method: 'Run a deterministic bounded calculation.',
            negativeResult: true,
            metrics: [{ name: 'mean', value: '2.5', unit: 'units', uncertainty: 'n=4' }],
          },
          artifactFiles: [
            { path: rawPath, contentHash: 'a'.repeat(64) },
            { path: logPath, contentHash: 'b'.repeat(64) },
          ],
        },
      },
    };
    const resumed = {
      ...initial,
      messages: [...initial.messages, ...toolTranscript(call, output)],
    };
    const completed = await gateway.generateWithTools(resumed);
    expect(JSON.parse(completed.text)).toMatchObject({
      attemptNumber: 1,
      mode: 'COMPUTATIONAL',
      planArtifactId: plan.id,
      operationKey: `workflow:${runId}:${context.step.id}`,
      status: 'COMPLETED',
      rawResult: { relativePath: rawPath, contentHash: 'a'.repeat(64) },
      experimentLog: { relativePath: logPath, contentHash: 'b'.repeat(64) },
      negativeResults: expect.arrayContaining([expect.any(String)]),
    });

    const wrong = structuredClone(output) as typeof output;
    wrong.structuredContent.workflowEvidence.artifactFiles[0]!.path = '../outside/raw-result.json';
    await expect(
      gateway.generateWithTools({
        ...initial,
        messages: [...initial.messages, ...toolTranscript(call, wrong)],
      }),
    ).rejects.toThrow('bounded durable experiment Tool evidence');
  });

  it('retains failed and negative attempts in analysis and claim maps point to Run Artifacts', async () => {
    const failed = makeArtifact(
      'research.experiment_record',
      {
        attemptNumber: 1,
        status: 'FAILED',
        metrics: [],
        negativeResults: [],
        failureDetails: ['bounded execution failed'],
      },
      { id: 'record-failed', producerStepRunId: 'step-r08-1' },
    );
    const negative = makeArtifact(
      'research.experiment_record',
      {
        attemptNumber: 2,
        status: 'COMPLETED',
        metrics: [{ name: 'mean', value: '2.5', unit: 'units', uncertainty: 'bounded' }],
        negativeResults: ['No improvement observed.'],
        failureDetails: [],
      },
      { id: 'record-negative', producerStepRunId: 'step-r08-2' },
    );
    const raw = makeArtifact('research.raw_result', '{}', {
      id: 'raw-1',
      producerStepRunId: 'step-r08-2',
      kind: 'FILE',
    });
    const log = makeArtifact('research.experiment_log', 'done', {
      id: 'log-1',
      producerStepRunId: 'step-r08-2',
      kind: 'FILE',
    });
    const context = makeContext('R09', { artifacts: [failed, negative, raw, log] });
    const result = await new ResearchWorkflowFixtureGateway(() => context).generate(request());
    const analysis = JSON.parse(result.text) as { outputs: Record<string, unknown> };
    const values = analysis.outputs['research.analysis_results'] as Record<string, unknown>;
    expect(values).toMatchObject({
      dataComplete: true,
      executionValid: true,
      refinementTarget: 'NONE',
      failedRuns: [expect.objectContaining({ attemptId: 'step-r08-1-attempt-1' })],
      negativeResults: [expect.objectContaining({ attemptId: 'step-r08-2-attempt-2' })],
    });
    expect(values.supportingArtifactIds).toEqual(
      expect.arrayContaining(['record-failed', 'record-negative', 'raw-1', 'log-1']),
    );

    const evidence = makeArtifact(
      'research.evidence',
      { claims: [{ evidenceId: 'ev-1', sourceArtifactId: 'source-real' }] },
      { id: 'evidence-1' },
    );
    const manuscriptContext = makeContext('R11', {
      artifacts: [
        evidence,
        negative,
        raw,
        log,
        makeArtifact('research.analysis_results', values, { id: 'analysis-1' }),
      ],
    });
    const manuscript = await new ResearchWorkflowFixtureGateway(() => manuscriptContext).generate(
      request(),
    );
    const claimMap = JSON.parse(manuscript.text).outputs['research.claim_evidence_map'] as {
      claims: Array<{ artifactIds: string[] }>;
    };
    expect(claimMap.claims[0]!.artifactIds).toEqual(
      expect.arrayContaining(['evidence-1', 'record-negative', 'analysis-1']),
    );
    expect(claimMap.claims[0]!.artifactIds).not.toContain('source-real');
  });

  it('freezes every terminal experiment attempt and real raw/log provenance in the final package', async () => {
    const failedAttempt = {
      ...makeContext('R08', { attempt: 1 }).step,
      state: 'FAILED' as const,
      missionRunId: 'mission-run-r08-failed',
      errorCode: 'TOOL_EXECUTION_FAILED',
    };
    const completedAttempt = {
      ...makeContext('R08', { attempt: 2 }).step,
      state: 'COMPLETED' as const,
      missionRunId: 'mission-run-r08-completed',
    };
    const record = makeArtifact(
      'research.experiment_record',
      { attemptNumber: 2, status: 'COMPLETED', rawResult: {}, experimentLog: {} },
      { id: 'experiment-record-2', producerStepRunId: completedAttempt.id },
    );
    const raw = makeArtifact('research.raw_result', '{}', {
      id: 'raw-result-2',
      producerStepRunId: completedAttempt.id,
      kind: 'FILE',
    });
    const log = makeArtifact('research.experiment_log', 'completed', {
      id: 'experiment-log-2',
      producerStepRunId: completedAttempt.id,
      kind: 'FILE',
    });
    raw.metadata.path = 'workflows/run/step-run-2/research/raw-result.json';
    raw.metadata.contentHash = 'a'.repeat(64);
    log.metadata.path = 'workflows/run/step-run-2/research/experiment-log.txt';
    log.metadata.contentHash = 'b'.repeat(64);
    const context = makeContext('R14', {
      steps: [failedAttempt, completedAttempt, makeContext('R14').step],
      artifacts: [record, raw, log],
    });

    const result = await new ResearchWorkflowFixtureGateway(() => context).generate(request());
    const finalPackage = JSON.parse(result.text) as {
      experimentAttempts: Array<Record<string, unknown>>;
      rawResultArtifactIds: string[];
      experimentLogArtifactIds: string[];
      experimentAttemptArtifactIds?: string[];
    };
    expect(finalPackage.experimentAttempts).toEqual([
      {
        stepRunId: failedAttempt.id,
        missionRunId: 'mission-run-r08-failed',
        attempt: 1,
        outcome: 'FAILED',
        recordArtifactId: '',
        errorCode: 'TOOL_EXECUTION_FAILED',
        rawPaths: [],
        rawHashes: [],
      },
      {
        stepRunId: completedAttempt.id,
        missionRunId: 'mission-run-r08-completed',
        attempt: 2,
        outcome: 'COMPLETED',
        recordArtifactId: 'experiment-record-2',
        errorCode: '',
        rawPaths: [
          'workflows/run/step-run-2/research/raw-result.json',
          'workflows/run/step-run-2/research/experiment-log.txt',
        ],
        rawHashes: ['a'.repeat(64), 'b'.repeat(64)],
      },
    ]);
    expect(finalPackage).not.toHaveProperty('experimentAttemptArtifactIds');
    expect(finalPackage.rawResultArtifactIds).toContain('raw-result-2');
    expect(finalPackage.experimentLogArtifactIds).toContain('experiment-log-2');
  });

  it('creates files only for an explicit HUMAN_OR_EXTERNAL submission, without writing or asserting facts', () => {
    const plan = makeArtifact(
      'research.experiment_plan',
      { method: 'Observe an external process safely.' },
      { id: 'plan-external' },
    );
    const external = makeContext('R08', {
      artifacts: [plan],
      inputs: { experimentMode: 'HUMAN_OR_EXTERNAL' },
    });
    const files = createResearchHumanBridgeFixtureFiles(external.detail, external.step);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      outputKey: 'research.raw_result',
      mediaType: 'application/json',
    });
    expect(files[0]!.contentHash).toBe(sha256(files[0]!.bytes));
    const mixed = makeContext('R08', { artifacts: [plan], inputs: { experimentMode: 'MIXED' } });
    expect(() => createResearchHumanBridgeFixtureFiles(mixed.detail, mixed.step)).toThrow(
      'explicit Human Bridge',
    );
  });
});

describe('research MCP stdio fixture', () => {
  it('returns URL/hash-backed source facts and bounded experiment artifact paths without shell/network', () => {
    const workspace = join(process.cwd(), '.test-data', `w23-mcp-${randomUUID()}`);
    mkdirSync(join(workspace, 'datasets'), { recursive: true });
    writeFileSync(
      join(workspace, 'datasets', 'research-fixture.csv'),
      'group,value\nbaseline,11\nbaseline,12\ncandidate,13\ncandidate,14\n',
      'utf8',
    );
    const experimentInput = {
      workflowRunId: 'workflow-1',
      stepRunId: 'step-r08-1',
      attempt: 1,
      attemptNumber: 1,
      planArtifactId: 'plan-1',
      operationKey: 'workflow:workflow-1:step-r08-1',
      mode: 'COMPUTATIONAL',
      method: 'Calculate bounded group means.',
      datasetRelativePath: 'datasets/research-fixture.csv',
      rawResultPath: 'workflows/workflow-1/step-r08-1/research/raw-result.json',
      experimentLogPath: 'workflows/workflow-1/step-r08-1/research/experiment-log.txt',
    };
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'research_sources',
          arguments: {
            workflowRunId: 'workflow-1',
            stepRunId: 'step-r02-1',
            researchQuestion: 'A bounded offline research question',
            field: 'Computer systems',
            scope: '',
            literatureTimeRange: { from: '1980-01-01', to: '2026-12-31' },
            maxResults: 8,
          },
        },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'run_experiment', arguments: experimentInput },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'run_experiment',
          arguments: { ...experimentInput, rawResultPath: '../../escape.json' },
        },
      },
    ];
    const processResult = spawnSync(
      process.execPath,
      [resolve(process.cwd(), 'scripts/fixtures/research-mcp-fixture.mjs')],
      {
        cwd: workspace,
        input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      },
    );
    expect(processResult.status).toBe(0);
    const replies = processResult.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const sources = replies[1]!.result as {
      structuredContent: { workflowEvidence: { researchSources: Array<Record<string, unknown>> } };
    };
    expect(sources.structuredContent.workflowEvidence.researchSources).toHaveLength(2);
    expect(sources.structuredContent.workflowEvidence.researchSources[0]).toMatchObject({
      url: expect.stringMatching(/^https:/),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const experiment = replies[2]!.result as {
      structuredContent: {
        workflowEvidence: {
          researchExperiment: Record<string, unknown>;
          artifactFiles: Array<Record<string, unknown>>;
        };
      };
    };
    expect(experiment.structuredContent.workflowEvidence.researchExperiment).toMatchObject({
      planArtifactId: 'plan-1',
      status: 'SUCCEEDED',
      negativeResult: true,
    });
    for (const file of experiment.structuredContent.workflowEvidence.artifactFiles) {
      const path = join(workspace, ...String(file.path).split('/'));
      expect(sha256(readFileSync(path))).toBe(file.contentHash);
    }
    expect(replies[3]!.result).toMatchObject({ isError: true });
  });
});
