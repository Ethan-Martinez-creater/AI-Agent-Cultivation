import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

const root = process.cwd();
const { navigateUi } = await import(pathToFileURL(join(root, 'scripts', 'ui-navigation.mjs')).href);
const runId = randomUUID();
const userData = join(root, '.test-data', `r3-3-ui-${runId}`);
const tempDirectory = join(root, '.tmp', `r3-3-ui-${runId}`, 'temp');
const images = join(userData, 'screenshots');
const fixturesDirectory = join(userData, 'fixtures');
const chromiumProfile = join(userData, 'chromium-profile');
const databasePath = join(userData, 'data', 'cultivation.sqlite');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const sourceAvatar = join(
  root,
  'apps',
  'desktop',
  'src',
  'renderer',
  'src',
  'assets',
  'avatars',
  'user.png',
);
const importedAvatar = join(fixturesDirectory, 'teammate-avatar.png');
const manifestPath = join(userData, 'evidence-manifest.json');

mkdirSync(images, { recursive: true });
mkdirSync(fixturesDirectory, { recursive: true });
mkdirSync(tempDirectory, { recursive: true });
mkdirSync(chromiumProfile, { recursive: true });
assert.ok(existsSync(executablePath), `Packaged app not found: ${executablePath}`);
assert.ok(existsSync(sourceAvatar), `Avatar fixture source not found: ${sourceAvatar}`);
copyFileSync(sourceAvatar, importedAvatar);

const manifest = {
  runId,
  executablePath,
  userData,
  screenshots: [],
  assertions: [],
};
const measurements = [];
let app;
let fixtures;
let conversationId = '';

function recordAssertion(name, details = {}) {
  manifest.assertions.push({ name, ...details });
}

function launchPackagedApp() {
  return electron.launch({
    executablePath,
    args: ['--gate1-fake-model', `--user-data-dir=${chromiumProfile}`],
    timeout: 30000,
    env: {
      ...process.env,
      CULTIVATION_USER_DATA_DIR: userData,
      TEMP: tempDirectory,
      TMP: tempDirectory,
      TMPDIR: tempDirectory,
    },
  });
}

async function waitForPaint(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
      ),
  );
}

async function waitForStableRoute(page, quietPeriod = 600) {
  await page.waitForFunction(
    (requiredQuietPeriod) => {
      const hash = window.location.hash;
      const state = window.__r33RouteStability;
      if (!state || state.hash !== hash) {
        window.__r33RouteStability = { hash, changedAt: Date.now() };
        return false;
      }
      return Date.now() - state.changedAt >= requiredQuietPeriod;
    },
    quietPeriod,
    { polling: 50 },
  );
}

async function setWindowSize(targetApp, page, width, height) {
  await targetApp.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
    [width, height],
  );
  await page.waitForTimeout(100);
  await waitForPaint(page);
  const actual = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  recordAssertion('real-browser-window-size', { requested: [width, height], actual });
  return actual;
}

async function capture(page, name, width, height, details = {}) {
  const path = join(images, name);
  await waitForPaint(page);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const metrics = await pageMetrics(page);
  manifest.screenshots.push({ name, path, viewport, requestedSize: [width, height], ...details });
  measurements.push({ name, ...viewport, ...metrics });
  return path;
}

async function pageMetrics(page) {
  const result = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const doc = window.document;
    const fields = [...doc.querySelectorAll('input:not([type="checkbox"]),select,textarea')]
      .filter(visible)
      .map((field) => ({
        labelCount: field.labels?.length ?? 0,
        element: field.tagName.toLowerCase(),
        accessibleName: field.getAttribute('aria-label') ?? '',
      }));
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentWidth: doc.documentElement.scrollWidth,
      placeholders: doc.querySelectorAll('[placeholder]').length,
      unlabelled: fields.filter((field) => field.labelCount === 0 && !field.accessibleName),
    };
  });
  assert.ok(
    result.documentWidth <= result.innerWidth + 1,
    `Page-level horizontal overflow: ${JSON.stringify(result)}`,
  );
  assert.equal(result.placeholders, 0, 'Visible product pages should not expose placeholders.');
  assert.deepEqual(result.unlabelled, [], 'Visible fields need external labels.');
  return result;
}

async function waitForChatIdle(page) {
  await page.waitForFunction(
    () =>
      window.document.querySelector('[data-testid="message-stream"]')?.getAttribute('aria-busy') ===
      'false',
  );
  await page.locator('[data-testid="streaming-message"]').waitFor({ state: 'detached' });
}

async function sendChatText(page, text) {
  const composer = page.getByLabel('写消息', { exact: true });
  await composer.fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function readAvailabilityRow(teammateId) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db
      .prepare('SELECT * FROM teammate_model_availability WHERE teammate_id = ?')
      .get(teammateId);
  } finally {
    db.close();
  }
}

async function closeWithTitlebar(targetApp, page) {
  const closed = targetApp.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) resolve(undefined);
        else window.once('closed', () => resolve(undefined));
      }),
  );
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
  recordAssertion('titlebar-close');
}

try {
  app = await launchPackagedApp();
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  await page.locator('.home-first-teammate').waitFor();
  assert.equal(await page.locator('.home-first-teammate .button.primary').count(), 1);
  assert.equal(await page.getByRole('link', { name: '创建第一位道友', exact: true }).count(), 1);
  assert.deepEqual(
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link').allTextContents(),
    ['首页', '道友', '队伍', '历练', '记忆', '设置'],
  );
  await setWindowSize(app, page, 1440, 900);
  await pageMetrics(page);
  await capture(page, '01-home-empty-1440.png', 1440, 900, { route: '/' });
  recordAssertion('home-empty-single-primary-action');

  const appMenuIsNull = await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null);
  assert.equal(
    appMenuIsNull,
    true,
    'The packaged app must not expose the default application menu.',
  );
  const titlebarPresentation = await page.evaluate(() => {
    const doc = window.document;
    const titlebar = doc.querySelector('.app-titlebar');
    const controls = doc.querySelector('.window-controls');
    return {
      brandCount: doc.querySelectorAll('.app-titlebar .titlebar-brand').length,
      productNameOccurrences: (doc.body.innerText.match(/AI Agent Cultivation/g) ?? []).length,
      sidebarText: doc.querySelector('.sidebar')?.innerText ?? '',
      titlebarDrag: titlebar
        ? window.getComputedStyle(titlebar).getPropertyValue('-webkit-app-region')
        : '',
      controlsDrag: controls
        ? window.getComputedStyle(controls).getPropertyValue('-webkit-app-region')
        : '',
    };
  });
  assert.equal(titlebarPresentation.brandCount, 1);
  assert.equal(titlebarPresentation.productNameOccurrences, 1);
  assert.doesNotMatch(titlebarPresentation.sidebarText, /AI Agent Cultivation|Windows V1 Alpha/);
  assert.equal(titlebarPresentation.titlebarDrag, 'drag');
  assert.equal(titlebarPresentation.controlsDrag, 'no-drag');
  recordAssertion('packaged-shell-menu-brand-and-drag-regions', {
    menuIsNull: appMenuIsNull,
    ...titlebarPresentation,
  });

  const logoImage = page.locator('.titlebar-brand img');
  const originalLogoDimensions = await logoImage.evaluate((image) => ({
    width: image.getAttribute('width'),
    height: image.getAttribute('height'),
    styleWidth: image.style.width,
    styleHeight: image.style.height,
  }));
  for (const size of [16, 24, 32, 48]) {
    const renderedSize = await logoImage.evaluate((image, dimension) => {
      image.setAttribute('width', String(dimension));
      image.setAttribute('height', String(dimension));
      image.style.width = `${dimension}px`;
      image.style.height = `${dimension}px`;
      return image.getBoundingClientRect().width;
    }, size);
    assert.equal(renderedSize, size, `Logo should render at ${size}px.`);
    await capture(page, `shell-logo-${size}.png`, 1440, 900, { logoSize: size });
  }
  await logoImage.evaluate((image, original) => {
    if (original.width === null) image.removeAttribute('width');
    else image.setAttribute('width', original.width);
    if (original.height === null) image.removeAttribute('height');
    else image.setAttribute('height', original.height);
    image.style.width = original.styleWidth;
    image.style.height = original.styleHeight;
  }, originalLogoDimensions);
  recordAssertion('packaged-logo-renders-at-16-24-32-48-px');

  await page.getByRole('button', { name: '折叠导航' }).click();
  await page.locator('.layout.sidebar-collapsed').waitFor();
  await page.getByRole('button', { name: '展开导航' }).click();
  await page.locator('.layout:not(.sidebar-collapsed)').waitFor();
  recordAssertion('sidebar-collapse-expand');

  const maximizeEvent = app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => BrowserWindow.getAllWindows()[0].once('maximize', resolve)),
  );
  await page.getByRole('button', { name: '最大化窗口' }).click();
  await maximizeEvent;
  await page.getByRole('button', { name: '恢复窗口' }).waitFor();
  const restoreEvent = app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => BrowserWindow.getAllWindows()[0].once('unmaximize', resolve)),
  );
  await page.getByRole('button', { name: '恢复窗口' }).click();
  await restoreEvent;
  await page.getByRole('button', { name: '最大化窗口' }).waitFor();
  const minimizeEvent = app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => BrowserWindow.getAllWindows()[0].once('minimize', resolve)),
  );
  await page.getByRole('button', { name: '最小化窗口' }).click();
  await minimizeEvent;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.getByRole('button', { name: '最小化窗口' }).waitFor();
  recordAssertion('titlebar-minimize-maximize-restore');

  await navigateUi(page, '道友 Teammates');
  await page.getByRole('button', { name: '创建道友', exact: true }).click();
  const emptyModelPanel = page.locator('.teammate-create-drawer');
  await emptyModelPanel.getByLabel('名称', { exact: true }).fill('Empty template check');
  await emptyModelPanel.getByRole('button', { name: '继续选择模型' }).click();
  await emptyModelPanel.getByRole('button', { name: '使用已有模型', exact: true }).click();
  await emptyModelPanel
    .getByText('暂无可复用的模型配置，请添加新模型。', { exact: true })
    .waitFor();
  assert.equal(await emptyModelPanel.locator('input[name="existing-runtime"]').count(), 0);
  await capture(page, 'create-teammate-no-template-1440.png', 1440, 900, {
    drawer: 'no-reusable-template',
  });
  await emptyModelPanel
    .locator('.create-empty-models')
    .getByRole('button', { name: '添加新模型', exact: true })
    .click();
  await emptyModelPanel.getByLabel('Provider 类型').waitFor();
  await emptyModelPanel.getByRole('button', { name: '关闭面板', exact: true }).click();
  recordAssertion('creation-empty-template-guides-to-new-model');
  await navigateUi(page, '洞府 Home');

  fixtures = await page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'R3.3 packaged smoke provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'R3.3 fixed smoke model',
      providerId: provider.id,
      credentialId: null,
      modelId: 'r33-fixed-smoke-model',
    });
    const createTeammate = (name, avatar) =>
      api.teammates.create({
        name,
        avatar,
        title: '产品验收道友',
        description: '用于 R3.3 packaged UI 验收。',
        identityPrompt: '',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
    const a = await createTeammate('青岚 Smoke', 'preset:02');
    const b = await createTeammate('明衡 Smoke', 'preset:07');
    await api.capability.saveBenchmark({
      runtimeProfileId: a.currentRuntimeProfileId,
      modelAlias: runtime.modelId,
      dimension: 'CODING',
      supported: true,
      normalizedScore: 86,
      rawScore: null,
      source: 'R3.3 deterministic visual fixture',
      benchmark: 'UI acceptance fixture (not a real benchmark)',
      benchmarkVersion: '1',
      snapshotDate: '2026-09-30T00:00:00.000Z',
      sourceUrl: null,
      provenanceType: 'USER_ESTIMATE',
    });
    const skill = await api.skills.create({
      name: '结构化分析',
      description: '产品验收用声明式 Skill。',
      instructions: '先整理要点，再给出简明结论。',
      tags: ['analysis'],
    });
    await api.skills.assign({ teammateId: a.id, skillId: skill.id });
    await api.skills.setEnabled({ teammateId: a.id, skillId: skill.id, enabled: true });
    const humanBridge = (await api.teammates.list()).find(
      (item) => item.executorKind === 'USER_BRIDGE' || item.systemKind === 'HUMAN_BRIDGE',
    );
    const party = await api.parties.create({
      name: '双人协作 Smoke',
      description: '由两位固定模型道友组成的队伍。',
      type: 'FIXED',
      coordinatorTeammateId: a.id,
      memberTeammateIds: [a.id, b.id],
    });
    const partyWithHumanBridge = await api.parties.create({
      name: '本尊协作 Smoke',
      description: '验证本尊在队伍中的委托状态，不显示模型可用性。',
      type: 'FIXED',
      coordinatorTeammateId: a.id,
      memberTeammateIds: [a.id, humanBridge.id],
    });
    const mission = await api.missions.create({
      title: '协作验收 Smoke',
      objective: '请两位道友分别整理需求，再等待用户确认协作结果。',
      coordinatorTeammateId: a.id,
      partyId: party.id,
      mode: 'CONSULTATION',
    });
    await api.missions.ready(mission.id);
    await api.missions.start({ missionId: mission.id, approvalFixture: false });
    return { provider, runtime, a, b, party, partyWithHumanBridge, mission, humanBridge };
  });
  assert.ok(fixtures.humanBridge, 'The packaged app should expose its Human Bridge teammate.');
  recordAssertion('fake-provider-fixtures-seeded', {
    teammateIds: [fixtures.a.id, fixtures.b.id],
    runtimeId: fixtures.runtime.id,
    missionId: fixtures.mission.id,
  });

  await waitForStableRoute(page);
  await navigateUi(page, '道友 Teammates');
  await page.getByRole('heading', { name: '道友', exact: true, level: 1 }).waitFor();
  await navigateUi(page, '洞府 Home');
  await waitForStableRoute(page);
  assert.equal(await page.evaluate(() => window.location.hash), '#/');
  await page.getByRole('heading', { name: '首页', exact: true, level: 1 }).waitFor();
  await page
    .locator('.home-task-list')
    .getByText(fixtures.mission.title, { exact: true })
    .first()
    .waitFor();
  await pageMetrics(page);
  await capture(page, '02-home-active-1440.png', 1440, 900, { route: '/' });

  await navigateUi(page, '道友 Teammates');
  await page.locator('.teammate-roster-select').filter({ hasText: fixtures.a.name }).click();
  await page.getByRole('heading', { name: fixtures.a.name, exact: true }).waitFor();
  await pageMetrics(page);
  await capture(page, '03-teammates-list-1440.png', 1440, 900, { route: '/teammates' });
  await capture(page, '04-teammate-detail-1440.png', 1440, 900, {
    route: '/teammates',
    teammate: fixtures.a.name,
  });

  const createPanel = page.locator('.teammate-create-drawer');
  await page.getByRole('button', { name: '创建道友' }).click();
  await createPanel.getByRole('heading', { name: '身份资料' }).waitFor();
  await pageMetrics(page);
  await capture(page, '05-create-teammate-identity-1440.png', 1440, 900, {
    route: '/teammates',
    drawer: 'identity',
  });
  await createPanel.getByLabel('名称', { exact: true }).fill('玄照 Upload Smoke');
  const mockDialogInstalled = await app.evaluate(({ dialog }, filePath) => {
    const target = dialog;
    const original = target.showOpenDialog;
    target.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    globalThis.__r33OriginalOpenDialog = original;
    return true;
  }, importedAvatar);
  assert.equal(mockDialogInstalled, true);
  await page.getByRole('button', { name: '从电脑选择' }).click();
  await page.waitForFunction(() => {
    const button = [...window.document.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('从电脑选择'),
    );
    return button && !button.disabled;
  });
  await createPanel.getByRole('button', { name: '继续选择模型' }).click();
  await createPanel.getByRole('heading', { name: '为 玄照 Upload Smoke 选择模型' }).waitFor();
  await createPanel.locator('input[name="existing-runtime"]').first().waitFor();
  const templateCandidates = await createPanel
    .locator('input[name="existing-runtime"]')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.deepEqual(templateCandidates, [fixtures.runtime.id]);
  assert.notEqual(fixtures.a.currentRuntimeProfileId, fixtures.runtime.id);
  assert.notEqual(fixtures.b.currentRuntimeProfileId, fixtures.runtime.id);
  recordAssertion('creation-only-unbound-template-no-duplicate-private-runtimes', {
    templateCandidates,
    excludedBoundRuntimes: [fixtures.a.currentRuntimeProfileId, fixtures.b.currentRuntimeProfileId],
  });
  await createPanel
    .locator(`input[name="existing-runtime"][value="${fixtures.runtime.id}"]`)
    .check();
  await pageMetrics(page);
  await capture(page, '06-create-teammate-model-1440.png', 1440, 900, {
    route: '/teammates',
    drawer: 'model',
  });
  await createPanel.getByRole('button', { name: '测试连接', exact: true }).click();
  await createPanel.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  await createPanel.getByRole('button', { name: '确认资料' }).click();
  await createPanel.getByRole('heading', { name: '检查道友资料' }).waitFor();
  await createPanel.getByRole('button', { name: '确认并创建道友' }).click();
  await page.getByRole('heading', { name: '玄照 Upload Smoke', exact: true }).waitFor();
  await app.evaluate(({ dialog }) => {
    if (globalThis.__r33OriginalOpenDialog)
      dialog.showOpenDialog = globalThis.__r33OriginalOpenDialog;
    delete globalThis.__r33OriginalOpenDialog;
  });
  const importedAvatarResult = await page.evaluate(async (name) => {
    const teammate = (await window.cultivation.teammates.list()).find((item) => item.name === name);
    if (!teammate) return null;
    const image = await window.cultivation.avatars.read(teammate.avatar ?? '');
    return {
      avatar: teammate.avatar,
      imagePrefix: image?.slice(0, 22) ?? '',
    };
  }, '玄照 Upload Smoke');
  assert.ok(
    importedAvatarResult?.avatar?.startsWith('local:'),
    'Import should return opaque local ref.',
  );
  assert.ok(
    !importedAvatarResult.avatar.includes(importedAvatar),
    'Absolute file path must not persist.',
  );
  assert.ok(importedAvatarResult.imagePrefix.startsWith('data:image/png;base64,'));
  await page.locator('.teammate-profile .object-avatar img').waitFor();
  recordAssertion('native-avatar-import-and-safe-reference', importedAvatarResult);

  await page.getByRole('button', { name: '创建道友' }).click();
  await createPanel.getByRole('heading', { name: '身份资料' }).waitFor();
  await createPanel.getByLabel('名称', { exact: true }).fill('紫檀 New Model Smoke');
  await createPanel.getByRole('button', { name: '继续选择模型' }).click();
  await createPanel.getByRole('heading', { name: '为 紫檀 New Model Smoke 选择模型' }).waitFor();
  await createPanel.getByRole('button', { name: '添加新模型', exact: true }).click();
  await createPanel.getByLabel('Provider 类型').selectOption('OPENAI_COMPATIBLE');
  await createPanel
    .getByLabel('Endpoint（兼容服务需要）', { exact: true })
    .fill('http://127.0.0.1:9998/v1');
  await createPanel.getByLabel('Model ID', { exact: true }).fill('r33-new-model-smoke');
  const smokeApiKey = 'r33-packaged-smoke-only-fake-key';
  await app.evaluate(({ clipboard }, key) => clipboard.writeText(key), smokeApiKey);
  await createPanel.getByRole('button', { name: '从剪贴板安全导入', exact: true }).click();
  await createPanel
    .getByRole('status')
    .filter({ hasText: 'API Key 已安全导入，剪贴板已清空。' })
    .waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(smokeApiKey));
  await createPanel.getByRole('button', { name: '测试连接', exact: true }).click();
  await createPanel.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  await capture(page, 'create-teammate-new-model-tested-1440.png', 1440, 900, {
    route: '/teammates',
    drawer: 'new-model-tested',
  });
  await createPanel.getByRole('button', { name: '确认资料' }).click();
  await createPanel.getByRole('heading', { name: '检查道友资料' }).waitFor();
  await capture(page, 'create-teammate-new-model-confirm-1440.png', 1440, 900, {
    route: '/teammates',
    drawer: 'new-model-confirm',
  });
  await createPanel.getByRole('button', { name: '确认并创建道友' }).click();
  await page.getByRole('heading', { name: '紫檀 New Model Smoke', exact: true }).waitFor();
  const createdNewModelBinding = await page.evaluate(async (name) => {
    const api = window.cultivation;
    const teammate = (await api.teammates.list()).find((item) => item.name === name);
    if (!teammate?.currentRuntimeProfileId) return null;
    const runtime = (await api.runtimes.list()).find(
      (item) => item.id === teammate.currentRuntimeProfileId,
    );
    const provider = runtime
      ? (await api.providers.list()).find((item) => item.id === runtime.providerId)
      : null;
    const credentials = provider ? await api.credentials.list(provider.id) : [];
    return {
      teammateName: teammate.name,
      runtimeId: runtime?.id,
      runtimeName: runtime?.name,
      modelId: runtime?.modelId,
      credentialBound: Boolean(runtime?.credentialId),
      providerKind: provider?.kind,
      endpoint: provider?.baseUrl,
      credentialLabel: credentials[0]?.label ?? '',
    };
  }, '紫檀 New Model Smoke');
  assert.ok(createdNewModelBinding?.runtimeId, 'New model creation must bind a runtime profile.');
  const { runtimeId: createdNewModelRuntimeId, ...newModelBindingDetails } = createdNewModelBinding;
  assert.deepEqual(newModelBindingDetails, {
    teammateName: '紫檀 New Model Smoke',
    runtimeName: 'r33-new-model-smoke',
    modelId: 'r33-new-model-smoke',
    credentialBound: true,
    providerKind: 'OPENAI_COMPATIBLE',
    endpoint: 'http://127.0.0.1:9998/v1',
    credentialLabel: 'r33-new-model-smoke API Key',
  });
  recordAssertion('embedded-provider-model-test-and-seal', createdNewModelBinding);

  // Exercise the real creation UI without importing a key or invoking the clipboard path.
  await page.getByRole('button', { name: '创建道友' }).click();
  await createPanel.getByRole('heading', { name: '身份资料' }).waitFor();
  await createPanel.getByLabel('名称', { exact: true }).fill('无钥 Keyless Smoke');
  await createPanel.getByRole('button', { name: '继续选择模型' }).click();
  await createPanel.getByRole('heading', { name: '为 无钥 Keyless Smoke 选择模型' }).waitFor();
  await createPanel.getByRole('button', { name: '添加新模型', exact: true }).click();
  await createPanel.getByLabel('Provider 类型').selectOption('OPENAI');
  await createPanel.getByLabel('Model ID', { exact: true }).fill('r33-keyless-smoke');
  assert.equal(
    await createPanel.getByRole('button', { name: '测试连接', exact: true }).isEnabled(),
    false,
  );
  await createPanel.getByLabel('Provider 类型').selectOption('OPENAI_COMPATIBLE');
  await createPanel.getByText('API Key（可选）', { exact: true }).waitFor();
  assert.equal(
    await createPanel.getByRole('button', { name: '测试连接', exact: true }).isEnabled(),
    false,
  );
  await createPanel
    .getByLabel('Endpoint（兼容服务需要）', { exact: true })
    .fill('http://127.0.0.1:9997/v1');
  assert.equal(
    await createPanel.getByRole('button', { name: '测试连接', exact: true }).isEnabled(),
    true,
  );
  await app.evaluate(({ clipboard }) => clipboard.writeText('r33-keyless-clipboard-untouched'));
  await createPanel.getByRole('button', { name: '测试连接', exact: true }).click();
  await createPanel.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  await capture(page, 'create-teammate-keyless-tested-1440.png', 1440, 900, {
    route: '/teammates',
    drawer: 'keyless-model-tested',
  });
  await createPanel.getByRole('button', { name: '确认资料' }).click();
  await createPanel.getByRole('heading', { name: '检查道友资料' }).waitFor();
  await capture(page, 'create-teammate-keyless-confirm-1440.png', 1440, 900, {
    route: '/teammates',
    drawer: 'keyless-model-confirm',
  });
  await createPanel.getByRole('button', { name: '确认并创建道友' }).click();
  await page.getByRole('heading', { name: '无钥 Keyless Smoke', exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    'r33-keyless-clipboard-untouched',
  );
  await app.evaluate(({ clipboard }) => clipboard.clear());
  const keylessDb = new Database(databasePath, { readonly: true });
  try {
    const sealedKeyless = keylessDb
      .prepare(
        `
      SELECT b.provider_kind, b.endpoint, b.model_id, b.credential_id,
        b.verified_at, b.sealed_at, b.verification_source,
        rp.credential_id AS runtime_credential_id, p.kind AS provider_kind_actual,
        p.base_url AS provider_endpoint_actual, rp.model_id AS runtime_model_id
      FROM teammates AS t
      JOIN teammate_model_bindings AS b ON b.teammate_id = t.id
      JOIN runtime_profiles AS rp ON rp.id = b.runtime_profile_id
      JOIN providers AS p ON p.id = rp.provider_id
      WHERE t.name = ? AND t.current_runtime_profile_id = b.runtime_profile_id
    `,
      )
      .get('无钥 Keyless Smoke');
    assert.ok(sealedKeyless);
    const { verified_at, sealed_at, ...identity } = sealedKeyless;
    assert.ok(verified_at && sealed_at);
    assert.deepEqual(identity, {
      provider_kind: 'OPENAI_COMPATIBLE',
      endpoint: 'http://127.0.0.1:9997/v1',
      model_id: 'r33-keyless-smoke',
      credential_id: null,
      verification_source: 'LIVE_TEST',
      runtime_credential_id: null,
      provider_kind_actual: 'OPENAI_COMPATIBLE',
      provider_endpoint_actual: 'http://127.0.0.1:9997/v1',
      runtime_model_id: 'r33-keyless-smoke',
    });
    assert.equal(
      keylessDb
        .prepare(
          `
      SELECT count(*) AS total FROM provider_credentials AS c
      JOIN providers AS p ON p.id = c.provider_id WHERE p.base_url = ?
    `,
        )
        .get('http://127.0.0.1:9997/v1').total,
      0,
    );
    recordAssertion('keyless-ui-test-create-sealed-sqlite-identity', sealedKeyless);
  } finally {
    keylessDb.close();
  }

  await navigateUi(page, '队伍 Parties');
  await page.locator('.party-summary-button').filter({ hasText: '双人协作 Smoke' }).click();
  await page.getByRole('heading', { name: '双人协作 Smoke', exact: true }).waitFor();
  await pageMetrics(page);
  await capture(page, '07-party-detail-1440.png', 1440, 900, {
    route: '/parties',
    party: fixtures.party.name,
  });
  await page
    .locator('.party-summary-button')
    .filter({ hasText: fixtures.partyWithHumanBridge.name })
    .click();
  const humanBridgePartyMember = page
    .locator('.party-detail-member')
    .filter({ hasText: fixtures.humanBridge.name });
  await humanBridgePartyMember.waitFor();
  assert.match(await humanBridgePartyMember.innerText(), /可接收委托/);
  assert.equal(await humanBridgePartyMember.locator('[data-availability]').count(), 0);
  assert.equal(
    await humanBridgePartyMember.getByRole('button', { name: '重新检测', exact: true }).count(),
    0,
  );
  await capture(page, 'party-human-bridge-1440.png', 1440, 900, {
    route: '/parties',
    party: fixtures.partyWithHumanBridge.name,
  });
  recordAssertion('human-bridge-party-member-has-delegation-status-only');

  await navigateUi(page, '历练 Missions');
  await page.getByRole('tab', { name: /^全部\s*\d/ }).click();
  await page
    .locator('button.mission-list-item')
    .filter({ hasText: fixtures.mission.title })
    .click();
  await page.getByRole('heading', { name: fixtures.mission.title, exact: true }).waitFor();
  await pageMetrics(page);
  await capture(page, '08-mission-detail-1440.png', 1440, 900, {
    route: '/missions',
    mission: fixtures.mission.title,
  });
  const approve = page.getByRole('button', { name: '批准并继续', exact: true }).first();
  await approve.waitFor();
  await approve.click();
  await page.waitForFunction(
    (id) =>
      window.cultivation.missions.detail(id).then((detail) => detail.mission.state === 'COMPLETED'),
    fixtures.mission.id,
  );
  recordAssertion('visible-mission-approval-and-completion');

  await navigateUi(page, '记忆 Memory');
  const memoryOwner = page.getByRole('combobox', { name: '道友', exact: true });
  await memoryOwner.selectOption(fixtures.a.id);
  await page.getByRole('button', { name: '新增记忆', exact: true }).first().click();
  await page.getByLabel('摘要', { exact: true }).fill('青岚的私有记忆');
  await page.getByLabel('内容', { exact: true }).fill('R33_A_PRIVATE_MEMORY');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.locator('.memory-object-row').filter({ hasText: 'R33_A_PRIVATE_MEMORY' }).waitFor();
  await memoryOwner.selectOption(fixtures.b.id);
  await page.getByText('还没有符合筛选的记忆', { exact: true }).waitFor();
  assert.equal(
    await page.locator('.memory-object-row').filter({ hasText: 'R33_A_PRIVATE_MEMORY' }).count(),
    0,
    'A teammate private memory must not appear in B scope.',
  );
  await page.getByRole('button', { name: '新增记忆', exact: true }).first().click();
  await page.getByLabel('摘要', { exact: true }).fill('明衡的私有记忆');
  await page.getByLabel('内容', { exact: true }).fill('R33_B_PRIVATE_MEMORY');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await page.locator('.memory-object-row').filter({ hasText: 'R33_B_PRIVATE_MEMORY' }).waitFor();
  await memoryOwner.selectOption(fixtures.a.id);
  await page.locator('.memory-object-row').filter({ hasText: 'R33_A_PRIVATE_MEMORY' }).waitFor();
  assert.equal(
    await page.locator('.memory-object-row').filter({ hasText: 'R33_B_PRIVATE_MEMORY' }).count(),
    0,
  );
  await page.locator('.memory-object-row').filter({ hasText: 'R33_A_PRIVATE_MEMORY' }).waitFor();
  await pageMetrics(page);
  await capture(page, '09-memory-1440.png', 1440, 900, {
    route: '/memory',
    owner: fixtures.a.name,
  });
  recordAssertion('memory-owner-isolation-both-directions');

  await navigateUi(page, '设置 Settings');
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  const sealedRuntime = page.locator('.runtime-item-sealed').filter({ hasText: fixtures.a.name });
  await sealedRuntime.waitFor();
  await sealedRuntime.getByText(/固定给/).waitFor();
  await sealedRuntime.getByText(fixtures.runtime.modelId, { exact: true }).waitFor();
  const boundRuntimeId = fixtures.a.currentRuntimeProfileId;
  assert.ok(boundRuntimeId, 'A model-backed teammate should have its sealed runtime profile.');
  const teammateBoundRuntime = await page.evaluate(
    (runtimeId) =>
      window.cultivation.runtimes.list().then((rows) => rows.find((row) => row.id === runtimeId)),
    boundRuntimeId,
  );
  assert.equal(teammateBoundRuntime?.modelId, fixtures.runtime.modelId);
  assert.equal(await sealedRuntime.getByRole('button', { name: '编辑模板' }).count(), 0);
  assert.equal(await sealedRuntime.getByRole('button', { name: '测试连接' }).count(), 0);
  const newModelSealedRuntime = page
    .locator('.runtime-item-sealed')
    .filter({ hasText: createdNewModelBinding.modelId });
  await newModelSealedRuntime.waitFor();
  await newModelSealedRuntime.getByText(/固定给/).waitFor();
  assert.equal(await newModelSealedRuntime.getByRole('button', { name: '编辑模板' }).count(), 0);
  assert.equal(await newModelSealedRuntime.getByRole('button', { name: '测试连接' }).count(), 0);
  await pageMetrics(page);
  await capture(page, '10-settings-models-1440.png', 1440, 900, {
    route: '/settings',
    tab: '模型配置',
  });
  recordAssertion('sealed-runtime-is-read-only', {
    runtimeIds: [boundRuntimeId, createdNewModelRuntimeId],
  });

  const rotationIdentity = await page.evaluate(async (id) => {
    const api = window.cultivation;
    const runtime = (await api.runtimes.list()).find((row) => row.id === id);
    const provider = (await api.providers.list()).find((row) => row.id === runtime.providerId);
    return {
      runtimeId: runtime.id,
      providerId: runtime.providerId,
      credentialId: runtime.credentialId,
      modelId: runtime.modelId,
      providerKind: provider.kind,
      endpoint: provider.baseUrl,
    };
  }, createdNewModelRuntimeId);
  await page.getByRole('tab', { name: '密钥凭据', exact: true }).click();
  await app.evaluate(({ clipboard }) => clipboard.writeText('r33-rotated-fake-key-main-only'));
  await page
    .locator('.object-row')
    .filter({ hasText: 'r33-new-model-smoke API Key' })
    .getByRole('button', { name: '轮换密钥', exact: true })
    .click();
  await page.getByRole('button', { name: '从剪贴板安全轮换', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '密钥已安全轮换' }).waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
  assert.ok(!(await page.locator('body').innerText()).includes('r33-rotated-fake-key-main-only'));
  const afterRotation = await page.evaluate(async (id) => {
    const api = window.cultivation;
    const runtime = (await api.runtimes.list()).find((row) => row.id === id);
    const provider = (await api.providers.list()).find((row) => row.id === runtime.providerId);
    return {
      runtimeId: runtime.id,
      providerId: runtime.providerId,
      credentialId: runtime.credentialId,
      modelId: runtime.modelId,
      providerKind: provider.kind,
      endpoint: provider.baseUrl,
    };
  }, createdNewModelRuntimeId);
  assert.deepEqual(afterRotation, rotationIdentity);
  recordAssertion('credential-rotation-ui-preserves-sealed-model-identity');
  await capture(page, 'settings-credential-rotation-1440.png', 1440, 900, {
    route: '/settings',
    tab: '密钥凭据',
  });
  await page.keyboard.press('Escape');

  await navigateUi(page, '本尊待办 Human Bridge');
  await page.getByRole('heading', { name: '本尊待办', exact: true }).waitFor();
  const humanBridgeAvailability = await page.locator('main').evaluate((main) => ({
    badges: main.querySelectorAll('[data-availability]').length,
    recheckButtons: [...main.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('重新检测'),
    ).length,
  }));
  assert.deepEqual(humanBridgeAvailability, { badges: 0, recheckButtons: 0 });
  await pageMetrics(page);
  await capture(page, '11-human-bridge-1440.png', 1440, 900, { route: '/external-work' });
  recordAssertion('human-bridge-has-no-model-availability', humanBridgeAvailability);

  await navigateUi(page, '道友 Teammates');
  await page.locator('.teammate-roster-select').filter({ hasText: fixtures.a.name }).click();
  await setWindowSize(app, page, 1180, 780);
  await pageMetrics(page);
  await capture(page, '12-teammate-detail-1180.png', 1180, 780, {
    route: '/teammates',
    teammate: fixtures.a.name,
  });

  await navigateUi(page, '历练 Missions');
  await page.getByRole('tab', { name: /^全部\s*\d/ }).click();
  await page
    .locator('button.mission-list-item')
    .filter({ hasText: fixtures.mission.title })
    .click();
  await page.getByRole('heading', { name: fixtures.mission.title, exact: true }).waitFor();
  await setWindowSize(app, page, 1180, 780);
  await pageMetrics(page);
  await capture(page, '13-mission-detail-1180.png', 1180, 780, {
    route: '/missions',
    mission: fixtures.mission.title,
  });

  await navigateUi(page, '洞府 Home');
  await setWindowSize(app, page, 900, 600);
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  await pageMetrics(page);
  await capture(page, '14-home-900.png', 900, 600, { route: '/' });
  await navigateUi(page, '道友 Teammates');
  await pageMetrics(page);
  await capture(page, '15-teammates-900.png', 900, 600, { route: '/teammates' });
  await navigateUi(page, '设置 Settings');
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  await pageMetrics(page);
  await capture(page, '16-settings-900.png', 900, 600, {
    route: '/settings',
    tab: '模型配置',
  });
  await page.getByRole('button', { name: '新建运行配置', exact: true }).click();
  await capture(page, 'settings-model-content-900.png', 900, 600, {
    route: '/settings',
    tab: '模型配置',
    scrolledToModelForm: true,
  });
  await page.keyboard.press('Escape');

  await setWindowSize(app, page, 1440, 900);
  await navigateUi(page, '道友 Teammates');
  await page.locator('.teammate-roster-select').filter({ hasText: fixtures.a.name }).click();
  await page.getByRole('button', { name: '开始对话', exact: true }).click();
  await page.locator('[data-testid="empty-chat"]').waitFor();
  await pageMetrics(page);
  await capture(page, 'chat-empty-1440.png', 1440, 900, { route: `/chat/${fixtures.a.id}` });
  await page
    .locator('[data-testid="empty-chat"]')
    .getByRole('button', { name: /开始新对话/ })
    .click();
  await page.locator('[data-testid="empty-conversation"]').waitFor();
  await page.getByLabel('写消息', { exact: true }).waitFor();
  await sendChatText(page, 'PING');
  await page.getByTestId('message-stream').getByText('PONG', { exact: true }).waitFor();
  await waitForChatIdle(page);
  const chatMessages = await page.locator('[data-testid="message-stream"]').evaluate((stream) => ({
    assistantAvatar: Boolean(
      stream.querySelector('.r33-message-row.is-assistant .r33-message-avatar'),
    ),
    userAvatar: Boolean(stream.querySelector('.r33-message-row.is-user .r33-user-avatar')),
  }));
  assert.deepEqual(chatMessages, { assistantAvatar: true, userAvatar: true });
  await capture(page, 'chat-conversation-1440.png', 1440, 900, {
    route: `/chat/${fixtures.a.id}`,
    conversationId: 'persisted-after-visible-PING',
  });
  const conversationRows = await page.evaluate(
    (id) => window.cultivation.chat.listConversations(id),
    fixtures.a.id,
  );
  assert.ok(conversationRows.length > 0);
  conversationId = conversationRows[0].id;
  recordAssertion('visible-chat-ping-pong-and-object-avatars', { conversationId, ...chatMessages });

  // The deterministic Fake gateway finishes in one microtask burst. Hold only
  // this request's real IPC events after its first delta so the genuine Renderer
  // streaming view can be captured; do not manufacture message/DOM content.
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const originalSend = contents.send;
    const queued = [];
    let heldRequestId;
    contents.send = function (channel, ...args) {
      const payload = args[0];
      if (channel === 'chat:event' && payload?.type === 'delta' && !heldRequestId) {
        heldRequestId = payload.requestId;
        return originalSend.call(this, channel, ...args);
      }
      if (channel === 'chat:event' && payload?.requestId === heldRequestId) {
        queued.push([channel, ...args]);
        return;
      }
      return originalSend.call(this, channel, ...args);
    };
    globalThis.__r33ReleaseChatEvents = () => {
      contents.send = originalSend;
      for (const [channel, ...args] of queued) originalSend.call(contents, channel, ...args);
      delete globalThis.__r33ReleaseChatEvents;
      return queued.length;
    };
  });
  const streamPrompt = `保留回复自然流动：${Array.from({ length: 850 }, (_, index) => `片段${index + 1}`).join(' ')}`;
  await page.evaluate(() => {
    window.__r33FirstDelta = new Promise((resolve) => {
      let unsubscribe = () => undefined;
      unsubscribe = window.cultivation.chat.onEvent((event) => {
        if (event.type === 'delta') {
          unsubscribe();
          resolve(event.text ?? '');
        }
      });
    });
  });
  await page.getByLabel('写消息', { exact: true }).fill(streamPrompt);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.evaluate(() => window.__r33FirstDelta);
  await page.locator('[data-testid="streaming-message"]').waitFor();
  assert.match(await page.locator('[data-testid="streaming-message"]').innerText(), /青岚 Smoke/);
  assert.match(await page.locator('[data-testid="streaming-message"]').innerText(), /正在/);
  await capture(page, 'chat-streaming-1440.png', 1440, 900, {
    route: `/chat/${fixtures.a.id}`,
    streaming: true,
  });
  const releasedEvents = await app.evaluate(() => globalThis.__r33ReleaseChatEvents());
  assert.ok(releasedEvents > 1, 'Real delta and terminal IPC events must be released in order.');
  await waitForChatIdle(page);
  recordAssertion('streaming-state-keeps-avatar-name-and-composer-visible', {
    fixture: 'real-IPC-first-delta-barrier',
    releasedEvents,
  });

  const codeBody = [
    'type SmokeRecord = { id: string; owner: "teammate"; content: string };',
    'export function summarize(record: SmokeRecord): string {',
    '  const readable = record.content.trim().replace(/\\s+/g, " ");',
    '  return `${record.id}: ${readable}`;',
    '}',
    `const veryLongSingleLine = "${'x'.repeat(1800)}";`,
  ].join('\n');
  const codePrompt = `请保留这段 TypeScript 示例：\n\`\`\`typescript\n${codeBody}\n\`\`\``;
  await sendChatText(page, codePrompt);
  await page.getByTestId('code-block').last().waitFor();
  await waitForChatIdle(page);
  assert.ok((await page.getByTestId('code-copy').count()) >= 1);
  const codeBlock = page.getByTestId('code-block').last();
  const copiedCode = await codeBlock.locator('pre code').textContent();
  await codeBlock.getByRole('button', { name: '复制代码' }).click();
  await codeBlock.getByRole('button', { name: '代码已复制' }).waitFor();
  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(clipboardText, copiedCode, 'Code Copy must use the typed Main clipboard port.');
  const codeLayout = await page.evaluate(() => ({
    documentWidth: window.document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    codeScrollWidth: window.document.querySelector('.r33-code-scroll')?.scrollWidth ?? 0,
    codeClientWidth: window.document.querySelector('.r33-code-scroll')?.clientWidth ?? 0,
  }));
  assert.ok(codeLayout.documentWidth <= codeLayout.innerWidth + 1, JSON.stringify(codeLayout));
  assert.ok(codeLayout.codeScrollWidth > codeLayout.codeClientWidth, JSON.stringify(codeLayout));
  await capture(page, 'chat-long-content-1440.png', 1440, 900, {
    route: `/chat/${fixtures.a.id}`,
    codeCharacters: copiedCode.length,
  });
  recordAssertion('safe-code-render-horizontal-container-and-typed-copy', codeLayout);

  await navigateUi(page, '道友 Teammates');
  await page.locator('.teammate-roster-select').filter({ hasText: fixtures.b.name }).click();
  await page
    .locator('.teammate-profile')
    .getByRole('button', { name: '重新检测', exact: true })
    .click();
  await page.locator('.teammate-profile [data-availability="AVAILABLE"]').waitFor();
  const beforeArchive = await readAvailabilityRow(fixtures.b.id);
  assert.ok(beforeArchive);
  await page.locator('.teammate-more-menu > summary').click();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.locator('.teammate-archived-status').waitFor();
  await page.evaluate(() => {
    window.__r33AvailabilityEvents = [];
    window.__r33StopAvailability = window.cultivation.availability.onChanged((value) => {
      window.__r33AvailabilityEvents.push(value);
    });
  });
  await page.evaluate((id) => {
    window.location.hash = `#/chat/${encodeURIComponent(id)}`;
  }, fixtures.b.id);
  await page.locator('[data-testid="chat-page"]').waitFor();
  await page.getByText('已归档', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '重新检测', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('写消息', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
  await page.waitForTimeout(250);
  const archiveEvents = await page.evaluate(() => window.__r33AvailabilityEvents.length);
  const afterArchive = await readAvailabilityRow(fixtures.b.id);
  assert.equal(archiveEvents, 0, 'Mounting an archived Chat must not initiate a probe.');
  assert.deepEqual(
    afterArchive,
    beforeArchive,
    'Archived Chat must preserve the availability projection.',
  );
  recordAssertion('archived-chat-does-not-probe-or-send', {
    availabilityStatus: beforeArchive.status,
    eventCount: archiveEvents,
  });

  await closeWithTitlebar(app, page);
  try {
    await app.close();
  } catch {
    // The titlebar close control may have already ended the packaged process.
  }
  app = undefined;

  const db = new Database(databasePath);
  try {
    const failureAt = new Date().toISOString();
    const changed = db
      .prepare(
        `UPDATE teammate_model_availability
         SET status = 'UNAVAILABLE', last_checked_at = ?, last_failure_at = ?, recent_outcomes_json = ?
         WHERE teammate_id = ?`,
      )
      .run(
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
    assert.equal(changed.changes, 1, 'Fixture must seed an existing sealed runtime projection.');
  } finally {
    db.close();
  }

  app = await launchPackagedApp();
  const restartedPage = await app.firstWindow();
  await restartedPage.getByRole('heading', { name: '首页', exact: true }).waitFor();
  await navigateUi(restartedPage, '道友 Teammates');
  await restartedPage
    .locator('.teammate-roster-select')
    .filter({ hasText: '玄照 Upload Smoke' })
    .click();
  const persistedImage = restartedPage.locator('.teammate-profile .object-avatar img');
  await persistedImage.waitFor();
  const persistedSource = await persistedImage.getAttribute('src');
  assert.ok(persistedSource?.startsWith('data:image/png;base64,'));
  const persistedAvatarPort = await restartedPage.evaluate(async (name) => {
    const teammate = (await window.cultivation.teammates.list()).find((item) => item.name === name);
    return teammate ? window.cultivation.avatars.read(teammate.avatar ?? '') : null;
  }, '玄照 Upload Smoke');
  assert.ok((await persistedAvatarPort)?.startsWith('data:image/png;base64,'));
  recordAssertion('local-avatar-survives-packaged-app-restart');

  await restartedPage
    .locator('.teammate-roster-select')
    .filter({ hasText: fixtures.a.name })
    .click();
  await restartedPage.locator('.teammate-profile [data-availability="UNAVAILABLE"]').waitFor();
  await restartedPage.getByRole('button', { name: '开始对话', exact: true }).click();
  await restartedPage.locator('[data-testid="chat-page"]').waitFor();
  await restartedPage.getByLabel('写消息', { exact: true }).fill('blocked UI send');
  await restartedPage.getByRole('button', { name: '发送', exact: true }).click();
  await restartedPage.locator('[data-testid="unavailable-notice"]').waitFor();
  await restartedPage.getByRole('button', { name: '选择其他道友', exact: true }).waitFor();
  await restartedPage.getByRole('button', { name: '重新检测', exact: true }).waitFor();
  await restartedPage.getByRole('button', { name: '取消', exact: true }).waitFor();
  assert.equal(
    await restartedPage.getByLabel('写消息', { exact: true }).inputValue(),
    'blocked UI send',
  );
  const blockedMessages = await restartedPage.evaluate(
    ({ teammateId, conversationId: targetConversationId }) =>
      window.cultivation.chat.listMessages({
        teammateId,
        conversationId: targetConversationId,
      }),
    { teammateId: fixtures.a.id, conversationId },
  );
  assert.equal(
    blockedMessages.some((message) => message.content === 'blocked UI send'),
    false,
  );
  await setWindowSize(app, restartedPage, 1440, 900);
  await capture(restartedPage, 'chat-unavailable-1440.png', 1440, 900, {
    route: `/chat/${fixtures.a.id}`,
    draftPreserved: true,
  });
  await restartedPage.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(
    await restartedPage.getByLabel('写消息', { exact: true }).inputValue(),
    'blocked UI send',
    'Canceling the inline notice must leave the unsent draft intact.',
  );
  await navigateUi(restartedPage, '道友 Teammates');
  await restartedPage
    .locator('.teammate-roster-select')
    .filter({ hasText: fixtures.a.name })
    .click();
  await restartedPage
    .locator('.teammate-profile')
    .getByRole('button', { name: '重新检测', exact: true })
    .click();
  await restartedPage.waitForFunction(
    (id) =>
      window.cultivation.availability
        .list()
        .then(
          (rows) =>
            rows.find((row) => row.teammateId === id)?.recentOutcomes.at(-1)?.kind === 'SUCCESS',
        ),
    fixtures.a.id,
  );
  // Preserve R3.2's two-success recovery policy after a hard failure.
  await restartedPage
    .locator('.teammate-profile')
    .getByRole('button', { name: '重新检测', exact: true })
    .click();
  await restartedPage.locator('.teammate-profile [data-availability="AVAILABLE"]').waitFor();
  recordAssertion('unavailable-chat-keeps-draft-and-explicit-recovery-only');

  await restartedPage.getByRole('button', { name: '开始对话', exact: true }).click();
  await restartedPage.locator('[data-testid="chat-page"]').waitFor();
  await setWindowSize(app, restartedPage, 900, 600);
  await restartedPage.getByRole('button', { name: '展开对话列表' }).click();
  await restartedPage.locator('dialog[open] [data-testid="conversation-list"]').waitFor();
  await restartedPage.getByLabel('写消息', { exact: true }).waitFor();
  await pageMetrics(restartedPage);
  await capture(restartedPage, 'chat-conversation-drawer-900.png', 900, 600, {
    route: `/chat/${fixtures.a.id}`,
    conversationDrawerOpen: true,
  });
  await restartedPage.keyboard.press('Escape');
  await restartedPage.locator('dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(await restartedPage.getByLabel('写消息', { exact: true }).isVisible(), true);
  recordAssertion('chat-900-drawer-toggles-with-composer-available');
  await sendChatText(restartedPage, 'PING');
  await restartedPage
    .getByTestId('message-stream')
    .getByText('PONG', { exact: true })
    .last()
    .waitFor();
  await waitForChatIdle(restartedPage);
  await pageMetrics(restartedPage);
  await capture(restartedPage, 'chat-conversation-900.png', 900, 600, {
    route: `/chat/${fixtures.a.id}`,
    conversationDrawerOpen: false,
    realReplyAfterExplicitRecovery: true,
  });

  await closeWithTitlebar(app, restartedPage);
  try {
    await app.close();
  } catch {
    // The titlebar close control may have already ended the packaged process.
  }
  app = undefined;
} catch (error) {
  if (app) {
    try {
      const page = await app.firstWindow();
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(images, 'failure.png'), fullPage: true });
        const main = page.locator('main');
        if ((await main.count()) > 0) console.error(await main.innerText());
      }
    } catch {
      // Preserve the original smoke failure if the packaged window has already closed.
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  throw error;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      // The titlebar close check may already have shut the app down.
    }
  }
}

const requiredScreenshots = [
  '01-home-empty-1440.png',
  '02-home-active-1440.png',
  '03-teammates-list-1440.png',
  '04-teammate-detail-1440.png',
  '05-create-teammate-identity-1440.png',
  '06-create-teammate-model-1440.png',
  '07-party-detail-1440.png',
  '08-mission-detail-1440.png',
  '09-memory-1440.png',
  '10-settings-models-1440.png',
  '11-human-bridge-1440.png',
  '12-teammate-detail-1180.png',
  '13-mission-detail-1180.png',
  '14-home-900.png',
  '15-teammates-900.png',
  '16-settings-900.png',
  'chat-empty-1440.png',
  'chat-conversation-1440.png',
  'chat-streaming-1440.png',
  'chat-long-content-1440.png',
  'chat-unavailable-1440.png',
  'chat-conversation-900.png',
];
assert.deepEqual(
  manifest.screenshots
    .map((item) => item.name)
    .filter((name) => requiredScreenshots.includes(name)),
  requiredScreenshots,
  'The complete v1.1 screenshot set must be captured in order.',
);
writeFileSync(
  join(userData, 'ui-measurements.json'),
  JSON.stringify(measurements, null, 2),
  'utf8',
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(
  `R3_3_UI_PACKAGED_SMOKE_OK screenshots=${manifest.screenshots.length} creation=unbound-templates,keyless-sealed chat=streaming,long-content,copy,unavailable memory-isolated=both-ways archived=no-probe sealed-runtime=readonly human-bridge=no-availability avatar=imported,restart titlebar=verified responsive=1440,1180,900`,
);
console.log(`R3_3_UI_EVIDENCE_DIR ${userData}`);
console.log(`R3_3_UI_EVIDENCE_MANIFEST ${manifestPath}`);
