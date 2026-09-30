import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DynamicCapabilityPanel } from '.././r1-capability.js';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import { errorText, PageHeading, safeLabel, EmptyList, formatDate } from '../ui-shared.js';
import type {
  RuntimeProfileView,
  TeammateView,
  SkillView,
  SkillAssignmentView,
  ExperienceType,
  ExperienceOutcome,
  TeammateExperienceView,
  MissionMode,
} from '../ui-shared.js';

interface TeammateForm {
  name: string;
  avatar: string;
  title: string;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
  currentRuntimeProfileId: string;
}

const blankTeammate: TeammateForm = {
  name: '',
  avatar: '友',
  title: '',
  description: '',
  identityPrompt: '',
  behaviorPrompt: '',
  currentRuntimeProfileId: '',
};

export function TeammatesPage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState<TeammateForm>(blankTeammate);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [teammateRows, runtimeRows] = await Promise.all([
        window.cultivation.teammates.list(),
        window.cultivation.runtimes.list(),
      ]);
      setTeammates(teammateRows);
      setRuntimes(runtimeRows);
      setSelectedId(
        (current) => current || teammateRows.find((item) => item.status === 'ACTIVE')?.id || '',
      );
    } catch (cause) {
      setError(errorText(cause, '读取道友失败。'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const selected = teammates.find((item) => item.id === selectedId);
  const startCreate = () => {
    setEditingId('');
    setForm({ ...blankTeammate, currentRuntimeProfileId: runtimes[0]?.id ?? '' });
    setError('');
    setNotice('');
  };
  const startEdit = (teammate: TeammateView) => {
    setSelectedId(teammate.id);
    setEditingId(teammate.id);
    setForm({
      name: teammate.name,
      avatar: teammate.avatar ?? '',
      title: teammate.title ?? '',
      description: teammate.description,
      identityPrompt: teammate.identityPrompt,
      behaviorPrompt: teammate.behaviorPrompt,
      currentRuntimeProfileId: teammate.currentRuntimeProfileId ?? '',
    });
    setError('');
    setNotice('');
  };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        avatar: form.avatar.trim() || null,
        title: form.title.trim() || null,
      };
      const saved = editingId
        ? await window.cultivation.teammates.update({ id: editingId, ...payload })
        : await window.cultivation.teammates.create(payload);
      setSelectedId(saved.id);
      setEditingId('');
      setForm(blankTeammate);
      setNotice(editingId ? '道友资料已保存。' : '道友已创建。');
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '保存道友失败。'));
    } finally {
      setBusy(false);
    }
  };
  const archive = async (teammate: TeammateView) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const archived = await window.cultivation.teammates.archive(teammate.id);
      setSelectedId(archived.id);
      setNotice(`${teammate.name} 已归档；身份与历史记录仍保留。`);
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '归档道友失败。'));
    } finally {
      setBusy(false);
    }
  };
  const duplicate = async (teammate: TeammateView) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const copy = await window.cultivation.teammates.duplicate(teammate.id);
      setSelectedId(copy.id);
      setNotice(`已复制为「${copy.name}」，新的道友 ID 与原道友不同。`);
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '复制道友失败。'));
    } finally {
      setBusy(false);
    }
  };
  const updateForm = (patch: Partial<TeammateForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <section className="page wide-page">
      <PageHeading
        eyebrow="道友档案 · Teammate"
        title="道友 Teammates"
        description="普通道友创建时验证并封存 Provider、Endpoint 和 Model；如需其他模型，请创建新道友。"
      />
      {error && (
        <div className="notice error notice-with-action" role="alert">
          {error}
          <button className="text-button" type="button" onClick={() => void refresh()}>
            重新读取
          </button>
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      <div className="teammate-workspace">
        <aside className="teammate-list-card">
          <div className="list-heading">
            <div>
              <h2>道友</h2>
              <p>{teammates.filter((item) => item.status === 'ACTIVE').length} 位活跃</p>
            </div>
            <button className="icon-button" aria-label="创建道友" onClick={startCreate}>
              ＋
            </button>
          </div>
          {loading ? (
            <div className="list-empty">读取中…</div>
          ) : error && teammates.length === 0 ? (
            <div className="list-empty">列表读取失败；可使用上方“重新读取”重试。</div>
          ) : teammates.length ? (
            teammates.map((teammate) => (
              <button
                key={teammate.id}
                className={`teammate-list-item ${selectedId === teammate.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(teammate.id);
                  setEditingId('');
                  setForm(blankTeammate);
                }}
              >
                <span className="avatar small-avatar">
                  {teammate.avatar || teammate.name.slice(0, 1)}
                </span>
                <span className="data-row-copy">
                  <strong>{teammate.name}</strong>
                  <small>{teammate.title || '道友'}</small>
                  {teammate.executorKind === 'USER_BRIDGE' && <small>本尊 · Human Bridge</small>}
                </span>
                <span
                  className={`status-pill ${teammate.status === 'ACTIVE' ? 'active' : 'archived'}`}
                >
                  {teammate.status === 'ACTIVE' ? '活跃' : '归档'}
                </span>
              </button>
            ))
          ) : (
            <EmptyList text="尚无道友。" />
          )}
          <button className="button secondary full-width" onClick={startCreate}>
            ＋ 创建道友
          </button>
        </aside>
        <div className="teammate-detail">
          {editingId || (!selected && !loading) ? (
            <form className="form-card teammate-form" onSubmit={(event) => void save(event)}>
              <div className="form-title-row">
                <div>
                  <p className="eyebrow">{editingId ? 'EDIT TEAMMATE' : 'NEW TEAMMATE'}</p>
                  <h2>{editingId ? '编辑道友' : '创建道友'}</h2>
                </div>
                {editingId && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setEditingId('');
                      setForm(blankTeammate);
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>名称</span>
                  <input
                    required
                    maxLength={80}
                    value={form.name}
                    onChange={(event) => updateForm({ name: event.target.value })}
                    placeholder="例如：青岚"
                  />
                </label>
                <label className="field">
                  <span>头像标记</span>
                  <input
                    maxLength={8}
                    value={form.avatar}
                    onChange={(event) => updateForm({ avatar: event.target.value })}
                    placeholder="友"
                  />
                </label>
              </div>
              <label className="field">
                <span>称号</span>
                <input
                  maxLength={100}
                  value={form.title}
                  onChange={(event) => updateForm({ title: event.target.value })}
                  placeholder="例如：研究搭档"
                />
              </label>
              <label className="field">
                <span>介绍</span>
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={form.description}
                  onChange={(event) => updateForm({ description: event.target.value })}
                  placeholder="简单描述道友的定位"
                />
              </label>
              <label className="field">
                <span>Identity Prompt</span>
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={form.identityPrompt}
                  onChange={(event) => updateForm({ identityPrompt: event.target.value })}
                  placeholder="定义稳定的身份、背景与表达方式"
                />
              </label>
              <label className="field">
                <span>Behavior Prompt</span>
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={form.behaviorPrompt}
                  onChange={(event) => updateForm({ behaviorPrompt: event.target.value })}
                  placeholder="定义回答习惯与协作偏好"
                />
              </label>
              {editingId ? (
                <p className="form-hint">
                  模型身份已固定：
                  {runtimes.find((runtime) => runtime.id === form.currentRuntimeProfileId)
                    ?.modelId ?? 'Runtime 不可用'}
                  。更换模型请新建道友。
                </p>
              ) : (
                <label className="field">
                  <span>Runtime Profile（创建后固定模型）</span>
                  <select
                    required
                    value={form.currentRuntimeProfileId}
                    onChange={(event) =>
                      updateForm({ currentRuntimeProfileId: event.target.value })
                    }
                  >
                    <option value="">选择运行配置</option>
                    {runtimes.map((runtime) => (
                      <option key={runtime.id} value={runtime.id}>
                        {runtime.name} · {runtime.modelId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!runtimes.length && (
                <div className="prerequisite-note">
                  <p className="form-hint">
                    需要先添加 Provider、Credential，再创建 Runtime Profile。
                  </p>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => navigate('/settings')}
                  >
                    前往 Settings 配置
                  </button>
                </div>
              )}
              <button className="button primary" disabled={busy || !runtimes.length}>
                {busy ? '保存中…' : editingId ? '保存道友' : '创建道友'}
              </button>
            </form>
          ) : selected ? (
            <div className="profile-card">
              <div className="profile-top">
                <span className="avatar profile-avatar">
                  {selected.avatar || selected.name.slice(0, 1)}
                </span>
                <div className="profile-main">
                  <div className="profile-name-row">
                    <h2>{selected.name}</h2>
                    <span
                      className={`status-pill ${selected.status === 'ACTIVE' ? 'active' : 'archived'}`}
                    >
                      {selected.status === 'ACTIVE' ? '活跃' : '归档'}
                    </span>
                  </div>
                  <p>
                    {selected.title || '道友'}
                    {selected.description ? ` · ${selected.description}` : ''}
                  </p>
                </div>
              </div>
              <div className="identity-panel">
                <span>稳定身份 ID</span>
                <code>{selected.id}</code>
                <small>
                  {selected.executorKind === 'USER_BRIDGE'
                    ? '系统 Human Bridge 不绑定模型 Runtime，仅在明确委托的外部工作中执行。'
                    : '此身份及模型绑定长期保持；Conversation 历史归属于此道友。'}
                </small>
              </div>
              {selected.executorKind !== 'USER_BRIDGE' && (
                <div className="profile-section">
                  <div className="section-heading">
                    <div>
                      <h3>固定模型绑定</h3>
                      <p>Provider、Endpoint 与 Model 已封存；Credential 可安全轮换。</p>
                    </div>
                  </div>
                  <p className="form-hint">
                    {runtimes.find((runtime) => runtime.id === selected.currentRuntimeProfileId)
                      ?.modelId ?? 'Runtime 不可用'}
                  </p>
                  <AvailabilityBadge teammateId={selected.id} />
                </div>
              )}
              <div className="profile-actions">
                {selected.executorKind === 'USER_BRIDGE' ? (
                  <button className="button primary" onClick={() => navigate('/external-work')}>
                    查看本尊待办与能力
                  </button>
                ) : (
                  selected.status === 'ACTIVE' && (
                    <button
                      className="button primary"
                      onClick={() => navigate(`/chat/${encodeURIComponent(selected.id)}`)}
                    >
                      打开对话
                    </button>
                  )
                )}
                {selected.executorKind !== 'USER_BRIDGE' && (
                  <button className="button secondary" onClick={() => startEdit(selected)}>
                    编辑资料
                  </button>
                )}
                {selected.executorKind !== 'USER_BRIDGE' && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void duplicate(selected)}
                  >
                    复制道友
                  </button>
                )}
                {selected.executorKind !== 'USER_BRIDGE' && selected.status === 'ACTIVE' && (
                  <button
                    className="button danger-ghost"
                    disabled={busy}
                    onClick={() => void archive(selected)}
                  >
                    归档
                  </button>
                )}
              </div>
              {selected.status === 'ARCHIVED' && (
                <div className="notice">已归档的道友保留历史数据，不能继续发送新消息。</div>
              )}
              {selected.executorKind !== 'USER_BRIDGE' && (
                <TeammateSkillsPanel teammate={selected} />
              )}
              {selected.executorKind !== 'USER_BRIDGE' && (
                <DynamicCapabilityPanel
                  key={`${selected.id}:${selected.currentRuntimeProfileId}`}
                  teammateId={selected.id}
                />
              )}
              <TeammateExperiencePanel teammate={selected} />
            </div>
          ) : loading ? (
            <div className="loading-card">正在读取道友…</div>
          ) : (
            <div className="empty-card">
              <h3>选择或创建道友</h3>
              <p>创建时选择并验证模型；成功后模型身份固定。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function TeammateSkillsPanel({ teammate }: { teammate: TeammateView }) {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [assignments, setAssignments] = useState<SkillAssignmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busySkillId, setBusySkillId] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [skillRows, assignmentRows] = await Promise.all([
        window.cultivation.skills.list(),
        window.cultivation.skills.listAssignments(teammate.id),
      ]);
      setSkills(skillRows);
      setAssignments(assignmentRows.filter((item) => item.teammateId === teammate.id));
    } catch (cause) {
      setError(errorText(cause, '读取道友 Skill 分配失败。'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [teammate.id]);

  const assign = async (skillId: string) => {
    setBusySkillId(skillId);
    setError('');
    try {
      await window.cultivation.skills.assign({ teammateId: teammate.id, skillId });
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '分配 Skill 失败。'));
    } finally {
      setBusySkillId('');
    }
  };
  const unassign = async (skillId: string) => {
    setBusySkillId(skillId);
    setError('');
    try {
      await window.cultivation.skills.unassign({ teammateId: teammate.id, skillId });
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '取消分配 Skill 失败。'));
    } finally {
      setBusySkillId('');
    }
  };
  const setEnabled = async (skillId: string, enabled: boolean) => {
    setBusySkillId(skillId);
    setError('');
    try {
      await window.cultivation.skills.setEnabled({ teammateId: teammate.id, skillId, enabled });
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '更新 Skill 启用状态失败。'));
    } finally {
      setBusySkillId('');
    }
  };

  return (
    <div className="profile-section teammate-skill-section">
      <div className="section-heading">
        <div>
          <h3>此道友的 Skills</h3>
          <p>分配和启用状态仅属于 {teammate.name}。</p>
        </div>
        <span className="count-badge">{assignments.length}</span>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="loading-card">正在读取 Skill 分配…</div>
      ) : skills.filter((skill) => skill.status === 'ACTIVE').length ? (
        <div className="teammate-skill-list">
          {skills
            .filter((skill) => skill.status === 'ACTIVE')
            .map((skill) => {
              const assignment = assignments.find((item) => item.skillId === skill.id);
              return (
                <div className="teammate-skill-row" key={skill.id}>
                  <div className="teammate-skill-copy">
                    <strong>{skill.name}</strong>
                    <small>
                      v{skill.version} · {skill.description || '无说明'}
                    </small>
                  </div>
                  {assignment ? (
                    <div className="teammate-skill-controls">
                      <label className="skill-toggle">
                        <input
                          type="checkbox"
                          checked={assignment.enabled}
                          disabled={busySkillId === skill.id}
                          onChange={(event) => void setEnabled(skill.id, event.target.checked)}
                        />
                        <span>{assignment.enabled ? '已启用' : '已停用'}</span>
                      </label>
                      <button
                        className="text-button"
                        disabled={busySkillId === skill.id}
                        onClick={() => void unassign(skill.id)}
                      >
                        取消分配
                      </button>
                    </div>
                  ) : (
                    <button
                      className="button secondary small"
                      disabled={busySkillId === skill.id || teammate.status !== 'ACTIVE'}
                      onClick={() => void assign(skill.id)}
                    >
                      分配给此道友
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      ) : (
        <p className="form-hint">还没有可分配的 Skill。先在 Skills 页面创建。</p>
      )}
      <p className="form-hint">只有此处已启用的 Skill 会进入这位道友的 Prompt。</p>
    </div>
  );
}

export function TeammateExperiencePanel({ teammate }: { teammate: TeammateView }) {
  const [experience, setExperience] = useState<TeammateExperienceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setExperience(null);
    setLoading(true);
    setError('');
    const getExperience = window.cultivation?.experience?.get;
    if (typeof getExperience !== 'function') {
      setError('经历记录接口尚未连接。请重启应用后重试。');
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void getExperience(teammate.id)
      .then((result) => {
        if (!cancelled) setExperience(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取经历记录失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teammate.id, refreshKey]);

  const profile = experience?.profile;
  const metrics = profile
    ? ([
        ['已完成 Mission', profile.completedMissions],
        ['失败 Mission', profile.failedMissions],
        ['已取消 Mission', profile.cancelledMissions],
        ['咨询参与', profile.consultationParticipations],
        ['审查参与', profile.reviewParticipations],
        ['委托参与', profile.delegationParticipations],
        ['工具使用', profile.toolUses],
        ['已完成协作', profile.completedCollaborations],
        ['Skill 使用', profile.skillUses],
      ] as const)
    : [];

  return (
    <section className="profile-section experience-panel" aria-labelledby="experience-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">可核验记录 · Activity profile</p>
          <h3 id="experience-title">经历 / 能力</h3>
          <p>炼气 · 正式能力考核尚未开启</p>
        </div>
        <button
          className="button ghost small"
          type="button"
          disabled={loading}
          onClick={() => setRefreshKey((current) => current + 1)}
        >
          刷新记录
        </button>
      </div>
      <p className="experience-note">
        这里只汇总 Mission 结果、协作、工具和 Skill 的实际记录，不评等级或分数，也不会自动改变境界。
      </p>
      {error && (
        <div className="notice error notice-with-action" role="alert">
          {error}
          <button
            className="text-button"
            type="button"
            disabled={loading}
            onClick={() => setRefreshKey((current) => current + 1)}
          >
            重试
          </button>
        </div>
      )}
      {loading ? (
        <div className="loading-card">正在读取经历记录…</div>
      ) : profile ? (
        <>
          <div className="experience-metrics">
            {metrics.map(([label, value]) => (
              <div className="experience-metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <p className="experience-last-active">
            最近活动：{profile.lastActiveAt ? formatDate(profile.lastActiveAt) : '暂无活动记录'}
          </p>
          <div className="experience-event-heading">
            <h4>近期经历来源</h4>
            <span>{experience.events.length} 条</span>
          </div>
          {experience.events.length ? (
            <ol className="experience-event-list">
              {experience.events
                .slice()
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                .slice(0, 12)
                .map((event) => (
                  <li className="experience-event" key={event.id}>
                    <div className="experience-event-top">
                      <strong>{experienceTypeLabel(event.experienceType)}</strong>
                      <span className={`experience-outcome outcome-${event.outcome.toLowerCase()}`}>
                        {experienceOutcomeLabel(event.outcome)}
                      </span>
                      <time>{formatDate(event.createdAt)}</time>
                    </div>
                    <div className="experience-provenance">
                      <span>模式：{experienceModeLabel(event.mode)}</span>
                      <span>角色：{safeLabel(event.role)}</span>
                      <span>
                        来源：{safeLabel(event.source)} · <code>{event.sourceId || '—'}</code>
                      </span>
                      <span>
                        Mission <code>{event.missionId || '—'}</code> · Run{' '}
                        <code>{event.runId || '—'}</code>
                      </span>
                    </div>
                  </li>
                ))}
            </ol>
          ) : (
            <div className="experience-empty">
              尚无可核验的任务、协作、工具或 Skill 使用记录；完成相关操作后，这里会显示记录来源。
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

export function experienceTypeLabel(type: ExperienceType): string {
  const labels: Record<ExperienceType, string> = {
    MISSION_RESULT: 'Mission 结果',
    COLLABORATION: '队伍协作',
    TOOL_USE: '工具使用',
    SKILL_USE: 'Skill 使用',
    EXTERNAL_WORK: '本尊外部工作',
  };
  return labels[type];
}

export function experienceOutcomeLabel(outcome: ExperienceOutcome): string {
  const labels: Record<ExperienceOutcome, string> = {
    COMPLETED: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
    INTERRUPTED: '中断',
  };
  return labels[outcome];
}

export function experienceModeLabel(mode: MissionMode): string {
  const labels: Record<MissionMode, string> = {
    SOLO: '单人 SOLO',
    CONSULTATION: '咨询',
    REVIEW: '审查',
    DELEGATION: '委托',
  };
  return labels[mode] ?? safeLabel(mode);
}
