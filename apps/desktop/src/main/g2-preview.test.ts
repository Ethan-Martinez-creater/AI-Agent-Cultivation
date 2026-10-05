import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import type {
  GenerationArtifactPort,
  GenerationRepository,
} from '@cultivation/application/g1-generation';
const mock = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: mock.register } }));
import { generationPreview } from './g2-preview.js';
function harness() {
  let handle!: (request: Request & { initiatorOrigin?: string }) => Promise<Response>;
  const session = {
    protocol: {
      handle: (_scheme: string, handler: typeof handle) => {
        handle = handler;
      },
    },
  } as unknown as Session;
  const resolve = vi.fn(async () => ({
    source: {
      open: async function* () {
        yield new Uint8Array([1, 2, 3, 4]);
      },
      cancel: vi.fn(),
    },
  }));
  const repository = {
    getArtifact: (id: string) =>
      id === 'a' ? { id, jobId: 'j', sizeBytes: 4, mimeType: 'video/mp4' } : null,
    getJob: () => ({ state: 'COMPLETED', generationTaskId: 't' }),
    getTask: () => ({ id: 't' }),
  } as unknown as GenerationRepository;
  const issue = generationPreview(session, repository, {
    resolveInput: resolve,
  } as unknown as GenerationArtifactPort);
  const request = (url: string, origin = 'file://', options: RequestInit = {}) =>
    Object.assign(new Request(url, options), { initiatorOrigin: origin });
  return { issue, request, handle: (r: Request) => handle(r), resolve };
}
describe('G2 opaque media protocol boundary', () => {
  it('rejects remote/opaque origins, unknown tokens, paths, queries and non-read methods', async () => {
    const h = harness();
    const url = await h.issue('a');
    for (const req of [
      h.request(url, 'https://evil.example'),
      h.request(url, 'null'),
      h.request('cultivation-media://artifact/unknown'),
      h.request(`${url}?path=C:/secret`),
      h.request(url.replace('artifact', 'other')),
      h.request(url, 'file://', { method: 'POST' }),
    ]) {
      expect((await h.handle(req)).status).toBeGreaterThanOrEqual(400);
    }
    expect(h.resolve).not.toHaveBeenCalled();
    expect(url).not.toContain('a/');
    await expect(h.issue('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('serves bounded byte ranges from the original validated Artifact source', async () => {
    const h = harness();
    const url = await h.issue('a');
    const response = await h.handle(h.request(url, 'file://', { headers: { range: 'bytes=1-2' } }));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3]);
    const head = await h.handle(h.request(url, 'file://', { method: 'HEAD' }));
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe('4');
    expect(
      (await h.handle(h.request(url, 'file://', { headers: { range: 'bytes=0-999' } }))).status,
    ).toBe(416);
  });
});
