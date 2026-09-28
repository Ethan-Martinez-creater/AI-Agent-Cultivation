import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionType } from '@cultivation/application/r0-decision';
import type { Fetch } from '@typesafe-ai/sdk';
import {
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

describe('TypeSafeDecisionGateway', () => {
  afterEach(() => vi.restoreAllMocks());

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
