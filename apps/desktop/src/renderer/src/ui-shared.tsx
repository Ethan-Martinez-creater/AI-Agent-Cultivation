import React from 'react';
import type { BenchmarkInput, CultivationBridge as PreloadBridge } from '../../preload/preload.js';
import type { CapabilityDimension, ModelCapabilityBenchmark } from '@cultivation/domain';
import type { R1CapabilityProfile } from '@cultivation/application/r1-capability-service';
import { type HumanBridgeApprovalInput, type R2UiApi } from './r2-human-bridge.js';

export type ProviderKind = 'OPENAI' | 'ANTHROPIC' | 'GOOGLE' | 'DEEPSEEK' | 'OPENAI_COMPATIBLE';

export type TeammateStatus = 'ACTIVE' | 'ARCHIVED';

export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';

export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
}

export interface CredentialView {
  id: string;
  providerId: string;
  label: string;
}

export interface RuntimeProfileView {
  id: string;
  name: string;
  providerId: string;
  credentialId: string | null;
  modelId: string;
}

export interface TeammateView {
  id: string;
  name: string;
  avatar: string | null;
  title: string | null;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
  currentRuntimeProfileId: string | null;
  executorKind?: 'MODEL_RUNTIME' | 'USER_BRIDGE';
  routingPolicy?: 'NORMAL' | 'FALLBACK_ONLY' | 'MANUAL_ONLY';
  systemKind?: 'HUMAN_BRIDGE' | null;
  status: TeammateStatus;
}

export interface ConversationView {
  id: string;
  teammateId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageView {
  id: string;
  missionId: string | null;
  conversationId: string;
  actorType: 'USER' | 'TEAMMATE' | 'SYSTEM';
  actorId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export type MemoryType =
  | 'IDENTITY'
  | 'PREFERENCE'
  | 'FACT'
  | 'EPISODE'
  | 'PROCEDURE'
  | 'OBSERVATION';

export type MemoryStatus = 'PROPOSED' | 'ACTIVE' | 'REJECTED' | 'ARCHIVED';

export type MemorySourceType = 'MANUAL' | 'CHAT_EXTRACTION';

export interface MemoryView {
  id: string;
  ownerType: 'TEAMMATE';
  ownerId: string;
  memoryType: MemoryType;
  content: string;
  summary: string;
  sourceType: MemorySourceType;
  sourceId: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  confirmedAt: string | null;
}

export interface SkillView {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tags: string[];
  version: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export interface SkillAssignmentView {
  teammateId: string;
  skillId: string;
  enabled: boolean;
}

export interface UsageView {
  id?: string;
  missionId?: string | null;
  runId?: string | null;
  teammateId: string;
  runtimeProfileId: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

export type ExperienceType =
  | 'MISSION_RESULT'
  | 'COLLABORATION'
  | 'TOOL_USE'
  | 'SKILL_USE'
  | 'EXTERNAL_WORK';

export type ExperienceOutcome = 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

export interface ExperienceEventView {
  id: string;
  teammateId: string;
  missionId: string;
  runId: string;
  experienceType: ExperienceType;
  source: string;
  sourceId: string;
  role: string;
  outcome: ExperienceOutcome;
  mode: MissionMode;
  createdAt: string;
}

export interface CapabilityProfileView {
  teammateId: string;
  completedMissions: number;
  failedMissions: number;
  cancelledMissions: number;
  consultationParticipations: number;
  reviewParticipations: number;
  delegationParticipations: number;
  toolUses: number;
  completedCollaborations: number;
  skillUses: number;
  lastActiveAt: string | null;
}

export interface TeammateExperienceView {
  events: ExperienceEventView[];
  profile: CapabilityProfileView;
}

export type PartyType = 'FIXED' | 'AD_HOC';

export type MissionMode = 'SOLO' | 'CONSULTATION' | 'REVIEW' | 'DELEGATION';

export interface PartyMemberView {
  teammateId: string;
  role: 'COORDINATOR' | 'MEMBER';
  order: number;
}

export interface PartyView {
  id: string;
  name: string;
  description: string;
  type: PartyType;
  status: 'ACTIVE' | 'ARCHIVED';
  coordinatorTeammateId: string;
  members: PartyMemberView[];
  createdAt: string;
}

export type MissionState =
  | 'DRAFT'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_COLLABORATION'
  | 'WAITING_EXTERNAL_WORK'
  | 'PAUSED'
  | 'INTERRUPTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface MissionView {
  id: string;
  title: string;
  objective: string;
  coordinatorTeammateId: string;
  mode: MissionMode;
  partyId?: string | null;
  state: MissionState;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationRequestView {
  id: string;
  missionId: string;
  runId: string;
  requesterTeammateId: string;
  targetTeammateId: string;
  reason: string;
  proposedTask: string;
  expectedBenefit: string;
  depth: number;
  state: 'PENDING' | 'APPROVED' | 'DENIED' | 'STARTED' | 'COMPLETED' | 'FAILED' | string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MissionParticipantView {
  missionId: string;
  teammateId: string;
  role: string;
  sortOrder: number;
}

export interface CollaborationArtifactView {
  id: string;
  missionId: string;
  runId: string;
  teammateId: string;
  kind: 'MEMBER_RESULT' | 'DRAFT' | 'REVIEW' | 'FINAL';
  content: string;
  createdAt: string;
}

export interface MissionRunView {
  id: string;
  missionId: string;
  attempt: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultText: string | null;
}

export interface MissionEventView {
  id: string;
  missionId: string;
  runId: string | null;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payloadJson: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalRequestView {
  id: string;
  missionId: string;
  runId: string;
  requesterTeammateId: string;
  capability: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  riskLevel: string;
  state: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ToolDescriptorView {
  id: string;
  name: string;
  description: string;
  source: 'BUILTIN' | 'MCP';
  capability: string;
  inputSchema: unknown;
  riskLevel: string;
  sideEffect: boolean;
}

export interface McpServerConfigView {
  id: string;
  name: string;
  command: string;
  args: string[];
  envWhitelist: string[];
  cwd: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpRefreshResult {
  status: 'READY' | 'ERROR';
  tools: ToolDescriptorView[];
  message: string;
}

export interface AuditEventView {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payloadJson: Record<string, unknown>;
  createdAt: string;
}

export interface MissionDetailView {
  mission: MissionView;
  runs: MissionRunView[];
  events: MissionEventView[];
  approvals: ApprovalRequestView[];
  audits: AuditEventView[];
  usage: UsageView[];
  participants: MissionParticipantView[];
  collaborations: CollaborationRequestView[];
  artifacts: CollaborationArtifactView[];
}

export interface ChatEvent {
  type: 'delta' | 'done' | 'error';
  requestId: string;
  teammateId: string;
  conversationId: string;
  text?: string;
  assistantMessage?: MessageView;
  message?: string;
  code?: 'MODEL_UNAVAILABLE';
}

export interface CultivationBridge {
  routing: PreloadBridge['routing'];
  desktop: PreloadBridge['desktop'];
  avatars: PreloadBridge['avatars'];
  availability: PreloadBridge['availability'];
  app: { getVersion(): Promise<string> };
  health: { ping(): Promise<{ status: string; database: string }> };
  r3: PreloadBridge['r3'];
  r2: R2UiApi;
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
  embedding: {
    getConfig(): Promise<{ available: boolean; runtimeProfileId: string | null }>;
    setConfig(
      runtimeProfileId: string | null,
    ): Promise<{ available: boolean; runtimeProfileId: string | null }>;
    reindex(teammateId: string): Promise<{ indexed: number; total: number }>;
  };
  providers: {
    list(): Promise<ProviderView[]>;
    create(input: { name: string; kind: ProviderKind; baseUrl?: string }): Promise<ProviderView>;
  };
  credentials: {
    list(providerId?: string): Promise<CredentialView[]>;
    create(input: { providerId: string; label: string }): Promise<CredentialView>;
    rotate(credentialId: string): Promise<CredentialView>;
  };
  runtimes: {
    list(): Promise<RuntimeProfileView[]>;
    create(input: {
      name: string;
      providerId: string;
      credentialId: string | null;
      modelId: string;
    }): Promise<RuntimeProfileView>;
    update(input: {
      id: string;
      name: string;
      providerId: string;
      credentialId: string | null;
      modelId: string;
    }): Promise<RuntimeProfileView>;
    testConnection(runtimeProfileId: string): Promise<{ ok: boolean; message: string }>;
  };
  teammates: {
    list(): Promise<TeammateView[]>;
    create(input: Omit<TeammateView, 'id' | 'status'>): Promise<TeammateView>;
    update(input: Omit<TeammateView, 'status'>): Promise<TeammateView>;
    archive(id: string): Promise<TeammateView>;
    duplicate(id: string): Promise<TeammateView>;
  };
  parties: {
    list(): Promise<PartyView[]>;
    create(input: {
      name: string;
      description: string;
      type: PartyType;
      coordinatorTeammateId: string;
      memberTeammateIds: string[];
    }): Promise<PartyView>;
    update(input: {
      id: string;
      name: string;
      description: string;
      type: PartyType;
      coordinatorTeammateId: string;
      memberTeammateIds: string[];
    }): Promise<PartyView>;
    archive(id: string): Promise<PartyView>;
  };
  chat: {
    listConversations(teammateId: string): Promise<ConversationView[]>;
    createConversation(teammateId: string): Promise<ConversationView>;
    listMessages(input: { teammateId: string; conversationId: string }): Promise<MessageView[]>;
    send(input: {
      requestId: string;
      teammateId: string;
      conversationId: string;
      text: string;
    }): Promise<{ requestId: string; conversationId: string }>;
    onEvent(callback: (event: ChatEvent) => void): () => void;
  };
  memories: {
    list(teammateId: string, status?: MemoryStatus): Promise<MemoryView[]>;
    create(input: {
      teammateId: string;
      memoryType: MemoryType;
      content: string;
      summary: string;
      importance: number;
    }): Promise<MemoryView>;
    update(input: {
      teammateId: string;
      id: string;
      memoryType: MemoryType;
      content: string;
      summary: string;
      importance: number;
    }): Promise<MemoryView>;
    archive(input: { teammateId: string; id: string }): Promise<MemoryView>;
    accept(input: {
      teammateId: string;
      id: string;
      edits?: Partial<Pick<MemoryView, 'memoryType' | 'content' | 'summary' | 'importance'>>;
    }): Promise<MemoryView>;
    reject(input: { teammateId: string; id: string }): Promise<MemoryView>;
    proposeFromMessage(input: {
      teammateId: string;
      conversationId: string;
      messageId: string;
    }): Promise<MemoryView[]>;
  };
  skills: {
    list(): Promise<SkillView[]>;
    create(input: {
      name: string;
      description: string;
      instructions: string;
      tags: string[];
    }): Promise<SkillView>;
    update(input: {
      id: string;
      name: string;
      description: string;
      instructions: string;
      tags: string[];
    }): Promise<SkillView>;
    archive(skillId: string): Promise<SkillView>;
    assign(input: { teammateId: string; skillId: string }): Promise<SkillAssignmentView>;
    unassign(input: { teammateId: string; skillId: string }): Promise<void>;
    setEnabled(input: {
      teammateId: string;
      skillId: string;
      enabled: boolean;
    }): Promise<SkillAssignmentView>;
    listAssignments(teammateId: string): Promise<SkillAssignmentView[]>;
  };
  usage: { list(teammateId?: string): Promise<UsageView[]> };
  experience: { get(teammateId: string): Promise<TeammateExperienceView> };
  missions: {
    list(): Promise<MissionView[]>;
    create(input: {
      title: string;
      objective: string;
      coordinatorTeammateId: string;
      mode?: MissionMode;
      partyId?: string | null;
    }): Promise<MissionView>;
    update(input: { id: string; title: string; objective: string }): Promise<MissionView>;
    ready(id: string): Promise<MissionView>;
    start(input: { missionId: string; approvalFixture: boolean }): Promise<MissionDetailView>;
    retry(input: { missionId: string; approvalFixture: boolean }): Promise<MissionDetailView>;
    pause(id: string): Promise<MissionView>;
    resume(id: string): Promise<MissionDetailView>;
    cancel(id: string): Promise<MissionView>;
    detail(id: string): Promise<MissionDetailView>;
    resolveApproval(input: {
      approvalId: string;
      decision: 'APPROVED' | 'DENIED' | 'ALLOW_MISSION';
    }): Promise<MissionDetailView>;
    resolveCollaboration(input: {
      requestId: string;
      decision: 'APPROVED' | 'DENIED';
      externalWork?: HumanBridgeApprovalInput;
    }): Promise<MissionDetailView>;
  };
  tools: {
    getWorkspace(): Promise<{ rootPath: string | null }>;
    chooseWorkspace(): Promise<{ rootPath: string | null }>;
    listBuiltins(): Promise<ToolDescriptorView[]>;
    listMcpServers(): Promise<McpServerConfigView[]>;
    saveMcpServer(input: {
      id?: string;
      name: string;
      command: string;
      args: string[];
      envWhitelist: string[];
      cwd: string | null;
      enabled: boolean;
    }): Promise<McpServerConfigView>;
    removeMcpServer(id: string): Promise<void>;
    refreshMcpServer(id: string): Promise<McpRefreshResult>;
  };
}

declare global {
  interface Window {
    cultivation: CultivationBridge;
  }
}

export const providerKinds: { value: ProviderKind; label: string }[] = [
  { value: 'OPENAI', label: 'OpenAI' },
  { value: 'ANTHROPIC', label: 'Anthropic' },
  { value: 'GOOGLE', label: 'Google' },
  { value: 'DEEPSEEK', label: 'DeepSeek' },
  { value: 'OPENAI_COMPATIBLE', label: 'OpenAI Compatible' },
];

export const memoryTypes: { value: MemoryType; label: string }[] = [
  { value: 'IDENTITY', label: '身份 Identity' },
  { value: 'PREFERENCE', label: '偏好 Preference' },
  { value: 'FACT', label: '事实 Fact' },
  { value: 'EPISODE', label: '经历 Episode' },
  { value: 'PROCEDURE', label: '流程 Procedure' },
  { value: 'OBSERVATION', label: '观察 Observation' },
];

export type MemoryForm = {
  memoryType: MemoryType;
  content: string;
  summary: string;
  importance: number;
};

export const blankMemoryForm: MemoryForm = {
  memoryType: 'FACT',
  content: '',
  summary: '',
  importance: 0.5,
};

export type SkillForm = {
  name: string;
  description: string;
  instructions: string;
  tagsText: string;
};

export const blankSkillForm: SkillForm = {
  name: '',
  description: '',
  instructions: '',
  tagsText: '',
};

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function makeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export function PageHeading({ title }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="page-heading">
      <h1>{title}</h1>
    </header>
  );
}

export function missionStateLabel(value: string): string {
  const labels: Record<string, string> = {
    DRAFT: '草稿',
    READY: '就绪',
    RUNNING: '运行中',
    WAITING_APPROVAL: '等待审批',
    WAITING_COLLABORATION: '等待协作批准',
    WAITING_EXTERNAL_WORK: '等待本尊外部工作',
    PAUSED: '已暂停',
    INTERRUPTED: '已中断',
    COMPLETED: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
  };
  return labels[value] ?? safeLabel(value);
}

export function missionModeLabel(mode: MissionMode): string {
  const labels: Record<MissionMode, string> = {
    SOLO: 'SOLO',
    CONSULTATION: '咨询',
    REVIEW: '审查',
    DELEGATION: '委托',
  };
  return labels[mode] ?? safeLabel(mode);
}

export function artifactKindLabel(kind: CollaborationArtifactView['kind']): string {
  const labels: Record<CollaborationArtifactView['kind'], string> = {
    MEMBER_RESULT: '成员意见',
    DRAFT: 'Draft 草稿',
    REVIEW: 'Review 审查',
    FINAL: 'Final 定稿',
  };
  return labels[kind];
}

export function timelineActorName(
  teammates: TeammateView[],
  actorType: string,
  actorId: string | null,
): string {
  if (actorId && teammates.some((teammate) => teammate.id === actorId)) {
    return teammateName(teammates, actorId);
  }
  if (actorType === 'USER') return '用户';
  if (actorType === 'SYSTEM') return '系统';
  return safeLabel(actorType);
}

export function stateClass(value: string): string {
  return value.toLowerCase().replaceAll('_', '-');
}

export function teammateName(teammates: TeammateView[], teammateId: string): string {
  return teammates.find((teammate) => teammate.id === teammateId)?.name ?? teammateId.slice(0, 8);
}

export function runAttemptLabel(runs: MissionRunView[], runId: string): string {
  const run = runs.find((item) => item.id === runId);
  return run ? `#${run.attempt}` : runId.slice(0, 8) || '—';
}

export function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, ' ').slice(0, 96) || '未知';
}

export function renderToolTimelineMetadata(payload: Record<string, unknown>): React.ReactNode {
  const fields: Array<[string, string]> = [];
  const toolId = metadataToken(payload.toolId);
  const sourceValue = payload.source ?? payload.toolSource;
  const source = sourceValue === 'BUILTIN' || sourceValue === 'MCP' ? sourceValue : null;
  const capability = metadataToken(
    payload.capability ?? payload.requestedCapability,
    /^[A-Z][A-Z0-9_]{1,48}$/,
  );
  const approvalValue =
    payload.approvalStatus ?? payload.approvalState ?? payload.approvalDecision ?? payload.approval;
  const approval =
    typeof approvalValue === 'string' &&
    [
      'ASK',
      'PENDING',
      'REQUESTED',
      'APPROVED',
      'DENIED',
      'ALLOW_MISSION',
      'GRANTED',
      'REUSED_GRANT',
    ].includes(approvalValue)
      ? approvalValue
      : null;
  const resultValue =
    payload.resultStatus ?? payload.executionStatus ?? payload.outcome ?? payload.result;
  const allowedResults = ['SUCCESS', 'FAILURE', 'FAILED', 'DENIED', 'ERROR', 'TIMEOUT'];
  const result =
    typeof resultValue === 'string' && allowedResults.includes(resultValue.toUpperCase())
      ? resultValue.toUpperCase()
      : typeof payload.success === 'boolean'
        ? payload.success
          ? 'SUCCESS'
          : 'FAILURE'
        : null;
  const missionGrant = payload.grantScope === 'MISSION' || payload.grantUsed === true;

  if (toolId) fields.push(['Tool', toolId]);
  if (source) fields.push(['Source', source]);
  if (capability) fields.push(['Capability', capability]);
  if (approval) fields.push(['Approval', approval]);
  if (missionGrant) fields.push(['Grant', 'MISSION']);
  if (result) fields.push(['Result', result]);
  if (fields.length === 0) return null;

  return (
    <span className="timeline-tool-meta">
      {fields.map(([label, value]) => (
        <span key={label}>
          {label}: <strong>{value}</strong>
        </span>
      ))}
    </span>
  );
}

export function metadataToken(value: unknown, pattern = /^[A-Za-z0-9_.:-]{1,96}$/): string | null {
  return typeof value === 'string' && pattern.test(value) ? safeLabel(value) : null;
}

export function InlineMessage({
  tone,
  children,
}: {
  tone: 'error' | 'success';
  children: React.ReactNode;
}) {
  return (
    <div className={`inline-message ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function EmptyList({ text }: { text: string }) {
  return <div className="list-empty">{text}</div>;
}

export function formatToken(value: number | null): string {
  return value === null ? '未知' : new Intl.NumberFormat('zh-CN').format(value);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}
