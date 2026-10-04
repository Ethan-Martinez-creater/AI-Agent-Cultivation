import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const profile = join(root, '.test-data', `w23-packaged-${randomUUID()}`);
const workspace = join(profile, 'workspace');
const evidence = join(profile, 'evidence');
const datasetPath = 'datasets/research-fixture.csv';
const databasePath = join(profile, 'data', 'cultivation.sqlite');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const mcpFixturePath = join(root, 'scripts', 'fixtures', 'research-mcp-fixture.mjs');
const requiredDimensions = ['GENERAL_REASONING', 'LONG_CONTEXT_REASONING', 'CODING', 'TOOL_USE'];
const cases = [
  {
    id: 'A-algorithm',
    question: '在固定本地工作负载上比较两种尾延迟调度策略的观测差异',
    field: '计算机系统',
    scope: '只分析本地确定性小型样本，不作普遍因果结论',
    mode: 'COMPUTATIONAL',
    expectedCycleTraversals: 0,
  },
  {
    id: 'B-dataset',
    question: '使用 Iris 样例数据检查两组数值描述统计差异',
    field: '数据分析',
    scope: '仅作离线描述性计算，不把样例结果外推为科学结论',
    mode: 'COMPUTATIONAL',
    expectedCycleTraversals: 1,
    dataset: { id: 'local-iris-fixture', kind: 'FILE', name: datasetPath },
  },
  {
    id: 'C-external-human-bridge',
    question: '记录一次用户控制的实验观察，并保留来源与方法限制',
    field: '人机协作实验方法',
    scope: '由用户完成外部观察并提交结构化记录，不声称真实领域验证',
    mode: 'HUMAN_OR_EXTERNAL',
    expectedCycleTraversals: 0,
    humanBridge: true,
  },
  {
    id: 'D-mixed-human-bridge',
    question: '在本地模拟实验之后补充一项由用户提交的外部观察记录',
    field: '人机协作实验方法',
    scope: '先执行有界本地计算，再由本尊提交补充观察，不声称真实领域验证',
    mode: 'MIXED',
    expectedCycleTraversals: 0,
    humanBridge: true,
  },
];

mkdirSync(workspace, { recursive: true });
mkdirSync(evidence, { recursive: true });
mkdirSync(join(workspace, 'datasets'), { recursive: true });
writeFileSync(
  join(workspace, datasetPath),
  'group,value\nbaseline,11\nbaseline,12\ncandidate,13\ncandidate,14\n',
  'utf8',
);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function read(fn) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function poll(readFn, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read(readFn);
    if (value) return value;
    await delay(80);
  }
  throw new Error(`W2.3 packaged smoke timed out waiting for ${label}`);
}
async function launch(extraFlags = []) {
  const app = await electron.launch({
    executablePath,
    args: [
      '--gate1-fake-model',
      '--r3-fake-decision',
      '--r4-fake-routing',
      '--w23-fake-research',
      ...extraFlags,
    ],
    env: {
      ...process.env,
      CULTIVATION_USER_DATA_DIR: profile,
      W23_WORKSPACE_ROOT: workspace,
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  app.process().stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (text.includes('W23_OFFLINE_FIXTURE_FAILURE')) console.error(text.trim());
  });
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}
async function kill(app) {
  const child = app.process();
  const exited = new Promise((resolve) => child.once('close', resolve));
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await exited;
}
const detail = (page, id) => page.evaluate((id) => window.cultivation.workflows.detail(id), id);
const active = (workflow) =>
  [...workflow.steps]
    .reverse()
    .find((step) => ['READY', 'RUNNING', 'WAITING'].includes(step.state));
async function workflowUi(page) {
  await navigateUi(page, '历练 Missions');
  await page.getByRole('link', { name: '工作流历练', exact: true }).click();
  await page.locator('.workflow-workspace').waitFor();
}

async function createThroughRenderer(page, testCase) {
  await workflowUi(page);
  await page.getByRole('button', { name: '新建运行', exact: true }).click();
  await page.locator('#workflow-version-select').selectOption('official.research::1');
  await page.locator('#workflow-input-researchQuestion').fill(testCase.question);
  await page.locator('#workflow-input-field').fill(testCase.field);
  await page.locator('#workflow-input-scope').fill(testCase.scope);
  await page.locator('#workflow-input-literatureTimeRange-from').fill('2020-01-01');
  await page.locator('#workflow-input-literatureTimeRange-to').fill('2026-10-04');
  await page.locator('#workflow-input-experimentMode').selectOption(testCase.mode);
  await page.locator('#workflow-input-maxExperimentCycles').fill('2');
  if (testCase.dataset) {
    const datasetGroup = page
      .locator('.workflow-launch-drawer fieldset')
      .filter({ has: page.locator('legend', { hasText: '已有数据' }) })
      .first();
    await datasetGroup.getByRole('button', { name: '添加一项', exact: true }).click();
    const artifactId = '#workflow-input-existingData-0--id';
    await page.locator(artifactId).fill(testCase.dataset.id);
    await page.locator('#workflow-input-existingData-0--kind').selectOption(testCase.dataset.kind);
    await page.locator('#workflow-input-existingData-0--name').fill(testCase.dataset.name);
  }
  const visible = await page.locator('.workflow-launch-drawer').innerText();
  assert.ok(!/COMPUTATIONAL|HUMAN_OR_EXTERNAL|MIXED/.test(visible), 'enum values stay internal');
  await page.screenshot({ path: join(evidence, `${testCase.id}-create.png`), fullPage: true });
  await page.getByRole('button', { name: '创建运行', exact: true }).click();
  await page.getByRole('button', { name: '开始执行', exact: true }).waitFor();
  const run = read((db) =>
    db.prepare('SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1').get(),
  );
  assert.ok(run?.id, 'Renderer created and persisted a Workflow Run');
  await page.getByRole('button', { name: '开始执行', exact: true }).click();
  return run.id;
}

async function createActor(page, name, modelAlias, score = 90) {
  return page.evaluate(
    async ({ name, modelAlias, score, dimensions }) => {
      const api = window.cultivation;
      const provider = await api.providers.create({
        name: `${name}研究模型服务`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9999/v1',
      });
      const runtime = await api.runtimes.create({
        name: `${name}研究固定模型`,
        providerId: provider.id,
        credentialId: null,
        modelId: modelAlias,
      });
      const teammate = await api.teammates.create({
        name,
        avatar: null,
        title: '科研道友',
        description: '离线验收道友',
        identityPrompt: '',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
      for (const dimension of dimensions)
        await api.capability.saveBenchmark({
          runtimeProfileId: teammate.currentRuntimeProfileId,
          modelAlias,
          dimension,
          supported: true,
          normalizedScore: score,
          rawScore: null,
          source: '本地验收配置',
          benchmark: '科研 Workflow 离线验收',
          benchmarkVersion: '1',
          snapshotDate: '2026-10-04T00:00:00.000Z',
          sourceUrl: null,
          provenanceType: 'USER_ESTIMATE',
        });
      return teammate;
    },
    { name, modelAlias, score, dimensions: requiredDimensions },
  );
}

let live = await launch(['--w2-stop-applied']);
const facts = {
  profile,
  workspace,
  cases: [],
  computationalRestart: null,
  mixedContinuationRestart: null,
  noPublication: true,
};
try {
  await live.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspace);
  await live.page.evaluate(() => window.cultivation.tools.chooseWorkspace());

  const setup = await live.page.evaluate(
    async ({ fixture, workspace, nodeCommand }) => {
      const api = window.cultivation;
      const version = (await api.workflows.versions()).find(
        (entry) => entry.definition.id === 'official.research',
      );
      if (!version) throw new Error('Official Research Workflow is not installed');
      const dimensions = [
        ...new Set(version.steps.flatMap((step) => step.routing.requiredCapabilities ?? [])),
      ];
      const server = await api.tools.saveMcpServer({
        name: '研究来源与计算工具',
        command: nodeCommand,
        args: [fixture],
        envWhitelist: ['W23_WORKSPACE_ROOT', 'TEMP', 'TMP'],
        cwd: workspace,
        enabled: true,
      });
      const discovered = await api.tools.refreshMcpServer(server.id);
      if (discovered.status !== 'READY') throw new Error(discovered.message);
      const sources = discovered.tools.find((tool) => tool.toolName === 'research_sources');
      const experiment = discovered.tools.find((tool) => tool.toolName === 'run_experiment');
      if (!sources || !experiment) throw new Error('Research MCP tools were not discovered');
      await api.tools.setToolPurposes({ toolId: sources.id, purposes: ['RESEARCH'] });
      await api.tools.setToolPurposes({ toolId: experiment.id, purposes: ['RESEARCH'] });
      for (const dimension of ['GENERAL_REASONING', 'LONG_CONTEXT_REASONING', 'CODING', 'TOOL_USE'])
        await api.r2.setCapability({ dimension, enabled: true });
      return {
        serverId: server.id,
        sourceToolId: sources.id,
        experimentToolId: experiment.id,
        dimensions,
      };
    },
    { fixture: mcpFixturePath, workspace, nodeCommand: process.execPath },
  );
  facts.setup = setup;
  const firstActor = await createActor(live.page, '青岚', 'research-fixture-a', 95);
  const secondActor = await createActor(live.page, '明衡', 'research-fixture-b', 85);
  facts.actors = [
    { id: firstActor.id, name: firstActor.name },
    { id: secondActor.id, name: secondActor.name },
  ];

  for (const testCase of cases) {
    if (testCase.id === 'B-dataset') {
      await live.page.evaluate((id) => window.cultivation.teammates.archive(id), secondActor.id);
      assert.equal(
        read(
          (db) => db.prepare('SELECT status FROM teammates WHERE id=?').get(secondActor.id)?.status,
        ),
        'ARCHIVED',
        'dataset acceptance leaves one qualified reviewer to record non-independence honestly',
      );
    } else if (testCase.id === 'D-mixed-human-bridge') {
      const third = await createActor(live.page, '知微', 'research-fixture-c', 88);
      facts.actors.push({ id: third.id, name: third.name });
    }

    const runId = await createThroughRenderer(live.page, testCase);
    let completed = null;
    let approvals = 0;
    let manualResume = null;
    let computationalRestart = null;
    for (let iteration = 0; iteration < 280; iteration++) {
      let workflow = await detail(live.page, runId);
      const current = active(workflow);
      if (workflow.run.state === 'COMPLETED') {
        completed = workflow;
        break;
      }
      assert.notEqual(workflow.run.state, 'FAILED', `${testCase.id}: ${JSON.stringify(current)}`);
      if (workflow.run.waitReason === 'USER_CONFIRMATION') {
        await workflowUi(live.page);
        await live.page.getByRole('button', { name: '确认交付，不发布', exact: true }).click();
        await delay(60);
        continue;
      }
      assert.ok(current, `${testCase.id} has a durable active Step`);
      if (current.errorCode)
        throw new Error(`${testCase.id} ${current.stepId} failed: ${current.errorCode}`);

      let pendingApproval = null;
      for (const step of [...workflow.steps].reverse()) {
        if (!step.missionId) continue;
        const mission = await live.page.evaluate(
          (id) => window.cultivation.missions.detail(id),
          step.missionId,
        );
        const approval = mission.approvals.find((item) => item.state === 'PENDING');
        if (approval) {
          pendingApproval = approval;
          break;
        }
      }
      if (pendingApproval) {
        approvals++;
        await live.page.evaluate(
          (id) =>
            window.cultivation.missions.resolveApproval({
              approvalId: id,
              decision: 'ALLOW_MISSION',
            }),
          pendingApproval.id,
        );
        await delay(60);
        continue;
      }

      if (workflow.run.waitReason === 'EXTERNAL_WORK') {
        assert.equal(testCase.humanBridge, true, 'only Human Bridge cases request external work');
        assert.equal(current.stepId, 'R08');
        if (manualResume) {
          await delay(100);
          continue;
        }
        const request = await live.page.evaluate(async (missionId) => {
          const requests = await window.cultivation.r2.listRequests();
          return requests.find((item) => item.missionId === missionId && item.state === 'PENDING');
        }, current.missionId);
        assert.ok(request, 'experiment has a durable Human Bridge request');
        const detailBefore = workflow;
        const outputKey = (artifact) => artifact.metadata.outputKey ?? artifact.metadata.logicalKey;
        const plan = detailBefore.artifacts.find(
          (artifact) => outputKey(artifact) === 'research.experiment_plan',
        );
        assert.ok(plan, 'the external step has a persisted experiment plan');
        const base = `workflows/${runId}/${current.id}/research`;
        const rawPath = `${base}/raw-result.json`;
        const logPath = `${base}/experiment-log.txt`;
        let rawBytes;
        let logBytes;
        if (testCase.mode === 'MIXED') {
          rawBytes = readFileSync(join(workspace, rawPath));
          logBytes = readFileSync(join(workspace, logPath));
        } else {
          rawBytes = Buffer.from(
            JSON.stringify(
              {
                attemptNumber: current.attempt,
                mode: 'HUMAN_OR_EXTERNAL',
                planArtifactId: plan.id,
                observation: '本尊提交的离线模拟观察，仅作为验收流程样例。',
                fixtureDisclosure: '该用户提交内容不代表真实领域实验数据。',
              },
              null,
              2,
            ),
            'utf8',
          );
          logBytes = Buffer.from(
            `attempt=${current.attempt}\nmode=HUMAN_OR_EXTERNAL\nsource=explicit-user-bridge-submission\n`,
            'utf8',
          );
        }
        const rawResult = { relativePath: rawPath, contentHash: hash(rawBytes) };
        const experimentLog = { relativePath: logPath, contentHash: hash(logBytes) };
        const recordValue = {
          attemptNumber: current.attempt,
          mode: testCase.mode,
          planArtifactId: plan.id,
          operationKey: `workflow:${runId}:${current.id}`,
          status: 'COMPLETED',
          rawResult,
          experimentLog,
          metrics: [],
          negativeResults: ['人工观察仅为离线模拟补充，不扩大实验结论。'],
          failureDetails: [],
          limitations: ['本尊提交的验收记录不构成真实领域实验。'],
          reproducibilityNotes:
            testCase.mode === 'MIXED'
              ? ['原始计算结果及日志由已授权 Research MCP 生成，人工续接没有覆盖文件。']
              : ['本尊通过明确的外部工作请求提交记录与文件。'],
        };
        const targets = request.targetArtifactsJson.items;
        const targetDirectory = request.targetWorkspacePathsJson.items[0];
        const safeTargetDirectory = String(targetDirectory)
          .replaceAll('\\', '/')
          .replace(/\/+$/, '');
        assert.ok(Array.isArray(targets) && targets.length > 0);
        assert.equal(
          safeTargetDirectory,
          base,
          'Human Bridge record stays in its step-scoped Workspace directory',
        );
        const submissions = [];
        for (const target of targets) {
          const key = String(target.id).toLowerCase().replaceAll('.', '_').replaceAll('-', '_');
          if (key.includes('raw_result') || key.includes('rawresult'))
            submissions.push({ targetArtifactId: target.id, relativePath: rawPath });
          else if (key.includes('experiment_log') || key.includes('experimentlog'))
            submissions.push({ targetArtifactId: target.id, relativePath: logPath });
          else if (key.includes('experiment_record') || key.includes('experimentrecord')) {
            const recordPath = `${safeTargetDirectory}/experiment-record.json`;
            writeFileSync(
              join(workspace, recordPath),
              JSON.stringify(recordValue, null, 2),
              'utf8',
            );
            submissions.push({ targetArtifactId: target.id, relativePath: recordPath });
          } else {
            throw new Error(`Unsupported Human Bridge research target: ${target.id}`);
          }
        }
        for (const target of targets.filter((item) => item.required))
          assert.ok(submissions.some((item) => item.targetArtifactId === target.id));
        const callsBefore = read(
          (db) =>
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type='model.call_started'",
              )
              .get(current.missionId).n,
        );
        const toolsBefore = read(
          (db) =>
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type='tool.result'",
              )
              .get(current.missionId).n,
        );
        await navigateUi(live.page, '本尊待办 Human Bridge');
        await live.page.locator('.human-bridge-request-brief').waitFor();
        await live.page.screenshot({
          path: join(evidence, `${testCase.id}-human-bridge-pending.png`),
          fullPage: true,
        });

        await kill(live.app);
        live = await launch(testCase.mode === 'MIXED' ? ['--w23-stop-manual-continuation'] : []);
        workflow = await detail(live.page, runId);
        const waitingAfterRestart = workflow.steps.find((step) => step.id === current.id);
        assert.equal(waitingAfterRestart?.missionRunId, current.missionRunId);
        assert.equal(waitingAfterRestart?.state, 'WAITING');
        await live.page.evaluate(
          async (id) => window.cultivation.r2.markInProgress(id),
          request.id,
        );
        if (testCase.mode === 'HUMAN_OR_EXTERNAL') {
          mkdirSync(join(workspace, base), { recursive: true });
          writeFileSync(join(workspace, rawPath), rawBytes);
          writeFileSync(join(workspace, logPath), logBytes);
        }
        await live.page.evaluate(
          async ({ id, submissions }) =>
            window.cultivation.r2.submitArtifacts({ requestId: id, artifacts: submissions }),
          { id: request.id, submissions },
        );
        const acceptance = live.page.evaluate(
          (id) =>
            window.cultivation.r2.accept({
              requestId: id,
              publicResult: '已提交受限的补充观察，并保留实验原始结果。',
            }),
          request.id,
        );
        if (testCase.mode === 'MIXED') {
          void acceptance.catch(() => {});
          await poll(
            (db) =>
              db
                .prepare(
                  "SELECT state FROM r2_external_work_continuations WHERE external_work_request_id=? AND state='PENDING'",
                )
                .get(request.id),
            'accepted mixed continuation pending before restart',
          );
          await kill(live.app);
          live = await launch();
        } else {
          await acceptance;
        }
        await poll(
          (db) =>
            db
              .prepare(
                'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id=?',
              )
              .get(request.id)?.state === 'CONSUMED',
          'accepted continuation consumed after restart',
        );
        workflow = await detail(live.page, runId);
        const resumedStep = workflow.steps.find((step) => step.id === current.id);
        assert.equal(resumedStep?.missionRunId, current.missionRunId);
        assert.equal(resumedStep?.state, 'COMPLETED');
        assert.equal(
          read(
            (db) =>
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type='model.call_started'",
                )
                .get(current.missionId).n,
          ),
          callsBefore,
          'Human Bridge continuation restart does not synthesize a second model call',
        );
        assert.equal(
          read(
            (db) =>
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type='tool.result'",
                )
                .get(current.missionId).n,
          ),
          toolsBefore,
          'Human Bridge continuation restart does not rerun the Research Tool',
        );
        assert.equal(hash(readFileSync(join(workspace, rawPath))), rawResult.contentHash);
        assert.equal(hash(readFileSync(join(workspace, logPath))), experimentLog.contentHash);
        manualResume = {
          requestId: request.id,
          missionRunId: current.missionRunId,
          continuation: 'CONSUMED',
          rawResult,
          experimentLog,
          noModelOrToolReplay: true,
        };
        if (testCase.mode === 'MIXED') facts.mixedContinuationRestart = manualResume;
        continue;
      }

      if (testCase.id === 'A-algorithm' && current.stepId === 'R08' && !computationalRestart) {
        void live.page
          .evaluate((id) => window.cultivation.workflows.advance(id), runId)
          .catch(() => {});
        const receipt = await poll(
          (db) =>
            db
              .prepare(
                "SELECT id,state FROM workflow_step_operation_receipts WHERE step_run_id=? AND state='APPLIED'",
              )
              .get(current.id),
          'R08 APPLIED file-output receipt',
        );
        const stepFiles = [
          `workflows/${runId}/${current.id}/research/raw-result.json`,
          `workflows/${runId}/${current.id}/research/experiment-log.txt`,
        ].map((path) => ({ path, contentHash: hash(readFileSync(join(workspace, path))) }));
        const before = read((db) =>
          db
            .prepare(
              "SELECT event_type,COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type IN ('model.call_started','tool.result') GROUP BY event_type ORDER BY event_type",
            )
            .all(current.missionId),
        );
        await kill(live.app);
        live = await launch();
        await poll(
          (db) =>
            db
              .prepare(
                "SELECT state FROM workflow_step_operation_receipts WHERE id=? AND state='VERIFIED'",
              )
              .get(receipt.id),
          'R08 receipt verified after restart',
        );
        const after = read((db) =>
          db
            .prepare(
              "SELECT event_type,COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type IN ('model.call_started','tool.result') GROUP BY event_type ORDER BY event_type",
            )
            .all(current.missionId),
        );
        assert.deepEqual(
          after,
          before,
          'APPLIED restart verifies the existing result without replay',
        );
        for (const item of stepFiles)
          assert.equal(hash(readFileSync(join(workspace, item.path))), item.contentHash);
        computationalRestart = { receipt, before, after, stepFiles, zeroReplay: true };
        facts.computationalRestart = computationalRestart;
        await live.page.evaluate((id) => window.cultivation.workflows.advance(id), runId);
        continue;
      }

      await live.page.evaluate((id) => window.cultivation.workflows.advance(id), runId);
      await delay(80);
    }
    assert.ok(
      completed || (completed = await detail(live.page, runId)).run.state === 'COMPLETED',
      `${testCase.id} completes`,
    );
    if (!completed || completed.run.state !== 'COMPLETED')
      throw new Error(`${testCase.id} did not reach Workflow COMPLETED`);

    const byKey = (key) =>
      completed.artifacts
        .filter((artifact) => (artifact.metadata.outputKey ?? artifact.metadata.logicalKey) === key)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const literature = JSON.parse(byKey('research.literature').at(-1).content);
    assert.ok(literature.sources.length >= 1);
    assert.equal(
      new Set(literature.sources.map((source) => source.sourceArtifactId)).size,
      literature.sources.length,
    );
    assert.ok(
      literature.sources.every(
        (source) => source.discoveryMethod === 'RESEARCH_TOOL' && source.sourceContentHash,
      ),
    );
    const screening = JSON.parse(byKey('research.screening').at(-1).content);
    assert.ok(screening.sources.some((source) => source.included === true && source.reason));
    assert.ok(screening.sources.some((source) => source.included === false && source.reason));
    const claimMap = JSON.parse(byKey('research.claim_evidence_map').at(-1).content);
    const artifactIds = new Set(completed.artifacts.map((artifact) => artifact.id));
    assert.ok(claimMap.claims.length > 0);
    assert.ok(
      claimMap.claims.every(
        (claim) =>
          claim.artifactIds.length > 0 && claim.artifactIds.every((id) => artifactIds.has(id)),
      ),
    );
    const analysis = JSON.parse(byKey('research.analysis_results').at(-1).content);
    if (testCase.id === 'B-dataset') assert.ok(analysis.negativeResults.length > 0);
    const finalPackage = JSON.parse(byKey('research.final_package').at(-1).content);
    assert.equal(finalPackage.submissionStatus, 'NOT_SUBMITTED');
    assert.equal(finalPackage.conclusionStatus, 'NOT_SCIENTIFICALLY_CONFIRMED');
    assert.ok(finalPackage.experimentAttempts.length >= 1);
    assert.ok(
      finalPackage.experimentAttempts.every(
        (attempt) => attempt.missionRunId && attempt.attempt >= 1,
      ),
    );
    if (testCase.id === 'B-dataset')
      assert.ok(
        finalPackage.experimentAttempts.length >= 2,
        'dataset case traverses a second experiment',
      );
    const experimentTraversals = completed.traversals.filter(
      (traversal) => traversal.groupId === 'research.experiment_cycle',
    );
    assert.equal(experimentTraversals.length, testCase.expectedCycleTraversals);
    assert.ok(experimentTraversals.length <= 2);

    const reviewSteps = completed.steps.filter((step) => ['R06', 'R12'].includes(step.stepId));
    const reviewFacts = reviewSteps.flatMap((step) =>
      read((db) =>
        db
          .prepare(
            "SELECT payload_json FROM mission_events WHERE mission_id=? AND event_type='workflow.review_independence'",
          )
          .all(step.missionId)
          .map((row) => JSON.parse(row.payload_json))
          .filter((event) => event.stepRunId === step.id),
      ),
    );
    assert.ok(reviewFacts.length >= 2, 'trusted Main persisted review independence facts');
    const reviewArtifacts = byKey('research.review');
    for (const step of reviewSteps) {
      const fact = reviewFacts.find((item) => item.stepRunId === step.id);
      const artifact = reviewArtifacts.find((item) => item.producerStepRunId === step.id);
      if (fact && artifact) {
        const expected = fact.reviewIndependence ? 1 : 0;
        assert.equal(Number(artifact.metadata.reviewIndependence), expected);
      }
    }
    if (testCase.id === 'B-dataset') {
      const dependentFacts = reviewFacts.filter((fact) => fact.reviewIndependence === false);
      assert.ok(dependentFacts.length >= 1);
      assert.ok(
        dependentFacts.every(
          (fact) => Array.isArray(fact.authorIds) && fact.authorIds.includes(fact.reviewerId),
        ),
        'single-qualified-reviewer path records reviewer overlap with the actual author set',
      );
      assert.ok(
        reviewArtifacts.some((artifact) => Number(artifact.metadata.reviewIndependence) === 0),
      );
    }
    if (testCase.id === 'A-algorithm') {
      assert.ok(reviewFacts.every((fact) => fact.reviewIndependence === true));
      assert.ok(
        reviewFacts.every(
          (fact) => Array.isArray(fact.authorIds) && !fact.authorIds.includes(fact.reviewerId),
        ),
        'independent review reviewer differs from every author for that reviewed artifact',
      );
    }

    const r02Step = completed.steps.find((step) => step.stepId === 'R02' && step.missionId);
    assert.ok(r02Step);
    const r02ToolFacts = read((db) =>
      db
        .prepare(
          "SELECT actor_id,payload_json FROM mission_events WHERE mission_id=? AND run_id=? AND event_type='tool.result'",
        )
        .all(r02Step.missionId, r02Step.missionRunId)
        .map((event) => ({ actorId: event.actor_id, ...JSON.parse(event.payload_json) })),
    );
    assert.ok(
      r02ToolFacts.some((event) => event.toolId === setup.sourceToolId && event.success === true),
    );
    assert.ok(approvals >= 1, 'MCP/experiment permissions were resolved through approval');

    const screenshotRun = await detail(live.page, runId);
    await workflowUi(live.page);
    const runItem = live.page
      .locator('.workflow-run-item')
      .filter({ hasText: testCase.question.slice(0, 12) });
    if (await runItem.count()) await runItem.first().click();
    await live.page.screenshot({
      path: join(evidence, `${testCase.id}-completed.png`),
      fullPage: true,
    });
    facts.cases.push({
      id: testCase.id,
      workflowRunId: runId,
      state: screenshotRun.run.state,
      mode: testCase.mode,
      approvals,
      experimentAttempts: finalPackage.experimentAttempts,
      experimentTraversals,
      sourceArtifactIds: literature.sources.map((source) => source.sourceArtifactId),
      reviewIndependence: reviewFacts.map((fact) => ({
        reviewerId: fact.reviewerId,
        authorIds: fact.authorIds,
        independent: fact.reviewIndependence,
      })),
      claims: claimMap.claims,
      continuation: manualResume,
      computationalRestart,
      finalPackage: {
        submissionStatus: finalPackage.submissionStatus,
        conclusionStatus: finalPackage.conclusionStatus,
        attemptCount: finalPackage.experimentAttempts.length,
      },
    });
  }

  // Fail-closed external uncertainty: a test-only state transition models the crash ambiguity
  // after a real PREPARED external action. Startup must preserve the request and require the user.
  const unknownCase = {
    id: 'E-unknown-external-action',
    question: '模拟外部实验动作结果不确定时保留待用户处理状态',
    field: '可复现性',
    scope: '只验证外部动作不确定后不会自动重做',
    mode: 'HUMAN_OR_EXTERNAL',
    expectedCycleTraversals: 0,
    humanBridge: true,
  };
  const unknownRunId = await createThroughRenderer(live.page, unknownCase);
  let unknownWorkflow = null;
  for (let iteration = 0; iteration < 160; iteration++) {
    unknownWorkflow = await detail(live.page, unknownRunId);
    assert.notEqual(unknownWorkflow.run.state, 'FAILED');
    if (unknownWorkflow.run.waitReason === 'EXTERNAL_WORK') break;
    const step = active(unknownWorkflow);
    if (!step) throw new Error('Unknown-action fixture has no active Step');
    let approval = null;
    for (const candidate of [...unknownWorkflow.steps].reverse()) {
      if (!candidate.missionId) continue;
      const mission = await live.page.evaluate(
        (id) => window.cultivation.missions.detail(id),
        candidate.missionId,
      );
      approval = mission.approvals.find((item) => item.state === 'PENDING') ?? null;
      if (approval) break;
    }
    if (approval) {
      await live.page.evaluate(
        (id) =>
          window.cultivation.missions.resolveApproval({
            approvalId: id,
            decision: 'ALLOW_MISSION',
          }),
        approval.id,
      );
      continue;
    }
    await live.page.evaluate((id) => window.cultivation.workflows.advance(id), unknownRunId);
    await delay(70);
  }
  assert.equal(unknownWorkflow?.run.waitReason, 'EXTERNAL_WORK');
  const unknownStep = active(unknownWorkflow);
  assert.equal(unknownStep?.stepId, 'R08');
  const externalRequest = await live.page.evaluate(async (missionId) => {
    const requests = await window.cultivation.r2.listRequests();
    return requests.find((item) => item.missionId === missionId && item.state === 'PENDING');
  }, unknownStep.missionId);
  assert.ok(externalRequest);
  const prepared = read((db) =>
    db
      .prepare(
        "SELECT id,state,effect_type FROM workflow_step_operation_receipts WHERE workflow_run_id=? AND step_run_id=? AND effect_type='EXTERNAL_ACTION' AND state='PREPARED'",
      )
      .get(unknownRunId, unknownStep.id),
  );
  assert.ok(
    prepared,
    'an actual R08 EXTERNAL_ACTION receipt is PREPARED before fixture crash injection',
  );
  const unknownEventsBefore = read((db) =>
    db
      .prepare(
        "SELECT event_type,COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type IN ('model.call_started','tool.result') GROUP BY event_type ORDER BY event_type",
      )
      .all(unknownStep.missionId),
  );
  const writable = new Database(databasePath);
  try {
    const result = writable
      .prepare(
        "UPDATE workflow_step_operation_receipts SET state='UNKNOWN',updated_at=? WHERE id=? AND state='PREPARED' AND effect_type='EXTERNAL_ACTION'",
      )
      .run(new Date().toISOString(), prepared.id);
    assert.equal(result.changes, 1, 'only the isolated fixture database moves PREPARED to UNKNOWN');
  } finally {
    writable.close();
  }
  await kill(live.app);
  live = await launch();
  await poll(
    (db) =>
      db
        .prepare(
          "SELECT state FROM workflow_step_operation_receipts WHERE id=? AND state='UNKNOWN'",
        )
        .get(prepared.id),
    'external action remains UNKNOWN after restart',
  );
  const unknownAfter = await detail(live.page, unknownRunId);
  assert.equal(unknownAfter.run.waitReason, 'USER_CONFIRMATION');
  assert.equal(active(unknownAfter)?.missionRunId, unknownStep.missionRunId);
  assert.equal(
    read(
      (db) =>
        db.prepare('SELECT state FROM external_work_requests WHERE id=?').get(externalRequest.id)
          ?.state,
    ),
    'PENDING',
    'unknown external action preserves its original pending Human Bridge request',
  );
  assert.deepEqual(
    read((db) =>
      db
        .prepare(
          "SELECT event_type,COUNT(*) AS n FROM mission_events WHERE mission_id=? AND event_type IN ('model.call_started','tool.result') GROUP BY event_type ORDER BY event_type",
        )
        .all(unknownStep.missionId),
    ),
    unknownEventsBefore,
    'UNKNOWN restart does not call a model or tool again',
  );
  facts.unknownExternalAction = {
    workflowRunId: unknownRunId,
    stepRunId: unknownStep.id,
    missionRunId: unknownStep.missionRunId,
    requestId: externalRequest.id,
    receiptId: prepared.id,
    state: 'UNKNOWN',
    waitReason: unknownAfter.run.waitReason,
    noModelOrToolReplay: true,
  };

  const before = read((db) => ({
    calls: db
      .prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='model.call_started'")
      .get().n,
    tools: db
      .prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='tool.result'")
      .get().n,
    continuations: db
      .prepare("SELECT COUNT(*) AS n FROM r2_external_work_continuations WHERE state='CONSUMED'")
      .get().n,
  }));
  await live.app.close();
  live = await launch();
  const after = read((db) => ({
    calls: db
      .prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='model.call_started'")
      .get().n,
    tools: db
      .prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='tool.result'")
      .get().n,
    continuations: db
      .prepare("SELECT COUNT(*) AS n FROM r2_external_work_continuations WHERE state='CONSUMED'")
      .get().n,
  }));
  assert.deepEqual(after, before, 'full restart is idempotent after all three acceptance Runs');
  facts.restartIdempotent = { before, after };
  facts.noAutomaticPublication = facts.cases.every(
    (item) => item.finalPackage.submissionStatus === 'NOT_SUBMITTED',
  );
  assert.equal(facts.noAutomaticPublication, true);
  writeFileSync(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(`W2.3 packaged acceptance passed: ${evidence}`);
} catch (error) {
  writeFileSync(join(evidence, 'failure.txt'), String(error?.stack ?? error), 'utf8');
  throw error;
} finally {
  await live.app.close().catch(() => {});
}
