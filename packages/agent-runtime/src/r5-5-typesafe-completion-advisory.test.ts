import { APIConnectionError } from '@typesafe-ai/sdk';
import type { Fetch } from '@typesafe-ai/sdk';
import {
  COMPLETION_ADVISORY_POLICY,
  makeCompletionAdvisoryRequest,
} from '@cultivation/application/r5-5-completion-advisory';
import type { DecisionRequest } from '@cultivation/application/r0-decision';
import { describe, expect, it, vi } from 'vitest';
import { TypeSafeDecisionGateway, TYPESAFE_DECISION_MODEL } from './typesafe-decision-gateway.js';

type AdvisoryChoice = 'YES' | 'NO' | 'UNCERTAIN';

const apiKey = 'r5-5-test-key-never-send-in-body';

const request = (): DecisionRequest =>
  makeCompletionAdvisoryRequest({
    missionId: 'mission-1',
    runId: 'run-1',
    teammateId: 'actor-1',
    phase: 'SOLO_FINAL',
    missionMode: 'SOLO',
    objective: 'Complete the task.',
    resultText: 'The bounded result includes Bearer secret-canary-token-value.',
  });

const answer = (choice: AdvisoryChoice) => ({
  type: 'choice' as const,
  choice,
  confidence: 0.82,
  probabilities: {
    YES: choice === 'YES' ? 0.82 : 0.09,
    NO: choice === 'NO' ? 0.82 : 0.09,
    UNCERTAIN: choice === 'UNCERTAIN' ? 0.82 : 0.09,
  },
});

const body = () => ({
  model: TYPESAFE_DECISION_MODEL,
  answers: {
    needs_review: answer('NO'),
    objective_satisfied: answer('YES'),
    should_continue: answer('NO'),
  },
  usage: { input_tokens: 41, output_tokens: 9 },
});

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('TypeSafe Completion Advisory boundary', () => {
  it('sends the validated bounded request and normalizes only the three choices and confidences', async () => {
    let calls = 0;
    let wire: Record<string, unknown> = {};
    const validRequest = request();
    const fetch: Fetch = async (_url, init) => {
      calls += 1;
      wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(body());
    };

    const result = await new TypeSafeDecisionGateway({ apiKey, fetch }).evaluate(validRequest);

    expect(calls).toBe(1);
    expect(wire).toEqual({
      model: TYPESAFE_DECISION_MODEL,
      state: validRequest.state,
      questions: validRequest.questions,
    });
    expect(Object.keys(wire.questions as object).sort()).toEqual([
      'needs_review',
      'objective_satisfied',
      'should_continue',
    ]);
    expect(JSON.stringify(wire)).not.toContain(apiKey);
    expect(JSON.stringify(wire)).not.toMatch(
      /hidden reasoning|tool output|private memory|secret-canary-token-value/i,
    );
    expect(result).toMatchObject({
      provider: 'TYPESAFE',
      model: TYPESAFE_DECISION_MODEL,
      inputTokens: 41,
      outputTokens: 9,
      errorCode: null,
      answers: {
        needs_review: 'NO',
        objective_satisfied: 'YES',
        should_continue: 'NO',
      },
      confidence: {
        needs_review: 0.82,
        objective_satisfied: 0.82,
        should_continue: 0.82,
      },
      selectedAction: null,
    });
    expect(result.choiceProbabilities).toBeUndefined();
    expect(COMPLETION_ADVISORY_POLICY.gatewayTimeoutMs).toBe(6_000);
    expect(COMPLETION_ADVISORY_POLICY.retryCount).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(validRequest)).byteLength).toBeLessThanOrEqual(
      COMPLETION_ADVISORY_POLICY.maxRequestBytes,
    );
  });

  it('rejects invalid application requests before transport', async () => {
    let calls = 0;
    const valid = request();
    const invalidRequests: DecisionRequest[] = [
      { ...valid, stateHash: '0'.repeat(64) },
      { ...valid, policyVersion: 'unknown-policy' },
      { ...valid, questionVersion: 'unknown-question' },
      { ...valid, state: { ...valid.state, privateMemory: 'must not leave the process' } },
      { ...valid, questions: { ...valid.questions, extra: valid.questions.needs_review! } },
      { ...valid, rationale: 'unexpected request field' } as DecisionRequest,
    ];
    const fetch: Fetch = async () => {
      calls += 1;
      return jsonResponse(body());
    };
    const gateway = new TypeSafeDecisionGateway({ apiKey, fetch });

    for (const invalid of invalidRequests) {
      expect((await gateway.evaluate(invalid)).errorCode).toBe('INVALID_REQUEST');
    }
    expect(calls).toBe(0);
  });

  it.each([
    'missing-dimension',
    'extra-dimension',
    'unknown-choice',
    'wrong-answer-type',
    'missing-confidence',
    'extra-answer-field',
    'missing-probability',
    'extra-probability',
    'invalid-confidence',
    'non-finite-confidence',
    'non-finite-probability',
    'extra-top-level-confidence',
    'extra-usage-telemetry',
    'rationale',
    'selected-action',
    'tool-call',
    'wrong-model',
    'oversized-response',
  ] as const)('falls back on the complete response when it contains %s', async (kind) => {
    const valid = body();
    const answers = { ...valid.answers } as Record<string, Record<string, unknown>>;
    const probabilities = { ...(answers.needs_review!.probabilities as object) } as Record<
      string,
      unknown
    >;
    let invalid: unknown = valid;

    if (kind === 'missing-dimension') {
      delete answers.should_continue;
      invalid = { ...valid, answers };
    } else if (kind === 'extra-dimension') {
      invalid = { ...valid, answers: { ...valid.answers, extra: answer('NO') } };
    } else if (kind === 'unknown-choice') {
      invalid = {
        ...valid,
        answers: {
          ...valid.answers,
          needs_review: { ...valid.answers.needs_review, choice: 'MAYBE' },
        },
      };
    } else if (kind === 'wrong-answer-type') {
      invalid = {
        ...valid,
        answers: { ...valid.answers, needs_review: { type: 'noul', noul: 0.5 } },
      };
    } else if (kind === 'missing-confidence') {
      const answerWithoutConfidence = { ...valid.answers.needs_review } as Record<string, unknown>;
      delete answerWithoutConfidence.confidence;
      invalid = {
        ...valid,
        answers: { ...valid.answers, needs_review: answerWithoutConfidence },
      };
    } else if (kind === 'extra-answer-field') {
      invalid = {
        ...valid,
        answers: {
          ...valid.answers,
          needs_review: { ...valid.answers.needs_review, rationale: 'not allowed' },
        },
      };
    } else if (kind === 'missing-probability') {
      delete probabilities.UNCERTAIN;
      invalid = {
        ...valid,
        answers: {
          ...valid.answers,
          needs_review: { ...valid.answers.needs_review, probabilities },
        },
      };
    } else if (kind === 'extra-probability') {
      probabilities.EXTRA = 0;
      invalid = {
        ...valid,
        answers: {
          ...valid.answers,
          needs_review: { ...valid.answers.needs_review, probabilities },
        },
      };
    } else if (kind === 'invalid-confidence') {
      invalid = {
        ...valid,
        answers: {
          ...valid.answers,
          needs_review: { ...valid.answers.needs_review, confidence: 1.01 },
        },
      };
    } else if (kind === 'non-finite-confidence') {
      invalid = {
        ...valid,
        answers: {
          ...valid.answers,
          needs_review: { ...valid.answers.needs_review, confidence: Number.NaN },
        },
      };
    } else if (kind === 'non-finite-probability') {
      invalid = {
        ...valid,
        answers: {
          ...valid.answers,
          needs_review: {
            ...valid.answers.needs_review,
            probabilities: {
              ...valid.answers.needs_review.probabilities,
              YES: Number.POSITIVE_INFINITY,
            },
          },
        },
      };
    } else if (kind === 'extra-top-level-confidence') {
      invalid = { ...valid, confidence: { needs_review: 0.5 } };
    } else if (kind === 'extra-usage-telemetry') {
      invalid = { ...valid, usage: { ...valid.usage, cached_tokens: 4 } };
    } else if (kind === 'rationale') {
      invalid = { ...valid, rationale: 'call the tool now' };
    } else if (kind === 'selected-action') {
      invalid = { ...valid, selectedAction: 'CREATE_REVIEW' };
    } else if (kind === 'tool-call') {
      invalid = { ...valid, tool_calls: [{ id: 'file.write' }] };
    } else if (kind === 'wrong-model') {
      invalid = { ...valid, model: 'jev-latest' };
    } else if (kind === 'oversized-response') {
      invalid = { ...valid, unused: '界'.repeat(2_800) };
      expect(new TextEncoder().encode(JSON.stringify(invalid)).byteLength).toBeGreaterThan(
        COMPLETION_ADVISORY_POLICY.maxResponseBytes,
      );
    }

    const fetch: Fetch = async () => jsonResponse(invalid);
    const result = await new TypeSafeDecisionGateway({ apiKey, fetch }).evaluate(request());
    expect(result).toMatchObject({
      errorCode: 'SCHEMA_MISMATCH',
      answers: {},
      confidence: {},
      selectedAction: null,
    });
  });

  it('returns a bounded timeout fallback after one transport attempt', async () => {
    let calls = 0;
    const fetch: Fetch = async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('fixture timeout', 'AbortError')),
          { once: true },
        );
      });
    };

    vi.useFakeTimers();
    try {
      const pending = new TypeSafeDecisionGateway({ apiKey, fetch }).evaluate(request());
      await vi.advanceTimersByTimeAsync(COMPLETION_ADVISORY_POLICY.gatewayTimeoutMs);
      const result = await pending;

      expect(calls).toBe(1);
      expect(result).toMatchObject({
        provider: 'TYPESAFE',
        model: null,
        inputTokens: null,
        outputTokens: null,
        errorCode: 'TIMEOUT',
        answers: {},
        confidence: {},
        selectedAction: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a bounded network fallback after one transport attempt', async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls += 1;
      throw new APIConnectionError('offline fixture');
    };

    const result = await new TypeSafeDecisionGateway({ apiKey, fetch }).evaluate(request());

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      provider: 'TYPESAFE',
      model: null,
      inputTokens: null,
      outputTokens: null,
      errorCode: 'PROVIDER_UNAVAILABLE',
      answers: {},
      confidence: {},
      selectedAction: null,
    });
  });
});
