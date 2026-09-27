import type Database from 'better-sqlite3';
import type { TeammateRecord } from './index.js';

export type CapabilityDimension =
  | 'GENERAL_REASONING'
  | 'LONG_CONTEXT_REASONING'
  | 'AGENTIC_EXECUTION'
  | 'CODING'
  | 'TOOL_USE'
  | 'VISUAL_UNDERSTANDING'
  | 'IMAGE_GENERATION'
  | 'IMAGE_EDITING'
  | 'VIDEO_GENERATION'
  | 'VIDEO_EDITING'
  | 'SPEECH_UNDERSTANDING'
  | 'SPEECH_GENERATION'
  | 'SPEECH_TO_SPEECH'
  | 'MUSIC_GENERATION';

export interface ModelCapabilityBenchmarkRecord {
  id: string;
  runtimeProfileId: string;
  modelAlias: string;
  dimension: CapabilityDimension;
  supported: boolean;
  normalizedScore: number | null;
  rawScore: number | null;
  source: string;
  benchmark: string;
  benchmarkVersion: string;
  snapshotDate: string;
  sourceUrl: string | null;
  provenanceType: 'CATALOG' | 'USER_OVERRIDE' | 'USER_ESTIMATE';
}

export interface TeammateCapabilityStateRecord {
  teammateId: string;
  dimension: CapabilityDimension;
  currentScore: number;
  evidenceWeight: number;
  ratingCount: number;
  currentRuntimeProfileId: string | null;
  updatedAt: string;
}

export interface CapabilityEvidenceRecord {
  id: string;
  teammateId: string;
  runtimeProfileId: string | null;
  missionId: string;
  runId: string;
  dimension: CapabilityDimension;
  sourceType: 'USER_DIMENSION_RATING' | 'USER_OVERALL_RATING';
  ratingValue: number;
  demandWeight: number;
  evidenceWeight: number;
  createdAt: string;
}

export interface DecisionReceiptRecord {
  id: string;
  missionId: string | null;
  runId: string | null;
  decisionType: string;
  provider: string;
  model: string;
  modelVersion: string;
  questionVersion: string;
  stateHash: string;
  inputSummary: string;
  answersJson: Record<string, unknown>;
  confidenceJson: Record<string, unknown>;
  policyVersion: string;
  selectedAction: string | null;
  mode: 'SHADOW' | 'ADVISORY' | 'ACTIVE';
  createdAt: string;
}

export type ExternalWorkRequestState =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED';

export interface ExternalWorkRequestRecord {
  id: string;
  missionId: string;
  runId: string;
  requesterTeammateId: string;
  assigneeTeammateId: string;
  capability: CapabilityDimension;
  title: string;
  prompt: string;
  requirementsJson: Record<string, unknown>;
  targetArtifactsJson: Record<string, unknown>;
  acceptanceCriteriaJson: Record<string, unknown>;
  state: ExternalWorkRequestState;
  createdAt: string;
  submittedAt: string | null;
  resolvedAt: string | null;
}

export interface ExternalWorkArtifactRecord {
  id: string;
  externalWorkRequestId: string;
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  mimeType: string | null;
  metadataJson: Record<string, unknown>;
  submittedAt: string;
}

export interface ExternalAppProfileRecord {
  id: string;
  teammateId: string;
  name: string;
  vendor: string | null;
  capabilities: CapabilityDimension[];
  notes: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnsureHumanBridgeInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface ModelCapabilityBenchmarkRow {
  id: string;
  runtime_profile_id: string;
  model_alias: string;
  dimension: CapabilityDimension;
  supported: number;
  normalized_score: number | null;
  raw_score: number | null;
  source: string;
  benchmark: string;
  benchmark_version: string;
  snapshot_date: string;
  source_url: string | null;
  provenance_type: ModelCapabilityBenchmarkRecord['provenanceType'];
}

interface TeammateCapabilityStateRow {
  teammate_id: string;
  dimension: CapabilityDimension;
  current_score: number;
  evidence_weight: number;
  rating_count: number;
  current_runtime_profile_id: string | null;
  updated_at: string;
}

interface CapabilityEvidenceRow {
  id: string;
  teammate_id: string;
  runtime_profile_id: string | null;
  mission_id: string;
  run_id: string;
  dimension: CapabilityDimension;
  source_type: CapabilityEvidenceRecord['sourceType'];
  rating_value: number;
  demand_weight: number;
  evidence_weight: number;
  created_at: string;
}

interface DecisionReceiptRow {
  id: string;
  mission_id: string | null;
  run_id: string | null;
  decision_type: string;
  provider: string;
  model: string;
  model_version: string;
  question_version: string;
  state_hash: string;
  input_summary: string;
  answers_json: string;
  confidence_json: string;
  policy_version: string;
  selected_action: string | null;
  mode: DecisionReceiptRecord['mode'];
  created_at: string;
}

interface ExternalWorkRequestRow {
  id: string;
  mission_id: string;
  run_id: string;
  requester_teammate_id: string;
  assignee_teammate_id: string;
  capability: CapabilityDimension;
  title: string;
  prompt: string;
  requirements_json: string;
  target_artifacts_json: string;
  acceptance_criteria_json: string;
  state: ExternalWorkRequestState;
  created_at: string;
  submitted_at: string | null;
  resolved_at: string | null;
}

interface ExternalWorkArtifactRow {
  id: string;
  external_work_request_id: string;
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  mime_type: string | null;
  metadata_json: string;
  submitted_at: string;
}

interface ExternalAppProfileRow {
  id: string;
  teammate_id: string;
  name: string;
  vendor: string | null;
  capabilities_json: string;
  notes: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Durable R0 routing facts; this repository does not make routing decisions. */
export class R0SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  saveModelCapabilityBenchmark(value: ModelCapabilityBenchmarkRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_capability_benchmarks
          (id, runtime_profile_id, model_alias, dimension, supported, normalized_score, raw_score,
           source, benchmark, benchmark_version, snapshot_date, source_url, provenance_type)
         VALUES
          (@id, @runtimeProfileId, @modelAlias, @dimension, @supported, @normalizedScore, @rawScore,
           @source, @benchmark, @benchmarkVersion, @snapshotDate, @sourceUrl, @provenanceType)`,
      )
      .run({ ...value, supported: value.supported ? 1 : 0 });
  }

  getModelCapabilityBenchmark(id: string): ModelCapabilityBenchmarkRecord | null {
    const row = this.db
      .prepare('SELECT * FROM model_capability_benchmarks WHERE id = ?')
      .get(id) as ModelCapabilityBenchmarkRow | undefined;
    return row ? mapModelCapabilityBenchmark(row) : null;
  }

  listModelCapabilityBenchmarks(
    runtimeProfileId: string,
    modelAlias?: string,
  ): ModelCapabilityBenchmarkRecord[] {
    const rows = modelAlias
      ? (this.db
          .prepare(
            `SELECT * FROM model_capability_benchmarks
             WHERE runtime_profile_id = ? AND model_alias = ?
             ORDER BY dimension, snapshot_date DESC, id`,
          )
          .all(runtimeProfileId, modelAlias) as ModelCapabilityBenchmarkRow[])
      : (this.db
          .prepare(
            `SELECT * FROM model_capability_benchmarks
             WHERE runtime_profile_id = ? ORDER BY model_alias, dimension, snapshot_date DESC, id`,
          )
          .all(runtimeProfileId) as ModelCapabilityBenchmarkRow[]);
    return rows.map(mapModelCapabilityBenchmark);
  }

  saveTeammateCapabilityState(value: TeammateCapabilityStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO teammate_capability_states
          (teammate_id, dimension, current_score, evidence_weight, rating_count,
           current_runtime_profile_id, updated_at)
         VALUES
          (@teammateId, @dimension, @currentScore, @evidenceWeight, @ratingCount,
           @currentRuntimeProfileId, @updatedAt)
         ON CONFLICT(teammate_id, dimension) DO UPDATE SET
           current_score=excluded.current_score, evidence_weight=excluded.evidence_weight,
           rating_count=excluded.rating_count,
           current_runtime_profile_id=excluded.current_runtime_profile_id,
           updated_at=excluded.updated_at`,
      )
      .run(value);
  }

  getTeammateCapabilityState(
    teammateId: string,
    dimension: CapabilityDimension,
  ): TeammateCapabilityStateRecord | null {
    const row = this.db
      .prepare('SELECT * FROM teammate_capability_states WHERE teammate_id = ? AND dimension = ?')
      .get(teammateId, dimension) as TeammateCapabilityStateRow | undefined;
    return row ? mapTeammateCapabilityState(row) : null;
  }

  listTeammateCapabilityStates(teammateId: string): TeammateCapabilityStateRecord[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM teammate_capability_states WHERE teammate_id = ? ORDER BY dimension',
        )
        .all(teammateId) as TeammateCapabilityStateRow[]
    ).map(mapTeammateCapabilityState);
  }

  appendCapabilityEvidence(value: CapabilityEvidenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO capability_evidence
          (id, teammate_id, runtime_profile_id, mission_id, run_id, dimension, source_type,
           rating_value, demand_weight, evidence_weight, created_at)
         VALUES
          (@id, @teammateId, @runtimeProfileId, @missionId, @runId, @dimension, @sourceType,
           @ratingValue, @demandWeight, @evidenceWeight, @createdAt)`,
      )
      .run(value);
  }

  listCapabilityEvidence(
    teammateId: string,
    dimension?: CapabilityDimension,
  ): CapabilityEvidenceRecord[] {
    const rows = dimension
      ? (this.db
          .prepare(
            `SELECT * FROM capability_evidence
             WHERE teammate_id = ? AND dimension = ? ORDER BY created_at, id`,
          )
          .all(teammateId, dimension) as CapabilityEvidenceRow[])
      : (this.db
          .prepare(
            'SELECT * FROM capability_evidence WHERE teammate_id = ? ORDER BY created_at, id',
          )
          .all(teammateId) as CapabilityEvidenceRow[]);
    return rows.map(mapCapabilityEvidence);
  }

  appendDecisionReceipt(value: DecisionReceiptRecord): void {
    this.db
      .prepare(
        `INSERT INTO decision_receipts
          (id, mission_id, run_id, decision_type, provider, model, model_version,
           question_version, state_hash, input_summary, answers_json, confidence_json,
           policy_version, selected_action, mode, created_at)
         VALUES
          (@id, @missionId, @runId, @decisionType, @provider, @model, @modelVersion,
           @questionVersion, @stateHash, @inputSummary, @answersJson, @confidenceJson,
           @policyVersion, @selectedAction, @mode, @createdAt)`,
      )
      .run({
        ...value,
        answersJson: JSON.stringify(value.answersJson),
        confidenceJson: JSON.stringify(value.confidenceJson),
      });
  }

  getDecisionReceipt(id: string): DecisionReceiptRecord | null {
    const row = this.db.prepare('SELECT * FROM decision_receipts WHERE id = ?').get(id) as
      | DecisionReceiptRow
      | undefined;
    return row ? mapDecisionReceipt(row) : null;
  }

  listDecisionReceipts(missionId?: string, runId?: string): DecisionReceiptRecord[] {
    let sql = 'SELECT * FROM decision_receipts';
    const filters: string[] = [];
    const parameters: string[] = [];
    if (missionId !== undefined) {
      filters.push('mission_id = ?');
      parameters.push(missionId);
    }
    if (runId !== undefined) {
      filters.push('run_id = ?');
      parameters.push(runId);
    }
    if (filters.length > 0) sql += ` WHERE ${filters.join(' AND ')}`;
    sql += ' ORDER BY created_at, id';
    return (this.db.prepare(sql).all(...parameters) as DecisionReceiptRow[]).map(
      mapDecisionReceipt,
    );
  }

  createExternalWorkRequest(value: ExternalWorkRequestRecord): ExternalWorkRequestRecord {
    this.db
      .prepare(
        `INSERT INTO external_work_requests
          (id, mission_id, run_id, requester_teammate_id, assignee_teammate_id, capability,
           title, prompt, requirements_json, target_artifacts_json, acceptance_criteria_json,
           state, created_at, submitted_at, resolved_at)
         VALUES
          (@id, @missionId, @runId, @requesterTeammateId, @assigneeTeammateId, @capability,
           @title, @prompt, @requirementsJson, @targetArtifactsJson, @acceptanceCriteriaJson,
           @state, @createdAt, @submittedAt, @resolvedAt)`,
      )
      .run({
        ...value,
        requirementsJson: JSON.stringify(value.requirementsJson),
        targetArtifactsJson: JSON.stringify(value.targetArtifactsJson),
        acceptanceCriteriaJson: JSON.stringify(value.acceptanceCriteriaJson),
      });
    return this.getExternalWorkRequest(value.id)!;
  }

  getExternalWorkRequest(id: string): ExternalWorkRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM external_work_requests WHERE id = ?').get(id) as
      | ExternalWorkRequestRow
      | undefined;
    return row ? mapExternalWorkRequest(row) : null;
  }

  listExternalWorkRequests(missionId?: string, runId?: string): ExternalWorkRequestRecord[] {
    let sql = 'SELECT * FROM external_work_requests';
    const filters: string[] = [];
    const parameters: string[] = [];
    if (missionId !== undefined) {
      filters.push('mission_id = ?');
      parameters.push(missionId);
    }
    if (runId !== undefined) {
      filters.push('run_id = ?');
      parameters.push(runId);
    }
    if (filters.length > 0) sql += ` WHERE ${filters.join(' AND ')}`;
    sql += ' ORDER BY created_at, id';
    return (this.db.prepare(sql).all(...parameters) as ExternalWorkRequestRow[]).map(
      mapExternalWorkRequest,
    );
  }

  transitionExternalWorkRequest(
    id: string,
    state: ExternalWorkRequestState,
    at: string,
  ): ExternalWorkRequestRecord | null {
    const current = this.getExternalWorkRequest(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE external_work_requests SET
           state = @state,
           submitted_at = CASE
             WHEN @state = 'SUBMITTED' THEN @at
             WHEN @state = 'IN_PROGRESS' AND state = 'REJECTED' THEN NULL
             ELSE submitted_at
           END,
           resolved_at = CASE
             WHEN @state IN ('ACCEPTED', 'REJECTED', 'CANCELLED') THEN @at
             WHEN @state = 'IN_PROGRESS' THEN NULL
             ELSE resolved_at
           END
         WHERE id = @id`,
      )
      .run({ id, state, at });
    return this.getExternalWorkRequest(id);
  }

  appendExternalWorkArtifact(value: ExternalWorkArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO external_work_artifacts
          (id, external_work_request_id, path, file_name, extension, size_bytes, mime_type,
           metadata_json, submitted_at)
         VALUES
          (@id, @externalWorkRequestId, @path, @fileName, @extension, @sizeBytes, @mimeType,
           @metadataJson, @submittedAt)`,
      )
      .run({ ...value, metadataJson: JSON.stringify(value.metadataJson) });
  }

  listExternalWorkArtifacts(externalWorkRequestId: string): ExternalWorkArtifactRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM external_work_artifacts
           WHERE external_work_request_id = ? ORDER BY submitted_at, id`,
        )
        .all(externalWorkRequestId) as ExternalWorkArtifactRow[]
    ).map(mapExternalWorkArtifact);
  }

  saveExternalAppProfile(value: ExternalAppProfileRecord): void {
    this.db
      .prepare(
        `INSERT INTO external_app_profiles
          (id, teammate_id, name, vendor, capabilities_json, notes, enabled, created_at, updated_at)
         VALUES
          (@id, @teammateId, @name, @vendor, @capabilitiesJson, @notes, @enabled, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, vendor=excluded.vendor, capabilities_json=excluded.capabilities_json,
           notes=excluded.notes, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run({
        ...value,
        capabilitiesJson: JSON.stringify(value.capabilities),
        enabled: value.enabled ? 1 : 0,
      });
  }

  listExternalAppProfiles(teammateId: string): ExternalAppProfileRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM external_app_profiles
           WHERE teammate_id = ? ORDER BY name COLLATE NOCASE, id`,
        )
        .all(teammateId) as ExternalAppProfileRow[]
    ).map(mapExternalAppProfile);
  }

  ensureHumanBridgeTeammate(input: EnsureHumanBridgeInput): TeammateRecord {
    const existing = this.db
      .prepare("SELECT * FROM teammates WHERE system_kind = 'HUMAN_BRIDGE'")
      .get() as TeammateRow | undefined;
    if (existing) return mapTeammate(existing);

    this.db
      .prepare(
        `INSERT INTO teammates
          (id, name, description, identity_prompt, behavior_prompt, status, realm,
           current_runtime_profile_id, executor_kind, routing_policy, system_kind,
           created_at, updated_at)
         VALUES
          (@id, '本尊 / Human Bridge', '', '', '', 'ACTIVE', 'QI_REFINING', NULL,
           'USER_BRIDGE', 'FALLBACK_ONLY', 'HUMAN_BRIDGE', @createdAt, @updatedAt)
         ON CONFLICT DO NOTHING`,
      )
      .run(input);
    const ensured = this.db
      .prepare("SELECT * FROM teammates WHERE system_kind = 'HUMAN_BRIDGE'")
      .get() as TeammateRow | undefined;
    if (!ensured) {
      throw new Error(
        `Cannot ensure Human Bridge teammate because teammate id ${input.id} is already in use`,
      );
    }
    return mapTeammate(ensured);
  }
}

function mapModelCapabilityBenchmark(
  row: ModelCapabilityBenchmarkRow,
): ModelCapabilityBenchmarkRecord {
  return {
    id: row.id,
    runtimeProfileId: row.runtime_profile_id,
    modelAlias: row.model_alias,
    dimension: row.dimension,
    supported: row.supported === 1,
    normalizedScore: row.normalized_score,
    rawScore: row.raw_score,
    source: row.source,
    benchmark: row.benchmark,
    benchmarkVersion: row.benchmark_version,
    snapshotDate: row.snapshot_date,
    sourceUrl: row.source_url,
    provenanceType: row.provenance_type,
  };
}

function mapTeammateCapabilityState(
  row: TeammateCapabilityStateRow,
): TeammateCapabilityStateRecord {
  return {
    teammateId: row.teammate_id,
    dimension: row.dimension,
    currentScore: row.current_score,
    evidenceWeight: row.evidence_weight,
    ratingCount: row.rating_count,
    currentRuntimeProfileId: row.current_runtime_profile_id,
    updatedAt: row.updated_at,
  };
}

function mapCapabilityEvidence(row: CapabilityEvidenceRow): CapabilityEvidenceRecord {
  return {
    id: row.id,
    teammateId: row.teammate_id,
    runtimeProfileId: row.runtime_profile_id,
    missionId: row.mission_id,
    runId: row.run_id,
    dimension: row.dimension,
    sourceType: row.source_type,
    ratingValue: row.rating_value,
    demandWeight: row.demand_weight,
    evidenceWeight: row.evidence_weight,
    createdAt: row.created_at,
  };
}

function mapDecisionReceipt(row: DecisionReceiptRow): DecisionReceiptRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    decisionType: row.decision_type,
    provider: row.provider,
    model: row.model,
    modelVersion: row.model_version,
    questionVersion: row.question_version,
    stateHash: row.state_hash,
    inputSummary: row.input_summary,
    answersJson: JSON.parse(row.answers_json) as Record<string, unknown>,
    confidenceJson: JSON.parse(row.confidence_json) as Record<string, unknown>,
    policyVersion: row.policy_version,
    selectedAction: row.selected_action,
    mode: row.mode,
    createdAt: row.created_at,
  };
}

function mapExternalWorkRequest(row: ExternalWorkRequestRow): ExternalWorkRequestRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    requesterTeammateId: row.requester_teammate_id,
    assigneeTeammateId: row.assignee_teammate_id,
    capability: row.capability,
    title: row.title,
    prompt: row.prompt,
    requirementsJson: JSON.parse(row.requirements_json) as Record<string, unknown>,
    targetArtifactsJson: JSON.parse(row.target_artifacts_json) as Record<string, unknown>,
    acceptanceCriteriaJson: JSON.parse(row.acceptance_criteria_json) as Record<string, unknown>,
    state: row.state,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
  };
}

function mapExternalWorkArtifact(row: ExternalWorkArtifactRow): ExternalWorkArtifactRecord {
  return {
    id: row.id,
    externalWorkRequestId: row.external_work_request_id,
    path: row.path,
    fileName: row.file_name,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    metadataJson: JSON.parse(row.metadata_json) as Record<string, unknown>,
    submittedAt: row.submitted_at,
  };
}

function mapExternalAppProfile(row: ExternalAppProfileRow): ExternalAppProfileRecord {
  return {
    id: row.id,
    teammateId: row.teammate_id,
    name: row.name,
    vendor: row.vendor,
    capabilities: JSON.parse(row.capabilities_json) as CapabilityDimension[],
    notes: row.notes,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTeammate(row: TeammateRow): TeammateRecord {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    title: row.title,
    description: row.description,
    identityPrompt: row.identity_prompt,
    behaviorPrompt: row.behavior_prompt,
    status: row.status,
    realm: row.realm,
    currentRuntimeProfileId: row.current_runtime_profile_id,
    executorKind: row.executor_kind,
    routingPolicy: row.routing_policy,
    systemKind: row.system_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface TeammateRow {
  id: string;
  name: string;
  avatar: string | null;
  title: string | null;
  description: string;
  identity_prompt: string;
  behavior_prompt: string;
  status: TeammateRecord['status'];
  realm: TeammateRecord['realm'];
  current_runtime_profile_id: string | null;
  executor_kind: TeammateRecord['executorKind'];
  routing_policy: TeammateRecord['routingPolicy'];
  system_kind: TeammateRecord['systemKind'];
  created_at: string;
  updated_at: string;
}
