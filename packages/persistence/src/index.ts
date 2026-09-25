import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import initialSql from '../../../migrations/0001_initial.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}
export const migrations: readonly Migration[] = [{ version: 1, name: 'initial', sql: initialSql }];

export function databasePath(userDataDirectory: string): string {
  return join(userDataDirectory, 'data', 'cultivation.sqlite');
}

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  runMigrations(db, migrations);
  return db;
}

export function runMigrations(db: Database.Database, steps: readonly Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    if (applied.has(step.version)) continue;
    db.transaction(() => {
      db.exec(step.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        step.version,
        step.name,
        new Date().toISOString(),
      );
    })();
  }
}
