/** The decision plane is independent of the generative ModelGateway. */
export type DecisionType =
  | 'TASK_CAPABILITY'
  | 'TEAMMATE_FIT'
  | 'COLLABORATION_NEED'
  | 'REVIEW_NEED'
  | 'SKILL_RELEVANCE'
  | 'MEMORY_EXTRACTION_NEED'
  | 'MEMORY_RELEVANCE';

/** R3 remains a separate, shadow-only consumer of the original four decisions. */
export type ShadowDecisionType = Exclude<
  DecisionType,
  'SKILL_RELEVANCE' | 'MEMORY_EXTRACTION_NEED' | 'MEMORY_RELEVANCE'
>;

export interface DecisionQuestion {
  type: 'noul' | 'choice';
  instructions: string;
  criteria?: Record<string, string | null>;
}

/** Decision-specific validators allow only bounded state; no general source-data authority. */
export interface DecisionRequest {
  decisionType: DecisionType;
  questionVersion: string;
  stateHash: string;
  policyVersion: string;
  /** Explicit allowlisted decision state. Never unbounded source text or private history. */
  state: Record<string, unknown>;
  /** Small independent questions; adapter owns provider-specific serialization. */
  questions: Record<string, DecisionQuestion>;
  inputSummary: {
    taskSummary: string;
    candidateIds: string[];
    capabilityBands?: Record<string, string>;
  };
}

/** Generic fail-open status, independent of any provider SDK. */
export type DecisionErrorCode =
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'SCHEMA_MISMATCH';

/** Advisory data only. Code remains responsible for eligibility and authority. */
export interface DecisionResult {
  answers: Record<string, unknown>;
  confidence: Record<string, number>;
  selectedAction: string | null;
  model?: string | null;
  inputTokens?: number | null;
  latencyMs?: number | null;
  /** Provider-reported choice distribution, kept outside normalized domain answers. */
  choiceProbabilities?: Record<string, number>;
  errorCode?: DecisionErrorCode | null;
}

export interface DecisionGateway {
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}
