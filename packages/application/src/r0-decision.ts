/** The decision plane is independent of the generative ModelGateway. */
export type DecisionType =
  | 'TASK_CAPABILITY'
  | 'TEAMMATE_FIT'
  | 'COLLABORATION_NEED'
  | 'REVIEW_NEED';

/** A deliberately small state summary; private Memory and file contents have no slot. */
export interface DecisionRequest {
  decisionType: DecisionType;
  questionVersion: string;
  stateHash: string;
  inputSummary: {
    taskSummary: string;
    candidateIds: string[];
    capabilityBands?: Record<string, string>;
  };
}

/** Advisory data only. Code remains responsible for eligibility and authority. */
export interface DecisionResult {
  answers: Record<string, unknown>;
  confidence: Record<string, number>;
  selectedAction: string | null;
}

export interface DecisionGateway {
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}
