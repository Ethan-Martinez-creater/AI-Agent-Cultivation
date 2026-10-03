import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export type WorkspaceMutationState = 'PREPARED' | 'APPLIED' | 'UNKNOWN';

export interface WorkspaceMutationIntent {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  operationReceiptId: string;
  attempt: number;
  missionId: string;
  missionRunId: string;
  teammateId: string;
  toolCallId: string;
  toolId: 'file.writeText';
  permissionResource: string;
  workspaceTag: string;
  relativePath: string;
  beforeHash: string | null;
  expectedAfterHash: string;
  observedAfterHash: string | null;
  state: WorkspaceMutationState;
  resultCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceVerificationFact {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  attempt: number;
  missionId: string;
  missionRunId: string;
  actorId: string;
  toolCallId: string;
  commandId: string;
  toolId: string;
  command: string;
  commandHash: string;
  exitStatus: number;
  criterionIds: string[];
  outputHash: string;
  createdAt: string;
}

interface MutationRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string;
  operation_receipt_id: string;
  attempt: number;
  mission_id: string;
  mission_run_id: string;
  teammate_id: string;
  tool_call_id: string;
  tool_id: 'file.writeText';
  permission_resource: string;
  workspace_tag: string;
  relative_path: string;
  before_hash: string | null;
  expected_after_hash: string;
  observed_after_hash: string | null;
  state: WorkspaceMutationState;
  result_code: string | null;
  created_at: string;
  updated_at: string;
}

interface VerificationRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string;
  attempt: number;
  mission_id: string;
  mission_run_id: string;
  actor_id: string;
  tool_call_id: string;
  command_id: string;
  tool_id: string;
  command: string;
  command_hash: string;
  exit_status: number;
  criterion_ids_json: string;
  output_hash: string;
  created_at: string;
}

interface OperationRow {
  id: string;
  attempt: number;
  effect_type: string;
  state: string;
}

const SHA256 = /^[a-f0-9]{64}$/;

/** Durable, Main-only facts for dynamic Workspace mutations and command verification. */
export class W22WorkspaceMutationRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getOperation(
    workflowRunId: string,
    stepRunId: string,
  ): {
    id: string;
    attempt: number;
    effectType: string;
    state: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, attempt, effect_type, state FROM workflow_step_operation_receipts
         WHERE workflow_run_id = ? AND step_run_id = ? ORDER BY attempt DESC LIMIT 1`,
      )
      .get(workflowRunId, stepRunId) as OperationRow | undefined;
    return row
      ? { id: row.id, attempt: row.attempt, effectType: row.effect_type, state: row.state }
      : null;
  }

  prepareMutation(value: WorkspaceMutationIntent): {
    intent: WorkspaceMutationIntent;
    created: boolean;
  } {
    validateMutation(value);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT * FROM workflow_workspace_mutation_journal
           WHERE workflow_run_id = ? AND step_run_id = ? AND attempt = ? AND tool_call_id = ?`,
        )
        .get(value.workflowRunId, value.stepRunId, value.attempt, value.toolCallId) as
        | MutationRow
        | undefined;
      if (prior) {
        const current = mapMutation(prior);
        if (!sameMutationIdentity(current, value))
          throw new Error('Workspace mutation Tool Call identity changed');
        return { intent: current, created: false };
      }
      this.db
        .prepare(
          `INSERT INTO workflow_workspace_mutation_journal (
            id, workflow_run_id, step_run_id, operation_receipt_id, attempt,
            mission_id, mission_run_id, teammate_id, tool_call_id, tool_id,
            permission_resource, workspace_tag, relative_path, before_hash,
            expected_after_hash, observed_after_hash, state, result_code,
            created_at, updated_at
          ) VALUES (
            @id, @workflowRunId, @stepRunId, @operationReceiptId, @attempt,
            @missionId, @missionRunId, @teammateId, @toolCallId, @toolId,
            @permissionResource, @workspaceTag, @relativePath, @beforeHash,
            @expectedAfterHash, @observedAfterHash, @state, @resultCode,
            @createdAt, @updatedAt
          )`,
        )
        .run(mutationValues(value));
      return { intent: value, created: true };
    });
  }

  transitionMutation(
    value: WorkspaceMutationIntent,
    expectedState: WorkspaceMutationState,
  ): boolean {
    validateMutation(value);
    if (expectedState !== 'PREPARED' || !['APPLIED', 'UNKNOWN'].includes(value.state))
      throw new Error('Invalid Workspace mutation state transition');
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM workflow_workspace_mutation_journal WHERE id = ?')
        .get(value.id) as MutationRow | undefined;
      if (!row) return false;
      const current = mapMutation(row);
      if (!sameMutationIdentity(current, value))
        throw new Error('Workspace mutation identity and intent are immutable');
      if (current.state !== expectedState) return false;
      const result = this.db
        .prepare(
          `UPDATE workflow_workspace_mutation_journal
           SET observed_after_hash = @observedAfterHash, state = @state,
               result_code = @resultCode, updated_at = @updatedAt
           WHERE id = @id AND state = @expectedState`,
        )
        .run({
          id: value.id,
          observedAfterHash: value.observedAfterHash,
          state: value.state,
          resultCode: value.resultCode,
          updatedAt: value.updatedAt,
          expectedState,
        });
      return result.changes === 1;
    });
  }

  listMutations(input: {
    workflowRunId: string;
    stepRunId: string;
    missionRunId?: string;
  }): WorkspaceMutationIntent[] {
    const rows = input.missionRunId
      ? (this.db
          .prepare(
            `SELECT * FROM workflow_workspace_mutation_journal
             WHERE workflow_run_id = ? AND step_run_id = ? AND mission_run_id = ?
             ORDER BY created_at, id`,
          )
          .all(input.workflowRunId, input.stepRunId, input.missionRunId) as MutationRow[])
      : (this.db
          .prepare(
            `SELECT * FROM workflow_workspace_mutation_journal
             WHERE workflow_run_id = ? AND step_run_id = ? ORDER BY created_at, id`,
          )
          .all(input.workflowRunId, input.stepRunId) as MutationRow[]);
    return rows.map(mapMutation);
  }

  listRunMutations(workflowRunId: string): WorkspaceMutationIntent[] {
    if (!validId(workflowRunId)) throw new Error('Workflow Run id is invalid');
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_workspace_mutation_journal
         WHERE workflow_run_id = ? ORDER BY created_at, id`,
      )
      .all(workflowRunId) as MutationRow[];
    return rows.map(mapMutation);
  }

  appendVerificationFact(value: WorkspaceVerificationFact): WorkspaceVerificationFact {
    validateVerification(value);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT * FROM workflow_verification_facts
           WHERE workflow_run_id = ? AND step_run_id = ? AND attempt = ? AND tool_call_id = ?`,
        )
        .get(value.workflowRunId, value.stepRunId, value.attempt, value.toolCallId) as
        | VerificationRow
        | undefined;
      if (prior) {
        const current = mapVerification(prior);
        if (JSON.stringify(current) !== JSON.stringify(value))
          throw new Error('Verification Tool Call is already bound to different evidence');
        return current;
      }
      this.db
        .prepare(
          `INSERT INTO workflow_verification_facts (
            id, workflow_run_id, step_run_id, attempt, mission_id, mission_run_id,
            actor_id, tool_call_id, command_id, tool_id, command, command_hash, exit_status,
            criterion_ids_json, output_hash, created_at
          ) VALUES (
            @id, @workflowRunId, @stepRunId, @attempt, @missionId, @missionRunId,
            @actorId, @toolCallId, @commandId, @toolId, @command, @commandHash, @exitStatus,
            @criterionIdsJson, @outputHash, @createdAt
          )`,
        )
        .run(verificationValues(value));
      return value;
    });
  }

  listVerificationFacts(stepRunId: string): WorkspaceVerificationFact[] {
    if (!validId(stepRunId)) throw new Error('Workflow StepRun id is invalid');
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_verification_facts WHERE step_run_id = ?
         ORDER BY created_at, id`,
      )
      .all(stepRunId) as VerificationRow[];
    return rows.map(mapVerification);
  }
}

function validateMutation(value: WorkspaceMutationIntent): void {
  if (
    ![
      value.id,
      value.workflowRunId,
      value.stepRunId,
      value.operationReceiptId,
      value.missionId,
      value.missionRunId,
      value.teammateId,
      value.toolCallId,
    ].every(validId) ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 5 ||
    value.toolId !== 'file.writeText' ||
    value.permissionResource.length > 512 ||
    value.workspaceTag.length < 8 ||
    value.workspaceTag.length > 64 ||
    !/^[a-f0-9]+$/i.test(value.workspaceTag) ||
    !safeRelativePath(value.relativePath) ||
    (value.beforeHash !== null && !SHA256.test(value.beforeHash)) ||
    !SHA256.test(value.expectedAfterHash) ||
    (value.observedAfterHash !== null && !SHA256.test(value.observedAfterHash)) ||
    !['PREPARED', 'APPLIED', 'UNKNOWN'].includes(value.state) ||
    (value.state === 'PREPARED' &&
      (value.observedAfterHash !== null || value.resultCode !== null)) ||
    (value.state === 'APPLIED' && value.observedAfterHash !== value.expectedAfterHash) ||
    (value.state === 'UNKNOWN' && value.resultCode === null)
  )
    throw new Error('Workspace mutation intent is invalid');
  validateTimestamp(value.createdAt);
  validateTimestamp(value.updatedAt);
}

function validateVerification(value: WorkspaceVerificationFact): void {
  if (
    ![
      value.id,
      value.workflowRunId,
      value.stepRunId,
      value.missionId,
      value.missionRunId,
      value.actorId,
      value.toolCallId,
      value.commandId,
      value.toolId,
    ].every(validId) ||
    typeof value.command !== 'string' ||
    value.command.trim() !== value.command ||
    value.command.length < 1 ||
    value.command.length > 512 ||
    !SHA256.test(value.commandHash) ||
    value.commandHash !== hash(value.command) ||
    !Number.isSafeInteger(value.exitStatus) ||
    value.exitStatus < -1 ||
    value.exitStatus > 255 ||
    !Array.isArray(value.criterionIds) ||
    value.criterionIds.length < 1 ||
    value.criterionIds.length > 32 ||
    new Set(value.criterionIds).size !== value.criterionIds.length ||
    !value.criterionIds.every((id) => validId(id) && id.length <= 128) ||
    !SHA256.test(value.outputHash)
  )
    throw new Error('Verification fact is invalid');
  validateTimestamp(value.createdAt);
}

function mutationValues(value: WorkspaceMutationIntent): Record<string, unknown> {
  return {
    ...value,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function verificationValues(value: WorkspaceVerificationFact): Record<string, unknown> {
  return { ...value, criterionIdsJson: JSON.stringify(value.criterionIds) };
}

function mapMutation(row: MutationRow): WorkspaceMutationIntent {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    operationReceiptId: row.operation_receipt_id,
    attempt: row.attempt,
    missionId: row.mission_id,
    missionRunId: row.mission_run_id,
    teammateId: row.teammate_id,
    toolCallId: row.tool_call_id,
    toolId: row.tool_id,
    permissionResource: row.permission_resource,
    workspaceTag: row.workspace_tag,
    relativePath: row.relative_path,
    beforeHash: row.before_hash,
    expectedAfterHash: row.expected_after_hash,
    observedAfterHash: row.observed_after_hash,
    state: row.state,
    resultCode: row.result_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVerification(row: VerificationRow): WorkspaceVerificationFact {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    attempt: row.attempt,
    missionId: row.mission_id,
    missionRunId: row.mission_run_id,
    actorId: row.actor_id,
    toolCallId: row.tool_call_id,
    commandId: row.command_id,
    toolId: row.tool_id,
    command: row.command,
    commandHash: row.command_hash,
    exitStatus: row.exit_status,
    criterionIds: JSON.parse(row.criterion_ids_json) as string[],
    outputHash: row.output_hash,
    createdAt: row.created_at,
  };
}

function sameMutationIdentity(
  left: WorkspaceMutationIntent,
  right: WorkspaceMutationIntent,
): boolean {
  const keys = [
    'id',
    'workflowRunId',
    'stepRunId',
    'operationReceiptId',
    'attempt',
    'missionId',
    'missionRunId',
    'teammateId',
    'toolCallId',
    'toolId',
    'permissionResource',
    'workspaceTag',
    'relativePath',
    'beforeHash',
    'expectedAfterHash',
    'createdAt',
  ] as const;
  return keys.every((key) => left[key] === right[key]);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    normalized === value &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:/.test(normalized) &&
    !normalized
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  );
}

function validId(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function validateTimestamp(value: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Timestamp is invalid');
}
