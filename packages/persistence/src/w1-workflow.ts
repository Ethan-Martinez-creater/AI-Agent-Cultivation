import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  canTransitionWorkflowRun,
  canTransitionWorkflowStep,
  EMPTY_WORKFLOW_INPUT_SCHEMA,
  W1_INPUT_POLICY,
  validateWorkflowInputs,
  validateWorkflowVersion,
  type WorkflowArtifact,
  type WorkflowArtifactBinding,
  type WorkflowCheckpoint,
  type WorkflowDecisionFact,
  type WorkflowDetail,
  type WorkflowEvent,
  type WorkflowFinalValidation,
  type WorkflowImportConfirmation,
  type WorkflowImportProposal,
  type WorkflowImportSource,
  type WorkflowImportedArtifact,
  type WorkflowInputs,
  type WorkflowRun,
  type WorkflowStepRun,
  type WorkflowValidationReceipt,
  type WorkflowVersion,
} from '@cultivation/domain';
import {
  validateWorkflowImportConfirmation,
  validateWorkflowImportProposal,
  validateWorkflowImportedArtifact,
  workflowImportSourceMetadataHash,
} from '@cultivation/domain';
import type { WorkflowRepository } from '../../application/src/w1-workflow-ports.js';

interface VersionRow {
  version_json: string;
}

interface DefinitionRow {
  source: WorkflowVersion['definition']['source'];
}

interface RunRow {
  id: string;
  definition_id: string;
  definition_version: number;
  state: WorkflowRun['state'];
  wait_reason: WorkflowRun['waitReason'];
  input_snapshot_json: string;
  created_at: string;
  updated_at: string;
}

interface FinalValidationRow {
  id: string;
  workflow_run_id: string;
  definition_version: number;
  input_hash: string;
  state_hash: string;
  output_bindings_json: string;
  valid: number;
  errors_json: string;
  created_at: string;
}

interface StepRunRow {
  id: string;
  workflow_run_id: string;
  step_id: string;
  attempt: number;
  completion_origin: 'EXECUTED' | 'IMPORTED_CONFIRMED';
  state: WorkflowStepRun['state'];
  mission_id: string | null;
  mission_run_id: string | null;
  workspace_root: string | null;
  wait_reason: WorkflowStepRun['waitReason'];
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  workflow_run_id: string;
  producer_step_run_id: string;
  mission_id: string | null;
  mission_run_id: string | null;
  actor_id: string | null;
  source_id: string;
  source: WorkflowArtifact['source'];
  kind: WorkflowArtifact['kind'];
  content: string;
  content_hash: string;
  metadata_json: string;
  created_at: string;
  import_confirmation_id?: string | null;
}

interface BindingRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string;
  key: string;
  artifact_id: string;
  role: WorkflowArtifactBinding['role'];
  contract_id: string;
  contract_version: string;
  created_at: string;
  import_confirmation_id?: string | null;
}

interface ImportedValidationRow extends ValidationRow {
  import_confirmation_id: string;
}

interface ImportedArtifactRow {
  id: string;
  workflow_run_id: string;
  producer_step_run_id: string;
  import_confirmation_id: string;
  source_id: string;
  kind: WorkflowArtifact['kind'];
  content: string;
  content_hash: string;
  metadata_json: string;
  created_at: string;
}

interface ImportConfirmationRow {
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

interface ValidationRow {
  id: string;
  step_run_id: string;
  artifact_id: string;
  contract_id: string;
  contract_version: string;
  validator_version: string;
  content_hash: string;
  valid: number;
  errors_json: string;
  created_at: string;
}

interface DecisionRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string;
  edge_id: string;
  branch: string;
  input_hash: string;
  created_at: string;
}

interface CheckpointRow {
  id: string;
  workflow_run_id: string;
  sequence: number;
  definition_version: number;
  completed_step_run_ids_json: string;
  active_step_run_ids_json: string;
  artifact_binding_hashes_json: string;
  decision_hashes_json: string;
  state_hash: string;
  created_at: string;
}

interface EventRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}

const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_ID = 256;
const MAX_TIMESTAMP = 128;
const MAX_ARTIFACT_CONTENT_BYTES = 1_000_000;
const MAX_METADATA_BYTES = 8_192;
const MAX_EVENT_PAYLOAD_BYTES = 4_096;
const PRIVATE_MEMORY_KEY = /privatememory/i;

/** SQLite persistence for immutable W1 Workflow definitions and durable run facts. */
export class W1WorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  publishVersion(value: WorkflowVersion): void {
    validateWorkflowVersion(value);
    validateId(value.definition.id, 'Workflow definition');
    validateText(value.definition.name, 'Workflow name', 256);
    validateText(value.definition.description, 'Workflow description', 6_000, true);
    validateText(value.definition.category, 'Workflow category', 128);
    validateTimestamp(value.createdAt);
    const versionJson = canonicalJson(value);
    const versionHash = sha256(versionJson);

    this.transaction(() => {
      const priorDefinition = this.db
        .prepare('SELECT source FROM workflow_definitions WHERE id = ?')
        .get(value.definition.id) as DefinitionRow | undefined;
      if (priorDefinition && priorDefinition.source !== value.definition.source) {
        throw new Error('Workflow definition id and source are immutable');
      }
      if (!priorDefinition) {
        this.db
          .prepare(
            `INSERT INTO workflow_definitions
              (id, name, description, category, source, created_at)
             VALUES (@id, @name, @description, @category, @source, @createdAt)`,
          )
          .run({ ...value.definition, createdAt: value.createdAt });
      }

      const priorVersion = this.db
        .prepare(
          'SELECT version_json FROM workflow_versions WHERE definition_id = ? AND version = ?',
        )
        .get(value.definition.id, value.version) as VersionRow | undefined;
      if (priorVersion) {
        if (priorVersion.version_json !== versionJson) {
          throw new Error('Workflow version is immutable');
        }
        return;
      }

      this.db
        .prepare(
          `INSERT INTO workflow_versions
            (definition_id, version, entry_step_id, version_json, content_hash, created_at)
           VALUES (@definitionId, @version, @entryStepId, @versionJson, @contentHash, @createdAt)`,
        )
        .run({
          definitionId: value.definition.id,
          version: value.version,
          entryStepId: value.entryStepId,
          versionJson,
          contentHash: versionHash,
          createdAt: value.createdAt,
        });

      const insertStep = this.db.prepare(
        `INSERT INTO workflow_steps
          (definition_id, version, id, type, title, objective, routing_json, inputs_json,
           outputs_json, max_attempts, exit_condition, effect_type)
         VALUES (@definitionId, @version, @id, @type, @title, @objective, @routing,
           @inputs, @outputs, @maxAttempts, @exitCondition, @effectType)`,
      );
      for (const step of value.steps) {
        insertStep.run({
          definitionId: value.definition.id,
          version: value.version,
          ...step,
          routing: canonicalJson(step.routing),
          inputs: canonicalJson(step.inputs),
          outputs: canonicalJson(step.outputs),
        });
      }
      const insertEdge = this.db.prepare(
        `INSERT INTO workflow_edges
          (definition_id, version, id, from_step_id, to_step_id, branch, condition_json, revision_code)
         VALUES (@definitionId, @version, @id, @fromStepId, @toStepId, @branch, @condition, @revisionCode)`,
      );
      for (const edge of value.edges) {
        insertEdge.run({
          definitionId: value.definition.id,
          version: value.version,
          ...edge,
          condition: canonicalJson(edge.condition),
          // W2 revision metadata lives in the immutable version JSON; legacy SQL column stays NULL.
          revisionCode: null,
        });
      }
    });
  }

  getVersion(definitionId: string, version: number): WorkflowVersion | null {
    validateId(definitionId, 'Workflow definition');
    if (!Number.isInteger(version) || version < 1) throw new Error('Invalid Workflow version');
    const row = this.db
      .prepare('SELECT version_json FROM workflow_versions WHERE definition_id = ? AND version = ?')
      .get(definitionId, version) as VersionRow | undefined;
    return row ? (JSON.parse(row.version_json) as WorkflowVersion) : null;
  }

  listVersions(): WorkflowVersion[] {
    const rows = this.db
      .prepare('SELECT version_json FROM workflow_versions ORDER BY definition_id, version')
      .all() as VersionRow[];
    return rows.map((row) => JSON.parse(row.version_json) as WorkflowVersion);
  }

  insertRun(value: WorkflowRun): void {
    validateRun(value);
    if (value.state !== 'DRAFT' || value.waitReason !== null) {
      throw new Error('Workflow Runs must start as DRAFT');
    }
    const version = this.getVersion(value.definitionId, value.definitionVersion);
    if (!version) throw new Error('Workflow Run requires an existing frozen version');
    const inputSnapshot = validateWorkflowInputs(
      version.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA,
      value.inputSnapshot ?? {},
    );
    const inputSnapshotJson = canonicalJson(inputSnapshot);
    if (Buffer.byteLength(inputSnapshotJson, 'utf8') > W1_INPUT_POLICY.maxSnapshotBytes) {
      throw new Error('Workflow input snapshot is too large');
    }
    this.db
      .prepare(
        `INSERT INTO workflow_runs
          (id, definition_id, definition_version, state, wait_reason, input_snapshot_json,
           created_at, updated_at)
         VALUES (@id, @definitionId, @definitionVersion, @state, @waitReason, @inputSnapshot,
           @createdAt, @updatedAt)`,
      )
      .run({
        id: value.id,
        definitionId: value.definitionId,
        definitionVersion: value.definitionVersion,
        state: value.state,
        waitReason: value.waitReason,
        inputSnapshot: inputSnapshotJson,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
  }

  saveRun(value: WorkflowRun, expectedState: WorkflowRun['state']): boolean {
    validateRun(value);
    if (expectedState !== value.state && !canTransitionWorkflowRun(expectedState, value.state)) {
      throw new Error(`Illegal Workflow transition: ${expectedState} → ${value.state}`);
    }
    const current = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(value.id) as
      | RunRow
      | undefined;
    if (!current || current.state !== expectedState) return false;
    if (
      current.definition_id !== value.definitionId ||
      current.definition_version !== value.definitionVersion ||
      current.created_at !== value.createdAt
    ) {
      throw new Error('Workflow Run identity and version pin are immutable');
    }
    const version = this.getVersion(current.definition_id, current.definition_version);
    if (!version) throw new Error('Workflow Run references a missing frozen version');
    const inputSnapshot = validateWorkflowInputs(
      version.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA,
      value.inputSnapshot ?? {},
    );
    if (canonicalJson(inputSnapshot) !== current.input_snapshot_json) {
      throw new Error('Workflow Run input snapshot is immutable');
    }
    return (
      this.db
        .prepare(
          `UPDATE workflow_runs SET state = @state, wait_reason = @waitReason, updated_at = @updatedAt
           WHERE id = @id AND state = @expectedState`,
        )
        .run({
          id: value.id,
          state: value.state,
          waitReason: value.waitReason,
          updatedAt: value.updatedAt,
          expectedState,
        }).changes === 1
    );
  }

  insertStep(value: WorkflowStepRun): void {
    validateStepRun(value);
    if (
      value.state !== 'PENDING' ||
      value.missionId !== null ||
      value.missionRunId !== null ||
      value.workspaceRoot != null ||
      value.waitReason !== null
    ) {
      throw new Error('Workflow StepRuns must start PENDING and unbound');
    }
    this.db
      .prepare(
        `INSERT INTO workflow_step_runs
          (id, workflow_run_id, step_id, attempt, state, mission_id, mission_run_id,
           workspace_root, wait_reason, error_code, created_at, updated_at)
         VALUES (@id, @workflowRunId, @stepId, @attempt, @state, @missionId, @missionRunId,
           @workspaceRoot, @waitReason, @errorCode, @createdAt, @updatedAt)`,
      )
      .run({
        id: value.id,
        workflowRunId: value.workflowRunId,
        stepId: value.stepId,
        attempt: value.attempt,
        state: value.state,
        missionId: value.missionId,
        missionRunId: value.missionRunId,
        workspaceRoot: null,
        waitReason: value.waitReason,
        errorCode: value.errorCode,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
  }

  saveStep(value: WorkflowStepRun, expectedState: WorkflowStepRun['state']): boolean {
    validateStepRun(value);
    if (expectedState !== value.state && !canTransitionWorkflowStep(expectedState, value.state)) {
      throw new Error(`Illegal Step transition: ${expectedState} → ${value.state}`);
    }
    const current = this.db
      .prepare('SELECT * FROM workflow_step_runs WHERE id = ?')
      .get(value.id) as StepRunRow | undefined;
    if (!current || current.state !== expectedState) return false;
    if (
      current.workflow_run_id !== value.workflowRunId ||
      current.step_id !== value.stepId ||
      current.attempt !== value.attempt ||
      current.created_at !== value.createdAt
    ) {
      throw new Error('Workflow StepRun identity is immutable');
    }
    const workspaceRoot =
      value.workspaceRoot === undefined ? current.workspace_root : value.workspaceRoot;
    const completionOrigin = value.completionOrigin ?? current.completion_origin;
    validateNullableText(workspaceRoot, 'Workflow workspace root', 4096);
    return (
      this.db
        .prepare(
          `UPDATE workflow_step_runs SET state = @state, mission_id = @missionId,
             mission_run_id = @missionRunId, workspace_root = @workspaceRoot,
             wait_reason = @waitReason, error_code = @errorCode,
             completion_origin = @completionOrigin, updated_at = @updatedAt
           WHERE id = @id AND state = @expectedState`,
        )
        .run({
          id: value.id,
          state: value.state,
          missionId: value.missionId,
          missionRunId: value.missionRunId,
          workspaceRoot,
          completionOrigin,
          waitReason: value.waitReason,
          errorCode: value.errorCode,
          updatedAt: value.updatedAt,
          expectedState,
        }).changes === 1
    );
  }

  detail(runId: string): WorkflowDetail | null {
    validateId(runId, 'Workflow Run');
    const runRow = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as
      | RunRow
      | undefined;
    if (!runRow) return null;
    const version = this.getVersion(runRow.definition_id, runRow.definition_version);
    if (!version) throw new Error('Workflow Run references a missing frozen version');
    const steps = this.db
      .prepare(
        'SELECT * FROM workflow_step_runs WHERE workflow_run_id = ? ORDER BY step_id, attempt, id',
      )
      .all(runId) as StepRunRow[];
    const artifacts = this.db
      .prepare('SELECT * FROM workflow_artifacts WHERE workflow_run_id = ? ORDER BY created_at, id')
      .all(runId) as ArtifactRow[];
    const importedArtifacts = this.db
      .prepare('SELECT * FROM workflow_import_artifacts WHERE workflow_run_id = ? ORDER BY created_at, id')
      .all(runId) as ImportedArtifactRow[];
    const artifactInputs = this.db
      .prepare(
        `SELECT l.artifact_id, l.input_artifact_id
         FROM workflow_artifact_inputs AS l
         JOIN workflow_artifacts AS a ON a.id = l.artifact_id
         WHERE a.workflow_run_id = ?
         UNION ALL
         SELECT l.artifact_id, l.input_import_artifact_id AS input_artifact_id
         FROM workflow_artifact_import_inputs AS l
         JOIN workflow_artifacts AS a ON a.id = l.artifact_id
         WHERE a.workflow_run_id = ?
         UNION ALL
         SELECT l.artifact_id, l.input_artifact_id
         FROM workflow_import_artifact_inputs AS l
         JOIN workflow_import_artifacts AS a ON a.id = l.artifact_id
         WHERE a.workflow_run_id = ?
         ORDER BY artifact_id, input_artifact_id`,
      )
      .all(runId, runId, runId) as { artifact_id: string; input_artifact_id: string }[];
    const inputIds = new Map<string, string[]>();
    for (const input of artifactInputs) {
      const ids = inputIds.get(input.artifact_id) ?? [];
      ids.push(input.input_artifact_id);
      inputIds.set(input.artifact_id, ids);
    }
    const bindings = this.db
      .prepare(
        'SELECT * FROM workflow_artifact_bindings WHERE workflow_run_id = ? ORDER BY created_at, id',
      )
      .all(runId) as BindingRow[];
    const importedBindings = this.db
      .prepare('SELECT * FROM workflow_import_artifact_bindings WHERE workflow_run_id = ? ORDER BY created_at, id')
      .all(runId) as BindingRow[];
    const validations = this.db
      .prepare(
        'SELECT * FROM workflow_validation_receipts WHERE workflow_run_id = ? ORDER BY created_at, id',
      )
      .all(runId) as ValidationRow[];
    const importedValidations = this.db
      .prepare('SELECT * FROM workflow_import_validations WHERE workflow_run_id = ? ORDER BY created_at, id')
      .all(runId) as ImportedValidationRow[];
    const finalValidations = this.db
      .prepare(
        'SELECT * FROM workflow_run_output_validations WHERE workflow_run_id = ? ORDER BY created_at, id',
      )
      .all(runId) as FinalValidationRow[];
    const decisions = this.db
      .prepare('SELECT * FROM workflow_decisions WHERE workflow_run_id = ? ORDER BY created_at, id')
      .all(runId) as DecisionRow[];
    const checkpoints = this.db
      .prepare('SELECT * FROM workflow_checkpoints WHERE workflow_run_id = ? ORDER BY sequence, id')
      .all(runId) as CheckpointRow[];
    const events = this.db
      .prepare('SELECT * FROM workflow_events WHERE workflow_run_id = ? ORDER BY created_at, id')
      .all(runId) as EventRow[];
    const confirmationRow = this.db
      .prepare('SELECT * FROM workflow_import_confirmations WHERE run_id = ?')
      .get(runId) as ImportConfirmationRow | undefined;
    const projectedArtifacts = [
      ...artifacts.map((row) => mapArtifact(row, inputIds.get(row.id) ?? [])),
      ...importedArtifacts.map((row) => mapImportedArtifact(row, inputIds.get(row.id) ?? [])),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const projectedBindings = [...bindings, ...importedBindings]
      .map(mapBinding)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const projectedValidations = [...validations, ...importedValidations]
      .map(mapValidation)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return {
      run: mapRun(runRow),
      version,
      steps: steps.map(mapStepRun),
      artifacts: projectedArtifacts,
      bindings: projectedBindings,
      validations: projectedValidations,
      finalValidations: finalValidations.map(mapFinalValidation),
      decisions: decisions.map(mapDecision),
      checkpoints: checkpoints.map(mapCheckpoint),
      events: events.map(mapEvent),
      importConfirmation: confirmationRow ? mapImportConfirmation(confirmationRow) : null,
    };
  }

  listRuns(): WorkflowRun[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_runs ORDER BY created_at, id')
      .all() as RunRow[];
    return rows.map(mapRun);
  }

  findStepByMissionId(missionId: string): WorkflowStepRun | null {
    validateId(missionId, 'Mission');
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_step_runs
         WHERE mission_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(missionId) as StepRunRow | undefined;
    return row ? mapStepRun(row) : null;
  }

  /** Re-checks Import provenance without projecting it as Mission execution evidence. */
  verifyImportedArtifact(artifact: WorkflowArtifact): boolean {
    try {
      if (
        artifact.source !== 'IMPORTED_CONFIRMED' ||
        artifact.missionId !== null ||
        artifact.missionRunId !== null ||
        artifact.actorId !== null ||
        !artifact.importConfirmationId
      )
        return false;
      validateWorkflowImportedArtifact(artifact as WorkflowImportedArtifact);
      const record = this.db
        .prepare(
          `SELECT a.*, c.proposal_id, c.version_hash AS confirmation_version_hash,
             c.source_metadata_hash AS confirmation_source_hash,
             c.completed_step_ids_json, c.current_step_id, c.bindings_json, c.mapping_hash,
             c.created_at AS confirmation_created_at,
             p.status AS proposal_status, p.run_id AS proposal_run_id,
             p.definition_id, p.definition_version, p.version_hash AS proposal_version_hash,
             p.source_metadata_hash AS proposal_source_hash, p.sources_json, p.policy_version,
             r.definition_id AS run_definition_id, r.definition_version AS run_definition_version,
             version.content_hash AS frozen_version_hash,
             producer.step_id AS producer_step_id, producer.attempt AS producer_attempt,
             producer.state AS producer_state, producer.completion_origin,
             producer.mission_id, producer.mission_run_id,
             binding.key AS binding_key, binding.contract_id, binding.contract_version,
             binding.import_confirmation_id AS binding_confirmation_id
           FROM workflow_import_artifacts a
           JOIN workflow_import_confirmations c ON c.id = a.import_confirmation_id
           JOIN workflow_import_proposals p ON p.id = c.proposal_id
           JOIN workflow_runs r ON r.id = a.workflow_run_id
           JOIN workflow_versions version ON version.definition_id = r.definition_id
             AND version.version = r.definition_version
           JOIN workflow_step_runs producer ON producer.id = a.producer_step_run_id
             AND producer.workflow_run_id = a.workflow_run_id
           JOIN workflow_import_artifact_bindings binding ON binding.artifact_id = a.id
             AND binding.workflow_run_id = a.workflow_run_id AND binding.step_run_id = producer.id
             AND binding.role = 'OUTPUT'
           WHERE a.id = ? AND a.workflow_run_id = ? AND a.import_confirmation_id = ?`,
        )
        .get(artifact.id, artifact.workflowRunId, artifact.importConfirmationId) as
        | ({
            proposal_id: string;
            confirmation_version_hash: string;
            confirmation_source_hash: string;
            completed_step_ids_json: string;
            current_step_id: string;
            bindings_json: string;
            mapping_hash: string;
            confirmation_created_at: string;
            proposal_status: string;
            proposal_run_id: string | null;
            definition_id: string;
            definition_version: number;
            proposal_version_hash: string;
            proposal_source_hash: string;
            sources_json: string;
            policy_version: string;
            run_definition_id: string;
            run_definition_version: number;
            frozen_version_hash: string;
            producer_step_id: string;
            producer_attempt: number;
            producer_state: string;
            completion_origin: string;
            mission_id: string | null;
            mission_run_id: string | null;
            binding_key: string;
            contract_id: string;
            contract_version: string;
            binding_confirmation_id: string;
          } & ArtifactRow)
        | undefined;
      if (!record) return false;
      const confirmation = mapImportConfirmation({
        id: artifact.importConfirmationId,
        proposal_id: record.proposal_id,
        run_id: artifact.workflowRunId,
        version_hash: record.confirmation_version_hash,
        source_metadata_hash: record.confirmation_source_hash,
        completed_step_ids_json: record.completed_step_ids_json,
        current_step_id: record.current_step_id,
        bindings_json: record.bindings_json,
        mapping_hash: record.mapping_hash,
        created_at: record.confirmation_created_at,
      });
      const sources = JSON.parse(record.sources_json) as WorkflowImportSource[];
      const source = sources.find((candidate) => candidate.id === artifact.sourceId);
      const proposal: WorkflowImportProposal = {
        id: confirmation.proposalId,
        revision: 1,
        status: 'COMMITTED',
        definitionId: record.definition_id,
        version: record.definition_version,
        versionHash: record.proposal_version_hash,
        inputSnapshot: {},
        description: '',
        sources,
        resolution: {
          suggestedCompletedSteps: confirmation.completedStepIds,
          suggestedCurrentStep: confirmation.currentStepId,
          candidateArtifactBindings: confirmation.bindings,
          missingRequirements: [],
          confidence: 1,
          explanationSummary: '',
        },
        sourceMetadataHash: record.proposal_source_hash,
        policyVersion: record.policy_version,
        validationStatus: 'VALID',
        validationErrors: [],
        createdAt: confirmation.createdAt,
        updatedAt: confirmation.createdAt,
        runId: artifact.workflowRunId,
      };
      if (
        !source ||
        record.id !== artifact.id ||
        record.workflow_run_id !== artifact.workflowRunId ||
        record.producer_step_run_id !== artifact.producerStepRunId ||
        record.import_confirmation_id !== artifact.importConfirmationId ||
        record.binding_confirmation_id !== artifact.importConfirmationId ||
        record.source_id !== artifact.sourceId ||
        record.content !== artifact.content ||
        record.content_hash !== artifact.contentHash ||
        record.metadata_json !== canonicalJson(artifact.metadata) ||
        record.proposal_status !== 'COMMITTED' ||
        record.proposal_run_id !== artifact.workflowRunId ||
        record.definition_id !== record.run_definition_id ||
        record.definition_version !== record.run_definition_version ||
        record.proposal_version_hash !== record.confirmation_version_hash ||
        record.proposal_version_hash !== record.frozen_version_hash ||
        record.proposal_source_hash !== record.confirmation_source_hash ||
        record.policy_version !== 'w3-2-text-prefix-v1' ||
        workflowImportSourceMetadataHash(sources) !== record.confirmation_source_hash ||
        !confirmation.completedStepIds.includes(record.producer_step_id) ||
        record.producer_state !== 'COMPLETED' ||
        record.completion_origin !== 'IMPORTED_CONFIRMED' ||
        record.mission_id !== null || record.mission_run_id !== null ||
        source.content !== artifact.content ||
        source.contentHash !== artifact.metadata.sourceContentHash ||
        source.name !== artifact.metadata.sourceName ||
        source.kind !== artifact.kind ||
        source.size !== artifact.metadata.sizeBytes ||
        artifact.metadata.snapshot !== true ||
        artifact.metadata.importConfirmationId !== confirmation.id ||
        Object.keys(artifact.metadata).length !== 5
      )
        return false;
      validateWorkflowImportProposal(proposal);
      const mapping = confirmation.bindings.find(
        (candidate) =>
          candidate.stepId === record.producer_step_id &&
          candidate.outputKey === record.binding_key &&
          candidate.sourceId === artifact.sourceId,
      );
      if (!mapping) return false;
      const version = this.getVersion(record.definition_id, record.definition_version);
      const step = version?.steps.find((candidate) => candidate.id === record.producer_step_id);
      const spec = step?.outputs.find(
        (candidate) =>
          candidate.key === record.binding_key &&
          candidate.contractId === record.contract_id &&
          candidate.contractVersion === record.contract_version &&
          candidate.kind === artifact.kind,
      );
      if (!version || !step || !spec || step.type !== 'TASK' || step.effectType !== 'NONE' || step.exitCondition !== 'VALID_OUTPUTS')
        return false;
      const expectedValidatorVersion =
        spec.validator.type === 'REGISTRY'
          ? version.contractManifest?.find(
              (contract) =>
                contract.contractId === spec.contractId &&
                contract.contractVersion === spec.contractVersion,
            )?.validatorVersion
          : 'w1-inline-validator-v1';
      if (!expectedValidatorVersion) return false;
      return !!this.db
        .prepare(
          `SELECT 1 FROM workflow_import_validations validation
           WHERE validation.workflow_run_id = ? AND validation.step_run_id = ?
             AND validation.artifact_id = ? AND validation.contract_id = ?
             AND validation.contract_version = ? AND validation.validator_version = ?
             AND validation.content_hash = ? AND validation.valid = 1
             AND validation.import_confirmation_id = ?`,
        )
        .get(
          artifact.workflowRunId,
          artifact.producerStepRunId,
          artifact.id,
          spec.contractId,
          spec.contractVersion,
          expectedValidatorVersion,
          artifact.contentHash,
          confirmation.id,
        );
    } catch {
      return false;
    }
  }

  appendArtifact(value: WorkflowArtifact): void {
    if (value.source === 'IMPORTED_CONFIRMED')
      throw new Error('Imported Artifacts must be appended through the Import repository');
    validateArtifact(value);
    const expectedHash = sha256(
      canonicalJson({ content: value.content, metadata: value.metadata }),
    );
    if (value.contentHash !== expectedHash) {
      throw new Error('Workflow Artifact contentHash must hash its canonical content and metadata');
    }
    if (value.source === 'HUMAN_BRIDGE' && value.kind === 'FILE' && value.content !== '') {
      throw new Error('Human Bridge FILE Artifact does not copy external file contents');
    }
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workflow_artifacts
            (id, workflow_run_id, producer_step_run_id, mission_id, mission_run_id, actor_id,
             source_id, source, kind, content, content_hash, metadata_json, created_at)
           VALUES (@id, @workflowRunId, @producerStepRunId, @missionId, @missionRunId,
             @actorId, @sourceId, @source, @kind, @content, @contentHash, @metadataJson, @createdAt)`,
        )
        .run({
          ...value,
          metadataJson: canonicalJson(value.metadata),
        });
      const insertInput = this.db.prepare(
        'INSERT INTO workflow_artifact_inputs (artifact_id, input_artifact_id) VALUES (?, ?)',
      );
      const insertImportedInput = this.db.prepare(
        'INSERT INTO workflow_artifact_import_inputs (artifact_id, input_import_artifact_id) VALUES (?, ?)',
      );
      for (const inputArtifactId of value.inputArtifactIds) {
        const imported = this.db.prepare('SELECT 1 FROM workflow_import_artifacts WHERE id = ?').get(inputArtifactId);
        if (imported) insertImportedInput.run(value.id, inputArtifactId);
        else insertInput.run(value.id, inputArtifactId);
      }
    });
  }

  appendBinding(value: WorkflowArtifactBinding): void {
    validateBinding(value);
    const imported = this.db
      .prepare('SELECT import_confirmation_id FROM workflow_import_artifacts WHERE id = ? AND workflow_run_id = ?')
      .get(value.artifactId, value.workflowRunId) as { import_confirmation_id: string } | undefined;
    if (imported) {
      if (value.role !== 'INPUT')
        throw new Error('Imported output bindings must be appended through the Import repository');
      if (value.importConfirmationId && value.importConfirmationId !== imported.import_confirmation_id)
        throw new Error('Imported binding confirmation does not match the Artifact source fact');
      this.db
        .prepare(
          `INSERT INTO workflow_import_artifact_bindings
            (id, workflow_run_id, step_run_id, key, artifact_id, role,
             contract_id, contract_version, import_confirmation_id, created_at)
           VALUES (@id, @workflowRunId, @stepRunId, @key, @artifactId, 'INPUT',
             @contractId, @contractVersion, @importConfirmationId, @createdAt)`,
        )
        .run({ ...value, importConfirmationId: imported.import_confirmation_id });
      return;
    }
    if (value.importConfirmationId)
      throw new Error('Executed Artifact bindings cannot carry Import confirmation provenance');
    this.db
      .prepare(
        `INSERT INTO workflow_artifact_bindings
          (id, workflow_run_id, step_run_id, key, artifact_id, role, contract_id, contract_version, created_at)
         VALUES (@id, @workflowRunId, @stepRunId, @key, @artifactId, @role,
           @contractId, @contractVersion, @createdAt)`,
      )
      .run({
        id: value.id,
        workflowRunId: value.workflowRunId,
        stepRunId: value.stepRunId,
        key: value.key,
        artifactId: value.artifactId,
        role: value.role,
        contractId: value.contractId,
        contractVersion: value.contractVersion,
        createdAt: value.createdAt,
      });
  }

  appendValidation(value: WorkflowValidationReceipt): void {
    validateValidation(value);
    if (this.db.prepare('SELECT 1 FROM workflow_import_artifacts WHERE id = ?').get(value.artifactId))
      throw new Error('Imported validations must be appended through the Import repository');
    const result = this.db
      .prepare(
        `INSERT INTO workflow_validation_receipts
          (id, workflow_run_id, step_run_id, artifact_id, contract_id, contract_version,
           validator_version, content_hash, valid, errors_json, created_at)
         SELECT @id, sr.workflow_run_id, @stepRunId, @artifactId, @contractId, @contractVersion,
           @validatorVersion, @contentHash, @valid, @errorsJson, @createdAt
         FROM workflow_step_runs AS sr WHERE sr.id = @stepRunId`,
      )
      .run({
        ...value,
        valid: value.valid ? 1 : 0,
        errorsJson: canonicalJson(value.errors),
      });
    if (result.changes !== 1) {
      throw new Error('Workflow validation receipt must reference an existing StepRun');
    }
  }

  appendFinalValidation(value: WorkflowFinalValidation): void {
    validateFinalValidation(value);
    const run = this.db
      .prepare(
        'SELECT definition_id, definition_version, input_snapshot_json FROM workflow_runs WHERE id = ?',
      )
      .get(value.workflowRunId) as
      | { definition_id: string; definition_version: number; input_snapshot_json: string }
      | undefined;
    if (!run) throw new Error('Workflow final validation must reference an existing Run');
    if (run.definition_version !== value.definitionVersion) {
      throw new Error('Workflow final validation must match its pinned version');
    }
    const expectedInputHash = sha256(
      canonicalJson(JSON.parse(run.input_snapshot_json) as WorkflowInputs),
    );
    if (value.inputHash !== expectedInputHash) {
      throw new Error('Workflow final validation inputHash must match the frozen Run inputs');
    }
    this.db
      .prepare(
        `INSERT INTO workflow_run_output_validations
          (id, workflow_run_id, definition_version, input_hash, state_hash,
           output_bindings_json, valid, errors_json, created_at)
         VALUES (@id, @workflowRunId, @definitionVersion, @inputHash, @stateHash,
           @outputBindings, @valid, @errors, @createdAt)`,
      )
      .run({
        id: value.id,
        workflowRunId: value.workflowRunId,
        definitionVersion: value.definitionVersion,
        inputHash: value.inputHash,
        stateHash: value.stateHash,
        outputBindings: canonicalJson(value.outputBindings),
        valid: value.valid ? 1 : 0,
        errors: canonicalJson(value.errors),
        createdAt: value.createdAt,
      });
  }

  appendDecision(value: WorkflowDecisionFact): void {
    validateDecision(value);
    this.db
      .prepare(
        `INSERT INTO workflow_decisions
          (id, workflow_run_id, step_run_id, edge_id, branch, input_hash, created_at)
         VALUES (@id, @workflowRunId, @stepRunId, @edgeId, @branch, @inputHash, @createdAt)`,
      )
      .run({
        id: value.id,
        workflowRunId: value.workflowRunId,
        stepRunId: value.stepRunId,
        edgeId: value.edgeId,
        branch: value.branch,
        inputHash: value.inputHash,
        createdAt: value.createdAt,
      });
  }

  appendCheckpoint(value: WorkflowCheckpoint): void {
    validateCheckpoint(value);
    this.db
      .prepare(
        `INSERT INTO workflow_checkpoints
          (id, workflow_run_id, sequence, definition_version, completed_step_run_ids_json,
           active_step_run_ids_json, artifact_binding_hashes_json, decision_hashes_json, state_hash, created_at)
         VALUES (@id, @workflowRunId, @sequence, @definitionVersion, @completedStepRunIds,
           @activeStepRunIds, @artifactBindingHashes, @decisionHashes, @stateHash, @createdAt)`,
      )
      .run({
        id: value.id,
        workflowRunId: value.workflowRunId,
        sequence: value.sequence,
        definitionVersion: value.definitionVersion,
        completedStepRunIds: canonicalJson(value.completedStepRunIds),
        activeStepRunIds: canonicalJson(value.activeStepRunIds),
        artifactBindingHashes: canonicalJson(value.artifactBindingHashes),
        decisionHashes: canonicalJson(value.decisionHashes),
        stateHash: value.stateHash,
        createdAt: value.createdAt,
      });
  }

  appendEvent(value: WorkflowEvent): void {
    validateEvent(value);
    this.db
      .prepare(
        `INSERT INTO workflow_events
          (id, workflow_run_id, step_run_id, type, payload_json, created_at)
         VALUES (@id, @workflowRunId, @stepRunId, @type, @payloadJson, @createdAt)`,
      )
      .run({
        id: value.id,
        workflowRunId: value.workflowRunId,
        stepRunId: value.stepRunId,
        type: value.type,
        payloadJson: canonicalJson(value.payload),
        createdAt: value.createdAt,
      });
  }
}

function mapRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    definitionId: row.definition_id,
    definitionVersion: row.definition_version,
    inputSnapshot: JSON.parse(row.input_snapshot_json) as WorkflowInputs,
    state: row.state,
    waitReason: row.wait_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFinalValidation(row: FinalValidationRow): WorkflowFinalValidation {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    definitionVersion: row.definition_version,
    inputHash: row.input_hash,
    stateHash: row.state_hash,
    outputBindings: JSON.parse(
      row.output_bindings_json,
    ) as WorkflowFinalValidation['outputBindings'],
    valid: row.valid === 1,
    errors: JSON.parse(row.errors_json) as string[],
    createdAt: row.created_at,
  };
}

function mapStepRun(row: StepRunRow): WorkflowStepRun {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    completionOrigin: row.completion_origin,
    state: row.state,
    missionId: row.mission_id,
    missionRunId: row.mission_run_id,
    workspaceRoot: row.workspace_root,
    waitReason: row.wait_reason,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifact(row: ArtifactRow, inputArtifactIds: string[]): WorkflowArtifact {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    producerStepRunId: row.producer_step_run_id,
    missionId: row.mission_id,
    missionRunId: row.mission_run_id,
    actorId: row.actor_id,
    sourceId: row.source_id,
    source: row.source,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    metadata: JSON.parse(row.metadata_json) as WorkflowArtifact['metadata'],
    ...(row.import_confirmation_id ? { importConfirmationId: row.import_confirmation_id } : {}),
    inputArtifactIds,
    createdAt: row.created_at,
  };
}

function mapImportedArtifact(row: ImportedArtifactRow, inputArtifactIds: string[]): WorkflowArtifact {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    producerStepRunId: row.producer_step_run_id,
    missionId: null,
    missionRunId: null,
    actorId: null,
    sourceId: row.source_id,
    source: 'IMPORTED_CONFIRMED',
    importConfirmationId: row.import_confirmation_id,
    kind: row.kind,
    content: row.content,
    contentHash: row.content_hash,
    metadata: JSON.parse(row.metadata_json) as WorkflowArtifact['metadata'],
    inputArtifactIds,
    createdAt: row.created_at,
  };
}

function mapBinding(row: BindingRow): WorkflowArtifactBinding {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    key: row.key,
    artifactId: row.artifact_id,
    role: row.role,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    createdAt: row.created_at,
    ...(row.import_confirmation_id ? { importConfirmationId: row.import_confirmation_id } : {}),
  };
}

function mapImportConfirmation(row: ImportConfirmationRow): WorkflowImportConfirmation {
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

function mapValidation(row: ValidationRow): WorkflowValidationReceipt {
  return {
    id: row.id,
    stepRunId: row.step_run_id,
    artifactId: row.artifact_id,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    validatorVersion: row.validator_version,
    contentHash: row.content_hash,
    valid: row.valid === 1,
    errors: JSON.parse(row.errors_json) as string[],
    createdAt: row.created_at,
  };
}

function mapDecision(row: DecisionRow): WorkflowDecisionFact {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    edgeId: row.edge_id,
    branch: row.branch,
    inputHash: row.input_hash,
    createdAt: row.created_at,
  };
}

function mapCheckpoint(row: CheckpointRow): WorkflowCheckpoint {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    sequence: row.sequence,
    definitionVersion: row.definition_version,
    completedStepRunIds: JSON.parse(row.completed_step_run_ids_json) as string[],
    activeStepRunIds: JSON.parse(row.active_step_run_ids_json) as string[],
    artifactBindingHashes: JSON.parse(row.artifact_binding_hashes_json) as string[],
    decisionHashes: JSON.parse(row.decision_hashes_json) as string[],
    stateHash: row.state_hash,
    createdAt: row.created_at,
  };
}

function mapEvent(row: EventRow): WorkflowEvent {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as WorkflowEvent['payload'],
    createdAt: row.created_at,
  };
}

function validateRun(value: WorkflowRun): void {
  validateId(value.id, 'Workflow Run');
  validateId(value.definitionId, 'Workflow definition');
  if (!Number.isInteger(value.definitionVersion) || value.definitionVersion < 1) {
    throw new Error('Invalid Workflow definition version');
  }
  validateTimestamp(value.createdAt);
  validateTimestamp(value.updatedAt);
  if (
    value.waitReason !== null &&
    !['APPROVAL', 'EXTERNAL_WORK', 'USER_CONFIRMATION', 'MISSION', 'DECISION'].includes(
      value.waitReason,
    )
  ) {
    throw new Error('Invalid Workflow wait reason');
  }
}

function validateFinalValidation(value: WorkflowFinalValidation): void {
  validateId(value.id, 'Workflow final validation');
  validateId(value.workflowRunId, 'Workflow Run');
  if (!Number.isInteger(value.definitionVersion) || value.definitionVersion < 1) {
    throw new Error('Invalid Workflow final validation version');
  }
  validateHash(value.inputHash, 'Workflow final validation inputHash');
  validateHash(value.stateHash, 'Workflow final validation stateHash');
  if (typeof value.valid !== 'boolean') throw new Error('Invalid Workflow final validation status');
  if (!Array.isArray(value.outputBindings) || value.outputBindings.length > 12) {
    throw new Error('Workflow final validation has too many output bindings');
  }
  const outputKeys = new Set<string>();
  for (const binding of value.outputBindings) {
    if (
      binding === null ||
      typeof binding !== 'object' ||
      Object.keys(binding).some((key) => !['key', 'artifactId', 'contentHash'].includes(key))
    ) {
      throw new Error('Invalid Workflow final output binding');
    }
    validateText(binding.key, 'Workflow final output key', 128);
    validateId(binding.artifactId, 'Workflow final output Artifact');
    validateHash(binding.contentHash, 'Workflow final output contentHash');
    if (outputKeys.has(binding.key)) throw new Error('Duplicate Workflow final output binding');
    outputKeys.add(binding.key);
  }
  if (!Array.isArray(value.errors) || value.errors.length > 64) {
    throw new Error('Workflow final validation has too many errors');
  }
  if (value.valid && value.errors.length > 0) {
    throw new Error('Valid Workflow final validation cannot contain errors');
  }
  for (const error of value.errors)
    validateText(error, 'Workflow final validation error', 512, true);
  validateTimestamp(value.createdAt);
}

function validateStepRun(value: WorkflowStepRun): void {
  validateId(value.id, 'Workflow StepRun');
  validateId(value.workflowRunId, 'Workflow Run');
  validateId(value.stepId, 'Workflow Step');
  if (!Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 5) {
    throw new Error('Invalid Workflow StepRun attempt');
  }
  validateNullableText(value.missionId, 'Mission id', MAX_ID);
  validateNullableText(value.missionRunId, 'Mission Run id', MAX_ID);
  validateNullableText(value.workspaceRoot ?? null, 'Workflow workspace root', 4096);
  validateNullableText(value.errorCode, 'Workflow StepRun error code', 128);
  validateTimestamp(value.createdAt);
  validateTimestamp(value.updatedAt);
  if (
    value.completionOrigin !== undefined &&
    !['EXECUTED', 'IMPORTED_CONFIRMED'].includes(value.completionOrigin)
  )
    throw new Error('Invalid Workflow StepRun completion origin');
}

function validateArtifact(value: WorkflowArtifact): void {
  validateId(value.id, 'Workflow Artifact');
  validateId(value.workflowRunId, 'Workflow Run');
  validateId(value.producerStepRunId, 'Workflow StepRun');
  if (value.missionId === null || value.missionRunId === null || value.actorId === null)
    throw new Error('Mission-backed Workflow Artifacts require Mission, Mission Run, and actor ids');
  validateId(value.missionId, 'Mission');
  validateId(value.missionRunId, 'Mission Run');
  validateId(value.actorId, 'Workflow Artifact actor');
  validateId(value.sourceId, 'Workflow Artifact source');
  validateTimestamp(value.createdAt);
  validateText(value.content, 'Workflow Artifact content', MAX_ARTIFACT_CONTENT_BYTES, true);
  if (!Array.isArray(value.inputArtifactIds) || value.inputArtifactIds.length > 384) {
    throw new Error('Workflow Artifact lineage is too large');
  }
  if (new Set(value.inputArtifactIds).size !== value.inputArtifactIds.length) {
    throw new Error('Duplicate Workflow Artifact input lineage');
  }
  for (const inputId of value.inputArtifactIds) validateId(inputId, 'Workflow input Artifact');
  validateMetadata(value.metadata, MAX_METADATA_BYTES);
  if (value.source === 'MISSION' && !['TEXT', 'JSON', 'FILE', 'DIRECTORY'].includes(value.kind)) {
    throw new Error('MISSION artifacts must be coordinator result text or JSON');
  }
  if (value.source === 'MISSION' && value.kind === 'FILE') {
    requireMetadataString(value.metadata, 'path');
    requireMetadataString(value.metadata, 'evidenceEventId');
    requireMetadataNumber(value.metadata, 'sizeBytes');
    if (!SHA256.test(requireMetadataString(value.metadata, 'contentHash')) || value.content !== '')
      throw new Error('Workflow FILE needs inspected hash and durable execution provenance');
  }
  if (
    value.source === 'MISSION' &&
    value.kind === 'DIRECTORY' &&
    value.metadata.inspectedManifest !== 1
  )
    throw new Error('Workflow manifest needs canonical inspection provenance');
  if (value.source === 'HUMAN_BRIDGE' && value.kind === 'FILE') {
    requireMetadataString(value.metadata, 'path');
    requireMetadataString(value.metadata, 'fileName');
    requireMetadataString(value.metadata, 'extension');
    requireMetadataNumber(value.metadata, 'sizeBytes');
    requireMetadataString(value.metadata, 'targetArtifactId');
    const externalHash = requireMetadataString(value.metadata, 'contentHash');
    if (!SHA256.test(externalHash))
      throw new Error('Human Bridge file contentHash must be SHA-256 hex');
    if (value.content !== '')
      throw new Error('Human Bridge FILE Artifact does not copy external file contents');
  }
  const hash = sha256(canonicalJson({ content: value.content, metadata: value.metadata }));
  if (value.contentHash !== hash)
    throw new Error(
      'Workflow Artifact contentHash does not match its canonical content and metadata',
    );
}

function validateBinding(value: WorkflowArtifactBinding): void {
  validateId(value.id, 'Workflow Artifact binding');
  validateId(value.workflowRunId, 'Workflow Run');
  validateId(value.stepRunId, 'Workflow StepRun');
  validateId(value.artifactId, 'Workflow Artifact');
  validateText(value.key, 'Workflow Artifact binding key', 128);
  validateText(value.contractId, 'Workflow contract id', 256);
  validateText(value.contractVersion, 'Workflow contract version', 128);
  validateTimestamp(value.createdAt);
}

function validateValidation(value: WorkflowValidationReceipt): void {
  validateId(value.id, 'Workflow validation receipt');
  validateId(value.stepRunId, 'Workflow StepRun');
  validateId(value.artifactId, 'Workflow Artifact');
  validateText(value.contractId, 'Workflow contract id', 256);
  validateText(value.contractVersion, 'Workflow contract version', 128);
  validateText(value.validatorVersion, 'Workflow validator version', 128);
  validateHash(value.contentHash, 'Workflow validation contentHash');
  if (value.valid && value.errors.length > 0)
    throw new Error('Valid Workflow receipts cannot contain errors');
  if (value.errors.length > 64) throw new Error('Workflow validation receipt has too many errors');
  for (const error of value.errors) validateText(error, 'Workflow validation error', 512, true);
  validateTimestamp(value.createdAt);
}

function validateDecision(value: WorkflowDecisionFact): void {
  validateId(value.id, 'Workflow decision');
  validateId(value.workflowRunId, 'Workflow Run');
  validateId(value.stepRunId, 'Workflow StepRun');
  validateId(value.edgeId, 'Workflow edge');
  validateText(value.branch, 'Workflow decision branch', 128);
  validateHash(value.inputHash, 'Workflow decision inputHash');
  validateTimestamp(value.createdAt);
}

function validateCheckpoint(value: WorkflowCheckpoint): void {
  validateId(value.id, 'Workflow checkpoint');
  validateId(value.workflowRunId, 'Workflow Run');
  if (
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isInteger(value.definitionVersion) ||
    value.definitionVersion < 1
  ) {
    throw new Error('Invalid Workflow checkpoint sequence or version');
  }
  validateIdArray(value.completedStepRunIds, 32, 'completed StepRuns');
  validateIdArray(value.activeStepRunIds, 32, 'active StepRuns');
  if (
    new Set(value.completedStepRunIds).size !== value.completedStepRunIds.length ||
    new Set(value.activeStepRunIds).size !== value.activeStepRunIds.length
  ) {
    throw new Error('Duplicate Workflow checkpoint StepRun');
  }
  if (value.artifactBindingHashes.length > 384 || value.decisionHashes.length > 32) {
    throw new Error('Workflow checkpoint metadata is too large');
  }
  for (const hash of value.artifactBindingHashes)
    validateHash(hash, 'Workflow artifact binding hash');
  for (const hash of value.decisionHashes) validateHash(hash, 'Workflow decision hash');
  validateHash(value.stateHash, 'Workflow checkpoint stateHash');
  validateTimestamp(value.createdAt);
}

function validateEvent(value: WorkflowEvent): void {
  validateId(value.id, 'Workflow event');
  validateId(value.workflowRunId, 'Workflow Run');
  validateNullableText(value.stepRunId, 'Workflow StepRun', MAX_ID);
  validateText(value.type, 'Workflow event type', 128);
  const keys = Object.keys(value.payload);
  if (keys.length > 32) throw new Error('Workflow event metadata has too many fields');
  for (const key of keys) {
    validateText(key, 'Workflow event key', 128);
    if (PRIVATE_MEMORY_KEY.test(key))
      throw new Error('Workflow event cannot contain privateMemory metadata');
    const field = value.payload[key];
    if (typeof field === 'string') validateText(field, 'Workflow event text metadata', 256, true);
    else if (typeof field === 'number' && !Number.isFinite(field))
      throw new Error('Workflow event number must be finite');
  }
  if (Buffer.byteLength(canonicalJson(value.payload), 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error('Workflow event metadata is too large');
  }
  validateTimestamp(value.createdAt);
}

function validateMetadata(metadata: WorkflowArtifact['metadata'], maxBytes: number): void {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object') {
    throw new Error('Workflow Artifact metadata must be an object');
  }
  const entries = Object.entries(metadata);
  if (entries.length > 32) throw new Error('Workflow Artifact metadata has too many fields');
  for (const [key, value] of entries) {
    validateText(key, 'Workflow Artifact metadata key', 128);
    if (PRIVATE_MEMORY_KEY.test(key))
      throw new Error('Workflow Artifact metadata cannot contain privateMemory');
    if (typeof value === 'string')
      validateText(value, 'Workflow Artifact metadata value', 2048, true);
    else if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Workflow Artifact metadata number must be finite');
    else if (typeof value === 'boolean') continue;
    else if (typeof value !== 'number')
      throw new Error('Workflow Artifact metadata values must be scalar');
  }
  if (Buffer.byteLength(canonicalJson(metadata), 'utf8') > maxBytes) {
    throw new Error('Workflow Artifact metadata is too large');
  }
}

function requireMetadataString(metadata: WorkflowArtifact['metadata'], key: string): string {
  const value = metadata[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Human Bridge FILE metadata requires ${key}`);
  return value;
}

function requireMetadataNumber(metadata: WorkflowArtifact['metadata'], key: string): number {
  const value = metadata[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Human Bridge FILE metadata requires numeric ${key}`);
  }
  return value;
}

function validateIdArray(values: string[], max: number, name: string): void {
  if (values.length > max) throw new Error(`Workflow checkpoint ${name} are too large`);
  for (const id of values) validateId(id, name);
}

function validateHash(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`${name} must be SHA-256 hex`);
}

function validateId(value: string, name: string): void {
  validateText(value, `${name} id`, MAX_ID);
}

function validateTimestamp(value: string): void {
  validateText(value, 'Workflow timestamp', MAX_TIMESTAMP);
}

function validateNullableText(value: string | null, name: string, max: number): void {
  if (value !== null) validateText(value, name, max, true);
}

function validateText(value: string, name: string, max: number, allowEmpty = false): void {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(
      `${name} must be ${allowEmpty ? 'at most' : 'a non-empty value up to'} ${max} characters`,
    );
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
