import { describe, expect, it } from 'vitest';
import { completionExecutionContext } from './r5-5-context.js';
import type { WorkflowRepository } from '@cultivation/application';
import type { CompletionAdvisoryContext } from '@cultivation/application/r5-5-completion-advisory';

const context: CompletionAdvisoryContext = {
  missionId: 'm',
  runId: 'r',
  teammateId: 'a',
  phase: 'SOLO',
  missionMode: 'SOLO',
  objective: 'summary',
  resultText: 'public result',
};
describe('R5.5 frozen Workflow metadata projection', () => {
  it('uses only current frozen Step and valid Artifact metadata, never contents/history/inputs', () => {
    const step = { id: 's', stepId: 'task', workflowRunId: 'w' };
    const artifact = {
      id: 'artifact',
      workflowRunId: 'w',
      contentHash: 'a'.repeat(64),
      kind: 'JSON',
      content: 'PRIVATE_ARTIFACT_BODY',
      inputArtifactIds: ['prior'],
    };
    const repository = {
      findStepByMissionId: () => step,
      detail: () => ({
        run: { id: 'w', inputSnapshot: { secret: 'PRIVATE_INPUT' } },
        version: {
          steps: [
            {
              id: 'task',
              type: 'REVIEW',
              objective: 'PRIVATE_GRAPH_OBJECTIVE',
              routing: { requiredCapabilities: ['GENERAL_REASONING'] },
              effectType: 'EXTERNAL_ACTION',
              outputs: [{ kind: 'JSON', contractId: 'review', contractVersion: '1' }],
            },
          ],
        },
        bindings: [
          {
            workflowRunId: 'w',
            stepRunId: 's',
            artifactId: 'artifact',
            contractId: 'review',
            contractVersion: '1',
          },
        ],
        artifacts: [artifact],
        validations: [
          {
            artifactId: 'artifact',
            contentHash: artifact.contentHash,
            contractId: 'review',
            contractVersion: '1',
            valid: true,
          },
        ],
        events: [{ text: 'PRIVATE_HISTORY' }],
      }),
    } as unknown as Pick<WorkflowRepository, 'findStepByMissionId' | 'detail'>;
    const value = completionExecutionContext(repository, context);
    expect(value.objective).toBe(context.objective);
    expect(value.workflow?.stepType).toBe('REVIEW');
    expect(value.artifacts?.[0]?.sha256).toBe(artifact.contentHash);
    expect(value.deterministicFlags?.sideEffect).toBe('UNKNOWN');
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE/);
  });
  it('keeps free Mission context unchanged when no Workflow is bound', () => {
    expect(
      completionExecutionContext({ findStepByMissionId: () => null, detail: () => null }, context),
    ).toBe(context);
  });
});
