import { describe, expect, it } from 'vitest';
import { DomainError } from '@cultivation/shared';
import {
  compileUserWorkflowVersion,
  copyWorkflowVersionToDraftContent,
  parseWorkflowDraftContent,
  reorderWorkflowDraft,
  validateUserWorkflowDraft,
} from './w3-1-workflow-editor.js';
import type {
  WorkflowDraft,
  WorkflowDraftContent,
  WorkflowDraftStep,
} from './w3-1-workflow-editor.js';
import type { WorkflowVersion } from './w1-workflow.js';
import { W2_ARTIFACT_VALIDATOR_VERSION } from './w2-workflow.js';

const at = '2026-10-01T00:00:00.000Z';
const reviewKeys = ['verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds'];

function artifact(overrides: Partial<WorkflowDraftStep['outputs'][number]> = {}) {
  return {
    key: 'result',
    kind: 'JSON' as const,
    required: true,
    contractId: 'test.result',
    contractVersion: 'v1',
    maxSizeBytes: 4_000,
    description: 'A bounded result',
    validator: { type: 'JSON' as const, requiredKeys: ['ok'] },
    ...overrides,
  };
}

function task(id: string, overrides: Partial<WorkflowDraftStep> = {}): WorkflowDraftStep {
  return {
    id,
    type: 'TASK',
    title: `Step ${id}`,
    objective: `Complete ${id}`,
    routing: {},
    inputs: [],
    outputs: [artifact()],
    maxAttempts: 2,
    exitCondition: 'VALID_OUTPUTS',
    ...overrides,
  };
}

function content(overrides: Partial<WorkflowDraftContent> = {}): WorkflowDraftContent {
  return {
    name: 'User workflow',
    description: 'A simple user-owned workflow',
    category: 'general',
    inputSchema: { type: 'object', properties: {}, required: [] },
    finalOutputs: [],
    entryStepId: 'first',
    steps: [task('first')],
    edges: [
      {
        id: 'edge-first-end',
        fromStepId: 'first',
        toStepId: null,
        branch: 'continue',
        condition: { type: 'ALWAYS' },
      },
    ],
    ...overrides,
  };
}

function draft(value: WorkflowDraftContent = content()): WorkflowDraft {
  return {
    id: 'draft-1',
    definitionId: 'definition-1',
    baseVersion: null,
    revision: 1,
    content: value,
    createdAt: at,
    updatedAt: at,
  };
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrow(DomainError);
}

describe('W3.1 user Workflow draft domain', () => {
  it('allows a structurally valid but graph-incomplete draft to be saved', () => {
    const incomplete = content({ entryStepId: 'missing' });
    expect(parseWorkflowDraftContent(incomplete)).toMatchObject({ entryStepId: 'missing' });
    expectInvalid(() => validateUserWorkflowDraft(incomplete));
  });

  it('rejects authority fields and unsupported capabilities at the parser boundary', () => {
    const withEffect = content({
      steps: [{ ...task('first'), effectType: 'WORKSPACE_MUTATION' } as WorkflowDraftStep],
    });
    expectInvalid(() => parseWorkflowDraftContent(withEffect));

    const withCapability = content({
      steps: [task('first', { routing: { requiredCapabilities: ['ADMIN'] as never } })],
    });
    expectInvalid(() => parseWorkflowDraftContent(withCapability));
  });

  it('bounds JSON decision conditions and accepts multibyte values within the limits', () => {
    const multibyte = content({
      edges: [
        {
          id: 'bounded-condition',
          fromStepId: 'first',
          toStepId: null,
          branch: 'match',
          condition: {
            type: 'JSON_FIELD_EQUALS',
            inputKey: 'choice',
            field: 'route',
            equals: '中'.repeat(256),
          },
        },
      ],
    });
    expect(parseWorkflowDraftContent(multibyte).edges[0]?.condition.type).toBe('JSON_FIELD_EQUALS');

    for (const equals of ['x'.repeat(257), '中'.repeat(257)]) {
      const decision = content({
        edges: [
          {
            id: 'bounded-condition',
            fromStepId: 'first',
            toStepId: null,
            branch: 'match',
            condition: {
              type: 'JSON_FIELD_EQUALS',
              inputKey: 'choice',
              field: 'route',
              equals,
            },
          },
        ],
      });
      expectInvalid(() => parseWorkflowDraftContent(decision));
    }
  });

  it('compiles only USER versions with NONE effects and the declared safe routing subset', () => {
    const userContent = content({
      steps: [
        task('first', {
          routing: {
            requiredCapabilities: ['GENERAL_REASONING'],
            executionConstraint: 'SOLO',
          },
        }),
      ],
    });
    const version = compileUserWorkflowVersion(draft(userContent), 1, at);
    expect(version.definition.source).toBe('USER');
    expect(version.validationPolicy).toBeUndefined();
    expect(version.steps[0]).toMatchObject({
      effectType: 'NONE',
      routing: { requiredCapabilities: ['GENERAL_REASONING'], executionConstraint: 'SOLO' },
    });
    expect(version.steps[0]).not.toHaveProperty('executionRequirements');
  });

  it('rejects dangling, self-referential, cyclic, and ambiguous branch graphs', () => {
    const dangling = content({
      edges: [
        {
          id: 'bad-edge',
          fromStepId: 'first',
          toStepId: 'missing',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
      ],
    });
    expectInvalid(() => validateUserWorkflowDraft(dangling));

    const selfLoop = content({
      edges: [
        {
          id: 'self',
          fromStepId: 'first',
          toStepId: 'first',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
      ],
    });
    expectInvalid(() => validateUserWorkflowDraft(selfLoop));

    const cycle = content({
      steps: [task('first'), task('second')],
      edges: [
        {
          id: 'first-second',
          fromStepId: 'first',
          toStepId: 'second',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'second-first',
          fromStepId: 'second',
          toStepId: 'first',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
      ],
    });
    expectInvalid(() => validateUserWorkflowDraft(cycle));
  });

  it('requires a producer to dominate every route to an Artifact consumer', () => {
    const entry = task('entry', {
      outputs: [artifact({ key: 'choice', validator: { type: 'JSON', requiredKeys: ['route'] } })],
    });
    const decision: WorkflowDraftStep = {
      id: 'decision',
      type: 'DECISION',
      title: 'Choose route',
      objective: 'Choose a declared route',
      routing: {},
      inputs: [{ key: 'choice', fromStepId: 'entry', outputKey: 'choice', required: true }],
      outputs: [],
      maxAttempts: 1,
      exitCondition: 'VALID_OUTPUTS',
    };
    const left = task('left', { outputs: [artifact({ key: 'left-result' })] });
    const right = task('right', { outputs: [artifact({ key: 'right-result' })] });
    const join = task('join', {
      inputs: [{ key: 'leftInput', fromStepId: 'left', outputKey: 'left-result', required: true }],
    });
    const branch = (id: string, toStepId: string, equals: string) => ({
      id,
      fromStepId: 'decision',
      toStepId,
      branch: equals,
      condition: {
        type: 'JSON_FIELD_EQUALS' as const,
        inputKey: 'choice',
        field: 'route',
        equals,
      },
    });
    const graph = content({
      entryStepId: 'entry',
      steps: [entry, decision, left, right, join],
      edges: [
        {
          id: 'entry-decision',
          fromStepId: 'entry',
          toStepId: 'decision',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        branch('decision-left', 'left', 'left'),
        branch('decision-right', 'right', 'right'),
        {
          id: 'left-join',
          fromStepId: 'left',
          toStepId: 'join',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'right-join',
          fromStepId: 'right',
          toStepId: 'join',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'join-end',
          fromStepId: 'join',
          toStepId: null,
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
      ],
    });
    expectInvalid(() => validateUserWorkflowDraft(graph));
  });

  it('rejects a required input binding to an optional producer output', () => {
    const producer = task('first', { outputs: [artifact({ required: false })] });
    const consumer = task('second', {
      inputs: [{ key: 'source', fromStepId: 'first', outputKey: 'result', required: true }],
    });
    expectInvalid(() =>
      validateUserWorkflowDraft(
        content({
          steps: [producer, consumer],
          edges: [
            {
              id: 'first-second',
              fromStepId: 'first',
              toStepId: 'second',
              branch: 'continue',
              condition: { type: 'ALWAYS' },
            },
            {
              id: 'second-end',
              fromStepId: 'second',
              toStepId: null,
              branch: 'continue',
              condition: { type: 'ALWAYS' },
            },
          ],
        }),
      ),
    );
  });

  it('requires structured REVIEW output and at least one real upstream Artifact input', () => {
    const review = task('review', {
      type: 'REVIEW',
      inputs: [{ key: 'source', fromStepId: 'first', outputKey: 'result', required: true }],
      outputs: [
        artifact({ key: 'verdict', validator: { type: 'JSON', requiredKeys: reviewKeys } }),
      ],
      reviewOutputKey: 'verdict',
      exitCondition: 'REVIEW_PASS',
    });
    const valid = content({
      steps: [task('first'), review],
      edges: [
        {
          id: 'first-review',
          fromStepId: 'first',
          toStepId: 'review',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'review-pass',
          fromStepId: 'review',
          toStepId: null,
          branch: 'PASS',
          condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
        },
      ],
    });
    expect(() => validateUserWorkflowDraft(valid)).not.toThrow();
    expectInvalid(() =>
      validateUserWorkflowDraft({
        ...valid,
        steps: [{ ...review, inputs: [] }, task('first')],
      }),
    );

    const reviseForward = content({
      steps: [task('first'), review, task('fix')],
      edges: [
        {
          id: 'first-review',
          fromStepId: 'first',
          toStepId: 'review',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'review-pass',
          fromStepId: 'review',
          toStepId: null,
          branch: 'PASS',
          condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
        },
        {
          id: 'review-revise',
          fromStepId: 'review',
          toStepId: 'fix',
          branch: 'REVISE',
          condition: { type: 'REVIEW_VERDICT', verdict: 'REVISE' },
        },
        {
          id: 'review-fail',
          fromStepId: 'review',
          toStepId: null,
          branch: 'FAIL',
          condition: { type: 'REVIEW_VERDICT', verdict: 'FAIL' },
        },
        {
          id: 'fix-end',
          fromStepId: 'fix',
          toStepId: null,
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
      ],
    });
    expectInvalid(() => validateUserWorkflowDraft(reviseForward));

    expect(() =>
      validateUserWorkflowDraft({
        ...reviseForward,
        steps: [task('first'), { ...review, exitCondition: 'VALID_OUTPUTS' }, task('fix')],
      }),
    ).not.toThrow();
  });

  it('requires exact producer projection for final outputs', () => {
    const producer = task('first', { outputs: [artifact({ required: false })] });
    const invalidProjection = content({
      steps: [producer],
      finalOutputs: [
        {
          key: 'final',
          fromStepId: 'first',
          outputKey: 'result',
          required: true,
          description: 'Required projection',
        },
      ],
    });
    expectInvalid(() => validateUserWorkflowDraft(invalidProjection));

    const validProjection = content({
      steps: [task('first')],
      finalOutputs: [
        {
          key: 'final',
          fromStepId: 'first',
          outputKey: 'result',
          required: true,
          description: 'Final output',
        },
      ],
    });
    const version = compileUserWorkflowVersion(draft(validProjection), 1, at);
    expect(version.outputSchema?.outputs[0]).toMatchObject({
      key: 'final',
      fromStepId: 'first',
      outputKey: 'result',
      contractId: 'test.result',
    });
  });

  it('requires every normal completion route to produce each required final output', () => {
    const entry = task('entry', {
      outputs: [artifact({ key: 'choice', validator: { type: 'JSON', requiredKeys: ['route'] } })],
    });
    const decision: WorkflowDraftStep = {
      id: 'decision',
      type: 'DECISION',
      title: 'Choose route',
      objective: 'Choose a declared route',
      routing: {},
      inputs: [{ key: 'choice', fromStepId: 'entry', outputKey: 'choice', required: true }],
      outputs: [],
      maxAttempts: 1,
      exitCondition: 'VALID_OUTPUTS',
    };
    const complete = task('complete', { outputs: [artifact({ key: 'final' })] });
    const skip = task('skip');
    const branch = (id: string, toStepId: string, equals: string) => ({
      id,
      fromStepId: 'decision',
      toStepId,
      branch: equals,
      condition: {
        type: 'JSON_FIELD_EQUALS' as const,
        inputKey: 'choice',
        field: 'route',
        equals,
      },
    });
    const graph = content({
      entryStepId: 'entry',
      steps: [entry, decision, complete, skip],
      edges: [
        {
          id: 'entry-decision',
          fromStepId: 'entry',
          toStepId: 'decision',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        branch('decision-complete', 'complete', 'complete'),
        branch('decision-skip', 'skip', 'skip'),
        {
          id: 'complete-end',
          fromStepId: 'complete',
          toStepId: null,
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'skip-end',
          fromStepId: 'skip',
          toStepId: null,
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
      ],
      finalOutputs: [
        {
          key: 'final-result',
          fromStepId: 'complete',
          outputKey: 'final',
          required: true,
          description: 'Required final output',
        },
      ],
    });
    expectInvalid(() => validateUserWorkflowDraft(graph));
  });

  it('reorders only a sequential graph and refuses conditional graph rewrites', () => {
    const linear = content({
      steps: [task('first'), task('second')],
      edges: [
        {
          id: 'first-second',
          fromStepId: 'first',
          toStepId: 'second',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'second-end',
          fromStepId: 'second',
          toStepId: null,
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
      ],
    });
    const reordered = reorderWorkflowDraft(linear, ['second', 'first']);
    expect(reordered.entryStepId).toBe('second');
    expect(reordered.steps.map((step) => step.id)).toEqual(['second', 'first']);
    expect(reordered.edges.map((edge) => [edge.fromStepId, edge.toStepId])).toEqual([
      ['second', 'first'],
      ['first', null],
    ]);

    const dependent = content({
      steps: [
        task('first'),
        task('second', {
          inputs: [{ key: 'source', fromStepId: 'first', outputKey: 'result', required: true }],
        }),
      ],
      edges: linear.edges,
    });
    expectInvalid(() => reorderWorkflowDraft(dependent, ['second', 'first']));

    const conditional = content({
      edges: [
        {
          id: 'branch',
          fromStepId: 'first',
          toStepId: null,
          branch: 'pass',
          condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
        },
      ],
    });
    expectInvalid(() => reorderWorkflowDraft(conditional, ['first']));
  });

  it('round-trips an editor-owned USER version without changing its graph or contracts', () => {
    const userContent = content({
      steps: [task('first', { routing: { executionConstraint: 'PARTY' } })],
    });
    const version = compileUserWorkflowVersion(draft(userContent), 3, at);
    expect(copyWorkflowVersionToDraftContent(version)).toEqual(userContent);
  });

  it('copies a BUILTIN into a safe sequential USER draft and strips official authority', () => {
    const contract = {
      contractId: 'official.result',
      contractVersion: 'v1',
      kind: 'JSON' as const,
      validatorVersion: W2_ARTIFACT_VALIDATOR_VERSION,
      maxSizeBytes: 4_000,
      validator: {
        type: 'JSON_SCHEMA' as const,
        schema: {
          type: 'object' as const,
          properties: { summary: { type: 'string' as const, minLength: 0, maxLength: 200 } },
          required: ['summary'],
        },
      },
    };
    const source: WorkflowVersion = {
      definition: {
        id: 'builtin-1',
        name: 'Official workflow',
        description: 'Frozen official content',
        category: 'official',
        source: 'BUILTIN',
      },
      version: 1,
      entryStepId: 'first',
      steps: [
        {
          id: 'first',
          type: 'TASK',
          title: 'Produce source',
          objective: 'Produce source data',
          routing: {
            explicitTeammateId: 'trusted-id',
            requiredCapabilities: ['GENERAL_REASONING'],
          },
          inputs: [],
          outputs: [
            {
              key: 'result',
              kind: 'JSON',
              required: true,
              contractId: contract.contractId,
              contractVersion: contract.contractVersion,
              maxSizeBytes: contract.maxSizeBytes,
              description: 'Source result',
              validator: {
                type: 'REGISTRY',
                contractId: contract.contractId,
                contractVersion: contract.contractVersion,
              },
            },
          ],
          maxAttempts: 2,
          exitCondition: 'VALID_OUTPUTS',
          effectType: 'WORKSPACE_MUTATION',
          effectPaths: ['output/result.json'],
          artifactPathScope: 'RUN_ATTEMPT',
        },
        {
          id: 'review',
          type: 'REVIEW',
          title: 'Review source',
          objective: 'Review the source output',
          routing: {},
          inputs: [{ key: 'source', fromStepId: 'first', outputKey: 'result', required: true }],
          outputs: [
            artifact({ key: 'verdict', validator: { type: 'JSON', requiredKeys: reviewKeys } }),
          ],
          reviewOutputKey: 'verdict',
          maxAttempts: 1,
          exitCondition: 'REVIEW_PASS',
          effectType: 'NONE',
        },
      ],
      edges: [
        {
          id: 'official-first-review',
          fromStepId: 'first',
          toStepId: 'review',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        ...(['PASS', 'FAIL'] as const).map((verdict) => ({
          id: `official-review-${verdict.toLowerCase()}`,
          fromStepId: 'review',
          toStepId: null,
          branch: verdict,
          condition: { type: 'REVIEW_VERDICT' as const, verdict },
        })),
        {
          id: 'bounded-revision',
          fromStepId: 'review',
          toStepId: 'first',
          branch: 'revision',
          condition: { type: 'REVIEW_VERDICT', verdict: 'REVISE' },
          revision: { groupId: 'official-revision', maxTraversals: 1 },
        },
      ],
      contractManifest: [contract],
      revisionGroups: [{ id: 'official-revision', maxTotalTraversals: 1, onExhausted: 'FAILED' }],
      validationPolicy: 'official.policy',
      referenceBasis: [],
      createdAt: at,
    };

    const original = JSON.stringify(source);
    const copied = copyWorkflowVersionToDraftContent(source);
    expect(JSON.stringify(source)).toBe(original);
    expect(copied.steps[0]?.outputs[0]).toMatchObject({
      contractId: 'user-copy.1',
      contractVersion: '1',
      validator: { type: 'JSON', requiredKeys: ['summary'] },
    });
    expect(
      copied.edges.some((edge) => edge.fromStepId === 'review' && edge.branch === 'PASS'),
    ).toBe(true);
    expect(
      copied.edges.some((edge) => edge.fromStepId === 'review' && edge.branch === 'REVISE'),
    ).toBe(false);
    expect(copied.edges.some((edge) => edge.branch === 'revision')).toBe(false);
    expect(() => validateUserWorkflowDraft(copied)).not.toThrow();
    const copiedVersion = compileUserWorkflowVersion(
      { ...draft(copied), definitionId: 'user-copy-1' },
      1,
      at,
    );
    expect(copiedVersion.validationPolicy).toBeUndefined();
    expect(copiedVersion.steps[0]?.effectType).toBe('NONE');
  });

  it('copies a non-generic official REVIEW as a safe TASK', () => {
    const source: WorkflowVersion = {
      definition: {
        id: 'builtin-review',
        name: 'Official review workflow',
        description: 'Official review contract',
        category: 'official',
        source: 'BUILTIN',
      },
      version: 1,
      entryStepId: 'first',
      steps: [
        {
          id: 'first',
          type: 'TASK',
          title: 'Produce source',
          objective: 'Produce source data',
          routing: {},
          inputs: [],
          outputs: [artifact()],
          maxAttempts: 1,
          exitCondition: 'VALID_OUTPUTS',
          effectType: 'NONE',
        },
        {
          id: 'review',
          type: 'REVIEW',
          title: 'Official review',
          objective: 'Use an official-only review contract',
          routing: {},
          inputs: [{ key: 'source', fromStepId: 'first', outputKey: 'result', required: true }],
          outputs: [
            artifact({ key: 'review-result', validator: { type: 'JSON', requiredKeys: ['ok'] } }),
          ],
          maxAttempts: 1,
          exitCondition: 'REVIEW_PASS',
          effectType: 'NONE',
        },
      ],
      edges: [
        {
          id: 'first-review',
          fromStepId: 'first',
          toStepId: 'review',
          branch: 'continue',
          condition: { type: 'ALWAYS' },
        },
        {
          id: 'review-pass',
          fromStepId: 'review',
          toStepId: null,
          branch: 'PASS',
          condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
        },
      ],
      referenceBasis: [],
      createdAt: at,
    };
    const copied = copyWorkflowVersionToDraftContent(source);
    expect(copied.steps[1]?.type).toBe('TASK');
    expect(copied.steps[1]).not.toHaveProperty('reviewOutputKey');
    expect(() => validateUserWorkflowDraft(copied)).not.toThrow();
  });
});
