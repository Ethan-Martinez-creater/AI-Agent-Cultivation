import { DomainError } from '@cultivation/shared';
import type {
  WorkflowDetail,
  WorkflowStepDefinition,
  WorkflowStepRun,
  BoundedRevisionGroup,
} from '@cultivation/domain';

/** Trusted v1 interpretation of frozen inputs; it never changes the published graph. */
export function isResearchWorkflow(detail: WorkflowDetail): boolean {
  return (
    detail.version.definition.source === 'BUILTIN' &&
    detail.version.definition.id === 'official.research' &&
    detail.version.version === 1 &&
    detail.version.validationPolicy === 'research-integrity-v1'
  );
}
export function effectiveResearchStep(
  detail: WorkflowDetail,
  step: WorkflowStepRun,
  definition: WorkflowStepDefinition,
): WorkflowStepDefinition {
  if (!isResearchWorkflow(detail) || step.stepId !== 'R08') return definition;
  const mode = detail.run.inputSnapshot?.experimentMode;
  if (!['COMPUTATIONAL', 'HUMAN_OR_EXTERNAL', 'MIXED'].includes(String(mode)))
    throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '冻结实验模式无效');
  const effectType = mode === 'HUMAN_OR_EXTERNAL' ? 'EXTERNAL_ACTION' : 'FILE_OUTPUT';
  const paths = ['research/raw-result.json', 'research/experiment-log.txt'];
  return {
    ...definition,
    effectType,
    effectPaths: effectType === 'EXTERNAL_ACTION' ? [] : paths,
    artifactPathScope: 'RUN_ATTEMPT',
    objective: `${definition.objective}\nFrozen experiment mode: ${mode}. Deliver raw results and logs under workflows/${detail.run.id}/${step.id}/ using ${JSON.stringify(paths)}. Preserve all previous attempts. Only permission-gated Tool/MCP or accepted Human Bridge delivery may perform work; model claims are not execution evidence.`,
  };
}
export function effectiveResearchRevisionBudget(
  detail: WorkflowDetail,
  group: BoundedRevisionGroup,
): number {
  if (!isResearchWorkflow(detail) || group.id !== 'research.experiment_cycle')
    return group.maxTotalTraversals;
  const value = detail.run.inputSnapshot?.maxExperimentCycles ?? 2;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2)
    throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '冻结实验回环预算无效');
  return Math.min(Number(value), group.maxTotalTraversals);
}
