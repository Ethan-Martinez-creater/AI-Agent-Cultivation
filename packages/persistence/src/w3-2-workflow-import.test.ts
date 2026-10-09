import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_IMPORT_POLICY_VERSION,
  workflowImportMappingHash,
  workflowImportSourceMetadataHash,
  type WorkflowImportArtifactMapping,
  type WorkflowImportProposal,
  type WorkflowImportSource,
  type WorkflowStepDefinition,
  type WorkflowVersion,
} from '@cultivation/domain';
import {
  migrations,
  runMigrations,
  W1WorkflowRepository,
  W32WorkflowImportRepository,
} from './index.js';

const NOW = '2026-10-09T00:00:00.000Z';

function output(key: string) {
  return {
    key,
    kind: 'TEXT' as const,
    required: true,
    contractId: `contract.${key}`,
    contractVersion: '1',
    maxSizeBytes: 4096,
    description: key,
    validator: { type: 'TEXT' as const, minLength: 1, requiredSections: [] },
  };
}

function task(
  id: string,
  inputs: WorkflowStepDefinition['inputs'] = [],
  outputKeys = [id],
): WorkflowStepDefinition {
  return {
    id,
    type: 'TASK',
    title: id,
    objective: `Complete ${id}`,
    routing: {},
    inputs,
    outputs: outputKeys.map(output),
    maxAttempts: 2,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'NONE',
  };
}

function version(withRequiredInputs = false): WorkflowVersion {
  const steps = withRequiredInputs
    ? [
        task('a', [], ['data', 'other']),
        task(
          'b',
          [{ key: 'input', fromStepId: 'a', outputKey: 'data', required: true }],
          ['b', 'otherb'],
        ),
        task('c', [{ key: 'input', fromStepId: 'b', outputKey: 'b', required: true }]),
        task('d'),
      ]
    : [task('a'), task('b'), task('c'), task('d')];
  return {
    definition: {
      id: withRequiredInputs ? 'import-input-guard' : 'import-graph-guard',
      name: 'Import Guard Test',
      description: '',
      category: 'test',
      source: 'USER',
    },
    version: 1,
    entryStepId: 'a',
    steps,
    edges: ['a', 'b', 'c', 'd'].map((fromStepId, index) => ({
      id: `${fromStepId}-next`,
      fromStepId,
      toStepId: ['b', 'c', 'd', null][index]!,
      branch: 'NEXT',
      condition: { type: 'ALWAYS' as const },
    })),
    referenceBasis: [],
    createdAt: NOW,
  };
}

function source(id: string, name: string): WorkflowImportSource {
  const content = `Imported text for ${id}`;
  return {
    id,
    name,
    relativePath: name,
    workspaceRoot: 'E:\\import-fixture',
    kind: 'TEXT',
    size: Buffer.byteLength(content),
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    mtime: 1,
  };
}

function freshRun(
  db: Database.Database,
  frozen: WorkflowVersion,
  runId: string,
): { repository: W1WorkflowRepository; imports: W32WorkflowImportRepository; versionHash: string } {
  const repository = new W1WorkflowRepository(db);
  const imports = new W32WorkflowImportRepository(db);
  repository.publishVersion(frozen);
  const run = {
    id: runId,
    definitionId: frozen.definition.id,
    definitionVersion: frozen.version,
    inputSnapshot: {},
    state: 'DRAFT' as const,
    waitReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  repository.insertRun(run);
  for (const definition of frozen.steps)
    repository.insertStep({
      id: `${runId}:${definition.id}:1`,
      workflowRunId: runId,
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
  expect(repository.saveRun({ ...run, state: 'READY', updatedAt: 'ready' }, 'DRAFT')).toBe(true);
  const entry = repository
    .detail(runId)!
    .steps.find((stepRun) => stepRun.stepId === frozen.entryStepId)!;
  expect(repository.saveStep({ ...entry, state: 'READY', updatedAt: 'ready' }, 'PENDING')).toBe(
    true,
  );
  const versionRow = db
    .prepare('SELECT content_hash FROM workflow_versions WHERE definition_id = ? AND version = ?')
    .get(frozen.definition.id, frozen.version) as { content_hash: string };
  return { repository, imports, versionHash: versionRow.content_hash };
}

function proposal(
  id: string,
  frozen: WorkflowVersion,
  versionHash: string,
  sources: WorkflowImportSource[],
  mappings: WorkflowImportArtifactMapping[],
): WorkflowImportProposal {
  return {
    id,
    revision: 1,
    status: 'VALIDATED',
    definitionId: frozen.definition.id,
    version: frozen.version,
    versionHash,
    inputSnapshot: {},
    description: 'Confirmed import fixture',
    sources,
    resolution: {
      suggestedCompletedSteps: mappings.map((mapping) => mapping.stepId),
      suggestedCurrentStep: 'd',
      candidateArtifactBindings: mappings,
      missingRequirements: [],
      confidence: 1,
      explanationSummary: 'Fixture proposal',
    },
    sourceMetadataHash: workflowImportSourceMetadataHash(sources),
    policyVersion: WORKFLOW_IMPORT_POLICY_VERSION,
    validationStatus: 'VALID',
    validationErrors: [],
    createdAt: NOW,
    updatedAt: NOW,
    runId: null,
  };
}

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function appendConfirmation(
  imports: W32WorkflowImportRepository,
  proposalId: string,
  runId: string,
  versionHash: string,
  sources: WorkflowImportSource[],
  completedStepIds: string[],
  currentStepId: string,
  bindings: WorkflowImportArtifactMapping[],
): void {
  imports.appendConfirmation({
    id: `confirmation-${proposalId}`,
    proposalId,
    runId,
    versionHash,
    sourceMetadataHash: workflowImportSourceMetadataHash(sources),
    completedStepIds,
    currentStepId,
    bindings,
    mappingHash: workflowImportMappingHash(completedStepIds, currentStepId, bindings),
    createdAt: NOW,
  });
}

describe('W3.2 SQLite Import graph guards', () => {
  it('bounds proposal recovery reads to one hundred snapshots', () => {
    const db = database();
    try {
      const frozen = version();
      const repository = new W1WorkflowRepository(db);
      repository.publishVersion(frozen);
      const imports = new W32WorkflowImportRepository(db);
      for (let index = 0; index < 101; index++)
        imports.insertProposal({
          id: `proposal-${String(index).padStart(3, '0')}`,
          revision: 1,
          status: 'DRAFT',
          definitionId: frozen.definition.id,
          version: frozen.version,
          versionHash: (
            db
              .prepare(
                'SELECT content_hash FROM workflow_versions WHERE definition_id = ? AND version = ?',
              )
              .get(frozen.definition.id, frozen.version) as { content_hash: string }
          ).content_hash,
          inputSnapshot: {},
          description: '',
          sources: [],
          resolution: {
            suggestedCompletedSteps: [],
            suggestedCurrentStep: 'a',
            candidateArtifactBindings: [],
            missingRequirements: [],
            confidence: 0,
            explanationSummary: '',
          },
          sourceMetadataHash: workflowImportSourceMetadataHash([]),
          policyVersion: WORKFLOW_IMPORT_POLICY_VERSION,
          validationStatus: 'INVALID',
          validationErrors: ['No source files selected'],
          createdAt: NOW,
          updatedAt: NOW,
          runId: null,
        });
      expect(imports.listProposals()).toHaveLength(100);
    } finally {
      db.close();
    }
  });

  it('rejects a skipped frozen node even when every claimed Step has a mapped source', () => {
    const db = database();
    try {
      const frozen = version();
      const setup = freshRun(db, frozen, 'skip-run');
      const sources = [source('source-a', 'a.txt'), source('source-c', 'c.txt')];
      const bindings = [
        { stepId: 'a', outputKey: 'a', sourceId: 'source-a' },
        { stepId: 'c', outputKey: 'c', sourceId: 'source-c' },
      ];
      setup.imports.insertProposal(
        proposal('skip-proposal', frozen, setup.versionHash, sources, bindings),
      );
      expect(() =>
        appendConfirmation(
          setup.imports,
          'skip-proposal',
          'skip-run',
          setup.versionHash,
          sources,
          ['a', 'c'],
          'd',
          bindings,
        ),
      ).toThrow(/Workflow Import confirmation/);
      expect(setup.imports.getConfirmationByProposal('skip-proposal')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('requires the mapped producer output for every required prefix and continuation input', () => {
    const db = database();
    try {
      const frozen = version(true);
      const setup = freshRun(db, frozen, 'input-run');
      const sources = [source('source-a', 'a.txt'), source('source-b', 'b.txt')];
      const bindings = [
        { stepId: 'a', outputKey: 'other', sourceId: 'source-a' },
        { stepId: 'b', outputKey: 'b', sourceId: 'source-b' },
      ];
      setup.imports.insertProposal(
        proposal('input-proposal', frozen, setup.versionHash, sources, bindings),
      );
      expect(() =>
        appendConfirmation(
          setup.imports,
          'input-proposal',
          'input-run',
          setup.versionHash,
          sources,
          ['a', 'b'],
          'c',
          bindings,
        ),
      ).toThrow(/Workflow Import confirmation/);
      expect(setup.imports.getConfirmationByProposal('input-proposal')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects a prefix missing the declared input of the current continuation Step', () => {
    const db = database();
    try {
      const frozen = version(true);
      const setup = freshRun(db, frozen, 'current-input-run');
      const sources = [source('source-a', 'a.txt'), source('source-b', 'b.txt')];
      const bindings = [
        { stepId: 'a', outputKey: 'data', sourceId: 'source-a' },
        { stepId: 'b', outputKey: 'otherb', sourceId: 'source-b' },
      ];
      setup.imports.insertProposal(
        proposal('current-input-proposal', frozen, setup.versionHash, sources, bindings),
      );
      expect(() =>
        appendConfirmation(
          setup.imports,
          'current-input-proposal',
          'current-input-run',
          setup.versionHash,
          sources,
          ['a', 'b'],
          'c',
          bindings,
        ),
      ).toThrow(/Workflow Import confirmation/);
      expect(setup.imports.getConfirmationByProposal('current-input-proposal')).toBeNull();
    } finally {
      db.close();
    }
  });
});
