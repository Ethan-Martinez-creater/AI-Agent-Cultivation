import type {
  ApprovalRequest,
  CapabilityDimension,
  Mission,
  MissionMode,
  MemoryRecord,
  MemoryType,
  Party,
  PermissionRule,
  PermissionScopeRef,
  RuntimeProfile,
  Skill,
  Teammate,
  ToolDescriptor,
} from '@cultivation/domain';
export * from './w1-workflow-ports.js';
export * from './w1-workflow-service.js';
export * from './research-delivery-projection.js';
export * from './workflow-validation-policy-registry.js';
export * from './w1-artifact-context.js';

export { Gate6ExperienceService, buildCapabilityProfile } from './gate6-experience-service.js';
export type { Gate6ExperienceSnapshot, Gate6ExperienceStore } from './gate6-experience-service.js';
export { BenchmarkPriorResolver } from './r1-benchmark-prior.js';
export { BENCHMARK_SOURCE_CATALOG } from './r1-benchmark-source-catalog.js';
export type { BenchmarkSourceCatalogEntry } from './r1-benchmark-source-catalog.js';
export {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_SCORING_POLICY,
  calculateCapabilityScore,
  projectCapabilityScore,
  ratingStarsToScore,
} from './r1-capability-scoring.js';
export type { CapabilityScoreProjection } from './r1-capability-scoring.js';
export { R1CapabilityService } from './r1-capability-service.js';
export type {
  R1CapabilityDimensionProfile,
  R1CapabilityProfile,
  R1CapabilityProfileSource,
  R1CapabilityStore,
  R1EffectiveBenchmarkPrior,
  R1MissionRunRatingTargetFact,
  R1RatingTarget,
  R1CapabilityServiceOptions,
  R1RuntimeTeammate,
  R1RuntimeTeammateReference,
  SubmitCapabilityRatingInput,
  SubmitCapabilityRatingResult,
} from './r1-capability-service.js';
export type {
  DecisionQuestion,
  DecisionGateway,
  DecisionRequest,
  DecisionResult,
  DecisionType,
} from './r0-decision.js';
export {
  CAPABILITY_BAND_POLICY,
  DECISION_STATE_BUDGET,
  DecisionStateBudgetError,
  DecisionStateBuilder,
  R3_DECISION_QUESTION_VERSIONS,
  R3_DECISION_STATE_VERSION,
  R3_SHADOW_POLICY_VERSION,
  canonicalDecisionJson,
} from './r3-decision-state.js';
export type {
  CapabilityAvailability,
  CapabilityBand,
  CapabilityStateInput,
  DecisionCandidateInput,
  DecisionSkillMetadata,
  DecisionStateBuildResult,
  VerifiedExperienceSummary,
} from './r3-decision-state.js';
export { ShadowDecisionService } from './r3-shadow-service.js';
export type {
  DecisionFallbackCode,
  DecisionObservationPort,
  DecisionShadowObservation,
  ShadowDecisionContext,
  ShadowDecisionOutcome,
  ShadowDecisionServiceOptions,
} from './r3-shadow-service.js';
export type {
  CapabilityRepository,
  DecisionReceiptRepository,
  ExternalWorkRepository,
  HumanBridgeBootstrapRepository,
} from './r0-repositories.js';

/** Application ports contain no Electron, SQLite or provider SDK types. */
export interface SecretStore {
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<string>;
}

export interface ProviderRegistry {
  getRuntimeProfile(id: string): Promise<RuntimeProfile | null>;
  listModelIds(providerId: string): Promise<string[]>;
}

export type ModelToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  /** Stable ToolDescriptor ID. The provider adapter may map it to a provider-safe name. */
  toolName: string;
  input: unknown;
};
export type ModelToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  /** Stable ToolDescriptor ID matching the assistant tool-call part. */
  toolName: string;
  output: {
    type: 'json';
    value: {
      classification: 'UNTRUSTED_EXTERNAL_DATA';
      toolId: string;
      ok: boolean;
      code: string | null;
      content: string;
    };
  };
};
export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | ModelToolCallPart[] }
  | { role: 'tool'; content: ModelToolResultPart[] };

/** Explicit external-work data supplied after a Human Bridge submission. It is never a Chat/user/tool message. */
export interface ModelExternalWorkContext {
  requestId: string;
  capability: CapabilityDimension;
  outcome: 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  publicResult: string | null;
  artifacts: Array<{
    path: string;
    fileName: string;
    extension: string;
    sizeBytes: number;
  }>;
  trust: 'UNTRUSTED_EXTERNAL_DATA';
}

export interface ModelRequest {
  /** Main-owned structured participant completion contract; ordinary Chat is unchanged. */
  participantOutcomeContract?: 'g3-v1';
  runtimeProfileId: string;
  teammateId: string;
  messages: ModelMessage[];
  externalWorkContext?: ModelExternalWorkContext;
  /** Durable call-start evidence is written after availability preflight and before provider I/O. */
  onCallStarted?: () => void | Promise<void>;
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
export interface ModelToolCall {
  id: string;
  toolId: string;
  input: unknown;
}
export interface ModelToolResponse extends ModelResponse {
  toolCalls: ModelToolCall[];
}
export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'finish'; usage: ModelUsage };
export interface ModelConnectionTestResult {
  ok: boolean;
  message: string;
}
export interface CollaborationProposal {
  targetTeammateId: string;
  reason: string;
  task: string;
  expectedBenefit: string;
  /** Declarative generation requirements, validated by trusted execution preparation. */
  generationRequirements?: {
    capability: import('@cultivation/domain/g1-generation').GenerationCapability;
    requiredFeatures: string[];
    parameters: Record<string, unknown>;
    inputRequirements?: Array<{
      role: string;
      artifactKinds: string[];
      mimeTypes: string[];
      required: boolean;
    }>;
    reviewCapability?: CapabilityDimension;
  };
}
export interface CollaborationProposalRequest {
  runtimeProfileId: string;
  teammateId: string;
  mode: Extract<MissionMode, 'CONSULTATION' | 'REVIEW' | 'DELEGATION'>;
  objective: string;
  eligibleTargetIds: string[];
  publicDraft: string | null;
  /** Public sealed execution metadata; no Credentials, private Memory or Provider endpoints. */
  eligibleExecutors?: Array<{
    teammateId: string;
    executionProtocol: 'LANGUAGE' | 'GENERATION' | 'USER_BRIDGE';
    descriptor?: import('@cultivation/domain/g1-generation').GenerationModelDescriptor;
  }>;
  /** Composed context for the requesting Teammate only; never another member's private context. */
  systemContext: string;
  /** Durable proposal-call start, invoked after availability preflight and before provider I/O. */
  onCallStarted?: () => void | Promise<void>;
}
export interface CollaborationProposalResult {
  proposal: CollaborationProposal;
  usage: ModelUsage;
}
export interface ModelGateway {
  /** True when this gateway invokes request.onCallStarted only after its own preflight. */
  handlesCallStart?: true;
  /** Optional availability/eligibility preflight before durable execution facts. */
  prepare?(request: { teammateId: string; runtimeProfileId: string }): Promise<void>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  generateWithTools?(
    request: ModelRequest & { tools: ToolDescriptor[] },
  ): Promise<ModelToolResponse>;
  proposeCollaboration?(
    request: CollaborationProposalRequest,
  ): Promise<CollaborationProposalResult>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  testConnection(runtimeProfileId: string): Promise<ModelConnectionTestResult>;
}

/** A model may propose facts from evidence; ownership and status are set by the application. */
export interface MemoryCandidateDraft {
  memoryType: MemoryType;
  content: string;
  summary: string;
  importance: number;
  confidence: number;
}
export interface MemoryCandidateRequest {
  runtimeProfileId: string;
  teammateId: string;
  evidence: string;
}
export interface MemoryCandidateResult {
  candidates: MemoryCandidateDraft[];
  usage: ModelUsage;
}
export interface MemoryCandidateExtractor {
  extractCandidates(request: MemoryCandidateRequest): Promise<MemoryCandidateResult>;
}

export interface EmbeddingRequest {
  runtimeProfileId: string;
  teammateId: string;
  text: string;
}
export interface EmbeddingResult {
  vector: number[];
  usage: ModelUsage;
}
export interface EmbeddingGateway {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
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

export {
  ExternalWorkService,
  HumanBridgeService,
  HUMAN_BRIDGE_PRIOR_SOURCE,
  HUMAN_BRIDGE_SCORING_POLICY_VERSION,
  HUMAN_BRIDGE_SYSTEM_ID,
} from './r2-human-bridge-service.js';
export type {
  CreateExplicitExternalWorkInput,
  ExternalWorkArtifactSubmission,
  ExternalWorkArtifactSummary,
  ExternalWorkArtifactTarget,
  ExternalWorkContinuation,
  ExternalWorkCreatedNotification,
  ExternalWorkDetail,
  ExternalWorkRequestRecord,
  HumanBridgeCapabilityDimensionProfile,
  HumanBridgeCapabilityProfile,
  HumanBridgeCapabilitySetting,
  HumanBridgeDisplayInput,
  HumanBridgeRatingInput,
  HumanBridgeRatingResult,
  HumanBridgeServiceOptions,
  HumanBridgeServiceStore,
  R2HumanBridgeServiceStore,
  SaveHumanBridgeExternalAppProfileInput,
  SubmitExternalWorkArtifactsInput,
  ValidatedWorkspaceArtifact,
  WorkspaceArtifactConstraints,
  WorkspaceArtifactValidator,
} from './r2-human-bridge-service.js';

export {
  AvailabilityAwareModelGateway,
  AvailabilityService,
  ModelUnavailableError,
  RoutingEligibilityService,
} from './r3-2-availability.js';
export type {
  AvailabilityIdentityStore,
  AvailabilityServiceOptions,
  AvailabilityStore,
  ModelAvailabilityProbe,
  ModelUnavailableResult,
  PrepareModelOutcome,
  PrepareModelResult,
  RoutingEligibilityOptions,
} from './r3-2-availability.js';
export * from './r4-routing-planner.js';
export * from './r4-decision-service.js';
export * from './r4-routing-mission-service.js';
export * from './w2-contracts.js';
export * from './w2-builtin-installer.js';
export type { WorkflowFoundationPort } from './w2-workflow-ports.js';
