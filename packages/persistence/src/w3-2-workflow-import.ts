import Database from 'better-sqlite3';
import type {
  WorkflowImportConfirmation,
  WorkflowImportProposal,
  WorkflowImportedArtifact,
  WorkflowImportedBinding,
  WorkflowImportedValidation,
} from '@cultivation/domain';
import {
  validateWorkflowImportConfirmation,
  validateWorkflowImportProposal,
  validateWorkflowImportedArtifact,
} from '@cultivation/domain';
import type { WorkflowImportRepositoryPort } from '../../application/src/w3-2-import-ports.js';

interface ProposalRow {
  id: string;
  revision: number;
  status: WorkflowImportProposal['status'];
  definition_id: string;
  definition_version: number;
  version_hash: string;
  input_snapshot_json: string;
  description: string;
  sources_json: string;
  resolution_json: string;
  source_metadata_hash: string;
  policy_version: string;
  validation_status: WorkflowImportProposal['validationStatus'];
  validation_errors_json: string;
  created_at: string;
  updated_at: string;
  run_id: string | null;
}

interface ConfirmationRow {
  id: string;
  proposal_id: string;
  run_id: string;
  version_hash: string;
  source_metadata_hash: string;
  completed_step_ids_json: string;
  current_step_id: string;
  bindings_json: string;
  mapping_hash: string;
  created_at: string;
}

/** SQLite persistence for W3.2 Import proposals and confirmed provenance facts. */
export class W32WorkflowImportRepository implements WorkflowImportRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getProposal(id: string): WorkflowImportProposal | null {
    const row = this.db.prepare('SELECT * FROM workflow_import_proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
    return row ? mapProposal(row) : null;
  }

  listProposals(): WorkflowImportProposal[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_import_proposals ORDER BY updated_at DESC, id LIMIT 100')
      .all() as ProposalRow[];
    return rows.map(mapProposal);
  }

  insertProposal(value: WorkflowImportProposal): void {
    validateWorkflowImportProposal(value);
    this.db
      .prepare(
        `INSERT INTO workflow_import_proposals
          (id, revision, status, definition_id, definition_version, version_hash,
           input_snapshot_json, description, sources_json, resolution_json,
           source_metadata_hash, policy_version, validation_status, validation_errors_json,
           created_at, updated_at, run_id)
         VALUES (@id, @revision, @status, @definitionId, @version, @versionHash,
           @inputSnapshot, @description, @sources, @resolution, @sourceMetadataHash,
           @policyVersion, @validationStatus, @validationErrors, @createdAt, @updatedAt, @runId)`,
      )
      .run(proposalParams(value));
  }

  saveProposal(value: WorkflowImportProposal, expectedRevision: number): boolean {
    validateWorkflowImportProposal(value);
    if (value.revision !== expectedRevision + 1)
      throw new Error('Workflow Import proposal revision must advance exactly once');
    return (
      this.db
        .prepare(
          `UPDATE workflow_import_proposals SET
             revision = @revision, status = @status, input_snapshot_json = @inputSnapshot,
             description = @description, sources_json = @sources, resolution_json = @resolution,
             source_metadata_hash = @sourceMetadataHash, policy_version = @policyVersion,
             validation_status = @validationStatus, validation_errors_json = @validationErrors,
             updated_at = @updatedAt, run_id = @runId
           WHERE id = @id AND revision = @expectedRevision`,
        )
        .run({ ...proposalParams(value), expectedRevision }).changes === 1
    );
  }

  appendConfirmation(value: WorkflowImportConfirmation): void {
    validateWorkflowImportConfirmation(value);
    this.db
      .prepare(
        `INSERT INTO workflow_import_confirmations
          (id, proposal_id, run_id, version_hash, source_metadata_hash,
           completed_step_ids_json, current_step_id, bindings_json, mapping_hash, created_at)
         VALUES (@id, @proposalId, @runId, @versionHash, @sourceMetadataHash,
           @completedStepIds, @currentStepId, @bindings, @mappingHash, @createdAt)`,
      )
      .run({
        id: value.id,
        proposalId: value.proposalId,
        runId: value.runId,
        versionHash: value.versionHash,
        sourceMetadataHash: value.sourceMetadataHash,
        completedStepIds: canonicalJson(value.completedStepIds),
        currentStepId: value.currentStepId,
        bindings: canonicalJson(value.bindings),
        mappingHash: value.mappingHash,
        createdAt: value.createdAt,
      });
  }

  getConfirmationByProposal(proposalId: string): WorkflowImportConfirmation | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_import_confirmations WHERE proposal_id = ?')
      .get(proposalId) as ConfirmationRow | undefined;
    return row ? mapConfirmation(row) : null;
  }

  getConfirmationByRun(runId: string): WorkflowImportConfirmation | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_import_confirmations WHERE run_id = ?')
      .get(runId) as ConfirmationRow | undefined;
    return row ? mapConfirmation(row) : null;
  }

  appendImportedArtifact(value: WorkflowImportedArtifact): void {
    validateWorkflowImportedArtifact(value);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workflow_import_artifacts
            (id, workflow_run_id, producer_step_run_id, import_confirmation_id, source_id,
             kind, content, content_hash, metadata_json, created_at)
           VALUES (@id, @workflowRunId, @producerStepRunId, @importConfirmationId, @sourceId,
             @kind, @content, @contentHash, @metadataJson, @createdAt)`,
        )
        .run({
          id: value.id,
          workflowRunId: value.workflowRunId,
          producerStepRunId: value.producerStepRunId,
          importConfirmationId: value.importConfirmationId,
          sourceId: value.sourceId,
          kind: value.kind,
          content: value.content,
          contentHash: value.contentHash,
          metadataJson: canonicalJson(value.metadata),
          createdAt: value.createdAt,
        });
      const insertInput = this.db.prepare(
        'INSERT INTO workflow_import_artifact_inputs (artifact_id, input_artifact_id) VALUES (?, ?)',
      );
      for (const inputId of value.inputArtifactIds) {
        const imported = this.db
          .prepare('SELECT 1 FROM workflow_import_artifacts WHERE id = ?')
          .get(inputId);
        if (!imported)
          throw new Error('Imported Artifact lineage must reference an earlier imported Artifact');
        insertInput.run(value.id, inputId);
      }
    });
  }

  appendImportedBinding(value: WorkflowImportedBinding): void {
    validateBinding(value);
    if (!value.importConfirmationId)
      throw new Error('Imported Artifact binding requires an Import confirmation id');
    this.db
      .prepare(
        `INSERT INTO workflow_import_artifact_bindings
          (id, workflow_run_id, step_run_id, key, artifact_id, role,
           contract_id, contract_version, import_confirmation_id, created_at)
         VALUES (@id, @workflowRunId, @stepRunId, @key, @artifactId, @role,
           @contractId, @contractVersion, @importConfirmationId, @createdAt)`,
      )
      .run(value);
  }

  appendImportedValidation(value: WorkflowImportedValidation): void {
    validateValidation(value);
    const result = this.db
      .prepare(
        `INSERT INTO workflow_import_validations
          (id, workflow_run_id, step_run_id, artifact_id, contract_id, contract_version,
           validator_version, content_hash, valid, errors_json, import_confirmation_id, created_at)
         SELECT @id, artifact.workflow_run_id, @stepRunId, @artifactId, @contractId,
           @contractVersion, @validatorVersion, @contentHash, @valid, @errorsJson,
           artifact.import_confirmation_id, @createdAt
         FROM workflow_import_artifacts AS artifact WHERE artifact.id = @artifactId`,
      )
      .run({
        ...value,
        valid: value.valid ? 1 : 0,
        errorsJson: canonicalJson(value.errors),
      });
    if (result.changes !== 1)
      throw new Error('Imported validation must reference an imported Artifact');
  }
}

function mapProposal(row: ProposalRow): WorkflowImportProposal {
  const value: WorkflowImportProposal = {
    id: row.id,
    revision: row.revision,
    status: row.status,
    definitionId: row.definition_id,
    version: row.definition_version,
    versionHash: row.version_hash,
    inputSnapshot: JSON.parse(row.input_snapshot_json) as WorkflowImportProposal['inputSnapshot'],
    description: row.description,
    sources: JSON.parse(row.sources_json) as WorkflowImportProposal['sources'],
    resolution: JSON.parse(row.resolution_json) as WorkflowImportProposal['resolution'],
    sourceMetadataHash: row.source_metadata_hash,
    policyVersion: row.policy_version,
    validationStatus: row.validation_status,
    validationErrors: JSON.parse(row.validation_errors_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runId: row.run_id,
  };
  validateWorkflowImportProposal(value);
  return value;
}

function mapConfirmation(row: ConfirmationRow): WorkflowImportConfirmation {
  const value: WorkflowImportConfirmation = {
    id: row.id,
    proposalId: row.proposal_id,
    runId: row.run_id,
    versionHash: row.version_hash,
    sourceMetadataHash: row.source_metadata_hash,
    completedStepIds: JSON.parse(row.completed_step_ids_json) as string[],
    currentStepId: row.current_step_id,
    bindings: JSON.parse(row.bindings_json) as WorkflowImportConfirmation['bindings'],
    mappingHash: row.mapping_hash,
    createdAt: row.created_at,
  };
  validateWorkflowImportConfirmation(value);
  return value;
}

function proposalParams(value: WorkflowImportProposal): Record<string, string | number | null> {
  return {
    id: value.id,
    revision: value.revision,
    status: value.status,
    definitionId: value.definitionId,
    version: value.version,
    versionHash: value.versionHash,
    inputSnapshot: canonicalJson(value.inputSnapshot),
    description: value.description,
    sources: canonicalJson(value.sources),
    resolution: canonicalJson(value.resolution),
    sourceMetadataHash: value.sourceMetadataHash,
    policyVersion: value.policyVersion,
    validationStatus: value.validationStatus,
    validationErrors: canonicalJson(value.validationErrors),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    runId: value.runId,
  };
}

function validateBinding(value: WorkflowImportedBinding): void {
  validateText(value.id, 'Import Artifact binding id', 256);
  validateText(value.workflowRunId, 'Workflow Run id', 256);
  validateText(value.stepRunId, 'Workflow StepRun id', 256);
  validateText(value.key, 'Workflow Artifact binding key', 128);
  validateText(value.artifactId, 'Imported Artifact id', 256);
  validateText(value.contractId, 'Workflow contract id', 256);
  validateText(value.contractVersion, 'Workflow contract version', 128);
  validateText(value.importConfirmationId, 'Workflow Import confirmation id', 256);
  validateText(value.createdAt, 'Workflow Import binding timestamp', 128);
  if (!['INPUT', 'OUTPUT'].includes(value.role))
    throw new Error('Invalid imported Artifact binding role');
}

function validateValidation(value: WorkflowImportedValidation): void {
  validateText(value.id, 'Import validation id', 256);
  validateText(value.stepRunId, 'Workflow StepRun id', 256);
  validateText(value.artifactId, 'Imported Artifact id', 256);
  validateText(value.contractId, 'Workflow contract id', 256);
  validateText(value.contractVersion, 'Workflow contract version', 128);
  validateText(value.validatorVersion, 'Workflow validator version', 128);
  validateHash(value.contentHash, 'Imported Artifact contentHash');
  if (typeof value.valid !== 'boolean' || !Array.isArray(value.errors) || value.errors.length > 64)
    throw new Error('Invalid imported validation receipt');
  if (value.valid && value.errors.length)
    throw new Error('Valid import validations cannot contain errors');
  for (const error of value.errors) validateText(error, 'Import validation error', 512, true);
  validateText(value.createdAt, 'Import validation timestamp', 128);
}

function validateText(value: string, name: string, max: number, allowEmpty = false): void {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()))
    throw new Error(`${name} is invalid`);
}

function validateHash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be SHA-256 hex`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  return value;
}
