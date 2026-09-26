import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { canTransition } from '@cultivation/domain';
import type {
  ApprovalRequest,
  AuditEvent,
  Mission,
  MissionEvent,
  MissionRun,
  MissionState,
  PermissionRule,
  UsageRecord,
} from '@cultivation/domain';

interface MissionRow {
  id: string;
  title: string;
  objective: string;
  initiator_type: Mission['initiatorType'];
  initiator_id: string;
  coordinator_teammate_id: string;
  party_id: string | null;
  mode: Mission['mode'];
  state: MissionState;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface MissionRunRow {
  id: string;
  mission_id: string;
  attempt: number;
  status: MissionRun['status'];
  started_at: string;
  ended_at: string | null;
  error_code: string | null;
  error_message: string | null;
  result_text: string | null;
}

interface ApprovalRow {
  id: string;
  mission_id: string;
  run_id: string;
  requester_teammate_id: string;
  capability: ApprovalRequest['capability'];
  action_type: string;
  action_payload_json: string;
  risk_level: ApprovalRequest['riskLevel'];
  state: ApprovalRequest['state'];
  created_at: string;
  resolved_at: string | null;
}

interface MissionEventRow {
  id: string;
  mission_id: string;
  run_id: string | null;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: string;
  created_at: string;
}

interface AuditEventRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload_json: string;
  created_at: string;
}

interface PermissionRuleRow {
  id: string;
  subject_type: PermissionRule['subjectType'];
  subject_id: string;
  capability: PermissionRule['capability'];
  resource_pattern: string;
  decision: PermissionRule['decision'];
  scope: PermissionRule['scope'];
  scope_id: string | null;
}

interface UsageRow {
  id: string;
  mission_id: string | null;
  run_id: string | null;
  teammate_id: string;
  runtime_profile_id: string;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  provider_metadata_json: string | null;
  estimated_cost: number | null;
  currency: string | null;
  created_at: string;
}

/** Gate 3 Main-process repository for Missions, independent Runs, and audit history. */
export class Gate3SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  listMissions(): Mission[] {
    return (
      this.db.prepare('SELECT * FROM missions ORDER BY updated_at DESC, id').all() as MissionRow[]
    ).map(mapMission);
  }

  getMission(id: string): Mission | null {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as
      | MissionRow
      | undefined;
    return row ? mapMission(row) : null;
  }

  /** Initial Gate 3 Mission creation is limited to a SOLO DRAFT. */
  insertMission(value: Mission): void {
    if (value.state !== 'DRAFT' || value.mode !== 'SOLO' || value.partyId !== null) {
      throw new Error('New Gate 3 Missions must be SOLO DRAFT records without a Party');
    }
    this.db
      .prepare(
        `INSERT INTO missions
          (id, title, objective, initiator_type, initiator_id, coordinator_teammate_id,
           party_id, mode, state, created_at, updated_at, completed_at)
         VALUES
          (@id, @title, @objective, @initiatorType, @initiatorId, @coordinatorTeammateId,
           @partyId, @mode, @state, @createdAt, @updatedAt, @completedAt)`,
      )
      .run(toMissionParams(value));
  }

  /** Updates editable DRAFT details with state as a compare-and-swap guard. */
  updateMissionDetails(value: Mission): boolean {
    if (value.mode !== 'SOLO' || value.partyId !== null) return false;
    return (
      this.db
        .prepare(
          `UPDATE missions
           SET title = ?, objective = ?, coordinator_teammate_id = ?, updated_at = ?
           WHERE id = ? AND state IN ('DRAFT', 'READY') AND state = ?`,
        )
        .run(
          value.title,
          value.objective,
          value.coordinatorTeammateId,
          value.updatedAt,
          value.id,
          value.state,
        ).changes > 0
    );
  }

  /** CAS Mission state through the domain state machine; details cannot be changed here. */
  transitionMission(value: Mission, expected: MissionState): boolean {
    if (!canTransition(expected, value.state)) {
      throw new Error(`Illegal Mission state transition: ${expected} -> ${value.state}`);
    }
    return (
      this.db
        .prepare(
          `UPDATE missions SET state = ?, updated_at = ?, completed_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(value.state, value.updatedAt, value.completedAt, value.id, expected).changes > 0
    );
  }

  listRunningMissions(): Mission[] {
    return (
      this.db
        .prepare("SELECT * FROM missions WHERE state = 'RUNNING' ORDER BY updated_at, id")
        .all() as MissionRow[]
    ).map(mapMission);
  }

  listRuns(missionId: string): MissionRun[] {
    return (
      this.db
        .prepare('SELECT * FROM mission_runs WHERE mission_id = ? ORDER BY attempt, id')
        .all(missionId) as MissionRunRow[]
    ).map(mapMissionRun);
  }

  getRun(id: string): MissionRun | null {
    const row = this.db.prepare('SELECT * FROM mission_runs WHERE id = ?').get(id) as
      | MissionRunRow
      | undefined;
    return row ? mapMissionRun(row) : null;
  }

  createRun(missionId: string, startedAt: string): MissionRun {
    return this.transaction(() => {
      const mission = this.getMission(missionId);
      if (!mission || mission.state !== 'RUNNING') {
        throw new Error('A Mission must be RUNNING before a Run is created');
      }
      const attempt = this.db
        .prepare(
          'SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM mission_runs WHERE mission_id = ?',
        )
        .get(missionId) as { attempt: number };
      const run: MissionRun = {
        id: randomUUID(),
        missionId,
        attempt: attempt.attempt,
        status: 'RUNNING',
        startedAt,
        endedAt: null,
        errorCode: null,
        errorMessage: null,
        resultText: null,
      };
      this.db
        .prepare(
          `INSERT INTO mission_runs
            (id, mission_id, attempt, status, started_at, ended_at,
             error_code, error_message, result_text)
           VALUES (@id, @missionId, @attempt, @status, @startedAt, @endedAt,
             @errorCode, @errorMessage, @resultText)`,
        )
        .run(run);
      return run;
    });
  }

  /** Updates only a RUNNING row and preserves every previous attempt. */
  finishRun(value: MissionRun): boolean {
    if (value.status === 'RUNNING' || value.endedAt === null) return false;
    return (
      this.db
        .prepare(
          `UPDATE mission_runs
           SET status = ?, ended_at = ?, error_code = ?, error_message = ?, result_text = ?
           WHERE id = ? AND mission_id = ? AND status = 'RUNNING'`,
        )
        .run(
          value.status,
          value.endedAt,
          value.errorCode,
          value.errorMessage,
          value.resultText,
          value.id,
          value.missionId,
        ).changes > 0
    );
  }

  insertApproval(value: ApprovalRequest): void {
    if (value.state !== 'PENDING' || value.resolvedAt !== null) {
      throw new Error('New ApprovalRequests must be PENDING');
    }
    this.db
      .prepare(
        `INSERT INTO approval_requests
          (id, mission_id, run_id, requester_teammate_id, capability, action_type,
           action_payload_json, risk_level, state, created_at, resolved_at)
         VALUES (@id, @missionId, @runId, @requesterTeammateId, @capability, @actionType,
           @actionPayloadJson, @riskLevel, @state, @createdAt, @resolvedAt)`,
      )
      .run({
        id: value.id,
        missionId: value.missionId,
        runId: value.runId,
        requesterTeammateId: value.requesterTeammateId,
        capability: value.capability,
        actionType: value.actionType,
        actionPayloadJson: JSON.stringify(value.actionPayload),
        riskLevel: value.riskLevel,
        state: value.state,
        createdAt: value.createdAt,
        resolvedAt: value.resolvedAt,
      });
  }

  getApproval(id: string): ApprovalRequest | null {
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    return row ? mapApproval(row) : null;
  }

  listApprovals(missionId: string): ApprovalRequest[] {
    return (
      this.db
        .prepare('SELECT * FROM approval_requests WHERE mission_id = ? ORDER BY created_at, id')
        .all(missionId) as ApprovalRow[]
    ).map(mapApproval);
  }

  resolveApproval(
    id: string,
    decision: 'APPROVED' | 'DENIED' | 'CANCELLED',
    at: string,
  ): ApprovalRequest | null {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE approval_requests SET state = ?, resolved_at = ?
           WHERE id = ? AND state = 'PENDING' AND resolved_at IS NULL`,
        )
        .run(decision, at, id);
      if (result.changes === 0) return null;
      return this.getApproval(id);
    });
  }

  listPermissionRules(
    subjectType: PermissionRule['subjectType'],
    subjectId: string,
    capability: PermissionRule['capability'],
  ): PermissionRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM permission_rules
         WHERE subject_type = ? AND subject_id = ? AND capability = ?
         ORDER BY scope, scope_id, id`,
      )
      .all(subjectType, subjectId, capability) as PermissionRuleRow[];
    return rows.map(mapPermissionRule);
  }

  savePermissionRule(value: PermissionRule): void {
    this.db
      .prepare(
        `INSERT INTO permission_rules
          (id, subject_type, subject_id, capability, resource_pattern, decision, scope, scope_id)
         VALUES (@id, @subjectType, @subjectId, @capability, @resourcePattern, @decision, @scope, @scopeId)
         ON CONFLICT(id) DO UPDATE SET
           subject_type=excluded.subject_type, subject_id=excluded.subject_id,
           capability=excluded.capability, resource_pattern=excluded.resource_pattern,
           decision=excluded.decision, scope=excluded.scope, scope_id=excluded.scope_id`,
      )
      .run(value);
  }

  listMissionEvents(missionId: string): MissionEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at, id')
        .all(missionId) as MissionEventRow[]
    ).map(mapMissionEvent);
  }

  appendMissionEvent(value: MissionEvent): void {
    this.db
      .prepare(
        `INSERT INTO mission_events
          (id, mission_id, run_id, event_type, actor_type, actor_id, payload_json, created_at)
         VALUES (@id, @missionId, @runId, @eventType, @actorType, @actorId, @payloadJson, @createdAt)`,
      )
      .run({ ...value, payloadJson: JSON.stringify(value.payloadJson) });
  }

  listAuditEvents(missionId: string): AuditEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM audit_events
           WHERE (target_type = 'MISSION' AND target_id = ?)
              OR (target_type = 'MISSION_RUN' AND target_id IN
                (SELECT id FROM mission_runs WHERE mission_id = ?))
           ORDER BY created_at, id`,
        )
        .all(missionId, missionId) as AuditEventRow[]
    ).map(mapAuditEvent);
  }

  appendAuditEvent(value: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
          (id, actor_type, actor_id, action, target_type, target_id, payload_json, created_at)
         VALUES (@id, @actorType, @actorId, @action, @targetType, @targetId, @payloadJson, @createdAt)`,
      )
      .run({ ...value, payloadJson: JSON.stringify(value.payloadJson) });
  }

  listMissionUsage(missionId: string): UsageRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM usage_records WHERE mission_id = ? ORDER BY created_at, id')
        .all(missionId) as UsageRow[]
    ).map(mapUsage);
  }

  /** Usage rows are append-only through this API; duplicate IDs fail instead of overwriting. */
  saveUsage(value: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_records
          (id, mission_id, run_id, teammate_id, runtime_profile_id, provider, model,
           input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
           provider_metadata_json, estimated_cost, currency, created_at)
         VALUES (@id, @missionId, @runId, @teammateId, @runtimeProfileId, @provider, @model,
           @inputTokens, @outputTokens, @cachedInputTokens, @reasoningTokens,
           @providerMetadataJson, @estimatedCost, @currency, @createdAt)`,
      )
      .run({
        id: value.id,
        missionId: value.missionId,
        runId: value.runId,
        teammateId: value.teammateId,
        runtimeProfileId: value.runtimeProfileId,
        provider: value.provider,
        model: value.model,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        cachedInputTokens: value.cachedInputTokens,
        reasoningTokens: value.reasoningTokens,
        providerMetadataJson: value.providerMetadata
          ? JSON.stringify(value.providerMetadata)
          : null,
        estimatedCost: value.estimatedCost,
        currency: value.currency,
        createdAt: value.createdAt,
      });
  }

  /** better-sqlite3 supports nested transactions via savepoints for composed services. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function toMissionParams(value: Mission): Record<string, unknown> {
  return {
    id: value.id,
    title: value.title,
    objective: value.objective,
    initiatorType: value.initiatorType,
    initiatorId: value.initiatorId,
    coordinatorTeammateId: value.coordinatorTeammateId,
    partyId: value.partyId,
    mode: value.mode,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  };
}

function mapMission(row: MissionRow): Mission {
  return {
    id: row.id,
    title: row.title,
    objective: row.objective,
    initiatorType: row.initiator_type,
    initiatorId: row.initiator_id,
    coordinatorTeammateId: row.coordinator_teammate_id,
    partyId: row.party_id,
    mode: row.mode,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapMissionRun(row: MissionRunRow): MissionRun {
  return {
    id: row.id,
    missionId: row.mission_id,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultText: row.result_text,
  };
}

function mapApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    requesterTeammateId: row.requester_teammate_id,
    capability: row.capability,
    actionType: row.action_type,
    actionPayload: JSON.parse(row.action_payload_json) as Record<string, unknown>,
    riskLevel: row.risk_level,
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapPermissionRule(row: PermissionRuleRow): PermissionRule {
  const base = {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    capability: row.capability,
    resourcePattern: row.resource_pattern,
    decision: row.decision,
  } as const;
  if (row.scope === 'GLOBAL') return { ...base, scope: 'GLOBAL', scopeId: null };
  if (row.scope_id === null) throw new Error('Stored scoped PermissionRule is missing scope_id');
  return { ...base, scope: row.scope, scopeId: row.scope_id };
}

function mapMissionEvent(row: MissionEventRow): MissionEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    payloadJson: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    payloadJson: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function mapUsage(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    teammateId: row.teammate_id,
    runtimeProfileId: row.runtime_profile_id,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningTokens: row.reasoning_tokens,
    providerMetadata: row.provider_metadata_json
      ? (JSON.parse(row.provider_metadata_json) as Record<string, unknown>)
      : null,
    estimatedCost: row.estimated_cost,
    currency: row.currency,
    createdAt: row.created_at,
  };
}
