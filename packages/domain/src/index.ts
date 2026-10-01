import type { Id, IsoDateTime } from '@cultivation/shared';
export * from './w1-workflow.js';
export * from './w1-workflow-contract.js';
export * from './w2-workflow.js';

export type TeammateStatus = 'ACTIVE' | 'ARCHIVED';
export type Realm = 'QI_REFINING' | 'FOUNDATION' | 'CORE' | 'NASCENT_SOUL';
export type ExecutorKind = 'MODEL_RUNTIME' | 'USER_BRIDGE';
export type RoutingPolicy = 'NORMAL' | 'FALLBACK_ONLY' | 'MANUAL_ONLY';
export type SystemKind = 'HUMAN_BRIDGE';
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
  executorKind: ExecutorKind;
  routingPolicy: RoutingPolicy;
  systemKind: SystemKind | null;
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

/** Immutable provider/model identity captured before live connection verification. */
export interface RuntimeIdentitySnapshot {
  providerId: Id;
  providerKind: ProviderKind;
  baseUrl: string | null;
  modelId: string;
  credentialId: Id | null;
  runtimeUpdatedAt: IsoDateTime;
  providerUpdatedAt: IsoDateTime;
  credentialUpdatedAt: IsoDateTime | null;
}

/** Sealed provider/model identity for one MODEL_RUNTIME teammate. Credentials may rotate. */
export interface TeammateModelBinding {
  teammateId: Id;
  runtimeProfileId: Id;
  providerKind: ProviderKind;
  endpoint: string | null;
  modelId: string;
  credentialId: Id | null;
  verifiedAt: IsoDateTime | null;
  verificationSource: 'LIVE_TEST' | 'LEGACY_STRUCTURAL';
  sealedAt: IsoDateTime;
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
  capability: PermissionCapability;
}

/** User-configured stdio MCP server settings. Only environment variable names are stored. */
export interface McpServerConfig {
  id: Id;
  name: string;
  command: string;
  args: string[];
  envWhitelist: string[];
  cwd: string | null;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
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

/** A Teammate explicitly assigned to one Mission; ordering is stable for presentation. */
export interface MissionParticipant {
  missionId: Id;
  teammateId: Id;
  role: 'COORDINATOR' | 'MEMBER' | 'AUTHOR' | 'REVIEWER';
  sortOrder: number;
}

export type MissionMode = 'SOLO' | 'CONSULTATION' | 'REVIEW' | 'DELEGATION';
export type MissionState =
  | 'DRAFT'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_COLLABORATION'
  | 'WAITING_EXTERNAL_WORK'
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

export type PendingToolCallState = 'PENDING' | 'RESOLVED';
/** Bounded, resumable tool input attached to one approval and the same Mission Run. */
export interface PendingToolCall {
  approvalId: Id;
  missionId: Id;
  runId: Id;
  toolId: Id;
  source: ToolSource;
  capability: PermissionCapability;
  inputJson: string;
  stepCount: number;
  toolCallCount: number;
  state: PendingToolCallState;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

export type CollaborationState = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED';
export interface CollaborationRequest {
  id: Id;
  missionId: Id;
  /** Null only for legacy pre-Gate-5 rows that were created without a MissionRun link. */
  runId: Id | null;
  requesterTeammateId: Id;
  targetTeammateId: Id;
  reason: string;
  proposedTask: string;
  expectedBenefit: string;
  /** Delegation depth is bounded to 0 (initiative/consultation) or 1 (delegation). */
  depth: 0 | 1;
  state: CollaborationState;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

export type Gate5PendingToolCallState = 'PENDING' | 'RESOLVED';
/** Restart-safe Gate 5 continuation snapshot for member-owned tool approval. */
export interface Gate5PendingToolCall {
  approvalId: Id;
  missionId: Id;
  runId: Id;
  teammateId: Id;
  /** Bounded JSON continuation context; includes task/artifact state, never private Memory text. */
  contextJson: string;
  stepCount: number;
  toolCallCount: number;
  state: Gate5PendingToolCallState;
  createdAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
}

export type CollaborationArtifactKind = 'MEMBER_RESULT' | 'DRAFT' | 'REVIEW' | 'FINAL';
/** Only bounded, Mission-public outputs belong here; private Memory is never an artifact. */
export interface CollaborationArtifact {
  id: Id;
  missionId: Id;
  runId: Id;
  teammateId: Id;
  kind: CollaborationArtifactKind;
  content: string;
  createdAt: IsoDateTime;
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

/** Append-only, provenance-backed record of one teammate's real Mission activity. */
export interface ExperienceEvent {
  id: Id;
  teammateId: Id;
  missionId: Id;
  runId: Id;
  experienceType: 'MISSION_RESULT' | 'COLLABORATION' | 'TOOL_USE' | 'SKILL_USE' | 'EXTERNAL_WORK';
  source: string;
  sourceId: Id;
  role: string;
  outcome: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  mode: MissionMode;
  createdAt: IsoDateTime;
}

/** Rebuilt from ExperienceEvent rows whenever requested; never a scoring source. */
export interface CapabilityProfile {
  teammateId: Id;
  completedMissions: number;
  failedMissions: number;
  cancelledMissions: number;
  consultationParticipations: number;
  reviewParticipations: number;
  delegationParticipations: number;
  toolUses: number;
  completedCollaborations: number;
  skillUses: number;
  lastActiveAt: IsoDateTime | null;
}

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

export type BenchmarkProvenanceType = 'CATALOG' | 'USER_OVERRIDE' | 'USER_ESTIMATE';

/** Static, versioned benchmark data attached to a Runtime/model alias. */
export interface ModelCapabilityBenchmark {
  id: Id;
  runtimeProfileId: Id;
  modelAlias: string;
  dimension: CapabilityDimension;
  supported: boolean;
  /** Null when unsupported; keep this distinct from a supported low score. */
  normalizedScore: number | null;
  rawScore: number | null;
  source: string;
  benchmark: string;
  benchmarkVersion: string;
  snapshotDate: IsoDateTime;
  sourceUrl: string | null;
  provenanceType: BenchmarkProvenanceType;
  createdAt: IsoDateTime;
}

/** Dynamic capability state derived from fact-backed CapabilityEvidence. */
export interface TeammateCapabilityState {
  teammateId: Id;
  dimension: CapabilityDimension;
  currentScore: number;
  evidenceWeight: number;
  ratingCount: number;
  currentRuntimeProfileId: Id | null;
  scoringPolicyVersion: string;
  updatedAt: IsoDateTime;
}

export type CapabilityEvidenceSourceType = 'USER_DIMENSION_RATING' | 'USER_OVERALL_RATING';

/** Append-only user evidence; a bridge rating may not be tied to a Runtime profile. */
export interface CapabilityEvidence {
  id: Id;
  teammateId: Id;
  runtimeProfileId: Id | null;
  missionId: Id;
  runId: Id;
  dimension: CapabilityDimension;
  sourceType: CapabilityEvidenceSourceType;
  ratingValue: number;
  demandWeight: number;
  evidenceWeight: number;
  createdAt: IsoDateTime;
}

/** One dimension's probability and whether it is a hard requirement for a task. */
export interface TaskCapabilityDemand {
  dimension: CapabilityDimension;
  probability: number;
  required: boolean;
}

export type DecisionReceiptMode = 'SHADOW' | 'ADVISORY' | 'ACTIVE';

/** Bounded audit record of a Decision Plane result; inputSummary excludes private source text. */
export interface DecisionReceipt {
  id: Id;
  missionId: Id | null;
  runId: Id | null;
  decisionType: string;
  provider: string;
  model: string;
  modelVersion: string;
  questionVersion: string;
  stateHash: string;
  /** Maximum 2,000 characters; persistence validates the bound. */
  inputSummary: string;
  answersJson: Record<string, unknown>;
  confidenceJson: Record<string, unknown>;
  policyVersion: string;
  /** Shadow recommendation only; it does not describe an action already applied. */
  selectedAction: string | null;
  /** Existing real behavior at observation time; distinct from the shadow recommendation. */
  actualAction?: string | null;
  /** Provider-reported/observed timing and token counts; absent means unknown. */
  latencyMs?: number | null;
  inputTokens?: number | null;
  mode: DecisionReceiptMode;
  createdAt: IsoDateTime;
}

export type ExternalWorkRequestState =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED';

export interface ExternalWorkTextItems {
  items: string[];
}

export interface ExternalWorkArtifactTarget {
  id: Id;
  name: string;
  required: boolean;
  allowedExtensions: string[];
  maxSizeBytes: number;
}

export interface ExternalWorkTargetArtifacts {
  items: ExternalWorkArtifactTarget[];
}

/** User-owned external work that can pause a Mission while awaiting an artifact. */
export interface ExternalWorkRequest {
  id: Id;
  missionId: Id;
  runId: Id;
  requesterTeammateId: Id;
  assigneeTeammateId: Id;
  capability: CapabilityDimension;
  title: string;
  prompt: string;
  requirementsJson: ExternalWorkTextItems;
  targetArtifactsJson: ExternalWorkTargetArtifacts;
  targetWorkspacePathsJson: ExternalWorkTextItems;
  acceptanceCriteriaJson: ExternalWorkTextItems;
  externalAppProfileId: Id | null;
  /** Bounded, explicitly public result text. User supplied content remains untrusted. */
  publicResult: string | null;
  state: ExternalWorkRequestState;
  createdAt: IsoDateTime;
  submittedAt: IsoDateTime | null;
  resolvedAt: IsoDateTime | null;
}

/** File metadata submitted to satisfy an ExternalWorkRequest. */
export interface ExternalWorkArtifact {
  id: Id;
  externalWorkRequestId: Id;
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  mimeType: string | null;
  metadataJson: Record<string, unknown>;
  submittedAt: IsoDateTime;
}

/** User-configured app that can be suggested for external work; stores no credentials. */
export interface ExternalAppProfile {
  id: Id;
  teammateId: Id;
  name: string;
  vendor: string | null;
  capabilities: CapabilityDimension[];
  notes: string | null;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export { canTransition, transition } from './mission-state.js';

export * from './r3-2-availability.js';
export * from './r4-routing.js';
