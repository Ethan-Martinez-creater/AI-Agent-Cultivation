import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import Database from 'better-sqlite3';

const executablePath = join(
  process.cwd(),
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
const userData = join(process.cwd(), '.test-data', `r1-packaged-${Date.now()}`);
mkdirSync(userData, { recursive: true });

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

const first = await launch();
let facts;
try {
  facts = await first.page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'R1 Fake Provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const runtimeA = await api.runtimes.create({
      name: 'R1 A',
      providerId: provider.id,
      credentialId: null,
      modelId: 'r1-a',
    });
    const runtimeB = await api.runtimes.create({
      name: 'R1 B',
      providerId: provider.id,
      credentialId: null,
      modelId: 'r1-b',
    });
    const teammate = await api.teammates.create({
      name: 'R1 Executor',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: 'Be concise.',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtimeA.id,
    });
    const unexecuted = await api.teammates.create({
      name: 'R1 Unexecuted',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      currentRuntimeProfileId: runtimeA.id,
    });
    const benchmark = async (runtime, dimension, supported, normalizedScore) =>
      api.capability.saveBenchmark({
        runtimeProfileId: runtime.id,
        modelAlias: runtime.modelId,
        dimension,
        supported,
        normalizedScore,
        rawScore: null,
        source: 'Packaged smoke fixture',
        benchmark: 'Deterministic fixture',
        benchmarkVersion: '1',
        snapshotDate: '2026-01-01T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
    await benchmark(runtimeA, 'GENERAL_REASONING', true, 80);
    await benchmark(runtimeA, 'CODING', false, null);
    await benchmark(runtimeB, 'GENERAL_REASONING', true, 20);
    await benchmark(runtimeB, 'CODING', true, 60);
    const initial = await api.capability.profile(teammate.id);
    const mission = await api.missions.create({
      title: 'R1 actual execution',
      objective: 'One model call',
      coordinatorTeammateId: teammate.id,
    });
    await api.missions.ready(mission.id);
    const detail = await api.missions.start({ missionId: mission.id, approvalFixture: false });
    const runId = detail.runs[0].id;
    const targets = await api.capability.ratingTargets({ missionId: mission.id, runId });
    const deniedUnexecuted = await api.capability
      .submitRating({
        missionId: mission.id,
        runId,
        teammateId: unexecuted.id,
        runtimeProfileId: runtimeA.id,
        selectedDimensions: ['GENERAL_REASONING'],
        overallRating: 5,
      })
      .then(
        () => false,
        () => true,
      );
    await api.capability.submitRating({
      missionId: mission.id,
      runId,
      teammateId: teammate.id,
      runtimeProfileId: runtimeA.id,
      selectedDimensions: ['GENERAL_REASONING'],
      overallRating: 1,
    });
    const duplicateRejected = await api.capability
      .submitRating({
        missionId: mission.id,
        runId,
        teammateId: teammate.id,
        runtimeProfileId: runtimeA.id,
        selectedDimensions: ['GENERAL_REASONING'],
        overallRating: 1,
      })
      .then(
        () => false,
        () => true,
      );
    const afterRating = await api.capability.profile(teammate.id);
    const switched = await api.teammates.switchRuntime({
      teammateId: teammate.id,
      runtimeProfileId: runtimeB.id,
    });
    const afterSwitch = await api.capability.profile(teammate.id);
    const another = await api.missions.create({
      title: 'R1 skip',
      objective: 'Skip rating',
      coordinatorTeammateId: teammate.id,
    });
    await api.missions.ready(another.id);
    const anotherDetail = await api.missions.start({
      missionId: another.id,
      approvalFixture: false,
    });
    const skipped = await api.capability.submitRating({
      missionId: another.id,
      runId: anotherDetail.runs[0].id,
      teammateId: teammate.id,
      runtimeProfileId: runtimeB.id,
      selectedDimensions: [],
      skip: true,
    });
    const advancedMission = await api.missions.create({
      title: 'R1 advanced rating',
      objective: 'Advanced dimension rating',
      coordinatorTeammateId: teammate.id,
    });
    await api.missions.ready(advancedMission.id);
    const advancedRun = await api.missions.start({
      missionId: advancedMission.id,
      approvalFixture: false,
    });
    const advanced = await api.capability.submitRating({
      missionId: advancedMission.id,
      runId: advancedRun.runs[0].id,
      teammateId: teammate.id,
      runtimeProfileId: runtimeB.id,
      selectedDimensions: ['GENERAL_REASONING', 'CODING'],
      overallRating: 3,
      dimensionRatings: { CODING: 5 },
    });
    const afterAdvanced = await api.capability.profile(teammate.id);
    return {
      teammateId: teammate.id,
      unexecutedId: unexecuted.id,
      runtimeA: runtimeA.id,
      runtimeB: runtimeB.id,
      initial,
      targets,
      deniedUnexecuted,
      duplicateRejected,
      afterRating,
      switched,
      afterSwitch,
      skipped,
      advanced,
      afterAdvanced,
    };
  });
  const row = (profile, dimension) =>
    profile.dimensions.find((item) => item.dimension === dimension);
  assert.equal(row(facts.initial, 'GENERAL_REASONING').currentScore, 80);
  assert.equal(row(facts.initial, 'CODING').currentScore, null);
  assert.equal(facts.targets.length, 1);
  assert.equal(facts.targets[0].teammateId, facts.teammateId);
  assert.deepEqual(facts.targets[0].supportedDimensions, ['GENERAL_REASONING']);
  assert.equal(facts.deniedUnexecuted, true);
  assert.equal(facts.duplicateRejected, true);
  assert.ok(row(facts.afterRating, 'GENERAL_REASONING').currentScore < 80);
  assert.ok(row(facts.afterRating, 'GENERAL_REASONING').currentScore > 50);
  assert.equal(facts.switched.id, facts.teammateId);
  assert.equal(facts.afterSwitch.currentRuntimeProfileId, facts.runtimeB);
  assert.ok(row(facts.afterSwitch, 'GENERAL_REASONING').currentScore < 20);
  assert.ok(row(facts.afterSwitch, 'GENERAL_REASONING').currentScore > 0);
  assert.equal(facts.skipped.skipped, true);
  assert.equal(facts.skipped.evidence.length, 0);
  assert.equal(facts.advanced.evidence.length, 2);
  assert.equal(
    facts.advanced.evidence.find((item) => item.dimension === 'CODING').sourceType,
    'USER_DIMENSION_RATING',
  );
  assert.equal(
    facts.advanced.evidence.find((item) => item.dimension === 'GENERAL_REASONING').sourceType,
    'USER_OVERALL_RATING',
  );
  await first.page.getByRole('link', { name: '设置 Settings' }).click();
  await first.page.getByRole('tab', { name: '能力画像 / Benchmark' }).click();
  await first.page.getByRole('heading', { name: '能力画像 / Benchmark' }).waitFor();
  await first.page.getByRole('link', { name: '道友 Teammates' }).click();
  await first.page.getByRole('heading', { name: '动态能力 · Capability' }).waitFor();
  await first.page.getByRole('link', { name: '历练 Missions' }).click();
  await first.page.getByRole('button', { name: /R1 skip/ }).click();
  await first.page.getByRole('heading', { name: '本次历练评价 · 可跳过' }).waitFor();
} finally {
  await first.app.close();
}

const dbPath = join(userData, 'data', 'cultivation.sqlite');
const db = new Database(dbPath);
try {
  assert.equal(
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    12,
  );
  const evidence = db
    .prepare('SELECT teammate_id, runtime_profile_id, source_type FROM capability_evidence')
    .all();
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((item) => item.teammate_id === facts.teammateId));
  assert.equal(evidence.filter((item) => item.runtime_profile_id === facts.runtimeA).length, 1);
  assert.equal(evidence.filter((item) => item.runtime_profile_id === facts.runtimeB).length, 2);
  assert.equal(evidence.filter((item) => item.source_type === 'USER_DIMENSION_RATING').length, 1);
  assert.equal(
    db
      .prepare('SELECT count(*) AS n FROM teammate_capability_states WHERE teammate_id = ?')
      .get(facts.unexecutedId).n,
    1,
  );
  // Only the projection is removed; immutable benchmarks, execution facts and evidence remain.
  db.prepare('DELETE FROM teammate_capability_states WHERE teammate_id = ?').run(facts.teammateId);
} finally {
  db.close();
}

const second = await launch();
try {
  const rebuilt = await second.page.evaluate(
    (id) => window.cultivation.capability.profile(id),
    facts.teammateId,
  );
  assert.deepEqual(rebuilt, facts.afterAdvanced);
  const twice = await second.page.evaluate(
    (id) => window.cultivation.capability.rebuild(id),
    facts.teammateId,
  );
  assert.equal(twice.length, 2);
} finally {
  await second.app.close();
}
console.log(
  'R1_PACKAGED_SMOKE_OK benchmark=runtime_supported rating=actual_actor migration=recomposed rebuild=restart_safe',
);
