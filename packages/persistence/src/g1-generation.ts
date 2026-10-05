import Database from 'better-sqlite3';
import { transitionGenerationJob } from '@cultivation/domain/g1-generation';
import type {
  GenerationArtifact,
  GenerationJob,
  GenerationJobState,
  GenerationModelDescriptor,
  GenerationTask,
} from '@cultivation/domain/g1-generation';

interface GenerationJobRow {
  id: string;
  generation_task_id: string;
  teammate_id: string;
  runtime_profile_id: string;
  provider_job_id: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  state: GenerationJobState;
  provider_status: string | null;
  output_artifact_ids_json: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface GenerationArtifactRow {
  id: string;
  job_id: string;
  output_id: string;
  kind: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  content_hash: string;
  metadata_json: string;
  storage_scope: GenerationArtifact['storageScope'];
  storage_key: string;
  created_at: string;
}

export interface GenerationJobPatch {
  providerJobId?: string | null;
  providerStatus?: string | null;
  errorCode?: string | null;
}

/**
 * Durable G1 Generation snapshots and jobs. The SQL migration re-checks the
 * sealed MODEL_RUNTIME/GENERATION identity so callers cannot forge it here.
 */
export class GenerationSqliteRepository {
  constructor(private readonly db: Database.Database) {}

  /** Create once per task ID; an exact replay is a no-op, a changed replay conflicts. */
  create(task: GenerationTask, descriptor: GenerationModelDescriptor, job: GenerationJob): void {
    const taskJson = canonicalJson(task);
    const descriptorJson = canonicalJson(descriptor);
    validateCreationFacts(task, descriptor, job);

    this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT t.id AS task_id, t.target_teammate_id, t.task_json, t.descriptor_json,
                  t.created_at AS task_created_at, j.*
           FROM generation_tasks AS t
           LEFT JOIN generation_jobs AS j ON j.generation_task_id = t.id
           WHERE t.id = ?`,
        )
        .get(task.id) as
        | (GenerationJobRow & {
            task_id: string;
            target_teammate_id: string;
            task_json: string;
            descriptor_json: string;
            task_created_at: string;
          })
        | undefined;

      if (existing) {
        if (
          existing.task_json === taskJson &&
          existing.descriptor_json === descriptorJson &&
          existing.target_teammate_id === task.targetTeammateId &&
          existing.task_created_at === task.createdAt &&
          existing.id === job.id &&
          existing.generation_task_id === job.generationTaskId &&
          existing.teammate_id === job.teammateId &&
          existing.runtime_profile_id === job.runtimeProfileId &&
          existing.idempotency_key === job.idempotencyKey &&
          existing.request_fingerprint === job.requestFingerprint &&
          existing.created_at === job.createdAt
        ) {
          return;
        }
        throw new Error('IDEMPOTENCY_CONFLICT: task ID already stores different immutable facts');
      }

      this.db
        .prepare(
          `INSERT INTO generation_tasks
             (id, target_teammate_id, task_json, descriptor_json, created_at)
           VALUES (@id, @targetTeammateId, @taskJson, @descriptorJson, @createdAt)`,
        )
        .run({
          id: task.id,
          targetTeammateId: task.targetTeammateId,
          taskJson,
          descriptorJson,
          createdAt: task.createdAt,
        });

      this.db
        .prepare(
          `INSERT INTO generation_jobs
             (id, generation_task_id, teammate_id, runtime_profile_id, provider_job_id,
              idempotency_key, request_fingerprint, state, provider_status,
              output_artifact_ids_json, error_code, created_at, updated_at, completed_at)
           VALUES (@id, @generationTaskId, @teammateId, @runtimeProfileId, @providerJobId,
              @idempotencyKey, @requestFingerprint, @state, @providerStatus,
              @outputArtifactIds, @errorCode, @createdAt, @updatedAt, @completedAt)`,
        )
        .run(jobInsertValues(job));

      this.appendEvent({
        jobId: job.id,
        taskId: task.id,
        eventType: 'generation.task_created',
        fromState: null,
        toState: 'PENDING',
        actorType: task.requester.actorType,
        actorId: task.requester.actorId,
        errorCode: null,
        createdAt: job.createdAt,
      });
      this.appendEvent({
        jobId: job.id,
        taskId: task.id,
        eventType: 'generation.job_created',
        fromState: null,
        toState: 'PENDING',
        actorType: task.requester.actorType,
        actorId: task.requester.actorId,
        errorCode: null,
        createdAt: job.createdAt,
      });
    })();
  }

  getTask(id: string): GenerationTask | null {
    const row = this.db.prepare('SELECT task_json FROM generation_tasks WHERE id = ?').get(id) as
      | { task_json: string }
      | undefined;
    return row ? parseJson<GenerationTask>(row.task_json, 'GenerationTask') : null;
  }

  getDescriptor(taskId: string): GenerationModelDescriptor | null {
    const row = this.db
      .prepare('SELECT descriptor_json FROM generation_tasks WHERE id = ?')
      .get(taskId) as { descriptor_json: string } | undefined;
    return row
      ? parseJson<GenerationModelDescriptor>(row.descriptor_json, 'GenerationModelDescriptor')
      : null;
  }

  getJob(id: string): GenerationJob | null {
    const row = this.db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as
      | GenerationJobRow
      | undefined;
    return row ? mapJob(row) : null;
  }

  listJobs(): GenerationJob[] {
    return (
      this.db
        .prepare('SELECT * FROM generation_jobs ORDER BY created_at, id')
        .all() as GenerationJobRow[]
    ).map(mapJob);
  }

  /** UNKNOWN is deliberately terminal: uncertain submissions are never auto-resubmitted. */
  listRecoverableJobs(): GenerationJob[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM generation_jobs
           WHERE state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN')
           ORDER BY created_at, id`,
        )
        .all() as GenerationJobRow[]
    ).map(mapJob);
  }

  /** Compare-and-swap one durable state transition and append its bounded event. */
  observeProviderStatus(
    id: string,
    expectedState: GenerationJobState,
    status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN',
  ): GenerationJob {
    if (!['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(status))
      throw new Error('Invalid provider status');
    return this.db.transaction(() => {
      const before = this.getJob(id);
      if (
        !before ||
        before.state !== expectedState ||
        !['QUEUED', 'RUNNING'].includes(before.state)
      )
        throw new Error('Provider status compare-and-swap conflict');
      if (before.providerStatus === status) return before;
      const timestamp = new Date().toISOString();
      const result = this.db
        .prepare('UPDATE generation_jobs SET provider_status=?,updated_at=? WHERE id=? AND state=?')
        .run(status, timestamp, id, expectedState);
      if (result.changes !== 1) throw new Error('Provider status compare-and-swap conflict');
      this.appendEvent({
        jobId: id,
        taskId: before.generationTaskId,
        eventType: `generation.provider_${status.toLowerCase()}`,
        fromState: before.state,
        toState: before.state,
        actorType: 'SYSTEM',
        actorId: null,
        errorCode: null,
        createdAt: timestamp,
      });
      return this.getJob(id)!;
    })();
  }

  /** Compare-and-swap one durable state transition and append its bounded event. */
  transition(
    id: string,
    expectedState: GenerationJobState,
    nextState: GenerationJobState,
    patch: GenerationJobPatch = {},
  ): GenerationJob {
    transitionGenerationJob(expectedState, nextState);
    if (nextState === 'COMPLETED') {
      throw new Error('Use complete() after registering every output Artifact');
    }

    return this.db.transaction(() => {
      const before = this.getJob(id);
      if (!before) throw new Error(`GenerationJob ${id} does not exist`);
      if (before.state !== expectedState) {
        throw new Error(
          `GenerationJob compare-and-swap conflict: expected ${expectedState}, found ${before.state}`,
        );
      }

      const providerJobId = hasOwn(patch, 'providerJobId')
        ? (patch.providerJobId ?? null)
        : before.providerJobId;
      const providerStatus = hasOwn(patch, 'providerStatus')
        ? (patch.providerStatus ?? null)
        : before.providerStatus;
      const errorCode = hasOwn(patch, 'errorCode') ? (patch.errorCode ?? null) : before.errorCode;
      validateNullableBoundedText(providerJobId, 512, 'providerJobId');
      validateNullableBoundedText(providerStatus, 120, 'providerStatus');
      validateNullableBoundedText(errorCode, 80, 'errorCode');
      const updatedAt = new Date().toISOString();

      const result = this.db
        .prepare(
          `UPDATE generation_jobs
           SET provider_job_id = @providerJobId, provider_status = @providerStatus,
               error_code = @errorCode, state = @nextState, updated_at = @updatedAt
           WHERE id = @id AND state = @expectedState`,
        )
        .run({ id, expectedState, nextState, providerJobId, providerStatus, errorCode, updatedAt });
      if (result.changes !== 1) {
        throw new Error(`GenerationJob compare-and-swap conflict for ${id}`);
      }

      this.appendEvent({
        jobId: id,
        taskId: before.generationTaskId,
        eventType: `generation.job_${nextState.toLowerCase()}`,
        fromState: before.state,
        toState: nextState,
        actorType: 'SYSTEM',
        actorId: null,
        errorCode,
        createdAt: updatedAt,
      });
      return this.getJob(id)!;
    })();
  }

  /**
   * Register an already verified Main-process output. Replaying the same
   * provider output ID and SHA-256 returns its original Artifact identity.
   */
  registerOutput(jobId: string, artifact: GenerationArtifact): GenerationArtifact {
    return this.db.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new Error(`GenerationJob ${jobId} does not exist`);
      if (artifact.jobId !== jobId) throw new Error('Artifact belongs to another GenerationJob');
      if (job.state !== 'QUEUED' && job.state !== 'RUNNING') {
        throw new Error(`Cannot register output while GenerationJob is ${job.state}`);
      }

      const task = this.getTask(job.generationTaskId);
      const descriptor = this.getDescriptor(job.generationTaskId);
      if (!task || !descriptor) throw new Error('GenerationTask snapshot is missing');
      validateArtifact(task, descriptor, artifact);

      const existing = this.db
        .prepare('SELECT * FROM generation_artifacts WHERE job_id = ? AND output_id = ?')
        .get(jobId, artifact.outputId) as GenerationArtifactRow | undefined;
      if (existing) {
        const registered = mapArtifact(existing);
        if (registered.contentHash !== artifact.contentHash) {
          throw new Error(
            'ARTIFACT_INTEGRITY: provider output ID was registered with another hash',
          );
        }
        if (!sameOutputFacts(registered, artifact)) {
          throw new Error('ARTIFACT_INTEGRITY: provider output facts changed after registration');
        }
        return registered;
      }

      if (this.db.prepare('SELECT 1 FROM generation_artifacts WHERE id = ?').get(artifact.id)) {
        throw new Error(`Artifact ID ${artifact.id} already belongs to another output`);
      }
      if (this.listArtifacts(jobId).length >= descriptor.limits.maxOutputs) {
        throw new Error('OUTPUT_LIMIT: too many generation outputs');
      }

      this.db
        .prepare(
          `INSERT INTO generation_artifacts
             (id, job_id, output_id, kind, mime_type, extension, size_bytes,
              content_hash, metadata_json, storage_scope, storage_key, created_at)
           VALUES (@id, @jobId, @outputId, @kind, @mimeType, @extension, @sizeBytes,
              @contentHash, @metadataJson, @storageScope, @storageKey, @createdAt)`,
        )
        .run({
          id: artifact.id,
          jobId,
          outputId: artifact.outputId,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          extension: artifact.extension,
          sizeBytes: artifact.sizeBytes,
          contentHash: artifact.contentHash,
          metadataJson: canonicalJson(artifact.metadata),
          storageScope: artifact.storageScope,
          storageKey: artifact.storageKey,
          createdAt: artifact.createdAt,
        });

      const outputArtifactIds = [...job.outputArtifactIds, artifact.id];
      const updatedAt = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE generation_jobs
           SET output_artifact_ids_json = @outputArtifactIds, updated_at = @updatedAt
           WHERE id = @jobId AND state = @state`,
        )
        .run({
          outputArtifactIds: JSON.stringify(outputArtifactIds),
          updatedAt,
          jobId,
          state: job.state,
        });

      this.appendEvent({
        jobId,
        taskId: job.generationTaskId,
        eventType: 'generation.output_registered',
        fromState: job.state,
        toState: job.state,
        actorType: 'SYSTEM',
        actorId: null,
        errorCode: null,
        createdAt: updatedAt,
      });
      return this.getArtifact(artifact.id)!;
    })();
  }

  getArtifact(id: string): GenerationArtifact | null {
    const row = this.db.prepare('SELECT * FROM generation_artifacts WHERE id = ?').get(id) as
      | GenerationArtifactRow
      | undefined;
    return row ? mapArtifact(row) : null;
  }

  listArtifacts(jobId: string): GenerationArtifact[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM generation_artifacts
           WHERE job_id = ? ORDER BY created_at, output_id, id`,
        )
        .all(jobId) as GenerationArtifactRow[]
    ).map(mapArtifact);
  }

  /** Complete only when every registered Artifact is named exactly once. */
  complete(jobId: string, expectedState: GenerationJobState, outputIds: string[]): GenerationJob {
    transitionGenerationJob(expectedState, 'COMPLETED');
    return this.db.transaction(() => {
      const before = this.getJob(jobId);
      if (!before) throw new Error(`GenerationJob ${jobId} does not exist`);
      if (before.state !== expectedState) {
        throw new Error(
          `GenerationJob compare-and-swap conflict: expected ${expectedState}, found ${before.state}`,
        );
      }
      if (expectedState !== 'QUEUED' && expectedState !== 'RUNNING') {
        throw new Error(`Cannot complete a GenerationJob from ${expectedState}`);
      }
      if (
        outputIds.length === 0 ||
        outputIds.some((id) => !id) ||
        new Set(outputIds).size !== outputIds.length
      ) {
        throw new Error('OUTPUT_MISSING: completion requires unique registered Artifact IDs');
      }

      const registeredIds = this.db
        .prepare(
          'SELECT id FROM generation_artifacts WHERE job_id = ? ORDER BY created_at, output_id, id',
        )
        .all(jobId) as { id: string }[];
      const registeredSet = new Set(registeredIds.map(({ id }) => id));
      if (
        registeredIds.length !== outputIds.length ||
        outputIds.some((id) => !registeredSet.has(id))
      ) {
        throw new Error('OUTPUT_MISSING: completion list does not match registered outputs');
      }

      const timestamp = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE generation_jobs
           SET state = 'COMPLETED', provider_status = 'COMPLETED', output_artifact_ids_json = @outputArtifactIds,
               completed_at = @timestamp, updated_at = @timestamp
           WHERE id = @jobId AND state = @expectedState`,
        )
        .run({
          outputArtifactIds: JSON.stringify(outputIds),
          timestamp,
          jobId,
          expectedState,
        });
      if (result.changes !== 1) {
        throw new Error(`GenerationJob compare-and-swap conflict for ${jobId}`);
      }

      this.appendEvent({
        jobId,
        taskId: before.generationTaskId,
        eventType: 'generation.job_completed',
        fromState: before.state,
        toState: 'COMPLETED',
        actorType: 'SYSTEM',
        actorId: null,
        errorCode: null,
        createdAt: timestamp,
      });
      return this.getJob(jobId)!;
    })();
  }

  private appendEvent(event: {
    jobId: string;
    taskId: string;
    eventType: string;
    fromState: GenerationJobState | null;
    toState: GenerationJobState | null;
    actorType: string;
    actorId: string | null;
    errorCode: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO generation_events
           (job_id, generation_task_id, event_type, from_state, to_state,
            actor_type, actor_id, error_code, created_at)
         VALUES (@jobId, @taskId, @eventType, @fromState, @toState,
            @actorType, @actorId, @errorCode, @createdAt)`,
      )
      .run(event);
  }
}

function validateCreationFacts(
  task: GenerationTask,
  descriptor: GenerationModelDescriptor,
  job: GenerationJob,
): void {
  validateBoundedText(task.id, 256, 'task.id');
  validateBoundedText(task.targetTeammateId, 256, 'task.targetTeammateId');
  validateBoundedText(job.id, 256, 'job.id');
  validateBoundedText(job.runtimeProfileId, 256, 'job.runtimeProfileId');
  validateBoundedText(job.requestFingerprint, 128, 'job.requestFingerprint');
  if (!/^[a-f0-9]{64}$/.test(job.requestFingerprint)) {
    throw new Error('GenerationJob requestFingerprint must be a SHA-256 hex digest');
  }
  if (
    job.generationTaskId !== task.id ||
    job.teammateId !== task.targetTeammateId ||
    job.idempotencyKey !== task.id
  ) {
    throw new Error('GenerationJob identity must match its task and idempotency key');
  }
  if (
    job.state !== 'PENDING' ||
    job.providerJobId !== null ||
    job.providerStatus !== null ||
    job.outputArtifactIds.length !== 0 ||
    job.errorCode !== null ||
    job.completedAt !== null
  ) {
    throw new Error('A new GenerationJob must start empty in PENDING');
  }
  if (descriptor.modelId.trim().length === 0 || descriptor.outputCapability !== task.capability) {
    throw new Error('GenerationTask capability or descriptor model identity is invalid');
  }
  if (
    task.requiredFeatures.some((feature) => !descriptor.featureTags.includes(feature)) ||
    task.inputs.some((input) => !descriptor.inputRoles.some((role) => role.role === input.role)) ||
    task.expectedOutput.mimeTypes.length === 0 ||
    task.expectedOutput.mimeTypes.some((mimeType) => !descriptor.outputTypes.includes(mimeType))
  ) {
    throw new Error('GenerationTask is incompatible with its immutable descriptor snapshot');
  }
  canonicalJson(task);
  canonicalJson(descriptor);
  validateTimestamp(task.createdAt, 'task.createdAt');
  validateTimestamp(job.createdAt, 'job.createdAt');
  validateTimestamp(job.updatedAt, 'job.updatedAt');
  if (task.createdAt !== job.createdAt) {
    throw new Error('GenerationTask and initial GenerationJob timestamps must match');
  }
}

function validateArtifact(
  task: GenerationTask,
  descriptor: GenerationModelDescriptor,
  artifact: GenerationArtifact,
): void {
  validateBoundedText(artifact.id, 256, 'artifact.id');
  validateBoundedText(artifact.outputId, 256, 'artifact.outputId');
  if (artifact.kind !== task.expectedOutput.artifactKind) {
    throw new Error('OUTPUT_MISSING: output Artifact kind does not satisfy the task');
  }
  if (
    !task.expectedOutput.mimeTypes.includes(artifact.mimeType) ||
    !descriptor.outputTypes.includes(artifact.mimeType)
  ) {
    throw new Error('UNSUPPORTED_MEDIA_TYPE: output MIME type is not declared by the task/model');
  }
  if (
    artifact.storageScope !== task.outputDestination.scope ||
    !isSafeRelativeStorageKey(artifact.storageKey)
  ) {
    throw new Error('INVALID_OUTPUT_DESTINATION: output must use its authorized opaque store key');
  }
  if (!/^\.[a-z0-9]{1,12}$/.test(artifact.extension)) {
    throw new Error('INVALID_OUTPUT: extension must be a normalized file extension');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.contentHash)) {
    throw new Error('ARTIFACT_INTEGRITY: output must have a SHA-256 content hash');
  }
  if (
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes <= 0 ||
    artifact.sizeBytes > descriptor.limits.maxOutputBytes
  ) {
    throw new Error('OUTPUT_TOO_LARGE: output size is invalid or over the model limit');
  }
  if (!isArtifactMetadata(artifact.metadata) || canonicalJson(artifact.metadata).length > 4096) {
    throw new Error('INVALID_OUTPUT: Artifact metadata must be a bounded object');
  }
  validateTimestamp(artifact.createdAt, 'artifact.createdAt');
}

function sameOutputFacts(left: GenerationArtifact, right: GenerationArtifact): boolean {
  return (
    left.kind === right.kind &&
    left.mimeType === right.mimeType &&
    left.extension === right.extension &&
    left.sizeBytes === right.sizeBytes &&
    left.contentHash === right.contentHash &&
    canonicalJson(left.metadata) === canonicalJson(right.metadata) &&
    left.storageScope === right.storageScope
  );
}

function jobInsertValues(job: GenerationJob): Record<string, unknown> {
  return {
    id: job.id,
    generationTaskId: job.generationTaskId,
    teammateId: job.teammateId,
    runtimeProfileId: job.runtimeProfileId,
    providerJobId: job.providerJobId,
    idempotencyKey: job.idempotencyKey,
    requestFingerprint: job.requestFingerprint,
    state: job.state,
    providerStatus: job.providerStatus,
    outputArtifactIds: canonicalJson(job.outputArtifactIds),
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function mapJob(row: GenerationJobRow): GenerationJob {
  return {
    id: row.id,
    generationTaskId: row.generation_task_id,
    teammateId: row.teammate_id,
    runtimeProfileId: row.runtime_profile_id,
    providerJobId: row.provider_job_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    providerStatus: row.provider_status,
    outputArtifactIds: parseJson<string[]>(row.output_artifact_ids_json, 'outputArtifactIds'),
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapArtifact(row: GenerationArtifactRow): GenerationArtifact {
  return {
    id: row.id,
    jobId: row.job_id,
    outputId: row.output_id,
    kind: row.kind,
    mimeType: row.mime_type,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    metadata: parseJson<Record<string, number | string | boolean | null>>(
      row.metadata_json,
      'Artifact metadata',
    ),
    storageScope: row.storage_scope,
    storageKey: row.storage_key,
    createdAt: row.created_at,
  };
}

function parseJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`PERSISTENCE_INTEGRITY: malformed ${label} JSON`);
  }
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Snapshot JSON cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('Snapshot JSON cannot contain cycles');
    ancestors.add(value);
    const result = `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) throw new Error('Snapshot JSON cannot contain cycles');
    ancestors.add(value);
    const result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`)
      .join(',')}}`;
    ancestors.delete(value);
    return result;
  }
  throw new Error('Snapshot JSON contains an unsupported value');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactMetadata(
  value: unknown,
): value is Record<string, string | number | boolean | null> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) =>
        item === null ||
        typeof item === 'string' ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)),
    )
  );
}

function isSafeRelativeStorageKey(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    // eslint-disable-next-line no-control-regex -- Reject control bytes in persisted relative keys.
    /[\\:\u0000-\u001f<>"|?*]/.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..' && segment.trim() === segment,
  );
}

function validateBoundedText(value: string, max: number, label: string): void {
  // eslint-disable-next-line no-control-regex -- Persisted identifiers cannot contain control bytes.
  if (value.trim().length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} is empty or outside its storage bound`);
  }
}

function validateNullableBoundedText(value: string | null, max: number, label: string): void {
  if (value !== null) validateBoundedText(value, max, label);
}

function validateTimestamp(value: string, label: string): void {
  if (value.length > 64 || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
}

function hasOwn<T extends object>(value: T, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}
