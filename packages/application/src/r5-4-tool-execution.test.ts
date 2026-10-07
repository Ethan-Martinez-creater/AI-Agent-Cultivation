import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovalRequest,
  CollaborationRequest,
  Mission,
  ApprovalState,
  AuditEvent,
  MissionEvent,
  UsageRecord,
  PermissionCapability,
  PermissionRule,
  RuntimeProfile,
  Teammate,
  ToolDescriptor,
} from '@cultivation/domain';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { DecisionGateway, DecisionRequest, DecisionResult } from './r0-decision.js';
import type { ModelGateway, ModelToolResponse } from './index.js';
import {
  Gate3MissionService,
  type Gate3MissionStore,
  type MissionClock,
  type MissionRunRecord,
  type PendingMissionToolCall,
  type PendingMissionToolStore,
} from './gate3-mission-service.js';
import {
  Gate5CollaborationService,
  type Gate5CollaborationStore,
  type ParticipantTask,
} from './gate5-collaboration-service.js';
import { PermissionEngine, type PermissionRuleStore } from './permission-engine.js';
import { ToolRegistry, ToolRuntime, type ToolExecutionGuard } from './tool-runtime.js';
import { ToolShortlistService, type ToolShortlistContext } from './r5-4-tool-shortlist.js';

const at = '2026-10-07T00:00:00.000Z';
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: null,
  reasoningTokens: null,
};

type Script = (
  request: Parameters<NonNullable<ModelGateway['generateWithTools']>>[0],
) => ModelToolResponse | Promise<ModelToolResponse>;

class ScriptedGateway extends FakeModelGateway {
  readonly toolRequests: Array<Parameters<NonNullable<ModelGateway['generateWithTools']>>[0]> = [];
  readonly scripts: Script[] = [];
  beforeReturn:
    | ((request: Parameters<NonNullable<ModelGateway['generateWithTools']>>[0]) => void)
    | null = null;

  respond(...responses: ModelToolResponse[]): void {
    this.scripts.push(...responses.map((response) => () => response));
  }

  override async generateWithTools(
    request: Parameters<NonNullable<ModelGateway['generateWithTools']>>[0],
  ): Promise<ModelToolResponse> {
    this.toolRequests.push(structuredClone(request));
    const script = this.scripts.shift();
    const response = script ? await script(request) : await super.generateWithTools(request);
    this.beforeReturn?.(request);
    return response;
  }
}

function modelResponse(
  toolCalls: ModelToolResponse['toolCalls'] = [],
  text = '',
): ModelToolResponse {
  return { text, toolCalls, usage };
}

function descriptor(
  id: string,
  capability: PermissionCapability,
  options: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    id,
    source: options.source ?? 'BUILTIN',
    name: options.name ?? id,
    description: options.description ?? 'R5.4 fixture tool',
    capability,
    riskLevel: options.riskLevel ?? (capability === 'FILE_READ' ? 'READ_ONLY' : 'HIGH'),
    sideEffect: options.sideEffect ?? (capability === 'FILE_READ' ? 'NONE' : 'LOCAL_WRITE'),
    inputSchema: options.inputSchema ?? {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    ...(options.workflowPurposes ? { workflowPurposes: options.workflowPurposes } : {}),
  };
}

class ScoringDecisionGateway implements DecisionGateway {
  readonly requests: DecisionRequest[] = [];

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(structuredClone(request));
    const candidates = (request.state as { candidates?: Array<{ id: string }> }).candidates ?? [];
    return {
      answers: { tools: candidates.map(({ id }) => ({ toolId: id, score: 0.5 })) },
      confidence: {},
      selectedAction: null,
      errorCode: null,
    };
  }
}

class ShortlistHarness {
  readonly contexts: ToolShortlistContext[] = [];
  readonly gateway = new ScoringDecisionGateway();
  policy: (step: number, context: ToolShortlistContext) => string[] = () =>
    this.registry.list().map((tool) => tool.id);
  readonly service: ToolShortlistService;

  constructor(private readonly registry: ToolRegistry) {
    this.service = new ToolShortlistService(registry, async () => this.gateway);
  }

  contextFor(context: ToolShortlistContext): ToolShortlistContext {
    const step = this.contexts.length;
    const transformed: ToolShortlistContext = {
      ...context,
      workflow: {
        ...context.workflow,
        toolIds: this.policy(step, context),
      },
    };
    this.contexts.push(structuredClone(transformed));
    return transformed;
  }
}
class MemoryPermissionStore implements PermissionRuleStore {
  readonly rules: PermissionRule[] = [];

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

function permissionRule(
  teammateId: string,
  capability: PermissionCapability,
  decision: PermissionRule['decision'],
): PermissionRule {
  return {
    id: 'rule-' + teammateId + '-' + capability + '-' + decision,
    subjectType: 'TEAMMATE',
    subjectId: teammateId,
    capability,
    resourcePattern: 'fixture:resource',
    decision,
    scope: 'GLOBAL',
    scopeId: null,
  };
}

function registerTool(
  registry: ToolRegistry,
  toolDescriptor: ToolDescriptor,
  execute: () => Promise<{ content: string }>,
  resource = 'fixture:resource',
) {
  registry.register({
    descriptor: toolDescriptor,
    resource: () => resource,
    execute,
  });
}

const capabilityCases = [
  {
    label: 'read',
    id: 'fixture.read',
    capability: 'FILE_READ',
    sideEffect: 'NONE',
    source: 'BUILTIN',
  },
  {
    label: 'write',
    id: 'fixture.write',
    capability: 'FILE_WRITE',
    sideEffect: 'LOCAL_WRITE',
    source: 'BUILTIN',
  },
  {
    label: 'MCP process execution',
    id: 'fixture.mcp',
    capability: 'MCP_TOOL_EXECUTE',
    sideEffect: 'PROCESS_EXECUTION',
    source: 'MCP',
  },
  {
    label: 'command execution',
    id: 'fixture.command',
    capability: 'EXECUTE_COMMAND',
    sideEffect: 'PROCESS_EXECUTION',
    source: 'BUILTIN',
  },
] as const;

describe('R5.4 Tool execution boundary', () => {
  it.each(capabilityCases)('DENY blocks $label even after approval', async (item) => {
    const permissions = new MemoryPermissionStore();
    permissions.savePermissionRule(permissionRule('actor', item.capability, 'DENY'));
    const engine = new PermissionEngine(permissions);
    const evaluate = vi.spyOn(engine, 'evaluate');
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    const guard: ToolExecutionGuard = {
      before: vi.fn(async () => null),
      after: vi.fn(async () => {}),
    };
    registerTool(
      registry,
      descriptor(item.id, item.capability, {
        source: item.source,
        sideEffect: item.sideEffect,
      }),
      execute,
    );
    const runtime = new ToolRuntime(registry, engine, guard);

    const result = await runtime.dispatch(
      { id: 'call-deny', toolId: item.id, input: { value: 'x' } },
      { missionId: 'mission', runId: 'run', teammateId: 'actor' },
      true,
    );

    expect(result).toMatchObject({ kind: 'RESULT', result: { code: 'PERMISSION_DENIED' } });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(guard.before).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(capabilityCases)('ASK holds $label until one explicit approval', async (item) => {
    const engine = new PermissionEngine(new MemoryPermissionStore());
    const evaluate = vi.spyOn(engine, 'evaluate');
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ content: 'executed once' }));
    const guard: ToolExecutionGuard = {
      before: vi.fn(async () => null),
      after: vi.fn(async () => {}),
    };
    registerTool(
      registry,
      descriptor(item.id, item.capability, {
        source: item.source,
        sideEffect: item.sideEffect,
      }),
      execute,
    );
    const runtime = new ToolRuntime(registry, engine, guard);
    const context = { missionId: 'mission', runId: 'run', teammateId: 'actor' };
    const call = { id: 'call-ask', toolId: item.id, input: { value: 'x' } };

    expect(await runtime.dispatch(call, context)).toMatchObject({ kind: 'APPROVAL' });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(guard.before).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await runtime.dispatch(call, context, true)).toMatchObject({
      kind: 'RESULT',
      result: { ok: true, content: 'executed once' },
    });
    expect(guard.before).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid schema before permission, guard, or execution', async () => {
    const engine = new PermissionEngine(new MemoryPermissionStore());
    const evaluate = vi.spyOn(engine, 'evaluate');
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    const guard: ToolExecutionGuard = {
      before: vi.fn(async () => null),
      after: vi.fn(async () => {}),
    };
    registerTool(registry, descriptor('fixture.read', 'FILE_READ'), execute);
    const result = await new ToolRuntime(registry, engine, guard).dispatch(
      { id: 'bad-schema', toolId: 'fixture.read', input: {} },
      { missionId: 'mission', runId: 'run', teammateId: 'actor' },
    );

    expect(result).toMatchObject({ kind: 'RESULT', result: { code: 'INPUT_INVALID' } });
    expect(evaluate).not.toHaveBeenCalled();
    expect(guard.before).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

class MemoryMissionStore {
  readonly missions = new Map<string, Mission>();
  readonly runs = new Map<string, MissionRunRecord>();
  readonly approvals = new Map<string, ApprovalRequest>();
  readonly events: MissionEvent[] = [];
  readonly audits: AuditEvent[] = [];
  readonly usageRecords: UsageRecord[] = [];
  private runSequence = 0;

  listMissions() {
    return [...this.missions.values()];
  }
  getMission(id: string) {
    return this.missions.get(id) ?? null;
  }
  insertMission(value: Mission) {
    this.missions.set(value.id, value);
  }
  updateMissionDetails(value: Mission) {
    this.missions.set(value.id, value);
    return true;
  }
  transitionMission(value: Mission, expected: string) {
    if (this.missions.get(value.id)?.state !== expected) return false;
    this.missions.set(value.id, value);
    return true;
  }
  listRunningMissions() {
    return this.listMissions().filter((item) => item.state === 'RUNNING');
  }
  listRuns(missionId: string) {
    return [...this.runs.values()].filter((run) => run.missionId === missionId);
  }
  getRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  createRun(missionId: string, startedAt: string): MissionRunRecord {
    const run: MissionRunRecord = {
      id: 'run-' + ++this.runSequence,
      missionId,
      attempt: 1,
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
  finishRun(value: MissionRunRecord) {
    this.runs.set(value.id, value);
    return true;
  }
  insertApproval(value: ApprovalRequest) {
    this.approvals.set(value.id, value);
  }
  getApproval(id: string) {
    return this.approvals.get(id) ?? null;
  }
  listApprovals(missionId: string) {
    return [...this.approvals.values()].filter((item) => item.missionId === missionId);
  }
  resolveApproval(
    id: string,
    decision: Extract<ApprovalState, 'APPROVED' | 'DENIED' | 'CANCELLED'>,
    atTime: string,
  ) {
    const current = this.approvals.get(id);
    if (!current || current.state !== 'PENDING') return null;
    const next = { ...current, state: decision, resolvedAt: atTime };
    this.approvals.set(id, next);
    return next;
  }
  listMissionEvents(missionId: string) {
    return this.events.filter((event) => event.missionId === missionId);
  }
  appendMissionEvent(value: MissionEvent) {
    this.events.push(value);
  }
  listAuditEvents(missionId: string) {
    return this.audits.filter((event) => event.targetId === missionId);
  }
  appendAuditEvent(value: AuditEvent) {
    this.audits.push(value);
  }
  listMissionUsage(missionId: string) {
    return this.usageRecords.filter((record) => record.missionId === missionId);
  }
  saveUsage(value: UsageRecord) {
    this.usageRecords.push(value);
  }
  transaction<T>(operation: () => T): T {
    return operation();
  }
}

class MemoryPendingTools implements PendingMissionToolStore {
  readonly calls = new Map<string, PendingMissionToolCall>();
  savePendingToolCall(value: PendingMissionToolCall) {
    this.calls.set(value.approvalId, value);
  }
  getPendingToolCall(id: string) {
    return this.calls.get(id) ?? null;
  }
  resolvePendingToolCall(id: string, resolvedAt: string) {
    const current = this.calls.get(id);
    if (!current || current.state !== 'PENDING') return null;
    const value = { ...current, state: 'RESOLVED' as const, resolvedAt };
    this.calls.set(id, value);
    return value;
  }
}

class TestClock implements MissionClock {
  private sequence = 0;
  now() {
    return at;
  }
  newId() {
    return 'id-' + ++this.sequence;
  }
}

function teammate(id: string, runtimeId: string): Teammate {
  return {
    id,
    name: id,
    avatar: null,
    title: null,
    description: '',
    identityPrompt: 'fixture',
    behaviorPrompt: '',
    status: 'ACTIVE',
    realm: 'QI_REFINING',
    executorKind: 'MODEL_RUNTIME',
    routingPolicy: 'NORMAL',
    systemKind: null,
    currentRuntimeProfileId: runtimeId,
    createdAt: at,
    updatedAt: at,
  };
}

function runtimeProfile(id: string): RuntimeProfile {
  return {
    id,
    name: id,
    providerId: 'provider-' + id,
    credentialId: null,
    modelId: 'model-' + id,
    parameters: {},
    capabilityOverrides: {},
    createdAt: at,
    updatedAt: at,
  };
}

function gate3Fixture() {
  const store = new MemoryMissionStore();
  const rules = new MemoryPermissionStore();
  const permissions = new PermissionEngine(rules);
  const evaluate = vi.spyOn(permissions, 'evaluate');
  const actor = teammate('gate3-actor', 'runtime-gate3');
  const profile = runtimeProfile(actor.currentRuntimeProfileId!);
  const gate1 = {
    getTeammate: (id: string) => (id === actor.id ? actor : null),
    getRuntimeProfile: (id: string) => (id === profile.id ? profile : null),
  };
  const gateway = new ScriptedGateway();
  const service = new Gate3MissionService(
    store as unknown as Gate3MissionStore,
    gate1 as never,
    permissions,
    gateway,
    undefined,
    new TestClock(),
  );
  const registry = new ToolRegistry();
  const executions = new Map<string, ReturnType<typeof vi.fn>>();
  for (const item of capabilityCases) {
    const execute = vi.fn(async () => ({ content: 'executed ' + item.id }));
    executions.set(item.id, execute);
    registerTool(
      registry,
      descriptor(item.id, item.capability, {
        source: item.source,
        sideEffect: item.sideEffect,
      }),
      execute,
    );
  }
  const guard: ToolExecutionGuard = {
    before: vi.fn(async () => null),
    after: vi.fn(async () => {}),
  };
  const runtime = new ToolRuntime(registry, permissions, guard);
  const pending = new MemoryPendingTools();
  service.attachTools(runtime, pending);
  const shortlist = new ShortlistHarness(registry);
  service.attachToolShortlist(shortlist.service, shortlist.contextFor.bind(shortlist));
  return {
    store,
    rules,
    permissions,
    evaluate,
    actor,
    profile,
    gate1,
    gateway,
    service,
    registry,
    executions,
    guard,
    runtime,
    pending,
    shortlist,
  };
}

function startGate3(h: ReturnType<typeof gate3Fixture>, objective = 'R5.4 shortlist fixture') {
  const mission = h.service.create({
    title: 'Tool shortlist',
    objective,
    coordinatorTeammateId: h.actor.id,
  });
  h.service.ready(mission.id);
  return h.service.start({ missionId: mission.id, approvalFixture: false });
}

describe('Gate 3 offered-set enforcement', () => {
  it('returns TOOL_NOT_OFFERED without permission evaluation, approval, guard, or execution', async () => {
    const h = gate3Fixture();
    h.shortlist.policy = () => ['fixture.read'];
    h.gateway.respond(
      modelResponse([{ id: 'not-offered', toolId: 'fixture.write', input: { value: 'x' } }]),
      modelResponse([], 'continued safely'),
    );

    const detail = await startGate3(h);

    expect(detail.mission.state).toBe('COMPLETED');
    expect(h.gateway.toolRequests.map((request) => request.tools.map((tool) => tool.id))).toEqual([
      ['fixture.read'],
      ['fixture.read'],
    ]);
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.guard.before).not.toHaveBeenCalled();
    expect(h.executions.get('fixture.write')).not.toHaveBeenCalled();
    expect(detail.approvals).toEqual([]);
    expect(h.pending.calls.size).toBe(0);
    expect(
      h.store.events.find((event) => event.eventType === 'tool.result')?.payloadJson.code,
    ).toBe('TOOL_NOT_OFFERED');
  });

  it('blocks a descriptor changed while the model request was in flight', async () => {
    const h = gate3Fixture();
    h.shortlist.policy = () => ['fixture.read'];
    h.gateway.respond(
      modelResponse([{ id: 'stale-offer', toolId: 'fixture.read', input: { value: 'x' } }]),
      modelResponse([], 'continued safely'),
    );
    let changed = false;
    h.gateway.beforeReturn = () => {
      if (changed) return;
      changed = true;
      h.registry.get('fixture.read')!.descriptor.description = 'changed during model call';
    };

    const detail = await startGate3(h);

    expect(detail.mission.state).toBe('COMPLETED');
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.guard.before).not.toHaveBeenCalled();
    expect(h.executions.get('fixture.read')).not.toHaveBeenCalled();
    expect(detail.approvals).toEqual([]);
    expect(
      h.store.events.find((event) => event.eventType === 'tool.result')?.payloadJson.code,
    ).toBe('TOOL_CHANGED');
  });

  it('revalidates schema before permission and execution for an offered call', async () => {
    const h = gate3Fixture();
    h.shortlist.policy = () => ['fixture.read'];
    h.gateway.respond(
      modelResponse([{ id: 'bad-input', toolId: 'fixture.read', input: {} }]),
      modelResponse([], 'continued safely'),
    );

    const detail = await startGate3(h);

    expect(detail.mission.state).toBe('COMPLETED');
    expect(h.gateway.toolRequests[0]?.tools.map((tool) => tool.id)).toEqual(['fixture.read']);
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.guard.before).not.toHaveBeenCalled();
    expect(h.executions.get('fixture.read')).not.toHaveBeenCalled();
    expect(detail.approvals).toEqual([]);
    expect(
      h.store.events.find((event) => event.eventType === 'tool.result')?.payloadJson.code,
    ).toBe('INPUT_INVALID');
  });

  it('takes a fresh shortlist on every model step, including an empty next offer', async () => {
    const h = gate3Fixture();
    h.shortlist.policy = (step) => (step === 0 ? ['fixture.read'] : []);
    h.rules.savePermissionRule(permissionRule(h.actor.id, 'FILE_READ', 'ALLOW'));
    h.gateway.respond(
      modelResponse([{ id: 'first', toolId: 'fixture.read', input: { value: 'one' } }]),
      modelResponse([{ id: 'second', toolId: 'fixture.read', input: { value: 'two' } }]),
      modelResponse([], 'finished'),
    );

    const detail = await startGate3(h);

    expect(detail.mission.state).toBe('COMPLETED');
    expect(h.gateway.toolRequests.map((request) => request.tools.map((tool) => tool.id))).toEqual([
      ['fixture.read'],
      [],
      [],
    ]);
    expect(h.shortlist.contexts).toHaveLength(3);
    expect(h.executions.get('fixture.read')).toHaveBeenCalledTimes(1);
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(h.pending.calls.size).toBe(0);
    expect(
      h.store.events
        .filter((event) => event.eventType === 'tool.result')
        .map((event) => event.payloadJson.code),
    ).toEqual(['OK', 'TOOL_NOT_OFFERED']);
  });

  it('resumes the original ASK call after restart once with its matched native transcript', async () => {
    const h = gate3Fixture();
    h.shortlist.policy = () => ['fixture.read'];
    h.gateway.respond(
      modelResponse([{ id: 'original-call', toolId: 'fixture.read', input: { value: 'x' } }]),
      modelResponse([], 'resumed answer'),
    );
    const waiting = await startGate3(h);
    const approval = waiting.approvals[0]!;
    expect(waiting.mission.state).toBe('WAITING_APPROVAL');
    expect(h.executions.get('fixture.read')).not.toHaveBeenCalled();

    const restarted = new Gate3MissionService(
      h.store as unknown as Gate3MissionStore,
      h.gate1 as never,
      h.permissions,
      h.gateway,
      undefined,
      new TestClock(),
    );
    restarted.attachTools(h.runtime, h.pending);
    restarted.attachToolShortlist(h.shortlist.service, h.shortlist.contextFor.bind(h.shortlist));
    expect(restarted.recoverInterrupted()).toEqual([]);
    const completed = await restarted.resolveApproval({
      approvalId: approval.id,
      decision: 'APPROVED',
    });

    expect(completed.mission.state).toBe('COMPLETED');
    expect(completed.runs[0]?.id).toBe(waiting.runs[0]?.id);
    expect(h.executions.get('fixture.read')).toHaveBeenCalledTimes(1);
    const resumed = h.gateway.toolRequests.at(-1)!.messages;
    const calls = resumed.flatMap((message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === 'tool-call')
        : [],
    );
    const results = resumed.flatMap((message) =>
      message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : [],
    );
    expect(calls.map((part) => part.toolCallId)).toEqual(['original-call']);
    expect(results.map((part) => part.toolCallId)).toEqual(['original-call']);
    expect(h.pending.calls.get(approval.id)?.state).toBe('RESOLVED');
    await expect(
      restarted.resolveApproval({ approvalId: approval.id, decision: 'APPROVED' }),
    ).rejects.toThrow();
    expect(h.executions.get('fixture.read')).toHaveBeenCalledTimes(1);
  });

  it('does not grant or dispatch an approved continuation after its offer fingerprint changes', async () => {
    const h = gate3Fixture();
    h.shortlist.policy = () => ['fixture.read'];
    h.gateway.respond(
      modelResponse([{ id: 'changed-after-ask', toolId: 'fixture.read', input: { value: 'x' } }]),
    );
    const waiting = await startGate3(h);
    const approval = waiting.approvals[0]!;
    h.registry.get('fixture.read')!.descriptor.sideEffect = 'EXTERNAL_WRITE';

    const completed = await h.service.resolveApproval({
      approvalId: approval.id,
      decision: 'ALLOW_MISSION',
    });

    expect(completed.runs[0]?.resultText).toContain('TOOL_CHANGED');
    expect(h.executions.get('fixture.read')).not.toHaveBeenCalled();
    expect(h.rules.rules).toEqual([]);
  });
});

function gate5ParticipantFixture() {
  const store = new MemoryMissionStore();
  const rules = new MemoryPermissionStore();
  const permissions = new PermissionEngine(rules);
  const evaluate = vi.spyOn(permissions, 'evaluate');
  const actorA = teammate('party-coordinator', 'runtime-a');
  const actorB = teammate('party-member', 'runtime-b');
  const profileB = runtimeProfile('runtime-b');
  const teammateMap = new Map<string, Teammate>([
    [actorA.id, actorA],
    [actorB.id, actorB],
  ]);
  const teammateStore = {
    getTeammate: (id: string) => teammateMap.get(id) ?? null,
    getRuntimeProfile: (id: string) => (id === profileB.id ? profileB : null),
  };
  const missionId = 'party-mission';
  const mission = {
    id: missionId,
    title: 'Party tool call',
    objective: 'Read the fixture as the participant.',
    mode: 'CONSULTATION',
    state: 'RUNNING',
    partyId: 'party-1',
    coordinatorTeammateId: actorA.id,
    updatedAt: at,
  } as unknown as Mission;
  const run: MissionRunRecord = {
    id: 'party-run',
    missionId,
    attempt: 1,
    status: 'RUNNING',
    startedAt: at,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
    resultText: null,
  };
  store.missions.set(missionId, mission);
  store.runs.set(run.id, run);
  const approvedRequest = {
    id: 'approved-member-request',
    missionId,
    requesterTeammateId: actorA.id,
    targetTeammateId: actorB.id,
    state: 'APPROVED',
  } as unknown as CollaborationRequest;
  const gate5Store = {
    getCollaborationRequest: (id: string) => (id === approvedRequest.id ? approvedRequest : null),
  } as unknown as Gate5CollaborationStore;
  const gateway = new ScriptedGateway();
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => ({ content: 'read as party member' }));
  registerTool(registry, descriptor('fixture.party.read', 'FILE_READ'), execute);
  rules.savePermissionRule(permissionRule(actorB.id, 'FILE_READ', 'ALLOW'));
  const guard: ToolExecutionGuard = {
    before: vi.fn(async () => null),
    after: vi.fn(async () => {}),
  };
  const runtime = new ToolRuntime(registry, permissions, guard);
  const shortlist = new ShortlistHarness(registry);
  const service = new Gate5CollaborationService(
    store as unknown as Gate3MissionStore,
    gate5Store,
    {} as never,
    teammateStore as never,
    permissions,
    gateway,
    undefined,
    runtime,
    new TestClock(),
  );
  service.attachToolShortlist(shortlist.service, shortlist.contextFor.bind(shortlist));
  const task: ParticipantTask = {
    phase: 'PARTICIPANT',
    teammateId: actorB.id,
    task: 'Read the fixture.',
    artifactKind: 'MEMBER_RESULT',
    requestId: approvedRequest.id,
  };
  const executeParticipant = (
    service as unknown as {
      executeParticipant(
        mission: Mission,
        run: MissionRunRecord,
        task: ParticipantTask,
      ): Promise<{ kind: string; text?: string }>;
    }
  ).executeParticipant.bind(service);
  return {
    store,
    mission,
    run,
    task,
    actorB,
    gateway,
    shortlist,
    evaluate,
    guard,
    execute,
    executeParticipant,
  };
}

describe('Gate 5 Party shortlist actor', () => {
  it('uses the actual participant as the shortlist and Permission actor', async () => {
    const h = gate5ParticipantFixture();
    h.gateway.respond(
      modelResponse([
        { id: 'member-tool-call', toolId: 'fixture.party.read', input: { value: 'x' } },
      ]),
      modelResponse([], 'participant finished'),
    );

    const outcome = await h.executeParticipant(h.mission, h.run, h.task);

    expect(outcome).toMatchObject({ kind: 'DONE', text: 'participant finished' });
    expect(h.gateway.toolRequests[0]?.teammateId).toBe(h.actorB.id);
    expect(h.shortlist.gateway.requests[0]?.state).toMatchObject({
      context: { actorId: h.actorB.id },
    });
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(h.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'TEAMMATE',
        subjectId: h.actorB.id,
        teammateId: h.actorB.id,
        missionId: h.mission.id,
        capability: 'FILE_READ',
        resource: 'fixture:resource',
      }),
    );
    expect(h.guard.before).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(
      h.store.events.find((event) => event.eventType === 'tool.result')?.payloadJson,
    ).toMatchObject({
      teammateId: h.actorB.id,
      code: 'OK',
    });
  });

  it('rejects a registered but unoffered tool before Permission, approval, guard, or execution', async () => {
    const h = gate5ParticipantFixture();
    h.shortlist.policy = () => [];
    h.gateway.respond(
      modelResponse([
        { id: 'member-unoffered', toolId: 'fixture.party.read', input: { value: 'x' } },
      ]),
      modelResponse([], 'participant continued safely'),
    );

    const outcome = await h.executeParticipant(h.mission, h.run, h.task);

    expect(outcome).toMatchObject({ kind: 'DONE', text: 'participant continued safely' });
    expect(h.gateway.toolRequests[0]?.tools).toEqual([]);
    expect(h.evaluate).not.toHaveBeenCalled();
    expect(h.guard.before).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.store.approvals.size).toBe(0);
    expect(
      h.store.events.find((event) => event.eventType === 'tool.result')?.payloadJson,
    ).toMatchObject({
      teammateId: h.actorB.id,
      code: 'TOOL_NOT_OFFERED',
    });
  });
});
