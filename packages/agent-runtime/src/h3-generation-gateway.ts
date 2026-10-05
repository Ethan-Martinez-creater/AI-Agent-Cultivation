import { createHash } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import { GenerationCrash } from '@cultivation/application/g1-generation';
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
  GenerationSubmissionRejectionCode,
  ProviderGenerationJob,
} from '@cultivation/domain/g1-generation';

export interface H3ResolvedRuntime {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}
export type H3ResolveRuntime = (runtimeProfileId: string) => Promise<H3ResolvedRuntime | null>;
export type H3SubmissionPhase = 'PREPARED' | 'SUBMITTING' | 'SUBMITTED' | 'REJECTED' | 'UNKNOWN';
export interface H3UploadedFileIdentity {
  artifactId: string;
  role: string;
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
}
export interface H3AdapterSubmissionState {
  runtimeId: string;
  key: string;
  requestFingerprint: string;
  semanticFingerprint: string;
  uploadedFiles: H3UploadedFileIdentity[];
  exactBody: string;
  phase: H3SubmissionPhase;
  providerJobId: string | null;
  errorCode?: GenerationSubmissionRejectionCode | null;
}
export interface H3AdapterStateStore {
  get(runtimeId: string, key: string): Promise<H3AdapterSubmissionState | null>;
  put(state: H3AdapterSubmissionState): Promise<void>;
}
export interface H3CachedOutput {
  sizeBytes: number;
  contentHash: string;
  source: GenerationBinarySource;
}
export interface H3OutputCache {
  lookup(
    runtimeProfileId: string,
    providerJobId: string,
    outputId: string,
  ): Promise<H3CachedOutput | null>;
  capture(input: {
    runtimeProfileId: string;
    providerJobId: string;
    outputId: string;
    mimeType: string;
    advertisedSize: number | null;
    source: GenerationBinarySource;
    signal?: AbortSignal;
  }): Promise<H3CachedOutput>;
}
export interface H3GenerationGatewayOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
}
export type H3ProviderErrorCode =
  | 'AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_FEATURE'
  | 'UNSUPPORTED_INPUT_ROLE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INPUT_TOO_LARGE'
  | 'MODEL_DURATION_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUEUE_FULL'
  | 'GENERATION_FAILED'
  | 'GENERATION_TIMEOUT'
  | 'SUBMISSION_STATE_UNKNOWN'
  | 'OUTPUT_MISSING'
  | 'INTERNAL_ERROR';

const MiB = 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_STREAM_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_INPUT_FILES = 4;
const DEFAULT_MAX_INPUT_BYTES = 128 * MiB;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * MiB;
const DEFAULT_MAX_OUTPUTS = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const KNOWN_FEATURES = new Set([
  'TEXT_TO_VIDEO',
  'FIRST_FRAME_CONDITIONING',
  'REFERENCE_CONDITIONING',
  'VIDEO_TO_AUDIO',
  'NATIVE_AUDIO',
]);
const KNOWN_ROLES = new Set([
  'FIRST_FRAME',
  'LAST_FRAME',
  'REFERENCE_IMAGE',
  'REFERENCE_VIDEO',
  'REFERENCE_AUDIO',
  'SOURCE_VIDEO',
]);
const ROLE_FEATURE: Record<string, string> = {
  FIRST_FRAME: 'FIRST_FRAME_CONDITIONING',
  LAST_FRAME: 'FIRST_FRAME_CONDITIONING',
  REFERENCE_IMAGE: 'REFERENCE_CONDITIONING',
  REFERENCE_VIDEO: 'REFERENCE_CONDITIONING',
  REFERENCE_AUDIO: 'REFERENCE_CONDITIONING',
  SOURCE_VIDEO: 'VIDEO_TO_AUDIO',
};
const ROLE_MIME_TYPES: Record<string, string[]> = {
  FIRST_FRAME: ['image/png'],
  LAST_FRAME: ['image/png'],
  REFERENCE_IMAGE: ['image/png'],
  REFERENCE_VIDEO: ['video/mp4'],
  REFERENCE_AUDIO: ['audio/wav'],
  SOURCE_VIDEO: ['video/mp4'],
};
const KNOWN_ERRORS = new Set<H3ProviderErrorCode>([
  'AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'MODEL_UNAVAILABLE',
  'INVALID_INPUT',
  'UNSUPPORTED_FEATURE',
  'UNSUPPORTED_INPUT_ROLE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INPUT_TOO_LARGE',
  'MODEL_DURATION_LIMIT',
  'IDEMPOTENCY_CONFLICT',
  'QUEUE_FULL',
  'GENERATION_FAILED',
  'GENERATION_TIMEOUT',
  'SUBMISSION_STATE_UNKNOWN',
  'OUTPUT_MISSING',
  'INTERNAL_ERROR',
]);
const DEFINITIVE_REJECTION_CODES = new Set<GenerationSubmissionRejectionCode>([
  'AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'INVALID_INPUT',
  'UNSUPPORTED_FEATURE',
  'UNSUPPORTED_INPUT_ROLE',
  'MODEL_DURATION_LIMIT',
  'QUEUE_FULL',
  'IDEMPOTENCY_CONFLICT',
]);
const SAFE_MESSAGES: Record<H3ProviderErrorCode, string> = {
  AUTH_FAILED: 'H3 runtime authentication failed.',
  MODEL_NOT_FOUND: 'The configured H3 model was not found.',
  MODEL_UNAVAILABLE: 'The H3 model service is unavailable.',
  INVALID_INPUT: 'The generation request is invalid.',
  UNSUPPORTED_FEATURE: 'The H3 runtime does not support a required feature.',
  UNSUPPORTED_INPUT_ROLE: 'The H3 runtime does not support an input role.',
  UNSUPPORTED_MEDIA_TYPE: 'The H3 runtime does not support this media type.',
  INPUT_TOO_LARGE: 'Generation input exceeds the H3 client limit.',
  MODEL_DURATION_LIMIT: 'Requested duration exceeds the H3 model limit.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was used for a different request.',
  QUEUE_FULL: 'The H3 generation queue is full.',
  GENERATION_FAILED: 'H3 generation failed.',
  GENERATION_TIMEOUT: 'H3 generation timed out.',
  SUBMISSION_STATE_UNKNOWN: 'H3 submission state is unknown and will not be retried.',
  OUTPUT_MISSING: 'The H3 generation output is unavailable.',
  INTERNAL_ERROR: 'The H3 adapter received an invalid response.',
};

function fail(code: H3ProviderErrorCode): never {
  throw new DomainError(code, SAFE_MESSAGES[code]);
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function boundedString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function errorCodeFromPayload(value: unknown): H3ProviderErrorCode | null {
  const root = asRecord(value);
  const error = asRecord(root?.error);
  const code = error?.code;
  return typeof code === 'string' && KNOWN_ERRORS.has(code as H3ProviderErrorCode)
    ? (code as H3ProviderErrorCode)
    : null;
}
/**
 * Generation Software Spec v0.2 §15–16 lacks an acceptance marker. The optional adapter contract
 * extension requires `accepted:false`; codes or retryable values alone are never enough to
 * distinguish a rejection from a lost/ambiguous accepted submission.
 */
function definitiveSubmissionRejection(value: unknown): GenerationSubmissionRejectionCode | null {
  const root = asRecord(value);
  if (!root || Object.keys(root).length !== 1 || !Object.hasOwn(root, 'error')) return null;
  const error = asRecord(root.error);
  if (!error) return null;
  const expectedFields = ['accepted', 'code', 'message', 'retryable'];
  if (
    Object.keys(error).length !== expectedFields.length ||
    expectedFields.some((field) => !Object.hasOwn(error, field)) ||
    error.accepted !== false ||
    typeof error.retryable !== 'boolean' ||
    !boundedString(error.message, 512) ||
    typeof error.code !== 'string' ||
    !DEFINITIVE_REJECTION_CODES.has(error.code as GenerationSubmissionRejectionCode)
  )
    return null;
  return error.code as GenerationSubmissionRejectionCode;
}
function statusErrorCode(status: number, fallback: H3ProviderErrorCode): H3ProviderErrorCode {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 429) return 'QUEUE_FULL';
  if (status === 408 || status === 504) return 'GENERATION_TIMEOUT';
  if (status >= 500) return fallback === 'INTERNAL_ERROR' ? 'MODEL_UNAVAILABLE' : fallback;
  if (status >= 400) return 'INVALID_INPUT';
  return fallback;
}
function stableJson(value: unknown, depth = 0): string {
  if (depth > 32) fail('INVALID_INPUT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_INPUT');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) fail('INVALID_INPUT');
    return '[' + value.map((item) => stableJson(item, depth + 1)).join(',') + ']';
  }
  const record = asRecord(value);
  if (!record || Object.keys(record).length > 20_000) fail('INVALID_INPUT');
  const entries = Object.keys(record)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(record[key], depth + 1));
  return '{' + entries.join(',') + '}';
}
function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function inputSemantic(request: ProviderGenerationRequest): string {
  return sha256(
    stableJson({
      modelId: request.modelId,
      capability: request.capability,
      requiredFeatures: request.requiredFeatures,
      prompt: request.prompt,
      parameters: request.parameters,
      inputs: request.inputs.map((input) => ({
        artifactId: input.artifactId,
        role: input.role,
        kind: input.kind,
        mimeType: input.mimeType,
        contentHash: input.contentHash.toLowerCase(),
        sizeBytes: input.sizeBytes,
      })),
    }),
  );
}
function runtimeBaseUrl(raw: string): string {
  if (!raw || raw.length > 2048 || raw.trim() !== raw) fail('INVALID_INPUT');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('INVALID_INPUT');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail('INVALID_INPUT');
  return url.toString().replace(/\/+$/, '');
}
function assertRuntime(runtime: H3ResolvedRuntime | null): H3ResolvedRuntime {
  if (
    !runtime ||
    !boundedString(runtime.modelId, 128) ||
    !MODEL_ID_PATTERN.test(runtime.modelId) ||
    typeof runtime.apiKey !== 'string' ||
    runtime.apiKey.length > 4096 ||
    /[\r\n]/.test(runtime.apiKey) ||
    typeof runtime.baseUrl !== 'string'
  )
    fail('INVALID_INPUT');
  return { ...runtime, baseUrl: runtimeBaseUrl(runtime.baseUrl) };
}
function authHeaders(runtime: H3ResolvedRuntime): Headers {
  const headers = new Headers({ accept: 'application/json' });
  if (runtime.apiKey) headers.set('authorization', 'Bearer ' + runtime.apiKey);
  return headers;
}
async function readBoundedJson(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
function safeResponseError(status: number, payload: unknown, fallback: H3ProviderErrorCode): never {
  fail(errorCodeFromPayload(payload) ?? statusErrorCode(status, fallback));
}
async function requestJson(
  fetcher: typeof globalThis.fetch,
  runtime: H3ResolvedRuntime,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fallback: H3ProviderErrorCode,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: new Headers(init.headers ?? authHeaders(runtime)),
      redirect: 'error',
      signal: init.signal ?? timeoutSignal(timeoutMs),
    });
  } catch {
    fail(fallback);
  }
  const payload = await readBoundedJson(response);
  if (!response.ok) safeResponseError(response.status, payload, fallback);
  if (payload === null) fail('INTERNAL_ERROR');
  return payload;
}
function apiUrl(runtime: H3ResolvedRuntime, path: string): string {
  return runtime.baseUrl.replace(/\/+$/, '') + path;
}
function safeProviderId(value: unknown): value is string {
  return boundedString(value, 128) && PROVIDER_ID_PATTERN.test(value);
}
function parseLowerStatus(
  value: unknown,
): 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN' {
  if (value === 'queued') return 'QUEUED';
  if (value === 'running') return 'RUNNING';
  if (value === 'completed') return 'COMPLETED';
  if (value === 'failed') return 'FAILED';
  if (value === 'cancelled') return 'CANCELLED';
  fail('INTERNAL_ERROR');
}
function canonicalMime(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}
function safeFileExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'audio/wav') return 'wav';
  return 'bin';
}
function inputMimeAllowed(role: string, mimeType: string): boolean {
  return ROLE_MIME_TYPES[role]?.includes(mimeType.toLowerCase()) ?? false;
}
interface MultipartBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  isVerified(): boolean;
  failure(): unknown;
}
function multipartFileBody(
  source: GenerationBinarySource,
  mimeType: string,
  expectedSize: number,
  expectedHash: string,
  maxBytes: number,
  boundary: string,
): MultipartBody {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    '--' +
      boundary +
      '\r\nContent-Disposition: form-data; name="file"; filename="input.' +
      safeFileExtension(mimeType) +
      '"\r\nContent-Type: ' +
      mimeType +
      '\r\n\r\n',
  );
  const suffix = encoder.encode('\r\n--' + boundary + '--\r\n');
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let started = false;
  let total = 0;
  let digest: ReturnType<typeof createHash> | null = null;
  let verified = false;
  let streamFailure: unknown = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          digest = createHash('sha256');
          iterator = source.open()[Symbol.asyncIterator]();
          controller.enqueue(prefix);
          return;
        }
        const next = await iterator!.next();
        if (next.done) {
          if (total !== expectedSize || digest!.digest('hex') !== expectedHash.toLowerCase())
            fail('INVALID_INPUT');
          verified = true;
          controller.enqueue(suffix);
          controller.close();
          return;
        }
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_STREAM_CHUNK_BYTES)
          fail('INPUT_TOO_LARGE');
        total += chunk.byteLength;
        if (total > expectedSize || total > maxBytes) fail('INPUT_TOO_LARGE');
        digest!.update(chunk);
        controller.enqueue(chunk);
      } catch (error) {
        streamFailure = error;
        try {
          await iterator?.return?.();
        } catch {
          // Retain the stable validation error.
        }
        try {
          await source.cancel(error);
        } catch {
          // Best-effort resource release.
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      streamFailure = reason;
      try {
        await iterator?.return?.();
      } catch {
        // Best-effort resource release.
      }
      await source.cancel(reason);
    },
  });
  return {
    body: stream,
    contentType: 'multipart/form-data; boundary=' + boundary,
    isVerified: () => verified,
    failure: () => streamFailure,
  };
}
const SAFE_ASPECTS = ['16:9', '9:16', '1:1'] as const;
const PARAMETER_KEYS = new Set([
  'duration',
  'durationSeconds',
  'aspect',
  'seed',
  'task',
  'nativeAudio',
]);

function schemaRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) fail('MODEL_UNAVAILABLE');
  return record;
}
function strictSchemaKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) fail('MODEL_UNAVAILABLE');
}
function schemaIntegerBounds(
  schema: Record<string, unknown>,
  baseMin: number,
  baseMax: number,
): { minimum: number; maximum: number } {
  strictSchemaKeys(schema, new Set(['type', 'minimum', 'maximum', 'default']));
  if (schema.type !== 'integer') fail('MODEL_UNAVAILABLE');
  const minimum = schema.minimum === undefined ? baseMin : schema.minimum;
  const maximum = schema.maximum === undefined ? baseMax : schema.maximum;
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    (minimum as number) > (maximum as number)
  )
    fail('MODEL_UNAVAILABLE');
  return {
    minimum: Math.max(baseMin, minimum as number),
    maximum: Math.min(baseMax, maximum as number),
  };
}
function providerParameterSchema(
  rawSchema: unknown,
  minDuration: number,
  maxDuration: number,
  supportsNativeAudio: boolean,
): Record<string, unknown> {
  const baseAspects = [...SAFE_ASPECTS];
  const baseSeed = { minimum: 0, maximum: 4_294_967_295 };
  let durationBounds = { minimum: minDuration, maximum: maxDuration };
  let aspectValues: string[] = baseAspects;
  let seedBounds = baseSeed;
  let required: string[] = [];
  if (rawSchema !== undefined && rawSchema !== null) {
    let encoded: string;
    try {
      encoded = JSON.stringify(rawSchema);
    } catch {
      return fail('MODEL_UNAVAILABLE');
    }
    if (new TextEncoder().encode(encoded).byteLength > 8 * 1024) fail('MODEL_UNAVAILABLE');
    const schema = schemaRecord(rawSchema);
    strictSchemaKeys(schema, new Set(['type', 'properties', 'required', 'additionalProperties']));
    if (schema.type !== 'object' || schema.additionalProperties === true) fail('MODEL_UNAVAILABLE');
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
      fail('MODEL_UNAVAILABLE');
    const properties = schemaRecord(schema.properties);
    if (Object.keys(properties).length > PARAMETER_KEYS.size) fail('MODEL_UNAVAILABLE');
    if (
      schema.additionalProperties === false &&
      ((properties.duration === undefined && properties.durationSeconds === undefined) ||
        properties.aspect === undefined ||
        properties.task === undefined)
    )
      fail('MODEL_UNAVAILABLE');
    for (const key of Object.keys(properties)) {
      if (!PARAMETER_KEYS.has(key)) fail('MODEL_UNAVAILABLE');
      const property = schemaRecord(properties[key]);
      if (key === 'duration' || key === 'durationSeconds') {
        const bounds = schemaIntegerBounds(property, minDuration, maxDuration);
        durationBounds = {
          minimum: Math.max(durationBounds.minimum, bounds.minimum),
          maximum: Math.min(durationBounds.maximum, bounds.maximum),
        };
      } else if (key === 'seed') {
        seedBounds = schemaIntegerBounds(property, baseSeed.minimum, baseSeed.maximum);
      } else if (key === 'aspect') {
        strictSchemaKeys(property, new Set(['type', 'enum', 'default']));
        if (property.type !== 'string') fail('MODEL_UNAVAILABLE');
        if (property.enum !== undefined) {
          if (
            !Array.isArray(property.enum) ||
            property.enum.length < 1 ||
            property.enum.length > SAFE_ASPECTS.length ||
            property.enum.some(
              (entry) => typeof entry !== 'string' || !baseAspects.includes(entry as never),
            ) ||
            new Set(property.enum).size !== property.enum.length
          )
            fail('MODEL_UNAVAILABLE');
          aspectValues = property.enum as string[];
        }
      } else if (key === 'task') {
        strictSchemaKeys(property, new Set(['type', 'enum', 'default']));
        if (
          property.type !== 'string' ||
          (property.default !== undefined && property.default !== 'auto') ||
          (property.enum !== undefined &&
            (!Array.isArray(property.enum) ||
              property.enum.length !== 1 ||
              property.enum[0] !== 'auto'))
        )
          fail('MODEL_UNAVAILABLE');
      } else if (key === 'nativeAudio') {
        strictSchemaKeys(property, new Set(['type', 'default']));
        if (
          property.type !== 'boolean' ||
          (property.default !== undefined && typeof property.default !== 'boolean') ||
          !supportsNativeAudio
        )
          fail('MODEL_UNAVAILABLE');
      }
    }
    if (durationBounds.minimum > durationBounds.maximum) fail('MODEL_UNAVAILABLE');
    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.length > PARAMETER_KEYS.size ||
        schema.required.some((key) => typeof key !== 'string' || !PARAMETER_KEYS.has(key)) ||
        new Set(schema.required).size !== schema.required.length
      )
        fail('MODEL_UNAVAILABLE');
      required = schema.required.map((key) => (key === 'durationSeconds' ? 'duration' : key));
      if (required.some((key) => !['duration', 'aspect', 'task'].includes(key)))
        fail('MODEL_UNAVAILABLE');
      if (
        required.some((key) =>
          key === 'duration'
            ? properties.duration === undefined && properties.durationSeconds === undefined
            : properties[key] === undefined,
        )
      )
        fail('MODEL_UNAVAILABLE');
    }
    const aspectDefault = asRecord(properties.aspect)?.default;
    if (aspectDefault !== undefined && !aspectValues.includes(aspectDefault as string))
      fail('MODEL_UNAVAILABLE');
    const durationDefault =
      asRecord(properties.duration)?.default ?? asRecord(properties.durationSeconds)?.default;
    if (
      durationDefault !== undefined &&
      (!Number.isSafeInteger(durationDefault) ||
        (durationDefault as number) < durationBounds.minimum ||
        (durationDefault as number) > durationBounds.maximum)
    )
      fail('MODEL_UNAVAILABLE');
    const seedDefault = asRecord(properties.seed)?.default;
    if (
      seedDefault !== undefined &&
      (!Number.isSafeInteger(seedDefault) ||
        (seedDefault as number) < seedBounds.minimum ||
        (seedDefault as number) > seedBounds.maximum)
    )
      fail('MODEL_UNAVAILABLE');
  }
  if (seedBounds.minimum > seedBounds.maximum) fail('MODEL_UNAVAILABLE');
  const durationDefault = Math.min(durationBounds.maximum, Math.max(durationBounds.minimum, 5));
  const aspectDefault = aspectValues.includes('16:9') ? '16:9' : aspectValues[0]!;
  const properties: Record<string, unknown> = {
    duration: {
      type: 'integer',
      minimum: durationBounds.minimum,
      maximum: durationBounds.maximum,
      default: durationDefault,
    },
    durationSeconds: {
      type: 'integer',
      minimum: durationBounds.minimum,
      maximum: durationBounds.maximum,
      default: durationDefault,
    },
    aspect: { type: 'string', enum: aspectValues, default: aspectDefault },
    seed: { type: 'integer', minimum: seedBounds.minimum, maximum: seedBounds.maximum },
    task: { type: 'string', enum: ['auto'], default: 'auto' },
  };
  if (supportsNativeAudio) properties.nativeAudio = { type: 'boolean', default: false };
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

export class H3GenerationGateway implements GenerationGateway {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly activeSubmissions = new Map<
    string,
    {
      requestFingerprint: string;
      semanticFingerprint: string;
      promise: Promise<GenerationSubmission>;
    }
  >();

  constructor(
    private readonly resolveRuntime: H3ResolveRuntime,
    private readonly stateStore: H3AdapterStateStore,
    private readonly outputCache: H3OutputCache,
    options: H3GenerationGatewayOptions = {},
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  async getDescriptor(runtimeProfileId: string): Promise<GenerationModelDescriptor> {
    const runtime = await this.runtime(runtimeProfileId);
    const health = asRecord(
      await requestJson(
        this.fetchImplementation,
        runtime,
        apiUrl(runtime, '/health'),
        { method: 'GET', headers: authHeaders(runtime) },
        this.requestTimeoutMs,
        'MODEL_UNAVAILABLE',
      ),
    );
    if (
      !health ||
      health.status !== 'ok' ||
      health.service !== 'minimax-h3-adapter' ||
      !boundedString(health.version, 64)
    )
      fail('MODEL_UNAVAILABLE');

    const modelPayload = asRecord(
      await requestJson(
        this.fetchImplementation,
        runtime,
        apiUrl(runtime, '/v1/models'),
        { method: 'GET', headers: authHeaders(runtime) },
        this.requestTimeoutMs,
        'MODEL_UNAVAILABLE',
      ),
    );
    const models = modelPayload?.data;
    if (!Array.isArray(models) || models.length > 64) fail('MODEL_UNAVAILABLE');
    const candidates = models
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    const model = candidates.find((entry) => entry.id === runtime.modelId);
    if (!model) fail('MODEL_NOT_FOUND');
    if (candidates.filter((entry) => entry.id === runtime.modelId).length !== 1)
      fail('MODEL_UNAVAILABLE');
    if (model.output_capability !== 'VIDEO_GENERATION' || model.execution_mode !== 'ASYNC_JOB')
      fail('MODEL_UNAVAILABLE');

    const remoteFeatures = model.features;
    const remoteRoles = model.input_roles;
    const limits = asRecord(model.limits);
    const outputTypes = model.output_types;
    if (
      !Array.isArray(remoteFeatures) ||
      remoteFeatures.length > 32 ||
      remoteFeatures.some(
        (feature) => typeof feature !== 'string' || !KNOWN_FEATURES.has(feature),
      ) ||
      new Set(remoteFeatures).size !== remoteFeatures.length ||
      !Array.isArray(remoteRoles) ||
      remoteRoles.length > 32 ||
      remoteRoles.some((role) => typeof role !== 'string' || !KNOWN_ROLES.has(role)) ||
      new Set(remoteRoles).size !== remoteRoles.length ||
      !limits ||
      !Array.isArray(outputTypes) ||
      outputTypes.length > 16 ||
      outputTypes.some((type) => typeof type !== 'string' || type !== 'video/mp4') ||
      !outputTypes.includes('video/mp4')
    )
      fail('MODEL_UNAVAILABLE');
    const minDuration = limits.min_duration_seconds;
    const maxDuration = limits.max_duration_seconds;
    if (
      !Number.isSafeInteger(minDuration) ||
      !Number.isSafeInteger(maxDuration) ||
      (minDuration as number) < 4 ||
      (maxDuration as number) > 15 ||
      (minDuration as number) > (maxDuration as number)
    )
      fail('MODEL_UNAVAILABLE');

    const verifiedFeatures = remoteFeatures.filter(
      (feature): feature is string => typeof feature === 'string' && KNOWN_FEATURES.has(feature),
    );
    if (!verifiedFeatures.includes('TEXT_TO_VIDEO')) fail('MODEL_UNAVAILABLE');
    const verifiedFeatureSet = new Set(verifiedFeatures);
    for (const role of remoteRoles) {
      const roleFeature = ROLE_FEATURE[role];
      if (roleFeature && !verifiedFeatureSet.has(roleFeature)) fail('MODEL_UNAVAILABLE');
    }
    const inputRoles = remoteRoles
      .filter((role): role is string => {
        const requiredFeature = ROLE_FEATURE[role];
        return (
          typeof role === 'string' &&
          KNOWN_ROLES.has(role) &&
          !!requiredFeature &&
          verifiedFeatureSet.has(requiredFeature)
        );
      })
      .map((role) => ({
        role,
        artifactKinds: [
          role.includes('VIDEO') ? 'VIDEO' : role.includes('AUDIO') ? 'AUDIO' : 'IMAGE',
        ],
        mimeTypes: ROLE_MIME_TYPES[role]!,
        maxFiles: 1,
      }));
    const maxInputFiles =
      inputRoles.length === 0
        ? 0
        : limits.max_input_files === undefined
          ? DEFAULT_MAX_INPUT_FILES
          : clampAdvertisedCount(limits.max_input_files, DEFAULT_MAX_INPUT_FILES);
    const maxInputBytes =
      limits.max_input_bytes === undefined
        ? DEFAULT_MAX_INPUT_BYTES
        : clampAdvertisedBytes(limits.max_input_bytes, DEFAULT_MAX_INPUT_BYTES);
    const maxOutputBytes =
      limits.max_output_bytes === undefined
        ? DEFAULT_MAX_OUTPUT_BYTES
        : clampAdvertisedBytes(limits.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES);
    const maxOutputs =
      limits.max_outputs === undefined
        ? DEFAULT_MAX_OUTPUTS
        : clampAdvertisedCount(limits.max_outputs, DEFAULT_MAX_OUTPUTS);
    return {
      modelId: runtime.modelId,
      outputCapability: 'VIDEO_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: verifiedFeatures,
      inputRoles,
      parameterSchema: providerParameterSchema(
        model.parameter_schema,
        minDuration as number,
        maxDuration as number,
        verifiedFeatures.includes('NATIVE_AUDIO'),
      ),
      outputTypes: ['video/mp4'],
      limits: {
        minDurationSeconds: minDuration as number,
        maxDurationSeconds: maxDuration as number,
        maxInputFiles,
        maxInputBytes,
        maxOutputBytes,
        maxOutputs,
      },
    };
  }

  async probe(runtimeProfileId: string): Promise<{ ok: boolean; code: string; message: string }> {
    try {
      await this.getDescriptor(runtimeProfileId);
      return { ok: true, code: 'MODEL_AVAILABLE', message: 'H3 runtime is available.' };
    } catch (error) {
      return {
        ok: false,
        code: isDomainErrorCode(error) ? error.code : 'MODEL_UNAVAILABLE',
        message: 'H3 runtime check failed.',
      };
    }
  }

  async submit(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const lockKey = runtimeProfileId + '\u0000' + request.idempotencyKey;
    const semanticFingerprint = inputSemantic(request);
    const current = this.activeSubmissions.get(lockKey);
    if (current) {
      if (
        current.requestFingerprint !== request.fingerprint ||
        current.semanticFingerprint !== semanticFingerprint
      )
        fail('IDEMPOTENCY_CONFLICT');
      return current.promise;
    }
    const pending = this.submitLocked(runtimeProfileId, request);
    const active = {
      requestFingerprint: request.fingerprint,
      semanticFingerprint,
      promise: pending,
    };
    this.activeSubmissions.set(lockKey, active);
    try {
      return await pending;
    } finally {
      if (this.activeSubmissions.get(lockKey) === active) this.activeSubmissions.delete(lockKey);
    }
  }

  async getJob(runtimeProfileId: string, providerJobId: string): Promise<ProviderGenerationJob> {
    if (!safeProviderId(providerJobId)) fail('OUTPUT_MISSING');
    const runtime = await this.runtime(runtimeProfileId);
    const descriptor = await this.getDescriptor(runtimeProfileId);
    const payload = asRecord(
      await requestJson(
        this.fetchImplementation,
        runtime,
        apiUrl(runtime, '/v1/videos/' + encodeURIComponent(providerJobId)),
        { method: 'GET', headers: authHeaders(runtime) },
        this.requestTimeoutMs,
        'GENERATION_FAILED',
      ),
    );
    if (!payload || payload.task_id !== providerJobId) fail('INTERNAL_ERROR');
    const status = parseLowerStatus(payload.status);
    if (status === 'FAILED' || status === 'CANCELLED')
      return {
        providerJobId,
        status,
        outputs: [],
        errorCode: this.providerJobError(payload.error),
      };
    if (status !== 'COMPLETED') return { providerJobId, status, outputs: [], errorCode: null };

    if (!Array.isArray(payload.outputs) || payload.outputs.length < 1) fail('OUTPUT_MISSING');
    if (payload.outputs.length > descriptor.limits.maxOutputs) fail('OUTPUT_MISSING');
    const outputs: GenerationOutputDescriptor[] = [];
    const ids = new Set<string>();
    for (const outputValue of payload.outputs) {
      const output = asRecord(outputValue);
      if (
        !output ||
        !safeProviderId(output.id) ||
        ids.has(output.id) ||
        output.mime_type !== 'video/mp4' ||
        !isPositiveSafeInteger(output.size_bytes) ||
        output.size_bytes > descriptor.limits.maxOutputBytes
      )
        fail('OUTPUT_MISSING');
      const outputId = output.id;
      ids.add(outputId);
      const advertisedSize = output.size_bytes;
      let cached = await this.outputCache.lookup(runtimeProfileId, providerJobId, outputId);
      if (cached) {
        this.validateCachedOutput(cached, advertisedSize, descriptor.limits.maxOutputBytes);
      } else {
        try {
          cached = await this.outputCache.capture({
            runtimeProfileId,
            providerJobId,
            outputId,
            mimeType: 'video/mp4',
            advertisedSize,
            source: this.remoteOutputSource(
              runtime,
              providerJobId,
              outputId,
              advertisedSize,
              descriptor.limits.maxOutputBytes,
            ),
          });
        } catch (error) {
          if (error instanceof GenerationCrash) throw error;
          if (error instanceof DomainError) {
            if (
              ['ARTIFACT_COMMIT_FAILED', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR'].includes(
                error.code,
              )
            )
              throw new GenerationCrash(
                'H3 output cache capture was interrupted; provider job retained',
              );
            throw error;
          }
          throw new GenerationCrash(
            'H3 output cache capture was interrupted; provider job retained',
          );
        }
        this.validateCachedOutput(cached, advertisedSize, descriptor.limits.maxOutputBytes);
      }
      outputs.push({
        id: outputId,
        mimeType: 'video/mp4',
        extension: '.mp4',
        sizeBytes: cached.sizeBytes,
        contentHash: cached.contentHash,
        metadata: safeOutputMetadata(output),
      });
    }
    return { providerJobId, status: 'COMPLETED', outputs, errorCode: null };
  }

  async downloadOutput(
    runtimeProfileId: string,
    providerJobId: string,
    outputId: string,
    options?: GenerationOperationOptions,
  ): Promise<GenerationBinarySource> {
    if (!safeProviderId(providerJobId) || !safeProviderId(outputId)) fail('OUTPUT_MISSING');
    if (options?.signal?.aborted) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    const cached = await this.outputCache.lookup(runtimeProfileId, providerJobId, outputId);
    if (cached) return cached.source;
    const job = await this.getJob(runtimeProfileId, providerJobId);
    if (job.status !== 'COMPLETED' || !job.outputs.some((output) => output.id === outputId))
      fail('OUTPUT_MISSING');
    const captured = await this.outputCache.lookup(runtimeProfileId, providerJobId, outputId);
    if (!captured) fail('OUTPUT_MISSING');
    return captured.source;
  }

  private validateCachedOutput(
    cached: H3CachedOutput,
    advertisedSize: number,
    maxBytes: number,
  ): void {
    if (
      cached.sizeBytes !== advertisedSize ||
      cached.sizeBytes > maxBytes ||
      !SHA256_PATTERN.test(cached.contentHash) ||
      cached.contentHash !== cached.contentHash.toLowerCase()
    )
      fail('OUTPUT_MISSING');
  }

  private async submitLocked(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const runtime = await this.runtime(runtimeProfileId);
    if (
      !safeHeaderKey(request.idempotencyKey) ||
      !boundedString(request.fingerprint, 256) ||
      !boundedString(request.modelId, 128)
    )
      fail('INVALID_INPUT');
    const semanticFingerprint = inputSemantic(request);
    let state = await this.stateStore.get(runtimeProfileId, request.idempotencyKey);
    if (state) {
      if (
        state.key !== request.idempotencyKey ||
        state.runtimeId !== runtimeProfileId ||
        state.requestFingerprint !== request.fingerprint ||
        state.semanticFingerprint !== semanticFingerprint
      )
        fail('IDEMPOTENCY_CONFLICT');
      if (state.phase === 'SUBMITTED') {
        if (!state.providerJobId) fail('SUBMISSION_STATE_UNKNOWN');
        return {
          outcome: 'SUBMITTED',
          providerJobId: state.providerJobId,
          status: 'QUEUED',
        };
      }
      if (state.phase === 'REJECTED') {
        if (!state.errorCode || !DEFINITIVE_REJECTION_CODES.has(state.errorCode))
          fail('SUBMISSION_STATE_UNKNOWN');
        return { outcome: 'REJECTED', errorCode: state.errorCode };
      }
      if (state.phase === 'SUBMITTING' || state.phase === 'UNKNOWN') {
        if (state.phase === 'SUBMITTING')
          await this.stateStore.put({ ...state, phase: 'UNKNOWN', providerJobId: null });
        return { outcome: 'UNKNOWN' };
      }
      if (state.phase !== 'PREPARED' || !state.exactBody || !Array.isArray(state.uploadedFiles))
        fail('INTERNAL_ERROR');
      if (!this.bodyMatchesState(state, request)) fail('INTERNAL_ERROR');
    } else {
      const descriptor = await this.getDescriptor(runtimeProfileId);
      if (request.modelId !== descriptor.modelId) fail('MODEL_NOT_FOUND');
      this.validateRequest(request, descriptor);
      const uploadedFiles = await this.uploadInputs(
        runtime,
        request,
        descriptor.limits.maxInputBytes,
      );
      const body = this.submissionBody(request, uploadedFiles, descriptor.parameterSchema);
      state = {
        runtimeId: runtimeProfileId,
        key: request.idempotencyKey,
        requestFingerprint: request.fingerprint,
        semanticFingerprint,
        uploadedFiles,
        exactBody: JSON.stringify(body),
        phase: 'PREPARED',
        providerJobId: null,
        errorCode: null,
      };
      await this.stateStore.put(state);
    }
    await this.stateStore.put({
      ...state,
      phase: 'SUBMITTING',
      providerJobId: null,
      errorCode: null,
    });
    let response: Response;
    try {
      response = await this.fetchImplementation(apiUrl(runtime, '/v1/videos'), {
        method: 'POST',
        headers: this.submissionHeaders(runtime, request.idempotencyKey),
        body: state.exactBody,
        redirect: 'error',
        signal: timeoutSignal(this.requestTimeoutMs),
      });
    } catch {
      await this.markUnknown(state);
      return { outcome: 'UNKNOWN' };
    }
    const payload = await readBoundedJson(response);
    if (!response.ok) {
      const errorCode = definitiveSubmissionRejection(payload);
      if (!errorCode) {
        await this.markUnknown(state);
        return { outcome: 'UNKNOWN' };
      }
      try {
        await this.stateStore.put({
          ...state,
          phase: 'REJECTED',
          providerJobId: null,
          errorCode,
        });
      } catch {
        // The provider says it rejected the task, but without a durable rejection fact a restart
        // must retain the existing SUBMITTING barrier and report uncertainty.
        return { outcome: 'UNKNOWN' };
      }
      return { outcome: 'REJECTED', errorCode };
    }
    const result = asRecord(payload);
    const rawStatus = result?.status;
    const providerJobId = result?.task_id;
    if (
      !result ||
      !safeProviderId(providerJobId) ||
      (rawStatus !== 'queued' && rawStatus !== 'running')
    ) {
      await this.markUnknown(state);
      return { outcome: 'UNKNOWN' };
    }
    try {
      await this.stateStore.put({ ...state, phase: 'SUBMITTED', providerJobId });
    } catch {
      fail('SUBMISSION_STATE_UNKNOWN');
    }
    return {
      outcome: 'SUBMITTED',
      providerJobId,
      status: rawStatus === 'running' ? 'RUNNING' : 'QUEUED',
    };
  }

  private bodyMatchesState(
    state: H3AdapterSubmissionState,
    request: ProviderGenerationRequest,
  ): boolean {
    try {
      const record = asRecord(JSON.parse(state.exactBody) as unknown);
      return (
        record !== null &&
        record.model === request.modelId &&
        record.prompt === request.prompt &&
        Array.isArray(record.media) &&
        record.media.length === state.uploadedFiles.length &&
        record.media.every((entry, index) => {
          const media = asRecord(entry);
          const file = state.uploadedFiles[index];
          return media?.file_id === file?.fileId && media?.role === file?.role.toLowerCase();
        })
      );
    } catch {
      return false;
    }
  }

  private submissionHeaders(runtime: H3ResolvedRuntime, idempotencyKey: string): Headers {
    const headers = authHeaders(runtime);
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', idempotencyKey);
    return headers;
  }

  private async uploadInputs(
    runtime: H3ResolvedRuntime,
    request: ProviderGenerationRequest,
    maxInputBytes: number,
  ): Promise<H3UploadedFileIdentity[]> {
    let total = 0;
    for (const input of request.inputs) {
      if (
        !isPositiveSafeInteger(input.sizeBytes) ||
        !SHA256_PATTERN.test(input.contentHash) ||
        total + input.sizeBytes > maxInputBytes
      )
        fail('INPUT_TOO_LARGE');
      total += input.sizeBytes;
    }
    const uploaded: H3UploadedFileIdentity[] = [];
    for (const input of request.inputs) {
      const mimeType = canonicalMime(input.mimeType);
      if (!inputMimeAllowed(input.role, mimeType)) fail('UNSUPPORTED_MEDIA_TYPE');
      if (!input.source || typeof input.source.open !== 'function') fail('INVALID_INPUT');
      const boundary = 'h3-' + sha256(input.artifactId).slice(0, 32);
      const multipart = multipartFileBody(
        input.source,
        mimeType,
        input.sizeBytes,
        input.contentHash,
        maxInputBytes,
        boundary,
      );
      const headers = authHeaders(runtime);
      headers.set('content-type', multipart.contentType);
      const streamInit = {
        method: 'POST',
        headers,
        body: multipart.body,
        redirect: 'error',
        signal: timeoutSignal(this.uploadTimeoutMs),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' };
      let response: Response;
      try {
        response = await this.fetchImplementation(apiUrl(runtime, '/v1/files'), streamInit);
      } catch {
        const streamFailure = multipart.failure();
        if (streamFailure instanceof DomainError) throw streamFailure;
        fail('MODEL_UNAVAILABLE');
      }
      if (!multipart.isVerified()) {
        const streamFailure = multipart.failure();
        if (streamFailure instanceof DomainError) throw streamFailure;
        fail('INVALID_INPUT');
      }
      const payload = await readBoundedJson(response);
      if (!response.ok) safeResponseError(response.status, payload, 'MODEL_UNAVAILABLE');
      const file = asRecord(payload);
      if (
        !file ||
        !safeProviderId(file.file_id) ||
        file.mime_type !== mimeType ||
        file.size_bytes !== input.sizeBytes ||
        typeof file.sha256 !== 'string' ||
        file.sha256.toLowerCase() !== input.contentHash.toLowerCase()
      )
        fail('INTERNAL_ERROR');
      uploaded.push({
        artifactId: input.artifactId,
        role: input.role,
        fileId: file.file_id,
        mimeType,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash.toLowerCase(),
      });
    }
    return uploaded;
  }

  private validateRequest(
    request: ProviderGenerationRequest,
    descriptor: GenerationModelDescriptor,
  ): void {
    if (request.capability !== 'VIDEO_GENERATION') fail('UNSUPPORTED_FEATURE');
    if (
      request.requiredFeatures.length > 24 ||
      new Set(request.requiredFeatures).size !== request.requiredFeatures.length
    )
      fail('INVALID_INPUT');
    const features = new Set(descriptor.featureTags);
    for (const feature of request.requiredFeatures) {
      if (!KNOWN_FEATURES.has(feature) || !features.has(feature)) fail('UNSUPPORTED_FEATURE');
    }
    if (!request.prompt.trim() || request.prompt.length > 12_000) fail('INVALID_INPUT');
    if (request.inputs.length > descriptor.limits.maxInputFiles) fail('INPUT_TOO_LARGE');
    for (const input of request.inputs) {
      if (!KNOWN_ROLES.has(input.role)) fail('UNSUPPORTED_INPUT_ROLE');
      const feature = ROLE_FEATURE[input.role];
      if (feature && (!features.has(feature) || !request.requiredFeatures.includes(feature)))
        fail('UNSUPPORTED_FEATURE');
      const role = descriptor.inputRoles.find((entry) => entry.role === input.role);
      if (!role) fail('UNSUPPORTED_INPUT_ROLE');
      if (
        request.inputs.filter((entry) => entry.role === input.role).length > role.maxFiles ||
        !role.mimeTypes.includes(canonicalMime(input.mimeType)) ||
        !role.artifactKinds.includes(input.kind)
      )
        fail('UNSUPPORTED_MEDIA_TYPE');
    }
    if (JSON.stringify(request.parameters).length > 8_000) fail('INVALID_INPUT');
    const parameters = asRecord(request.parameters);
    if (!parameters) fail('INVALID_INPUT');
    if (parameters.nativeAudio !== undefined && !descriptor.featureTags.includes('NATIVE_AUDIO'))
      fail('UNSUPPORTED_FEATURE');
    const permitted = new Set(['durationSeconds', 'duration', 'aspect', 'seed', 'task']);
    if (descriptor.featureTags.includes('NATIVE_AUDIO')) permitted.add('nativeAudio');
    if (Object.keys(parameters).some((key) => !permitted.has(key))) fail('INVALID_INPUT');
    if (parameters.nativeAudio !== undefined && typeof parameters.nativeAudio !== 'boolean')
      fail('INVALID_INPUT');
    if (
      parameters.duration !== undefined &&
      parameters.durationSeconds !== undefined &&
      parameters.duration !== parameters.durationSeconds
    )
      fail('INVALID_INPUT');
    const schemaProperties = asRecord(asRecord(descriptor.parameterSchema)?.properties);
    const durationDefault = asRecord(schemaProperties?.duration)?.default;
    const duration = parameters.durationSeconds ?? parameters.duration ?? durationDefault;
    if (!Number.isSafeInteger(duration)) fail('INVALID_INPUT');
    const durationProperty = asRecord(schemaProperties?.duration);
    const parameterMin =
      typeof durationProperty?.minimum === 'number'
        ? durationProperty.minimum
        : (descriptor.limits.minDurationSeconds ?? 1);
    const parameterMax =
      typeof durationProperty?.maximum === 'number'
        ? durationProperty.maximum
        : (descriptor.limits.maxDurationSeconds ?? 60);
    if ((duration as number) < parameterMin || (duration as number) > parameterMax)
      fail('MODEL_DURATION_LIMIT');
    const aspectProperty = asRecord(schemaProperties?.aspect);
    const allowedAspects: unknown[] = Array.isArray(aspectProperty?.enum)
      ? aspectProperty.enum
      : [...SAFE_ASPECTS];
    if (parameters.aspect !== undefined && !allowedAspects.includes(parameters.aspect))
      fail('INVALID_INPUT');
    const seedProperty = asRecord(schemaProperties?.seed);
    const seedMin = typeof seedProperty?.minimum === 'number' ? seedProperty.minimum : 0;
    const seedMax =
      typeof seedProperty?.maximum === 'number' ? seedProperty.maximum : 4_294_967_295;
    if (
      parameters.seed !== undefined &&
      (!Number.isSafeInteger(parameters.seed) ||
        (parameters.seed as number) < seedMin ||
        (parameters.seed as number) > seedMax)
    )
      fail('INVALID_INPUT');
    if (parameters.task !== undefined && parameters.task !== 'auto') fail('INVALID_INPUT');
  }

  private submissionBody(
    request: ProviderGenerationRequest,
    uploadedFiles: H3UploadedFileIdentity[],
    parameterSchema: Record<string, unknown>,
  ): Record<string, unknown> {
    const parameters = request.parameters;
    const schemaProperties = asRecord(parameterSchema.properties);
    const duration =
      parameters.durationSeconds ??
      parameters.duration ??
      asRecord(schemaProperties?.duration)?.default;
    const body: Record<string, unknown> = {
      model: request.modelId,
      prompt: request.prompt,
      duration,
      aspect: parameters.aspect ?? asRecord(schemaProperties?.aspect)?.default ?? '16:9',
      task: parameters.task ?? 'auto',
      media: uploadedFiles.map((file) => ({
        role: file.role.toLowerCase(),
        file_id: file.fileId,
      })),
    };
    if (parameters.seed !== undefined) body.seed = parameters.seed;
    return body;
  }

  private async markUnknown(state: H3AdapterSubmissionState): Promise<void> {
    try {
      await this.stateStore.put({ ...state, phase: 'UNKNOWN', providerJobId: null });
    } catch {
      // Durable SUBMITTING still prevents a later replay after a store failure.
    }
  }

  private providerJobError(value: unknown): string {
    return errorCodeFromPayload({ error: value }) ?? 'GENERATION_FAILED';
  }

  private remoteOutputSource(
    runtime: H3ResolvedRuntime,
    providerJobId: string,
    outputId: string,
    advertisedSize: number,
    maxBytes: number,
  ): GenerationBinarySource {
    let opened = false;
    let controller: AbortController | null = null;
    const download = this.fetchImplementation;
    return {
      open: async function* (signal?: AbortSignal) {
        if (opened) fail('OUTPUT_MISSING');
        opened = true;
        controller = new AbortController();
        const abort = () => controller?.abort(signal?.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        let response: Response;
        try {
          response = await download(
            apiUrl(
              runtime,
              '/v1/videos/' +
                encodeURIComponent(providerJobId) +
                '/outputs/' +
                encodeURIComponent(outputId),
            ),
            {
              method: 'GET',
              headers: authHeaders(runtime),
              redirect: 'error',
              signal: controller.signal,
            },
          );
        } catch {
          throw new GenerationCrash('H3 output download was interrupted; provider job retained');
        }
        if (!response.ok) {
          if (response.status >= 500 || response.status === 408 || response.status === 429)
            throw new GenerationCrash('H3 output download was interrupted; provider job retained');
          safeResponseError(response.status, await readBoundedJson(response), 'OUTPUT_MISSING');
        }
        if (canonicalMime(response.headers.get('content-type') ?? '') !== 'video/mp4') {
          await response.body?.cancel();
          fail('UNSUPPORTED_MEDIA_TYPE');
        }
        const reader = response.body?.getReader();
        if (!reader) fail('OUTPUT_MISSING');
        let size = 0;
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (
              item.value.byteLength > MAX_STREAM_CHUNK_BYTES ||
              size > maxBytes ||
              size > advertisedSize
            )
              fail('OUTPUT_MISSING');
            yield item.value;
          }
        } finally {
          signal?.removeEventListener('abort', abort);
          reader.releaseLock();
        }
        if (size !== advertisedSize) fail('OUTPUT_MISSING');
      },
      cancel: async (reason?: unknown) => {
        if (controller && !controller.signal.aborted) controller.abort(reason);
      },
    };
  }

  private async runtime(runtimeProfileId: string): Promise<H3ResolvedRuntime> {
    let resolved: H3ResolvedRuntime | null;
    try {
      resolved = await this.resolveRuntime(runtimeProfileId);
    } catch {
      fail('MODEL_UNAVAILABLE');
    }
    if (!resolved) fail('MODEL_UNAVAILABLE');
    const runtime = assertRuntime(resolved);
    return runtime;
  }
}

function safeHeaderKey(value: unknown): value is string {
  return boundedString(value, 128) && /^[A-Za-z0-9._:-]+$/.test(value);
}
function isDomainErrorCode(value: unknown): value is DomainError & { code: H3ProviderErrorCode } {
  return value instanceof DomainError && KNOWN_ERRORS.has(value.code as H3ProviderErrorCode);
}
function clampAdvertisedBytes(value: unknown, defaultBytes: number): number {
  if (!isPositiveSafeInteger(value)) fail('MODEL_UNAVAILABLE');
  return Math.min(value, defaultBytes);
}
function clampAdvertisedCount(value: unknown, defaultCount: number): number {
  if (!isPositiveSafeInteger(value)) fail('MODEL_UNAVAILABLE');
  return Math.min(value, defaultCount);
}
function safeOutputMetadata(
  output: Record<string, unknown>,
): Record<string, number | string | boolean | null> {
  const metadata: Record<string, number | string | boolean | null> = {};
  for (const [providerKey, publicKey] of [
    ['duration_seconds', 'durationSeconds'],
    ['width', 'width'],
    ['height', 'height'],
    ['fps', 'fps'],
  ] as const) {
    const value = output[providerKey];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000)
      metadata[publicKey] = value;
  }
  return metadata;
}
