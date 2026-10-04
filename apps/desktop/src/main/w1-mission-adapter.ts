import { DomainError } from '@cultivation/shared';
import { createHash } from 'node:crypto';
import type {
  Gate3MissionService,
  Gate3MissionStore,
} from '@cultivation/application/gate3-mission-service';
import type { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import type {
  ExternalWorkService,
  WorkflowMissionPort,
  WorkflowMissionSnapshot,
  RoutingMissionService,
  WorkflowRepository,
  WorkflowStepExecutionContext,
} from '@cultivation/application';
import { FileWorkspace } from './file-workspace.js';
import { WorkflowWorkspaceValidation } from './w2-workspace-validation.js';
import type {
  StepOperationReceipt,
  WorkflowStepDefinition,
  WorkflowDetail,
  WorkflowStepRun,
  ToolDescriptor,
  WorkflowArtifact,
} from '@cultivation/domain';
import { scopedWorkflowStep, workflowExternalDraft } from './w21-execution-contract.js';
import { inspectNewsMediaBytes, inspectNewsImageBytes } from './w21-media-validation.js';
import { softwareExternalDraft } from './w22-execution-contract.js';
import type { W22WorkspaceMutationRepository } from '@cultivation/persistence';
import { latestSoftwareOutput } from './w22-validation-policy.js';
import {
  effectiveResearchStep,
  isResearchWorkflow,
} from '../../../../packages/application/src/research-execution-policy.js';
import { researchExternalDraft } from './w23-execution-contract.js';

/** Retain source/event provenance without exceeding the existing scalar metadata limits. */
export function boundedResearchMetadata(
  references: Record<string, unknown>[],
): Record<string, string> {
  const chunks: Record<string, unknown>[][] = [[]];
  for (const reference of references) {
    let chunk = chunks.at(-1)!;
    if (JSON.stringify([...chunk, reference]).length > 1900) {
      chunk = [];
      chunks.push(chunk);
    }
    chunk.push(reference);
    if (JSON.stringify(chunk).length > 1900 || chunks.length > 3)
      throw new DomainError('WORKFLOW_CONTEXT_LIMIT', '研究来源证据超出本版本元数据上限');
  }
  const result = Object.fromEntries(
    chunks.map((chunk, index) => [
      index === 0 ? 'researchSources' : `researchSources${index + 1}`,
      JSON.stringify(chunk),
    ]),
  );
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 7000)
    throw new DomainError('WORKFLOW_CONTEXT_LIMIT', '研究来源证据超出本版本元数据上限');
  return result;
}

/** Shares R4/Mission authority; it has no ModelGateway, ToolRuntime or permission shortcuts. */
export class WorkflowMissionAdapter implements WorkflowMissionPort {
  constructor(
    private readonly routing: RoutingMissionService,
    private readonly store: Gate3MissionStore,
    private readonly solo: Gate3MissionService,
    private readonly party: Gate5CollaborationService,
    private readonly externalWork: ExternalWorkService,
    private readonly workspaceRoot: () => string | null,
    private readonly workflows?: WorkflowRepository,
    private readonly availableTools: () => ToolDescriptor[] = () => [],
    private readonly mutationJournal?: Pick<
      W22WorkspaceMutationRepository,
      'listMutations' | 'listRunMutations'
    >,
    private readonly eligibleReviewers: (definition: WorkflowStepDefinition) => string[] = () => [],
    private readonly failedExperimentFiles: (
      workflowRunId: string,
    ) => Array<{ rawPaths: string[]; rawHashes: string[] }> = () => [],
  ) {}
  private researchAuthors(detail: WorkflowDetail, reviewed: string[]): string[] {
    const ids = new Set<string>();
    for (const prior of detail.steps.filter(
      (item) => reviewed.includes(item.stepId) && item.state === 'COMPLETED' && item.missionId,
    )) {
      for (const event of this.store.listMissionEvents(prior.missionId!))
        if (
          event.runId === prior.missionRunId &&
          event.actorId &&
          event.actorType === 'TEAMMATE' &&
          ['model.call_started', 'tool.execution_started', 'tool.result'].includes(event.eventType)
        )
          ids.add(event.actorId);
      const mission = this.store.getMission(prior.missionId!);
      if (mission) ids.add(mission.coordinatorTeammateId);
    }
    return [...ids].sort();
  }
  private effectiveStep(
    definition: WorkflowStepDefinition,
    context?: WorkflowStepExecutionContext,
  ): WorkflowStepDefinition {
    const detail = context ? this.workflows?.detail(context.workflowRunId) : null;
    const step = detail?.steps.find((item) => item.id === context?.stepRunId);
    return detail && step ? effectiveResearchStep(detail, step, definition) : definition;
  }
  async prepareExecution(
    definition: WorkflowStepDefinition,
    detail: WorkflowDetail,
    step: WorkflowStepRun,
  ) {
    if (isResearchWorkflow(detail)) {
      if (!this.workspaceRoot()) return { reason: 'WORKSPACE_REQUIRED' };
      if (definition.id === 'R08') {
        if (detail.run.inputSnapshot?.experimentMode === 'HUMAN_OR_EXTERNAL')
          return { routing: { executionConstraint: 'HUMAN_BRIDGE' as const } };
        if (
          !this.availableTools().some(
            (tool) => tool.source === 'MCP' && tool.workflowPurposes?.includes('RESEARCH'),
          )
        )
          return { reason: 'RESEARCH_EXPERIMENT_TOOL_REQUIRED' };
        return {
          routing: {
            executionConstraint: 'SOLO' as const,
            requiredCapabilities: ['GENERAL_REASONING' as const, 'TOOL_USE' as const],
          },
        };
      }
      if (
        definition.id === 'R02' &&
        !this.availableTools().some((tool) => tool.workflowPurposes?.includes('RESEARCH')) &&
        !(
          Array.isArray(detail.run.inputSnapshot?.existingSources) &&
          detail.run.inputSnapshot.existingSources.length
        )
      )
        return { routing: { executionConstraint: 'HUMAN_BRIDGE' as const } };
      const reviewSteps = definition.executionRequirements?.independentReviewOfStepIds;
      if (reviewSteps) {
        const authors = this.researchAuthors(detail, reviewSteps);
        const alternatives = this.eligibleReviewers(definition).filter(
          (id) => !authors.includes(id),
        );
        return {
          routing: {
            executionConstraint: 'SOLO' as const,
            ...(alternatives.length ? { excludedTeammateIds: authors } : {}),
          },
        };
      }
      return {};
    }
    if (detail.version.validationPolicy === 'software-integrity-v1') {
      const root = this.workspaceRoot();
      if (!root || detail.run.inputSnapshot?.workspaceRoot !== root)
        return { reason: 'WORKSPACE_REQUIRED' };
      const acceptance = latestSoftwareOutput(detail, 'software.acceptance');
      if (definition.id === 'S06' && acceptance) {
        const criteria = (
          JSON.parse(acceptance.content) as { criteria: { verificationMethod: string }[] }
        ).criteria;
        const plan = latestSoftwareOutput(detail, 'software.plan_scope');
        const requiredCommands = plan
          ? (JSON.parse(plan.content) as { commands: { required: boolean }[] }).commands.some(
              (c) => c.required,
            )
          : false;
        if (!criteria.some((item) => item.verificationMethod === 'COMMAND') && !requiredCommands)
          return { routing: { executionConstraint: 'HUMAN_BRIDGE' as const } };
      }
      const scope = detail.run.inputSnapshot?.allowedToolScope;
      if (
        definition.effectPathMode === 'DYNAMIC' &&
        (!Array.isArray(detail.run.inputSnapshot?.targetArea) ||
          !detail.run.inputSnapshot.targetArea.length)
      )
        return { reason: 'WORKSPACE_MUTATION_SCOPE_REQUIRED' };
      if (
        definition.executionRequirements?.requiredToolScope &&
        (!Array.isArray(scope) ||
          !scope.length ||
          scope.some(
            (id) => typeof id !== 'string' || !this.availableTools().some((tool) => tool.id === id),
          ))
      )
        return definition.effectType === 'WORKSPACE_MUTATION'
          ? { reason: 'WORKFLOW_MUTATION_TOOL_REQUIRED' }
          : { routing: { executionConstraint: 'HUMAN_BRIDGE' as const } };
      const reviewSteps = definition.executionRequirements?.independentReviewOfStepIds;
      if (reviewSteps) {
        const actors = new Set<string>();
        for (const prior of detail.steps.filter(
          (item) => reviewSteps.includes(item.stepId) && item.missionId,
        )) {
          const mission = this.store.getMission(prior.missionId!);
          if (mission) actors.add(mission.coordinatorTeammateId);
          for (const event of this.store.listMissionEvents(prior.missionId!))
            if (
              event.actorType === 'TEAMMATE' &&
              event.actorId &&
              ['model.call_started', 'tool.result'].includes(event.eventType)
            )
              actors.add(event.actorId);
        }
        return {
          routing: { executionConstraint: 'AUTO' as const, excludedTeammateIds: [...actors] },
        };
      }
      return definition.id === 'S06' ? { routing: { executionConstraint: 'SOLO' as const } } : {};
    }
    if (detail.version.validationPolicy !== 'news-integrity-v1') return {};
    if (!this.workspaceRoot()) return { reason: 'WORKSPACE_REQUIRED' };
    const purpose = definition.executionRequirements?.toolPurpose;
    const humanVoice =
      purpose === 'VOICEOVER' && detail.run.inputSnapshot?.narrationMode === 'HUMAN';
    if (
      purpose &&
      (humanVoice ||
        !this.availableTools().some((tool) => tool.workflowPurposes?.includes(purpose)))
    ) {
      if (
        purpose === 'ASSET_COLLECTION' &&
        workflowExternalDraft(detail, step).targetArtifacts.length > 12
      )
        return { reason: 'HUMAN_BRIDGE_TARGET_LIMIT' };
      return { routing: { executionConstraint: 'HUMAN_BRIDGE' as const } };
    }
    if (purpose === 'VOICEOVER' || purpose === 'VIDEO_ASSEMBLY')
      return {
        routing: {
          executionConstraint: 'SOLO' as const,
          requiredCapabilities: ['TOOL_USE' as const],
        },
      };
    return {};
  }
  async create(
    input: Parameters<WorkflowMissionPort['create']>[0],
    bind: Parameters<WorkflowMissionPort['create']>[1],
  ): Promise<Awaited<ReturnType<WorkflowMissionPort['create']>>> {
    const context = input.context.executionContext;
    const detail =
      context?.origin === 'WORKFLOW' && context.executionId
        ? this.workflows?.detail(context.executionId)
        : null;
    const step = detail?.steps.find((item) => item.id === context?.stepId);
    const result = await this.routing.createMission(
      {
        ...input,
        ...(detail?.version.validationPolicy === 'news-integrity-v1' && step
          ? { externalWorkDraft: () => workflowExternalDraft(detail, step) }
          : detail && isResearchWorkflow(detail) && step
            ? { externalWorkDraft: () => researchExternalDraft(detail, step) }
            : detail?.version.validationPolicy === 'software-integrity-v1' && step
              ? { externalWorkDraft: () => softwareExternalDraft(detail, step) }
              : {}),
      },
      bind,
    );
    if (
      result.status === 'CREATED' &&
      detail &&
      isResearchWorkflow(detail) &&
      step &&
      ['R06', 'R12'].includes(step.stepId)
    ) {
      const reviewed =
        detail.version.steps.find((item) => item.id === step.stepId)!.executionRequirements
          ?.independentReviewOfStepIds ?? [];
      const authors = this.researchAuthors(detail, reviewed);
      this.store.appendMissionEvent({
        id: crypto.randomUUID(),
        missionId: result.mission.id,
        runId: null,
        eventType: 'workflow.review_independence',
        actorType: 'SYSTEM',
        actorId: null,
        payloadJson: {
          stepRunId: step.id,
          reviewIndependence: !authors.includes(result.mission.coordinatorTeammateId),
          reviewerId: result.mission.coordinatorTeammateId,
          authorIds: authors,
        },
        createdAt: new Date().toISOString(),
      });
    }
    return result.status === 'CREATED'
      ? { status: result.status, mission: result.mission }
      : { status: result.status, reason: result.reason };
  }
  snapshot(id: string): WorkflowMissionSnapshot {
    const mission = this.store.getMission(id);
    if (!mission) throw new DomainError('NOT_FOUND', 'Workflow 绑定的 Mission 不存在');
    const run = this.store.listRuns(id).at(-1) ?? null;
    const events = this.store.listMissionEvents(id).filter((e) => e.runId === run?.id);
    return {
      mission,
      run,
      outputs:
        run?.status === 'COMPLETED' && run.resultText !== null
          ? [
              {
                source: 'MISSION',
                sourceId: run.id,
                actorId: mission.coordinatorTeammateId,
                kind: 'TEXT',
                content: run.resultText,
                metadata: {},
              },
            ]
          : [],
      uncertainSideEffects:
        events.some((e) =>
          ['tool.execution_started', 'tool.call_started', 'tool.proposed', 'tool.result'].includes(
            e.eventType,
          ),
        ) && run?.status !== 'COMPLETED',
    };
  }
  hasAcceptedArtifactProvenance(artifact: WorkflowArtifact): boolean {
    if (artifact.source !== 'HUMAN_BRIDGE') return false;
    const step = this.workflows?.findStepByMissionId(artifact.missionId);
    const detail = step ? this.workflows?.detail(step.workflowRunId) : null;
    if (
      !detail ||
      !['news-integrity-v1', 'software-integrity-v1', 'research-integrity-v1'].includes(
        detail.version.validationPolicy ?? '',
      )
    )
      return false;
    const spec = detail.version.steps
      .find((item) => item.id === step!.stepId)
      ?.outputs.find(
        (item) => item.key === artifact.metadata.outputKey && item.kind === artifact.kind,
      );
    if (!spec || artifact.metadata.targetArtifactId !== spec.key) return false;
    return this.externalWork
      .listExternalWorkRequests(artifact.missionId, artifact.missionRunId)
      .filter(
        (request) =>
          request.state === 'ACCEPTED' && request.assigneeTeammateId === artifact.actorId,
      )
      .some(
        (request) =>
          this.externalWork
            .getExternalWorkRequest(request.id)
            ?.artifacts.some(
              (file) =>
                file.id === artifact.sourceId &&
                file.submittedAt === request.submittedAt &&
                file.path === artifact.metadata.path &&
                file.fileName === artifact.metadata.fileName &&
                file.extension === artifact.metadata.extension &&
                file.sizeBytes === artifact.metadata.sizeBytes &&
                file.metadataJson.targetArtifactId === spec.key &&
                typeof file.metadataJson.contentHash === 'string' &&
                file.metadataJson.contentHash === artifact.metadata.contentHash,
            ) === true,
      );
  }
  workspaceIdentity(): string | null {
    return this.workspaceRoot();
  }
  captureOperation(
    definition: WorkflowStepDefinition,
    root: string | null,
    context?: WorkflowStepExecutionContext,
  ) {
    return new WorkflowWorkspaceValidation(
      this.store,
      this.workspaceRoot,
      this.mutationJournal,
    ).capture(
      scopedWorkflowStep(
        this.effectiveStep(definition, context),
        context,
        context ? (this.workflows?.detail(context.workflowRunId) ?? undefined) : undefined,
      ),
      root,
    );
  }
  verifyOperation(
    receipt: StepOperationReceipt,
    definition: WorkflowStepDefinition,
    snapshot: WorkflowMissionSnapshot,
    root: string | null,
    context?: WorkflowStepExecutionContext,
  ) {
    return new WorkflowWorkspaceValidation(
      this.store,
      this.workspaceRoot,
      this.mutationJournal,
    ).verify(
      receipt,
      scopedWorkflowStep(
        this.effectiveStep(definition, context),
        context,
        context ? (this.workflows?.detail(context.workflowRunId) ?? undefined) : undefined,
      ),
      snapshot,
      root,
      context,
    );
  }
  async collectOutputs(
    id: string,
    boundWorkspaceRoot: string | null,
    definition?: WorkflowStepDefinition,
    context?: WorkflowStepExecutionContext,
  ): Promise<WorkflowMissionSnapshot> {
    const snapshot = this.snapshot(id);
    if (!snapshot.run || snapshot.run.status !== 'COMPLETED') return snapshot;
    const researchDetailForValidation = context
      ? this.workflows?.detail(context.workflowRunId)
      : null;
    if (
      researchDetailForValidation &&
      isResearchWorkflow(researchDetailForValidation) &&
      definition?.id === 'R14'
    ) {
      const root = this.workspaceRoot();
      if (!root || root !== boundWorkspaceRoot)
        throw new DomainError('WORKFLOW_WORKSPACE_CHANGED', '请恢复实验使用的工作区');
      const workspace = await FileWorkspace.open(root);
      for (const artifact of researchDetailForValidation.artifacts.filter(
        (item) =>
          item.kind === 'FILE' &&
          ['research.raw_result', 'research.experiment_log'].includes(
            String(item.metadata.outputKey),
          ) &&
          researchDetailForValidation.steps.some(
            (producer) =>
              producer.id === item.producerStepRunId &&
              producer.stepId === 'R08' &&
              producer.state === 'COMPLETED',
          ),
      )) {
        const path = artifact.metadata.path;
        const expectedHash = artifact.metadata.contentHash;
        if (typeof path !== 'string' || typeof expectedHash !== 'string')
          throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '历史实验产物缺少文件事实');
        const inspected = await workspace.inspectArtifact(path, 4_000_000, true);
        if (inspected.contentHash !== expectedHash)
          throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '历史实验原始结果已改变');
      }
      for (const failure of this.failedExperimentFiles(researchDetailForValidation.run.id))
        for (const [index, path] of failure.rawPaths.entries()) {
          const inspected = await workspace.inspectArtifact(path, 4_000_000, true);
          if (inspected.contentHash !== failure.rawHashes[index])
            throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '历史失败实验结果已改变');
        }
    }
    if (definition?.executionRequirements?.toolPurpose === 'RESEARCH') {
      const events = this.store
        .listMissionEvents(id)
        .filter(
          (event) =>
            event.runId === snapshot.run!.id &&
            event.eventType === 'tool.result' &&
            event.payloadJson.success === true &&
            event.payloadJson.source === 'MCP' &&
            event.payloadJson.capability === 'MCP_TOOL_EXECUTE',
        );
      const references = events
        .flatMap((event) =>
          Array.isArray(event.payloadJson.researchSources)
            ? event.payloadJson.researchSources.map((source) => ({
                ...(source as Record<string, unknown>),
                evidenceEventId: event.id,
                actorId: event.actorId,
              }))
            : [],
        )
        .slice(0, 20);
      for (const output of snapshot.outputs)
        output.metadata = { ...output.metadata, ...boundedResearchMetadata(references) };
    }
    const reviewFact = this.store
      .listMissionEvents(id)
      .find((event) => event.eventType === 'workflow.review_independence');
    if (reviewFact)
      for (const output of snapshot.outputs)
        output.metadata = {
          ...output.metadata,
          reviewIndependence: reviewFact.payloadJson.reviewIndependence === true ? 1 : 0,
          reviewAuthorIds: JSON.stringify(reviewFact.payloadJson.authorIds),
        };
    const requests = this.externalWork
      .listExternalWorkRequests(id, snapshot.run.id)
      .filter((r) => r.state === 'ACCEPTED');
    for (const request of requests) {
      const mixedHandoff = this.store
        .listMissionEvents(id)
        .find(
          (event) =>
            event.runId === snapshot.run!.id &&
            event.eventType === 'workflow.verification.manual_requested' &&
            event.payloadJson.requestId === request.id &&
            event.payloadJson.stepRunId === context?.stepRunId,
        );
      if (mixedHandoff) {
        const artifact = this.externalWork
          .getExternalWorkRequest(request.id)
          ?.artifacts.find(
            (a) =>
              a.submittedAt === request.submittedAt &&
              a.metadataJson.targetArtifactId ===
                (mixedHandoff.payloadJson.boundaryId === 'research-experiment-v1'
                  ? 'research.experiment_record'
                  : 'software.tests'),
          );
        if (!artifact) throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '人工验收产物缺失');
        const root = this.workspaceRoot();
        if (!root || root !== boundWorkspaceRoot)
          throw new DomainError('WORKFLOW_WORKSPACE_CHANGED', '请恢复人工验收时使用的 Workspace');
        const inspected = await (
          await FileWorkspace.open(root)
        ).inspectArtifact(artifact.path, artifact.sizeBytes || 1, true);
        if (
          inspected.contentHash !== artifact.metadataJson.contentHash ||
          inspected.sizeBytes !== artifact.sizeBytes
        )
          throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '已验收文件被修改');
        for (const output of snapshot.outputs)
          output.metadata = {
            ...output.metadata,
            manualRequestId: request.id,
            manualArtifactId: artifact.id,
            manualContentHash: String(artifact.metadataJson.contentHash),
          };
        // The accepted file remains immutable; the Main-composed report has Mission provenance.
        continue;
      }
      const detail = this.externalWork.getExternalWorkRequest(request.id)!;
      const root = this.workspaceRoot();
      if (!root || root !== boundWorkspaceRoot)
        throw new DomainError('WORKFLOW_WORKSPACE_CHANGED', '请恢复交付时使用的 Workspace');
      const workspace = await FileWorkspace.open(root);
      for (const artifact of detail.artifacts.filter(
        (a) => a.submittedAt === request.submittedAt,
      )) {
        const inspected = await workspace.inspectArtifact(
          artifact.path,
          artifact.sizeBytes || 1,
          true,
        );
        if (
          inspected.sizeBytes !== artifact.sizeBytes ||
          inspected.fileName !== artifact.fileName ||
          inspected.extension !== artifact.extension ||
          (artifact.metadataJson.contentHash !== undefined &&
            inspected.contentHash !== artifact.metadataJson.contentHash)
        )
          throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '外部产物已改变，请重新确认');
        const target = definition?.outputs.find(
          (spec) => spec.key === artifact.metadataJson.targetArtifactId,
        );
        const structured =
          definition?.artifactPathScope === 'RUN_ATTEMPT' &&
          target &&
          ['JSON', 'TEXT'].includes(target.kind);
        let content = '';
        if (structured) {
          const bytes = await workspace.readArtifactBytes(artifact.path, target.maxSizeBytes);
          if (createHash('sha256').update(bytes).digest('hex') !== inspected.contentHash)
            throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '交付文件在校验期间改变');
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (target.kind === 'JSON') content = JSON.stringify(JSON.parse(content));
        }
        const mediaFile =
          definition?.artifactPathScope === 'RUN_ATTEMPT' &&
          ['.wav', '.mp4', '.png'].includes(artifact.extension);
        const bytes = mediaFile
          ? await workspace.readArtifactBytes(artifact.path, target?.maxSizeBytes ?? 10_000_000)
          : null;
        if (bytes && createHash('sha256').update(bytes).digest('hex') !== inspected.contentHash)
          throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '媒体文件在校验期间改变');
        const media =
          bytes && artifact.extension !== '.png'
            ? inspectNewsMediaBytes(bytes, {
                requireAudio: definition?.executionRequirements?.toolPurpose !== 'ASSET_COLLECTION',
              })
            : {};
        const image = bytes && artifact.extension === '.png' ? inspectNewsImageBytes(bytes) : {};
        const researchDetail = context ? this.workflows?.detail(context.workflowRunId) : null;
        const researchFile =
          researchDetail &&
          isResearchWorkflow(researchDetail) &&
          definition?.id === 'R08' &&
          target?.kind === 'FILE';
        if (researchFile) {
          const contentBytes = await workspace.readArtifactBytes(
            artifact.path,
            target.maxSizeBytes,
          );
          if (createHash('sha256').update(contentBytes).digest('hex') !== inspected.contentHash)
            throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '实验交付文件在检验期间改变');
          const text = new TextDecoder('utf8', { fatal: true }).decode(contentBytes);
          if (artifact.extension === '.json') JSON.parse(text);
        }
        snapshot.outputs.push({
          source: 'HUMAN_BRIDGE',
          sourceId: artifact.id,
          actorId: request.assigneeTeammateId,
          kind: structured ? target.kind : 'FILE',
          content,
          metadata: {
            path: artifact.path,
            fileName: artifact.fileName,
            extension: artifact.extension,
            sizeBytes: artifact.sizeBytes,
            targetArtifactId: String(artifact.metadataJson.targetArtifactId),
            contentHash: inspected.contentHash!,
            ...(target ? { outputKey: target.key } : {}),
            ...(researchFile
              ? { mediaType: artifact.extension === '.json' ? 'application/json' : 'text/plain' }
              : {}),
            ...(structured &&
            target.kind === 'JSON' &&
            definition.executionRequirements?.toolPurpose === 'RESEARCH'
              ? {
                  acceptedSourceReport: 1,
                  sourceReportId: artifact.id,
                  sourceReportHash: inspected.contentHash!,
                }
              : {}),
            ...media,
            ...image,
          },
        });
      }
    }
    const collected = definition
      ? await new WorkflowWorkspaceValidation(
          this.store,
          this.workspaceRoot,
          this.mutationJournal,
        ).collect(
          snapshot,
          scopedWorkflowStep(
            this.effectiveStep(definition, context),
            context,
            context ? (this.workflows?.detail(context.workflowRunId) ?? undefined) : undefined,
          ),
          boundWorkspaceRoot,
          context,
          context
            ? this.workflows?.detail(context.workflowRunId)?.version.contractManifest
            : undefined,
        )
      : snapshot;
    if (definition?.artifactPathScope === 'RUN_ATTEMPT') {
      const root = this.workspaceRoot();
      if (!root || root !== boundWorkspaceRoot)
        throw new DomainError('WORKFLOW_WORKSPACE_CHANGED', 'Workspace 已改变');
      const workspace = await FileWorkspace.open(root);
      const fileSpecs = definition.outputs.filter((spec) => spec.kind === 'FILE');
      for (const output of collected.outputs.filter(
        (item) => item.kind === 'FILE' && item.source === 'MISSION',
      )) {
        const researchDetail = context ? this.workflows?.detail(context.workflowRunId) : null;
        if (researchDetail && isResearchWorkflow(researchDetail) && definition.id === 'R08') {
          const fileKey = String(output.metadata.path).endsWith('raw-result.json')
            ? 'research.raw_result'
            : String(output.metadata.path).endsWith('experiment-log.txt')
              ? 'research.experiment_log'
              : null;
          if (fileKey) {
            const bytes = await workspace.readArtifactBytes(
              String(output.metadata.path),
              4_000_000,
            );
            if (createHash('sha256').update(bytes).digest('hex') !== output.metadata.contentHash)
              throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '实验文件在检验期间改变');
            const decoded = new TextDecoder('utf8', { fatal: true }).decode(bytes);
            if (String(output.metadata.extension) === '.json') JSON.parse(decoded);
            output.metadata = {
              ...output.metadata,
              outputKey: fileKey,
              mediaType:
                String(output.metadata.extension) === '.json' ? 'application/json' : 'text/plain',
            };
          }
        }
        if (
          fileSpecs.length === 1 &&
          scopedWorkflowStep(
            this.effectiveStep(definition, context),
            context,
            context ? (this.workflows?.detail(context.workflowRunId) ?? undefined) : undefined,
          ).effectPaths?.includes(String(output.metadata.path))
        )
          output.metadata = { ...output.metadata, outputKey: fileSpecs[0]!.key };
      }
      for (const output of collected.outputs.filter(
        (item) =>
          item.kind === 'FILE' &&
          item.source === 'MISSION' &&
          ['.mp4', '.wav'].includes(String(item.metadata.extension)),
      )) {
        const bytes = await workspace.readArtifactBytes(String(output.metadata.path), 10_000_000);
        if (createHash('sha256').update(bytes).digest('hex') !== output.metadata.contentHash)
          throw new DomainError('WORKFLOW_ARTIFACT_CHANGED', '媒体文件在校验期间改变');
        output.metadata = {
          ...output.metadata,
          ...inspectNewsMediaBytes(bytes, {
            requireAudio: definition.executionRequirements?.toolPurpose !== 'ASSET_COLLECTION',
          }),
        };
      }
    }
    return collected;
  }
  async start(id: string): Promise<void> {
    const mission = this.snapshot(id).mission;
    if (mission.mode === 'SOLO') {
      if (mission.state === 'DRAFT') this.solo.ready(id);
      await this.solo.start({ missionId: id, approvalFixture: false });
    } else {
      if (mission.state === 'DRAFT') this.party.ready(id);
      await this.party.start(id);
    }
  }
  async retry(id: string): Promise<void> {
    const mission = this.snapshot(id).mission;
    if (mission.mode === 'SOLO') await this.solo.retry({ missionId: id, approvalFixture: false });
    else await this.party.retry(id);
  }
  cancel(id: string): void {
    if (this.snapshot(id).mission.mode === 'SOLO') this.solo.cancel(id);
    else this.party.cancel(id);
  }
}
