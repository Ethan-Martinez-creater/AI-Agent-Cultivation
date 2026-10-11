/* global document */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  lstatSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { startGenHttpV1Fixture } from './fixtures/gen-http-v1.mjs';

const root = process.cwd();
const runId = randomUUID();
const runDirectory = join(root, '.test-data', `gen-http-v1-packaged-${runId}`);
const profile = join(runDirectory, 'production-profile');
const mediaDirectory = join(runDirectory, 'media');
const evidence = join(runDirectory, 'evidence');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const fixture = await startGenHttpV1Fixture();
const facts = {
  runId,
  package: {
    fakeGenerationFlag: false,
    executable: relative(root, executablePath),
  },
  upstream: 'offline loopback HTTP fixture',
  fixture: null,
  scenarios: {},
  screenshots: [],
  restart: { sameJobsAndArtifacts: false, verified: [] },
  failure: null,
};
const scenarios = [
  {
    key: 'image',
    modelId: 'fixture-image',
    capability: 'IMAGE_GENERATION',
    label: '描述想生成的图片',
    teammateName: '图片生成验证',
    prompt: '离线图片验证：一盏灯照亮安静的湖面',
    mimeType: 'image/png',
  },
  {
    key: 'video',
    modelId: 'fixture-video',
    capability: 'VIDEO_GENERATION',
    label: '描述想生成的视频',
    teammateName: '视频生成验证',
    prompt: '首帧延续：湖面微风吹动树影，镜头缓慢推进',
    mimeType: 'video/mp4',
  },
  {
    key: 'music',
    modelId: 'fixture-music',
    capability: 'MUSIC_GENERATION',
    label: '描述想生成的音乐',
    teammateName: '音乐生成验证',
    prompt: '离线音乐验证：平静、简短的钢琴主题',
    mimeType: 'audio/wav',
  },
  {
    key: 'speech',
    modelId: 'fixture-speech',
    capability: 'SPEECH_GENERATION',
    label: '朗读原文',
    teammateName: '语音生成验证',
    prompt: '离线语音验证：欢迎回到安静的湖畔。',
    mimeType: 'audio/wav',
  },
];

mkdirSync(profile, { recursive: true });
mkdirSync(mediaDirectory, { recursive: true });
mkdirSync(evidence, { recursive: true });
assert.equal(
  process.argv.some((argument) => /--g\d+-fake-generation/iu.test(argument)),
  false,
  'Packaged GEN_HTTP_V1 smoke must not run with a fake-generation flag',
);

let live = null;

async function launch(profilePath) {
  const app = await electron.launch({
    executablePath,
    args: [],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profilePath },
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 60_000 });
    await page.setViewportSize({ width: 1440, height: 900 });
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function closeLive() {
  if (!live) return;
  const current = live;
  live = null;
  await current.app.close().catch(() => undefined);
}

function read(profilePath, query) {
  const db = new Database(join(profilePath, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

async function captureThreeWidths(page, name) {
  const dimensions = [
    { width: 1440, height: 900 },
    { width: 900, height: 900 },
    { width: 390, height: 844 },
  ];
  for (const size of dimensions) {
    const browserWindow = await live.app.browserWindow(page);
    await browserWindow.evaluate(
      (win, viewport) => win.setContentSize(viewport.width, viewport.height),
      size,
    );
    await page.setViewportSize(size);
    const path = join(evidence, `${name}-${size.width}x${size.height}.png`);
    await page.screenshot({ path });
    facts.screenshots.push(relative(root, path));
  }
  const browserWindow = await live.app.browserWindow(page);
  await browserWindow.evaluate((win) => win.setContentSize(1440, 900));
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function seedIdentities(page, baseUrl) {
  return page.evaluate(
    async ({ endpoint, models }) => {
      const provider = await window.cultivation.providers.create({
        name: 'GEN_HTTP_V1 离线媒体服务',
        kind: 'GENERATION_HTTP',
        adapterId: 'GEN_HTTP_V1',
        baseUrl: endpoint,
      });
      const identities = {};
      for (const model of models) {
        const runtime = await window.cultivation.runtimes.create({
          name: `GEN_HTTP_V1 ${model.key}`,
          providerId: provider.id,
          credentialId: null,
          modelId: model.modelId,
          executionProtocol: 'GENERATION',
        });
        const connection = await window.cultivation.runtimes.testConnection(runtime.id);
        if (!connection.ok) throw new Error(`GEN_HTTP_V1 connection failed for ${model.modelId}`);
        const teammate = await window.cultivation.teammates.create({
          name: model.teammateName,
          avatar: 'preset:01',
          title: null,
          description: '本地离线生成验收对象',
          identityPrompt: '',
          behaviorPrompt: '',
          currentRuntimeProfileId: runtime.id,
        });
        identities[model.key] = {
          providerId: provider.id,
          runtimeId: runtime.id,
          teammateId: teammate.id,
        };
      }
      return identities;
    },
    { endpoint: baseUrl, models: scenarios },
  );
}

async function openGenerationChat(page, scenario, teammateId) {
  await page.evaluate((id) => {
    window.location.hash = `/generation-chat/${encodeURIComponent(id)}`;
  }, teammateId);
  await page
    .getByRole('textbox', { name: scenario.label, exact: true })
    .waitFor({ timeout: 30_000 });
  await page.locator('.g2-generation-descriptor').waitFor({ timeout: 30_000 });
}

async function createConversation(page) {
  const empty = page.getByTestId('empty-generation-chat');
  await empty.waitFor({ timeout: 30_000 });
  await empty.getByRole('button', { name: /开始新对话/u }).click();
  await page.getByTestId('generation-chat-composer').waitFor({ timeout: 30_000 });
}

async function importGeneratedImage(page, generatedImagePath, expectedHash) {
  await live.app.evaluate(({ dialog }, selectedFile) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFile] });
  }, generatedImagePath);
  const panel = page.locator('.g2-generation-tool-panel').first();
  await panel.locator('summary').click();
  await page.getByRole('button', { name: '从文件导入', exact: true }).click();
  const rolePicker = page.getByLabel('素材用途：image-generated.png', { exact: true });
  await rolePicker.waitFor({ timeout: 30_000 });
  await rolePicker.selectOption('FIRST_FRAME');
  const attachments = await page.evaluate(() =>
    window.cultivation.generationChat.listAttachments(),
  );
  const imported = attachments.find(
    (attachment) =>
      attachment.name === 'image-generated.png' && attachment.contentHash === expectedHash,
  );
  assert(
    imported,
    'The image Artifact must re-enter through typed picker IPC with its original bytes',
  );
  await panel.locator('summary').click();
  return imported;
}

async function sendPrompt(page, scenario) {
  await page.getByRole('textbox', { name: scenario.label, exact: true }).fill(scenario.prompt);
  await page.locator('[data-testid="generation-chat-composer"] button[type="submit"]').click();
  await page.waitForFunction(
    (prompt) =>
      [...document.querySelectorAll('[data-testid="generation-entry"]')].some(
        (entry) =>
          entry.querySelector('.g2-generation-user-message .r33-message-surface p')?.textContent ===
          prompt,
      ),
    scenario.prompt,
    { timeout: 30_000 },
  );
}

async function waitForJobState(page, prompt, state, timeout = 90_000) {
  await page.waitForFunction(
    ({ text, expectedState }) => {
      const entry = [...document.querySelectorAll('[data-testid="generation-entry"]')].find(
        (item) =>
          item.querySelector('.g2-generation-user-message .r33-message-surface p')?.textContent ===
          text,
      );
      return Boolean(
        entry?.querySelector(
          `[data-testid="generation-job-card"].state-${expectedState.toLowerCase()}`,
        ),
      );
    },
    { text: prompt, expectedState: state },
    { timeout },
  );
}

async function conversationDetail(page, teammateId) {
  const conversations = await page.evaluate(
    async (id) => window.cultivation.generationChat.listConversations(id),
    teammateId,
  );
  assert.equal(conversations.length, 1, 'Each packaged scenario uses one fresh conversation');
  const conversation = conversations[0];
  const detail = await page.evaluate(
    async (reference) => window.cultivation.generationChat.detail(reference),
    { teammateId, conversationId: conversation.id },
  );
  return { conversation, detail };
}

function entryFor(detail, prompt) {
  const entry = detail.entries.find((value) => value.message.content === prompt);
  assert(entry, `Missing generation chat entry for ${prompt}`);
  return entry;
}

function assertOpaqueUrl(url, artifactId) {
  assert.match(
    url,
    /^cultivation-media:\/\/artifact\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  );
  assert(
    !url.endsWith(artifactId),
    'Renderer preview exposes an opaque token, not the Artifact id',
  );
  assert(!url.includes(fixture.baseUrl));
  assert(!url.includes(profile));
  assert(!url.includes(root));
  assert(!/api.?key|token=|key=/iu.test(url));
}

async function waitForMedia(page, mimeType) {
  if (mimeType.startsWith('image/')) {
    const image = page.locator('img.g2-generation-image').last();
    await image.waitFor({ timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const images = [...document.querySelectorAll('img.g2-generation-image')];
        const imageElement = images.at(-1);
        return Boolean(imageElement?.complete && imageElement.naturalWidth > 0);
      },
      undefined,
      { timeout: 30_000 },
    );
    return image.evaluate((element) => ({
      src: element.getAttribute('src'),
      currentSrc: element.currentSrc,
      complete: element.complete,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
    }));
  }
  if (mimeType === 'video/mp4') {
    const video = page.locator('video.g2-generation-video').last();
    await video.waitFor({ timeout: 30_000 });
    await video.evaluate(async (element) => {
      element.muted = true;
      await element.play();
    });
    await page.waitForFunction(
      () => {
        const videos = [...document.querySelectorAll('video.g2-generation-video')];
        const element = videos.at(-1);
        return Boolean(element && !element.paused && element.readyState >= 2);
      },
      undefined,
      { timeout: 30_000 },
    );
    const diagnostics = await video.evaluate((element) => ({
      src: element.getAttribute('src'),
      currentSrc: element.currentSrc,
      readyState: element.readyState,
      videoWidth: element.videoWidth,
      videoHeight: element.videoHeight,
      paused: element.paused,
      errorCode: element.error?.code ?? null,
    }));
    await video.evaluate((element) => element.pause());
    assert.equal(diagnostics.errorCode, null);
    return diagnostics;
  }

  assert.equal(mimeType, 'audio/wav');
  const audio = page.locator('audio.g2-generation-audio').last();
  await audio.waitFor({ timeout: 30_000 });
  await audio.evaluate(async (element) => {
    element.muted = true;
    await element.play();
  });
  await page.waitForFunction(
    () => {
      const players = [...document.querySelectorAll('audio.g2-generation-audio')];
      const element = players.at(-1);
      return Boolean(element && !element.paused && element.readyState >= 2);
    },
    undefined,
    { timeout: 30_000 },
  );
  const diagnostics = await audio.evaluate((element) => ({
    src: element.getAttribute('src'),
    currentSrc: element.currentSrc,
    readyState: element.readyState,
    duration: element.duration,
    paused: element.paused,
    errorCode: element.error?.code ?? null,
  }));
  await audio.evaluate((element) => element.pause());
  assert.equal(diagnostics.errorCode, null);
  return diagnostics;
}

async function captureOpaqueUrl(page, artifactId) {
  const url = await page.evaluate(
    (id) => window.cultivation.generationChat.artifactUrl(id),
    artifactId,
  );
  assertOpaqueUrl(url, artifactId);
  return url;
}

function readArtifact(profilePath, artifactId) {
  return read(profilePath, (db) =>
    db
      .prepare(
        `SELECT id,mime_type,extension,size_bytes,content_hash,storage_scope,storage_key
         FROM generation_artifacts WHERE id=?`,
      )
      .get(artifactId),
  );
}

function copyArtifactIntoPickerFixture(profilePath, artifactId, targetPath) {
  const artifact = readArtifact(profilePath, artifactId);
  assert(artifact, 'Generated image Artifact must be durable before I2V continues');
  assert.equal(artifact.mime_type, 'image/png');
  assert.equal(artifact.storage_scope, 'APP_ARTIFACT_STORE');
  const pieces = String(artifact.storage_key).split('/');
  assert(pieces.length >= 2 && pieces.every((part) => part && part !== '.' && part !== '..'));
  const artifactRoot = resolve(profilePath, 'generation-artifacts');
  const sourcePath = resolve(artifactRoot, ...pieces);
  assert(sourcePath.toLowerCase().startsWith(`${artifactRoot}${sep}`.toLowerCase()));
  const sourceInfo = lstatSync(sourcePath);
  assert(sourceInfo.isFile() && !sourceInfo.isSymbolicLink());
  copyFileSync(sourcePath, targetPath);
  const copied = readFileSync(targetPath);
  assert.equal(copied.length, artifact.size_bytes);
  assert.equal(createHash('sha256').update(copied).digest('hex'), artifact.content_hash);
  return { artifact, targetPath };
}

function auditBinding(profilePath, teammateId) {
  return read(profilePath, (db) =>
    db
      .prepare(
        `SELECT b.runtime_profile_id AS runtimeId,
                p.kind AS providerKind,p.adapter_id AS providerAdapter,p.base_url AS providerEndpoint,
                rp.execution_protocol AS runtimeProtocol,rp.model_id AS runtimeModel,
                b.provider_kind AS bindingProvider,b.adapter_id AS bindingAdapter,
                b.execution_protocol AS bindingProtocol,b.endpoint AS bindingEndpoint,
                b.model_id AS bindingModel,b.credential_id AS bindingCredential
         FROM teammate_model_bindings AS b
         JOIN runtime_profiles AS rp ON rp.id=b.runtime_profile_id
         JOIN providers AS p ON p.id=rp.provider_id
         WHERE b.teammate_id=?`,
      )
      .get(teammateId),
  );
}

function auditJob(profilePath, jobId) {
  return read(profilePath, (db) => {
    const job = db.prepare('SELECT id,state,error_code FROM generation_jobs WHERE id=?').get(jobId);
    const artifacts = db
      .prepare(
        `SELECT id,mime_type,extension,size_bytes,content_hash,storage_scope
         FROM generation_artifacts WHERE job_id=? ORDER BY created_at,output_id,id`,
      )
      .all(jobId);
    return { job, artifacts };
  });
}

async function runScenario(scenario, identity, imageSource) {
  await openGenerationChat(live.page, scenario, identity.teammateId);
  await createConversation(live.page);

  let importedInput = null;
  if (scenario.key === 'video') {
    assert(imageSource, 'I2V smoke requires the prior generated image Artifact');
    importedInput = await importGeneratedImage(
      live.page,
      imageSource.targetPath,
      imageSource.artifact.content_hash,
    );
    facts.scenarios.i2vLineage = {
      sourceImageJobId: facts.scenarios.image.jobId,
      sourceImageArtifactId: imageSource.artifact.id,
      importedInputArtifactId: importedInput.id,
      sourceAndUploadHashMatch: importedInput.contentHash === imageSource.artifact.content_hash,
    };
    assert.equal(importedInput.contentHash, imageSource.artifact.content_hash);
  }

  await sendPrompt(live.page, scenario);
  await waitForJobState(live.page, scenario.prompt, 'COMPLETED');
  const { detail } = await conversationDetail(live.page, identity.teammateId);
  const entry = entryFor(detail, scenario.prompt);
  assert.equal(entry.job?.state, 'COMPLETED');
  assert.equal(entry.artifacts.length, 1);
  assert.equal(entry.artifacts[0].mimeType, scenario.mimeType);
  if (scenario.key === 'video') {
    assert.equal(entry.inputs.length, 1);
    assert.equal(entry.inputs[0].role, 'FIRST_FRAME');
    assert.equal(entry.inputs[0].artifactId, importedInput.id);
  } else {
    assert.equal(entry.inputs.length, 0);
  }

  const opaqueUrl = await captureOpaqueUrl(live.page, entry.artifacts[0].id);
  const mediaDiagnostics = await waitForMedia(live.page, scenario.mimeType);
  await captureThreeWidths(live.page, scenario.key);

  const binding = auditBinding(profile, identity.teammateId);
  assert(binding);
  assert.equal(binding.providerKind, 'GENERATION_HTTP');
  assert.equal(binding.providerAdapter, 'GEN_HTTP_V1');
  assert.equal(binding.bindingProvider, 'GENERATION_HTTP');
  assert.equal(binding.bindingAdapter, 'GEN_HTTP_V1');
  assert.equal(binding.runtimeProtocol, 'GENERATION');
  assert.equal(binding.bindingProtocol, 'GENERATION');
  assert.equal(binding.providerEndpoint, fixture.baseUrl);
  assert.equal(binding.bindingEndpoint, fixture.baseUrl);
  assert.equal(binding.runtimeModel, scenario.modelId);
  assert.equal(binding.bindingModel, scenario.modelId);
  assert.equal(binding.bindingCredential, null);

  const database = auditJob(profile, entry.job.id);
  assert.equal(database.job?.state, 'COMPLETED');
  assert.equal(database.artifacts.length, 1);
  assert.equal(database.artifacts[0].id, entry.artifacts[0].id);
  assert.equal(database.artifacts[0].mime_type, scenario.mimeType);

  const result = {
    providerId: identity.providerId,
    runtimeId: identity.runtimeId,
    teammateId: identity.teammateId,
    conversationId: detail.conversation.id,
    jobId: entry.job.id,
    state: entry.job.state,
    artifactIds: entry.artifacts.map((artifact) => artifact.id),
    mimeType: entry.artifacts[0].mimeType,
    contentHash: entry.artifacts[0].contentHash,
    sizeBytes: entry.artifacts[0].sizeBytes,
    opaqueArtifactUrl: opaqueUrl,
    preview: mediaDiagnostics,
    inputArtifactId: importedInput?.id ?? null,
    inputContentHash: importedInput?.contentHash ?? null,
    sealedAdapter: binding.providerAdapter,
  };
  facts.scenarios[scenario.key] = result;
  return scenario.key === 'image'
    ? copyArtifactIntoPickerFixture(
        profile,
        entry.artifacts[0].id,
        join(mediaDirectory, 'image-generated.png'),
      )
    : null;
}

async function verifyAfterRestart() {
  for (const scenario of scenarios) {
    const identity = identities[scenario.key];
    await openGenerationChat(live.page, scenario, identity.teammateId);
    await waitForJobState(live.page, scenario.prompt, 'COMPLETED');
    const { detail } = await conversationDetail(live.page, identity.teammateId);
    const entry = entryFor(detail, scenario.prompt);
    const original = facts.scenarios[scenario.key];
    assert.equal(entry.job?.id, original.jobId, `${scenario.key} must resume its original Job`);
    assert.equal(entry.job?.state, 'COMPLETED');
    assert.deepEqual(
      entry.artifacts.map((artifact) => artifact.id),
      original.artifactIds,
      `${scenario.key} must retain the original Artifact identities`,
    );
    const opaqueUrl = await captureOpaqueUrl(live.page, entry.artifacts[0].id);
    assert.notEqual(
      opaqueUrl,
      original.opaqueArtifactUrl,
      'Restart must issue a fresh preview token',
    );
    const preview = await waitForMedia(live.page, scenario.mimeType);
    const database = auditJob(profile, original.jobId);
    assert.equal(database.job?.state, 'COMPLETED');
    assert.deepEqual(
      database.artifacts.map((artifact) => artifact.id),
      original.artifactIds,
    );
    facts.restart.verified.push({
      capability: scenario.capability,
      jobId: entry.job.id,
      artifactIds: original.artifactIds,
      previewReady: scenario.mimeType.startsWith('image/')
        ? preview.naturalWidth > 0
        : preview.readyState >= 2,
    });
  }
  facts.restart.sameJobsAndArtifacts = facts.restart.verified.length === scenarios.length;
  assert.equal(facts.restart.sameJobsAndArtifacts, true);
}

const identities = {};

async function main() {
  assert.match(fixture.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
  assert.equal(
    existsSync(executablePath),
    true,
    `Packaged Electron executable not found: ${executablePath}`,
  );
  live = await launch(profile);
  Object.assign(identities, await seedIdentities(live.page, fixture.baseUrl));

  let imageSource = null;
  for (const scenario of scenarios) {
    const identity = identities[scenario.key];
    assert(identity, `Missing sealed runtime identity for ${scenario.modelId}`);
    imageSource = (await runScenario(scenario, identity, imageSource)) ?? imageSource;
  }

  assert.equal(fixture.facts.submissions.length, 4);
  assert.equal(fixture.facts.downloads, 4);
  assert.equal(fixture.facts.uploads.length, 1, 'The generated PNG is uploaded once for I2V');
  const videoRequest = fixture.facts.submissions.find(
    (request) => request.capability === 'VIDEO_GENERATION',
  );
  assert(videoRequest);
  assert.equal(videoRequest.requiredFeatures.includes('IMAGE_TO_VIDEO'), true);
  assert.equal(videoRequest.inputs.length, 1);
  assert.equal(videoRequest.inputs[0].role, 'FIRST_FRAME');
  assert.equal(
    fixture.facts.uploads[0].contentHash,
    facts.scenarios.image.contentHash,
    'I2V upload must carry the previously generated image bytes',
  );

  facts.fixture = {
    baseUrl: fixture.baseUrl,
    uploads: fixture.facts.uploads,
    submissions: fixture.facts.submissions,
    postAttempts: fixture.facts.postAttempts,
    downloads: fixture.facts.downloads,
    statusQueries: fixture.facts.statusQueries,
    healthChecks: fixture.facts.healthChecks,
    modelQueries: fixture.facts.modelQueries,
  };

  await closeLive();
  live = await launch(profile);
  await verifyAfterRestart();
  const counts = read(profile, (db) => ({
    generationJobs: db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n,
    generationArtifacts: db.prepare('SELECT COUNT(*) AS n FROM generation_artifacts').get().n,
    conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
  }));
  assert.equal(counts.generationJobs, 4);
  assert.equal(counts.generationArtifacts, 4);
  assert.equal(counts.conversations, 4);
  facts.database = counts;
}

try {
  await main();
} catch (error) {
  facts.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  throw error;
} finally {
  await closeLive();
  await fixture.close();
  facts.package.fakeGenerationFlag = false;
  writeFileSync(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
}

console.log(
  `GEN_HTTP_V1_PACKAGED_SMOKE_OK capabilities=IMAGE_VIDEO_MUSIC_SPEECH typedIPC=true restart=true screenshots=1440_900_390 productionFlags=true evidence=${relative(root, evidence)}`,
);
