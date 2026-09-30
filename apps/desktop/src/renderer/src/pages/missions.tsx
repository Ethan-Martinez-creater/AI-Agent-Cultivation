import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import './mission-party.css';
import { HumanBridgeApproval } from '.././r2-human-bridge.js';
import {
  errorText,
  PageHeading,
  missionStateLabel,
  missionModeLabel,
  artifactKindLabel,
  timelineActorName,
  stateClass,
  teammateName,
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
} from '../ui-shared.js';

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
  const [missionFilter, setMissionFilter] = useState<'running' | 'history' | 'all'>('running');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const handledCreateQuery = useRef('');
  const availableTeammates = teammates.filter((teammate) => teammate.status === 'ACTIVE');
  const activeTeammates = availableTeammates.filter(
    (teammate) => teammate.executorKind !== 'USER_BRIDGE',
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
    const selectedParty = activeParties.find((party) => party.id === requestedPartyId);
    const selectedTeammate = activeTeammates.find(
      (teammate) => teammate.id === requestedTeammateId,
    );
    setSelectedId('');
    setDetail(null);
    setCreating(true);
    setEditing(false);
    setTitle('');
    setObjective('');
    setMissionMode(selectedParty ? 'CONSULTATION' : 'SOLO');
    setPartyId(selectedParty?.id ?? activeParties[0]?.id ?? '');
    setCoordinatorId(selectedTeammate?.id ?? activeTeammates[0]?.id ?? '');
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
        if (!cancelled) setError(errorText(cause, '读取 Mission 失败。'));
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
        if (!cancelled) setError(errorText(cause, '读取 Mission 详情失败。'));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailLoadAttempt]);

  const mission = detail?.mission ?? missions.find((item) => item.id === selectedId) ?? null;
  const canEdit = !mission || mission.state === 'DRAFT' || mission.state === 'READY';
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
    }
  };

  const beginCreateMission = () => {
    setSelectedId('');
    setDetail(null);
    setCreating(true);
    setEditing(false);
    setTitle('');
    setObjective('');
    setMissionMode('SOLO');
    setPartyId(activeParties[0]?.id ?? '');
    setCoordinatorId(activeTeammates[0]?.id ?? '');
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

  const saveMission = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      creating &&
      (missionMode === 'SOLO'
        ? !activeTeammates.some((teammate) => teammate.id === coordinatorId)
        : !activeParties.some((party) => party.id === partyId))
    ) {
      setError(
        missionMode === 'SOLO'
          ? '请选择一位当前可用的执行道友。'
          : '请选择一支由 2–4 位当前可用道友组成的队伍。',
      );
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (creating) {
        const created = await window.cultivation.missions.create({
          title: title.trim(),
          objective: objective.trim(),
          coordinatorTeammateId:
            missionMode === 'SOLO'
              ? coordinatorId
              : (activeParties.find((party) => party.id === partyId)?.coordinatorTeammateId ??
                coordinatorId),
          mode: missionMode,
          partyId: missionMode === 'SOLO' ? null : partyId,
        });
        await refreshMissions(created.id);
        setDetail(await window.cultivation.missions.detail(created.id));
        setCreating(false);
        setEditing(false);
        setNotice('Mission 草稿已创建。');
      } else if (mission) {
        const updated = await window.cultivation.missions.update({
          id: mission.id,
          title: title.trim(),
          objective: objective.trim(),
        });
        await refreshMissions(updated.id);
        setDetail(await window.cultivation.missions.detail(updated.id));
        setEditing(false);
        setNotice('Mission 已保存。');
      }
    } catch (cause) {
      setError(errorText(cause, '保存 Mission 失败。'));
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

  return (
    <section className="page wide-page mission-page">
      <PageHeading
        eyebrow="任务历练 · Mission"
        title="历练 Missions"
        description="先用 SOLO Mission 完成单人历练；准备队伍后，再选择 Party 协作模式。每位道友的 Runtime、Memory 与 Skill 保持独立。"
      />
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
      <div className="mission-workspace">
        <aside className="mission-list-card">
          <div className="list-heading">
            <div>
              <h2>历练</h2>
              <p>{visibleMissions.length} 项</p>
            </div>
            <button
              className="button primary small"
              disabled={busy || (activeTeammates.length === 0 && activeParties.length === 0)}
              onClick={beginCreateMission}
            >
              + 发起历练
            </button>
          </div>
          <div className="mission-filter-tabs" role="tablist" aria-label="筛选历练">
            {(
              [
                ['running', '运行中'],
                ['history', '历史'],
                ['all', '全部'],
              ] as const
            ).map(([filter, label]) => {
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
                  onClick={() => {
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
                  }}
                >
                  {label}
                  <span>{count}</span>
                </button>
              );
            })}
          </div>
          {loading ? (
            <div className="loading-card">正在读取 Mission…</div>
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
                    <span className={`mission-state state-${stateClass(item.state)}`}>
                      {missionStateLabel(item.state)}
                    </span>
                  </span>
                  <small>
                    {teammateName(teammates, item.coordinatorTeammateId)} ·{' '}
                    {missionModeLabel(item.mode ?? 'SOLO')}
                    {item.partyId &&
                      ` · ${parties.find((party) => party.id === item.partyId)?.name ?? 'Party'}`}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <div className="list-empty">
              {missions.length ? '此筛选下没有历练。' : '还没有历练。'}
            </div>
          )}
        </aside>

        <div className="mission-main-column">
          {(creating || (mission && editing && canEdit)) && (
            <form
              className="form-card mission-editor"
              onSubmit={(event) => void saveMission(event)}
            >
              <div className="form-title-row">
                <div>
                  <p className="eyebrow">{creating ? 'NEW MISSION' : 'MISSION'}</p>
                  <h2>{creating ? '创建 Mission 草稿' : '编辑 Mission'}</h2>
                </div>
                {!creating && (
                  <button type="button" className="text-button" onClick={resetEditor}>
                    取消
                  </button>
                )}
              </div>
              <label className="field">
                <span>标题</span>
                <input
                  required
                  maxLength={120}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="field">
                <span>目标 Objective</span>
                <textarea
                  required
                  rows={5}
                  maxLength={12000}
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                />
              </label>
              {creating && (
                <>
                  <label className="field">
                    <span>执行方式</span>
                    <select
                      value={missionMode === 'SOLO' ? 'SOLO' : 'PARTY'}
                      onChange={(event) =>
                        setMissionMode((current) =>
                          event.target.value === 'SOLO'
                            ? 'SOLO'
                            : current === 'SOLO'
                              ? 'CONSULTATION'
                              : current,
                        )
                      }
                    >
                      <option value="SOLO">指定道友</option>
                      <option value="PARTY">指定队伍</option>
                    </select>
                  </label>
                  {missionMode === 'SOLO' ? (
                    <>
                      <label className="field">
                        <span>执行道友</span>
                        <select
                          required
                          value={coordinatorId}
                          onChange={(event) => setCoordinatorId(event.target.value)}
                        >
                          <option value="">选择道友</option>
                          {activeTeammates.map((teammate) => (
                            <option key={teammate.id} value={teammate.id}>
                              {teammate.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {coordinatorId && <AvailabilityBadge teammateId={coordinatorId} />}
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>协作方式</span>
                        <select
                          value={missionMode}
                          onChange={(event) => setMissionMode(event.target.value as MissionMode)}
                        >
                          <option value="CONSULTATION">咨询</option>
                          <option value="REVIEW">审查</option>
                          <option value="DELEGATION">委托</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>参与队伍</span>
                        <select
                          required
                          value={partyId}
                          onChange={(event) => setPartyId(event.target.value)}
                        >
                          <option value="">选择可用队伍</option>
                          {activeParties.map((party) => (
                            <option key={party.id} value={party.id}>
                              {party.name} · {party.members.length} 位 ·{' '}
                              {teammateName(teammates, party.coordinatorTeammateId)} 协调
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
                              {teammateName(teammates, member.teammateId)}
                            </span>
                          ))}
                      </div>
                    </>
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
                      (missionMode === 'SOLO'
                        ? !activeTeammates.some((teammate) => teammate.id === coordinatorId)
                        : !activeParties.some((party) => party.id === partyId)))
                  }
                >
                  {busy ? '保存中…' : creating ? '创建草稿' : '保存更改'}
                </button>
                {creating && (
                  <button type="button" className="button ghost" onClick={resetEditor}>
                    取消
                  </button>
                )}
              </div>
            </form>
          )}

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
                  className="mission-section approval-section"
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
                          <strong>{approval.capability}</strong>
                          <span>
                            {approval.actionType} · 风险 {approval.riskLevel}
                          </span>
                          <small>
                            Run {runAttemptLabel(detail.runs, approval.runId)} · 请求于{' '}
                            {formatDate(approval.createdAt)}
                          </small>
                        </div>
                        <div className="button-row compact">
                          {approval.actionType === 'TOOL_CALL' && (
                            <button
                              className="button secondary small"
                              disabled={busy}
                              onClick={() =>
                                void runAction('Mission 授权已记录，Runtime 将继续执行。', () =>
                                  window.cultivation.missions.resolveApproval({
                                    approvalId: approval.id,
                                    decision: 'ALLOW_MISSION',
                                  }),
                                )
                              }
                            >
                              Allow This Mission
                            </button>
                          )}
                          <button
                            className="button primary small"
                            disabled={busy}
                            onClick={() =>
                              void runAction('审批已批准，Runtime 将继续执行。', () =>
                                window.cultivation.missions.resolveApproval({
                                  approvalId: approval.id,
                                  decision: 'APPROVED',
                                }),
                              )
                            }
                          >
                            批准
                          </button>
                          <button
                            className="button danger-ghost small"
                            disabled={busy}
                            onClick={() =>
                              void runAction('审批已拒绝，拒绝结果已交还 Runtime。', () =>
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
              <article className="mission-overview">
                <div className="mission-overview-top">
                  <div>
                    <h2>{mission.title}</h2>
                    <p className="mission-overview-meta">
                      {missionModeLabel(mission.mode ?? 'SOLO')} · 协调道友{' '}
                      {teammateName(teammates, mission.coordinatorTeammateId)} · 创建于{' '}
                      {formatDate(mission.createdAt)}
                    </p>
                  </div>
                  <span className={`mission-state large state-${stateClass(mission.state)}`}>
                    {missionStateLabel(mission.state)}
                  </span>
                </div>
                <AvailabilityBadge teammateId={mission.coordinatorTeammateId} compact />
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
                      disabled={busy}
                      onClick={() => setEditing(true)}
                    >
                      编辑目标
                    </button>
                  )}
                  {mission.state === 'DRAFT' && (
                    <button
                      className="button primary small"
                      disabled={busy}
                      onClick={() =>
                        void runAction('Mission 已就绪。', () =>
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
                          void runAction('Mission Run 已启动。', () =>
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
                        void runAction('Mission 已暂停。', () =>
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
                        void runAction('Mission 已恢复。', () =>
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
                        void runAction('已创建新的 Mission Run。', () =>
                          window.cultivation.missions.retry({
                            missionId: mission.id,
                            approvalFixture,
                          }),
                        )
                      }
                    >
                      重试（新 Run）
                    </button>
                  )}
                  {['RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'INTERRUPTED', 'FAILED'].includes(
                    mission.state,
                  ) && (
                    <button
                      className="button danger-ghost small"
                      disabled={busy}
                      onClick={() =>
                        void runAction('Mission 已取消。', () =>
                          window.cultivation.missions.cancel(mission.id),
                        )
                      }
                    >
                      取消历练
                    </button>
                  )}
                </div>
              </article>

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
                      .map((participant) => (
                        <article className="mission-participant-card" key={participant.teammateId}>
                          <span className="avatar">
                            {teammates.find((teammate) => teammate.id === participant.teammateId)
                              ?.avatar ||
                              teammateName(teammates, participant.teammateId).slice(0, 1)}
                          </span>
                          <div>
                            <strong>{teammateName(teammates, participant.teammateId)}</strong>
                            <small>{safeLabel(participant.role)}</small>
                          </div>
                        </article>
                      ))}
                  </div>
                </section>
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
                            <strong>{teammateName(teammates, request.requesterTeammateId)}</strong>
                            <span>请求协作 →</span>
                            <strong>{teammateName(teammates, request.targetTeammateId)}</strong>
                          </span>
                          <span className="mission-state state-waiting-approval">等待批准</span>
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
                        <small>
                          委托深度 {request.depth} · Run{' '}
                          {runAttemptLabel(detail.runs, request.runId)} · 请求于{' '}
                          {formatDate(request.createdAt)}
                        </small>
                        <div className="button-row compact">
                          {teammates.find((item) => item.id === request.targetTeammateId)
                            ?.executorKind === 'USER_BRIDGE' ? (
                            <HumanBridgeApproval
                              api={window.cultivation.r2}
                              busy={busy}
                              onApprove={(externalWork) =>
                                runAction('已创建本尊外部工作；原 Run 正在等待提交。', () =>
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
                                void runAction('协作已批准，原 Mission Run 将继续。', () =>
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
                              void runAction('协作已拒绝，Coordinator 将收到结构化结果。', () =>
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
                            <strong>{teammateName(teammates, artifact.teammateId)}</strong>
                            <time>{formatDate(artifact.createdAt)}</time>
                          </div>
                          <div className="mission-artifact-content">{artifact.content}</div>
                        </article>
                      ))}
                  </div>
                </section>
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
                                参与者:{' '}
                                {timelineActorName(
                                  teammates,
                                  item.audit.actorType,
                                  item.audit.actorId,
                                )}
                              </span>
                              {renderToolTimelineMetadata(item.audit.payloadJson)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                </details>
              )}

              <section className="mission-section">
                <div className="section-heading">
                  <div>
                    <h2>执行 Timeline</h2>
                  </div>
                  <span className="count-badge">{missionTimeline.length}</span>
                </div>
                {missionTimeline.length ? (
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
                              参与者:{' '}
                              {timelineActorName(
                                teammates,
                                item.event.actorType,
                                item.event.actorId,
                              )}
                            </span>
                            {item.event.runId && (
                              <span>Run {runAttemptLabel(detail.runs, item.event.runId)}</span>
                            )}
                            <details className="timeline-event-details">
                              <summary>高级事件元数据</summary>
                              {renderToolTimelineMetadata(item.event.payloadJson)}
                            </details>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="mission-empty-inline">
                    状态变化、审批和模型调用事件会追加到此时间线。
                  </div>
                )}
              </section>

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
                                <td>{teammateName(teammates, item.teammateId)}</td>
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
            <div className="empty-card mission-empty-state">
              <span className="empty-icon">◇</span>
              <h3>
                {missions.length
                  ? '此筛选下没有历练'
                  : activeTeammates.length || activeParties.length
                    ? '发起一次历练'
                    : '先准备一位可用道友'}
              </h3>
              {!missions.length && (
                <p>
                  {activeTeammates.length || activeParties.length
                    ? '填写任务目标并指定执行道友或队伍。'
                    : '先创建或启用一位道友。'}
                </p>
              )}
              {missions.length ? (
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
                <div className="button-row centered">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => navigate('/settings')}
                  >
                    配置 Provider
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => navigate('/teammates')}
                  >
                    创建道友
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
