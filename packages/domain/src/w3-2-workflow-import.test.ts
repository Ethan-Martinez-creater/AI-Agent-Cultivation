import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_IMPORT_POLICY_VERSION,
  canonicalWorkflowImportJson,
  toWorkflowImportProposalSafeDto,
  validateWorkflowImportConfirmation,
  validateWorkflowImportProposal,
  workflowImportMappingHash,
  workflowImportSourceMetadataHash,
  type WorkflowImportProposal,
  type WorkflowImportSource,
} from './w3-2-workflow-import.js';

const source: WorkflowImportSource = {
  id: 'source-a',
  name: 'brief.txt',
  relativePath: 'deliverables/brief.txt',
  workspaceRoot: 'E:/workspace',
  kind: 'TEXT',
  size: 8,
  content: 'Brief v1',
  contentHash: 'cc479039114f1a4ebab2755243628516d467b5c22da8b6be5e2cf4b01dbaa80a',
  mtime: 1_791_492_800_000,
};

function makeProposal(): WorkflowImportProposal {
  const sources = [source];
  return {
    id: 'proposal-a',
    revision: 1,
    status: 'DRAFT',
    definitionId: 'user.workflow',
    version: 1,
    versionHash: 'a'.repeat(64),
    inputSnapshot: {},
    description: 'Import a verified prefix',
    sources,
    resolution: {
      suggestedCompletedSteps: ['S01'],
      suggestedCurrentStep: 'S02',
      candidateArtifactBindings: [{ stepId: 'S01', outputKey: 'brief', sourceId: source.id }],
      missingRequirements: [],
      confidence: 0.9,
      explanationSummary: 'The source matches the declared output.',
    },
    sourceMetadataHash: workflowImportSourceMetadataHash(sources),
    policyVersion: WORKFLOW_IMPORT_POLICY_VERSION,
    validationStatus: 'VALID',
    validationErrors: [],
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    runId: null,
  };
}

describe('W3.2 Workflow Import domain facts', () => {
  it('keeps full source paths and content out of the safe DTO', () => {
    const proposal = makeProposal();
    validateWorkflowImportProposal(proposal);
    const safe = toWorkflowImportProposalSafeDto(proposal);
    expect(safe.sources).toEqual([
      { id: 'source-a', name: 'brief.txt', kind: 'TEXT', size: 8, contentHash: source.contentHash },
    ]);
    expect(canonicalWorkflowImportJson(safe)).not.toContain(source.content);
    expect(JSON.stringify(safe)).not.toContain(source.relativePath);
    expect(JSON.stringify(safe)).not.toContain(source.workspaceRoot);
  });

  it('allows an empty draft and retains bounded invalid mappings for diagnostics', () => {
    const proposal = makeProposal();
    proposal.sources = [];
    proposal.sourceMetadataHash = workflowImportSourceMetadataHash([]);
    proposal.validationStatus = 'INVALID';
    proposal.validationErrors = ['No source files were selected'];
    proposal.resolution = {
      suggestedCompletedSteps: ['S01'],
      suggestedCurrentStep: 'S01',
      candidateArtifactBindings: [{ stepId: 'S01', outputKey: 'brief', sourceId: 'missing-source' }],
      missingRequirements: ['S01.brief has no selected source'],
      confidence: 0.2,
      explanationSummary: '',
    };
    expect(() => validateWorkflowImportProposal(proposal)).not.toThrow();
  });

  it('requires strict source and mapping validity before marking a proposal valid', () => {
    const proposal = makeProposal();
    proposal.sources = [];
    proposal.sourceMetadataHash = workflowImportSourceMetadataHash([]);
    expect(() => validateWorkflowImportProposal(proposal)).toThrow(/at least one source/);
  });

  it('hashes confirmation mappings independently of caller order', () => {
    const completed = ['S01', 'S02'];
    const bindings = [
      { stepId: 'S02', outputKey: 'summary', sourceId: 'source-b' },
      { stepId: 'S01', outputKey: 'brief', sourceId: 'source-a' },
    ];
    const confirmation = {
      id: 'confirm-a',
      proposalId: 'proposal-a',
      runId: 'run-a',
      versionHash: 'a'.repeat(64),
      sourceMetadataHash: 'b'.repeat(64),
      completedStepIds: completed,
      currentStepId: 'S03',
      bindings,
      mappingHash: workflowImportMappingHash(completed, 'S03', [...bindings].reverse()),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    expect(() => validateWorkflowImportConfirmation(confirmation)).not.toThrow();
    confirmation.mappingHash = 'c'.repeat(64);
    expect(() => validateWorkflowImportConfirmation(confirmation)).toThrow(/mappingHash/);
  });
});
