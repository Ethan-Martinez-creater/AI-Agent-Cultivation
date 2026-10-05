import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations, R0SqliteRepository, R3SqliteRepository, runMigrations } from './index.js';
import type { DecisionShadowAttemptRecord, R3DecisionReceiptRecord } from './r3.js';

let db: Database.Database;
let repository: R3SqliteRepository;

function fixture(steps = migrations): void {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, steps);
  repository = new R3SqliteRepository(db);
}

function seedMissionRun(missionId = 'mission-1', runId = 'run-1'): void {
  db.exec(`
    INSERT INTO providers (id, name, kind, created_at, updated_at)
      VALUES ('provider-1', 'Provider', 'OPENAI', 'created', 'updated');
    INSERT INTO runtime_profiles (id, name, provider_id, model_id, created_at, updated_at)
      VALUES ('runtime-1', 'Runtime', 'provider-1', 'model-1', 'created', 'updated');
    INSERT INTO teammates (id, name, current_runtime_profile_id, created_at, updated_at)
      VALUES ('teammate-1', 'Teammate', 'runtime-1', 'created', 'updated');
  `);
  db.prepare(
    `INSERT INTO missions
      (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
       mode, state, created_at, updated_at)
     VALUES (?, 'Mission', 'Objective', 'USER', 'user-1', 'teammate-1',
       'SOLO', 'RUNNING', 'created', 'updated')`,
  ).run(missionId);
  db.prepare(
    `INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
     VALUES (?, ?, 1, 'RUNNING', 'started')`,
  ).run(runId, missionId);
}

function receipt(overrides: Partial<R3DecisionReceiptRecord> = {}): R3DecisionReceiptRecord {
  return {
    id: 'receipt-1',
    missionId: 'mission-1',
    runId: 'run-1',
    decisionType: 'TASK_CAPABILITY',
    provider: 'TYPESAFE',
    model: 'jev-1.13.0',
    modelVersion: 'jev-1.13.0',
    questionVersion: 'r3-questions-v1',
    stateHash: 'sha256:bounded-state',
    inputSummary: 'Bounded objective summary',
    answersJson: { dimensions: [{ dimension: 'CODING', probability: 0.7 }] },
    confidenceJson: { overall: 0.8 },
    policyVersion: 'r3-shadow-policy-v1',
    selectedAction: 'CODING',
    actualAction: 'user-selected-teammate-1',
    latencyMs: 241,
    inputTokens: 311,
    mode: 'SHADOW',
    createdAt: 'receipt-time',
    ...overrides,
  };
}

function attempt(
  overrides: Partial<DecisionShadowAttemptRecord> = {},
): DecisionShadowAttemptRecord {
  return {
    id: 'attempt-1',
    missionId: 'mission-1',
    runId: 'run-1',
    decisionType: 'TASK_CAPABILITY',
    provider: 'TYPESAFE',
    model: 'jev-1.13.0',
    status: 'SUCCESS',
    receiptId: 'receipt-1',
    actualAction: 'user-selected-teammate-1',
    errorCode: null,
    latencyMs: 241,
    inputTokens: 311,
    createdAt: 'attempt-time',
    ...overrides,
  };
}

describe('R3 Decision Plane persistence', () => {
  beforeEach(() => fixture());
  afterEach(() => db.close());

  it('migrates a populated v12 database to v13 without rewriting receipt facts', () => {
    db.close();
    fixture(migrations.slice(0, 12));
    seedMissionRun();
    const oldReceipt = {
      id: 'receipt-before-r3',
      missionId: 'mission-1',
      runId: 'run-1',
      decisionType: 'TASK_CAPABILITY',
      provider: 'jev',
      model: 'jev-1.13.0',
      modelVersion: '1.13.0',
      questionVersion: 'r0-question-v1',
      stateHash: 'prior-hash',
      inputSummary: 'existing bounded summary',
      answersJson: { coding: 0.8 },
      confidenceJson: { coding: 0.9 },
      policyVersion: 'r0-policy-v1',
      selectedAction: 'teammate-1',
      mode: 'SHADOW' as const,
      createdAt: 'before-r3',
    };
    new R0SqliteRepository(db).appendDecisionReceipt(oldReceipt);

    runMigrations(db, migrations);

    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: 29,
    });
    expect(
      db.prepare('SELECT id, state_hash, input_summary, mode FROM decision_receipts').get(),
    ).toEqual({
      id: 'receipt-before-r3',
      state_hash: 'prior-hash',
      input_summary: 'existing bounded summary',
      mode: 'SHADOW',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(repository.getDecisionProviderConfig()).toMatchObject({
      enabled: false,
      mode: 'SHADOW',
      model: 'jev-1.13.0',
      apiKeyCiphertext: null,
    });
  });

  it('seeds a disabled pinned Typesafe config and stores only ciphertext bytes', () => {
    const initial = repository.getDecisionProviderConfig();
    expect(initial).toMatchObject({
      id: 'TYPESAFE',
      provider: 'TYPESAFE',
      model: 'jev-1.13.0',
      enabled: false,
      mode: 'SHADOW',
      apiKeyCiphertext: null,
    });
    expect(repository.getDecisionProviderStatus()).toEqual({
      id: 'TYPESAFE',
      provider: 'TYPESAFE',
      model: 'jev-1.13.0',
      enabled: false,
      mode: 'SHADOW',
      hasCredential: false,
      createdAt: initial.createdAt,
      updatedAt: initial.updatedAt,
    });
    expect(repository.getDecisionProviderStatus()).not.toHaveProperty('apiKeyCiphertext');

    const environmentConfigured = repository.saveDecisionProviderConfig({
      enabled: true,
      mode: 'SHADOW',
      apiKeyCiphertext: null,
      updatedAt: 'env-configured',
    });
    expect(environmentConfigured).toMatchObject({
      enabled: true,
      apiKeyCiphertext: null,
      mode: 'SHADOW',
    });
    expect(repository.getDecisionProviderStatus()).toMatchObject({
      enabled: true,
      hasCredential: false,
    });

    const ciphertext = Uint8Array.from([0x00, 0x9f, 0x21, 0xfa]);
    const saved = repository.saveDecisionProviderConfig({
      enabled: true,
      mode: 'SHADOW',
      apiKeyCiphertext: ciphertext,
      updatedAt: 'updated-config',
    });
    expect(saved.apiKeyCiphertext).toEqual(ciphertext);
    expect(
      db
        .prepare(
          'SELECT typeof(api_key_ciphertext) AS type, api_key_ciphertext FROM decision_provider_configs',
        )
        .get(),
    ).toEqual({ type: 'blob', api_key_ciphertext: Buffer.from(ciphertext) });
    expect(repository.getDecisionProviderStatus()).toMatchObject({
      enabled: true,
      hasCredential: true,
      updatedAt: 'updated-config',
    });
    const columns = db.prepare('PRAGMA table_info(decision_provider_configs)').all() as {
      name: string;
    }[];
    expect(columns.map(({ name }) => name)).not.toContain('api_key');
    expect(columns.map(({ name }) => name)).toContain('api_key_ciphertext');

    expect(() =>
      repository.saveDecisionProviderConfig({
        enabled: true,
        mode: 'ACTIVE' as 'SHADOW',
        apiKeyCiphertext: ciphertext,
        updatedAt: 'invalid-mode',
      }),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE decision_provider_configs SET model = 'jev-latest'").run(),
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE decision_provider_configs SET api_key_ciphertext = ?').run('plaintext'),
    ).toThrow();
    expect(() =>
      repository.saveDecisionProviderConfig({
        enabled: true,
        mode: 'SHADOW',
        apiKeyCiphertext: new Uint8Array(),
        updatedAt: 'empty-ciphertext',
      }),
    ).toThrow();
    expect(() => db.prepare('DELETE FROM decision_provider_configs').run()).toThrow();
  });

  it('keeps policy SHADOW-only, disabled by default, and bounds state and timeout settings', () => {
    const initial = repository.getShadowPolicyConfig();
    expect(initial).toMatchObject({
      enabled: false,
      mode: 'SHADOW',
      questionVersion: 'r3-questions-v1',
      policyVersion: 'r3-shadow-policy-v1',
      maxStateBytes: 24000,
      timeoutMs: 15000,
    });
    expect(
      repository.saveShadowPolicyConfig({
        enabled: true,
        mode: 'SHADOW',
        questionVersion: 'questions-v2',
        policyVersion: 'policy-v2',
        maxStateBytes: 4096,
        timeoutMs: 5000,
        updatedAt: 'updated-policy',
      }),
    ).toMatchObject({ enabled: true, maxStateBytes: 4096, timeoutMs: 5000 });
    expect(() =>
      repository.saveShadowPolicyConfig({
        enabled: true,
        mode: 'ACTIVE' as 'SHADOW',
        questionVersion: 'bad',
        policyVersion: 'bad',
        maxStateBytes: 4096,
        timeoutMs: 5000,
        updatedAt: 'bad',
      }),
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE decision_shadow_policy_config SET timeout_ms = 120001').run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE decision_shadow_policy_config SET mode = 'ADVISORY'").run(),
    ).toThrow();
  });

  it('stores bounded SHADOW receipts with actual action and immutable timing metadata', () => {
    seedMissionRun();
    const value = receipt();
    repository.appendDecisionReceipt(value);
    expect(repository.getDecisionReceipt(value.id)).toEqual(value);
    expect(repository.listDecisionReceipts('mission-1', 'run-1')).toEqual([value]);
    expect(() =>
      repository.appendDecisionReceipt(
        receipt({ id: 'oversized', inputSummary: 'x'.repeat(2001) }),
      ),
    ).toThrow();
    expect(() =>
      repository.appendDecisionReceipt(receipt({ id: 'bad-latency', latencyMs: -1 })),
    ).toThrow();
    expect(() =>
      repository.appendDecisionReceipt(receipt({ id: 'bad-token-count', inputTokens: -1 })),
    ).toThrow();
    expect(() => db.prepare('UPDATE decision_receipts SET actual_action = NULL').run()).toThrow();
    expect(() => db.prepare('DELETE FROM decision_receipts').run()).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO decision_receipts
      (id, decision_type, provider, model, model_version, question_version, state_hash,
       input_summary, answers_json, confidence_json, policy_version, mode, created_at)
      VALUES ('active', 'REVIEW_NEED', 'TYPESAFE', 'jev-1.13.0', 'jev-1.13.0', 'q', 'h',
       '', '{}', '{}', 'p', 'ACTIVE', 'now')`,
        )
        .run(),
    ).toThrow(/SHADOW/i);
  });

  it('stores only safe shadow attempt outcomes and verifies receipt and MissionRun provenance', () => {
    seedMissionRun();
    const value = receipt();
    repository.appendDecisionReceipt(value);
    const succeeded = attempt();
    repository.appendShadowAttempt(succeeded);
    repository.appendShadowAttempt(
      attempt({
        id: 'attempt-error',
        status: 'ERROR',
        receiptId: null,
        actualAction: 'user-selected-teammate-1',
        errorCode: 'TIMEOUT',
        latencyMs: 15000,
        inputTokens: 280,
      }),
    );
    repository.appendShadowAttempt(
      attempt({
        id: 'attempt-skipped',
        status: 'SKIPPED',
        receiptId: null,
        actualAction: null,
        errorCode: 'DISABLED',
        latencyMs: null,
        inputTokens: null,
      }),
    );
    expect(repository.listShadowAttempts('mission-1', 'run-1')).toEqual([
      expect.objectContaining({ id: 'attempt-skipped', status: 'SKIPPED', errorCode: 'DISABLED' }),
      expect.objectContaining({
        id: 'attempt-error',
        status: 'ERROR',
        errorCode: 'TIMEOUT',
        actualAction: 'user-selected-teammate-1',
      }),
      succeeded,
    ]);
    expect(repository.listDecisionReceipts('mission-1', 'run-1')).toEqual([value]);
    expect(() =>
      repository.appendShadowAttempt(attempt({ id: 'bad-receipt', receiptId: 'missing' })),
    ).toThrow();
    expect(() =>
      repository.appendShadowAttempt(attempt({ id: 'bad-run', runId: 'run-other' })),
    ).toThrow();
    expect(() =>
      repository.appendShadowAttempt(
        attempt({
          id: 'raw-error',
          status: 'ERROR',
          receiptId: null,
          errorCode: 'timeout: raw response',
        } as unknown as DecisionShadowAttemptRecord),
      ),
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE decision_shadow_attempts SET error_code = ?').run('NETWORK'),
    ).toThrow();
    expect(() => db.prepare('DELETE FROM decision_shadow_attempts').run()).toThrow();
    expect(repository.listShadowAttempts(undefined, undefined, 10000)).toHaveLength(3);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('persists the sanitized application fallback codes without raw provider errors', () => {
    seedMissionRun();
    const codes = [
      'INVALID_REQUEST',
      'TIMEOUT',
      'PROVIDER_UNAVAILABLE',
      'SCHEMA_MISMATCH',
      'RECEIPT_WRITE_FAILED',
    ] as const;
    for (const [index, errorCode] of codes.entries()) {
      repository.appendShadowAttempt(
        attempt({
          id: `fallback-${index}`,
          status: 'ERROR',
          receiptId: null,
          actualAction: 'explicit-current-selection',
          errorCode,
        }),
      );
    }

    expect(
      repository
        .listShadowAttempts('mission-1', 'run-1')
        .map(({ errorCode }) => errorCode)
        .reverse(),
    ).toEqual(codes);
    expect(() =>
      repository.appendShadowAttempt(
        attempt({
          id: 'raw-provider-message',
          status: 'ERROR',
          receiptId: null,
          errorCode: 'Provider rejected key sk-test-secret' as never,
        }),
      ),
    ).toThrow();
  });

  it('rejects mismatched Mission/Run receipt references', () => {
    seedMissionRun();
    expect(() => repository.appendDecisionReceipt(receipt({ runId: 'missing-run' }))).toThrow();
    expect(() =>
      repository.appendDecisionReceipt(receipt({ missionId: 'missing-mission' })),
    ).toThrow();
  });
});
