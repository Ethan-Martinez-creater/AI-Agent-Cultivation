import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
      if (editingId) await window.cultivation.parties.update({ id: editingId, ...input });
      else await window.cultivation.parties.create(input);
      await refresh();
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
      setNotice(`队伍「${party.name}」已归档。`);
    } catch (cause) {
      setError(errorText(cause, '归档队伍失败。'));
    } finally {
      setBusy(false);
    }
  };

  const activeParties = parties.filter((party) => party.status === 'ACTIVE');
  const archivedParties = parties.filter((party) => party.status === 'ARCHIVED');

  return (
    <section className="page wide-page party-page">
      <PageHeading
        eyebrow="组队协作 · Party"
        title="队伍 Parties"
        description="组合 2–4 位持久道友并指定协调者。队伍成员保持各自的 Runtime、Memory、Skill 与工具权限。"
      />
      <div className="workflow-note">
        <strong>协作建议</strong>
        <p>
          先用 SOLO Mission 熟悉单人运行；准备至少两位可用道友后创建 Party，再从 Party Mission
          选择咨询、审查或委托。每次跨道友协作都会生成可审阅的请求。
        </p>
        <button className="text-button" type="button" onClick={() => navigate('/missions')}>
          前往 Mission
        </button>
      </div>
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
        <section className="list-card party-roster">
          <div className="list-heading">
            <div>
              <h2>我的队伍</h2>
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
          ) : activeParties.length ? (
            <div className="party-list">
              {activeParties.map((party) => (
                <article
                  className={`party-card ${editingId === party.id ? 'selected' : ''}`}
                  key={party.id}
                >
                  <div className="party-card-heading">
                    <div>
                      <h3>{party.name}</h3>
                      <span className={`party-type-pill ${party.type.toLowerCase()}`}>
                        {party.type === 'FIXED' ? '固定队伍' : '临时队伍'}
                      </span>
                    </div>
                    <span className="count-badge">{party.members.length}/4</span>
                  </div>
                  <p>{party.description || '暂无说明。'}</p>
                  <div className="party-member-list">
                    {party.members
                      .slice()
                      .sort((left, right) => left.order - right.order)
                      .map((member) => (
                        <span
                          className={`party-member-chip ${member.role === 'COORDINATOR' ? 'coordinator' : ''}`}
                          key={member.teammateId}
                        >
                          {member.role === 'COORDINATOR' ? '协调者 · ' : ''}
                          {teammateName(teammates, member.teammateId)}
                          {teammates.find((teammate) => teammate.id === member.teammateId)
                            ?.status !== 'ACTIVE' && ' · 不可用'}
                        </span>
                      ))}
                  </div>
                  <div className="button-row compact">
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() => beginEdit(party)}
                    >
                      编辑
                    </button>
                    <button
                      className="button danger-ghost small"
                      type="button"
                      disabled={busy}
                      onClick={() => void archive(party)}
                    >
                      归档
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-card party-empty-state">
              <span className="empty-icon">◇</span>
              <h3>{activeTeammates.length < 2 ? '组队需要两位可用道友' : '还没有可用队伍'}</h3>
              <p>
                {activeTeammates.length < 2
                  ? '创建或启用第二位道友后，便可指定协调者并开始 Party Mission。'
                  : '创建一支包含 2–4 位道友的队伍，之后可在 Party Mission 中发起协作。'}
              </p>
              {activeTeammates.length < 2 ? (
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
              ) : (
                <button className="button primary" type="button" onClick={beginCreate}>
                  新建队伍
                </button>
              )}
            </div>
          )}
          {archivedParties.length > 0 && (
            <details className="archived-party-list">
              <summary>已归档队伍 ({archivedParties.length})</summary>
              {archivedParties.map((party) => (
                <div className="archived-party-row" key={party.id}>
                  <strong>{party.name}</strong>
                  <span>
                    {party.type === 'FIXED' ? '固定' : '临时'} · {party.members.length} 位成员
                  </span>
                </div>
              ))}
            </details>
          )}
        </section>

        {(creating || editingId) && (
          <form className="form-card party-editor" onSubmit={(event) => void submit(event)}>
            <div className="form-title-row">
              <div>
                <p className="eyebrow">PARTY CONFIGURATION</p>
                <h2>{creating ? '创建队伍' : '编辑队伍'}</h2>
                <p className="muted-copy">新 Mission 只能使用由可用持久道友组成的队伍。</p>
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
                placeholder="例如：研究小队"
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
                placeholder="这支队伍适合处理什么任务？"
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
                  setForm((current) => ({ ...current, coordinatorTeammateId: event.target.value }))
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
              disabled={busy || !form.name.trim() || form.memberTeammateIds.length < 2}
            >
              {busy ? '保存中…' : '保存队伍'}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
