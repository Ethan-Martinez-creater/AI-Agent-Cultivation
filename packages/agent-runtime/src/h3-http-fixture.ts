import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type H3HttpFixtureMode =
  | 'normal'
  | 'full-capability'
  | 'auth-error'
  | 'unknown-feature'
  | 'unknown-role'
  | 'role-without-feature'
  | 'invalid-parameter-schema'
  | 'narrow-parameter-schema'
  | 'queue-full'
  | 'unknown-submit'
  | 'wrong-output-size'
  | 'wrong-output-mime'
  | 'download-unavailable'
  | 'redirect-health';

export interface H3HttpFixtureStats {
  uploadRequests: number;
  submitRequests: number;
  createdJobs: number;
  downloadRequests: number;
  lastSubmitBody: Record<string, unknown> | null;
  lastIdempotencyKey: string | null;
}

interface FixtureJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}

const fixtureMp4 = readFileSync(
  new URL('../../../scripts/fixtures/news-media/short.mp4', import.meta.url),
);
const fixtureApiKey = 'fixture-secret';

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
  });
  response.end(body);
}

async function readRequest(request: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const item of request) {
    const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('Fixture request exceeds its bound.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function parseMultipartFile(
  request: IncomingMessage,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const contentType = request.headers['content-type'] ?? '';
  const boundaryMatch = /(?:^|;)\s*boundary=([^;]+)/i.exec(contentType);
  if (!boundaryMatch) throw new Error('Missing multipart boundary.');
  const boundary = boundaryMatch[1]!.replace(/^"|"$/g, '');
  const body = await readRequest(request);
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'));
  const end = body.lastIndexOf(Buffer.from('\r\n--' + boundary + '--'));
  if (headerEnd < 0 || end < headerEnd + 4) throw new Error('Invalid multipart file part.');
  const header = body.subarray(0, headerEnd).toString('utf8');
  const mimeMatch = /^Content-Type:\s*([^\r\n]+)/im.exec(header);
  if (!/Content-Disposition:\s*form-data;\s*name="file";\s*filename="input\./i.test(header))
    throw new Error('Unexpected multipart field.');
  return {
    bytes: Buffer.from(body.subarray(headerEnd + 4, end)),
    mimeType: mimeMatch?.[1]?.trim() ?? '',
  };
}

function fixtureError(code: string, message = 'offline fixture error'): { error: object } {
  return { error: { code, message } };
}

export interface H3HttpFixture {
  baseUrl: string;
  server: Server;
  setMode(mode: H3HttpFixtureMode): void;
  setJobStatus(providerJobId: string, status: FixtureJob['status']): void;
  stats(): H3HttpFixtureStats;
  close(): Promise<void>;
}

export async function startH3HttpFixture(): Promise<H3HttpFixture> {
  let mode: H3HttpFixtureMode = 'normal';
  let nextFileId = 0;
  let nextJobId = 0;
  let downloadRequests = 0;
  let uploadRequests = 0;
  let submitRequests = 0;
  let lastSubmitBody: Record<string, unknown> | null = null;
  let lastIdempotencyKey: string | null = null;
  const jobs = new Map<string, FixtureJob>();
  const uploads = new Map<string, { bytes: Buffer; mimeType: string; sha256: string }>();
  const byIdempotencyKey = new Map<string, { body: string; jobId: string }>();

  const server = createServer((request, response) => {
    void (async () => {
      if (mode === 'auth-error') {
        sendJson(response, 401, fixtureError('AUTH_FAILED', 'secret=' + fixtureApiKey));
        return;
      }
      if (request.headers.authorization !== 'Bearer ' + fixtureApiKey) {
        sendJson(response, 401, fixtureError('AUTH_FAILED'));
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/health' && request.method === 'GET') {
        if (mode === 'redirect-health') {
          response.writeHead(302, { location: 'https://example.invalid/health' });
          response.end();
          return;
        }
        sendJson(response, 200, {
          status: 'ok',
          service: 'minimax-h3-adapter',
          version: '0.2.0',
        });
        return;
      }
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        const features =
          mode === 'unknown-feature'
            ? ['TEXT_TO_VIDEO', 'MYSTERY_FEATURE']
            : mode === 'full-capability'
              ? [
                  'TEXT_TO_VIDEO',
                  'FIRST_FRAME_CONDITIONING',
                  'REFERENCE_CONDITIONING',
                  'VIDEO_TO_AUDIO',
                  'NATIVE_AUDIO',
                ]
              : ['TEXT_TO_VIDEO', 'FIRST_FRAME_CONDITIONING'];
        sendJson(response, 200, {
          data: [
            {
              id: 'minimax-h3',
              output_capability: 'VIDEO_GENERATION',
              execution_mode: 'ASYNC_JOB',
              features,
              input_roles:
                mode === 'full-capability'
                  ? [
                      'FIRST_FRAME',
                      'LAST_FRAME',
                      'REFERENCE_IMAGE',
                      'REFERENCE_VIDEO',
                      'REFERENCE_AUDIO',
                      'SOURCE_VIDEO',
                    ]
                  : mode === 'unknown-role'
                    ? ['FIRST_FRAME', 'MASK']
                    : mode === 'role-without-feature'
                      ? ['FIRST_FRAME', 'REFERENCE_IMAGE']
                      : ['FIRST_FRAME'],
              limits: {
                min_duration_seconds: 4,
                max_duration_seconds: 15,
              },
              output_types: ['video/mp4'],
              ...(mode === 'invalid-parameter-schema'
                ? {
                    parameter_schema: {
                      type: 'object',
                      properties: { surprise: { type: 'string' } },
                    },
                  }
                : mode === 'narrow-parameter-schema'
                  ? {
                      parameter_schema: {
                        type: 'object',
                        properties: {
                          duration: { type: 'integer', minimum: 5, maximum: 10 },
                          aspect: { type: 'string', enum: ['1:1'] },
                          seed: { type: 'integer', minimum: 4, maximum: 99 },
                          task: { type: 'string', enum: ['auto'] },
                        },
                        required: ['duration'],
                        additionalProperties: false,
                      },
                    }
                  : {}),
            },
          ],
        });
        return;
      }
      if (url.pathname === '/v1/files' && request.method === 'POST') {
        uploadRequests += 1;
        if (mode === 'queue-full') {
          sendJson(response, 429, fixtureError('QUEUE_FULL'));
          return;
        }
        const file = await parseMultipartFile(request);
        const fileId = 'file_' + ++nextFileId;
        const digest = createHash('sha256').update(file.bytes).digest('hex');
        uploads.set(fileId, {
          bytes: file.bytes,
          mimeType: file.mimeType,
          sha256: digest,
        });
        sendJson(response, 200, {
          file_id: fileId,
          mime_type: file.mimeType,
          size_bytes: file.bytes.byteLength,
          sha256: digest,
          created_at: '2026-10-05T00:00:00.000Z',
        });
        return;
      }
      if (url.pathname === '/v1/videos' && request.method === 'POST') {
        submitRequests += 1;
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string') {
          sendJson(response, 400, fixtureError('INVALID_INPUT'));
          return;
        }
        const bodyBytes = await readRequest(request, 256 * 1024);
        const bodyText = bodyBytes.toString('utf8');
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        lastSubmitBody = body;
        lastIdempotencyKey = key;
        const existing = byIdempotencyKey.get(key);
        if (existing) {
          if (existing.body !== bodyText) {
            sendJson(response, 409, fixtureError('IDEMPOTENCY_CONFLICT'));
            return;
          }
          sendJson(response, 200, { task_id: existing.jobId, status: 'queued' });
          return;
        }
        if (mode === 'queue-full') {
          sendJson(response, 429, fixtureError('QUEUE_FULL'));
          return;
        }
        const jobId = 'gen_' + ++nextJobId;
        jobs.set(jobId, { id: jobId, status: 'queued' });
        byIdempotencyKey.set(key, { body: bodyText, jobId });
        if (mode === 'unknown-submit') {
          response.destroy();
          return;
        }
        sendJson(response, 200, { task_id: jobId, status: 'queued' });
        return;
      }
      const jobMatch = /^\/v1\/videos\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
      if (jobMatch && request.method === 'GET') {
        const job = jobs.get(decodeURIComponent(jobMatch[1]!));
        if (!job) {
          sendJson(response, 404, fixtureError('MODEL_NOT_FOUND'));
          return;
        }
        const output = {
          id: 'output_0',
          mime_type: mode === 'wrong-output-mime' ? 'video/webm' : 'video/mp4',
          size_bytes:
            mode === 'wrong-output-size' ? fixtureMp4.byteLength + 1 : fixtureMp4.byteLength,
          duration_seconds: 1,
          width: 640,
          height: 360,
          fps: 24,
        };
        sendJson(response, 200, {
          task_id: job.id,
          status: job.status,
          progress: null,
          outputs: job.status === 'completed' ? [output] : [],
          error: job.status === 'failed' ? fixtureError('GENERATION_FAILED').error : null,
        });
        return;
      }
      const outputMatch = /^\/v1\/videos\/([A-Za-z0-9._-]+)\/outputs\/([A-Za-z0-9._-]+)$/.exec(
        url.pathname,
      );
      if (outputMatch && request.method === 'GET') {
        downloadRequests += 1;
        if (mode === 'download-unavailable') {
          sendJson(response, 503, fixtureError('MODEL_UNAVAILABLE'));
          return;
        }
        const job = jobs.get(decodeURIComponent(outputMatch[1]!));
        if (!job || job.status !== 'completed') {
          sendJson(response, 404, fixtureError('OUTPUT_MISSING'));
          return;
        }
        response.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': fixtureMp4.byteLength,
        });
        for (let offset = 0; offset < fixtureMp4.byteLength; offset += 16 * 1024)
          response.write(fixtureMp4.subarray(offset, offset + 16 * 1024));
        response.end();
        return;
      }
      sendJson(response, 404, fixtureError('MODEL_NOT_FOUND'));
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, fixtureError('INTERNAL_ERROR'));
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: 'http://127.0.0.1:' + address.port,
    server,
    setMode(nextMode) {
      mode = nextMode;
    },
    setJobStatus(providerJobId, status) {
      const job = jobs.get(providerJobId);
      if (job) job.status = status;
    },
    stats() {
      return {
        uploadRequests,
        submitRequests,
        createdJobs: jobs.size,
        downloadRequests,
        lastSubmitBody,
        lastIdempotencyKey,
      };
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
