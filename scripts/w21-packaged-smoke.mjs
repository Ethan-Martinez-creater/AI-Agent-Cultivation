import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const nonce = randomUUID();
const profile = join(root, '.test-data', `w21-packaged-${nonce}`);
const workspace = join(profile, 'workspace');
const evidence = join(profile, 'evidence');
const databasePath = join(profile, 'data', 'cultivation.sqlite');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const mcpFixturePath = join(root, 'scripts', 'fixtures', 'news-mcp-fixture.mjs');
const mediaRoot = join(root, 'scripts', 'fixtures', 'news-media');
const acceptanceFactoryPath = join(
  root,
  'packages',
  'application',
  'src',
  'builtin',
  'ai-news-video',
  'test-data.ts',
);
const factoryBundlePath = join(evidence, 'w21-acceptance-factory.mjs');

// Exact AP-007 inputs exported by AI_NEWS_VIDEO_ACCEPTANCE_INPUTS in v1.ts.
const cases = [
  {
    id: 'short',
    inputs: {
      topicScope: '人工智能芯片行业动态',
      timeRange: { from: '2026-09-25T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
      language: 'zh-CN',
      targetPlatform: 'YOUTUBE_SHORTS',
      targetDurationSeconds: 60,
      targetStoryCount: { min: 1, max: 1 },
      narrationMode: 'AUTO',
    },
  },
  {
    id: 'weekly',
    inputs: {
      topicScope: '人工智能产品与研究周报',
      timeRange: { from: '2026-09-25T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
      language: 'zh-CN',
      targetPlatform: 'YOUTUBE_LONG',
      targetDurationSeconds: 300,
      targetStoryCount: { min: 3, max: 5 },
      narrationMode: 'MODEL_OR_TOOL',
    },
  },
  {
    id: 'productExplainer',
    inputs: {
      topicScope: '某一产品在明确时间范围内发布的新功能说明',
      timeRange: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
      language: 'zh-CN',
      targetPlatform: 'GENERIC',
      targetDurationSeconds: 180,
      targetStoryCount: { min: 1, max: 1 },
      narrationMode: 'HUMAN',
    },
  },
];

mkdirSync(workspace, { recursive: true });
mkdirSync(evidence, { recursive: true });
assert.ok(realpathSync(mediaRoot));
assert.ok(realpathSync(mcpFixturePath));

await build({
  entryPoints: [acceptanceFactoryPath],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: factoryBundlePath,
  tsconfig: join(root, 'tsconfig.base.json'),
  logLevel: 'silent',
});
const factory = await import(`${pathToFileURL(factoryBundlePath).href}?v=${nonce}`);
assert.equal(typeof factory.createAiNewsAcceptanceOutput, 'function');

function read(fn) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function runEventSnapshot(runId) {
  return read((db) => {
    const events = db
      .prepare(
        `SELECT event_type,COUNT(*) AS count
         FROM mission_events
         WHERE mission_id IN (
           SELECT mission_id FROM workflow_step_runs
           WHERE workflow_run_id=? AND mission_id IS NOT NULL
         )
         GROUP BY event_type ORDER BY event_type`,
      )
      .all(runId);
    return Object.fromEntries(events.map((item) => [item.event_type, item.count]));
  });
}

function missionEventSnapshot(missionId) {
  return read((db) =>
    Object.fromEntries(
      db
        .prepare(
          'SELECT event_type,COUNT(*) AS count FROM mission_events WHERE mission_id=? GROUP BY event_type ORDER BY event_type',
        )
        .all(missionId)
        .map((item) => [item.event_type, item.count]),
    ),
  );
}

function equalSnapshots(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

async function poll(readFn, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read(readFn);
    if (value) return value;
    await delay(80);
  }
  throw new Error(`W2.1 packaged smoke timed out waiting for ${label}`);
}

async function launch(extraFlags = []) {
  const app = await electron.launch({
    executablePath,
    args: [
      '--gate1-fake-model',
      '--r3-fake-decision',
      '--r4-fake-routing',
      '--w21-fake-news',
      ...extraFlags,
    ],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  app.process().stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (text.includes('W21_OFFLINE_FIXTURE_FAILURE')) console.error(text.trim());
  });
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}

async function kill(app) {
  const child = app.process();
  const closed = new Promise((resolveClose) => child.once('close', resolveClose));
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await closed;
  const deadline = Date.now() + 5_000;
  for (;;) {
    let db;
    try {
      db = new Database(databasePath);
      db.exec('BEGIN IMMEDIATE; COMMIT;');
      break;
    } catch (error) {
      if (error.code !== 'SQLITE_IOERR_TRUNCATE' || Date.now() >= deadline) throw error;
      await delay(100);
    } finally {
      db?.close();
    }
  }
}

async function refreshMcpServer(page, serverId) {
  const result = await page.evaluate(
    (id) => window.cultivation.tools.refreshMcpServer(id),
    serverId,
  );
  assert.equal(result.status, 'READY', result.message);
  assert.ok(result.tools.some((tool) => tool.id.endsWith(':research_news')));
  assert.ok(result.tools.some((tool) => tool.id.endsWith(':assemble_video')));
  return result;
}

async function detail(page, runId) {
  return page.evaluate((id) => window.cultivation.workflows.detail(id), runId);
}

function activeStep(workflow) {
  return [...workflow.steps]
    .reverse()
    .find((step) => ['READY', 'RUNNING', 'WAITING'].includes(step.state));
}

async function pendingApprovalForWorkflow(page, workflow) {
  for (const step of [...workflow.steps].reverse()) {
    if (!step.missionId) continue;
    const mission = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      step.missionId,
    );
    const approval = mission.approvals?.find((item) => item.state === 'PENDING');
    if (approval) return { step, mission, approval };
  }
  return null;
}

function priorArtifacts(workflow) {
  const byId = new Map(workflow.artifacts.map((artifact) => [artifact.id, artifact]));
  const outputs = new Map();
  for (const binding of workflow.bindings
    .filter((item) => item.role === 'OUTPUT')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const artifact = byId.get(binding.artifactId);
    if (!artifact) continue;
    outputs.set(binding.key, {
      key: binding.key,
      artifactId: artifact.id,
      kind: artifact.kind,
      content: artifact.content,
      contentHash: artifact.contentHash,
      metadata: artifact.metadata,
    });
  }
  return [...outputs.values()];
}

function acceptanceForHumanStep(workflow, step) {
  const outputPathPrefix = `workflows/${workflow.run.id}/${step.id}/`;
  return factory.createAiNewsAcceptanceOutput({
    stepId: step.stepId,
    workflowInputs: workflow.run.inputSnapshot,
    priorArtifacts: priorArtifacts(workflow),
    inputArtifactIds: workflow.bindings
      .filter((binding) => binding.stepRunId === step.id && binding.role === 'INPUT')
      .map((binding) => binding.artifactId),
    ...(step.stepId === 'N10' ? { outputPathPrefix } : {}),
  });
}

function safeWorkspacePath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized))
    throw new Error('Human Bridge fixture target must be workspace-relative');
  const target = resolve(workspace, ...normalized.split('/'));
  const path = relative(workspace, target);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error('Human Bridge fixture target escaped its workspace');
  return { target, normalized };
}

function chooseExtension(target, preferred) {
  const allowed = target.allowedExtensions ?? [];
  const normalized = preferred.toLowerCase();
  if (allowed.includes(normalized)) return normalized;
  const ext = allowed.find((item) => ['.json', '.md', '.txt', '.png', '.wav'].includes(item));
  if (!ext) throw new Error(`No supported test extension for Human Bridge target ${target.id}`);
  return ext;
}

function targetOutputValue(target, outputs) {
  if (Object.hasOwn(outputs, target.id)) return outputs[target.id];
  const key = Object.keys(outputs).find((outputKey) => target.id.startsWith(`${outputKey}.`));
  return key ? outputs[key] : undefined;
}

function humanBridgeDeliverables(workflow, step, requestDetail) {
  const acceptance = acceptanceForHumanStep(workflow, step);
  const prefix = `workflows/${workflow.run.id}/${step.id}/`;
  const request = requestDetail.request;
  const targets = request.targetArtifactsJson.items;
  const allowedRoots = request.targetWorkspacePathsJson.items;
  assert.ok(
    Array.isArray(targets) && targets.length > 0,
    'Human Bridge request needs typed targets',
  );
  assert.ok(
    Array.isArray(allowedRoots) && allowedRoots.length > 0,
    'Human Bridge request needs a workspace target',
  );

  const files = [...acceptance.files];
  const usedFiles = new Set();
  const submissions = [];
  for (const [targetIndex, target] of targets.entries()) {
    const targetKey = String(target.id);
    let fileIndex = files.findIndex(
      (file, index) =>
        !usedFiles.has(index) &&
        (targetKey === file.outputKey || targetKey.startsWith(`${file.outputKey}.`)),
    );
    const numericSuffix = /\.(\d+)$/.exec(targetKey);
    if (fileIndex < 0 && numericSuffix && targetKey.startsWith('news.assets.')) {
      const candidate = Number(numericSuffix[1]);
      if (candidate < files.length && !usedFiles.has(candidate)) fileIndex = candidate;
    }

    let bytes;
    let preferredExtension;
    let requestedRelativePath;
    if (fileIndex >= 0) {
      const file = files[fileIndex];
      usedFiles.add(fileIndex);
      const scoped = file.relativePath.startsWith(prefix)
        ? file.relativePath
        : `${prefix}${file.relativePath}`;
      preferredExtension = extname(scoped);
      requestedRelativePath = scoped;
      bytes = Buffer.from(file.bytes);
    } else {
      const value = targetOutputValue(target, acceptance.outputs);
      if (value === undefined) {
        if (target.required === false) continue;
        throw new Error(
          `No deterministic output is available for Human Bridge target ${targetKey}`,
        );
      }
      const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      preferredExtension = extname(String(target.name ?? '')) || '.json';
      const directory = allowedRoots[0].replaceAll('\\', '/').replace(/\/$/, '');
      const fallbackName = `${targetKey.split('.').at(-1) ?? `target-${targetIndex}`}${chooseExtension(
        target,
        preferredExtension,
      )}`;
      requestedRelativePath = `${directory}/${fallbackName}`;
      bytes = Buffer.from(serialized, 'utf8');
    }

    const extension = chooseExtension(target, preferredExtension);
    const currentExtension = extname(requestedRelativePath);
    if (currentExtension.toLowerCase() !== extension) {
      requestedRelativePath = `${requestedRelativePath.slice(0, -currentExtension.length)}${extension}`;
    }
    const { target: absolutePath, normalized } = safeWorkspacePath(requestedRelativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, bytes, { flag: 'wx' });
    submissions.push({ targetArtifactId: target.id, relativePath: normalized });
  }
  for (const [index, target] of targets.entries()) {
    if (
      target.required !== false &&
      !submissions.some((item) => item.targetArtifactId === target.id)
    )
      throw new Error(
        `Required Human Bridge target ${target.id} was not materialized (index ${index})`,
      );
  }
  return { acceptance, submissions };
}

async function acceptHumanBridge(live, workflow, step, requestId) {
  const requestDetail = await live.page.evaluate(
    (id) => window.cultivation.r2.getRequest(id),
    requestId,
  );
  assert.ok(requestDetail?.request);
  const { acceptance, submissions } = humanBridgeDeliverables(workflow, step, requestDetail);
  await live.page.evaluate((id) => window.cultivation.r2.markInProgress(id), requestId);
  const submitted = await live.page.evaluate(
    ({ requestId: id, artifacts }) =>
      window.cultivation.r2.submitArtifacts({ requestId: id, artifacts }),
    { requestId, artifacts: submissions },
  );
  assert.ok(['SUBMITTED', 'IN_PROGRESS'].includes(submitted.state));
  await live.page.evaluate(
    (id) =>
      window.cultivation.r2.accept({
        requestId: id,
        publicResult:
          'Deterministic AP-007 fixture files submitted through typed Human Bridge IPC.',
      }),
    requestId,
  );
  return {
    requestId,
    stepId: step.stepId,
    targets: submissions,
    fileHashes: submissions.map((item) => ({
      relativePath: item.relativePath,
      sha256: createHash('sha256')
        .update(readFileSync(join(workspace, item.relativePath)))
        .digest('hex'),
    })),
    outputKeys: Object.keys(acceptance.outputs),
  };
}

async function waitForAppliedN12(runId) {
  return poll(
    (db) =>
      db
        .prepare(
          `SELECT receipt.*,step.step_id FROM workflow_step_operation_receipts AS receipt
           JOIN workflow_step_runs AS step ON step.id=receipt.step_run_id
           WHERE receipt.workflow_run_id=? AND step.step_id='N12' AND receipt.state='APPLIED'
           ORDER BY receipt.attempt DESC,receipt.updated_at DESC LIMIT 1`,
        )
        .get(runId),
    'N12 APPLIED operation receipt',
  );
}

function n12MissionId(runId) {
  return read(
    (db) =>
      db
        .prepare(
          `SELECT mission_id FROM workflow_step_runs
         WHERE workflow_run_id=? AND step_id='N12' AND mission_id IS NOT NULL
         ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId)?.mission_id,
  );
}

async function driveRun(liveRef, serverId, runId, options = {}) {
  const fact = options.fact ?? {
    runId,
    approvals: [],
    humanBridge: [],
    visitedStepIds: [],
    restarts: [],
    mcpToolIds: [],
  };
  let hookStarted = false;
  let n12Approved = false;
  let n12Recovered = false;
  let approvalJustResolved = false;
  const maxIterations = 180;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let workflow = await detail(liveRef.current.page, runId);
    fact.visitedStepIds = [...new Set(workflow.steps.map((step) => step.stepId))];
    if (workflow.run.state === 'COMPLETED') return { workflow, fact };
    assert.notEqual(workflow.run.state, 'FAILED', `Workflow failed: ${workflow.run.id}`);
    assert.notEqual(workflow.run.state, 'CANCELLED', `Workflow cancelled: ${workflow.run.id}`);
    const current = activeStep(workflow);

    if (workflow.run.waitReason === 'USER_CONFIRMATION') {
      assert.equal(
        current?.stepId,
        'N14',
        `Unexpected validation wait: ${current?.stepId} ${current?.errorCode}`,
      );
      return { workflow, fact };
    }
    if (workflow.run.waitReason === 'EXTERNAL_WORK') {
      if (
        options.restartAtN10 &&
        current?.stepId === 'N10' &&
        !fact.restarts.some((item) => item.point === 'N10_EXTERNAL_WAIT')
      ) {
        const before = runEventSnapshot(runId);
        fact.restarts.push({ point: 'N10_EXTERNAL_WAIT', eventCountsBefore: before });
        await kill(liveRef.current.app);
        liveRef.current = await launch();
        await refreshMcpServer(liveRef.current.page, serverId);
        workflow = await detail(liveRef.current.page, runId);
        assert.equal(workflow.run.state, 'WAITING');
        assert.equal(workflow.run.waitReason, 'EXTERNAL_WORK');
        equalSnapshots(
          runEventSnapshot(runId),
          before,
          'Human Bridge restart must not replay model or tool events',
        );
        fact.restarts.at(-1).eventCountsAfter = runEventSnapshot(runId);
        continue;
      }
      const request = await liveRef.current.page.evaluate(async (missionId) => {
        const requests = await window.cultivation.r2.listRequests();
        return (
          requests.find(
            (item) =>
              item.missionId === missionId &&
              ['PENDING', 'IN_PROGRESS', 'SUBMITTED'].includes(item.state),
          ) ?? null
        );
      }, current?.missionId);
      if (!request) {
        await delay(120);
        await liveRef.current.page.evaluate(
          (id) => window.cultivation.workflows.advance(id),
          runId,
        );
        continue;
      }
      assert.ok(request, `Workflow is waiting for Human Bridge at ${current?.stepId}`);
      return { workflow, fact, external: { step: current, request } };
    }

    const pending = await pendingApprovalForWorkflow(liveRef.current.page, workflow);
    if (pending) {
      assert.equal(pending.approval.capability, 'MCP_TOOL_EXECUTE');
      assert.equal(pending.approval.actionPayload.source, 'MCP');
      assert.ok(String(pending.approval.actionPayload.toolId).includes(serverId));
      fact.approvals.push({
        approvalId: pending.approval.id,
        capability: pending.approval.capability,
        toolId: pending.approval.actionPayload.toolId,
        stepId: pending.step.stepId,
      });
      if (pending.step.stepId === 'N12') {
        n12Approved = true;
        if (options.crashAfterN12Applied && !hookStarted) {
          await liveRef.current.app.close();
          liveRef.current = await launch(['--w2-stop-applied']);
          await refreshMcpServer(liveRef.current.page, serverId);
          hookStarted = true;
          workflow = await detail(liveRef.current.page, runId);
        }
      }
      await liveRef.current.page.evaluate(
        (approvalId) =>
          window.cultivation.missions.resolveApproval({
            approvalId,
            decision: 'ALLOW_MISSION',
          }),
        pending.approval.id,
      );
      approvalJustResolved = true;
      continue;
    }

    if (
      options.crashAfterN12Applied &&
      hookStarted &&
      n12Approved &&
      !n12Recovered &&
      current?.stepId === 'N12'
    ) {
      // The app's --w2-stop-applied hook parks after the durable side effect receipt.
      void liveRef.current.page.evaluate((id) => {
        void window.cultivation.workflows.advance(id);
      }, runId);
      const applied = await waitForAppliedN12(runId);
      const missionId = n12MissionId(runId);
      assert.ok(missionId, 'N12 must remain bound to the same Mission during recovery');
      const before = missionEventSnapshot(missionId);
      fact.restarts.push({
        point: 'N12_APPLIED',
        receiptId: applied.id,
        eventCountsBefore: before,
      });
      await kill(liveRef.current.app);
      liveRef.current = await launch();
      await refreshMcpServer(liveRef.current.page, serverId);
      workflow = await detail(liveRef.current.page, runId);
      assert.equal(workflow.run.id, runId);
      equalSnapshots(
        missionEventSnapshot(missionId),
        before,
        'N12 restart must not replay model or tool events',
      );
      assert.ok(
        ['APPLIED', 'VERIFIED'].includes(
          read(
            (db) =>
              db
                .prepare('SELECT state FROM workflow_step_operation_receipts WHERE id=?')
                .get(applied.id).state,
          ),
        ),
      );
      const recovered = await liveRef.current.page.evaluate(
        (id) => window.cultivation.workflows.advance(id),
        runId,
      );
      const verified = read(
        (db) =>
          db
            .prepare('SELECT state FROM workflow_step_operation_receipts WHERE id=?')
            .get(applied.id)?.state,
      );
      assert.equal(verified, 'VERIFIED');
      equalSnapshots(
        missionEventSnapshot(missionId),
        before,
        'N12 APPLIED recovery must verify without model/tool replay',
      );
      fact.restarts.at(-1).eventCountsAfter = missionEventSnapshot(missionId);
      fact.restarts.at(-1).recoveredRunState = recovered.run.state;
      n12Recovered = true;
      continue;
    }

    if (workflow.run.state === 'WAITING' && workflow.run.waitReason === 'MISSION') {
      await delay(120);
      continue;
    }
    if (
      workflow.run.state === 'WAITING' &&
      workflow.run.waitReason === 'APPROVAL' &&
      !approvalJustResolved
    ) {
      throw new Error(
        `Workflow waits for approval but no pending approval is visible at ${current?.stepId}`,
      );
    }

    approvalJustResolved = false;
    const advanced = await liveRef.current.page.evaluate(
      (id) => window.cultivation.workflows.advance(id),
      runId,
    );
    assert.ok(
      advanced.run.state !== 'FAILED',
      `Workflow failed during ${current?.stepId ?? 'advance'}`,
    );
    const next = activeStep(advanced);
    if (next?.stepId === 'N10' && advanced.run.waitReason === 'EXTERNAL_WORK') {
      fact.waitingAtN10 = true;
    }
    if (next?.stepId === 'N12') fact.mcpToolIds.push('assemble_video');
    if (next?.stepId === 'N01' || next?.stepId === 'N03') fact.mcpToolIds.push('research_news');
    await delay(25);
  }
  throw new Error(`Workflow ${runId} exceeded ${maxIterations} state transitions`);
}

async function completeExternalWait(liveRef, result) {
  const { workflow, fact, external } = result;
  assert.ok(external?.request?.id);
  const step = external.step;
  const requestId = external.request.id;
  const accepted = await acceptHumanBridge(liveRef.current, workflow, step, requestId);
  fact.humanBridge.push(accepted);
  return { workflow, fact };
}

let live = { current: await launch() };
const facts = {
  profile,
  workspace,
  acceptanceCases: [],
};
try {
  await live.current.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspace);
  await live.current.page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  facts.workspace = await live.current.page.evaluate(() => window.cultivation.tools.getWorkspace());
  assert.equal(facts.workspace.rootPath, workspace);

  const setup = await live.current.page.evaluate(async (requiredCapabilities) => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'W2.1 deterministic fixture provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'W2.1 deterministic fixture runtime',
      providerId: provider.id,
      credentialId: null,
      modelId: 'w21-fixture-model',
    });
    const teammate = await api.teammates.create({
      name: 'W2.1 deterministic workflow executor',
      avatar: null,
      title: null,
      description: 'Test-only offline AP-007 workflow fixture',
      identityPrompt: 'Use the bounded deterministic fixture output for this test-only workflow.',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    for (const dimension of requiredCapabilities) {
      await api.capability.saveBenchmark({
        runtimeProfileId: runtime.id,
        modelAlias: 'w21-fixture-model',
        dimension,
        supported: true,
        normalizedScore: 95,
        rawScore: null,
        source: 'W2.1 offline deterministic acceptance fixture',
        benchmark: 'AP-007 required capability fixture',
        benchmarkVersion: '1',
        snapshotDate: '2026-10-01T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
    }
    const bridge = await api.r2.bridgeProfile();
    for (const dimension of requiredCapabilities) {
      await api.r2.setCapability({ dimension, enabled: true });
    }
    return {
      provider,
      runtime,
      teammate,
      humanBridgeTeammateId: bridge.teammate.id,
      humanBridgeDimensions: requiredCapabilities,
    };
  }, []);

  const version = await live.current.page.evaluate(async () => {
    const versions = await window.cultivation.workflows.versions();
    return versions.find(
      (item) => item.definition.id === 'official.ai-news-video' && item.version === 1,
    );
  });
  assert.ok(
    version,
    'The production official AI News Video frozen version must be installed by the trusted registry',
  );
  const requiredCapabilities = [
    ...new Set(version.steps.flatMap((step) => step.routing.requiredCapabilities ?? [])),
  ];
  assert.ok(requiredCapabilities.length > 0);
  // Save all benchmark evidence after reading the trusted registered definition.
  facts.setup = await live.current.page.evaluate(
    async ({ dimensions }) => {
      const api = window.cultivation;
      const teammate = (await api.teammates.list()).find(
        (item) => item.name === 'W2.1 deterministic workflow executor',
      );
      if (!teammate) throw new Error('Fixture teammate is missing');
      const runtimeId = teammate.currentRuntimeProfileId;
      for (const dimension of dimensions) {
        await api.capability.saveBenchmark({
          runtimeProfileId: runtimeId,
          modelAlias: 'w21-fixture-model',
          dimension,
          supported: true,
          normalizedScore: 95,
          rawScore: null,
          source: 'W2.1 offline deterministic acceptance fixture',
          benchmark: 'AP-007 required capability fixture',
          benchmarkVersion: '1',
          snapshotDate: '2026-10-01T00:00:00.000Z',
          sourceUrl: null,
          provenanceType: 'USER_ESTIMATE',
        });
      }
      const bridge = await api.r2.bridgeProfile();
      for (const dimension of dimensions) await api.r2.setCapability({ dimension, enabled: true });
      return { teammate, humanBridgeTeammateId: bridge.teammate.id, capabilities: dimensions };
    },
    { dimensions: requiredCapabilities },
  );
  facts.requiredCapabilities = requiredCapabilities;
  facts.setup = { ...facts.setup, provider: setup.provider, runtime: setup.runtime };

  const server = await live.current.page.evaluate(
    ({ command, scriptPath, fixtureRoot, cwd }) =>
      window.cultivation.tools.saveMcpServer({
        name: 'W2.1 deterministic stdio news fixture',
        command,
        args: [scriptPath, '--fixture-root', fixtureRoot],
        envWhitelist: [],
        cwd,
        enabled: true,
      }),
    {
      command: process.execPath,
      scriptPath: mcpFixturePath,
      fixtureRoot: mediaRoot,
      cwd: workspace,
    },
  );
  assert.deepEqual(server.envWhitelist, []);
  facts.mcpServer = {
    id: server.id,
    name: server.name,
    command: server.command,
    args: server.args,
    envWhitelist: server.envWhitelist,
    cwd: server.cwd,
  };
  const discovered = await refreshMcpServer(live.current.page, server.id);
  facts.mcpTools = discovered.tools.map((tool) => ({ id: tool.id, name: tool.name }));

  for (const testCase of cases) {
    const created = await live.current.page.evaluate(
      ({ definitionId, inputs }) =>
        window.cultivation.workflows.create({ definitionId, version: 1, inputs }),
      { definitionId: 'official.ai-news-video', inputs: testCase.inputs },
    );
    assert.equal(created.run.state, 'READY');
    const runId = created.run.id;
    const driveOptions = {
      restartAtN10: testCase.id === 'short',
      crashAfterN12Applied: testCase.id === 'weekly',
    };
    let result = await driveRun(live, server.id, runId, driveOptions);
    while (result.external) {
      if (testCase.id === 'short' && result.external.step.stepId === 'N10') {
        await navigateUi(live.current.page, '本尊待办 Human Bridge');
        await live.current.page.screenshot({
          path: join(evidence, '01-w21-human-bridge-waiting.png'),
          fullPage: true,
        });
      }
      await completeExternalWait(live, result);
      result = await driveRun(live, server.id, runId, { ...driveOptions, fact: result.fact });
    }
    let workflow = result.workflow;
    assert.equal(workflow.run.waitReason, 'USER_CONFIRMATION');
    assert.equal(workflow.run.state, 'WAITING');
    const confirmation = await live.current.page.evaluate(
      (id) => window.cultivation.workflows.confirm(id),
      runId,
    );
    assert.equal(confirmation.run.state, 'COMPLETED');
    workflow = confirmation;
    assert.deepEqual(
      [...new Set(workflow.steps.map((step) => step.stepId))].sort(),
      Array.from({ length: 14 }, (_, index) => `N${String(index + 1).padStart(2, '0')}`).sort(),
      'The packaged run must persist all 14 official step states',
    );
    assert.equal(workflow.run.definitionId, 'official.ai-news-video');
    assert.ok(
      workflow.artifacts.some(
        (artifact) => artifact.kind === 'FILE' && artifact.metadata.mediaType === 'video/mp4',
      ),
    );
    assert.ok(workflow.artifacts.some((artifact) => artifact.kind === 'DIRECTORY'));
    assert.ok(workflow.validations.every((validation) => validation.valid));
    const outputs = new Map(
      workflow.bindings
        .filter((binding) => binding.role === 'OUTPUT')
        .map((binding) => [
          binding.key,
          workflow.artifacts.find((artifact) => artifact.id === binding.artifactId),
        ]),
    );
    const jsonOutput = (key) => JSON.parse(outputs.get(key).content);
    const candidates = jsonOutput('news.candidates').candidates;
    const clusters = jsonOutput('news.story_clusters').clusters;
    assert.ok(
      candidates.length > clusters.length,
      'Duplicate discovery sources must form one story',
    );
    const sources = new Set(
      jsonOutput('news.source_packets').sources.map((source) => source.sourceId),
    );
    const claims = new Map(
      jsonOutput('news.verified_claims').claims.map((claim) => [claim.claimId, claim]),
    );
    for (const segment of jsonOutput('news.script_claim_map').segments) {
      for (const id of segment.claimIds) {
        const claim = claims.get(id);
        assert.ok(claim && claim.status !== 'UNVERIFIED' && claim.scriptEligible === true);
        assert.ok(claim.sourceIds.length && claim.sourceIds.every((id) => sources.has(id)));
      }
    }
    const finalVideo = outputs.get('news.video.draft');
    const deliveredBytes = readFileSync(join(workspace, finalVideo.metadata.path));
    assert.equal(
      createHash('sha256').update(deliveredBytes).digest('hex'),
      finalVideo.metadata.contentHash,
    );
    if (testCase.id === 'weekly') {
      assert.equal(
        workflow.traversals.filter((item) => item.groupId === 'news.final_qa_revision').length,
        1,
      );
      assert.ok(workflow.steps.some((step) => step.stepId === 'N12' && step.attempt === 2));
    }
    facts.acceptanceCases.push({
      id: testCase.id,
      input: testCase.inputs,
      runId,
      state: workflow.run.state,
      waitReasonBeforeConfirmation: result.workflow.run.waitReason,
      steps: workflow.steps.map((step) => ({
        id: step.stepId,
        state: step.state,
        attempt: step.attempt,
      })),
      artifactKeys: workflow.bindings
        .filter((binding) => binding.role === 'OUTPUT')
        .map((binding) => binding.key),
      validationCount: workflow.validations.length,
      permissionApprovals: result.fact.approvals,
      humanBridge: result.fact.humanBridge,
      restarts: result.fact.restarts,
      eventCounts: runEventSnapshot(runId),
      confirmedByTypedIpc: true,
      integrity: {
        deduplicated: true,
        scriptClaimsTraceSources: true,
        unverifiedScriptClaims: 0,
        videoPath: finalVideo.metadata.path,
        videoHash: finalVideo.metadata.contentHash,
        videoBytes: deliveredBytes.length,
        revisionTraversals: workflow.traversals,
      },
    });
    if (testCase.id === 'productExplainer') {
      await navigateUi(live.current.page, '历练 Missions');
      const workflowLink = live.current.page.getByRole('link', { name: '工作流历练', exact: true });
      await workflowLink.click();
      const panel = live.current.page.locator('.workflow-workspace');
      await panel.waitFor();
      await panel.getByRole('heading', { name: 'AI 资讯视频', exact: true }).waitFor();
      await panel.getByText(/进度：7\s*\/\s*7\s*阶段\s*已完成/).waitFor();
      await live.current.page.screenshot({
        path: join(evidence, '02-w21-completed-workflow.png'),
        fullPage: true,
      });
    }
  }

  const published = await live.current.page.evaluate(async () => {
    const versions = await window.cultivation.workflows.versions();
    return versions
      .filter((item) => item.definition.category === 'SOCIAL_PUBLISHING')
      .map((item) => item.definition.id);
  });
  assert.deepEqual(
    published,
    [],
    'The smoke must not create or invoke a social-publishing workflow',
  );
  facts.socialPublishing = { definitions: published, publishActions: 0 };
  facts.persistence = read((db) => ({
    migration: db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    workflowRuns: db
      .prepare('SELECT id,state,definition_id FROM workflow_runs ORDER BY created_at')
      .all(),
    operationReceipts: db
      .prepare(
        'SELECT workflow_run_id,step_run_id,operation_key,state FROM workflow_step_operation_receipts ORDER BY created_at',
      )
      .all(),
    researchEvidenceEvents: db
      .prepare(
        "SELECT event_type,COUNT(*) AS count FROM mission_events WHERE event_type LIKE 'workflow.%' GROUP BY event_type",
      )
      .all(),
  }));
  writeFileSync(join(evidence, 'w21-facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(
    `W21_PACKAGED_SMOKE_OK cases=${facts.acceptanceCases.length} steps=14 permission=normal-mcp-approval humanBridge=typed-ipc restarts=N10-wait+N12-applied zeroReplay=true socialPublish=0 evidence=${evidence}`,
  );
} finally {
  await live.current.app.close();
}
