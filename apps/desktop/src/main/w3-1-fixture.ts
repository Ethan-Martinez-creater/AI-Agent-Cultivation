import type { ModelRequest } from '@cultivation/application';
import type { WorkflowDetail, WorkflowStepRun } from '@cultivation/domain';
import { WorkflowFixtureGateway } from './w1-fixture.js';

/** Offline editor acceptance only. It installs no Workflow and grants no authority. */
export class WorkflowEditorFixtureGateway extends WorkflowFixtureGateway {
  constructor(
    private readonly active: () => { detail: WorkflowDetail; step: WorkflowStepRun } | null,
  ) {
    super();
  }
  override async generate(request: ModelRequest) {
    const original = await super.generate(request);
    const execution = this.active();
    if (!execution || !execution.detail.version.definition.id.startsWith('user.')) return original;
    const definition = execution.detail.version.steps.find(
      (step) => step.id === execution.step.stepId,
    )!;
    const inputs = execution.detail.bindings
      .filter((binding) => binding.stepRunId === execution.step.id && binding.role === 'INPUT')
      .map((binding) => binding.artifactId);
    const outputs = Object.fromEntries(
      definition.outputs.map((spec) => {
        if (spec.kind === 'TEXT')
          return [
            spec.key,
            `工作流已完成本步骤。${spec.description}\n${spec.validator.type === 'TEXT' ? spec.validator.requiredSections.join('\n') : ''}`,
          ];
        if (
          definition.type === 'REVIEW' &&
          spec.key === (definition.reviewOutputKey ?? definition.outputs[0]?.key)
        )
          return [
            spec.key,
            {
              verdict: 'PASS',
              findings: [],
              evidence: ['已核对本次输入产物'],
              summary: '内容符合约定，可以继续。',
              reviewedArtifactIds: inputs,
            },
          ];
        return [
          spec.key,
          Object.fromEntries(
            (spec.validator.type === 'JSON' ? spec.validator.requiredKeys : ['ok']).map((key) => [
              key,
              key === 'ok' ? true : '已完成',
            ]),
          ),
        ];
      }),
    );
    const value =
      definition.outputs.length === 1 ? outputs[definition.outputs[0]!.key] : { outputs };
    return { ...original, text: typeof value === 'string' ? value : JSON.stringify(value) };
  }
}
