import { describe, expect, it } from 'vitest';
import type {
  CapabilityDimension,
  CapabilityEvidence,
  AuditEvent,
  ExternalAppProfile,
  ExternalWorkArtifact,
  Mission,
  MissionEvent,
  MissionParticipant,
  MissionRun,
  Teammate,
  TeammateCapabilityState,
} from '@cultivation/domain';
import {
  ExternalWorkService,
  HumanBridgeService,
  HUMAN_BRIDGE_SYSTEM_ID,
  type ExternalWorkRequestRecord,
  type R2HumanBridgeServiceStore,
  type ValidatedWorkspaceArtifact,
  type WorkspaceArtifactConstraints,
  type WorkspaceArtifactValidator,
} from './r2-human-bridge-service.js';

const at = '2026-09-28T00:00:00.000Z';

class MemoryStore implements R2HumanBridgeServiceStore {
  bridge: Teammate | null = null;
  bridgeCreationCount = 0;
  missions = new Map<string, Mission>();
  runs = new Map<string, MissionRun[]>();
  participants = new Map<string, MissionParticipant[]>();
  capabilities = new Map<
    string,
    Map<CapabilityDimension, { enabled: boolean; updatedAt: string }>
  >();
  states = new Map<string, TeammateCapabilityState[]>();
  evidence: CapabilityEvidence[] = [];
  requests = new Map<string, ExternalWorkRequestRecord>();
  artifacts: ExternalWorkArtifact[] = [];
  missionEvents: MissionEvent[] = [];
  auditEvents: AuditEvent[] = [];
  apps = new Map<string, ExternalAppProfile>();
  private idNumber = 0;

  ensureHumanBridgeTeammate(input: { id: string; createdAt: string; updatedAt: string }): Teammate {
    if (!this.bridge) {
      this.bridgeCreationCount += 1;
      this.bridge = {
        id: input.id,
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
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
    }
    return { ...this.bridge };
  }

  updateHumanBridgeDisplay(
    teammateId: string,
    value: {
      name: string;
      avatar: string | null;
      title: string | null;
      description: string;
      updatedAt: string;
    },
  ): Teammate | null {
    if (!this.bridge || this.bridge.id !== teammateId) return null;
    this.bridge = { ...this.bridge, ...value };
    return { ...this.bridge };
  }

  listHumanBridgeCapabilities(teammateId: string) {
    return [...(this.capabilities.get(teammateId) ?? new Map()).entries()].map(
      ([dimension, setting]) => ({ teammateId, dimension, ...setting }),
    );
  }

  saveHumanBridgeCapability(value: {
    teammateId: string;
    dimension: CapabilityDimension;
    enabled: boolean;
    updatedAt: string;
  }): void {
    const settings = this.capabilities.get(value.teammateId) ?? new Map();
    settings.set(value.dimension, { enabled: value.enabled, updatedAt: value.updatedAt });
    this.capabilities.set(value.teammateId, settings);
  }

  listTeammateCapabilityStates(teammateId: string): TeammateCapabilityState[] {
    return [...(this.states.get(teammateId) ?? [])];
  }

  replaceTeammateCapabilityStates(
    teammateId: string,
    states: readonly TeammateCapabilityState[],
  ): void {
    this.states.set(
      teammateId,
      states.map((state) => ({ ...state })),
    );
  }

  listCapabilityEvidence(
    teammateId: string,
    dimension?: CapabilityDimension,
  ): CapabilityEvidence[] {
    return this.evidence.filter(
      (entry) =>
        entry.teammateId === teammateId &&
        (dimension === undefined || entry.dimension === dimension),
    );
  }

  appendCapabilityEvidenceBatch(values: readonly CapabilityEvidence[]): void {
    this.evidence.push(...values.map((value) => ({ ...value })));
  }

  saveExternalAppProfile(value: ExternalAppProfile): void {
    this.apps.set(value.id, { ...value, capabilities: [...value.capabilities] });
  }

  listExternalAppProfiles(teammateId: string): ExternalAppProfile[] {
    return [...this.apps.values()]
      .filter((profile) => profile.teammateId === teammateId)
      .map((profile) => ({ ...profile, capabilities: [...profile.capabilities] }));
  }

  createExternalWorkRequest(value: ExternalWorkRequestRecord): ExternalWorkRequestRecord {
    if (this.requests.has(value.id)) throw new Error('duplicate request');
    this.requests.set(value.id, cloneRequest(value));
    return cloneRequest(value);
  }

  getExternalWorkRequest(id: string): ExternalWorkRequestRecord | null {
    const request = this.requests.get(id);
    return request ? cloneRequest(request) : null;
  }

  listExternalWorkRequests(missionId?: string, runId?: string): ExternalWorkRequestRecord[] {
    return [...this.requests.values()]
      .filter((request) => missionId === undefined || request.missionId === missionId)
      .filter((request) => runId === undefined || request.runId === runId)
      .map(cloneRequest);
  }

  transitionExternalWorkRequest(
    id: string,
    state: ExternalWorkRequestRecord['state'],
    atTime: string,
    publicResult?: string | null,
  ): ExternalWorkRequestRecord | null {
    const current = this.requests.get(id);
    if (!current) return null;
    const valid: Record<ExternalWorkRequestRecord['state'], ExternalWorkRequestRecord['state'][]> =
      {
        PENDING: ['IN_PROGRESS', 'CANCELLED'],
        IN_PROGRESS: ['SUBMITTED', 'CANCELLED'],
        SUBMITTED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
        ACCEPTED: [],
        REJECTED: ['IN_PROGRESS', 'CANCELLED'],
        CANCELLED: [],
      };
    if (!valid[current.state].includes(state))
      throw new Error(`invalid request state ${current.state} -> ${state}`);
    const next = {
      ...current,
      state,
      submittedAt: state === 'SUBMITTED' ? atTime : state === 'IN_PROGRESS' && current.state === 'REJECTED' ? null : current.submittedAt,
      resolvedAt: ['ACCEPTED', 'REJECTED', 'CANCELLED'].includes(state)
        ? atTime
        : state === 'IN_PROGRESS' && current.state === 'REJECTED' ? null : current.resolvedAt,
      publicResult: state === 'ACCEPTED' ? (publicResult ?? null) : null,
    };
    this.requests.set(id, next);
    return cloneRequest(next);
  }

  appendExternalWorkArtifact(value: ExternalWorkArtifact): void {
    const request = this.requests.get(value.externalWorkRequestId);
    if (!request) throw new Error('artifact request missing');
    if (request.state !== 'SUBMITTED' || request.submittedAt !== value.submittedAt) {
      throw new Error('artifact must match the submitted request timestamp');
    }
    this.artifacts.push({ ...value, metadataJson: { ...value.metadataJson } });
  }

  listExternalWorkArtifacts(requestId: string): ExternalWorkArtifact[] {
    return this.artifacts
      .filter((artifact) => artifact.externalWorkRequestId === requestId)
      .map((artifact) => ({ ...artifact, metadataJson: { ...artifact.metadataJson } }));
  }

  getMission(id: string): Mission | null {
    const mission = this.missions.get(id);
    return mission ? { ...mission } : null;
  }

  listRuns(missionId: string): MissionRun[] {
    return (this.runs.get(missionId) ?? []).map((run) => ({ ...run }));
  }

  listMissionParticipants(missionId: string): MissionParticipant[] {
    return (this.participants.get(missionId) ?? []).map((participant) => ({ ...participant }));
  }

  transitionMission(next: Mission, expectedState: Mission['state']): boolean {
    const current = this.missions.get(next.id);
    if (!current || current.state !== expectedState) return false;
    this.missions.set(next.id, { ...next });
    return true;
  }

  appendMissionEvent(event: MissionEvent): void {
    this.missionEvents.push({ ...event, payloadJson: { ...event.payloadJson } });
  }

  appendAuditEvent(event: AuditEvent): void {
    this.auditEvents.push({ ...event, payloadJson: { ...event.payloadJson } });
  }

  transaction<T>(fn: () => T): T {
    const snapshot = {
      bridge: this.bridge ? { ...this.bridge } : null,
      capabilities: new Map([...this.capabilities].map(([id, values]) => [id, new Map(values)])),
      states: new Map(
        [...this.states].map(([id, values]) => [id, values.map((value) => ({ ...value }))]),
      ),
      evidence: this.evidence.map((value) => ({ ...value })),
      requests: new Map([...this.requests].map(([id, value]) => [id, cloneRequest(value)])),
      artifacts: this.artifacts.map((value) => ({
        ...value,
        metadataJson: { ...value.metadataJson },
      })),
      missionEvents: this.missionEvents.map((value) => ({
        ...value,
        payloadJson: { ...value.payloadJson },
      })),
      auditEvents: this.auditEvents.map((value) => ({
        ...value,
        payloadJson: { ...value.payloadJson },
      })),
      missions: new Map([...this.missions].map(([id, value]) => [id, { ...value }])),
    };
    try {
      return fn();
    } catch (error) {
      this.bridge = snapshot.bridge;
      this.capabilities = snapshot.capabilities;
      this.states = snapshot.states;
      this.evidence = snapshot.evidence;
      this.requests = snapshot.requests;
      this.artifacts = snapshot.artifacts;
      this.missionEvents = snapshot.missionEvents;
      this.auditEvents = snapshot.auditEvents;
      this.missions = snapshot.missions;
      throw error;
    }
  }

  nextId(): string {
    this.idNumber += 1;
    return `generated-${this.idNumber}`;
  }
}

class FakeWorkspaceValidator implements WorkspaceArtifactValidator {
  readonly calls: { path: string; constraints: WorkspaceArtifactConstraints }[] = [];
  readonly facts = new Map<string, ValidatedWorkspaceArtifact>();
  readonly failures = new Map<string, Error>();

  async validateArtifact(
    relativePath: string,
    constraints: WorkspaceArtifactConstraints,
  ): Promise<ValidatedWorkspaceArtifact> {
    this.calls.push({ path: relativePath, constraints });
    const failure = this.failures.get(relativePath);
    if (failure) throw failure;
    const value = this.facts.get(relativePath);
    if (!value) throw new Error('Workspace artifact was not found');
    return { ...value };
  }
}

function setup() {
  const store = new MemoryStore();
  store.missions.set('mission-1', {
    id: 'mission-1',
    title: 'Create a cover',
    objective: 'Create a cover image',
    initiatorType: 'TEAMMATE',
    initiatorId: 'coordinator',
    coordinatorTeammateId: 'coordinator',
    partyId: 'party-1',
    mode: 'DELEGATION',
    state: 'RUNNING',
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  });
  store.runs.set('mission-1', [
    {
      id: 'run-1',
      missionId: 'mission-1',
      attempt: 1,
      status: 'RUNNING',
      startedAt: at,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
      resultText: null,
    },
  ]);
  store.participants.set('mission-1', [
    { missionId: 'mission-1', teammateId: 'coordinator', role: 'COORDINATOR', sortOrder: 0 },
  ]);
  const clock = { now: () => at, newId: () => store.nextId() };
  const bridge = new HumanBridgeService(store, clock);
  const workspace = new FakeWorkspaceValidator();
  const externalWork = new ExternalWorkService(store, workspace, clock);
  return { store, bridge, externalWork, workspace };
}

function createInput() {
  return {
    missionId: 'mission-1',
    runId: 'run-1',
    requesterTeammateId: 'coordinator',
    capability: 'IMAGE_GENERATION' as const,
    title: 'Create cover art',
    prompt: 'Generate a clean 16:9 cover with a blue mountain silhouette.',
    requirements: ['Use a 16:9 composition', 'Use a blue mountain silhouette'],
    targetArtifacts: [
      {
        id: 'cover',
        name: 'Cover image',
        required: true,
        allowedExtensions: ['.png'],
        maxSizeBytes: 1_024,
      },
    ],
    targetWorkspacePaths: ['mission-output'],
    acceptanceCriteria: ['Image is 16:9', 'No visible watermark'],
  };
}

async function submittedRequest(
  externalWork: ExternalWorkService,
  workspace: FakeWorkspaceValidator,
  path = 'mission-output/cover.png',
): Promise<ExternalWorkRequestRecord> {
  const request = externalWork.createExplicit(createInput());
  externalWork.markInProgress(request.id);
  workspace.facts.set(path, {
    relativePath: path,
    fileName: path.split('/').at(-1)!,
    extension: '.png',
    sizeBytes: 512,
  });
  return externalWork.submitArtifacts({
    requestId: request.id,
    artifacts: [{ targetArtifactId: 'cover', relativePath: path }],
  });
}

function cloneRequest(value: ExternalWorkRequestRecord): ExternalWorkRequestRecord {
  return {
    ...value,
    requirementsJson: { ...value.requirementsJson },
    targetArtifactsJson: { ...value.targetArtifactsJson },
    acceptanceCriteriaJson: { ...value.acceptanceCriteriaJson },
    targetWorkspacePathsJson: { items: [...value.targetWorkspacePathsJson.items] },
  };
}

describe('R2 Human Bridge application services', () => {
  it('bootstraps one immutable USER_BRIDGE with no Runtime and exposes the explicit prior', () => {
    const { store, bridge } = setup();
    const first = bridge.bootstrap();
    const second = bridge.bootstrap();

    expect(store.bridgeCreationCount).toBe(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      id: HUMAN_BRIDGE_SYSTEM_ID,
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
      currentRuntimeProfileId: null,
    });

    const enabled = bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    expect(enabled.dimensions.find((item) => item.dimension === 'IMAGE_GENERATION')).toMatchObject({
      enabled: true,
      priorScore: 1,
      currentScore: 1,
      source: 'HUMAN_BRIDGE_EXPLICIT_PRIOR',
      ratingCount: 0,
    });
    expect(store.listTeammateCapabilityStates(first.id)).toHaveLength(1);
    const disabled = bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: false });
    expect(disabled.dimensions.find((item) => item.dimension === 'IMAGE_GENERATION')).toMatchObject(
      {
        enabled: false,
        priorScore: null,
        currentScore: null,
        source: null,
      },
    );
    expect(store.listTeammateCapabilityStates(first.id)).toEqual([]);
  });

  it('changes only display fields and never follows normal Runtime presence into NORMAL routing', () => {
    const { bridge } = setup();
    bridge.bootstrap();
    const updated = bridge.updateDisplay({
      name: 'Me',
      avatar: 'avatar.png',
      title: 'Human artist',
      description: 'I can review and create visual work.',
    });

    expect(updated).toMatchObject({
      name: 'Me',
      avatar: 'avatar.png',
      title: 'Human artist',
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
      currentRuntimeProfileId: null,
    });
    expect(bridge.bootstrap()).toMatchObject({
      routingPolicy: 'FALLBACK_ONLY',
      currentRuntimeProfileId: null,
    });
  });

  it('requires an explicit enabled capability, participant requester, current Run, and bounded task schema', () => {
    const { store, bridge, externalWork } = setup();
    bridge.bootstrap();
    expect(() => externalWork.createExplicit(createInput())).toThrow(/未启用/);
    expect(store.getMission('mission-1')?.state).toBe('RUNNING');

    bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    expect(() =>
      externalWork.createExplicit({
        ...createInput(),
        requesterTeammateId: 'non-participant',
      }),
    ).toThrow(/participant/);
    expect(() =>
      externalWork.createExplicit({
        ...createInput(),
        prompt: 'x'.repeat(20_001),
      }),
    ).toThrow(/长度限制/);
    const createdEvents: unknown[] = [];
    externalWork.subscribeCreated((event) => {
      createdEvents.push(event);
    });
    const request = externalWork.createExplicit(createInput());

    expect(request).toMatchObject({
      missionId: 'mission-1',
      runId: 'run-1',
      requesterTeammateId: 'coordinator',
      assigneeTeammateId: HUMAN_BRIDGE_SYSTEM_ID,
      capability: 'IMAGE_GENERATION',
      state: 'PENDING',
      targetWorkspacePathsJson: { items: ['mission-output'] },
    });
    expect(store.getMission('mission-1')?.state).toBe('WAITING_EXTERNAL_WORK');
    expect(store.listRuns('mission-1')).toMatchObject([{ id: 'run-1', status: 'RUNNING' }]);
    expect(createdEvents).toEqual([
      {
        type: 'EXTERNAL_WORK_CREATED',
        requestId: request.id,
        missionId: 'mission-1',
        title: '有一项外部工作等待处理',
      },
    ]);
    expect(JSON.stringify(createdEvents)).not.toContain(request.prompt);

  });

  it('validates submitted files through the workspace port and rejects traversal, symlink, extension, and size failures', async () => {
    const { bridge, externalWork, workspace, store } = setup();
    bridge.bootstrap();
    bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    const request = externalWork.createExplicit(createInput());
    externalWork.markInProgress(request.id);

    await expect(
      externalWork.submitArtifacts({
        requestId: request.id,
        artifacts: [{ targetArtifactId: 'cover', relativePath: 'mission-output/../../escape.png' }],
      }),
    ).rejects.toThrow(/traversal/);
    expect(workspace.calls).toHaveLength(0);

    workspace.facts.set('mission-output/wrong.exe', {
      relativePath: 'mission-output/wrong.exe',
      fileName: 'wrong.exe',
      extension: '.exe',
      sizeBytes: 500,
    });
    await expect(
      externalWork.submitArtifacts({
        requestId: request.id,
        artifacts: [{ targetArtifactId: 'cover', relativePath: 'mission-output/wrong.exe' }],
      }),
    ).rejects.toThrow(/extension/);

    workspace.facts.set('mission-output/large.png', {
      relativePath: 'mission-output/large.png',
      fileName: 'large.png',
      extension: '.png',
      sizeBytes: 1_025,
    });
    await expect(
      externalWork.submitArtifacts({
        requestId: request.id,
        artifacts: [{ targetArtifactId: 'cover', relativePath: 'mission-output/large.png' }],
      }),
    ).rejects.toThrow(/大小/);

    workspace.failures.set(
      'mission-output/link.png',
      new Error('Workspace symlink/junction escape rejected'),
    );
    await expect(
      externalWork.submitArtifacts({
        requestId: request.id,
        artifacts: [{ targetArtifactId: 'cover', relativePath: 'mission-output/link.png' }],
      }),
    ).rejects.toThrow(/symlink\/junction/);
    expect(store.getExternalWorkRequest(request.id)?.state).toBe('IN_PROGRESS');
    expect(store.listExternalWorkArtifacts(request.id)).toEqual([]);
  });

  it('accepts only a submitted Artifact, resumes the same Run, and emits a bounded untrusted continuation', async () => {
    const { bridge, externalWork, workspace, store } = setup();
    bridge.bootstrap();
    bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    const submitted = await submittedRequest(externalWork, workspace);
    expect(submitted.state).toBe('SUBMITTED');
    const continuations: unknown[] = [];
    externalWork.subscribeContinuations((value) => {
      continuations.push(value);
    });

    const result = externalWork.accept({
      requestId: submitted.id,
      publicResult: 'The cover image is ready.',
    });

    expect(store.getExternalWorkRequest(submitted.id)).toMatchObject({
      state: 'ACCEPTED',
      publicResult: 'The cover image is ready.',
    });
    expect(store.getMission('mission-1')?.state).toBe('RUNNING');
    expect(store.listRuns('mission-1')).toMatchObject([
      { id: 'run-1', status: 'RUNNING', attempt: 1 },
    ]);
    expect(result).toEqual({
      kind: 'EXTERNAL_WORK_CONTINUATION',
      requestId: submitted.id,
      missionId: 'mission-1',
      runId: 'run-1',
      requesterTeammateId: 'coordinator',
      assigneeTeammateId: HUMAN_BRIDGE_SYSTEM_ID,
      capability: 'IMAGE_GENERATION',
      outcome: 'ACCEPTED',
      publicResult: 'The cover image is ready.',
      artifacts: [
        {
          id: expect.any(String),
          path: 'mission-output/cover.png',
          fileName: 'cover.png',
          extension: '.png',
          sizeBytes: 512,
        },
      ],
      trust: 'UNTRUSTED_EXTERNAL_DATA',
    });
    expect(continuations).toEqual([result]);
    expect(result).not.toHaveProperty('role');
    expect(result).not.toHaveProperty('toolId');
  });

  it('records accepted Human Bridge ratings with a null Runtime, updates the score progressively, and skips without evidence', async () => {
    const { store, bridge, externalWork, workspace } = setup();
    bridge.bootstrap();
    bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    const initial = bridge
      .capabilityProfile()
      .dimensions.find((item) => item.dimension === 'IMAGE_GENERATION');
    expect(initial?.currentScore).toBe(1);

    const submitted = await submittedRequest(externalWork, workspace);
    externalWork.accept({ requestId: submitted.id });
    const rated = bridge.submitRating({ externalWorkRequestId: submitted.id, stars: 5 });

    expect(rated.evidence).toMatchObject([
      {
        teammateId: HUMAN_BRIDGE_SYSTEM_ID,
        runtimeProfileId: null,
        missionId: 'mission-1',
        runId: 'run-1',
        dimension: 'IMAGE_GENERATION',
        ratingValue: 100,
      },
    ]);
    expect(
      rated.profile.dimensions.find((item) => item.dimension === 'IMAGE_GENERATION')?.currentScore,
    ).toBe(12);

    const second = await submittedRequest(externalWork, workspace);
    externalWork.accept({ requestId: second.id });
    expect(bridge.submitRating({ externalWorkRequestId: second.id, skip: true })).toMatchObject({
      evidence: [],
      skipped: true,
    });
    expect(store.listCapabilityEvidence(HUMAN_BRIDGE_SYSTEM_ID)).toHaveLength(1);

    bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: false });
    expect(store.listTeammateCapabilityStates(HUMAN_BRIDGE_SYSTEM_ID)).toEqual([]);
    const reenabled = bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    expect(
      reenabled.dimensions.find((item) => item.dimension === 'IMAGE_GENERATION')?.currentScore,
    ).toBe(12);
  });

  it('keeps rejected and cancelled outcomes explicit and never rates them as successful work', async () => {
    const { store, bridge, externalWork, workspace } = setup();
    bridge.bootstrap();
    bridge.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    const submitted = await submittedRequest(externalWork, workspace);
    const rejected = externalWork.reject({
      requestId: submitted.id,
      reason: 'The image did not meet the criteria.',
    });
    expect(rejected.state).toBe('REJECTED');
    expect(store.getMission('mission-1')?.state).toBe('WAITING_EXTERNAL_WORK');
    expect(store.missionEvents.at(-1)?.eventType).toBe('external_work.rejected');
    expect(store.auditEvents.at(-1)?.action).toBe('external_work.rejected');
    expect(() => bridge.submitRating({ externalWorkRequestId: submitted.id, stars: 5 })).toThrow(
      /只有已接受/,
    );

    externalWork.markInProgress(submitted.id);
    workspace.facts.set('mission-output/cover-revised.png', {
      relativePath: 'mission-output/cover-revised.png',
      fileName: 'cover-revised.png',
      extension: '.png',
      sizeBytes: 450,
    });
    await externalWork.submitArtifacts({
      requestId: submitted.id,
      artifacts: [{ targetArtifactId: 'cover', relativePath: 'mission-output/cover-revised.png' }],
    });
    expect(externalWork.accept({ requestId: submitted.id }).artifacts).toMatchObject([
      { path: 'mission-output/cover-revised.png', fileName: 'cover-revised.png' },
    ]);
    expect(store.getMission('mission-1')?.state).toBe('RUNNING');

    const cancelledRequest = externalWork.createExplicit(createInput());
    const cancelled = externalWork.cancel({ requestId: cancelledRequest.id });
    expect(cancelled.outcome).toBe('CANCELLED');
    expect(cancelled.artifacts).toEqual([]);
    expect(store.getMission('mission-1')?.state).toBe('RUNNING');
    expect(store.listCapabilityEvidence(HUMAN_BRIDGE_SYSTEM_ID)).toEqual([]);
  });
});
