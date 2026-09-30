import { navigateUi } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';

const userData = join(process.cwd(), '.test-data', `r3-2-packaged-${Date.now()}`);
mkdirSync(userData, { recursive: true });
const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const launch = () =>
  electron.launch({
    executablePath,
    args: ['--gate1-fake-model'],
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
    timeout: 30_000,
  });
let app = await launch();
let teammateId;
let runtimeProfileId;
let conversationId;
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  const result = await page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'Availability fixture',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://localhost:1234/v1',
    });
    const runtime = await api.runtimes.create({
      name: 'R3.2 fixture',
      providerId: provider.id,
      credentialId: null,
      modelId: 'fixed-model',
    });
    const a = await api.teammates.create({
      name: 'Availability A',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    const b = await api.teammates.create({
      name: 'Availability B',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    const initial = await api.availability.list();
    const first = await api.availability.prepare(a.id);
    const recheck = await api.availability.recheck(a.id);
    const conversation = await api.chat.createConversation(a.id);
    const mission = await api.missions.create({
      title: 'Availability SOLO',
      objective: 'Normal answer',
      coordinatorTeammateId: a.id,
    });
    await api.missions.ready(mission.id);
    const solo = await api.missions.start({ missionId: mission.id, approvalFixture: false });
    const party = await api.parties.create({
      name: 'Availability Party',
      description: '',
      type: 'FIXED',
      coordinatorTeammateId: a.id,
      memberTeammateIds: [a.id, b.id],
    });
    const partyMission = await api.missions.create({
      title: 'Availability Consultation',
      objective: 'Independent perspective',
      coordinatorTeammateId: a.id,
      partyId: party.id,
      mode: 'CONSULTATION',
    });
    await api.missions.ready(partyMission.id);
    const proposed = await api.missions.start({
      missionId: partyMission.id,
      approvalFixture: false,
    });
    const pending = proposed.collaborations.find((r) => r.state === 'PENDING');
    const completed = await api.missions.resolveCollaboration({
      requestId: pending.id,
      decision: 'APPROVED',
    });
    return {
      a,
      b,
      initial,
      first,
      recheck,
      conversation,
      solo,
      completed,
      states: await api.availability.list(),
      bridge: await api.r2.bridgeProfile(),
    };
  });
  teammateId = result.a.id;
  runtimeProfileId = result.a.currentRuntimeProfileId;
  conversationId = result.conversation.id;
  assert.equal(result.initial.find((r) => r.teammateId === teammateId).status, 'UNKNOWN');
  assert.equal(result.first.ok, true);
  assert.equal(result.recheck.status, 'AVAILABLE');
  assert.equal(result.solo.mission.state, 'COMPLETED');
  assert.equal(result.completed.mission.state, 'COMPLETED');
  assert.equal(result.states.find((r) => r.teammateId === result.b.id).status, 'AVAILABLE');
  assert.ok(!result.states.some((r) => r.teammateId === result.bridge.teammate.id));
  await navigateUi(page, '道友 Teammates');
  await page.getByText('Availability A', { exact: true }).first().click();
  await page.locator('[data-availability="AVAILABLE"]').first().waitFor();
} finally {
  await app.close();
}

// Real AI SDK/HTTP path in the Windows package; no public API or secret is needed.
let authenticationRejected = false;
let generationCalls = 0;
let metadataCalls = 0;
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/v1/chat/completions') generationCalls += 1;
  if (request.method === 'GET' && request.url === '/v1/models') metadataCalls += 1;
  if (authenticationRejected) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'fixture authentication rejected', type: 'authentication_error' },
      }),
    );
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }),
    );
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const input = JSON.parse(Buffer.concat(body).toString('utf8'));
    const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: 'fixture-stream',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
      };
      response.end(
        [
          {
            ...base,
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'PONG' }, finish_reason: null },
            ],
          },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
        ]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
      );
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'fixture-completion',
          object: 'chat.completion',
          created: 1,
          model: 'fixture-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' },
          ],
          usage,
        }),
      );
    }
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const sdkData = join(process.cwd(), '.test-data', `r3-2-sdk-packaged-${Date.now()}`);
mkdirSync(sdkData, { recursive: true });
const sdkApp = await electron.launch({
  executablePath,
  args: [],
  env: { ...process.env, CULTIVATION_USER_DATA_DIR: sdkData },
  timeout: 30_000,
});
try {
  const page = await sdkApp.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  const setup = await page.evaluate(async (baseUrl) => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'Real SDK fixture',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl,
    });
    const runtime = await api.runtimes.create({
      name: 'Real SDK fixture',
      providerId: provider.id,
      credentialId: null,
      modelId: 'fixture-model',
    });
    const teammate = await api.teammates.create({
      name: 'SDK Availability',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtime.id,
    });
    const conversation = await api.chat.createConversation(teammate.id);
    return { teammate, conversation };
  }, `http://127.0.0.1:${address.port}/v1`);
  const send = () =>
    page.evaluate(async ({ teammate, conversation }) => {
      const api = window.cultivation;
      return await new Promise((resolve, reject) => {
        const requestId = window.crypto.randomUUID();
        const timer = window.setTimeout(() => {
          off();
          reject(new Error('SDK stream timeout'));
        }, 15_000);
        const off = api.chat.onEvent((event) => {
          if (event.requestId === requestId && ['done', 'error'].includes(event.type)) {
            window.clearTimeout(timer);
            off();
            resolve(event);
          }
        });
        api.chat
          .send({
            teammateId: teammate.id,
            conversationId: conversation.id,
            requestId,
            text: 'PING',
          })
          .catch(reject);
      });
    }, setup);
  assert.equal((await send()).type, 'done');
  assert.equal(generationCalls, 1);
  assert.equal(metadataCalls, 2); // Creation verification and UNKNOWN pre-send probe.
  assert.equal(
    (await page.evaluate(() => window.cultivation.availability.list()))[0].status,
    'AVAILABLE',
  );
  const solo = await page.evaluate(async (id) => {
    const api = window.cultivation;
    const mission = await api.missions.create({
      title: 'SDK SOLO',
      objective: 'Return PONG',
      coordinatorTeammateId: id,
    });
    await api.missions.ready(mission.id);
    return api.missions.start({ missionId: mission.id, approvalFixture: false });
  }, setup.teammate.id);
  assert.equal(solo.mission.state, 'COMPLETED');
  assert.equal(generationCalls, 2);
  authenticationRejected = true;
  assert.equal((await send()).type, 'error');
  const failed = (await page.evaluate(() => window.cultivation.availability.list()))[0];
  assert.equal(failed.status, 'UNAVAILABLE');
  assert.equal(failed.recentOutcomes.at(-1).kind, 'HARD_FAILURE');
  assert.equal(generationCalls, 3);
  const blocked = await page.evaluate(
    (id) => window.cultivation.availability.prepare(id),
    setup.teammate.id,
  );
  assert.equal(blocked.ok, false);
  assert.equal(generationCalls, 3);
  authenticationRejected = false;
  const recovered = await page.evaluate(async (id) => {
    await window.cultivation.availability.recheck(id);
    return window.cultivation.availability.recheck(id);
  }, setup.teammate.id);
  assert.equal(recovered.status, 'AVAILABLE');
  console.log(
    'R3_2_SDK_PACKAGED_SMOKE_OK metadata=real_http stream=real_sdk solo=real_sdk auth_failure=unavailable no_reroute=ok recovery=ok',
  );
} finally {
  await sdkApp.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

// Seed a durable hard failure, then prove the Windows app preserves it and never reroutes.
const databasePath = join(userData, 'data', 'cultivation.sqlite');
{
  const db = new Database(databasePath);
  try {
    const at = new Date().toISOString();
    db.prepare(
      `UPDATE teammate_model_availability SET status='UNAVAILABLE',last_checked_at=?,last_failure_at=?,recent_outcomes_json=? WHERE teammate_id=?`,
    ).run(
      at,
      at,
      JSON.stringify([{ kind: 'HARD_FAILURE', code: 'AUTH_FAILED', checkedAt: at }]),
      teammateId,
    );
  } finally {
    db.close();
  }
}
app = await launch();
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '洞府 Home' }).waitFor();
  const beforeDb = new Database(databasePath, { readonly: true });
  const countBefore = beforeDb.prepare('SELECT count(*) AS n FROM usage_records').get().n;
  beforeDb.close();
  const result = await page.evaluate(
    async ({ teammateId, conversationId }) => {
      const api = window.cultivation;
      const blocked = await api.availability.prepare(teammateId);
      const event = await new Promise((resolve, reject) => {
        const requestId = window.crypto.randomUUID();
        const timer = window.setTimeout(() => {
          off();
          reject(new Error('chat availability timeout'));
        }, 15_000);
        const off = api.chat.onEvent((e) => {
          if (e.requestId === requestId && e.type === 'error') {
            window.clearTimeout(timer);
            off();
            resolve(e);
          }
        });
        api.chat
          .send({ teammateId, conversationId, requestId, text: 'Do not switch teammate' })
          .catch(reject);
      });
      return { blocked, event, states: await api.availability.list() };
    },
    { teammateId, conversationId },
  );
  assert.equal(result.blocked.ok, false);
  assert.deepEqual(result.blocked.actions, ['RECHECK', 'SELECT_OTHER', 'CANCEL']);
  assert.equal(result.event.code, 'MODEL_UNAVAILABLE');
  assert.equal(result.event.teammateId, teammateId);
  assert.equal(
    result.states.find((r) => r.teammateId === teammateId).runtimeProfileId,
    runtimeProfileId,
  );
  const afterDb = new Database(databasePath, { readonly: true });
  try {
    assert.equal(afterDb.prepare('SELECT count(*) AS n FROM usage_records').get().n, countBefore);
  } finally {
    afterDb.close();
  }
  const recovery = await page.evaluate(async (id) => {
    await window.cultivation.availability.recheck(id);
    return window.cultivation.availability.recheck(id);
  }, teammateId);
  assert.equal(recovery.status, 'AVAILABLE');
  console.log(
    'R3_2_PACKAGED_SMOKE_OK unknown=ok probe=ok solo=ok party=ok actor_identity=ok bridge_excluded=ok restart=ok explicit_unavailable=blocked_no_usage recovery=ok',
  );
} finally {
  await app.close();
}
