import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ExecutionTask } from '../../domain/src/g3-execution.js';
import { G3_EXECUTION_POLICY } from '../../domain/src/g3-execution.js';
import { G3SqliteRepository } from './g3-execution.js';

const migration = readFileSync(
  new URL('../../../migrations/0030_g3_multimodal_collaboration.sql', import.meta.url),
  'utf8',
);
const timestamp = '2026-10-06T08:00:00.000Z';

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE missions (id TEXT PRIMARY KEY, coordinator_teammate_id TEXT NOT NULL);
    CREATE TABLE mission_runs (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'RUNNING');
    CREATE TABLE mission_participants (mission_id TEXT NOT NULL, teammate_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(mission_id, teammate_id));
    CREATE TABLE collaboration_requests (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, run_id TEXT NOT NULL,
      requester_teammate_id TEXT NOT NULL, target_teammate_id TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY);
    CREATE TABLE workflow_artifacts (id TEXT PRIMARY KEY, content TEXT, content_hash TEXT, workflow_run_id TEXT, metadata_json TEXT, producer_step_run_id TEXT);
    CREATE TABLE workflow_artifact_bindings (artifact_id TEXT, role TEXT, step_run_id TEXT);
    CREATE TABLE workflow_validation_receipts (artifact_id TEXT, valid INTEGER, content_hash TEXT);
    CREATE TABLE workflow_step_runs (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, mission_id TEXT, mission_run_id TEXT
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
      teammate_id TEXT NOT NULL, runtime_profile_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'COMPLETED'
    );
    CREATE TABLE generation_artifacts (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL,
      mime_type TEXT NOT NULL, content_hash TEXT NOT NULL, size_bytes INTEGER NOT NULL
    );
    CREATE TABLE external_work_requests (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, run_id TEXT NOT NULL,
      requester_teammate_id TEXT NOT NULL, assignee_teammate_id TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE external_work_artifacts (
      id TEXT PRIMARY KEY, external_work_request_id TEXT NOT NULL,
      mime_type TEXT, size_bytes INTEGER NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',extension TEXT NOT NULL DEFAULT '.png'
    );
  `);
  db.exec(migration);
  db.exec(`
    INSERT INTO missions VALUES ('mission-1', 'coordinator-1');
    INSERT INTO mission_runs VALUES ('run-1', 'mission-1', 1, 'RUNNING');
    INSERT INTO mission_participants VALUES ('mission-1', 'coordinator-1', 'COORDINATOR');
    INSERT INTO mission_participants VALUES ('mission-1', 'participant-1', 'MEMBER');
    INSERT INTO mission_participants VALUES ('mission-1', 'participant-2', 'MEMBER');
    INSERT INTO runtime_profiles VALUES ('runtime-language', 'language-model', 'LANGUAGE', NULL);
    INSERT INTO runtime_profiles VALUES ('runtime-generation', 'image-model', 'GENERATION', NULL);
    INSERT INTO teammates VALUES ('coordinator-1', 'MODEL_RUNTIME', NULL, 'ACTIVE', 'runtime-language', 'NORMAL');
    INSERT INTO teammates VALUES ('participant-1', 'MODEL_RUNTIME', NULL, 'ACTIVE', 'runtime-generation', 'NORMAL');
    INSERT INTO teammates VALUES ('participant-2', 'MODEL_RUNTIME', NULL, 'ACTIVE', 'runtime-generation', 'NORMAL');
    INSERT INTO teammate_model_bindings VALUES ('coordinator-1', 'runtime-language', 'LANGUAGE');
    INSERT INTO teammate_model_bindings VALUES ('participant-1', 'runtime-generation', 'GENERATION');
    INSERT INTO teammate_model_bindings VALUES ('participant-2', 'runtime-generation', 'GENERATION');
    INSERT INTO collaboration_requests VALUES ('request-1', 'mission-1', 'run-1', 'coordinator-1', 'participant-1', 'APPROVED');
    INSERT INTO workflow_runs VALUES ('workflow-run-1');
    INSERT INTO workflow_step_runs VALUES ('step-run-1', 'workflow-run-1', 'mission-1', 'run-1');
  `);
  return db;
}

function makeTask(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id: 'execution-1',
    logicalKey: 'request-1:video-task',
    source: 'COLLABORATION',
    missionId: 'mission-1',
    runId: 'run-1',
    collaborationRequestId: 'request-1',
    workflowRunId: null,
    workflowStepRunId: null,
    requesterTeammateId: 'coordinator-1',
    coordinatorTeammateId: 'coordinator-1',
    targetTeammateId: 'participant-1',
    requiredCapability: 'IMAGE_GENERATION',
    executionProtocol: 'GENERATION',
    publicTask: 'Generate a scene image.',
    publicContext: 'Product campaign scene 1.',
    artifactInputs: [],
    generationRequirements: {
      capability: 'IMAGE_GENERATION',
      requiredFeatures: ['TEXT_TO_IMAGE'],
      prompt: 'A product campaign scene.',
      parameters: { seed: 12 },
      expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
      outputDestination: { scope: 'APP_ARTIFACT_STORE' },
      inputRequirements: [],
      reviewCapability: 'VISUAL_UNDERSTANDING',
    },
    acceptanceCriteria: ['Register one image Artifact.'],
    dependencyRole: null,
    reviewOf: [],
    parentTaskId: null,
    retryNo: 0,
    continuationRound: 0,
    policyVersion: G3_EXECUTION_POLICY.version,
    createdAt: timestamp,
    ...overrides,
  };
}

function makeGenerationTaskJson(attemptId: string, task: ExecutionTask): string {
  return JSON.stringify({
    id: `generation-${attemptId}`,
    targetTeammateId: task.targetTeammateId,
    capability: task.requiredCapability,
    missionId: task.missionId,
    runId: task.runId,
    collaborationRequestId: task.collaborationRequestId,
    executionAttemptId: attemptId,
    outputDestination: { scope: 'APP_ARTIFACT_STORE' },
    createdAt: timestamp,
  });
}

describe('G3SqliteRepository', () => {
  it('applies migration 0030 and retains immutable, idempotent task snapshots', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const task = makeTask();
    expect(repository.createTask(task)).toEqual(task);
    expect(repository.createTask(task)).toEqual(task);
    expect(repository.listTasks('mission-1', 'run-1')).toEqual([task]);
    expect(() => repository.createTask({ ...task, publicTask: 'Changed task.' })).toThrow(
      /IDEMPOTENCY_CONFLICT/,
    );
    expect(() =>
      db.prepare('UPDATE g3_execution_tasks SET task_json = ? WHERE id = ?').run('{}', task.id),
    ).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM g3_execution_tasks WHERE id = ?').run(task.id)).toThrow(
      /retained/,
    );
    expect(
      (db.pragma('table_info(g3_participant_outcomes)') as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toContain('participant_teammate_id');
  });

  it('binds outcome facts to the exact attempt provenance and consumes them once', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const task = repository.createTask(makeTask());
    const attempt = repository.createAttempt(task.id, {
      id: 'attempt-1',
      runtimeProfileId: 'runtime-generation',
      createdAt: timestamp,
    });
    expect(
      repository.createAttempt(task.id, {
        id: 'attempt-1',
        runtimeProfileId: 'runtime-generation',
        createdAt: timestamp,
      }),
    ).toEqual(attempt);
    repository.transitionAttempt(attempt.id, 'PREPARED', 'RUNNING');
    const outcome = repository.appendOutcome(attempt.id, {
      kind: 'NEEDS_INPUT',
      requirements: [
        {
          role: 'STYLE_REFERENCE',
          artifactKinds: ['IMAGE'],
          mimeTypes: ['image/png'],
          required: true,
        },
      ],
      reason: 'A style reference is required.',
    });
    expect(outcome).toMatchObject({
      taskId: task.id,
      attemptId: attempt.id,
      missionId: task.missionId,
      runId: task.runId,
      collaborationRequestId: task.collaborationRequestId,
      participantTeammateId: task.targetTeammateId,
      executionProtocol: task.executionProtocol,
      outcome: { kind: 'NEEDS_INPUT' },
    });
    expect(repository.getAttempt(attempt.id)?.state).toBe('WAITING_INPUT');
    expect(repository.appendOutcome(attempt.id, outcome.outcome)).toEqual(outcome);
    expect(() =>
      repository.appendOutcome(attempt.id, {
        kind: 'RESULT',
        artifactRefs: [],
      }),
    ).toThrow(/OUTCOME_CONFLICT/);
    expect(repository.consumeOutcome(outcome.id, timestamp)).toBe(true);
    expect(repository.consumeOutcome(outcome.id, timestamp)).toBe(false);
    expect(repository.getOutcome(attempt.id)?.consumedAt).toBe(timestamp);
  });

  it('persists continuation intent before downstream work and consumes it once', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const task = repository.createTask(makeTask());
    const attempt = repository.createAttempt(task.id, { runtimeProfileId: 'runtime-generation' });
    repository.transitionAttempt(attempt.id, 'PREPARED', 'RUNNING');
    const outcome = repository.appendOutcome(attempt.id, {
      kind: 'NEEDS_CAPABILITY',
      capability: 'VISUAL_UNDERSTANDING',
      requestedInputs: [{ role: 'STYLE_REFERENCE', required: false }],
      reason: 'Review the source image.',
    });
    const decision = {
      action: 'REQUEST_CAPABILITY' as const,
      reason: 'Find an eligible reviewer.',
      nextTaskId: 'review-task-1',
      data: {
        reviewCapability: 'VISUAL_UNDERSTANDING',
        targetRequestId: 'request-review-1',
        policyVersion: G3_EXECUTION_POLICY.version,
      },
    };
    const continuation = repository.saveContinuation(outcome.id, decision);
    expect(repository.saveContinuation(outcome.id, decision)).toEqual(continuation);
    expect(repository.getContinuation(outcome.id)).toEqual(continuation);
    expect(continuation).toMatchObject({
      missionId: task.missionId,
      runId: task.runId,
      collaborationRequestId: task.collaborationRequestId,
      continuationRound: 1,
      decision,
    });
    expect(() => repository.saveContinuation(outcome.id, { action: 'FAIL' })).toThrow(
      /CONTINUATION_CONFLICT/,
    );
    expect(repository.consumeContinuation(continuation.id, timestamp)).toBe(true);
    expect(repository.consumeContinuation(continuation.id, timestamp)).toBe(false);
  });

  it('requires actual same-Run artifact facts and rejects invented approved imports across Runs', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const ref = {
      id: 'artifact-1',
      kind: 'IMAGE',
      mimeType: 'image/png',
      contentHash: 'a'.repeat(64),
      sizeBytes: 128,
    };
    db.prepare(
      "INSERT INTO generation_tasks(id,target_teammate_id,task_json,created_at) VALUES('source-task','participant-1',?,?)",
    ).run(JSON.stringify({ missionId: 'mission-1', runId: 'run-1' }), timestamp);
    db.prepare(
      "INSERT INTO generation_jobs(id,generation_task_id,teammate_id,runtime_profile_id) VALUES('source-job','source-task','participant-1','runtime-generation')",
    ).run();
    db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run(
      ref.id,
      'source-job',
      ref.kind,
      ref.mimeType,
      ref.contentHash,
      ref.sizeBytes,
    );
    expect(
      repository.registerArtifactRef('mission-1', 'run-1', ref, {
        type: 'GENERATION',
        id: ref.id,
      }),
    ).toEqual(ref);
    expect(repository.listArtifactRefs('mission-1', 'run-1')).toEqual([ref]);
    expect(() =>
      repository.createTask(makeTask({ artifactInputs: [{ ...ref, role: 'STYLE_REFERENCE' }] })),
    ).not.toThrow();
    expect(() => repository.registerArtifactRef('mission-1', 'run-2', ref)).toThrow();
    db.prepare('INSERT INTO mission_runs VALUES (?, ?, ?, ?)').run(
      'run-2',
      'mission-1',
      2,
      'RUNNING',
    );
    expect(() =>
      repository.registerArtifactRef('mission-1', 'run-2', ref, {
        type: 'APPROVED_IMPORT',
        id: 'approval-2',
      }),
    ).toThrow();
    expect(() =>
      repository.registerArtifactRef(
        'mission-1',
        'run-1',
        { ...ref, contentHash: 'b'.repeat(64) },
        {
          type: 'GENERATION',
          id: ref.id,
        },
      ),
    ).toThrow(/ARTIFACT_REF_CONFLICT/);
  });

  it('atomically binds only one GenerationJob and requires an approved collaboration identity', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const task = repository.createTask(makeTask());
    const attempt = repository.createAttempt(task.id, {
      id: 'attempt-generation-job',
      runtimeProfileId: 'runtime-generation',
    });
    const generationTaskId = `generation-${attempt.id}`;
    db.prepare(
      'INSERT INTO generation_tasks (id, target_teammate_id, task_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(
      generationTaskId,
      task.targetTeammateId,
      makeGenerationTaskJson(attempt.id, task),
      timestamp,
    );
    db.prepare(
      'INSERT INTO generation_jobs (id, generation_task_id, teammate_id, runtime_profile_id) VALUES (?, ?, ?, ?)',
    ).run('job-1', generationTaskId, task.targetTeammateId, 'runtime-generation');
    expect(repository.getAttempt(attempt.id)?.generationJobId).toBe('job-1');
    expect(repository.bindGenerationJob(attempt.id, 'job-1').generationJobId).toBe('job-1');

    const secondTaskId = `generation-second-${attempt.id}`;
    db.prepare(
      'INSERT INTO generation_tasks (id, target_teammate_id, task_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(secondTaskId, task.targetTeammateId, makeGenerationTaskJson(attempt.id, task), timestamp);
    expect(() =>
      db
        .prepare(
          'INSERT INTO generation_jobs (id, generation_task_id, teammate_id, runtime_profile_id) VALUES (?, ?, ?, ?)',
        )
        .run('job-2', secondTaskId, task.targetTeammateId, 'runtime-generation'),
    ).toThrow(/G3 GENERATION attempt/);
  });

  it('rejects unknown state transitions, mismatched outcome identity, and a Generation Party Coordinator', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const task = repository.createTask(makeTask());
    const attempt = repository.createAttempt(task.id, { runtimeProfileId: 'runtime-generation' });
    expect(() => repository.transitionAttempt(attempt.id, 'PREPARED', 'COMPLETED')).toThrow(
      /Invalid ExecutionAttempt transition/,
    );
    expect(() =>
      db
        .prepare(
          `
      INSERT INTO g3_participant_outcomes
        (id, task_id, attempt_id, mission_id, run_id, collaboration_request_id,
         participant_teammate_id, execution_protocol, kind, outcome_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
          'bad-outcome',
          task.id,
          attempt.id,
          'mission-1',
          'run-1',
          'request-1',
          'participant-2',
          'GENERATION',
          'NEEDS_INPUT',
          JSON.stringify({ kind: 'NEEDS_INPUT', requirements: [], reason: 'Wrong participant.' }),
          timestamp,
        ),
    ).toThrow(/match its task, attempt/);
    expect(() =>
      db
        .prepare('INSERT INTO parties (id, coordinator_teammate_id) VALUES (?, ?)')
        .run('party-bad', 'participant-1'),
    ).toThrow(/LANGUAGE Runtime/);
    expect(() =>
      repository.createTask(
        makeTask({
          id: 'unapproved-task',
          logicalKey: 'request-1:unapproved',
        }),
      ),
    ).not.toThrow();
    db.prepare("UPDATE collaboration_requests SET state = 'DENIED' WHERE id = 'request-1'").run();
    expect(() =>
      repository.createTask(
        makeTask({
          id: 'unapproved-retry',
          logicalKey: 'request-1:unapproved-retry',
        }),
      ),
    ).toThrow(/approval, provenance/);
  });

  it('keeps an UNKNOWN attempt terminal and lists durable recovery work', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const task = repository.createTask(makeTask());
    const attempt = repository.createAttempt(task.id, { runtimeProfileId: 'runtime-generation' });
    repository.transitionAttempt(attempt.id, 'PREPARED', 'UNKNOWN');
    expect(() => repository.transitionAttempt(attempt.id, 'UNKNOWN', 'RUNNING')).toThrow(
      /Invalid ExecutionAttempt transition/,
    );
    expect(repository.listPending()).toHaveLength(1);
  });

  it('binds same-Run external input and review continuations for LANGUAGE attempts', () => {
    const db = createDatabase();
    const repository = new G3SqliteRepository(db);
    const makeLanguageWorkflowTask = (id: string): ExecutionTask =>
      makeTask({
        id,
        logicalKey: `workflow:${id}`,
        source: 'WORKFLOW',
        collaborationRequestId: null,
        workflowRunId: 'workflow-run-1',
        workflowStepRunId: 'step-run-1',
        targetTeammateId: 'coordinator-1',
        requiredCapability: 'GENERAL_REASONING',
        executionProtocol: 'LANGUAGE',
        generationRequirements: null,
      });
    const createExternalRequest = (id: string): void => {
      db.prepare(
        `
        INSERT INTO external_work_requests
          (id, mission_id, run_id, requester_teammate_id, assignee_teammate_id, state)
        VALUES (?, 'mission-1', 'run-1', 'coordinator-1', 'participant-2', 'PENDING')
      `,
      ).run(id);
    };

    const inputTask = repository.createTask(makeLanguageWorkflowTask('language-input-task'));
    const inputAttempt = repository.createAttempt(inputTask.id, {
      runtimeProfileId: 'runtime-language',
    });
    repository.transitionAttempt(inputAttempt.id, 'PREPARED', 'WAITING_USER');
    createExternalRequest('external-input-request');
    expect(
      repository.bindExternalWork(inputAttempt.id, 'external-input-request').externalWorkRequestId,
    ).toBe('external-input-request');

    const reviewTask = repository.createTask(makeLanguageWorkflowTask('language-review-task'));
    const reviewAttempt = repository.createAttempt(reviewTask.id, {
      runtimeProfileId: 'runtime-language',
    });
    repository.transitionAttempt(reviewAttempt.id, 'PREPARED', 'RUNNING');
    repository.appendOutcome(reviewAttempt.id, {
      kind: 'RESULT',
      publicResult: 'Ready for review.',
      artifactRefs: [],
    });
    createExternalRequest('external-review-request');
    expect(repository.getAttempt(reviewAttempt.id)?.state).toBe('COMPLETED');
    expect(
      repository.bindExternalWork(reviewAttempt.id, 'external-review-request')
        .externalWorkRequestId,
    ).toBe('external-review-request');

    const prepared = repository.createAttempt(reviewTask.id, {
      id: 'attempt-not-ready',
      attemptNo: 2,
      runtimeProfileId: 'runtime-language',
    });
    expect(() => repository.bindExternalWork(prepared.id, 'external-review-request')).toThrow(
      /External work binds only/,
    );
  });
});
