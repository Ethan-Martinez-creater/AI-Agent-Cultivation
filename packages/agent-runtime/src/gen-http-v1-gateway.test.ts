import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { ProviderGenerationRequest } from '@cultivation/application/g1-generation';
import type { GenerationProviderSubmissionFact } from './generation-provider-ports.js';
import { GenHttpV1Gateway, parseGenHttpDescriptor } from './gen-http-v1-gateway.js';

const descriptor = {
  modelId: 'generic-image-v1',
  outputCapability: 'IMAGE_GENERATION',
  executionMode: 'ASYNC_JOB',
  featureTags: ['TEXT_TO_IMAGE', 'REFERENCE_CONDITIONING'],
  inputRoles: [
    { role: 'REFERENCE_IMAGE', artifactKinds: ['IMAGE'], mimeTypes: ['image/png'], maxFiles: 1 },
  ],
  parameterSchema: {
    type: 'object',
    properties: { seed: { type: 'integer', minimum: 0 } },
    additionalProperties: false,
  },
  outputTypes: ['image/png'],
  limits: {
    maxInputFiles: 1,
    maxInputBytes: 32 * 1024 * 1024,
    maxOutputBytes: 128 * 1024 * 1024,
    maxOutputs: 1,
  },
};
const bytes = Buffer.from('bounded synthetic media');
const hash = createHash('sha256').update(bytes).digest('hex');
const request = (): ProviderGenerationRequest => ({
  idempotencyKey: 'task-001',
  fingerprint: 'a'.repeat(64),
  modelId: descriptor.modelId,
  capability: 'IMAGE_GENERATION',
  requiredFeatures: ['TEXT_TO_IMAGE'],
  prompt: 'A blue circle',
  inputs: [],
  parameters: { seed: 1 },
});

async function fixture(mode: 'normal' | 'lost' | 'rejected' | 'bad-hash' | 'redirect' = 'normal') {
  let posts = 0;
  let uploads = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer private-fixture-key') {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return void res.end(JSON.stringify({ status: 'ok' }));
    if (req.url === '/v1/models')
      return void res.end(JSON.stringify({ protocol: 'GEN_HTTP_V1', models: [descriptor] }));
    if (req.url === '/v1/files') {
      uploads++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const received = Buffer.concat(chunks);
      return void res.end(
        JSON.stringify({
          fileId: 'file-001',
          mimeType: 'image/png',
          sizeBytes: received.length,
          contentHash: createHash('sha256').update(received).digest('hex'),
        }),
      );
    }
    if (req.url === '/v1/generations' && req.method === 'POST') {
      posts++;
      for await (const chunk of req) {
        void chunk;
        /* fully consume */
      }
      if (mode === 'lost') return req.socket.destroy();
      if (mode === 'rejected') {
        res.statusCode = 429;
        return void res.end(JSON.stringify({ error: { accepted: false, code: 'QUEUE_FULL' } }));
      }
      return void res.end(JSON.stringify({ providerJobId: 'job-001', status: 'QUEUED' }));
    }
    if (req.url === '/v1/generations/job-001')
      return void res.end(
        JSON.stringify({
          providerJobId: 'job-001',
          status: 'COMPLETED',
          outputs: [
            {
              id: 'out-001',
              mimeType: 'image/png',
              extension: 'png',
              sizeBytes: bytes.length,
              contentHash: mode === 'bad-hash' ? 'b'.repeat(64) : hash,
              metadata: { durationToleranceSeconds: 0.05, width: 1 },
            },
          ],
        }),
      );
    if (req.url === '/v1/generations/job-001/outputs/out-001/download') {
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }).end();
        return;
      }
      res.setHeader('content-type', 'image/png');
      res.setHeader('content-length', String(bytes.length));
      return void res.end(bytes);
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const facts = new Map<string, GenerationProviderSubmissionFact>();
  const state = {
    get: async (_runtime: string, key: string) =>
      facts.has(key) ? structuredClone(facts.get(key)!) : null,
    put: async (fact: GenerationProviderSubmissionFact) => {
      facts.set(fact.key, structuredClone(fact));
    },
  };
  const gateway = () =>
    new GenHttpV1Gateway(
      async () => ({ baseUrl, modelId: descriptor.modelId, apiKey: 'private-fixture-key' }),
      state,
      { requestTimeoutMs: 1000 },
    );
  return {
    gateway,
    counts: () => ({ posts, uploads }),
    facts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

describe('GEN_HTTP_V1 production contract against independent HTTP fixture', () => {
  it('accepts a bounded model descriptor larger than 16 MiB and rejects remote schema code', () => {
    expect(parseGenHttpDescriptor(descriptor).limits.maxInputBytes).toBeGreaterThan(
      16 * 1024 * 1024,
    );
    expect(() =>
      parseGenHttpDescriptor({
        ...descriptor,
        parameterSchema: { type: 'object', $ref: 'https://host/schema' },
      }),
    ).toThrow();
    expect(() =>
      parseGenHttpDescriptor({
        ...descriptor,
        inputRoles: [...descriptor.inputRoles, ...descriptor.inputRoles],
      }),
    ).toThrow();
  });
  it.each([
    ['IMAGE_GENERATION', 'image/png'],
    ['VIDEO_GENERATION', 'video/mp4'],
    ['MUSIC_GENERATION', 'audio/mpeg'],
    ['SPEECH_GENERATION', 'audio/wav'],
  ])(
    'expresses %s through the same protocol without a provider-specific model type',
    (capability, mime) => {
      expect(
        parseGenHttpDescriptor({ ...descriptor, outputCapability: capability, outputTypes: [mime] })
          .outputCapability,
      ).toBe(capability);
      expect(() =>
        parseGenHttpDescriptor({
          ...descriptor,
          outputCapability: capability,
          outputTypes: [capability === 'VIDEO_GENERATION' ? 'image/png' : 'video/mp4'],
        }),
      ).toThrow();
    },
  );
  it('freezes key/fingerprint, queries the original job, downloads bounded same-origin output', async () => {
    const f = await fixture();
    try {
      const g = f.gateway();
      expect((await g.getDescriptor('runtime')).outputCapability).toBe('IMAGE_GENERATION');
      expect(await g.submit('runtime', request())).toEqual({
        outcome: 'SUBMITTED',
        providerJobId: 'job-001',
        status: 'QUEUED',
      });
      expect(await f.gateway().submit('runtime', request())).toMatchObject({
        providerJobId: 'job-001',
      });
      expect(await g.submit('runtime', { ...request(), prompt: 'changed' })).toEqual({
        outcome: 'REJECTED',
        errorCode: 'IDEMPOTENCY_CONFLICT',
      });
      const output = (await g.getJob('runtime', 'job-001')).outputs[0]!;
      expect(output.contentHash).toBe(hash);
      expect(output.extension).toBe('.png');
      expect(output.metadata).toEqual({ width: 1 });
      expect(output.metadata).not.toHaveProperty('durationToleranceSeconds');
      const source = await g.downloadOutput('runtime', 'job-001', 'out-001');
      let count = 0;
      for await (const part of source.open()) count += part.length;
      expect(count).toBe(bytes.length);
      expect(f.counts().posts).toBe(1);
      expect(JSON.stringify([...f.facts.values()])).not.toContain('private-fixture-key');
    } finally {
      await f.close();
    }
  });
  it('uploads a trusted input using streamed bytes and binds its Artifact hash/role', async () => {
    const f = await fixture();
    try {
      const r = {
        ...request(),
        requiredFeatures: ['REFERENCE_CONDITIONING'],
        inputs: [
          {
            artifactId: 'artifact-001',
            role: 'REFERENCE_IMAGE',
            kind: 'IMAGE',
            mimeType: 'image/png',
            contentHash: hash,
            sizeBytes: bytes.length,
            source: {
              async *open() {
                yield bytes;
              },
              cancel() {},
            },
          },
        ],
      };
      expect((await f.gateway().submit('runtime', r)).outcome).toBe('SUBMITTED');
      const fact = f.facts.get(r.idempotencyKey)!;
      expect(JSON.parse(fact.exactBody).inputs).toEqual([
        {
          fileId: 'file-001',
          artifactId: 'artifact-001',
          role: 'REFERENCE_IMAGE',
          contentHash: hash,
        },
      ]);
      expect(f.counts()).toEqual({ posts: 1, uploads: 1 });
    } finally {
      await f.close();
    }
  });
  it('a lost billable response persists UNKNOWN and never automatically submits again', async () => {
    const f = await fixture('lost');
    try {
      expect(await f.gateway().submit('runtime', request())).toEqual({ outcome: 'UNKNOWN' });
      expect(await f.gateway().submit('runtime', request())).toEqual({ outcome: 'UNKNOWN' });
      expect(f.counts().posts).toBe(1);
      expect(f.facts.get('task-001')?.phase).toBe('UNKNOWN');
    } finally {
      await f.close();
    }
  });
  it('a durable SUBMITTING crash recovers UNKNOWN without sending a POST', async () => {
    const f = await fixture();
    try {
      await f.gateway().submit('runtime', request());
      const fact = f.facts.get('task-001')!;
      f.facts.set(fact.key, { ...fact, phase: 'SUBMITTING', providerJobId: null });
      expect(await f.gateway().submit('runtime', request())).toEqual({ outcome: 'UNKNOWN' });
      expect(f.counts().posts).toBe(1);
    } finally {
      await f.close();
    }
  });
  it('only an explicit stable non-acceptance response is definitive, and cannot be resubmitted', async () => {
    const f = await fixture('rejected');
    try {
      expect(await f.gateway().submit('runtime', request())).toEqual({
        outcome: 'REJECTED',
        errorCode: 'QUEUE_FULL',
      });
      expect(await f.gateway().submit('runtime', request())).toEqual({
        outcome: 'REJECTED',
        errorCode: 'QUEUE_FULL',
      });
      expect(f.counts().posts).toBe(1);
    } finally {
      await f.close();
    }
  });
  it.each(['bad-hash', 'redirect'] as const)(
    'rejects output %s without accepting unsafe bytes',
    async (mode) => {
      const f = await fixture(mode);
      try {
        const source = await f.gateway().downloadOutput('runtime', 'job-001', 'out-001');
        await expect(
          (async () => {
            for await (const part of source.open()) {
              void part;
              /* downstream validates */
            }
          })(),
        ).rejects.toThrow();
      } finally {
        await f.close();
      }
    },
  );
});
