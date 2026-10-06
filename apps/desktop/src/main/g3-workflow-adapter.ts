import { DomainError } from '@cultivation/shared';
import type {
  WorkflowMissionPort,
  WorkflowMissionSnapshot,
  WorkflowRepository,
  WorkflowStepExecutionContext,
} from '@cultivation/application';
import type {
  Mission,
  RoutingTaskContext,
  StepOperationReceipt,
  WorkflowDetail,
  WorkflowStepDefinition,
  WorkflowStepRun,
} from '@cultivation/domain';
import { validateWorkflowVersion } from '@cultivation/domain';

/** Main-owned bridge into the existing Gate3 Mission and G1/G2 Generation services. */
export interface GenerationWorkflowExecutionPort {
  prepare(
    definition: WorkflowStepDefinition,
    detail: WorkflowDetail,
    step: WorkflowStepRun,
  ): Promise<{ reason?: string } | { routing?: Partial<RoutingTaskContext> }>;
  /** Called inside RoutingMissionService's transaction with the Workflow step binding. */
  bind(
    mission: Mission,
    detail: WorkflowDetail,
    step: WorkflowStepRun,
    definition: WorkflowStepDefinition,
  ): void;
  start(missionId: string): Promise<void>;
  snapshot(missionId: string): WorkflowMissionSnapshot;
  collectOutputs(
    missionId: string,
    workspaceRoot: string | null,
    definition?: WorkflowStepDefinition,
    context?: WorkflowStepExecutionContext,
  ): Promise<WorkflowMissionSnapshot>;
  handles(missionId: string): boolean;
}

type WorkflowContext = RoutingTaskContext & {
  requiredExecutionProtocol?: 'LANGUAGE' | 'GENERATION';
};
type BoundGenerationStep = {
  detail: WorkflowDetail;
  step: WorkflowStepRun;
  definition: WorkflowStepDefinition;
};

/**
 * Decorates W1's existing Mission port. LANGUAGE and legacy frozen definitions still flow
 * through the existing adapter; only a validated frozen GENERATION step is dispatched here.
 */
export class GenerationWorkflowMissionAdapter implements WorkflowMissionPort {
  constructor(
    private readonly delegate: WorkflowMissionPort,
    private readonly workflows: Pick<WorkflowRepository, 'detail' | 'findStepByMissionId'>,
    private readonly generation: GenerationWorkflowExecutionPort,
  ) {}

  private frozenStep(detail: WorkflowDetail, step: WorkflowStepRun): WorkflowStepDefinition | null {
    if (step.workflowRunId !== detail.run.id) return null;
    return detail.version.steps.find((item) => item.id === step.stepId) ?? null;
  }

  private generationStep(
    definition: WorkflowStepDefinition,
    detail: WorkflowDetail,
    step: WorkflowStepRun,
  ): 'GENERATION' | 'LANGUAGE' | 'INVALID' {
    try {
      validateWorkflowVersion(detail.version);
    } catch {
      return 'INVALID';
    }
    const frozen = this.frozenStep(detail, step);
    if (!frozen || frozen.id !== definition.id) return 'INVALID';
    const protocol = (frozen.routing as WorkflowContext).requiredExecutionProtocol;
    const hasGenerationDeclaration = frozen.executionRequirements?.generation !== undefined;
    if (protocol === 'GENERATION' && hasGenerationDeclaration) return 'GENERATION';
    if ((protocol === undefined || protocol === 'LANGUAGE') && !hasGenerationDeclaration)
      return 'LANGUAGE';
    return 'INVALID';
  }

  private boundGenerationStep(missionId: string): BoundGenerationStep | null {
    const step = this.workflows.findStepByMissionId(missionId);
    const detail = step ? this.workflows.detail(step.workflowRunId) : null;
    if (!step || !detail) return null;
    const definition = this.frozenStep(detail, step);
    if (!definition) return null;
    const mode = this.generationStep(definition, detail, step);
    if (mode === 'GENERATION') return { detail, step, definition };
    if (mode === 'INVALID')
      throw new DomainError('WORKFLOW_GENERATION_INVALID', '冻结的 Generation Step 声明无效');
    return null;
  }

  private requireGenerationDispatcher(missionId: string): void {
    if (!this.generation.handles(missionId))
      throw new DomainError(
        'GENERATION_DISPATCH_NOT_ATTACHED',
        'Workflow Generation Mission 尚未绑定可恢复的 Generation 执行记录',
      );
  }

  async prepareExecution(
    definition: WorkflowStepDefinition,
    detail: WorkflowDetail,
    step: WorkflowStepRun,
  ): Promise<{ reason: string } | { routing?: Partial<RoutingTaskContext> }> {
    const mode = this.generationStep(definition, detail, step);
    if (mode === 'INVALID') return { reason: 'WORKFLOW_GENERATION_INVALID' };
    if (mode === 'GENERATION') {
      const frozen = this.frozenStep(detail, step)!;
      const prepared = await this.generation.prepare(frozen, detail, step);
      if ('reason' in prepared && typeof prepared.reason === 'string')
        return { reason: prepared.reason };
      const routing = 'routing' in prepared ? prepared.routing : undefined;
      if (routing?.executionConstraint !== undefined && routing.executionConstraint !== 'SOLO')
        return { reason: 'GENERATION_SOLO_REQUIRED' };
      return { routing: { ...routing, executionConstraint: 'SOLO' } };
    }

    const prepared = await this.delegate.prepareExecution?.(definition, detail, step);
    if (prepared && 'reason' in prepared) return prepared;
    if (definition.type === 'REVIEW' && this.hasValidatedMediaReference(detail, step))
      return {
        routing: { ...prepared?.routing, executionConstraint: 'HUMAN_BRIDGE' },
      };
    return prepared ?? {};
  }

  private hasValidatedMediaReference(detail: WorkflowDetail, step: WorkflowStepRun): boolean {
    const inputIds = new Set(
      detail.bindings
        .filter((binding) => binding.stepRunId === step.id && binding.role === 'INPUT')
        .map((binding) => binding.artifactId),
    );
    return detail.artifacts.some((artifact) => {
      if (
        !inputIds.has(artifact.id) ||
        artifact.kind !== 'JSON' ||
        typeof artifact.metadata.generationArtifactId !== 'string' ||
        typeof artifact.metadata.generationJobId !== 'string' ||
        typeof artifact.metadata.generationTaskId !== 'string' ||
        typeof artifact.metadata.workflowStepRunId !== 'string' ||
        typeof artifact.metadata.evidenceEventId !== 'string' ||
        typeof artifact.metadata.contentHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(artifact.metadata.contentHash) ||
        typeof artifact.metadata.mimeType !== 'string' ||
        typeof artifact.metadata.kind !== 'string' ||
        typeof artifact.metadata.sizeBytes !== 'number' ||
        !Number.isSafeInteger(artifact.metadata.sizeBytes) ||
        !detail.validations.some(
          (receipt) =>
            receipt.artifactId === artifact.id &&
            receipt.valid &&
            receipt.contentHash === artifact.contentHash,
        )
      )
        return false;
      try {
        const reference = JSON.parse(artifact.content) as {
          type?: unknown;
          artifact?: {
            id?: unknown;
            kind?: unknown;
            mimeType?: unknown;
            contentHash?: unknown;
            sizeBytes?: unknown;
          };
        };
        return (
          reference.type === 'GENERATION_ARTIFACT_REF' &&
          reference.artifact?.id === artifact.metadata.generationArtifactId &&
          reference.artifact?.kind === artifact.metadata.kind &&
          reference.artifact?.mimeType === artifact.metadata.mimeType &&
          reference.artifact?.contentHash === artifact.metadata.contentHash &&
          reference.artifact?.sizeBytes === artifact.metadata.sizeBytes &&
          /^(image|video|audio)\//.test(String(reference.artifact?.mimeType))
        );
      } catch {
        return false;
      }
    });
  }

  async create(
    input: Parameters<WorkflowMissionPort['create']>[0],
    bind: Parameters<WorkflowMissionPort['create']>[1],
  ): Promise<Awaited<ReturnType<WorkflowMissionPort['create']>>> {
    const context = input.context as WorkflowContext;
    const isWorkflowContext = context.executionContext?.origin === 'WORKFLOW';
    const detail =
      isWorkflowContext && context.executionContext?.executionId
        ? this.workflows.detail(context.executionContext.executionId)
        : null;
    const step =
      detail && context.executionContext?.stepId
        ? detail.steps.find((item) => item.id === context.executionContext!.stepId)
        : null;
    const definition = detail && step ? this.frozenStep(detail, step) : null;
    let mode: 'GENERATION' | 'LANGUAGE' | 'INVALID' = 'LANGUAGE';
    if (
      context.requiredExecutionProtocol === 'GENERATION' ||
      definition?.executionRequirements?.generation ||
      (definition?.routing as WorkflowContext | undefined)?.requiredExecutionProtocol ===
        'GENERATION' ||
      (context.requiredExecutionProtocol !== undefined &&
        context.requiredExecutionProtocol !== 'LANGUAGE')
    ) {
      if (!detail || !step || !definition) mode = 'INVALID';
      else mode = this.generationStep(definition, detail, step);
    }
    if ((context.requiredExecutionProtocol ?? 'LANGUAGE') !== mode) mode = 'INVALID';
    if (mode === 'INVALID')
      return { status: 'USER_ACTION_REQUIRED', reason: 'WORKFLOW_GENERATION_INVALID' };

    return this.delegate.create(input, (mission) => {
      if (mode === 'GENERATION') {
        if (mission.mode !== 'SOLO')
          throw new DomainError(
            'GENERATION_SOLO_REQUIRED',
            'Generation Workflow 必须绑定 SOLO Mission',
          );
        bind(mission);
        this.generation.bind(mission, detail!, step!, definition!);
      } else {
        bind(mission);
      }
    });
  }

  snapshot(missionId: string): WorkflowMissionSnapshot {
    const generated = this.boundGenerationStep(missionId);
    if (!generated) return this.delegate.snapshot(missionId);
    this.requireGenerationDispatcher(missionId);
    return this.generation.snapshot(missionId);
  }

  hasAcceptedArtifactProvenance = (
    artifact: Parameters<NonNullable<WorkflowMissionPort['hasAcceptedArtifactProvenance']>>[0],
  ): boolean => this.delegate.hasAcceptedArtifactProvenance?.(artifact) ?? false;

  async collectOutputs(
    missionId: string,
    workspaceRoot: string | null,
    definition?: WorkflowStepDefinition,
    context?: WorkflowStepExecutionContext,
  ): Promise<WorkflowMissionSnapshot> {
    const generated = this.boundGenerationStep(missionId);
    if (generated) {
      this.requireGenerationDispatcher(missionId);
      return this.generation.collectOutputs(
        missionId,
        workspaceRoot,
        definition ?? generated.definition,
        context ?? { workflowRunId: generated.detail.run.id, stepRunId: generated.step.id },
      );
    }
    return (
      (await this.delegate.collectOutputs?.(missionId, workspaceRoot, definition, context)) ??
      this.delegate.snapshot(missionId)
    );
  }

  async captureOperation(
    ...args: Parameters<NonNullable<WorkflowMissionPort['captureOperation']>>
  ): Promise<StepOperationReceipt['manifest']> {
    if (!this.delegate.captureOperation)
      throw new DomainError('WORKFLOW_OPERATION_UNAVAILABLE', 'Workflow 操作检查不可用');
    return this.delegate.captureOperation(...args);
  }

  async verifyOperation(
    ...args: Parameters<NonNullable<WorkflowMissionPort['verifyOperation']>>
  ): Promise<
    NonNullable<Awaited<ReturnType<NonNullable<WorkflowMissionPort['verifyOperation']>>>>
  > {
    if (!this.delegate.verifyOperation)
      throw new DomainError('WORKFLOW_OPERATION_UNAVAILABLE', 'Workflow 操作检查不可用');
    return this.delegate.verifyOperation(...args);
  }

  workspaceIdentity(): string | null {
    return this.delegate.workspaceIdentity?.() ?? null;
  }

  async start(missionId: string): Promise<void> {
    if (this.boundGenerationStep(missionId)) {
      this.requireGenerationDispatcher(missionId);
      await this.generation.start(missionId);
      return;
    }
    await this.delegate.start(missionId);
  }

  async retry(missionId: string): Promise<void> {
    if (this.boundGenerationStep(missionId)) {
      this.requireGenerationDispatcher(missionId);
      await this.generation.start(missionId);
      return;
    }
    await this.delegate.retry(missionId);
  }

  cancel(missionId: string): void {
    this.delegate.cancel(missionId);
  }
}
