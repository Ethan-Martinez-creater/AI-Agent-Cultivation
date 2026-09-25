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
});
