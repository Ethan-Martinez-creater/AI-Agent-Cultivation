import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import { Gate1Service } from '@cultivation/application/gate1-service';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import { transition } from '@cultivation/domain';
import type { GenerationTask } from '@cultivation/domain/g1-generation';
import {
  Gate1SqliteRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
  openDatabase,
} from '@cultivation/persistence';
import { G3SqliteRepository } from '@cultivation/persistence/g3-execution';
import { generationFoundation } from './g1-foundation.js';
import { GenerationArtifactSharingService } from './generation-artifact-sharing.js';

async function harness() {
  const root = join(process.cwd(), '.test-data', `generation-sharing-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, 'data.sqlite'));
  const store = new Gate1SqliteRepository(db);
  const missions = new Gate3SqliteRepository(db);
  const tools = new Gate4SqliteRepository(db);
  const generation = generationFoundation({
    db,
    userData: root,
    store,
    missions,
    tools,
    permission: new PermissionEngine(missions),
    testOnly: true,
  });
  const gate1 = new Gate1Service(
    store,
    {
      encrypt: async (value) => new TextEncoder().encode(value),
      decrypt: async (value) => new TextDecoder().decode(value),
    },
    new FakeModelGateway(),
    undefined,
    generation.gateway,
  );
  const provider = gate1.createProvider({
    name: 'Artifact sharing test',
    kind: 'OPENAI_COMPATIBLE',
    baseUrl: 'http://127.0.0.1:7788/v1',
  });
  const runtime = gate1.createRuntimeProfile({
    name: 'Image runtime',
    providerId: provider.id,
    credentialId: null,
    modelId: 'image-v1',
    executionProtocol: 'GENERATION',
  });
  const teammate = await gate1.createTeammate({
    name: 'Image maker',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtime.id,
  });

  const at = new Date().toISOString();
  const draft = {
    id: randomUUID(),
    title: 'Artifact sharing mission',
    objective: 'Share a generated image into the current run',
    initiatorType: 'USER' as const,
    initiatorId: 'local-user',
    coordinatorTeammateId: teammate.id,
    partyId: null,
    mode: 'SOLO' as const,
    state: 'DRAFT' as const,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  };
  missions.insertMission(draft);
  const ready = transition(draft, 'READY', at);
  expect(missions.transitionMission(ready, 'DRAFT')).toBe(true);
  const running = transition(ready, 'RUNNING', at);
  expect(missions.transitionMission(running, 'READY')).toBe(true);
  const sourceRun = missions.createRun(draft.id, at);

  const task: Omit<GenerationTask, 'id' | 'createdAt'> = {
    targetTeammateId: teammate.id,
    capability: 'IMAGE_GENERATION',
    requiredFeatures: ['TEXT_TO_IMAGE'],
    prompt: 'Generate a small image for sharing tests',
    inputs: [],
    parameters: {},
    expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
    outputDestination: { scope: 'APP_ARTIFACT_STORE' },
    requester: { actorType: 'USER', actorId: 'local-user' },
    missionId: draft.id,
    runId: sourceRun.id,
    workflowRunId: null,
    workflowStepRunId: null,
  };
  const job = await generation.service.create(task);
  await generation.service.advance(job.id);
  const artifact = generation.repository.listArtifacts(job.id)[0]!;
  const currentRun = missions.createRun(draft.id, new Date(Date.now() + 1).toISOString());
  const execution = new G3SqliteRepository(db);
  const artifacts = generation.artifacts;
  const service = new GenerationArtifactSharingService({
    missions,
    execution,
    generation: generation.repository,
    artifacts,
  });

  return {
    root,
    db,
    missions,
    execution,
    generation: generation.repository,
    artifacts,
    service,
    missionId: draft.id,
    sourceRun,
    currentRun,
    job,
    artifact,
    close: () => db.close(),
  };
}

function expectedRef(artifact: {
  id: string;
  kind: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
}) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
  };
}

describe('GenerationArtifactSharingService', () => {
  it('shares verified media idempotently into the latest run without granting file permissions', async () => {
    const h = await harness();
    try {
      const mission = h.missions.getMission(h.missionId)!;
      const paused = transition(mission, 'PAUSED', new Date().toISOString());
      expect(h.missions.transitionMission(paused, mission.state)).toBe(true);
      const before = h.db.prepare('SELECT COUNT(*) AS count FROM permission_rules').get() as {
        count: number;
      };
      const input = {
        missionId: h.missionId,
        runId: h.currentRun.id,
        artifactId: h.artifact.id,
      };

      const first = await h.service.share(input);
      const second = await h.service.share(input);
      const events = h.missions
        .listMissionEvents(h.missionId)
        .filter(
          (event) =>
            event.runId === h.currentRun.id && event.eventType === 'collaboration.artifact_shared',
        );
      const audits = h.missions
        .listAuditEvents(h.missionId)
        .filter(
          (event) =>
            event.action === 'collaboration.artifact_shared' &&
            event.targetType === 'MISSION_RUN' &&
            event.targetId === h.currentRun.id,
        );
      const refs = h.execution.listArtifactRefs(h.missionId, h.currentRun.id);
      const after = h.db.prepare('SELECT COUNT(*) AS count FROM permission_rules').get() as {
        count: number;
      };
      const payload = {
        sourceJobId: h.job.id,
        artifactId: h.artifact.id,
        kind: h.artifact.kind,
        mimeType: h.artifact.mimeType,
        contentHash: h.artifact.contentHash,
        sizeBytes: h.artifact.sizeBytes,
      };

      expect(first).toEqual(expectedRef(h.artifact));
      expect(second).toEqual(first);
      expect(Object.keys(first).sort()).toEqual(
        ['contentHash', 'id', 'kind', 'mimeType', 'sizeBytes'].sort(),
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'collaboration.artifact_shared',
        actorType: 'USER',
        actorId: 'local-user',
        payloadJson: payload,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'collaboration.artifact_shared',
        actorType: 'USER',
        actorId: 'local-user',
        payloadJson: payload,
      });
      expect(refs).toEqual([expectedRef(h.artifact)]);
      expect(after.count).toBe(before.count);
    } finally {
      h.close();
    }
  });

  it('rejects a previous run and keeps its ArtifactRef separate from the latest run', async () => {
    const h = await harness();
    try {
      await expect(
        h.service.share({
          missionId: h.missionId,
          runId: h.sourceRun.id,
          artifactId: h.artifact.id,
        }),
      ).rejects.toMatchObject({ code: 'RUN_NOT_CURRENT' });
      expect(h.execution.listArtifactRefs(h.missionId, h.sourceRun.id)).toEqual([]);

      await h.service.share({
        missionId: h.missionId,
        runId: h.currentRun.id,
        artifactId: h.artifact.id,
      });
      expect(h.execution.listArtifactRefs(h.missionId, h.sourceRun.id)).toEqual([]);
      expect(h.execution.listArtifactRefs(h.missionId, h.currentRun.id)).toEqual([
        expectedRef(h.artifact),
      ]);
    } finally {
      h.close();
    }
  });

  it('fails closed when the committed media file no longer matches its registered hash', async () => {
    const h = await harness();
    try {
      const path = join(h.root, 'generation-artifacts', ...h.artifact.storageKey.split('/'));
      const bytes = readFileSync(path);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
      writeFileSync(path, bytes);

      await expect(
        h.service.share({
          missionId: h.missionId,
          runId: h.currentRun.id,
          artifactId: h.artifact.id,
        }),
      ).rejects.toThrow();
      expect(
        h.missions
          .listMissionEvents(h.missionId)
          .filter((event) => event.eventType === 'collaboration.artifact_shared'),
      ).toEqual([]);
      expect(h.execution.listArtifactRefs(h.missionId, h.currentRun.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('rejects Workspace output before file verification or recording share facts', async () => {
    const h = await harness();
    try {
      vi.spyOn(h.generation, 'getArtifact').mockReturnValue({
        ...h.artifact,
        storageScope: 'MISSION_WORKSPACE',
      });
      const verify = vi.spyOn(h.artifacts, 'verify');

      await expect(
        h.service.share({
          missionId: h.missionId,
          runId: h.currentRun.id,
          artifactId: h.artifact.id,
        }),
      ).rejects.toMatchObject({ code: 'ARTIFACT_PROVENANCE' });
      expect(verify).not.toHaveBeenCalled();
      expect(
        h.missions
          .listMissionEvents(h.missionId)
          .filter((event) => event.eventType === 'collaboration.artifact_shared'),
      ).toEqual([]);
      expect(h.execution.listArtifactRefs(h.missionId, h.currentRun.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('rejects a forged USER event as an APPROVED_IMPORT source at the SQLite boundary', async () => {
    const h = await harness();
    try {
      const forgedEventId = randomUUID();
      h.missions.appendMissionEvent({
        id: forgedEventId,
        missionId: h.missionId,
        runId: h.currentRun.id,
        eventType: 'collaboration.artifact_shared',
        actorType: 'USER',
        actorId: 'local-user',
        payloadJson: {
          sourceJobId: h.job.id,
          artifactId: h.artifact.id,
          kind: h.artifact.kind,
          mimeType: h.artifact.mimeType,
          contentHash: '0'.repeat(64),
          sizeBytes: h.artifact.sizeBytes,
        },
        createdAt: new Date().toISOString(),
      });

      expect(() =>
        h.execution.registerArtifactRef(h.missionId, h.currentRun.id, expectedRef(h.artifact), {
          type: 'APPROVED_IMPORT',
          id: forgedEventId,
        }),
      ).toThrow('ArtifactRef must be a persisted same-Run Artifact or an explicit approved import');
      expect(h.execution.listArtifactRefs(h.missionId, h.currentRun.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('enforces the 16 Artifact share limit per current Run', async () => {
    const h = await harness();
    try {
      for (let index = 0; index < 16; index++) {
        h.missions.appendMissionEvent({
          id: randomUUID(),
          missionId: h.missionId,
          runId: h.currentRun.id,
          eventType: 'collaboration.artifact_shared',
          actorType: 'USER',
          actorId: 'local-user',
          payloadJson: {
            sourceJobId: `source-job-${index}`,
            artifactId: `artifact-${index}`,
            kind: 'IMAGE',
            mimeType: 'image/png',
            contentHash: 'a'.repeat(64),
            sizeBytes: 12,
          },
          createdAt: new Date().toISOString(),
        });
      }

      await expect(
        h.service.share({
          missionId: h.missionId,
          runId: h.currentRun.id,
          artifactId: h.artifact.id,
        }),
      ).rejects.toMatchObject({ code: 'ARTIFACT_SHARE_LIMIT' });
      expect(
        h.missions
          .listMissionEvents(h.missionId)
          .filter(
            (event) =>
              event.runId === h.currentRun.id &&
              event.eventType === 'collaboration.artifact_shared',
          ),
      ).toHaveLength(16);
      expect(h.execution.listArtifactRefs(h.missionId, h.currentRun.id)).toEqual([]);
    } finally {
      h.close();
    }
  });
});
