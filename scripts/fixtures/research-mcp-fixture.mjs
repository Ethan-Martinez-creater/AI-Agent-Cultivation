import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { stdin, stdout } from 'node:process';

// Offline deterministic acceptance fixture. It has no network, shell, or ambient-secret access.
const workspaceRoot = realpathSync(process.cwd());
let buffer = Buffer.alloc(0);
let framing = 'line';
let handling = Promise.resolve();

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const isWithin = (root, candidate) => {
  const relativePath = relative(root, candidate);
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
};
const isSafeRelative = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes('\\') &&
  !isAbsolute(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');

const sourceSnapshots = [
  {
    title: 'The Tail at Scale',
    authors: ['Jeffrey Dean', 'Luiz André Barroso'],
    year: 2013,
    source: 'Google Research publication record',
    url: 'https://research.google/pubs/the-tail-at-scale/',
    doi: '',
    identifier: 'https://research.google/pubs/the-tail-at-scale/',
    summary: '离线验收来源快照：该出版记录讨论大型在线服务的尾延迟与降低尾延迟的系统设计。',
  },
  {
    title: 'Iris',
    authors: [],
    year: 1988,
    source: 'UCI Machine Learning Repository',
    url: 'https://archive.ics.uci.edu/dataset/53/iris',
    doi: '',
    identifier: 'https://archive.ics.uci.edu/dataset/53/iris',
    summary: '离线验收来源快照：UCI Machine Learning Repository 的 Iris 数据集目录记录。',
  },
];

function sourceRows(input) {
  if (
    !safeId(input.workflowRunId) ||
    !safeId(input.stepRunId) ||
    typeof input.researchQuestion !== 'string' ||
    input.researchQuestion.length < 10 ||
    input.researchQuestion.length > 3000 ||
    typeof input.field !== 'string' ||
    input.field.length < 2 ||
    input.field.length > 200 ||
    !Number.isInteger(input.maxResults) ||
    input.maxResults < 1 ||
    input.maxResults > 8
  )
    throw new Error('research_sources received invalid bounded input');

  const range = input.literatureTimeRange;
  if (range !== undefined && (!range || typeof range !== 'object' || Array.isArray(range)))
    throw new Error('research_sources received an invalid date range');
  const from = typeof range?.from === 'string' ? Number(range.from.slice(0, 4)) : -Infinity;
  const to = typeof range?.to === 'string' ? Number(range.to.slice(0, 4)) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(to) || from > to)
    throw new Error('research_sources received an invalid date range');

  return sourceSnapshots
    .filter((source) => source.year >= from && source.year <= to)
    .slice(0, input.maxResults)
    .map((source) => {
      const snapshot = JSON.stringify({
        title: source.title,
        authors: source.authors,
        year: source.year,
        source: source.source,
        url: source.url,
        summary: source.summary,
      });
      return { ...source, contentHash: hash(snapshot) };
    });
}

function checkedWorkspacePath(relativePath) {
  if (!isSafeRelative(relativePath))
    throw new Error('Fixture path is not a safe workspace-relative path');
  const absolutePath = resolve(workspaceRoot, ...relativePath.split('/'));
  if (!isWithin(workspaceRoot, absolutePath)) throw new Error('Fixture path escaped Workspace');
  return absolutePath;
}

function writeOutput(relativePath, bytes) {
  const absolutePath = checkedWorkspacePath(relativePath);
  const parentPath = dirname(absolutePath);
  mkdirSync(parentPath, { recursive: true });
  const canonicalParent = realpathSync(parentPath);
  if (!isWithin(workspaceRoot, canonicalParent))
    throw new Error('Fixture output parent escaped Workspace');
  if (existsSync(absolutePath)) {
    if (lstatSync(absolutePath).isSymbolicLink())
      throw new Error('Fixture refuses a symbolic-link output');
    const existing = readFileSync(absolutePath);
    if (hash(existing) !== hash(bytes))
      throw new Error('Fixture refuses to overwrite different attempt output');
    return hash(existing);
  }
  const temporaryPath = `${absolutePath}.tmp-${randomUUID()}`;
  writeFileSync(temporaryPath, bytes, { flag: 'wx' });
  try {
    renameSync(temporaryPath, absolutePath);
  } catch (error) {
    if (!existsSync(absolutePath) || hash(readFileSync(absolutePath)) !== hash(bytes)) throw error;
  }
  if (
    lstatSync(absolutePath).isSymbolicLink() ||
    !isWithin(workspaceRoot, realpathSync(absolutePath))
  )
    throw new Error('Fixture committed output escaped Workspace');
  return hash(readFileSync(absolutePath));
}

function readDataset(relativePath) {
  if (relativePath !== 'datasets/research-fixture.csv')
    throw new Error('Dataset fixture only reads the pre-provisioned acceptance dataset');
  const path = checkedWorkspacePath(relativePath);
  const canonicalPath = realpathSync(path);
  if (!isWithin(workspaceRoot, canonicalPath) || lstatSync(path).isSymbolicLink())
    throw new Error('Dataset file escaped Workspace or is a symbolic link');
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size > 32_768)
    throw new Error('Dataset fixture file type or size is invalid');
  const csv = readFileSync(path, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  if (lines.shift() !== 'group,value' || lines.length < 2 || lines.length > 100)
    throw new Error('Dataset fixture requires bounded group,value CSV rows');
  const rows = lines.map((line) => {
    const match = /^(baseline|candidate),(-?\d+(?:\.\d+)?)$/.exec(line);
    if (!match) throw new Error('Dataset fixture rejected a row outside its bounded CSV schema');
    return { group: match[1], value: Number(match[2]) };
  });
  if (
    !rows.some((row) => row.group === 'baseline') ||
    !rows.some((row) => row.group === 'candidate')
  )
    throw new Error('Dataset fixture requires both baseline and candidate observations');
  return { rows, contentHash: hash(Buffer.from(csv, 'utf8')) };
}

function executeExperiment(input) {
  if (
    !safeId(input.workflowRunId) ||
    !safeId(input.stepRunId) ||
    !safeId(input.planArtifactId) ||
    !Number.isInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > 5 ||
    input.operationKey !== `workflow:${input.workflowRunId}:${input.stepRunId}` ||
    !['COMPUTATIONAL', 'MIXED'].includes(input.mode) ||
    typeof input.method !== 'string' ||
    input.method.length < 1 ||
    input.method.length > 2000
  )
    throw new Error('run_experiment received invalid trusted execution context');
  const expectedBase = `workflows/${input.workflowRunId}/experiments/${input.stepRunId}/attempt-${input.attempt}`;
  const rawPath = `${expectedBase}/raw-result.json`;
  const logPath = `${expectedBase}/experiment-log.txt`;
  if (input.rawResultPath !== rawPath || input.experimentLogPath !== logPath)
    throw new Error('run_experiment refused a non-attempt-scoped output path');

  let data;
  let metric;
  let negativeResult = false;
  if (input.datasetRelativePath !== undefined) {
    data = readDataset(input.datasetRelativePath);
    const mean = (group) => {
      const values = data.rows.filter((row) => row.group === group).map((row) => row.value);
      return values.reduce((total, value) => total + value, 0) / values.length;
    };
    const baseline = mean('baseline');
    const candidate = mean('candidate');
    negativeResult = candidate >= baseline;
    metric = {
      name: 'group_mean_difference',
      value: String(Number((candidate - baseline).toFixed(4))),
      unit: 'dataset units',
      uncertainty: `n=${data.rows.length}; descriptive fixture only`,
    };
  } else {
    const baseline = [107, 110, 111, 109, 108, 110, 107, 112];
    const candidate = [109, 111, 108, 113, 110, 109, 112, 111];
    const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
    negativeResult = mean(candidate) >= mean(baseline);
    metric = {
      name: 'mean_latency_difference',
      value: String(Number((mean(candidate) - mean(baseline)).toFixed(4))),
      unit: 'ms',
      uncertainty: `n=${baseline.length} per arm; deterministic fixture only`,
    };
    data = {
      rows: baseline
        .map((value, index) => ({ arm: 'baseline', index, value }))
        .concat(candidate.map((value, index) => ({ arm: 'candidate', index, value }))),
      contentHash: hash(JSON.stringify({ baseline, candidate })),
    };
  }

  const raw = Buffer.from(
    JSON.stringify(
      {
        workflowRunId: input.workflowRunId,
        stepRunId: input.stepRunId,
        attempt: input.attempt,
        planArtifactId: input.planArtifactId,
        method: input.method,
        inputContentHash: data.contentHash,
        observations: data.rows,
        metrics: [metric],
        negativeResult,
        limitation:
          'Deterministic offline acceptance fixture; not scientific evidence beyond this bounded sample.',
      },
      null,
      2,
    ),
  );
  const log = Buffer.from(
    `workflowRunId=${input.workflowRunId}\nstepRunId=${input.stepRunId}\nattempt=${input.attempt}\nplanArtifactId=${input.planArtifactId}\nstatus=SUCCEEDED\nmethod=${input.method.slice(0, 200)}\n`,
  );
  const rawHash = writeOutput(rawPath, raw);
  const logHash = writeOutput(logPath, log);
  return {
    content: [{ type: 'text', text: 'Deterministic bounded experiment completed.' }],
    structuredContent: {
      workflowEvidence: {
        researchExperiment: {
          planArtifactId: input.planArtifactId,
          status: 'SUCCEEDED',
          method: input.method,
          negativeResult,
          metrics: [metric],
          limitations: [
            'Deterministic offline acceptance fixture; do not generalize beyond this sample.',
          ],
          reproducibilityNotes: [
            `Input SHA-256: ${data.contentHash}`,
            `Operation: ${input.operationKey}`,
          ],
        },
        artifactFiles: [
          { path: rawPath, contentHash: rawHash },
          { path: logPath, contentHash: logHash },
        ],
      },
    },
  };
}

const tools = [
  {
    name: 'research_sources',
    description: 'Returns two fixed offline source snapshots; does not access the network.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: { type: 'string', minLength: 1, maxLength: 128 },
        stepRunId: { type: 'string', minLength: 1, maxLength: 128 },
        researchQuestion: { type: 'string', minLength: 10, maxLength: 3000 },
        field: { type: 'string', minLength: 2, maxLength: 200 },
        scope: { type: 'string', maxLength: 2000 },
        literatureTimeRange: {
          type: 'object',
          properties: {
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
          },
          additionalProperties: false,
        },
        maxResults: { type: 'integer', minimum: 1, maximum: 8 },
      },
      required: [
        'workflowRunId',
        'stepRunId',
        'researchQuestion',
        'field',
        'scope',
        'literatureTimeRange',
        'maxResults',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'run_experiment',
    description:
      'Runs fixed deterministic local calculations and writes attempt-scoped output files; no shell or network.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowRunId: { type: 'string', minLength: 1, maxLength: 128 },
        stepRunId: { type: 'string', minLength: 1, maxLength: 128 },
        attempt: { type: 'integer', minimum: 1, maximum: 5 },
        attemptNumber: { type: 'integer', minimum: 1, maximum: 5 },
        planArtifactId: { type: 'string', minLength: 1, maxLength: 128 },
        operationKey: { type: 'string', minLength: 1, maxLength: 256 },
        mode: { type: 'string', enum: ['COMPUTATIONAL', 'MIXED'] },
        method: { type: 'string', minLength: 1, maxLength: 2000 },
        datasetRelativePath: { type: 'string', enum: ['datasets/research-fixture.csv'] },
        rawResultPath: { type: 'string', minLength: 1, maxLength: 512 },
        experimentLogPath: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: [
        'workflowRunId',
        'stepRunId',
        'attempt',
        'attemptNumber',
        'planArtifactId',
        'operationKey',
        'mode',
        'method',
        'rawResultPath',
        'experimentLogPath',
      ],
      additionalProperties: false,
    },
  },
];

function send(message) {
  const payload = JSON.stringify(message);
  if (framing === 'content-length')
    stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  else stdout.write(`${payload}\n`);
}

async function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'research-deterministic-fixture', version: '1.0.0' },
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
    try {
      const input = message.params?.arguments ?? {};
      let result;
      if (message.params?.name === 'research_sources') {
        const sources = sourceRows(input);
        result = {
          content: [{ type: 'text', text: JSON.stringify({ sources }) }],
          structuredContent: {
            workflowEvidence: {
              researchSources: sources.map(({ url, contentHash }) => ({ url, contentHash })),
            },
          },
        };
      } else if (message.params?.name === 'run_experiment') {
        result = executeExperiment(input);
      } else {
        throw new Error('Unknown research fixture Tool');
      }
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof Error ? error.message.slice(0, 500) : 'Research fixture failed.',
            },
          ],
        },
      });
    }
    return;
  }
  if (message.id !== undefined)
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}

function processBuffer() {
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
      if (Number.isInteger(length)) {
        framing = 'content-length';
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const payload = buffer.subarray(start, start + length).toString('utf8');
        buffer = buffer.subarray(start + length);
        handling = handling.then(() => handle(JSON.parse(payload)));
        continue;
      }
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const payload = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    buffer = buffer.subarray(newline + 1);
    if (payload.trim()) handling = handling.then(() => handle(JSON.parse(payload)));
  }
}

stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});
stdin.on('error', () => process.exit(1));
