import type { WorkflowRepository } from '@cultivation/application';
import type { CompletionAdvisoryContext } from '@cultivation/application/r5-5-completion-advisory';

/** Only the currently bound frozen Step and verified metadata, never Artifact bodies/history. */
export function completionExecutionContext(
  repository: Pick<WorkflowRepository, 'findStepByMissionId' | 'detail'>,
  context: CompletionAdvisoryContext,
): CompletionAdvisoryContext {
  const step = repository.findStepByMissionId(context.missionId);
  if (!step) return context;
  const detail = repository.detail(step.workflowRunId);
  const definition = detail?.version.steps.find((item) => item.id === step.stepId);
  if (!detail || !definition) return context;
  const output = definition.outputs[0];
  const artifacts = detail.bindings
    .filter((binding) => binding.workflowRunId === detail.run.id && binding.stepRunId === step.id)
    .flatMap((binding) => {
      const artifact = detail.artifacts.find(
        (item) => item.id === binding.artifactId && item.workflowRunId === detail.run.id,
      );
      const validation =
        artifact &&
        detail.validations.find(
          (item) =>
            item.artifactId === artifact.id &&
            item.contentHash === artifact.contentHash &&
            item.contractId === binding.contractId &&
            item.contractVersion === binding.contractVersion &&
            item.valid,
        );
      return artifact && validation
        ? [
            {
              id: artifact.id,
              sha256: artifact.contentHash,
              kind: artifact.kind,
              validationStatus: 'PASS' as const,
              contractId: binding.contractId,
              contractVersion: binding.contractVersion,
              lineageCount: artifact.inputArtifactIds.length,
            },
          ]
        : [];
    });
  return {
    ...context,
    artifacts,
    workflow: {
      stepType: definition.type,
      requiredCapabilities: definition.routing.requiredCapabilities ?? [],
      expectedOutputContract: output
        ? {
            kind: output.kind,
            contractId: output.contractId,
            contractVersion: output.contractVersion,
          }
        : null,
      validationStatus: 'UNKNOWN',
      reviewPolicy: definition.type === 'REVIEW' ? 'FROZEN_STRUCTURED_REVIEW' : 'NOT_APPLICABLE',
    },
    deterministicFlags: {
      sideEffect: definition.effectType === 'NONE' ? 'NONE' : 'UNKNOWN',
      artifactValidation: 'UNKNOWN',
      reviewVerdict: definition.type === 'REVIEW' ? 'UNKNOWN' : 'NOT_APPLICABLE',
    },
  };
}
