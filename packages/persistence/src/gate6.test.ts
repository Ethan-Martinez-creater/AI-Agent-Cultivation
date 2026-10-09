import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissionEvent } from '@cultivation/domain';
import {
  Gate6SqliteRepository,
  Gate5SqliteRepository,
  migrations,
  runMigrations,
} from './index.js';

function fixture(steps: typeof migrations = migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, steps);
  db.prepare(
    `INSERT INTO providers (id,name,kind,created_at,updated_at)
     VALUES ('provider','Provider','OPENAI','now','now')`,
  ).run();
  db.prepare(
    `INSERT INTO runtime_profiles (id,name,provider_id,model_id,created_at,updated_at)
     VALUES ('runtime','Runtime','provider','model','now','now')`,
  ).run();
  const teammate = db.prepare(
    `INSERT INTO teammates (id,name,current_runtime_profile_id,created_at,updated_at)
     VALUES (?, ?, 'runtime','now','now')`,
  );
  for (const id of ['a', 'b', 'c']) teammate.run(id, id.toUpperCase());
  const parties = new Gate5SqliteRepository(db);
  parties.saveParty(
    {
      id: 'party',
      name: 'Party',
      description: '',
      coordinatorTeammateId: 'a',
      type: 'FIXED',
      status: 'ACTIVE',
      createdAt: 'now',
    },
    [
      { partyId: 'party', teammateId: 'a', role: 'COORDINATOR', order: 0 },
      { partyId: 'party', teammateId: 'b', role: 'MEMBER', order: 1 },
      { partyId: 'party', teammateId: 'c', role: 'MEMBER', order: 2 },
    ],
  );
  db.prepare(
    `INSERT INTO missions (id,title,objective,initiator_type,initiator_id,
       coordinator_teammate_id,party_id,mode,state,created_at,updated_at)
     VALUES ('mission','Mission','Objective','USER','user','a','party','CONSULTATION','READY','now','now')`,
  ).run();
  for (const [teammateId, role, sortOrder] of [
    ['a', 'COORDINATOR', 0],
    ['b', 'MEMBER', 1],
    ['c', 'MEMBER', 2],
  ] as const) {
    db.prepare(
      `INSERT INTO mission_participants (mission_id,teammate_id,role,sort_order)
       VALUES ('mission', ?, ?, ?)`,
    ).run(teammateId, role, sortOrder);
  }
  db.prepare("UPDATE missions SET state='RUNNING' WHERE id='mission'").run();
  const insertRun = db.prepare(
    `INSERT INTO mission_runs (id,mission_id,attempt,status,started_at)
     VALUES (?, 'mission', ?, 'RUNNING', ?)`,
  );
  const finishRun = db.prepare(`UPDATE mission_runs SET status = ?, ended_at = ? WHERE id = ?`);
  for (const [id, attempt] of [
    ['run-1', 1],
    ['run-2', 2],
    ['run-3', 3],
    ['run-4', 4],
    ['run-5', 5],
  ] as const) {
    insertRun.run(id, attempt, `start-${attempt}`);
  }
  for (const [id, status, endedAt] of [
    ['run-1', 'COMPLETED', 'end-1'],
    ['run-2', 'FAILED', 'end-2'],
    ['run-3', 'CANCELLED', 'end-3'],
    ['run-4', 'INTERRUPTED', 'end-4'],
    ['run-5', 'FAILED', 'end-5'],
  ] as const) {
    finishRun.run(status, endedAt, id);
  }
  const ledger = new Gate6SqliteRepository(db);
  return { db, parties, ledger };
}

function event(
  id: string,
  runId: string,
  eventType: string,
  actorId: string,
  payload: Record<string, unknown> = {},
): MissionEvent {
  return {
    id,
    missionId: 'mission',
    runId,
    eventType,
    actorType: 'TEAMMATE',
    actorId,
    payloadJson: payload,
    createdAt: `2026-09-27T00:00:${id.at(-1)}Z`,
  };
}

function insertEvent(db: Database.Database, value: MissionEvent): void {
  db.prepare(
    `INSERT INTO mission_events
      (id,mission_id,run_id,event_type,actor_type,actor_id,payload_json,created_at)
     VALUES (@id,@missionId,@runId,@eventType,@actorType,@actorId,@payloadJson,@createdAt)`,
  ).run({ ...value, payloadJson: JSON.stringify(value.payloadJson) });
}

function approveCollaboration(db: Database.Database, id: string, runId: string, target: string) {
  db.prepare(
    `INSERT INTO collaboration_requests
      (id,mission_id,run_id,requester_teammate_id,target_teammate_id,reason,proposed_task,
       expected_benefit,depth,state,created_at)
     VALUES (?, 'mission', ?, 'a', ?, 'reason', 'task', 'benefit', 1, 'PENDING', 'now')`,
  ).run(id, runId, target);
  db.prepare(
    `UPDATE collaboration_requests SET state='APPROVED',resolved_at='later' WHERE id=?`,
  ).run(id);
}

describe('Gate 6 experience ledger', () => {
  let current: ReturnType<typeof fixture> | null = null;
  afterEach(() => {
    current?.db.close();
    current = null;
  });

  it('attributes Party and SOLO results to actors, excludes denied legacy artifacts, and keeps retries separate', () => {
    current = fixture();
    const { db, parties, ledger } = current;
    insertEvent(db, event('call-a-1', 'run-1', 'model.call_started', 'a'));
    db.prepare(
      `INSERT INTO collaboration_requests
        (id,mission_id,run_id,requester_teammate_id,target_teammate_id,reason,proposed_task,
         expected_benefit,depth,state,created_at)
       VALUES ('denied-c','mission','run-1','a','c','reason','task','benefit',1,'PENDING','now')`,
    ).run();
    db.prepare(
      `UPDATE collaboration_requests SET state='DENIED',resolved_at='later' WHERE id='denied-c'`,
    ).run();
    parties.appendCollaborationArtifact({
      id: 'legacy-fake-c',
      missionId: 'mission',
      runId: 'run-1',
      teammateId: 'c',
      kind: 'MEMBER_RESULT',
      content: 'Legacy fake result from a denied target',
      createdAt: 'legacy',
    });

    approveCollaboration(db, 'approved-b-1', 'run-1', 'b');
    insertEvent(db, event('call-b-1', 'run-1', 'model.call_started', 'b'));
    insertEvent(
      db,
      event('collab-start-b-1', 'run-1', 'collaboration.started', 'b', {
        requestId: 'approved-b-1',
        targetTeammateId: 'b',
      }),
    );
    insertEvent(
      db,
      event('collab-failed-b-1', 'run-1', 'collaboration.failed', 'b', {
        requestId: 'approved-b-1',
        targetTeammateId: 'b',
      }),
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO experience_events
            (id,teammate_id,mission_id,run_id,experience_type,source,source_id,role,outcome,mode,created_at)
           VALUES ('wrong-collaboration-outcome','b','mission','run-1','COLLABORATION',
             'COLLABORATION_EVENT','collab-start-b-1','MEMBER','COMPLETED','CONSULTATION','now')`,
        )
        .run(),
    ).toThrow(/durable Mission, Run, and actor evidence/);

    approveCollaboration(db, 'approved-b-2', 'run-2', 'b');
    insertEvent(db, event('call-b-2', 'run-2', 'model.call_started', 'b'));
    insertEvent(
      db,
      event('collab-b-2', 'run-2', 'collaboration.started', 'b', {
        requestId: 'approved-b-2',
        targetTeammateId: 'b',
      }),
    );
    insertEvent(
      db,
      event('collab-completed-b-2', 'run-2', 'collaboration.completed', 'b', {
        requestId: 'approved-b-2',
        targetTeammateId: 'b',
      }),
    );
    insertEvent(
      db,
      event('tool-denied-b-2', 'run-2', 'tool.result', 'b', {
        success: false,
        code: 'PERMISSION_DENIED',
      }),
    );
    insertEvent(db, event('tool-success-b-2', 'run-2', 'tool.result', 'b', { success: true }));
    insertEvent(db, event('skill-b-2', 'run-2', 'skill.used', 'b', { skillId: 'skill-1' }));
    parties.appendCollaborationArtifact({
      id: 'real-b-2',
      missionId: 'mission',
      runId: 'run-2',
      teammateId: 'b',
      kind: 'MEMBER_RESULT',
      content: 'Run 2 participant result',
      createdAt: '2026-09-27T00:00:20Z',
    });
    insertEvent(db, event('call-a-3', 'run-3', 'model.call_started', 'a'));
    insertEvent(db, event('call-a-4', 'run-4', 'model.call_started', 'a'));

    const inserted = ledger.reconcileExperienceEvents();
    expect(inserted).toBe(9);
    expect(ledger.reconcileExperienceEvents()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM experience_events').get()).toEqual({
      count: 9,
    });

    const aEvents = ledger.listExperienceEvents('a');
    expect(aEvents.filter((item) => item.experienceType === 'MISSION_RESULT')).toMatchObject([
      { runId: 'run-1', outcome: 'COMPLETED', role: 'COORDINATOR' },
      { runId: 'run-3', outcome: 'CANCELLED', role: 'COORDINATOR' },
      { runId: 'run-4', outcome: 'INTERRUPTED', role: 'COORDINATOR' },
    ]);
    const bEvents = ledger.listExperienceEvents('b');
    expect(bEvents).toHaveLength(6);
    expect(
      bEvents.map(({ experienceType, runId, outcome }) => ({
        experienceType,
        runId,
        outcome,
      })),
    ).toEqual(
      expect.arrayContaining([
        { experienceType: 'MISSION_RESULT', runId: 'run-2', outcome: 'FAILED' },
        { experienceType: 'COLLABORATION', runId: 'run-1', outcome: 'FAILED' },
        { experienceType: 'COLLABORATION', runId: 'run-2', outcome: 'COMPLETED' },
        { experienceType: 'TOOL_USE', runId: 'run-2', outcome: 'FAILED' },
        { experienceType: 'SKILL_USE', runId: 'run-2', outcome: 'FAILED' },
      ]),
    );
    expect(ledger.listExperienceEvents('c')).toEqual([]);
    expect(ledger.listExperienceEvents('a').some((item) => item.runId === 'run-5')).toBe(false);
    expect(ledger.listExperienceEvents('b').some((item) => item.runId === 'run-5')).toBe(false);
    expect(bEvents.map((item) => item.sourceId)).toContain('collab-b-2');
    expect(bEvents.map((item) => item.sourceId)).not.toContain('legacy-fake-c');
    expect(
      bEvents.find((item) => item.experienceType === 'MISSION_RESULT' && item.runId === 'run-1')
        ?.outcome,
    ).toBe('COMPLETED');
  });

  it('enforces source ownership, provenance, uniqueness, and append-only rows in SQLite', () => {
    current = fixture();
    const { db, ledger } = current;
    insertEvent(db, event('call-a-1', 'run-1', 'model.call_started', 'a'));
    expect(ledger.reconcileExperienceEvents()).toBe(1);
    const saved = ledger.listExperienceEvents('a')[0]!;
    expect(() =>
      db.prepare('UPDATE experience_events SET role=? WHERE id=?').run('MEMBER', saved.id),
    ).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM experience_events WHERE id=?').run(saved.id)).toThrow(
      /append-only/,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO experience_events
          (id,teammate_id,mission_id,run_id,experience_type,source,source_id,role,outcome,mode,created_at)
         VALUES ('duplicate','a','mission','run-1','MISSION_RESULT','MISSION_RUN','run-1',
           'COORDINATOR','COMPLETED','CONSULTATION','later')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('preserves the pre-Gate-6 generic events table without treating its rows as ledger facts', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      runMigrations(db, migrations.slice(0, 6));
      db.prepare(
        `INSERT INTO providers (id,name,kind,created_at,updated_at)
         VALUES ('provider','Provider','OPENAI','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO runtime_profiles (id,name,provider_id,model_id,created_at,updated_at)
         VALUES ('runtime','Runtime','provider','model','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO teammates (id,name,current_runtime_profile_id,created_at,updated_at)
         VALUES ('a','A','runtime','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO missions (id,title,objective,initiator_type,initiator_id,
           coordinator_teammate_id,mode,state,created_at,updated_at)
         VALUES ('mission','Mission','Objective','USER','user','a','SOLO','DRAFT','now','now')`,
      ).run();
      db.prepare(
        `INSERT INTO experience_events
          (id,teammate_id,mission_id,event_type,payload_json,created_at)
         VALUES ('legacy','a','mission','score.changed','{"score":999}','now')`,
      ).run();

      runMigrations(db, migrations);
      expect(
        db.prepare('SELECT id,event_type,payload_json FROM legacy_experience_events').all(),
      ).toEqual([{ id: 'legacy', event_type: 'score.changed', payload_json: '{"score":999}' }]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM experience_events').get()).toEqual({
        count: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
        count: 32,
      });
    } finally {
      db.close();
    }
  });

  it('uses started-only outcomes for cancelled/interrupted runs and requires actor execution evidence', () => {
    current = fixture();
    const { db, ledger } = current;
    for (const [runId, requestId] of [
      ['run-3', 'cancelled-b'],
      ['run-4', 'interrupted-b'],
      ['run-5', 'failed-b'],
    ] as const) {
      approveCollaboration(db, requestId, runId, 'b');
      insertEvent(db, event(`call-${requestId}`, runId, 'model.call_started', 'b'));
      insertEvent(
        db,
        event(`start-${requestId}`, runId, 'collaboration.started', 'b', {
          requestId,
          targetTeammateId: 'b',
        }),
      );
    }

    expect(ledger.reconcileExperienceEvents()).toBe(5);
    const collaborations = ledger
      .listExperienceEvents('b')
      .filter((item) => item.experienceType === 'COLLABORATION');
    expect(collaborations.map(({ runId, outcome }) => ({ runId, outcome }))).toEqual(
      expect.arrayContaining([
        { runId: 'run-3', outcome: 'CANCELLED' },
        { runId: 'run-4', outcome: 'INTERRUPTED' },
      ]),
    );
    expect(ledger.reconcileExperienceEvents()).toBe(0);
  });

  it('rebuilds only derived Collaboration rows from 0007 facts and remains idempotent', () => {
    current = fixture(migrations.slice(0, 7));
    const { db, ledger } = current;
    approveCollaboration(db, 'approved-b-1', 'run-1', 'b');
    insertEvent(db, event('call-b-1', 'run-1', 'model.call_started', 'b'));
    insertEvent(
      db,
      event('start-b-1', 'run-1', 'collaboration.started', 'b', {
        requestId: 'approved-b-1',
        targetTeammateId: 'b',
      }),
    );
    insertEvent(
      db,
      event('failed-b-1', 'run-1', 'collaboration.failed', 'b', {
        requestId: 'approved-b-1',
        targetTeammateId: 'b',
      }),
    );
    insertEvent(
      db,
      event('coordinator-final-1', 'run-1', 'collaboration.completed', 'a', {
        artifactId: 'final-1',
        kind: 'FINAL',
      }),
    );

    db.prepare(
      `INSERT INTO experience_events
        (id,teammate_id,mission_id,run_id,experience_type,source,source_id,role,outcome,mode,created_at)
       VALUES ('old-mission-result','b','mission','run-1','MISSION_RESULT','MISSION_RUN',
         'run-1','MEMBER','COMPLETED','CONSULTATION','end-1')`,
    ).run();
    db.prepare(
      `INSERT INTO experience_events
        (id,teammate_id,mission_id,run_id,experience_type,source,source_id,role,outcome,mode,created_at)
       VALUES ('old-collaboration','b','mission','run-1','COLLABORATION','COLLABORATION_EVENT',
         'start-b-1','MEMBER','COMPLETED','CONSULTATION','now')`,
    ).run();
    expect(
      ledger.listExperienceEvents('b').find((item) => item.experienceType === 'COLLABORATION')
        ?.outcome,
    ).toBe('COMPLETED');
    const missionEventCount = db.prepare('SELECT COUNT(*) AS count FROM mission_events').get() as {
      count: number;
    };
    const auditEventCount = db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as {
      count: number;
    };

    runMigrations(db, migrations);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toHaveLength(
      31,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM mission_events').get()).toEqual(
      missionEventCount,
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get()).toEqual(auditEventCount);
    expect(
      ledger.listExperienceEvents('b').filter((item) => item.experienceType === 'COLLABORATION'),
    ).toEqual([]);

    expect(ledger.reconcileExperienceEvents()).toBe(1);
    expect(
      ledger.listExperienceEvents('b').filter((item) => item.experienceType === 'COLLABORATION'),
    ).toMatchObject([{ runId: 'run-1', outcome: 'FAILED', sourceId: 'start-b-1' }]);
    expect(ledger.reconcileExperienceEvents()).toBe(0);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM experience_events WHERE teammate_id = ? AND experience_type = ?',
        )
        .get('b', 'COLLABORATION'),
    ).toEqual({ count: 1 });
  });
});
