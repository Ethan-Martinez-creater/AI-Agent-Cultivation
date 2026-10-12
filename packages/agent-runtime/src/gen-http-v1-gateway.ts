import { createHash } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import { validateGenerationTask } from '@cultivation/application/g1-generation';
import type {
  GenerationBinarySource,
  GenerationGateway,
  GenerationOperationOptions,
  ProviderGenerationRequest,
} from '@cultivation/application/g1-generation';
import type {
  GenerationModelDescriptor,
  GenerationSubmission,
  GenerationSubmissionRejectionCode,
  ProviderGenerationJob,
} from '@cultivation/domain/g1-generation';
import type {
  GenerationProviderHttpOptions,
  GenerationProviderStatePort,
  GenerationRuntimeResolver,
} from './generation-provider-ports.js';

const JSON_LIMIT = 256 * 1024;
const CHUNK_LIMIT = 64 * 1024;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const capabilities = new Set([
  'IMAGE_GENERATION',
  'IMAGE_EDITING',
  'VIDEO_GENERATION',
  'MUSIC_GENERATION',
  'SPEECH_GENERATION',
]);
const mimeExtensions: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4'],
  'audio/wav': ['wav'],
  'audio/mpeg': ['mp3'],
};
const rejectionCodes = new Set<GenerationSubmissionRejectionCode>([
  'AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'INVALID_INPUT',
  'UNSUPPORTED_FEATURE',
  'UNSUPPORTED_INPUT_ROLE',
  'MODEL_DURATION_LIMIT',
  'QUEUE_FULL',
  'IDEMPOTENCY_CONFLICT',
]);
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成服务响应格式无效');
  return value as ObjectValue;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !safeId.test(value))
    throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成服务标识无效');
  return value;
}
function boundedStrings(value: unknown, limit: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some((v) => typeof v !== 'string' || v.length > 128) ||
    new Set(value).size !== value.length
  )
    throw new DomainError('INVALID_DESCRIPTOR', '生成模型描述无效');
  return value as string[];
}
/** A deliberately small parameter-schema dialect, with no remote refs or executable rules. */
function parameterSchema(value: unknown, depth = 0): ObjectValue {
  const schema = object(value);
  const keys = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'enum',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'items',
    'minItems',
    'maxItems',
    'default',
    'title',
    'description',
  ]);
  if (
    depth > 4 ||
    Object.keys(schema).some((k) => !keys.has(k)) ||
    !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(String(schema.type))
  )
    throw new DomainError('INVALID_DESCRIPTOR', '生成模型参数规范不受支持');
  if (schema.properties !== undefined) {
    const properties = object(schema.properties);
    if (
      Object.keys(properties).length > 32 ||
      Object.keys(properties).some((k) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k))
    )
      throw new DomainError('INVALID_DESCRIPTOR', '生成模型参数过多');
    for (const child of Object.values(properties)) parameterSchema(child, depth + 1);
  }
  if (schema.items !== undefined) parameterSchema(schema.items, depth + 1);
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.length > 64 ||
      schema.enum.some(
        (v) => !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 128,
      ))
  )
    throw new DomainError('INVALID_DESCRIPTOR', '生成参数枚举无效');
  if (schema.required !== undefined) boundedStrings(schema.required, 32);
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))
    )
      throw new DomainError('INVALID_DESCRIPTOR', '生成参数边界无效');
  }
  return schema;
}
export function parseGenHttpDescriptor(value: unknown): GenerationModelDescriptor {
  const data = object(value);
  if (
    !capabilities.has(String(data.outputCapability)) ||
    !['ASYNC_JOB', 'SYNC'].includes(String(data.executionMode))
  )
    throw new DomainError('INVALID_DESCRIPTOR', '生成模型能力无效');
  const limits = object(data.limits);
  for (const key of ['maxInputFiles', 'maxInputBytes', 'maxOutputBytes', 'maxOutputs'])
    if (!Number.isSafeInteger(limits[key]) || Number(limits[key]) < 0)
      throw new DomainError('INVALID_DESCRIPTOR', '生成模型限制无效');
  if (
    Number(limits.maxInputFiles) > 16 ||
    Number(limits.maxOutputs) < 1 ||
    Number(limits.maxOutputs) > 8 ||
    Number(limits.maxOutputBytes) < 1
  )
    throw new DomainError('INVALID_DESCRIPTOR', '生成模型限制超出软件安全范围');
  for (const key of ['minDurationSeconds', 'maxDurationSeconds'])
    if (
      limits[key] !== undefined &&
      (typeof limits[key] !== 'number' || !Number.isFinite(limits[key]) || Number(limits[key]) < 0)
    )
      throw new DomainError('INVALID_DESCRIPTOR', '生成模型时长限制无效');
  const outputTypes = boundedStrings(data.outputTypes, 8);
  const outputPrefix = String(data.outputCapability).startsWith('IMAGE_')
    ? 'image/'
    : data.outputCapability === 'VIDEO_GENERATION'
      ? 'video/'
      : 'audio/';
  if (
    !outputTypes.length ||
    outputTypes.some((m) => !mimeExtensions[m] || !m.startsWith(outputPrefix))
  )
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', '生成媒体格式不受支持');
  if (!Array.isArray(data.inputRoles) || data.inputRoles.length > 16)
    throw new DomainError('INVALID_DESCRIPTOR', '生成输入角色无效');
  const inputRoles = data.inputRoles.map((value) => {
    const role = object(value);
    if (
      !Number.isSafeInteger(role.maxFiles) ||
      Number(role.maxFiles) < 1 ||
      Number(role.maxFiles) > 16
    )
      throw new DomainError('INVALID_DESCRIPTOR', '生成输入数量无效');
    const artifactKinds = boundedStrings(role.artifactKinds, 3);
    const mimeTypes = boundedStrings(role.mimeTypes, 8);
    if (
      !artifactKinds.length ||
      !mimeTypes.length ||
      artifactKinds.some((k) => !['IMAGE', 'VIDEO', 'AUDIO'].includes(k)) ||
      mimeTypes.some(
        (m) =>
          !mimeExtensions[m] ||
          !artifactKinds.includes(
            m.startsWith('image/') ? 'IMAGE' : m.startsWith('video/') ? 'VIDEO' : 'AUDIO',
          ),
      )
    )
      throw new DomainError('INVALID_DESCRIPTOR', '生成输入格式无效');
    return { role: id(role.role), artifactKinds, mimeTypes, maxFiles: Number(role.maxFiles) };
  });
  if (new Set(inputRoles.map((r) => r.role)).size !== inputRoles.length)
    throw new DomainError('INVALID_DESCRIPTOR', '生成输入角色重复');
  return {
    modelId: id(data.modelId),
    outputCapability: data.outputCapability as GenerationModelDescriptor['outputCapability'],
    executionMode: data.executionMode as GenerationModelDescriptor['executionMode'],
    featureTags: boundedStrings(data.featureTags, 24),
    inputRoles,
    parameterSchema: parameterSchema(data.parameterSchema),
    outputTypes,
    limits: {
      maxInputFiles: Number(limits.maxInputFiles),
      maxInputBytes: Number(limits.maxInputBytes),
      maxOutputBytes: Number(limits.maxOutputBytes),
      maxOutputs: Number(limits.maxOutputs),
      ...(limits.minDurationSeconds === undefined
        ? {}
        : { minDurationSeconds: Number(limits.minDurationSeconds) }),
      ...(limits.maxDurationSeconds === undefined
        ? {}
        : { maxDurationSeconds: Number(limits.maxDurationSeconds) }),
    },
  };
}

/** GEN_HTTP_V1 uses fixed protocol paths. Servers cannot supply local paths or a REST program. */
export class GenHttpV1Gateway implements GenerationGateway {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly pending = new Map<string, Promise<GenerationSubmission>>();
  constructor(
    private readonly resolve: GenerationRuntimeResolver,
    private readonly states: GenerationProviderStatePort,
    private readonly options: GenerationProviderHttpOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async runtime(runtimeId: string) {
    const runtime = await this.resolve(runtimeId);
    if (!runtime) throw new DomainError('MODEL_NOT_FOUND', '生成执行身份不存在');
    const base = new URL(runtime.baseUrl);
    if (
      !['https:', 'http:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new DomainError('INVALID_INPUT', '生成服务地址无效');
    // User-selected self-hosted origins may be local. Output locations are always fixed, same-origin.
    base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/';
    return { ...runtime, base };
  }
  private async request(runtimeId: string, path: string, init: RequestInit = {}) {
    const runtime = await this.runtime(runtimeId);
    const headers = new Headers(init.headers);
    if (runtime.apiKey) headers.set('authorization', `Bearer ${runtime.apiKey}`);
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 20_000)])
      : AbortSignal.timeout(this.options.requestTimeoutMs ?? 20_000);
    return this.fetcher(new URL(path, runtime.base), {
      ...init,
      headers,
      redirect: 'error',
      signal,
    });
  }
  private async json(response: Response): Promise<ObjectValue> {
    if (!response.body) throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成服务响应为空');
    const reader = response.body.getReader();
    const pieces: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > JSON_LIMIT)
          throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成服务响应过大');
        pieces.push(part.value);
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const part of pieces) {
        buffer.set(part, offset);
        offset += part.byteLength;
      }
      return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async getDescriptor(runtimeId: string): Promise<GenerationModelDescriptor> {
    const health = await this.request(runtimeId, 'health');
    if (!health.ok || (await this.json(health)).status !== 'ok')
      throw new DomainError('MODEL_UNAVAILABLE', '生成服务暂不可用');
    const response = await this.request(runtimeId, 'v1/models');
    if (!response.ok)
      throw new DomainError(
        response.status === 401 ? 'AUTH_FAILED' : 'MODEL_UNAVAILABLE',
        '无法读取生成模型',
      );
    const data = await this.json(response);
    if (data.protocol !== 'GEN_HTTP_V1' || !Array.isArray(data.models) || data.models.length > 128)
      throw new DomainError('INVALID_DESCRIPTOR', '生成服务协议不兼容');
    const runtime = await this.runtime(runtimeId);
    const candidates = data.models.filter((v) => object(v).modelId === runtime.modelId);
    if (candidates.length !== 1) throw new DomainError('MODEL_NOT_FOUND', '生成模型不存在');
    return parseGenHttpDescriptor(candidates[0]);
  }
  async submit(
    runtimeId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const lockKey = JSON.stringify([runtimeId, request.idempotencyKey]);
    const existing = this.pending.get(lockKey);
    if (existing) {
      await existing;
      return this.submitOnce(runtimeId, request);
    }
    const operation = this.submitOnce(runtimeId, request).finally(() =>
      this.pending.delete(lockKey),
    );
    this.pending.set(lockKey, operation);
    return operation;
  }
  private async submitOnce(
    runtimeId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const semantic = createHash('sha256')
      .update(
        JSON.stringify({
          ...request,
          inputs: request.inputs.map((i) => ({
            artifactId: i.artifactId,
            role: i.role,
            kind: i.kind,
            mimeType: i.mimeType,
            sizeBytes: i.sizeBytes,
            contentHash: i.contentHash,
          })),
        }),
      )
      .digest('hex');
    let fact = await this.states.get(runtimeId, request.idempotencyKey);
    if (
      fact &&
      (fact.requestFingerprint !== request.fingerprint || fact.semanticFingerprint !== semantic)
    )
      return { outcome: 'REJECTED', errorCode: 'IDEMPOTENCY_CONFLICT' };
    if (fact?.phase === 'SUBMITTED')
      return { outcome: 'SUBMITTED', providerJobId: id(fact.providerJobId), status: 'QUEUED' };
    if (fact?.phase === 'REJECTED')
      return { outcome: 'REJECTED', errorCode: fact.errorCode ?? 'INVALID_INPUT' };
    if (fact?.phase === 'UNKNOWN') return { outcome: 'UNKNOWN' };
    if (fact?.phase === 'SUBMITTING') {
      await this.states.put({ ...fact, phase: 'UNKNOWN' });
      return { outcome: 'UNKNOWN' };
    }
    const descriptor = await this.getDescriptor(runtimeId);
    const runtime = await this.runtime(runtimeId);
    if (request.modelId !== runtime.modelId)
      throw new DomainError('MODEL_NOT_FOUND', '生成模型身份不匹配');
    validateGenerationTask(
      {
        id: request.idempotencyKey,
        targetTeammateId: 'trusted-main',
        capability: request.capability,
        requiredFeatures: request.requiredFeatures,
        prompt: request.prompt,
        inputs: request.inputs.map((i) => ({ artifactId: i.artifactId, role: i.role })),
        parameters: request.parameters,
        expectedOutput: {
          artifactKind: request.capability.startsWith('IMAGE_')
            ? 'IMAGE'
            : request.capability === 'VIDEO_GENERATION'
              ? 'VIDEO'
              : 'AUDIO',
          mimeTypes: descriptor.outputTypes,
        },
        outputDestination: { scope: 'APP_ARTIFACT_STORE' },
        requester: { actorType: 'USER', actorId: null },
        missionId: null,
        runId: null,
        workflowRunId: null,
        workflowStepRunId: null,
        createdAt: '',
      },
      descriptor,
    );
    fact ??= {
      runtimeId,
      key: request.idempotencyKey,
      requestFingerprint: request.fingerprint,
      semanticFingerprint: semantic,
      uploadedFiles: [],
      exactBody: '',
      phase: 'PREPARED',
      providerJobId: null,
    };
    await this.states.put(fact);
    for (const input of request.inputs) {
      if (
        fact.uploadedFiles.some((f) => f.artifactId === input.artifactId && f.role === input.role)
      )
        continue;
      const role = descriptor.inputRoles.find((r) => r.role === input.role);
      if (
        !role?.artifactKinds.includes(input.kind) ||
        !role.mimeTypes.includes(input.mimeType) ||
        input.sizeBytes > descriptor.limits.maxInputBytes ||
        !hashPattern.test(input.contentHash)
      )
        throw new DomainError('INVALID_INPUT', '生成输入事实不匹配');
      const iterator = input.source.open()[Symbol.asyncIterator]();
      let count = 0;
      const digest = createHash('sha256');
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await iterator.next();
            if (part.done) {
              if (count !== input.sizeBytes || digest.digest('hex') !== input.contentHash)
                throw new DomainError('INVALID_INPUT', '生成输入已变化');
              controller.close();
              return;
            }
            count += part.value.byteLength;
            if (count > input.sizeBytes || part.value.byteLength > 1024 * 1024)
              throw new DomainError('INPUT_TOO_LARGE', '生成输入超过边界');
            digest.update(part.value);
            controller.enqueue(part.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return?.();
          await input.source.cancel();
        },
      });
      const response = await this.request(runtimeId, 'v1/files', {
        method: 'POST',
        body: stream,
        duplex: 'half',
        headers: {
          'content-type': input.mimeType,
          'x-content-sha256': input.contentHash,
          'x-artifact-id': input.artifactId,
          'x-input-role': input.role,
          'x-content-size': String(input.sizeBytes),
          'idempotency-key': `${request.idempotencyKey}:${input.artifactId}:${input.role}`,
        },
      } as RequestInit);
      if (!response.ok) throw new DomainError('INVALID_INPUT', '生成输入上传失败');
      const result = await this.json(response);
      if (
        count !== input.sizeBytes ||
        result.contentHash !== input.contentHash ||
        result.sizeBytes !== input.sizeBytes ||
        result.mimeType !== input.mimeType
      )
        throw new DomainError('INVALID_INPUT', '生成上传身份校验失败');
      fact = {
        ...fact,
        uploadedFiles: [
          ...fact.uploadedFiles,
          {
            artifactId: input.artifactId,
            role: input.role,
            fileId: id(result.fileId),
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            contentHash: input.contentHash,
          },
        ],
      };
      await this.states.put(fact);
    }
    fact = {
      ...fact,
      exactBody: JSON.stringify({
        model: request.modelId,
        capability: request.capability,
        requiredFeatures: request.requiredFeatures,
        prompt: request.prompt,
        inputs: fact.uploadedFiles.map((f) => ({
          fileId: f.fileId,
          artifactId: f.artifactId,
          role: f.role,
          contentHash: f.contentHash,
        })),
        parameters: request.parameters,
      }),
      phase: 'SUBMITTING',
    };
    await this.states.put(fact);
    try {
      const response = await this.request(runtimeId, 'v1/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': request.idempotencyKey },
        body: fact.exactBody,
      });
      const data = await this.json(response);
      if (!response.ok) {
        const error = data.error ? object(data.error) : {};
        if (
          error.accepted === false &&
          rejectionCodes.has(error.code as GenerationSubmissionRejectionCode)
        ) {
          const code = error.code as GenerationSubmissionRejectionCode;
          await this.states.put({ ...fact, phase: 'REJECTED', errorCode: code });
          return { outcome: 'REJECTED', errorCode: code };
        }
        throw new Error('Unconfirmed submission');
      }
      if (!['QUEUED', 'RUNNING'].includes(String(data.status)))
        throw new Error('Invalid submission');
      const providerJobId = id(data.providerJobId);
      await this.states.put({ ...fact, phase: 'SUBMITTED', providerJobId });
      return { outcome: 'SUBMITTED', providerJobId, status: data.status as 'QUEUED' | 'RUNNING' };
    } catch {
      await this.states.put({ ...fact, phase: 'UNKNOWN' });
      return { outcome: 'UNKNOWN' };
    }
  }
  async getJob(runtimeId: string, providerJobId: string): Promise<ProviderGenerationJob> {
    id(providerJobId);
    const response = await this.request(
      runtimeId,
      `v1/generations/${encodeURIComponent(providerJobId)}`,
    );
    if (!response.ok) throw new DomainError('MODEL_UNAVAILABLE', '无法查询原生成任务');
    const data = await this.json(response);
    if (
      data.providerJobId !== providerJobId ||
      !['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(
        String(data.status),
      )
    )
      throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成任务状态不匹配');
    const descriptor = await this.getDescriptor(runtimeId);
    if (
      !Array.isArray(data.outputs) ||
      data.outputs.length > descriptor.limits.maxOutputs ||
      (data.status === 'COMPLETED' && !data.outputs.length)
    )
      throw new DomainError('OUTPUT_MISSING', '生成输出清单无效');
    const outputs = data.outputs.map((value) => {
      const output = object(value);
      if (
        !descriptor.outputTypes.includes(String(output.mimeType)) ||
        !mimeExtensions[String(output.mimeType)]?.includes(
          String(output.extension).replace(/^\./, ''),
        ) ||
        !Number.isSafeInteger(output.sizeBytes) ||
        Number(output.sizeBytes) < 1 ||
        Number(output.sizeBytes) > descriptor.limits.maxOutputBytes ||
        typeof output.contentHash !== 'string' ||
        !hashPattern.test(output.contentHash)
      )
        throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成输出元数据无效');
      const metadata = object(output.metadata);
      if (
        Object.keys(metadata).length > 32 ||
        Object.entries(metadata).some(
          ([k, v]) =>
            k.length > 64 ||
            (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) ||
            String(v).length > 256 ||
            (typeof v === 'number' && !Number.isFinite(v)),
        )
      )
        throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成输出元数据超过边界');
      return {
        id: id(output.id),
        mimeType: String(output.mimeType),
        extension: '.' + String(output.extension).replace(/^\./, ''),
        sizeBytes: Number(output.sizeBytes),
        contentHash: output.contentHash,
        metadata: Object.fromEntries(
          Object.entries(metadata).filter(([key]) => key !== 'durationToleranceSeconds'),
        ) as Record<string, number | string | boolean | null>,
      };
    });
    if (new Set(outputs.map((o) => o.id)).size !== outputs.length)
      throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成输出标识重复');
    return {
      providerJobId,
      status: data.status as ProviderGenerationJob['status'],
      outputs,
      errorCode:
        typeof data.errorCode === 'string' && safeId.test(data.errorCode) ? data.errorCode : null,
    };
  }
  async downloadOutput(
    runtimeId: string,
    providerJobId: string,
    outputId: string,
    options?: GenerationOperationOptions,
  ): Promise<GenerationBinarySource> {
    id(providerJobId);
    id(outputId);
    const job = await this.getJob(runtimeId, providerJobId);
    const output = job.outputs.find((o) => o.id === outputId);
    if (job.status !== 'COMPLETED' || !output)
      throw new DomainError('OUTPUT_MISSING', '生成输出尚不可读取');
    const controller = new AbortController();
    const request = this.request.bind(this);
    let opened = false;
    return {
      cancel: () => controller.abort(),
      async *open(signal) {
        if (opened) throw new DomainError('INVALID_INPUT', '媒体读取源已使用');
        opened = true;
        const response = await request(
          runtimeId,
          `v1/generations/${encodeURIComponent(providerJobId)}/outputs/${encodeURIComponent(outputId)}/download`,
          {
            signal: AbortSignal.any([
              controller.signal,
              ...(signal ? [signal] : []),
              ...(options?.signal ? [options.signal] : []),
            ]),
          },
        );
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
        const length = response.headers.get('content-length');
        if (
          !response.ok ||
          mime !== output.mimeType ||
          (length !== null && Number(length) !== output.sizeBytes) ||
          !response.body
        ) {
          await response.body?.cancel();
          throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成媒体响应不匹配');
        }
        const reader = response.body.getReader();
        let bytes = 0;
        const digest = createHash('sha256');
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > output.sizeBytes)
              throw new DomainError('OUTPUT_TOO_LARGE', '生成媒体超过声明边界');
            digest.update(part.value);
            for (let offset = 0; offset < part.value.byteLength; offset += CHUNK_LIMIT)
              yield part.value.subarray(offset, offset + CHUNK_LIMIT);
          }
          if (bytes !== output.sizeBytes || digest.digest('hex') !== output.contentHash)
            throw new DomainError('INVALID_PROVIDER_RESPONSE', '生成媒体完整性校验失败');
        } finally {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
    };
  }
}
