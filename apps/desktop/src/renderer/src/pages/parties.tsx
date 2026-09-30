import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import './mission-party.css';
import { errorText, PageHeading, teammateName } from '../ui-shared.js';
import type { TeammateView, PartyType, PartyView } from '../ui-shared.js';

type PartyForm = {
  name: string;
  description: string;
  type: PartyType;
  coordinatorTeammateId: string;
  memberTeammateIds: string[];
};

const blankPartyForm: PartyForm = {
  name: '',
  description: '',
  type: 'FIXED',
  coordinatorTeammateId: '',
  memberTeammateIds: [],
};

export function PartiesPage() {
  const [parties, setParties] = useState<PartyView[]>([]);
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [form, setForm] = useState<PartyForm>(blankPartyForm);
  const [editingId, setEditingId] = useState('');
  const [selectedPartyId, setSelectedPartyId] = useState('');
  const [partyFilter, setPartyFilter] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();

  const activeTeammates = teammates.filter((teammate) => teammate.status === 'ACTIVE');
  const refresh = async () => {
    const [partyRows, teammateRows] = await Promise.all([
      window.cultivation.parties.list(),
      window.cultivation.teammates.list(),
    ]);
    setParties(partyRows);
    setTeammates(teammateRows);
    return partyRows;
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void Promise.all([window.cultivation.parties.list(), window.cultivation.teammates.list()])
      .then(([partyRows, teammateRows]) => {
        if (cancelled) return;
        setParties(partyRows);
        setTeammates(teammateRows);
        setSelectedPartyId((current) =>
          current && partyRows.some((party) => party.id === current)
            ? current
            : (partyRows.find((party) => party.status === 'ACTIVE')?.id ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取队伍失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const beginCreate = () => {
    const initial = activeTeammates.slice(0, 2).map((teammate) => teammate.id);
    setForm({
      ...blankPartyForm,
      memberTeammateIds: initial,
      coordinatorTeammateId: initial[0] ?? '',
    });
    setEditingId('');
    setSelectedPartyId('');
    setPartyFilter('ACTIVE');
    setCreating(true);
    setError('');
    setNotice('');
  };

  const beginEdit = (party: PartyView) => {
    const memberTeammateIds = party.members
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((member) => member.teammateId);
    setForm({
      name: party.name,
      description: party.description,
      type: party.type,
      coordinatorTeammateId: party.coordinatorTeammateId,
      memberTeammateIds,
    });
    setEditingId(party.id);
    setSelectedPartyId(party.id);
    setCreating(false);
    setError('');
    setNotice('');
  };

  const updateMembers = (teammateId: string, checked: boolean) => {
    setForm((current) => {
      const members = checked
        ? [...current.memberTeammateIds, teammateId]
        : current.memberTeammateIds.filter((id) => id !== teammateId);
      const coordinatorTeammateId = checked
        ? current.coordinatorTeammateId || teammateId
        : current.coordinatorTeammateId === teammateId
          ? (members[0] ?? '')
          : current.coordinatorTeammateId;
      return { ...current, memberTeammateIds: members, coordinatorTeammateId };
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const selectedActive = form.memberTeammateIds.filter((id) =>
      activeTeammates.some((teammate) => teammate.id === id),
    );
    if (selectedActive.length < 2 || selectedActive.length > 4) {
      setError('队伍必须包含 2–4 名当前可用的道友。');
      return;
    }
    if (!selectedActive.includes(form.coordinatorTeammateId)) {
      setError('协调道友必须属于队伍成员。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const input = {
        name: form.name.trim(),
        description: form.description.trim(),
        type: form.type,
        coordinatorTeammateId: form.coordinatorTeammateId,
        memberTeammateIds: selectedActive,
      };
      const saved = editingId
        ? await window.cultivation.parties.update({ id: editingId, ...input })
        : await window.cultivation.parties.create(input);
      await refresh();
      setSelectedPartyId(saved.id);
      setPartyFilter('ACTIVE');
      setEditingId('');
      setCreating(false);
      setForm(blankPartyForm);
      setNotice(editingId ? '队伍已更新。' : '队伍已创建。');
    } catch (cause) {
      setError(errorText(cause, '保存队伍失败。'));
    } finally {
      setBusy(false);
    }
  };
  const archive = async (party: PartyView) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.cultivation.parties.archive(party.id);
      await refresh();
      if (editingId === party.id) {
        setEditingId('');
        setForm(blankPartyForm);
      }
      if (selectedPartyId === party.id) setSelectedPartyId('');
      setNotice(`队伍「${party.name}」已归档。`);
    } catch (cause) {
      setError(errorText(cause, '归档队伍失败。'));
    } finally {
      setBusy(false);
    }
  };

  const activeParties = parties.filter((party) => party.status === 'ACTIVE');
  const archivedParties = parties.filter((party) => party.status === 'ARCHIVED');
  const visibleParties = partyFilter === 'ACTIVE' ? activeParties : archivedParties;
  const selectedParty = parties.find((party) => party.id === selectedPartyId) ?? null;
  const orderedMembers = (party: PartyView) =>
    party.members.slice().sort((left, right) => left.order - right.order);

  return (
    <section className="page wide-page party-page">
      <PageHeading eyebrow="组队协作 · Party" title="队伍 Parties" description="队伍" />
      {error && (
        <div className="notice error notice-with-action" role="alert">
          {error}
          <button
            className="text-button"
            type="button"
            onClick={() => setLoadAttempt((current) => current + 1)}
          >
            重新读取
          </button>
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      <div className="party-layout">
        <section className="party-roster">
          <div className="list-heading">
            <div>
              <h2>队伍</h2>
              <p>
                {activeParties.length} 支可用队伍 · {archivedParties.length} 支已归档
              </p>
            </div>
            <button
              className="button primary small"
              type="button"
              disabled={busy || activeTeammates.length < 2}
              onClick={beginCreate}
            >
              新建队伍
            </button>
          </div>
          <div className="party-filter-tabs" role="tablist" aria-label="筛选队伍">
            <button
              type="button"
              role="tab"
              aria-selected={partyFilter === 'ACTIVE'}
              className={partyFilter === 'ACTIVE' ? 'active' : ''}
              onClick={() => {
                setPartyFilter('ACTIVE');
                setSelectedPartyId(activeParties[0]?.id ?? '');
              }}
            >
              可用 <span>{activeParties.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={partyFilter === 'ARCHIVED'}
              className={partyFilter === 'ARCHIVED' ? 'active' : ''}
              onClick={() => {
                setPartyFilter('ARCHIVED');
                setSelectedPartyId(archivedParties[0]?.id ?? '');
                setCreating(false);
                setEditingId('');
              }}
            >
              已归档 <span>{archivedParties.length}</span>
            </button>
          </div>
          {loading ? (
            <div className="loading-card">正在读取队伍…</div>
          ) : error && parties.length === 0 ? (
            <div className="empty-card party-empty-state">
              <h3>暂时无法读取队伍</h3>
              <p>连接恢复后可重新载入队伍与成员列表。</p>
              <button
                className="button secondary"
                type="button"
                onClick={() => setLoadAttempt((current) => current + 1)}
              >
                重新读取
              </button>
            </div>
          ) : visibleParties.length ? (
            <div className="party-compact-list">
              {visibleParties.map((party) => (
                <article
                  className={`party-compact-item ${selectedPartyId === party.id ? 'selected' : ''}`}
                  key={party.id}
                >
                  <button
                    className="party-summary-button"
                    type="button"
                    aria-pressed={selectedPartyId === party.id}
                    onClick={() => {
                      setSelectedPartyId(party.id);
                      setCreating(false);
                      setEditingId('');
                    }}
                  >
                    <span className="party-summary-copy">
                      <strong>{party.name}</strong>
                      <small>协调者 · {teammateName(teammates, party.coordinatorTeammateId)}</small>
                    </span>
                    <span
                      className="party-summary-members"
                      aria-label={`${party.members.length} 位成员`}
                    >
                      {orderedMembers(party).map((member) => {
                        const teammate = teammates.find((item) => item.id === member.teammateId);
                        return (
                          <span className="avatar" key={member.teammateId}>
                            {teammate?.avatar ||
                              teammateName(teammates, member.teammateId).slice(0, 1)}
                          </span>
                        );
                      })}
                    </span>
                    <span className="party-summary-count">{party.members.length}/4</span>
                    <span className="party-summary-availability">
                      {orderedMembers(party).map((member) => (
                        <AvailabilityBadge
                          key={member.teammateId}
                          teammateId={member.teammateId}
                          recheck={false}
                          compact
                        />
                      ))}
                    </span>
                  </button>
                  {party.status === 'ACTIVE' && (
                    <div className="party-compact-actions">
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => beginEdit(party)}
                      >
                        编辑
                      </button>
                      <button
                        className="text-button danger-text"
                        type="button"
                        disabled={busy}
                        onClick={() => void archive(party)}
                      >
                        归档
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-card party-empty-state">
              <h3>
                {partyFilter === 'ARCHIVED'
                  ? '没有已归档队伍'
                  : activeTeammates.length < 2
                    ? '组队需要两位可用道友'
                    : '还没有可用队伍'}
              </h3>
              {partyFilter === 'ACTIVE' && activeTeammates.length < 2 && (
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
        </section>

        <div className="party-detail-column">
          {(creating || editingId) && (
            <form className="form-card party-editor" onSubmit={(event) => void submit(event)}>
              <div className="form-title-row">
                <div>
                  <p className="eyebrow">PARTY CONFIGURATION</p>
                  <h2>{creating ? '创建队伍' : '编辑队伍'}</h2>
                </div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setEditingId('');
                    setForm(blankPartyForm);
                  }}
                >
                  取消
                </button>
              </div>
              <label className="field">
                <span>队伍名称</span>
                <input
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>
                  说明 <small>可选</small>
                </span>
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>类型</span>
                <select
                  value={form.type}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, type: event.target.value as PartyType }))
                  }
                >
                  <option value="FIXED">FIXED · 固定队伍</option>
                  <option value="AD_HOC">AD_HOC · 临时队伍</option>
                </select>
              </label>
              <fieldset className="party-member-fieldset">
                <legend>成员 · 选择 2–4 位可用道友</legend>
                {teammates.map((teammate) => {
                  const checked = form.memberTeammateIds.includes(teammate.id);
                  const archivedSelected = checked && teammate.status !== 'ACTIVE';
                  return (
                    <label
                      className={`party-member-option ${teammate.status !== 'ACTIVE' ? 'unavailable' : ''}`}
                      key={teammate.id}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={
                          busy ||
                          (teammate.status !== 'ACTIVE' && !checked) ||
                          (!checked && form.memberTeammateIds.length >= 4)
                        }
                        onChange={(event) => updateMembers(teammate.id, event.target.checked)}
                      />
                      <span>
                        <strong>{teammate.name}</strong>
                        <small>
                          {teammate.title || '道友'}
                          {archivedSelected
                            ? ' · 当前已归档，请移除后保存'
                            : teammate.status !== 'ACTIVE'
                              ? ' · 不可加入新队伍'
                              : ''}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <label className="field">
                <span>协调道友</span>
                <select
                  required
                  value={form.coordinatorTeammateId}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      coordinatorTeammateId: event.target.value,
                    }))
                  }
                >
                  <option value="">选择协调者</option>
                  {form.memberTeammateIds
                    .filter((id) =>
                      activeTeammates.some(
                        (teammate) => teammate.id === id && teammate.executorKind !== 'USER_BRIDGE',
                      ),
                    )
                    .map((id) => (
                      <option key={id} value={id}>
                        {teammateName(teammates, id)}
                      </option>
                    ))}
                </select>
              </label>
              {form.memberTeammateIds.length < 2 && <p className="form-hint">至少选择两位道友。</p>}
              <button
                className="button primary"
                disabled={
                  busy ||
                  !form.name.trim() ||
                  form.memberTeammateIds.length < 2 ||
                  form.memberTeammateIds.length > 4 ||
                  !form.memberTeammateIds.includes(form.coordinatorTeammateId) ||
                  form.memberTeammateIds.some(
                    (id) => !activeTeammates.some((teammate) => teammate.id === id),
                  )
                }
              >
                {busy ? '保存中…' : '保存队伍'}
              </button>
            </form>
          )}
          {!creating && !editingId && selectedParty && (
            <section className="party-detail-card">
              <div className="party-detail-heading">
                <div>
                  <h2>{selectedParty.name}</h2>
                  <div className="party-detail-meta">
                    <span>{selectedParty.type === 'FIXED' ? '固定队伍' : '临时队伍'}</span>
                    <span>{selectedParty.status === 'ACTIVE' ? '可用' : '已归档'}</span>
                    <span>{selectedParty.members.length}/4</span>
                  </div>
                </div>
                {selectedParty.status === 'ACTIVE' && (
                  <button
                    className="button primary small"
                    type="button"
                    onClick={() =>
                      navigate(`/missions?partyId=${encodeURIComponent(selectedParty.id)}&create=1`)
                    }
                  >
                    发起队伍历练
                  </button>
                )}
              </div>
              {selectedParty.description && (
                <p className="party-description">{selectedParty.description}</p>
              )}
              <div className="party-detail-members">
                {orderedMembers(selectedParty).map((member) => {
                  const teammate = teammates.find((item) => item.id === member.teammateId);
                  return (
                    <article className="party-detail-member" key={member.teammateId}>
                      <span className="avatar">
                        {teammate?.avatar || teammateName(teammates, member.teammateId).slice(0, 1)}
                      </span>
                      <div className="party-detail-member-copy">
                        <strong>{teammateName(teammates, member.teammateId)}</strong>
                        <small>
                          {member.role === 'COORDINATOR' ? '协调者' : '成员'}
                          {teammate?.status !== 'ACTIVE' ? ' · 不可用' : ''}
                        </small>
                      </div>
                      <AvailabilityBadge teammateId={member.teammateId} />
                    </article>
                  );
                })}
              </div>
              {selectedParty.status === 'ACTIVE' && (
                <div className="button-row compact party-detail-actions">
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={busy}
                    onClick={() => beginEdit(selectedParty)}
                  >
                    编辑队伍
                  </button>
                  <button
                    className="button danger-ghost small"
                    type="button"
                    disabled={busy}
                    onClick={() => void archive(selectedParty)}
                  >
                    归档队伍
                  </button>
                </div>
              )}
            </section>
          )}
          {!creating && !editingId && !selectedParty && !loading && (
            <div className="empty-card party-empty-state">
              <h3>选择一支队伍</h3>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
