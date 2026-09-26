import { describe, expect, it } from 'vitest';
import type {
  Conversation,
  Message,
  RuntimeProfile,
  Teammate,
  UsageRecord,
} from '@cultivation/domain';
import type { MemoryCandidateExtractor } from './index.js';
import {
  Gate2MemoryService,
  type Gate2MemoryRecord,
  type Gate2MemoryStore,
} from './gate2-memory-service.js';
import type { Gate1Store } from './gate1-service.js';

function fixture(extractor?: MemoryCandidateExtractor) {
  const teammate = (id: string, runtimeId = 'runtime-a') =>
    ({ id, status: 'ACTIVE', currentRuntimeProfileId: runtimeId }) as Teammate;
  const teammates = new Map([
    ['a', teammate('a')],
    ['b', teammate('b', 'runtime-b')],
  ]);
  const runtimes = new Map<string, RuntimeProfile>([
    [
      'runtime-a',
      { id: 'runtime-a', providerId: 'provider-a', modelId: 'model-a' } as RuntimeProfile,
    ],
    [
      'runtime-b',
      { id: 'runtime-b', providerId: 'provider-b', modelId: 'model-b' } as RuntimeProfile,
    ],
  ]);
  const conversation = { id: 'conversation-a', teammateId: 'a' } as Conversation;
  const message = {
    id: 'message-a',
    missionId: null,
    conversationId: conversation.id,
    content: 'I prefer green tea.',
  } as Message;
  const rows = new Map<string, Gate2MemoryRecord>();
  const usage: UsageRecord[] = [];
  const memoryStore: Gate2MemoryStore = {
    getMemory: (id) => rows.get(id) ?? null,
    listMemories: () => [...rows.values()], // deliberately hostile: application must recheck scope
    saveMemory: (record) => {
      rows.set(record.id, record);
    },
    searchActiveMemories: () => [...rows.values()], // deliberately hostile
  };
  const gate1 = {
    getTeammate: (id: string) => teammates.get(id) ?? null,
    getRuntimeProfile: (id: string) => runtimes.get(id) ?? null,
    getConversation: (id: string) => (id === conversation.id ? conversation : null),
    listMessages: (teammateId: string, conversationId: string) =>
      teammateId === 'a' && conversationId === conversation.id ? [message] : [],
    saveUsage: (record: UsageRecord) => {
      usage.push(record);
    },
  } satisfies Pick<
    Gate1Store,
    'getTeammate' | 'getRuntimeProfile' | 'getConversation' | 'listMessages' | 'saveUsage'
  >;
  const model: MemoryCandidateExtractor = extractor ?? {
    extractCandidates: async () => ({
      candidates: [
        {
          memoryType: 'PREFERENCE',
          content: 'The user prefers green tea.',
          summary: 'Prefers green tea',
          importance: 0.8,
          confidence: 0.9,
        },
      ],
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    }),
  };
  return {
    service: new Gate2MemoryService(gate1, memoryStore, model),
    teammates,
    rows,
    usage,
    message,
  };
}

const edit = {
  memoryType: 'FACT' as const,
  content: 'Likes jasmine tea',
  summary: 'Tea preference',
  importance: 0.7,
};

describe('Gate 2 memory application boundary', () => {
  it('rechecks owner/status even if a repository returns another teammate’s rows', () => {
    const { service } = fixture();
    const a = service.createManual('a', edit);
    const b = service.createManual('b', { ...edit, content: 'Private to B' });
    expect(service.list('a').map((row) => row.id)).toEqual([a.id]);
    expect(service.retrieveActive('a', 'tea').map((row) => row.id)).toEqual([a.id]);
    expect(service.retrieveActive('b', 'tea').map((row) => row.id)).toEqual([b.id]);
    expect(() => service.update('b', a.id, edit)).toThrow();
    expect(() => service.archive('b', a.id)).toThrow();
  });

  it('persists extracted evidence only as PROPOSED until explicit acceptance', async () => {
    const { service, usage, message } = fixture();
    const [candidate] = await service.proposeFromMessage({
      teammateId: 'a',
      conversationId: 'conversation-a',
      messageId: message.id,
    });
    if (!candidate) throw new Error('Expected one candidate');
    expect(candidate).toMatchObject({
      ownerType: 'TEAMMATE',
      ownerId: 'a',
      status: 'PROPOSED',
      sourceConversationId: 'conversation-a',
      sourceMessageId: message.id,
      confirmedAt: null,
    });
    expect(service.retrieveActive('a', 'tea')).toEqual([]);
    expect(usage[0]).toMatchObject({
      teammateId: 'a',
      runtimeProfileId: 'runtime-a',
      provider: 'provider-a',
      inputTokens: 11,
      outputTokens: 7,
    });
    expect(() => service.accept('b', candidate.id)).toThrow();
    const accepted = service.accept('a', candidate.id, { content: 'User prefers jasmine tea.' });
    expect(accepted.status).toBe('ACTIVE');
    expect(accepted.confirmedAt).not.toBeNull();
    expect(service.retrieveActive('a', 'tea').map((row) => row.id)).toEqual([candidate.id]);
  });

  it('never retrieves rejected proposals or archived manual memories', async () => {
    const { service, message } = fixture();
    const [candidate] = await service.proposeFromMessage({
      teammateId: 'a',
      conversationId: 'conversation-a',
      messageId: message.id,
    });
    if (!candidate) throw new Error('Expected one candidate');
    expect(service.reject('a', candidate.id).status).toBe('REJECTED');
    expect(() => service.accept('a', candidate.id)).toThrow();
    const manual = service.createManual('a', edit);
    service.archive('a', manual.id);
    expect(service.retrieveActive('a', 'tea')).toEqual([]);
  });

  it('keeps memory owner stable when the teammate changes runtime', async () => {
    const { service, teammates, message, usage } = fixture();
    const original = service.createManual('a', edit);
    teammates.set('a', { ...teammates.get('a')!, currentRuntimeProfileId: 'runtime-b' });
    const [candidate] = await service.proposeFromMessage({
      teammateId: 'a',
      conversationId: 'conversation-a',
      messageId: message.id,
    });
    if (!candidate) throw new Error('Expected one candidate');
    expect(candidate.ownerId).toBe('a');
    expect(service.retrieveActive('a', 'tea').map((row) => row.id)).toEqual([original.id]);
    expect(usage[0]).toMatchObject({ teammateId: 'a', runtimeProfileId: 'runtime-b' });
  });

  it('treats extraction failure as an optional flow without changing saved chat evidence', async () => {
    const { service, message, usage } = fixture({
      extractCandidates: async () => {
        throw new Error('provider secret in raw error');
      },
    });
    await expect(
      service.proposeFromMessage({
        teammateId: 'a',
        conversationId: 'conversation-a',
        messageId: message.id,
      }),
    ).rejects.toThrow('记忆候选提取失败');
    expect(message.content).toBe('I prefer green tea.');
    expect(service.list('a')).toEqual([]);
    expect(usage[0]).toMatchObject({
      teammateId: 'a',
      inputTokens: null,
      outputTokens: null,
    });
  });
});
