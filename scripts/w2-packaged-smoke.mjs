import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const profile = join(root, '.test-data', `w2-packaged-${randomUUID()}`);
const workspace = join(profile, 'workspace');
const evidence = join(profile, 'evidence');
mkdirSync(workspace, { recursive: true });
mkdirSync(evidence, { recursive: true });
const databasePath = join(profile, 'data', 'cultivation.sqlite');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
function read(fn) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function poll(fn) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const result = read(fn);
    if (result) return result;
    await delay(80);
  }
  throw new Error('W2 durable fact timeout');
}
async function launch(extra = []) {
  const app = await electron.launch({
    executablePath,
    args: [
      '--gate1-fake-model',
      '--r3-fake-decision',
      '--r4-fake-routing',
      '--w2-fake-workflow',
      ...extra,
    ],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}
async function kill(app) {
  const child = app.process();
  const closed = new Promise((resolve) => child.once('close', resolve));
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await closed;
  // Windows may finish releasing SQLite file handles just after process close.
  const deadline = Date.now() + 5000;
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
const create = (page, definitionId) =>
  page.evaluate(
    (id) => window.cultivation.workflows.create({ definitionId: id, version: 1 }),
    definitionId,
  );
const advance = (page, id) => page.evaluate((id) => window.cultivation.workflows.advance(id), id);
const detail = (page, id) => page.evaluate((id) => window.cultivation.workflows.detail(id), id);
let live = await launch();
const facts = {};
try {
  await live.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspace);
  await live.page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  facts.teammate = await live.page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'W2 fixture Provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'W2 fixture template',
      providerId: provider.id,
      credentialId: null,
      modelId: 'w2-fixture-model',
    });
    const teammate = await api.teammates.create({
      name: 'W2 fixture executor',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: 'Use the declared fixture output.',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    await api.capability.saveBenchmark({
      runtimeProfileId: teammate.currentRuntimeProfileId,
      modelAlias: 'w2-fixture-model',
      dimension: 'GENERAL_REASONING',
      supported: true,
      normalizedScore: 80,
      rawScore: null,
      source: 'Test-only deterministic fixture',
      benchmark: 'W2 fixture',
      benchmarkVersion: '1',
      snapshotDate: '2026-10-01T00:00:00.000Z',
      sourceUrl: null,
      provenanceType: 'USER_ESTIMATE',
    });
    return teammate;
  });
  const completed = await advance(
    live.page,
    (await create(live.page, 'w2-fixture-contract')).run.id,
  );
  assert.equal(completed.run.state, 'COMPLETED');
  assert.equal(completed.validations[0].validatorVersion, 'w2-deterministic-v1');
  assert.equal(completed.operations[0].state, 'VERIFIED');
  facts.contract = completed;
  const released = await advance(
    live.page,
    (await create(live.page, 'test-only-builtin-contract')).run.id,
  );
  assert.equal(released.run.state, 'COMPLETED');
  assert.equal(released.version.definition.category, 'TEST_ONLY');
  const official = await advance(
    live.page,
    (await create(live.page, 'test-official-builtin-contract')).run.id,
  );
  assert.equal(official.run.state, 'COMPLETED');
  assert.equal(official.version.definition.source, 'BUILTIN');
  assert.equal(official.validations[0].contractId, 'test.w2.official');
  facts.officialInstall = official;
  const installSnapshot = () =>
    read((db) => ({
      contracts: db
        .prepare(
          'SELECT contract_id,contract_version,content_hash FROM workflow_artifact_contract_registry ORDER BY contract_id,contract_version',
        )
        .all(),
      releases: db
        .prepare('SELECT * FROM workflow_builtin_releases ORDER BY definition_id,version')
        .all(),
      versions: db
        .prepare(
          'SELECT definition_id,version,content_hash FROM workflow_versions ORDER BY definition_id,version',
        )
        .all(),
    }));
  const installed = installSnapshot();
  assert.equal(
    installed.releases.length,
    3,
    'Fixture and synthetic OFFICIAL are distinct registry packages',
  );
  const revision = await create(live.page, 'w2-fixture-revision');
  await advance(live.page, revision.run.id);
  const two = await advance(live.page, revision.run.id);
  assert.equal(two.traversals.length, 2);
  assert.equal(new Set(two.traversals.map((t) => t.edgeId)).size, 2);
  const bounded = await advance(live.page, revision.run.id);
  assert.equal(bounded.run.state, 'WAITING');
  assert.equal(
    bounded.steps.filter((s) => s.stepId === 'review').sort((a, b) => b.attempt - a.attempt)[0]
      .errorCode,
    'REVISION_BUDGET_EXHAUSTED',
  );
  facts.revision = bounded;
  const external = await advance(
    live.page,
    (await create(live.page, 'w2-fixture-external')).run.id,
  );
  assert.equal(external.run.state, 'WAITING');
  assert.equal(external.operations[0].state, 'UNKNOWN');
  facts.external = external;
  facts.externalCalls = read(
    (db) =>
      db
        .prepare(
          "SELECT count(*) n FROM mission_events WHERE mission_id=? AND event_type='model.call_started'",
        )
        .get(external.steps[0].missionId).n,
  );
  await live.app.close();
  live = await launch(['--w2-stop-applied']);
  const file = await create(live.page, 'w2-fixture-file');
  const waiting = await advance(live.page, file.run.id);
  assert.equal(waiting.run.waitReason, 'APPROVAL');
  const approval = read((db) =>
    db
      .prepare("SELECT id FROM approval_requests WHERE mission_id=? AND state='PENDING'")
      .get(waiting.steps[0].missionId),
  );
  await live.page.evaluate(
    (id) =>
      window.cultivation.missions.resolveApproval({ approvalId: id, decision: 'ALLOW_MISSION' }),
    approval.id,
  );
  await live.page.evaluate((id) => {
    void window.cultivation.workflows.advance(id);
  }, file.run.id);
  await poll((db) =>
    db
      .prepare(
        "SELECT * FROM workflow_step_operation_receipts WHERE workflow_run_id=? AND state='APPLIED'",
      )
      .get(file.run.id),
  );
  const callsBefore = read(
    (db) =>
      db
        .prepare(
          "SELECT count(*) n FROM mission_events WHERE mission_id=? AND event_type='model.call_started'",
        )
        .get(waiting.steps[0].missionId).n,
  );
  const fileBefore = readFileSync(join(workspace, 'w2-output.txt'), 'utf8');
  await kill(live.app);
  live = await launch();
  const recovered = await detail(live.page, file.run.id);
  assert.equal(recovered.run.state, 'COMPLETED');
  assert.equal(recovered.operations[0].state, 'VERIFIED');
  assert.equal(recovered.artifacts[0].kind, 'FILE');
  assert.equal(readFileSync(join(workspace, 'w2-output.txt'), 'utf8'), fileBefore);
  assert.equal(
    read(
      (db) =>
        db
          .prepare(
            "SELECT count(*) n FROM mission_events WHERE mission_id=? AND event_type='model.call_started'",
          )
          .get(waiting.steps[0].missionId).n,
    ),
    callsBefore,
  );
  facts.fileRecovery = recovered;
  await live.app.close();
  live = await launch(['--w2-stop-applied']);
  const mutation = await create(live.page, 'w2-fixture-workspace');
  const mutationWait = await advance(live.page, mutation.run.id);
  const mutationApproval = read((db) =>
    db
      .prepare("SELECT id FROM approval_requests WHERE mission_id=? AND state='PENDING'")
      .get(mutationWait.steps[0].missionId),
  );
  await live.page.evaluate(
    (id) =>
      window.cultivation.missions.resolveApproval({ approvalId: id, decision: 'ALLOW_MISSION' }),
    mutationApproval.id,
  );
  await live.page.evaluate((id) => {
    void window.cultivation.workflows.advance(id);
  }, mutation.run.id);
  await poll((db) =>
    db
      .prepare(
        "SELECT * FROM workflow_step_operation_receipts WHERE workflow_run_id=? AND state='APPLIED'",
      )
      .get(mutation.run.id),
  );
  await kill(live.app);
  live = await launch();
  const mutationRecovered = await detail(live.page, mutation.run.id);
  assert.equal(mutationRecovered.run.state, 'COMPLETED');
  assert.ok(mutationRecovered.operations[0].manifest[0].beforeHash);
  assert.equal(mutationRecovered.artifacts[0].kind, 'DIRECTORY');
  assert.equal(mutationRecovered.validations[0].contractId, 'test.w2.workspace');
  assert.equal(mutationRecovered.validations[0].valid, true);
  const executionEvidence = JSON.parse(mutationRecovered.artifacts[0].metadata.executionEvidence);
  assert.equal(executionEvidence[0].actorId, facts.teammate.id);
  assert.equal(executionEvidence[0].source, 'MISSION');
  facts.workspaceRecovery = mutationRecovered;
  const receiptCount = read(
    (db) => db.prepare('SELECT count(*) n FROM workflow_step_operation_audit').get().n,
  );
  const traversalCount = read(
    (db) => db.prepare('SELECT count(*) n FROM workflow_revision_traversals').get().n,
  );
  await live.app.close();
  live = await launch();
  assert.equal(
    read((db) => db.prepare('SELECT count(*) n FROM workflow_step_operation_audit').get().n),
    receiptCount,
  );
  assert.equal(
    read((db) => db.prepare('SELECT count(*) n FROM workflow_revision_traversals').get().n),
    traversalCount,
  );
  assert.equal((await detail(live.page, external.run.id)).operations[0].state, 'UNKNOWN');
  assert.equal(
    read(
      (db) =>
        db
          .prepare(
            "SELECT count(*) n FROM mission_events WHERE mission_id=? AND event_type='model.call_started'",
          )
          .get(external.steps[0].missionId).n,
    ),
    facts.externalCalls,
  );
  await navigateUi(live.page, '历练 Missions');
  await live.page.getByRole('link', { name: '工作流历练', exact: true }).click();
  await live.page.locator('.workflow-workspace').waitFor();
  await live.page.locator('.workflow-advanced-card > summary').click();
  await live.page.screenshot({
    path: join(evidence, '01-w2-workflow-foundation.png'),
    fullPage: true,
  });
  await live.page
    .getByRole('heading', { name: '副作用回执与修订预算', exact: true })
    .scrollIntoViewIfNeeded();
  assert.match(
    await live.page.locator('.workflow-advanced-content').innerText(),
    /WORKSPACE_MUTATION\s*·\s*VERIFIED/,
  );
  await live.page.screenshot({
    path: join(evidence, '02-w2-verified-operation.png'),
    fullPage: true,
  });
  facts.persistence = read((db) => ({
    migration: db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,
    contracts: db
      .prepare(
        'SELECT contract_id,contract_version,content_hash FROM workflow_artifact_contract_registry',
      )
      .all(),
    release: db.prepare('SELECT * FROM workflow_builtin_releases').all(),
    operationAudit: db
      .prepare('SELECT operation_id,event_type FROM workflow_step_operation_audit')
      .all(),
    traversals: db.prepare('SELECT * FROM workflow_revision_traversals').all(),
  }));
  assert.equal(facts.persistence.migration, 20);
  assert.deepEqual(
    installSnapshot(),
    installed,
    'Repeated process restarts must install identical packages without duplicating or changing facts',
  );
  facts.registryInstall = { snapshot: installed, identicalAfterRestarts: true };
  await live.app.close();
  const production = await electron.launch({
    executablePath,
    args: [],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: join(profile, 'production') },
    timeout: 30000,
  });
  live = { app: production, page: await production.firstWindow() };
  await live.page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  assert.deepEqual(
    await live.page.evaluate(async () =>
      (await window.cultivation.workflows.versions()).map((v) => v.definition.id),
    ),
    ['official.ai-news-video'],
    'Normal production bootstrap loads only the official news package, never test fixtures',
  );
  const normalDatabase = new Database(join(profile, 'production', 'data', 'cultivation.sqlite'), {
    readonly: true,
  });
  try {
    facts.productionBootstrap = {};
    for (const table of [
      'workflow_artifact_contract_registry',
      'workflow_builtin_releases',
      'workflow_versions',
    ]) {
      const count = normalDatabase.prepare(`SELECT count(*) n FROM ${table}`).get().n;
      assert.ok(count > 0);
      facts.productionBootstrap[table] = count;
    }
  } finally {
    normalDatabase.close();
  }
  writeFileSync(join(evidence, 'w2-facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(
    `W2_PACKAGED_SMOKE_OK contract=frozen,deterministic builtin=official-installer+isolated-test-fixture,idempotent production=official-news-v1 revision=edge+group,idempotent FILE+WORKSPACE=APPLIED-recovery,zero-replay EXTERNAL=UNKNOWN evidence=${evidence}`,
  );
} finally {
  await live.app.close();
}
