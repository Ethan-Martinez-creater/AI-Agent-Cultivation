/* global URL, fetch */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JSON_LIMIT = 256 * 1024;
const INPUT_LIMIT = 1024 * 1024;

function makeWav(seconds, frequency, sampleRate = 16_000) {
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.floor(seconds * sampleRate);
  const dataBytes = sampleCount * channels * (bitsPerSample / 8);
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  bytes.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  for (let sample = 0; sample < sampleCount; sample++) {
    const envelope = Math.min(1, sample / 160, (sampleCount - sample) / 160);
    const value = Math.round(
      Math.sin((2 * Math.PI * frequency * sample) / sampleRate) * 5000 * envelope,
    );
    bytes.writeInt16LE(value, 44 + sample * 2);
  }
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const visual = readFileSync(new URL('./news-media/visual.png', import.meta.url));
const video = readFileSync(new URL('./g2-media/h3-generated-video.mp4', import.meta.url));
const music = makeWav(1.2, 220);
const speech = makeWav(0.8, 440);

const models = [
  {
    modelId: 'fixture-image',
    outputCapability: 'IMAGE_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: ['TEXT_TO_IMAGE'],
    inputRoles: [],
    parameterSchema: { type: 'object', properties: {} },
    outputTypes: ['image/png'],
    limits: {
      maxInputFiles: 0,
      maxInputBytes: INPUT_LIMIT,
      maxOutputBytes: 2 * 1024 * 1024,
      maxOutputs: 1,
    },
  },
  {
    modelId: 'fixture-video',
    outputCapability: 'VIDEO_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO'],
    inputRoles: [
      { role: 'FIRST_FRAME', artifactKinds: ['IMAGE'], mimeTypes: ['image/png'], maxFiles: 1 },
    ],
    parameterSchema: { type: 'object', properties: {} },
    outputTypes: ['video/mp4'],
    limits: {
      maxInputFiles: 1,
      maxInputBytes: INPUT_LIMIT,
      maxOutputBytes: 2 * 1024 * 1024,
      maxOutputs: 1,
      minDurationSeconds: 1,
      maxDurationSeconds: 10,
    },
  },
  {
    modelId: 'fixture-music',
    outputCapability: 'MUSIC_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: ['TEXT_TO_MUSIC'],
    inputRoles: [],
    parameterSchema: { type: 'object', properties: {} },
    outputTypes: ['audio/wav'],
    limits: {
      maxInputFiles: 0,
      maxInputBytes: INPUT_LIMIT,
      maxOutputBytes: 2 * 1024 * 1024,
      maxOutputs: 1,
    },
  },
  {
    modelId: 'fixture-speech',
    outputCapability: 'SPEECH_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: ['TEXT_TO_SPEECH'],
    inputRoles: [],
    parameterSchema: { type: 'object', properties: {} },
    outputTypes: ['audio/wav'],
    limits: {
      maxInputFiles: 0,
      maxInputBytes: INPUT_LIMIT,
      maxOutputBytes: 2 * 1024 * 1024,
      maxOutputs: 1,
    },
  },
];

const media = new Map([
  ['fixture-image', { mimeType: 'image/png', extension: 'png', bytes: visual }],
  ['fixture-video', { mimeType: 'video/mp4', extension: 'mp4', bytes: video }],
  ['fixture-music', { mimeType: 'audio/wav', extension: 'wav', bytes: music }],
  ['fixture-speech', { mimeType: 'audio/wav', extension: 'wav', bytes: speech }],
]);

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  response.end(bytes);
}

function sendError(response, status, code) {
  sendJson(response, status, {
    error: { accepted: false, code, message: 'Offline fixture rejected the bounded request' },
  });
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RangeError('Fixture request body exceeded its limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function expectedFeature(model, inputs) {
  if (inputs.length) {
    return inputs.some((input) => input.role === 'FIRST_FRAME') ? 'IMAGE_TO_VIDEO' : null;
  }
  if (model.outputCapability.startsWith('IMAGE_')) return 'TEXT_TO_IMAGE';
  if (model.outputCapability === 'VIDEO_GENERATION') return 'TEXT_TO_VIDEO';
  if (model.outputCapability === 'MUSIC_GENERATION') return 'TEXT_TO_MUSIC';
  return 'TEXT_TO_SPEECH';
}

/** Independent offline GEN_HTTP_V1 server. Imported only by smoke/tests, never by production Main. */
export async function startGenHttpV1Fixture() {
  const facts = {
    uploads: [],
    submissions: [],
    postAttempts: 0,
    downloads: 0,
    statusQueries: 0,
    healthChecks: 0,
    modelQueries: 0,
  };
  const uploadsByKey = new Map();
  const uploadsById = new Map();
  const jobsByKey = new Map();
  const jobsById = new Map();
  let uploadSequence = 0;
  let jobSequence = 0;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        facts.healthChecks++;
        return sendJson(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        facts.modelQueries++;
        return sendJson(response, 200, { protocol: 'GEN_HTTP_V1', models });
      }
      if (request.method === 'POST' && url.pathname === '/v1/files') {
        const artifactId = String(request.headers['x-artifact-id'] ?? '');
        const role = String(request.headers['x-input-role'] ?? '');
        const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
        const mimeType = String(request.headers['content-type'] ?? '')
          .split(';')[0]
          .trim();
        const expectedHash = String(request.headers['x-content-sha256'] ?? '');
        const expectedSize = Number(request.headers['x-content-size']);
        const roleDescriptor = models
          .flatMap((model) => model.inputRoles)
          .find((candidate) => candidate.role === role && candidate.mimeTypes.includes(mimeType));
        if (
          !/^[A-Za-z0-9._:-]{1,512}$/u.test(idempotencyKey) ||
          !/^[A-Za-z0-9._:-]{1,128}$/u.test(artifactId) ||
          !roleDescriptor ||
          !Number.isSafeInteger(expectedSize) ||
          expectedSize < 1 ||
          expectedSize > INPUT_LIMIT ||
          !/^[a-f0-9]{64}$/u.test(expectedHash)
        )
          return sendError(response, 400, 'INVALID_INPUT');

        const bytes = await readBody(request, INPUT_LIMIT);
        const contentHash = sha256(bytes);
        if (bytes.length !== expectedSize || contentHash !== expectedHash)
          return sendError(response, 400, 'INVALID_INPUT');
        const previous = uploadsByKey.get(idempotencyKey);
        if (previous) {
          if (
            previous.artifactId !== artifactId ||
            previous.role !== role ||
            previous.mimeType !== mimeType ||
            previous.contentHash !== contentHash ||
            previous.sizeBytes !== bytes.length
          )
            return sendError(response, 409, 'IDEMPOTENCY_CONFLICT');
          return sendJson(response, 200, previous.response);
        }

        const fileId = `fixture_file_${++uploadSequence}`;
        const entry = {
          artifactId,
          role,
          mimeType,
          contentHash,
          sizeBytes: bytes.length,
          bytes,
          response: { fileId, mimeType, sizeBytes: bytes.length, contentHash },
        };
        uploadsByKey.set(idempotencyKey, entry);
        uploadsById.set(fileId, entry);
        facts.uploads.push({
          fileId,
          artifactId,
          role,
          mimeType,
          sizeBytes: bytes.length,
          contentHash,
        });
        return sendJson(response, 200, entry.response);
      }
      if (request.method === 'POST' && url.pathname === '/v1/generations') {
        facts.postAttempts++;
        const idempotencyKey = String(request.headers['idempotency-key'] ?? '');
        if (!/^[A-Za-z0-9._:-]{1,512}$/u.test(idempotencyKey))
          return sendError(response, 400, 'INVALID_INPUT');
        const bytes = await readBody(request, JSON_LIMIT);
        let body;
        try {
          body = JSON.parse(bytes.toString('utf8'));
        } catch {
          return sendError(response, 400, 'INVALID_INPUT');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return sendError(response, 400, 'INVALID_INPUT');
        const model = models.find((candidate) => candidate.modelId === body.model);
        if (
          !model ||
          body.capability !== model.outputCapability ||
          typeof body.prompt !== 'string' ||
          body.prompt.trim().length === 0 ||
          body.prompt.length > 12_000 ||
          !Array.isArray(body.inputs) ||
          body.inputs.length > model.limits.maxInputFiles ||
          !Array.isArray(body.requiredFeatures) ||
          body.requiredFeatures.some((feature) => !model.featureTags.includes(feature)) ||
          !body.requiredFeatures.includes(expectedFeature(model, body.inputs)) ||
          !body.parameters ||
          typeof body.parameters !== 'object' ||
          Array.isArray(body.parameters)
        )
          return sendError(response, 400, 'INVALID_INPUT');

        const roleCounts = new Map();
        for (const input of body.inputs) {
          const role = model.inputRoles.find((candidate) => candidate.role === input.role);
          const uploaded = uploadsById.get(input.fileId);
          if (
            !role ||
            !uploaded ||
            uploaded.artifactId !== input.artifactId ||
            uploaded.role !== input.role ||
            uploaded.contentHash !== input.contentHash ||
            !role.mimeTypes.includes(uploaded.mimeType)
          )
            return sendError(response, 400, 'INVALID_INPUT');
          const count = (roleCounts.get(input.role) ?? 0) + 1;
          if (count > role.maxFiles) return sendError(response, 400, 'INVALID_INPUT');
          roleCounts.set(input.role, count);
        }

        const fingerprint = JSON.stringify(body);
        const previous = jobsByKey.get(idempotencyKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return sendError(response, 409, 'IDEMPOTENCY_CONFLICT');
          return sendJson(response, 200, {
            providerJobId: previous.providerJobId,
            status: 'QUEUED',
          });
        }

        const selectedOutput = media.get(model.modelId);
        const providerJobId = `fixture_job_${++jobSequence}`;
        const output = {
          id: 'output_0',
          mimeType: selectedOutput.mimeType,
          extension: selectedOutput.extension,
          sizeBytes: selectedOutput.bytes.length,
          contentHash: sha256(selectedOutput.bytes),
          metadata: {},
        };
        const job = {
          providerJobId,
          model,
          fingerprint,
          body,
          output,
          bytes: selectedOutput.bytes,
          polls: 0,
        };
        jobsByKey.set(idempotencyKey, job);
        jobsById.set(providerJobId, job);
        facts.submissions.push({
          providerJobId,
          model: model.modelId,
          capability: model.outputCapability,
          requiredFeatures: [...body.requiredFeatures],
          inputs: body.inputs.map((input) => ({
            fileId: input.fileId,
            artifactId: input.artifactId,
            role: input.role,
            contentHash: input.contentHash,
          })),
        });
        return sendJson(response, 202, { providerJobId, status: 'QUEUED' });
      }

      const downloadMatch = /^\/v1\/generations\/([^/]+)\/outputs\/([^/]+)\/download$/u.exec(
        url.pathname,
      );
      if (request.method === 'GET' && downloadMatch) {
        const providerJobId = decodeURIComponent(downloadMatch[1]);
        const outputId = decodeURIComponent(downloadMatch[2]);
        const job = jobsById.get(providerJobId);
        if (!job || job.output.id !== outputId || job.polls < 2)
          return sendError(response, 404, 'OUTPUT_MISSING');
        facts.downloads++;
        response.writeHead(200, {
          'content-type': job.output.mimeType,
          'content-length': job.output.sizeBytes,
          'cache-control': 'no-store',
        });
        response.end(job.bytes);
        return;
      }

      const statusMatch = /^\/v1\/generations\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && statusMatch) {
        const providerJobId = decodeURIComponent(statusMatch[1]);
        const job = jobsById.get(providerJobId);
        if (!job) return sendError(response, 404, 'MODEL_NOT_FOUND');
        facts.statusQueries++;
        job.polls++;
        const status = job.polls < 2 ? 'RUNNING' : 'COMPLETED';
        return sendJson(response, 200, {
          providerJobId,
          status,
          outputs: status === 'COMPLETED' ? [job.output] : [],
          errorCode: null,
        });
      }

      return sendError(response, 404, 'INVALID_INPUT');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      return sendError(response, error instanceof RangeError ? 413 : 500, 'INVALID_INPUT');
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: `${origin}/v1`,
    facts,
    media: { image: visual, video, music, speech },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

export async function runGenHttpV1FixtureSelfTest() {
  const fixture = await startGenHttpV1Fixture();
  try {
    const health = await fetch(new URL('/health', fixture.baseUrl));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const descriptorResponse = await fetch(new URL('/v1/models', fixture.baseUrl));
    assert.equal(descriptorResponse.status, 200);
    const descriptorBody = await descriptorResponse.json();
    assert.equal(descriptorBody.protocol, 'GEN_HTTP_V1');
    assert.deepEqual(
      new Set(descriptorBody.models.map((model) => model.outputCapability)),
      new Set(['IMAGE_GENERATION', 'VIDEO_GENERATION', 'MUSIC_GENERATION', 'SPEECH_GENERATION']),
    );

    const imageHash = sha256(fixture.media.image);
    const uploadResponse = await fetch(new URL('/v1/files', fixture.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-artifact-id': 'selftest-image-artifact',
        'x-input-role': 'FIRST_FRAME',
        'x-content-sha256': imageHash,
        'x-content-size': String(fixture.media.image.length),
        'idempotency-key': 'selftest:image:artifact:FIRST_FRAME',
      },
      body: fixture.media.image,
    });
    assert.equal(uploadResponse.status, 200);
    const uploaded = await uploadResponse.json();
    assert.deepEqual(
      {
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
        contentHash: uploaded.contentHash,
      },
      { mimeType: 'image/png', sizeBytes: fixture.media.image.length, contentHash: imageHash },
    );

    const body = {
      model: 'fixture-image',
      capability: 'IMAGE_GENERATION',
      requiredFeatures: ['TEXT_TO_IMAGE'],
      prompt: 'Synthetic offline fixture image',
      inputs: [],
      parameters: {},
    };
    const submissionHeaders = {
      'content-type': 'application/json',
      'idempotency-key': 'selftest:image-generation',
    };
    const firstSubmission = await fetch(new URL('/v1/generations', fixture.baseUrl), {
      method: 'POST',
      headers: submissionHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(firstSubmission.status, 202);
    const firstJob = await firstSubmission.json();
    const duplicateSubmission = await fetch(new URL('/v1/generations', fixture.baseUrl), {
      method: 'POST',
      headers: submissionHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(duplicateSubmission.status, 200);
    assert.equal((await duplicateSubmission.json()).providerJobId, firstJob.providerJobId);
    const changedSubmission = await fetch(new URL('/v1/generations', fixture.baseUrl), {
      method: 'POST',
      headers: submissionHeaders,
      body: JSON.stringify({ ...body, prompt: 'Changed request must not reuse the key' }),
    });
    assert.equal(changedSubmission.status, 409);
    assert.equal((await changedSubmission.json()).error.code, 'IDEMPOTENCY_CONFLICT');

    const jobPath = `/v1/generations/${firstJob.providerJobId}`;
    assert.equal((await fetch(new URL(jobPath, fixture.baseUrl))).status, 200);
    const completed = await fetch(new URL(jobPath, fixture.baseUrl));
    assert.equal(completed.status, 200);
    const completedBody = await completed.json();
    assert.equal(completedBody.status, 'COMPLETED');
    assert.equal(completedBody.outputs[0].mimeType, 'image/png');
    const download = await fetch(new URL(`${jobPath}/outputs/output_0/download`, fixture.baseUrl));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), fixture.media.image);

    const remainingModels = [
      {
        model: 'fixture-video',
        capability: 'VIDEO_GENERATION',
        feature: 'IMAGE_TO_VIDEO',
        mimeType: 'video/mp4',
        bytes: fixture.media.video,
        inputs: [
          {
            fileId: uploaded.fileId,
            artifactId: 'selftest-image-artifact',
            role: 'FIRST_FRAME',
            contentHash: imageHash,
          },
        ],
      },
      {
        model: 'fixture-music',
        capability: 'MUSIC_GENERATION',
        feature: 'TEXT_TO_MUSIC',
        mimeType: 'audio/wav',
        bytes: fixture.media.music,
        inputs: [],
      },
      {
        model: 'fixture-speech',
        capability: 'SPEECH_GENERATION',
        feature: 'TEXT_TO_SPEECH',
        mimeType: 'audio/wav',
        bytes: fixture.media.speech,
        inputs: [],
      },
    ];
    for (const [index, model] of remainingModels.entries()) {
      const response = await fetch(new URL('/v1/generations', fixture.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `selftest:other:${index}`,
        },
        body: JSON.stringify({
          model: model.model,
          capability: model.capability,
          requiredFeatures: [model.feature],
          prompt: `Synthetic offline ${model.capability} output`,
          inputs: model.inputs,
          parameters: {},
        }),
      });
      assert.equal(response.status, 202);
      const submitted = await response.json();
      const jobPath = `/v1/generations/${submitted.providerJobId}`;
      await fetch(new URL(jobPath, fixture.baseUrl));
      const status = await fetch(new URL(jobPath, fixture.baseUrl));
      const result = await status.json();
      assert.equal(result.status, 'COMPLETED');
      assert.equal(result.outputs[0].mimeType, model.mimeType);
      assert.equal(result.outputs[0].contentHash, sha256(model.bytes));
      const downloadResponse = await fetch(
        new URL(`${jobPath}/outputs/output_0/download`, fixture.baseUrl),
      );
      assert.equal(downloadResponse.headers.get('content-type'), model.mimeType);
      assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), model.bytes);
    }

    assert.equal(fixture.facts.uploads.length, 1);
    assert.equal(fixture.facts.submissions.length, 4);
    assert.equal(fixture.facts.postAttempts, 6);
    assert.equal(fixture.facts.downloads, 4);
  } finally {
    await fixture.close();
  }
  return { ok: true, capabilities: models.map((model) => model.outputCapability) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runGenHttpV1FixtureSelfTest();
  console.log(`GEN_HTTP_V1_FIXTURE_OK capabilities=${result.capabilities.join(',')}`);
}
