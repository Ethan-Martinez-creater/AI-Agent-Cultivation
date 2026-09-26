import { stdin, stdout } from 'node:process';

const mode = process.argv[2] ?? 'normal';
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
        handleMessage(JSON.parse(payload));
        continue;
      }
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const payload = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    buffer = buffer.subarray(newline + 1);
    if (payload.trim()) handleMessage(JSON.parse(payload));
  }
}

function handleMessage(message) {
  if (message.method === 'initialize') {
    if (mode === 'timeout-initialize') return;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'deterministic-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    if (mode === 'crash-discovery') process.exit(17);
    if (mode === 'timeout-discovery') return;
    const inputSchema =
      mode === 'bad-schema'
        ? { type: 'number' }
        : {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
            required: ['message'],
            additionalProperties: false,
          };
    const outputSchema =
      mode === 'bad-output-schema'
        ? {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          }
        : undefined;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Returns a bounded test echo.',
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
          },
          { name: 'env', description: 'Reports configured fixture environment.', inputSchema },
          { name: 'failure', description: 'Returns a tool error.', inputSchema },
          { name: 'slow', description: 'Never returns.', inputSchema },
          { name: 'crash', description: 'Crashes the child process.', inputSchema },
        ],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    if (message.params?.name === 'slow' || mode === 'timeout-call') return;
    if (message.params?.name === 'crash' || mode === 'crash-call') process.exit(18);
    if (message.params?.name === 'failure') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'fixture failure' }] },
      });
      return;
    }
    const text =
      message.params?.name === 'env'
        ? JSON.stringify({
            allowed: process.env.MCP_GATE4_ALLOWED ?? null,
            blocked: process.env.MCP_GATE4_BLOCKED ?? null,
            nodeOptions: process.env.NODE_OPTIONS ?? null,
          })
        : `echo:${String(message.params?.arguments?.message ?? '')}`;
    if (mode === 'bad-output-schema' && message.params?.name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: 'invalid structured output' }],
          structuredContent: { answer: 42 },
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text }] },
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
