import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeGenerationGateway } from './g1-fake-generation.js';
import type { ProviderGenerationRequest } from '@cultivation/application/g1-generation';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

async function fixture() {
  const root = join(process.cwd(), '.test-data', `w31-fake-rename-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, 'provider.json');
  const gateway = new FakeGenerationGateway(path, () => 'image-v1');
  const submission = await gateway.submit('runtime', {
    idempotencyKey: 'task',
    fingerprint: 'same-request',
    modelId: 'image-v1',
    capability: 'IMAGE_GENERATION',
    requiredFeatures: ['TEXT_TO_IMAGE'],
    prompt: '测试图片',
    inputs: [],
    parameters: {},
  });
  if (submission.outcome !== 'SUBMITTED') throw new Error('Fixture submission failed');
  return { path, gateway, submission };
}

const failRename = (code: string) => () => {
  throw Object.assign(new Error('Simulated fixture file lock'), { code });
};

afterEach(() => vi.mocked(renameSync).mockClear());

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
    expect(await gateway.submit('r', request)).toEqual(first);
    const reopened = new FakeGenerationGateway(file, () => 'image-v1');
    expect(await reopened.submit('r', request)).toEqual(first);
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
    expect(await new FakeGenerationGateway(file, () => 'image-v1').submit('r', request)).toEqual({
      outcome: 'UNKNOWN',
    });
    const reopened = new FakeGenerationGateway(file, () => 'image-v1');
    expect(await reopened.submit('r', request)).toEqual({ outcome: 'UNKNOWN' });
    expect(reopened.counters().submissions).toBe(1);
  });
});

describe('test-only generation fixture atomic persistence', () => {
  it('retries transient replacement without repeating generation or query counters', async () => {
    const x = await fixture();
    const rename = vi.mocked(renameSync);
    rename.mockClear();
    rename.mockImplementationOnce(failRename('EPERM')).mockImplementationOnce(failRename('EBUSY'));
    expect((await x.gateway.getJob('runtime', x.submission.providerJobId)).status).toBe(
      'COMPLETED',
    );
    expect(rename).toHaveBeenCalledTimes(3);
    const restarted = new FakeGenerationGateway(x.path, () => 'image-v1');
    expect(restarted.counters()).toEqual({ submissions: 1, downloads: 0, queries: 1 });
  });

  it('fails closed after bounded replacement attempts and keeps the original Job after restart', async () => {
    const x = await fixture();
    const rename = vi.mocked(renameSync);
    rename.mockClear();
    for (let i = 0; i < 5; i++) rename.mockImplementationOnce(failRename('EPERM'));
    await expect(x.gateway.getJob('runtime', x.submission.providerJobId)).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(rename).toHaveBeenCalledTimes(5);
    const restarted = new FakeGenerationGateway(x.path, () => 'image-v1');
    expect(restarted.counters()).toEqual({ submissions: 1, downloads: 0, queries: 0 });
    expect((await restarted.getJob('runtime', x.submission.providerJobId)).status).toBe(
      'COMPLETED',
    );
    expect(restarted.counters().submissions).toBe(1);
  });

  it('does not retry unrelated filesystem errors', async () => {
    const x = await fixture();
    const rename = vi.mocked(renameSync);
    rename.mockClear();
    rename.mockImplementationOnce(failRename('EINVAL'));
    await expect(x.gateway.getJob('runtime', x.submission.providerJobId)).rejects.toMatchObject({
      code: 'EINVAL',
    });
    expect(rename).toHaveBeenCalledTimes(1);
  });
});
