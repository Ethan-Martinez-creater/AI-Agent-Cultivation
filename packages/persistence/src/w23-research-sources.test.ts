import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ResearchSourceRepository, type ResearchSourceFact } from './w23-research-sources.js';
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,definition_id TEXT,definition_version INTEGER);
    CREATE TABLE workflow_step_runs(id TEXT PRIMARY KEY,workflow_run_id TEXT,mission_id TEXT,mission_run_id TEXT,step_id TEXT);
    CREATE TABLE workflow_versions(definition_id TEXT,version INTEGER,version_json TEXT);
    CREATE TABLE missions(id TEXT PRIMARY KEY);CREATE TABLE mission_runs(id TEXT PRIMARY KEY);
    CREATE TABLE teammates(id TEXT PRIMARY KEY);
    CREATE TABLE mission_events(id TEXT PRIMARY KEY,mission_id TEXT,run_id TEXT,actor_id TEXT,actor_type TEXT,event_type TEXT,payload_json TEXT);
    INSERT INTO workflow_runs VALUES('workflow','official.research',1);
    INSERT INTO workflow_step_runs VALUES('step','workflow','mission','run','R02');
    INSERT INTO workflow_versions VALUES('official.research',1,'{"definition":{"source":"BUILTIN"},"validationPolicy":"research-integrity-v1"}');
    INSERT INTO missions VALUES('mission');INSERT INTO mission_runs VALUES('run');INSERT INTO teammates VALUES('actor');`);
  const sql = readFileSync('migrations/0023_w23_research.sql', 'utf8');
  db.exec(
    sql.slice(
      sql.indexOf('CREATE TABLE research_source_artifacts'),
      sql.indexOf('-- W2.3 accepted research artifacts'),
    ),
  );
  const hash = 'a'.repeat(64),
    outputHash = 'b'.repeat(64);
  db.prepare('INSERT INTO mission_events VALUES(?,?,?,?,?,?,?)').run(
    'event',
    'mission',
    'run',
    'actor',
    'TEAMMATE',
    'tool.result',
    JSON.stringify({
      success: true,
      source: 'MCP',
      capability: 'MCP_TOOL_EXECUTE',
      toolCallId: 'call',
      toolId: 'research-tool',
      outputHash,
      researchSources: [{ url: 'https://example.org/source', contentHash: hash }],
    }),
  );
  const fact: ResearchSourceFact = {
    workflowRunId: 'workflow',
    stepRunId: 'step',
    sourceArtifactId: `source-${hash}`,
    missionId: 'mission',
    missionRunId: 'run',
    evidenceEventId: 'event',
    actorId: 'actor',
    toolCallId: 'call',
    toolId: 'research-tool',
    url: 'https://example.org/source',
    contentHash: hash,
    outputHash,
  };
  return { db, fact, store: new ResearchSourceRepository(db) };
}
describe('research Source Artifact provenance', () => {
  it.each(['wrong-step', 'user-version'])(
    'rejects %s source registration at the SQL boundary',
    (kind) => {
      const { db, fact, store } = fixture();
      if (kind === 'wrong-step') db.exec("UPDATE workflow_step_runs SET step_id='R08'");
      else
        db.exec(
          "UPDATE workflow_versions SET version_json=json_set(version_json,'$.definition.source','USER')",
        );
      expect(() => store.append(fact)).toThrow();
      expect(store.list('workflow')).toEqual([]);
      db.close();
    },
  );
  it('persists actual source facts idempotently and retains append-only provenance', () => {
    const { db, fact, store } = fixture();
    store.append(fact);
    store.append(fact);
    expect(store.list('workflow')).toEqual([fact]);
    expect(() =>
      db.prepare('UPDATE research_source_artifacts SET url=?').run('https://fake.example'),
    ).toThrow();
    expect(() => db.exec('DELETE FROM research_source_artifacts')).toThrow();
    db.close();
  });
  it.each(['missionRunId', 'actorId', 'toolCallId', 'outputHash', 'url', 'contentHash'] as const)(
    'rejects forged %s even with participant membership',
    (key) => {
      const { db, fact, store } = fixture();
      const forged = { ...fact, [key]: key.endsWith('Hash') ? 'c'.repeat(64) : 'forged' };
      expect(() => store.append(forged)).toThrow();
      expect(store.list('workflow')).toEqual([]);
      db.close();
    },
  );
  it('rejects unsuccessful tool output and other-run execution', () => {
    const { db, fact, store } = fixture();
    db.prepare("UPDATE mission_events SET payload_json=json_set(payload_json,'$.success',0)").run();
    expect(() => store.append(fact)).toThrow();
    db.close();
  });
});
