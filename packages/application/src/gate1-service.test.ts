import { describe, expect, it } from 'vitest';
import type {
  Conversation,
  CredentialSummary,
  Message,
  ProviderConfig,
  RuntimeProfile,
  Teammate,
  TeammateModelBinding,
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
  const bindings = new Map<string, TeammateModelBinding>();
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
    getRuntimeIdentitySnapshot: (id) => {
      const runtime = runtimes.get(id);
      if (!runtime) return null;
      const provider = providers.get(runtime.providerId);
      if (!provider) return null;
      return {
        providerId: runtime.providerId,
        providerKind: provider.kind,
        baseUrl: provider.baseUrl,
        modelId: runtime.modelId,
        credentialId: runtime.credentialId,
        runtimeUpdatedAt: runtime.updatedAt,
        providerUpdatedAt: provider.updatedAt,
        credentialUpdatedAt: runtime.credentialId
          ? (credentials.get(runtime.credentialId)?.updatedAt ?? null)
          : null,
      };
    },
    saveRuntimeProfile: (value) => {
      runtimes.set(value.id, value);
    },
    isRuntimeBound: (runtimeId) =>
      [...bindings.values()].some((item) => item.runtimeProfileId === runtimeId),
    hasValidModelBinding: (teammateId) => bindings.has(teammateId),
    getModelBinding: (teammateId) => bindings.get(teammateId) ?? null,
    createSealedTeammate: (teammate, sourceRuntimeProfileId, verifiedIdentity, verifiedAt) => {
      const source = runtimes.get(sourceRuntimeProfileId)!;
      const provider = providers.get(source.providerId)!;
      const currentIdentity = store.getRuntimeIdentitySnapshot(sourceRuntimeProfileId);
      if (JSON.stringify(currentIdentity) !== JSON.stringify(verifiedIdentity)) {
        throw new Error('Runtime identity changed after connection verification');
      }
      const runtime = {
        ...source,
        id: crypto.randomUUID(),
        createdAt: verifiedAt,
        updatedAt: verifiedAt,
      };
      runtimes.set(runtime.id, runtime);
      const saved = { ...teammate, currentRuntimeProfileId: runtime.id };
      teammates.set(saved.id, saved);
      const binding: TeammateModelBinding = {
        teammateId: saved.id,
        runtimeProfileId: runtime.id,
        providerKind: provider.kind,
        endpoint: provider.baseUrl,
        modelId: runtime.modelId,
        credentialId: runtime.credentialId,
        verifiedAt,
        sealedAt: verifiedAt,
        verificationSource: 'LIVE_TEST',
      };
      bindings.set(saved.id, binding);
      return { teammate: saved, binding };
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
  it('does not create or seal a teammate when connection verification fails', async () => {
    const gateway = {
      testConnection: async () => ({ ok: false, message: 'offline' }),
    } as unknown as ModelGateway;
    const { service, store } = setup(gateway);
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
    await expect(service.createTeammate(teammateInput(runtime.id))).rejects.toThrow(
      '连接测试未通过',
    );
    expect(store.listTeammates()).toEqual([]);
    expect(store.isRuntimeBound(runtime.id)).toBe(false);
  });

  it('rejects sealing if Runtime identity changes while connection verification is pending', async () => {
    let finishTest!: (result: { ok: boolean; message: string }) => void;
    const gateway = {
      testConnection: () =>
        new Promise<{ ok: boolean; message: string }>((resolve) => {
          finishTest = resolve;
        }),
    } as unknown as ModelGateway;
    const { service, store } = setup(gateway);
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

    const pendingCreation = service.createTeammate(teammateInput(runtime.id));
    expect(finishTest).toBeTypeOf('function');
    store.saveRuntimeProfile({
      ...runtime,
      modelId: 'temporary-model',
      updatedAt: '2026-09-29T01:00:00.000Z',
    });
    // Restore the original identity values while retaining a new version stamp.
    store.saveRuntimeProfile({ ...runtime, updatedAt: '2026-09-29T01:00:01.000Z' });
    finishTest({ ok: true, message: 'ok' });

    await expect(pendingCreation).rejects.toThrow('连接测试期间模型配置发生变化');
    expect(store.listTeammates()).toEqual([]);
    expect(store.isRuntimeBound(runtime.id)).toBe(false);
  });

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

  it('seals each teammate to a private verified model while retaining chat and usage', async () => {
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
    const teammate = await service.createTeammate(teammateInput(runtimeA.id));
    expect(teammate).toMatchObject({
      executorKind: 'MODEL_RUNTIME',
      routingPolicy: 'NORMAL',
      systemKind: null,
    });
    const duplicate = await service.duplicateTeammate(teammate.id);
    expect(duplicate).toMatchObject({
      executorKind: 'MODEL_RUNTIME',
      routingPolicy: 'NORMAL',
      systemKind: null,
    });
    expect(duplicate.id).not.toBe(teammate.id);
    expect(duplicate.currentRuntimeProfileId).not.toBe(teammate.currentRuntimeProfileId);
    const originalBinding = store.getModelBinding(teammate.id)!;
    const rotated = await service.rotateCredential({
      credentialId: credentialA.id,
      apiKey: 'secret-A-rotated',
    });
    expect(rotated).not.toHaveProperty('ciphertext');
    expect(rotated.id).toBe(credentialA.id);
    expect(store.getModelBinding(teammate.id)).toEqual(originalBinding);
    expect((await service.resolveRuntime(teammate.currentRuntimeProfileId!)).apiKey).toBe(
      'secret-A-rotated',
    );
    const conversation = service.createConversation(teammate.id);
    expect((await collect(service, teammate.id, conversation.id, 'PING')).at(-1)?.type).toBe(
      'done',
    );
    expect(() =>
      service.switchRuntime({ teammateId: teammate.id, runtimeProfileId: runtimeB.id }),
    ).toThrow('模型已封存');
    expect(() =>
      service.updateTeammate({ ...teammate, currentRuntimeProfileId: runtimeB.id }),
    ).toThrow('模型已封存');
    expect(() =>
      service.updateRuntimeProfile({
        ...runtimeA,
        id: teammate.currentRuntimeProfileId!,
        providerId: providerB.id,
        credentialId: credentialB.id,
        modelId: 'model-b',
      }),
    ).toThrow('已封存');
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
    expect(store.getTeammate(teammate.id)?.currentRuntimeProfileId).toBe(
      teammate.currentRuntimeProfileId,
    );
    expect(
      service
        .listUsage(teammate.id)
        .map((item) => [item.teammateId, item.runtimeProfileId, item.provider, item.model]),
    ).toEqual([
      [teammate.id, teammate.currentRuntimeProfileId, providerA.id, 'model-a'],
      [teammate.id, teammate.currentRuntimeProfileId, providerA.id, 'model-a'],
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
    const a = await service.createTeammate(teammateInput(runtime.id, 'A'));
    const b = await service.createTeammate(teammateInput(runtime.id, 'B'));
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
    const teammate = await service.createTeammate(teammateInput(runtime.id));
    const conversation = service.createConversation(teammate.id);
    await collect(service, teammate.id, conversation.id, 'hello');
    expect(service.listUsage(teammate.id)[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('does not bind or archive Human Bridge through Gate 1 update paths', async () => {
    const { service, store } = setup();
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
    const bridge = {
      ...(await service.createTeammate(teammateInput(runtime.id))),
      currentRuntimeProfileId: null,
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
    } as const;
    store.saveTeammate(bridge);

    expect(() =>
      service.updateTeammate({
        id: bridge.id,
        name: bridge.name,
        avatar: bridge.avatar,
        title: bridge.title,
        description: bridge.description,
        identityPrompt: bridge.identityPrompt,
        behaviorPrompt: bridge.behaviorPrompt,
        currentRuntimeProfileId: runtime.id,
      }),
    ).toThrow('Human Bridge');
    expect(() =>
      service.switchRuntime({ teammateId: bridge.id, runtimeProfileId: runtime.id }),
    ).toThrow('模型已封存');
    expect(() => service.archiveTeammate(bridge.id)).toThrow('Human Bridge');
    expect(store.getTeammate(bridge.id)).toEqual(bridge);
  });
});
