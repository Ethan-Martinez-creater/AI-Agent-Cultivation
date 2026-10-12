import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createGenerationHttpTransport } from './generation-http-transport.js';

const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
const transport = (resolveProxy = async () => 'DIRECT') =>
  createGenerationHttpTransport({
    readFetch: globalThis.fetch,
    resolveProxy,
  });

it('accepted POST response loss is one network attempt, never a retry', async () => {
  let posts = 0;
  const url = await listen(
    createServer(async (req) => {
      for await (const chunk of req) void chunk;
      posts++;
      req.socket.destroy();
    }),
  );
  await expect(transport()(url, { method: 'POST', body: '{"intent":"one"}' })).rejects.toThrow();
  expect(posts).toBe(1);
});
it('streams request and response through the selected HTTP proxy without leaking proxy choice', async () => {
  let bytes = 0;
  let seen = '';
  const proxyUrl = await listen(
    createServer(async (req, res) => {
      seen = req.url!;
      for await (const chunk of req) bytes += chunk.length;
      res.write('first');
      res.end('second');
    }),
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let n = 0; n < 32; n++) controller.enqueue(new Uint8Array(1024));
      controller.close();
    },
  });
  const response = await transport(async () => `PROXY ${new URL(proxyUrl).host}`)(
    'http://provider.invalid/v1/jobs',
    { method: 'POST', body, duplex: 'half' } as RequestInit,
  );
  expect(await response.text()).toBe('firstsecond');
  expect(bytes).toBe(32768);
  expect(seen).toBe('http://provider.invalid/v1/jobs');
});
it('redirect cannot replay a billable write or forward credentials', async () => {
  let calls = 0;
  const url = await listen(
    createServer((_req, res) => {
      calls++;
      res.writeHead(307, { location: '/another' });
      res.end();
    }),
  );
  await expect(
    transport()(url, { method: 'POST', body: '{}', headers: { authorization: 'test' } }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it('unsupported proxy selection fails closed before submission', async () => {
  const readFetch = vi.fn();
  const fetch = createGenerationHttpTransport({
    readFetch,
    resolveProxy: async () => 'SOCKS5 localhost:7890',
  });
  await expect(fetch('https://provider.invalid', { method: 'POST', body: '{}' })).rejects.toThrow(
    'Unsupported',
  );
  expect(readFetch).not.toHaveBeenCalled();
});
it('read-only network operations retain Electron transport and an aborted write is not submitted', async () => {
  const readFetch = vi.fn().mockResolvedValue(new Response('ok'));
  const resolveProxy = vi.fn().mockResolvedValue('DIRECT');
  const fetch = createGenerationHttpTransport({ readFetch, resolveProxy });
  expect(await (await fetch('https://provider.invalid')).text()).toBe('ok');
  await expect(
    fetch('https://provider.invalid', { method: 'POST', body: '{}', signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(resolveProxy).not.toHaveBeenCalled();
});
