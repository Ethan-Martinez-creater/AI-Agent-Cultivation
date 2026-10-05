import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Gate1SqliteRepository, migrations, runMigrations } from './index.js';

describe('G2 submission continuation migration', () => {
  it('preserves adapter facts across 28→29 and keeps rejected outcomes immutable', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      runMigrations(
        db,
        migrations.filter((m) => m.version <= 28),
      );
      const store = new Gate1SqliteRepository(db);
      const at = '2026-10-06T00:00:00Z';
      store.saveProvider({
        id: 'provider',
        name: '模型',
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://localhost',
        enabled: true,
        createdAt: at,
        updatedAt: at,
      });
      store.saveRuntimeProfile({
        id: 'runtime',
        name: '模型配置',
        providerId: 'provider',
        credentialId: null,
        modelId: 'model',
        parameters: {},
        capabilityOverrides: {},
        executionProtocol: 'LANGUAGE',
        createdAt: at,
        updatedAt: at,
      });
      const old = {
        runtimeId: 'runtime',
        key: 'accepted',
        phase: 'SUBMITTED',
        requestFingerprint: 'hash',
        semanticFingerprint: 'semantic',
        providerJobId: 'job',
      };
      db.prepare('INSERT INTO generation_adapter_submissions VALUES(?,?,?)').run(
        'runtime',
        'accepted',
        JSON.stringify(old),
      );
      runMigrations(db, migrations);
      expect(
        JSON.parse(
          (
            db.prepare('SELECT state_json FROM generation_adapter_submissions').get() as {
              state_json: string;
            }
          ).state_json,
        ),
      ).toEqual(old);
      const rejected = {
        runtimeId: 'runtime',
        key: 'rejected',
        phase: 'REJECTED',
        requestFingerprint: 'hash',
        semanticFingerprint: 'semantic',
        errorCode: 'QUEUE_FULL',
      };
      db.prepare('INSERT INTO generation_adapter_submissions VALUES(?,?,?)').run(
        'runtime',
        'rejected',
        JSON.stringify(rejected),
      );
      expect(() =>
        db
          .prepare('UPDATE generation_adapter_submissions SET state_json=? WHERE idempotency_key=?')
          .run(JSON.stringify({ ...rejected, phase: 'SUBMITTING' }), 'rejected'),
      ).toThrow(/immutable/);
      expect(() =>
        db
          .prepare('DELETE FROM generation_adapter_submissions WHERE idempotency_key=?')
          .run('rejected'),
      ).toThrow(/retained/);
      expect(() =>
        db
          .prepare('INSERT INTO generation_adapter_submissions VALUES(?,?,?)')
          .run('runtime', 'bad', JSON.stringify({ ...rejected, key: 'bad', errorCode: null })),
      ).toThrow();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      runMigrations(db, migrations);
      expect(db.prepare('SELECT COUNT(*) AS n FROM generation_adapter_submissions').get()).toEqual({
        n: 2,
      });
    } finally {
      db.close();
    }
  });
});
