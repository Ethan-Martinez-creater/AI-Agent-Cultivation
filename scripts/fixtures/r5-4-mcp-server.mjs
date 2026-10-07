import { stdin, stdout } from 'node:process';
import { Buffer } from 'node:buffer';

const tools = [
  {
    name: 'research_read',
    description: 'Read a bounded research source for literature review.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { 'cultivation.workflowPurposes': ['RESEARCH'] },
  },
  {
    name: 'asset_search',
    description: 'Search for public media assets by a short phrase.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'voice_render',
    description: 'Render a short voice sample from supplied text.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'weather_lookup',
    description: 'Look up a local weather forecast.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'calendar_search',
    description: 'Search calendar entries by date.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'diagram_export',
    description: 'Export a diagram as an image.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'web_snapshot',
    description: 'Capture a public webpage snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'contact_lookup',
    description: 'Look up a contact by a display name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pdf_outline',
    description: 'Extract section headings from a PDF file.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'image_describe',
    description: 'Describe a supplied image in a sentence.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'table_query',
    description: 'Run a read-only query against a sample table.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'excluded',
    description: 'Return a bounded unrelated fixture value.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

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
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'r5-4-shortlist-fixture', version: '1.0.0' },
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
    const result =
      message.params?.name === 'research_read'
        ? 'R54_MCP_RESEARCH_READ_OK'
        : 'R54_MCP_UNEXPECTED_TOOL';
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: result }] },
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
