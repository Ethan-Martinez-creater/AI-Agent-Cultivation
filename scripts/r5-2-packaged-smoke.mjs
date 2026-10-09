import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';

const root = process.cwd();
const nonce = randomUUID();
const profileRoot = join(root, '.test-data', `r5-2-packaged-${nonce}`);
const productionProfile = join(profileRoot, 'production');
const fixtureProfile = join(profileRoot, 'fixture');
const evidenceDir = join(root, 'docs', 'evidence', 'r5-2-memory-pre-gate', nonce);
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const officialWorkflowIds = [
  'official.ai-news-video',
  'official.research',
  'official.software-feature',
];
const durableText = 'I prefer green tea.';
const skippedText = '你好。';
const fallbackText = 'I avoid coffee after lunch.';

assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);
assert.equal(
  existsSync(profileRoot),
  false,
  'Each R5.2 smoke run needs a fresh project-local profile',
);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function hashText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function snapshotOfficialVersions(versions, { requireFixture = false } = {}) {
  const official = versions
    .filter((item) => officialWorkflowIds.includes(item.definition.id))
    .sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  assert.deepEqual(
    official.map((item) => item.definition.id),
    [...officialWorkflowIds].sort(),
    'The packaged app must expose exactly the three official workflow definitions',
  );
  if (requireFixture) {
    assert.ok(
      versions.some((item) => item.definition.id === 'w1-fixture-sequence' && item.version === 1),
      'The explicit W1 compatibility fixture must be registered for this run',
    );
  } else {
    assert.deepEqual(
      versions.map((item) => item.definition.id).sort(),
      [...officialWorkflowIds].sort(),
      'A normal production launch must expose no user or test-only workflow templates',
    );
  }
  return Object.fromEntries(official.map((item) => [item.definition.id, hash(item)]));
}

function openReadOnlyDatabase(profile, fn) {
  const path = join(profile, 'data', 'cultivation.sqlite');
  assert.ok(existsSync(path), `Expected packaged profile database at ${path}`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function launch(profile, args = []) {
  const tempPath = join(profile, 'tmp');
  mkdirSync(tempPath, { recursive: true });
  const app = await electron.launch({
    executablePath,
    args,
    timeout: 30_000,
    env: {
      ...process.env,
      CULTIVATION_USER_DATA_DIR: profile,
      TEMP: tempPath,
      TMP: tempPath,
      TMPDIR: tempPath,
    },
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}

function assertMigrations(profile) {
  return openReadOnlyDatabase(profile, (db) => {
    const migrations = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version);
    assert.deepEqual(
      migrations,
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    return migrations;
  });
}

async function seedActor(page, role) {
  return page.evaluate(
    async ({ role, nonce }) => {
      const api = window.cultivation;
      const provider = await api.providers.create({
        name: `R5.2 ${role} offline LANGUAGE provider ${nonce}`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9999/v1',
      });
      const runtime = await api.runtimes.create({
        name: `R5.2 ${role} LANGUAGE runtime ${nonce}`,
        providerId: provider.id,
        credentialId: null,
        modelId: `r52-language-${role.toLowerCase()}-${nonce.slice(0, 8)}`,
        executionProtocol: 'LANGUAGE',
      });
      if (runtime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.2 actors must use LANGUAGE runtimes');
      const teammate = await api.teammates.create({
        name: role === 'A' ? '观澜' : '明衡',
        avatar: null,
        title: `R5.2 ${role}`,
        description: 'Packaged Memory Pre-Gate fixture actor.',
        identityPrompt: `R5.2 sealed LANGUAGE identity ${role} ${nonce}`,
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
      const sealedRuntime = (await api.runtimes.list()).find(
        (item) => item.id === teammate.currentRuntimeProfileId,
      );
      if (!sealedRuntime || sealedRuntime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.2 sealed actor must use a LANGUAGE runtime');
      await api.capability.saveBenchmark({
        runtimeProfileId: sealedRuntime.id,
        modelAlias: sealedRuntime.modelId,
        dimension: 'GENERAL_REASONING',
        supported: true,
        normalizedScore: role === 'A' ? 80 : 60,
        rawScore: null,
        source: 'R5.2 deterministic fixture',
        benchmark: 'Acceptance fixture',
        benchmarkVersion: '1',
        snapshotDate: '2026-10-01T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
      return {
        role,
        teammateId: teammate.id,
        runtimeProfileId: sealedRuntime.id,
        executionProtocol: sealedRuntime.executionProtocol,
      };
    },
    { role, nonce },
  );
}

async function createConversation(page, teammateId) {
  return page.evaluate((id) => window.cultivation.chat.createConversation(id), teammateId);
}

async function sendAndWaitForMessages(page, input) {
  return page.evaluate(async ({ teammateId, conversationId, text, requestId }) => {
    const api = window.cultivation;
    const accepted = await api.chat.send({ requestId, teammateId, conversationId, text });
    if (accepted.requestId !== requestId || accepted.conversationId !== conversationId)
      throw new Error('R5.2 Chat request identity did not round-trip');
    const deadline = Date.now() + 10_000;
    let messages = [];
    while (Date.now() < deadline) {
      messages = await api.chat.listMessages({ teammateId, conversationId });
      const user = messages.find(
        (item) => item.role === 'USER' && item.actorType === 'USER' && item.content === text,
      );
      const assistant = messages.find((item) => item.role === 'ASSISTANT');
      if (user && assistant) {
        return {
          userMessage: {
            id: user.id,
            role: user.role,
            actorType: user.actorType,
            conversationId: user.conversationId,
            missionId: user.missionId,
            contentCharacters: user.content.length,
          },
          messageCount: messages.length,
        };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for persisted Chat messages');
  }, input);
}

async function proposeFromMessage(page, input) {
  return page.evaluate((value) => window.cultivation.memories.proposeFromMessage(value), input);
}

async function listUsage(page, teammateId) {
  return page.evaluate(async (id) => {
    const rows = await window.cultivation.usage.list(id);
    return rows
      .filter((item) => item.providerMetadata?.purpose === 'MEMORY_CANDIDATE_EXTRACTION')
      .map((item) => ({
        id: item.id,
        teammateId: item.teammateId,
        runtimeProfileId: item.runtimeProfileId,
        missionId: item.missionId,
        runId: item.runId,
      }));
  }, teammateId);
}

async function listMemories(page, teammateId) {
  return page.evaluate((id) => window.cultivation.memories.list(id), teammateId);
}

async function evaluateMainGate(app, input) {
  return app.evaluate(({ app }, value) => app.r52AcceptanceGate(value), input);
}

function assertGateReceipt(receipt, label) {
  assert.ok(receipt && typeof receipt === 'object', `${label} must return a receipt`);
  assert.ok(
    ['RUN_EXTRACTION', 'SKIP_EXTRACTION'].includes(receipt.decision),
    `${label} receipt must include a decision`,
  );
  assert.ok(
    ['JEV', 'DETERMINISTIC_FALLBACK'].includes(receipt.mode),
    `${label} receipt must include its routing mode`,
  );
  return receipt;
}

function safeReceipt(receipt) {
  const allowed = [
    'decision',
    'mode',
    'sourceType',
    'trigger',
    'policyVersion',
    'questionVersion',
    'ownerId',
    'sourceId',
    'confidence',
    'reason',
    'errorCode',
    'inputHash',
    'stateHash',
    'extractorInvoked',
    'candidateCount',
  ];
  return Object.fromEntries(
    allowed.filter((key) => Object.hasOwn(receipt, key)).map((key) => [key, receipt[key]]),
  );
}

function readObserver(profile) {
  const path = join(profile, 'r5-2-execution-facts.json');
  assert.ok(existsSync(path), 'Explicit R5.2 fixture must save bounded execution facts');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function databaseAudit(profile, actors, messages, expectedMemoryIds) {
  return openReadOnlyDatabase(profile, (db) => {
    const rows = db
      .prepare(
        `SELECT id, owner_type, owner_id, source_type, source_id,
                source_conversation_id, source_message_id, status, confirmed_at
         FROM memories WHERE id IN (?, ?) ORDER BY id`,
      )
      .all(...expectedMemoryIds);
    assert.equal(rows.length, expectedMemoryIds.length);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const primary = byId.get(expectedMemoryIds[0]);
    const fallback = byId.get(expectedMemoryIds[1]);
    assert.ok(primary && fallback);
    for (const row of rows) {
      assert.equal(row.owner_type, 'TEAMMATE');
      assert.equal(row.owner_id, actors.a.teammateId);
      assert.equal(row.source_type, 'CHAT_EXTRACTION');
      assert.equal(row.source_conversation_id, messages.conversationId);
      assert.equal(row.confirmed_at !== null, row.status === 'ACTIVE');
    }
    assert.equal(primary.source_message_id, messages.run.messageId);
    assert.equal(primary.status, 'ACTIVE', 'The explicitly accepted candidate must be ACTIVE');
    assert.equal(fallback.source_message_id, messages.fallback.messageId);
    assert.equal(fallback.status, 'PROPOSED', 'The fallback candidate remains reviewable');
    const skippedRows = db
      .prepare('SELECT id FROM memories WHERE source_message_id = ?')
      .all(messages.skip.messageId);
    assert.deepEqual(skippedRows, [], 'SKIP must not persist a Memory row');

    const usageRows = db
      .prepare(
        `SELECT teammate_id, runtime_profile_id, mission_id, run_id, provider_metadata_json
         FROM usage_records
         WHERE json_extract(provider_metadata_json, '$.purpose') = 'MEMORY_CANDIDATE_EXTRACTION'
         ORDER BY rowid`,
      )
      .all();
    assert.equal(usageRows.length, 2, 'Only RUN and fallback extraction create extraction usage');
    assert.ok(usageRows.every((row) => row.teammate_id === actors.a.teammateId));
    assert.ok(usageRows.every((row) => row.runtime_profile_id === actors.a.runtimeProfileId));
    assert.ok(usageRows.every((row) => row.mission_id === null && row.run_id === null));
    assert.ok(
      usageRows.every(
        (row) => JSON.parse(row.provider_metadata_json).purpose === 'MEMORY_CANDIDATE_EXTRACTION',
      ),
    );

    const userMessageRows = db
      .prepare(
        'SELECT id, conversation_id, actor_type, actor_id, role FROM messages WHERE id IN (?, ?, ?)',
      )
      .all(messages.run.messageId, messages.skip.messageId, messages.fallback.messageId);
    assert.equal(userMessageRows.length, 3);
    assert.ok(
      userMessageRows.every(
        (row) =>
          row.conversation_id === messages.conversationId &&
          row.actor_type === 'USER' &&
          row.actor_id === 'local-user' &&
          row.role === 'USER',
      ),
    );
    return {
      acceptedMemory: {
        id: primary.id,
        ownerId: primary.owner_id,
        sourceType: primary.source_type,
        sourceMessageId: primary.source_message_id,
        status: primary.status,
        confirmed: primary.confirmed_at !== null,
      },
      fallbackMemory: {
        id: fallback.id,
        ownerId: fallback.owner_id,
        sourceType: fallback.source_type,
        sourceMessageId: fallback.source_message_id,
        status: fallback.status,
      },
      skippedMemoryRows: skippedRows.length,
      extractionUsageRows: usageRows.length,
      usageRuntimeIds: [...new Set(usageRows.map((row) => row.runtime_profile_id))],
      userMessages: userMessageRows.map((row) => ({
        id: row.id,
        role: row.role,
        actorType: row.actor_type,
        actorId: row.actor_id,
      })),
    };
  });
}

let productionHashes;
let productionDatabase;
{
  const live = await launch(productionProfile);
  try {
    const { app, page } = live;
    const normal = await page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
      rendererGateType: typeof window.cultivation.r52AcceptanceGate,
    }));
    productionHashes = snapshotOfficialVersions(normal.versions);
    assert.equal(normal.routing.cloudEnabled, false);
    assert.equal(normal.rendererGateType, 'undefined', 'R5.2 compatibility gate must not be IPC');
    assert.equal(
      await app.evaluate(({ app }) => typeof app.r52AcceptanceGate),
      'undefined',
      'Normal production must not expose the Main-only acceptance fixture seam',
    );
    assert.equal(
      existsSync(join(productionProfile, 'r5-2-execution-facts.json')),
      false,
      'Normal production must not create R5.2 fixture evidence',
    );
  } finally {
    await live.app.close();
  }
}
productionDatabase = openReadOnlyDatabase(productionProfile, (db) => {
  const migrations = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version);
  assert.deepEqual(
    migrations,
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  return { migrations, r52EvidenceRows: 0 };
});

let fixtureHashes;
let actorA;
let actorB;
let chatFacts;
let memoryIds;
let compatibilityFacts;
let observer;
let fixtureDatabase;
{
  const live = await launch(fixtureProfile, [
    '--gate1-fake-model',
    '--r5-2-fixture',
    '--r4-fake-routing',
    '--w1-fake-workflow',
  ]);
  try {
    const { app, page } = live;
    const boot = await page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
      rendererGateType: typeof window.cultivation.r52AcceptanceGate,
    }));
    fixtureHashes = snapshotOfficialVersions(boot.versions, { requireFixture: true });
    assert.deepEqual(
      fixtureHashes,
      productionHashes,
      'Explicit fixtures must preserve all three official frozen Workflow hashes',
    );
    assert.equal(boot.routing.cloudEnabled, false);
    assert.equal(boot.rendererGateType, 'undefined', 'The test seam must stay out of Renderer IPC');
    assert.equal(
      await app.evaluate(({ app }) => typeof app.r52AcceptanceGate),
      'function',
      'Only explicit R5.2 fixture launch may expose the Main acceptance gate',
    );

    const fakeJevKey = `r52-fixture-jev-key-${nonce}`;
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), fakeJevKey);
    const imported = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
    assert.equal(imported.keySource, 'SAFE_STORAGE');
    assert.equal(imported.configured, true);
    assert.equal(JSON.stringify(imported).includes(fakeJevKey), false);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
    const cloud = await page.evaluate(() => window.cultivation.routing.setCloudEnabled(true));
    assert.equal(cloud.cloudEnabled, true, 'Jev requires explicit cloud routing opt-in');

    actorA = await seedActor(page, 'A');
    actorB = await seedActor(page, 'B');
    const conversation = await createConversation(page, actorA.teammateId);
    const runMessage = await sendAndWaitForMessages(page, {
      teammateId: actorA.teammateId,
      conversationId: conversation.id,
      text: durableText,
      requestId: randomUUID(),
    });
    assert.equal(runMessage.userMessage.role, 'USER');
    assert.equal(runMessage.userMessage.actorType, 'USER');
    assert.equal(runMessage.userMessage.missionId, null);

    const beforeRunUsage = await listUsage(page, actorA.teammateId);
    const runCandidates = await proposeFromMessage(page, {
      teammateId: actorA.teammateId,
      conversationId: conversation.id,
      messageId: runMessage.userMessage.id,
    });
    assert.equal(runCandidates.length, 1, 'A durable statement should invoke the fake extractor');
    assert.equal(runCandidates[0].ownerType, 'TEAMMATE');
    assert.equal(runCandidates[0].ownerId, actorA.teammateId);
    assert.equal(runCandidates[0].sourceType, 'CHAT_EXTRACTION');
    assert.equal(runCandidates[0].sourceConversationId, conversation.id);
    assert.equal(runCandidates[0].sourceMessageId, runMessage.userMessage.id);
    assert.equal(runCandidates[0].status, 'PROPOSED');
    const afterRunUsage = await listUsage(page, actorA.teammateId);
    assert.equal(afterRunUsage.length, beforeRunUsage.length + 1);

    const accepted = await page.evaluate(
      ({ teammateId, id }) => window.cultivation.memories.accept({ teammateId, id }),
      { teammateId: actorA.teammateId, id: runCandidates[0].id },
    );
    assert.equal(accepted.status, 'ACTIVE');
    assert.equal(accepted.ownerId, actorA.teammateId);

    const bList = await listMemories(page, actorB.teammateId);
    assert.equal(
      bList.some((item) => item.id === runCandidates[0].id),
      false,
      'Teammate B cannot list Teammate A’s candidate',
    );
    await assert.rejects(
      proposeFromMessage(page, {
        teammateId: actorB.teammateId,
        conversationId: conversation.id,
        messageId: runMessage.userMessage.id,
      }),
      undefined,
      'Teammate B cannot forge ownership of Teammate A’s Chat source',
    );
    await assert.rejects(
      page.evaluate(
        ({ teammateId, id }) => window.cultivation.memories.accept({ teammateId, id }),
        { teammateId: actorB.teammateId, id: runCandidates[0].id },
      ),
      undefined,
      'Teammate B cannot accept Teammate A’s Memory',
    );
    await assert.rejects(
      page.evaluate(
        ({ teammateId, id }) => window.cultivation.memories.reject({ teammateId, id }),
        { teammateId: actorB.teammateId, id: runCandidates[0].id },
      ),
      undefined,
      'Teammate B cannot reject Teammate A’s Memory',
    );

    const skipMessage = await sendAndWaitForMessages(page, {
      teammateId: actorA.teammateId,
      conversationId: conversation.id,
      text: skippedText,
      requestId: randomUUID(),
    });
    const beforeSkipUsage = await listUsage(page, actorA.teammateId);
    const beforeSkipMemories = await listMemories(page, actorA.teammateId);
    const skippedCandidates = await proposeFromMessage(page, {
      teammateId: actorA.teammateId,
      conversationId: conversation.id,
      messageId: skipMessage.userMessage.id,
    });
    assert.deepEqual(
      skippedCandidates,
      [],
      'A non-durable statement should return a normal empty result',
    );
    const afterSkipUsage = await listUsage(page, actorA.teammateId);
    const afterSkipMemories = await listMemories(page, actorA.teammateId);
    assert.equal(
      afterSkipUsage.length,
      beforeSkipUsage.length,
      'SKIP must not record extractor usage',
    );
    assert.equal(
      afterSkipMemories.length,
      beforeSkipMemories.length,
      'SKIP must not create a Memory row',
    );

    const freeMission = await page.evaluate(
      async ({ teammateId, nonce }) => {
        const api = window.cultivation;
        const created = await api.missions.create({
          title: 'R5.2 自由历练来源验收',
          objective: `Summarize a bounded completed mission result for deterministic pre-gate acceptance ${nonce}.`,
          coordinatorTeammateId: teammateId,
        });
        await api.missions.ready(created.id);
        return api.missions.start({ missionId: created.id, approvalFixture: false });
      },
      { teammateId: actorA.teammateId, nonce },
    );
    assert.equal(freeMission.mission.mode, 'SOLO');
    assert.equal(freeMission.mission.state, 'COMPLETED');
    const freeRun = freeMission.runs.at(-1);
    assert.ok(freeRun && freeRun.status === 'COMPLETED' && freeRun.resultText);

    const party = await page.evaluate(
      ({ aId, bId, nonce }) =>
        window.cultivation.parties.create({
          name: `R5.2 Party ${nonce}`,
          description: 'Two sealed LANGUAGE actors for a bounded source fact.',
          type: 'FIXED',
          coordinatorTeammateId: aId,
          memberTeammateIds: [aId, bId],
        }),
      { aId: actorA.teammateId, bId: actorB.teammateId, nonce },
    );
    const partyStarted = await page.evaluate(
      async ({ partyId, teammateId, nonce }) => {
        const api = window.cultivation;
        const created = await api.missions.create({
          title: 'R5.2 Party provenance验收',
          objective: `Survey comet observations and synthesize a concise report for R5.2 ${nonce}.`,
          coordinatorTeammateId: teammateId,
          partyId,
          mode: 'CONSULTATION',
        });
        await api.missions.ready(created.id);
        return api.missions.start({ missionId: created.id, approvalFixture: false });
      },
      { partyId: party.id, teammateId: actorA.teammateId, nonce },
    );
    assert.equal(partyStarted.mission.state, 'WAITING_COLLABORATION');
    const invitation = partyStarted.collaborations.find((item) => item.state === 'PENDING');
    assert.ok(invitation, 'The explicit Party fixture must produce a collaboration request');
    const partyDone = await page.evaluate(
      (requestId) =>
        window.cultivation.missions.resolveCollaboration({
          requestId,
          decision: 'APPROVED',
        }),
      invitation.id,
    );
    assert.equal(partyDone.mission.state, 'COMPLETED');
    const partyRun = partyDone.runs.at(-1);
    assert.ok(partyRun && partyRun.status === 'COMPLETED');
    const partyArtifact = partyDone.artifacts.find(
      (item) => item.runId === partyRun.id && item.teammateId === actorA.teammateId,
    );
    assert.ok(partyArtifact, 'The fixture must produce an A-owned durable collaboration artifact');
    const memberArtifact = partyDone.artifacts.find(
      (item) =>
        item.runId === partyRun.id &&
        item.teammateId === actorB.teammateId &&
        item.kind === 'MEMBER_RESULT',
    );
    assert.ok(memberArtifact, 'B must own its actually executed participant result');

    const workflowCreated = await page.evaluate(() =>
      window.cultivation.workflows.create({
        definitionId: 'w1-fixture-sequence',
        version: 1,
      }),
    );
    const workflowAdvance = await page.evaluate(
      (id) => window.cultivation.workflows.advance(id),
      workflowCreated.run.id,
    );
    assert.equal(workflowAdvance.run.state, 'COMPLETED');
    const workflowDone = await page.evaluate(
      (id) => window.cultivation.workflows.detail(id),
      workflowCreated.run.id,
    );
    assert.equal(workflowDone.run.state, 'COMPLETED');
    const reviewStep = workflowDone.steps
      .filter((item) => item.stepId === 'review' && item.state === 'COMPLETED')
      .sort((a, b) => b.attempt - a.attempt)[0];
    assert.ok(reviewStep?.missionId && reviewStep.missionRunId);
    assert.equal(reviewStep.state, 'COMPLETED');
    const workflowArtifact = workflowDone.artifacts.find(
      (item) =>
        item.producerStepRunId === reviewStep.id &&
        item.missionId === reviewStep.missionId &&
        item.missionRunId === reviewStep.missionRunId &&
        item.actorId === actorA.teammateId &&
        item.source === 'MISSION' &&
        ['TEXT', 'JSON'].includes(item.kind),
    );
    assert.ok(
      workflowArtifact,
      'The completed TASK/REVIEW fixture must have a bounded output artifact',
    );
    assert.ok(
      workflowDone.validations.some(
        (item) =>
          item.artifactId === workflowArtifact.id &&
          item.valid === true &&
          item.contentHash === workflowArtifact.contentHash,
      ),
      'The Workflow source must be a validated artifact produced by the completed review step',
    );
    const workflowMission = await page.evaluate(
      (id) => window.cultivation.missions.detail(id),
      reviewStep.missionId,
    );
    const workflowMissionRun = workflowMission.runs.find(
      (item) => item.id === reviewStep.missionRunId && item.status === 'COMPLETED',
    );
    assert.ok(workflowMissionRun);

    const beforeCompatibilityMemories = await listMemories(page, actorA.teammateId);
    const beforeCompatibilityExtractions = readObserver(fixtureProfile).extractions.length;
    const freeInput = {
      missionId: freeMission.mission.id,
      runId: freeRun.id,
      ownerId: actorA.teammateId,
      sourceId: freeRun.id,
    };
    const partyInput = {
      missionId: partyDone.mission.id,
      runId: partyRun.id,
      ownerId: actorA.teammateId,
      sourceId: partyArtifact.id,
    };
    const workflowInput = {
      missionId: workflowMission.mission.id,
      runId: workflowMissionRun.id,
      ownerId: actorA.teammateId,
      sourceId: workflowArtifact.id,
    };
    const freeReceipt = assertGateReceipt(await evaluateMainGate(app, freeInput), 'Free Mission');
    const partyReceipt = assertGateReceipt(
      await evaluateMainGate(app, partyInput),
      'Party Mission',
    );
    const workflowReceipt = assertGateReceipt(
      await evaluateMainGate(app, workflowInput),
      'Workflow Step',
    );
    const memberInput = { ...partyInput, ownerId: actorB.teammateId, sourceId: memberArtifact.id };
    const memberReceipt = assertGateReceipt(
      await evaluateMainGate(app, memberInput),
      'Party participant',
    );
    assert.equal(memberReceipt.ownerId, actorB.teammateId);
    await assert.rejects(
      evaluateMainGate(app, { ...memberInput, ownerId: actorA.teammateId }),
      undefined,
      'Coordinator cannot claim participant evidence ownership',
    );
    assert.equal(freeReceipt.extractorInvoked, undefined);
    assert.equal(partyReceipt.extractorInvoked, undefined);
    assert.equal(workflowReceipt.extractorInvoked, undefined);

    await assert.rejects(
      evaluateMainGate(app, { ...freeInput, ownerId: actorB.teammateId }),
      undefined,
      'Free Mission context must reject a forged owner',
    );
    await assert.rejects(
      evaluateMainGate(app, { ...partyInput, sourceId: `missing-${nonce}` }),
      undefined,
      'Party context must reject an unrelated source artifact',
    );
    await assert.rejects(
      evaluateMainGate(app, { ...workflowInput, runId: freeRun.id }),
      undefined,
      'Workflow context must reject a Run from another Mission',
    );

    const fallbackCloud = await page.evaluate(() =>
      window.cultivation.routing.setCloudEnabled(false),
    );
    assert.equal(fallbackCloud.cloudEnabled, false);
    const fallbackMessage = await sendAndWaitForMessages(page, {
      teammateId: actorA.teammateId,
      conversationId: conversation.id,
      text: fallbackText,
      requestId: randomUUID(),
    });
    const beforeFallbackUsage = await listUsage(page, actorA.teammateId);
    const fallbackCandidates = await proposeFromMessage(page, {
      teammateId: actorA.teammateId,
      conversationId: conversation.id,
      messageId: fallbackMessage.userMessage.id,
    });
    assert.equal(
      fallbackCandidates.length,
      1,
      'Local deterministic fallback must invoke the fake extractor',
    );
    assert.equal(fallbackCandidates[0].status, 'PROPOSED');
    const afterFallbackUsage = await listUsage(page, actorA.teammateId);
    assert.equal(afterFallbackUsage.length, beforeFallbackUsage.length + 1);

    const afterCompatibilityMemories = await listMemories(page, actorA.teammateId);
    observer = readObserver(fixtureProfile);
    assert.equal(
      observer.extractions.length,
      beforeCompatibilityExtractions + 1,
      'Mission and Workflow compatibility gates must not invoke the extractor',
    );
    assert.equal(
      afterCompatibilityMemories.length,
      beforeCompatibilityMemories.length + 1,
      'Mission and Workflow compatibility gates must not write Memory rows',
    );
    assert.equal(
      observer.extractions.length,
      2,
      'Only the Jev RUN and fallback invoke the extractor',
    );
    assert.equal(
      observer.decisions.length,
      6,
      'Two Chat requests and four valid execution sources run the gateway',
    );
    assert.equal(
      observer.receipts.length,
      7,
      'Six gateway calls and one fallback each record a bounded receipt',
    );
    assert.equal(observer.receipts[0].decision === 'SKIP_EXTRACTION', false);
    assert.equal(observer.receipts[0].mode, 'JEV');
    assert.equal(observer.receipts[0].extractorInvoked, true);
    assert.equal(observer.receipts[0].candidateCount, 1);
    assert.equal(observer.receipts[1].decision, 'SKIP_EXTRACTION');
    assert.equal(observer.receipts[1].extractorInvoked, false);
    assert.equal(observer.receipts[1].candidateCount, 0);
    assert.equal(observer.receipts.at(-1).mode, 'DETERMINISTIC_FALLBACK');
    assert.equal(observer.receipts.at(-1).extractorInvoked, true);
    assert.equal(observer.receipts.at(-1).candidateCount, 1);
    assert.ok(
      observer.decisions.some(
        (item) => item.sourceType === 'CHAT_MESSAGE' && item.trigger === 'USER_EXPLICIT',
      ),
    );
    assert.ok(
      observer.decisions.some(
        (item) =>
          item.sourceType === 'MISSION_RESULT' &&
          item.trigger === 'HARNESS' &&
          item.executionFields.includes('objectiveSummary'),
      ),
      'Free and Party Mission contexts must expose bounded objective fields',
    );
    assert.ok(
      observer.decisions.some(
        (item) =>
          item.sourceType === 'WORKFLOW_STEP_RESULT' &&
          item.trigger === 'HARNESS' &&
          item.executionFields.includes('stepType') &&
          item.executionFields.includes('expectedOutputContract'),
      ),
      'Workflow context must expose Step type and output contract without history bodies',
    );
    assert.ok(observer.decisions.every((item) => item.privateSentinelPresent === false));
    assert.ok(
      observer.decisions.every((item) => item.stateBytes <= 4_096 && Array.isArray(item.stateKeys)),
      'Pre-gate decisions must use bounded fact summaries',
    );
    const observerJson = JSON.stringify(observer);
    for (const body of [durableText, skippedText, fallbackText])
      assert.equal(
        observerJson.includes(body),
        false,
        'Observer facts must never persist raw Chat bodies',
      );

    chatFacts = {
      conversationId: conversation.id,
      run: {
        messageId: runMessage.userMessage.id,
        role: runMessage.userMessage.role,
        contentCharacters: runMessage.userMessage.contentCharacters,
        contentHash: hashText(durableText),
        returnedCandidateIds: [runCandidates[0].id],
        acceptedStatus: accepted.status,
      },
      skip: {
        messageId: skipMessage.userMessage.id,
        role: skipMessage.userMessage.role,
        contentCharacters: skipMessage.userMessage.contentCharacters,
        contentHash: hashText(skippedText),
        candidateCount: skippedCandidates.length,
        extractionUsageCountBefore: beforeSkipUsage.length,
        extractionUsageCountAfter: afterSkipUsage.length,
      },
      fallback: {
        messageId: fallbackMessage.userMessage.id,
        role: fallbackMessage.userMessage.role,
        contentCharacters: fallbackMessage.userMessage.contentCharacters,
        contentHash: hashText(fallbackText),
        candidateIds: [fallbackCandidates[0].id],
        usageCountBefore: beforeFallbackUsage.length,
        usageCountAfter: afterFallbackUsage.length,
      },
      actorIsolation: {
        teammateBListedCandidateA: false,
        teammateBCouldForgeChatOwner: false,
        teammateBCouldAcceptCandidateA: false,
        teammateBCouldRejectCandidateA: false,
      },
    };
    memoryIds = [runCandidates[0].id, fallbackCandidates[0].id];
    compatibilityFacts = {
      sources: [
        {
          kind: 'FREE_SOLO_MISSION',
          missionId: freeMission.mission.id,
          runId: freeRun.id,
          sourceId: freeRun.id,
          receipt: safeReceipt(freeReceipt),
        },
        {
          kind: 'PARTY_COLLABORATION_ARTIFACT',
          missionId: partyDone.mission.id,
          runId: partyRun.id,
          sourceId: partyArtifact.id,
          ownerId: actorA.teammateId,
          artifactKind: partyArtifact.kind,
          receipt: safeReceipt(partyReceipt),
        },
        {
          kind: 'PARTY_PARTICIPANT_ARTIFACT',
          missionId: partyDone.mission.id,
          runId: partyRun.id,
          sourceId: memberArtifact.id,
          ownerId: actorB.teammateId,
          artifactKind: memberArtifact.kind,
          receipt: safeReceipt(memberReceipt),
        },
        {
          kind: 'WORKFLOW_VALIDATED_STEP_ARTIFACT',
          workflowRunId: workflowDone.run.id,
          stepRunId: reviewStep.id,
          missionId: workflowMission.mission.id,
          runId: workflowMissionRun.id,
          sourceId: workflowArtifact.id,
          artifactKind: workflowArtifact.kind,
          contentHash: workflowArtifact.contentHash,
          receipt: safeReceipt(workflowReceipt),
        },
      ],
      invalidInputsRejected: { forgedOwner: true, unrelatedSource: true, wrongRun: true },
      extractorCallsBefore: beforeCompatibilityExtractions,
      extractorCallsAfter: observer.extractions.length,
      memoryRowsBefore: beforeCompatibilityMemories.length,
      memoryRowsAfter: afterCompatibilityMemories.length,
      extractorInvoked: false,
      memoryRowsCreated: 0,
    };
  } finally {
    await live.app.close();
  }
}

assert.equal(
  existsSync(join(productionProfile, 'r5-2-execution-facts.json')),
  false,
  'Normal production must not leave fixture evidence after shutdown',
);
assert.equal(
  existsSync(join(fixtureProfile, 'r5-2-execution-facts.json')),
  true,
  'Explicit fixture mode must write its bounded observer file',
);
fixtureDatabase = databaseAudit(
  fixtureProfile,
  { a: actorA, b: actorB },
  {
    conversationId: chatFacts.conversationId,
    run: { messageId: chatFacts.run.messageId },
    skip: { messageId: chatFacts.skip.messageId },
    fallback: { messageId: chatFacts.fallback.messageId },
  },
  memoryIds,
);
const fixtureMigrations = assertMigrations(fixtureProfile);
const productionMigrations = assertMigrations(productionProfile);
assert.deepEqual(productionMigrations, fixtureMigrations);

const serializedObserver = JSON.stringify(observer);
for (const body of [durableText, skippedText, fallbackText])
  assert.equal(serializedObserver.includes(body), false);
assert.equal(JSON.stringify(chatFacts).includes(durableText), false);
assert.equal(JSON.stringify(chatFacts).includes(skippedText), false);
assert.equal(JSON.stringify(chatFacts).includes(fallbackText), false);

mkdirSync(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, 'facts.json');
const evidence = {
  verifiedAt: new Date().toISOString(),
  schemaVersion: 32,
  production: {
    normalLaunch: true,
    mainAcceptanceGate: false,
    rendererAcceptanceIpc: false,
    fixtureEvidenceFile: false,
    officialWorkflowHashes: productionHashes,
    database: productionDatabase,
  },
  fixture: {
    flags: ['--gate1-fake-model', '--r5-2-fixture', '--r4-fake-routing', '--w1-fake-workflow'],
    officialWorkflowHashes: fixtureHashes,
    officialHashesUnchanged: hash(productionHashes) === hash(fixtureHashes),
    actors: [actorA, actorB],
    chat: chatFacts,
    compatibility: compatibilityFacts,
    decisions: observer.decisions.map((item) => ({
      decisionType: item.decisionType,
      policyVersion: item.policyVersion,
      questionVersion: item.questionVersion,
      stateHash: item.stateHash,
      stateBytes: item.stateBytes,
      stateKeys: item.stateKeys,
      sourceType: item.sourceType,
      trigger: item.trigger,
      messageRole: item.messageRole,
      evidence: item.evidence,
      executionFields: item.executionFields,
      executionHash: item.executionHash,
      privateSentinelPresent: item.privateSentinelPresent,
    })),
    extractions: observer.extractions,
    receipts: observer.receipts.map(safeReceipt),
    database: fixtureDatabase,
    migrations: fixtureMigrations,
  },
};
const evidenceJson = JSON.stringify(evidence);
for (const body of [durableText, skippedText, fallbackText])
  assert.equal(
    evidenceJson.includes(body),
    false,
    'Evidence file must not contain Chat or Memory bodies',
  );
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`R5_2_PACKAGED_EVIDENCE ${evidencePath}`);
console.log(
  `R5_2_PACKAGED_SMOKE_OK production=normal_fixture_free chat=jev_run_skip fallback=deterministic party=owner_scoped workflow=validated_artifact no_auto_extraction=true evidence=${evidencePath}`,
);
