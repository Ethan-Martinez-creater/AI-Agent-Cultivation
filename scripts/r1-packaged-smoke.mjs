import { navigateUi } from './ui-navigation.mjs';
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

const app = await electron.launch({
  executablePath,
  args: ['--gate1-fake-model'],
  timeout: 30_000,
  env: { ...process.env, CULTIVATION_USER_DATA_DIR: userData },
});
let facts;
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  facts = await page.evaluate(async () => {
    const api = window.cultivation;
    const provider = await api.providers.create({
      name: 'R1 Benchmark Provider',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const sourceRuntime = await api.runtimes.create({
      name: 'R1 Benchmark Runtime',
      providerId: provider.id,
      credentialId: null,
      modelId: 'r1-benchmark-model',
    });
    const teammate = await api.teammates.create({
      name: 'R1 Benchmark Executor',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: 'Be concise.',
      behaviorPrompt: '',
      currentRuntimeProfileId: sourceRuntime.id,
    });
    const runtimeProfileId = teammate.currentRuntimeProfileId;
    const runtimes = await api.runtimes.list();
    const runtime = runtimes.find((item) => item.id === runtimeProfileId);
    if (!runtime) throw new Error('Sealed Runtime profile is missing');

    const saveBenchmark = (dimension, supported, normalizedScore) =>
      api.capability.saveBenchmark({
        runtimeProfileId,
        modelAlias: runtime.modelId,
        dimension,
        supported,
        normalizedScore,
        rawScore: null,
        source: 'R1 packaged smoke',
        benchmark: 'Deterministic fixture',
        benchmarkVersion: '1',
        snapshotDate: '2026-01-01T00:00:00.000Z',
        sourceUrl: null,
        provenanceType: 'USER_ESTIMATE',
      });
    await saveBenchmark('GENERAL_REASONING', true, 82);
    await saveBenchmark('CODING', false, null);
    const profile = await api.capability.profile(teammate.id);
    const mission = await api.missions.create({
      title: 'R1 benchmark-only completion',
      objective: 'Complete one normal Mission without creating capability ratings.',
      coordinatorTeammateId: teammate.id,
    });
    await api.missions.ready(mission.id);
    const started = await api.missions.start({ missionId: mission.id, approvalFixture: false });
    const detail = await api.missions.detail(mission.id);
    return {
      sourceRuntimeId: sourceRuntime.id,
      runtimeProfileId,
      runtimeModelId: runtime.modelId,
      teammateId: teammate.id,
      missionId: mission.id,
      runId: started.runs[0]?.id,
      missionState: detail.mission.state,
      profile,
      ratingApisRemoved:
        !Object.hasOwn(api.capability, 'submitRating') &&
        !Object.hasOwn(api.capability, 'ratingTargets'),
    };
  });

  assert.ok(facts.sourceRuntimeId);
  assert.ok(facts.runtimeProfileId);
  assert.notEqual(facts.runtimeProfileId, facts.sourceRuntimeId);
  assert.equal(facts.runtimeModelId, 'r1-benchmark-model');
  assert.equal(facts.missionState, 'COMPLETED');
  assert.equal(facts.ratingApisRemoved, true);
  await navigateUi(page, '历练 Missions');
  await page.locator('.mission-filter-tabs').getByRole('tab', { name: /全部/ }).click();
  await page.getByRole('button', { name: /R1 benchmark-only completion/ }).click();
  assert.equal(await page.getByText('本次历练评价 · 可跳过').count(), 0);
  const row = (dimension) => facts.profile.dimensions.find((item) => item.dimension === dimension);
  assert.equal(facts.profile.currentRuntimeProfileId, facts.runtimeProfileId);
  assert.equal(row('GENERAL_REASONING').currentScore, 82);
  assert.equal(row('GENERAL_REASONING').prior.normalizedScore, 82);
  assert.equal(row('GENERAL_REASONING').source, 'BENCHMARK_ONLY');
  assert.equal(row('GENERAL_REASONING').ratingCount, 0);
  assert.equal(row('GENERAL_REASONING').evidenceWeight, 0);
  assert.equal(row('CODING').currentScore, null);
  assert.equal(row('CODING').source, 'UNSUPPORTED');
} finally {
  await app.close();
}

const db = new Database(join(userData, 'data', 'cultivation.sqlite'), { readonly: true });
try {
  assert.equal(
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    17,
  );
  const benchmarks = db
    .prepare(
      `SELECT runtime_profile_id, dimension, supported, normalized_score
       FROM model_capability_benchmarks ORDER BY dimension`,
    )
    .all();
  assert.equal(benchmarks.length, 2);
  assert.ok(benchmarks.every((item) => item.runtime_profile_id === facts.runtimeProfileId));
  assert.deepEqual(
    benchmarks.map(({ dimension, supported, normalized_score }) => ({
      dimension,
      supported,
      normalized_score,
    })),
    [
      { dimension: 'CODING', supported: 0, normalized_score: null },
      { dimension: 'GENERAL_REASONING', supported: 1, normalized_score: 82 },
    ],
  );
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM capability_evidence').get().n,
    0,
    'A completed Mission must not write dynamic capability evidence',
  );
  const binding = db
    .prepare(
      `SELECT teammate_id, runtime_profile_id, provider_kind, endpoint, model_id,
              credential_id, verified_at, verification_source, sealed_at
       FROM teammate_model_bindings WHERE teammate_id = ?`,
    )
    .get(facts.teammateId);
  assert.equal(binding.teammate_id, facts.teammateId);
  assert.equal(binding.runtime_profile_id, facts.runtimeProfileId);
  assert.equal(binding.provider_kind, 'OPENAI_COMPATIBLE');
  assert.equal(binding.model_id, 'r1-benchmark-model');
  assert.ok(binding.endpoint.startsWith('http://127.0.0.1:9999/v1'));
  assert.equal(binding.verification_source, 'LIVE_TEST');
  assert.ok(binding.verified_at);
  assert.ok(binding.sealed_at);
} finally {
  db.close();
}
console.log(
  'R1_PACKAGED_SMOKE_OK benchmark_only=ok unsupported_distinct=ok private_runtime_binding=sealed rating_ipc_removed=ok no_evidence_writes=ok',
);
