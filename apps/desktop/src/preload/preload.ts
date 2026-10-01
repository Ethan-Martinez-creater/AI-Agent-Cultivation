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
  ExternalAppProfile,
  ExternalWorkArtifact,
  ExternalWorkRequest,
  ModelAvailabilityProjection,
  RoutingTaskContext,
  RoutingDecisionReceipt,
  WorkflowDetail,
  WorkflowRun,
  WorkflowVersion,
} from '@cultivation/domain';
import type { RoutingMissionCreationResult } from '@cultivation/application';
import type { AvailabilityService } from '@cultivation/application';
import type { R1CapabilityProfile } from '@cultivation/application/r1-capability-service';

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
      code?: 'MODEL_UNAVAILABLE';
      availability?: Awaited<ReturnType<AvailabilityService['prepare']>>;
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
  routing: {
    config(): Promise<{ cloudEnabled: boolean; policyVersion: string }>;
    setCloudEnabled(enabled: boolean): Promise<{ cloudEnabled: boolean; policyVersion: string }>;
    createMission(input: {
      title: string;
      context: RoutingTaskContext;
    }): Promise<RoutingMissionCreationResult>;
    receipts(missionId?: string): Promise<RoutingDecisionReceipt[]>;
  };
  desktop: {
    windowState(): Promise<{ maximized: boolean }>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    copyText(text: string): Promise<void>;
    onWindowStateChanged(callback: (state: { maximized: boolean }) => void): () => void;
  };
  avatars: {
    import(): Promise<string | null>;
    read(ref: string): Promise<string | null>;
  };
  availability: {
    list(): Promise<ModelAvailabilityProjection[]>;
    recheck(teammateId: string): Promise<ModelAvailabilityProjection>;
    prepare(teammateId: string): ReturnType<AvailabilityService['prepare']>;
    onChanged(callback: (projection: ModelAvailabilityProjection) => void): () => void;
  };
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
    rotate(credentialId: string): Promise<CredentialSummary>;
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
  workflows: {
    versions(): Promise<WorkflowVersion[]>;
    list(): Promise<WorkflowRun[]>;
    detail(id: string): Promise<WorkflowDetail>;
    create(input: { definitionId: string; version: number }): Promise<WorkflowDetail>;
    advance(id: string): Promise<WorkflowDetail>;
    retryMission(id: string): Promise<WorkflowDetail>;
    retryStep(id: string): Promise<WorkflowDetail>;
    pause(id: string): Promise<WorkflowDetail>;
    resume(id: string): Promise<WorkflowDetail>;
    cancel(id: string): Promise<WorkflowDetail>;
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
  routing: {
    config: () => ipcRenderer.invoke('routing:config'),
    setCloudEnabled: (enabled) => ipcRenderer.invoke('routing:setCloudEnabled', enabled),
    createMission: (input) => ipcRenderer.invoke('routing:createMission', input),
    receipts: (missionId) => ipcRenderer.invoke('routing:receipts', missionId),
  },
  desktop: {
    windowState: () => ipcRenderer.invoke('desktop:windowState'),
    minimize: () => ipcRenderer.invoke('desktop:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('desktop:toggleMaximize'),
    close: () => ipcRenderer.invoke('desktop:close'),
    copyText: (text) => ipcRenderer.invoke('desktop:copyText', text),
    onWindowStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: { maximized: boolean }) =>
        callback(state);
      ipcRenderer.on('desktop:windowStateChanged', listener);
      return () => ipcRenderer.removeListener('desktop:windowStateChanged', listener);
    },
  },
  avatars: {
    import: () => ipcRenderer.invoke('avatars:import'),
    read: (ref) => ipcRenderer.invoke('avatars:read', ref),
  },
  availability: {
    list: () => ipcRenderer.invoke('availability:list'),
    recheck: (teammateId) => ipcRenderer.invoke('availability:recheck', teammateId),
    prepare: (teammateId) => ipcRenderer.invoke('availability:prepare', teammateId),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: ModelAvailabilityProjection) =>
        callback(value);
      ipcRenderer.on('availability:event', listener);
      return () => ipcRenderer.removeListener('availability:event', listener);
    },
  },
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
    rotate: (credentialId) => ipcRenderer.invoke('credentials:rotate', credentialId),
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
  workflows: {
    versions: () => ipcRenderer.invoke('workflows:versions'),
    list: () => ipcRenderer.invoke('workflows:list'),
    detail: (id) => ipcRenderer.invoke('workflows:detail', id),
    create: (input) => ipcRenderer.invoke('workflows:create', input),
    advance: (id) => ipcRenderer.invoke('workflows:advance', id),
    retryMission: (id) => ipcRenderer.invoke('workflows:retryMission', id),
    retryStep: (id) => ipcRenderer.invoke('workflows:retryStep', id),
    pause: (id) => ipcRenderer.invoke('workflows:pause', id),
    resume: (id) => ipcRenderer.invoke('workflows:resume', id),
    cancel: (id) => ipcRenderer.invoke('workflows:cancel', id),
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
