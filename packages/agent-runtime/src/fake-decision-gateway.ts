import type {
  DecisionGateway,
  DecisionRequest,
  DecisionResult,
} from '@cultivation/application/r0-decision';

/** Fixed, local fixture responses. An absent fixture produces an inert advisory result. */
export class FakeDecisionGateway implements DecisionGateway {
  constructor(private readonly fixtures: ReadonlyMap<string, DecisionResult> = new Map()) {}

  static key(request: Pick<DecisionRequest, 'decisionType' | 'stateHash'>): string {
    return `${request.decisionType}:${request.stateHash}`;
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const fixture = this.fixtures.get(FakeDecisionGateway.key(request));
    return fixture
      ? structuredClone(fixture)
      : { answers: {}, confidence: {}, selectedAction: null };
  }
}
