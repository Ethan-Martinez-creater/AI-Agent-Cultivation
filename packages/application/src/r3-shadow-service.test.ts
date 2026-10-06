import { describe, expect, it } from 'vitest';
import type { DecisionGateway, DecisionRequest, DecisionResult } from './r0-decision.js';
import type { DecisionReceipt } from '@cultivation/domain';
import { DecisionStateBuilder } from './r3-decision-state.js';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';
import { ShadowDecisionService, type DecisionShadowObservation } from './r3-shadow-service.js';

class FakeDecisionGateway implements DecisionGateway {
  calls = 0;

  constructor(private readonly result: DecisionResult | Error | unknown) {}

  async evaluate(_request: DecisionRequest): Promise<DecisionResult> {
    void _request;
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result as DecisionResult;
  }
}

function setup(result: DecisionResult | Error | unknown) {
  const gateway = new FakeDecisionGateway(result);
  const receipts: DecisionReceipt[] = [];
  const observations: DecisionShadowObservation[] = [];
  const service = new ShadowDecisionService({
    gateway,
    receipts: { appendDecisionReceipt: (receipt) => void receipts.push(receipt) },
    observations: {
      recordDecisionObservation: (observation) => void observations.push(observation),
    },
    provider: 'TYPESAFE',
    model: 'jev-1.13.0',
    modelVersion: 'jev-1.13.0',
    policyVersion: 'r3-shadow-policy-v1',
    now: () => '2026-09-28T12:00:00.000Z',
    idFactory: () => 'receipt-fixed-id',
  });
  return { service, gateway, receipts, observations };
}

function taskRequest(): DecisionRequest {
  return new DecisionStateBuilder().buildTaskCapability({ taskSummary: '请审查这段 TypeScript。' });
}

function completeTaskAnswer() {
  return {
    demands: CAPABILITY_DIMENSIONS.map((dimension) => ({
      dimension,
      probability: 0.7,
      required: dimension === 'CODING',
    })),
  };
}

describe('ShadowDecisionService', () => {
  it('does not promote the separate Skill relevance path into the R3 SHADOW plane', async () => {
    const { service, gateway, receipts } = setup({
      answers: {},
      confidence: {},
      selectedAction: null,
    });
    const result = await service.evaluate(
      { ...taskRequest(), decisionType: 'SKILL_RELEVANCE' },
      { actualAction: 'unchanged' },
    );
    expect(result).toMatchObject({ status: 'FALLBACK', fallbackCode: 'INVALID_REQUEST' });
    expect(gateway.calls).toBe(0);
    expect(receipts).toEqual([]);
  });
  it('accepts only bounded availability signals and stays strictly SHADOW', async () => {
    const { service, gateway } = setup({
      answers: { teammate: 'a' },
      confidence: {},
      selectedAction: 'a',
    });
    const request = new DecisionStateBuilder().buildTeammateFit({
      taskSummary: 'Answer',
      candidates: [
        {
          id: 'a',
          roleTitle: 'Fixture',
          capabilities: {},
          enabledSkills: [],
          verifiedExperiences: [],
          modelAvailability: 'UNSTABLE',
          stabilityPenalty: 'UNSTABLE',
        },
      ],
    });
    const result = await service.evaluate(request, { actualAction: 'explicit-a' });
    expect(gateway.calls).toBe(1);
    expect(result.status).toBe('RECORDED');
  });
  it('appends a SHADOW receipt with provider metadata and records, but never applies, the recommendation', async () => {
    const request = taskRequest();
    const { service, receipts, observations } = setup({
      answers: completeTaskAnswer(),
      confidence: { 'demand.CODING.required': 0.87 },
      selectedAction: null,
      model: 'jev-1.13.0',
      inputTokens: 247,
      latencyMs: 981,
    });

    const result = await service.evaluate(request, {
      missionId: 'mission-1',
      runId: 'run-1',
      actualAction: 'teammate-user-selected',
    });

    expect(result.status).toBe('RECORDED');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      missionId: 'mission-1',
      runId: 'run-1',
      decisionType: 'TASK_CAPABILITY',
      provider: 'TYPESAFE',
      model: 'jev-1.13.0',
      modelVersion: 'jev-1.13.0',
      mode: 'SHADOW',
      selectedAction: null,
      actualAction: 'teammate-user-selected',
      inputTokens: 247,
      latencyMs: 981,
    });
    expect(observations[0]).toMatchObject({
      status: 'RECORDED',
      recommendation: null,
      actualAction: 'teammate-user-selected',
    });
  });

  it('fails open on provider timeout/error and stores only a sanitized fallback observation', async () => {
    const { service, gateway, receipts, observations } = setup(
      new Error('request timeout with token sk-abcdefghijklmnop'),
    );
    const result = await service.evaluate(taskRequest(), { actualAction: 'selected-by-user' });

    expect(result).toMatchObject({ status: 'FALLBACK', fallbackCode: 'PROVIDER_UNAVAILABLE' });
    expect(gateway.calls).toBe(1);
    expect(receipts).toHaveLength(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      status: 'FALLBACK',
      fallbackCode: 'PROVIDER_UNAVAILABLE',
      recommendation: null,
      actualAction: 'selected-by-user',
    });
    expect(JSON.stringify(observations)).not.toContain('sk-abcdefghijklmnop');
    expect(JSON.stringify(observations)).not.toContain('timeout with token');
  });

  it('returns on its configured deadline when a DecisionGateway never settles', async () => {
    const receipts: DecisionReceipt[] = [];
    const observations: DecisionShadowObservation[] = [];
    const service = new ShadowDecisionService({
      gateway: { evaluate: () => new Promise<DecisionResult>(() => undefined) },
      receipts: { appendDecisionReceipt: (receipt) => void receipts.push(receipt) },
      observations: {
        recordDecisionObservation: (observation) => void observations.push(observation),
      },
      provider: 'TYPESAFE',
      model: 'jev-1.13.0',
      modelVersion: 'jev-1.13.0',
      policyVersion: 'r3-shadow-policy-v1',
      timeoutMs: 5,
    });

    const result = await service.evaluate(taskRequest());
    expect(result).toMatchObject({ status: 'FALLBACK', fallbackCode: 'TIMEOUT' });
    expect(receipts).toHaveLength(0);
    expect(observations[0]?.fallbackCode).toBe('TIMEOUT');
  });

  it('fails open on response schema mismatch without persisting a DecisionReceipt', async () => {
    const { service, receipts, observations } = setup({
      answers: {},
      confidence: { decision: 1.4 },
      selectedAction: null,
    });
    const result = await service.evaluate(taskRequest());

    expect(result).toMatchObject({ status: 'FALLBACK', fallbackCode: 'SCHEMA_MISMATCH' });
    expect(receipts).toHaveLength(0);
    expect(observations[0]?.fallbackCode).toBe('SCHEMA_MISMATCH');
  });

  it('uses sanitized adapter error codes and never turns an empty failure response into a receipt', async () => {
    for (const code of [
      'TIMEOUT',
      'PROVIDER_UNAVAILABLE',
      'SCHEMA_MISMATCH',
      'INVALID_REQUEST',
    ] as const) {
      const { service, receipts, observations } = setup({
        answers: {},
        confidence: {},
        selectedAction: null,
        errorCode: code,
        latencyMs: 42,
      });
      const result = await service.evaluate(taskRequest());
      expect(result).toMatchObject({ status: 'FALLBACK', fallbackCode: code });
      expect(receipts).toHaveLength(0);
      expect(observations[0]).toMatchObject({ fallbackCode: code, latencyMs: 42 });
    }
  });

  it('rejects non-allowlisted state before calling the DecisionGateway', async () => {
    const { service, gateway, receipts, observations } = setup({
      answers: {},
      confidence: {},
      selectedAction: null,
    });
    const request = taskRequest();
    (request.state as Record<string, unknown>).privateMemory = 'must never be sent';
    const result = await service.evaluate(request);

    expect(result).toMatchObject({ status: 'FALLBACK', fallbackCode: 'INVALID_REQUEST' });
    expect(gateway.calls).toBe(0);
    expect(receipts).toHaveLength(0);
    expect(observations[0]?.status).toBe('FALLBACK');
  });

  it('rejects secret or hidden-reasoning fields in decision answers before writing a receipt', async () => {
    const { service, receipts, observations } = setup({
      answers: {
        teammate: 'NONE',
        apiKey: 'sk-abcdefghijklmnop',
        chainOfThought: 'hidden reasoning',
      },
      confidence: {},
      selectedAction: 'NONE',
    });
    const result = await service.evaluate(
      new DecisionStateBuilder().buildTeammateFit({
        taskSummary: 'Find a suitable teammate.',
        candidates: [],
      }),
    );

    expect(result).toMatchObject({ status: 'FALLBACK', fallbackCode: 'SCHEMA_MISMATCH' });
    expect(receipts).toHaveLength(0);
    expect(JSON.stringify(observations)).not.toContain('sk-abcdefghijklmnop');
    expect(JSON.stringify(observations)).not.toContain('hidden reasoning');
  });

  it('records teammate fit and collaboration/review choices as recommendations only', async () => {
    const fitRequest = new DecisionStateBuilder().buildTeammateFit({
      taskSummary: 'Write a concise Chinese guide.',
      explicitTeammateId: 'chosen-by-user',
      candidates: [
        {
          id: 'chosen-by-user',
          roleTitle: 'Writer',
          capabilities: {},
          enabledSkills: [],
          verifiedExperiences: [],
        },
        {
          id: 'other',
          roleTitle: 'Reviewer',
          capabilities: {},
          enabledSkills: [],
          verifiedExperiences: [],
        },
      ],
    });
    const fit = setup({ answers: { teammate: 'other' }, confidence: {}, selectedAction: null });
    const fitResult = await fit.service.evaluate(fitRequest, { actualAction: 'chosen-by-user' });
    expect(fitResult).toMatchObject({
      status: 'RECORDED',
      recommendation: { selectedAction: 'other' },
    });
    expect(fit.observations[0]).toMatchObject({
      recommendation: 'other',
      actualAction: 'chosen-by-user',
    });

    for (const decision of [
      {
        request: new DecisionStateBuilder().buildCollaborationNeed({
          taskSummary: 'Translate a technical document.',
          eligibleCandidateCount: 1,
        }),
        key: 'collaboration',
      },
      {
        request: new DecisionStateBuilder().buildReviewNeed({
          taskSummary: 'Translate a technical document.',
        }),
        key: 'review',
      },
    ]) {
      const fixture = setup({
        answers: { [decision.key]: 'YES' },
        confidence: {},
        selectedAction: null,
      });
      const result = await fixture.service.evaluate(decision.request);
      expect(result).toMatchObject({
        status: 'RECORDED',
        recommendation: { selectedAction: 'YES' },
      });
    }
  });

  it('does not depend on ModelGateway semantics or add execution methods', () => {
    const keys = Object.getOwnPropertyNames(ShadowDecisionService.prototype);
    expect(keys).toEqual(['constructor', 'evaluate', 'fallback', 'recordObservation']);
    expect(keys.some((key) => /route|execute|permission|invite|runtime|bridge/i.test(key))).toBe(
      false,
    );
  });
});
