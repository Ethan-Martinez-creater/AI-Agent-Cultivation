import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { TypeSafeDecisionGateway } from '../../packages/agent-runtime/src/typesafe-decision-gateway.js';
import {
  makeMemoryRerankRequest,
  MemoryRerankService,
} from '../../packages/application/src/r5-3-memory-rerank.js';
import { createGenerationHttpTransport } from '../../apps/desktop/src/main/generation-http-transport.js';
import type { Gate2MemoryRecord } from '../../packages/application/src/gate2-memory-service.js';

const root = process.cwd();
const require = createRequire(import.meta.url);
const evidence = resolve(root, 'docs/evidence/v1-engineering-validation/preflight');
const scratch = resolve(
  root,
  '.test-data/e1-transport',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(scratch, { recursive: true });
mkdirSync(evidence, { recursive: true });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const request = makeMemoryRerankRequest({
  query: '离线测试日志',
  candidates: [
    { id: 'offline-memory', memoryType: 'FACT', text: '这是不含真实个人信息的离线 HTTP fixture。' },
  ],
});
const memory: Gate2MemoryRecord = {
  id: 'offline-memory',
  ownerType: 'TEAMMATE',
  ownerId: 'offline-owner',
  status: 'ACTIVE',
  memoryType: 'FACT',
  content: '离线 HTTP fixture',
  summary: '离线 HTTP fixture',
  sourceType: 'MANUAL',
  sourceId: null,
  sourceConversationId: null,
  sourceMessageId: null,
  importance: 0.5,
  confidence: 1,
  expiresAt: null,
  confirmedAt: '2026-10-15T00:00:00.000Z',
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};

async function suite(transport: typeof fetch, name: string, includeLateFactory: boolean) {
  const wire: Array<Record<string, unknown>> = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      const [, id, scenario] = path.split('/');
      const body = Buffer.concat(chunks).toString('utf8');
      const item: Record<string, unknown> = {
        id,
        scenario,
        path,
        method: req.method,
        bodyHash: sha(body),
        receivedAt: new Date().toISOString(),
        disconnected: false,
      };
      wire.push(item);
      res.on('close', () => {
        item.disconnected = true;
      });
      if (scenario === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"offline unavailable"}');
        return;
      }
      if (scenario === 'redirect') {
        res.writeHead(307, { location: `/${id}/success/v1/systemone` });
        res.end();
        return;
      }
      if (scenario === 'response-loss') {
        req.socket.destroy();
        return;
      }
      if (scenario === 'timeout') return;
      if (path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"models":[]}');
        return;
      }
      const decoded = JSON.parse(body || '{}');
      const answers = Object.fromEntries(
        Object.keys(decoded.questions ?? {}).map((key) => [key, { type: 'noul', noul: 0.75 }]),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: 7, output_tokens: 2 },
        }),
      );
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const rows: Array<Record<string, unknown>> = [];
  let sequence = 0;
  try {
    for (const scenario of [
      'success',
      'unavailable',
      'redirect',
      'response-loss',
      'timeout',
      'connection-probe',
    ]) {
      const id = `${name}-${++sequence}`;
      let dispatches = 0;
      let abortEvents = 0;
      const gateway = new TypeSafeDecisionGateway({
        apiKey: 'offline-fixture-key-not-a-secret',
        baseURL: `${origin}/${id}/${scenario === 'connection-probe' ? 'success' : scenario}`,
        timeoutMs: 6_000,
        fetch: async (url, init) => {
          assert.equal(new URL(String(url)).origin, origin, 'only local fixture origin permitted');
          dispatches += 1;
          init?.signal?.addEventListener(
            'abort',
            () => {
              abortEvents += 1;
            },
            { once: true },
          );
          return transport(url, init);
        },
      });
      const started = performance.now();
      const result =
        scenario === 'connection-probe'
          ? await gateway.testConnection()
          : await gateway.evaluate(request);
      await delay(40);
      const observed = wire.filter((item) => item.id === id);
      if (scenario === 'success') {
        assert.equal('errorCode' in result ? result.errorCode : undefined, null);
        assert.equal(dispatches, 1);
        assert.equal(observed.length, 1);
      }
      if (scenario === 'unavailable') {
        assert.equal(dispatches, 1);
        assert.equal(observed.length, 1);
      }
      if (scenario === 'redirect') {
        assert.equal(dispatches, 1);
        assert.equal(observed.length, 2, 'default fetch follows local 307 as another POST');
      }
      if (scenario === 'timeout') {
        assert.equal(result.errorCode, 'TIMEOUT');
        assert.ok(abortEvents >= 1);
        assert.equal(dispatches, 1);
        assert.ok(observed.some((item) => item.disconnected));
      }
      if (scenario === 'connection-probe') {
        assert.equal(dispatches, 2);
        assert.equal(observed.length, 2);
      }
      rows.push({
        scenario,
        logicalEvaluateCount: scenario === 'connection-probe' ? 0 : 1,
        sdkDispatches: dispatches,
        serverObservedWireRequests: observed.length,
        requestMethods: observed.map((item) => item.method),
        abortEvents,
        elapsedMs: performance.now() - started,
        result,
        wire: observed,
      });
    }
    if (includeLateFactory) {
      for (const stopped of [false, true]) {
        const id = `${name}-late-${stopped}`;
        let dispatches = 0;
        let rejectedLateDispatches = 0;
        let stop = false;
        let settled!: () => void;
        const done = new Promise<void>((resolve) => {
          settled = resolve;
        });
        const gateway = new TypeSafeDecisionGateway({
          apiKey: 'offline-fixture-key-not-a-secret',
          baseURL: `${origin}/${id}/success`,
          timeoutMs: 6_000,
          fetch: async (url, init) => {
            if (stop) {
              rejectedLateDispatches += 1;
              throw new Error('preflight budget stopped');
            }
            dispatches += 1;
            return transport(url, init);
          },
        });
        const service = new MemoryRerankService(async () => {
          await delay(6_200);
          return {
            evaluate: async (input) => {
              try {
                return await gateway.evaluate(input);
              } finally {
                settled();
              }
            },
          };
        });
        const result = await service.rank({
          teammateId: 'offline-owner',
          query: '离线测试日志',
          candidates: [memory],
        });
        const atReturn = dispatches;
        assert.equal(result.receipt.reason, 'GATEWAY_TIMEOUT');
        if (stopped) stop = true;
        await done;
        assert.equal(atReturn, 0);
        assert.equal(dispatches, stopped ? 0 : 1);
        rows.push({
          scenario: stopped ? 'late-factory-with-test-stop-guard' : 'late-factory-no-stop-guard',
          source: 'PRODUCTION_SELECTOR_WITH_LOCAL_GATEWAY',
          returnedReason: result.receipt.reason,
          dispatchesAtSelectorReturn: atReturn,
          dispatchesAfterDrain: dispatches,
          rejectedLateDispatches,
          serverObservedWireRequests: wire.filter((item) => item.id === id).length,
        });
      }
      const oneShot = createGenerationHttpTransport({
        readFetch: transport,
        resolveProxy: async () => 'DIRECT',
      });
      for (const scenario of ['success', 'redirect', 'response-loss']) {
        const id = `one-shot-${scenario}`;
        let dispatches = 0;
        const gateway = new TypeSafeDecisionGateway({
          apiKey: 'offline-fixture-key-not-a-secret',
          baseURL: `${origin}/${id}/${scenario}`,
          timeoutMs: 6_000,
          fetch: (url, init) => {
            dispatches += 1;
            return oneShot(url, init);
          },
        });
        const result = await gateway.evaluate(request);
        const observed = wire.filter((item) => item.id === id);
        assert.equal(observed.length, 1);
        rows.push({
          scenario: 'existing-one-shot-transport-' + scenario,
          source: 'PRODUCTION_GATEWAY_WITH_EXPLICIT_ALTERNATE_FETCH_OPTION',
          productionMainDefaultTransport: false,
          sdkDispatches: dispatches,
          serverObservedWireRequests: observed.length,
          result,
        });
      }
    }
    return {
      status: 'PASS',
      runtime: name,
      evidenceLevel: 'LOCAL_HTTP_REAL_PRODUCTION_GATEWAY',
      liveProviderCalls: 0,
      sdkVersion: '0.6.0',
      model: 'jev-1.13.0',
      requestHash: sha(JSON.stringify(request)),
      cases: rows,
    };
  } catch (error) {
    writeFileSync(
      join(scratch, `suite-failure-${name}.json`),
      JSON.stringify({ status: 'FAIL', error: String(error), cases: rows, wire }, null, 2) + '\n',
      'utf8',
    );
    throw error;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (process.versions.electron) {
  const { app, net } = require('electron') as typeof import('electron');
  const output = process.argv[process.argv.indexOf('--preflight-output') + 1];
  app.setPath('userData', process.env.CULTIVATION_USER_DATA_DIR!);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    try {
      writeFileSync(
        output!,
        JSON.stringify(
          await suite(
            (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
            'electron-net-fetch',
            false,
          ),
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } catch (error) {
      writeFileSync(
        output!,
        JSON.stringify({ status: 'FAIL', error: String(error) }) + '\n',
        'utf8',
      );
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
} else {
  const childProfile = join(scratch, 'electron-profile');
  const childOutput = join(scratch, 'electron-transport.json');
  for (const directory of [
    childProfile,
    join(scratch, 'appdata'),
    join(scratch, 'localappdata'),
    join(scratch, 'temp'),
    join(scratch, 'userprofile'),
  ])
    mkdirSync(directory, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CULTIVATION_USER_DATA_DIR: childProfile,
    APPDATA: join(scratch, 'appdata'),
    LOCALAPPDATA: join(scratch, 'localappdata'),
    TEMP: join(scratch, 'temp'),
    TMP: join(scratch, 'temp'),
    USERPROFILE: join(scratch, 'userprofile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    join(root, 'node_modules/electron/dist/electron.exe'),
    [
      fileURLToPath(import.meta.url),
      '--preflight-output',
      childOutput,
      '--user-data-dir=' + childProfile,
      '--disable-gpu-shader-disk-cache',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  writeFileSync(
    join(scratch, 'electron-launch.json'),
    JSON.stringify(
      {
        pid: child.pid,
        executable: join(root, 'node_modules/electron/dist/electron.exe'),
        profile: childProfile,
        output: childOutput,
        forcedKill: false,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    writeFileSync(join(scratch, 'electron-stderr.txt'), stderr, 'utf8');
  });
  const childDone = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const node = await suite(globalThis.fetch, 'node-fetch', true);
  const exitCode = await childDone;
  const electron = JSON.parse(readFileSync(childOutput, 'utf8'));
  assert.equal(exitCode, 0);
  assert.equal(electron.status, 'PASS');
  const report = {
    status: 'PASS',
    liveProviderCalls: 0,
    formalBenchmark: 'NOT_RUN',
    checkedAt: new Date().toISOString(),
    node,
    electron,
    electronProcess: {
      pid: child.pid,
      exitCode,
      normalAppQuit: true,
      forcedKill: false,
      profile: childProfile,
      stderr,
    },
    wireScope:
      'server-observed plaintext loopback HTTP; no assertion about unobserved real Jev TLS traffic',
    budgetReadiness: {
      status: 'BLOCKED',
      logicalEvaluateCap: 15,
      questionCap: 91,
      sdkPostDispatchCap: 15,
      timeoutMs: 6000,
      roundWatchdogMs: 120000,
      automaticRetry: false,
      reason:
        'account price/monetary ceiling and approval of E2 observed no-replay transport remain pending; Gold separately pending',
    },
  };
  writeFileSync(
    join(evidence, 'jev-transport-preflight.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
  );
  console.log(
    JSON.stringify({
      status: report.status,
      nodeCases: node.cases.length,
      electronCases: electron.cases.length,
      liveProviderCalls: 0,
      budget: report.budgetReadiness.status,
    }),
  );
}
