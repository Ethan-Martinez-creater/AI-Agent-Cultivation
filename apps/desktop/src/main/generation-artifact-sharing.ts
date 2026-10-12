import { randomUUID } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import type { AuditEvent, Mission, MissionEvent, MissionRun } from '@cultivation/domain';
import type { ArtifactRef } from '@cultivation/domain/g3-execution';
import type {
  GenerationArtifact,
  GenerationJob,
  GenerationTask,
} from '@cultivation/domain/g1-generation';
import type { GenerationArtifactPort } from '@cultivation/application/g1-generation';
import type { Gate3SqliteRepository } from '@cultivation/persistence';
import type { G3SqliteRepository } from '@cultivation/persistence/g3-execution';
import type { GenerationSqliteRepository } from '@cultivation/persistence/g1-generation';

const SHARE_EVENT = 'collaboration.artifact_shared';
const MAX_SHARED_ARTIFACTS_PER_RUN = 16;
const TERMINAL_MISSION_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
const MIME_KIND = new Map<string, string>([
  ['image/png', 'IMAGE'],
  ['image/jpeg', 'IMAGE'],
  ['image/jpg', 'IMAGE'],
  ['image/webp', 'IMAGE'],
  ['video/mp4', 'VIDEO'],
  ['audio/wav', 'AUDIO'],
  ['audio/wave', 'AUDIO'],
  ['audio/x-wav', 'AUDIO'],
  ['audio/mpeg', 'AUDIO'],
  ['audio/mp3', 'AUDIO'],
  ['audio/x-mp3', 'AUDIO'],
]);

interface ShareInput {
  missionId: string;
  runId: string;
  artifactId: string;
}

interface ShareFacts {
  [key: string]: unknown;
  sourceJobId: string;
  artifactId: string;
  kind: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
}

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function assertInput(input: ShareInput): void {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    Object.keys(input).some((key) => !['missionId', 'runId', 'artifactId'].includes(key)) ||
    typeof input.missionId !== 'string' ||
    !input.missionId.trim() ||
    typeof input.runId !== 'string' ||
    !input.runId.trim() ||
    typeof input.artifactId !== 'string' ||
    !input.artifactId.trim()
  )
    fail('INVALID_INPUT', 'Artifact 分享必须提供 Mission、Run 与 Artifact ID');
}

function assertCurrentRun(
  missions: Gate3SqliteRepository,
  missionId: string,
  runId: string,
): { mission: Mission; run: MissionRun } {
  const mission = missions.getMission(missionId);
  if (!mission || TERMINAL_MISSION_STATES.has(mission.state))
    fail('MISSION_NOT_ACTIVE', 'Mission 不存在或已经结束');

  const run = missions.getRun(runId);
  if (
    !run ||
    run.missionId !== missionId ||
    run.status !== 'RUNNING' ||
    missions.listRuns(missionId).at(-1)?.id !== runId
  )
    fail('RUN_NOT_CURRENT', 'Artifact 只能分享给该 Mission 当前运行中的最新 Run');

  return { mission, run };
}

function requireShareableArtifact(
  job: GenerationJob | null,
  artifact: GenerationArtifact | null,
  task: GenerationTask | null,
  artifactId: string,
): { job: GenerationJob; artifact: GenerationArtifact; task: GenerationTask } {
  if (!job || job.state !== 'COMPLETED' || !job.outputArtifactIds.includes(artifactId))
    fail('ARTIFACT_NOT_COMPLETED', 'Artifact 必须来自已完成的生成任务');
  if (!artifact || artifact.id !== artifactId || artifact.jobId !== job.id || !task)
    fail('ARTIFACT_PROVENANCE', 'Artifact 与生成任务的来源不匹配');
  if (task.id !== job.generationTaskId)
    fail('ARTIFACT_PROVENANCE', 'Artifact 来源任务 identity 无效');
  if (
    task.outputDestination.scope !== 'APP_ARTIFACT_STORE' ||
    artifact.storageScope !== 'APP_ARTIFACT_STORE'
  )
    fail('ARTIFACT_PROVENANCE', '只有 APP Artifact Store 中的素材可以分享');
  if (MIME_KIND.get(artifact.mimeType.toLowerCase()) !== artifact.kind)
    fail('UNSUPPORTED_MEDIA_TYPE', 'Artifact 必须是已知 MIME 的图片、视频或音频');
  if (
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(artifact.contentHash)
  )
    fail('ARTIFACT_INTEGRITY', 'Artifact 元数据不满足完整性要求');
  return { job, artifact, task };
}

function sameRun(left: MissionRun, right: MissionRun): boolean {
  return (
    left.id === right.id &&
    left.missionId === right.missionId &&
    left.attempt === right.attempt &&
    left.status === right.status
  );
}

function sameJob(left: GenerationJob, right: GenerationJob): boolean {
  return (
    left.id === right.id &&
    left.generationTaskId === right.generationTaskId &&
    left.state === right.state &&
    left.completedAt === right.completedAt &&
    JSON.stringify(left.outputArtifactIds) === JSON.stringify(right.outputArtifactIds)
  );
}

function sameArtifact(left: GenerationArtifact, right: GenerationArtifact): boolean {
  return (
    left.id === right.id &&
    left.jobId === right.jobId &&
    left.outputId === right.outputId &&
    left.kind === right.kind &&
    left.mimeType === right.mimeType &&
    left.extension === right.extension &&
    left.sizeBytes === right.sizeBytes &&
    left.contentHash === right.contentHash &&
    left.storageScope === right.storageScope &&
    left.storageKey === right.storageKey &&
    left.createdAt === right.createdAt &&
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata)
  );
}

function samePayload(value: Record<string, unknown>, expected: ShareFacts): boolean {
  return (
    value.sourceJobId === expected.sourceJobId &&
    value.artifactId === expected.artifactId &&
    value.kind === expected.kind &&
    value.mimeType === expected.mimeType &&
    value.contentHash === expected.contentHash &&
    value.sizeBytes === expected.sizeBytes
  );
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.mimeType === right.mimeType &&
    left.contentHash === right.contentHash &&
    left.sizeBytes === right.sizeBytes
  );
}

function toArtifactRef(artifact: GenerationArtifact): ArtifactRef {
  return {
    id: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
  };
}

/** Shares a verified Generation Artifact into one active Mission Run as a user-approved import. */
export class GenerationArtifactSharingService {
  constructor(
    private readonly options: {
      missions: Gate3SqliteRepository;
      execution: G3SqliteRepository;
      generation: GenerationSqliteRepository;
      artifacts: GenerationArtifactPort;
    },
  ) {}

  async share(input: ShareInput): Promise<ArtifactRef> {
    assertInput(input);
    const { missions, execution, generation, artifacts } = this.options;
    const target = assertCurrentRun(missions, input.missionId, input.runId);
    const artifactRow = generation.getArtifact(input.artifactId);
    const jobRow = artifactRow ? generation.getJob(artifactRow.jobId) : null;
    const taskRow = jobRow ? generation.getTask(jobRow.generationTaskId) : null;
    const { artifact, job, task } = requireShareableArtifact(
      jobRow,
      artifactRow,
      taskRow,
      input.artifactId,
    );

    // Verification is performed by the Main-owned port, which checks the real file and canonical identity.
    await artifacts.verify(artifact, task);

    const expectedRef = toArtifactRef(artifact);
    const payload: ShareFacts = {
      sourceJobId: job.id,
      artifactId: artifact.id,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      contentHash: artifact.contentHash,
      sizeBytes: artifact.sizeBytes,
    };

    return missions.transaction(() => {
      const currentTarget = assertCurrentRun(missions, input.missionId, input.runId);
      if (!sameRun(currentTarget.run, target.run))
        fail('RUN_NOT_CURRENT', 'Artifact 分享期间 Mission Run 已改变');

      const currentJob = generation.getJob(job.id);
      const currentArtifact = generation.getArtifact(artifact.id);
      const currentTask = generation.getTask(task.id);
      if (
        !currentJob ||
        !currentArtifact ||
        !currentTask ||
        !sameJob(job, currentJob) ||
        !sameArtifact(artifact, currentArtifact) ||
        JSON.stringify(task) !== JSON.stringify(currentTask)
      )
        fail('ARTIFACT_INTEGRITY', 'Artifact 来源或 identity 在分享期间发生改变');
      requireShareableArtifact(currentJob, currentArtifact, currentTask, input.artifactId);

      const events = missions
        .listMissionEvents(input.missionId)
        .filter((event) => event.runId === input.runId && event.eventType === SHARE_EVENT);
      const existingEvents = events.filter((event) => event.payloadJson.artifactId === artifact.id);
      const audits = missions
        .listAuditEvents(input.missionId)
        .filter(
          (audit) =>
            audit.action === SHARE_EVENT &&
            audit.targetType === 'MISSION_RUN' &&
            audit.targetId === input.runId &&
            audit.payloadJson.artifactId === artifact.id,
        );

      if (existingEvents.length || audits.length) {
        if (existingEvents.length !== 1 || audits.length !== 1)
          fail('ARTIFACT_REF_CONFLICT', 'Artifact 分享历史不完整或重复');
        const event = existingEvents[0]!;
        const audit = audits[0]!;
        if (
          event.actorType !== 'USER' ||
          event.actorId !== 'local-user' ||
          audit.actorType !== 'USER' ||
          audit.actorId !== 'local-user' ||
          !samePayload(event.payloadJson, payload) ||
          !samePayload(audit.payloadJson, payload)
        )
          fail('ARTIFACT_REF_CONFLICT', 'Artifact 分享历史与当前素材 identity 不匹配');
        const registered = execution.registerArtifactRef(
          input.missionId,
          input.runId,
          expectedRef,
          {
            type: 'APPROVED_IMPORT',
            id: event.id,
          },
        );
        if (!sameRef(registered, expectedRef))
          fail('ARTIFACT_REF_CONFLICT', '已登记 ArtifactRef 与当前素材 identity 不匹配');
        return registered;
      }

      if (events.length >= MAX_SHARED_ARTIFACTS_PER_RUN)
        fail('ARTIFACT_SHARE_LIMIT', '每个 Run 最多分享 16 个 Artifact');

      const at = new Date().toISOString();
      const event: MissionEvent = {
        id: randomUUID(),
        missionId: input.missionId,
        runId: input.runId,
        eventType: SHARE_EVENT,
        actorType: 'USER',
        actorId: 'local-user',
        payloadJson: payload,
        createdAt: at,
      };
      const audit: AuditEvent = {
        id: randomUUID(),
        actorType: 'USER',
        actorId: 'local-user',
        action: SHARE_EVENT,
        targetType: 'MISSION_RUN',
        targetId: input.runId,
        payloadJson: payload,
        createdAt: at,
      };

      missions.appendMissionEvent(event);
      missions.appendAuditEvent(audit);
      return execution.registerArtifactRef(input.missionId, input.runId, expectedRef, {
        type: 'APPROVED_IMPORT',
        id: event.id,
      });
    });
  }
}
