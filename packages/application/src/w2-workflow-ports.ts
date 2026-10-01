import type {
  ArtifactContract,
  RevisionTraversal,
  StepOperationReceipt,
} from '@cultivation/domain';

/** Main-only durable foundation; uses the same SQLite connection/transaction as W1. */
export interface WorkflowFoundationPort {
  registerContract(contract: ArtifactContract): void;
  getContract(id: string, version: string): ArtifactContract | null;
  appendRevisionTraversal(value: RevisionTraversal): void;
  listTraversals(runId: string): RevisionTraversal[];
  prepareOperation(value: StepOperationReceipt): void;
  transitionOperation(
    value: StepOperationReceipt,
    expectedState: StepOperationReceipt['state'],
  ): boolean;
  listOperations(runId: string): StepOperationReceipt[];
}
