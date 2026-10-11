import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { DomainError } from '@cultivation/shared';
import { GenerationCrash } from '@cultivation/application/g1-generation';
import type { GenerationBinarySource } from '@cultivation/application/g1-generation';
import type {
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
import type {
  GenerationCachedMedia,
  GenerationProviderMediaCache,
  GenerationProviderHttpOptions,
  GenerationProviderRuntime,
  GenerationProviderStatePort,
  GenerationProviderSubmissionFact,
  GenerationRuntimeResolver,
  GenerationUploadedInput,
} from './generation-provider-ports.js';

const MiB = 1024 * 1024;
export const MAX_PROVIDER_JSON_BYTES = 2 * MiB;
export const MAX_PROVIDER_CHUNK_BYTES = MiB;
const MAX_SOURCE_YIELD_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export type CommercialProvider = 'APIMART' | 'TOKENRHYTHM';
export type SafeGenerationErrorCode =
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
  | 'OUTPUT_TOO_LARGE'
  | 'INTERNAL_ERROR';

const SAFE_MESSAGES: Record<SafeGenerationErrorCode, string> = {
  AUTH_FAILED: 'The generation provider rejected its account credentials or access.',
  MODEL_NOT_FOUND: 'The configured generation model was not found.',
  MODEL_UNAVAILABLE: 'The generation provider is unavailable.',
  INVALID_INPUT: 'The generation request is invalid.',
  UNSUPPORTED_FEATURE: 'The generation provider does not support a requested feature.',
  UNSUPPORTED_INPUT_ROLE: 'The generation provider does not support this input role.',
  UNSUPPORTED_MEDIA_TYPE: 'The generation provider returned an unsupported media type.',
  INPUT_TOO_LARGE: 'Generation input exceeds the provider limit.',
  MODEL_DURATION_LIMIT: 'The requested duration exceeds the model limit.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was used for a different generation request.',
  QUEUE_FULL: 'The generation provider rejected the request because its queue is full.',
  GENERATION_FAILED: 'Generation failed at the provider.',
  GENERATION_TIMEOUT: 'The provider request timed out.',
  SUBMISSION_STATE_UNKNOWN: 'Submission state is unknown and the request will not be repeated.',
  OUTPUT_MISSING: 'The generation output is missing or unavailable.',
  OUTPUT_TOO_LARGE: 'Generation output exceeds the media limit.',
  INTERNAL_ERROR: 'The generation provider returned an invalid response.',
};

export function fail(code: SafeGenerationErrorCode): never {
  throw new DomainError(code, SAFE_MESSAGES[code]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isByteChunk(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

export function boundedString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function safeProviderId(value: unknown): value is string {
  return boundedString(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function safeIdempotencyKey(value: unknown): value is string {
  return boundedString(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function safeFingerprint(value: unknown): value is string {
  return boundedString(value, 256) && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function safeSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value: unknown, depth = 0): string {
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
  if (!isRecord(value) || Object.keys(value).length > 20_000) fail('INVALID_INPUT');
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableJson(value[key], depth + 1))
      .join(',') +
    '}'
  );
}

export function semanticFingerprint(request: {
  modelId: string;
  capability: string;
  requiredFeatures: string[];
  prompt: string;
  parameters: Record<string, unknown>;
  inputs: Array<{
    artifactId: string;
    role: string;
    kind: string;
    mimeType: string;
    contentHash: string;
    sizeBytes: number;
  }>;
}): string {
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
        mimeType: canonicalMime(input.mimeType),
        contentHash: input.contentHash.toLowerCase(),
        sizeBytes: input.sizeBytes,
      })),
    }),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function validateRuntime(
  runtime: GenerationProviderRuntime | null,
  provider: CommercialProvider,
  testOnly: boolean,
): GenerationProviderRuntime {
  if (
    !runtime ||
    !boundedString(runtime.modelId, 128) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runtime.modelId) ||
    typeof runtime.apiKey !== 'string' ||
    runtime.apiKey.length < 1 ||
    runtime.apiKey.length > 4096 ||
    /[\r\n]/.test(runtime.apiKey) ||
    typeof runtime.baseUrl !== 'string' ||
    runtime.baseUrl.length > 2048 ||
    runtime.baseUrl.trim() !== runtime.baseUrl
  )
    fail('INVALID_INPUT');
  let url: URL;
  try {
    url = new URL(runtime.baseUrl);
  } catch {
    return fail('INVALID_INPUT');
  }
  const allowedHost = provider === 'APIMART' ? 'api.apimart.ai' : 'tokenrhythm.studio';
  const isFixture = testOnly && isLoopbackHostname(url.hostname);
  const validProtocol = url.protocol === 'https:' || (isFixture && url.protocol === 'http:');
  const validPath = url.pathname === '' || url.pathname === '/' || url.pathname === '/v1';
  if (
    !validProtocol ||
    (!isFixture && url.hostname.toLowerCase() !== allowedHost) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !validPath ||
    (!isFixture && url.port !== '')
  )
    fail('INVALID_INPUT');
  return { ...runtime, baseUrl: url.origin + '/v1' };
}

export function providerApiUrl(runtime: GenerationProviderRuntime, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) fail('INTERNAL_ERROR');
  return runtime.baseUrl.replace(/\/+$/, '') + path;
}

export interface JsonHttpResult {
  response: Response;
  payload: unknown | null;
}

export async function readBoundedJson(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!isByteChunk(item.value) || item.value.byteLength > MAX_PROVIDER_CHUNK_BYTES) {
        await reader.cancel();
        return null;
      }
      total += item.value.byteLength;
      if (total > MAX_PROVIDER_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(item.value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Preserve the bounded-JSON failure result.
    }
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

export async function fetchJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<JsonHttpResult> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GenerationCrash('Provider request was interrupted; the generation job is retained.');
  }
  return { response, payload: await readBoundedJson(response) };
}

export type GenerationSubmissionRejection =
  | 'AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_FEATURE'
  | 'UNSUPPORTED_INPUT_ROLE'
  | 'MODEL_DURATION_LIMIT'
  | 'QUEUE_FULL'
  | 'IDEMPOTENCY_CONFLICT';

export function statusErrorCode(
  status: number,
  fallback: SafeGenerationErrorCode,
): SafeGenerationErrorCode {
  if (status === 401 || status === 403 || status === 402) return 'AUTH_FAILED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 429) return 'QUEUE_FULL';
  if (status === 408 || status === 504) return 'GENERATION_TIMEOUT';
  if (status >= 500) return 'MODEL_UNAVAILABLE';
  if (status >= 400) return 'INVALID_INPUT';
  return fallback;
}

export function canonicalMime(value: string): string {
  const bare = value.split(';', 1)[0]!.trim().toLowerCase();
  if (bare === 'image/jpg' || bare === 'image/pjpeg') return 'image/jpeg';
  if (bare === 'audio/x-wav' || bare === 'audio/wave') return 'audio/wav';
  if (bare === 'audio/mp3' || bare === 'audio/x-mp3') return 'audio/mpeg';
  return bare;
}

/** Identifies only common bounded file headers; the media cache performs full validation. */
export function sniffMediaMimeType(prefix: Uint8Array): string | null {
  if (
    prefix.length >= 8 &&
    prefix[0] === 0x89 &&
    prefix[1] === 0x50 &&
    prefix[2] === 0x4e &&
    prefix[3] === 0x47 &&
    prefix[4] === 0x0d &&
    prefix[5] === 0x0a &&
    prefix[6] === 0x1a &&
    prefix[7] === 0x0a
  )
    return 'image/png';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff)
    return 'image/jpeg';
  if (
    prefix.length >= 12 &&
    prefix[0] === 0x52 &&
    prefix[1] === 0x49 &&
    prefix[2] === 0x46 &&
    prefix[3] === 0x46
  ) {
    if (prefix[8] === 0x57 && prefix[9] === 0x41 && prefix[10] === 0x56 && prefix[11] === 0x45)
      return 'audio/wav';
    if (prefix[8] === 0x57 && prefix[9] === 0x45 && prefix[10] === 0x42 && prefix[11] === 0x50)
      return 'image/webp';
  }
  if (
    prefix.length >= 8 &&
    prefix[4] === 0x66 &&
    prefix[5] === 0x74 &&
    prefix[6] === 0x79 &&
    prefix[7] === 0x70
  )
    return 'video/mp4';
  if (prefix.length >= 3 && prefix[0] === 0x49 && prefix[1] === 0x44 && prefix[2] === 0x33)
    return 'audio/mpeg';
  if (prefix.length >= 2 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

export function extensionForMime(mimeType: string): string {
  switch (canonicalMime(mimeType)) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'video/mp4':
      return '.mp4';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/wav':
      return '.wav';
    default:
      return '.bin';
  }
}

export function isAllowedProviderUrl(
  raw: string,
  provider: CommercialProvider,
  testOnly: boolean,
  allowedMimeTypes?: readonly string[],
): URL | null {
  if (!boundedString(raw, 8192) || raw.trim() !== raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowedHosts =
    provider === 'APIMART'
      ? new Set(['upload.apimart.ai', 'api.apimart.ai'])
      : new Set(['tokenrhythm.studio']);
  const loopbackFixture = testOnly && isLoopbackHostname(host);
  const verifiedApiMartAudioHost =
    provider === 'APIMART' &&
    host === 'getapib.org' &&
    !!allowedMimeTypes?.length &&
    allowedMimeTypes.every((mimeType) => canonicalMime(mimeType).startsWith('audio/'));
  if (
    !(url.protocol === 'https:' || (loopbackFixture && url.protocol === 'http:')) ||
    (!allowedHosts.has(host) && !verifiedApiMartAudioHost && !loopbackFixture) ||
    url.username ||
    url.password ||
    url.hash ||
    (!loopbackFixture && url.port !== '') ||
    url.pathname.length > 4096 ||
    url.search.length > 4096
  )
    return null;
  return url;
}

export interface OpenedRemoteMedia {
  mimeType: string;
  advertisedSize: number | null;
  source: GenerationBinarySource;
}

export async function openRemoteMedia(
  fetcher: typeof globalThis.fetch,
  rawUrl: string,
  provider: CommercialProvider,
  testOnly: boolean,
  allowedMimeTypes: readonly string[],
  maxBytes: number,
  timeoutMs: number,
): Promise<OpenedRemoteMedia> {
  const url = isAllowedProviderUrl(rawUrl, provider, testOnly, allowedMimeTypes);
  if (!url) fail('OUTPUT_MISSING');
  let response: Response;
  try {
    // Output URLs can be signed bearer-like values. They are used only for this request and are
    // never included in a diagnostic, header, log record, or Renderer response.
    response = await fetcher(url.toString(), {
      method: 'GET',
      headers: { accept: allowedMimeTypes.join(', ') },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GenerationCrash('Provider output download was interrupted; the job is retained.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 500 || response.status === 408 || response.status === 429)
      throw new GenerationCrash('Provider output download was interrupted; the job is retained.');
    fail('OUTPUT_MISSING');
  }
  if (
    response.redirected ||
    (response.url && new URL(response.url).origin !== url.origin) ||
    (response.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity'
  ) {
    await response.body?.cancel();
    fail('OUTPUT_MISSING');
  }
  const declaredMimeType = canonicalMime(response.headers.get('content-type') ?? '');
  const contentLength = response.headers.get('content-length');
  let advertisedSize: number | null = null;
  if (contentLength !== null) {
    if (!/^[0-9]{1,16}$/.test(contentLength)) {
      await response.body?.cancel();
      fail('OUTPUT_MISSING');
    }
    const parsed = Number(contentLength);
    if (!positiveSafeInteger(parsed)) {
      await response.body?.cancel();
      fail('OUTPUT_MISSING');
    }
    if (parsed > maxBytes) {
      await response.body?.cancel();
      fail('OUTPUT_TOO_LARGE');
    }
    advertisedSize = parsed;
  }
  if (!response.body) fail('OUTPUT_MISSING');
  const reader = response.body.getReader();
  const prefetched: Uint8Array[] = [];
  const prefix = new Uint8Array(12);
  let prefixLength = 0;
  let headerChunks = 0;
  try {
    while (prefixLength < prefix.byteLength && headerChunks < 64) {
      const item = await reader.read();
      if (item.done) break;
      headerChunks += 1;
      if (!isByteChunk(item.value) || item.value.byteLength > MAX_PROVIDER_CHUNK_BYTES) {
        await reader.cancel();
        reader.releaseLock();
        fail('OUTPUT_TOO_LARGE');
      }
      prefetched.push(item.value);
      const take = Math.min(prefix.byteLength - prefixLength, item.value.byteLength);
      prefix.set(item.value.subarray(0, take), prefixLength);
      prefixLength += take;
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the stable cancellation or validation error.
    }
    try {
      reader.releaseLock();
    } catch {
      // The stream may already have released its reader after cancellation.
    }
    if (error instanceof DomainError) throw error;
    throw new GenerationCrash('Provider output download was interrupted; the job is retained.');
  }
  const detectedMimeType = sniffMediaMimeType(prefix.subarray(0, prefixLength));
  const mimeType = detectedMimeType ?? declaredMimeType;
  if (
    !allowedMimeTypes.map(canonicalMime).includes(mimeType) ||
    ((declaredMimeType === 'application/octet-stream' ||
      declaredMimeType === 'binary/octet-stream') &&
      detectedMimeType === null)
  ) {
    await reader.cancel();
    reader.releaseLock();
    fail('UNSUPPORTED_MEDIA_TYPE');
  }
  let opened = false;
  let cancelled = false;
  const source: GenerationBinarySource = {
    async *open(signal?: AbortSignal) {
      if (opened || cancelled) fail('OUTPUT_MISSING');
      opened = true;
      let total = 0;
      const onAbort = () => {
        void reader.cancel(signal?.reason);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let prefetchedIndex = 0;
        while (true) {
          const item =
            prefetchedIndex < prefetched.length
              ? { done: false as const, value: prefetched[prefetchedIndex++]! }
              : await reader.read();
          if (item.done) break;
          if (!isByteChunk(item.value) || item.value.byteLength > MAX_PROVIDER_CHUNK_BYTES)
            fail('OUTPUT_TOO_LARGE');
          total += item.value.byteLength;
          if (total > maxBytes || (advertisedSize !== null && total > advertisedSize))
            fail('OUTPUT_TOO_LARGE');
          for (let offset = 0; offset < item.value.byteLength; offset += MAX_SOURCE_YIELD_BYTES)
            yield item.value.subarray(
              offset,
              Math.min(offset + MAX_SOURCE_YIELD_BYTES, item.value.length),
            );
        }
        if (advertisedSize !== null && total !== advertisedSize) fail('OUTPUT_MISSING');
      } catch (error) {
        try {
          await reader.cancel(error);
        } catch {
          // Preserve the stable validation or cancellation error.
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        reader.releaseLock();
      }
    },
    async cancel(reason?: unknown) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Best-effort release of the provider response stream.
      }
    },
  };
  return { mimeType, advertisedSize, source };
}

export interface MultipartBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  isVerified(): boolean;
  failure(): unknown;
}

export function multipartImageBody(
  source: GenerationBinarySource,
  mimeType: string,
  expectedSize: number,
  expectedHash: string,
  maxBytes: number,
  boundary: string,
): MultipartBody {
  const extension = extensionForMime(mimeType).slice(1);
  if (!['png', 'jpg'].includes(extension)) fail('UNSUPPORTED_MEDIA_TYPE');
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    '--' +
      boundary +
      '\r\nContent-Disposition: form-data; name="file"; filename="input.' +
      extension +
      '"\r\nContent-Type: ' +
      canonicalMime(mimeType) +
      '\r\n\r\n',
  );
  const suffix = encoder.encode('\r\n--' + boundary + '--\r\n');
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let started = false;
  let verified = false;
  let total = 0;
  let streamFailure: unknown = null;
  let digest: ReturnType<typeof createHash> | null = null;
  const body = new ReadableStream<Uint8Array>({
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
        if (!isByteChunk(chunk) || chunk.byteLength > MAX_PROVIDER_CHUNK_BYTES)
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
          // Preserve the stable validation error.
        }
        try {
          await source.cancel(error);
        } catch {
          // Best-effort release.
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      streamFailure = reason;
      try {
        await iterator?.return?.();
      } catch {
        // Best-effort release.
      }
      await source.cancel(reason);
    },
  });
  return {
    body,
    contentType: 'multipart/form-data; boundary=' + boundary,
    isVerified: () => verified,
    failure: () => streamFailure,
  };
}

export function validateCachedMedia(
  value: unknown,
  allowedMimeTypes: readonly string[],
  maxBytes: number,
  fallbackMimeType?: string,
): { sizeBytes: number; contentHash: string; source: GenerationBinarySource; mimeType: string } {
  if (!isRecord(value)) fail('OUTPUT_MISSING');
  const sizeBytes = value.sizeBytes;
  const contentHash = value.contentHash;
  const source = value.source;
  const rawMimeType = (value as Record<string, unknown>).mimeType;
  const mimeType = canonicalMime(
    typeof rawMimeType === 'string' ? rawMimeType : (fallbackMimeType ?? ''),
  );
  if (
    !positiveSafeInteger(sizeBytes) ||
    sizeBytes > maxBytes ||
    !safeSha256(contentHash) ||
    contentHash !== contentHash.toLowerCase() ||
    !source ||
    typeof source !== 'object' ||
    typeof (source as GenerationBinarySource).open !== 'function' ||
    !allowedMimeTypes.map(canonicalMime).includes(mimeType)
  )
    fail('OUTPUT_MISSING');
  return {
    sizeBytes,
    contentHash,
    source: source as GenerationBinarySource,
    mimeType,
  };
}

export function safeOutputMetadata(value: Record<string, unknown>): Record<string, number> {
  const metadata: Record<string, number> = {};
  for (const [sourceKey, targetKey] of [
    ['duration', 'durationSeconds'],
    ['duration_seconds', 'durationSeconds'],
    ['width', 'width'],
    ['height', 'height'],
    ['fps', 'fps'],
  ] as const) {
    const number = value[sourceKey];
    if (typeof number === 'number' && Number.isFinite(number) && number > 0 && number <= 1_000_000)
      metadata[targetKey] = number;
  }
  return metadata;
}

export type CommercialSubmissionDecision =
  | {
      kind: 'SUBMITTED';
      providerJobId: string;
      status: 'QUEUED' | 'RUNNING';
      persistedBody?: string;
    }
  | { kind: 'REJECTED'; errorCode: GenerationSubmissionRejectionCode }
  | { kind: 'UNKNOWN' };

export interface CommercialOutputSource {
  id: string;
  url: string;
  metadata?: Record<string, unknown>;
}

export interface CommercialGatewayConfig {
  provider: CommercialProvider;
  descriptor(runtime: GenerationProviderRuntime): GenerationModelDescriptor;
  verifyDescriptor?(
    runtime: GenerationProviderRuntime,
    descriptor: GenerationModelDescriptor,
    fetchJson: (
      runtime: GenerationProviderRuntime,
      path: string,
    ) => Promise<{ response: Response; payload: unknown | null }>,
  ): Promise<void>;
  endpoint(runtime: GenerationProviderRuntime): string;
  prepare(
    runtime: GenerationProviderRuntime,
    request: ProviderGenerationRequest,
    descriptor: GenerationModelDescriptor,
    uploadImage: CommercialImageUploader,
  ): Promise<{ body: Record<string, unknown>; uploadedFiles: GenerationUploadedInput[] }>;
  verifyPrepared(
    body: Record<string, unknown>,
    state: GenerationProviderSubmissionFact,
    request: ProviderGenerationRequest,
  ): boolean;
  submission(
    runtime: GenerationProviderRuntime,
    request: ProviderGenerationRequest,
    response: Response,
    payload: unknown | null,
    state: GenerationProviderSubmissionFact,
  ): CommercialSubmissionDecision;
  query(
    runtime: GenerationProviderRuntime,
    providerJobId: string,
    state: GenerationProviderSubmissionFact | null,
    fetchJson: (
      runtime: GenerationProviderRuntime,
      path: string,
    ) => Promise<{ response: Response; payload: unknown | null }>,
  ): Promise<{
    status: ProviderGenerationJob['status'];
    outputs: CommercialOutputSource[];
    errorCode: string | null;
  }>;
}

export type CommercialImageUploader = (
  runtime: GenerationProviderRuntime,
  input: ProviderGenerationRequest['inputs'][number],
  maxBytes: number,
) => Promise<{ identity: GenerationUploadedInput; url: string }>;

const KNOWN_FEATURES = new Set([
  'TEXT_TO_IMAGE',
  'TEXT_TO_VIDEO',
  'TEXT_TO_MUSIC',
  'REFERENCE_CONDITIONING',
  'FIRST_FRAME_CONDITIONING',
]);
const ROLE_FEATURE: Record<string, string> = {
  REFERENCE_IMAGE: 'REFERENCE_CONDITIONING',
  FIRST_FRAME: 'FIRST_FRAME_CONDITIONING',
  LAST_FRAME: 'FIRST_FRAME_CONDITIONING',
};
const MAX_REQUEST_JSON_BYTES = 32 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** Common durable billable-submission barrier and cache-backed GenerationGateway behavior. */
export class CommercialGenerationGateway implements GenerationGateway {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly testOnly: boolean;
  private readonly active = new Map<string, Promise<GenerationSubmission>>();

  constructor(
    private readonly resolveRuntime: GenerationRuntimeResolver,
    private readonly stateStore: GenerationProviderStatePort,
    private readonly outputCache: GenerationProviderMediaCache,
    private readonly config: CommercialGatewayConfig,
    options: GenerationProviderHttpOptions = {},
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.testOnly = options.testOnly === true;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 100 ||
      this.requestTimeoutMs > 10 * 60_000
    )
      fail('INVALID_INPUT');
  }

  async getDescriptor(runtimeProfileId: string): Promise<GenerationModelDescriptor> {
    const runtime = await this.runtime(runtimeProfileId);
    const descriptor = this.config.descriptor(runtime);
    await this.config.verifyDescriptor?.(runtime, descriptor, (providerRuntime, path) =>
      this.fetchProviderJson(providerRuntime, path),
    );
    return descriptor;
  }

  submit(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const key = runtimeProfileId + '\u0000' + request.idempotencyKey;
    const active = this.active.get(key);
    if (active) return active;
    const submission = this.submitOnce(runtimeProfileId, request).finally(() => {
      this.active.delete(key);
    });
    this.active.set(key, submission);
    return submission;
  }

  async getJob(runtimeProfileId: string, providerJobId: string): Promise<ProviderGenerationJob> {
    if (!safeProviderId(providerJobId)) fail('OUTPUT_MISSING');
    const runtime = await this.runtime(runtimeProfileId);
    const descriptor = this.config.descriptor(runtime);
    const localState = await this.stateForJob(runtimeProfileId, providerJobId, runtime);
    const job = await this.config.query(
      runtime,
      providerJobId,
      localState,
      (providerRuntime, path) => this.fetchProviderJson(providerRuntime, path),
    );
    if (job.status !== 'COMPLETED')
      return { providerJobId, status: job.status, outputs: [], errorCode: job.errorCode };
    if (
      !job.outputs.length ||
      job.outputs.length > descriptor.limits.maxOutputs ||
      new Set(job.outputs.map((output) => output.id)).size !== job.outputs.length
    )
      fail('OUTPUT_MISSING');

    const outputs = await this.cacheOutputs(
      runtimeProfileId,
      providerJobId,
      job.outputs,
      descriptor,
    );
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
    if (cached) {
      const descriptor = await this.getDescriptor(runtimeProfileId);
      return validateCachedMedia(
        cached,
        descriptor.outputTypes,
        descriptor.limits.maxOutputBytes,
        descriptor.outputTypes.length === 1 ? descriptor.outputTypes[0] : undefined,
      ).source;
    }
    const job = await this.getJob(runtimeProfileId, providerJobId);
    if (job.status !== 'COMPLETED' || !job.outputs.some((output) => output.id === outputId))
      fail('OUTPUT_MISSING');
    const captured = await this.outputCache.lookup(runtimeProfileId, providerJobId, outputId);
    if (!captured) fail('OUTPUT_MISSING');
    const descriptor = await this.getDescriptor(runtimeProfileId);
    return validateCachedMedia(
      captured,
      descriptor.outputTypes,
      descriptor.limits.maxOutputBytes,
      descriptor.outputTypes.length === 1 ? descriptor.outputTypes[0] : undefined,
    ).source;
  }

  private async submitOnce(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const runtime = await this.runtime(runtimeProfileId);
    if (
      !safeIdempotencyKey(request.idempotencyKey) ||
      !safeFingerprint(request.fingerprint) ||
      request.modelId !== runtime.modelId
    )
      fail('INVALID_INPUT');
    const descriptor = this.config.descriptor(runtime);
    this.validateRequest(request, descriptor);
    const semantic = semanticFingerprint(request);
    let state = await this.stateStore.get(runtimeProfileId, request.idempotencyKey);
    if (state) {
      if (
        state.runtimeId !== runtimeProfileId ||
        state.key !== request.idempotencyKey ||
        state.requestFingerprint !== request.fingerprint ||
        state.semanticFingerprint !== semantic
      )
        fail('IDEMPOTENCY_CONFLICT');
      if (state.phase === 'SUBMITTED') {
        if (!safeProviderId(state.providerJobId)) return { outcome: 'UNKNOWN' };
        const syncResult = parseJsonRecord(state.exactBody);
        return {
          outcome: 'SUBMITTED',
          providerJobId: state.providerJobId,
          status: syncResult?.localSyncResult === true ? 'RUNNING' : 'QUEUED',
        };
      }
      if (state.phase === 'REJECTED') {
        if (!isRejectionCode(state.errorCode)) return { outcome: 'UNKNOWN' };
        return { outcome: 'REJECTED', errorCode: state.errorCode };
      }
      if (state.phase === 'SUBMITTING' || state.phase === 'UNKNOWN') {
        if (state.phase === 'SUBMITTING') {
          try {
            await this.stateStore.put({ ...state, phase: 'UNKNOWN', providerJobId: null });
          } catch {
            // Keeping SUBMITTING still prevents a repeated billable POST.
          }
        }
        return { outcome: 'UNKNOWN' };
      }
      if (state.phase !== 'PREPARED') fail('INTERNAL_ERROR');
      const body = parseJsonRecord(state.exactBody);
      if (!body || !this.config.verifyPrepared(body, state, request)) fail('INTERNAL_ERROR');
    } else {
      const prepared = await this.config.prepare(
        runtime,
        request,
        descriptor,
        (uploadRuntime, input, maxBytes) => this.uploadImage(uploadRuntime, input, maxBytes),
      );
      const exactBody = JSON.stringify(prepared.body);
      if (new TextEncoder().encode(exactBody).byteLength > MAX_REQUEST_JSON_BYTES)
        fail('INPUT_TOO_LARGE');
      state = {
        runtimeId: runtimeProfileId,
        key: request.idempotencyKey,
        requestFingerprint: request.fingerprint,
        semanticFingerprint: semantic,
        uploadedFiles: prepared.uploadedFiles,
        exactBody,
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
      response = await this.fetchImplementation(
        providerApiUrl(runtime, this.config.endpoint(runtime)),
        {
          method: 'POST',
          headers: this.authHeaders(runtime, true),
          body: state.exactBody,
          redirect: 'error',
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
    } catch {
      await this.markUnknown(state);
      return { outcome: 'UNKNOWN' };
    }
    if (!this.isExpectedApiResponse(runtime, response)) {
      await response.body?.cancel();
      await this.markUnknown(state);
      return { outcome: 'UNKNOWN' };
    }
    const payload = await readBoundedJson(response);
    const decision = this.config.submission(runtime, request, response, payload, state);
    if (decision.kind === 'REJECTED') {
      try {
        await this.stateStore.put({
          ...state,
          phase: 'REJECTED',
          providerJobId: null,
          errorCode: decision.errorCode,
        });
      } catch {
        return { outcome: 'UNKNOWN' };
      }
      return { outcome: 'REJECTED', errorCode: decision.errorCode };
    }
    if (decision.kind === 'UNKNOWN') {
      await this.markUnknown(state);
      return { outcome: 'UNKNOWN' };
    }
    if (!safeProviderId(decision.providerJobId)) {
      await this.markUnknown(state);
      return { outcome: 'UNKNOWN' };
    }
    try {
      await this.stateStore.put({
        ...state,
        phase: 'SUBMITTED',
        providerJobId: decision.providerJobId,
        exactBody: decision.persistedBody ?? state.exactBody,
      });
    } catch {
      fail('SUBMISSION_STATE_UNKNOWN');
    }
    return {
      outcome: 'SUBMITTED',
      providerJobId: decision.providerJobId,
      status: decision.status,
    };
  }

  protected async fetchProviderJson(
    runtime: GenerationProviderRuntime,
    path: string,
  ): Promise<{ response: Response; payload: unknown | null }> {
    const result = await fetchJson(
      this.fetchImplementation,
      providerApiUrl(runtime, path),
      { method: 'GET', headers: this.authHeaders(runtime, false) },
      this.requestTimeoutMs,
    );
    if (!this.isExpectedApiResponse(runtime, result.response)) {
      await result.response.body?.cancel();
      throw new GenerationCrash(
        'Provider response origin changed; the generation job is retained.',
      );
    }
    return result;
  }

  protected async cacheOutputs(
    runtimeProfileId: string,
    providerJobId: string,
    outputs: CommercialOutputSource[],
    descriptor: GenerationModelDescriptor,
  ): Promise<GenerationOutputDescriptor[]> {
    const result: GenerationOutputDescriptor[] = [];
    for (const output of outputs) {
      let cached = await this.outputCache.lookup(runtimeProfileId, providerJobId, output.id);
      if (cached) {
        const media = validateCachedMedia(
          cached,
          descriptor.outputTypes,
          descriptor.limits.maxOutputBytes,
          descriptor.outputTypes.length === 1 ? descriptor.outputTypes[0] : undefined,
        );
        cached = { ...cached, mimeType: media.mimeType } as GenerationCachedMedia;
      } else {
        const opened = await openRemoteMedia(
          this.fetchImplementation,
          output.url,
          this.config.provider,
          this.testOnly,
          descriptor.outputTypes,
          descriptor.limits.maxOutputBytes,
          this.requestTimeoutMs,
        );
        try {
          cached = await this.outputCache.capture({
            runtimeProfileId,
            providerJobId,
            outputId: output.id,
            mimeType: opened.mimeType,
            advertisedSize: opened.advertisedSize,
            source: opened.source,
          });
        } catch (error) {
          if (error instanceof GenerationCrash) throw error;
          if (
            error instanceof DomainError &&
            [
              'UNSUPPORTED_MEDIA_TYPE',
              'OUTPUT_TOO_LARGE',
              'OUTPUT_MISSING',
              'ARTIFACT_INTEGRITY',
            ].includes(error.code)
          )
            throw error;
          throw new GenerationCrash(
            'Provider output capture was interrupted; the job is retained.',
          );
        }
        cached = { ...cached, mimeType: opened.mimeType } as GenerationCachedMedia;
      }
      const media = validateCachedMedia(
        cached,
        descriptor.outputTypes,
        descriptor.limits.maxOutputBytes,
        descriptor.outputTypes.length === 1 ? descriptor.outputTypes[0] : undefined,
      );
      result.push({
        id: output.id,
        mimeType: media.mimeType,
        extension: extensionForMime(media.mimeType),
        sizeBytes: media.sizeBytes,
        contentHash: media.contentHash,
        metadata: safeOutputMetadata(output.metadata ?? {}),
      });
    }
    return result;
  }

  protected async stateForJob(
    runtimeProfileId: string,
    providerJobId: string,
    runtime: GenerationProviderRuntime,
  ): Promise<GenerationProviderSubmissionFact | null> {
    // Synchronous TokenRhythm image jobs use the logical Generation id as their local job id.
    if (
      this.config.provider !== 'TOKENRHYTHM' ||
      !['qwen-image-2.0', 'wan2.7-image'].includes(runtime.modelId)
    )
      return null;
    const state = await this.stateStore.get(runtimeProfileId, providerJobId);
    if (!state || state.phase !== 'SUBMITTED' || state.providerJobId !== providerJobId) return null;
    return state;
  }

  protected outputCountAllowed(count: number, descriptor: GenerationModelDescriptor): boolean {
    return Number.isSafeInteger(count) && count > 0 && count <= descriptor.limits.maxOutputs;
  }

  private validateRequest(
    request: ProviderGenerationRequest,
    descriptor: GenerationModelDescriptor,
  ): void {
    if (
      request.modelId !== descriptor.modelId ||
      request.requiredFeatures.length > 24 ||
      new Set(request.requiredFeatures).size !== request.requiredFeatures.length
    )
      fail('INVALID_INPUT');
    if (request.capability !== descriptor.outputCapability) fail('UNSUPPORTED_FEATURE');
    const features = new Set(descriptor.featureTags);
    for (const feature of request.requiredFeatures) {
      if (!KNOWN_FEATURES.has(feature) || !features.has(feature)) fail('UNSUPPORTED_FEATURE');
    }
    if (!boundedString(request.prompt, 12_000) || !request.prompt.trim()) fail('INVALID_INPUT');
    if (
      !Array.isArray(request.inputs) ||
      request.inputs.length > descriptor.limits.maxInputFiles ||
      request.inputs.length > 16
    )
      fail('INPUT_TOO_LARGE');
    let inputBytes = 0;
    for (const input of request.inputs) {
      if (!boundedString(input.artifactId, 256) || !boundedString(input.role, 64))
        fail('INVALID_INPUT');
      const role = descriptor.inputRoles.find((candidate) => candidate.role === input.role);
      if (!role) fail('UNSUPPORTED_INPUT_ROLE');
      const roleFeature = ROLE_FEATURE[input.role];
      if (
        roleFeature &&
        (!features.has(roleFeature) || !request.requiredFeatures.includes(roleFeature))
      )
        fail('UNSUPPORTED_FEATURE');
      if (
        request.inputs.filter((candidate) => candidate.role === input.role).length >
          role.maxFiles ||
        !role.artifactKinds.includes(input.kind) ||
        !role.mimeTypes.includes(canonicalMime(input.mimeType))
      )
        fail('UNSUPPORTED_MEDIA_TYPE');
      if (
        !positiveSafeInteger(input.sizeBytes) ||
        !safeSha256(input.contentHash) ||
        !input.source ||
        typeof input.source.open !== 'function' ||
        typeof input.source.cancel !== 'function'
      )
        fail('INVALID_INPUT');
      inputBytes += input.sizeBytes;
      if (!Number.isSafeInteger(inputBytes) || inputBytes > descriptor.limits.maxInputBytes)
        fail('INPUT_TOO_LARGE');
    }
    let encodedParameters: string;
    try {
      encodedParameters = JSON.stringify(request.parameters);
    } catch {
      fail('INVALID_INPUT');
    }
    if (new TextEncoder().encode(encodedParameters!).byteLength > 8 * 1024) fail('INVALID_INPUT');
    const ajv = new Ajv({ allErrors: false, schemaId: 'auto', jsonPointers: true });
    if (!ajv.validate(descriptor.parameterSchema, request.parameters)) fail('INVALID_INPUT');
  }

  private authHeaders(runtime: GenerationProviderRuntime, jsonBody: boolean): Headers {
    const headers = new Headers({ accept: 'application/json' });
    headers.set('authorization', 'Bearer ' + runtime.apiKey);
    if (jsonBody) headers.set('content-type', 'application/json');
    return headers;
  }

  private async uploadImage(
    runtime: GenerationProviderRuntime,
    input: ProviderGenerationRequest['inputs'][number],
    maxBytes: number,
  ): Promise<{ identity: GenerationUploadedInput; url: string }> {
    const mimeType = canonicalMime(input.mimeType);
    if (
      !['image/png', 'image/jpeg'].includes(mimeType) ||
      !positiveSafeInteger(input.sizeBytes) ||
      input.sizeBytes > maxBytes ||
      !safeSha256(input.contentHash) ||
      !input.source ||
      typeof input.source.open !== 'function'
    )
      fail('UNSUPPORTED_MEDIA_TYPE');
    const boundary = 'commercial-' + sha256(input.artifactId).slice(0, 32);
    const multipart = multipartImageBody(
      input.source,
      mimeType,
      input.sizeBytes,
      input.contentHash,
      maxBytes,
      boundary,
    );
    const headers = this.authHeaders(runtime, false);
    headers.set('content-type', multipart.contentType);
    let response: Response;
    try {
      response = await this.fetchImplementation(providerApiUrl(runtime, '/uploads/images'), {
        method: 'POST',
        headers,
        body: multipart.body,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(5 * 60_000, Math.max(this.requestTimeoutMs, 60_000))),
        duplex: 'half',
      } as RequestInit);
    } catch {
      const streamFailure = multipart.failure();
      if (streamFailure instanceof DomainError) throw streamFailure;
      throw new GenerationCrash(
        'Provider image upload was interrupted; the generation job is retained.',
      );
    }
    if (!this.isExpectedApiResponse(runtime, response)) {
      await response.body?.cancel();
      fail('OUTPUT_MISSING');
    }
    if (!multipart.isVerified()) {
      const streamFailure = multipart.failure();
      if (streamFailure instanceof DomainError) throw streamFailure;
      fail('INVALID_INPUT');
    }
    const payload = await readBoundedJson(response);
    if (!response.ok) {
      if (response.status === 413) fail('INPUT_TOO_LARGE');
      if (response.status >= 500 || response.status === 408 || response.status === 429)
        throw new GenerationCrash(
          'Provider image upload was interrupted; the generation job is retained.',
        );
      fail(statusErrorCode(response.status, 'MODEL_UNAVAILABLE'));
    }
    const result = isRecord(payload) ? payload : null;
    const url = typeof result?.url === 'string' ? result.url : '';
    const safeUrl = isAllowedProviderUrl(url, this.config.provider, this.testOnly);
    if (
      !safeUrl ||
      canonicalMime(typeof result?.content_type === 'string' ? result.content_type : '') !==
        mimeType ||
      result?.bytes !== input.sizeBytes
    )
      fail('INTERNAL_ERROR');
    return {
      identity: {
        artifactId: input.artifactId,
        role: input.role,
        fileId: sha256(safeUrl.toString()),
        mimeType,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash.toLowerCase(),
      },
      url: safeUrl.toString(),
    };
  }

  private isExpectedApiResponse(runtime: GenerationProviderRuntime, response: Response): boolean {
    if (response.redirected) return false;
    if (!response.url) return true;
    try {
      return new URL(response.url).origin === new URL(runtime.baseUrl).origin;
    } catch {
      return false;
    }
  }

  private async markUnknown(state: GenerationProviderSubmissionFact): Promise<void> {
    try {
      await this.stateStore.put({ ...state, phase: 'UNKNOWN', providerJobId: null });
    } catch {
      // Durable SUBMITTING still blocks another billable request.
    }
  }

  private async runtime(runtimeProfileId: string): Promise<GenerationProviderRuntime> {
    let resolved: GenerationProviderRuntime | null;
    try {
      resolved = await this.resolveRuntime(runtimeProfileId);
    } catch {
      fail('MODEL_UNAVAILABLE');
    }
    return validateRuntime(resolved, this.config.provider, this.testOnly);
  }
}

export function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRejectionCode(value: unknown): value is GenerationSubmissionRejectionCode {
  return (
    value === 'AUTH_FAILED' ||
    value === 'MODEL_NOT_FOUND' ||
    value === 'INVALID_INPUT' ||
    value === 'UNSUPPORTED_FEATURE' ||
    value === 'UNSUPPORTED_INPUT_ROLE' ||
    value === 'MODEL_DURATION_LIMIT' ||
    value === 'QUEUE_FULL' ||
    value === 'IDEMPOTENCY_CONFLICT'
  );
}

function mappedProviderErrorType(value: unknown): GenerationSubmissionRejection | null {
  switch (value) {
    case 'invalid_request_error':
      return 'INVALID_INPUT';
    case 'authentication_error':
    case 'payment_required':
    case 'permission_error':
      return 'AUTH_FAILED';
    case 'rate_limit_error':
      return 'QUEUE_FULL';
    default:
      return null;
  }
}

export function decisionFromHttpError(
  status: number,
  payload: unknown,
): CommercialSubmissionDecision | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const rejection = isRejectionCode(payload.error.code)
    ? payload.error.code
    : mappedProviderErrorType(payload.error.type);
  if (!isRejectionCode(rejection)) return null;

  const compatibleStatus =
    ((status === 400 || status === 422) &&
      (rejection === 'INVALID_INPUT' ||
        rejection === 'UNSUPPORTED_FEATURE' ||
        rejection === 'UNSUPPORTED_INPUT_ROLE' ||
        rejection === 'MODEL_DURATION_LIMIT')) ||
    ((status === 401 || status === 402 || status === 403) && rejection === 'AUTH_FAILED') ||
    (status === 404 && rejection === 'MODEL_NOT_FOUND') ||
    (status === 409 && rejection === 'IDEMPOTENCY_CONFLICT') ||
    (status === 429 && rejection === 'QUEUE_FULL');
  return compatibleStatus ? { kind: 'REJECTED', errorCode: rejection } : null;
}

export function outputIdForUrl(index: number, url: string): string {
  return 'out-' + index.toString(10) + '-' + sha256(url).slice(0, 20);
}

export function providerStatus(value: unknown): ProviderGenerationJob['status'] {
  switch (value) {
    case 'queued':
    case 'pending':
    case 'submitted':
      return 'QUEUED';
    case 'running':
    case 'processing':
      return 'RUNNING';
    case 'completed':
    case 'complete':
    case 'success':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}
