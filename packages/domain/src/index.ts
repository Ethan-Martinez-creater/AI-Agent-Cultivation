import type { Id, IsoDateTime } from '@cultivation/shared';

export type TeammateStatus = 'ACTIVE' | 'ARCHIVED';
export type Realm = 'QI_REFINING' | 'FOUNDATION' | 'CORE' | 'NASCENT_SOUL';
export type ProviderKind = 'OPENAI' | 'ANTHROPIC' | 'GOOGLE' | 'DEEPSEEK' | 'OPENAI_COMPATIBLE';
export interface ProviderConfig {
  id: Id;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
/** Safe for Renderer: neither a key nor encrypted bytes are included. */
export interface CredentialSummary {
  id: Id;
  providerId: Id;
  label: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface Teammate {
  id: Id;
  name: string;
  avatar: string | null;
  title: string | null;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
  status: TeammateStatus;
  realm: Realm;
  currentRuntimeProfileId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface RuntimeProfile {
  id: Id;
  name: string;
  providerId: Id;
  credentialId: Id | null;
  modelId: string;
  parameters: Record<string, unknown>;
  capabilityOverrides: Record<string, boolean>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type MemoryOwnerType = 'USER' | 'TEAMMATE' | 'MISSION';
export type MemoryType =
  | 'IDENTITY'
  | 'PREFERENCE'
  | 'FACT'
  | 'EPISODE'
  | 'PROCEDURE'
  | 'OBSERVATION';
export type MemoryStatus = 'PROPOSED' | 'ACTIVE' | 'REJECTED' | 'ARCHIVED';
export interface MemoryRecord {
  id: Id;
  ownerType: MemoryOwnerType;
  ownerId: Id;
  memoryType: MemoryType;
  content: string;
  summary: string;
  sourceType: string;
  sourceId: Id | null;
  sourceConversationId: Id | null;
  sourceMessageId: Id | null;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  expiresAt: IsoDateTime | null;
  confirmedAt: IsoDateTime | null;
}

export type SkillStatus = 'ACTIVE' | 'ARCHIVED';
export interface Skill {
  id: Id;
  name: string;
  description: string;
  instructions: string;
  version: string;
  tags: string[];
  status: SkillStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Immutable full-content snapshot recorded whenever the current Skill version changes. */
export interface SkillRevision {
  id: Id;
  skillId: Id;
  revision: number;
  version: string;
  name: string;
  description: string;
  instructions: string;
  tags: string[];
  createdAt: IsoDateTime;
}

export interface SkillAssignment {
  teammateId: Id;
  skillId: Id;
  enabled: boolean;
}

export type ToolSource = 'BUILTIN' | 'MCP';
export type RiskLevel = 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH';
export type SideEffect = 'NONE' | 'LOCAL_WRITE' | 'EXTERNAL_WRITE' | 'PROCESS_EXECUTION';
export interface ToolDescriptor {
  id: Id;
  source: ToolSource;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
  sideEffect: SideEffect;
}

export type PartyType = 'FIXED' | 'AD_HOC';
export type PartyStatus = 'ACTIVE' | 'ARCHIVED';
export interface Party {
  id: Id;
  name: string;
  description: string;
  coordinatorTeammateId: Id;
  type: PartyType;
  status: PartyStatus;
  createdAt: IsoDateTime;
}
export interface PartyMember {
  partyId: Id;
  teammateId: Id;
  role: 'COORDINATOR' | 'MEMBER';
  order: number;
}

export type MissionMode = 'SOLO' | 'CONSULTATION' | 'REVIEW' | 'DELEGATION';
export type MissionState =
  | 'DRAFT'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_COLLABORATION'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';
export interface Mission {
  id: Id;
  title: string;
  objective: string;
  initiatorType: 'USER' | 'TEAMMATE';
  initiatorId: Id;
  coordinatorTeammateId: Id;
  partyId: Id | null;
  mode: MissionMode;
  state: MissionState;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
}

export type PermissionCapability =
  | 'MEMORY_READ'
  | 'MEMORY_WRITE'
  | 'FILE_READ'
  | 'FILE_WRITE'
  | 'MCP_TOOL_EXECUTE'
  | 'INVITE_TEAMMATE'
  | 'CREATE_MISSION'
  | 'SPEND_BUDGET'
  | 'WEB_ACCESS'
  | 'BROWSER_CONTROL'
  | 'EXECUTE_COMMAND'
  | 'EXTERNAL_MESSAGE'
  | 'INSTALL_TOOL';
export type PermissionDecision = 'ALLOW' | 'DENY' | 'ASK';
export type PermissionScopeRef =
  | { scope: 'GLOBAL'; scopeId: null }
  | { scope: 'TEAMMATE'; scopeId: Id }
  | { scope: 'MISSION'; scopeId: Id };
export type PermissionScope = PermissionScopeRef['scope'];
interface PermissionRuleBase {
  id: Id;
  subjectType: 'USER' | 'TEAMMATE';
  subjectId: Id;
  capability: PermissionCapability;
  resourcePattern: string;
  decision: PermissionDecision;
}
export type PermissionRule = PermissionRuleBase & PermissionScopeRef;

export type MissionRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export interface MissionRun {
  id: Id;
  missionId: Id;
  attempt: number;
  status: MissionRunStatus;
  startedAt: IsoDateTime;
  endedAt: IsoDateTime | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultText: string | null;
}

export type ApprovalState = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'EXPIRED';
export interface ApprovalRequest {
  id: Id;
  missionId: Id;
  runId: Id;
  requesterTeammateId: Id;
  capability: PermissionCapability;
  actionType: string;
  actionPayload: Record<string, unknown>;
  riskLevel: RiskLevel;
  state: ApprovalState;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

export type CollaborationState = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED';
export interface CollaborationRequest {
  id: Id;
  missionId: Id;
  requesterTeammateId: Id;
  targetTeammateId: Id;
  reason: string;
  proposedTask: string;
  estimatedUsage: number | null;
  state: CollaborationState;
}

export interface Message {
  id: Id;
  missionId: Id | null;
  conversationId: Id;
  actorType: 'USER' | 'TEAMMATE' | 'SYSTEM';
  actorId: Id;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
  content: string;
  createdAt: IsoDateTime;
}

/** A personal chat thread; Mission messages remain a separate future workflow. */
export interface Conversation {
  id: Id;
  teammateId: Id;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface MissionEvent {
  id: Id;
  missionId: Id;
  runId: Id | null;
  eventType: string;
  actorType: string;
  actorId: Id | null;
  payloadJson: Record<string, unknown>;
  createdAt: IsoDateTime;
}

export interface AuditEvent {
  id: Id;
  actorType: string;
  actorId: Id | null;
  action: string;
  targetType: string | null;
  targetId: Id | null;
  payloadJson: Record<string, unknown>;
  createdAt: IsoDateTime;
}

export interface UsageRecord {
  id: Id;
  missionId: Id | null;
  runId: Id | null;
  teammateId: Id;
  runtimeProfileId: Id;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  providerMetadata: Record<string, unknown> | null;
  estimatedCost: number | null;
  currency: string | null;
  createdAt: IsoDateTime;
}

export { canTransition, transition } from './mission-state.js';
