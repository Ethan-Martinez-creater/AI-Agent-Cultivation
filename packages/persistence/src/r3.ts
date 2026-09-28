import Database from 'better-sqlite3';
import type { DecisionReceipt } from '@cultivation/domain';

export interface DecisionProviderConfigRecord {
  id: 'TYPESAFE';
  provider: 'TYPESAFE';
  model: 'jev-1.13.0';
  enabled: boolean;
  mode: 'SHADOW';
  /** Encrypted safeStorage bytes. Main-process use only; never expose to Renderer. */
  apiKeyCiphertext: Uint8Array | null;
  createdAt: string;
  updatedAt: string;
}

export type DecisionProviderConfigWrite = Pick<
  DecisionProviderConfigRecord,
  'enabled' | 'mode' | 'apiKeyCiphertext' | 'updatedAt'
>;

/** Renderer-safe config metadata; it deliberately contains no key bytes or plaintext. */
export type DecisionProviderConfigStatus = Omit<
  DecisionProviderConfigRecord,
  'apiKeyCiphertext'
> & { hasCredential: boolean };

export interface DecisionShadowPolicyConfigRecord {
  id: 'default';
  enabled: boolean;
  mode: 'SHADOW';
  questionVersion: string;
  policyVersion: string;
  maxStateBytes: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export type DecisionShadowPolicyConfigWrite = Pick<
  DecisionShadowPolicyConfigRecord,
  | 'enabled'
  | 'mode'
  | 'questionVersion'
  | 'policyVersion'
  | 'maxStateBytes'
  | 'timeoutMs'
  | 'updatedAt'
>;

export type DecisionShadowAttemptStatus = 'SUCCESS' | 'ERROR' | 'SKIPPED';
export type DecisionShadowErrorCode =
  | 'DISABLED'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'SCHEMA_MISMATCH'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

/** Sanitized attempt metadata only; never persist provider messages or raw errors here. */
export interface DecisionShadowAttemptRecord {
  id: string;
  missionId: string | null;
  runId: string | null;
  decisionType: string;
  provider: 'TYPESAFE';
  model: 'jev-1.13.0';
  status: DecisionShadowAttemptStatus;
  receiptId: string | null;
  actualAction: string | null;
  errorCode: DecisionShadowErrorCode | null;
  latencyMs: number | null;
  inputTokens: number | null;
  createdAt: string;
}

/** R3 appends only SHADOW receipts; existing R0 rows can still be read by the old adapter. */
export interface R3DecisionReceiptRecord extends Omit<DecisionReceipt, 'mode'> {
  mode: 'SHADOW';
  actualAction: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
}

interface DecisionProviderConfigRow {
  id: 'TYPESAFE';
  provider: 'TYPESAFE';
  model: 'jev-1.13.0';
  enabled: number;
  mode: 'SHADOW';
  api_key_ciphertext: Buffer | null;
  created_at: string;
  updated_at: string;
}

interface DecisionShadowPolicyConfigRow {
  id: 'default';
  enabled: number;
  mode: 'SHADOW';
  question_version: string;
  policy_version: string;
  max_state_bytes: number;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
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
  actual_action: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  mode: 'SHADOW';
  created_at: string;
}

interface DecisionShadowAttemptRow {
  id: string;
  mission_id: string | null;
  run_id: string | null;
  decision_type: string;
  provider: 'TYPESAFE';
  model: 'jev-1.13.0';
  status: DecisionShadowAttemptStatus;
  receipt_id: string | null;
  actual_action: string | null;
  error_code: DecisionShadowErrorCode | null;
  latency_ms: number | null;
  input_tokens: number | null;
  created_at: string;
}

/** Persistence only: never chooses or applies an action. Intended for Main/application use. */
export class R3SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  getDecisionProviderConfig(): DecisionProviderConfigRecord {
    const row = this.db
      .prepare("SELECT * FROM decision_provider_configs WHERE id = 'TYPESAFE'")
      .get() as DecisionProviderConfigRow | undefined;
    if (!row) throw new Error('Typesafe decision provider config is missing');
    return mapProviderConfig(row);
  }

  getDecisionProviderStatus(): DecisionProviderConfigStatus {
    const { apiKeyCiphertext, ...config } = this.getDecisionProviderConfig();
    return { ...config, hasCredential: apiKeyCiphertext !== null };
  }

  saveDecisionProviderConfig(value: DecisionProviderConfigWrite): DecisionProviderConfigRecord {
    if (value.mode !== 'SHADOW') throw new Error('R3 decision provider mode must remain SHADOW');
    this.db
      .prepare(
        `UPDATE decision_provider_configs
         SET enabled = @enabled, api_key_ciphertext = @ciphertext, updated_at = @updatedAt
         WHERE id = 'TYPESAFE' AND mode = @mode`,
      )
      .run({
        enabled: value.enabled ? 1 : 0,
        mode: value.mode,
        ciphertext: value.apiKeyCiphertext === null ? null : Buffer.from(value.apiKeyCiphertext),
        updatedAt: value.updatedAt,
      });
    return this.getDecisionProviderConfig();
  }

  getShadowPolicyConfig(): DecisionShadowPolicyConfigRecord {
    const row = this.db
      .prepare("SELECT * FROM decision_shadow_policy_config WHERE id = 'default'")
      .get() as DecisionShadowPolicyConfigRow | undefined;
    if (!row) throw new Error('Decision shadow policy config is missing');
    return mapShadowPolicyConfig(row);
  }

  saveShadowPolicyConfig(value: DecisionShadowPolicyConfigWrite): DecisionShadowPolicyConfigRecord {
    if (value.mode !== 'SHADOW') throw new Error('R3 decision policy mode must remain SHADOW');
    this.db
      .prepare(
        `UPDATE decision_shadow_policy_config
         SET enabled = @enabled, question_version = @questionVersion,
             policy_version = @policyVersion, max_state_bytes = @maxStateBytes,
             timeout_ms = @timeoutMs, updated_at = @updatedAt
         WHERE id = 'default' AND mode = @mode`,
      )
      .run({ ...value, enabled: value.enabled ? 1 : 0 });
    return this.getShadowPolicyConfig();
  }

  appendDecisionReceipt(value: R3DecisionReceiptRecord): void {
    if (value.provider !== 'TYPESAFE' || value.model !== 'jev-1.13.0') {
      throw new Error('R3 decision receipts require the pinned Typesafe provider model');
    }
    this.db
      .prepare(
        `INSERT INTO decision_receipts
          (id, mission_id, run_id, decision_type, provider, model, model_version,
           question_version, state_hash, input_summary, answers_json, confidence_json,
           policy_version, selected_action, actual_action, latency_ms, input_tokens,
           mode, created_at)
         VALUES
          (@id, @missionId, @runId, @decisionType, @provider, @model, @modelVersion,
           @questionVersion, @stateHash, @inputSummary, @answersJson, @confidenceJson,
           @policyVersion, @selectedAction, @actualAction, @latencyMs, @inputTokens,
           'SHADOW', @createdAt)`,
      )
      .run({
        ...value,
        answersJson: JSON.stringify(value.answersJson),
        confidenceJson: JSON.stringify(value.confidenceJson),
      });
  }

  getDecisionReceipt(id: string): R3DecisionReceiptRecord | null {
    const row = this.db
      .prepare("SELECT * FROM decision_receipts WHERE id = ? AND mode = 'SHADOW'")
      .get(id) as DecisionReceiptRow | undefined;
    return row ? mapDecisionReceipt(row) : null;
  }

  listDecisionReceipts(missionId?: string, runId?: string, limit = 100): R3DecisionReceiptRecord[] {
    const { where, params } = buildFilters(missionId, runId);
    const rows = this.db
      .prepare(
        `SELECT * FROM decision_receipts
         WHERE mode = 'SHADOW' ${where}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, boundedLimit(limit)) as DecisionReceiptRow[];
    return rows.map(mapDecisionReceipt);
  }

  appendShadowAttempt(value: DecisionShadowAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO decision_shadow_attempts
          (id, mission_id, run_id, decision_type, provider, model, status,
           receipt_id, actual_action, error_code, latency_ms, input_tokens, created_at)
         VALUES
          (@id, @missionId, @runId, @decisionType, 'TYPESAFE', 'jev-1.13.0', @status,
           @receiptId, @actualAction, @errorCode, @latencyMs, @inputTokens, @createdAt)`,
      )
      .run(value);
  }

  listShadowAttempts(
    missionId?: string,
    runId?: string,
    limit = 100,
  ): DecisionShadowAttemptRecord[] {
    const { where, params } = buildFilters(missionId, runId);
    const rows = this.db
      .prepare(
        `SELECT * FROM decision_shadow_attempts WHERE 1 = 1 ${where}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, boundedLimit(limit)) as DecisionShadowAttemptRow[];
    return rows.map(mapShadowAttempt);
  }
}

function buildFilters(
  missionId: string | undefined,
  runId: string | undefined,
): { where: string; params: string[] } {
  const filters: string[] = [];
  const params: string[] = [];
  if (missionId !== undefined) {
    filters.push('mission_id = ?');
    params.push(missionId);
  }
  if (runId !== undefined) {
    filters.push('run_id = ?');
    params.push(runId);
  }
  return { where: filters.length ? `AND ${filters.join(' AND ')}` : '', params };
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value)) throw new Error('List limit must be an integer');
  return Math.max(1, Math.min(value, 500));
}

function mapProviderConfig(row: DecisionProviderConfigRow): DecisionProviderConfigRecord {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    enabled: row.enabled === 1,
    mode: row.mode,
    apiKeyCiphertext:
      row.api_key_ciphertext === null ? null : Uint8Array.from(row.api_key_ciphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapShadowPolicyConfig(
  row: DecisionShadowPolicyConfigRow,
): DecisionShadowPolicyConfigRecord {
  return {
    id: row.id,
    enabled: row.enabled === 1,
    mode: row.mode,
    questionVersion: row.question_version,
    policyVersion: row.policy_version,
    maxStateBytes: row.max_state_bytes,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDecisionReceipt(row: DecisionReceiptRow): R3DecisionReceiptRecord {
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
    actualAction: row.actual_action,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    mode: row.mode,
    createdAt: row.created_at,
  };
}

function mapShadowAttempt(row: DecisionShadowAttemptRow): DecisionShadowAttemptRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    runId: row.run_id,
    decisionType: row.decision_type,
    provider: row.provider,
    model: row.model,
    status: row.status,
    receiptId: row.receipt_id,
    actualAction: row.actual_action,
    errorCode: row.error_code,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    createdAt: row.created_at,
  };
}
