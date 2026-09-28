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
  CollaborationArtifact,
  CollaborationRequest,
  McpServerConfig,
  MissionMode,
  MissionParticipant,
  ToolDescriptor,
  Party,
  PartyMember,
  ProviderConfig,
  ProviderKind,
  RuntimeProfile,
  Skill,
  SkillAssignment,
  SkillRevision,
  Teammate,
  UsageRecord,
  ExperienceEvent,
  CapabilityProfile,
  CapabilityDimension,
  ModelCapabilityBenchmark,
  CapabilityEvidence,
  ExternalAppProfile,
  ExternalWorkArtifact,
  ExternalWorkRequest,
} from '@cultivation/domain';
import type {
  R1CapabilityProfile,
  R1RatingTarget,
} from '@cultivation/application/r1-capability-service';

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
  participants: MissionParticipant[];
  collaborations: CollaborationRequest[];
  artifacts: CollaborationArtifact[];
}

export type PartyView = Party & { members: PartyMember[] };

export interface BenchmarkInput {
  runtimeProfileId: string;
  modelAlias: string;
  dimension: CapabilityDimension;
  supported: boolean;
  normalizedScore: number | null;
  rawScore: number | null;
  source: string;
  benchmark: string;
  benchmarkVersion: string;
  snapshotDate: string;
  sourceUrl: string | null;
  provenanceType: ModelCapabilityBenchmark['provenanceType'];
}

export interface RatingInput {
  missionId: string;
  runId: string;
  teammateId: string;
  runtimeProfileId: string;
  selectedDimensions: CapabilityDimension[];
  skip?: boolean;
  overallRating?: 1 | 2 | 3 | 4 | 5;
  dimensionRatings?: Partial<Record<CapabilityDimension, 1 | 2 | 3 | 4 | 5>>;
}

export interface R3DecisionConfigView {
  provider: 'TYPESAFE';
  model: 'jev-1.13.0';
  mode: 'SHADOW';
  enabled: boolean;
  configured: boolean;
  keySource: 'SAFE_STORAGE' | 'ENVIRONMENT' | 'NONE';
}

export interface R3ShadowObservationView {
  id: string;
  missionId: string | null;
  runId: string | null;
  decisionType: string;
  recommendation: string | null;
  actualAction: string | null;
  confidence: number | null;
  provider: string;
  model: string;
  questionVersion: string;
  policyVersion: string;
  latencyMs: number | null;
  inputTokens: number | null;
  status: 'SUCCESS' | 'ERROR' | 'SKIPPED';
  errorCode: string | null;
  createdAt: string;
}

export interface CultivationBridge {
  app: { getVersion(): Promise<string> };
  health: { ping(): Promise<{ status: string; database: string }> };
  r3: {
    getConfig(): Promise<R3DecisionConfigView>;
    saveKeyFromClipboard(): Promise<R3DecisionConfigView>;
    setEnabled(enabled: boolean): Promise<R3DecisionConfigView>;
    testConnection(): Promise<{ ok: boolean; message: string; model: string | null }>;
    listObservations(missionId?: string): Promise<R3ShadowObservationView[]>;
  };
  r2: {
    bridgeProfile(): Promise<{
      teammate: Teammate;
      dimensions: Array<{
        dimension: CapabilityDimension;
        enabled: boolean;
        priorScore: number | null;
        currentScore: number | null;
        ratingCount: number;
        evidenceWeight: number;
        source: string | null;
      }>;
    }>;
    updateDisplay(input: {
      name: string;
      avatar: string | null;
      title: string | null;
      description: string;
    }): Promise<Teammate>;
    setCapability(input: { dimension: CapabilityDimension; enabled: boolean }): Promise<unknown>;
    listApps(): Promise<ExternalAppProfile[]>;
    saveApp(input: {
      id?: string;
      name: string;
      vendor: string | null;
      capabilities: CapabilityDimension[];
      notes: string | null;
      enabled: boolean;
    }): Promise<ExternalAppProfile>;
    listRequests(): Promise<ExternalWorkRequest[]>;
    getRequest(
      id: string,
    ): Promise<{ request: ExternalWorkRequest; artifacts: ExternalWorkArtifact[] } | null>;
    markInProgress(id: string): Promise<ExternalWorkRequest>;
    submitArtifacts(input: {
      requestId: string;
      artifacts: Array<{ targetArtifactId: string; relativePath: string }>;
    }): Promise<ExternalWorkRequest>;
    accept(input: { requestId: string; publicResult?: string }): Promise<unknown>;
    reject(input: { requestId: string; reason?: string }): Promise<unknown>;
    cancel(input: { requestId: string }): Promise<unknown>;
    submitRating(input: {
      externalWorkRequestId: string;
      stars?: number;
      skip?: boolean;
    }): Promise<unknown>;
    copyPrompt(id: string): Promise<void>;
    openTargetFolder(id: string): Promise<void>;
    onNavigate(callback: (path: string) => void): () => void;
  };
  experience: {
    get(teammateId: string): Promise<{ events: ExperienceEvent[]; profile: CapabilityProfile }>;
  };
  capability: {
    catalog(): Promise<
      Array<{
        id: string;
        name: string;
        url: string;
        dimensions: CapabilityDimension[];
        description: string;
      }>
    >;
    benchmarks(runtimeProfileId: string): Promise<ModelCapabilityBenchmark[]>;
    priors(
      runtimeProfileId: string,
    ): Promise<Array<{ dimension: CapabilityDimension; prior: ModelCapabilityBenchmark | null }>>;
    saveBenchmark(input: BenchmarkInput): Promise<ModelCapabilityBenchmark>;
    ratingTargets(input: { missionId: string; runId: string }): Promise<R1RatingTarget[]>;
    submitRating(input: RatingInput): Promise<{ evidence: CapabilityEvidence[]; skipped: boolean }>;
    profile(teammateId: string): Promise<R1CapabilityProfile>;
    rebuild(teammateId: string): Promise<unknown>;
  };
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
      mode?: MissionMode;
      partyId?: string | null;
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
      decision: 'APPROVED' | 'DENIED' | 'ALLOW_MISSION';
    }): Promise<MissionDetail>;
    resolveCollaboration(input: {
      requestId: string;
      decision: 'APPROVED' | 'DENIED';
      externalWork?: {
        capability: CapabilityDimension;
        title: string;
        prompt: string;
        requirements: string[];
        targetArtifacts: Array<{
          id: string;
          name: string;
          required: boolean;
          allowedExtensions: string[];
          maxSizeBytes: number;
        }>;
        targetWorkspacePaths: string[];
        acceptanceCriteria: string[];
        externalAppProfileId: string | null;
      };
    }): Promise<MissionDetail>;
  };
  parties: {
    list(): Promise<PartyView[]>;
    create(input: {
      name: string;
      description: string;
      type: Party['type'];
      coordinatorTeammateId: string;
      memberTeammateIds: string[];
    }): Promise<PartyView>;
    update(input: {
      id: string;
      name: string;
      description: string;
      type: Party['type'];
      coordinatorTeammateId: string;
      memberTeammateIds: string[];
    }): Promise<PartyView>;
    archive(id: string): Promise<PartyView>;
  };
  tools: {
    getWorkspace(): Promise<{ rootPath: string | null }>;
    chooseWorkspace(): Promise<{ rootPath: string | null }>;
    listBuiltins(): Promise<ToolDescriptor[]>;
    listMcpServers(): Promise<McpServerConfig[]>;
    saveMcpServer(input: {
      id?: string;
      name: string;
      command: string;
      args: string[];
      envWhitelist: string[];
      cwd: string | null;
      enabled: boolean;
    }): Promise<McpServerConfig>;
    removeMcpServer(id: string): Promise<void>;
    refreshMcpServer(id: string): Promise<{
      status: 'READY' | 'ERROR';
      tools: ToolDescriptor[];
      message: string;
    }>;
  };
  usage: { list(teammateId?: string): Promise<UsageRecord[]> };
}

const bridge: CultivationBridge = {
  app: { getVersion: () => ipcRenderer.invoke('app:getVersion') },
  health: { ping: () => ipcRenderer.invoke('health:ping') },
  r3: {
    getConfig: () => ipcRenderer.invoke('r3:getConfig'),
    saveKeyFromClipboard: () => ipcRenderer.invoke('r3:saveKeyFromClipboard'),
    setEnabled: (enabled) => ipcRenderer.invoke('r3:setEnabled', enabled),
    testConnection: () => ipcRenderer.invoke('r3:testConnection'),
    listObservations: (missionId) => ipcRenderer.invoke('r3:listObservations', missionId),
  },
  r2: {
    bridgeProfile: () => ipcRenderer.invoke('r2:bridgeProfile'),
    updateDisplay: (input) => ipcRenderer.invoke('r2:updateDisplay', input),
    setCapability: (input) => ipcRenderer.invoke('r2:setCapability', input),
    listApps: () => ipcRenderer.invoke('r2:listApps'),
    saveApp: (input) => ipcRenderer.invoke('r2:saveApp', input),
    listRequests: () => ipcRenderer.invoke('r2:listRequests'),
    getRequest: (id) => ipcRenderer.invoke('r2:getRequest', id),
    markInProgress: (id) => ipcRenderer.invoke('r2:markInProgress', id),
    submitArtifacts: (input) => ipcRenderer.invoke('r2:submitArtifacts', input),
    accept: (input) => ipcRenderer.invoke('r2:accept', input),
    reject: (input) => ipcRenderer.invoke('r2:reject', input),
    cancel: (input) => ipcRenderer.invoke('r2:cancel', input),
    submitRating: (input) => ipcRenderer.invoke('r2:submitRating', input),
    copyPrompt: (id) => ipcRenderer.invoke('r2:copyPrompt', id),
    openTargetFolder: (id) => ipcRenderer.invoke('r2:openTargetFolder', id),
    onNavigate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string) => {
        if (path === '/external-work') callback(path);
      };
      ipcRenderer.on('r2:navigate', listener);
      return () => ipcRenderer.removeListener('r2:navigate', listener);
    },
  },
  experience: { get: (teammateId) => ipcRenderer.invoke('experience:get', teammateId) },
  capability: {
    catalog: () => ipcRenderer.invoke('capability:catalog'),
    benchmarks: (runtimeProfileId) => ipcRenderer.invoke('capability:benchmarks', runtimeProfileId),
    priors: (runtimeProfileId) => ipcRenderer.invoke('capability:priors', runtimeProfileId),
    saveBenchmark: (input) => ipcRenderer.invoke('capability:saveBenchmark', input),
    ratingTargets: (input) => ipcRenderer.invoke('capability:ratingTargets', input),
    submitRating: (input) => ipcRenderer.invoke('capability:submitRating', input),
    profile: (teammateId) => ipcRenderer.invoke('capability:profile', teammateId),
    rebuild: (teammateId) => ipcRenderer.invoke('capability:rebuild', teammateId),
  },
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
    resolveCollaboration: (input) => ipcRenderer.invoke('missions:resolveCollaboration', input),
  },
  parties: {
    list: () => ipcRenderer.invoke('parties:list'),
    create: (input) => ipcRenderer.invoke('parties:create', input),
    update: (input) => ipcRenderer.invoke('parties:update', input),
    archive: (id) => ipcRenderer.invoke('parties:archive', id),
  },
  tools: {
    getWorkspace: () => ipcRenderer.invoke('tools:getWorkspace'),
    chooseWorkspace: () => ipcRenderer.invoke('tools:chooseWorkspace'),
    listBuiltins: () => ipcRenderer.invoke('tools:listBuiltins'),
    listMcpServers: () => ipcRenderer.invoke('tools:listMcpServers'),
    saveMcpServer: (input) => ipcRenderer.invoke('tools:saveMcpServer', input),
    removeMcpServer: (id) => ipcRenderer.invoke('tools:removeMcpServer', id),
    refreshMcpServer: (id) => ipcRenderer.invoke('tools:refreshMcpServer', id),
  },
  usage: { list: (teammateId) => ipcRenderer.invoke('usage:list', teammateId) },
};

contextBridge.exposeInMainWorld('cultivation', bridge);
