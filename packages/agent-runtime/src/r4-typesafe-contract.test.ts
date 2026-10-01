import { describe, expect, it } from 'vitest';
import {
  DecisionStateBuilder,
  R4DecisionService,
  R4_ROUTING_POLICY_VERSION,
  R4_ROUTING_QUESTION_VERSIONS,
  createR4DecisionRequest,
} from '@cultivation/application';
import type {
  DecisionCandidateInput,
  DecisionGateway,
  DecisionRequest,
} from '@cultivation/application';
import {
  TypeSafeDecisionGateway,
  TYPESAFE_DECISION_MODEL,
} from '@cultivation/agent-runtime/typesafe-decision-gateway';
import type { Fetch } from '@typesafe-ai/sdk';

const apiKey = 'r4-contract-test-placeholder-key';
const privateSentinel = 'contract-private-marker-7d2f1';

interface CapturedPayload {
  model: string;
  state: Record<string, unknown>;
  questions: Record<
    string,
    {
      type: 'noul' | 'choice';
      instructions: string;
      criteria?: Record<string, string | null>;
    }
  >;
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function successfulSdkResponse(payload: CapturedPayload): unknown {
  const answers: Record<string, unknown> = {};
  const candidates = Array.isArray(payload.state.candidates)
    ? (payload.state.candidates as Array<{ id: string }>)
    : [];

  for (const [key, question] of Object.entries(payload.questions)) {
    if (question.type === 'noul') {
      const dimension = key.split('.')[1];
      answers[key] = {
        type: 'noul',
        noul: dimension === 'CODING' ? 0.94 : 0.08,
      };
      continue;
    }

    const criteria = Object.keys(question.criteria ?? {});
    const dimension = key.split('.')[1];
    const choice =
      key === 'teammate'
        ? (candidates[0]?.id ?? 'NONE')
        : key.endsWith('.required')
          ? dimension === 'CODING'
            ? 'YES'
            : 'NO'
          : criteria[0]!;
    const chosenProbability = 0.91;
    const otherProbability = (1 - chosenProbability) / Math.max(1, criteria.length - 1);
    answers[key] = {
      type: 'choice',
      choice,
      confidence: chosenProbability,
      probabilities: Object.fromEntries(
        criteria.map((criterion) => [
          criterion,
          criterion === choice ? chosenProbability : otherProbability,
        ]),
      ),
    };
  }

  return {
    model: TYPESAFE_DECISION_MODEL,
    answers,
    usage: { input_tokens: 211, output_tokens: 37 },
  };
}

describe('R4 TypeSafe decision contract', () => {
  it('normalizes bounded R4 demand and top-K fit through the pinned SDK transport', async () => {
    const captured: Array<{ url: string; payload: CapturedPayload; authorization: string | null }> =
      [];
    const fetch: Fetch = async (input, init) => {
      const payload = JSON.parse(String(init?.body)) as CapturedPayload;
      captured.push({
        url: input,
        payload,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return jsonResponse(successfulSdkResponse(payload));
    };

    const typeSafeGateway = new TypeSafeDecisionGateway({ apiKey, fetch });
    const requestsAtGateway: DecisionRequest[] = [];
    const gateway: DecisionGateway = {
      evaluate: async (request) => {
        requestsAtGateway.push(request);
        return typeSafeGateway.evaluate(request);
      },
    };
    const service = new R4DecisionService({ gateway: async () => gateway, timeoutMs: 1_000 });
    const builder = new DecisionStateBuilder();
    const r3TaskRequest = builder.buildTaskCapability({
      taskSummary: `Write a focused routing test. api_key=${privateSentinel}`,
    });
    const taskRequest = createR4DecisionRequest(r3TaskRequest);
    const fitCandidates: DecisionCandidateInput[] = [
      {
        id: 'candidate-fit',
        roleTitle: 'Code reviewer',
        capabilities: { CODING: { status: 'SUPPORTED', score: 84 } },
        enabledSkills: [],
        verifiedExperiences: [],
      },
      {
        id: 'candidate-other',
        roleTitle: 'Researcher',
        capabilities: { GENERAL_REASONING: { status: 'SUPPORTED', score: 76 } },
        enabledSkills: [],
        verifiedExperiences: [],
      },
    ];
    const r3FitRequest = builder.buildTeammateFit({
      taskSummary: 'Review the proposed routing change.',
      candidates: fitCandidates,
    });
    const fitRequest = createR4DecisionRequest(r3FitRequest);

    const taskResult = await service.evaluate(taskRequest);
    const fitResult = await service.evaluate(fitRequest);

    expect(requestsAtGateway).toHaveLength(2);
    expect(captured).toHaveLength(2);

    expect(taskRequest).toMatchObject({
      decisionType: 'TASK_CAPABILITY',
      policyVersion: R4_ROUTING_POLICY_VERSION,
      questionVersion: R4_ROUTING_QUESTION_VERSIONS.TASK_CAPABILITY,
    });
    expect(taskRequest.stateHash).not.toBe(r3TaskRequest.stateHash);
    expect(fitRequest).toMatchObject({
      decisionType: 'TEAMMATE_FIT',
      policyVersion: R4_ROUTING_POLICY_VERSION,
      questionVersion: R4_ROUTING_QUESTION_VERSIONS.TEAMMATE_FIT,
    });
    expect(fitRequest.stateHash).not.toBe(r3FitRequest.stateHash);

    expect(taskResult.errorCode).toBeUndefined();
    expect(taskResult.answers.demands).toHaveLength(14);
    expect(taskResult.answers.demands).toContainEqual({
      dimension: 'CODING',
      probability: 0.94,
      required: true,
    });
    expect(taskResult.confidence['demand.CODING.required']).toBe(0.91);
    expect(taskResult.confidence['demand.CODING.probability']).toBeUndefined();
    expect(taskResult.selectedAction).toBeNull();
    expect(taskResult.model).toBe(TYPESAFE_DECISION_MODEL);
    expect(taskResult.inputTokens).toBe(211);

    expect(fitResult.errorCode).toBeUndefined();
    expect(fitResult).toMatchObject({
      answers: { teammate: 'candidate-fit' },
      confidence: { teammate: 0.91 },
      selectedAction: 'candidate-fit',
      model: TYPESAFE_DECISION_MODEL,
      inputTokens: 211,
    });
    expect((fitRequest.state.candidates as Array<{ id: string }>).map(({ id }) => id)).toEqual([
      'candidate-fit',
      'candidate-other',
    ]);
    expect(Object.keys(fitRequest.questions.teammate?.criteria ?? {})).toEqual([
      'candidate-fit',
      'candidate-other',
      'NONE',
    ]);

    expect(requestsAtGateway).toEqual([taskRequest, fitRequest]);
    expect(captured).toHaveLength(2);
    expect(captured.map(({ url }) => url)).toEqual([
      'https://api.typesafe.ai/v1/systemone',
      'https://api.typesafe.ai/v1/systemone',
    ]);
    expect(captured.map(({ payload }) => payload.model)).toEqual([
      TYPESAFE_DECISION_MODEL,
      TYPESAFE_DECISION_MODEL,
    ]);
    expect(captured[0]?.payload).toMatchObject({
      state: taskRequest.state,
      questions: taskRequest.questions,
    });
    expect(captured[1]?.payload).toMatchObject({
      state: fitRequest.state,
      questions: fitRequest.questions,
    });
    expect(captured.every(({ authorization }) => authorization === `Bearer ${apiKey}`)).toBe(true);

    const sentJson = JSON.stringify(captured.map(({ payload }) => payload));
    expect(sentJson).not.toContain(privateSentinel);
    expect(sentJson).not.toMatch(/rawMemory|privateMemory|api[_ -]?key|secret|credential/i);
    expect(sentJson).toContain('bounded advisory');
    expect(sentJson).not.toMatch(/\bshadow\b/i);
    expect(captured[0]?.payload.questions['demand.CODING.required']?.instructions).toContain(
      'does not select or assign an executor',
    );
    expect(captured[1]?.payload.questions.teammate?.instructions).toContain(
      'does not assign a Teammate or claim execution',
    );
  });
});
