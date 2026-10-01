import { describe, expect, it } from 'vitest';
import { DomainError } from '@cultivation/shared';
import {
  canTransitionWorkflowRun,
  canTransitionWorkflowStep,
  transitionWorkflowRun,
  transitionWorkflowStep,
  validateWorkflowVersion,
} from './w1-workflow.js';
import type { WorkflowStepDefinition, WorkflowVersion } from './w1-workflow.js';

const at = '2026-10-01T00:00:00.000Z';

function step(id: string, overrides: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition {
  return {
    id,
    type: 'TASK',
    title: id,
    objective: `Do ${id}`,
    routing: {},
    inputs: [],
    outputs: [],
    maxAttempts: 2,
    exitCondition: 'VALID_OUTPUTS',
    effectType: 'NONE',
    ...overrides,
  };
}

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    definition: {
      id: 'definition-1',
      name: 'Workflow',
      description: '',
      category: 'test',
      source: 'USER',
    },
    version: 1,
    entryStepId: 'task',
    steps: [step('task'), step('next')],
    edges: [
      {
        id: 'edge-task-next',
        fromStepId: 'task',
        toStepId: 'next',
        branch: 'continue',
        condition: { type: 'ALWAYS' },
      },
    ],
    referenceBasis: [],
    createdAt: at,
    ...overrides,
  };
}

describe('W1 workflow domain', () => {
  it('allows only declared run and step transitions', () => {
    expect(canTransitionWorkflowRun('WAITING', 'RUNNING')).toBe(true);
    expect(canTransitionWorkflowRun('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransitionWorkflowStep('FAILED', 'READY')).toBe(true);
    expect(canTransitionWorkflowStep('COMPLETED', 'READY')).toBe(false);

    expect(
      transitionWorkflowRun(
        {
          id: 'run',
          definitionId: 'definition-1',
          definitionVersion: 1,
          state: 'WAITING',
          waitReason: 'MISSION',
          createdAt: at,
          updatedAt: at,
        },
        'RUNNING',
        at,
      ).waitReason,
    ).toBeNull();
    expect(() =>
      transitionWorkflowStep(
        {
          id: 'step-run',
          workflowRunId: 'run',
          stepId: 'task',
          attempt: 1,
          state: 'COMPLETED',
          missionId: null,
          missionRunId: null,
          waitReason: null,
          errorCode: null,
          createdAt: at,
          updatedAt: at,
        },
        'READY',
        at,
      ),
    ).toThrow(DomainError);
  });

  it('accepts a bounded forward-only version and rejects loops, unreachable steps, and undeclared revisions', () => {
    expect(() => validateWorkflowVersion(version())).not.toThrow();
    expect(() =>
      validateWorkflowVersion(
        version({
          edges: [
            {
              id: 'loop',
              fromStepId: 'next',
              toStepId: 'task',
              branch: 'back',
              condition: { type: 'ALWAYS' },
            },
          ],
        }),
      ),
    ).toThrow(DomainError);
    expect(() =>
      validateWorkflowVersion(version({ steps: [step('task'), step('next'), step('orphan')] })),
    ).toThrow(DomainError);
    expect(() =>
      validateWorkflowVersion(
        version({
          edges: [
            {
              id: 'edge-task-next',
              fromStepId: 'task',
              toStepId: 'next',
              branch: 'continue',
              condition: { type: 'ALWAYS' },
              revisionCode: 'revise',
            },
          ],
        }),
      ),
    ).toThrow(DomainError);
  });

  it('rejects ambiguous branches, malformed reviews, and executable decisions', () => {
    expect(() =>
      validateWorkflowVersion(
        version({
          edges: [
            {
              id: 'one',
              fromStepId: 'task',
              toStepId: 'next',
              branch: 'one',
              condition: { type: 'ALWAYS' },
            },
            {
              id: 'two',
              fromStepId: 'task',
              toStepId: null,
              branch: 'two',
              condition: { type: 'ALWAYS' },
            },
          ],
        }),
      ),
    ).toThrow(DomainError);

    expect(() =>
      validateWorkflowVersion(
        version({ steps: [step('task', { type: 'REVIEW' }), step('next')], edges: [] }),
      ),
    ).toThrow(DomainError);
    expect(() =>
      validateWorkflowVersion(
        version({
          steps: [
            step('task', {
              type: 'DECISION',
              outputs: [
                {
                  key: 'x',
                  kind: 'TEXT',
                  required: false,
                  contractId: 'x',
                  contractVersion: '1',
                  maxSizeBytes: 10,
                  description: '',
                  validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
                },
              ],
            }),
            step('next'),
          ],
          edges: [],
        }),
      ),
    ).toThrow(DomainError);
  });
});
