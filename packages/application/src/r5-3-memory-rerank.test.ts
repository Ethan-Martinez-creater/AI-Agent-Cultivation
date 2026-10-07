import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gate2MemoryRecord } from './gate2-memory-service.js';
import type { DecisionGateway, DecisionRequest, DecisionResult } from './r0-decision.js';
import {
  MEMORY_RERANK_POLICY,
  MemoryRerankService,
  makeMemoryRerankRequest,
  validateMemoryRerankRequest,
} from './r5-3-memory-rerank.js';

function memory(id: string, overrides: Partial<Gate2MemoryRecord> = {}): Gate2MemoryRecord {
  return {
    id,
    ownerType: 'TEAMMATE',
    ownerId: 'teammate-a',
    memoryType: 'FACT',
    content: `content for ${id}`,
    summary: `summary for ${id}`,
    sourceType: 'MANUAL',
    sourceId: null,
    sourceConversationId: null,
    sourceMessageId: null,
    importance: 0.5,
    confidence: 1,
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

function success(memories: Array<{ memoryId: string; score: number }>): DecisionResult {
  return { answers: { memories }, confidence: {}, selectedAction: null };
}

function gateway(
  result: DecisionResult | ((request: DecisionRequest) => DecisionResult | Promise<DecisionResult>),
) {
  const evaluate = vi.fn(async (request: DecisionRequest) =>
    typeof result === 'function' ? await result(request) : result,
  );
  return { gateway: { evaluate } satisfies DecisionGateway, evaluate };
}

describe('R5.3 Memory Rerank request boundary', () => {
  it('builds a strict numeric Noul request with redacted, normalized, UTF-8 bounded text', () => {
    const request = makeMemoryRerankRequest({
      query: '  ＡPI_KEY=sk-abcdefghijklmnop  résumé\nneedles  ',
      candidates: [
        { id: 'memory-1', memoryType: 'FACT', text: '  Bearer abc.def secret=private phrase  ' },
      ],
    });
    const state = request.state as {
      query: string;
      candidates: Array<{ id: string; text: string }>;
    };
    expect(request.decisionType).toBe('MEMORY_RELEVANCE');
    expect(state.query).toContain('[REDACTED]');
    expect(state.query).toContain('résumé needles');
    expect(state.candidates[0]?.text).toContain('[REDACTED]');
    expect(state.query).not.toContain('sk-abcdefghijklmnop');
    expect(state.candidates[0]?.text).not.toContain('abc.def');
    expect(request.questions).toEqual({
      'memory.memory-1': expect.objectContaining({ type: 'noul' }),
    });
    expect(validateMemoryRerankRequest(request)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThanOrEqual(
      MEMORY_RERANK_POLICY.maxStateBytes,
    );
    expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(
      MEMORY_RERANK_POLICY.maxRequestBytes,
    );
  });

  it('clips Unicode by code point and UTF-8 byte caps and trims or omits tail candidates to fit budgets', () => {
    const request = makeMemoryRerankRequest({
      query: '🧠'.repeat(1_000),
      candidates: Array.from({ length: 20 }, (_, index) => ({
        id: `memory-${String(index).padStart(2, '0')}`,
        memoryType: 'FACT' as const,
        text: '界'.repeat(240),
      })),
    });
    const state = request.state as {
      query: string;
      candidates: Array<{ id: string; text: string }>;
    };
    expect(state.query.length).toBeLessThanOrEqual(MEMORY_RERANK_POLICY.maxQueryCharacters);
    expect(Buffer.byteLength(state.query, 'utf8')).toBeLessThanOrEqual(
      MEMORY_RERANK_POLICY.maxQueryBytes,
    );
    expect(state.candidates.length).toBeLessThanOrEqual(MEMORY_RERANK_POLICY.maxShortlist);
    expect(state.candidates.every(({ text }) => [...text].length <= 240)).toBe(true);
    expect(
      state.candidates.every(
        ({ text }) => Buffer.byteLength(text, 'utf8') <= MEMORY_RERANK_POLICY.maxCandidateTextBytes,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThanOrEqual(
      MEMORY_RERANK_POLICY.maxStateBytes,
    );
  });

  it('rejects unknown request, state, candidate, question, hash, and question-map fields', () => {
    const request = makeMemoryRerankRequest({
      query: 'q',
      candidates: [{ id: 'memory-a', memoryType: 'FACT', text: 'summary' }],
    });
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(request));
    const mutations: Array<(copy: Record<string, unknown>) => void> = [
      (copy) => (copy.extra = true),
      (copy) => ((copy.state as Record<string, unknown>).extra = true),
      (copy) =>
        ((copy.state as { candidates: Array<Record<string, unknown>> }).candidates[0]!.extra =
          true),
      (copy) =>
        ((copy.questions as Record<string, Record<string, unknown>>)['memory.memory-a']!.criteria =
          {}),
      (copy) => (copy.stateHash = '0'.repeat(64)),
      (copy) => ((copy.questions as Record<string, unknown>)['memory.other'] = { type: 'noul' }),
    ];
    for (const mutate of mutations) {
      const copy = clone();
      mutate(copy);
      expect(validateMemoryRerankRequest(copy as unknown as DecisionRequest)).toBe(false);
    }
  });
});

describe('R5.3 MemoryRerankService', () => {
  beforeEach(() => vi.useRealTimers());

  it('rechecks owner, ACTIVE status, and expiry before creating the Jev request', async () => {
    const { gateway: decisionGateway, evaluate } = gateway((request) => {
      const state = request.state as { candidates: Array<{ id: string }> };
      return success(state.candidates.map(({ id }) => ({ memoryId: id, score: 0.5 })));
    });
    const service = new MemoryRerankService(async () => decisionGateway);
    const result = await service.rank({
      teammateId: 'teammate-a',
      query: 'current task',
      candidates: [
        memory('owned'),
        memory('foreign', { ownerId: 'teammate-b' }),
        memory('proposed', { status: 'PROPOSED' }),
        memory('rejected', { status: 'REJECTED' }),
        memory('archived', { status: 'ARCHIVED' }),
        memory('expired', { expiresAt: '2000-01-01T00:00:00.000Z' }),
      ],
    });
    const request = evaluate.mock.calls[0]?.[0];
    const state = request?.state as { candidates: Array<{ id: string }> };
    expect(state.candidates.map(({ id }) => id)).toEqual(['owned']);
    expect(result.orderedIds).toEqual(['owned']);
    expect(result.receipt.candidateIds).toEqual(['owned']);
  });

  it('prefers summary, falls back to bounded content excerpt, and receipts only lengths and hashes', async () => {
    const { gateway: decisionGateway } = gateway((request) => {
      const state = request.state as { candidates: Array<{ id: string }> };
      return success(state.candidates.map(({ id }) => ({ memoryId: id, score: 0.8 })));
    });
    const service = new MemoryRerankService(async () => decisionGateway);
    const result = await service.rank({
      teammateId: 'teammate-a',
      query: 'private query phrase',
      candidates: [
        memory('summary', {
          summary: 'summary phrase',
          content: 'content phrase must not be selected',
        }),
        memory('excerpt', { summary: '  ', content: '  content excerpt phrase  ' }),
      ],
    });
    expect(result.receipt.candidateTextFacts).toEqual([
      expect.objectContaining({ memoryId: 'summary', source: 'SUMMARY' }),
      expect.objectContaining({ memoryId: 'excerpt', source: 'CONTENT_EXCERPT' }),
    ]);
    expect(JSON.stringify(result.receipt)).not.toContain('private query phrase');
    expect(JSON.stringify(result.receipt)).not.toContain('content excerpt phrase');
    expect(result.receipt.queryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      result.receipt.candidateTextFacts.every(({ textHash }) => /^[a-f0-9]{64}$/u.test(textHash)),
    ).toBe(true);
  });

  it('uses relevance score descending, then original baseline order for stable ties', async () => {
    const { gateway: decisionGateway } = gateway(
      success([
        { memoryId: 'memory-c', score: 0.9 },
        { memoryId: 'memory-a', score: 0.9 },
        { memoryId: 'memory-b', score: 0.4 },
      ]),
    );
    const service = new MemoryRerankService(async () => decisionGateway);
    const result = await service.rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [memory('memory-a'), memory('memory-b'), memory('memory-c')],
    });
    expect(result.orderedIds).toEqual(['memory-a', 'memory-c', 'memory-b']);
    expect(result.receipt.mode).toBe('JEV');
    expect(result.receipt.reason).toBe('JEV_RERANKED');
    expect(result.receipt.scores).toEqual([
      { memoryId: 'memory-c', score: 0.9 },
      { memoryId: 'memory-a', score: 0.9 },
      { memoryId: 'memory-b', score: 0.4 },
    ]);
  });

  it.each([
    [
      'unknown ID',
      (ids: string[]) => [
        { memoryId: 'unknown', score: 0.9 },
        ...ids.slice(1).map((memoryId) => ({ memoryId, score: 0.5 })),
      ],
    ],
    [
      'foreign ID',
      (ids: string[]) => [
        { memoryId: 'foreign-memory', score: 0.9 },
        ...ids.slice(1).map((memoryId) => ({ memoryId, score: 0.5 })),
      ],
    ],
    [
      'duplicate ID',
      (ids: string[]) => [
        { memoryId: ids[0]!, score: 0.9 },
        { memoryId: ids[0]!, score: 0.8 },
      ],
    ],
    [
      'too many answers',
      (ids: string[]) =>
        Array.from({ length: 13 }, (_, index) => ({
          memoryId: ids[index % ids.length]!,
          score: 0.5,
        })),
    ],
    [
      'NaN score',
      (ids: string[]) =>
        ids.map((memoryId, index) => ({ memoryId, score: index === 0 ? Number.NaN : 0.5 })),
    ],
    [
      'infinite score',
      (ids: string[]) =>
        ids.map((memoryId, index) => ({
          memoryId,
          score: index === 0 ? Number.POSITIVE_INFINITY : 0.5,
        })),
    ],
    [
      'score below zero',
      (ids: string[]) =>
        ids.map((memoryId, index) => ({ memoryId, score: index === 0 ? -0.01 : 0.5 })),
    ],
    [
      'score above one',
      (ids: string[]) =>
        ids.map((memoryId, index) => ({ memoryId, score: index === 0 ? 1.01 : 0.5 })),
    ],
  ])('falls back in baseline order for %s', async (_name, buildScores) => {
    const scores = buildScores(['a', 'b']);
    const { gateway: decisionGateway } = gateway({
      answers: { memories: scores },
      confidence: {},
      selectedAction: null,
    } as unknown as DecisionResult);
    const service = new MemoryRerankService(async () => decisionGateway);
    const result = await service.rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [memory('a'), memory('b')],
    });
    expect(result.orderedIds).toEqual(['a', 'b']);
    expect(result.receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    expect(result.receipt.reason).toBe('INVALID_RESPONSE');
  });

  it.each([
    [
      'extra answer entry field',
      (ids: string[]) => ({
        memories: ids.map((memoryId) => ({ memoryId, score: 0.5, rationale: 'free text' })),
      }),
    ],
    [
      'extra answer key',
      (ids: string[]) => ({
        memories: ids.map((memoryId) => ({ memoryId, score: 0.5 })),
        rationale: 'free text',
      }),
    ],
  ])('rejects %s and falls back', async (_name, answers) => {
    const { gateway: decisionGateway } = gateway({
      answers: answers(['a', 'b']),
      confidence: {},
      selectedAction: null,
    } as unknown as DecisionResult);
    const service = new MemoryRerankService(async () => decisionGateway);
    const result = await service.rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [memory('a'), memory('b')],
    });
    expect(result.orderedIds).toEqual(['a', 'b']);
    expect(result.receipt.reason).toBe('INVALID_RESPONSE');
  });

  it('rejects selectedAction, nonempty confidence, and oversized telemetry responses', async () => {
    const responses: DecisionResult[] = [
      {
        ...success([
          { memoryId: 'a', score: 0.8 },
          { memoryId: 'b', score: 0.7 },
        ]),
        selectedAction: 'a',
      },
      {
        ...success([
          { memoryId: 'a', score: 0.8 },
          { memoryId: 'b', score: 0.7 },
        ]),
        confidence: { extra: 0.5 },
      },
      {
        ...success([
          { memoryId: 'a', score: 0.8 },
          { memoryId: 'b', score: 0.7 },
        ]),
        model: 'x'.repeat(MEMORY_RERANK_POLICY.maxResponseBytes + 1),
      },
    ];
    for (const response of responses) {
      const { gateway: decisionGateway } = gateway(response);
      const result = await new MemoryRerankService(async () => decisionGateway).rank({
        teammateId: 'teammate-a',
        query: 'q',
        candidates: [memory('a'), memory('b')],
      });
      expect(result.orderedIds).toEqual(['a', 'b']);
      expect(result.receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    }
  });

  it('uses deterministic baseline when no gateway or no candidates are available', async () => {
    const gatewayFactory = vi.fn(async () => null);
    const service = new MemoryRerankService(gatewayFactory);
    const fallback = await service.rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [memory('b'), memory('a')],
    });
    expect(fallback.orderedIds).toEqual(['b', 'a']);
    expect(fallback.receipt.reason).toBe('GATEWAY_UNAVAILABLE');
    expect(gatewayFactory).toHaveBeenCalledOnce();

    const emptyFactory = vi.fn(async () => null);
    const empty = await new MemoryRerankService(emptyFactory).rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [],
    });
    expect(empty.orderedIds).toEqual([]);
    expect(empty.receipt.reason).toBe('NO_CANDIDATES');
    expect(emptyFactory).not.toHaveBeenCalled();
  });

  it('keeps the deterministic baseline if a bounded provider request cannot be built', async () => {
    const changingCandidate = memory('a');
    let memoryTypeReads = 0;
    Object.defineProperty(changingCandidate, 'memoryType', {
      get: () => (memoryTypeReads++ === 0 ? 'FACT' : 'INVALID'),
    });
    const gatewayFactory = vi.fn(async () => gateway(success([])).gateway);

    const result = await new MemoryRerankService(gatewayFactory).rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [changingCandidate],
    });

    expect(result.orderedIds).toEqual(['a']);
    expect(result.receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    expect(result.receipt.reason).toBe('GATEWAY_ERROR');
    expect(result.receipt.errorCode).toBe('INVALID_REQUEST');
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it('falls back on network errors and enforces the fixed timeout without retry', async () => {
    const networkGateway = gateway(() => {
      throw new Error('private provider body');
    });
    const network = await new MemoryRerankService(async () => networkGateway.gateway).rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [memory('a'), memory('b')],
    });
    expect(network.orderedIds).toEqual(['a', 'b']);
    expect(network.receipt.reason).toBe('GATEWAY_ERROR');
    expect(JSON.stringify(network.receipt)).not.toContain('private provider body');
    expect(networkGateway.evaluate).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    const hangingFactory = vi.fn(async () => new Promise<DecisionGateway>(() => {}));
    const pending = new MemoryRerankService(hangingFactory).rank({
      teammateId: 'teammate-a',
      query: 'q',
      candidates: [memory('a'), memory('b')],
    });
    await vi.advanceTimersByTimeAsync(MEMORY_RERANK_POLICY.gatewayTimeoutMs);
    const timedOut = await pending;
    expect(timedOut.orderedIds).toEqual(['a', 'b']);
    expect(timedOut.receipt.reason).toBe('GATEWAY_TIMEOUT');
    expect(hangingFactory).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each(['TIMEOUT', 'PROVIDER_UNAVAILABLE', 'SCHEMA_MISMATCH', 'INVALID_REQUEST'] as const)(
    'maps normalized gateway error %s to deterministic fallback',
    async (errorCode) => {
      const { gateway: decisionGateway } = gateway({
        answers: {},
        confidence: {},
        selectedAction: null,
        errorCode,
      });
      const result = await new MemoryRerankService(async () => decisionGateway).rank({
        teammateId: 'teammate-a',
        query: 'q',
        candidates: [memory('a'), memory('b')],
      });
      expect(result.orderedIds).toEqual(['a', 'b']);
      expect(result.receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    },
  );
});
