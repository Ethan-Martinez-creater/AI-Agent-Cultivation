import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { R2ContinuationRepository } from './r2-continuation.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE external_work_requests (id TEXT PRIMARY KEY);
    CREATE TABLE missions (id TEXT PRIMARY KEY);
    CREATE TABLE mission_runs (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id));
    CREATE TABLE r2_external_work_continuations (
      external_work_request_id TEXT PRIMARY KEY REFERENCES external_work_requests(id) ON DELETE RESTRICT,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
      mission_run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK (state IN ('PENDING','CONSUMING','CONSUMED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consumed_at TEXT,
      CHECK ((state = 'CONSUMED' AND consumed_at IS NOT NULL)
        OR (state IN ('PENDING','CONSUMING') AND consumed_at IS NULL))
    );
    CREATE INDEX r2_external_work_continuations_recovery_idx
      ON r2_external_work_continuations(state, created_at, external_work_request_id);
    CREATE TRIGGER r2_external_work_continuations_transition
    BEFORE UPDATE ON r2_external_work_continuations
    WHEN new.external_work_request_id IS NOT old.external_work_request_id
      OR new.mission_id IS NOT old.mission_id
      OR new.mission_run_id IS NOT old.mission_run_id
      OR new.created_at IS NOT old.created_at
      OR NOT (
        (old.state = 'PENDING' AND new.state = 'CONSUMING' AND new.consumed_at IS NULL)
        OR (old.state = 'CONSUMING' AND new.state = 'CONSUMED' AND new.consumed_at IS NOT NULL)
      )
    BEGIN SELECT RAISE(ABORT, 'invalid continuation transition'); END;
    INSERT INTO external_work_requests VALUES ('request-a'), ('request-b');
    INSERT INTO missions VALUES ('mission-a'), ('mission-b');
    INSERT INTO mission_runs VALUES ('run-a','mission-a'), ('run-b','mission-b');
  `);
  return { db, repository: new R2ContinuationRepository(db) };
}

describe('R2 ExternalWork continuation persistence', () => {
  it('persists a single pending continuation bound to the accepted request, Mission, and Run', () => {
    const { db, repository } = fixture();
    try {
      const input = {
        externalWorkRequestId: 'request-a',
        missionId: 'mission-a',
        missionRunId: 'run-a',
        createdAt: '2026-09-28T10:00:00.000Z',
      };
      expect(repository.createPending(input)).toMatchObject({
        externalWorkRequestId: 'request-a',
        missionId: 'mission-a',
        missionRunId: 'run-a',
        state: 'PENDING',
        consumedAt: null,
      });
      expect(repository.createPending(input)).toMatchObject({ state: 'PENDING' });
      expect(() =>
        repository.createPending({ ...input, missionId: 'mission-b', missionRunId: 'run-b' }),
      ).toThrow(/identity conflicts/);
      expect(repository.listRecoverable()).toHaveLength(1);
      expect(() =>
        repository.createPending({ ...input, externalWorkRequestId: 'missing' }),
      ).toThrow();
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM r2_external_work_continuations').get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('claims once, recovers a CONSUMING row after restart, and marks consumption idempotently', () => {
    const { db, repository } = fixture();
    try {
      repository.createPending({
        externalWorkRequestId: 'request-a',
        missionId: 'mission-a',
        missionRunId: 'run-a',
        createdAt: 'created',
      });
      expect(repository.markConsuming('request-a', 'claimed')).toBe(true);
      expect(repository.markConsuming('request-a', 'duplicate')).toBe(false);
      expect(repository.listRecoverable()).toMatchObject([
        { externalWorkRequestId: 'request-a', state: 'CONSUMING' },
      ]);

      const reopened = new R2ContinuationRepository(db);
      expect(reopened.listRecoverable()).toMatchObject([
        { externalWorkRequestId: 'request-a', missionRunId: 'run-a', state: 'CONSUMING' },
      ]);
      expect(reopened.markConsumed('request-a', 'done')).toBe(true);
      expect(reopened.markConsumed('request-a', 'again')).toBe(true);
      expect(reopened.getByRequestId('request-a')).toMatchObject({
        state: 'CONSUMED',
        consumedAt: 'done',
      });
      expect(reopened.listRecoverable()).toEqual([]);
      expect(() =>
        db
          .prepare(
            "UPDATE r2_external_work_continuations SET state = 'PENDING' WHERE external_work_request_id = 'request-a'",
          )
          .run(),
      ).toThrow(/invalid continuation transition/);
    } finally {
      db.close();
    }
  });
});
