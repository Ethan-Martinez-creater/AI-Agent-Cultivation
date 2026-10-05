import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DomainError } from '@cultivation/shared';
import type {
  GenerationGateway,
  ProviderGenerationRequest,
  GenerationBinarySource,
} from '@cultivation/application/g1-generation';
import type {
  GenerationModelDescriptor,
  GenerationSubmission,
  ProviderGenerationJob,
} from '@cultivation/domain/g1-generation';

/** Retains the original test adapter fingerprint without accumulating input bytes. */
async function fingerprintRequest(request: ProviderGenerationRequest): Promise<string> {
  const hash = createHash('sha256');
  hash.update('{');
  let firstField = true;
  for (const key of Object.keys(request) as (keyof ProviderGenerationRequest)[]) {
    if (key === 'fingerprint') continue;
    if (!firstField) hash.update(',');
    firstField = false;
    hash.update(JSON.stringify(key) + ':');
    if (key !== 'inputs') {
      hash.update(JSON.stringify(request[key]));
      continue;
    }
    hash.update('[');
    let firstInput = true;
    for (const input of request.inputs) {
      if (!firstInput) hash.update(',');
      firstInput = false;
      const identity = JSON.stringify({
        artifactId: input.artifactId,
        role: input.role,
        kind: input.kind,
        mimeType: input.mimeType,
        contentHash: input.contentHash,
      });
      hash.update(identity.slice(0, -1) + ',"bytes":[');
      const content = createHash('sha256');
      let size = 0;
      let firstByte = true;
      for await (const chunk of input.source.open()) {
        content.update(chunk);
        size += chunk.byteLength;
        if (chunk.byteLength) {
          if (!firstByte) hash.update(',');
          firstByte = false;
          hash.update(Array.from(chunk).join(','));
        }
      }
      if (size !== input.sizeBytes || content.digest('hex') !== input.contentHash)
        throw new DomainError('ARTIFACT_INTEGRITY', '上传 Artifact 与可信身份不一致');
      hash.update(']}');
    }
    hash.update(']');
  }
  return hash.update('}').digest('hex');
}

/** Test-only adapter fixture. Its mapping survives Electron restart and never contains credentials. */
export class FakeGenerationGateway implements GenerationGateway {
  private facts: {
    entries: Record<
      string,
      { fingerprint: string; suppliedFingerprint: string; job: ProviderGenerationJob }
    >;
    submissions: number;
    downloads: number;
    queries: number;
  };
  readonly bytes = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  constructor(
    private readonly factPath: string,
    private readonly modelId: (runtimeId: string) => string,
  ) {
    mkdirSync(dirname(factPath), { recursive: true });
    this.facts = existsSync(factPath)
      ? (JSON.parse(readFileSync(factPath, 'utf8')) as typeof this.facts)
      : { entries: {}, submissions: 0, downloads: 0, queries: 0 };
    if (!existsSync(factPath)) this.save();
  }
  async getDescriptor(runtimeProfileId: string): Promise<GenerationModelDescriptor> {
    return {
      modelId: this.modelId(runtimeProfileId),
      outputCapability: 'IMAGE_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: ['TEXT_TO_IMAGE', 'REFERENCE_IMAGE'],
      inputRoles: [
        { role: 'REFERENCE', artifactKinds: ['IMAGE'], mimeTypes: ['image/png'], maxFiles: 2 },
      ],
      parameterSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scenario: {
            type: 'string',
            enum: [
              'NORMAL',
              'UNKNOWN',
              'INVALID_MIME',
              'INVALID_HASH',
              'MISSING',
              'FAILED',
              'QUEUED',
            ],
          },
        },
      },
      outputTypes: ['image/png'],
      limits: {
        maxInputFiles: 2,
        maxInputBytes: 32 * 1024 * 1024,
        maxOutputBytes: 32 * 1024 * 1024,
        maxOutputs: 1,
      },
    };
  }
  async submit(
    runtimeId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const fingerprint = await fingerprintRequest(request);
    const old = this.facts.entries[request.idempotencyKey];
    if (old) {
      if (old.fingerprint !== fingerprint || old.suppliedFingerprint !== request.fingerprint)
        throw new DomainError('IDEMPOTENCY_CONFLICT', '相同任务不能提交不同请求');
      return {
        providerJobId: old.job.status === 'UNKNOWN' ? null : old.job.providerJobId,
        status: old.job.status === 'UNKNOWN' ? 'UNKNOWN' : 'QUEUED',
      };
    }
    const descriptor = await this.getDescriptor(runtimeId);
    if (
      request.modelId !== descriptor.modelId ||
      request.requiredFeatures.some((f) => !descriptor.featureTags.includes(f)) ||
      request.inputs.some((i) => !descriptor.inputRoles.some((r) => r.role === i.role))
    )
      throw new DomainError('UNSUPPORTED_FEATURE', '生成描述不匹配');
    const scenario = request.parameters.scenario;
    const providerJobId = `generation-${randomUUID()}`;
    const output = {
      id: 'image-1',
      mimeType: scenario === 'INVALID_MIME' ? 'application/x-executable' : 'image/png',
      extension: '.png',
      sizeBytes: this.bytes.length,
      contentHash:
        scenario === 'INVALID_HASH'
          ? '0'.repeat(64)
          : createHash('sha256').update(this.bytes).digest('hex'),
      metadata: { width: 1, height: 1 },
    };
    const job: ProviderGenerationJob = {
      providerJobId,
      status:
        scenario === 'UNKNOWN'
          ? 'UNKNOWN'
          : scenario === 'FAILED'
            ? 'FAILED'
            : scenario === 'QUEUED'
              ? 'QUEUED'
              : 'COMPLETED',
      outputs: scenario === 'MISSING' ? [] : [output],
      errorCode: scenario === 'FAILED' ? 'GENERATION_FAILED' : null,
    };
    this.facts.entries[request.idempotencyKey] = {
      fingerprint,
      suppliedFingerprint: request.fingerprint,
      job,
    };
    this.facts.submissions++;
    this.save();
    return {
      providerJobId: scenario === 'UNKNOWN' ? null : providerJobId,
      status: scenario === 'UNKNOWN' ? 'UNKNOWN' : 'QUEUED',
    };
  }
  async getJob(_runtimeId: string, providerJobId: string): Promise<ProviderGenerationJob> {
    const entry = Object.values(this.facts.entries).find(
      (e) => e.job.providerJobId === providerJobId,
    );
    if (!entry) throw new DomainError('NOT_FOUND', '生成任务不存在');
    this.facts.queries++;
    this.save();
    return structuredClone(entry.job);
  }
  async downloadOutput(
    _runtimeId: string,
    providerJobId: string,
    outputId: string,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationBinarySource> {
    const entry = Object.values(this.facts.entries).find(
      (e) => e.job.providerJobId === providerJobId,
    );
    if (!entry || !entry.job.outputs.some((o) => o.id === outputId))
      throw new DomainError('OUTPUT_MISSING', '输出不存在');
    this.facts.downloads++;
    this.save();
    const bytes = this.bytes;
    const controller = new AbortController();
    return {
      open: (signal?: AbortSignal) =>
        (async function* () {
          const active = AbortSignal.any([
            controller.signal,
            ...(options?.signal ? [options.signal] : []),
            ...(signal ? [signal] : []),
          ]);
          for (let offset = 0; offset < bytes.byteLength; offset += 8) {
            if (active.aborted) throw new DomainError('GENERATION_CANCELLED', '下载已取消');
            yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 8));
          }
        })(),
      cancel: () => {
        controller.abort();
      },
    };
  }
  counters() {
    return {
      submissions: this.facts.submissions,
      downloads: this.facts.downloads,
      queries: this.facts.queries,
    };
  }
  private save() {
    const staging = `${this.factPath}.tmp`;
    writeFileSync(staging, JSON.stringify(this.facts), { encoding: 'utf8' });
    renameSync(staging, this.factPath);
  }
}
export class UnconfiguredGenerationGateway implements GenerationGateway {
  async getDescriptor(): Promise<GenerationModelDescriptor> {
    throw new DomainError('GENERATION_ADAPTER_UNAVAILABLE', '尚未配置生成模型适配器');
  }
  async submit(): Promise<GenerationSubmission> {
    throw new DomainError('GENERATION_ADAPTER_UNAVAILABLE', '尚未配置生成模型适配器');
  }
  async getJob(): Promise<ProviderGenerationJob> {
    throw new DomainError('GENERATION_ADAPTER_UNAVAILABLE', '尚未配置生成模型适配器');
  }
  async downloadOutput(): Promise<GenerationBinarySource> {
    throw new DomainError('GENERATION_ADAPTER_UNAVAILABLE', '尚未配置生成模型适配器');
  }
}
