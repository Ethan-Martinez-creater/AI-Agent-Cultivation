import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { transition } from '@cultivation/domain';
import type {
  ApprovalRequest,
  AuditEvent,
  Mission,
  MissionEvent,
  PermissionRule,
  UsageRecord,
} from '@cultivation/domain';
import { Gate3SqliteRepository, migrations, runMigrations } from './index.js';

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  db.prepare(
    `INSERT INTO providers (id, name, kind, created_at, updated_at)
     VALUES ('provider-1', 'Test', 'OPENAI', 'now', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO runtime_profiles (id, name, provider_id, model_id, created_at, updated_at)
     VALUES ('runtime-1', 'Test runtime', 'provider-1', 'model-1', 'now', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO teammates (id, name, current_runtime_profile_id, created_at, updated_at)
     VALUES ('teammate-1', 'Test teammate', 'runtime-1', 'now', 'now')`,
  ).run();
  return db;
}

function mission(id: string, title = id): Mission {
  return {
    id,
    title,
    objective: `Objective ${id}`,
    initiatorType: 'USER',
    initiatorId: 'user-1',
    coordinatorTeammateId: 'teammate-1',
    partyId: null,
    mode: 'SOLO',
    state: 'DRAFT',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  };
}

function createRunningMission(repository: Gate3SqliteRepository, id: string): Mission {
  const draft = mission(id);
  repository.insertMission(draft);
  const ready = transition(draft, 'READY', '2026-01-01T00:01:00.000Z');
  expect(repository.transitionMission(ready, 'DRAFT')).toBe(true);
  const running = transition(ready, 'RUNNING', '2026-01-01T00:02:00.000Z');
  expect(repository.transitionMission(running, 'READY')).toBe(true);
  return running;
}

function approval(missionId: string, runId: string, id = 'approval-1'): ApprovalRequest {
  return {
    id,
    missionId,
    runId,
    requesterTeammateId: 'teammate-1',
    capability: 'FILE_WRITE',
    actionType: 'fixture.write',
    actionPayload: { path: 'fixture.txt' },
    riskLevel: 'LOW',
    state: 'PENDING',
    createdAt: '2026-01-01T00:03:00.000Z',
    resolvedAt: null,
  };
}

describe('Gate 3 SQLite persistence', () => {
  it('adds Gate 3 without rewriting previous run, audit, or migration data', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 3));
    db.prepare(
      `INSERT INTO teammates (id, name, created_at, updated_at)
       VALUES ('teammate-1', 'Legacy', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO missions
        (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
         mode, state, created_at, updated_at)
       VALUES ('mission-legacy', 'Legacy', 'Keep this', 'USER', 'user-1', 'teammate-1',
         'SOLO', 'RUNNING', 'created', 'updated')`,
    ).run();
    db.prepare(
      `INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
       VALUES ('run-legacy', 'mission-legacy', 1, 'RUNNING', 'started')`,
    ).run();
    db.prepare(
      `INSERT INTO audit_events (id, actor_type, action, target_type, target_id, created_at)
       VALUES ('audit-legacy', 'SYSTEM', 'legacy.action', 'MISSION', 'mission-legacy', 'created')`,
    ).run();

    runMigrations(db, migrations);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(db.prepare('SELECT id, result_text FROM mission_runs').all()).toEqual([
      { id: 'run-legacy', result_text: null },
    ]);
    expect(db.prepare('SELECT id, action FROM audit_events').all()).toEqual([
      { id: 'audit-legacy', action: 'legacy.action' },
    ]);
    db.close();
  });

  it('creates only SOLO DRAFT Missions and never changes state in details updates', () => {
    const db = createDatabase();
    const repository = new Gate3SqliteRepository(db);
    const draft = mission('mission-1');
    repository.insertMission(draft);
    expect(repository.getMission(draft.id)).toEqual(draft);
    expect(repository.listMissions()).toEqual([draft]);

    expect(
      repository.updateMissionDetails({
        ...draft,
        title: 'Edited',
        objective: 'New objective',
        updatedAt: '2026-01-01T00:01:00.000Z',
      }),
    ).toBe(true);
    expect(repository.getMission(draft.id)).toMatchObject({
      state: 'DRAFT',
      title: 'Edited',
      objective: 'New objective',
    });
    const ready = transition(repository.getMission(draft.id)!, 'READY');
    expect(repository.transitionMission(ready, 'DRAFT')).toBe(true);
    expect(repository.updateMissionDetails({ ...ready, title: 'Edited while ready' })).toBe(true);
    expect(repository.getMission(draft.id)).toMatchObject({
      state: 'READY',
      title: 'Edited while ready',
    });
    expect(() => repository.insertMission({ ...draft, state: 'READY' })).toThrow();
    expect(() =>
      repository.insertMission({ ...draft, id: 'mission-party', mode: 'DELEGATION' }),
    ).toThrow();
    db.close();
  });

  it('enforces the domain state machine and compare-and-swap state writes', () => {
    const db = createDatabase();
    const repository = new Gate3SqliteRepository(db);
    const draft = mission('mission-1');
    repository.insertMission(draft);
    expect(() => repository.transitionMission({ ...draft, state: 'COMPLETED' }, 'DRAFT')).toThrow(
      /Illegal Mission state transition/,
    );
    const ready = transition(draft, 'READY', '2026-01-01T00:01:00.000Z');
    expect(repository.transitionMission(ready, 'DRAFT')).toBe(true);
    expect(() => repository.transitionMission({ ...ready, state: 'RUNNING' }, 'DRAFT')).toThrow(
      /Illegal Mission state transition/,
    );
    const running = transition(ready, 'RUNNING', '2026-01-01T00:02:00.000Z');
    expect(repository.transitionMission(running, 'READY')).toBe(true);
    expect(repository.transitionMission(running, 'READY')).toBe(false);
    expect(repository.getMission(draft.id)?.state).toBe('RUNNING');
    db.close();
  });

  it('allocates independent attempts and finalizes only a RUNNING Run', () => {
    const db = createDatabase();
    const repository = new Gate3SqliteRepository(db);
    const firstMissionRun = createRunningMission(repository, 'mission-1');
    const first = repository.createRun(firstMissionRun.id, '2026-01-01T00:03:00.000Z');
    expect(first.attempt).toBe(1);
    expect(first.resultText).toBeNull();
    expect(
      repository.finishRun({
        ...first,
        status: 'FAILED',
        endedAt: '2026-01-01T00:04:00.000Z',
        errorCode: 'MODEL_FAILED',
        errorMessage: 'provider unavailable',
      }),
    ).toBe(true);
    expect(repository.finishRun({ ...first, status: 'COMPLETED', endedAt: 'later' })).toBe(false);
    expect(() =>
      db.prepare("UPDATE mission_runs SET result_text = 'rewritten' WHERE id = ?").run(first.id),
    ).toThrow(/finalized only once/);

    const failed = transition(firstMissionRun, 'FAILED', '2026-01-01T00:05:00.000Z');
    expect(repository.transitionMission(failed, 'RUNNING')).toBe(true);
    // Retry follows the domain state machine FAILED -> READY -> RUNNING while
    // preserving the first terminal Run.
    const ready = transition(failed, 'READY', '2026-01-01T00:06:00.000Z');
    expect(repository.transitionMission(ready, 'FAILED')).toBe(true);
    const running = transition(ready, 'RUNNING', '2026-01-01T00:07:00.000Z');
    expect(repository.transitionMission(running, 'READY')).toBe(true);
    const second = repository.createRun(firstMissionRun.id, '2026-01-01T00:08:00.000Z');

    expect(second.attempt).toBe(2);
    expect(repository.listRuns(firstMissionRun.id)).toMatchObject([
      { id: first.id, attempt: 1, status: 'FAILED', resultText: null },
      { id: second.id, attempt: 2, status: 'RUNNING', resultText: null },
    ]);
    db.close();
  });

  it('keeps Mission-scope permission rules isolated by exact scopeId', () => {
    const db = createDatabase();
    const repository = new Gate3SqliteRepository(db);
    repository.insertMission(mission('mission-1'));
    repository.insertMission(mission('mission-2'));
    const rule = (
      id: string,
      scopeId: string,
      decision: PermissionRule['decision'],
    ): PermissionRule => ({
      id,
      subjectType: 'TEAMMATE',
      subjectId: 'teammate-1',
      capability: 'FILE_WRITE',
      resourcePattern: 'fixture.txt',
      decision,
      scope: 'MISSION',
      scopeId,
    });
    repository.savePermissionRule(rule('rule-1', 'mission-1', 'ALLOW'));
    repository.savePermissionRule(rule('rule-2', 'mission-2', 'DENY'));

    expect(
      repository
        .listPermissionRules('TEAMMATE', 'teammate-1', 'FILE_WRITE')
        .filter((item) => item.scope === 'MISSION' && item.scopeId === 'mission-1'),
    ).toEqual([rule('rule-1', 'mission-1', 'ALLOW')]);
    expect(
      repository
        .listPermissionRules('TEAMMATE', 'teammate-1', 'FILE_WRITE')
        .filter((item) => item.scope === 'MISSION' && item.scopeId === 'mission-2'),
    ).toEqual([rule('rule-2', 'mission-2', 'DENY')]);
    expect(() =>
      repository.savePermissionRule(rule('bad-rule', 'missing-mission', 'ALLOW')),
    ).toThrow();
    db.close();
  });

  it('resolves an Approval once and rejects cross-Mission run associations', () => {
    const db = createDatabase();
    const repository = new Gate3SqliteRepository(db);
    const running = createRunningMission(repository, 'mission-1');
    repository.insertMission(mission('mission-2'));
    const run = repository.createRun(running.id, '2026-01-01T00:03:00.000Z');
    const request = approval(running.id, run.id);
    repository.insertApproval(request);
    expect(repository.getApproval(request.id)).toEqual(request);
    expect(repository.listApprovals(running.id)).toEqual([request]);
    expect(
      repository.resolveApproval(request.id, 'APPROVED', '2026-01-01T00:04:00.000Z'),
    ).toMatchObject({
      state: 'APPROVED',
      resolvedAt: '2026-01-01T00:04:00.000Z',
    });
    expect(repository.resolveApproval(request.id, 'DENIED', 'later')).toBeNull();
    expect(() =>
      db
        .prepare(
          "UPDATE approval_requests SET state = 'DENIED', resolved_at = 'later' WHERE id = ?",
        )
        .run(request.id),
    ).toThrow(/resolved once/);
    expect(() =>
      repository.insertApproval(approval('mission-2', run.id, 'cross-approval')),
    ).toThrow();
    expect(repository.resolveApproval('missing', 'DENIED', 'later')).toBeNull();
    db.close();
  });

  it('stores correctly owned Mission usage and rejects mismatched run/teammate ownership', () => {
    const db = createDatabase();
    const repository = new Gate3SqliteRepository(db);
    const running = createRunningMission(repository, 'mission-1');
    const run = repository.createRun(running.id, '2026-01-01T00:03:00.000Z');
    const usage: UsageRecord = {
      id: 'usage-1',
      missionId: running.id,
      runId: run.id,
      teammateId: 'teammate-1',
      runtimeProfileId: 'runtime-1',
      provider: 'OPENAI',
      model: 'model-1',
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: null,
      reasoningTokens: null,
      providerMetadata: null,
      estimatedCost: null,
      currency: null,
      createdAt: '2026-01-01T00:04:00.000Z',
    };
    repository.saveUsage(usage);
    expect(repository.listMissionUsage(running.id)).toEqual([usage]);
    expect(() =>
      repository.saveUsage({ ...usage, id: 'usage-wrong-run', missionId: 'mission-2' }),
    ).toThrow();
    expect(() =>
      repository.saveUsage({ ...usage, id: 'usage-wrong-owner', teammateId: 'other' }),
    ).toThrow();
    db.close();
  });

  it('appends immutable MissionEvent and AuditEvent records transactionally', () => {
    const db = createDatabase();
    const repository = new Gate3SqliteRepository(db);
    const running = createRunningMission(repository, 'mission-1');
    const run = repository.createRun(running.id, '2026-01-01T00:03:00.000Z');
    const event: MissionEvent = {
      id: 'event-1',
      missionId: running.id,
      runId: run.id,
      eventType: 'RUN_STARTED',
      actorType: 'SYSTEM',
      actorId: null,
      payloadJson: { attempt: run.attempt },
      createdAt: '2026-01-01T00:03:00.000Z',
    };
    const audit: AuditEvent = {
      id: 'audit-1',
      actorType: 'SYSTEM',
      actorId: null,
      action: 'mission.run.started',
      targetType: 'MISSION_RUN',
      targetId: run.id,
      payloadJson: { attempt: run.attempt },
      createdAt: '2026-01-01T00:03:00.000Z',
    };
    repository.transaction(() => {
      repository.appendMissionEvent(event);
      repository.appendAuditEvent(audit);
    });
    expect(repository.listMissionEvents(running.id)).toEqual([event]);
    expect(repository.listAuditEvents(running.id)).toEqual([audit]);
    expect(() => db.prepare("UPDATE audit_events SET action = 'changed'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/);
    expect(() => db.prepare('UPDATE mission_events SET event_type = ?').run('changed')).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM mission_events').run()).toThrow(/append-only/);
    expect(() =>
      repository.appendMissionEvent({ ...event, id: 'cross-event', missionId: 'mission-2' }),
    ).toThrow();

    const rollback: AuditEvent = { ...audit, id: 'audit-rollback', action: 'rollback' };
    expect(() =>
      repository.transaction(() => {
        repository.appendAuditEvent(rollback);
        throw new Error('abort composed write');
      }),
    ).toThrow('abort composed write');
    expect(repository.listAuditEvents(running.id)).toEqual([audit]);
    db.close();
  });
});
