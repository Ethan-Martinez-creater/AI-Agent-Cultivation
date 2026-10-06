import React, { useEffect, useMemo, useState } from 'react';
import { Avatar } from './Avatar.js';
import type {
  GenerationArtifactView,
  MissionExecutionArtifactReferenceView,
  MissionExecutionAttemptView,
  MissionExecutionOutcomeView,
  MissionExecutionView,
  MissionParticipantView,
  TeammateView,
} from '../ui-shared.js';

type PublicStatus = {
  label: string;
  tone: 'neutral' | 'active' | 'waiting' | 'success' | 'attention';
  detail: string;
};

export function G3Collaboration({
  execution,
  participants,
  teammates,
  onRefresh,
}: {
  execution: MissionExecutionView;
  participants: MissionParticipantView[];
  teammates: TeammateView[];
  onRefresh?: () => void;
}) {
  const participantById = useMemo(
    () => new Map(participants.map((participant) => [participant.teammateId, participant])),
    [participants],
  );
  const teammateById = useMemo(
    () => new Map(teammates.map((teammate) => [teammate.id, teammate])),
    [teammates],
  );
  const outcomeByAttempt = useMemo(
    () => new Map(execution.outcomes.map((outcome) => [outcome.attemptId, outcome])),
    [execution.outcomes],
  );
  const attemptsByTask = useMemo(() => {
    const grouped = new Map<string, MissionExecutionAttemptView[]>();
    for (const attempt of execution.attempts) {
      const rows = grouped.get(attempt.taskId) ?? [];
      rows.push(attempt);
      grouped.set(attempt.taskId, rows);
    }
    for (const rows of grouped.values())
      rows.sort((left, right) => left.attemptNo - right.attemptNo);
    return grouped;
  }, [execution.attempts]);
  const completedCount = execution.tasks.filter((task) => {
    const attempts = attemptsByTask.get(task.id) ?? [];
    const latest = attempts.at(-1);
    const outcome = latest ? outcomeByAttempt.get(latest.id) : undefined;
    const participant = participantById.get(task.participantTeammateId);
    const isReviewer = participant?.role === 'REVIEWER' || task.role === 'REVIEWER';
    return (
      publicStatus(latest, outcome, latest?.executionProtocol ?? 'LANGUAGE', isReviewer, task)
        .tone === 'success'
    );
  }).length;

  return (
    <section className="mission-section g3-collaboration" aria-labelledby="g3-collaboration-title">
      <div className="section-heading g3-collaboration-heading">
        <div>
          <h2 id="g3-collaboration-title">协作执行进度</h2>
          <p>
            {completedCount} / {execution.tasks.length} 项已完成
          </p>
        </div>
        <div className="g3-collaboration-actions">
          {onRefresh && (
            <button className="button ghost small" type="button" onClick={onRefresh}>
              刷新进度
            </button>
          )}
        </div>
      </div>

      {execution.tasks.length === 0 ? (
        <p className="g3-empty-progress">等待协作任务分配。</p>
      ) : (
        <div className="g3-task-grid">
          {execution.tasks.map((task) => {
            const teammateId = task.participantTeammateId;
            const teammate = teammateById.get(teammateId);
            const participant = participantById.get(teammateId);
            const attempts = attemptsByTask.get(task.id) ?? [];
            const latest = attempts.at(-1);
            const outcome = latest ? outcomeByAttempt.get(latest.id) : undefined;
            const isReviewer = participant?.role === 'REVIEWER' || task.role === 'REVIEWER';
            const protocol = latest?.executionProtocol ?? 'LANGUAGE';
            const status = publicStatus(latest, outcome, protocol, isReviewer, task);
            return (
              <article className="g3-task-card" key={task.id}>
                <div className="g3-task-heading">
                  <Avatar
                    avatar={teammate?.avatar}
                    name={teammate?.name ?? '协作道友'}
                    kind={teammate?.executorKind === 'USER_BRIDGE' ? 'HUMAN_BRIDGE' : 'TEAMMATE'}
                    size={36}
                  />
                  <div className="g3-task-owner">
                    <strong>{teammate?.name ?? '协作道友'}</strong>
                    <small>{isReviewer ? '审查任务' : '协作任务'}</small>
                  </div>
                  <span className={`g3-status-pill g3-status-${status.tone}`}>{status.label}</span>
                </div>
                {task.description && (
                  <p className="g3-task-description">{publicTaskDescription(task.description)}</p>
                )}
                <p className="g3-task-status-detail">{status.detail}</p>
                {outcome?.outcome.publicResult && (
                  <div className="g3-public-result">{outcome.outcome.publicResult}</div>
                )}
                {outcome?.outcome.artifactRefs.length ? (
                  <div className="g3-artifact-grid" aria-label="协作成果">
                    {outcome.outcome.artifactRefs.map((reference) => {
                      const artifact = execution.artifacts.find((item) => item.id === reference.id);
                      return (
                        <G3ArtifactCard
                          key={reference.id}
                          reference={reference}
                          artifact={artifact}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      <details className="g3-advanced-details">
        <summary>高级 · 任务与尝试记录</summary>
        {execution.tasks.length > 0 && (
          <div className="g3-advanced-task-list">
            {execution.tasks.map((task) => (
              <section className="g3-advanced-task" key={task.id}>
                <strong>{teammateById.get(task.participantTeammateId)?.name ?? '协作道友'}</strong>
                <code>task: {task.id}</code>
                {task.description && <p>{task.description}</p>}
                {(attemptsByTask.get(task.id) ?? []).map((attempt) => (
                  <div className="g3-advanced-attempt" key={attempt.id}>
                    <span>尝试 {attempt.attemptNo}</span>
                    <code>attempt: {attempt.id}</code>
                    <code>state: {attempt.state}</code>
                    {attempt.executionProtocol && (
                      <code>protocol: {attempt.executionProtocol}</code>
                    )}
                    {attempt.generationJobId && <code>job: {attempt.generationJobId}</code>}
                    {attempt.errorCode && <code>error: {attempt.errorCode}</code>}
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
        {execution.outcomes.some((outcome) => outcome.outcome.artifactRefs.length > 0) && (
          <ul className="g3-advanced-artifact-list">
            {execution.outcomes.flatMap((outcome) =>
              outcome.outcome.artifactRefs.map((reference) => (
                <li key={`${outcome.id}:${reference.id}`}>
                  <code>artifact: {reference.id}</code>
                  <code>sha256: {reference.contentHash}</code>
                </li>
              )),
            )}
          </ul>
        )}
      </details>
    </section>
  );
}

function publicTaskDescription(value: string): string {
  return value
    .replace(
      /^MEMBER_TASK:\s*(?:Contribute to this Mission:\s*|Review this public draft for the Mission:\s*)?/,
      '',
    )
    .replace(/__G3_[A-Z_]+__/g, '')
    .trim();
}

function publicStatus(
  attempt: MissionExecutionAttemptView | undefined,
  outcome: MissionExecutionOutcomeView | undefined,
  protocol: string,
  isReviewer: boolean,
  task?: { retryNo?: number; reviewPending?: boolean },
): PublicStatus {
  if (task?.reviewPending)
    return { label: '正在审查', tone: 'waiting', detail: '等待本尊审查生成成果。' };
  const state = attempt?.state.toUpperCase() ?? '';
  const kind = outcome?.outcome.kind.toUpperCase() ?? '';
  const signal = `${state} ${kind}`;
  if (
    signal.includes('WAITING_INPUT') ||
    signal.includes('NEEDS_INPUT') ||
    signal.includes('INPUT_REQUIRED') ||
    signal.includes('INPUT_REQUEST') ||
    signal.includes('MISSING_INPUT') ||
    signal.includes('MATERIAL')
  ) {
    return { label: '需要素材', tone: 'waiting', detail: '补充所需素材后，协作即可继续。' };
  }
  if (
    signal.includes('WAITING_CAPABILITY') ||
    signal.includes('NEEDS_CAPABILITY') ||
    signal.includes('CAPABILITY_REQUIRED') ||
    signal.includes('CAPABILITY_REQUEST')
  ) {
    return { label: '请求能力', tone: 'waiting', detail: '正在请求完成此项工作所需的能力。' };
  }
  if (
    signal.includes('WAITING_USER') ||
    signal.includes('USER_ACTION') ||
    signal.includes('EXTERNAL_WORK') ||
    signal.includes('HUMAN')
  ) {
    return { label: '等待本尊', tone: 'waiting', detail: '等待本尊补充素材或确认交付。' };
  }
  if (state.includes('RETRYING') || state.includes('IN_RETRY')) {
    return { label: '正在重试', tone: 'active', detail: '上次尝试未完成，正在继续处理。' };
  }
  if (state.includes('FAILED_RETRYABLE') || kind.includes('RETRYABLE')) {
    return { label: '等待重试', tone: 'attention', detail: '当前尝试未完成，可以再次尝试。' };
  }
  if (state.includes('FAILED') || state.includes('TERMINAL')) {
    return { label: '需要关注', tone: 'attention', detail: '这项协作暂时未能完成。' };
  }
  if (state.includes('COMPLETED') || state.includes('SUCCEEDED') || outcome?.consumedAt) {
    return {
      label: isReviewer ? '审查完成' : '完成',
      tone: 'success',
      detail: isReviewer ? '审查意见已返回协调道友。' : '交付结果已返回协调道友。',
    };
  }
  if (state.includes('RUNNING') || state.includes('GENERATING') || state.includes('SUBMITTING')) {
    if ((task?.retryNo ?? 0) > 0 || (attempt && attempt.attemptNo > 1)) {
      return { label: '正在重试', tone: 'active', detail: '正在继续处理本次协作。' };
    }
    if (protocol === 'GENERATION') {
      return { label: '正在生成', tone: 'active', detail: '生成任务正在处理中。' };
    }
    return {
      label: isReviewer ? '正在审查' : '正在协作',
      tone: 'active',
      detail: isReviewer ? '正在检查协作交付。' : '协作道友正在处理分配的任务。',
    };
  }
  return {
    label: '已委派',
    tone: 'neutral',
    detail: attempt ? '任务已分配，等待开始处理。' : '任务已分配，等待执行记录。',
  };
}

function G3ArtifactCard({
  reference,
  artifact,
}: {
  reference: MissionExecutionArtifactReferenceView;
  artifact: GenerationArtifactView | undefined;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mimeType = artifact?.mimeType ?? reference.mimeType;
  const sizeBytes = artifact?.sizeBytes ?? reference.sizeBytes;
  const mediaKind = mimeType.startsWith('image/')
    ? 'image'
    : mimeType.startsWith('video/')
      ? 'video'
      : mimeType.startsWith('audio/')
        ? 'audio'
        : null;
  const metadata = artifact?.metadata ?? {};
  const width = numberMetadata(metadata.width);
  const height = numberMetadata(metadata.height);
  const duration = numberMetadata(metadata.durationSeconds ?? metadata.duration_seconds);
  const metadataText = [
    mimeType,
    formatBytes(sizeBytes),
    width !== null && height !== null ? `${width} × ${height}` : null,
    duration !== null ? `${duration} 秒` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' · ');

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setFailed(false);
    if (!mediaKind) return () => void (cancelled = true);
    void window.cultivation.generationChat.artifactUrl(reference.id).then(
      (url) => {
        if (!cancelled) setSource(url);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mediaKind, reference.id]);

  return (
    <article className="g3-artifact-card">
      {mediaKind && source ? (
        mediaKind === 'image' ? (
          <img className="g3-artifact-preview" src={source} alt="协作成果预览" />
        ) : mediaKind === 'video' ? (
          <video
            className="g3-artifact-preview"
            src={source}
            controls
            preload="metadata"
            aria-label="协作视频成果"
          />
        ) : (
          <audio className="g3-artifact-audio" src={source} controls aria-label="协作音频成果" />
        )
      ) : mediaKind ? (
        <div className="g3-artifact-pending" role={failed ? 'alert' : 'status'}>
          {failed ? '暂时无法加载预览。' : '正在准备成果预览…'}
        </div>
      ) : (
        <div className="g3-artifact-file" aria-hidden="true">
          文件
        </div>
      )}
      <div className="g3-artifact-copy">
        <strong>{artifactLabel(reference.kind, mimeType)}</strong>
        <span>{metadataText}</span>
      </div>
    </article>
  );
}

function artifactLabel(kind: string, mimeType: string): string {
  const normalized = kind.toUpperCase();
  if (normalized.includes('VIDEO') || mimeType.startsWith('video/')) return '视频成果';
  if (normalized.includes('IMAGE') || mimeType.startsWith('image/')) return '图片成果';
  if (normalized.includes('AUDIO') || mimeType.startsWith('audio/')) return '音频成果';
  return '生成成果';
}

function numberMetadata(value: number | string | boolean | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}
