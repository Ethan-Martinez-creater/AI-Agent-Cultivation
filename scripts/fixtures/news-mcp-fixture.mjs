import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stdin, stdout } from 'node:process';

const mediaArgument = process.argv.indexOf('--fixture-root');
const mediaRootValue = mediaArgument >= 0 ? process.argv[mediaArgument + 1] : undefined;
if (!mediaRootValue) throw new Error('Missing --fixture-root');
const mediaRoot = realpathSync(resolve(mediaRootValue));
const workspaceRoot = realpathSync(process.cwd());

const hash = (value) => createHash('sha256').update(value).digest('hex');
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const within = (root, candidate) => {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

function candidateSources(storyCount) {
  const candidateCount = Math.min(20, storyCount + 1);
  return Array.from({ length: candidateCount }, (_, index) => {
    const storyIndex = index === 1 ? 0 : index > 1 ? index - 1 : index;
    const eventKey = `synthetic-event-${storyIndex + 1}`;
    const url = `https://news.example.test/${eventKey}/${index + 1}`;
    return { url, contentHash: hash(`candidate synthetic content ${index + 1}`) };
  });
}

function researchSources(input) {
  const storyCount = input.targetStoryCount?.min;
  if (!Number.isInteger(storyCount) || storyCount < 1 || storyCount > 20) {
    throw new Error('Research fixture received invalid targetStoryCount');
  }
  const candidates = candidateSources(storyCount);
  if (input.stepId === 'N01') return candidates;
  if (input.stepId !== 'N03') throw new Error('Research fixture received an unsupported step');
  const sources = Array.from({ length: storyCount }, (_, index) => {
    const eventKey = `synthetic-event-${index + 1}`;
    return ['primary', 'independent_reliable'].map((tier) => {
      const url = `https://sources.example.test/${eventKey}/${tier}`;
      return { url, contentHash: hash(`synthetic source content ${url}`) };
    });
  }).flat();
  return [...candidates, ...sources];
}

function mediaNameIsValid(input) {
  const allowed =
    input.targetDurationSeconds === 60
      ? ['short60s.mp4', 'short.mp4']
      : input.targetDurationSeconds === 300
        ? ['weekly300s.mp4', 'weekly.mp4']
        : input.targetDurationSeconds === 180
          ? ['explainer180s.mp4', 'explainer120s.mp4', 'explainer.mp4']
          : [];
  return allowed.includes(input.sourceMediaName);
}

function commitAssembly(input) {
  if (!safeId(input.workflowRunId) || !safeId(input.stepRunId)) {
    throw new Error('Assembly fixture received invalid workflow IDs');
  }
  if (!mediaNameIsValid(input))
    throw new Error('Assembly fixture media does not match target duration');
  const expectedPath = `workflows/${input.workflowRunId}/${input.stepRunId}/output/draft.mp4`;
  if (input.outputPath !== expectedPath)
    throw new Error('Assembly fixture target path is not attempt-scoped');

  const sourcePath = realpathSync(join(mediaRoot, input.sourceMediaName));
  if (!within(mediaRoot, sourcePath))
    throw new Error('Assembly fixture source escaped its media root');
  const bytes = readFileSync(sourcePath);
  const outputPath = resolve(workspaceRoot, ...expectedPath.split('/'));
  if (!within(workspaceRoot, outputPath))
    throw new Error('Assembly fixture target escaped its workspace');
  const parentPath = dirname(outputPath);
  mkdirSync(parentPath, { recursive: true });
  const canonicalParent = realpathSync(parentPath);
  if (!within(workspaceRoot, canonicalParent))
    throw new Error('Assembly fixture parent escaped its workspace');
  if (existsSync(outputPath))
    throw new Error('Assembly fixture refuses to overwrite an existing file');

  const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
  writeFileSync(temporaryPath, bytes, { flag: 'wx' });
  renameSync(temporaryPath, outputPath);
  const committed = readFileSync(outputPath);
  const contentHash = createHash('sha256').update(committed).digest('hex');
  return {
    content: [{ type: 'text', text: 'Deterministic offline MP4 fixture committed.' }],
    structuredContent: {
      workflowEvidence: {
        artifactFiles: [{ path: expectedPath, contentHash }],
      },
    },
  };
}

function commitVoice(input) {
  if (
    !safeId(input.workflowRunId) ||
    !safeId(input.stepRunId) ||
    ![60, 180, 300].includes(input.targetDurationSeconds)
  )
    throw new Error('Invalid voice request');
  const expected = `workflows/${input.workflowRunId}/${input.stepRunId}/output/voice.wav`;
  if (input.outputPath !== expected) throw new Error('Invalid attempt voice path');
  const dataSize = input.targetDurationSeconds * 16000;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(dataSize, 40);
  const output = resolve(workspaceRoot, ...expected.split('/'));
  mkdirSync(dirname(output), { recursive: true });
  if (!within(workspaceRoot, realpathSync(dirname(output)))) throw new Error('Voice path escape');
  const temporary = `${output}.tmp-${randomUUID()}`;
  if (existsSync(output)) throw new Error('Voice already exists');
  writeFileSync(temporary, bytes, { flag: 'wx' });
  renameSync(temporary, output);
  return {
    content: [{ type: 'text', text: 'Audio delivery saved.' }],
    structuredContent: {
      workflowEvidence: { artifactFiles: [{ path: expected, contentHash: hash(bytes) }] },
    },
  };
}

const tools = [
  {
    name: 'research_news',
    description: 'Returns deterministic synthetic research provenance; performs no network access.',
    inputSchema: {
      type: 'object',
      properties: {
        stepId: { type: 'string', enum: ['N01', 'N03'] },
        workflowRunId: { type: 'string' },
        stepRunId: { type: 'string' },
        topicScope: { type: 'string' },
        targetDurationSeconds: { type: 'number' },
        targetStoryCount: {
          type: 'object',
          properties: { min: { type: 'integer' }, max: { type: 'integer' } },
          required: ['min', 'max'],
          additionalProperties: false,
        },
        timeRange: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
      required: [
        'stepId',
        'workflowRunId',
        'stepRunId',
        'topicScope',
        'targetDurationSeconds',
        'targetStoryCount',
        'timeRange',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'assemble_video',
    description: 'Copies one actual offline test MP4 into the current workflow attempt output.',
    inputSchema: {
      type: 'object',
      properties: {
        stepId: { type: 'string', const: 'N12' },
        workflowRunId: { type: 'string' },
        stepRunId: { type: 'string' },
        topicScope: { type: 'string' },
        targetDurationSeconds: { type: 'number', enum: [60, 180, 300] },
        targetStoryCount: {
          type: 'object',
          properties: { min: { type: 'integer' }, max: { type: 'integer' } },
          required: ['min', 'max'],
          additionalProperties: false,
        },
        timeRange: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        sourceMediaName: { type: 'string' },
        outputPath: { type: 'string' },
      },
      required: [
        'stepId',
        'workflowRunId',
        'stepRunId',
        'topicScope',
        'targetDurationSeconds',
        'targetStoryCount',
        'timeRange',
        'sourceMediaName',
        'outputPath',
      ],
      additionalProperties: false,
    },
  },
];
// An ordinary third-party descriptor: no cultivation metadata.
tools.push({
  name: 'voiceover',
  description: 'Creates an offline WAV delivery.',
  inputSchema: {
    type: 'object',
    properties: {
      stepId: { const: 'N11' },
      workflowRunId: { type: 'string' },
      stepRunId: { type: 'string' },
      topicScope: { type: 'string' },
      targetDurationSeconds: { type: 'number', enum: [60, 180, 300] },
      targetStoryCount: { type: 'object' },
      timeRange: { type: 'object' },
      outputPath: { type: 'string' },
    },
    required: ['stepId', 'workflowRunId', 'stepRunId', 'targetDurationSeconds', 'outputPath'],
    additionalProperties: false,
  },
});

let buffer = Buffer.alloc(0);
let framing = 'line';
stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

function readMessages() {
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (match) {
        framing = 'content-length';
        const contentLength = Number(match[1]);
        const messageStart = headerEnd + 4;
        if (buffer.length < messageStart + contentLength) return;
        const payload = buffer
          .subarray(messageStart, messageStart + contentLength)
          .toString('utf8');
        buffer = buffer.subarray(messageStart + contentLength);
        void handleMessage(JSON.parse(payload));
        continue;
      }
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const payload = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    buffer = buffer.subarray(newline + 1);
    if (payload.trim()) void handleMessage(JSON.parse(payload));
  }
}

async function handleMessage(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-news-deterministic-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    return;
  }
  if (message.method === 'tools/call') {
    const input = message.params?.arguments ?? {};
    try {
      const result =
        message.params?.name === 'research_news'
          ? {
              content: [
                { type: 'text', text: 'Synthetic acceptance fixture only; no internet research.' },
              ],
              structuredContent: {
                workflowEvidence: { researchSources: researchSources(input) },
              },
            }
          : message.params?.name === 'assemble_video'
            ? commitAssembly(input)
            : message.params?.name === 'voiceover'
              ? commitVoice(input)
              : null;
      if (!result) throw new Error('Unknown fixture tool');
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [
            { type: 'text', text: error instanceof Error ? error.message : 'Fixture tool failed.' },
          ],
        },
      });
    }
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Method not found' },
    });
  }
}

function send(message) {
  const payload = JSON.stringify(message);
  if (framing === 'content-length') {
    stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  } else {
    stdout.write(`${payload}\n`);
  }
}
