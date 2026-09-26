import type {
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  RuntimeProfile,
  UsageRecord,
} from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type { MemoryCandidateExtractor, ModelUsage } from './index.js';
import type { Gate1Store } from './gate1-service.js';

export type Gate2MemoryRecord = MemoryRecord & {
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  confirmedAt: string | null;
};

/** Main-only port. Scoped search must constrain owner and status before FTS matching. */
export interface Gate2MemoryStore {
  getMemory(id: string): Gate2MemoryRecord | null;
  listMemories(ownerType: 'TEAMMATE', ownerId: string, status?: MemoryStatus): Gate2MemoryRecord[];
  saveMemory(record: Gate2MemoryRecord): void;
  searchActiveMemories(
    ownerType: 'TEAMMATE',
    ownerId: string,
    query: string,
    limit: number,
  ): Gate2MemoryRecord[];
}

export interface MemoryEdit {
  memoryType: MemoryType;
  content: string;
  summary: string;
  importance: number;
}

const now = (): string => new Date().toISOString();
const id = (): string => crypto.randomUUID();

function text(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new DomainError('INVALID_INPUT', `${label}不能为空或超过长度限制`);
  }
  return trimmed;
}

function importance(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DomainError('INVALID_INPUT', '重要性须在 0 到 1 之间');
  }
  return value;
}

/** Memory transitions are explicit user actions; model output can only create PROPOSED rows. */
export class Gate2MemoryService {
  constructor(
    private readonly gate1: Pick<
      Gate1Store,
      'getTeammate' | 'getRuntimeProfile' | 'getConversation' | 'listMessages' | 'saveUsage'
    >,
    private readonly memories: Gate2MemoryStore,
    private readonly extractor: MemoryCandidateExtractor,
  ) {}

  private requireTeammate(teammateId: string): void {
    if (!this.gate1.getTeammate(teammateId)) {
      throw new DomainError('NOT_FOUND', '道友不存在');
    }
  }

  private owned(teammateId: string, memoryId: string): Gate2MemoryRecord {
    this.requireTeammate(teammateId);
    const record = this.memories.getMemory(memoryId);
    if (!record || record.ownerType !== 'TEAMMATE' || record.ownerId !== teammateId) {
      throw new DomainError('NOT_FOUND', '记忆不存在');
    }
    return record;
  }

  list(teammateId: string, status?: MemoryStatus): Gate2MemoryRecord[] {
    this.requireTeammate(teammateId);
    return this.memories
      .listMemories('TEAMMATE', teammateId, status)
      .filter(
        (record) =>
          record.ownerType === 'TEAMMATE' &&
          record.ownerId === teammateId &&
          (status === undefined || record.status === status),
      );
  }

  createManual(teammateId: string, edit: MemoryEdit): Gate2MemoryRecord {
    this.requireTeammate(teammateId);
    const timestamp = now();
    const record: Gate2MemoryRecord = {
      id: id(),
      ownerType: 'TEAMMATE',
      ownerId: teammateId,
      memoryType: edit.memoryType,
      content: text(edit.content, '记忆内容', 2_000),
      summary: edit.summary.trim().slice(0, 240),
      sourceType: 'MANUAL',
      sourceId: null,
      sourceConversationId: null,
      sourceMessageId: null,
      importance: importance(edit.importance),
      confidence: 1,
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp,
      confirmedAt: timestamp,
      expiresAt: null,
    };
    this.memories.saveMemory(record);
    return record;
  }

  update(teammateId: string, memoryId: string, edit: MemoryEdit): Gate2MemoryRecord {
    const previous = this.owned(teammateId, memoryId);
    if (previous.status === 'REJECTED' || previous.status === 'ARCHIVED') {
      throw new DomainError('INVALID_INPUT', '已拒绝或归档的记忆不可编辑');
    }
    const updated: Gate2MemoryRecord = {
      ...previous,
      memoryType: edit.memoryType,
      content: text(edit.content, '记忆内容', 2_000),
      summary: edit.summary.trim().slice(0, 240),
      importance: importance(edit.importance),
      updatedAt: now(),
    };
    this.memories.saveMemory(updated);
    return updated;
  }

  archive(teammateId: string, memoryId: string): Gate2MemoryRecord {
    const previous = this.owned(teammateId, memoryId);
    if (previous.status === 'ARCHIVED') return previous;
    const updated: Gate2MemoryRecord = { ...previous, status: 'ARCHIVED', updatedAt: now() };
    this.memories.saveMemory(updated);
    return updated;
  }

  accept(teammateId: string, memoryId: string, edits?: Partial<MemoryEdit>): Gate2MemoryRecord {
    const previous = this.owned(teammateId, memoryId);
    if (previous.status !== 'PROPOSED') {
      throw new DomainError('INVALID_INPUT', '只能确认待审核记忆');
    }
    const timestamp = now();
    const updated: Gate2MemoryRecord = {
      ...previous,
      memoryType: edits?.memoryType ?? previous.memoryType,
      content: text(edits?.content ?? previous.content, '记忆内容', 2_000),
      summary: (edits?.summary ?? previous.summary).trim().slice(0, 240),
      importance: importance(edits?.importance ?? previous.importance),
      status: 'ACTIVE',
      confirmedAt: timestamp,
      updatedAt: timestamp,
    };
    this.memories.saveMemory(updated);
    return updated;
  }

  reject(teammateId: string, memoryId: string): Gate2MemoryRecord {
    const previous = this.owned(teammateId, memoryId);
    if (previous.status !== 'PROPOSED') {
      throw new DomainError('INVALID_INPUT', '只能拒绝待审核记忆');
    }
    const updated: Gate2MemoryRecord = { ...previous, status: 'REJECTED', updatedAt: now() };
    this.memories.saveMemory(updated);
    return updated;
  }

  retrieveActive(teammateId: string, query: string, limit = 6): Gate2MemoryRecord[] {
    this.requireTeammate(teammateId);
    const boundedLimit = Math.max(1, Math.min(6, Math.floor(limit)));
    return this.memories
      .searchActiveMemories('TEAMMATE', teammateId, query.slice(0, 500), boundedLimit)
      .filter(
        (record) =>
          record.ownerType === 'TEAMMATE' &&
          record.ownerId === teammateId &&
          record.status === 'ACTIVE' &&
          (!record.expiresAt || record.expiresAt > now()),
      )
      .slice(0, boundedLimit);
  }

  private usage(
    teammateId: string,
    runtime: RuntimeProfile,
    usage: ModelUsage | null,
  ): UsageRecord {
    return {
      id: id(),
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
      providerMetadata: { purpose: 'MEMORY_CANDIDATE_EXTRACTION' },
      estimatedCost: null,
      currency: null,
      createdAt: now(),
    };
  }

  async proposeFromMessage(input: {
    teammateId: string;
    conversationId: string;
    messageId: string;
  }): Promise<Gate2MemoryRecord[]> {
    const teammate = this.gate1.getTeammate(input.teammateId);
    if (!teammate || teammate.status !== 'ACTIVE') {
      throw new DomainError('NOT_FOUND', '可用道友不存在');
    }
    const conversation = this.gate1.getConversation(input.conversationId);
    if (!conversation || conversation.teammateId !== input.teammateId) {
      throw new DomainError('NOT_FOUND', '对话不存在');
    }
    const message = this.gate1
      .listMessages(input.teammateId, input.conversationId)
      .find((item) => item.id === input.messageId);
    if (!message || message.missionId !== null) {
      throw new DomainError('NOT_FOUND', '对话证据不存在');
    }
    if (!teammate.currentRuntimeProfileId) {
      throw new DomainError('INVALID_INPUT', '道友没有运行配置');
    }
    const runtime = this.gate1.getRuntimeProfile(teammate.currentRuntimeProfileId);
    if (!runtime) throw new DomainError('NOT_FOUND', '运行配置不存在');
    let extracted;
    try {
      extracted = await this.extractor.extractCandidates({
        teammateId: teammate.id,
        runtimeProfileId: runtime.id,
        evidence: message.content,
      });
    } catch {
      this.gate1.saveUsage(this.usage(teammate.id, runtime, null));
      throw new DomainError('MODEL_CALL_FAILED', '记忆候选提取失败；对话已正常保存');
    }
    this.gate1.saveUsage(this.usage(teammate.id, runtime, extracted.usage));
    const timestamp = now();
    return extracted.candidates.slice(0, 3).map((candidate) => {
      const record: Gate2MemoryRecord = {
        id: id(),
        ownerType: 'TEAMMATE',
        ownerId: teammate.id,
        memoryType: candidate.memoryType,
        content: text(candidate.content, '记忆内容', 1_000),
        summary: candidate.summary.trim().slice(0, 240),
        sourceType: 'CHAT_EXTRACTION',
        sourceId: message.id,
        sourceConversationId: conversation.id,
        sourceMessageId: message.id,
        importance: importance(candidate.importance),
        confidence: importance(candidate.confidence),
        status: 'PROPOSED',
        createdAt: timestamp,
        updatedAt: timestamp,
        confirmedAt: null,
        expiresAt: null,
      };
      this.memories.saveMemory(record);
      return record;
    });
  }
}
