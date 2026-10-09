import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
const root = process.cwd();
const evidence = join(root, '.test-data', `g1-packaged-${randomUUID()}`, 'evidence');
mkdirSync(evidence, { recursive: true });
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const facts = { crashes: [], failClosed: [], production: null, workspace: [], frozenHashes: [] };
async function launch(profile, args = [], extra = {}) {
  const app = await electron.launch({
    executablePath,
    args,
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile, ...extra },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}
async function crashProcess(app) {
  const child = app.process();
  const exited = once(child, 'exit');
  // On Windows Playwright may return a launcher wrapper, not the Electron host.
  const mainPid = await app.evaluate(() => process.pid);
  process.kill(mainPid, 'SIGKILL');
  await exited;
}
const read = (profile, fn) => {
  const db = new Database(join(profile, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
async function setup(page) {
  return page.evaluate(async () => {
    const provider = await window.cultivation.providers.create({
      name: '图像服务',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:7788/v1',
    });
    const runtime = await window.cultivation.runtimes.create({
      name: '图像模型',
      providerId: provider.id,
      credentialId: null,
      modelId: 'image-v1',
      executionProtocol: 'GENERATION',
    });
    const test = await window.cultivation.runtimes.testConnection(runtime.id);
    if (!test.ok) throw new Error('Generation connection rejected');
    const teammate = await window.cultivation.teammates.create({
      name: '画师',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    return {
      teammateId: teammate.id,
      runtimeId: teammate.currentRuntimeProfileId,
      sourceRuntimeId: runtime.id,
    };
  });
}
const input = (teammateId, scenario) => ({
  teammateId,
  capability: 'IMAGE_GENERATION',
  requiredFeatures: ['TEXT_TO_IMAGE'],
  prompt: '生成一张简洁图片',
  inputs: [],
  parameters: scenario ? { scenario } : {},
  expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
});
async function capture(page, name, width = 1180) {
  await page.setViewportSize({ width, height: 900 });
  await page.screenshot({ path: join(evidence, `${name}-${width}.png`) });
}

// Normal production has no generation test provider and preserves all W2 frozen installations.
let live;
try {
  const production = join(evidence, '..', 'production-profile');
  live = await launch(production);
  facts.production = read(production, (db) => ({
    migration: db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n,
    jobs: db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n,
  }));
  assert.deepEqual(facts.production, { migration: 31, jobs: 0 });
  facts.frozenHashes = read(production, (db) =>
    db
      .prepare(
        'SELECT r.definition_id,r.manifest_hash,v.content_hash FROM workflow_builtin_releases AS r JOIN workflow_versions AS v ON v.definition_id=r.definition_id AND v.version=r.version ORDER BY r.definition_id',
      )
      .all(),
  );
  assert.equal(facts.frozenHashes.length, 3);
  assert.deepEqual(facts.frozenHashes, [
    {
      definition_id: 'official.ai-news-video',
      manifest_hash: 'ae37a04bf0156c42adea41d8d0418de2f942d6dc677803727af7db41ab36e4cd',
      content_hash: '4763d276b85362096db1085ebc458c76ea731c243d72df6069da302ca75ce153',
    },
    {
      definition_id: 'official.research',
      manifest_hash: '199c675c91c1c7d15709141be9a7dc6ce1e776f3c1b0af7c66c2ff9e1f3b03d3',
      content_hash: 'b264c0448470b12473c0e39f21cf7e1c40c1d9b4b6e1c945f9ffb5ccc2a305b7',
    },
    {
      definition_id: 'official.software-feature',
      manifest_hash: '30eb30ce957ef3bad798d1046bd45835322b645d97e49ca5affcac4e16cd348d',
      content_hash: 'a5a9982824db796dc4843d68558b4874067d551eff878132c78c94e881e2ea5a',
    },
  ]);
  assert.equal(existsSync(join(production, 'g1-fake-provider.json')), false);
  await live.app.close();

  for (const point of [
    'created',
    'submitting',
    'submission_sent',
    'submitted',
    'provider_completed',
    'downloading',
    'staged',
    'committed',
    'registered',
  ]) {
    const profile = join(evidence, '..', `crash-${point}`);
    live = await launch(profile, [
      '--gate1-fake-model',
      '--g1-fake-generation',
      `--g1-crash-${point}`,
    ]);
    const identity = await setup(live.page);
    await live.page.evaluate(async (data) => {
      try {
        const job = await window.cultivation.generation.create(data);
        await window.cultivation.generation.advance(job.id);
      } catch {
        /* The durable boundary is intentionally interrupted by the test hook. */
      }
    }, input(identity.teammateId));
    const before = read(profile, (db) => db.prepare('SELECT * FROM generation_jobs').get());
    assert(before);
    const counterBefore = JSON.parse(readFileSync(join(profile, 'g1-fake-provider.json'), 'utf8'));
    let partialFacts = null;
    if (point === 'downloading') {
      const providerOutput = Object.values(counterBefore.entries)[0].job.outputs[0];
      const hashed = (value) => createHash('sha256').update(value).digest('hex');
      const stage = join(
        profile,
        'generation-artifacts',
        'staging',
        hashed(before.id),
        hashed(providerOutput.id) + '.png.stage',
      );
      partialFacts = {
        partialBytes: statSync(stage + '.partial').size,
        advertisedBytes: providerOutput.sizeBytes,
        completeStageExists: existsSync(stage),
        artifacts: read(
          profile,
          (db) => db.prepare('SELECT COUNT(*) AS n FROM generation_artifacts').get().n,
        ),
      };
      assert(
        partialFacts.partialBytes > 0 && partialFacts.partialBytes < partialFacts.advertisedBytes,
      );
      assert.equal(partialFacts.completeStageExists, false);
      assert.equal(partialFacts.artifacts, 0);
    }
    const frozenDescriptor = read(profile, (db) =>
      JSON.parse(
        db.prepare('SELECT descriptor_json FROM generation_tasks LIMIT 1').get().descriptor_json,
      ),
    );
    assert(frozenDescriptor.limits.maxInputBytes > 16 * 1024 * 1024);
    assert(frozenDescriptor.limits.maxOutputBytes > 16 * 1024 * 1024);
    await crashProcess(live.app);
    live = await launch(profile, ['--gate1-fake-model', '--g1-fake-generation']);
    const recovered = await live.page.evaluate(
      (id) => window.cultivation.generation.detail(id),
      before.id,
    );
    assert.equal(recovered.job.state, 'COMPLETED');
    assert.equal(recovered.artifacts.length, 1);
    const after = JSON.parse(readFileSync(join(profile, 'g1-fake-provider.json'), 'utf8'));
    assert.equal(after.submissions, 1);
    assert.equal(after.downloads, point === 'downloading' ? 2 : 1);
    if (['staged', 'committed', 'registered'].includes(point))
      assert.equal(after.downloads, counterBefore.downloads);
    await live.page.evaluate(() => {
      window.location.hash = '/generation';
    });
    await live.page.getByRole('heading', { name: '生成任务', exact: true }).waitFor();
    await live.page.getByRole('region', { name: '生成任务列表' }).locator('button').first().click();
    await capture(live.page, `recovery-${point}`, 900);
    const artifactFacts = read(profile, (db) =>
      db.prepare('SELECT id,content_hash,storage_scope FROM generation_artifacts').all(),
    );
    facts.crashes.push({
      point,
      beforeState: before.state,
      beforeProviderStatus: before.provider_status,
      providerJobId: recovered.job.providerJobId,
      state: recovered.job.state,
      submissions: after.submissions,
      downloads: after.downloads,
      downloadsBeforeRestart: counterBefore.downloads,
      descriptorLimits: frozenDescriptor.limits,
      partialFacts,
      artifacts: artifactFacts,
    });
    const events = read(
      profile,
      (db) => db.prepare('SELECT COUNT(*) AS n FROM generation_events').get().n,
    );
    await live.app.close();
    live = await launch(profile, ['--gate1-fake-model', '--g1-fake-generation']);
    assert.equal(
      read(profile, (db) => db.prepare('SELECT COUNT(*) AS n FROM generation_events').get().n),
      events,
    );
    const again = JSON.parse(readFileSync(join(profile, 'g1-fake-provider.json'), 'utf8'));
    assert.deepEqual(
      { submissions: again.submissions, downloads: again.downloads, queries: again.queries },
      { submissions: after.submissions, downloads: after.downloads, queries: after.queries },
    );
    await live.app.close();
  }

  const safetyProfile = join(evidence, '..', 'safety-profile');
  live = await launch(safetyProfile, ['--gate1-fake-model', '--g1-fake-generation']);
  const identity = await setup(live.page);
  for (const scenario of ['UNKNOWN', 'INVALID_MIME', 'INVALID_HASH', 'MISSING']) {
    const job = await live.page.evaluate(
      (data) => window.cultivation.generation.create(data),
      input(identity.teammateId, scenario),
    );
    const result = await live.page.evaluate(
      (id) => window.cultivation.generation.advance(id),
      job.id,
    );
    assert.equal(result.state, scenario === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED');
    assert.deepEqual(result.outputArtifactIds, []);
    facts.failClosed.push({ scenario, state: result.state, errorCode: result.errorCode });
  }
  for (const spoof of [
    { outputDestination: { scope: 'MISSION_WORKSPACE', path: 'C:\\secret' } },
    { inputs: [{ artifactId: 'forged', role: 'REFERENCE', path: 'C:\\secret' }] },
    { requiredFeatures: ['FORGED_FEATURE'] },
  ]) {
    const rejected = await live.page.evaluate(
      async (data) => {
        try {
          await window.cultivation.generation.create(data);
          return false;
        } catch {
          return true;
        }
      },
      { ...input(identity.teammateId), ...spoof },
    );
    assert.equal(rejected, true);
  }
  await live.page.evaluate(() => {
    window.location.hash = '/settings';
  });
  await live.page.getByRole('tab', { name: '模型配置', exact: true }).click();
  await live.page.getByRole('button', { name: '新建运行配置', exact: true }).click();
  const runtimeForm = live.page.getByRole('dialog', { name: '新建运行配置', exact: true });
  await runtimeForm.getByLabel('名称', { exact: true }).fill('图像生成配置');
  const availableProviders = await live.page.evaluate(() => window.cultivation.providers.list());
  await runtimeForm.getByLabel('服务商').selectOption(availableProviders[0].id);
  await runtimeForm.getByLabel('模型编号', { exact: true }).fill('image-v1');
  await runtimeForm.getByLabel('模型类型').selectOption('GENERATION');
  await capture(live.page, 'runtime-create', 900);
  await runtimeForm.getByRole('button', { name: '创建运行配置', exact: true }).click();
  await runtimeForm.waitFor({ state: 'hidden' });
  const uiRuntime = (await live.page.evaluate(() => window.cultivation.runtimes.list())).find(
    (r) => r.name === '图像生成配置',
  );
  assert.equal(uiRuntime.executionProtocol, 'GENERATION');
  facts.runtimeUi = { id: uiRuntime.id, executionProtocol: uiRuntime.executionProtocol };
  await capture(live.page, 'runtime-foundation', 1440);
  assert.equal(await live.page.getByRole('button', { name: '重新检测', exact: true }).count(), 0);
  await live.page.evaluate(() => {
    window.location.hash = '/teammates';
  });
  await live.page.locator('.teammate-roster-select').filter({ hasText: '画师' }).click();
  await live.page.getByRole('button', { name: '查看生成任务', exact: true }).waitFor();
  assert.equal(await live.page.getByRole('button', { name: '开始对话', exact: true }).count(), 0);
  assert.equal(await live.page.getByRole('button', { name: '重新检测', exact: true }).count(), 0);
  await capture(live.page, 'generation-teammate', 1440);
  await live.page.getByRole('button', { name: '查看生成任务', exact: true }).click();
  await live.page.getByRole('heading', { name: '生成任务', exact: true }).waitFor();
  facts.runtimeUi.generationEntry = true;
  const uncertaintyCounters = JSON.parse(
    readFileSync(join(safetyProfile, 'g1-fake-provider.json'), 'utf8'),
  );
  await live.app.close();
  live = await launch(safetyProfile, ['--gate1-fake-model', '--g1-fake-generation']);
  const afterUncertainty = JSON.parse(
    readFileSync(join(safetyProfile, 'g1-fake-provider.json'), 'utf8'),
  );
  assert.deepEqual(
    {
      submissions: afterUncertainty.submissions,
      downloads: afterUncertainty.downloads,
      queries: afterUncertainty.queries,
    },
    {
      submissions: uncertaintyCounters.submissions,
      downloads: uncertaintyCounters.downloads,
      queries: uncertaintyCounters.queries,
    },
  );
  const uncertain = (await live.page.evaluate(() => window.cultivation.generation.list())).filter(
    (job) => job.state === 'UNKNOWN',
  );
  assert.equal(uncertain.length, 1);
  assert.deepEqual(uncertain[0].outputArtifactIds, []);
  facts.unknownRestart = {
    state: 'UNKNOWN',
    automaticSubmissions: 0,
    automaticDownloads: 0,
    automaticQueries: 0,
  };
  await live.app.close();

  for (const deny of [false, true]) {
    const profile = join(evidence, '..', deny ? 'workspace-denied' : 'workspace-allowed');
    const workspace = join(profile, 'workspace');
    mkdirSync(workspace, { recursive: true });
    live = await launch(
      profile,
      [
        '--gate1-fake-model',
        '--g1-fake-generation',
        '--g1-workspace-fixture',
        ...(deny ? ['--g1-deny-write'] : []),
      ],
      { CULTIVATION_G1_WORKSPACE_DIR: workspace },
    );
    const jobs = await live.page.evaluate(() => window.cultivation.generation.list());
    assert.equal(jobs.length, 1);
    const result = await live.page.evaluate(
      (id) => window.cultivation.generation.advance(id),
      jobs[0].id,
    );
    assert.equal(result.state, deny ? 'FAILED' : 'COMPLETED');
    const file = join(workspace, 'deliveries', 'picture.png');
    assert.equal(existsSync(file), !deny);
    const detail = await live.page.evaluate(
      (id) => window.cultivation.generation.detail(id),
      jobs[0].id,
    );
    if (!deny) {
      assert.equal(detail.artifacts[0].storageScope, 'MISSION_WORKSPACE');
      assert.equal(
        createHash('sha256').update(readFileSync(file)).digest('hex'),
        detail.artifacts[0].contentHash,
      );
    }
    facts.workspace.push({
      deny,
      state: result.state,
      errorCode: result.errorCode,
      artifacts: detail.artifacts.map((a) => ({
        id: a.id,
        hash: a.contentHash,
        scope: a.storageScope,
      })),
    });
    await live.app.close();
  }
  writeFileSync(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
  console.log(
    `G1_PACKAGED_SMOKE_OK crashes=A-F+partial+commit streaming=true descriptorsAbove16MiB=true partial=re-download-original verifiedStage=zero-redownload idempotency=stable UNKNOWN=no-replay output=app+workspace permission=deny evidence=${evidence}`,
  );
} finally {
  if (live) await live.app.close().catch(() => undefined);
}
