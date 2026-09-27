import { describe, expect, it } from 'vitest';
import type { DecisionRequest, DecisionResult } from '@cultivation/application/r0-decision';
import { FakeDecisionGateway } from './fake-decision-gateway.js';

const request: DecisionRequest = {
  decisionType: 'TASK_CAPABILITY',
  questionVersion: 'r0-fixture-v1',
  stateHash: 'state-1',
  inputSummary: {
    taskSummary: 'A bounded public task summary',
    candidateIds: ['teammate-a'],
  },
};

describe('FakeDecisionGateway', () => {
  it('is inert without a fixture and never calls a remote decision service', async () => {
    const gateway = new FakeDecisionGateway();
    expect(await gateway.evaluate(request)).toEqual({
      answers: {},
      confidence: {},
      selectedAction: null,
    });
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
    expect(await gateway.evaluate({ ...request, stateHash: 'unmatched' })).toEqual({
      answers: {},
      confidence: {},
      selectedAction: null,
    });
  });
});
