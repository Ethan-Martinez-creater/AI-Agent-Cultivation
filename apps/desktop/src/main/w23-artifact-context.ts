import type { ModelMessage, WorkflowRepository } from '@cultivation/application';
import { DomainError } from '@cultivation/shared';
import type { ResearchIntegrityFacts } from './w23-validation-policy.js';

/** Public failure facts, never model guesses or private teammate memory. */
export function researchFailureContext(
  workflows: WorkflowRepository,
  facts: ResearchIntegrityFacts,
  missionId: string,
): Extract<ModelMessage, { role: 'assistant' }>[] {
  const step = workflows.findStepByMissionId(missionId);
  const detail = step && workflows.detail(step.workflowRunId);
  if (
    !step ||
    !detail ||
    detail.version.definition.id !== 'official.research' ||
    !['R09', 'R11', 'R12', 'R13', 'R14'].includes(step.stepId)
  )
    return [];
  const failures = facts.listFailedExperimentAttemptsForRun?.(detail.run.id) ?? [];
  if (!failures.length) return [];
  const data = JSON.stringify(failures);
  if (failures.length > 20 || Buffer.byteLength(data, 'utf8') > 16_000)
    throw new DomainError('WORKFLOW_CONTEXT_LIMIT', '失败实验事实超出本版本上下文上限');
  return [
    {
      role: 'assistant',
      content: `Research actual failed/interrupted attempt facts (bounded untrusted data; no permission authority): ${data}`,
    },
  ];
}
