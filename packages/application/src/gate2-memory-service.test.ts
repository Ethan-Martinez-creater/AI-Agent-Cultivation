import { describe, expect, it, vi } from 'vitest';
import { MemoryPreGateService } from './r5-2-memory-pre-gate.js';
import type { DecisionRequest, DecisionResult } from './r0-decision.js';
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
    ({
      id,
      status: 'ACTIVE',
      executorKind: 'MODEL_RUNTIME',
      currentRuntimeProfileId: runtimeId,
    }) as Teammate;
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
    role: 'USER',
    actorType: 'USER',
    actorId: 'local-user',
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
    getModelBinding: (id: string) => ({
      teammateId: id,
      runtimeProfileId: teammates.get(id)?.currentRuntimeProfileId ?? '',
      executionProtocol: 'LANGUAGE' as const,
      providerKind: 'OPENAI' as const,
      endpoint: null,
      modelId: 'test-model',
      credentialId: null,
      verifiedAt: '2026-10-06',
      verificationSource: 'LIVE_TEST' as const,
      sealedAt: '2026-10-06',
    }),
    hasValidModelBinding: () => true,
    getConversation: (id: string) => (id === conversation.id ? conversation : null),
    listMessages: (teammateId: string, conversationId: string) =>
      teammateId === 'a' && conversationId === conversation.id ? [message] : [],
    saveUsage: (record: UsageRecord) => {
      usage.push(record);
    },
  } satisfies Pick<
    Gate1Store,
    | 'getTeammate'
    | 'getRuntimeProfile'
    | 'getConversation'
    | 'listMessages'
    | 'saveUsage'
    | 'getModelBinding'
    | 'hasValidModelBinding'
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
    gate1,
    runtimes,
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

describe('R5.2 existing Chat extraction integration', () => {
  const input = { teammateId: 'a', conversationId: 'conversation-a', messageId: 'message-a' };
  const answer = (decision: 'RUN_EXTRACTION' | 'SKIP_EXTRACTION'): DecisionResult => ({
    answers: { extraction: decision },
    confidence: { extraction: 0.9 },
    selectedAction: null,
  });
  const model = () => ({
    extractCandidates: vi.fn(async () => ({
      candidates: [
        {
          memoryType: 'FACT' as const,
          content: 'A durable fact',
          summary: '',
          importance: 0.5,
          confidence: 0.8,
          status: 'ACTIVE',
        },
      ],
      usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: null, reasoningTokens: null },
    })),
  });

  it('SKIP is a normal compatible empty result: no extractor, proposal, or fake Usage', async () => {
    const extractor = model();
    const { service, usage, rows } = fixture(extractor);
    service.attachMemoryPreGate(
      new MemoryPreGateService(async () => ({ evaluate: async () => answer('SKIP_EXTRACTION') })),
    );
    const result = await service.proposeFromMessageWithGate(input);
    expect(result).toMatchObject({
      candidates: [],
      gate: {
        mode: 'JEV',
        decision: 'SKIP_EXTRACTION',
        extractorInvoked: false,
        candidateCount: 0,
      },
    });
    expect(extractor.extractCandidates).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
    expect(usage).toEqual([]);
    expect(await service.proposeFromMessage(input)).toEqual([]);
  });

  it('RUN invokes the existing extractor once and cannot bypass PROPOSED or user review', async () => {
    const extractor = model();
    const { service, rows, usage } = fixture(extractor);
    service.attachMemoryPreGate(
      new MemoryPreGateService(async () => ({ evaluate: async () => answer('RUN_EXTRACTION') })),
    );
    const result = await service.proposeFromMessageWithGate(input);
    expect(extractor.extractCandidates).toHaveBeenCalledTimes(1);
    expect(result.gate).toMatchObject({
      mode: 'JEV',
      decision: 'RUN_EXTRACTION',
      extractorInvoked: true,
      candidateCount: 1,
    });
    expect([...rows.values()].every((row) => row.status === 'PROPOSED')).toBe(true);
    expect(service.retrieveActive('a', 'fact')).toEqual([]);
    expect(usage).toHaveLength(1);
    expect(() => service.accept('b', result.candidates[0]!.id)).toThrow();
    expect(() => service.reject('b', result.candidates[0]!.id)).toThrow();
    expect(service.list('b')).toEqual([]);
    expect(service.accept('a', result.candidates[0]!.id).status).toBe('ACTIVE');
  });

  it('no gateway preserves explicit extraction and reports fallback, never Jev success', async () => {
    const extractor = model();
    const { service } = fixture(extractor);
    const result = await service.proposeFromMessageWithGate(input);
    expect(extractor.extractCandidates).toHaveBeenCalledTimes(1);
    expect(result.gate).toMatchObject({
      trigger: 'USER_EXPLICIT',
      mode: 'DETERMINISTIC_FALLBACK',
      decision: 'RUN_EXTRACTION',
      extractorInvoked: true,
    });
  });

  it('only bounded structural facts enter the decision request; raw source reaches only extraction', async () => {
    const extractor = model();
    const { service, message } = fixture(extractor);
    message.content =
      'I prefer private green tea. PRIVATE_MEMORY_SENTINEL sk-secret-12345678901234567890123\n```file\nFILE_BODY_SENTINEL\n```';
    const evaluate = vi.fn<(request: DecisionRequest) => Promise<DecisionResult>>(async () =>
      answer('RUN_EXTRACTION'),
    );
    service.attachMemoryPreGate(new MemoryPreGateService(async () => ({ evaluate })));
    const { gate } = await service.proposeFromMessageWithGate(input);
    const request = evaluate.mock.calls[0]![0];
    expect(
      JSON.stringify({ state: request.state, inputSummary: request.inputSummary }),
    ).not.toMatch(/green tea|SENTINEL|sk-secret|content|instructions/);
    expect(JSON.stringify(gate)).not.toMatch(/green tea|SENTINEL|sk-secret/);
    expect(extractor.extractCandidates).toHaveBeenCalledWith({
      teammateId: 'a',
      runtimeProfileId: 'runtime-a',
      evidence: message.content,
    });
  });

  it.each([
    'wrong-owner',
    'wrong-conversation',
    'wrong-actor',
    'tool-role',
    'mission-source',
    'human-bridge',
    'generation',
  ])('rejects %s before Jev or expensive extraction', async (caseName) => {
    const extractor = model();
    const f = fixture(extractor);
    const evaluate = vi.fn(async () => answer('RUN_EXTRACTION'));
    f.service.attachMemoryPreGate(new MemoryPreGateService(async () => ({ evaluate })));
    let source = input;
    if (caseName === 'wrong-owner') source = { ...input, teammateId: 'b' };
    if (caseName === 'wrong-conversation') f.message.conversationId = 'other';
    if (caseName === 'wrong-actor') {
      f.message.role = 'ASSISTANT';
      f.message.actorType = 'TEAMMATE';
      f.message.actorId = 'b';
    }
    if (caseName === 'tool-role') f.message.role = 'TOOL';
    if (caseName === 'mission-source') f.message.missionId = 'mission';
    if (caseName === 'human-bridge')
      f.teammates.set('a', { ...f.teammates.get('a')!, executorKind: 'USER_BRIDGE' });
    if (caseName === 'generation')
      f.runtimes.set('runtime-a', {
        ...f.runtimes.get('runtime-a')!,
        executionProtocol: 'GENERATION',
      });
    await expect(f.service.proposeFromMessage(source)).rejects.toThrow();
    expect(evaluate).not.toHaveBeenCalled();
    expect(extractor.extractCandidates).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
    expect(f.usage).toEqual([]);
  });

  it('rechecks source and owner after the gate await before invoking extraction', async () => {
    const extractor = model();
    const f = fixture(extractor);
    f.service.attachMemoryPreGate(
      new MemoryPreGateService(async () => ({
        evaluate: async () => {
          f.message.conversationId = 'another-owner';
          return answer('RUN_EXTRACTION');
        },
      })),
    );
    await expect(f.service.proposeFromMessage(input)).rejects.toThrow();
    expect(extractor.extractCandidates).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
  });

  it('rechecks after extraction: an archived actor gets no proposal while actual usage is retained', async () => {
    const extractor = model();
    const f = fixture(extractor);
    extractor.extractCandidates.mockImplementationOnce(async () => {
      f.teammates.set('a', { ...f.teammates.get('a')!, status: 'ARCHIVED' });
      return {
        candidates: [],
        usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: null, reasoningTokens: null },
      };
    });
    await expect(f.service.proposeFromMessage(input)).rejects.toThrow();
    expect(f.rows.size).toBe(0);
    expect(f.usage).toHaveLength(1);
  });
});
