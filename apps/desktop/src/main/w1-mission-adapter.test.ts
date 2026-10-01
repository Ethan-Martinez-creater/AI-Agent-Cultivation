import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMissionSnapshot } from '@cultivation/application';
import type {
  Gate3MissionStore,
  Gate3MissionService,
} from '@cultivation/application/gate3-mission-service';
import type { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import type { ExternalWorkService, RoutingMissionService } from '@cultivation/application';
import { WorkflowMissionAdapter } from './w1-mission-adapter.js';

function fixture(mode: 'SOLO' | 'CONSULTATION' = 'SOLO') {
  const snapshot: WorkflowMissionSnapshot = {
    mission: {
      id: 'mission',
      title: 'Bounded',
      objective: 'Objective',
      initiatorType: 'USER',
      initiatorId: 'local-user',
      coordinatorTeammateId: 'actor',
      partyId: mode === 'SOLO' ? null : 'party',
      mode,
      state: 'COMPLETED',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      completedAt: '2026-10-01T00:00:00Z',
    },
    run: {
      id: 'run-2',
      missionId: 'mission',
      attempt: 2,
      status: 'COMPLETED',
      startedAt: '2026-10-01T00:00:00Z',
      endedAt: '2026-10-01T00:00:00Z',
      errorCode: null,
      errorMessage: null,
      resultText: 'Current attempt final',
    },
    outputs: [],
    uncertainSideEffects: false,
  };
  const store = {
    getMission: vi.fn(() => snapshot.mission),
    listRuns: vi.fn(() => [
      { ...snapshot.run!, id: 'run-1', attempt: 1, resultText: 'Old attempt result' },
      snapshot.run!,
    ]),
    listMissionEvents: vi.fn(() => []),
  };
  const solo = {
    ready: vi.fn(),
    start: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
  const party = {
    ready: vi.fn(),
    start: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
  const external = { listExternalWorkRequests: vi.fn(() => []), getExternalWorkRequest: vi.fn() };
  const routing = {
    createMission: vi.fn(async (input, bind) => {
      bind(snapshot.mission);
      return { status: 'CREATED', mission: snapshot.mission, receipt: {} };
    }),
  };
  const adapter = new WorkflowMissionAdapter(
    routing as unknown as RoutingMissionService,
    store as unknown as Gate3MissionStore,
    solo as unknown as Gate3MissionService,
    party as unknown as Gate5CollaborationService,
    external as unknown as ExternalWorkService,
    () => 'workspace-root',
  );
  return { adapter, snapshot, store, solo, party, external, routing };
}
describe('W1 existing Mission boundary', () => {
  it('collects only the current terminal Run result with its actual coordinator', () => {
    const { adapter } = fixture('CONSULTATION');
    expect(adapter.snapshot('mission').outputs).toEqual([
      {
        source: 'MISSION',
        sourceId: 'run-2',
        actorId: 'actor',
        kind: 'TEXT',
        content: 'Current attempt final',
        metadata: {},
      },
    ]);
  });
  it('never turns an interrupted result into a completed Artifact', () => {
    const { adapter, snapshot } = fixture();
    snapshot.run!.status = 'INTERRUPTED';
    snapshot.mission.state = 'INTERRUPTED';
    expect(adapter.snapshot('mission').outputs).toEqual([]);
  });
  it.each(['SOLO', 'CONSULTATION'] as const)(
    'dispatches %s through its existing Mission service',
    async (mode) => {
      const { adapter, snapshot, solo, party } = fixture(mode);
      snapshot.mission.state = 'DRAFT';
      await adapter.start('mission');
      await adapter.retry('mission');
      adapter.cancel('mission');
      const selected = mode === 'SOLO' ? solo : party;
      const other = mode === 'SOLO' ? party : solo;
      expect(selected.ready).toHaveBeenCalledWith('mission');
      expect(selected.start).toHaveBeenCalledTimes(1);
      expect(selected.retry).toHaveBeenCalledTimes(1);
      expect(selected.cancel).toHaveBeenCalledWith('mission');
      expect(other.start).not.toHaveBeenCalled();
      expect(other.retry).not.toHaveBeenCalled();
    },
  );
  it('keeps R4 generic context and transactional binding callback', async () => {
    const { adapter, routing } = fixture();
    const bind = vi.fn();
    const context = {
      objective: 'Only public task',
      executionConstraint: 'SOLO' as const,
      executionContext: { origin: 'WORKFLOW', executionId: 'wf', stepId: 'step' },
    };
    await adapter.create(
      { title: 'step', context, executionObjective: 'Bounded execution contract' },
      bind,
    );
    expect(routing.createMission).toHaveBeenCalledWith(
      { title: 'step', context, executionObjective: 'Bounded execution contract' },
      bind,
    );
    expect(bind).toHaveBeenCalledTimes(1);
  });
  it('returns action-required instead of inventing an executor/Mission', async () => {
    const { adapter, routing } = fixture();
    routing.createMission.mockImplementationOnce(
      async () => ({ status: 'USER_ACTION_REQUIRED', reason: 'NO_CAPABLE_EXECUTOR' }) as never,
    );
    const bind = vi.fn();
    expect(await adapter.create({ title: 'step', context: { objective: 'task' } }, bind)).toEqual({
      status: 'USER_ACTION_REQUIRED',
      reason: 'NO_CAPABLE_EXECUTOR',
    });
    expect(bind).not.toHaveBeenCalled();
  });
  it('does not inspect rejected external artifacts', async () => {
    const { adapter, external } = fixture();
    external.listExternalWorkRequests.mockReturnValue([
      { id: 'denied', state: 'REJECTED' },
    ] as never);
    expect((await adapter.collectOutputs('mission', 'workspace-root')).outputs).toHaveLength(1);
    expect(external.getExternalWorkRequest).not.toHaveBeenCalled();
  });
  it('rejects changed Workspace before filesystem inspection of an accepted file', async () => {
    const { adapter, external } = fixture();
    external.listExternalWorkRequests.mockReturnValue([
      { id: 'accepted', state: 'ACCEPTED', runId: 'run-2' },
    ] as never);
    external.getExternalWorkRequest.mockReturnValue({ artifacts: [] });
    await expect(adapter.collectOutputs('mission', 'other-root')).rejects.toMatchObject({
      code: 'WORKFLOW_WORKSPACE_CHANGED',
    });
  });
});
