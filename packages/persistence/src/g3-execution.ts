import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  G3_EXECUTION_POLICY,
  parseG3ContinuationDecision,
  parseParticipantOutcome,
  transitionExecutionAttempt,
  validateExecutionTask,
} from '../../domain/src/g3-execution.js';
import type {
  ArtifactRef,
  ArtifactRefSource,
  CreateExecutionAttemptInput,
  ExecutionAttempt,
  ExecutionAttemptPatch,
  ExecutionAttemptState,
  ExecutionDispatchProtocol,
  ExecutionTask,
  G3Continuation,
  G3ContinuationDecision,
  ParticipantOutcome,
  ParticipantOutcomeFact,
} from '../../domain/src/g3-execution.js';

interface TaskRow {
  id: string;
  logical_key: string;
  source: ExecutionTask['source'];
  mission_id: string;
  run_id: string;
  collaboration_request_id: string | null;
  workflow_run_id: string | null;
  workflow_step_run_id: string | null;
  requester_teammate_id: string | null;
  coordinator_teammate_id: string | null;
  target_teammate_id: string;
  required_capability: string;
  execution_protocol: ExecutionDispatchProtocol;
  parent_task_id: string | null;
  retry_no: number;
  continuation_round: number;
  policy_version: string;
  task_json: string;
  created_at: string;
}

interface AttemptRow {
  id: string;
  task_id: string;
  attempt_no: number;
  runtime_profile_id: string | null;
  state: ExecutionAttemptState;
  generation_job_id: string | null;
  external_work_request_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface OutcomeRow {
  id: string;
  task_id: string;
  attempt_id: string;
  mission_id: string;
  run_id: string;
  collaboration_request_id: string | null;
  participant_teammate_id: string;
  execution_protocol: ExecutionDispatchProtocol;
  kind: ParticipantOutcome['kind'];
  outcome_json: string;
  created_at: string;
  consumed_at: string | null;
}

interface ContinuationRow {
  id: string;
  outcome_id: string;
  task_id: string;
  attempt_id: string;
  mission_id: string;
  run_id: string;
  collaboration_request_id: string | null;
  action: G3ContinuationDecision['action'];
  decision_json: string;
  continuation_round: number;
  created_at: string;
  consumed_at: string | null;
}

interface ArtifactRefRow {
  artifact_id: string;
  kind: string;
  mime_type: string;
  content_hash: string;
  size_bytes: number;
}

export interface G3PendingExecution {
  task: ExecutionTask;
  attempt: ExecutionAttempt;
  outcome: ParticipantOutcomeFact | null;
  continuation: G3Continuation | null;
}

const MAX_ID_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_TASK_BYTES = 65_536;
const MAX_OUTCOME_BYTES = 32_768;
const MAX_CONTINUATION_BYTES = 12_288;

/** Durable G3 facts. State changes are compare-and-swap and all snapshots remain append-only. */
export class G3SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  createTask(task: ExecutionTask): ExecutionTask {
    validateExecutionTask(task);
    const taskJson = canonicalJson(task);
    assertJsonBytes(taskJson, MAX_TASK_BYTES, 'ExecutionTask');

    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM g3_execution_tasks WHERE id = ?')
        .get(task.id) as TaskRow | undefined;
      if (existing) {
        if (existing.task_json !== taskJson) {
          throw new Error('IDEMPOTENCY_CONFLICT: ExecutionTask ID already stores different facts');
        }
        return mapTask(existing);
      }

      const logicalExisting = this.db
        .prepare('SELECT * FROM g3_execution_tasks WHERE logical_key = ? AND retry_no = ?')
        .get(task.logicalKey, task.retryNo) as TaskRow | undefined;
      if (logicalExisting) {
        if (logicalExisting.task_json === taskJson) return mapTask(logicalExisting);
        throw new Error('IDEMPOTENCY_CONFLICT: logicalKey/retryNo already stores another task');
      }

      this.assertTaskArtifactRefs(task);
      this.db
        .prepare(
          `INSERT INTO g3_execution_tasks (
            id, logical_key, source, mission_id, run_id, collaboration_request_id,
            workflow_run_id, workflow_step_run_id, requester_teammate_id,
            coordinator_teammate_id, target_teammate_id, required_capability,
            execution_protocol, parent_task_id, retry_no, continuation_round,
            policy_version, task_json, created_at
          ) VALUES (
            @id, @logicalKey, @source, @missionId, @runId, @collaborationRequestId,
            @workflowRunId, @workflowStepRunId, @requesterTeammateId,
            @coordinatorTeammateId, @targetTeammateId, @requiredCapability,
            @executionProtocol, @parentTaskId, @retryNo, @continuationRound,
            @policyVersion, @taskJson, @createdAt
          )`,
        )
        .run({
          id: task.id,
          logicalKey: task.logicalKey,
          source: task.source,
          missionId: task.missionId,
          runId: task.runId,
          collaborationRequestId: task.collaborationRequestId,
          workflowRunId: task.workflowRunId,
          workflowStepRunId: task.workflowStepRunId,
          requesterTeammateId: task.requesterTeammateId,
          coordinatorTeammateId: task.coordinatorTeammateId,
          targetTeammateId: task.targetTeammateId,
          requiredCapability: task.requiredCapability,
          executionProtocol: task.executionProtocol,
          parentTaskId: task.parentTaskId,
          retryNo: task.retryNo,
          continuationRound: task.continuationRound,
          policyVersion: task.policyVersion,
          taskJson,
          createdAt: task.createdAt,
        });
      return this.getTask(task.id)!;
    })();
  }

  getTask(id: string): ExecutionTask | null {
    validateId(id, 'ExecutionTask');
    const row = this.db.prepare('SELECT * FROM g3_execution_tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    return row ? mapTask(row) : null;
  }

  listTasks(missionId?: string, runId?: string): ExecutionTask[] {
    if (missionId !== undefined) validateId(missionId, 'Mission');
    if (runId !== undefined) validateId(runId, 'Mission Run');
    const rows = this.db
      .prepare(
        `SELECT * FROM g3_execution_tasks
         WHERE (@missionId IS NULL OR mission_id = @missionId)
           AND (@runId IS NULL OR run_id = @runId)
         ORDER BY created_at, id`,
      )
      .all({ missionId: missionId ?? null, runId: runId ?? null }) as TaskRow[];
    return rows.map(mapTask);
  }

  createAttempt(taskId: string, input: CreateExecutionAttemptInput = {}): ExecutionAttempt {
    validateId(taskId, 'ExecutionTask');
    const task = this.getTask(taskId);
    if (!task) throw new Error(`ExecutionTask ${taskId} does not exist`);
    const attemptNo = input.attemptNo ?? 1;
    if (
      !Number.isInteger(attemptNo) ||
      attemptNo < 1 ||
      attemptNo > G3_EXECUTION_POLICY.maxParticipantAttempts
    ) {
      throw new Error('ExecutionAttempt attemptNo is outside the versioned attempt budget');
    }
    if (input.id !== undefined) validateId(input.id, 'ExecutionAttempt');
    if (input.runtimeProfileId !== undefined && input.runtimeProfileId !== null) {
      validateId(input.runtimeProfileId, 'RuntimeProfile');
    }
    const existing = this.db
      .prepare('SELECT * FROM g3_execution_attempts WHERE task_id = ? AND attempt_no = ?')
      .get(taskId, attemptNo) as AttemptRow | undefined;
    if (existing) {
      if (input.id !== undefined && input.id !== existing.id) {
        throw new Error('IDEMPOTENCY_CONFLICT: task attempt number already has another ID');
      }
      if (
        input.runtimeProfileId !== undefined &&
        input.runtimeProfileId !== existing.runtime_profile_id
      ) {
        throw new Error('IDEMPOTENCY_CONFLICT: task attempt number already has another Runtime');
      }
      if (input.createdAt !== undefined && input.createdAt !== existing.created_at) {
        throw new Error(
          'IDEMPOTENCY_CONFLICT: task attempt number already has another creation time',
        );
      }
      return mapAttempt(existing);
    }

    const createdAt = input.createdAt ?? nowIso();
    validateTimestamp(createdAt);
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO g3_execution_attempts
          (id, task_id, attempt_no, runtime_profile_id, state, generation_job_id,
           external_work_request_id, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PREPARED', NULL, NULL, NULL, ?, ?)`,
      )
      .run(id, taskId, attemptNo, input.runtimeProfileId ?? null, createdAt, createdAt);
    return this.getAttempt(id)!;
  }

  getAttempt(id: string): ExecutionAttempt | null {
    validateId(id, 'ExecutionAttempt');
    const row = this.db.prepare('SELECT * FROM g3_execution_attempts WHERE id = ?').get(id) as
      | AttemptRow
      | undefined;
    return row ? mapAttempt(row) : null;
  }

  listAttempts(taskId?: string): ExecutionAttempt[] {
    if (taskId !== undefined) validateId(taskId, 'ExecutionTask');
    const rows = this.db
      .prepare(
        `SELECT * FROM g3_execution_attempts
         WHERE (? IS NULL OR task_id = ?)
         ORDER BY created_at, task_id, attempt_no`,
      )
      .all(taskId ?? null, taskId ?? null) as AttemptRow[];
    return rows.map(mapAttempt);
  }

  transitionAttempt(
    id: string,
    expected: ExecutionAttemptState,
    next: ExecutionAttemptState,
    patch: ExecutionAttemptPatch = {},
  ): ExecutionAttempt {
    validateId(id, 'ExecutionAttempt');
    if (next === expected) {
      const current = this.getAttempt(id);
      if (!current || current.state !== expected)
        throw new Error('ExecutionAttempt compare-and-swap conflict');
      return current;
    }
    transitionExecutionAttempt(expected, next);
    if (patch.errorCode !== undefined && patch.errorCode !== null)
      validateErrorCode(patch.errorCode);
    const updatedAt = patch.updatedAt ?? nowIso();
    validateTimestamp(updatedAt);

    return this.db.transaction(() => {
      const before = this.getAttempt(id);
      if (!before) throw new Error(`ExecutionAttempt ${id} does not exist`);
      if (before.state !== expected) {
        throw new Error(
          `ExecutionAttempt compare-and-swap conflict: expected ${expected}, found ${before.state}`,
        );
      }
      const errorCode = patch.errorCode === undefined ? before.errorCode : patch.errorCode;
      const changed = this.db
        .prepare(
          `UPDATE g3_execution_attempts SET state = ?, error_code = ?, updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(next, errorCode, updatedAt, id, expected).changes;
      if (changed !== 1) throw new Error('ExecutionAttempt compare-and-swap conflict');
      return this.getAttempt(id)!;
    })();
  }

  appendOutcome(attemptId: string, input: ParticipantOutcome): ParticipantOutcomeFact {
    validateId(attemptId, 'ExecutionAttempt');
    const outcome = parseParticipantOutcome(input);
    const outcomeJson = canonicalJson(outcome);
    assertJsonBytes(outcomeJson, MAX_OUTCOME_BYTES, 'ParticipantOutcome');
    const timestamp = nowIso();

    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM g3_participant_outcomes WHERE attempt_id = ?')
        .get(attemptId) as OutcomeRow | undefined;
      if (existing) {
        if (existing.outcome_json !== outcomeJson) {
          throw new Error('OUTCOME_CONFLICT: attempt already has a different ParticipantOutcome');
        }
        return mapOutcome(existing);
      }

      const attempt = this.getAttempt(attemptId);
      if (!attempt) throw new Error(`ExecutionAttempt ${attemptId} does not exist`);
      const task = this.getTask(attempt.taskId);
      if (!task) throw new Error(`ExecutionTask ${attempt.taskId} does not exist`);
      if (outcome.kind === 'RESULT')
        this.assertArtifactRefs(task.missionId, task.runId, outcome.artifactRefs);

      const target = outcomeState(outcome);
      if (attempt.state !== target) {
        this.transitionAttempt(attempt.id, attempt.state, target, {
          errorCode:
            outcome.kind === 'FAILED_RETRYABLE' || outcome.kind === 'FAILED_TERMINAL'
              ? outcome.errorCode
              : null,
          updatedAt: timestamp,
        });
      }

      this.db
        .prepare(
          `INSERT INTO g3_participant_outcomes (
            id, task_id, attempt_id, mission_id, run_id, collaboration_request_id,
            participant_teammate_id, execution_protocol, kind, outcome_json, created_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          randomUUID(),
          task.id,
          attempt.id,
          task.missionId,
          task.runId,
          task.collaborationRequestId,
          task.targetTeammateId,
          task.executionProtocol,
          outcome.kind,
          outcomeJson,
          timestamp,
        );
      return this.getOutcome(attemptId)!;
    })();
  }

  getOutcome(attemptId: string): ParticipantOutcomeFact | null {
    validateId(attemptId, 'ExecutionAttempt');
    const row = this.db
      .prepare('SELECT * FROM g3_participant_outcomes WHERE attempt_id = ?')
      .get(attemptId) as OutcomeRow | undefined;
    return row ? mapOutcome(row) : null;
  }

  /** Marks a persisted outcome consumed once. Repeated consumption returns false. */
  consumeOutcome(id: string, at: string): boolean {
    validateId(id, 'ParticipantOutcome');
    validateTimestamp(at);
    return (
      this.db
        .prepare(
          'UPDATE g3_participant_outcomes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
        )
        .run(at, id).changes === 1
    );
  }

  /** Persist the coordinator intent before it creates any downstream task or side effect. */
  saveContinuation(outcomeId: string, input: G3ContinuationDecision): G3Continuation {
    validateId(outcomeId, 'ParticipantOutcome');
    const decision = parseG3ContinuationDecision(input);
    const decisionJson = canonicalJson(decision);
    assertJsonBytes(decisionJson, MAX_CONTINUATION_BYTES, 'Continuation decision');

    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM g3_continuations WHERE outcome_id = ?')
        .get(outcomeId) as ContinuationRow | undefined;
      if (existing) {
        if (existing.decision_json !== decisionJson) {
          throw new Error('CONTINUATION_CONFLICT: outcome already has another persisted decision');
        }
        return mapContinuation(existing);
      }
      const outcome = this.db
        .prepare('SELECT * FROM g3_participant_outcomes WHERE id = ?')
        .get(outcomeId) as OutcomeRow | undefined;
      if (!outcome) throw new Error(`ParticipantOutcome ${outcomeId} does not exist`);
      const task = this.getTask(outcome.task_id);
      if (!task) throw new Error(`ExecutionTask ${outcome.task_id} does not exist`);
      const continuationRound = task.continuationRound + 1;
      if (continuationRound > G3_EXECUTION_POLICY.maxContinuationRounds) {
        throw new Error('CONTINUATION_BUDGET_EXHAUSTED: G3 continuation round limit reached');
      }
      this.db
        .prepare(
          `INSERT INTO g3_continuations (
            id, outcome_id, task_id, attempt_id, mission_id, run_id,
            collaboration_request_id, action, decision_json, continuation_round,
            created_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          randomUUID(),
          outcome.id,
          outcome.task_id,
          outcome.attempt_id,
          outcome.mission_id,
          outcome.run_id,
          outcome.collaboration_request_id,
          decision.action,
          decisionJson,
          continuationRound,
          nowIso(),
        );
      return this.getContinuation(outcomeId)!;
    })();
  }

  getContinuation(outcomeId: string): G3Continuation | null {
    validateId(outcomeId, 'ParticipantOutcome');
    const row = this.db
      .prepare('SELECT * FROM g3_continuations WHERE outcome_id = ?')
      .get(outcomeId) as ContinuationRow | undefined;
    return row ? mapContinuation(row) : null;
  }

  /** Marks a persisted decision consumed once. Repeated consumption returns false. */
  consumeContinuation(id: string, at: string): boolean {
    validateId(id, 'Continuation');
    validateTimestamp(at);
    return (
      this.db
        .prepare('UPDATE g3_continuations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(at, id).changes === 1
    );
  }

  /** Confirms the atomic G3 GenerationJob insert trigger linked exactly this job. */
  bindGenerationJob(attemptId: string, jobId: string): ExecutionAttempt {
    validateId(attemptId, 'ExecutionAttempt');
    validateId(jobId, 'GenerationJob');
    return this.db.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt) throw new Error(`ExecutionAttempt ${attemptId} does not exist`);
      const task = this.getTask(attempt.taskId)!;
      if (task.executionProtocol !== 'GENERATION')
        throw new Error('Only GENERATION attempts may bind a GenerationJob');
      const generationTask = this.db
        .prepare(
          `SELECT gt.task_json, gt.target_teammate_id, job.runtime_profile_id
           FROM generation_jobs AS job JOIN generation_tasks AS gt ON gt.id = job.generation_task_id
           WHERE job.id = ?`,
        )
        .get(jobId) as
        | { task_json: string; target_teammate_id: string; runtime_profile_id: string }
        | undefined;
      if (!generationTask) throw new Error(`GenerationJob ${jobId} does not exist`);
      const snapshot = parseJsonRecord(generationTask.task_json, 'GenerationTask');
      if (
        snapshot.executionAttemptId !== attempt.id ||
        snapshot.missionId !== task.missionId ||
        snapshot.runId !== task.runId ||
        (snapshot.collaborationRequestId ?? null) !== task.collaborationRequestId ||
        generationTask.target_teammate_id !== task.targetTeammateId ||
        generationTask.runtime_profile_id !== attempt.runtimeProfileId
      ) {
        throw new Error('GenerationJob provenance does not match its G3 ExecutionAttempt');
      }
      if (attempt.generationJobId !== null && attempt.generationJobId !== jobId) {
        throw new Error('ExecutionAttempt is already bound to another GenerationJob');
      }
      if (attempt.generationJobId === null) {
        this.db
          .prepare(
            'UPDATE g3_execution_attempts SET generation_job_id = ? WHERE id = ? AND generation_job_id IS NULL',
          )
          .run(jobId, attemptId);
      }
      const bound = this.getAttempt(attemptId)!;
      if (bound.generationJobId !== jobId)
        throw new Error('GenerationJob binding did not persist atomically');
      return bound;
    })();
  }

  /** Binds Human Bridge work, or a USER_BRIDGE continuation requested by a waiting GENERATION attempt. */
  bindExternalWork(attemptId: string, requestId: string): ExecutionAttempt {
    validateId(attemptId, 'ExecutionAttempt');
    validateId(requestId, 'ExternalWorkRequest');
    return this.db.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt) throw new Error(`ExecutionAttempt ${attemptId} does not exist`);
      const task = this.getTask(attempt.taskId)!;
      const userBridgeExecution = task.executionProtocol === 'USER_BRIDGE';
      const userInputContinuation =
        attempt.state === 'WAITING_USER' &&
        (task.executionProtocol === 'LANGUAGE' || task.executionProtocol === 'GENERATION');
      const reviewContinuation =
        attempt.state === 'COMPLETED' &&
        (task.executionProtocol === 'LANGUAGE' || task.executionProtocol === 'GENERATION');
      if (!(userBridgeExecution || userInputContinuation || reviewContinuation)) {
        throw new Error(
          'External work binds only USER_BRIDGE, a WAITING_USER input, or a completed review continuation',
        );
      }
      const request = this.db
        .prepare(
          'SELECT mission_id, run_id, assignee_teammate_id FROM external_work_requests WHERE id = ?',
        )
        .get(requestId) as
        | { mission_id: string; run_id: string; assignee_teammate_id: string }
        | undefined;
      if (!request) throw new Error(`ExternalWorkRequest ${requestId} does not exist`);
      if (request.mission_id !== task.missionId || request.run_id !== task.runId) {
        throw new Error('ExternalWorkRequest provenance does not match the ExecutionTask Run');
      }
      if (
        task.executionProtocol === 'USER_BRIDGE' &&
        request.assignee_teammate_id !== task.targetTeammateId
      ) {
        throw new Error('ExternalWorkRequest assignee does not match its USER_BRIDGE participant');
      }
      if (attempt.externalWorkRequestId !== null && attempt.externalWorkRequestId !== requestId) {
        throw new Error('ExecutionAttempt is already bound to another ExternalWorkRequest');
      }
      if (attempt.externalWorkRequestId === null) {
        this.db
          .prepare(
            'UPDATE g3_execution_attempts SET external_work_request_id = ? WHERE id = ? AND external_work_request_id IS NULL',
          )
          .run(requestId, attemptId);
      }
      return this.getAttempt(attemptId)!;
    })();
  }

  registerArtifactRef(
    missionId: string,
    runId: string,
    ref: ArtifactRef,
    source?: ArtifactRefSource,
  ): ArtifactRef {
    validateId(missionId, 'Mission');
    validateId(runId, 'Mission Run');
    const artifact = validateArtifactRef(ref);
    if (source) {
      validateId(source.id, 'Artifact source');
      if (!['GENERATION', 'EXTERNAL_WORK', 'APPROVED_IMPORT'].includes(source.type)) {
        throw new Error('Unsupported ArtifactRef source type');
      }
    }
    const createdAt = nowIso();
    const provenanceJson = canonicalJson(source ? { source } : {});
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM g3_artifact_refs
           WHERE mission_id = ? AND run_id = ? AND artifact_id = ?`,
        )
        .get(missionId, runId, artifact.id) as
        | (ArtifactRefRow & {
            source_type: string | null;
            source_id: string | null;
            provenance_json: string;
          })
        | undefined;
      if (existing) {
        if (
          existing.kind !== artifact.kind ||
          existing.mime_type !== artifact.mimeType ||
          existing.content_hash !== artifact.contentHash ||
          existing.size_bytes !== artifact.sizeBytes ||
          existing.source_type !== (source?.type ?? null) ||
          existing.source_id !== (source?.id ?? null) ||
          existing.provenance_json !== provenanceJson
        ) {
          throw new Error('ARTIFACT_REF_CONFLICT: Run already stores different Artifact facts');
        }
        return mapArtifactRef(existing);
      }
      this.db
        .prepare(
          `INSERT INTO g3_artifact_refs (
            mission_id, run_id, artifact_id, kind, mime_type, content_hash,
            size_bytes, source_type, source_id, provenance_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          missionId,
          runId,
          artifact.id,
          artifact.kind,
          artifact.mimeType,
          artifact.contentHash,
          artifact.sizeBytes,
          source?.type ?? null,
          source?.id ?? null,
          provenanceJson,
          createdAt,
        );
      return artifact;
    })();
  }

  listArtifactRefs(missionId: string, runId: string): ArtifactRef[] {
    validateId(missionId, 'Mission');
    validateId(runId, 'Mission Run');
    const rows = this.db
      .prepare(
        `SELECT artifact_id, kind, mime_type, content_hash, size_bytes
         FROM g3_artifact_refs WHERE mission_id = ? AND run_id = ?
         ORDER BY created_at, artifact_id`,
      )
      .all(missionId, runId) as ArtifactRefRow[];
    return rows.map(mapArtifactRef);
  }

  /** Includes unfinished attempts and durable outcome/decision intents needing recovery. */
  listPending(): G3PendingExecution[] {
    const rows = this.db
      .prepare(
        `SELECT task.task_json, attempt.*,
                outcome.id AS outcome_id, outcome.task_id AS outcome_task_id,
                outcome.attempt_id AS outcome_attempt_id, outcome.mission_id AS outcome_mission_id,
                outcome.run_id AS outcome_run_id, outcome.collaboration_request_id AS outcome_request_id,
                outcome.participant_teammate_id AS outcome_participant_id,
                outcome.execution_protocol AS outcome_protocol, outcome.kind AS outcome_kind,
                outcome.outcome_json, outcome.created_at AS outcome_created_at,
                outcome.consumed_at AS outcome_consumed_at,
                continuation.id AS continuation_id, continuation.outcome_id AS continuation_outcome_id,
                continuation.task_id AS continuation_task_id, continuation.attempt_id AS continuation_attempt_id,
                continuation.mission_id AS continuation_mission_id, continuation.run_id AS continuation_run_id,
                continuation.collaboration_request_id AS continuation_request_id,
                continuation.action AS continuation_action, continuation.decision_json,
                continuation.continuation_round, continuation.created_at AS continuation_created_at,
                continuation.consumed_at AS continuation_consumed_at
         FROM g3_execution_attempts AS attempt
         JOIN g3_execution_tasks AS task ON task.id = attempt.task_id
         LEFT JOIN g3_participant_outcomes AS outcome ON outcome.attempt_id = attempt.id
         LEFT JOIN g3_continuations AS continuation ON continuation.outcome_id = outcome.id
         WHERE attempt.state IN ('PREPARED','RUNNING','WAITING_INPUT','WAITING_CAPABILITY','WAITING_USER')
            OR (attempt.state IN ('COMPLETED','FAILED','UNKNOWN') AND outcome.id IS NULL)
            OR (outcome.id IS NOT NULL AND outcome.consumed_at IS NULL)
            OR (continuation.id IS NOT NULL AND continuation.consumed_at IS NULL)
         ORDER BY attempt.created_at, attempt.task_id, attempt.attempt_no`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const attempt = mapAttempt(row as unknown as AttemptRow);
      const task = this.getTask(attempt.taskId);
      if (!task) throw new Error(`ExecutionTask ${attempt.taskId} does not exist`);
      const outcome =
        row.outcome_id === null
          ? null
          : mapOutcome({
              id: String(row.outcome_id),
              task_id: String(row.outcome_task_id),
              attempt_id: String(row.outcome_attempt_id),
              mission_id: String(row.outcome_mission_id),
              run_id: String(row.outcome_run_id),
              collaboration_request_id: nullableString(row.outcome_request_id),
              participant_teammate_id: String(row.outcome_participant_id),
              execution_protocol: row.outcome_protocol as ExecutionDispatchProtocol,
              kind: row.outcome_kind as ParticipantOutcome['kind'],
              outcome_json: String(row.outcome_json),
              created_at: String(row.outcome_created_at),
              consumed_at: nullableString(row.outcome_consumed_at),
            });
      const continuation =
        row.continuation_id === null
          ? null
          : mapContinuation({
              id: String(row.continuation_id),
              outcome_id: String(row.continuation_outcome_id),
              task_id: String(row.continuation_task_id),
              attempt_id: String(row.continuation_attempt_id),
              mission_id: String(row.continuation_mission_id),
              run_id: String(row.continuation_run_id),
              collaboration_request_id: nullableString(row.continuation_request_id),
              action: row.continuation_action as G3ContinuationDecision['action'],
              decision_json: String(row.decision_json),
              continuation_round: Number(row.continuation_round),
              created_at: String(row.continuation_created_at),
              consumed_at: nullableString(row.continuation_consumed_at),
            });
      return { task, attempt, outcome, continuation };
    });
  }

  /** better-sqlite3 transactions are synchronous; async callbacks are rejected. */
  transaction<T>(callback: (repository: G3SqliteRepository) => T): T {
    let value!: T;
    this.db.transaction(() => {
      value = callback(this);
      if (value !== null && typeof value === 'object' && 'then' in value) {
        throw new Error('G3SqliteRepository.transaction callback must be synchronous');
      }
    })();
    return value;
  }

  private assertTaskArtifactRefs(task: ExecutionTask): void {
    this.assertArtifactRefs(task.missionId, task.runId, [
      ...task.artifactInputs,
      ...(task.reviewOf ?? []),
    ]);
  }

  private assertArtifactRefs(missionId: string, runId: string, refs: readonly ArtifactRef[]): void {
    const query = this.db.prepare(
      `SELECT 1 FROM g3_artifact_refs
       WHERE mission_id = ? AND run_id = ? AND artifact_id = ?
         AND kind = ? AND mime_type = ? AND content_hash = ? AND size_bytes = ?`,
    );
    for (const ref of refs) {
      const artifact = validateArtifactRef(ref);
      if (
        !query.get(
          missionId,
          runId,
          artifact.id,
          artifact.kind,
          artifact.mimeType,
          artifact.contentHash,
          artifact.sizeBytes,
        )
      ) {
        throw new Error(
          `ARTIFACT_PROVENANCE: Artifact ${artifact.id} is not registered for this Mission Run`,
        );
      }
    }
  }
}

function mapTask(row: TaskRow): ExecutionTask {
  const parsed = parseJsonRecord(row.task_json, 'ExecutionTask') as unknown as ExecutionTask;
  validateExecutionTask(parsed);
  if (
    parsed.id !== row.id ||
    parsed.logicalKey !== row.logical_key ||
    parsed.source !== row.source ||
    parsed.missionId !== row.mission_id ||
    parsed.runId !== row.run_id ||
    parsed.collaborationRequestId !== row.collaboration_request_id ||
    parsed.workflowRunId !== row.workflow_run_id ||
    parsed.workflowStepRunId !== row.workflow_step_run_id ||
    parsed.targetTeammateId !== row.target_teammate_id ||
    parsed.executionProtocol !== row.execution_protocol
  ) {
    throw new Error('Stored ExecutionTask identity does not match its indexed columns');
  }
  return parsed;
}

function mapAttempt(row: AttemptRow): ExecutionAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    runtimeProfileId: row.runtime_profile_id,
    state: row.state,
    generationJobId: row.generation_job_id,
    externalWorkRequestId: row.external_work_request_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutcome(row: OutcomeRow): ParticipantOutcomeFact {
  const outcome = parseParticipantOutcome(parseJsonRecord(row.outcome_json, 'ParticipantOutcome'));
  if (outcome.kind !== row.kind)
    throw new Error('Stored ParticipantOutcome kind does not match its indexed column');
  return {
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    missionId: row.mission_id,
    runId: row.run_id,
    collaborationRequestId: row.collaboration_request_id,
    participantTeammateId: row.participant_teammate_id,
    executionProtocol: row.execution_protocol,
    outcome,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

function mapContinuation(row: ContinuationRow): G3Continuation {
  const decision = parseG3ContinuationDecision(
    parseJsonRecord(row.decision_json, 'Continuation decision'),
  );
  if (decision.action !== row.action)
    throw new Error('Stored continuation action does not match its indexed column');
  return {
    id: row.id,
    outcomeId: row.outcome_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    missionId: row.mission_id,
    runId: row.run_id,
    collaborationRequestId: row.collaboration_request_id,
    decision,
    continuationRound: row.continuation_round,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

function mapArtifactRef(row: ArtifactRefRow): ArtifactRef {
  return {
    id: row.artifact_id,
    kind: row.kind,
    mimeType: row.mime_type,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
  };
}

function validateArtifactRef(ref: ArtifactRef): ArtifactRef {
  const parsed = parseParticipantOutcome({
    kind: 'RESULT',
    artifactRefs: [
      {
        id: ref.id,
        kind: ref.kind,
        mimeType: ref.mimeType,
        contentHash: ref.contentHash,
        sizeBytes: ref.sizeBytes,
      },
    ],
  });
  return parsed.kind === 'RESULT'
    ? parsed.artifactRefs[0]!
    : (() => {
        throw new Error('Invalid ArtifactRef');
      })();
}

function outcomeState(outcome: ParticipantOutcome): ExecutionAttemptState {
  switch (outcome.kind) {
    case 'RESULT':
      return 'COMPLETED';
    case 'NEEDS_INPUT':
      return 'WAITING_INPUT';
    case 'NEEDS_CAPABILITY':
      return 'WAITING_CAPABILITY';
    case 'FAILED_RETRYABLE':
    case 'FAILED_TERMINAL':
      return 'FAILED';
  }
}

function parseJsonRecord(json: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`Stored ${label} JSON is invalid`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Stored ${label} JSON must be an object`);
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('JSON numbers must be finite');
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (record[key] !== undefined) result[key] = normalize(record[key]);
      }
      return result;
    }
    throw new Error('Value is not JSON serializable');
  };
  return JSON.stringify(normalize(value));
}

function assertJsonBytes(json: string, limit: number, label: string): void {
  if (new TextEncoder().encode(json).length > limit)
    throw new Error(`${label} exceeds ${limit} UTF-8 bytes`);
}

function validateId(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_ID_LENGTH ||
    value.includes('\0')
  ) {
    throw new Error(`${label} ID must be non-empty text of at most ${MAX_ID_LENGTH} characters`);
  }
}

function validateTimestamp(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_TIMESTAMP_LENGTH ||
    value.includes('\0')
  ) {
    throw new Error(
      `Timestamp must be non-empty text of at most ${MAX_TIMESTAMP_LENGTH} characters`,
    );
  }
}

function validateErrorCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(value))
    throw new Error('errorCode must be a stable uppercase code');
}

function nowIso(): string {
  return new Date().toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
