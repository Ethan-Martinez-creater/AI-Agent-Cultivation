import { describe, expect, it, vi } from 'vitest';
import { MemoryRerankService } from './r5-3-memory-rerank.js';
import { PromptComposer } from './prompt-composer.js';
import type { DecisionRequest, DecisionResult } from './r0-decision.js';
import type { ProviderConfig, RuntimeProfile, Teammate, UsageRecord } from '@cultivation/domain';
import type { EmbeddingGateway, MemoryCandidateExtractor } from './index.js';
import {
  Gate2MemoryService,
  type Gate2MemoryRecord,
  type Gate2MemoryStore,
} from './gate2-memory-service.js';
import { Gate2HybridMemoryService, type VectorMemoryStore } from './gate2-hybrid-memory-service.js';

function fixture(failQuery = false) {
  const rows = new Map<string, Gate2MemoryRecord>();
  const usage: UsageRecord[] = [];
  const savedEmbeddings: string[] = [];
  const runtime = {
    id: 'embedding-runtime',
    providerId: 'provider',
    modelId: 'embed-model',
  } as RuntimeProfile;
  const provider = { id: 'provider', kind: 'OPENAI', enabled: true } as ProviderConfig;
  const gate1 = {
    getTeammate: (id: string) => ({ id, status: 'ACTIVE' }) as Teammate,
    getRuntimeProfile: (id: string) => (id === runtime.id ? runtime : null),
    getModelBinding: () => null,
    hasValidModelBinding: () => false,
    getProvider: (id: string) => (id === provider.id ? provider : null),
    getConversation: () => null,
    listMessages: () => [],
    saveUsage: (record: UsageRecord) => {
      usage.push(record);
    },
  };
  const store: Gate2MemoryStore = {
    getMemory: (id) => rows.get(id) ?? null,
    listMemories: () => [...rows.values()], // hostile adapter
    saveMemory: (record) => {
      rows.set(record.id, record);
    },
    searchActiveMemories: () => [...rows.values()], // hostile adapter
  };
  const extractor: MemoryCandidateExtractor = {
    extractCandidates: async () => ({
      candidates: [],
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    }),
  };
  const memories = new Gate2MemoryService(gate1, store, extractor);
  let configured: string | null = null;
  const vectors: VectorMemoryStore = {
    available: true,
    getRuntimeProfileId: () => configured,
    setRuntimeProfileId: (id) => {
      configured = id;
    },
    hasCurrentEmbedding: () => false,
    hasScopedEmbeddings: () => true,
    saveEmbedding: (input) => {
      savedEmbeddings.push(input.memoryId);
    },
    deleteMemoryEmbeddings: () => undefined,
    searchScoped: () => [...rows.keys()].map((memoryId) => ({ memoryId, distance: 0 })), // hostile adapter
  };
  const gateway: EmbeddingGateway = {
    embed: async () => {
      if (failQuery) throw new Error('provider failure with secret');
      return {
        vector: [1, 0],
        usage: {
          inputTokens: 3,
          outputTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
      };
    },
  };
  const hybrid = new Gate2HybridMemoryService(gate1, memories, vectors, gateway);
  return {
    memories,
    hybrid,
    rows,
    usage,
    savedEmbeddings,
    vectors,
    store,
    extractor,
    embeddings: gateway,
  };
}

describe('Gate 2 hybrid retrieval', () => {
  it('rechecks Teammate scope even when vector and lexical adapters return another owner', async () => {
    const { memories, hybrid, usage } = fixture();
    const a = memories.createManual('a', {
      memoryType: 'FACT',
      content: 'alpha tea',
      summary: '',
      importance: 0.8,
    });
    memories.createManual('b', {
      memoryType: 'FACT',
      content: 'beta secret',
      summary: '',
      importance: 0.8,
    });
    hybrid.configure('embedding-runtime');
    expect((await hybrid.retrieve('a', 'tea')).map((row) => row.id)).toEqual([a.id]);
    expect(usage).toMatchObject([
      {
        teammateId: 'a',
        runtimeProfileId: 'embedding-runtime',
        inputTokens: 3,
        outputTokens: null,
      },
    ]);
  });

  it('keeps FTS5 results usable when embedding is absent or fails', async () => {
    const { memories, hybrid, usage } = fixture(true);
    const a = memories.createManual('a', {
      memoryType: 'FACT',
      content: 'tea',
      summary: '',
      importance: 0.8,
    });
    expect((await hybrid.retrieve('a', 'tea')).map((row) => row.id)).toEqual([a.id]);
    expect(usage).toHaveLength(0);
    hybrid.configure('embedding-runtime');
    expect((await hybrid.retrieve('a', 'tea')).map((row) => row.id)).toEqual([a.id]);
    expect(usage[0]).toMatchObject({ teammateId: 'a', inputTokens: null, outputTokens: null });
  });

  it('indexes only reviewed active memories and attributes embedding usage to the owner and configured runtime', async () => {
    const { memories, hybrid, usage, savedEmbeddings } = fixture();
    const a = memories.createManual('a', {
      memoryType: 'FACT',
      content: 'alpha tea',
      summary: '',
      importance: 0.8,
    });
    const b = memories.createManual('b', {
      memoryType: 'FACT',
      content: 'beta secret',
      summary: '',
      importance: 0.8,
    });
    hybrid.configure('embedding-runtime');
    expect(await hybrid.reindex('a')).toEqual({ indexed: 1, total: 1 });
    expect(savedEmbeddings).toEqual([a.id]);
    expect(savedEmbeddings).not.toContain(b.id);
    expect(usage[0]).toMatchObject({
      teammateId: 'a',
      runtimeProfileId: 'embedding-runtime',
      provider: 'provider',
      model: 'embed-model',
      inputTokens: 3,
      outputTokens: null,
    });
    memories.archive('a', a.id);
    await hybrid.onMemoryChanged(memories.list('a')[0]!);
    expect((await hybrid.retrieve('a', 'alpha')).map((row) => row.id)).toEqual([]);
  });
});

function rerankFixture() {
  const f = fixture();
  for (const memoryId of ['a', 'b', 'c', 'd', 'e']) {
    const created = f.memories.createManual('owner-a', {
      memoryType: 'FACT',
      content: `release ${memoryId}`,
      summary: `release ${memoryId}`,
      importance: 0.8,
    });
    f.rows.delete(created.id);
    f.rows.set(memoryId, { ...created, id: memoryId });
  }
  f.store.searchActiveMemories = () => ['a', 'b', 'c'].map((id) => f.rows.get(id)!);
  f.vectors.searchScoped = () =>
    ['c', 'd', 'a', 'e'].map((memoryId) => ({ memoryId, distance: 0 }));
  f.hybrid.configure('embedding-runtime');
  return f;
}

function scores(request: DecisionRequest): DecisionResult {
  return {
    answers: {
      memories: request.inputSummary.candidateIds.map((memoryId) => ({
        memoryId,
        score: memoryId === 'e' ? 1 : 0.1,
      })),
    },
    confidence: {},
    selectedAction: null,
  };
}

describe('R5.3 shared retrieval integration', () => {
  it('keeps the local query while sending only the trusted task query to cloud rerank', async () => {
    const f = rerankFixture();
    const lexical = vi.spyOn(f.store, 'searchActiveMemories');
    const embed = vi.spyOn(f.embeddings, 'embed');
    const evaluate = vi.fn(async (request: DecisionRequest) => scores(request));
    f.hybrid.attachMemoryRerank(new MemoryRerankService(async () => ({ evaluate })));
    const localQuery = 'release SYNTHESIS_ARTIFACT_BODY_SENTINEL TOOL_OUTPUT_SENTINEL';
    await f.hybrid.retrieve('owner-a', localQuery, 'release');
    expect(lexical).toHaveBeenCalledWith('TEAMMATE', 'owner-a', localQuery, 6);
    expect(embed).toHaveBeenCalledWith(expect.objectContaining({ text: localQuery }));
    expect(evaluate.mock.calls[0]![0].state.query).toBe('release');
    expect(JSON.stringify(evaluate.mock.calls[0]![0])).not.toMatch(/BODY_SENTINEL|OUTPUT_SENTINEL/);
    f.hybrid.attachMemoryRerank(new MemoryRerankService(async () => null));
    expect(
      (await f.hybrid.retrieve('owner-a', localQuery, 'release')).map((memory) => memory.id),
    ).toEqual(['a', 'c', 'b', 'd', 'e']);
  });
  it('preserves the approved R5.2 golden fusion order when Cloud/key is unavailable', async () => {
    const f = rerankFixture();
    const factory = vi.fn(async () => null);
    f.hybrid.attachMemoryRerank(new MemoryRerankService(factory));
    const result = await f.hybrid.retrieveWithReceipt('owner-a', 'release');
    // R5.2: reciprocal rank 1/(60+rank), stable lexical then vector insertion ties.
    expect(result.memories.map((memory) => memory.id)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(result.receipt.mode).toBe('DETERMINISTIC_FALLBACK');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('filters hostile lexical/vector candidates before Jev and before the final prompt', async () => {
    const f = rerankFixture();
    const base = f.rows.get('a')!;
    for (const [id, change] of [
      ['foreign', { ownerId: 'owner-b' }],
      ['proposed', { status: 'PROPOSED' }],
      ['rejected', { status: 'REJECTED' }],
      ['archived', { status: 'ARCHIVED' }],
      ['expired', { expiresAt: '2000-01-01T00:00:00.000Z' }],
      ['invalid-expiry', { expiresAt: 'not-a-date' }],
    ] as const)
      f.rows.set(id, { ...base, ...change, id });
    f.store.searchActiveMemories = () => [...f.rows.values()];
    f.vectors.searchScoped = () =>
      [...f.rows.keys()].map((memoryId) => ({ memoryId, distance: 0 }));
    const evaluate = vi.fn(async (request: DecisionRequest) => scores(request));
    f.hybrid.attachMemoryRerank(new MemoryRerankService(async () => ({ evaluate })));
    const result = await f.hybrid.retrieve('owner-a', 'release');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]![0].inputSummary.candidateIds.slice().sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(result.map((memory) => memory.id)).toEqual(['e', 'a', 'b', 'c', 'd']);
    const prompt = new PromptComposer().compose({
      platformPolicy: 'policy',
      teammate: { id: 'owner-a', name: 'A', identityPrompt: '', behaviorPrompt: '' },
      relevantMemories: result,
      skills: [],
      skillAssignments: [],
      conversationContext: [],
    });
    expect(
      JSON.parse(prompt.sections.relevantMemory.split('\n')[1]!).map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual(result.map((memory) => memory.id));
    expect(prompt.sections.relevantMemory).not.toMatch(
      /foreign|proposed|rejected|archived|expired/,
    );
  });

  it.each(['archive', 'expire', 'owner', 'reject', 'delete'] as const)(
    'rereads %s changes made during the Jev await before injecting Memory',
    async (change) => {
      const f = rerankFixture();
      const evaluate = vi.fn(async (request: DecisionRequest) => {
        const old = f.rows.get('e')!;
        if (change === 'delete') f.rows.delete('e');
        else
          f.rows.set('e', {
            ...old,
            ...(change === 'archive' ? { status: 'ARCHIVED' } : {}),
            ...(change === 'reject' ? { status: 'REJECTED' } : {}),
            ...(change === 'owner' ? { ownerId: 'owner-b' } : {}),
            ...(change === 'expire' ? { expiresAt: '2000-01-01T00:00:00.000Z' } : {}),
          });
        return scores(request);
      });
      f.hybrid.attachMemoryRerank(new MemoryRerankService(async () => ({ evaluate })));
      const result = await f.hybrid.retrieve('owner-a', 'release');
      expect(result.map((memory) => memory.id)).toEqual(['a', 'c', 'b', 'd']);
      expect(result).not.toContainEqual(expect.objectContaining({ id: 'e' }));
    },
  );

  it('a normal retrieval does not extract candidates or write Memory rows', async () => {
    const f = rerankFixture();
    const extractor = vi.spyOn(f.extractor, 'extractCandidates');
    const rowCount = f.rows.size;
    await f.hybrid.retrieve('owner-a', 'release');
    expect(f.rows.size).toBe(rowCount);
    expect(extractor).not.toHaveBeenCalled();
  });

  it('PromptComposer retains ordering and its own owner/status/expiry boundary', () => {
    const f = rerankFixture();
    const base = f.rows.get('a')!;
    const prompt = new PromptComposer().compose({
      platformPolicy: 'policy',
      teammate: { id: 'owner-a', name: 'A', identityPrompt: '', behaviorPrompt: '' },
      relevantMemories: [
        f.rows.get('e')!,
        { ...base, ownerId: 'owner-b', id: 'foreign' },
        { ...base, status: 'ARCHIVED', id: 'archived' },
        { ...base, expiresAt: '2000-01-01T00:00:00.000Z', id: 'expired' },
        base,
      ],
      skills: [],
      skillAssignments: [],
      conversationContext: [],
    });
    expect(
      JSON.parse(prompt.sections.relevantMemory.split('\n')[1]!).map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual(['e', 'a']);
  });
});
