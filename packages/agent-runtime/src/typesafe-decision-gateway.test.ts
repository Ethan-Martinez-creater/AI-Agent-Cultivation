import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMemoryPreGateRequest } from '@cultivation/application/r5-2-memory-pre-gate';
import type { DecisionType } from '@cultivation/application/r0-decision';
import type { Fetch } from '@typesafe-ai/sdk';
import {
  MAX_TYPESAFE_MEMORY_PRE_GATE_RESPONSE_BYTES,
  TypeSafeDecisionGateway,
  TYPESAFE_DECISION_MODEL,
  type TypeSafeDecisionRequest,
} from './typesafe-decision-gateway.js';

const apiKey = 'ts-test-never-log-this-key';
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
] as const;

const baseRequest = (
  decisionType: DecisionType,
  questions: TypeSafeDecisionRequest['questions'],
): TypeSafeDecisionRequest =>
  ({
    decisionType,
    questionVersion: 'r3-test-v1',
    policyVersion: 'r3-shadow-policy-v1',
    stateHash: 'bounded-state-hash',
    inputSummary: { taskSummary: 'bounded task summary', candidateIds: ['teammate-a'] },
    state: { schemaVersion: 'r3-decision-state-v1', taskSummary: 'Write a short unit test.' },
    questions,
  }) as TypeSafeDecisionRequest;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const successfulTaskResponse = (): unknown => {
  const answers: Record<string, unknown> = {};
  for (const dimension of dimensions) {
    answers[`demand.${dimension}.probability`] = {
      type: 'noul',
      noul: dimension === 'CODING' ? 0.94 : 0.08,
    };
    answers[`demand.${dimension}.required`] = {
      type: 'choice',
      choice: dimension === 'CODING' ? 'YES' : 'NO',
      confidence: 0.91,
      probabilities: dimension === 'CODING' ? { YES: 0.91, NO: 0.09 } : { YES: 0.05, NO: 0.95 },
    };
  }
  return {
    model: TYPESAFE_DECISION_MODEL,
    answers,
    usage: { input_tokens: 143, output_tokens: 38 },
  };
};

const taskQuestions = (): TypeSafeDecisionRequest['questions'] => {
  const questions: TypeSafeDecisionRequest['questions'] = {};
  for (const dimension of dimensions) {
    questions[`demand.${dimension}.probability`] = {
      type: 'noul',
      instructions: `Estimate the probability from 0 to 1 that ${dimension} is needed for this task.`,
    };
    questions[`demand.${dimension}.required`] = {
      type: 'choice',
      instructions: `Is ${dimension} a hard requirement for task success?`,
      criteria: { YES: 'Required to meet the task objective.', NO: 'Not a hard requirement.' },
    };
  }
  return questions;
};

const skillCandidates = [
  { id: 'skill-zeta', name: 'Zeta', description: 'A bounded summary.', tags: ['research'] },
  { id: 'skill-alpha', name: 'Alpha', description: 'Another bounded summary.', tags: ['writing'] },
  { id: 'skill-beta', name: 'Beta', description: 'A third bounded summary.', tags: [] },
  {
    id: 'skill-gamma',
    name: 'Gamma',
    description: 'A fourth bounded summary.',
    tags: ['analysis'],
  },
  { id: 'skill-delta', name: 'Delta', description: 'A fifth bounded summary.', tags: ['planning'] },
];

const skillRelevanceRequest = (candidates = skillCandidates): TypeSafeDecisionRequest => {
  const questions = Object.fromEntries(
    candidates.map((candidate) => [
      `skill.${candidate.id}`,
      {
        type: 'noul' as const,
        instructions: 'Estimate relevance from the bounded task context and Skill metadata.',
      },
    ]),
  ) as TypeSafeDecisionRequest['questions'];
  return {
    ...baseRequest('SKILL_RELEVANCE' as DecisionType, questions),
    inputSummary: {
      taskSummary: 'Compare a few enabled Skills for a bounded coding task.',
      candidateIds: candidates.map((candidate) => candidate.id),
    },
    state: {
      context: { objective: 'Compare a few enabled Skills for a bounded coding task.' },
      candidates,
    },
  };
};

const skillRelevanceResponse = (scores: Record<string, number>): unknown => ({
  model: TYPESAFE_DECISION_MODEL,
  answers: Object.fromEntries(
    Object.entries(scores).map(([skillId, score]) => [
      `skill.${skillId}`,
      { type: 'noul', noul: score },
    ]),
  ),
  usage: { input_tokens: 97, output_tokens: 12 },
});

const memoryPreGateRequest = () =>
  makeMemoryPreGateRequest({
    ownerId: 'teammate-a',
    sourceId: 'message-a',
    sourceType: 'CHAT_MESSAGE',
    trigger: 'HARNESS',
    messageRole: 'user',
    evidenceCharacters: 84,
    semanticSignals: {
      durableStatement: true,
      questionOnly: false,
      codeOrStructured: false,
    },
  });

const memoryPreGateResponse = (choice: 'RUN_EXTRACTION' | 'SKIP_EXTRACTION'): unknown => ({
  model: TYPESAFE_DECISION_MODEL,
  answers: {
    extraction: {
      type: 'choice',
      choice,
      confidence: 0.83,
      probabilities: {
        RUN_EXTRACTION: choice === 'RUN_EXTRACTION' ? 0.83 : 0.17,
        SKIP_EXTRACTION: choice === 'SKIP_EXTRACTION' ? 0.83 : 0.17,
      },
    },
  },
  usage: { input_tokens: 35, output_tokens: 4 },
});

describe('TypeSafeDecisionGateway', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['RUN_EXTRACTION', 'SKIP_EXTRACTION'] as const)(
    'normalizes the bounded Memory Pre-Gate choice %s',
    async (choice) => {
      let sentBody: unknown;
      const fetch: Fetch = async (_input, init) => {
        sentBody = JSON.parse(String(init?.body));
        return jsonResponse(memoryPreGateResponse(choice));
      };
      const request = memoryPreGateRequest();
      const result = await new TypeSafeDecisionGateway({ apiKey, fetch }).evaluate(request);

      expect(sentBody).toMatchObject({
        model: TYPESAFE_DECISION_MODEL,
        state: request.state,
        questions: request.questions,
      });
      const wireBody = sentBody as { state: Record<string, unknown> };
      expect(Object.keys(wireBody.state).sort()).toEqual(
        ['evidence', 'messageRole', 'sourceType', 'trigger'].sort(),
      );
      expect(result).toMatchObject({
        provider: 'TYPESAFE',
        model: TYPESAFE_DECISION_MODEL,
        errorCode: null,
        answers: { extraction: choice },
        confidence: { extraction: 0.83 },
        selectedAction: null,
      });
      expect(result.choiceProbabilities).toBeUndefined();
    },
  );

  it('rejects a Memory Pre-Gate request that fails shared validation before transport', async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls += 1;
      return jsonResponse(memoryPreGateResponse('RUN_EXTRACTION'));
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const valid = memoryPreGateRequest();
    const invalidRequests = [
      { ...valid, stateHash: '0'.repeat(64) },
      { ...valid, questionVersion: 'unrecognized-version' },
      {
        ...valid,
        questions: {
          ...valid.questions,
          hidden: { type: 'noul' as const, instructions: 'Not an allowed question.' },
        },
      },
    ];

    for (const request of invalidRequests) {
      expect((await gateway.evaluate(request)).errorCode).toBe('INVALID_REQUEST');
    }
    expect(calls).toBe(0);
  });

  it('fails closed on oversized, unknown-field, extra-answer, and illegal Memory Pre-Gate responses', async () => {
    const valid = memoryPreGateResponse('RUN_EXTRACTION') as {
      model: string;
      answers: Record<string, unknown>;
      usage: { input_tokens: number; output_tokens: number };
    };
    const answer = valid.answers.extraction as Record<string, unknown>;
    const invalidResponses = [
      { ...valid, unexpected: 'provider detail' },
      { ...valid, answers: { ...valid.answers, extra: answer } },
      {
        ...valid,
        answers: {
          extraction: { ...answer, choice: 'WRITE_MEMORY' },
        },
      },
      { ...valid, oversizedProviderData: 'x'.repeat(2_100) },
    ];
    expect(
      new TextEncoder().encode(JSON.stringify(invalidResponses[3])).byteLength,
    ).toBeGreaterThan(MAX_TYPESAFE_MEMORY_PRE_GATE_RESPONSE_BYTES);

    for (const response of invalidResponses) {
      const fetch: Fetch = async () => jsonResponse(response);
      const result = await new TypeSafeDecisionGateway({ apiKey, fetch }).evaluate(
        memoryPreGateRequest(),
      );
      expect(result.errorCode).toBe('SCHEMA_MISMATCH');
      expect(result.answers).toEqual({});
      expect(result.confidence).toEqual({});
      expect(result.selectedAction).toBeNull();
    }
  });

  it('pins the model and sends only the bounded state/questions with bearer auth', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetch: Fetch = async (input, init) => {
      requestUrl = input;
      requestInit = init;
      return jsonResponse(successfulTaskResponse());
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch, timeoutMs: 500 });
    const request = baseRequest('TASK_CAPABILITY', taskQuestions());
    const result = await gateway.evaluate(request);

    expect(requestUrl).toBe('https://api.typesafe.ai/v1/systemone');
    expect(new Headers(requestInit?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: 'jev-1.13.0',
      state: request.state,
      questions: request.questions,
    });
    expect(result.errorCode).toBeNull();
    expect(result.provider).toBe('TYPESAFE');
    expect(result.model).toBe(TYPESAFE_DECISION_MODEL);
    expect(result.inputTokens).toBe(143);
    expect(result.outputTokens).toBe(38);
    expect(result.answers.demands).toHaveLength(14);
    expect(result.answers.demands).toContainEqual({
      dimension: 'CODING',
      probability: 0.94,
      required: true,
    });
    expect(result.confidence['demand.CODING.required']).toBe(0.91);
    expect(result.confidence['demand.CODING.probability']).toBeUndefined();
    expect(result.selectedAction).toBeNull();
  });

  it('normalizes a fit recommendation and keeps choice probabilities outside domain answers', async () => {
    const fetch: Fetch = async () =>
      jsonResponse({
        model: TYPESAFE_DECISION_MODEL,
        answers: {
          teammate: {
            type: 'choice',
            choice: 'teammate-a',
            confidence: 0.78,
            probabilities: { 'teammate-a': 0.78, 'teammate-b': 0.15, NONE: 0.07 },
          },
        },
        usage: { input_tokens: 42, output_tokens: 8 },
      });
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const result = await gateway.evaluate(
      baseRequest('TEAMMATE_FIT', {
        teammate: {
          type: 'choice',
          instructions: 'Choose the eligible teammate that best fits the task.',
          criteria: {
            'teammate-a': 'Coding',
            'teammate-b': 'Design',
            NONE: 'No suitable teammate',
          },
        },
      }),
    );

    expect(result.answers).toEqual({ teammate: 'teammate-a' });
    expect(result.choiceProbabilities).toEqual({
      'teammate-a': 0.78,
      'teammate-b': 0.15,
      NONE: 0.07,
    });
    expect(result.confidence).toEqual({ teammate: 0.78 });
    expect(result.selectedAction).toBe('teammate-a');
  });

  it('preserves collaboration and review choice labels as shadow recommendations', async () => {
    const fetch: Fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const key = Object.keys(body.questions)[0]!;
      const choice = key === 'collaboration' ? 'YES' : 'UNCERTAIN';
      return jsonResponse({
        model: TYPESAFE_DECISION_MODEL,
        answers: {
          [key]: {
            type: 'choice',
            choice,
            confidence: 0.73,
            probabilities: { YES: 0.73, NO: 0.1, UNCERTAIN: 0.17 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const collaboration = await gateway.evaluate(
      baseRequest('COLLABORATION_NEED', {
        collaboration: {
          type: 'choice',
          instructions: 'Would this task benefit from another teammate?',
          criteria: { YES: null, NO: null, UNCERTAIN: null },
        },
      }),
    );
    const review = await gateway.evaluate(
      baseRequest('REVIEW_NEED', {
        review: {
          type: 'choice',
          instructions: 'Would independent review materially help?',
          criteria: { YES: null, NO: null, UNCERTAIN: null },
        },
      }),
    );
    expect(collaboration.answers).toEqual({ collaboration: 'YES' });
    expect(collaboration.selectedAction).toBe('YES');
    expect(review.answers).toEqual({ review: 'UNCERTAIN' });
    expect(review.selectedAction).toBe('UNCERTAIN');
  });

  it('normalizes Skill relevance scores to at most three candidate IDs in stable rank order', async () => {
    let requestInit: RequestInit | undefined;
    const fetch: Fetch = async (_input, init) => {
      requestInit = init;
      return jsonResponse(
        skillRelevanceResponse({
          'skill-zeta': 0.91,
          'skill-alpha': 0.3,
          'skill-beta': 0.91,
          'skill-gamma': 0.82,
          'skill-delta': 0.2,
        }),
      );
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch, timeoutMs: 500 });
    const request = skillRelevanceRequest();
    const result = await gateway.evaluate(request);
    const sent = JSON.parse(String(requestInit?.body)) as {
      model: string;
      state: Record<string, unknown>;
      questions: Record<string, { type: string; criteria?: unknown }>;
    };

    expect(sent.model).toBe(TYPESAFE_DECISION_MODEL);
    expect(sent.state).toEqual(request.state);
    expect(sent.questions).toEqual(request.questions);
    expect(Object.keys(sent.questions).sort()).toEqual(
      skillCandidates.map((candidate) => `skill.${candidate.id}`).sort(),
    );
    expect(Object.values(sent.questions).every((question) => question.type === 'noul')).toBe(true);
    expect(Object.values(sent.questions).every((question) => !('criteria' in question))).toBe(true);
    expect(JSON.stringify(sent.state).toLowerCase()).not.toContain('instructions');
    expect(result).toMatchObject({
      provider: 'TYPESAFE',
      model: TYPESAFE_DECISION_MODEL,
      errorCode: null,
      inputTokens: 97,
      outputTokens: 12,
      confidence: {},
      selectedAction: null,
      answers: {
        skills: [
          { skillId: 'skill-beta', score: 0.91 },
          { skillId: 'skill-zeta', score: 0.91 },
          { skillId: 'skill-gamma', score: 0.82 },
        ],
      },
    });
  });

  it('rejects Skill relevance requests with mismatched IDs or named criteria before transport', async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls += 1;
      return jsonResponse(skillRelevanceResponse({ 'skill-zeta': 0.9 }));
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const base = skillRelevanceRequest([skillCandidates[0]!]);
    const mismatchedIds = {
      ...base,
      inputSummary: { ...base.inputSummary, candidateIds: ['skill-other'] },
    };
    const namedCriteria = {
      ...base,
      questions: {
        [`skill.${skillCandidates[0]!.id}`]: {
          type: 'noul' as const,
          instructions: 'Estimate relevance.',
          criteria: { true: 'Relevant' },
        },
      },
    };
    const skillInstructions = {
      ...base,
      state: {
        ...base.state,
        candidates: [{ ...skillCandidates[0]!, instructions: 'Private Skill instructions.' }],
      },
    };
    const privateMemory = {
      ...base,
      state: {
        ...base.state,
        context: { taskSummary: 'Bounded task summary', privateMemory: 'Private note.' },
      },
    };
    const unknownContext = {
      ...base,
      state: { ...base.state, context: { objective: 'Review', privatePrompt: 'Never send this.' } },
    };
    const unknownState = { ...base, state: { ...base.state, hidden: 'Never send this.' } };
    const tooManyCandidates = skillRelevanceRequest(
      Array.from({ length: 25 }, (_, index) => ({
        id: `skill-${index}`,
        name: `Skill ${index}`,
        description: 'Bounded metadata.',
        tags: [],
      })),
    );

    expect((await gateway.evaluate(mismatchedIds)).errorCode).toBe('INVALID_REQUEST');
    expect((await gateway.evaluate(namedCriteria)).errorCode).toBe('INVALID_REQUEST');
    expect((await gateway.evaluate(skillInstructions)).errorCode).toBe('INVALID_REQUEST');
    expect((await gateway.evaluate(privateMemory)).errorCode).toBe('INVALID_REQUEST');
    expect((await gateway.evaluate(unknownContext)).errorCode).toBe('INVALID_REQUEST');
    expect((await gateway.evaluate(unknownState)).errorCode).toBe('INVALID_REQUEST');
    expect((await gateway.evaluate(tooManyCandidates)).errorCode).toBe('INVALID_REQUEST');
    expect(calls).toBe(0);
  });

  it('fails closed on missing, extra, or non-Noul Skill relevance answers', async () => {
    const request = skillRelevanceRequest(skillCandidates.slice(0, 2));
    const validAnswers = {
      'skill.skill-zeta': { type: 'noul', noul: 0.7 },
      'skill.skill-alpha': { type: 'noul', noul: 0.4 },
    };
    const invalidResponses = [
      { ...validAnswers, 'skill.skill-alpha': undefined },
      { ...validAnswers, 'skill.skill-extra': { type: 'noul', noul: 0.5 } },
      {
        ...validAnswers,
        'skill.skill-alpha': {
          type: 'choice',
          choice: 'YES',
          confidence: 1,
          probabilities: { YES: 1, NO: 0 },
        },
      },
    ];
    for (const answers of invalidResponses) {
      const fetch: Fetch = async () =>
        jsonResponse({
          model: TYPESAFE_DECISION_MODEL,
          answers,
          usage: { input_tokens: 20, output_tokens: 4 },
        });
      const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
      const result = await gateway.evaluate(request);
      expect(result.errorCode).toBe('SCHEMA_MISMATCH');
      expect(result.answers).toEqual({});
      expect(result.selectedAction).toBeNull();
    }
  });

  it('fails open on malformed schema and on answer/question mismatches', async () => {
    const invalidBodies = [
      {
        model: TYPESAFE_DECISION_MODEL,
        answers: {
          teammate: { type: 'choice', choice: 'A', confidence: 2, probabilities: { A: 1 } },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { model: TYPESAFE_DECISION_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    for (const body of invalidBodies) {
      const fetch: Fetch = async () => jsonResponse(body);
      const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
      const result = await gateway.evaluate(
        baseRequest('TEAMMATE_FIT', {
          teammate: {
            type: 'choice',
            instructions: 'Choose a teammate.',
            criteria: { A: null, NONE: null },
          },
        }),
      );
      expect(result.errorCode).toBe('SCHEMA_MISMATCH');
      expect(result.answers).toEqual({});
      expect(result.selectedAction).toBeNull();
    }
  });

  it('fails open without exposing provider errors or the configured credential', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch: Fetch = async () => {
      throw new Error(`connection failed with ${apiKey}`);
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const result = await gateway.evaluate(
      baseRequest('TEAMMATE_FIT', {
        teammate: {
          type: 'choice',
          instructions: 'Choose a teammate.',
          criteria: { A: null, NONE: null },
        },
      }),
    );

    expect(result.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('uses a no-retry timeout and converts timeout to an inert result', async () => {
    const fetch: Fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch, timeoutMs: 15 });
    const result = await gateway.evaluate(
      baseRequest('TEAMMATE_FIT', {
        teammate: {
          type: 'choice',
          instructions: 'Choose a teammate.',
          criteria: { A: null, NONE: null },
        },
      }),
    );
    expect(result.errorCode).toBe('TIMEOUT');
    expect(result.answers).toEqual({});
  });

  it('rejects raw private-memory fields and over-budget state before network access', async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls += 1;
      return jsonResponse({});
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const question = {
      teammate: {
        type: 'choice' as const,
        instructions: 'Choose a teammate.',
        criteria: { A: null, NONE: null },
      },
    };
    const privateRequest = {
      ...baseRequest('TEAMMATE_FIT', question),
      state: { schemaVersion: 'r3', privateMemory: 'private note' },
    };
    const largeRequest = {
      ...baseRequest('TEAMMATE_FIT', question),
      state: { schemaVersion: 'r3', taskSummary: 'x'.repeat(25_000) },
    };
    expect((await gateway.evaluate(privateRequest)).errorCode).toBe('INVALID_REQUEST');
    expect((await gateway.evaluate(largeRequest)).errorCode).toBe('INVALID_REQUEST');
    expect(calls).toBe(0);
  });

  it('Test Connection verifies the authenticated account has the pinned model', async () => {
    let url = '';
    const fetch: Fetch = async (input) => {
      url = input;
      return jsonResponse({
        models: [
          {
            name: TYPESAFE_DECISION_MODEL,
            description: 'Pinned System One model',
            release_date: '2026-09-15',
          },
        ],
      });
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const result = await gateway.testConnection();
    expect(url).toBe('https://api.typesafe.ai/v1/models');
    expect(result).toMatchObject({ ok: true, model: TYPESAFE_DECISION_MODEL, errorCode: null });
  });

  it('Test Connection reports model unavailability without leaking raw response data', async () => {
    const fetch: Fetch = async () =>
      jsonResponse({
        models: [{ name: 'jev-latest', description: 'moving alias', release_date: '2026-09-15' }],
      });
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    expect(await gateway.testConnection()).toMatchObject({
      ok: false,
      model: TYPESAFE_DECISION_MODEL,
      errorCode: 'MODEL_UNAVAILABLE',
    });
  });
});
