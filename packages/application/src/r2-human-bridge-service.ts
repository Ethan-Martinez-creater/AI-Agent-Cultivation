import { randomUUID } from 'node:crypto';
import type {
  CapabilityDimension,
  CapabilityEvidence,
  AuditEvent,
  ExternalAppProfile,
  ExternalWorkArtifact,
  ExternalWorkRequest,
  Mission,
  MissionEvent,
  MissionParticipant,
  MissionRun,
  Teammate,
  TeammateCapabilityState,
} from '@cultivation/domain';
import { transition } from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_SCORING_POLICY,
  ratingStarsToScore,
} from './r1-capability-scoring.js';

export const HUMAN_BRIDGE_SYSTEM_ID = 'system-human-bridge';
export const HUMAN_BRIDGE_PRIOR_SOURCE = 'HUMAN_BRIDGE_EXPLICIT_PRIOR';
export const HUMAN_BRIDGE_SCORING_POLICY_VERSION = 'r2-human-bridge-progressive-v1';

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_DISPLAY_TITLE_LENGTH = 160;
const MAX_DISPLAY_DESCRIPTION_LENGTH = 4_000;
const MAX_AVATAR_LENGTH = 2_048;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_REQUIREMENTS = 20;
const MAX_REQUIREMENT_LENGTH = 1_000;
const MAX_TARGET_ARTIFACTS = 12;
const MAX_ARTIFACT_NAME_LENGTH = 128;
const MAX_TARGET_PATHS = 8;
const MAX_RELATIVE_PATH_LENGTH = 512;
const MAX_ACCEPTANCE_CRITERIA = 20;
const MAX_ACCEPTANCE_CRITERION_LENGTH = 1_000;
const MAX_EXTENSION_COUNT = 16;
const MAX_ARTIFACT_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_SUBMISSION_ARTIFACTS = MAX_TARGET_ARTIFACTS;
const MAX_PUBLIC_RESULT_LENGTH = 4_000;
const MAX_REJECTION_REASON_LENGTH = 500;
const MAX_RESOLUTION_ARTIFACTS = 12;

export interface HumanBridgeCapabilitySetting {
  teammateId: string;
  dimension: CapabilityDimension;
  enabled: boolean;
  updatedAt: string;
}

export interface HumanBridgeDisplayInput {
  name: string;
  avatar: string | null;
  title: string | null;
  description: string;
}

export interface HumanBridgeCapabilityDimensionProfile {
  dimension: CapabilityDimension;
  enabled: boolean;
  priorScore: number | null;
  currentScore: number | null;
  evidenceWeight: number;
  ratingCount: number;
  source: typeof HUMAN_BRIDGE_PRIOR_SOURCE | null;
}

export interface HumanBridgeCapabilityProfile {
  teammate: Teammate;
  scoringPolicyVersion: string;
  dimensions: HumanBridgeCapabilityDimensionProfile[];
}

/** The extra persisted request facts intentionally stay outside Message/ToolResult. */
export type ExternalWorkRequestRecord = ExternalWorkRequest & {
  targetWorkspacePathsJson: { items: string[] };
  externalAppProfileId: string | null;
  publicResult: string | null;
};

export interface HumanBridgeServiceStore {
  ensureHumanBridgeTeammate(input: { id: string; createdAt: string; updatedAt: string }): Teammate;
  updateHumanBridgeDisplay(
    teammateId: string,
    value: HumanBridgeDisplayInput & { updatedAt: string },
  ): Teammate | null;
  listHumanBridgeCapabilities(teammateId: string): HumanBridgeCapabilitySetting[];
  saveHumanBridgeCapability(value: HumanBridgeCapabilitySetting): void;
  listTeammateCapabilityStates(teammateId: string): TeammateCapabilityState[];
  replaceTeammateCapabilityStates(
    teammateId: string,
    states: readonly TeammateCapabilityState[],
  ): void;
  listCapabilityEvidence(teammateId: string, dimension?: CapabilityDimension): CapabilityEvidence[];
  appendCapabilityEvidenceBatch(values: readonly CapabilityEvidence[]): void;
  saveExternalAppProfile(value: ExternalAppProfile): void;
  listExternalAppProfiles(teammateId: string): ExternalAppProfile[];
  createExternalWorkRequest(value: ExternalWorkRequestRecord): ExternalWorkRequestRecord;
  getExternalWorkRequest(id: string): ExternalWorkRequestRecord | null;
  listExternalWorkRequests(missionId?: string, runId?: string): ExternalWorkRequestRecord[];
  transitionExternalWorkRequest(
    id: string,
    state: ExternalWorkRequest['state'],
    at: string,
    publicResult?: string | null,
  ): ExternalWorkRequestRecord | null;
  appendExternalWorkArtifact(value: ExternalWorkArtifact): void;
  listExternalWorkArtifacts(requestId: string): ExternalWorkArtifact[];
}

export interface R2HumanBridgeServiceStore extends HumanBridgeServiceStore {
  getMission(id: string): Mission | null;
  listRuns(missionId: string): MissionRun[];
  listMissionParticipants(missionId: string): MissionParticipant[];
  transitionMission(next: Mission, expectedState: Mission['state']): boolean;
  appendMissionEvent(event: MissionEvent): void;
  appendAuditEvent(event: AuditEvent): void;
  transaction<T>(fn: () => T): T;
}

export interface HumanBridgeServiceOptions {
  now?: () => string;
  newId?: () => string;
}

export interface SaveHumanBridgeExternalAppProfileInput {
  id?: string;
  name: string;
  vendor?: string | null;
  capabilities: CapabilityDimension[];
  notes?: string | null;
  enabled?: boolean;
}

export interface HumanBridgeRatingInput {
  externalWorkRequestId: string;
  stars?: number;
  skip?: boolean;
}

export interface HumanBridgeRatingResult {
  evidence: CapabilityEvidence[];
  skipped: boolean;
  profile: HumanBridgeCapabilityProfile;
}

/**
 * Human Bridge capability is configured explicitly by the user. Its prior is a
 * separate fact source and never manufactures a ModelCapabilityBenchmark.
 */
export class HumanBridgeService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly store: HumanBridgeServiceStore,
    options: HumanBridgeServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  bootstrap(): Teammate {
    const at = this.now();
    const teammate = this.store.ensureHumanBridgeTeammate({
      id: HUMAN_BRIDGE_SYSTEM_ID,
      createdAt: at,
      updatedAt: at,
    });
    assertHumanBridgeIdentity(teammate);
    this.rebuild(teammate.id);
    return teammate;
  }

  updateDisplay(input: HumanBridgeDisplayInput): Teammate {
    const teammate = this.requireBridge();
    const value = validateDisplay(input);
    const updated = this.store.updateHumanBridgeDisplay(teammate.id, {
      ...value,
      updatedAt: this.now(),
    });
    if (!updated) throw new DomainError('NOT_FOUND', 'Human Bridge 不存在');
    assertHumanBridgeIdentity(updated);
    return updated;
  }

  setCapability(input: {
    dimension: CapabilityDimension;
    enabled: boolean;
  }): HumanBridgeCapabilityProfile {
    if (!CAPABILITY_DIMENSIONS.includes(input.dimension)) {
      throw new DomainError('INVALID_INPUT', 'Human Bridge capability dimension 无效');
    }
    if (typeof input.enabled !== 'boolean') {
      throw new DomainError('INVALID_INPUT', 'Human Bridge capability enabled 必须为布尔值');
    }
    const teammate = this.requireBridge();
    this.store.saveHumanBridgeCapability({
      teammateId: teammate.id,
      dimension: input.dimension,
      enabled: input.enabled,
      updatedAt: this.now(),
    });
    return this.capabilityProfile();
  }

  capabilityProfile(): HumanBridgeCapabilityProfile {
    const teammate = this.requireBridge();
    const states = this.rebuild(teammate.id);
    const settingByDimension = new Map(
      this.store
        .listHumanBridgeCapabilities(teammate.id)
        .map((setting) => [setting.dimension, setting.enabled]),
    );
    const stateByDimension = new Map(states.map((state) => [state.dimension, state]));
    return {
      teammate,
      scoringPolicyVersion: HUMAN_BRIDGE_SCORING_POLICY_VERSION,
      dimensions: CAPABILITY_DIMENSIONS.map((dimension) => {
        const enabled = settingByDimension.get(dimension) === true;
        const state = stateByDimension.get(dimension);
        return {
          dimension,
          enabled,
          priorScore: enabled ? 1 : null,
          currentScore: state?.currentScore ?? null,
          evidenceWeight: state?.evidenceWeight ?? 0,
          ratingCount: state?.ratingCount ?? 0,
          source: enabled ? HUMAN_BRIDGE_PRIOR_SOURCE : null,
        };
      }),
    };
  }

  listExternalAppProfiles(): ExternalAppProfile[] {
    return this.store.listExternalAppProfiles(this.requireBridge().id);
  }

  saveExternalAppProfile(input: SaveHumanBridgeExternalAppProfileInput): ExternalAppProfile {
    const teammate = this.requireBridge();
    const value = validateExternalAppProfile(input);
    const prior = value.id
      ? this.store.listExternalAppProfiles(teammate.id).find((profile) => profile.id === value.id)
      : undefined;
    if (value.id && prior && prior.teammateId !== teammate.id) {
      throw new DomainError('INVALID_INPUT', 'External App Profile 不属于 Human Bridge');
    }
    const at = this.now();
    const profile: ExternalAppProfile = {
      id: value.id ?? this.newId(),
      teammateId: teammate.id,
      name: value.name,
      vendor: value.vendor,
      capabilities: value.capabilities,
      notes: value.notes,
      enabled: value.enabled,
      createdAt: prior?.createdAt ?? at,
      updatedAt: at,
    };
    this.store.saveExternalAppProfile(profile);
    return profile;
  }

  submitRating(input: HumanBridgeRatingInput): HumanBridgeRatingResult {
    const teammate = this.requireBridge();
    const request = this.store.getExternalWorkRequest(requiredId(input.externalWorkRequestId));
    if (!request || request.assigneeTeammateId !== teammate.id || request.state !== 'ACCEPTED') {
      throw new DomainError('CONFLICT', '只有已接受的 Human Bridge ExternalWork 才可评价');
    }
    if (latestSubmissionArtifacts(this.store, request).length === 0) {
      throw new DomainError('CONFLICT', '缺少已验证的 ExternalWork Artifact');
    }
    if (input.skip === true) {
      return { evidence: [], skipped: true, profile: this.capabilityProfile() };
    }
    const stars = input.stars;
    if (stars === undefined) throw new DomainError('INVALID_INPUT', '评价星级不能为空');
    const existing = this.store
      .listCapabilityEvidence(teammate.id, request.capability)
      .some(
        (entry) =>
          entry.missionId === request.missionId &&
          entry.runId === request.runId &&
          entry.runtimeProfileId === null,
      );
    if (existing) throw new DomainError('CONFLICT', '此 Mission Run 已评价过该 Human Bridge 能力');
    const evidence: CapabilityEvidence = {
      id: this.newId(),
      teammateId: teammate.id,
      runtimeProfileId: null,
      missionId: request.missionId,
      runId: request.runId,
      dimension: request.capability,
      sourceType: 'USER_DIMENSION_RATING',
      ratingValue: ratingStarsToScore(stars),
      demandWeight: CAPABILITY_SCORING_POLICY.selectedDimensionDemandWeight,
      evidenceWeight: CAPABILITY_SCORING_POLICY.dimensionEvidenceWeight,
      createdAt: this.now(),
    };
    this.store.appendCapabilityEvidenceBatch([evidence]);
    return {
      evidence: [evidence],
      skipped: false,
      profile: this.capabilityProfile(),
    };
  }

  private requireBridge(): Teammate {
    const teammate = this.store.ensureHumanBridgeTeammate({
      id: HUMAN_BRIDGE_SYSTEM_ID,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    assertHumanBridgeIdentity(teammate);
    return teammate;
  }

  private rebuild(teammateId: string): TeammateCapabilityState[] {
    const settings = this.store.listHumanBridgeCapabilities(teammateId);
    const enabled = new Set(
      settings.filter((setting) => setting.enabled).map((item) => item.dimension),
    );
    if (enabled.size === 0) {
      this.store.replaceTeammateCapabilityStates(teammateId, []);
      return [];
    }

    const requests = this.store.listExternalWorkRequests();
    const acceptedFacts = new Set(
      requests
        .filter(
          (request) =>
            request.assigneeTeammateId === teammateId &&
            request.state === 'ACCEPTED' &&
            latestSubmissionArtifacts(this.store, request).length > 0,
        )
        .map((request) => `${request.missionId}\0${request.runId}\0${request.capability}`),
    );
    const evidence = this.store
      .listCapabilityEvidence(teammateId)
      .filter(
        (entry) =>
          entry.runtimeProfileId === null &&
          acceptedFacts.has(`${entry.missionId}\0${entry.runId}\0${entry.dimension}`),
      );
    const states = CAPABILITY_DIMENSIONS.flatMap((dimension) => {
      if (!enabled.has(dimension)) return [];
      const relevant = evidence.filter((entry) => entry.dimension === dimension);
      const weight = relevant.reduce(
        (sum, entry) => sum + entry.evidenceWeight * entry.demandWeight,
        0,
      );
      const weightedScore = relevant.reduce(
        (sum, entry) => sum + entry.ratingValue * entry.evidenceWeight * entry.demandWeight,
        0,
      );
      const userScore = weight > 0 ? weightedScore / weight : 1;
      const alpha = weight > 0 ? weight / (CAPABILITY_SCORING_POLICY.priorStrength + weight) : 0;
      const currentScore = roundScore(1 + alpha * (userScore - 1));
      const updatedAt = maxTimestamp([
        settings.find((item) => item.dimension === dimension)?.updatedAt ?? this.now(),
        ...relevant.map((entry) => entry.createdAt),
      ]);
      return [
        {
          teammateId,
          dimension,
          currentScore,
          evidenceWeight: weight,
          ratingCount: relevant.length,
          currentRuntimeProfileId: null,
          scoringPolicyVersion: HUMAN_BRIDGE_SCORING_POLICY_VERSION,
          updatedAt,
        } satisfies TeammateCapabilityState,
      ];
    });
    this.store.replaceTeammateCapabilityStates(teammateId, states);
    return states;
  }
}

export interface ExternalWorkArtifactTarget {
  id: string;
  name: string;
  required: boolean;
  allowedExtensions: string[];
  maxSizeBytes: number;
}

export interface CreateExplicitExternalWorkInput {
  missionId: string;
  runId: string;
  requesterTeammateId: string;
  capability: CapabilityDimension;
  title: string;
  prompt: string;
  requirements: string[];
  targetArtifacts: ExternalWorkArtifactTarget[];
  targetWorkspacePaths: string[];
  acceptanceCriteria: string[];
  externalAppProfileId?: string | null;
}

export interface WorkspaceArtifactConstraints {
  maxSizeBytes: number;
  allowedExtensions: readonly string[];
}

export interface ValidatedWorkspaceArtifact {
  relativePath: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
}

/** Implemented by Main using FileWorkspace; returned facts must come from disk inspection. */
export interface WorkspaceArtifactValidator {
  validateArtifact(
    relativePath: string,
    constraints: WorkspaceArtifactConstraints,
  ): Promise<ValidatedWorkspaceArtifact>;
}

export interface ExternalWorkArtifactSubmission {
  targetArtifactId: string;
  relativePath: string;
}

export interface SubmitExternalWorkArtifactsInput {
  requestId: string;
  artifacts: ExternalWorkArtifactSubmission[];
}

export interface ExternalWorkArtifactSummary {
  id: string;
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
}

export interface ExternalWorkContinuation {
  kind: 'EXTERNAL_WORK_CONTINUATION';
  requestId: string;
  missionId: string;
  runId: string;
  requesterTeammateId: string;
  assigneeTeammateId: string;
  capability: CapabilityDimension;
  outcome: Extract<ExternalWorkRequest['state'], 'ACCEPTED' | 'REJECTED' | 'CANCELLED'>;
  publicResult: string | null;
  artifacts: ExternalWorkArtifactSummary[];
  trust: 'UNTRUSTED_EXTERNAL_DATA';
}

export interface ExternalWorkCreatedNotification {
  type: 'EXTERNAL_WORK_CREATED';
  requestId: string;
  missionId: string;
  /** Safe generic title only: no prompt or task title is placed in a lock-screen alert. */
  title: '有一项外部工作等待处理';
}

export interface ExternalWorkDetail {
  request: ExternalWorkRequestRecord;
  artifacts: ExternalWorkArtifact[];
}

export type ExternalWorkServiceOptions = HumanBridgeServiceOptions;

type ContinuationListener = (value: ExternalWorkContinuation) => void | Promise<void>;
type CreatedListener = (value: ExternalWorkCreatedNotification) => void | Promise<void>;

/** Application-owned lifecycle for explicit, user-executed work. */
export class ExternalWorkService {
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly continuationListeners = new Set<ContinuationListener>();
  private readonly createdListeners = new Set<CreatedListener>();

  constructor(
    private readonly store: R2HumanBridgeServiceStore,
    private readonly artifactValidator: WorkspaceArtifactValidator,
    options: ExternalWorkServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  createExplicit(input: CreateExplicitExternalWorkInput): ExternalWorkRequestRecord {
    const value = validateCreateInput(input);
    const bridge = this.requireBridge();
    const capabilityEnabled = this.store
      .listHumanBridgeCapabilities(bridge.id)
      .some((item) => item.dimension === value.capability && item.enabled);
    if (!capabilityEnabled) {
      throw new DomainError('INVALID_INPUT', '所选 Human Bridge capability 当前未启用');
    }
    const mission = this.store.getMission(value.missionId);
    if (!mission) throw new DomainError('NOT_FOUND', 'Mission 不存在');
    if (mission.state !== 'RUNNING') {
      throw new DomainError('MISSION_INVALID_STATE', '只有 RUNNING Mission 可以创建 ExternalWork');
    }
    const runs = this.store.listRuns(mission.id);
    const currentRun = runs.at(-1);
    if (
      !currentRun ||
      currentRun.id !== value.runId ||
      currentRun.missionId !== mission.id ||
      currentRun.status !== 'RUNNING'
    ) {
      throw new DomainError('CONFLICT', 'ExternalWork 必须绑定当前 RUNNING MissionRun');
    }
    const isCoordinator = mission.coordinatorTeammateId === value.requesterTeammateId;
    const isParticipant = this.store
      .listMissionParticipants(mission.id)
      .some((participant) => participant.teammateId === value.requesterTeammateId);
    if (!isCoordinator && !isParticipant) {
      throw new DomainError('INVALID_INPUT', 'ExternalWork requester 必须是 Mission participant');
    }
    const activeRequest = this.store
      .listExternalWorkRequests(mission.id, currentRun.id)
      .find((request) => ['PENDING', 'IN_PROGRESS', 'SUBMITTED'].includes(request.state));
    if (activeRequest) {
      throw new DomainError('CONFLICT', '此 Mission Run 已有待处理的 ExternalWork');
    }

    const externalAppProfileId = this.validateExternalAppProfile(
      value.externalAppProfileId,
      bridge.id,
      value.capability,
    );
    const at = this.now();
    const request: ExternalWorkRequestRecord = {
      id: this.newId(),
      missionId: mission.id,
      runId: currentRun.id,
      requesterTeammateId: value.requesterTeammateId,
      assigneeTeammateId: bridge.id,
      capability: value.capability,
      title: value.title,
      prompt: value.prompt,
      requirementsJson: { items: value.requirements },
      targetArtifactsJson: { items: value.targetArtifacts },
      acceptanceCriteriaJson: { items: value.acceptanceCriteria },
      targetWorkspacePathsJson: { items: value.targetWorkspacePaths },
      externalAppProfileId,
      publicResult: null,
      state: 'PENDING',
      createdAt: at,
      submittedAt: null,
      resolvedAt: null,
    };
    let created!: ExternalWorkRequestRecord;
    const waiting = transition(mission, 'WAITING_EXTERNAL_WORK', at);
    this.store.transaction(() => {
      created = this.store.createExternalWorkRequest(request);
      if (!this.store.transitionMission(waiting, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.recordLifecycle(created, 'external_work.created', at);
    });
    this.publishCreated({
      type: 'EXTERNAL_WORK_CREATED',
      requestId: created.id,
      missionId: created.missionId,
      title: '有一项外部工作等待处理',
    });
    return created;
  }

  listExternalWorkRequests(missionId?: string, runId?: string): ExternalWorkRequestRecord[] {
    return this.store.listExternalWorkRequests(missionId, runId);
  }

  getExternalWorkRequest(id: string): ExternalWorkDetail | null {
    const request = this.store.getExternalWorkRequest(requiredId(id));
    return request
      ? { request, artifacts: this.store.listExternalWorkArtifacts(request.id) }
      : null;
  }

  markInProgress(id: string): ExternalWorkRequestRecord {
    const request = this.requireRequest(id);
    if (request.state !== 'PENDING' && request.state !== 'REJECTED') {
      throw new DomainError('CONFLICT', '只有 PENDING 或 REJECTED ExternalWork 可以开始');
    }
    let updated!: ExternalWorkRequestRecord;
    const at = this.now();
    this.store.transaction(() => {
      updated = this.transitionRequest(request, 'IN_PROGRESS', null, at);
      this.recordLifecycle(updated, 'external_work.in_progress', at);
    });
    return updated;
  }

  async submitArtifacts(
    input: SubmitExternalWorkArtifactsInput,
  ): Promise<ExternalWorkRequestRecord> {
    const request = this.requireRequest(input.requestId);
    if (request.state !== 'IN_PROGRESS') {
      throw new DomainError('CONFLICT', '只有 IN_PROGRESS ExternalWork 可以提交 Artifact');
    }
    const targets = targetArtifactsFromRequest(request);
    const submissions = validateArtifactSubmissions(input.artifacts, targets);
    const targetById = new Map(targets.map((target) => [target.id, target]));
    const artifacts: Omit<ExternalWorkArtifact, 'submittedAt'>[] = [];
    for (const submission of submissions) {
      const target = targetById.get(submission.targetArtifactId)!;
      const normalizedInputPath = normalizeRelativeWorkspacePath(submission.relativePath);
      if (!isInsideTargetPath(normalizedInputPath, targetWorkspacePathsFromRequest(request))) {
        throw new DomainError('INVALID_INPUT', 'Artifact 必须位于请求指定的 Workspace 路径下');
      }
      const inspected = await this.artifactValidator.validateArtifact(normalizedInputPath, {
        maxSizeBytes: target.maxSizeBytes,
        allowedExtensions: target.allowedExtensions,
      });
      const validatedPath = normalizeRelativeWorkspacePath(inspected.relativePath);
      const extension = validateInspectedArtifact(inspected, target, validatedPath);
      if (!isInsideTargetPath(validatedPath, targetWorkspacePathsFromRequest(request))) {
        throw new DomainError('INVALID_INPUT', 'Workspace validator 返回了请求路径之外的 Artifact');
      }
      artifacts.push({
        id: this.newId(),
        externalWorkRequestId: request.id,
        path: validatedPath,
        fileName: inspected.fileName,
        extension,
        sizeBytes: inspected.sizeBytes,
        mimeType: null,
        metadataJson: { targetArtifactId: target.id },
      });
    }
    let submitted!: ExternalWorkRequestRecord;
    const priorSubmissionTimes = this.store
      .listExternalWorkArtifacts(request.id)
      .map((artifact) => artifact.submittedAt);
    const submittedAt = afterLatestTimestamp(this.now(), priorSubmissionTimes);
    this.store.transaction(() => {
      submitted = this.transitionRequest(request, 'SUBMITTED', null, submittedAt);
      const persistedSubmittedAt = submitted.submittedAt;
      if (!persistedSubmittedAt)
        throw new DomainError('PERSISTENCE_INVALID', 'SUBMITTED request 缺少 submittedAt');
      const currentSubmissionArtifacts = artifacts.map((artifact) => ({
        ...artifact,
        submittedAt: persistedSubmittedAt,
      }));
      for (const artifact of currentSubmissionArtifacts)
        this.store.appendExternalWorkArtifact(artifact);
      this.recordLifecycle(submitted, 'external_work.submitted', persistedSubmittedAt, {
        artifactCount: currentSubmissionArtifacts.length,
        artifacts: currentSubmissionArtifacts.map((artifact) => ({
          id: artifact.id,
          targetArtifactId: artifact.metadataJson.targetArtifactId,
          extension: artifact.extension,
          sizeBytes: artifact.sizeBytes,
        })),
      });
    });
    return submitted;
  }

  accept(input: { requestId: string; publicResult?: string | null }): ExternalWorkContinuation {
    const request = this.requireRequest(input.requestId);
    if (request.state !== 'SUBMITTED') {
      throw new DomainError('CONFLICT', '只有 SUBMITTED ExternalWork 可以接受');
    }
    const artifacts = latestSubmissionArtifacts(this.store, request);
    if (artifacts.length === 0) throw new DomainError('CONFLICT', '缺少已验证的 Artifact');
    const targets = targetArtifactsFromRequest(request);
    const suppliedTargetIds = new Set(
      artifacts
        .map((artifact) => artifact.metadataJson.targetArtifactId)
        .filter((id): id is string => typeof id === 'string'),
    );
    if (targets.some((target) => target.required && !suppliedTargetIds.has(target.id))) {
      throw new DomainError('CONFLICT', '当前 Artifact submission 缺少 required target');
    }
    const publicResult = optionalBoundedText(
      input.publicResult,
      MAX_PUBLIC_RESULT_LENGTH,
      'publicResult',
    );
    const continuation = this.resolveRequest(request, 'ACCEPTED', publicResult);
    this.publishContinuation(continuation);
    return continuation;
  }

  reject(input: { requestId: string; reason?: string | null }): ExternalWorkRequestRecord {
    const request = this.requireRequest(input.requestId);
    if (request.state !== 'SUBMITTED') {
      throw new DomainError('CONFLICT', '只有 SUBMITTED ExternalWork 可以拒绝');
    }
    const reason = optionalBoundedText(input.reason, MAX_REJECTION_REASON_LENGTH, 'reason');
    const at = this.now();
    let rejected!: ExternalWorkRequestRecord;
    this.store.transaction(() => {
      rejected = this.transitionRequest(request, 'REJECTED', null, at);
      this.recordLifecycle(rejected, 'external_work.rejected', at, {
        reasonLength: reason?.length ?? 0,
      });
    });
    return rejected;
  }

  cancel(input: { requestId: string }): ExternalWorkContinuation {
    const request = this.requireRequest(input.requestId);
    if (!['PENDING', 'IN_PROGRESS', 'SUBMITTED'].includes(request.state)) {
      throw new DomainError('CONFLICT', '此 ExternalWork 状态不能取消');
    }
    const continuation = this.resolveRequest(request, 'CANCELLED', null);
    this.publishContinuation(continuation);
    return continuation;
  }

  /**
   * Reconstructs terminal results whose Mission is still waiting after a
   * recovery/repair scenario. Normal lifecycle writes Mission and request in
   * one transaction, so this usually returns an empty list.
   */
  resumeFinalizedRequests(): ExternalWorkContinuation[] {
    const continuations: ExternalWorkContinuation[] = [];
    for (const request of this.store.listExternalWorkRequests()) {
      if (!['ACCEPTED', 'CANCELLED'].includes(request.state)) continue;
      const mission = this.store.getMission(request.missionId);
      if (!mission || mission.state !== 'WAITING_EXTERNAL_WORK') continue;
      const run = this.store.listRuns(request.missionId).at(-1);
      if (!run || run.id !== request.runId || run.status !== 'RUNNING') continue;
      const continuation = this.resumeMission(request, mission);
      continuations.push(continuation);
      this.publishContinuation(continuation);
    }
    return continuations;
  }

  subscribeContinuations(listener: ContinuationListener): () => void {
    this.continuationListeners.add(listener);
    return () => this.continuationListeners.delete(listener);
  }

  subscribeCreated(listener: CreatedListener): () => void {
    this.createdListeners.add(listener);
    return () => this.createdListeners.delete(listener);
  }

  private requireBridge(): Teammate {
    const at = this.now();
    const bridge = this.store.ensureHumanBridgeTeammate({
      id: HUMAN_BRIDGE_SYSTEM_ID,
      createdAt: at,
      updatedAt: at,
    });
    assertHumanBridgeIdentity(bridge);
    return bridge;
  }

  private validateExternalAppProfile(
    profileId: string | null | undefined,
    teammateId: string,
    capability: CapabilityDimension,
  ): string | null {
    if (!profileId) return null;
    const profile = this.store
      .listExternalAppProfiles(teammateId)
      .find((entry) => entry.id === profileId);
    if (!profile || !profile.enabled || !profile.capabilities.includes(capability)) {
      throw new DomainError(
        'INVALID_INPUT',
        'External App recommendation 必须是已启用且匹配能力的配置',
      );
    }
    return profile.id;
  }

  private requireRequest(id: string): ExternalWorkRequestRecord {
    const request = this.store.getExternalWorkRequest(requiredId(id));
    if (!request) throw new DomainError('NOT_FOUND', 'ExternalWorkRequest 不存在');
    const bridge = this.requireBridge();
    if (request.assigneeTeammateId !== bridge.id) {
      throw new DomainError('INVALID_INPUT', 'ExternalWorkRequest assignee 不是 Human Bridge');
    }
    return request;
  }

  private transitionRequest(
    request: ExternalWorkRequestRecord,
    state: ExternalWorkRequest['state'],
    publicResult?: string | null,
    at = this.now(),
  ): ExternalWorkRequestRecord {
    const transitioned = this.store.transitionExternalWorkRequest(
      request.id,
      state,
      at,
      publicResult,
    );
    if (!transitioned) throw new DomainError('NOT_FOUND', 'ExternalWorkRequest 不存在');
    return transitioned;
  }

  private resolveRequest(
    request: ExternalWorkRequestRecord,
    outcome: ExternalWorkContinuation['outcome'],
    publicResult: string | null,
  ): ExternalWorkContinuation {
    const mission = this.store.getMission(request.missionId);
    if (!mission || mission.state !== 'WAITING_EXTERNAL_WORK') {
      throw new DomainError('CONFLICT', 'Mission 当前不在 WAITING_EXTERNAL_WORK');
    }
    const currentRun = this.store.listRuns(mission.id).at(-1);
    if (!currentRun || currentRun.id !== request.runId || currentRun.status !== 'RUNNING') {
      throw new DomainError('CONFLICT', 'ExternalWork 绑定的 MissionRun 不再是当前 RUNNING Run');
    }
    const at = this.now();
    const running = transition(mission, 'RUNNING', at);
    let resolved!: ExternalWorkRequestRecord;
    this.store.transaction(() => {
      resolved = this.transitionRequest(request, outcome, publicResult);
      if (!this.store.transitionMission(running, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      const artifacts =
        outcome === 'ACCEPTED' ? latestSubmissionArtifacts(this.store, resolved) : [];
      this.recordLifecycle(resolved, `external_work.${outcome.toLowerCase()}`, at, {
        artifactIds: artifacts.map((artifact) => artifact.id),
        publicResultLength: publicResult?.length ?? 0,
      });
    });
    return this.buildContinuation(resolved, outcome, publicResult);
  }

  private resumeMission(
    request: ExternalWorkRequestRecord,
    mission: Mission,
  ): ExternalWorkContinuation {
    const running = transition(mission, 'RUNNING', this.now());
    this.store.transaction(() => {
      if (!this.store.transitionMission(running, mission.state)) {
        throw new DomainError('CONFLICT', 'Mission 状态已被其他操作修改');
      }
      this.recordLifecycle(request, 'external_work.resumed', running.updatedAt);
    });
    return this.buildContinuation(
      request,
      request.state as ExternalWorkContinuation['outcome'],
      request.publicResult,
    );
  }

  private buildContinuation(
    request: ExternalWorkRequestRecord,
    outcome: ExternalWorkContinuation['outcome'],
    publicResult: string | null,
  ): ExternalWorkContinuation {
    const artifacts =
      outcome === 'ACCEPTED'
        ? latestSubmissionArtifacts(this.store, request)
            .slice(0, MAX_RESOLUTION_ARTIFACTS)
            .map(
              (artifact): ExternalWorkArtifactSummary => ({
                id: boundedField(artifact.id, 128),
                path: boundedField(artifact.path, MAX_RELATIVE_PATH_LENGTH),
                fileName: boundedField(artifact.fileName, MAX_ARTIFACT_NAME_LENGTH),
                extension: boundedField(artifact.extension, 16),
                sizeBytes: artifact.sizeBytes,
              }),
            )
        : [];
    return {
      kind: 'EXTERNAL_WORK_CONTINUATION',
      requestId: request.id,
      missionId: request.missionId,
      runId: request.runId,
      requesterTeammateId: request.requesterTeammateId,
      assigneeTeammateId: request.assigneeTeammateId,
      capability: request.capability,
      outcome,
      publicResult,
      artifacts,
      trust: 'UNTRUSTED_EXTERNAL_DATA',
    };
  }

  private publishCreated(value: ExternalWorkCreatedNotification): void {
    for (const listener of this.createdListeners) this.callListener(listener, value);
  }

  private recordLifecycle(
    request: ExternalWorkRequestRecord,
    eventType: string,
    at: string,
    details: Record<string, unknown> = {},
  ): void {
    const payloadJson = {
      requestId: request.id,
      requesterTeammateId: request.requesterTeammateId,
      assigneeTeammateId: request.assigneeTeammateId,
      capability: request.capability,
      state: request.state,
      ...details,
    };
    this.store.appendMissionEvent({
      id: this.newId(),
      missionId: request.missionId,
      runId: request.runId,
      eventType,
      actorType: 'USER',
      actorId: null,
      payloadJson,
      createdAt: at,
    });
    this.store.appendAuditEvent({
      id: this.newId(),
      actorType: 'USER',
      actorId: null,
      action: eventType,
      targetType: 'EXTERNAL_WORK_REQUEST',
      targetId: request.id,
      payloadJson,
      createdAt: at,
    });
  }

  private publishContinuation(value: ExternalWorkContinuation): void {
    for (const listener of this.continuationListeners) this.callListener(listener, value);
  }

  private callListener<T>(listener: (value: T) => void | Promise<void>, value: T): void {
    try {
      Promise.resolve(listener(value)).catch(() => undefined);
    } catch {
      // Notification and coordinator callbacks cannot roll back committed user work.
    }
  }
}

function latestSubmissionArtifacts(
  store: Pick<HumanBridgeServiceStore, 'listExternalWorkArtifacts'>,
  request: ExternalWorkRequestRecord,
): ExternalWorkArtifact[] {
  if (!request.submittedAt) return [];
  return store
    .listExternalWorkArtifacts(request.id)
    .filter((artifact) => artifact.submittedAt === request.submittedAt);
}

function assertHumanBridgeIdentity(teammate: Teammate): void {
  if (
    teammate.systemKind !== 'HUMAN_BRIDGE' ||
    teammate.executorKind !== 'USER_BRIDGE' ||
    teammate.routingPolicy !== 'FALLBACK_ONLY' ||
    teammate.currentRuntimeProfileId !== null
  ) {
    throw new DomainError('PERSISTENCE_INVALID', 'Human Bridge system identity is invalid');
  }
}

function validateDisplay(input: HumanBridgeDisplayInput): HumanBridgeDisplayInput {
  const name = requiredText(input.name, 'name', MAX_DISPLAY_NAME_LENGTH);
  const description = boundedText(input.description, 'description', MAX_DISPLAY_DESCRIPTION_LENGTH);
  const avatar =
    input.avatar === null ? null : optionalBoundedText(input.avatar, MAX_AVATAR_LENGTH, 'avatar');
  const title =
    input.title === null
      ? null
      : optionalBoundedText(input.title, MAX_DISPLAY_TITLE_LENGTH, 'title');
  return { name, avatar, title, description };
}

function validateExternalAppProfile(
  input: SaveHumanBridgeExternalAppProfileInput,
): Omit<ExternalAppProfile, 'teammateId' | 'createdAt' | 'updatedAt'> {
  const id = input.id === undefined ? undefined : requiredId(input.id);
  const name = requiredText(input.name, 'External App name', 120);
  const vendor =
    input.vendor === undefined || input.vendor === null
      ? null
      : requiredText(input.vendor, 'External App vendor', 120);
  const capabilities = uniqueDimensions(input.capabilities, 'External App capabilities');
  if (capabilities.length === 0)
    throw new DomainError('INVALID_INPUT', 'External App 至少需要一个 capability');
  const notes =
    input.notes === undefined || input.notes === null
      ? null
      : boundedText(input.notes, 'External App notes', 1_000);
  return { id: id!, name, vendor, capabilities, notes, enabled: input.enabled ?? true };
}

function validateCreateInput(
  input: CreateExplicitExternalWorkInput,
): CreateExplicitExternalWorkInput {
  if (!CAPABILITY_DIMENSIONS.includes(input.capability)) {
    throw new DomainError('INVALID_INPUT', 'ExternalWork capability 必须是明确的结构化 capability');
  }
  const missionId = requiredId(input.missionId);
  const runId = requiredId(input.runId);
  const requesterTeammateId = requiredId(input.requesterTeammateId);
  const title = requiredText(input.title, 'title', 160);
  const prompt = requiredText(input.prompt, 'prompt', MAX_PROMPT_LENGTH);
  if (
    !Array.isArray(input.requirements) ||
    input.requirements.length === 0 ||
    input.requirements.length > MAX_REQUIREMENTS
  ) {
    throw new DomainError('INVALID_INPUT', 'requirements 数量无效');
  }
  const requirements = input.requirements.map((requirement) =>
    requiredText(requirement, 'requirement', MAX_REQUIREMENT_LENGTH),
  );
  if (
    !Array.isArray(input.targetArtifacts) ||
    input.targetArtifacts.length === 0 ||
    input.targetArtifacts.length > MAX_TARGET_ARTIFACTS
  ) {
    throw new DomainError('INVALID_INPUT', 'targetArtifacts 数量无效');
  }
  const targetIds = new Set<string>();
  const targetArtifacts = input.targetArtifacts.map((target) => {
    const id = requiredId(target.id);
    if (targetIds.has(id)) throw new DomainError('INVALID_INPUT', 'targetArtifacts id 必须唯一');
    targetIds.add(id);
    if (typeof target.required !== 'boolean')
      throw new DomainError('INVALID_INPUT', 'Artifact required 必须为布尔值');
    if (
      !Number.isInteger(target.maxSizeBytes) ||
      target.maxSizeBytes < 1 ||
      target.maxSizeBytes > MAX_ARTIFACT_SIZE_BYTES
    ) {
      throw new DomainError('INVALID_INPUT', 'Artifact maxSizeBytes 超出限制');
    }
    const allowedExtensions = uniqueExtensions(target.allowedExtensions);
    if (allowedExtensions.length === 0)
      throw new DomainError('INVALID_INPUT', 'Artifact 必须声明 allowedExtensions');
    return {
      id,
      name: requiredText(target.name, 'Artifact name', MAX_ARTIFACT_NAME_LENGTH),
      required: target.required,
      allowedExtensions,
      maxSizeBytes: target.maxSizeBytes,
    };
  });
  if (!targetArtifacts.some((target) => target.required)) {
    throw new DomainError('INVALID_INPUT', '至少需要一个 required Artifact');
  }
  if (
    !Array.isArray(input.targetWorkspacePaths) ||
    input.targetWorkspacePaths.length === 0 ||
    input.targetWorkspacePaths.length > MAX_TARGET_PATHS
  ) {
    throw new DomainError('INVALID_INPUT', 'targetWorkspacePaths 数量无效');
  }
  const targetWorkspacePaths = [
    ...new Set(input.targetWorkspacePaths.map(normalizeRelativeWorkspacePath)),
  ];
  if (targetWorkspacePaths.length === 0)
    throw new DomainError('INVALID_INPUT', 'targetWorkspacePaths 不能为空');
  if (
    !Array.isArray(input.acceptanceCriteria) ||
    input.acceptanceCriteria.length === 0 ||
    input.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA
  ) {
    throw new DomainError('INVALID_INPUT', 'acceptanceCriteria 数量无效');
  }
  const acceptanceCriteria = input.acceptanceCriteria.map((criterion) =>
    requiredText(criterion, 'acceptance criterion', MAX_ACCEPTANCE_CRITERION_LENGTH),
  );
  return {
    missionId,
    runId,
    requesterTeammateId,
    capability: input.capability,
    title,
    prompt,
    requirements,
    targetArtifacts,
    targetWorkspacePaths,
    acceptanceCriteria,
    externalAppProfileId: input.externalAppProfileId
      ? requiredId(input.externalAppProfileId)
      : null,
  };
}

function validateArtifactSubmissions(
  value: ExternalWorkArtifactSubmission[],
  targets: ExternalWorkArtifactTarget[],
): ExternalWorkArtifactSubmission[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SUBMISSION_ARTIFACTS) {
    throw new DomainError('INVALID_INPUT', 'Artifact submission 数量无效');
  }
  const targetIds = new Set(targets.map((target) => target.id));
  const submitted = new Set<string>();
  const values = value.map((entry) => {
    const targetArtifactId = requiredId(entry.targetArtifactId);
    if (!targetIds.has(targetArtifactId) || submitted.has(targetArtifactId)) {
      throw new DomainError('INVALID_INPUT', 'Artifact target 无效或重复');
    }
    submitted.add(targetArtifactId);
    return {
      targetArtifactId,
      relativePath: normalizeRelativeWorkspacePath(entry.relativePath),
    };
  });
  if (targets.some((target) => target.required && !submitted.has(target.id))) {
    throw new DomainError('INVALID_INPUT', '缺少 required Artifact');
  }
  return values;
}

function targetArtifactsFromRequest(
  request: ExternalWorkRequestRecord,
): ExternalWorkArtifactTarget[] {
  const raw = request.targetArtifactsJson.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TARGET_ARTIFACTS) {
    throw new DomainError('PERSISTENCE_INVALID', 'ExternalWork targetArtifacts 数据无效');
  }
  return raw.map((item) => {
    if (!isRecord(item))
      throw new DomainError('PERSISTENCE_INVALID', 'ExternalWork targetArtifact 数据无效');
    const allowedExtensions = Array.isArray(item.allowedExtensions)
      ? uniqueExtensions(item.allowedExtensions as string[])
      : [];
    if (
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.required !== 'boolean' ||
      !Number.isInteger(item.maxSizeBytes) ||
      Number(item.maxSizeBytes) < 1 ||
      allowedExtensions.length === 0
    ) {
      throw new DomainError('PERSISTENCE_INVALID', 'ExternalWork targetArtifact 数据无效');
    }
    return {
      id: requiredId(item.id),
      name: requiredText(item.name, 'Artifact name', MAX_ARTIFACT_NAME_LENGTH),
      required: item.required,
      allowedExtensions,
      maxSizeBytes: Number(item.maxSizeBytes),
    };
  });
}

function targetWorkspacePathsFromRequest(request: ExternalWorkRequestRecord): string[] {
  const raw = request.targetWorkspacePathsJson;
  const values = Array.isArray(raw) ? raw : isRecord(raw) ? raw.items : null;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_TARGET_PATHS) {
    throw new DomainError('PERSISTENCE_INVALID', 'ExternalWork targetWorkspacePaths 数据无效');
  }
  return values.map((value) => normalizeRelativeWorkspacePath(value as string));
}

function validateInspectedArtifact(
  value: ValidatedWorkspaceArtifact,
  target: ExternalWorkArtifactTarget,
  normalizedPath: string,
): string {
  if (
    normalizedPath.length > MAX_RELATIVE_PATH_LENGTH ||
    normalizedPath !== normalizeRelativeWorkspacePath(value.relativePath) ||
    !Number.isInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > target.maxSizeBytes ||
    value.sizeBytes > MAX_ARTIFACT_SIZE_BYTES
  ) {
    throw new DomainError('INVALID_INPUT', 'Workspace Artifact 大小或路径验证失败');
  }
  const fileName = requiredText(value.fileName, 'fileName', MAX_ARTIFACT_NAME_LENGTH);
  if (
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName !== normalizedPath.split('/').at(-1)
  ) {
    throw new DomainError('INVALID_INPUT', 'Workspace validator 返回的 Artifact 文件名无效');
  }
  const extension = normalizeExtension(value.extension);
  if (!target.allowedExtensions.includes(extension)) {
    throw new DomainError('INVALID_INPUT', 'Artifact extension 不符合 target 要求');
  }
  if (!fileName.toLowerCase().endsWith(extension)) {
    throw new DomainError('INVALID_INPUT', 'Artifact extension 与文件名不匹配');
  }
  return extension;
}

function normalizeRelativeWorkspacePath(value: string): string {
  if (typeof value !== 'string')
    throw new DomainError('INVALID_INPUT', 'Workspace path 必须是文本');
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_RELATIVE_PATH_LENGTH ||
    trimmed.includes('\0') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    throw new DomainError('INVALID_INPUT', 'Workspace path 必须是 bounded relative path');
  }
  const segments = trimmed.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new DomainError('INVALID_INPUT', 'Workspace path 不允许 traversal');
  }
  const normalized = segments.filter(Boolean).join('/');
  if (!normalized) throw new DomainError('INVALID_INPUT', 'Workspace path 不能为空');
  return normalized;
}

function isInsideTargetPath(path: string, targets: readonly string[]): boolean {
  return targets.some((target) => {
    const normalizedTarget = normalizeRelativeWorkspacePath(target);
    return path === normalizedTarget || path.startsWith(`${normalizedTarget}/`);
  });
}

function uniqueDimensions(values: CapabilityDimension[], label: string): CapabilityDimension[] {
  if (!Array.isArray(values) || values.length > CAPABILITY_DIMENSIONS.length) {
    throw new DomainError('INVALID_INPUT', `${label} 数量无效`);
  }
  const result = new Set<CapabilityDimension>();
  for (const value of values) {
    if (!CAPABILITY_DIMENSIONS.includes(value))
      throw new DomainError('INVALID_INPUT', `${label} 包含无效 dimension`);
    result.add(value);
  }
  return [...result];
}

function uniqueExtensions(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_EXTENSION_COUNT) {
    throw new DomainError('INVALID_INPUT', 'allowedExtensions 数量无效');
  }
  return [...new Set(values.map(normalizeExtension))];
}

function normalizeExtension(value: string): string {
  if (typeof value !== 'string') throw new DomainError('INVALID_INPUT', 'extension 必须是文本');
  const extension = value.trim().toLowerCase();
  if (!/^\.[a-z0-9]{1,10}$/.test(extension))
    throw new DomainError('INVALID_INPUT', 'extension 格式无效');
  return extension;
}

function requiredId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new DomainError('INVALID_INPUT', '标识符无效');
  }
  return value;
}

function requiredText(value: string, label: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength)
    throw new DomainError('INVALID_INPUT', `${label}不能为空或超过长度限制`);
  return text;
}

function boundedText(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new DomainError('INVALID_INPUT', `${label} 超过长度限制`);
  }
  return value.trim();
}

function optionalBoundedText(
  value: string | null | undefined,
  maxLength: number,
  label: string,
): string | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  return boundedText(value, label, maxLength);
}

function boundedField(value: string, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function maxTimestamp(values: readonly string[]): string {
  return (
    [...values].sort((left, right) => {
      const leftDate = Date.parse(left);
      const rightDate = Date.parse(right);
      if (leftDate !== rightDate) return rightDate - leftDate;
      return right.localeCompare(left);
    })[0] ?? new Date(0).toISOString()
  );
}

function afterLatestTimestamp(candidate: string, priorValues: readonly string[]): string {
  const candidateTime = Date.parse(candidate);
  const latestPrior = priorValues.reduce(
    (latest, value) => Math.max(latest, Date.parse(value)),
    -1,
  );
  return latestPrior >= candidateTime ? new Date(latestPrior + 1).toISOString() : candidate;
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
