import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  WorkflowArtifact,
  WorkflowArtifactSpec,
  WorkflowCheckpoint,
  WorkflowFinalValidation,
  Mission,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowStepRun,
  WorkflowValidationReceipt,
  WorkflowVersion,
  StepOperationReceipt,
} from '@cultivation/domain';
import { migrations, runMigrations, W1WorkflowRepository, W2WorkflowRepository } from './index.js';
import { installOfficialBuiltinWorkflows } from '../../../apps/desktop/src/main/w2-builtin-installation.js';
import {
  AI_NEWS_VIDEO_VERSION_1,
  AI_NEWS_VIDEO_ACCEPTANCE_INPUTS,
} from '../../application/src/builtin/ai-news-video/v1.js';
import { WorkflowService } from '@cultivation/application';
import type {
  WorkflowMissionPort,
  WorkflowMissionSnapshot,
} from '../../application/src/w1-workflow-ports.js';

const NOW = '2026-10-01T00:00:00.000Z';
const HASH = 'a'.repeat(64);

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function outputSpec(kind: 'TEXT' | 'JSON' = 'TEXT', required = true): WorkflowArtifactSpec {
  return kind === 'TEXT'
    ? {
        key: 'result',
        kind,
        required,
        contractId: 'contract.result',
        contractVersion: '1',
        maxSizeBytes: 4096,
        description: 'Result',
        validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
      }
    : {
        key: 'result',
        kind,
        required,
        contractId: 'contract.result',
        contractVersion: '1',
        maxSizeBytes: 4096,
        description: 'Result',
        validator: { type: 'JSON', requiredKeys: [] },
      };
}

function step(id: string, overrides: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition {
  return {
    id,
    type: 'TASK',
    title: id,
    objective: `Do ${id}`,
    routing: {},
    inputs: [],
    outputs: [],
    maxAttempts: 2,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'NONE',
    ...overrides,
  };
}

function version(
  steps: WorkflowStepDefinition[] = [step('work')],
  edges: WorkflowVersion['edges'] = [],
): WorkflowVersion {
  return {
    definition: {
      id: 'workflow-1',
      name: 'Workflow',
      description: '',
      category: 'test',
      source: 'USER',
    },
    version: 1,
    entryStepId: steps[0]!.id,
    steps,
    edges,
    referenceBasis: [],
    createdAt: NOW,
  };
}

function createRun(
  repository: W1WorkflowRepository,
  frozenVersion: WorkflowVersion,
  id = 'workflow-run-1',
  inputSnapshot: WorkflowRun['inputSnapshot'] = {},
): { run: WorkflowRun; steps: WorkflowStepRun[] } {
  repository.publishVersion(frozenVersion);
  const run: WorkflowRun = {
    id,
    definitionId: frozenVersion.definition.id,
    definitionVersion: frozenVersion.version,
    inputSnapshot,
    state: 'DRAFT',
    waitReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  repository.insertRun(run);
  for (const definition of frozenVersion.steps) {
    repository.insertStep({
      id: `${id}:${definition.id}:1`,
      workflowRunId: id,
      stepId: definition.id,
      attempt: 1,
      state: 'PENDING',
      missionId: null,
      missionRunId: null,
      workspaceRoot: null,
      waitReason: null,
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const readyRun = { ...run, state: 'READY' as const, updatedAt: 'ready' };
  expect(repository.saveRun(readyRun, 'DRAFT')).toBe(true);
  const runningRun = { ...readyRun, state: 'RUNNING' as const, updatedAt: 'running' };
  expect(repository.saveRun(runningRun, 'READY')).toBe(true);
  const entry = repository
    .detail(id)!
    .steps.find((item) => item.stepId === frozenVersion.entryStepId)!;
  const readyStep = { ...entry, state: 'READY' as const, updatedAt: 'ready' };
  expect(repository.saveStep(readyStep, 'PENDING')).toBe(true);
  const runningStep = { ...readyStep, state: 'RUNNING' as const, updatedAt: 'running' };
  expect(repository.saveStep(runningStep, 'READY')).toBe(true);
  return { run: repository.detail(id)!.run, steps: repository.detail(id)!.steps };
}

function addMission(
  db: Database.Database,
  id: string,
  options: {
    state?: string;
    runStatus?: string;
    resultText?: string;
    coordinator?: string;
    runId?: string;
    attempt?: number;
  } = {},
): { id: string; runId: string; coordinator: string } {
  const coordinator = options.coordinator ?? 'coordinator-1';
  const runId = options.runId ?? `${id}-run-1`;
  db.prepare(
    `INSERT OR IGNORE INTO teammates (id, name, created_at, updated_at)
    VALUES (?, 'Coordinator', ?, ?)`,
  ).run(coordinator, NOW, NOW);
  db.prepare(
    `INSERT INTO missions
    (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
     mode, state, created_at, updated_at)
    VALUES (?, 'Mission', 'Objective', 'USER', 'user-1', ?, 'SOLO', ?, ?, ?)`,
  ).run(id, coordinator, options.state ?? 'COMPLETED', NOW, NOW);
  db.prepare(
    `INSERT INTO mission_runs
    (id, mission_id, attempt, status, started_at, ended_at, result_text)
    VALUES (?, ?, ?, 'RUNNING', ?, NULL, NULL)`,
  ).run(runId, id, options.attempt ?? 1, NOW);
  const runStatus = options.runStatus ?? 'COMPLETED';
  if (runStatus !== 'RUNNING') {
    db.prepare(
      `UPDATE mission_runs SET status = ?, ended_at = ?, result_text = ? WHERE id = ?`,
    ).run(runStatus, NOW, options.resultText ?? 'result text', runId);
  }
  return { id, runId, coordinator };
}

function bindMission(
  repository: W1WorkflowRepository,
  stepRun: WorkflowStepRun,
  mission: { id: string; runId: string },
  workspaceRoot: string | null = 'E:\\workspace',
): WorkflowStepRun {
  expect(
    repository.saveStep({ ...stepRun, missionId: mission.id, workspaceRoot }, stepRun.state),
  ).toBe(true);
  const bound = repository
    .detail(stepRun.workflowRunId)!
    .steps.find((item) => item.id === stepRun.id)!;
  expect(repository.saveStep({ ...bound, missionRunId: mission.runId }, bound.state)).toBe(true);
  return repository.detail(stepRun.workflowRunId)!.steps.find((item) => item.id === stepRun.id)!;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function jsonHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function artifactHash(content: string, metadata: WorkflowArtifact['metadata']): string {
  return createHash('sha256')
    .update(JSON.stringify(stable({ content, metadata })))
    .digest('hex');
}

function missionArtifact(
  stepRun: WorkflowStepRun,
  mission: { id: string; runId: string; coordinator: string },
  content: string,
  options: {
    id?: string;
    kind?: WorkflowArtifact['kind'];
    metadata?: WorkflowArtifact['metadata'];
    sourceId?: string;
    actorId?: string;
    inputArtifactIds?: string[];
  } = {},
): WorkflowArtifact {
  const metadata = options.metadata ?? {};
  return {
    id: options.id ?? 'artifact-1',
    workflowRunId: stepRun.workflowRunId,
    producerStepRunId: stepRun.id,
    missionId: mission.id,
    missionRunId: mission.runId,
    actorId: options.actorId ?? mission.coordinator,
    sourceId: options.sourceId ?? mission.runId,
    source: 'MISSION',
    kind: options.kind ?? 'TEXT',
    content,
    contentHash: artifactHash(content, metadata),
    metadata,
    inputArtifactIds: options.inputArtifactIds ?? [],
    createdAt: NOW,
  };
}

function checkpoint(
  run: WorkflowRun,
  completedStepRunIds: string[],
  activeStepRunIds: string[] = [],
  sequence = 1,
): WorkflowCheckpoint {
  return {
    id: `checkpoint-${run.id}-${sequence}`,
    workflowRunId: run.id,
    sequence,
    definitionVersion: run.definitionVersion,
    completedStepRunIds,
    activeStepRunIds,
    artifactBindingHashes: [],
    decisionHashes: [],
    stateHash: HASH,
    createdAt: NOW,
  };
}

function persistOutput(
  repository: W1WorkflowRepository,
  stepRun: WorkflowStepRun,
  value: WorkflowArtifact,
  spec: WorkflowArtifactSpec,
): void {
  repository.appendArtifact(value);
  const receipt: WorkflowValidationReceipt = {
    id: `validation-${value.id}`,
    stepRunId: stepRun.id,
    artifactId: value.id,
    contractId: spec.contractId,
    contractVersion: spec.contractVersion,
    validatorVersion: 'w1-inline-validator-v1',
    contentHash: value.contentHash,
    valid: true,
    errors: [],
    createdAt: NOW,
  };
  repository.appendValidation(receipt);
  repository.appendBinding({
    id: `binding-${value.id}`,
    workflowRunId: stepRun.workflowRunId,
    stepRunId: stepRun.id,
    key: spec.key,
    artifactId: value.id,
    role: 'OUTPUT',
    contractId: spec.contractId,
    contractVersion: spec.contractVersion,
    createdAt: NOW,
  });
}

function sqliteMissionPort(
  db: Database.Database,
  repository: W1WorkflowRepository,
  failAfterBinding = false,
): WorkflowMissionPort {
  const missionId = failAfterBinding ? 'mission-rollback' : 'mission-service-run';
  const coordinatorId = 'service-coordinator';
  db.prepare(
    `INSERT INTO teammates (id, name, created_at, updated_at)
    VALUES (?, 'Service Coordinator', ?, ?)`,
  ).run(coordinatorId, NOW, NOW);
  let current: WorkflowMissionSnapshot | null = null;
  return {
    async create(_input, bind) {
      const mission = {
        id: missionId,
        title: 'Service mission',
        objective: 'Complete the Workflow step',
        initiatorType: 'USER',
        initiatorId: 'user-1',
        coordinatorTeammateId: coordinatorId,
        partyId: null,
        mode: 'SOLO',
        state: 'DRAFT',
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      } as unknown as Mission;
      repository.transaction(() => {
        db.prepare(
          `INSERT INTO missions
          (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
           mode, state, created_at, updated_at)
          VALUES (?, ?, ?, 'USER', 'user-1', ?, 'SOLO', 'DRAFT', ?, ?)`,
        ).run(mission.id, mission.title, mission.objective, coordinatorId, NOW, NOW);
        bind(mission);
        if (failAfterBinding) throw new Error('forced callback failure');
      });
      current = { mission, run: null, outputs: [], uncertainSideEffects: false };
      return { status: 'CREATED', mission };
    },
    snapshot() {
      if (!current) throw new Error('Mission has not been created');
      return current;
    },
    async start(id) {
      db.prepare(
        `INSERT INTO mission_runs
        (id, mission_id, attempt, status, started_at, ended_at, result_text)
        VALUES (?, ?, 1, 'RUNNING', ?, NULL, NULL)`,
      ).run(`${id}-run-1`, id, NOW);
      db.prepare(`UPDATE missions SET state = 'RUNNING', updated_at = ? WHERE id = ?`).run(NOW, id);
      db.prepare(
        `UPDATE mission_runs SET status = 'COMPLETED', ended_at = ?, result_text = ? WHERE id = ?`,
      ).run(NOW, 'service result', `${id}-run-1`);
      db.prepare(
        `UPDATE missions SET state = 'COMPLETED', updated_at = ?, completed_at = ? WHERE id = ?`,
      ).run(NOW, NOW, id);
      if (!current) throw new Error('Mission snapshot was not initialized');
      current = {
        ...current,
        mission: { ...current.mission, state: 'COMPLETED', updatedAt: NOW, completedAt: NOW },
        run: {
          id: `${id}-run-1`,
          missionId: id,
          attempt: 1,
          status: 'COMPLETED',
          startedAt: NOW,
          endedAt: NOW,
          errorCode: null,
          errorMessage: null,
          resultText: 'service result',
        } as NonNullable<WorkflowMissionSnapshot['run']>,
      };
    },
    async retry() {},
    cancel() {},
    workspaceIdentity: () => 'E:\\service-workspace',
  };
}

describe('W1 SQLite persistence', () => {
  it('upgrades a version 1 database through migration 20 with foreign keys enabled', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, [migrations[0]!]);
    runMigrations(db, migrations.slice(1));

    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: 32,
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_checkpoints'",
        )
        .get(),
    ).toEqual({ '1': 1 });
    db.close();
  });

  it('keeps legacy completed Runs readable without backfilling final receipts', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations.slice(0, 17));
    const frozenVersion = version();
    db.prepare(
      `INSERT INTO workflow_definitions (id, name, description, category, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      frozenVersion.definition.id,
      frozenVersion.definition.name,
      frozenVersion.definition.description,
      frozenVersion.definition.category,
      frozenVersion.definition.source,
      frozenVersion.createdAt,
    );
    db.prepare(
      `INSERT INTO workflow_versions
        (definition_id, version, entry_step_id, version_json, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      frozenVersion.definition.id,
      frozenVersion.version,
      frozenVersion.entryStepId,
      JSON.stringify(frozenVersion),
      HASH,
      frozenVersion.createdAt,
    );
    db.prepare(
      `INSERT INTO workflow_runs
        (id, definition_id, definition_version, state, created_at, updated_at)
       VALUES ('legacy-completed-run', ?, ?, 'DRAFT', ?, ?)`,
    ).run(frozenVersion.definition.id, frozenVersion.version, NOW, NOW);
    db.prepare("UPDATE workflow_runs SET state = 'READY' WHERE id = 'legacy-completed-run'").run();
    db.prepare(
      "UPDATE workflow_runs SET state = 'RUNNING' WHERE id = 'legacy-completed-run'",
    ).run();
    db.prepare(
      "UPDATE workflow_runs SET state = 'COMPLETED' WHERE id = 'legacy-completed-run'",
    ).run();

    runMigrations(db, migrations.slice(17));

    expect(
      db
        .prepare(
          "SELECT state, input_snapshot_json FROM workflow_runs WHERE id = 'legacy-completed-run'",
        )
        .get(),
    ).toEqual({
      state: 'COMPLETED',
      input_snapshot_json: '{}',
    });
    expect(
      db
        .prepare('SELECT id FROM workflow_run_output_validations WHERE workflow_run_id = ?')
        .all('legacy-completed-run'),
    ).toEqual([]);
    expect(new W1WorkflowRepository(db).listRuns()[0]?.inputSnapshot).toEqual({});
    db.close();
  });

  it('requires a valid exact final binding receipt before completing a Run', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const resultSpec = outputSpec();
    const finalSpec = {
      ...resultSpec,
      key: 'final-result',
      fromStepId: 'work',
      outputKey: resultSpec.key,
    };
    const frozenVersion: WorkflowVersion = {
      ...version([step('work', { outputs: [resultSpec] })]),
      outputSchema: { outputs: [finalSpec] },
    };
    const { run, steps } = createRun(repository, frozenVersion, 'final-validation-run');

    expect(() =>
      repository.saveRun({ ...run, state: 'COMPLETED', updatedAt: 'completed' }, 'RUNNING'),
    ).toThrow();

    const mission = addMission(db, 'mission-final-output', { resultText: 'Final result' });
    const bound = bindMission(repository, steps[0]!, mission);
    const artifact = missionArtifact(bound, mission, 'Final result', {
      metadata: { outputKey: resultSpec.key },
    });
    persistOutput(repository, bound, artifact, resultSpec);
    repository.appendCheckpoint(checkpoint(run, [bound.id]));
    expect(
      repository.saveStep({ ...bound, state: 'COMPLETED', updatedAt: 'completed' }, 'RUNNING'),
    ).toBe(true);

    const receipt: WorkflowFinalValidation = {
      id: 'final-validation-1',
      workflowRunId: run.id,
      definitionVersion: run.definitionVersion,
      inputHash: jsonHash({}),
      stateHash: HASH,
      outputBindings: [
        { key: finalSpec.key, artifactId: artifact.id, contentHash: artifact.contentHash },
      ],
      valid: true,
      errors: [],
      createdAt: NOW,
    };
    expect(() =>
      repository.appendFinalValidation({ ...receipt, inputHash: 'b'.repeat(64) }),
    ).toThrow('inputHash');
    expect(() => repository.appendFinalValidation({ ...receipt, outputBindings: [] })).toThrow();
    expect(() =>
      repository.appendFinalValidation({
        ...receipt,
        outputBindings: [{ ...receipt.outputBindings[0]!, contentHash: 'b'.repeat(64) }],
      }),
    ).toThrow();

    repository.appendFinalValidation(receipt);
    expect(repository.detail(run.id)?.finalValidations).toEqual([receipt]);
    expect(() =>
      db
        .prepare('UPDATE workflow_run_output_validations SET valid = 0 WHERE id = ?')
        .run(receipt.id),
    ).toThrow();
    expect(() =>
      db.prepare('DELETE FROM workflow_run_output_validations WHERE id = ?').run(receipt.id),
    ).toThrow();
    expect(
      repository.saveRun({ ...run, state: 'COMPLETED', updatedAt: 'completed' }, 'RUNNING'),
    ).toBe(true);
    expect(repository.detail(run.id)?.run.state).toBe('COMPLETED');
    db.close();
  });

  it('validates, freezes, and restores the immutable Run input snapshot', () => {
    const path = join(process.cwd(), `.w1-input-snapshot-${crypto.randomUUID()}.sqlite`);
    let db: Database.Database | null = new Database(path);
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, migrations);
      const repository = new W1WorkflowRepository(db);
      const frozenVersion: WorkflowVersion = {
        ...version(),
        inputSchema: {
          type: 'object',
          properties: { topic: { type: 'string', minLength: 1, maxLength: 40 } },
          required: ['topic'],
        },
      };
      repository.publishVersion(frozenVersion);
      const run: WorkflowRun = {
        id: 'snapshot-restart-run',
        definitionId: frozenVersion.definition.id,
        definitionVersion: frozenVersion.version,
        inputSnapshot: { topic: 'frozen input' },
        state: 'DRAFT',
        waitReason: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      repository.insertRun(run);

      expect(repository.detail(run.id)?.run.inputSnapshot).toEqual({ topic: 'frozen input' });
      expect(() =>
        repository.insertRun({ ...run, id: 'missing-required-input', inputSnapshot: {} }),
      ).toThrow();
      expect(() =>
        repository.saveRun({ ...run, inputSnapshot: { topic: 'changed input' } }, 'DRAFT'),
      ).toThrow('input snapshot is immutable');
      expect(() =>
        db
          ?.prepare('UPDATE workflow_runs SET input_snapshot_json = ? WHERE id = ?')
          .run('{"topic":"changed input"}', run.id),
      ).toThrow();

      db.close();
      const reopenedDb = new Database(path);
      db = reopenedDb;
      reopenedDb.pragma('foreign_keys = ON');
      runMigrations(reopenedDb, migrations);
      const restarted = new W1WorkflowRepository(reopenedDb);
      expect(restarted.detail(run.id)?.run.inputSnapshot).toEqual({ topic: 'frozen input' });
      expect(restarted.listRuns()[0]?.inputSnapshot).toEqual({ topic: 'frozen input' });
      expect(() =>
        reopenedDb
          .prepare('UPDATE workflow_runs SET input_snapshot_json = ? WHERE id = ?')
          .run('{"topic":"changed input"}', run.id),
      ).toThrow();
    } finally {
      if (db?.open) db.close();
      if (existsSync(path)) unlinkSync(path);
    }
  }, 30_000);

  it('completes a real WorkflowService execution through the SQLite repository', async () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const missions = sqliteMissionPort(db, repository);
    let sequence = 0;
    const service = new WorkflowService(repository, missions, {
      now: () => NOW,
      id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
    service.publish(version());
    const created = service.createRun({ definitionId: 'workflow-1', version: 1 });

    const completed = await service.advance(created.run.id);

    expect(completed.run.state).toBe('COMPLETED');
    expect(completed.steps).toHaveLength(1);
    expect(completed.steps[0]).toMatchObject({
      state: 'COMPLETED',
      missionId: 'mission-service-run',
      missionRunId: 'mission-service-run-run-1',
      workspaceRoot: 'E:\\service-workspace',
    });
    expect(completed.checkpoints).toHaveLength(1);
    expect(completed.checkpoints[0]?.completedStepRunIds).toEqual([completed.steps[0]?.id]);
    expect(
      db.prepare('SELECT state FROM missions WHERE id = ?').get('mission-service-run'),
    ).toEqual({ state: 'COMPLETED' });
    expect(
      db.prepare('SELECT status FROM mission_runs WHERE id = ?').get('mission-service-run-run-1'),
    ).toEqual({ status: 'COMPLETED' });
    db.close();
  });

  it('rolls Mission creation and Step binding back together when the binding callback fails', async () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const missions = sqliteMissionPort(db, repository, true);
    let sequence = 0;
    const service = new WorkflowService(repository, missions, {
      now: () => NOW,
      id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
    service.publish(version());
    const created = service.createRun({ definitionId: 'workflow-1', version: 1 });

    await expect(service.advance(created.run.id)).rejects.toThrow('forced callback failure');

    const rolledBack = repository.detail(created.run.id)!;
    expect(rolledBack.run.state).toBe('WAITING');
    expect(rolledBack.steps[0]).toMatchObject({
      state: 'WAITING',
      missionId: null,
      missionRunId: null,
    });
    expect(
      db.prepare('SELECT id FROM missions WHERE id = ?').get('mission-rollback'),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM workflow_events WHERE type = 'step.mission_bound'").all(),
    ).toEqual([]);
    db.close();
  });

  it('pins immutable versions and relies on SQLite foreign keys', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const v1 = version();
    createRun(repository, v1, 'pinned-run');
    const finalOutput = outputSpec();
    const v2: WorkflowVersion = {
      ...v1,
      version: 2,
      createdAt: 'version-2',
      definition: {
        ...v1.definition,
        name: 'Version Two',
        description: 'Updated description',
        category: 'updated',
      },
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['topic'],
      },
      outputSchema: {
        outputs: [{ ...finalOutput, key: 'final', fromStepId: 'finish', outputKey: 'result' }],
      },
      entryStepId: 'finish',
      steps: [step('finish', { outputs: [finalOutput] })],
      edges: [],
    };
    repository.publishVersion(v2);
    repository.publishVersion(v1);
    expect(() =>
      repository.publishVersion({ ...v1, definition: { ...v1.definition, name: 'Changed v1' } }),
    ).toThrow('Workflow version is immutable');
    expect(() => repository.publishVersion({ ...v1, inputSchema: v2.inputSchema })).toThrow(
      'Workflow version is immutable',
    );
    expect(() => repository.publishVersion({ ...v1, outputSchema: { outputs: [] } })).toThrow(
      'Workflow version is immutable',
    );
    createRun(repository, v2, 'v2-run', { topic: 'version two input' });

    expect(repository.detail('pinned-run')?.run.definitionVersion).toBe(1);
    expect(repository.detail('pinned-run')?.version).toEqual(v1);
    expect(repository.detail('pinned-run')?.steps.map(({ stepId }) => stepId)).toEqual(['work']);
    expect(repository.detail('v2-run')?.version).toEqual(v2);
    expect(repository.detail('v2-run')?.run.inputSnapshot).toEqual({ topic: 'version two input' });
    expect(
      db
        .prepare(
          'SELECT name, description, category, source FROM workflow_definitions WHERE id = ?',
        )
        .get('workflow-1'),
    ).toEqual({ name: 'Workflow', description: '', category: 'test', source: 'USER' });
    expect(() =>
      db.prepare("UPDATE workflow_runs SET definition_version = 2 WHERE id = 'pinned-run'").run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "UPDATE workflow_versions SET entry_step_id = 'other' WHERE definition_id = 'workflow-1' AND version = 1",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare("DELETE FROM workflow_versions WHERE definition_id = 'workflow-1' AND version = 1")
        .run(),
    ).toThrow();
    expect(() =>
      repository.publishVersion({
        ...v2,
        version: 3,
        definition: { ...v2.definition, source: 'IMPORTED' },
      }),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs
      (id, definition_id, definition_version, state, created_at, updated_at)
      VALUES ('orphan-run', 'missing-definition', 1, 'DRAFT', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow();
    db.close();
  });

  it('supports same-state CAS writes and rejects stale state, Mission rebinding, workspace changes, and Run rollback', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const { run, steps } = createRun(repository, version(), 'binding-run');
    const stepRun = steps[0]!;
    const mission = addMission(db, 'mission-1', { runStatus: 'FAILED', attempt: 1 });
    db.prepare(
      `INSERT INTO mission_runs (id, mission_id, attempt, status, started_at, ended_at, result_text)
      VALUES ('mission-1-run-2', 'mission-1', 2, 'RUNNING', ?, NULL, NULL)`,
    ).run(NOW);
    addMission(db, 'mission-2', { runId: 'mission-2-run-1', attempt: 1 });

    expect(repository.saveRun({ ...run, updatedAt: 'same-run-state' }, 'RUNNING')).toBe(true);
    expect(repository.saveRun({ ...run, state: 'RUNNING', updatedAt: 'stale' }, 'READY')).toBe(
      false,
    );
    expect(repository.saveStep({ ...stepRun, updatedAt: 'same-step-state' }, 'RUNNING')).toBe(true);
    expect(repository.saveStep({ ...stepRun, state: 'RUNNING', updatedAt: 'stale' }, 'READY')).toBe(
      false,
    );

    const bound = bindMission(repository, stepRun, mission, 'E:\\workspace');
    expect(repository.findStepByMissionId(mission.id)?.id).toBe(stepRun.id);
    expect(() => repository.saveStep({ ...bound, missionId: 'mission-2' }, 'RUNNING')).toThrow();
    expect(() =>
      repository.saveStep({ ...bound, workspaceRoot: 'E:\\other' }, 'RUNNING'),
    ).toThrow();
    expect(() => repository.saveStep({ ...bound, missionRunId: null }, 'RUNNING')).toThrow();

    const rebound = { ...bound, missionRunId: 'mission-1-run-2' };
    expect(repository.saveStep(rebound, 'RUNNING')).toBe(true);
    expect(repository.detail(run.id)?.steps[0]?.missionRunId).toBe('mission-1-run-2');

    const second = createRun(repository, version(), 'second-workflow-run');
    expect(() =>
      repository.saveStep({ ...second.steps[0]!, missionId: mission.id }, 'RUNNING'),
    ).toThrow();
    expect(() => repository.saveStep({ ...second.steps[0]!, missionId: '' }, 'RUNNING')).toThrow();
    db.close();
  });

  it('checks Mission result provenance and requires an outputKey declared by the pinned version', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const jsonSpec = { ...outputSpec('JSON'), key: 'payload' };
    const workflowVersion = version([step('work', { outputs: [jsonSpec] })]);
    const { steps } = createRun(repository, workflowVersion, 'provenance-run');
    const stepRun = steps[0]!;
    const mission = addMission(db, 'mission-json', {
      resultText: '{"outputs":{"payload":{"answer":42}}}',
    });
    const bound = bindMission(repository, stepRun, mission);
    const content = '{"answer":42}';

    expect(() =>
      repository.appendArtifact(
        missionArtifact(bound, mission, content, {
          id: 'wrong-key',
          kind: 'JSON',
          metadata: { outputKey: 'undeclared' },
        }),
      ),
    ).toThrow();
    expect(() =>
      repository.appendArtifact(
        missionArtifact(bound, mission, content, {
          id: 'wrong-actor',
          kind: 'JSON',
          metadata: { outputKey: 'payload' },
          actorId: 'forged-coordinator',
        }),
      ),
    ).toThrow();
    expect(() =>
      repository.appendArtifact(
        missionArtifact(bound, mission, content, {
          id: 'wrong-source',
          kind: 'JSON',
          metadata: { outputKey: 'payload' },
          sourceId: 'not-the-run-id',
        }),
      ),
    ).toThrow();

    const accepted = missionArtifact(bound, mission, content, {
      id: 'json-output',
      kind: 'JSON',
      metadata: { outputKey: 'payload' },
    });
    repository.appendArtifact(accepted);
    expect(repository.detail(bound.workflowRunId)?.artifacts[0]?.content).toBe(content);
    db.close();
  });

  it('rolls back nested artifact writes on invalid lineage and only accepts validated declared input lineage', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const firstOutput = { ...outputSpec(), key: 'source' };
    const secondInput = { key: 'input', fromStepId: 'first', outputKey: 'source', required: true };
    const secondOutput = { ...outputSpec(), key: 'derived' };
    const workflowVersion = version(
      [
        step('first', { outputs: [firstOutput] }),
        step('second', { inputs: [secondInput], outputs: [secondOutput] }),
      ],
      [
        {
          id: 'edge-first-second',
          fromStepId: 'first',
          toStepId: 'second',
          branch: 'next',
          condition: { type: 'ALWAYS' },
        },
      ],
    );
    const { run, steps } = createRun(repository, workflowVersion, 'lineage-run');
    const first = steps.find((item) => item.stepId === 'first')!;
    const firstMission = addMission(db, 'mission-first', { resultText: 'source result' });
    const boundFirst = bindMission(repository, first, firstMission);
    const firstArtifact = missionArtifact(boundFirst, firstMission, 'source result', {
      id: 'source-artifact',
    });
    persistOutput(repository, boundFirst, firstArtifact, firstOutput);
    repository.appendCheckpoint(checkpoint(run, [boundFirst.id]));
    expect(
      repository.saveStep({ ...boundFirst, state: 'COMPLETED', updatedAt: 'completed' }, 'RUNNING'),
    ).toBe(true);

    const secondReady = repository.detail(run.id)!.steps.find((item) => item.stepId === 'second')!;
    expect(
      repository.saveStep({ ...secondReady, state: 'READY', updatedAt: 'ready' }, 'PENDING'),
    ).toBe(true);
    const ready = repository.detail(run.id)!.steps.find((item) => item.id === secondReady.id)!;
    expect(repository.saveStep({ ...ready, state: 'RUNNING', updatedAt: 'running' }, 'READY')).toBe(
      true,
    );
    const secondRunning = repository
      .detail(run.id)!
      .steps.find((item) => item.id === secondReady.id)!;
    const secondMission = addMission(db, 'mission-second', { resultText: 'derived result' });
    const boundSecond = bindMission(repository, secondRunning, secondMission);
    repository.appendBinding({
      id: 'input-binding',
      workflowRunId: run.id,
      stepRunId: boundSecond.id,
      key: 'input',
      artifactId: firstArtifact.id,
      role: 'INPUT',
      contractId: firstOutput.contractId,
      contractVersion: firstOutput.contractVersion,
      createdAt: NOW,
    });
    const derived = missionArtifact(boundSecond, secondMission, 'derived result', {
      id: 'derived-artifact',
      inputArtifactIds: [firstArtifact.id],
    });
    repository.appendArtifact(derived);
    expect(
      repository.detail(run.id)?.artifacts.find((item) => item.id === derived.id)?.inputArtifactIds,
    ).toEqual([firstArtifact.id]);

    const invalid = missionArtifact(boundSecond, secondMission, 'derived result', {
      id: 'rolled-back-artifact',
      inputArtifactIds: ['missing-input-artifact'],
    });
    expect(() => repository.appendArtifact(invalid)).toThrow();
    expect(
      db.prepare('SELECT id FROM workflow_artifacts WHERE id = ?').get(invalid.id),
    ).toBeUndefined();
    db.close();
  });

  it('requires required valid bindings, a completed Mission and Run, and a checkpoint before Step completion', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const spec = outputSpec();
    const { run, steps } = createRun(
      repository,
      version([step('work', { outputs: [spec] })]),
      'completion-run',
    );
    const stepRun = steps[0]!;
    const mission = addMission(db, 'mission-completion');
    const bound = bindMission(repository, stepRun, mission);

    expect(() => repository.saveStep({ ...bound, state: 'COMPLETED' }, 'RUNNING')).toThrow();
    const value = missionArtifact(bound, mission, 'result text');
    persistOutput(repository, bound, value, spec);
    expect(() => repository.saveStep({ ...bound, state: 'COMPLETED' }, 'RUNNING')).toThrow();
    repository.appendCheckpoint(checkpoint(run, [bound.id]));
    expect(
      repository.saveStep({ ...bound, state: 'COMPLETED', updatedAt: 'completed' }, 'RUNNING'),
    ).toBe(true);

    const unfinishedDb = database();
    const unfinishedRepo = new W1WorkflowRepository(unfinishedDb);
    const noOutput = createRun(unfinishedRepo, version(), 'unfinished-mission-run');
    const unfinishedMission = addMission(unfinishedDb, 'mission-not-complete', {
      state: 'RUNNING',
    });
    const unfinishedStep = bindMission(unfinishedRepo, noOutput.steps[0]!, unfinishedMission);
    unfinishedRepo.appendCheckpoint(checkpoint(noOutput.run, [unfinishedStep.id]));
    expect(() =>
      unfinishedRepo.saveStep({ ...unfinishedStep, state: 'COMPLETED' }, 'RUNNING'),
    ).toThrow();
    unfinishedDb.close();
    db.close();
  });

  it('requires a declared edge fact and checkpoint for Decision completion, including non-DECISION routing edges', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const workflowVersion = version(
      [step('first'), step('second')],
      [
        {
          id: 'edge-next',
          fromStepId: 'first',
          toStepId: 'second',
          branch: 'next',
          condition: { type: 'ALWAYS' },
        },
      ],
    );
    const { run, steps } = createRun(repository, workflowVersion, 'decision-fact-run');
    const first = steps.find((item) => item.stepId === 'first')!;
    const firstMission = addMission(db, 'decision-fact-mission');
    const boundFirst = bindMission(repository, first, firstMission);
    expect(() =>
      repository.appendDecision({
        id: 'bad-decision',
        workflowRunId: run.id,
        stepRunId: boundFirst.id,
        edgeId: 'missing-edge',
        branch: 'next',
        inputHash: HASH,
        createdAt: NOW,
      }),
    ).toThrow();
    repository.appendDecision({
      id: 'declared-decision',
      workflowRunId: run.id,
      stepRunId: boundFirst.id,
      edgeId: 'edge-next',
      branch: 'next',
      inputHash: HASH,
      createdAt: NOW,
    });
    const second = repository.detail(run.id)!.steps.find((item) => item.stepId === 'second')!;
    expect(repository.saveStep({ ...second, state: 'READY' }, 'PENDING')).toBe(true);
    repository.appendCheckpoint(checkpoint(run, [boundFirst.id], [second.id]));
    expect(repository.saveStep({ ...boundFirst, state: 'COMPLETED' }, 'RUNNING')).toBe(true);
    db.close();
  });

  it('requires a valid structured PASS review receipt before REVIEW_PASS completion', () => {
    const db = database();
    const repository = new W1WorkflowRepository(db);
    const reviewSpec = { ...outputSpec('JSON'), key: 'review' };
    const reviewStep = step('review', {
      type: 'REVIEW',
      outputs: [reviewSpec],
      exitCondition: 'REVIEW_PASS',
    });
    const { run, steps } = createRun(repository, version([reviewStep]), 'review-run');
    const stepRun = steps[0]!;
    const mission = addMission(db, 'mission-review', {
      resultText:
        '{"outputs":{"review":{"verdict":"PASS","findings":[],"evidence":[],"summary":"Good","reviewedArtifactIds":[]}}}',
    });
    const bound = bindMission(repository, stepRun, mission);
    const review =
      '{"verdict":"PASS","findings":[],"evidence":[],"summary":"Good","reviewedArtifactIds":[]}';
    const value = missionArtifact(bound, mission, review, {
      id: 'review-artifact',
      kind: 'JSON',
      metadata: { outputKey: 'review' },
    });
    persistOutput(repository, bound, value, reviewSpec);
    repository.appendCheckpoint(checkpoint(run, [bound.id]));
    expect(repository.saveStep({ ...bound, state: 'COMPLETED' }, 'RUNNING')).toBe(true);
    db.close();
  });
  it('allows a news REVISE only after its declared decision and bounded traversal are durable', () => {
    const db = database();
    try {
      const repository = new W1WorkflowRepository(db);
      const foundation = new W2WorkflowRepository(db);
      installOfficialBuiltinWorkflows(repository, foundation);
      const { run } = createRun(
        repository,
        AI_NEWS_VIDEO_VERSION_1,
        'news-review-run',
        AI_NEWS_VIDEO_ACCEPTANCE_INPUTS.short,
      );
      const pending = repository.detail(run.id)!.steps.find((item) => item.stepId === 'N13')!;
      repository.saveStep({ ...pending, state: 'READY' }, 'PENDING');
      repository.saveStep({ ...pending, state: 'RUNNING' }, 'READY');
      const review = {
        verdict: 'REVISE',
        findings: [],
        evidence: [],
        summary: '重做制作',
        reviewedArtifactIds: [],
        revisionCode: 'ASSEMBLY',
      };
      const outputs = {
        'news.qa_review': review,
        'news.qa_report': { report: 'persisted review fixture' },
      };
      const mission = addMission(db, 'news-review-mission', {
        resultText: JSON.stringify({ outputs }),
      });
      const bound = bindMission(repository, { ...pending, state: 'RUNNING' }, mission);
      const ids: string[] = [];
      for (const spec of AI_NEWS_VIDEO_VERSION_1.steps.find((item) => item.id === 'N13')!.outputs) {
        const value = missionArtifact(
          bound,
          mission,
          JSON.stringify(outputs[spec.key as keyof typeof outputs]),
          { id: spec.key, kind: 'JSON', metadata: { outputKey: spec.key } },
        );
        persistOutput(repository, bound, value, spec);
        ids.push(value.id);
      }
      const operation: StepOperationReceipt = {
        id: 'review-operation',
        workflowRunId: run.id,
        stepRunId: bound.id,
        attempt: 1,
        operationKey: 'news-review-operation',
        effectType: 'NONE',
        state: 'PREPARED',
        inputHash: HASH,
        manifest: [],
        outputArtifactIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      };
      foundation.prepareOperation(operation);
      foundation.transitionOperation({ ...operation, state: 'APPLIED' }, 'PREPARED');
      foundation.transitionOperation(
        { ...operation, state: 'VERIFIED', outputArtifactIds: ids },
        'APPLIED',
      );
      repository.appendCheckpoint(checkpoint(run, [bound.id]));
      expect(() => repository.saveStep({ ...bound, state: 'COMPLETED' }, 'RUNNING')).toThrow(
        /validated outputs/,
      );
      repository.appendDecision({
        id: 'review-decision',
        workflowRunId: run.id,
        stepRunId: bound.id,
        edgeId: 'n13_assembly',
        branch: 'REVISE_ASSEMBLY',
        inputHash: HASH,
        createdAt: NOW,
      });
      expect(() => repository.saveStep({ ...bound, state: 'COMPLETED' }, 'RUNNING')).toThrow(
        /validated outputs/,
      );
      foundation.appendRevisionTraversal({
        id: 'review-traversal',
        workflowRunId: run.id,
        stepRunId: bound.id,
        edgeId: 'n13_assembly',
        groupId: 'news.final_qa_revision',
        traversalIndex: 1,
        reason: 'ASSEMBLY',
        createdAt: NOW,
      });
      expect(repository.saveStep({ ...bound, state: 'COMPLETED' }, 'RUNNING')).toBe(true);
      expect(() =>
        foundation.appendRevisionTraversal({
          id: 'duplicate-traversal',
          workflowRunId: run.id,
          stepRunId: bound.id,
          edgeId: 'n13_assembly',
          groupId: 'news.final_qa_revision',
          traversalIndex: 2,
          reason: 'ASSEMBLY',
          createdAt: NOW,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
