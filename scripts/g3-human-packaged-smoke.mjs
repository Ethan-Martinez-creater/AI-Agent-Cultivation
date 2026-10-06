import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const runId = randomUUID();
const nonce = runId.slice(0, 8);
const dataRoot = join(root, '.test-data', `g3-human-packaged-${runId}`);
const profile = join(dataRoot, 'production-profile');
const workspaceRoot = join(dataRoot, 'workspace');
const evidence = join(root, 'docs', 'evidence', 'g3-multimodal-collaboration', `human-${runId}`);
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const launchFlags = ['--g3-fixture', '--gate1-fake-model'];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const facts = {
  runId,
  status: 'NOT_RUN',
  package: { executable: relative(root, executablePath), launchFlags },
  network: { externalRequests: 0, generation: 'local G3 fixture adapter' },
  screenshots: [],
  scenarios: {},
  database: {},
  failure: null,
};

mkdirSync(profile, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
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

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
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

function auditMission(profilePath, missionId) {
  return readDatabase(profilePath, (db) => {
    const mission = db
      .prepare('SELECT id,state,mode,coordinator_teammate_id FROM missions WHERE id=?')
      .get(missionId);
    assert(mission, `Mission ${missionId} must be durable in SQLite`);
    const runs = db
      .prepare(
        'SELECT id,attempt,status,result_text FROM mission_runs WHERE mission_id=? ORDER BY attempt',
      )
      .all(missionId)
      .map((run) => ({
        ...run,
        resultDigest: run.result_text ? digest(run.result_text) : null,
        result_text: undefined,
      }));
    const tasks = db
      .prepare(
        `SELECT id,logical_key,source,run_id,collaboration_request_id,target_teammate_id,
                required_capability,execution_protocol,parent_task_id,retry_no,continuation_round,task_json
         FROM g3_execution_tasks WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId)
      .map((row) => {
        const snapshot = JSON.parse(row.task_json);
        return {
          ...row,
          publicContext: snapshot.publicContext,
          artifactInputs: snapshot.artifactInputs,
          task_json: undefined,
        };
      });
    const attempts = db
      .prepare(
        `SELECT a.id,a.task_id,a.attempt_no,a.runtime_profile_id,a.state,a.generation_job_id,
                a.external_work_request_id,a.error_code,t.target_teammate_id,
                t.execution_protocol,t.required_capability
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
          requirements: row.kind === 'NEEDS_INPUT' ? (outcome.requirements ?? []) : [],
          consumedAt: row.consumed_at,
        };
      });
    const g3Continuations = db
      .prepare(
        `SELECT id,outcome_id,task_id,attempt_id,action,decision_json,continuation_round,consumed_at
         FROM g3_continuations WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId)
      .map((row) => ({
        ...row,
        decision: JSON.parse(row.decision_json),
        decision_json: undefined,
      }));
    const collaborationRequests = db
      .prepare(
        `SELECT id,run_id,requester_teammate_id,target_teammate_id,state,depth
         FROM collaboration_requests WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId);
    const externalRequests = db
      .prepare(
        `SELECT id,run_id,requester_teammate_id,assignee_teammate_id,capability,title,state,public_result
         FROM external_work_requests WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId)
      .map((request) => ({
        ...request,
        publicResult: request.public_result,
        public_result: undefined,
      }));
    const externalArtifacts = db
      .prepare(
        `SELECT a.id,a.external_work_request_id,a.path,a.file_name,a.extension,a.size_bytes,
                a.mime_type,a.metadata_json
         FROM external_work_artifacts a JOIN external_work_requests r ON r.id=a.external_work_request_id
         WHERE r.mission_id=? ORDER BY a.submitted_at,a.id`,
      )
      .all(missionId)
      .map((artifact) => ({
        id: artifact.id,
        requestId: artifact.external_work_request_id,
        path: artifact.path,
        fileName: artifact.file_name,
        extension: artifact.extension,
        sizeBytes: artifact.size_bytes,
        mimeType: artifact.mime_type,
        contentHash: JSON.parse(artifact.metadata_json).contentHash ?? null,
      }));
    const externalContinuations = db
      .prepare(
        `SELECT external_work_request_id,mission_run_id,state,created_at,updated_at,consumed_at
         FROM r2_external_work_continuations WHERE mission_id=? ORDER BY created_at,external_work_request_id`,
      )
      .all(missionId);
    const approvals = db
      .prepare(
        `SELECT id,run_id,requester_teammate_id,capability,action_type,action_payload_json,state,resolved_at
         FROM approval_requests WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId)
      .map((approval) => ({
        ...approval,
        actionPayload: JSON.parse(approval.action_payload_json),
        action_payload_json: undefined,
      }));
    const events = db
      .prepare(
        `SELECT run_id,event_type,actor_type,actor_id,payload_json,created_at
         FROM mission_events WHERE mission_id=? ORDER BY created_at,id`,
      )
      .all(missionId)
      .map((event) => ({
        ...event,
        payload: JSON.parse(event.payload_json),
        payload_json: undefined,
      }));
    const generationJobs = db
      .prepare(
        `SELECT j.id,j.generation_task_id,j.teammate_id,j.runtime_profile_id,j.state,j.provider_job_id,
                gt.task_json AS generation_task_json
         FROM generation_jobs j JOIN generation_tasks gt ON gt.id=j.generation_task_id
         WHERE json_extract(gt.task_json,'$.missionId')=? ORDER BY j.created_at,j.id`,
      )
      .all(missionId)
      .map((job) => {
        const task = JSON.parse(job.generation_task_json);
        return {
          id: job.id,
          generationTaskId: job.generation_task_id,
          teammateId: job.teammate_id,
          runtimeProfileId: job.runtime_profile_id,
          state: job.state,
          providerJobId: job.provider_job_id,
          executionAttemptId: task.executionAttemptId ?? null,
          collaborationRequestId: task.collaborationRequestId ?? null,
          runId: task.runId ?? null,
          capability: task.capability,
        };
      });
    const generationArtifacts = db
      .prepare(
        `SELECT a.id,a.job_id,a.kind,a.mime_type,a.extension,a.size_bytes,a.content_hash
         FROM generation_artifacts a JOIN generation_jobs j ON j.id=a.job_id
         JOIN generation_tasks t ON t.id=j.generation_task_id
         WHERE json_extract(t.task_json,'$.missionId')=? ORDER BY a.created_at,a.id`,
      )
      .all(missionId);
    const artifactRefs = db
      .prepare(
        `SELECT run_id,artifact_id,kind,mime_type,content_hash,size_bytes,source_type,source_id
         FROM g3_artifact_refs WHERE mission_id=? ORDER BY created_at,artifact_id`,
      )
      .all(missionId);
    const actorCounts = {
      modelCalls: db
        .prepare(
          `SELECT actor_type,actor_id,json_extract(payload_json,'$.phase') AS phase,COUNT(*) AS count
           FROM mission_events WHERE mission_id=? AND event_type='model.call_started'
           GROUP BY actor_type,actor_id,phase ORDER BY actor_type,actor_id,phase`,
        )
        .all(missionId),
    };
    return {
      mission,
      runs,
      tasks,
      attempts,
      outcomes,
      g3Continuations,
      collaborationRequests,
      externalRequests,
      externalArtifacts,
      externalContinuations,
      approvals,
      events,
      actorCounts,
      generationJobs,
      generationArtifacts,
      artifactRefs,
    };
  });
}

let live = null;

async function launch(crashPoint = null) {
  assert.equal(
    existsSync(executablePath),
    true,
    `Packaged executable not found: ${executablePath}`,
  );
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

async function capture(page, name) {
  for (const width of [1440, 1180, 900]) {
    const window = await live.app.browserWindow(page);
    await window.evaluate((win, size) => win.setContentSize(size, 900), width);
    await page.setViewportSize({ width, height: 900 });
    const path = join(evidence, `${name}-${width}x900.png`);
    await page.screenshot({ path, fullPage: true });
    facts.screenshots.push(relative(root, path));
  }
  const window = await live.app.browserWindow(page);
  await window.evaluate((win) => win.setContentSize(1440, 900));
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function configureFixture(page, app) {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspaceRoot);
  const workspace = await page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  assert.equal(workspace.rootPath, workspaceRoot, 'Workspace must be selected through typed IPC');

  const seeded = await page.evaluate(async (nonceValue) => {
    const api = window.cultivation;
    const bridgeProfile = await api.r2.bridgeProfile();
    const bridge = bridgeProfile.teammate;
    if (bridge.systemKind !== 'HUMAN_BRIDGE' || bridge.executorKind !== 'USER_BRIDGE')
      throw new Error('Packaged Main did not bootstrap the real Human Bridge identity');
    await api.r2.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    await api.r2.setCapability({ dimension: 'VISUAL_UNDERSTANDING', enabled: true });
    const enabled = await api.r2.bridgeProfile();
    for (const dimension of ['IMAGE_GENERATION', 'VISUAL_UNDERSTANDING']) {
      if (!enabled.dimensions.some((item) => item.dimension === dimension && item.enabled))
        throw new Error(`Human Bridge capability ${dimension} did not enable through typed IPC`);
    }

    const languageProvider = await api.providers.create({
      name: `G3 Human Language Provider ${nonceValue}`,
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const coordinatorRuntime = await api.runtimes.create({
      name: `G3 Human Coordinator Runtime ${nonceValue}`,
      providerId: languageProvider.id,
      credentialId: null,
      modelId: `g3-human-coordinator-${nonceValue}`,
      executionProtocol: 'LANGUAGE',
    });
    const memberRuntime = await api.runtimes.create({
      name: `G3 Human Member Runtime ${nonceValue}`,
      providerId: languageProvider.id,
      credentialId: null,
      modelId: `g3-human-member-${nonceValue}`,
      executionProtocol: 'LANGUAGE',
    });
    const generationProvider = await api.providers.create({
      name: `G3 Human Generation Provider ${nonceValue}`,
      kind: 'GENERATION_HTTP',
      adapterId: 'H3',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const imageRuntime = await api.runtimes.create({
      name: `G3 Human Image Runtime ${nonceValue}`,
      providerId: generationProvider.id,
      credentialId: null,
      modelId: `g3-image-human-${nonceValue}`,
      executionProtocol: 'GENERATION',
    });

    const makeTeammate = (name, runtime, description) =>
      api.teammates.create({
        name: `${name} ${nonceValue}`,
        avatar: 'preset:01',
        title: null,
        description,
        identityPrompt: 'Complete only the bounded Mission task assigned to this teammate.',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
    const [coordinator, languageMember, imageMember] = await Promise.all([
      makeTeammate('协调道友', coordinatorRuntime, '协调成员分工并汇总成果。'),
      makeTeammate('文本道友', memberRuntime, '基于可信素材完成分配的工作。'),
      makeTeammate('图片道友', imageRuntime, '完成图片创作并交付成果。'),
    ]);
    for (const teammate of [coordinator, languageMember, imageMember]) {
      const connection = await api.runtimes.testConnection(teammate.currentRuntimeProfileId);
      if (!connection.ok)
        throw new Error(`Sealed fixture runtime did not pass fake connection: ${teammate.name}`);
    }

    const saveBenchmark = (runtimeProfileId, modelAlias, dimension) =>
      api.capability.saveBenchmark({
        runtimeProfileId,
        modelAlias,
        dimension,
        supported: true,
        normalizedScore: 90,
        rawScore: null,
        source: 'G3 Human packaged smoke',
        benchmark: 'Deterministic test fixture capability',
        benchmarkVersion: '1',
        snapshotDate: '2026-10-06T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
    await Promise.all([
      saveBenchmark(
        coordinator.currentRuntimeProfileId,
        coordinatorRuntime.modelId,
        'GENERAL_REASONING',
      ),
      saveBenchmark(
        languageMember.currentRuntimeProfileId,
        memberRuntime.modelId,
        'GENERAL_REASONING',
      ),
      saveBenchmark(imageMember.currentRuntimeProfileId, imageRuntime.modelId, 'IMAGE_GENERATION'),
    ]);
    const languageParty = await api.parties.create({
      name: `素材协作队伍 ${nonceValue}`,
      description: '补齐素材后，由道友继续完成工作。',
      type: 'FIXED',
      coordinatorTeammateId: coordinator.id,
      memberTeammateIds: [coordinator.id, languageMember.id],
    });
    const imageParty = await api.parties.create({
      name: `创作与审查队伍 ${nonceValue}`,
      description: '图片创作完成后，由本尊独立审查。',
      type: 'FIXED',
      coordinatorTeammateId: coordinator.id,
      memberTeammateIds: [coordinator.id, imageMember.id],
    });
    return {
      bridgeId: bridge.id,
      providerIds: { language: languageProvider.id, generation: generationProvider.id },
      runtimeIds: {
        coordinator: coordinatorRuntime.id,
        languageMember: memberRuntime.id,
        image: imageRuntime.id,
      },
      teammateIds: {
        coordinator: coordinator.id,
        languageMember: languageMember.id,
        imageMember: imageMember.id,
      },
      parties: {
        language: { id: languageParty.id, name: languageParty.name },
        image: { id: imageParty.id, name: imageParty.name },
      },
    };
  }, nonce);
  return seeded;
}

async function startMission(page, fixture, { title, objective, party, targetId }) {
  const started = await page.evaluate(
    async ({ title, objective, partyId, coordinatorTeammateId }) => {
      const api = window.cultivation;
      const mission = await api.missions.create({
        title,
        objective,
        coordinatorTeammateId,
        partyId,
        mode: 'DELEGATION',
      });
      await api.missions.ready(mission.id);
      const detail = await api.missions.start({ missionId: mission.id, approvalFixture: false });
      return { mission, detail };
    },
    { title, objective, partyId: party.id, coordinatorTeammateId: fixture.teammateIds.coordinator },
  );
  assert.equal(started.detail.mission.state, 'WAITING_COLLABORATION');
  const request = started.detail.collaborations.find(
    (item) => item.targetTeammateId === targetId && item.state === 'PENDING',
  );
  assert(request, `Expected an actual pending collaboration request for ${targetId}`);
  await page.evaluate(
    (requestId) =>
      window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
    request.id,
  );
  return {
    missionId: started.mission.id,
    initialRunId: started.detail.runs[0].id,
    collaborationRequestId: request.id,
  };
}

async function waitForHumanRequest(page, missionId) {
  return waitUntil(async () => {
    const detail = await page.evaluate((id) => window.cultivation.missions.detail(id), missionId);
    const requests = await page.evaluate(() => window.cultivation.r2.listRequests());
    const request = requests.find(
      (item) =>
        item.missionId === missionId &&
        ['PENDING', 'IN_PROGRESS', 'SUBMITTED'].includes(item.state),
    );
    return request ? { detail, request } : false;
  }, `Human Bridge request for Mission ${missionId}`);
}

async function showHumanBridgeRequest(page, requestTitle) {
  await navigateUi(page, '本尊待办 Human Bridge');
  await page.getByRole('heading', { name: '本尊待办', exact: true }).waitFor();
  const entry = page.locator('.human-bridge-request-list button').filter({ hasText: requestTitle });
  await entry.waitFor({ timeout: 60_000 });
  await entry.click();
  await page.locator('.human-bridge-request-brief').waitFor();
}

function writeWorkspaceArtifact(request, fileName, contents) {
  const folder = request.targetWorkspacePathsJson.items[0];
  const relativePath = `${folder}/${fileName}`;
  const absolutePath = join(workspaceRoot, ...relativePath.split('/'));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  return relativePath;
}

async function submitThroughHumanBridgeUi(page, request, relativePath) {
  if (request.state === 'PENDING') {
    await page.getByRole('button', { name: '标记开始', exact: true }).click();
  }
  await page.locator('.r2-artifact-form input').first().fill(relativePath);
  await page.getByRole('button', { name: '提交文件', exact: true }).click();
  await page.getByLabel('公开结果摘要（可选，仅发送给协调道友）').waitFor();
}

async function acceptWithoutPublicResult(page, requestId) {
  return page.evaluate(async (id) => {
    try {
      const continuation = await window.cultivation.r2.accept({ requestId: id });
      return { accepted: true, continuation };
    } catch (cause) {
      return { accepted: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, requestId);
}

async function acceptAndExpectCrash(page, requestId) {
  assert(live, 'A packaged Main process must be live before the REVIEW_COMMITTED crash fixture');
  const current = live;
  const child = current.app.process();
  const exited = once(child, 'exit');
  const accepted = page
    .evaluate((id) => window.cultivation.r2.accept({ requestId: id }), requestId)
    .catch(() => undefined);
  let timer;
  try {
    const exit = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Configured REVIEW_COMMITTED crash point did not fire')),
          60_000,
        );
      }),
    ]);
    await Promise.race([accepted, delay(5_000)]);
    return { code: exit[0], signal: exit[1] };
  } finally {
    if (timer) clearTimeout(timer);
    live = null;
    await current.app.close().catch(() => undefined);
  }
}

async function showMission(page, title) {
  await navigateUi(page, '历练 Missions');
  await page.getByRole('heading', { name: '历练', level: 1, exact: true }).waitFor();
  await page.locator('.mission-filter-tabs').getByRole('tab', { name: /全部/ }).click();
  await page.getByRole('button', { name: title, exact: false }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.locator('.g3-collaboration').waitFor({ timeout: 60_000 });
}

async function runLanguageNeedsInput(page, fixture) {
  const title = `补充参考图片 ${nonce}`;
  const started = await startMission(page, fixture, {
    title,
    objective: '请先说明所需的图片参考，再基于可信素材完成协作。__G3_NEEDS_INPUT__',
    party: fixture.parties.language,
    targetId: fixture.teammateIds.languageMember,
  });
  const waiting = await waitForHumanRequest(page, started.missionId);
  assert.equal(waiting.detail.mission.state, 'WAITING_EXTERNAL_WORK');
  assert.equal(waiting.detail.runs[0].id, started.initialRunId);
  const requestDetail = await page.evaluate(
    (id) => window.cultivation.r2.getRequest(id),
    waiting.request.id,
  );
  assert.equal(requestDetail.request.capability, 'IMAGE_GENERATION');
  assert.deepEqual(
    requestDetail.request.targetArtifactsJson.items.map((item) => ({
      id: item.id,
      allowedExtensions: item.allowedExtensions,
    })),
    [{ id: 'input-0', allowedExtensions: ['.png'] }],
  );

  await showHumanBridgeRequest(page, '补充协作素材');
  await capture(page, 'waitingHB-language-input');
  const relativePath = writeWorkspaceArtifact(requestDetail.request, 'human-reference.png', png);
  await submitThroughHumanBridgeUi(page, waiting.request, relativePath);
  const accepted = await acceptWithoutPublicResult(page, waiting.request.id);
  assert.equal(
    accepted.accepted,
    false,
    'Exact FILE_READ approval must gate the accepted PNG read',
  );
  assert.match(accepted.error, /授权/);

  const approvalState = await page.evaluate(async (missionId) => {
    const detail = await window.cultivation.missions.detail(missionId);
    const request = detail.approvals.find(
      (item) =>
        item.actionType === 'G3_MEDIA_ACCESS' &&
        item.capability === 'FILE_READ' &&
        item.state === 'PENDING',
    );
    return { detail, request };
  }, started.missionId);
  assert(approvalState.request, 'Accepted PNG must create a pending exact FILE_READ approval');
  const submitted = await page.evaluate(
    (id) => window.cultivation.r2.getRequest(id),
    waiting.request.id,
  );
  assert.equal(submitted.request.state, 'ACCEPTED');
  assert.equal(submitted.artifacts.length, 1);
  assert.equal(submitted.artifacts[0].path, relativePath);
  const fileResource = `file:${workspaceRoot}:${submitted.artifacts[0].path}`;
  assert.equal(approvalState.request.actionPayload.resource, fileResource);
  assert.equal(approvalState.request.runId, started.initialRunId);
  assert.equal(approvalState.detail.mission.state, 'WAITING_APPROVAL');
  await page.evaluate(
    (approvalId) =>
      window.cultivation.missions.resolveApproval({ approvalId, decision: 'ALLOW_MISSION' }),
    approvalState.request.id,
  );

  const completed = await waitUntil(async () => {
    const detail = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      started.missionId,
    );
    return ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(detail.mission.state)
      ? detail
      : false;
  }, 'original LANGUAGE Mission Run completion after FILE_READ approval');
  assert.equal(completed.mission.state, 'COMPLETED');
  assert.equal(
    completed.runs.length,
    1,
    'Human Bridge continuation must remain in the original Run',
  );
  assert.equal(completed.runs[0].id, started.initialRunId);

  const audit = auditMission(profile, started.missionId);
  assert.equal(audit.runs.length, 1);
  assert.equal(audit.runs[0].id, started.initialRunId);
  assert.equal(audit.runs[0].status, 'COMPLETED');
  assert.equal(
    audit.collaborationRequests.length,
    1,
    'Continuation must not create a duplicate collaboration request',
  );
  assert.equal(audit.externalRequests.length, 1);
  assert.equal(audit.externalRequests[0].state, 'ACCEPTED');
  assert.equal(audit.externalRequests[0].assignee_teammate_id, fixture.bridgeId);
  assert.equal(audit.externalRequests[0].requester_teammate_id, fixture.teammateIds.coordinator);
  assert.equal(audit.externalRequests[0].capability, 'IMAGE_GENERATION');
  assert.equal(audit.externalArtifacts.length, 1);
  assert.equal(audit.externalArtifacts[0].path, relativePath);
  assert.equal(audit.externalArtifacts[0].extension, '.png');
  assert.equal(audit.externalArtifacts[0].contentHash, digest(png));
  assert(
    audit.artifactRefs.some(
      (ref) =>
        ref.artifact_id === audit.externalArtifacts[0].id &&
        ref.kind === 'IMAGE' &&
        ref.mime_type === 'image/png' &&
        ref.source_type === 'EXTERNAL_WORK' &&
        ref.source_id === audit.externalArtifacts[0].id,
    ),
    'Accepted PNG must become a verified same-Run IMAGE ArtifactRef',
  );
  assert.equal(audit.externalContinuations.length, 1);
  assert.equal(audit.externalContinuations[0].state, 'CONSUMED');
  assert(audit.externalContinuations[0].consumed_at);
  assert.equal(
    audit.generationJobs.length,
    0,
    'LANGUAGE NEEDS_INPUT fixture must not invent an image job',
  );

  const needsInput = audit.outcomes.find(
    (outcome) =>
      outcome.kind === 'NEEDS_INPUT' &&
      outcome.participantTeammateId === fixture.teammateIds.languageMember,
  );
  assert(needsInput, 'Sealed LANGUAGE member must persist its structured NEEDS_INPUT outcome');
  assert(
    needsInput.requirements.some(
      (item) =>
        item.role === 'REFERENCE' &&
        item.artifactKinds.includes('IMAGE') &&
        item.mimeTypes.includes('image/png'),
    ),
  );
  assert(
    needsInput.consumedAt,
    'NEEDS_INPUT outcome continuation must be consumed once after resumption',
  );
  const inputContinuation = audit.g3Continuations.find(
    (continuation) => continuation.outcome_id === needsInput.id,
  );
  assert(inputContinuation, 'NEEDS_INPUT must have one durable G3 continuation');
  assert.equal(inputContinuation.action, 'RESUME');
  assert(
    inputContinuation.consumed_at,
    'NEEDS_INPUT G3 continuation must be consumed after its successor completes',
  );
  assert.equal(
    audit.g3Continuations.filter((continuation) => continuation.outcome_id === needsInput.id)
      .length,
    1,
  );
  const memberTasks = audit.tasks.filter(
    (task) => task.target_teammate_id === fixture.teammateIds.languageMember,
  );
  assert.equal(
    memberTasks.length,
    2,
    'Input resumption creates one bounded successor LANGUAGE task',
  );
  assert.equal(memberTasks.filter((task) => task.parent_task_id !== null).length, 1);
  assert.equal(memberTasks.filter((task) => task.continuation_round === 1).length, 1);
  const resumedLanguageTask = memberTasks.find((task) => task.parent_task_id !== null);
  assert(
    resumedLanguageTask?.publicContext.includes('素材已提供'),
    'The trusted successor context must tell FakeModelGateway the requested input is now available',
  );
  assert(
    resumedLanguageTask?.artifactInputs.some(
      (input) =>
        input.role === 'REFERENCE' && input.kind === 'IMAGE' && input.mimeType === 'image/png',
    ),
  );
  assert.equal(
    audit.outcomes.filter(
      (outcome) =>
        outcome.kind === 'RESULT' &&
        outcome.participantTeammateId === fixture.teammateIds.languageMember,
    ).length,
    1,
  );
  const approval = audit.approvals.find(
    (item) => item.id === approvalState.request.id && item.action_type === 'G3_MEDIA_ACCESS',
  );
  assert(approval);
  assert.equal(approval.capability, 'FILE_READ');
  assert.equal(approval.actionPayload.resource, fileResource);
  assert.equal(approval.state, 'APPROVED');
  assert.equal(
    audit.events.filter(
      (event) =>
        event.event_type === 'collaboration.input_requested' &&
        event.actor_id === fixture.teammateIds.coordinator &&
        event.payload.participantTeammateId === fixture.teammateIds.languageMember,
    ).length,
    1,
  );
  assert.equal(
    audit.events.filter(
      (event) =>
        event.event_type === 'collaboration.completed' &&
        event.actor_id === fixture.teammateIds.languageMember,
    ).length,
    1,
  );
  assert.equal(
    audit.events.filter((event) => event.event_type === 'collaboration.media_review_completed')
      .length,
    0,
  );
  assert.equal(
    audit.actorCounts.modelCalls
      .filter(
        (item) => item.phase === 'SYNTHESIS' && item.actor_id === fixture.teammateIds.coordinator,
      )
      .reduce((sum, item) => sum + item.count, 0),
    1,
  );
  facts.scenarios.languageNeedsInput = {
    ...started,
    humanBridgeRequestId: waiting.request.id,
    acceptedFile: {
      relativePath,
      mimeType: 'image/png',
      contentHash: audit.externalArtifacts[0].contentHash,
    },
    fileReadApprovalId: approval.id,
    structuredOutcomeId: needsInput.id,
    structuredContinuationId: inputContinuation.id,
    languageTasks: memberTasks.map((task) => ({
      id: task.id,
      continuationRound: task.continuation_round,
      parentTaskId: task.parent_task_id,
    })),
    state: audit.mission.state,
    externalContinuation: audit.externalContinuations[0].state,
    synthesisCalls: 1,
    actualActors: {
      coordinatorTeammateId: fixture.teammateIds.coordinator,
      languageParticipantTeammateId: fixture.teammateIds.languageMember,
      humanBridgeTeammateId: fixture.bridgeId,
    },
  };
  facts.database[started.missionId] = audit;
  return { ...started, title };
}

async function runGenerationReview(page, fixture) {
  const title = `创作与审查图片 ${nonce}`;
  const started = await startMission(page, fixture, {
    title,
    objective: '生成一张图片并请本尊提交独立审查意见。__G3_REVIEW__',
    party: fixture.parties.image,
    targetId: fixture.teammateIds.imageMember,
  });
  const waiting = await waitForHumanRequest(page, started.missionId);
  assert.equal(waiting.detail.mission.state, 'WAITING_EXTERNAL_WORK');
  assert.equal(waiting.detail.runs[0].id, started.initialRunId);
  const requestDetail = await page.evaluate(
    (id) => window.cultivation.r2.getRequest(id),
    waiting.request.id,
  );
  assert.equal(requestDetail.request.title, '审查生成结果');
  assert.equal(requestDetail.request.capability, 'VISUAL_UNDERSTANDING');
  assert.deepEqual(
    requestDetail.request.targetArtifactsJson.items.map((item) => ({
      id: item.id,
      name: item.name,
      allowedExtensions: item.allowedExtensions,
    })),
    [{ id: 'review', name: '媒体审查意见', allowedExtensions: ['.txt'] }],
  );

  await showHumanBridgeRequest(page, '审查生成结果');
  await capture(page, 'review-human-bridge-waiting');
  const relativePath = writeWorkspaceArtifact(
    requestDetail.request,
    'review-notes.txt',
    Buffer.from('画面主体清晰，符合任务目标；建议保留当前构图。', 'utf8'),
  );
  await submitThroughHumanBridgeUi(page, waiting.request, relativePath);
  const crash = await acceptAndExpectCrash(page, waiting.request.id);
  facts.scenarios.generationReview = {
    ...started,
    humanBridgeRequestId: waiting.request.id,
    crashPoint: 'REVIEW_COMMITTED',
    mainProcessExit: crash,
  };
  const afterCrash = auditMission(profile, started.missionId);
  assert.equal(
    afterCrash.mission.state,
    'RUNNING',
    'Crash fixture must stop before coordinator recovery',
  );
  assert.equal(afterCrash.runs.length, 1);
  assert.equal(afterCrash.runs[0].id, started.initialRunId);
  assert.equal(afterCrash.externalRequests.length, 1);
  assert.equal(afterCrash.externalRequests[0].state, 'ACCEPTED');
  assert.equal(
    afterCrash.externalRequests[0].publicResult,
    null,
    'Omitted publicResult must be durably null',
  );
  assert.equal(afterCrash.externalContinuations.length, 1);
  assert.equal(afterCrash.externalContinuations[0].state, 'CONSUMED');
  assert(afterCrash.externalContinuations[0].consumed_at);
  assert.equal(
    afterCrash.events.filter((event) => event.event_type === 'collaboration.media_review_completed')
      .length,
    1,
  );
  assert.equal(
    afterCrash.events.filter(
      (event) => event.event_type === 'model.call_started' && event.payload.phase === 'SYNTHESIS',
    ).length,
    0,
    'REVIEW_COMMITTED must crash before Coordinator recovery starts',
  );
  assert.equal(afterCrash.generationJobs.length, 1);
  assert.equal(
    afterCrash.events.filter((event) => event.event_type === 'collaboration.review_requested')
      .length,
    1,
  );
  assert.equal(
    afterCrash.events.filter((event) => event.event_type === 'collaboration.media_review_completed')
      .length,
    1,
  );
  live = await launch();

  page = live.page;
  const completed = await waitUntil(async () => {
    const detail = await live.page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      started.missionId,
    );
    return ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(detail.mission.state)
      ? detail
      : false;
  }, 'image review Mission completion and coordinator synthesis');
  assert.equal(completed.mission.state, 'COMPLETED');
  assert.equal(completed.runs.length, 1);
  assert.equal(completed.runs[0].id, started.initialRunId);

  const audit = auditMission(profile, started.missionId);
  assert.equal(audit.runs.length, 1, 'Accepted review must not restart or duplicate a Mission Run');
  assert.equal(audit.runs[0].id, started.initialRunId);
  assert.equal(audit.collaborationRequests.length, 1);
  assert.equal(audit.collaborationRequests[0].state, 'APPROVED');
  assert.equal(
    audit.externalRequests.length,
    1,
    'Review continuation must not create a duplicate Human Bridge request',
  );
  assert.equal(audit.externalRequests[0].state, 'ACCEPTED');
  assert.equal(audit.externalRequests[0].assignee_teammate_id, fixture.bridgeId);
  assert.equal(audit.externalRequests[0].requester_teammate_id, fixture.teammateIds.coordinator);
  assert.equal(audit.externalRequests[0].capability, 'VISUAL_UNDERSTANDING');
  assert.equal(audit.externalRequests[0].publicResult, null);
  assert.equal(audit.externalContinuations.length, 1);
  assert.equal(audit.externalContinuations[0].state, 'CONSUMED');
  assert(audit.externalContinuations[0].consumed_at);
  assert.equal(audit.externalArtifacts.length, 1);
  assert.equal(audit.externalArtifacts[0].path, relativePath);
  assert.equal(audit.externalArtifacts[0].extension, '.txt');
  assert.equal(
    audit.externalArtifacts[0].contentHash,
    digest(Buffer.from('画面主体清晰，符合任务目标；建议保留当前构图。', 'utf8')),
  );
  assert.equal(
    audit.generationJobs.length,
    1,
    'Review continuation must reuse the actual completed image GenerationJob',
  );
  assert.equal(audit.generationJobs[0].teammateId, fixture.teammateIds.imageMember);
  assert.equal(audit.generationJobs[0].state, 'COMPLETED');
  assert.equal(audit.generationArtifacts.length, 1);
  assert.equal(audit.generationArtifacts[0].mime_type, 'image/png');
  assert.equal(
    audit.outcomes.filter(
      (outcome) =>
        outcome.kind === 'RESULT' &&
        outcome.participantTeammateId === fixture.teammateIds.imageMember,
    ).length,
    1,
  );
  assert.equal(
    audit.g3Continuations.filter((continuation) => continuation.action === 'REVIEW').length,
    1,
  );
  assert(
    audit.g3Continuations.find((continuation) => continuation.action === 'REVIEW')?.consumed_at,
  );
  const reviewRequested = audit.events.filter(
    (event) => event.event_type === 'collaboration.review_requested',
  );
  const reviewCompleted = audit.events.filter(
    (event) => event.event_type === 'collaboration.media_review_completed',
  );
  assert.equal(reviewRequested.length, 1);
  assert.equal(reviewRequested[0].actor_id, fixture.teammateIds.coordinator);
  assert.equal(reviewCompleted.length, 1);
  assert.equal(reviewCompleted[0].actor_id, fixture.bridgeId);
  assert.equal(reviewCompleted[0].payload.externalWorkRequestId, waiting.request.id);
  assert.equal(reviewCompleted[0].payload.summary, '本尊已验收审查意见文件');
  assert.equal(
    audit.events.filter(
      (event) =>
        event.event_type === 'model.call_started' &&
        event.payload.phase === 'SYNTHESIS' &&
        event.actor_id === fixture.teammateIds.coordinator,
    ).length,
    1,
    'Coordinator synthesis must resume once without a restart',
  );
  assert.equal(
    audit.events.filter(
      (event) =>
        event.event_type === 'collaboration.completed' &&
        event.actor_id === fixture.teammateIds.imageMember,
    ).length,
    1,
  );
  assert.equal(
    audit.approvals.filter((approval) => approval.action_type === 'G3_MEDIA_ACCESS').length,
    0,
  );

  await showMission(live.page, title);
  await live.page.locator('.g3-collaboration').scrollIntoViewIfNeeded();
  await capture(page, 'final-human-review-synthesis');
  facts.scenarios.generationReview = {
    ...started,
    humanBridgeRequestId: waiting.request.id,
    crashPoint: 'REVIEW_COMMITTED',
    mainProcessExit: crash,
    acceptedFile: {
      relativePath,
      extension: '.txt',
      contentHash: audit.externalArtifacts[0].contentHash,
    },
    publicResult: audit.externalRequests[0].publicResult,
    generationJobId: audit.generationJobs[0].id,
    imageArtifactId: audit.generationArtifacts[0].id,
    reviewRequestedEventCount: reviewRequested.length,
    reviewCompletedEventCount: reviewCompleted.length,
    state: audit.mission.state,
    externalContinuation: audit.externalContinuations[0].state,
    synthesisCalls: 1,
    actualActors: {
      coordinatorTeammateId: fixture.teammateIds.coordinator,
      imageParticipantTeammateId: fixture.teammateIds.imageMember,
      humanBridgeTeammateId: fixture.bridgeId,
    },
  };
  facts.database[started.missionId] = audit;
  return { ...started, title };
}

async function main() {
  live = await launch();
  const fixture = await configureFixture(live.page, live.app);
  facts.package.status = 'LAUNCHED';
  facts.package.seededThroughTypedIpc = true;
  facts.package.setup = fixture;

  const needsInput = await runLanguageNeedsInput(live.page, fixture);
  await closeLive();
  live = await launch('REVIEW_COMMITTED');
  const review = await runGenerationReview(live.page, fixture);
  facts.package.status = 'PASS';
  facts.status = 'PASS';
  facts.package.missions = [needsInput.missionId, review.missionId];
}

try {
  await main();
} catch (error) {
  facts.status = 'FAILED';
  facts.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  throw error;
} finally {
  await closeLive();
  writeFileSync(join(evidence, 'facts.json'), JSON.stringify(facts, null, 2), 'utf8');
}

console.log(
  `G3_HUMAN_PACKAGED_SMOKE_${facts.status} needs_input=language-structured,file_read=exact-review=accepted-empty-summary=no-restart screenshots=1440_1180_900 evidence=${relative(root, evidence)}`,
);
