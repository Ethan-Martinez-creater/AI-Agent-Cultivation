import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import prettier from 'prettier';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const nonce = randomUUID();
const profile = join(root, '.test-data', `w31-packaged-${nonce}`);
const evidence = join(root, 'docs/evidence/w3-1-user-workflow-editor/packaged');
const executablePath = join(root, 'out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe');
const dbPath = join(profile, 'data/cultivation.sqlite');
const workspace = join(root, '.test-data', `w31-workspace-${nonce}`);
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'workflow-result.txt'), '用户原始文件\n', 'utf8');
mkdirSync(evidence, { recursive: true });
const facts = { profile: relative(root, profile), screenshots: [], acceptance: {} };
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;
const hash = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest('hex');
function read(fn) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function launch(fixture = false) {
  const app = await electron.launch({
    executablePath,
    args: fixture ? ['--gate1-fake-model', '--w31-editor-fixture', '--r4-fake-routing'] : [],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile },
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}
async function workflows(page) {
  await navigateUi(page, '历练 Missions');
  await page.getByRole('link', { name: '工作流历练', exact: true }).click();
}
async function screenshot(live, name, width) {
  await live.app.evaluate(
    ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
    width,
  );
  await live.page.waitForTimeout(150);
  const layout = await live.page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: window.document.documentElement.scrollWidth,
  }));
  assert.ok(
    layout.documentWidth <= layout.viewportWidth + 1,
    `${name}: horizontal window overflow`,
  );
  const file = `${name}-${width}.png`;
  await live.page.screenshot({ path: join(evidence, file), fullPage: true });
  facts.screenshots.push({
    file,
    width,
    ...layout,
    sha256: hash(readFileSync(join(evidence, file))),
  });
}
async function allSizes(live, name) {
  for (const width of [1440, 1180, 900]) await screenshot(live, name, width);
}
async function poll(fn) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const value = read(fn);
    if (value) return value;
    await delay(100);
  }
  throw new Error('W3.1 durable execution fact timeout');
}
async function createExecutor(page) {
  return page.evaluate(async () => {
    const api = window.cultivation;
    const p = await api.providers.create({
      name: '本地文本服务',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const r = await api.runtimes.create({
      name: '文本执行配置',
      providerId: p.id,
      credentialId: null,
      modelId: 'workflow-text',
    });
    const t = await api.teammates.create({
      name: '清岚',
      avatar: null,
      title: '工作流执行者',
      description: '',
      identityPrompt: '按当前步骤完成任务。',
      behaviorPrompt: '',
      currentRuntimeProfileId: r.id,
    });
    await api.capability.saveBenchmark({
      runtimeProfileId: t.currentRuntimeProfileId,
      modelAlias: 'workflow-text',
      dimension: 'GENERAL_REASONING',
      supported: true,
      normalizedScore: 80,
      rawScore: null,
      source: '用户配置',
      benchmark: '能力基准',
      benchmarkVersion: '1',
      snapshotDate: '2026-10-07T00:00:00.000Z',
      sourceUrl: null,
      provenanceType: 'USER_ESTIMATE',
    });
    return t;
  });
}
async function userList(page) {
  await page.getByTestId('workflow-tab-user').click();
  await page.getByTestId('workflow-library-user').waitFor();
}
async function drafts(page) {
  return page.evaluate(() => window.cultivation.workflowEditor.listDrafts());
}
async function expand(card) {
  if ((await card.locator('details').first().getAttribute('open')) === null)
    await card.locator('summary').first().click();
}
async function save(page) {
  await page.getByTestId('workflow-draft-save').click();
  await page.getByRole('status').filter({ hasText: '草稿已保存' }).waitFor();
}
async function publish(page) {
  await page.getByTestId('workflow-draft-publish').click();
  await page.getByTestId('workflow-editor').waitFor({ state: 'hidden' });
}
async function launchRunUi(page, definitionId, version) {
  await userList(page);
  const versions = await page.evaluate(() => window.cultivation.workflows.versions());
  const name = versions.find((v) => v.definition.id === definitionId && v.version === version)
    .definition.name;
  const card = page
    .getByTestId('workflow-version-card')
    .filter({ hasText: name })
    .filter({ hasText: `v${version}` });
  await card.getByRole('button', { name: '运行此版本', exact: true }).click();
  await page.getByRole('dialog', { name: '新建工作流运行' }).waitFor();
  await page.getByLabel('工作流版本', { exact: true }).selectOption(`${definitionId}::${version}`);
  await page.getByLabel(/^任务备注/).fill('本次整理公开交付内容，不增加权限。');
  await page.getByRole('button', { name: '创建运行', exact: true }).click();
  await page.getByRole('dialog', { name: '新建工作流运行' }).waitFor({ state: 'hidden' });
  return poll((db) =>
    db
      .prepare(
        'SELECT * FROM workflow_runs WHERE definition_id=? AND definition_version=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(definitionId, version),
  );
}
async function finishUi(page, runId) {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const run = read((db) =>
      db.prepare('SELECT state,wait_reason FROM workflow_runs WHERE id=?').get(runId),
    );
    if (run.state === 'COMPLETED') return run;
    assert.notEqual(run.state, 'FAILED', `USER Workflow failed: ${JSON.stringify(run)}`);
    const next = page.getByRole('button', {
      name: /^(开始执行|同步并检查等待状态|检查进度并继续)$/,
    });
    if ((await next.count()) && (await next.isEnabled())) await next.click();
    await delay(120);
  }
  throw new Error('Visible USER Workflow execution did not complete');
}
function runFacts(runId) {
  return read((db) => ({
    run: db
      .prepare('SELECT id,definition_id,definition_version,state FROM workflow_runs WHERE id=?')
      .get(runId),
    steps: db
      .prepare(
        'SELECT id,step_id,attempt,state,mission_id,mission_run_id FROM workflow_step_runs WHERE workflow_run_id=? ORDER BY created_at',
      )
      .all(runId),
    artifacts: db
      .prepare(
        'SELECT id,kind,content_hash,producer_step_run_id FROM workflow_artifacts WHERE workflow_run_id=?',
      )
      .all(runId),
    bindings: db
      .prepare(
        'SELECT step_run_id,artifact_id,key,role FROM workflow_artifact_bindings WHERE workflow_run_id=?',
      )
      .all(runId),
    receipts: db
      .prepare('SELECT artifact_id,valid FROM workflow_validation_receipts WHERE workflow_run_id=?')
      .all(runId),
    checkpoints: db
      .prepare('SELECT count(*) AS n FROM workflow_checkpoints WHERE workflow_run_id=?')
      .get(runId).n,
    usage: db
      .prepare(
        'SELECT u.teammate_id,u.runtime_profile_id,u.mission_id,u.run_id FROM usage_records u JOIN workflow_step_runs s ON s.mission_run_id=u.run_id WHERE s.workflow_run_id=?',
      )
      .all(runId),
    routing: db
      .prepare(
        'SELECT r.mission_id,r.receipt_id,r.assignment_json,r.context_json FROM routing_mission_assignments r JOIN workflow_step_runs s ON s.mission_id=r.mission_id WHERE s.workflow_run_id=?',
      )
      .all(runId)
      .map((row) => ({
        missionId: row.mission_id,
        receiptId: row.receipt_id,
        assignment: JSON.parse(row.assignment_json),
        workflowContext: JSON.parse(row.context_json).workflow,
      })),
    reviews: db
      .prepare(
        "SELECT a.id,a.content FROM workflow_artifacts a JOIN workflow_artifact_bindings b ON b.artifact_id=a.id WHERE a.workflow_run_id=? AND b.role='OUTPUT' AND b.key='review'",
      )
      .all(runId)
      .map((row) => ({ artifactId: row.id, ...JSON.parse(row.content) })),
  }));
}
const officialIds = ['official.ai-news-video', 'official.software-feature', 'official.research'];
const frozenReleases = JSON.parse(
  readFileSync(
    join(root, 'docs/evidence/r5-5-review-completion-advisory/frozen-hashes.json'),
    'utf8',
  ),
).releases;
function officialFacts() {
  return read((db) =>
    db
      .prepare(
        'SELECT v.definition_id, v.content_hash, b.manifest_hash FROM workflow_versions v JOIN workflow_builtin_releases b ON b.definition_id=v.definition_id AND b.version=v.version ORDER BY v.definition_id',
      )
      .all(),
  );
}

// The remaining acceptance uses the visible editor and launch controls. Assertions below
// query native SQLite independently of rendered labels; setup is the only direct model IPC.
let live = await launch();
try {
  const versions = await live.page.evaluate(() => window.cultivation.workflows.versions());
  assert.deepEqual(versions.map((v) => v.definition.id).sort(), [...officialIds].sort());
  assert.deepEqual(
    await live.page.evaluate(() => window.cultivation.workflowEditor.listDrafts()),
    [],
  );
  assert.deepEqual(await live.page.evaluate(() => window.cultivation.workflows.list()), []);
  assert.equal(
    read((db) => db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v),
    32,
  );
  assert.deepEqual(
    read((db) => db.prepare('PRAGMA foreign_key_check').all()),
    [],
  );
  facts.officialBefore = officialFacts();
  assert.deepEqual(
    facts.officialBefore,
    frozenReleases
      .map((release) => ({
        definition_id: release.definitionId,
        content_hash: release.contentHash,
        manifest_hash: release.manifestHash,
      }))
      .sort((a, b) => a.definition_id.localeCompare(b.definition_id)),
  );
  facts.acceptance.normalProduction = {
    officialVersions: 3,
    drafts: 0,
    runs: 0,
    schemaVersion: 32,
  };
} finally {
  await live.app.close();
}

live = await launch(true);
let mainDraft;
let v1;
let runA;
let runB;
let permissionRun;
try {
  facts.executor = await createExecutor(live.page);
  await workflows(live.page);
  await userList(live.page);
  await allSizes(live, 'my-workflows-empty');
  await live.page.getByTestId('workflow-create-draft').click();
  await live.page.getByTestId('workflow-name').fill('交付与审核');
  await live.page.getByTestId('workflow-category').fill('日常工作');
  await live.page.getByTestId('workflow-description').fill('先整理交付，再进行结构化审核。');
  await live.page.getByTestId('workflow-input-schema-add').click();
  await live.page.getByTestId('workflow-input-schema-field-key').fill('taskNote');
  await live.page.getByLabel('显示名称', { exact: true }).fill('任务备注');
  await live.page.getByLabel('输入字段 1 必填', { exact: true }).check();
  let cards = live.page.getByTestId('workflow-step-card');
  await expand(cards.nth(0));
  await cards.nth(0).getByTestId('workflow-step-title').fill('整理交付');
  await cards
    .nth(0)
    .getByTestId('workflow-step-objective')
    .fill('整理本次工作并提供简洁文本交付。');
  await cards.nth(0).getByLabel('步骤 1 使用输入 taskNote', { exact: true }).check();
  await live.page.getByTestId('workflow-step-add').click();
  await expand(cards.nth(1));
  await cards.nth(1).getByTestId('workflow-step-title').fill('准备背景');
  await cards
    .nth(1)
    .getByTestId('workflow-step-objective')
    .fill('准备简洁工作背景，不读取额外文件。');
  const oldOrder = await cards.evaluateAll((nodes) => nodes.map((n) => n.dataset.stepId));
  for (const index of [0, 1])
    if ((await cards.nth(index).locator('details').first().getAttribute('open')) !== null)
      await cards.nth(index).locator('summary').first().click();
  await cards
    .nth(1)
    .getByTestId('workflow-step-drag-handle')
    .dragTo(cards.nth(0).locator('summary').first());
  await live.page.getByRole('status').filter({ hasText: '步骤顺序已更新' }).waitFor();
  assert.deepEqual(
    await cards.evaluateAll((nodes) => nodes.map((n) => n.dataset.stepId)),
    [...oldOrder].reverse(),
  );
  await expand(cards.nth(0));
  await live.page.getByLabel('新增步骤类型').selectOption('REVIEW');
  await live.page.getByTestId('workflow-step-add').click();
  cards = live.page.getByTestId('workflow-step-card');
  assert.equal(await cards.count(), 4);
  await expand(cards.nth(2));
  await cards.nth(2).getByTestId('workflow-step-title').fill('审核交付');
  await cards
    .nth(2)
    .getByTestId('workflow-step-objective')
    .fill('审查已绑定交付；返回真实产物引用和结构化结论。');
  await cards.nth(2).getByLabel('步骤 3 分支 1 名称').fill('审核通过');
  await cards.nth(0).getByLabel('输出约定 1 约定编号').fill('user.background');
  await cards.nth(0).getByTestId('workflow-step-execution-constraint').selectOption('SOLO');
  await cards.nth(0).getByLabel('通用推理', { exact: true }).uncheck();
  await cards.nth(0).getByLabel('通用推理', { exact: true }).check();
  await cards.nth(2).getByLabel('步骤 3 退出条件', { exact: true }).selectOption('VALID_OUTPUTS');
  await save(live.page);
  mainDraft = (await drafts(live.page)).find((d) => d.content.name === '交付与审核');
  assert.deepEqual(
    mainDraft.content.steps.slice(0, 2).map((s) => s.id),
    [...oldOrder].reverse(),
  );
  assert.equal(
    mainDraft.content.edges.find((e) => e.fromStepId === mainDraft.content.entryStepId).toStepId,
    oldOrder[0],
  );
  assert.equal(mainDraft.content.steps[2].type, 'REVIEW');
  assert.equal(
    mainDraft.content.edges.filter((e) => e.fromStepId === mainDraft.content.steps[2].id).length,
    3,
  );
  await live.page.getByTestId('workflow-editor').locator('header').first().scrollIntoViewIfNeeded();
  await allSizes(live, 'editor');
  await cards.nth(0).getByTestId('workflow-step-objective').scrollIntoViewIfNeeded();
  await allSizes(live, 'expanded-step');
  await cards.nth(0).getByTestId('workflow-output-spec').scrollIntoViewIfNeeded();
  await allSizes(live, 'output-contract');
  await cards.nth(2).getByTestId('workflow-branch-row').first().scrollIntoViewIfNeeded();
  await allSizes(live, 'review-branch-contract');
  facts.acceptance.rendererDraft = {
    id: mainDraft.id,
    definitionId: mainDraft.definitionId,
    revision: mainDraft.revision,
    steps: mainDraft.content.steps.map((s) => ({ id: s.id, type: s.type, title: s.title })),
    realDrag: true,
    mainOwnedSequentialEdges: true,
  };
} finally {
  await live.app.close();
}
live = await launch(true);
try {
  assert.deepEqual(
    (await drafts(live.page)).find((d) => d.id === mainDraft.id),
    mainDraft,
  );
  await workflows(live.page);
  await userList(live.page);
  await live.page.getByTestId('workflow-draft-open').click();
  await publish(live.page);
  v1 = (await live.page.evaluate(() => window.cultivation.workflows.versions())).find(
    (v) => v.definition.id === mainDraft.definitionId,
  );
  assert.equal(v1.version, 1);
  assert.equal(v1.definition.source, 'USER');
  assert.ok(v1.steps.every((s) => s.effectType === 'NONE'));
  assert.equal(v1.validationPolicy, undefined);
  runA = await launchRunUi(live.page, v1.definition.id, 1);
  assert.equal(runA.state, 'READY');
  await userList(live.page);
  await live.page
    .getByTestId('workflow-version-card')
    .filter({ hasText: '交付与审核' })
    .getByRole('button', { name: '编辑为新草稿' })
    .click();
  await live.page.getByTestId('workflow-description').fill('第二版增加更明确的交付目标。');
  await expand(live.page.getByTestId('workflow-step-card').nth(0));
  await live.page
    .getByTestId('workflow-step-card')
    .nth(0)
    .getByTestId('workflow-step-objective')
    .fill('第二版：准备简洁背景并明确目标，不读取额外文件。');
  await publish(live.page);
  const versions = await live.page.evaluate(() => window.cultivation.workflows.versions());
  assert.deepEqual(
    versions.find((v) => v.definition.id === v1.definition.id && v.version === 1),
    v1,
  );
  assert.equal(
    versions
      .find((v) => v.definition.id === v1.definition.id && v.version === 2)
      .steps[0].objective.startsWith('第二版'),
    true,
  );
  await allSizes(live, 'published-versions');
  runB = await launchRunUi(live.page, v1.definition.id, 2);
  await finishUi(live.page, runB.id);
  facts.acceptance.runB = runFacts(runB.id);
  assert.equal(facts.acceptance.runB.steps.filter((s) => s.state === 'COMPLETED').length, 3);
  assert.equal(facts.acceptance.runB.steps.filter((s) => s.state === 'SKIPPED').length, 1);
  assert.equal(facts.acceptance.runB.artifacts.length, 3);
  assert.ok(facts.acceptance.runB.receipts.every((r) => r.valid === 1));
  assert.ok(
    facts.acceptance.runB.usage.every(
      (u) =>
        u.teammate_id === facts.executor.id &&
        u.runtime_profile_id === facts.executor.currentRuntimeProfileId,
    ),
  );
  assert.equal(facts.acceptance.runB.bindings.filter((b) => b.role === 'INPUT').length, 1);
  assert.equal(facts.acceptance.runB.routing.length, 3);
  assert.ok(
    facts.acceptance.runB.routing.every(
      (r) =>
        r.assignment.coordinatorTeammateId === facts.executor.id && r.assignment.mode === 'SOLO',
    ),
  );
  assert.equal(facts.acceptance.runB.reviews.length, 1);
  assert.deepEqual(
    facts.acceptance.runB.reviews[0].reviewedArtifactIds,
    facts.acceptance.runB.bindings.filter((b) => b.role === 'INPUT').map((b) => b.artifact_id),
  );
  assert.equal(
    read(
      (db) =>
        db.prepare('SELECT definition_version FROM workflow_runs WHERE id=?').get(runA.id)
          .definition_version,
    ),
    1,
  );
  await allSizes(live, 'completed-user-run');
  await live.page.getByTestId('workflow-tab-official').click();
  await live.page
    .getByTestId('workflow-version-card')
    .filter({ hasText: 'AI 资讯视频' })
    .getByTestId('workflow-copy-version')
    .click();
  await live.page.getByTestId('workflow-copy-confirm').click();
  await live.page.getByTestId('workflow-editor').waitFor();
  await live.page.getByTestId('workflow-name').fill('我的资讯制作流程');
  await save(live.page);
  const copied = (await drafts(live.page)).find((d) => d.content.name === '我的资讯制作流程');
  assert.ok(
    copied.definitionId.startsWith('user.') && copied.definitionId !== 'official.ai-news-video',
  );
  assert.ok(
    copied.content.steps.every((s) => !('executionRequirements' in s) && !('effectType' in s)),
  );
  await publish(live.page);
  const copiedVersion = (
    await live.page.evaluate(() => window.cultivation.workflows.versions())
  ).find((v) => v.definition.id === copied.definitionId);
  assert.equal(copiedVersion.definition.source, 'USER');
  assert.equal(copiedVersion.validationPolicy, undefined);
  assert.equal(copiedVersion.releaseMetadata, undefined);
  facts.acceptance.officialCopy = {
    definitionId: copied.definitionId,
    version: copiedVersion.version,
    source: copiedVersion.definition.source,
    officialAuthority: false,
  };
  const countBefore = read(
    (db) => db.prepare('SELECT count(*) AS n FROM workflow_versions').get().n,
  );
  const executionBeforeInvalid = read((db) => ({
    modelCalls: db
      .prepare("SELECT count(*) AS n FROM mission_events WHERE event_type='model.call_started'")
      .get().n,
    missions: db.prepare('SELECT count(*) AS n FROM missions').get().n,
    routingReceipts: db.prepare('SELECT count(*) AS n FROM routing_decision_receipts').get().n,
  }));
  facts.acceptance.invalidPublication = await live.page.evaluate(async () => {
    const api = window.cultivation.workflowEditor;
    const cases = [];
    for (const kind of ['cycle', 'dangling', 'invalid-contract', 'authority']) {
      let draft = await api.createDraft({
        name: {
          cycle: '检查步骤连接',
          dangling: '整理连接目标',
          'invalid-contract': '调整输出限制',
          authority: '个人流程草稿',
        }[kind],
      });
      const content = window.structuredClone(draft.content);
      content.steps[0].objective = '校验失败，不应发生执行。';
      if (kind === 'cycle') content.edges[0].toStepId = content.steps[0].id;
      if (kind === 'dangling') content.edges[0].toStepId = 'missing-step';
      if (kind === 'invalid-contract') content.steps[0].outputs[0].maxSizeBytes = 2_000_000;
      if (kind === 'authority') content.validationPolicy = 'research-integrity-v1';
      let rejected = false;
      try {
        draft = await api.saveDraft({ id: draft.id, expectedRevision: draft.revision, content });
        await api.publishDraft({ id: draft.id, expectedRevision: draft.revision });
      } catch {
        rejected = true;
      }
      cases.push({ kind, rejected, definitionId: draft.definitionId });
    }
    return cases;
  });
  assert.ok(facts.acceptance.invalidPublication.every((c) => c.rejected));
  assert.equal(
    read((db) => db.prepare('SELECT count(*) AS n FROM workflow_versions').get().n),
    countBefore,
  );
  const executionAfterInvalid = read((db) => ({
    modelCalls: db
      .prepare("SELECT count(*) AS n FROM mission_events WHERE event_type='model.call_started'")
      .get().n,
    missions: db.prepare('SELECT count(*) AS n FROM missions').get().n,
    routingReceipts: db.prepare('SELECT count(*) AS n FROM routing_decision_receipts').get().n,
  }));
  assert.deepEqual(executionAfterInvalid, executionBeforeInvalid);
  facts.acceptance.invalidZeroExecution = {
    before: executionBeforeInvalid,
    after: executionAfterInvalid,
  };
  facts.officialAfter = officialFacts();
  assert.deepEqual(facts.officialAfter, facts.officialBefore);
  await live.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await live.page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  permissionRun = await live.page.evaluate(async () => {
    const api = window.cultivation;
    let draft = await api.workflowEditor.createDraft({ name: '权限边界验收' });
    draft.content.steps[0].objective = '__W1_TOOL_WAIT__ 请求写入工作区文件。';
    draft = await api.workflowEditor.saveDraft({
      id: draft.id,
      expectedRevision: draft.revision,
      content: draft.content,
    });
    const version = await api.workflowEditor.publishDraft({
      id: draft.id,
      expectedRevision: draft.revision,
    });
    const run = await api.workflows.create({
      definitionId: version.definition.id,
      version: version.version,
    });
    return api.workflows.advance(run.run.id);
  });
  assert.equal(permissionRun.run.waitReason, 'APPROVAL');
  assert.equal(readFileSync(join(workspace, 'workflow-result.txt'), 'utf8'), '用户原始文件\n');
} finally {
  await live.app.close();
}
live = await launch(true);
try {
  await workflows(live.page);
  const waiting = await live.page.evaluate(
    (id) => window.cultivation.workflows.detail(id),
    permissionRun.run.id,
  );
  assert.equal(waiting.run.waitReason, 'APPROVAL');
  assert.equal(waiting.steps[0].missionRunId, permissionRun.steps[0].missionRunId);
  const approval = await live.page.evaluate(
    async (id) =>
      (await window.cultivation.missions.detail(id)).approvals.find((a) => a.state === 'PENDING'),
    waiting.steps[0].missionId,
  );
  await live.page.evaluate(
    (id) => window.cultivation.missions.resolveApproval({ approvalId: id, decision: 'DENIED' }),
    approval.id,
  );
  const deniedRun = await live.page.evaluate(
    (id) => window.cultivation.workflows.advance(id),
    waiting.run.id,
  );
  assert.equal(deniedRun.run.state, 'COMPLETED');
  assert.equal(readFileSync(join(workspace, 'workflow-result.txt'), 'utf8'), '用户原始文件\n');
  facts.acceptance.permission = {
    workflowRunId: waiting.run.id,
    missionRunId: waiting.steps[0].missionRunId,
    approvalId: approval.id,
    restartSameRun: true,
    decision: 'DENIED',
    fileUnchanged: true,
    finalState: deniedRun.run.state,
  };
  const run = await live.page.evaluate((id) => window.cultivation.workflows.detail(id), runA.id);
  assert.deepEqual(run.version, v1);
  const runButton = live.page
    .locator('.workflow-run-list')
    .getByRole('button')
    .filter({ hasText: '交付与审核' })
    .last();
  await runButton.click();
  await finishUi(live.page, runA.id);
  facts.acceptance.runA = runFacts(runA.id);
  assert.equal(facts.acceptance.runA.run.definition_version, 1);
  assert.equal(facts.acceptance.runA.run.state, 'COMPLETED');
  facts.restartBefore = read((db) => ({
    missions: db.prepare('SELECT count(*) AS n FROM missions').get().n,
    usage: db.prepare('SELECT count(*) AS n FROM usage_records').get().n,
    artifacts: db.prepare('SELECT count(*) AS n FROM workflow_artifacts').get().n,
    receipts: db.prepare('SELECT count(*) AS n FROM workflow_validation_receipts').get().n,
    drafts: db.prepare('SELECT count(*) AS n FROM workflow_user_drafts').get().n,
  }));
} finally {
  await live.app.close();
}
live = await launch();
try {
  const after = read((db) => ({
    missions: db.prepare('SELECT count(*) AS n FROM missions').get().n,
    usage: db.prepare('SELECT count(*) AS n FROM usage_records').get().n,
    artifacts: db.prepare('SELECT count(*) AS n FROM workflow_artifacts').get().n,
    receipts: db.prepare('SELECT count(*) AS n FROM workflow_validation_receipts').get().n,
    drafts: db.prepare('SELECT count(*) AS n FROM workflow_user_drafts').get().n,
  }));
  assert.deepEqual(after, facts.restartBefore);
  assert.deepEqual(officialFacts(), facts.officialBefore);
  assert.equal(
    read((db) => db.prepare('PRAGMA integrity_check').get().integrity_check),
    'ok',
  );
  assert.deepEqual(
    read((db) => db.prepare('PRAGMA foreign_key_check').all()),
    [],
  );
  await workflows(live.page);
  await userList(live.page);
  await allSizes(live, 'my-workflows-restarted');
  facts.acceptance.restart = {
    before: facts.restartBefore,
    after,
    noMissionOrModelReplay: true,
    frozenVersions: true,
    draftsPreserved: true,
  };
} finally {
  await live.app.close();
}
writeFileSync(
  join(evidence, 'facts.json'),
  await prettier.format(JSON.stringify(facts), { parser: 'json' }),
  'utf8',
);
console.log(`W31_PACKAGED_SMOKE_OK profile=${profile} evidence=${evidence}`);
