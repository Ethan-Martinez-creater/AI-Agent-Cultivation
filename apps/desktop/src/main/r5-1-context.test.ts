import { describe, expect, it } from 'vitest';
import type { WorkflowRepository } from '@cultivation/application';
import type { RoutingTaskContext, WorkflowDetail } from '@cultivation/domain';
import { skillRoutingExecutionContext } from './r5-1-context.js';

describe('R5.1 current Step metadata projection', () => {
  it('uses the pinned Step and exact input bindings without history, bodies, prompts or paths', () => {
    const step = { id: 'step-run', stepId: 'review', workflowRunId: 'run', missionId: 'mission' };
    const detail = {
      run: { id: 'run', inputSnapshot: { privateInput: 'INPUT_SENTINEL' } },
      version: {
        steps: [
          {
            id: 'review',
            type: 'REVIEW',
            objective: 'Review analysis',
            routing: { requiredCapabilities: ['GENERAL_REASONING'] },
            outputs: [
              { key: 'verdict', kind: 'JSON', contractId: 'review-contract', contractVersion: '1' },
            ],
          },
        ],
      },
      bindings: [
        {
          role: 'INPUT',
          workflowRunId: 'run',
          stepRunId: 'step-run',
          artifactId: 'input',
          key: 'analysis',
        },
        {
          role: 'INPUT',
          workflowRunId: 'run',
          stepRunId: 'other-step',
          artifactId: 'private',
          key: 'private',
        },
      ],
      artifacts: [
        {
          id: 'input',
          workflowRunId: 'run',
          kind: 'JSON',
          content: 'BODY_SENTINEL',
          metadata: { path: 'C:\\secret' },
        },
        { id: 'private', workflowRunId: 'run', kind: 'TEXT', content: 'HISTORY_SENTINEL' },
      ],
      events: [{ payloadJson: { instructions: 'PRIVATE_PROMPT_SENTINEL' } }],
    } as unknown as WorkflowDetail;
    const context = skillRoutingExecutionContext(
      {
        getByMissionId: () => ({
          context: {
            objective: 'Expanded execution prompt must not leak',
            requiredCapabilities: ['GENERAL_REASONING'],
          },
        }),
      },
      { findStepByMissionId: () => step, detail: () => detail } as unknown as Pick<
        WorkflowRepository,
        'findStepByMissionId' | 'detail'
      >,
      'mission',
    );
    expect(context).toEqual({
      objective: 'Review analysis',
      stepType: 'REVIEW',
      requiredCapabilities: ['GENERAL_REASONING'],
      inputArtifactSummaries: [{ id: 'input', kind: 'JSON', name: 'analysis' }],
      expectedOutputContract: [
        { key: 'verdict', kind: 'JSON', contractId: 'review-contract', contractVersion: '1' },
      ],
    });
    expect(JSON.stringify(context)).not.toMatch(/SENTINEL|C:|Expanded execution/);
  });
  it('projects generic R4 context without leaking opaque execution IDs or routing authority', () => {
    const context: RoutingTaskContext = {
      objective: 'Summarize',
      requiredCapabilities: ['GENERAL_REASONING'],
      explicitTeammateId: 'other',
      executionConstraint: 'SOLO',
      executionContext: { origin: 'WORKFLOW', executionId: 'private-run' },
    };
    const value = skillRoutingExecutionContext(
      { getByMissionId: () => ({ context }) },
      { findStepByMissionId: () => null, detail: () => null },
      'mission',
    );
    expect(value).toEqual({
      objective: 'Summarize',
      requiredCapabilities: ['GENERAL_REASONING'],
      inputArtifactSummaries: [],
    });
    expect(JSON.stringify(value)).not.toMatch(/other|private-run|executionConstraint/);
  });
});
