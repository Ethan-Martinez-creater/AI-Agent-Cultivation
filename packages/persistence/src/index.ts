import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { RuntimeIdentitySnapshot } from '@cultivation/domain';
import initialSql from '../../../migrations/0001_initial.sql?raw';
import gate1Sql from '../../../migrations/0002_gate1.sql?raw';
import gate2Sql from '../../../migrations/0003_gate2.sql?raw';
import gate3Sql from '../../../migrations/0004_gate3.sql?raw';
import gate4Sql from '../../../migrations/0005_gate4.sql?raw';
import gate5Sql from '../../../migrations/0006_gate5.sql?raw';
import gate6Sql from '../../../migrations/0007_gate6.sql?raw';
import gate6CollaborationOutcomeSql from '../../../migrations/0008_gate6_collaboration_outcome.sql?raw';
import routingFoundationSql from '../../../migrations/0009_routing_foundation.sql?raw';
import capabilityEvidenceProvenanceSql from '../../../migrations/0010_r0_capability_evidence_provenance.sql?raw';
import dynamicCapabilitySql from '../../../migrations/0011_r1_dynamic_capability.sql?raw';
import humanBridgeSql from '../../../migrations/0012_r2_human_bridge.sql?raw';
import r3DecisionPlaneSql from '../../../migrations/0013_r3_decision_plane.sql?raw';
import r3_1IdentityCapabilitySql from '../../../migrations/0014_r3_1_identity_capability.sql?raw';
import r3_2AvailabilitySql from '../../../migrations/0015_r3_2_availability.sql?raw';
import r4RoutingSql from '../../../migrations/0016_r4_controlled_routing.sql?raw';
import w1WorkflowFoundationSql from '../../../migrations/0017_w1_workflow_foundation.sql?raw';
import w1WorkflowIoSql from '../../../migrations/0018_w1_workflow_io.sql?raw';
import w2BuiltinWorkflowContractSql from '../../../migrations/0019_w2_builtin_workflow_contract.sql?raw';
import w21AiNewsVideoSql from '../../../migrations/0020_w21_ai_news_video.sql?raw';
import w21ToolPurposeBindingsSql from '../../../migrations/0021_w21_tool_purpose_bindings.sql?raw';
import w22SoftwareFeatureSql from '../../../migrations/0022_w22_software_feature.sql?raw';
import w23ResearchSql from '../../../migrations/0023_w23_research.sql?raw';
import { R31BindingRepository } from './r3-1-binding.js';
import type { SealedTeammateCreation, TeammateModelBindingRecord } from './r3-1-binding.js';

export { R31BindingRepository } from './r3-1-binding.js';
export type { SealedTeammateCreation, TeammateModelBindingRecord } from './r3-1-binding.js';
export {
  MAX_PERSISTED_AVAILABILITY_OUTCOMES,
  R32AvailabilityRepository,
} from './r3-2-availability.js';
export { R2ContinuationRepository } from './r2-continuation.js';
export { R4RoutingRepository } from './r4-routing.js';
export type { RoutingMissionAssignmentRecord, RoutingHumanBridgeDraft } from './r4-routing.js';
export { W1WorkflowRepository } from './w1-workflow.js';
export { W2WorkflowRepository } from './w2-workflow.js';
export { W22WorkspaceMutationRepository } from './w22-workspace-mutations.js';
export { ResearchSourceRepository } from './w23-research-sources.js';
export type {
  WorkspaceMutationIntent,
  WorkspaceVerificationFact,
} from './w22-workspace-mutations.js';
export type { WorkflowBuiltinReleaseFact } from './w2-workflow.js';

export { Gate2SqliteRepository, MEMORY_FTS_SEARCH_QUERY, MEMORY_SCOPE_QUERY } from './gate2.js';
export type { MemorySearchResult } from './gate2.js';
export { Gate2VectorRepository, SCOPED_VECTOR_QUERY } from './gate2-vector.js';
export type { ScopedVectorMatch } from './gate2-vector.js';
export { Gate3SqliteRepository } from './gate3.js';
export { Gate4SqliteRepository } from './gate4.js';
export { Gate5SqliteRepository } from './gate5.js';
export { Gate6SqliteRepository } from './gate6.js';
export { R0SqliteRepository } from './r0.js';
export { R3SqliteRepository } from './r3.js';
export type {
  DecisionProviderConfigRecord,
  DecisionProviderConfigWrite,
  DecisionProviderConfigStatus,
  DecisionShadowPolicyConfigRecord,
  DecisionShadowPolicyConfigWrite,
  DecisionShadowAttemptRecord,
  DecisionShadowAttemptStatus,
  DecisionShadowErrorCode,
  R3DecisionReceiptRecord,
} from './r3.js';
export type {
  CapabilityDimension,
  CapabilityEvidenceRecord,
  DecisionReceiptRecord,
  ExternalAppProfileRecord,
  ExternalWorkArtifactRecord,
  ExternalWorkRequestRecord,
  HumanBridgeCapabilityRecord,
  HumanBridgeDisplayUpdate,
  ModelCapabilityBenchmarkRecord,
  MissionRunRatingTarget,
  TeammateCapabilityStateRecord,
} from './r0.js';
export type { McpServerConfig, PendingToolCall, PendingToolCallState } from '@cultivation/domain';
export type { Gate5PendingToolCall, Gate5PendingToolCallState } from '@cultivation/domain';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  requiresForeignKeysOff?: boolean;
}
export const migrations: readonly Migration[] = [
  { version: 1, name: 'initial', sql: initialSql },
  { version: 2, name: 'gate1', sql: gate1Sql },
  { version: 3, name: 'gate2', sql: gate2Sql },
  { version: 4, name: 'gate3', sql: gate3Sql },
  { version: 5, name: 'gate4', sql: gate4Sql },
  { version: 6, name: 'gate5', sql: gate5Sql },
  { version: 7, name: 'gate6', sql: gate6Sql },
  { version: 8, name: 'gate6_collaboration_outcome', sql: gate6CollaborationOutcomeSql },
  {
    version: 9,
    name: 'routing_foundation',
    sql: routingFoundationSql,
    requiresForeignKeysOff: true,
  },
  { version: 10, name: 'r0_capability_evidence_provenance', sql: capabilityEvidenceProvenanceSql },
  { version: 11, name: 'r1_dynamic_capability', sql: dynamicCapabilitySql },
  { version: 12, name: 'r2_human_bridge', sql: humanBridgeSql },
  { version: 13, name: 'r3_decision_plane', sql: r3DecisionPlaneSql },
  { version: 14, name: 'r3_1_identity_capability', sql: r3_1IdentityCapabilitySql },
  { version: 15, name: 'r3_2_availability', sql: r3_2AvailabilitySql },
  { version: 16, name: 'r4_controlled_routing', sql: r4RoutingSql },
  { version: 17, name: 'w1_workflow_foundation', sql: w1WorkflowFoundationSql },
  { version: 18, name: 'w1_workflow_io', sql: w1WorkflowIoSql },
  { version: 19, name: 'w2_builtin_workflow_contract', sql: w2BuiltinWorkflowContractSql },
  { version: 20, name: 'w21_ai_news_video', sql: w21AiNewsVideoSql },
  { version: 21, name: 'w21_tool_purpose_bindings', sql: w21ToolPurposeBindingsSql },
  { version: 22, name: 'w22_software_feature', sql: w22SoftwareFeatureSql },
  { version: 23, name: 'w23_research', sql: w23ResearchSql },
];

export type ProviderKind = 'OPENAI' | 'ANTHROPIC' | 'GOOGLE' | 'DEEPSEEK' | 'OPENAI_COMPATIBLE';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSummary {
  id: string;
  providerId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

/** Ciphertext is intentionally available only from this Main-process repository API. */
export type StoredCredential = CredentialSummary & { ciphertext: Uint8Array };

export interface RuntimeProfileRecord {
  id: string;
  name: string;
  providerId: string;
  credentialId: string | null;
  modelId: string;
  parameters: Record<string, unknown>;
  capabilityOverrides: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface TeammateRecord {
  id: string;
  name: string;
  avatar: string | null;
  title: string | null;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
  status: 'ACTIVE' | 'ARCHIVED';
  realm: 'QI_REFINING' | 'FOUNDATION' | 'CORE' | 'NASCENT_SOUL';
  currentRuntimeProfileId: string | null;
  executorKind: 'MODEL_RUNTIME' | 'USER_BRIDGE';
  routingPolicy: 'NORMAL' | 'FALLBACK_ONLY' | 'MANUAL_ONLY';
  systemKind: 'HUMAN_BRIDGE' | null;
  createdAt: string;
  updatedAt: string;
}

type TeammateWriteRecord = Omit<TeammateRecord, 'executorKind' | 'routingPolicy' | 'systemKind'> &
  Partial<Pick<TeammateRecord, 'executorKind' | 'routingPolicy' | 'systemKind'>>;

export interface ConversationRecord {
  id: string;
  teammateId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  missionId: string | null;
  conversationId: string;
  actorType: 'USER' | 'TEAMMATE' | 'SYSTEM';
  actorId: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
  content: string;
  createdAt: string;
}

export interface UsageRecord {
  id: string;
  missionId: string | null;
  runId: string | null;
  teammateId: string;
  runtimeProfileId: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  providerMetadata: Record<string, unknown> | null;
  estimatedCost: number | null;
  currency: string | null;
  createdAt: string;
}

interface ProviderRow {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  id: string;
  provider_id: string;
  label: string;
  ciphertext: Buffer;
  created_at: string;
  updated_at: string;
}

interface RuntimeProfileRow {
  id: string;
  name: string;
  provider_id: string;
  credential_id: string | null;
  model_id: string;
  parameters_json: string;
  capability_overrides_json: string;
  created_at: string;
  updated_at: string;
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

interface ConversationRow {
  id: string;
  teammate_id: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  mission_id: string | null;
  conversation_id: string;
  actor_type: MessageRecord['actorType'];
  actor_id: string;
  role: MessageRecord['role'];
  content: string;
  created_at: string;
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

/** Synchronous SQLite access used only by Electron's Main process. */
export class Gate1SqliteRepository {
  private readonly r31Bindings: R31BindingRepository;

  constructor(private readonly db: Database.Database) {
    this.r31Bindings = new R31BindingRepository(db);
  }

  saveProvider(value: ProviderConfig): void {
    this.db
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, enabled, created_at, updated_at)
         VALUES (@id, @name, @kind, @baseUrl, @enabled, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, kind=excluded.kind, base_url=excluded.base_url,
           enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run({ ...value, enabled: value.enabled ? 1 : 0 });
  }

  getProvider(id: string): ProviderConfig | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      | ProviderRow
      | undefined;
    return row ? mapProvider(row) : null;
  }

  listProviders(): ProviderConfig[] {
    return (
      this.db.prepare('SELECT * FROM providers ORDER BY name, id').all() as ProviderRow[]
    ).map(mapProvider);
  }

  saveCredential(value: StoredCredential): void {
    this.db
      .prepare(
        `INSERT INTO provider_credentials
          (id, provider_id, label, ciphertext, created_at, updated_at)
         VALUES (@id, @providerId, @label, @ciphertext, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           provider_id=excluded.provider_id, label=excluded.label,
           ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`,
      )
      .run({ ...value, ciphertext: Buffer.from(value.ciphertext) });
  }

  getCredential(id: string): StoredCredential | null {
    const row = this.db.prepare('SELECT * FROM provider_credentials WHERE id = ?').get(id) as
      | CredentialRow
      | undefined;
    return row
      ? { ...mapCredentialSummary(row), ciphertext: Uint8Array.from(row.ciphertext) }
      : null;
  }

  /** Never returns the ciphertext column. */
  listCredentials(providerId?: string): CredentialSummary[] {
    const rows = providerId
      ? (this.db
          .prepare(
            `SELECT id, provider_id, label, created_at, updated_at
             FROM provider_credentials WHERE provider_id = ? ORDER BY created_at, id`,
          )
          .all(providerId) as Omit<CredentialRow, 'ciphertext'>[])
      : (this.db
          .prepare(
            `SELECT id, provider_id, label, created_at, updated_at
             FROM provider_credentials ORDER BY created_at, id`,
          )
          .all() as Omit<CredentialRow, 'ciphertext'>[]);
    return rows.map(mapCredentialSummary);
  }

  saveRuntimeProfile(value: RuntimeProfileRecord): void {
    this.db
      .prepare(
        `INSERT INTO runtime_profiles
          (id, name, provider_id, credential_id, model_id, parameters_json,
           capability_overrides_json, created_at, updated_at)
         VALUES (@id, @name, @providerId, @credentialId, @modelId, @parameters,
           @capabilityOverrides, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, provider_id=excluded.provider_id,
           credential_id=excluded.credential_id, model_id=excluded.model_id,
           parameters_json=excluded.parameters_json,
           capability_overrides_json=excluded.capability_overrides_json,
           updated_at=excluded.updated_at`,
      )
      .run({
        ...value,
        parameters: JSON.stringify(value.parameters),
        capabilityOverrides: JSON.stringify(value.capabilityOverrides),
      });
  }

  getRuntimeProfile(id: string): RuntimeProfileRecord | null {
    const row = this.db.prepare('SELECT * FROM runtime_profiles WHERE id = ?').get(id) as
      | RuntimeProfileRow
      | undefined;
    return row ? mapRuntimeProfile(row) : null;
  }

  listRuntimeProfiles(): RuntimeProfileRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM runtime_profiles ORDER BY name, id')
        .all() as RuntimeProfileRow[]
    ).map(mapRuntimeProfile);
  }

  saveTeammate(value: TeammateWriteRecord): void {
    const existing = this.db
      .prepare('SELECT executor_kind, routing_policy, system_kind FROM teammates WHERE id = ?')
      .get(value.id) as
      | Pick<TeammateRow, 'executor_kind' | 'routing_policy' | 'system_kind'>
      | undefined;
    if (
      existing?.system_kind === 'HUMAN_BRIDGE' &&
      ((value.executorKind !== undefined && value.executorKind !== existing.executor_kind) ||
        (value.routingPolicy !== undefined && value.routingPolicy !== existing.routing_policy) ||
        (value.systemKind !== undefined && value.systemKind !== existing.system_kind) ||
        value.currentRuntimeProfileId !== null)
    ) {
      throw new Error('Human Bridge executor identity and Runtime binding are immutable');
    }
    const executorKind = value.executorKind ?? existing?.executor_kind ?? 'MODEL_RUNTIME';
    const routingPolicy = value.routingPolicy ?? existing?.routing_policy ?? 'NORMAL';
    const systemKind = value.systemKind ?? existing?.system_kind ?? null;
    this.db
      .prepare(
        `INSERT INTO teammates
          (id, name, avatar, title, description, identity_prompt, behavior_prompt, status, realm,
           current_runtime_profile_id, executor_kind, routing_policy, system_kind, created_at, updated_at)
         VALUES (@id, @name, @avatar, @title, @description, @identityPrompt, @behaviorPrompt,
           @status, @realm, @currentRuntimeProfileId, @executorKind, @routingPolicy, @systemKind,
           @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, avatar=excluded.avatar, title=excluded.title,
           description=excluded.description, identity_prompt=excluded.identity_prompt,
           behavior_prompt=excluded.behavior_prompt, status=excluded.status,
           realm=excluded.realm, current_runtime_profile_id=excluded.current_runtime_profile_id,
           executor_kind=excluded.executor_kind, routing_policy=excluded.routing_policy,
           system_kind=excluded.system_kind,
           updated_at=excluded.updated_at`,
      )
      .run({ ...value, executorKind, routingPolicy, systemKind });
  }

  getTeammate(id: string): TeammateRecord | null {
    const row = this.db.prepare('SELECT * FROM teammates WHERE id = ?').get(id) as
      | TeammateRow
      | undefined;
    return row ? mapTeammate(row) : null;
  }

  listTeammates(): TeammateRecord[] {
    return (
      this.db.prepare('SELECT * FROM teammates ORDER BY name, id').all() as TeammateRow[]
    ).map(mapTeammate);
  }

  createSealedTeammate(
    teammate: TeammateRecord,
    sourceRuntimeProfileId: string,
    verifiedIdentity: RuntimeIdentitySnapshot,
    verifiedAt: string,
  ): SealedTeammateCreation {
    return this.r31Bindings.createSealedTeammate(
      teammate,
      sourceRuntimeProfileId,
      verifiedIdentity,
      verifiedAt,
    );
  }

  getRuntimeIdentitySnapshot(runtimeProfileId: string): RuntimeIdentitySnapshot | null {
    return this.r31Bindings.getRuntimeIdentitySnapshot(runtimeProfileId);
  }

  getModelBinding(teammateId: string): TeammateModelBindingRecord | null {
    return this.r31Bindings.getModelBinding(teammateId);
  }

  isRuntimeBound(runtimeProfileId: string): boolean {
    return this.r31Bindings.isRuntimeBound(runtimeProfileId);
  }

  hasValidModelBinding(teammateId: string): boolean {
    return this.r31Bindings.hasValidModelBinding(teammateId);
  }

  rotateBoundCredential(
    teammateId: string,
    credentialId: string | null,
  ): TeammateModelBindingRecord {
    return this.r31Bindings.rotateBoundCredential(teammateId, credentialId);
  }

  saveConversation(value: ConversationRecord): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, teammate_id, created_at, updated_at)
         VALUES (@id, @teammateId, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           teammate_id=excluded.teammate_id, updated_at=excluded.updated_at`,
      )
      .run(value);
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
    return row ? mapConversation(row) : null;
  }

  listConversations(teammateId: string): ConversationRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM conversations WHERE teammate_id = ? ORDER BY updated_at DESC, id')
        .all(teammateId) as ConversationRow[]
    ).map(mapConversation);
  }

  saveMessage(value: MessageRecord): void {
    const missionId = value.missionId ?? null;
    let teammateId: string | null = null;
    if (missionId === null) {
      const conversation = this.db
        .prepare('SELECT teammate_id FROM conversations WHERE id = ?')
        .get(value.conversationId) as { teammate_id: string } | undefined;
      if (!conversation) throw new Error('Cannot save chat message without its conversation');
      teammateId = conversation.teammate_id;
    }
    const writeMessage = this.db.prepare(
      `INSERT INTO messages
          (id, mission_id, conversation_id, teammate_id, actor_type, actor_id, role, content, created_at)
         VALUES (@id, @missionId, @conversationId, @teammateId, @actorType, @actorId, @role, @content, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           mission_id=excluded.mission_id, conversation_id=excluded.conversation_id,
           teammate_id=excluded.teammate_id, actor_type=excluded.actor_type,
           actor_id=excluded.actor_id, role=excluded.role, content=excluded.content,
           created_at=excluded.created_at`,
    );
    this.db.transaction(() => {
      writeMessage.run({ ...value, missionId, teammateId });
      if (teammateId !== null) {
        this.db
          .prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND teammate_id = ?')
          .run(value.createdAt, value.conversationId, teammateId);
      }
    })();
  }

  listMessages(teammateId: string, conversationId: string): MessageRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, mission_id, conversation_id, actor_type, actor_id, role, content, created_at
           FROM messages
           WHERE teammate_id = ? AND conversation_id = ? AND mission_id IS NULL
           ORDER BY created_at, id`,
        )
        .all(teammateId, conversationId) as MessageRow[]
    ).map(mapMessage);
  }

  saveUsage(value: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_records
          (id, mission_id, run_id, teammate_id, runtime_profile_id, provider, model,
           input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
           provider_metadata_json, estimated_cost, currency, created_at)
         VALUES (@id, @missionId, @runId, @teammateId, @runtimeProfileId, @provider, @model,
           @inputTokens, @outputTokens, @cachedInputTokens, @reasoningTokens,
           @providerMetadata, @estimatedCost, @currency, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           mission_id=excluded.mission_id, run_id=excluded.run_id,
           teammate_id=excluded.teammate_id, runtime_profile_id=excluded.runtime_profile_id,
           provider=excluded.provider, model=excluded.model, input_tokens=excluded.input_tokens,
           output_tokens=excluded.output_tokens, cached_input_tokens=excluded.cached_input_tokens,
           reasoning_tokens=excluded.reasoning_tokens,
           provider_metadata_json=excluded.provider_metadata_json,
           estimated_cost=excluded.estimated_cost, currency=excluded.currency,
           created_at=excluded.created_at`,
      )
      .run({
        ...value,
        providerMetadata: value.providerMetadata ? JSON.stringify(value.providerMetadata) : null,
      });
  }

  listUsage(teammateId?: string): UsageRecord[] {
    const rows = teammateId
      ? (this.db
          .prepare('SELECT * FROM usage_records WHERE teammate_id = ? ORDER BY created_at, id')
          .all(teammateId) as UsageRow[])
      : (this.db
          .prepare('SELECT * FROM usage_records ORDER BY created_at, id')
          .all() as UsageRow[]);
    return rows.map(mapUsage);
  }
}

function mapProvider(row: ProviderRow): ProviderConfig {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCredentialSummary(row: Omit<CredentialRow, 'ciphertext'>): CredentialSummary {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntimeProfile(row: RuntimeProfileRow): RuntimeProfileRecord {
  return {
    id: row.id,
    name: row.name,
    providerId: row.provider_id,
    credentialId: row.credential_id,
    modelId: row.model_id,
    parameters: JSON.parse(row.parameters_json) as Record<string, unknown>,
    capabilityOverrides: JSON.parse(row.capability_overrides_json) as Record<string, boolean>,
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

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    teammateId: row.teammate_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    conversationId: row.conversation_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    role: row.role,
    content: row.content,
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

export function databasePath(userDataDirectory: string): string {
  return join(userDataDirectory, 'data', 'cultivation.sqlite');
}

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  runMigrations(db, migrations);
  return db;
}

export function runMigrations(db: Database.Database, steps: readonly Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    if (applied.has(step.version)) continue;
    if (step.requiresForeignKeysOff) {
      runMigrationWithForeignKeysDisabled(db, step);
    } else {
      db.transaction(() => applyMigration(db, step))();
    }
  }
}

function applyMigration(db: Database.Database, step: Migration): void {
  db.exec(step.sql);
  db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
    step.version,
    step.name,
    new Date().toISOString(),
  );
}

function runMigrationWithForeignKeysDisabled(db: Database.Database, step: Migration): void {
  if (db.inTransaction) {
    throw new Error(`Migration ${step.version} must run outside an existing transaction`);
  }
  const foreignKeysWereEnabled = Boolean(db.pragma('foreign_keys', { simple: true }));
  const legacyAlterTableWasEnabled = Boolean(db.pragma('legacy_alter_table', { simple: true }));
  assertForeignKeyIntegrity(db, `before migration ${step.version}`);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      applyMigration(db, step);
      assertForeignKeyIntegrity(db, `during migration ${step.version}`);
    })();
    assertForeignKeyIntegrity(db, `after migration ${step.version}`);
  } finally {
    try {
      db.pragma(`legacy_alter_table = ${legacyAlterTableWasEnabled ? 'ON' : 'OFF'}`);
    } finally {
      db.pragma(`foreign_keys = ${foreignKeysWereEnabled ? 'ON' : 'OFF'}`);
    }
  }
  assertForeignKeyIntegrity(db, `after restoring foreign keys for migration ${step.version}`);
}

function assertForeignKeyIntegrity(db: Database.Database, phase: string): void {
  const violations = db.pragma('foreign_key_check') as {
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }[];
  if (violations.length > 0) {
    const sample = violations
      .slice(0, 5)
      .map(
        ({ table, rowid, parent, fkid }) =>
          `${table}[${rowid ?? 'WITHOUT ROWID'}]->${parent}#${fkid}`,
      )
      .join(', ');
    throw new Error(`Foreign key check failed ${phase}: ${sample}`);
  }
}
