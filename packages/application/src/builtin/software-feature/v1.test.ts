import { describe, expect, it } from 'vitest';
import { validateBuiltinWorkflowRelease } from '../../w2-contracts.js';
import {
  SOFTWARE_FEATURE_CONTRACTS,
  SOFTWARE_FEATURE_DEFINITION_ID,
  SOFTWARE_FEATURE_PACKAGE,
  SOFTWARE_FEATURE_PHASES,
  SOFTWARE_FEATURE_REVISION_GROUPS,
  SOFTWARE_FEATURE_VALIDATION_POLICY,
  SOFTWARE_FEATURE_VERSION_1,
} from './v1.js';

describe('software feature official v1 package', () => {
  it('is a production OFFICIAL package with a canonical, frozen release manifest', () => {
    expect(SOFTWARE_FEATURE_PACKAGE.kind).toBe('OFFICIAL');
    expect(SOFTWARE_FEATURE_VERSION_1.definition.source).toBe('BUILTIN');
    expect(SOFTWARE_FEATURE_VERSION_1.definition.id).toBe(SOFTWARE_FEATURE_DEFINITION_ID);
    expect(SOFTWARE_FEATURE_VERSION_1.version).toBe(1);
    expect(SOFTWARE_FEATURE_VERSION_1.validationPolicy).toBe(SOFTWARE_FEATURE_VALIDATION_POLICY);
    expect(validateBuiltinWorkflowRelease(SOFTWARE_FEATURE_VERSION_1)).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(SOFTWARE_FEATURE_PACKAGE)).toBe(true);
    expect(Object.isFrozen(SOFTWARE_FEATURE_VERSION_1.steps)).toBe(true);
    expect(Object.isFrozen(SOFTWARE_FEATURE_VERSION_1.steps[4]?.outputs)).toBe(true);
    expect(Object.isFrozen(SOFTWARE_FEATURE_VERSION_1.contractManifest)).toBe(true);
  });

  it('declares exactly S01-S11 across the six product phases', () => {
    expect(SOFTWARE_FEATURE_VERSION_1.steps.map((step) => step.id)).toEqual([
      'S01',
      'S02',
      'S03',
      'S04',
      'S05',
      'S06',
      'S07',
      'S08',
      'S09',
      'S10',
      'S11',
    ]);
    expect(SOFTWARE_FEATURE_PHASES.map((phase) => phase.title)).toEqual([
      '理解',
      '规划',
      '开发',
      '验证',
      '审查',
      '交付',
    ]);
    expect(SOFTWARE_FEATURE_PHASES.flatMap((phase) => phase.steps).sort()).toEqual(
      SOFTWARE_FEATURE_VERSION_1.steps.map((step) => step.id).sort(),
    );
    expect(new Set(SOFTWARE_FEATURE_VERSION_1.steps.map((step) => step.id)).size).toBe(11);
  });

  it('freezes the AP-007 workflow inputs and required final outputs', () => {
    expect(Object.keys(SOFTWARE_FEATURE_VERSION_1.inputSchema!.properties)).toEqual([
      'objective',
      'workspaceRoot',
      'constraints',
      'targetArea',
      'userAcceptanceNotes',
      'allowedToolScope',
      'contextArtifacts',
    ]);
    expect(SOFTWARE_FEATURE_VERSION_1.outputSchema!.outputs.map((output) => output.key)).toEqual([
      'workspace_change_set',
      'feature_spec',
      'acceptance_criteria',
      'implementation_plan',
      'test_report',
      'code_review',
      'delivery_summary',
    ]);
    expect(
      SOFTWARE_FEATURE_VERSION_1.outputSchema!.outputs.every((output) => output.required),
    ).toBe(true);
  });

  it('registers versioned deterministic contracts for each required software artifact', () => {
    const ids = SOFTWARE_FEATURE_CONTRACTS.map((contract) => contract.contractId);
    expect(ids).toEqual([
      'software.repo_context',
      'software.spec',
      'software.acceptance',
      'software.plan',
      'software.plan_scope',
      'software.review',
      'software.changes',
      'software.tests',
      'software.fix',
      'software.delivery',
    ]);
    expect(SOFTWARE_FEATURE_CONTRACTS.every((contract) => contract.contractVersion === '1')).toBe(
      true,
    );
    const changes = SOFTWARE_FEATURE_CONTRACTS.find(
      (candidate) => candidate.contractId === 'software.changes',
    );
    expect(changes?.kind).toBe('WORKSPACE');
    expect(changes?.validator).toMatchObject({
      type: 'WORKSPACE_MANIFEST',
      dynamicPaths: true,
      allowedPaths: [],
      requireBeforeHash: false,
    });
  });

  it('bounds plan review and shares one total fix budget across verification and review', () => {
    const planGroup = SOFTWARE_FEATURE_VERSION_1.revisionGroups!.find(
      (group) => group.id === SOFTWARE_FEATURE_REVISION_GROUPS.plan,
    );
    const fixGroup = SOFTWARE_FEATURE_VERSION_1.revisionGroups!.find(
      (group) => group.id === SOFTWARE_FEATURE_REVISION_GROUPS.fix,
    );
    expect(planGroup?.maxTotalTraversals).toBe(2);
    expect(fixGroup?.maxTotalTraversals).toBe(3);
    expect(
      SOFTWARE_FEATURE_VERSION_1.edges
        .filter((edge) => edge.revision?.groupId === SOFTWARE_FEATURE_REVISION_GROUPS.fix)
        .map((edge) => [edge.fromStepId, edge.toStepId, edge.revision?.maxTraversals]),
    ).toEqual([
      ['S07', 'S10', 3],
      ['S09', 'S10', 3],
    ]);
    expect(
      SOFTWARE_FEATURE_VERSION_1.edges.find((edge) => edge.fromStepId === 'S10')?.toStepId,
    ).toBe('S06');
  });

  it('requires a different reviewer and declares dynamic workspace mutation scope', () => {
    const byId = (id: string) => SOFTWARE_FEATURE_VERSION_1.steps.find((step) => step.id === id)!;
    expect(byId('S04').executionRequirements).toEqual({
      independentReviewOfStepIds: ['S03'],
    });
    expect(byId('S08').executionRequirements).toEqual({
      independentReviewOfStepIds: ['S05', 'S10'],
    });
    expect(byId('S05')).toMatchObject({
      effectType: 'WORKSPACE_MUTATION',
      effectPathMode: 'DYNAMIC',
      executionRequirements: { requiredToolScope: true },
    });
    expect(byId('S10')).toMatchObject({
      effectType: 'WORKSPACE_MUTATION',
      effectPathMode: 'DYNAMIC',
      executionRequirements: { requiredToolScope: true },
    });
    expect((byId('S05') as unknown as { effectPaths?: string[] }).effectPaths).toBeUndefined();
    expect((byId('S10') as unknown as { effectPaths?: string[] }).effectPaths).toBeUndefined();
    for (const stepId of ['S01', 'S05', 'S06', 'S10'])
      expect(byId(stepId).executionRequirements?.requiredToolScope).toBe(true);
  });

  it('makes verification decisions non-model and excludes source-control or release actions', () => {
    const verificationDecision = SOFTWARE_FEATURE_VERSION_1.steps.find(
      (step) => step.id === 'S07',
    )!;
    expect(verificationDecision.type).toBe('DECISION');
    expect(verificationDecision.outputs).toEqual([]);
    expect(verificationDecision.routing.requiredCapabilities).toEqual([]);
    expect(
      SOFTWARE_FEATURE_VERSION_1.steps
        .filter((step) => ['S05', 'S10', 'S11'].includes(step.id))
        .map((step) => step.objective)
        .join(' '),
    ).toMatch(/push.*merge.*deploy.*release/i);
    expect(
      SOFTWARE_FEATURE_VERSION_1.edges.some(
        (edge) => edge.fromStepId === 'S07' && edge.branch === 'BLOCKED' && edge.toStepId === null,
      ),
    ).toBe(true);
    expect(
      SOFTWARE_FEATURE_VERSION_1.edges.some(
        (edge) => edge.fromStepId === 'S09' && edge.branch === 'FAIL' && edge.toStepId === null,
      ),
    ).toBe(true);
  });
});
