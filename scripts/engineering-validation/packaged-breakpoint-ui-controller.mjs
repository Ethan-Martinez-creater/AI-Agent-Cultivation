import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { preparePackagedWorkspace } from './packaged-workspace-fixture.mjs';
const execFileAsync = promisify(execFile);
const { fetch, WebSocket } = globalThis;
const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '..', '..');
const repositoryRoot = process.env.E1_REPOSITORY_ROOT
  ? resolve(process.env.E1_REPOSITORY_ROOT)
  : existsSync(join(worktreeRoot, 'out'))
    ? worktreeRoot
    : resolve(worktreeRoot, '..', '..');
assert.match(worktreeRoot, /^E:[\\/]/i, 'Run the controller from the approved E: workspace');
assert.match(repositoryRoot, /^E:[\\/]/i, 'Use an E: repository and packaged artifact');
const scenario = (process.argv[2] || '').toUpperCase();
assert.ok(
  ['CR_A_P4', 'CR_B_P5'].includes(scenario),
  'usage: node packaged-breakpoint-ui-controller.mjs CR_A_P4|CR_B_P5',
);
const token = `${scenario.toLowerCase()}-${randomUUID()}`;
const scratchRoot =
  basename(worktreeRoot) === 'e1-packaged-preflight' && basename(dirname(worktreeRoot)) === '.tmp'
    ? worktreeRoot
    : join(worktreeRoot, '.tmp', 'e1-packaged-preflight');
const runRoot = join(scratchRoot, 'isolated', token);
const profile = join(runRoot, 'profile');
const workspace = join(runRoot, 'workspace');
const evidence = join(scratchRoot, 'evidence', token);
const temp = join(profile, 'Temp');
for (const dir of [
  evidence,
  workspace,
  temp,
  join(profile, 'Roaming'),
  join(profile, 'Local'),
  join(profile, 'UserData'),
  join(profile, 'Chromium'),
])
  mkdirSync(dir, { recursive: true });
const databasePath = join(profile, 'UserData', 'data', 'cultivation.sqlite');
const workspaceVerifier = join(worktreeRoot, 'scripts', 'fixtures', 'software-mcp-fixture.mjs');
const workspaceFixture = preparePackagedWorkspace({ workspace, evidence });
const verificationLedger = workspaceFixture.ledgerPath;
const executablePath = join(
  repositoryRoot,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
assert.ok(existsSync(executablePath), `packaged EXE missing at ${executablePath}`);
const facts = {
  schemaVersion: 1,
  scenario,
  startedAt: new Date().toISOString(),
  status: 'STARTING',
  executablePath,
  profile,
  workspace,
  databasePath,
  evidence,
  verificationLedger,
  workspaceFixture: {
    objective: workspaceFixture.objective,
    targetArea: workspaceFixture.targetArea,
    targetPath: workspaceFixture.targetPath,
    expectedSha256: workspaceFixture.expectedSha256,
    language: workspaceFixture.language,
    metadata: workspaceFixture.metadata,
  },
  fixture: 'offline --gate1-fake-model --r4-fake-routing --w22-fake-software',
  fixtureLanguage: workspaceFixture.language,
  testOnlySeams: [
    'Playwright ElectronApplication.evaluate installs only a dialog.showOpenDialog stub returning this isolated E-drive workspace; subsequent chooser click and workflow launch use the visible renderer UI and exposed preload IPC.',
    'The workspace verifier appends ENTRY/FAILED/COMPLETED records with PID and timestamp to an E-drive evidence ledger; this is test-only invocation telemetry.',
  ],
  restrictions: {
    realProvider: false,
    providerKeysPassed: false,
    workflowBusinessStateMutatedViaMainEvaluation: false,
    privateDatabaseWrites: false,
    forcedTermination: false,
    productionFilesModified: false,
  },
  breakpoints: [],
  hits: [],
  observations: [],
};
const reportPath = join(evidence, 'breakpoint-execution.json');
const save = () => writeFileSync(reportPath, JSON.stringify(facts, null, 2), 'utf8');
const log = (s) => {
  process.stdout.write(`${s}\n`);
  facts.observations.push({ at: new Date().toISOString(), text: s });
  save();
};
save();
async function availablePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
function sha(data) {
  return createHash('sha256').update(data).digest('hex');
}
function fileFact(path) {
  return existsSync(path)
    ? { exists: true, sizeBytes: statSync(path).size, sha256: sha(readFileSync(path)) }
    : { exists: false };
}
function sourceLocation(source, index) {
  const before = source.slice(0, index);
  const lineNumber = (before.match(/\n/g) || []).length;
  return { lineNumber, columnNumber: index - before.lastIndexOf('\n') - 1 };
}
class Inspector {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
        for (const fn of this.listeners.get(m.method) || []) fn(m.params);
      }
    });
  }
  static async connect(port) {
    let target;
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((x) => x.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* ignore transient probe failure */
      }
      await delay(100);
    }
    if (!target) throw new Error('Node inspector endpoint did not appear');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Inspector(ws);
  }
  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }
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
function breakpointWaiter(inspector, bpId, timeoutMs = 180000) {
  const idx = inspector.events.findIndex(
    (e) => e.method === 'Debugger.paused' && e.params.hitBreakpoints?.includes(bpId),
  );
  if (idx >= 0)
    return { promise: Promise.resolve(inspector.events.splice(idx, 1)[0].params), cancel() {} };
  let timer;
  let resolvePromise;
  let rejectPromise;
  const fn = (p) => {
    if (p.hitBreakpoints?.includes(bpId)) {
      clearTimeout(timer);
      off();
      resolvePromise(p);
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
      rejectPromise(new Error(`breakpoint waiter cancelled: ${bpId}`));
    },
  };
}
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
function readDb(fn) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    db.pragma('query_only = ON');
    return fn(db);
  } finally {
    db.close();
  }
}
function tableRows(db, table, column, value) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return { table, exists: false, rows: [] };
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((x) => x.name);
  if (!columns.includes(column)) return { table, exists: true, columns, rows: [] };
  const safeColumns = columns.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x));
  return {
    table,
    exists: true,
    columns: safeColumns,
    rows: db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).all(value),
  };
}
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
      for (const [name, score] of [
        ['青岚', 95],
        ['明衡', 85],
      ]) {
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
        if (observations[0].status === 'UNAVAILABLE')
          observations.push(await api.availability.recheck(actor.id));
        availability.push({ teammateId: actor.id, observations, latest: observations.at(-1) });
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
async function connectAndBreak(app, port, fixture) {
  const inspector = await Inspector.connect(port);
  const scripts = [];
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
  const site = (needle, delta = 0) => {
    const ix = bundle.source.indexOf(needle);
    if (ix < 0 || bundle.source.indexOf(needle, ix + needle.length) >= 0)
      throw new Error(`target must be unique: ${needle}`);
    return { index: ix + delta, ...sourceLocation(bundle.source, ix + delta) };
  };
  const p4 = site('}),A}chooseEdge', 3);
  const p5entry = site('if(n.length>Ma)');
  const p5post = site(',{content:"Text written."}', 1);
  facts.staticLocations = { P4: p4, P5entry: p5entry, P5postwrite: p5post };
  if (scenario === 'CR_A_P4' && (p4.lineNumber !== 9625 || p4.columnNumber !== 7198))
    throw new Error(`P4 location drift: ${JSON.stringify(p4)}`);
  if (
    scenario === 'CR_B_P5' &&
    (p5entry.lineNumber !== 9848 ||
      p5entry.columnNumber !== 7607 ||
      p5post.lineNumber !== 9848 ||
      p5post.columnNumber !== 13635)
  )
    throw new Error(`P5 location drift: ${JSON.stringify({ p5entry, p5post })}`);
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
  const ids =
    scenario === 'CR_A_P4'
      ? {
          p4: (
            await install(
              'P4 completeExecution after transaction, conditional S06',
              p4,
              'n.stepId === "S06"',
            )
          ).breakpointId,
        }
      : {
          p5entry: await install(
            'P5 workspace.writeText method entry before file mutation',
            p5entry,
            `t === ${JSON.stringify(fixture.targetPath)} && this.rootPath.toLowerCase() === ${JSON.stringify(workspace.toLowerCase())}`,
            { startLine: 9848, startColumn: 7588, endLine: 9848, endColumn: 7625 },
          ),
        };
  return { inspector, ids, bundle, install, staticLocations: { p4, p5entry, p5post } };
}
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
    return { error: String(e.message), functionName: frame.functionName, location: frame.location };
  }
}
async function launchApp() {
  const port = await availablePort();
  const env = {
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
    CULTIVATION_USER_DATA_DIR: join(profile, 'UserData'),
    W22_WORKSPACE_ROOT: workspace,
  };
  const app = await electron.launch({
    executablePath,
    args: [
      '--gate1-fake-model',
      '--r4-fake-routing',
      '--w22-fake-software',
      `--inspect=127.0.0.1:${port}`,
      `--user-data-dir=${join(profile, 'Chromium')}`,
    ],
    env,
    timeout: 0,
    dumpio: true,
  });
  const child = app.process();
  facts.app = {
    launcherPid: child.pid,
    spawnfile: child.spawnfile,
    spawnargs: child.spawnargs,
    configuredExe: executablePath,
    inspectorPort: port,
    observedAt: new Date().toISOString(),
    processTree: await runtimeFacts(child.pid),
  };
  save();
  const page = await app.firstWindow({ timeout: 45000 });
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 25000 });
  await page.screenshot({ path: join(evidence, 'home.png'), timeout: 15000 });
  facts.homepage = {
    title: await page.title(),
    url: page.url(),
    screenshot: join(evidence, 'home.png'),
  };
  return { app, page, port };
}
async function inspectAtPause(inspector, paused, label, runId) {
  const p4 = label === 'P4';
  const p5Entry = label === 'P5-entry';
  const callFrame = await evaluateReadOnly(
    inspector,
    paused,
    p4
      ? 'JSON.stringify({workflowRunId:t.run.id,stepId:n.stepId,stepRunId:n.id,stepState:n.state,missionId:n.missionId,completionResult:A})'
      : p5Entry
        ? 'JSON.stringify({path:t,relativePath:t,contentLength:n.length,workspaceRoot:this.rootPath})'
        : 'JSON.stringify({path:r.path,contentLength:r.content.length})',
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
  if (p4) {
    facts.databaseAtBreakpoint = readDb((db) => {
      const run = db
        .prepare('SELECT id,state,wait_reason FROM workflow_runs WHERE id=?')
        .get(runId);
      const steps = db
        .prepare(
          'SELECT id,step_id,attempt,state,mission_id,mission_run_id FROM workflow_step_runs WHERE workflow_run_id=? ORDER BY created_at,id',
        )
        .all(runId);
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
              return JSON.parse(c.completed_step_run_ids_json ?? '[]').includes(s06.id);
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
    const steps = facts.databaseAtBreakpoint.steps ?? [];
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
  } else {
    let toolPath;
    let frameValue;
    try {
      frameValue = JSON.parse(callFrame.value);
      toolPath = frameValue.path;
    } catch {
      /* ignore transient probe failure */
    }
    if (label === 'P5-entry') {
      facts.P5entry = {
        relativePath: toolPath ?? null,
        workspaceRoot: frameValue?.workspaceRoot ?? null,
        contentLength: frameValue?.contentLength ?? null,
        filePath: toolPath ? join(workspace, toolPath) : null,
        fileBefore: toolPath ? fileFact(join(workspace, toolPath)) : null,
        database: p5DatabaseState(runId),
        actualLocation: paused.callFrames?.[0]?.location ?? null,
      };
      facts.P5entry.hitCount = facts.hits.filter((hit) => hit.label === 'P5-entry').length;
    } else {
      const filePath = toolPath ? join(workspace, toolPath) : facts.P5entry?.filePath;
      const dbState = p5DatabaseState(runId);
      facts.P5postwrite = {
        filePath,
        relativePath: frameValue?.path ?? null,
        contentLength: frameValue?.contentLength ?? null,
        returnValue: paused.callFrames?.[0]?.returnValue ?? null,
        fileAfter: filePath ? fileFact(filePath) : null,
        database: dbState,
        sourceSidecarsAtCapture: {
          wal: fileFact(`${databasePath}-wal`),
          shm: fileFact(`${databasePath}-shm`),
        },
        actualLocation: paused.callFrames?.[0]?.location ?? null,
        breakpointCandidate: facts.P5postwriteCandidate ?? null,
      };
      facts.P5postwrite.hitCounts = {
        entry: facts.hits.filter((h) => h.label === 'P5-entry').length,
        postwrite: facts.hits.filter((h) => h.label === 'P5-postwrite').length,
      };
      const beforeHash = facts.P5entry?.fileBefore?.sha256;
      const afterHash = facts.P5postwrite.fileAfter?.sha256;
      facts.P5postwrite.fileHashChanged = Boolean(
        beforeHash && afterHash && beforeHash !== afterHash,
      );
      facts.P5postwrite.fileHashMatchesJournal = dbState.journalRows.some(
        (row) => row.expected_after_hash === afterHash,
      );
      const entryBreakpoint = facts.breakpoints.find(
        (item) => item.label === 'P5 workspace.writeText method entry before file mutation',
      );
      const postBreakpoint = facts.breakpoints.find(
        (item) => item.label === 'P5 builtin file.writeText return before async execute resolves',
      );
      facts.assertions = {
        ...facts.assertions,
        entryHitCount: facts.P5postwrite.hitCounts.entry === 1 && facts.P5entry?.hitCount === 1,
        postwriteHitCount: facts.P5postwrite.hitCounts.postwrite === 1,
        postwriteFrameIsBuiltinExecute:
          facts.hits.at(-1)?.callFrame?.frame?.functionName === 'execute' &&
          facts.P5postwrite.relativePath === workspaceFixture.targetPath,
        distinctActualLocations:
          entryBreakpoint?.actualLocations?.[0]?.lineNumber !==
            postBreakpoint?.actualLocations?.[0]?.lineNumber ||
          entryBreakpoint?.actualLocations?.[0]?.columnNumber !==
            postBreakpoint?.actualLocations?.[0]?.columnNumber,
        fileExistsAfterWrite: facts.P5postwrite.fileAfter?.exists === true,
        fileHashChanged: facts.P5postwrite.fileHashChanged,
        fileHashMatchesJournal: facts.P5postwrite.fileHashMatchesJournal,
        fileHashMatchesFixtureOutput: afterHash === workspaceFixture.expectedSha256,
        operationReceiptPrepared:
          dbState.operationsTableExists &&
          dbState.operationRows.length > 0 &&
          dbState.operationRows.every((row) => row.state === 'PREPARED'),
        mutationJournalPrepared:
          dbState.journalTableExists &&
          dbState.journalRows.length > 0 &&
          dbState.journalRows.every((row) => row.state === 'PREPARED'),
        noSuccessfulFileWriteToolResult:
          dbState.missionEventsTableExists && dbState.fileWriteToolResultCount === 0,
      };
    }
  }
}

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
async function eventCounts(runId) {
  return readDb((db) =>
    db
      .prepare(
        `
    SELECT e.event_type,COUNT(*) AS count
    FROM mission_events e JOIN workflow_step_runs s ON s.mission_id=e.mission_id
    WHERE s.workflow_run_id=? AND e.event_type IN ('model.call_started','tool.result')
    GROUP BY e.event_type ORDER BY e.event_type
  `,
      )
      .all(runId),
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
function p5DatabaseState(runId) {
  return readDb((db) => {
    const step = db
      .prepare(
        "SELECT id,step_id,attempt,state,mission_id,mission_run_id FROM workflow_step_runs WHERE workflow_run_id=? AND step_id='S05' ORDER BY attempt DESC LIMIT 1",
      )
      .get(runId);
    const operations = step
      ? tableRows(db, 'workflow_step_operation_receipts', 'step_run_id', step.id)
      : { exists: false, rows: [] };
    const journal = tableRows(db, 'workflow_workspace_mutation_journal', 'workflow_run_id', runId);
    const missionEvents = step?.mission_id
      ? tableRows(db, 'mission_events', 'mission_id', step.mission_id)
      : { exists: false, rows: [] };
    const writeToolResults = (missionEvents.rows ?? []).filter(
      (event) =>
        event.event_type === 'tool.result' &&
        (() => {
          try {
            return JSON.parse(event.payload_json ?? '{}').toolId === 'file.writeText';
          } catch {
            return false;
          }
        })(),
    );
    const operationRows = operations.rows
      .filter((row) => row.attempt === step?.attempt)
      .map((row) => ({
        state: row.state,
        operation_id: row.operation_id ?? row.id,
        attempt: row.attempt,
        workflow_run_id: row.workflow_run_id,
        step_run_id: row.step_run_id,
        effect_type: row.effect_type,
      }));
    const journalRows = journal.rows
      .filter((row) => row.step_run_id === step?.id)
      .map((row) => ({
        state: row.state,
        mutation_id: row.mutation_id ?? row.id,
        operation_receipt_id: row.operation_receipt_id,
        workflow_run_id: row.workflow_run_id,
        step_run_id: row.step_run_id,
        mission_id: row.mission_id,
        mission_run_id: row.mission_run_id,
        tool_call_id: row.tool_call_id,
        tool_id: row.tool_id,
        attempt: row.attempt,
        before_hash: row.before_hash ?? null,
        expected_before_hash: row.expected_before_hash ?? row.before_hash ?? null,
        expected_after_hash: row.expected_after_hash ?? null,
        observed_after_hash: row.observed_after_hash ?? null,
        relative_path: row.relative_path ?? null,
      }));
    return {
      step: step
        ? {
            id: step.id,
            attempt: step.attempt,
            state: step.state,
            missionId: step.mission_id,
            missionRunId: step.mission_run_id,
          }
        : null,
      operationsTableExists: operations.exists,
      operationRows,
      journalTableExists: journal.exists,
      journalRows,
      missionEventsTableExists: missionEvents.exists,
      fileWriteToolResultCount: writeToolResults.length,
      fileWriteToolResultEventIds: writeToolResults.map((event) => event.id),
    };
  });
}
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
          (value) => ({ kind: 'returned', value }),
          (error) => ({ kind: 'error', error: String(error?.message ?? error) }),
        );
      const outcome = await Promise.race([
        waiter.promise.then(
          (paused) => ({ kind: 'paused', paused }),
          (error) => ({ kind: 'waitError', error: String(error.message) }),
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
      if (outcome.kind === 'error')
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
        (value) => ({ kind: 'returned', value }),
        (error) => ({ kind: 'error', error: String(error?.message ?? error) }),
      );
    const outcome = await Promise.race([
      waiter.promise.then(
        (paused) => ({ kind: 'paused', paused }),
        (error) => ({ kind: 'waitError', error: String(error.message) }),
      ),
      action,
    ]);
    if (outcome.kind === 'paused') return { paused: outcome.paused, action };
    waiter.cancel();
    if (outcome.kind === 'error') throw new Error(`workflows.advance failed: ${outcome.error}`);
    facts.advanceReturns = (facts.advanceReturns ?? 0) + 1;
    facts.lastAdvanceRunState = outcome.value?.run?.state ?? null;
    save();
    await delay(100);
  }
  throw new Error('workflow iteration limit reached before target breakpoint');
}

let app;
let page;
let inspector;
let paused = false;
let activeAdvance;
let breakpointIds = [];
try {
  facts.status = 'LAUNCHING_PACKAGED_EXE';
  save();
  const launched = await launchApp();
  app = launched.app;
  page = launched.page;
  facts.status = 'HEALTHY_PACKAGED_WINDOW';
  save();
  log(`healthy packaged window opened; PID=${facts.app.launcherPid}`);
  const connected = await connectAndBreak(app, launched.port, workspaceFixture);
  breakpointIds =
    scenario === 'CR_A_P4' ? [connected.ids.p4] : [connected.ids.p5entry.breakpointId];
  inspector = connected.inspector;
  facts.status = 'INSPECTOR_ATTACHED_AND_BREAKPOINTS_SET';
  save();
  const runtimeIdentity = await inspector.send('Runtime.evaluate', {
    expression:
      "JSON.stringify({pid:process.pid,execPath:process.execPath,userData:process.env.CULTIVATION_USER_DATA_DIR??null,fixtureArgs:process.argv.filter(a=>['--gate1-fake-model','--r4-fake-routing','--w22-fake-software'].includes(a)),electronUserData:typeof require==='function'?require('electron').app.getPath('userData'):null})",
    returnByValue: true,
    silent: true,
  });
  facts.runtimeIdentity = {
    value: runtimeIdentity.result?.value ?? null,
    exception: runtimeIdentity.exceptionDetails?.text ?? null,
    observedAt: new Date().toISOString(),
  };
  try {
    const identity = JSON.parse(facts.runtimeIdentity.value);
    facts.app.mainPid = identity.pid;
    facts.app.mainExecPath = identity.execPath;
    facts.app.runtimeFixtureArgs = identity.fixtureArgs;
    facts.fixtureFlagsVerified = [
      '--gate1-fake-model',
      '--r4-fake-routing',
      '--w22-fake-software',
    ].every((arg) => identity.fixtureArgs.includes(arg));
    if (!facts.fixtureFlagsVerified)
      throw new Error('packaged Main argv is missing an approved offline fixture flag');
  } catch (error) {
    if (error?.message?.includes('missing an approved offline fixture flag')) throw error;
    facts.runtimeIdentity.parseError = String(error?.message ?? error);
  }
  save();
  facts.fixtureSetup = await setupFixture(page);
  facts.observations.push({
    at: new Date().toISOString(),
    text: 'Controller fixture correction: benchmarks target teammate.currentRuntimeProfileId (sealed clone) rather than the source runtime template; prior S01 NO_CAPABLE_EXECUTOR was a controller fixture defect, not evidence of a production R4 defect.',
  });
  facts.observations.push({
    at: new Date().toISOString(),
    text: 'Controller fixture correction: workspace now includes required package.json (type=module, test=node verify.mjs); prior run’s S01 mission exhausted tool calls after file.readText failures because the required input file was absent.',
  });
  save();
  facts.availabilityBeforeWorkflow = facts.fixtureSetup.availability.map(
    ({ teammateId, observations, latest }) => ({
      teammateId,
      observations: observations.map(({ status, recentOutcomes, lastCheckedAt }) => ({
        status,
        recentOutcomes,
        lastCheckedAt,
      })),
      latestStatus: latest.status,
    }),
  );
  if (facts.fixtureSetup.availability.some(({ latest }) => latest.status !== 'AVAILABLE'))
    throw new Error(
      'offline fake-model availability recheck did not make every seeded teammate AVAILABLE',
    );
  await chooseWorkspaceBeforeWorkflowDrawer(app, page, workspace);
  facts.runId = await createWorkflowViaIpc(page, facts.fixtureSetup.toolId, workspaceFixture);
  facts.status = 'WORKFLOW_CREATED';
  save();
  log(`official.software-feature@1 created; runId=${facts.runId}`);

  if (scenario === 'CR_A_P4') {
    const result = await driveToBreakpoint(page, inspector, facts.runId, connected.ids.p4);
    paused = true;
    activeAdvance = result.action;
    await inspectAtPause(inspector, result.paused, 'P4', facts.runId);
    facts.advanceDispatchCountAtPause = facts.advanceDispatchCount;
    facts.eventCountsAtPause = await eventCounts(facts.runId);
    await delay(1200);
    facts.eventCountsAfterPausedInterval = await eventCounts(facts.runId);
    facts.advanceDispatchCountAfterPausedInterval = facts.advanceDispatchCount;
    facts.assertions.externalEventCountsStableWhilePaused =
      JSON.stringify(facts.eventCountsAtPause) ===
      JSON.stringify(facts.eventCountsAfterPausedInterval);
    facts.assertions.noExternalAdvanceDispatchedWhilePaused =
      facts.advanceDispatchCountAfterPausedInterval === facts.advanceDispatchCountAtPause;
    facts.assertions.breakpointResolutionConfirmed =
      facts.bundle.sha256 === facts.bundle.expectedSha256 &&
      facts.breakpoints.find((b) => b.label.startsWith('P4'))?.actualLocations?.length > 0;
    facts.status = Object.values(facts.assertions).every(Boolean)
      ? 'P4_PREFLIGHT_PASS'
      : 'P4_PREFLIGHT_ASSERTION_FAILED';
    save();
    log(`P4 breakpoint observed; assertions=${JSON.stringify(facts.assertions)}`);
    await inspector.send('Debugger.resume');
    paused = false;
    const settled = await Promise.race([
      activeAdvance.then(
        (v) => ({ done: true, value: v }),
        (e) => ({ done: true, error: String(e?.message ?? e) }),
      ),
      delay(15000).then(() => ({ done: false })),
    ]);
    facts.postResumeAdvance = settled;
    save();
  } else {
    const result = await driveToBreakpoint(
      page,
      inspector,
      facts.runId,
      connected.ids.p5entry.breakpointId,
    );
    paused = true;
    activeAdvance = result.action;
    await inspectAtPause(inspector, result.paused, 'P5-entry', facts.runId);
    facts.P5entry.entryHitCount = facts.hits.filter((hit) => hit.label === 'P5-entry').length;
    const entryLocation = connected.ids.p5entry.actualLocations[0];
    const entryBreakpointRecord = facts.breakpoints.find(
      (item) => item.label === 'P5 workspace.writeText method entry before file mutation',
    );
    const firstEntryPossibleLocation = entryBreakpointRecord?.possibleBreakpoints?.[0] ?? null;
    const postRange = { startLine: 9848, startColumn: 13589, endLine: 9848, endColumn: 13680 };
    const postScan = await inspector.send('Debugger.getPossibleBreakpoints', {
      start: {
        scriptId: connected.bundle.scriptId,
        lineNumber: postRange.startLine,
        columnNumber: postRange.startColumn,
      },
      end: {
        scriptId: connected.bundle.scriptId,
        lineNumber: postRange.endLine,
        columnNumber: postRange.endColumn,
      },
      restrictToFunction: false,
    });
    const returnLocation = postScan.locations?.find((location) => location.type === 'return');
    facts.P5postwritePossibleBreakpointScan = {
      range: postRange,
      rawResponse: postScan,
      returnLocation: returnLocation ?? null,
    };
    if (!returnLocation)
      throw new Error(
        'No V8 return-typed location exists in the builtin file.writeText execute function',
      );
    const postwriteBreakpoint = await connected.install(
      'P5 builtin file.writeText return before async execute resolves',
      returnLocation,
      null,
      postRange,
    );
    connected.ids.p5post = postwriteBreakpoint;
    breakpointIds.push(postwriteBreakpoint.breakpointId);
    const postLocation = postwriteBreakpoint.actualLocations[0];
    facts.P5resolvedLocations = {
      requestedEntry: connected.staticLocations.p5entry,
      entry: entryLocation,
      firstEntryPossibleLocation,
      postwrite: postLocation,
      distinct:
        entryLocation.lineNumber !== postLocation.lineNumber ||
        entryLocation.columnNumber !== postLocation.columnNumber,
    };
    facts.P5resolvedLocations.entryResolution = {
      matchesFirstPossibleV8Location:
        firstEntryPossibleLocation?.lineNumber === entryLocation.lineNumber &&
        firstEntryPossibleLocation?.columnNumber === entryLocation.columnNumber,
      deltaFromRequestedColumn:
        entryLocation.columnNumber - connected.staticLocations.p5entry.columnNumber,
      explanation:
        'V8 resolved the breakpoint request to the first executable location returned by getPossibleBreakpoints in the method-entry scan; the paused frame and unchanged seed hash establish the pre-mutation phase.',
    };
    facts.P5postwriteCandidate = {
      type: returnLocation.type,
      requested: returnLocation,
      actual: postLocation,
      sourceFragment: connected.bundle.source.slice(
        connected.staticLocations.p5post.index - 100,
        connected.staticLocations.p5post.index + 90,
      ),
    };
    facts.assertions = {
      entryBreakpointResolved:
        entryLocation.lineNumber === 9848 &&
        Math.abs(entryLocation.columnNumber - connected.staticLocations.p5entry.columnNumber) <=
          8 &&
        facts.P5resolvedLocations.entryResolution.matchesFirstPossibleV8Location,
      postwriteBreakpointResolved:
        postLocation.lineNumber === 9848 &&
        postLocation.columnNumber === returnLocation.columnNumber &&
        returnLocation.type === 'return',
      distinctActualLocations: facts.P5resolvedLocations.distinct,
      entryFrameIsWorkspaceWriteText:
        facts.hits.at(-1)?.callFrame?.frame?.functionName === 'writeText' &&
        facts.P5entry.relativePath === workspaceFixture.targetPath &&
        facts.P5entry.workspaceRoot?.toLowerCase() === workspace.toLowerCase(),
      entryFileStillAtSeedHash:
        facts.P5entry.fileBefore?.sha256 ===
        workspaceFixture.metadata.find((item) => item.name === workspaceFixture.targetPath)?.sha256,
      entryOperationPrepared:
        facts.P5entry.database.operationsTableExists &&
        facts.P5entry.database.operationRows.length > 0 &&
        facts.P5entry.database.operationRows.every((row) => row.state === 'PREPARED'),
      entryMutationJournalPrepared:
        facts.P5entry.database.journalTableExists &&
        facts.P5entry.database.journalRows.length > 0 &&
        facts.P5entry.database.journalRows.every((row) => row.state === 'PREPARED'),
      noSuccessfulFileWriteToolResultAtEntry:
        facts.P5entry.database.missionEventsTableExists &&
        facts.P5entry.database.fileWriteToolResultCount === 0,
    };
    save();
    if (
      !facts.assertions.entryBreakpointResolved ||
      !facts.assertions.postwriteBreakpointResolved ||
      !facts.assertions.distinctActualLocations
    )
      throw new Error(
        `P5 V8 breakpoint mapping did not resolve to two distinct validated locations: ${JSON.stringify(facts.assertions)}`,
      );
    const postwriteWaiter = breakpointWaiter(inspector, connected.ids.p5post.breakpointId, 30000);
    const resumeRequest = inspector.send('Debugger.resume').then(
      (value) => ({ state: 'resolved', value }),
      (error) => ({ state: 'error', error: String(error?.message ?? error) }),
    );
    paused = false;
    const postOutcome = await Promise.race([
      postwriteWaiter.promise.then(
        (value) => ({ kind: 'paused', value }),
        (error) => ({ kind: 'waitError', error: String(error.message) }),
      ),
      activeAdvance.then(
        (value) => ({ kind: 'advanceReturned', value }),
        (error) => ({ kind: 'advanceError', error: String(error?.message ?? error) }),
      ),
    ]);
    if (postOutcome.kind !== 'paused') {
      postwriteWaiter.cancel();
      facts.P5postwriteOutcome = {
        state: 'NOT_RUN',
        kind: postOutcome.kind,
        detail: postOutcome.error ?? null,
        fileAfter: fileFact(facts.P5entry.filePath),
      };
      facts.status = 'P5_POSTWRITE_NOT_RUN';
      save();
      throw new Error(
        `P5 return-typed postwrite breakpoint was not observed: ${JSON.stringify(facts.P5postwriteOutcome)}`,
      );
    }
    const postwrite = postOutcome.value;
    paused = true;
    facts.P5postwriteResumeRequest = await Promise.race([
      resumeRequest,
      delay(1000).then(() => ({ state: 'still-pending-after-pause' })),
    ]);
    await inspectAtPause(inspector, postwrite, 'P5-postwrite', facts.runId);
    facts.assertions.breakpointResolutionConfirmed =
      facts.bundle.sha256 === facts.bundle.expectedSha256 &&
      facts.P5resolvedLocations?.distinct === true &&
      [
        'P5 workspace.writeText method entry before file mutation',
        'P5 builtin file.writeText return before async execute resolves',
      ].every(
        (label) => facts.breakpoints.find((b) => b.label === label)?.actualLocations?.length > 0,
      );
    facts.status = Object.values(facts.assertions).every(Boolean)
      ? 'P5_PREFLIGHT_PASS'
      : 'P5_PREFLIGHT_ASSERTION_FAILED';
    save();
    log(`P5 postwrite breakpoint observed; assertions=${JSON.stringify(facts.assertions)}`);
    for (const breakpointId of breakpointIds)
      await inspector.send('Debugger.removeBreakpoint', { breakpointId });
    facts.P5breakpointsRemovedBeforeResume = true;
    save();
    await inspector.send('Debugger.resume');
    paused = false;
    const settled = await Promise.race([
      activeAdvance.then(
        (v) => ({ done: true, value: v }),
        (e) => ({ done: true, error: String(e?.message ?? e) }),
      ),
      delay(15000).then(() => ({ done: false })),
    ]);
    facts.postResumeAdvance = settled;
    save();
  }
} catch (error) {
  if (facts.status !== 'P5_POSTWRITE_NOT_RUN') facts.status = 'BLOCKED_OR_ERROR';
  facts.error = {
    name: error?.name ?? 'Error',
    message: String(error?.message ?? error),
    stack: String(error?.stack ?? '').slice(0, 5000),
  };
  save();
  log(`controller stopped: ${facts.error.message}`);
} finally {
  if (inspector) {
    for (const breakpointId of breakpointIds) {
      try {
        await inspector.send('Debugger.removeBreakpoint', { breakpointId });
      } catch (error) {
        facts.breakpointCleanupErrors = [
          ...(facts.breakpointCleanupErrors ?? []),
          String(error?.message ?? error),
        ];
      }
    }
    save();
  }
  if (paused && inspector) {
    try {
      await inspector.send('Debugger.resume');
      paused = false;
      facts.resumeBeforeClose = true;
      save();
    } catch (error) {
      facts.resumeBeforeClose = { error: String(error?.message ?? error) };
      save();
    }
  }
  if (inspector) {
    try {
      await inspector.close();
      facts.inspectorSocketClosedBeforeAppQuit = true;
    } catch (error) {
      facts.inspectorSocketCloseError = String(error?.message ?? error);
    }
    save();
  }
  if (page) {
    try {
      await Promise.race([
        page
          .evaluate(() => window.cultivation.desktop.close())
          .then(
            () => {
              facts.normalIpcCloseRequested = true;
            },
            (error) => {
              facts.normalIpcCloseError = String(error?.message ?? error);
            },
          ),
        delay(3000).then(() => {
          facts.normalIpcCloseTimedOut = true;
        }),
      ]);
      save();
    } catch (error) {
      facts.normalIpcCloseError = String(error?.message ?? error);
      save();
    }
  }
  if (app) {
    try {
      const child = app.process();
      facts.normalClose = {
        requested: true,
        pid: child.pid,
        exitCodeBefore: child.exitCode,
        signalCodeBefore: child.signalCode,
      };
      await app.close();
      facts.normalClose.exitCodeAfter = child.exitCode;
      facts.normalClose.signalCodeAfter = child.signalCode;
    } catch (error) {
      facts.normalClose = {
        requested: true,
        error: String(error?.message ?? error),
        forcedTermination: false,
      };
    }
  }
  facts.finishedAt = new Date().toISOString();
  save();
}
log(`final status=${facts.status}; evidence=${reportPath}`);
