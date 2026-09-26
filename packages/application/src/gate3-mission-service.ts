import type {
  ApprovalRequest,
  ApprovalState,
  AuditEvent,
  Mission,
  MissionEvent,
  MissionMode,
  MissionRun,
  MissionRunStatus,
  MissionState,
  PermissionCapability,
  PermissionRule,
  RiskLevel,
  RuntimeProfile,
  UsageRecord,
} from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import { transition } from '@cultivation/domain';
import type { ModelGateway, ModelUsage, ModelRequest } from './index.js';
import type { ChatPromptContext, Gate1Store } from './gate1-service.js';
import { PromptComposer } from './prompt-composer.js';
import type { PermissionEngine } from './permission-engine.js';
import { ToolRuntime, type ToolCall, type ToolDispatch, type ToolResult } from './tool-runtime.js';

/** Domain Run plus its user-visible final result. The result is never copied to an audit/event. */
export type MissionRunRecord = MissionRun & { resultText: string | null };

/** Mission-only persistence port. State changes are compare-and-transition operations. */
export interface Gate3MissionStore {
  listMissions(): Mission[];
  getMission(id: string): Mission | null;
  insertMission(mission: Mission): void;
  updateMissionDetails(mission: Mission): boolean;
  transitionMission(next: Mission, expectedState: MissionState): boolean;
  listRunningMissions(): Mission[];
  listRuns(missionId: string): MissionRunRecord[];
  getRun(id: string): MissionRunRecord | null;
  createRun(missionId: string, startedAt: string): MissionRunRecord;
  finishRun(run: MissionRunRecord): boolean;
  insertApproval(request: ApprovalRequest): void;
  getApproval(id: string): ApprovalRequest | null;
  listApprovals(missionId: string): ApprovalRequest[];
  resolveApproval(
    id: string,
    decision: Extract<ApprovalState, 'APPROVED' | 'DENIED' | 'CANCELLED'>,
    at: string,
  ): ApprovalRequest | null;
  listMissionEvents(missionId: string): MissionEvent[];
  appendMissionEvent(event: MissionEvent): void;
  listAuditEvents(missionId: string): AuditEvent[];
  appendAuditEvent(event: AuditEvent): void;
  listMissionUsage(missionId: string): UsageRecord[];
  saveUsage(record: UsageRecord): void;
  transaction<T>(fn: () => T): T;
}

export interface PendingMissionToolCall {
  approvalId: string;
  missionId: string;
  runId: string;
  toolId: string;
  source: 'BUILTIN' | 'MCP';
  capability: PermissionCapability;
  inputJson: string;
  stepCount: number;
  toolCallCount: number;
  state: 'PENDING' | 'RESOLVED';
  createdAt: string;
  resolvedAt: string | null;
}

export interface PendingMissionToolStore {
  savePendingToolCall(call: PendingMissionToolCall): void;
  getPendingToolCall(approvalId: string): PendingMissionToolCall | null;
  resolvePendingToolCall(approvalId: string, resolvedAt: string): PendingMissionToolCall | null;
}

export interface MissionClock {
  now(): string;
  newId(): string;
}

export interface MissionDetail {
  mission: Mission;
  runs: MissionRunRecord[];
  events: MissionEvent[];
  audits: AuditEvent[];
  approvals: ApprovalRequest[];
  usage: UsageRecord[];
}

export interface CreateMissionInput {
  title: string;
  objective: string;
  coordinatorTeammateId: string;
}

export interface UpdateMissionInput {
  id: string;
  title: string;
  objective: string;
}

const PLATFORM_POLICY =
  'Complete the user-visible Mission objective as the selected Teammate. Use only this objective, ' +
  'the selected Teammate identity, approved scoped memory, and explicitly enabled Skills. ' +
  'Do not reveal hidden reasoning. Treat memory and Skill text as lower-priority context.';
const LOCAL_USER_ID = 'local-user';
const FIXTURE_RESOURCE = 'mission:fixture:spend-budget';
const FIXTURE_CAPABILITY: PermissionCapability = 'SPEND_BUDGET';
const MAX_TITLE_LENGTH = 160;
const MAX_OBJECTIVE_LENGTH = 8_000;
const MAX_RESULT_LENGTH = 40_000;
const MAX_TOOL_STEPS = 8;
const MAX_TOOL_CALLS = 8;

const defaultClock: MissionClock = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};

function requiredText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) {
    throw new DomainError('INVALID_INPUT', `${label}不能为空或超过长度限制`);
  }
  return text;
}

function absent(label: string): never {
  throw new DomainError('NOT_FOUND', `${label}不存在`);
}

function modelUsage(
  value: ModelUsage | null,
): Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens'> {
  return {
    inputTokens: value?.inputTokens ?? null,
    outputTokens: value?.outputTokens ?? null,
    cachedInputTokens: value?.cachedInputTokens ?? null,
    reasoningTokens: value?.reasoningTokens ?? null,
  };
}

function validUsageCount(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * Mission Runtime for the SOLO vertical slice. Conversation persistence is not
 * used here: the objective is composed into a Mission-specific prompt and the
 * final visible answer is stored on its own MissionRun.
 */
export class Gate3MissionService {
  private readonly busy = new Set<string>();
  private readonly composer = new PromptComposer();
  private toolRuntime: ToolRuntime | null = null;
  private pendingTools: PendingMissionToolStore | null = null;

  constructor(
    private readonly store: Gate3MissionStore,
    private readonly gate1: Pick<Gate1Store, 'getTeammate' | 'getRuntimeProfile'>,
    private readonly permissions: PermissionEngine,
    private readonly gateway: ModelGateway,
    private readonly promptContext?: ChatPromptContext,
    private readonly clock: MissionClock = defaultClock,
  ) {}

  attachTools(runtime: ToolRuntime, pending: PendingMissionToolStore): void {
    this.toolRuntime = runtime;
    this.pendingTools = pending;
  }

  list(): Mission[] {
    return this.store.listMissions();
  }

  detail(id: string): MissionDetail {
    const mission = this.store.getMission(id);
    if (!mission) return absent('Mission');
    return {
      mission,
      runs: this.store.listRuns(id),
      events: this.store.listMissionEvents(id),
      audits: this.store.listAuditEvents(id),
      approvals: this.store.listApprovals(id),
      usage: this.store.listMissionUsage(id),
    };
  }

  create(input: CreateMissionInput): Mission {
    const teammate = this.gate1.getTeammate(input.coordinatorTeammateId);
    if (!teammate || teammate.status !== 'ACTIVE') absent('可用道友');
    const timestamp = this.clock.now();
    const mission: Mission = {
      id: this.clock.newId(),
      title: requiredText(input.title, 'Mission 标题', MAX_TITLE_LENGTH),
      objective: requiredText(input.objective, 'Mission 目标', MAX_OBJECTIVE_LENGTH),
      initiatorType: 'USER',
      initiatorId: LOCAL_USER_ID,
      coordinatorTeammateId: teammate.id,
      partyId: null,
      mode: 'SOLO',
      state: 'DRAFT',
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    this.store.transaction(() => {
      this.store.insertMission(mission);
      this.appendEvent(mission, null, 'mission.created', 'USER', LOCAL_USER_ID, {
        mode: mission.mode,
        state: mission.state,
        coordinatorTeammateId: teammate.id,
      });
      this.appendAudit(mission, 'mission.created', 'USER', LOCAL_USER_ID, {
        mode: mission.mode,
        state: mission.state,
        coordinatorTeammateId: teammate.id,
      });
    });
    return mission;
  }

  update(input: UpdateMissionInput): Mission {
    const previous = this.requireMission(input.id);
    if (previous.state !== 'DRAFT' && previous.state !== 'READY') {
      throw new DomainError('MISSION_INVALID_STATE', '只有 DRAFT 或 READY Mission 可以编辑');
    }
    const updated: Mission = {
      ...previous,
      title: requiredText(input.title, 'Mission 标题', MAX_TITLE_LENGTH),
      objective: requiredText(input.objective, 'Mission 目标', MAX_OBJECTIVE_LENGTH),
      updatedAt: this.clock.now(),
    };
    this.store.transaction(() => {
      if (!this.store.updateMissionDetails(updated)) {
        throw new DomainError('CONFLICT', 'Mission 已被其他操作修改');
      }
      this.appendEvent(updated, null, 'mission.updated', 'USER', LOCAL_USER_ID, {
        changedFields: ['title', 'objective'],
      });
      this.appendAudit(updated, 'mission.updated', 'USER', LOCAL_USER_ID, {
        changedFields: ['title', 'objective'],
      });
    });
    return updated;
  }

  ready(id: string): Mission {
    const mission = this.requireMission(id);
    return this.transitionAndRecord(mission, 'READY', 'USER', LOCAL_USER_ID, {
      eventType: 'mission.ready',
    });
  }

  async start(input: { missionId: string; approvalFixture: boolean }): Promise<MissionDetail> {
    const mission = this.requireMission(input.missionId);
    if (mission.state !== 'READY') {
      throw new DomainError('MISSION_INVALID_STATE', '只有 READY Mission 可以运行');
    }
    return this.startNewRun(mission, input.approvalFixture, false);
  }

  async retry(input: { missionId: string; approvalFixture: boolean }): Promise<MissionDetail> {
    let mission = this.requireMission(input.missionId);
    if (mission.state !== 'FAILED' && mission.state !== 'INTERRUPTED') {
      throw new DomainError('MISSION_INVALID_STATE', '只有 FAILED 或 INTERRUPTED Mission 可以重试');
    }
    if (this.busy.has(mission.id)) throw new DomainError('MISSION_BUSY', 'Mission 正在执行');
    const latest = this.store.listRuns(mission.id).at(-1);
    if (!latest || (latest.status !== 'FAILED' && latest.status !== 'INTERRUPTED')) {
      throw new DomainError('MISSION_INVALID_STATE', '没有可重试的失败 Run');
    }
    mission = this.transitionAndRecord(mission, 'READY', 'USER', LOCAL_USER_ID, {
      eventType: 'mission.retry_ready',
      runId: latest.id,
      attempt: latest.attempt,
    });
    return this.startNewRun(mission, input.approvalFixture, true);
  }

  pause(id: string): Mission {
    const mission = this.requireMission(id);
    if (this.busy.has(id)) throw new DomainError('MISSION_BUSY', '模型正在生成，暂时不能暂停');
    return this.transitionAndRecord(mission, 'PAUSED', 'USER', LOCAL_USER_ID, {
      eventType: 'mission.paused',
    });
  }

  async resume(id: string): Promise<MissionDetail> {
    let mission = this.requireMission(id);
    if (mission.state === 'WAITING_APPROVAL') {
      throw new DomainError('APPROVAL_PENDING', 'Mission 正在等待审批');
    }
    if (mission.state !== 'PAUSED') {
      throw new DomainError('MISSION_INVALID_STATE', '只有 PAUSED Mission 可以恢复');
    }
    const run = this.latestRun(mission.id);
    if (run.status !== 'RUNNING') {
      throw new DomainError('MISSION_INVALID_STATE', '暂停中的 Run 已结束');
    }
    mission = this.transitionAndRecord(mission, 'RUNNING', 'USER', LOCAL_USER_ID, {
      eventType: 'mission.resumed',
      runId: run.id,
      attempt: run.attempt,
    });
    await this.executeRun(mission, run);
    return this.detail(id);
  }

  cancel(id: string): Mission {
    const mission = this.requireMission(id);
    if (mission.state === 'CANCELLED') return mission;
    if (this.busy.has(id)) throw new DomainError('MISSION_BUSY', '模型正在生成，暂时不能取消');
    const timestamp = this.clock.now();
    let cancelled!: Mission;
    this.store.transaction(() => {
      const pending = this.store
        .listApprovals(mission.id)
        .filter((approval) => approval.state === 'PENDING');
      for (const approval of pending) {
        const resolved = this.store.resolveApproval(approval.id, 'CANCELLED', timestamp);
        if (!resolved) throw new DomainError('APPROVAL_ALREADY_RESOLVED', 'Approval 已被处理');
        if (this.pendingTools?.getPendingToolCall(approval.id)) {
          if (!this.pendingTools.resolvePendingToolCall(approval.id, timestamp)) {
            throw new DomainError('CONFLICT', 'Pending Tool Call 已被处理');
          }
        }
        this.appendEvent(mission, approval.runId, 'approval.cancelled', 'USER', LOCAL_USER_ID, {
          approvalId: approval.id,
          capability: approval.capability,
        });
      }
      cancelled = this.transition(mission, 'CANCELLED', timestamp);
      if (!this.store.transitionMission(cancelled, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      const activeRun = this.store.listRuns(mission.id).find((run) => run.status === 'RUNNING');
      if (activeRun) {
        this.finishRun({
          ...activeRun,
          status: 'CANCELLED',
          endedAt: timestamp,
          errorCode: 'MISSION_CANCELLED',
          errorMessage: 'Mission cancelled by user.',
        });
        this.appendEvent(cancelled, activeRun.id, 'run.cancelled', 'USER', LOCAL_USER_ID, {
          attempt: activeRun.attempt,
        });
      }
      this.appendStateEvents(mission, cancelled, 'USER', LOCAL_USER_ID, 'mission.cancelled', {
        cancelledApprovalCount: pending.length,
      });
    });
    return cancelled;
  }

  async resolveApproval(input: {
    approvalId: string;
    decision: 'APPROVED' | 'DENIED' | 'ALLOW_MISSION';
  }): Promise<MissionDetail> {
    const approval = this.store.getApproval(input.approvalId);
    if (!approval) return absent('ApprovalRequest');
    if (approval.state !== 'PENDING') {
      throw new DomainError('APPROVAL_ALREADY_RESOLVED', 'Approval 只能处理一次');
    }
    const mission = this.requireMission(approval.missionId);
    if (mission.state !== 'WAITING_APPROVAL') {
      throw new DomainError('MISSION_INVALID_STATE', 'Mission 不在等待审批状态');
    }
    const run = this.store.getRun(approval.runId);
    if (!run || run.missionId !== mission.id || run.status !== 'RUNNING') {
      throw new DomainError('MISSION_INVALID_STATE', 'Approval 对应的 Run 已结束');
    }
    const pendingTool = this.pendingTools?.getPendingToolCall(approval.id);
    if (pendingTool) {
      return this.resolveToolApproval(input, approval, mission, run, pendingTool);
    }
    if (input.decision === 'ALLOW_MISSION') {
      throw new DomainError('INVALID_INPUT', '此审批不支持 Mission 工具授权');
    }
    const fixtureDecision = input.decision;

    let nextMission = mission;
    this.store.transaction(() => {
      const resolved = this.store.resolveApproval(
        input.approvalId,
        fixtureDecision,
        this.clock.now(),
      );
      if (!resolved) throw new DomainError('APPROVAL_ALREADY_RESOLVED', 'Approval 只能处理一次');
      this.appendEvent(mission, run.id, 'approval.decided', 'USER', LOCAL_USER_ID, {
        approvalId: approval.id,
        capability: approval.capability,
        decision: input.decision,
      });
      this.appendAudit(mission, 'approval.decided', 'USER', LOCAL_USER_ID, {
        runId: run.id,
        approvalId: approval.id,
        capability: approval.capability,
        decision: input.decision,
      });
      if (input.decision === 'APPROVED') {
        nextMission = this.transition(mission, 'RUNNING');
        if (!this.store.transitionMission(nextMission, mission.state)) {
          throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
        }
        this.appendStateEvents(
          mission,
          nextMission,
          'USER',
          LOCAL_USER_ID,
          'mission.approval_resumed',
          {
            runId: run.id,
            attempt: run.attempt,
          },
        );
      } else {
        const timestamp = this.clock.now();
        nextMission = this.transition(mission, 'FAILED', timestamp);
        if (!this.store.transitionMission(nextMission, mission.state)) {
          throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
        }
        const denialResult = `Permission denied: ${approval.capability}.`;
        this.finishRun({
          ...run,
          status: 'FAILED',
          endedAt: timestamp,
          errorCode: 'PERMISSION_DENIED',
          errorMessage: denialResult,
          resultText: denialResult,
        });
        this.appendEvent(nextMission, run.id, 'runtime.permission_denied', 'SYSTEM', null, {
          approvalId: approval.id,
          capability: approval.capability,
          attempt: run.attempt,
        });
        this.appendStateEvents(mission, nextMission, 'SYSTEM', null, 'mission.failed', {
          runId: run.id,
          reason: 'PERMISSION_DENIED',
        });
      }
    });

    if (input.decision === 'APPROVED') await this.executeRun(nextMission, run);
    return this.detail(mission.id);
  }

  private async resolveToolApproval(
    input: { approvalId: string; decision: 'APPROVED' | 'DENIED' | 'ALLOW_MISSION' },
    approval: ApprovalRequest,
    mission: Mission,
    run: MissionRunRecord,
    pending: PendingMissionToolCall,
  ): Promise<MissionDetail> {
    if (!this.toolRuntime || !this.pendingTools || pending.state !== 'PENDING') {
      throw new DomainError('MISSION_INVALID_STATE', 'Tool Runtime 不可用');
    }
    if (
      pending.missionId !== mission.id ||
      pending.runId !== run.id ||
      pending.capability !== approval.capability
    ) {
      throw new DomainError('PERSISTENCE_INVALID', 'Approval 与 Tool Call 不匹配');
    }
    let stored: { callId: string; input: unknown };
    try {
      stored = JSON.parse(pending.inputJson) as { callId: string; input: unknown };
      if (typeof stored.callId !== 'string' || stored.callId.length > 128) throw new Error();
    } catch {
      throw new DomainError('PERSISTENCE_INVALID', 'Tool Call 数据无效');
    }
    const tool = this.toolRuntime.registry.get(pending.toolId);
    const resource = approval.actionPayload.resource;
    let currentResource: string | null = null;
    try {
      if (
        tool &&
        stored.input &&
        typeof stored.input === 'object' &&
        !Array.isArray(stored.input)
      ) {
        currentResource = tool.resource(stored.input as Record<string, unknown>);
      }
    } catch {
      currentResource = null;
    }
    const descriptorMatches =
      tool?.descriptor.source === pending.source &&
      tool.descriptor.capability === pending.capability &&
      currentResource === resource;
    if (
      input.decision === 'ALLOW_MISSION' &&
      (typeof resource !== 'string' || !resource || resource.length > 512)
    ) {
      throw new DomainError('PERSISTENCE_INVALID', 'Tool grant 目标无效');
    }
    const at = this.clock.now();
    const running = this.transition(mission, 'RUNNING', at);
    this.store.transaction(() => {
      if (
        !this.store.resolveApproval(
          approval.id,
          input.decision === 'DENIED' ? 'DENIED' : 'APPROVED',
          at,
        )
      ) {
        throw new DomainError('APPROVAL_ALREADY_RESOLVED', 'Approval 只能处理一次');
      }
      if (!this.pendingTools?.resolvePendingToolCall(approval.id, at)) {
        throw new DomainError('APPROVAL_ALREADY_RESOLVED', 'Tool Call 只能处理一次');
      }
      if (input.decision === 'ALLOW_MISSION' && descriptorMatches) {
        this.permissions.grantMission({
          id: this.clock.newId(),
          subjectType: 'TEAMMATE',
          subjectId: mission.coordinatorTeammateId,
          capability: pending.capability,
          resourcePattern: resource as string,
          decision: 'ALLOW',
          scope: 'MISSION',
          scopeId: mission.id,
        });
      }
      if (!this.store.transitionMission(running, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(running, run.id, 'tool.approval_decided', 'USER', LOCAL_USER_ID, {
        approvalId: approval.id,
        toolId: pending.toolId,
        source: pending.source,
        capability: pending.capability,
        decision: input.decision,
      });
      this.appendAudit(running, 'tool.approval_decided', 'USER', LOCAL_USER_ID, {
        runId: run.id,
        approvalId: approval.id,
        toolId: pending.toolId,
        source: pending.source,
        capability: pending.capability,
        decision: input.decision,
      });
      this.appendStateEvents(mission, running, 'USER', LOCAL_USER_ID, 'mission.approval_resumed', {
        runId: run.id,
        approvalId: approval.id,
      });
    });

    const call: ToolCall = { id: stored.callId, toolId: pending.toolId, input: stored.input };
    let result: ToolResult;
    if (input.decision === 'DENIED') {
      result = {
        toolCallId: call.id,
        toolId: call.toolId,
        ok: false,
        code: 'PERMISSION_DENIED',
        content: 'Permission denied by user.',
      };
      this.recordToolResult(running, run, pending, result, approval.id);
    } else if (!descriptorMatches) {
      result = {
        toolCallId: call.id,
        toolId: call.toolId,
        ok: false,
        code: 'TOOL_CHANGED',
        content: 'Tool configuration changed while approval was pending.',
      };
      this.recordToolResult(running, run, pending, result, approval.id);
    } else {
      if (this.busy.has(mission.id)) throw new DomainError('MISSION_BUSY', 'Mission 正在执行');
      this.busy.add(mission.id);
      try {
        const dispatch = await this.toolRuntime.dispatch(
          call,
          { missionId: mission.id, runId: run.id, teammateId: mission.coordinatorTeammateId },
          true,
        );
        result =
          dispatch.kind === 'RESULT'
            ? dispatch.result
            : {
                toolCallId: call.id,
                toolId: call.toolId,
                ok: false,
                code: 'PERMISSION_DENIED',
                content: 'Tool approval could not be applied.',
              };
        this.recordToolResult(running, run, pending, result, approval.id);
      } finally {
        this.busy.delete(mission.id);
      }
    }
    await this.executeRun(running, run, result, pending.stepCount, pending.toolCallCount);
    return this.detail(mission.id);
  }

  /** Startup recovery does not resume token streams or alter user approval/pause state. */
  recoverInterrupted(): Mission[] {
    const recovered: Mission[] = [];
    for (const mission of this.store.listRunningMissions()) {
      if (mission.state !== 'RUNNING') continue;
      const timestamp = this.clock.now();
      const next = this.transition(mission, 'INTERRUPTED', timestamp);
      this.store.transaction(() => {
        if (!this.store.transitionMission(next, mission.state)) {
          throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
        }
        for (const run of this.store
          .listRuns(mission.id)
          .filter((candidate) => candidate.status === 'RUNNING')) {
          this.finishRun({
            ...run,
            status: 'INTERRUPTED',
            endedAt: timestamp,
            errorCode: 'APP_RESTARTED',
            errorMessage: 'Application restarted while the Mission was running.',
          });
          this.appendEvent(next, run.id, 'run.interrupted', 'SYSTEM', null, {
            attempt: run.attempt,
            reason: 'APP_RESTARTED',
          });
        }
        this.appendStateEvents(mission, next, 'SYSTEM', null, 'mission.interrupted', {
          reason: 'APP_RESTARTED',
        });
      });
      recovered.push(next);
    }
    return recovered;
  }

  private async startNewRun(
    original: Mission,
    approvalFixture: boolean,
    retry: boolean,
  ): Promise<MissionDetail> {
    const timestamp = this.clock.now();
    let running!: Mission;
    let run!: MissionRunRecord;
    this.store.transaction(() => {
      const latest = this.store.listRuns(original.id).at(-1);
      if (latest?.status === 'RUNNING') {
        throw new DomainError('MISSION_BUSY', 'Mission 已有正在运行的 Run');
      }
      running = this.transition(original, 'RUNNING', timestamp);
      if (!this.store.transitionMission(running, original.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      run = this.store.createRun(original.id, timestamp);
      if (run.missionId !== original.id || run.status !== 'RUNNING') {
        throw new DomainError('PERSISTENCE_INVALID', 'MissionRun 创建结果无效');
      }
      this.appendStateEvents(original, running, 'SYSTEM', null, 'mission.run_started', {
        runId: run.id,
        attempt: run.attempt,
        retry,
      });
      this.appendEvent(running, run.id, 'run.started', 'SYSTEM', null, {
        attempt: run.attempt,
        retry,
      });
    });

    if (approvalFixture) {
      const decision = this.permissions.evaluate({
        subjectType: 'TEAMMATE',
        subjectId: running.coordinatorTeammateId,
        capability: FIXTURE_CAPABILITY,
        resource: FIXTURE_RESOURCE,
        teammateId: running.coordinatorTeammateId,
        missionId: running.id,
      });
      if (decision.decision === 'DENY') {
        this.denyWithoutApproval(running, run, decision.matchedRuleIds);
        return this.detail(running.id);
      }
      if (decision.decision === 'ASK') {
        this.requestApproval(running, run);
        return this.detail(running.id);
      }
    }

    await this.executeRun(running, run);
    return this.detail(running.id);
  }

  private requestApproval(mission: Mission, run: MissionRunRecord): void {
    const timestamp = this.clock.now();
    const request: ApprovalRequest = {
      id: this.clock.newId(),
      missionId: mission.id,
      runId: run.id,
      requesterTeammateId: mission.coordinatorTeammateId,
      capability: FIXTURE_CAPABILITY,
      actionType: 'FIXTURE_CAPABILITY',
      actionPayload: { resource: FIXTURE_RESOURCE },
      riskLevel: 'MEDIUM',
      state: 'PENDING',
      createdAt: timestamp,
      resolvedAt: null,
    };
    const waiting = this.transition(mission, 'WAITING_APPROVAL', timestamp);
    this.store.transaction(() => {
      this.store.insertApproval(request);
      if (!this.store.transitionMission(waiting, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(
        waiting,
        run.id,
        'approval.requested',
        'TEAMMATE',
        mission.coordinatorTeammateId,
        {
          approvalId: request.id,
          capability: request.capability,
          riskLevel: request.riskLevel,
        },
      );
      this.appendAudit(waiting, 'approval.requested', 'TEAMMATE', mission.coordinatorTeammateId, {
        runId: run.id,
        approvalId: request.id,
        capability: request.capability,
        riskLevel: request.riskLevel,
      });
      this.appendStateEvents(mission, waiting, 'SYSTEM', null, 'mission.waiting_approval', {
        runId: run.id,
        approvalId: request.id,
      });
    });
  }

  private denyWithoutApproval(
    mission: Mission,
    run: MissionRunRecord,
    matchedRuleIds: string[],
  ): void {
    const timestamp = this.clock.now();
    const failed = this.transition(mission, 'FAILED', timestamp);
    const denialResult = `Permission denied: ${FIXTURE_CAPABILITY}.`;
    this.store.transaction(() => {
      if (!this.store.transitionMission(failed, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.finishRun({
        ...run,
        status: 'FAILED',
        endedAt: timestamp,
        errorCode: 'PERMISSION_DENIED',
        errorMessage: denialResult,
        resultText: denialResult,
      });
      this.appendEvent(failed, run.id, 'runtime.permission_denied', 'SYSTEM', null, {
        capability: FIXTURE_CAPABILITY,
        matchedRuleIds: matchedRuleIds.slice(0, 20),
      });
      this.appendAudit(failed, 'runtime.permission_denied', 'SYSTEM', null, {
        runId: run.id,
        capability: FIXTURE_CAPABILITY,
        matchedRuleIds: matchedRuleIds.slice(0, 20),
      });
      this.appendStateEvents(mission, failed, 'SYSTEM', null, 'mission.failed', {
        runId: run.id,
        reason: 'PERMISSION_DENIED',
      });
    });
  }

  private async executeRun(
    mission: Mission,
    run: MissionRunRecord,
    previousToolResult?: ToolResult,
    previousStepCount = 0,
    previousToolCallCount = 0,
  ): Promise<void> {
    if (this.busy.has(mission.id)) throw new DomainError('MISSION_BUSY', 'Mission 正在执行');
    if (mission.state !== 'RUNNING' || run.status !== 'RUNNING') {
      throw new DomainError('MISSION_INVALID_STATE', '只有 RUNNING MissionRun 可以执行');
    }
    const teammate = this.gate1.getTeammate(mission.coordinatorTeammateId);
    if (!teammate || teammate.status !== 'ACTIVE') {
      this.failBeforeModel(mission, run, 'TEAMMATE_UNAVAILABLE');
      return;
    }
    const runtimeId = teammate.currentRuntimeProfileId;
    const runtime: RuntimeProfile | null = runtimeId
      ? this.gate1.getRuntimeProfile(runtimeId)
      : null;
    if (!runtime) {
      this.failBeforeModel(mission, run, 'RUNTIME_PROFILE_UNAVAILABLE');
      return;
    }

    let context: Awaited<ReturnType<ChatPromptContext['load']>> = {
      relevantMemories: [],
      skills: [],
      skillAssignments: [],
    };
    try {
      if (this.promptContext)
        context = await this.promptContext.load(teammate.id, mission.objective);
    } catch {
      // Memory and Skills augment execution; an unavailable context store cannot block a Mission.
    }
    if (
      this.store.getMission(mission.id)?.state !== 'RUNNING' ||
      this.store.getRun(run.id)?.status !== 'RUNNING'
    ) {
      return;
    }
    const messages = this.composer.compose({
      platformPolicy: PLATFORM_POLICY,
      teammate,
      relevantMemories: context.relevantMemories.filter(
        (memory) =>
          memory.ownerType === 'TEAMMATE' &&
          memory.ownerId === teammate.id &&
          memory.status === 'ACTIVE',
      ),
      skills: context.skills,
      skillAssignments: context.skillAssignments.filter(
        (assignment) => assignment.teammateId === teammate.id,
      ),
      conversationContext: [{ role: 'user', content: mission.objective }],
    }).messages;

    if (previousToolResult) {
      messages.push({ role: 'user', content: `TOOL_RESULT:${JSON.stringify(previousToolResult)}` });
    }
    if (this.toolRuntime && this.gateway.generateWithTools) {
      await this.executeToolLoop(
        mission,
        run,
        teammate.id,
        runtime,
        messages,
        previousStepCount,
        previousToolCallCount,
      );
      return;
    }

    this.store.transaction(() => {
      this.appendEvent(mission, run.id, 'model.call_started', 'TEAMMATE', teammate.id, {
        runtimeProfileId: runtime.id,
        providerId: runtime.providerId,
        modelId: runtime.modelId,
      });
      this.appendAudit(mission, 'model.call_started', 'TEAMMATE', teammate.id, {
        runId: run.id,
        runtimeProfileId: runtime.id,
        providerId: runtime.providerId,
        modelId: runtime.modelId,
      });
    });

    let response;
    this.busy.add(mission.id);
    try {
      response = await this.gateway.generate({
        teammateId: teammate.id,
        runtimeProfileId: runtime.id,
        messages,
      });
    } catch {
      this.busy.delete(mission.id);
      this.failModelCall(mission, run, teammate.id, runtime, null);
      return;
    } finally {
      this.busy.delete(mission.id);
    }

    // Startup recovery or a safe pause may have superseded this in-flight call.
    // Never let its late completion overwrite the persisted MissionRun state.
    if (
      this.store.getMission(mission.id)?.state !== 'RUNNING' ||
      this.store.getRun(run.id)?.status !== 'RUNNING'
    ) {
      return;
    }

    const output = response.text.slice(0, MAX_RESULT_LENGTH);
    const usage = this.usageRecord(mission, run, teammate.id, runtime, response.usage);
    const completedAt = this.clock.now();
    const completedRun: MissionRunRecord = {
      ...run,
      status: 'COMPLETED',
      endedAt: completedAt,
      errorCode: null,
      errorMessage: null,
      resultText: output,
    };
    const completedMission = this.transition(mission, 'COMPLETED', completedAt);
    this.store.transaction(() => {
      this.store.saveUsage(usage);
      this.appendUsageEvents(mission, run, teammate.id, runtime, usage);
      this.finishRun(completedRun);
      if (!this.store.transitionMission(completedMission, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(completedMission, run.id, 'run.completed', 'SYSTEM', null, {
        attempt: run.attempt,
      });
      this.appendStateEvents(mission, completedMission, 'SYSTEM', null, 'mission.completed', {
        runId: run.id,
        attempt: run.attempt,
      });
    });
  }

  private async executeToolLoop(
    mission: Mission,
    run: MissionRunRecord,
    teammateId: string,
    runtime: RuntimeProfile,
    messages: ModelRequest['messages'],
    initialSteps: number,
    initialToolCalls: number,
  ): Promise<void> {
    if (!this.toolRuntime || !this.gateway.generateWithTools) return;
    let steps = initialSteps;
    let toolCalls = initialToolCalls;
    if (this.busy.has(mission.id)) throw new DomainError('MISSION_BUSY', 'Mission 正在执行');
    this.busy.add(mission.id);
    try {
      while (steps < MAX_TOOL_STEPS) {
        if (!this.isRunActive(mission, run)) return;
        this.store.transaction(() => {
          this.appendEvent(mission, run.id, 'model.call_started', 'TEAMMATE', teammateId, {
            runtimeProfileId: runtime.id,
            providerId: runtime.providerId,
            modelId: runtime.modelId,
            step: steps + 1,
          });
          this.appendAudit(mission, 'model.call_started', 'TEAMMATE', teammateId, {
            runId: run.id,
            runtimeProfileId: runtime.id,
            providerId: runtime.providerId,
            modelId: runtime.modelId,
            step: steps + 1,
          });
        });
        let response;
        try {
          response = await this.gateway.generateWithTools({
            teammateId,
            runtimeProfileId: runtime.id,
            messages,
            tools: this.toolRuntime.registry.list(),
          });
        } catch {
          if (this.isRunActive(mission, run)) {
            this.failModelCall(mission, run, teammateId, runtime, null);
          }
          return;
        }
        if (!this.isRunActive(mission, run)) return;
        steps += 1;
        const usage = this.usageRecord(mission, run, teammateId, runtime, response.usage);
        this.store.transaction(() => {
          this.store.saveUsage(usage);
          this.appendUsageEvents(mission, run, teammateId, runtime, usage);
          this.appendEvent(mission, run.id, 'model.call_completed', 'TEAMMATE', teammateId, {
            step: steps,
            proposedToolCalls: response.toolCalls.length,
          });
          this.appendAudit(mission, 'model.call_completed', 'TEAMMATE', teammateId, {
            runId: run.id,
            step: steps,
            proposedToolCalls: response.toolCalls.length,
          });
        });

        if (response.toolCalls.length === 0) {
          this.completeToolRun(mission, run, response.text);
          return;
        }
        if (response.toolCalls.length !== 1) {
          toolCalls += response.toolCalls.length;
          if (toolCalls > MAX_TOOL_CALLS) break;
          const result: ToolResult = {
            toolCallId: 'multiple',
            toolId: 'multiple',
            ok: false,
            code: 'MULTIPLE_TOOL_CALLS',
            content: 'Propose only one tool call per model step.',
          };
          this.recordToolResult(
            mission,
            run,
            {
              toolId: 'multiple',
              source: 'BUILTIN',
              capability: 'FILE_READ',
              inputJson: '{}',
            },
            result,
          );
          messages.push({ role: 'user', content: `TOOL_RESULT:${JSON.stringify(result)}` });
          continue;
        }
        if (toolCalls >= MAX_TOOL_CALLS) break;
        toolCalls += 1;
        const proposed = response.toolCalls[0]!;
        const call: ToolCall = { id: proposed.id, toolId: proposed.toolId, input: proposed.input };
        let dispatch: ToolDispatch;
        try {
          dispatch = await this.toolRuntime.dispatch(call, {
            missionId: mission.id,
            runId: run.id,
            teammateId,
          });
        } catch {
          dispatch = {
            kind: 'RESULT',
            trace: {
              toolId: call.toolId,
              source: 'UNKNOWN',
              capability: null,
              riskLevel: null,
              sideEffect: null,
              resource: null,
              inputSummary: { keys: [], bytes: 0 },
              outputSummary: { ok: false, code: 'TOOL_FAILED', bytes: 0 },
            },
            result: {
              toolCallId: call.id,
              toolId: call.toolId,
              ok: false,
              code: 'TOOL_FAILED',
              content: 'Tool failed safely.',
            },
          };
        }
        if (!this.isRunActive(mission, run)) return;
        this.store.transaction(() => {
          this.appendEvent(mission, run.id, 'tool.proposed', 'TEAMMATE', teammateId, {
            toolId: dispatch.trace.toolId,
            source: dispatch.trace.source,
            capability: dispatch.trace.capability,
            inputSummary: dispatch.trace.inputSummary,
            step: steps,
          });
          this.appendAudit(mission, 'tool.proposed', 'TEAMMATE', teammateId, {
            runId: run.id,
            toolId: dispatch.trace.toolId,
            source: dispatch.trace.source,
            capability: dispatch.trace.capability,
            inputSummary: dispatch.trace.inputSummary,
            step: steps,
          });
        });
        if (dispatch.kind === 'APPROVAL') {
          this.requestToolApproval(mission, run, call, dispatch, steps, toolCalls);
          return;
        }
        this.recordToolResult(
          mission,
          run,
          {
            toolId: dispatch.trace.toolId,
            source: dispatch.trace.source === 'MCP' ? 'MCP' : 'BUILTIN',
            capability: dispatch.trace.capability ?? 'FILE_READ',
            inputJson: JSON.stringify({ callId: call.id, input: call.input }).slice(0, 64 * 1024),
          },
          dispatch.result,
        );
        messages.push({ role: 'user', content: `TOOL_RESULT:${JSON.stringify(dispatch.result)}` });
      }
      if (this.isRunActive(mission, run)) this.failToolLimit(mission, run);
    } finally {
      this.busy.delete(mission.id);
    }
  }

  private requestToolApproval(
    mission: Mission,
    run: MissionRunRecord,
    call: ToolCall,
    dispatch: Extract<ToolDispatch, { kind: 'APPROVAL' }>,
    steps: number,
    toolCalls: number,
  ): void {
    if (
      !this.pendingTools ||
      !dispatch.trace.capability ||
      !dispatch.trace.resource ||
      dispatch.trace.source === 'UNKNOWN' ||
      !dispatch.trace.riskLevel
    ) {
      throw new DomainError('PERSISTENCE_INVALID', 'Tool approval 数据无效');
    }
    const at = this.clock.now();
    const approval: ApprovalRequest = {
      id: this.clock.newId(),
      missionId: mission.id,
      runId: run.id,
      requesterTeammateId: mission.coordinatorTeammateId,
      capability: dispatch.trace.capability,
      actionType: 'TOOL_CALL',
      actionPayload: {
        toolId: dispatch.trace.toolId,
        source: dispatch.trace.source,
        resource: dispatch.trace.resource,
        inputSummary: dispatch.trace.inputSummary,
      },
      riskLevel: dispatch.trace.riskLevel,
      state: 'PENDING',
      createdAt: at,
      resolvedAt: null,
    };
    const waiting = this.transition(mission, 'WAITING_APPROVAL', at);
    this.store.transaction(() => {
      this.store.insertApproval(approval);
      this.pendingTools?.savePendingToolCall({
        approvalId: approval.id,
        missionId: mission.id,
        runId: run.id,
        toolId: call.toolId,
        source: dispatch.trace.source as 'BUILTIN' | 'MCP',
        capability: approval.capability,
        inputJson: JSON.stringify({ callId: call.id, input: call.input }),
        stepCount: steps,
        toolCallCount: toolCalls,
        state: 'PENDING',
        createdAt: at,
        resolvedAt: null,
      });
      if (!this.store.transitionMission(waiting, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(
        waiting,
        run.id,
        'tool.approval_requested',
        'TEAMMATE',
        mission.coordinatorTeammateId,
        {
          approvalId: approval.id,
          toolId: call.toolId,
          source: dispatch.trace.source,
          capability: approval.capability,
          inputSummary: dispatch.trace.inputSummary,
        },
      );
      this.appendAudit(
        waiting,
        'tool.approval_requested',
        'TEAMMATE',
        mission.coordinatorTeammateId,
        {
          runId: run.id,
          approvalId: approval.id,
          toolId: call.toolId,
          source: dispatch.trace.source,
          capability: approval.capability,
          inputSummary: dispatch.trace.inputSummary,
        },
      );
      this.appendStateEvents(mission, waiting, 'SYSTEM', null, 'mission.waiting_approval', {
        runId: run.id,
        approvalId: approval.id,
      });
    });
  }

  private recordToolResult(
    mission: Mission,
    run: MissionRunRecord,
    metadata: Pick<PendingMissionToolCall, 'toolId' | 'source' | 'capability' | 'inputJson'>,
    result: ToolResult,
    approvalId: string | null = null,
  ): void {
    const payload = {
      toolId: metadata.toolId,
      source: metadata.source,
      capability: metadata.capability,
      approvalId,
      success: result.ok,
      code: result.code,
      inputSummary: { bytes: Buffer.byteLength(metadata.inputJson) },
      outputSummary: { bytes: Buffer.byteLength(result.content) },
    };
    this.store.transaction(() => {
      this.appendEvent(
        mission,
        run.id,
        'tool.result',
        'TEAMMATE',
        mission.coordinatorTeammateId,
        payload,
      );
      this.appendAudit(mission, 'tool.result', 'TEAMMATE', mission.coordinatorTeammateId, {
        runId: run.id,
        ...payload,
      });
    });
  }

  private completeToolRun(mission: Mission, run: MissionRunRecord, text: string): void {
    const at = this.clock.now();
    const completed = this.transition(mission, 'COMPLETED', at);
    this.store.transaction(() => {
      this.finishRun({
        ...run,
        status: 'COMPLETED',
        endedAt: at,
        errorCode: null,
        errorMessage: null,
        resultText: text.slice(0, MAX_RESULT_LENGTH),
      });
      if (!this.store.transitionMission(completed, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(completed, run.id, 'run.completed', 'SYSTEM', null, {
        attempt: run.attempt,
      });
      this.appendStateEvents(mission, completed, 'SYSTEM', null, 'mission.completed', {
        runId: run.id,
        attempt: run.attempt,
      });
    });
  }

  private failToolLimit(mission: Mission, run: MissionRunRecord): void {
    const at = this.clock.now();
    const failed = this.transition(mission, 'FAILED', at);
    this.store.transaction(() => {
      this.finishRun({
        ...run,
        status: 'FAILED',
        endedAt: at,
        errorCode: 'TOOL_LIMIT_REACHED',
        errorMessage: 'Mission tool step limit reached.',
        resultText: JSON.stringify({ ok: false, code: 'TOOL_LIMIT_REACHED' }),
      });
      if (!this.store.transitionMission(failed, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(failed, run.id, 'runtime.tool_limit', 'SYSTEM', null, {
        maxSteps: MAX_TOOL_STEPS,
        maxToolCalls: MAX_TOOL_CALLS,
      });
      this.appendAudit(failed, 'runtime.tool_limit', 'SYSTEM', null, {
        runId: run.id,
        maxSteps: MAX_TOOL_STEPS,
        maxToolCalls: MAX_TOOL_CALLS,
      });
      this.appendStateEvents(mission, failed, 'SYSTEM', null, 'mission.failed', {
        runId: run.id,
        reason: 'TOOL_LIMIT_REACHED',
      });
    });
  }

  private isRunActive(mission: Mission, run: MissionRunRecord): boolean {
    return (
      this.store.getMission(mission.id)?.state === 'RUNNING' &&
      this.store.getRun(run.id)?.status === 'RUNNING'
    );
  }

  private failBeforeModel(mission: Mission, run: MissionRunRecord, code: string): void {
    const timestamp = this.clock.now();
    const failed = this.transition(mission, 'FAILED', timestamp);
    const failedRun: MissionRunRecord = {
      ...run,
      status: 'FAILED',
      endedAt: timestamp,
      errorCode: code,
      errorMessage: 'Mission could not start with the selected runtime.',
    };
    this.store.transaction(() => {
      this.finishRun(failedRun);
      if (!this.store.transitionMission(failed, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(failed, run.id, 'runtime.failed', 'SYSTEM', null, {
        attempt: run.attempt,
        errorCode: code,
      });
      this.appendAudit(failed, 'runtime.failed', 'SYSTEM', null, {
        runId: run.id,
        errorCode: code,
      });
      this.appendStateEvents(mission, failed, 'SYSTEM', null, 'mission.failed', {
        runId: run.id,
        reason: code,
      });
    });
  }

  private failModelCall(
    mission: Mission,
    run: MissionRunRecord,
    teammateId: string,
    runtime: RuntimeProfile,
    usage: ModelUsage | null,
  ): void {
    const timestamp = this.clock.now();
    const failed = this.transition(mission, 'FAILED', timestamp);
    const usageRecord = this.usageRecord(mission, run, teammateId, runtime, usage);
    const failedRun: MissionRunRecord = {
      ...run,
      status: 'FAILED',
      endedAt: timestamp,
      errorCode: 'MODEL_CALL_FAILED',
      errorMessage: '模型调用失败，请检查运行配置与网络。',
    };
    this.store.transaction(() => {
      this.store.saveUsage(usageRecord);
      this.appendUsageEvents(mission, run, teammateId, runtime, usageRecord);
      this.finishRun(failedRun);
      if (!this.store.transitionMission(failed, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendEvent(failed, run.id, 'model.call_failed', 'SYSTEM', null, {
        attempt: run.attempt,
        errorCode: 'MODEL_CALL_FAILED',
      });
      this.appendAudit(failed, 'model.call_failed', 'SYSTEM', null, {
        runId: run.id,
        errorCode: 'MODEL_CALL_FAILED',
      });
      this.appendStateEvents(mission, failed, 'SYSTEM', null, 'mission.failed', {
        runId: run.id,
        reason: 'MODEL_CALL_FAILED',
      });
    });
  }

  private usageRecord(
    mission: Mission,
    run: MissionRunRecord,
    teammateId: string,
    runtime: RuntimeProfile,
    value: ModelUsage | null,
  ): UsageRecord {
    const usage = modelUsage(value);
    return {
      id: this.clock.newId(),
      missionId: mission.id,
      runId: run.id,
      teammateId,
      runtimeProfileId: runtime.id,
      provider: runtime.providerId,
      model: runtime.modelId,
      inputTokens: validUsageCount(usage.inputTokens),
      outputTokens: validUsageCount(usage.outputTokens),
      cachedInputTokens: validUsageCount(usage.cachedInputTokens),
      reasoningTokens: validUsageCount(usage.reasoningTokens),
      providerMetadata: null,
      estimatedCost: null,
      currency: null,
      createdAt: this.clock.now(),
    };
  }

  private appendUsageEvents(
    mission: Mission,
    run: MissionRunRecord,
    teammateId: string,
    runtime: RuntimeProfile,
    usage: UsageRecord,
  ): void {
    const payload = {
      usageId: usage.id,
      runId: run.id,
      teammateId,
      runtimeProfileId: runtime.id,
      providerId: runtime.providerId,
      modelId: runtime.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      reasoningTokens: usage.reasoningTokens,
    };
    this.appendEvent(mission, run.id, 'usage.recorded', 'SYSTEM', null, payload);
    this.appendAudit(mission, 'usage.recorded', 'SYSTEM', null, payload);
  }

  private finishRun(run: MissionRunRecord): void {
    if (!this.store.finishRun(run)) {
      throw new DomainError('CONFLICT', 'MissionRun 已被其他操作修改');
    }
  }

  private transitionAndRecord(
    mission: Mission,
    nextState: MissionState,
    actorType: string,
    actorId: string | null,
    details: Record<string, unknown> & { eventType: string },
  ): Mission {
    const { eventType, ...payload } = details;
    const next = this.transition(mission, nextState);
    this.store.transaction(() => {
      if (!this.store.transitionMission(next, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.appendStateEvents(mission, next, actorType, actorId, eventType, payload);
    });
    return next;
  }

  private transition(mission: Mission, nextState: MissionState, at = this.clock.now()): Mission {
    return transition(mission, nextState, at);
  }

  private appendStateEvents(
    previous: Mission,
    next: Mission,
    actorType: string,
    actorId: string | null,
    eventType: string,
    details: Record<string, unknown>,
  ): void {
    const payload = {
      from: previous.state,
      to: next.state,
      ...details,
    };
    this.appendEvent(next, this.latestRunId(next.id), eventType, actorType, actorId, payload);
    this.appendAudit(
      next,
      `mission.state.${next.state.toLowerCase()}`,
      actorType,
      actorId,
      payload,
    );
  }

  private appendEvent(
    mission: Mission,
    runId: string | null,
    eventType: string,
    actorType: string,
    actorId: string | null,
    payloadJson: Record<string, unknown>,
  ): void {
    const event: MissionEvent = {
      id: this.clock.newId(),
      missionId: mission.id,
      runId,
      eventType,
      actorType,
      actorId,
      payloadJson,
      createdAt: this.clock.now(),
    };
    this.store.appendMissionEvent(event);
  }

  private appendAudit(
    mission: Mission,
    action: string,
    actorType: string,
    actorId: string | null,
    payloadJson: Record<string, unknown>,
  ): void {
    const audit: AuditEvent = {
      id: this.clock.newId(),
      actorType,
      actorId,
      action,
      targetType: 'MISSION',
      targetId: mission.id,
      payloadJson,
      createdAt: this.clock.now(),
    };
    this.store.appendAuditEvent(audit);
  }

  private requireMission(id: string): Mission {
    const mission = this.store.getMission(id);
    if (!mission) return absent('Mission');
    return mission;
  }

  private latestRun(missionId: string): MissionRunRecord {
    const run = this.store.listRuns(missionId).at(-1);
    if (!run) throw new DomainError('NOT_FOUND', 'MissionRun 不存在');
    return run;
  }

  private latestRunId(missionId: string): string | null {
    return this.store.listRuns(missionId).at(-1)?.id ?? null;
  }
}

export type MissionRunStatusForContract = MissionRunStatus;
export type MissionModeForContract = MissionMode;
export type MissionRiskForContract = RiskLevel;
export type Gate3PermissionRule = PermissionRule;
