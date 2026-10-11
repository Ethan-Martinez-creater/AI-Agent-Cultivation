import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { GenerationBinarySource } from '@cultivation/application/g1-generation';
import { GenerationMediaStore } from './g2-media-store.js';

vi.mock('./g1-media-validator.js', () => ({
  validateGenerationMedia: async (mimeType: string, reader: { sizeBytes: number }) => ({
    container: mimeType,
    sizeBytes: reader.sizeBytes,
  }),
}));

const TEST_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.tmp');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cacheKey = (runtime: string, job: string, output: string) =>
  createHash('sha256').update(`${runtime}\0${job}\0${output}`).digest('hex');

async function fixture() {
  const userData = path.join(TEST_BASE, `g2-media-store-${randomUUID()}`);
  await mkdir(userData, { recursive: true });
  return { userData, store: new GenerationMediaStore(userData, {} as never) };
}

function source(bytes: Uint8Array): GenerationBinarySource {
  return {
    open: () =>
      (async function* () {
        yield bytes;
      })(),
    cancel: () => undefined,
  };
}

async function readSource(binary: GenerationBinarySource): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of binary.open()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('GenerationMediaStore format-aware cache', () => {
  it.each([
    { mimeType: 'image/jpeg', canonicalMime: 'image/jpeg', extension: '.jpg' },
    { mimeType: 'image/jpg', canonicalMime: 'image/jpeg', extension: '.jpg' },
    { mimeType: 'image/webp', canonicalMime: 'image/webp', extension: '.webp' },
    { mimeType: 'audio/x-wav', canonicalMime: 'audio/wav', extension: '.wav' },
    { mimeType: 'audio/mpeg', canonicalMime: 'audio/mpeg', extension: '.mp3' },
  ])('captures $mimeType under its canonical $extension cache path', async (format) => {
    const { userData, store } = await fixture();
    const runtimeProfileId = 'runtime-format-test';
    const providerJobId = 'provider-job-format-test';
    const outputId = format.extension;
    const bytes = Buffer.from(`fixture:${format.mimeType}`, 'utf8');
    const captured = await store.capture({
      runtimeProfileId,
      providerJobId,
      outputId,
      mimeType: format.mimeType,
      advertisedSize: bytes.length,
      source: source(bytes),
    });

    const key = cacheKey(runtimeProfileId, providerJobId, outputId);
    const cachedFile = path.join(
      userData,
      'generation-media',
      'cache',
      `${key}${format.extension}`,
    );
    await expect(stat(cachedFile)).resolves.toMatchObject({ size: bytes.length });
    const metadata = JSON.parse(
      await readFile(path.join(userData, 'generation-media', 'cache', `${key}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata.mimeType).toBe(format.canonicalMime);
    expect(captured.mimeType).toBe(format.canonicalMime);
    expect(await readSource(captured.source)).toEqual(bytes);

    const lookedUp = await store.lookup(runtimeProfileId, providerJobId, outputId);
    expect(lookedUp?.mimeType).toBe(format.canonicalMime);
    expect(lookedUp && (await readSource(lookedUp.source))).toEqual(bytes);
  });

  it('reads legacy cache metadata without a MIME as MP4 from the old .mp4 path', async () => {
    const { userData, store } = await fixture();
    const runtimeProfileId = 'runtime-legacy-test';
    const providerJobId = 'provider-job-legacy-test';
    const outputId = 'old-video';
    const key = cacheKey(runtimeProfileId, providerJobId, outputId);
    const cacheRoot = path.join(userData, 'generation-media', 'cache');
    await mkdir(cacheRoot, { recursive: true });
    const bytes = Buffer.from('legacy mp4 bytes', 'utf8');
    await writeFile(path.join(cacheRoot, `${key}.mp4`), bytes);
    await writeFile(
      path.join(cacheRoot, `${key}.json`),
      JSON.stringify({ sizeBytes: bytes.length, contentHash: digest(bytes) }),
      'utf8',
    );

    const cached = await store.lookup(runtimeProfileId, providerJobId, outputId);
    expect(cached).toMatchObject({ mimeType: 'video/mp4', sizeBytes: bytes.length });
    expect(cached && (await readSource(cached.source))).toEqual(bytes);
  });
});
