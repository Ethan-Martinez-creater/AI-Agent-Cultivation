import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

/** Offline HTTP fixture, launched only by tests/smoke; production never imports it. */
export async function startH3Fixture() {
  const video = readFileSync(
    fileURLToPath(new URL('./g2-media/h3-generated-video.mp4', import.meta.url)),
  );
  const png = readFileSync(fileURLToPath(new URL('./news-media/visual.png', import.meta.url)));
  const facts = {
    uploads: 0,
    submissions: 0,
    downloads: 0,
    statusQueries: 0,
    healthChecks: 0,
    models: 0,
    keys: [],
    requests: [],
  };
  const mode = {
    offline: false,
    uncertain: false,
    uploadHashMismatch: false,
    downloadInterrupted: false,
    hold: false,
  };
  const jobs = new Map();
  const fileIds = new Set();
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const error = (response, status, code) =>
    json(response, status, {
      error: { code, message: 'Fixture private error text must never reach UI', retryable: false },
    });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        facts.healthChecks++;
        return mode.offline
          ? error(response, 503, 'MODEL_UNAVAILABLE')
          : json(response, 200, { status: 'ok', service: 'minimax-h3-adapter', version: '0.2.0' });
      }
      if (mode.offline) return error(response, 503, 'MODEL_UNAVAILABLE');
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        facts.models++;
        return json(response, 200, {
          data: [
            {
              id: 'minimax-h3',
              output_capability: 'VIDEO_GENERATION',
              execution_mode: 'ASYNC_JOB',
              features: ['TEXT_TO_VIDEO', 'FIRST_FRAME_CONDITIONING'],
              input_roles: ['FIRST_FRAME'],
              limits: { min_duration_seconds: 4, max_duration_seconds: 15 },
              output_types: ['video/mp4'],
            },
          ],
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/files') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024 * 1024) return error(response, 413, 'INPUT_TOO_LARGE');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const type = String(request.headers['content-type']);
        const boundary = /boundary=([^;]+)/.exec(type)?.[1]?.replaceAll('"', '');
        if (!boundary) return error(response, 400, 'INVALID_INPUT');
        const begin = body.indexOf(Buffer.from('\r\n\r\n')) + 4;
        const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}`));
        if (begin < 4 || end < begin) return error(response, 400, 'INVALID_INPUT');
        const bytes = body.subarray(begin, end);
        facts.uploads++;
        const file_id = `file_${facts.uploads}`;
        fileIds.add(file_id);
        const mime = /Content-Type:\s*([^\r]+)/i.exec(
          body.subarray(0, begin).toString('utf8'),
        )?.[1];
        return json(response, 200, {
          file_id,
          mime_type: mime,
          size_bytes: bytes.length,
          sha256: mode.uploadHashMismatch
            ? '0'.repeat(64)
            : createHash('sha256').update(bytes).digest('hex'),
          created_at: '2026-10-05T00:00:00Z',
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/videos') {
        let text = '';
        for await (const chunk of request) {
          text += chunk;
          if (text.length > 64000) return error(response, 413, 'INVALID_INPUT');
        }
        const body = JSON.parse(text);
        const key = String(request.headers['idempotency-key'] ?? '');
        if (!key) return error(response, 400, 'INVALID_INPUT');
        const hash = createHash('sha256').update(text).digest('hex');
        const previous = jobs.get(key);
        if (previous) {
          return previous.hash === hash
            ? json(response, 200, { task_id: previous.id, status: 'queued' })
            : error(response, 409, 'IDEMPOTENCY_CONFLICT');
        }
        if (
          body.model !== 'minimax-h3' ||
          (body.media ?? []).some((m) => m.role !== 'first_frame' || !fileIds.has(m.file_id))
        )
          return error(response, 400, 'INVALID_INPUT');
        const value = { id: `job_${jobs.size + 1}`, hash, queries: 0, body };
        jobs.set(key, value);
        facts.submissions++;
        facts.keys.push(key);
        facts.requests.push(body);
        if (mode.uncertain) {
          request.socket.destroy();
          return;
        }
        return json(response, 202, { task_id: value.id, status: 'queued' });
      }
      const match = /^\/v1\/videos\/([^/]+)(?:\/(content|outputs\/([^/]+)))?$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const job = [...jobs.values()].find((j) => j.id === match[1]);
        if (!job) return error(response, 404, 'MODEL_NOT_FOUND');
        if (match[2]) {
          facts.downloads++;
          response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length });
          if (mode.downloadInterrupted) {
            mode.downloadInterrupted = false;
            response.write(video.subarray(0, 16));
            response.destroy();
            return;
          }
          for (let offset = 0; offset < video.length; offset += 1024)
            response.write(video.subarray(offset, offset + 1024));
          response.end();
          return;
        }
        facts.statusQueries++;
        job.queries++;
        const status = mode.hold ? 'running' : job.queries === 1 ? 'running' : 'completed';
        return json(response, 200, {
          task_id: job.id,
          status,
          progress: null,
          outputs:
            status === 'completed'
              ? [{ id: 'output_0', mime_type: 'video/mp4', size_bytes: video.length }]
              : [],
          error: null,
        });
      }
      error(response, 404, 'INVALID_INPUT');
    } catch {
      if (!response.headersSent) error(response, 500, 'INTERNAL_ERROR');
      else response.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    facts,
    mode,
    video,
    png,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
