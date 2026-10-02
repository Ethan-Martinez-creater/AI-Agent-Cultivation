import type { WorkflowArtifact, WorkflowArtifactBinding } from '@cultivation/domain';

const resultNames: Record<WorkflowArtifact['kind'], string> = {
  TEXT: '文本结果',
  JSON: '结构化结果',
  FILE: '文件结果',
  DIRECTORY: '目录结果',
  EXTERNAL_REFERENCE: '外部交付结果',
};

export function WorkflowArtifactResult({
  artifact,
  label,
  binding,
}: {
  artifact: WorkflowArtifact;
  label: string;
  binding?: WorkflowArtifactBinding;
}) {
  return (
    <details className="workflow-data-row">
      <summary>{resultNames[artifact.kind]}</summary>
      <pre>{artifact.content}</pre>
      <details className="workflow-technical-details">
        <summary>高级 · 来源记录</summary>
        <dl>
          <div>
            <dt>逻辑键</dt>
            <dd>{binding?.key ?? label}</dd>
          </div>
          <div>
            <dt>类型</dt>
            <dd>{artifact.kind}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{artifact.source}</dd>
          </div>
          <div>
            <dt>产出步骤尝试</dt>
            <dd>
              <code>{artifact.producerStepRunId}</code>
            </dd>
          </div>
          <div>
            <dt>历练 / 运行</dt>
            <dd>
              <code>
                {artifact.missionId} / {artifact.missionRunId}
              </code>
            </dd>
          </div>
          <div>
            <dt>执行者编号</dt>
            <dd>
              <code>{artifact.actorId}</code>
            </dd>
          </div>
          <div>
            <dt>来源记录编号</dt>
            <dd>
              <code>{artifact.sourceId}</code>
            </dd>
          </div>
          <div>
            <dt>内容 Hash</dt>
            <dd>
              <code>{artifact.contentHash}</code>
            </dd>
          </div>
          {binding && (
            <div>
              <dt>Contract</dt>
              <dd>
                {binding.contractId} · {binding.contractVersion}
              </dd>
            </div>
          )}
        </dl>
      </details>
    </details>
  );
}
