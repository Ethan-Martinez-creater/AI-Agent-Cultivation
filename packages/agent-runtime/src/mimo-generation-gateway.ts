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
import type {
  GenerationCachedMedia,
  GenerationProviderMediaCache,
  GenerationProviderRuntime,
  GenerationProviderStatePort,
  GenerationProviderSubmissionFact,
  GenerationRuntimeResolver,
  GenerationProviderHttpOptions,
} from './generation-provider-ports.js';

export const MIMO_TTS_VOICES = [
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
  'mimo_default',
] as const;

const MODEL_ID = 'mimo-v2.5-tts';
const BASE_URL = 'https://api.xiaomimimo.com/v1';
const AUDIO_MIME_TYPE = 'audio/wav';
const OUTPUT_ID = 'audio';
const MiB = 1024 * 1024;
const MAX_PROMPT_BYTES = 4 * 1024;
/** Short V1 TTS is deliberately much smaller than the shared 1 GiB audio ceiling. */
const MAX_OUTPUT_BYTES = 16 * MiB;
const MAX_MODEL_LIST_RESPONSE_BYTES = 64 * 1024;
const JSON_ENVELOPE_BYTES = 64 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_OUTPUT_BYTES / 3) * 4;
const MAX_RESPONSE_BYTES = MAX_BASE64_CHARS + JSON_ENVELOPE_BYTES;
const BASE64_CHUNK_CHARS = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_ID_PATTERN = /^mimo_v1_[a-f0-9]{64}$/;
const DEFINITIVE_REJECTIONS = new Set<GenerationSubmissionRejectionCode>([
  'AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'INVALID_INPUT',
  'QUEUE_FULL',
]);
const SAFE_MESSAGES: Record<string, string> = {
  AUTH_FAILED: 'MiMo authentication failed.',
  MODEL_NOT_FOUND: 'The configured MiMo TTS model was not found.',
  INVALID_INPUT: 'The MiMo TTS request is invalid.',
  QUEUE_FULL: 'MiMo is temporarily unable to accept this request.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was used for a different request.',
  SUBMISSION_STATE_UNKNOWN: 'MiMo submission state is unknown and will not be retried.',
  OUTPUT_MISSING: 'The MiMo TTS output is unavailable.',
  INTERNAL_ERROR: 'The MiMo adapter received an invalid response.',
  RUNTIME_UNAVAILABLE: 'The MiMo runtime is unavailable.',
};

type MimoErrorCode = keyof typeof SAFE_MESSAGES;

function fail(code: MimoErrorCode): never {
  throw new DomainError(code, SAFE_MESSAGES[code]!);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalBaseUrl(raw: string): string {
  if (!raw || raw.length > 512 || raw.trim() !== raw) fail('RUNTIME_UNAVAILABLE');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('RUNTIME_UNAVAILABLE');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'api.xiaomimimo.com' ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== '/v1' && url.pathname !== '/v1/') ||
    url.search ||
    url.hash
  )
    fail('RUNTIME_UNAVAILABLE');
  return BASE_URL;
}

function assertRuntime(runtime: GenerationProviderRuntime | null): GenerationProviderRuntime {
  if (
    !runtime ||
    runtime.modelId !== MODEL_ID ||
    typeof runtime.apiKey !== 'string' ||
    runtime.apiKey.length < 1 ||
    runtime.apiKey.length > 4096 ||
    /[\r\n]/.test(runtime.apiKey) ||
    typeof runtime.baseUrl !== 'string'
  )
    fail('RUNTIME_UNAVAILABLE');
  return { ...runtime, baseUrl: canonicalBaseUrl(runtime.baseUrl) };
}

function runtimeHeaders(runtime: GenerationProviderRuntime): Headers {
  return new Headers({
    accept: 'application/json',
    authorization: 'Bearer ' + runtime.apiKey,
    'content-type': 'application/json',
  });
}

function isModelList(value: unknown): boolean {
  const payload = asRecord(value);
  if (payload?.object !== 'list' || !Array.isArray(payload.data)) return false;
  return payload.data.every((item) => {
    const model = asRecord(item);
    return typeof model?.id === 'string' && model.id.length > 0 && model.id.length <= 256;
  });
}

function safeProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID_PATTERN.test(value);
}

function localProviderId(runtimeId: string, key: string, fingerprint: string): string {
  const digest = createHash('sha256')
    .update(runtimeId)
    .update('\u0000')
    .update(key)
    .update('\u0000')
    .update(fingerprint)
    .digest('hex');
  return 'mimo_v1_' + digest;
}

function requestSemanticFingerprint(request: ProviderGenerationRequest): string {
  return sha256(
    JSON.stringify({
      modelId: request.modelId,
      capability: request.capability,
      requiredFeatures: request.requiredFeatures,
      prompt: request.prompt,
      parameters: { voice: request.parameters.voice },
      inputs: [],
    }),
  );
}

function validateRequest(request: ProviderGenerationRequest): string {
  if (
    !request ||
    !SAFE_KEY_PATTERN.test(request.idempotencyKey) ||
    !SHA256_PATTERN.test(request.fingerprint) ||
    request.modelId !== MODEL_ID ||
    request.capability !== 'SPEECH_GENERATION' ||
    !Array.isArray(request.requiredFeatures) ||
    request.requiredFeatures.length !== 0 ||
    !Array.isArray(request.inputs) ||
    request.inputs.length !== 0 ||
    typeof request.prompt !== 'string' ||
    request.prompt.trim().length === 0 ||
    /[\u0000]/.test(request.prompt) ||
    utf8Size(request.prompt) > MAX_PROMPT_BYTES
  )
    fail('INVALID_INPUT');

  const parameters = asRecord(request.parameters);
  if (
    !parameters ||
    Object.keys(parameters).length !== 1 ||
    Object.keys(parameters)[0] !== 'voice' ||
    typeof parameters.voice !== 'string' ||
    !MIMO_TTS_VOICES.includes(parameters.voice as (typeof MIMO_TTS_VOICES)[number])
  )
    fail('INVALID_INPUT');

  return requestSemanticFingerprint(request);
}

function submissionBody(request: ProviderGenerationRequest): string {
  return JSON.stringify({
    model: MODEL_ID,
    messages: [{ role: 'assistant', content: request.prompt }],
    audio: { format: 'wav', voice: request.parameters.voice },
  });
}

function stateMatchesRequest(
  state: GenerationProviderSubmissionFact,
  runtimeId: string,
  request: ProviderGenerationRequest,
  semanticFingerprint: string,
): boolean {
  return (
    state.runtimeId === runtimeId &&
    state.key === request.idempotencyKey &&
    state.requestFingerprint === request.fingerprint &&
    state.semanticFingerprint === semanticFingerprint
  );
}

function parseDefinitiveRejection(status: number): GenerationSubmissionRejectionCode | null {
  if (status === 400) return 'INVALID_INPUT';
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 429) return 'QUEUE_FULL';
  return null;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort; no response body is included in user-visible errors.
  }
}

async function readBoundedJson(
  response: Response,
  maximumBytes = MAX_RESPONSE_BYTES,
): Promise<unknown | null> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    await discardResponseBody(response);
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join('')) as unknown;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Best effort; malformed or interrupted output remains UNKNOWN.
    }
    return null;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Best effort resource release.
      }
    }
    reader.releaseLock();
  }
}

function decodeLength(base64: string): number | null {
  if (
    base64.length === 0 ||
    base64.length > MAX_BASE64_CHARS ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedBytes = (base64.length / 4) * 3 - padding;
  return decodedBytes <= MAX_OUTPUT_BYTES ? decodedBytes : null;
}

function hasWaveHeader(base64: string): boolean {
  const header = Buffer.from(base64.slice(0, 16), 'base64');
  return (
    header.byteLength >= 12 &&
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WAVE'
  );
}

function audioDataFromResponse(payload: unknown): string | null {
  const choiceList = asRecord(payload)?.choices;
  const choice =
    Array.isArray(choiceList) && choiceList.length === 1 ? asRecord(choiceList[0]) : null;
  const message = asRecord(choice?.message);
  const audio = asRecord(message?.audio);
  return typeof audio?.data === 'string' ? audio.data : null;
}

interface DecodedAudioSource {
  source: GenerationBinarySource;
  completed(): boolean;
  sizeBytes(): number;
  contentHash(): string | null;
}

function decodedAudioSource(base64Input: string, expectedBytes: number): DecodedAudioSource {
  let base64: string | null = base64Input;
  let opened = false;
  let cancelled = false;
  let complete = false;
  let totalBytes = 0;
  let digest: string | null = null;
  const hash = createHash('sha256');

  const source: GenerationBinarySource = {
    open(signal?: AbortSignal): AsyncIterable<Uint8Array> {
      if (opened || cancelled || base64 === null)
        throw new DomainError('OUTPUT_MISSING', SAFE_MESSAGES.OUTPUT_MISSING!);
      opened = true;
      return (async function* () {
        try {
          for (
            let offset = 0;
            base64 !== null && offset < base64.length;
            offset += BASE64_CHUNK_CHARS
          ) {
            if (signal?.aborted) {
              const error = new Error('The operation was aborted.');
              error.name = 'AbortError';
              throw error;
            }
            const end = Math.min(offset + BASE64_CHUNK_CHARS, base64.length);
            const bytes = Buffer.from(base64.slice(offset, end), 'base64');
            totalBytes += bytes.byteLength;
            if (totalBytes > expectedBytes || totalBytes > MAX_OUTPUT_BYTES)
              throw new DomainError('OUTPUT_TOO_LARGE', SAFE_MESSAGES.OUTPUT_MISSING!);
            hash.update(bytes);
            yield bytes;
          }
          if (totalBytes !== expectedBytes)
            throw new DomainError('ARTIFACT_INTEGRITY', SAFE_MESSAGES.OUTPUT_MISSING!);
          digest = hash.digest('hex');
          complete = true;
        } finally {
          base64 = null;
        }
      })();
    },
    cancel() {
      cancelled = true;
      base64 = null;
    },
  };
  return {
    source,
    completed: () => complete,
    sizeBytes: () => totalBytes,
    contentHash: () => digest,
  };
}

function validCachedAudio(cached: GenerationCachedMedia): boolean {
  const cachedMimeType = (cached as GenerationCachedMedia & { mimeType?: unknown }).mimeType;
  return (
    (cachedMimeType === undefined || cachedMimeType === AUDIO_MIME_TYPE) &&
    Number.isSafeInteger(cached.sizeBytes) &&
    cached.sizeBytes >= 12 &&
    cached.sizeBytes <= MAX_OUTPUT_BYTES &&
    SHA256_PATTERN.test(cached.contentHash) &&
    typeof cached.source?.open === 'function' &&
    typeof cached.source?.cancel === 'function'
  );
}

function outputDescriptor(cached: GenerationCachedMedia): GenerationOutputDescriptor {
  return {
    id: OUTPUT_ID,
    mimeType: AUDIO_MIME_TYPE,
    extension: '.wav',
    sizeBytes: cached.sizeBytes,
    contentHash: cached.contentHash,
    metadata: { provider: 'xiaomimimo', model: MODEL_ID },
  };
}

export class MiMoTtsGateway implements GenerationGateway {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly activeSubmissions = new Map<
    string,
    {
      requestFingerprint: string;
      semanticFingerprint: string;
      promise: Promise<GenerationSubmission>;
    }
  >();

  constructor(
    private readonly resolveRuntime: GenerationRuntimeResolver,
    private readonly statePort: GenerationProviderStatePort,
    private readonly mediaCache: GenerationProviderMediaCache,
    options: GenerationProviderHttpOptions = {},
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.requestTimeoutMs =
      Number.isSafeInteger(timeout) && timeout >= 1_000 && timeout <= 300_000
        ? timeout
        : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async getDescriptor(runtimeProfileId: string): Promise<GenerationModelDescriptor> {
    const runtime = assertRuntime(await this.resolveRuntime(runtimeProfileId));
    let response: Response;
    try {
      response = await this.fetchImplementation(runtime.baseUrl + '/models', {
        method: 'GET',
        headers: runtimeHeaders(runtime),
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      fail('RUNTIME_UNAVAILABLE');
    }

    if (!response.ok) {
      const errorCode = response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : null;
      await discardResponseBody(response);
      fail(errorCode ?? 'RUNTIME_UNAVAILABLE');
    }

    const modelList = await readBoundedJson(response, MAX_MODEL_LIST_RESPONSE_BYTES);
    if (!isModelList(modelList)) fail('RUNTIME_UNAVAILABLE');

    return {
      modelId: runtime.modelId,
      outputCapability: 'SPEECH_GENERATION',
      executionMode: 'SYNC',
      featureTags: [],
      inputRoles: [],
      parameterSchema: {
        type: 'object',
        properties: {
          voice: {
            type: 'string',
            enum: [...MIMO_TTS_VOICES],
            default: '冰糖',
          },
        },
        required: ['voice'],
        additionalProperties: false,
      },
      outputTypes: [AUDIO_MIME_TYPE],
      limits: {
        maxInputFiles: 0,
        maxInputBytes: 0,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        maxOutputs: 1,
      },
    };
  }

  async submit(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const semanticFingerprint = validateRequest(request);
    const lockKey = runtimeProfileId + '\u0000' + request.idempotencyKey;
    const current = this.activeSubmissions.get(lockKey);
    if (current) {
      if (
        current.requestFingerprint !== request.fingerprint ||
        current.semanticFingerprint !== semanticFingerprint
      )
        fail('IDEMPOTENCY_CONFLICT');
      return current.promise;
    }
    const pending = this.submitLocked(runtimeProfileId, request, semanticFingerprint);
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

    let cached: GenerationCachedMedia | null;
    try {
      cached = await this.mediaCache.lookup(runtimeProfileId, providerJobId, OUTPUT_ID);
    } catch {
      throw new GenerationCrash('MiMo cached output lookup was interrupted; provider job retained');
    }
    if (!cached || !validCachedAudio(cached))
      return { providerJobId, status: 'UNKNOWN', outputs: [], errorCode: 'OUTPUT_MISSING' };
    return {
      providerJobId,
      status: 'COMPLETED',
      outputs: [outputDescriptor(cached)],
      errorCode: null,
    };
  }

  async downloadOutput(
    runtimeProfileId: string,
    providerJobId: string,
    outputId: string,
    options?: GenerationOperationOptions,
  ): Promise<GenerationBinarySource> {
    if (!safeProviderId(providerJobId) || outputId !== OUTPUT_ID) fail('OUTPUT_MISSING');
    if (options?.signal?.aborted) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    let cached: GenerationCachedMedia | null;
    try {
      cached = await this.mediaCache.lookup(runtimeProfileId, providerJobId, outputId);
    } catch {
      throw new GenerationCrash('MiMo output cache lookup was interrupted; provider job retained');
    }
    if (!cached || !validCachedAudio(cached)) fail('OUTPUT_MISSING');
    return cached.source;
  }

  private async submitLocked(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
    semanticFingerprint: string,
  ): Promise<GenerationSubmission> {
    let state = await this.statePort.get(runtimeProfileId, request.idempotencyKey);
    if (state) {
      if (!stateMatchesRequest(state, runtimeProfileId, request, semanticFingerprint))
        fail('IDEMPOTENCY_CONFLICT');
      if (state.phase === 'SUBMITTED') {
        if (!safeProviderId(state.providerJobId)) return { outcome: 'UNKNOWN' };
        return { outcome: 'SUBMITTED', providerJobId: state.providerJobId, status: 'RUNNING' };
      }
      if (state.phase === 'REJECTED') {
        if (!state.errorCode || !DEFINITIVE_REJECTIONS.has(state.errorCode))
          return { outcome: 'UNKNOWN' };
        return { outcome: 'REJECTED', errorCode: state.errorCode };
      }
      if (state.phase === 'SUBMITTING' || state.phase === 'UNKNOWN') {
        if (state.phase === 'SUBMITTING') await this.markUnknown(state);
        return { outcome: 'UNKNOWN' };
      }
      const expectedBody = submissionBody(request);
      if (
        state.phase !== 'PREPARED' ||
        state.providerJobId !== null ||
        state.exactBody !== expectedBody ||
        state.uploadedFiles.length !== 0
      )
        fail('INTERNAL_ERROR');
    }

    const runtime = assertRuntime(await this.resolveRuntime(runtimeProfileId));
    const body = submissionBody(request);
    if (!state) {
      state = {
        runtimeId: runtimeProfileId,
        key: request.idempotencyKey,
        requestFingerprint: request.fingerprint,
        semanticFingerprint,
        uploadedFiles: [],
        exactBody: body,
        phase: 'PREPARED',
        providerJobId: null,
        errorCode: null,
      };
      await this.statePort.put(state);
    }

    const submittingState: GenerationProviderSubmissionFact = {
      ...state,
      phase: 'SUBMITTING',
      providerJobId: null,
      errorCode: null,
    };
    await this.statePort.put(submittingState);

    let response: Response;
    try {
      response = await this.fetchImplementation(runtime.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: runtimeHeaders(runtime),
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      await this.markUnknown(submittingState);
      return { outcome: 'UNKNOWN' };
    }

    if (!response.ok) {
      const errorCode = parseDefinitiveRejection(response.status);
      await discardResponseBody(response);
      if (!errorCode) {
        await this.markUnknown(submittingState);
        return { outcome: 'UNKNOWN' };
      }
      try {
        await this.statePort.put({
          ...submittingState,
          phase: 'REJECTED',
          providerJobId: null,
          errorCode,
        });
      } catch {
        return { outcome: 'UNKNOWN' };
      }
      return { outcome: 'REJECTED', errorCode };
    }

    let rawAudio = audioDataFromResponse(await readBoundedJson(response));
    if (rawAudio === null || rawAudio.length > MAX_BASE64_CHARS) {
      await this.markUnknown(submittingState);
      return { outcome: 'UNKNOWN' };
    }

    const decodedBytes = decodeLength(rawAudio);
    if (decodedBytes === null || decodedBytes < 12 || !hasWaveHeader(rawAudio)) {
      await this.markUnknown(submittingState);
      return { outcome: 'UNKNOWN' };
    }

    const decoded = decodedAudioSource(rawAudio, decodedBytes);
    const providerJobId = localProviderId(
      runtimeProfileId,
      request.idempotencyKey,
      request.fingerprint,
    );
    let cached: GenerationCachedMedia;
    try {
      cached = await this.mediaCache.capture({
        runtimeProfileId,
        providerJobId,
        outputId: OUTPUT_ID,
        mimeType: AUDIO_MIME_TYPE,
        advertisedSize: decodedBytes,
        source: decoded.source,
      });
    } catch {
      rawAudio = null;
      await decoded.source.cancel();
      await this.markUnknown(submittingState);
      return { outcome: 'UNKNOWN' };
    }
    rawAudio = null;
    if (
      !decoded.completed() ||
      decoded.sizeBytes() !== decodedBytes ||
      cached.sizeBytes !== decodedBytes ||
      cached.contentHash !== decoded.contentHash() ||
      !validCachedAudio(cached)
    ) {
      await decoded.source.cancel();
      await this.markUnknown(submittingState);
      return { outcome: 'UNKNOWN' };
    }

    try {
      await this.statePort.put({
        ...submittingState,
        phase: 'SUBMITTED',
        providerJobId,
        errorCode: null,
      });
    } catch {
      return { outcome: 'UNKNOWN' };
    }
    return { outcome: 'SUBMITTED', providerJobId, status: 'RUNNING' };
  }

  private async markUnknown(state: GenerationProviderSubmissionFact): Promise<void> {
    try {
      await this.statePort.put({
        ...state,
        phase: 'UNKNOWN',
        providerJobId: null,
        errorCode: null,
      });
    } catch {
      // SUBMITTING remains a durable no-replay barrier if marking UNKNOWN also fails.
    }
  }
}
