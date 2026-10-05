import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  ExecutionProtocol,
  ProviderKind as DomainProviderKind,
  RuntimeIdentitySnapshot,
  TeammateModelBinding,
} from '@cultivation/domain';
import type { RuntimeProfileRecord, TeammateRecord } from './index.js';

export interface TeammateModelBindingRecord
  extends Omit<TeammateModelBinding, 'executionProtocol'> {
  executionProtocol: ExecutionProtocol;
}

export interface SealedTeammateCreation {
  teammate: TeammateRecord;
  binding: TeammateModelBindingRecord;
}

interface ModelBindingRow {
  teammate_id: string;
  runtime_profile_id: string;
  provider_kind: DomainProviderKind;
  adapter_id: string | null;
  endpoint: string | null;
  model_id: string;
  execution_protocol: ExecutionProtocol;
  credential_id: string | null;
  verified_at: string | null;
  verification_source: 'LIVE_TEST' | 'LEGACY_STRUCTURAL';
  sealed_at: string;
}

interface RuntimeProviderRow {
  id: string;
  name: string;
  provider_id: string;
  credential_id: string | null;
  model_id: string;
  execution_protocol: ExecutionProtocol;
  parameters_json: string;
  capability_overrides_json: string;
  created_at: string;
  updated_at: string;
  provider_kind: DomainProviderKind;
  adapter_id: string | null;
  endpoint: string | null;
  provider_enabled: number;
  provider_updated_at: string;
  credential_updated_at: string | null;
}

interface ModelBenchmarkRow {
  model_alias: string;
  dimension: string;
  supported: number;
  normalized_score: number | null;
  raw_score: number | null;
  source: string;
  benchmark: string;
  benchmark_version: string;
  snapshot_date: string;
  source_url: string | null;
  provenance_type: string;
  created_at: string;
}

/** Persistence operations for sealed R3.1 teammate/model identities. */
export class R31BindingRepository {
  constructor(private readonly db: Database.Database) {}
  private adapterSql(): string {
    return (this.db.pragma('table_info(providers)') as Array<{ name: string }>).some(
      (c) => c.name === 'adapter_id',
    )
      ? 'p.adapter_id'
      : 'NULL';
  }

  /**
   * Atomically gives a newly created teammate a private Runtime clone and seals
   * the exact provider/model identity that was successfully verified.
   */
  createSealedTeammate(
    teammate: TeammateRecord,
    sourceRuntimeProfileId: string,
    verifiedIdentity: RuntimeIdentitySnapshot,
    verifiedAt: string,
  ): SealedTeammateCreation {
    if (teammate.executorKind !== 'MODEL_RUNTIME' || teammate.systemKind !== null) {
      throw new Error('A ModelBinding can only be created for an ordinary MODEL_RUNTIME teammate');
    }
    if (
      teammate.currentRuntimeProfileId !== null &&
      teammate.currentRuntimeProfileId !== sourceRuntimeProfileId
    ) {
      throw new Error('The verified Runtime must match the teammate creation request');
    }
    if (!isValidTimestamp(verifiedAt)) {
      throw new Error('ModelBinding verification time must be a valid timestamp');
    }

    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM teammates WHERE id = ?').get(teammate.id)) {
        throw new Error(`Teammate ${teammate.id} already exists`);
      }
      const source = this.db
        .prepare(
          `SELECT rp.*, p.kind AS provider_kind, ${this.adapterSql()} AS adapter_id, p.base_url AS endpoint,
                  p.enabled AS provider_enabled, p.updated_at AS provider_updated_at,
                  pc.updated_at AS credential_updated_at
           FROM runtime_profiles AS rp
           JOIN providers AS p ON p.id = rp.provider_id
           LEFT JOIN provider_credentials AS pc ON pc.id = rp.credential_id
           WHERE rp.id = ?`,
        )
        .get(sourceRuntimeProfileId) as RuntimeProviderRow | undefined;
      if (!source) throw new Error(`Runtime profile ${sourceRuntimeProfileId} does not exist`);
      if (!sameRuntimeIdentity(verifiedIdentity, runtimeIdentityFromRow(source))) {
        throw new Error(
          'Runtime identity changed after connection verification; retest before sealing',
        );
      }
      if (source.provider_enabled !== 1) {
        throw new Error('Cannot seal a Runtime whose Provider is disabled');
      }
      if (
        !isSupportedProviderKind(source.provider_kind) ||
        !isValidEndpoint(source.endpoint, source.provider_kind)
      ) {
        throw new Error('Runtime Provider endpoint is structurally invalid');
      }
      if (source.model_id.trim().length === 0) {
        throw new Error('Model ID is required before a ModelBinding can be sealed');
      }
      if (
        source.credential_id === null &&
        !['OPENAI_COMPATIBLE', 'GENERATION_HTTP'].includes(source.provider_kind)
      ) {
        throw new Error('This Provider requires a Credential before a ModelBinding can be sealed');
      }
      if (source.credential_id !== null) {
        const credential = this.db
          .prepare('SELECT provider_id FROM provider_credentials WHERE id = ?')
          .get(source.credential_id) as { provider_id: string } | undefined;
        if (!credential || credential.provider_id !== source.provider_id) {
          throw new Error('Runtime credential must belong to its Provider');
        }
      }

      const runtimeProfileId = randomUUID();
      const runtimeProfile: RuntimeProfileRecord = {
        id: runtimeProfileId,
        name: source.name,
        providerId: source.provider_id,
        credentialId: source.credential_id,
        modelId: source.model_id,
        executionProtocol: source.execution_protocol,
        parameters: JSON.parse(source.parameters_json) as Record<string, unknown>,
        capabilityOverrides: JSON.parse(source.capability_overrides_json) as Record<
          string,
          boolean
        >,
        createdAt: teammate.createdAt,
        updatedAt: teammate.updatedAt,
      };
      this.db
        .prepare(
          `INSERT INTO runtime_profiles
            (id, name, provider_id, credential_id, model_id, execution_protocol, parameters_json,
             capability_overrides_json, created_at, updated_at)
           VALUES (@id, @name, @providerId, @credentialId, @modelId, @executionProtocol, @parameters,
             @capabilityOverrides, @createdAt, @updatedAt)`,
        )
        .run({
          ...runtimeProfile,
          parameters: JSON.stringify(runtimeProfile.parameters),
          capabilityOverrides: JSON.stringify(runtimeProfile.capabilityOverrides),
        });
      this.copyBenchmarks(sourceRuntimeProfileId, runtimeProfileId);

      const savedTeammate: TeammateRecord = {
        ...teammate,
        currentRuntimeProfileId: runtimeProfileId,
        executorKind: 'MODEL_RUNTIME',
        systemKind: null,
      };
      this.db
        .prepare(
          `INSERT INTO teammates
            (id, name, avatar, title, description, identity_prompt, behavior_prompt, status,
             realm, current_runtime_profile_id, executor_kind, routing_policy, system_kind,
             created_at, updated_at)
           VALUES (@id, @name, @avatar, @title, @description, @identityPrompt, @behaviorPrompt,
             @status, @realm, @currentRuntimeProfileId, @executorKind, @routingPolicy,
             @systemKind, @createdAt, @updatedAt)`,
        )
        .run(savedTeammate);

      const binding: TeammateModelBindingRecord = {
        teammateId: teammate.id,
        runtimeProfileId,
        providerKind: source.provider_kind,
        adapterId: source.adapter_id,
        endpoint: source.endpoint,
        modelId: source.model_id,
        executionProtocol: source.execution_protocol,
        credentialId: source.credential_id,
        verifiedAt,
        verificationSource: 'LIVE_TEST',
        sealedAt: new Date().toISOString(),
      };
      this.insertBinding(binding);
      return { teammate: savedTeammate, binding };
    })();
  }

  getModelBinding(teammateId: string): TeammateModelBindingRecord | null {
    const row = this.db
      .prepare('SELECT * FROM teammate_model_bindings WHERE teammate_id = ?')
      .get(teammateId) as ModelBindingRow | undefined;
    return row ? mapModelBinding(row) : null;
  }

  getRuntimeIdentitySnapshot(runtimeProfileId: string): RuntimeIdentitySnapshot | null {
    const row = this.db
      .prepare(
        `SELECT rp.*, p.kind AS provider_kind, ${this.adapterSql()} AS adapter_id, p.base_url AS endpoint,
                p.enabled AS provider_enabled, p.updated_at AS provider_updated_at,
                pc.updated_at AS credential_updated_at
         FROM runtime_profiles AS rp
         JOIN providers AS p ON p.id = rp.provider_id
         LEFT JOIN provider_credentials AS pc ON pc.id = rp.credential_id
         WHERE rp.id = ?`,
      )
      .get(runtimeProfileId) as RuntimeProviderRow | undefined;
    return row ? runtimeIdentityFromRow(row) : null;
  }

  isRuntimeBound(runtimeProfileId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM teammate_model_bindings WHERE runtime_profile_id = ?')
        .get(runtimeProfileId),
    );
  }

  /** Returns false for missing, stale, disabled, or structurally invalid bindings. */
  hasValidModelBinding(teammateId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT b.*, p.kind AS actual_provider_kind, ${this.adapterSql()} AS actual_adapter_id, p.base_url AS provider_endpoint,
                p.enabled AS provider_enabled, rp.provider_id, rp.model_id AS runtime_model_id,
                rp.execution_protocol AS runtime_execution_protocol,
                rp.credential_id AS runtime_credential_id, c.provider_id AS credential_provider_id,
                t.current_runtime_profile_id, t.executor_kind, t.system_kind
         FROM teammate_model_bindings AS b
         JOIN teammates AS t ON t.id = b.teammate_id
         JOIN runtime_profiles AS rp ON rp.id = b.runtime_profile_id
         JOIN providers AS p ON p.id = rp.provider_id
         LEFT JOIN provider_credentials AS c ON c.id = b.credential_id
         WHERE b.teammate_id = ?`,
      )
      .get(teammateId) as
      | (ModelBindingRow & {
          provider_endpoint: string | null;
          actual_provider_kind: string;
          actual_adapter_id: string | null;
          provider_enabled: number;
          provider_id: string;
          runtime_model_id: string;
          runtime_execution_protocol: ExecutionProtocol;
          runtime_credential_id: string | null;
          credential_provider_id: string | null;
          current_runtime_profile_id: string | null;
          executor_kind: string;
          system_kind: string | null;
        })
      | undefined;
    if (!row) return false;

    return (
      row.executor_kind === 'MODEL_RUNTIME' &&
      row.system_kind === null &&
      row.current_runtime_profile_id === row.runtime_profile_id &&
      row.actual_provider_kind === row.provider_kind &&
      row.actual_adapter_id === row.adapter_id &&
      (row.provider_kind !== 'GENERATION_HTTP' ||
        (row.adapter_id === 'H3' && row.execution_protocol === 'GENERATION')) &&
      isSupportedProviderKind(row.provider_kind) &&
      row.provider_enabled === 1 &&
      row.provider_endpoint === row.endpoint &&
      row.runtime_model_id === row.model_id &&
      row.runtime_execution_protocol === row.execution_protocol &&
      row.runtime_credential_id === row.credential_id &&
      (row.credential_id === null || row.credential_provider_id === row.provider_id) &&
      (row.credential_id !== null ||
        ['OPENAI_COMPATIBLE', 'GENERATION_HTTP'].includes(row.provider_kind)) &&
      row.model_id.trim().length > 0 &&
      ((row.verification_source === 'LIVE_TEST' && isValidTimestamp(row.verified_at)) ||
        (row.verification_source === 'LEGACY_STRUCTURAL' && row.verified_at === null)) &&
      isValidTimestamp(row.sealed_at) &&
      isValidEndpoint(row.endpoint, row.provider_kind)
    );
  }

  /** Changes only the Credential ID; database triggers synchronize the private Runtime. */
  rotateBoundCredential(
    teammateId: string,
    credentialId: string | null,
  ): TeammateModelBindingRecord {
    const previous = this.getModelBinding(teammateId);
    if (!previous) {
      throw new Error(`Teammate ${teammateId} does not have a sealed ModelBinding`);
    }
    if (
      credentialId === null &&
      !['OPENAI_COMPATIBLE', 'GENERATION_HTTP'].includes(previous.providerKind)
    ) {
      throw new Error('This Provider requires a Credential');
    }
    const result = this.db
      .prepare('UPDATE teammate_model_bindings SET credential_id = ? WHERE teammate_id = ?')
      .run(credentialId, teammateId);
    if (result.changes !== 1) {
      throw new Error(`Teammate ${teammateId} does not have a sealed ModelBinding`);
    }
    const binding = this.getModelBinding(teammateId);
    if (!binding) throw new Error(`ModelBinding for teammate ${teammateId} disappeared`);
    return binding;
  }

  private insertBinding(binding: TeammateModelBindingRecord): void {
    this.db
      .prepare(
        `INSERT INTO teammate_model_bindings
          (teammate_id, runtime_profile_id, provider_kind, adapter_id, endpoint, model_id, execution_protocol,
           credential_id, verified_at, verification_source, sealed_at)
         VALUES (@teammateId, @runtimeProfileId, @providerKind, @adapterId, @endpoint, @modelId, @executionProtocol,
           @credentialId, @verifiedAt, @verificationSource, @sealedAt)`,
      )
      .run(binding);
  }

  private copyBenchmarks(sourceRuntimeProfileId: string, runtimeProfileId: string): void {
    const sourceBenchmarks = this.db
      .prepare('SELECT * FROM model_capability_benchmarks WHERE runtime_profile_id = ?')
      .all(sourceRuntimeProfileId) as ModelBenchmarkRow[];
    const insert = this.db.prepare(
      `INSERT INTO model_capability_benchmarks
        (id, runtime_profile_id, model_alias, dimension, supported, normalized_score,
         raw_score, source, benchmark, benchmark_version, snapshot_date, source_url,
         provenance_type, created_at)
       VALUES (@id, @runtimeProfileId, @modelAlias, @dimension, @supported, @normalizedScore,
         @rawScore, @source, @benchmark, @benchmarkVersion, @snapshotDate, @sourceUrl,
         @provenanceType, @createdAt)`,
    );
    for (const benchmark of sourceBenchmarks) {
      insert.run({
        id: randomUUID(),
        runtimeProfileId,
        modelAlias: benchmark.model_alias,
        dimension: benchmark.dimension,
        supported: benchmark.supported,
        normalizedScore: benchmark.normalized_score,
        rawScore: benchmark.raw_score,
        source: benchmark.source,
        benchmark: benchmark.benchmark,
        benchmarkVersion: benchmark.benchmark_version,
        snapshotDate: benchmark.snapshot_date,
        sourceUrl: benchmark.source_url,
        provenanceType: benchmark.provenance_type,
        createdAt: benchmark.created_at,
      });
    }
  }
}

function runtimeIdentityFromRow(row: RuntimeProviderRow): RuntimeIdentitySnapshot {
  return {
    providerId: row.provider_id,
    providerKind: row.provider_kind,
    adapterId: row.adapter_id,
    baseUrl: row.endpoint,
    modelId: row.model_id,
    executionProtocol: row.execution_protocol,
    credentialId: row.credential_id,
    runtimeUpdatedAt: row.updated_at,
    providerUpdatedAt: row.provider_updated_at,
    credentialUpdatedAt: row.credential_updated_at,
  };
}

function sameRuntimeIdentity(
  left: RuntimeIdentitySnapshot,
  right: RuntimeIdentitySnapshot,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.providerKind === right.providerKind &&
    (left.adapterId ?? null) === (right.adapterId ?? null) &&
    left.baseUrl === right.baseUrl &&
    left.modelId === right.modelId &&
    (left.executionProtocol ?? 'LANGUAGE') === (right.executionProtocol ?? 'LANGUAGE') &&
    left.credentialId === right.credentialId &&
    left.runtimeUpdatedAt === right.runtimeUpdatedAt &&
    left.providerUpdatedAt === right.providerUpdatedAt &&
    left.credentialUpdatedAt === right.credentialUpdatedAt
  );
}

function mapModelBinding(row: ModelBindingRow): TeammateModelBindingRecord {
  return {
    teammateId: row.teammate_id,
    runtimeProfileId: row.runtime_profile_id,
    providerKind: row.provider_kind,
    adapterId: row.adapter_id,
    endpoint: row.endpoint,
    modelId: row.model_id,
    executionProtocol: row.execution_protocol,
    credentialId: row.credential_id,
    verifiedAt: row.verified_at,
    verificationSource: row.verification_source,
    sealedAt: row.sealed_at,
  };
}

function isSupportedProviderKind(value: string): value is DomainProviderKind {
  return [
    'OPENAI',
    'ANTHROPIC',
    'GOOGLE',
    'DEEPSEEK',
    'OPENAI_COMPATIBLE',
    'GENERATION_HTTP',
  ].includes(value);
}

function isValidTimestamp(value: string | null): boolean {
  return value !== null && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function isValidEndpoint(endpoint: string | null, providerKind: DomainProviderKind): boolean {
  if (endpoint === null) return !['OPENAI_COMPATIBLE', 'GENERATION_HTTP'].includes(providerKind);
  try {
    const url = new URL(endpoint);
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    const validProtocol =
      url.protocol === 'https:' || (url.protocol === 'http:' && localHosts.has(url.hostname));
    return (
      validProtocol &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}
