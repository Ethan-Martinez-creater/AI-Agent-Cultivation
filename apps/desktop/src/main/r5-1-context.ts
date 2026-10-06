import type { RoutingTaskContext } from '@cultivation/domain';
import type { WorkflowRepository } from '@cultivation/application';
import type { SkillRoutingContext } from '@cultivation/application/r5-1-skill-routing';

/** A projection of the current frozen Step, never a serialized Workflow detail/history. */
export function skillRoutingExecutionContext(
  routing: { getByMissionId(id: string): { context: RoutingTaskContext } | null },
  workflows: Pick<WorkflowRepository, 'findStepByMissionId' | 'detail'>,
  missionId: string,
): SkillRoutingContext | null {
  const saved = routing.getByMissionId(missionId)?.context;
  const step = workflows.findStepByMissionId(missionId);
  if (!saved && !step) return null;
  if (!step)
    return {
      objective: saved!.objective,
      requiredCapabilities: saved!.requiredCapabilities ?? [],
      inputArtifactSummaries: (saved!.inputArtifactMetadata ?? []).map(({ id, kind, name }) => ({
        id,
        kind,
        name,
      })),
    };
  const detail = workflows.detail(step.workflowRunId);
  const definition = detail?.version.steps.find((item) => item.id === step.stepId);
  if (!detail || !definition) return { objective: '' };
  const inputs = detail.bindings.filter(
    (binding) =>
      binding.workflowRunId === detail.run.id &&
      binding.stepRunId === step.id &&
      binding.role === 'INPUT',
  );
  return {
    objective: definition.objective,
    stepType: definition.type,
    requiredCapabilities:
      saved?.requiredCapabilities ?? definition.routing.requiredCapabilities ?? [],
    inputArtifactSummaries: inputs.flatMap((binding) => {
      const artifact = detail.artifacts.find(
        (item) => item.id === binding.artifactId && item.workflowRunId === detail.run.id,
      );
      return artifact ? [{ id: artifact.id, kind: artifact.kind, name: binding.key }] : [];
    }),
    expectedOutputContract: definition.outputs.map((output) => ({
      key: output.key,
      kind: output.kind,
      contractId: output.contractId,
      contractVersion: output.contractVersion,
    })),
  };
}
