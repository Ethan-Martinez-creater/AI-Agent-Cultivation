/* global document, HTMLMediaElement */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout } from 'node:timers';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { startH3Fixture } from './fixtures/g2-h3-http.mjs';

const root = process.cwd();
const runId = randomUUID();
const dataRoot = join(root, '.test-data', `g2-packaged-${runId}`);
const profile = join(dataRoot, 'production-profile');
const evidenceRoot = join(root, 'docs', 'evidence', 'g2-h3-integration');
const evidence = join(evidenceRoot, runId);
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const pickerFile = join(root, 'scripts', 'fixtures', 'news-media', 'visual.png');
const facts = {
  runId,
  package: { fakeGenerationFlag: false, executable: relative(root, executablePath) },
  screenshots: [],
  scenarios: {},
  failure: null,
  mediaDiagnostics: [],
};

mkdirSync(profile, { recursive: true });
mkdirSync(evidence, { recursive: true });
assert.equal(
  process.argv.slice(2).some((arg) => arg === '--g1-fake-generation'),
  false,
  'G2 packaged smoke must use the production generation foundation',
);

const fixture = await startH3Fixture();
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

async function crashMainProcess(app) {
  const child = app.process();
  const exited = once(child, 'exit');
  // Playwright may expose an Electron launcher wrapper on Windows; kill Electron Main itself.
  const mainPid = await app.evaluate(() => process.pid);
  process.kill(mainPid, 'SIGKILL');
  await exited;
  await app.close().catch(() => undefined);
  return mainPid;
}

function read(profilePath, query) {
  const db = new Database(join(profilePath, 'data', 'cultivation.sqlite'), { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, label, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function capture(page, name) {
  for (const width of [1440, 900]) {
    const window = await live.app.browserWindow(page);
    await window.evaluate((win, size) => win.setContentSize(size, 900), width);
    await page.setViewportSize({ width, height: 900 });
    const path = join(evidence, `${name}-${width}x900.png`);
    await page.screenshot({ path });
    facts.screenshots.push(relative(root, path));
  }
  const window = await live.app.browserWindow(page);
  await window.evaluate((win) => win.setContentSize(1440, 900));
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function openGenerationChat(page, teammateId) {
  await page.evaluate((id) => {
    window.location.hash = `/generation-chat/${encodeURIComponent(id)}`;
  }, teammateId);
  await page.getByRole('textbox', { name: '描述想生成的视频' }).waitFor({ timeout: 30_000 });
  await page.locator('.g2-generation-descriptor').waitFor({ timeout: 30_000 });
}

async function sendPrompt(page, prompt) {
  await page.getByRole('textbox', { name: '描述想生成的视频' }).fill(prompt);
  await page.locator('[data-testid="generation-chat-composer"] button[type="submit"]').click();
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('[data-testid="generation-entry"]')].some(
        (entry) =>
          entry.querySelector('.g2-generation-user-message .r33-message-surface p')?.textContent ===
          text,
      ),
    prompt,
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
    (id) => window.cultivation.generationChat.listConversations(id),
    teammateId,
  );
  assert.equal(conversations.length, 1, 'Smoke profile should contain one generation conversation');
  const conversation = conversations[0];
  const detail = await page.evaluate(
    (reference) => window.cultivation.generationChat.detail(reference),
    { teammateId, conversationId: conversation.id },
  );
  return { conversation, detail };
}

function entryFor(detail, prompt) {
  const entry = detail.entries.find((value) => value.message.content === prompt);
  assert(entry, `Missing generation chat entry for ${prompt}`);
  return entry;
}

async function waitForVideoData(page) {
  await page.locator('video.g2-generation-video').last().waitFor();
  await delay(1500);
  facts.mediaDiagnostics.push(
    await page
      .locator('video.g2-generation-video')
      .last()
      .evaluate((video) => ({
        src: video.getAttribute('src'),
        currentSrc: video.currentSrc,
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
      })),
  );
  await page
    .locator('video.g2-generation-video')
    .last()
    .evaluate(async (video) => {
      video.muted = true;
      await video.play();
    });
  await page.waitForFunction(
    () => {
      const videos = [...document.querySelectorAll('video.g2-generation-video')];
      return videos.length > 0 && videos.at(-1).readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    },
    undefined,
    { timeout: 60_000 },
  );
  return page
    .locator('video.g2-generation-video')
    .last()
    .evaluate((video) => video.readyState);
}

async function seedIdentity(page, baseUrl) {
  return page.evaluate(async (endpoint) => {
    const provider = await window.cultivation.providers.create({
      name: '视频生成服务',
      kind: 'GENERATION_HTTP',
      adapterId: 'H3',
      baseUrl: endpoint,
    });
    const runtime = await window.cultivation.runtimes.create({
      name: 'MiniMax H3',
      providerId: provider.id,
      credentialId: null,
      modelId: 'minimax-h3',
      executionProtocol: 'GENERATION',
    });
    const connection = await window.cultivation.runtimes.testConnection(runtime.id);
    if (!connection.ok) throw new Error('H3 fixture testConnection failed');
    const teammate = await window.cultivation.teammates.create({
      name: '映川',
      avatar: 'preset:01',
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    return { providerId: provider.id, runtimeId: runtime.id, teammateId: teammate.id };
  }, baseUrl);
}

function auditDatabase(profilePath, teammateId) {
  return read(profilePath, (db) => {
    const binding = db
      .prepare(
        `SELECT b.runtime_profile_id AS runtime_id,
                p.kind AS provider_kind,p.adapter_id AS provider_adapter,p.base_url AS provider_endpoint,
                rp.execution_protocol AS runtime_protocol,rp.model_id AS runtime_model,
                b.provider_kind AS binding_provider,b.adapter_id AS binding_adapter,
                b.execution_protocol AS binding_protocol,b.endpoint AS binding_endpoint,
                b.model_id AS binding_model,b.credential_id AS binding_credential
         FROM teammate_model_bindings AS b
         JOIN runtime_profiles AS rp ON rp.id=b.runtime_profile_id
         JOIN providers AS p ON p.id=rp.provider_id
         WHERE b.teammate_id=?`,
      )
      .get(teammateId);
    const messages = db
      .prepare(
        `SELECT m.role,m.actor_type,m.actor_id,m.mission_id,m.content,e.job_id,e.inputs_json
         FROM generation_chat_entries AS e JOIN messages AS m ON m.id=e.message_id
         WHERE e.teammate_id=? ORDER BY e.created_at,e.message_id`,
      )
      .all(teammateId);
    const jobs = db
      .prepare(
        `SELECT j.id,j.state,j.error_code,
                (SELECT COUNT(*) FROM generation_artifacts a WHERE a.job_id=j.id) AS artifact_count
         FROM generation_jobs AS j WHERE j.teammate_id=? ORDER BY j.created_at,j.id`,
      )
      .all(teammateId);
    const submissions = db
      .prepare(`SELECT state_json FROM generation_adapter_submissions WHERE runtime_profile_id=?`)
      .all(binding?.runtime_id ?? null)
      .map((row) => JSON.parse(row.state_json));
    const availability = db
      .prepare('SELECT status,policy_version FROM teammate_model_availability WHERE teammate_id=?')
      .get(teammateId);
    return { binding, messages, jobs, submissions, availability };
  });
}

async function main() {
  assert.equal(
    existsSync(executablePath),
    true,
    `Packaged Electron executable not found: ${executablePath}`,
  );
  live = await launch(profile);
  const identity = await seedIdentity(live.page, fixture.baseUrl);
  facts.scenarios.identity = { seededThroughTypedIpc: true, sealedAdapter: 'H3' };

  await openGenerationChat(live.page, identity.teammateId);
  const createButton = live.page.getByTestId('empty-generation-chat').getByRole('button', {
    name: /开始新对话/,
  });
  await createButton.click();
  await live.page.getByTestId('generation-chat-composer').waitFor();

  const plainPrompt = '纯提示词：晨光照亮海面，镜头平稳向前';
  fixture.mode.hold = true;
  await sendPrompt(live.page, plainPrompt);
  await waitForJobState(live.page, plainPrompt, 'RUNNING');
  await capture(live.page, 'plain-prompt-running');
  fixture.mode.hold = false;
  await waitForJobState(live.page, plainPrompt, 'COMPLETED');
  const plainDetail = await conversationDetail(live.page, identity.teammateId);
  const plainEntry = entryFor(plainDetail.detail, plainPrompt);
  assert.equal(plainEntry.job.state, 'COMPLETED');
  assert.equal(plainEntry.artifacts.length, 1);
  await capture(live.page, 'plain-prompt-before-play');
  const plainReadyState = await waitForVideoData(live.page);
  await capture(live.page, 'plain-prompt-video-ready');
  facts.scenarios.plainPrompt = {
    jobId: plainEntry.job.id,
    state: plainEntry.job.state,
    artifactCount: plainEntry.artifacts.length,
    videoReadyState: plainReadyState,
    heldThenReleased: true,
  };

  // Exercise the actual renderer button and typed IPC. The native OS picker response is fixed to
  // the checked-in PNG fixture in Electron Main; Renderer never receives or supplies a file path.
  await live.app.evaluate(({ dialog }, selectedFile) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFile] });
  }, pickerFile);
  await live.page.locator('.g2-generation-tool-panel').first().locator('summary').click();
  await live.page.getByRole('button', { name: '从文件导入', exact: true }).click();
  const attachmentRole = live.page.getByLabel('素材用途：visual.png', { exact: true });
  await attachmentRole.waitFor({ timeout: 30_000 });
  await attachmentRole.selectOption('FIRST_FRAME');
  const imported = await live.page.evaluate(() =>
    window.cultivation.generationChat.listAttachments(),
  );
  assert.equal(imported.filter((item) => item.mimeType === 'image/png').length, 1);
  assert.equal(imported[0].mimeType, 'image/png');

  const firstFramePrompt = '首帧延续画面：海面上的小船缓慢驶向远处';
  const previousDownloads = fixture.facts.downloads;
  fixture.mode.hold = true;
  fixture.mode.downloadInterrupted = true;
  await sendPrompt(live.page, firstFramePrompt);
  await waitForJobState(live.page, firstFramePrompt, 'RUNNING');
  const firstFrameDetail = await conversationDetail(live.page, identity.teammateId);
  const firstFrameEntry = entryFor(firstFrameDetail.detail, firstFramePrompt);
  const stableFirstFrameJobId = firstFrameEntry.job.id;
  assert.equal(firstFrameEntry.inputs.length, 1);
  assert.equal(firstFrameEntry.inputs[0].role, 'FIRST_FRAME');
  assert.equal(fixture.facts.uploads, 1, 'The imported frame must upload to the H3 fixture');
  assert.equal(fixture.facts.requests.length, 2);
  assert.equal(fixture.facts.requests[1].model, 'minimax-h3');
  assert.equal(fixture.facts.requests[1].media.length, 1);
  assert.equal(fixture.facts.requests[1].media[0].role, 'first_frame');
  await capture(live.page, 'first-frame-job-running');
  fixture.mode.hold = false;

  await waitUntil(
    () => fixture.facts.downloads > previousDownloads,
    'the deliberately interrupted H3 output download',
  );
  assert.equal(fixture.mode.downloadInterrupted, false, 'Interrupted-download mode is one-shot');
  await delay(100);
  const beforeCrash = read(profile, (db) =>
    db.prepare('SELECT id,state FROM generation_jobs WHERE id=?').get(stableFirstFrameJobId),
  );
  assert(beforeCrash);
  assert.notEqual(
    beforeCrash.state,
    'FAILED',
    'Transient download failure must preserve the G1 job',
  );
  const killedPid = await crashMainProcess(live.app);
  live = null;
  facts.scenarios.downloadRecovery = {
    jobIdBeforeRestart: stableFirstFrameJobId,
    stateBeforeRestart: beforeCrash.state,
    mainProcessPidKilled: killedPid,
    interruptedDownloadCount: fixture.facts.downloads - previousDownloads,
  };

  live = await launch(profile);
  await openGenerationChat(live.page, identity.teammateId);
  await waitForJobState(live.page, firstFramePrompt, 'COMPLETED');
  const recoveredDetail = await conversationDetail(live.page, identity.teammateId);
  const recoveredEntry = entryFor(recoveredDetail.detail, firstFramePrompt);
  assert.equal(
    recoveredEntry.job.id,
    stableFirstFrameJobId,
    'Restart must resume the original job',
  );
  assert.equal(recoveredEntry.job.state, 'COMPLETED');
  assert.equal(recoveredEntry.artifacts.length, 1, 'Recovered job registers exactly one artifact');
  const recoveredReadyState = await waitForVideoData(live.page);
  const opaqueUrl = await live.page.evaluate(
    (id) => window.cultivation.generationChat.artifactUrl(id),
    recoveredEntry.artifacts[0].id,
  );
  assert.match(opaqueUrl, /^cultivation-media:\/\/artifact\/[0-9a-f-]{36}$/i);
  assert(!opaqueUrl.includes(fixture.baseUrl));
  assert(!opaqueUrl.includes(pickerFile));
  assert(!/api.?key|token=|key=/i.test(opaqueUrl));
  await capture(live.page, 'recovered-first-frame-video');
  facts.scenarios.nativePickerFirstFrame = {
    pickerInvokedThroughRenderer: true,
    importedMimeType: imported[0].mimeType,
    selectedRole: recoveredEntry.inputs[0].role,
    providerUploadCount: fixture.facts.uploads,
    providerSubmissionMediaRole: fixture.facts.requests[1].media[0].role,
    jobId: recoveredEntry.job.id,
    state: recoveredEntry.job.state,
    artifactCount: recoveredEntry.artifacts.length,
    videoReadyState: recoveredReadyState,
    rendererArtifactUrlIsOpaque: true,
  };
  assert.equal(
    fixture.facts.submissions,
    2,
    'Successful pure and first-frame requests submit once each',
  );
  assert(
    fixture.facts.downloads >= previousDownloads + 2,
    'Interrupted output is downloaded again after restart',
  );

  const unknownPrompt = '未知提交测试：云层缓慢散开';
  fixture.mode.uncertain = true;
  const submissionsBeforeUnknown = fixture.facts.submissions;
  await sendPrompt(live.page, unknownPrompt);
  await waitForJobState(live.page, unknownPrompt, 'UNKNOWN');
  const unknownDetail = await conversationDetail(live.page, identity.teammateId);
  const unknownEntry = entryFor(unknownDetail.detail, unknownPrompt);
  assert.equal(unknownEntry.job.state, 'UNKNOWN');
  assert.equal(unknownEntry.artifacts.length, 0);
  assert.equal(fixture.facts.submissions, submissionsBeforeUnknown + 1);
  await capture(live.page, 'unknown-submission');
  facts.scenarios.unknownSubmission = {
    jobId: unknownEntry.job.id,
    state: unknownEntry.job.state,
    initialSubmissionCount: fixture.facts.submissions,
    artifactCount: unknownEntry.artifacts.length,
  };

  fixture.mode.uncertain = false;
  const countersBeforeUnknownRestart = {
    submissions: fixture.facts.submissions,
    statusQueries: fixture.facts.statusQueries,
    downloads: fixture.facts.downloads,
  };
  await closeLive();
  live = await launch(profile);
  await openGenerationChat(live.page, identity.teammateId);
  await waitForJobState(live.page, unknownPrompt, 'UNKNOWN');
  await delay(4_000);
  assert.deepEqual(
    {
      submissions: fixture.facts.submissions,
      statusQueries: fixture.facts.statusQueries,
      downloads: fixture.facts.downloads,
    },
    countersBeforeUnknownRestart,
    'Restarting an UNKNOWN job must not resubmit, poll, or download it',
  );
  facts.scenarios.unknownRestart = {
    jobId: unknownEntry.job.id,
    state: 'UNKNOWN',
    automaticSubmissions: 0,
    automaticStatusQueries: 0,
    automaticDownloads: 0,
  };

  const countsBeforeOffline = read(profile, (db) => ({
    messages: db
      .prepare('SELECT COUNT(*) AS n FROM generation_chat_entries WHERE teammate_id=?')
      .get(identity.teammateId).n,
    jobs: db
      .prepare('SELECT COUNT(*) AS n FROM generation_jobs WHERE teammate_id=?')
      .get(identity.teammateId).n,
  }));
  const submissionsBeforeOffline = fixture.facts.submissions;
  const healthChecksBeforeOffline = fixture.facts.healthChecks;
  fixture.mode.offline = true;
  const offlinePrompt = '离线时不应被改派：暮色中的山谷';
  await live.page.getByRole('textbox', { name: '描述想生成的视频' }).fill(offlinePrompt);
  await live.page.locator('[data-testid="generation-chat-composer"] button[type="submit"]').click();
  await live.page.getByTestId('generation-chat-error').waitFor({ timeout: 30_000 });
  assert.equal(
    fixture.facts.submissions,
    submissionsBeforeOffline,
    'Unavailable service must not reroute or submit',
  );
  assert(
    fixture.facts.healthChecks > healthChecksBeforeOffline,
    'Send must recheck H3 health before execution',
  );
  const countsAfterOffline = read(profile, (db) => ({
    messages: db
      .prepare('SELECT COUNT(*) AS n FROM generation_chat_entries WHERE teammate_id=?')
      .get(identity.teammateId).n,
    jobs: db
      .prepare('SELECT COUNT(*) AS n FROM generation_jobs WHERE teammate_id=?')
      .get(identity.teammateId).n,
  }));
  assert.deepEqual(
    countsAfterOffline,
    countsBeforeOffline,
    'Unavailable send must create no message or job',
  );
  const offlineAudit = auditDatabase(profile, identity.teammateId);
  assert.equal(offlineAudit.availability.status, 'UNAVAILABLE');
  await capture(live.page, 'offline-unavailable-no-reroute');
  facts.scenarios.offlineUnavailable = {
    availability: offlineAudit.availability.status,
    newMessages: countsAfterOffline.messages - countsBeforeOffline.messages,
    newJobs: countsAfterOffline.jobs - countsBeforeOffline.jobs,
    providerSubmissions: fixture.facts.submissions - submissionsBeforeOffline,
    reroutes: 0,
  };

  const finalAudit = auditDatabase(profile, identity.teammateId);
  const binding = finalAudit.binding;
  assert(binding);
  assert.equal(binding.provider_kind, 'GENERATION_HTTP');
  assert.equal(binding.provider_adapter, 'H3');
  assert.equal(binding.runtime_protocol, 'GENERATION');
  assert.equal(binding.binding_provider, 'GENERATION_HTTP');
  assert.equal(binding.binding_adapter, 'H3');
  assert.equal(binding.binding_protocol, 'GENERATION');
  assert.equal(binding.provider_endpoint, fixture.baseUrl);
  assert.equal(binding.binding_endpoint, fixture.baseUrl);
  assert.equal(binding.runtime_model, 'minimax-h3');
  assert.equal(binding.binding_model, 'minimax-h3');
  assert.equal(binding.binding_credential, null);
  assert.equal(finalAudit.messages.length, 3);
  assert(
    finalAudit.messages.every(
      (message) =>
        message.role === 'USER' &&
        message.actor_type === 'USER' &&
        message.actor_id === 'local-user' &&
        message.mission_id === null,
    ),
    'Generation chat provenance must contain only user-owned messages',
  );
  assert.deepEqual(
    new Set(finalAudit.messages.map((message) => message.content)),
    new Set([plainPrompt, firstFramePrompt, unknownPrompt]),
  );
  const firstFrameMessage = finalAudit.messages.find(
    (message) => message.content === firstFramePrompt,
  );
  assert(firstFrameMessage);
  assert.deepEqual(JSON.parse(firstFrameMessage.inputs_json), [
    { artifactId: imported[0].id, role: 'FIRST_FRAME' },
  ]);
  const finalJobs = finalAudit.jobs;
  assert.equal(
    finalJobs.length,
    3,
    'Only the two successes and one UNKNOWN job should be persisted',
  );
  assert.equal(finalJobs.filter((job) => job.state === 'COMPLETED').length, 2);
  assert.equal(finalJobs.filter((job) => job.state === 'UNKNOWN').length, 1);
  assert.equal(
    finalJobs.reduce((sum, job) => sum + job.artifact_count, 0),
    2,
  );
  assert(
    finalJobs.filter((job) => job.state === 'COMPLETED').every((job) => job.artifact_count === 1),
  );
  const unknownState = finalAudit.submissions.find((state) => state.phase === 'UNKNOWN');
  assert(unknownState, 'Uncertain submission fact must remain durably UNKNOWN');
  facts.database = {
    sealedAdapterIdentity: {
      providerKind: binding.provider_kind,
      providerAdapterId: binding.provider_adapter,
      executionProtocol: binding.binding_protocol,
      modelId: binding.binding_model,
      credentialless: binding.binding_credential === null,
      endpointMatchesFixture: binding.binding_endpoint === fixture.baseUrl,
    },
    userOnlyMessages: finalAudit.messages.length,
    generationJobs: finalJobs.map(({ id, state, error_code, artifact_count }) => ({
      id,
      state,
      errorCode: error_code,
      artifactCount: artifact_count,
    })),
    totalArtifacts: finalJobs.reduce((sum, job) => sum + job.artifact_count, 0),
    unknownSubmissionDurablyRetained: true,
    finalAvailability: finalAudit.availability.status,
  };
  facts.fixture = {
    uploads: fixture.facts.uploads,
    submissions: fixture.facts.submissions,
    downloads: fixture.facts.downloads,
    statusQueries: fixture.facts.statusQueries,
    healthChecks: fixture.facts.healthChecks,
    models: fixture.facts.models,
    unknownSubmissionPhase: unknownState.phase,
  };
}

try {
  await main();
} catch (error) {
  facts.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  throw error;
} finally {
  fixture.mode.offline = false;
  await closeLive();
  await fixture.close();
  writeFileSync(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
}

console.log(
  `G2_PACKAGED_SMOKE_OK screenshots=1440_and_900 productionAdapter=H3_HTTP offlineFixture=true evidence=${relative(root, evidence)}`,
);
