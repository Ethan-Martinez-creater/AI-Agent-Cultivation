import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';

const root = process.cwd();
const nonce = randomUUID();
const profileRoot = join(root, '.test-data', `r5-3-packaged-${nonce}`);
const productionProfile = join(profileRoot, 'production');
const fixtureProfile = join(profileRoot, 'fixture');
const evidenceDir = join(root, 'docs', 'evidence', 'r5-3-memory-rerank', nonce);
const fixtureFactsPath = join(fixtureProfile, 'r5-3-execution-facts.json');
const productionFactsPath = join(productionProfile, 'r5-3-execution-facts.json');
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
const mainQuery = 'release migration handoff';
const reversedQuery = [...mainQuery].reverse().join('');
const soloObjective = `Analyze comet orbital observations and produce a concise spectral report ${nonce}.`;
const partyObjective = `Survey lunar crater shadow observations and synthesize a concise terrain report ${nonce}.`;
const memoryTextSentinels = [
  `PRIVATE_INSTRUCTIONS_SENTINEL_${nonce}`,
  `FILE_BODY_SENTINEL_${nonce}`,
  `HISTORY_SENTINEL_${nonce}`,
];
const rerankBudgets = {
  maxShortlist: 12,
  finalTopK: 6,
  maxQueryCharacters: 600,
  maxQueryBytes: 1_200,
  maxCandidateTextCharacters: 240,
  maxCandidateTextBytes: 720,
  maxStateBytes: 11_000,
  maxRequestBytes: 16_000,
  maxResponseBytes: 8_192,
};

assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);
assert.equal(
  existsSync(profileRoot),
  false,
  'Each R5.3 smoke run needs a fresh project-local profile',
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
  assert.ok(
    profile === productionProfile || profile === fixtureProfile,
    'Database audit is limited to this run’s isolated packaged profiles',
  );
  const path = join(profile, 'data', 'cultivation.sqlite');
  assert.ok(existsSync(path), `Expected packaged profile database at ${path}`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function updateFixtureMemory(memoryId, statement, ...parameters) {
  assert.ok(typeof memoryId === 'string' && memoryId.length > 0);
  const dbPath = join(fixtureProfile, 'data', 'cultivation.sqlite');
  assert.ok(existsSync(dbPath), 'Fixture-only status setup requires the isolated fixture database');
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    return db.prepare(statement).run(...parameters, memoryId);
  } finally {
    db.close();
  }
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

function databaseMemoryCount(profile) {
  return openReadOnlyDatabase(
    profile,
    (db) => db.prepare('SELECT COUNT(*) AS count FROM memories').get().count,
  );
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

async function seedActor(page, role) {
  return page.evaluate(
    async ({ role, nonce }) => {
      const api = window.cultivation;
      const provider = await api.providers.create({
        name: `R5.3 ${role} offline LANGUAGE provider ${nonce}`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9999/v1',
      });
      const runtime = await api.runtimes.create({
        name: `R5.3 ${role} LANGUAGE runtime ${nonce}`,
        providerId: provider.id,
        credentialId: null,
        modelId: `r53-language-${role.toLowerCase()}-${nonce.slice(0, 8)}`,
        executionProtocol: 'LANGUAGE',
      });
      if (runtime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.3 actors must use LANGUAGE runtimes');
      const teammate = await api.teammates.create({
        name: role === 'A' ? '观澜' : '明衡',
        avatar: null,
        title: `R5.3 ${role}`,
        description: 'Packaged Memory Rerank fixture actor.',
        identityPrompt: `R5.3 sealed LANGUAGE identity ${role} ${nonce}`,
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
      const sealedRuntime = (await api.runtimes.list()).find(
        (item) => item.id === teammate.currentRuntimeProfileId,
      );
      if (!sealedRuntime || sealedRuntime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.3 sealed actor must use a LANGUAGE runtime');
      await api.capability.saveBenchmark({
        runtimeProfileId: sealedRuntime.id,
        modelAlias: sealedRuntime.modelId,
        dimension: 'GENERAL_REASONING',
        supported: true,
        normalizedScore: role === 'A' ? 80 : 60,
        rawScore: null,
        source: 'R5.3 deterministic fixture',
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

async function createMemory(page, actor, input) {
  const memory = await page.evaluate(
    ({ teammateId, input }) => window.cultivation.memories.create({ teammateId, ...input }),
    { teammateId: actor.teammateId, input },
  );
  assert.equal(memory.ownerType, 'TEAMMATE');
  assert.equal(memory.ownerId, actor.teammateId);
  assert.equal(memory.status, 'ACTIVE');
  return memory;
}

async function createConversation(page, teammateId) {
  return page.evaluate((id) => window.cultivation.chat.createConversation(id), teammateId);
}

async function sendAndWaitForMessages(page, input) {
  return page.evaluate(async ({ teammateId, conversationId, text, requestId }) => {
    const api = window.cultivation;
    const accepted = await api.chat.send({ requestId, teammateId, conversationId, text });
    if (accepted.requestId !== requestId || accepted.conversationId !== conversationId)
      throw new Error('R5.3 Chat request identity did not round-trip');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const messages = await api.chat.listMessages({ teammateId, conversationId });
      const user = messages.find(
        (item) => item.role === 'USER' && item.actorType === 'USER' && item.content === text,
      );
      const assistant = messages.find(
        (item) => item.role === 'ASSISTANT' && item.conversationId === conversationId,
      );
      if (user && assistant)
        return {
          userMessageId: user.id,
          assistantMessageId: assistant.id,
          userCharacters: user.content.length,
          assistantCharacters: assistant.content.length,
        };
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for the packaged LANGUAGE Chat completion');
  }, input);
}

async function retrieveAcceptance(app, teammateId, query) {
  return app.evaluate(
    ({ app }, input) => app.r53AcceptanceRetrieve(input.teammateId, input.query),
    { teammateId, query },
  );
}

function readObserver(profile) {
  const path = join(profile, 'r5-3-execution-facts.json');
  assert.ok(existsSync(path), 'Explicit R5.3 fixture must save bounded execution facts');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safeReceipt(receipt) {
  const allowed = [
    'teammateId',
    'baselineIds',
    'orderedIds',
    'candidateIds',
    'selectedIds',
    'mode',
    'reason',
    'errorCode',
    'queryHash',
    'stateHash',
    'policyVersion',
    'questionVersion',
    'scores',
    'candidateTextFacts',
  ];
  return Object.fromEntries(
    allowed.filter((key) => Object.hasOwn(receipt, key)).map((key) => [key, receipt[key]]),
  );
}

function safeDecision(decision) {
  return {
    decisionType: decision.decisionType,
    stateHash: decision.stateHash,
    policyVersion: decision.policyVersion,
    questionVersion: decision.questionVersion,
    queryHash: decision.queryHash,
    stateFields: decision.stateFields,
    stateBytes: decision.stateBytes,
    requestBytes: decision.requestBytes,
    questionKeys: decision.questionKeys,
    candidates: decision.candidates,
    historyLeak: decision.historyLeak,
  };
}

function assertReceiptOwned(receipt, ownerIds) {
  assert.ok(Array.isArray(receipt.candidateIds));
  assert.ok(Array.isArray(receipt.selectedIds));
  assert.ok(receipt.selectedIds.length <= rerankBudgets.finalTopK);
  assert.ok(receipt.candidateIds.length <= rerankBudgets.maxShortlist);
  for (const id of [...receipt.candidateIds, ...receipt.selectedIds])
    assert.equal(ownerIds.get(id), receipt.teammateId, 'R5.3 receipt crossed a Teammate owner');
}

function assertDecisionBounds(observer, ownerIds) {
  for (const decision of observer.decisions) {
    assert.equal(decision.decisionType, 'MEMORY_RELEVANCE');
    assert.deepEqual([...decision.stateFields].sort(), ['candidates', 'query']);
    assert.ok(decision.stateBytes <= rerankBudgets.maxStateBytes);
    assert.ok(decision.requestBytes <= rerankBudgets.maxRequestBytes);
    assert.equal(decision.historyLeak, false);
    assert.ok(
      decision.candidates.length > 0 && decision.candidates.length <= rerankBudgets.maxShortlist,
    );
    for (const candidate of decision.candidates) {
      assert.deepEqual([...candidate.fields].sort(), ['id', 'memoryType', 'text']);
      assert.equal(ownerIds.get(candidate.id), candidate.ownerId);
      assert.ok(candidate.textCharacters <= rerankBudgets.maxCandidateTextCharacters);
      assert.ok(candidate.textBytes <= rerankBudgets.maxCandidateTextBytes);
    }
  }
}

function assertModelCallsOwned(modelCalls, ownerIds) {
  for (const call of modelCalls) {
    assert.ok(Array.isArray(call.finalPromptMemoryIds));
    assert.ok(Array.isArray(call.memoryOwners));
    assert.deepEqual(
      call.memoryOwners,
      call.finalPromptMemoryIds.map((id) => ownerIds.get(id)),
    );
    assert.ok(call.memoryOwners.every((ownerId) => ownerId === call.teammateId));
  }
}

function assertRetrievalSegment(observer, startIndex, teammateId, ownerIds) {
  const receipts = observer.retrievals.slice(startIndex);
  const owned = receipts.filter((receipt) => receipt.teammateId === teammateId);
  assert.ok(owned.length > 0, `Expected a real LANGUAGE retrieval for ${teammateId}`);
  for (const receipt of receipts) assertReceiptOwned(receipt, ownerIds);
  return owned;
}

let productionHashes;
let productionMigrations;
{
  const live = await launch(productionProfile);
  try {
    const { app, page } = live;
    const normal = await page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
      rendererAcceptanceRetrieve: typeof window.cultivation.r53AcceptanceRetrieve,
    }));
    productionHashes = snapshotOfficialVersions(normal.versions);
    assert.equal(normal.routing.cloudEnabled, false);
    assert.equal(
      normal.rendererAcceptanceRetrieve,
      'undefined',
      'The Main-only R5.3 fixture seam must never be exposed through Renderer IPC',
    );
    assert.equal(
      await app.evaluate(({ app }) => typeof app.r53AcceptanceRetrieve),
      'undefined',
      'Normal production must not expose the Main-only R5.3 acceptance seam',
    );
    assert.equal(
      existsSync(productionFactsPath),
      false,
      'Normal production must not create R5.3 fixture evidence',
    );
  } finally {
    await live.app.close();
  }
}
productionMigrations = assertMigrations(productionProfile);

const fixtureArgs = [
  '--gate1-fake-model',
  '--r5-3-fixture',
  '--r5-2-fixture',
  '--r5-1-fixture',
  '--r4-fake-routing',
  '--w1-fake-workflow',
];
let fixtureHashes;
let actors;
let memories;
let baselineFacts;
let fallbackFacts;
let chatFacts;
let soloFacts;
let partyFacts;
let workflowFacts;
let observer;
let memoryCountBeforeRetrieval;
let memoryCountAfterRetrieval;
let fixtureMigrations;
let rawFixtureTexts;
const privacyScreenshots = [];
{
  const live = await launch(fixtureProfile, fixtureArgs);
  try {
    const { app, page } = live;
    const boot = await page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
      rendererAcceptanceRetrieve: typeof window.cultivation.r53AcceptanceRetrieve,
    }));
    fixtureHashes = snapshotOfficialVersions(boot.versions, { requireFixture: true });
    assert.deepEqual(
      fixtureHashes,
      productionHashes,
      'Explicit fixture launch must preserve all three official frozen Workflow hashes',
    );
    assert.equal(boot.routing.cloudEnabled, false);
    assert.equal(
      boot.rendererAcceptanceRetrieve,
      'undefined',
      'The R5.3 acceptance helper must remain Main-only',
    );
    assert.equal(
      await app.evaluate(({ app }) => typeof app.r53AcceptanceRetrieve),
      'function',
      'Only explicit R5.3 fixture launch may expose the Main acceptance helper',
    );

    const fakeJevKey = `r53-fixture-jev-key-${nonce}`;
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), fakeJevKey);
    const imported = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
    assert.equal(imported.keySource, 'SAFE_STORAGE');
    assert.equal(imported.configured, true);
    assert.equal(JSON.stringify(imported).includes(fakeJevKey), false);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
    const cloudOff = await page.evaluate(() => window.cultivation.routing.setCloudEnabled(false));
    assert.equal(cloudOff.cloudEnabled, false);

    const actorA = await seedActor(page, 'A');
    const actorB = await seedActor(page, 'B');
    actors = { a: actorA, b: actorB };
    assert.equal(actorA.executionProtocol, 'LANGUAGE');
    assert.equal(actorB.executionProtocol, 'LANGUAGE');

    const specs = [
      {
        key: 'aLexicalHeavy',
        owner: 'a',
        memoryType: 'FACT',
        content: `${mainQuery}. ${mainQuery}. ${mainQuery}. ${memoryTextSentinels[1]}`,
        summary: 'Routine observatory maintenance notes for the antenna array.',
        importance: 1,
      },
      {
        key: 'aSummaryRelevant',
        owner: 'a',
        memoryType: 'PREFERENCE',
        content: memoryTextSentinels[0],
        summary: 'Handoff notes for release planning.',
        importance: 0.2,
      },
      {
        key: 'aVectorHeavy',
        owner: 'a',
        memoryType: 'OBSERVATION',
        content: reversedQuery,
        summary: 'Unrelated notes about oceanic tidal cycles.',
        importance: 0.4,
      },
      {
        key: 'aIrrelevant',
        owner: 'a',
        memoryType: 'FACT',
        content: 'Quartz basalt canyon water sample catalog.',
        summary: 'Unrelated geological sample inventory.',
        importance: 0.3,
      },
      {
        key: 'aSoloMission',
        owner: 'a',
        memoryType: 'PROCEDURE',
        content: 'Use the calibrated comet observation worksheet for orbital reports.',
        summary: 'Comet orbital observations concise spectral report.',
        importance: 0.7,
      },
      {
        key: 'aPartyCoordinator',
        owner: 'a',
        memoryType: 'OBSERVATION',
        content: 'Coordinator notes about lunar crater shadows and terrain reports.',
        summary: 'Lunar crater shadow observations coordinator synthesis report.',
        importance: 0.7,
      },
      {
        key: 'aWorkflowStep',
        owner: 'a',
        memoryType: 'PROCEDURE',
        content: 'Review a workflow input artifact and return structured output.',
        summary: 'Workflow review input artifact structured JSON output contract.',
        importance: 0.7,
      },
      {
        key: 'bCrossOwner',
        owner: 'b',
        memoryType: 'FACT',
        content: mainQuery,
        summary: mainQuery,
        importance: 1,
      },
      {
        key: 'bPartyParticipant',
        owner: 'b',
        memoryType: 'OBSERVATION',
        content: 'Participant findings from lunar crater shadow observations.',
        summary: 'Lunar crater shadow observations participant findings report.',
        importance: 0.8,
      },
      {
        key: 'excludedProposed',
        owner: 'a',
        memoryType: 'FACT',
        content: mainQuery,
        summary: mainQuery,
        importance: 1,
      },
      {
        key: 'excludedArchived',
        owner: 'a',
        memoryType: 'FACT',
        content: mainQuery,
        summary: mainQuery,
        importance: 1,
      },
      {
        key: 'excludedExpired',
        owner: 'a',
        memoryType: 'FACT',
        content: mainQuery,
        summary: mainQuery,
        importance: 1,
      },
      {
        key: 'excludedRejected',
        owner: 'a',
        memoryType: 'FACT',
        content: mainQuery,
        summary: mainQuery,
        importance: 1,
      },
    ];
    rawFixtureTexts = [
      mainQuery,
      soloObjective,
      partyObjective,
      ...specs.flatMap((spec) => [spec.content, spec.summary]),
      ...memoryTextSentinels,
    ];
    memories = {};
    const ownerIds = new Map();
    for (const spec of specs) {
      const actor = spec.owner === 'a' ? actorA : actorB;
      const { key, memoryType, content, summary, importance } = spec;
      const input = { memoryType, content, summary, importance };
      const memory = await createMemory(page, actor, input);
      memories[key] = { id: memory.id, ownerId: actor.teammateId, status: 'ACTIVE' };
      ownerIds.set(memory.id, actor.teammateId);
    }

    const proposed = memories.excludedProposed;
    updateFixtureMemory(
      proposed.id,
      "UPDATE memories SET status='PROPOSED', confirmed_at=NULL, updated_at=? WHERE id=?",
      new Date().toISOString(),
    );
    const archived = await page.evaluate(
      ({ teammateId, id }) => window.cultivation.memories.archive({ teammateId, id }),
      { teammateId: actorA.teammateId, id: memories.excludedArchived.id },
    );
    assert.equal(archived.status, 'ARCHIVED');
    updateFixtureMemory(
      memories.excludedExpired.id,
      'UPDATE memories SET expires_at=?, updated_at=? WHERE id=?',
      '2000-01-01T00:00:00.000Z',
      new Date().toISOString(),
    );
    updateFixtureMemory(
      memories.excludedRejected.id,
      "UPDATE memories SET status='PROPOSED', confirmed_at=NULL, updated_at=? WHERE id=?",
      new Date().toISOString(),
    );
    const rejected = await page.evaluate(
      ({ teammateId, id }) => window.cultivation.memories.reject({ teammateId, id }),
      { teammateId: actorA.teammateId, id: memories.excludedRejected.id },
    );
    assert.equal(rejected.status, 'REJECTED');
    memories.excludedProposed.status = 'PROPOSED';
    memories.excludedArchived.status = 'ARCHIVED';
    memories.excludedExpired.status = 'ACTIVE_EXPIRED';
    memories.excludedRejected.status = 'REJECTED';

    const initialEmbedding = await page.evaluate(() => window.cultivation.embedding.getConfig());
    assert.equal(
      initialEmbedding.available,
      true,
      'The packaged SQLite vector extension is required',
    );
    assert.equal(initialEmbedding.runtimeProfileId, null);
    const noVector = await retrieveAcceptance(app, actorA.teammateId, mainQuery);
    assert.equal(noVector.receipt.mode, 'DETERMINISTIC_FALLBACK');
    assert.ok(noVector.ids.includes(memories.aLexicalHeavy.id));
    assert.equal(
      noVector.ids.includes(memories.aVectorHeavy.id),
      false,
      'The vector-heavy fixture must not be a lexical-only result',
    );

    const embeddingSetup = await page.evaluate(
      async ({ runtimeProfileId, teammateA, teammateB }) => {
        const api = window.cultivation;
        const config = await api.embedding.setConfig(runtimeProfileId);
        const a = await api.embedding.reindex(teammateA);
        const b = await api.embedding.reindex(teammateB);
        return { config, a, b };
      },
      {
        runtimeProfileId: actorA.runtimeProfileId,
        teammateA: actorA.teammateId,
        teammateB: actorB.teammateId,
      },
    );
    assert.equal(embeddingSetup.config.runtimeProfileId, actorA.runtimeProfileId);
    assert.ok(embeddingSetup.a.indexed > 0 && embeddingSetup.b.indexed > 0);

    baselineFacts = await retrieveAcceptance(app, actorA.teammateId, mainQuery);
    assert.equal(baselineFacts.receipt.mode, 'DETERMINISTIC_FALLBACK');
    assert.equal(baselineFacts.receipt.reason, 'GATEWAY_UNAVAILABLE');
    assert.deepEqual(baselineFacts.ids, baselineFacts.receipt.selectedIds);
    assert.ok(
      baselineFacts.receipt.candidateIds.includes(memories.aVectorHeavy.id),
      'A vector-only candidate must enter the deterministic union after scoped reindex',
    );
    assert.ok(baselineFacts.receipt.baselineIds.includes(memories.aSummaryRelevant.id));
    assert.equal(
      baselineFacts.receipt.baselineIds.includes(memories.bCrossOwner.id),
      false,
      'A relevant cross-owner candidate must be filtered before rerank',
    );
    const excludedIds = [
      memories.excludedProposed.id,
      memories.excludedArchived.id,
      memories.excludedExpired.id,
      memories.excludedRejected.id,
    ];
    for (const id of excludedIds) {
      assert.equal(baselineFacts.receipt.candidateIds.includes(id), false);
      assert.equal(baselineFacts.ids.includes(id), false);
    }
    assert.equal(baselineFacts.receipt.teammateId, actorA.teammateId);
    assert.equal(baselineFacts.receipt.baselineIds[0], memories.aLexicalHeavy.id);

    memoryCountBeforeRetrieval = databaseMemoryCount(fixtureProfile);
    const observerBeforeFallback = readObserver(fixtureProfile);
    const decisionCountBeforeFallback = observerBeforeFallback.decisions.length;
    const retrievalStartFallback = observerBeforeFallback.retrievals.length;
    const modelCallStartFallback = observerBeforeFallback.modelCalls.length;
    const fallbackConversation = await createConversation(page, actorA.teammateId);
    const fallbackChat = await sendAndWaitForMessages(page, {
      teammateId: actorA.teammateId,
      conversationId: fallbackConversation.id,
      text: mainQuery,
      requestId: randomUUID(),
    });
    observer = readObserver(fixtureProfile);
    const fallbackReceipts = observer.retrievals.slice(retrievalStartFallback);
    const actualFallback = fallbackReceipts.find(
      (receipt) =>
        receipt.teammateId === actorA.teammateId &&
        receipt.queryHash === baselineFacts.receipt.queryHash,
    );
    assert.ok(actualFallback, 'Actual cloud-disabled Chat must use the same bounded query');
    assert.equal(actualFallback.mode, 'DETERMINISTIC_FALLBACK');
    assert.equal(actualFallback.reason, 'GATEWAY_UNAVAILABLE');
    assert.deepEqual(actualFallback.baselineIds, baselineFacts.receipt.baselineIds);
    assert.deepEqual(actualFallback.orderedIds, baselineFacts.receipt.orderedIds);
    assert.deepEqual(actualFallback.selectedIds, baselineFacts.receipt.selectedIds);
    assert.equal(
      observer.decisions.length,
      decisionCountBeforeFallback,
      'Cloud-disabled retrieval must make zero Jev gateway calls',
    );
    const fallbackModelCall = observer.modelCalls[modelCallStartFallback];
    assert.ok(fallbackModelCall, 'Fallback must complete a real packaged LANGUAGE model call');
    assert.equal(fallbackModelCall.teammateId, actorA.teammateId);
    assert.deepEqual(
      fallbackModelCall.finalPromptMemoryIds,
      baselineFacts.receipt.selectedIds.slice(0, 5),
      'PromptComposer must preserve the deterministic Top 5 slice',
    );
    assert.equal(fallbackChat.assistantCharacters > 0, true);
    fallbackFacts = {
      cloudEnabled: false,
      queryHash: actualFallback.queryHash,
      deterministicBaselineIds: actualFallback.baselineIds,
      actualFallback: safeReceipt(actualFallback),
      jevDecisionCallsBefore: decisionCountBeforeFallback,
      jevDecisionCallsAfter: observer.decisions.length,
      promptMemoryIds: fallbackModelCall.finalPromptMemoryIds,
      completed: fallbackChat.assistantCharacters > 0,
    };

    const cloudOn = await page.evaluate(() => window.cultivation.routing.setCloudEnabled(true));
    assert.equal(cloudOn.cloudEnabled, true);

    const observerBeforeRerank = readObserver(fixtureProfile);
    const retrievalStartRerank = observerBeforeRerank.retrievals.length;
    const decisionStartRerank = observerBeforeRerank.decisions.length;
    const modelCallStartRerank = observerBeforeRerank.modelCalls.length;
    const rerankConversation = await createConversation(page, actorA.teammateId);
    const rerankedChat = await sendAndWaitForMessages(page, {
      teammateId: actorA.teammateId,
      conversationId: rerankConversation.id,
      text: mainQuery,
      requestId: randomUUID(),
    });
    observer = readObserver(fixtureProfile);
    const rerankReceipt = observer.retrievals
      .slice(retrievalStartRerank)
      .find((receipt) => receipt.teammateId === actorA.teammateId);
    assert.ok(rerankReceipt, 'The actual Chat path must record a R5.3 retrieval receipt');
    assert.equal(rerankReceipt.mode, 'JEV');
    assert.equal(rerankReceipt.reason, 'JEV_RERANKED');
    assert.equal(rerankReceipt.queryHash, baselineFacts.receipt.queryHash);
    assert.deepEqual(rerankReceipt.baselineIds, baselineFacts.receipt.baselineIds);
    assert.notDeepEqual(
      rerankReceipt.orderedIds,
      rerankReceipt.baselineIds,
      'The relevance rerank must change the frozen deterministic order',
    );
    assert.equal(rerankReceipt.orderedIds[0], memories.aSummaryRelevant.id);
    assert.notEqual(rerankReceipt.baselineIds[0], memories.aSummaryRelevant.id);
    assert.equal(rerankReceipt.selectedIds.length, Math.min(6, rerankReceipt.orderedIds.length));
    assert.equal(rerankReceipt.selectedIds.includes(memories.bCrossOwner.id), false);
    for (const id of excludedIds) assert.equal(rerankReceipt.candidateIds.includes(id), false);
    const rerankModelCall = observer.modelCalls[modelCallStartRerank];
    assert.ok(rerankModelCall, 'Rerank must be followed by an actual model call');
    assert.equal(rerankModelCall.teammateId, actorA.teammateId);
    assert.deepEqual(
      rerankModelCall.finalPromptMemoryIds,
      rerankReceipt.selectedIds.slice(0, 5),
      'PromptComposer must receive the reranked Top 5 slice in the same order',
    );
    assert.equal(rerankedChat.assistantCharacters > 0, true);
    const rerankDecision = observer.decisions[decisionStartRerank];
    assert.ok(rerankDecision, 'Explicit R5.3 fixture must record its FakeDecisionGateway request');
    assert.equal(rerankDecision.decisionType, 'MEMORY_RELEVANCE');
    assert.equal(rerankDecision.queryHash, baselineFacts.receipt.queryHash);
    assert.deepEqual(
      rerankDecision.candidates.map((candidate) => candidate.id),
      rerankReceipt.candidateIds,
    );
    assert.ok(rerankReceipt.candidateTextFacts.every((fact) => fact.source === 'SUMMARY'));
    assert.ok(rerankReceipt.candidateTextFacts.every((fact) => fact.utf8Bytes <= 720));
    chatFacts = {
      fallback: {
        userMessageId: fallbackChat.userMessageId,
        assistantMessageId: fallbackChat.assistantMessageId,
        receipt: safeReceipt(actualFallback),
      },
      rerank: {
        userMessageId: rerankedChat.userMessageId,
        assistantMessageId: rerankedChat.assistantMessageId,
        receipt: safeReceipt(rerankReceipt),
        requestBytes: rerankDecision.requestBytes,
        stateBytes: rerankDecision.stateBytes,
        candidateCount: rerankDecision.candidates.length,
        promptMemoryIds: rerankModelCall.finalPromptMemoryIds,
        completionCharacters: rerankedChat.assistantCharacters,
      },
      vectorOnlyProbe: {
        ftsOnlyCandidateIds: noVector.receipt.candidateIds,
        hybridCandidateIds: baselineFacts.receipt.candidateIds,
        vectorOnlyId: memories.aVectorHeavy.id,
      },
    };

    const beforeSolo = readObserver(fixtureProfile);
    const soloResult = await page.evaluate(
      async ({ teammateId, objective, nonce }) => {
        const api = window.cultivation;
        const mission = await api.missions.create({
          title: `R5.3 SOLO LANGUAGE rerank ${nonce}`,
          objective,
          coordinatorTeammateId: teammateId,
        });
        await api.missions.ready(mission.id);
        return api.missions.start({ missionId: mission.id, approvalFixture: false });
      },
      { teammateId: actorA.teammateId, objective: soloObjective, nonce },
    );
    assert.equal(soloResult.mission.mode, 'SOLO');
    assert.equal(soloResult.mission.state, 'COMPLETED');
    observer = readObserver(fixtureProfile);
    const soloReceipts = assertRetrievalSegment(
      observer,
      beforeSolo.retrievals.length,
      actorA.teammateId,
      ownerIds,
    );
    assert.ok(soloReceipts.some((receipt) => receipt.mode === 'JEV'));
    const soloCalls = observer.modelCalls.slice(beforeSolo.modelCalls.length);
    assert.ok(
      soloCalls.some(
        (call) =>
          call.teammateId === actorA.teammateId &&
          call.finalPromptMemoryIds.includes(memories.aSoloMission.id),
      ),
      'SOLO Mission prompt must contain the actor’s reranked Memory',
    );
    soloFacts = {
      missionId: soloResult.mission.id,
      state: soloResult.mission.state,
      retrievals: soloReceipts.map(safeReceipt),
      modelCalls: soloCalls,
      completed: true,
    };

    const party = await page.evaluate(
      ({ aId, bId, nonce }) =>
        window.cultivation.parties.create({
          name: `R5.3 Party ${nonce}`,
          description: 'Two LANGUAGE actors for a bounded owner-scoped rerank fixture.',
          type: 'FIXED',
          coordinatorTeammateId: aId,
          memberTeammateIds: [aId, bId],
        }),
      { aId: actorA.teammateId, bId: actorB.teammateId, nonce },
    );
    const beforeParty = readObserver(fixtureProfile);
    const partyStart = await page.evaluate(
      async ({ partyId, teammateId, objective, nonce }) => {
        const api = window.cultivation;
        const mission = await api.missions.create({
          title: `R5.3 Party LANGUAGE rerank ${nonce}`,
          objective,
          coordinatorTeammateId: teammateId,
          partyId,
          mode: 'CONSULTATION',
        });
        await api.missions.ready(mission.id);
        return api.missions.start({ missionId: mission.id, approvalFixture: false });
      },
      { partyId: party.id, teammateId: actorA.teammateId, objective: partyObjective, nonce },
    );
    assert.equal(partyStart.mission.state, 'WAITING_COLLABORATION');
    const invitation = partyStart.collaborations.find((item) => item.state === 'PENDING');
    assert.ok(invitation, 'The real Party execution must create a collaboration request');
    assert.equal(invitation.requesterTeammateId, actorA.teammateId);
    assert.equal(invitation.targetTeammateId, actorB.teammateId);
    const partyDone = await page.evaluate(
      (requestId) =>
        window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
      invitation.id,
    );
    assert.equal(partyDone.mission.state, 'COMPLETED');
    assert.ok(
      partyDone.participants.some(
        (item) => item.teammateId === actorA.teammateId && item.role === 'COORDINATOR',
      ),
    );
    assert.ok(
      partyDone.participants.some(
        (item) => item.teammateId === actorB.teammateId && item.role === 'MEMBER',
      ),
    );
    observer = readObserver(fixtureProfile);
    const partyReceipts = observer.retrievals.slice(beforeParty.retrievals.length);
    const partyAReceipts = partyReceipts.filter(
      (receipt) => receipt.teammateId === actorA.teammateId,
    );
    const partyBReceipts = partyReceipts.filter(
      (receipt) => receipt.teammateId === actorB.teammateId,
    );
    assert.ok(partyAReceipts.length > 0, 'Party coordinator must rerank its own Memory');
    assert.ok(partyBReceipts.length > 0, 'Party participant must rerank its own Memory');
    for (const receipt of partyReceipts) assertReceiptOwned(receipt, ownerIds);
    assert.ok(
      partyReceipts.every((receipt) => receipt.queryHash === hashText(partyObjective)),
      'Party cloud rerank must see only the task objective, never synthesis results/artifacts',
    );
    assert.ok(partyAReceipts.some((receipt) => receipt.mode === 'JEV'));
    assert.ok(partyBReceipts.some((receipt) => receipt.mode === 'JEV'));
    const partyCalls = observer.modelCalls.slice(beforeParty.modelCalls.length);
    assertModelCallsOwned(partyCalls, ownerIds);
    assert.ok(
      partyCalls.some(
        (call) =>
          call.teammateId === actorA.teammateId &&
          call.finalPromptMemoryIds.includes(memories.aPartyCoordinator.id),
      ),
      'Party coordinator model prompt must use only its own ranked Memory',
    );
    assert.ok(
      partyCalls.some(
        (call) =>
          call.teammateId === actorB.teammateId &&
          call.finalPromptMemoryIds.includes(memories.bPartyParticipant.id),
      ),
      'Party participant model prompt must use only its own ranked Memory',
    );
    partyFacts = {
      missionId: partyDone.mission.id,
      state: partyDone.mission.state,
      participants: partyDone.participants.map((item) => ({
        teammateId: item.teammateId,
        role: item.role,
      })),
      coordinatorReceipts: partyAReceipts.map(safeReceipt),
      participantReceipts: partyBReceipts.map(safeReceipt),
      modelCalls: partyCalls,
      crossOwnerMemoryIdsAbsent: partyReceipts.every((receipt) =>
        receipt.candidateIds.every((id) => ownerIds.get(id) === receipt.teammateId),
      ),
    };

    const beforeWorkflow = readObserver(fixtureProfile);
    const workflowCreated = await page.evaluate(() =>
      window.cultivation.workflows.create({ definitionId: 'w1-fixture-sequence', version: 1 }),
    );
    const workflowDone = await page.evaluate(
      (runId) => window.cultivation.workflows.advance(runId),
      workflowCreated.run.id,
    );
    assert.equal(workflowDone.run.state, 'COMPLETED');
    const reviewStep = workflowDone.steps.find(
      (item) => item.stepId === 'review' && item.state === 'COMPLETED',
    );
    assert.ok(reviewStep?.missionId, 'The actual W1 LANGUAGE review step must run');
    const workflowMission = await page.evaluate(
      (missionId) => window.cultivation.missions.detail(missionId),
      reviewStep.missionId,
    );
    assert.equal(workflowMission.mission.state, 'COMPLETED');
    observer = readObserver(fixtureProfile);
    const workflowReceipts = assertRetrievalSegment(
      observer,
      beforeWorkflow.retrievals.length,
      actorA.teammateId,
      ownerIds,
    );
    assert.ok(workflowReceipts.some((receipt) => receipt.mode === 'JEV'));
    const workflowCalls = observer.modelCalls.slice(beforeWorkflow.modelCalls.length);
    assertModelCallsOwned(workflowCalls, ownerIds);
    assert.ok(
      workflowCalls.some(
        (call) =>
          call.teammateId === actorA.teammateId &&
          call.finalPromptMemoryIds.includes(memories.aWorkflowStep.id),
      ),
      'Workflow LANGUAGE Step prompt must contain the executing actor’s ranked Memory',
    );
    workflowFacts = {
      workflowRunId: workflowDone.run.id,
      stepRunId: reviewStep.id,
      missionId: reviewStep.missionId,
      actorId: actorA.teammateId,
      workflowRunChangedOwner: false,
      state: workflowDone.run.state,
      retrievals: workflowReceipts.map(safeReceipt),
      modelCalls: workflowCalls,
      workflowHistorySent: false,
    };

    observer = readObserver(fixtureProfile);
    assertDecisionBounds(observer, ownerIds);
    assertModelCallsOwned(observer.modelCalls, ownerIds);
    assert.equal(observer.extractorCalls, 0, 'Ordinary retrieval must never invoke extraction');
    assert.equal(
      observer.decisions.length,
      observer.retrievals.filter((receipt) => receipt.mode === 'JEV').length,
      'Only successful opted-in reranks may call the explicit FakeDecisionGateway',
    );
    const observerJson = JSON.stringify(observer);
    for (const rawText of [
      mainQuery,
      soloObjective,
      partyObjective,
      ...specs.flatMap((spec) => [spec.content, spec.summary]),
      ...memoryTextSentinels,
      fakeJevKey,
    ])
      assert.equal(
        observerJson.includes(rawText),
        false,
        'Observer must not persist raw text or credentials',
      );
    memoryCountAfterRetrieval = databaseMemoryCount(fixtureProfile);
    assert.equal(
      memoryCountAfterRetrieval,
      memoryCountBeforeRetrieval,
      'Ordinary retrieval must not create or modify Memory rows',
    );
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '智能分配', exact: true }).click();
    await page.getByText('数据范围与策略', { exact: true }).click();
    await page.getByText(/记忆重排还会发送当前道友的候选记忆摘要/).waitFor();
    mkdirSync(evidenceDir, { recursive: true });
    for (const width of [1440, 1180, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0].setSize(width, 900);
      }, width);
      await page.waitForTimeout(150);
      const name = `routing-privacy-${width}.png`;
      await page.screenshot({ path: join(evidenceDir, name), animations: 'disabled' });
      privacyScreenshots.push({ name, width, height: 900 });
    }
  } finally {
    await live.app.close();
  }
}

assert.equal(existsSync(productionFactsPath), false);
assert.equal(existsSync(fixtureFactsPath), true);
observer = readObserver(fixtureProfile);
fixtureMigrations = assertMigrations(fixtureProfile);
assert.deepEqual(fixtureMigrations, productionMigrations);
assert.equal(memoryCountAfterRetrieval, memoryCountBeforeRetrieval);

const ownerIds = new Map(Object.values(memories).map((memory) => [memory.id, memory.ownerId]));
assertDecisionBounds(observer, ownerIds);
assertModelCallsOwned(observer.modelCalls, ownerIds);
for (const receipt of observer.retrievals) assertReceiptOwned(receipt, ownerIds);
assert.equal(observer.extractorCalls, 0);

const databaseFacts = openReadOnlyDatabase(fixtureProfile, (db) => {
  const ids = Object.values(memories).map((memory) => memory.id);
  const rows = db
    .prepare(
      `SELECT id, owner_type, owner_id, memory_type, status, expires_at
       FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    )
    .all(...ids);
  assert.equal(rows.length, ids.length);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const memory of Object.values(memories)) {
    const row = byId.get(memory.id);
    assert.ok(row);
    assert.equal(row.owner_type, 'TEAMMATE');
    assert.equal(row.owner_id, memory.ownerId);
    if (memory.status === 'ACTIVE_EXPIRED') assert.ok(Date.parse(row.expires_at) < Date.now());
    else assert.equal(row.status, memory.status);
  }
  const migrations = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version);
  return {
    memoryRows: db.prepare('SELECT COUNT(*) AS count FROM memories').get().count,
    seededRows: rows.length,
    statuses: Object.fromEntries(rows.map((row) => [row.id, row.status])),
    expiredIds: rows
      .filter((row) => row.expires_at && Date.parse(row.expires_at) < Date.now())
      .map((row) => row.id),
    migrations,
  };
});
assert.equal(databaseFacts.memoryRows, memoryCountBeforeRetrieval);
assert.equal(databaseFacts.seededRows, Object.keys(memories).length);
assert.deepEqual(
  databaseFacts.migrations,
  Array.from({ length: 32 }, (_, index) => index + 1),
);

const jevReceipts = observer.retrievals.filter((receipt) => receipt.mode === 'JEV');
assert.ok(jevReceipts.length >= 5, 'Chat, SOLO, Party, and Workflow must exercise Jev reranking');

const evidencePath = join(evidenceDir, 'facts.json');
mkdirSync(evidenceDir, { recursive: true });
const evidence = {
  verifiedAt: new Date().toISOString(),
  schemaVersion: 32,
  privacyScreenshots,
  liveJev: { status: 'NOT RUN', gateway: 'explicit FakeDecisionGateway fixture' },
  production: {
    normalLaunch: true,
    r53MainAcceptanceRetrieve: false,
    rendererAcceptanceRetrieve: false,
    fixtureEvidenceFile: false,
    officialWorkflowHashes: productionHashes,
    migrations: productionMigrations,
  },
  fixture: {
    flags: fixtureArgs,
    officialWorkflowHashes: fixtureHashes,
    officialHashesUnchanged: hash(productionHashes) === hash(fixtureHashes),
    actors,
    memoryIds: Object.fromEntries(
      Object.entries(memories).map(([key, memory]) => [
        key,
        {
          id: memory.id,
          ownerId: memory.ownerId,
          status: memory.status,
        },
      ]),
    ),
    embedding: {
      runtimeProfileId: actors.a.runtimeProfileId,
      vectorExtensionAvailable: true,
      actorAReindexed: true,
      actorBReindexed: true,
    },
    deterministicBaseline: safeReceipt(baselineFacts.receipt),
    fallback: fallbackFacts,
    chat: chatFacts,
    solo: soloFacts,
    party: partyFacts,
    workflow: workflowFacts,
    observer: {
      decisions: observer.decisions.map(safeDecision),
      retrievals: observer.retrievals.map(safeReceipt),
      modelCalls: observer.modelCalls,
      extractorCalls: observer.extractorCalls,
    },
    database: {
      ...databaseFacts,
      memoryCountBeforeRetrieval,
      memoryCountAfterRetrieval,
      memoryRowsUnchanged: memoryCountBeforeRetrieval === memoryCountAfterRetrieval,
      extractorCalls: observer.extractorCalls,
    },
    migrations: fixtureMigrations,
  },
};
const evidenceJson = JSON.stringify(evidence);
for (const rawText of rawFixtureTexts)
  assert.equal(
    evidenceJson.includes(rawText),
    false,
    'Evidence must not include raw query or Memory text',
  );
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`R5_3_PACKAGED_EVIDENCE ${evidencePath}`);
console.log(
  `R5_3_PACKAGED_SMOKE_OK production=fixture_free cloud_off=baseline_equal rerank=summary_relevance party=owner_scoped workflow=language_step extractor=0 memories_unchanged=true evidence=${evidencePath}`,
);
