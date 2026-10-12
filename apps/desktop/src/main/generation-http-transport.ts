import { Agent, request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';
import { once } from 'node:events';

/** Chromium can replay an accepted POST after connection loss. Billable writes use one
 * Node request: no pooling, redirect, authentication retry, or automatic retry loop. */
export function createGenerationHttpTransport(options: {
  readFetch: typeof globalThis.fetch;
  resolveProxy: (url: string) => Promise<string>;
}): typeof globalThis.fetch {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method === 'GET' || method === 'HEAD') return options.readFetch(input, init);
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new TypeError('Invalid generation transport URL');
    request.signal.throwIfAborted();
    const selected = ((await options.resolveProxy(url.href)).split(';')[0] ?? '').trim();
    const proxy = selected === 'DIRECT' ? null : /^PROXY ([^\s]+)$/.exec(selected)?.[1];
    if (proxy === undefined) throw new TypeError('Unsupported generation proxy');
    const proxyUrl = proxy ? new URL(`http://${proxy}`) : null;
    if (proxyUrl?.username || proxyUrl?.password) throw new TypeError('Invalid generation proxy');
    request.signal.throwIfAborted();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    headers.connection = 'close';
    let tunnel: ReturnType<typeof tlsConnect> | undefined;
    if (proxyUrl && url.protocol === 'https:') {
      tunnel = await new Promise((resolve, reject) => {
        const connect = httpRequest({
          hostname: proxyUrl.hostname,
          port: proxyUrl.port,
          method: 'CONNECT',
          path: `${url.hostname}:${url.port || 443}`,
          agent: false,
          signal: request.signal,
          headers: { host: `${url.hostname}:${url.port || 443}` },
        });
        connect.on('error', () => reject(new TypeError('Generation proxy connection failed')));
        connect.on('connect', (response, socket, head) => {
          if (response.statusCode !== 200 || head.length) {
            socket.destroy();
            reject(new TypeError('Generation proxy refused tunnel'));
            return;
          }
          const tls = tlsConnect({ socket, servername: url.hostname, ALPNProtocols: ['http/1.1'] });
          const abort = () => {
            tls.destroy(new Error('Generation request aborted'));
          };
          request.signal.addEventListener('abort', abort, { once: true });
          tls.once('close', () => request.signal.removeEventListener('abort', abort));
          tls.once('error', () => reject(new TypeError('Generation secure connection failed')));
          tls.once('secureConnect', () => resolve(tls));
          if (request.signal.aborted) abort();
        });
        connect.end();
      });
    }
    return new Promise<Response>((resolve, reject) => {
      let outgoing: ClientRequest;
      const fail = () => {
        tunnel?.destroy();
        reject(new TypeError('Generation HTTP request failed'));
      };
      const receive = (response: import('node:http').IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
          response.destroy();
          outgoing.destroy();
          fail();
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(
          new Response(
            status === 204 || status === 205
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders },
          ),
        );
      };
      try {
        const common = { method, headers, signal: request.signal, agent: false as const };
        if (tunnel) {
          const agent = new Agent({ keepAlive: false });
          agent.createConnection = () => tunnel!;
          outgoing = httpRequest(
            {
              ...common,
              agent,
              hostname: url.hostname,
              port: url.port || 443,
              path: `${url.pathname}${url.search}`,
            },
            receive,
          );
          outgoing.once('close', () => agent.destroy());
        } else if (proxyUrl) {
          outgoing = httpRequest(
            {
              ...common,
              hostname: proxyUrl.hostname,
              port: proxyUrl.port,
              path: url.href,
              headers: { ...headers, host: url.host },
            },
            receive,
          );
        } else
          outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, common, receive);
        outgoing.once('error', fail);
        void (async () => {
          if (request.body) {
            const body = Readable.fromWeb(
              request.body as import('node:stream/web').ReadableStream<Uint8Array>,
            );
            outgoing.once('close', () => body.destroy());
            for await (const chunk of body) {
              if (!outgoing.write(chunk)) await once(outgoing, 'drain');
            }
          }
          outgoing.end();
        })().catch(() => {
          outgoing.destroy();
          fail();
        });
      } catch {
        tunnel?.destroy();
        fail();
      }
    });
  };
}
