import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@cultivation/shared';
import type {
  GenerationArtifact,
  GenerationJob,
  GenerationModelDescriptor,
  GenerationOutputDescriptor,
  GenerationTask,
} from '@cultivation/domain/g1-generation';
import { GenerationArtifactStore } from './g1-artifact-store.js';

const TEST_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.tmp');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const makeArtifactId = (jobId: string, outputId: string) =>
  createHash('sha256').update(jobId, 'utf8').update('\0').update(outputId, 'utf8').digest('hex');

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const name = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  };
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) rows[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = png(1, 1);

class MemoryGenerationRepository {
  private readonly artifacts = new Map<string, GenerationArtifact>();
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly tasks = new Map<string, GenerationTask>();
  add(job: GenerationJob, task: GenerationTask, artifact?: GenerationArtifact) {
    this.jobs.set(job.id, job);
    this.tasks.set(task.id, task);
    if (artifact) this.artifacts.set(artifact.id, artifact);
  }
  getArtifact(id: string) {
    return this.artifacts.get(id) ?? null;
  }
  getJob(id: string) {
    return this.jobs.get(id) ?? null;
  }
  getTask(id: string) {
    return this.tasks.get(id) ?? null;
  }
  listJobs() {
    return [...this.jobs.values()];
  }
  listArtifacts(jobId: string) {
    return [...this.artifacts.values()].filter((item) => item.jobId === jobId);
  }
}

function makeTask(
  id: string,
  scope: GenerationTask['outputDestination']['scope'] = 'APP_ARTIFACT_STORE',
  logicalPathHint: string | null = null,
): GenerationTask {
  const mission = scope === 'MISSION_WORKSPACE';
  return {
    id,
    targetTeammateId: 'teammate-1',
    capability: 'IMAGE_GENERATION',
    requiredFeatures: ['TEXT_TO_IMAGE'],
    prompt: 'draw a small blue square',
    inputs: [],
    parameters: {},
    expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
    outputDestination: { scope, logicalPathHint },
    requester: { actorType: 'USER', actorId: null },
    missionId: mission ? `mission-${id}` : null,
    runId: mission ? `run-${id}` : null,
    workflowRunId: null,
    workflowStepRunId: null,
    createdAt: '2026-10-05T00:00:00.000Z',
  };
}

function makeJob(task: GenerationTask, id = `job-${task.id}`): GenerationJob {
  return {
    id,
    generationTaskId: task.id,
    teammateId: task.targetTeammateId,
    runtimeProfileId: 'runtime-1',
    providerJobId: 'provider-job-1',
    idempotencyKey: task.id,
    requestFingerprint: 'f'.repeat(64),
    state: 'RUNNING',
    providerStatus: 'COMPLETED',
    outputArtifactIds: [],
    errorCode: null,
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
    completedAt: null,
  };
}

function makeDescriptor(): GenerationModelDescriptor {
  return {
    modelId: 'fixture-image-model',
    outputCapability: 'IMAGE_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: ['TEXT_TO_IMAGE'],
    inputRoles: [
      { role: 'REFERENCE', artifactKinds: ['IMAGE'], mimeTypes: ['image/png'], maxFiles: 2 },
    ],
    parameterSchema: { type: 'object' },
    outputTypes: ['image/png'],
    limits: {
      maxInputFiles: 2,
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      maxOutputs: 1,
    },
  };
}

function makeOutput(bytes = PNG, outputId = 'output-1'): GenerationOutputDescriptor {
  return {
    id: outputId,
    mimeType: 'image/png',
    extension: '.png',
    sizeBytes: bytes.byteLength,
    contentHash: sha256(bytes),
    metadata: { width: 1, height: 1, providerClaim: 'ignored' },
  };
}

async function fixture() {
  const root = path.join(TEST_BASE, `g1-artifact-store-${randomUUID()}`);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { root, workspace, userData: path.join(root, 'user-data') };
}

function makeStore(
  f: Awaited<ReturnType<typeof fixture>>,
  repository = new MemoryGenerationRepository(),
  options: {
    workspaceRoot?: () => string | null;
    authorize?: (
      task: GenerationTask,
      capability: 'FILE_READ' | 'FILE_WRITE',
      resource: string,
    ) => Promise<void>;
    maxBytes?: number;
    crash?: (point: 'STAGED' | 'COMMITTED', job: GenerationJob) => void;
  } = {},
) {
  return new GenerationArtifactStore({
    userData: f.userData,
    repository,
    workspaceRoot: options.workspaceRoot ?? (() => f.workspace),
    authorize: options.authorize ?? (async () => undefined),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.crash ? { crash: options.crash } : {}),
  });
}

describe('GenerationArtifactStore', () => {
  it('fingerprints canonical JSON and raw Uint8Array bytes with SHA-256', async () => {
    const f = await fixture();
    const store = makeStore(f);
    expect(store.fingerprint({ z: [2, 1], a: { y: true, x: null } })).toBe(
      store.fingerprint({ a: { x: null, y: true }, z: [2, 1] }),
    );
    expect(store.fingerprint(PNG)).toBe(sha256(PNG));
    expect(store.fingerprint({ values: [1, 2] })).not.toBe(store.fingerprint({ values: [2, 1] }));
  });

  it('derives PNG metadata from its checked header and reuses staged bytes after a crash', async () => {
    const f = await fixture();
    let crashed = false;
    const store = makeStore(f, new MemoryGenerationRepository(), {
      crash: (point) => {
        if (point === 'STAGED' && !crashed) {
          crashed = true;
          throw new Error('simulated process stop');
        }
      },
    });
    const task = makeTask('task-staged');
    const job = makeJob(task);
    const output = makeOutput();
    const download = vi.fn(async () => PNG);
    const commit = () => store.commit(job, task, makeDescriptor(), output, download);

    await expect(commit()).rejects.toThrow('simulated process stop');
    const artifact = await commit();
    expect(download).toHaveBeenCalledTimes(1);
    expect(artifact.id).toBe(makeArtifactId(job.id, output.id));
    expect(artifact.metadata).toEqual({ container: 'png', width: 1, height: 1 });
    expect(artifact.storageKey).toBe(`files/${artifact.id}.png`);
    const stored = await readFile(
      path.join(f.userData, 'generation-artifacts', ...artifact.storageKey.split('/')),
    );
    expect(stored.equals(PNG)).toBe(true);
  });

  it('reuses an already committed file after a crash without downloading or overwriting it', async () => {
    const f = await fixture();
    let crashed = false;
    const store = makeStore(f, new MemoryGenerationRepository(), {
      crash: (point) => {
        if (point === 'COMMITTED' && !crashed) {
          crashed = true;
          throw new Error('crash after publish');
        }
      },
    });
    const task = makeTask('task-committed');
    const job = makeJob(task);
    const output = makeOutput();
    const download = vi.fn(async () => PNG);
    const commit = () => store.commit(job, task, makeDescriptor(), output, download);

    await expect(commit()).rejects.toThrow('crash after publish');
    const artifact = await commit();
    expect(download).toHaveBeenCalledTimes(1);
    expect(artifact.contentHash).toBe(output.contentHash);
    await expect(
      store.commit(
        job,
        task,
        makeDescriptor(),
        { ...output, contentHash: '0'.repeat(64) },
        download,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY' });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('rejects a header-only MP4 instead of accepting fabricated media metadata', async () => {
    const f = await fixture();
    const store = makeStore(f);
    const task = {
      ...makeTask('task-mp4'),
      capability: 'VIDEO_GENERATION' as const,
      expectedOutput: { artifactKind: 'VIDEO' as const, mimeTypes: ['video/mp4'] },
    };
    const bytes = Buffer.alloc(20);
    bytes.writeUInt32BE(20);
    bytes.write('ftyp', 4, 'ascii');
    bytes.write('isom', 8, 'ascii');
    const output = {
      ...makeOutput(),
      mimeType: 'video/mp4',
      extension: '.mp4',
      sizeBytes: bytes.length,
      contentHash: sha256(bytes),
      metadata: {},
    };
    const descriptor = {
      ...makeDescriptor(),
      outputCapability: 'VIDEO_GENERATION' as const,
      outputTypes: ['video/mp4'],
    };
    await expect(
      store.commit(makeJob(task), task, descriptor, output, async () => bytes),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('snapshots a Mission Workspace root and refuses a later root change', async () => {
    const f = await fixture();
    let currentRoot = f.workspace;
    const store = makeStore(f, new MemoryGenerationRepository(), {
      workspaceRoot: () => currentRoot,
    });
    const task = makeTask('task-bound-root', 'MISSION_WORKSPACE', 'shot.png');
    await store.validateDestination(task);
    const binding = JSON.parse(
      await readFile(
        path.join(f.userData, 'generation-artifacts', 'bindings', `${task.id}.json`),
        'utf8',
      ),
    ) as { taskId: string; workspaceRoot: string };
    expect(binding).toEqual({ taskId: task.id, workspaceRoot: f.workspace });
    const moved = path.join(f.root, 'workspace-moved');
    await mkdir(moved);
    currentRoot = moved;

    await expect(store.validateDestination(task)).rejects.toMatchObject({
      code: 'WORKSPACE_CHANGED',
    });
    await expect(
      store.commit(makeJob(task), task, makeDescriptor(), makeOutput(), async () => PNG),
    ).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
  });

  it('commits Workspace files atomically under a safe relative hint and uses standard file permission resources', async () => {
    const f = await fixture();
    const repository = new MemoryGenerationRepository();
    const calls: Array<{ capability: string; resource: string }> = [];
    const store = makeStore(f, repository, {
      authorize: async (_task, capability, resource) => {
        calls.push({ capability, resource });
      },
    });
    const task = makeTask('task-workspace-output', 'MISSION_WORKSPACE', 'renders/shot');
    const job = makeJob(task);
    const artifact = await store.commit(job, task, makeDescriptor(), makeOutput(), async () => PNG);
    repository.add(job, task, artifact);
    await store.verify(artifact, task);
    const root = await import('node:fs/promises').then(({ realpath }) => realpath(f.workspace));
    expect(artifact.storageKey).toBe('renders/shot.png');
    expect((await readFile(path.join(f.workspace, 'renders', 'shot.png'))).equals(PNG)).toBe(true);
    expect(
      calls.filter((call) => call.capability === 'FILE_WRITE').map((call) => call.resource),
    ).toEqual([
      `file:${root}:renders/shot.png`,
      `file:${root}:renders/shot.png`,
      `file:${root}:renders/shot.png`,
    ]);

    const denied = new DomainError('PERMISSION_DENIED', 'write grant revoked');
    const deniedStore = makeStore(f, repository, {
      authorize: async (_task, capability) => {
        expect(capability).toBe('FILE_WRITE');
        throw denied;
      },
    });
    await expect(deniedStore.verify(artifact, task)).rejects.toBe(denied);
  });

  it('rejects unsafe paths, unknown MIME, and false PNG dimensions before publishing', async () => {
    const f = await fixture();
    const store = makeStore(f);
    const task = makeTask('task-invalid');
    const job = makeJob(task);
    const download = vi.fn(async () => PNG);
    await expect(
      store.commit(
        job,
        {
          ...task,
          outputDestination: { scope: 'APP_ARTIFACT_STORE', logicalPathHint: '../escape.png' },
        },
        makeDescriptor(),
        makeOutput(),
        download,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT_PATH' });
    await expect(
      store.commit(
        job,
        task,
        makeDescriptor(),
        { ...makeOutput(), mimeType: 'application/x-executable' },
        download,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(
      store.commit(
        job,
        task,
        makeDescriptor(),
        { ...makeOutput(), metadata: { width: 2, height: 1 } },
        download,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY' });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('commits and resolves only registered generation_artifacts', async () => {
    const f = await fixture();
    const repository = new MemoryGenerationRepository();
    const store = makeStore(f, repository);
    const sourceTask = makeTask('task-source');
    const sourceJob = makeJob(sourceTask);
    const artifact = await store.commit(
      sourceJob,
      sourceTask,
      makeDescriptor(),
      makeOutput(),
      async () => PNG,
    );
    repository.add(sourceJob, sourceTask, artifact);
    const consumerTask = makeTask('task-consumer');
    const resolved = await store.resolveInput(
      { artifactId: artifact.id, role: 'REFERENCE' },
      consumerTask,
    );
    expect(resolved).toMatchObject({
      artifactId: artifact.id,
      role: 'REFERENCE',
      kind: 'IMAGE',
      mimeType: 'image/png',
    });
    expect(Buffer.from(resolved.bytes).equals(PNG)).toBe(true);
    await expect(
      store.resolveInput(
        { artifactId: 'artifact-ref-from-renderer', role: 'REFERENCE' },
        consumerTask,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY' });
  });

  it('authorizes a Workspace input before reading its bytes and never grants permission from an ArtifactRef', async () => {
    const f = await fixture();
    const repository = new MemoryGenerationRepository();
    const denied = new DomainError('PERMISSION_DENIED', 'denied');
    const authorize = vi.fn(
      async (_task: GenerationTask, capability: 'FILE_READ' | 'FILE_WRITE', resource: string) => {
        expect(capability).toBe('FILE_READ');
        expect(resource).toBe(`file:${f.workspace}:untrusted.png`);
        throw denied;
      },
    );
    const store = makeStore(f, repository, { authorize });
    const sourceTask = makeTask('task-denied-source', 'MISSION_WORKSPACE', 'untrusted.png');
    const sourceJob = makeJob(sourceTask);
    await store.validateDestination(sourceTask);
    const invalidBytes = Buffer.from('not a PNG');
    await writeFile(path.join(f.workspace, 'untrusted.png'), invalidBytes, { flag: 'wx' });
    const fakeArtifact: GenerationArtifact = {
      id: makeArtifactId(sourceJob.id, 'output-1'),
      jobId: sourceJob.id,
      outputId: 'output-1',
      kind: 'IMAGE',
      mimeType: 'image/png',
      extension: '.png',
      sizeBytes: invalidBytes.length,
      contentHash: sha256(invalidBytes),
      metadata: {},
      storageScope: 'MISSION_WORKSPACE',
      storageKey: 'untrusted.png',
      createdAt: sourceTask.createdAt,
    };
    repository.add(sourceJob, sourceTask, fakeArtifact);

    await expect(
      store.resolveInput(
        { artifactId: fakeArtifact.id, role: 'REFERENCE' },
        makeTask('task-reader'),
      ),
    ).rejects.toBe(denied);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('rejects symlink or junction parents before committing a Workspace output', async ({
    skip,
  }) => {
    const f = await fixture();
    const outside = path.join(f.root, 'outside');
    await mkdir(outside);
    try {
      await symlink(
        outside,
        path.join(f.workspace, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      skip('Filesystem does not permit creating a symlink or junction');
      return;
    }
    const store = makeStore(f);
    const task = makeTask('task-symlink', 'MISSION_WORKSPACE', 'link/escape.png');
    await expect(
      store.commit(makeJob(task), task, makeDescriptor(), makeOutput(), async () => PNG),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_ESCAPE' });
  });
});
