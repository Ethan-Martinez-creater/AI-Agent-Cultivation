import { createHash, randomUUID } from 'node:crypto';
import type { WorkflowDetail, WorkflowStepRun } from '@cultivation/domain';
import type {
  ToolCall,
  ToolContext,
  ToolExecutionGuard,
} from '@cultivation/application/tool-runtime';
import type { ToolDescriptor } from '@cultivation/domain';
import type {
  WorkspaceMutationIntent,
  W22WorkspaceMutationRepository,
} from '@cultivation/persistence';
import { DomainError } from '@cultivation/shared';
import { FileWorkspace, FileWorkspaceError } from './file-workspace.js';

export interface SoftwareToolCommand {
  id: string;
  command: string;
  acceptanceCriteriaIds: string[];
}

export interface SoftwareToolScope {
  allowedToolIds: string[];
  allowedCommands: SoftwareToolCommand[];
  acceptanceIds: string[];
  allowedPathPrefixes: string[];
  planFiles: string[];
}

export interface WorkflowToolLookup {
  findStepByMissionId(missionId: string): WorkflowStepRun | null;
  bindMissionRun(step: WorkflowStepRun, context: ToolContext): WorkflowStepRun | null;
  detail(workflowRunId: string): WorkflowDetail | null;
}

interface OperationIdentity {
  id: string;
  attempt: number;
  effectType: string;
  state: string;
}

interface MutationRepository extends W22WorkspaceMutationRepository {
  getOperation(workflowRunId: string, stepRunId: string): OperationIdentity | null;
}

interface WorkflowToolToken {
  kind: 'MUTATION' | 'VERIFICATION' | 'NOOP';
  mutation?: WorkspaceMutationIntent;
  workflowRunId?: string;
  stepRunId?: string;
  attempt?: number;
  missionId?: string;
  missionRunId?: string;
  actorId?: string;
  toolCallId?: string;
  toolId?: string;
  command?: string;
  commandId?: string;
  criterionIds?: string[];
  createdAt?: string;
}

type ScopeResolver = (detail: WorkflowDetail, step: WorkflowStepRun) => SoftwareToolScope | null;

const SOFTWARE_POLICY = 'software-integrity-v1';
const MUTATION_MAX_BYTES = 10_000_000;
const MAX_CRITERIA = 32;

/** Main-only gate for software Workflow tools. The normal PermissionEngine remains authoritative. */
export class WorkflowToolGuard implements ToolExecutionGuard {
  constructor(
    private readonly workflows: WorkflowToolLookup,
    private readonly journal: MutationRepository,
    private readonly workspaceRoot: () => string | null,
    private readonly resolveSoftwareScope: ScopeResolver = () => null,
  ) {}

  async before(
    call: ToolCall,
    context: ToolContext,
    descriptor: ToolDescriptor & { capability: string },
    input: Record<string, unknown>,
    resource: string,
  ): Promise<WorkflowToolToken> {
    const pendingStep = this.workflows.findStepByMissionId(context.missionId);
    if (!pendingStep) return { kind: 'NOOP' };
    const pendingDetail = this.workflows.detail(pendingStep.workflowRunId);
    if (
      pendingDetail?.version.definition.source !== 'BUILTIN' ||
      pendingDetail.version.validationPolicy !== SOFTWARE_POLICY
    )
      return { kind: 'NOOP' };
    const boundStep = this.workflows.bindMissionRun(pendingStep, context);
    if (!boundStep)
      throw new DomainError(
        'WORKFLOW_TOOL_RUN_BINDING_INVALID',
        'Tool call does not belong to the active Workflow MissionRun',
      );
    const detail = this.workflows.detail(boundStep.workflowRunId);
    const step = detail?.steps.find((item) => item.id === boundStep.id);
    if (!detail || !step || detail.version.definition.source !== 'BUILTIN') return { kind: 'NOOP' };
    if (detail.version.validationPolicy !== SOFTWARE_POLICY) return { kind: 'NOOP' };
    if (
      step.missionId !== context.missionId ||
      step.missionRunId !== context.runId ||
      !['RUNNING', 'WAITING'].includes(step.state)
    )
      throw new DomainError(
        'WORKFLOW_TOOL_SCOPE_DENIED',
        'Software Workflow Step binding is invalid',
      );

    const scope = this.resolveSoftwareScope(detail, step);
    if (
      !scope ||
      !Array.isArray(scope.allowedToolIds) ||
      !scope.allowedToolIds.includes(call.toolId)
    )
      throw new DomainError(
        'WORKFLOW_TOOL_SCOPE_DENIED',
        'Tool is outside the confirmed software scope',
      );

    if (descriptor.source === 'MCP') {
      if (step.stepId !== 'S06' || !scope.allowedToolIds.includes(call.toolId))
        throw new DomainError(
          'WORKFLOW_MCP_MUTATION_UNSUPPORTED',
          'This MCP action is not permitted for the software Step',
        );
      return this.prepareVerification(call, context, input, scope, detail, step, descriptor);
    }

    if (!['NONE', 'LOCAL_WRITE'].includes(descriptor.sideEffect))
      throw new DomainError(
        'WORKFLOW_TOOL_SCOPE_DENIED',
        'Tool side effects are not allowed in this Step',
      );
    if (descriptor.sideEffect === 'LOCAL_WRITE' && call.toolId !== 'file.writeText')
      throw new DomainError(
        'WORKFLOW_MUTATION_SCOPE_DENIED',
        'Only journaled text-file writes are supported',
      );
    if (call.toolId !== 'file.writeText') return { kind: 'NOOP' };
    if (
      !('path' in input) ||
      typeof input.path !== 'string' ||
      typeof input.content !== 'string' ||
      descriptor.capability !== 'FILE_WRITE'
    )
      throw new DomainError('WORKFLOW_MUTATION_SCOPE_DENIED', 'Write is not allowed in this Step');
    const versionStep = detail.version.steps.find((candidate) => candidate.id === step.stepId);
    if (
      versionStep?.effectType !== 'WORKSPACE_MUTATION' ||
      (versionStep as (typeof detail.version.steps)[number] & { effectPathMode?: string })
        .effectPathMode !== 'DYNAMIC'
    )
      throw new DomainError(
        'WORKFLOW_MUTATION_SCOPE_DENIED',
        'This Step has no dynamic mutation manifest',
      );

    const relativePath = normalizeRelative(input.path);
    if (
      !relativePath ||
      !scope.planFiles.includes(relativePath) ||
      !scope.allowedPathPrefixes.some((prefix) => isWithin(relativePath, prefix))
    )
      throw new DomainError(
        'WORKFLOW_MUTATION_SCOPE_DENIED',
        'Path is outside the confirmed plan scope',
      );
    const root = this.workspaceRoot();
    if (!root || step.workspaceRoot !== root)
      throw new DomainError(
        'WORKFLOW_WORKSPACE_CHANGED',
        'Restore the confirmed Workspace before editing',
      );
    const workspace = await FileWorkspace.open(root);
    const workspaceTag = rootHash(workspace.getRoot()).slice(0, 16);
    const expectedResource = `file:${workspaceTag}:${relativePath.toLowerCase()}`;
    if (resource !== expectedResource)
      throw new DomainError(
        'WORKFLOW_PERMISSION_RESOURCE_MISMATCH',
        'File permission target changed',
      );

    const operation = this.journal.getOperation(detail.run.id, step.id);
    if (
      !operation ||
      operation.state !== 'PREPARED' ||
      operation.effectType !== 'WORKSPACE_MUTATION' ||
      operation.attempt !== step.attempt
    )
      throw new DomainError(
        'WORKFLOW_OPERATION_INVALID',
        'Prepared Workspace operation is unavailable',
      );

    let beforeHash: string | null = null;
    try {
      beforeHash =
        (await workspace.inspectArtifact(relativePath, MUTATION_MAX_BYTES, true)).contentHash ??
        null;
    } catch (error) {
      if (!(error instanceof FileWorkspaceError) || error.code !== 'FILE_WORKSPACE_PATH_NOT_FOUND')
        throw error;
    }
    const now = new Date().toISOString();
    const prepared = this.journal.prepareMutation({
      id: randomUUID(),
      workflowRunId: detail.run.id,
      stepRunId: step.id,
      operationReceiptId: operation.id,
      attempt: step.attempt,
      missionId: context.missionId,
      missionRunId: context.runId,
      teammateId: context.teammateId,
      toolCallId: call.id,
      toolId: 'file.writeText',
      permissionResource: resource,
      workspaceTag,
      relativePath,
      beforeHash,
      expectedAfterHash: sha256(Buffer.from(input.content, 'utf8')),
      observedAfterHash: null,
      state: 'PREPARED',
      resultCode: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!prepared.created)
      throw new DomainError(
        'WORKFLOW_MUTATION_REPLAY_BLOCKED',
        'This Tool Call has a prior mutation intent',
      );
    return { kind: 'MUTATION', mutation: prepared.intent };
  }

  async after(
    tokenValue: unknown,
    context: ToolContext,
    outcome: { ok: boolean; code: string; content: string },
  ): Promise<void> {
    if (!tokenValue || typeof tokenValue !== 'object') return;
    const token = tokenValue as WorkflowToolToken;
    if (token.kind === 'NOOP') return;
    if (token.kind === 'MUTATION' && token.mutation) {
      const intent = token.mutation;
      const root = this.workspaceRoot();
      let actualHash: string | null = null;
      try {
        if (!root || rootHash(root).slice(0, 16) !== intent.workspaceTag)
          throw new DomainError(
            'WORKFLOW_WORKSPACE_CHANGED',
            'Workspace identity changed during write',
          );
        const workspace = await FileWorkspace.open(root);
        actualHash =
          (await workspace.inspectArtifact(intent.relativePath, MUTATION_MAX_BYTES, true))
            .contentHash ?? null;
      } catch (error) {
        if (
          !(error instanceof FileWorkspaceError) ||
          error.code !== 'FILE_WORKSPACE_PATH_NOT_FOUND'
        )
          actualHash = null;
      }
      const applied = outcome.ok && actualHash === intent.expectedAfterHash;
      const next: WorkspaceMutationIntent = {
        ...intent,
        state: applied ? 'APPLIED' : 'UNKNOWN',
        observedAfterHash: actualHash,
        resultCode: outcome.code.slice(0, 128),
        updatedAt: new Date().toISOString(),
      };
      if (!this.journal.transitionMutation(next, 'PREPARED'))
        throw new DomainError(
          'WORKFLOW_MUTATION_STATE_CONFLICT',
          'Workspace mutation intent changed',
        );
      return;
    }
    if (token.kind === 'VERIFICATION') {
      if (
        !outcome.ok ||
        !token.workflowRunId ||
        !token.stepRunId ||
        !token.missionId ||
        !token.missionRunId ||
        !token.actorId ||
        !token.toolCallId ||
        !token.toolId ||
        !token.command ||
        !token.commandId ||
        !token.attempt ||
        !token.createdAt
      )
        return;
      const parsed = safeJsonRecord(outcome.content);
      const structured =
        parsed && isRecord(parsed.structuredContent) ? parsed.structuredContent : null;
      const evidence =
        structured && isRecord(structured.workflowEvidence)
          ? structured.workflowEvidence.verification
          : null;
      if (!isRecord(evidence)) return;
      const commandId = evidence.commandId;
      const command = evidence.command;
      const exitStatus = evidence.exitStatus;
      const criterionIds = evidence.acceptanceCriterionIds;
      if (
        commandId !== token.commandId ||
        command !== token.command ||
        !Number.isSafeInteger(exitStatus) ||
        (exitStatus as number) < -1 ||
        (exitStatus as number) > 255 ||
        !Array.isArray(criterionIds) ||
        criterionIds.length < 1 ||
        criterionIds.length > MAX_CRITERIA ||
        criterionIds.some((id) => typeof id !== 'string') ||
        criterionIds.some((id) => !token.criterionIds?.includes(id))
      )
        return;
      this.journal.appendVerificationFact({
        id: token.toolCallId,
        workflowRunId: token.workflowRunId,
        stepRunId: token.stepRunId,
        attempt: token.attempt,
        missionId: token.missionId,
        missionRunId: token.missionRunId,
        actorId: token.actorId,
        toolCallId: token.toolCallId,
        commandId: token.commandId,
        toolId: token.toolId,
        command: token.command,
        commandHash: sha256(Buffer.from(token.command, 'utf8')),
        exitStatus: exitStatus as number,
        criterionIds: [...new Set(criterionIds as string[])],
        outputHash: sha256(Buffer.from(outcome.content, 'utf8')),
        createdAt: token.createdAt,
      });
      void context;
    }
  }

  private prepareVerification(
    call: ToolCall,
    context: ToolContext,
    input: Record<string, unknown>,
    scope: SoftwareToolScope,
    detail: WorkflowDetail,
    step: WorkflowStepRun,
    descriptor: ToolDescriptor & { capability: string },
  ): WorkflowToolToken {
    if (step.stepId !== 'S06' || descriptor.sideEffect !== 'PROCESS_EXECUTION')
      throw new DomainError(
        'WORKFLOW_VERIFICATION_SCOPE_DENIED',
        'MCP execution is limited to verification',
      );
    if (
      typeof input.commandId !== 'string' ||
      typeof input.command !== 'string' ||
      !Array.isArray(input.acceptanceCriterionIds) ||
      input.acceptanceCriterionIds.length < 1 ||
      input.acceptanceCriterionIds.length > MAX_CRITERIA
    )
      throw new DomainError(
        'WORKFLOW_VERIFICATION_INPUT_INVALID',
        'Verification command is incomplete',
      );
    const allowed = scope.allowedCommands.find(
      (item) => item.id === input.commandId && item.command === input.command,
    );
    const acceptedIds =
      allowed?.acceptanceCriteriaIds.filter((id) => scope.acceptanceIds.includes(id)) ?? [];
    if (
      !allowed ||
      !scope.allowedToolIds.includes(call.toolId) ||
      input.acceptanceCriterionIds.some((id) => typeof id !== 'string' || !acceptedIds.includes(id))
    )
      throw new DomainError(
        'WORKFLOW_VERIFICATION_SCOPE_DENIED',
        'Command or criteria are outside the confirmed plan',
      );
    return {
      kind: 'VERIFICATION',
      workflowRunId: detail.run.id,
      stepRunId: step.id,
      attempt: step.attempt,
      missionId: context.missionId,
      missionRunId: context.runId,
      actorId: context.teammateId,
      toolCallId: call.id,
      toolId: call.toolId,
      command: input.command,
      commandId: input.commandId,
      criterionIds: input.acceptanceCriterionIds as string[],
      createdAt: new Date().toISOString(),
    };
  }
}

function safeJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRelative(value: string): string | null {
  if (!value || value.includes('\0')) return null;
  const path = value.replaceAll('\\', '/');
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))
  )
    return null;
  return path;
}

function isWithin(path: string, prefix: string): boolean {
  const normalized = normalizeRelative(prefix);
  if (!normalized) return false;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function rootHash(root: string): string {
  return createHash('sha256').update(root.toLowerCase(), 'utf8').digest('hex');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
