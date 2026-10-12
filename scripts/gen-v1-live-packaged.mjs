/* global setTimeout, document */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';
import { capturePackagedWindow } from './gen-v1-capture.mjs';

// Explicitly invoked acceptance harness; never imported by production bootstrap.
// The profile and submission intents survive harness restarts. No case resubmits an existing entry.
const root = process.cwd();
const profile = join(root, '.test-data', 'gen-v1-live', 'production-profile');
const evidence = join(root, 'docs', 'evidence', 'gen-v1-live-software-v2', 'packaged');
await mkdir(profile, { recursive: true });
await mkdir(evidence, { recursive: true });
const keys = (await readFile(join(root, 'private', 'keys.txt'), 'utf8'))
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .map((value) => value.trim());
assert.equal(
  keys.length >= 4 && keys.slice(0, 4).every((value) => value && !/\s/.test(value)),
  true,
);
const stage = process.argv[2];
assert.ok(
  [
    'apimart',
    'apimart-music-corrective',
    'apimart-video-corrective',
    'mimo',
    'tokenrhythm',
    'history',
  ].includes(stage),
);
const factsPath = join(evidence, 'live-generation-facts.json');
let facts;
try {
  facts = JSON.parse(await readFile(factsPath, 'utf8'));
} catch {
  facts = {
    baseline: '630dfb89029aa8fb359048d547d861bb35b1b721',
    cases: {},
    screenshots: [],
    productionFakeFlags: false,
  };
}
const clean = (value) => {
  let text = String(value);
  for (const key of keys.filter(Boolean)) text = text.split(key).join('[REDACTED]');
  return text.replace(/https?:\/\/[^\s"<>]+/g, '[REMOTE_URL]').slice(0, 500);
};
const save = async () => {
  const text = JSON.stringify(facts, null, 2);
  assert.ok(!keys.filter(Boolean).some((key) => text.includes(key)));
  await writeFile(factsPath, text + '\n', 'utf8');
};
let app;
let page;
const launch = async () => {
  app = await electron.launch({
    executablePath: join(root, 'out', 'AI Agent Cultivation-win32-x64', 'AI-Agent-Cultivation.exe'),
    args: ['--proxy-server=http://127.0.0.1:7890'],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile },
    timeout: 60_000,
  });
  page = await app.firstWindow();
  const window = await app.browserWindow(page);
  await window.evaluate((value) => {
    value.show();
    value.focus();
  });
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 60_000 });
};
const readFacts = (query) => {
  const db = new Database(join(profile, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
};
async function actor(adapterId, modelId, keyIndex, baseUrl, name) {
  const existing = await page.evaluate(
    async (name) =>
      (await window.cultivation.teammates.list()).find((value) => value.name === name),
    name,
  );
  if (existing) return existing;
  let provider = await page.evaluate(
    async ({ adapterId, baseUrl }) => {
      const api = window.cultivation;
      return (
        (await api.providers.list()).find(
          (value) =>
            value.kind === 'GENERATION_HTTP' &&
            value.adapterId === adapterId &&
            value.baseUrl === baseUrl,
        ) ??
        (await api.providers.create({
          name:
            adapterId === 'MIMO_TTS'
              ? 'MiMo 语音'
              : adapterId === 'APIMART_ASYNC'
                ? 'API Mart'
                : '基元律动',
          kind: 'GENERATION_HTTP',
          adapterId,
          baseUrl,
        }))
      );
    },
    { adapterId, baseUrl },
  );
  let credential = await page.evaluate(
    async (id) => (await window.cultivation.credentials.list(id))[0] ?? null,
    provider.id,
  );
  if (!credential) {
    // Plaintext crosses only Playwright's trusted Electron Main channel, never page/Renderer.
    await app.evaluate(({ clipboard }, key) => clipboard.writeText(key), keys[keyIndex]);
    credential = await page.evaluate(
      (id) => window.cultivation.credentials.create({ providerId: id, label: '本地安全凭据' }),
      provider.id,
    );
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
    assert.ok(!('ciphertext' in credential) && !('apiKey' in credential));
  }
  return page.evaluate(
    async ({ provider, credential, modelId, name }) => {
      const api = window.cultivation;
      const runtime =
        (await api.runtimes.list()).find(
          (value) => value.name === name && value.providerId === provider.id,
        ) ??
        (await api.runtimes.create({
          name,
          providerId: provider.id,
          credentialId: credential.id,
          modelId,
          executionProtocol: 'GENERATION',
        }));
      const connection = await api.runtimes.testConnection(runtime.id);
      if (!connection.ok) throw new Error('MODEL_CONNECTION_FAILED');
      return api.teammates.create({
        name,
        avatar: 'preset:01',
        title: null,
        description: '',
        identityPrompt: '',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
    },
    { provider, credential, modelId, name },
  );
}
async function capture(name) {
  for (const summary of await page
    .locator('details.g2-generation-tool-panel[open] > summary')
    .all())
    await summary.click();
  for (const width of [1440, 1180, 900]) {
    const win = await app.browserWindow(page);
    await win.evaluate((window, size) => window.setContentSize(size, 900), width);
    await page.setViewportSize({ width, height: 900 });
    await delay(150);
    const filename = `${name}-${width}.png`;
    await capturePackagedWindow(app, page, join(evidence, filename));
    if (!facts.screenshots.includes(filename)) facts.screenshots.push(filename);
  }
}
async function runCase(spec, inputs = []) {
  const record = facts.cases[spec.caseId] ?? {
    api: 'NOT_RUN',
    adapter: 'NOT_RUN',
    integration: 'NOT_RUN',
    packaged: 'NOT_RUN',
  };
  facts.cases[spec.caseId] = record;
  try {
    const teammate = await actor(spec.adapter, spec.model, spec.keyIndex, spec.baseUrl, spec.name);
    record.teammateId = teammate.id;
    await page.evaluate((id) => {
      window.location.hash = `/generation-chat/${encodeURIComponent(id)}`;
    }, teammate.id);
    await page.locator('[data-testid="generation-chat-page"]').waitFor();
    await page.locator('.g2-generation-descriptor').waitFor({ timeout: 60_000 });
    let conversations = await page.evaluate(
      (id) => window.cultivation.generationChat.listConversations(id),
      teammate.id,
    );
    let conversation = conversations[0];
    if (!conversation)
      conversation = await page.evaluate(
        (id) => window.cultivation.generationChat.createConversation({ teammateId: id }),
        teammate.id,
      );
    // Remount to select the persisted conversation, then submit only if the unique intent is absent.
    await page.evaluate(() => {
      window.location.hash = '/teammates';
    });
    await page.getByRole('heading', { name: '道友', exact: true }).waitFor();
    await page.evaluate((id) => {
      window.location.hash = `/generation-chat/${encodeURIComponent(id)}`;
    }, teammate.id);
    await page.locator('#generation-chat-prompt').waitFor();
    let detail = await page.evaluate((ref) => window.cultivation.generationChat.detail(ref), {
      teammateId: teammate.id,
      conversationId: conversation.id,
    });
    const prior = detail.entries.find((value) => value.message.content === spec.prompt);
    if (!prior) {
      if (record.jobId) {
        assert.notEqual(
          record.state,
          'UNKNOWN',
          'Never create a replacement for an uncertain submission',
        );
        record.previousAttempts ??= [];
        record.previousAttempts.push({
          jobId: record.jobId,
          providerJobId: record.providerJobId ?? null,
          state: record.state,
          errorCode: record.errorCode,
        });
        record.api = record.adapter = record.integration = record.packaged = 'NOT_RUN';
      }
      if (inputs.length) {
        // Select the Main-provided opaque Artifact; Renderer never submits a path.
        await page
          .locator('.g2-generation-tool-panel')
          .filter({ hasText: '可用素材' })
          .locator('summary')
          .click();
        const available = await page.evaluate(() =>
          window.cultivation.generationChat.listAttachments(),
        );
        const index = available.findIndex((value) => value.id === inputs[0].artifactId);
        assert.ok(index >= 0);
        const row = page.locator('.g2-generation-attachment').nth(index);
        await row.getByRole('checkbox').check();
        await row.locator('select').selectOption(inputs[0].role);
      }
      if (Object.keys(spec.parameters).length > 0)
        await page
          .locator('.g2-generation-tool-panel')
          .filter({ hasText: '生成参数' })
          .locator('summary')
          .click();
      for (const [key, value] of Object.entries(spec.parameters)) {
        const control = page.locator(`[data-testid="generation-chat-composer"] [name="${key}"]`);
        // Parameter controls are label-based; inspect exact associated field where no name exists.
        let target = control;
        if (!(await target.count())) {
          const labels = {
            durationSeconds: '时长',
            resolution: '清晰度',
            aspect: '画面比例',
            voice: '音色',
            version: '版本',
            audioFormat: '音频格式',
            size: '画面比例',
          };
          target = page.getByLabel(labels[key] ?? key, { exact: false });
        }
        if (await target.count()) {
          const tag = await target.first().evaluate((element) => element.tagName);
          if (tag === 'SELECT') await target.first().selectOption(String(value));
          else await target.first().fill(String(value));
        } else throw new Error(`PARAMETER_CONTROL_MISSING:${key}`);
      }
      await page.locator('#generation-chat-prompt').fill(spec.prompt);
      record.intentAt = new Date().toISOString();
      await save();
      await page.locator('[data-testid="generation-chat-composer"] button[type="submit"]').click();
    }
    const deadline = Date.now() + 15 * 60_000;
    let entry;
    while (Date.now() < deadline) {
      detail = await page.evaluate((ref) => window.cultivation.generationChat.refresh(ref), {
        teammateId: teammate.id,
        conversationId: conversation.id,
      });
      entry = detail.entries.find((value) => value.message.content === spec.prompt);
      if (entry?.job && ['COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(entry.job.state))
        break;
      if (entry?.preparationErrorCode) throw new Error(entry.preparationErrorCode);
      await delay(5000);
    }
    record.jobId = entry?.job?.id ?? null;
    record.providerJobId = entry?.job?.providerJobId ?? null;
    record.state = entry?.job?.state ?? 'PENDING';
    record.errorCode = entry?.job?.errorCode ?? null;
    if (entry?.job?.providerJobId) record.api = record.adapter = 'PASS';
    if (entry?.job?.state !== 'COMPLETED')
      throw new Error(`GENERATION_${record.state}:${record.errorCode ?? ''}`);
    delete record.failure;
    record.integration = 'PASS';
    record.artifacts = entry.artifacts.map((value) => ({
      id: value.id,
      kind: value.kind,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes,
      contentHash: value.contentHash,
    }));
    // Confirm trusted task snapshot, adapter durable barrier, sealed binding and all outputs persisted.
    record.persistence = readFacts((db) => ({
      integrity: db.pragma('integrity_check', { simple: true }),
      binding: db
        .prepare(
          'SELECT adapter_id,model_id,execution_protocol,credential_id FROM teammate_model_bindings WHERE teammate_id=?',
        )
        .get(teammate.id),
      inputs: JSON.parse(
        db
          .prepare('SELECT task_json FROM generation_tasks WHERE id=?')
          .get(entry.job.generationTaskId).task_json,
      ).inputs,
    }));
    await page
      .locator('[data-testid="generation-artifact-card"]')
      .first()
      .waitFor({ timeout: 30000 });
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(
          '[data-testid="generation-artifact-card"] img, [data-testid="generation-artifact-card"] audio, [data-testid="generation-artifact-card"] video',
        ).length === count,
      entry.artifacts.length,
      { timeout: 30000 },
    );
    const media = await page
      .locator(
        '[data-testid="generation-artifact-card"] img, [data-testid="generation-artifact-card"] audio, [data-testid="generation-artifact-card"] video',
      )
      .all();
    assert.equal(media.length, entry.artifacts.length);
    record.playback = [];
    for (const element of media) {
      const check = await element.evaluate(async (value) => {
        if (value.tagName === 'IMG') {
          if (!value.complete)
            await new Promise((resolve, reject) => {
              value.onload = resolve;
              value.onerror = reject;
            });
          return {
            kind: 'IMAGE',
            width: value.naturalWidth,
            loaded: value.complete && value.naturalWidth > 0,
            opaque: value.src.startsWith('cultivation-media:'),
          };
        }
        await value.play();
        for (let attempt = 0; attempt < 40 && value.currentTime === 0; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 200));
        const result = {
          kind: value.tagName,
          loaded: value.readyState >= 2,
          currentTime: value.currentTime,
          duration: value.duration,
          opaque: value.src.startsWith('cultivation-media:'),
          progressed: value.currentTime > 0,
        };
        value.pause();
        return result;
      });
      assert.equal(check.loaded && check.opaque, true);
      if (check.kind !== 'IMAGE')
        assert.equal(check.progressed, true, 'Real playback clock must advance');
      record.playback.push(check);
    }
    await capture(spec.caseId.toLowerCase());
    record.packaged = 'PASS';
    if (record.failure) {
      record.recoveredFailure = record.failure;
      delete record.failure;
    }
    record.finishedAt = new Date().toISOString();
    await save();
    console.log(`${spec.caseId}: ${record.state} / ${entry.artifacts.length} Artifact`);
    return entry.artifacts;
  } catch (error) {
    record.failure = clean(error?.message ?? 'LIVE_CASE_FAILED');
    if (record.packaged !== 'PASS') record.packaged = 'BLOCKED';
    process.exitCode = 1;
    await save();
    console.log(`${spec.caseId}: BLOCKED ${record.failure}`);
    return [];
  }
}
try {
  await launch();
  const api = { adapter: 'APIMART_ASYNC', keyIndex: 0, baseUrl: 'https://api.apimart.ai/v1' };
  if (stage === 'apimart') {
    const images = await runCase({
      ...api,
      caseId: 'LIVE_APIMART_IMAGE',
      model: 'gemini-3.1-flash-lite-image',
      name: '绘图道友',
      prompt: '白色背景上的蓝色圆形小机器人，简洁插画，无文字。',
      parameters: { aspect: '1:1' },
    });
    await runCase({
      ...api,
      caseId: 'LIVE_APIMART_VIDEO_T2V',
      model: 'wan2.7',
      name: '视频道友',
      prompt: '一片绿叶在微风中轻轻摆动，镜头固定。',
      parameters: { durationSeconds: 2, resolution: '720P', aspect: '16:9' },
    });
    if (images.length)
      await runCase(
        {
          ...api,
          caseId: 'LIVE_APIMART_VIDEO_I2V',
          model: 'wan2.7',
          name: '图生视频道友',
          prompt: '画面中的小机器人轻轻挥手，保持背景和构图。',
          parameters: { durationSeconds: 2, resolution: '720P', aspect: '16:9' },
        },
        [{ artifactId: images[0].id, role: 'FIRST_FRAME' }],
      );
    await runCase({
      ...api,
      caseId: 'LIVE_APIMART_MUSIC',
      model: 'suno',
      name: '音乐道友',
      prompt: '轻柔钢琴纯音乐，安静的清晨，无人声。',
      parameters: { version: 'v6', audioFormat: 'wav' },
    });
  }
  if (stage === 'apimart-music-corrective')
    await runCase({
      ...api,
      caseId: 'LIVE_APIMART_MUSIC',
      model: 'suno',
      name: '音乐道友',
      prompt: '轻柔钢琴纯音乐，清晨花园的安静氛围，无人声。',
      parameters: { version: 'v6', audioFormat: 'wav' },
    });
  if (stage === 'apimart-video-corrective')
    await runCase({
      ...api,
      caseId: 'LIVE_APIMART_VIDEO_T2V',
      model: 'wan2.7',
      name: '视频道友',
      prompt: '一片小绿叶随微风轻轻摆动，固定镜头，无文字。',
      parameters: { durationSeconds: 2, resolution: '720P', aspect: '16:9' },
    });
  if (stage === 'mimo')
    await runCase({
      adapter: 'MIMO_TTS',
      keyIndex: 1,
      baseUrl: 'https://api.xiaomimimo.com/v1',
      caseId: 'LIVE_MIMO_TTS',
      model: 'mimo-v2.5-tts',
      name: '朗读道友',
      prompt: '你好，这是一段简短的语音测试。愿今天的工作顺利。',
      parameters: { voice: '冰糖' },
    });
  if (stage === 'tokenrhythm') {
    for (const [model, name, caseId] of [
      ['qwen-image-2.0', '通义绘图道友', 'LIVE_TOKENRHYTHM_QWEN_IMAGE'],
      ['wan2.7-image', '万相绘图道友', 'LIVE_TOKENRHYTHM_WAN_IMAGE'],
    ])
      await runCase({
        adapter: 'TOKENRHYTHM_ASYNC',
        keyIndex: 3,
        baseUrl: 'https://tokenrhythm.studio/v1',
        model,
        name,
        caseId,
        prompt: '白色背景上一朵黄色小花，简洁插画，无文字。',
        parameters: {},
      });
  }
  if (stage === 'history') {
    for (const [caseId, record] of Object.entries(facts.cases)) {
      if (record.state !== 'COMPLETED') continue;
      const before = readFacts((db) =>
        db
          .prepare(
            'SELECT id,job_id,content_hash FROM generation_artifacts WHERE job_id=? ORDER BY id',
          )
          .all(record.jobId),
      );
      await page.evaluate((id) => {
        window.location.hash = `/generation-chat/${encodeURIComponent(id)}`;
      }, record.teammateId);
      await page
        .locator('[data-testid="generation-artifact-card"]')
        .first()
        .waitFor({ timeout: 30_000 });
      const playback = await page
        .locator(
          '[data-testid="generation-artifact-card"] audio, [data-testid="generation-artifact-card"] video',
        )
        .evaluateAll(async (elements) => {
          const results = [];
          for (const value of elements) {
            await value.play();
            for (let attempt = 0; attempt < 40 && value.currentTime === 0; attempt++)
              await new Promise((resolve) => setTimeout(resolve, 200));
            results.push({
              loaded: value.readyState >= 2,
              currentTime: value.currentTime,
              duration: value.duration,
              opaque: value.src.startsWith('cultivation-media:'),
            });
            value.pause();
          }
          return results;
        });
      assert.ok(playback.every((value) => value.loaded && value.opaque && value.currentTime > 0));
      record.restartPlayback = playback;
      const images = await page
        .locator('[data-testid="generation-artifact-card"] img')
        .evaluateAll((elements) =>
          elements.map((value) => ({
            loaded: value.complete && value.naturalWidth > 0,
            opaque: value.src.startsWith('cultivation-media:'),
          })),
        );
      assert.ok(images.every((value) => value.loaded && value.opaque));
      record.restartImages = images;
      const after = readFacts((db) =>
        db
          .prepare(
            'SELECT id,job_id,content_hash FROM generation_artifacts WHERE job_id=? ORDER BY id',
          )
          .all(record.jobId),
      );
      assert.deepEqual(after, before);
      record.restartHistory = 'PASS';
      await capture(`${caseId.toLowerCase()}-restart`);
    }
    await save();
  }
} finally {
  await app?.close().catch(() => undefined);
  await save();
}
