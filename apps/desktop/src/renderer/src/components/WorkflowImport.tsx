import React, { useEffect, useMemo, useState } from 'react';
import {
  EMPTY_WORKFLOW_INPUT_SCHEMA,
  type WorkflowDetail,
  type WorkflowInputs,
  type WorkflowStepDefinition,
  type WorkflowVersion,
  type WorkflowImportProposalSafeDto,
} from '@cultivation/domain';
import { Drawer } from './Drawer.js';
import { StatusBadge } from './StatusBadge.js';
import { WorkflowInputForm } from './WorkflowInputForm.js';
import { workflowInputPresentationFor } from './workflow-input-presentations.js';
import './WorkflowImport.css';

export type WorkflowImportProposal = WorkflowImportProposalSafeDto;

type WorkflowImportApi = typeof window.cultivation.workflowImports;

function workflowImportApiOrNull(): WorkflowImportApi | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.cultivation;
  const api = bridge.workflowImports;
  if (
    !api ||
    !['list', 'prepare', 'selectSource', 'revise', 'confirm', 'cancel', 'get'].every(
      (key) => typeof api[key as keyof WorkflowImportApi] === 'function',
    )
  )
    return null;
  return api;
}

/** Hide the Library entry until the trusted import bridge is available. */
export function workflowImportAvailable(): boolean {
  return workflowImportApiOrNull() !== null;
}

function isSupportedImportVersion(version: WorkflowVersion): boolean {
  return (
    version.definition.source === 'USER' ||
    (version.definition.source === 'BUILTIN' &&
      version.definition.id === 'official.research' &&
      version.version === 1)
  );
}

function hasLinearAlwaysSuccessor(
  version: WorkflowVersion,
  stepId: string,
): WorkflowStepDefinition | null {
  const outgoing = version.edges.filter((edge) => edge.fromStepId === stepId);
  if (outgoing.length !== 1) return null;
  const [edge] = outgoing;
  if (
    !edge ||
    edge.condition.type !== 'ALWAYS' ||
    edge.revision !== undefined ||
    edge.revisionCode !== undefined ||
    edge.toStepId === null
  )
    return null;
  return version.steps.find((step) => step.id === edge.toStepId) ?? null;
}

function isImportableStep(step: WorkflowStepDefinition): boolean {
  return (
    step.type === 'TASK' &&
    step.effectType === 'NONE' &&
    step.exitCondition === 'VALID_OUTPUTS' &&
    !step.confirmationRequired &&
    !step.executionRequirements?.generation &&
    step.outputs.length > 0 &&
    !step.effectPaths?.length &&
    step.effectPathMode === undefined &&
    step.outputs.every((output) => output.kind === 'TEXT' || output.kind === 'JSON')
  );
}

/** Walk the frozen entry path; an import always leaves a real step to execute. */
export function importableStepPrefix(version: WorkflowVersion): WorkflowStepDefinition[] {
  if (!isSupportedImportVersion(version)) return [];
  const isOfficialResearch =
    version.definition.source === 'BUILTIN' && version.definition.id === 'official.research';
  if (isOfficialResearch && version.entryStepId !== 'R01') return [];
  const prefix: WorkflowStepDefinition[] = [];
  const visited = new Set<string>();
  let step = version.steps.find((candidate) => candidate.id === version.entryStepId) ?? null;
  while (step && !visited.has(step.id)) {
    visited.add(step.id);
    if (!isImportableStep(step)) break;
    if (isOfficialResearch && step.id !== 'R01') break;
    const successor = hasLinearAlwaysSuccessor(version, step.id);
    // Do not offer terminal steps: every imported run must continue through execution.
    if (!successor || visited.has(successor.id)) break;
    prefix.push(step);
    // The supported official research policy permits importing only its R01 brief.
    if (isOfficialResearch) break;
    step = successor;
  }
  return prefix;
}

export type CompletionOrigin = 'IMPORTED_CONFIRMED' | 'EXECUTED';

/** Older Run rows have no origin field and retain their historical executed meaning. */
export function completionOriginOf(value: unknown): CompletionOrigin {
  if (!value || typeof value !== 'object') return 'EXECUTED';
  const record = value as { completionOrigin?: unknown; source?: unknown };
  const origin = record.completionOrigin ?? record.source;
  return typeof origin === 'string' && origin.toUpperCase() === 'IMPORTED_CONFIRMED'
    ? 'IMPORTED_CONFIRMED'
    : 'EXECUTED';
}

export function workflowImportUnsupportedReason(version: WorkflowVersion): string | null {
  if (
    version.definition.source === 'BUILTIN' &&
    (version.definition.id !== 'official.research' || version.version !== 1)
  )
    return '此官方版本暂不支持导入，仍需按工作流实际执行。';
  if (!isSupportedImportVersion(version)) return '仅个人工作流与官方研究 v1 支持导入。';
  if (importableStepPrefix(version).length === 0)
    return '此版本没有可安全导入并保留后续实际执行步骤的前缀。';
  return null;
}

function currentStepAfterPrefix(
  version: WorkflowVersion,
  completedStepIds: string[],
): WorkflowStepDefinition | null {
  const prefix = importableStepPrefix(version);
  if (completedStepIds.length === 0) {
    return version.steps.find((step) => step.id === version.entryStepId) ?? null;
  }
  const lastCompleted = prefix[completedStepIds.length - 1];
  if (!lastCompleted || completedStepIds.some((id, index) => prefix[index]?.id !== id)) return null;
  return hasLinearAlwaysSuccessor(version, lastCompleted.id);
}

function suggestedPrefix(version: WorkflowVersion, proposal: WorkflowImportProposal): string[] {
  const prefix = importableStepPrefix(version);
  const suggested = new Set(proposal.resolution.suggestedCompletedSteps);
  const result: string[] = [];
  for (const step of prefix) {
    if (!suggested.has(step.id)) break;
    result.push(step.id);
  }
  return result;
}

function bindingSlot(stepId: string, outputKey: string): string {
  return `${stepId}\u0000${outputKey}`;
}

function errorMessage(reason: unknown, fallback: string): string {
  const message =
    reason && typeof reason === 'object' && 'message' in reason
      ? (reason as { message?: unknown }).message
      : undefined;
  return typeof message === 'string' && message.trim() ? message.slice(0, 1_200) : fallback;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '大小未知';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

export function WorkflowImport({
  version,
  open,
  onClose,
  onConfirmed,
}: {
  version: WorkflowVersion | null;
  open: boolean;
  onClose: () => void;
  onConfirmed: (detail: WorkflowDetail) => void | Promise<void>;
}) {
  const [proposal, setProposal] = useState<WorkflowImportProposal | null>(null);
  const [recoverableProposals, setRecoverableProposals] = useState<WorkflowImportProposal[]>([]);
  const [loadingRecoverable, setLoadingRecoverable] = useState(false);
  const [description, setDescription] = useState('');
  const [completedStepIds, setCompletedStepIds] = useState<string[]>([]);
  const [currentStepId, setCurrentStepId] = useState('');
  const [bindingChoices, setBindingChoices] = useState<Record<string, string>>({});
  const [choicesTouched, setChoicesTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const importableSteps = useMemo(() => (version ? importableStepPrefix(version) : []), [version]);

  useEffect(() => {
    if (!open) return;
    setProposal(null);
    setRecoverableProposals([]);
    setLoadingRecoverable(false);
    setDescription('');
    setCompletedStepIds([]);
    setCurrentStepId('');
    setBindingChoices({});
    setChoicesTouched(false);
    setDirty(false);
    setPending(false);
    setError('');
  }, [open, version?.definition.id, version?.version]);

  useEffect(() => {
    if (!open || !version) return;
    const api = workflowImportApiOrNull();
    if (!api) return;
    let active = true;
    setLoadingRecoverable(true);
    void api
      .list()
      .then((proposals) => {
        if (!active) return;
        setRecoverableProposals(
          proposals
            .filter(
              (item) =>
                item.definitionId === version.definition.id &&
                item.version === version.version &&
                (item.status === 'DRAFT' || item.status === 'VALIDATED'),
            )
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        );
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, '读取未完成的导入提案失败，可直接新建提案。'));
      })
      .finally(() => {
        if (active) setLoadingRecoverable(false);
      });
    return () => {
      active = false;
    };
  }, [open, version?.definition.id, version?.version]);

  const applyProposalSuggestions = (next: WorkflowImportProposal, force = false) => {
    setDescription(next.description);
    if (version && (force || !choicesTouched)) {
      const suggested = suggestedPrefix(version, next);
      setCompletedStepIds(suggested);
      setCurrentStepId(currentStepAfterPrefix(version, suggested)?.id ?? '');
      const sources = new Set(next.sources.map((source) => source.id));
      setBindingChoices(
        Object.fromEntries(
          next.resolution.candidateArtifactBindings
            .filter((binding) => sources.has(binding.sourceId))
            .map((binding) => [bindingSlot(binding.stepId, binding.outputKey), binding.sourceId]),
        ),
      );
    }
    setProposal(next);
    setDirty(false);
  };

  const resumeProposal = async (proposalId: string) => {
    if (pending || !version) return;
    setPending(true);
    setError('');
    try {
      const api = workflowImportApiOrNull();
      if (!api) throw new Error('导入服务尚未就绪，请稍后重试。');
      const next = await api.get(proposalId);
      if (
        next.definitionId !== version.definition.id ||
        next.version !== version.version ||
        (next.status !== 'DRAFT' && next.status !== 'VALIDATED')
      )
        throw new Error('此提案已不可恢复，请刷新未完成的导入列表后重试。');
      setChoicesTouched(false);
      applyProposalSuggestions(next, true);
    } catch (reason) {
      setError(errorMessage(reason, '恢复导入提案失败，请刷新列表后重试。'));
    } finally {
      setPending(false);
    }
  };

  const prepare = async (inputs: WorkflowInputs) => {
    if (!version || pending) return;
    setPending(true);
    setError('');
    try {
      const api = workflowImportApiOrNull();
      if (!api) throw new Error('导入服务尚未就绪，请稍后重试。');
      const next = await api.prepare({
        definitionId: version.definition.id,
        version: version.version,
        inputs,
        description: description.trim(),
      });
      setChoicesTouched(false);
      applyProposalSuggestions(next);
    } catch (reason) {
      setError(errorMessage(reason, '无法准备导入提案，请检查输入后重试。'));
    } finally {
      setPending(false);
    }
  };

  const selectSource = async () => {
    if (!proposal || pending || dirty) return;
    setPending(true);
    setError('');
    try {
      const api = workflowImportApiOrNull();
      if (!api) throw new Error('导入服务尚未就绪，请稍后重试。');
      const next = await api.selectSource(proposal.id);
      if (next) applyProposalSuggestions(next);
    } catch (reason) {
      setError(errorMessage(reason, '选择来源文件失败，请重试。'));
    } finally {
      setPending(false);
    }
  };

  const refreshProposal = async () => {
    if (!proposal || pending || dirty) return;
    setPending(true);
    setError('');
    try {
      const api = workflowImportApiOrNull();
      if (!api) throw new Error('导入服务尚未就绪，请稍后重试。');
      const next = await api.get(proposal.id);
      applyProposalSuggestions(next);
    } catch (reason) {
      setError(errorMessage(reason, '刷新导入提案失败，请重试。'));
    } finally {
      setPending(false);
    }
  };

  const revise = async () => {
    if (!proposal || pending || !version) return;
    setPending(true);
    setError('');
    try {
      const api = workflowImportApiOrNull();
      if (!api) throw new Error('导入服务尚未就绪，请稍后重试。');
      const selected = new Set(completedStepIds);
      const bindings = importableSteps
        .filter((step) => selected.has(step.id))
        .flatMap((step) =>
          step.outputs.flatMap((output) => {
            const sourceId = bindingChoices[bindingSlot(step.id, output.key)];
            return sourceId ? [{ stepId: step.id, outputKey: output.key, sourceId }] : [];
          }),
        );
      const next = await api.revise({
        proposalId: proposal.id,
        revision: proposal.revision,
        completedStepIds,
        currentStepId,
        bindings,
      });
      setProposal(next);
      setDirty(false);
    } catch (reason) {
      setError(errorMessage(reason, '无法验证导入映射，请检查映射后重试。'));
    } finally {
      setPending(false);
    }
  };

  const confirm = async () => {
    if (
      !proposal ||
      pending ||
      dirty ||
      proposal.status !== 'VALIDATED' ||
      proposal.validationStatus !== 'VALID'
    )
      return;
    setPending(true);
    setError('');
    try {
      const api = workflowImportApiOrNull();
      if (!api) throw new Error('导入服务尚未就绪，请稍后重试。');
      const detail = await api.confirm({ proposalId: proposal.id, revision: proposal.revision });
      await onConfirmed(detail);
      setProposal(null);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason, '无法完成导入确认，请刷新提案核对状态后重试。'));
    } finally {
      setPending(false);
    }
  };

  const cancel = async () => {
    if (pending) return;
    if (!proposal) {
      onClose();
      return;
    }
    setPending(true);
    setError('');
    try {
      const api = workflowImportApiOrNull();
      if (!api) throw new Error('导入服务尚未就绪，请稍后重试。');
      await api.cancel({ proposalId: proposal.id, revision: proposal.revision });
      setProposal(null);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason, '取消导入提案失败，请刷新后重试。'));
    } finally {
      setPending(false);
    }
  };

  const updateCompletedPrefix = (stepIndex: number, checked: boolean) => {
    const next = importableSteps
      .slice(0, checked ? stepIndex + 1 : stepIndex)
      .map((step) => step.id);
    setCompletedStepIds(next);
    setCurrentStepId(version ? (currentStepAfterPrefix(version, next)?.id ?? '') : '');
    setChoicesTouched(true);
    setDirty(true);
  };

  const sourceIds = new Set(proposal?.sources.map((source) => source.id) ?? []);
  const selectedSteps = new Set(completedStepIds);
  const currentCandidate = version ? currentStepAfterPrefix(version, completedStepIds) : null;

  return (
    <Drawer
      title={
        version ? `导入已有结果 · ${version.definition.name} v${version.version}` : '导入已有结果'
      }
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      className="workflow-import-drawer"
    >
      {version && (
        <div className="workflow-import" data-testid="workflow-import">
          <p className="workflow-import-intro">
            选择文件后，查看系统建议并手动确认步骤和产物映射。导入不会替代后续需要执行的步骤。
          </p>
          {error && (
            <div className="workflow-import-error" role="alert">
              {error}
            </div>
          )}
          {!proposal ? (
            <>
              {(loadingRecoverable || recoverableProposals.length > 0) && (
                <section className="workflow-import-resume-section" aria-label="未完成的导入提案">
                  <div className="workflow-import-heading-row">
                    <h3>继续上次导入</h3>
                    {loadingRecoverable && <span className="workflow-import-muted">正在读取…</span>}
                  </div>
                  {recoverableProposals.length > 0 && (
                    <ul className="workflow-import-resume-list">
                      {recoverableProposals.map((item) => (
                        <li key={item.id}>
                          <div>
                            <strong>
                              {item.description ||
                                (item.sources.length
                                  ? item.sources.map((source) => source.name).join('、')
                                  : '未命名导入提案')}
                            </strong>
                            <small>
                              {item.sources.length
                                ? item.sources.map((source) => source.name).join('、')
                                : '尚未选择来源文件'}
                              {' · '}
                              更新于 {formatUpdatedAt(item.updatedAt)}
                            </small>
                          </div>
                          <StatusBadge
                            tone={
                              item.status === 'VALIDATED' && item.validationStatus === 'VALID'
                                ? 'success'
                                : 'warning'
                            }
                          >
                            {item.status === 'VALIDATED' && item.validationStatus === 'VALID'
                              ? '待确认'
                              : '待修订'}
                          </StatusBadge>
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={pending}
                            data-testid="workflow-import-resume"
                            data-proposal-id={item.id}
                            onClick={() => void resumeProposal(item.id)}
                          >
                            继续上次导入
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
              <section className="workflow-import-form-section">
                <p className="workflow-import-policy">
                  可导入步骤：
                  {importableSteps.length
                    ? importableSteps.map((step) => step.title).join('、')
                    : '此版本没有可安全导入并保留后续执行的步骤'}
                </p>
                <WorkflowInputForm
                  schema={version.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA}
                  presentation={workflowInputPresentationFor(version.definition.id)}
                  busy={pending || importableSteps.length === 0}
                  submitLabel="准备导入提案"
                  onSubmit={prepare}
                  additionalInputs={
                    <>
                      <label className="workflow-import-description">
                        <span>导入说明（可选）</span>
                        <textarea
                          value={description}
                          maxLength={2_000}
                          rows={3}
                          disabled={pending}
                          onChange={(event) => setDescription(event.target.value)}
                        />
                      </label>
                      <button
                        className="button ghost"
                        type="button"
                        disabled={pending}
                        onClick={() => void cancel()}
                      >
                        取消
                      </button>
                    </>
                  }
                />
              </section>
            </>
          ) : (
            <>
              <section className="workflow-import-proposal" aria-label="导入提案摘要">
                <div className="workflow-import-heading-row">
                  <h3>导入提案</h3>
                  <StatusBadge
                    tone={
                      proposal.status === 'VALIDATED' && proposal.validationStatus === 'VALID'
                        ? 'success'
                        : 'warning'
                    }
                  >
                    {proposal.status === 'VALIDATED' && proposal.validationStatus === 'VALID'
                      ? '验证通过'
                      : proposal.validationStatus === 'INVALID'
                        ? '需要修订'
                        : '待提交验证'}
                  </StatusBadge>
                </div>
                <p>{proposal.resolution.explanationSummary || '已生成建议，请检查后提交验证。'}</p>
                <details className="workflow-technical-details">
                  <summary>高级 · 提案信息</summary>
                  <dl>
                    <div>
                      <dt>提案编号</dt>
                      <dd>
                        <code>{proposal.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>策略版本 / 修订</dt>
                      <dd>
                        {proposal.policyVersion} · {proposal.revision}
                      </dd>
                    </div>
                    <div>
                      <dt>冻结工作流 Hash</dt>
                      <dd>
                        <code>{proposal.versionHash}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>来源元数据 Hash</dt>
                      <dd>
                        <code>{proposal.sourceMetadataHash}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>匹配置信度</dt>
                      <dd>
                        {Number.isFinite(proposal.resolution.confidence)
                          ? `${Math.round(proposal.resolution.confidence * 100)}%`
                          : '未提供'}
                      </dd>
                    </div>
                  </dl>
                  {proposal.description && (
                    <p className="workflow-import-saved-description">{proposal.description}</p>
                  )}
                  <details className="workflow-input-snapshot">
                    <summary>已保存工作流输入</summary>
                    {Object.keys(proposal.inputSnapshot).length ? (
                      <pre>{JSON.stringify(proposal.inputSnapshot, null, 2)}</pre>
                    ) : (
                      <p>此提案没有工作流输入字段。</p>
                    )}
                  </details>
                </details>
              </section>

              <section className="workflow-import-sources" aria-label="已选择来源">
                <div className="workflow-import-heading-row">
                  <h3>来源文件 · {proposal.sources.length}</h3>
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={pending || dirty}
                    data-testid="workflow-import-select-source"
                    onClick={() => void selectSource()}
                  >
                    从文件对话框选择
                  </button>
                </div>
                {proposal.sources.length ? (
                  <ul className="workflow-import-source-list">
                    {proposal.sources.map((source) => (
                      <li key={source.id}>
                        <strong>{source.name}</strong>
                        <details className="workflow-technical-details">
                          <summary>高级 · 来源信息</summary>
                          <dl>
                            <div>
                              <dt>类型 / 大小</dt>
                              <dd>
                                {source.kind} · {formatBytes(source.size)}
                              </dd>
                            </div>
                            <div>
                              <dt>内容 Hash</dt>
                              <dd>
                                <code>{source.contentHash}</code>
                              </dd>
                            </div>
                          </dl>
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="workflow-import-muted">尚未选择来源文件。</p>
                )}
              </section>

              <section className="workflow-import-resolution" aria-label="步骤与产物映射">
                <div className="workflow-import-heading-row">
                  <h3>完成步骤</h3>
                  <span className="workflow-import-muted">仅连续的安全步骤可标记为已导入</span>
                </div>
                {importableSteps.length ? (
                  <fieldset className="workflow-import-step-list">
                    <legend>导入为已完成</legend>
                    {importableSteps.map((step, index) => (
                      <label key={step.id}>
                        <input
                          type="checkbox"
                          checked={selectedSteps.has(step.id)}
                          disabled={pending}
                          onChange={(event) => updateCompletedPrefix(index, event.target.checked)}
                        />
                        <span>
                          <strong>{step.title}</strong>
                          <small>{step.objective}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <p className="workflow-import-error" role="status">
                    此版本没有可导入的安全步骤，所有步骤需按原工作流实际执行。
                  </p>
                )}

                <label className="workflow-import-current-step">
                  <span>导入后当前步骤</span>
                  <select
                    value={currentStepId}
                    disabled={pending}
                    onChange={(event) => {
                      setCurrentStepId(event.target.value);
                      setChoicesTouched(true);
                      setDirty(true);
                    }}
                  >
                    <option value="">采用建议的继续步骤</option>
                    {currentCandidate && (
                      <option key={currentCandidate.id} value={currentCandidate.id}>
                        {currentCandidate.title}
                      </option>
                    )}
                  </select>
                </label>

                <div className="workflow-import-bindings">
                  <h4>产物映射</h4>
                  {importableSteps
                    .filter((step) => selectedSteps.has(step.id))
                    .flatMap((step) => step.outputs.map((output) => ({ step, output })))
                    .map(({ step, output }) => {
                      const key = bindingSlot(step.id, output.key);
                      const suggested = proposal.resolution.candidateArtifactBindings.find(
                        (binding) => binding.stepId === step.id && binding.outputKey === output.key,
                      );
                      return (
                        <label className="workflow-import-binding" key={key}>
                          <span>
                            {step.title} · {output.description || output.key}{' '}
                          </span>
                          <select
                            value={bindingChoices[key] ?? ''}
                            disabled={pending || proposal.sources.length === 0}
                            onChange={(event) => {
                              setBindingChoices((current) => ({
                                ...current,
                                [key]: event.target.value,
                              }));
                              setChoicesTouched(true);
                              setDirty(true);
                            }}
                          >
                            <option value="">选择来源 Artifact</option>
                            {proposal.sources.map((source) => (
                              <option key={source.id} value={source.id}>
                                {source.name}
                              </option>
                            ))}
                          </select>
                          {suggested && sourceIds.has(suggested.sourceId) && (
                            <small>
                              系统建议：
                              {
                                proposal.sources.find((source) => source.id === suggested.sourceId)
                                  ?.name
                              }
                            </small>
                          )}
                        </label>
                      );
                    })}
                  {proposal.resolution.candidateArtifactBindings.some(
                    (binding) => !sourceIds.has(binding.sourceId),
                  ) && (
                    <p className="workflow-import-muted">
                      部分建议引用的来源不可用，请手动选择当前来源。
                    </p>
                  )}
                  {proposal.resolution.missingRequirements.length > 0 && (
                    <ul className="workflow-import-requirements">
                      {proposal.resolution.missingRequirements.map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              {(proposal.validationErrors.length > 0 || dirty) && (
                <section className="workflow-import-validation" aria-label="验证结果">
                  {proposal.validationErrors.length > 0 && (
                    <ul className="workflow-import-error-list" role="alert">
                      {proposal.validationErrors.map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  )}
                  {dirty && <p role="status">映射已修改，请重新验证后确认。</p>}
                </section>
              )}

              <div className="workflow-import-actions">
                <button
                  className="button ghost"
                  type="button"
                  disabled={pending}
                  onClick={() => void cancel()}
                >
                  取消导入
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={pending || dirty}
                  onClick={() => void refreshProposal()}
                >
                  刷新提案
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={pending}
                  onClick={() => void revise()}
                >
                  {pending ? '正在验证…' : '提交映射并验证'}
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={
                    pending ||
                    dirty ||
                    proposal.status !== 'VALIDATED' ||
                    proposal.validationStatus !== 'VALID' ||
                    proposal.sources.length === 0 ||
                    completedStepIds.length === 0
                  }
                  data-testid="workflow-import-confirm"
                  onClick={() => void confirm()}
                >
                  {pending ? '处理中…' : '明确确认并创建运行'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
