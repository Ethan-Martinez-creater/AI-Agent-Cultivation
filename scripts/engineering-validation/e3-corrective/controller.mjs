// @ts-check
// Derived from the sealed E1 controller; CR-B control flow is intentionally absent.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { chromium } from 'playwright-core';
import Database from 'better-sqlite3';
import { captureStage, snapshotSummary } from './snapshots.mjs';

/** @typedef {{objective:string,targetArea:string[],targetPath:string,expectedContent:string,expectedContents:Record<string,string>,expectedSha256:string,ledgerPath:string,language:string,metadata:Array<{name:string,bytes:number,sha256:string}>}} WorkspaceFixture */
/** @typedef {(input:{workspace:string,evidence:string})=>WorkspaceFixture} FixturePreparer */

/** @typedef {{pid:number,parentPid:number|null,executable:string,commandLine:string,createdUtc:string,createdUtcTicks:string}} ProcessIdentity */
/** @typedef {{pid:number,execPath:string,userData:string,electronUserData:string,argv:string[]}} RuntimeIdentity */
/** @typedef {{mainPid:number,executable:string,profile:string,spawnargs:string[],launchToken:string,startedAt:string}} ControllerLaunch */
/** @typedef {{status:string,main:ProcessIdentity,verified:ProcessIdentity[],excludedCandidates:unknown[]}} ObserveReceipt */
/** @typedef {{status:string,main?:ProcessIdentity,verified?:ProcessIdentity[],[key:string]:unknown}} ControlReceipt */
/** @typedef {{generation:number,child:import('node:child_process').ChildProcess,port:number,chromePort:number,paused:boolean,entryCount:number,returnCount:number,profileVerified:boolean,activeReturns:Set<string>,spawnError?:string,startupIdentity?:ProcessIdentity,inspector?:Inspector,observerId?:string,heldEntry?:CdpParams,heldReturn?:CdpParams,observerError?:string,page?:import('playwright-core').Page,osIdentity?:ObserveReceipt,app?:{evaluate:<TArg,TResult>(fn:(electron:ElectronBoundary,arg:TArg)=>TResult,arg:TArg)=>Promise<TResult>},runtimeIdentity?:RuntimeIdentity,controllerLaunch?:ControllerLaunch}} Session */
/** @typedef {Record<string, any>} CdpParams CDP messages are the explicit protocol boundary. */
/** @typedef {Record<string, any>} SnapshotBoundary Snapshot JSON is a typed evidence boundary. */
/** @typedef {string | number | bigint | Uint8Array | null} SqlValue */
/** @typedef {Record<string, SqlValue>} SqlRow */
/** @typedef {{method:string,params:CdpParams}} CdpEvent */
/** @typedef {{dialog:{showOpenDialog:(...args:unknown[])=>Promise<unknown>}}} ElectronBoundary */
/** @typedef {{kind:'returned',value:unknown}|{kind:'error',error:string}|{kind:'paused',paused:CdpParams}|{kind:'waitError',error:string}} BreakpointRace */
/** @typedef {{kind:'returned',value:WorkflowDetail}|{kind:'error',error:string}|{kind:'paused',paused:CdpParams}|{kind:'waitError',error:string}} AdvanceRace */
const { fetch, WebSocket } = globalThis;
const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();
assert.match(repositoryRoot, /^E:[\\/]/i);
const fixtureModule = await import(
  pathToFileURL(join(repositoryRoot, 'scripts/engineering-validation/packaged-workspace-fixture.mjs')).href,
);
const preparePackagedWorkspace = /** @type {FixturePreparer} */ (
  fixtureModule.preparePackagedWorkspace
);
const requestedCase = process.argv[2];
if (requestedCase !== 'CR_A_CORRECTIVE' && requestedCase !== 'PROBE')
  throw new Error('This corrective controller accepts CR_A_CORRECTIVE or PROBE; CR_B is refused');
const scenario = requestedCase === 'CR_A_CORRECTIVE' ? 'CR_A_P4' : 'NONCRASH_PROBE';
const token = requestedCase + '-' + randomUUID();
const runRoot = join(repositoryRoot, '.tmp/e3-corrective-runtime', token);
const profile = join(runRoot, 'profile');
const workspace = join(runRoot, 'workspace');
const evidence = join(runRoot, 'raw-controller');
const temp = join(runRoot, 'Temp');
for (const path of [
  profile,
  workspace,
  evidence,
  temp,
  join(profile, 'Roaming'),
  join(profile, 'Local'),
  join(profile, 'UserData'),
  join(profile, 'Chromium'),
])
  mkdirSync(path, { recursive: true });
const databasePath = join(profile, 'UserData/data/cultivation.sqlite');
const workspaceVerifier = join(repositoryRoot, 'scripts/fixtures/software-mcp-fixture.mjs');
/** @type {WorkspaceFixture} */
const workspaceFixture = preparePackagedWorkspace({ workspace, evidence });
const verificationLedger = workspaceFixture.ledgerPath;
const controllerLedger = join(evidence, 'independent-controller.ndjson');
const executablePath = join(
  repositoryRoot,
  'out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe',
);
const processControlPath = join(
  repositoryRoot,
  'scripts/engineering-validation/e3-corrective/process-control.ps1',
);
const processPolicyPath = join(
  repositoryRoot,
  'scripts/engineering-validation/e3-corrective/process-policy.ps1',
);
const publication = join(
  repositoryRoot,
  'docs/evidence/v1-engineering-validation/e3/cr-a-corrective',
  token,
);
mkdirSync(publication, { recursive: true });
/** @type {Record<string, any>} Heterogeneous JSON evidence is the serialization boundary. */
const facts = {
  schemaVersion: 1,
  case: requestedCase,
  scenario,
  token,
  status: 'PREPARING',
  startedAt: new Date().toISOString(),
  executablePath,
  profile,
  workspace,
  databasePath,
  runRoot,
  fixtureLanguage: workspaceFixture.language,
  fixtureFlags: ['--gate1-fake-model', '--r4-fake-routing', '--w22-fake-software'],
  restrictions: {
    realProviderCalls: 0,
    productionFilesModified: false,
    manualDatabaseBusinessWrites: false,
  },
  generations: [],
  stages: {},
  breakpoints: [],
  hits: [],
  observations: [],
  killOrdinal: 0,
};
const reportPath = join(publication, 'execution.json');
const fixtureFlags = /** @type {string[]} */ (facts.fixtureFlags);
/** @type {() => void} */
const save = () => writeFileSync(reportPath, JSON.stringify(facts, null, 2) + '\n', 'utf8');
/** @param {string} text */
const log = (text) => {
  facts.observations.push({ at: new Date().toISOString(), text });
  save();
  process.stdout.write(text + '\n');
};
/** @type {Session | undefined} */
let current;
/** @returns {Session} */
function requireSession() {
  if (!current) throw new Error('No owned application generation is active');
  return current;
}
/** @param {Session} session @returns {Inspector} */
function requireInspector(session) {
  if (!session.inspector) throw new Error('Main Inspector is not attached');
  return session.inspector;
}
/** @param {Session} session @returns {import('playwright-core').Page} */
function requirePage(session) {
  if (!session.page) throw new Error('Packaged renderer page is not ready');
  return session.page;
}
/** @param {Session} session @returns {NonNullable<Session['app']>} */
function requireApp(session) {
  if (!session.app) throw new Error('Main Electron bridge is not attached');
  return session.app;
}
/** @type {string | undefined} */
let lastConsistentPath;
let pauseChain = Promise.resolve();
let phase = 'SETUP';
/** @param {Record<string, unknown>} event */
const observe = (event) => {
  appendFileSync(
    controllerLedger,
    JSON.stringify({
      at: new Date().toISOString(),
      generation: current?.generation ?? -1,
      phase,
      ...event,
    }) + '\n',
    'utf8',
  );
};
/** @returns {NodeJS.ProcessEnv} */
const childEnvironment = () => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  USERPROFILE: profile,
  HOMEDRIVE: 'E:',
  HOMEPATH: profile.slice(2),
  APPDATA: join(profile, 'Roaming'),
  LOCALAPPDATA: join(profile, 'Local'),
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  NODE_COMPILE_CACHE: join(temp, 'node-cache'),
  CULTIVATION_USER_DATA_DIR: join(profile, 'UserData'),
  W22_WORKSPACE_ROOT: workspace,
});
/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function readDb(fn) {
  assert.ok(lastConsistentPath, 'Seal a stage and consistency copy before inspecting the database');
  const db = new Database(lastConsistentPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  try {
    db.pragma('query_only = ON');
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Decode rows from the explicitly read-only SQLite queries used by this
 * controller. The schema is frozen with the packaged build; column names are
 * selected at runtime and validated as SQLite scalar values.
 * @param {unknown} value
 * @returns {SqlRow[]}
 */
function decodeSqlRows(value) {
  if (!Array.isArray(value)) throw new TypeError('SQLite query did not return a row array');
  return value.map((row) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      throw new TypeError('SQLite query returned a non-object row');
    for (const scalar of Object.values(row)) {
      if (
        scalar !== null &&
        typeof scalar !== 'string' &&
        typeof scalar !== 'number' &&
        typeof scalar !== 'bigint' &&
        !(scalar instanceof Uint8Array)
      )
        throw new TypeError('SQLite query returned a non-scalar value');
    }
    return /** @type {SqlRow} */ (row);
  });
}
/** @param {import('better-sqlite3').Database} db @param {string} sql @param {...SqlValue} params */
function sqlRows(db, sql, ...params) {
  return decodeSqlRows(db.prepare(sql).all(...params));
}
/** @param {import('better-sqlite3').Database} db @param {string} sql @param {...SqlValue} params */
function sqlRow(db, sql, ...params) {
  const rows = decodeSqlRows([db.prepare(sql).get(...params)].filter((row) => row !== undefined));
  return rows[0];
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined));
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Temporary listener did not bind to a TCP port');
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve(undefined))),
  );
  return port;
}
/** @param {string | Uint8Array} data */
function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}
/** @param {string} path */
function fileFact(path) {
  return existsSync(path)
    ? { exists: true, sizeBytes: statSync(path).size, sha256: sha(readFileSync(path)) }
    : { exists: false };
}
/** @param {string} source @param {number} index */
function sourceLocation(source, index) {
  const before = source.slice(0, index);
  const lineNumber = (before.match(/\n/g) || []).length;
  return { lineNumber, columnNumber: index - before.lastIndexOf('\n') - 1 };
}
class Inspector {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve:(value:any)=>void,reject:(error:Error)=>void}>} */
    this.pending = new Map();
    /** @type {Map<string,Array<(params:CdpParams)=>void>>} */
    this.listeners = new Map();
    /** @type {CdpEvent[]} */
    this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (p) {
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      } else if (m.method) {
        this.events.push(m);
        for (const fn of this.listeners.get(m.method) || []) fn(m.params);
      }
    });
  }
  /** @param {number} port */
  static async connect(port) {
    let target;
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      try {
        const list = /** @type {Array<{webSocketDebuggerUrl?:string}>} */ (
          await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        );
        target = list.find((item) => item.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* ignore transient probe failure */
      }
      await delay(100);
    }
    if (!target) throw new Error('Node inspector endpoint did not appear');
    const webSocketUrl = target.webSocketDebuggerUrl;
    if (!webSocketUrl) throw new Error('Inspector target has no websocket URL');
    const ws = new WebSocket(webSocketUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Inspector(ws);
  }
  /** @param {string} method @param {(params:CdpParams)=>void} fn */
  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }
  /** @param {string} method @param {Record<string,unknown>} [params] @returns {Promise<any>} */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async close() {
    this.ws.close();
  }
}
/** @param {Inspector} inspector @param {string} bpId @param {number} [timeoutMs] */
function breakpointWaiter(inspector, bpId, timeoutMs = 180000) {
  const idx = inspector.events.findIndex(
    (e) => e.method === 'Debugger.paused' && e.params.hitBreakpoints?.includes(bpId),
  );
  if (idx >= 0) {
    const queued = inspector.events.splice(idx, 1)[0];
    if (queued) return { promise: Promise.resolve(queued.params), cancel() {} };
  }
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {((value:CdpParams)=>void) | undefined} */
  let resolvePromise;
  /** @type {((error:Error)=>void) | undefined} */
  let rejectPromise;
  /** @param {CdpParams} p */
  const fn = (p) => {
    if (p.hitBreakpoints?.includes(bpId)) {
      clearTimeout(timer);
      off();
      resolvePromise?.(p);
    }
  };
  const off = () => {
    const a = inspector.listeners.get('Debugger.paused') || [];
    inspector.listeners.set(
      'Debugger.paused',
      a.filter((x) => x !== fn),
    );
  };
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    timer = setTimeout(() => {
      off();
      reject(new Error(`breakpoint not hit: ${bpId}`));
    }, timeoutMs);
  });
  inspector.on('Debugger.paused', fn);
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      off();
      rejectPromise?.(new Error(`breakpoint waiter cancelled: ${bpId}`));
    },
  };
}

/** @param {number} parentPid @returns {Promise<unknown>} */
function runtimeFacts(parentPid) {
  const ps = `$seed=${parentPid}; $front=@($seed); $rows=@(); for($d=0;$d -lt 5;$d++){ $next=@(); foreach($id in $front){ $items=Get-CimInstance Win32_Process -Filter "ProcessId = $id OR ParentProcessId = $id" -ErrorAction SilentlyContinue; foreach($x in $items){ if(-not ($rows | Where-Object ProcessId -eq $x.ProcessId)){ $rows += [pscustomobject]@{ProcessId=$x.ProcessId;ParentProcessId=$x.ParentProcessId;Name=$x.Name;ExecutablePath=$x.ExecutablePath;CreationDate=$x.CreationDate}; if($x.ProcessId -ne $seed){$next += $x.ProcessId} } } }; $front=$next }; $rows | ConvertTo-Json -Depth 3 -Compress`;
  return execFileAsync('pwsh.exe', ['-NoProfile', '-Command', ps], {
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      USERPROFILE: profile,
      HOMEDRIVE: 'E:',
      HOMEPATH: profile.slice(2),
      APPDATA: join(profile, 'Roaming'),
      LOCALAPPDATA: join(profile, 'Local'),
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    },
  })
    .then((r) => {
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { raw: r.stdout, error: r.stderr };
      }
    })
    .catch((e) => ({ error: String(e.message), stdout: e.stdout, stderr: e.stderr }));
}
/** @param {NonNullable<Session['app']>} app @param {import('playwright-core').Page} page @param {string} folder */
async function chooseWorkspaceBeforeWorkflowDrawer(app, page, folder) {
  await app.evaluate(({ dialog }, selectedWorkspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedWorkspace] });
  }, folder);
  facts.observations.push({
    at: new Date().toISOString(),
    text: 'installed test-only Electron dialog.showOpenDialog stub for the isolated workspace; workflow actions remain through visible UI and preload IPC',
  });
  save();
  const selection = await page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  if (selection.rootPath !== folder)
    throw new Error(`chooseWorkspace returned ${selection.rootPath}, expected ${folder}`);
  facts.workspaceSelection = {
    rootPath: selection.rootPath,
    method:
      'exposed preload IPC window.cultivation.tools.chooseWorkspace before workflow form mount',
    at: new Date().toISOString(),
  };
  save();
}

/** @param {import('better-sqlite3').Database} db @param {string} table @param {string} column @param {string} value */
function tableRows(db, table, column, value) {
  const exists = sqlRow(
    db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    table,
  );
  if (!exists) return { table, exists: false, rows: [] };
  const columns = sqlRows(db, `PRAGMA table_info(${table})`).map((item) => String(item.name));
  if (!columns.includes(column)) return { table, exists: true, columns, rows: [] };
  const safeColumns = columns.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x));
  return {
    table,
    exists: true,
    columns: safeColumns,
    rows: sqlRows(db, `SELECT * FROM ${table} WHERE ${column}=?`, value),
  };
}
/** @param {import('playwright-core').Page} page @param {string} setupToolId @param {{objective:string,targetArea:string[]}} fixture @returns {Promise<string>} */
async function createWorkflowViaIpc(page, setupToolId, fixture) {
  const detail = await page.evaluate(
    async ({ workspaceRoot, toolId, objective, targetArea }) =>
      window.cultivation.workflows.create({
        definitionId: 'official.software-feature',
        version: 1,
        inputs: {
          objective,
          workspaceRoot,
          targetArea,
          allowedToolScope: ['file.readText', 'file.writeText', toolId],
        },
      }),
    {
      workspaceRoot: workspace,
      toolId: setupToolId,
      objective: fixture.objective,
      targetArea: fixture.targetArea,
    },
  );
  facts.workflowCreation = {
    runId: detail.run.id,
    route: 'window.cultivation.workflows.create preload IPC',
    definitionId: detail.run.definitionId,
    version: detail.run.definitionVersion,
    initialState: detail.run.state,
    inputs: {
      workspaceRoot: workspace,
      objective: fixture.objective,
      targetArea: fixture.targetArea,
      allowedToolScope: ['file.readText', 'file.writeText', setupToolId],
    },
  };
  save();
  return detail.run.id;
}
/** @param {import('playwright-core').Page} page @returns {Promise<FixtureSetup>} */
async function setupFixture(page) {
  return page.evaluate(
    async ({ fixturePath, workspacePath, nodePath }) => {
      const api = window.cultivation;
      const routingConfig = await api.routing.config();
      const r3Config = await api.r3.getConfig();
      const version = (await api.workflows.versions()).find(
        (v) => v.definition.id === 'official.software-feature',
      );
      if (!version) throw new Error('official.software-feature@1 unavailable');
      const dimensions = [
        ...new Set(version.steps.flatMap((s) => s.routing.requiredCapabilities ?? [])),
      ];
      await api.r2.setCapability({ dimension: 'CODING', enabled: true });
      const actors = [];
      const actorSpecs = /** @type {Array<[string, number]>} */ ([
        ['青岚', 95],
        ['明衡', 85],
      ]);
      for (const [name, score] of actorSpecs) {
        const provider = await api.providers.create({
          name: `${name}模型服务`,
          kind: 'OPENAI_COMPATIBLE',
          baseUrl: 'http://127.0.0.1:9999/v1',
        });
        const runtime = await api.runtimes.create({
          name: `${name}固定模型`,
          providerId: provider.id,
          credentialId: null,
          modelId: 'software-local-model',
        });
        const teammate = await api.teammates.create({
          name,
          avatar: null,
          title: null,
          description: '',
          identityPrompt: '',
          behaviorPrompt: '',
          currentRuntimeProfileId: runtime.id,
        });
        if (!teammate.currentRuntimeProfileId)
          throw new Error(`teammate ${teammate.id} has no sealed runtime profile`);
        for (const dimension of dimensions)
          await api.capability.saveBenchmark({
            runtimeProfileId: teammate.currentRuntimeProfileId,
            modelAlias: 'software-local-model',
            dimension,
            supported: true,
            normalizedScore: score,
            rawScore: null,
            source: 'E1离线断点验收',
            benchmark: '软件流程验收',
            benchmarkVersion: '1',
            snapshotDate: '2026-10-15T00:00:00.000Z',
            sourceUrl: null,
            provenanceType: 'USER_ESTIMATE',
          });
        actors.push({ id: teammate.id, name });
      }
      const server = await api.tools.saveMcpServer({
        name: 'E1离线验证工具',
        command: nodePath,
        args: [fixturePath],
        envWhitelist: ['W22_WORKSPACE_ROOT', 'TEMP', 'TMP'],
        cwd: workspacePath,
        enabled: true,
      });
      const discovered = await api.tools.refreshMcpServer(server.id);
      if (discovered.status !== 'READY')
        throw new Error(`offline MCP discovery failed: ${discovered.status}`);
      const tool = discovered.tools.find((item) => item.toolName === 'verify_repository');
      if (!tool) throw new Error('verify_repository missing from offline MCP');
      const availability = [];
      for (const actor of actors) {
        const observations = [await api.availability.recheck(actor.id)];
        const firstObservation = observations[0];
        if (!firstObservation) throw new Error('Availability probe produced no initial observation');
        if (firstObservation.status === 'UNAVAILABLE')
          observations.push(await api.availability.recheck(actor.id));
        const latest = observations.at(-1);
        if (!latest) throw new Error('Availability probe produced no observation');
        availability.push({ teammateId: actor.id, observations, latest });
      }
      return {
        actors,
        serverId: server.id,
        toolId: tool.id,
        mcpStatus: discovered.status,
        routingConfig,
        r3Config,
        availability,
        modelGateway: '--gate1-fake-model probe/model gateway; no real provider/API invocation',
      };
    },
    { fixturePath: workspaceVerifier, workspacePath: workspace, nodePath: process.execPath },
  );
}
async function connectAndBreak() {
  const inspector = requireInspector(requireSession());
  const scripts = inspector.events
    .filter((event) => event.method === 'Debugger.scriptParsed')
    .map((event) => event.params);
  inspector.on('Debugger.scriptParsed', (p) => scripts.push(p));
  inspector.on('Debugger.enable', () => {});
  await inspector.send('Debugger.enable');
  let bundle;
  for (const s of scripts.filter((x) => /\.vite[\\/]build[\\/]main-[^/\\]+\.js/i.test(x.url))) {
    const reply = await inspector.send('Debugger.getScriptSource', { scriptId: s.scriptId });
    if (reply.scriptSource.includes('Text written.')) {
      bundle = { scriptId: s.scriptId, url: s.url, source: reply.scriptSource };
      break;
    }
  }
  if (!bundle) throw new Error(`bundled Main JS not found in ${scripts.length} parsed scripts`);
  const hash = sha(bundle.source);
  facts.bundle = {
    url: bundle.url,
    scriptId: bundle.scriptId,
    sha256: hash,
    length: bundle.source.length,
    expectedSha256: '417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71',
    hashMatchesApproved:
      hash === '417144942a7179bde611c014360f545da756e01b3e270e69a5031ea507f3bc71',
  };
  if (!facts.bundle.hashMatchesApproved)
    throw new Error(`runtime main bundle hash mismatch: ${hash}`);
  /** @param {string} needle @param {number} [delta] */
  const site = (needle, delta = 0) => {
    const ix = bundle.source.indexOf(needle);
    if (ix < 0 || bundle.source.indexOf(needle, ix + needle.length) >= 0)
      throw new Error(`target must be unique: ${needle}`);
    return { index: ix + delta, ...sourceLocation(bundle.source, ix + delta) };
  };
  const p4 = site('}),A}chooseEdge', 3);
  facts.staticLocations = { P4: p4 };
  if (scenario === 'CR_A_P4' && (p4.lineNumber !== 9625 || p4.columnNumber !== 7198))
    throw new Error(`P4 location drift: ${JSON.stringify(p4)}`);
  /** @param {string} label @param {{index:number,lineNumber:number,columnNumber:number}} location @param {string|null} condition @param {{startLine?:number,startColumn?:number,endLine?:number,endColumn?:number}} [scanRange] */
  const install = async (label, location, condition, scanRange) => {
    const start = {
      scriptId: bundle.scriptId,
      lineNumber: scanRange?.startLine ?? location.lineNumber,
      columnNumber: scanRange?.startColumn ?? Math.max(0, location.columnNumber - 2),
    };
    const end = {
      scriptId: bundle.scriptId,
      lineNumber: scanRange?.endLine ?? location.lineNumber,
      columnNumber: scanRange?.endColumn ?? location.columnNumber + 8,
    };
    const possible = await inspector.send('Debugger.getPossibleBreakpoints', {
      start,
      end,
      restrictToFunction: false,
    });
    const bp = await inspector.send('Debugger.setBreakpoint', {
      location: {
        scriptId: bundle.scriptId,
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      },
      ...(condition ? { condition } : {}),
    });
    const actualLocations = bp.actualLocation ? [bp.actualLocation] : (bp.locations ?? []);
    const item = {
      label,
      requested: location,
      condition: condition ?? null,
      scanRange: { start, end },
      rawPossibleBreakpointsResponse: possible,
      rawSetBreakpointResponse: bp,
      actualLocations,
      breakpointId: bp.breakpointId,
      possibleBreakpoints: possible.locations,
    };
    facts.breakpoints.push(item);
    save();
    if (!actualLocations.length) throw new Error(`${label} breakpoint was unresolved`);
    return { breakpointId: bp.breakpointId, actualLocations };
  };
  const ids = {
    p4: (
      await install(
        'P4 completeExecution after transaction, conditional S06',
        p4,
        'n.stepId === "S06"',
      )
    ).breakpointId,
  };
  return { inspector, ids, bundle, install, staticLocations: { p4 } };
}
/** @param {Inspector} inspector @param {CdpParams} paused @param {string} expression */
async function evaluateReadOnly(inspector, paused, expression) {
  const frame = paused.callFrames?.[0];
  if (!frame) return { error: 'no call frame' };
  try {
    const r = await inspector.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression,
      returnByValue: true,
      silent: true,
    });
    return {
      frame: { functionName: frame.functionName, url: frame.url, location: frame.location },
      value: r.result?.value,
      exception: r.exceptionDetails?.text,
    };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      functionName: frame.functionName,
      location: frame.location,
    };
  }
}

/** @param {Inspector} inspector @param {CdpParams} paused @param {string} label @param {string} runId */
async function inspectAtPause(inspector, paused, label, runId) {
  const callFrame = await evaluateReadOnly(
    inspector,
    paused,
    'JSON.stringify({workflowRunId:t.run.id,stepId:n.stepId,stepRunId:n.id,stepState:n.state,missionId:n.missionId,completionResult:A})',
  );
  facts.hits.push({
    label,
    at: new Date().toISOString(),
    reason: paused.reason,
    hitBreakpoints: paused.hitBreakpoints,
    actualLocation: paused.callFrames?.[0]?.location ?? null,
    callFrameCount: paused.callFrames?.length ?? 0,
    rawPaused: paused,
    callFrame,
  });
  facts.processTreeAtBreakpoint = await runtimeFacts(facts.app.mainPid ?? facts.app.launcherPid);
  facts.mainProcessIdentityAtBreakpoint = Array.isArray(facts.processTreeAtBreakpoint)
    ? (facts.processTreeAtBreakpoint.find((item) => item.ProcessId === facts.app.mainPid) ?? null)
    : facts.processTreeAtBreakpoint;
  facts.processTreeInterpretation =
    'Process-tree rows are candidate lineage only and may include stale/reused PIDs; Main identity is tied to Runtime.evaluate PID plus executable path and matching creation timestamp where available. This evidence is never used to terminate a process.';
    facts.databaseAtBreakpoint = readDb((db) => {
      const run = sqlRow(
        db,
        'SELECT id,state,wait_reason FROM workflow_runs WHERE id=?',
        runId,
      );
      const steps = sqlRows(
        db,
        'SELECT id,step_id,attempt,state,mission_id,mission_run_id FROM workflow_step_runs WHERE workflow_run_id=? ORDER BY created_at,id',
        runId,
      );
      const artifacts = tableRows(db, 'workflow_artifacts', 'workflow_run_id', runId);
      const checkpoints = tableRows(db, 'workflow_checkpoints', 'workflow_run_id', runId);
      const s06 = steps.find((x) => x.step_id === 'S06');
      const s06Artifacts = s06
        ? artifacts.rows.filter((a) => a.producer_step_run_id === s06.id)
        : [];
      const validationTable = tableRows(
        db,
        'workflow_validation_receipts',
        'workflow_run_id',
        runId,
      );
      const s06Validations = s06
        ? validationTable.rows.filter((v) => v.step_run_id === s06.id)
        : [];
      const s06Checkpoints = s06
        ? checkpoints.rows.filter((c) => {
            try {
      const ids = c.completed_step_run_ids_json;
              return JSON.parse(typeof ids === 'string' ? ids : '[]').includes(s06.id);
            } catch {
              return false;
            }
          })
        : [];
      return {
        run,
        steps,
        artifactsTableExists: artifacts.exists,
        validationTableExists: validationTable.exists,
        checkpointTableExists: checkpoints.exists,
        s06Artifacts: s06Artifacts.map((a) => ({
          id: a.id,
          kind: a.kind,
          content_hash: a.content_hash,
          producer_step_run_id: a.producer_step_run_id,
        })),
        s06ValidationReceipts: s06Validations,
        s06Checkpoints,
      };
    });
    const steps = /** @type {SqlRow[]} */ (facts.databaseAtBreakpoint.steps ?? []);
    const s06 = steps.find((x) => x.step_id === 'S06');
    facts.assertions = {
      runActiveAtS06Boundary: facts.databaseAtBreakpoint.run?.state === 'RUNNING',
      S06Completed: s06?.state === 'COMPLETED',
      S07Ready: steps.some((x) => x.step_id === 'S07' && x.state === 'READY'),
      checkpointIncludesS06: (facts.databaseAtBreakpoint.s06Checkpoints ?? []).length > 0,
      S06ArtifactsPresent: (facts.databaseAtBreakpoint.s06Artifacts ?? []).length > 0,
      S06ValidationPresent: (facts.databaseAtBreakpoint.s06ValidationReceipts ?? []).length > 0,
      requiredTablesPresent:
        facts.databaseAtBreakpoint.artifactsTableExists &&
        facts.databaseAtBreakpoint.validationTableExists &&
        facts.databaseAtBreakpoint.checkpointTableExists,
    };
    facts.verificationLedgerAtBreakpoint = verificationLedgerFacts();
    facts.independentVerificationCountsAtBreakpoint = {
      entry: facts.verificationLedgerAtBreakpoint.entryCount,
      completed: facts.verificationLedgerAtBreakpoint.completedCount,
      records: facts.verificationLedgerAtBreakpoint.records,
    };
}

/** @param {import('playwright-core').Page} page @param {string} runId */
async function pendingApproval(page, runId) {
  const detail = await page.evaluate((id) => window.cultivation.workflows.detail(id), runId);
  for (const step of [...detail.steps].reverse()) {
    if (!step.missionId) continue;
    const mission = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      step.missionId,
    );
    const approval = mission.approvals.find((item) => item.state === 'PENDING');
    if (approval) return { stepId: step.stepId, missionId: step.missionId, approval };
  }
  return null;
}
/** @param {string} runId */
async function eventCounts(runId) {
  return readDb((db) =>
    sqlRows(
      db,
      `
    SELECT e.event_type,COUNT(*) AS count
    FROM mission_events e JOIN workflow_step_runs s ON s.mission_id=e.mission_id
    WHERE s.workflow_run_id=? AND e.event_type IN ('model.call_started','tool.result')
    GROUP BY e.event_type ORDER BY e.event_type
  `,
      runId,
    ),
  );
}
function verificationLedgerFacts() {
  if (!existsSync(verificationLedger))
    return { exists: false, entryCount: 0, completedCount: 0, records: [] };
  const records = readFileSync(verificationLedger, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    exists: true,
    path: verificationLedger,
    sha256: fileFact(verificationLedger).sha256,
    entryCount: records.filter((item) => item.event === 'ENTRY').length,
    completedCount: records.filter((item) => item.event === 'COMPLETED').length,
    records,
  };
}
/** @param {import('playwright-core').Page} page @param {Inspector} inspector @param {string} runId @param {string} breakpointId */
async function driveToBreakpoint(page, inspector, runId, breakpointId) {
  for (let iteration = 0; iteration < 220; iteration++) {
    const detail = await page.evaluate((id) => window.cultivation.workflows.detail(id), runId);
    if (detail.run.state === 'FAILED')
      throw new Error(
        `workflow failed at ${detail.steps.find((s) => ['READY', 'RUNNING', 'WAITING'].includes(s.state))?.stepId ?? 'unknown'}`,
      );
    if (detail.run.state === 'COMPLETED')
      throw new Error('workflow completed without reaching target breakpoint');
    const approval = await pendingApproval(page, runId);
    if (approval) {
      /** @type {Record<string, unknown>} */
      const approvalFact = {
        stepId: approval.stepId,
        missionId: approval.missionId,
        approvalId: approval.approval.id,
        capability: approval.approval.capability,
        decision: 'ALLOW_MISSION',
        requestedAt: new Date().toISOString(),
      };
      facts.approvals = [...(facts.approvals ?? []), approvalFact];
      save();
      const waiter = breakpointWaiter(inspector, breakpointId);
      const action = page
        .evaluate(
          (id) =>
            window.cultivation.missions.resolveApproval({
              approvalId: id,
              decision: 'ALLOW_MISSION',
            }),
          approval.approval.id,
        )
        .then(
          (value) => /** @type {BreakpointRace} */ ({ kind: 'returned', value }),
          (error) =>
            /** @type {BreakpointRace} */ ({
              kind: 'error',
              error: String(error?.message ?? error),
            }),
        );
      const outcome = await Promise.race([
        waiter.promise.then(
          (paused) => /** @type {BreakpointRace} */ ({ kind: 'paused', paused }),
          (error) =>
            /** @type {BreakpointRace} */ ({ kind: 'waitError', error: String(error.message) }),
        ),
        action,
      ]);
      if (outcome.kind === 'paused') {
        approvalFact.breakpointPausedDuringResolution = true;
        approvalFact.pausedAt = new Date().toISOString();
        save();
        return {
          paused: outcome.paused,
          action,
          pauseSource: 'approval-resolution',
          approval: approvalFact,
        };
      }
      waiter.cancel();
      if (outcome.kind === 'error' || outcome.kind === 'waitError')
        throw new Error(`missions.resolveApproval failed: ${outcome.error}`);
      approvalFact.resolutionReturnedAt = new Date().toISOString();
      save();
      continue;
    }
    if (detail.run.state === 'WAITING' && detail.run.waitReason === 'USER_CONFIRMATION')
      throw new Error(
        `workflow requires user confirmation at ${detail.steps.find((s) => s.state === 'WAITING')?.stepId ?? 'unknown'}`,
      );
    const waiter = breakpointWaiter(inspector, breakpointId);
    facts.advanceDispatchCount = (facts.advanceDispatchCount ?? 0) + 1;
    const action = page
      .evaluate((id) => window.cultivation.workflows.advance(id), runId)
      .then(
        (value) => /** @type {AdvanceRace} */ ({ kind: 'returned', value }),
        (error) =>
          /** @type {AdvanceRace} */ ({
            kind: 'error',
            error: String(error?.message ?? error),
          }),
      );
    const outcome = await Promise.race([
      waiter.promise.then(
        (paused) => /** @type {AdvanceRace} */ ({ kind: 'paused', paused }),
        (error) =>
          /** @type {AdvanceRace} */ ({ kind: 'waitError', error: String(error.message) }),
      ),
      action,
    ]);
    if (outcome.kind === 'paused') return { paused: outcome.paused, action };
    waiter.cancel();
    if (outcome.kind === 'error' || outcome.kind === 'waitError')
      throw new Error(`workflows.advance failed: ${outcome.error}`);
    facts.advanceReturns = (facts.advanceReturns ?? 0) + 1;
    facts.lastAdvanceRunState = outcome.value?.run?.state ?? null;
    save();
    await delay(100);
  }
  throw new Error('workflow iteration limit reached before target breakpoint');
}

/** @overload @param {'Observe'} mode @param {Record<string,unknown>} [extra] @returns {Promise<ObserveReceipt>} */
/** @overload @param {'Terminate'} mode @param {Record<string,unknown>} [extra] @returns {Promise<ControlReceipt>} */
/** @param {'Observe'|'Terminate'} mode @param {Record<string,unknown>} [extra] */
async function processControl(mode, extra = {}) {
  const session = requireSession();
  const requestPath = join(evidence, `process-${mode}-${randomUUID()}.json`);
  const request = {
    mainPid: session.child.pid,
    executable: executablePath,
    profile,
    nodeExecutable: process.execPath,
    fixtureScript: workspaceVerifier,
    verifierScript: join(workspace, 'verify.mjs'),
    ...extra,
  };
  writeFileSync(requestPath, JSON.stringify(request), 'utf8');
  const result = await execFileAsync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      processControlPath,
      '-Mode',
      mode,
      '-RequestPath',
      requestPath,
    ],
    { windowsHide: true, env: childEnvironment(), timeout: 45000 },
  );
  return JSON.parse(result.stdout.trim());
}
/** @param {unknown} value @returns {value is SnapshotBoundary} */
function isSnapshotRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** @param {unknown} value @returns {SnapshotBoundary[] | null} */
function snapshotRows(value) {
  if (!Array.isArray(value) || !value.every(isSnapshotRecord)) return null;
  return value;
}
/** @param {SnapshotBoundary[] | null} rows @returns {Map<string,SnapshotBoundary> | null} */
function snapshotRowsById(rows) {
  if (!rows) return null;
  const result = new Map();
  for (const row of rows) {
    if (typeof row.id !== 'string' || result.has(row.id)) return null;
    result.set(row.id, row);
  }
  return result;
}
/** @param {unknown} left @param {unknown} right */
function sameSnapshotValue(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}
/** @param {Awaited<ReturnType<typeof captureStage>>} beforeSnapshot @param {Awaited<ReturnType<typeof captureStage>>} afterSnapshot @param {Session} session */
function assertFirstRestartBoundary(beforeSnapshot, afterSnapshot, session) {
  const beforeFacts = /** @type {SnapshotBoundary} */ (beforeSnapshot.facts);
  const afterFacts = /** @type {SnapshotBoundary} */ (afterSnapshot.facts);
  const beforeWorkflow = isSnapshotRecord(beforeFacts.workflow) ? beforeFacts.workflow : null;
  const afterWorkflow = isSnapshotRecord(afterFacts.workflow) ? afterFacts.workflow : null;
  const workflowIdentityUnchanged = Boolean(
    beforeWorkflow &&
      afterWorkflow &&
      typeof beforeWorkflow.id === 'string' &&
      beforeWorkflow.id === facts.runId &&
      sameSnapshotValue(
        {
          id: beforeWorkflow.id,
          definition_id: beforeWorkflow.definition_id,
          definition_version: beforeWorkflow.definition_version,
        },
        {
          id: afterWorkflow.id,
          definition_id: afterWorkflow.definition_id,
          definition_version: afterWorkflow.definition_version,
        },
      ),
  );
  const beforeSteps = snapshotRows(beforeFacts.steps);
  const afterSteps = snapshotRows(afterFacts.steps);
  const beforeStepMap = snapshotRowsById(beforeSteps);
  const afterStepMap = snapshotRowsById(afterSteps);
  const completedStepSet =
    beforeSteps?.filter((step) => step.state === 'COMPLETED').map((step) => ({
      id: step.id,
      step_id: step.step_id,
      attempt: step.attempt,
      state: step.state,
      mission_id: step.mission_id ?? null,
      mission_run_id: step.mission_run_id ?? null,
    })) ?? [];
  const completedStepIdentityUnchanged = Boolean(
    completedStepSet.length > 0 &&
      beforeStepMap &&
      afterStepMap &&
      completedStepSet.every((step) => {
        const after = afterStepMap.get(step.id);
        return Boolean(
          after &&
            sameSnapshotValue(
              {
                id: after.id,
                step_id: after.step_id,
                attempt: after.attempt,
                state: after.state,
                mission_id: after.mission_id ?? null,
                mission_run_id: after.mission_run_id ?? null,
              },
              step,
            ),
        );
      }),
  );
  const appendOnlyTables = [
    'workflow_artifacts',
    'workflow_validation_receipts',
    'workflow_checkpoints',
  ];
  /** @type {(SnapshotBoundary[] | null)[]} */
  const appendOnlyBefore = appendOnlyTables.map((table) => snapshotRows(beforeFacts[table]));
  /** @type {(SnapshotBoundary[] | null)[]} */
  const appendOnlyAfter = appendOnlyTables.map((table) => snapshotRows(afterFacts[table]));
  const appendOnlyRowCountsUnchanged = appendOnlyBefore.every((rows, index) => {
    const afterRows = appendOnlyAfter[index] ?? null;
    return rows !== null && afterRows !== null && rows.length === afterRows.length;
  });
  const appendOnlyRowsUnchanged = appendOnlyBefore.every((rows, index) => {
    const beforeById = snapshotRowsById(rows);
    const afterById = snapshotRowsById(appendOnlyAfter[index] ?? null);
    if (!beforeById || !afterById || beforeById.size !== afterById.size) return false;
    for (const [id, row] of beforeById) {
      if (!sameSnapshotValue(row, afterById.get(id))) return false;
    }
    return true;
  });
  const oldMissionRunIds = new Set(
    (beforeSteps ?? [])
      .filter((step) => step.state === 'COMPLETED' && typeof step.mission_run_id === 'string')
      .map((step) => step.mission_run_id),
  );
  const beforeMissionEvents = snapshotRows(beforeFacts.missionEvents);
  const afterMissionEvents = snapshotRows(afterFacts.missionEvents);
  /** @param {SnapshotBoundary[] | null} rows @returns {SnapshotBoundary[] | null} */
  const relevantMissionEvents = (rows) => {
    if (!rows) return null;
    return rows
      .filter(
        (event) =>
          oldMissionRunIds.has(event.run_id) &&
          typeof event.event_type === 'string' &&
          (event.event_type.startsWith('model.') || event.event_type.startsWith('tool.')),
      )
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  };
  const completedMissionRunEventsUnchanged = Boolean(
    oldMissionRunIds.size > 0 &&
      beforeMissionEvents &&
      afterMissionEvents &&
      sameSnapshotValue(
        relevantMissionEvents(beforeMissionEvents),
        relevantMissionEvents(afterMissionEvents),
      ),
  );
  const beforeVerifier = snapshotRows(beforeSnapshot.verifierLedger);
  const afterVerifier = snapshotRows(afterSnapshot.verifierLedger);
  /** @param {SnapshotBoundary[] | null} ledger @returns {{entryCount:number,completedCount:number} | null} */
  const verifierCount = (ledger) =>
    ledger
      ? {
          entryCount: ledger.filter((row) => row.event === 'ENTRY').length,
          completedCount: ledger.filter((row) => row.event === 'COMPLETED').length,
        }
      : null;
  const verifierLedgerExactlyOnceUnchanged = Boolean(
    Array.isArray(beforeVerifier) &&
      Array.isArray(afterVerifier) &&
      sameSnapshotValue(verifierCount(beforeVerifier), { entryCount: 1, completedCount: 1 }) &&
      sameSnapshotValue(verifierCount(afterVerifier), { entryCount: 1, completedCount: 1 }) &&
      sameSnapshotValue(beforeVerifier, afterVerifier),
  );
  facts.completedStepSetAtFirstRestart = completedStepSet;
  facts.firstRestartChecks = {
    workflowIdentityUnchanged,
    completedStepIdentityUnchanged,
    appendOnlyRowsUnchanged,
    appendOnlyRowCountsUnchanged,
    completedMissionRunEventsUnchanged,
    verifierLedgerExactlyOnceUnchanged,
    startupWriteEntriesZero: session.entryCount === 0,
    startupWriteReturnsZero: session.returnCount === 0,
  };
  save();
  const failures = Object.entries(facts.firstRestartChecks).filter(([, passed]) => passed !== true);
  assert.deepEqual(failures, [], 'First restart boundary changed committed state before explicit continue');
}
/** @param {string} name @param {string} lifecycle */
async function stage(name, lifecycle) {
  await pauseChain;
  const session = requireSession();
  const snapshot = await captureStage({
    stageRoot: runRoot,
    stage: name,
    databasePath,
    workspace,
    verifierLedger: verificationLedger,
    controllerLedger,
    runId: facts.runId ?? '__probe__',
    processState: {
      isolatedProfile: profile,
      workspace,
      mainPid: session.child.pid,
      generation: session.generation,
      profileVerifiedFromRuntime: session.profileVerified,
      startupIdentity: session.startupIdentity,
      runtimeIdentity: session.runtimeIdentity,
      controllerLaunch: session.controllerLaunch,
      lifecycle,
    },
  });
  lastConsistentPath = snapshot.consistentPath;
  facts.stages[name] = snapshotSummary(snapshot);
  writeFileSync(
    join(publication, name + '.json'),
    JSON.stringify(snapshot, null, 2) + '\n',
    'utf8',
  );
  save();
  return snapshot;
}
/** @param {number} generation @returns {Promise<Session>} */
async function launchGeneration(generation) {
  phase = generation ? 'STARTUP_RECOVERY' : 'INITIAL_STARTUP';
  const port = await availablePort();
  const chromePort = await availablePort();
  const spawnargs = [
    `--inspect-brk=127.0.0.1:${port}`,
    `--remote-debugging-port=${chromePort}`,
    ...facts.fixtureFlags,
    `--user-data-dir=${join(profile, 'Chromium')}`,
  ];
  const startedAt = new Date().toISOString();
  const child = spawn(
    executablePath,
    spawnargs,
    {
      cwd: runRoot,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const mainPid = child.pid;
  if (mainPid === undefined) throw new Error('Main spawn did not return an owned PID');
  current = {
    generation,
    child,
    port,
    chromePort,
    paused: false,
    entryCount: 0,
    returnCount: 0,
    profileVerified: false,
    activeReturns: new Set(),
    controllerLaunch: {
      mainPid,
      executable: executablePath,
      profile,
      spawnargs,
      launchToken: token,
      startedAt,
    },
  };
  const local = current;
  if (!local) throw new Error('Main session initialization failed');
  child.on('error', (error) => {
    local.spawnError = String(error);
  });
  child.stdout?.on('data', (data) =>
    appendFileSync(join(evidence, `generation-${generation}.stdout.txt`), data),
  );
  child.stderr?.on('data', (data) =>
    appendFileSync(join(evidence, `generation-${generation}.stderr.txt`), data),
  );
  const identity = await processControl('Observe');
  local.startupIdentity = identity.main;
  const inspector = await Inspector.connect(port);
  local.inspector = inspector;
  await inspector.send('Runtime.enable');
  await inspector.send('Debugger.enable');
  const armed = await inspector.send('Debugger.setBreakpointByUrl', {
    urlRegex: 'main-pyN31JHh\\.js$',
    lineNumber: 9848,
    columnNumber: 7612,
    condition: `this.rootPath.toLowerCase() === ${JSON.stringify(workspace.toLowerCase())}`,
  });
  local.observerId = armed.breakpointId;
  observe({
    event: 'OBSERVER_ARMED',
    breakpointId: armed.breakpointId,
    beforeBootstrapAndRecovery: true,
    mainPid: child.pid,
  });
  inspector.on('Debugger.paused', (paused) => {
    local.paused = true;
    pauseChain = pauseChain
      .then(async () => {
        if (paused.reason === 'Break on start') {
          local.paused = false;
          inspector.send('Debugger.resume').catch(() => {});
          return;
        }
        if (paused.hitBreakpoints?.includes(local.observerId)) {
          const frame = await evaluateReadOnly(
            inspector,
            paused,
            'JSON.stringify({path:t,workspaceRoot:this.rootPath})',
          );
          const value = JSON.parse(frame.value);
          local.entryCount++;
          observe({ event: 'WRITE_ENTRY', path: value.path, count: local.entryCount, frame });
          const post = await inspector.send('Debugger.setBreakpoint', {
            location: {
              scriptId: paused.callFrames[0].location.scriptId,
              lineNumber: 9848,
              columnNumber: 13661,
            },
          });
          local.activeReturns.add(post.breakpointId);
          local.paused = false;
          inspector.send('Debugger.resume').catch(() => {});
        } else if (
          /** @type {string[] | undefined} */ (paused.hitBreakpoints)?.some((id) =>
            local.activeReturns.has(id),
          )
        ) {
          const frame = await evaluateReadOnly(inspector, paused, 'JSON.stringify({path:r.path})');
          const value = JSON.parse(frame.value);
          local.returnCount++;
          observe({
            event: 'WRITE_RETURN',
            path: value.path,
            count: local.returnCount,
            file: fileFact(join(workspace, value.path)),
            frame,
          });
          for (const id of [...local.activeReturns]) {
            await inspector.send('Debugger.removeBreakpoint', { breakpointId: id });
            local.activeReturns.delete(id);
          }
          local.paused = false;
          inspector.send('Debugger.resume').catch(() => {});
        }
      })
      .catch((error) => {
        local.observerError = String(error.stack ?? error);
        save();
      });
  });
  await inspector.send('Runtime.runIfWaitingForDebugger');
  let browser;
  for (let attempt = 0; attempt < 250; attempt++) {
    if (local.spawnError || child.exitCode !== null)
      throw new Error(`Main exited during startup: ${local.spawnError ?? child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromePort}`, { timeout: 1000 });
      break;
    } catch {
      await delay(200);
    }
  }
  assert.ok(browser, 'Chromium CDP unavailable');
  let page;
  for (let attempt = 0; attempt < 250; attempt++) {
    page = browser
      .contexts()[0]
      ?.pages()
      .find((item) => item.url().startsWith('file:'));
    if (page) break;
    await delay(200);
  }
  assert.ok(page, 'Packaged page unavailable');
  local.page = page;
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 30000 });
  const runtime = await inspector.send('Runtime.evaluate', {
    expression:
      'JSON.stringify({pid:process.pid,execPath:process.execPath,userData:process.env.CULTIVATION_USER_DATA_DIR,electronUserData:require("electron").app.getPath("userData"),argv:process.argv})',
    returnByValue: true,
    includeCommandLineAPI: true,
  });
  const runtimeIdentity = /** @type {RuntimeIdentity} */ (JSON.parse(runtime.result.value));
  assert.equal(runtimeIdentity.pid, child.pid);
  assert.equal(runtimeIdentity.execPath.toLowerCase(), executablePath.toLowerCase());
  assert.equal(runtimeIdentity.userData, join(profile, 'UserData'));
  assert.equal(runtimeIdentity.electronUserData, join(profile, 'UserData'));
  assert.ok(fixtureFlags.every((flag) => runtimeIdentity.argv.includes(flag)));
  local.profileVerified = true;
  local.runtimeIdentity = runtimeIdentity;
  const observed = await processControl('Observe');
  assert.equal(observed.main.createdUtcTicks, identity.main.createdUtcTicks);
  local.osIdentity = observed;
  facts.app = {
    mainPid: child.pid,
    launcherPid: child.pid,
    mainExecPath: executablePath,
    runtimeIdentity,
    inspectorPort: port,
  };
  facts.generations.push({
    generation,
    mainPid: child.pid,
    startupIdentity: identity.main,
    runtimeIdentity,
    profileVerified: true,
    observerArmedBeforeBootstrap: true,
    readyAt: new Date().toISOString(),
  });
  local.app = {
    evaluate: async (fn, arg) => {
      const result = await inspector.send('Runtime.evaluate', {
        expression: `(async()=>{const electron=require('electron');return (${fn.toString()})(electron,${JSON.stringify(arg)});})()`,
        includeCommandLineAPI: true,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
  };
  save();
  log(`generation ${generation} healthy, Main=${child.pid}, observer armed before bootstrap`);
  return local;
}
async function normalClose() {
  const session = requireSession();
  if (session.child.exitCode !== null) return;
  phase = 'NORMAL_CLOSE';
  if (session.paused) throw new Error('Refusing normal close while formal barrier remains paused');
  const inspector = requireInspector(session);
  const page = requirePage(session);
  await inspector.send('Debugger.disable');
  await inspector.close();
  const closing = page.evaluate(() => window.cultivation.desktop.close()).catch(() => {});
  await Promise.race([closing, delay(3000)]);
  const until = Date.now() + 30000;
  while (session.child.exitCode === null && Date.now() < until) await delay(100);
  assert.notEqual(
    session.child.exitCode,
    null,
    'Normal close did not finish; no fallback forced termination permitted',
  );
  const generation = facts.generations.at(-1);
  assert.ok(generation);
  generation.normalClose = {
    exitCode: session.child.exitCode,
    finishedAt: new Date().toISOString(),
  };
  save();
}
async function plannedKill() {
  const session = requireSession();
  assert.equal(facts.killOrdinal, 0);
  assert.ok(session.profileVerified && session.paused);
  assert.ok(session.startupIdentity, 'Missing startup process identity for the kill request');
  assert.ok(session.runtimeIdentity, 'Missing runtime process identity for the kill request');
  assert.ok(session.controllerLaunch, 'Missing controller launch identity for the kill request');
  assert.equal(session.controllerLaunch.mainPid, session.child.pid);
  assert.equal(session.controllerLaunch.launchToken, token);
  assert.ok(facts.stages.BeforeCrash, 'The exact pre-crash snapshot is required');
  assert.ok(
    Object.values(facts.assertions).every(Boolean),
    'All formal barrier assertions required',
  );
  const identity = await processControl('Observe');
  assert.equal(identity.main.createdUtcTicks, session.startupIdentity?.createdUtcTicks);
  assert.equal(identity.main.pid, session.runtimeIdentity?.pid);
  assert.equal(identity.main.executable.toLowerCase(), executablePath.toLowerCase());
  assert.ok(identity.main.commandLine.toLowerCase().includes(profile.toLowerCase()));
  facts.killOrdinal = 1;
  facts.killRequestIdentity = identity;
  save();
  facts.termination = await processControl('Terminate', {
    authorization: 'USER_APPROVED_E3_CR_A_CORRECTIVE_ONE_MAIN_KILL',
    case: 'CR_A_CORRECTIVE',
    killOrdinal: 1,
    profileVerifiedFromRuntime: true,
    breakpointAndSnapshotVerified: true,
    identities: identity.verified,
    startupIdentity: session.startupIdentity,
    runtimeIdentity: session.runtimeIdentity,
    controllerLaunch: session.controllerLaunch,
  });
  assert.equal(facts.termination.status, 'TERMINATED');
  await requireInspector(session).close();
  session.paused = false;
  save();
  log('one planned Main forced termination completed; verified original process identities absent');
}
/** @param {import('playwright-core').Page} page @param {string} runId */
async function continueToCompletion(page, runId) {
  for (let i = 0; i < 220; i++) {
    const detail = await page.evaluate((id) => window.cultivation.workflows.detail(id), runId);
    if (detail.run.state === 'COMPLETED') return detail;
    assert.ok(
      !['FAILED', 'CANCELLED'].includes(detail.run.state),
      `Explicit continue ended ${detail.run.state}`,
    );
    const approval = await pendingApproval(page, runId);
    if (approval)
      await page.evaluate(
        (id) =>
          window.cultivation.missions.resolveApproval({
            approvalId: id,
            decision: 'ALLOW_MISSION',
          }),
        approval.approval.id,
      );
    else {
      assert.notEqual(
        detail.run.waitReason,
        'USER_CONFIRMATION',
        'Unexpected manual intervention during explicit continue',
      );
      await page.evaluate((id) => window.cultivation.workflows.advance(id), runId);
    }
    await delay(100);
  }
  throw new Error('Explicit continue limit reached');
}
try {
  save();
  const controllerPath = fileURLToPath(import.meta.url);
  const controllerHash = fileFact(controllerPath).sha256;
  const safetyHelperHash = fileFact(processControlPath).sha256;
  const safetyPolicyHash = fileFact(processPolicyPath).sha256;
  assert.ok(controllerHash, 'Unable to hash the running corrective controller');
  assert.ok(safetyHelperHash, 'Unable to hash the exact Main process-control helper');
  assert.ok(safetyPolicyHash, 'Unable to hash the process identity safety policy');
  facts.launchIntegrity = {
    controllerPath,
    controllerSha256: controllerHash,
    processControlPath,
    processControlSha256: safetyHelperHash,
    processPolicyPath,
    processPolicySha256: safetyPolicyHash,
    capturedBeforeFirstLaunch: true,
  };
  save();
  assert.equal(
    fileFact(executablePath).sha256,
    '8a4cdbce704b86297dfee1bc0e22c9b92fc225bdb31eda6501aa668108e4b42c',
  );
  let session = await launchGeneration(0);
  /** @type {Awaited<ReturnType<typeof captureStage>> | undefined} */
  let beforeCrashSnapshot;
  if (requestedCase === 'PROBE') {
    await connectAndBreak();
    facts.fixtureSetup = await setupFixture(requirePage(session));
    await chooseWorkspaceBeforeWorkflowDrawer(requireApp(session), requirePage(session), workspace);
    await stage('ProbeReady', 'RUNNING');
    await normalClose();
    facts.status = 'PROBE_PASS';
  } else {
    phase = 'WORKFLOW_EXECUTION';
    const connected = await connectAndBreak();
    const fixtureSetup = await setupFixture(requirePage(session));
    facts.fixtureSetup = fixtureSetup;
    assert.ok(fixtureSetup.availability.every(({ latest }) => latest.status === 'AVAILABLE'));
    await chooseWorkspaceBeforeWorkflowDrawer(requireApp(session), requirePage(session), workspace);
    facts.runId = await createWorkflowViaIpc(
      requirePage(session),
      fixtureSetup.toolId,
      workspaceFixture,
    );
    log(`formal workflow created ${facts.runId}`);
    if (requestedCase === 'CR_A_CORRECTIVE') {
      const hit = await driveToBreakpoint(
        requirePage(session),
        requireInspector(session),
        facts.runId,
        connected.ids.p4,
      );
      phase = 'FORMAL_BARRIER';
      session.paused = true;
      beforeCrashSnapshot = await stage('BeforeCrash', 'PAUSED');
      await inspectAtPause(requireInspector(session), hit.paused, 'P4', facts.runId);
      const s07 = /** @type {SqlRow[]} */ (facts.stages.BeforeCrash.facts.steps).find(
        (step) => step.step_id === 'S07',
      );
      assert.ok(s07, 'S07 row missing from the sealed before-crash snapshot');
      facts.assertions.S07MissionAbsent = !s07.mission_id;
      facts.assertions.verifierExactlyOnce =
        verificationLedgerFacts().entryCount === 1 &&
        verificationLedgerFacts().completedCount === 1;
      facts.assertions.compiledBundleVerified = facts.bundle.sha256 === facts.bundle.expectedSha256;
      facts.eventCountsAtBarrier = await eventCounts(facts.runId);
    }
    save();
    assert.ok(
      Object.values(facts.assertions).every(Boolean),
      `Barrier rejected: ${JSON.stringify(facts.assertions)}`,
    );
    await plannedKill();
    await stage('AfterKill', 'TERMINATED');
    session = await launchGeneration(1);
    await delay(2500);
    phase = 'BEFORE_ANY_MANUAL_CONTINUE';
    facts.auditStageMap = { firstRestart: 'FirstRestartBeforeContinue' };
    const firstRestartSnapshot = await stage('FirstRestartBeforeContinue', 'RUNNING');
    if (requestedCase === 'CR_A_CORRECTIVE') {
      assert.ok(beforeCrashSnapshot, 'Missing exact pre-crash snapshot');
      assertFirstRestartBoundary(beforeCrashSnapshot, firstRestartSnapshot, session);
      phase = 'EXPLICIT_CONTINUE';
      observe({ event: 'USER_EXPLICIT_CONTINUE', runId: facts.runId });
      facts.explicitContinue = {
        requestedAt: new Date().toISOString(),
        via: 'window.cultivation.workflows.advance + public approval IPC',
      };
      facts.continuedDetail = await continueToCompletion(requirePage(session), facts.runId);
      await delay(1000);
      await stage('ExplicitContinue', 'RUNNING');
    }
    await normalClose();
    session = await launchGeneration(2);
    await delay(2500);
    phase = 'SECOND_RESTART_NO_ACTION';
    await stage('SecondRestart', 'RUNNING');
    assert.equal(session.entryCount, 0, 'Second startup replayed a real write entry');
    assert.equal(session.returnCount, 0, 'Second startup replayed a real write return');
    await normalClose();
    facts.status = 'EXECUTION_COMPLETE_PENDING_INVARIANTS';
  }
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  facts.status = facts.killOrdinal ? 'FORMAL_EXECUTION_INCOMPLETE' : 'BLOCKED_BEFORE_KILL';
  facts.error = { message: failure.message, stack: failure.stack ?? '' };
  save();
  log(`stopped: ${facts.error.message}`);
  const ownedSession = current;
  if (ownedSession && !ownedSession.paused && ownedSession.child.exitCode === null) {
    try {
      await normalClose();
    } catch (closeError) {
      facts.cleanupError = closeError instanceof Error ? closeError.message : String(closeError);
    }
  }
} finally {
  facts.finishedAt = new Date().toISOString();
  save();
}
log(`final ${facts.status}; ${reportPath}`);
