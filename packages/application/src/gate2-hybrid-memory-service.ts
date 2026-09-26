import { createHash, randomUUID } from 'node:crypto';
import type { ProviderConfig, RuntimeProfile, UsageRecord } from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type { EmbeddingGateway, ModelUsage } from './index.js';
import type { Gate2MemoryRecord } from './gate2-memory-service.js';
import { Gate2MemoryService } from './gate2-memory-service.js';

export interface VectorMemoryStore {
  readonly available: boolean;
  getRuntimeProfileId(): string | null;
  setRuntimeProfileId(id: string | null): void;
  hasCurrentEmbedding(
    memoryId: string,
    runtimeProfileId: string,
    modelId: string,
    hash: string,
  ): boolean;
  hasScopedEmbeddings(teammateId: string, runtimeProfileId: string, modelId: string): boolean;
  saveEmbedding(input: {
    memoryId: string;
    runtimeProfileId: string;
    modelId: string;
    contentHash: string;
    vector: readonly number[];
  }): void;
  deleteMemoryEmbeddings(memoryId: string): void;
  searchScoped(input: {
    teammateId: string;
    runtimeProfileId: string;
    modelId: string;
    vector: readonly number[];
    limit: number;
  }): Array<{ memoryId: string; distance: number }>;
}

export interface EmbeddingSettings {
  available: boolean;
  runtimeProfileId: string | null;
}

type RuntimeStore = {
  getRuntimeProfile(id: string): RuntimeProfile | null;
  getProvider(id: string): ProviderConfig | null;
  saveUsage(record: UsageRecord): void;
};

const supported = new Set(['OPENAI', 'GOOGLE', 'OPENAI_COMPATIBLE']);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Optional vector ranking. Every DB candidate remains constrained to the Teammate's ACTIVE scope. */
export class Gate2HybridMemoryService {
  constructor(
    private readonly runtimes: RuntimeStore,
    private readonly memories: Gate2MemoryService,
    private readonly vectors: VectorMemoryStore,
    private readonly embeddings: EmbeddingGateway,
  ) {}

  getConfig(): EmbeddingSettings {
    return {
      available: this.vectors.available,
      runtimeProfileId: this.vectors.getRuntimeProfileId(),
    };
  }

  configure(runtimeProfileId: string | null): EmbeddingSettings {
    if (runtimeProfileId !== null) {
      if (!this.vectors.available) throw new DomainError('INVALID_INPUT', '向量扩展不可用');
      this.runtime(runtimeProfileId);
    }
    this.vectors.setRuntimeProfileId(runtimeProfileId);
    return this.getConfig();
  }

  private runtime(id: string): RuntimeProfile {
    const runtime = this.runtimes.getRuntimeProfile(id);
    const provider = runtime ? this.runtimes.getProvider(runtime.providerId) : null;
    if (!runtime || !provider || !provider.enabled || !supported.has(provider.kind)) {
      throw new DomainError(
        'INVALID_INPUT',
        '请选择支持 embedding 的 OpenAI、Google 或兼容 Runtime',
      );
    }
    return runtime;
  }

  private usage(
    teammateId: string,
    runtime: RuntimeProfile,
    usage: ModelUsage | null,
    purpose: string,
  ): void {
    this.runtimes.saveUsage({
      id: randomUUID(),
      missionId: null,
      runId: null,
      teammateId,
      runtimeProfileId: runtime.id,
      provider: runtime.providerId,
      model: runtime.modelId,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedInputTokens: usage?.cachedInputTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      providerMetadata: { purpose },
      estimatedCost: null,
      currency: null,
      createdAt: new Date().toISOString(),
    });
  }

  /** Called only after an explicit user review or manual creation. Indexing failure never blocks Chat. */
  async indexMemory(memory: Gate2MemoryRecord): Promise<boolean> {
    const configured = this.vectors.getRuntimeProfileId();
    if (
      !this.vectors.available ||
      !configured ||
      memory.status !== 'ACTIVE' ||
      memory.ownerType !== 'TEAMMATE'
    )
      return false;
    let runtime: RuntimeProfile;
    try {
      runtime = this.runtime(configured);
    } catch {
      return false;
    }
    const contentHash = hash(memory.content);
    if (this.vectors.hasCurrentEmbedding(memory.id, runtime.id, runtime.modelId, contentHash))
      return true;
    let result;
    try {
      result = await this.embeddings.embed({
        runtimeProfileId: runtime.id,
        teammateId: memory.ownerId,
        text: memory.content,
      });
    } catch {
      this.usage(memory.ownerId, runtime, null, 'MEMORY_EMBEDDING_INDEX');
      return false;
    }
    this.usage(memory.ownerId, runtime, result.usage, 'MEMORY_EMBEDDING_INDEX');
    const current = this.memories
      .list(memory.ownerId, 'ACTIVE')
      .find((item) => item.id === memory.id);
    if (
      !current ||
      hash(current.content) !== contentHash ||
      this.vectors.getRuntimeProfileId() !== runtime.id
    )
      return false;
    try {
      this.vectors.saveEmbedding({
        memoryId: memory.id,
        runtimeProfileId: runtime.id,
        modelId: runtime.modelId,
        contentHash,
        vector: result.vector,
      });
      return true;
    } catch {
      return false;
    }
  }

  async onMemoryChanged(memory: Gate2MemoryRecord): Promise<void> {
    this.vectors.deleteMemoryEmbeddings(memory.id);
    if (memory.status === 'ACTIVE') await this.indexMemory(memory);
  }

  async reindex(teammateId: string): Promise<{ indexed: number; total: number }> {
    if (!this.vectors.available || !this.vectors.getRuntimeProfileId()) {
      throw new DomainError('INVALID_INPUT', '先配置 embedding Runtime');
    }
    const records = this.memories.list(teammateId, 'ACTIVE');
    let indexed = 0;
    for (const record of records) if (await this.indexMemory(record)) indexed++;
    return { indexed, total: records.length };
  }

  async retrieve(teammateId: string, query: string): Promise<Gate2MemoryRecord[]> {
    const lexical = this.memories.retrieveActive(teammateId, query, 6);
    const configured = this.vectors.getRuntimeProfileId();
    if (!this.vectors.available || !configured || !query.trim()) return lexical;
    let runtime: RuntimeProfile;
    try {
      runtime = this.runtime(configured);
    } catch {
      return lexical;
    }
    if (!this.vectors.hasScopedEmbeddings(teammateId, runtime.id, runtime.modelId)) return lexical;
    let result;
    try {
      result = await this.embeddings.embed({
        runtimeProfileId: runtime.id,
        teammateId,
        text: query.slice(0, 2_000),
      });
    } catch {
      this.usage(teammateId, runtime, null, 'MEMORY_EMBEDDING_QUERY');
      return lexical;
    }
    this.usage(teammateId, runtime, result.usage, 'MEMORY_EMBEDDING_QUERY');
    let matches: Array<{ memoryId: string; distance: number }>;
    try {
      matches = this.vectors.searchScoped({
        teammateId,
        runtimeProfileId: runtime.id,
        modelId: runtime.modelId,
        vector: result.vector,
        limit: 12,
      });
    } catch {
      return lexical;
    }
    // A second owner/status check guards the application even if a vector adapter regresses.
    const owned = new Map(this.memories.list(teammateId, 'ACTIVE').map((item) => [item.id, item]));
    const scores = new Map<string, number>();
    lexical.forEach((item, rank) =>
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (60 + rank)),
    );
    matches.forEach((item, rank) => {
      if (owned.has(item.memoryId))
        scores.set(item.memoryId, (scores.get(item.memoryId) ?? 0) + 1 / (60 + rank));
    });
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id]) => owned.get(id))
      .filter((item): item is Gate2MemoryRecord => Boolean(item));
  }
}
