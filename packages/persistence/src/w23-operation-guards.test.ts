import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

/** Exercise the shipped SQL against hostile direct writes, independent of Main. */
function fixture(mode: string, budget = 2) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,definition_id TEXT,definition_version INTEGER,input_snapshot_json TEXT);
    CREATE TABLE workflow_versions(definition_id TEXT,version INTEGER,version_json TEXT);
    CREATE TABLE workflow_steps(definition_id TEXT,version INTEGER,id TEXT,type TEXT,effect_type TEXT);
    CREATE TABLE workflow_step_runs(id TEXT PRIMARY KEY,workflow_run_id TEXT,attempt INTEGER,step_id TEXT,state TEXT,wait_reason TEXT,mission_id TEXT,mission_run_id TEXT);
    CREATE TABLE mission_runs(id TEXT PRIMARY KEY,mission_id TEXT,status TEXT);
    CREATE TABLE mission_events(mission_id TEXT,run_id TEXT,event_type TEXT,payload_json TEXT);
    CREATE TABLE workflow_step_operation_receipts(id TEXT PRIMARY KEY,workflow_run_id TEXT,step_run_id TEXT,attempt INTEGER,
      operation_key TEXT,effect_type TEXT,state TEXT,output_artifact_ids_json TEXT,external_reference TEXT);
    CREATE TABLE workflow_revision_traversals(workflow_run_id TEXT,group_id TEXT,traversal_index INTEGER);
    CREATE TRIGGER workflow_step_operation_receipts_validate_insert BEFORE INSERT ON workflow_step_operation_receipts BEGIN SELECT 1; END;
    CREATE TRIGGER workflow_step_runs_w2_completion_guard BEFORE UPDATE ON workflow_step_runs BEGIN SELECT 1; END;
    INSERT INTO workflow_steps VALUES('official.research',1,'R08','TASK','FILE_OUTPUT');
    INSERT INTO workflow_step_runs(id,workflow_run_id,attempt,step_id,state) VALUES('step','workflow',1,'R08','RUNNING');`);
  db.prepare('INSERT INTO workflow_runs VALUES(?,?,?,?)').run(
    'workflow',
    'official.research',
    1,
    JSON.stringify({ experimentMode: mode, maxExperimentCycles: budget }),
  );
  db.prepare('INSERT INTO workflow_versions VALUES(?,?,?)').run(
    'official.research',
    1,
    JSON.stringify({
      definition: { source: 'BUILTIN' },
      validationPolicy: 'research-integrity-v1',
      contractManifest: [],
    }),
  );
  const sql = readFileSync('migrations/0023_w23_research.sql', 'utf8');
  db.exec(sql.slice(0, sql.indexOf('CREATE TABLE research_source_artifacts')));
  const prepare = (
    id: string,
    effect: string,
    key = `workflow:workflow:step${id === 'external' ? ':external' : ''}`,
  ) =>
    db
      .prepare('INSERT INTO workflow_step_operation_receipts VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, 'workflow', 'step', 1, key, effect, 'PREPARED', '[]', null);
  return { db, prepare };
}
describe('research frozen operation and revision SQL authority', () => {
  it.each(['COMPUTATIONAL', 'MIXED'])(
    '%s rejects an external receipt as the primary operation',
    (mode) => {
      const { db, prepare } = fixture(mode);
      expect(() => prepare('primary', 'EXTERNAL_ACTION')).toThrow();
      expect(() => prepare('primary', 'FILE_OUTPUT')).not.toThrow();
      db.close();
    },
  );
  it('external mode rejects FILE_OUTPUT and accepts only the frozen external semantics', () => {
    const { db, prepare } = fixture('HUMAN_OR_EXTERNAL');
    expect(() => prepare('primary', 'FILE_OUTPUT')).toThrow();
    prepare('primary', 'EXTERNAL_ACTION');
    db.close();
  });
  it('mixed mode requires the exact secondary operation key and both receipts VERIFIED', () => {
    const { db, prepare } = fixture('MIXED');
    prepare('primary', 'FILE_OUTPUT');
    expect(() => prepare('external', 'EXTERNAL_ACTION', 'arbitrary-external')).toThrow();
    prepare('external', 'EXTERNAL_ACTION');
    db.prepare(
      "UPDATE workflow_step_operation_receipts SET state='VERIFIED' WHERE id='primary'",
    ).run();
    expect(() => db.prepare("UPDATE workflow_step_runs SET state='COMPLETED'").run()).toThrow();
    db.prepare(
      "UPDATE workflow_step_operation_receipts SET state='VERIFIED' WHERE id='external'",
    ).run();
    expect(() => db.prepare("UPDATE workflow_step_runs SET state='COMPLETED'").run()).not.toThrow();
    db.close();
  });
  it('a user-sourced graph cannot manufacture the special mixed external operation', () => {
    const { db, prepare } = fixture('MIXED');
    db.prepare(
      "UPDATE workflow_versions SET version_json=json_set(version_json,'$.definition.source','USER')",
    ).run();
    expect(() => prepare('external', 'EXTERNAL_ACTION')).toThrow();
    db.close();
  });
  it('allows only the mixed secondary handoff after the bound Mission resumes a real Tool approval', () => {
    const { db, prepare } = fixture('MIXED');
    prepare('primary', 'FILE_OUTPUT');
    db.exec(
      "UPDATE workflow_step_runs SET state='WAITING',wait_reason='APPROVAL',mission_id='mission',mission_run_id='run'; INSERT INTO mission_runs VALUES('run','mission','RUNNING');",
    );
    expect(() => prepare('external', 'EXTERNAL_ACTION')).toThrow();
    const evidence = JSON.stringify({
      success: true,
      source: 'MCP',
      capability: 'MCP_TOOL_EXECUTE',
      researchExperiment: { status: 'SUCCEEDED' },
    });
    db.prepare('INSERT INTO mission_events VALUES(?,?,?,?)').run(
      'mission',
      'foreign-run',
      'tool.result',
      evidence,
    );
    expect(() => prepare('external', 'EXTERNAL_ACTION')).toThrow();
    db.prepare('INSERT INTO mission_events VALUES(?,?,?,?)').run(
      'mission',
      'run',
      'tool.result',
      evidence,
    );
    expect(() => prepare('external', 'EXTERNAL_ACTION')).not.toThrow();
    expect(() => prepare('another-primary', 'FILE_OUTPUT')).toThrow();
    db.close();
  });
  it('tightens the shared revision budget to the immutable run input', () => {
    const { db } = fixture('COMPUTATIONAL', 1);
    const insert = db.prepare('INSERT INTO workflow_revision_traversals VALUES(?,?,?)');
    insert.run('workflow', 'research.experiment_cycle', 1);
    expect(() => insert.run('workflow', 'research.experiment_cycle', 2)).toThrow();
    db.close();
  });
});
