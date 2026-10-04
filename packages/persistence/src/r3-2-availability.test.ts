import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ModelAvailabilityProjection } from '@cultivation/domain';
import {
  Gate1SqliteRepository,
  migrations,
  R32AvailabilityRepository,
  runMigrations,
  type ProviderConfig,
  type RuntimeProfileRecord,
  type TeammateRecord,
} from './index.js';

const timestamp = '2026-09-30T08:00:00.000Z';

function database(steps = migrations): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, steps);
  return db;
}

function seedTeammate(db: Database.Database, id = 'teammate-a') {
  const gate1 = new Gate1SqliteRepository(db);
  const provider: ProviderConfig = {
    id: `provider-${id}`,
    name: 'OpenAI',
    kind: 'OPENAI',
    baseUrl: null,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  gate1.saveProvider(provider);
  const credentialId = `credential-${id}`;
  gate1.saveCredential({
    id: credentialId,
    providerId: provider.id,
    label: 'Primary',
    ciphertext: Uint8Array.from([0x01, 0x02]),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const runtime: RuntimeProfileRecord = {
    id: `runtime-template-${id}`,
    name: 'Template',
    providerId: provider.id,
    credentialId,
    modelId: 'gpt-4o-mini',
    parameters: {},
    capabilityOverrides: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  gate1.saveRuntimeProfile(runtime);
  const teammate: TeammateRecord = {
    id,
    name: id,
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    status: 'ACTIVE',
    realm: 'QI_REFINING',
    currentRuntimeProfileId: runtime.id,
    executorKind: 'MODEL_RUNTIME',
    routingPolicy: 'NORMAL',
    systemKind: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const identity = gate1.getRuntimeIdentitySnapshot(runtime.id);
  if (!identity) throw new Error('Runtime identity fixture was not created');
  const created = gate1.createSealedTeammate(teammate, runtime.id, identity, timestamp);
  return { gate1, created, credentialId, provider };
}

function projection(
  teammateId: string,
  runtimeProfileId: string,
  overrides: Partial<ModelAvailabilityProjection> = {},
): ModelAvailabilityProjection {
  return {
    teammateId,
    runtimeProfileId,
    status: 'AVAILABLE',
    lastCheckedAt: '2026-09-30T09:00:00.000Z',
    lastSuccessAt: '2026-09-30T09:00:00.000Z',
    lastFailureAt: null,
    recentOutcomes: [
      { kind: 'SUCCESS', code: 'REQUEST_SUCCEEDED', checkedAt: '2026-09-30T09:00:00.000Z' },
    ],
    policyVersion: 'r3-2-availability-v1',
    ...overrides,
  };
}

describe('R3.2 availability persistence', () => {
  it('upgrades a Migration 1 database to latest migration with an UNKNOWN legacy projection', () => {
    const db = database([migrations[0]!]);
    db.prepare(
      `INSERT INTO providers (id, name, kind, created_at, updated_at)
       VALUES ('provider-legacy', 'Legacy', 'OPENAI', ?, ?)`,
    ).run(timestamp, timestamp);
    db.prepare(
      `INSERT INTO runtime_profiles (id, name, provider_id, credential_id, model_id,
         created_at, updated_at)
       VALUES ('runtime-legacy', 'Legacy runtime', 'provider-legacy', NULL, 'gpt-4o', ?, ?)`,
    ).run(timestamp, timestamp);
    db.prepare(
      `INSERT INTO teammates (id, name, current_runtime_profile_id, created_at, updated_at)
       VALUES ('teammate-legacy', 'Legacy', 'runtime-legacy', ?, ?)`,
    ).run(timestamp, timestamp);

    runMigrations(db, migrations);

    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: 24,
    });
    expect(new R32AvailabilityRepository(db).getAvailability('teammate-legacy')).toEqual({
      teammateId: 'teammate-legacy',
      runtimeProfileId: expect.any(String),
      status: 'UNKNOWN',
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      recentOutcomes: [],
      policyVersion: 'r3-2-availability-v1',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('creates UNKNOWN availability automatically for a newly sealed ordinary teammate', () => {
    const db = database();
    const { created } = seedTeammate(db);
    const availability = new R32AvailabilityRepository(db);
    expect(availability.getAvailability('teammate-a')).toEqual({
      teammateId: 'teammate-a',
      runtimeProfileId: created.binding.runtimeProfileId,
      status: 'UNKNOWN',
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      recentOutcomes: [],
      policyVersion: 'r3-2-availability-v1',
    });
    db.close();
  });

  it('keeps Human Bridge outside model availability and blocks direct projections', () => {
    const db = database();
    const { gate1, created } = seedTeammate(db);
    gate1.saveTeammate({
      id: 'human-bridge',
      name: '本尊',
      avatar: null,
      title: null,
      description: '',
      identityPrompt: '',
      behaviorPrompt: '',
      status: 'ACTIVE',
      realm: 'QI_REFINING',
      currentRuntimeProfileId: null,
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const availability = new R32AvailabilityRepository(db);
    expect(availability.getAvailability('human-bridge')).toBeNull();
    expect(availability.listAvailability().map((item) => item.teammateId)).toEqual(['teammate-a']);
    expect(() =>
      db
        .prepare(
          `INSERT INTO teammate_model_availability
            (teammate_id, runtime_profile_id, status, recent_outcomes_json,
             policy_version, updated_at)
           VALUES ('human-bridge', ?, 'UNKNOWN', '[]', 'r3-2-availability-v1', ?)`,
        )
        .run(created.binding.runtimeProfileId, timestamp),
    ).toThrow();
    db.close();
  });

  it('saves and lists bounded outcomes without allowing status or identity mismatch', () => {
    const db = database();
    const { created } = seedTeammate(db);
    const availability = new R32AvailabilityRepository(db);
    const saved = projection('teammate-a', created.binding.runtimeProfileId);
    availability.saveAvailability(saved);
    expect(availability.getAvailability('teammate-a')).toEqual(saved);
    expect(availability.listAvailability()).toEqual([saved]);

    expect(() =>
      availability.saveAvailability({
        ...saved,
        runtimeProfileId: 'another-runtime',
      }),
    ).toThrow(/sealed ModelBinding/);
    expect(() =>
      availability.saveAvailability({
        ...saved,
        status: 'UNKNOWN',
      }),
    ).toThrow(/UNKNOWN availability/);
    expect(() =>
      availability.saveAvailability({
        ...saved,
        recentOutcomes: Array.from({ length: 9 }, (_, index) => ({
          kind: 'SUCCESS' as const,
          code: `REQUEST_${index}`,
          checkedAt: '2026-09-30T09:00:00.000Z',
        })),
      }),
    ).toThrow(/at most 8/);
    expect(() =>
      availability.saveAvailability({
        ...saved,
        recentOutcomes: [
          { kind: 'SUCCESS', code: 'bad code', checkedAt: '2026-09-30T09:00:00.000Z' },
        ],
      }),
    ).toThrow(/safe code/);
    expect(() =>
      availability.saveAvailability({
        ...saved,
        recentOutcomes: [
          {
            kind: 'SUCCESS',
            code: 'REQUEST_SUCCEEDED',
            checkedAt: '2026-09-30T09:00:00.000Z',
            payload: 'must not persist external content',
          } as ModelAvailabilityProjection['recentOutcomes'][number],
        ],
      }),
    ).toThrow(/extra fields/);
    expect(() =>
      db
        .prepare(
          `UPDATE teammate_model_availability SET runtime_profile_id = 'another-runtime'
           WHERE teammate_id = 'teammate-a'`,
        )
        .run(),
    ).toThrow(/invalid sealed identity/);
    expect(() =>
      db
        .prepare(
          `UPDATE teammate_model_availability SET recent_outcomes_json = ?
           WHERE teammate_id = 'teammate-a'`,
        )
        .run(JSON.stringify(Array.from({ length: 9 }, () => ({ kind: 'SUCCESS' })))),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE teammate_model_availability SET recent_outcomes_json = ?
           WHERE teammate_id = 'teammate-a'`,
        )
        .run(
          JSON.stringify([
            {
              kind: 'SUCCESS',
              code: 'bad code',
              checkedAt: '2026-09-30T09:00:00.000Z',
            },
          ]),
        ),
    ).toThrow(/invalid sealed identity or outcome/);
    expect(() =>
      db
        .prepare(
          `UPDATE teammate_model_availability SET recent_outcomes_json = ?
           WHERE teammate_id = 'teammate-a'`,
        )
        .run(
          JSON.stringify([
            {
              kind: 'SUCCESS',
              checkedAt: '2026-09-30T09:00:00.000Z',
            },
          ]),
        ),
    ).toThrow(/invalid sealed identity or outcome/);
    expect(() =>
      db
        .prepare(
          `UPDATE teammate_model_availability SET recent_outcomes_json = ?
           WHERE teammate_id = 'teammate-a'`,
        )
        .run(
          JSON.stringify([
            {
              kind: 'SUCCESS',
              code: 'REQUEST_SUCCEEDED',
              checkedAt: '2026-09-30T09:00:00.000Z',
              output: 'large or sensitive extra payload',
            },
          ]),
        ),
    ).toThrow(/invalid sealed identity or outcome/);
    db.close();
  });

  it('resets freshness to UNKNOWN after credential id or ciphertext rotation', () => {
    const db = database();
    const { gate1, created, credentialId, provider } = seedTeammate(db);
    const availability = new R32AvailabilityRepository(db);
    const saved = projection('teammate-a', created.binding.runtimeProfileId);
    availability.saveAvailability(saved);

    gate1.saveCredential({
      id: credentialId,
      providerId: provider.id,
      label: 'Primary rotated',
      ciphertext: Uint8Array.from([0x7a, 0x7b]),
      createdAt: timestamp,
      updatedAt: '2026-09-30T09:30:00.000Z',
    });
    expect(availability.getAvailability('teammate-a')).toMatchObject({
      status: 'UNKNOWN',
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      recentOutcomes: [],
    });

    gate1.saveCredential({
      id: 'credential-next',
      providerId: provider.id,
      label: 'Next',
      ciphertext: Uint8Array.from([0x11, 0x12]),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    gate1.rotateBoundCredential('teammate-a', 'credential-next');
    expect(availability.getAvailability('teammate-a')).toMatchObject({
      status: 'UNKNOWN',
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      recentOutcomes: [],
      runtimeProfileId: created.binding.runtimeProfileId,
    });
    expect(gate1.getModelBinding('teammate-a')).toMatchObject({
      runtimeProfileId: created.binding.runtimeProfileId,
      providerKind: created.binding.providerKind,
      endpoint: created.binding.endpoint,
      modelId: created.binding.modelId,
      credentialId: 'credential-next',
    });
    db.close();
  });
});
