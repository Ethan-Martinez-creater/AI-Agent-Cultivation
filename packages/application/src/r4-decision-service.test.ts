import { describe, expect, it } from 'vitest';
import type { DecisionGateway, DecisionRequest, DecisionResult } from './r0-decision.js';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';
import { DecisionStateBuilder } from './r3-decision-state.js';
import {
  createR4DecisionRequest,
  R4DecisionService,
  R4_ROUTING_POLICY_VERSION,
} from './r4-decision-service.js';

class FakeDecisionGateway implements DecisionGateway {
  readonly requests: DecisionRequest[] = [];

  constructor(
    private readonly result: DecisionResult | ((request: DecisionRequest) => DecisionResult),
  ) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(request);
    return typeof this.result === 'function' ? this.result(request) : this.result;
  }
}

function taskRequest(): DecisionRequest {
  return createR4DecisionRequest(
    new DecisionStateBuilder().buildTaskCapability({
      taskSummary: 'Review this TypeScript change.',
    }),
  );
}

function teammateRequest(): DecisionRequest {
  return createR4DecisionRequest(
    new DecisionStateBuilder().buildTeammateFit({
      taskSummary: 'Review this TypeScript change.',
      candidates: [
        {
          id: 'candidate-1',
          roleTitle: 'Code reviewer',
          capabilities: {},
          enabledSkills: [],
          verifiedExperiences: [],
        },
      ],
    }),
  );
}

function collaborationRequest(): DecisionRequest {
  return createR4DecisionRequest(
    new DecisionStateBuilder().buildCollaborationNeed({
      taskSummary: 'Review this TypeScript change.',
      eligibleCandidateCount: 2,
      selectedMode: 'SOLO',
    }),
  );
}

function successfulResult(request: DecisionRequest): DecisionResult {
  if (request.decisionType === 'TASK_CAPABILITY') {
    return {
      answers: {
        demands: CAPABILITY_DIMENSIONS.map((dimension) => ({
          dimension,
          probability: 0.6,
          required: dimension === 'CODING',
        })),
      },
      confidence: Object.fromEntries(
        CAPABILITY_DIMENSIONS.map((dimension) => [`demand.${dimension}.required`, 0.9]),
      ),
      selectedAction: null,
    };
  }
  if (request.decisionType === 'TEAMMATE_FIT') {
    return {
      answers: { teammate: 'candidate-1' },
      confidence: { teammate: 0.9 },
      selectedAction: 'candidate-1',
    };
  }
  return {
    answers: { collaboration: 'YES' },
    confidence: { collaboration: 0.9 },
    selectedAction: 'YES',
  };
}

describe('R4DecisionService', () => {
  it('versions bounded R3 requests under the independent R4 routing policy', () => {
    const r3Request = new DecisionStateBuilder().buildTeammateFit({
      taskSummary: 'Review this TypeScript change.',
      candidates: [
        {
          id: 'candidate-1',
          roleTitle: 'Code reviewer',
          capabilities: {},
          enabledSkills: [],
          verifiedExperiences: [],
        },
      ],
    });
    const r4Request = createR4DecisionRequest(r3Request);

    expect(r4Request.policyVersion).toBe(R4_ROUTING_POLICY_VERSION);
    expect(r4Request.questionVersion).toBe('r4-teammate-fit-v1');
    expect(r4Request.stateHash).not.toBe(r3Request.stateHash);
    expect(r4Request.state).toEqual(r3Request.state);
    expect(r4Request.questions.teammate!.instructions).toContain('bounded advisory');
    expect(r4Request.questions.teammate!.instructions).not.toContain('shadow');
  });

  it('normalizes capability demand, teammate fit, and collaboration need results', async () => {
    const gateway = new FakeDecisionGateway(successfulResult);
    const service = new R4DecisionService({ gateway: async () => gateway });

    const taskResult = await service.evaluate(taskRequest());
    const fitResult = await service.evaluate(teammateRequest());
    const collaborationResult = await service.evaluate(collaborationRequest());

    expect(taskResult.errorCode).toBeUndefined();
    expect(taskResult.answers.demands as Array<{ dimension: string }>).toHaveLength(
      CAPABILITY_DIMENSIONS.length,
    );
    expect(fitResult).toMatchObject({
      answers: { teammate: 'candidate-1' },
      selectedAction: 'candidate-1',
    });
    expect(collaborationResult).toMatchObject({
      answers: { collaboration: 'YES' },
      selectedAction: 'YES',
    });
    expect(
      gateway.requests.every((request) => request.policyVersion === R4_ROUTING_POLICY_VERSION),
    ).toBe(true);
  });

  it('rejects a recommendation outside the bounded candidate IDs', async () => {
    const gateway = new FakeDecisionGateway({
      answers: { teammate: 'unlisted-candidate' },
      confidence: { teammate: 0.9 },
      selectedAction: 'unlisted-candidate',
    });
    const service = new R4DecisionService({ gateway: async () => gateway });

    const result = await service.evaluate(teammateRequest());

    expect(result).toMatchObject({
      answers: {},
      selectedAction: null,
      errorCode: 'SCHEMA_MISMATCH',
    });
  });

  it('rejects invalid R4 metadata before asking the gateway', async () => {
    const gateway = new FakeDecisionGateway(successfulResult);
    const service = new R4DecisionService({ gateway: async () => gateway });
    const invalidRequest = { ...taskRequest(), stateHash: 'invalid' };

    const result = await service.evaluate(invalidRequest);

    expect(result.errorCode).toBe('INVALID_REQUEST');
    expect(gateway.requests).toHaveLength(0);
  });

  it('fails closed when the independent routing gateway is not consent-enabled', async () => {
    const service = new R4DecisionService({ gateway: async () => null });

    const result = await service.evaluate(taskRequest());

    expect(result.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(result.answers).toEqual({});
  });

  it('returns a bounded timeout result when gateway resolution or evaluation hangs', async () => {
    const gateway: DecisionGateway = {
      evaluate: () => new Promise<DecisionResult>(() => undefined),
    };
    const service = new R4DecisionService({
      gateway: async () => gateway,
      timeoutMs: 5,
    });

    const result = await service.evaluate(taskRequest());

    expect(result.errorCode).toBe('TIMEOUT');
    expect(result.selectedAction).toBeNull();
    expect(result.answers).toEqual({});
  });

  it('rejects private fields before adapting a builder request', () => {
    const request = new DecisionStateBuilder().buildTaskCapability({ taskSummary: 'Review code.' });
    const unsafeRequest = {
      ...request,
      state: { ...request.state, memory: 'private note' },
    };

    expect(() => createR4DecisionRequest(unsafeRequest)).toThrow();
  });
});
