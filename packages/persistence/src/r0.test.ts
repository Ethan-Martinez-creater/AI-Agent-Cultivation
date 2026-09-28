import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  databasePath,
  Gate1SqliteRepository,
  migrations,
  openDatabase,
  R0SqliteRepository,
  runMigrations,
} from './index.js';
import type {
  CapabilityEvidenceRecord,
  DecisionReceiptRecord,
  ExternalAppProfileRecord,
  ExternalWorkArtifactRecord,
  ExternalWorkRequestRecord,
  ModelCapabilityBenchmarkRecord,
  TeammateCapabilityStateRecord,
} from './r0.js';

function makeDatabase(steps: typeof migrations = migrations): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, steps);
  return db;
}

function seedRuntimeAndTeammates(db: Database.Database): void {
  db.prepare(
    `INSERT INTO providers (id, name, kind, created_at, updated_at)
     VALUES ('provider-1', 'Provider', 'OPENAI', 'created', 'updated')`,
  ).run();
  db.prepare(
    `INSERT INTO runtime_profiles
       (id, name, provider_id, model_id, created_at, updated_at)
     VALUES ('runtime-1', 'Runtime', 'provider-1', 'model-1', 'created', 'updated')`,
  ).run();
  db.prepare(
    `INSERT INTO teammates (id, name, created_at, updated_at)
     VALUES ('coordinator', 'Coordinator', 'created', 'updated')`,
  ).run();
}

function seedMissionRun(
  db: Database.Database,
  missionId = 'mission-1',
  runId = 'run-1',
  coordinatorId = 'coordinator',
): void {
  db.prepare(
    `INSERT INTO missions
      (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
       mode, state, created_at, updated_at)
     VALUES (?, 'Mission', 'Objective', 'USER', 'user-1', ?, 'SOLO', 'RUNNING', 'created', 'updated')`,
  ).run(missionId, coordinatorId);
  db.prepare(
    `INSERT INTO mission_participants (mission_id, teammate_id, role)
     VALUES (?, ?, 'COORDINATOR')`,
  ).run(missionId, coordinatorId);
  db.prepare(
    `INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
     VALUES (?, ?, 1, 'RUNNING', 'started')`,
  ).run(runId, missionId);
}

function benchmark(
  value: Partial<ModelCapabilityBenchmarkRecord> &
    Pick<ModelCapabilityBenchmarkRecord, 'id' | 'dimension'>,
): ModelCapabilityBenchmarkRecord {
  return {
    id: value.id,
    runtimeProfileId: value.runtimeProfileId ?? 'runtime-1',
    modelAlias: value.modelAlias ?? 'model-alias',
    dimension: value.dimension,
    supported: value.supported ?? true,
    normalizedScore: value.normalizedScore === undefined ? 74 : value.normalizedScore,
    rawScore: value.rawScore === undefined ? 0.78 : value.rawScore,
    source: value.source ?? 'catalog',
    benchmark: value.benchmark ?? 'index',
    benchmarkVersion: value.benchmarkVersion ?? 'v1',
    snapshotDate: value.snapshotDate ?? '2026-09-27',
    sourceUrl: value.sourceUrl ?? 'https://example.test/benchmark',
    provenanceType: value.provenanceType ?? 'CATALOG',
    createdAt: value.createdAt ?? '2026-09-27T00:00:00.000Z',
  };
}

function capabilityEvidence(
  value: Partial<CapabilityEvidenceRecord> & Pick<CapabilityEvidenceRecord, 'id'>,
): CapabilityEvidenceRecord {
  return {
    id: value.id,
    teammateId: value.teammateId ?? 'coordinator',
    runtimeProfileId: value.runtimeProfileId === undefined ? 'runtime-1' : value.runtimeProfileId,
    missionId: value.missionId ?? 'mission-1',
    runId: value.runId ?? 'run-1',
    dimension: value.dimension ?? 'CODING',
    sourceType: value.sourceType ?? 'USER_DIMENSION_RATING',
    ratingValue: value.ratingValue ?? 75,
    demandWeight: value.demandWeight ?? 0.8,
    evidenceWeight: value.evidenceWeight ?? 0.6,
    createdAt: value.createdAt ?? 'evidence-time',
  };
}

function receipt(
  id: string,
  missionId: string | null,
  runId: string | null,
): DecisionReceiptRecord {
  return {
    id,
    missionId,
    runId,
    decisionType: 'TASK_CAPABILITY_DEMAND',
    provider: 'jev',
    model: 'jev-1.13.0',
    modelVersion: '1.13.0',
    questionVersion: 'capabilities-v1',
    stateHash: 'state-hash',
    inputSummary: 'Bounded decision summary',
    answersJson: { dimensions: ['CODING'] },
    confidenceJson: { CODING: 0.91 },
    policyVersion: 'routing-v1',
    selectedAction: 'candidate-1',
    mode: 'SHADOW',
    createdAt: 'created',
  };
}

function externalRequest(id: string, assigneeTeammateId: string): ExternalWorkRequestRecord {
  return {
    id,
    missionId: 'mission-1',
    runId: 'run-1',
    requesterTeammateId: 'coordinator',
    assigneeTeammateId,
    capability: 'IMAGE_GENERATION',
    title: 'Create a cover image',
    prompt: 'Create the requested image in the selected application.',
    requirementsJson: { items: ['1024 by 1024 pixels'] },
    targetArtifactsJson: {
      items: [
        {
          id: 'primary-image',
          name: 'Primary image',
          required: true,
          allowedExtensions: ['png'],
          maxSizeBytes: 4_194_304,
        },
      ],
    },
    targetWorkspacePathsJson: { items: ['workspace/output'] },
    acceptanceCriteriaJson: { items: ['Use the png extension'] },
    externalAppProfileId: null,
    publicResult: null,
    state: 'PENDING',
    createdAt: 'created',
    submittedAt: null,
    resolvedAt: null,
  };
}

function artifact(id: string, requestId: string, submittedAt: string): ExternalWorkArtifactRecord {
  return {
    id,
    externalWorkRequestId: requestId,
    path: 'workspace/output/image.png',
    fileName: 'image.png',
    extension: 'png',
    sizeBytes: 2048,
    mimeType: 'image/png',
    metadataJson: { width: 1024, height: 1024 },
    submittedAt,
  };
}

describe('R0 routing persistence', () => {
  it('upgrades a Migration 1 database and preserves existing Teammate and Mission defaults', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [migrations[0]!]);
    seedRuntimeAndTeammates(db);
    db.prepare(
      `INSERT INTO missions
        (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
         mode, state, created_at, updated_at)
       VALUES ('old-mission', 'Old', 'Keep this', 'USER', 'user-1', 'coordinator',
         'SOLO', 'WAITING_APPROVAL', 'created', 'updated')`,
    ).run();

    runMigrations(db, migrations);

    expect(
      db.prepare('SELECT executor_kind, routing_policy, system_kind FROM teammates').get(),
    ).toEqual({ executor_kind: 'MODEL_RUNTIME', routing_policy: 'NORMAL', system_kind: null });
    expect(db.prepare('SELECT id, state, objective FROM missions').get()).toEqual({
      id: 'old-mission',
      state: 'WAITING_APPROVAL',
      objective: 'Keep this',
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('upgrades Migration 8 without losing Mission facts, then resumes WAITING_EXTERNAL_WORK after reopen', () => {
    const directory = join(
      process.cwd(),
      'packages',
      'persistence',
      '.test-data',
      `r0-migration-${crypto.randomUUID()}`,
    );
    mkdirSync(directory, { recursive: true });
    const path = databasePath(directory);
    mkdirSync(dirname(path), { recursive: true });
    const oldDb = new Database(path);
    oldDb.pragma('foreign_keys = ON');
    runMigrations(oldDb, migrations.slice(0, 8));
    seedRuntimeAndTeammates(oldDb);
    seedMissionRun(oldDb);
    oldDb
      .prepare(
        `INSERT INTO mission_events
        (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
       VALUES ('event-1', 'mission-1', 'run-1', 'model.call_started', 'TEAMMATE',
        'coordinator', '{}', 'event-time')`,
      )
      .run();
    oldDb
      .prepare(
        `INSERT INTO permission_rules
        (id, subject_type, subject_id, capability, resource_pattern, decision, scope, scope_id)
       VALUES ('permission-1', 'USER', 'user-1', 'FILE_READ', '*', 'ALLOW', 'MISSION', 'mission-1')`,
      )
      .run();
    oldDb
      .prepare(
        `INSERT INTO audit_events
        (id, actor_type, actor_id, action, target_type, target_id, payload_json, created_at)
       VALUES ('audit-1', 'USER', 'user-1', 'mission.reviewed', 'MISSION', 'mission-1', '{}', 'audit-time')`,
      )
      .run();
    oldDb
      .prepare(
        "UPDATE mission_runs SET status = 'COMPLETED', ended_at = 'ended' WHERE id = 'run-1'",
      )
      .run();
    oldDb
      .prepare(
        `INSERT INTO experience_events
        (id, teammate_id, mission_id, run_id, experience_type, source, source_id,
         role, outcome, mode, created_at)
       VALUES ('experience-1', 'coordinator', 'mission-1', 'run-1', 'MISSION_RESULT',
         'MISSION_RUN', 'run-1', 'COORDINATOR', 'COMPLETED', 'SOLO', 'experience-time')`,
      )
      .run();
    oldDb.prepare("UPDATE missions SET state = 'WAITING_APPROVAL' WHERE id = 'mission-1'").run();
    oldDb.close();

    let db = new Database(path);
    db.pragma('foreign_keys = ON');
    db.pragma('legacy_alter_table = ON');
    runMigrations(db, migrations);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('legacy_alter_table', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT id, state FROM missions').get()).toEqual({
      id: 'mission-1',
      state: 'WAITING_APPROVAL',
    });
    expect(db.prepare('SELECT id, mission_id, status FROM mission_runs').all()).toEqual([
      { id: 'run-1', mission_id: 'mission-1', status: 'COMPLETED' },
    ]);
    expect(db.prepare('SELECT id, mission_id, run_id FROM mission_events').all()).toEqual([
      { id: 'event-1', mission_id: 'mission-1', run_id: 'run-1' },
    ]);
    expect(db.prepare('SELECT id, scope_id FROM permission_rules').all()).toEqual([
      { id: 'permission-1', scope_id: 'mission-1' },
    ]);
    expect(db.prepare('SELECT id, target_id FROM audit_events').all()).toEqual([
      { id: 'audit-1', target_id: 'mission-1' },
    ]);
    expect(db.prepare('SELECT id, source_id FROM experience_events').all()).toEqual([
      { id: 'experience-1', source_id: 'run-1' },
    ]);
    db.prepare(
      "UPDATE missions SET state = 'WAITING_EXTERNAL_WORK', updated_at = 'waiting' WHERE id = 'mission-1'",
    ).run();
    db.close();

    db = openDatabase(path);
    expect(db.prepare('SELECT state FROM missions WHERE id = ?').get('mission-1')).toEqual({
      state: 'WAITING_EXTERNAL_WORK',
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  }, 30_000);

  it('adds R1 benchmark timestamps and scoring policy versions while preserving prior rows', () => {
    const db = makeDatabase(migrations.slice(0, 10));
    seedRuntimeAndTeammates(db);
    db.prepare(
      `INSERT INTO model_capability_benchmarks
        (id, runtime_profile_id, model_alias, dimension, supported, normalized_score, raw_score,
         source, benchmark, benchmark_version, snapshot_date, source_url, provenance_type)
       VALUES ('legacy-benchmark', 'runtime-1', 'model-alias', 'CODING', 1, 72, 0.72,
         'catalog', 'index', 'v1', '2026-09-20', NULL, 'CATALOG')`,
    ).run();
    db.prepare(
      `INSERT INTO teammate_capability_states
        (teammate_id, dimension, current_score, evidence_weight, rating_count,
         current_runtime_profile_id, updated_at)
       VALUES ('coordinator', 'CODING', 62, 1.5, 2, 'runtime-1', 'legacy-state-time')`,
    ).run();

    runMigrations(db, migrations);

    expect(
      db
        .prepare('SELECT created_at FROM model_capability_benchmarks WHERE id = ?')
        .get('legacy-benchmark'),
    ).toEqual({ created_at: '2026-09-20' });
    expect(
      db.prepare('SELECT scoring_policy_version FROM teammate_capability_states').get(),
    ).toEqual({ scoring_policy_version: 'r0-unversioned' });

    const repository = new R0SqliteRepository(db);
    const ingested = benchmark({
      id: 'ingested-benchmark',
      dimension: 'CODING',
      createdAt: '2026-09-28T10:00:00.000Z',
    });
    repository.saveModelCapabilityBenchmark(ingested);
    expect(repository.getModelCapabilityBenchmark(ingested.id)).toEqual(ingested);
    expect(() =>
      db.prepare("UPDATE model_capability_benchmarks SET created_at = 'edited'").run(),
    ).toThrow();
    expect(() => db.prepare('DELETE FROM model_capability_benchmarks').run()).toThrow();
    db.close();
  });

  it('stores benchmark priors, current capability state, immutable evidence, and bounded decision receipts', () => {
    const db = makeDatabase();
    seedRuntimeAndTeammates(db);
    seedMissionRun(db);
    const repository = new R0SqliteRepository(db);

    const unsupported = benchmark({
      id: 'benchmark-unsupported',
      dimension: 'VIDEO_GENERATION',
      supported: false,
      normalizedScore: null,
      rawScore: null,
    });
    const lowScore = benchmark({
      id: 'benchmark-low-score',
      dimension: 'CODING',
      supported: true,
      normalizedScore: 4,
    });
    repository.saveModelCapabilityBenchmark(unsupported);
    repository.saveModelCapabilityBenchmark(lowScore);
    expect(repository.getModelCapabilityBenchmark(unsupported.id)).toEqual(unsupported);
    expect(repository.listModelCapabilityBenchmarks('runtime-1')).toEqual([lowScore, unsupported]);
    expect(() =>
      repository.saveModelCapabilityBenchmark(
        benchmark({ id: 'invalid-unsupported', dimension: 'MUSIC_GENERATION', supported: false }),
      ),
    ).toThrow();
    expect(() => db.prepare('DELETE FROM model_capability_benchmarks').run()).toThrow();

    const state: TeammateCapabilityStateRecord = {
      teammateId: 'coordinator',
      dimension: 'CODING',
      currentScore: 63,
      evidenceWeight: 2.5,
      ratingCount: 3,
      currentRuntimeProfileId: 'runtime-1',
      scoringPolicyVersion: 'r1-test-v1',
      updatedAt: 'state-time',
    };
    repository.saveTeammateCapabilityState(state);
    expect(repository.getTeammateCapabilityState('coordinator', 'CODING')).toEqual(state);
    repository.saveTeammateCapabilityState({ ...state, currentScore: 70, updatedAt: 'later' });
    expect(repository.listTeammateCapabilityStates('coordinator')).toEqual([
      { ...state, currentScore: 70, updatedAt: 'later' },
    ]);

    db.prepare(
      `INSERT INTO mission_events
        (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
       VALUES ('evidence-model-call', 'mission-1', 'run-1', 'model.call_started',
         'TEAMMATE', 'coordinator', '{"runtimeProfileId":"runtime-1","modelId":"model-1"}', 'call-time')`,
    ).run();
    db.prepare(
      "UPDATE mission_runs SET status = 'COMPLETED', ended_at = 'ended' WHERE id = 'run-1'",
    ).run();

    const evidence: CapabilityEvidenceRecord = {
      id: 'evidence-1',
      teammateId: 'coordinator',
      runtimeProfileId: 'runtime-1',
      missionId: 'mission-1',
      runId: 'run-1',
      dimension: 'CODING',
      sourceType: 'USER_DIMENSION_RATING',
      ratingValue: 75,
      demandWeight: 0.8,
      evidenceWeight: 0.6,
      createdAt: 'evidence-time',
    };
    repository.appendCapabilityEvidence(evidence);
    expect(repository.listCapabilityEvidence('coordinator', 'CODING')).toEqual([evidence]);
    expect(() => db.prepare('UPDATE capability_evidence SET rating_value = 0').run()).toThrow();

    const value = receipt('receipt-1', 'mission-1', 'run-1');
    repository.appendDecisionReceipt(value);
    expect(repository.getDecisionReceipt(value.id)).toEqual(value);
    expect(repository.listDecisionReceipts('mission-1', 'run-1')).toEqual([value]);
    expect(() =>
      repository.appendDecisionReceipt({
        ...value,
        id: 'too-long-summary',
        inputSummary: 'x'.repeat(2001),
      }),
    ).toThrow();
    expect(() => db.prepare('DELETE FROM decision_receipts').run()).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('replaces capability state projections atomically and records their scoring policy', () => {
    const db = makeDatabase();
    seedRuntimeAndTeammates(db);
    const repository = new R0SqliteRepository(db);
    const coding: TeammateCapabilityStateRecord = {
      teammateId: 'coordinator',
      dimension: 'CODING',
      currentScore: 63,
      evidenceWeight: 2.5,
      ratingCount: 3,
      currentRuntimeProfileId: 'runtime-1',
      scoringPolicyVersion: 'r1-v1',
      updatedAt: 'first-projection',
    };
    const reasoning: TeammateCapabilityStateRecord = {
      ...coding,
      dimension: 'GENERAL_REASONING',
      currentScore: 81,
    };
    repository.replaceTeammateCapabilityStates('coordinator', [coding, reasoning]);
    expect(repository.listTeammateCapabilityStates('coordinator')).toHaveLength(2);

    const updatedCoding = { ...coding, currentScore: 70, scoringPolicyVersion: 'r1-v2' };
    repository.replaceTeammateCapabilityStates('coordinator', [updatedCoding]);
    expect(repository.listTeammateCapabilityStates('coordinator')).toEqual([updatedCoding]);

    expect(() =>
      repository.replaceTeammateCapabilityStates('coordinator', [
        { ...updatedCoding, currentScore: 74, updatedAt: 'partial-write' },
        {
          ...updatedCoding,
          dimension: 'TOOL_USE',
          currentScore: 101,
          updatedAt: 'invalid-row',
        },
      ]),
    ).toThrow();
    expect(repository.listTeammateCapabilityStates('coordinator')).toEqual([updatedCoding]);
    expect(() =>
      repository.replaceTeammateCapabilityStates('coordinator', [
        { ...updatedCoding, teammateId: 'missing-teammate' },
      ]),
    ).toThrow(/belong to the requested Teammate/);
    expect(repository.listTeammateCapabilityStates('coordinator')).toEqual([updatedCoding]);
    db.close();
  });

  it('returns runtime assignments and aliases from persisted Runtime profiles', () => {
    const db = makeDatabase();
    seedRuntimeAndTeammates(db);
    db.prepare(
      `INSERT INTO runtime_profiles
        (id, name, provider_id, model_id, created_at, updated_at)
       VALUES ('runtime-2', 'Second Runtime', 'provider-1', 'model-2', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO teammates (id, name, current_runtime_profile_id, created_at, updated_at)
       VALUES ('member', 'Member', 'runtime-1', 'created', 'updated'),
              ('other-runtime', 'Other Runtime', 'runtime-2', 'created', 'updated')`,
    ).run();
    db.prepare(
      "UPDATE teammates SET current_runtime_profile_id = 'runtime-1' WHERE id = 'coordinator'",
    ).run();
    const repository = new R0SqliteRepository(db);
    repository.ensureHumanBridgeTeammate({
      id: 'human-bridge',
      createdAt: 'created',
      updatedAt: 'updated',
    });

    expect(repository.listTeammatesUsingRuntime('runtime-1')).toEqual([
      { id: 'coordinator', currentRuntimeProfileId: 'runtime-1' },
      { id: 'member', currentRuntimeProfileId: 'runtime-1' },
    ]);
    expect(repository.getRuntimeModelAlias('runtime-1')).toBe('model-1');
    expect(repository.getRuntimeModelAlias('missing-runtime')).toBeNull();
    expect(repository.getTeammate('coordinator')).toEqual({
      id: 'coordinator',
      currentRuntimeProfileId: 'runtime-1',
      executorKind: 'MODEL_RUNTIME',
    });
    expect(repository.getTeammate('human-bridge')).toEqual({
      id: 'human-bridge',
      currentRuntimeProfileId: null,
      executorKind: 'USER_BRIDGE',
    });
    expect(repository.getTeammate('missing-teammate')).toBeNull();
    db.close();
  });

  it('lists only model Teammates with actual execution on a terminal MissionRun', () => {
    const db = makeDatabase();
    seedRuntimeAndTeammates(db);
    seedMissionRun(db);
    db.prepare(
      `INSERT INTO runtime_profiles
        (id, name, provider_id, model_id, created_at, updated_at)
       VALUES ('runtime-2', 'Second Runtime', 'provider-1', 'model-2', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO teammates (id, name, current_runtime_profile_id, created_at, updated_at)
       VALUES ('member', 'Member', 'runtime-2', 'created', 'updated'),
              ('membership-only', 'Membership only', 'runtime-1', 'created', 'updated')`,
    ).run();
    const repository = new R0SqliteRepository(db);
    repository.ensureHumanBridgeTeammate({
      id: 'human-bridge',
      createdAt: 'created',
      updatedAt: 'updated',
    });
    db.prepare(
      `INSERT INTO mission_participants (mission_id, teammate_id, role, sort_order)
       VALUES ('mission-1', 'member', 'MEMBER', 1),
              ('mission-1', 'membership-only', 'MEMBER', 2),
              ('mission-1', 'human-bridge', 'MEMBER', 3)`,
    ).run();

    const insertModelCall = db.prepare(
      `INSERT INTO mission_events
        (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
       VALUES (?, 'mission-1', 'run-1', 'model.call_started', 'TEAMMATE', ?, ?, ?)`,
    );
    insertModelCall.run(
      'call-member',
      'member',
      JSON.stringify({ runtimeProfileId: 'runtime-2', modelId: 'model-2' }),
      'call-2',
    );
    insertModelCall.run(
      'call-bridge',
      'human-bridge',
      JSON.stringify({ runtimeProfileId: 'runtime-1', modelId: 'model-1' }),
      'call-3',
    );
    db.prepare(
      `INSERT INTO mission_events
        (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
       VALUES ('call-malformed', 'mission-1', 'run-1', 'model.call_started', 'TEAMMATE',
         'membership-only', 'not-json', 'call-4')`,
    ).run();
    db.prepare(
      `INSERT INTO usage_records
        (id, mission_id, run_id, teammate_id, runtime_profile_id, provider, model,
         input_tokens, output_tokens, created_at)
       VALUES ('usage-only-fact', 'mission-1', 'run-1', 'coordinator', 'runtime-1',
         'OPENAI', 'usage-model', 0, 0, 'usage-time')`,
    ).run();

    expect(repository.listMissionRunRatingTargets('mission-1', 'run-1')).toEqual([]);
    db.prepare(
      "UPDATE mission_runs SET status = 'COMPLETED', ended_at = 'ended' WHERE id = 'run-1'",
    ).run();
    expect(repository.listMissionRunRatingTargets('mission-1', 'run-1')).toEqual([
      { teammateId: 'coordinator', runtimeProfileId: 'runtime-1', modelAlias: 'usage-model' },
      { teammateId: 'member', runtimeProfileId: 'runtime-2', modelAlias: 'model-2' },
    ]);
    db.close();
  });

  it('appends 1–3 rating dimensions atomically and leaves evidence append-only', () => {
    const db = makeDatabase();
    seedRuntimeAndTeammates(db);
    seedMissionRun(db);
    db.prepare(
      `INSERT INTO mission_events
        (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
       VALUES ('evidence-call', 'mission-1', 'run-1', 'model.call_started', 'TEAMMATE',
         'coordinator', '{"runtimeProfileId":"runtime-1","modelId":"model-1"}', 'call-time')`,
    ).run();
    db.prepare(
      "UPDATE mission_runs SET status = 'COMPLETED', ended_at = 'ended' WHERE id = 'run-1'",
    ).run();
    const repository = new R0SqliteRepository(db);
    const first = capabilityEvidence({ id: 'rating-1' });
    const second = capabilityEvidence({ id: 'rating-2', dimension: 'TOOL_USE' });

    expect(() => repository.appendCapabilityEvidenceBatch([])).toThrow(/between 1 and 3/);
    expect(() =>
      repository.appendCapabilityEvidenceBatch([
        first,
        second,
        capabilityEvidence({ id: 'rating-3', dimension: 'GENERAL_REASONING' }),
        capabilityEvidence({ id: 'rating-4', dimension: 'AGENTIC_EXECUTION' }),
      ]),
    ).toThrow(/between 1 and 3/);
    repository.appendCapabilityEvidenceBatch([first, second]);
    expect(repository.listCapabilityEvidence('coordinator')).toEqual([first, second]);

    expect(() =>
      repository.appendCapabilityEvidenceBatch([
        capabilityEvidence({ id: 'must-roll-back', dimension: 'VISUAL_UNDERSTANDING' }),
        capabilityEvidence({ id: 'rating-1', dimension: 'GENERAL_REASONING' }),
      ]),
    ).toThrow();
    expect(repository.listCapabilityEvidence('coordinator')).toEqual([first, second]);
    expect(() => db.prepare('UPDATE capability_evidence SET rating_value = 0').run()).toThrow();
    expect(() => db.prepare('DELETE FROM capability_evidence').run()).toThrow();
    db.close();
  });

  it('ensures one immutable Human Bridge teammate and validates external work lifecycle/artifacts/apps', () => {
    const db = makeDatabase();
    seedRuntimeAndTeammates(db);
    seedMissionRun(db);
    const persistence = new Gate1SqliteRepository(db);
    const repository = new R0SqliteRepository(db);
    const bridge = repository.ensureHumanBridgeTeammate({
      id: 'human-bridge',
      createdAt: 'bridge-created',
      updatedAt: 'bridge-updated',
    });
    expect(bridge).toMatchObject({
      id: 'human-bridge',
      name: '本尊 / Human Bridge',
      currentRuntimeProfileId: null,
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
    });
    expect(
      repository.ensureHumanBridgeTeammate({
        id: 'ignored-second-id',
        createdAt: 'later',
        updatedAt: 'later',
      }).id,
    ).toBe('human-bridge');
    expect(() =>
      persistence.saveTeammate({
        ...bridge,
        executorKind: 'MODEL_RUNTIME',
        currentRuntimeProfileId: 'runtime-1',
        updatedAt: 'tamper',
      }),
    ).toThrow(/immutable/i);
    persistence.saveTeammate({ ...bridge, name: 'Human Bridge (edited)', updatedAt: 'edited' });
    expect(persistence.getTeammate('human-bridge')?.name).toBe('Human Bridge (edited)');
    expect(() => db.prepare("DELETE FROM teammates WHERE id = 'human-bridge'").run()).toThrow();
    expect(
      repository.updateHumanBridgeDisplay(bridge.id, {
        name: '本尊',
        avatar: 'human.png',
        title: 'Creator',
        description: 'Human controlled bridge',
        updatedAt: 'display-updated',
      }),
    ).toMatchObject({
      id: bridge.id,
      name: '本尊',
      avatar: 'human.png',
      title: 'Creator',
      description: 'Human controlled bridge',
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
      currentRuntimeProfileId: null,
    });
    expect(
      repository.updateHumanBridgeDisplay('coordinator', {
        name: 'Coordinator',
        avatar: null,
        title: null,
        description: '',
        updatedAt: 'ignored',
      }),
    ).toBeNull();

    expect(
      repository.saveHumanBridgeCapability({
        teammateId: bridge.id,
        dimension: 'IMAGE_GENERATION',
        enabled: true,
        updatedAt: 'capability-enabled',
      }),
    ).toEqual({
      teammateId: bridge.id,
      dimension: 'IMAGE_GENERATION',
      enabled: true,
      updatedAt: 'capability-enabled',
    });
    expect(repository.listHumanBridgeCapabilities(bridge.id)).toEqual([
      {
        teammateId: bridge.id,
        dimension: 'IMAGE_GENERATION',
        enabled: true,
        updatedAt: 'capability-enabled',
      },
    ]);
    repository.saveTeammateCapabilityState({
      teammateId: bridge.id,
      dimension: 'IMAGE_GENERATION',
      currentScore: 1,
      evidenceWeight: 0,
      ratingCount: 0,
      currentRuntimeProfileId: null,
      scoringPolicyVersion: 'human-bridge-prior-v1',
      updatedAt: 'prior',
    });
    repository.saveHumanBridgeCapability({
      teammateId: bridge.id,
      dimension: 'IMAGE_GENERATION',
      enabled: false,
      updatedAt: 'capability-disabled',
    });
    expect(repository.getTeammateCapabilityState(bridge.id, 'IMAGE_GENERATION')).toBeNull();
    expect(() =>
      repository.saveTeammateCapabilityState({
        teammateId: bridge.id,
        dimension: 'IMAGE_GENERATION',
        currentScore: 1,
        evidenceWeight: 0,
        ratingCount: 0,
        currentRuntimeProfileId: null,
        scoringPolicyVersion: 'human-bridge-prior-v1',
        updatedAt: 'disabled-prior',
      }),
    ).toThrow(/disabled/i);
    repository.saveHumanBridgeCapability({
      teammateId: bridge.id,
      dimension: 'IMAGE_GENERATION',
      enabled: true,
      updatedAt: 'capability-reenabled',
    });

    db.prepare(
      `INSERT INTO mission_participants (mission_id, teammate_id, role, sort_order)
       VALUES ('mission-1', 'human-bridge', 'MEMBER', 1)`,
    ).run();
    seedMissionRun(db, 'mission-2', 'run-2');
    db.prepare(
      `INSERT INTO teammates (id, name, created_at, updated_at)
       VALUES ('model-peer', 'Model peer', 'created', 'updated')`,
    ).run();
    expect(() =>
      repository.createExternalWorkRequest({
        ...externalRequest('bad-run-owner', bridge.id),
        runId: 'run-2',
      }),
    ).toThrow();
    expect(() =>
      repository.createExternalWorkRequest(externalRequest('bad-assignee', 'model-peer')),
    ).toThrow();
    expect(() =>
      repository.createExternalWorkRequest({
        ...externalRequest('bad-workspace-path', bridge.id),
        targetWorkspacePathsJson: { items: ['../outside'] },
      }),
    ).toThrow(/structured/i);
    expect(() =>
      repository.createExternalWorkRequest({
        ...externalRequest('bad-app-recommendation', bridge.id),
        externalAppProfileId: 'missing-app-profile',
      }),
    ).toThrow();
    const request = repository.createExternalWorkRequest(externalRequest('request-1', bridge.id));
    expect(request.state).toBe('PENDING');
    expect(repository.transitionExternalWorkRequest('missing', 'IN_PROGRESS', 'time')).toBeNull();
    expect(() => repository.transitionExternalWorkRequest(request.id, 'ACCEPTED', 'bad')).toThrow();
    expect(
      repository.transitionExternalWorkRequest(request.id, 'IN_PROGRESS', 'started')?.state,
    ).toBe('IN_PROGRESS');
    const firstSubmit = repository.transitionExternalWorkRequest(
      request.id,
      'SUBMITTED',
      'submitted-1',
    );
    expect(firstSubmit).toMatchObject({ state: 'SUBMITTED', submittedAt: 'submitted-1' });
    expect(() =>
      repository.transitionExternalWorkRequest(request.id, 'ACCEPTED', 'no-artifact'),
    ).toThrow(/artifact/i);
    repository.appendExternalWorkArtifact(artifact('artifact-1', request.id, 'submitted-1'));
    expect(repository.listExternalWorkArtifacts(request.id)).toEqual([
      artifact('artifact-1', request.id, 'submitted-1'),
    ]);
    expect(() =>
      db.prepare("UPDATE external_work_artifacts SET path = 'elsewhere'").run(),
    ).toThrow();
    expect(
      repository.transitionExternalWorkRequest(request.id, 'REJECTED', 'rejected')?.state,
    ).toBe('REJECTED');
    expect(
      repository.transitionExternalWorkRequest(request.id, 'IN_PROGRESS', 'rework'),
    ).toMatchObject({ state: 'IN_PROGRESS', submittedAt: null, resolvedAt: null });
    expect(() =>
      repository.transitionExternalWorkRequest(request.id, 'SUBMITTED', 'submitted-1'),
    ).toThrow(/new timestamp/i);
    expect(
      repository.transitionExternalWorkRequest(request.id, 'SUBMITTED', 'submitted-2')?.state,
    ).toBe('SUBMITTED');
    expect(() =>
      repository.transitionExternalWorkRequest(request.id, 'ACCEPTED', 'missing-current-artifact'),
    ).toThrow(/artifact/i);
    repository.appendExternalWorkArtifact(artifact('artifact-2', request.id, 'submitted-2'));
    expect(
      repository.transitionExternalWorkRequest(
        request.id,
        'ACCEPTED',
        'accepted',
        'The artifact meets the requested image brief.',
      ),
    ).toMatchObject({
      state: 'ACCEPTED',
      submittedAt: 'submitted-2',
      resolvedAt: 'accepted',
      publicResult: 'The artifact meets the requested image brief.',
    });
    expect(() =>
      repository.transitionExternalWorkRequest(request.id, 'IN_PROGRESS', 'invalid'),
    ).toThrow();
    expect(() => db.prepare('DELETE FROM external_work_requests').run()).toThrow();

    const appProfile: ExternalAppProfileRecord = {
      id: 'app-1',
      teammateId: bridge.id,
      name: 'Image Studio',
      vendor: 'Example',
      capabilities: ['IMAGE_GENERATION', 'IMAGE_EDITING'],
      notes: 'No credentials stored',
      enabled: true,
      createdAt: 'app-created',
      updatedAt: 'app-updated',
    };
    repository.saveExternalAppProfile(appProfile);
    expect(repository.listExternalAppProfiles(bridge.id)).toEqual([appProfile]);
    repository.saveExternalAppProfile({ ...appProfile, enabled: false, updatedAt: 'app-disabled' });
    expect(repository.listExternalAppProfiles(bridge.id)[0]?.enabled).toBe(false);
    expect(() =>
      repository.saveExternalAppProfile({
        ...appProfile,
        id: 'bad-app',
        teammateId: 'coordinator',
      }),
    ).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('accepts EXTERNAL_WORK and MISSION_RESULT only from accepted current-run Human Bridge artifacts', () => {
    const db = makeDatabase();
    seedRuntimeAndTeammates(db);
    const persistence = new R0SqliteRepository(db);
    const bridge = persistence.ensureHumanBridgeTeammate({
      id: 'human-bridge',
      createdAt: 'bridge-created',
      updatedAt: 'bridge-updated',
    });
    persistence.saveHumanBridgeCapability({
      teammateId: bridge.id,
      dimension: 'IMAGE_GENERATION',
      enabled: true,
      updatedAt: 'capability-enabled',
    });
    db.prepare(
      "UPDATE teammates SET current_runtime_profile_id = 'runtime-1' WHERE id = 'coordinator'",
    ).run();
    db.exec(`
      INSERT INTO parties (id, name, coordinator_teammate_id, type, status, created_at)
        VALUES ('party-1', 'Party', 'coordinator', 'FIXED', 'ACTIVE', 'created');
      INSERT INTO party_members (party_id, teammate_id, role, sort_order)
        VALUES ('party-1', 'coordinator', 'COORDINATOR', 0),
               ('party-1', 'human-bridge', 'MEMBER', 1);
      INSERT INTO missions
        (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
         party_id, mode, state, created_at, updated_at)
        VALUES ('mission-1', 'Mission', 'Objective', 'USER', 'user-1', 'coordinator',
                'party-1', 'CONSULTATION', 'RUNNING', 'created', 'updated');
      INSERT INTO mission_participants (mission_id, teammate_id, role, sort_order)
        VALUES ('mission-1', 'coordinator', 'COORDINATOR', 0),
               ('mission-1', 'human-bridge', 'MEMBER', 1);
      INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
        VALUES ('run-1', 'mission-1', 1, 'RUNNING', 'started');
    `);

    const request = persistence.createExternalWorkRequest(
      externalRequest('bridge-work', bridge.id),
    );
    persistence.transitionExternalWorkRequest(request.id, 'IN_PROGRESS', 'started');
    persistence.transitionExternalWorkRequest(request.id, 'SUBMITTED', 'submitted');
    persistence.appendExternalWorkArtifact(artifact('bridge-artifact', request.id, 'submitted'));
    expect(() =>
      db
        .prepare(
          `INSERT INTO experience_events
          (id, teammate_id, mission_id, run_id, experience_type, source, source_id,
           role, outcome, mode, created_at)
         VALUES ('pending-experience', 'human-bridge', 'mission-1', 'run-1',
           'EXTERNAL_WORK', 'EXTERNAL_WORK_REQUEST', 'bridge-work', 'MEMBER',
           'COMPLETED', 'CONSULTATION', 'attempted')`,
        )
        .run(),
    ).toThrow(/durable/i);

    persistence.transitionExternalWorkRequest(
      request.id,
      'ACCEPTED',
      'accepted',
      'The submitted image is ready for coordinator review.',
    );
    db.prepare(
      "UPDATE mission_runs SET status = 'FAILED', ended_at = 'ended' WHERE id = 'run-1'",
    ).run();
    db.prepare(
      `INSERT INTO experience_events
        (id, teammate_id, mission_id, run_id, experience_type, source, source_id,
         role, outcome, mode, created_at)
       VALUES ('bridge-experience', 'human-bridge', 'mission-1', 'run-1',
         'EXTERNAL_WORK', 'EXTERNAL_WORK_REQUEST', 'bridge-work', 'MEMBER',
         'COMPLETED', 'CONSULTATION', 'ended')`,
    ).run();
    db.prepare(
      `INSERT INTO experience_events
        (id, teammate_id, mission_id, run_id, experience_type, source, source_id,
         role, outcome, mode, created_at)
       VALUES ('bridge-mission-result', 'human-bridge', 'mission-1', 'run-1',
         'MISSION_RESULT', 'MISSION_RUN', 'run-1', 'MEMBER',
         'FAILED', 'CONSULTATION', 'ended')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO experience_events
          (id, teammate_id, mission_id, run_id, experience_type, source, source_id,
           role, outcome, mode, created_at)
         VALUES ('wrong-source-experience', 'human-bridge', 'mission-1', 'run-1',
           'EXTERNAL_WORK', 'EXTERNAL_WORK_REQUEST', 'wrong-request', 'MEMBER',
           'COMPLETED', 'CONSULTATION', 'ended')`,
        )
        .run(),
    ).toThrow(/durable/i);
    expect(
      db.prepare('SELECT experience_type, source, source_id, outcome FROM experience_events').all(),
    ).toEqual([
      {
        experience_type: 'EXTERNAL_WORK',
        source: 'EXTERNAL_WORK_REQUEST',
        source_id: 'bridge-work',
        outcome: 'COMPLETED',
      },
      {
        experience_type: 'MISSION_RESULT',
        source: 'MISSION_RUN',
        source_id: 'run-1',
        outcome: 'FAILED',
      },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
