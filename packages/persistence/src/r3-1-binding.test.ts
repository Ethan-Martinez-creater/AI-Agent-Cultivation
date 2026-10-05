import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  Gate1SqliteRepository,
  migrations,
  runMigrations,
  type ProviderConfig,
  type RuntimeProfileRecord,
  type TeammateRecord,
} from './index.js';

const timestamp = '2026-09-28T08:00:00.000Z';

function teammate(id: string, runtimeProfileId: string | null): TeammateRecord {
  return {
    id,
    name: id,
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    status: 'ACTIVE',
    realm: 'QI_REFINING',
    currentRuntimeProfileId: runtimeProfileId,
    executorKind: 'MODEL_RUNTIME',
    routingPolicy: 'NORMAL',
    systemKind: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function seedProviderRuntime(
  repository: Gate1SqliteRepository,
  runtimeId = 'runtime-template',
  db?: Database.Database,
  executionProtocol: 'LANGUAGE' | 'GENERATION' = 'LANGUAGE',
) {
  const provider: ProviderConfig = {
    id: 'provider-openai',
    name: 'OpenAI',
    kind: 'OPENAI',
    baseUrl: null,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  repository.saveProvider(provider);
  repository.saveCredential({
    id: 'credential-openai',
    providerId: provider.id,
    label: 'Primary',
    ciphertext: Uint8Array.from([1, 2, 3]),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const runtime: RuntimeProfileRecord = {
    id: runtimeId,
    name: 'Shared template',
    providerId: provider.id,
    credentialId: 'credential-openai',
    modelId: 'gpt-4o',
    executionProtocol,
    parameters: { temperature: 0.2 },
    capabilityOverrides: { CODING: true },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (db && !hasColumn(db, 'runtime_profiles', 'execution_protocol')) {
    db.prepare(
      `INSERT INTO runtime_profiles
        (id, name, provider_id, credential_id, model_id, parameters_json,
         capability_overrides_json, created_at, updated_at)
       VALUES (@id, @name, @providerId, @credentialId, @modelId, @parameters,
         @capabilityOverrides, @createdAt, @updatedAt)`,
    ).run({
      ...runtime,
      parameters: JSON.stringify(runtime.parameters),
      capabilityOverrides: JSON.stringify(runtime.capabilityOverrides),
    });
  } else {
    repository.saveRuntimeProfile(runtime);
  }
  return { provider, runtime };
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some(
    (row) => row.name === column,
  );
}

describe('R3.1 sealed teammate model binding', () => {
  it('isolates legacy teammates that shared a Runtime and preserves old history references', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 13));
    const repository = new Gate1SqliteRepository(db);
    seedProviderRuntime(repository, 'runtime-shared', db);
    repository.saveTeammate(teammate('teammate-a', 'runtime-shared'));
    repository.saveTeammate(teammate('teammate-b', 'runtime-shared'));
    db.prepare(
      `INSERT INTO model_capability_benchmarks
        (id, runtime_profile_id, model_alias, dimension, supported, normalized_score,
         raw_score, source, benchmark, benchmark_version, snapshot_date, source_url,
         provenance_type, created_at)
       VALUES ('benchmark-shared', 'runtime-shared', 'gpt-4o', 'CODING', 1, 91,
         91, 'catalog', 'coding-suite', 'v1', ?, NULL, 'CATALOG', ?)`,
    ).run(timestamp, timestamp);
    repository.saveUsage({
      id: 'usage-history',
      missionId: null,
      runId: null,
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-shared',
      provider: 'OPENAI',
      model: 'gpt-4o',
      inputTokens: 2,
      outputTokens: 3,
      cachedInputTokens: null,
      reasoningTokens: null,
      providerMetadata: null,
      estimatedCost: null,
      currency: null,
      createdAt: timestamp,
    });
    db.prepare(
      `INSERT INTO missions
        (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
         mode, created_at, updated_at)
       VALUES ('mission-history', 'Legacy mission', 'Keep the reference', 'USER', 'user-1',
         'teammate-a', 'SOLO', ?, ?)`,
    ).run(timestamp, timestamp);
    db.prepare(
      `INSERT INTO mission_events
        (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
       VALUES ('event-history', 'mission-history', NULL, 'legacy.event', 'TEAMMATE',
         'teammate-a', '{}', ?)`,
    ).run(timestamp);
    db.prepare(
      `INSERT INTO audit_events
        (id, actor_type, actor_id, action, target_type, target_id, payload_json, created_at)
       VALUES ('audit-history', 'USER', 'user-1', 'legacy.action', 'RUNTIME',
         'runtime-shared', '{}', ?)`,
    ).run(timestamp);

    runMigrations(db, migrations);

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM runtime_profiles WHERE execution_protocol != 'LANGUAGE'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM teammate_model_bindings WHERE execution_protocol != 'LANGUAGE'",
        )
        .get(),
    ).toEqual({ n: 0 });

    const bindings = db
      .prepare(
        `SELECT b.teammate_id, b.runtime_profile_id, b.model_id, t.current_runtime_profile_id
         FROM teammate_model_bindings AS b
         JOIN teammates AS t ON t.id = b.teammate_id
         ORDER BY b.teammate_id`,
      )
      .all() as {
      teammate_id: string;
      runtime_profile_id: string;
      model_id: string;
      current_runtime_profile_id: string;
    }[];
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((row) => row.runtime_profile_id)).size).toBe(2);
    expect(bindings.every((row) => row.runtime_profile_id !== 'runtime-shared')).toBe(true);
    expect(bindings.every((row) => row.current_runtime_profile_id === row.runtime_profile_id)).toBe(
      true,
    );
    expect(bindings.map((row) => row.model_id)).toEqual(['gpt-4o', 'gpt-4o']);
    expect(
      db
        .prepare(
          `SELECT verified_at, verification_source
           FROM teammate_model_bindings ORDER BY teammate_id LIMIT 1`,
        )
        .get(),
    ).toEqual({ verified_at: null, verification_source: 'LEGACY_STRUCTURAL' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_capability_benchmarks').get()).toEqual({
      count: 3,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count, MIN(b.normalized_score) AS min_score,
                  MAX(b.normalized_score) AS max_score
           FROM model_capability_benchmarks AS b
           JOIN teammate_model_bindings AS binding
             ON binding.runtime_profile_id = b.runtime_profile_id
           WHERE b.dimension = 'CODING'`,
        )
        .get(),
    ).toEqual({ count: 2, min_score: 91, max_score: 91 });
    expect(
      db.prepare('SELECT runtime_profile_id FROM usage_records WHERE id = ?').get('usage-history'),
    ).toEqual({ runtime_profile_id: 'runtime-shared' });
    expect(
      db.prepare('SELECT id FROM runtime_profiles WHERE id = ?').get('runtime-shared'),
    ).toEqual({
      id: 'runtime-shared',
    });
    expect(db.prepare('SELECT id FROM missions WHERE id = ?').get('mission-history')).toEqual({
      id: 'mission-history',
    });
    expect(db.prepare('SELECT id FROM mission_events WHERE id = ?').get('event-history')).toEqual({
      id: 'event-history',
    });
    expect(db.prepare('SELECT id FROM audit_events WHERE id = ?').get('audit-history')).toEqual({
      id: 'audit-history',
    });
    db.close();
  });

  it('creates an isolated sealed Runtime atomically and allows credential-only rotation', () => {
    const db = createDatabase();
    const repository = new Gate1SqliteRepository(db);
    const { provider, runtime } = seedProviderRuntime(repository);
    db.prepare(
      `INSERT INTO model_capability_benchmarks
        (id, runtime_profile_id, model_alias, dimension, supported, normalized_score,
         raw_score, source, benchmark, benchmark_version, snapshot_date, source_url,
         provenance_type, created_at)
       VALUES ('benchmark-template', ?, 'gpt-4o', 'CODING', 1, 91,
         91, 'catalog', 'coding-suite', 'v1', ?, NULL, 'CATALOG', ?)`,
    ).run(runtime.id, timestamp, timestamp);
    const created = repository.createSealedTeammate(
      teammate('teammate-new', runtime.id),
      runtime.id,
      repository.getRuntimeIdentitySnapshot(runtime.id)!,
      timestamp,
    );

    expect(created.teammate.currentRuntimeProfileId).not.toBe(runtime.id);
    expect(created.binding.runtimeProfileId).toBe(created.teammate.currentRuntimeProfileId);
    expect(created.binding.modelId).toBe('gpt-4o');
    expect(repository.getModelBinding('teammate-new')).toEqual(created.binding);
    expect(repository.isRuntimeBound(runtime.id)).toBe(false);
    expect(repository.isRuntimeBound(created.binding.runtimeProfileId)).toBe(true);
    expect(repository.hasValidModelBinding('teammate-new')).toBe(true);
    expect(
      db
        .prepare(
          `SELECT model_alias, dimension, normalized_score
           FROM model_capability_benchmarks WHERE runtime_profile_id = ?`,
        )
        .all(created.binding.runtimeProfileId),
    ).toEqual([{ model_alias: 'gpt-4o', dimension: 'CODING', normalized_score: 91 }]);

    repository.saveRuntimeProfile({ ...runtime, modelId: 'source-model-changed' });
    expect(repository.getRuntimeProfile(created.binding.runtimeProfileId)?.modelId).toBe('gpt-4o');

    repository.saveCredential({
      id: 'credential-openai-next',
      providerId: provider.id,
      label: 'Rotated',
      ciphertext: Uint8Array.from([4, 5, 6]),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const rotated = repository.rotateBoundCredential('teammate-new', 'credential-openai-next');
    expect(rotated.credentialId).toBe('credential-openai-next');
    expect(repository.getRuntimeProfile(created.binding.runtimeProfileId)?.credentialId).toBe(
      'credential-openai-next',
    );
    expect(rotated.modelId).toBe('gpt-4o');
    expect(repository.hasValidModelBinding('teammate-new')).toBe(true);

    repository.saveCredential({
      id: 'credential-openai-next',
      providerId: provider.id,
      label: 'Rotated',
      ciphertext: Uint8Array.from([7, 8, 9]),
      createdAt: timestamp,
      updatedAt: '2026-09-28T09:00:00.000Z',
    });
    expect(repository.getModelBinding('teammate-new')?.modelId).toBe('gpt-4o');
    expect(repository.hasValidModelBinding('teammate-new')).toBe(true);
    db.close();
  });

  it('revalidates the verified identity inside the sealing transaction', () => {
    const db = createDatabase();
    const repository = new Gate1SqliteRepository(db);
    const { runtime } = seedProviderRuntime(repository);
    const verifiedIdentity = repository.getRuntimeIdentitySnapshot(runtime.id)!;

    repository.saveRuntimeProfile({
      ...runtime,
      modelId: 'intermediate-model',
      updatedAt: '2026-09-29T01:00:00.000Z',
    });
    repository.saveRuntimeProfile({
      ...runtime,
      updatedAt: '2026-09-29T01:00:01.000Z',
    });

    expect(() =>
      repository.createSealedTeammate(
        teammate('teammate-stale-verification', runtime.id),
        runtime.id,
        verifiedIdentity,
        timestamp,
      ),
    ).toThrow('Runtime identity changed after connection verification');
    expect(repository.getTeammate('teammate-stale-verification')).toBeNull();
    expect(repository.isRuntimeBound(runtime.id)).toBe(false);
    db.close();
  });

  it('snapshots and privately clones GENERATION execution identity immutably', () => {
    const db = createDatabase();
    const repository = new Gate1SqliteRepository(db);
    const { runtime } = seedProviderRuntime(
      repository,
      'runtime-generation-template',
      undefined,
      'GENERATION',
    );
    const verifiedIdentity = repository.getRuntimeIdentitySnapshot(runtime.id)!;
    expect(verifiedIdentity.executionProtocol).toBe('GENERATION');
    expect(() =>
      repository.createSealedTeammate(
        teammate('teammate-generation-stale', runtime.id),
        runtime.id,
        { ...verifiedIdentity, executionProtocol: 'LANGUAGE' },
        timestamp,
      ),
    ).toThrow('Runtime identity changed after connection verification');

    const created = repository.createSealedTeammate(
      teammate('teammate-generation', runtime.id),
      runtime.id,
      verifiedIdentity,
      timestamp,
    );
    const privateRuntime = repository.getRuntimeProfile(created.teammate.currentRuntimeProfileId!)!;
    expect(created.binding.executionProtocol).toBe('GENERATION');
    expect(privateRuntime.executionProtocol).toBe('GENERATION');
    expect(repository.hasValidModelBinding(created.teammate.id)).toBe(true);
    expect(() =>
      db
        .prepare("UPDATE runtime_profiles SET execution_protocol = 'LANGUAGE' WHERE id = ?")
        .run(runtime.id),
    ).toThrow('Runtime execution protocol is immutable');
    expect(() =>
      db
        .prepare("UPDATE runtime_profiles SET execution_protocol = 'LANGUAGE' WHERE id = ?")
        .run(privateRuntime.id),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "UPDATE teammate_model_bindings SET execution_protocol = 'LANGUAGE' WHERE teammate_id = ?",
        )
        .run(created.teammate.id),
    ).toThrow('Sealed ModelBinding execution protocol is immutable');
    db.close();
  });

  it('fails closed for a migrated disabled Provider and can recover after credential rotation', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 13));
    const repository = new Gate1SqliteRepository(db);
    repository.saveProvider({
      id: 'provider-openai',
      name: 'OpenAI',
      kind: 'OPENAI',
      baseUrl: null,
      enabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    db.prepare(
      `INSERT INTO runtime_profiles
        (id, name, provider_id, credential_id, model_id, parameters_json,
         capability_overrides_json, created_at, updated_at)
       VALUES ('runtime-missing-key', 'Legacy runtime', 'provider-openai', NULL, 'gpt-4o',
         '{}', '{}', ?, ?)`,
    ).run(timestamp, timestamp);
    repository.saveTeammate(teammate('teammate-legacy', 'runtime-missing-key'));

    runMigrations(db, migrations);

    expect(repository.hasValidModelBinding('teammate-legacy')).toBe(false);
    expect(repository.getModelBinding('teammate-legacy')?.verificationSource).toBe(
      'LEGACY_STRUCTURAL',
    );
    repository.saveCredential({
      id: 'credential-recovered',
      providerId: 'provider-openai',
      label: 'Recovered',
      ciphertext: Uint8Array.from([1]),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repository.rotateBoundCredential('teammate-legacy', 'credential-recovered');
    expect(repository.hasValidModelBinding('teammate-legacy')).toBe(false);
    repository.saveProvider({
      id: 'provider-openai',
      name: 'OpenAI',
      kind: 'OPENAI',
      baseUrl: null,
      enabled: true,
      createdAt: timestamp,
      updatedAt: '2026-09-28T09:00:00.000Z',
    });
    expect(repository.hasValidModelBinding('teammate-legacy')).toBe(true);
    db.close();
  });

  it('rejects sealed identity changes, cross-Provider credentials, and invalid Human Bridge mutations', () => {
    const db = createDatabase();
    const repository = new Gate1SqliteRepository(db);
    const { provider, runtime } = seedProviderRuntime(repository);
    const created = repository.createSealedTeammate(
      teammate('teammate-sealed', runtime.id),
      runtime.id,
      repository.getRuntimeIdentitySnapshot(runtime.id)!,
      timestamp,
    );
    repository.saveProvider({
      id: 'provider-other',
      name: 'Other',
      kind: 'ANTHROPIC',
      baseUrl: null,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repository.saveCredential({
      id: 'credential-other',
      providerId: 'provider-other',
      label: 'Other',
      ciphertext: Uint8Array.from([10]),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(() =>
      db
        .prepare('UPDATE teammate_model_bindings SET model_id = ? WHERE teammate_id = ?')
        .run('gpt-5', 'teammate-sealed'),
    ).toThrow();
    expect(() =>
      db
        .prepare('UPDATE runtime_profiles SET model_id = ? WHERE id = ?')
        .run('gpt-5', created.binding.runtimeProfileId),
    ).toThrow();
    expect(() =>
      repository.saveProvider({ ...provider, baseUrl: 'https://changed.example/v1' }),
    ).toThrow();
    expect(() =>
      repository.saveCredential({
        id: 'credential-openai',
        providerId: 'provider-other',
        label: 'Moved',
        ciphertext: Uint8Array.from([11]),
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toThrow();
    expect(() => repository.rotateBoundCredential('teammate-sealed', 'credential-other')).toThrow();
    expect(repository.getModelBinding('teammate-sealed')?.modelId).toBe('gpt-4o');
    expect(repository.getModelBinding('teammate-sealed')?.credentialId).toBe('credential-openai');

    repository.saveTeammate({
      ...teammate('human-bridge', null),
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
    });
    expect(() =>
      db.prepare("UPDATE teammates SET status = 'ARCHIVED' WHERE id = 'human-bridge'").run(),
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE teammates SET system_kind = NULL WHERE id = ?').run('human-bridge'),
    ).toThrow();
    expect(() => db.prepare("DELETE FROM teammates WHERE id = 'human-bridge'").run()).toThrow();
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name = 'human_bridge_no_delete_r3_1'`,
        )
        .get(),
    ).toEqual({ name: 'human_bridge_no_delete_r3_1' });
    expect(() =>
      db
        .prepare(
          `INSERT INTO teammate_model_bindings
            (teammate_id, runtime_profile_id, provider_kind, endpoint, model_id,
             credential_id, verified_at, verification_source, sealed_at)
           VALUES ('human-bridge', 'runtime-template', 'OPENAI', NULL, 'gpt-4o',
             'credential-openai', ?, 'LIVE_TEST', ?)`,
        )
        .run(timestamp, timestamp),
    ).toThrow();
    expect(() =>
      repository.saveTeammate({
        ...teammate('invalid-human-bridge', null),
        status: 'ARCHIVED',
        executorKind: 'USER_BRIDGE',
        routingPolicy: 'FALLBACK_ONLY',
        systemKind: 'HUMAN_BRIDGE',
      }),
    ).toThrow();
    db.close();
  });
});
