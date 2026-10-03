import { navigateUi } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

const nonce = randomUUID();
const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const userData = join(process.cwd(), '.test-data', `r3-1-crash-${nonce}`);
const workspaceRoot = join(process.cwd(), '.test-data', `r3-1-workspace-${nonce}`);
const databasePath = join(userData, 'data', 'cultivation.sqlite');
mkdirSync(userData, { recursive: true });
mkdirSync(join(workspaceRoot, 'deliverables'), { recursive: true });
writeFileSync(
  join(workspaceRoot, 'deliverables', 'result.png'),
  Buffer.from('R3.1 ExternalWork crash fixture'),
);

async function launch() {
  const app = await electron.launch({
    executablePath,
    args: ['--gate1-fake-model'],
    timeout: 30_000,
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}

async function forceKill(app) {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await closed;
  // Windows can briefly retain a killed process's mapped SQLite SHM handle.
  // Verify write readiness before injecting the next crash window; do not
  // retry application execution or hide persistent database errors.
  const deadline = Date.now() + 5000;
  for (;;) {
    let db;
    try {
      db = new Database(databasePath);
      db.exec('BEGIN IMMEDIATE; COMMIT;');
      return;
    } catch (error) {
      if (error.code !== 'SQLITE_IOERR_TRUNCATE' || Date.now() >= deadline) throw error;
    } finally {
      db?.close();
    }
    await delay(100);
  }
}

const first = await launch();
let facts;
let firstKilled = false;
try {
  await first.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspaceRoot);
  await navigateUi(first.page, '本尊待办 Human Bridge');
  await first.page.getByRole('heading', { name: '本尊待办' }).waitFor();
  facts = await first.page.evaluate(async () => {
    const api = window.cultivation;
    await api.tools.chooseWorkspace();
    const profile = await api.r2.bridgeProfile();
    const bridge = profile.teammate;
    await api.r2.setCapability({ dimension: 'IMAGE_GENERATION', enabled: true });
    const provider = await api.providers.create({
      name: 'R3.1 Crash Fake Provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'R3.1 Crash Coordinator Runtime',
      providerId: provider.id,
      credentialId: null,
      modelId: 'r3-1-crash-fake',
    });
    const coordinator = await api.teammates.create({
      name: 'R3.1 Crash Coordinator',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: 'Coordinate safely.',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    const party = await api.parties.create({
      name: 'R3.1 Crash Team',
      description: 'Durable ExternalWork continuation recovery fixture',
      type: 'FIXED',
      coordinatorTeammateId: coordinator.id,
      memberTeammateIds: [coordinator.id, bridge.id],
    });
    const mission = await api.missions.create({
      title: 'R3.1 crash continuation',
      objective: 'Consult Human Bridge, then synthesize. __R2_EXTERNAL_INSPECT__',
      coordinatorTeammateId: coordinator.id,
      mode: 'CONSULTATION',
      partyId: party.id,
    });
    await api.missions.ready(mission.id);
    const waiting = await api.missions.start({ missionId: mission.id, approvalFixture: false });
    if (waiting.mission.state !== 'WAITING_COLLABORATION') {
      throw new Error(`Expected collaboration wait, got ${waiting.mission.state}`);
    }
    const invite = waiting.collaborations.find((item) => item.state === 'PENDING');
    if (!invite || invite.targetTeammateId !== bridge.id) {
      throw new Error('Human Bridge invitation missing');
    }
    const afterApproval = await api.missions.resolveCollaboration({
      requestId: invite.id,
      decision: 'APPROVED',
      externalWork: {
        capability: 'IMAGE_GENERATION',
        title: 'Prepare image artifact',
        prompt: 'Create an image and save the final image in deliverables/result.png.',
        requirements: ['Produce one image'],
        targetArtifacts: [
          {
            id: 'image-1',
            name: 'Final image',
            required: true,
            allowedExtensions: ['.png'],
            maxSizeBytes: 1048576,
          },
        ],
        targetWorkspacePaths: ['deliverables'],
        acceptanceCriteria: ['Image file exists in the workspace'],
        externalAppProfileId: null,
      },
    });
    const request = (await api.r2.listRequests()).find((item) => item.missionId === mission.id);
    if (!request) throw new Error('Human Bridge ExternalWork request missing');
    await api.r2.markInProgress(request.id);
    const submitted = await api.r2.submitArtifacts({
      requestId: request.id,
      artifacts: [{ targetArtifactId: 'image-1', relativePath: 'deliverables/result.png' }],
    });
    if (submitted.state !== 'SUBMITTED') {
      throw new Error(`Expected submitted artifact before accept, got ${submitted.state}`);
    }
    return {
      bridgeId: bridge.id,
      coordinatorId: coordinator.id,
      coordinatorRuntimeId: coordinator.currentRuntimeProfileId,
      providerId: provider.id,
      partyId: party.id,
      missionId: mission.id,
      runId: waiting.runs[0].id,
      requestId: request?.id,
      waitingState: afterApproval.mission.state,
      waitingRunId: afterApproval.runs[0].id,
    };
  });
  assert.equal(facts.waitingState, 'WAITING_EXTERNAL_WORK');
  assert.equal(facts.waitingRunId, facts.runId);
  assert.ok(facts.requestId);

  const gate = new Database(databasePath);
  try {
    gate.exec(`
      CREATE TRIGGER r3_1_test_hold_before_consumption
      BEFORE UPDATE OF state ON r2_external_work_continuations
      WHEN old.state = 'PENDING' AND new.state = 'CONSUMING'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
  } finally {
    gate.close();
  }

  const interruptedAccept = await first.page.evaluate(async (requestId) => {
    try {
      await window.cultivation.r2.accept({
        requestId,
        publicResult: 'The accepted artifact is ready for synthesis.',
      });
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }, facts.requestId);
  assert.equal(interruptedAccept.ok, false, 'fault injection must stop before continuation claim');

  const verifyWindow = new Database(databasePath, { readonly: true });
  try {
    assert.equal(
      verifyWindow
        .prepare('SELECT state FROM external_work_requests WHERE id = ?')
        .get(facts.requestId).state,
      'ACCEPTED',
    );
    assert.equal(
      verifyWindow
        .prepare(
          'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id = ?',
        )
        .get(facts.requestId).state,
      'PENDING',
    );
    assert.equal(
      verifyWindow.prepare('SELECT state FROM missions WHERE id = ?').get(facts.missionId).state,
      'WAITING_EXTERNAL_WORK',
    );
    assert.equal(
      verifyWindow.prepare('SELECT status FROM mission_runs WHERE id = ?').get(facts.runId).status,
      'RUNNING',
    );
  } finally {
    verifyWindow.close();
  }

  await forceKill(first.app);
  firstKilled = true;
} finally {
  if (!firstKilled) await first.app.close().catch(() => undefined);
}

const clearGate = new Database(databasePath);
try {
  clearGate.exec('DROP TRIGGER r3_1_test_hold_before_consumption;');
  // Recreate the historical split-commit window deterministically: ACCEPTED request,
  // RUNNING Mission/Run, and an unconsumed durable continuation.
  clearGate
    .prepare(
      `UPDATE missions SET state = 'RUNNING', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND state = 'WAITING_EXTERNAL_WORK'`,
    )
    .run(facts.missionId);
} finally {
  clearGate.close();
}

const exactWindow = new Database(databasePath, { readonly: true });
try {
  assert.equal(
    exactWindow
      .prepare('SELECT state FROM external_work_requests WHERE id = ?')
      .get(facts.requestId).state,
    'ACCEPTED',
  );
  assert.equal(
    exactWindow
      .prepare(
        'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id = ?',
      )
      .get(facts.requestId).state,
    'PENDING',
  );
  assert.equal(
    exactWindow.prepare('SELECT state FROM missions WHERE id = ?').get(facts.missionId).state,
    'RUNNING',
  );
  assert.equal(
    exactWindow.prepare('SELECT status FROM mission_runs WHERE id = ?').get(facts.runId).status,
    'RUNNING',
  );
} finally {
  exactWindow.close();
}

const second = await launch();
let secondKilled = false;
let consumingFacts;
try {
  const recovered = await second.page.waitForFunction(
    async ({ missionId, runId }) => {
      const detail = await window.cultivation.missions.detail(missionId);
      return detail.mission.state === 'COMPLETED' && detail.runs[0]?.id === runId ? detail : false;
    },
    facts,
    { timeout: 30_000 },
  );
  const result = await recovered.jsonValue();
  assert.equal(result.runs.length, 1, 'recovery must resume the same Run');
  assert.equal(result.runs[0].status, 'COMPLETED');
  assert.equal(result.artifacts.filter((item) => item.kind === 'FINAL').length, 1);
  assert.equal(result.usage.filter((item) => item.teammateId === facts.bridgeId).length, 0);
  assert.equal(result.artifacts.filter((item) => item.teammateId === facts.bridgeId).length, 0);
  const synthesis = JSON.parse(result.runs[0].resultText);
  assert.equal(synthesis.externalWorkContext.requestId, facts.requestId);
  assert.equal(synthesis.externalWorkContext.trust, 'UNTRUSTED_EXTERNAL_DATA');
  assert.equal(synthesis.userMessagesWithExternalResult, 0);
  assert.equal(synthesis.toolMessagesWithExternalResult, 0);

  const db = new Database(databasePath, { readonly: true });
  try {
    assert.equal(
      db
        .prepare(
          'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id = ?',
        )
        .get(facts.requestId).state,
      'CONSUMED',
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id = ?')
        .get(facts.missionId).count,
      1,
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM mission_events
           WHERE mission_id = ? AND run_id = ? AND event_type = 'model.call_started'
             AND actor_id = ? AND json_extract(payload_json, '$.phase') = 'SYNTHESIS'`,
        )
        .get(facts.missionId, facts.runId, facts.coordinatorId).count,
      1,
      'the coordinator synthesis runs once after the restart',
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM mission_events
           WHERE mission_id = ? AND run_id = ? AND event_type = 'external_work.continuation_received'
             AND json_extract(payload_json, '$.requestId') = ?`,
        )
        .get(facts.missionId, facts.runId, facts.requestId).count,
      1,
      'the accepted continuation is durably recorded once',
    );
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      20,
    );
  } finally {
    db.close();
  }

  consumingFacts = await second.page.evaluate(async ({ coordinatorId, partyId, bridgeId }) => {
    const api = window.cultivation;
    const mission = await api.missions.create({
      title: 'R3.1 started synthesis crash',
      objective: 'Consult Human Bridge, then synthesize after restart.',
      coordinatorTeammateId: coordinatorId,
      mode: 'CONSULTATION',
      partyId,
    });
    await api.missions.ready(mission.id);
    const waiting = await api.missions.start({ missionId: mission.id, approvalFixture: false });
    const invite = waiting.collaborations.find(
      (item) => item.state === 'PENDING' && item.targetTeammateId === bridgeId,
    );
    if (!invite) throw new Error('Started synthesis fixture has no Human Bridge invitation');
    const afterApproval = await api.missions.resolveCollaboration({
      requestId: invite.id,
      decision: 'APPROVED',
      externalWork: {
        capability: 'IMAGE_GENERATION',
        title: 'Prepare another image artifact',
        prompt: 'Use the existing deliverables/result.png as the completed artifact.',
        requirements: ['Provide one image'],
        targetArtifacts: [
          {
            id: 'image-2',
            name: 'Final image',
            required: true,
            allowedExtensions: ['.png'],
            maxSizeBytes: 1048576,
          },
        ],
        targetWorkspacePaths: ['deliverables'],
        acceptanceCriteria: ['Image file exists in the workspace'],
        externalAppProfileId: null,
      },
    });
    if (afterApproval.mission.state !== 'WAITING_EXTERNAL_WORK') {
      throw new Error('Started synthesis fixture did not wait for ExternalWork');
    }
    const request = (await api.r2.listRequests()).find((item) => item.missionId === mission.id);
    if (!request) throw new Error('Started synthesis fixture has no ExternalWork request');
    await api.r2.markInProgress(request.id);
    const submitted = await api.r2.submitArtifacts({
      requestId: request.id,
      artifacts: [{ targetArtifactId: 'image-2', relativePath: 'deliverables/result.png' }],
    });
    if (submitted.state !== 'SUBMITTED')
      throw new Error('Started synthesis artifact not submitted');
    return { missionId: mission.id, runId: waiting.runs[0].id, requestId: request.id };
  }, facts);

  const holdStarted = new Database(databasePath);
  try {
    holdStarted.exec(`
      CREATE TRIGGER r3_1_test_hold_started_synthesis
      BEFORE UPDATE OF state ON r2_external_work_continuations
      WHEN old.state = 'PENDING' AND new.state = 'CONSUMING'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
  } finally {
    holdStarted.close();
  }
  const heldAccept = await second.page.evaluate(async (requestId) => {
    try {
      await window.cultivation.r2.accept({
        requestId,
        publicResult: 'The second accepted artifact is ready.',
      });
      return true;
    } catch {
      return false;
    }
  }, consumingFacts.requestId);
  assert.equal(heldAccept, false, 'fault injection must stop before synthesis');
  await forceKill(second.app);
  secondKilled = true;
} finally {
  if (!secondKilled) await second.app.close();
}

const injectStarted = new Database(databasePath);
try {
  injectStarted.exec('DROP TRIGGER r3_1_test_hold_started_synthesis;');
  const request = injectStarted
    .prepare('SELECT * FROM external_work_requests WHERE id = ?')
    .get(consumingFacts.requestId);
  const artifact = injectStarted
    .prepare(
      `SELECT id, path, file_name, extension, size_bytes
       FROM external_work_artifacts WHERE external_work_request_id = ?
       ORDER BY submitted_at DESC, id DESC LIMIT 1`,
    )
    .get(consumingFacts.requestId);
  assert.equal(request.state, 'ACCEPTED');
  assert.ok(artifact);
  const marked = injectStarted
    .prepare(
      `UPDATE r2_external_work_continuations
       SET state = 'CONSUMING', updated_at = ?
       WHERE external_work_request_id = ? AND state = 'PENDING'`,
    )
    .run(new Date().toISOString(), consumingFacts.requestId);
  assert.equal(marked.changes, 1);
  injectStarted
    .prepare(
      `UPDATE missions SET state = 'RUNNING', updated_at = ?
       WHERE id = ? AND state = 'WAITING_EXTERNAL_WORK'`,
    )
    .run(new Date().toISOString(), consumingFacts.missionId);
  const at = Date.now();
  const receivedPayload = {
    kind: 'EXTERNAL_WORK_CONTINUATION',
    requestId: consumingFacts.requestId,
    missionId: consumingFacts.missionId,
    runId: consumingFacts.runId,
    requesterTeammateId: facts.coordinatorId,
    assigneeTeammateId: facts.bridgeId,
    capability: request.capability,
    outcome: 'ACCEPTED',
    publicResult: request.public_result,
    artifacts: [
      {
        id: artifact.id,
        path: artifact.path,
        fileName: artifact.file_name,
        extension: artifact.extension,
        sizeBytes: artifact.size_bytes,
      },
    ],
    trust: 'UNTRUSTED_EXTERNAL_DATA',
  };
  const addEvent = injectStarted.prepare(
    `INSERT INTO mission_events
       (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  addEvent.run(
    randomUUID(),
    consumingFacts.missionId,
    consumingFacts.runId,
    'external_work.continuation_received',
    'SYSTEM',
    null,
    JSON.stringify(receivedPayload),
    new Date(at + 1000).toISOString(),
  );
  addEvent.run(
    randomUUID(),
    consumingFacts.missionId,
    consumingFacts.runId,
    'model.call_started',
    'TEAMMATE',
    facts.coordinatorId,
    JSON.stringify({
      phase: 'SYNTHESIS',
      externalWorkRequestId: consumingFacts.requestId,
      runtimeProfileId: facts.coordinatorRuntimeId,
      providerId: facts.providerId,
      modelId: 'r3-1-crash-fake',
    }),
    new Date(at + 2000).toISOString(),
  );
} finally {
  injectStarted.close();
}

const third = await launch();
try {
  const interrupted = await third.page.waitForFunction(
    async ({ missionId, runId }) => {
      const detail = await window.cultivation.missions.detail(missionId);
      return detail.mission.state === 'INTERRUPTED' && detail.runs[0]?.id === runId
        ? detail
        : false;
    },
    consumingFacts,
    { timeout: 30_000 },
  );
  const detail = await interrupted.jsonValue();
  assert.equal(detail.runs[0].status, 'INTERRUPTED');
  assert.equal(detail.artifacts.filter((item) => item.kind === 'FINAL').length, 0);
  const noReplay = new Database(databasePath, { readonly: true });
  try {
    assert.equal(
      noReplay
        .prepare(
          `SELECT COUNT(*) AS count FROM mission_events
           WHERE mission_id = ? AND run_id = ? AND event_type = 'model.call_started'
             AND json_extract(payload_json, '$.phase') = 'SYNTHESIS'`,
        )
        .get(consumingFacts.missionId, consumingFacts.runId).count,
      1,
      'startup must not start synthesis again after a durable call-start fact',
    );
    assert.equal(
      noReplay
        .prepare(
          'SELECT state FROM r2_external_work_continuations WHERE external_work_request_id = ?',
        )
        .get(consumingFacts.requestId).state,
      'CONSUMING',
    );
    assert.equal(
      noReplay
        .prepare('SELECT state FROM external_work_requests WHERE id = ?')
        .get(consumingFacts.requestId).state,
      'ACCEPTED',
    );
    assert.equal(
      noReplay
        .prepare(
          'SELECT COUNT(*) AS count FROM external_work_artifacts WHERE external_work_request_id = ?',
        )
        .get(consumingFacts.requestId).count,
      1,
    );
  } finally {
    noReplay.close();
  }
} finally {
  await third.app.close();
}

console.log(
  'R3_1_CRASH_PACKAGED_SMOKE_OK pending_restart_same_run=ok synthesis_once=ok continuation_consumed=ok consuming_started_interrupted=ok no_auto_replay=ok accepted_artifact_retained=ok',
);
