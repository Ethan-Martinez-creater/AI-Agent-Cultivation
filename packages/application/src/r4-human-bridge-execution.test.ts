import { describe, expect, it } from 'vitest';
import { transition } from '@cultivation/domain';
import type {
  ApprovalRequest,
  ApprovalState,
  AuditEvent,
  ExternalWorkArtifact,
  Mission,
  MissionEvent,
  Teammate,
  UsageRecord,
} from '@cultivation/domain';
import type { ModelGateway } from './index.js';
import type { Gate1Store } from './gate1-service.js';
import {
  Gate3MissionService,
  type Gate3ExternalWorkService,
  type Gate3HumanBridgeAssignmentStore,
  type Gate3MissionStore,
  type MissionClock,
  type MissionRunRecord,
} from './gate3-mission-service.js';
import { PermissionEngine, type PermissionRuleStore } from './permission-engine.js';
import type {
  ExternalWorkContinuation,
  ExternalWorkDetail,
  ExternalWorkRequestRecord,
  HumanBridgeExternalWorkDraft,
  R2ExternalWorkContinuationRecord,
  R2ExternalWorkContinuationStore,
} from './r2-human-bridge-service.js';

const at = '2026-10-01T00:00:00.000Z';
const bridgeId = 'system-human-bridge';

class MemoryMissionStore implements Gate3MissionStore {
  readonly missions = new Map<string, Mission>();
  readonly runs = new Map<string, MissionRunRecord>();
  readonly approvals = new Map<string, ApprovalRequest>();
  readonly events: MissionEvent[] = [];
  readonly audits: AuditEvent[] = [];
  readonly usage: UsageRecord[] = [];
  private runSequence = 0;

  listMissions(): Mission[] {
    return [...this.missions.values()];
  }

  getMission(id: string): Mission | null {
    return this.missions.get(id) ?? null;
  }

  insertMission(mission: Mission): void {
    this.missions.set(mission.id, mission);
  }

  updateMissionDetails(mission: Mission): boolean {
    const current = this.missions.get(mission.id);
    if (!current || current.state !== mission.state) return false;
    this.missions.set(mission.id, mission);
    return true;
  }

  transitionMission(next: Mission, expectedState: Mission['state']): boolean {
    const current = this.missions.get(next.id);
    if (!current || current.state !== expectedState) return false;
    this.missions.set(next.id, next);
    return true;
  }

  listRunningMissions(): Mission[] {
    return this.listMissions().filter((mission) => mission.state === 'RUNNING');
  }

  listRuns(missionId: string): MissionRunRecord[] {
    return [...this.runs.values()]
      .filter((run) => run.missionId === missionId)
      .sort((left, right) => left.attempt - right.attempt);
  }

  getRun(id: string): MissionRunRecord | null {
    return this.runs.get(id) ?? null;
  }

  createRun(missionId: string, startedAt: string): MissionRunRecord {
    this.runSequence += 1;
    const run: MissionRunRecord = {
      id: `run-${this.runSequence}`,
      missionId,
      attempt: this.listRuns(missionId).length + 1,
      status: 'RUNNING',
      startedAt,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
      resultText: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  finishRun(run: MissionRunRecord): boolean {
    if (this.runs.get(run.id)?.status !== 'RUNNING') return false;
    this.runs.set(run.id, run);
    return true;
  }

  insertApproval(request: ApprovalRequest): void {
    this.approvals.set(request.id, request);
  }

  getApproval(id: string): ApprovalRequest | null {
    return this.approvals.get(id) ?? null;
  }

  listApprovals(missionId: string): ApprovalRequest[] {
    return [...this.approvals.values()].filter((request) => request.missionId === missionId);
  }

  resolveApproval(
    id: string,
    decision: Extract<ApprovalState, 'APPROVED' | 'DENIED' | 'CANCELLED'>,
    resolvedAt: string,
  ): ApprovalRequest | null {
    const current = this.approvals.get(id);
    if (!current || current.state !== 'PENDING') return null;
    const resolved = { ...current, state: decision, resolvedAt };
    this.approvals.set(id, resolved);
    return resolved;
  }

  listMissionEvents(missionId: string): MissionEvent[] {
    return this.events.filter((event) => event.missionId === missionId);
  }

  appendMissionEvent(event: MissionEvent): void {
    this.events.push(event);
  }

  listAuditEvents(missionId: string): AuditEvent[] {
    return this.audits.filter((audit) => audit.targetId === missionId);
  }

  appendAuditEvent(event: AuditEvent): void {
    this.audits.push(event);
  }

  listMissionUsage(missionId: string): UsageRecord[] {
    return this.usage.filter((record) => record.missionId === missionId);
  }

  saveUsage(record: UsageRecord): void {
    this.usage.push(record);
  }

  transaction<T>(fn: () => T): T {
    const snapshot = {
      missions: new Map(this.missions),
      runs: new Map(this.runs),
      approvals: new Map(this.approvals),
      events: [...this.events],
      audits: [...this.audits],
      usage: [...this.usage],
    };
    try {
      return fn();
    } catch (error) {
      this.missions.clear();
      for (const [key, value] of snapshot.missions) this.missions.set(key, value);
      this.runs.clear();
      for (const [key, value] of snapshot.runs) this.runs.set(key, value);
      this.approvals.clear();
      for (const [key, value] of snapshot.approvals) this.approvals.set(key, value);
      this.events.splice(0, this.events.length, ...snapshot.events);
      this.audits.splice(0, this.audits.length, ...snapshot.audits);
      this.usage.splice(0, this.usage.length, ...snapshot.usage);
      throw error;
    }
  }
}

class MemoryContinuationStore implements R2ExternalWorkContinuationStore {
  readonly records = new Map<string, R2ExternalWorkContinuationRecord>();

  createPending(input: {
    externalWorkRequestId: string;
    missionId: string;
    missionRunId: string;
    createdAt: string;
  }): R2ExternalWorkContinuationRecord {
    const current = this.records.get(input.externalWorkRequestId);
    if (current) return current;
    const record: R2ExternalWorkContinuationRecord = {
      externalWorkRequestId: input.externalWorkRequestId,
      missionId: input.missionId,
      missionRunId: input.missionRunId,
      state: 'PENDING',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      consumedAt: null,
    };
    this.records.set(record.externalWorkRequestId, record);
    return record;
  }

  getByRequestId(requestId: string): R2ExternalWorkContinuationRecord | null {
    return this.records.get(requestId) ?? null;
  }

  listRecoverable(): R2ExternalWorkContinuationRecord[] {
    return [...this.records.values()].filter((record) => record.state !== 'CONSUMED');
  }

  markConsuming(requestId: string, updatedAt: string): boolean {
    const record = this.records.get(requestId);
    if (!record || record.state !== 'PENDING') return false;
    this.records.set(requestId, { ...record, state: 'CONSUMING', updatedAt });
    return true;
  }

  markConsumed(requestId: string, at: string): boolean {
    const record = this.records.get(requestId);
    if (!record) return false;
    if (record.state === 'CONSUMED') return true;
    if (record.state !== 'CONSUMING') return false;
    this.records.set(requestId, { ...record, state: 'CONSUMED', updatedAt: at, consumedAt: at });
    return true;
  }
}

class MemoryExternalWorkService implements Gate3ExternalWorkService {
  readonly requests = new Map<string, ExternalWorkRequestRecord>();
  readonly artifacts = new Map<string, ExternalWorkArtifact[]>();

  constructor(private readonly store: MemoryMissionStore) {}

  createExplicit(input: Parameters<Gate3ExternalWorkService['createExplicit']>[0]) {
    const mission = this.store.getMission(input.missionId);
    const run = this.store.listRuns(input.missionId).at(-1);
    if (!mission || mission.state !== 'RUNNING' || !run || run.id !== input.runId) {
      throw new Error('ExternalWork requires the current RUNNING MissionRun');
    }
    const request: ExternalWorkRequestRecord = {
      id: 'external-request-1',
      missionId: input.missionId,
      runId: input.runId,
      requesterTeammateId: input.requesterTeammateId,
      assigneeTeammateId: bridgeId,
      capability: input.capability,
      title: input.title,
      prompt: input.prompt,
      requirementsJson: { items: input.requirements },
      targetArtifactsJson: { items: input.targetArtifacts },
      targetWorkspacePathsJson: { items: input.targetWorkspacePaths },
      acceptanceCriteriaJson: { items: input.acceptanceCriteria },
      externalAppProfileId: input.externalAppProfileId ?? null,
      publicResult: null,
      state: 'PENDING',
      createdAt: at,
      submittedAt: null,
      resolvedAt: null,
    };
    const waiting = transition(mission, 'WAITING_EXTERNAL_WORK', at);
    this.store.transaction(() => {
      this.requests.set(request.id, request);
      this.artifacts.set(request.id, []);
      if (!this.store.transitionMission(waiting, mission.state))
        throw new Error('Mission conflict');
    });
    return request;
  }

  getExternalWorkRequest(id: string): ExternalWorkDetail | null {
    const request = this.requests.get(id);
    return request ? { request, artifacts: this.artifacts.get(id) ?? [] } : null;
  }

  listExternalWorkRequests(missionId?: string, runId?: string): ExternalWorkRequestRecord[] {
    return [...this.requests.values()].filter(
      (request) =>
        (missionId === undefined || request.missionId === missionId) &&
        (runId === undefined || request.runId === runId),
    );
  }

  accept(requestId: string, publicResult: string): ExternalWorkRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('Missing ExternalWorkRequest');
    const artifact: ExternalWorkArtifact = {
      id: 'artifact-1',
      externalWorkRequestId: request.id,
      path: 'output/report.md',
      fileName: 'report.md',
      extension: '.md',
      sizeBytes: 42,
      mimeType: 'text/markdown',
      metadataJson: { targetArtifactId: 'report' },
      submittedAt: at,
    };
    const accepted: ExternalWorkRequestRecord = {
      ...request,
      publicResult,
      state: 'ACCEPTED',
      submittedAt: at,
      resolvedAt: at,
    };
    this.requests.set(request.id, accepted);
    this.artifacts.set(request.id, [artifact]);
    return accepted;
  }

  cancel(requestId: string): ExternalWorkRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('Missing ExternalWorkRequest');
    const cancelled = { ...request, state: 'CANCELLED' as const, resolvedAt: at };
    this.requests.set(request.id, cancelled);
    const mission = this.store.getMission(request.missionId);
    if (mission?.state === 'WAITING_EXTERNAL_WORK') {
      this.store.transitionMission(transition(mission, 'RUNNING', at), mission.state);
    }
    return cancelled;
  }

  cancelForMission(input: { requestId: string; missionId: string; runId: string }) {
    const request = this.requests.get(input.requestId);
    if (
      !request ||
      request.missionId !== input.missionId ||
      request.runId !== input.runId ||
      !['PENDING', 'IN_PROGRESS', 'SUBMITTED'].includes(request.state)
    ) {
      throw new Error('ExternalWork request cannot be cancelled with Mission');
    }
    const cancelled = { ...request, state: 'CANCELLED' as const, resolvedAt: at };
    this.requests.set(request.id, cancelled);
    return cancelled;
  }
}

const draft: HumanBridgeExternalWorkDraft = {
  capability: 'CODING',
  title: 'Implement the requested change',
  prompt: 'Complete the bounded implementation task.',
  requirements: ['Provide the source file.'],
  targetArtifacts: [
    {
      id: 'report',
      name: 'Source report',
      required: true,
      allowedExtensions: ['.md'],
      maxSizeBytes: 10_000,
    },
  ],
  targetWorkspacePaths: ['deliverables'],
  acceptanceCriteria: ['The file contains the completed result.'],
};

function harness(model = false) {
  const bridge: Teammate = {
    id: bridgeId,
    name: '本尊 / Human Bridge',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    executorKind: 'USER_BRIDGE',
    routingPolicy: 'FALLBACK_ONLY',
    systemKind: 'HUMAN_BRIDGE',
    status: 'ACTIVE',
    realm: 'QI_REFINING',
    currentRuntimeProfileId: null,
    createdAt: at,
    updatedAt: at,
  };
  const store = new MemoryMissionStore();
  const externalWork = new MemoryExternalWorkService(store);
  const continuations = new MemoryContinuationStore();
  let missionId: string | null = null;
  const assignments: Gate3HumanBridgeAssignmentStore = {
    getByMissionId: (id) => (id === missionId ? { externalWorkDraft: draft } : null),
  };
  const gate1 = {
    getTeammate: (id: string) =>
      id === bridge.id
        ? bridge
        : id === 'model'
          ? {
              ...bridge,
              id: 'model',
              executorKind: 'MODEL_RUNTIME',
              routingPolicy: 'NORMAL',
              systemKind: null,
              currentRuntimeProfileId: 'runtime',
            }
          : null,
    getRuntimeProfile: () => ({
      id: 'runtime',
      name: 'Model',
      providerId: 'provider',
      credentialId: null,
      modelId: 'fixed-model',
      parameters: {},
      capabilityOverrides: {},
      createdAt: at,
      updatedAt: at,
    }),
  } as unknown as Pick<Gate1Store, 'getTeammate' | 'getRuntimeProfile'>;
  let generated = 0;
  const gateway = {
    generate: async () => {
      generated += 1;
      if (model) return { text: 'automatic verification report', usage: null };
      throw new Error('Human Bridge SOLO must not call a model');
    },
    stream: async function* () {
      generated += 1;
      yield undefined;
      throw new Error('Human Bridge SOLO must not stream a model');
    },
    testConnection: async () => {
      generated += 1;
      throw new Error('Human Bridge SOLO must not test a model');
    },
  } as unknown as ModelGateway;
  let id = 0;
  const clock: MissionClock = {
    now: () => at,
    newId: () => `id-${++id}`,
  };
  const permissionStore = {} as PermissionRuleStore;
  const service = new Gate3MissionService(
    store,
    gate1,
    new PermissionEngine(permissionStore),
    gateway,
    undefined,
    clock,
  );
  service.attachHumanBridgeExecution(externalWork, continuations, assignments);
  const mission = (
    model ? service.create.bind(service) : service.createHumanBridgeMission.bind(service)
  )({
    title: 'R4 Human Bridge SOLO',
    objective: 'Produce a source report.',
    coordinatorTeammateId: model ? 'model' : bridgeId,
  });
  missionId = mission.id;
  return {
    service,
    store,
    externalWork,
    continuations,
    mission,
    clock,
    gate1,
    gatewayCalls: () => generated,
  };
}

describe('bounded mixed verification continuation', () => {
  it('cancels its pending manual work with the original Mission without creating a success continuation', async () => {
    const h = harness(true);
    h.service.attachCompletionBoundary({
      prepare: () => ({ draft, stepRunId: 'S06' }),
      compose: async () => {
        throw new Error('cancelled manual work cannot compose');
      },
    });
    h.service.ready(h.mission.id);
    await h.service.start({ missionId: h.mission.id, approvalFixture: false });
    h.service.cancel(h.mission.id);
    expect(h.externalWork.getExternalWorkRequest('external-request-1')?.request.state).toBe(
      'CANCELLED',
    );
    expect(h.continuations.listRecoverable()).toEqual([]);
    expect(h.service.detail(h.mission.id).runs[0]?.status).toBe('CANCELLED');
    expect(h.gatewayCalls()).toBe(1);
  });
  it('resumes the original model Run after restart, composing accepted manual evidence once with zero model replay', async () => {
    const h = harness(true);
    let composed = 0;
    const boundary = {
      prepare: () => ({ draft, stepRunId: 'S06-attempt-1' }),
      compose: async () => {
        composed++;
        return 'trusted command + accepted manual report';
      },
    };
    h.service.attachCompletionBoundary(boundary);
    h.service.ready(h.mission.id);
    const waiting = await h.service.start({ missionId: h.mission.id, approvalFixture: false });
    expect(waiting.mission.state).toBe('WAITING_EXTERNAL_WORK');
    expect(h.gatewayCalls()).toBe(1);
    const originalRun = waiting.runs[0]!.id;
    const request = h.externalWork.accept('external-request-1', 'manual accepted');
    h.continuations.createPending({
      externalWorkRequestId: request.id,
      missionId: h.mission.id,
      missionRunId: originalRun,
      createdAt: at,
    });
    const restarted = new Gate3MissionService(
      h.store,
      h.gate1,
      new PermissionEngine({} as PermissionRuleStore),
      {
        generate: async () => {
          throw new Error('must not replay model');
        },
      } as unknown as ModelGateway,
      undefined,
      h.clock,
    );
    restarted.attachHumanBridgeExecution(h.externalWork, h.continuations, {
      getByMissionId: () => null,
    });
    restarted.attachCompletionBoundary(boundary);
    expect(restarted.recoverInterrupted()).toEqual([]);
    const done = await restarted.resumeExternalWork(continuation(request, 'ACCEPTED'));
    await restarted.resumeExternalWork(continuation(request, 'ACCEPTED'));
    expect(done.runs).toHaveLength(1);
    expect(done.runs[0]).toMatchObject({
      id: originalRun,
      status: 'COMPLETED',
      resultText: 'trusted command + accepted manual report',
    });
    expect(composed).toBe(1);
    expect(h.gatewayCalls()).toBe(1);
    expect(h.continuations.getByRequestId(request.id)?.state).toBe('CONSUMED');
  });
  it('does not consume accepted evidence or complete a Run when trusted composition fails', async () => {
    const h = harness(true);
    h.service.attachCompletionBoundary({
      prepare: () => ({ draft, stepRunId: 'S06' }),
      compose: async () => {
        throw new Error('artifact hash changed');
      },
    });
    h.service.ready(h.mission.id);
    const waiting = await h.service.start({ missionId: h.mission.id, approvalFixture: false });
    const request = h.externalWork.accept('external-request-1', 'manual accepted');
    h.continuations.createPending({
      externalWorkRequestId: request.id,
      missionId: h.mission.id,
      missionRunId: waiting.runs[0]!.id,
      createdAt: at,
    });
    await expect(h.service.resumeExternalWork(continuation(request, 'ACCEPTED'))).rejects.toThrow(
      'hash changed',
    );
    expect(h.store.getRun(waiting.runs[0]!.id)?.status).toBe('RUNNING');
    expect(h.store.getMission(h.mission.id)?.state).toBe('WAITING_EXTERNAL_WORK');
    expect(h.continuations.getByRequestId(request.id)?.state).toBe('PENDING');
    expect(h.gatewayCalls()).toBe(1);
  });
});

function continuation(
  request: ExternalWorkRequestRecord,
  outcome: ExternalWorkContinuation['outcome'],
): ExternalWorkContinuation {
  const artifacts =
    outcome === 'ACCEPTED'
      ? [
          {
            id: 'artifact-1',
            path: 'output/report.md',
            fileName: 'report.md',
            extension: '.md',
            sizeBytes: 42,
          },
        ]
      : [];
  return {
    kind: 'EXTERNAL_WORK_CONTINUATION',
    requestId: request.id,
    missionId: request.missionId,
    runId: request.runId,
    requesterTeammateId: request.requesterTeammateId,
    assigneeTeammateId: request.assigneeTeammateId,
    capability: request.capability,
    outcome,
    publicResult: request.publicResult,
    artifacts,
    trust: 'UNTRUSTED_EXTERNAL_DATA',
  };
}

describe('R4 SOLO Human Bridge Mission execution', () => {
  it('accepts a durable continuation after restart on the same Run without model usage or artifacts', async () => {
    const { service, store, externalWork, continuations, mission, clock, gatewayCalls } = harness();
    service.ready(mission.id);
    const waiting = await service.start({ missionId: mission.id, approvalFixture: false });
    const originalRunId = waiting.runs[0]!.id;
    const request = externalWork.accept(
      'external-request-1',
      'The reviewed implementation is ready.',
    );
    continuations.createPending({
      externalWorkRequestId: request.id,
      missionId: mission.id,
      missionRunId: originalRunId,
      createdAt: clock.now(),
    });
    expect(continuations.markConsuming(request.id, clock.now())).toBe(true);

    const restarted = new Gate3MissionService(
      store,
      {
        getTeammate: (id: string) => (id === bridgeId ? humanBridgeTeammate : null),
        getRuntimeProfile: () => null,
      } as unknown as Pick<Gate1Store, 'getTeammate' | 'getRuntimeProfile'>,
      new PermissionEngine({} as PermissionRuleStore),
      {
        generate: async () => {
          throw new Error('Human Bridge continuation must not call a model');
        },
        stream: async function* () {
          yield undefined;
          throw new Error('Human Bridge continuation must not stream a model');
        },
        testConnection: async () => {
          throw new Error('Human Bridge continuation must not test a model');
        },
      } as unknown as ModelGateway,
      undefined,
      clock,
    );
    const assignments: Gate3HumanBridgeAssignmentStore = {
      getByMissionId: (id) => (id === mission.id ? { externalWorkDraft: draft } : null),
    };
    restarted.attachHumanBridgeExecution(externalWork, continuations, assignments);

    const done = await restarted.resumeExternalWork(continuation(request, 'ACCEPTED'));
    const replay = await restarted.resumeExternalWork(continuation(request, 'ACCEPTED'));
    expect(done.mission.state).toBe('COMPLETED');
    expect(done.runs).toHaveLength(1);
    expect(done.runs[0]).toMatchObject({
      id: originalRunId,
      status: 'COMPLETED',
      resultText: 'The reviewed implementation is ready.',
    });
    expect(replay.runs.map((run) => run.id)).toEqual([originalRunId]);
    expect(continuations.getByRequestId(request.id)?.state).toBe('CONSUMED');
    expect(done.usage).toEqual([]);
    expect(done.events.map((event) => event.eventType)).not.toContain('model.call_started');
    expect(done.events.map((event) => event.eventType)).not.toContain('tool.result');
    expect(done.events.map((event) => event.eventType)).not.toContain('collaboration.artifact');
    expect(gatewayCalls()).toBe(0);
  });

  it('records Human Bridge cancellation as a failed result and never marks it complete', async () => {
    const { service, externalWork, continuations, mission, gatewayCalls } = harness();
    service.ready(mission.id);
    const waiting = await service.start({ missionId: mission.id, approvalFixture: false });
    const originalRunId = waiting.runs[0]!.id;
    const request = externalWork.cancel('external-request-1');
    const detail = await service.resumeExternalWork(continuation(request, 'CANCELLED'));

    expect(detail.mission.state).toBe('FAILED');
    expect(detail.runs[0]).toMatchObject({
      id: originalRunId,
      status: 'FAILED',
      errorCode: 'EXTERNAL_WORK_CANCELLED',
      resultText: JSON.stringify({ ok: false, code: 'EXTERNAL_WORK_CANCELLED' }),
    });
    expect(continuations.getByRequestId(request.id)).toBeNull();
    expect(detail.usage).toEqual([]);
    expect(gatewayCalls()).toBe(0);

    const second = harness();
    second.service.ready(second.mission.id);
    const secondWaiting = await second.service.start({
      missionId: second.mission.id,
      approvalFixture: false,
    });
    const cancelled = second.service.cancel(second.mission.id);
    expect(cancelled.state).toBe('CANCELLED');
    expect(second.service.detail(second.mission.id).runs[0]).toMatchObject({
      id: secondWaiting.runs[0]!.id,
      status: 'CANCELLED',
      errorCode: 'MISSION_CANCELLED',
      resultText: JSON.stringify({ ok: false, code: 'MISSION_CANCELLED' }),
    });
    expect(second.externalWork.listExternalWorkRequests(second.mission.id)[0]?.state).toBe(
      'CANCELLED',
    );
    expect(second.store.usage).toEqual([]);
  });

  it('keeps routed Mission objectives immutable while allowing title edits and legacy edits', () => {
    const routed = harness();
    routed.service.attachAssignmentGuard({
      hasAssignment: (missionId) => missionId === routed.mission.id,
    });

    const renamed = routed.service.update({
      id: routed.mission.id,
      title: 'R4 routed Mission renamed',
      objective: routed.mission.objective,
    });
    expect(renamed.title).toBe('R4 routed Mission renamed');
    expect(() =>
      routed.service.update({
        id: routed.mission.id,
        title: 'R4 routed Mission renamed again',
        objective: 'Change the immutable routed objective.',
      }),
    ).toThrow(expect.objectContaining({ code: 'MISSION_INVALID_STATE' }));

    const legacy = harness();
    legacy.service.attachAssignmentGuard({ hasAssignment: () => false });
    const edited = legacy.service.update({
      id: legacy.mission.id,
      title: 'Legacy Mission updated',
      objective: 'Legacy unassigned objective remains editable.',
    });
    expect(edited.objective).toBe('Legacy unassigned objective remains editable.');
  });
});

const humanBridgeTeammate: Teammate = {
  id: bridgeId,
  name: '本尊 / Human Bridge',
  avatar: null,
  title: null,
  description: '',
  identityPrompt: '',
  behaviorPrompt: '',
  executorKind: 'USER_BRIDGE',
  routingPolicy: 'FALLBACK_ONLY',
  systemKind: 'HUMAN_BRIDGE',
  status: 'ACTIVE',
  realm: 'QI_REFINING',
  currentRuntimeProfileId: null,
  createdAt: at,
  updatedAt: at,
};
