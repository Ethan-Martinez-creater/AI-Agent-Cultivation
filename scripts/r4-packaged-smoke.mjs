import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';
import { verifyR4RoutingUi } from './r4-ui-packaged-smoke.mjs';

const nonce = randomUUID();
const root = process.cwd();
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const userData = join(root, '.test-data', `r4-packaged-${nonce}`);
const workspaceRoot = join(root, '.test-data', `r4-workspace-${nonce}`);
const databasePath = join(userData, 'data', 'cultivation.sqlite');
mkdirSync(userData, { recursive: true });
mkdirSync(join(workspaceRoot, 'deliverables'), { recursive: true });
writeFileSync(
  join(workspaceRoot, 'deliverables', 'result.txt'),
  'R4 Human Bridge artifact fixture\n',
  'utf8',
);

async function launch() {
  const app = await electron.launch({
    executablePath,
    args: ['--gate1-fake-model', '--r3-fake-decision', '--r4-fake-routing'],
    timeout: 30_000,
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}

async function selectWorkspace(app, page) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspaceRoot);
  const selected = await page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  assert.equal(selected.rootPath, workspaceRoot);
}

async function main() {
  assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);
  const first = await launch();
  let facts;
  try {
    const { app, page } = first;
    const initial = await page.evaluate(async () => ({
      routing: await window.cultivation.routing.config(),
      shadow: await window.cultivation.r3.getConfig(),
    }));
    assert.equal(initial.routing.cloudEnabled, false);
    assert.deepEqual(
      {
        mode: initial.shadow.mode,
        enabled: initial.shadow.enabled,
        configured: initial.shadow.configured,
      },
      { mode: 'SHADOW', enabled: false, configured: false },
    );

    const key = `r4-routing-smoke-${nonce}`;
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), key);
    const configured = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
    assert.equal(configured.keySource, 'SAFE_STORAGE');
    assert.equal(JSON.stringify(configured).includes(key), false);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
    assert.equal((await page.evaluate(() => window.cultivation.r3.testConnection())).ok, true);
    const enabled = await page.evaluate(() => window.cultivation.routing.setCloudEnabled(true));
    assert.equal(enabled.cloudEnabled, true);
    const shadowAfterOptIn = await page.evaluate(() => window.cultivation.r3.getConfig());
    assert.equal(shadowAfterOptIn.mode, 'SHADOW');
    assert.equal(shadowAfterOptIn.enabled, false, 'R4 opt-in must not enable legacy Shadow');

    const seeded = await page.evaluate(async (nonce) => {
      const api = window.cultivation;
      const make = async (label, score) => {
        const provider = await api.providers.create({
          name: `R4 ${label} Provider ${nonce}`,
          kind: 'OPENAI_COMPATIBLE',
          baseUrl: 'http://127.0.0.1:9999/v1',
        });
        const sourceRuntime = await api.runtimes.create({
          name: `R4 ${label} Runtime ${nonce}`,
          providerId: provider.id,
          credentialId: null,
          modelId: `r4-${label.toLowerCase()}-${nonce.slice(0, 8)}`,
        });
        const teammate = await api.teammates.create({
          name: `R4 ${label} ${nonce}`,
          avatar: null,
          title: null,
          description: `R4 routing fixture ${nonce}`,
          identityPrompt: 'Use the provided task and return a concise result.',
          behaviorPrompt: '',
          currentRuntimeProfileId: sourceRuntime.id,
        });
        const runtime = (await api.runtimes.list()).find(
          (item) => item.id === teammate.currentRuntimeProfileId,
        );
        if (!runtime) throw new Error(`${label} sealed Runtime is missing`);
        const saveBenchmark = (dimension, supported, normalizedScore) =>
          api.capability.saveBenchmark({
            runtimeProfileId: runtime.id,
            modelAlias: runtime.modelId,
            dimension,
            supported,
            normalizedScore,
            rawScore: null,
            source: 'R4 packaged smoke',
            benchmark: 'Deterministic routing fixture',
            benchmarkVersion: '1',
            snapshotDate: '2026-01-01T00:00:00.000Z',
            sourceUrl: null,
            provenanceType: 'USER_ESTIMATE',
          });
        await saveBenchmark('GENERAL_REASONING', true, score);
        await saveBenchmark('VIDEO_GENERATION', false, null);
        return { ...teammate, runtimeProfileId: runtime.id, providerId: provider.id };
      };
      const a = await make('A90', 90);
      const b = await make('B60', 60);
      const bridge = await api.r2.bridgeProfile();
      await api.r2.setCapability({ dimension: 'GENERAL_REASONING', enabled: true });
      await api.r2.setCapability({ dimension: 'VIDEO_GENERATION', enabled: true });
      await api.r2.setCapability({ dimension: 'MUSIC_GENERATION', enabled: false });
      const updatedBridge = await api.r2.bridgeProfile();
      if (
        !updatedBridge.dimensions.find((item) => item.dimension === 'VIDEO_GENERATION')?.enabled
      ) {
        throw new Error('Human Bridge VIDEO_GENERATION capability did not enable');
      }
      if (updatedBridge.dimensions.find((item) => item.dimension === 'MUSIC_GENERATION')?.enabled) {
        throw new Error('Human Bridge MUSIC_GENERATION capability must remain disabled');
      }
      return { a, b, bridgeId: bridge.teammate.id };
    }, nonce);
    assert.ok(seeded.a.id);
    assert.ok(seeded.b.id);
    assert.notEqual(seeded.a.id, seeded.b.id);
    assert.notEqual(seeded.a.runtimeProfileId, seeded.b.runtimeProfileId);

    const missingWorkspace = await page.evaluate(() =>
      window.cultivation.routing.createMission({
        title: 'R4 explicit Human Bridge without Workspace',
        context: {
          objective: 'Wait for an explicitly chosen Workspace before external work.',
          executionConstraint: 'HUMAN_BRIDGE',
          requiredCapabilities: ['GENERAL_REASONING'],
        },
      }),
    );
    assert.equal(missingWorkspace.status, 'USER_ACTION_REQUIRED');
    assert.equal(missingWorkspace.reason, 'WORKSPACE_REQUIRED');
    assert.equal(missingWorkspace.receipt.assignment.kind, 'HUMAN_BRIDGE');
    assert.equal(missingWorkspace.receipt.candidates.length, 0);
    assert.equal(
      (await page.evaluate(() => window.cultivation.missions.list())).some(
        (mission) => mission.title === 'R4 explicit Human Bridge without Workspace',
      ),
      false,
    );
    await selectWorkspace(app, page);

    // R4 UI actions run with both sealed model identities available and the
    // independent routing opt-in active. Shadow remains disabled throughout.
    const availability = await page.evaluate(
      async (ids) => {
        const api = window.cultivation;
        const a = await api.availability.prepare(ids.a);
        const b = await api.availability.prepare(ids.b);
        return [a, b];
      },
      { a: seeded.a.id, b: seeded.b.id },
    );
    assert.ok(availability.every((item) => item.ok));

    const conflicts = await page.evaluate(
      async ({ modelId, bridgeId }) => {
        const api = window.cultivation;
        const before = {
          availability: await api.availability.list(),
          receipts: await api.routing.receipts(),
        };
        const errors = [];
        for (const [kind, id, constraints] of [
          ['teammate', modelId, ['AUTO', 'PARTY', 'HUMAN_BRIDGE']],
          ['teammate', bridgeId, ['AUTO', 'SOLO', 'PARTY']],
          ['party', 'conflicting-party', ['AUTO', 'SOLO', 'HUMAN_BRIDGE']],
        ]) {
          for (const executionConstraint of constraints) {
            try {
              await api.routing.createMission({
                title: 'Must reject conflicting constraint',
                context: {
                  objective: 'Reject before Jev, probe, receipt or Mission creation.',
                  executionConstraint,
                  ...(kind === 'party' ? { explicitPartyId: id } : { explicitTeammateId: id }),
                },
              });
              errors.push(null);
            } catch (error) {
              errors.push(String(error));
            }
          }
        }
        return {
          before,
          errors,
          after: {
            availability: await api.availability.list(),
            receipts: await api.routing.receipts(),
          },
        };
      },
      { modelId: seeded.a.id, bridgeId: seeded.bridgeId },
    );
    assert.equal(conflicts.errors.length, 9);
    assert.ok(conflicts.errors.every((error) => error?.includes('执行约束与显式指定对象冲突')));
    assert.deepEqual(
      conflicts.after,
      conflicts.before,
      'Conflicting constraints must not probe or append receipts',
    );

    for (const executionConstraint of ['SOLO', 'PARTY']) {
      const blocked = await page.evaluate(
        (executionConstraint) =>
          window.cultivation.routing.createMission({
            title: `R4 hard constraint ${executionConstraint}`,
            context: {
              objective:
                'No model supports VIDEO; an enabled Human Bridge must not weaken the hard constraint.',
              requiredCapabilities: ['VIDEO_GENERATION'],
              executionConstraint,
            },
          }),
        executionConstraint,
      );
      assert.equal(blocked.status, 'USER_ACTION_REQUIRED');
      assert.equal(
        blocked.reason,
        executionConstraint === 'SOLO'
          ? 'SOLO_REQUIRES_MODEL_EXECUTOR'
          : 'PARTY_REQUIRES_TWO_EXECUTORS',
      );
      assert.equal(blocked.receipt.assignment, null);
      assert.ok(blocked.receipt.candidates.every((candidate) => !candidate.probed));
    }
    const uiEvidence = await verifyR4RoutingUi(page, { a: seeded.a, b: seeded.b });
    const uiHumanMission = uiEvidence.humanBridgeCreation.mission;
    assert.equal(uiHumanMission.coordinatorTeammateId, seeded.bridgeId);
    await page.evaluate((id) => window.cultivation.missions.ready(id), uiHumanMission.id);
    const uiHumanWaiting = await page.evaluate(
      (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
      uiHumanMission.id,
    );
    assert.equal(uiHumanWaiting.mission.state, 'WAITING_EXTERNAL_WORK');
    assert.equal(uiHumanWaiting.usage.length, 0);
    const uiHumanRequest = await page.evaluate(
      async (missionId) =>
        (await window.cultivation.r2.listRequests()).find(
          (request) => request.missionId === missionId,
        ),
      uiHumanMission.id,
    );
    assert.equal(uiHumanRequest?.capability, 'GENERAL_REASONING');
    assert.equal(uiHumanRequest?.runId, uiHumanWaiting.runs[0].id);

    const autoSolo = await page.evaluate(async (nonce) => {
      return window.cultivation.routing.createMission({
        title: `R4 automatic solo ${nonce}`,
        context: {
          objective: 'R4 automatic bounded model task.',
          requiredCapabilities: ['GENERAL_REASONING'],
          executionConstraint: 'AUTO',
        },
      });
    }, nonce);
    assert.equal(autoSolo.status, 'CREATED');
    assert.equal(autoSolo.receipt.assignment.kind, 'SOLO');
    assert.equal(autoSolo.receipt.assignment.coordinatorTeammateId, seeded.a.id);
    assert.equal(autoSolo.mission.coordinatorTeammateId, seeded.a.id);
    assert.equal(autoSolo.mission.mode, 'SOLO');
    const soloCandidateScores = new Map(
      autoSolo.receipt.candidates.map((candidate) => [
        candidate.teammateId,
        candidate.benchmarkScore,
      ]),
    );
    assert.equal(soloCandidateScores.get(seeded.a.id), 90);
    assert.equal(soloCandidateScores.get(seeded.b.id), 60);
    await page.evaluate((id) => window.cultivation.missions.ready(id), autoSolo.mission.id);
    const soloDone = await page.evaluate(
      (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
      autoSolo.mission.id,
    );
    assert.equal(soloDone.mission.state, 'COMPLETED');
    assert.equal(soloDone.runs.length, 1);
    assert.ok(soloDone.usage.some((item) => item.teammateId === seeded.a.id));
    assert.ok(
      soloDone.usage
        .filter((item) => item.teammateId === seeded.a.id)
        .every((item) => item.runtimeProfileId === seeded.a.runtimeProfileId),
    );

    const autoParty = await page.evaluate(
      async ({ title, nonce }) => {
        return window.cultivation.routing.createMission({
          title,
          context: {
            objective: `R4 collaborate on this task [R4_PARTY] ${nonce}`,
            requiredCapabilities: ['GENERAL_REASONING'],
            executionConstraint: 'AUTO',
          },
        });
      },
      { title: `R4 automatic party ${nonce}`, nonce },
    );
    assert.equal(autoParty.status, 'CREATED');
    assert.equal(autoParty.receipt.assignment.kind, 'PARTY');
    assert.equal(autoParty.mission.mode, 'CONSULTATION');
    assert.ok(autoParty.mission.partyId, 'Routed PARTY Mission must link its generated Party');
    const partyBeforeStart = await page.evaluate(() => window.cultivation.parties.list());
    const generatedParty = partyBeforeStart.find((party) => party.id === autoParty.mission.partyId);
    assert.ok(generatedParty, 'AUTO party assignment must persist its generated Party');
    assert.equal(generatedParty.type, 'AD_HOC');
    assert.deepEqual(
      generatedParty.members.map((member) => member.teammateId).sort(),
      [seeded.a.id, seeded.b.id].sort(),
    );
    await page.evaluate((id) => window.cultivation.missions.ready(id), autoParty.mission.id);
    const partyWaiting = await page.evaluate(
      (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
      autoParty.mission.id,
    );
    assert.equal(partyWaiting.mission.state, 'WAITING_COLLABORATION');
    const collaboration = partyWaiting.collaborations.find((item) => item.state === 'PENDING');
    assert.ok(collaboration, 'Party Mission must use the existing collaboration approval flow');
    const partyResolved = await page.evaluate(
      (requestId) =>
        window.cultivation.missions.resolveCollaboration({ requestId, decision: 'DENIED' }),
      collaboration.id,
    );
    assert.equal(partyResolved.mission.state, 'COMPLETED');
    assert.ok(partyResolved.events.some((event) => event.eventType === 'collaboration.denied'));
    assert.equal(
      partyResolved.usage.filter((item) => item.teammateId === seeded.b.id).length,
      0,
      'A denied party collaborator must have no model usage',
    );
    assert.equal(
      partyResolved.events.some(
        (event) => event.actorId === seeded.b.id && event.eventType === 'model.call_started',
      ),
      false,
    );

    const approvedParty = await page.evaluate(
      async ({ title, nonce }) =>
        window.cultivation.routing.createMission({
          title,
          context: {
            objective: `R4 approve the independent collaborator [R4_PARTY] ${nonce}`,
            requiredCapabilities: ['GENERAL_REASONING'],
            executionConstraint: 'AUTO',
          },
        }),
      { title: `R4 automatic party approved ${nonce}`, nonce },
    );
    assert.equal(approvedParty.status, 'CREATED');
    assert.equal(approvedParty.receipt.assignment.kind, 'PARTY');
    assert.ok(approvedParty.mission.partyId);
    const approvedPartyRecord = (await page.evaluate(() => window.cultivation.parties.list())).find(
      (party) => party.id === approvedParty.mission.partyId,
    );
    assert.equal(approvedPartyRecord?.type, 'AD_HOC');
    await page.evaluate((id) => window.cultivation.missions.ready(id), approvedParty.mission.id);
    const approvedPartyWaiting = await page.evaluate(
      (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
      approvedParty.mission.id,
    );
    assert.equal(approvedPartyWaiting.mission.state, 'WAITING_COLLABORATION');
    const approvedCollaboration = approvedPartyWaiting.collaborations.find(
      (item) => item.state === 'PENDING',
    );
    assert.ok(approvedCollaboration);
    const approvedPartyDone = await page.evaluate(
      (requestId) =>
        window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
      approvedCollaboration.id,
    );
    assert.equal(approvedPartyDone.mission.state, 'COMPLETED');
    assert.ok(
      approvedPartyDone.events.some((event) => event.eventType === 'collaboration.approved'),
    );
    assert.ok(
      approvedPartyDone.audits.some((audit) => audit.action === 'collaboration.approved'),
      'The collaborator approval must be durably audited',
    );
    const bUsage = approvedPartyDone.usage.filter((item) => item.teammateId === seeded.b.id);
    assert.ok(bUsage.length > 0, 'The approved collaborator must execute its assigned work');
    assert.ok(bUsage.every((item) => item.runtimeProfileId === seeded.b.runtimeProfileId));

    const humanBridge = await page.evaluate(async (nonce) => {
      return window.cultivation.routing.createMission({
        title: `R4 Human Bridge fallback ${nonce}`,
        context: {
          objective: `Prepare a bounded video-generation deliverable ${nonce}`,
          requiredCapabilities: ['VIDEO_GENERATION'],
          executionConstraint: 'AUTO',
          expectedOutputContract: {
            name: 'result.txt',
            allowedExtensions: ['.txt'],
            maxSizeBytes: 1_048_576,
          },
        },
      });
    }, nonce);
    assert.equal(humanBridge.status, 'CREATED');
    assert.equal(humanBridge.receipt.assignment.kind, 'HUMAN_BRIDGE');
    assert.equal(humanBridge.receipt.assignment.coordinatorTeammateId, seeded.bridgeId);
    assert.equal(humanBridge.mission.mode, 'SOLO');
    assert.equal(humanBridge.mission.coordinatorTeammateId, seeded.bridgeId);
    await page.evaluate((id) => window.cultivation.missions.ready(id), humanBridge.mission.id);
    const waiting = await page.evaluate(
      (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
      humanBridge.mission.id,
    );
    assert.equal(waiting.mission.state, 'WAITING_EXTERNAL_WORK');
    assert.equal(waiting.runs.length, 1);
    assert.equal(waiting.runs[0].status, 'RUNNING');
    assert.equal(waiting.usage.length, 0, 'Human Bridge coordinator must not call a model');
    const request = await page.evaluate(async (missionId) => {
      return (await window.cultivation.r2.listRequests()).find(
        (item) => item.missionId === missionId,
      );
    }, humanBridge.mission.id);
    assert.ok(request, 'Routed Human Bridge Mission must create ExternalWork');
    assert.equal(request.runId, waiting.runs[0].id);
    assert.equal(request.capability, 'VIDEO_GENERATION');

    const unmet = await page.evaluate(async (nonce) => {
      return window.cultivation.routing.createMission({
        title: `R4 no capable executor ${nonce}`,
        context: {
          objective: 'Require an unsupported music-generation capability.',
          requiredCapabilities: ['MUSIC_GENERATION'],
          executionConstraint: 'AUTO',
        },
      });
    }, nonce);
    assert.equal(unmet.status, 'USER_ACTION_REQUIRED');
    assert.equal(unmet.reason, 'NO_CAPABLE_EXECUTOR');
    assert.equal(unmet.receipt.assignment, null);
    const noCapMission = (await page.evaluate(() => window.cultivation.missions.list())).find(
      (mission) => mission.title === `R4 no capable executor ${nonce}`,
    );
    assert.equal(
      noCapMission,
      undefined,
      'Unmet requirements must not create a substituted Mission',
    );
    const unmatchedReceipts = await page.evaluate(() => window.cultivation.routing.receipts());
    assert.ok(unmatchedReceipts.some((item) => item.id === unmet.receipt.id));

    for (const created of [autoSolo, autoParty, approvedParty, humanBridge]) {
      const receipts = await page.evaluate(
        (id) => window.cultivation.routing.receipts(id),
        created.mission.id,
      );
      assert.ok(receipts.some((item) => item.id === created.receipt.id));
    }
    const shadowEnd = await page.evaluate(() => window.cultivation.r3.getConfig());
    assert.equal(shadowEnd.mode, 'SHADOW');
    assert.equal(shadowEnd.enabled, false);
    facts = {
      uiEvidence,
      uiHumanMissionId: uiHumanMission.id,
      uiHumanRunId: uiHumanWaiting.runs[0].id,
      uiHumanRequestId: uiHumanRequest.id,
      a: seeded.a,
      b: seeded.b,
      bridgeId: seeded.bridgeId,
      soloMissionId: autoSolo.mission.id,
      soloReceiptId: autoSolo.receipt.id,
      partyMissionId: autoParty.mission.id,
      partyId: autoParty.mission.partyId,
      partyReceiptId: autoParty.receipt.id,
      approvedPartyMissionId: approvedParty.mission.id,
      approvedPartyReceiptId: approvedParty.receipt.id,
      approvedCollaboratorId: seeded.b.id,
      approvedCollaboratorRuntimeId: seeded.b.runtimeProfileId,
      humanMissionId: humanBridge.mission.id,
      runId: waiting.runs[0].id,
      requestId: request.id,
      receiptId: humanBridge.receipt.id,
      unmetReceiptId: unmet.receipt.id,
      unmetTitle: `R4 no capable executor ${nonce}`,
      decisionReceiptIds: [
        autoSolo.receipt.id,
        autoParty.receipt.id,
        approvedParty.receipt.id,
        humanBridge.receipt.id,
        unmet.receipt.id,
      ],
      publicResult: `Accepted R4 bounded result ${nonce}`,
      shadowMode: shadowEnd.mode,
    };
  } finally {
    await first.app.close();
  }

  // Inject one persisted hard failure after the first desktop process closes.
  // This mirrors an observed unavailable identity and leaves the alternate
  // model available so an explicit choice can prove it is never rerouted.
  const db = new Database(databasePath);
  try {
    const at = new Date().toISOString();
    const outcome = JSON.stringify([{ kind: 'HARD_FAILURE', code: 'AUTH_FAILED', checkedAt: at }]);
    const changed = db
      .prepare(
        `UPDATE teammate_model_availability
         SET status='UNAVAILABLE', last_checked_at=?, last_failure_at=?,
             recent_outcomes_json=?, updated_at=?
         WHERE teammate_id=? AND runtime_profile_id=?`,
      )
      .run(at, at, outcome, at, facts.a.id, facts.a.runtimeProfileId);
    assert.equal(
      changed.changes,
      1,
      'Available sealed identity must have a durable availability row',
    );
    assert.equal(
      db
        .prepare('SELECT status FROM teammate_model_availability WHERE teammate_id=?')
        .get(facts.a.id).status,
      'UNAVAILABLE',
    );
    assert.equal(
      db
        .prepare('SELECT status FROM teammate_model_availability WHERE teammate_id=?')
        .get(facts.b.id).status,
      'AVAILABLE',
      'Alternate model remains available for the no-reroute check',
    );
    const schemaVersion = db
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get().version;
    assert.equal(schemaVersion, 27);
    for (const receiptId of facts.decisionReceiptIds) {
      assert.equal(
        db.prepare('SELECT mode FROM routing_decision_receipts WHERE id=?').get(receiptId).mode,
        'ACTIVE',
      );
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE target_type='ROUTING_RECEIPT' AND target_id=? AND action='routing.decided'",
          )
          .get(receiptId).count,
        1,
        'Every active routing receipt must have a durable decision audit',
      );
    }
    for (const { missionId, receiptId, kind } of [
      { missionId: facts.soloMissionId, receiptId: facts.soloReceiptId, kind: 'SOLO' },
      { missionId: facts.partyMissionId, receiptId: facts.partyReceiptId, kind: 'PARTY' },
      {
        missionId: facts.approvedPartyMissionId,
        receiptId: facts.approvedPartyReceiptId,
        kind: 'PARTY',
      },
      { missionId: facts.humanMissionId, receiptId: facts.receiptId, kind: 'HUMAN_BRIDGE' },
    ]) {
      const assignment = db
        .prepare(
          'SELECT receipt_id, assignment_json, human_bridge_draft_json FROM routing_mission_assignments WHERE mission_id=?',
        )
        .get(missionId);
      assert.ok(assignment);
      assert.equal(JSON.parse(assignment.assignment_json).kind, kind);
      assert.equal(assignment.receipt_id, receiptId);
      if (kind === 'HUMAN_BRIDGE') assert.ok(JSON.parse(assignment.human_bridge_draft_json));
      assert.equal(
        db.prepare('SELECT mode FROM routing_decision_receipts WHERE id=?').get(receiptId).mode,
        'ACTIVE',
      );
      assert.equal(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM mission_events
             WHERE mission_id=? AND event_type='routing.assigned'`,
          )
          .get(missionId).count,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE target_id=? AND action='routing.assigned'",
          )
          .get(missionId).count,
        1,
      );
    }
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM usage_records WHERE mission_id=? AND teammate_id=?')
        .get(facts.partyMissionId, facts.approvedCollaboratorId).count,
      0,
      'Denied collaboration must persist zero usage for the target teammate',
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM mission_events
           WHERE mission_id=? AND actor_id=? AND event_type='model.call_started'`,
        )
        .get(facts.partyMissionId, facts.approvedCollaboratorId).count,
      0,
    );
    const approvedUsage = db
      .prepare(
        'SELECT runtime_profile_id, run_id FROM usage_records WHERE mission_id=? AND teammate_id=?',
      )
      .all(facts.approvedPartyMissionId, facts.approvedCollaboratorId);
    assert.ok(approvedUsage.length > 0);
    assert.ok(
      approvedUsage.every((row) => row.runtime_profile_id === facts.approvedCollaboratorRuntimeId),
      'Approved collaborator usage must retain its private Runtime identity',
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM mission_events
           WHERE mission_id=? AND event_type='collaboration.approved'`,
        )
        .get(facts.approvedPartyMissionId).count,
      1,
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM audit_events
           WHERE target_type='MISSION' AND target_id=? AND action='collaboration.approved'`,
        )
        .get(facts.approvedPartyMissionId).count,
      1,
    );
  } finally {
    db.close();
  }

  const restarted = await launch();
  try {
    const { page } = restarted;
    const retained = await page.evaluate(async (missionId) => {
      const api = window.cultivation;
      return {
        detail: await api.missions.detail(missionId),
        request: (await api.r2.listRequests()).find((item) => item.missionId === missionId),
        routing: await api.routing.config(),
        shadow: await api.r3.getConfig(),
      };
    }, facts.humanMissionId);
    assert.equal(retained.detail.mission.state, 'WAITING_EXTERNAL_WORK');
    assert.equal(retained.detail.runs[0]?.id, facts.runId);
    assert.equal(retained.detail.runs[0]?.status, 'RUNNING');
    assert.equal(retained.request?.id, facts.requestId);
    assert.equal(retained.request?.state, 'PENDING');
    assert.equal(retained.routing.cloudEnabled, true);
    assert.equal(retained.shadow.mode, 'SHADOW');
    assert.equal(retained.shadow.enabled, false);

    const uiHumanRetained = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      facts.uiHumanMissionId,
    );
    assert.equal(uiHumanRetained.mission.state, 'WAITING_EXTERNAL_WORK');
    assert.equal(uiHumanRetained.runs[0].id, facts.uiHumanRunId);
    await page.evaluate((id) => window.cultivation.r2.markInProgress(id), facts.uiHumanRequestId);
    await page.evaluate(
      (requestId) =>
        window.cultivation.r2.submitArtifacts({
          requestId,
          artifacts: [{ targetArtifactId: 'result', relativePath: 'deliverables/result.txt' }],
        }),
      facts.uiHumanRequestId,
    );
    await page.evaluate(
      (requestId) =>
        window.cultivation.r2.accept({
          requestId,
          publicResult: 'Accepted explicitly chosen Human Bridge result.',
        }),
      facts.uiHumanRequestId,
    );
    const uiHumanCompleted = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      facts.uiHumanMissionId,
    );
    assert.equal(uiHumanCompleted.mission.state, 'COMPLETED');
    assert.equal(uiHumanCompleted.runs.length, 1);
    assert.equal(uiHumanCompleted.runs[0].id, facts.uiHumanRunId);
    assert.equal(uiHumanCompleted.runs[0].status, 'COMPLETED');
    assert.equal(uiHumanCompleted.usage.length, 0);
    assert.equal(
      uiHumanCompleted.events.filter(
        (event) => event.eventType.startsWith('model.') || event.eventType.startsWith('tool.'),
      ).length,
      0,
    );

    const explicitUnavailable = await page.evaluate(
      async ({ a, nonce }) => {
        return window.cultivation.routing.createMission({
          title: `R4 explicit unavailable ${nonce}`,
          context: {
            objective: 'Use the explicitly selected model and never substitute another model.',
            requiredCapabilities: ['GENERAL_REASONING'],
            executionConstraint: 'SOLO',
            explicitTeammateId: a.id,
          },
        });
      },
      { a: facts.a, nonce },
    );
    assert.equal(explicitUnavailable.status, 'USER_ACTION_REQUIRED');
    assert.equal(explicitUnavailable.reason, 'EXPLICIT_TEAMMATE_UNAVAILABLE');
    assert.equal(explicitUnavailable.receipt.assignment, null);
    assert.deepEqual(
      explicitUnavailable.receipt.candidates.map((item) => item.teammateId),
      [facts.a.id],
      'An explicit unavailable teammate must not be replaced with the other available candidate',
    );
    const explicitReceiptAudit = await page.evaluate(
      (id) =>
        window.cultivation.routing.receipts().then((items) => items.find((item) => item.id === id)),
      explicitUnavailable.receipt.id,
    );
    assert.equal(explicitReceiptAudit?.outcome, 'USER_ACTION_REQUIRED');
    facts.explicitUnavailableReceiptId = explicitUnavailable.receipt.id;
    facts.explicitUnavailableTitle = `R4 explicit unavailable ${nonce}`;
    assert.equal(
      (await page.evaluate(() => window.cultivation.missions.list())).some(
        (mission) => mission.title === `R4 explicit unavailable ${nonce}`,
      ),
      false,
    );

    await page.evaluate((id) => window.cultivation.r2.markInProgress(id), facts.requestId);
    const submitted = await page.evaluate(
      ({ requestId }) =>
        window.cultivation.r2.submitArtifacts({
          requestId,
          artifacts: [{ targetArtifactId: 'result', relativePath: 'deliverables/result.txt' }],
        }),
      { requestId: facts.requestId },
    );
    assert.equal(submitted.state, 'SUBMITTED');
    await page.evaluate(
      ({ requestId, publicResult }) => window.cultivation.r2.accept({ requestId, publicResult }),
      { requestId: facts.requestId, publicResult: facts.publicResult },
    );
    const completed = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      facts.humanMissionId,
    );
    assert.equal(completed.mission.state, 'COMPLETED');
    assert.equal(completed.runs.length, 1, 'ACCEPT must continue the original Mission Run');
    assert.equal(completed.runs[0].id, facts.runId);
    assert.equal(completed.runs[0].status, 'COMPLETED');
    assert.equal(completed.runs[0].resultText, facts.publicResult);
    assert.equal(
      completed.usage.length,
      0,
      'Human Bridge continuation must not fabricate model usage',
    );
    assert.equal(
      completed.artifacts.length,
      0,
      'ExternalWork must not create a collaboration artifact',
    );
    assert.ok(
      completed.events.some((event) => event.eventType === 'external_work.continuation_received'),
    );
    assert.equal(
      completed.events.filter(
        (event) => event.eventType.startsWith('model.') || event.eventType.startsWith('tool.'),
      ).length,
      0,
      'Human Bridge execution must not create model or tool events',
    );
    assert.equal((await page.evaluate(() => window.cultivation.r3.getConfig())).enabled, false);
  } finally {
    await restarted.app.close();
  }

  const verify = new Database(databasePath, { readonly: true });
  try {
    assert.equal(
      verify.prepare('SELECT state FROM missions WHERE id=?').get(facts.uiHumanMissionId).state,
      'COMPLETED',
    );
    assert.equal(
      verify
        .prepare('SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id=?')
        .get(facts.uiHumanMissionId).count,
      1,
    );
    assert.equal(
      verify
        .prepare('SELECT mission_id, status FROM mission_runs WHERE id=?')
        .get(facts.uiHumanRunId).mission_id,
      facts.uiHumanMissionId,
    );
    assert.equal(
      verify.prepare('SELECT status FROM mission_runs WHERE id=?').get(facts.uiHumanRunId).status,
      'COMPLETED',
    );
    assert.equal(
      verify
        .prepare(
          'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id=?',
        )
        .get(facts.uiHumanRequestId).state,
      'CONSUMED',
    );
    assert.equal(
      verify
        .prepare('SELECT COUNT(*) AS count FROM usage_records WHERE mission_id=?')
        .get(facts.uiHumanMissionId).count,
      0,
    );
    assert.equal(
      verify.prepare('SELECT state FROM missions WHERE id=?').get(facts.humanMissionId).state,
      'COMPLETED',
    );
    const run = verify
      .prepare('SELECT status, result_text FROM mission_runs WHERE id=?')
      .get(facts.runId);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.result_text, facts.publicResult);
    assert.equal(
      verify
        .prepare('SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id=?')
        .get(facts.humanMissionId).count,
      1,
    );
    assert.equal(
      verify
        .prepare('SELECT COUNT(*) AS count FROM usage_records WHERE mission_id=?')
        .get(facts.humanMissionId).count,
      0,
    );
    assert.equal(
      verify
        .prepare(
          `SELECT COUNT(*) AS count FROM mission_events
           WHERE mission_id=? AND (event_type LIKE 'model.%' OR event_type LIKE 'tool.%')`,
        )
        .get(facts.humanMissionId).count,
      0,
    );
    assert.equal(
      verify
        .prepare(
          'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id=?',
        )
        .get(facts.requestId).state,
      'CONSUMED',
    );
    assert.equal(
      verify.prepare('SELECT state FROM external_work_requests WHERE id=?').get(facts.requestId)
        .state,
      'ACCEPTED',
    );
    assert.equal(
      verify
        .prepare(
          'SELECT COUNT(*) AS count FROM external_work_artifacts WHERE external_work_request_id=?',
        )
        .get(facts.requestId).count,
      1,
    );
    assert.equal(
      verify
        .prepare('SELECT COUNT(*) AS count FROM collaboration_artifacts WHERE mission_id=?')
        .get(facts.humanMissionId).count,
      0,
    );
    for (const receiptId of [facts.unmetReceiptId, facts.explicitUnavailableReceiptId]) {
      const receipt = verify
        .prepare('SELECT mode, receipt_json FROM routing_decision_receipts WHERE id=?')
        .get(receiptId);
      assert.equal(receipt.mode, 'ACTIVE');
      assert.equal(JSON.parse(receipt.receipt_json).outcome, 'USER_ACTION_REQUIRED');
      assert.equal(
        verify
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_events WHERE target_type='ROUTING_RECEIPT' AND target_id=? AND action='routing.decided'",
          )
          .get(receiptId).count,
        1,
      );
    }
    for (const title of [facts.unmetTitle, facts.explicitUnavailableTitle]) {
      assert.equal(
        verify.prepare('SELECT COUNT(*) AS count FROM missions WHERE title=?').get(title).count,
        0,
        'USER_ACTION_REQUIRED must not substitute or create a Mission',
      );
    }
  } finally {
    verify.close();
  }

  const evidencePath = join(userData, 'r4-evidence.json');
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        migration: 27,
        decisionMode: 'ACTIVE',
        shadowEnabled: false,
        checks: [
          'explicit Human Bridge without Workspace returns WORKSPACE_REQUIRED and creates no Mission',
          'incompatible explicit constraints reject before probe and receipt',
          'SOLO/PARTY cannot degrade to Human Bridge',
          'explicit Human Bridge UI with supported available models performs zero model probes',
          'explicit Human Bridge WAITING_EXTERNAL_WORK restart and ACCEPT stay in the same Run',
          'automatic SOLO Benchmark 90 > 60',
          'automatic AD_HOC Party uses existing approval and actor Runtime attribution',
          'denied collaborator has zero model calls and usage',
          'Human Bridge fallback survives restart and ACCEPT completes the same Run',
          'Human Bridge has zero model/tool calls and usage',
          'explicit UNAVAILABLE identity is retained without substitution',
          'unsupported capability creates no Mission',
          'routing receipt and assignment Event/Audit are durable',
        ],
        ui: facts.uiEvidence,
        missions: {
          solo: facts.soloMissionId,
          deniedParty: facts.partyMissionId,
          approvedParty: facts.approvedPartyMissionId,
          humanBridge: facts.humanMissionId,
          humanBridgeRun: facts.runId,
          explicitHumanBridge: facts.uiHumanMissionId,
          explicitHumanBridgeRun: facts.uiHumanRunId,
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`R4_PACKAGED_EVIDENCE ${evidencePath}`);
  console.log(
    'R4_PACKAGED_SMOKE_OK constraints=hard_conflicts_zero_side_effects explicit_human_bridge=ui_zero_probe_same_run routing_optin=independent auto_solo=90 auto_party=AD_HOC human_bridge_fallback=durable_same_run explicit_unavailable=no_substitution unmet_capability=blocked shadow=unchanged',
  );
}

await main();
