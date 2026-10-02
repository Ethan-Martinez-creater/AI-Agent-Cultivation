import { WorkflowArtifactResult as ArtifactDisclosure } from '../components/WorkflowArtifactResult.js';
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  WorkflowArtifact,
  WorkflowDetail,
  WorkflowInputs,
  WorkflowRun,
  WorkflowRunState,
  WorkflowStepRun,
  WorkflowStepState,
  WorkflowVersion,
  WorkflowWaitReason,
} from '@cultivation/domain';
import { EMPTY_WORKFLOW_INPUT_SCHEMA } from '@cultivation/domain';
import type { CultivationBridge as PreloadBridge } from '../../../preload/preload.js';
import { EmptyState } from '../components/EmptyState.js';
import { Dialog } from '../components/Dialog.js';
import { Drawer } from '../components/Drawer.js';
import { Section } from '../components/Section.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { WorkflowInputForm } from '../components/WorkflowInputForm.js';
import { PageHeading } from '../ui-shared.js';
import './mission-party.css';
import './product-pages.css';
import './workflows.css';

type WorkflowAction = 'advance' | 'retryMission' | 'retryStep' | 'pause' | 'resume' | 'cancel';
type ConfirmableAction = Extract<WorkflowAction, 'retryMission' | 'retryStep' | 'cancel'>;
type PendingConfirmation = { action: ConfirmableAction; title: string; explanation: string };

const runLabels: Record<WorkflowRunState, string> = {
  DRAFT: '草稿',
  READY: '待开始',
  RUNNING: '运行中',
  WAITING: '等待处理',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};

const stepLabels: Record<WorkflowStepState, string> = {
  PENDING: '待执行',
  READY: '待开始',
  RUNNING: '运行中',
  WAITING: '等待处理',
  COMPLETED: '已完成',
  FAILED: '失败',
  SKIPPED: '已跳过',
  CANCELLED: '已取消',
};

const waitLabels: Record<WorkflowWaitReason, string> = {
  APPROVAL: '等待权限审批',
  EXTERNAL_WORK: '等待本尊交付',
  USER_CONFIRMATION: '等待用户确认',
  MISSION: '等待关联历练',
  DECISION: '等待工作流决策',
};

const waitDescriptions: Record<WorkflowWaitReason, string> = {
  APPROVAL: '请先在关联历练中处理审批，再返回这里同步状态。',
  EXTERNAL_WORK: '请先打开本尊待办并提交交付，再返回这里同步状态。',
  USER_CONFIRMATION: '执行结果需要你先检查。工作流不会自动重放可能产生副作用的步骤。',
  MISSION: '关联历练仍在处理中。完成或更新它后，再返回这里同步状态。',
  DECISION: '此步骤正在等待可用的决策信息。',
};

function versionKey(version: WorkflowVersion): string {
  return `${version.definition.id}::${version.version}`;
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}

function kindLabel(kind: WorkflowArtifact['kind']): string {
  const labels: Record<WorkflowArtifact['kind'], string> = {
    TEXT: '文本',
    JSON: 'JSON',
    FILE: '文件',
    DIRECTORY: '目录',
    EXTERNAL_REFERENCE: '外部引用',
  };
  return labels[kind];
}

function sortRuns(runs: WorkflowRun[]): WorkflowRun[] {
  return [...runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function latestAttempt(attempts: WorkflowStepRun[]): WorkflowStepRun | undefined {
  return [...attempts].sort((left, right) => right.attempt - left.attempt)[0];
}

function workflowName(definition: WorkflowVersion['definition']): string {
  return definition.name.replace(/\bTEST_ONLY\b/gi, '测试').trim() || '测试工作流';
}

function workflowStateTone(state: WorkflowRunState | WorkflowStepState) {
  if (state === 'COMPLETED') return 'success';
  if (state === 'FAILED' || state === 'CANCELLED') return 'danger';
  if (state === 'WAITING') return 'warning';
  return 'neutral';
}

function workflowApi() {
  return (window.cultivation as unknown as PreloadBridge).workflows;
}

function isTerminal(state: WorkflowRunState): boolean {
  return state === 'COMPLETED' || state === 'CANCELLED';
}

function isWorkflowInputError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 'WORKFLOW_INPUT_INVALID' ||
    (typeof candidate.message === 'string' &&
      (candidate.message.includes('工作流输入无效') ||
        candidate.message.includes('工作流输入字段 ')))
  );
}

function missionLink(missionId: string | null) {
  if (!missionId) return null;
  return (
    <Link
      className="workflow-inline-link"
      to={`/missions?missionId=${encodeURIComponent(missionId)}`}
    >
      查看关联历练
    </Link>
  );
}

export function WorkflowsPage() {
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedVersionKey, setSelectedVersionKey] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  const orderedVersions = useMemo(
    () =>
      [...versions].sort(
        (left, right) =>
          left.definition.name.localeCompare(right.definition.name, 'zh-Hans-CN') ||
          right.version - left.version,
      ),
    [versions],
  );
  const selectedVersion = orderedVersions.find(
    (version) => versionKey(version) === selectedVersionKey,
  );
  const orderedRuns = useMemo(() => sortRuns(runs), [runs]);
  const selectedRun = detail?.run ?? orderedRuns.find((run) => run.id === selectedRunId) ?? null;
  const lastStep = detail
    ? [...detail.steps].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    : undefined;
  const stepStates = detail
    ? detail.version.steps.map((step) => {
        const attempt = latestAttempt(detail.steps.filter((item) => item.stepId === step.id));
        return { step, attempt, state: attempt?.state ?? ('PENDING' as const) };
      })
    : [];
  const progressCount = stepStates.filter(
    ({ state }) => state === 'COMPLETED' || state === 'SKIPPED',
  ).length;
  const currentStep =
    stepStates.find(({ state }) => !['COMPLETED', 'SKIPPED', 'CANCELLED'].includes(state)) ??
    (lastStep ? stepStates.find(({ step }) => step.id === lastStep.stepId) : stepStates[0]);
  const workflowResults = detail
    ? detail.artifacts.filter((artifact) =>
        detail.bindings.some(
          (binding) => binding.artifactId === artifact.id && binding.role === 'OUTPUT',
        ),
      )
    : [];
  const retryableStep =
    detail?.run.state === 'FAILED'
      ? detail.version.steps
          .map((step) =>
            latestAttempt(detail.steps.filter((attempt) => attempt.stepId === step.id)),
          )
          .filter((attempt): attempt is WorkflowStepRun => attempt?.state === 'FAILED')
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
      : undefined;

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([workflowApi().versions(), workflowApi().list()])
      .then(([nextVersions, nextRuns]) => {
        if (!active) return;
        setVersions(nextVersions);
        setRuns(sortRuns(nextRuns));
        const firstVersion = nextVersions[0];
        if (firstVersion) setSelectedVersionKey((current) => current || versionKey(firstVersion));
        const newestRun = sortRuns(nextRuns)[0];
        if (newestRun) setSelectedRunId((current) => current || newestRun.id);
      })
      .catch(() => {
        if (active) setError('读取工作流列表失败，请稍后重试。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    void workflowApi()
      .detail(selectedRunId)
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch(() => {
        if (active) {
          setDetail(null);
          setError('读取工作流运行详情失败，请稍后重试。');
        }
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedRunId]);

  const refreshRuns = async (selectId?: string) => {
    const nextRuns = sortRuns(await workflowApi().list());
    setRuns(nextRuns);
    if (selectId) setSelectedRunId(selectId);
  };

  const startRun = async (inputs: WorkflowInputs) => {
    if (!selectedVersion) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const nextDetail = await workflowApi().create({
        definitionId: selectedVersion.definition.id,
        version: selectedVersion.version,
        inputs,
      });
      setDetail(nextDetail);
      setSelectedRunId(nextDetail.run.id);
      setCreateOpen(false);
      setNotice('工作流已创建，可检查步骤后开始执行。');
      try {
        await refreshRuns(nextDetail.run.id);
      } catch {
        setError('运行已创建，但运行历史刷新失败。请重新选择或稍后重试。');
      }
    } catch (error) {
      setError(
        isWorkflowInputError(error)
          ? '工作流输入校验失败，请检查必填项、格式和范围后重试。'
          : '创建工作流运行失败，请检查所选 Definition 后重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  const executeAction = async (action: WorkflowAction) => {
    if (!detail) return;
    setBusy(true);
    setError('');
    setNotice('');
    setPendingConfirmation(null);
    try {
      const nextDetail = await workflowApi()[action](detail.run.id);
      setDetail(nextDetail);
      const labels: Record<WorkflowAction, string> = {
        advance: '工作流状态已同步。',
        retryMission: '已为关联历练重新发起一次执行。',
        retryStep: '已重新尝试此步骤，之前的记录已保留。',
        pause: '工作流已暂停。',
        resume: '工作流已恢复。',
        cancel: '工作流已取消。',
      };
      setNotice(labels[action]);
      try {
        await refreshRuns(nextDetail.run.id);
      } catch {
        setError('操作已完成，但运行历史刷新失败。请稍后重试。');
      }
    } catch {
      setError('工作流操作未完成，请检查运行状态后重试。');
      try {
        const refreshed = await workflowApi().detail(detail.run.id);
        setDetail(refreshed);
        await refreshRuns(refreshed.run.id);
      } catch {
        // Keep the sanitized operation message when refreshing also fails.
      }
    } finally {
      setBusy(false);
    }
  };

  const requestConfirmation = (action: ConfirmableAction, title: string, explanation: string) =>
    setPendingConfirmation({ action, title, explanation });

  const confirmAction = () => {
    if (pendingConfirmation) void executeAction(pendingConfirmation.action);
  };

  const renderAttempt = (attempt: WorkflowStepRun, version: WorkflowVersion) => {
    const inputBindings =
      detail?.bindings.filter(
        (binding) => binding.stepRunId === attempt.id && binding.role === 'INPUT',
      ) ?? [];
    const outputBindings =
      detail?.bindings.filter(
        (binding) => binding.stepRunId === attempt.id && binding.role === 'OUTPUT',
      ) ?? [];
    const inputArtifacts = inputBindings.flatMap((binding) => {
      const artifact = detail?.artifacts.find((item) => item.id === binding.artifactId);
      return artifact ? [{ artifact, label: `${binding.key} · ${artifact.kind}` }] : [];
    });
    const outputArtifacts = (detail?.artifacts ?? [])
      .filter((artifact) => artifact.producerStepRunId === attempt.id)
      .map((artifact) => ({
        artifact,
        label:
          outputBindings.find((binding) => binding.artifactId === artifact.id)?.key ??
          version.steps
            .find((step) => step.id === attempt.stepId)
            ?.outputs.find((output) => output.kind === artifact.kind)?.key ??
          kindLabel(artifact.kind),
      }));
    const stepDefinition = version.steps.find((step) => step.id === attempt.stepId);
    const waitReason = attempt.waitReason;
    return (
      <div className="workflow-attempt" key={attempt.id}>
        <div className="workflow-attempt-heading">
          <strong>尝试 {attempt.attempt}</strong>
          <StatusBadge tone={workflowStateTone(attempt.state)}>
            {stepLabels[attempt.state]}
          </StatusBadge>
        </div>
        {waitReason && (
          <p className="workflow-wait-note">
            {waitLabels[waitReason]}：{waitDescriptions[waitReason]}
          </p>
        )}
        <details className="workflow-technical-details">
          <summary>高级 · 尝试记录</summary>
          {attempt.errorCode && <p>错误代码：{attempt.errorCode}</p>}
          {stepDefinition?.inputs.length ? (
            <p className="workflow-declared-inputs">
              输入绑定：
              {stepDefinition.inputs
                .map((input) => `${input.key} ← ${input.fromStepId}.${input.outputKey}`)
                .join('、')}
            </p>
          ) : null}
        </details>
        {(inputArtifacts.length > 0 || outputArtifacts.length > 0) && (
          <div className="workflow-artifact-groups">
            {inputArtifacts.length > 0 && (
              <details className="workflow-data-group">
                <summary>已绑定输入 · {inputArtifacts.length}</summary>
                {inputArtifacts.map(({ artifact, label }) => (
                  <ArtifactDisclosure key={artifact.id} artifact={artifact} label={label} />
                ))}
              </details>
            )}
            {outputArtifacts.length > 0 && (
              <details className="workflow-data-group">
                <summary>已生成输出 · {outputArtifacts.length}</summary>
                {outputArtifacts.map(({ artifact, label }) => (
                  <ArtifactDisclosure key={artifact.id} artifact={artifact} label={label} />
                ))}
              </details>
            )}
          </div>
        )}
        <div className="workflow-attempt-links">
          {missionLink(attempt.missionId)}
          {attempt.waitReason === 'EXTERNAL_WORK' && (
            <Link className="workflow-inline-link" to="/external-work">
              打开本尊待办
            </Link>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="page wide-page workflow-page object-page">
      <PageHeading
        eyebrow="任务中心"
        title="工作流历练"
        description="按可用版本启动工作流，并查看每一步的状态、关联历练和交付记录。"
      />
      <nav className="workflow-hub-switch" aria-label="历练类型">
        <Link to="/missions">自由历练</Link>
        <Link to="/workflows" aria-current="page" className="active">
          工作流历练
        </Link>
      </nav>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}

      <div className="workflow-workspace object-list-detail-layout">
        <aside className="workflow-history object-list-pane">
          <Section
            title="运行历史"
            className="workflow-history-section"
            action={
              <button
                className="button primary small"
                type="button"
                disabled={busy || orderedVersions.length === 0}
                onClick={() => setCreateOpen(true)}
              >
                新建运行
              </button>
            }
          >
            <p className="object-list-summary">{orderedRuns.length} 次运行</p>
            {loading ? (
              <div className="loading-card">正在读取工作流…</div>
            ) : orderedRuns.length ? (
              <div className="workflow-run-list">
                {orderedRuns.map((run) => {
                  const definition = versions.find(
                    (version) =>
                      version.definition.id === run.definitionId &&
                      version.version === run.definitionVersion,
                  )?.definition;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      className={`workflow-run-item ${run.id === selectedRunId ? 'selected' : ''}`}
                      onClick={() => {
                        setError('');
                        setNotice('');
                        setSelectedRunId(run.id);
                      }}
                    >
                      <span className="workflow-run-item-title">
                        <strong>{definition ? workflowName(definition) : '工作流运行'}</strong>
                        <StatusBadge tone={workflowStateTone(run.state)}>
                          {runLabels[run.state]}
                        </StatusBadge>
                      </span>
                      <small>{when(run.updatedAt)}</small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="workflow-empty-copy">
                暂无工作流运行历史。选择一个已注册版本后即可启动。
              </p>
            )}
          </Section>
        </aside>

        <div className="workflow-main-column object-detail-pane">
          <Drawer
            title="新建工作流运行"
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            className="workflow-launch-drawer"
          >
            <section className="workflow-launch-card">
              <p className="product-drawer-intro">
                选择版本并填写必需输入，创建后可检查步骤再开始执行。
              </p>
              {orderedVersions.length ? (
                <div className="workflow-launch-controls">
                  <label htmlFor="workflow-version-select">工作流版本</label>
                  <div className="workflow-launch-row">
                    <select
                      id="workflow-version-select"
                      value={selectedVersionKey}
                      onChange={(event) => setSelectedVersionKey(event.target.value)}
                      disabled={busy}
                    >
                      {orderedVersions.map((version) => (
                        <option key={versionKey(version)} value={versionKey(version)}>
                          {workflowName(version.definition)} · v{version.version}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedVersion && (
                    <p className="workflow-version-description">
                      {(selectedVersion.definition.description ?? '').replace(
                        /\bTEST_ONLY\b/gi,
                        '测试专用',
                      ) || '暂无说明。'}
                    </p>
                  )}
                  {selectedVersion && (
                    <WorkflowInputForm
                      key={versionKey(selectedVersion)}
                      schema={selectedVersion.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA}
                      busy={busy}
                      onSubmit={startRun}
                    />
                  )}
                </div>
              ) : (
                <div className="workflow-no-definitions" role="status">
                  <strong>{loading ? '正在读取工作流…' : '暂无可运行工作流'}</strong>
                  <p>目前没有可启动的工作流。</p>
                </div>
              )}
            </section>
          </Drawer>

          {detailLoading ? (
            <div className="workflow-detail-placeholder loading-card">正在读取运行详情…</div>
          ) : detail ? (
            <>
              <section className="workflow-overview object-header">
                <div className="workflow-overview-heading">
                  <div className="object-header-copy">
                    <h2>{workflowName(detail.version.definition)}</h2>
                    <div className="object-header-meta">
                      <span>
                        当前步骤：{currentStep?.step.title ?? '全部步骤已结束'}
                        {currentStep && currentStep.state !== 'PENDING' && (
                          <> · {stepLabels[currentStep.state]}</>
                        )}
                      </span>
                      <span>
                        进度：{progressCount} / {detail.version.steps.length} 步已完成
                      </span>
                    </div>
                  </div>
                  <StatusBadge tone={workflowStateTone(detail.run.state)}>
                    {runLabels[detail.run.state]}
                  </StatusBadge>
                </div>
                {detail.events.some((event) => event.type === 'workflow.integrity_failed') && (
                  <div className="workflow-wait-panel" role="alert">
                    <strong>运行无法安全继续</strong>
                    <p>请保留高级记录供排查；已完成步骤不会自动重放。</p>
                  </div>
                )}
                {detail.run.state === 'WAITING' && detail.run.waitReason && (
                  <div className="workflow-wait-panel">
                    <strong>{waitLabels[detail.run.waitReason]}</strong>
                    <p>{waitDescriptions[detail.run.waitReason]}</p>
                    {detail.run.waitReason === 'EXTERNAL_WORK' && (
                      <Link className="workflow-inline-link" to="/external-work">
                        打开本尊待办
                      </Link>
                    )}
                    {lastStep && missionLink(lastStep.missionId)}
                  </div>
                )}
                <div className="workflow-actions">
                  {(detail.run.state === 'READY' ||
                    detail.run.state === 'RUNNING' ||
                    detail.run.state === 'WAITING') && (
                    <button
                      className="button primary small"
                      type="button"
                      disabled={busy}
                      onClick={() => void executeAction('advance')}
                    >
                      {detail.run.state === 'READY'
                        ? '开始执行'
                        : detail.run.state === 'WAITING'
                          ? '同步并检查等待状态'
                          : '检查进度并继续'}
                    </button>
                  )}
                  {detail.run.state === 'RUNNING' && (
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() => void executeAction('pause')}
                    >
                      暂停
                    </button>
                  )}
                  {detail.run.state === 'PAUSED' && (
                    <button
                      className="button primary small"
                      type="button"
                      disabled={busy}
                      onClick={() => void executeAction('resume')}
                    >
                      恢复工作流
                    </button>
                  )}
                  {retryableStep?.missionId && (
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        requestConfirmation(
                          'retryMission',
                          '重新发起关联历练',
                          '原历练和已有执行记录会保留，并开始一次新的执行。请先确认上一次执行结果及其副作用已经厘清。',
                        )
                      }
                    >
                      重新发起关联历练
                    </button>
                  )}
                  {retryableStep && (
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        requestConfirmation(
                          'retryStep',
                          '重新执行失败步骤',
                          '之前的执行记录会保留。请先核实已有文件及外部动作；如果上一次操作结果仍不确定，重试可能重复产生影响。仅在你明确决定重新执行后确认。',
                        )
                      }
                    >
                      重试失败步骤
                    </button>
                  )}
                  {!isTerminal(detail.run.state) && (
                    <button
                      className="button danger-ghost small"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        requestConfirmation(
                          'cancel',
                          '取消此工作流运行',
                          '取消后工作流不会继续推进。已完成的 Mission 和交付记录仍会保留。',
                        )
                      }
                    >
                      取消工作流
                    </button>
                  )}
                </div>
                <Dialog
                  title={pendingConfirmation?.title ?? '确认操作'}
                  open={pendingConfirmation !== null}
                  onClose={() => setPendingConfirmation(null)}
                >
                  {pendingConfirmation && (
                    <div>
                      <div>
                        <p>{pendingConfirmation.explanation}</p>
                      </div>
                      <div className="button-row drawer-actions">
                        <button
                          className="button secondary small"
                          type="button"
                          disabled={busy}
                          onClick={() => setPendingConfirmation(null)}
                        >
                          返回检查
                        </button>
                        <button
                          className={
                            pendingConfirmation.action === 'cancel'
                              ? 'button danger small'
                              : 'button primary small'
                          }
                          type="button"
                          disabled={busy}
                          onClick={confirmAction}
                        >
                          {pendingConfirmation.action === 'cancel' ? '确认取消' : '确认并重试'}
                        </button>
                      </div>
                    </div>
                  )}
                </Dialog>
              </section>

              {workflowResults.length > 0 && (
                <Section
                  title="交付结果"
                  className="workflow-results object-section"
                  action={<span className="count-badge">{workflowResults.length}</span>}
                >
                  {workflowResults.map((artifact) => (
                    <ArtifactDisclosure
                      key={artifact.id}
                      artifact={artifact}
                      binding={detail.bindings.find(
                        (binding) =>
                          binding.artifactId === artifact.id && binding.role === 'OUTPUT',
                      )}
                      label={
                        detail.bindings.find(
                          (binding) =>
                            binding.artifactId === artifact.id && binding.role === 'OUTPUT',
                        )?.key ?? kindLabel(artifact.kind)
                      }
                    />
                  ))}
                </Section>
              )}

              <Section
                title="执行进度"
                className="workflow-steps-card object-section"
                action={
                  <span className="count-badge">
                    {progressCount} / {detail.version.steps.length}
                  </span>
                }
              >
                <progress
                  className="workflow-progress"
                  max={Math.max(detail.version.steps.length, 1)}
                  value={progressCount}
                  aria-label="工作流完成步骤数"
                />
                <ol className="workflow-step-list">
                  {stepStates.map(({ step, state }, index) => {
                    const attempts = detail.steps
                      .filter((attempt) => attempt.stepId === step.id)
                      .sort((left, right) => left.attempt - right.attempt);
                    return (
                      <li key={step.id} className={`workflow-step state-${state.toLowerCase()}`}>
                        <div className="workflow-step-heading">
                          <span className="workflow-step-number">{index + 1}</span>
                          <div className="workflow-step-title">
                            <strong>{step.title}</strong>
                          </div>
                          <StatusBadge tone={workflowStateTone(state)}>
                            {stepLabels[state]}
                          </StatusBadge>
                        </div>
                        <details className="workflow-step-details">
                          <summary>
                            {attempts.length
                              ? `查看步骤详情 · ${attempts.length} 次尝试`
                              : '查看步骤详情'}
                          </summary>
                          <p className="workflow-step-objective">{step.objective}</p>
                          <div className="workflow-step-contract">
                            <span>输入 {step.inputs.length}</span>
                            <span>输出 {step.outputs.length}</span>
                            <span>最多尝试 {step.maxAttempts} 次</span>
                          </div>
                          {attempts.length > 0 ? (
                            <div className="workflow-attempt-list">
                              {attempts.map((attempt) => renderAttempt(attempt, detail.version))}
                            </div>
                          ) : (
                            <p className="workflow-no-attempt">此步骤尚未开始。</p>
                          )}
                          <details className="workflow-technical-details">
                            <summary>高级 · 步骤约定</summary>
                            <dl>
                              <div>
                                <dt>步骤编号</dt>
                                <dd>
                                  <code>{step.id}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>步骤类型</dt>
                                <dd>
                                  <code>{step.type}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>副作用类型</dt>
                                <dd>
                                  <code>{step.effectType}</code>
                                </dd>
                              </div>
                            </dl>
                          </details>
                        </details>
                      </li>
                    );
                  })}
                </ol>
              </Section>

              <details className="workflow-advanced-card advanced-disclosure">
                <summary>高级记录</summary>
                <div className="workflow-advanced-content">
                  <section>
                    <h3>运行信息</h3>
                    <dl>
                      <div>
                        <dt>Run ID</dt>
                        <dd>
                          <code>{detail.run.id}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Definition ID</dt>
                        <dd>
                          <code>{detail.version.definition.id}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>版本 / 分类 / 来源</dt>
                        <dd>
                          v{detail.version.version} ·{' '}
                          {detail.version.definition.category || '未分类'} ·{' '}
                          {detail.version.definition.source}
                        </dd>
                      </div>
                    </dl>
                    {detail.run.inputSnapshot !== undefined && (
                      <details className="workflow-input-snapshot">
                        <summary>本次固定输入</summary>
                        {Object.keys(detail.run.inputSnapshot).length ? (
                          <pre>{JSON.stringify(detail.run.inputSnapshot, null, 2)}</pre>
                        ) : (
                          <p>本次运行没有输入字段。</p>
                        )}
                      </details>
                    )}
                  </section>
                  <section>
                    <h3>验证回执 · {detail.validations.length}</h3>
                    {detail.validations.length ? (
                      <ul>
                        {detail.validations.map((receipt) => (
                          <li key={receipt.id}>
                            <strong>{receipt.valid ? '通过' : '未通过'}</strong> ·{' '}
                            {receipt.contractId} v{receipt.contractVersion} ·{' '}
                            {receipt.validatorVersion}
                            {receipt.errors.length > 0 && <p>{receipt.errors.join('；')}</p>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>暂无验证回执。</p>
                    )}
                  </section>
                  <section>
                    <h3>决策与检查点</h3>
                    {detail.decisions.length ? (
                      <ul>
                        {detail.decisions.map((decision) => (
                          <li key={decision.id}>
                            {decision.branch} · {decision.edgeId} · {when(decision.createdAt)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>暂无决策记录。</p>
                    )}
                    {detail.checkpoints.length ? (
                      <ul>
                        {detail.checkpoints.map((checkpoint) => (
                          <li key={checkpoint.id}>
                            检查点 {checkpoint.sequence} · v{checkpoint.definitionVersion} ·{' '}
                            <code>{checkpoint.stateHash.slice(0, 16)}</code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>暂无检查点。</p>
                    )}
                  </section>
                  <section>
                    <h3>副作用回执与修订预算</h3>
                    {(detail.operations ?? []).map((receipt) => (
                      <p key={receipt.id}>
                        {receipt.effectType} · {receipt.state} · attempt {receipt.attempt}
                        <br />
                        <code>{receipt.operationKey}</code>
                      </p>
                    ))}
                    {(detail.operations ?? []).some((o) => o.state === 'UNKNOWN') && (
                      <p>副作用结果尚不确定。请先核实，应用不会自动重放。</p>
                    )}
                    {(detail.version.revisionGroups ?? []).map((group) => (
                      <p key={group.id}>
                        {group.id} ·{' '}
                        {(detail.traversals ?? []).filter((t) => t.groupId === group.id).length} /{' '}
                        {group.maxTotalTraversals}
                      </p>
                    ))}
                  </section>
                  <section>
                    <h3>工作流事件 · {detail.events.length}</h3>
                    {detail.events.length ? (
                      <ul className="workflow-event-list">
                        {detail.events.map((event) => (
                          <li key={event.id}>
                            <span>{event.type}</span>
                            <small>{when(event.createdAt)}</small>
                            <code>{JSON.stringify(event.payload)}</code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>暂无事件。</p>
                    )}
                  </section>
                </div>
              </details>
            </>
          ) : (
            <div className="workflow-detail-placeholder">
              <EmptyState
                icon="Workflow"
                title={selectedRun ? '无法读取工作流运行' : '选择一次运行或启动工作流'}
                description={
                  selectedRun
                    ? '此运行的详情暂时不可用，请从运行历史重新选择。'
                    : '运行详情会展示冻结版本中的步骤顺序、Mission 关联和每次尝试的交付记录。'
                }
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
