import type { CapabilityDimension, MissionMode, ModelAvailabilityStatus } from './index.js';

/** An execution contract, independent of Mission and any future Workflow implementation. */
export interface RoutingTaskContext {
  objective: string;
  requiredCapabilities?: CapabilityDimension[];
  /** Hard execution kind; explicit model/bridge/Party permits only its matching kind or omission. */
  executionConstraint?: 'AUTO' | 'SOLO' | 'PARTY' | 'HUMAN_BRIDGE';
  explicitTeammateId?: string;
  explicitPartyId?: string;
  partyMode?: Exclude<MissionMode, 'SOLO'>;
  inputArtifactMetadata?: Array<{ id: string; name: string; kind: string; mimeType?: string }>;
  expectedOutputContract?: {
    name: string;
    allowedExtensions: string[];
    maxSizeBytes: number;
  };
  executionContext?: { origin: string; executionId?: string; stepId?: string; stepType?: string };
}

export interface RoutingDemand {
  dimension: CapabilityDimension;
  weight: number;
  required: boolean;
}

export interface RoutingCandidateTrace {
  teammateId: string;
  runtimeProfileId: string | null;
  eligible: boolean;
  reason: string;
  benchmarkScore: number | null;
  semanticBonus: number;
  stabilityPenalty: number;
  rankingScore: number | null;
  availability: ModelAvailabilityStatus | null;
  probed: boolean;
}

export interface TaskExecutionAssignment {
  id: string;
  kind: 'SOLO' | 'PARTY' | 'HUMAN_BRIDGE';
  coordinatorTeammateId: string;
  memberTeammateIds: string[];
  partyId: string | null;
  mode: MissionMode;
  demand: RoutingDemand[];
  policyVersion: string;
}

export interface RoutingDecisionReceipt {
  id: string;
  assignment: TaskExecutionAssignment | null;
  taskSummary: string;
  contextHash: string;
  demand: RoutingDemand[];
  candidates: RoutingCandidateTrace[];
  decisionSignals: Array<{
    type: string;
    status: 'ACCEPTED' | 'IGNORED' | 'UNAVAILABLE';
    recommendation: string | null;
    confidence: number | null;
    requestHash: string;
    questionVersion: string;
    policyVersion: string;
    errorCode: string | null;
    inputTokens: number | null;
    latencyMs: number | null;
  }>;
  outcome: 'ASSIGNED' | 'USER_ACTION_REQUIRED';
  reason: string;
  policyVersion: string;
  createdAt: string;
}

export type RoutingPlanResult =
  | { status: 'ASSIGNED'; assignment: TaskExecutionAssignment; receipt: RoutingDecisionReceipt }
  | {
      status: 'USER_ACTION_REQUIRED';
      reason: string;
      actions: Array<'CONFIGURE_CAPABILITY' | 'RECHECK' | 'SELECT_OTHER' | 'CANCEL'>;
      receipt: RoutingDecisionReceipt;
    };
