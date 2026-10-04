import { describe, expect, it } from 'vitest';
import {
  validateArtifactContract,
  validateWorkflowInputSchema,
  validateWorkflowInputs,
  validateWorkflowVersion,
} from '@cultivation/domain';
import { validateBuiltinWorkflowRelease } from '../../w2-contracts.js';
import {
  RESEARCH_CONTRACTS,
  RESEARCH_DEFINITION_ID,
  RESEARCH_PACKAGE,
  RESEARCH_PHASES,
  RESEARCH_REVISION_GROUPS,
  RESEARCH_VALIDATION_POLICY,
  RESEARCH_VERSION_1,
} from './v1.js';

const validInputs = {
  researchQuestion: 'Does deterministic retrieval improve result reproducibility?',
  field: 'Information retrieval',
  experimentMode: 'COMPUTATIONAL',
  maxExperimentCycles: 2,
  literatureTimeRange: { from: '2020-01-01', to: '2026-01-01' },
  existingSources: [{ id: 'source-1', kind: 'EXTERNAL_REFERENCE', name: 'Reference metadata' }],
  existingData: [],
  existingCode: [],
};

describe('official research v1 package', () => {
  it('is an immutable production package with a valid canonical release manifest', () => {
    expect(RESEARCH_PACKAGE.kind).toBe('OFFICIAL');
    expect(RESEARCH_VERSION_1.definition.source).toBe('BUILTIN');
    expect(RESEARCH_VERSION_1.definition.id).toBe(RESEARCH_DEFINITION_ID);
    expect(RESEARCH_VERSION_1.version).toBe(1);
    expect(RESEARCH_VERSION_1.validationPolicy).toBe(RESEARCH_VALIDATION_POLICY);
    expect(validateBuiltinWorkflowRelease(RESEARCH_VERSION_1)).toMatch(/^[a-f0-9]{64}$/);
    const tamperedVersion = {
      ...RESEARCH_VERSION_1,
      steps: RESEARCH_VERSION_1.steps.map((step) =>
        step.id === 'R13' ? { ...step, objective: `${step.objective} altered` } : step,
      ),
    };
    expect(() => validateBuiltinWorkflowRelease(tamperedVersion)).toThrow();
    expect(Object.isFrozen(RESEARCH_PACKAGE)).toBe(true);
    expect(Object.isFrozen(RESEARCH_VERSION_1.steps)).toBe(true);
    expect(Object.isFrozen(RESEARCH_VERSION_1.steps[7]?.effectPaths)).toBe(true);
    expect(Object.isFrozen(RESEARCH_VERSION_1.contractManifest)).toBe(true);
    expect(() => validateWorkflowVersion(RESEARCH_VERSION_1)).not.toThrow();
  });

  it('declares exactly R01-R14 in the six user-facing phases', () => {
    expect(RESEARCH_VERSION_1.steps.map((step) => step.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `R${String(index + 1).padStart(2, '0')}`),
    );
    expect(RESEARCH_PHASES.map((phase) => [phase.id, phase.title])).toEqual([
      ['exploration', '探索'],
      ['hypothesis', '假设'],
      ['experiment', '实验'],
      ['analysis', '分析'],
      ['writing', '写作'],
      ['review', '审查'],
    ]);
    expect(RESEARCH_PHASES.flatMap((phase) => phase.steps).sort()).toEqual(
      RESEARCH_VERSION_1.steps.map((step) => step.id).sort(),
    );
  });

  it('deterministically bounds and validates the frozen Workflow inputs', () => {
    expect(validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, validInputs)).toEqual(
      validInputs,
    );
    const { researchQuestion: _required, field: _field, ...missingQuestion } = validInputs;
    expect(() =>
      validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, missingQuestion),
    ).toThrow();
    expect(() =>
      validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, {
        ...validInputs,
        maxExperimentCycles: 3,
      }),
    ).toThrow();
    expect(() =>
      validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, {
        ...validInputs,
        experimentMode: 'AUTOMATIC',
      }),
    ).toThrow();
    expect(() =>
      validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, {
        ...validInputs,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, {
        ...validInputs,
        existingSources: Array.from({ length: 13 }, (_, index) => ({
          id: `source-${index}`,
          kind: 'EXTERNAL_REFERENCE',
        })),
      }),
    ).toThrow();
    expect(() =>
      validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, {
        ...validInputs,
        literatureTimeRange: { from: '2026-01-01', to: '2020-01-01' },
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkflowInputs(RESEARCH_VERSION_1.inputSchema!, {
        ...validInputs,
        existingSources: [{ id: 'source-1', kind: 'FILE', path: 'C:/secret.txt' }],
      }),
    ).toThrow();
  });

  it('registers versioned research artifact contracts with bounded structured fields', () => {
    expect(RESEARCH_CONTRACTS.map((contract) => contract.contractId)).toEqual([
      'research.brief',
      'research.literature',
      'research.evidence',
      'research.screening',
      'research.landscape',
      'research.gaps',
      'research.hypotheses',
      'research.experiment_plan',
      'research.experiment_record',
      'research.analysis',
      'research.analysis_results',
      'research.manuscript',
      'research.claim-evidence-map',
      'research.review',
      'research.revised-manuscript',
      'research.revision-response',
      'research.raw-result',
      'research.experiment-log',
      'research.source-packet',
      'research.figures',
      'research.final-package',
    ]);
    expect(RESEARCH_CONTRACTS.every((contract) => contract.contractVersion === '1')).toBe(true);
    expect(new Set(RESEARCH_CONTRACTS.map((contract) => contract.contractId)).size).toBe(
      RESEARCH_CONTRACTS.length,
    );
    const visit = (schema: unknown): void => {
      if (!schema || typeof schema !== 'object') return;
      const record = schema as Record<string, unknown>;
      if (record.type === 'array') expect(record.maxItems).toBeLessThanOrEqual(20);
      if (record.type === 'object') {
        expect(Object.keys(record.properties as object).length).toBeLessThanOrEqual(16);
        Object.values(record.properties as Record<string, unknown>).forEach(visit);
      }
      if (record.items) visit(record.items);
    };
    for (const contract of RESEARCH_CONTRACTS)
      if (contract.validator.type === 'JSON_SCHEMA') {
        visit(contract.validator.schema);
        try {
          validateWorkflowInputSchema(contract.validator.schema);
        } catch (error) {
          throw new Error(`${contract.contractId}: ${String(error)}`);
        }
      }
  });

  it('keeps research loops declared, bounded, and based on frozen experiment-cycle input', () => {
    expect(RESEARCH_REVISION_GROUPS).toEqual({
      hypothesis: 'research.hypothesis_revision',
      experiment: 'research.experiment_cycle',
      manuscript: 'research.manuscript_revision',
    });
    const groups = RESEARCH_VERSION_1.revisionGroups!;
    expect(groups.map(({ id, maxTotalTraversals }) => [id, maxTotalTraversals])).toEqual([
      ['research.hypothesis_revision', 2],
      ['research.experiment_cycle', 2],
      ['research.manuscript_revision', 2],
    ]);
    const experimentEdges = RESEARCH_VERSION_1.edges.filter(
      (edge) => edge.revision?.groupId === RESEARCH_REVISION_GROUPS.experiment,
    );
    expect(
      experimentEdges.map((edge) => [edge.fromStepId, edge.toStepId, edge.revision?.maxTraversals]),
    ).toEqual([
      ['R10', 'R07', 2],
      ['R10', 'R05', 2],
    ]);
    expect(RESEARCH_VERSION_1.inputSchema!.properties.maxExperimentCycles).toMatchObject({
      type: 'number',
      minimum: 1,
      maximum: 2,
      integer: true,
    });
    expect(RESEARCH_VERSION_1.steps.find((step) => step.id === 'R10')?.outputs).toEqual([]);
    expect(
      RESEARCH_VERSION_1.steps.find((step) => step.id === 'R10')?.routing.requiredCapabilities,
    ).toEqual([]);
  });

  it('freezes trusted attempt effects, deterministic signals, review provenance, and final lineage', () => {
    const byId = (stepId: string) => RESEARCH_VERSION_1.steps.find((step) => step.id === stepId)!;
    expect(byId('R08')).toMatchObject({
      effectType: 'FILE_OUTPUT',
      effectPaths: ['research/raw-result.json', 'research/experiment-log.txt'],
      artifactPathScope: 'RUN_ATTEMPT',
    });
    expect(byId('R08').outputs.map((spec) => [spec.key, spec.kind])).toEqual([
      ['research.experiment_record', 'JSON'],
      ['research.raw_result', 'FILE'],
      ['research.experiment_log', 'FILE'],
    ]);
    expect(
      RESEARCH_CONTRACTS.find((contract) => contract.contractId === 'research.experiment-log'),
    ).toMatchObject({ kind: 'FILE' });
    expect(byId('R06').executionRequirements?.independentReviewOfStepIds).toEqual(['R05']);
    expect(byId('R12').executionRequirements?.independentReviewOfStepIds).toEqual(['R11', 'R13']);
    expect(byId('R09').outputs.map((spec) => spec.key)).toEqual([
      'research.analysis',
      'research.analysis_results',
      'research.figures',
    ]);
    const resultsContract = RESEARCH_CONTRACTS.find(
      (contract) => contract.contractId === 'research.analysis_results',
    )!;
    expect(resultsContract.validator).toMatchObject({
      type: 'JSON_SCHEMA',
      schema: {
        properties: {
          dataComplete: { type: 'boolean' },
          executionValid: { type: 'boolean' },
          refinementTarget: { type: 'enum', values: ['NONE', 'EXPERIMENT', 'HYPOTHESIS'] },
        },
      },
    });
    expect(
      (resultsContract.validator as { schema: { properties: Record<string, unknown> } }).schema
        .properties,
    ).not.toHaveProperty('decision');
    expect(byId('R12').inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'revised_manuscript', fromStepId: 'R13', required: false }),
        expect.objectContaining({
          key: 'revised_claim_evidence_map',
          fromStepId: 'R13',
          required: false,
        }),
      ]),
    );
    expect(byId('R13').inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'manuscript',
          fromStepId: 'R11',
        }),
        expect.objectContaining({
          key: 'claim_evidence_map',
          fromStepId: 'R11',
        }),
        expect.objectContaining({ key: 'review', fromStepId: 'R12' }),
      ]),
    );
    expect(byId('R13').inputs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fromStepId: 'R13' })]),
    );
    expect(byId('R13').objective).toMatch(/检查 Main 提供的可信 Workflow Artifact history/);
    expect(byId('R13').objective).toMatch(/attempt 顺序最新、已验证/);
    expect(byId('R14').outputs.map((spec) => spec.key)).toEqual(['research.final_package']);
    const finalPackageContract = RESEARCH_CONTRACTS.find(
      (contract) => contract.contractId === 'research.final-package',
    )!;
    expect(finalPackageContract.validator).toMatchObject({
      type: 'JSON_SCHEMA',
      schema: {
        properties: {
          reproducibilitySummary: { type: 'string' },
          experimentAttempts: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: expect.objectContaining({
                stepRunId: { type: 'string', minLength: 1, maxLength: 128 },
                missionRunId: { type: 'string', minLength: 1, maxLength: 128 },
                attempt: { type: 'number', minimum: 1, maximum: 5, integer: true },
                outcome: {
                  type: 'enum',
                  values: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
                },
                recordArtifactId: { type: 'string', minLength: 0, maxLength: 128 },
                errorCode: { type: 'string', minLength: 0, maxLength: 128 },
                rawPaths: expect.objectContaining({ type: 'array', maxItems: 20 }),
                rawHashes: expect.objectContaining({ type: 'array', maxItems: 20 }),
              }),
            },
          },
        },
      },
    });
    const finalPackageSchema = (
      finalPackageContract.validator as {
        schema: { properties: Record<string, unknown> };
      }
    ).schema.properties;
    expect(finalPackageSchema).not.toHaveProperty('experimentAttemptArtifactIds');
    const validPackage = {
      finalManuscriptArtifactId: 'manuscript-final',
      evidenceTableArtifactId: 'evidence-table',
      claimEvidenceMapArtifactIds: ['claim-map'],
      experimentAttempts: [
        {
          stepRunId: 'step-run-completed',
          missionRunId: 'mission-run-completed',
          attempt: 1,
          outcome: 'COMPLETED',
          recordArtifactId: 'experiment-record-1',
          errorCode: '',
          rawPaths: ['research/raw-result.json'],
          rawHashes: ['a'.repeat(64)],
        },
        {
          stepRunId: 'step-run-failed',
          missionRunId: 'mission-run-failed',
          attempt: 1,
          outcome: 'FAILED',
          recordArtifactId: '',
          errorCode: 'TOOL_EXIT_NONZERO',
          rawPaths: [],
          rawHashes: [],
        },
      ],
      rawResultArtifactIds: ['raw-result-1'],
      experimentLogArtifactIds: ['experiment-log-1'],
      analysisArtifactIds: ['analysis-1'],
      figureArtifactIds: ['figures-1'],
      reviewHistoryArtifactIds: ['review-1'],
      sourceArtifactIds: ['source-1'],
      screeningArtifactId: 'screening-1',
      hypothesisArtifactIds: ['hypothesis-1'],
      experimentPlanArtifactIds: ['plan-1'],
      reproducibilitySummary: 'All attempts are listed, including failed attempts without records.',
      conclusionStatus: 'NOT_SCIENTIFICALLY_CONFIRMED',
      submissionStatus: 'NOT_SUBMITTED',
    };
    expect(
      validateArtifactContract(finalPackageContract, {
        kind: 'JSON',
        content: JSON.stringify(validPackage),
      }),
    ).toEqual([]);
    expect(
      validateArtifactContract(finalPackageContract, {
        kind: 'JSON',
        content: JSON.stringify({
          ...validPackage,
          experimentAttempts: Array(21).fill(validPackage.experimentAttempts[0]),
        }),
      }),
    ).toContain('JSON_SCHEMA_MISMATCH');
  });
});
