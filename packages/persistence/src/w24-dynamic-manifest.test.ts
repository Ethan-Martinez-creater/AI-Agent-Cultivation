import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE workflow_step_operation_receipts(id TEXT, workflow_run_id TEXT, step_run_id TEXT, attempt INTEGER,effect_type TEXT,state TEXT,manifest_json TEXT);
    CREATE TABLE workflow_step_runs(id TEXT,workflow_run_id TEXT,attempt INTEGER,step_id TEXT);
    CREATE TABLE workflow_runs(id TEXT,definition_id TEXT,definition_version INTEGER);
    CREATE TABLE workflow_versions(definition_id TEXT,version INTEGER,version_json TEXT);
    CREATE TABLE workflow_workspace_mutation_journal(id TEXT,operation_receipt_id TEXT,relative_path TEXT,state TEXT,before_hash TEXT,observed_after_hash TEXT,created_at TEXT);
    CREATE VIEW workflow_w2_operation_effect_paths AS SELECT '' AS step_run_id,'' AS effect_type,'' AS relative_path WHERE 0;
    CREATE TRIGGER workflow_step_operation_receipts_manifest_validate_update BEFORE UPDATE ON workflow_step_operation_receipts BEGIN SELECT 1; END;
    INSERT INTO workflow_step_runs VALUES('step','workflow',1,'S05');
    INSERT INTO workflow_runs VALUES('workflow','official.software-feature',1);
    INSERT INTO workflow_versions VALUES('official.software-feature',1,'{"definition":{"source":"BUILTIN"},"validationPolicy":"software-integrity-v1","steps":[{"id":"S05","effectType":"WORKSPACE_MUTATION","effectPathMode":"DYNAMIC"}]}');
    INSERT INTO workflow_step_operation_receipts VALUES('operation','workflow','step',1,'WORKSPACE_MUTATION','PREPARED','[]');`);
  db.exec(readFileSync('migrations/0025_w23_uncertain_prepared_effect.sql', 'utf8'));
  db.exec(readFileSync('migrations/0026_w24_dynamic_manifest_integrity.sql', 'utf8'));
  const journal = (id: string, path: string, afterHash: string) =>
    db
      .prepare('INSERT INTO workflow_workspace_mutation_journal VALUES(?,?,?,?,?,?,?)')
      .run(id, 'operation', path, 'APPLIED', null, afterHash, '2026-10-04T00:00:00.000Z');
  const update = (manifest: unknown[], state = 'APPLIED') =>
    db
      .prepare('UPDATE workflow_step_operation_receipts SET manifest_json=?,state=?')
      .run(JSON.stringify(manifest), state);
  return { db, journal, update };
}
const a = { relativePath: 'a.ts', afterHash: 'a'.repeat(64) };
const b = { relativePath: 'b.ts', afterHash: 'b'.repeat(64) };
describe('W2.4 shipped dynamic manifest SQL defense', () => {
  it('rejects duplicate path covering up a missing changed file', () => {
    const f = fixture();
    f.journal('1', 'a.ts', a.afterHash);
    f.journal('2', 'b.ts', b.afterHash);
    expect(() => f.update([a, a])).toThrow('exactly once');
    expect(() => f.update([a])).toThrow();
    expect(() => f.update([a, b])).not.toThrow();
    expect(() => f.update([a, b], 'VERIFIED')).not.toThrow();
    f.db.close();
  });
  it('rejects stale afterHash when writes share a timestamp', () => {
    const f = fixture();
    f.journal('1', 'a.ts', a.afterHash);
    f.journal('2', 'a.ts', b.afterHash);
    expect(() => f.update([a])).toThrow('latest hash');
    expect(() => f.update([{ ...a, afterHash: b.afterHash }])).not.toThrow();
    f.db.close();
  });
  it('preserves empty uncertain PREPARED and unchanged APPLIED evidence', () => {
    const empty = fixture();
    expect(() => empty.update([], 'UNKNOWN')).not.toThrow();
    empty.db.close();
    const applied = fixture();
    applied.journal('1', 'a.ts', a.afterHash);
    applied.update([a]);
    expect(() => applied.update([a], 'UNKNOWN')).not.toThrow();
    applied.db.close();
  });
});
