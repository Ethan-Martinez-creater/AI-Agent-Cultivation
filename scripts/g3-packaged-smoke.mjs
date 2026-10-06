import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { clearTimeout, setTimeout } from 'node:timers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';
import { startH3Fixture } from './fixtures/g2-h3-http.mjs';

const root = process.cwd();
const runId = randomUUID();
const dataRoot = join(root, '.test-data', `g3-packaged-${runId}`);
const profile = join(dataRoot, 'production-profile');
const evidence = join(root, 'docs', 'evidence', 'g3-multimodal-collaboration', runId);
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const launchFlags = ['--g3-fixture', '--gate1-fake-model'];
const facts = {
  runId,
  status: 'NOT_RUN',
  package: { executable: relative(root, executablePath), launchFlags },
  liveEndpoint: {
    status: 'BLOCKED',
    reason: 'No live generation endpoint was provided; this run uses the local H3 HTTP fixture.',
  },
  screenshots: [],
  scenarios: {},
  fixtures: {},
  database: {},
  failure: null,
};

mkdirSync(profile, { recursive: true });
mkdirSync(evidence, { recursive: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, label, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readDatabase(profilePath, query) {
  const db = new Database(join(profilePath, 'data', 'cultivation.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

let h3Fixture = null;
let live = null;

async function launch(crashPoint = null) {
  const app = await electron.launch({
    executablePath,
    args: launchFlags,
    timeout: 60_000,
    env: {
      ...process.env,
      CULTIVATION_USER_DATA_DIR: profile,
      CULTIVATION_G3_CRASH: crashPoint ?? '',
    },
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

async function waitForFixtureCrash(page, requestId) {
  assert(live, 'A packaged Main process must be running before a crash fixture');
  const current = live;
  const child = current.app.process();
  const exited = once(child, 'exit');
  const decision = page
    .evaluate(
      (id) =>
        window.cultivation.missions.resolveCollaboration({
          requestId: id,
          decision: 'APPROVED',
        }),
      requestId,
    )
    .catch(() => undefined);
  let timer;
  try {
    const exit = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Configured G3 crash point did not fire')),
          60_000,
        );
      }),
    ]);
    await decision;
    return exit;
  } finally {
    if (timer) clearTimeout(timer);
    live = null;
    await current.app.close().catch(() => undefined);
  }
}

async function capture(page, name, anchor = null) {
  for (const width of [1440, 1180, 900]) {
    const window = await live.app.browserWindow(page);
    await window.evaluate((win, size) => win.setContentSize(size, 900), width);
    await page.setViewportSize({ width, height: 900 });
    if (anchor) await page.locator(anchor).first().scrollIntoViewIfNeeded();
    const path = join(evidence, `${name}-${width}x900.png`);
    await page.screenshot({ path, fullPage: true });
    facts.screenshots.push(relative(root, path));
  }
  const window = await live.app.browserWindow(page);
  await window.evaluate((win) => win.setContentSize(1440, 900));
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function seedIdentities(page, endpoint, nonce) {
  return page.evaluate(
    async ({ endpoint, nonce }) => {
      const api = window.cultivation;
      const languageProvider = await api.providers.create({
        name: `G3 Language Fixture ${nonce}`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9999/v1',
      });
      const languageRuntime = await api.runtimes.create({
        name: `G3 Language Runtime ${nonce}`,
        providerId: languageProvider.id,
        credentialId: null,
        modelId: `g3-language-${nonce}`,
        executionProtocol: 'LANGUAGE',
      });

      const generationProvider = await api.providers.create({
        name: `G3 H3 HTTP Fixture ${nonce}`,
        kind: 'GENERATION_HTTP',
        adapterId: 'H3',
        baseUrl: endpoint,
      });
      const makeGenerationRuntime = (name, modelId) =>
        api.runtimes.create({
          name: `${name} ${nonce}`,
          providerId: generationProvider.id,
          credentialId: null,
          modelId,
          executionProtocol: 'GENERATION',
        });
      const [h3Runtime, imageRuntime, musicRuntime] = await Promise.all([
        makeGenerationRuntime('G3 H3 Runtime', 'minimax-h3'),
        makeGenerationRuntime('G3 Image Runtime', 'g3-image'),
        makeGenerationRuntime('G3 Music Runtime', 'g3-music'),
      ]);

      for (const runtime of [languageRuntime, h3Runtime, imageRuntime, musicRuntime]) {
        const connection = await api.runtimes.testConnection(runtime.id);
        if (!connection.ok)
          throw new Error(`G3 fixture Runtime connection failed: ${runtime.name}`);
      }

      const makeTeammate = (name, runtime) =>
        api.teammates.create({
          name: `${name} ${nonce}`,
          avatar: 'preset:01',
          title: null,
          description: '在固定队伍中独立完成获准的工作。',
          identityPrompt: 'Complete only the bounded Mission task assigned to this teammate.',
          behaviorPrompt: '',
          currentRuntimeProfileId: runtime.id,
        });
      const [coordinator, h3, image, music, languageMember] = await Promise.all([
        makeTeammate('语言协调者', languageRuntime),
        makeTeammate('H3 视频道友', h3Runtime),
        makeTeammate('图片道友', imageRuntime),
        makeTeammate('音乐道友', musicRuntime),
        makeTeammate('文本协作者', languageRuntime),
      ]);

      const saveBenchmark = (runtime, dimension) =>
        api.capability.saveBenchmark({
          runtimeProfileId: runtime.id,
          modelAlias: runtime.modelId,
          dimension,
          supported: true,
          normalizedScore: 90,
          rawScore: null,
          source: 'G3 packaged smoke',
          benchmark: 'Deterministic fixture capability',
          benchmarkVersion: '1',
          snapshotDate: '2026-10-06T00:00:00.000Z',
          sourceUrl: null,
          provenanceType: 'USER_ESTIMATE',
        });
      await Promise.all([
        saveBenchmark(
          { ...languageRuntime, id: coordinator.currentRuntimeProfileId },
          'GENERAL_REASONING',
        ),
        saveBenchmark({ ...h3Runtime, id: h3.currentRuntimeProfileId }, 'VIDEO_GENERATION'),
        saveBenchmark({ ...imageRuntime, id: image.currentRuntimeProfileId }, 'IMAGE_GENERATION'),
        saveBenchmark({ ...musicRuntime, id: music.currentRuntimeProfileId }, 'MUSIC_GENERATION'),
        saveBenchmark(
          { ...languageRuntime, id: languageMember.currentRuntimeProfileId },
          'GENERAL_REASONING',
        ),
      ]);

      const makeParty = async (name, memberTeammateIds) => {
        const party = await api.parties.create({
          name: `${name} ${nonce}`,
          description: '各道友独立完成分工，由协调道友汇总成果。',
          type: 'FIXED',
          coordinatorTeammateId: coordinator.id,
          memberTeammateIds: [coordinator.id, ...memberTeammateIds],
        });
        return party;
      };
      const [h3Party, imageParty, musicParty, referenceParty, capabilityParty] = await Promise.all([
        makeParty('视频制作队伍', [h3.id]),
        makeParty('图片创作队伍', [image.id]),
        makeParty('音乐创作队伍', [music.id]),
        makeParty('参考素材制作队伍', [h3.id, image.id]),
        makeParty('图文协作队伍', [languageMember.id, image.id]),
      ]);

      return {
        providerIds: { language: languageProvider.id, generation: generationProvider.id },
        runtimeIds: {
          language: languageRuntime.id,
          h3: h3Runtime.id,
          image: imageRuntime.id,
          music: musicRuntime.id,
        },
        teammateIds: {
          coordinator: coordinator.id,
          h3: h3.id,
          image: image.id,
          music: music.id,
          languageMember: languageMember.id,
        },
        parties: {
          h3: { id: h3Party.id, name: h3Party.name },
          image: { id: imageParty.id, name: imageParty.name },
          music: { id: musicParty.id, name: musicParty.name },
          reference: { id: referenceParty.id, name: referenceParty.name },
          capability: { id: capabilityParty.id, name: capabilityParty.name },
        },
      };
    },
    { endpoint, nonce },
  );
}

async function createStartedMission(
  page,
  fixture,
  { title, objective, party, mode = 'DELEGATION' },
) {
  return page.evaluate(
    async ({ title, objective, partyId, coordinatorTeammateId, mode }) => {
      const api = window.cultivation;
      const routed = await api.routing.createMission({
        title,
        context: {
          objective,
          executionConstraint: 'PARTY',
          explicitPartyId: partyId,
          partyMode: mode,
          requiredCapabilities: [],
        },
      });
      if (routed.status !== 'CREATED')
        throw new Error('Explicit multimodal Party assignment was rejected: ' + routed.reason);
      const mission = routed.mission;
      if (mission.coordinatorTeammateId !== coordinatorTeammateId)
        throw new Error('Routing changed the fixed Coordinator');
      await api.missions.ready(mission.id);
      const detail = await api.missions.start({ missionId: mission.id, approvalFixture: false });
      return { mission, detail };
    },
    {
      title,
      objective,
      partyId: party.id,
      coordinatorTeammateId: fixture.teammateIds.coordinator,
      mode,
    },
  );
}

async function missionDetail(page, id) {
  return page.evaluate((missionId) => window.cultivation.missions.detail(missionId), id);
}

async function approveInitialRequest(page, started, targetTeammateId, decision) {
  let detail = started.detail;
  if (!detail?.collaborations) detail = await missionDetail(page, started.mission.id);
  const request = detail.collaborations.find(
    (item) => item.targetTeammateId === targetTeammateId && item.state === 'PENDING',
  );
  assert(request, `Expected a pending collaboration for target ${targetTeammateId}`);
  const resolved = await page.evaluate(
    async ({ requestId, decision }) =>
      window.cultivation.missions.resolveCollaboration({ requestId, decision }),
    { requestId: request.id, decision },
  );
  return {
    request,
    detail: resolved?.mission ? resolved : await missionDetail(page, started.mission.id),
  };
}

async function driveApprovedMission(page, missionId, firstRequestId) {
  const handled = new Set([firstRequestId]);
  return waitUntil(async () => {
    let detail = await missionDetail(page, missionId);
    const next = detail.collaborations.find(
      (request) => request.state === 'PENDING' && !handled.has(request.id),
    );
    if (next) {
      handled.add(next.id);
      detail = await page.evaluate(
        async (requestId) =>
          window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
        next.id,
      );
      if (!detail?.mission) detail = await missionDetail(page, missionId);
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(detail.mission.state))
      return detail;
    return false;
  }, `Mission ${missionId} to complete after approved dependencies`);
}

async function runApprovedScenario(page, fixture, { key, title, objective, party, targetId }) {
  const started = await createStartedMission(page, fixture, { title, objective, party });
  const approved = await approveInitialRequest(page, started, targetId, 'APPROVED');
  const detail = await driveApprovedMission(page, started.mission.id, approved.request.id);
  assert.equal(detail.mission.state, 'COMPLETED', `${key} Mission should complete`);
  return { missionId: started.mission.id, requestId: approved.request.id, detail };
}

async function showMission(page, title) {
  await navigateUi(page, '历练 Missions');
  await page.getByRole('heading', { name: '历练', level: 1, exact: true }).waitFor();
  await page.locator('.mission-filter-tabs').getByRole('tab', { name: /全部/ }).click();
  await page.getByRole('button', { name: title, exact: false }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.locator('.g3-collaboration').waitFor({ timeout: 60_000 });
  await page.locator('.g3-collaboration').scrollIntoViewIfNeeded();
}

async function showPartyAndCapture(page, partyName) {
  await navigateUi(page, '队伍 Parties');
  await page.getByRole('heading', { name: '队伍', level: 1, exact: true }).waitFor();
  await page.locator('.party-summary-button').filter({ hasText: partyName }).waitFor();
  await page.locator('.party-summary-button').filter({ hasText: partyName }).click();
  await page.getByRole('heading', { name: partyName, exact: true }).waitFor();
  await capture(page, 'party-h3-generation');
}

function safeFixtureSnapshot(profilePath) {
  const path = join(profilePath, 'g3-fixture-providers.json');
  if (!existsSync(path)) return null;
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  const project = (ledger) => ({
    submissions: ledger.submissions,
    queries: ledger.queries,
    downloads: ledger.downloads,
    entries: Object.values(ledger.entries).map((entry) => ({
      runtimeProfileId: entry.runtimeProfileId,
      idempotencyKeyDigest: digest(entry.idempotencyKey),
      requestFingerprint: entry.requestFingerprint,
      submissionOutcome: entry.submission?.outcome ?? null,
      providerJobId: entry.providerJobId,
      errorCode: entry.submission?.outcome === 'REJECTED' ? entry.submission.errorCode : null,
    })),
  });
  return { image: project(snapshot.image), music: project(snapshot.music) };
}

function auditMission(profilePath, missionId) {
  return readDatabase(profilePath, (db) => {
    const mission = db
      .prepare('SELECT id,state,mode,coordinator_teammate_id FROM missions WHERE id=?')
      .get(missionId);
    assert(mission, `Mission ${missionId} must be durable in SQLite`);
    const tasks = db
      .prepare(
        `SELECT id,logical_key,source,run_id,collaboration_request_id,target_teammate_id,
                required_capability,execution_protocol,parent_task_id,retry_no,continuation_round
         FROM g3_execution_tasks WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId);
    const attempts = db
      .prepare(
        `SELECT a.id,a.task_id,a.attempt_no,a.runtime_profile_id,a.state,a.generation_job_id,a.error_code,
                t.target_teammate_id,t.execution_protocol,t.required_capability
         FROM g3_execution_attempts a JOIN g3_execution_tasks t ON t.id=a.task_id
         WHERE t.mission_id=? ORDER BY a.created_at,a.id`,
      )
      .all(missionId);
    const outcomes = db
      .prepare(
        `SELECT o.id,o.task_id,o.attempt_id,o.participant_teammate_id,o.execution_protocol,o.kind,
                o.outcome_json,o.created_at,o.consumed_at
         FROM g3_participant_outcomes o WHERE o.mission_id=? ORDER BY o.created_at,o.id`,
      )
      .all(missionId)
      .map((row) => {
        const outcome = JSON.parse(row.outcome_json);
        return {
          id: row.id,
          taskId: row.task_id,
          attemptId: row.attempt_id,
          participantTeammateId: row.participant_teammate_id,
          executionProtocol: row.execution_protocol,
          kind: row.kind,
          publicResultDigest: outcome.publicResult ? digest(outcome.publicResult) : null,
          artifactRefs: Array.isArray(outcome.artifactRefs)
            ? outcome.artifactRefs.map((ref) => ({
                id: ref.id,
                kind: ref.kind,
                mimeType: ref.mimeType,
                contentHash: ref.contentHash,
                sizeBytes: ref.sizeBytes,
              }))
            : [],
          requirements:
            row.kind === 'NEEDS_INPUT'
              ? (outcome.requirements ?? []).map((value) => ({
                  role: value.role,
                  artifactKinds: value.artifactKinds ?? [],
                  mimeTypes: value.mimeTypes ?? [],
                  required: value.required,
                }))
              : [],
          consumedAt: row.consumed_at,
          createdAt: row.created_at,
        };
      });
    const generationJobs = db
      .prepare(
        `SELECT j.id,j.generation_task_id,j.teammate_id,j.runtime_profile_id,j.idempotency_key,
                j.request_fingerprint,j.state,j.provider_job_id,j.error_code,
                gt.task_json AS generation_task_json,gt.descriptor_json
         FROM generation_jobs j JOIN generation_tasks gt ON gt.id=j.generation_task_id
         WHERE json_extract(gt.task_json,'$.missionId')=? ORDER BY j.created_at,j.id`,
      )
      .all(missionId)
      .map((row) => {
        const task = JSON.parse(row.generation_task_json);
        return {
          id: row.id,
          generationTaskId: row.generation_task_id,
          teammateId: row.teammate_id,
          runtimeProfileId: row.runtime_profile_id,
          idempotencyKeyDigest: digest(row.idempotency_key),
          idempotencyKeyMatchesTask: row.idempotency_key === row.generation_task_id,
          requestFingerprint: row.request_fingerprint,
          state: row.state,
          providerJobId: row.provider_job_id,
          errorCode: row.error_code,
          executionAttemptId: task.executionAttemptId ?? null,
          collaborationRequestId: task.collaborationRequestId ?? null,
          runId: task.runId ?? null,
          inputArtifactIds: (task.inputs ?? []).map((input) => input.artifactId),
          inputRoles: (task.inputs ?? []).map((input) => input.role),
          capability: task.capability,
          modelId: JSON.parse(row.descriptor_json).modelId,
        };
      });
    const generationArtifacts = db
      .prepare(
        `SELECT a.id,a.job_id,a.kind,a.mime_type,a.extension,a.size_bytes,a.content_hash,a.metadata_json,a.storage_scope
         FROM generation_artifacts a JOIN generation_jobs j ON j.id=a.job_id
         JOIN generation_tasks t ON t.id=j.generation_task_id
         WHERE json_extract(t.task_json,'$.missionId')=? ORDER BY a.created_at,a.id`,
      )
      .all(missionId)
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        kind: row.kind,
        mimeType: row.mime_type,
        extension: row.extension,
        sizeBytes: row.size_bytes,
        contentHash: row.content_hash,
        metadata: JSON.parse(row.metadata_json),
        storageScope: row.storage_scope,
      }));
    const artifactRefs = db
      .prepare(
        `SELECT run_id,artifact_id,kind,mime_type,content_hash,size_bytes,source_type,source_id
         FROM g3_artifact_refs WHERE mission_id=? ORDER BY created_at,artifact_id`,
      )
      .all(missionId);
    const continuations = db
      .prepare(
        `SELECT id,outcome_id,task_id,attempt_id,action,decision_json,continuation_round,created_at,consumed_at
         FROM g3_continuations WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId)
      .map((row) => ({
        ...row,
        decision: JSON.parse(row.decision_json),
        decision_json: undefined,
      }));
    const requests = db
      .prepare(
        `SELECT id,run_id,requester_teammate_id,target_teammate_id,state,depth
         FROM collaboration_requests WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId);
    const collaborationArtifacts = db
      .prepare(
        `SELECT teammate_id,kind,created_at FROM collaboration_artifacts WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId);
    const usage = db
      .prepare(
        `SELECT run_id,teammate_id,runtime_profile_id,provider,model FROM usage_records
         WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId);
    const events = db
      .prepare(
        `SELECT event_type,actor_type,actor_id,payload_json,created_at FROM mission_events
         WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId)
      .map((row) => {
        const payload = JSON.parse(row.payload_json);
        return {
          eventType: row.event_type,
          actorType: row.actor_type,
          actorId: row.actor_id,
          phase: payload.phase ?? null,
          executionAttemptId: payload.executionAttemptId ?? null,
          generationJobId: payload.generationJobId ?? null,
          dependencyOutcomeId: payload.dependencyOutcomeId ?? null,
          targetTeammateId: payload.targetTeammateId ?? null,
          createdAt: row.created_at,
        };
      });
    return {
      mission,
      tasks,
      attempts,
      outcomes,
      generationJobs,
      generationArtifacts,
      artifactRefs,
      continuations,
      requests,
      collaborationArtifacts,
      usage,
      events,
    };
  });
}

function assertGenerationResult(audit, teammateId, mimeType) {
  const targetTasks = audit.tasks.filter((task) => task.target_teammate_id === teammateId);
  assert(targetTasks.length > 0, `Expected a persisted G3 task for teammate ${teammateId}`);
  const targetAttempts = audit.attempts.filter(
    (attempt) => attempt.target_teammate_id === teammateId,
  );
  const completedAttempt = targetAttempts.find(
    (attempt) => attempt.state === 'COMPLETED' && attempt.generation_job_id,
  );
  assert(completedAttempt, `Expected a completed Generation attempt for ${teammateId}`);
  const job = audit.generationJobs.find((item) => item.id === completedAttempt.generation_job_id);
  assert(job, 'The G3 attempt must bind its actual GenerationJob');
  assert.equal(job.state, 'COMPLETED');
  assert.equal(job.teammateId, teammateId);
  assert.equal(job.idempotencyKeyMatchesTask, true);
  const artifact = audit.generationArtifacts.find(
    (item) => item.jobId === job.id && item.mimeType === mimeType,
  );
  assert(artifact, `Expected persisted ${mimeType} output for GenerationJob ${job.id}`);
  const outcome = audit.outcomes.find((item) => item.attemptId === completedAttempt.id);
  assert(outcome, 'Generation attempt must persist a structured participant outcome');
  assert.equal(outcome.kind, 'RESULT');
  assert.equal(
    outcome.consumedAt !== null,
    true,
    'Coordinator continuation must consume the outcome',
  );
  assert(outcome.artifactRefs.some((ref) => ref.id === artifact.id));
  assert(
    audit.artifactRefs.some(
      (ref) => ref.artifact_id === artifact.id && ref.source_type === 'GENERATION',
    ),
    'Generated output must be registered as a same-Run ArtifactRef',
  );
  return { job, artifact, outcome };
}

function assertRequestState(audit, requestId, expectedState) {
  const request = audit.requests.find((item) => item.id === requestId);
  assert(request, `Collaboration request ${requestId} must be durable in SQLite`);
  assert.equal(request.state, expectedState);
  return request;
}

async function main() {
  assert.equal(
    existsSync(executablePath),
    true,
    `Packaged executable not found: ${executablePath}`,
  );
  h3Fixture = await startH3Fixture();
  live = await launch();
  const fixture = await seedIdentities(live.page, h3Fixture.baseUrl, runId.slice(0, 8));
  facts.package.status = 'LAUNCHED';
  facts.package.seededThroughTypedIpc = true;
  facts.package.identityCount = Object.keys(fixture.teammateIds).length;
  facts.package.generationAdapter = 'H3 HTTP fixture plus g3-image/g3-music test adapters';
  facts.setup = fixture;

  const h3Title = `制作演示短片 ${runId.slice(0, 8)}`;
  const h3 = await runApprovedScenario(live.page, fixture, {
    key: 'approvedH3',
    title: h3Title,
    objective: '生成一段短片并交付可验证的 MP4 成果。',
    party: fixture.parties.h3,
    targetId: fixture.teammateIds.h3,
  });
  const h3Audit = auditMission(profile, h3.missionId);
  assertRequestState(h3Audit, h3.requestId, 'APPROVED');
  const h3Result = assertGenerationResult(h3Audit, fixture.teammateIds.h3, 'video/mp4');
  const finalArtifact = h3Audit.collaborationArtifacts.find(
    (artifact) =>
      artifact.kind === 'FINAL' && artifact.teammate_id === fixture.teammateIds.coordinator,
  );
  assert(finalArtifact, 'Coordinator must persist a FINAL synthesis artifact');
  assert(
    h3Audit.events.some(
      (event) =>
        event.eventType === 'model.call_started' &&
        event.actorId === fixture.teammateIds.coordinator &&
        event.phase === 'SYNTHESIS',
    ),
    'Coordinator synthesis must run after the Generation outcome',
  );
  facts.scenarios.approvedH3 = {
    missionId: h3.missionId,
    requestId: h3.requestId,
    missionState: h3Audit.mission.state,
    requestState: 'APPROVED',
    generationJobId: h3Result.job.id,
    generationJobState: h3Result.job.state,
    artifactId: h3Result.artifact.id,
    artifactMimeType: h3Result.artifact.mimeType,
    outcomeId: h3Result.outcome.id,
    outcomeConsumed: Boolean(h3Result.outcome.consumedAt),
    coordinatorSynthesisArtifact: finalArtifact.kind,
    requestCount: h3Audit.requests.length,
  };
  await showMission(live.page, h3Title);
  const video = live.page.locator('video.g3-artifact-preview').first();
  await video.waitFor({ timeout: 30_000 });
  const mediaSource = await video.getAttribute('src');
  assert.match(mediaSource ?? '', /^cultivation-media:\/\/artifact\//);
  await live.page.waitForFunction(
    () => {
      const element = globalThis.document.querySelector('video.g3-artifact-preview');
      return (
        element instanceof globalThis.HTMLMediaElement &&
        element.readyState >= globalThis.HTMLMediaElement.HAVE_METADATA
      );
    },
    undefined,
    { timeout: 60_000 },
  );
  const preview = await video.evaluate((element) => ({
    currentSrc: element.currentSrc,
    readyState: element.readyState,
  }));
  assert.match(preview.currentSrc, /^cultivation-media:\/\/artifact\//);
  facts.scenarios.approvedH3.preview = {
    scheme: 'cultivation-media://artifact',
    readyState: preview.readyState,
  };
  await capture(live.page, 'mission-approved-h3');
  await capture(live.page, 'h3-artifact-preview', '.g3-artifact-card');
  await showPartyAndCapture(live.page, fixture.parties.h3.name);

  const deniedTitle = `G3 denied target ${runId.slice(0, 8)}`;
  const deniedStart = await createStartedMission(live.page, fixture, {
    title: deniedTitle,
    objective: '请求协作后由用户拒绝，目标不得开始生成。',
    party: fixture.parties.h3,
  });
  const denied = await approveInitialRequest(
    live.page,
    deniedStart,
    fixture.teammateIds.h3,
    'DENIED',
  );
  const deniedDetail = await missionDetail(live.page, deniedStart.mission.id);
  const deniedAudit = auditMission(profile, deniedStart.mission.id);
  assertRequestState(deniedAudit, denied.request.id, 'DENIED');
  assert.equal(deniedDetail.mission.state, 'COMPLETED');
  assert.equal(deniedAudit.tasks.length, 0, 'Denied target must create no G3 execution task');
  assert.equal(
    deniedAudit.generationJobs.length,
    0,
    'Denied target must create zero GenerationJobs',
  );
  assert.equal(
    deniedAudit.usage.some((entry) => entry.teammate_id === fixture.teammateIds.h3),
    false,
    'Denied target must have no model usage',
  );
  facts.scenarios.deniedTarget = {
    missionId: deniedStart.mission.id,
    requestId: denied.request.id,
    requestState: deniedDetail.collaborations.find((item) => item.id === denied.request.id)?.state,
    targetGenerationJobs: 0,
    targetExecutionTasks: 0,
  };

  const imageTitle = `创作参考图片 ${runId.slice(0, 8)}`;
  const image = await runApprovedScenario(live.page, fixture, {
    key: 'imageParticipation',
    title: imageTitle,
    objective: '生成一张图片成果并交付。',
    party: fixture.parties.image,
    targetId: fixture.teammateIds.image,
  });
  const imageAudit = auditMission(profile, image.missionId);
  assertRequestState(imageAudit, image.requestId, 'APPROVED');
  const imageResult = assertGenerationResult(imageAudit, fixture.teammateIds.image, 'image/png');
  facts.scenarios.imageParticipation = {
    missionId: image.missionId,
    requestState: 'APPROVED',
    generationJobId: imageResult.job.id,
    artifactId: imageResult.artifact.id,
    artifactMimeType: imageResult.artifact.mimeType,
    outcomeId: imageResult.outcome.id,
  };

  const musicTitle = `制作配乐 ${runId.slice(0, 8)}`;
  const music = await runApprovedScenario(live.page, fixture, {
    key: 'musicParticipation',
    title: musicTitle,
    objective: '生成一段音乐成果并交付。',
    party: fixture.parties.music,
    targetId: fixture.teammateIds.music,
  });
  const musicAudit = auditMission(profile, music.missionId);
  assertRequestState(musicAudit, music.requestId, 'APPROVED');
  const musicResult = assertGenerationResult(musicAudit, fixture.teammateIds.music, 'audio/wav');
  facts.scenarios.musicParticipation = {
    missionId: music.missionId,
    requestState: 'APPROVED',
    generationJobId: musicResult.job.id,
    artifactId: musicResult.artifact.id,
    artifactMimeType: musicResult.artifact.mimeType,
    outcomeId: musicResult.outcome.id,
  };

  const referenceTitle = `参考图片转短片 ${runId.slice(0, 8)}`;
  const reference = await runApprovedScenario(live.page, fixture, {
    key: 'needsInputImageDependency',
    title: referenceTitle,
    objective: '为视频生成准备所需的图片素材。__G3_REFERENCE__',
    party: fixture.parties.reference,
    targetId: fixture.teammateIds.h3,
  });
  const referenceAudit = auditMission(profile, reference.missionId);
  const missingInput = referenceAudit.outcomes.find(
    (outcome) =>
      outcome.kind === 'NEEDS_INPUT' && outcome.participantTeammateId === fixture.teammateIds.h3,
  );
  assert(missingInput, 'H3 must durably request a required image input');
  assert(
    missingInput.requirements.some(
      (requirement) =>
        requirement.artifactKinds.includes('IMAGE') && requirement.mimeTypes.includes('image/png'),
    ),
    'H3 NEEDS_INPUT must require an image/png artifact',
  );
  const dependencyRequest = referenceAudit.requests.find(
    (request) =>
      request.target_teammate_id === fixture.teammateIds.image && request.state === 'APPROVED',
  );
  assert(dependencyRequest, 'The image teammate must be approved for the dependency');
  const dependencyResult = referenceAudit.outcomes.find(
    (outcome) =>
      outcome.participantTeammateId === fixture.teammateIds.image && outcome.kind === 'RESULT',
  );
  assert(dependencyResult, 'Image dependency must persist a successful participant outcome');
  const h3FinalJob = referenceAudit.generationJobs.find(
    (job) => job.teammateId === fixture.teammateIds.h3 && job.state === 'COMPLETED',
  );
  assert(h3FinalJob, 'H3 must resume and complete after image dependency delivery');
  assert.equal(h3FinalJob.capability, 'VIDEO_GENERATION');
  assert(h3FinalJob.inputArtifactIds.length > 0, 'Resumed H3 task must consume the image artifact');
  const childRefs = dependencyResult.artifactRefs.map((ref) => ref.id);
  assert(
    h3FinalJob.inputArtifactIds.some((id) => childRefs.includes(id)),
    'Resumed H3 GenerationTask must bind the image dependency output',
  );
  assert(
    referenceAudit.continuations.some(
      (continuation) => continuation.outcome_id === missingInput.id && continuation.consumed_at,
    ),
    'NEEDS_INPUT continuation must be durably consumed after H3 resumes',
  );
  facts.scenarios.needsInputImageDependency = {
    missionId: reference.missionId,
    missingInputOutcomeId: missingInput.id,
    dependencyRequestId: dependencyRequest.id,
    dependencyTeammateId: fixture.teammateIds.image,
    dependencyArtifactIds: childRefs,
    resumedH3JobId: h3FinalJob.id,
    resumedH3InputArtifactIds: h3FinalJob.inputArtifactIds,
    continuationConsumed: true,
  };

  const testOnlyWorkflows = await live.page.evaluate(() =>
    window.cultivation.workflows.versions().then((versions) =>
      versions
        .filter((version) => version.definition.id === 'test.g3-generation')
        .map((version) => ({
          definitionId: version.definition.id,
          category: version.definition.category,
          version: version.version,
          stepCount: version.steps.length,
        })),
    ),
  );
  facts.fixtures.testOnlyWorkflows = testOnlyWorkflows;
  assert.equal(testOnlyWorkflows.length, 1, 'RootMain G3 fixture must register test.g3-generation');
  assert.equal(testOnlyWorkflows[0].category, 'TEST_ONLY');
  assert.equal(testOnlyWorkflows[0].version, 1);

  const createdWorkflow = await live.page.evaluate(() =>
    window.cultivation.workflows.create({ definitionId: 'test.g3-generation', version: 1 }),
  );
  const workflowRunId = createdWorkflow.run.id;
  await live.page.evaluate((id) => window.cultivation.workflows.advance(id), workflowRunId);
  const completedWorkflow = await waitUntil(async () => {
    let detail = await live.page.evaluate(
      (id) => window.cultivation.workflows.detail(id),
      workflowRunId,
    );
    if (detail.run.state === 'WAITING' && detail.run.waitReason === 'MISSION') {
      const boundId = detail.steps[0]?.missionId;
      if (boundId && (await missionDetail(live.page, boundId)).mission.state === 'COMPLETED')
        detail = await live.page.evaluate(
          (id) => window.cultivation.workflows.advance(id),
          workflowRunId,
        );
    }
    if (detail.run.state === 'FAILED' || detail.run.state === 'CANCELLED')
      throw new Error(`G3 fixture Workflow did not complete: ${detail.run.state}`);
    return detail.run.state === 'COMPLETED' ? detail : false;
  }, 'test.g3-generation Workflow completion');
  assert.equal(completedWorkflow.steps.length, 1);
  assert.equal(completedWorkflow.steps[0].state, 'COMPLETED');
  assert(completedWorkflow.steps[0].missionId, 'Generation step must bind its Mission');
  const workflowOutput = completedWorkflow.artifacts.find(
    (artifact) =>
      artifact.kind === 'JSON' && artifact.producerStepRunId === completedWorkflow.steps[0].id,
  );
  assert(workflowOutput, 'Workflow must commit its declared Generation ArtifactRef JSON output');
  const workflowOutputReference = JSON.parse(workflowOutput.content);
  assert.equal(workflowOutputReference.type, 'GENERATION_ARTIFACT_REF');
  const workflowAuditBeforeRestart = auditMission(profile, completedWorkflow.steps[0].missionId);
  const workflowGeneration = assertGenerationResult(
    workflowAuditBeforeRestart,
    fixture.teammateIds.image,
    'image/png',
  );
  assert.equal(workflowOutputReference.artifact.id, workflowGeneration.artifact.id);
  const workflowFixtureBeforeRestart = safeFixtureSnapshot(profile);
  const h3CountersBeforeRestart = {
    submissions: h3Fixture.facts.submissions,
    postAttempts: h3Fixture.facts.postAttempts,
    downloads: h3Fixture.facts.downloads,
    statusQueries: h3Fixture.facts.statusQueries,
  };
  facts.scenarios.testOnlyWorkflow = {
    definitionId: completedWorkflow.run.definitionId,
    definitionVersion: completedWorkflow.run.definitionVersion,
    workflowRunId,
    runState: completedWorkflow.run.state,
    stepRunId: completedWorkflow.steps[0].id,
    stepMissionId: completedWorkflow.steps[0].missionId,
    stepMissionRunId: completedWorkflow.steps[0].missionRunId,
    generationJobId: workflowGeneration.job.id,
    generatedArtifactId: workflowGeneration.artifact.id,
    outputReferenceArtifactId: workflowOutputReference.artifact.id,
    outputValidationCount: completedWorkflow.validations.filter((item) => item.valid).length,
    restart: { status: 'PENDING' },
  };

  await closeLive();
  live = await launch();
  const recoveredWorkflow = await live.page.evaluate(
    (id) => window.cultivation.workflows.detail(id),
    workflowRunId,
  );
  assert.equal(recoveredWorkflow.run.state, 'COMPLETED');
  assert.equal(recoveredWorkflow.steps[0].missionId, completedWorkflow.steps[0].missionId);
  const recoveredWorkflowOutput = recoveredWorkflow.artifacts.find(
    (artifact) =>
      artifact.kind === 'JSON' && artifact.producerStepRunId === completedWorkflow.steps[0].id,
  );
  assert.equal(recoveredWorkflowOutput?.id, workflowOutput.id);
  const workflowAuditAfterRestart = auditMission(profile, completedWorkflow.steps[0].missionId);
  assert.deepEqual(
    {
      tasks: workflowAuditAfterRestart.tasks.length,
      attempts: workflowAuditAfterRestart.attempts.length,
      jobs: workflowAuditAfterRestart.generationJobs.length,
      artifacts: workflowAuditAfterRestart.generationArtifacts.length,
      outcomes: workflowAuditAfterRestart.outcomes.length,
    },
    {
      tasks: workflowAuditBeforeRestart.tasks.length,
      attempts: workflowAuditBeforeRestart.attempts.length,
      jobs: workflowAuditBeforeRestart.generationJobs.length,
      artifacts: workflowAuditBeforeRestart.generationArtifacts.length,
      outcomes: workflowAuditBeforeRestart.outcomes.length,
    },
    'Completed Workflow restart must reuse durable G3 Generation facts without replay',
  );
  assert.deepEqual(safeFixtureSnapshot(profile), workflowFixtureBeforeRestart);
  assert.deepEqual(
    {
      submissions: h3Fixture.facts.submissions,
      postAttempts: h3Fixture.facts.postAttempts,
      downloads: h3Fixture.facts.downloads,
      statusQueries: h3Fixture.facts.statusQueries,
    },
    h3CountersBeforeRestart,
    'Completed Workflow restart must not resubmit to the H3 HTTP adapter',
  );
  facts.scenarios.testOnlyWorkflow.restart = {
    status: 'PASS',
    runState: recoveredWorkflow.run.state,
    durableJobCount: workflowAuditAfterRestart.generationJobs.length,
    durableOutputCount: workflowAuditAfterRestart.generationArtifacts.length,
    fixtureProviderCountersUnchanged: true,
    h3HttpCountersUnchanged: true,
  };

  const unknownTitle = `G3 unknown submission ${runId.slice(0, 8)}`;
  const unknownStart = await createStartedMission(live.page, fixture, {
    title: unknownTitle,
    objective: '验证未知提交不得自动重放。__G3_UNKNOWN__',
    party: fixture.parties.image,
  });
  const unknownApproval = await approveInitialRequest(
    live.page,
    unknownStart,
    fixture.teammateIds.image,
    'APPROVED',
  );
  const unknownBeforeRestart = await waitUntil(() => {
    const audit = auditMission(profile, unknownStart.mission.id);
    return audit.generationJobs.some((job) => job.state === 'UNKNOWN') ? audit : false;
  }, 'durable UNKNOWN GenerationJob');
  assert.equal(unknownBeforeRestart.generationJobs.length, 1);
  assertRequestState(unknownBeforeRestart, unknownApproval.request.id, 'APPROVED');
  assert.equal(unknownBeforeRestart.attempts[0].state, 'UNKNOWN');
  assert.equal(unknownBeforeRestart.outcomes.length, 0);
  const unknownFixtureBeforeRestart = safeFixtureSnapshot(profile);
  const unknownH3CountersBeforeRestart = {
    submissions: h3Fixture.facts.submissions,
    postAttempts: h3Fixture.facts.postAttempts,
    downloads: h3Fixture.facts.downloads,
    statusQueries: h3Fixture.facts.statusQueries,
  };
  await closeLive();
  live = await launch();
  await delay(2_000);
  const unknownAfterRestart = auditMission(profile, unknownStart.mission.id);
  assert.deepEqual(
    unknownAfterRestart.generationJobs.map(({ id, state }) => ({ id, state })),
    unknownBeforeRestart.generationJobs.map(({ id, state }) => ({ id, state })),
    'UNKNOWN restart must retain the same terminal job without creating another Job',
  );
  assert.equal(unknownAfterRestart.attempts[0].state, 'UNKNOWN');
  assert.deepEqual(safeFixtureSnapshot(profile), unknownFixtureBeforeRestart);
  assert.deepEqual(
    {
      submissions: h3Fixture.facts.submissions,
      postAttempts: h3Fixture.facts.postAttempts,
      downloads: h3Fixture.facts.downloads,
      statusQueries: h3Fixture.facts.statusQueries,
    },
    unknownH3CountersBeforeRestart,
  );
  facts.scenarios.unknownSubmission = {
    missionId: unknownStart.mission.id,
    requestId: unknownApproval.request.id,
    generationJobId: unknownBeforeRestart.generationJobs[0].id,
    jobState: 'UNKNOWN',
    attemptState: 'UNKNOWN',
    participantOutcomeCount: 0,
    restart: { status: 'PASS', extraJobs: 0, extraSubmissions: 0 },
  };

  const retryTitle = `G3 definitive retry ${runId.slice(0, 8)}`;
  const retryStart = await createStartedMission(live.page, fixture, {
    title: retryTitle,
    objective: '遇到有确凿证据的队列拒绝后，仅执行一次安全重试。__G3_RETRY__',
    party: fixture.parties.image,
  });
  const retryApproval = await approveInitialRequest(
    live.page,
    retryStart,
    fixture.teammateIds.image,
    'APPROVED',
  );
  const retryAudit = await waitUntil(() => {
    const audit = auditMission(profile, retryStart.mission.id);
    return audit.generationJobs.length === 2 ? audit : false;
  }, 'one bounded definitive QUEUE_FULL retry');
  const retryDetail = await waitUntil(async () => {
    const detail = await missionDetail(live.page, retryStart.mission.id);
    return ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(detail.mission.state)
      ? detail
      : false;
  }, 'bounded retry Mission terminal state');
  assert.equal(retryAudit.generationJobs.length, 2);
  assertRequestState(retryAudit, retryApproval.request.id, 'APPROVED');
  assert(retryAudit.generationJobs.every((job) => job.state === 'FAILED'));
  assert(retryAudit.generationJobs.every((job) => job.idempotencyKeyMatchesTask));
  assert.equal(new Set(retryAudit.generationJobs.map((job) => job.idempotencyKeyDigest)).size, 2);
  const retryProof = safeFixtureSnapshot(profile);
  const queueRejections = retryProof.image.entries.filter(
    (entry) => entry.submissionOutcome === 'REJECTED' && entry.errorCode === 'QUEUE_FULL',
  );
  assert.equal(queueRejections.length, 2, 'Each distinct GenerationTask may be rejected once');
  facts.scenarios.definitiveRetry = {
    missionId: retryStart.mission.id,
    requestId: retryApproval.request.id,
    missionState: retryDetail.mission.state,
    jobIds: retryAudit.generationJobs.map((job) => job.id),
    idempotencyKeyDigests: retryAudit.generationJobs.map((job) => job.idempotencyKeyDigest),
    jobStates: retryAudit.generationJobs.map((job) => job.state),
    queueFullProofCount: queueRejections.length,
    boundedRetries: 1,
  };

  const crashTitle = `G3 crash after job binding ${runId.slice(0, 8)}`;
  const crashStart = await createStartedMission(live.page, fixture, {
    title: crashTitle,
    objective: '在 GenerationJob 持久绑定后模拟 Main 崩溃并恢复。',
    party: fixture.parties.image,
  });
  const crashRequest = crashStart.detail.collaborations.find(
    (request) =>
      request.targetTeammateId === fixture.teammateIds.image && request.state === 'PENDING',
  );
  assert(crashRequest, 'Crash recovery fixture requires an explicit pending approval');
  await closeLive();
  live = await launch('JOB_BOUND');
  const crashExit = await waitForFixtureCrash(live.page, crashRequest.id);
  const crashBeforeRecovery = auditMission(profile, crashStart.mission.id);
  assert.equal(crashBeforeRecovery.generationJobs.length, 1);
  const boundJobId = crashBeforeRecovery.generationJobs[0].id;
  assert.equal(crashBeforeRecovery.generationJobs[0].state, 'PENDING');
  assert.equal(crashBeforeRecovery.attempts[0].generation_job_id, boundJobId);
  const crashFixtureBeforeRecovery = safeFixtureSnapshot(profile);
  live = await launch();
  const recoveredCrashMission = await waitUntil(async () => {
    const detail = await missionDetail(live.page, crashStart.mission.id);
    return ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(detail.mission.state)
      ? detail
      : false;
  }, 'G3 JOB_BOUND crash recovery');
  assert.equal(recoveredCrashMission.mission.state, 'COMPLETED');
  const crashAfterRecovery = auditMission(profile, crashStart.mission.id);
  assert.equal(crashAfterRecovery.generationJobs.length, 1);
  assert.equal(crashAfterRecovery.generationJobs[0].id, boundJobId);
  assert.equal(crashAfterRecovery.generationJobs[0].state, 'COMPLETED');
  assert.equal(crashAfterRecovery.attempts[0].generation_job_id, boundJobId);
  assertRequestState(crashAfterRecovery, crashRequest.id, 'APPROVED');
  assert.equal(
    safeFixtureSnapshot(profile).image.submissions,
    crashFixtureBeforeRecovery.image.submissions + 1,
    'Recovery must submit the already-bound GenerationJob exactly once',
  );
  facts.scenarios.jobBoundCrashRecovery = {
    missionId: crashStart.mission.id,
    requestId: crashRequest.id,
    mainProcessExit: { code: crashExit[0], signal: crashExit[1] },
    generationJobIdBeforeRestart: boundJobId,
    generationJobIdAfterRestart: crashAfterRecovery.generationJobs[0].id,
    completedAfterRestart: true,
    duplicateGenerationJobs: 0,
    recoveredGenerationSubmissions: 1,
  };

  const allMissionIds = [
    h3.missionId,
    deniedStart.mission.id,
    image.missionId,
    music.missionId,
    reference.missionId,
    completedWorkflow.steps[0].missionId,
    unknownStart.mission.id,
    retryStart.mission.id,
    crashStart.mission.id,
  ];
  facts.database = Object.fromEntries(
    allMissionIds.map((missionId) => [missionId, auditMission(profile, missionId)]),
  );
  facts.fixtures.h3Http = {
    type: 'local-offline-H3-production-HTTP-adapter-fixture',
    submissions: h3Fixture.facts.submissions,
    postAttempts: h3Fixture.facts.postAttempts,
    uploads: h3Fixture.facts.uploads,
    downloads: h3Fixture.facts.downloads,
    statusQueries: h3Fixture.facts.statusQueries,
    healthChecks: h3Fixture.facts.healthChecks,
    models: h3Fixture.facts.models,
    idempotencyKeyDigests: h3Fixture.facts.keys.map(digest),
    requestModels: h3Fixture.facts.requests.map((request) => request.model),
  };
  facts.fixtures.providerNeutralGeneration = safeFixtureSnapshot(profile);
  assert(
    facts.fixtures.providerNeutralGeneration,
    'Durable G3 image/music fixture facts must exist',
  );
  const imageLedger = facts.fixtures.providerNeutralGeneration.image;
  const submittedImages = imageLedger.entries.filter(
    (entry) => entry.submissionOutcome === 'SUBMITTED',
  );
  const unknownImages = imageLedger.entries.filter(
    (entry) => entry.submissionOutcome === 'UNKNOWN',
  );
  const queueFullImages = imageLedger.entries.filter(
    (entry) => entry.submissionOutcome === 'REJECTED' && entry.errorCode === 'QUEUE_FULL',
  );
  assert.equal(
    imageLedger.submissions,
    7,
    'Four successful, one UNKNOWN, and two QUEUE_FULL image submissions',
  );
  assert.equal(submittedImages.length, 4);
  assert.equal(unknownImages.length, 1);
  assert.equal(queueFullImages.length, 2);
  assert.equal(facts.fixtures.providerNeutralGeneration.music.submissions, 1);
  assert(
    imageLedger.downloads >= 4 && facts.fixtures.providerNeutralGeneration.music.downloads >= 1,
    'Image and music provider-neutral fixture outputs must be downloaded',
  );

  // Actual packaged process exits at durable boundaries, not just in-memory reconstruction.
  const crashMatrix = [
    { window: 'A', point: 'APPROVAL_COMMITTED' },
    { window: 'B', point: 'TASK_CREATED' },
    { window: 'D', point: 'GENERATION_COMPLETED' },
    { window: 'J', point: 'OUTCOME_CREATED' },
    { window: 'E', point: 'OUTCOME_CREATED', reference: true },
    { window: 'FG', point: 'DEPENDENCY_COMPLETED', reference: true },
    { window: 'G', point: 'DEPENDENCY_COMPLETED', capability: true },
    { window: 'H', point: 'CONTINUATION_CREATED', retry: true },
  ];
  facts.scenarios.crashMatrix = [];
  for (const scenario of crashMatrix) {
    const started = await createStartedMission(live.page, fixture, {
      title: `恢复验收 ${scenario.window} ${runId.slice(0, 8)}`,
      objective: scenario.capability
        ? '图文协作请求 __G3_NEEDS_CAPABILITY__'
        : scenario.reference
          ? '素材依赖恢复 __G3_REFERENCE__'
          : scenario.retry
            ? '有界重试恢复 __G3_RETRY__'
            : '生成图片并保存成果',
      party: scenario.capability
        ? fixture.parties.capability
        : scenario.reference
          ? fixture.parties.reference
          : fixture.parties.image,
    });
    let request = started.detail.collaborations.find((value) => value.state === 'PENDING');
    assert(request);
    if (scenario.point === 'DEPENDENCY_COMPLETED') {
      const approved = await approveInitialRequest(
        live.page,
        started,
        scenario.capability ? fixture.teammateIds.languageMember : fixture.teammateIds.h3,
        'APPROVED',
      );
      request = approved.detail.collaborations.find((value) => value.state === 'PENDING');
      assert(request, 'The dependency must remain independently user-approved');
    }
    await closeLive();
    live = await launch(scenario.point);
    const exited = await waitForFixtureCrash(live.page, request.id);
    const before = auditMission(profile, started.mission.id);
    live = await launch();
    const detail = await driveApprovedMission(live.page, started.mission.id, request.id);
    assert.equal(detail.mission.state, 'COMPLETED');
    const after = auditMission(profile, started.mission.id);
    const expectedJobs = scenario.reference || scenario.retry ? 2 : 1;
    assert.equal(after.generationJobs.length, expectedJobs);
    assert.equal(after.generationArtifacts.length, scenario.reference ? 2 : scenario.retry ? 0 : 1);
    assert.equal(new Set(after.tasks.map((task) => task.logical_key)).size, after.tasks.length);
    assert.equal(
      new Set(after.generationJobs.map((job) => job.idempotencyKeyDigest)).size,
      expectedJobs,
    );
    for (const job of before.generationJobs)
      assert(after.generationJobs.some((value) => value.id === job.id));
    const stable = safeFixtureSnapshot(profile);
    await closeLive();
    live = await launch();
    assert.deepEqual(
      safeFixtureSnapshot(profile),
      stable,
      'Completed crash-recovered runs must not submit or download again',
    );
    const repeated = auditMission(profile, started.mission.id);
    assert.equal(repeated.generationJobs.length, after.generationJobs.length);
    assert.equal(repeated.generationArtifacts.length, after.generationArtifacts.length);
    facts.database[started.mission.id] = repeated;
    facts.scenarios.crashMatrix.push({
      window: scenario.window,
      point: scenario.point,
      missionId: started.mission.id,
      exitCode: exited[0],
      beforeJobs: before.generationJobs.length,
      afterJobs: after.generationJobs.length,
      artifacts: after.generationArtifacts.length,
      duplicateJobs: 0,
      duplicateArtifacts: 0,
    });
  }
  facts.fixtures.providerNeutralGeneration = safeFixtureSnapshot(profile);
  facts.fixtures.h3Http.submissions = h3Fixture.facts.submissions;
  facts.fixtures.h3Http.postAttempts = h3Fixture.facts.postAttempts;
  facts.fixtures.h3Http.downloads = h3Fixture.facts.downloads;

  facts.package.status = 'PASS';
  facts.status = 'PASS';
}

try {
  await main();
} catch (error) {
  facts.status = 'FAILED';
  facts.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  throw error;
} finally {
  await closeLive();
  if (h3Fixture) {
    facts.fixtures.h3Http ??= {
      type: 'local-offline-H3-production-HTTP-adapter-fixture',
      submissions: h3Fixture.facts.submissions,
      postAttempts: h3Fixture.facts.postAttempts,
      uploads: h3Fixture.facts.uploads,
      downloads: h3Fixture.facts.downloads,
      statusQueries: h3Fixture.facts.statusQueries,
      healthChecks: h3Fixture.facts.healthChecks,
      models: h3Fixture.facts.models,
      idempotencyKeyDigests: h3Fixture.facts.keys.map(digest),
    };
    await h3Fixture.close();
  }
  writeFileSync(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
}

console.log(
  `G3_PACKAGED_SMOKE_${facts.status} localH3Fixture=true liveEndpoint=${facts.liveEndpoint.status} screenshots=1440_1180_900 evidence=${relative(root, evidence)}`,
);
