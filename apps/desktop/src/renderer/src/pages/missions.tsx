import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import { Avatar } from '../components/Avatar.js';
import { Drawer } from '../components/Drawer.js';
import { EmptyState } from '../components/EmptyState.js';
import { G3Collaboration } from '../components/G3Collaboration.js';
import { Section } from '../components/Section.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { handleHorizontalTabKeyDown, horizontalTabIndex } from '../horizontal-tabs.js';
import './mission-party.css';
import './product-pages.css';
import { HumanBridgeApproval } from '.././r2-human-bridge.js';
import type {
  CapabilityDimension,
  RoutingDecisionReceipt,
  RoutingTaskContext,
} from '@cultivation/domain';
import {
  CapabilityPicker,
  RoutingActions,
  RoutingReceiptPanel,
  routingReasonLabel,
} from '../r4-routing.js';
import {
  errorText,
  PageHeading,
  missionStateLabel,
  artifactKindLabel,
  stateClass,
  runAttemptLabel,
  safeLabel,
  renderToolTimelineMetadata,
  formatToken,
  formatDate,
} from '../ui-shared.js';
import type {
  TeammateView,
  MissionMode,
  PartyView,
  MissionView,
  ApprovalRequestView,
  MissionDetailView,
  MissionEventView,
} from '../ui-shared.js';
import type { CreateMissionRoutingResult } from '../r4-routing.js';

type AssignmentMode = 'AUTO' | 'SOLO' | 'PARTY' | 'HUMAN_BRIDGE';
const missionFilterTabs = [
  ['running', '运行中'],
  ['history', '历史'],
  ['all', '全部'],
] as const;
const missionFilterValues = missionFilterTabs.map(([filter]) => filter);
type MissionFilter = (typeof missionFilterTabs)[number][0];
type RoutingRequiredResult = Extract<
  CreateMissionRoutingResult,
  { status: 'USER_ACTION_REQUIRED' }
>;

/** Friendly labels for the default view; Advanced retains the original event identifiers. */
function recentEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    'model.call_started': '开始调用模型',
    'model.call_completed': '模型回复已完成',
    'model.call_failed': '模型调用失败',
    'skill.selection': '选用功法',
    'skill.used': '使用功法',
    'collaboration.proposed': '提出协作请求',
    'collaboration.approved': '协作已获批准',
    'collaboration.denied': '协作请求已拒绝',
    'collaboration.started': '道友开始协作',
    'collaboration.completed': '道友完成协作',
    'collaboration.failed': '协作未能完成',
    'tool.call_started': '开始使用法宝',
    'tool.execution_started': '开始使用法宝',
    'tool.result': '收到法宝执行结果',
    'approval.requested': '等待权限审批',
    'approval.resolved': '权限审批已处理',
    'approval.decided': '权限审批已处理',
    'tool.approval_requested': '等待工具操作审批',
    'tool.approval_decided': '工具操作审批已处理',
    'usage.recorded': '用量已记录',
    'run.completed': '本次历练完成',
    'run.failed': '本次历练失败',
    'run.started': '本次历练开始',
    'run.interrupted': '本次执行已中断',
    'external_work.accepted': '本尊交付已验收',
    'external_work.submitted': '本尊已提交交付',
    'external_work.continuation_received': '本尊交付已验收',
    'external_work.rejected': '交付已退回修改',
    'external_work.cancelled': '本尊待办已取消',
    'external_work.failed': '本尊交付处理失败',
    'mission.created': '历练已创建',
    'mission.updated': '历练已更新',
    'mission.ready': '历练已就绪',
    'mission.retry_ready': '历练已准备重新执行',
    'mission.paused': '历练已暂停',
    'mission.resumed': '历练已恢复',
    'mission.cancelled': '历练已取消',
    'mission.run_started': '历练已开始',
    'mission.started': '历练已开始',
    'mission.retry_started': '历练已重新开始',
    'mission.waiting_approval': '等待权限审批',
    'mission.waiting_collaboration': '等待协作处理',
    'mission.waiting_external_work': '等待本尊交付',
    'mission.approval_resumed': '审批已完成，历练继续执行',
    'mission.external_work_resumed': '本尊交付已返回',
    'mission.completed': '历练已完成',
    'mission.failed': '历练执行失败',
    'mission.interrupted': '历练执行已中断',
    'mission.external_work_interrupted': '本尊待办中断',
  };
  if (labels[eventType]) return labels[eventType];
  if (eventType.startsWith('mission.state.')) {
    const state = eventType.slice('mission.state.'.length).toUpperCase();
    const stateLabels: Record<string, string> = {
      DRAFT: '历练已创建',
      READY: '历练已就绪',
      RUNNING: '历练正在运行',
      WAITING_APPROVAL: '等待权限审批',
      WAITING_COLLABORATION: '等待协作处理',
      WAITING_EXTERNAL_WORK: '等待本尊交付',
      PAUSED: '历练已暂停',
      INTERRUPTED: '历练执行已中断',
      COMPLETED: '历练已完成',
      FAILED: '历练执行失败',
      CANCELLED: '历练已取消',
    };
    return stateLabels[state] ?? '历练状态已更新';
  }
  return '执行记录已更新';
}

function missionStateTone(state: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (state === 'COMPLETED') return 'success';
  if (state === 'FAILED' || state === 'CANCELLED') return 'danger';
  if (state.startsWith('WAITING_') || state === 'INTERRUPTED') return 'warning';
  return 'neutral';
}

function permissionLabel(value: string): string {
  const labels: Record<string, string> = {
    MEMORY_READ: '读取记忆',
    MEMORY_WRITE: '修改记忆',
    FILE_READ: '读取文件',
    FILE_WRITE: '写入文件',
    MCP_TOOL_EXECUTE: '运行外部工具',
    INVITE_TEAMMATE: '邀请道友协作',
    CREATE_MISSION: '创建历练',
    SPEND_BUDGET: '使用预算',
    WEB_ACCESS: '访问网页',
    BROWSER_CONTROL: '控制浏览器',
    EXECUTE_COMMAND: '执行命令',
    EXTERNAL_MESSAGE: '发送外部消息',
    INSTALL_TOOL: '安装工具',
  };
  return labels[value] ?? '相关操作';
}

function approvalDecisionLabel(value: unknown): string | null {
  if (value === 'APPROVED') return '已批准';
  if (value === 'DENIED') return '已拒绝';
  if (value === 'ALLOW_MISSION') return '已允许本次历练';
  return null;
}

function riskLabel(value: string): string {
  const labels: Record<string, string> = {
    LOW: '低风险',
    MEDIUM: '中风险',
    HIGH: '高风险',
  };
  return labels[value] ?? '需确认';
}

function missionEventSummary(event: MissionEventView): string[] {
  const payload = event.payloadJson;
  const summaries: string[] = [];
  if (event.eventType === 'skill.selection' && Array.isArray(payload.selectedSkillIds)) {
    summaries.push(`功法：${Math.min(payload.selectedSkillIds.length, 3)} 项`);
  }
  const from = typeof payload.from === 'string' ? payload.from : null;
  const to = typeof payload.to === 'string' ? payload.to : null;
  if (from && to) summaries.push(`状态：${missionStateLabel(from)} → ${missionStateLabel(to)}`);

  const decision = approvalDecisionLabel(payload.decision);
  if (decision) summaries.push(`审批：${decision}`);

  if (event.eventType.startsWith('tool.')) summaries.push('操作：工具调用');
  if (event.eventType.startsWith('tool.') && typeof payload.capability === 'string') {
    summaries.push(`权限：${permissionLabel(payload.capability)}`);
  }
  if (event.eventType === 'tool.result' && typeof payload.success === 'boolean') {
    summaries.push(`执行结果：${payload.success ? '成功' : '未成功'}`);
  }
  if (event.eventType === 'external_work.continuation_received' && payload.outcome === 'ACCEPTED') {
    summaries.push('交付：已验收');
  }
  return summaries;
}

export function MissionPage() {
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [parties, setParties] = useState<PartyView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<MissionDetailView | null>(null);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [coordinatorId, setCoordinatorId] = useState('');
  const [missionMode, setMissionMode] = useState<MissionMode>('SOLO');
  const [partyId, setPartyId] = useState('');
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>('AUTO');
  const [requiredCapabilities, setRequiredCapabilities] = useState<CapabilityDimension[]>([]);
  const [capabilitySelectionRequired, setCapabilitySelectionRequired] = useState(false);
  const [capabilityPickerOpen, setCapabilityPickerOpen] = useState(false);
  const [expectedOutputEnabled, setExpectedOutputEnabled] = useState(false);
  const [expectedOutputName, setExpectedOutputName] = useState('交付成果');
  const [expectedOutputExtension, setExpectedOutputExtension] = useState('.txt');
  const [expectedOutputSizeMb, setExpectedOutputSizeMb] = useState('10');
  const [routingPrompt, setRoutingPrompt] = useState<RoutingRequiredResult | null>(null);
  const [routingReceipts, setRoutingReceipts] = useState<RoutingDecisionReceipt[]>([]);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptError, setReceiptError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [approvalFixture, setApprovalFixture] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [detailLoadAttempt, setDetailLoadAttempt] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [missionFilter, setMissionFilter] = useState<MissionFilter>('running');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const handledCreateQuery = useRef('');
  const assignmentSelectRef = useRef<HTMLSelectElement>(null);
  const availableTeammates = teammates.filter((teammate) => teammate.status === 'ACTIVE');
  const activeTeammates = availableTeammates.filter(
    (teammate) => teammate.executorKind !== 'USER_BRIDGE',
  );
  const humanBridge = availableTeammates.find(
    (teammate) => teammate.executorKind === 'USER_BRIDGE' && teammate.systemKind === 'HUMAN_BRIDGE',
  );
  const activeParties = parties.filter(
    (party) =>
      party.status === 'ACTIVE' &&
      party.members.length >= 2 &&
      party.members.length <= 4 &&
      party.members.every((member) =>
        availableTeammates.some((teammate) => teammate.id === member.teammateId),
      ),
  );
  const isHistoryMission = (item: MissionView) =>
    ['COMPLETED', 'FAILED', 'CANCELLED'].includes(item.state);
  const visibleMissions = missions.filter((item) =>
    missionFilter === 'all'
      ? true
      : missionFilter === 'history'
        ? isHistoryMission(item)
        : !isHistoryMission(item),
  );
  const selectMissionFilter = (filter: MissionFilter) => {
    const next = missions.filter((item) =>
      filter === 'all'
        ? true
        : filter === 'history'
          ? isHistoryMission(item)
          : !isHistoryMission(item),
    );
    setMissionFilter(filter);
    setSelectedId(next[0]?.id ?? '');
    setCreating(false);
    setEditing(false);
  };
  const modeLabel = (mode: MissionMode) => {
    const labels: Record<MissionMode, string> = {
      SOLO: '单人历练',
      CONSULTATION: '咨询协作',
      REVIEW: '审查协作',
      DELEGATION: '委托协作',
    };
    return labels[mode];
  };
  const teammateFor = (teammateId: string) => teammates.find((item) => item.id === teammateId);
  const displayTeammateName = (teammateId: string) =>
    teammateFor(teammateId)?.name ?? '道友资料不可用';
  const renderExecutorStatus = (teammateId: string) => {
    const teammate = teammateFor(teammateId);
    if (!teammate) return <span className="product-status muted">道友资料不可用</span>;
    if (teammate.status !== 'ACTIVE') return <span className="product-status muted">已归档</span>;
    if (teammate.executorKind === 'USER_BRIDGE') {
      return <span className="product-status bridge">本尊 · 可接收委托</span>;
    }
    return (
      <AvailabilityBadge
        teammateId={teammate.id}
        teammateStatus={teammate.status}
        executorKind={teammate.executorKind}
      />
    );
  };
  const renderActor = (actorType: string, actorId: string | null) => {
    const teammate = actorId ? teammateFor(actorId) : undefined;
    if (teammate) {
      return (
        <span className="mission-actor">
          <Avatar
            avatar={teammate.avatar}
            name={teammate.name}
            kind={teammate.executorKind === 'USER_BRIDGE' ? 'HUMAN_BRIDGE' : 'TEAMMATE'}
            size={22}
          />
          <span>{teammate.name}</span>
        </span>
      );
    }
    const name =
      actorType === 'USER'
        ? '用户'
        : actorType === 'SYSTEM'
          ? '系统'
          : actorType === 'TEAMMATE'
            ? '道友'
            : '其他参与者';
    return (
      <span className="mission-actor">
        {actorType === 'USER' && <Avatar name={name} kind="USER" size={22} />}
        <span>{name}</span>
      </span>
    );
  };

  useEffect(() => {
    const query = searchParams.toString();
    const requestedMissionId = searchParams.get('missionId') ?? '';
    const shouldCreate = searchParams.get('create') === '1';
    if (!shouldCreate && !requestedMissionId) {
      handledCreateQuery.current = '';
      return;
    }
    if (loading || handledCreateQuery.current === query) return;
    handledCreateQuery.current = query;
    if (requestedMissionId) {
      setMissionFilter('all');
      setCreating(false);
      setEditing(false);
      setSelectedId(requestedMissionId);
      if (!missions.some((item) => item.id === requestedMissionId)) {
        setError('找不到这次历练。');
      }
      setSearchParams({}, { replace: true });
      return;
    }
    const requestedTeammateId = searchParams.get('teammateId') ?? '';
    const requestedPartyId = searchParams.get('partyId') ?? '';
    setSelectedId('');
    setDetail(null);
    setCreating(true);
    setEditing(false);
    setTitle('');
    setObjective('');
    setAssignmentMode(requestedPartyId ? 'PARTY' : requestedTeammateId ? 'SOLO' : 'AUTO');
    setMissionMode(requestedPartyId ? 'CONSULTATION' : 'SOLO');
    setPartyId(requestedPartyId || activeParties[0]?.id || '');
    setCoordinatorId(requestedTeammateId || activeTeammates[0]?.id || '');
    setRequiredCapabilities([]);
    setCapabilitySelectionRequired(false);
    setCapabilityPickerOpen(false);
    setExpectedOutputEnabled(false);
    setExpectedOutputName('交付成果');
    setExpectedOutputExtension('.txt');
    setExpectedOutputSizeMb('10');
    setRoutingPrompt(null);
    setMissionFilter('all');
    setError('');
    setNotice('');
    setSearchParams({}, { replace: true });
  }, [loading, missions, searchParams, setSearchParams, activeParties, activeTeammates]);

  const refreshMissions = async (preferredId?: string) => {
    const rows = await window.cultivation.missions.list();
    setMissions(rows);
    const nextId = preferredId ?? selectedId;
    if (nextId && rows.some((mission) => mission.id === nextId)) {
      setSelectedId(nextId);
    } else if (rows.length > 0) {
      setSelectedId(rows[0]!.id);
    } else {
      setSelectedId('');
      setDetail(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void Promise.all([
      window.cultivation.missions.list(),
      window.cultivation.teammates.list(),
      window.cultivation.parties.list(),
    ])
      .then(([missionRows, teammateRows, partyRows]) => {
        if (cancelled) return;
        setMissions(missionRows);
        setTeammates(teammateRows);
        setParties(partyRows);
        setCoordinatorId(
          (current) =>
            current || teammateRows.find((teammate) => teammate.status === 'ACTIVE')?.id || '',
        );
        setPartyId(
          (current) => current || partyRows.find((party) => party.status === 'ACTIVE')?.id || '',
        );
        if (missionRows.length > 0) setSelectedId(missionRows[0]!.id);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取历练失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setError('');
    void window.cultivation.missions
      .detail(selectedId)
      .then((result) => {
        if (!cancelled) {
          setDetail(result);
          if (!editing && !creating) {
            setTitle(result.mission.title);
            setObjective(result.mission.objective);
            setMissionMode(result.mission.mode ?? 'SOLO');
            setPartyId(result.mission.partyId ?? '');
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取历练详情失败。'));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailLoadAttempt]);

  useEffect(() => {
    if (!selectedId) {
      setRoutingReceipts([]);
      setReceiptLoading(false);
      setReceiptError('');
      return;
    }
    let cancelled = false;
    setRoutingReceipts([]);
    setReceiptLoading(true);
    setReceiptError('');
    void window.cultivation.routing
      .receipts(selectedId)
      .then((rows) => {
        if (!cancelled) setRoutingReceipts(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setReceiptError(errorText(cause, '读取智能分配记录失败。'));
      })
      .finally(() => {
        if (!cancelled) setReceiptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const mission = detail?.mission ?? missions.find((item) => item.id === selectedId) ?? null;
  const canEdit = !mission || mission.state === 'DRAFT' || mission.state === 'READY';
  const routingAssignmentLocked = routingReceipts.some((receipt) => receipt.outcome === 'ASSIGNED');
  const isPendingApproval = (approval: ApprovalRequestView) =>
    approval.state !== 'APPROVED' && approval.state !== 'DENIED' && !approval.resolvedAt;

  const resetEditor = () => {
    setCreating(false);
    setEditing(false);
    setError('');
    setNotice('');
    if (mission) {
      setTitle(mission.title);
      setObjective(mission.objective);
    } else {
      setTitle('');
      setObjective('');
      setMissionMode('SOLO');
      setAssignmentMode('AUTO');
      setRequiredCapabilities([]);
      setCapabilitySelectionRequired(false);
      setCapabilityPickerOpen(false);
      setExpectedOutputEnabled(false);
    }
    setRoutingPrompt(null);
  };

  const beginCreateMission = () => {
    setSelectedId('');
    setDetail(null);
    setCreating(true);
    setEditing(false);
    setTitle('');
    setObjective('');
    setMissionMode('SOLO');
    setAssignmentMode('AUTO');
    setPartyId(activeParties[0]?.id ?? '');
    setCoordinatorId(activeTeammates[0]?.id ?? '');
    setRequiredCapabilities([]);
    setCapabilitySelectionRequired(false);
    setCapabilityPickerOpen(false);
    setExpectedOutputEnabled(false);
    setExpectedOutputName('交付成果');
    setExpectedOutputExtension('.txt');
    setExpectedOutputSizeMb('10');
    setRoutingPrompt(null);
    setRoutingReceipts([]);
    setMissionFilter('all');
    setError('');
    setNotice('');
  };

  const runAction = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refreshMissions();
      setMissionFilter('all');
      if (selectedId) {
        const refreshed = await window.cultivation.missions.detail(selectedId);
        setDetail(refreshed);
        setTitle(refreshed.mission.title);
        setObjective(refreshed.mission.objective);
      }
      setNotice(label);
      setEditing(false);
      setCreating(false);
    } catch (cause) {
      setError(errorText(cause, `${label}失败。`));
    } finally {
      setBusy(false);
    }
  };

  const createRoutingMission = async () => {
    if (assignmentMode === 'HUMAN_BRIDGE' && requiredCapabilities.length === 0) {
      setCapabilityPickerOpen(true);
      setError('本尊执行需要至少选择一项本次历练实际涉及的必需能力。');
      return;
    }
    if (
      capabilitySelectionRequired &&
      assignmentMode === 'AUTO' &&
      requiredCapabilities.length === 0
    ) {
      setCapabilityPickerOpen(true);
      return;
    }
    if (assignmentMode === 'SOLO' && !coordinatorId) {
      setError('请选择要指定的道友。');
      return;
    }
    if (assignmentMode === 'PARTY' && !partyId) {
      setError('请选择要指定的队伍。');
      return;
    }
    const outputSizeMb = Number(expectedOutputSizeMb);
    if (
      expectedOutputEnabled &&
      (!expectedOutputName.trim() || !Number.isFinite(outputSizeMb) || outputSizeMb < 1)
    ) {
      setError('请填写有效的文件名称和至少 1 MB 的大小上限。');
      return;
    }

    const context: RoutingTaskContext = {
      objective: objective.trim(),
      executionConstraint: assignmentMode,
      ...(requiredCapabilities.length > 0 ? { requiredCapabilities } : {}),
      ...(assignmentMode === 'SOLO' ? { explicitTeammateId: coordinatorId } : {}),
      ...(assignmentMode === 'PARTY'
        ? {
            explicitPartyId: partyId,
            partyMode: missionMode === 'SOLO' ? 'CONSULTATION' : missionMode,
          }
        : {}),
      ...(expectedOutputEnabled
        ? {
            expectedOutputContract: {
              name: expectedOutputName.trim(),
              allowedExtensions: [expectedOutputExtension],
              maxSizeBytes: Math.round(outputSizeMb * 1024 * 1024),
            },
          }
        : {}),
    };

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.cultivation.routing.createMission({
        title: title.trim(),
        context,
      });
      if (result.status === 'USER_ACTION_REQUIRED') {
        setRoutingPrompt(result);
        if (
          result.actions.includes('CONFIGURE_CAPABILITY') ||
          ['TASK_DEMAND_LOW_CONFIDENCE', 'TASK_DEMAND_REQUIRES_CONFIRMATION'].includes(
            result.reason,
          )
        ) {
          setCapabilitySelectionRequired(true);
          setCapabilityPickerOpen(true);
        }
        return;
      }
      setRoutingPrompt(null);
      setCapabilitySelectionRequired(false);
      setRoutingReceipts([result.receipt]);
      await refreshMissions(result.mission.id);
      setDetail(await window.cultivation.missions.detail(result.mission.id));
      setCreating(false);
      setEditing(false);
      setMissionFilter('all');
      setNotice('已完成执行者分配，历练草稿已创建。');
    } catch (cause) {
      setError(errorText(cause, '智能分配或创建历练失败。'));
    } finally {
      setBusy(false);
    }
  };

  const recheckAndRetryRouting = async () => {
    if (!routingPrompt) return;
    if (assignmentMode === 'HUMAN_BRIDGE') {
      setError('本尊执行不会检测普通模型。请调整本尊已启用的能力或取消。');
      return;
    }

    const activeModelTeammate = (teammateId: string) => {
      const teammate = teammates.find((item) => item.id === teammateId);
      return teammate?.status === 'ACTIVE' && teammate.executorKind === 'MODEL_RUNTIME'
        ? teammate
        : undefined;
    };
    let teammateIds: string[] = [];
    if (assignmentMode === 'SOLO') {
      if (activeModelTeammate(coordinatorId)) teammateIds = [coordinatorId];
    } else if (assignmentMode === 'PARTY') {
      const selectedParty = parties.find((item) => item.id === partyId);
      if (selectedParty?.status === 'ACTIVE') {
        teammateIds = selectedParty.members
          .slice()
          .sort((left, right) => left.order - right.order)
          .map((member) => member.teammateId)
          .filter((teammateId) => Boolean(activeModelTeammate(teammateId)));
      }
    } else {
      const failedCandidate = routingPrompt.receipt.candidates
        .filter(
          (candidate) =>
            (candidate.availability === 'UNAVAILABLE' ||
              candidate.reason === 'MODEL_UNAVAILABLE') &&
            candidate.benchmarkScore !== null &&
            candidate.runtimeProfileId !== null &&
            activeModelTeammate(candidate.teammateId)?.currentRuntimeProfileId ===
              candidate.runtimeProfileId,
        )
        .slice()
        .sort(
          (left, right) =>
            (right.benchmarkScore ?? -1) - (left.benchmarkScore ?? -1) ||
            left.teammateId.localeCompare(right.teammateId),
        )[0];
      if (failedCandidate) teammateIds = [failedCandidate.teammateId];
    }

    const uniqueTeammateIds = [...new Set(teammateIds)];
    if (uniqueTeammateIds.length === 0) {
      setError(
        assignmentMode === 'AUTO'
          ? '当前记录中没有可重新检测的已绑定模型候选。请明确选择能力需求或选择其他执行者。'
          : '所选执行者中没有当前可重新检测的模型道友。请检查选择后重试。',
      );
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      for (const teammateId of uniqueTeammateIds) {
        await window.cultivation.availability.recheck(teammateId);
      }
    } catch (cause) {
      setError(errorText(cause, '重新检测执行者失败。请检查连接后重试。'));
      return;
    } finally {
      setBusy(false);
    }

    await createRoutingMission();
  };

  const chooseWorkspaceAndRetry = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    let selectedWorkspace = false;
    try {
      const result = await window.cultivation.tools.chooseWorkspace();
      selectedWorkspace = Boolean(result.rootPath);
      if (!selectedWorkspace) setNotice('未选择工作区。');
    } catch (cause) {
      setError(errorText(cause, '选择工作区失败。'));
    } finally {
      setBusy(false);
    }
    if (selectedWorkspace) await createRoutingMission();
  };

  const saveMission = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) {
      await createRoutingMission();
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mission) {
        const updated = await window.cultivation.missions.update({
          id: mission.id,
          title: title.trim(),
          objective: objective.trim(),
        });
        await refreshMissions(updated.id);
        setDetail(await window.cultivation.missions.detail(updated.id));
        setEditing(false);
        setNotice('历练已保存。');
      }
    } catch (cause) {
      setError(errorText(cause, '保存历练失败。'));
    } finally {
      setBusy(false);
    }
  };

  const pendingApprovals = detail?.approvals.filter(isPendingApproval) ?? [];
  const pendingCollaborations =
    detail?.collaborations.filter((request) => request.state === 'PENDING') ?? [];
  const sortedTimeline = [
    ...(detail?.events ?? []).map((event) => ({
      id: `event-${event.id}`,
      kind: 'MISSION_EVENT' as const,
      time: event.createdAt,
      event,
    })),
    ...(detail?.audits ?? []).map((audit) => ({
      id: `audit-${audit.id}`,
      kind: 'AUDIT_EVENT' as const,
      time: audit.createdAt,
      audit,
    })),
  ].sort((left, right) => right.time.localeCompare(left.time));
  const missionTimeline = sortedTimeline.filter((item) => item.kind === 'MISSION_EVENT');
  const auditTimeline = sortedTimeline.filter((item) => item.kind === 'AUDIT_EVENT');
  const latestResultRun =
    detail?.runs
      .slice()
      .sort((left, right) => right.attempt - left.attempt)
      .find((run) => Boolean(run.resultText?.trim())) ?? null;

  return (
    <section className="page wide-page mission-page object-page">
      <PageHeading
        eyebrow="任务中心"
        title="历练"
        description="查看进行中的任务、待处理事项与过往结果。"
      />
      <nav className="workflow-hub-switch" aria-label="历练类型">
        <Link to="/missions" aria-current="page" className="active">
          自由历练
        </Link>
        <Link to="/workflows">工作流历练</Link>
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
      <div className="mission-workspace object-list-detail-layout">
        <Section
          title="历练"
          className="mission-list-card object-list-pane"
          action={
            <button
              className="button primary small"
              type="button"
              disabled={busy}
              onClick={beginCreateMission}
            >
              发起历练
            </button>
          }
        >
          <p className="object-list-summary">{visibleMissions.length} 项</p>
          <div className="mission-filter-tabs" role="tablist" aria-label="筛选历练">
            {missionFilterTabs.map(([filter, label]) => {
              const count =
                filter === 'all'
                  ? missions.length
                  : filter === 'history'
                    ? missions.filter(isHistoryMission).length
                    : missions.filter((item) => !isHistoryMission(item)).length;
              return (
                <button
                  key={filter}
                  className={`mission-filter-tab ${missionFilter === filter ? 'active' : ''}`}
                  type="button"
                  role="tab"
                  aria-selected={missionFilter === filter}
                  tabIndex={horizontalTabIndex(missionFilter, filter)}
                  onKeyDown={(event) =>
                    handleHorizontalTabKeyDown(
                      event,
                      missionFilterValues,
                      filter,
                      selectMissionFilter,
                    )
                  }
                  onClick={() => selectMissionFilter(filter)}
                >
                  {label}
                  <span>{count}</span>
                </button>
              );
            })}
          </div>
          {loading ? (
            <div className="loading-card">正在读取历练…</div>
          ) : visibleMissions.length ? (
            <div className="mission-list">
              {visibleMissions.map((item) => (
                <button
                  key={item.id}
                  className={
                    item.id === selectedId ? 'mission-list-item selected' : 'mission-list-item'
                  }
                  onClick={() => {
                    setCreating(false);
                    setEditing(false);
                    setSelectedId(item.id);
                    setError('');
                    setNotice('');
                  }}
                >
                  <span className="mission-list-item-top">
                    <strong>{item.title}</strong>
                    <StatusBadge tone={missionStateTone(item.state)}>
                      {missionStateLabel(item.state)}
                    </StatusBadge>
                  </span>
                  <small>
                    {displayTeammateName(item.coordinatorTeammateId)} ·{' '}
                    {modeLabel(item.mode ?? 'SOLO')}
                    {item.partyId &&
                      ` · ${parties.find((party) => party.id === item.partyId)?.name ?? '队伍'}`}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <div className="list-empty">
              {missions.length ? '此筛选下没有历练。' : '还没有历练。'}
            </div>
          )}
        </Section>

        <div className="mission-main-column object-detail-pane">
          <Drawer
            title={creating ? '发起历练' : '编辑历练'}
            open={creating || Boolean(mission && editing && canEdit)}
            onClose={resetEditor}
            className="mission-editor-drawer"
          >
            {(creating || (mission && editing && canEdit)) && (
              <form
                className="form-card mission-editor"
                onSubmit={(event) => void saveMission(event)}
              >
                <p className="product-drawer-intro">设置历练标题、目标和执行方式。</p>
                <label className="field">
                  <span>标题</span>
                  <input
                    required
                    maxLength={120}
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      setRoutingPrompt(null);
                    }}
                  />
                </label>
                <label className="field">
                  <span>任务目标</span>
                  <textarea
                    required
                    rows={5}
                    maxLength={12000}
                    value={objective}
                    readOnly={creating ? false : routingAssignmentLocked}
                    onChange={(event) => {
                      setObjective(event.target.value);
                      setRoutingPrompt(null);
                    }}
                  />
                  {!creating && routingAssignmentLocked && (
                    <small className="form-hint">
                      智能分配后任务目标已锁定，以保持原执行分配一致；你仍可修改标题。
                    </small>
                  )}
                </label>
                {creating && (
                  <>
                    <label className="field">
                      <span>分配方式</span>
                      <select
                        ref={assignmentSelectRef}
                        value={assignmentMode}
                        onChange={(event) => {
                          const next = event.target.value as AssignmentMode;
                          setAssignmentMode(next);
                          setCapabilitySelectionRequired(next === 'HUMAN_BRIDGE');
                          if (next === 'HUMAN_BRIDGE') setCapabilityPickerOpen(true);
                          if (next === 'PARTY' && missionMode === 'SOLO') {
                            setMissionMode('CONSULTATION');
                          }
                          setRoutingPrompt(null);
                        }}
                      >
                        <option value="AUTO">自动分配</option>
                        <option value="SOLO">指定道友</option>
                        <option value="PARTY">指定队伍</option>
                        <option value="HUMAN_BRIDGE">本尊执行</option>
                      </select>
                    </label>
                    {assignmentMode === 'SOLO' ? (
                      <>
                        <label className="field">
                          <span>选择道友</span>
                          <select
                            value={coordinatorId}
                            onChange={(event) => {
                              setCoordinatorId(event.target.value);
                              setRoutingPrompt(null);
                            }}
                          >
                            <option value="">选择道友</option>
                            {coordinatorId &&
                              !activeTeammates.some(
                                (teammate) => teammate.id === coordinatorId,
                              ) && (
                                <option value={coordinatorId} disabled>
                                  {teammateFor(coordinatorId)?.name ?? '指定道友'} · 当前不可用
                                </option>
                              )}
                            {activeTeammates.map((teammate) => (
                              <option key={teammate.id} value={teammate.id}>
                                {teammate.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {coordinatorId && renderExecutorStatus(coordinatorId)}
                      </>
                    ) : assignmentMode === 'PARTY' ? (
                      <>
                        <label className="field">
                          <span>协作方式</span>
                          <select
                            value={missionMode}
                            onChange={(event) => {
                              setMissionMode(event.target.value as MissionMode);
                              setRoutingPrompt(null);
                            }}
                          >
                            <option value="CONSULTATION">咨询</option>
                            <option value="REVIEW">审查</option>
                            <option value="DELEGATION">委托</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>参与队伍</span>
                          <select
                            value={partyId}
                            onChange={(event) => {
                              setPartyId(event.target.value);
                              setRoutingPrompt(null);
                            }}
                          >
                            <option value="">选择可用队伍</option>
                            {partyId && !activeParties.some((party) => party.id === partyId) && (
                              <option value={partyId} disabled>
                                {parties.find((party) => party.id === partyId)?.name ?? '指定队伍'}{' '}
                                · 当前不可用
                              </option>
                            )}
                            {activeParties.map((party) => (
                              <option key={party.id} value={party.id}>
                                {party.name} · {party.members.length} 位 ·{' '}
                                {displayTeammateName(party.coordinatorTeammateId)} 协调
                              </option>
                            ))}
                          </select>
                        </label>
                        {activeParties.length === 0 && (
                          <p className="form-hint">
                            请先在 Parties 页面创建包含 2–4 位可用道友的队伍。
                          </p>
                        )}
                        <div className="mission-party-preview">
                          <strong>参与成员</strong>
                          {(activeParties.find((party) => party.id === partyId)?.members ?? [])
                            .slice()
                            .sort((left, right) => left.order - right.order)
                            .map((member) => (
                              <span key={member.teammateId}>
                                {member.role === 'COORDINATOR' ? '协调者 · ' : ''}
                                {displayTeammateName(member.teammateId)}
                              </span>
                            ))}
                        </div>
                      </>
                    ) : assignmentMode === 'HUMAN_BRIDGE' ? (
                      <div className="mission-party-preview" aria-label="本尊执行者">
                        <strong>执行者</strong>
                        {humanBridge ? (
                          <span>{humanBridge.name} · 不探测普通模型</span>
                        ) : (
                          <span>本尊尚不可用；系统不会改派给普通模型。</span>
                        )}
                      </div>
                    ) : (
                      <p className="form-hint">
                        系统会根据任务需要分配道友或队伍；如无法可靠判断能力需求，会请你明确选择，不会填入默认能力。
                      </p>
                    )}
                    <div className="routing-capability-field">
                      <button
                        className="text-button"
                        type="button"
                        aria-expanded={capabilityPickerOpen}
                        onClick={() => setCapabilityPickerOpen((open) => !open)}
                      >
                        {capabilityPickerOpen
                          ? '收起能力需求'
                          : assignmentMode === 'HUMAN_BRIDGE'
                            ? '选择必需能力'
                            : '可选：指定必需能力'}
                        {requiredCapabilities.length > 0
                          ? `（${requiredCapabilities.length}）`
                          : ''}
                      </button>
                      <p className="form-hint">
                        {assignmentMode === 'HUMAN_BRIDGE'
                          ? '本尊执行需要至少一项已启用的能力；请只选择本次历练实际涉及的必需能力。'
                          : capabilitySelectionRequired &&
                              assignmentMode === 'AUTO' &&
                              requiredCapabilities.length === 0
                            ? '当前无法可靠判断任务能力。请至少选择一项必需能力后再分配。'
                            : '留空时由系统分析；只有你明确选择的能力才会作为必需项，不会伪造“通用推理”默认值。'}
                      </p>
                      {assignmentMode === 'HUMAN_BRIDGE' && requiredCapabilities.length === 0 && (
                        <p className="form-hint" role="status">
                          尚未选择必需能力，当前不能创建本尊历练。
                        </p>
                      )}
                      {capabilityPickerOpen && (
                        <CapabilityPicker
                          selected={requiredCapabilities}
                          onChange={(next) => {
                            setRequiredCapabilities(next);
                            setRoutingPrompt(null);
                          }}
                        />
                      )}
                    </div>
                    <details className="mission-routing-advanced">
                      <summary>高级：Human Bridge 文件交付</summary>
                      <p className="form-hint">
                        仅当你需要本尊后备交付文件时设置。默认扩展名为 .txt；工作区仍由应用验证。
                      </p>
                      <label className="routing-capability-option">
                        <input
                          type="checkbox"
                          checked={expectedOutputEnabled}
                          onChange={(event) => {
                            setExpectedOutputEnabled(event.target.checked);
                            setRoutingPrompt(null);
                          }}
                        />
                        <span>附加期望交付文件约定</span>
                      </label>
                      {expectedOutputEnabled && (
                        <div className="routing-output-contract">
                          <label className="field">
                            <span>交付文件名称</span>
                            <input
                              required
                              maxLength={120}
                              value={expectedOutputName}
                              onChange={(event) => setExpectedOutputName(event.target.value)}
                            />
                          </label>
                          <label className="field">
                            <span>允许的文件类型</span>
                            <select
                              value={expectedOutputExtension}
                              onChange={(event) => setExpectedOutputExtension(event.target.value)}
                            >
                              <option value=".txt">.txt</option>
                              <option value=".md">.md</option>
                              <option value=".pdf">.pdf</option>
                              <option value=".png">.png</option>
                              <option value=".csv">.csv</option>
                            </select>
                          </label>
                          <label className="field">
                            <span>最大文件大小（MB）</span>
                            <input
                              required
                              type="number"
                              min="1"
                              max="1024"
                              step="1"
                              value={expectedOutputSizeMb}
                              onChange={(event) => setExpectedOutputSizeMb(event.target.value)}
                            />
                          </label>
                        </div>
                      )}
                    </details>
                    {routingPrompt && (
                      <div className="routing-action-required" role="status">
                        <strong>{routingReasonLabel(routingPrompt.reason)}</strong>
                        {routingPrompt.reason === 'WORKSPACE_REQUIRED' && (
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={busy}
                            onClick={() => void chooseWorkspaceAndRetry()}
                          >
                            选择工作区并重新评估
                          </button>
                        )}
                        <RoutingActions
                          actions={
                            assignmentMode === 'HUMAN_BRIDGE'
                              ? [
                                  ...new Set([
                                    ...routingPrompt.actions.filter(
                                      (action) => action !== 'RECHECK',
                                    ),
                                    'CONFIGURE_CAPABILITY' as const,
                                  ]),
                                ]
                              : routingPrompt.actions
                          }
                          disabled={busy}
                          onRecheck={() => void recheckAndRetryRouting()}
                          onSelectOther={() => assignmentSelectRef.current?.focus()}
                          onCancel={() => {
                            setRoutingPrompt(null);
                            setCreating(false);
                          }}
                          onConfigureCapability={() => setCapabilityPickerOpen(true)}
                        />
                        <RoutingReceiptPanel
                          receipt={routingPrompt.receipt}
                          teammates={teammates}
                          parties={parties}
                          priorityTeammateIds={
                            assignmentMode === 'SOLO'
                              ? [coordinatorId]
                              : assignmentMode === 'PARTY'
                                ? (parties
                                    .find((party) => party.id === partyId)
                                    ?.members.map((member) => member.teammateId) ?? [])
                                : []
                          }
                        />
                      </div>
                    )}
                  </>
                )}
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !title.trim() ||
                      !objective.trim() ||
                      (creating &&
                        ((assignmentMode === 'SOLO' && !coordinatorId) ||
                          (assignmentMode === 'PARTY' && !partyId) ||
                          (assignmentMode === 'HUMAN_BRIDGE' &&
                            requiredCapabilities.length === 0) ||
                          (capabilitySelectionRequired &&
                            assignmentMode === 'AUTO' &&
                            requiredCapabilities.length === 0)))
                    }
                  >
                    {busy ? '正在分配…' : creating ? '分配并创建草稿' : '保存更改'}
                  </button>
                  {creating && (
                    <button type="button" className="button ghost" onClick={resetEditor}>
                      取消
                    </button>
                  )}
                </div>
              </form>
            )}
          </Drawer>

          {!creating && mission && detail && (
            <>
              {(pendingApprovals.length > 0 || pendingCollaborations.length > 0) && (
                <nav className="mission-pending-summary" aria-label="待处理事项">
                  <strong>待我处理</strong>
                  {pendingApprovals.length > 0 && (
                    <a href="#mission-pending-approvals">审批 {pendingApprovals.length}</a>
                  )}
                  {pendingCollaborations.length > 0 && (
                    <a href="#mission-pending-collaboration">
                      协作请求 {pendingCollaborations.length}
                    </a>
                  )}
                </nav>
              )}
              {pendingApprovals.length > 0 && (
                <section
                  className="mission-section approval-section object-section"
                  id="mission-pending-approvals"
                >
                  <div className="section-heading">
                    <div>
                      <h2>待处理审批</h2>
                    </div>
                    <span className="count-badge">{pendingApprovals.length}</span>
                  </div>
                  <div className="approval-list">
                    {pendingApprovals.map((approval) => (
                      <article className="approval-card" key={approval.id}>
                        <div className="approval-card-copy">
                          <strong>{permissionLabel(approval.capability)}</strong>
                          <span>
                            {approval.actionType === 'TOOL_CALL' ? '工具操作' : '权限请求'} ·{' '}
                            {riskLabel(approval.riskLevel)}
                          </span>
                          <small>请求于 {formatDate(approval.createdAt)}</small>
                        </div>
                        <div className="button-row compact">
                          {approval.actionType === 'TOOL_CALL' && (
                            <button
                              className="button secondary small"
                              disabled={busy}
                              onClick={() =>
                                void runAction('本次历练已获授权，将继续执行。', () =>
                                  window.cultivation.missions.resolveApproval({
                                    approvalId: approval.id,
                                    decision: 'ALLOW_MISSION',
                                  }),
                                )
                              }
                            >
                              允许本次历练
                            </button>
                          )}
                          <button
                            className="button primary small"
                            disabled={busy}
                            onClick={() =>
                              void runAction('审批已批准，历练将继续执行。', () =>
                                window.cultivation.missions.resolveApproval({
                                  approvalId: approval.id,
                                  decision: 'APPROVED',
                                }),
                              )
                            }
                          >
                            批准并继续
                          </button>
                          <button
                            className="button danger-ghost small"
                            disabled={busy}
                            onClick={() =>
                              void runAction('审批已拒绝，处理结果已返回执行者。', () =>
                                window.cultivation.missions.resolveApproval({
                                  approvalId: approval.id,
                                  decision: 'DENIED',
                                }),
                              )
                            }
                          >
                            拒绝
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <article className="mission-overview object-section">
                <div className="mission-overview-top">
                  <div className="object-header-copy">
                    <h2>{mission.title}</h2>
                    <div className="mission-overview-meta object-header-meta">
                      <span>{modeLabel(mission.mode ?? 'SOLO')}</span>
                      {mission.partyId && (
                        <span>
                          队伍 ·{' '}
                          {parties.find((party) => party.id === mission.partyId)?.name ??
                            '已关联队伍'}
                        </span>
                      )}
                      <span>创建于 {formatDate(mission.createdAt)}</span>
                    </div>
                  </div>
                  <StatusBadge tone={missionStateTone(mission.state)}>
                    {missionStateLabel(mission.state)}
                  </StatusBadge>
                </div>
                <div className="mission-executor-summary object-header-identity">
                  <Avatar
                    avatar={teammateFor(mission.coordinatorTeammateId)?.avatar}
                    name={displayTeammateName(mission.coordinatorTeammateId)}
                    kind={
                      teammateFor(mission.coordinatorTeammateId)?.executorKind === 'USER_BRIDGE'
                        ? 'HUMAN_BRIDGE'
                        : 'TEAMMATE'
                    }
                    size={38}
                  />
                  <div>
                    <small>执行者</small>
                    <strong>{displayTeammateName(mission.coordinatorTeammateId)}</strong>
                    {renderExecutorStatus(mission.coordinatorTeammateId)}
                  </div>
                </div>
                <p className="mission-objective">{mission.objective}</p>
                {mission.state === 'WAITING_EXTERNAL_WORK' && (
                  <div className="notice">
                    <button
                      className="button secondary small"
                      onClick={() => navigate('/external-work')}
                    >
                      打开本尊待办
                    </button>
                  </div>
                )}
                <div className="mission-actions">
                  {canEdit && !editing && (
                    <button
                      className="button secondary small"
                      disabled={busy || receiptLoading}
                      onClick={() => setEditing(true)}
                    >
                      {routingAssignmentLocked ? '编辑标题' : '编辑目标'}
                    </button>
                  )}
                  {mission.state === 'DRAFT' && (
                    <button
                      className="button primary small"
                      disabled={busy}
                      onClick={() =>
                        void runAction('历练已就绪。', () =>
                          window.cultivation.missions.ready(mission.id),
                        )
                      }
                    >
                      标记就绪
                    </button>
                  )}
                  {mission.state === 'READY' && (
                    <>
                      <details className="mission-run-options">
                        <summary>高级启动选项</summary>
                        <label className="mission-fixture-toggle">
                          <input
                            type="checkbox"
                            checked={approvalFixture}
                            onChange={(event) => setApprovalFixture(event.target.checked)}
                          />
                          <span>触发确定性审批示例</span>
                        </label>
                      </details>
                      <button
                        className="button primary small"
                        disabled={busy}
                        onClick={() =>
                          void runAction('历练已开始。', () =>
                            window.cultivation.missions.start({
                              missionId: mission.id,
                              approvalFixture,
                            }),
                          )
                        }
                      >
                        开始历练
                      </button>
                    </>
                  )}
                  {mission.state === 'RUNNING' && (
                    <button
                      className="button secondary small"
                      disabled={busy}
                      onClick={() =>
                        void runAction('历练已暂停。', () =>
                          window.cultivation.missions.pause(mission.id),
                        )
                      }
                    >
                      暂停
                    </button>
                  )}
                  {mission.state === 'PAUSED' && (
                    <button
                      className="button primary small"
                      disabled={busy}
                      onClick={() =>
                        void runAction('历练已恢复。', () =>
                          window.cultivation.missions.resume(mission.id),
                        )
                      }
                    >
                      恢复
                    </button>
                  )}
                  {(mission.state === 'INTERRUPTED' || mission.state === 'FAILED') && (
                    <button
                      className="button primary small"
                      disabled={busy}
                      onClick={() =>
                        void runAction('已创建一次新的执行尝试。', () =>
                          window.cultivation.missions.retry({
                            missionId: mission.id,
                            approvalFixture,
                          }),
                        )
                      }
                    >
                      重试历练
                    </button>
                  )}
                  {['RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'INTERRUPTED', 'FAILED'].includes(
                    mission.state,
                  ) && (
                    <button
                      className="button danger-ghost small"
                      disabled={busy}
                      onClick={() =>
                        void runAction('历练已取消。', () =>
                          window.cultivation.missions.cancel(mission.id),
                        )
                      }
                    >
                      取消历练
                    </button>
                  )}
                </div>
              </article>

              {latestResultRun?.resultText && (
                <Section
                  title="结果"
                  className="mission-section mission-result-section object-section"
                >
                  <div className="mission-result-content">{latestResultRun.resultText}</div>
                </Section>
              )}

              {detail.participants.length > 0 && (
                <section className="mission-section mission-participants">
                  <div className="section-heading">
                    <div>
                      <h2>参与道友</h2>
                    </div>
                    <span className="count-badge">{detail.participants.length}</span>
                  </div>
                  <div className="mission-participant-list">
                    {detail.participants
                      .slice()
                      .sort((left, right) => left.sortOrder - right.sortOrder)
                      .map((participant) => {
                        const teammate = teammateFor(participant.teammateId);
                        return (
                          <article
                            className="mission-participant-card"
                            key={participant.teammateId}
                          >
                            <Avatar
                              avatar={teammate?.avatar}
                              name={displayTeammateName(participant.teammateId)}
                              kind={
                                teammate?.executorKind === 'USER_BRIDGE'
                                  ? 'HUMAN_BRIDGE'
                                  : 'TEAMMATE'
                              }
                              size={32}
                            />
                            <div>
                              <strong>{displayTeammateName(participant.teammateId)}</strong>
                              <small>
                                {participant.role === 'COORDINATOR'
                                  ? '队长'
                                  : participant.role === 'REVIEWER'
                                    ? '审查者'
                                    : '成员'}
                              </small>
                            </div>
                            {renderExecutorStatus(participant.teammateId)}
                          </article>
                        );
                      })}
                  </div>
                </section>
              )}

              {detail.execution && (
                <G3Collaboration
                  execution={detail.execution}
                  participants={detail.participants}
                  teammates={teammates}
                  onRefresh={() => {
                    void runAction('协作进度已刷新。', async () => undefined);
                  }}
                />
              )}

              {pendingCollaborations.length > 0 && (
                <section className="mission-section collaboration-approval-section">
                  <span id="mission-pending-collaboration" />
                  <div className="section-heading">
                    <div>
                      <h2>待处理协作请求</h2>
                    </div>
                    <span className="count-badge">{pendingCollaborations.length}</span>
                  </div>
                  <div className="collaboration-request-list">
                    {pendingCollaborations.map((request) => (
                      <article className="collaboration-request-card" key={request.id}>
                        <div className="collaboration-request-heading">
                          <span className="collaboration-flow">
                            <strong>{displayTeammateName(request.requesterTeammateId)}</strong>
                            <span>请求协作 →</span>
                            <strong>{displayTeammateName(request.targetTeammateId)}</strong>
                          </span>
                          <StatusBadge tone="warning">等待批准</StatusBadge>
                        </div>
                        <dl className="collaboration-request-details">
                          <div>
                            <dt>原因</dt>
                            <dd>{request.reason}</dd>
                          </div>
                          <div>
                            <dt>拟执行任务</dt>
                            <dd>{request.proposedTask}</dd>
                          </div>
                          <div>
                            <dt>预计收益</dt>
                            <dd>{request.expectedBenefit}</dd>
                          </div>
                        </dl>
                        <small>请求于 {formatDate(request.createdAt)}</small>
                        <div className="button-row compact">
                          {teammates.find((item) => item.id === request.targetTeammateId)
                            ?.executorKind === 'USER_BRIDGE' ? (
                            <HumanBridgeApproval
                              api={window.cultivation.r2}
                              busy={busy}
                              onApprove={(externalWork) =>
                                runAction('已创建本尊待办，原历练正在等待交付。', () =>
                                  window.cultivation.missions.resolveCollaboration({
                                    requestId: request.id,
                                    decision: 'APPROVED',
                                    externalWork,
                                  }),
                                )
                              }
                            />
                          ) : (
                            <button
                              className="button primary small"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void runAction('协作已批准，原历练将继续。', () =>
                                  window.cultivation.missions.resolveCollaboration({
                                    requestId: request.id,
                                    decision: 'APPROVED',
                                  }),
                                )
                              }
                            >
                              批准并继续
                            </button>
                          )}
                          <button
                            className="button danger-ghost small"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void runAction('协作已拒绝，协调道友将收到处理结果。', () =>
                                window.cultivation.missions.resolveCollaboration({
                                  requestId: request.id,
                                  decision: 'DENIED',
                                }),
                              )
                            }
                          >
                            拒绝请求
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {detail.artifacts.length > 0 && (
                <section className="mission-section mission-artifacts">
                  <div className="section-heading">
                    <div>
                      <h2>协作成果</h2>
                    </div>
                    <span className="count-badge">{detail.artifacts.length}</span>
                  </div>
                  <div className="mission-artifact-list">
                    {detail.artifacts
                      .slice()
                      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
                      .map((artifact) => (
                        <article
                          className={`mission-artifact-card artifact-${artifact.kind.toLowerCase()}`}
                          key={artifact.id}
                        >
                          <div className="mission-artifact-heading">
                            <span className="artifact-kind-pill">
                              {artifactKindLabel(artifact.kind)}
                            </span>
                            <strong>{displayTeammateName(artifact.teammateId)}</strong>
                            <time>{formatDate(artifact.createdAt)}</time>
                          </div>
                          <div className="mission-artifact-content">{artifact.content}</div>
                        </article>
                      ))}
                  </div>
                </section>
              )}

              {(routingReceipts.length > 0 || receiptError) && (
                <details className="mission-advanced advanced-disclosure">
                  <summary>高级 · 执行分配记录</summary>
                  {receiptError && <p role="status">{receiptError}</p>}
                  <div className="routing-receipt-list">
                    {routingReceipts
                      .slice()
                      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                      .slice(0, 3)
                      .map((receipt) => (
                        <RoutingReceiptPanel
                          key={receipt.id}
                          receipt={receipt}
                          teammates={teammates}
                          parties={parties}
                        />
                      ))}
                  </div>
                </details>
              )}

              <details className="mission-advanced">
                <summary>高级 · Run 记录</summary>
                <section className="mission-section">
                  <div className="section-heading">
                    <div>
                      <h2>Mission Runs</h2>
                    </div>
                    <span className="count-badge">{detail.runs.length}</span>
                  </div>
                  {detail.runs.length ? (
                    <div className="mission-run-list">
                      {[...detail.runs]
                        .sort((a, b) => a.attempt - b.attempt)
                        .map((run) => (
                          <article className="mission-run-card" key={run.id}>
                            <div className="mission-run-heading">
                              <strong>Attempt {run.attempt}</strong>
                              <span className={`mission-state state-${stateClass(run.status)}`}>
                                {missionStateLabel(run.status)}
                              </span>
                            </div>
                            <small>开始于 {formatDate(run.startedAt)}</small>
                            {run.endedAt && <small>结束于 {formatDate(run.endedAt)}</small>}
                            {run.errorCode && (
                              <small className="mission-error-code">
                                错误代码：{run.errorCode}
                              </small>
                            )}
                            {run.resultText && run.id !== latestResultRun?.id && (
                              <details className="mission-run-result">
                                <summary>查看 Attempt {run.attempt} 结果</summary>
                                <div className="mission-result-content">{run.resultText}</div>
                              </details>
                            )}
                          </article>
                        ))}
                    </div>
                  ) : (
                    <div className="mission-empty-inline">
                      就绪后开始历练，此处会记录每个独立 Run。
                    </div>
                  )}
                </section>
              </details>

              {auditTimeline.length > 0 && (
                <details className="mission-advanced">
                  <summary>高级 · 审计记录 ({auditTimeline.length})</summary>
                  <section className="mission-section">
                    <ol className="mission-timeline">
                      {auditTimeline.map((item) => (
                        <li className="mission-timeline-item" key={item.id}>
                          <span className="timeline-dot audit" />
                          <div className="timeline-card">
                            <div className="timeline-card-heading">
                              <strong>{safeLabel(item.audit.action)}</strong>
                              <time>{formatDate(item.time)}</time>
                            </div>
                            <div className="timeline-safe-meta">
                              <span>Target: {safeLabel(item.audit.targetType ?? 'UNKNOWN')}</span>
                              <span>
                                操作者：{renderActor(item.audit.actorType, item.audit.actorId)}
                              </span>
                              {renderToolTimelineMetadata(item.audit.payloadJson)}
                              <details className="timeline-event-details">
                                <summary>高级 · 完整审计内容</summary>
                                <pre>{JSON.stringify(item.audit.payloadJson, null, 2)}</pre>
                              </details>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                </details>
              )}

              <Section
                title="最近动态"
                className="mission-section mission-recent-timeline object-timeline"
                action={<span className="count-badge">{missionTimeline.length}</span>}
              >
                {missionTimeline.length ? (
                  <ol className="mission-timeline">
                    {missionTimeline.slice(0, 4).map((item) => (
                      <li className="mission-timeline-item" key={item.id}>
                        <span className="timeline-dot" />
                        <div className="timeline-card">
                          <div className="timeline-card-heading">
                            <strong>{recentEventLabel(item.event.eventType)}</strong>
                            <time>{formatDate(item.time)}</time>
                          </div>
                          <div className="timeline-safe-meta">
                            <span>
                              操作者：{renderActor(item.event.actorType, item.event.actorId)}
                            </span>
                            {missionEventSummary(item.event).map((summary) => (
                              <span key={summary}>{summary}</span>
                            ))}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="mission-empty-inline">
                    历练开始后，状态变化和处理记录会显示在这里。
                  </div>
                )}
              </Section>

              <details className="mission-advanced">
                <summary>高级 · 完整执行记录</summary>
                {missionTimeline.length > 0 && (
                  <section className="mission-section">
                    <div className="section-heading">
                      <div>
                        <h2>完整时间线</h2>
                      </div>
                      <span className="count-badge">{missionTimeline.length}</span>
                    </div>
                    <ol className="mission-timeline">
                      {missionTimeline.map((item) => (
                        <li className="mission-timeline-item" key={item.id}>
                          <span className="timeline-dot" />
                          <div className="timeline-card">
                            <div className="timeline-card-heading">
                              <strong>{safeLabel(item.event.eventType)}</strong>
                              <time>{formatDate(item.time)}</time>
                            </div>
                            <div className="timeline-safe-meta">
                              <span>
                                操作者：{renderActor(item.event.actorType, item.event.actorId)}
                              </span>
                              {item.event.runId && (
                                <span>运行 #{runAttemptLabel(detail.runs, item.event.runId)}</span>
                              )}
                              <details className="timeline-event-details">
                                <summary>高级 · 完整事件内容</summary>
                                {renderToolTimelineMetadata(item.event.payloadJson)}
                                <pre>{JSON.stringify(item.event.payloadJson, null, 2)}</pre>
                              </details>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </details>

              <details className="mission-advanced">
                <summary>高级 · 用量明细</summary>
                <section className="mission-section">
                  <div className="section-heading">
                    <div>
                      <h2>Mission Usage</h2>
                    </div>
                    <span className="count-badge">{detail.usage.length}</span>
                  </div>
                  {detail.usage.length ? (
                    <div className="table-card mission-usage-table">
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>时间 / Run</th>
                              <th>道友</th>
                              <th>Provider / Model</th>
                              <th>Runtime Profile</th>
                              <th>输入</th>
                              <th>输出</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.usage.map((item, index) => (
                              <tr key={item.id ?? `${item.runId}-${item.createdAt}-${index}`}>
                                <td>
                                  {formatDate(item.createdAt)}
                                  <small className="cell-id">
                                    Run {runAttemptLabel(detail.runs, item.runId ?? '')}
                                  </small>
                                </td>
                                <td>{displayTeammateName(item.teammateId)}</td>
                                <td>
                                  <strong>{item.provider}</strong>
                                  <small className="cell-id">{item.model}</small>
                                </td>
                                <td>
                                  <code>{item.runtimeProfileId.slice(0, 12)}</code>
                                </td>
                                <td>{formatToken(item.inputTokens)}</td>
                                <td>{formatToken(item.outputTokens)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="mission-empty-inline">
                      模型调用完成后，其 UsageRecord 会关联到相应 Run。
                    </div>
                  )}
                </section>
              </details>
            </>
          )}

          {!creating && !mission && !loading && error && (
            <div className="empty-card mission-empty-state">
              <span className="empty-icon">◇</span>
              <h3>暂时无法读取 Mission</h3>
              <p>{error}</p>
              <button
                className="button secondary"
                type="button"
                onClick={() => setLoadAttempt((current) => current + 1)}
              >
                重新读取
              </button>
            </div>
          )}

          {!creating && mission && !detail && !loading && (
            <div className="empty-card mission-empty-state">
              <span className="empty-icon">◇</span>
              <h3>{detailLoading ? '正在读取 Mission 详情' : 'Mission 详情暂不可用'}</h3>
              {!detailLoading && error && <p>{error}</p>}
              {detailLoading ? (
                <div className="loading-card">读取中…</div>
              ) : (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setDetailLoadAttempt((current) => current + 1)}
                >
                  重试
                </button>
              )}
            </div>
          )}

          {!creating && !mission && !loading && !error && (
            <EmptyState
              icon="Mission"
              title={
                missions.length
                  ? '此筛选下没有历练'
                  : activeTeammates.length || activeParties.length
                    ? '发起一次历练'
                    : '先准备一位可用道友'
              }
              description={
                missions.length
                  ? undefined
                  : activeTeammates.length || activeParties.length
                    ? '填写任务目标并指定道友或队伍。'
                    : '先创建或启用一位道友。'
              }
              action={
                missions.length ? (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => {
                      setMissionFilter('all');
                      setSelectedId(missions[0]?.id ?? '');
                    }}
                  >
                    查看全部历练
                  </button>
                ) : activeTeammates.length || activeParties.length ? (
                  <button className="button primary" type="button" onClick={beginCreateMission}>
                    发起历练
                  </button>
                ) : (
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => navigate('/teammates')}
                  >
                    创建道友
                  </button>
                )
              }
            />
          )}
        </div>
      </div>
    </section>
  );
}
