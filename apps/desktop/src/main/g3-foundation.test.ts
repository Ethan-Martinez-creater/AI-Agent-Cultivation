import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollaborationRequest, Mission, Party, PartyMember } from '@cultivation/domain';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import { Gate1Service } from '@cultivation/application/gate1-service';
import { Gate5CollaborationService } from '@cultivation/application/gate5-collaboration-service';
import {
  ExternalWorkService,
  type ExternalWorkContinuation,
  type R2HumanBridgeServiceStore,
  type ValidatedWorkspaceArtifact,
  type WorkspaceArtifactConstraints,
} from '@cultivation/application/r2-human-bridge-service';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import {
  Gate1SqliteRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
  Gate5SqliteRepository,
  openDatabase,
  R0SqliteRepository,
  R2ContinuationRepository,
} from '@cultivation/persistence';
import { GenerationSqliteRepository } from '@cultivation/persistence/g1-generation';
import { GenerationMediaStore } from './g2-media-store.js';
import { FileWorkspace } from './file-workspace.js';
import { generationFoundation } from './g1-foundation.js';
import { multimodalFoundation } from './g3-foundation.js';

const at = '2026-10-06T00:00:00.000Z';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

async function harness(
  outcome: Record<string, unknown> = { kind: 'RESULT', artifactRefs: [] },
  unavailable = false,
) {
  const root = join(process.cwd(), '.test-data', `g3-main-${randomUUID()}`);
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const db = openDatabase(join(root, 'data.sqlite'));
  const store = new Gate1SqliteRepository(db);
  const missions = new Gate3SqliteRepository(db);
  const parties = new Gate5SqliteRepository(db);
  const tools = new Gate4SqliteRepository(db);
  const capabilityStore = new R0SqliteRepository(db);
  const continuations = new R2ContinuationRepository(db);
  const permission = new PermissionEngine(missions);
  tools.setWorkspaceRoot(workspaceRoot);

  const gate1 = new Gate1Service(
    store,
    {
      encrypt: async (value) => new TextEncoder().encode(value),
      decrypt: async (value) => new TextDecoder().decode(value),
    },
    new FakeModelGateway(),
  );
  const provider = gate1.createProvider({
    name: 'G3 test',
    kind: 'OPENAI_COMPATIBLE',
    baseUrl: 'http://127.0.0.1:7788/v1',
  });
  const runtime = gate1.createRuntimeProfile({
    name: 'G3 language',
    providerId: provider.id,
    credentialId: null,
    modelId: 'g3-language-v1',
    executionProtocol: 'LANGUAGE',
  });
  const coordinator = await gate1.createTeammate({
    name: 'Coordinator',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtime.id,
  });
  const participant = await gate1.createTeammate({
    name: 'Participant',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtime.id,
  });
  const bridge = capabilityStore.ensureHumanBridgeTeammate({
    id: 'system-human-bridge',
    createdAt: at,
    updatedAt: at,
  });
  for (const dimension of [
    'GENERAL_REASONING',
    'IMAGE_GENERATION',
    'VISUAL_UNDERSTANDING',
  ] as const) {
    capabilityStore.saveHumanBridgeCapability({
      teammateId: bridge.id,
      dimension,
      enabled: true,
      updatedAt: at,
    });
  }

  const generation = generationFoundation({
    db,
    userData: root,
    store,
    missions,
    tools,
    permission,
    testOnly: true,
  });
  const generationRepository = new GenerationSqliteRepository(db);
  const media = new GenerationMediaStore(root, db);
  const r2Store = {
    ensureHumanBridgeTeammate: capabilityStore.ensureHumanBridgeTeammate.bind(capabilityStore),
    updateHumanBridgeDisplay: capabilityStore.updateHumanBridgeDisplay.bind(capabilityStore),
    listHumanBridgeCapabilities: capabilityStore.listHumanBridgeCapabilities.bind(capabilityStore),
    saveHumanBridgeCapability: capabilityStore.saveHumanBridgeCapability.bind(capabilityStore),
    listTeammateCapabilityStates:
      capabilityStore.listTeammateCapabilityStates.bind(capabilityStore),
    replaceTeammateCapabilityStates:
      capabilityStore.replaceTeammateCapabilityStates.bind(capabilityStore),
    listCapabilityEvidence: capabilityStore.listCapabilityEvidence.bind(capabilityStore),
    appendCapabilityEvidenceBatch:
      capabilityStore.appendCapabilityEvidenceBatch.bind(capabilityStore),
    saveExternalAppProfile: capabilityStore.saveExternalAppProfile.bind(capabilityStore),
    listExternalAppProfiles: capabilityStore.listExternalAppProfiles.bind(capabilityStore),
    createExternalWorkRequest: capabilityStore.createExternalWorkRequest.bind(capabilityStore),
    getExternalWorkRequest: capabilityStore.getExternalWorkRequest.bind(capabilityStore),
    listExternalWorkRequests: capabilityStore.listExternalWorkRequests.bind(capabilityStore),
    transitionExternalWorkRequest:
      capabilityStore.transitionExternalWorkRequest.bind(capabilityStore),
    appendExternalWorkArtifact: capabilityStore.appendExternalWorkArtifact.bind(capabilityStore),
    listExternalWorkArtifacts: capabilityStore.listExternalWorkArtifacts.bind(capabilityStore),
    getMission: missions.getMission.bind(missions),
    listRuns: missions.listRuns.bind(missions),
    listMissionParticipants: parties.listMissionParticipants.bind(parties),
    transitionMission: missions.transitionMission.bind(missions),
    appendMissionEvent: missions.appendMissionEvent.bind(missions),
    appendAuditEvent: missions.appendAuditEvent.bind(missions),
    transaction: missions.transaction.bind(missions),
  } as unknown as R2HumanBridgeServiceStore;
  const validator = {
    async validateArtifact(
      relativePath: string,
      constraints: WorkspaceArtifactConstraints,
    ): Promise<ValidatedWorkspaceArtifact> {
      const inspected = await (
        await FileWorkspace.open(workspaceRoot)
      ).inspectArtifact(relativePath, constraints.maxSizeBytes, true);
      if (!constraints.allowedExtensions.includes(inspected.extension))
        throw new Error('Unexpected extension');
      return {
        relativePath: inspected.path,
        fileName: inspected.fileName,
        extension: inspected.extension,
        sizeBytes: inspected.sizeBytes,
        contentHash: inspected.contentHash,
      };
    },
  };
  const externalWork = new ExternalWorkService(r2Store, validator, {
    continuations,
    now: () => at,
    newId: randomUUID,
  });
  const partyExecution = {
    recordMultimodalExternalWork: () => undefined,
    recoverMultimodalExternalWork: () => false,
    executeLanguageParticipant: async () =>
      unavailable
        ? { kind: 'UNAVAILABLE' as const, code: 'MODEL_UNAVAILABLE' }
        : {
            kind: 'DONE' as const,
            text: JSON.stringify(outcome),
          },
    recoverExecution: async () => undefined,
    attachMultimodalExecution: () => undefined,
    detail: (missionId: string) => ({
      mission: missions.getMission(missionId),
      collaborations: parties.listCollaborationRequests(missionId),
    }),
    requestDependency: () => {
      throw new Error('Not used in this fixture');
    },
  } as unknown as Gate5CollaborationService;
  const foundation = multimodalFoundation({
    db,
    store,
    missions,
    parties,
    partyExecution,
    tools,
    permission,
    planner: {
      plan: async () => ({ status: 'UNAVAILABLE', reason: 'No eligible dependency' }),
    } as never,
    externalWork,
    continuations,
    generation: { ...generation, repository: generationRepository },
    media,
    missionExecution: { attachGenerationExecution: () => undefined } as never,
    workflows: { detail: () => null, findStepByMissionId: () => null } as never,
  });
  return {
    db,
    root,
    workspaceRoot,
    store,
    missions,
    parties,
    tools,
    capabilityStore,
    continuations,
    permission,
    gate1,
    coordinator,
    participant,
    bridge,
    externalWork,
    foundation,
    media,
    generationRepository,
    close: () => db.close(),
  };
}

function createRunningParty(h: Awaited<ReturnType<typeof harness>>, useBridge = false) {
  const missionId = `mission-${randomUUID()}`;
  const partyId = `party-${randomUUID()}`;
  const targetId = useBridge ? h.bridge.id : h.participant.id;
  const party: Party = {
    id: partyId,
    name: 'G3 test party',
    description: '',
    coordinatorTeammateId: h.coordinator.id,
    type: 'FIXED',
    status: 'ACTIVE',
    createdAt: at,
  };
  const members: PartyMember[] = [
    { partyId, teammateId: h.coordinator.id, role: 'COORDINATOR', order: 0 },
    { partyId, teammateId: targetId, role: 'MEMBER', order: 1 },
  ];
  h.parties.saveParty(party, members);
  const draft: Mission = {
    id: missionId,
    title: 'G3 test mission',
    objective: 'Complete a bounded execution task',
    initiatorType: 'USER',
    initiatorId: 'local-user',
    coordinatorTeammateId: h.coordinator.id,
    partyId,
    mode: 'DELEGATION',
    state: 'DRAFT',
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  };
  h.parties.insertPartyMission(draft);
  const ready = { ...draft, state: 'READY' as const, updatedAt: at };
  expect(h.missions.transitionMission(ready, 'DRAFT')).toBe(true);
  const running = { ...ready, state: 'RUNNING' as const, updatedAt: at };
  expect(h.missions.transitionMission(running, 'READY')).toBe(true);
  const run = h.missions.createRun(missionId, at);
  const request: CollaborationRequest = {
    id: `request-${randomUUID()}`,
    missionId,
    runId: run.id,
    requesterTeammateId: h.coordinator.id,
    targetTeammateId: targetId,
    reason: 'Test approved dispatch',
    proposedTask: 'Complete the approved bounded task',
    expectedBenefit: 'Exercise Main orchestration',
    depth: 0,
    state: 'PENDING',
    createdAt: at,
    resolvedAt: null,
  };
  h.parties.createCollaborationRequest(request);
  const approved = h.parties.resolveCollaborationRequest(request.id, 'APPROVED', at);
  expect(approved?.state).toBe('APPROVED');
  return { mission: h.missions.getMission(missionId)!, run, request: approved!, targetId };
}

async function submitAccepted(
  h: Awaited<ReturnType<typeof harness>>,
  missionId: string,
  runId: string,
  extension: '.png' | '.txt',
  body: Buffer,
  publicResult: string | null = null,
): Promise<ExternalWorkContinuation> {
  const request = h.capabilityStore.listExternalWorkRequests(missionId, runId)[0];
  expect(request).toBeDefined();
  const target = request!.targetArtifactsJson.items[0]!;
  const folder = request!.targetWorkspacePathsJson.items[0]!;
  const relativePath = `${folder}/${extension === '.png' ? 'reference' : 'review'}${extension}`;
  mkdirSync(join(h.workspaceRoot, folder), { recursive: true });
  writeFileSync(join(h.workspaceRoot, ...relativePath.split('/')), body);
  h.externalWork.markInProgress(request!.id);
  await h.externalWork.submitArtifacts({
    requestId: request!.id,
    artifacts: [{ targetArtifactId: target.id, relativePath }],
  });
  return h.externalWork.accept({ requestId: request!.id, publicResult });
}

describe('G3 Main orchestration over full SQLite migrations', () => {
  it('protects only the current Run and never borrows old G3 tasks or approval facts after Retry', async () => {
    const h = await harness();
    try {
      const { mission, run, request, targetId } = createRunningParty(h);
      await h.foundation.delegate.execute(mission, run, {
        phase: 'PARTICIPANT',
        teammateId: targetId,
        task: request.proposedTask,
        artifactKind: 'MEMBER_RESULT',
        requestId: request.id,
      });
      expect(h.foundation.repository.listTasks(mission.id, run.id)).toHaveLength(1);
      expect(h.foundation.protectedMissionIds().has(mission.id)).toBe(true);
      const failed = { ...mission, state: 'FAILED' as const, completedAt: at };
      expect(h.missions.transitionMission(failed, 'RUNNING')).toBe(true);
      expect(h.missions.finishRun({ ...run, status: 'FAILED', endedAt: at })).toBe(true);
      const ready = { ...failed, state: 'READY' as const, completedAt: null };
      expect(h.missions.transitionMission(ready, 'FAILED')).toBe(true);
      expect(h.missions.transitionMission({ ...ready, state: 'RUNNING' }, 'READY')).toBe(true);
      const retry = h.missions.createRun(mission.id, at);
      expect(retry.attempt).toBe(2);
      expect(h.foundation.protectedMissionIds().has(mission.id)).toBe(false);
      expect(h.foundation.repository.listTasks(mission.id, run.id)).toHaveLength(1);
      expect(h.foundation.repository.listTasks(mission.id, retry.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('returns pre-execution unavailability without attributing a completed or failed output to the unexecuted target', async () => {
    const h = await harness({}, true);
    try {
      const { mission, run, request, targetId } = createRunningParty(h);
      expect(
        await h.foundation.delegate.execute(mission, run, {
          phase: 'PARTICIPANT',
          teammateId: targetId,
          task: request.proposedTask,
          artifactKind: 'MEMBER_RESULT',
          requestId: request.id,
        }),
      ).toEqual({ kind: 'UNAVAILABLE', code: 'MODEL_UNAVAILABLE' });
      expect(h.parties.listCollaborationArtifacts(mission.id, run.id)).toEqual([]);
      expect(
        h.missions
          .listMissionEvents(mission.id)
          .filter(
            (event) =>
              event.actorId === targetId &&
              ['model.call_started', 'collaboration.completed', 'collaboration.failed'].includes(
                event.eventType,
              ),
          ),
      ).toEqual([]);
    } finally {
      h.close();
    }
  });
  it('uses NEEDS_CAPABILITY.requestedInputs to request and resume a role-bound input, with exact user approval', async () => {
    const h = await harness({
      kind: 'NEEDS_CAPABILITY',
      capability: 'IMAGE_GENERATION',
      requiredFeatures: ['REFERENCE_IMAGE'],
      requestedInputs: [
        { role: 'REFERENCE', artifactKinds: ['IMAGE'], mimeTypes: ['image/png'], required: true },
      ],
      reason: 'Need a visual reference',
    });
    try {
      const { mission, run, request, targetId } = createRunningParty(h);
      const progress = await h.foundation.delegate.execute(mission, run, {
        phase: 'PARTICIPANT',
        teammateId: targetId,
        task: request.proposedTask,
        artifactKind: 'MEMBER_RESULT',
        requestId: request.id,
      });
      expect(progress.kind).toBe('WAITING');
      const external = h.capabilityStore.listExternalWorkRequests(mission.id, run.id)[0]!;
      expect(external.targetArtifactsJson.items).toMatchObject([
        { id: 'input-0', name: 'REFERENCE', required: true, allowedExtensions: ['.png'] },
      ]);

      const continuation = await submitAccepted(h, mission.id, run.id, '.png', png);
      const attempt = h.foundation.repository.listAttempts(
        h.foundation.repository.listTasks(mission.id, run.id)[0]!.id,
      )[0]!;
      const resource = `file:${h.workspaceRoot}:${continuation.artifacts[0]!.path}`;
      await expect(h.foundation.resumeHuman(continuation)).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
      expect(h.media.list()).toEqual([]);
      expect(h.missions.getMission(mission.id)?.state).toBe('WAITING_APPROVAL');
      const approval = h.missions
        .listApprovals(mission.id)
        .find((item) => item.actionPayload.executionAttemptId === attempt.id)!;
      expect(approval.actionPayload).toEqual({ executionAttemptId: attempt.id, resource });

      await h.foundation.resolveApproval({ approvalId: approval.id, decision: 'ALLOW_MISSION' });
      expect(
        h.permission.evaluate({
          subjectType: 'TEAMMATE',
          subjectId: targetId,
          teammateId: targetId,
          missionId: mission.id,
          capability: 'FILE_READ',
          resource,
        }).decision,
      ).toBe('ALLOW');
      expect(
        h.permission.evaluate({
          subjectType: 'TEAMMATE',
          subjectId: targetId,
          teammateId: targetId,
          missionId: mission.id,
          capability: 'FILE_READ',
          resource: `${resource}.other`,
        }).decision,
      ).toBe('ASK');
      const child = h.foundation.repository
        .listTasks(mission.id, run.id)
        .find((task) => task.parentTaskId !== null)!;
      expect(child.artifactInputs).toMatchObject([
        { role: 'REFERENCE', kind: 'IMAGE', mimeType: 'image/png' },
      ]);
      expect(h.continuations.getByRequestId(continuation.requestId)?.state).toBe('CONSUMED');
    } finally {
      h.close();
    }
  });

  it('settles accepted direct USER_BRIDGE delivery as one typed RESULT fact', async () => {
    const h = await harness();
    try {
      const { mission, run, request, targetId } = createRunningParty(h, true);
      const progress = await h.foundation.delegate.execute(mission, run, {
        phase: 'PARTICIPANT',
        teammateId: targetId,
        task: request.proposedTask,
        artifactKind: 'MEMBER_RESULT',
        requestId: request.id,
      });
      expect(progress.kind).toBe('WAITING');
      const continuation = await submitAccepted(
        h,
        mission.id,
        run.id,
        '.txt',
        Buffer.from('Approved handoff', 'utf8'),
        'Delivered',
      );
      for (const forged of [
        { ...continuation, publicResult: 'Forged acceptance' },
        { ...continuation, assigneeTeammateId: h.participant.id },
        {
          ...continuation,
          artifacts: continuation.artifacts.map((a) => ({ ...a, path: 'other.txt' })),
        },
      ]) {
        await expect(h.foundation.resumeHuman(forged)).rejects.toMatchObject({
          code: 'EXTERNAL_WORK_PROVENANCE',
        });
        expect(h.continuations.getByRequestId(continuation.requestId)?.state).toBe('PENDING');
      }
      expect(await h.foundation.resumeHuman(continuation)).toBe(true);
      const task = h.foundation.repository.listTasks(mission.id, run.id)[0]!;
      const settled = await h.foundation.service.advance(task.id);
      expect(settled.kind).toBe('OUTCOME');
      if (settled.kind === 'OUTCOME')
        expect(settled.fact.outcome).toEqual({
          kind: 'RESULT',
          publicResult: 'Delivered',
          artifactRefs: [],
        });
      expect(
        h.foundation.repository.getAttempt(h.foundation.repository.listAttempts(task.id)[0]!.id)
          ?.state,
      ).toBe('COMPLETED');
      expect(
        h.foundation.repository.getOutcome(h.foundation.repository.listAttempts(task.id)[0]!.id)
          ?.outcome.kind,
      ).toBe('RESULT');
      // This harness deliberately does not synthesize or commit the Mission.
      expect(h.continuations.getByRequestId(continuation.requestId)?.state).toBe('CONSUMING');
    } finally {
      h.close();
    }
  });

  it('consumes an accepted review artifact even when the reviewer leaves publicResult empty', async () => {
    const h = await harness();
    try {
      const { mission, run, request, targetId } = createRunningParty(h);
      const task = {
        id: `task-${randomUUID()}`,
        logicalKey: `collaboration:${request.id}`,
        source: 'COLLABORATION' as const,
        missionId: mission.id,
        runId: run.id,
        collaborationRequestId: request.id,
        workflowRunId: null,
        workflowStepRunId: null,
        requesterTeammateId: h.coordinator.id,
        coordinatorTeammateId: h.coordinator.id,
        targetTeammateId: targetId,
        requiredCapability: 'GENERAL_REASONING' as const,
        executionProtocol: 'LANGUAGE' as const,
        publicTask: request.proposedTask,
        publicContext: '',
        artifactInputs: [],
        generationRequirements: null,
        acceptanceCriteria: ['test'],
        inputRequirements: [],
        dependencyRole: null,
        reviewOf: [],
        parentTaskId: null,
        retryNo: 0,
        continuationRound: 0,
        policyVersion: 'g3-execution-policy-v1',
        createdAt: at,
      };
      h.foundation.repository.createTask(task);
      let attempt = h.foundation.repository.createAttempt(task.id, {
        runtimeProfileId: h.store.getModelBinding(targetId)!.runtimeProfileId,
        createdAt: at,
      });
      attempt = h.foundation.repository.transitionAttempt(attempt.id, 'PREPARED', 'RUNNING');
      attempt = h.foundation.repository.transitionAttempt(attempt.id, 'RUNNING', 'COMPLETED');
      const fact = h.foundation.repository.appendOutcome(attempt.id, {
        kind: 'RESULT',
        publicResult: 'Generated',
        artifactRefs: [],
      });
      h.foundation.repository.saveContinuation(fact.id, {
        action: 'REVIEW',
        reason: 'Wait for accepted review',
      });
      const externalRequest = h.externalWork.createExplicit({
        missionId: mission.id,
        runId: run.id,
        requesterTeammateId: h.coordinator.id,
        capability: 'VISUAL_UNDERSTANDING',
        title: 'Review output',
        prompt: 'Review the output and submit a written opinion.',
        requirements: ['Do not self-review'],
        targetArtifacts: [
          {
            id: 'review',
            name: 'Review notes',
            required: true,
            allowedExtensions: ['.txt'],
            maxSizeBytes: 64 * 1024,
          },
        ],
        targetWorkspacePaths: ['g3-review'],
        acceptanceCriteria: ['Reviewer accepted the review file'],
      });
      h.foundation.repository.bindExternalWork(attempt.id, externalRequest.id);
      h.missions.appendMissionEvent({
        id: randomUUID(),
        missionId: mission.id,
        runId: run.id,
        eventType: 'collaboration.review_requested',
        actorType: 'SYSTEM',
        actorId: null,
        payloadJson: { taskId: task.id, externalWorkRequestId: externalRequest.id },
        createdAt: at,
      });
      const continuation = await submitAccepted(
        h,
        mission.id,
        run.id,
        '.txt',
        Buffer.from('Looks good', 'utf8'),
      );

      expect(continuation.publicResult).toBeNull();
      expect(await h.foundation.resumeHuman(continuation)).toBe(true);
      expect(h.continuations.getByRequestId(continuation.requestId)?.state).toBe('CONSUMED');
      const completed = h.missions
        .listMissionEvents(mission.id)
        .find((event) => event.eventType === 'collaboration.media_review_completed')!;
      expect(completed.payloadJson.summary).toBe('本尊已验收审查意见文件');
      expect(completed.payloadJson.reviewedArtifactRefs).toEqual([]);
    } finally {
      h.close();
    }
  });
});
