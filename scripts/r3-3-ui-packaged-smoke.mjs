import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const userData = join(root, '.test-data', `r3-3-ui-${randomUUID()}`);
const images = join(userData, 'screenshots');
mkdirSync(images, { recursive: true });
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const launch = () =>
  electron.launch({
    executablePath,
    args: ['--gate1-fake-model'],
    timeout: 30000,
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
  });
const app = await launch();
let fixtures;
let conversationId;
const measurements = [];
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  const nav = page.getByRole('navigation', { name: '主导航' });
  assert.deepEqual(await nav.getByRole('link').allTextContents(), [
    '首页',
    '道友',
    '队伍',
    '历练',
    '记忆',
    '设置',
  ]);
  await page.getByText('开始使用', { exact: true }).waitFor();
  await page.screenshot({ path: join(images, 'home-empty.png') });
  await page.getByRole('button', { name: '折叠导航' }).click();
  await nav.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置 Settings' }).waitFor();
  await page.getByRole('button', { name: '展开导航' }).click();

  fixtures = await page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'UI fixture Provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'UI model template',
      providerId: provider.id,
      credentialId: null,
      modelId: 'ui-fixed-model',
    });
    const create = (name) =>
      api.teammates.create({
        name,
        avatar: null,
        title: null,
        description: '',
        identityPrompt: '',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
    const a = await create('青岚 UI');
    const b = await create('明衡 UI');
    await api.capability.saveBenchmark({
      runtimeProfileId: a.currentRuntimeProfileId,
      modelAlias: 'ui-fixed-model',
      dimension: 'CODING',
      supported: true,
      normalizedScore: 86,
      rawScore: null,
      source: 'UI smoke fixture',
      benchmark: 'Deterministic fixture',
      benchmarkVersion: '1',
      snapshotDate: '2026-09-30T00:00:00.000Z',
      sourceUrl: null,
      provenanceType: 'USER_ESTIMATE',
    });
    const skill = await api.skills.create({
      name: 'UI 审查功法',
      description: '',
      instructions: 'Explain concisely.',
      tags: ['review'],
    });
    const party = await api.parties.create({
      name: '青岚小队 UI',
      description: '',
      type: 'FIXED',
      coordinatorTeammateId: a.id,
      memberTeammateIds: [a.id, b.id],
    });
    const solo = await api.missions.create({
      title: '自由历练 UI',
      objective: 'Normal deterministic response',
      coordinatorTeammateId: a.id,
    });
    await api.missions.ready(solo.id);
    await api.missions.start({ missionId: solo.id, approvalFixture: false });
    const collaboration = await api.missions.create({
      title: '等待协作审批 UI',
      objective: 'Independent perspective',
      coordinatorTeammateId: a.id,
      partyId: party.id,
      mode: 'CONSULTATION',
    });
    await api.missions.ready(collaboration.id);
    await api.missions.start({ missionId: collaboration.id, approvalFixture: false });
    return { a, b, runtime, party, solo, collaboration, skill };
  });

  await navigateUi(page, '道友 Teammates');
  await page.locator('.teammate-roster-select').filter({ hasText: fixtures.a.name }).click();
  await page.locator('.teammate-benchmark-score').filter({ hasText: '86' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /切换 Runtime/ }).count(), 0);
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.locator('.teammate-profile-status [data-availability="AVAILABLE"]').waitFor();
  await page.locator('.teammate-secondary-view > summary').filter({ hasText: 'Skills' }).click();
  await page.getByRole('button', { name: '分配给此道友', exact: true }).click();
  assert.equal(await page.getByLabel('已停用').isChecked(), false);
  await page.getByLabel('已停用').click();
  await page.getByLabel('已启用').waitFor();
  assert.equal(await page.getByLabel('已启用').isChecked(), true);
  await page.getByLabel('已启用').click();
  await page.getByLabel('已停用').waitFor();
  assert.equal(await page.getByLabel('已停用').isChecked(), false);
  await page.getByLabel('已停用').click();
  await page.getByLabel('已启用').waitFor();
  await page.screenshot({ path: join(images, 'teammate-benchmark-skills.png') });
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await page.getByRole('button', { name: '新建 Conversation', exact: true }).first().click();
  await page.getByLabel('消息', { exact: true }).fill('PING');
  await page.getByRole('button', { name: '发送' }).click();
  await page.locator('.assistant-message .message-bubble').filter({ hasText: 'PONG' }).waitFor();
  const conversations = await page.evaluate(
    (id) => window.cultivation.chat.listConversations(id),
    fixtures.a.id,
  );
  conversationId = conversations[0].id;
  await page.screenshot({ path: join(images, 'chat-stream.png') });

  await navigateUi(page, '记忆 Memory');
  await page.getByLabel('当前道友（记忆归属）').selectOption(fixtures.a.id);
  await page.getByLabel('摘要', { exact: true }).fill('UI A 私有记忆');
  await page.getByLabel('内容', { exact: true }).fill('UI_A_PRIVATE_MEMORY');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.locator('.memory-card').filter({ hasText: 'UI_A_PRIVATE_MEMORY' }).waitFor();
  await page.getByLabel('当前道友（记忆归属）').selectOption(fixtures.b.id);
  await page.waitForFunction(
    () => !window.document.querySelector('.loading-card')?.textContent?.includes('记忆'),
  );
  assert.equal(
    await page.locator('.memory-card').filter({ hasText: 'UI_A_PRIVATE_MEMORY' }).count(),
    0,
  );

  await navigateUi(page, '设置 Settings');
  await page.getByRole('tab', { name: 'Benchmark', exact: true }).click();
  await page.getByLabel('Runtime / Model').selectOption(fixtures.a.currentRuntimeProfileId);
  await page.getByLabel('能力维度').selectOption('TOOL_USE');
  await page.getByLabel('归一化分数 0–100').fill('0');
  await page.getByLabel('来源', { exact: true }).fill('UI manual fixture');
  await page.getByLabel('Benchmark 名称').fill('UI zero score');
  await page.getByRole('button', { name: '保存该维度事实', exact: true }).click();
  await page
    .locator('.r1-dimension-list .data-row')
    .filter({ hasText: 'TOOL_USE' })
    .filter({ hasText: '0 / 100' })
    .waitFor();
  const savedBenchmark = await page.evaluate(
    (runtimeId) => window.cultivation.capability.benchmarks(runtimeId),
    fixtures.a.currentRuntimeProfileId,
  );
  assert.ok(
    savedBenchmark.some(
      (fact) => fact.dimension === 'TOOL_USE' && fact.supported && fact.normalizedScore === 0,
    ),
  );
  await page.screenshot({ path: join(images, 'benchmark-manual-zero.png') });

  await navigateUi(page, '历练 Missions');
  await page.locator('button.mission-list-item').filter({ hasText: '等待协作审批 UI' }).click();
  await page.getByRole('heading', { name: '执行 Timeline' }).waitFor();
  await page.screenshot({ path: join(images, 'mission-pending.png') });
  await page.getByRole('button', { name: '批准并继续', exact: true }).first().click();
  await page.waitForFunction(
    (id) =>
      window.cultivation.missions.detail(id).then((detail) => detail.mission.state === 'COMPLETED'),
    fixtures.collaboration.id,
  );

  for (const [width, height] of [
    [1180, 780],
    [1440, 900],
    [900, 600],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    for (const name of [
      '洞府 Home',
      '道友 Teammates',
      '队伍 Parties',
      '历练 Missions',
      '记忆 Memory',
      '设置 Settings',
      '功法 Skills',
      '法宝 Tools',
      '灵石 Usage',
      '本尊待办 Human Bridge',
    ]) {
      await navigateUi(page, name);
      await page.locator('main h1').waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      const result = await page.evaluate(() => {
        const document = window.document;
        const getComputedStyle = window.getComputedStyle.bind(window);
        const fields = [
          ...document.querySelectorAll('input:not([type="checkbox"]),select,textarea'),
        ].filter((field) => field.getBoundingClientRect().width > 0);
        const unlabelled = fields
          .filter((field) => !field.labels?.length)
          .map((field) => field.outerHTML.slice(0, 120));
        return {
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          background: getComputedStyle(document.querySelector('main')).backgroundColor,
          titleSize: getComputedStyle(document.querySelector('main h1')).fontSize,
          placeholders: document.querySelectorAll('[placeholder]').length,
          unlabelled,
        };
      });
      assert.ok(
        result.scrollWidth <= result.innerWidth + 1,
        JSON.stringify({ name, width, ...result }),
      );
      assert.equal(result.background, 'rgb(255, 255, 255)');
      assert.equal(result.titleSize, '20px');
      assert.equal(result.placeholders, 0, name);
      assert.deepEqual(result.unlabelled, [], name);
      measurements.push({ name, width, height, ...result });
      if (
        width === 1180 ||
        (width === 900 &&
          ['道友 Teammates', '历练 Missions', '本尊待办 Human Bridge'].includes(name))
      ) {
        await page.screenshot({ path: join(images, name.split(' ')[1] + '-' + width + '.png') });
      }
    }
  }
  await navigateUi(page, '道友 Teammates');
  await page.getByRole('button', { name: /新建道友/ }).click();
  const create = page.locator('form.teammate-form');
  for (const field of await create.locator('input[type="text"],input:not([type]),textarea').all()) {
    assert.equal(await field.inputValue(), '', 'create fields must not contain example text');
  }
  await create.getByLabel('名称', { exact: true }).fill('第三位 UI');
  await create.getByLabel('模型（创建后固定）').selectOption(fixtures.runtime.id);
  await create.getByRole('button', { name: '创建道友', exact: true }).click();
  await page.getByRole('heading', { name: '第三位 UI', exact: true }).waitFor();
  await navigateUi(page, '洞府 Home');
  await page.locator('.task-row').filter({ hasText: '自由历练 UI' }).last().click();
  await page.getByRole('heading', { name: '自由历练 UI', exact: true }).waitFor();
  assert.equal(await page.getByText('工作流', { exact: true }).count(), 0);
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: join(images, 'failure.png'), fullPage: true });
  console.error(await page.locator('main').innerText());
  throw error;
} finally {
  await app.close();
}

// A durable hard failure drives the actual unavailable UI on restart.
const db = new Database(join(userData, 'data', 'cultivation.sqlite'));
try {
  const failureAt = new Date().toISOString();
  db.prepare(
    `UPDATE teammate_model_availability SET status='UNAVAILABLE', last_checked_at=?, last_failure_at=?, recent_outcomes_json=? WHERE teammate_id=?`,
  ).run(
    failureAt,
    failureAt,
    JSON.stringify([
      {
        kind: 'HARD_FAILURE',
        code: 'AUTHENTICATION_FAILED',
        checkedAt: failureAt,
      },
    ]),
    fixtures.a.id,
  );
} finally {
  db.close();
}
const restarted = await launch();
try {
  const page = await restarted.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  await navigateUi(page, '道友 Teammates');
  await page.locator('.teammate-roster-select').filter({ hasText: fixtures.a.name }).click();
  await page.locator('.teammate-profile-status [data-availability="UNAVAILABLE"]').waitFor();
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('blocked UI send');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByRole('button', { name: '选择其他道友' }).waitFor();
  const messages = await page.evaluate(
    ({ id, conversationId }) =>
      window.cultivation.chat.listMessages({ teammateId: id, conversationId }),
    { id: fixtures.a.id, conversationId },
  );
  assert.equal(
    messages.some((message) => message.content === 'blocked UI send'),
    false,
  );
  await page.screenshot({ path: join(images, 'chat-unavailable-error.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await page.locator('[data-availability="AVAILABLE"]').waitFor();
} catch (error) {
  const page = await restarted.firstWindow();
  await page.screenshot({ path: join(images, 'restart-failure.png'), fullPage: true });
  console.error(await page.locator('main').innerText());
  throw error;
} finally {
  await restarted.close();
}
writeFileSync(
  join(userData, 'ui-measurements.json'),
  JSON.stringify(measurements, null, 2),
  'utf8',
);
console.log(
  'R3_3_UI_PACKAGED_SMOKE_OK navigation=6 advanced=reachable chat=stream memory=isolated skill=toggle collaboration=approved create=blank_fields responsive=30_views error=unavailable_no_reroute restart=retained',
);
console.log('R3_3_UI_EVIDENCE_DIR ' + userData);
