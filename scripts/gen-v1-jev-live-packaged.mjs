import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';
import { capturePackagedWindow } from './gen-v1-capture.mjs';

// Explicit, fixture-free packaged Jev acceptance. The fixed profile, write-ahead
// facts and stable Mission titles let a later invocation recover without making
// a second Mission or resubmitting a completed run.
const root = process.cwd();
const profile = join(root, '.test-data', 'gen-v1-live', 'production-profile');
const evidenceDir = join(root, 'docs', 'evidence', 'gen-v1-live-software-v2', 'packaged');
const evidencePath = join(evidenceDir, 'jev-facts.json');
const databasePath = join(profile, 'data', 'cultivation.sqlite');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const workspaceRoot = join(root, '.test-data', 'gen-v1-live', 'jev-workspace');
const workspaceFile = join(workspaceRoot, 'acceptance-brief.txt');
const keysPath = join(root, 'private', 'keys.txt');
const API_MART_BASE_URL = 'https://api.apimart.ai/v1';
const API_MART_MODEL = 'gpt-4.1-nano-2025-04-14';
const JEV_MODEL = 'jev-1.13.0';
const API_MART_CREDENTIAL_LABEL = 'GEN V1 Jev live acceptance';
const ACTOR_NAME = 'GEN V1 Jev 语言验收';
const ACTOR_RUNTIME_NAME = 'GEN V1 Jev API Mart LANGUAGE';
const R3_MISSION_TITLE = 'LIVE-JEV-R3-SDK-contract-v2-630dfb89029a';
const MAIN_MISSION_TITLE = 'LIVE-JEV-R4-R5-630dfb89029a';
const SKILL_NAME = 'LIVE-JEV-R5 concise evidence summary';
const PREFERENCE_TEXT = 'I prefer concise bullet summaries.';
const WORKSPACE_TEXT =
  'Acceptance note: the release cadence is weekly and the review set has four observations.\n';
const MAIN_OBJECTIVE =
  'Use the read-only workspace tool to read acceptance-brief.txt. Summarize its note in exactly two concise bullet points, honoring the user’s saved answer-format preference.';
const SCREENSHOT_WIDTHS = [1440, 1180, 900];
const MAX_WAIT_MS = 15 * 60_000;

let app;
let page;
let facts;
let keyValues;

function emptyFacts() {
  return {
    baseline: '630dfb89029aa8fb359048d547d861bb35b1b721',
    schemaVersion: 1,
    runId: randomUUID(),
    status: 'RUNNING',
    productionFakeFlags: false,
    languageModel: API_MART_MODEL,
    runtimeParameters: 'NOT_EXPOSED_BY_CURRENT_TYPED_IPC',
    cases: {
      r3: { status: 'NOT_STARTED', observations: [] },
      r52: { status: 'NOT_STARTED' },
      r4r5: { status: 'NOT_STARTED' },
    },
    screenshots: [],
    restartVerified: false,
  };
}

async function loadFacts() {
  if (!existsSync(evidencePath)) return emptyFacts();
  const existing = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(existing.baseline, '630dfb89029aa8fb359048d547d861bb35b1b721');
  assert.equal(existing.schemaVersion, 1);
  assert.equal(existing.productionFakeFlags, false);
  assert.ok(existing.cases && existing.screenshots);
  return existing;
}

async function saveFacts() {
  facts.updatedAt = new Date().toISOString();
  const serialized = `${JSON.stringify(facts, null, 2)}\n`;
  for (const secret of keyValues ?? []) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /https?:\/\//iu, 'Evidence must not contain provider URLs');
  assert.equal(serialized.includes(PREFERENCE_TEXT), false, 'Evidence must not contain raw Memory');
  await mkdir(evidenceDir, { recursive: true });
  const temporaryPath = `${evidencePath}.tmp`;
  await writeFile(temporaryPath, serialized, 'utf8');
  await rename(temporaryPath, evidencePath);
}

function openDatabase() {
  assert.ok(existsSync(databasePath), 'Packaged profile database is missing');
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function readMissionEvents(missionId) {
  const db = openDatabase();
  try {
    return db
      .prepare(
        `SELECT id, run_id AS runId, event_type AS eventType, actor_id AS actorId, payload_json AS payloadJson
         FROM mission_events WHERE mission_id = ? ORDER BY rowid`,
      )
      .all(missionId)
      .map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) }));
  } finally {
    db.close();
  }
}

function readAudit(action, targetId = null) {
  const db = openDatabase();
  try {
    const rows =
      targetId === null
        ? db
            .prepare(
              'SELECT id, action, target_id AS targetId, actor_id AS actorId, payload_json AS payloadJson, created_at AS createdAt FROM audit_events WHERE action = ? ORDER BY created_at, id',
            )
            .all(action)
        : db
            .prepare(
              'SELECT id, action, target_id AS targetId, actor_id AS actorId, payload_json AS payloadJson, created_at AS createdAt FROM audit_events WHERE action = ? AND target_id = ? ORDER BY created_at, id',
            )
            .all(action, targetId);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) }));
  } finally {
    db.close();
  }
}

function safeErrorName(error) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : 'Error';
}

async function launch() {
  assert.ok(existsSync(executablePath), 'Packaged desktop executable is missing');
  await mkdir(profile, { recursive: true });
  const tempPath = join(profile, 'tmp');
  await mkdir(tempPath, { recursive: true });
  process.env.TEMP = tempPath;
  process.env.TMP = tempPath;
  process.env.TMPDIR = tempPath;
  app = await electron.launch({
    executablePath,
    args: [
      '--proxy-server=http://127.0.0.1:7890',
      `--disk-cache-dir=${join(profile, 'http-cache')}`,
    ],
    env: {
      ...process.env,
      CULTIVATION_USER_DATA_DIR: profile,
      TEMP: tempPath,
      TMP: tempPath,
      TMPDIR: tempPath,
    },
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
}

async function importJevKey() {
  if (
    facts.jev?.authenticatedCheck === 'PASS' &&
    (await page.evaluate(() => window.cultivation.r3.getConfig())).configured
  )
    return;
  await app.evaluate(({ clipboard }, key) => clipboard.writeText(key), keyValues[2]);
  const result = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
  assert.equal(result.configured, true);
  assert.equal(result.keySource, 'SAFE_STORAGE');
  assert.equal(JSON.stringify(result).includes(keyValues[2]), false);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
  const connection = await page.evaluate(() => window.cultivation.r3.testConnection());
  assert.equal(connection.ok, true, 'Authenticated Jev model check must pass before live tasks');
  assert.equal(connection.model, JEV_MODEL);
  facts.jev = { model: JEV_MODEL, keySource: result.keySource, authenticatedCheck: 'PASS' };
  await saveFacts();
}

async function ensureApiMartActor() {
  const provider = await page.evaluate(
    async ({ baseUrl }) => {
      const api = window.cultivation;
      const providers = await api.providers.list();
      return (
        providers.find((item) => item.kind === 'OPENAI_COMPATIBLE' && item.baseUrl === baseUrl) ??
        (await api.providers.create({
          name: 'API Mart Jev live acceptance',
          kind: 'OPENAI_COMPATIBLE',
          baseUrl,
        }))
      );
    },
    { baseUrl: API_MART_BASE_URL },
  );

  let credentials = await page.evaluate(
    (providerId) => window.cultivation.credentials.list(providerId),
    provider.id,
  );
  let credential = credentials.find((item) => item.label === API_MART_CREDENTIAL_LABEL);
  if (!credential) {
    await app.evaluate(({ clipboard }, key) => clipboard.writeText(key), keyValues[0]);
    credential = await page.evaluate(
      ({ providerId, label }) => window.cultivation.credentials.create({ providerId, label }),
      { providerId: provider.id, label: API_MART_CREDENTIAL_LABEL },
    );
    assert.equal(JSON.stringify(credential).includes(keyValues[0]), false);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
    credentials = await page.evaluate(
      (providerId) => window.cultivation.credentials.list(providerId),
      provider.id,
    );
    credential = credentials.find((item) => item.id === credential.id);
  }
  assert.ok(credential && !('apiKey' in credential) && !('ciphertext' in credential));

  let runtime = await page.evaluate(
    ({ providerId, modelId, name }) =>
      window.cultivation.runtimes
        .list()
        .then((items) =>
          items.find(
            (item) =>
              item.providerId === providerId && item.modelId === modelId && item.name === name,
          ),
        ),
    { providerId: provider.id, modelId: API_MART_MODEL, name: ACTOR_RUNTIME_NAME },
  );
  if (!runtime) {
    runtime = await page.evaluate((input) => window.cultivation.runtimes.create(input), {
      name: ACTOR_RUNTIME_NAME,
      providerId: provider.id,
      credentialId: credential.id,
      modelId: API_MART_MODEL,
      executionProtocol: 'LANGUAGE',
    });
  }
  assert.equal(runtime.executionProtocol, 'LANGUAGE');
  assert.equal(runtime.modelId, API_MART_MODEL);
  assert.equal(runtime.credentialId, credential.id);
  let teammate = await page.evaluate(
    (name) =>
      window.cultivation.teammates.list().then((items) => items.find((item) => item.name === name)),
    ACTOR_NAME,
  );
  if (!teammate) {
    const connection = await page.evaluate(
      (id) => window.cultivation.runtimes.testConnection(id),
      runtime.id,
    );
    assert.equal(
      connection.ok,
      true,
      'API Mart model identity check must pass before creating the sealed actor',
    );
    teammate = await page.evaluate(
      ({ name, runtimeProfileId }) =>
        window.cultivation.teammates.create({
          name,
          avatar: null,
          title: 'Jev packaged acceptance',
          description: 'Bounded production-language acceptance actor.',
          identityPrompt: 'Use concise, evidence-grounded answers.',
          behaviorPrompt: '',
          currentRuntimeProfileId: runtimeProfileId,
        }),
      { name: ACTOR_NAME, runtimeProfileId: runtime.id },
    );
  }
  const sealedRuntime = await page.evaluate(
    (id) =>
      window.cultivation.runtimes.list().then((items) => items.find((item) => item.id === id)),
    teammate.currentRuntimeProfileId,
  );
  assert.ok(sealedRuntime);
  assert.equal(sealedRuntime.executionProtocol, 'LANGUAGE');
  assert.equal(sealedRuntime.modelId, API_MART_MODEL);
  assert.equal(sealedRuntime.providerId, provider.id);
  assert.equal(sealedRuntime.credentialId, credential.id);

  await page.evaluate(
    async ({ runtimeProfileId, modelAlias }) => {
      const api = window.cultivation;
      const existing = (await api.capability.benchmarks(runtimeProfileId)).find(
        (item) =>
          item.dimension === 'GENERAL_REASONING' && item.supported && item.normalizedScore === 80,
      );
      if (!existing || !existing.supported || existing.normalizedScore !== 80) {
        await api.capability.saveBenchmark({
          runtimeProfileId,
          modelAlias,
          dimension: 'GENERAL_REASONING',
          supported: true,
          normalizedScore: 80,
          rawScore: null,
          source: 'Live packaged acceptance configuration',
          benchmark: 'Configured routing capability',
          benchmarkVersion: '1',
          snapshotDate: '2026-10-11T00:00:00.000Z',
          sourceUrl: null,
          provenanceType: 'USER_ESTIMATE',
        });
      }
    },
    { runtimeProfileId: sealedRuntime.id, modelAlias: sealedRuntime.modelId },
  );
  await page.evaluate(() =>
    window.cultivation.r2.setCapability({ dimension: 'GENERAL_REASONING', enabled: true }),
  );
  facts.actor = {
    teammateId: teammate.id,
    runtimeProfileId: sealedRuntime.id,
    providerKind: 'OPENAI_COMPATIBLE',
    modelId: API_MART_MODEL,
    executionProtocol: 'LANGUAGE',
  };
  await saveFacts();
  return teammate;
}

async function findMissionByTitle(title) {
  const matches = await page.evaluate(
    (value) =>
      window.cultivation.missions
        .list()
        .then((items) => items.filter((item) => item.title === value)),
    title,
  );
  assert.ok(matches.length <= 1, `Duplicate stable Mission title: ${title}`);
  return matches[0] ?? null;
}

async function ensureR3ShadowMission(teammateId) {
  let mission = await findMissionByTitle(R3_MISSION_TITLE);
  const configBefore = await page.evaluate(() => window.cultivation.r3.getConfig());
  assert.equal(configBefore.configured, true);
  if (!mission) {
    if (!configBefore.enabled) await page.evaluate(() => window.cultivation.r3.setEnabled(true));
    facts.cases.r3.createIntent = true;
    await saveFacts();
    mission = await page.evaluate(
      ({ title, teammateId }) =>
        window.cultivation.missions.create({
          title,
          objective:
            'Assess a short bounded analysis task while preserving its explicitly assigned coordinator.',
          coordinatorTeammateId: teammateId,
        }),
      { title: R3_MISSION_TITLE, teammateId },
    );
    facts.cases.r3.missionId = mission.id;
    facts.cases.r3.status = 'MISSION_CREATED';
    await saveFacts();
  } else {
    facts.cases.r3.missionId = mission.id;
    await saveFacts();
  }

  const deadline = Date.now() + 120_000;
  let observations = [];
  while (Date.now() < deadline) {
    observations = await page.evaluate(
      (id) => window.cultivation.r3.listObservations(id),
      mission.id,
    );
    if (observations.length >= 4) break;
    await delay(2_000);
  }
  const expected = ['COLLABORATION_NEED', 'REVIEW_NEED', 'TASK_CAPABILITY', 'TEAMMATE_FIT'];
  assert.deepEqual(
    observations.map((item) => item.decisionType).sort(),
    expected,
    'R3 must persist all four independent Jev shadow decisions for the stable draft Mission',
  );
  assert.ok(observations.every((item) => item.status === 'SUCCESS' && item.model === JEV_MODEL));
  const details = await page.evaluate((id) => window.cultivation.missions.detail(id), mission.id);
  assert.equal(details.mission.state, 'DRAFT', 'R3 Shadow must not change Mission control flow');
  assert.equal(details.mission.coordinatorTeammateId, teammateId);
  const db = openDatabase();
  try {
    const persisted = db
      .prepare(
        `SELECT a.id AS attemptId, a.decision_type AS decisionType, a.status,
                a.receipt_id AS receiptId, r.state_hash AS stateHash,
                r.policy_version AS policyVersion, r.question_version AS questionVersion,
                r.provider, r.model
         FROM decision_shadow_attempts AS a
         LEFT JOIN decision_receipts AS r ON r.id = a.receipt_id
         WHERE a.mission_id = ? ORDER BY a.decision_type`,
      )
      .all(mission.id);
    assert.equal(persisted.length, 4);
    assert.deepEqual(
      persisted.map((item) => item.decisionType),
      expected,
    );
    assert.ok(
      persisted.every(
        (item) =>
          item.status === 'SUCCESS' &&
          item.receiptId &&
          item.provider === 'TYPESAFE' &&
          item.model === JEV_MODEL &&
          /^[a-f0-9]{64}$/u.test(item.stateHash) &&
          typeof item.policyVersion === 'string' &&
          typeof item.questionVersion === 'string',
      ),
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM decision_shadow_attempts WHERE mission_id = ?')
        .get(mission.id).count,
      4,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM decision_receipts WHERE mission_id = ? AND mode = 'SHADOW'",
        )
        .get(mission.id).count,
      4,
    );
    facts.cases.r3.observations = persisted.map((item) => ({ ...item }));
  } finally {
    db.close();
  }
  facts.cases.r3.status = 'PASS';
  facts.cases.r3.missionId = mission.id;
  facts.cases.r3.missionState = details.mission.state;
  await saveFacts();
  await page.evaluate(() => window.cultivation.r3.setEnabled(false));
  facts.cases.r3.independentSwitchDisabledAfterEvidence = true;
  await saveFacts();
}

async function ensurePreferenceConversation(teammateId) {
  const memoryFacts = (facts.cases.r52 ??= { status: 'NOT_STARTED' });
  let conversations = await page.evaluate(
    (id) => window.cultivation.chat.listConversations(id),
    teammateId,
  );
  let conversation = memoryFacts.conversationId
    ? conversations.find((item) => item.id === memoryFacts.conversationId)
    : null;
  if (!conversation && memoryFacts.conversationCreateIntent) {
    const before = new Set(memoryFacts.conversationIdsBefore ?? []);
    const userMessageConversations = [];
    for (const candidate of conversations) {
      const messages = await page.evaluate(
        ({ teammateId, conversationId }) =>
          window.cultivation.chat.listMessages({ teammateId, conversationId }),
        { teammateId, conversationId: candidate.id },
      );
      if (messages.some((item) => item.role === 'USER' && item.content === PREFERENCE_TEXT))
        userMessageConversations.push(candidate);
    }
    if (userMessageConversations.length === 1) conversation = userMessageConversations[0];
    else {
      const newConversations = conversations.filter((item) => !before.has(item.id));
      if (newConversations.length === 1) conversation = newConversations[0];
      else if (newConversations.length > 1) throw new Error('CONVERSATION_RECOVERY_AMBIGUOUS');
    }
  }
  if (!conversation) {
    memoryFacts.conversationIdsBefore = conversations.map((item) => item.id);
    memoryFacts.conversationCreateIntent = true;
    await saveFacts();
    conversation = await page.evaluate(
      (id) => window.cultivation.chat.createConversation(id),
      teammateId,
    );
  }
  memoryFacts.conversationId = conversation.id;
  await saveFacts();

  let messages = await page.evaluate(
    ({ teammateId, conversationId }) =>
      window.cultivation.chat.listMessages({ teammateId, conversationId }),
    { teammateId, conversationId: conversation.id },
  );
  let userMessage = messages.find(
    (item) => item.role === 'USER' && item.content === PREFERENCE_TEXT,
  );
  assert.ok(
    messages.filter((item) => item.role === 'USER' && item.content === PREFERENCE_TEXT).length <= 1,
    'The durable preference chat message must not be duplicated',
  );
  if (!userMessage) {
    memoryFacts.chatRequestId ??= randomUUID();
    memoryFacts.chatSendIntent = true;
    await saveFacts();
    await page.evaluate(
      ({ requestId, teammateId, conversationId, text }) =>
        window.cultivation.chat.send({ requestId, teammateId, conversationId, text }),
      {
        requestId: memoryFacts.chatRequestId,
        teammateId,
        conversationId: conversation.id,
        text: PREFERENCE_TEXT,
      },
    );
  }
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    messages = await page.evaluate(
      ({ teammateId, conversationId }) =>
        window.cultivation.chat.listMessages({ teammateId, conversationId }),
      { teammateId, conversationId: conversation.id },
    );
    userMessage = messages.find((item) => item.role === 'USER' && item.content === PREFERENCE_TEXT);
    const assistant = messages.find((item) => item.role === 'ASSISTANT');
    if (userMessage && assistant) break;
    await delay(1_000);
  }
  assert.ok(userMessage, 'The preference statement must persist as a Chat USER message');
  assert.ok(
    messages.some((item) => item.role === 'ASSISTANT'),
    'Chat reply did not persist',
  );
  memoryFacts.userMessageId = userMessage.id;
  memoryFacts.chatMessageCharacters = userMessage.content.length;
  await saveFacts();
  return { conversationId: conversation.id, userMessageId: userMessage.id };
}

function preGateAuditForMessage(messageId) {
  const matches = readAudit('memory.pre_gate', messageId);
  assert.ok(matches.length <= 1, 'The one Chat message must have at most one pre-gate audit');
  return matches[0] ?? null;
}

async function extractorUsageIds(teammateId) {
  const rows = await page.evaluate(
    (id) =>
      window.cultivation.usage
        .list(id)
        .then((items) =>
          items
            .filter((item) => item.providerMetadata?.purpose === 'MEMORY_CANDIDATE_EXTRACTION')
            .map((item) => item.id),
        ),
    teammateId,
  );
  return rows;
}

async function ensureExtractedOrFallbackMemory(teammateId, message) {
  const memoryFacts = facts.cases.r52;
  memoryFacts.extractorUsageIdsBefore ??= await extractorUsageIds(teammateId);
  await saveFacts();
  let memories = await page.evaluate((id) => window.cultivation.memories.list(id), teammateId);
  let candidate = memories.find((item) => item.sourceMessageId === message.userMessageId);
  if (!candidate && !memoryFacts.proposalIntent) {
    memoryFacts.proposalIntent = true;
    memoryFacts.proposeCalled = true;
    await saveFacts();
    const proposed = await page.evaluate(
      (input) =>
        window.cultivation.memories.proposeFromMessage({
          teammateId: input.teammateId,
          conversationId: input.conversationId,
          messageId: input.messageId,
        }),
      {
        teammateId,
        conversationId: message.conversationId,
        messageId: message.userMessageId,
      },
    );
    assert.ok(Array.isArray(proposed));
    memories = await page.evaluate((id) => window.cultivation.memories.list(id), teammateId);
    candidate = memories.find((item) => item.sourceMessageId === message.userMessageId);
    const gateAudit = preGateAuditForMessage(message.userMessageId);
    if (gateAudit) {
      memoryFacts.preGate = {
        auditId: gateAudit.id,
        sourceId: gateAudit.targetId,
        ownerId: gateAudit.actorId,
        mode: gateAudit.payload.mode,
        decision: gateAudit.payload.decision,
        confidence: gateAudit.payload.confidence,
        stateHash: gateAudit.payload.stateHash,
        policyVersion: gateAudit.payload.policyVersion,
        questionVersion: gateAudit.payload.questionVersion,
        reason: gateAudit.payload.reason,
        errorCode: gateAudit.payload.errorCode,
        extractorInvoked: gateAudit.payload.extractorInvoked,
        candidateCount: gateAudit.payload.candidateCount,
      };
    }
    memoryFacts.proposedCandidateCount = proposed.length;
    memoryFacts.proposedCandidateIds = proposed.map((item) => item.id);
    await saveFacts();
  } else {
    const gateAudit = preGateAuditForMessage(message.userMessageId);
    if (gateAudit && !memoryFacts.preGate) {
      memoryFacts.preGate = {
        auditId: gateAudit.id,
        sourceId: gateAudit.targetId,
        ownerId: gateAudit.actorId,
        mode: gateAudit.payload.mode,
        decision: gateAudit.payload.decision,
        confidence: gateAudit.payload.confidence,
        stateHash: gateAudit.payload.stateHash,
        policyVersion: gateAudit.payload.policyVersion,
        questionVersion: gateAudit.payload.questionVersion,
        reason: gateAudit.payload.reason,
        errorCode: gateAudit.payload.errorCode,
        extractorInvoked: gateAudit.payload.extractorInvoked,
        candidateCount: gateAudit.payload.candidateCount,
      };
    }
    memoryFacts.proposedCandidateCount ??= memoryFacts.preGate?.candidateCount ?? 0;
    memoryFacts.proposedCandidateIds ??= candidate ? [candidate.id] : [];
  }

  const gate = memoryFacts.preGate;
  assert.ok(gate, 'A durable Main pre-gate receipt must exist for proposeFromMessage');
  assert.equal(gate.mode, 'JEV', 'R5.2 live evidence must come from real Jev');
  assert.equal(gate.ownerId, teammateId);
  assert.equal(gate.sourceId, message.userMessageId);
  assert.ok(/^[a-f0-9]{64}$/u.test(gate.stateHash));
  assert.equal(
    gate.extractorInvoked,
    gate.decision === 'RUN_EXTRACTION',
    'The real extractor must agree with the persisted Jev RUN/SKIP decision',
  );
  assert.equal(gate.candidateCount, memoryFacts.proposedCandidateCount ?? 0);

  const beforeUsageIds = new Set(memoryFacts.extractorUsageIdsBefore);
  const usageIds = await extractorUsageIds(teammateId);
  const currentExtractionUsage = usageIds.filter((id) => !beforeUsageIds.has(id));
  assert.equal(currentExtractionUsage.length > 0, gate.extractorInvoked);
  memoryFacts.extractorUsageIds = currentExtractionUsage;

  if (candidate?.status === 'PROPOSED') {
    candidate = await page.evaluate(
      ({ teammateId, id }) => window.cultivation.memories.accept({ teammateId, id }),
      { teammateId, id: candidate.id },
    );
  }
  if (candidate?.status === 'ACTIVE') {
    memoryFacts.activeMemoryId = candidate.id;
    memoryFacts.activeMemorySource = 'CHAT_EXTRACTION_ACCEPTED';
  } else {
    const safeSummary = 'Jev live preference for concise answers';
    let fallback = memories.find(
      (item) =>
        item.status === 'ACTIVE' &&
        item.ownerId === teammateId &&
        item.memoryType === 'PREFERENCE' &&
        item.summary === safeSummary,
    );
    if (!fallback) {
      memoryFacts.fallbackMemoryCreateIntent = true;
      await saveFacts();
      fallback = await page.evaluate(
        ({ teammateId, content, summary }) =>
          window.cultivation.memories.create({
            teammateId,
            memoryType: 'PREFERENCE',
            content,
            summary,
            importance: 0.9,
          }),
        { teammateId, content: PREFERENCE_TEXT, summary: safeSummary },
      );
    }
    assert.equal(fallback.status, 'ACTIVE');
    memoryFacts.activeMemoryId = fallback.id;
    memoryFacts.activeMemorySource = candidate
      ? 'EXISTING_ACTIVE_PREFERENCE'
      : 'USER_CREATED_FALLBACK';
  }
  memoryFacts.status = 'PASS';
  await saveFacts();
  return memoryFacts.activeMemoryId;
}

async function ensureWorkspace() {
  await mkdir(workspaceRoot, { recursive: true });
  if (existsSync(workspaceFile)) {
    const current = await readFile(workspaceFile, 'utf8');
    assert.equal(current, WORKSPACE_TEXT, 'The stable test workspace file has unexpected contents');
  } else {
    await writeFile(workspaceFile, WORKSPACE_TEXT, 'utf8');
  }
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, workspaceRoot);
  const workspace = await page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  assert.equal(workspace.rootPath, workspaceRoot);
  const builtins = await page.evaluate(() => window.cultivation.tools.listBuiltins());
  const builtinIds = builtins.map((item) => item.id).sort();
  assert.deepEqual(builtinIds, [
    'file.createDirectory',
    'file.list',
    'file.readText',
    'file.writeText',
  ]);
  facts.workspace = { selected: true, builtinToolCount: builtinIds.length };
  await saveFacts();
}

async function ensureSkill(teammateId) {
  let skill = await page.evaluate(
    (name) =>
      window.cultivation.skills.list().then((items) => items.find((item) => item.name === name)),
    SKILL_NAME,
  );
  if (!skill) {
    skill = await page.evaluate(
      ({ name }) =>
        window.cultivation.skills.create({
          name,
          description: 'Bounded format guidance for short evidence summaries.',
          instructions:
            'For evidence summaries, cite only supplied facts and use concise bullet points.',
          tags: ['live-acceptance'],
        }),
      { name: SKILL_NAME },
    );
  }
  assert.equal(skill.status, 'ACTIVE');
  let assignments = await page.evaluate(
    (id) => window.cultivation.skills.listAssignments(id),
    teammateId,
  );
  let assignment = assignments.find((item) => item.skillId === skill.id);
  if (!assignment) {
    assignment = await page.evaluate(
      ({ teammateId, skillId }) => window.cultivation.skills.assign({ teammateId, skillId }),
      { teammateId, skillId: skill.id },
    );
  }
  if (!assignment.enabled)
    assignment = await page.evaluate(
      ({ teammateId, skillId }) =>
        window.cultivation.skills.setEnabled({ teammateId, skillId, enabled: true }),
      { teammateId, skillId: skill.id },
    );
  facts.skill = {
    skillId: skill.id,
    teammateId,
    status: skill.status,
    enabled: assignment.enabled,
  };
  await saveFacts();
  return skill.id;
}

async function ensureRoutedMission(teammateId) {
  let mission = await findMissionByTitle(MAIN_MISSION_TITLE);
  let receipt;
  if (!mission) {
    facts.cases.r4r5.routeCreateIntent = true;
    facts.cases.r4r5.status = 'ROUTE_CREATE_INTENT';
    await saveFacts();
    const result = await page.evaluate(
      ({ title, objective }) =>
        window.cultivation.routing.createMission({
          title,
          context: {
            objective,
            requiredCapabilities: ['GENERAL_REASONING'],
            executionConstraint: 'SOLO',
          },
        }),
      { title: MAIN_MISSION_TITLE, objective: MAIN_OBJECTIVE },
    );
    assert.equal(result.status, 'CREATED', `R4 routing returned ${result.reason ?? result.status}`);
    mission = result.mission;
    receipt = result.receipt;
    facts.cases.r4r5.missionId = mission.id;
    facts.cases.r4r5.routeReceiptId = receipt.id;
    facts.cases.r4r5.assignmentKind = receipt.assignment?.kind ?? null;
    facts.cases.r4r5.decisionSignals = receipt.decisionSignals.map((item) => ({
      type: item.type,
      status: item.status,
      recommendation: item.recommendation,
      requestHash: item.requestHash,
      policyVersion: item.policyVersion,
      questionVersion: item.questionVersion,
      errorCode: item.errorCode,
    }));
    await saveFacts();
  } else {
    facts.cases.r4r5.missionId = mission.id;
    const receipts = await page.evaluate(
      (id) => window.cultivation.routing.receipts(id),
      mission.id,
    );
    assert.equal(
      receipts.length,
      1,
      'Stable R4 Mission must have exactly one durable routing receipt',
    );
    receipt = receipts[0];
    facts.cases.r4r5.routeReceiptId = receipt.id;
    facts.cases.r4r5.assignmentKind = receipt.assignment?.kind ?? null;
    facts.cases.r4r5.decisionSignals = receipt.decisionSignals.map((item) => ({
      type: item.type,
      status: item.status,
      recommendation: item.recommendation,
      requestHash: item.requestHash,
      policyVersion: item.policyVersion,
      questionVersion: item.questionVersion,
      errorCode: item.errorCode,
    }));
    await saveFacts();
  }
  assert.equal(receipt.outcome, 'ASSIGNED');
  assert.equal(receipt.assignment?.kind, 'SOLO');
  assert.equal(receipt.assignment?.coordinatorTeammateId, teammateId);
  assert.ok(
    receipt.decisionSignals.some(
      (item) =>
        item.type === 'TEAMMATE_FIT' &&
        ['ACCEPTED', 'IGNORED'].includes(item.status) &&
        !item.errorCode,
    ),
    'R4 must retain a successful bounded real Jev signal; the deterministic confidence guard may ignore it',
  );
  assert.equal(
    receipt.decisionSignals.some((item) => item.status === 'UNAVAILABLE'),
    false,
  );
  await page.evaluate(() => window.cultivation.routing.setCloudEnabled(true));
  const refreshed = await page.evaluate((id) => window.cultivation.missions.detail(id), mission.id);
  if (refreshed.mission.state === 'DRAFT')
    await page.evaluate((id) => window.cultivation.missions.ready(id), mission.id);
  facts.cases.r4r5.status = 'ROUTED_SOLO';
  await saveFacts();
  return mission;
}

async function driveMissionOnce(missionId) {
  const mainFacts = facts.cases.r4r5;
  const deadline = Date.now() + MAX_WAIT_MS;
  let detail = await page.evaluate((id) => window.cultivation.missions.detail(id), missionId);
  while (Date.now() < deadline) {
    const state = detail.mission.state;
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED') return detail;
    if (state === 'DRAFT') {
      await page.evaluate((id) => window.cultivation.missions.ready(id), missionId);
      detail = await page.evaluate((id) => window.cultivation.missions.detail(id), missionId);
      continue;
    }
    if (state === 'READY') {
      mainFacts.startIntent = true;
      await saveFacts();
      detail = await page.evaluate(
        (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
        missionId,
      );
      continue;
    }
    if (state === 'WAITING_APPROVAL') {
      const approval = detail.approvals?.find((item) => item.state === 'PENDING');
      if (!approval) {
        await delay(2_000);
        detail = await page.evaluate((id) => window.cultivation.missions.detail(id), missionId);
        continue;
      }
      assert.equal(approval.capability, 'FILE_READ');
      mainFacts.approvalIntentIds ??= [];
      if (!mainFacts.approvalIntentIds.includes(approval.id)) {
        mainFacts.approvalIntentIds.push(approval.id);
        await saveFacts();
      }
      detail = await page.evaluate(
        ({ approvalId }) =>
          window.cultivation.missions.resolveApproval({ approvalId, decision: 'APPROVED' }),
        { approvalId: approval.id },
      );
      continue;
    }
    if (state === 'RUNNING') {
      await delay(2_000);
      detail = await page.evaluate((id) => window.cultivation.missions.detail(id), missionId);
      continue;
    }
    throw new Error(`UNEXPECTED_MISSION_STATE_${state}`);
  }
  throw new Error('MISSION_WAIT_TIMEOUT_NO_RETRY');
}

async function ensureRerankMission(teammateId) {
  const title = 'LIVE-JEV-R5-3-focused-memory-630dfb89029a';
  let mission = await page.evaluate(
    async ({ title, teammateId, objective }) =>
      (await window.cultivation.missions.list()).find((value) => value.title === title) ??
      window.cultivation.missions.create({
        title,
        objective,
        coordinatorTeammateId: teammateId,
        partyId: null,
        mode: 'SOLO',
      }),
    { title, teammateId, objective: PREFERENCE_TEXT },
  );
  facts.cases.r53 ??= {};
  facts.cases.r53.missionId = mission.id;
  await saveFacts();
  const detail = await driveMissionOnce(mission.id);
  assert.equal(detail.mission.state, 'COMPLETED');
  facts.cases.r53.runId = detail.runs.at(-1).id;
  await saveFacts();
}

function verifyPersistentEvidence(missionId, teammateId, memoryId, skillId) {
  const completedRunId = facts.cases.r4r5.runIds.at(-1);
  const events = readMissionEvents(missionId).filter((value) => value.runId === completedRunId);
  const skillSelections = events.filter((item) => item.eventType === 'skill.selection');
  const memorySelections = readMissionEvents(facts.cases.r53.missionId).filter(
    (item) => item.eventType === 'memory.prompt_selection' && item.runId === facts.cases.r53.runId,
  );
  const toolSelections = events.filter((item) => item.eventType === 'tool.selection');
  const advisories = events.filter((item) => item.eventType === 'completion.advisory');
  const skillSelection = skillSelections.find((item) => item.actorId === teammateId);
  assert.ok(skillSelection, 'R5.1 must persist a production skill.selection event');
  assert.equal(skillSelection.payload.mode, 'JEV');
  assert.ok(skillSelection.payload.candidateIds.includes(skillId));
  assert.ok(skillSelection.payload.selectedSkillIds.includes(skillId));
  assert.ok(/^[a-f0-9]{64}$/u.test(skillSelection.payload.inputHash));

  const promptSelection = memorySelections.find((item) => item.actorId === teammateId);
  assert.ok(promptSelection, 'R5.3 must persist the actual final prompt memory selection');
  assert.ok(promptSelection.payload.memoryIds.includes(memoryId));
  assert.ok(/^[a-f0-9]{64}$/u.test(promptSelection.payload.sectionHash));
  assert.ok(promptSelection.runId);

  const rerank = readAudit('memory.rerank')
    .filter(
      (item) =>
        item.actorId === teammateId &&
        item.payload.mode === 'JEV' &&
        item.payload.candidateIds?.includes(memoryId) &&
        item.payload.selectedIds?.includes(memoryId),
    )
    .at(-1);
  assert.ok(rerank, 'R5.3 must persist a real Jev rerank receipt that feeds the final prompt');
  assert.ok(/^[a-f0-9]{64}$/u.test(rerank.payload.stateHash));
  assert.ok(/^[a-f0-9]{64}$/u.test(rerank.payload.queryHash));

  const toolSelection = toolSelections.find(
    (item) => item.actorId === teammateId && item.payload.mode === 'JEV',
  );
  assert.ok(toolSelection, 'R5.4 must persist a real Jev tool.selection receipt');
  assert.ok(toolSelection.payload.eligibleIds.length > 0);
  assert.ok(toolSelection.payload.offeredIds.length > 0);
  assert.ok(
    toolSelection.payload.runId === undefined ||
      toolSelection.payload.runId === toolSelection.runId,
  );
  assert.ok(
    events.some(
      (item) =>
        item.eventType === 'model.call_started' &&
        item.runId === toolSelection.runId &&
        item.actorId === teammateId,
    ),
    'The tool shortlist must precede the actor model call on the same Mission run',
  );
  const offeredToolProposals = events.filter(
    (item) =>
      item.eventType === 'tool.proposed' &&
      item.actorId === teammateId &&
      toolSelection.payload.offeredIds.includes(item.payload.toolId),
  );
  assert.ok(
    offeredToolProposals.length > 0,
    'A real model proposal must reference a tool in the persisted Jev offered set',
  );

  const advisory = advisories.find(
    (item) => item.actorId === teammateId && item.payload.mode === 'JEV',
  );
  assert.ok(advisory, 'R5.5 must persist a real Jev completion.advisory event');
  assert.ok(/^[a-f0-9]{64}$/u.test(advisory.payload.objectiveHash));
  assert.ok(/^[a-f0-9]{64}$/u.test(advisory.payload.resultHash));
  assert.ok(/^[a-f0-9]{64}$/u.test(advisory.payload.stateHash));

  const promptAudit = readAudit('memory.prompt_selection', facts.cases.r53.missionId).find(
    (item) => item.payload.runId === promptSelection.runId,
  );
  assert.ok(promptAudit, 'The prompt selection must also have its durable Main audit row');
  assert.deepEqual(promptAudit.payload.memoryIds, promptSelection.payload.memoryIds);
  assert.equal(promptAudit.payload.sectionHash, promptSelection.payload.sectionHash);

  return {
    missionId,
    runId: completedRunId,
    memoryMissionId: facts.cases.r53.missionId,
    memoryRunId: promptSelection.runId,
    skillSelection: {
      eventId: skillSelection.id,
      actorId: skillSelection.actorId,
      mode: skillSelection.payload.mode,
      inputHash: skillSelection.payload.inputHash,
      candidateIds: skillSelection.payload.candidateIds,
      selectedSkillIds: skillSelection.payload.selectedSkillIds,
    },
    memoryRerank: {
      auditId: rerank.id,
      mode: rerank.payload.mode,
      stateHash: rerank.payload.stateHash,
      queryHash: rerank.payload.queryHash,
      baselineIds: rerank.payload.baselineIds,
      candidateIds: rerank.payload.candidateIds,
      orderedIds: rerank.payload.orderedIds,
      selectedIds: rerank.payload.selectedIds,
    },
    promptSelection: {
      eventId: promptSelection.id,
      auditId: promptAudit.id,
      runId: promptSelection.runId,
      memoryIds: promptSelection.payload.memoryIds,
      sectionHash: promptSelection.payload.sectionHash,
    },
    toolSelection: {
      eventId: toolSelection.id,
      runId: toolSelection.runId,
      mode: toolSelection.payload.mode,
      eligibleIds: toolSelection.payload.eligibleIds,
      candidateIds: toolSelection.payload.candidateIds,
      offeredIds: toolSelection.payload.offeredIds,
      matchingModelToolProposals: offeredToolProposals.map((item) => ({
        eventId: item.id,
        toolId: item.payload.toolId,
        runId: item.runId,
      })),
    },
    completionAdvisory: {
      eventId: advisory.id,
      runId: advisory.runId,
      mode: advisory.payload.mode,
      phase: advisory.payload.phase,
      disposition: advisory.payload.disposition,
      objectiveHash: advisory.payload.objectiveHash,
      resultHash: advisory.payload.resultHash,
      stateHash: advisory.payload.stateHash,
      policyVersion: advisory.payload.policyVersion,
      questionVersion: advisory.payload.questionVersion,
    },
  };
}

async function ensureMainMission(teammateId, memoryId, skillId) {
  let mission = await ensureRoutedMission(teammateId);
  const detailBefore = await page.evaluate(
    (id) => window.cultivation.missions.detail(id),
    mission.id,
  );
  if (
    detailBefore.mission.state === 'FAILED' &&
    facts.cases.r4r5.explicitTransportRetryIntent &&
    !facts.cases.r4r5.explicitJsonModeCorrectionRetryIntent
  ) {
    const previousRun = detailBefore.runs.at(-1);
    const toolFacts = readMissionEvents(mission.id).filter(
      (event) => event.runId === previousRun.id && event.eventType === 'tool.result',
    );
    assert.equal(previousRun.errorCode, 'MODEL_CALL_FAILED');
    assert.equal(toolFacts.length, 0, 'Never replay an uncertain Tool side effect');
    // One explicit new attempt after fixing the SDK/compatible endpoint JSON
    // mode mismatch. Failed historical attempts remain unchanged.
    facts.cases.r4r5.explicitJsonModeCorrectionRetryIntent = true;
    facts.cases.r4r5.failedJsonModeRunId = previousRun.id;
    await saveFacts();
    await page.evaluate(
      (id) => window.cultivation.missions.retry({ missionId: id, approvalFixture: false }),
      mission.id,
    );
    return ensureMainMission(teammateId, memoryId, skillId);
  }
  if (detailBefore.mission.state === 'FAILED' && !facts.cases.r4r5.explicitTransportRetryIntent) {
    const previousRun = detailBefore.runs.at(-1);
    const toolFacts = readMissionEvents(mission.id).filter(
      (event) => event.runId === previousRun.id && event.eventType === 'tool.result',
    );
    assert.equal(previousRun.errorCode, 'MODEL_CALL_FAILED');
    assert.equal(toolFacts.length, 0, 'Never retry an uncertain external Tool side effect');
    facts.cases.r4r5.explicitTransportRetryIntent = true;
    facts.cases.r4r5.failedOriginalRunId = previousRun.id;
    await saveFacts();
    await page.evaluate(
      (id) => window.cultivation.missions.retry({ missionId: id, approvalFixture: false }),
      mission.id,
    );
    return ensureMainMission(teammateId, memoryId, skillId);
  }
  if (['DRAFT', 'READY', 'RUNNING', 'WAITING_APPROVAL'].includes(detailBefore.mission.state)) {
    facts.cases.r4r5.status = 'MISSION_IN_PROGRESS';
    await saveFacts();
    const detail = await driveMissionOnce(mission.id);
    assert.equal(detail.mission.state, 'COMPLETED', `R4/R5 Mission ended ${detail.mission.state}`);
    facts.cases.r4r5.missionState = detail.mission.state;
    facts.cases.r4r5.runIds = detail.runs.map((item) => item.id);
    await saveFacts();
  } else {
    assert.equal(detailBefore.mission.state, 'COMPLETED');
  }
  mission = await page.evaluate((id) => window.cultivation.missions.detail(id), mission.id);
  assert.equal(mission.mission.coordinatorTeammateId, teammateId);
  assert.equal(mission.mission.mode, 'SOLO');
  assert.equal(mission.mission.state, 'COMPLETED');
  const routeEvents = readMissionEvents(mission.mission.id).filter(
    (item) => item.eventType === 'routing.assigned',
  );
  assert.equal(routeEvents.length, 1, 'The SOLO assignment must have one durable route event');
  assert.equal(routeEvents[0].payload.receiptId, facts.cases.r4r5.routeReceiptId);
  const proof = verifyPersistentEvidence(mission.mission.id, teammateId, memoryId, skillId);
  facts.cases.r4r5.status = 'PASS';
  facts.cases.r4r5.missionState = mission.mission.state;
  facts.cases.r4r5.persistence = proof;
  facts.cases.r4r5.assignment = {
    receiptId: facts.cases.r4r5.routeReceiptId,
    kind: facts.cases.r4r5.assignmentKind,
    coordinatorTeammateId: teammateId,
    routeEventId: routeEvents[0].id,
  };
  await saveFacts();
  return mission;
}

async function captureThreeWidths() {
  const window = await app.browserWindow(page);
  for (const width of SCREENSHOT_WIDTHS) {
    await window.evaluate(
      (browserWindow, nextWidth) => browserWindow.setContentSize(nextWidth, 900),
      width,
    );
    await page.setViewportSize({ width, height: 900 });
    await delay(200);
    const filename = `jev-home-${width}.png`;
    await capturePackagedWindow(app, page, join(evidenceDir, filename));
    if (!facts.screenshots.includes(filename)) facts.screenshots.push(filename);
  }
  await saveFacts();
}

async function verifyAfterRestart(missionId, r3MissionId, teammateId) {
  await app.close();
  app = null;
  await launch();
  const config = await page.evaluate(async () => ({
    r3: await window.cultivation.r3.getConfig(),
    routing: await window.cultivation.routing.config(),
  }));
  assert.equal(config.r3.enabled, false, 'R3 shadow switch must remain independent and disabled');
  assert.equal(config.routing.cloudEnabled, true, 'R4/R5 Jev opt-in must persist after restart');
  const r3Observations = await page.evaluate(
    (id) => window.cultivation.r3.listObservations(id),
    r3MissionId,
  );
  assert.equal(r3Observations.length, 4);
  assert.ok(r3Observations.every((item) => item.status === 'SUCCESS'));
  const details = await page.evaluate((id) => window.cultivation.missions.detail(id), missionId);
  assert.equal(details.mission.state, 'COMPLETED');
  assert.equal(details.mission.coordinatorTeammateId, teammateId);
  assert.equal(details.mission.mode, 'SOLO');
  const receipts = await page.evaluate((id) => window.cultivation.routing.receipts(id), missionId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, facts.cases.r4r5.routeReceiptId);
  const eventsAfterRestart = readMissionEvents(missionId);
  assert.equal(
    eventsAfterRestart.filter((item) => item.eventType === 'routing.assigned').length,
    1,
  );
  assert.equal(
    eventsAfterRestart.filter((item) => item.eventType === 'run.completed').length,
    1,
    'Restart must not replay the completed Mission',
  );
  facts.restartVerified = true;
  facts.cases.r3.restartObservationCount = r3Observations.length;
  facts.cases.r4r5.restartMissionState = details.mission.state;
  await saveFacts();
}

async function main() {
  assert.equal(
    process.argv.length,
    2,
    'This production harness accepts no fake-model flags or stage overrides',
  );
  await mkdir(evidenceDir, { recursive: true });
  facts = await loadFacts();
  const keyLines = (await readFile(keysPath, 'utf8'))
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .map((value) => value.trim());
  assert.ok(keyLines.length >= 4 && keyLines[0] && keyLines[2]);
  assert.equal(/[\s]/u.test(keyLines[0]), false);
  assert.equal(/[\s]/u.test(keyLines[2]), false);
  keyValues = keyLines.slice(0, 4);
  await saveFacts();
  await launch();
  await importJevKey();
  const teammate = await ensureApiMartActor();
  await ensureR3ShadowMission(teammate.id);
  await page.evaluate(() => window.cultivation.routing.setCloudEnabled(true));

  const message = await ensurePreferenceConversation(teammate.id);
  facts.cases.r52.conversationId = message.conversationId;
  facts.cases.r52.userMessageId = message.userMessageId;
  await saveFacts();
  const memoryId = await ensureExtractedOrFallbackMemory(teammate.id, message);
  await ensureWorkspace();
  const skillId = await ensureSkill(teammate.id);
  await ensureRerankMission(teammate.id);
  const mainMission = await ensureMainMission(teammate.id, memoryId, skillId);
  facts.status = 'POST_RESTART_VERIFICATION';
  await saveFacts();
  await verifyAfterRestart(mainMission.mission.id, facts.cases.r3.missionId, teammate.id);
  await captureThreeWidths();
  facts.status = 'PASS';
  facts.completedAt = new Date().toISOString();
  await saveFacts();
  console.log(
    `LIVE_JEV_PACKAGED_OK r3=4-shadow-decisions r4=solo r5.1=skill r5.2=pre-gate-and-extractor r5.3=rerank-and-prompt-selection r5.4=offered-tool-proposal r5.5=completion-advisory restart=verified screenshots=${facts.screenshots.length}`,
  );
}

try {
  await main();
} catch (error) {
  if (facts) {
    facts.status = 'BLOCKED';
    facts.failureType = safeErrorName(error);
    facts.failureLocation =
      typeof error?.stack === 'string'
        ? error.stack
            .split('\n')
            .filter((line) => line.includes('gen-v1-jev-live-packaged.mjs'))
            .slice(0, 3)
        : [];
    await saveFacts().catch(() => undefined);
  }
  console.error(`LIVE_JEV_PACKAGED_BLOCKED failure=${safeErrorName(error)}`);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
}
