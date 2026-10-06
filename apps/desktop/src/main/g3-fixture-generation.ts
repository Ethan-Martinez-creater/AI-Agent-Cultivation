import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { DomainError } from '@cultivation/shared';
import type {
  GenerationBinarySource,
  GenerationGateway,
  GenerationOperationOptions,
  ProviderGenerationRequest,
} from '@cultivation/application/g1-generation';
import type {
  GenerationModelDescriptor,
  GenerationOutputDescriptor,
  GenerationSubmission,
  ProviderGenerationJob,
} from '@cultivation/domain/g1-generation';

export type G3FixtureAdapterKind = 'image' | 'music';
export type G3FixtureScenario = 'NORMAL' | 'QUEUE_FULL' | 'UNKNOWN';

export interface G3FixtureAdapterEntry {
  runtimeProfileId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  semanticFingerprint: string;
  submission: GenerationSubmission;
  providerJobId: string | null;
  pollCount: number;
}

export interface G3FixtureAdapterLedger {
  submissions: number;
  queries: number;
  downloads: number;
  entries: Record<string, G3FixtureAdapterEntry>;
}

/** The store is owned by a test harness and can be backed by durable test state. */
export interface G3FixtureStateSnapshot {
  image: G3FixtureAdapterLedger;
  music: G3FixtureAdapterLedger;
}

export interface G3FixtureStatePort {
  read(): G3FixtureStateSnapshot | Promise<G3FixtureStateSnapshot>;
  write(snapshot: G3FixtureStateSnapshot): void | Promise<void>;
}

export interface G3FixtureProofEntry {
  runtimeProfileId: string;
  idempotencyKeyDigest: string;
  requestFingerprint: string;
  submissionOutcome: GenerationSubmission['outcome'];
  providerJobId: string | null;
  errorCode: string | null;
  definitiveQueueFullRejection: boolean;
}

export interface G3FixtureProofAdapter {
  submissions: number;
  queries: number;
  downloads: number;
  entries: G3FixtureProofEntry[];
}

export interface G3FixtureProofSnapshot {
  image: G3FixtureProofAdapter;
  music: G3FixtureProofAdapter;
}

export interface G3FixtureProofPort {
  read(): Promise<G3FixtureProofSnapshot>;
}

export interface G3FixtureGenerationOptions {
  /** Required runtime guard: this adapter is only available to explicit test harnesses. */
  testMode: boolean;
  h3Gateway: GenerationGateway;
  modelIdForRuntime(runtimeProfileId: string): string | Promise<string>;
  statePort: G3FixtureStatePort;
}

const imagePng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64',
  ),
);

function createSmallWav(): Uint8Array {
  const sampleCount = 8_000;
  const bytes = Buffer.alloc(44 + sampleCount, 128);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(8_000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(sampleCount, 40);
  return Uint8Array.from(bytes);
}

const musicWav = createSmallWav();
const ajv = new Ajv({ allErrors: false, schemaId: 'auto' });

function emptyLedger(): G3FixtureAdapterLedger {
  return { submissions: 0, queries: 0, downloads: 0, entries: {} };
}

function emptySnapshot(): G3FixtureStateSnapshot {
  return { image: emptyLedger(), music: emptyLedger() };
}

/** Restart-safe memory port for deterministic tests; production composition never imports it. */
export class MemoryG3FixtureStatePort implements G3FixtureStatePort {
  private snapshot = emptySnapshot();

  async read(): Promise<G3FixtureStateSnapshot> {
    return structuredClone(this.snapshot);
  }

  async write(snapshot: G3FixtureStateSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}

/** Test-only image/music GenerationGateway that leaves H3 HTTP runtimes on the real gateway. */
export class G3FixtureGenerationGateway implements GenerationGateway {
  readonly proofPort: G3FixtureProofPort;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: G3FixtureGenerationOptions) {
    if (options.testMode !== true)
      throw new DomainError('TEST_MODE_REQUIRED', 'G3 生成夹具仅可由显式测试模式构造');
    this.proofPort = {
      read: () => this.serial(async () => proofSnapshot(await this.options.statePort.read())),
    };
  }

  async getDescriptor(runtimeProfileId: string): Promise<GenerationModelDescriptor> {
    const modelId = await this.options.modelIdForRuntime(runtimeProfileId);
    const kind = adapterKind(modelId);
    return kind
      ? structuredClone(descriptorFor(kind, modelId))
      : this.options.h3Gateway.getDescriptor(runtimeProfileId);
  }

  async submit(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const modelId = await this.options.modelIdForRuntime(runtimeProfileId);
    const kind = adapterKind(modelId);
    if (!kind) return this.options.h3Gateway.submit(runtimeProfileId, request);
    if (request.modelId !== modelId)
      throw new DomainError('MODEL_NOT_FOUND', '固定生成模型与任务模型不匹配');

    const semanticFingerprint = await fingerprintRequest(request);
    validateRequest(kind, modelId, request);
    const requestFingerprint = digestIdentity(request.fingerprint);
    const scopedKey = ledgerKey(runtimeProfileId, request.idempotencyKey);
    return this.serial(async () => {
      const snapshot = await this.options.statePort.read();
      const ledger = snapshot[kind];
      const existing = ledger.entries[scopedKey];
      if (existing) {
        if (
          existing.requestFingerprint !== requestFingerprint ||
          existing.semanticFingerprint !== semanticFingerprint
        )
          throw new DomainError('IDEMPOTENCY_CONFLICT', '相同生成任务不能提交不同内容');
        return structuredClone(existing.submission);
      }

      const scenario = fixtureScenario(request.parameters.fixtureScenario);
      const providerJobId =
        scenario === 'NORMAL'
          ? providerJobIdFor(kind, runtimeProfileId, request.idempotencyKey, semanticFingerprint)
          : null;
      const submission: GenerationSubmission =
        scenario === 'QUEUE_FULL'
          ? { outcome: 'REJECTED', errorCode: 'QUEUE_FULL' }
          : scenario === 'UNKNOWN'
            ? { outcome: 'UNKNOWN' }
            : { outcome: 'SUBMITTED', providerJobId: providerJobId!, status: 'QUEUED' };
      ledger.entries[scopedKey] = {
        runtimeProfileId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
        semanticFingerprint,
        submission,
        providerJobId,
        pollCount: 0,
      };
      ledger.submissions++;
      await this.options.statePort.write(snapshot);
      return structuredClone(submission);
    });
  }

  async getJob(runtimeProfileId: string, providerJobId: string): Promise<ProviderGenerationJob> {
    const modelId = await this.options.modelIdForRuntime(runtimeProfileId);
    const kind = adapterKind(modelId);
    if (!kind) return this.options.h3Gateway.getJob(runtimeProfileId, providerJobId);
    return this.serial(async () => {
      const snapshot = await this.options.statePort.read();
      const ledger = snapshot[kind];
      const entry = Object.values(ledger.entries).find(
        (item) =>
          item.runtimeProfileId === runtimeProfileId && item.providerJobId === providerJobId,
      );
      if (!entry || entry.submission.outcome !== 'SUBMITTED')
        throw new DomainError('NOT_FOUND', '生成任务不存在');
      ledger.queries++;
      entry.pollCount++;
      const completed = entry.pollCount >= 2;
      await this.options.statePort.write(snapshot);
      return {
        providerJobId,
        status: completed ? 'COMPLETED' : 'RUNNING',
        outputs: completed ? [outputDescriptor(kind)] : [],
        errorCode: null,
      };
    });
  }

  async downloadOutput(
    runtimeProfileId: string,
    providerJobId: string,
    outputId: string,
    options?: GenerationOperationOptions,
  ): Promise<GenerationBinarySource> {
    const modelId = await this.options.modelIdForRuntime(runtimeProfileId);
    const kind = adapterKind(modelId);
    if (!kind)
      return this.options.h3Gateway.downloadOutput(
        runtimeProfileId,
        providerJobId,
        outputId,
        options,
      );
    const bytes = kind === 'image' ? imagePng : musicWav;
    await this.serial(async () => {
      const snapshot = await this.options.statePort.read();
      const ledger = snapshot[kind];
      const entry = Object.values(ledger.entries).find(
        (item) =>
          item.runtimeProfileId === runtimeProfileId && item.providerJobId === providerJobId,
      );
      if (
        !entry ||
        entry.submission.outcome !== 'SUBMITTED' ||
        entry.pollCount < 2 ||
        outputId !== outputDescriptor(kind).id
      )
        throw new DomainError('OUTPUT_MISSING', '生成输出不存在');
      ledger.downloads++;
      await this.options.statePort.write(snapshot);
    });
    return binarySource(bytes, options?.signal);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationTail.then(operation, operation);
    this.operationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

function adapterKind(modelId: string): G3FixtureAdapterKind | null {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('g3-image')) return 'image';
  if (normalized.includes('g3-music')) return 'music';
  return null;
}

function descriptorFor(kind: G3FixtureAdapterKind, modelId: string): GenerationModelDescriptor {
  if (kind === 'image') {
    return {
      modelId,
      outputCapability: 'IMAGE_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: ['TEXT_TO_IMAGE', 'REFERENCE_IMAGE'],
      inputRoles: [
        {
          role: 'REFERENCE_IMAGE',
          artifactKinds: ['IMAGE'],
          mimeTypes: ['image/png'],
          maxFiles: 2,
        },
      ],
      parameterSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          seed: { type: 'integer', minimum: 0, maximum: 2_147_483_647, default: 7 },
          style: { type: 'string', enum: ['NATURAL', 'ILLUSTRATION'], default: 'NATURAL' },
          fixtureScenario: { type: 'string', enum: ['NORMAL', 'QUEUE_FULL', 'UNKNOWN'] },
        },
        additionalProperties: false,
      },
      outputTypes: ['image/png'],
      limits: {
        maxInputFiles: 2,
        maxInputBytes: 4 * 1024 * 1024,
        maxOutputBytes: imagePng.byteLength,
        maxOutputs: 1,
      },
    };
  }
  return {
    modelId,
    outputCapability: 'MUSIC_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: ['TEXT_TO_MUSIC', 'LYRICS', 'REFERENCE_AUDIO'],
    inputRoles: [
      { role: 'REFERENCE_AUDIO', artifactKinds: ['AUDIO'], mimeTypes: ['audio/wav'], maxFiles: 2 },
    ],
    parameterSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        durationSeconds: { type: 'integer', minimum: 1, maximum: 30, default: 1 },
        tempo: { type: 'integer', minimum: 40, maximum: 200, default: 100 },
        seed: { type: 'integer', minimum: 0, maximum: 2_147_483_647, default: 11 },
        fixtureScenario: { type: 'string', enum: ['NORMAL', 'QUEUE_FULL', 'UNKNOWN'] },
      },
      additionalProperties: false,
    },
    outputTypes: ['audio/wav'],
    limits: {
      minDurationSeconds: 1,
      maxDurationSeconds: 30,
      maxInputFiles: 2,
      maxInputBytes: 4 * 1024 * 1024,
      maxOutputBytes: musicWav.byteLength,
      maxOutputs: 1,
    },
  };
}

function validateRequest(
  kind: G3FixtureAdapterKind,
  modelId: string,
  request: ProviderGenerationRequest,
): void {
  if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 256)
    throw new DomainError('INVALID_INPUT', '生成任务缺少稳定提交键');
  const descriptor = descriptorFor(kind, modelId);
  if (request.capability !== descriptor.outputCapability)
    throw new DomainError('UNSUPPORTED_CAPABILITY', '固定生成适配器不支持所需输出能力');
  if (request.requiredFeatures.some((feature) => !descriptor.featureTags.includes(feature)))
    throw new DomainError('UNSUPPORTED_FEATURE', '固定生成适配器不支持所需功能');
  if (request.inputs.length > descriptor.limits.maxInputFiles)
    throw new DomainError('INPUT_TOO_LARGE', '输入素材数量超过模型限制');
  let totalBytes = 0;
  const roleCounts = new Map<string, number>();
  for (const input of request.inputs) {
    const role = descriptor.inputRoles.find((candidate) => candidate.role === input.role);
    if (!role) throw new DomainError('UNSUPPORTED_INPUT_ROLE', '输入素材用途不受支持');
    if (!role.artifactKinds.includes(input.kind) || !role.mimeTypes.includes(input.mimeType))
      throw new DomainError('UNSUPPORTED_INPUT_ROLE', '输入素材类型与用途不匹配');
    const count = (roleCounts.get(input.role) ?? 0) + 1;
    roleCounts.set(input.role, count);
    if (count > role.maxFiles) throw new DomainError('INPUT_TOO_LARGE', '同类输入素材数量超过限制');
    totalBytes += input.sizeBytes;
  }
  if (totalBytes > descriptor.limits.maxInputBytes)
    throw new DomainError('INPUT_TOO_LARGE', '输入素材超过模型大小限制');
  if (!request.prompt.trim() || request.prompt.length > 12_000)
    throw new DomainError('INVALID_INPUT', '生成提示词无效');
  if (!ajv.validate(descriptor.parameterSchema, request.parameters))
    throw new DomainError('INVALID_INPUT', '生成参数不符合固定模型描述');
}

function fixtureScenario(value: unknown): G3FixtureScenario {
  if (value === undefined || value === 'NORMAL') return 'NORMAL';
  if (value === 'QUEUE_FULL' || value === 'UNKNOWN') return value;
  throw new DomainError('INVALID_INPUT', '生成夹具场景无效');
}

async function fingerprintRequest(request: ProviderGenerationRequest): Promise<string> {
  const inputs = [];
  for (const input of request.inputs) {
    const content = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of input.source.open()) {
      if (!(chunk instanceof Uint8Array))
        throw new DomainError('ARTIFACT_INTEGRITY', '输入素材流格式无效');
      content.update(chunk);
      sizeBytes += chunk.byteLength;
    }
    const contentHash = content.digest('hex');
    if (sizeBytes !== input.sizeBytes || contentHash !== input.contentHash.toLowerCase())
      throw new DomainError('ARTIFACT_INTEGRITY', '输入素材与可信内容摘要不一致');
    inputs.push({
      artifactId: input.artifactId,
      role: input.role,
      kind: input.kind,
      mimeType: input.mimeType,
      contentHash,
      sizeBytes,
    });
  }
  const semanticRequest = canonicalize({
    modelId: request.modelId,
    capability: request.capability,
    requiredFeatures: request.requiredFeatures,
    prompt: request.prompt,
    inputs,
    parameters: request.parameters,
  });
  return createHash('sha256').update(JSON.stringify(semanticRequest)).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function ledgerKey(runtimeProfileId: string, idempotencyKey: string): string {
  return JSON.stringify([runtimeProfileId, idempotencyKey]);
}

function providerJobIdFor(
  kind: G3FixtureAdapterKind,
  runtimeProfileId: string,
  idempotencyKey: string,
  semanticFingerprint: string,
): string {
  const stableIdentity = `${kind}\n${runtimeProfileId}\n${idempotencyKey}\n${semanticFingerprint}`;
  return `g3-fixture-${kind}-${createHash('sha256').update(stableIdentity).digest('hex').slice(0, 24)}`;
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function outputDescriptor(kind: G3FixtureAdapterKind): GenerationOutputDescriptor {
  const bytes = kind === 'image' ? imagePng : musicWav;
  return {
    id: `g3-${kind}-output-1`,
    mimeType: kind === 'image' ? 'image/png' : 'audio/wav',
    extension: kind === 'image' ? '.png' : '.wav',
    sizeBytes: bytes.byteLength,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    metadata:
      kind === 'image'
        ? { width: 1, height: 1 }
        : { durationSeconds: 1, sampleRate: 8_000, channels: 1, bitsPerSample: 8 },
  };
}

function binarySource(bytes: Uint8Array, operationSignal?: AbortSignal): GenerationBinarySource {
  const controller = new AbortController();
  const source: GenerationBinarySource = {
    open: (openSignal) =>
      (async function* () {
        const signals = [controller.signal, operationSignal, openSignal];
        for (let offset = 0; offset < bytes.byteLength; offset += 257) {
          if (signals.some((signal) => signal?.aborted))
            throw new DomainError('GENERATION_CANCELLED', '生成素材流已取消');
          yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 257));
        }
      })(),
    cancel: (reason) => controller.abort(reason),
  };
  return source;
}

function proofSnapshot(snapshot: G3FixtureStateSnapshot): G3FixtureProofSnapshot {
  const proofFor = (ledger: G3FixtureAdapterLedger): G3FixtureProofAdapter => ({
    submissions: ledger.submissions,
    queries: ledger.queries,
    downloads: ledger.downloads,
    entries: Object.values(ledger.entries).map((entry) => ({
      runtimeProfileId: entry.runtimeProfileId,
      idempotencyKeyDigest: digestIdentity(entry.idempotencyKey),
      requestFingerprint: entry.requestFingerprint,
      submissionOutcome: entry.submission.outcome,
      providerJobId: entry.providerJobId,
      errorCode: entry.submission.outcome === 'REJECTED' ? entry.submission.errorCode : null,
      definitiveQueueFullRejection:
        entry.submission.outcome === 'REJECTED' && entry.submission.errorCode === 'QUEUE_FULL',
    })),
  });
  return { image: proofFor(snapshot.image), music: proofFor(snapshot.music) };
}
