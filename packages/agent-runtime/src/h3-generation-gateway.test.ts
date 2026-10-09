import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainError } from '@cultivation/shared';
import { GenerationCrash } from '@cultivation/application/g1-generation';
import type {
  GenerationBinarySource,
  ProviderGenerationRequest,
} from '@cultivation/application/g1-generation';
import type { GenerationResolvedInput } from '@cultivation/application/g1-generation';
import type {
  H3AdapterStateStore,
  H3AdapterSubmissionState,
  H3CachedOutput,
  H3OutputCache,
  H3ResolvedRuntime,
} from './h3-generation-gateway.js';
import { H3GenerationGateway } from './h3-generation-gateway.js';
import { startH3HttpFixture } from './h3-http-fixture.js';

const API_KEY = 'fixture-secret';
const RUNTIME_ID = 'runtime-h3';
const MODEL_ID = 'minimax-h3';
const PROMPT = 'A quiet sunrise over a lake.';
const MP4_SIZE = 135_131;
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

class MemoryStateStore implements H3AdapterStateStore {
  private readonly values = new Map<string, H3AdapterSubmissionState>();
  async get(runtimeId: string, key: string) {
    const value = this.values.get(runtimeId + '\u0000' + key);
    return value ? structuredClone(value) : null;
  }
  async put(state: H3AdapterSubmissionState) {
    this.values.set(state.runtimeId + '\u0000' + state.key, structuredClone(state));
  }
}

class MemoryOutputCache implements H3OutputCache {
  private readonly values = new Map<string, H3CachedOutput>();
  captures = 0;
  async lookup(runtimeId: string, providerJobId: string, outputId: string) {
    return this.values.get(runtimeId + '\u0000' + providerJobId + '\u0000' + outputId) ?? null;
  }
  async capture(input: Parameters<H3OutputCache['capture']>[0]) {
    this.captures += 1;
    const chunks: Uint8Array[] = [];
    let sizeBytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of input.source.open(input.signal)) {
      sizeBytes += chunk.byteLength;
      hash.update(chunk);
      chunks.push(new Uint8Array(chunk));
    }
    if (input.advertisedSize !== null && sizeBytes !== input.advertisedSize)
      throw new DomainError('ARTIFACT_INTEGRITY', 'Fixture output size mismatch.');
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      sizeBytes,
    );
    const output: H3CachedOutput = {
      sizeBytes,
      contentHash: hash.digest('hex'),
      source: byteSource(bytes),
    };
    this.values.set(
      input.runtimeProfileId + '\u0000' + input.providerJobId + '\u0000' + input.outputId,
      output,
    );
    return output;
  }
}

function byteSource(bytes: Uint8Array): GenerationBinarySource {
  return {
    async *open(signal?: AbortSignal) {
      for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        yield bytes.subarray(offset, Math.min(offset + 16 * 1024, bytes.byteLength));
      }
    },
    cancel() {},
  };
}

function makeInput(overrides: Partial<GenerationResolvedInput> = {}): GenerationResolvedInput {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  return {
    artifactId: 'artifact-first-frame',
    role: 'FIRST_FRAME',
    kind: 'IMAGE',
    mimeType: 'image/png',
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    source: byteSource(bytes),
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<ProviderGenerationRequest> = {},
): ProviderGenerationRequest {
  return {
    idempotencyKey: 'task-h3-001',
    fingerprint: fingerprint('g1-request'),
    modelId: MODEL_ID,
    capability: 'VIDEO_GENERATION',
    requiredFeatures: ['TEXT_TO_VIDEO'],
    prompt: PROMPT,
    inputs: [],
    parameters: { durationSeconds: 5, aspect: '16:9', seed: 42, task: 'auto' },
    ...overrides,
  };
}

function createGateway(
  fixture: { baseUrl: string },
  stateStore = new MemoryStateStore(),
  outputCache = new MemoryOutputCache(),
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
) {
  const resolver = async (): Promise<H3ResolvedRuntime> => ({
    baseUrl: fixture.baseUrl,
    modelId: MODEL_ID,
    apiKey: API_KEY,
  });
  const gateway = new H3GenerationGateway(resolver, stateStore, outputCache, {
    fetch: fetchImplementation,
    requestTimeoutMs: 2_000,
    uploadTimeoutMs: 2_000,
  });
  return { gateway, stateStore, outputCache };
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

describe('H3 GenerationGateway HTTP adapter', () => {
  it('probes health and exposes only implemented, bounded MP4 descriptor capabilities', async () => {
    const fixture = await startH3HttpFixture();
    try {
      const { gateway } = createGateway(fixture);
      const descriptor = await gateway.getDescriptor(RUNTIME_ID);
      expect(descriptor).toMatchObject({
        modelId: MODEL_ID,
        outputCapability: 'VIDEO_GENERATION',
        executionMode: 'ASYNC_JOB',
        featureTags: ['TEXT_TO_VIDEO', 'FIRST_FRAME_CONDITIONING'],
        outputTypes: ['video/mp4'],
        limits: {
          minDurationSeconds: 4,
          maxDurationSeconds: 15,
          maxInputFiles: 4,
          maxInputBytes: 128 * 1024 * 1024,
          maxOutputBytes: 512 * 1024 * 1024,
          maxOutputs: 1,
        },
      });
      expect(descriptor.inputRoles).toEqual([
        {
          role: 'FIRST_FRAME',
          artifactKinds: ['IMAGE'],
          mimeTypes: ['image/png'],
          maxFiles: 1,
        },
      ]);
      expect(descriptor.parameterSchema.properties).toMatchObject({
        duration: { minimum: 4, maximum: 15, default: 5 },
        aspect: { enum: ['16:9', '9:16', '1:1'], default: '16:9' },
      });
      expect(descriptor.parameterSchema.properties).not.toHaveProperty('nativeAudio');
      expect(await gateway.probe(RUNTIME_ID)).toMatchObject({
        ok: true,
        code: 'MODEL_AVAILABLE',
      });
    } finally {
      await fixture.close();
    }
  });

  it('streams multipart input, maps formal parameters, and reuses the durable idempotency result after restart', async () => {
    const fixture = await startH3HttpFixture();
    const stateStore = new MemoryStateStore();
    const outputCache = new MemoryOutputCache();
    try {
      const request = makeRequest({
        requiredFeatures: ['TEXT_TO_VIDEO', 'FIRST_FRAME_CONDITIONING'],
        inputs: [makeInput()],
        parameters: { duration: 6, aspect: '9:16', seed: 123, task: 'auto' },
      });
      const first = createGateway(fixture, stateStore, outputCache);
      const result = await first.gateway.submit(RUNTIME_ID, request);
      expect(result).toEqual({
        outcome: 'SUBMITTED',
        providerJobId: 'gen_1',
        status: 'QUEUED',
      });
      expect(fixture.stats()).toMatchObject({
        uploadRequests: 1,
        submitRequests: 1,
        createdJobs: 1,
        lastIdempotencyKey: request.idempotencyKey,
      });
      expect(fixture.stats().lastSubmitBody).toMatchObject({
        model: MODEL_ID,
        prompt: PROMPT,
        duration: 6,
        aspect: '9:16',
        seed: 123,
        task: 'auto',
        media: [{ role: 'first_frame', file_id: 'file_1' }],
      });
      expect(await stateStore.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
        requestFingerprint: request.fingerprint,
        phase: 'SUBMITTED',
        providerJobId: 'gen_1',
        uploadedFiles: [
          {
            artifactId: 'artifact-first-frame',
            fileId: 'file_1',
            role: 'FIRST_FRAME',
            mimeType: 'image/png',
            sizeBytes: 6,
            contentHash: makeInput().contentHash,
          },
        ],
        exactBody: expect.any(String),
      });

      const restarted = createGateway(fixture, stateStore, outputCache);
      expect(await restarted.gateway.submit(RUNTIME_ID, request)).toEqual(result);
      expect(fixture.stats()).toMatchObject({
        uploadRequests: 1,
        submitRequests: 1,
        createdJobs: 1,
      });

      fixture.setJobStatus('gen_1', 'running');
      expect((await restarted.gateway.getJob(RUNTIME_ID, 'gen_1')).status).toBe('RUNNING');
      fixture.setJobStatus('gen_1', 'completed');
      const completed = await restarted.gateway.getJob(RUNTIME_ID, 'gen_1');
      expect(completed.status).toBe('COMPLETED');
      expect(completed.outputs).toHaveLength(1);
      expect(completed.outputs[0]).toMatchObject({
        id: 'output_0',
        mimeType: 'video/mp4',
        extension: '.mp4',
        sizeBytes: MP4_SIZE,
        metadata: { durationSeconds: 1, width: 640, height: 360, fps: 24 },
      });
      expect(completed.outputs[0]!.contentHash).toMatch(SHA256_PATTERN);
      expect(outputCache.captures).toBe(1);
      expect(fixture.stats().downloadRequests).toBe(1);

      const source = await restarted.gateway.downloadOutput(RUNTIME_ID, 'gen_1', 'output_0');
      let bytes = 0;
      for await (const chunk of source.open()) bytes += chunk.byteLength;
      expect(bytes).toBe(MP4_SIZE);
      expect(fixture.stats().downloadRequests).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('maps every known verified provider feature and input role without guessing new feature names', async () => {
    const fixture = await startH3HttpFixture();
    try {
      fixture.setMode('full-capability');
      const { gateway } = createGateway(fixture);
      const descriptor = await gateway.getDescriptor(RUNTIME_ID);
      expect(descriptor.featureTags).toEqual([
        'TEXT_TO_VIDEO',
        'FIRST_FRAME_CONDITIONING',
        'REFERENCE_CONDITIONING',
        'VIDEO_TO_AUDIO',
        'NATIVE_AUDIO',
      ]);
      expect(descriptor.inputRoles.map((role) => role.role)).toEqual([
        'FIRST_FRAME',
        'LAST_FRAME',
        'REFERENCE_IMAGE',
        'REFERENCE_VIDEO',
        'REFERENCE_AUDIO',
        'SOURCE_VIDEO',
      ]);

      const roleCases = [
        ['FIRST_FRAME', 'FIRST_FRAME_CONDITIONING', 'IMAGE', 'image/png', 'first_frame'],
        ['LAST_FRAME', 'FIRST_FRAME_CONDITIONING', 'IMAGE', 'image/png', 'last_frame'],
        ['REFERENCE_IMAGE', 'REFERENCE_CONDITIONING', 'IMAGE', 'image/png', 'reference_image'],
        ['REFERENCE_VIDEO', 'REFERENCE_CONDITIONING', 'VIDEO', 'video/mp4', 'reference_video'],
        ['REFERENCE_AUDIO', 'REFERENCE_CONDITIONING', 'AUDIO', 'audio/wav', 'reference_audio'],
        ['SOURCE_VIDEO', 'VIDEO_TO_AUDIO', 'VIDEO', 'video/mp4', 'source_video'],
      ] as const;
      for (const [role, feature, kind, mimeType, providerRole] of roleCases) {
        await gateway.submit(
          RUNTIME_ID,
          makeRequest({
            idempotencyKey: 'task-' + role.toLowerCase(),
            fingerprint: fingerprint(role),
            requiredFeatures: ['TEXT_TO_VIDEO', feature],
            inputs: [
              makeInput({
                artifactId: 'artifact-' + role.toLowerCase(),
                role,
                kind,
                mimeType,
              }),
            ],
          }),
        );
        expect(fixture.stats().lastSubmitBody?.media).toEqual([
          expect.objectContaining({ role: providerRole }),
        ]);
      }
      await gateway.submit(
        RUNTIME_ID,
        makeRequest({
          idempotencyKey: 'task-native-audio',
          fingerprint: fingerprint('native-audio'),
          requiredFeatures: ['TEXT_TO_VIDEO'],
          parameters: { duration: 5, nativeAudio: true },
        }),
      );
      expect(fixture.stats().lastSubmitBody).not.toHaveProperty('required_features');
      expect(fixture.stats().createdJobs).toBe(7);
    } finally {
      await fixture.close();
    }
  });

  it('fails closed for unsupported features, roles, and durations before upload or submission', async () => {
    const fixture = await startH3HttpFixture();
    try {
      const { gateway } = createGateway(fixture);
      await rejectsCode(
        gateway.submit(RUNTIME_ID, makeRequest({ requiredFeatures: ['NATIVE_AUDIO'] })),
        'UNSUPPORTED_FEATURE',
      );
      await rejectsCode(
        gateway.submit(RUNTIME_ID, makeRequest({ parameters: { duration: 5, nativeAudio: true } })),
        'UNSUPPORTED_FEATURE',
      );
      await rejectsCode(
        gateway.submit(RUNTIME_ID, makeRequest({ inputs: [makeInput({ role: 'MASK' })] })),
        'UNSUPPORTED_INPUT_ROLE',
      );
      await rejectsCode(
        gateway.submit(RUNTIME_ID, makeRequest({ parameters: { durationSeconds: 3 } })),
        'MODEL_DURATION_LIMIT',
      );
      expect(fixture.stats()).toMatchObject({
        uploadRequests: 0,
        submitRequests: 0,
        createdJobs: 0,
      });
    } finally {
      await fixture.close();
    }
  });

  it('checks input hash and size while streaming and never submits a mismatched upload', async () => {
    const fixture = await startH3HttpFixture();
    try {
      const { gateway } = createGateway(fixture);
      const input = makeInput({ contentHash: '0'.repeat(64) });
      await rejectsCode(
        gateway.submit(
          RUNTIME_ID,
          makeRequest({
            requiredFeatures: ['TEXT_TO_VIDEO', 'FIRST_FRAME_CONDITIONING'],
            inputs: [input],
          }),
        ),
        'INVALID_INPUT',
      );
      expect(fixture.stats().submitRequests).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('marks dropped submit responses unknown and a new gateway never resubmits them', async () => {
    const fixture = await startH3HttpFixture();
    const stateStore = new MemoryStateStore();
    try {
      fixture.setMode('unknown-submit');
      const request = makeRequest();
      const first = createGateway(fixture, stateStore);
      await expect(first.gateway.submit(RUNTIME_ID, request)).resolves.toEqual({
        outcome: 'UNKNOWN',
      });
      expect(await stateStore.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
        phase: 'UNKNOWN',
        providerJobId: null,
      });

      const afterRestart = createGateway(fixture, stateStore);
      await expect(afterRestart.gateway.submit(RUNTIME_ID, request)).resolves.toEqual({
        outcome: 'UNKNOWN',
      });
      expect(fixture.stats()).toMatchObject({
        submitRequests: 1,
        createdJobs: 1,
      });
    } finally {
      await fixture.close();
    }
  });

  it('recovers a durable SUBMITTING barrier as UNKNOWN after the POST was accepted but its response was abandoned', async () => {
    const fixture = await startH3HttpFixture();
    const stateStore = new MemoryStateStore();
    const request = makeRequest();
    let notifyAccepted!: () => void;
    const postAccepted = new Promise<void>((resolve) => {
      notifyAccepted = resolve;
    });
    const abandonedResponse: { release?: () => void } = {};
    let abandonedSubmission: Promise<unknown> | null = null;
    const losingResponseFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'POST' && new URL(url).pathname === '/v1/videos') {
        await globalThis.fetch(input, init);
        notifyAccepted();
        return await new Promise<Response>((_resolve, reject) => {
          abandonedResponse.release = () =>
            reject(new Error('Simulated process exit before reading response.'));
        });
      }
      return globalThis.fetch(input, init);
    };

    try {
      const beforeRestart = createGateway(
        fixture,
        stateStore,
        new MemoryOutputCache(),
        losingResponseFetch,
      );
      abandonedSubmission = beforeRestart.gateway.submit(RUNTIME_ID, request);
      await postAccepted;
      expect(fixture.stats()).toMatchObject({ submitRequests: 1, createdJobs: 1 });
      expect(await stateStore.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
        phase: 'SUBMITTING',
        providerJobId: null,
      });

      let restartedNetworkRequests = 0;
      const restartedFetch: typeof globalThis.fetch = async (input, init) => {
        restartedNetworkRequests += 1;
        return globalThis.fetch(input, init);
      };
      const afterRestart = createGateway(
        fixture,
        stateStore,
        new MemoryOutputCache(),
        restartedFetch,
      );
      await expect(afterRestart.gateway.submit(RUNTIME_ID, request)).resolves.toEqual({
        outcome: 'UNKNOWN',
      });
      expect(await stateStore.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
        phase: 'UNKNOWN',
        providerJobId: null,
      });
      expect(restartedNetworkRequests).toBe(0);
      expect(fixture.stats()).toMatchObject({
        submitRequests: 1,
        createdJobs: 1,
        downloadRequests: 0,
      });
    } finally {
      abandonedResponse.release?.();
      await abandonedSubmission?.catch(() => undefined);
      await fixture.close();
    }
  });

  it('persists only explicit stable pre-acceptance errors as REJECTED and never reposts them', async () => {
    const fixture = await startH3HttpFixture();
    const stateStore = new MemoryStateStore();
    const codes = [
      'AUTH_FAILED',
      'MODEL_NOT_FOUND',
      'INVALID_INPUT',
      'UNSUPPORTED_FEATURE',
      'UNSUPPORTED_INPUT_ROLE',
      'MODEL_DURATION_LIMIT',
      'QUEUE_FULL',
      'IDEMPOTENCY_CONFLICT',
    ] as const;
    try {
      for (const code of codes) {
        fixture.setSubmissionError({
          error: {
            code,
            message: 'bounded stable error',
            retryable: code === 'QUEUE_FULL',
            accepted: false,
          },
        });
        const request = makeRequest({
          idempotencyKey: 'task-rejected-' + code,
          fingerprint: fingerprint('rejected-' + code),
        });
        const first = createGateway(fixture, stateStore);
        await expect(first.gateway.submit(RUNTIME_ID, request)).resolves.toEqual({
          outcome: 'REJECTED',
          errorCode: code,
        });
        expect(await stateStore.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
          phase: 'REJECTED',
          providerJobId: null,
          errorCode: code,
        });

        const afterRestart = createGateway(fixture, stateStore);
        await expect(afterRestart.gateway.submit(RUNTIME_ID, request)).resolves.toEqual({
          outcome: 'REJECTED',
          errorCode: code,
        });
        await rejectsCode(
          afterRestart.gateway.submit(RUNTIME_ID, {
            ...request,
            fingerprint: fingerprint('changed-' + code),
            prompt: 'changed',
          }),
          'IDEMPOTENCY_CONFLICT',
        );
      }
      expect(fixture.stats()).toMatchObject({
        submitRequests: codes.length,
        createdJobs: 0,
      });
    } finally {
      await fixture.close();
    }
  });

  it('keeps malformed, absent, contradictory, or affirmative acceptance facts UNKNOWN', async () => {
    const fixture = await startH3HttpFixture();
    const stateStore = new MemoryStateStore();
    const ambiguousPayloads: unknown[] = [
      {
        error: {
          code: 'AUTH_FAILED',
          message: 'stable code but no acceptance fact',
          retryable: false,
        },
      },
      {
        error: {
          code: 'AUTH_FAILED',
          message: 'accepted is affirmative',
          retryable: false,
          accepted: true,
        },
      },
      {
        error: {
          code: 'AUTH_FAILED',
          message: 'malformed retryable field',
          retryable: 'false',
          accepted: false,
        },
      },
      {
        task_id: 'gen_conflicting',
        error: {
          code: 'AUTH_FAILED',
          message: 'conflicting accepted job identity',
          retryable: false,
          accepted: false,
        },
      },
      {
        error: {
          code: 'UNLISTED_REJECTION',
          message: 'unlisted code',
          retryable: false,
          accepted: false,
        },
      },
    ];
    try {
      for (let index = 0; index < ambiguousPayloads.length; index += 1) {
        fixture.setSubmissionError(ambiguousPayloads[index] ?? null);
        const request = makeRequest({
          idempotencyKey: 'task-ambiguous-' + index,
          fingerprint: fingerprint('ambiguous-' + index),
        });
        await expect(
          createGateway(fixture, stateStore).gateway.submit(RUNTIME_ID, request),
        ).resolves.toEqual({ outcome: 'UNKNOWN' });
        expect(await stateStore.get(RUNTIME_ID, request.idempotencyKey)).toMatchObject({
          phase: 'UNKNOWN',
          providerJobId: null,
        });
        await expect(
          createGateway(fixture, stateStore).gateway.submit(RUNTIME_ID, request),
        ).resolves.toEqual({ outcome: 'UNKNOWN' });
      }
      expect(fixture.stats()).toMatchObject({
        submitRequests: ambiguousPayloads.length,
        createdJobs: 0,
      });
    } finally {
      await fixture.close();
    }
  });

  it('preserves a recoverable job when output download is interrupted', async () => {
    const fixture = await startH3HttpFixture();
    try {
      const queueGateway = createGateway(fixture);
      fixture.setMode('queue-full');
      await expect(queueGateway.gateway.submit(RUNTIME_ID, makeRequest())).resolves.toEqual({
        outcome: 'REJECTED',
        errorCode: 'QUEUE_FULL',
      });

      fixture.setMode('normal');
      const { gateway } = createGateway(fixture);
      const submission = await gateway.submit(
        RUNTIME_ID,
        makeRequest({
          idempotencyKey: 'task-download-retry',
          fingerprint: fingerprint('download-retry'),
        }),
      );
      if (submission.outcome !== 'SUBMITTED') throw new Error('Expected a submitted fixture job');
      const { providerJobId } = submission;
      fixture.setJobStatus(providerJobId!, 'completed');
      fixture.setMode('download-unavailable');
      await expect(gateway.getJob(RUNTIME_ID, providerJobId!)).rejects.toBeInstanceOf(
        GenerationCrash,
      );
      expect(fixture.stats().downloadRequests).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('rejects a reused key with a changed request and sanitizes provider errors', async () => {
    const fixture = await startH3HttpFixture();
    const stateStore = new MemoryStateStore();
    try {
      const { gateway } = createGateway(fixture, stateStore);
      await gateway.submit(RUNTIME_ID, makeRequest());
      await rejectsCode(
        gateway.submit(
          RUNTIME_ID,
          makeRequest({
            fingerprint: fingerprint('changed'),
            prompt: 'A different prompt.',
          }),
        ),
        'IDEMPOTENCY_CONFLICT',
      );
      expect(fixture.stats().submitRequests).toBe(1);

      fixture.setMode('auth-error');
      const probe = await gateway.probe(RUNTIME_ID);
      expect(probe.code).toBe('AUTH_FAILED');
      expect(JSON.stringify(probe)).not.toContain(API_KEY);
      const error = await rejectsCode(gateway.getDescriptor(RUNTIME_ID), 'AUTH_FAILED');
      expect(error.message).not.toContain(API_KEY);
    } finally {
      await fixture.close();
    }
  });

  it('rejects unknown descriptor names, blocks redirects, and reports offline health safely', async () => {
    const fixture = await startH3HttpFixture();
    const { gateway } = createGateway(fixture);
    try {
      fixture.setMode('unknown-feature');
      await rejectsCode(gateway.getDescriptor(RUNTIME_ID), 'MODEL_UNAVAILABLE');

      fixture.setMode('redirect-health');
      const redirectProbe = await gateway.probe(RUNTIME_ID);
      expect(redirectProbe.ok).toBe(false);
      expect(redirectProbe.message).not.toContain('example.invalid');

      await fixture.close();
      const offlineProbe = await gateway.probe(RUNTIME_ID);
      expect(offlineProbe).toMatchObject({
        ok: false,
        code: 'MODEL_UNAVAILABLE',
        message: 'H3 runtime check failed.',
      });
    } finally {
      if (fixture.server.listening) await fixture.close();
    }
  });

  it('validates a provider parameter schema and uses only compatible narrower bounds', async () => {
    const fixture = await startH3HttpFixture();
    try {
      fixture.setMode('narrow-parameter-schema');
      const { gateway } = createGateway(fixture);
      const descriptor = await gateway.getDescriptor(RUNTIME_ID);
      expect(descriptor.parameterSchema.properties).toMatchObject({
        duration: { minimum: 5, maximum: 10, default: 5 },
        aspect: { enum: ['1:1'], default: '1:1' },
        seed: { minimum: 4, maximum: 99 },
      });
      await gateway.submit(
        RUNTIME_ID,
        makeRequest({
          idempotencyKey: 'task-narrow-schema',
          fingerprint: fingerprint('narrow-schema'),
          parameters: { duration: 5, aspect: '1:1' },
        }),
      );
      expect(fixture.stats().lastSubmitBody).toMatchObject({
        duration: 5,
        aspect: '1:1',
      });
      await rejectsCode(
        gateway.submit(
          RUNTIME_ID,
          makeRequest({
            idempotencyKey: 'task-outside-schema',
            fingerprint: fingerprint('outside-schema'),
            parameters: { duration: 4, aspect: '1:1' },
          }),
        ),
        'MODEL_DURATION_LIMIT',
      );
    } finally {
      await fixture.close();
    }
  });

  it('rejects provider role-feature disagreement and unknown parameter schema shapes', async () => {
    const fixture = await startH3HttpFixture();
    try {
      const { gateway } = createGateway(fixture);
      fixture.setMode('role-without-feature');
      await rejectsCode(gateway.getDescriptor(RUNTIME_ID), 'MODEL_UNAVAILABLE');
      fixture.setMode('unknown-role');
      await rejectsCode(gateway.getDescriptor(RUNTIME_ID), 'MODEL_UNAVAILABLE');
      fixture.setMode('invalid-parameter-schema');
      await rejectsCode(gateway.getDescriptor(RUNTIME_ID), 'MODEL_UNAVAILABLE');
    } finally {
      await fixture.close();
    }
  });

  it('rejects invalid advertised MP4 facts before output capture', async () => {
    const fixture = await startH3HttpFixture();
    try {
      const { gateway } = createGateway(fixture);
      const submission = await gateway.submit(RUNTIME_ID, makeRequest());
      if (submission.outcome !== 'SUBMITTED') throw new Error('Expected a submitted fixture job');
      const { providerJobId } = submission;
      fixture.setJobStatus(providerJobId!, 'completed');
      fixture.setMode('wrong-output-mime');
      await rejectsCode(gateway.getJob(RUNTIME_ID, providerJobId!), 'OUTPUT_MISSING');
      expect(fixture.stats().downloadRequests).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
