import { describe, expect, it } from 'vitest';
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
  return { memories, hybrid, rows, usage, savedEmbeddings };
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
