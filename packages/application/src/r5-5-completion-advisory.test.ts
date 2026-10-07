import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionGateway, DecisionRequest, DecisionResult } from './r0-decision.js';
import {
  COMPLETION_ADVISORY_POLICY,
  CompletionAdvisoryService,
  makeCompletionAdvisoryRequest,
  validateCompletionAdvisoryRequest,
  type CompletionAdvisoryChoices,
  type CompletionAdvisoryContext,
} from './r5-5-completion-advisory.js';

function context(overrides: Partial<CompletionAdvisoryContext> = {}): CompletionAdvisoryContext {
  return {
    missionId: 'mission-1',
    runId: 'run-1',
    teammateId: 'teammate-a',
    phase: 'SOLO_FINAL',
    missionMode: 'SOLO',
    objective: 'Complete the requested task.',
    resultText: 'The candidate final result is ready.',
    ...overrides,
  };
}

function choices(overrides: Partial<CompletionAdvisoryChoices> = {}): CompletionAdvisoryChoices {
  return {
    needs_review: 'NO',
    objective_satisfied: 'YES',
    should_continue: 'NO',
    ...overrides,
  };
}

function result(
  answer: CompletionAdvisoryChoices = choices(),
  overrides: Record<string, unknown> = {},
): DecisionResult {
  return {
    provider: 'TYPESAFE',
    model: 'jev-1.13.0',
    inputTokens: 32,
    outputTokens: 8,
    latencyMs: 10,
    errorCode: null,
    answers: answer,
    confidence: {
      needs_review: 0.91,
      objective_satisfied: 0.84,
      should_continue: 0.88,
    },
    selectedAction: null,
    ...overrides,
  } as unknown as DecisionResult;
}

function makeGateway(value: unknown) {
  const evaluate = vi.fn(async (request: DecisionRequest) => {
    void request;
    return value as DecisionResult;
  });
  return { gateway: { evaluate } satisfies DecisionGateway, evaluate };
}

describe('R5.5 completion advisory request boundary', () => {
  it('keeps clipping canonical when the excerpt boundary falls on whitespace', () => {
    const request = makeCompletionAdvisoryRequest(
      context({ resultText: `${'x'.repeat(959)} ${'tail'.repeat(30)}` }),
    );
    expect(validateCompletionAdvisoryRequest(request)).toBe(true);
  });
  it('redacts secrets before cloud, clips by Unicode characters and UTF-8 bytes, and sends metadata only', () => {
    const candidate = context({
      objective: '请完成研究 api_key=sk-abcdefghijklmnop。',
      resultText: `结果 Bearer top-secret-token; password=hunter2 ${'界🙂'.repeat(1_200)}`,
      toolUsage: {
        toolCallCount: 2,
        successfulToolCallCount: 1,
        failureCodes: ['TIMEOUT'],
        usedToolIds: ['web-search'],
        approvalOccurred: true,
      },
      artifacts: [
        {
          id: 'artifact-1',
          sha256: 'a'.repeat(64),
          kind: 'PUBLIC_RESULT',
          contentType: 'text/plain',
          validationStatus: 'PASS',
          contractId: 'answer-v1',
          contractVersion: '1',
          lineageCount: 2,
        },
      ],
      workflow: {
        stepType: 'RESEARCH',
        requiredCapabilities: ['WEB_ACCESS'],
        expectedOutputContract: { kind: 'SUMMARY', contractId: 'summary-v1' },
        validationStatus: 'PASS',
        reviewPolicy: 'REQUIRED',
      },
      deterministicFlags: {
        completionBoundary: 'SATISFIED',
        sideEffect: 'NONE',
        artifactValidation: 'PASS',
        reviewVerdict: 'PASS',
      },
    });
    const request = makeCompletionAdvisoryRequest(candidate);
    const state = request.state as unknown as {
      context: { objective: string };
      result: { excerpt: string; characters: number };
    };
    const serialized = JSON.stringify(request);

    expect(validateCompletionAdvisoryRequest(request)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThanOrEqual(
      COMPLETION_ADVISORY_POLICY.maxStateBytes,
    );
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      COMPLETION_ADVISORY_POLICY.maxRequestBytes,
    );
    expect([...state.context.objective].length).toBeLessThanOrEqual(
      COMPLETION_ADVISORY_POLICY.maxObjectiveCharacters,
    );
    expect(Buffer.byteLength(state.context.objective, 'utf8')).toBeLessThanOrEqual(
      COMPLETION_ADVISORY_POLICY.maxObjectiveBytes,
    );
    expect([...state.result.excerpt].length).toBeLessThanOrEqual(
      COMPLETION_ADVISORY_POLICY.maxResultExcerptCharacters,
    );
    expect(Buffer.byteLength(state.result.excerpt, 'utf8')).toBeLessThanOrEqual(
      COMPLETION_ADVISORY_POLICY.maxResultExcerptBytes,
    );
    expect(state.context.objective).toContain('[REDACTED]');
    expect(state.result.excerpt).toContain('[REDACTED]');
    expect(serialized).not.toContain('sk-abcdefghijklmnop');
    expect(serialized).not.toContain('top-secret-token');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('The candidate final result is ready.');
    expect(serialized).not.toContain('privateMemory');
    expect(serialized).not.toContain('toolOutput');
    expect(state.result.characters).toBeGreaterThan([...state.result.excerpt].length);
  });

  it('hashes the original candidate result while redacting the excerpt and receipt', async () => {
    const secret = 'sk-abcdefghijklmnop';
    const resultText = `候选结果 🙂 ${secret} 保留原文哈希。`;
    const candidate = context({ resultText });
    const request = makeCompletionAdvisoryRequest(candidate);
    const state = request.state as unknown as {
      result: { excerpt: string; characters: number; sha256: string };
    };
    const expectedHash = createHash('sha256').update(resultText, 'utf8').digest('hex');
    const gateway = makeGateway(result());
    const receipt = await new CompletionAdvisoryService(async () => gateway.gateway).assess(
      candidate,
    );

    expect(state.result.characters).toBe([...resultText].length);
    expect(state.result.sha256).toBe(expectedHash);
    expect(state.result.excerpt).toContain('[REDACTED]');
    expect(state.result.excerpt).not.toContain(secret);
    expect(JSON.stringify(request)).not.toContain(secret);
    expect(receipt.resultHash).toBe(expectedHash);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain(resultText);
  });

  it('rejects unknown request fields and request hash tampering', () => {
    const request = makeCompletionAdvisoryRequest(context());
    expect(validateCompletionAdvisoryRequest(request)).toBe(true);
    expect(
      validateCompletionAdvisoryRequest({
        ...request,
        runtimeId: 'runtime-1',
      } as unknown as DecisionRequest),
    ).toBe(false);
    expect(
      validateCompletionAdvisoryRequest({
        ...request,
        stateHash: '0'.repeat(64),
      } as DecisionRequest),
    ).toBe(false);
  });

  it('rejects context containing unallowlisted fields without invoking Jev', async () => {
    const evaluate = vi.fn();
    const service = new CompletionAdvisoryService(
      async () => ({ evaluate }) as unknown as DecisionGateway,
    );
    const unsafe = {
      ...context(),
      privateMemory: 'never send this',
    } as unknown as CompletionAdvisoryContext;
    const receipt = await service.assess(unsafe);

    expect(evaluate).not.toHaveBeenCalled();
    expect(receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    expect(receipt.reason).toBe('INVALID_CONTEXT');
    expect(JSON.stringify(receipt)).not.toContain('never send this');

    const malformedPhase = {
      ...context(),
      phase: null,
    } as unknown as CompletionAdvisoryContext;
    await expect(service.assess(malformedPhase)).resolves.toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      reason: 'INVALID_CONTEXT',
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('R5.5 completion advisory result validation', () => {
  it('accepts three strict choices and returns only advisory facts with trusted disposition', async () => {
    const candidate = context({
      objective: 'Private objective content must not appear in the receipt.',
      resultText: 'Private final result content must not appear in the receipt.',
    });
    const gateway = makeGateway(result(choices({ needs_review: 'YES' })));
    const receipt = await new CompletionAdvisoryService(async () => gateway.gateway).assess(
      candidate,
    );

    expect(gateway.evaluate).toHaveBeenCalledTimes(1);
    expect(receipt.mode).toBe('JEV');
    expect(receipt.choices).toEqual(choices({ needs_review: 'YES' }));
    expect(receipt.disposition).toBe('REVIEW_RECOMMENDED');
    expect(receipt.actorId).toBe('teammate-a');
    expect(receipt.phase).toBe('SOLO_FINAL');
    expect(receipt.stateHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.objectiveHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.resultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain('Private objective content');
    expect(JSON.stringify(receipt)).not.toContain('Private final result content');
    expect(Object.keys(receipt).sort()).toEqual(
      [
        'missionId',
        'runId',
        'actorId',
        'phase',
        'choices',
        'disposition',
        'mode',
        'reason',
        'errorCode',
        'stateHash',
        'objectiveHash',
        'resultHash',
        'policyVersion',
        'questionVersion',
        'stateBytes',
        'requestBytes',
        'responseBytes',
      ].sort(),
    );
  });

  it.each([
    ['wrong model', result(choices(), { model: 'jev-9.9.9' })],
    ['missing model', result(choices(), { model: undefined })],
    [
      'missing dimension',
      result({ needs_review: 'NO', objective_satisfied: 'YES' } as CompletionAdvisoryChoices),
    ],
    [
      'extra dimension',
      result({ ...choices(), create_mission: 'YES' } as unknown as CompletionAdvisoryChoices),
    ],
    [
      'unknown choice',
      result({ ...choices(), should_continue: 'MAYBE' } as unknown as CompletionAdvisoryChoices),
    ],
    ['rationale', result(choices(), { rationale: 'because' })],
    ['non-null selected action', result(choices(), { selectedAction: 'COMPLETE_MISSION' })],
    ['extra telemetry', result(choices(), { diagnosticTrace: 'extra' })],
    [
      'extra confidence dimension',
      result(choices(), {
        confidence: {
          needs_review: 0.9,
          objective_satisfied: 0.8,
          should_continue: 0.7,
          nextAction: 1,
        },
      }),
    ],
    [
      'invalid confidence',
      result(choices(), {
        confidence: { needs_review: Number.NaN, objective_satisfied: 0.8, should_continue: 0.7 },
      }),
    ],
    ['wrong provider', result(choices(), { provider: 'OTHER' })],
    [
      'oversized response',
      result(choices(), {
        diagnosticTrace: 'x'.repeat(COMPLETION_ADVISORY_POLICY.maxResponseBytes + 1),
      }),
    ],
  ])('falls back atomically for %s', async (_name, invalidResponse) => {
    const gateway = makeGateway(invalidResponse);
    const receipt = await new CompletionAdvisoryService(async () => gateway.gateway).assess(
      context(),
    );

    expect(receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    expect(receipt.reason).toBe('INVALID_RESPONSE');
    expect(receipt.errorCode).toBe('SCHEMA_MISMATCH');
    expect(receipt.choices).toEqual({
      needs_review: 'UNCERTAIN',
      objective_satisfied: 'UNCERTAIN',
      should_continue: 'UNCERTAIN',
    });
    expect(receipt.disposition).toBe('NO_ADVISORY');
  });

  it('records an oversized provider response as outside the fixed response budget', async () => {
    const gateway = makeGateway(
      result(choices(), {
        diagnosticTrace: 'x'.repeat(COMPLETION_ADVISORY_POLICY.maxResponseBytes + 1),
      }),
    );
    const receipt = await new CompletionAdvisoryService(async () => gateway.gateway).assess(
      context(),
    );

    expect(receipt.reason).toBe('INVALID_RESPONSE');
    expect(receipt.responseBytes).toBeGreaterThan(COMPLETION_ADVISORY_POLICY.maxResponseBytes);
  });

  it('uses only deterministic advisory dispositions and preserves contradictions as multiple concerns', async () => {
    const cases: Array<[CompletionAdvisoryChoices, string]> = [
      [choices(), 'NO_ADVISORY'],
      [choices({ needs_review: 'YES' }), 'REVIEW_RECOMMENDED'],
      [choices({ objective_satisfied: 'NO' }), 'OBJECTIVE_UNCERTAIN'],
      [choices({ objective_satisfied: 'NO', should_continue: 'YES' }), 'CONTINUE_RECOMMENDED'],
      [choices({ objective_satisfied: 'YES', should_continue: 'YES' }), 'MULTIPLE_CONCERNS'],
      [
        choices({ needs_review: 'YES', objective_satisfied: 'NO', should_continue: 'YES' }),
        'MULTIPLE_CONCERNS',
      ],
      [choices({ objective_satisfied: 'NO', should_continue: 'NO' }), 'OBJECTIVE_UNCERTAIN'],
    ];
    for (const [advisory, expectedDisposition] of cases) {
      const gateway = makeGateway(result(advisory));
      const receipt = await new CompletionAdvisoryService(async () => gateway.gateway).assess(
        context(),
      );
      expect(receipt.disposition).toBe(expectedDisposition);
      expect(receipt.mode).toBe('JEV');
    }
  });
});

describe('R5.5 fail-open behavior', () => {
  it('never dispatches after a gateway factory resolves beyond the advisory timeout', async () => {
    vi.useFakeTimers();
    try {
      const gateway = makeGateway(result());
      let resolveFactory!: (gateway: DecisionGateway) => void;
      const pending = new CompletionAdvisoryService(
        () =>
          new Promise<DecisionGateway>((resolve) => {
            resolveFactory = resolve;
          }),
      ).assess(context());
      await vi.advanceTimersByTimeAsync(COMPLETION_ADVISORY_POLICY.gatewayTimeoutMs);
      expect((await pending).reason).toBe('GATEWAY_TIMEOUT');
      resolveFactory(gateway.gateway);
      await vi.advanceTimersByTimeAsync(1);
      expect(gateway.evaluate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks execution freshness after the asynchronous gateway factory', async () => {
    const gateway = makeGateway(result());
    let active = true;
    let resolveFactory!: (gateway: DecisionGateway) => void;
    const pending = new CompletionAdvisoryService(
      () =>
        new Promise<DecisionGateway>((resolve) => {
          resolveFactory = resolve;
        }),
    ).assess(context(), () => active);
    await Promise.resolve();
    active = false;
    resolveFactory(gateway.gateway);
    expect((await pending).mode).toBe('DETERMINISTIC_FALLBACK');
    expect(gateway.evaluate).not.toHaveBeenCalled();
  });

  it('returns neutral choices when the gateway factory has no cloud/key gateway', async () => {
    const receipt = await new CompletionAdvisoryService(async () => null).assess(context());
    expect(receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    expect(receipt.reason).toBe('GATEWAY_UNAVAILABLE');
    expect(receipt.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(receipt.choices).toEqual({
      needs_review: 'UNCERTAIN',
      objective_satisfied: 'UNCERTAIN',
      should_continue: 'UNCERTAIN',
    });
    expect(receipt.disposition).toBe('NO_ADVISORY');
  });

  it('falls back after provider errors and bounded SDK error results', async () => {
    const thrown = new CompletionAdvisoryService(async () => ({
      evaluate: async () => {
        throw new Error('private SDK error text');
      },
    })).assess(context());
    const sdkError = makeGateway({
      provider: 'TYPESAFE',
      model: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 2,
      errorCode: 'TIMEOUT',
      answers: {},
      confidence: {},
      selectedAction: null,
    });
    const [thrownReceipt, sdkReceipt] = await Promise.all([
      thrown,
      new CompletionAdvisoryService(async () => sdkError.gateway).assess(context()),
    ]);

    expect(thrownReceipt.reason).toBe('GATEWAY_ERROR');
    expect(thrownReceipt.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(thrownReceipt)).not.toContain('private SDK error text');
    expect(sdkReceipt.reason).toBe('GATEWAY_TIMEOUT');
    expect(sdkReceipt.errorCode).toBe('TIMEOUT');
  });

  it('falls back when the single advisory call times out without retrying', async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(() => new Promise<DecisionResult>(() => undefined));
      const pending = new CompletionAdvisoryService(async () => ({ evaluate })).assess(context());
      await vi.advanceTimersByTimeAsync(COMPLETION_ADVISORY_POLICY.gatewayTimeoutMs);
      const receipt = await pending;

      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(receipt.reason).toBe('GATEWAY_TIMEOUT');
      expect(receipt.errorCode).toBe('TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });
});
