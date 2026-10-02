import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const runId = randomUUID();
const profile = join(root, '.test-data', `ui-product-system-${runId}`);
const screenshots = join(profile, 'screenshots');
const workspace = join(profile, 'workspace');
for (const directory of [screenshots, workspace, join(profile, 'temp'), join(profile, 'chromium')])
  mkdirSync(directory, { recursive: true });
const dbPath = join(profile, 'data', 'cultivation.sqlite');
const evidence = { runId, sizes: [1440, 1180, 900], screenshots: [], checks: [] };
let app;
// Use ordinary product copy through the existing OpenAI-compatible HTTP fixture path.
// FakeModelGateway and every core regression fixture remain unchanged.
const visualResponse =
  '已整理本周产品需求：\n\n1. 明确用户目标与主要使用场景。\n2. 按优先级拆分交付内容。\n3. 为每项需求补充可验证的验收要点。';
let modelCalls = 0;
const modelServer = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-32b', object: 'model' }] }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404);
    response.end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const content = input.response_format ? JSON.stringify({ candidates: [] }) : visualResponse;
  modelCalls += 1;
  const base = { id: `response-${modelCalls}`, created: 1, model: 'qwen3-32b' };
  const usage = { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 };
  if (input.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      [
        {
          ...base,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage,
        },
      ]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
    );
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage,
      }),
    );
  }
});
await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
const modelBaseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
async function launch() {
  app = await electron.launch({
    executablePath: join(root, 'out', 'AI Agent Cultivation-win32-x64', 'AI-Agent-Cultivation.exe'),
    args: [`--user-data-dir=${join(profile, 'chromium')}`],
    env: {
      ...process.env,
      CULTIVATION_USER_DATA_DIR: profile,
      TEMP: join(profile, 'temp'),
      TMP: join(profile, 'temp'),
    },
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return page;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
// Smoke-owned USER fixture, installed into this isolated profile while the app is closed.
// It is never shipped or registered as an official template.
function installVisualDefinition() {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const output = {
    key: 'summary',
    kind: 'TEXT',
    required: true,
    contractId: 'visual.summary',
    contractVersion: '1',
    maxSizeBytes: 16384,
    description: '整理结果',
    validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
  };
  const step = {
    id: 'outline',
    type: 'TASK',
    title: '整理需求要点',
    objective: '为产品迭代整理清晰的需求要点。',
    routing: { executionConstraint: 'SOLO', requiredCapabilities: ['GENERAL_REASONING'] },
    inputs: [],
    outputs: [output],
    maxAttempts: 3,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'NONE',
  };
  const version = {
    definition: {
      id: 'visual-user-outline',
      name: '需求整理',
      description: '梳理本次迭代的目标与交付内容。',
      category: '日常工作',
      source: 'USER',
    },
    version: 1,
    entryStepId: step.id,
    steps: [step],
    edges: [],
    referenceBasis: [],
    createdAt: now,
  };
  const json = JSON.stringify(canonical(version));
  try {
    db.transaction(() => {
      db.prepare(
        'INSERT INTO workflow_definitions(id,name,description,category,source,created_at) VALUES(?,?,?,?,?,?)',
      ).run(
        version.definition.id,
        version.definition.name,
        version.definition.description,
        version.definition.category,
        'USER',
        now,
      );
      db.prepare(
        'INSERT INTO workflow_versions(definition_id,version,entry_step_id,version_json,content_hash,created_at) VALUES(?,?,?,?,?,?)',
      ).run(
        version.definition.id,
        1,
        step.id,
        json,
        createHash('sha256').update(json).digest('hex'),
        now,
      );
      db.prepare(
        'INSERT INTO workflow_steps(definition_id,version,id,type,title,objective,routing_json,inputs_json,outputs_json,max_attempts,exit_condition,effect_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        version.definition.id,
        1,
        step.id,
        step.type,
        step.title,
        step.objective,
        JSON.stringify(step.routing),
        '[]',
        JSON.stringify(step.outputs),
        step.maxAttempts,
        step.exitCondition,
        step.effectType,
      );
    })();
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM workflow_definitions WHERE source='BUILTIN'").get().n,
      0,
    );
  } finally {
    db.close();
  }
}
async function capture(page, name, width) {
  await page.waitForTimeout(180);
  const metrics = await page.evaluate(() => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const main = window.document.querySelector('main');
    const fontSizes = [
      ...new Set(
        [...main.querySelectorAll('*')]
          .filter(visible)
          .map((element) => window.getComputedStyle(element).fontSize),
      ),
    ];
    const scrolls = [...window.document.querySelectorAll('*')]
      .filter(
        (element) =>
          visible(element) &&
          element.scrollHeight > element.clientHeight + 2 &&
          ['auto', 'scroll'].includes(window.getComputedStyle(element).overflowY),
      )
      .map((element) => ({
        tag: element.tagName,
        classes: element.className,
        scrollbar: window.getComputedStyle(element).scrollbarWidth,
      }));
    return {
      width: window.innerWidth,
      documentWidth: window.document.documentElement.scrollWidth,
      mainWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      text: main.innerText,
      fontSizes,
      scrolls,
    };
  });
  assert.ok(metrics.documentWidth <= metrics.width + 1, `${name}: window.document overflow`);
  assert.ok(metrics.mainWidth <= metrics.mainClientWidth + 1, `${name}: main overflow`);
  assert.ok(!/FAKE:|TEST_ONLY|\bfixture\b/i.test(metrics.text), `${name}: test identity visible`);
  assert.ok(
    !/\b(?:FILE_OUTPUT|WORKSPACE_MUTATION|EXTERNAL_ACTION|VALID_OUTPUTS|WAITING_USER|MODEL_RUNTIME|IMAGE_GENERATION)\b/.test(
      metrics.text,
    ),
    `${name}: internal enum exposed`,
  );
  assert.ok(!metrics.fontSizes.some((size) => parseFloat(size) < 12), `${name}: tiny typography`);
  if (name === 'usage')
    assert.ok(
      !/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(metrics.text),
      'usage: primary UI exposes an internal identity',
    );
  for (const scroll of metrics.scrolls) {
    assert.equal(scroll.scrollbar, 'thin', `${name}: prominent native scrollbar`);
    assert.ok(
      scroll.tag === 'MAIN' ||
        scroll.tag === 'TEXTAREA' ||
        /drawer-content|r33-message-stream|r33-conversation-items|advanced|code-scroll|table-scroll|management-table-wrap/.test(
          scroll.classes,
        ),
      `${name}: nested scroll ${JSON.stringify(scroll)}`,
    );
  }
  const path = join(screenshots, `${name}-${width}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  const safeMetrics = { ...metrics };
  delete safeMetrics.text;
  evidence.screenshots.push({ name, width, path, metrics: safeMetrics });
}
async function route(page, destination) {
  await navigateUi(page, destination);
  await page.waitForTimeout(160);
}
async function keyboardClose(page) {
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => window.document.activeElement?.tagName === 'BODY'),
    false,
    'Modal must return focus to its trigger',
  );
}
try {
  let page = await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await capture(page, 'home-empty', 1440);
  await route(page, '设置 Settings');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.getByLabel('显示名称', { exact: true }).isVisible(), false);
  evidence.checks.push(
    'production bootstrap: zero official/test-only templates; provider form hidden',
  );
  await app.close();
  installVisualDefinition();
  page = await launch();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  const facts = await page.evaluate(async (baseUrl) => {
    const api = window.cultivation;
    await api.tools.chooseWorkspace();
    const provider = await api.providers.create({
      name: '本地模型服务',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl,
    });
    const runtime = await api.runtimes.create({
      name: '日常分析模型',
      providerId: provider.id,
      credentialId: null,
      modelId: 'qwen3-32b',
    });
    const create = (name, avatar, title) =>
      api.teammates.create({
        name,
        avatar,
        title,
        description: '整理思路并给出清晰的交付结果。',
        identityPrompt: '',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
    const a = await create('青岚', 'preset:02', '需求分析');
    const b = await create('明衡', 'preset:07', '交付审阅');
    for (const teammate of [a, b])
      await api.capability.saveBenchmark({
        runtimeProfileId: teammate.currentRuntimeProfileId,
        modelAlias: runtime.modelId,
        dimension: 'GENERAL_REASONING',
        supported: true,
        normalizedScore: 82,
        rawScore: null,
        source: '用户手动估计',
        benchmark: '能力参考',
        benchmarkVersion: '1',
        snapshotDate: '2026-10-01T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
    const skill = await api.skills.create({
      name: '结构化分析',
      description: '将目标、约束与下一步整理为简明要点。',
      instructions: '先整理要点，再给出简明结论。',
      tags: ['分析'],
    });
    await api.skills.assign({ teammateId: a.id, skillId: skill.id });
    await api.skills.setEnabled({ teammateId: a.id, skillId: skill.id, enabled: true });
    await api.memories.create({
      teammateId: a.id,
      memoryType: 'PREFERENCE',
      content: '汇报时先给结论，再列出待确认的问题。',
      summary: '简明汇报偏好',
      importance: 0.7,
    });
    const party = await api.parties.create({
      name: '产品协作组',
      description: '分析与审阅相互配合。',
      type: 'FIXED',
      coordinatorTeammateId: a.id,
      memberTeammateIds: [a.id, b.id],
    });
    const mission = await api.missions.create({
      title: '整理本周产品需求',
      objective: '整理本周需求与验收要点。',
      coordinatorTeammateId: a.id,
      mode: 'SOLO',
    });
    await api.missions.ready(mission.id);
    await api.missions.start({ missionId: mission.id, approvalFixture: false });
    const conversation = await api.chat.createConversation(a.id);
    await api.chat.send({
      requestId: window.crypto.randomUUID(),
      teammateId: a.id,
      conversationId: conversation.id,
      text: '请用三个要点整理这次讨论。',
    });
    await api.r2.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    const external = await api.routing.createMission({
      title: '准备封面草图',
      context: {
        objective: '准备一张清晰的产品封面草图。',
        executionConstraint: 'HUMAN_BRIDGE',
        requiredCapabilities: ['IMAGE_GENERATION'],
      },
    });
    if (external.status !== 'CREATED') throw new Error('Human Bridge fixture was not assigned');
    await api.missions.ready(external.mission.id);
    const waiting = await api.missions.start({
      missionId: external.mission.id,
      approvalFixture: false,
    });
    if (waiting.mission.state !== 'WAITING_EXTERNAL_WORK') {
      throw new Error('Human Bridge fixture did not reach its real waiting state');
    }
    const workflow = await api.workflows.create({
      definitionId: 'visual-user-outline',
      version: 1,
    });
    return { a, b, party, mission, external, workflow: workflow.run };
  }, modelBaseUrl);
  await app.evaluate(({ clipboard }) =>
    clipboard.writeText('ui-acceptance-fixture-key-not-a-real-secret'),
  );
  await page.evaluate(async () => {
    const provider = await window.cultivation.providers.create({
      name: '云端模型服务',
      kind: 'OPENAI',
    });
    await window.cultivation.credentials.create({ providerId: provider.id, label: '个人连接凭据' });
    await window.cultivation.tools.saveMcpServer({
      name: '资料服务',
      command: 'node',
      args: ['manual-server.mjs'],
      envWhitelist: [],
      cwd: null,
      enabled: false,
    });
  });
  await page.waitForFunction(
    (id) =>
      window.cultivation.missions.detail(id).then((detail) => detail.mission.state === 'COMPLETED'),
    facts.mission.id,
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const detail = await page.evaluate(
      (id) => window.cultivation.workflows.advance(id),
      facts.workflow.id,
    );
    if (detail.run.state === 'COMPLETED') break;
    await page.waitForTimeout(100);
  }
  const workflow = await page.evaluate(
    (id) => window.cultivation.workflows.detail(id),
    facts.workflow.id,
  );
  assert.equal(workflow.run.state, 'COMPLETED');
  for (const [width, height] of [
    [1440, 900],
    [1180, 780],
    [900, 700],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await route(page, '洞府 Home');
    await page.getByRole('button', { name: '刷新首页', exact: true }).click();
    await page.locator('.home-task-row').first().waitFor();
    await capture(page, 'home', width);
    await route(page, '道友 Teammates');
    await capture(page, 'teammate-list', width);
    await page.locator('.teammate-roster-select').filter({ hasText: facts.a.name }).click();
    await capture(page, 'teammate-detail', width);
    if (width === 900) await page.getByRole('button', { name: '道友名单', exact: true }).click();
    await page.getByRole('button', { name: '创建道友', exact: true }).click();
    await capture(page, 'create-teammate', width);
    await page.locator('.teammate-create-drawer .drawer-content').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const createActions = await page
      .locator('.teammate-create-drawer .create-flow-actions')
      .evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, viewport: window.innerHeight };
      });
    assert.ok(
      createActions.top >= 0 && createActions.bottom <= createActions.viewport,
      `create actions inaccessible after scroll: ${JSON.stringify(createActions)}`,
    );
    await capture(page, 'create-teammate-actions', width);
    await keyboardClose(page);
    await page.locator('.teammate-roster-select').filter({ hasText: facts.a.name }).click();
    await page.getByRole('button', { name: '开始对话', exact: true }).click();
    await page.getByLabel('写消息', { exact: true }).waitFor();
    await capture(page, 'chat', width);
    if (width === 900) {
      await page.getByRole('button', { name: '展开对话列表' }).click();
      await capture(page, 'chat-conversations', width);
      await keyboardClose(page);
    }
    await route(page, '队伍 Parties');
    await page.getByRole('button').filter({ hasText: facts.party.name }).first().click();
    const partyLayout = await page.evaluate(() => {
      const detail = window.document.querySelector('.party-detail-column');
      const member = detail?.querySelector('.party-detail-member');
      return detail && member
        ? {
            detailWidth: detail.getBoundingClientRect().width,
            memberWidth: member.getBoundingClientRect().width,
          }
        : null;
    });
    assert.ok(
      partyLayout && partyLayout.memberWidth >= partyLayout.detailWidth * 0.85,
      `party members squeezed by sibling content: ${JSON.stringify(partyLayout)}`,
    );
    await capture(page, 'party', width);
    await route(page, '历练 Missions');
    await page.locator('.mission-filter-tabs').getByRole('tab', { name: /^全部/ }).click();
    await page.locator('button.mission-list-item').filter({ hasText: facts.mission.title }).click();
    await capture(page, 'mission', width);
    await page.getByRole('link', { name: '工作流历练', exact: true }).click();
    await capture(page, 'workflow', width);
    const resultSummary = page.locator('.workflow-results .workflow-data-row > summary');
    assert.equal(await resultSummary.first().innerText(), '文本结果');
    assert.ok(
      !/summary|Mission|TEXT|visual\.summary/.test(
        await resultSummary.allInnerTexts().then((text) => text.join(' ')),
      ),
    );
    await resultSummary.first().click();
    const primaryResult = page.locator('.workflow-results .workflow-data-row').first();
    assert.ok(!/\bsummary\b|\bMISSION\b|visual\.summary/.test(await primaryResult.innerText()));
    await primaryResult.locator('.workflow-technical-details > summary').click();
    assert.equal(await primaryResult.getByText('summary', { exact: true }).isVisible(), true);
    assert.equal(await primaryResult.getByText('MISSION', { exact: true }).isVisible(), true);
    assert.ok((await primaryResult.innerText()).includes('visual.summary'));
    await resultSummary.first().click();
    await route(page, '记忆 Memory');
    await page.getByRole('combobox', { name: '道友', exact: true }).selectOption(facts.a.id);
    await capture(page, 'memory', width);
    await route(page, '设置 Settings');
    await capture(page, 'settings', width);
    if (width === 900) {
      const navHeight = await page
        .locator('.settings-sidebar')
        .evaluate((element) => element.getBoundingClientRect().height);
      assert.ok(
        navHeight < height * 0.4,
        `settings navigation consumes first screen (${navHeight})`,
      );
    }
    for (const [tab, name] of [
      ['服务商', 'providers'],
      ['密钥凭据', 'credentials'],
      ['模型配置', 'runtime'],
      ['记忆检索', 'embedding'],
      ['能力评测', 'benchmark'],
      ['智能分配', 'routing'],
      ['Jev 观察', 'jev'],
    ]) {
      const button = page.getByRole('tab', { name: tab, exact: true });
      if (!(await button.count())) throw new Error(`Required Settings category missing: ${tab}`);
      await button.click();
      if (name === 'benchmark') {
        await page
          .getByRole('combobox', { name: '运行配置', exact: true })
          .selectOption(facts.a.currentRuntimeProfileId);
      }
      if (name === 'jev') {
        const actionsPerRow = await page
          .locator('.shadow-panel .setting-row')
          .evaluateAll((rows) => rows.map((row) => row.querySelectorAll('button').length));
        assert.deepEqual(actionsPerRow, [1, 1, 1]);
        assert.equal(
          await page.getByText('Jev 只提供建议。是否启用由你决定，现有执行权限保持不变。').count(),
          0,
        );
      }
      if (name === 'routing') {
        const toggle = page.getByRole('switch', { name: 'Cloud 智能分配', exact: true });
        assert.equal(await toggle.isVisible(), true);
        assert.equal(await toggle.getAttribute('aria-checked'), 'false');
        assert.equal(await page.locator('.routing-config-card input[type="checkbox"]').count(), 0);
      }
      await capture(page, name, width);
      if (name === 'providers') {
        assert.equal(await page.getByLabel('显示名称', { exact: true }).isVisible(), false);
        await page.getByRole('button', { name: '添加服务商', exact: true }).click();
        await capture(page, 'provider-create', width);
        await page.getByLabel('显示名称', { exact: true }).focus();
        await page.keyboard.press('Tab');
        assert.equal(
          await page.evaluate(() => window.document.activeElement?.closest('dialog')?.open),
          true,
        );
        await keyboardClose(page);
      }
    }
    await route(page, '功法 Skills');
    await capture(page, 'skills', width);
    assert.equal(await page.getByLabel('名称', { exact: true }).isVisible(), false);
    await page.getByRole('button', { name: '新建功法', exact: true }).click();
    await capture(page, 'skill-create', width);
    await keyboardClose(page);
    await route(page, '法宝 Tools');
    await capture(page, 'tools-mcp', width);
    await page.getByText('资料服务', { exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'mcp-servers', width);
    await page.getByRole('button', { name: '添加 MCP 服务', exact: true }).click();
    const mcpEnabled = page.getByRole('switch', { name: '启用此 MCP 服务', exact: true });
    assert.equal(await mcpEnabled.isChecked(), true);
    await mcpEnabled.focus();
    await page.keyboard.press('Space');
    assert.equal(await mcpEnabled.isChecked(), false);
    await page.keyboard.press('Enter');
    assert.equal(await mcpEnabled.isChecked(), true);
    await capture(page, 'mcp-create', width);
    const mcpDrawer = page.locator('dialog[open][aria-label="添加 MCP 服务"]');
    await mcpDrawer.locator('.drawer-content').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const mcpActions = await mcpDrawer.locator('.drawer-actions').boundingBox();
    assert.ok(
      mcpActions &&
        mcpActions.y >= 0 &&
        mcpActions.y + mcpActions.height <= (await page.evaluate(() => window.innerHeight)),
      `MCP drawer actions inaccessible at ${width}px`,
    );
    await capture(page, 'mcp-create-actions', width);
    await keyboardClose(page);
    await route(page, '灵石 Usage');
    await capture(page, 'usage', width);
    await route(page, '本尊待办 Human Bridge');
    const bridgeWidth = await page
      .locator('.human-bridge-detail')
      .evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(bridgeWidth >= 400, `Human Bridge detail collapsed to ${bridgeWidth}px`);
    await capture(page, 'human-bridge', width);
    assert.equal(await page.locator('.availability-control').count(), 0);
    await page.getByRole('link', { name: '首页', exact: true }).focus();
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = window.document.activeElement;
      const style = window.getComputedStyle(element);
      return {
        tag: element.tagName,
        classes: element.className,
        outline: style.outlineWidth,
        visible: element.matches(':focus-visible'),
      };
    });
    assert.ok(
      focus.visible && parseFloat(focus.outline) >= 1,
      `keyboard focus-visible absent: ${JSON.stringify(focus)}`,
    );
  }
  evidence.checks.push(
    'product Switch for routing; primary surfaces contain no FAKE:/TEST_ONLY/fixture; Workflow result has a friendly name',
    'all pages: no horizontal overflow/tiny typography/internal primary enum; thin scrollbars only in allowed containers',
    '900 Settings compact navigation',
    'Provider/Skill form hidden until action; native Drawer focus/Escape/return focus',
    'Human Bridge no model availability',
    'existing IPC Mission/Chat/Workflow/ExternalWork facts exercised',
  );
  assert.ok(modelCalls >= 3, 'Visual copy must come through actual model IPC/SDK execution');
  writeFileSync(join(profile, 'evidence-manifest.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(
    `UI_PRODUCT_SYSTEM_PACKAGED_OK screenshots=${evidence.screenshots.length} sizes=1440,1180,900 profile=${profile}`,
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: join(screenshots, 'failure.png') });
    writeFileSync(join(profile, 'failure-ui.txt'), await page.locator('main').innerText(), 'utf8');
  }
  throw error;
} finally {
  if (app) await app.close();
  await new Promise((resolve) => modelServer.close(resolve));
}
