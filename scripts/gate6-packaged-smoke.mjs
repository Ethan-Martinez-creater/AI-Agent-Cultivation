import { navigateUi } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

const eventIds = (events) => events.map((item) => item.id).sort();

const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);

export async function verifyGate6Packaged(evidence) {
  const { userData, fixture, deniedMissionId, approvedMissionId } = evidence;
  const launch = () =>
    electron.launch({
      executablePath,
      args: ['--gate1-fake-model'],
      timeout: 30_000,
      env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
    });
  const app = await launch();
  let beforeRestart;
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
    beforeRestart = await page.evaluate(
      async ({ fixture, deniedMissionId, approvedMissionId }) => {
        const api = window.cultivation;
        const deniedTarget = await api.experience.get(fixture.bId);
        const approvedTarget = await api.experience.get(fixture.bId);
        const coordinator = await api.experience.get(fixture.aId);
        const teammateAtStart = (await api.teammates.list()).find(
          (item) => item.id === fixture.bId,
        );
        const memories = await api.memories.list(fixture.bId, 'ACTIVE');
        const skills = await api.skills.listAssignments(fixture.bId);

        const runPartyMode = async (mode, marker = '') => {
          const mission = await api.missions.create({
            title: `Alpha ${mode} ${fixture.nonce}`,
            objective: `Produce a bounded ${mode} result for alpha acceptance. ${marker}`,
            coordinatorTeammateId: fixture.aId,
            partyId: fixture.partyId,
            mode,
          });
          await api.missions.ready(mission.id);
          const waiting = await api.missions.start({
            missionId: mission.id,
            approvalFixture: false,
          });
          const request = waiting.collaborations.find((item) => item.state === 'PENDING');
          if (!request) throw new Error(`${mode} did not request collaboration`);
          const done = await api.missions.resolveCollaboration({
            requestId: request.id,
            decision: 'APPROVED',
          });
          return {
            missionId: mission.id,
            runId: done.runs.at(-1)?.id,
            state: done.mission.state,
            artifacts: done.artifacts.map((item) => ({
              kind: item.kind,
              teammateId: item.teammateId,
            })),
            targetUsage: done.usage.filter((item) => item.teammateId === fixture.bId).length,
            targetModelCalls: done.events.filter(
              (item) => item.eventType === 'model.call_started' && item.actorId === fixture.bId,
            ).length,
          };
        };
        const review = await runPartyMode('REVIEW');
        const delegation = await runPartyMode('DELEGATION');
        const completedBeforeOpposites = (await api.experience.get(fixture.bId)).profile
          .completedCollaborations;
        const memberFailed = await runPartyMode('CONSULTATION', '__GATE6_MEMBER_FAIL__');
        const memberFailedExperience = await api.experience.get(fixture.bId);
        const synthesisFailed = await runPartyMode('REVIEW', '__GATE6_SYNTHESIS_FAIL__');
        const finalTarget = await api.experience.get(fixture.bId);
        const teammateAfterMissions = (await api.teammates.list()).find(
          (item) => item.id === fixture.bId,
        );
        return {
          deniedTarget,
          approvedTarget,
          coordinator,
          bindingAtStart: teammateAtStart?.currentRuntimeProfileId,
          bindingAfterMissions: teammateAfterMissions?.currentRuntimeProfileId,
          memories,
          skills,
          review,
          delegation,
          completedBeforeOpposites,
          memberFailed,
          memberFailedExperience,
          synthesisFailed,
          finalTarget,
          deniedMissionId,
          approvedMissionId,
        };
      },
      { fixture, deniedMissionId, approvedMissionId },
    );

    assert.ok(beforeRestart.bindingAtStart);
    assert.equal(beforeRestart.bindingAfterMissions, beforeRestart.bindingAtStart);
    assert.ok(beforeRestart.memories.some((item) => item.content.includes('GATE5_B_MEMORY')));
    assert.ok(beforeRestart.skills.some((item) => item.enabled));
    assert.deepEqual(
      eventIds(beforeRestart.deniedTarget.events),
      eventIds(beforeRestart.approvedTarget.events),
      'Repeated reconciliation must not duplicate Experience',
    );
    assert.ok(
      beforeRestart.deniedTarget.events.every((item) => item.missionId !== deniedMissionId),
      'The denied, unexecuted target must receive no Experience from that Mission',
    );
    assert.ok(
      beforeRestart.approvedTarget.events.some(
        (item) => item.missionId === approvedMissionId && item.experienceType === 'MISSION_RESULT',
      ),
    );
    assert.ok(
      beforeRestart.coordinator.events.some(
        (item) => item.missionId === deniedMissionId && item.experienceType === 'MISSION_RESULT',
      ),
    );
    assert.equal(beforeRestart.review.state, 'COMPLETED');
    assert.deepEqual(
      beforeRestart.review.artifacts.sort((left, right) => left.kind.localeCompare(right.kind)),
      [
        { kind: 'DRAFT', teammateId: fixture.aId },
        { kind: 'FINAL', teammateId: fixture.aId },
        { kind: 'REVIEW', teammateId: fixture.bId },
      ],
    );
    assert.ok(beforeRestart.review.targetUsage > 0);
    assert.equal(beforeRestart.delegation.state, 'COMPLETED');
    assert.deepEqual(
      beforeRestart.delegation.artifacts.sort((left, right) => left.kind.localeCompare(right.kind)),
      [
        { kind: 'FINAL', teammateId: fixture.aId },
        { kind: 'MEMBER_RESULT', teammateId: fixture.bId },
      ],
    );
    assert.ok(beforeRestart.delegation.targetUsage > 0);
    assert.equal(beforeRestart.memberFailed.state, 'COMPLETED');
    assert.ok(beforeRestart.memberFailed.targetModelCalls > 0);
    assert.equal(
      beforeRestart.memberFailedExperience.events.find(
        (item) =>
          item.missionId === beforeRestart.memberFailed.missionId &&
          item.runId === beforeRestart.memberFailed.runId &&
          item.experienceType === 'COLLABORATION',
      )?.outcome,
      'FAILED',
      'Member failure must remain FAILED after successful coordinator synthesis',
    );
    assert.equal(
      beforeRestart.memberFailedExperience.profile.completedCollaborations,
      beforeRestart.completedBeforeOpposites,
    );
    assert.equal(beforeRestart.synthesisFailed.state, 'FAILED');
    assert.ok(beforeRestart.synthesisFailed.targetModelCalls > 0);
    assert.equal(
      beforeRestart.finalTarget.events.find(
        (item) =>
          item.missionId === beforeRestart.synthesisFailed.missionId &&
          item.runId === beforeRestart.synthesisFailed.runId &&
          item.experienceType === 'COLLABORATION',
      )?.outcome,
      'COMPLETED',
      'Completed member work must remain COMPLETED after coordinator synthesis fails',
    );
    assert.equal(
      beforeRestart.finalTarget.profile.completedCollaborations,
      beforeRestart.completedBeforeOpposites + 1,
    );
    assert.ok(beforeRestart.finalTarget.profile.consultationParticipations >= 1);
    assert.ok(beforeRestart.finalTarget.profile.reviewParticipations >= 1);
    assert.ok(beforeRestart.finalTarget.profile.delegationParticipations >= 1);
    assert.ok(beforeRestart.finalTarget.profile.completedCollaborations >= 3);
    assert.ok(beforeRestart.finalTarget.profile.skillUses >= 1);
    assert.ok(
      beforeRestart.finalTarget.events.every(
        (item) =>
          item.teammateId === fixture.bId &&
          item.missionId &&
          item.runId &&
          item.source &&
          item.sourceId &&
          item.createdAt,
      ),
      'Every Experience row needs durable actor, Run, source, and timestamp provenance',
    );
    await navigateUi(page, '道友 Teammates');
    await page
      .locator('button.teammate-roster-select')
      .filter({ hasText: `Gate 5 Member ${fixture.nonce}` })
      .click();
    await page.locator('.teammate-secondary-view > summary').filter({ hasText: '经历' }).click();
    await page.getByRole('heading', { name: '经历 / 能力' }).waitFor();
    await page.getByText('炼气 · 正式能力考核尚未开启').waitFor();
    await page.locator('.experience-event').first().waitFor();
  } finally {
    await app.close();
  }

  const databasePath = join(userData, 'data', 'cultivation.sqlite');
  const db = new Database(databasePath, { readonly: true });
  let beforeCount;
  try {
    beforeCount = db.prepare('SELECT COUNT(*) AS count FROM experience_events').get().count;
    const deniedRows = db
      .prepare(
        'SELECT COUNT(*) AS count FROM experience_events WHERE mission_id = ? AND teammate_id = ?',
      )
      .get(deniedMissionId, fixture.bId).count;
    assert.equal(deniedRows, 0);
    for (const [scenario, expectedOutcome] of [
      [beforeRestart.memberFailed, 'FAILED'],
      [beforeRestart.synthesisFailed, 'COMPLETED'],
    ]) {
      const row = db
        .prepare(
          "SELECT outcome FROM experience_events WHERE mission_id = ? AND run_id = ? AND teammate_id = ? AND experience_type = 'COLLABORATION'",
        )
        .get(scenario.missionId, scenario.runId, fixture.bId);
      assert.equal(row?.outcome, expectedOutcome);
    }
    assert.ok(beforeCount > 0);
  } finally {
    db.close();
  }

  const reopened = await launch();
  try {
    const page = await reopened.firstWindow();
    await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
    const afterRestart = await page.evaluate(
      (teammateId) => window.cultivation.experience.get(teammateId),
      fixture.bId,
    );
    assert.deepEqual(
      eventIds(afterRestart.events),
      eventIds(beforeRestart.finalTarget.events),
      'Restart must retain Experience without regenerating duplicate source events',
    );
  } finally {
    await reopened.close();
  }
  const reopenedDb = new Database(databasePath, { readonly: true });
  try {
    const afterCount = reopenedDb
      .prepare('SELECT COUNT(*) AS count FROM experience_events')
      .get().count;
    assert.equal(afterCount, beforeCount);
  } finally {
    reopenedDb.close();
  }
  console.log(
    'GATE6_PACKAGED_SMOKE_OK experience=actor_run_source_provenance denied_target=zero participant_failed_run_completed=ok participant_completed_run_failed=ok review=ok delegation=ok sealed_binding=stable restart=ledger_idempotent',
  );
}
