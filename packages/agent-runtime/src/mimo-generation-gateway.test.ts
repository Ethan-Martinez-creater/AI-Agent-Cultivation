import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@cultivation/shared';
import type {
  GenerationBinarySource,
  ProviderGenerationRequest,
} from '@cultivation/application/g1-generation';
import type {
  GenerationCachedMedia,
  GenerationProviderSubmissionFact,
} from './generation-provider-ports.js';
import { MIMO_TTS_VOICES, MiMoTtsGateway } from './mimo-generation-gateway.js';

const API_KEY = 'mimo-fixture-secret-do-not-persist';
const RUNTIME_ID = 'runtime-mimo-test';
const MODEL_ID = 'mimo-v2.5-tts';
const ORIGINAL_TEXT = '  你好，世界。请按原文朗读。 \n';

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyOf(runtimeId: string, key: string): string {
  return runtimeId + '\u0000' + key;
}

class MemoryStatePort {
  private readonly values = new Map<string, GenerationProviderSubmissionFact>();
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async get(runtimeId: string, key: string) {
    const value = this.values.get(keyOf(runtimeId, key));
    return value ? structuredClone(value) : null;
  }

  async put(state: GenerationProviderSubmissionFact) {
    this.events.push('state:' + state.phase);
    this.values.set(keyOf(state.runtimeId, state.key), structuredClone(state));
  }
}

function byteSource(bytes: Uint8Array): GenerationBinarySource {
  return {
    async *open(signal?: AbortSignal) {
      for (let offset = 0; offset < bytes.byteLength; offset += 7) {
        if (signal?.aborted) {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          throw error;
        }
        yield bytes.subarray(offset, Math.min(offset + 7, bytes.byteLength));
      }
    },
    cancel() {},
  };
}

class MemoryMediaCache {
  private readonly values = new Map<string, GenerationCachedMedia>();
  readonly events: string[];
  captures = 0;
  lookups = 0;

  constructor(
    events: string[],
    private readonly returnedMimeType = 'audio/wav',
  ) {
    this.events = events;
  }

  async lookup(runtimeId: string, providerJobId: string, outputId: string) {
    this.lookups += 1;
    return this.values.get(runtimeId + '\u0000' + providerJobId + '\u0000' + outputId) ?? null;
  }

  async capture(input: {
    runtimeProfileId: string;
    providerJobId: string;
    outputId: string;
    mimeType: string;
    advertisedSize: number | null;
    source: GenerationBinarySource;
    signal?: AbortSignal;
  }) {
    this.captures += 1;
    this.events.push('cache:capture');
    const chunks: Uint8Array[] = [];
    let sizeBytes = 0;
    const digest = createHash('sha256');
    for await (const chunk of input.source.open(input.signal)) {
      chunks.push(new Uint8Array(chunk));
      sizeBytes += chunk.byteLength;
      digest.update(chunk);
    }
    if (input.advertisedSize !== null && sizeBytes !== input.advertisedSize)
      throw new DomainError('ARTIFACT_INTEGRITY', 'Fixture size mismatch.');
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      sizeBytes,
    );
    const cached: GenerationCachedMedia = {
      sizeBytes,
      contentHash: digest.digest('hex'),
      source: byteSource(bytes),
      mimeType: this.returnedMimeType,
    } as GenerationCachedMedia;
    this.values.set(
      input.runtimeProfileId + '\u0000' + input.providerJobId + '\u0000' + input.outputId,
      cached,
    );
    return cached;
  }
}

function wavBytes(length = 64): Uint8Array {
  const bytes = Buffer.alloc(length);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(length - 44, 40);
  for (let index = 44; index < length; index += 1) bytes[index] = index & 0xff;
  return bytes;
}

function audioResponse(bytes = wavBytes()): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { audio: { data: Buffer.from(bytes).toString('base64') } } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

function modelListResponse(ids = [MODEL_ID]): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: 'xiaomimimo' })),
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

function makeRequest(
  overrides: Partial<ProviderGenerationRequest> = {},
): ProviderGenerationRequest {
  return {
    idempotencyKey: 'task-mimo-001',
    fingerprint: hash('request-mimo-001'),
    modelId: MODEL_ID,
    capability: 'SPEECH_GENERATION',
    requiredFeatures: [],
    prompt: ORIGINAL_TEXT,
    inputs: [],
    parameters: { voice: '冰糖' },
    ...overrides,
  };
}

function createGateway(
  fetchImplementation: typeof globalThis.fetch,
  statePort = new MemoryStatePort(),
  mediaCache = new MemoryMediaCache(statePort.events),
) {
  const gateway = new MiMoTtsGateway(
    async () => ({ baseUrl: 'https://api.xiaomimimo.com/v1', modelId: MODEL_ID, apiKey: API_KEY }),
    statePort,
    mediaCache,
    { fetch: fetchImplementation, requestTimeoutMs: 2_000 },
  );
  return { gateway, statePort, mediaCache };
}

function fakeFetch(
  response: Response | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const implementation = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (response instanceof Response) return response;
    return response(input, init);
  };
  return {
    fetch: vi.fn(implementation) as unknown as typeof globalThis.fetch,
    calls,
  };
}

async function expectDomainCode(action: Promise<unknown>, code: string): Promise<DomainError> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  return caught as DomainError;
}

describe('MiMo TTS GenerationGateway', () => {
  it('exposes only the bounded synchronous WAV speech capability and preset voice parameter', async () => {
    const fetcher = fakeFetch(modelListResponse(['mimo-v2.5-tts-alias']));
    const { gateway } = createGateway(fetcher.fetch);
    const descriptor = await gateway.getDescriptor(RUNTIME_ID);
    expect(descriptor).toMatchObject({
      modelId: MODEL_ID,
      outputCapability: 'SPEECH_GENERATION',
      executionMode: 'SYNC',
      featureTags: [],
      inputRoles: [],
      outputTypes: ['audio/wav'],
      limits: {
        maxInputFiles: 0,
        maxInputBytes: 0,
        maxOutputBytes: 16 * 1024 * 1024,
        maxOutputs: 1,
      },
    });
    expect(descriptor.parameterSchema).toMatchObject({
      properties: { voice: { enum: [...MIMO_TTS_VOICES] } },
      required: ['voice'],
      additionalProperties: false,
    });
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.url).toBe('https://api.xiaomimimo.com/v1/models');
    expect(fetcher.calls[0]?.init?.method).toBe('GET');
    expect(fetcher.calls[0]?.init?.redirect).toBe('error');
    expect(new Headers(fetcher.calls[0]?.init?.headers).get('authorization')).toBe(
      'Bearer ' + API_KEY,
    );
  });

  it('requires an authenticated models check and never probes with billable TTS', async () => {
    const fetcher = fakeFetch(
      new Response('not authorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
    );
    const { gateway } = createGateway(fetcher.fetch);
    const error = await expectDomainCode(gateway.getDescriptor(RUNTIME_ID), 'AUTH_FAILED');
    expect(error.message).not.toContain(API_KEY);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.url).toBe('https://api.xiaomimimo.com/v1/models');
    expect(fetcher.calls.some((call) => call.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('rejects malformed or oversized model discovery responses', async () => {
    const responses = [
      new Response(JSON.stringify({ object: 'list', data: [{ object: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ object: 'list', data: [] }) + ' '.repeat(70 * 1024), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    for (const response of responses) {
      const fetcher = fakeFetch(response);
      const { gateway } = createGateway(fetcher.fetch);
      await expectDomainCode(gateway.getDescriptor(RUNTIME_ID), 'RUNTIME_UNAVAILABLE');
      expect(fetcher.calls.some((call) => call.url.endsWith('/chat/completions'))).toBe(false);
    }
  });

  it.each(MIMO_TTS_VOICES)(
    'submits original assistant text with the preset voice %s',
    async (voice) => {
      const fetcher = fakeFetch(audioResponse());
      const { gateway } = createGateway(fetcher.fetch);
      const result = await gateway.submit(RUNTIME_ID, makeRequest({ parameters: { voice } }));
      expect(result).toMatchObject({ outcome: 'SUBMITTED', status: 'RUNNING' });
      expect(fetcher.calls).toHaveLength(1);
      expect(fetcher.calls[0]?.url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
      const init = fetcher.calls[0]?.init;
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + API_KEY);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: MODEL_ID,
        messages: [{ role: 'assistant', content: ORIGINAL_TEXT }],
        audio: { format: 'wav', voice },
      });
    },
  );

  it('persists PREPARED then SUBMITTING before POST, captures and hashes WAV before SUBMITTED, and recovers from cache after restart', async () => {
    const events: string[] = [];
    const statePort = new MemoryStatePort(events);
    const mediaCache = new MemoryMediaCache(events);
    const fetcher = fakeFetch(async (_input, init) => {
      events.push('fetch');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + API_KEY);
      return audioResponse();
    });
    const first = createGateway(fetcher.fetch, statePort, mediaCache);
    const request = makeRequest();
    const submitted = await first.gateway.submit(RUNTIME_ID, request);
    expect(submitted.outcome).toBe('SUBMITTED');
    if (submitted.outcome !== 'SUBMITTED') throw new Error('Expected submitted result.');
    const providerJobId = submitted.providerJobId;
    expect(events).toEqual([
      'state:PREPARED',
      'state:SUBMITTING',
      'fetch',
      'cache:capture',
      'state:SUBMITTED',
    ]);
    const state = await statePort.get(RUNTIME_ID, request.idempotencyKey);
    expect(state).toMatchObject({
      requestFingerprint: request.fingerprint,
      phase: 'SUBMITTED',
      providerJobId,
      uploadedFiles: [],
      exactBody: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'assistant', content: ORIGINAL_TEXT }],
        audio: { format: 'wav', voice: '冰糖' },
      }),
    });
    const cached = await mediaCache.lookup(RUNTIME_ID, providerJobId, 'audio');
    expect(cached).toMatchObject({ sizeBytes: 64, contentHash: hash(wavBytes()) });

    const restarted = createGateway(fetcher.fetch, statePort, mediaCache);
    expect(await restarted.gateway.submit(RUNTIME_ID, request)).toEqual(submitted);
    const job = await restarted.gateway.getJob(RUNTIME_ID, providerJobId);
    expect(job).toMatchObject({
      providerJobId,
      status: 'COMPLETED',
      outputs: [
        {
          id: 'audio',
          mimeType: 'audio/wav',
          extension: '.wav',
          sizeBytes: 64,
          contentHash: hash(wavBytes()),
        },
      ],
    });
    const source = await restarted.gateway.downloadOutput(RUNTIME_ID, providerJobId, 'audio');
    const downloaded: Uint8Array[] = [];
    for await (const chunk of source.open()) downloaded.push(new Uint8Array(chunk));
    expect(Buffer.concat(downloaded.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(wavBytes()),
    );
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(mediaCache.captures).toBe(1);
  });

  it('treats a lost response as UNKNOWN and never sends a second POST after restart', async () => {
    const fetcher = fakeFetch(async () => {
      throw new Error('fixture connection dropped');
    });
    const statePort = new MemoryStatePort();
    const mediaCache = new MemoryMediaCache(statePort.events);
    const first = createGateway(fetcher.fetch, statePort, mediaCache);
    const request = makeRequest();
    expect(await first.gateway.submit(RUNTIME_ID, request)).toEqual({ outcome: 'UNKNOWN' });
    expect(await statePort.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
      phase: 'UNKNOWN',
      providerJobId: null,
    });

    const restarted = createGateway(fetcher.fetch, statePort, mediaCache);
    expect(await restarted.gateway.submit(RUNTIME_ID, request)).toEqual({ outcome: 'UNKNOWN' });
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(mediaCache.captures).toBe(0);
  });

  it('rejects idempotency reuse when the request or its fingerprint changes', async () => {
    const fetcher = fakeFetch(audioResponse());
    const { gateway } = createGateway(fetcher.fetch);
    const request = makeRequest();
    await gateway.submit(RUNTIME_ID, request);
    await expectDomainCode(
      gateway.submit(RUNTIME_ID, makeRequest({ fingerprint: hash('changed-fingerprint') })),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectDomainCode(
      gateway.submit(RUNTIME_ID, makeRequest({ prompt: '不同的原文。' })),
      'IDEMPOTENCY_CONFLICT',
    );
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds an oversized successful HTTP body, cancels its stream, and does not cache or retry', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let deliveredChunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        deliveredChunks += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversizedResponse = new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetcher = fakeFetch(oversizedResponse);
    const statePort = new MemoryStatePort();
    const mediaCache = new MemoryMediaCache(statePort.events);
    const first = createGateway(fetcher.fetch, statePort, mediaCache);
    const request = makeRequest();
    expect(await first.gateway.submit(RUNTIME_ID, request)).toEqual({ outcome: 'UNKNOWN' });
    expect(cancelled).toBe(true);
    expect(deliveredChunks).toBeLessThan(30);
    expect(mediaCache.captures).toBe(0);
    const restarted = createGateway(fetcher.fetch, statePort, mediaCache);
    expect(await restarted.gateway.submit(RUNTIME_ID, request)).toEqual({ outcome: 'UNKNOWN' });
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('maps the official 404 response to a durable model rejection without exposing its body', async () => {
    const fetcher = fakeFetch(
      new Response('{"error":{"message":"model not found"}}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const statePort = new MemoryStatePort();
    const { gateway } = createGateway(fetcher.fetch, statePort);
    const request = makeRequest();
    expect(await gateway.submit(RUNTIME_ID, request)).toEqual({
      outcome: 'REJECTED',
      errorCode: 'MODEL_NOT_FOUND',
    });
    expect(await statePort.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
      phase: 'REJECTED',
      errorCode: 'MODEL_NOT_FOUND',
    });
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns UNKNOWN for a local provider ID whose cached output is missing and never queries MiMo', async () => {
    const fetcher = fakeFetch(audioResponse());
    const { gateway, mediaCache } = createGateway(fetcher.fetch);
    const providerJobId = 'mimo_v1_' + 'a'.repeat(64);
    expect(await gateway.getJob(RUNTIME_ID, providerJobId)).toEqual({
      providerJobId,
      status: 'UNKNOWN',
      outputs: [],
      errorCode: 'OUTPUT_MISSING',
    });
    expect(mediaCache.lookups).toBe(1);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('does not mark the response SUBMITTED when the durable cache reports a mismatched MIME type', async () => {
    const fetcher = fakeFetch(audioResponse());
    const statePort = new MemoryStatePort();
    const mediaCache = new MemoryMediaCache(statePort.events, 'audio/mpeg');
    const { gateway } = createGateway(fetcher.fetch, statePort, mediaCache);
    const request = makeRequest();
    expect(await gateway.submit(RUNTIME_ID, request)).toEqual({ outcome: 'UNKNOWN' });
    expect(await statePort.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
      phase: 'UNKNOWN',
      providerJobId: null,
    });
    expect(await gateway.getJob(RUNTIME_ID, 'mimo_v1_' + 'a'.repeat(64))).toMatchObject({
      status: 'UNKNOWN',
    });
  });

  it('treats malformed JSON, malformed base64, and non-WAV audio as UNKNOWN', async () => {
    const responses = [
      new Response('{"choices":[', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(
        JSON.stringify({ choices: [{ message: { audio: { data: '%%%not-base64%%%' } } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      new Response(
        JSON.stringify({
          choices: [
            { message: { audio: { data: Buffer.from('not a WAV audio').toString('base64') } } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ];
    for (const response of responses) {
      const fetcher = fakeFetch(response);
      const statePort = new MemoryStatePort();
      const mediaCache = new MemoryMediaCache(statePort.events);
      const { gateway } = createGateway(fetcher.fetch, statePort, mediaCache);
      expect(await gateway.submit(RUNTIME_ID, makeRequest())).toEqual({ outcome: 'UNKNOWN' });
      expect(mediaCache.captures).toBe(0);
    }
  });

  it('rejects overlong plain text before persisting or calling the provider', async () => {
    const fetcher = fakeFetch(audioResponse());
    const statePort = new MemoryStatePort();
    const { gateway } = createGateway(fetcher.fetch, statePort);
    await expectDomainCode(
      gateway.submit(RUNTIME_ID, makeRequest({ prompt: '文'.repeat(1_366) })),
      'INVALID_INPUT',
    );
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(await statePort.get(RUNTIME_ID, 'task-mimo-001')).toBeNull();
  });

  it('keeps resolved credentials out of durable state, descriptors, and errors', async () => {
    const response = new Response(JSON.stringify({ choices: [], provider_debug: API_KEY }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetcher = fakeFetch(async (input) =>
      String(input).endsWith('/models')
        ? new Response(JSON.stringify({ object: 'list', data: [], provider_debug: API_KEY }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : response,
    );
    const statePort = new MemoryStatePort();
    const { gateway } = createGateway(fetcher.fetch, statePort);
    const descriptor = await gateway.getDescriptor(RUNTIME_ID);
    expect(JSON.stringify(descriptor)).not.toContain(API_KEY);
    const invalidIdError = await expectDomainCode(
      gateway.getJob(RUNTIME_ID, API_KEY),
      'OUTPUT_MISSING',
    );
    expect(invalidIdError.message).not.toContain(API_KEY);
    const result = await gateway.submit(RUNTIME_ID, makeRequest());
    expect(result).toEqual({ outcome: 'UNKNOWN' });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    const state = await statePort.get(RUNTIME_ID, 'task-mimo-001');
    expect(JSON.stringify(state)).not.toContain(API_KEY);
    expect(JSON.parse(state!.exactBody).messages[0].content).toBe(ORIGINAL_TEXT);
  });
});
