import { useState } from 'react';
import type { CapabilityDimension, RoutingDecisionReceipt } from '@cultivation/domain';
import type { PartyView, TeammateView } from './ui-shared.js';

export type RoutingUiApi = typeof window.cultivation.routing;
export type RoutingConfigView = Awaited<ReturnType<RoutingUiApi['config']>>;
export type CreateMissionRoutingResult = Awaited<ReturnType<RoutingUiApi['createMission']>>;
export type RoutingUserAction = Extract<
  CreateMissionRoutingResult,
  { status: 'USER_ACTION_REQUIRED' }
>['actions'][number];

const CAPABILITY_OPTIONS: Array<[CapabilityDimension, string]> = [
  ['GENERAL_REASONING', '通用推理'],
  ['LONG_CONTEXT_REASONING', '长上下文推理'],
  ['AGENTIC_EXECUTION', 'Agent 执行'],
  ['CODING', '代码'],
  ['TOOL_USE', '工具使用'],
  ['VISUAL_UNDERSTANDING', '视觉理解'],
  ['IMAGE_GENERATION', '图像生成'],
  ['IMAGE_EDITING', '图像编辑'],
  ['VIDEO_GENERATION', '视频生成'],
  ['VIDEO_EDITING', '视频编辑'],
  ['SPEECH_UNDERSTANDING', '语音理解'],
  ['SPEECH_GENERATION', '语音生成'],
  ['SPEECH_TO_SPEECH', '语音转换'],
  ['MUSIC_GENERATION', '音乐生成'],
];

const capabilityNames = new Map(CAPABILITY_OPTIONS);

export function capabilityLabel(value: CapabilityDimension): string {
  return capabilityNames.get(value) ?? value.replaceAll('_', ' ').toLowerCase();
}

export function clipRoutingText(value: string, limit = 220): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

const REASON_LABELS: Record<string, string> = {
  TASK_CAPABILITY_UNAVAILABLE: '暂时无法判断任务所需的能力，请明确选择后重试。',
  TASK_DEMAND_LOW_CONFIDENCE: '系统无法可靠判断任务需要的能力，请选择能力需求后重试。',
  TASK_DEMAND_REQUIRES_CONFIRMATION: '请确认此任务必需的能力后继续。',
  SOLO_REQUIRES_MODEL_EXECUTOR: '单人历练需要一位可用模型道友；系统不会改由本尊执行。',
  HUMAN_BRIDGE_CAPABILITY_REQUIRED: '本尊执行需要至少选择一项必需能力。',
  NO_CAPABLE_EXECUTOR: '当前没有可执行这项任务的道友。',
  EXPLICIT_TEAMMATE_UNAVAILABLE: '你指定的道友当前不可用；系统没有改派给其他人。',
  EXPLICIT_PARTY_UNAVAILABLE: '你指定的队伍当前不可用；系统没有改派到其他队伍。',
  PARTY_REQUIRES_TWO_EXECUTORS: '满足队伍执行约束的当前可用模型道友不足两位。',
  WORKSPACE_REQUIRED: '本尊交付需要先配置可用工作区。',
};

export function routingReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? clipRoutingText(reason.replaceAll('_', ' '), 180);
}

export function routingActionLabel(action: RoutingUserAction): string {
  const labels: Record<RoutingUserAction, string> = {
    CONFIGURE_CAPABILITY: '选择必需能力',
    RECHECK: '重新检测',
    SELECT_OTHER: '选择其他执行者',
    CANCEL: '取消',
  };
  return labels[action];
}

function assignmentLabel(
  receipt: RoutingDecisionReceipt,
  teammates: TeammateView[],
  parties: PartyView[],
): string {
  const assignment = receipt.assignment;
  if (!assignment) return routingReasonLabel(receipt.reason);
  const teammateName = (id: string) =>
    teammates.find((teammate) => teammate.id === id)?.name ?? '道友';
  const partyName = parties.find((party) => party.id === assignment.partyId)?.name;
  if (assignment.kind === 'PARTY') {
    const members = assignment.memberTeammateIds.map(teammateName).join('、');
    const mode =
      assignment.mode === 'CONSULTATION' ? '咨询' : assignment.mode === 'REVIEW' ? '审查' : '委托';
    return `${partyName ?? '协作队伍'} · ${mode}${members ? ` · ${members}` : ''}`;
  }
  if (assignment.kind === 'HUMAN_BRIDGE') return '本尊 · Human Bridge';
  return teammateName(assignment.coordinatorTeammateId);
}

function candidateReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    ELIGIBLE: '符合条件',
    CAPABILITY_UNSUPPORTED: '缺少所需能力',
    TEAMMATE_INACTIVE: '道友未启用',
    PROVIDER_DISABLED: '服务商已停用',
    MODEL_UNAVAILABLE: '模型当前不可用',
    FALLBACK_ONLY: '仅作兜底',
    MANUAL_ONLY: '需手动指定',
    EXPLICIT_SELECTION: '用户指定',
  };
  return labels[reason] ?? clipRoutingText(reason.replaceAll('_', ' ').toLowerCase(), 80);
}

function availabilityLabel(status: string | null): string {
  if (!status) return '未探测';
  const labels: Record<string, string> = {
    AVAILABLE: '可用',
    UNSTABLE: '不稳定',
    UNAVAILABLE: '不可用',
    UNKNOWN: '未知',
  };
  return labels[status] ?? status;
}

function signalTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    TASK_CAPABILITY: '任务能力判断',
    COLLABORATION_NEED: '协作判断',
    TEAMMATE_FIT: '道友匹配',
    SEMANTIC_FIT: '道友匹配',
  };
  return labels[type] ?? clipRoutingText(type.replaceAll('_', ' '), 60);
}

function signalStatusLabel(status: 'ACCEPTED' | 'IGNORED' | 'UNAVAILABLE'): string {
  const labels = { ACCEPTED: '已采用', IGNORED: '未采用', UNAVAILABLE: '不可用' };
  return labels[status];
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export function RoutingReceiptPanel({
  receipt,
  teammates,
  parties,
  priorityTeammateIds = [],
}: {
  receipt: RoutingDecisionReceipt;
  teammates: TeammateView[];
  parties: PartyView[];
  priorityTeammateIds?: string[];
}) {
  const demands = receipt.demand.slice(0, 8);
  const signals = receipt.decisionSignals.slice(0, 6);
  const assignedTeammateIds =
    receipt.assignment?.kind === 'PARTY'
      ? receipt.assignment.memberTeammateIds
      : receipt.assignment?.kind === 'SOLO'
        ? [receipt.assignment.coordinatorTeammateId]
        : [];
  const priorityIds = new Set([...assignedTeammateIds, ...priorityTeammateIds]);
  const orderedCandidates = receipt.candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        Number(priorityIds.has(right.candidate.teammateId)) -
          Number(priorityIds.has(left.candidate.teammateId)) || left.index - right.index,
    );
  const candidates = orderedCandidates.slice(0, 128).map(({ candidate }) => candidate);
  const candidatesTruncated = orderedCandidates.length > candidates.length;

  return (
    <section className="mission-section routing-receipt" aria-label="智能分配记录">
      <div className="section-heading">
        <div>
          <h2>智能分配记录</h2>
          <p>{receipt.outcome === 'ASSIGNED' ? '已完成执行者分配' : '需要你处理后继续'}</p>
        </div>
        <span className="count-badge">R4</span>
      </div>
      {receipt.taskSummary && (
        <p className="routing-receipt-summary">任务摘要：{clipRoutingText(receipt.taskSummary)}</p>
      )}
      {receipt.outcome === 'ASSIGNED' && (
        <p className="routing-receipt-assignment">
          <strong>分配结果</strong> · {assignmentLabel(receipt, teammates, parties)}
        </p>
      )}
      {demands.length > 0 && (
        <div className="routing-receipt-demands">
          <strong>能力需求</strong>
          <div className="routing-chip-row">
            {demands.map((demand) => (
              <span
                className={demand.required ? 'routing-chip required' : 'routing-chip'}
                key={demand.dimension}
              >
                {capabilityLabel(demand.dimension)} · {demand.required ? '必需' : '参考'} ·{' '}
                {Math.round(demand.weight * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}
      {signals.length > 0 && (
        <div className="routing-receipt-signals">
          <strong>决策信号</strong>
          {signals.map((signal, index) => (
            <p key={`${signal.type}-${index}`}>
              {signalTypeLabel(signal.type)} · {signalStatusLabel(signal.status)}
              {signal.recommendation ? ` · ${clipRoutingText(signal.recommendation, 120)}` : ''}
              {signal.confidence !== null ? ` · 置信度 ${percent(signal.confidence)}` : ''}
            </p>
          ))}
        </div>
      )}
      {candidates.length > 0 && (
        <details className="routing-candidate-details">
          <summary>
            候选比较（{receipt.candidates.length}）
            {candidatesTruncated ? ' · 已优先显示所选项，其余显示前 128 位' : ''}
          </summary>
          <div className="routing-candidate-list">
            {candidates.map((candidate) => {
              const name = teammates.find((teammate) => teammate.id === candidate.teammateId)?.name;
              return (
                <article className="routing-candidate-row" key={candidate.teammateId}>
                  <strong>{name ?? `道友 ${candidate.teammateId.slice(0, 8)}`}</strong>
                  <span>
                    {candidate.eligible ? '符合条件' : candidateReasonLabel(candidate.reason)}
                  </span>
                  <small>
                    基准{' '}
                    {candidate.benchmarkScore === null
                      ? '无'
                      : `${Math.round(candidate.benchmarkScore)}/100`}
                    {' · '}可用性 {availabilityLabel(candidate.availability)}
                    {' · '}排名{' '}
                    {candidate.rankingScore === null ? '—' : candidate.rankingScore.toFixed(2)}
                  </small>
                </article>
              );
            })}
          </div>
        </details>
      )}
    </section>
  );
}

export function RoutingActions({
  actions,
  onRecheck,
  onSelectOther,
  onCancel,
  onConfigureCapability,
  disabled = false,
}: {
  actions: RoutingUserAction[];
  onRecheck: () => void;
  onSelectOther: () => void;
  onCancel: () => void;
  onConfigureCapability: () => void;
  disabled?: boolean;
}) {
  const handlers: Record<RoutingUserAction, () => void> = {
    CONFIGURE_CAPABILITY: onConfigureCapability,
    RECHECK: onRecheck,
    SELECT_OTHER: onSelectOther,
    CANCEL: onCancel,
  };
  return (
    <div className="button-row compact routing-action-row">
      {actions.map((action) => (
        <button
          className={action === 'CANCEL' ? 'button ghost small' : 'button secondary small'}
          type="button"
          key={action}
          disabled={disabled}
          onClick={handlers[action]}
        >
          {routingActionLabel(action)}
        </button>
      ))}
    </div>
  );
}

export function RoutingConfigPanel({
  config,
  onChange,
  onOpenJevSettings,
}: {
  config: RoutingConfigView;
  onChange: (enabled: boolean) => Promise<void>;
  onOpenJevSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const change = async (enabled: boolean) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await onChange(enabled);
      setNotice(enabled ? 'Cloud 智能分配已启用。' : 'Cloud 智能分配已关闭。');
    } catch {
      setError(
        enabled
          ? '无法启用 Cloud 智能分配。请先在 Jev 观察中配置 TypeSafe Key，并检查连接状态。'
          : '无法确认 Cloud 已关闭，请刷新设置后重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-card routing-config-card">
      <h2>智能分配</h2>
      <p className="muted-copy">
        默认关闭。启用后，Jev 云端只接收有界的任务摘要、候选道友身份、Benchmark
        能力档位、已启用功法元数据和可核验经历摘要。
      </p>
      <p className="muted-copy">
        不发送 API Key 或其他凭据、私有记忆原文、完整文件、完整聊天记录、工具输出或 Tool secret。
        Jev 不会获得审批权限，也不会覆盖用户明确指定的道友或队伍。
      </p>
      <p className="form-hint">
        策略版本：{config.policyVersion} · Cloud 当前{config.cloudEnabled ? '已启用' : '已关闭'}
      </p>
      <label className="field routing-cloud-toggle">
        <input
          type="checkbox"
          checked={config.cloudEnabled}
          disabled={busy}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>启用 Cloud 智能分配</span>
      </label>
      <button className="button ghost small" type="button" onClick={onOpenJevSettings}>
        配置 Jev 凭据
      </button>
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
    </div>
  );
}

export function CapabilityPicker({
  selected,
  onChange,
}: {
  selected: CapabilityDimension[];
  onChange: (selected: CapabilityDimension[]) => void;
}) {
  const toggle = (dimension: CapabilityDimension, checked: boolean) => {
    onChange(
      checked
        ? [...new Set([...selected, dimension])]
        : selected.filter((item) => item !== dimension),
    );
  };

  return (
    <div className="routing-capability-grid">
      {CAPABILITY_OPTIONS.map(([dimension, label]) => (
        <label className="routing-capability-option" key={dimension}>
          <input
            type="checkbox"
            checked={selected.includes(dimension)}
            onChange={(event) => toggle(dimension, event.target.checked)}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}
