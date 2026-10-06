import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import Ajv from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  GenerationBinarySource,
  ProviderGenerationRequest,
} from '@cultivation/application/g1-generation';
import type { GenerationInputRoleDescriptor } from '@cultivation/domain/g1-generation';
import { G3FixtureGenerationGateway, MemoryG3FixtureStatePort } from './g3-fixture-generation.js';
import type { G3FixtureAdapterKind, G3FixtureGenerationOptions } from './g3-fixture-generation.js';
import { H3GenerationGateway } from '@cultivation/agent-runtime/h3-generation-gateway';
import type {
  H3AdapterStateStore,
  H3AdapterSubmissionState,
  H3OutputCache,
  H3CachedOutput,
} from '@cultivation/agent-runtime/h3-generation-gateway';
import { startH3Fixture } from '../../../../scripts/fixtures/g2-h3-http.mjs';

type H3Fixture = Awaited<ReturnType<typeof startH3Fixture>>;

const modelIds: Record<string, string> = {
  'runtime-g3-image': 'studio/g3-image-v1',
  'runtime-g3-music': 'studio/g3-music-v1',
  'runtime-h3': 'minimax-h3',
};

class MemoryH3StateStore implements H3AdapterStateStore {
  private readonly values = new Map<string, H3AdapterSubmissionState>();

  async get(runtimeId: string, key: string): Promise<H3AdapterSubmissionState | null> {
    const value = this.values.get(JSON.stringify([runtimeId, key]));
    return value ? structuredClone(value) : null;
  }

  async put(state: H3AdapterSubmissionState): Promise<void> {
    this.values.set(JSON.stringify([state.runtimeId, state.key]), structuredClone(state));
  }
}

class MemoryH3OutputCache implements H3OutputCache {
  private readonly values = new Map<string, H3CachedOutput>();

  async lookup(
    runtimeProfileId: string,
    providerJobId: string,
    outputId: string,
  ): Promise<H3CachedOutput | null> {
    return this.values.get(JSON.stringify([runtimeProfileId, providerJobId, outputId])) ?? null;
  }

  async capture(input: Parameters<H3OutputCache['capture']>[0]): Promise<H3CachedOutput> {
    const chunks: Uint8Array[] = [];
    let sizeBytes = 0;
    for await (const chunk of input.source.open(input.signal)) {
      chunks.push(chunk);
      sizeBytes += chunk.byteLength;
    }
    const bytes = Buffer.concat(chunks);
    const value: H3CachedOutput = {
      sizeBytes,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      source: bytesSource(bytes),
    };
    this.values.set(
      JSON.stringify([input.runtimeProfileId, input.providerJobId, input.outputId]),
      value,
    );
    return value;
  }
}

function bytesSource(bytes: Uint8Array): GenerationBinarySource {
  return {
    open: () =>
      (async function* () {
        for (let offset = 0; offset < bytes.byteLength; offset += 257)
          yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 257));
      })(),
    cancel: () => undefined,
  };
}

let h3Fixture: H3Fixture;
let h3Gateway: H3GenerationGateway;

beforeAll(async () => {
  h3Fixture = await startH3Fixture();
  h3Gateway = new H3GenerationGateway(
    async (runtimeProfileId) =>
      runtimeProfileId === 'runtime-h3'
        ? {
            baseUrl: h3Fixture.baseUrl,
            modelId: 'minimax-h3',
            apiKey: 'private-h3-fixture-key',
          }
        : null,
    new MemoryH3StateStore(),
    new MemoryH3OutputCache(),
  );
});

afterAll(async () => {
  await h3Fixture?.close();
});

function createGateway(
  statePort = new MemoryG3FixtureStatePort(),
  overrides: Partial<G3FixtureGenerationOptions> = {},
): G3FixtureGenerationGateway {
  return new G3FixtureGenerationGateway({
    testMode: true,
    h3Gateway,
    modelIdForRuntime: (runtimeProfileId) => modelIds[runtimeProfileId] ?? '',
    statePort,
    ...overrides,
  });
}

function requestFor(
  kind: G3FixtureAdapterKind,
  input: ProviderGenerationRequest['inputs'][number] | undefined,
  overrides: Partial<ProviderGenerationRequest> = {},
): ProviderGenerationRequest {
  const image = kind === 'image';
  const modelId = modelIds[image ? 'runtime-g3-image' : 'runtime-g3-music']!;
  const requiredFeatures = image ? ['TEXT_TO_IMAGE'] : ['TEXT_TO_MUSIC'];
  if (input) requiredFeatures.push(image ? 'REFERENCE_IMAGE' : 'REFERENCE_AUDIO');
  return {
    idempotencyKey: `${kind}-stable-key`,
    fingerprint: `${kind}-request-fingerprint`,
    modelId,
    capability: image ? 'IMAGE_GENERATION' : 'MUSIC_GENERATION',
    requiredFeatures,
    prompt: image ? '一幅平静的海边插画' : '一段轻柔的钢琴旋律',
    inputs: input ? [input] : [],
    parameters: image
      ? { seed: 7, style: 'NATURAL' }
      : { durationSeconds: 1, tempo: 100, seed: 11 },
    ...overrides,
  };
}

function referenceInput(kind: G3FixtureAdapterKind): ProviderGenerationRequest['inputs'][number] {
  const bytes = Buffer.from(
    kind === 'image'
      ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
      : createTestWav().toString('base64'),
    'base64',
  );
  return {
    artifactId: `${kind}-reference-artifact`,
    role: kind === 'image' ? 'REFERENCE_IMAGE' : 'REFERENCE_AUDIO',
    kind: kind === 'image' ? 'IMAGE' : 'AUDIO',
    mimeType: kind === 'image' ? 'image/png' : 'audio/wav',
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    source: bytesSource(bytes),
  };
}

function createTestWav(): Buffer {
  const sampleCount = 64;
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
  return bytes;
}

function runtimeFor(kind: G3FixtureAdapterKind): string {
  return kind === 'image' ? 'runtime-g3-image' : 'runtime-g3-music';
}

async function readAll(source: GenerationBinarySource): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.open()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('G3 test-only provider-neutral Generation fixture', () => {
  it('requires an explicit testMode=true flag before construction', () => {
    expect(() => createGateway(new MemoryG3FixtureStatePort(), { testMode: false })).toThrow(
      'G3 生成夹具仅可由显式测试模式构造',
    );
  });

  it('provides valid image and music descriptors, feature sets, input roles, and parameters', async () => {
    const statePort = new MemoryG3FixtureStatePort();
    const gateway = createGateway(statePort);
    const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });

    for (const kind of ['image', 'music'] as const) {
      const runtimeProfileId = runtimeFor(kind);
      const descriptor = await gateway.getDescriptor(runtimeProfileId);
      const image = kind === 'image';
      expect(descriptor.modelId).toBe(modelIds[runtimeProfileId]);
      expect(descriptor.outputCapability).toBe(image ? 'IMAGE_GENERATION' : 'MUSIC_GENERATION');
      expect(descriptor.featureTags).toEqual(
        image
          ? ['TEXT_TO_IMAGE', 'REFERENCE_IMAGE']
          : ['TEXT_TO_MUSIC', 'LYRICS', 'REFERENCE_AUDIO'],
      );
      const role: GenerationInputRoleDescriptor = descriptor.inputRoles[0]!;
      expect(role).toMatchObject({
        role: image ? 'REFERENCE_IMAGE' : 'REFERENCE_AUDIO',
        artifactKinds: [image ? 'IMAGE' : 'AUDIO'],
        mimeTypes: [image ? 'image/png' : 'audio/wav'],
        maxFiles: 2,
      });
      const validateParameters = ajv.compile(descriptor.parameterSchema);
      expect(
        validateParameters(
          image
            ? { seed: 7, style: 'NATURAL', fixtureScenario: 'NORMAL' }
            : { durationSeconds: 1, tempo: 100, seed: 11, fixtureScenario: 'NORMAL' },
        ),
      ).toBe(true);
      expect(descriptor.outputTypes).toEqual([image ? 'image/png' : 'audio/wav']);

      const submission = await gateway.submit(
        runtimeProfileId,
        requestFor(kind, referenceInput(kind)),
      );
      expect(submission.outcome).toBe('SUBMITTED');
    }

    const unsupported = requestFor('image', referenceInput('image'), {
      idempotencyKey: 'unsupported-role',
      inputs: [{ ...referenceInput('image'), role: 'SOURCE_VIDEO' }],
    });
    await expect(gateway.submit('runtime-g3-image', unsupported)).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT_ROLE',
    });
  });

  it('preserves key plus fingerprint across concurrent repeats and a gateway restart', async () => {
    const statePort = new MemoryG3FixtureStatePort();
    const firstGateway = createGateway(statePort);
    const request = requestFor('image', undefined);
    const firstRows = await Promise.all(
      Array.from({ length: 4 }, () => firstGateway.submit('runtime-g3-image', request)),
    );
    expect(firstRows).toEqual(Array.from({ length: 4 }, () => firstRows[0]));

    const reopenedGateway = createGateway(statePort);
    expect(await reopenedGateway.submit('runtime-g3-image', request)).toEqual(firstRows[0]);
    await expect(
      reopenedGateway.submit('runtime-g3-image', {
        ...request,
        prompt: '另一段内容，但仍伪造原始 fingerprint',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      reopenedGateway.submit('runtime-g3-image', {
        ...request,
        fingerprint: 'different-request-fingerprint',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await reopenedGateway.proofPort.read()).toMatchObject({
      image: { submissions: 1 },
    });
  });

  it('streams valid PNG and WAV outputs with durable query and download counters', async () => {
    for (const kind of ['image', 'music'] as const) {
      const statePort = new MemoryG3FixtureStatePort();
      const firstGateway = createGateway(statePort);
      const runtimeProfileId = runtimeFor(kind);
      const request = requestFor(kind, undefined);
      const submitted = await firstGateway.submit(runtimeProfileId, request);
      expect(submitted.outcome).toBe('SUBMITTED');
      if (submitted.outcome !== 'SUBMITTED') throw new Error('Expected a fixture job');
      expect((await firstGateway.getJob(runtimeProfileId, submitted.providerJobId)).status).toBe(
        'RUNNING',
      );

      const reopenedGateway = createGateway(statePort);
      const completed = await reopenedGateway.getJob(runtimeProfileId, submitted.providerJobId);
      expect(completed.status).toBe('COMPLETED');
      const output = completed.outputs[0]!;
      const bytes = await readAll(
        await reopenedGateway.downloadOutput(runtimeProfileId, submitted.providerJobId, output.id),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.contentHash);
      if (kind === 'image') {
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(bytes.readUInt32BE(16)).toBe(1);
        expect(bytes.readUInt32BE(20)).toBe(1);
      } else {
        expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
        expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
        expect(bytes.toString('ascii', 12, 16)).toBe('fmt ');
        expect(bytes.toString('ascii', 36, 40)).toBe('data');
        expect(bytes.readUInt32LE(4)).toBe(bytes.byteLength - 8);
        expect(bytes.readUInt32LE(40)).toBe(bytes.byteLength - 44);
      }
      expect(await reopenedGateway.proofPort.read()).toMatchObject({
        [kind]: { submissions: 1, queries: 2, downloads: 1 },
      });
    }
  });

  it('persists a definitive QUEUE_FULL rejection once and exposes only safe proof facts', async () => {
    const statePort = new MemoryG3FixtureStatePort();
    const gateway = createGateway(statePort);
    const request = requestFor('image', undefined, {
      idempotencyKey: 'queue-full-once',
      parameters: { fixtureScenario: 'QUEUE_FULL' },
    });
    const rejected = await gateway.submit('runtime-g3-image', request);
    expect(rejected).toEqual({ outcome: 'REJECTED', errorCode: 'QUEUE_FULL' });

    const reopenedGateway = createGateway(statePort);
    expect(await reopenedGateway.submit('runtime-g3-image', request)).toEqual(rejected);
    const proof = await reopenedGateway.proofPort.read();
    expect(proof.image).toMatchObject({ submissions: 1, queries: 0, downloads: 0 });
    expect(proof.image.entries[0]).toMatchObject({
      submissionOutcome: 'REJECTED',
      providerJobId: null,
      errorCode: 'QUEUE_FULL',
      definitiveQueueFullRejection: true,
    });
    const encodedProof = JSON.stringify(proof);
    expect(encodedProof).not.toContain('private-h3-fixture-key');
    expect(encodedProof).not.toContain('127.0.0.1');
    expect(encodedProof).not.toMatch(/[A-Za-z]:\\/);
  });

  it('persists UNKNOWN as ambiguous and never creates a second job', async () => {
    const statePort = new MemoryG3FixtureStatePort();
    const gateway = createGateway(statePort);
    const request = requestFor('music', undefined, {
      idempotencyKey: 'unknown-once',
      parameters: { fixtureScenario: 'UNKNOWN' },
    });
    expect(await gateway.submit('runtime-g3-music', request)).toEqual({ outcome: 'UNKNOWN' });
    const reopenedGateway = createGateway(statePort);
    expect(await reopenedGateway.submit('runtime-g3-music', request)).toEqual({
      outcome: 'UNKNOWN',
    });
    const proof = await reopenedGateway.proofPort.read();
    expect(proof.music).toMatchObject({ submissions: 1, queries: 0, downloads: 0 });
    expect(proof.music.entries[0]).toMatchObject({
      submissionOutcome: 'UNKNOWN',
      providerJobId: null,
      errorCode: null,
      definitiveQueueFullRejection: false,
    });
  });

  it('routes all non-G3 model ids to the supplied real H3 HTTP fixture gateway', async () => {
    const gateway = createGateway();
    const descriptor = await gateway.getDescriptor('runtime-h3');
    expect(descriptor).toMatchObject({
      modelId: 'minimax-h3',
      outputCapability: 'VIDEO_GENERATION',
      outputTypes: ['video/mp4'],
    });
    expect(h3Fixture.facts.healthChecks).toBeGreaterThan(0);
    expect(h3Fixture.facts.models).toBeGreaterThan(0);

    const request: ProviderGenerationRequest = {
      idempotencyKey: 'h3-delegate-key',
      fingerprint: 'h3-delegate-fingerprint',
      modelId: descriptor.modelId,
      capability: 'VIDEO_GENERATION',
      requiredFeatures: ['TEXT_TO_VIDEO'],
      prompt: '一段海边短片',
      inputs: [],
      parameters: { durationSeconds: 5, aspect: '16:9', task: 'auto' },
    };
    const submission = await gateway.submit('runtime-h3', request);
    expect(submission.outcome).toBe('SUBMITTED');
    if (submission.outcome !== 'SUBMITTED') throw new Error('Expected H3 fixture submission');
    expect(h3Fixture.facts.postAttempts).toBe(1);
    expect((await gateway.getJob('runtime-h3', submission.providerJobId)).status).toBe('RUNNING');

    const proof = await gateway.proofPort.read();
    const encodedProof = JSON.stringify(proof);
    expect(encodedProof).not.toContain('private-h3-fixture-key');
    expect(encodedProof).not.toContain(h3Fixture.baseUrl);
  });
});
