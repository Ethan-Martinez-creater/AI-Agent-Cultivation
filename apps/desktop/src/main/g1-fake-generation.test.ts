import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeGenerationGateway } from './g1-fake-generation.js';
import type { ProviderGenerationRequest } from '@cultivation/application/g1-generation';
describe('G1 adapter idempotency boundary', () => {
  it('same key/request survives restart, different payload conflicts even with spoofed fingerprint', async () => {
    const file = join(process.cwd(), '.test-data', `g1-adapter-${randomUUID()}`, 'provider.json');
    const gateway = new FakeGenerationGateway(file, () => 'image-v1');
    const request: ProviderGenerationRequest = {
      idempotencyKey: 'task-1',
      fingerprint: 'bounded-request',
      modelId: 'image-v1',
      capability: 'IMAGE_GENERATION',
      requiredFeatures: ['TEXT_TO_IMAGE'],
      prompt: '图片',
      parameters: {},
      inputs: [],
    };
    const first = await gateway.submit('r', request);
    expect((await gateway.submit('r', request)).providerJobId).toBe(first.providerJobId);
    const reopened = new FakeGenerationGateway(file, () => 'image-v1');
    expect((await reopened.submit('r', request)).providerJobId).toBe(first.providerJobId);
    expect(reopened.counters().submissions).toBe(1);
    await expect(reopened.submit('r', { ...request, prompt: '另一张图片' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(
      reopened.submit('r', { ...request, fingerprint: 'different-fingerprint' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(reopened.counters().submissions).toBe(1);
  });
  it('adapter uncertainty remains durable and does not create a second logical generation', async () => {
    const file = join(process.cwd(), '.test-data', `g1-adapter-${randomUUID()}`, 'provider.json');
    const request: ProviderGenerationRequest = {
      idempotencyKey: 'task-1',
      fingerprint: 'bounded-request',
      modelId: 'image-v1',
      capability: 'IMAGE_GENERATION',
      requiredFeatures: ['TEXT_TO_IMAGE'],
      prompt: '图片',
      parameters: { scenario: 'UNKNOWN' },
      inputs: [],
    };
    expect(
      await new FakeGenerationGateway(file, () => 'image-v1').submit('r', request),
    ).toMatchObject({ status: 'UNKNOWN', providerJobId: null });
    const reopened = new FakeGenerationGateway(file, () => 'image-v1');
    expect(await reopened.submit('r', request)).toMatchObject({
      status: 'UNKNOWN',
      providerJobId: null,
    });
    expect(reopened.counters().submissions).toBe(1);
  });
});
