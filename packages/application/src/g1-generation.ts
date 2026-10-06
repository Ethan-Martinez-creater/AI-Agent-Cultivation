import Ajv from 'ajv';
import { DomainError } from '@cultivation/shared';
import { transitionGenerationJob } from '@cultivation/domain/g1-generation';
import type {
  GenerationArtifact,
  GenerationJob,
  GenerationJobState,
  GenerationModelDescriptor,
  GenerationOutputDescriptor,
  GenerationTask,
  GenerationSubmission,
  ProviderGenerationJob,
} from '@cultivation/domain/g1-generation';
import {
  generationMediaCategory,
  getGenerationMediaCeilingBytes,
  isGenerationMetadataWithinLimit,
} from './g1-media-policy.js';
import type { GenerationMediaCategory } from './g1-media-policy.js';

/** Provider-neutral readable capability. No local paths; honor abort and cancel,
 * yield chunks bounded by the shared media policy, and release resources on iterator return. */
export interface GenerationBinarySource {
  open(signal?: AbortSignal): AsyncIterable<Uint8Array>;
  cancel(reason?: unknown): void | Promise<void>;
}

export interface GenerationOperationOptions {
  signal?: AbortSignal;
}

export interface GenerationResolvedInput {
  artifactId: string;
  role: string;
  kind: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
  source: GenerationBinarySource;
}
/** Adapter guarantees stable logical submission for key + fingerprint, including across restart. */
export interface ProviderGenerationRequest {
  idempotencyKey: string;
  fingerprint: string;
  modelId: string;
  capability: GenerationTask['capability'];
  requiredFeatures: string[];
  prompt: string;
  inputs: GenerationResolvedInput[];
  parameters: Record<string, unknown>;
}
export interface GenerationGateway {
  getDescriptor(runtimeProfileId: string): Promise<GenerationModelDescriptor>;
  submit(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission>;
  getJob(runtimeProfileId: string, providerJobId: string): Promise<ProviderGenerationJob>;
  downloadOutput(
    runtimeProfileId: string,
    providerJobId: string,
    outputId: string,
    options?: GenerationOperationOptions,
  ): Promise<GenerationBinarySource>;
}
export interface GenerationRepository {
  create(task: GenerationTask, descriptor: GenerationModelDescriptor, job: GenerationJob): void;
  getTask(id: string): GenerationTask | null;
  getDescriptor(taskId: string): GenerationModelDescriptor | null;
  getJob(id: string): GenerationJob | null;
  listJobs(): GenerationJob[];
  listRecoverableJobs(): GenerationJob[];
  observeProviderStatus(
    id: string,
    expectedState: GenerationJobState,
    status: ProviderGenerationJob['status'],
  ): GenerationJob;
  transition(
    id: string,
    expectedState: GenerationJobState,
    nextState: GenerationJobState,
    patch?: {
      providerJobId?: string | null;
      providerStatus?: string | null;
      errorCode?: string | null;
    },
  ): GenerationJob;
  registerOutput(jobId: string, artifact: GenerationArtifact): GenerationArtifact;
  getArtifact(id: string): GenerationArtifact | null;
  listArtifacts(jobId: string): GenerationArtifact[];
  complete(jobId: string, expectedState: GenerationJobState, outputIds: string[]): GenerationJob;
}
export interface GenerationIdentityPort {
  requireGenerationIdentity(teammateId: string): { runtimeProfileId: string; modelId: string };
  validateDestination(task: GenerationTask): Promise<void>;
}
export interface GenerationArtifactPort {
  resolveInput(
    binding: GenerationTask['inputs'][number],
    task: GenerationTask,
    options?: GenerationOperationOptions,
  ): Promise<GenerationResolvedInput>;
  fingerprint(value: unknown): string;
  /** Reuses a verified staging/committed file; invokes download only when no safe result exists. */
  commit(
    job: GenerationJob,
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    download: (options?: GenerationOperationOptions) => Promise<GenerationBinarySource>,
    options?: GenerationOperationOptions,
  ): Promise<GenerationArtifact>;
  verify(artifact: GenerationArtifact, task: GenerationTask): Promise<void>;
}
export type GenerationCrashPoint =
  | 'CREATED'
  | 'SUBMITTING'
  | 'SUBMISSION_SENT'
  | 'SUBMITTED'
  | 'PROVIDER_COMPLETED'
  | 'REGISTERED';
export class GenerationCrash extends Error {}
const terminal = new Set<GenerationJobState>(['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
const safeCode = (error: unknown) =>
  error instanceof DomainError ? error.code : 'GENERATION_FAILED';
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('Generation operation aborted');
  error.name = 'AbortError';
  throw error;
}

export function validateGenerationTask(
  task: GenerationTask,
  descriptor: GenerationModelDescriptor,
): void {
  const fail = (code: string) => {
    throw new DomainError(code, '生成任务不满足模型执行规范');
  };
  if (task.capability !== descriptor.outputCapability) fail('UNSUPPORTED_CAPABILITY');
  const outputKind = descriptor.outputCapability.startsWith('IMAGE_')
    ? 'IMAGE'
    : descriptor.outputCapability === 'VIDEO_GENERATION'
      ? 'VIDEO'
      : 'AUDIO';
  if (task.expectedOutput.artifactKind !== outputKind) fail('UNSUPPORTED_MEDIA_TYPE');
  if (
    !Number.isSafeInteger(descriptor.limits.maxInputFiles) ||
    descriptor.limits.maxInputFiles < 0 ||
    descriptor.limits.maxInputFiles > 16 ||
    !Number.isSafeInteger(descriptor.limits.maxInputBytes) ||
    descriptor.limits.maxInputBytes < 0 ||
    !Number.isSafeInteger(descriptor.limits.maxOutputBytes) ||
    descriptor.limits.maxOutputBytes < 1 ||
    !Number.isSafeInteger(descriptor.limits.maxOutputs) ||
    descriptor.limits.maxOutputs < 1 ||
    descriptor.limits.maxOutputs > 8
  )
    fail('INVALID_DESCRIPTOR');
  if (
    task.requiredFeatures.length > 24 ||
    new Set(task.requiredFeatures).size !== task.requiredFeatures.length ||
    task.requiredFeatures.some((f) => !descriptor.featureTags.includes(f))
  )
    fail('UNSUPPORTED_FEATURE');
  if (!task.prompt.trim() || task.prompt.length > 12000) fail('INVALID_INPUT');
  if (task.inputs.length > descriptor.limits.maxInputFiles || task.inputs.length > 16)
    fail('INPUT_TOO_LARGE');
  for (const input of task.inputs) {
    const role = descriptor.inputRoles.find((r) => r.role === input.role);
    if (!role) fail('UNSUPPORTED_INPUT_ROLE');
    if (task.inputs.filter((i) => i.role === input.role).length > role!.maxFiles)
      fail('INPUT_TOO_LARGE');
  }
  if (
    !task.expectedOutput.mimeTypes.length ||
    task.expectedOutput.mimeTypes.some((m) => !descriptor.outputTypes.includes(m))
  )
    fail('UNSUPPORTED_MEDIA_TYPE');
  const ajv = new Ajv({ allErrors: false, schemaId: 'auto', jsonPointers: true });
  if (!ajv.validate(descriptor.parameterSchema, task.parameters)) fail('INVALID_INPUT');
  const duration = task.parameters.durationSeconds;
  if (
    typeof duration === 'number' &&
    ((descriptor.limits.minDurationSeconds !== undefined &&
      duration < descriptor.limits.minDurationSeconds) ||
      (descriptor.limits.maxDurationSeconds !== undefined &&
        duration > descriptor.limits.maxDurationSeconds))
  )
    fail('MODEL_DURATION_LIMIT');
  if (JSON.stringify(task.parameters).length > 8000) fail('INVALID_INPUT');
}

/** G1 jobs are independent durable executions. No Chat/Mission/Workflow orchestration is added. */
export class GenerationService {
  private readonly active = new Map<string, Promise<GenerationJob>>();
  constructor(
    private readonly repository: GenerationRepository,
    private readonly gateway: GenerationGateway,
    private readonly identities: GenerationIdentityPort,
    private readonly artifacts: GenerationArtifactPort,
    private readonly options: {
      id: () => string;
      now?: () => string;
      crash?: (point: GenerationCrashPoint, job: GenerationJob) => void;
    },
  ) {}
  list(): GenerationJob[] {
    return this.repository.listJobs();
  }
  detail(id: string): { job: GenerationJob; artifacts: GenerationArtifact[] } {
    const job = this.repository.getJob(id);
    if (!job) throw new DomainError('NOT_FOUND', '生成任务不存在');
    return { job, artifacts: this.repository.listArtifacts(id) };
  }
  async create(
    input: Omit<GenerationTask, 'id' | 'createdAt'>,
    options?: GenerationOperationOptions,
  ): Promise<GenerationJob> {
    const identity = this.identities.requireGenerationIdentity(input.targetTeammateId);
    const descriptor = await this.gateway.getDescriptor(identity.runtimeProfileId);
    if (descriptor.modelId !== identity.modelId)
      throw new DomainError('INVALID_INPUT', '生成模型描述与固定模型身份不一致');
    const current = this.identities.requireGenerationIdentity(input.targetTeammateId);
    if (
      current.runtimeProfileId !== identity.runtimeProfileId ||
      current.modelId !== identity.modelId
    )
      throw new DomainError('INVALID_INPUT', '生成身份发生变化');
    const timestamp = this.now();
    const task: GenerationTask = JSON.parse(
      JSON.stringify({ ...input, id: this.options.id(), createdAt: timestamp }),
    ) as GenerationTask;
    validateGenerationTask(task, descriptor);
    await this.identities.validateDestination(task);
    const inputs = await this.inputs(task, descriptor, options);
    const requestFingerprint = this.artifacts.fingerprint({
      modelId: descriptor.modelId,
      capability: task.capability,
      requiredFeatures: task.requiredFeatures,
      prompt: task.prompt,
      parameters: task.parameters,
      inputs: inputs.map(({ artifactId, role, kind, mimeType, contentHash, sizeBytes }) => ({
        artifactId,
        role,
        kind,
        mimeType,
        contentHash,
        sizeBytes,
      })),
    });
    const job: GenerationJob = {
      id: this.options.id(),
      generationTaskId: task.id,
      teammateId: task.targetTeammateId,
      runtimeProfileId: identity.runtimeProfileId,
      providerJobId: null,
      idempotencyKey: task.id,
      requestFingerprint,
      state: 'PENDING',
      providerStatus: null,
      outputArtifactIds: [],
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    this.repository.create(task, descriptor, job);
    this.options.crash?.('CREATED', job);
    return job;
  }
  advance(id: string, options?: GenerationOperationOptions): Promise<GenerationJob> {
    const running = this.active.get(id);
    if (running) return running;
    const operation = this.advanceOnce(id, options).finally(() => this.active.delete(id));
    this.active.set(id, operation);
    return operation;
  }
  async recover(): Promise<void> {
    for (const job of this.repository.listRecoverableJobs()) {
      // The adapter resolves the original logical submission using the same durable key.
      // It must return UNKNOWN rather than generate again if its own mapping is uncertain.
      await this.advance(job.id);
    }
  }
  private async inputs(
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    options?: GenerationOperationOptions,
  ): Promise<GenerationResolvedInput[]> {
    const values: GenerationResolvedInput[] = [];
    const inputBytesByCategory = new Map<GenerationMediaCategory, number>();
    let totalInputBytes = 0;
    for (const binding of task.inputs) {
      const input = await this.artifacts.resolveInput(binding, task, options);
      const role = descriptor.inputRoles.find((r) => r.role === binding.role);
      if (
        !role ||
        input.artifactId !== binding.artifactId ||
        input.role !== binding.role ||
        !role.artifactKinds.includes(input.kind) ||
        !role.mimeTypes.includes(input.mimeType)
      )
        throw new DomainError('UNSUPPORTED_MEDIA_TYPE', '输入 Artifact 类型不匹配');
      if (
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 1 ||
        !input.source ||
        typeof input.source.open !== 'function' ||
        typeof input.source.cancel !== 'function'
      )
        throw new DomainError('ARTIFACT_INTEGRITY', '输入 Artifact 流描述无效');
      const mediaLimit = getGenerationMediaCeilingBytes(input.kind, input.mimeType, 'input');
      if (mediaLimit === null)
        throw new DomainError('UNSUPPORTED_MEDIA_TYPE', '输入 Artifact 媒体类型无效');
      const category = generationMediaCategory(input.kind, input.mimeType);
      if (!category) throw new DomainError('UNSUPPORTED_MEDIA_TYPE', '输入 Artifact 媒体类型无效');
      const categoryInputBytes = (inputBytesByCategory.get(category) ?? 0) + input.sizeBytes;
      if (
        !Number.isSafeInteger(categoryInputBytes) ||
        categoryInputBytes > Math.min(descriptor.limits.maxInputBytes, mediaLimit)
      )
        throw new DomainError('INPUT_TOO_LARGE', '输入 Artifact 超出大小限制');
      inputBytesByCategory.set(category, categoryInputBytes);
      totalInputBytes += input.sizeBytes;
      if (
        !Number.isSafeInteger(totalInputBytes) ||
        totalInputBytes > descriptor.limits.maxInputBytes
      )
        throw new DomainError('INPUT_TOO_LARGE', '输入 Artifact 超出大小限制');
      values.push(input);
    }
    return values;
  }
  private async advanceOnce(
    id: string,
    options?: GenerationOperationOptions,
  ): Promise<GenerationJob> {
    let job = this.detail(id).job;
    if (terminal.has(job.state)) return job;
    const task = this.repository.getTask(job.generationTaskId);
    const descriptor = this.repository.getDescriptor(job.generationTaskId);
    if (!task || !descriptor)
      throw new DomainError('PERSISTENCE_INTEGRITY', '生成任务持久化事实缺失');
    try {
      throwIfAborted(options?.signal);
      const identity = this.identities.requireGenerationIdentity(job.teammateId);
      if (
        identity.runtimeProfileId !== job.runtimeProfileId ||
        identity.modelId !== descriptor.modelId
      )
        throw new DomainError('INVALID_INPUT', '固定模型身份不匹配');
      await this.identities.validateDestination(task);
      if (job.state === 'PENDING' || job.state === 'SUBMITTING') {
        const inputs = await this.inputs(task, descriptor, options);
        throwIfAborted(options?.signal);
        if (job.state === 'PENDING') job = this.move(job, 'SUBMITTING');
        this.options.crash?.('SUBMITTING', job);
        let submission: GenerationSubmission;
        try {
          submission = await this.gateway.submit(job.runtimeProfileId, {
            idempotencyKey: task.id,
            fingerprint: job.requestFingerprint,
            modelId: descriptor.modelId,
            capability: task.capability,
            requiredFeatures: task.requiredFeatures,
            prompt: task.prompt,
            parameters: task.parameters,
            inputs,
          });
          throwIfAborted(options?.signal);
          this.options.crash?.('SUBMISSION_SENT', job);
        } catch (error) {
          if (error instanceof GenerationCrash) throw error;
          if (options?.signal?.aborted)
            return this.move(job, 'UNKNOWN', { errorCode: 'SUBMISSION_STATE_UNKNOWN' });
          return this.move(
            job,
            error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT'
              ? 'FAILED'
              : 'UNKNOWN',
            { errorCode: safeCode(error) },
          );
        }
        if (submission.outcome === 'REJECTED')
          return this.move(job, 'FAILED', { errorCode: submission.errorCode });
        if (submission.outcome === 'UNKNOWN')
          return this.move(job, 'UNKNOWN', { errorCode: 'SUBMISSION_STATE_UNKNOWN' });
        job = this.move(job, submission.status === 'QUEUED' ? 'QUEUED' : 'RUNNING', {
          providerJobId: submission.providerJobId,
          providerStatus: submission.status,
        });
        this.options.crash?.('SUBMITTED', job);
      }
      if (job.state === 'SUBMITTING')
        return this.move(job, 'UNKNOWN', { errorCode: 'SUBMISSION_STATE_UNKNOWN' });
      if (!job.providerJobId)
        throw new DomainError('PERSISTENCE_INTEGRITY', 'Provider Job identity 缺失');
      const provider = await this.gateway.getJob(job.runtimeProfileId, job.providerJobId);
      throwIfAborted(options?.signal);
      if (provider.providerJobId !== job.providerJobId)
        throw new DomainError('PERSISTENCE_INTEGRITY', 'Provider 返回了其他 Job');
      job = this.repository.observeProviderStatus(job.id, job.state, provider.status);
      if (provider.status === 'UNKNOWN')
        return this.move(job, 'UNKNOWN', { errorCode: 'SUBMISSION_STATE_UNKNOWN' });
      if (provider.status === 'FAILED' || provider.status === 'CANCELLED')
        return this.move(job, provider.status, { errorCode: provider.errorCode });
      if (provider.status !== 'COMPLETED') {
        if (job.state === 'QUEUED' && provider.status === 'RUNNING')
          job = this.move(job, 'RUNNING', { providerStatus: provider.status });
        return job;
      }
      this.options.crash?.('PROVIDER_COMPLETED', job);
      if (
        !provider.outputs.length ||
        provider.outputs.length > descriptor.limits.maxOutputs ||
        new Set(provider.outputs.map((o) => o.id)).size !== provider.outputs.length
      )
        throw new DomainError('OUTPUT_MISSING', '生成输出缺失或重复');
      const registered: GenerationArtifact[] = [];
      for (const output of provider.outputs) {
        throwIfAborted(options?.signal);
        const mediaLimit = getGenerationMediaCeilingBytes(
          task.expectedOutput.artifactKind,
          output.mimeType,
          'output',
        );
        if (
          mediaLimit === null ||
          !task.expectedOutput.mimeTypes.includes(output.mimeType) ||
          !descriptor.outputTypes.includes(output.mimeType)
        )
          throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Provider 输出媒体类型无效');
        if (
          !Number.isSafeInteger(output.sizeBytes) ||
          output.sizeBytes < 1 ||
          output.sizeBytes > Math.min(descriptor.limits.maxOutputBytes, mediaLimit)
        )
          throw new DomainError('OUTPUT_TOO_LARGE', '生成输出超出大小限制');
        if (!isGenerationMetadataWithinLimit(output.metadata))
          throw new DomainError('OUTPUT_METADATA_TOO_LARGE', '生成输出元数据超出大小限制');
        let artifact = this.repository.listArtifacts(job.id).find((a) => a.outputId === output.id);
        if (artifact) {
          if (
            artifact.contentHash !== output.contentHash ||
            artifact.mimeType !== output.mimeType ||
            artifact.sizeBytes !== output.sizeBytes
          )
            throw new DomainError('ARTIFACT_INTEGRITY', 'Provider 输出身份发生变化');
          await this.artifacts.verify(artifact, task);
        } else {
          artifact = await this.artifacts.commit(
            job,
            task,
            descriptor,
            output,
            (downloadOptions) =>
              this.gateway.downloadOutput(job.runtimeProfileId, job.providerJobId!, output.id, {
                signal: downloadOptions?.signal ?? options?.signal,
              }),
            options,
          );
          try {
            artifact = this.repository.registerOutput(job.id, artifact);
          } catch (error) {
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR'].includes(String(error.code))
            ) {
              throw new GenerationCrash(
                'Artifact registration temporarily unavailable; committed output retained',
              );
            }
            throw error;
          }
          this.options.crash?.('REGISTERED', job);
        }
        registered.push(artifact);
      }
      // Existing registrations must match the exact current provider output set.
      if (this.repository.listArtifacts(job.id).length !== registered.length)
        throw new DomainError('ARTIFACT_INTEGRITY', '生成输出清单不一致');
      return this.repository.complete(
        job.id,
        job.state,
        registered.map((a) => a.id),
      );
    } catch (error) {
      if (error instanceof GenerationCrash) throw error;
      // G3 owns a durable approval continuation; preserve the existing Job, never re-submit it.
      if (
        task.executionAttemptId &&
        error instanceof DomainError &&
        error.code === 'APPROVAL_REQUIRED'
      )
        throw error;
      const current = this.repository.getJob(id)!;
      if (terminal.has(current.state)) return current;
      if (options?.signal?.aborted) {
        if (current.state === 'SUBMITTING')
          return this.move(current, 'UNKNOWN', { errorCode: 'SUBMISSION_STATE_UNKNOWN' });
        if (
          current.state === 'PENDING' ||
          current.state === 'QUEUED' ||
          current.state === 'RUNNING'
        )
          return this.move(current, 'CANCELLED', { errorCode: 'GENERATION_CANCELLED' });
      }
      return this.move(current, 'FAILED', { errorCode: safeCode(error) });
    }
  }
  private move(
    job: GenerationJob,
    state: GenerationJobState,
    patch: Parameters<GenerationRepository['transition']>[3] = {},
  ): GenerationJob {
    transitionGenerationJob(job.state, state);
    return this.repository.transition(job.id, job.state, state, patch);
  }
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
