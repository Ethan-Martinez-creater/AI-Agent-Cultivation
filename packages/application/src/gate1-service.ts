import type {
  Conversation,
  CredentialSummary,
  Message,
  ProviderConfig,
  ProviderKind,
  RuntimeProfile,
  Teammate,
  UsageRecord,
} from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type { ModelGateway, ModelUsage, SecretStore } from './index.js';

export interface StoredCredential extends CredentialSummary {
  ciphertext: Uint8Array;
}

/** Main-only persistence port. The credential record never crosses IPC. */
export interface Gate1Store {
  listProviders(): ProviderConfig[];
  getProvider(id: string): ProviderConfig | null;
  saveProvider(value: ProviderConfig): void;
  listCredentials(providerId?: string): CredentialSummary[];
  getCredential(id: string): StoredCredential | null;
  saveCredential(value: StoredCredential): void;
  listRuntimeProfiles(): RuntimeProfile[];
  getRuntimeProfile(id: string): RuntimeProfile | null;
  saveRuntimeProfile(value: RuntimeProfile): void;
  listTeammates(): Teammate[];
  getTeammate(id: string): Teammate | null;
  saveTeammate(value: Teammate): void;
  listConversations(teammateId: string): Conversation[];
  getConversation(id: string): Conversation | null;
  saveConversation(value: Conversation): void;
  listMessages(teammateId: string, conversationId: string): Message[];
  saveMessage(value: Message): void;
  listUsage(teammateId?: string): UsageRecord[];
  saveUsage(value: UsageRecord): void;
}

export type ChatUpdate =
  | { type: 'delta'; text: string }
  | { type: 'done'; assistantMessage: Message };

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function required(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new DomainError('INVALID_INPUT', `${label}不能为空`);
  return result;
}

function notFound(label: string): never {
  throw new DomainError('NOT_FOUND', `${label}不存在`);
}

export class Gate1Service {
  private readonly activeConversations = new Set<string>();

  constructor(
    private readonly store: Gate1Store,
    private readonly secrets: SecretStore,
    private readonly gateway: ModelGateway,
  ) {}

  listProviders(): ProviderConfig[] {
    return this.store.listProviders();
  }

  createProvider(input: {
    name: string;
    kind: ProviderKind;
    baseUrl?: string | null;
  }): ProviderConfig {
    const baseUrl = input.baseUrl?.trim() || null;
    if (input.kind === 'OPENAI_COMPATIBLE' && !baseUrl) {
      throw new DomainError('INVALID_INPUT', 'OpenAI-Compatible 服务需要 Base URL');
    }
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        if (
          parsed.protocol !== 'https:' &&
          !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))
        ) {
          throw new Error('invalid protocol');
        }
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          throw new Error('credentials or query in URL');
        }
      } catch {
        throw new DomainError('INVALID_INPUT', 'Base URL 必须是 HTTPS 或本机 HTTP 地址');
      }
    }
    const timestamp = now();
    const provider: ProviderConfig = {
      id: id(),
      name: required(input.name, 'Provider 名称'),
      kind: input.kind,
      baseUrl,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.saveProvider(provider);
    return provider;
  }

  listCredentials(providerId?: string): CredentialSummary[] {
    return this.store.listCredentials(providerId);
  }

  async createCredential(input: {
    providerId: string;
    label: string;
    apiKey: string;
  }): Promise<CredentialSummary> {
    if (!this.store.getProvider(input.providerId)) notFound('Provider');
    const key = required(input.apiKey, 'API Key');
    const timestamp = now();
    const summary: CredentialSummary = {
      id: id(),
      providerId: input.providerId,
      label: required(input.label, '凭证标签'),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const ciphertext = await this.secrets.encrypt(key);
    this.store.saveCredential({ ...summary, ciphertext });
    return summary;
  }

  listRuntimeProfiles(): RuntimeProfile[] {
    return this.store.listRuntimeProfiles();
  }

  private validateRuntimeBinding(providerId: string, credentialId: string | null): void {
    const provider = this.store.getProvider(providerId);
    if (!provider) notFound('Provider');
    if (!provider.enabled) throw new DomainError('INVALID_INPUT', 'Provider 已停用');
    if (credentialId) {
      const credential = this.store.getCredential(credentialId);
      if (!credential || credential.providerId !== providerId) {
        throw new DomainError('INVALID_INPUT', '凭证与 Provider 不匹配');
      }
    } else if (provider.kind !== 'OPENAI_COMPATIBLE') {
      throw new DomainError('INVALID_INPUT', '此 Provider 需要凭证');
    }
  }

  createRuntimeProfile(input: {
    name: string;
    providerId: string;
    credentialId: string | null;
    modelId: string;
  }): RuntimeProfile {
    this.validateRuntimeBinding(input.providerId, input.credentialId);
    const timestamp = now();
    const runtime: RuntimeProfile = {
      id: id(),
      name: required(input.name, '运行配置名称'),
      providerId: input.providerId,
      credentialId: input.credentialId,
      modelId: required(input.modelId, 'Model ID'),
      parameters: {},
      capabilityOverrides: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.saveRuntimeProfile(runtime);
    return runtime;
  }

  updateRuntimeProfile(input: {
    id: string;
    name: string;
    providerId: string;
    credentialId: string | null;
    modelId: string;
  }): RuntimeProfile {
    const previous = this.store.getRuntimeProfile(input.id);
    if (!previous) notFound('RuntimeProfile');
    this.validateRuntimeBinding(input.providerId, input.credentialId);
    const runtime: RuntimeProfile = {
      ...previous,
      name: required(input.name, '运行配置名称'),
      providerId: input.providerId,
      credentialId: input.credentialId,
      modelId: required(input.modelId, 'Model ID'),
      updatedAt: now(),
    };
    this.store.saveRuntimeProfile(runtime);
    return runtime;
  }

  /** Called only from Main's model resolver; never register it as an IPC method. */
  async resolveRuntime(id: string): Promise<{
    kind: ProviderKind;
    baseUrl: string | null;
    modelId: string;
    apiKey: string;
    parameters: Record<string, unknown>;
  }> {
    const runtime = this.store.getRuntimeProfile(id);
    if (!runtime) notFound('RuntimeProfile');
    const provider = this.store.getProvider(runtime.providerId);
    if (!provider || !provider.enabled) notFound('Provider');
    const credential = runtime.credentialId ? this.store.getCredential(runtime.credentialId) : null;
    if (runtime.credentialId && (!credential || credential.providerId !== provider.id)) {
      throw new DomainError('INVALID_INPUT', '运行配置凭证不匹配');
    }
    return {
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      modelId: runtime.modelId,
      apiKey: credential ? await this.secrets.decrypt(credential.ciphertext) : '',
      parameters: runtime.parameters,
    };
  }

  async testConnection(runtimeProfileId: string): Promise<{ ok: boolean; message: string }> {
    if (!this.store.getRuntimeProfile(runtimeProfileId)) notFound('RuntimeProfile');
    try {
      const result = await this.gateway.testConnection(runtimeProfileId);
      return { ok: result.ok, message: result.ok ? '连接成功' : '连接失败，请检查模型与凭证' };
    } catch {
      return { ok: false, message: '连接失败，请检查模型、凭证与网络' };
    }
  }

  listTeammates(): Teammate[] {
    return this.store.listTeammates();
  }

  private requireRuntime(id: string): void {
    if (!this.store.getRuntimeProfile(id)) notFound('RuntimeProfile');
  }

  createTeammate(input: {
    name: string;
    avatar: string | null;
    title: string | null;
    description: string;
    identityPrompt: string;
    behaviorPrompt: string;
    currentRuntimeProfileId: string;
  }): Teammate {
    this.requireRuntime(input.currentRuntimeProfileId);
    const timestamp = now();
    const teammate: Teammate = {
      id: id(),
      name: required(input.name, '道友名称'),
      avatar: input.avatar || null,
      title: input.title || null,
      description: input.description,
      identityPrompt: input.identityPrompt,
      behaviorPrompt: input.behaviorPrompt,
      status: 'ACTIVE',
      realm: 'QI_REFINING',
      currentRuntimeProfileId: input.currentRuntimeProfileId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.saveTeammate(teammate);
    return teammate;
  }

  updateTeammate(input: {
    id: string;
    name: string;
    avatar: string | null;
    title: string | null;
    description: string;
    identityPrompt: string;
    behaviorPrompt: string;
    currentRuntimeProfileId: string;
  }): Teammate {
    const previous = this.store.getTeammate(input.id);
    if (!previous) notFound('道友');
    this.requireRuntime(input.currentRuntimeProfileId);
    const teammate: Teammate = {
      ...previous,
      name: required(input.name, '道友名称'),
      avatar: input.avatar || null,
      title: input.title || null,
      description: input.description,
      identityPrompt: input.identityPrompt,
      behaviorPrompt: input.behaviorPrompt,
      currentRuntimeProfileId: input.currentRuntimeProfileId,
      updatedAt: now(),
    };
    this.store.saveTeammate(teammate);
    return teammate;
  }

  archiveTeammate(teammateId: string): Teammate {
    const previous = this.store.getTeammate(teammateId);
    if (!previous) notFound('道友');
    const teammate = { ...previous, status: 'ARCHIVED' as const, updatedAt: now() };
    this.store.saveTeammate(teammate);
    return teammate;
  }

  duplicateTeammate(teammateId: string): Teammate {
    const previous = this.store.getTeammate(teammateId);
    if (!previous) notFound('道友');
    if (!previous.currentRuntimeProfileId)
      throw new DomainError('INVALID_INPUT', '原道友没有运行配置');
    return this.createTeammate({
      name: `${previous.name} 副本`,
      avatar: previous.avatar,
      title: previous.title,
      description: previous.description,
      identityPrompt: previous.identityPrompt,
      behaviorPrompt: previous.behaviorPrompt,
      currentRuntimeProfileId: previous.currentRuntimeProfileId,
    });
  }

  switchRuntime(input: { teammateId: string; runtimeProfileId: string }): Teammate {
    const previous = this.store.getTeammate(input.teammateId);
    if (!previous) notFound('道友');
    this.requireRuntime(input.runtimeProfileId);
    const teammate = {
      ...previous,
      currentRuntimeProfileId: input.runtimeProfileId,
      updatedAt: now(),
    };
    this.store.saveTeammate(teammate);
    return teammate;
  }

  listConversations(teammateId: string): Conversation[] {
    if (!this.store.getTeammate(teammateId)) notFound('道友');
    return this.store.listConversations(teammateId);
  }

  createConversation(teammateId: string): Conversation {
    const teammate = this.store.getTeammate(teammateId);
    if (!teammate) notFound('道友');
    if (teammate.status !== 'ACTIVE')
      throw new DomainError('INVALID_INPUT', '已归档道友不可新建对话');
    const timestamp = now();
    const conversation = { id: id(), teammateId, createdAt: timestamp, updatedAt: timestamp };
    this.store.saveConversation(conversation);
    return conversation;
  }

  listMessages(teammateId: string, conversationId: string): Message[] {
    this.requireConversation(teammateId, conversationId);
    return this.store.listMessages(teammateId, conversationId);
  }

  private requireConversation(teammateId: string, conversationId: string): void {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation || conversation.teammateId !== teammateId) notFound('对话');
  }

  listUsage(teammateId?: string): UsageRecord[] {
    if (teammateId && !this.store.getTeammate(teammateId)) notFound('道友');
    return this.store.listUsage(teammateId);
  }

  private usageRecord(
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
      providerMetadata: null,
      estimatedCost: null,
      currency: null,
      createdAt: now(),
    };
  }

  async *streamChat(input: {
    teammateId: string;
    conversationId: string;
    text: string;
  }): AsyncIterable<ChatUpdate> {
    const teammate = this.store.getTeammate(input.teammateId);
    if (!teammate) notFound('道友');
    if (teammate.status !== 'ACTIVE')
      throw new DomainError('INVALID_INPUT', '已归档道友不可发送消息');
    this.requireConversation(input.teammateId, input.conversationId);
    if (this.activeConversations.has(input.conversationId)) {
      throw new DomainError('CHAT_BUSY', '该对话正在生成回复');
    }
    if (!teammate.currentRuntimeProfileId)
      throw new DomainError('INVALID_INPUT', '道友没有运行配置');
    const runtime = this.store.getRuntimeProfile(teammate.currentRuntimeProfileId);
    if (!runtime) notFound('RuntimeProfile');
    const text = required(input.text, '消息');
    this.activeConversations.add(input.conversationId);
    try {
      const userMessage: Message = {
        id: id(),
        missionId: null,
        conversationId: input.conversationId,
        actorType: 'USER',
        actorId: 'local-user',
        role: 'USER',
        content: text,
        createdAt: now(),
      };
      this.store.saveMessage(userMessage);
      const history = this.store.listMessages(input.teammateId, input.conversationId);
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      if (teammate.identityPrompt.trim())
        messages.push({ role: 'system', content: teammate.identityPrompt });
      if (teammate.behaviorPrompt.trim())
        messages.push({ role: 'system', content: teammate.behaviorPrompt });
      for (const message of history) {
        if (message.role === 'USER') messages.push({ role: 'user', content: message.content });
        if (message.role === 'ASSISTANT')
          messages.push({ role: 'assistant', content: message.content });
      }
      let answer = '';
      let usage: ModelUsage | null = null;
      let modelCalled = false;
      let usageRecorded = false;
      try {
        modelCalled = true;
        for await (const event of this.gateway.stream({
          teammateId: teammate.id,
          runtimeProfileId: runtime.id,
          messages,
        })) {
          if (event.type === 'text-delta') {
            answer += event.text;
            yield { type: 'delta', text: event.text };
          } else if (event.type === 'finish') {
            usage = event.usage;
          }
        }
        if (!usage) throw new Error('missing finish event');
        const assistantMessage: Message = {
          id: id(),
          missionId: null,
          conversationId: input.conversationId,
          actorType: 'TEAMMATE',
          actorId: teammate.id,
          role: 'ASSISTANT',
          content: answer,
          createdAt: now(),
        };
        this.store.saveUsage(this.usageRecord(teammate.id, runtime, usage));
        usageRecorded = true;
        this.store.saveMessage(assistantMessage);
        yield { type: 'done', assistantMessage };
      } catch {
        if (modelCalled && !usageRecorded) {
          this.store.saveUsage(this.usageRecord(teammate.id, runtime, null));
        }
        throw new DomainError('MODEL_CALL_FAILED', '模型调用失败，请检查配置与网络');
      }
    } finally {
      this.activeConversations.delete(input.conversationId);
    }
  }
}
