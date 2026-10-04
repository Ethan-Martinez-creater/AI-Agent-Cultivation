import { describe, expect, it } from 'vitest';
import type { WorkflowDetail, WorkflowStepDefinition, WorkflowStepRun } from '@cultivation/domain';
import {
  effectiveResearchStep,
  effectiveResearchRevisionBudget,
} from './research-execution-policy.js';
import { WorkflowService } from './w1-workflow-service.js';
const fixture = (mode: string = 'COMPUTATIONAL') =>
  ({
    version: {
      definition: { id: 'official.research', source: 'BUILTIN' },
      version: 1,
      validationPolicy: 'research-integrity-v1',
    },
    run: { id: 'run-a', inputSnapshot: { experimentMode: mode, maxExperimentCycles: 1 } },
  }) as unknown as WorkflowDetail;
const step = { id: 'step-attempt-a', stepId: 'R08', attempt: 1 } as WorkflowStepRun;
const definition = {
  id: 'R08',
  objective: '实验',
  effectType: 'FILE_OUTPUT',
  effectPaths: ['research/raw-result.json', 'research/experiment-log.txt'],
} as WorkflowStepDefinition;
describe('frozen research execution policy', () => {
  it('requires a fresh Step attempt instead of reusing experiment output paths on Mission retry', async () => {
    const detail = fixture();
    detail.steps = [{ ...step, state: 'FAILED', missionId: 'failed-mission' } as WorkflowStepRun];
    let retryCalls = 0;
    const service = new WorkflowService(
      { detail: () => detail } as never,
      {
        retry: () => {
          retryCalls++;
        },
      } as never,
    );
    await expect(service.retryMission('run-a')).rejects.toMatchObject({
      code: 'WORKFLOW_STEP_RETRY_REQUIRED',
    });
    expect(retryCalls).toBe(0);
    expect(detail.steps[0]!.id).toBe('step-attempt-a');
  });
  it.each(['COMPUTATIONAL', 'MIXED'])(
    'keeps %s computational effect real and attempt scoped',
    (mode) => {
      const result = effectiveResearchStep(fixture(mode), step, definition);
      expect(result.effectType).toBe('FILE_OUTPUT');
      expect(result.artifactPathScope).toBe('RUN_ATTEMPT');
      expect(result.objective).toContain('workflows/run-a/step-attempt-a/');
      expect(definition.objective).toBe('实验');
    },
  );
  it('external execution cannot masquerade as a no-effect task', () => {
    expect(effectiveResearchStep(fixture('HUMAN_OR_EXTERNAL'), step, definition)).toMatchObject({
      effectType: 'EXTERNAL_ACTION',
      effectPaths: [],
    });
  });
  it('rejects unknown experiment mode and frozen budget overflow', () => {
    expect(() => effectiveResearchStep(fixture('NONE'), step, definition)).toThrow();
    const detail = fixture();
    detail.run.inputSnapshot!.maxExperimentCycles = 3;
    expect(() =>
      effectiveResearchRevisionBudget(detail, {
        id: 'research.experiment_cycle',
        maxTotalTraversals: 2,
        onExhausted: 'WAITING_USER',
      }),
    ).toThrow();
  });
  it('both refine edges use the same tighter run budget without changing the released ceiling', () => {
    const group = {
      id: 'research.experiment_cycle',
      maxTotalTraversals: 2,
      onExhausted: 'WAITING_USER' as const,
    };
    expect(effectiveResearchRevisionBudget(fixture(), group)).toBe(1);
    expect(group.maxTotalTraversals).toBe(2);
    const detail = fixture();
    delete detail.run.inputSnapshot!.maxExperimentCycles;
    expect(effectiveResearchRevisionBudget(detail, group)).toBe(2);
  });
  it('does not reinterpret existing software/news versions', () => {
    const detail = fixture();
    detail.version.definition.id = 'official.software-feature';
    expect(effectiveResearchStep(detail, step, definition)).toBe(definition);
  });
});
