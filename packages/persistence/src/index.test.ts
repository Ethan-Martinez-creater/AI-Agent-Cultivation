import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { databasePath, openDatabase, runMigrations, migrations } from './index.js';

describe('SQLite bootstrap', () => {
  it('places data beneath userData', () => {
    expect(databasePath('E:/example-user-data').replaceAll('\\', '/')).toBe(
      'E:/example-user-data/data/cultivation.sqlite',
    );
  });

  it('migrates fresh and reopened databases with WAL and foreign keys', () => {
    const directory = join(process.cwd(), '.test-data', `migration-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const path = databasePath(directory);
    let db = openDatabase(path);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(() =>
      db
        .prepare(
          `INSERT INTO runtime_profiles
      (id, name, provider_id, model_id, created_at, updated_at) VALUES
      ('r1', 'Test', 'missing-provider', 'fake', 'now', 'now')`,
        )
        .run(),
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 1,
    });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all() as { name: string }[];
    for (const name of [
      'app_meta',
      'providers',
      'provider_credentials',
      'runtime_profiles',
      'teammates',
      'memories',
      'memory_fts',
      'skills',
      'teammate_skills',
      'tools',
      'mcp_servers',
      'teammate_tool_grants',
      'parties',
      'party_members',
      'missions',
      'mission_runs',
      'mission_participants',
      'messages',
      'mission_events',
      'approval_requests',
      'permission_rules',
      'collaboration_requests',
      'audit_events',
      'usage_records',
      'experience_events',
      'capability_profiles',
    ]) {
      expect(tables.some((table) => table.name === name)).toBe(true);
    }
    const appendOnlyTriggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mission_events'",
      )
      .all() as { name: string }[];
    expect(appendOnlyTriggers.map((row) => row.name)).toEqual(
      expect.arrayContaining(['mission_events_no_update', 'mission_events_no_delete']),
    );
    runMigrations(db, migrations);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 1,
    });
    db.close();
    db = openDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 1,
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('keeps Mission-scoped permissions separate for the same subject and capability', () => {
    const directory = join(process.cwd(), '.test-data', `permission-${crypto.randomUUID()}`);
    const db = openDatabase(databasePath(directory));
    try {
      db.prepare(
        `INSERT INTO teammates (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      ).run('teammate-1', '测试道友', 'now', 'now');
      const insertMission = db.prepare(
        `INSERT INTO missions
          (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
           mode, created_at, updated_at)
         VALUES (?, ?, ?, 'USER', 'user-1', 'teammate-1', 'SOLO', 'now', 'now')`,
      );
      insertMission.run('mission-1', '任务一', '验证作用域一');
      insertMission.run('mission-2', '任务二', '验证作用域二');

      const rules = [
        {
          id: 'rule-1',
          subjectType: 'USER',
          subjectId: 'user-1',
          capability: 'FILE_READ',
          resourcePattern: '/docs/*',
          decision: 'ALLOW',
          scope: 'MISSION',
          scopeId: 'mission-1',
        },
        {
          id: 'rule-2',
          subjectType: 'USER',
          subjectId: 'user-1',
          capability: 'FILE_READ',
          resourcePattern: '/docs/*',
          decision: 'DENY',
          scope: 'MISSION',
          scopeId: 'mission-2',
        },
      ] as const;
      const insertRule = db.prepare(
        `INSERT INTO permission_rules
          (id, subject_type, subject_id, capability, resource_pattern, decision, scope, scope_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const rule of rules) {
        insertRule.run(
          rule.id,
          rule.subjectType,
          rule.subjectId,
          rule.capability,
          rule.resourcePattern,
          rule.decision,
          rule.scope,
          rule.scopeId,
        );
      }

      const findForMission = db.prepare(
        `SELECT id, decision FROM permission_rules
         WHERE subject_type = 'USER' AND subject_id = 'user-1'
           AND capability = 'FILE_READ' AND resource_pattern = '/docs/*'
           AND scope = 'MISSION' AND scope_id = ?`,
      );
      expect(findForMission.all('mission-1')).toEqual([{ id: 'rule-1', decision: 'ALLOW' }]);
      expect(findForMission.all('mission-2')).toEqual([{ id: 'rule-2', decision: 'DENY' }]);
      expect(findForMission.all('mission-3')).toEqual([]);
      expect(() =>
        insertRule.run('bad', 'USER', 'user-1', 'FILE_READ', '/docs/*', 'ALLOW', 'MISSION', null),
      ).toThrow();
      expect(() =>
        insertRule.run(
          'bad',
          'USER',
          'user-1',
          'FILE_READ',
          '/docs/*',
          'ALLOW',
          'MISSION',
          'missing-mission',
        ),
      ).toThrow();
      expect(() => db.prepare('DELETE FROM missions WHERE id = ?').run('mission-1')).toThrow();
    } finally {
      db.close();
    }
  });
});
