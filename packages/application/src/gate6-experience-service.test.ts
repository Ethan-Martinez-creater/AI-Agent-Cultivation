import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ExperienceEvent } from '@cultivation/domain';
import { Gate6SqliteRepository, migrations, runMigrations } from '../../persistence/src/index.js';
import { buildCapabilityProfile, Gate6ExperienceService } from './gate6-experience-service.js';

function ledgerEvent(
  experienceType: ExperienceEvent['experienceType'],
  overrides: Partial<ExperienceEvent> = {},
): ExperienceEvent {
  return {
    id: `event-${experienceType}`,
    teammateId: 'a',
    missionId: 'mission',
    runId: 'run',
    experienceType,
    source: 'test',
    sourceId: `source-${experienceType}`,
    role: 'MEMBER',
    outcome: 'COMPLETED',
    mode: 'CONSULTATION',
    createdAt: '2026-09-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('Gate 6 experience application service', () => {
  it('rebuilds profile counters from ledger rows', () => {
    const profile = buildCapabilityProfile('a', [
      ledgerEvent('MISSION_RESULT'),
      ledgerEvent('MISSION_RESULT', { id: 'failed', outcome: 'FAILED' }),
      ledgerEvent('MISSION_RESULT', { id: 'cancelled', outcome: 'CANCELLED' }),
      ledgerEvent('COLLABORATION'),
      ledgerEvent('COLLABORATION', {
        id: 'review',
        mode: 'REVIEW',
        outcome: 'FAILED',
      }),
      ledgerEvent('COLLABORATION', { id: 'delegation', mode: 'DELEGATION' }),
      ledgerEvent('TOOL_USE'),
      ledgerEvent('SKILL_USE'),
    ]);
    expect(profile).toEqual({
      teammateId: 'a',
      completedMissions: 1,
      failedMissions: 1,
      cancelledMissions: 1,
      consultationParticipations: 1,
      reviewParticipations: 1,
      delegationParticipations: 1,
      toolUses: 1,
      completedCollaborations: 2,
      skillUses: 1,
      lastActiveAt: '2026-09-27T00:00:00.000Z',
    });
  });

  it('ignores legacy inflated capability profile data and reconciles idempotently', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    db.prepare(
      `INSERT INTO teammates (id,name,created_at,updated_at)
       VALUES ('a','A','now','now'),('b','B','now','now')`,
    ).run();
    db.prepare(
      `INSERT INTO missions (id,title,objective,initiator_type,initiator_id,
         coordinator_teammate_id,mode,state,created_at,updated_at)
       VALUES ('mission','Mission','Objective','USER','user','a','SOLO','RUNNING','now','now')`,
    ).run();
    db.prepare(
      `INSERT INTO mission_runs (id,mission_id,attempt,status,started_at)
       VALUES ('run','mission',1,'RUNNING','start')`,
    ).run();
    db.prepare("UPDATE mission_runs SET status='COMPLETED',ended_at='end' WHERE id='run'").run();
    db.prepare(
      `INSERT INTO mission_events
        (id,mission_id,run_id,event_type,actor_type,actor_id,payload_json,created_at)
       VALUES ('wrong-actor','mission','run','model.call_started','TEAMMATE','b','{}','start')`,
    ).run();
    db.prepare(
      `INSERT INTO capability_profiles (teammate_id,tags_json,stats_json,updated_at)
       VALUES ('a','[]','{"completedMissions":99999,"skillUses":99999}','later')`,
    ).run();
    const service = new Gate6ExperienceService(new Gate6SqliteRepository(db));
    try {
      const snapshot = service.get('a');
      expect(snapshot.events).toEqual([]);
      expect(snapshot.profile).toEqual({
        teammateId: 'a',
        completedMissions: 0,
        failedMissions: 0,
        cancelledMissions: 0,
        consultationParticipations: 0,
        reviewParticipations: 0,
        delegationParticipations: 0,
        toolUses: 0,
        completedCollaborations: 0,
        skillUses: 0,
        lastActiveAt: null,
      });
      expect(service.reconcileAll()).toBe(0);
      expect(service.get('b')).toEqual({
        events: [],
        profile: {
          teammateId: 'b',
          completedMissions: 0,
          failedMissions: 0,
          cancelledMissions: 0,
          consultationParticipations: 0,
          reviewParticipations: 0,
          delegationParticipations: 0,
          toolUses: 0,
          completedCollaborations: 0,
          skillUses: 0,
          lastActiveAt: null,
        },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM experience_events').get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });
});
