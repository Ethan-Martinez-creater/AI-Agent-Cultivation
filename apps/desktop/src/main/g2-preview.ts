import { protocol, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  GenerationRepository,
  GenerationArtifactPort,
} from '@cultivation/application/g1-generation';
import { DomainError } from '@cultivation/shared';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cultivation-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const previews = new WeakMap<Session, (id: string) => Promise<string>>();

/** Exact Main-issued token; neither a Provider URL nor local storage path reaches Renderer. */
export function generationPreview(
  session: Session,
  repository: GenerationRepository,
  artifacts: GenerationArtifactPort,
  rendererOrigin = 'file://',
) {
  const existing = previews.get(session);
  if (existing) return existing;
  const allowed = new Map<string, string>();
  session.protocol.handle('cultivation-media', async (request) => {
    try {
      // Chromium supplies this origin; unlike referrer it cannot be forged by web content.
      // Electron identifies the packaged Renderer as file://; remote origins get no access.
      const initiator = (request as Request & { initiatorOrigin?: string }).initiatorOrigin;
      if (initiator !== undefined && initiator !== rendererOrigin)
        return new Response(null, { status: 403 });
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== 'artifact' || url.search || url.hash)
        return new Response(null, { status: 403 });
      const id = allowed.get(url.pathname.slice(1));
      const artifact = id ? repository.getArtifact(id) : null;
      const job = artifact ? repository.getJob(artifact.jobId) : null;
      const task = job ? repository.getTask(job.generationTaskId) : null;
      if (!artifact || !task || job?.state !== 'COMPLETED')
        return new Response(null, { status: 404 });
      const input = await artifacts.resolveInput(
        { artifactId: artifact.id, role: 'PREVIEW' },
        task,
        { signal: request.signal },
      );
      let start = 0,
        end = artifact.sizeBytes - 1,
        status = 200;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) return new Response(null, { status: 416 });
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start < 0 ||
          end >= artifact.sizeBytes
        )
          return new Response(null, { status: 416 });
        status = 206;
      }
      const selected = async function* () {
        let offset = 0;
        try {
          for await (const chunk of input.source.open(request.signal)) {
            const next = offset + chunk.byteLength;
            if (next > start && offset <= end)
              yield chunk.subarray(
                Math.max(0, start - offset),
                Math.min(chunk.byteLength, end - offset + 1),
              );
            offset = next;
            if (offset > end) break;
          }
        } finally {
          await input.source.cancel();
        }
      };
      const headers: Record<string, string> = {
        'Content-Type': artifact.mimeType,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${artifact.sizeBytes}`;
      if (request.method === 'HEAD') {
        await input.source.cancel();
        return new Response(null, { status, headers });
      }
      return new Response(Readable.toWeb(Readable.from(selected())) as ReadableStream<Uint8Array>, {
        status,
        headers,
      });
    } catch {
      return new Response(null, { status: 403 });
    }
  });
  const issue = async (id: string) => {
    const artifact = repository.getArtifact(id);
    const job = artifact ? repository.getJob(artifact.jobId) : null;
    if (!artifact || job?.state !== 'COMPLETED')
      throw new DomainError('NOT_FOUND', '生成结果不存在');
    if (allowed.size >= 4096) allowed.delete(allowed.keys().next().value!);
    const token = randomUUID();
    allowed.set(token, id);
    return `cultivation-media://artifact/${token}`;
  };
  previews.set(session, issue);
  return issue;
}
