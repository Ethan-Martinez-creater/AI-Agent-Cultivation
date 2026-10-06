import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  G3ExecutionCrash,
  G3ExecutionService,
  type G3CrashPoint,
} from '@cultivation/application/g3-execution-service';
import { G3SqliteRepository } from '@cultivation/persistence/g3-execution';
import {
  G3_EXECUTION_POLICY,
  parseParticipantOutcome,
  type ExecutionTask,
} from '@cultivation/domain/g3-execution';
import type {
  GenerationJob,
  GenerationModelDescriptor,
  GenerationTask,
} from '@cultivation/domain/g1-generation';

const migrationCandidates = [
  fileURLToPath(
    new URL('../../../migrations/0030_g3_multimodal_collaboration.sql', import.meta.url),
  ),
  resolve(process.cwd(), 'migrations', '0030_g3_multimodal_collaboration.sql'),
  resolve(process.cwd(), '..', '..', 'migrations', '0030_g3_multimodal_collaboration.sql'),
];
const migrationPath = migrationCandidates.find(existsSync);
if (!migrationPath) throw new Error('Cannot find the current G3 migration 0030');
const migration = readFileSync(migrationPath, 'utf8');
const timestamp = '2026-10-06T08:00:00.000Z';
const descriptor: GenerationModelDescriptor = {
  modelId: 'model-image-1',
  outputCapability: 'IMAGE_GENERATION',
  executionMode: 'ASYNC_JOB',
  featureTags: ['TEXT_TO_IMAGE'],
  inputRoles: [],
  parameterSchema: {},
  outputTypes: ['IMAGE'],
  limits: { maxInputFiles: 0, maxInputBytes: 0, maxOutputBytes: 100_000, maxOutputs: 1 },
};

type PlannedJob = { state: 'COMPLETED' | 'FAILED' | 'UNKNOWN'; errorCode?: string };
type Metrics = { creates: number; advances: number; languageCalls: number };

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE missions (id TEXT PRIMARY KEY, coordinator_teammate_id TEXT NOT NULL);
    CREATE TABLE mission_runs (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'RUNNING'
    );
    CREATE TABLE mission_participants (
      mission_id TEXT NOT NULL, teammate_id TEXT NOT NULL, role TEXT NOT NULL,
      PRIMARY KEY(mission_id, teammate_id)
    );
    CREATE TABLE collaboration_requests (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, run_id TEXT NOT NULL,
      requester_teammate_id TEXT NOT NULL, target_teammate_id TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY);
    CREATE TABLE workflow_versions (definition_id TEXT, version INTEGER, version_json TEXT);
    CREATE TABLE workflow_steps (
      definition_id TEXT, version INTEGER, id TEXT, outputs_json TEXT DEFAULT '[]'
    );
    CREATE TABLE workflow_artifacts (
      id TEXT PRIMARY KEY, content TEXT, content_hash TEXT, workflow_run_id TEXT,
      metadata_json TEXT, producer_step_run_id TEXT, mission_id TEXT, mission_run_id TEXT,
      actor_id TEXT, source TEXT, kind TEXT
    );
    CREATE TABLE workflow_artifact_bindings (artifact_id TEXT, role TEXT, step_run_id TEXT);
    CREATE TABLE workflow_validation_receipts (artifact_id TEXT, valid INTEGER, content_hash TEXT);
    CREATE TABLE workflow_step_runs (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, mission_id TEXT, mission_run_id TEXT,
      step_id TEXT, state TEXT
    );
    CREATE TABLE mission_events (
      id TEXT PRIMARY KEY, mission_id TEXT, run_id TEXT, actor_type TEXT, actor_id TEXT,
      event_type TEXT, payload_json TEXT
    );
    CREATE TABLE providers (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE runtime_profiles (
      id TEXT PRIMARY KEY, model_id TEXT NOT NULL, execution_protocol TEXT NOT NULL, provider_id TEXT
    );
    CREATE TABLE teammates (
      id TEXT PRIMARY KEY, executor_kind TEXT NOT NULL, system_kind TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE', current_runtime_profile_id TEXT, routing_policy TEXT NOT NULL DEFAULT 'NORMAL'
    );
    CREATE TABLE teammate_model_bindings (
      teammate_id TEXT NOT NULL, runtime_profile_id TEXT NOT NULL, execution_protocol TEXT NOT NULL
    );
    CREATE TABLE parties (id TEXT PRIMARY KEY, coordinator_teammate_id TEXT NOT NULL);
    CREATE TABLE generation_tasks (
      id TEXT PRIMARY KEY, target_teammate_id TEXT NOT NULL, task_json TEXT NOT NULL,
      descriptor_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY, generation_task_id TEXT NOT NULL UNIQUE,
      teammate_id TEXT NOT NULL, runtime_profile_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'PENDING', output_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT, recovery_result TEXT NOT NULL
    );
    CREATE TABLE generation_artifacts (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL,
      content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_scope TEXT NOT NULL
    );
    CREATE TABLE external_work_requests (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, run_id TEXT NOT NULL,
      requester_teammate_id TEXT NOT NULL, assignee_teammate_id TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE external_work_artifacts (
      id TEXT PRIMARY KEY, external_work_request_id TEXT NOT NULL,
      mime_type TEXT, size_bytes INTEGER NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
      extension TEXT NOT NULL DEFAULT '.png'
    );
  `);
  db.exec(migration);
  db.exec(`
    INSERT INTO missions VALUES ('mission-1', 'coordinator-1');
    INSERT INTO mission_runs VALUES ('run-1', 'mission-1', 1, 'RUNNING');
    INSERT INTO mission_participants VALUES ('mission-1', 'coordinator-1', 'COORDINATOR');
    INSERT INTO mission_participants VALUES ('mission-1', 'participant-1', 'MEMBER');
    INSERT INTO mission_participants VALUES ('mission-1', 'participant-2', 'MEMBER');
    INSERT INTO mission_participants VALUES ('mission-1', 'language-1', 'MEMBER');
    INSERT INTO runtime_profiles VALUES ('runtime-language', 'language-model', 'LANGUAGE', NULL);
    INSERT INTO runtime_profiles VALUES ('runtime-generation', 'image-model', 'GENERATION', NULL);
    INSERT INTO teammates VALUES ('coordinator-1', 'MODEL_RUNTIME', NULL, 'ACTIVE', 'runtime-language', 'NORMAL');
    INSERT INTO teammates VALUES ('participant-1', 'MODEL_RUNTIME', NULL, 'ACTIVE', 'runtime-generation', 'NORMAL');
    INSERT INTO teammates VALUES ('participant-2', 'MODEL_RUNTIME', NULL, 'ACTIVE', 'runtime-generation', 'NORMAL');
    INSERT INTO teammates VALUES ('language-1', 'MODEL_RUNTIME', NULL, 'ACTIVE', 'runtime-language', 'NORMAL');
    INSERT INTO teammate_model_bindings VALUES ('coordinator-1', 'runtime-language', 'LANGUAGE');
    INSERT INTO teammate_model_bindings VALUES ('participant-1', 'runtime-generation', 'GENERATION');
    INSERT INTO teammate_model_bindings VALUES ('participant-2', 'runtime-generation', 'GENERATION');
    INSERT INTO teammate_model_bindings VALUES ('language-1', 'runtime-language', 'LANGUAGE');
    INSERT INTO collaboration_requests VALUES (
      'request-generation', 'mission-1', 'run-1', 'coordinator-1', 'participant-1', 'APPROVED'
    );
    INSERT INTO collaboration_requests VALUES (
      'request-language', 'mission-1', 'run-1', 'coordinator-1', 'language-1', 'APPROVED'
    );
  `);
  return db;
}

function makeTask(protocol: 'LANGUAGE' | 'GENERATION', id: string): ExecutionTask {
  const generation = protocol === 'GENERATION';
  const requestId = generation ? 'request-generation' : 'request-language';
  return {
    id,
    logicalKey: `${requestId}:${id}`,
    source: 'COLLABORATION',
    missionId: 'mission-1',
    runId: 'run-1',
    collaborationRequestId: requestId,
    workflowRunId: null,
    workflowStepRunId: null,
    requesterTeammateId: 'coordinator-1',
    coordinatorTeammateId: 'coordinator-1',
    targetTeammateId: generation ? 'participant-1' : 'language-1',
    requiredCapability: generation ? 'IMAGE_GENERATION' : 'GENERAL_REASONING',
    executionProtocol: protocol,
    publicTask: `Task ${id}`,
    publicContext: 'Recovery test context.',
    artifactInputs: [],
    generationRequirements: generation
      ? {
          capability: 'IMAGE_GENERATION',
          requiredFeatures: ['TEXT_TO_IMAGE'],
          prompt: 'Generate one bounded test image.',
          parameters: {},
          expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
          outputDestination: { scope: 'APP_ARTIFACT_STORE' },
          inputRequirements: [],
        }
      : null,
    acceptanceCriteria: ['Return a bounded result.'],
    inputRequirements: [],
    dependencyRole: null,
    reviewOf: [],
    parentTaskId: null,
    retryNo: 0,
    continuationRound: 0,
    policyVersion: G3_EXECUTION_POLICY.version,
    createdAt: timestamp,
  };
}

function createHarness(plans: PlannedJob[] = [{ state: 'COMPLETED' }]) {
  const db = createDatabase();
  const plannedJobs = [...plans];
  const metrics: Metrics = { creates: 0, advances: 0, languageCalls: 0 };
  let serviceSequence = 0;

  function jobFromRow(row: Record<string, unknown>): GenerationJob {
    const outputArtifactIds = JSON.parse(String(row.output_artifact_ids_json)) as string[];
    const state = String(row.state) as GenerationJob['state'];
    return {
      id: String(row.id),
      generationTaskId: String(row.generation_task_id),
      teammateId: String(row.teammate_id),
      runtimeProfileId: String(row.runtime_profile_id),
      providerJobId: null,
      idempotencyKey: String(row.idempotency_key),
      requestFingerprint: String(row.request_fingerprint),
      state,
      providerStatus: null,
      outputArtifactIds,
      errorCode: row.error_code === null ? null : String(row.error_code),
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: state === 'COMPLETED' ? timestamp : null,
    };
  }

  function generationPorts() {
    const generation = {
      create: async (input: Omit<GenerationTask, 'id' | 'createdAt'>): Promise<GenerationJob> => {
        metrics.creates += 1;
        if (!input.executionAttemptId)
          throw new Error('G3 must bind a GenerationTask to its attempt');
        const result = plannedJobs.shift() ?? { state: 'COMPLETED' as const };
        const taskId = `generation-task-${input.executionAttemptId}`;
        const jobId = `generation-job-${input.executionAttemptId}`;
        const task: GenerationTask = { ...input, id: taskId, createdAt: timestamp };
        db.prepare(
          'INSERT INTO generation_tasks (id, target_teammate_id, task_json, descriptor_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(
          taskId,
          task.targetTeammateId,
          JSON.stringify(task),
          JSON.stringify(descriptor),
          timestamp,
        );
        db.prepare(
          `INSERT INTO generation_jobs (
            id, generation_task_id, teammate_id, runtime_profile_id, idempotency_key,
            request_fingerprint, state, output_artifact_ids_json, error_code, recovery_result
          ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', '[]', NULL, ?)`,
        ).run(
          jobId,
          taskId,
          task.targetTeammateId,
          String(
            db
              .prepare('SELECT runtime_profile_id FROM g3_execution_attempts WHERE id = ?')
              .pluck()
              .get(input.executionAttemptId),
          ),
          taskId,
          'b'.repeat(64),
          JSON.stringify(result),
        );
        return jobFromRow(
          db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as Record<
            string,
            unknown
          >,
        );
      },
      advance: async (jobId: string): Promise<GenerationJob> => {
        const row = db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as
          | Record<string, unknown>
          | undefined;
        if (!row) throw new Error(`Missing durable GenerationJob ${jobId}`);
        if (row.state !== 'PENDING') return jobFromRow(row);
        metrics.advances += 1;
        const result = JSON.parse(String(row.recovery_result)) as PlannedJob;
        const outputArtifactIds: string[] = [];
        if (result.state === 'COMPLETED') {
          const task = JSON.parse(
            String(
              db
                .prepare('SELECT task_json FROM generation_tasks WHERE id = ?')
                .pluck()
                .get(row.generation_task_id),
            ),
          ) as GenerationTask;
          const artifactId = `artifact-${String(row.generation_task_id)}`;
          outputArtifactIds.push(artifactId);
          db.prepare(
            `INSERT INTO generation_artifacts (
              id, job_id, kind, mime_type, content_hash, size_bytes, storage_scope
            ) VALUES (?, ?, 'IMAGE', 'image/png', ?, 123, ?)`,
          ).run(artifactId, jobId, 'a'.repeat(64), task.outputDestination.scope);
        }
        db.prepare(
          'UPDATE generation_jobs SET state = ?, output_artifact_ids_json = ?, error_code = ? WHERE id = ?',
        ).run(result.state, JSON.stringify(outputArtifactIds), result.errorCode ?? null, jobId);
        return jobFromRow(
          db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as Record<
            string,
            unknown
          >,
        );
      },
      detail: (jobId: string) => ({
        artifacts: db
          .prepare(
            `SELECT id, kind, mime_type AS mimeType, content_hash AS contentHash, size_bytes AS sizeBytes
             FROM generation_artifacts WHERE job_id = ? ORDER BY id`,
          )
          .all(jobId),
      }),
    };
    const generationFacts = {
      getTask: (taskId: string): GenerationTask | null => {
        const row = db
          .prepare('SELECT task_json FROM generation_tasks WHERE id = ?')
          .get(taskId) as { task_json: string } | undefined;
        return row ? (JSON.parse(row.task_json) as GenerationTask) : null;
      },
      getDescriptor: (taskId: string): GenerationModelDescriptor | null => {
        const row = db
          .prepare('SELECT descriptor_json FROM generation_tasks WHERE id = ?')
          .get(taskId) as { descriptor_json: string } | undefined;
        return row ? (JSON.parse(row.descriptor_json) as GenerationModelDescriptor) : null;
      },
      getJob: (jobId: string): GenerationJob | null => {
        const row = db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as
          | Record<string, unknown>
          | undefined;
        return row ? jobFromRow(row) : null;
      },
    };
    const gateway = { getDescriptor: async () => descriptor };
    return { generation, generationFacts, gateway };
  }

  function service(crashAt?: G3CrashPoint) {
    let crashed = false;
    const { generation, generationFacts, gateway } = generationPorts();
    const ports = {
      identity: (teammateId: string) =>
        teammateId === 'language-1'
          ? { executionProtocol: 'LANGUAGE' as const, runtimeProfileId: 'runtime-language' }
          : { executionProtocol: 'GENERATION' as const, runtimeProfileId: 'runtime-generation' },
      assertExecutionAllowed: () => undefined,
      verifyArtifact: async () => undefined,
      language: async () => {
        metrics.languageCalls += 1;
        throw new G3ExecutionCrash('language call was interrupted');
      },
      human: async () => ({ kind: 'WAITING' as const }),
      provenRetryableRejection: (job: GenerationJob) => job.errorCode === 'QUEUE_FULL',
      event: () => undefined,
    };
    return new G3ExecutionService(
      new G3SqliteRepository(db),
      generation as never,
      generationFacts as never,
      gateway as never,
      ports as never,
      {
        id: () => `successor-${++serviceSequence}`,
        now: () => timestamp,
        crash: (point) => {
          if (!crashed && point === crashAt) {
            crashed = true;
            throw new G3ExecutionCrash(`simulated crash at ${point}`);
          }
        },
      },
    );
  }

  return { db, metrics, service };
}

function counts(db: Database.Database) {
  const count = (table: string): number =>
    (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    tasks: count('g3_execution_tasks'),
    attempts: count('g3_execution_attempts'),
    generationTasks: count('generation_tasks'),
    generationJobs: count('generation_jobs'),
    generationArtifacts: count('generation_artifacts'),
    artifactRefs: count('g3_artifact_refs'),
    outcomes: count('g3_participant_outcomes'),
  };
}

describe('G3ExecutionService durable recovery', () => {
  it.each<Exclude<G3CrashPoint, 'CONTINUATION_CREATED'>>([
    'TASK_CREATED',
    'ATTEMPT_CREATED',
    'JOB_BOUND',
    'GENERATION_COMPLETED',
    'OUTCOME_CREATED',
  ])('reconstructs the dispatcher after %s without duplicating durable facts', async (point) => {
    const harness = createHarness();
    const task = makeTask('GENERATION', `recover-${point.toLowerCase()}`);
    const firstService = harness.service(point);
    await expect(firstService.dispatch(task)).rejects.toBeInstanceOf(G3ExecutionCrash);

    const before = counts(harness.db);
    const expectedBefore = {
      TASK_CREATED: {
        tasks: 1,
        attempts: 0,
        generationTasks: 0,
        generationJobs: 0,
        generationArtifacts: 0,
        artifactRefs: 0,
        outcomes: 0,
      },
      ATTEMPT_CREATED: {
        tasks: 1,
        attempts: 1,
        generationTasks: 0,
        generationJobs: 0,
        generationArtifacts: 0,
        artifactRefs: 0,
        outcomes: 0,
      },
      JOB_BOUND: {
        tasks: 1,
        attempts: 1,
        generationTasks: 1,
        generationJobs: 1,
        generationArtifacts: 0,
        artifactRefs: 0,
        outcomes: 0,
      },
      OUTCOME_CREATED: {
        tasks: 1,
        attempts: 1,
        generationTasks: 1,
        generationJobs: 1,
        generationArtifacts: 1,
        artifactRefs: 1,
        outcomes: 1,
      },
      GENERATION_COMPLETED: {
        tasks: 1,
        attempts: 1,
        generationTasks: 1,
        generationJobs: 1,
        generationArtifacts: 1,
        artifactRefs: 1,
        outcomes: 0,
      },
    }[point];
    expect(before).toEqual(expectedBefore);
    const attemptIdBefore = harness.db
      .prepare('SELECT id FROM g3_execution_attempts WHERE task_id = ?')
      .pluck()
      .get(task.id) as string | undefined;
    const jobIdBeforeValue = harness.db
      .prepare('SELECT generation_job_id FROM g3_execution_attempts WHERE task_id = ?')
      .pluck()
      .get(task.id);
    const jobIdBefore = jobIdBeforeValue == null ? undefined : String(jobIdBeforeValue);
    const generationTaskIdBefore = harness.db
      .prepare('SELECT id FROM generation_tasks ORDER BY id')
      .pluck()
      .get() as string | undefined;
    const artifactIdBefore = harness.db
      .prepare('SELECT id FROM generation_artifacts ORDER BY id')
      .pluck()
      .get() as string | undefined;
    const outcomeIdBefore = harness.db
      .prepare('SELECT id FROM g3_participant_outcomes WHERE task_id = ?')
      .pluck()
      .get(task.id) as string | undefined;

    const recoveredService = harness.service();
    const progress = await recoveredService.advance(task.id);
    expect(progress.kind).toBe('OUTCOME');
    expect(counts(harness.db)).toEqual({
      tasks: 1,
      attempts: 1,
      generationTasks: 1,
      generationJobs: 1,
      generationArtifacts: 1,
      artifactRefs: 1,
      outcomes: 1,
    });
    const attemptIdAfter = harness.db
      .prepare('SELECT id FROM g3_execution_attempts WHERE task_id = ?')
      .pluck()
      .get(task.id) as string;
    expect(attemptIdAfter).toEqual(expect.any(String));
    if (attemptIdBefore !== undefined) expect(attemptIdAfter).toBe(attemptIdBefore);
    const jobIdAfter = String(
      harness.db
        .prepare('SELECT generation_job_id FROM g3_execution_attempts WHERE task_id = ?')
        .pluck()
        .get(task.id),
    );
    if (jobIdBefore !== undefined) expect(jobIdAfter).toBe(jobIdBefore);
    expect(harness.db.prepare('SELECT id FROM generation_tasks ORDER BY id').pluck().get()).toEqual(
      generationTaskIdBefore ?? expect.any(String),
    );
    expect(
      harness.db.prepare('SELECT id FROM generation_artifacts ORDER BY id').pluck().get(),
    ).toEqual(artifactIdBefore ?? expect.any(String));
    const outcomeIdAfter = harness.db
      .prepare('SELECT id FROM g3_participant_outcomes WHERE task_id = ?')
      .pluck()
      .get(task.id) as string;
    if (outcomeIdBefore !== undefined) expect(outcomeIdAfter).toBe(outcomeIdBefore);
    expect(harness.metrics.creates).toBe(1);
    expect(harness.metrics.advances).toBe(1);
    if (progress.kind === 'OUTCOME') {
      const repository = new G3SqliteRepository(harness.db);
      expect(repository.getOutcome(progress.attempt.id)?.id).toBe(progress.fact.id);
      expect(repository.consumeOutcome(progress.fact.id, timestamp)).toBe(true);
      expect(harness.service().consume(progress.fact.id)).toBe(false);
    }
    expect(harness.metrics.creates).toBe(1);
    expect(harness.metrics.advances).toBe(1);
    harness.db.close();
  });

  it('recovers a committed continuation once and gives a retry a fresh task and GenerationJob key within budget', async () => {
    const harness = createHarness([
      { state: 'FAILED', errorCode: 'QUEUE_FULL' },
      { state: 'FAILED', errorCode: 'QUEUE_FULL' },
    ]);
    const original = makeTask('GENERATION', 'retry-original');
    const first = await harness.service().dispatch(original);
    if (first.kind !== 'OUTCOME') throw new Error('Expected retryable Generation outcome');
    expect(first.fact.outcome.kind).toBe('FAILED_RETRYABLE');

    const initialRepository = new G3SqliteRepository(harness.db);
    const firstJobId = first.attempt.generationJobId;
    const firstTaskId = harness.db
      .prepare('SELECT id FROM generation_tasks ORDER BY id')
      .pluck()
      .get() as string;
    const serviceBeforeCrash = harness.service('CONTINUATION_CREATED');
    expect(() => serviceBeforeCrash.successor(original.id, { retry: true })).toThrow(
      G3ExecutionCrash,
    );

    const continuationBefore = initialRepository.getContinuation(first.fact.id);
    const nextTaskBefore = continuationBefore?.decision.nextTaskId;
    expect(nextTaskBefore).toBeTruthy();
    const resumedService = harness.service();
    const sameNextTask = resumedService.successor(original.id, { retry: true });
    expect(sameNextTask.id).toBe(nextTaskBefore);
    expect(new G3SqliteRepository(harness.db).listTasks()).toHaveLength(2);
    expect(initialRepository.consumeOutcome(first.fact.id, timestamp)).toBe(true);
    expect(resumedService.consume(first.fact.id)).toBe(false);
    expect(initialRepository.consumeContinuation(continuationBefore!.id, timestamp)).toBe(true);
    expect(
      new G3SqliteRepository(harness.db).consumeContinuation(continuationBefore!.id, timestamp),
    ).toBe(false);

    const retryProgress = await resumedService.dispatch(sameNextTask);
    if (retryProgress.kind !== 'OUTCOME') throw new Error('Expected bounded retry outcome');
    expect(retryProgress.fact.outcome.kind).toBe('FAILED_RETRYABLE');
    expect(retryProgress.task).toMatchObject({
      id: nextTaskBefore,
      parentTaskId: original.id,
      retryNo: 1,
      continuationRound: 1,
    });
    expect(retryProgress.attempt.generationJobId).not.toBe(firstJobId);
    const jobs = harness.db
      .prepare('SELECT id, generation_task_id, idempotency_key FROM generation_jobs ORDER BY id')
      .all() as Array<{ id: string; generation_task_id: string; idempotency_key: string }>;
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(new Set(jobs.map((job) => job.generation_task_id)).size).toBe(2);
    expect(new Set(jobs.map((job) => job.idempotency_key)).size).toBe(2);
    expect(jobs.map((job) => job.generation_task_id)).toContain(firstTaskId);
    expect(jobs.some((job) => job.generation_task_id !== firstTaskId)).toBe(true);
    expect(harness.metrics.creates).toBe(2);
    expect(harness.metrics.advances).toBe(2);
    expect(() => resumedService.successor(sameNextTask.id, { retry: true })).toThrow(
      '重试次数已达到上限',
    );
    expect(new G3SqliteRepository(harness.db).listTasks()).toHaveLength(2);
    harness.db.close();
  });

  it('leaves an ambiguous GenerationJob UNKNOWN and performs no automatic resubmit after reconstruction', async () => {
    const harness = createHarness([{ state: 'UNKNOWN', errorCode: 'PROVIDER_TIMEOUT' }]);
    const task = makeTask('GENERATION', 'unknown-no-replay');
    const first = await harness.service().dispatch(task);
    expect(first.kind).toBe('WAITING');
    if (first.kind !== 'WAITING') throw new Error('Expected UNKNOWN wait');
    expect(first.attempt.state).toBe('UNKNOWN');
    const recovered = await harness.service().advance(task.id);
    expect(recovered).toMatchObject({ kind: 'WAITING', attempt: { state: 'UNKNOWN' } });
    expect(harness.metrics.creates).toBe(1);
    expect(harness.metrics.advances).toBe(1);
    expect(counts(harness.db)).toMatchObject({
      tasks: 1,
      attempts: 1,
      generationTasks: 1,
      generationJobs: 1,
    });
    expect(counts(harness.db).outcomes).toBe(0);
    harness.db.close();
  });

  it('marks an interrupted LANGUAGE call UNKNOWN and never replays it after reconstruction', async () => {
    const harness = createHarness();
    const task = makeTask('LANGUAGE', 'language-interrupted');
    await expect(harness.service().dispatch(task)).rejects.toBeInstanceOf(G3ExecutionCrash);
    const interruptedAttempt = new G3SqliteRepository(harness.db).listAttempts(task.id)[0];
    expect(interruptedAttempt?.state).toBe('RUNNING');
    const firstRecovery = await harness.service().advance(task.id);
    expect(firstRecovery).toMatchObject({ kind: 'WAITING', attempt: { state: 'UNKNOWN' } });
    const secondRecovery = await harness.service().advance(task.id);
    expect(secondRecovery).toMatchObject({ kind: 'WAITING', attempt: { state: 'UNKNOWN' } });
    expect(harness.metrics.languageCalls).toBe(1);
    expect(new G3SqliteRepository(harness.db).listAttempts(task.id)).toHaveLength(1);
    harness.db.close();
  });

  it('rejects forged outcome identity and unapproved executor changes', async () => {
    expect(() =>
      parseParticipantOutcome({
        kind: 'RESULT',
        publicResult: 'Done.',
        artifactRefs: [],
        targetTeammateId: 'participant-2',
      }),
    ).toThrow();
    expect(() =>
      parseParticipantOutcome({
        kind: 'FAILED_TERMINAL',
        errorCode: 'EXECUTION_FAILED',
        reason: 'Rejected.',
        permissionDecision: 'ALLOW',
      }),
    ).toThrow();

    const harness = createHarness();
    const task = makeTask('GENERATION', 'approved-target-only');
    new G3SqliteRepository(harness.db).createTask(task);
    const service = harness.service();
    expect(() => service.successor(task.id, { targetTeammateId: 'participant-2' })).toThrow(
      '更换执行者必须建立新的获准协作请求',
    );
    const unapproved = { ...task, id: 'unapproved-task', targetTeammateId: 'participant-2' };
    expect(() => new G3SqliteRepository(harness.db).createTask(unapproved)).toThrow();
    expect(counts(harness.db).tasks).toBe(1);
    harness.db.close();
  });
});
