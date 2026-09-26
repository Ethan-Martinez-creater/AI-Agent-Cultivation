import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const userData = join(process.cwd(), '.test-data', `gate3-packaged-${Date.now()}`);
mkdirSync(userData, { recursive: true });

async function launch() {
  const app = await electron.launch({
    executablePath,
    args: ['--gate1-fake-model'],
    timeout: 30_000,
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  return { app, page };
}

let first = await launch();
let fixture;
try {
  fixture = await first.page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'Gate3 local fixture',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'Gate3 Fake Runtime',
      providerId: provider.id,
      credentialId: null,
      modelId: 'gate3-fake',
    });
    const teammateInput = {
      avatar: null,
      title: null,
      description: '',
      identityPrompt: 'You are a scoped teammate.',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    };
    const a = await api.teammates.create({ ...teammateInput, name: 'Mission A' });
    const b = await api.teammates.create({ ...teammateInput, name: 'Mission B' });
    const inspectMarker = '__GATE2_PROMPT_INSPECT__';
    await api.memories.create({
      teammateId: a.id,
      memoryType: 'FACT',
      content: 'Alpha fact',
      summary: `${inspectMarker} GATE3_A_MEMORY_ONLY`,
      importance: 0.9,
    });
    await api.memories.create({
      teammateId: b.id,
      memoryType: 'FACT',
      content: 'Beta fact',
      summary: `${inspectMarker} GATE3_B_MEMORY_ONLY`,
      importance: 0.9,
    });
    const skillA = await api.skills.create({
      name: 'Gate3 A Skill',
      description: '',
      instructions: 'GATE3_A_SKILL_ONLY',
      tags: [],
    });
    const skillB = await api.skills.create({
      name: 'Gate3 B Skill',
      description: '',
      instructions: 'GATE3_B_SKILL_ONLY',
      tags: [],
    });
    await api.skills.assign({ teammateId: a.id, skillId: skillA.id });
    await api.skills.assign({ teammateId: b.id, skillId: skillB.id });
    await api.skills.setEnabled({ teammateId: a.id, skillId: skillA.id, enabled: true });
    await api.skills.setEnabled({ teammateId: b.id, skillId: skillB.id, enabled: true });
    const createReady = async (title, teammateId, objective = inspectMarker) => {
      const mission = await api.missions.create({
        title,
        objective,
        coordinatorTeammateId: teammateId,
      });
      await api.missions.ready(mission.id);
      return mission.id;
    };
    const soloA = await createReady('SOLO A', a.id);
    const soloB = await createReady('SOLO B', b.id);
    const resultA = await api.missions.start({ missionId: soloA, approvalFixture: false });
    const resultB = await api.missions.start({ missionId: soloB, approvalFixture: false });
    const waiting = await createReady('WAITING', a.id, 'Approval persistence');
    await api.missions.start({ missionId: waiting, approvalFixture: true });
    const scopedAllow = await createReady('MISSION GRANT', a.id, 'Mission scoped grant');
    const scopedOther = await createReady('OTHER MISSION', a.id, 'Mission grant isolation');
    const paused = await createReady('PAUSED', a.id, 'Pause persistence');
    const interrupted = await createReady('INTERRUPTED', a.id, 'Crash recovery');
    return {
      a: a.id,
      b: b.id,
      runtime: runtime.id,
      provider: provider.id,
      soloA,
      soloB,
      resultA,
      resultB,
      waiting,
      scopedAllow,
      scopedOther,
      paused,
      interrupted,
      conversationsA: await api.chat.listConversations(a.id),
      conversationsB: await api.chat.listConversations(b.id),
    };
  });
  assert.equal(fixture.resultA.mission.state, 'COMPLETED');
  assert.equal(fixture.resultB.mission.state, 'COMPLETED');
  assert.equal(fixture.resultA.runs.length, 1);
  assert.equal(fixture.resultA.runs[0].attempt, 1);
  assert.equal(fixture.resultA.runs[0].status, 'COMPLETED');
  assert.ok(fixture.resultA.runs[0].resultText.includes('GATE3_A_MEMORY_ONLY'));
  assert.ok(fixture.resultA.runs[0].resultText.includes('GATE3_A_SKILL_ONLY'));
  assert.ok(!fixture.resultA.runs[0].resultText.includes('GATE3_B_MEMORY_ONLY'));
  assert.ok(!fixture.resultA.runs[0].resultText.includes('GATE3_B_SKILL_ONLY'));
  assert.ok(fixture.resultB.runs[0].resultText.includes('GATE3_B_MEMORY_ONLY'));
  assert.ok(!fixture.resultB.runs[0].resultText.includes('GATE3_A_MEMORY_ONLY'));
  assert.deepEqual(fixture.conversationsA, []);
  assert.deepEqual(fixture.conversationsB, []);
  const waiting = await first.page.evaluate(
    (id) => window.cultivation.missions.detail(id),
    fixture.waiting,
  );
  assert.equal(waiting.mission.state, 'WAITING_APPROVAL');
  assert.equal(waiting.runs[0].status, 'RUNNING');
  assert.equal(waiting.approvals.filter((item) => item.state === 'PENDING').length, 1);
} finally {
  await first.app.close();
}

const path = join(userData, 'data', 'cultivation.sqlite');
const db = new Database(path);
try {
  db.pragma('foreign_keys = ON');
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO permission_rules
    (id, subject_type, subject_id, capability, resource_pattern, decision, scope, scope_id)
    VALUES (?, 'TEAMMATE', ?, 'SPEND_BUDGET', '*', 'ALLOW', 'MISSION', ?)`,
  ).run(randomUUID(), fixture.a, fixture.scopedAllow);
  for (const [missionId, state] of [
    [fixture.paused, 'PAUSED'],
    [fixture.interrupted, 'RUNNING'],
  ]) {
    db.prepare('UPDATE missions SET state = ?, updated_at = ? WHERE id = ?').run(
      state,
      at,
      missionId,
    );
    db.prepare(
      `INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
      VALUES (?, ?, 1, 'RUNNING', ?)`,
    ).run(randomUUID(), missionId, at);
  }
} finally {
  db.close();
}

const second = await launch();
try {
  const recovered = await second.page.evaluate(async ({ waiting, paused, interrupted }) => {
    const api = window.cultivation;
    return {
      waiting: await api.missions.detail(waiting),
      paused: await api.missions.detail(paused),
      interrupted: await api.missions.detail(interrupted),
    };
  }, fixture);
  assert.equal(recovered.waiting.mission.state, 'WAITING_APPROVAL');
  assert.equal(recovered.waiting.runs[0].status, 'RUNNING');
  assert.equal(recovered.waiting.approvals[0].state, 'PENDING');
  assert.equal(recovered.paused.mission.state, 'PAUSED');
  assert.equal(recovered.paused.runs[0].status, 'RUNNING');
  assert.equal(recovered.interrupted.mission.state, 'INTERRUPTED');
  assert.equal(recovered.interrupted.runs[0].status, 'INTERRUPTED');

  const complete = await second.page.evaluate(
    async ({ waiting, scopedAllow, scopedOther, paused, interrupted }) => {
      const api = window.cultivation;
      const pending = (await api.missions.detail(waiting)).approvals.find(
        (item) => item.state === 'PENDING',
      );
      const approved = await api.missions.resolveApproval({
        approvalId: pending.id,
        decision: 'APPROVED',
      });
      const duplicateResolveRejected = await api.missions
        .resolveApproval({ approvalId: pending.id, decision: 'APPROVED' })
        .then(
          () => false,
          () => true,
        );
      const grant = await api.missions.start({ missionId: scopedAllow, approvalFixture: true });
      const otherWaiting = await api.missions.start({
        missionId: scopedOther,
        approvalFixture: true,
      });
      const otherPending = (await api.missions.detail(scopedOther)).approvals.find(
        (item) => item.state === 'PENDING',
      );
      const denied = await api.missions.resolveApproval({
        approvalId: otherPending.id,
        decision: 'DENIED',
      });
      const retried = await api.missions.retry({ missionId: scopedOther, approvalFixture: false });
      const resumed = await api.missions.resume(paused);
      const retriedInterrupted = await api.missions.retry({
        missionId: interrupted,
        approvalFixture: false,
      });
      return {
        approved,
        duplicateResolveRejected,
        grant,
        otherWaiting,
        denied,
        retried,
        resumed,
        retriedInterrupted,
      };
    },
    fixture,
  );
  assert.equal(complete.approved.mission.state, 'COMPLETED');
  assert.equal(complete.approved.runs.length, 1);
  assert.equal(complete.approved.runs[0].id, recovered.waiting.runs[0].id);
  assert.equal(complete.duplicateResolveRejected, true);
  assert.equal(complete.grant.mission.state, 'COMPLETED');
  assert.equal(complete.otherWaiting.mission.state, 'WAITING_APPROVAL');
  assert.equal(complete.denied.mission.state, 'FAILED');
  assert.equal(complete.denied.runs[0].status, 'FAILED');
  assert.ok(
    complete.denied.events.some((event) => JSON.stringify(event.payloadJson).includes('DENIED')),
  );
  assert.equal(complete.retried.mission.state, 'COMPLETED');
  assert.deepEqual(
    complete.retried.runs.map((run) => run.attempt),
    [1, 2],
  );
  assert.equal(complete.retried.runs[0].status, 'FAILED');
  assert.equal(complete.retried.runs[1].status, 'COMPLETED');
  assert.equal(complete.resumed.mission.state, 'COMPLETED');
  assert.equal(complete.resumed.runs[0].id, recovered.paused.runs[0].id);
  assert.equal(complete.retriedInterrupted.mission.state, 'COMPLETED');
  assert.deepEqual(
    complete.retriedInterrupted.runs.map((run) => run.attempt),
    [1, 2],
  );
  assert.equal(complete.retriedInterrupted.runs[0].status, 'INTERRUPTED');
  assert.equal(complete.retriedInterrupted.runs[1].status, 'COMPLETED');
  for (const detail of [
    fixture.resultA,
    fixture.resultB,
    complete.approved,
    complete.grant,
    complete.retried,
  ]) {
    assert.ok(
      detail.usage.every(
        (record) =>
          record.missionId === detail.mission.id &&
          detail.runs.some((run) => run.id === record.runId) &&
          record.teammateId === detail.mission.coordinatorTeammateId &&
          record.runtimeProfileId === fixture.runtime,
      ),
    );
    assert.ok(detail.events.length > 0);
    assert.ok(detail.audits.length > 0);
  }
  await second.page.getByRole('link', { name: '历练 Missions' }).click();
  await second.page.getByRole('heading', { name: '历练 Missions' }).waitFor();
  await second.page.getByRole('button', { name: /SOLO A/ }).click();
  await second.page.getByRole('heading', { name: '执行 Timeline' }).waitFor();
  await second.page.getByText('run.completed', { exact: true }).waitFor();
} finally {
  await second.app.close();
}

const auditDb = new Database(path);
try {
  const audit = auditDb
    .prepare('SELECT id, payload_json FROM audit_events ORDER BY created_at LIMIT 1')
    .get();
  assert.ok(audit);
  assert.ok(!audit.payload_json.includes('GATE3_A_MEMORY_ONLY'));
  assert.throws(() =>
    auditDb.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = ?").run(audit.id),
  );
  assert.throws(() => auditDb.prepare('DELETE FROM audit_events WHERE id = ?').run(audit.id));
} finally {
  auditDb.close();
}
console.log(
  'GATE3_PACKAGED_SMOKE_OK solo=ok scope=memory_skill_permission usage=mission_run approval=once restart=waiting_paused_interrupted retry=new_attempt audit=append_only',
);
