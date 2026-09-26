import { contextBridge, ipcRenderer } from 'electron';
import type {
  Conversation,
  CredentialSummary,
  Message,
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  Mission,
  MissionRun,
  MissionEvent,
  AuditEvent,
  ApprovalRequest,
  ProviderConfig,
  ProviderKind,
  RuntimeProfile,
  Skill,
  SkillAssignment,
  SkillRevision,
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

export interface MemoryInput {
  teammateId: string;
  memoryType: MemoryType;
  content: string;
  summary: string;
  importance: number;
}
export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  tags: string[];
}

export interface MissionDetail {
  mission: Mission;
  runs: MissionRun[];
  events: MissionEvent[];
  audits: AuditEvent[];
  approvals: ApprovalRequest[];
  usage: UsageRecord[];
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
  memories: {
    list(teammateId: string, status?: MemoryStatus): Promise<MemoryRecord[]>;
    create(input: MemoryInput): Promise<MemoryRecord>;
    update(input: MemoryInput & { id: string }): Promise<MemoryRecord>;
    archive(input: { teammateId: string; id: string }): Promise<MemoryRecord>;
    accept(input: {
      teammateId: string;
      id: string;
      edits?: Partial<Pick<MemoryRecord, 'memoryType' | 'content' | 'summary' | 'importance'>>;
    }): Promise<MemoryRecord>;
    reject(input: { teammateId: string; id: string }): Promise<MemoryRecord>;
    proposeFromMessage(input: {
      teammateId: string;
      conversationId: string;
      messageId: string;
    }): Promise<MemoryRecord[]>;
  };
  embedding: {
    getConfig(): Promise<{ available: boolean; runtimeProfileId: string | null }>;
    setConfig(
      runtimeProfileId: string | null,
    ): Promise<{ available: boolean; runtimeProfileId: string | null }>;
    reindex(teammateId: string): Promise<{ indexed: number; total: number }>;
  };
  skills: {
    list(): Promise<Skill[]>;
    create(input: SkillInput): Promise<Skill>;
    update(input: SkillInput & { id: string }): Promise<Skill>;
    archive(id: string): Promise<Skill>;
    listRevisions(id: string): Promise<SkillRevision[]>;
    listAssignments(teammateId: string): Promise<SkillAssignment[]>;
    assign(input: { teammateId: string; skillId: string }): Promise<SkillAssignment>;
    unassign(input: { teammateId: string; skillId: string }): Promise<void>;
    setEnabled(input: {
      teammateId: string;
      skillId: string;
      enabled: boolean;
    }): Promise<SkillAssignment>;
  };
  missions: {
    list(): Promise<Mission[]>;
    detail(id: string): Promise<MissionDetail>;
    create(input: {
      title: string;
      objective: string;
      coordinatorTeammateId: string;
    }): Promise<Mission>;
    update(input: { id: string; title: string; objective: string }): Promise<Mission>;
    ready(id: string): Promise<Mission>;
    start(input: { missionId: string; approvalFixture: boolean }): Promise<MissionDetail>;
    retry(input: { missionId: string; approvalFixture: boolean }): Promise<MissionDetail>;
    pause(id: string): Promise<Mission>;
    resume(id: string): Promise<MissionDetail>;
    cancel(id: string): Promise<Mission>;
    resolveApproval(input: {
      approvalId: string;
      decision: 'APPROVED' | 'DENIED';
    }): Promise<MissionDetail>;
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
  memories: {
    list: (teammateId, status) => ipcRenderer.invoke('memories:list', { teammateId, status }),
    create: (input) => ipcRenderer.invoke('memories:create', input),
    update: (input) => ipcRenderer.invoke('memories:update', input),
    archive: (input) => ipcRenderer.invoke('memories:archive', input),
    accept: (input) => ipcRenderer.invoke('memories:accept', input),
    reject: (input) => ipcRenderer.invoke('memories:reject', input),
    proposeFromMessage: (input) => ipcRenderer.invoke('memories:proposeFromMessage', input),
  },
  embedding: {
    getConfig: () => ipcRenderer.invoke('embedding:getConfig'),
    setConfig: (runtimeProfileId) =>
      ipcRenderer.invoke('embedding:setConfig', { runtimeProfileId }),
    reindex: (teammateId) => ipcRenderer.invoke('embedding:reindex', { teammateId }),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    create: (input) => ipcRenderer.invoke('skills:create', input),
    update: (input) => ipcRenderer.invoke('skills:update', input),
    archive: (id) => ipcRenderer.invoke('skills:archive', id),
    listRevisions: (id) => ipcRenderer.invoke('skills:listRevisions', id),
    listAssignments: (teammateId) => ipcRenderer.invoke('skills:listAssignments', teammateId),
    assign: (input) => ipcRenderer.invoke('skills:assign', input),
    unassign: (input) => ipcRenderer.invoke('skills:unassign', input),
    setEnabled: (input) => ipcRenderer.invoke('skills:setEnabled', input),
  },
  missions: {
    list: () => ipcRenderer.invoke('missions:list'),
    detail: (id) => ipcRenderer.invoke('missions:detail', id),
    create: (input) => ipcRenderer.invoke('missions:create', input),
    update: (input) => ipcRenderer.invoke('missions:update', input),
    ready: (id) => ipcRenderer.invoke('missions:ready', id),
    start: (input) => ipcRenderer.invoke('missions:start', input),
    retry: (input) => ipcRenderer.invoke('missions:retry', input),
    pause: (id) => ipcRenderer.invoke('missions:pause', id),
    resume: (id) => ipcRenderer.invoke('missions:resume', id),
    cancel: (id) => ipcRenderer.invoke('missions:cancel', id),
    resolveApproval: (input) => ipcRenderer.invoke('missions:resolveApproval', input),
  },
  usage: { list: (teammateId) => ipcRenderer.invoke('usage:list', teammateId) },
};

contextBridge.exposeInMainWorld('cultivation', bridge);
