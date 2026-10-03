import type { ModelMessage } from './index.js';
import type { WorkflowRepository } from './w1-workflow-ports.js';
import { workflowInputsForStep } from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';

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
  const news = detail.version.validationPolicy !== undefined;
  if (
    news &&
    Buffer.byteLength(
      JSON.stringify(
        artifacts.map((artifact) =>
          ['JSON', 'TEXT'].includes(artifact.kind) ? artifact.content : '',
        ),
      ),
      'utf8',
    ) > 64000
  )
    throw new DomainError('WORKFLOW_CONTEXT_LIMIT', '声明的新闻产物数据超出上下文上限');
  let remaining = 8_000;
  const data = artifacts.map((a) => {
    const content = ['TEXT', 'JSON'].includes(a.kind)
      ? news
        ? a.content
        : a.content.slice(0, Math.min(1500, remaining))
      : '';
    remaining -= content.length;
    return {
      id: a.id,
      ...(news
        ? {
            key: detail.bindings.find(
              (binding) => binding.role === 'OUTPUT' && binding.artifactId === a.id,
            )?.key,
            inputKey: detail.bindings.find(
              (binding) =>
                binding.stepRunId === step.id &&
                binding.role === 'INPUT' &&
                binding.artifactId === a.id,
            )?.key,
            metadata: a.metadata,
          }
        : {}),
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
