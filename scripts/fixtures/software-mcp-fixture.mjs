import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CRITERIA = 32;
const MAX_SUMMARY_BYTES = 2_000;
const FIXED_COMMAND = 'node verify.mjs';

function workspaceRoot() {
  const configured = process.env.W22_WORKSPACE_ROOT;
  if (!configured) throw new Error('WORKSPACE_ROOT_REQUIRED');
  const root = realpathSync(configured);
  if (!statSync(root).isDirectory()) throw new Error('WORKSPACE_ROOT_INVALID');
  return root;
}

function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function boundedText(value) {
  const text = typeof value === 'string' ? value : '';
  return Buffer.from(text, 'utf8').subarray(0, MAX_SUMMARY_BYTES).toString('utf8');
}

async function verifyRepository(input) {
  if (
    input.command !== FIXED_COMMAND ||
    typeof input.commandId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,96}$/.test(input.commandId) ||
    !Array.isArray(input.acceptanceCriterionIds) ||
    input.acceptanceCriterionIds.length < 1 ||
    input.acceptanceCriterionIds.length > MAX_CRITERIA ||
    new Set(input.acceptanceCriterionIds).size !== input.acceptanceCriterionIds.length ||
    input.acceptanceCriterionIds.some(
      (id) => typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(id),
    )
  )
    throw new Error('INVALID_VERIFICATION_REQUEST');

  const root = workspaceRoot();
  const script = resolve(root, 'verify.mjs');
  const canonicalScript = realpathSync(script);
  if (!within(root, canonicalScript) || dirname(canonicalScript) !== root)
    throw new Error('VERIFIER_PATH_OUTSIDE_WORKSPACE');
  if (!statSync(canonicalScript).isFile()) throw new Error('VERIFIER_NOT_FILE');

  let exitStatus = 0;
  let stdout = '';
  let stderr = '';
  let failure = null;
  try {
    const result = await execFileAsync(process.execPath, [canonicalScript], {
      cwd: root,
      timeout: 5_000,
      maxBuffer: 8_192,
      windowsHide: true,
      shell: false,
      env: { W22_WORKSPACE_ROOT: root },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const childError = error && typeof error === 'object' ? error : {};
    const code = Reflect.get(childError, 'code');
    const signal = Reflect.get(childError, 'signal');
    const out = Reflect.get(childError, 'stdout');
    const err = Reflect.get(childError, 'stderr');
    stdout = typeof out === 'string' ? out : '';
    stderr = typeof err === 'string' ? err : '';
    exitStatus = Number.isInteger(code) ? code : 1;
    failure = signal === 'SIGTERM' ? 'TIMEOUT' : 'VERIFICATION_FAILED';
  }

  const outputHash = createHash('sha256').update(`${stdout}\n${stderr}`).digest('hex');
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          command: FIXED_COMMAND,
          exitStatus,
          failure,
          summary: boundedText(exitStatus === 0 ? stdout : stderr || stdout),
        }),
      },
    ],
    structuredContent: {
      workflowEvidence: {
        verification: {
          commandId: input.commandId,
          command: FIXED_COMMAND,
          exitStatus,
          failure,
          acceptanceCriterionIds: [...new Set(input.acceptanceCriterionIds)],
          outputHash,
        },
      },
    },
  };
}

const tools = [
  {
    name: 'verify_repository',
    description: 'Runs the one bounded offline acceptance verifier provisioned for this workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', minLength: 1, maxLength: 96 },
        command: { type: 'string', const: FIXED_COMMAND },
        acceptanceCriterionIds: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CRITERIA,
          items: { type: 'string', minLength: 1, maxLength: 96 },
        },
      },
      required: ['commandId', 'command', 'acceptanceCriterionIds'],
      additionalProperties: false,
    },
  },
];

let buffer = Buffer.alloc(0);
let framing = 'line';
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (framing === 'content-length')
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body.toString('utf8')}`);
  else process.stdout.write(`${body.toString('utf8')}\n`);
}

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
        serverInfo: { name: 'software-offline-verification-fixture', version: '1.0.0' },
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
      if (message.params?.name !== 'verify_repository') throw new Error('UNKNOWN_TOOL');
      const result = await verifyRepository(message.params?.arguments ?? {});
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message.slice(0, 160) : 'VERIFICATION_FAILED',
        },
      });
    }
    return;
  }
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}
