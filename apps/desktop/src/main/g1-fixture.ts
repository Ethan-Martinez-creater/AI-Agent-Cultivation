import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { Gate1Service } from '@cultivation/application/gate1-service';
import type { Gate3SqliteRepository, Gate4SqliteRepository } from '@cultivation/persistence';
import type { GenerationService } from '@cultivation/application/g1-generation';
import { transition } from '@cultivation/domain';

/** Explicit packaged-test fixture only. No production generation/Mission orchestration is introduced. */
export async function seedGenerationWorkspaceFixture(
  service: Gate1Service,
  generation: GenerationService,
  missions: Gate3SqliteRepository,
  tools: Gate4SqliteRepository,
  root: string,
  deny: boolean,
) {
  const canonical = await realpath(root);
  tools.setWorkspaceRoot(canonical);
  const provider = service.createProvider({
    name: '图像服务',
    kind: 'OPENAI_COMPATIBLE',
    baseUrl: 'http://127.0.0.1:7788/v1',
  });
  const runtime = service.createRuntimeProfile({
    name: '图像生成',
    providerId: provider.id,
    credentialId: null,
    modelId: 'image-v1',
    executionProtocol: 'GENERATION',
  });
  const teammate = await service.createTeammate({
    name: '画师',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtime.id,
  });
  const now = new Date().toISOString();
  const mission = {
    id: randomUUID(),
    title: '图片交付',
    objective: '保存一张图片到指定历练工作区',
    initiatorType: 'USER' as const,
    initiatorId: 'local-user',
    coordinatorTeammateId: teammate.id,
    partyId: null,
    mode: 'SOLO' as const,
    state: 'DRAFT' as const,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  missions.insertMission(mission);
  const ready = transition(mission, 'READY');
  missions.transitionMission(ready, mission.state);
  const running = transition(ready, 'RUNNING');
  missions.transitionMission(running, ready.state);
  const run = missions.createRun(mission.id, now);
  const logicalPathHint = 'deliveries/picture.png';
  missions.appendMissionEvent({
    id: randomUUID(),
    missionId: mission.id,
    runId: run.id,
    eventType: 'generation.output_destination_bound',
    actorType: 'USER',
    actorId: 'local-user',
    payloadJson: { teammateId: teammate.id, logicalPathHint },
    createdAt: now,
  });
  missions.savePermissionRule({
    id: randomUUID(),
    subjectType: 'TEAMMATE',
    subjectId: teammate.id,
    capability: 'FILE_WRITE',
    scope: 'MISSION',
    scopeId: mission.id,
    resourcePattern: `file:${canonical}:*`,
    decision: deny ? 'DENY' : 'ALLOW',
  });
  return generation.create({
    targetTeammateId: teammate.id,
    capability: 'IMAGE_GENERATION',
    requiredFeatures: ['TEXT_TO_IMAGE'],
    prompt: '生成一张图片',
    inputs: [],
    parameters: {},
    expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
    outputDestination: { scope: 'MISSION_WORKSPACE', logicalPathHint },
    requester: { actorType: 'USER', actorId: 'local-user' },
    missionId: mission.id,
    runId: run.id,
    workflowRunId: null,
    workflowStepRunId: null,
  });
}
