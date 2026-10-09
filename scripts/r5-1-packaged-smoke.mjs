import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';

const root = process.cwd();
const nonce = randomUUID();
const profileRoot = join(root, '.test-data', `r5-1-packaged-${nonce}`);
const productionProfile = join(profileRoot, 'production');
const fixtureProfile = join(profileRoot, 'fixture');
const evidenceDir = join(root, 'docs', 'evidence', 'r5-1-skill-routing', nonce);
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
const historySentinels = [
  'HISTORY_SENTINEL',
  'PRIVATE_MEMORY_SENTINEL',
  'PRIVATE_INSTRUCTIONS_SENTINEL',
];

assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);
assert.equal(
  existsSync(profileRoot),
  false,
  'Each R5.1 smoke run needs a fresh project-local profile',
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
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function hashText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertSameIds(actual, expected, message) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}

function snapshotOfficialVersions(versions, { requireFixture = false } = {}) {
  const official = versions
    .filter((item) => officialWorkflowIds.includes(item.definition.id))
    .sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  assert.deepEqual(
    official.map((item) => item.definition.id),
    [...officialWorkflowIds].sort(),
    'The production package must expose exactly the three official workflow definitions',
  );
  if (requireFixture) {
    assert.ok(
      versions.some((item) => item.definition.id === 'w1-fixture-sequence' && item.version === 1),
      'The explicit test-only W1 fixture must be registered for this run',
    );
  } else {
    assert.deepEqual(
      versions.map((item) => item.definition.id).sort(),
      [...officialWorkflowIds].sort(),
      'A normal production launch must expose no user or test-only workflow templates',
    );
    assert.equal(
      versions.some((item) => item.definition.id.startsWith('w1-fixture-')),
      false,
      'A normal production launch must not register W1 fixtures',
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

function createSkillSpecs(role, runNonce) {
  const prefix = `R51_${role}`;
  const privateMarker = 'PRIVATE_INSTRUCTIONS_SENTINEL';
  return {
    free: [
      {
        key: 'free1',
        name: `${role} comet orbital observation planning ${runNonce}`,
        description:
          'Plan orbital comet observations, telescope cadence, and a concise observation schedule.',
        tags: ['comet', 'orbital', 'observation', 'telescope'],
        marker: `${prefix}_COMET_PLAN_${runNonce}`,
      },
      {
        key: 'free2',
        name: `${role} comet photometry observation table ${runNonce}`,
        description:
          'Summarize comet photometry from orbital observation readings in a clear table.',
        tags: ['comet', 'photometry', 'observation', 'table'],
        marker: `${prefix}_PHOTOMETRY_TABLE_${runNonce}`,
      },
      {
        key: 'free3',
        name: `${role} telescope observation report ${runNonce}`,
        description: 'Prepare an orbital telescope observation report with measured comet details.',
        tags: ['telescope', 'observation', 'report', 'orbital'],
        marker: `${prefix}_OBSERVATION_REPORT_${runNonce}`,
      },
    ],
    workflow: [
      {
        key: 'workflow1',
        name: `${role} workflow review artifact JSON contract ${runNonce}`,
        description:
          'Review a workflow input artifact and produce structured JSON matching fixture.review output contract.',
        tags: ['workflow', 'review', 'artifact', 'structured', 'JSON', 'fixture.review'],
        marker: `${prefix}_WORKFLOW_REVIEW_CONTRACT_${runNonce}`,
      },
      {
        key: 'workflow2',
        name: `${role} structured review verdict evidence ${runNonce}`,
        description:
          'Inspect the draft artifact in a workflow review and report verdict, findings, evidence, and summary as JSON.',
        tags: ['workflow', 'review', 'draft', 'artifact', 'verdict', 'evidence', 'JSON'],
        marker: `${prefix}_REVIEW_VERDICT_EVIDENCE_${runNonce}`,
      },
      {
        key: 'workflow3',
        name: `${role} workflow step output validator ${runNonce}`,
        description:
          'Validate the structured JSON output contract for the review step and referenced artifact metadata.',
        tags: ['workflow', 'step', 'output', 'contract', 'structured', 'JSON', 'artifact'],
        marker: `${prefix}_WORKFLOW_OUTPUT_VALIDATOR_${runNonce}`,
      },
    ],
    disabled: {
      key: 'disabled',
      name: `${role} disabled comet observation ${runNonce}`,
      description: 'Disabled comet observation and photometry marker; must not be selected.',
      tags: ['comet', 'observation', 'disabled'],
      marker: `${prefix}_DISABLED_${runNonce}`,
    },
    archived: {
      key: 'archived',
      name: `${role} archived comet report ${runNonce}`,
      description: 'Archived comet orbital observation report marker; must not be selected.',
      tags: ['comet', 'orbital', 'archived'],
      marker: `${prefix}_ARCHIVED_${runNonce}`,
    },
    unassigned: {
      key: 'unassigned',
      name: `${role} unassigned comet telescope skill ${runNonce}`,
      description: 'Unassigned comet observation telescope marker; must not be selected.',
      tags: ['comet', 'telescope', 'unassigned'],
      marker: `${prefix}_UNASSIGNED_${runNonce}`,
    },
    privateMarker,
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
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}

async function seedActor(page, role) {
  const specs = createSkillSpecs(role, nonce);
  return page.evaluate(
    async ({ role, specs, nonce }) => {
      const api = window.cultivation;
      const provider = await api.providers.create({
        name: `R5.1 ${role} LANGUAGE provider ${nonce}`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9999/v1',
      });
      const runtime = await api.runtimes.create({
        name: `R5.1 ${role} sealed LANGUAGE runtime ${nonce}`,
        providerId: provider.id,
        credentialId: null,
        modelId: `r51-language-${role.toLowerCase()}-${nonce.slice(0, 8)}`,
        executionProtocol: 'LANGUAGE',
      });
      if (runtime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.1 actors must use LANGUAGE runtimes');
      const teammate = await api.teammates.create({
        name: role === 'A' ? '观澜' : '明衡',
        avatar: null,
        title: `R5.1 ${role}`,
        description: 'Packaged skill-routing LANGUAGE fixture actor.',
        identityPrompt: `R5.1 sealed LANGUAGE identity ${role} ${nonce}`,
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
      const sealedRuntime = (await api.runtimes.list()).find(
        (item) => item.id === teammate.currentRuntimeProfileId,
      );
      if (!sealedRuntime) throw new Error(`R5.1 ${role} sealed Runtime is missing`);
      if (sealedRuntime.executionProtocol !== 'LANGUAGE')
        throw new Error('R5.1 sealed actors must use LANGUAGE runtimes');
      await api.capability.saveBenchmark({
        runtimeProfileId: sealedRuntime.id,
        modelAlias: sealedRuntime.modelId,
        dimension: 'GENERAL_REASONING',
        supported: true,
        normalizedScore: role === 'A' ? 80 : 60,
        rawScore: null,
        source: 'R5.1 deterministic fixture',
        benchmark: 'Acceptance fixture',
        benchmarkVersion: '1',
        snapshotDate: '2026-10-01T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
      await api.r2.setCapability({ dimension: 'GENERAL_REASONING', enabled: true });

      const skillMeta = {};
      const create = async (spec) => {
        const skill = await api.skills.create({
          name: spec.name,
          description: spec.description,
          instructions: `${spec.marker}\nPRIVATE_INSTRUCTIONS_SENTINEL ${nonce}: use only this bounded skill instruction.`,
          tags: spec.tags,
        });
        skillMeta[spec.key] = {
          id: skill.id,
          status: skill.status,
          instructionCharacters: skill.instructions.length,
        };
        return skill;
      };
      for (const spec of [...specs.free, ...specs.workflow]) {
        const skill = await create(spec);
        await api.skills.assign({ teammateId: teammate.id, skillId: skill.id });
        await api.skills.setEnabled({ teammateId: teammate.id, skillId: skill.id, enabled: true });
      }
      const disabled = await create(specs.disabled);
      await api.skills.assign({ teammateId: teammate.id, skillId: disabled.id });
      await api.skills.setEnabled({
        teammateId: teammate.id,
        skillId: disabled.id,
        enabled: false,
      });

      const archived = await create(specs.archived);
      await api.skills.assign({ teammateId: teammate.id, skillId: archived.id });
      await api.skills.setEnabled({ teammateId: teammate.id, skillId: archived.id, enabled: true });
      const archivedResult = await api.skills.archive(archived.id);
      skillMeta.archived.status = archivedResult.status;

      await create(specs.unassigned);
      const assignments = await api.skills.listAssignments(teammate.id);
      const enabledActiveIds = Object.values(skillMeta)
        .filter(
          (item) =>
            item.status === 'ACTIVE' &&
            assignments.some((assignment) => assignment.skillId === item.id && assignment.enabled),
        )
        .map((item) => item.id);
      if (enabledActiveIds.length !== 6)
        throw new Error(`Expected six enabled ACTIVE Skills for ${role}`);
      return {
        role,
        teammateId: teammate.id,
        runtimeProfileId: sealedRuntime.id,
        executionProtocol: runtime.executionProtocol,
        skillMeta,
        assignments: assignments.map(({ skillId, enabled }) => ({ skillId, enabled })),
        freeSkillIds: specs.free.map((spec) => skillMeta[spec.key].id),
        workflowSkillIds: specs.workflow.map((spec) => skillMeta[spec.key].id),
        enabledActiveIds,
      };
    },
    { role, specs, nonce },
  );
}

function selectionEvents(detail, teammateId) {
  return detail.events.filter(
    (event) => event.eventType === 'skill.selection' && event.actorId === teammateId,
  );
}

function assertSelectionReceipt(event, actor, expectedIds, mode) {
  const receipt = event.payloadJson;
  assert.equal(receipt.mode, mode);
  assert.equal(receipt.policyVersion, 'r5-1-skill-routing-policy-v1');
  assert.equal(receipt.questionVersion, 'r5-1-skill-relevance-question-v1');
  assert.ok(Array.isArray(receipt.candidateIds));
  assert.ok(Array.isArray(receipt.selectedSkillIds));
  assert.ok(receipt.selectedSkillIds.length >= 1 && receipt.selectedSkillIds.length <= 3);
  assert.equal(new Set(receipt.candidateIds).size, receipt.candidateIds.length);
  assert.ok(
    receipt.candidateIds.every((id) => actor.enabledActiveIds.includes(id)),
    'Candidate set must be limited to this teammate’s assigned, enabled, ACTIVE skills',
  );
  assert.deepEqual(
    receipt.selectedSkillIds,
    receipt.candidateIds.slice(0, 3),
    'Selection must preserve deterministic top-three candidate order',
  );
  assert.deepEqual(
    [...receipt.selectedSkillIds].sort(),
    [...expectedIds].sort(),
    'The objective and bounded Workflow context must rank their expected high-overlap Skills first',
  );
  assert.ok(typeof receipt.inputHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.inputHash));
  if (Array.isArray(receipt.scores)) {
    assert.ok(receipt.scores.length <= 24);
    assert.ok(
      receipt.scores.every(
        (item) =>
          receipt.candidateIds.includes(item.skillId) &&
          Number.isFinite(item.score) &&
          item.score >= 0 &&
          item.score <= 1,
      ),
      'Persisted relevance scores must be finite, bounded, and candidate-scoped',
    );
  }
  return receipt;
}

function assertModelCallForSelection(call, event, actor) {
  assert.equal(call.teammateId, actor.teammateId);
  assert.equal(
    call.runtimeProfileId,
    actor.runtimeProfileId,
    'Model calls must use the actor’s sealed LANGUAGE runtime',
  );
  assert.equal(
    call.selectionHash,
    event.payloadJson.inputHash,
    'Rendered Skills must pair with the durable selection receipt',
  );
  assert.deepEqual(call.selectedSkillIds, event.payloadJson.selectedSkillIds);
  assert.ok(call.selectedSkillIds.length >= 1 && call.selectedSkillIds.length <= 3);
  assert.ok(call.instructionCharacters > 0 && call.instructionCharacters <= 6_000);
  assert.ok(call.skillSectionCharacters > 0 && call.skillSectionCharacters <= 6_000);
  assert.ok(actor.enabledActiveIds.includes(call.selectedSkillIds[0]));
}

function auditSelectionDatabase(profile) {
  return openReadOnlyDatabase(profile, (db) => {
    const events = db
      .prepare(
        "SELECT mission_id, run_id, actor_id, payload_json FROM mission_events WHERE event_type='skill.selection' ORDER BY rowid",
      )
      .all()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
    const audits = db
      .prepare(
        "SELECT target_id, actor_id, payload_json FROM audit_events WHERE action='skill.selection' ORDER BY rowid",
      )
      .all()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
    assert.equal(
      audits.length,
      events.length,
      'Every durable skill selection must have one audit receipt',
    );
    for (const event of events) {
      const match = audits.filter(
        (audit) =>
          audit.target_id === event.mission_id &&
          audit.actor_id === event.actor_id &&
          audit.payload.runId === event.run_id &&
          audit.payload.inputHash === event.payload.inputHash,
      );
      assert.equal(
        match.length,
        1,
        'Mission Event and Audit must preserve the same actor/run/input hash',
      );
      for (const key of [
        'mode',
        'policyVersion',
        'questionVersion',
        'reason',
        'errorCode',
        'candidateIds',
        'selectedSkillIds',
      ]) {
        assert.deepEqual(match[0].payload[key], event.payload[key]);
      }
    }
    return events.map((event) => ({
      missionId: event.mission_id,
      runId: event.run_id,
      teammateId: event.actor_id,
      mode: event.payload.mode,
      inputHash: event.payload.inputHash,
      candidateIds: event.payload.candidateIds,
      selectedSkillIds: event.payload.selectedSkillIds,
      scores: event.payload.scores ?? [],
    }));
  });
}

function assertDecisionContextSafe(decisions) {
  for (const decision of decisions) {
    assert.equal(decision.historyLeak, false);
    assert.equal(decision.containsInstructionMarker, false);
    const contextText = JSON.stringify(decision.contextFacts ?? {});
    assert.ok(!Object.hasOwn(decision, 'context'), 'Evidence must not persist the task objective');
    for (const sentinel of historySentinels) assert.equal(contextText.includes(sentinel), false);
  }
}

let productionHashes;
let productionFacts;
{
  const live = await launch(productionProfile);
  try {
    const { page } = live;
    const initial = await page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
      shadow: await window.cultivation.r3.getConfig(),
      observations: await window.cultivation.r3.listObservations(),
    }));
    productionHashes = snapshotOfficialVersions(initial.versions);
    assert.equal(initial.routing.cloudEnabled, false);
    assert.deepEqual(
      {
        mode: initial.shadow.mode,
        enabled: initial.shadow.enabled,
        configured: initial.shadow.configured,
      },
      { mode: 'SHADOW', enabled: false, configured: false },
    );
    assert.deepEqual(initial.observations, []);
    productionFacts = {
      officialWorkflowHashes: productionHashes,
      normalLaunch: true,
      r3: { mode: initial.shadow.mode, enabled: initial.shadow.enabled, observations: 0 },
    };
  } finally {
    await live.app.close();
  }
}

const productionDatabase = openReadOnlyDatabase(productionProfile, (db) => {
  const migrationVersions = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version);
  assert.deepEqual(
    migrationVersions,
    Array.from({ length: 31 }, (_, index) => index + 1),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='skill.selection'").get()
      .n,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='skill.selection'").get().n,
    0,
  );
  return { migrations: migrationVersions, skillSelectionEvents: 0, skillSelectionAudits: 0 };
});

let fixtureFacts;
let fixtureObserver;
let actorA;
let actorB;
let missionIds;
{
  const live = await launch(fixtureProfile, [
    '--gate1-fake-model',
    '--r5-1-fixture',
    '--r4-fake-routing',
    '--w1-fake-workflow',
  ]);
  try {
    const { app, page } = live;
    const boot = await page.evaluate(async () => ({
      versions: await window.cultivation.workflows.versions(),
      routing: await window.cultivation.routing.config(),
      shadow: await window.cultivation.r3.getConfig(),
    }));
    const fixtureHashes = snapshotOfficialVersions(boot.versions, { requireFixture: true });
    assert.deepEqual(
      fixtureHashes,
      productionHashes,
      'Test-only fixture boot must preserve official frozen workflow hashes',
    );
    assert.equal(boot.routing.cloudEnabled, false);
    assert.equal(boot.shadow.mode, 'SHADOW');
    assert.equal(boot.shadow.enabled, false);

    const safeKey = `r5-1-safe-main-key-${nonce}`;
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), safeKey);
    const configured = await page.evaluate(() => window.cultivation.r3.saveKeyFromClipboard());
    assert.equal(configured.keySource, 'SAFE_STORAGE');
    assert.equal(configured.configured, true);
    assert.equal(JSON.stringify(configured).includes(safeKey), false);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '');
    const enabled = await page.evaluate(() => window.cultivation.routing.setCloudEnabled(true));
    assert.equal(enabled.cloudEnabled, true);
    const shadowAfterOptIn = await page.evaluate(() => window.cultivation.r3.getConfig());
    assert.equal(shadowAfterOptIn.mode, 'SHADOW');
    assert.equal(shadowAfterOptIn.enabled, false, 'R4 opt-in must not enable legacy R3 Shadow');

    actorA = await seedActor(page, 'A');
    actorB = await seedActor(page, 'B');
    assert.equal(actorA.executionProtocol, 'LANGUAGE');
    assert.equal(actorB.executionProtocol, 'LANGUAGE');
    for (const actor of [actorA, actorB]) {
      assert.equal(actor.enabledActiveIds.length, 6);
      assert.equal(actor.skillMeta.archived.status, 'ARCHIVED');
      assert.ok(
        actor.assignments.some(
          (item) => item.skillId === actor.skillMeta.disabled.id && !item.enabled,
        ),
      );
      assert.ok(actor.assignments.some((item) => item.skillId === actor.skillMeta.archived.id));
      assert.ok(!actor.assignments.some((item) => item.skillId === actor.skillMeta.unassigned.id));
    }

    const freeMission = await page.evaluate(
      async ({ teammateId, nonce }) => {
        const api = window.cultivation;
        const created = await api.missions.create({
          title: '彗星观测计划',
          objective: `Analyze the comet orbital observation schedule and photometry readings, then deliver a concise telescope observation report and table. R51_FREE_OBJECTIVE_${nonce}`,
          coordinatorTeammateId: teammateId,
        });
        await api.missions.ready(created.id);
        const detail = await api.missions.start({ missionId: created.id, approvalFixture: false });
        return detail;
      },
      { teammateId: actorA.teammateId, nonce },
    );
    assert.equal(freeMission.mission.state, 'COMPLETED');
    assert.ok(freeMission.usage.some((item) => item.teammateId === actorA.teammateId));
    const freeSelectionEvents = selectionEvents(freeMission, actorA.teammateId);
    assert.equal(freeSelectionEvents.length, 1);
    assertSelectionReceipt(freeSelectionEvents[0], actorA, actorA.freeSkillIds, 'JEV');
    const freeCalls = (await readObserver(fixtureProfile)).modelCalls.filter(
      (call) => call.missionId === freeMission.mission.id && call.teammateId === actorA.teammateId,
    );
    assert.equal(freeCalls.length, 1);
    assertModelCallForSelection(freeCalls[0], freeSelectionEvents[0], actorA);
    assert.ok(['generate', 'generateWithTools'].includes(freeCalls[0].method));

    const party = await page.evaluate(
      async ({ aId, bId }) =>
        window.cultivation.parties.create({
          name: '天文研究组',
          description: 'Two sealed LANGUAGE actors with scoped Skills.',
          type: 'FIXED',
          coordinatorTeammateId: aId,
          memberTeammateIds: [aId, bId],
        }),
      { aId: actorA.teammateId, bId: actorB.teammateId, nonce },
    );
    const partyStart = await page.evaluate(
      async ({ partyId, teammateId, nonce }) => {
        const api = window.cultivation;
        const created = await api.missions.create({
          title: '联合观测分析',
          objective: `Survey the comet orbital observation schedule and photometry table, then report measured telescope observation results. R51_PARTY_OBJECTIVE_${nonce}`,
          coordinatorTeammateId: teammateId,
          partyId,
          mode: 'CONSULTATION',
        });
        await api.missions.ready(created.id);
        return api.missions.start({ missionId: created.id, approvalFixture: false });
      },
      { partyId: party.id, teammateId: actorA.teammateId, nonce },
    );
    assert.equal(partyStart.mission.state, 'WAITING_COLLABORATION');
    const invite = partyStart.collaborations.find((item) => item.state === 'PENDING');
    assert.ok(invite);
    assert.equal(invite.requesterTeammateId, actorA.teammateId);
    assert.equal(invite.targetTeammateId, actorB.teammateId);
    const partyDone = await page.evaluate(
      (requestId) =>
        window.cultivation.missions.resolveCollaboration({ requestId, decision: 'APPROVED' }),
      invite.id,
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
    const partyAEvents = selectionEvents(partyDone, actorA.teammateId);
    const partyBEvents = selectionEvents(partyDone, actorB.teammateId);
    assert.ok(
      partyAEvents.length >= 2,
      'Coordinator must select Skills for proposal and synthesis',
    );
    assert.equal(partyBEvents.length, 1, 'Approved participant must select its own Skills');
    for (const event of partyAEvents)
      assertSelectionReceipt(event, actorA, actorA.freeSkillIds, 'JEV');
    for (const event of partyBEvents)
      assertSelectionReceipt(event, actorB, actorB.freeSkillIds, 'JEV');
    assert.ok(
      partyDone.usage.some(
        (item) =>
          item.teammateId === actorA.teammateId &&
          item.runtimeProfileId === actorA.runtimeProfileId,
      ),
    );
    assert.ok(
      partyDone.usage.some(
        (item) =>
          item.teammateId === actorB.teammateId &&
          item.runtimeProfileId === actorB.runtimeProfileId,
      ),
    );

    const workflowRun = await page.evaluate(() =>
      window.cultivation.workflows.create({
        definitionId: 'w1-fixture-sequence',
        version: 1,
      }),
    );
    const workflowDone = await page.evaluate(
      (runId) => window.cultivation.workflows.advance(runId),
      workflowRun.run.id,
    );
    assert.equal(workflowDone.run.state, 'COMPLETED');
    const reviewStep = workflowDone.steps.find((item) => item.stepId === 'review');
    assert.ok(
      reviewStep?.missionId,
      'W1 review step must create a Mission with input artifact metadata',
    );
    const workflowMission = await page.evaluate(
      (missionId) => window.cultivation.missions.detail(missionId),
      reviewStep.missionId,
    );
    assert.equal(workflowMission.mission.state, 'COMPLETED');
    const workflowSelectionEvents = selectionEvents(workflowMission, actorA.teammateId);
    assert.equal(workflowSelectionEvents.length, 1);
    const workflowReceipt = assertSelectionReceipt(
      workflowSelectionEvents[0],
      actorA,
      actorA.workflowSkillIds,
      'JEV',
    );
    assert.equal(
      workflowDone.bindings.filter(
        (binding) => binding.stepRunId === reviewStep.id && binding.role === 'INPUT',
      ).length,
      1,
      'The W1 review must consume a durable input artifact through a typed binding',
    );

    const workflowInputs = {
      definitionId: 'w1-fixture-io',
      version: 1,
      inputs: {
        topic: `R5.1 workflow JSON task ${nonce}`,
        mode: 'brief',
        count: 2,
        privateNote: `PRIVATE_MEMORY_SENTINEL_${nonce}`,
      },
    };
    const ioRun = await page.evaluate(
      (input) => window.cultivation.workflows.create(input),
      workflowInputs,
    );
    const ioDone = await page.evaluate(
      (runId) => window.cultivation.workflows.advance(runId),
      ioRun.run.id,
    );
    assert.equal(ioDone.run.state, 'COMPLETED');
    const ioArtifact = ioDone.artifacts.find((item) => item.kind === 'JSON');
    assert.ok(ioArtifact);
    const ioResult = JSON.parse(ioArtifact.content);
    assert.equal(ioResult.hiddenInputSeen, false);
    assert.equal(ioResult.inputRole, 'assistant');

    const fallbackConfig = await page.evaluate(() =>
      window.cultivation.routing.setCloudEnabled(false),
    );
    assert.equal(fallbackConfig.cloudEnabled, false);
    const fallbackMission = await page.evaluate(
      async ({ teammateId, nonce }) => {
        const api = window.cultivation;
        const created = await api.missions.create({
          title: '观测报告整理',
          objective: `Summarize the comet orbital observation report and photometry table using the enabled skills. R51_FALLBACK_OBJECTIVE_${nonce}`,
          coordinatorTeammateId: teammateId,
        });
        await api.missions.ready(created.id);
        return api.missions.start({ missionId: created.id, approvalFixture: false });
      },
      { teammateId: actorA.teammateId, nonce },
    );
    assert.equal(fallbackMission.mission.state, 'COMPLETED');
    assert.ok(fallbackMission.usage.some((item) => item.teammateId === actorA.teammateId));
    assert.ok(
      fallbackMission.events.some(
        (event) => event.eventType === 'model.call_started' && event.actorId === actorA.teammateId,
      ),
    );
    const fallbackEvents = selectionEvents(fallbackMission, actorA.teammateId);
    assert.equal(fallbackEvents.length, 1);
    const fallbackReceipt = assertSelectionReceipt(
      fallbackEvents[0],
      actorA,
      actorA.freeSkillIds,
      'DETERMINISTIC_FALLBACK',
    );
    const finalR3 = await page.evaluate(async () => ({
      shadow: await window.cultivation.r3.getConfig(),
      observations: await window.cultivation.r3.listObservations(),
      routing: await window.cultivation.routing.config(),
    }));
    assert.equal(finalR3.shadow.mode, 'SHADOW');
    assert.equal(finalR3.shadow.enabled, false);
    assert.deepEqual(
      finalR3.observations,
      [],
      'R5.1 routing must not create legacy Shadow observations',
    );
    assert.equal(finalR3.routing.cloudEnabled, false);

    mkdirSync(evidenceDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await navigateUi(page, '历练 Missions');
    await page.locator('.mission-filter-tabs').getByRole('tab', { name: /全部/ }).click();
    await page.getByRole('button', { name: '彗星观测计划', exact: false }).click();
    await page.getByRole('heading', { name: '彗星观测计划', exact: true }).waitFor();
    await page.getByText('高级 · 完整执行记录', { exact: true }).click();
    const selectionLabel = page
      .locator('details.mission-advanced[open]')
      .getByText('skill.selection', { exact: true })
      .first();
    await selectionLabel.waitFor();
    await selectionLabel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidenceDir, 'mission-skill-selection-1440.png') });

    missionIds = {
      free: freeMission.mission.id,
      party: partyDone.mission.id,
      workflow: workflowMission.mission.id,
      workflowRun: workflowDone.run.id,
      ioWorkflowRun: ioDone.run.id,
      fallback: fallbackMission.mission.id,
    };
    fixtureFacts = {
      screenshots: ['mission-skill-selection-1440.png'],
      flags: ['--gate1-fake-model', '--r5-1-fixture', '--r4-fake-routing', '--w1-fake-workflow'],
      officialWorkflowHashes: fixtureHashes,
      routingOptIn: {
        cloudEnabledDuringJev: true,
        cloudEnabledAfterFallback: false,
        keySource: configured.keySource,
      },
      r3Shadow: { mode: finalR3.shadow.mode, enabled: finalR3.shadow.enabled, observations: 0 },
      actors: [actorA, actorB].map((actor) => ({
        role: actor.role,
        teammateId: actor.teammateId,
        runtimeProfileId: actor.runtimeProfileId,
        executionProtocol: actor.executionProtocol,
        enabledActiveSkillIds: actor.enabledActiveIds,
        selectedGroups: { free: actor.freeSkillIds, workflow: actor.workflowSkillIds },
        excludedSkillIds: {
          disabled: actor.skillMeta.disabled.id,
          archived: actor.skillMeta.archived.id,
          unassigned: actor.skillMeta.unassigned.id,
        },
      })),
      missions: missionIds,
      workflowReview: {
        stepId: reviewStep.stepId,
        missionId: workflowMission.mission.id,
        inputArtifactCount: workflowDone.bindings.filter(
          (binding) => binding.stepRunId === reviewStep.id && binding.role === 'INPUT',
        ).length,
        expectedSelectedSkillIds: workflowReceipt.selectedSkillIds,
      },
      fallback: {
        mode: fallbackReceipt.mode,
        selectedSkillIds: fallbackReceipt.selectedSkillIds,
        actualModelCall: true,
      },
      completion: {
        free: freeMission.mission.state,
        party: partyDone.mission.state,
        workflow: workflowDone.run.state,
        inputWorkflow: ioDone.run.state,
        fallback: fallbackMission.mission.state,
      },
    };
  } finally {
    await live.app.close();
  }
}

fixtureObserver = JSON.parse(
  readFileSync(join(fixtureProfile, 'r5-1-execution-facts.json'), 'utf8'),
);
assert.ok(Array.isArray(fixtureObserver.modelCalls) && fixtureObserver.modelCalls.length >= 7);
assert.ok(Array.isArray(fixtureObserver.decisions));
assertDecisionContextSafe(fixtureObserver.decisions);

const receiptFacts = auditSelectionDatabase(fixtureProfile);
assert.equal(
  receiptFacts.length,
  fixtureObserver.modelCalls.length,
  'Every skill selection must lead to one observed model call',
);
const actorById = new Map([
  [actorA.teammateId, actorA],
  [actorB.teammateId, actorB],
]);
for (const call of fixtureObserver.modelCalls) {
  const actor = actorById.get(call.teammateId);
  assert.ok(actor, 'Only the two sealed LANGUAGE actors may enter a LANGUAGE prompt composer');
  assert.equal(call.runtimeProfileId, actor.runtimeProfileId);
  assert.equal(
    call.method === 'generate' ||
      call.method === 'proposeCollaboration' ||
      call.method === 'generateWithTools',
    true,
  );
  assert.ok(
    !Object.hasOwn(call, 'messages') && !Object.hasOwn(call, 'systemContext'),
    'Fixture observer must not persist raw prompt text',
  );
  const receipt = receiptFacts.find(
    (item) =>
      item.missionId === call.missionId &&
      item.runId === call.runId &&
      item.teammateId === call.teammateId &&
      item.inputHash === call.selectionHash,
  );
  assert.ok(
    receipt,
    'Each observed prompt must pair with its durable Mission Event and Audit receipt',
  );
  assert.deepEqual(call.selectedSkillIds, receipt.selectedSkillIds);
  assert.ok(call.instructionCharacters > 0 && call.instructionCharacters <= 6_000);
  assert.ok(call.skillSectionCharacters > 0 && call.skillSectionCharacters <= 6_000);
}

const decisionEntries = fixtureObserver.decisions.filter((item) => item.type === 'SKILL_RELEVANCE');
assert.ok(
  decisionEntries.length >= 7,
  'Cloud opt-in must use JEV relevance selection for active Missions',
);
for (const receipt of receiptFacts.filter((item) => item.mode === 'JEV')) {
  assert.ok(
    decisionEntries.some(
      (entry) => JSON.stringify(entry.candidateIds) === JSON.stringify(receipt.candidateIds),
    ),
    'Each JEV receipt must be backed by a corresponding bounded relevance decision',
  );
}

const reviewReceipt = receiptFacts.find(
  (item) => item.missionId === missionIds.workflow && item.teammateId === actorA.teammateId,
);
assert.ok(reviewReceipt);
const reviewDecision = decisionEntries.find(
  (item) =>
    item.contextFacts?.stepType === 'REVIEW' &&
    JSON.stringify(item.candidateIds) === JSON.stringify(reviewReceipt.candidateIds),
);
assert.ok(reviewDecision, 'W1 review relevance decision must use the frozen Step context');
assert.equal(reviewDecision.questionVersion, 'r5-1-skill-relevance-question-v1');
const reviewContext = reviewDecision.contextFacts;
assert.equal(reviewContext.stepType, 'REVIEW');
assert.deepEqual(reviewContext.requiredCapabilities, ['GENERAL_REASONING']);
assert.ok(Array.isArray(reviewContext.inputArtifactSummaries));
assert.equal(reviewContext.inputArtifactSummaries.length, 1);
assert.deepEqual(reviewContext.inputArtifactSummaries[0].fields.sort(), ['id', 'kind', 'name']);
assert.equal(reviewContext.inputArtifactSummaries[0].nameHash, hashText('draft'));
assert.ok(Array.isArray(reviewContext.expectedOutputContract));
assert.ok(
  reviewContext.expectedOutputContract.some(
    (item) =>
      item.keyHash === hashText('review') &&
      item.kind === 'JSON' &&
      item.contractIdHash === hashText('fixture.review') &&
      item.contractVersion === '1',
  ),
);
assert.equal(reviewContext.publicState, 'RUNNING');
assert.equal(JSON.stringify(reviewContext).includes('PRIVATE_MEMORY_SENTINEL'), false);
assert.equal(JSON.stringify(reviewContext).includes('PRIVATE_INSTRUCTIONS_SENTINEL'), false);

const reviewCall = fixtureObserver.modelCalls.find(
  (call) =>
    call.missionId === missionIds.workflow &&
    call.teammateId === actorA.teammateId &&
    call.selectionHash === reviewReceipt.inputHash,
);
assert.ok(reviewCall);
assertSameIds(reviewCall.selectedSkillIds, actorA.workflowSkillIds);
assert.notDeepEqual(
  reviewCall.selectedSkillIds,
  actorA.freeSkillIds,
  'Workflow Step metadata must change relevance from the free Mission objective',
);

const partyCallsA = fixtureObserver.modelCalls.filter(
  (call) => call.missionId === missionIds.party && call.teammateId === actorA.teammateId,
);
const partyCallsB = fixtureObserver.modelCalls.filter(
  (call) => call.missionId === missionIds.party && call.teammateId === actorB.teammateId,
);
assert.ok(partyCallsA.length >= 2);
assert.equal(partyCallsB.length, 1);
for (const call of partyCallsA) assertSameIds(call.selectedSkillIds, actorA.freeSkillIds);
for (const call of partyCallsB) assertSameIds(call.selectedSkillIds, actorB.freeSkillIds);
assert.ok(
  partyCallsA.every((call) =>
    call.selectedSkillIds.every((id) => !actorB.enabledActiveIds.includes(id)),
  ),
);
assert.ok(
  partyCallsB.every((call) =>
    call.selectedSkillIds.every((id) => !actorA.enabledActiveIds.includes(id)),
  ),
);
assert.ok(
  partyCallsB[0].structuredOutcomeContract,
  'Participant prompt must retain its structured Gate5 outcome contract',
);

const modelSummary = fixtureObserver.modelCalls.map((call) => ({
  missionId: call.missionId,
  runId: call.runId,
  teammateId: call.teammateId,
  runtimeProfileId: call.runtimeProfileId,
  phase: call.phase,
  method: call.method,
  selectedSkillIds: call.selectedSkillIds,
  instructionCharacters: call.instructionCharacters,
  skillSectionCharacters: call.skillSectionCharacters,
  structuredOutcomeContract: call.structuredOutcomeContract,
  selectionHash: call.selectionHash,
}));
for (const marker of [
  `PRIVATE_MEMORY_SENTINEL_${nonce}`,
  `R51_A_DISABLED_${nonce}`,
  `R51_A_ARCHIVED_${nonce}`,
  `R51_A_UNASSIGNED_${nonce}`,
  `R51_B_DISABLED_${nonce}`,
  `R51_B_ARCHIVED_${nonce}`,
  `R51_B_UNASSIGNED_${nonce}`,
]) {
  assert.equal(
    JSON.stringify(fixtureObserver).includes(marker),
    false,
    `Private or excluded marker leaked into observer evidence: ${marker}`,
  );
}

const finalDbFacts = openReadOnlyDatabase(fixtureProfile, (db) => {
  const migrations = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version);
  assert.deepEqual(
    migrations,
    Array.from({ length: 31 }, (_, index) => index + 1),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM mission_events WHERE event_type='skill.selection'").get()
      .n,
    receiptFacts.length,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='skill.selection'").get().n,
    receiptFacts.length,
  );
  const languageRuntimes = db
    .prepare("SELECT id FROM runtime_profiles WHERE id IN (?,?) AND execution_protocol='LANGUAGE'")
    .all(actorA.runtimeProfileId, actorB.runtimeProfileId)
    .map((item) => item.id);
  assert.deepEqual(
    new Set(languageRuntimes),
    new Set([actorA.runtimeProfileId, actorB.runtimeProfileId]),
  );
  return {
    migrations,
    durableSelectionEvents: receiptFacts.length,
    durableSelectionAudits: receiptFacts.length,
    languageRuntimes,
  };
});

mkdirSync(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, 'facts.json');
const evidence = {
  verifiedAt: new Date().toISOString(),
  schemaVersion: 31,
  production: { ...productionFacts, database: productionDatabase },
  fixture: {
    ...fixtureFacts,
    database: finalDbFacts,
    durableSelections: receiptFacts,
    decisions: fixtureObserver.decisions.map(
      ({
        type,
        questionVersion,
        stateHash,
        candidateIds,
        contextKeys,
        contextFacts,
        historyLeak,
        containsInstructionMarker,
      }) => ({
        type,
        questionVersion,
        stateHash,
        candidateIds,
        contextKeys,
        contextFacts,
        historyLeak,
        containsInstructionMarker,
      }),
    ),
    modelCalls: modelSummary,
  },
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`R5_1_PACKAGED_EVIDENCE ${evidencePath}`);
console.log(
  `R5_1_PACKAGED_SMOKE_OK production=normal_fixture_free fixture=explicit_top3=1-3 party=own_actor_skills workflow=bounded_step_context fallback=deterministic_real_model_call migration=31 shadow=off evidence=${evidencePath}`,
);

async function readObserver(profile) {
  const path = join(profile, 'r5-1-execution-facts.json');
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(50);
  assert.ok(existsSync(path), 'Explicit fixture must write bounded R5.1 execution summaries');
  return JSON.parse(readFileSync(path, 'utf8'));
}
