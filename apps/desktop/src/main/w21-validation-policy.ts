import type { WorkflowValidationPolicyPort } from '@cultivation/application';
import { WorkflowValidationPolicyRegistry } from '@cultivation/application';
import { DomainError } from '@cultivation/shared';
import {
  validateNewsInputs,
  validateNewsStep,
} from '../../../../packages/application/src/builtin/ai-news-video/v1.js';

/** Trusted bundled policy only; neither Renderer nor a model can supply validators. */
export const newsWorkflowValidationPolicy: WorkflowValidationPolicyPort = {
  validateInputs(version, inputs) {
    if (version.validationPolicy !== 'news-integrity-v1' || version.definition.source !== 'BUILTIN')
      throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '无效的官方工作流校验策略');
    validateNewsInputs(inputs);
  },
  validateStep(detail, step, produced) {
    try {
      validateNewsStep({
        version: detail.version,
        stepId: step.stepId,
        workflowInputs: detail.run.inputSnapshot ?? {},
        priorArtifacts: detail.bindings
          .filter((binding) => binding.stepRunId === step.id && binding.role === 'INPUT')
          .map((binding) => {
            const artifact = detail.artifacts.find((item) => item.id === binding.artifactId);
            if (!artifact) throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '来源产物不存在');
            const producer = detail.bindings.find(
              (item) => item.role === 'OUTPUT' && item.artifactId === artifact.id,
            );
            if (!producer) throw new DomainError('WORKFLOW_INTEGRITY_ERROR', '来源绑定不存在');
            return { ...artifact, key: producer.key, artifactId: artifact.id };
          }),
        producedArtifacts: produced.map(({ spec, artifact }) => ({
          ...artifact,
          key: spec.key,
          artifactId: artifact.id,
        })),
      });
      return [];
    } catch (error) {
      if (error instanceof DomainError) return [error.message];
      throw error;
    }
  },
};

export function officialWorkflowValidationPolicies(): WorkflowValidationPolicyRegistry {
  const registry = new WorkflowValidationPolicyRegistry();
  registry.register('news-integrity-v1', newsWorkflowValidationPolicy);
  return registry;
}
