import { contextBridge, ipcRenderer } from 'electron';
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

export type ChatStreamEvent =
  | {
      type: 'delta';
      requestId: string;
      teammateId: string;
      conversationId: string;
      text: string;
    }
  | {
      type: 'done';
      requestId: string;
      teammateId: string;
      conversationId: string;
      assistantMessage: Message;
    }
  | {
      type: 'error';
      requestId: string;
      teammateId: string;
      conversationId: string;
      message: string;
    };

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string | null;
}
export interface RuntimeInput {
  name: string;
  providerId: string;
  credentialId: string | null;
  modelId: string;
}
export interface TeammateInput {
  name: string;
  avatar: string | null;
  title: string | null;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
  currentRuntimeProfileId: string;
}

export interface CultivationBridge {
  app: { getVersion(): Promise<string> };
  health: { ping(): Promise<{ status: string; database: string }> };
  providers: {
    list(): Promise<ProviderConfig[]>;
    create(input: ProviderInput): Promise<ProviderConfig>;
  };
  credentials: {
    list(providerId?: string): Promise<CredentialSummary[]>;
    create(input: { providerId: string; label: string }): Promise<CredentialSummary>;
  };
  runtimes: {
    list(): Promise<RuntimeProfile[]>;
    create(input: RuntimeInput): Promise<RuntimeProfile>;
    update(input: RuntimeInput & { id: string }): Promise<RuntimeProfile>;
    testConnection(runtimeProfileId: string): Promise<{ ok: boolean; message: string }>;
  };
  teammates: {
    list(): Promise<Teammate[]>;
    create(input: TeammateInput): Promise<Teammate>;
    update(input: TeammateInput & { id: string }): Promise<Teammate>;
    archive(id: string): Promise<Teammate>;
    duplicate(id: string): Promise<Teammate>;
    switchRuntime(input: { teammateId: string; runtimeProfileId: string }): Promise<Teammate>;
  };
  chat: {
    listConversations(teammateId: string): Promise<Conversation[]>;
    createConversation(teammateId: string): Promise<Conversation>;
    listMessages(input: { teammateId: string; conversationId: string }): Promise<Message[]>;
    send(input: {
      requestId: string;
      teammateId: string;
      conversationId: string;
      text: string;
    }): Promise<{ requestId: string; conversationId: string }>;
    onEvent(callback: (event: ChatStreamEvent) => void): () => void;
  };
  usage: { list(teammateId?: string): Promise<UsageRecord[]> };
}

const bridge: CultivationBridge = {
  app: { getVersion: () => ipcRenderer.invoke('app:getVersion') },
  health: { ping: () => ipcRenderer.invoke('health:ping') },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    create: (input) => ipcRenderer.invoke('providers:create', input),
  },
  credentials: {
    list: (providerId) => ipcRenderer.invoke('credentials:list', providerId),
    create: (input) => ipcRenderer.invoke('credentials:create', input),
  },
  runtimes: {
    list: () => ipcRenderer.invoke('runtimes:list'),
    create: (input) => ipcRenderer.invoke('runtimes:create', input),
    update: (input) => ipcRenderer.invoke('runtimes:update', input),
    testConnection: (runtimeProfileId) =>
      ipcRenderer.invoke('runtimes:testConnection', runtimeProfileId),
  },
  teammates: {
    list: () => ipcRenderer.invoke('teammates:list'),
    create: (input) => ipcRenderer.invoke('teammates:create', input),
    update: (input) => ipcRenderer.invoke('teammates:update', input),
    archive: (id) => ipcRenderer.invoke('teammates:archive', id),
    duplicate: (id) => ipcRenderer.invoke('teammates:duplicate', id),
    switchRuntime: (input) => ipcRenderer.invoke('teammates:switchRuntime', input),
  },
  chat: {
    listConversations: (teammateId) => ipcRenderer.invoke('chat:listConversations', teammateId),
    createConversation: (teammateId) => ipcRenderer.invoke('chat:createConversation', teammateId),
    listMessages: (input) => ipcRenderer.invoke('chat:listMessages', input),
    send: (input) => ipcRenderer.invoke('chat:send', input),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ChatStreamEvent) =>
        callback(payload);
      ipcRenderer.on('chat:event', listener);
      return () => ipcRenderer.removeListener('chat:event', listener);
    },
  },
  usage: { list: (teammateId) => ipcRenderer.invoke('usage:list', teammateId) },
};

contextBridge.exposeInMainWorld('cultivation', bridge);
