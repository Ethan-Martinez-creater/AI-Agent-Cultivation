import type {
  WorkflowImportConfirmation,
  WorkflowImportProposal,
  WorkflowImportedArtifact,
  WorkflowImportedBinding,
  WorkflowImportedValidation,
} from '@cultivation/domain';

/** Main-owned W3.2 persistence boundary; it contains no filesystem or UI APIs. */
export interface WorkflowImportRepositoryPort {
  transaction<T>(fn: () => T): T;
  getProposal(id: string): WorkflowImportProposal | null;
  listProposals(): WorkflowImportProposal[];
  insertProposal(value: WorkflowImportProposal): void;
  /** Compare-and-swap a proposal revision; false means another edit won. */
  saveProposal(value: WorkflowImportProposal, expectedRevision: number): boolean;
  appendConfirmation(value: WorkflowImportConfirmation): void;
  getConfirmationByProposal(proposalId: string): WorkflowImportConfirmation | null;
  getConfirmationByRun(runId: string): WorkflowImportConfirmation | null;
  appendImportedArtifact(value: WorkflowImportedArtifact): void;
  appendImportedBinding(value: WorkflowImportedBinding): void;
  appendImportedValidation(value: WorkflowImportedValidation): void;
}
