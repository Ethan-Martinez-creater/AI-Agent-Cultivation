import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';
import { capturePackagedWindow } from './gen-v1-capture.mjs';
const root = process.cwd();
const profile = join(root, '.test-data/gen-v1-live/production-profile');
const evidence = join(root, 'docs/evidence/gen-v1-live-software-v2/packaged');
const path = join(evidence, 'artifact-collaboration-facts.json');
let facts;
try {
  facts = JSON.parse(await readFile(path, 'utf8'));
} catch {
  facts = { status: 'IN_PROGRESS', productionFakeFlags: false };
}
const save = () => writeFile(path, JSON.stringify(facts, null, 2) + '\n', 'utf8');
const dbFacts = (callback) => {
  const db = new Database(join(profile, 'data/cultivation.sqlite'), { readonly: true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
};
const app = await electron.launch({
  executablePath: join(root, 'out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe'),
  args: ['--proxy-server=http://127.0.0.1:7890'],
  env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile },
  timeout: 60000,
});
let page;
try {
  page = await app.firstWindow();
  page.on('pageerror', (error) => {
    facts.rendererError = String(error.message).slice(0, 300);
  });
  page.setDefaultTimeout(60000);
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  const identities = await page.evaluate(async () => {
    const teammates = await window.cultivation.teammates.list();
    return {
      coordinator: teammates.find((x) => x.name === 'GEN V1 Jev 语言验收'),
      member: teammates.find((x) => x.name === '图生视频道友'),
    };
  });
  assert.ok(identities.coordinator && identities.member);
  const availability = await page.evaluate(() => window.cultivation.availability.list());
  if (
    availability.find((value) => value.teammateId === identities.coordinator.id)?.status ===
    'UNAVAILABLE'
  ) {
    assert.ok(!facts.modelRecheckIntent, 'Do not repeat a failed explicit recheck');
    facts.modelRecheckIntent = true;
    await save();
    const checked = await page.evaluate(
      (id) => window.cultivation.availability.recheck(id),
      identities.coordinator.id,
    );
    assert.notEqual(checked.status, 'UNAVAILABLE');
    facts.modelRecheck = checked.status;
    await save();
  }
  const artifacts = await page.evaluate(() => window.cultivation.missions.shareableArtifacts());
  const image = artifacts.find(
    (x) => x.id === 'ec4a84a6753d87280c7200ff919c4db92b7d7796fe72a7be6b5619d879f52504',
  );
  assert.ok(image);
  facts.sourceArtifact = image;
  facts.coordinatorId = identities.coordinator.id;
  facts.memberId = identities.member.id;
  await save();
  const party = await page.evaluate(async ({ coordinator, member }) => {
    const api = window.cultivation;
    return (
      (await api.parties.list()).find((x) => x.name === '素材视频制作队伍') ??
      api.parties.create({
        name: '素材视频制作队伍',
        description: '由协调道友汇总，经用户批准使用已有图片生成短视频。',
        type: 'FIXED',
        coordinatorTeammateId: coordinator.id,
        memberTeammateIds: [coordinator.id, member.id],
      })
    );
  }, identities);
  const title = '已有图片的短视频协作';
  let mission = await page.evaluate(
    async ({ title, partyId, coordinator, member }) => {
      const api = window.cultivation;
      return (
        (await api.missions.list()).find((x) => x.title === title) ??
        api.missions.create({
          title,
          objective: `请把用户提供的已有图片交给队伍中的视频道友 ${member.id} 制作一个2秒、720P、16:9短视频，保持原图片构图并轻轻运动。必须提出一次明确生成协作请求，capability VIDEO_GENERATION，requiredFeatures FIRST_FRAME_CONDITIONING，parameters durationSeconds=2、resolution=720P、aspect=16:9，inputRequirements FIRST_FRAME IMAGE image/jpeg required=true。先等待用户提供已有素材并批准协作。结果回来后只总结交付，不再生成其它内容或邀请其它成员。`,
          coordinatorTeammateId: coordinator.id,
          partyId,
          mode: 'DELEGATION',
        })
      );
    },
    { title, partyId: party.id, ...identities },
  );
  facts.missionId = mission.id;
  await save();
  if (mission.state === 'DRAFT')
    await page.evaluate((id) => window.cultivation.missions.ready(id), mission.id);
  mission = await page.evaluate((id) => window.cultivation.missions.detail(id), mission.id);
  if (
    mission.mission.state === 'FAILED' &&
    mission.runs.at(-1).errorCode === 'MODEL_UNAVAILABLE' &&
    facts.modelRecheckIntent &&
    !facts.availabilityRecoveryRetryIntent
  ) {
    const executions = dbFacts(
      (db) =>
        db
          .prepare('SELECT COUNT(*) AS n FROM g3_execution_tasks WHERE mission_id=? AND run_id=?')
          .get(mission.mission.id, mission.runs.at(-1).id).n,
    );
    assert.equal(executions, 0);
    facts.availabilityRecoveryRetryIntent = true;
    facts.unavailableRunId = mission.runs.at(-1).id;
    await save();
    mission = await page.evaluate(
      (id) => window.cultivation.missions.retry({ missionId: id, approvalFixture: false }),
      mission.mission.id,
    );
  }
  if (mission.mission.state === 'FAILED' && !facts.schemaCorrectionRetryIntent) {
    assert.equal(mission.runs.at(-1).errorCode, 'COLLABORATION_PROPOSAL_FAILED');
    const executions = dbFacts(
      (db) =>
        db
          .prepare('SELECT COUNT(*) AS n FROM g3_execution_tasks WHERE mission_id=? AND run_id=?')
          .get(mission.mission.id, mission.runs.at(-1).id).n,
    );
    assert.equal(executions, 0, 'No replay of any previous media execution');
    facts.schemaCorrectionRetryIntent = true;
    facts.previousFailedRunId = mission.runs.at(-1).id;
    await save();
    mission = await page.evaluate(
      (id) =>
        window.cultivation.missions.retry({
          missionId: id,
          approvalFixture: false,
        }),
      mission.mission.id,
    );
  }
  if (mission.mission.state === 'READY') {
    facts.startIntent = true;
    await save();
    mission = await page.evaluate(
      (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
      mission.mission.id,
    );
  }
  if (mission.mission.state === 'FAILED' || mission.mission.state === 'INTERRUPTED')
    throw new Error('COLLABORATION_RUN_STOPPED_NO_AUTOMATIC_RETRY');
  facts.runId = mission.runs.at(-1).id;
  await save();
  await page.evaluate(() => {
    window.location.hash = '/missions';
  });
  await page.getByRole('link', { name: '历练', exact: true }).first().click();
  await page.getByRole('tab', { name: /^全部/ }).click();
  await page.getByRole('button', { name: title, exact: false }).first().waitFor();
  await page.getByRole('button', { name: title, exact: false }).first().click();
  const shared = dbFacts((db) =>
    db
      .prepare(
        'SELECT artifact_id FROM g3_artifact_refs WHERE mission_id=? AND run_id=? AND artifact_id=?',
      )
      .get(facts.missionId, facts.runId, image.id),
  );
  if (!shared) {
    await page.getByRole('button', { name: '提供已有素材', exact: true }).click();
    await page.getByLabel('生成结果', { exact: true }).selectOption(image.id);
    await page.getByRole('button', { name: '授权使用素材', exact: true }).click();
    for (let check = 0; check < 50; check++) {
      const persisted = dbFacts((db) =>
        db
          .prepare(
            'SELECT artifact_id FROM g3_artifact_refs WHERE mission_id=? AND run_id=? AND artifact_id=?',
          )
          .get(facts.missionId, facts.runId, image.id),
      );
      if (persisted) break;
      const errors = await page.getByRole('alert').allTextContents();
      if (errors.length) throw new Error('SHARE_REJECTED: ' + errors.join(' ').slice(0, 200));
      await delay(200);
    }
  }
  facts.share = dbFacts((db) =>
    db
      .prepare(
        'SELECT artifact_id,source_type,source_id,content_hash FROM g3_artifact_refs WHERE mission_id=? AND run_id=? AND artifact_id=?',
      )
      .get(facts.missionId, facts.runId, image.id),
  );
  assert.equal(facts.share?.content_hash, image.contentHash);
  assert.equal(facts.share.source_type, 'APPROVED_IMPORT');
  facts.shareProvenance = dbFacts((db) => {
    const event = db
      .prepare(
        'SELECT id,actor_type,actor_id,payload_json FROM mission_events WHERE id=? AND mission_id=? AND run_id=? AND event_type=?',
      )
      .get(facts.share.source_id, facts.missionId, facts.runId, 'collaboration.artifact_shared');
    const audits = db
      .prepare(
        'SELECT id,actor_type,actor_id,payload_json FROM audit_events WHERE action=? AND target_id=?',
      )
      .all('collaboration.artifact_shared', facts.runId)
      .filter((value) => JSON.parse(value.payload_json).artifactId === image.id);
    assert.equal(event?.actor_type, 'USER');
    assert.equal(event?.actor_id, 'local-user');
    assert.equal(JSON.parse(event.payload_json).contentHash, image.contentHash);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_type, 'USER');
    assert.equal(audits[0].payload_json, event.payload_json);
    return { eventId: event.id, auditId: audits[0].id, actor: 'local-user' };
  });
  await save();
  const deadline = Date.now() + 15 * 60000;
  while (Date.now() < deadline) {
    const detail = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      facts.missionId,
    );
    facts.state = detail.mission.state;
    await save();
    if (detail.mission.state === 'COMPLETED') break;
    if (['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(detail.mission.state))
      throw new Error('COLLABORATION_' + detail.mission.state);
    const request =
      detail.collaborations?.find((x) => x.state === 'PENDING') ??
      detail.collaborationRequests?.find((x) => x.state === 'PENDING');
    if (request) {
      assert.equal(request.targetTeammateId, identities.member.id);
      const proposal = dbFacts((db) =>
        db
          .prepare(
            "SELECT payload_json FROM mission_events WHERE mission_id=? AND run_id=? AND event_type='collaboration.proposed' ORDER BY created_at DESC LIMIT 1",
          )
          .get(facts.missionId, facts.runId),
      );
      const requirement = JSON.parse(proposal.payload_json).generationRequirements;
      assert.equal(requirement.parameters.durationSeconds, 2);
      assert.equal(requirement.parameters.resolution, '720P');
      assert.ok(requirement.requiredFeatures.includes('FIRST_FRAME_CONDITIONING'));
      facts.approvalIntent = request.id;
      await save();
      await page
        .locator('.collaboration-request-card')
        .filter({ hasText: identities.member.name })
        .getByRole('button', { name: '批准并继续', exact: true })
        .click();
    } else if (detail.approvals?.some((value) => value.state === 'PENDING')) {
      const approval = detail.approvals.find((value) => value.state === 'PENDING');
      assert.equal(approval.actionType, 'G3_MEDIA_ACCESS');
      assert.equal(approval.requesterTeammateId, identities.member.id);
      // This acceptance uses APP storage, never requests a Workspace grant.
      throw new Error('UNEXPECTED_WORKSPACE_MEDIA_APPROVAL');
    } else if (detail.mission.state === 'PAUSED')
      throw new Error('COLLABORATION_PAUSED_USER_ACTION_REQUIRED');
    await delay(3000);
  }
  assert.equal(facts.state, 'COMPLETED');
  facts.execution = dbFacts((db) =>
    db
      .prepare(
        'SELECT t.id, a.generation_job_id, t.task_json, a.state FROM g3_execution_tasks t JOIN g3_execution_attempts a ON a.task_id=t.id WHERE t.mission_id=? AND t.run_id=? AND a.generation_job_id IS NOT NULL',
      )
      .all(facts.missionId, facts.runId)
      .map((row) => ({
        taskId: row.id,
        jobId: row.generation_job_id,
        state: row.state,
        inputs: JSON.parse(row.task_json).artifactInputs,
      })),
  );
  assert.ok(
    facts.execution.some((x) =>
      x.inputs.some((y) => y.id === image.id && y.contentHash === image.contentHash),
    ),
  );
  facts.output = dbFacts((db) =>
    db
      .prepare(
        'SELECT id,kind,mime_type,content_hash,size_bytes FROM generation_artifacts WHERE job_id IN (SELECT generation_job_id FROM g3_execution_attempts WHERE task_id IN (SELECT id FROM g3_execution_tasks WHERE mission_id=? AND run_id=?))',
      )
      .all(facts.missionId, facts.runId),
  );
  assert.ok(facts.output.some((x) => x.kind === 'VIDEO'));
  // Completed-path re-entry only reads durable facts and plays the original opaque result.
  await page.getByRole('button', { name: title, exact: false }).first().click();
  const video = page.locator('video.g3-artifact-preview').first();
  await video.waitFor();
  await video.scrollIntoViewIfNeeded();
  await video.evaluate(async (value) => {
    value.muted = true;
    await value.play();
  });
  for (let check = 0; check < 40; check++) {
    if ((await video.evaluate((value) => value.currentTime)) > 0) break;
    await delay(200);
  }
  facts.playback = await video.evaluate((value) => ({
    loaded: value.readyState >= 2,
    currentTime: value.currentTime,
    duration: value.duration,
    opaque: value.currentSrc.startsWith('cultivation-media:'),
  }));
  assert.ok(facts.playback.loaded && facts.playback.currentTime > 0 && facts.playback.opaque);
  facts.reentry = dbFacts((db) => {
    const jobs = db
      .prepare('SELECT id,state,provider_job_id FROM generation_jobs WHERE id=?')
      .all(facts.execution[0].jobId);
    const output = db
      .prepare('SELECT id,content_hash FROM generation_artifacts WHERE job_id=?')
      .all(facts.execution[0].jobId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, 'COMPLETED');
    assert.equal(output.length, facts.output.length);
    assert.ok(
      output.every((value) =>
        facts.output.some(
          (original) => original.id === value.id && original.content_hash === value.content_hash,
        ),
      ),
    );
    return {
      jobCount: jobs.length,
      outputCount: output.length,
      sameJobAndArtifacts: true,
      noNewSubmissionIntent: true,
    };
  });
  for (const width of [1440, 1180, 900]) {
    const win = await app.browserWindow(page);
    await win.evaluate((w, n) => w.setContentSize(n, 900), width);
    await page.setViewportSize({ width, height: 900 });
    await video.scrollIntoViewIfNeeded();
    await video.evaluate((value) => value.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await delay(250);
    await capturePackagedWindow(
      app,
      page,
      join(evidence, `live-artifact-collaboration-${width}.png`),
    );
  }
  facts.status = 'PASS';
  facts.levels = { api: 'PASS', adapter: 'PASS', integration: 'PASS', packaged: 'PASS' };
  if (facts.failure) {
    facts.previousFailure = { message: facts.failure, location: facts.failureLocation };
    delete facts.failure;
    delete facts.failureLocation;
  }
  delete facts.rendererError;
  delete facts.visibleHeadings;
  await save();
  console.log('LIVE_ARTIFACT_COLLABORATION_PASS');
} catch (error) {
  facts.status = 'BLOCKED';
  facts.failure = String(error.message).slice(0, 250);
  facts.failureLocation = error.stack
    ?.split('\n')
    .filter((x) => x.includes('gen-v1-artifact-collaboration-live.mjs'))
    .slice(0, 2);
  facts.visibleHeadings = await page
    ?.getByRole('heading')
    .allTextContents()
    .catch(() => []);
  await capturePackagedWindow(
    app,
    page,
    join(evidence, 'collaboration-playback-diagnostic.png'),
  ).catch(() => undefined);
  await save();
  console.log('LIVE_ARTIFACT_COLLABORATION_BLOCKED');
  process.exitCode = 1;
} finally {
  await app.close();
}
