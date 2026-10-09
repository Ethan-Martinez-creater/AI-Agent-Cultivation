import { navigateUi } from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';

const root = process.cwd();
const nonce = randomUUID();
const profileRoot = join(root, '.test-data', `r5-4-packaged-${nonce}`);
const productionProfile = join(profileRoot, 'production');
const fixtureProfile = join(profileRoot, 'fixture');
const workspaceRoot = join(root, '.test-data', `r5-4-workspace-${nonce}`);
const evidenceDir = join(root, 'docs', 'evidence', 'r5-4-tool-shortlist', nonce);
const productionFactsPath = join(productionProfile, 'r5-4-execution-facts.json');
const fixtureFactsPath = join(fixtureProfile, 'r5-4-execution-facts.json');
const databasePath = join(fixtureProfile, 'data', 'cultivation.sqlite');
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const mcpFixturePath = join(root, 'scripts', 'fixtures', 'r5-4-mcp-server.mjs');
const officialWorkflowIds = [
  'official.ai-news-video',
  'official.research',
  'official.software-feature',
];
const fixtureArgs = [
  '--gate1-fake-model',
  '--r5-4-fixture',
  '--r4-fake-routing',
  '--w1-fake-workflow',
  '--r5-1-fixture',
];
const inputText = `R54_READ_CONTENT_${nonce}`;

assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);
assert.ok(existsSync(mcpFixturePath), `MCP fixture not found: ${mcpFixturePath}`);
assert.equal(existsSync(profileRoot), false, 'R5.4 needs fresh isolated app profiles');
assert.equal(existsSync(workspaceRoot), false, 'R5.4 needs a fresh isolated Workspace');

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
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function snapshotWorkflowVersions(versions, { production = false } = {}) {
  const official = versions
    .filter((item) => officialWorkflowIds.includes(item.definition.id))
    .sort((left, right) => left.definition.id.localeCompare(right.definition.id));
  assert.deepEqual(
    official.map((item) => item.definition.id),
    [...officialWorkflowIds].sort(),
    'All three official frozen Workflow definitions must remain registered',
  );
  if (production) {
    assert.deepEqual(
      versions.map((item) => item.definition.id).sort(),
      [...officialWorkflowIds].sort(),
      'Normal packaged launch must expose no R5.4 or other fixture Workflow',
    );
  } else {
    assert.ok(
      versions.some((item) => item.definition.id === 'r54-fixture-tools' && item.version === 1),
      'Only the explicit R5.4 fixture launch may publish its USER Workflow',
    );
    assert.ok(
      versions.some((item) => item.definition.id === 'w1-fixture-sequence' && item.version === 1),
      'The explicit W1 workflow fixture must be available for startup compatibility',
    );
  }
  return Object.fromEntries(official.map((item) => [item.definition.id, hash(item)]));
}

function openReadOnlyDatabase(profile, fn) {
  assert.ok(
    profile === productionProfile || profile === fixtureProfile,
    'Database audits must stay inside this run’s isolated project-local profiles',
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

function missionEvents(missionId) {
  return openReadOnlyDatabase(fixtureProfile, (db) =>
    db
      .prepare(
        `SELECT event_type AS eventType, actor_id AS actorId, run_id AS runId, payload_json AS payloadJson
         FROM mission_events WHERE mission_id = ? ORDER BY created_at, id`,
      )
      .all(missionId)
      .map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) })),
  );
}

function missionToolResults(missionId) {
  return missionEvents(missionId).filter((event) => event.eventType === 'tool.result');
}

function missionSelections(missionId) {
  return missionEvents(missionId)
    .filter((event) => event.eventType === 'tool.selection')
    .map((event) => event.payload);
}

function selectionForActor(missionId, teammateId) {
  const selection = missionSelections(missionId).find((item) => item.actorId === teammateId);
  assert.ok(
    selection,
    `Mission ${missionId} must persist a tool shortlist receipt for ${teammateId}`,
  );
  assert.equal(selection.mode, 'JEV');
  assert.equal(selection.reason, 'JEV_RERANKED');
  assert.ok(Array.isArray(selection.eligibleIds));
  assert.ok(Array.isArray(selection.candidateIds));
  assert.ok(Array.isArray(selection.offeredIds));
  assert.equal(selection.eligibleCount, selection.eligibleIds.length);
  assert.equal(selection.candidateCount, selection.candidateIds.length);
  assert.equal(selection.offeredCount, selection.offeredIds.length);
  return selection;
}

function safeSelection(selection) {
  return {
    actorId: selection.actorId,
    phase: selection.phase,
    eligibleCount: selection.eligibleCount,
    eligibleIds: selection.eligibleIds,
    candidateCount: selection.candidateCount,
    candidateIds: selection.candidateIds,
    offeredCount: selection.offeredCount,
    offeredIds: selection.offeredIds,
    mode: selection.mode,
    reason: selection.reason,
    stateBytes: selection.stateBytes,
    requestBytes: selection.requestBytes,
    responseBytes: selection.responseBytes,
    stateHash: selection.stateHash,
    policyVersion: selection.policyVersion,
    questionVersion: selection.questionVersion,
    fingerprints: selection.fingerprints,
    scores: selection.scores,
  };
}

function encodeExactResource(resource) {
  let encoded = '';
  for (let index = 0; index < resource.length; index += 1)
    encoded += resource.charCodeAt(index).toString(16).padStart(4, '0');
  return `\u0000cultivation.exact-resource.v1:${encoded}`;
}

function decodeExactResource(pattern) {
  const prefix = '\u0000cultivation.exact-resource.v1:';
  if (!pattern.startsWith(prefix)) return null;
  const encoded = pattern.slice(prefix.length);
  if (encoded.length % 4 !== 0 || !/^[a-f0-9]*$/u.test(encoded)) return null;
  let resource = '';
  for (let index = 0; index < encoded.length; index += 4)
    resource += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16));
  return resource;
}

function insertMissionPermissionDeny(missionId, teammateId, resource) {
  assert.ok(missionId && teammateId && resource);
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.prepare(
      `INSERT INTO permission_rules
        (id, subject_type, subject_id, capability, resource_pattern, decision, scope, scope_id)
       VALUES (?, 'TEAMMATE', ?, 'FILE_READ', ?, 'DENY', 'MISSION', ?)`,
    ).run(randomUUID(), teammateId, encodeExactResource(resource), missionId);
  } finally {
    db.close();
  }
}

function missionPermissionRules(missionId, capability) {
  return openReadOnlyDatabase(fixtureProfile, (db) =>
    db
      .prepare(
        `SELECT subject_type AS subjectType, subject_id AS subjectId, capability,
                resource_pattern AS resourcePattern, decision, scope, scope_id AS scopeId
         FROM permission_rules WHERE scope = 'MISSION' AND scope_id = ? AND capability = ?`,
      )
      .all(missionId, capability),
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

function readObserver(profile = fixtureProfile) {
  const path = join(profile, 'r5-4-execution-facts.json');
  assert.ok(existsSync(path), 'The explicit fixture launch must persist bounded R5.4 facts');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function observerSnapshot() {
  return existsSync(fixtureFactsPath) ? readObserver() : { decisions: [], modelCalls: [] };
}

function pendingApproval(detail, capability, toolId) {
  assert.equal(detail.mission.state, 'WAITING_APPROVAL');
  const approval = detail.approvals.find((item) => item.state === 'PENDING');
  assert.ok(approval, `Mission ${detail.mission.id} should have one pending approval`);
  assert.equal(approval.capability, capability);
  if (toolId) {
    assert.equal(approval.actionType, 'TOOL_CALL');
    assert.equal(approval.actionPayload.toolId, toolId);
  }
  return approval;
}

async function seedActor(page, role) {
  return page.evaluate(
    async ({ role, nonce }) => {
      const api = window.cultivation;
      const provider = await api.providers.create({
        name: `R5.4 ${role} offline LANGUAGE provider ${nonce}`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9999/v1',
      });
      const runtime = await api.runtimes.create({
        name: `R5.4 ${role} sealed LANGUAGE runtime ${nonce}`,
        providerId: provider.id,
        credentialId: null,
        modelId: `r54-language-${role.toLowerCase()}-${nonce.slice(0, 8)}`,
        executionProtocol: 'LANGUAGE',
      });
      if (runtime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.4 actors must use sealed LANGUAGE runtimes');
      const teammate = await api.teammates.create({
        name: role === 'A' ? '观澜' : '明衡',
        avatar: null,
        title: `R5.4 ${role}`,
        description: 'Packaged R5.4 deterministic tool shortlist actor.',
        identityPrompt: `R5.4 sealed LANGUAGE identity ${role} ${nonce}`,
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
      const sealedRuntime = (await api.runtimes.list()).find(
        (item) => item.id === teammate.currentRuntimeProfileId,
      );
      if (!sealedRuntime || sealedRuntime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.4 teammate must remain bound to a LANGUAGE runtime');
      for (const dimension of ['GENERAL_REASONING', 'TOOL_USE']) {
        await api.capability.saveBenchmark({
          runtimeProfileId: sealedRuntime.id,
          modelAlias: sealedRuntime.modelId,
          dimension,
          supported: true,
          normalizedScore: role === 'A' ? 80 : 60,
          rawScore: null,
          source: 'R5.4 deterministic fixture',
          benchmark: 'Acceptance fixture',
          benchmarkVersion: '1',
          snapshotDate: '2026-10-01T00:00:00.000Z',
          sourceUrl: null,
          provenanceType: 'USER_ESTIMATE',
        });
        await api.r2.setCapability({ dimension, enabled: true });
      }
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
  return page.evaluate(
    (id) => window.cultivation.missions.start({ missionId: id, approvalFixture: false }),
    missionId,
  );
}

async function resolveApproval(page, approvalId, decision) {
  return page.evaluate(
    ({ approvalId, decision }) =>
      window.cultivation.missions.resolveApproval({ approvalId, decision }),
    { approvalId, decision },
  );
}

function requireModelProposal(observer, offset, actor, toolId, expectedOffered = true) {
  const candidate = observer.modelCalls
    .slice(offset)
    .find((call) => call.teammateId === actor.teammateId && call.proposedIds?.includes(toolId));
  assert.ok(candidate, `Expected a model proposal for ${toolId} by ${actor.teammateId}`);
  assert.equal(candidate.runtimeProfileId, actor.runtimeProfileId);
  assert.equal(candidate.offeredIds.includes(toolId), expectedOffered);
  return candidate;
}

function assertMissionUsage(detail, actor, runId) {
  const usage = detail.usage.filter((item) => item.teammateId === actor.teammateId);
  assert.ok(usage.length > 0, `Expected model usage for ${actor.teammateId}`);
  for (const record of usage) {
    assert.equal(record.missionId, detail.mission.id);
    assert.equal(record.runId, runId);
    assert.equal(record.runtimeProfileId, actor.runtimeProfileId);
  }
}

function assertObserverPrivacy(observer, rawValues) {
  assert.ok(Array.isArray(observer.decisions));
  assert.ok(Array.isArray(observer.modelCalls));
  assert.ok(observer.modelCalls.length > 0);
  for (const decision of observer.decisions) {
    assert.equal(decision.decisionType, 'TOOL_RELEVANCE');
    assert.equal(decision.forbiddenDataSeen, false);
    assert.ok(Array.isArray(decision.stateFields));
    assert.ok(Array.isArray(decision.questionKeys));
    assert.ok(Array.isArray(decision.candidateIds));
    assert.ok(Array.isArray(decision.candidateFields));
    assert.equal(decision.candidateIds.length, decision.candidateFields.length);
    assert.ok(decision.stateBytes <= 16_000);
    assert.ok(decision.requestBytes <= 30_000);
    assert.ok(decision.responseBytes <= 16_000);
    for (const fields of decision.candidateFields)
      assert.ok(
        fields.every((field) =>
          [
            'id',
            'name',
            'description',
            'source',
            'riskLevel',
            'sideEffect',
            'capability',
            'workflowPurposes',
            'inputShape',
          ].includes(field),
        ),
      );
  }
  const serialized = JSON.stringify(observer);
  for (const value of rawValues) assert.equal(serialized.includes(value), false);
}

async function captureRoutingPrivacy(page, app) {
  await navigateUi(page, '设置 Settings');
  await page.getByRole('tab', { name: '智能分配', exact: true }).click();
  await page.getByText('数据范围与策略', { exact: true }).click();
  await page
    .getByText(/已确定可候选的工具名称、有限描述、来源、风险\/副作用和能力元数据/)
    .waitFor();
  await page.getByText(/MCP env/).waitFor();
  await page.getByText(/工具推荐不授予 Permission/).waitFor();
  mkdirSync(evidenceDir, { recursive: true });
  const screenshots = [];
  for (const width of [1440, 1180, 900]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: window.document.documentElement.scrollWidth,
      disclosureText: window.document.body.innerText.replace(/\s+/gu, ' ').trim(),
    }));
    assert.ok(
      layout.disclosureText.includes(
        '还可能发送当前任务中已确定可候选的工具名称、有限描述、来源、风险/副作用和能力元数据。',
      ),
    );
    assert.ok(
      layout.disclosureText.includes(
        '不发送 API Key 或其他凭据、完整私有记忆、完整文件、完整聊天记录、工具输出或 Tool secret 或 MCP env。工具推荐不授予 Permission。Jev 不会获得审批权限，也不会覆盖用户明确指定的道友或队伍。',
      ),
    );
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1);
    const name = `routing-tool-shortlist-privacy-${width}.png`;
    await page.screenshot({
      path: join(evidenceDir, name),
      fullPage: true,
      animations: 'disabled',
    });
    const layoutPath = join(evidenceDir, `routing-tool-shortlist-privacy-${width}-layout.json`);
    writeFileSync(
      layoutPath,
      `${JSON.stringify({ width, height: 900, ...layout }, null, 2)}\n`,
      'utf8',
    );
    screenshots.push({
      name,
      layoutFile: name.replace('.png', '-layout.json'),
      width,
      height: 900,
    });
  }
  return screenshots;
}

let productionHashes;
let productionMigrations;
let actors;
let builtinIds;
let stableRegistryOrder;
let mcpServerId;
let toolIds;
let readRestartFacts;
let writeFacts;
let excludedFacts;
let mcpFacts;
let partyFacts;
let workflowFacts;
let cloudOffFacts;
let permissionDenyFacts;
let screenshots = [];
let fixtureMigrations;
let observer;

{
  const live = await launch(productionProfile);
  try {
    const boot = await live.page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
    }));
    productionHashes = snapshotWorkflowVersions(boot.versions, { production: true });
    assert.equal(boot.routing.cloudEnabled, false);
    assert.equal(
      existsSync(productionFactsPath),
      false,
      'Normal production launch must not create an R5.4 fixture observer',
    );
  } finally {
    await live.app.close();
  }
}
productionMigrations = assertMigrations(productionProfile);

mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(workspaceRoot, 'r54-input.txt'), inputText, 'utf8');

let live = await launch(fixtureProfile, fixtureArgs);
let restartMissionId;
let restartApprovalId;
let restartRunId;
let restartResource;
try {
  const { app, page } = live;
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, workspaceRoot);
  const workspace = await page.evaluate(() => window.cultivation.tools.chooseWorkspace());
  assert.equal(resolve(workspace.rootPath), resolve(realpathSync(workspaceRoot)));
  builtinIds = (await page.evaluate(() => window.cultivation.tools.listBuiltins()))
    .map((tool) => tool.id)
    .sort();
  assert.deepEqual(builtinIds, [
    'file.createDirectory',
    'file.list',
    'file.readText',
    'file.writeText',
  ]);

  const workflowVersions = await page.evaluate(() => window.cultivation.workflows.versions());
  const fixtureHashes = snapshotWorkflowVersions(workflowVersions);
  assert.deepEqual(
    fixtureHashes,
    productionHashes,
    'Explicit R5.4 flags must preserve all official frozen Workflow hashes',
  );
  const fixtureVersionIds = workflowVersions.map((item) => item.definition.id);
  assert.ok(fixtureVersionIds.includes('r54-fixture-tools'));

  const fakeKey = `r54-deterministic-fixture-key-${nonce}`;
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), fakeKey);
  const imported = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
  assert.equal(imported.configured, true);
  assert.equal(JSON.stringify(imported).includes(fakeKey), false);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
  const cloudEnabled = await page.evaluate(() => window.cultivation.routing.setCloudEnabled(true));
  assert.equal(cloudEnabled.cloudEnabled, true);

  const actorA = await seedActor(page, 'A');
  const actorB = await seedActor(page, 'B');
  actors = { a: actorA, b: actorB };
  assert.equal(actorA.executionProtocol, 'LANGUAGE');
  assert.equal(actorB.executionProtocol, 'LANGUAGE');

  const server = await page.evaluate(
    ({ command, args, cwd, nonce }) =>
      window.cultivation.tools.saveMcpServer({
        name: `R5.4 bounded shortlist fixture ${nonce}`,
        command,
        args,
        envWhitelist: [],
        cwd,
        enabled: true,
      }),
    { command: process.execPath, args: [mcpFixturePath], cwd: root, nonce },
  );
  mcpServerId = server.id;
  const discovered = await page.evaluate(
    (id) => window.cultivation.tools.refreshMcpServer(id),
    server.id,
  );
  assert.equal(discovered.status, 'READY');
  assert.equal(discovered.tools.length, 12);
  const initialResearch = discovered.tools.find((tool) => tool.toolName === 'research_read');
  const excluded = discovered.tools.find((tool) => tool.toolName === 'excluded');
  assert.ok(initialResearch && excluded);
  assert.deepEqual(
    initialResearch.workflowPurposes ?? [],
    [],
    'Remote MCP metadata must not establish a trusted local Workflow purpose',
  );
  const mappedResearch = await page.evaluate(
    ({ toolId }) => window.cultivation.tools.setToolPurposes({ toolId, purposes: ['RESEARCH'] }),
    { toolId: initialResearch.id },
  );
  assert.deepEqual(mappedResearch.workflowPurposes, ['RESEARCH']);
  toolIds = {
    read: 'file.readText',
    write: 'file.writeText',
    researchRead: initialResearch.id,
    excluded: excluded.id,
  };
  stableRegistryOrder = [
    'file.list',
    'file.readText',
    'file.writeText',
    'file.createDirectory',
    ...discovered.tools.map((tool) => tool.id),
  ];
  assert.equal(stableRegistryOrder.length, 16);

  const beforeRead = observerSnapshot();
  const readMission = await createMission(
    page,
    actorA,
    `R5.4 read restart ${nonce}`,
    `__R54_READ__ read the approved workspace file`,
  );
  const readStart = await startMission(page, readMission.id);
  const readApproval = pendingApproval(readStart, 'FILE_READ', toolIds.read);
  restartResource = readApproval.actionPayload.resource;
  assert.ok(typeof restartResource === 'string' && restartResource.length > 0);
  restartMissionId = readMission.id;
  restartApprovalId = readApproval.id;
  restartRunId = readStart.runs.at(-1)?.id;
  assert.ok(restartRunId);
  const readProposal = requireModelProposal(
    observerSnapshot(),
    beforeRead.modelCalls.length,
    actorA,
    toolIds.read,
  );
  assert.ok(readProposal.offeredIds.length < stableRegistryOrder.length);
  const readSelection = selectionForActor(readMission.id, actorA.teammateId);
  assert.ok(readSelection.eligibleIds.length > readSelection.offeredIds.length);
  assert.ok(readSelection.offeredIds.includes(toolIds.read));
  assert.ok(readSelection.offeredIds.length <= 8);
  assertMissionUsage(readStart, actorA, restartRunId);
  readRestartFacts = {
    missionId: readMission.id,
    approvalId: readApproval.id,
    runId: restartRunId,
    stateBeforeRestart: readStart.mission.state,
    offeredIds: readProposal.offeredIds,
    receipt: safeSelection(readSelection),
    proposedId: toolIds.read,
  };
} finally {
  if (live?.app) await live.app.close().catch(() => {});
}

live = await launch(fixtureProfile, fixtureArgs);
try {
  let { app, page } = live;
  const persistedWorkspace = await page.evaluate(() => window.cultivation.tools.getWorkspace());
  assert.equal(resolve(persistedWorkspace.rootPath), resolve(realpathSync(workspaceRoot)));
  const recovered = await page.evaluate(
    (id) => window.cultivation.missions.detail(id),
    restartMissionId,
  );
  assert.equal(recovered.mission.state, 'WAITING_APPROVAL');
  assert.equal(
    recovered.runs.at(-1)?.id,
    restartRunId,
    'Approval recovery must retain the same Run',
  );
  const pending = pendingApproval(recovered, 'FILE_READ', toolIds.read);
  assert.equal(pending.id, restartApprovalId);
  assert.equal(pending.missionId, restartMissionId);
  const completed = await resolveApproval(page, restartApprovalId, 'APPROVED');
  assert.equal(completed.mission.state, 'COMPLETED');
  assert.equal(completed.runs.at(-1)?.id, restartRunId);
  assertMissionUsage(completed, actors.a, restartRunId);
  assert.equal(readFileSync(join(workspaceRoot, 'r54-input.txt'), 'utf8'), inputText);
  const readResults = missionToolResults(restartMissionId);
  assert.equal(readResults.length, 1, 'The recovered approved read must execute exactly once');
  assert.equal(readResults[0].payload.toolId, toolIds.read);
  assert.equal(readResults[0].payload.success, true);
  const readObserverAfter = readObserver();
  assertObserverPrivacy(readObserverAfter, [
    inputText,
    'r54-input.txt',
    '交付已完成',
    fakeKeyMarker(),
  ]);
  readRestartFacts = {
    ...readRestartFacts,
    stateAfterRestart: recovered.mission.state,
    stateAfterApproval: completed.mission.state,
    approvalRecovered: pending.id === restartApprovalId,
    runIdPreserved: completed.runs.at(-1)?.id === restartRunId,
    exactReadExecutions: readResults.length,
    readOutputVerified: readResults[0].payload.outputSummary?.bytes > 0,
  };

  const permissionDenyMission = await createMission(
    page,
    actors.a,
    `R5.4 explicit Permission deny ${nonce}`,
    `__R54_READ__ read the denied workspace file`,
  );
  await app.close();
  insertMissionPermissionDeny(permissionDenyMission.id, actors.a.teammateId, restartResource);
  const seededDenyRule = missionPermissionRules(permissionDenyMission.id, 'FILE_READ').find(
    (rule) => rule.subjectId === actors.a.teammateId,
  );
  assert.ok(seededDenyRule);
  assert.equal(seededDenyRule.decision, 'DENY');
  assert.equal(decodeExactResource(seededDenyRule.resourcePattern), restartResource);
  live = await launch(fixtureProfile, fixtureArgs);
  ({ app, page } = live);
  const beforePermissionDeny = observerSnapshot();
  const permissionDenied = await startMission(page, permissionDenyMission.id);
  assert.equal(permissionDenied.mission.state, 'COMPLETED');
  assert.equal(
    permissionDenied.approvals.filter((item) => item.state === 'PENDING').length,
    0,
    'A persisted Permission DENY must not be converted into a user approval request',
  );
  const permissionDeniedResults = missionToolResults(permissionDenyMission.id);
  assert.equal(permissionDeniedResults.length, 1);
  assert.equal(permissionDeniedResults[0].payload.code, 'PERMISSION_DENIED');
  assert.equal(permissionDeniedResults[0].payload.success, false);
  assert.equal(seededDenyRule.subjectType, 'TEAMMATE');
  assert.equal(seededDenyRule.scope, 'MISSION');
  assert.equal(seededDenyRule.scopeId, permissionDenyMission.id);
  assert.equal(seededDenyRule.capability, 'FILE_READ');
  const permissionDenyProposal = requireModelProposal(
    observerSnapshot(),
    beforePermissionDeny.modelCalls.length,
    actors.a,
    toolIds.read,
  );
  const permissionDenySelection = selectionForActor(permissionDenyMission.id, actors.a.teammateId);
  assert.ok(permissionDenyProposal.offeredIds.includes(toolIds.read));
  assert.equal(
    missionEvents(permissionDenyMission.id).some(
      (event) => event.eventType === 'approval.requested',
    ),
    false,
  );
  permissionDenyFacts = {
    missionId: permissionDenyMission.id,
    teammateId: actors.a.teammateId,
    runId: permissionDenied.runs.at(-1)?.id,
    scopedRule: seededDenyRule.scope,
    exactResourceMatch: decodeExactResource(seededDenyRule.resourcePattern) === restartResource,
    offeredIds: permissionDenyProposal.offeredIds,
    receipt: safeSelection(permissionDenySelection),
    code: permissionDeniedResults[0].payload.code,
    toolResultCount: permissionDeniedResults.length,
    approvalCount: permissionDenied.approvals.filter((item) => item.actionType === 'TOOL_CALL')
      .length,
  };

  const deniedMission = await createMission(
    page,
    actors.a,
    `R5.4 denied write ${nonce}`,
    `__R54_WRITE__ write the approved workspace result`,
  );
  const beforeDenied = observerSnapshot();
  const deniedStart = await startMission(page, deniedMission.id);
  const deniedApproval = pendingApproval(deniedStart, 'FILE_WRITE', toolIds.write);
  const denied = await resolveApproval(page, deniedApproval.id, 'DENIED');
  assert.equal(denied.mission.state, 'COMPLETED');
  const deniedOutputAbsent = !existsSync(join(workspaceRoot, 'r54-output.txt'));
  assert.equal(deniedOutputAbsent, true);
  const deniedResults = missionToolResults(deniedMission.id);
  assert.equal(deniedResults.length, 1);
  assert.equal(deniedResults[0].payload.code, 'PERMISSION_DENIED');
  const deniedProposal = requireModelProposal(
    observerSnapshot(),
    beforeDenied.modelCalls.length,
    actors.a,
    toolIds.write,
  );
  assert.ok(deniedProposal.offeredIds.includes(toolIds.write));
  const deniedSelection = selectionForActor(deniedMission.id, actors.a.teammateId);

  const approvedWriteMission = await createMission(
    page,
    actors.a,
    `R5.4 approved write ${nonce}`,
    `__R54_WRITE__ write the approved workspace result`,
  );
  const beforeWrite = observerSnapshot();
  const writeStart = await startMission(page, approvedWriteMission.id);
  const writeApproval = pendingApproval(writeStart, 'FILE_WRITE', toolIds.write);
  const writeDone = await resolveApproval(page, writeApproval.id, 'APPROVED');
  assert.equal(writeDone.mission.state, 'COMPLETED');
  assert.equal(readFileSync(join(workspaceRoot, 'r54-output.txt'), 'utf8'), '交付已完成');
  const writeResults = missionToolResults(approvedWriteMission.id);
  assert.equal(writeResults.length, 1);
  assert.equal(writeResults[0].payload.toolId, toolIds.write);
  assert.equal(writeResults[0].payload.success, true);
  const writeProposal = requireModelProposal(
    observerSnapshot(),
    beforeWrite.modelCalls.length,
    actors.a,
    toolIds.write,
  );
  const approvedWriteSelection = selectionForActor(approvedWriteMission.id, actors.a.teammateId);
  writeFacts = {
    denied: {
      missionId: deniedMission.id,
      approvalId: deniedApproval.id,
      toolResults: deniedResults.length,
      outputAbsent: deniedOutputAbsent,
      deniedCode: deniedResults[0].payload.code,
      receipt: safeSelection(deniedSelection),
    },
    approved: {
      missionId: approvedWriteMission.id,
      approvalId: writeApproval.id,
      offeredIds: writeProposal.offeredIds,
      receipt: safeSelection(approvedWriteSelection),
      toolResults: writeResults.length,
      outputMatches: true,
    },
  };

  const excludedMission = await createMission(
    page,
    actors.a,
    `R5.4 not offered ${nonce}`,
    `__R54_NOT_OFFERED__ read the approved workspace file`,
  );
  const beforeExcluded = observerSnapshot();
  const excludedStart = await startMission(page, excludedMission.id);
  assert.equal(excludedStart.mission.state, 'COMPLETED');
  assert.equal(excludedStart.approvals.filter((item) => item.actionType === 'TOOL_CALL').length, 0);
  const excludedProposal = requireModelProposal(
    observerSnapshot(),
    beforeExcluded.modelCalls.length,
    actors.a,
    toolIds.excluded,
    false,
  );
  const excludedEvents = missionEvents(excludedMission.id);
  const excludedSelection = selectionForActor(excludedMission.id, actors.a.teammateId);
  assert.ok(excludedSelection.eligibleIds.length > excludedSelection.offeredIds.length);
  assert.equal(excludedSelection.offeredIds.includes(toolIds.excluded), false);
  const offerFailure = excludedEvents.find(
    (event) =>
      event.eventType === 'tool.offer_checked' && event.payload.toolId === toolIds.excluded,
  );
  assert.ok(offerFailure, 'The unoffered descriptor proposal must be rejected before dispatch');
  assert.equal(offerFailure.payload.offered, false);
  assert.equal(offerFailure.payload.code, 'TOOL_NOT_OFFERED');
  const excludedResults = missionToolResults(excludedMission.id);
  assert.equal(
    excludedResults.filter((event) => event.payload.code === 'TOOL_NOT_OFFERED').length,
    1,
  );
  assert.equal(
    excludedResults.some((event) => event.payload.success === true),
    false,
  );
  excludedFacts = {
    missionId: excludedMission.id,
    proposedId: toolIds.excluded,
    excludedFromOfferedIds: !excludedProposal.offeredIds.includes(toolIds.excluded),
    errorCode: offerFailure.payload.code,
    receipt: safeSelection(excludedSelection),
    approvalCount: 0,
    successfulToolResults: 0,
  };

  const mcpMission = await createMission(
    page,
    actors.a,
    `R5.4 MCP read ${nonce}`,
    `__R54_MCP__ research read approved literature sources`,
  );
  const beforeMcp = observerSnapshot();
  const mcpStart = await startMission(page, mcpMission.id);
  const mcpApproval = pendingApproval(mcpStart, 'MCP_TOOL_EXECUTE', toolIds.researchRead);
  const mcpDone = await resolveApproval(page, mcpApproval.id, 'APPROVED');
  assert.equal(mcpDone.mission.state, 'COMPLETED');
  const mcpProposal = requireModelProposal(
    observerSnapshot(),
    beforeMcp.modelCalls.length,
    actors.a,
    toolIds.researchRead,
  );
  const mcpResults = missionToolResults(mcpMission.id);
  const mcpSelection = selectionForActor(mcpMission.id, actors.a.teammateId);
  assert.equal(mcpResults.length, 1);
  assert.equal(mcpResults[0].payload.toolId, toolIds.researchRead);
  assert.equal(mcpResults[0].payload.source, 'MCP');
  assert.equal(mcpResults[0].payload.capability, 'MCP_TOOL_EXECUTE');
  assert.equal(mcpResults[0].payload.success, true);
  mcpFacts = {
    missionId: mcpMission.id,
    approvalId: mcpApproval.id,
    serverId: mcpServerId,
    toolId: toolIds.researchRead,
    offeredIds: mcpProposal.offeredIds,
    receipt: safeSelection(mcpSelection),
    resultCount: mcpResults.length,
    source: mcpResults[0].payload.source,
    approved: true,
  };

  const party = await page.evaluate(
    ({ aId, bId, nonce }) =>
      window.cultivation.parties.create({
        name: `R5.4 Party ${nonce}`,
        description: 'Two sealed LANGUAGE actors for exact Mission grant isolation.',
        type: 'FIXED',
        coordinatorTeammateId: aId,
        memberTeammateIds: [aId, bId],
      }),
    { aId: actors.a.teammateId, bId: actors.b.teammateId, nonce },
  );
  const partyMission = await createMission(
    page,
    actors.a,
    `R5.4 Party grant isolation ${nonce}`,
    `__R54_PARTY__ read the approved workspace file`,
    { partyId: party.id, mode: 'REVIEW' },
  );
  const beforeParty = observerSnapshot();
  const partyStart = await startMission(page, partyMission.id);
  const coordinatorApproval = pendingApproval(partyStart, 'FILE_READ', toolIds.read);
  assert.equal(coordinatorApproval.requesterTeammateId, actors.a.teammateId);
  const coordinatorGrant = await resolveApproval(page, coordinatorApproval.id, 'ALLOW_MISSION');
  assert.equal(coordinatorGrant.mission.state, 'WAITING_COLLABORATION');
  assert.equal(coordinatorGrant.runs.at(-1)?.id, partyStart.runs.at(-1)?.id);
  const collaboration = coordinatorGrant.collaborations.find((item) => item.state === 'PENDING');
  assert.ok(collaboration, 'Review fixture must then ask the Party member to review the draft');
  const partyGrantResource = coordinatorApproval.actionPayload.resource;
  assert.ok(typeof partyGrantResource === 'string' && partyGrantResource.length > 0);
  const rulesAfterCoordinatorGrant = missionPermissionRules(partyMission.id, 'FILE_READ');
  assert.ok(
    rulesAfterCoordinatorGrant.some(
      (rule) =>
        rule.subjectType === 'TEAMMATE' &&
        rule.subjectId === actors.a.teammateId &&
        rule.scopeId === partyMission.id &&
        decodeExactResource(rule.resourcePattern) === partyGrantResource &&
        rule.decision === 'ALLOW',
    ),
    'A’s approval must create one exact Mission-scoped read grant',
  );
  assert.equal(
    rulesAfterCoordinatorGrant.some((rule) => rule.subjectId === actors.b.teammateId),
    false,
    'The A grant must not create a Mission read rule for B',
  );

  const partyParticipant = await page.evaluate(
    (requestId) =>
      window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
    collaboration.id,
  );
  assert.equal(partyParticipant.mission.state, 'WAITING_APPROVAL');
  assert.equal(partyParticipant.runs.at(-1)?.id, partyStart.runs.at(-1)?.id);
  const participantApproval = pendingApproval(partyParticipant, 'FILE_READ', toolIds.read);
  assert.equal(participantApproval.requesterTeammateId, actors.b.teammateId);
  assert.equal(participantApproval.actionPayload.resource, partyGrantResource);
  const participantProposal = requireModelProposal(
    observerSnapshot(),
    beforeParty.modelCalls.length,
    actors.b,
    toolIds.read,
  );
  assert.ok(participantProposal.offeredIds.includes(toolIds.read));
  const partyEventsBeforeBApproval = missionEvents(partyMission.id);
  assert.equal(
    partyEventsBeforeBApproval.filter(
      (event) => event.eventType === 'tool.result' && event.actorId === actors.b.teammateId,
    ).length,
    0,
    'B’s tool must remain unexecuted while its own approval is pending',
  );
  const partyDone = await resolveApproval(page, participantApproval.id, 'APPROVED');
  assert.equal(partyDone.mission.state, 'COMPLETED');
  assert.equal(partyDone.runs.at(-1)?.id, partyStart.runs.at(-1)?.id);
  const partyEvents = missionEvents(partyMission.id);
  const participantResults = partyEvents.filter(
    (event) => event.eventType === 'tool.result' && event.actorId === actors.b.teammateId,
  );
  assert.equal(participantResults.length, 1);
  assert.equal(participantResults[0].payload.toolId, toolIds.read);
  assert.equal(participantResults[0].payload.success, true);
  const partyReadSelection = selectionForActor(partyMission.id, actors.a.teammateId);
  const partyParticipantSelection = selectionForActor(partyMission.id, actors.b.teammateId);
  assert.equal(
    partyEvents.filter(
      (event) =>
        event.eventType === 'tool.approval_requested' && event.actorId === actors.a.teammateId,
    ).length,
    1,
    'A’s later synthesis read must use its already approved Mission permission',
  );
  assertMissionUsage(partyDone, actors.a, partyStart.runs.at(-1).id);
  assertMissionUsage(partyDone, actors.b, partyStart.runs.at(-1).id);
  partyFacts = {
    missionId: partyMission.id,
    runId: partyStart.runs.at(-1).id,
    partyId: party.id,
    coordinatorApprovalId: coordinatorApproval.id,
    participantApprovalId: participantApproval.id,
    coordinatorTeammateId: actors.a.teammateId,
    participantTeammateId: actors.b.teammateId,
    exactResourceMatched: participantApproval.actionPayload.resource === partyGrantResource,
    participantAskedSeparately: true,
    coordinatorReceipt: safeSelection(partyReadSelection),
    participantReceipt: safeSelection(partyParticipantSelection),
    participantResultCount: participantResults.length,
    finalState: partyDone.mission.state,
  };

  const workflowCreated = await page.evaluate(() =>
    window.cultivation.workflows.create({ definitionId: 'r54-fixture-tools', version: 1 }),
  );
  const beforeWorkflow = observerSnapshot();
  const workflowStarted = await page.evaluate(
    (runId) => window.cultivation.workflows.advance(runId),
    workflowCreated.run.id,
  );
  const workflowStep = workflowStarted.steps.find((item) => item.stepId === 'read');
  assert.ok(workflowStep?.missionId && workflowStep.missionRunId);
  const workflowMissionStart = await page.evaluate(
    (missionId) => window.cultivation.missions.detail(missionId),
    workflowStep.missionId,
  );
  const workflowApproval = pendingApproval(workflowMissionStart, 'FILE_READ', toolIds.read);
  const workflowModelCall = requireModelProposal(
    observerSnapshot(),
    beforeWorkflow.modelCalls.length,
    actors.a,
    toolIds.read,
  );
  assert.deepEqual(
    workflowModelCall.offeredIds,
    [toolIds.read],
    'The trusted current Workflow Step must hard-filter tools before model generation',
  );
  assert.equal(
    workflowMissionStart.events.some((event) => event.eventType === 'r54.workflow_guard.checked'),
    false,
    'A waiting Mission must not run the Workflow tool guard before approval',
  );
  const workflowMissionDone = await resolveApproval(page, workflowApproval.id, 'APPROVED');
  assert.equal(workflowMissionDone.mission.state, 'COMPLETED');
  assert.equal(workflowMissionDone.runs.at(-1)?.id, workflowStep.missionRunId);
  assert.ok(
    workflowMissionDone.events.some((event) => event.eventType === 'r54.workflow_guard.checked'),
    'The approved call must confirm the trusted current Workflow Mission Step binding',
  );
  const workflowDone = await page.evaluate(
    (runId) => window.cultivation.workflows.advance(runId),
    workflowCreated.run.id,
  );
  assert.equal(workflowDone.run.state, 'COMPLETED');
  const workflowDetail = await page.evaluate(
    (runId) => window.cultivation.workflows.detail(runId),
    workflowCreated.run.id,
  );
  const completedStep = workflowDetail.steps.find((item) => item.stepId === 'read');
  assert.equal(completedStep?.state, 'COMPLETED');
  assert.equal(completedStep?.missionId, workflowStep.missionId);
  assert.equal(completedStep?.missionRunId, workflowStep.missionRunId);
  const workflowResults = missionToolResults(workflowStep.missionId);
  assert.equal(workflowResults.length, 1);
  assert.equal(workflowResults[0].payload.toolId, toolIds.read);
  assert.equal(workflowResults[0].payload.success, true);
  const workflowSelection = selectionForActor(workflowStep.missionId, actors.a.teammateId);
  assert.deepEqual(workflowSelection.eligibleIds, [toolIds.read]);
  assert.deepEqual(workflowSelection.candidateIds, [toolIds.read]);
  assert.deepEqual(workflowSelection.offeredIds, [toolIds.read]);
  workflowFacts = {
    workflowRunId: workflowCreated.run.id,
    stepRunId: workflowStep.id,
    missionId: workflowStep.missionId,
    missionRunId: workflowStep.missionRunId,
    actorTeammateId: actors.a.teammateId,
    runtimeProfileId: actors.a.runtimeProfileId,
    offeredIds: workflowModelCall.offeredIds,
    receipt: safeSelection(workflowSelection),
    resultCount: workflowResults.length,
    state: workflowDone.run.state,
    stepState: completedStep.state,
    currentMissionRunBound: completedStep.missionRunId === workflowStep.missionRunId,
  };

  const beforeCloudOff = observerSnapshot();
  const cloudOffConfig = await page.evaluate(() =>
    window.cultivation.routing.setCloudEnabled(false),
  );
  assert.equal(cloudOffConfig.cloudEnabled, false);
  const cloudOffMission = await createMission(
    page,
    actors.a,
    `R5.4 Cloud-off fallback ${nonce}`,
    '__R54_READ__ read the approved workspace file',
  );
  const cloudOffStart = await startMission(page, cloudOffMission.id);
  const cloudOffApproval = pendingApproval(cloudOffStart, 'FILE_READ', toolIds.read);
  const cloudOffProposal = requireModelProposal(
    observerSnapshot(),
    beforeCloudOff.modelCalls.length,
    actors.a,
    toolIds.read,
  );
  assert.deepEqual(
    cloudOffProposal.offeredIds,
    stableRegistryOrder,
    'Cloud-off fallback must offer the complete live registry in stable order',
  );
  const cloudOffSelections = missionSelections(cloudOffMission.id);
  assert.ok(cloudOffSelections.length > 0);
  assert.ok(
    cloudOffSelections.every(
      (selection) =>
        selection.mode === 'DETERMINISTIC_FALLBACK' &&
        selection.reason === 'GATEWAY_UNAVAILABLE' &&
        JSON.stringify(selection.offeredIds) === JSON.stringify(stableRegistryOrder),
    ),
    'Cloud-off tool selection must use deterministic fallback without a Jev shortlist',
  );
  const cloudOffDone = await resolveApproval(page, cloudOffApproval.id, 'APPROVED');
  assert.equal(cloudOffDone.mission.state, 'COMPLETED');
  assert.equal(cloudOffDone.runs.at(-1)?.id, cloudOffStart.runs.at(-1)?.id);
  const cloudOffResults = missionToolResults(cloudOffMission.id);
  assert.equal(cloudOffResults.length, 1);
  assert.equal(cloudOffResults[0].payload.toolId, toolIds.read);
  assert.equal(cloudOffResults[0].payload.success, true);
  const afterCloudOff = observerSnapshot();
  assert.equal(
    afterCloudOff.decisions.length,
    beforeCloudOff.decisions.length,
    'Cloud-off fallback must not call the Jev decision gateway',
  );
  assert.ok(
    afterCloudOff.modelCalls
      .slice(beforeCloudOff.modelCalls.length)
      .every((call) => JSON.stringify(call.offeredIds) === JSON.stringify(stableRegistryOrder)),
  );
  cloudOffFacts = {
    missionId: cloudOffMission.id,
    approvalId: cloudOffApproval.id,
    offeredIds: cloudOffProposal.offeredIds,
    expectedRegistryOrder: stableRegistryOrder,
    selectionCount: cloudOffSelections.length,
    selectionMode: cloudOffSelections[0].mode,
    selectionReason: cloudOffSelections[0].reason,
    decisionCountUnchanged: afterCloudOff.decisions.length === beforeCloudOff.decisions.length,
    resultCount: cloudOffResults.length,
    finalState: cloudOffDone.mission.state,
  };

  observer = readObserver();
  assertObserverPrivacy(observer, [
    inputText,
    'r54-input.txt',
    'r54-output.txt',
    '交付已完成',
    fakeKeyMarker(),
  ]);
  assert.ok(
    observer.decisions.length >= 6,
    'Cloud-enabled fixture must exercise the shortlist decision',
  );
  assert.equal(existsSync(productionFactsPath), false);
  screenshots = await captureRoutingPrivacy(page, app);
} finally {
  await live.app.close();
}

assert.equal(existsSync(productionFactsPath), false);
assert.equal(existsSync(fixtureFactsPath), true);
fixtureMigrations = assertMigrations(fixtureProfile);
assert.deepEqual(fixtureMigrations, productionMigrations);
assert.equal(readFileSync(join(workspaceRoot, 'r54-input.txt'), 'utf8'), inputText);
assert.equal(readFileSync(join(workspaceRoot, 'r54-output.txt'), 'utf8'), '交付已完成');
observer = readObserver();
assertObserverPrivacy(observer, [
  inputText,
  'r54-input.txt',
  'r54-output.txt',
  '交付已完成',
  fakeKeyMarker(),
]);
for (const missionId of [
  readRestartFacts.missionId,
  permissionDenyFacts.missionId,
  writeFacts.denied.missionId,
  writeFacts.approved.missionId,
  excludedFacts.missionId,
  mcpFacts.missionId,
  partyFacts.missionId,
  workflowFacts.missionId,
  cloudOffFacts.missionId,
]) {
  assert.ok(missionId && typeof missionId === 'string');
  assert.ok(missionEvents(missionId).length > 0);
}

const mcpConfig = openReadOnlyDatabase(fixtureProfile, (db) =>
  db.prepare('SELECT id, enabled FROM mcp_servers WHERE id = ?').get(mcpServerId),
);
assert.deepEqual(mcpConfig, { id: mcpServerId, enabled: 1 });
const evidence = {
  verifiedAt: new Date().toISOString(),
  schemaVersion: 32,
  production: {
    normalLaunch: true,
    fixtureObserverFile: false,
    officialWorkflowHashes: productionHashes,
    migrations: productionMigrations,
  },
  fixture: {
    flags: fixtureArgs,
    officialWorkflowHashes: productionHashes,
    officialHashesUnchanged: true,
    actors,
    tools: {
      builtinIds,
      stableRegistryOrder,
      mcpServerId,
      ...toolIds,
      registryDescriptorCount: stableRegistryOrder.length,
    },
    readApprovalRestart: readRestartFacts,
    permissionDeny: permissionDenyFacts,
    writeApproval: writeFacts,
    notOffered: excludedFacts,
    mcpApproval: mcpFacts,
    partyActorIsolation: partyFacts,
    workflowHardEligibility: workflowFacts,
    cloudOffFallback: cloudOffFacts,
    observer: {
      decisions: observer.decisions,
      modelCalls: observer.modelCalls,
    },
    mcpServer: mcpConfig,
    migrations: fixtureMigrations,
    privacyScreenshots: screenshots,
  },
};
const evidenceJson = JSON.stringify(evidence);
for (const rawValue of [
  inputText,
  'r54-input.txt',
  'r54-output.txt',
  '交付已完成',
  fakeKeyMarker(),
])
  assert.equal(
    evidenceJson.includes(rawValue),
    false,
    'Evidence must exclude raw file contents and secrets',
  );
mkdirSync(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, 'facts.json');
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`R5_4_PACKAGED_EVIDENCE ${evidencePath}`);
console.log(
  `R5_4_PACKAGED_SMOKE_OK production=fixture_free approval_restart=same_run write_deny=unwritten not_offered=blocked mcp=approved party=actor_isolated workflow=hard_eligible cloud_off=deterministic_fallback privacy_widths=1440,1180,900 evidence=${evidencePath}`,
);

function fakeKeyMarker() {
  return `r54-deterministic-fixture-key-${nonce}`;
}
