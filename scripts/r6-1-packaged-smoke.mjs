import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import prettier from 'prettier';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const profile = join(root, '.test-data', `r61-packaged-${randomUUID()}`);
const workspace = join(profile, 'workspace');
const evidence = join(root, 'docs/evidence/r6-1-alpha-stabilization/packaged');
const dbPath = join(profile, 'data/cultivation.sqlite');
const executablePath = join(root, 'out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe');
mkdirSync(workspace, { recursive: true });
mkdirSync(evidence, { recursive: true });
for (let i = 1; i <= 17; i++)
  writeFileSync(join(workspace, `s${i}.txt`), `第${i}份既有成果`, 'utf8');
const facts = {
  stage: 'R6.1',
  profile: relative(root, profile),
  normalProduction: true,
  live: 'NOT RUN',
  screenshots: [],
};
const read = (fn) => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const counts = () =>
  read((db) =>
    Object.fromEntries(
      [
        'workflow_runs',
        'workflow_import_confirmations',
        'workflow_import_artifacts',
        'workflow_checkpoints',
        'missions',
        'mission_runs',
        'usage_records',
        'experience_events',
        'permission_rules',
        'approval_requests',
      ].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]),
    ),
  );
async function launch() {
  const started = globalThis.performance.now();
  const app = await electron.launch({
    executablePath,
    args: [],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile },
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    return { app, page, startupMs: globalThis.performance.now() - started };
  } catch (error) {
    await app.close();
    throw error;
  }
}
async function capture(live, name) {
  for (const width of [1440, 1180, 900]) {
    await live.app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    await live.page.waitForTimeout(180);
    const layout = await live.page.evaluate(() => ({
      viewport: window.innerWidth,
      document: window.document.documentElement.scrollWidth,
    }));
    assert.ok(layout.document <= layout.viewport + 1, `${name} overflow ${width}`);
    const file = `${name}-${width}.png`;
    await live.page.screenshot({ path: join(evidence, file), fullPage: true });
    facts.screenshots.push({
      file,
      width,
      ...layout,
      sha256: createHash('sha256')
        .update(readFileSync(join(evidence, file)))
        .digest('hex'),
    });
  }
}
async function choose(live, files) {
  await live.app.evaluate(
    ({ dialog }, { workspace, files }) => {
      let index = 0;
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: [options.properties.includes('openDirectory') ? workspace : files[index++]],
      });
      dialog.showMessageBox = async () => ({ response: 1 });
    },
    { workspace, files },
  );
}
let live;
try {
  live = await launch();
  facts.startupMs = live.startupMs;
  facts.production = read((db) => ({
    migrations: db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n,
    builtin: db
      .prepare(
        'SELECT v.definition_id,v.content_hash,r.manifest_hash FROM workflow_builtin_releases r JOIN workflow_versions v ON v.definition_id=r.definition_id AND v.version=r.version ORDER BY v.definition_id',
      )
      .all(),
    testOnlyVersions: db
      .prepare("SELECT COUNT(*) n FROM workflow_versions WHERE version_json LIKE '%TEST_ONLY%'")
      .get().n,
    jobs: db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n,
    missions: db.prepare('SELECT COUNT(*) n FROM missions').get().n,
  }));
  assert.equal(facts.production.migrations, 32);
  assert.equal(facts.production.builtin.length, 3);
  assert.equal(facts.production.testOnlyVersions, 0);
  assert.equal(facts.production.jobs, 0);
  assert.equal(facts.production.missions, 0);
  await capture(live, 'home-empty');
  facts.forgedIpc = await live.app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const handler = ipcMain._invokeHandlers.get('workflowImports:prepare');
    const outcomes = [];
    for (const event of [
      { sender: {}, senderFrame: window.webContents.mainFrame },
      { sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } },
      { sender: window.webContents, senderFrame: null },
    ]) {
      try {
        await handler(event, { definitionId: 'official.research', version: 1 });
        outcomes.push('UNEXPECTED');
      } catch (error) {
        outcomes.push(String(error.message));
      }
    }
    return outcomes;
  });
  assert.ok(facts.forgedIpc.every((value) => value === 'IPC sender denied'));
  await choose(live, []);
  await live.page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  const frozenInputs = { topic: '来源与输入验证', count: 2, mode: 'A' };
  const version = await live.page.evaluate(async () => {
    const api = window.cultivation.workflowEditor;
    const draft = await api.createDraft({ name: '有界成果导入' });
    const content = draft.content;
    const template = content.steps[0];
    content.inputSchema = {
      type: 'object',
      properties: {
        topic: { type: 'string', minLength: 1, maxLength: 40 },
        count: { type: 'number', minimum: 1, maximum: 3, integer: true },
        mode: { type: 'enum', values: ['A', 'B'] },
      },
      required: ['topic', 'count', 'mode'],
    };
    const ids = Array.from({ length: 32 }, (_, i) => `s${i + 1}`);
    content.entryStepId = 's1';
    content.steps = ids.map((id, i) => ({
      ...window.structuredClone(template),
      id,
      title: `成果${i + 1}`,
      objective: '核验声明的有界输入成果',
      workflowInputKeys: ['topic'],
      inputs: i
        ? [{ key: 'previous', fromStepId: ids[i - 1], outputKey: ids[i - 1], required: true }]
        : [],
      outputs: [{ ...template.outputs[0], key: id }],
    }));
    content.edges = ids.map((id, i) => ({
      id: `${id}-next`,
      fromStepId: id,
      toStepId: ids[i + 1] ?? null,
      branch: 'NEXT',
      condition: { type: 'ALWAYS' },
    }));
    content.finalOutputs = [
      {
        key: 'result',
        fromStepId: 's32',
        outputKey: 's32',
        required: true,
        description: '最终成果',
      },
    ];
    const saved = await api.saveDraft({ id: draft.id, expectedRevision: draft.revision, content });
    return api.publishDraft({ id: saved.id, expectedRevision: saved.revision });
  });
  const prepare = (inputs) =>
    live.page.evaluate(
      ({ id, inputs }) =>
        window.cultivation.workflowImports.prepare({ definitionId: id, version: 1, inputs }),
      { id: version.definition.id, inputs },
    );
  for (const invalid of [
    {},
    { ...frozenInputs, mode: 'C' },
    { ...frozenInputs, count: 4 },
    { ...frozenInputs, forged: 'extra' },
  ])
    await assert.rejects(() => prepare(invalid));
  let proposal = await prepare(frozenInputs);
  await choose(
    live,
    Array.from({ length: 17 }, (_, i) => join(workspace, `s${i + 1}.txt`)),
  );
  for (let i = 0; i < 16; i++)
    proposal = await live.page.evaluate(
      (id) => window.cultivation.workflowImports.selectSource(id),
      proposal.id,
    );
  assert.equal(proposal.sources.length, 16);
  assert.equal(proposal.resolution.suggestedCompletedSteps.length, 16);
  assert.equal(proposal.resolution.suggestedCurrentStep, 's17');
  const before = counts();
  await assert.rejects(() =>
    live.page.evaluate((id) => window.cultivation.workflowImports.selectSource(id), proposal.id),
  );
  assert.deepEqual(counts(), before);
  const original = globalThis.structuredClone(proposal);
  const invalid = await live.page.evaluate(
    (p) =>
      window.cultivation.workflowImports.revise({
        proposalId: p.id,
        revision: p.revision,
        completedStepIds: [...p.resolution.suggestedCompletedSteps, 's17'],
        currentStepId: 's18',
        bindings: [
          ...p.resolution.candidateArtifactBindings,
          { stepId: 's17', outputKey: 's17', sourceId: p.sources[0].id },
        ],
      }),
    proposal,
  );
  assert.equal(invalid.validationStatus, 'INVALID');
  await assert.rejects(() =>
    live.page.evaluate(
      (p) => window.cultivation.workflowImports.confirm({ proposalId: p.id, revision: p.revision }),
      invalid,
    ),
  );
  assert.deepEqual(counts(), before);
  proposal = await live.page.evaluate(
    ({ original, invalid }) =>
      window.cultivation.workflowImports.revise({
        proposalId: original.id,
        revision: invalid.revision,
        completedStepIds: original.resolution.suggestedCompletedSteps,
        currentStepId: original.resolution.suggestedCurrentStep,
        bindings: original.resolution.candidateArtifactBindings,
      }),
    { original, invalid },
  );
  const detail = await live.page.evaluate(
    (p) => window.cultivation.workflowImports.confirm({ proposalId: p.id, revision: p.revision }),
    proposal,
  );
  assert.deepEqual(detail.run.inputSnapshot, frozenInputs);
  assert.equal(detail.steps.filter((s) => s.completionOrigin === 'IMPORTED_CONFIRMED').length, 16);
  assert.equal(detail.artifacts.length, 16);
  assert.equal(detail.checkpoints.length, 16);
  const after = counts();
  for (const table of [
    'missions',
    'mission_runs',
    'usage_records',
    'experience_events',
    'permission_rules',
    'approval_requests',
  ])
    assert.equal(after[table], before[table]);
  facts.capacity = {
    sourcesAccepted: 16,
    source17Rejected: true,
    totalSteps: 32,
    reachableImportedPrefix: 16,
    formalPrefixArrayBound: 32,
    structuralPrefixBound: 31,
    reason:
      'Distinct evidence per output and 16 source cap; a following executable Step is required.',
    reusedSourceRejected: true,
    partialRunCreatedOnFailure: false,
    inputSnapshot: detail.run.inputSnapshot,
    before,
    after,
  };
  // Bounded reproducible scale scenario; these are READY intent records, never execution facts.
  facts.volume = await live.page.evaluate(
    async ({ id, inputs }) => {
      const started = window.performance.now();
      const bridge = (await window.cultivation.teammates.list()).find(
        (t) => t.systemKind === 'HUMAN_BRIDGE',
      );
      for (let i = 0; i < 300; i++)
        await window.cultivation.missions.create({
          title: `待办历练 ${i + 1}`,
          objective: '保留为尚未启动的用户任务，不进行模型或外部工作调用。',
          coordinatorTeammateId: bridge.id,
        });
      for (let i = 0; i < 120; i++)
        await window.cultivation.workflows.create({ definitionId: id, version: 1, inputs });
      for (let i = 0; i < 100; i++)
        await window.cultivation.workflowEditor.createDraft({ name: `待编辑工作流 ${i + 1}` });
      const queryStart = window.performance.now();
      const runs = await window.cultivation.workflows.list();
      const drafts = await window.cultivation.workflowEditor.listDrafts();
      const proposals = await window.cultivation.workflowImports.list();
      const missions = await window.cultivation.missions.list();
      return {
        createMs: queryStart - started,
        queryAndIpcMs: window.performance.now() - queryStart,
        runs: runs.length,
        drafts: drafts.length,
        proposals: proposals.length,
        missions: missions.length,
      };
    },
    { id: version.definition.id, inputs: frozenInputs },
  );
  assert.equal(facts.volume.runs, 121);
  assert.equal(facts.volume.drafts, 100);
  assert.equal(facts.volume.missions, 300);
  await navigateUi(live.page, '历练 Missions');
  const missionTabs = live.page.getByRole('tablist', { name: '筛选历练' });
  await missionTabs.getByRole('tab').first().focus();
  await live.page.keyboard.press('End');
  assert.equal(await missionTabs.getByRole('tab').last().getAttribute('aria-selected'), 'true');
  await capture(live, 'mission-volume');
  await live.page.getByRole('link', { name: '工作流历练', exact: true }).click();
  const tabs = live.page.getByRole('tablist', { name: '工作流管理' });
  await tabs.getByRole('tab').first().focus();
  await live.page.keyboard.press('End');
  assert.equal(await tabs.getByRole('tab').last().getAttribute('aria-selected'), 'true');
  await live.page.keyboard.press('ArrowLeft');
  assert.equal(
    await live.page.getByTestId('workflow-tab-official').getAttribute('aria-selected'),
    'true',
  );
  await live.page.keyboard.press('Home');
  assert.equal(
    await live.page.getByTestId('workflow-tab-runs').getAttribute('aria-selected'),
    'true',
  );
  await capture(live, 'workflow-volume');
  facts.keyboard = { missionsEnd: true, workflowsEndLeftHome: true };
  const stable = counts();
  await live.app.close();
  live = await launch();
  assert.deepEqual(counts(), stable);
  const restored = await live.page.evaluate(
    (p) => window.cultivation.workflowImports.confirm({ proposalId: p.id, revision: p.revision }),
    proposal,
  );
  assert.equal(restored.run.id, detail.run.id);
  assert.deepEqual(restored.run.inputSnapshot, frozenInputs);
  assert.deepEqual(counts(), stable);
  facts.restart = {
    originalRun: restored.run.id,
    snapshotIdentical: true,
    factCountsIdentical: true,
    noMissionOrSideEffectReplay: true,
  };
  facts.integrity = read((db) => ({
    fk: db.pragma('foreign_key_check'),
    integrity: db.pragma('integrity_check'),
    steps: db.prepare('SELECT COUNT(*) n FROM workflow_step_runs').get().n,
  }));
  assert.deepEqual(facts.integrity.fk, []);
  assert.deepEqual(facts.integrity.integrity, [{ integrity_check: 'ok' }]);
  console.log(
    'R61_PACKAGED_SMOKE_OK production=normal capacity=16_of_32 required_inputs=frozen forged_ipc=denied keyboard=operable restart=no_replay live=NOT_RUN',
  );
} finally {
  if (live?.app) await live.app.close();
  writeFileSync(
    join(evidence, 'facts.json'),
    await prettier.format(JSON.stringify(facts), {
      ...(await prettier.resolveConfig(join(evidence, 'facts.json'))),
      parser: 'json',
    }),
    'utf8',
  );
}
