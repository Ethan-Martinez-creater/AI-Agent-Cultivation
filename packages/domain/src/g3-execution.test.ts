import { describe, expect, it } from 'vitest';
import {
  G3_EXECUTION_POLICY,
  parseG3ContinuationDecision,
  parseParticipantOutcome,
  transitionExecutionAttempt,
  validateExecutionTask,
} from './g3-execution.js';
import type { ExecutionTask } from './g3-execution.js';

const artifact = {
  id: 'artifact-1',
  kind: 'IMAGE',
  mimeType: 'image/png',
  contentHash: 'a'.repeat(64),
  sizeBytes: 120,
};

function workflowTask(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id: 'execution-task-1',
    logicalKey: 'workflow:run-1:step-1:attempt-1',
    source: 'WORKFLOW',
    missionId: 'mission-1',
    runId: 'run-1',
    collaborationRequestId: null,
    workflowRunId: 'workflow-run-1',
    workflowStepRunId: 'step-run-1',
    requesterTeammateId: null,
    coordinatorTeammateId: null,
    targetTeammateId: 'participant-1',
    requiredCapability: 'IMAGE_GENERATION',
    executionProtocol: 'GENERATION',
    publicTask: 'Generate a product image.',
    publicContext: '',
    artifactInputs: [],
    generationRequirements: {
      capability: 'IMAGE_GENERATION',
      requiredFeatures: ['TEXT_TO_IMAGE'],
      prompt: 'A product image',
      parameters: { seed: 42 },
      expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
      outputDestination: { scope: 'APP_ARTIFACT_STORE' },
      inputRequirements: [],
      reviewCapability: 'VISUAL_UNDERSTANDING',
    },
    acceptanceCriteria: ['One image artifact is registered.'],
    dependencyRole: null,
    reviewOf: [],
    parentTaskId: null,
    retryNo: 0,
    continuationRound: 0,
    policyVersion: G3_EXECUTION_POLICY.version,
    createdAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('G3 ExecutionTask domain contract', () => {
  it('keeps the dispatch protocol distinct from teammate executor identity and validates generation requirements', () => {
    expect(validateExecutionTask(workflowTask()).executionProtocol).toBe('GENERATION');
    expect(() =>
      validateExecutionTask(
        workflowTask({
          executionProtocol: 'LANGUAGE',
          generationRequirements: null,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateExecutionTask(
        workflowTask({
          generationRequirements: {
            capability: 'VIDEO_GENERATION',
            requiredFeatures: [],
            parameters: {},
            expectedOutput: { artifactKind: 'VIDEO', mimeTypes: ['video/mp4'] },
            outputDestination: { scope: 'APP_ARTIFACT_STORE' },
          },
        }),
      ),
    ).toThrow(/match requiredCapability/);
  });

  it('accepts only the documented, bounded ParticipantOutcome variants', () => {
    expect(
      parseParticipantOutcome({ kind: 'RESULT', publicResult: 'Ready', artifactRefs: [artifact] }),
    ).toEqual({
      kind: 'RESULT',
      publicResult: 'Ready',
      artifactRefs: [artifact],
    });
    expect(
      parseParticipantOutcome({
        kind: 'NEEDS_INPUT',
        requirements: [
          {
            role: 'FIRST_FRAME',
            artifactKinds: ['IMAGE'],
            mimeTypes: ['image/png'],
            required: true,
          },
        ],
        reason: 'A first frame is required.',
      }).kind,
    ).toBe('NEEDS_INPUT');
    expect(
      parseParticipantOutcome({
        kind: 'NEEDS_CAPABILITY',
        capability: 'IMAGE_GENERATION',
        requiredFeatures: ['TEXT_TO_IMAGE'],
        requestedInputs: [{ role: 'STYLE_REFERENCE', required: false }],
        reason: 'Need a style reference.',
      }).kind,
    ).toBe('NEEDS_CAPABILITY');
    expect(
      parseParticipantOutcome({
        kind: 'FAILED_RETRYABLE',
        errorCode: 'QUEUE_FULL',
        reason: 'Queue is full.',
      }).kind,
    ).toBe('FAILED_RETRYABLE');
    expect(
      parseParticipantOutcome({
        kind: 'FAILED_TERMINAL',
        errorCode: 'AUTH_FAILED',
        reason: 'Authorization failed.',
      }).kind,
    ).toBe('FAILED_TERMINAL');
  });

  it('rejects teammate selection, permission mutations, unknown fields, and unbounded data', () => {
    for (const extra of [
      { targetTeammateId: 'arbitrary-teammate' },
      { permission: 'INVITE_TEAMMATE' },
      { nested: { permissions: ['FILE_READ'] } },
    ]) {
      expect(() => parseParticipantOutcome({ kind: 'RESULT', artifactRefs: [], ...extra })).toThrow(
        /unsupported field/,
      );
    }
    expect(() =>
      parseParticipantOutcome({
        kind: 'NEEDS_INPUT',
        requirements: [{ role: 'FIRST_FRAME', required: true, arbitrary: true }],
        reason: 'Missing input.',
      }),
    ).toThrow(/unsupported field/);
    expect(() =>
      parseParticipantOutcome({
        kind: 'FAILED_RETRYABLE',
        errorCode: 'queue_full',
        reason: 'No stable code.',
      }),
    ).toThrow(/stable uppercase/);
    expect(() =>
      parseParticipantOutcome({
        kind: 'RESULT',
        publicResult: 'x'.repeat(4001),
        artifactRefs: [],
      }),
    ).toThrow(/4000/);
  });

  it('bounds continuation intent data and versioned retry/round policy', () => {
    const data = { requestedRole: 'FIRST_FRAME', retryIntent: { retryNo: 1 } };
    expect(parseG3ContinuationDecision({ action: 'REQUEST_INPUT', data })).toEqual({
      action: 'REQUEST_INPUT',
      data,
    });
    expect(() =>
      parseG3ContinuationDecision({ action: 'RETRY', data: { prompt: 'x'.repeat(9000) } }),
    ).toThrow(/8192/);
    expect(G3_EXECUTION_POLICY.maxParticipantAttempts).toBe(3);
    expect(G3_EXECUTION_POLICY.maxContinuationRounds).toBe(3);
    expect(G3_EXECUTION_POLICY.maxRetryAttemptsPerParticipantTask).toBe(1);
  });
});

describe('G3 ExecutionAttempt state machine', () => {
  it('supports bounded waiting and terminal outcomes while keeping UNKNOWN non-replayable', () => {
    expect(transitionExecutionAttempt('PREPARED', 'RUNNING')).toBe('RUNNING');
    expect(transitionExecutionAttempt('RUNNING', 'WAITING_INPUT')).toBe('WAITING_INPUT');
    expect(transitionExecutionAttempt('WAITING_INPUT', 'RUNNING')).toBe('RUNNING');
    expect(transitionExecutionAttempt('RUNNING', 'COMPLETED')).toBe('COMPLETED');
    for (const [from, to] of [
      ['UNKNOWN', 'RUNNING'],
      ['COMPLETED', 'FAILED'],
      ['FAILED', 'RUNNING'],
      ['WAITING_CAPABILITY', 'COMPLETED'],
    ] as const) {
      expect(() => transitionExecutionAttempt(from, to)).toThrow(
        /Invalid ExecutionAttempt transition/,
      );
    }
  });
});
