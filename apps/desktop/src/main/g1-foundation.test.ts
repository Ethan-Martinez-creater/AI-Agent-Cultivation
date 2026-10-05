import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  openDatabase,
  Gate1SqliteRepository,
  Gate3SqliteRepository,
  Gate4SqliteRepository,
} from '@cultivation/persistence';
import { Gate1Service } from '@cultivation/application/gate1-service';
import { GenerationCrash } from '@cultivation/application/g1-generation';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { GenerationTask } from '@cultivation/domain/g1-generation';
import { generationFoundation } from './g1-foundation.js';
import { FakeGenerationGateway, UnconfiguredGenerationGateway } from './g1-fake-generation.js';
import { seedGenerationWorkspaceFixture } from './g1-fixture.js';

async function harness(crash?: (point: string) => void) {
  const root = join(process.cwd(), '.test-data', `g1-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  let db = openDatabase(join(root, 'data.sqlite'));
  const compose = () => {
    const store = new Gate1SqliteRepository(db);
    const missions = new Gate3SqliteRepository(db);
    const tools = new Gate4SqliteRepository(db);
    const foundation = generationFoundation({
      db,
      userData: root,
      store,
      missions,
      tools,
      permission: new PermissionEngine(missions),
      testOnly: true,
      crash,
    });
    const service = new Gate1Service(
      store,
      {
        encrypt: async (v) => new TextEncoder().encode(v),
        decrypt: async (v) => new TextDecoder().decode(v),
      },
      new FakeModelGateway(),
      undefined,
      foundation.gateway,
    );
    return { store, missions, tools, foundation, service };
  };
  let h = compose();
  const provider = h.service.createProvider({
    name: '生成服务',
    kind: 'OPENAI_COMPATIBLE',
    baseUrl: 'http://127.0.0.1:7788/v1',
  });
  const runtime = h.service.createRuntimeProfile({
    name: '图像模型',
    providerId: provider.id,
    credentialId: null,
    modelId: 'image-v1',
    executionProtocol: 'GENERATION',
  });
  const teammate = await h.service.createTeammate({
    name: '画师',
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtime.id,
  });
  const input: Omit<GenerationTask, 'id' | 'createdAt'> = {
    targetTeammateId: teammate.id,
    capability: 'IMAGE_GENERATION',
    requiredFeatures: ['TEXT_TO_IMAGE'],
    prompt: '一张清晰的图片',
    inputs: [],
    parameters: {},
    expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
    outputDestination: { scope: 'APP_ARTIFACT_STORE' },
    requester: { actorType: 'USER', actorId: 'local-user' },
    missionId: null,
    runId: null,
    workflowRunId: null,
    workflowStepRunId: null,
  };
  return {
    root,
    input,
    teammate,
    runtime,
    get db() {
      return db;
    },
    get h() {
      return h;
    },
    restart() {
      db.close();
      db = openDatabase(join(root, 'data.sqlite'));
      crash = undefined;
      h = compose();
    },
    close() {
      db.close();
    },
  };
}
describe('G1 durable execution and safe output foundation', () => {
  it('retains a safely committed output after transient SQLite registration failure and recovers it', async () => {
    const x = await harness();
    try {
      const job = await x.h.foundation.service.create(x.input);
      vi.spyOn(x.h.foundation.repository, 'registerOutput').mockImplementationOnce(() => {
        throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
      });
      await expect(x.h.foundation.service.advance(job.id)).rejects.toThrow(GenerationCrash);
      expect(x.h.foundation.service.detail(job.id).job.state).toBe('QUEUED');
      x.restart();
      await x.h.foundation.service.recover();
      expect(x.h.foundation.service.detail(job.id).job.state).toBe('COMPLETED');
      expect(x.h.foundation.service.detail(job.id).artifacts).toHaveLength(1);
      expect((x.h.foundation.gateway as FakeGenerationGateway).counters().downloads).toBe(1);
    } finally {
      x.close();
    }
  });
  it('creates a sealed GENERATION identity and completes only after trusted Artifact registration', async () => {
    const x = await harness();
    try {
      const job = await x.h.foundation.service.create(x.input);
      expect(job.state).toBe('PENDING');
      const done = await x.h.foundation.service.advance(job.id);
      expect(done.state).toBe('COMPLETED');
      const artifact = x.h.foundation.service.detail(job.id).artifacts[0]!;
      expect(artifact).toMatchObject({
        kind: 'IMAGE',
        mimeType: 'image/png',
        storageScope: 'APP_ARTIFACT_STORE',
      });
      expect(artifact.metadata).toMatchObject({ width: 1, height: 1 });
      expect(done.outputArtifactIds).toEqual([artifact.id]);
      expect(x.h.store.getModelBinding(x.teammate.id)?.executionProtocol).toBe('GENERATION');
      expect(x.h.foundation.gateway).toBeInstanceOf(FakeGenerationGateway);
    } finally {
      x.close();
    }
  });
  it.each(['UNKNOWN', 'INVALID_MIME', 'INVALID_HASH', 'MISSING', 'FAILED'] as const)(
    'provider %s never forges successful output',
    async (scenario) => {
      const x = await harness();
      try {
        const job = await x.h.foundation.service.create({ ...x.input, parameters: { scenario } });
        const result = await x.h.foundation.service.advance(job.id);
        expect(result.state).toBe(scenario === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED');
        expect(result.outputArtifactIds).toEqual([]);
        expect(x.h.foundation.service.detail(job.id).artifacts).toEqual([]);
        x.restart();
        await x.h.foundation.service.recover();
        expect((x.h.foundation.gateway as FakeGenerationGateway).counters().submissions).toBe(1);
      } finally {
        x.close();
      }
    },
  );
  it.each([
    'CREATED',
    'SUBMITTING',
    'SUBMISSION_SENT',
    'SUBMITTED',
    'PROVIDER_COMPLETED',
    'DOWNLOADING',
    'STAGED',
    'COMMITTED',
    'REGISTERED',
  ])('restart after %s does not duplicate generation or Artifact', async (point) => {
    const x = await harness((p) => {
      if (p === point) throw new GenerationCrash(point);
    });
    try {
      if (point === 'CREATED')
        await expect(x.h.foundation.service.create(x.input)).rejects.toThrow(GenerationCrash);
      else {
        const job = await x.h.foundation.service.create(x.input);
        await expect(x.h.foundation.service.advance(job.id)).rejects.toThrow(GenerationCrash);
      }
      const original = x.h.foundation.service.list()[0]!;
      if (point === 'PROVIDER_COMPLETED') {
        expect(original.state).toBe('QUEUED');
        expect(original.providerStatus).toBe('COMPLETED');
        expect(original.outputArtifactIds).toEqual([]);
      }
      const before = (x.h.foundation.gateway as FakeGenerationGateway).counters();
      x.restart();
      await x.h.foundation.service.recover();
      const recovered = x.h.foundation.service.detail(original.id);
      expect(recovered.job.state).toBe('COMPLETED');
      const after = (x.h.foundation.gateway as FakeGenerationGateway).counters();
      expect(after.submissions).toBe(1);
      expect(after.downloads).toBe(point === 'DOWNLOADING' ? 2 : 1);
      if (['STAGED', 'COMMITTED', 'REGISTERED'].includes(point))
        expect(after.downloads).toBe(before.downloads);
      expect(recovered.artifacts.length).toBe(1);
      const count = x.db.prepare('SELECT COUNT(*) AS n FROM generation_events').get();
      x.restart();
      await x.h.foundation.service.recover();
      expect(x.db.prepare('SELECT COUNT(*) AS n FROM generation_events').get()).toEqual(count);
      expect((x.h.foundation.gateway as FakeGenerationGateway).counters()).toEqual(after);
    } finally {
      x.close();
    }
  });
  it.each([
    { requiredFeatures: ['NOT_SUPPORTED'] },
    { inputs: [{ artifactId: 'absent', role: 'FORGED_ROLE' }] },
    { inputs: [{ artifactId: 'absent', role: 'REFERENCE' }] },
    { capability: 'VIDEO_GENERATION' },
  ])('rejects unsupported or nonexistent input before submission', async (change) => {
    const x = await harness();
    try {
      await expect(
        x.h.foundation.service.create({ ...x.input, ...change } as typeof x.input),
      ).rejects.toThrow();
      expect((x.h.foundation.gateway as FakeGenerationGateway).counters().submissions).toBe(0);
      expect(x.h.foundation.service.list()).toEqual([]);
    } finally {
      x.close();
    }
  });
  it('uses only trusted Artifact identity as a later input', async () => {
    const x = await harness();
    try {
      const first = await x.h.foundation.service.create(x.input);
      await x.h.foundation.service.advance(first.id);
      const artifact = x.h.foundation.service.detail(first.id).artifacts[0]!;
      const second = await x.h.foundation.service.create({
        ...x.input,
        requiredFeatures: ['REFERENCE_IMAGE'],
        inputs: [{ artifactId: artifact.id, role: 'REFERENCE' }],
      });
      expect((await x.h.foundation.service.advance(second.id)).state).toBe('COMPLETED');
      expect(x.h.foundation.repository.getTask(second.generationTaskId)?.inputs).toEqual([
        { artifactId: artifact.id, role: 'REFERENCE' },
      ]);
    } finally {
      x.close();
    }
  });
  it('rechecks an input hash before submit and rejects bytes changed after task creation', async () => {
    const x = await harness();
    try {
      const first = await x.h.foundation.service.create(x.input);
      await x.h.foundation.service.advance(first.id);
      const artifact = x.h.foundation.service.detail(first.id).artifacts[0]!;
      const next = await x.h.foundation.service.create({
        ...x.input,
        requiredFeatures: ['REFERENCE_IMAGE'],
        inputs: [{ artifactId: artifact.id, role: 'REFERENCE' }],
      });
      writeFileSync(
        join(x.root, 'generation-artifacts', artifact.storageKey),
        Buffer.from('changed'),
      );
      const result = await x.h.foundation.service.advance(next.id);
      expect(result.state).toBe('FAILED');
      expect(result.outputArtifactIds).toEqual([]);
      expect((x.h.foundation.gateway as FakeGenerationGateway).counters().submissions).toBe(1);
    } finally {
      x.close();
    }
  });
  it('Mission Workspace registration crash reuses committed output with the original write grant', async () => {
    const x = await harness((p) => {
      if (p === 'REGISTERED') throw new GenerationCrash(p);
    });
    try {
      const workspace = join(x.root, 'workspace');
      mkdirSync(workspace, { recursive: true });
      const job = await seedGenerationWorkspaceFixture(
        x.h.service,
        x.h.foundation.service,
        x.h.missions,
        x.h.tools,
        workspace,
        false,
      );
      await expect(x.h.foundation.service.advance(job.id)).rejects.toThrow(GenerationCrash);
      const before = (x.h.foundation.gateway as FakeGenerationGateway).counters();
      x.restart();
      await x.h.foundation.service.recover();
      expect(x.h.foundation.service.detail(job.id).job.state).toBe('COMPLETED');
      expect(x.h.foundation.service.detail(job.id).artifacts).toHaveLength(1);
      expect((x.h.foundation.gateway as FakeGenerationGateway).counters().downloads).toBe(
        before.downloads,
      );
    } finally {
      x.close();
    }
  });
  it('production composition has no Fake provider and refuses unsupported generation connection', async () => {
    const x = await harness();
    try {
      const prod = generationFoundation({
        db: x.db,
        userData: x.root,
        store: x.h.store,
        missions: x.h.missions,
        tools: x.h.tools,
        permission: new PermissionEngine(x.h.missions),
        testOnly: false,
      });
      expect(prod.gateway).toBeInstanceOf(UnconfiguredGenerationGateway);
      await expect(prod.service.create(x.input)).rejects.toMatchObject({
        code: 'GENERATION_ADAPTER_UNAVAILABLE',
      });
    } finally {
      x.close();
    }
  });
  it.each([false, true])(
    'Mission Workspace uses explicit binding and actual executor Permission, deny=%s',
    async (deny) => {
      const x = await harness();
      try {
        const workspace = join(x.root, 'workspace');
        mkdirSync(workspace, { recursive: true });
        const job = await seedGenerationWorkspaceFixture(
          x.h.service,
          x.h.foundation.service,
          x.h.missions,
          x.h.tools,
          workspace,
          deny,
        );
        const result = await x.h.foundation.service.advance(job.id);
        expect(result.state).toBe(deny ? 'FAILED' : 'COMPLETED');
        expect(existsSync(join(workspace, 'deliveries', 'picture.png'))).toBe(!deny);
        if (deny) expect(result.errorCode).toBe('PERMISSION_DENIED');
        else
          expect(x.h.foundation.service.detail(job.id).artifacts[0]?.storageScope).toBe(
            'MISSION_WORKSPACE',
          );
      } finally {
        x.close();
      }
    },
  );
  it('Renderer-style Mission destination has no authority without durable Main output binding', async () => {
    const x = await harness();
    try {
      await expect(
        x.h.foundation.service.create({
          ...x.input,
          missionId: 'forged',
          runId: 'forged',
          outputDestination: { scope: 'MISSION_WORKSPACE', logicalPathHint: 'image.png' },
        }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' });
      expect((x.h.foundation.gateway as FakeGenerationGateway).counters().submissions).toBe(0);
    } finally {
      x.close();
    }
  });
});
