import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const runId = randomUUID();
const shortId = runId.slice(0, 8);
const profileRoot = join(root, '.test-data', `r5-5-packaged-${runId}`);
const productionProfile = join(profileRoot, 'production');
const fixtureProfile = join(profileRoot, 'fixture');
const productionFactsPath = join(productionProfile, 'r5-5-execution-facts.json');
const fixtureFactsPath = join(fixtureProfile, 'r5-5-execution-facts.json');
const evidenceDir = join(root, 'docs', 'evidence', 'r5-5-review-completion-advisory', runId);
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
const fixtureArgs = [
  '--gate1-fake-model',
  '--r5-5-fixture',
  '--g3-fixture',
  '--r4-fake-routing',
  '--w1-fake-workflow',
];
const secretMarker = `sk-${runId.replaceAll('-', '')}`;
const satisfiedObjective = `Produce a concise local status note. [R55_SATISFIED] token=${secretMarker}`;
const concernObjective = `Produce a concise local status note. [R55_CONCERN] token=${secretMarker}`;
const inconsistentObjective = `Produce a concise local status note. [R55_INCONSISTENT] token=${secretMarker}`;
const privateMarkers = [
  `R55_PRIVATE_A_MEMORY_${shortId}`,
  `R55_PRIVATE_B_MEMORY_${shortId}`,
  `R55_PRIVATE_A_SKILL_${shortId}`,
  `R55_PRIVATE_B_SKILL_${shortId}`,
];
const rawValues = [
  secretMarker,
  satisfiedObjective,
  concernObjective,
  inconsistentObjective,
  ...privateMarkers,
  `r55-deterministic-fixture-key-${runId}`,
];

assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);
assert.equal(existsSync(profileRoot), false, 'R5.5 acceptance needs fresh isolated profiles');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashObject(value) {
  return hash(canonical(value));
}

function snapshotOfficialWorkflowVersions(versions, { production = false } = {}) {
  const official = versions
    .filter((item) => officialWorkflowIds.includes(item.definition.id))
    .sort((left, right) => left.definition.id.localeCompare(right.definition.id));
  assert.deepEqual(
    official.map((item) => item.definition.id),
    [...officialWorkflowIds].sort(),
    'The three frozen official Workflow definitions must remain registered',
  );
  if (production) {
    assert.deepEqual(
      versions.map((item) => item.definition.id).sort(),
      [...officialWorkflowIds].sort(),
      'Normal packaged launch must expose no test Workflow fixture',
    );
  }
  return Object.fromEntries(official.map((item) => [item.definition.id, hashObject(item)]));
}

function openReadOnlyDatabase(profile, fn) {
  assert.ok(
    profile === productionProfile || profile === fixtureProfile,
    'SQLite acceptance reads must stay inside this run’s isolated profiles',
  );
  const path = join(profile, 'data', 'cultivation.sqlite');
  assert.ok(existsSync(path), `Packaged profile database not found: ${path}`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function assertMigrations(profile) {
  return openReadOnlyDatabase(profile, (db) => {
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version);
    assert.deepEqual(
      versions,
      Array.from({ length: 31 }, (_, index) => index + 1),
    );
    return versions;
  });
}

function tableCount(table) {
  const allowed = new Set(['missions', 'parties', 'approval_requests']);
  assert.ok(allowed.has(table), 'Only fixed SQLite table names may be counted');
  return openReadOnlyDatabase(
    fixtureProfile,
    (db) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  );
}

function missionEventCounts(missionIds) {
  return openReadOnlyDatabase(fixtureProfile, (db) => {
    const output = {};
    for (const missionId of [...missionIds].sort()) {
      const events = db
        .prepare(
          'SELECT event_type AS eventType, COUNT(*) AS count FROM mission_events WHERE mission_id = ? GROUP BY event_type ORDER BY event_type',
        )
        .all(missionId);
      output[missionId] = Object.fromEntries(events.map((row) => [row.eventType, row.count]));
    }
    return output;
  });
}

const completionAdvisoryReceiptKeys = [
  'actorId',
  'choices',
  'disposition',
  'errorCode',
  'missionId',
  'mode',
  'objectiveHash',
  'phase',
  'policyVersion',
  'questionVersion',
  'reason',
  'requestBytes',
  'responseBytes',
  'resultHash',
  'runId',
  'stateBytes',
  'stateHash',
];

function readG3LanguageOutcome(missionId, participantTeammateId) {
  return openReadOnlyDatabase(fixtureProfile, (db) => {
    const row = db
      .prepare(
        `SELECT id, task_id AS taskId, attempt_id AS attemptId,
                participant_teammate_id AS participantTeammateId,
                execution_protocol AS executionProtocol, kind, outcome_json AS outcomeJson,
                consumed_at AS consumedAt
         FROM g3_participant_outcomes
         WHERE mission_id = ? AND participant_teammate_id = ? AND execution_protocol = 'LANGUAGE'
         ORDER BY created_at, id`,
      )
      .get(missionId, participantTeammateId);
    assert.ok(row, 'G3 must persist the LANGUAGE ParticipantOutcome for the actual participant');
    const outcome = JSON.parse(row.outcomeJson);
    assert.equal(row.kind, outcome.kind);
    assert.equal(row.executionProtocol, 'LANGUAGE');
    assert.equal(outcome.kind, 'RESULT');
    assert.deepEqual(outcome.artifactRefs, []);
    assert.equal(typeof outcome.publicResult, 'string');
    const continuationCount = db
      .prepare('SELECT COUNT(*) AS count FROM g3_continuations WHERE outcome_id = ?')
      .get(row.id).count;
    assert.equal(
      continuationCount,
      0,
      'A structured RESULT must not gain a continuation from advisory',
    );
    return {
      id: row.id,
      taskId: row.taskId,
      attemptId: row.attemptId,
      participantTeammateId: row.participantTeammateId,
      executionProtocol: row.executionProtocol,
      kind: row.kind,
      outcomeHash: hash(row.outcomeJson),
      publicResultBytes: Buffer.byteLength(outcome.publicResult, 'utf8'),
      consumed: row.consumedAt !== null,
      continuationCount,
    };
  });
}

function readObserver(profile = fixtureProfile) {
  const path = join(profile, 'r5-5-execution-facts.json');
  assert.ok(existsSync(path), 'Explicit R5.5 fixture launch must save bounded execution facts');
  const observer = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(observer.decisions));
  assert.ok(Array.isArray(observer.modelCalls));
  assert.ok(Array.isArray(observer.receipts));
  return observer;
}

function observerSnapshot() {
  return existsSync(fixtureFactsPath)
    ? readObserver()
    : { decisions: [], modelCalls: [], receipts: [] };
}

function payloadOf(event) {
  assert.ok(event.payloadJson && typeof event.payloadJson === 'object');
  return event.payloadJson;
}

function advisoryEvents(detail) {
  return (detail.events ?? [])
    .filter((event) => event.eventType === 'completion.advisory')
    .map((event) => {
      assert.equal(event.eventType, 'completion.advisory');
      return { event, payload: payloadOf(event) };
    });
}

function advisoryValues(value) {
  const source = value?.choices ?? value?.values ?? value;
  return {
    needsReview: source?.needs_review,
    objectiveSatisfied: source?.objective_satisfied,
    shouldContinue: source?.should_continue,
  };
}

function safeHashes(value) {
  const result = {};
  for (const [target, key] of Object.entries({
    objective: 'objectiveHash',
    result: 'resultHash',
    state: 'stateHash',
  })) {
    const item = value?.[key];
    if (typeof item === 'string' && /^[a-f0-9]{64}$/iu.test(item)) result[target] = item;
  }
  return result;
}

function safeBytes(value) {
  const bytes = {
    state: value?.stateBytes,
    request: value?.requestBytes,
    response: value?.responseBytes,
  };
  for (const count of Object.values(bytes))
    assert.ok(
      Number.isSafeInteger(count) && count >= 0,
      'Completion receipt byte counts are required',
    );
  return bytes;
}

function normalizeAdvisoryFact(value, trusted = {}) {
  const normalized = {
    type: value?.type ?? trusted.type,
    actorId: value?.actorId,
    phase: value?.phase,
    missionId: value?.missionId,
    runId: value?.runId,
    resultType: value?.resultType,
    mode: value?.mode,
    values: advisoryValues(value),
    disposition: value?.disposition,
    hashes: safeHashes(value),
    bytes: safeBytes(value),
    forbiddenDataSeen: value?.forbiddenDataSeen ?? trusted.forbiddenDataSeen,
  };
  assert.equal(normalized.type, 'COMPLETION_ADVISORY');
  assert.equal(typeof normalized.actorId, 'string');
  assert.equal(typeof normalized.phase, 'string');
  assert.equal(typeof normalized.missionId, 'string');
  for (const choice of Object.values(normalized.values))
    assert.ok(['YES', 'NO', 'UNCERTAIN'].includes(choice), 'All three advisory Choices are typed');
  assert.equal(normalized.forbiddenDataSeen, false);
  assert.ok(normalized.bytes.state <= 8_000);
  assert.ok(normalized.bytes.request <= 16_000);
  assert.ok(normalized.bytes.response <= 8_000);
  return normalized;
}

function safeDecision(decision) {
  // Some callers already hold the local normalized safe projection. Re-project
  // its fields once; the durable receipt exact-key check remains at the boundary.
  const value = normalizeAdvisoryFact({
    ...decision,
    choices: decision.choices ?? {
      needs_review: decision.values?.needs_review ?? decision.values?.needsReview,
      objective_satisfied:
        decision.values?.objective_satisfied ?? decision.values?.objectiveSatisfied,
      should_continue: decision.values?.should_continue ?? decision.values?.shouldContinue,
    },
    objectiveHash: decision.objectiveHash ?? decision.hashes?.objective,
    resultHash: decision.resultHash ?? decision.hashes?.result,
    stateHash: decision.stateHash ?? decision.hashes?.state,
    stateBytes: decision.stateBytes ?? decision.bytes?.state,
    requestBytes: decision.requestBytes ?? decision.bytes?.request,
    responseBytes: decision.responseBytes ?? decision.bytes?.response,
  });
  return {
    type: value.type,
    actorId: value.actorId,
    phase: value.phase,
    missionId: value.missionId,
    ...(value.runId ? { runId: value.runId } : {}),
    ...(value.resultType ? { resultType: value.resultType } : {}),
    ...(typeof value.mode === 'string' ? { mode: value.mode } : {}),
    values: value.values,
    ...(typeof value.disposition === 'string' ? { disposition: value.disposition } : {}),
    hashes: value.hashes,
    bytes: value.bytes,
    forbiddenDataSeen: value.forbiddenDataSeen,
  };
}

function advisoryForMission(detail, { actorId, phase, values, required = true }) {
  const matching = advisoryEvents(detail).filter(({ event, payload }) => {
    const fact = normalizeAdvisoryFact(payload, {
      type: event.eventType === 'completion.advisory' ? 'COMPLETION_ADVISORY' : undefined,
      forbiddenDataSeen: false,
    });
    assert.deepEqual(Object.keys(payload).sort(), [...completionAdvisoryReceiptKeys].sort());
    return (
      fact.actorId === actorId &&
      fact.actorId === event.actorId &&
      fact.missionId === event.missionId &&
      fact.runId === event.runId &&
      (phase === undefined || fact.phase === phase) &&
      (!detail.mission?.id || fact.missionId === detail.mission.id)
    );
  });
  if (!required) {
    assert.equal(matching.length, 0, `No ${phase} advisory should be created for this path`);
    return null;
  }
  assert.equal(matching.length, 1, `Expected one ${phase} advisory for actor ${actorId}`);
  const { event, payload } = matching[0];
  const fact = normalizeAdvisoryFact(payload, {
    type: event.eventType === 'completion.advisory' ? 'COMPLETION_ADVISORY' : undefined,
    forbiddenDataSeen: false,
  });
  assert.equal(event.eventType, 'completion.advisory');
  assert.deepEqual(Object.keys(payload).sort(), [...completionAdvisoryReceiptKeys].sort());
  assert.deepEqual(fact.values, values);
  assert.equal(event.actorId, actorId, 'Durable advisory actor attribution must match executor');
  assert.equal(
    fact.missionId,
    event.missionId,
    'Durable receipt mission attribution must match event',
  );
  assert.equal(fact.runId, event.runId, 'Durable receipt run attribution must match the event');
  return fact;
}

function observerDecision(observer, { actorId, phase, missionId }) {
  const matches = observer.decisions.filter((item) => {
    return (
      item.type === 'COMPLETION_ADVISORY' &&
      item.decisionType === 'COMPLETION_ADVISORY' &&
      item.actorId === actorId &&
      item.missionId === missionId &&
      (phase === undefined || item.phase === phase)
    );
  });
  assert.equal(matches.length, 1, 'The bounded Main observer must record one Cloud decision');
  return safeDecision(matches[0]);
}

function assertObserverPrivacy(observer) {
  for (const decision of observer.decisions) {
    assert.equal(decision.type, 'COMPLETION_ADVISORY');
    assert.equal(decision.decisionType, 'COMPLETION_ADVISORY');
    assert.equal(decision.forbiddenDataSeen, false);
    normalizeAdvisoryFact(decision);
  }
  const serialized = JSON.stringify(observer);
  for (const raw of rawValues) assert.equal(serialized.includes(raw), false);
}

function modelAndToolCounts(detail) {
  const events = detail.events ?? [];
  return {
    modelCalls: events.filter((event) => event.eventType === 'model.call_started').length,
    toolCalls: events.filter((event) =>
      [
        'tool.proposed',
        'tool.result',
        'tool.execution_started',
        'tool.execution_completed',
      ].includes(event.eventType),
    ).length,
    approvals: detail.approvals?.length ?? 0,
    collaborations: detail.collaborations?.length ?? 0,
  };
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
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 30_000 });
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function missionDetail(page, missionId) {
  return page.evaluate((id) => window.cultivation.missions.detail(id), missionId);
}

async function waitForMissionTerminal(page, missionId) {
  const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const detail = await missionDetail(page, missionId);
    if (terminal.has(detail.mission.state)) return detail;
    await page.waitForTimeout(100);
  }
  throw new Error(`Mission ${missionId} did not reach a terminal state`);
}

async function seedActor(page, role) {
  return page.evaluate(
    async ({ role, shortId }) => {
      const api = window.cultivation;
      const provider = await api.providers.create({
        name: `R5.5 ${role} offline provider ${shortId}`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9999/v1',
      });
      const runtime = await api.runtimes.create({
        name: `R5.5 ${role} sealed runtime ${shortId}`,
        providerId: provider.id,
        credentialId: null,
        modelId: `r55-language-${role.toLowerCase()}-${shortId}`,
        executionProtocol: 'LANGUAGE',
      });
      if (runtime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.5 actor must use a LANGUAGE runtime');
      const teammate = await api.teammates.create({
        name: role === 'A' ? '知微' : '行简',
        avatar: null,
        title: `R5.5 ${role}`,
        description: 'Packaged R5.5 advisory actor fixture.',
        identityPrompt: `R5.5 sealed LANGUAGE identity ${role} ${shortId}`,
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
      const binding = (await api.runtimes.list()).find(
        (item) => item.id === teammate.currentRuntimeProfileId,
      );
      if (!binding || binding.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.5 actor must stay bound to its LANGUAGE runtime');
      await api.capability.saveBenchmark({
        runtimeProfileId: binding.id,
        modelAlias: binding.modelId,
        dimension: 'GENERAL_REASONING',
        supported: true,
        normalizedScore: role === 'A' ? 80 : 60,
        rawScore: null,
        source: 'R5.5 deterministic fixture',
        benchmark: 'Acceptance fixture',
        benchmarkVersion: '1',
        snapshotDate: '2026-10-01T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
      await api.r2.setCapability({ dimension: 'GENERAL_REASONING', enabled: true });
      return {
        role,
        teammateId: teammate.id,
        runtimeProfileId: binding.id,
        executionProtocol: binding.executionProtocol,
      };
    },
    { role, shortId },
  );
}

async function createMission(page, actor, title, objective, options = {}) {
  return page.evaluate(
    async ({ teammateId, title, objective, partyId, mode }) => {
      const api = window.cultivation;
      const mission = await api.missions.create({
        title,
        objective,
        coordinatorTeammateId: teammateId,
        ...(partyId ? { partyId } : {}),
        ...(mode ? { mode } : {}),
      });
      await api.missions.ready(mission.id);
      return mission;
    },
    {
      teammateId: actor.teammateId,
      title,
      objective,
      partyId: options.partyId ?? null,
      mode: options.mode ?? null,
    },
  );
}

async function startMission(page, missionId) {
  await page.evaluate(
    (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
    missionId,
  );
  return waitForMissionTerminal(page, missionId);
}

async function setCloudEnabled(page, enabled) {
  const config = await page.evaluate(
    (value) => window.cultivation.routing.setCloudEnabled(value),
    enabled,
  );
  assert.equal(config.cloudEnabled, enabled);
  return config;
}

async function configureFakeCloudKey(app, page) {
  const fakeKey = `r55-deterministic-fixture-key-${runId}`;
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), fakeKey);
  const imported = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
  assert.equal(imported.configured, true);
  assert.equal(JSON.stringify(imported).includes(fakeKey), false);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
}

async function addPrivateContext(page, actors) {
  await page.evaluate(
    async ({ actors, privateMarkers }) => {
      const api = window.cultivation;
      for (const [index, actor] of [actors.a, actors.b].entries()) {
        const memoryMarker = privateMarkers[index];
        const skillMarker = privateMarkers[index + 2];
        await api.memories.create({
          teammateId: actor.teammateId,
          memoryType: 'FACT',
          content: memoryMarker,
          summary: memoryMarker,
          importance: 0.9,
        });
        const skill = await api.skills.create({
          name: `R5.5 private skill ${index}`,
          description: 'Fixture-only private skill text.',
          instructions: skillMarker,
          tags: ['r55-private-fixture'],
        });
        await api.skills.assign({ teammateId: actor.teammateId, skillId: skill.id });
        await api.skills.setEnabled({
          teammateId: actor.teammateId,
          skillId: skill.id,
          enabled: true,
        });
      }
    },
    { actors, privateMarkers },
  );
}

async function createParty(page, actors) {
  return page.evaluate(
    ({ aId, bId, shortId }) =>
      window.cultivation.parties.create({
        name: `R5.5 actor isolation ${shortId}`,
        description: 'Two LANGUAGE actors for independent R5.5 completion advisory.',
        type: 'FIXED',
        coordinatorTeammateId: aId,
        memberTeammateIds: [aId, bId],
      }),
    { aId: actors.a.teammateId, bId: actors.b.teammateId, shortId },
  );
}

async function capturePrivacy(page, app) {
  await navigateUi(page, '设置 Settings');
  await page.getByRole('tab', { name: '智能分配', exact: true }).click();
  await page.getByText('数据范围与策略', { exact: true }).click();
  await page.getByText(/完成度建议还会发送脱敏后的有界目标和最终公开结果摘录/).waitFor();
  await page.getByText(/完成度建议不改变历练或工作流状态，也不会自动创建审查或继续执行/).waitFor();
  mkdirSync(evidenceDir, { recursive: true });
  const screenshots = [];
  for (const width of [1440, 1180, 900]) {
    await app.evaluate(
      ({ BrowserWindow }, currentWidth) =>
        BrowserWindow.getAllWindows()[0].setSize(currentWidth, 900),
      width,
    );
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: window.document.documentElement.scrollWidth,
    }));
    assert.ok(
      layout.documentWidth <= layout.viewportWidth + 1,
      'Privacy disclosure must not overflow',
    );
    const name = `completion-advisory-privacy-${width}.png`;
    await page.screenshot({
      path: join(evidenceDir, name),
      fullPage: true,
      animations: 'disabled',
    });
    writeFileSync(
      join(evidenceDir, `completion-advisory-privacy-${width}-layout.json`),
      `${JSON.stringify({ width, height: 900, ...layout }, null, 2)}\n`,
      'utf8',
    );
    screenshots.push({ name, width, height: 900, horizontalOverflow: false });
  }
  return screenshots;
}

async function getWorkflowDetail(page, runId) {
  return page.evaluate((id) => window.cultivation.workflows.detail(id), runId);
}

async function startWorkflow(page, definitionId) {
  const created = await page.evaluate(
    (id) => window.cultivation.workflows.create({ definitionId: id, version: 1 }),
    definitionId,
  );
  await page.evaluate((id) => window.cultivation.workflows.advance(id), created.run.id);
  const deadline = Date.now() + 30_000;
  let detail;
  while (Date.now() < deadline) {
    detail = await getWorkflowDetail(page, created.run.id);
    if (detail.run.state !== 'RUNNING' && detail.run.state !== 'READY') return detail;
    await page.waitForTimeout(100);
  }
  throw new Error(`Workflow ${definitionId} did not settle for packaged acceptance`);
}

function workflowMissionStep(detail, stepId) {
  const step = detail.steps.find((item) => item.stepId === stepId);
  assert.ok(step, `Workflow ${detail.run.definitionId} must include Step ${stepId}`);
  assert.ok(step.missionId, `Workflow Step ${stepId} must bind its Mission`);
  return step;
}

let productionHashes;
let productionMigrations;
let fixtureMigrations;
let actors;
let observer;
let screenshots = [];
let soloSatisfiedFacts;
let soloConcernFacts;
let cloudOffFacts;
let inconsistentFacts;
let partyFacts;
let workflowInvalidFacts;
let workflowReviewFacts;
let g3Facts;
let restartFacts;
let fixtureWorkflowHashes;
let fixtureWorkflowIds;
const missionIdsForRestart = [];

{
  const production = await launch(productionProfile);
  try {
    const boot = await production.page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
    }));
    productionHashes = snapshotOfficialWorkflowVersions(boot.versions, { production: true });
    assert.equal(boot.routing.cloudEnabled, false);
    assert.equal(
      existsSync(productionFactsPath),
      false,
      'Normal packaged launch must not create R5.5 fixture evidence',
    );
    assert.equal(
      await production.app.evaluate(({ app }) => typeof app.r55AcceptanceAssess),
      'undefined',
      'Normal launch must not expose a Renderer-callable R5.5 test authority',
    );
  } finally {
    await production.app.close();
  }
}
productionMigrations = assertMigrations(productionProfile);

let live = await launch(fixtureProfile, fixtureArgs);
try {
  const { app, page } = live;
  const boot = await page.evaluate(async () => ({
    versions: await window.cultivation.workflows.versions(),
    routing: await window.cultivation.routing.config(),
  }));
  fixtureWorkflowHashes = snapshotOfficialWorkflowVersions(boot.versions);
  assert.deepEqual(fixtureWorkflowHashes, productionHashes);
  fixtureWorkflowIds = boot.versions.map((item) => item.definition.id);
  for (const id of [
    'w1-fixture-sequence',
    'r55-fixture-output-invalid',
    'r55-fixture-review-revise',
    'test.g3-generation',
  ])
    assert.ok(fixtureWorkflowIds.includes(id), `Explicit fixture launch must expose ${id}`);
  assert.ok(
    boot.versions
      .filter((item) =>
        ['r55-fixture-output-invalid', 'r55-fixture-review-revise'].includes(item.definition.id),
      )
      .every((item) => item.definition.source === 'USER'),
    'R5.5 Workflow adversaries must be USER-owned fixtures',
  );
  assert.equal(boot.routing.cloudEnabled, false);
  assert.equal(existsSync(fixtureFactsPath), false, 'Fixture facts appear only after execution');

  await configureFakeCloudKey(app, page);
  await setCloudEnabled(page, true);
  const actorA = await seedActor(page, 'A');
  const actorB = await seedActor(page, 'B');
  actors = { a: actorA, b: actorB };
  assert.equal(actorA.executionProtocol, 'LANGUAGE');
  assert.equal(actorB.executionProtocol, 'LANGUAGE');

  const missionCountBeforeSolo = tableCount('missions');
  const partyCountBeforeSolo = tableCount('parties');

  const satisfiedMission = await createMission(
    page,
    actorA,
    `R5.5 satisfied ${shortId}`,
    satisfiedObjective,
  );
  const satisfiedBefore = observerSnapshot();
  const satisfiedDetail = await startMission(page, satisfiedMission.id);
  assert.equal(satisfiedDetail.mission.state, 'COMPLETED');
  assert.equal(satisfiedDetail.mission.mode, 'SOLO');
  const satisfiedModelCounts = modelAndToolCounts(satisfiedDetail);
  assert.deepEqual(satisfiedModelCounts, {
    modelCalls: 1,
    toolCalls: 0,
    approvals: 0,
    collaborations: 0,
  });
  const satisfiedFinal = satisfiedDetail.runs.at(-1)?.resultText;
  assert.equal(typeof satisfiedFinal, 'string');
  assert.ok(
    satisfiedFinal.startsWith('FAKE:'),
    'Ordinary FakeModel must still return its normal final',
  );
  const satisfiedAdvisory = advisoryForMission(satisfiedDetail, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    values: { needsReview: 'NO', objectiveSatisfied: 'YES', shouldContinue: 'NO' },
  });
  assert.equal(satisfiedAdvisory.disposition, 'NO_ADVISORY');
  let currentObserver = readObserver();
  const satisfiedDecision = observerDecision(currentObserver, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    missionId: satisfiedMission.id,
  });
  assert.equal(currentObserver.decisions.length, satisfiedBefore.decisions.length + 1);
  assert.equal(currentObserver.modelCalls.length, satisfiedBefore.modelCalls.length + 1);
  soloSatisfiedFacts = {
    missionId: satisfiedMission.id,
    runId: satisfiedDetail.runs.at(-1)?.id,
    actorId: actorA.teammateId,
    missionState: satisfiedDetail.mission.state,
    resultHash: hash(satisfiedFinal),
    modelCalls: satisfiedModelCounts.modelCalls,
    toolCalls: satisfiedModelCounts.toolCalls,
    approvalCount: satisfiedModelCounts.approvals,
    collaborationCount: satisfiedModelCounts.collaborations,
    advisory: safeDecision(satisfiedDecision),
  };
  missionIdsForRestart.push(satisfiedMission.id);

  const concernMission = await createMission(
    page,
    actorA,
    `R5.5 concern ${shortId}`,
    concernObjective,
  );
  const concernBefore = observerSnapshot();
  const concernDetail = await startMission(page, concernMission.id);
  assert.equal(concernDetail.mission.state, 'COMPLETED');
  assert.equal(concernDetail.mission.mode, 'SOLO');
  const concernModelCounts = modelAndToolCounts(concernDetail);
  assert.deepEqual(concernModelCounts, satisfiedModelCounts);
  const concernAdvisory = advisoryForMission(concernDetail, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    values: { needsReview: 'YES', objectiveSatisfied: 'NO', shouldContinue: 'YES' },
  });
  assert.equal(concernAdvisory.disposition, 'MULTIPLE_CONCERNS');
  currentObserver = readObserver();
  const concernDecision = observerDecision(currentObserver, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    missionId: concernMission.id,
  });
  assert.equal(currentObserver.decisions.length, concernBefore.decisions.length + 1);
  assert.equal(currentObserver.modelCalls.length, concernBefore.modelCalls.length + 1);
  soloConcernFacts = {
    missionId: concernMission.id,
    runId: concernDetail.runs.at(-1)?.id,
    actorId: actorA.teammateId,
    missionState: concernDetail.mission.state,
    resultHash: hash(concernDetail.runs.at(-1)?.resultText ?? ''),
    modelCalls: concernModelCounts.modelCalls,
    toolCalls: concernModelCounts.toolCalls,
    approvalCount: concernModelCounts.approvals,
    collaborationCount: concernModelCounts.collaborations,
    advisory: safeDecision(concernDecision),
  };
  missionIdsForRestart.push(concernMission.id);

  await setCloudEnabled(page, false);
  const cloudOffMission = await createMission(
    page,
    actorA,
    `R5.5 Cloud off ${shortId}`,
    satisfiedObjective,
  );
  const cloudOffBefore = observerSnapshot();
  const cloudOffDetail = await startMission(page, cloudOffMission.id);
  assert.equal(cloudOffDetail.mission.state, 'COMPLETED');
  const cloudOffModelCounts = modelAndToolCounts(cloudOffDetail);
  assert.deepEqual(cloudOffModelCounts, satisfiedModelCounts);
  const fallbackAdvisory = advisoryForMission(cloudOffDetail, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    values: {
      needsReview: 'UNCERTAIN',
      objectiveSatisfied: 'UNCERTAIN',
      shouldContinue: 'UNCERTAIN',
    },
  });
  assert.equal(fallbackAdvisory.disposition, 'NO_ADVISORY');
  assert.equal(fallbackAdvisory.mode, 'DETERMINISTIC_FALLBACK');
  currentObserver = readObserver();
  assert.equal(currentObserver.decisions.length, cloudOffBefore.decisions.length);
  assert.equal(
    currentObserver.modelCalls.length,
    cloudOffBefore.modelCalls.length + cloudOffModelCounts.modelCalls,
    'Cloud-off still records the ordinary FakeModel call while skipping the advisory decision call',
  );
  assert.ok(
    currentObserver.receipts.length > cloudOffBefore.receipts.length,
    'Cloud-off Mission must retain a deterministic fallback receipt',
  );
  assert.equal(
    hash(cloudOffDetail.runs.at(-1)?.resultText ?? ''),
    soloSatisfiedFacts.resultHash,
    'Cloud-off must preserve the exact R5.4 FakeModel final result',
  );
  cloudOffFacts = {
    missionId: cloudOffMission.id,
    runId: cloudOffDetail.runs.at(-1)?.id,
    actorId: actorA.teammateId,
    missionState: cloudOffDetail.mission.state,
    modelCalls: cloudOffModelCounts.modelCalls,
    toolCalls: cloudOffModelCounts.toolCalls,
    decisionCountUnchanged: currentObserver.decisions.length === cloudOffBefore.decisions.length,
    ordinaryModelCallCount: cloudOffModelCounts.modelCalls,
    fallbackReceipt: safeDecision(fallbackAdvisory),
    baselineResultHashEqual: true,
  };
  missionIdsForRestart.push(cloudOffMission.id);
  await setCloudEnabled(page, true);

  const inconsistentMission = await createMission(
    page,
    actorA,
    `R5.5 inconsistent ${shortId}`,
    inconsistentObjective,
  );
  const inconsistentDetail = await startMission(page, inconsistentMission.id);
  assert.equal(inconsistentDetail.mission.state, 'COMPLETED');
  const inconsistentAdvisory = advisoryForMission(inconsistentDetail, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    values: { needsReview: 'NO', objectiveSatisfied: 'YES', shouldContinue: 'YES' },
  });
  assert.ok(['INCONSISTENT', 'MULTIPLE_CONCERNS'].includes(inconsistentAdvisory.disposition));
  const inconsistentModelCounts = modelAndToolCounts(inconsistentDetail);
  assert.deepEqual(inconsistentModelCounts, satisfiedModelCounts);
  currentObserver = readObserver();
  const inconsistentDecision = observerDecision(currentObserver, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    missionId: inconsistentMission.id,
  });
  inconsistentFacts = {
    missionId: inconsistentMission.id,
    runId: inconsistentDetail.runs.at(-1)?.id,
    actorId: actorA.teammateId,
    missionState: inconsistentDetail.mission.state,
    modelCalls: inconsistentModelCounts.modelCalls,
    toolCalls: inconsistentModelCounts.toolCalls,
    advisory: safeDecision(inconsistentDecision),
    stateUnaffected: true,
  };
  missionIdsForRestart.push(inconsistentMission.id);
  assert.equal(tableCount('missions'), missionCountBeforeSolo + 4);
  assert.equal(tableCount('parties'), partyCountBeforeSolo);

  await addPrivateContext(page, actors);
  const partyCountBeforeParty = tableCount('parties');
  const missionCountBeforeParty = tableCount('missions');
  const party = await createParty(page, actors);
  const partyMission = await createMission(
    page,
    actorA,
    `R5.5 Party Review ${shortId}`,
    `Review the bounded public draft. [R55_SATISFIED] ${shortId}`,
    { partyId: party.id, mode: 'REVIEW' },
  );
  const beforeParty = observerSnapshot();
  await page.evaluate(
    (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
    partyMission.id,
  );
  let partyPending = await missionDetail(page, partyMission.id);
  const request = partyPending.collaborations?.find((item) => item.state === 'PENDING');
  assert.ok(request, 'Review Party must ask the participant to review the draft');
  assert.equal(request.targetTeammateId, actorB.teammateId);
  assert.equal(partyPending.approvals?.length ?? 0, 0);
  const afterDraft = advisoryForMission(partyPending, {
    actorId: actorA.teammateId,
    phase: 'COORDINATOR',
    values: { needsReview: 'NO', objectiveSatisfied: 'YES', shouldContinue: 'NO' },
  });
  const participantStart = await page.evaluate(
    (requestId) =>
      window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
    request.id,
  );
  assert.ok(participantStart?.mission);
  const partyDetail = await waitForMissionTerminal(page, partyMission.id);
  assert.equal(partyDetail.mission.state, 'COMPLETED');
  assert.equal(partyDetail.mission.mode, 'REVIEW');
  assert.equal(partyDetail.approvals?.length ?? 0, 0);
  assert.equal(
    partyDetail.collaborations?.find((item) => item.id === request.id)?.state,
    'APPROVED',
  );
  const participantAdvisory = advisoryForMission(partyDetail, {
    actorId: actorB.teammateId,
    phase: 'PARTICIPANT',
    values: { needsReview: 'NO', objectiveSatisfied: 'YES', shouldContinue: 'NO' },
  });
  const synthesisAdvisory = advisoryForMission(partyDetail, {
    actorId: actorA.teammateId,
    phase: 'SYNTHESIS',
    values: { needsReview: 'NO', objectiveSatisfied: 'YES', shouldContinue: 'NO' },
  });
  assert.equal(
    advisoryEvents(partyDetail).length,
    3,
    'Party Review must produce one Coordinator, Participant, and Synthesis advisory',
  );
  const partyEventJson = JSON.stringify(advisoryEvents(partyDetail).map(({ payload }) => payload));
  for (const marker of privateMarkers)
    assert.equal(
      partyEventJson.includes(marker),
      false,
      'Advisory events must omit private context',
    );
  const partyModelCounts = modelAndToolCounts(partyDetail);
  assert.equal(partyModelCounts.toolCalls, 0);
  assert.equal(partyModelCounts.approvals, 0);
  assert.equal(tableCount('parties'), partyCountBeforeParty + 1);
  assert.equal(tableCount('missions'), missionCountBeforeParty + 1);
  currentObserver = readObserver();
  const partyDecisions = [
    observerDecision(currentObserver, {
      actorId: actorA.teammateId,
      phase: 'COORDINATOR',
      missionId: partyMission.id,
    }),
    observerDecision(currentObserver, {
      actorId: actorB.teammateId,
      phase: 'PARTICIPANT',
      missionId: partyMission.id,
    }),
    observerDecision(currentObserver, {
      actorId: actorA.teammateId,
      phase: 'SYNTHESIS',
      missionId: partyMission.id,
    }),
  ];
  assert.deepEqual(afterDraft.values, partyDecisions[0].values);
  assert.deepEqual(participantAdvisory.values, partyDecisions[1].values);
  assert.deepEqual(synthesisAdvisory.values, partyDecisions[2].values);
  assert.equal(currentObserver.decisions.length, beforeParty.decisions.length + 3);
  assert.equal(currentObserver.modelCalls.length, beforeParty.modelCalls.length + 3);
  assertObserverPrivacy(currentObserver);
  const g3Outcome = readG3LanguageOutcome(partyMission.id, actorB.teammateId);
  assert.equal(g3Outcome.consumed, true, 'G3 owns completion and consumes its structured RESULT');
  g3Facts = {
    missionId: partyMission.id,
    taskId: g3Outcome.taskId,
    attemptId: g3Outcome.attemptId,
    outcomeId: g3Outcome.id,
    participantTeammateId: actorB.teammateId,
    executionProtocol: g3Outcome.executionProtocol,
    structuredOutcomeKind: g3Outcome.kind,
    structuredOutcomeHash: g3Outcome.outcomeHash,
    publicResultBytes: g3Outcome.publicResultBytes,
    consumed: g3Outcome.consumed,
    continuationCount: g3Outcome.continuationCount,
    advisoryValues: participantAdvisory.values,
    outcomeUnaffectedByAdvisory: true,
  };
  partyFacts = {
    missionId: partyMission.id,
    runId: partyDetail.runs.at(-1)?.id,
    partyId: party.id,
    coordinatorTeammateId: actorA.teammateId,
    participantTeammateId: actorB.teammateId,
    partyState: partyDetail.mission.state,
    collaborationState: 'APPROVED',
    modelCalls: partyModelCounts.modelCalls,
    toolCalls: partyModelCounts.toolCalls,
    approvalCount: partyModelCounts.approvals,
    advisories: partyDecisions.map((item) => ({
      type: item.type,
      actorId: item.actorId,
      phase: item.phase,
      missionId: item.missionId,
      values: item.values,
      disposition: item.disposition,
      hashes: item.hashes,
      bytes: item.bytes,
      forbiddenDataSeen: item.forbiddenDataSeen,
    })),
    actorIsolation: true,
    privateMemoryAndSkillAbsentFromObserver: true,
  };
  missionIdsForRestart.push(partyMission.id);

  const outputInvalid = await startWorkflow(page, 'r55-fixture-output-invalid');
  const invalidStep = workflowMissionStep(outputInvalid, 'draft');
  assert.equal(outputInvalid.run.state, 'WAITING');
  assert.equal(invalidStep.state, 'WAITING');
  const invalidMission = await missionDetail(page, invalidStep.missionId);
  assert.equal(invalidMission.mission.state, 'COMPLETED');
  assert.ok(
    outputInvalid.validations.some(
      (item) => item.stepRunId === invalidStep.id && item.valid === false,
    ),
    'A deterministic output contract failure must remain invalid when Jev says satisfied',
  );
  const invalidAdvisory = advisoryForMission(invalidMission, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    values: { needsReview: 'NO', objectiveSatisfied: 'YES', shouldContinue: 'NO' },
  });
  assert.deepEqual(invalidAdvisory.values, {
    needsReview: 'NO',
    objectiveSatisfied: 'YES',
    shouldContinue: 'NO',
  });
  const invalidModelCounts = modelAndToolCounts(invalidMission);
  assert.equal(invalidModelCounts.modelCalls, 1);
  assert.equal(invalidModelCounts.toolCalls, 0);
  workflowInvalidFacts = {
    workflowRunId: outputInvalid.run.id,
    workflowState: outputInvalid.run.state,
    stepRunId: invalidStep.id,
    stepId: invalidStep.stepId,
    stepState: invalidStep.state,
    stepWaitReason: invalidStep.waitReason ?? null,
    missionId: invalidStep.missionId,
    missionState: invalidMission.mission.state,
    invalidValidationReceiptCount: outputInvalid.validations.filter(
      (item) => item.stepRunId === invalidStep.id && item.valid === false,
    ).length,
    advisory: safeDecision(
      observerDecision(readObserver(), {
        actorId: actorA.teammateId,
        phase: 'SOLO',
        missionId: invalidStep.missionId,
      }),
    ),
    deterministicValidationWon: true,
  };
  missionIdsForRestart.push(invalidStep.missionId);

  const reviewWorkflow = await startWorkflow(page, 'r55-fixture-review-revise');
  const reviewStep = workflowMissionStep(reviewWorkflow, 'review');
  assert.equal(reviewWorkflow.run.state, 'WAITING');
  assert.equal(reviewStep.state, 'WAITING');
  const reviewMission = await missionDetail(page, reviewStep.missionId);
  assert.equal(reviewMission.mission.state, 'COMPLETED');
  const reviewArtifact = reviewWorkflow.artifacts.find(
    (item) => item.producerStepRunId === reviewStep.id && item.kind === 'JSON',
  );
  assert.ok(
    reviewArtifact,
    'Deterministic REVIEW output must remain available for trusted parsing',
  );
  const review = JSON.parse(reviewArtifact.content);
  assert.equal(review.verdict, 'REVISE');
  const reviewAdvisory = advisoryForMission(reviewMission, {
    actorId: actorA.teammateId,
    phase: 'SOLO',
    values: { needsReview: 'NO', objectiveSatisfied: 'YES', shouldContinue: 'NO' },
  });
  assert.deepEqual(reviewAdvisory.values, {
    needsReview: 'NO',
    objectiveSatisfied: 'YES',
    shouldContinue: 'NO',
  });
  assert.equal(
    reviewWorkflow.steps.length,
    2,
    'REVISE must not invent an undeclared follow-up Step',
  );
  workflowReviewFacts = {
    workflowRunId: reviewWorkflow.run.id,
    workflowState: reviewWorkflow.run.state,
    stepRunId: reviewStep.id,
    stepId: reviewStep.stepId,
    stepState: reviewStep.state,
    stepWaitReason: reviewStep.waitReason ?? null,
    missionId: reviewStep.missionId,
    missionState: reviewMission.mission.state,
    deterministicReviewVerdict: review.verdict,
    reviewArtifactHash: reviewArtifact.contentHash,
    nextStepCount: reviewWorkflow.steps.filter((item) => item.state !== 'PENDING').length,
    advisory: safeDecision(
      observerDecision(readObserver(), {
        actorId: actorA.teammateId,
        phase: 'SOLO',
        missionId: reviewStep.missionId,
      }),
    ),
    deterministicReviewWon: true,
  };
  missionIdsForRestart.push(reviewStep.missionId);

  const outcomeBeforeRestart = readG3LanguageOutcome(partyMission.id, actorB.teammateId);
  const observerBeforeRestart = readObserver();
  const eventCountsBeforeRestart = missionEventCounts(missionIdsForRestart);
  const decisionsBeforeRestart = observerBeforeRestart.decisions.length;
  const adviceCallsBeforeRestart = observerBeforeRestart.modelCalls.length;
  await app.close();
  live = await launch(fixtureProfile, fixtureArgs);
  const restartedObserver = readObserver();
  assert.deepEqual(restartedObserver, observerBeforeRestart);
  assert.equal(restartedObserver.decisions.length, decisionsBeforeRestart);
  assert.equal(restartedObserver.modelCalls.length, adviceCallsBeforeRestart);
  assert.deepEqual(missionEventCounts(missionIdsForRestart), eventCountsBeforeRestart);
  const outcomeAfterRestart = readG3LanguageOutcome(partyMission.id, actorB.teammateId);
  assert.deepEqual(outcomeAfterRestart, outcomeBeforeRestart);
  const restartedSatisfied = await missionDetail(live.page, satisfiedMission.id);
  assert.equal(restartedSatisfied.mission.state, 'COMPLETED');
  restartFacts = {
    completedMissionId: satisfiedMission.id,
    decisionCountBefore: decisionsBeforeRestart,
    decisionCountAfter: restartedObserver.decisions.length,
    advisoryCallCountBefore: adviceCallsBeforeRestart,
    advisoryCallCountAfter: restartedObserver.modelCalls.length,
    eventCountsUnchanged: true,
    g3OutcomeHashUnchanged: outcomeAfterRestart.outcomeHash === outcomeBeforeRestart.outcomeHash,
    repeatedAdvisory: false,
    repeatedModelCall: false,
    repeatedToolCall: false,
  };
  observer = restartedObserver;
  assertObserverPrivacy(observer);
  fixtureMigrations = assertMigrations(fixtureProfile);
  assert.deepEqual(fixtureMigrations, productionMigrations);
  assert.equal(existsSync(productionFactsPath), false);
  screenshots = await capturePrivacy(live.page, live.app);
} finally {
  await live.app.close().catch(() => undefined);
}

observer = readObserver();
assertObserverPrivacy(observer);
assert.equal(existsSync(productionFactsPath), false);
assert.equal(tableCount('approval_requests'), 0, 'R5.5 fixtures must not create hidden approvals');

const observerJson = JSON.stringify(observer);
for (const rawValue of rawValues)
  assert.equal(
    observerJson.includes(rawValue),
    false,
    'Observer facts must exclude raw/private data',
  );

const evidence = {
  runId,
  verifiedAt: new Date().toISOString(),
  package: { executable: relative(root, executablePath) },
  production: {
    normalLaunch: true,
    fixtureObserverFile: false,
    officialWorkflowHashes: productionHashes,
    migrations: productionMigrations,
  },
  fixture: {
    flags: fixtureArgs,
    officialWorkflowHashes: fixtureWorkflowHashes,
    officialHashesUnchanged: true,
    fixtureWorkflowIds,
    actors,
    soloSatisfied: soloSatisfiedFacts,
    soloConcern: soloConcernFacts,
    cloudOffFallback: cloudOffFacts,
    inconsistentAdvisory: inconsistentFacts,
    partyActorIsolation: partyFacts,
    workflowValidationConflict: workflowInvalidFacts,
    workflowReviewConflict: workflowReviewFacts,
    g3StructuredOutcome: g3Facts,
    restartNoReplay: restartFacts,
    observer: {
      decisions: observer.decisions.map((item) => safeDecision(item)),
      modelCalls: observer.modelCalls.map((item) => ({
        teammateId: item.teammateId,
        runtimeProfileId: item.runtimeProfileId,
        method: item.method,
        structured: item.structured,
      })),
      receipts: observer.receipts.length,
    },
    migrations: fixtureMigrations,
    privacyScreenshots: screenshots,
  },
};
const evidenceJson = JSON.stringify(evidence);
for (const rawValue of rawValues)
  assert.equal(
    evidenceJson.includes(rawValue),
    false,
    'Evidence must exclude raw/private data and keys',
  );
assert.equal(
  evidenceJson.includes('outcomeJson'),
  false,
  'Evidence must exclude G3 outcome bodies',
);
assert.equal(evidenceJson.includes('schema'), false, 'Evidence must exclude schema content');

mkdirSync(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, 'facts.json');
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`R5_5_PACKAGED_EVIDENCE ${evidencePath}`);
console.log(
  `R5_5_PACKAGED_SMOKE_OK production=fixture_free solo=satisfied_concern_cloud_off_inconsistent party=actor_isolated workflow=validation_and_review_advisory_conflict g3=structured_result_preserved restart=no_replay privacy_widths=1440,1180,900 evidence=${evidencePath}`,
);
