import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const nonce = randomUUID();
const userData = join(process.cwd(), '.test-data', `gate5-packaged-${nonce}`);
mkdirSync(userData, { recursive: true });
assert.ok(existsSync(executablePath), `Package not found: ${executablePath}`);

const app = await electron.launch({
  executablePath,
  args: ['--gate1-fake-model'],
  timeout: 30_000,
  env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
});

function pendingCollaboration(detail) {
  const request = detail.collaborations.find((item) => item.state === 'PENDING');
  assert.ok(request, `Mission ${detail.mission.id} must have a pending collaboration request`);
  return request;
}

function assertCollaborationAudit(detail, state) {
  assert.ok(
    detail.events.some((event) => event.eventType === `collaboration.${state}`),
    `Mission ${detail.mission.id} must persist collaboration.${state}`,
  );
  assert.ok(
    detail.audits.some((audit) => audit.action === `collaboration.${state}`),
    `Mission ${detail.mission.id} must audit collaboration.${state}`,
  );
}

function missionUsage(detail, teammateId) {
  return detail.usage.filter((record) => record.teammateId === teammateId);
}

let fixture;
let deniedDetail;
let approvedDetail;
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();

  fixture = await page.evaluate(async (nonce) => {
    const api = window.cultivation;
    const providerA = await api.providers.create({
      name: `Gate 5 Provider A ${nonce}`,
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const providerB = await api.providers.create({
      name: `Gate 5 Provider B ${nonce}`,
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtimeA = await api.runtimes.create({
      name: `Gate 5 Runtime A ${nonce}`,
      providerId: providerA.id,
      credentialId: null,
      modelId: 'gate5-fake-a',
    });
    const runtimeB = await api.runtimes.create({
      name: `Gate 5 Runtime B ${nonce}`,
      providerId: providerB.id,
      credentialId: null,
      modelId: 'gate5-fake-b',
    });
    const makeTeammate = (name, currentRuntimeProfileId) =>
      api.teammates.create({
        name,
        avatar: null,
        title: null,
        description: `Persistent Gate 5 teammate ${nonce}`,
        identityPrompt: `Gate 5 identity for ${name}`,
        behaviorPrompt: '',
        currentRuntimeProfileId,
      });
    const a = await makeTeammate(`Gate 5 Coordinator ${nonce}`, runtimeA.id);
    const b = await makeTeammate(`Gate 5 Member ${nonce}`, runtimeB.id);

    const objective = `Consult independently and report a bounded public result. __GATE5_SCOPE_INSPECT__ ${nonce}`;
    const memberTask = `MEMBER_TASK: Contribute to this Mission: ${objective}`;
    const aMemory = `${memberTask} GATE5_A_MEMORY_${nonce}`;
    const bMemory = `${memberTask} GATE5_B_MEMORY_${nonce}`;
    await api.memories.create({
      teammateId: a.id,
      memoryType: 'FACT',
      content: aMemory,
      summary: aMemory,
      importance: 0.99,
    });
    await api.memories.create({
      teammateId: b.id,
      memoryType: 'FACT',
      content: bMemory,
      summary: bMemory,
      importance: 0.99,
    });
    const skillA = await api.skills.create({
      name: `Gate 5 Skill A ${nonce}`,
      description: 'Coordinator private skill fixture',
      instructions: `GATE5_A_SKILL_${nonce}`,
      tags: ['gate5-smoke'],
    });
    const skillB = await api.skills.create({
      name: `Gate 5 Skill B ${nonce}`,
      description: 'Member private skill fixture',
      instructions: `GATE5_B_SKILL_${nonce}`,
      tags: ['gate5-smoke'],
    });
    for (const [teammate, skill] of [
      [a, skillA],
      [b, skillB],
    ]) {
      await api.skills.assign({ teammateId: teammate.id, skillId: skill.id });
      await api.skills.setEnabled({ teammateId: teammate.id, skillId: skill.id, enabled: true });
    }

    const partyName = `Gate 5 Party ${nonce}`;
    const party = await api.parties.create({
      name: partyName,
      description: 'Packaged two-teammate consultation fixture',
      type: 'FIXED',
      coordinatorTeammateId: a.id,
      memberTeammateIds: [a.id, b.id],
    });
    const listedParties = await api.parties.list();
    if (!listedParties.some((item) => item.id === party.id)) {
      throw new Error('The persisted Party is missing from Party listing');
    }
    return {
      providerAId: providerA.id,
      providerBId: providerB.id,
      runtimeAId: runtimeA.id,
      runtimeBId: runtimeB.id,
      aId: a.id,
      bId: b.id,
      partyId: party.id,
      partyName,
      nonce,
      privateMarkers: [aMemory, bMemory, `GATE5_A_SKILL_${nonce}`, `GATE5_B_SKILL_${nonce}`],
    };
  }, nonce);

  await page.getByRole('link', { name: '队伍 Parties' }).click();
  await page.getByRole('heading', { name: '队伍 Parties' }).waitFor();
  await page.getByText(fixture.partyName, { exact: true }).waitFor();

  const startConsultation = async (title) => {
    const mission = await page.evaluate(
      async ({ title, partyId, coordinatorTeammateId, nonce }) => {
        const api = window.cultivation;
        const created = await api.missions.create({
          title,
          objective: `Consult independently and report a bounded public result. __GATE5_SCOPE_INSPECT__ ${nonce}`,
          coordinatorTeammateId,
          partyId,
          mode: 'CONSULTATION',
        });
        await api.missions.ready(created.id);
        return created;
      },
      {
        title,
        partyId: fixture.partyId,
        coordinatorTeammateId: fixture.aId,
        nonce: fixture.nonce,
      },
    );
    return page.evaluate(
      (missionId) => window.cultivation.missions.start({ missionId, approvalFixture: false }),
      mission.id,
    );
  };

  const deniedStart = await startConsultation(`Gate 5 collaboration denied ${nonce}`);
  const deniedRequest = pendingCollaboration(deniedStart);
  assert.equal(deniedStart.mission.state, 'WAITING_COLLABORATION');
  assert.equal(deniedRequest.requesterTeammateId, fixture.aId);
  assert.equal(deniedRequest.targetTeammateId, fixture.bId);
  assert.equal(deniedRequest.depth, 1);
  assert.ok(deniedRequest.reason.length > 0);
  assert.ok(deniedRequest.proposedTask.length > 0);
  assert.ok(deniedRequest.expectedBenefit.length > 0);
  const proposedEvent = deniedStart.events.find(
    (event) => event.eventType === 'collaboration.proposed',
  );
  assert.equal(proposedEvent?.payloadJson.permission, 'ASK');
  assert.equal(proposedEvent?.actorId, fixture.aId);
  assert.equal(proposedEvent?.payloadJson.targetTeammateId, fixture.bId);
  deniedDetail = await page.evaluate(
    async ({ requestId }) =>
      window.cultivation.missions.resolveCollaboration({ requestId, decision: 'DENIED' }),
    { requestId: deniedRequest.id },
  );
  if (!deniedDetail?.mission)
    deniedDetail = await page.evaluate(
      (missionId) => window.cultivation.missions.detail(missionId),
      deniedStart.mission.id,
    );
  assert.equal(deniedDetail.mission.state, 'COMPLETED');
  assert.equal(missionUsage(deniedDetail, fixture.bId).length, 0);
  assert.equal(
    deniedDetail.events.filter(
      (event) => event.eventType === 'model.call_started' && event.actorId === fixture.bId,
    ).length,
    0,
    'Denied Teammate B must not begin a model call',
  );
  assert.equal(
    deniedDetail.artifacts.filter((artifact) => artifact.teammateId === fixture.bId).length,
    0,
    'Unexecuted teammate B must own no collaboration artifact',
  );
  assert.equal(
    deniedDetail.events.filter(
      (event) =>
        event.actorId === fixture.bId &&
        ['collaboration.started', 'collaboration.completed', 'collaboration.failed'].includes(
          event.eventType,
        ),
    ).length,
    0,
  );
  assert.ok(
    deniedDetail.artifacts
      .find((artifact) => artifact.kind === 'FINAL')
      ?.content.includes('"state":"DENIED"'),
    'Coordinator synthesis must receive the denied CollaborationRequest outcome',
  );
  assertCollaborationAudit(deniedDetail, 'denied');
  assert.ok(missionUsage(deniedDetail, fixture.aId).length > 0);

  const approvedStart = await startConsultation(`Gate 5 collaboration approved ${nonce}`);
  const approvedRequest = pendingCollaboration(approvedStart);
  assert.equal(approvedRequest.requesterTeammateId, fixture.aId);
  assert.equal(approvedRequest.targetTeammateId, fixture.bId);
  approvedDetail = await page.evaluate(
    async ({ requestId }) =>
      window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
    { requestId: approvedRequest.id },
  );
  if (!approvedDetail?.mission)
    approvedDetail = await page.evaluate(
      (missionId) => window.cultivation.missions.detail(missionId),
      approvedStart.mission.id,
    );

  assert.equal(approvedDetail.mission.state, 'COMPLETED');
  assert.equal(
    approvedDetail.collaborations.find((item) => item.id === approvedRequest.id).state,
    'APPROVED',
  );
  assertCollaborationAudit(approvedDetail, 'proposed');
  assertCollaborationAudit(approvedDetail, 'approved');
  assertCollaborationAudit(approvedDetail, 'started');
  assertCollaborationAudit(approvedDetail, 'completed');
  assert.equal(
    approvedDetail.events.find((event) => event.eventType === 'collaboration.started')?.actorId,
    fixture.bId,
  );
  assert.ok(
    approvedDetail.events.some(
      (event) => event.eventType === 'collaboration.completed' && event.actorId === fixture.bId,
    ),
    'Member completion must be recorded under B even when final synthesis shares the same timestamp',
  );

  const members = approvedDetail.participants;
  assert.deepEqual(
    members.map((participant) => participant.teammateId).sort(),
    [fixture.aId, fixture.bId].sort(),
  );
  assert.equal(
    members.find((participant) => participant.teammateId === fixture.aId).role,
    'COORDINATOR',
  );
  assert.ok(
    members.some(
      (participant) => participant.teammateId === fixture.bId && participant.role === 'MEMBER',
    ),
  );

  const memberUsage = missionUsage(approvedDetail, fixture.bId);
  const coordinatorUsage = missionUsage(approvedDetail, fixture.aId);
  assert.ok(memberUsage.length > 0, 'Approved teammate B must make a model call');
  assert.ok(coordinatorUsage.length >= 2, 'Coordinator must propose and synthesize');
  assert.ok(memberUsage.every((record) => record.runtimeProfileId === fixture.runtimeBId));
  assert.ok(coordinatorUsage.every((record) => record.runtimeProfileId === fixture.runtimeAId));
  assert.ok(memberUsage.every((record) => record.missionId === approvedDetail.mission.id));
  const memberModelEvents = approvedDetail.events.filter(
    (event) => event.eventType === 'model.call_started' && event.actorId === fixture.bId,
  );
  const coordinatorModelEvents = approvedDetail.events.filter(
    (event) => event.eventType === 'model.call_started' && event.actorId === fixture.aId,
  );
  assert.equal(memberModelEvents.length, memberUsage.length);
  assert.ok(
    memberModelEvents.every((event) => event.payloadJson.runtimeProfileId === fixture.runtimeBId),
  );
  assert.ok(
    coordinatorModelEvents.every(
      (event) => event.payloadJson.runtimeProfileId === fixture.runtimeAId,
    ),
  );
  assert.ok(
    memberUsage.every((record) => approvedDetail.runs.some((run) => run.id === record.runId)),
  );
  assert.ok(coordinatorUsage.every((record) => record.missionId === approvedDetail.mission.id));

  const memberResult = approvedDetail.artifacts.find(
    (artifact) => artifact.teammateId === fixture.bId && artifact.kind === 'MEMBER_RESULT',
  );
  const finalArtifact = approvedDetail.artifacts.find(
    (artifact) => artifact.teammateId === fixture.aId && artifact.kind === 'FINAL',
  );
  assert.ok(memberResult, 'Approved member result must be persisted as an artifact');
  assert.ok(finalArtifact, 'Coordinator synthesis must be persisted as a FINAL artifact');
  const memberDiagnostic = JSON.parse(memberResult.content);
  assert.deepEqual(memberDiagnostic, {
    teammateId: fixture.bId,
    runtimeProfileId: fixture.runtimeBId,
    aMemorySeen: false,
    bMemorySeen: true,
    aSkillSeen: false,
    bSkillSeen: true,
  });
  assert.ok(finalArtifact.content.includes(fixture.bId));
  assert.ok(finalArtifact.content.includes('bMemorySeen'));

  const denyEvents = JSON.stringify({
    events: deniedDetail.events,
    audits: deniedDetail.audits,
    artifacts: deniedDetail.artifacts,
  });
  const approvedEvents = JSON.stringify({
    events: approvedDetail.events,
    audits: approvedDetail.audits,
  });
  for (const privateMarker of fixture.privateMarkers) {
    assert.ok(
      !denyEvents.includes(privateMarker),
      'Private prompt context must not enter denial audit',
    );
    assert.ok(
      !approvedEvents.includes(privateMarker),
      'Private prompt context must not enter audit',
    );
  }

  await page.getByRole('link', { name: '历练 Missions' }).click();
  await page.getByRole('heading', { name: '历练 Missions' }).waitFor();
  await page
    .getByRole('button', { name: new RegExp(`Gate 5 collaboration approved ${nonce}`) })
    .click();
  await page.getByRole('heading', { name: '执行 Timeline' }).waitFor();
} finally {
  await app.close();
}

const databasePath = join(userData, 'data', 'cultivation.sqlite');
const db = new Database(databasePath, { readonly: true });
try {
  const parties = db
    .prepare('SELECT id, coordinator_teammate_id, type, status FROM parties WHERE id = ?')
    .get(fixture.partyId);
  assert.equal(parties.coordinator_teammate_id, fixture.aId);
  assert.equal(parties.type, 'FIXED');
  assert.equal(parties.status, 'ACTIVE');

  const participants = db
    .prepare(
      'SELECT teammate_id, role FROM mission_participants WHERE mission_id = ? ORDER BY sort_order',
    )
    .all(approvedDetail.mission.id);
  assert.deepEqual(
    participants.map((item) => [item.teammate_id, item.role]),
    [
      [fixture.aId, 'COORDINATOR'],
      [fixture.bId, 'MEMBER'],
    ],
  );

  const denialCalls = db
    .prepare(
      'SELECT teammate_id, runtime_profile_id FROM usage_records WHERE mission_id = ? AND teammate_id = ?',
    )
    .all(deniedDetail.mission.id, fixture.bId);
  assert.deepEqual(denialCalls, [], 'Deny must leave B with zero persisted model calls');
  const approvedCalls = db
    .prepare(
      `SELECT teammate_id, runtime_profile_id, run_id FROM usage_records
       WHERE mission_id = ? ORDER BY created_at, teammate_id`,
    )
    .all(approvedDetail.mission.id);
  assert.ok(approvedCalls.some((call) => call.teammate_id === fixture.aId));
  assert.ok(
    approvedCalls.some(
      (call) => call.teammate_id === fixture.bId && call.runtime_profile_id === fixture.runtimeBId,
    ),
  );
  assert.ok(
    approvedCalls.every((call) => approvedDetail.runs.some((run) => run.id === call.run_id)),
  );

  const deniedRequestId = deniedDetail.collaborations.find(
    (item) => item.missionId === deniedDetail.mission.id,
  )?.id;
  const approvedRequestId = approvedDetail.collaborations.find(
    (item) => item.missionId === approvedDetail.mission.id,
  )?.id;
  assert.ok(deniedRequestId);
  assert.ok(approvedRequestId);
  const collaborations = db
    .prepare(
      `SELECT requester_teammate_id, target_teammate_id, reason, proposed_task, expected_benefit,
              depth, state
       FROM collaboration_requests WHERE id IN (?, ?) ORDER BY state`,
    )
    .all(deniedRequestId, approvedRequestId);
  assert.equal(collaborations.length, 2);
  assert.ok(collaborations.every((item) => item.requester_teammate_id === fixture.aId));
  assert.ok(collaborations.every((item) => item.target_teammate_id === fixture.bId));
  assert.ok(collaborations.every((item) => item.depth === 1));
  assert.deepEqual(
    new Set(collaborations.map((item) => item.state)),
    new Set(['APPROVED', 'DENIED']),
  );

  const artifacts = db
    .prepare(`SELECT teammate_id, kind, content FROM collaboration_artifacts WHERE mission_id = ?`)
    .all(approvedDetail.mission.id);
  assert.ok(
    artifacts.some((item) => item.teammate_id === fixture.bId && item.kind === 'MEMBER_RESULT'),
  );
  assert.ok(artifacts.some((item) => item.teammate_id === fixture.aId && item.kind === 'FINAL'));
  const deniedTargetArtifactCount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM collaboration_artifacts
       WHERE mission_id = ? AND teammate_id = ?`,
    )
    .get(deniedDetail.mission.id, fixture.bId).count;
  assert.equal(
    deniedTargetArtifactCount,
    0,
    'SQLite must not assign an artifact to a denied, unexecuted teammate',
  );
  for (const privateMarker of fixture.privateMarkers) {
    assert.ok(!JSON.stringify(artifacts).includes(privateMarker));
  }

  const auditActions = db
    .prepare('SELECT action, actor_id, target_id, payload_json FROM audit_events')
    .all();
  const collaborationAudits = auditActions.filter((item) =>
    item.action.startsWith('collaboration.'),
  );
  assert.ok(collaborationAudits.some((item) => item.action === 'collaboration.proposed'));
  assert.ok(collaborationAudits.some((item) => item.action === 'collaboration.denied'));
  assert.ok(collaborationAudits.some((item) => item.action === 'collaboration.approved'));
  assert.ok(collaborationAudits.some((item) => item.action === 'collaboration.started'));
  assert.ok(collaborationAudits.some((item) => item.action === 'collaboration.completed'));
  assert.ok(collaborationAudits.some((item) => item.actor_id === fixture.aId));
  assert.ok(collaborationAudits.some((item) => item.actor_id === fixture.bId));
  const attributedModelAudits = auditActions.filter(
    (item) => item.target_id === approvedDetail.mission.id && item.action === 'model.call_started',
  );
  assert.ok(
    attributedModelAudits.some(
      (item) =>
        item.actor_id === fixture.aId &&
        JSON.parse(item.payload_json).runtimeProfileId === fixture.runtimeAId,
    ),
  );
  assert.ok(
    attributedModelAudits.some(
      (item) =>
        item.actor_id === fixture.bId &&
        JSON.parse(item.payload_json).runtimeProfileId === fixture.runtimeBId,
    ),
  );
} finally {
  db.close();
}

console.log(
  'GATE5_PACKAGED_SMOKE_OK party=2 persistent_teammates consultation=initiative_invite deny=target_model_calls_zero_and_sqlite_artifacts_zero approve=member_uses_own_runtime_memory_skill coordinator_synthesis=final_artifact usage_audit=actor_attributed',
);

export const gate5Evidence = {
  userData,
  fixture,
  deniedMissionId: deniedDetail.mission.id,
  approvedMissionId: approvedDetail.mission.id,
};
