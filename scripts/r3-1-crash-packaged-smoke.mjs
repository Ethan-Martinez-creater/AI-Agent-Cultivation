import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
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
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  return { app, page };
}

async function forceKill(app) {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await exited;
}

const first = await launch();
let facts;
let firstKilled = false;
try {
  await first.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspaceRoot);
  await first.page.getByRole('link', { name: '本尊待办 Human Bridge' }).click();
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
      14,
    );
  } finally {
    db.close();
  }
} finally {
  await second.app.close();
}

console.log(
  'R3_1_CRASH_PACKAGED_SMOKE_OK artifact_submitted_before_accept=ok accepted_running_pending_window=ok forced_kill=ok restart_same_run=ok synthesis_once=ok continuation_consumed=ok',
);
