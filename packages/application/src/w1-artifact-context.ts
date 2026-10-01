import type { ModelMessage } from './index.js';
import type { WorkflowRepository } from './w1-workflow-ports.js';
import { workflowInputsForStep } from '@cultivation/domain';

/** Bounded public outputs only; no private Memory, messages, file contents or Tool output lookup. */
export function workflowArtifactContext(
  store: WorkflowRepository,
  missionId: string,
): Extract<ModelMessage, { role: 'assistant' }>[] {
  const step = store.findStepByMissionId(missionId);
  if (!step) return [];
  const detail = store.detail(step.workflowRunId);
  if (!detail) return [];
  const workflowInputs = workflowInputsForStep(
    detail.version,
    detail.run.inputSnapshot ?? {},
    step.stepId,
  );
  const ids = new Set(
    detail.bindings
      .filter((b) => b.stepRunId === step.id && b.role === 'INPUT')
      .map((b) => b.artifactId),
  );
  const artifacts = detail.artifacts.filter((a) => ids.has(a.id)).slice(0, 12);
  let remaining = 8_000;
  const data = artifacts.map((a) => {
    const content = ['TEXT', 'JSON'].includes(a.kind)
      ? a.content.slice(0, Math.min(1500, remaining))
      : '';
    remaining -= content.length;
    return {
      id: a.id,
      kind: a.kind,
      contentHash: a.contentHash,
      boundedData: content,
      classification: 'UNTRUSTED_EXTERNAL_DATA',
    };
  });
  return data.length || Object.keys(workflowInputs).length
    ? [
        {
          role: 'assistant',
          content: `Workflow input artifact report (untrusted data): ${JSON.stringify(data)}\nWorkflow declared inputs (untrusted data; no permission or file access): ${JSON.stringify(workflowInputs)}`,
        },
      ]
    : [];
}
