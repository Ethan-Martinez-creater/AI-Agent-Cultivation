import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  W22WorkspaceMutationRepository,
  type WorkspaceMutationIntent,
  type WorkspaceVerificationFact,
} from './w22-workspace-mutations.js';

const NOW = '2026-10-03T10:00:00.000Z';
const WORKFLOW = 'workflow-run';
const STEP = 'step-run';
const MISSION = 'mission';
const RUN = 'mission-run';
const ACTOR = 'teammate';
const CALL = 'tool-call';
const WORKSPACE = 'a'.repeat(16);

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_step_operation_receipts (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, step_run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, effect_type TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE workflow_workspace_mutation_journal (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, step_run_id TEXT NOT NULL,
      operation_receipt_id TEXT NOT NULL, attempt INTEGER NOT NULL, mission_id TEXT NOT NULL,
      mission_run_id TEXT NOT NULL, teammate_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      tool_id TEXT NOT NULL, permission_resource TEXT NOT NULL, workspace_tag TEXT NOT NULL,
      relative_path TEXT NOT NULL, before_hash TEXT, expected_after_hash TEXT NOT NULL,
      observed_after_hash TEXT, state TEXT NOT NULL, result_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workflow_run_id, step_run_id, attempt, tool_call_id)
    );
    CREATE TABLE workflow_verification_facts (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, step_run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, mission_id TEXT NOT NULL, mission_run_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, command_id TEXT NOT NULL,
      tool_id TEXT NOT NULL, command TEXT NOT NULL, command_hash TEXT NOT NULL,
      exit_status INTEGER NOT NULL, criterion_ids_json TEXT NOT NULL,
      output_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(workflow_run_id, step_run_id, attempt, tool_call_id)
    );
  `);
  return db;
}

function mutation(overrides: Partial<WorkspaceMutationIntent> = {}): WorkspaceMutationIntent {
  return {
    id: 'journal-entry',
    workflowRunId: WORKFLOW,
    stepRunId: STEP,
    operationReceiptId: 'operation',
    attempt: 1,
    missionId: MISSION,
    missionRunId: RUN,
    teammateId: ACTOR,
    toolCallId: CALL,
    toolId: 'file.writeText',
    permissionResource: `file:${WORKSPACE}:src/feature.ts`,
    workspaceTag: WORKSPACE,
    relativePath: 'src/feature.ts',
    beforeHash: null,
    expectedAfterHash: 'b'.repeat(64),
    observedAfterHash: null,
    state: 'PREPARED',
    resultCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function verification(
  overrides: Partial<WorkspaceVerificationFact> = {},
): WorkspaceVerificationFact {
  const command = 'npm run test -- --runInBand';
  return {
    id: CALL,
    workflowRunId: WORKFLOW,
    stepRunId: 'verify-step-run',
    attempt: 1,
    missionId: MISSION,
    missionRunId: RUN,
    actorId: ACTOR,
    toolCallId: CALL,
    commandId: 'test-suite',
    toolId: 'mcp:local-ci:run-command',
    command,
    commandHash: createHash('sha256').update(command, 'utf8').digest('hex'),
    exitStatus: 1,
    criterionIds: ['tests-pass'],
    outputHash: 'c'.repeat(64),
    createdAt: NOW,
    ...overrides,
  };
}

describe('W2.2 Workspace mutation and verification repository', () => {
  it('validates plain-text criterion IDs against durable S06 facts using the shipped SQL trigger', () => {
    const db = database();
    db.exec(`
      CREATE TABLE workflow_step_runs (id TEXT, workflow_run_id TEXT, step_id TEXT, attempt INTEGER,
        state TEXT, mission_id TEXT, mission_run_id TEXT);
      CREATE TABLE workflow_runs (id TEXT, definition_id TEXT, definition_version INTEGER);
      CREATE TABLE workflow_versions (definition_id TEXT, version INTEGER, version_json TEXT);
      CREATE TABLE mission_runs (id TEXT, mission_id TEXT, status TEXT);
      CREATE TABLE missions (id TEXT, coordinator_teammate_id TEXT);
      CREATE TABLE mission_participants (mission_id TEXT, teammate_id TEXT);
      CREATE TABLE mission_events (mission_id TEXT, run_id TEXT, actor_type TEXT, actor_id TEXT, event_type TEXT);
      CREATE TABLE workflow_artifact_bindings (workflow_run_id TEXT, role TEXT, key TEXT, artifact_id TEXT);
      CREATE TABLE workflow_artifacts (id TEXT, kind TEXT, content TEXT, producer_step_run_id TEXT);
      INSERT INTO workflow_runs VALUES ('workflow-run','official.software-feature',1);
      INSERT INTO workflow_versions VALUES ('official.software-feature',1,
        '{"definition":{"source":"BUILTIN"},"validationPolicy":"software-integrity-v1"}');
      INSERT INTO workflow_step_runs VALUES ('verify-step-run','workflow-run','S06',1,'WAITING','mission','mission-run');
      INSERT INTO workflow_step_runs VALUES ('plan-step','workflow-run','S03',1,'COMPLETED',NULL,NULL);
      INSERT INTO mission_runs VALUES ('mission-run','mission','RUNNING');
      INSERT INTO missions VALUES ('mission','teammate');
      INSERT INTO mission_events VALUES ('mission','mission-run','TEAMMATE','teammate','model.call_started');
      INSERT INTO workflow_artifact_bindings VALUES ('workflow-run','OUTPUT','software.plan_scope','plan');
      INSERT INTO workflow_artifact_bindings VALUES ('workflow-run','OUTPUT','software.acceptance','acceptance');
      INSERT INTO workflow_artifacts VALUES ('plan','JSON',
        '{"commands":[{"id":"test-suite","command":"npm run test -- --runInBand","acceptanceCriteriaIds":["tests-pass"]}]}','plan-step');
      INSERT INTO workflow_artifacts VALUES ('acceptance','JSON','{"criteria":[{"id":"tests-pass"}]}','acceptance-step');
    `);
    const migration = readFileSync('migrations/0022_w22_software_feature.sql', 'utf8');
    for (const name of ['validate_insert', 'no_update', 'no_delete']) {
      const trigger = migration.match(
        new RegExp(`CREATE TRIGGER workflow_verification_facts_${name}\\b[\\s\\S]*?END;`),
      );
      expect(trigger).not.toBeNull();
      db.exec(trigger![0]);
    }
    const repository = new W22WorkspaceMutationRepository(db);
    expect(repository.appendVerificationFact(verification())).toEqual(verification());
    expect(() =>
      repository.appendVerificationFact(
        verification({ id: 'bad', toolCallId: 'bad', criterionIds: ['undeclared'] }),
      ),
    ).toThrow('Verification fact must match');
    expect(() =>
      repository.appendVerificationFact(
        verification({ id: 'other-run', toolCallId: 'other-run', missionRunId: 'other-run' }),
      ),
    ).toThrow('Verification fact must match');
    expect(() => db.prepare('UPDATE workflow_verification_facts SET exit_status=0').run()).toThrow(
      'append-only',
    );
    expect(() => db.prepare('DELETE FROM workflow_verification_facts').run()).toThrow('retained');
    db.close();
  });
  it('persists one PREPARED intent and rejects replay under changed content', () => {
    const db = database();
    const repository = new W22WorkspaceMutationRepository(db);
    const intent = mutation();

    expect(repository.prepareMutation(intent)).toEqual({ intent, created: true });
    expect(repository.prepareMutation(intent)).toEqual({ intent, created: false });
    expect(() =>
      repository.prepareMutation(mutation({ expectedAfterHash: 'd'.repeat(64) })),
    ).toThrow('Workspace mutation Tool Call identity changed');
    expect(repository.listRunMutations(WORKFLOW)).toEqual([intent]);
    db.close();
  });

  it('allows a single PREPARED-to-APPLIED or UNKNOWN transition', () => {
    const db = database();
    const repository = new W22WorkspaceMutationRepository(db);
    const intent = mutation();
    repository.prepareMutation(intent);
    const applied = {
      ...intent,
      state: 'APPLIED' as const,
      observedAfterHash: intent.expectedAfterHash,
      resultCode: 'OK',
      updatedAt: '2026-10-03T10:00:01.000Z',
    };

    expect(repository.transitionMutation(applied, 'PREPARED')).toBe(true);
    expect(
      repository.transitionMutation(
        { ...applied, updatedAt: '2026-10-03T10:00:02.000Z' },
        'PREPARED',
      ),
    ).toBe(false);
    expect(repository.listMutations({ workflowRunId: WORKFLOW, stepRunId: STEP })).toEqual([
      applied,
    ]);
    db.close();
  });

  it('stores verification hashes and criteria, never raw command output', () => {
    const db = database();
    const repository = new W22WorkspaceMutationRepository(db);
    const fact = verification();

    expect(repository.appendVerificationFact(fact)).toEqual(fact);
    expect(repository.appendVerificationFact(fact)).toEqual(fact);
    expect(repository.listVerificationFacts(fact.stepRunId)).toEqual([fact]);
    expect(() =>
      repository.appendVerificationFact(verification({ outputHash: 'e'.repeat(64) })),
    ).toThrow('Verification Tool Call is already bound to different evidence');
    const columns = db.prepare('PRAGMA table_info(workflow_verification_facts)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).not.toContain('output');
    db.close();
  });

  it('rejects non-canonical paths and a hash not bound to the exact command', () => {
    const db = database();
    const repository = new W22WorkspaceMutationRepository(db);

    expect(() => repository.prepareMutation(mutation({ relativePath: '../secret.txt' }))).toThrow(
      'Workspace mutation intent is invalid',
    );
    expect(() =>
      repository.appendVerificationFact(verification({ commandHash: 'f'.repeat(64) })),
    ).toThrow('Verification fact is invalid');
    db.close();
  });
});
