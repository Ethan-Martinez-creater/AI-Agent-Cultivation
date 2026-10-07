import { describe, expect, it, vi } from 'vitest';
import type { DecisionGateway, DecisionRequest, DecisionResult } from './r0-decision.js';
import {
  MEMORY_PRE_GATE_POLICY,
  MemoryPreGateContextError,
  MemoryPreGateService,
  buildMemoryEvidenceFacts,
  makeMemoryPreGateRequest,
  validateMemoryPreGateRequest,
  type MemoryPreGateContext,
  type MemoryPreGateExecutionContext,
  type MemoryPreGateSourceType,
} from './r5-2-memory-pre-gate.js';

const RAW_EVIDENCE = 'I prefer concise review summaries. PRIVATE_CHAT_BODY_9842';

function evidence(raw = RAW_EVIDENCE) {
  return buildMemoryEvidenceFacts(raw);
}

function execution(
  overrides: Partial<MemoryPreGateExecutionContext> = {},
): MemoryPreGateExecutionContext {
  return {
    objectiveSummary: 'Review the current source artifact for correctness.',
    stepType: 'REVIEW',
    requiredCapabilities: ['CODING'],
    inputArtifactSummaries: [{ id: 'artifact-1', kind: 'TEXT', name: 'source summary' }],
    expectedOutputContract: [
      {
        key: 'review',
        kind: 'JSON',
        contractId: 'review-v1',
        contractVersion: '1',
      },
    ],
    publicState: 'RUNNING',
    ...overrides,
  };
}

function context(
  overrides: Partial<MemoryPreGateContext> & { sourceType?: MemoryPreGateSourceType } = {},
): MemoryPreGateContext {
  return {
    ownerId: 'owner-private-47',
    sourceId: 'source-private-21',
    sourceType: 'CHAT_MESSAGE',
    trigger: 'USER_EXPLICIT',
    messageRole: 'user',
    ...evidence(),
    ...overrides,
  };
}

function answer(choice: 'RUN_EXTRACTION' | 'SKIP_EXTRACTION', confidence = 0.91): DecisionResult {
  return {
    answers: { extraction: choice },
    confidence: { extraction: confidence },
    selectedAction: null,
  };
}

function gatewayFor(result: unknown): {
  gateway: DecisionGateway;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn<(request: DecisionRequest) => Promise<DecisionResult>>(
    async () => result as DecisionResult,
  );
  return { gateway: { evaluate }, evaluate };
}

interface MutableRequestClone {
  [key: string]: unknown;
  state: Record<string, unknown>;
  questions: { extraction: Record<string, unknown> };
  inputSummary: Record<string, unknown>;
}

function cloneRequest(request: DecisionRequest): MutableRequestClone {
  return JSON.parse(JSON.stringify(request)) as MutableRequestClone;
}

describe('Memory Pre-Gate', () => {
  it('reduces raw evidence to fixed local facts without returning any text', () => {
    const facts = buildMemoryEvidenceFacts(RAW_EVIDENCE);

    expect(facts).toEqual({
      evidenceCharacters: RAW_EVIDENCE.length,
      semanticSignals: {
        durableStatement: true,
        questionOnly: false,
        codeOrStructured: false,
      },
    });
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_CHAT_BODY_9842');
    expect(buildMemoryEvidenceFacts('Could we review this?').semanticSignals).toMatchObject({
      questionOnly: true,
      durableStatement: false,
    });
    expect(buildMemoryEvidenceFacts('我偏好简短回复').semanticSignals).toMatchObject({
      durableStatement: true,
      questionOnly: false,
    });
    expect(buildMemoryEvidenceFacts('const answer = 42;').semanticSignals.codeOrStructured).toBe(
      true,
    );
  });

  it('builds a metadata-only chat request with a deterministic hash and strict shape', () => {
    const source = context();
    const request = makeMemoryPreGateRequest(source);
    const serialized = JSON.stringify(request);
    const state = request.state as {
      sourceType: string;
      trigger: string;
      messageRole: string;
      evidence: ReturnType<typeof buildMemoryEvidenceFacts>;
    };

    expect(validateMemoryPreGateRequest(request)).toBe(true);
    expect(request).toMatchObject({
      decisionType: 'MEMORY_EXTRACTION_NEED',
      policyVersion: MEMORY_PRE_GATE_POLICY.version,
      questionVersion: MEMORY_PRE_GATE_POLICY.questionVersion,
      questions: {
        extraction: {
          type: 'choice',
          criteria: {
            RUN_EXTRACTION: expect.any(String),
            SKIP_EXTRACTION: expect.any(String),
          },
        },
      },
      inputSummary: { candidateIds: [] },
    });
    expect(state).toEqual({
      sourceType: 'CHAT_MESSAGE',
      trigger: 'USER_EXPLICIT',
      messageRole: 'user',
      evidence: evidence(),
    });
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThanOrEqual(
      MEMORY_PRE_GATE_POLICY.maxStateBytes,
    );
    expect(serialized).not.toContain(RAW_EVIDENCE);
    expect(serialized).not.toContain('PRIVATE_CHAT_BODY_9842');
    expect(serialized).not.toContain(source.ownerId);
    expect(serialized).not.toContain(source.sourceId);
    expect(makeMemoryPreGateRequest(source).stateHash).toBe(request.stateHash);
  });

  it('accepts only the current bounded execution projection and redacts secret-like text', () => {
    const source = context({
      sourceType: 'WORKFLOW_STEP_RESULT',
      messageRole: undefined,
      execution: execution({
        objectiveSummary:
          'Review this artifact using API_KEY=sk_live_secret_0123456789 and Bearer abcdefghijklmnop.',
        inputArtifactSummaries: [
          { id: 'artifact-1', kind: 'TEXT', name: 'source api_key=ghp_12345678901234567890' },
        ],
      }),
    });
    const request = makeMemoryPreGateRequest(source);
    const serialized = JSON.stringify(request);
    const state = request.state as { execution: MemoryPreGateExecutionContext };

    expect(validateMemoryPreGateRequest(request)).toBe(true);
    expect(state.execution.objectiveSummary).not.toContain('sk_live_secret_0123456789');
    expect(state.execution.objectiveSummary).not.toContain('abcdefghijklmnop');
    expect(state.execution.inputArtifactSummaries?.[0]?.name).not.toContain(
      'ghp_12345678901234567890',
    );
    expect(state.execution.expectedOutputContract?.[0]?.contractVersion).toBe('1');
    expect(serialized).not.toContain('workflowHistory');
    expect(JSON.stringify(request.state)).not.toContain('instructions');
  });

  it('rejects forged provenance, unbounded metadata, and non-allowlisted private payloads', async () => {
    const gatewayFactory = vi.fn(async () => null);
    const service = new MemoryPreGateService(gatewayFactory);
    const forged = context({ ownerId: 'sk_live_private_012345678901' });

    await expect(service.evaluate(forged)).rejects.toBeInstanceOf(MemoryPreGateContextError);
    expect(gatewayFactory).not.toHaveBeenCalled();

    for (const key of [
      'conversationHistory',
      'workflowHistory',
      'fileBody',
      'toolOutput',
      'skillInstructions',
      'memoryDatabaseDump',
      'credential',
    ]) {
      expect(() =>
        makeMemoryPreGateRequest({
          ...context(),
          [key]: 'PRIVATE_PAYLOAD_MUST_NOT_CROSS',
        } as MemoryPreGateContext),
      ).toThrow(MemoryPreGateContextError);
    }
    expect(() =>
      makeMemoryPreGateRequest(
        context({
          sourceType: 'MISSION_RESULT',
          execution: undefined,
        }),
      ),
    ).toThrow(MemoryPreGateContextError);
    expect(() =>
      makeMemoryPreGateRequest(
        context({
          sourceType: 'WORKFLOW_STEP_RESULT',
          messageRole: undefined,
          execution: {
            ...execution(),
            workflowHistory: 'PRIVATE_HISTORY',
          } as MemoryPreGateExecutionContext,
        }),
      ),
    ).toThrow(MemoryPreGateContextError);
  });

  it('fits maximum Chinese execution metadata inside the total UTF-8 state budget', () => {
    const large = context({
      sourceType: 'WORKFLOW_STEP_RESULT',
      messageRole: undefined,
      execution: execution({
        objectiveSummary: '界'.repeat(600),
        inputArtifactSummaries: Array.from({ length: 6 }, (_, index) => ({
          id: `artifact-${index}`,
          kind: '种类'.repeat(16),
          name: '摘要'.repeat(32),
        })),
        expectedOutputContract: Array.from({ length: 6 }, (_, index) => ({
          key: `字段${index}`.repeat(20),
          kind: '种类'.repeat(16),
          contractId: '合同'.repeat(24),
          contractVersion: '版本'.repeat(16),
        })),
      }),
    });
    const request = makeMemoryPreGateRequest(large);
    const state = request.state as { execution: MemoryPreGateExecutionContext };

    expect(validateMemoryPreGateRequest(request)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(request.state), 'utf8')).toBeLessThanOrEqual(
      MEMORY_PRE_GATE_POLICY.maxStateBytes,
    );
    expect(state.execution.objectiveSummary).toBe('界'.repeat(600));
    expect(state.execution.inputArtifactSummaries).toBeUndefined();
    expect(state.execution.expectedOutputContract?.length).toBeLessThanOrEqual(4);
  });

  it('truncates oversized execution arrays to the documented item limits', () => {
    const request = makeMemoryPreGateRequest(
      context({
        sourceType: 'WORKFLOW_STEP_RESULT',
        messageRole: undefined,
        execution: execution({
          inputArtifactSummaries: Array.from({ length: 6 }, (_, index) => ({
            id: `artifact-${index}`,
            kind: 'TEXT',
            name: `summary-${index}`,
          })),
          expectedOutputContract: Array.from({ length: 6 }, (_, index) => ({
            key: `output-${index}`,
            kind: 'JSON',
          })),
          requiredCapabilities: [
            'CODING',
            'TOOL_USE',
            'GENERAL_REASONING',
            'LONG_CONTEXT_REASONING',
            'AGENTIC_EXECUTION',
            'VISUAL_UNDERSTANDING',
            'IMAGE_GENERATION',
            'IMAGE_EDITING',
            'VIDEO_GENERATION',
          ],
        }),
      }),
    );
    const state = request.state as { execution: MemoryPreGateExecutionContext };

    expect(state.execution.inputArtifactSummaries).toHaveLength(
      MEMORY_PRE_GATE_POLICY.maxArtifacts,
    );
    expect(state.execution.expectedOutputContract).toHaveLength(
      MEMORY_PRE_GATE_POLICY.maxOutputContracts,
    );
    expect(state.execution.requiredCapabilities).toHaveLength(
      MEMORY_PRE_GATE_POLICY.maxRequiredCapabilities,
    );
  });

  it('rejects altered schema, nested extras, stale hash, and oversized request state', () => {
    const request = makeMemoryPreGateRequest(context());

    const extraTopLevel = cloneRequest(request);
    extraTopLevel.rawContent = RAW_EVIDENCE;
    expect(validateMemoryPreGateRequest(extraTopLevel as unknown as DecisionRequest)).toBe(false);

    const extraQuestion = cloneRequest(request);
    extraQuestion.questions.extraction.rationale = 'not allowed';
    expect(validateMemoryPreGateRequest(extraQuestion as unknown as DecisionRequest)).toBe(false);

    const wrongVersion = cloneRequest(request);
    wrongVersion.questionVersion = 'old-question-version';
    expect(validateMemoryPreGateRequest(wrongVersion as unknown as DecisionRequest)).toBe(false);

    const staleHash = cloneRequest(request);
    staleHash.state.trigger = 'HARNESS';
    expect(validateMemoryPreGateRequest(staleHash as unknown as DecisionRequest)).toBe(false);

    const oversized = cloneRequest(request);
    oversized.state.execution = { objectiveSummary: '界'.repeat(1_400) };
    expect(validateMemoryPreGateRequest(oversized as unknown as DecisionRequest)).toBe(false);

    const extraSummary = cloneRequest(request);
    extraSummary.inputSummary.ownerId = 'forged-owner';
    expect(validateMemoryPreGateRequest(extraSummary as unknown as DecisionRequest)).toBe(false);
  });

  it('returns JEV RUN and SKIP decisions with bounded confidence and receipt facts', async () => {
    for (const choice of ['RUN_EXTRACTION', 'SKIP_EXTRACTION'] as const) {
      const { gateway, evaluate } = gatewayFor(answer(choice, 0.73));
      const receipt = await new MemoryPreGateService(async () => gateway).evaluate(context());

      expect(receipt).toMatchObject({
        sourceType: 'CHAT_MESSAGE',
        ownerId: 'owner-private-47',
        sourceId: 'source-private-21',
        trigger: 'USER_EXPLICIT',
        mode: 'JEV',
        decision: choice,
        confidence: 0.73,
        reason: 'JEV_DECISION',
        errorCode: null,
      });
      expect(Object.keys(receipt).sort()).toEqual([
        'confidence',
        'decision',
        'errorCode',
        'mode',
        'ownerId',
        'policyVersion',
        'questionVersion',
        'reason',
        'sourceId',
        'sourceType',
        'stateHash',
        'trigger',
      ]);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(receipt)).not.toContain(RAW_EVIDENCE);
    }
  });

  it('uses trigger-specific deterministic fallback when the gateway is not configured', async () => {
    const service = new MemoryPreGateService(async () => null);
    const userReceipt = await service.evaluate(context({ trigger: 'USER_EXPLICIT' }));
    const harnessReceipt = await service.evaluate(
      context({
        sourceType: 'MISSION_RESULT',
        trigger: 'HARNESS',
        messageRole: undefined,
        execution: execution({ stepType: 'TASK' }),
      }),
    );

    expect(userReceipt).toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      decision: 'RUN_EXTRACTION',
      confidence: null,
      reason: 'GATEWAY_UNAVAILABLE',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(harnessReceipt).toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      decision: 'SKIP_EXTRACTION',
      confidence: null,
      reason: 'GATEWAY_UNAVAILABLE',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(userReceipt.mode).not.toBe('JEV');
  });

  it('maps gateway errors and timeout to safe fallback codes without retaining raw errors', async () => {
    const gatewayFailure = new MemoryPreGateService(async () => {
      throw new Error('raw provider body contains PRIVATE_RESPONSE_SECRET');
    });
    const failed = await gatewayFailure.evaluate(context());
    expect(failed).toMatchObject({
      decision: 'RUN_EXTRACTION',
      mode: 'DETERMINISTIC_FALLBACK',
      reason: 'GATEWAY_ERROR',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_RESPONSE_SECRET');

    vi.useFakeTimers();
    try {
      const pendingGateway: DecisionGateway = {
        evaluate: () => new Promise<DecisionResult>(() => undefined),
      };
      const pending = new MemoryPreGateService(async () => pendingGateway).evaluate(context());
      await vi.advanceTimersByTimeAsync(MEMORY_PRE_GATE_POLICY.gatewayTimeoutMs);
      await expect(pending).resolves.toMatchObject({
        decision: 'RUN_EXTRACTION',
        mode: 'DETERMINISTIC_FALLBACK',
        reason: 'GATEWAY_TIMEOUT',
        errorCode: 'TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back on malformed, unknown, extra, and oversized provider results', async () => {
    const invalidResults: unknown[] = [
      { ...answer('SKIP_EXTRACTION'), answers: { extraction: 'DELETE_MEMORY' } },
      { ...answer('SKIP_EXTRACTION'), selectedAction: 'RUN_EXTRACTION' },
      { ...answer('SKIP_EXTRACTION'), confidence: { extraction: 1.01 } },
      { ...answer('SKIP_EXTRACTION'), rationale: 'private chain of thought' },
      { ...answer('SKIP_EXTRACTION'), ownerId: 'forged-owner' },
      {
        ...answer('SKIP_EXTRACTION'),
        model: `jev-${'x'.repeat(MEMORY_PRE_GATE_POLICY.maxResponseBytes)}`,
      },
    ];

    for (const invalid of invalidResults) {
      const { gateway } = gatewayFor(invalid);
      const receipt = await new MemoryPreGateService(async () => gateway).evaluate(context());
      expect(receipt).toMatchObject({
        mode: 'DETERMINISTIC_FALLBACK',
        decision: 'RUN_EXTRACTION',
        confidence: null,
        reason: 'INVALID_RESPONSE',
        errorCode: 'SCHEMA_MISMATCH',
      });
    }
  });

  it('maps explicit provider error results to fallback rather than a JEV decision', async () => {
    const { gateway } = gatewayFor({
      answers: {},
      confidence: {},
      selectedAction: null,
      errorCode: 'PROVIDER_UNAVAILABLE',
      provider: 'TYPESAFE',
      model: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 42,
    });
    const receipt = await new MemoryPreGateService(async () => gateway).evaluate(context());

    expect(receipt).toMatchObject({
      mode: 'DETERMINISTIC_FALLBACK',
      decision: 'RUN_EXTRACTION',
      reason: 'GATEWAY_ERROR',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
  });
});
