import type {
  ApprovalRequest,
  Mission,
  MemoryRecord,
  Party,
  PermissionRule,
  PermissionScopeRef,
  RuntimeProfile,
  Skill,
  Teammate,
  ToolDescriptor,
} from '@cultivation/domain';

/** Application ports contain no Electron, SQLite or provider SDK types. */
export interface SecretStore {
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<string>;
}

export interface ProviderRegistry {
  getRuntimeProfile(id: string): Promise<RuntimeProfile | null>;
  listModelIds(providerId: string): Promise<string[]>;
}

export interface ModelRequest {
  runtimeProfileId: string;
  teammateId: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}
export interface ModelResponse {
  text: string;
  usage: ModelUsage;
}
export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'finish'; usage: ModelUsage };
export interface ModelConnectionTestResult {
  ok: boolean;
  message: string;
}
export interface ModelGateway {
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  testConnection(runtimeProfileId: string): Promise<ModelConnectionTestResult>;
}

export interface Repository<T> {
  get(id: string): Promise<T | null>;
  save(value: T): Promise<void>;
}
export interface TeammateRepository extends Repository<Teammate> {
  list(): Promise<Teammate[]>;
}
export interface MissionRepository extends Repository<Mission> {
  listByTeammate(teammateId: string): Promise<Mission[]>;
}
export interface MemoryRepository extends Repository<MemoryRecord> {
  listActiveByOwner(ownerType: MemoryRecord['ownerType'], ownerId: string): Promise<MemoryRecord[]>;
}
export interface SkillRepository extends Repository<Skill> {
  listForTeammate(teammateId: string): Promise<Skill[]>;
}
export interface PartyRepository extends Repository<Party> {
  list(): Promise<Party[]>;
}
export interface AuditRepository {
  append(event: {
    actorType: string;
    actorId: string | null;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
export interface UsageRepository {
  append(record: {
    teammateId: string;
    runtimeProfileId: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void>;
}
export interface PermissionRepository extends Repository<PermissionRule> {
  find(
    subjectId: string,
    capability: PermissionRule['capability'],
    scope: PermissionScopeRef,
  ): Promise<PermissionRule[]>;
  saveApproval(request: ApprovalRequest): Promise<void>;
}
export interface ToolRegistry {
  get(id: string): Promise<ToolDescriptor | null>;
  list(): Promise<ToolDescriptor[]>;
}
