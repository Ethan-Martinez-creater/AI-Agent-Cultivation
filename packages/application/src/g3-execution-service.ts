import { DomainError } from '@cultivation/shared';
import {
  G3_EXECUTION_POLICY,
  parseParticipantOutcome,
  type ArtifactRef,
  type ExecutionTask,
  type ExecutionAttempt,
  type ExecutionAttemptState,
  type ParticipantOutcome,
  type ParticipantOutcomeFact,
  type G3Continuation,
  type G3ContinuationDecision,
} from '@cultivation/domain/g3-execution';
import type {
  GenerationJob,
  GenerationModelDescriptor,
  GenerationTask,
} from '@cultivation/domain/g1-generation';
import type {
  GenerationService,
  GenerationGateway,
  GenerationRepository,
} from './g1-generation.js';
import { GenerationCrash } from './g1-generation.js';

/** Durable ports: neither Workflow nor Mission objects are needed by the dispatcher. */
export interface G3ExecutionRepository {
  createTask(task: ExecutionTask): ExecutionTask;
  getTask(id: string): ExecutionTask | null;
  listTasks(missionId?: string, runId?: string): ExecutionTask[];
  createAttempt(
    taskId: string,
    input?: { id?: string; runtimeProfileId?: string | null; attemptNo?: number },
  ): ExecutionAttempt;
  getAttempt(id: string): ExecutionAttempt | null;
  listAttempts(taskId?: string): ExecutionAttempt[];
  transitionAttempt(
    id: string,
    expected: ExecutionAttemptState,
    next: ExecutionAttemptState,
    patch?: { errorCode?: string | null },
  ): ExecutionAttempt;
  bindGenerationJob(attemptId: string, jobId: string): ExecutionAttempt;
  bindExternalWork(attemptId: string, requestId: string): ExecutionAttempt;
  appendOutcome(attemptId: string, outcome: ParticipantOutcome): ParticipantOutcomeFact;
  getOutcome(attemptId: string): ParticipantOutcomeFact | null;
  consumeOutcome(id: string, at: string): boolean;
  saveContinuation(outcomeId: string, decision: G3ContinuationDecision): G3Continuation;
  getContinuation(outcomeId: string): G3Continuation | null;
  consumeContinuation(id: string, at: string): boolean;
  registerArtifactRef(
    missionId: string,
    runId: string,
    ref: ArtifactRef,
    source: { type: 'GENERATION' | 'EXTERNAL_WORK' | 'APPROVED_IMPORT'; id: string },
  ): void;
  listArtifactRefs(missionId: string, runId: string): ArtifactRef[];
  transaction<T>(operation: () => T): T;
}

export interface G3ExecutionPorts {
  identity(teammateId: string): {
    executionProtocol: ExecutionTask['executionProtocol'];
    runtimeProfileId: string | null;
  };
  assertExecutionAllowed(task: ExecutionTask): void;
  verifyArtifact(ref: ArtifactRef, task: ExecutionTask): Promise<void>;
  language(
    task: ExecutionTask,
    attempt: ExecutionAttempt,
  ): Promise<ParticipantOutcome | { kind: 'WAITING' }>;
  human(
    task: ExecutionTask,
    attempt: ExecutionAttempt,
  ): Promise<ParticipantOutcome | { kind: 'WAITING' }>;
  /** Only a durable adapter non-acceptance fact can permit a generation retry. */
  provenRetryableRejection(job: GenerationJob): boolean;
  event(
    task: ExecutionTask,
    attempt: ExecutionAttempt,
    type: string,
    data: Record<string, unknown>,
  ): void;
}

export type G3CrashPoint =
  | 'TASK_CREATED'
  | 'ATTEMPT_CREATED'
  | 'JOB_BOUND'
  | 'GENERATION_COMPLETED'
  | 'OUTCOME_CREATED'
  | 'CONTINUATION_CREATED';
export class G3ExecutionCrash extends Error {}
export type G3ExecutionProgress =
  | {
      kind: 'OUTCOME';
      task: ExecutionTask;
      attempt: ExecutionAttempt;
      fact: ParticipantOutcomeFact;
    }
  | { kind: 'WAITING'; task: ExecutionTask; attempt: ExecutionAttempt };

/** One bounded dispatcher above existing execution systems; GenerationJob remains authoritative. */
export class G3ExecutionService {
  private readonly inFlight = new Map<string, Promise<G3ExecutionProgress>>();
  constructor(
    readonly repository: G3ExecutionRepository,
    private readonly generation: Pick<GenerationService, 'create' | 'advance' | 'detail'>,
    private readonly generationFacts: Pick<
      GenerationRepository,
      'getTask' | 'getDescriptor' | 'getJob'
    >,
    private readonly gateway: Pick<GenerationGateway, 'getDescriptor'>,
    private readonly ports: G3ExecutionPorts,
    private readonly options: {
      id: () => string;
      now?: () => string;
      crash?: (point: G3CrashPoint, task: ExecutionTask) => void;
    },
  ) {}

  descriptor(teammateId: string): Promise<GenerationModelDescriptor> {
    const identity = this.ports.identity(teammateId);
    if (identity.executionProtocol !== 'GENERATION' || !identity.runtimeProfileId)
      throw new DomainError('EXECUTION_PROTOCOL_UNSUPPORTED', '此道友不是生成执行者');
    return this.gateway.getDescriptor(identity.runtimeProfileId);
  }

  async dispatch(
    snapshot: ExecutionTask,
    options?: { authorizedLanguageResume?: boolean },
  ): Promise<G3ExecutionProgress> {
    const durable = this.repository.createTask(snapshot);
    this.options.crash?.('TASK_CREATED', durable);
    return this.advance(durable.id, options);
  }

  advance(
    taskId: string,
    options?: { authorizedLanguageResume?: boolean },
  ): Promise<G3ExecutionProgress> {
    const running = this.inFlight.get(taskId);
    if (running) return running;
    const operation = this.advanceOnce(taskId, options).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, operation);
    return operation;
  }

  /** A new attempt owns a new immutable task snapshot and therefore a new generation key. */
  successor(
    taskId: string,
    changes: {
      artifactInputs?: ExecutionTask['artifactInputs'];
      publicContext?: string;
      retry?: boolean;
      targetTeammateId?: string;
      generationRequirements?: ExecutionTask['generationRequirements'];
    },
  ): ExecutionTask {
    const previous = this.requireTask(taskId);
    if (changes.targetTeammateId && changes.targetTeammateId !== previous.targetTeammateId)
      throw new DomainError('PERMISSION_DENIED', '更换执行者必须建立新的获准协作请求');
    const attempt = this.repository.listAttempts(taskId).at(-1);
    const fact = attempt ? this.repository.getOutcome(attempt.id) : null;
    if (!attempt || !fact || attempt.state === 'UNKNOWN')
      throw new DomainError('EXECUTION_CONTINUATION_INVALID', '不能重放结果未知或尚未完成的执行');
    if (changes.retry && fact.outcome.kind !== 'FAILED_RETRYABLE')
      throw new DomainError('EXECUTION_RETRY_FORBIDDEN', '此结果不允许重试');
    // A committed continuation already spent its budget. Recover its immutable task
    // before applying limits for a new decision.
    const existingDecision = this.repository.getContinuation(fact.id);
    if (existingDecision?.decision.nextTaskId)
      return this.requireTask(existingDecision.decision.nextTaskId);
    const root = this.rootTask(previous);
    const lineage = this.repository
      .listTasks(previous.missionId, previous.runId)
      .filter((task) => this.rootTask(task).id === root.id);
    if (
      lineage.length >= G3_EXECUTION_POLICY.maxParticipantAttempts ||
      previous.continuationRound >= G3_EXECUTION_POLICY.maxContinuationRounds
    )
      throw new DomainError('EXECUTION_BUDGET_EXHAUSTED', '协作续跑已达到本轮上限');
    const priorRetryCount = lineage.filter((task) => task.retryNo > 0).length;
    if (changes.retry && priorRetryCount >= G3_EXECUTION_POLICY.maxRetryAttemptsPerParticipantTask)
      throw new DomainError('EXECUTION_BUDGET_EXHAUSTED', '重试次数已达到上限');
    if (
      !changes.retry &&
      !changes.targetTeammateId &&
      !changes.generationRequirements &&
      !changes.publicContext &&
      JSON.stringify(changes.artifactInputs ?? previous.artifactInputs) ===
        JSON.stringify(previous.artifactInputs)
    )
      throw new DomainError('EXECUTION_CYCLE', '没有新素材或执行证据，不能重复相同请求');
    const next: ExecutionTask = {
      ...previous,
      id: this.options.id(),
      targetTeammateId: changes.targetTeammateId ?? previous.targetTeammateId,
      artifactInputs: changes.artifactInputs ?? previous.artifactInputs,
      publicContext: changes.publicContext ?? previous.publicContext,
      generationRequirements: changes.generationRequirements ?? previous.generationRequirements,
      parentTaskId: previous.id,
      retryNo: changes.retry ? previous.retryNo + 1 : previous.retryNo,
      continuationRound: previous.continuationRound + 1,
      createdAt: this.now(),
      logicalKey: `${root.logicalKey}:continuation:${previous.continuationRound + 1}`,
    };
    this.repository.transaction(() => {
      this.repository.createTask(next);
      this.repository.saveContinuation(fact.id, {
        action: changes.retry ? 'RETRY' : 'RESUME',
        nextTaskId: next.id,
      });
    });
    this.options.crash?.('CONTINUATION_CREATED', next);
    return next;
  }

  consume(factId: string): boolean {
    return this.repository.consumeOutcome(factId, this.now());
  }

  private async advanceOnce(
    taskId: string,
    options?: { authorizedLanguageResume?: boolean },
  ): Promise<G3ExecutionProgress> {
    const task = this.requireTask(taskId);
    this.ports.assertExecutionAllowed(task);
    const identity = this.ports.identity(task.targetTeammateId);
    if (identity.executionProtocol !== task.executionProtocol)
      throw new DomainError('EXECUTION_IDENTITY_CHANGED', '固定执行身份与任务快照不一致');
    let attempt = this.repository.createAttempt(task.id, {
      runtimeProfileId: identity.runtimeProfileId,
    });
    this.options.crash?.('ATTEMPT_CREATED', task);
    const existing = this.repository.getOutcome(attempt.id);
    if (existing) return { kind: 'OUTCOME', task, attempt, fact: existing };
    if (['UNKNOWN', 'WAITING_USER', 'COMPLETED', 'FAILED'].includes(attempt.state))
      return { kind: 'WAITING', task, attempt };
    if (task.executionProtocol === 'GENERATION') return this.advanceGeneration(task, attempt);
    if (
      task.executionProtocol === 'LANGUAGE' &&
      attempt.state === 'RUNNING' &&
      !options?.authorizedLanguageResume
    ) {
      // A provider/tool call may have happened. Replaying a missing response is not safe.
      attempt = this.repository.transitionAttempt(attempt.id, 'RUNNING', 'UNKNOWN', {
        errorCode: 'EXECUTION_INTERRUPTED',
      });
      this.ports.event(task, attempt, 'collaboration.execution_uncertain', {});
      return { kind: 'WAITING', task, attempt };
    }
    if (attempt.state === 'PREPARED')
      attempt = this.repository.transitionAttempt(attempt.id, 'PREPARED', 'RUNNING');
    try {
      const result =
        task.executionProtocol === 'LANGUAGE'
          ? await this.ports.language(task, attempt)
          : await this.ports.human(task, attempt);
      if (result.kind === 'WAITING')
        return { kind: 'WAITING', task, attempt: this.repository.getAttempt(attempt.id)! };
      return this.persist(task, attempt, parseParticipantOutcome(result));
    } catch (error) {
      if (error instanceof G3ExecutionCrash) throw error;
      return this.persist(task, attempt, {
        kind: 'FAILED_TERMINAL',
        errorCode: safeCode(error),
        reason: '执行结果未通过可信校验',
      });
    }
  }

  private async advanceGeneration(
    task: ExecutionTask,
    original: ExecutionAttempt,
  ): Promise<G3ExecutionProgress> {
    let attempt = original;
    const requirements = task.generationRequirements;
    if (!requirements)
      return this.persist(task, attempt, {
        kind: 'FAILED_TERMINAL',
        errorCode: 'GENERATION_REQUIREMENTS_REQUIRED',
        reason: '生成任务需要明确执行要求',
      });
    try {
      const descriptor = attempt.generationJobId
        ? this.generationFacts.getDescriptor(
            this.generationFacts.getJob(attempt.generationJobId)!.generationTaskId,
          )!
        : await this.descriptor(task.targetTeammateId);
      if (
        requirements.capability !== descriptor.outputCapability ||
        requirements.requiredFeatures.some((feature) => !descriptor.featureTags.includes(feature))
      )
        throw new DomainError('UNSUPPORTED_FEATURE', '固定模型不支持本次生成要求');
      for (const requirement of requirements.inputRequirements ?? task.inputRequirements ?? []) {
        const role = descriptor.inputRoles.find((value) => value.role === requirement.role);
        if (
          !role ||
          requirement.artifactKinds?.some((kind) => !role.artifactKinds.includes(kind)) ||
          requirement.mimeTypes?.some((mime) => !role.mimeTypes.includes(mime))
        )
          throw new DomainError('UNSUPPORTED_INPUT_ROLE', '素材角色不属于固定模型规范');
      }
      for (const ref of task.artifactInputs) await this.ports.verifyArtifact(ref, task);
      const missing = (requirements.inputRequirements ?? task.inputRequirements ?? []).filter(
        (requirement) =>
          requirement.required &&
          !task.artifactInputs.some(
            (ref) =>
              ref.role === requirement.role &&
              (!requirement.artifactKinds?.length ||
                requirement.artifactKinds.includes(ref.kind)) &&
              (!requirement.mimeTypes?.length || requirement.mimeTypes.includes(ref.mimeType)),
          ),
      );
      if (missing.length)
        return this.persist(task, attempt, {
          kind: 'NEEDS_INPUT',
          requirements: missing,
          reason: '需要符合模型角色的可信素材',
        });
      if (!attempt.generationJobId) {
        const input: Omit<GenerationTask, 'id' | 'createdAt'> = {
          targetTeammateId: task.targetTeammateId,
          capability: descriptor.outputCapability,
          requiredFeatures: requirements.requiredFeatures,
          prompt: requirements.prompt ?? task.publicTask,
          inputs: task.artifactInputs.map((ref) => ({ artifactId: ref.id, role: ref.role })),
          parameters: requirements.parameters,
          expectedOutput: requirements.expectedOutput,
          outputDestination: requirements.outputDestination,
          requester: {
            actorType: task.source === 'WORKFLOW' ? 'WORKFLOW' : 'TEAMMATE',
            actorId: task.source === 'WORKFLOW' ? task.workflowRunId : task.requesterTeammateId,
          },
          missionId: task.missionId,
          runId: task.runId,
          workflowRunId: task.workflowRunId,
          workflowStepRunId: task.workflowStepRunId,
          executionAttemptId: attempt.id,
          collaborationRequestId: task.collaborationRequestId,
        };
        const created = await this.generation.create(input);
        attempt = this.repository.getAttempt(attempt.id)!;
        if (!attempt.generationJobId)
          attempt = this.repository.bindGenerationJob(attempt.id, created.id);
        if (attempt.generationJobId !== created.id)
          throw new DomainError('PERSISTENCE_INVALID', '生成执行关联不一致');
        this.options.crash?.('JOB_BOUND', task);
      }
      if (attempt.state === 'PREPARED') {
        this.repository.transaction(() => {
          attempt = this.repository.transitionAttempt(attempt.id, 'PREPARED', 'RUNNING');
          this.ports.event(task, attempt, 'collaboration.started', {
            generationJobId: attempt.generationJobId,
          });
        });
      }
      const job = await this.generation.advance(attempt.generationJobId!);
      if (job.state === 'UNKNOWN') {
        attempt = this.repository.transitionAttempt(attempt.id, attempt.state, 'UNKNOWN', {
          errorCode: job.errorCode,
        });
        this.ports.event(task, attempt, 'collaboration.execution_uncertain', {
          generationJobId: job.id,
        });
        return { kind: 'WAITING', task, attempt };
      }
      if (job.state === 'FAILED' || job.state === 'CANCELLED')
        return this.persist(task, attempt, {
          kind:
            job.state === 'FAILED' && this.ports.provenRetryableRejection(job)
              ? 'FAILED_RETRYABLE'
              : 'FAILED_TERMINAL',
          errorCode: job.errorCode ?? 'GENERATION_FAILED',
          reason: '生成服务未交付可验证结果',
        });
      if (job.state !== 'COMPLETED') return { kind: 'WAITING', task, attempt };
      const refs = this.generation
        .detail(job.id)
        .artifacts.map(({ id, kind, mimeType, contentHash, sizeBytes }) => ({
          id,
          kind,
          mimeType,
          contentHash,
          sizeBytes,
        }));
      if (!refs.length) throw new DomainError('OUTPUT_MISSING', '生成任务缺少安全提交的结果');
      for (const ref of refs) await this.ports.verifyArtifact(ref, task);
      this.repository.transaction(() => {
        for (const ref of refs)
          this.repository.registerArtifactRef(task.missionId, task.runId, ref, {
            type: 'GENERATION',
            id: ref.id,
          });
      });
      this.options.crash?.('GENERATION_COMPLETED', task);
      return this.persist(task, attempt, {
        kind: 'RESULT',
        publicResult: '生成结果已安全保存，尚不代表已通过审查',
        artifactRefs: refs,
      });
    } catch (error) {
      if (error instanceof G3ExecutionCrash || error instanceof GenerationCrash) throw error;
      const latest = this.repository.getAttempt(attempt.id)!;
      if (error instanceof DomainError && error.code === 'APPROVAL_REQUIRED') {
        const waiting =
          latest.state === 'WAITING_USER'
            ? latest
            : this.repository.transitionAttempt(latest.id, latest.state, 'WAITING_USER');
        return { kind: 'WAITING', task, attempt: waiting };
      }
      const bound = latest.generationJobId
        ? this.generationFacts.getJob(latest.generationJobId)
        : null;
      if (bound && !['FAILED', 'CANCELLED', 'COMPLETED'].includes(bound.state))
        return { kind: 'WAITING', task, attempt: latest };
      return this.persist(task, latest, {
        kind: 'FAILED_TERMINAL',
        errorCode: safeCode(error),
        reason: '生成准备或交付校验失败',
      });
    }
  }

  private async persist(
    task: ExecutionTask,
    attempt: ExecutionAttempt,
    outcome: ParticipantOutcome,
  ): Promise<G3ExecutionProgress> {
    const checked = parseParticipantOutcome(outcome);
    if (checked.kind === 'RESULT')
      for (const ref of checked.artifactRefs) await this.ports.verifyArtifact(ref, task);
    const next: ExecutionAttemptState =
      checked.kind === 'RESULT'
        ? 'COMPLETED'
        : checked.kind === 'NEEDS_INPUT'
          ? 'WAITING_INPUT'
          : checked.kind === 'NEEDS_CAPABILITY'
            ? 'WAITING_CAPABILITY'
            : 'FAILED';
    let fact!: ParticipantOutcomeFact;
    this.repository.transaction(() => {
      // PREPARED -> RUNNING before a completed result, even for an already accepted Human delivery.
      if (attempt.state === 'PREPARED' && next === 'COMPLETED')
        attempt = this.repository.transitionAttempt(attempt.id, 'PREPARED', 'RUNNING');
      if (attempt.state !== next)
        attempt = this.repository.transitionAttempt(
          attempt.id,
          attempt.state,
          next,
          checked.kind === 'FAILED_RETRYABLE' || checked.kind === 'FAILED_TERMINAL'
            ? { errorCode: checked.errorCode }
            : {},
        );
      fact = this.repository.appendOutcome(attempt.id, checked);
      this.ports.event(task, attempt, 'collaboration.outcome_recorded', {
        outcomeId: fact.id,
        kind: checked.kind,
        artifactIds: checked.kind === 'RESULT' ? checked.artifactRefs.map((ref) => ref.id) : [],
      });
    });
    this.options.crash?.('OUTCOME_CREATED', task);
    return { kind: 'OUTCOME', task, attempt, fact };
  }
  private requireTask(id: string): ExecutionTask {
    const task = this.repository.getTask(id);
    if (!task) throw new DomainError('NOT_FOUND', '执行任务不存在');
    return task;
  }
  private rootTask(task: ExecutionTask): ExecutionTask {
    let root = task;
    const seen = new Set<string>();
    while (root.parentTaskId) {
      if (seen.has(root.id)) throw new DomainError('PERSISTENCE_INVALID', '执行 lineage 形成循环');
      seen.add(root.id);
      root = this.requireTask(root.parentTaskId);
    }
    return root;
  }
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function safeCode(error: unknown): string {
  return error instanceof DomainError && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : 'EXECUTION_FAILED';
}
