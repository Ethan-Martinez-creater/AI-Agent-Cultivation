import type {
  CapabilityDimension,
  CapabilityEvidence,
  DecisionReceipt,
  ExternalAppProfile,
  ExternalWorkArtifact,
  ExternalWorkRequest,
  ModelCapabilityBenchmark,
  TeammateCapabilityState,
} from '@cultivation/domain';

/** R0 catalog and evidence ports. No routing policy consumes these records yet. */
export interface CapabilityRepository {
  saveModelCapabilityBenchmark(value: ModelCapabilityBenchmark): void;
  getModelCapabilityBenchmark(id: string): ModelCapabilityBenchmark | null;
  listModelCapabilityBenchmarks(
    runtimeProfileId: string,
    modelAlias?: string,
  ): ModelCapabilityBenchmark[];
  saveTeammateCapabilityState(value: TeammateCapabilityState): void;
  getTeammateCapabilityState(
    teammateId: string,
    dimension: CapabilityDimension,
  ): TeammateCapabilityState | null;
  listTeammateCapabilityStates(teammateId: string): TeammateCapabilityState[];
  appendCapabilityEvidence(value: CapabilityEvidence): void;
  listCapabilityEvidence(teammateId: string, dimension?: CapabilityDimension): CapabilityEvidence[];
}

/** A receipt stores bounded decision summaries, not private Memory or raw prompts. */
export interface DecisionReceiptRepository {
  appendDecisionReceipt(value: DecisionReceipt): void;
  getDecisionReceipt(id: string): DecisionReceipt | null;
  listDecisionReceipts(missionId?: string, runId?: string): DecisionReceipt[];
}

/** Persistence only: actual external work execution belongs to later gates. */
export interface ExternalWorkRepository {
  createExternalWorkRequest(value: ExternalWorkRequest): void;
  getExternalWorkRequest(id: string): ExternalWorkRequest | null;
  listExternalWorkRequests(missionId?: string, runId?: string): ExternalWorkRequest[];
  transitionExternalWorkRequest(
    id: string,
    state: ExternalWorkRequest['state'],
    at: string,
  ): ExternalWorkRequest | null;
  appendExternalWorkArtifact(value: ExternalWorkArtifact): void;
  listExternalWorkArtifacts(requestId: string): ExternalWorkArtifact[];
  saveExternalAppProfile(value: ExternalAppProfile): void;
  listExternalAppProfiles(teammateId: string): ExternalAppProfile[];
}
