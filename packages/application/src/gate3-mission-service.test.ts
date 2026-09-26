import { describe, expect, it } from 'vitest';
import type {
  ApprovalRequest,
  ApprovalState,
  AuditEvent,
  MemoryRecord,
  Mission,
  MissionEvent,
  PermissionRule,
  RuntimeProfile,
  Skill,
  SkillAssignment,
  Teammate,
  UsageRecord,
} from '@cultivation/domain';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { ChatPromptContext, Gate1Store } from './gate1-service.js';
import {
  Gate3MissionService,
  type Gate3MissionStore,
  type MissionClock,
  type MissionRunRecord,
  type PendingMissionToolCall,
  type PendingMissionToolStore,
} from './gate3-mission-service.js';
import { PermissionEngine, type PermissionRuleStore } from './permission-engine.js';
import { ToolRegistry, ToolRuntime } from './tool-runtime.js';

const timestamp = '2026-09-26T00:00:00.000Z';

class InMemoryMissionStore implements Gate3MissionStore {
  missions = new Map<string, Mission>();
  runs = new Map<string, MissionRunRecord>();
  approvals = new Map<string, ApprovalRequest>();
  events: MissionEvent[] = [];
  audits: AuditEvent[] = [];
  usage: UsageRecord[] = [];
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
    const attempt =
      this.listRuns(missionId).reduce((max, run) => Math.max(max, run.attempt), 0) + 1;
    this.runSequence += 1;
    const run: MissionRunRecord = {
      id: `run-${this.runSequence}`,
      missionId,
      attempt,
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
    const current = this.runs.get(run.id);
    if (!current || current.status !== 'RUNNING') return false;
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
    return [...this.approvals.values()].filter((item) => item.missionId === missionId);
  }

  resolveApproval(
    id: string,
    decision: Extract<ApprovalState, 'APPROVED' | 'DENIED' | 'CANCELLED'>,
    at: string,
  ): ApprovalRequest | null {
    const current = this.approvals.get(id);
    if (!current || current.state !== 'PENDING') return null;
    const resolved = { ...current, state: decision, resolvedAt: at };
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
    return this.audits.filter((event) => event.targetId === missionId);
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
      this.missions = snapshot.missions;
      this.runs = snapshot.runs;
      this.approvals = snapshot.approvals;
      this.events = snapshot.events;
      this.audits = snapshot.audits;
      this.usage = snapshot.usage;
      throw error;
    }
  }
}

class InMemoryPermissionStore implements PermissionRuleStore {
  constructor(readonly rules: PermissionRule[] = []) {}

  listPermissionRules(
    subjectType: PermissionRule['subjectType'],
    subjectId: string,
    capability: PermissionRule['capability'],
  ): PermissionRule[] {
    return this.rules.filter(
      (rule) =>
        rule.subjectType === subjectType &&
        rule.subjectId === subjectId &&
        rule.capability === capability,
    );
  }

  savePermissionRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }
}

class TestClock implements MissionClock {
  private sequence = 0;

  now(): string {
    return timestamp;
  }

  newId(): string {
    this.sequence += 1;
    return `id-${this.sequence}`;
  }
}

class InMemoryPendingTools implements PendingMissionToolStore {
  readonly calls = new Map<string, PendingMissionToolCall>();

  savePendingToolCall(call: PendingMissionToolCall): void {
    this.calls.set(call.approvalId, call);
  }

  getPendingToolCall(id: string): PendingMissionToolCall | null {
    return this.calls.get(id) ?? null;
  }

  resolvePendingToolCall(id: string, resolvedAt: string): PendingMissionToolCall | null {
    const previous = this.calls.get(id);
    if (!previous || previous.state !== 'PENDING') return null;
    const resolved = { ...previous, state: 'RESOLVED' as const, resolvedAt };
    this.calls.set(id, resolved);
    return resolved;
  }
}

function attachFixtureTool(
  service: Gate3MissionService,
  permissionStore: InMemoryPermissionStore,
  pending: InMemoryPendingTools,
  execute: () => Promise<{ content: string }>,
): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register({
    descriptor: {
      id: 'file.readText',
      name: 'Read text',
      description: 'Read a workspace file',
      source: 'BUILTIN',
      capability: 'FILE_READ',
      riskLevel: 'READ_ONLY',
      sideEffect: 'NONE',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    resource: (input) => `file:${input.path}`,
    execute: async () => execute(),
  });
  const runtime = new ToolRuntime(registry, new PermissionEngine(permissionStore));
  service.attachTools(runtime, pending);
  return runtime;
}

function fixture() {
  const teammate: Teammate = {
    id: 'teammate-1',
    name: '青玄',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: 'Curious researcher',
    behaviorPrompt: 'Answer clearly',
    status: 'ACTIVE',
    realm: 'QI_REFINING',
    currentRuntimeProfileId: 'runtime-1',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const runtime: RuntimeProfile = {
    id: 'runtime-1',
    name: 'Fake runtime',
    providerId: 'provider-test',
    credentialId: null,
    modelId: 'fake-model',
    parameters: {},
    capabilityOverrides: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const gate1 = {
    getTeammate: (id: string) => (id === teammate.id ? teammate : null),
    getRuntimeProfile: (id: string) => (id === runtime.id ? runtime : null),
  } as unknown as Pick<Gate1Store, 'getTeammate' | 'getRuntimeProfile'>;
  const store = new InMemoryMissionStore();
  const permissionStore = new InMemoryPermissionStore();
  const gateway = new FakeModelGateway();
  const service = new Gate3MissionService(
    store,
    gate1,
    new PermissionEngine(permissionStore),
    gateway,
    undefined,
    new TestClock(),
  );
  return { store, permissionStore, gateway, service, teammate, runtime, gate1 };
}

function permissionRule(
  scope: PermissionRule['scope'],
  scopeId: string | null,
  decision: PermissionRule['decision'],
): PermissionRule {
  return {
    id: `rule-${scope}-${scopeId}`,
    subjectType: 'TEAMMATE',
    subjectId: 'teammate-1',
    capability: 'SPEND_BUDGET',
    resourcePattern: 'mission:fixture:spend-budget',
    scope,
    scopeId,
    decision,
  } as PermissionRule;
}

function activeMemory(id: string, ownerId: string, content: string): MemoryRecord {
  return {
    id,
    ownerType: 'TEAMMATE',
    ownerId,
    memoryType: 'FACT',
    content,
    summary: content,
    sourceType: 'MANUAL',
    sourceId: null,
    sourceConversationId: null,
    sourceMessageId: null,
    importance: 0.5,
    confidence: 1,
    status: 'ACTIVE',
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: null,
    confirmedAt: timestamp,
  };
}

describe('Gate 3 Mission Runtime', () => {
  it('executes a SOLO Mission and binds Usage to its run and runtime', async () => {
    const { service } = fixture();
    const created = service.create({
      title: 'Summarize',
      objective: 'Summarize the public release notes.',
      coordinatorTeammateId: 'teammate-1',
    });

    expect(created.state).toBe('DRAFT');
    expect(service.ready(created.id).state).toBe('READY');
    const detail = await service.start({ missionId: created.id, approvalFixture: false });

    expect(detail.mission.state).toBe('COMPLETED');
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ attempt: 1, status: 'COMPLETED' });
    expect(detail.runs[0]?.resultText).toContain('Summarize the public release notes.');
    expect(detail.usage).toHaveLength(1);
    expect(detail.usage[0]).toMatchObject({
      missionId: created.id,
      runId: detail.runs[0]?.id,
      teammateId: 'teammate-1',
      runtimeProfileId: 'runtime-1',
      provider: 'provider-test',
      model: 'fake-model',
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    expect(detail.events.map((event) => event.eventType)).toContain('mission.completed');
    expect(JSON.stringify(detail.events)).not.toContain(detail.runs[0]?.resultText);
    expect(detail.audits.map((event) => event.action)).toContain('usage.recorded');
  });

  it('rejects invalid transitions through the domain state machine', async () => {
    const { service } = fixture();
    const mission = service.create({
      title: 'Draft',
      objective: 'Just a draft.',
      coordinatorTeammateId: 'teammate-1',
    });

    await expect(
      service.start({ missionId: mission.id, approvalFixture: false }),
    ).rejects.toMatchObject({
      code: 'MISSION_INVALID_STATE',
    });
    service.ready(mission.id);
    await service.start({ missionId: mission.id, approvalFixture: false });
    expect(() => service.cancel(mission.id)).toThrow(/Illegal Mission transition/);
  });

  it('pauses at a prompt boundary and resumes the same run', async () => {
    const { store } = fixture();
    let releaseContext!: (value: Awaited<ReturnType<ChatPromptContext['load']>>) => void;
    let signalContext!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      signalContext = resolve;
    });
    let loadCount = 0;
    const context: ChatPromptContext = {
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          signalContext();
          return new Promise((resolve) => {
            releaseContext = resolve;
          });
        }
        return { relevantMemories: [], skills: [], skillAssignments: [] };
      },
    };
    const { teammate, runtime, permissionStore, gateway, gate1 } = fixture();
    const withContext = new Gate3MissionService(
      store,
      gate1,
      new PermissionEngine(permissionStore),
      gateway,
      context,
      new TestClock(),
    );
    const mission = withContext.create({
      title: 'Pause test',
      objective: 'Wait at the safe boundary.',
      coordinatorTeammateId: teammate.id,
    });
    withContext.ready(mission.id);
    const pendingStart = withContext.start({ missionId: mission.id, approvalFixture: false });
    await contextStarted;
    expect(withContext.pause(mission.id).state).toBe('PAUSED');
    releaseContext({ relevantMemories: [], skills: [], skillAssignments: [] });
    expect((await pendingStart).mission.state).toBe('PAUSED');

    const resumed = await withContext.resume(mission.id);
    expect(resumed.mission.state).toBe('COMPLETED');
    expect(resumed.runs).toHaveLength(1);
    expect(resumed.runs[0]).toMatchObject({ id: 'run-1', status: 'COMPLETED', attempt: 1 });
    expect(runtime.id).toBe('runtime-1');
  });

  it('waits for approval, resumes the original run on approve, and returns a denial on deny', async () => {
    const approved = fixture();
    const first = approved.service.create({
      title: 'Approval A',
      objective: 'Continue after approval.',
      coordinatorTeammateId: 'teammate-1',
    });
    approved.service.ready(first.id);
    const waiting = await approved.service.start({ missionId: first.id, approvalFixture: true });
    expect(waiting.mission.state).toBe('WAITING_APPROVAL');
    expect(waiting.runs[0]?.status).toBe('RUNNING');
    expect(waiting.approvals[0]?.state).toBe('PENDING');
    expect(approved.service.recoverInterrupted()).toEqual([]);
    expect(approved.service.detail(first.id).mission.state).toBe('WAITING_APPROVAL');

    const approval = waiting.approvals[0];
    expect(approval).toBeDefined();
    const completed = await approved.service.resolveApproval({
      approvalId: approval!.id,
      decision: 'APPROVED',
    });
    expect(completed.mission.state).toBe('COMPLETED');
    expect(completed.runs).toHaveLength(1);
    expect(completed.runs[0]?.id).toBe(waiting.runs[0]?.id);
    await expect(
      approved.service.resolveApproval({ approvalId: approval!.id, decision: 'DENIED' }),
    ).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_RESOLVED' });

    const denied = fixture();
    const mission = denied.service.create({
      title: 'Approval B',
      objective: 'Do not perform denied action.',
      coordinatorTeammateId: 'teammate-1',
    });
    denied.service.ready(mission.id);
    const pending = await denied.service.start({ missionId: mission.id, approvalFixture: true });
    const decision = await denied.service.resolveApproval({
      approvalId: pending.approvals[0]!.id,
      decision: 'DENIED',
    });
    expect(decision.mission.state).toBe('FAILED');
    expect(decision.runs[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'PERMISSION_DENIED',
      resultText: 'Permission denied: SPEND_BUDGET.',
    });
    expect(decision.usage).toEqual([]);
    expect(JSON.stringify(decision.events)).not.toContain('Do not perform denied action.');
  });

  it('keeps a Mission-specific grant isolated and explicit DENY takes priority', () => {
    const { service, permissionStore } = fixture();
    permissionStore.savePermissionRule(permissionRule('MISSION', 'mission-1', 'ALLOW'));
    const evaluate = (missionId: string) =>
      new PermissionEngine(permissionStore).evaluate({
        subjectType: 'TEAMMATE',
        subjectId: 'teammate-1',
        capability: 'SPEND_BUDGET',
        resource: 'mission:fixture:spend-budget',
        teammateId: 'teammate-1',
        missionId,
      }).decision;
    expect(evaluate('mission-1')).toBe('ALLOW');
    expect(evaluate('mission-2')).toBe('ASK');
    permissionStore.savePermissionRule(permissionRule('MISSION', 'mission-1', 'DENY'));
    expect(evaluate('mission-1')).toBe('DENY');
    expect(service.list()).toEqual([]);
  });

  it('recovers RUNNING to INTERRUPTED and retries with a new preserved attempt', async () => {
    const context = fixture();
    let fail = true;
    const fake = new FakeModelGateway();
    const gateway = {
      ...fake,
      generate: async (request: Parameters<FakeModelGateway['generate']>[0]) => {
        if (fail) {
          fail = false;
          throw new Error('provider-secret-must-not-be-logged');
        }
        return fake.generate(request);
      },
      stream: fake.stream.bind(fake),
      testConnection: fake.testConnection.bind(fake),
    };
    const retryService = new Gate3MissionService(
      context.store,
      context.gate1,
      new PermissionEngine(context.permissionStore),
      gateway,
      undefined,
      new TestClock(),
    );
    const mission = retryService.create({
      title: 'Retry',
      objective: 'Retry after transient failure.',
      coordinatorTeammateId: 'teammate-1',
    });
    retryService.ready(mission.id);
    const failed = await retryService.start({ missionId: mission.id, approvalFixture: false });
    expect(failed.mission.state).toBe('FAILED');
    expect(failed.runs[0]?.status).toBe('FAILED');
    expect(JSON.stringify(failed.events)).not.toContain('provider-secret-must-not-be-logged');
    const retried = await retryService.retry({ missionId: mission.id, approvalFixture: false });
    expect(retried.mission.state).toBe('COMPLETED');
    expect(retried.runs.map(({ id, attempt, status }) => ({ id, attempt, status }))).toEqual([
      { id: 'run-1', attempt: 1, status: 'FAILED' },
      { id: 'run-2', attempt: 2, status: 'COMPLETED' },
    ]);
    expect(retried.audits.map((event) => event.action)).toContain('mission.state.ready');
    expect(retried.audits.length).toBeGreaterThan(failed.audits.length);
  });

  it('marks a persisted RUNNING Mission and Run interrupted after restart without accepting late output', async () => {
    const { store, permissionStore, gate1 } = fixture();
    const fake = new FakeModelGateway();
    let signalModel!: () => void;
    let releaseModel!: (value: Awaited<ReturnType<FakeModelGateway['generate']>>) => void;
    const modelStarted = new Promise<void>((resolve) => {
      signalModel = resolve;
    });
    let firstCall = true;
    const deferredGateway = {
      generate: async (request: Parameters<FakeModelGateway['generate']>[0]) => {
        if (!firstCall) return fake.generate(request);
        firstCall = false;
        signalModel();
        return new Promise<Awaited<ReturnType<FakeModelGateway['generate']>>>((resolve) => {
          releaseModel = resolve;
        });
      },
      stream: fake.stream.bind(fake),
      testConnection: fake.testConnection.bind(fake),
    };
    const service = new Gate3MissionService(
      store,
      gate1,
      new PermissionEngine(permissionStore),
      deferredGateway,
      undefined,
      new TestClock(),
    );
    const mission = service.create({
      title: 'Crash recovery',
      objective: 'The process will restart mid run.',
      coordinatorTeammateId: 'teammate-1',
    });
    service.ready(mission.id);
    const inFlight = service.start({ missionId: mission.id, approvalFixture: false });
    await modelStarted;
    expect(service.recoverInterrupted()).toMatchObject([{ id: mission.id, state: 'INTERRUPTED' }]);
    expect(service.detail(mission.id).runs[0]?.status).toBe('INTERRUPTED');

    releaseModel({
      text: 'stale output',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
    const recovered = await inFlight;
    expect(recovered.mission.state).toBe('INTERRUPTED');
    expect(recovered.runs[0]?.resultText).toBeNull();
    expect(recovered.usage).toEqual([]);

    const retried = await service.retry({ missionId: mission.id, approvalFixture: false });
    expect(retried.mission.state).toBe('COMPLETED');
    expect(retried.runs.map(({ id, attempt, status }) => ({ id, attempt, status }))).toEqual([
      { id: 'run-1', attempt: 1, status: 'INTERRUPTED' },
      { id: 'run-2', attempt: 2, status: 'COMPLETED' },
    ]);
    expect(retried.audits.map((event) => event.action)).toContain('mission.state.interrupted');
  });

  it('does not inject another Teammate memory or unassigned/disabled Skills', async () => {
    const { store, permissionStore, gate1 } = fixture();
    const fake = new FakeModelGateway();
    let captured: Parameters<FakeModelGateway['generate']>[0] | undefined;
    const captureGateway = {
      generate: async (request: Parameters<FakeModelGateway['generate']>[0]) => {
        captured = request;
        return fake.generate(request);
      },
      stream: fake.stream.bind(fake),
      testConnection: fake.testConnection.bind(fake),
    };
    const context: ChatPromptContext = {
      load: async () => {
        const enabledSkill: Skill = {
          id: 'skill-enabled',
          name: 'Enabled',
          description: '',
          instructions: 'Use concise headings.',
          version: '1.0.0',
          tags: [],
          status: 'ACTIVE',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const disabledSkill: Skill = {
          ...enabledSkill,
          id: 'skill-disabled',
          instructions: 'disabled text',
        };
        const memories = [
          activeMemory('memory-own', 'teammate-1', 'OWN_MEMORY_SENTINEL'),
          activeMemory('memory-other', 'teammate-2', 'OTHER_MEMORY_SENTINEL'),
          {
            ...activeMemory('memory-mission', 'mission-1', 'MISSION_MEMORY_SENTINEL'),
            ownerType: 'MISSION',
          },
        ];
        const assignments: SkillAssignment[] = [
          { teammateId: 'teammate-1', skillId: enabledSkill.id, enabled: true },
          { teammateId: 'teammate-1', skillId: disabledSkill.id, enabled: false },
          { teammateId: 'teammate-2', skillId: enabledSkill.id, enabled: true },
        ];
        return {
          relevantMemories: memories as MemoryRecord[],
          skills: [enabledSkill, disabledSkill],
          skillAssignments: assignments,
        };
      },
    };
    const service = new Gate3MissionService(
      store,
      gate1,
      new PermissionEngine(permissionStore),
      captureGateway,
      context,
      new TestClock(),
    );
    const mission = service.create({
      title: 'Scoped context',
      objective: 'Use allowed context only.',
      coordinatorTeammateId: 'teammate-1',
    });
    service.ready(mission.id);
    await service.start({ missionId: mission.id, approvalFixture: false });
    const prompt = captured?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('OWN_MEMORY_SENTINEL');
    expect(prompt).toContain('Use concise headings.');
    expect(prompt).not.toContain('OTHER_MEMORY_SENTINEL');
    expect(prompt).not.toContain('MISSION_MEMORY_SENTINEL');
    expect(prompt).not.toContain('disabled text');
  });
  it('continues the original Run after tool approval and persists a Mission-only grant', async () => {
    const { service, store, permissionStore, teammate, gate1, gateway } = fixture();
    const pending = new InMemoryPendingTools();
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { content: 'file contents' };
    };
    attachFixtureTool(service, permissionStore, pending, execute);
    const mission = service.create({
      title: 'Read one file',
      objective: '__GATE4_TOOL__:{"toolId":"file.readText","input":{"path":"a.txt"}}',
      coordinatorTeammateId: teammate.id,
    });
    service.ready(mission.id);
    const waiting = await service.start({ missionId: mission.id, approvalFixture: false });
    expect(waiting.mission.state).toBe('WAITING_APPROVAL');
    expect(waiting.runs[0]?.status).toBe('RUNNING');
    expect(executions).toBe(0);
    const approval = waiting.approvals[0]!;
    expect(approval.actionType).toBe('TOOL_CALL');
    expect(approval.actionPayload).not.toHaveProperty('input');

    const restarted = new Gate3MissionService(
      store,
      gate1,
      new PermissionEngine(permissionStore),
      gateway,
      undefined,
      new TestClock(),
    );
    attachFixtureTool(restarted, permissionStore, pending, execute);
    expect(restarted.recoverInterrupted()).toEqual([]);
    expect(restarted.detail(mission.id).mission.state).toBe('WAITING_APPROVAL');
    const done = await restarted.resolveApproval({
      approvalId: approval.id,
      decision: 'ALLOW_MISSION',
    });
    expect(done.mission.state).toBe('COMPLETED');
    expect(done.runs).toHaveLength(1);
    expect(done.runs[0]?.id).toBe(waiting.runs[0]?.id);
    expect(executions).toBe(1);
    expect(done.usage).toHaveLength(2);
    expect(
      done.usage.every(
        (row) =>
          row.missionId === mission.id &&
          row.runId === done.runs[0]?.id &&
          row.teammateId === teammate.id,
      ),
    ).toBe(true);
    expect(done.events.map((event) => event.eventType)).toContain('tool.result');
    expect(done.audits.map((event) => event.action)).toContain('tool.result');
    expect(permissionStore.rules).toContainEqual(
      expect.objectContaining({
        scope: 'MISSION',
        scopeId: mission.id,
        capability: 'FILE_READ',
        decision: 'ALLOW',
      }),
    );
    await expect(
      restarted.resolveApproval({ approvalId: approval.id, decision: 'APPROVED' }),
    ).rejects.toThrow('Approval 只能处理一次');

    const other = restarted.create({
      title: 'Other mission',
      objective: '__GATE4_TOOL__:{"toolId":"file.readText","input":{"path":"a.txt"}}',
      coordinatorTeammateId: teammate.id,
    });
    restarted.ready(other.id);
    const otherWaiting = await restarted.start({ missionId: other.id, approvalFixture: false });
    expect(otherWaiting.mission.state).toBe('WAITING_APPROVAL');
    expect(executions).toBe(1);
  });

  it('returns tool denial and failure as structured model input without executing denied work', async () => {
    const { service, permissionStore, teammate } = fixture();
    const pending = new InMemoryPendingTools();
    let executions = 0;
    attachFixtureTool(service, permissionStore, pending, async () => {
      executions += 1;
      throw new Error('secret provider detail');
    });
    const mission = service.create({
      title: 'Denied tool',
      objective: '__GATE4_TOOL__:{"toolId":"file.readText","input":{"path":"a.txt"}}',
      coordinatorTeammateId: teammate.id,
    });
    service.ready(mission.id);
    const waiting = await service.start({ missionId: mission.id, approvalFixture: false });
    const denied = await service.resolveApproval({
      approvalId: waiting.approvals[0]!.id,
      decision: 'DENIED',
    });
    expect(denied.mission.state).toBe('COMPLETED');
    expect(denied.runs[0]?.resultText).toContain('PERMISSION_DENIED');
    expect(executions).toBe(0);

    permissionStore.savePermissionRule({
      id: 'allow-file',
      subjectType: 'TEAMMATE',
      subjectId: teammate.id,
      capability: 'FILE_READ',
      resourcePattern: 'file:a.txt',
      decision: 'ALLOW',
      scope: 'GLOBAL',
      scopeId: null,
    });
    const failing = service.create({
      title: 'Failed tool',
      objective: '__GATE4_TOOL__:{"toolId":"file.readText","input":{"path":"a.txt"}}',
      coordinatorTeammateId: teammate.id,
    });
    service.ready(failing.id);
    const completed = await service.start({ missionId: failing.id, approvalFixture: false });
    expect(completed.mission.state).toBe('COMPLETED');
    expect(completed.runs[0]?.resultText).toContain('TOOL_FAILED');
    expect(JSON.stringify(completed.audits)).not.toContain('secret provider detail');
    expect(executions).toBe(1);
  });

  it('does not execute or grant a tool when its resource changes during approval', async () => {
    const { service, permissionStore, teammate } = fixture();
    const pending = new InMemoryPendingTools();
    let executions = 0;
    const runtime = attachFixtureTool(service, permissionStore, pending, async () => {
      executions += 1;
      return { content: 'changed target' };
    });
    const mission = service.create({
      title: 'Changed workspace',
      objective: '__GATE4_TOOL__:{"toolId":"file.readText","input":{"path":"a.txt"}}',
      coordinatorTeammateId: teammate.id,
    });
    service.ready(mission.id);
    const waiting = await service.start({ missionId: mission.id, approvalFixture: false });
    const original = runtime.registry.get('file.readText')!;
    runtime.registry.unregister('file.readText');
    runtime.registry.register({
      descriptor: original.descriptor,
      resource: () => 'file:different-root:a.txt',
      execute: async () => {
        executions += 1;
        return { content: 'changed target' };
      },
    });
    const done = await service.resolveApproval({
      approvalId: waiting.approvals[0]!.id,
      decision: 'ALLOW_MISSION',
    });
    expect(done.runs[0]?.resultText).toContain('TOOL_CHANGED');
    expect(executions).toBe(0);
    expect(permissionStore.rules).toHaveLength(0);
  });

  it('stops repeating tool calls at the configured step bound', async () => {
    const { service, permissionStore, teammate } = fixture();
    permissionStore.savePermissionRule({
      id: 'allow-file',
      subjectType: 'TEAMMATE',
      subjectId: teammate.id,
      capability: 'FILE_READ',
      resourcePattern: 'file:a.txt',
      decision: 'ALLOW',
      scope: 'GLOBAL',
      scopeId: null,
    });
    let executions = 0;
    attachFixtureTool(service, permissionStore, new InMemoryPendingTools(), async () => {
      executions += 1;
      return { content: 'file contents' };
    });
    const mission = service.create({
      title: 'Loop cap',
      objective: '__GATE4_REPEAT_TOOL__:{"toolId":"file.readText","input":{"path":"a.txt"}}',
      coordinatorTeammateId: teammate.id,
    });
    service.ready(mission.id);
    const detail = await service.start({ missionId: mission.id, approvalFixture: false });
    expect(detail.mission.state).toBe('FAILED');
    expect(detail.runs[0]?.errorCode).toBe('TOOL_LIMIT_REACHED');
    expect(executions).toBeLessThanOrEqual(8);
    expect(detail.usage.length).toBeLessThanOrEqual(8);
  });
});
