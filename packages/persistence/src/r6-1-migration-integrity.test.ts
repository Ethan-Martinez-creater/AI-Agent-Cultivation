import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { compileUserWorkflowVersion } from '@cultivation/domain';
import { WorkflowEditorService, WorkflowService } from '@cultivation/application';
import type { WorkflowMissionPort } from '../../application/src/w1-workflow-ports.js';
import { installOfficialBuiltinWorkflows } from '../../../apps/desktop/src/main/w2-builtin-installation.js';
import {
  migrations,
  runMigrations,
  W1WorkflowRepository,
  W2WorkflowRepository,
  W31WorkflowDraftRepository,
  Gate3SqliteRepository,
} from './index.js';

it('R6.1 preserves native on-disk 0031 profile facts, guards and frozen releases across 0032 upgrade and second restart', () => {
  const directory = join(process.cwd(), '.test-data/r61-upgrade');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${randomUUID()}.sqlite`);
  let db = new Database(file);
  const tables = [
    'workflow_versions',
    'workflow_builtin_releases',
    'workflow_artifact_contract_registry',
    'workflow_runs',
    'workflow_step_runs',
    'workflow_events',
    'workflow_user_drafts',
    'missions',
    'mission_events',
    'audit_events',
    'usage_records',
    'experience_events',
  ];
  const snapshot = () =>
    Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 31),
    );
    const workflows = new W1WorkflowRepository(db);
    const foundation = new W2WorkflowRepository(db);
    installOfficialBuiltinWorkflows(workflows, foundation);
    const engine = new WorkflowService(workflows, {} as WorkflowMissionPort, undefined, foundation);
    const draftStore = new W31WorkflowDraftRepository(db);
    const editor = new WorkflowEditorService(draftStore, workflows, engine);
    let draft = editor.createDraft({ name: '旧版本待编辑资料' });
    draft.content.steps[0]!.objective = '处理已声明输入，不执行外部操作';
    draft = editor.saveDraft({
      id: draft.id,
      expectedRevision: draft.revision,
      content: draft.content,
    });
    const version = compileUserWorkflowVersion(draft, 1, draft.createdAt);
    workflows.publishVersion(version);
    const run = engine.createRun({ definitionId: version.definition.id, version: 1 });
    db.prepare(
      "INSERT INTO providers (id,name,kind,created_at,updated_at) VALUES ('p','旧服务','OPENAI','now','now')",
    ).run();
    db.prepare(
      "INSERT INTO runtime_profiles (id,name,provider_id,model_id,created_at,updated_at) VALUES ('r','旧配置','p','old-model','now','now')",
    ).run();
    db.prepare(
      "INSERT INTO teammates (id,name,current_runtime_profile_id,created_at,updated_at) VALUES ('t','旧道友','r','now','now')",
    ).run();
    const missions = new Gate3SqliteRepository(db);
    missions.insertMission({
      id: 'old-mission',
      title: '旧待办',
      objective: '保留事实',
      initiatorType: 'USER',
      initiatorId: 'local-user',
      coordinatorTeammateId: 't',
      partyId: null,
      mode: 'SOLO',
      state: 'DRAFT',
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
      completedAt: null,
    });
    missions.appendMissionEvent({
      id: 'old-event',
      missionId: 'old-mission',
      runId: null,
      eventType: 'mission.created',
      actorType: 'USER',
      actorId: 'local-user',
      payloadJson: {},
      createdAt: draft.createdAt,
    });
    const before = snapshot();
    db.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    // The only expected change in old rows is the explicit EXECUTED default added by 0032.
    const after = snapshot();
    const stepsBefore = before.workflow_step_runs as Array<Record<string, unknown>>;
    before.workflow_step_runs = stepsBefore.map((step) => ({
      ...step,
      completion_origin: 'EXECUTED',
    }));
    expect(after).toEqual(before);
    expect(db.prepare('SELECT MAX(version) version FROM schema_migrations').get()).toEqual({
      version: 32,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(() =>
      db
        .prepare('UPDATE workflow_versions SET version_json = ? WHERE definition_id = ?')
        .run('{}', version.definition.id),
    ).toThrow();
    expect(() =>
      db
        .prepare("UPDATE workflow_step_runs SET state = 'COMPLETED' WHERE workflow_run_id = ?")
        .run(run.run.id),
    ).toThrow();
    expect(() =>
      db
        .prepare('UPDATE workflow_runs SET input_snapshot_json = ? WHERE id = ?')
        .run('{"forged":true}', run.run.id),
    ).toThrow();
    const frozen = snapshot();
    db.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    expect(snapshot()).toEqual(frozen);
    expect(new W1WorkflowRepository(db).detail(run.run.id)!.run.definitionVersion).toBe(1);
    expect(new W31WorkflowDraftRepository(db).getDraft(draft.id)).toEqual(draft);
  } finally {
    db.close();
  }
}, 30000);
