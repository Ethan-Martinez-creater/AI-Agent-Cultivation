import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent, CollaborationArtifact, Mission, MissionEvent } from '@cultivation/domain';
import {
  Gate5CollaborationService,
  type Gate5CollaborationStore,
  type MultimodalPartyExecution,
} from './gate5-collaboration-service.js';
import type { Gate3MissionStore, MissionRunRecord } from './gate3-mission-service.js';
import type { ModelGateway } from './index.js';
import type {
  R2ExternalWorkContinuationRecord,
  R2ExternalWorkContinuationStore,
} from './r2-human-bridge-service.js';

const at = '2026-10-06T00:00:00.000Z';
const missionId = 'mission-current';
const runId = 'run-current';
const requestId = 'external-current';

class RecoveryStore {
  mission: Mission = {
    id: missionId,
    title: 'Recovery fixture',
    objective: 'Complete the accepted handoff',
    initiatorType: 'USER',
    initiatorId: 'local-user',
    coordinatorTeammateId: 'coordinator',
    partyId: 'party',
    mode: 'DELEGATION',
    state: 'RUNNING',
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  };

  run: MissionRunRecord = {
    id: runId,
    missionId,
    attempt: 1,
    status: 'RUNNING',
    startedAt: at,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
    resultText: null,
  };

  artifacts: CollaborationArtifact[] = [
    {
      id: 'final-current',
      missionId,
      runId,
      teammateId: 'coordinator',
      kind: 'FINAL',
      content: 'Saved final synthesis result',
      createdAt: at,
    },
  ];

  events: MissionEvent[] = [];
  audits: AuditEvent[] = [];
  continuations = new Map<string, R2ExternalWorkContinuationRecord>();
  markConsumedCalls = new Map<string, number>();

  getMission = (id: string) => (id === this.mission.id ? this.mission : null);
  listRuns = (id: string) => (id === missionId ? [this.run] : []);
  getRun = (id: string) => (id === runId ? this.run : null);
  listMissionEvents = (id: string) => this.events.filter((event) => event.missionId === id);
  listCollaborationArtifacts = (id: string, currentRunId?: string) =>
    this.artifacts.filter(
      (artifact) => artifact.missionId === id && (!currentRunId || artifact.runId === currentRunId),
    );
  listAuditEvents = (id: string) => this.audits.filter((event) => event.targetId === id);
  listMissionUsage = () => [];
  listApprovals = () => [];
  listMissionParticipants = () => [];
  listCollaborationRequests = () => [];

  transitionMission(next: Mission, expected: Mission['state']): boolean {
    if (this.mission.state !== expected) return false;
    this.mission = next;
    return true;
  }

  finishRun(next: MissionRunRecord): boolean {
    if (this.run.status !== 'RUNNING' || next.id !== this.run.id) return false;
    this.run = next;
    return true;
  }

  appendMissionEvent(event: MissionEvent): void {
    this.events.push(event);
  }

  appendAuditEvent(event: AuditEvent): void {
    this.audits.push(event);
  }

  transaction<T>(action: () => T): T {
    return action();
  }

  createPending(input: {
    externalWorkRequestId: string;
    missionId: string;
    missionRunId: string;
    createdAt: string;
  }): R2ExternalWorkContinuationRecord {
    const existing = this.continuations.get(input.externalWorkRequestId);
    if (existing) return { ...existing };
    const record: R2ExternalWorkContinuationRecord = {
      ...input,
      state: 'PENDING',
      updatedAt: input.createdAt,
      consumedAt: null,
    };
    this.continuations.set(record.externalWorkRequestId, record);
    return { ...record };
  }

  getByRequestId(id: string): R2ExternalWorkContinuationRecord | null {
    const record = this.continuations.get(id);
    return record ? { ...record } : null;
  }

  listRecoverable(): R2ExternalWorkContinuationRecord[] {
    return [...this.continuations.values()]
      .filter((record) => record.state !== 'CONSUMED')
      .map((record) => ({ ...record }));
  }

  markConsuming(id: string, updatedAt: string): boolean {
    const current = this.continuations.get(id);
    if (!current || current.state !== 'PENDING') return false;
    this.continuations.set(id, { ...current, state: 'CONSUMING', updatedAt });
    return true;
  }

  markConsumed(id: string, updatedAt: string): boolean {
    this.markConsumedCalls.set(id, (this.markConsumedCalls.get(id) ?? 0) + 1);
    const current = this.continuations.get(id);
    if (!current || current.state !== 'CONSUMING') return false;
    this.continuations.set(id, {
      ...current,
      state: 'CONSUMED',
      updatedAt,
      consumedAt: updatedAt,
    });
    return true;
  }
}

describe('Gate5 FINAL recovery with an accepted R2 continuation', () => {
  it('completes the current Run from its saved FINAL artifact and consumes its continuation once without execution', async () => {
    const store = new RecoveryStore();
    store.createPending({
      externalWorkRequestId: requestId,
      missionId,
      missionRunId: runId,
      createdAt: at,
    });
    expect(store.markConsuming(requestId, at)).toBe(true);

    const staleRequestId = 'external-previous-run';
    store.createPending({
      externalWorkRequestId: staleRequestId,
      missionId,
      missionRunId: 'run-previous',
      createdAt: at,
    });
    expect(store.markConsuming(staleRequestId, at)).toBe(true);

    store.events.push(
      {
        id: 'continuation-current-run',
        missionId,
        runId,
        eventType: 'external_work.continuation_received',
        actorType: 'SYSTEM',
        actorId: null,
        payloadJson: {
          requestId,
          missionId,
          runId,
          requesterTeammateId: 'coordinator',
          assigneeTeammateId: 'human-bridge',
          capability: 'IMAGE_GENERATION',
          outcome: 'ACCEPTED',
          trust: 'UNTRUSTED_EXTERNAL_DATA',
        },
        createdAt: at,
      },
      {
        id: 'continuation-previous-run',
        missionId,
        runId: 'run-previous',
        eventType: 'external_work.continuation_received',
        actorType: 'SYSTEM',
        actorId: null,
        payloadJson: {
          requestId: staleRequestId,
          missionId,
          runId: 'run-previous',
        },
        createdAt: at,
      },
    );

    const generate = vi.fn();
    const execute = vi.fn(async () => ({ kind: 'WAITING' as const }));
    const multimodal: MultimodalPartyExecution = {
      execute,
      consume: vi.fn(),
      detail: vi.fn(() => null),
      candidateMetadata: vi.fn(async () => []),
    };
    let sequence = 0;
    const service = new Gate5CollaborationService(
      store as unknown as Gate3MissionStore,
      store as unknown as Gate5CollaborationStore,
      {} as never,
      {} as never,
      {} as never,
      { generate } as unknown as ModelGateway,
      undefined,
      undefined,
      { now: () => at, newId: () => `recovery-event-${++sequence}` },
    );
    service.attachMultimodalExecution(multimodal);
    service.attachExternalWork(
      { createExplicit: vi.fn() } as never,
      store as unknown as R2ExternalWorkContinuationStore,
    );

    await service.recoverExecution(missionId);

    expect(store.mission.state).toBe('COMPLETED');
    expect(store.run).toMatchObject({
      id: runId,
      status: 'COMPLETED',
      resultText: 'Saved final synthesis result',
    });
    expect(store.getByRequestId(requestId)).toMatchObject({ state: 'CONSUMED' });
    expect(store.markConsumedCalls.get(requestId)).toBe(1);
    expect(store.getByRequestId(staleRequestId)).toMatchObject({ state: 'CONSUMING' });
    expect(store.markConsumedCalls.has(staleRequestId)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await service.recoverExecution(missionId);

    expect(store.markConsumedCalls.get(requestId)).toBe(1);
    expect(store.artifacts.filter((artifact) => artifact.kind === 'FINAL')).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
