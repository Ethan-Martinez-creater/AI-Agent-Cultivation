import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactContract,
  RevisionTraversal,
  StepOperationReceipt,
  WorkflowRun,
  WorkflowStepDefinition,
  WorkflowStepRun,
  WorkflowVersion,
} from '@cultivation/domain';
import {
  migrations,
  R0SqliteRepository,
  runMigrations,
  W1WorkflowRepository,
  W2WorkflowRepository,
} from './index.js';

const NOW = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-01T00:00:01.000Z';
const LATEST = '2026-10-01T00:00:02.000Z';
const HASH = 'a'.repeat(64);

function database(path = ':memory:'): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function step(
  id: string,
  type: WorkflowStepDefinition['type'] = 'TASK',
  effectType: WorkflowStepDefinition['effectType'] = 'NONE',
): WorkflowStepDefinition {
  return {
    id,
    type,
    title: id,
    objective: `Do ${id}`,
    routing: {},
    inputs: [],
    outputs: [],
    maxAttempts: 2,
    exitCondition: 'VALID_OUTPUTS',
    effectType,
  };
}

function w2Version(
  options: {
    id?: string;
    source?: WorkflowVersion['definition']['source'];
    steps?: WorkflowStepDefinition[];
    edges?: WorkflowVersion['edges'];
    revisionGroups?: WorkflowVersion['revisionGroups'];
  } = {},
): WorkflowVersion {
  const steps = options.steps ?? [step('work')];
  return {
    definition: {
      id: options.id ?? 'workflow-w2',
      name: 'W2 Workflow',
      description: '',
      category: 'test',
      source: options.source ?? 'USER',
    },
    version: 1,
    entryStepId: steps[0]!.id,
    steps,
    edges: options.edges ?? [],
    referenceBasis: [],
    createdAt: NOW,
    contractManifest: [],
    revisionGroups: options.revisionGroups ?? [],
  };
}

function revisionVersion(
  id: string,
  groupId: string,
  groupLimit: number,
  edgeLimit: number,
): WorkflowVersion {
  const reviewStep: WorkflowStepDefinition = {
    ...step('review', 'REVIEW'),
    exitCondition: 'REVIEW_PASS',
    outputs: [
      {
        key: 'review',
        kind: 'JSON',
        required: true,
        contractId: 'contract.review',
        contractVersion: '1',
        maxSizeBytes: 4096,
        description: 'Structured review result',
        validator: { type: 'JSON', requiredKeys: ['verdict'] },
      },
    ],
  };
  return w2Version({
    id,
    steps: [reviewStep, step('fix')],
    edges: [
      {
        id: 'revise',
        fromStepId: 'review',
        toStepId: 'fix',
        branch: 'REVISE',
        condition: { type: 'REVIEW_VERDICT', verdict: 'REVISE' },
        revision: { groupId, maxTraversals: edgeLimit },
      },
      {
        id: 'continue',
        fromStepId: 'review',
        toStepId: null,
        branch: 'PASS',
        condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
      },
      {
        id: 'fix-review',
        fromStepId: 'fix',
        toStepId: 'review',
        branch: 'review-again',
        condition: { type: 'ALWAYS' },
      },
    ],
    revisionGroups: [{ id: groupId, maxTotalTraversals: groupLimit, onExhausted: 'FAILED' }],
  });
}

function createRun(
  db: Database.Database,
  version: WorkflowVersion,
  runId = `${version.definition.id}-run`,
) {
  const workflow = new W1WorkflowRepository(db);
  workflow.publishVersion(version);
  const run: WorkflowRun = {
    id: runId,
    definitionId: version.definition.id,
    definitionVersion: version.version,
    inputSnapshot: {},
    state: 'DRAFT',
    waitReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  workflow.insertRun(run);
  const readyRun = { ...run, state: 'READY' as const, updatedAt: LATER };
  expect(workflow.saveRun(readyRun, 'DRAFT')).toBe(true);
  const runningRun = { ...readyRun, state: 'RUNNING' as const, updatedAt: LATEST };
  expect(workflow.saveRun(runningRun, 'READY')).toBe(true);
  return { workflow, w2: new W2WorkflowRepository(db), run: runningRun };
}

function insertRunningStep(
  workflow: W1WorkflowRepository,
  workflowRunId: string,
  stepId: string,
  attempt = 1,
): WorkflowStepRun {
  const pending: WorkflowStepRun = {
    id: `${workflowRunId}:${stepId}:${attempt}`,
    workflowRunId,
    stepId,
    attempt,
    state: 'PENDING',
    missionId: null,
    missionRunId: null,
    workspaceRoot: null,
    waitReason: null,
    errorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  workflow.insertStep(pending);
  const ready = { ...pending, state: 'READY' as const, updatedAt: LATER };
  expect(workflow.saveStep(ready, 'PENDING')).toBe(true);
  const running = { ...ready, state: 'RUNNING' as const, updatedAt: LATEST };
  expect(workflow.saveStep(running, 'READY')).toBe(true);
  return running;
}

function appendDecision(
  workflow: W1WorkflowRepository,
  workflowRunId: string,
  stepRunId: string,
  id: string,
): void {
  workflow.appendDecision({
    id,
    workflowRunId,
    stepRunId,
    edgeId: 'revise',
    branch: 'REVISE',
    inputHash: HASH,
    createdAt: NOW,
  });
}

function acceptedExternalActionReference(
  db: Database.Database,
  workflow: W1WorkflowRepository,
  stepRun: WorkflowStepRun,
): string {
  const coordinatorId = 'coordinator-external-operation';
  const bridgeId = 'bridge-external-operation';
  const missionId = 'mission-external-operation';
  const missionRunId = 'mission-run-external-operation';
  const requestId = 'accepted-external-operation';
  const artifactId = 'accepted-external-operation-file';
  db.prepare(
    `INSERT INTO teammates (id, name, created_at, updated_at)
     VALUES (?, 'Coordinator', ?, ?)`,
  ).run(coordinatorId, NOW, NOW);
  db.prepare(
    `INSERT INTO teammates
       (id, name, executor_kind, routing_policy, system_kind, created_at, updated_at)
     VALUES (?, 'Human Bridge', 'USER_BRIDGE', 'FALLBACK_ONLY', 'HUMAN_BRIDGE', ?, ?)`,
  ).run(bridgeId, NOW, NOW);
  db.prepare(
    `INSERT INTO missions
       (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
        mode, state, created_at, updated_at)
     VALUES (?, 'Mission', 'External operation', 'USER', 'user-1', ?, 'SOLO',
       'WAITING_EXTERNAL_WORK', ?, ?)`,
  ).run(missionId, coordinatorId, NOW, NOW);
  db.prepare(
    `INSERT INTO mission_participants (mission_id, teammate_id, role)
     VALUES (?, ?, 'COORDINATOR')`,
  ).run(missionId, coordinatorId);
  db.prepare(
    `INSERT INTO mission_runs (id, mission_id, attempt, status, started_at)
     VALUES (?, ?, 1, 'RUNNING', ?)`,
  ).run(missionRunId, missionId, NOW);
  expect(
    workflow.saveStep({ ...stepRun, missionId, missionRunId, updatedAt: NOW }, 'RUNNING'),
  ).toBe(true);

  const external = new R0SqliteRepository(db);
  external.saveHumanBridgeCapability({
    teammateId: bridgeId,
    dimension: 'IMAGE_GENERATION',
    enabled: true,
    updatedAt: NOW,
  });
  external.createExternalWorkRequest({
    id: requestId,
    missionId,
    runId: missionRunId,
    requesterTeammateId: coordinatorId,
    assigneeTeammateId: bridgeId,
    capability: 'IMAGE_GENERATION',
    title: 'Create an external artifact',
    prompt: 'Create a file for this operation.',
    requirementsJson: { items: ['PNG file'] },
    targetArtifactsJson: {
      items: [
        {
          id: 'result',
          name: 'Result',
          required: true,
          allowedExtensions: ['png'],
          maxSizeBytes: 4096,
        },
      ],
    },
    targetWorkspacePathsJson: { items: ['workspace/output'] },
    acceptanceCriteriaJson: { items: ['File is present'] },
    externalAppProfileId: null,
    publicResult: null,
    state: 'PENDING',
    createdAt: NOW,
    submittedAt: null,
    resolvedAt: null,
  });
  expect(external.transitionExternalWorkRequest(requestId, 'IN_PROGRESS', LATER)?.state).toBe(
    'IN_PROGRESS',
  );
  expect(external.transitionExternalWorkRequest(requestId, 'SUBMITTED', LATEST)?.state).toBe(
    'SUBMITTED',
  );
  external.appendExternalWorkArtifact({
    id: artifactId,
    externalWorkRequestId: requestId,
    path: 'workspace/output/result.png',
    fileName: 'result.png',
    extension: 'png',
    sizeBytes: 1024,
    mimeType: 'image/png',
    metadataJson: {},
    submittedAt: LATEST,
  });
  expect(
    external.transitionExternalWorkRequest(requestId, 'ACCEPTED', LATEST, 'Accepted result')?.state,
  ).toBe('ACCEPTED');
  return requestId;
}

function traversal(
  workflowRunId: string,
  stepRunId: string,
  traversalIndex: number,
  id = `traversal-${traversalIndex}`,
): RevisionTraversal {
  return {
    id,
    workflowRunId,
    stepRunId,
    edgeId: 'revise',
    groupId: 'revision',
    traversalIndex,
    reason: 'REVISE',
    createdAt: NOW,
  };
}

const textContract: ArtifactContract = {
  contractId: 'contract.summary',
  contractVersion: '1',
  kind: 'TEXT',
  validatorVersion: 'w2-deterministic-v1',
  maxSizeBytes: 4096,
  validator: { type: 'TEXT_RULES', minLength: 1, requiredSections: [] },
};

describe('W2 workflow persistence', () => {
  it('registers immutable contracts and requires frozen version manifest references', () => {
    const db = database();
    try {
      const w2 = new W2WorkflowRepository(db);
      const registeredContract = w2.registerContract(textContract, NOW);
      expect(registeredContract).toEqual(textContract);
      expect(w2.getContract(textContract.contractId, textContract.contractVersion)).toEqual(
        textContract,
      );
      expect(w2.listContracts()).toEqual([textContract]);
      expect(() => w2.registerContract({ ...textContract, maxSizeBytes: 8192 }, NOW)).toThrow(
        /immutable/i,
      );
      expect(() =>
        db
          .prepare(
            `UPDATE workflow_artifact_contract_registry SET contract_json = '{}'
           WHERE contract_id = ? AND contract_version = ?`,
          )
          .run(textContract.contractId, textContract.contractVersion),
      ).toThrow(/immutable/i);

      const versionJson = JSON.stringify({
        definition: { id: 'workflow-contract-manifest', source: 'USER' },
        contractManifest: [registeredContract],
      });
      db.prepare(
        `INSERT INTO workflow_definitions (id, name, description, category, source, created_at)
         VALUES ('workflow-contract-manifest', 'Manifest', '', 'test', 'USER', ?)`,
      ).run(NOW);
      const insertVersion = () =>
        db
          .prepare(
            `INSERT INTO workflow_versions
            (definition_id, version, entry_step_id, version_json, content_hash, created_at)
           VALUES ('workflow-contract-manifest', 1, 'entry', ?, ?, ?)`,
          )
          .run(versionJson, HASH, NOW);
      expect(() => insertVersion()).not.toThrow();
      expect(() =>
        db
          .prepare(
            `UPDATE workflow_versions SET version_json = '{}'
           WHERE definition_id = 'workflow-contract-manifest' AND version = 1`,
          )
          .run(),
      ).toThrow(/immutable/i);
      expect(() =>
        db
          .prepare(
            `DELETE FROM workflow_artifact_contract_registry
           WHERE contract_id = ? AND contract_version = ?`,
          )
          .run(textContract.contractId, textContract.contractVersion),
      ).toThrow(/retained/i);
    } finally {
      db.close();
    }
  });

  it('counts only committed revision choices and enforces edge and group budgets', () => {
    const db = database();
    try {
      const version = revisionVersion('workflow-revision-group', 'revision', 1, 1);
      const { workflow, w2, run } = createRun(db, version);
      const first = insertRunningStep(workflow, run.id, 'review', 1);
      expect(() =>
        workflow.transaction(() => {
          appendDecision(workflow, run.id, first.id, 'decision-rolled-back');
          w2.appendRevisionTraversal(traversal(run.id, first.id, 1));
          throw new Error('rollback selected edge');
        }),
      ).toThrow(/rollback selected edge/);
      expect(w2.listTraversals(run.id)).toEqual([]);
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM workflow_decisions WHERE workflow_run_id = ?')
          .get(run.id),
      ).toEqual({ count: 0 });

      appendDecision(workflow, run.id, first.id, 'decision-1');
      w2.appendRevisionTraversal(traversal(run.id, first.id, 1));
      expect(w2.listTraversals(run.id)).toHaveLength(1);
      expect(() =>
        w2.appendRevisionTraversal({ ...traversal(run.id, first.id, 2), id: 'duplicate-step' }),
      ).toThrow();

      const second = insertRunningStep(workflow, run.id, 'review', 2);
      appendDecision(workflow, run.id, second.id, 'decision-2');
      expect(() => w2.appendRevisionTraversal(traversal(run.id, second.id, 2))).toThrow(/budget/i);
      expect(w2.listTraversals(run.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('enforces the per-edge limit even when the containing group has capacity', () => {
    const db = database();
    try {
      const version = revisionVersion('workflow-revision-edge', 'revision', 3, 1);
      const { workflow, w2, run } = createRun(db, version);
      const first = insertRunningStep(workflow, run.id, 'review', 1);
      appendDecision(workflow, run.id, first.id, 'edge-decision-1');
      w2.appendRevisionTraversal(traversal(run.id, first.id, 1));
      const second = insertRunningStep(workflow, run.id, 'review', 2);
      appendDecision(workflow, run.id, second.id, 'edge-decision-2');
      expect(() => w2.appendRevisionTraversal(traversal(run.id, second.id, 2))).toThrow(/budget/i);
      expect(w2.listTraversals(run.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('uses operation receipt CAS, appends snapshots, and prevents terminal replay', () => {
    const db = database();
    try {
      const version = w2Version({
        id: 'workflow-operation-cas',
        steps: [step('publish', 'TASK', 'EXTERNAL_ACTION')],
      });
      const { workflow, w2, run } = createRun(db, version);
      const stepRun = insertRunningStep(workflow, run.id, 'publish');
      const acceptedReference = acceptedExternalActionReference(db, workflow, stepRun);
      const prepared: StepOperationReceipt = {
        id: 'operation-1',
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        attempt: 1,
        operationKey: 'publish:v1',
        effectType: 'EXTERNAL_ACTION',
        state: 'PREPARED',
        inputHash: HASH,
        createdAt: NOW,
        updatedAt: NOW,
      };
      expect(w2.prepareOperation(prepared)).toEqual(prepared);
      expect(w2.prepareOperation(prepared)).toEqual(prepared);
      expect(() =>
        w2.prepareOperation({ ...prepared, id: 'operation-conflict', inputHash: 'b'.repeat(64) }),
      ).toThrow(/different receipt/i);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM workflow_step_operation_audit').get(),
      ).toEqual({ count: 1 });

      const forgedApplied: StepOperationReceipt = {
        ...prepared,
        state: 'APPLIED',
        externalReference: 'provider-action-42',
        updatedAt: LATER,
      };
      expect(() => w2.transitionOperation(forgedApplied, 'PREPARED')).toThrow(/evidence/i);
      const applied: StepOperationReceipt = {
        ...forgedApplied,
        externalReference: acceptedReference,
        updatedAt: LATER,
      };
      expect(w2.transitionOperation(applied, 'PREPARED')).toBe(true);
      expect(w2.transitionOperation(applied, 'PREPARED')).toBe(false);
      const verified: StepOperationReceipt = { ...applied, state: 'VERIFIED', updatedAt: LATEST };
      expect(() =>
        w2.transitionOperation(
          { ...verified, externalReference: 'rewritten-reference' },
          'APPLIED',
        ),
      ).toThrow(/evidence/i);
      expect(w2.transitionOperation(verified, 'APPLIED')).toBe(true);
      expect(w2.listOperations(run.id)).toEqual([verified]);
      expect(() => w2.transitionOperation(applied, 'VERIFIED')).toThrow(/terminal/i);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM workflow_step_operation_audit').get(),
      ).toEqual({ count: 3 });
      expect(() =>
        db
          .prepare(
            `UPDATE workflow_step_operation_receipts SET operation_key = 'replayed'
           WHERE id = 'operation-1'`,
          )
          .run(),
      ).toThrow(/immutable/i);
    } finally {
      db.close();
    }
  });

  it('requires FILE_OUTPUT manifests to match frozen paths and defers output IDs until verification', () => {
    const db = database();
    try {
      const fileStep: WorkflowStepDefinition = {
        ...step('render', 'TASK', 'FILE_OUTPUT'),
        effectPaths: ['dist/render.png'],
      };
      const version = w2Version({ id: 'workflow-file-output', steps: [fileStep] });
      const { workflow, w2, run } = createRun(db, version);
      const stepRun = insertRunningStep(workflow, run.id, 'render');
      const prepared: StepOperationReceipt = {
        id: 'file-output-operation',
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        attempt: stepRun.attempt,
        operationKey: 'render:attempt-1',
        effectType: 'FILE_OUTPUT',
        state: 'PREPARED',
        inputHash: HASH,
        manifest: [{ relativePath: 'other/render.png' }],
        createdAt: NOW,
        updatedAt: NOW,
      };
      expect(() => w2.prepareOperation(prepared)).toThrow(/manifest/i);

      const exactPrepared = {
        ...prepared,
        manifest: [{ relativePath: 'dist/render.png' }],
      };
      expect(w2.prepareOperation(exactPrepared)).toMatchObject(exactPrepared);
      const applied: StepOperationReceipt = {
        ...exactPrepared,
        state: 'APPLIED',
        manifest: [{ relativePath: 'dist/render.png', afterHash: 'b'.repeat(64) }],
        updatedAt: LATER,
      };
      expect(w2.transitionOperation(applied, 'PREPARED')).toBe(true);
      expect(() =>
        w2.transitionOperation(
          {
            ...applied,
            state: 'VERIFIED',
            outputArtifactIds: ['missing-file-output'],
            updatedAt: LATEST,
          },
          'APPLIED',
        ),
      ).toThrow(/transition|evidence|validation/i);
      expect(w2.listOperations(run.id)).toEqual([applied]);
    } finally {
      db.close();
    }
  });

  it('preserves a WORKSPACE_MUTATION before hash and manifest through APPLIED and VERIFIED', () => {
    const db = database();
    try {
      const workspaceStep: WorkflowStepDefinition = {
        ...step('fix', 'TASK', 'WORKSPACE_MUTATION'),
        effectPaths: ['src/main.ts'],
      };
      const version = w2Version({ id: 'workflow-workspace-mutation', steps: [workspaceStep] });
      const { workflow, w2, run } = createRun(db, version);
      const stepRun = insertRunningStep(workflow, run.id, 'fix');
      const prepared: StepOperationReceipt = {
        id: 'workspace-operation',
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        attempt: stepRun.attempt,
        operationKey: 'fix:attempt-1',
        effectType: 'WORKSPACE_MUTATION',
        state: 'PREPARED',
        inputHash: HASH,
        manifest: [{ relativePath: 'src/main.ts', beforeHash: HASH }],
        createdAt: NOW,
        updatedAt: NOW,
      };
      expect(w2.prepareOperation(prepared)).toEqual(prepared);
      const changedBaseline: StepOperationReceipt = {
        ...prepared,
        state: 'APPLIED',
        manifest: [
          { relativePath: 'src/main.ts', beforeHash: 'b'.repeat(64), afterHash: 'c'.repeat(64) },
        ],
        updatedAt: LATER,
      };
      expect(() => w2.transitionOperation(changedBaseline, 'PREPARED')).toThrow(/evidence/i);

      const applied: StepOperationReceipt = {
        ...prepared,
        state: 'APPLIED',
        manifest: [{ relativePath: 'src/main.ts', beforeHash: HASH, afterHash: 'c'.repeat(64) }],
        updatedAt: LATER,
      };
      expect(w2.transitionOperation(applied, 'PREPARED')).toBe(true);
      expect(() =>
        w2.transitionOperation(
          {
            ...applied,
            state: 'VERIFIED',
            manifest: [
              { relativePath: 'src/main.ts', beforeHash: HASH, afterHash: 'd'.repeat(64) },
            ],
            updatedAt: LATEST,
          },
          'APPLIED',
        ),
      ).toThrow(/evidence/i);
      const verified: StepOperationReceipt = { ...applied, state: 'VERIFIED', updatedAt: LATEST };
      expect(w2.transitionOperation(verified, 'APPLIED')).toBe(true);
      expect(w2.listOperations(run.id)).toEqual([verified]);
    } finally {
      db.close();
    }
  });

  it('requires VERIFIED operation receipts before a W2 StepRun can complete', () => {
    const db = database();
    try {
      const version = w2Version({ id: 'workflow-operation-completion', steps: [step('work')] });
      const { workflow, w2, run } = createRun(db, version);
      const stepRun = insertRunningStep(workflow, run.id, 'work');
      const missionId = 'mission-operation-completion';
      const missionRunId = 'mission-operation-completion-run';
      db.prepare(
        `INSERT INTO teammates (id, name, created_at, updated_at) VALUES (?, 'Coordinator', ?, ?)`,
      ).run('coordinator-operation-completion', NOW, NOW);
      db.prepare(
        `INSERT INTO missions
          (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
           mode, state, created_at, updated_at)
         VALUES (?, 'Mission', 'Objective', 'USER', 'user-1', ?, 'SOLO', 'COMPLETED', ?, ?)`,
      ).run(missionId, 'coordinator-operation-completion', NOW, NOW);
      db.prepare(
        `INSERT INTO mission_runs
          (id, mission_id, attempt, status, started_at)
         VALUES (?, ?, 1, 'RUNNING', ?)`,
      ).run(missionRunId, missionId, NOW);
      db.prepare(
        `UPDATE mission_runs SET status = 'COMPLETED', ended_at = ?, result_text = 'done'
         WHERE id = ?`,
      ).run(LATER, missionRunId);
      const bound = {
        ...stepRun,
        missionId,
        missionRunId,
        updatedAt: NOW,
      };
      expect(workflow.saveStep(bound, 'RUNNING')).toBe(true);
      workflow.appendCheckpoint({
        id: 'checkpoint-operation-completion',
        workflowRunId: run.id,
        sequence: 1,
        definitionVersion: version.version,
        completedStepRunIds: [stepRun.id],
        activeStepRunIds: [],
        artifactBindingHashes: [],
        decisionHashes: [],
        stateHash: HASH,
        createdAt: NOW,
      });
      const completed = { ...bound, state: 'COMPLETED' as const, updatedAt: LATER };
      expect(() => workflow.saveStep(completed, 'RUNNING')).toThrow(/verified operation receipts/i);

      const prepared: StepOperationReceipt = {
        id: 'operation-completion',
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        attempt: stepRun.attempt,
        operationKey: 'work:attempt-1',
        effectType: 'NONE',
        state: 'PREPARED',
        manifest: [],
        inputHash: HASH,
        createdAt: NOW,
        updatedAt: NOW,
      };
      w2.prepareOperation(prepared);
      expect(w2.listOperations(run.id)[0]?.manifest).toEqual([]);
      const applied: StepOperationReceipt = { ...prepared, state: 'APPLIED', updatedAt: LATER };
      expect(w2.transitionOperation(applied, 'PREPARED')).toBe(true);
      const verified: StepOperationReceipt = { ...applied, state: 'VERIFIED', updatedAt: LATEST };
      expect(() =>
        workflow.transaction(() => {
          expect(w2.transitionOperation(verified, 'APPLIED')).toBe(true);
          expect(workflow.saveStep(completed, 'RUNNING')).toBe(true);
          throw new Error('rollback completion bundle');
        }),
      ).toThrow(/rollback completion bundle/);
      expect(w2.listOperations(run.id)).toEqual([applied]);
      expect(
        db.prepare('SELECT state FROM workflow_step_runs WHERE id = ?').get(stepRun.id),
      ).toEqual({ state: 'RUNNING' });
      workflow.transaction(() => {
        expect(w2.transitionOperation(verified, 'APPLIED')).toBe(true);
        expect(workflow.saveStep(completed, 'RUNNING')).toBe(true);
      });
      expect(w2.listOperations(run.id)).toEqual([verified]);
    } finally {
      db.close();
    }
  });

  it('persists contracts, revision traversals, and receipt state across a database restart', () => {
    const dbPath = join(process.cwd(), '.tmp', 'runtime-temp', `w2-restart-${randomUUID()}.sqlite`);
    let db: Database.Database | null = null;
    try {
      db = database(dbPath);
      const version = revisionVersion('workflow-restart', 'revision', 3, 3);
      const { workflow, w2, run } = createRun(db, version, 'workflow-restart-run');
      const stepRun = insertRunningStep(workflow, run.id, 'review');
      appendDecision(workflow, run.id, stepRun.id, 'restart-decision');
      const fact = traversal(run.id, stepRun.id, 1, 'restart-traversal');
      w2.appendRevisionTraversal(fact);
      w2.registerContract(textContract, NOW);
      const prepared: StepOperationReceipt = {
        id: 'restart-operation',
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        attempt: 1,
        operationKey: 'review:attempt-1',
        effectType: 'NONE',
        state: 'PREPARED',
        inputHash: HASH,
        createdAt: NOW,
        updatedAt: NOW,
      };
      w2.prepareOperation(prepared);
      const applied: StepOperationReceipt = { ...prepared, state: 'APPLIED', updatedAt: LATER };
      w2.transitionOperation(applied, 'PREPARED');
      const verified: StepOperationReceipt = { ...applied, state: 'VERIFIED', updatedAt: LATEST };
      w2.transitionOperation(verified, 'APPLIED');
      db.close();
      db = null;

      db = database(dbPath);
      const resumed = new W2WorkflowRepository(db);
      expect(resumed.getContract(textContract.contractId, textContract.contractVersion)).toEqual(
        textContract,
      );
      expect(resumed.listTraversals(run.id)).toEqual([fact]);
      expect(resumed.listOperations(run.id)).toEqual([verified]);
    } finally {
      db?.close();
    }
  }, 60_000);

  it('blocks BUILTIN source spoofing without a matching trusted release fact', () => {
    const db = database();
    try {
      const w2 = new W2WorkflowRepository(db);
      const insertDefinition = (id: string, source: 'BUILTIN' | 'USER') =>
        db
          .prepare(
            `INSERT INTO workflow_definitions
            (id, name, description, category, source, created_at)
           VALUES (?, 'Workflow', '', 'test', ?, ?)`,
          )
          .run(id, source, NOW);
      const insertVersion = (id: string, source: 'BUILTIN' | 'USER') => {
        const versionJson = JSON.stringify({
          definition: { id, source },
          contractManifest: [],
          releaseMetadata: { manifestHash: HASH },
        });
        return db
          .prepare(
            `INSERT INTO workflow_versions
              (definition_id, version, entry_step_id, version_json, content_hash, created_at)
             VALUES (?, 1, 'entry', ?, ?, ?)`,
          )
          .run(id, versionJson, HASH, NOW);
      };
      insertDefinition('workflow-builtin-spoof', 'BUILTIN');
      expect(() => insertVersion('workflow-builtin-spoof', 'BUILTIN')).toThrow(/release metadata/i);
      w2.registerRelease({
        definitionId: 'workflow-builtin-spoof',
        version: 1,
        manifestHash: HASH,
        releasedAt: NOW,
      });
      expect(() => insertVersion('workflow-builtin-spoof', 'BUILTIN')).not.toThrow();

      insertDefinition('workflow-user-spoof', 'USER');
      expect(() => insertVersion('workflow-user-spoof', 'USER')).toThrow(/release metadata/i);
    } finally {
      db.close();
    }
  });
});
