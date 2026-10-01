import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  validateArtifactContractDefinition,
  validateRevisionTraversal,
  validateStepOperationReceipt,
  type ArtifactContract,
  type RevisionTraversal,
  type StepOperationReceipt,
} from '@cultivation/domain';

interface ContractRow {
  contract_json: string;
  content_hash: string;
}

interface ReleaseRow {
  definition_id: string;
  version: number;
  manifest_hash: string;
  released_at: string;
}

interface TraversalRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string;
  edge_id: string;
  group_id: string;
  traversal_index: number;
  reason: string;
  created_at: string;
}

interface OperationRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string;
  attempt: number;
  operation_key: string;
  effect_type: StepOperationReceipt['effectType'];
  state: StepOperationReceipt['state'];
  input_hash: string;
  manifest_json: string | null;
  output_artifact_ids_json: string;
  external_reference: string | null;
  created_at: string;
  updated_at: string;
}

/** Trusted release fact created only after the builtin manifest has been validated. */
export interface WorkflowBuiltinReleaseFact {
  definitionId: string;
  version: number;
  manifestHash: string;
  releasedAt: string;
}

const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_ID = 256;
const MAX_TIMESTAMP = 128;

/** Independent W2 persistence extension sharing the W1 database connection. */
export class W2WorkflowRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  registerContract(
    value: ArtifactContract,
    registeredAt = new Date().toISOString(),
  ): ArtifactContract {
    validateArtifactContractDefinition(value);
    validateId(value.contractId, 'Artifact Contract');
    validateId(value.contractVersion, 'Artifact Contract version');
    validateTimestamp(registeredAt);
    const contractJson = canonicalJson(value);
    const contentHash = sha256(contractJson);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT contract_json, content_hash FROM workflow_artifact_contract_registry
           WHERE contract_id = ? AND contract_version = ?`,
        )
        .get(value.contractId, value.contractVersion) as ContractRow | undefined;
      if (prior) {
        if (prior.contract_json !== contractJson || prior.content_hash !== contentHash) {
          throw new Error('Artifact Contract identity and definition are immutable');
        }
        return JSON.parse(prior.contract_json) as ArtifactContract;
      }
      this.db
        .prepare(
          `INSERT INTO workflow_artifact_contract_registry
            (contract_id, contract_version, contract_json, content_hash, registered_at)
           VALUES (@contractId, @contractVersion, @contractJson, @contentHash, @registeredAt)`,
        )
        .run({
          contractId: value.contractId,
          contractVersion: value.contractVersion,
          contractJson,
          contentHash,
          registeredAt,
        });
      return JSON.parse(contractJson) as ArtifactContract;
    });
  }

  getContract(contractId: string, contractVersion: string): ArtifactContract | null {
    validateId(contractId, 'Artifact Contract');
    validateId(contractVersion, 'Artifact Contract version');
    const row = this.db
      .prepare(
        `SELECT contract_json FROM workflow_artifact_contract_registry
         WHERE contract_id = ? AND contract_version = ?`,
      )
      .get(contractId, contractVersion) as { contract_json: string } | undefined;
    return row ? (JSON.parse(row.contract_json) as ArtifactContract) : null;
  }

  listContracts(): ArtifactContract[] {
    const rows = this.db
      .prepare(
        `SELECT contract_json, content_hash FROM workflow_artifact_contract_registry
         ORDER BY contract_id COLLATE BINARY, contract_version COLLATE BINARY`,
      )
      .all() as ContractRow[];
    return rows.map((row) => {
      const contract = JSON.parse(row.contract_json) as ArtifactContract;
      validateArtifactContractDefinition(contract);
      if (
        canonicalJson(contract) !== row.contract_json ||
        sha256(row.contract_json) !== row.content_hash
      ) {
        throw new Error('Persisted Artifact Contract integrity check failed');
      }
      return contract;
    });
  }

  /**
   * Register a builtin only after the trusted registry has verified its canonical manifest hash.
   * W1 version insertion is separately guarded by an exact releaseMetadata hash match.
   */
  registerRelease(value: WorkflowBuiltinReleaseFact): WorkflowBuiltinReleaseFact {
    validateId(value.definitionId, 'Workflow definition');
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
      throw new Error('Invalid built-in Workflow version');
    }
    validateHash(value.manifestHash, 'Built-in Workflow manifestHash');
    validateTimestamp(value.releasedAt);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT definition_id, version, manifest_hash, released_at
           FROM workflow_builtin_releases WHERE definition_id = ? AND version = ?`,
        )
        .get(value.definitionId, value.version) as ReleaseRow | undefined;
      if (prior) {
        if (prior.manifest_hash !== value.manifestHash) {
          throw new Error('Built-in Workflow release identity and manifestHash are immutable');
        }
        return mapRelease(prior);
      }
      this.db
        .prepare(
          `INSERT INTO workflow_builtin_releases
            (definition_id, version, manifest_hash, released_at)
           VALUES (@definitionId, @version, @manifestHash, @releasedAt)`,
        )
        .run(value);
      return { ...value };
    });
  }

  getRelease(definitionId: string, version: number): WorkflowBuiltinReleaseFact | null {
    validateId(definitionId, 'Workflow definition');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error('Invalid built-in Workflow version');
    }
    const row = this.db
      .prepare(
        `SELECT definition_id, version, manifest_hash, released_at
         FROM workflow_builtin_releases WHERE definition_id = ? AND version = ?`,
      )
      .get(definitionId, version) as ReleaseRow | undefined;
    return row ? mapRelease(row) : null;
  }

  /** Append one selected revision edge inside the caller's Step completion transaction. */
  appendRevisionTraversal(value: RevisionTraversal): void {
    validateRevisionTraversal(value);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workflow_revision_traversals
            (id, workflow_run_id, step_run_id, edge_id, group_id, traversal_index, reason, created_at)
           VALUES (@id, @workflowRunId, @stepRunId, @edgeId, @groupId,
             @traversalIndex, @reason, @createdAt)`,
        )
        .run({
          id: value.id,
          workflowRunId: value.workflowRunId,
          stepRunId: value.stepRunId,
          edgeId: value.edgeId,
          groupId: value.groupId,
          traversalIndex: value.traversalIndex,
          reason: value.reason,
          createdAt: value.createdAt,
        });
    });
  }

  listTraversals(workflowRunId: string): RevisionTraversal[] {
    validateId(workflowRunId, 'Workflow Run');
    const rows = this.db
      .prepare(
        `SELECT id, workflow_run_id, step_run_id, edge_id, group_id,
           traversal_index, reason, created_at
         FROM workflow_revision_traversals
         WHERE workflow_run_id = ? ORDER BY traversal_index, created_at, id`,
      )
      .all(workflowRunId) as TraversalRow[];
    return rows.map(mapTraversal);
  }

  /** Prepare is idempotent for the same immutable receipt identity and never replays terminal work. */
  prepareOperation(value: StepOperationReceipt): StepOperationReceipt {
    validateStepOperationReceipt(value);
    if (value.state !== 'PREPARED') {
      throw new Error('A new Workflow operation receipt must start PREPARED');
    }
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT * FROM workflow_step_operation_receipts
           WHERE workflow_run_id = ? AND step_run_id = ? AND attempt = ? AND operation_key = ?`,
        )
        .get(value.workflowRunId, value.stepRunId, value.attempt, value.operationKey) as
        | OperationRow
        | undefined;
      if (prior) {
        const receipt = mapOperation(prior);
        if (!sameOperationIdentity(receipt, value)) {
          throw new Error('Workflow operation key is already owned by a different receipt');
        }
        return receipt;
      }
      this.db
        .prepare(
          `INSERT INTO workflow_step_operation_receipts
            (id, workflow_run_id, step_run_id, attempt, operation_key, effect_type, state,
             input_hash, manifest_json, output_artifact_ids_json, external_reference,
             created_at, updated_at)
           VALUES (@id, @workflowRunId, @stepRunId, @attempt, @operationKey, @effectType,
             @state, @inputHash, @manifestJson, @outputArtifactIdsJson, @externalReference,
             @createdAt, @updatedAt)`,
        )
        .run(operationValues(value));
      return value;
    });
  }

  /** Compare-and-swap an operation receipt from PREPARED to APPLIED/UNKNOWN or APPLIED onward. */
  transitionOperation(
    nextReceipt: StepOperationReceipt,
    expectedState: StepOperationReceipt['state'],
  ): boolean {
    validateStepOperationReceipt(nextReceipt);
    if (!['PREPARED', 'APPLIED'].includes(expectedState)) {
      throw new Error('Terminal Workflow operation receipts cannot be replayed');
    }
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM workflow_step_operation_receipts WHERE id = ?')
        .get(nextReceipt.id) as OperationRow | undefined;
      if (!row) return false;
      const current = mapOperation(row);
      if (!sameOperationIdentity(current, nextReceipt)) {
        throw new Error('Workflow operation receipt ownership and inputs are immutable');
      }
      if (current.state !== expectedState) return false;
      const allowed =
        (expectedState === 'PREPARED' && ['APPLIED', 'UNKNOWN'].includes(nextReceipt.state)) ||
        (expectedState === 'APPLIED' && ['VERIFIED', 'UNKNOWN'].includes(nextReceipt.state));
      if (!allowed) throw new Error('Invalid Workflow operation receipt transition');
      const result = this.db
        .prepare(
          `UPDATE workflow_step_operation_receipts
           SET state = @state, manifest_json = @manifestJson,
               output_artifact_ids_json = @outputArtifactIdsJson,
               external_reference = @externalReference, updated_at = @updatedAt
           WHERE id = @id AND state = @expectedState`,
        )
        .run({ ...operationValues(nextReceipt), expectedState });
      return result.changes === 1;
    });
  }

  listOperations(workflowRunId: string): StepOperationReceipt[] {
    validateId(workflowRunId, 'Workflow Run');
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_step_operation_receipts
         WHERE workflow_run_id = ? ORDER BY created_at, id`,
      )
      .all(workflowRunId) as OperationRow[];
    return rows.map(mapOperation);
  }
}

function operationValues(value: StepOperationReceipt): Record<string, unknown> {
  return {
    id: value.id,
    workflowRunId: value.workflowRunId,
    stepRunId: value.stepRunId,
    attempt: value.attempt,
    operationKey: value.operationKey,
    effectType: value.effectType,
    state: value.state,
    inputHash: value.inputHash,
    manifestJson: value.manifest === undefined ? null : canonicalJson(value.manifest),
    outputArtifactIdsJson: canonicalJson(value.outputArtifactIds ?? []),
    externalReference: value.externalReference ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapRelease(row: ReleaseRow): WorkflowBuiltinReleaseFact {
  return {
    definitionId: row.definition_id,
    version: row.version,
    manifestHash: row.manifest_hash,
    releasedAt: row.released_at,
  };
}

function mapTraversal(row: TraversalRow): RevisionTraversal {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    edgeId: row.edge_id,
    groupId: row.group_id,
    traversalIndex: row.traversal_index,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapOperation(row: OperationRow): StepOperationReceipt {
  const manifest = row.manifest_json
    ? (JSON.parse(row.manifest_json) as StepOperationReceipt['manifest'])
    : undefined;
  const outputArtifactIds = JSON.parse(row.output_artifact_ids_json) as string[];
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    attempt: row.attempt,
    operationKey: row.operation_key,
    effectType: row.effect_type,
    state: row.state,
    inputHash: row.input_hash,
    ...(manifest !== undefined ? { manifest } : {}),
    ...(outputArtifactIds.length > 0 ? { outputArtifactIds } : {}),
    ...(row.external_reference !== null ? { externalReference: row.external_reference } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameOperationIdentity(left: StepOperationReceipt, right: StepOperationReceipt): boolean {
  return (
    left.id === right.id &&
    left.workflowRunId === right.workflowRunId &&
    left.stepRunId === right.stepRunId &&
    left.attempt === right.attempt &&
    left.operationKey === right.operationKey &&
    left.effectType === right.effectType &&
    left.inputHash === right.inputHash &&
    left.createdAt === right.createdAt
  );
}

function validateHash(value: string, name: string): void {
  if (typeof value !== 'string' || !SHA256.test(value))
    throw new Error(`${name} must be SHA-256 hex`);
}

function validateId(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ID) {
    throw new Error(`${name} id is invalid`);
  }
}

function validateTimestamp(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('Workflow timestamp is invalid');
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
