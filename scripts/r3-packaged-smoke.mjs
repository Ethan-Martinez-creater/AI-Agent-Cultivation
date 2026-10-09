import { navigateUi } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const userData = join(process.cwd(), '.test-data', `r3-packaged-${Date.now()}`);
mkdirSync(userData, { recursive: true });
const key = `jev-r3-smoke-${randomUUID()}`;
const app = await electron.launch({
  executablePath,
  args: ['--gate1-fake-model', '--r3-fake-decision'],
  timeout: 30_000,
  env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
});

let missionId;
let teammateId;
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  const before = await page.evaluate(() => window.cultivation.r3.getConfig());
  assert.deepEqual(
    { provider: before.provider, model: before.model, mode: before.mode, enabled: before.enabled },
    { provider: 'TYPESAFE', model: 'jev-1.13.0', mode: 'SHADOW', enabled: false },
  );
  assert.equal(before.configured, false);

  await app.evaluate(({ clipboard }, plaintext) => clipboard.writeText(plaintext), key);
  const config = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
  assert.equal(config.keySource, 'SAFE_STORAGE');
  assert.equal(JSON.stringify(config).includes(key), false);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
  assert.equal((await page.evaluate(() => window.cultivation.r3.testConnection())).ok, true);
  assert.equal((await page.evaluate(() => window.cultivation.r3.setEnabled(true))).enabled, true);

  const created = await page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'R3 smoke model provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'R3 smoke runtime',
      providerId: provider.id,
      credentialId: null,
      modelId: 'r3-fixture-model',
    });
    const teammate = await api.teammates.create({
      name: 'R3 selected coordinator',
      avatar: null,
      title: '编程道友',
      description: '',
      identityPrompt: 'Be concise.',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    const mission = await api.missions.create({
      title: 'R3 shadow only',
      objective: '用 Python 修复一个小程序；不要更换已指定的道友。',
      coordinatorTeammateId: teammate.id,
    });
    return { mission, teammate };
  });
  missionId = created.mission.id;
  teammateId = created.teammate.id;
  assert.equal(created.mission.coordinatorTeammateId, teammateId);
  assert.equal(created.mission.state, 'DRAFT');

  await page.waitForFunction(
    async (id) => (await window.cultivation.r3.listObservations(id)).length === 4,
    missionId,
    { timeout: 20_000 },
  );
  const observations = await page.evaluate(
    (id) => window.cultivation.r3.listObservations(id),
    missionId,
  );
  assert.deepEqual(observations.map((observation) => observation.decisionType).sort(), [
    'COLLABORATION_NEED',
    'REVIEW_NEED',
    'TASK_CAPABILITY',
    'TEAMMATE_FIT',
  ]);
  assert.ok(observations.every((observation) => observation.status === 'SUCCESS'));
  assert.ok(observations.every((observation) => observation.model === 'jev-1.13.0'));
  const fit = observations.find((observation) => observation.decisionType === 'TEAMMATE_FIT');
  assert.equal(fit.actualAction, teammateId);
  assert.equal(
    (await page.evaluate((id) => window.cultivation.missions.detail(id), missionId)).mission
      .coordinatorTeammateId,
    teammateId,
  );

  await navigateUi(page, '设置 Settings');
  await page.getByRole('heading', { name: '设置', level: 1, exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Jev 观察', exact: true }).click();
  await page.locator('.shadow-diagnostics > summary').click();
  await page.getByRole('heading', { name: '运行信息', exact: true }).waitFor();
  await page.locator('.shadow-privacy > summary').click();
  const privacy = page.getByRole('note', { name: 'Cloud Shadow 隐私说明' });
  assert.match(await privacy.innerText(), /Benchmark 能力档位/);
  assert.match(await privacy.innerText(), /不发送 Credential 或 API Key/);

  const db = new Database(join(userData, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    const configRow = db
      .prepare(
        'SELECT api_key_ciphertext AS ciphertext, enabled, mode FROM decision_provider_configs',
      )
      .get();
    assert.equal(configRow.enabled, 1);
    assert.equal(configRow.mode, 'SHADOW');
    assert.ok(configRow.ciphertext instanceof Buffer);
    assert.equal(configRow.ciphertext.includes(Buffer.from(key)), false);
    const receipts = db
      .prepare('SELECT * FROM decision_receipts WHERE mission_id = ? ORDER BY decision_type')
      .all(missionId);
    assert.equal(receipts.length, 4);
    assert.ok(receipts.every((receipt) => receipt.mode === 'SHADOW'));
    assert.ok(receipts.every((receipt) => /^[a-f0-9]{64}$/.test(receipt.state_hash)));
    assert.ok(receipts.every((receipt) => !JSON.stringify(receipt).includes(key)));
    const attempts = db
      .prepare('SELECT * FROM decision_shadow_attempts WHERE mission_id = ?')
      .all(missionId);
    assert.equal(attempts.length, 4);
    assert.ok(attempts.every((attempt) => attempt.status === 'SUCCESS' && attempt.receipt_id));
    const missionRow = db
      .prepare('SELECT state, coordinator_teammate_id FROM missions WHERE id = ?')
      .get(missionId);
    assert.deepEqual(missionRow, { state: 'DRAFT', coordinator_teammate_id: teammateId });
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM mission_runs WHERE mission_id = ?').get(missionId).n,
      0,
    );
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM collaboration_requests WHERE mission_id = ?')
        .get(missionId).n,
      0,
    );
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM external_work_requests WHERE mission_id = ?')
        .get(missionId).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      32,
    );
  } finally {
    db.close();
  }
  console.log('R3_PACKAGED_SMOKE_OK shadow=4 receipts=4 credential=encrypted mission_unchanged=ok');
} finally {
  await app.close();
}

const failedApp = await electron.launch({
  executablePath,
  args: ['--gate1-fake-model', '--r3-fake-decision-error'],
  timeout: 30_000,
  env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
});
try {
  const page = await failedApp.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  const failedMission = await page.evaluate(
    (coordinatorTeammateId) =>
      window.cultivation.missions.create({
        title: 'R3 provider fallback',
        objective: 'This mission must stay DRAFT if the decision provider fails.',
        coordinatorTeammateId,
      }),
    teammateId,
  );
  assert.equal(failedMission.state, 'DRAFT');
  assert.equal(failedMission.coordinatorTeammateId, teammateId);
  await page.waitForFunction(
    async (id) => (await window.cultivation.r3.listObservations(id)).length === 4,
    failedMission.id,
    { timeout: 20_000 },
  );
  const failures = await page.evaluate(
    (id) => window.cultivation.r3.listObservations(id),
    failedMission.id,
  );
  assert.ok(
    failures.every(
      (observation) =>
        observation.status === 'ERROR' && observation.errorCode === 'PROVIDER_UNAVAILABLE',
    ),
  );
  const db = new Database(join(userData, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM decision_receipts WHERE mission_id = ?')
        .get(failedMission.id).n,
      0,
    );
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM decision_shadow_attempts WHERE mission_id = ?')
        .get(failedMission.id).n,
      4,
    );
    assert.equal(
      db.prepare('SELECT state FROM missions WHERE id = ?').get(failedMission.id).state,
      'DRAFT',
    );
  } finally {
    db.close();
  }
  console.log('R3_PACKAGED_FALLBACK_OK provider_error=4 receipts=0 mission_unchanged=ok');
} finally {
  await failedApp.close();
}
