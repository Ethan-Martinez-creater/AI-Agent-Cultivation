import { describe, expect, it } from 'vitest';
import { makeMemoryPreGateRequest } from '@cultivation/application/r5-2-memory-pre-gate';
import type { DecisionRequest, DecisionResult } from '@cultivation/application/r0-decision';
import { FakeDecisionGateway } from './fake-decision-gateway.js';

const request = {
  decisionType: 'TASK_CAPABILITY',
  questionVersion: 'r0-fixture-v1',
  policyVersion: 'r3-shadow-v1',
  stateHash: 'state-1',
  inputSummary: {
    taskSummary: 'A bounded public task summary',
    candidateIds: ['teammate-a'],
  },
  state: { schemaVersion: 'r3-decision-state-v1', taskSummary: 'A bounded public task summary' },
  questions: Object.fromEntries(
    [
      'GENERAL_REASONING',
      'LONG_CONTEXT_REASONING',
      'AGENTIC_EXECUTION',
      'CODING',
      'TOOL_USE',
      'VISUAL_UNDERSTANDING',
      'IMAGE_GENERATION',
      'IMAGE_EDITING',
      'VIDEO_GENERATION',
      'VIDEO_EDITING',
      'SPEECH_UNDERSTANDING',
      'SPEECH_GENERATION',
      'SPEECH_TO_SPEECH',
      'MUSIC_GENERATION',
    ].flatMap((dimension) => [
      [
        `demand.${dimension}.probability`,
        { type: 'noul' as const, instructions: 'Estimate task demand.' },
      ],
      [
        `demand.${dimension}.required`,
        {
          type: 'choice' as const,
          instructions: 'Is this required?',
          criteria: { YES: null, NO: null },
        },
      ],
    ]),
  ),
} as DecisionRequest;

const memoryPreGateRequest = (durableStatement: boolean) =>
  makeMemoryPreGateRequest({
    ownerId: 'teammate-a',
    sourceId: 'message-a',
    sourceType: 'CHAT_MESSAGE',
    trigger: 'HARNESS',
    messageRole: 'user',
    evidenceCharacters: 84,
    semanticSignals: {
      durableStatement,
      questionOnly: false,
      codeOrStructured: false,
    },
  });

describe('FakeDecisionGateway', () => {
  it('creates safe deterministic answers without calling a remote decision service', async () => {
    const gateway = new FakeDecisionGateway();
    const result = await gateway.evaluate(request);
    expect(result.answers.demands).toHaveLength(14);
    expect(result.selectedAction).toBeNull();
  });

  it('returns a deterministic isolated copy keyed by decision and state', async () => {
    const fixture: DecisionResult = {
      answers: { demands: [{ dimension: 'CODING', probability: 0.8, required: true }] },
      confidence: { demands: 0.9 },
      selectedAction: 'ADVISE_ONLY',
    };
    const gateway = new FakeDecisionGateway(new Map([[FakeDecisionGateway.key(request), fixture]]));
    const first = await gateway.evaluate(request);
    (first.answers.demands as Array<{ dimension: string }>)[0]!.dimension = 'MUTATED';
    expect(await gateway.evaluate(request)).toEqual(fixture);
    const unmatched = await gateway.evaluate({ ...request, stateHash: 'unmatched' });
    expect(unmatched.answers.demands).toHaveLength(14);
    expect(unmatched).not.toEqual(fixture);
  });

  it('creates bounded deterministic fake answers for every R3 decision shape', async () => {
    const dimensions = [
      'GENERAL_REASONING',
      'LONG_CONTEXT_REASONING',
      'AGENTIC_EXECUTION',
      'CODING',
      'TOOL_USE',
      'VISUAL_UNDERSTANDING',
      'IMAGE_GENERATION',
      'IMAGE_EDITING',
      'VIDEO_GENERATION',
      'VIDEO_EDITING',
      'SPEECH_UNDERSTANDING',
      'SPEECH_GENERATION',
      'SPEECH_TO_SPEECH',
      'MUSIC_GENERATION',
    ];
    const questions = Object.fromEntries(
      dimensions.flatMap((dimension) => [
        [
          `demand.${dimension}.probability`,
          { type: 'noul' as const, instructions: 'Estimate task demand.' },
        ],
        [
          `demand.${dimension}.required`,
          {
            type: 'choice' as const,
            instructions: 'Is it required?',
            criteria: { YES: null, NO: null },
          },
        ],
      ]),
    );
    const taskResult = await new FakeDecisionGateway().evaluate({
      ...request,
      questions,
    } as DecisionRequest);
    expect(taskResult.answers.demands).toHaveLength(14);
    expect(taskResult.answers.demands).toContainEqual({
      dimension: 'CODING',
      probability: 0.25,
      required: false,
    });

    const teammateResult = await new FakeDecisionGateway().evaluate({
      ...request,
      decisionType: 'TEAMMATE_FIT',
      questions: {
        teammate: {
          type: 'choice',
          instructions: 'Choose an eligible teammate.',
          criteria: { 'teammate-b': null, 'teammate-a': null, NONE: null },
        },
      },
    } as DecisionRequest);
    expect(teammateResult.answers.teammate).toBe('teammate-b');
    expect(Object.keys(teammateResult.answers)).toEqual(['teammate']);
    expect(teammateResult.choiceProbabilities).toEqual({
      'teammate-b': 1,
      'teammate-a': 0,
      NONE: 0,
    });
    expect(teammateResult.confidence.teammate).toBe(1);
    expect(teammateResult.selectedAction).toBe('teammate-b');

    const collaborationResult = await new FakeDecisionGateway().evaluate({
      ...request,
      decisionType: 'COLLABORATION_NEED',
      questions: {
        collaboration: {
          type: 'choice',
          instructions: 'Would collaboration help?',
          criteria: { YES: null, NO: null, UNCERTAIN: null },
        },
      },
    } as DecisionRequest);
    const reviewResult = await new FakeDecisionGateway().evaluate({
      ...request,
      decisionType: 'REVIEW_NEED',
      questions: {
        review: {
          type: 'choice',
          instructions: 'Would review help?',
          criteria: { YES: null, NO: null, UNCERTAIN: null },
        },
      },
    } as DecisionRequest);
    expect(collaborationResult.answers.collaboration).toBe('NO');
    expect(reviewResult.answers.review).toBe('NO');
    expect(collaborationResult.selectedAction).toBe('NO');
    expect(reviewResult.selectedAction).toBe('NO');
  });

  it('returns deterministic local top-three Skill relevance scores', async () => {
    const candidates = ['skill-zeta', 'skill-alpha', 'skill-gamma', 'skill-beta', 'skill-delta'];
    const skillRequest = {
      ...request,
      decisionType: 'SKILL_RELEVANCE',
      inputSummary: {
        taskSummary: 'A bounded public task summary',
        candidateIds: candidates,
      },
      state: {
        schemaVersion: 'r5-skill-relevance-v1',
        decisionType: 'SKILL_RELEVANCE',
        context: { taskSummary: 'A bounded public task summary' },
        candidates: candidates.map((id) => ({ id, name: id, description: '', tags: [] })),
      },
      questions: Object.fromEntries(
        candidates.map((id) => [
          `skill.${id}`,
          { type: 'noul' as const, instructions: 'Estimate relevance.' },
        ]),
      ),
    } as DecisionRequest;

    const result = await new FakeDecisionGateway().evaluate(skillRequest);

    expect(result).toEqual({
      answers: {
        skills: [
          { skillId: 'skill-zeta', score: 1 },
          { skillId: 'skill-alpha', score: 5 / 6 },
          { skillId: 'skill-gamma', score: 1 - 2 / 6 },
        ],
      },
      confidence: {},
      selectedAction: null,
    });
  });

  it('uses only validated metadata facts for deterministic Memory Pre-Gate RUN and SKIP fixtures', async () => {
    const gateway = new FakeDecisionGateway();
    const runRequest = memoryPreGateRequest(true);
    const skipRequest = memoryPreGateRequest(false);

    expect(JSON.stringify(runRequest.state)).not.toMatch(
      /memory.?content|conversation.?history|instructions/i,
    );
    expect(await gateway.evaluate(runRequest)).toEqual({
      answers: { extraction: 'RUN_EXTRACTION' },
      confidence: { extraction: 1 },
      selectedAction: null,
      errorCode: null,
    });
    expect(await gateway.evaluate(skipRequest)).toEqual({
      answers: { extraction: 'SKIP_EXTRACTION' },
      confidence: { extraction: 1 },
      selectedAction: null,
      errorCode: null,
    });
  });

  it('rejects a Memory Pre-Gate request that does not pass shared policy validation', async () => {
    const valid = memoryPreGateRequest(true);
    const forged = {
      ...valid,
      state: { ...valid.state, privateMemory: 'must not enter a decision request' },
    };
    const result = await new FakeDecisionGateway().evaluate(forged);
    expect(result).toEqual({
      answers: {},
      confidence: {},
      selectedAction: null,
      errorCode: 'INVALID_REQUEST',
    });
  });
});
