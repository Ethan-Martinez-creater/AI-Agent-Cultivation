import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@cultivation/shared';
import { extensionForMime, openRemoteMedia } from './commercial-generation-http.js';
import type {
  GenerationBinarySource,
  ProviderGenerationRequest,
} from '@cultivation/application/g1-generation';
import type {
  GenerationCachedMedia,
  GenerationProviderMediaCache,
  GenerationProviderStatePort,
  GenerationProviderSubmissionFact,
  GenerationProviderRuntime,
} from './generation-provider-ports.js';
import { ApiMartGenerationGateway } from './apimart-generation-gateway.js';
import { TokenRhythmGenerationGateway } from './tokenrhythm-generation-gateway.js';

const API_KEY = 'fixture-secret-never-forward-this';
const RUNTIME_ID = 'runtime-commercial';
const PROMPT = 'A paper lantern floating over a quiet river.';
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

class MemoryStateStore implements GenerationProviderStatePort {
  private readonly values = new Map<string, GenerationProviderSubmissionFact>();

  async get(runtimeId: string, key: string) {
    const value = this.values.get(runtimeId + '\u0000' + key);
    return value ? structuredClone(value) : null;
  }

  async put(state: GenerationProviderSubmissionFact) {
    this.values.set(state.runtimeId + '\u0000' + state.key, structuredClone(state));
  }
}

class MemoryMediaCache implements GenerationProviderMediaCache {
  private readonly values = new Map<
    string,
    { bytes: Uint8Array; contentHash: string; mimeType: string }
  >();
  captures = 0;

  async lookup(runtimeId: string, providerJobId: string, outputId: string) {
    const value = this.values.get(cacheKey(runtimeId, providerJobId, outputId));
    if (!value) return null;
    return {
      sizeBytes: value.bytes.byteLength,
      contentHash: value.contentHash,
      mimeType: value.mimeType,
      source: byteSource(value.bytes),
    } as GenerationCachedMedia & { mimeType: string };
  }

  async capture(input: Parameters<GenerationProviderMediaCache['capture']>[0]) {
    this.captures += 1;
    const chunks: Uint8Array[] = [];
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of input.source.open(input.signal)) {
      const copy = new Uint8Array(chunk);
      chunks.push(copy);
      hash.update(copy);
      sizeBytes += copy.byteLength;
    }
    if (input.advertisedSize !== null && input.advertisedSize !== sizeBytes)
      throw new DomainError('ARTIFACT_INTEGRITY', 'Fixture size did not match response headers.');
    const bytes = new Uint8Array(sizeBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.values.set(cacheKey(input.runtimeProfileId, input.providerJobId, input.outputId), {
      bytes,
      contentHash: hash.digest('hex'),
      mimeType: input.mimeType,
    });
    const cached = await this.lookup(input.runtimeProfileId, input.providerJobId, input.outputId);
    if (!cached) throw new Error('Fixture cache capture failed.');
    return cached;
  }
}

interface SeenRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

function fakeFetch(handler: (request: SeenRequest) => Promise<Response> | Response): {
  fetch: typeof globalThis.fetch;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: typeof input === 'string' || input instanceof URL ? String(input) : input.url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: init?.body ?? (input instanceof Request ? input.body : null),
    };
    seen.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function binaryResponse(bytes: Uint8Array, mimeType: string): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { 'content-type': mimeType, 'content-length': String(bytes.byteLength) },
  });
}

function byteSource(bytes: Uint8Array): GenerationBinarySource {
  return {
    async *open(signal?: AbortSignal) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024)
        yield bytes.subarray(offset, Math.min(offset + 16 * 1024, bytes.byteLength));
    },
    cancel() {},
  };
}

function cacheKey(runtimeId: string, providerJobId: string, outputId: string): string {
  return runtimeId + '\u0000' + providerJobId + '\u0000' + outputId;
}

function request(
  modelId: string,
  capability: ProviderGenerationRequest['capability'],
  parameters: Record<string, unknown> = {},
  inputs: ProviderGenerationRequest['inputs'] = [],
): ProviderGenerationRequest {
  return {
    idempotencyKey: 'generation-2026-001',
    fingerprint: fingerprint('fingerprint-1'),
    modelId,
    capability,
    requiredFeatures:
      capability === 'IMAGE_GENERATION'
        ? inputs.length
          ? ['TEXT_TO_IMAGE', 'REFERENCE_CONDITIONING']
          : ['TEXT_TO_IMAGE']
        : capability === 'VIDEO_GENERATION'
          ? ['TEXT_TO_VIDEO', ...(inputs.length ? ['FIRST_FRAME_CONDITIONING'] : [])]
          : ['TEXT_TO_MUSIC'],
    prompt: PROMPT,
    inputs,
    parameters,
  };
}

function runtime(modelId: string, provider: 'apimart' | 'tokenrhythm'): GenerationProviderRuntime {
  return {
    baseUrl: provider === 'apimart' ? 'https://api.apimart.ai/v1' : 'https://tokenrhythm.studio/v1',
    modelId,
    apiKey: API_KEY,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function imageInput(): ProviderGenerationRequest['inputs'][number] {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
  return {
    artifactId: 'artifact-reference-one',
    role: 'REFERENCE_IMAGE',
    kind: 'IMAGE',
    mimeType: 'image/jpeg',
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    source: byteSource(bytes),
  };
}

function createApiMart(
  modelId: string,
  fetch: typeof globalThis.fetch,
  states = new MemoryStateStore(),
  cache = new MemoryMediaCache(),
) {
  const modelsAwareFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.endsWith('/models?expand=parameters'))
      return jsonResponse({ object: 'list', success: true, data: [{ id: modelId }] });
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const gateway = new ApiMartGenerationGateway(
    async () => runtime(modelId, 'apimart'),
    states,
    cache,
    { fetch: modelsAwareFetch, requestTimeoutMs: 2_000 },
  );
  return { gateway, states, cache };
}

function createTokenRhythm(
  modelId: string,
  fetch: typeof globalThis.fetch,
  states = new MemoryStateStore(),
  cache = new MemoryMediaCache(),
) {
  const modelsAwareFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.endsWith('/models')) return jsonResponse({ models: [{ id: 'qwen3.8-flash' }] });
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const gateway = new TokenRhythmGenerationGateway(
    async () => runtime(modelId, 'tokenrhythm'),
    states,
    cache,
    { fetch: modelsAwareFetch, requestTimeoutMs: 2_000 },
  );
  return { gateway, states, cache };
}

async function rejectsCode(action: Promise<unknown>, code: string): Promise<DomainError> {
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

describe('API Mart and TokenRhythm GenerationGateway adapters', () => {
  it('sniffs bounded generic WAV headers, emits bounded chunks, and names WebP cache files', async () => {
    const wav = new Uint8Array(100_000);
    wav.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    const opened = await openRemoteMedia(
      async () =>
        new Response(wav, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(wav.byteLength),
          },
        }),
      'https://getapib.org/audio/output',
      'APIMART',
      false,
      ['audio/wav', 'audio/mpeg'],
      200_000,
      2_000,
    );
    expect(opened.mimeType).toBe('audio/wav');
    const sizes: number[] = [];
    let total = 0;
    for await (const chunk of opened.source.open()) {
      sizes.push(chunk.byteLength);
      total += chunk.byteLength;
    }
    expect(total).toBe(wav.byteLength);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    expect(extensionForMime('image/webp')).toBe('.webp');
  });

  it('authenticates the bounded APIMart model catalogue before exposing a descriptor', async () => {
    const mock = fakeFetch((call) => {
      expect(call.method).toBe('GET');
      expect(call.url).toBe('https://api.apimart.ai/v1/models?expand=parameters');
      expect(call.headers.get('authorization')).toBe('Bearer ' + API_KEY);
      return jsonResponse({
        object: 'list',
        success: true,
        data: [{ id: 'gemini-3.1-flash-lite-image' }],
      });
    });
    const gateway = new ApiMartGenerationGateway(
      async () => runtime('gemini-3.1-flash-lite-image', 'apimart'),
      new MemoryStateStore(),
      new MemoryMediaCache(),
      { fetch: mock.fetch, requestTimeoutMs: 2_000 },
    );
    const descriptor = await gateway.getDescriptor(RUNTIME_ID);
    expect(descriptor.modelId).toBe('gemini-3.1-flash-lite-image');
    expect(mock.seen).toHaveLength(1);
  });

  it('uploads trusted image streams with size/hash binding and caches actual APIMart MIME', async () => {
    const imageBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
    const remoteImage = Uint8Array.from([0xff, 0xd8, 0xff, 0x10, 0x11]);
    const seen: SeenRequest[] = [];
    const mock = fakeFetch(async (call) => {
      seen.push(call);
      if (call.url.endsWith('/uploads/images')) {
        expect(call.headers.get('authorization')).toBe('Bearer ' + API_KEY);
        expect(call.headers.get('content-type')).toContain('multipart/form-data; boundary=');
        const uploadedBody = await readStream(call.body as ReadableStream<Uint8Array>);
        expect(Buffer.from(uploadedBody).includes(Buffer.from(imageBytes))).toBe(true);
        return jsonResponse({
          url: 'https://upload.apimart.ai/f/image/ref-one.jpg',
          filename: 'ref-one.jpg',
          content_type: 'image/jpeg',
          bytes: imageBytes.byteLength,
        });
      }
      if (call.url.endsWith('/images/generations')) {
        expect(call.headers.get('authorization')).toBe('Bearer ' + API_KEY);
        const body = JSON.parse(String(call.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          model: 'gemini-3.1-flash-lite-image',
          prompt: PROMPT,
          resolution: '1K',
          n: 1,
        });
        expect(body.image_urls).toEqual([{ url: 'https://upload.apimart.ai/f/image/ref-one.jpg' }]);
        return jsonResponse({
          code: 200,
          data: [{ status: 'submitted', task_id: 'task-image-001' }],
        });
      }
      if (call.url.endsWith('/tasks/task-image-001'))
        return jsonResponse({
          data: {
            id: 'task-image-001',
            status: 'completed',
            result: { images: [{ url: ['https://upload.apimart.ai/f/image/generated.jpg'] }] },
          },
        });
      if (call.url === 'https://upload.apimart.ai/f/image/generated.jpg') {
        expect(call.headers.has('authorization')).toBe(false);
        expect(call.url).not.toContain(API_KEY);
        return binaryResponse(remoteImage, 'image/pjpeg; charset=binary');
      }
      throw new Error('Unexpected fixture request: ' + new URL(call.url).pathname);
    });
    const { gateway, states, cache } = createApiMart('gemini-3.1-flash-lite-image', mock.fetch);
    const input = imageInput();
    const imageRequest = request('gemini-3.1-flash-lite-image', 'IMAGE_GENERATION', {}, [input]);
    const submitted = await gateway.submit(RUNTIME_ID, imageRequest);
    expect(submitted).toEqual({
      outcome: 'SUBMITTED',
      providerJobId: 'task-image-001',
      status: 'QUEUED',
    });
    const saved = await states.get(RUNTIME_ID, imageRequest.idempotencyKey);
    expect(saved?.phase).toBe('SUBMITTED');
    expect(saved?.uploadedFiles[0]?.contentHash).toBe(input.contentHash);
    const descriptor = await gateway.getDescriptor(RUNTIME_ID);
    expect(descriptor.outputCapability).toBe('IMAGE_GENERATION');
    expect(descriptor.outputTypes).toEqual(['image/png', 'image/jpeg']);
    const job = await gateway.getJob(RUNTIME_ID, 'task-image-001');
    expect(job.status).toBe('COMPLETED');
    expect(job.outputs).toHaveLength(1);
    expect(job.outputs[0]).toMatchObject({ mimeType: 'image/jpeg', extension: '.jpg' });
    expect(cache.captures).toBe(1);
    const downloaded = await gateway.downloadOutput(
      RUNTIME_ID,
      'task-image-001',
      job.outputs[0]!.id,
    );
    expect(
      await readStream(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for await (const chunk of downloaded.open()) controller.enqueue(chunk);
            controller.close();
          },
        }),
      ),
    ).toEqual(remoteImage);
    const outputRequest = seen.find((entry) => entry.url.includes('generated.jpg'))!;
    expect(outputRequest.headers.has('authorization')).toBe(false);
    expect(outputRequest.method).toBe('GET');
    expect(seen.filter((entry) => entry.url.endsWith('/images/generations'))).toHaveLength(1);
  });

  it('keeps an unknown billable APIMart submission behind the no-replay barrier and conflicts on changed lineage', async () => {
    let posts = 0;
    const mock = fakeFetch(async (call) => {
      if (call.url.endsWith('/videos/generations')) {
        posts += 1;
        throw new Error('fixture network ambiguity');
      }
      throw new Error('Unexpected request.');
    });
    const { gateway, states } = createApiMart('wan2.7', mock.fetch);
    const initial = request('wan2.7', 'VIDEO_GENERATION', { durationSeconds: 5 });
    expect(await gateway.submit(RUNTIME_ID, initial)).toEqual({ outcome: 'UNKNOWN' });
    expect((await states.get(RUNTIME_ID, initial.idempotencyKey))?.phase).toBe('UNKNOWN');
    expect(await gateway.submit(RUNTIME_ID, initial)).toEqual({ outcome: 'UNKNOWN' });
    expect(posts).toBe(1);
    await rejectsCode(
      gateway.submit(RUNTIME_ID, {
        ...initial,
        prompt: 'A changed prompt.',
        fingerprint: fingerprint('changed-lineage'),
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    expect(posts).toBe(1);
  });

  it('persists definitive APIMart rejection and never repeats that billable POST', async () => {
    let posts = 0;
    const mock = fakeFetch(async (call) => {
      if (call.url.endsWith('/images/generations')) {
        posts += 1;
        return jsonResponse(
          {
            error: {
              code: 400,
              message: 'Invalid request parameters',
              type: 'invalid_request_error',
            },
          },
          400,
        );
      }
      throw new Error('Unexpected request.');
    });
    const { gateway, states } = createApiMart('gemini-3.1-flash-lite-image', mock.fetch);
    const imageRequest = request('gemini-3.1-flash-lite-image', 'IMAGE_GENERATION');
    expect(await gateway.submit(RUNTIME_ID, imageRequest)).toEqual({
      outcome: 'REJECTED',
      errorCode: 'INVALID_INPUT',
    });
    expect((await states.get(RUNTIME_ID, imageRequest.idempotencyKey))?.phase).toBe('REJECTED');
    expect(await gateway.submit(RUNTIME_ID, imageRequest)).toEqual({
      outcome: 'REJECTED',
      errorCode: 'INVALID_INPUT',
    });
    expect(posts).toBe(1);
  });

  it('keeps message-only HTTP errors UNKNOWN and never repeats the billable POST', async () => {
    let posts = 0;
    const mock = fakeFetch(async (call) => {
      if (call.url.endsWith('/images/generations')) {
        posts += 1;
        return jsonResponse({ error: { message: 'invalid prompt details' } }, 422);
      }
      throw new Error('Unexpected request.');
    });
    const { gateway, states } = createApiMart('gemini-3.1-flash-lite-image', mock.fetch);
    const imageRequest = request('gemini-3.1-flash-lite-image', 'IMAGE_GENERATION');
    expect(await gateway.submit(RUNTIME_ID, imageRequest)).toEqual({ outcome: 'UNKNOWN' });
    expect((await states.get(RUNTIME_ID, imageRequest.idempotencyKey))?.phase).toBe('UNKNOWN');
    expect(await gateway.submit(RUNTIME_ID, imageRequest)).toEqual({ outcome: 'UNKNOWN' });
    expect(posts).toBe(1);
  });

  it('submits and polls APIMart Wan 2.7 video with the documented bounded parameters', async () => {
    const video = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const mock = fakeFetch(async (call) => {
      if (call.url.endsWith('/videos/generations')) {
        expect(JSON.parse(String(call.body))).toEqual({
          model: 'wan2.7',
          prompt: PROMPT,
          duration: 8,
          resolution: '720P',
          size: '9:16',
        });
        return jsonResponse({
          code: 200,
          data: [{ status: 'submitted', task_id: 'task-video-001' }],
        });
      }
      if (call.url.endsWith('/tasks/task-video-001'))
        return jsonResponse({
          data: {
            id: 'task-video-001',
            status: 'completed',
            result: {
              videos: [{ url: 'https://upload.apimart.ai/f/video/output.mp4', duration: 8 }],
            },
          },
        });
      if (call.url.endsWith('/f/video/output.mp4')) {
        expect(call.headers.has('authorization')).toBe(false);
        return binaryResponse(video, 'video/mp4');
      }
      throw new Error('Unexpected fixture request.');
    });
    const { gateway } = createApiMart('wan2.7', mock.fetch);
    const videoRequest = request('wan2.7', 'VIDEO_GENERATION', {
      durationSeconds: 8,
      aspect: '9:16',
      resolution: '720P',
    });
    expect((await gateway.getDescriptor(RUNTIME_ID)).limits).toMatchObject({
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      maxOutputs: 1,
    });
    const submitted = await gateway.submit(RUNTIME_ID, videoRequest);
    if (submitted.outcome !== 'SUBMITTED') throw new Error('Fixture submission failed.');
    const job = await gateway.getJob(RUNTIME_ID, submitted.providerJobId);
    expect(job.status).toBe('COMPLETED');
    expect(job.outputs[0]).toMatchObject({ mimeType: 'video/mp4', extension: '.mp4' });
  });

  it('preserves every supported Suno result track and uses each track Content-Type', async () => {
    const seen: SeenRequest[] = [];
    const wav = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 0x01]);
    const mock = fakeFetch(async (call) => {
      seen.push(call);
      if (call.url.endsWith('/music/generations')) {
        expect(JSON.parse(String(call.body))).toMatchObject({
          model: 'suno',
          custom: false,
          version: 'v6',
          audio_format: 'wav',
        });
        return jsonResponse({ data: [{ status: 'submitted', task_id: 'task-music-001' }] });
      }
      if (call.url.endsWith('/music/tasks/task-music-001'))
        return jsonResponse({
          data: {
            id: 'task-music-001',
            status: 'completed',
            result: {
              music: [
                {
                  audio_id: 'track-a',
                  duration: 12.5,
                  audio_url: 'https://getapib.org/a/track-a',
                },
                {
                  audio_id: 'track-b',
                  duration: 13,
                  audio_url: 'https://upload.apimart.ai/a/track-b',
                },
              ],
            },
          },
        });
      if (call.url === 'https://getapib.org/a/track-a') {
        expect(call.headers.has('authorization')).toBe(false);
        return binaryResponse(wav, 'application/octet-stream');
      }
      if (call.url.endsWith('/a/track-b')) {
        expect(call.headers.has('authorization')).toBe(false);
        return binaryResponse(mp3, 'audio/mp3; charset=binary');
      }
      throw new Error('Unexpected fixture request.');
    });
    const { gateway, cache } = createApiMart('suno', mock.fetch);
    const musicRequest = request('suno', 'MUSIC_GENERATION');
    const submission = await gateway.submit(RUNTIME_ID, musicRequest);
    expect(submission.outcome).toBe('SUBMITTED');
    const taskId = submission.outcome === 'SUBMITTED' ? submission.providerJobId : '';
    const job = await gateway.getJob(RUNTIME_ID, taskId);
    expect(job.status).toBe('COMPLETED');
    expect(job.outputs.map(({ mimeType, extension }) => ({ mimeType, extension }))).toEqual([
      { mimeType: 'audio/wav', extension: '.wav' },
      { mimeType: 'audio/mpeg', extension: '.mp3' },
    ]);
    expect(job.outputs).toHaveLength(2);
    expect(cache.captures).toBe(2);
    expect(seen.filter((entry) => entry.url.endsWith('/music/generations'))).toHaveLength(1);
  });

  it('rejects more Suno tracks than the advertised cap instead of truncating them', async () => {
    const mock = fakeFetch(async (call) => {
      if (call.url.endsWith('/music/generations'))
        return jsonResponse({ data: [{ status: 'submitted', task_id: 'task-music-too-many' }] });
      if (call.url.endsWith('/music/tasks/task-music-too-many'))
        return jsonResponse({
          data: {
            id: 'task-music-too-many',
            status: 'completed',
            result: {
              music: Array.from({ length: 9 }, (_, index) => ({
                audio_url: `https://upload.apimart.ai/a/track-${index}`,
              })),
            },
          },
        });
      throw new Error('The over-cap response must fail before media downloads.');
    });
    const { gateway } = createApiMart('suno', mock.fetch);
    const submitted = await gateway.submit(RUNTIME_ID, request('suno', 'MUSIC_GENERATION'));
    if (submitted.outcome !== 'SUBMITTED') throw new Error('Fixture submission failed.');
    await rejectsCode(gateway.getJob(RUNTIME_ID, submitted.providerJobId), 'OUTPUT_MISSING');
  });

  it('stores TokenRhythm synchronous image results behind a durable local job identity', async () => {
    const outputBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    let posts = 0;
    let outputGets = 0;
    const mock = fakeFetch(async (call) => {
      if (call.url.endsWith('/images/generations')) {
        posts += 1;
        expect(call.headers.get('authorization')).toBe('Bearer ' + API_KEY);
        expect(JSON.parse(String(call.body))).toEqual({
          model: 'qwen-image-2.0',
          prompt: PROMPT,
          n: 1,
          size: '1024x1024',
        });
        return jsonResponse({
          created: 1780000000,
          data: [{ url: 'https://tokenrhythm.studio/media/image-1.png' }],
        });
      }
      if (call.url === 'https://tokenrhythm.studio/media/image-1.png') {
        outputGets += 1;
        expect(call.headers.has('authorization')).toBe(false);
        return binaryResponse(outputBytes, 'image/png');
      }
      throw new Error('Unexpected fixture request.');
    });
    const { gateway, states, cache } = createTokenRhythm('qwen-image-2.0', mock.fetch);
    const imageRequest = request('qwen-image-2.0', 'IMAGE_GENERATION');
    const descriptor = await gateway.getDescriptor(RUNTIME_ID);
    expect(descriptor.executionMode).toBe('SYNC');
    const first = await gateway.submit(RUNTIME_ID, imageRequest);
    expect(first).toEqual({
      outcome: 'SUBMITTED',
      providerJobId: imageRequest.idempotencyKey,
      status: 'RUNNING',
    });
    const stored = await states.get(RUNTIME_ID, imageRequest.idempotencyKey);
    expect(stored?.phase).toBe('SUBMITTED');
    const repeated = await gateway.submit(RUNTIME_ID, imageRequest);
    expect(repeated).toEqual(first);
    expect(posts).toBe(1);
    const job = await gateway.getJob(RUNTIME_ID, imageRequest.idempotencyKey);
    expect(job.status).toBe('COMPLETED');
    expect(job.outputs[0]).toMatchObject({ mimeType: 'image/png', extension: '.png' });
    expect(cache.captures).toBe(1);
    expect(outputGets).toBe(1);
  });

  it('authenticates TokenRhythm discovery without requiring media models in its LLM catalog', async () => {
    const mock = fakeFetch((call) => {
      expect(call.method).toBe('GET');
      expect(call.url).toBe('https://tokenrhythm.studio/v1/models');
      expect(call.headers.get('authorization')).toBe('Bearer ' + API_KEY);
      return jsonResponse({ object: 'list', data: [{ id: 'qwen3.8-flash' }] });
    });
    const gateway = new TokenRhythmGenerationGateway(
      async () => runtime('qwen-image-2.0', 'tokenrhythm'),
      new MemoryStateStore(),
      new MemoryMediaCache(),
      { fetch: mock.fetch, requestTimeoutMs: 2_000 },
    );
    const descriptor = await gateway.getDescriptor(RUNTIME_ID);
    expect(descriptor.modelId).toBe('qwen-image-2.0');
    expect(mock.seen).toHaveLength(1);
  });

  it('submits Wan3 videos and queries only the accepted id without forwarding the key to output storage', async () => {
    const video = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const mock = fakeFetch(async (call) => {
      if (call.url.endsWith('/videos/generations')) {
        expect(call.headers.get('authorization')).toBe('Bearer ' + API_KEY);
        expect(JSON.parse(String(call.body))).toEqual({
          model: 'wan3.0-video',
          content: [{ type: 'text', text: PROMPT }],
          resolution: '720P',
          duration: 5,
          ratio: '16:9',
        });
        return jsonResponse({ id: 'tr-video-001', status: 'queued' }, 202);
      }
      if (call.url.endsWith('/videos/tr-video-001'))
        return jsonResponse({
          id: 'tr-video-001',
          status: 'completed',
          result: { url: 'https://tokenrhythm.studio/media/video-1.mp4' },
        });
      if (call.url === 'https://tokenrhythm.studio/media/video-1.mp4') {
        expect(call.headers.has('authorization')).toBe(false);
        expect(call.url).not.toContain(API_KEY);
        return binaryResponse(video, 'video/mp4');
      }
      throw new Error('Unexpected fixture request.');
    });
    const { gateway, cache } = createTokenRhythm('wan3.0-video', mock.fetch);
    const submitted = await gateway.submit(RUNTIME_ID, request('wan3.0-video', 'VIDEO_GENERATION'));
    expect(submitted).toEqual({
      outcome: 'SUBMITTED',
      providerJobId: 'tr-video-001',
      status: 'QUEUED',
    });
    const job = await gateway.getJob(RUNTIME_ID, 'tr-video-001');
    expect(job.status).toBe('COMPLETED');
    expect(job.outputs[0]).toMatchObject({ mimeType: 'video/mp4', extension: '.mp4' });
    expect(cache.captures).toBe(1);
  });

  it('blocks an unapproved output URL before issuing any CDN request', async () => {
    const seen: SeenRequest[] = [];
    const mock = fakeFetch(async (call) => {
      seen.push(call);
      if (call.url.endsWith('/images/generations'))
        return jsonResponse({
          code: 200,
          data: [{ status: 'submitted', task_id: 'task-host-check' }],
        });
      if (call.url.endsWith('/tasks/task-host-check'))
        return jsonResponse({
          data: {
            id: 'task-host-check',
            status: 'completed',
            result: { images: [{ url: 'https://upload.apimart.ai.example.invalid/picture.png' }] },
          },
        });
      throw new Error('An untrusted host must not be contacted.');
    });
    const { gateway } = createApiMart('gemini-3.1-flash-lite-image', mock.fetch);
    const submitted = await gateway.submit(
      RUNTIME_ID,
      request('gemini-3.1-flash-lite-image', 'IMAGE_GENERATION'),
    );
    if (submitted.outcome !== 'SUBMITTED') throw new Error('Fixture submission failed.');
    await rejectsCode(gateway.getJob(RUNTIME_ID, submitted.providerJobId), 'OUTPUT_MISSING');
    expect(seen.map((entry) => new URL(entry.url).hostname)).toEqual([
      'api.apimart.ai',
      'api.apimart.ai',
    ]);
  });
});
