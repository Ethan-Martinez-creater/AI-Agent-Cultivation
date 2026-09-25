import { describe, expect, it } from 'vitest';
import type {
  Conversation,
  CredentialSummary,
  Message,
  ProviderConfig,
  RuntimeProfile,
  Teammate,
  UsageRecord,
} from '@cultivation/domain';
import { FakeModelGateway } from '@cultivation/agent-runtime';
import type { ModelGateway, SecretStore } from './index.js';
import { Gate1Service, type Gate1Store, type StoredCredential } from './gate1-service.js';

function setup(gateway: ModelGateway = new FakeModelGateway()) {
  const providers = new Map<string, ProviderConfig>();
  const credentials = new Map<string, StoredCredential>();
  const runtimes = new Map<string, RuntimeProfile>();
  const teammates = new Map<string, Teammate>();
  const conversations = new Map<string, Conversation>();
  const messages: Message[] = [];
  const usage: UsageRecord[] = [];
  const store: Gate1Store = {
    listProviders: () => [...providers.values()],
    getProvider: (id) => providers.get(id) ?? null,
    saveProvider: (value) => {
      providers.set(value.id, value);
    },
    listCredentials: (providerId) =>
      [...credentials.values()]
        .filter((item) => !providerId || item.providerId === providerId)
        .map(
          (item): CredentialSummary => ({
            id: item.id,
            providerId: item.providerId,
            label: item.label,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          }),
        ),
    getCredential: (id) => credentials.get(id) ?? null,
    saveCredential: (value) => {
      credentials.set(value.id, value);
    },
    listRuntimeProfiles: () => [...runtimes.values()],
    getRuntimeProfile: (id) => runtimes.get(id) ?? null,
    saveRuntimeProfile: (value) => {
      runtimes.set(value.id, value);
    },
    listTeammates: () => [...teammates.values()],
    getTeammate: (id) => teammates.get(id) ?? null,
    saveTeammate: (value) => {
      teammates.set(value.id, value);
    },
    listConversations: (teammateId) =>
      [...conversations.values()].filter((c) => c.teammateId === teammateId),
    getConversation: (id) => conversations.get(id) ?? null,
    saveConversation: (value) => {
      conversations.set(value.id, value);
    },
    listMessages: (teammateId, conversationId) => {
      if (conversations.get(conversationId)?.teammateId !== teammateId) return [];
      return messages.filter((message) => message.conversationId === conversationId);
    },
    saveMessage: (value) => {
      messages.push(value);
    },
    listUsage: (teammateId) =>
      usage.filter((item) => !teammateId || item.teammateId === teammateId),
    saveUsage: (value) => {
      usage.push(value);
    },
  };
  const secrets: SecretStore = {
    encrypt: async (plaintext) => Buffer.from(`sealed:${plaintext}`),
    decrypt: async (ciphertext) => Buffer.from(ciphertext).toString().slice('sealed:'.length),
  };
  return {
    service: new Gate1Service(store, secrets, gateway),
    store,
    credentials,
    messages,
    usage,
  };
}

function teammateInput(runtimeProfileId: string, name = '青玄') {
  return {
    name,
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    currentRuntimeProfileId: runtimeProfileId,
  };
}

async function collect(
  service: Gate1Service,
  teammateId: string,
  conversationId: string,
  text: string,
) {
  const events = [];
  for await (const event of service.streamChat({ teammateId, conversationId, text }))
    events.push(event);
  return events;
}

describe('Gate 1 application vertical slice', () => {
  it('rejects Provider URLs that could store credential material in plaintext', () => {
    const { service } = setup();
    for (const baseUrl of [
      'https://secret@provider.example/v1',
      'https://provider.example/v1?api_key=secret',
      'https://provider.example/v1#secret',
    ]) {
      expect(() =>
        service.createProvider({ name: 'Unsafe', kind: 'OPENAI_COMPATIBLE', baseUrl }),
      ).toThrow();
    }
    expect(service.listProviders()).toEqual([]);
  });

  it('keeps credentials behind Main and retains identity, chat and usage across Providers', async () => {
    const { service, store, credentials } = setup();
    const providerA = service.createProvider({ name: 'Provider A', kind: 'OPENAI' });
    const providerB = service.createProvider({ name: 'Provider B', kind: 'ANTHROPIC' });
    const credentialA = await service.createCredential({
      providerId: providerA.id,
      label: 'A',
      apiKey: 'secret-A',
    });
    const credentialB = await service.createCredential({
      providerId: providerB.id,
      label: 'B',
      apiKey: 'secret-B',
    });
    expect(credentialA).not.toHaveProperty('ciphertext');
    expect(service.listCredentials(providerA.id)).not.toHaveProperty('apiKey');
    expect(Buffer.from(credentials.get(credentialA.id)!.ciphertext).toString()).not.toBe(
      'secret-A',
    );
    const runtimeA = service.createRuntimeProfile({
      name: 'Runtime A',
      providerId: providerA.id,
      credentialId: credentialA.id,
      modelId: 'model-a',
    });
    const runtimeB = service.createRuntimeProfile({
      name: 'Runtime B',
      providerId: providerB.id,
      credentialId: credentialB.id,
      modelId: 'model-b',
    });
    const teammate = service.createTeammate(teammateInput(runtimeA.id));
    const conversation = service.createConversation(teammate.id);
    expect((await collect(service, teammate.id, conversation.id, 'PING')).at(-1)?.type).toBe(
      'done',
    );
    const switched = service.switchRuntime({
      teammateId: teammate.id,
      runtimeProfileId: runtimeB.id,
    });
    expect(switched.id).toBe(teammate.id);
    expect((await collect(service, teammate.id, conversation.id, 'again')).at(-1)?.type).toBe(
      'done',
    );
    expect(service.listMessages(teammate.id, conversation.id).map((item) => item.role)).toEqual([
      'USER',
      'ASSISTANT',
      'USER',
      'ASSISTANT',
    ]);
    expect(service.listConversations(teammate.id)).toEqual([conversation]);
    expect(store.getTeammate(teammate.id)?.currentRuntimeProfileId).toBe(runtimeB.id);
    expect(
      service
        .listUsage(teammate.id)
        .map((item) => [item.teammateId, item.runtimeProfileId, item.provider, item.model]),
    ).toEqual([
      [teammate.id, runtimeA.id, providerA.id, 'model-a'],
      [teammate.id, runtimeB.id, providerB.id, 'model-b'],
    ]);
  });

  it('isolates concurrent streams and conversations by teammate', async () => {
    const gateway = {
      async *stream(request: { teammateId: string }) {
        yield { type: 'text-delta', text: request.teammateId };
        await Promise.resolve();
        yield {
          type: 'finish',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: null,
            reasoningTokens: null,
          },
        };
      },
      testConnection: async () => ({ ok: true, message: 'ok' }),
    } as unknown as ModelGateway;
    const { service } = setup(gateway);
    const provider = service.createProvider({
      name: 'Local',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://localhost:9999/v1',
    });
    const runtime = service.createRuntimeProfile({
      name: 'Local',
      providerId: provider.id,
      credentialId: null,
      modelId: 'local-model',
    });
    const a = service.createTeammate(teammateInput(runtime.id, 'A'));
    const b = service.createTeammate(teammateInput(runtime.id, 'B'));
    const ca = service.createConversation(a.id);
    const cb = service.createConversation(b.id);
    const [eventsA, eventsB] = await Promise.all([
      collect(service, a.id, ca.id, 'hello A'),
      collect(service, b.id, cb.id, 'hello B'),
    ]);
    expect(eventsA[0]).toEqual({ type: 'delta', text: a.id });
    expect(eventsB[0]).toEqual({ type: 'delta', text: b.id });
    expect(() => service.listMessages(a.id, cb.id)).toThrow();
    expect(() => service.listMessages(b.id, ca.id)).toThrow();
    expect(service.listUsage(a.id)).toHaveLength(1);
    expect(service.listUsage(b.id)).toHaveLength(1);
  });

  it('persists missing provider token fields as null rather than inventing counts', async () => {
    const gateway = {
      async *stream() {
        yield { type: 'text-delta', text: 'reply' };
        yield {
          type: 'finish',
          usage: {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reasoningTokens: null,
          },
        };
      },
      testConnection: async () => ({ ok: true, message: 'ok' }),
    } as unknown as ModelGateway;
    const { service } = setup(gateway);
    const provider = service.createProvider({
      name: 'Local',
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://localhost:9999/v1',
    });
    const runtime = service.createRuntimeProfile({
      name: 'Local',
      providerId: provider.id,
      credentialId: null,
      modelId: 'local-model',
    });
    const teammate = service.createTeammate(teammateInput(runtime.id));
    const conversation = service.createConversation(teammate.id);
    await collect(service, teammate.id, conversation.id, 'hello');
    expect(service.listUsage(teammate.id)[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });
});
