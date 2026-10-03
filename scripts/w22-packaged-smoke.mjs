import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const profile = join(root, '.test-data', `w22-packaged-${randomUUID()}`);
const workspace = join(profile, 'workspace');
const evidence = join(profile, 'evidence');
mkdirSync(evidence, { recursive: true });
mkdirSync(join(workspace, 'migrations'), { recursive: true });
const databasePath = join(profile, 'data', 'cultivation.sqlite');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const cases = [
  {
    name: 'bugfix',
    objective: '小型错误修复：让 answer 返回 42',
    paths: ['main.js'],
    test: "const source = readFileSync('main.js','utf8'); assert.match(source,/answer = 42/);",
  },
  {
    name: 'migration',
    objective: '数据库 migration 功能：新增 feature_records',
    paths: ['migrations/0001_feature.sql'],
    test: "const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec(readFileSync('migrations/0001_feature.sql','utf8')); db.prepare('INSERT INTO feature_records(id) VALUES (?)').run('feature-1'); assert.equal(db.prepare('SELECT id FROM feature_records').get().id, 'feature-1'); db.close();",
  },
  {
    name: 'crossLayer',
    objective: 'Renderer IPC persistence 跨层功能',
    paths: ['renderer.ts', 'ipc.ts', 'store.ts'],
    test: "const renderer = await import('./renderer.ts'); const ipc = await import('./ipc.ts'); const store = await import('./store.ts'); assert.equal(renderer.featureRenderer, true); assert.equal(ipc.featureIpc, 'feature:run'); assert.equal(store.featureStored, true);",
  },
  {
    name: 'mixed',
    objective: '混合验收 mixed migration：命令验证与人工交付说明检查',
    paths: ['migrations/0001_feature.sql'],
    test: "assert.match(readFileSync('migrations/0001_feature.sql','utf8'),/feature_records/);",
  },
];
writeFileSync(
  join(workspace, 'package.json'),
  JSON.stringify({
    name: 'bounded-software-workspace',
    type: 'module',
    scripts: { test: 'node verify.mjs' },
  }),
  'utf8',
);
writeFileSync(join(workspace, 'main.js'), 'export const answer = 0;\n', 'utf8');
for (const file of ['renderer.ts', 'ipc.ts', 'store.ts'])
  writeFileSync(join(workspace, file), '// existing project file\n', 'utf8');
function read(fn) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function launch(hook = false, manualHook = false) {
  const app = await electron.launch({
    executablePath,
    args: [
      '--gate1-fake-model',
      '--r4-fake-routing',
      '--w22-fake-software',
      ...(hook ? ['--w2-stop-applied'] : []),
      ...(manualHook ? ['--w22-stop-manual-continuation'] : []),
    ],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile, W22_WORKSPACE_ROOT: workspace },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}
async function kill(app) {
  const child = app.process();
  const exited = new Promise((resolve) => child.once('close', resolve));
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await exited;
}
async function poll(fn, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = read(fn);
    if (result) return result;
    await delay(100);
  }
  throw new Error(`W22 timeout: ${label}`);
}
const detail = (page, id) => page.evaluate((id) => window.cultivation.workflows.detail(id), id);
const active = (workflow) =>
  [...workflow.steps]
    .reverse()
    .find((step) => ['READY', 'RUNNING', 'WAITING'].includes(step.state));
function counts(missionId) {
  return read((db) =>
    db
      .prepare(
        'SELECT event_type,COUNT(*) AS n FROM mission_events WHERE mission_id=? GROUP BY event_type ORDER BY event_type',
      )
      .all(missionId),
  );
}
async function workflowUi(page) {
  await navigateUi(page, '历练 Missions');
  await page.getByRole('link', { name: '工作流历练', exact: true }).click();
  await page.locator('.workflow-workspace').waitFor();
}
async function createUi(page, inputs) {
  await workflowUi(page);
  await page.getByRole('button', { name: '新建运行', exact: true }).click();
  await page.locator('#workflow-version-select').selectOption('official.software-feature::1');
  await page.locator('#workflow-input-objective').fill(inputs.objective);
  await page.locator('code[aria-label="当前 Workspace 根路径"]').waitFor();
  assert.equal(
    await page.locator('code[aria-label="当前 Workspace 根路径"]').innerText(),
    inputs.workspaceRoot,
  );
  assert.equal(await page.locator('input#workflow-input-workspaceRoot').count(), 0);
  for (const key of ['targetArea']) {
    const title = '允许修改的相对路径 / 模块';
    const field = page
      .locator('.workflow-launch-drawer fieldset')
      .filter({ has: page.locator('legend', { hasText: title }) })
      .first();
    for (const [i, value] of inputs[key].entries()) {
      if (!(await page.locator(`#workflow-input-${key}-${i}-`).count()))
        await field.getByRole('button', { name: '添加一项', exact: true }).click();
      await page.locator(`#workflow-input-${key}-${i}-`).fill(value);
    }
  }
  const tools = await page.evaluate(async () => {
    const api = window.cultivation.tools;
    const discoveries = await Promise.all(
      (await api.listMcpServers())
        .filter((server) => server.enabled)
        .map((server) => api.refreshMcpServer(server.id)),
    );
    return [...(await api.listBuiltins()), ...discoveries.flatMap((server) => server.tools)];
  });
  for (const id of inputs.allowedToolScope) {
    const tool = tools.find((item) => item.id === id);
    assert.ok(tool);
    await page.locator(`input[data-tool-id="${id}"]`).check();
  }
  await page.screenshot({ path: join(evidence, '03-tool-scope-selection.png'), fullPage: true });
  await page.locator('.workflow-launch-drawer .drawer-content').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: join(evidence, '01-software-inputs.png'), fullPage: true });
  await page.getByRole('button', { name: '创建运行', exact: true }).click();
  await page.getByRole('button', { name: '开始执行', exact: true }).waitFor();
  return read(
    (db) => db.prepare('SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1').get().id,
  );
}
let live = await launch(true);
const facts = { profile, workspace, cases: [], mutationRestart: null };
try {
  await live.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspace);
  await live.page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  const setup = await live.page.evaluate(
    async ({ fixture, workspace, nodePath }) => {
      const api = window.cultivation;
      const version = (await api.workflows.versions()).find(
        (v) => v.definition.id === 'official.software-feature',
      );
      if (!version) throw new Error('Official software package not installed');
      const dimensions = [
        ...new Set(version.steps.flatMap((s) => s.routing.requiredCapabilities ?? [])),
      ];
      const actors = [];
      await api.r2.setCapability({ dimension: 'CODING', enabled: true });
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
        for (const dimension of dimensions)
          await api.capability.saveBenchmark({
            runtimeProfileId: teammate.currentRuntimeProfileId,
            modelAlias: 'software-local-model',
            dimension,
            supported: true,
            normalizedScore: score,
            rawScore: null,
            source: '离线验收',
            benchmark: '软件流程验收',
            benchmarkVersion: '1',
            snapshotDate: '2026-10-03T00:00:00.000Z',
            sourceUrl: null,
            provenanceType: 'USER_ESTIMATE',
          });
        actors.push(teammate);
      }
      const server = await api.tools.saveMcpServer({
        name: '项目验证工具',
        command: nodePath,
        args: [fixture],
        envWhitelist: ['W22_WORKSPACE_ROOT', 'TEMP', 'TMP'],
        cwd: workspace,
        enabled: true,
      });
      const discovered = await api.tools.refreshMcpServer(server.id);
      if (discovered.status !== 'READY') throw new Error(discovered.message);
      return {
        actors,
        serverId: server.id,
        toolId: discovered.tools.find((t) => t.toolName === 'verify_repository').id,
      };
    },
    {
      fixture: join(root, 'scripts', 'fixtures', 'software-mcp-fixture.mjs'),
      workspace,
      nodePath: process.execPath,
    },
  );
  facts.setup = setup;
  for (const testCase of cases) {
    writeFileSync(
      join(workspace, 'verify.mjs'),
      `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n${testCase.test}\nconsole.log('验收通过');\n`,
      'utf8',
    );
    const inputs = {
      objective: testCase.objective,
      workspaceRoot: workspace,
      targetArea: testCase.paths,
      allowedToolScope: ['file.readText', 'file.writeText', setup.toolId],
    };
    const runId =
      testCase.name === 'bugfix'
        ? await createUi(live.page, inputs)
        : (
            await live.page.evaluate(
              (inputs) =>
                window.cultivation.workflows.create({
                  definitionId: 'official.software-feature',
                  version: 1,
                  inputs,
                }),
              inputs,
            )
          ).run.id;
    const approvals = [];
    let recovered = false;
    let completed;
    for (let iteration = 0; iteration < 180; iteration++) {
      const workflow = await detail(live.page, runId);
      const current = active(workflow);
      if (workflow.run.state === 'COMPLETED') {
        completed = workflow;
        break;
      }
      assert.notEqual(workflow.run.state, 'FAILED', JSON.stringify(current));
      if (workflow.run.waitReason === 'EXTERNAL_WORK') {
        assert.equal(testCase.name, 'mixed', 'only mixed S06 requires manual verification');
        assert.equal(current.stepId, 'S06');
        const requests = await live.page.evaluate(() => window.cultivation.r2.listRequests());
        const request = requests.find(
          (r) =>
            r.missionId === current.missionId &&
            r.runId === current.missionRunId &&
            r.state === 'PENDING',
        );
        assert.ok(request, 'one bounded manual request on original S06 Run');
        const before = counts(current.missionId);
        assert.equal(
          read(
            (db) =>
              db
                .prepare(
                  'SELECT COUNT(*) AS n FROM workflow_verification_facts WHERE step_run_id=?',
                )
                .get(current.id).n,
          ),
          1,
        );
        await kill(live.app);
        live = await launch(false, true);
        assert.deepEqual(
          counts(current.missionId),
          before,
          'manual wait restart cannot repeat commands',
        );
        const resumed = await detail(live.page, runId);
        assert.equal(active(resumed).missionRunId, current.missionRunId);
        await navigateUi(live.page, '本尊待办 Human Bridge');
        await live.page.locator('.human-bridge-request-brief').waitFor();
        await live.page.screenshot({
          path: join(evidence, '04-mixed-command-human-verification.png'),
          fullPage: true,
        });
        const directory = request.targetWorkspacePathsJson.items[0];
        mkdirSync(join(workspace, directory), { recursive: true });
        const path = `${directory}/software.tests.json`;
        writeFileSync(
          join(workspace, path),
          JSON.stringify({
            executions: [],
            criteria: [
              {
                criterionId: 'AC-MANUAL',
                status: 'PASS',
                evidenceArtifactIds: [],
                executionIds: [],
              },
            ],
            failures: [],
          }),
          'utf8',
        );
        await live.page.evaluate(
          async ({ id, path }) => {
            await window.cultivation.r2.markInProgress(id);
            await window.cultivation.r2.submitArtifacts({
              requestId: id,
              artifacts: [{ targetArtifactId: 'software.tests', relativePath: path }],
            });
          },
          { id: request.id, path },
        );
        void live.page
          .evaluate(
            (id) =>
              window.cultivation.r2.accept({ requestId: id, publicResult: '人工交付说明检查通过' }),
            request.id,
          )
          .catch(() => {});
        await poll(
          (db) =>
            db
              .prepare(
                "SELECT state FROM r2_external_work_continuations WHERE external_work_request_id=? AND state='PENDING'",
              )
              .get(request.id),
          'accepted continuation pending',
        );
        const afterAccept = counts(current.missionId);
        await kill(live.app);
        live = await launch();
        assert.equal(
          read(
            (db) =>
              db
                .prepare(
                  'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id=?',
                )
                .get(request.id).state,
          ),
          'CONSUMED',
        );
        const mission = await live.page.evaluate(
          (id) => window.cultivation.missions.detail(id),
          current.missionId,
        );
        assert.equal(mission.runs.length, 1);
        assert.equal(mission.runs[0].id, current.missionRunId);
        assert.equal(mission.runs[0].status, 'COMPLETED');
        const merged = JSON.parse(mission.runs[0].resultText);
        assert.equal(merged.executions.length, 1);
        assert.equal(merged.criteria.find((c) => c.criterionId === 'AC-MANUAL').status, 'PASS');
        const counted = (items, type) => items.find((i) => i.event_type === type)?.n ?? 0;
        const after = counts(current.missionId);
        for (const type of ['model.call_started', 'tool.result'])
          assert.equal(counted(after, type), counted(afterAccept, type));
        facts.mixedVerification = {
          workflowRunId: runId,
          stepRunId: current.id,
          missionRunId: current.missionRunId,
          requestId: request.id,
          commandFactCount: 1,
          merged,
          waitingRestartZeroReplay: true,
          acceptedRestartZeroReplay: true,
          before,
          afterAccept,
          after,
          continuation: 'CONSUMED',
        };
        continue;
      }
      if (current?.errorCode)
        throw new Error(`W22 ${testCase.name} ${current.stepId}: ${current.errorCode}`);
      let pending;
      for (const step of [...workflow.steps].reverse()) {
        if (!step.missionId) continue;
        const mission = await live.page.evaluate(
          (id) => window.cultivation.missions.detail(id),
          step.missionId,
        );
        const approval = mission.approvals.find((a) => a.state === 'PENDING');
        if (approval) {
          pending = { step, approval };
          break;
        }
      }
      if (pending) {
        approvals.push({ stepId: pending.step.stepId, capability: pending.approval.capability });
        await live.page.evaluate(
          (id) =>
            window.cultivation.missions.resolveApproval({
              approvalId: id,
              decision: 'ALLOW_MISSION',
            }),
          pending.approval.id,
        );
        await delay(50);
        continue;
      }
      if (testCase.name === 'bugfix' && current?.stepId === 'S05' && !recovered) {
        const mission = read((db) =>
          db.prepare('SELECT state FROM missions WHERE id=?').get(current.missionId),
        );
        if (mission?.state === 'COMPLETED') {
          void live.page.evaluate((id) => {
            void window.cultivation.workflows.advance(id);
          }, runId);
          const receipt = await poll(
            (db) =>
              db
                .prepare(
                  "SELECT id,state FROM workflow_step_operation_receipts WHERE step_run_id=? AND state='APPLIED'",
                )
                .get(current.id),
            'S05 APPLIED',
          );
          const before = counts(current.missionId);
          const hash = createHash('sha256')
            .update(readFileSync(join(workspace, 'main.js')))
            .digest('hex');
          await kill(live.app);
          live = await launch();
          assert.deepEqual(counts(current.missionId), before);
          assert.equal(
            createHash('sha256')
              .update(readFileSync(join(workspace, 'main.js')))
              .digest('hex'),
            hash,
          );
          facts.mutationRestart = {
            receipt,
            missionId: current.missionId,
            before,
            after: counts(current.missionId),
            zeroReplay: true,
          };
          recovered = true;
          continue;
        }
      }
      await live.page.evaluate((id) => window.cultivation.workflows.advance(id), runId);
      await delay(50);
    }
    assert.ok(completed, `W22 ${testCase.name} must complete`);
    const implementationIds = completed.steps
      .filter((s) => ['S05', 'S10'].includes(s.stepId) && s.missionId)
      .map((s) => s.missionId);
    const reviewIds = completed.steps
      .filter((s) => s.stepId === 'S08' && s.missionId)
      .map((s) => s.missionId);
    const implementers = read((db) =>
      implementationIds.map(
        (id) =>
          db.prepare('SELECT coordinator_teammate_id FROM missions WHERE id=?').get(id)
            .coordinator_teammate_id,
      ),
    );
    const reviewers = read((db) =>
      reviewIds.map(
        (id) =>
          db.prepare('SELECT coordinator_teammate_id FROM missions WHERE id=?').get(id)
            .coordinator_teammate_id,
      ),
    );
    assert.ok(
      reviewers.length && reviewers.every((id) => !implementers.includes(id)),
      'review must be independent',
    );
    assert.ok(completed.validations.every((v) => v.valid));
    if (testCase.name === 'bugfix') {
      assert.equal(
        completed.traversals.filter((t) => t.groupId === 'software.plan_revision').length,
        1,
      );
      assert.equal(
        completed.traversals.filter((t) => t.groupId === 'software.fix_cycle').length,
        2,
      );
    }
    const journal = read((db) =>
      db
        .prepare(
          'SELECT * FROM workflow_workspace_mutation_journal WHERE workflow_run_id=? ORDER BY created_at,id',
        )
        .all(runId),
    );
    assert.ok(
      journal.length &&
        journal.every(
          (row) => row.state === 'APPLIED' && row.expected_after_hash === row.observed_after_hash,
        ),
    );
    const verificationFacts = read((db) =>
      db
        .prepare(
          'SELECT * FROM workflow_verification_facts WHERE workflow_run_id=? ORDER BY created_at,id',
        )
        .all(runId),
    );
    assert.equal(verificationFacts.length, testCase.name === 'bugfix' ? 3 : 1);
    assert.deepEqual(
      verificationFacts.map((fact) => fact.exit_status),
      testCase.name === 'bugfix' ? [1, 0, 0] : [0],
    );
    for (const fact of verificationFacts) {
      assert.equal(fact.command, 'node verify.mjs');
      assert.ok(
        read((db) =>
          db
            .prepare(
              "SELECT id FROM mission_events WHERE mission_id=? AND run_id=? AND actor_id=? AND event_type='tool.result' AND json_extract(payload_json,'$.toolCallId')=? AND json_extract(payload_json,'$.outputHash')=? AND json_extract(payload_json,'$.success')=1",
            )
            .get(
              fact.mission_id,
              fact.mission_run_id,
              fact.actor_id,
              fact.tool_call_id,
              fact.output_hash,
            ),
        ),
      );
    }
    const final = completed.artifacts.find(
      (a) =>
        a.producerStepRunId ===
          completed.steps.find((s) => s.stepId === 'S11' && s.state === 'COMPLETED').id &&
        a.kind === 'DIRECTORY',
    );
    assert.ok(final);
    for (const entry of JSON.parse(final.content).entries)
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(workspace, entry.relativePath)))
          .digest('hex'),
        entry.afterHash,
      );
    facts.cases.push({
      name: testCase.name,
      runId,
      state: completed.run.state,
      implementers,
      reviewers,
      approvals,
      traversals: completed.traversals,
      validations: completed.validations.length,
      journal,
      verificationFacts,
      finalChanges: JSON.parse(final.content),
      steps: completed.steps.map((s) => ({ stepId: s.stepId, attempt: s.attempt, state: s.state })),
    });
    await workflowUi(live.page);
    await live.page.locator('.workflow-run-item').first().click();
    await delay(200);
    await live.page.screenshot({
      path: join(evidence, `02-${testCase.name}-completed.png`),
      fullPage: true,
    });
  }
  const before = read((db) => ({
    calls: db
      .prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='model.call_started'")
      .get().n,
    mutations: db.prepare('SELECT COUNT(*) AS n FROM workflow_workspace_mutation_journal').get().n,
    checkpoints: db.prepare('SELECT COUNT(*) AS n FROM workflow_checkpoints').get().n,
  }));
  await live.app.close();
  live = await launch();
  const after = read((db) => ({
    calls: db
      .prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='model.call_started'")
      .get().n,
    mutations: db.prepare('SELECT COUNT(*) AS n FROM workflow_workspace_mutation_journal').get().n,
    checkpoints: db.prepare('SELECT COUNT(*) AS n FROM workflow_checkpoints').get().n,
  }));
  assert.deepEqual(after, before);
  facts.restartIdempotent = { before, after };
  facts.noPublish = read(
    (db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM mission_events WHERE event_type LIKE '%deploy%' OR event_type LIKE '%git.push%' OR event_type LIKE '%release%'",
        )
        .get().n,
  );
  assert.equal(facts.noPublish, 0);
  writeFileSync(join(evidence, 'w22-facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(
    `W22_PACKAGED_SMOKE_OK cases=4 mixedVerification=true independentReview=true dynamicMutation=true crashZeroReplay=true noPublish=true evidence=${evidence}`,
  );
} finally {
  await live.app.close();
}
