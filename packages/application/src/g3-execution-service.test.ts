import { describe, expect, it, vi } from 'vitest';
import {
  parseParticipantOutcome,
  transitionExecutionAttempt,
  type ArtifactRef,
  type ExecutionAttempt,
  type ExecutionAttemptState,
  type ExecutionTask,
  type G3Continuation,
  type G3ContinuationDecision,
  type ParticipantOutcome,
  type ParticipantOutcomeFact,
} from '../../domain/src/g3-execution.js';
import type {
  GenerationJob,
  GenerationModelDescriptor,
  GenerationTask,
} from '../../domain/src/g1-generation.js';
import { G3ExecutionService, type G3ExecutionRepository } from './g3-execution-service.js';

const timestamp = '2026-10-06T08:00:00.000Z';

class MemoryRepository implements G3ExecutionRepository {
  readonly tasks = new Map<string, ExecutionTask>();
  readonly attempts = new Map<string, ExecutionAttempt>();
  readonly outcomes = new Map<string, ParticipantOutcomeFact>();
  readonly continuations = new Map<string, G3Continuation>();
  readonly artifactRefs = new Map<string, ArtifactRef>();
  private sequence = 0;

  createTask(task: ExecutionTask): ExecutionTask {
    const existing = this.tasks.get(task.id);
    if (existing) return existing;
    this.tasks.set(task.id, task);
    return task;
  }
  getTask(id: string): ExecutionTask | null {
    return this.tasks.get(id) ?? null;
  }
  listTasks(missionId?: string, runId?: string): ExecutionTask[] {
    return [...this.tasks.values()].filter(
      (task) =>
        (missionId === undefined || task.missionId === missionId) &&
        (runId === undefined || task.runId === runId),
    );
  }
  createAttempt(
    taskId: string,
    input: { id?: string; runtimeProfileId?: string | null; attemptNo?: number } = {},
  ): ExecutionAttempt {
    const attemptNo = input.attemptNo ?? 1;
    const existing = [...this.attempts.values()].find(
      (attempt) => attempt.taskId === taskId && attempt.attemptNo === attemptNo,
    );
    if (existing) return existing;
    const attempt: ExecutionAttempt = {
      id: input.id ?? `attempt-${++this.sequence}`,
      taskId,
      attemptNo,
      runtimeProfileId: input.runtimeProfileId ?? null,
      state: 'PREPARED',
      generationJobId: null,
      externalWorkRequestId: null,
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.attempts.set(attempt.id, attempt);
    return attempt;
  }
  getAttempt(id: string): ExecutionAttempt | null {
    return this.attempts.get(id) ?? null;
  }
  listAttempts(taskId?: string): ExecutionAttempt[] {
    return [...this.attempts.values()]
      .filter((attempt) => taskId === undefined || attempt.taskId === taskId)
      .sort((left, right) => left.attemptNo - right.attemptNo);
  }
  transitionAttempt(
    id: string,
    expected: ExecutionAttemptState,
    next: ExecutionAttemptState,
    patch: { errorCode?: string | null } = {},
  ): ExecutionAttempt {
    const attempt = this.requireAttempt(id);
    if (attempt.state !== expected)
      throw new Error(`CAS conflict: ${expected} != ${attempt.state}`);
    transitionExecutionAttempt(expected, next);
    const updated = { ...attempt, state: next, updatedAt: timestamp };
    if (patch.errorCode !== undefined) updated.errorCode = patch.errorCode;
    this.attempts.set(id, updated);
    return updated;
  }
  bindGenerationJob(attemptId: string, jobId: string): ExecutionAttempt {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.generationJobId && attempt.generationJobId !== jobId)
      throw new Error('Already bound');
    const updated = { ...attempt, generationJobId: jobId };
    this.attempts.set(attemptId, updated);
    return updated;
  }
  bindExternalWork(attemptId: string, requestId: string): ExecutionAttempt {
    const attempt = this.requireAttempt(attemptId);
    const updated = { ...attempt, externalWorkRequestId: requestId };
    this.attempts.set(attemptId, updated);
    return updated;
  }
  appendOutcome(attemptId: string, value: ParticipantOutcome): ParticipantOutcomeFact {
    const existing = [...this.outcomes.values()].find((fact) => fact.attemptId === attemptId);
    if (existing) return existing;
    const attempt = this.requireAttempt(attemptId);
    const task = this.getTask(attempt.taskId)!;
    const outcome = parseParticipantOutcome(value);
    const fact: ParticipantOutcomeFact = {
      id: `outcome-${++this.sequence}`,
      taskId: task.id,
      attemptId,
      missionId: task.missionId,
      runId: task.runId,
      collaborationRequestId: task.collaborationRequestId,
      participantTeammateId: task.targetTeammateId,
      executionProtocol: task.executionProtocol,
      outcome,
      createdAt: timestamp,
      consumedAt: null,
    };
    this.outcomes.set(fact.id, fact);
    return fact;
  }
  getOutcome(attemptId: string): ParticipantOutcomeFact | null {
    return [...this.outcomes.values()].find((fact) => fact.attemptId === attemptId) ?? null;
  }
  consumeOutcome(id: string, at: string): boolean {
    const fact = this.outcomes.get(id);
    if (!fact || fact.consumedAt) return false;
    this.outcomes.set(id, { ...fact, consumedAt: at });
    return true;
  }
  saveContinuation(outcomeId: string, decision: G3ContinuationDecision): G3Continuation {
    const previous = [...this.continuations.values()].find((item) => item.outcomeId === outcomeId);
    if (previous) return previous;
    const fact = this.outcomes.get(outcomeId)!;
    const continuation: G3Continuation = {
      id: `continuation-${++this.sequence}`,
      outcomeId,
      taskId: fact.taskId,
      attemptId: fact.attemptId,
      missionId: fact.missionId,
      runId: fact.runId,
      collaborationRequestId: fact.collaborationRequestId,
      decision,
      continuationRound: this.getTask(fact.taskId)!.continuationRound + 1,
      createdAt: timestamp,
      consumedAt: null,
    };
    this.continuations.set(continuation.id, continuation);
    return continuation;
  }
  getContinuation(outcomeId: string): G3Continuation | null {
    return [...this.continuations.values()].find((item) => item.outcomeId === outcomeId) ?? null;
  }
  consumeContinuation(id: string, at: string): boolean {
    const continuation = this.continuations.get(id);
    if (!continuation || continuation.consumedAt) return false;
    this.continuations.set(id, { ...continuation, consumedAt: at });
    return true;
  }
  registerArtifactRef(_missionId: string, _runId: string, ref: ArtifactRef): void {
    void _missionId;
    void _runId;
    this.artifactRefs.set(ref.id, ref);
  }
  listArtifactRefs(_missionId: string, _runId: string): ArtifactRef[] {
    void _missionId;
    void _runId;
    return [...this.artifactRefs.values()];
  }
  transaction<T>(operation: () => T): T {
    return operation();
  }

  private requireAttempt(id: string): ExecutionAttempt {
    const attempt = this.getAttempt(id);
    if (!attempt) throw new Error(`No attempt ${id}`);
    return attempt;
  }
}

function makeTask(
  protocol: 'LANGUAGE' | 'GENERATION',
  id: string,
  inputRequirements: ExecutionTask['inputRequirements'] = [],
): ExecutionTask {
  return {
    id,
    logicalKey: `g3:${id}`,
    source: 'COLLABORATION',
    missionId: 'mission-1',
    runId: 'run-1',
    collaborationRequestId: 'request-1',
    workflowRunId: null,
    workflowStepRunId: null,
    requesterTeammateId: 'coordinator-1',
    coordinatorTeammateId: 'coordinator-1',
    targetTeammateId: protocol === 'LANGUAGE' ? 'language-1' : 'generation-1',
    requiredCapability: protocol === 'LANGUAGE' ? 'GENERAL_REASONING' : 'IMAGE_GENERATION',
    executionProtocol: protocol,
    publicTask: `Task ${id}`,
    publicContext: 'Test context.',
    artifactInputs: [],
    generationRequirements:
      protocol === 'GENERATION'
        ? {
            capability: 'IMAGE_GENERATION',
            requiredFeatures: ['TEXT_TO_IMAGE'],
            prompt: 'Generate a clean image.',
            parameters: {},
            expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
            outputDestination: { scope: 'APP_ARTIFACT_STORE' },
            inputRequirements,
          }
        : null,
    acceptanceCriteria: ['Return a bounded result.'],
    inputRequirements,
    dependencyRole: null,
    reviewOf: [],
    parentTaskId: null,
    retryNo: 0,
    continuationRound: 0,
    policyVersion: 'g3-execution-policy-v1',
    createdAt: timestamp,
  };
}

const descriptor: GenerationModelDescriptor = {
  modelId: 'model-image-1',
  outputCapability: 'IMAGE_GENERATION',
  executionMode: 'ASYNC_JOB',
  featureTags: ['TEXT_TO_IMAGE'],
  inputRoles: [
    { role: 'REFERENCE', artifactKinds: ['IMAGE'], mimeTypes: ['image/png'], maxFiles: 1 },
  ],
  parameterSchema: {},
  outputTypes: ['IMAGE'],
  limits: { maxInputFiles: 1, maxInputBytes: 100_000, maxOutputBytes: 100_000, maxOutputs: 1 },
};

function makeJob(
  id: string,
  state: GenerationJob['state'],
  errorCode: string | null = null,
): GenerationJob {
  return {
    id,
    generationTaskId: `task-${id}`,
    teammateId: 'generation-1',
    runtimeProfileId: 'runtime-generation',
    providerJobId: null,
    idempotencyKey: `key-${id}`,
    requestFingerprint: `fingerprint-${id}`,
    state,
    providerStatus: null,
    outputArtifactIds: [],
    errorCode,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: state === 'COMPLETED' ? timestamp : null,
  };
}

function harness(
  options: {
    generationJob?: GenerationJob;
    languageResult?: ParticipantOutcome;
  } = {},
) {
  const repository = new MemoryRepository();
  const job = options.generationJob ?? makeJob('job-1', 'UNKNOWN', 'PROVIDER_TIMEOUT');
  const generation = {
    create: vi.fn(async (input: Omit<GenerationTask, 'id' | 'createdAt'>) => {
      const created = makeJob('job-1', 'QUEUED');
      repository.bindGenerationJob(input.executionAttemptId!, created.id);
      return created;
    }),
    advance: vi.fn(async () => job),
    detail: vi.fn(() => ({ artifacts: [] })),
  };
  const generationFacts = {
    getTask: vi.fn(() => null),
    getDescriptor: vi.fn(() => descriptor),
    getJob: vi.fn(() => job),
  };
  const gateway = { getDescriptor: vi.fn(async () => descriptor) };
  const ports = {
    identity: vi.fn((teammateId: string) => ({
      executionProtocol:
        teammateId === 'language-1' ? ('LANGUAGE' as const) : ('GENERATION' as const),
      runtimeProfileId: teammateId === 'language-1' ? 'runtime-language' : 'runtime-generation',
    })),
    assertExecutionAllowed: vi.fn(),
    verifyArtifact: vi.fn(async () => undefined),
    language: vi.fn(
      async () =>
        options.languageResult ??
        ({ kind: 'RESULT', publicResult: 'Done.', artifactRefs: [] } as const),
    ),
    human: vi.fn(async () => ({ kind: 'WAITING' as const })),
    provenRetryableRejection: vi.fn(
      (candidate: GenerationJob) => candidate.errorCode === 'QUEUE_FULL',
    ),
    event: vi.fn(),
  };
  let id = 0;
  const service = new G3ExecutionService(
    repository,
    generation as never,
    generationFacts as never,
    gateway as never,
    ports as never,
    { id: () => `successor-${++id}`, now: () => timestamp },
  );
  return { repository, generation, generationFacts, gateway, ports, service };
}

describe('G3ExecutionService', () => {
  it.each(['FEATURE', 'ROLE'] as const)(
    'rejects unsupported %s before creating a GenerationJob',
    async (invalid) => {
      const { generation, service } = harness();
      const task = makeTask('GENERATION', `invalid-${invalid}`);
      if (invalid === 'FEATURE')
        task.generationRequirements!.requiredFeatures = ['ARBITRARY_FEATURE'];
      else
        task.generationRequirements!.inputRequirements = [
          {
            role: 'UNDECLARED_ROLE',
            artifactKinds: ['IMAGE'],
            mimeTypes: ['image/png'],
            required: true,
          },
        ];
      const progress = await service.dispatch(task);
      expect(progress.kind).toBe('OUTCOME');
      if (progress.kind !== 'OUTCOME') throw new Error('Expected rejected preparation');
      expect(progress.fact.outcome).toMatchObject({
        kind: 'FAILED_TERMINAL',
        errorCode: invalid === 'FEATURE' ? 'UNSUPPORTED_FEATURE' : 'UNSUPPORTED_INPUT_ROLE',
      });
      expect(generation.create).not.toHaveBeenCalled();
      expect(generation.advance).not.toHaveBeenCalled();
    },
  );

  it('rejects changed input integrity before submit and does not turn it into permission authority', async () => {
    const { generation, ports, service } = harness();
    const task = makeTask('GENERATION', 'changed-input');
    task.artifactInputs = [
      {
        id: 'other-run-artifact',
        kind: 'IMAGE',
        mimeType: 'image/png',
        contentHash: 'a'.repeat(64),
        sizeBytes: 68,
        role: 'REFERENCE',
      },
    ];
    ports.verifyArtifact.mockRejectedValue(new Error('Artifact hash/provenance mismatch'));
    const progress = await service.dispatch(task);
    expect(progress).toMatchObject({
      kind: 'OUTCOME',
      attempt: { state: 'FAILED' },
      fact: { outcome: { kind: 'FAILED_TERMINAL' } },
    });
    expect(generation.create).not.toHaveBeenCalled();
  });

  it('persists a bounded LANGUAGE result as a completed outcome fact', async () => {
    const { repository, service } = harness();
    const progress = await service.dispatch(makeTask('LANGUAGE', 'language-success'));
    expect(progress.kind).toBe('OUTCOME');
    if (progress.kind !== 'OUTCOME') throw new Error('Expected an outcome');
    expect(progress.attempt.state).toBe('COMPLETED');
    expect(progress.fact).toMatchObject({
      missionId: 'mission-1',
      runId: 'run-1',
      collaborationRequestId: 'request-1',
      executionProtocol: 'LANGUAGE',
      outcome: { kind: 'RESULT', publicResult: 'Done.' },
    });
    expect(repository.getOutcome(progress.attempt.id)?.id).toBe(progress.fact.id);
  });

  it('keeps an ambiguous GenerationJob UNKNOWN and never submits it again', async () => {
    const { generation, service } = harness({
      generationJob: makeJob('job-1', 'UNKNOWN', 'PROVIDER_TIMEOUT'),
    });
    const task = makeTask('GENERATION', 'generation-unknown');
    const first = await service.dispatch(task);
    expect(first.kind).toBe('WAITING');
    if (first.kind !== 'WAITING') throw new Error('Expected waiting state');
    expect(first.attempt).toMatchObject({ state: 'UNKNOWN', generationJobId: 'job-1' });
    const recovered = await service.advance(task.id);
    expect(recovered).toMatchObject({ kind: 'WAITING', attempt: { state: 'UNKNOWN' } });
    expect(generation.create).toHaveBeenCalledTimes(1);
    expect(generation.advance).toHaveBeenCalledTimes(1);
  });

  it('allows one retryable Generation rejection and persists the successor intent', async () => {
    const { repository, service } = harness({
      generationJob: makeJob('job-1', 'FAILED', 'QUEUE_FULL'),
    });
    const original = makeTask('GENERATION', 'generation-retry');
    const progress = await service.dispatch(original);
    expect(progress.kind).toBe('OUTCOME');
    if (progress.kind !== 'OUTCOME') throw new Error('Expected an outcome');
    expect(progress.fact.outcome).toMatchObject({
      kind: 'FAILED_RETRYABLE',
      errorCode: 'QUEUE_FULL',
    });
    const next = service.successor(original.id, { retry: true });
    expect(next).toMatchObject({
      id: 'successor-1',
      logicalKey: `${original.logicalKey}:continuation:1`,
      parentTaskId: original.id,
      retryNo: 1,
      continuationRound: 1,
    });
    expect(repository.getTask(next.id)).toEqual(next);
    expect(repository.getContinuation(progress.fact.id)?.decision).toMatchObject({
      action: 'RETRY',
      nextTaskId: next.id,
    });
  });

  it('returns NEEDS_INPUT before creating a GenerationJob when a required role is missing', async () => {
    const { generation, service } = harness();
    const task = makeTask('GENERATION', 'generation-needs-input', [
      { role: 'REFERENCE', artifactKinds: ['IMAGE'], mimeTypes: ['image/png'], required: true },
    ]);
    const progress = await service.dispatch(task);
    expect(progress.kind).toBe('OUTCOME');
    if (progress.kind !== 'OUTCOME') throw new Error('Expected an outcome');
    expect(progress.attempt.state).toBe('WAITING_INPUT');
    expect(progress.fact.outcome).toMatchObject({
      kind: 'NEEDS_INPUT',
      requirements: [{ role: 'REFERENCE', required: true }],
    });
    expect(generation.create).not.toHaveBeenCalled();
  });
});
