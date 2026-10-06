import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMissionPort, WorkflowMissionSnapshot } from '@cultivation/application';
import type {
  Mission,
  WorkflowArtifact,
  WorkflowDetail,
  WorkflowStepDefinition,
  WorkflowStepRun,
  WorkflowVersion,
} from '@cultivation/domain';
import {
  GenerationWorkflowMissionAdapter,
  type GenerationWorkflowExecutionPort,
} from './g3-workflow-adapter.js';

// In managed worktrees workspace package junctions can point at the primary checkout.
// Exercise this worktree's W1 validator so the adapter fixture uses the same frozen contract.
vi.mock('@cultivation/domain', async () => {
  const actual = await vi.importActual<typeof import('@cultivation/domain')>('@cultivation/domain');
  const workflow = await import('../../../../packages/domain/src/w1-workflow.js');
  return { ...actual, validateWorkflowVersion: workflow.validateWorkflowVersion };
});

const at = '2026-10-06T00:00:00.000Z';
const refKeys = ['type', 'artifact'];

function generatedStep(overrides: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition {
  return {
    id: 'generate',
    type: 'TASK',
    title: 'Generate media',
    objective: 'A quiet lake at sunrise',
    routing: { requiredExecutionProtocol: 'GENERATION' },
    inputs: [],
    outputs: [
      {
        key: 'media-ref',
        kind: 'JSON',
        required: true,
        contractId: 'generation-artifact-ref',
        contractVersion: '1',
        maxSizeBytes: 32_000,
        description: 'Reference to registered media output',
        validator: { type: 'JSON', requiredKeys: refKeys },
      },
    ],
    executionRequirements: {
      generation: {
        capability: 'IMAGE_GENERATION',
        requiredFeatures: ['TEXT_TO_IMAGE'],
        parameters: {},
        expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
      },
    },
    maxAttempts: 2,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'NONE',
    ...overrides,
  };
}

function reviewStep(overrides: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition {
  return {
    id: 'review',
    type: 'REVIEW',
    title: 'Review media',
    objective: 'Review the generated media',
    routing: { requiredExecutionProtocol: 'LANGUAGE' },
    inputs: [{ key: 'media', fromStepId: 'generate', outputKey: 'media-ref', required: true }],
    outputs: [
      {
        key: 'decision',
        kind: 'JSON',
        required: true,
        contractId: 'review-decision',
        contractVersion: '1',
        maxSizeBytes: 1000,
        description: 'Review decision',
        validator: { type: 'JSON', requiredKeys: ['verdict', 'reviewedArtifactIds'] },
      },
    ],
    maxAttempts: 2,
    exitCondition: 'REVIEW_PASS',
    effectType: 'NONE',
    ...overrides,
  };
}

function workflowVersion(
  steps: WorkflowStepDefinition[] = [generatedStep()],
  policy?: string,
): WorkflowVersion {
  return {
    definition: {
      id: policy ? 'official.ai-news-video' : 'test.g3-generation',
      name: 'Generation fixture',
      description: '',
      category: 'test',
      source: policy ? 'BUILTIN' : 'USER',
    },
    version: 1,
    ...(policy ? { validationPolicy: policy } : {}),
    entryStepId: steps[0]!.id,
    steps,
    edges:
      steps.length > 1
        ? [
            {
              id: 'generate-review',
              fromStepId: 'generate',
              toStepId: 'review',
              branch: 'continue',
              condition: { type: 'ALWAYS' },
            },
          ]
        : [],
    referenceBasis: [],
    createdAt: at,
  };
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-g3',
    title: 'Generate media',
    objective: 'A quiet lake at sunrise',
    initiatorType: 'USER',
    initiatorId: 'local-user',
    coordinatorTeammateId: 'generation-teammate',
    partyId: null,
    mode: 'SOLO',
    state: 'DRAFT',
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    ...overrides,
  };
}

function makeStepRun(overrides: Partial<WorkflowStepRun> = {}): WorkflowStepRun {
  return {
    id: 'workflow-step-run-generate',
    workflowRunId: 'workflow-run-g3',
    stepId: 'generate',
    attempt: 1,
    state: 'READY',
    missionId: null,
    missionRunId: null,
    waitReason: null,
    errorCode: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeDetail(
  version = workflowVersion(),
  step = makeStepRun(),
  additions: Partial<WorkflowDetail> = {},
): WorkflowDetail {
  return {
    run: {
      id: 'workflow-run-g3',
      definitionId: version.definition.id,
      definitionVersion: version.version,
      state: 'RUNNING',
      waitReason: null,
      createdAt: at,
      updatedAt: at,
    },
    version,
    steps: [step],
    artifacts: [],
    bindings: [],
    validations: [],
    decisions: [],
    checkpoints: [],
    events: [],
    ...additions,
  };
}

function testOnlyGenerationPort() {
  // TEST_ONLY durable facts intentionally survive construction of a new adapter/port instance.
  const frozenBindings = new Map<string, { workflowRunId: string; stepRunId: string }>();
  const jobs = new Map<
    string,
    { taskId: string; jobId: string; artifactId: string; runId: string }
  >();
  const port = (): GenerationWorkflowExecutionPort => ({
    prepare: vi.fn(async () => ({ routing: {} })),
    bind: vi.fn((mission, detail, step) => {
      frozenBindings.set(mission.id, { workflowRunId: detail.run.id, stepRunId: step.id });
    }),
    start: vi.fn(async (missionId) => {
      if (!frozenBindings.has(missionId)) throw new Error('missing frozen Workflow binding');
      if (!jobs.has(missionId))
        jobs.set(missionId, {
          taskId: 'generation-task-g3',
          jobId: 'generation-job-g3',
          artifactId: 'generation-artifact-g3',
          runId: 'mission-run-g3',
        });
    }),
    snapshot: vi.fn((missionId) => testOnlySnapshot(missionId, jobs.get(missionId)!)),
    collectOutputs: vi.fn(async (missionId) => testOnlySnapshot(missionId, jobs.get(missionId)!)),
    handles: vi.fn((missionId) => frozenBindings.has(missionId)),
  });
  return { port, jobs, frozenBindings, testOnly: true as const };
}

function testOnlySnapshot(
  missionId: string,
  identity: { taskId: string; jobId: string; artifactId: string; runId: string },
): WorkflowMissionSnapshot {
  const mission = makeMission({ id: missionId, state: 'COMPLETED', completedAt: at });
  const content = JSON.stringify({
    type: 'GENERATION_ARTIFACT_REF',
    artifact: {
      id: identity.artifactId,
      kind: 'IMAGE',
      mimeType: 'image/png',
      contentHash: 'a'.repeat(64),
      sizeBytes: 24,
    },
  });
  return {
    mission,
    run: {
      id: identity.runId,
      missionId,
      attempt: 1,
      status: 'COMPLETED',
      startedAt: at,
      endedAt: at,
      errorCode: null,
      errorMessage: null,
      resultText: content,
    },
    outputs: [
      {
        source: 'MISSION',
        sourceId: identity.runId,
        actorId: 'generation-teammate',
        kind: 'JSON',
        content,
        metadata: {
          outputKey: 'media-ref',
          generationTaskId: identity.taskId,
          generationJobId: identity.jobId,
          generationArtifactId: identity.artifactId,
          workflowStepRunId: 'workflow-step-run-generate',
          evidenceEventId: 'generation-completed-event-g3',
          contentHash: 'a'.repeat(64),
          mimeType: 'image/png',
          sizeBytes: 24,
          kind: 'IMAGE',
        },
      },
    ],
    uncertainSideEffects: false,
  };
}

function makeAdapter(
  detail: WorkflowDetail,
  generation: GenerationWorkflowExecutionPort,
  delegateOverrides: Partial<WorkflowMissionPort> = {},
) {
  const mission = makeMission();
  const delegate: WorkflowMissionPort = {
    prepareExecution: vi.fn(async () => ({})),
    create: vi.fn(async (_input, bind) => {
      bind(mission);
      return { status: 'CREATED' as const, mission };
    }),
    snapshot: vi.fn(() => ({
      mission,
      run: null,
      outputs: [],
      uncertainSideEffects: false,
    })),
    collectOutputs: vi.fn(async () => ({
      mission,
      run: null,
      outputs: [],
      uncertainSideEffects: false,
    })),
    start: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(),
    ...delegateOverrides,
  };
  const workflows = {
    detail: vi.fn((id: string) => (id === detail.run.id ? detail : null)),
    findStepByMissionId: vi.fn(
      (id: string) => detail.steps.find((step) => step.missionId === id) ?? null,
    ),
  };
  return {
    adapter: new GenerationWorkflowMissionAdapter(delegate, workflows, generation),
    delegate,
    workflows,
    mission,
  };
}

describe('G3 Workflow Mission adapter', () => {
  it('routes only a frozen Generation Step through the dispatcher while binding the existing Mission', async () => {
    const detail = makeDetail();
    const testOnly = testOnlyGenerationPort();
    const generation = testOnly.port();
    const { adapter, delegate, mission } = makeAdapter(detail, generation);
    const definition = detail.version.steps[0]!;
    const step = detail.steps[0]!;

    expect(await adapter.prepareExecution!(definition, detail, step)).toEqual({
      routing: { executionConstraint: 'SOLO' },
    });
    const bind = vi.fn((created: Mission) => {
      detail.steps[0] = { ...step, missionId: created.id };
    });
    const input = {
      title: definition.title,
      context: {
        objective: definition.objective,
        executionConstraint: 'SOLO',
        requiredExecutionProtocol: 'GENERATION',
        executionContext: {
          origin: 'WORKFLOW',
          executionId: detail.run.id,
          stepId: step.id,
          stepType: 'TASK',
        },
      },
    } as Parameters<WorkflowMissionPort['create']>[0];
    expect((await adapter.create(input, bind)).status).toBe('CREATED');
    expect(generation.bind).toHaveBeenCalledWith(mission, detail, step, definition);
    expect(delegate.create).toHaveBeenCalledTimes(1);
    expect(await adapter.start(mission.id)).toBeUndefined();
    expect(generation.start).toHaveBeenCalledWith(mission.id);
    expect(delegate.start).not.toHaveBeenCalled();
    expect(adapter.snapshot(mission.id).outputs[0]?.kind).toBe('JSON');
    expect(generation.snapshot).toHaveBeenCalledWith(mission.id);
  });

  it('preserves legacy BUILTIN LANGUAGE routing and delegates start unchanged', async () => {
    const definition = generatedStep({
      id: 'news-task',
      routing: { requiredExecutionProtocol: 'LANGUAGE' },
      executionRequirements: undefined,
    });
    const version = workflowVersion([definition], 'news-integrity-v1');
    const step = makeStepRun({ stepId: definition.id });
    const detail = makeDetail(version, step);
    const generation = testOnlyGenerationPort().port();
    const { adapter, delegate } = makeAdapter(detail, generation);
    const expected = { routing: { executionConstraint: 'AUTO' as const } };
    vi.mocked(delegate.prepareExecution!).mockResolvedValue(expected);

    expect(await adapter.prepareExecution!(definition, detail, step)).toEqual(expected);
    await adapter.start('mission-g3');
    expect(delegate.start).toHaveBeenCalledWith('mission-g3');
    expect(generation.start).not.toHaveBeenCalled();
  });

  it('rejects unknown or mismatched frozen Generation structures without language fallback', async () => {
    const definition = generatedStep({
      executionRequirements: {
        generation: {
          capability: 'IMAGE_GENERATION',
          requiredFeatures: ['TEXT_TO_IMAGE'],
          parameters: {},
          expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
          provider: 'provider-specific',
        } as never,
      },
    });
    const detail = makeDetail(workflowVersion([definition]));
    const generation = testOnlyGenerationPort().port();
    const { adapter, delegate } = makeAdapter(detail, generation);

    expect(await adapter.prepareExecution!(definition, detail, detail.steps[0]!)).toEqual({
      reason: 'WORKFLOW_GENERATION_INVALID',
    });
    expect(generation.prepare).not.toHaveBeenCalled();
    expect(delegate.prepareExecution).not.toHaveBeenCalled();
  });

  it('sends a validated media ArtifactRef review to HUMAN_BRIDGE', async () => {
    const generate = generatedStep();
    const review = reviewStep();
    const version = workflowVersion([generate, review]);
    const step = makeStepRun({ id: 'workflow-step-run-review', stepId: 'review' });
    const mediaRef = {
      type: 'GENERATION_ARTIFACT_REF',
      artifact: {
        id: 'generation-artifact-g3',
        kind: 'IMAGE',
        mimeType: 'image/png',
        contentHash: 'a'.repeat(64),
        sizeBytes: 24,
      },
    };
    const artifact: WorkflowArtifact = {
      id: 'workflow-artifact-ref',
      workflowRunId: 'workflow-run-g3',
      producerStepRunId: 'workflow-step-run-generate',
      missionId: 'mission-g3',
      missionRunId: 'mission-run-g3',
      actorId: 'generation-teammate',
      sourceId: 'mission-run-g3',
      source: 'MISSION',
      kind: 'JSON',
      content: JSON.stringify(mediaRef),
      contentHash: 'b'.repeat(64),
      metadata: {
        generationTaskId: 'generation-task-g3',
        generationJobId: 'generation-job-g3',
        generationArtifactId: 'generation-artifact-g3',
        workflowStepRunId: 'workflow-step-run-generate',
        evidenceEventId: 'generation-completed-event-g3',
        contentHash: 'a'.repeat(64),
        mimeType: 'image/png',
        sizeBytes: 24,
        kind: 'IMAGE',
      },
      inputArtifactIds: [],
      createdAt: at,
    };
    const detail = makeDetail(version, step, {
      artifacts: [artifact],
      bindings: [
        {
          id: 'binding-review-media',
          workflowRunId: 'workflow-run-g3',
          stepRunId: step.id,
          key: 'media',
          artifactId: artifact.id,
          role: 'INPUT',
          contractId: 'generation-artifact-ref',
          contractVersion: '1',
          createdAt: at,
        },
      ],
      validations: [
        {
          id: 'validation-media-ref',
          stepRunId: 'workflow-step-run-generate',
          artifactId: artifact.id,
          contractId: 'generation-artifact-ref',
          contractVersion: '1',
          validatorVersion: 'w1-json-v1',
          contentHash: artifact.contentHash,
          valid: true,
          errors: [],
          createdAt: at,
        },
      ],
    });
    const generation = testOnlyGenerationPort().port();
    const { adapter, delegate } = makeAdapter(detail, generation);
    vi.mocked(delegate.prepareExecution!).mockResolvedValue({
      routing: { executionConstraint: 'SOLO' },
    });

    expect(await adapter.prepareExecution!(review, detail, step)).toEqual({
      routing: { executionConstraint: 'HUMAN_BRIDGE' },
    });
  });

  it('TEST_ONLY restart reuses the same GenerationTask, Job, and registered Artifact', async () => {
    const detail = makeDetail();
    const testOnly = testOnlyGenerationPort();
    const { adapter, mission } = makeAdapter(detail, testOnly.port());
    const step = detail.steps[0]!;
    await adapter.create(
      {
        title: 'Generate media',
        context: {
          objective: 'Generate media',
          requiredExecutionProtocol: 'GENERATION',
          executionContext: {
            origin: 'WORKFLOW',
            executionId: detail.run.id,
            stepId: step.id,
          },
        } as never,
      },
      (created) => {
        detail.steps[0] = { ...step, missionId: created.id };
      },
    );
    await adapter.start(mission.id);
    const first = structuredClone(testOnly.jobs.get(mission.id));

    // Reconstruct Main's decorator and execution port over the same durable TEST_ONLY facts.
    const restarted = makeAdapter(detail, testOnly.port());
    await restarted.adapter.start(mission.id);
    const resumed = testOnly.jobs.get(mission.id);

    expect(resumed).toEqual(first);
    expect(resumed).toEqual({
      taskId: 'generation-task-g3',
      jobId: 'generation-job-g3',
      artifactId: 'generation-artifact-g3',
      runId: 'mission-run-g3',
    });
    expect(testOnly.jobs.size).toBe(1);
  });
});
