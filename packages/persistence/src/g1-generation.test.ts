import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  GenerationArtifact,
  GenerationJob,
  GenerationModelDescriptor,
  GenerationTask,
} from '@cultivation/domain/g1-generation';
import { GenerationSqliteRepository } from './g1-generation.js';

const timestamp = '2026-10-05T08:00:00.000Z';
const generationSql = readFileSync(
  new URL('../../../migrations/0027_g1_generation_foundation.sql', import.meta.url),
  'utf8',
);
const generationDdl = generationSql.slice(generationSql.indexOf('CREATE TABLE generation_tasks'));

function createDatabase(executionProtocol = 'GENERATION'): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE runtime_profiles (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      execution_protocol TEXT NOT NULL
    );
    CREATE TABLE teammates (
      id TEXT PRIMARY KEY,
      executor_kind TEXT NOT NULL,
      system_kind TEXT,
      current_runtime_profile_id TEXT
    );
    CREATE TABLE teammate_model_bindings (
      teammate_id TEXT PRIMARY KEY REFERENCES teammates(id),
      runtime_profile_id TEXT NOT NULL UNIQUE REFERENCES runtime_profiles(id),
      execution_protocol TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO runtime_profiles VALUES (?, ?, ?)').run(
    'runtime-generation',
    'minimax-h3',
    executionProtocol,
  );
  db.prepare('INSERT INTO teammates VALUES (?, ?, ?, ?)').run(
    'teammate-generation',
    'MODEL_RUNTIME',
    null,
    'runtime-generation',
  );
  db.prepare('INSERT INTO teammate_model_bindings VALUES (?, ?, ?)').run(
    'teammate-generation',
    'runtime-generation',
    executionProtocol,
  );
  db.exec(generationDdl);
  return db;
}

function makeTask(id = 'task-1'): GenerationTask {
  return {
    id,
    targetTeammateId: 'teammate-generation',
    capability: 'VIDEO_GENERATION',
    requiredFeatures: ['TEXT_TO_VIDEO'],
    prompt: 'A sunrise over a quiet lake.',
    inputs: [],
    parameters: { durationSeconds: 5 },
    expectedOutput: { artifactKind: 'VIDEO', mimeTypes: ['video/mp4'] },
    outputDestination: { scope: 'APP_ARTIFACT_STORE' },
    requester: { actorType: 'USER', actorId: 'user-1' },
    missionId: null,
    runId: null,
    workflowRunId: null,
    workflowStepRunId: null,
    createdAt: timestamp,
  };
}

function makeDescriptor(): GenerationModelDescriptor {
  return {
    modelId: 'minimax-h3',
    outputCapability: 'VIDEO_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: ['TEXT_TO_VIDEO'],
    inputRoles: [],
    parameterSchema: { type: 'object' },
    outputTypes: ['video/mp4'],
    limits: {
      minDurationSeconds: 4,
      maxDurationSeconds: 15,
      maxInputFiles: 2,
      maxInputBytes: 1024,
      maxOutputBytes: 1024 * 1024,
      maxOutputs: 2,
    },
  };
}

function makeJob(task: GenerationTask, id = 'job-1'): GenerationJob {
  return {
    id,
    generationTaskId: task.id,
    teammateId: task.targetTeammateId,
    runtimeProfileId: 'runtime-generation',
    providerJobId: null,
    idempotencyKey: task.id,
    requestFingerprint: 'a'.repeat(64),
    state: 'PENDING',
    providerStatus: null,
    outputArtifactIds: [],
    errorCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

function makeArtifact(
  jobId = 'job-1',
  overrides: Partial<GenerationArtifact> = {},
): GenerationArtifact {
  return {
    id: 'artifact-1',
    jobId,
    outputId: 'provider-output-1',
    kind: 'VIDEO',
    mimeType: 'video/mp4',
    extension: '.mp4',
    sizeBytes: 128,
    contentHash: 'b'.repeat(64),
    metadata: { durationSeconds: 5, width: 832, height: 480 },
    storageScope: 'APP_ARTIFACT_STORE',
    storageKey: 'objects/store-key-1.mp4',
    createdAt: timestamp,
    ...overrides,
  };
}

function create(
  repository: GenerationSqliteRepository,
  task = makeTask(),
  job = makeJob(task),
): void {
  repository.create(task, makeDescriptor(), job);
}

function submit(repository: GenerationSqliteRepository, id = 'job-1'): void {
  repository.transition(id, 'PENDING', 'SUBMITTING');
  repository.transition(id, 'SUBMITTING', 'QUEUED', {
    providerJobId: `provider-${id}`,
    providerStatus: 'queued',
  });
}

describe('G1 Generation persistence', () => {
  it('stores immutable snapshots and treats an exact task replay as idempotent', () => {
    const db = createDatabase();
    const repository = new GenerationSqliteRepository(db);
    const task = makeTask();
    const descriptor = makeDescriptor();
    const job = makeJob(task);

    repository.create(task, descriptor, job);
    repository.transition(job.id, 'PENDING', 'SUBMITTING');
    repository.create(task, descriptor, job);

    expect(repository.getTask(task.id)).toEqual(task);
    expect(repository.getDescriptor(task.id)).toEqual(descriptor);
    expect(repository.getJob(job.id)?.state).toBe('SUBMITTING');
    expect(db.prepare('SELECT count(*) AS count FROM generation_jobs').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT count(*) AS count FROM generation_events').get()).toEqual({
      count: 3,
    });
    const eventColumns = db.pragma('table_info(generation_events)') as { name: string }[];
    expect(eventColumns.map(({ name }) => name)).not.toContain('prompt');
    expect(eventColumns.map(({ name }) => name)).not.toContain('payload_json');

    expect(() =>
      repository.create({ ...task, prompt: 'Changed payload.' }, descriptor, job),
    ).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() =>
      db.prepare('UPDATE generation_tasks SET task_json = ? WHERE id = ?').run('{}', task.id),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare('UPDATE generation_jobs SET teammate_id = ? WHERE id = ?').run('other', job.id),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare('UPDATE generation_events SET error_code = ? WHERE id = 1').run('LEAK'),
    ).toThrow(/append-only/);
    db.close();
  });

  it('rejects a Runtime that is not the teammate sealed GENERATION identity atomically', () => {
    const db = createDatabase('LANGUAGE');
    const repository = new GenerationSqliteRepository(db);
    const task = makeTask();

    expect(() => create(repository, task)).toThrow(/sealed GENERATION Runtime/);
    expect(db.prepare('SELECT count(*) AS count FROM generation_tasks').get()).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT count(*) AS count FROM generation_jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM generation_events').get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it('uses compare-and-swap transitions and excludes UNKNOWN from recovery', () => {
    const db = createDatabase();
    const repository = new GenerationSqliteRepository(db);
    const first = makeTask();
    create(repository, first);

    repository.transition('job-1', 'PENDING', 'SUBMITTING');
    repository.transition('job-1', 'SUBMITTING', 'QUEUED', {
      providerJobId: 'provider-job-1',
      providerStatus: 'queued',
    });
    expect(() => repository.transition('job-1', 'SUBMITTING', 'QUEUED')).toThrow(
      /compare-and-swap conflict/,
    );
    expect(() => repository.transition('job-1', 'QUEUED', 'COMPLETED')).toThrow(/Use complete\(\)/);
    repository.transition('job-1', 'QUEUED', 'RUNNING', { providerStatus: 'running' });
    expect(repository.getJob('job-1')?.providerJobId).toBe('provider-job-1');

    const second = makeTask('task-2');
    create(repository, second, makeJob(second, 'job-2'));
    repository.transition('job-2', 'PENDING', 'SUBMITTING');
    repository.transition('job-2', 'SUBMITTING', 'UNKNOWN', {
      errorCode: 'SUBMISSION_STATE_UNKNOWN',
    });
    expect(repository.listRecoverableJobs().map(({ id }) => id)).toEqual(['job-1']);
    expect(repository.listJobs().map(({ id }) => id)).toEqual(['job-1', 'job-2']);
    expect(() =>
      db
        .prepare('UPDATE generation_jobs SET provider_job_id = ? WHERE id = ?')
        .run('replacement', 'job-1'),
    ).toThrow(/provider Job identity/);
    db.close();
  });

  it('registers each verified output once and rejects a changed hash for the same provider output', () => {
    const db = createDatabase();
    const repository = new GenerationSqliteRepository(db);
    create(repository);
    submit(repository);

    const artifact = makeArtifact();
    const first = repository.registerOutput('job-1', artifact);
    const replay = repository.registerOutput('job-1', { ...artifact, id: 'artifact-retry' });
    expect(replay.id).toBe(first.id);
    expect(repository.listArtifacts('job-1')).toHaveLength(1);
    expect(repository.getJob('job-1')?.outputArtifactIds).toEqual(['artifact-1']);
    expect(() =>
      repository.registerOutput('job-1', { ...artifact, contentHash: 'c'.repeat(64) }),
    ).toThrow(/another hash/);
    expect(() =>
      repository.registerOutput('job-1', {
        ...artifact,
        id: 'artifact-bytes',
        outputId: 'provider-output-bytes',
        metadata: {
          bytes: Uint8Array.from([1, 2, 3]),
        } as unknown as GenerationArtifact['metadata'],
      }),
    ).toThrow(/metadata must be a bounded object/);
    expect(() =>
      repository.registerOutput('job-1', {
        ...artifact,
        id: 'artifact-path',
        outputId: 'provider-output-path',
        storageKey: '../outside.mp4',
      }),
    ).toThrow(/authorized opaque store key/);
    expect(() =>
      db
        .prepare('UPDATE generation_artifacts SET storage_key = ? WHERE id = ?')
        .run('other', artifact.id),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare('DELETE FROM generation_artifacts WHERE id = ?').run(artifact.id),
    ).toThrow(/retained/);
    db.close();
  });

  it('accepts safe Main ArtifactStore keys and bound Mission Workspace relative paths', () => {
    const db = createDatabase();
    const repository = new GenerationSqliteRepository(db);
    const task = {
      ...makeTask('task-workspace'),
      outputDestination: {
        scope: 'MISSION_WORKSPACE' as const,
        logicalPathHint: 'deliveries/picture.mp4',
      },
    };
    const job = makeJob(task, 'job-workspace');
    repository.create(task, makeDescriptor(), job);
    submit(repository, job.id);

    const artifact = makeArtifact(job.id, {
      id: 'workspace-artifact',
      outputId: 'provider-output-workspace',
      storageScope: 'MISSION_WORKSPACE',
      storageKey: 'deliveries/picture.mp4',
    });
    expect(repository.registerOutput(job.id, artifact)).toEqual(artifact);
    expect(() =>
      repository.registerOutput(job.id, {
        ...artifact,
        id: 'workspace-drive-path',
        outputId: 'provider-output-drive-path',
        storageKey: 'C:/outside.mp4',
      }),
    ).toThrow(/authorized opaque store key/);
    db.close();
  });

  it('completes atomically only after every output is registered', () => {
    const db = createDatabase();
    const repository = new GenerationSqliteRepository(db);
    create(repository);
    submit(repository);
    const beforeEvents = (
      db.prepare('SELECT count(*) AS count FROM generation_events').get() as { count: number }
    ).count;

    expect(() => repository.complete('job-1', 'QUEUED', ['missing-artifact'])).toThrow(
      /registered outputs/,
    );
    expect(repository.getJob('job-1')?.state).toBe('QUEUED');
    expect(
      (db.prepare('SELECT count(*) AS count FROM generation_events').get() as { count: number })
        .count,
    ).toBe(beforeEvents);
    expect(() =>
      db
        .prepare(`UPDATE generation_jobs SET state = 'COMPLETED', completed_at = ? WHERE id = ?`)
        .run(timestamp, 'job-1'),
    ).toThrow(/outputs must be registered/);

    const artifact = repository.registerOutput('job-1', makeArtifact());
    const completed = repository.complete('job-1', 'QUEUED', [artifact.id]);
    expect(completed.state).toBe('COMPLETED');
    expect(completed.outputArtifactIds).toEqual([artifact.id]);
    expect(completed.completedAt).not.toBeNull();
    expect(repository.listRecoverableJobs()).toEqual([]);
    const events = db
      .prepare('SELECT event_type, from_state, to_state FROM generation_events ORDER BY id')
      .all();
    expect(events).toContainEqual({
      event_type: 'generation.job_completed',
      from_state: 'QUEUED',
      to_state: 'COMPLETED',
    });
    expect(() => repository.transition('job-1', 'COMPLETED', 'FAILED')).toThrow(
      /Invalid GenerationJob transition/,
    );
    db.close();
  });
});
