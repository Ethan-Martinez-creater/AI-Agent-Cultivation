import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DynamicCapabilityPanel } from '.././r1-capability.js';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import { errorText, PageHeading, safeLabel, formatDate } from '../ui-shared.js';
import './teammates.css';
import type {
  ProviderView,
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
  avatar: '',
  title: '',
  description: '',
  identityPrompt: '',
  behaviorPrompt: '',
  currentRuntimeProfileId: '',
};

export function TeammatesPage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
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
      void window.cultivation.providers.list().then(setProviders, () => setProviders([]));
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
  const selectedRuntime = selected?.currentRuntimeProfileId
    ? runtimes.find((runtime) => runtime.id === selected.currentRuntimeProfileId)
    : undefined;
  const startCreate = () => {
    setCreating(true);
    setEditingId('');
    setForm({ ...blankTeammate, currentRuntimeProfileId: runtimes[0]?.id ?? '' });
    setError('');
    setNotice('');
  };
  const startEdit = (teammate: TeammateView) => {
    setCreating(false);
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
      setCreating(false);
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
    <section className="page wide-page teammates-page">
      <PageHeading eyebrow="" title="道友 Teammates" description="" />
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
        <aside className="teammate-list-card teammate-roster">
          <div className="list-heading">
            <div>
              <h2>道友</h2>
              <p>{teammates.length}</p>
            </div>
            <button className="button secondary small" type="button" onClick={startCreate}>
              ＋ 新建道友
            </button>
          </div>
          {loading ? (
            <div className="list-empty">读取中…</div>
          ) : error && teammates.length === 0 ? (
            <div className="list-empty">列表暂时无法读取。</div>
          ) : teammates.length ? (
            <div className="teammate-roster-list">
              {teammates.map((teammate) => {
                const runtime = runtimes.find(
                  (item) => item.id === teammate.currentRuntimeProfileId,
                );
                const modelLabel =
                  teammate.executorKind === 'USER_BRIDGE' ? 'Human Bridge' : runtime?.modelId;
                return (
                  <article
                    className={`teammate-roster-row ${selectedId === teammate.id ? 'selected' : ''}`}
                    key={teammate.id}
                  >
                    <button
                      className="teammate-roster-select"
                      type="button"
                      aria-pressed={selectedId === teammate.id}
                      onClick={() => {
                        setSelectedId(teammate.id);
                        setCreating(false);
                        setEditingId('');
                        setForm(blankTeammate);
                      }}
                    >
                      <span className="avatar small-avatar">
                        {teammate.avatar || teammate.name.slice(0, 1)}
                      </span>
                      <span className="teammate-roster-copy">
                        <strong>{teammate.name}</strong>
                        <small>{modelLabel ?? '模型未配置'}</small>
                      </span>
                    </button>
                    {teammate.executorKind === 'USER_BRIDGE' ? (
                      <span
                        className="human-roster-status"
                        role="img"
                        aria-label="可接收委托"
                        title="可接收委托"
                      >
                        <span className="availability-dot available" aria-hidden="true" />
                      </span>
                    ) : (
                      <AvailabilityBadge teammateId={teammate.id} recheck={false} compact />
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="teammate-empty-list">
              <p>还没有道友</p>
              <button className="button primary small" type="button" onClick={startCreate}>
                创建道友
              </button>
            </div>
          )}
        </aside>
        <div className="teammate-detail">
          {creating || editingId ? (
            <form className="form-card teammate-form" onSubmit={(event) => void save(event)}>
              <div className="form-title-row">
                <div>
                  <h2>{editingId ? '编辑道友' : '创建道友'}</h2>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setCreating(false);
                    setEditingId('');
                    setForm(blankTeammate);
                  }}
                >
                  返回
                </button>
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>名称</span>
                  <input
                    required
                    maxLength={80}
                    value={form.name}
                    onChange={(event) => updateForm({ name: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>头像标记</span>
                  <input
                    maxLength={8}
                    value={form.avatar}
                    onChange={(event) => updateForm({ avatar: event.target.value })}
                  />
                </label>
              </div>
              <label className="field">
                <span>称号</span>
                <input
                  maxLength={100}
                  value={form.title}
                  onChange={(event) => updateForm({ title: event.target.value })}
                />
              </label>
              <label className="field">
                <span>介绍</span>
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={form.description}
                  onChange={(event) => updateForm({ description: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Identity Prompt</span>
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={form.identityPrompt}
                  onChange={(event) => updateForm({ identityPrompt: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Behavior Prompt</span>
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={form.behaviorPrompt}
                  onChange={(event) => updateForm({ behaviorPrompt: event.target.value })}
                />
              </label>
              {editingId ? (
                <p className="form-hint">
                  固定模型：
                  {runtimes.find((runtime) => runtime.id === form.currentRuntimeProfileId)
                    ?.modelId ?? 'Runtime 不可用'}
                </p>
              ) : (
                <label className="field">
                  <span>模型（创建后固定）</span>
                  <select
                    required
                    value={form.currentRuntimeProfileId}
                    onChange={(event) =>
                      updateForm({ currentRuntimeProfileId: event.target.value })
                    }
                  >
                    <option value="">选择模型</option>
                    {runtimes.map((runtime) => (
                      <option key={runtime.id} value={runtime.id}>
                        {runtime.modelId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!runtimes.length && (
                <div className="prerequisite-note">
                  <p className="form-hint">创建前先在设置中配置 Provider 和模型。</p>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => navigate('/settings')}
                  >
                    打开设置
                  </button>
                </div>
              )}
              <button className="button primary" disabled={busy || !runtimes.length}>
                {busy ? '保存中…' : editingId ? '保存' : '创建道友'}
              </button>
            </form>
          ) : selected ? (
            <article className="profile-card teammate-profile-card">
              <header className="teammate-profile-header">
                <div className="teammate-profile-identity">
                  <span className="avatar profile-avatar">
                    {selected.avatar || selected.name.slice(0, 1)}
                  </span>
                  <div className="profile-main">
                    <h2>{selected.name}</h2>
                    {selected.executorKind === 'USER_BRIDGE' ? (
                      <p>人工任务协作</p>
                    ) : (
                      <p>
                        {runtimes.find((runtime) => runtime.id === selected.currentRuntimeProfileId)
                          ?.modelId ?? '模型未配置'}
                      </p>
                    )}
                  </div>
                </div>
                <div className="teammate-profile-status">
                  {selected.executorKind === 'USER_BRIDGE' ? (
                    <span className="status-pill active">可接收委托</span>
                  ) : selected.status === 'ACTIVE' ? (
                    <AvailabilityBadge teammateId={selected.id} />
                  ) : (
                    <span className="status-pill archived">已归档</span>
                  )}
                </div>
                <div className="teammate-profile-actions">
                  {selected.executorKind === 'USER_BRIDGE' ? (
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => navigate('/external-work')}
                    >
                      查看人类任务
                    </button>
                  ) : (
                    <>
                      <button
                        className="button primary"
                        type="button"
                        disabled={selected.status !== 'ACTIVE'}
                        onClick={() => navigate(`/chat/${encodeURIComponent(selected.id)}`)}
                      >
                        开始对话
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={selected.status !== 'ACTIVE'}
                        onClick={() =>
                          navigate(
                            `/missions?teammateId=${encodeURIComponent(selected.id)}&create=1`,
                          )
                        }
                      >
                        发起历练
                      </button>
                    </>
                  )}
                  <details className="teammate-more-menu">
                    <summary className="button secondary">更多</summary>
                    <div className="teammate-more-content">
                      {selected.executorKind !== 'USER_BRIDGE' && (
                        <div className="teammate-more-actions">
                          <button
                            className="button secondary small"
                            type="button"
                            onClick={() => startEdit(selected)}
                          >
                            编辑资料
                          </button>
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={busy}
                            onClick={() => void duplicate(selected)}
                          >
                            复制道友
                          </button>
                          {selected.status === 'ACTIVE' && (
                            <button
                              className="button danger-ghost small"
                              type="button"
                              disabled={busy}
                              onClick={() => void archive(selected)}
                            >
                              归档
                            </button>
                          )}
                        </div>
                      )}
                      <details className="teammate-advanced-details">
                        <summary>高级信息</summary>
                        <dl>
                          <div>
                            <dt>道友 ID</dt>
                            <dd>
                              <code>{selected.id}</code>
                            </dd>
                          </div>
                          {selected.executorKind !== 'USER_BRIDGE' && (
                            <>
                              <div>
                                <dt>Provider</dt>
                                <dd>
                                  {providers.find(
                                    (provider) => provider.id === selectedRuntime?.providerId,
                                  )?.name ?? '未配置'}
                                </dd>
                              </div>
                              <div>
                                <dt>Endpoint</dt>
                                <dd>
                                  {providers.find(
                                    (provider) => provider.id === selectedRuntime?.providerId,
                                  )?.baseUrl ?? '未配置'}
                                </dd>
                              </div>
                              <div>
                                <dt>Runtime ID</dt>
                                <dd>
                                  <code>{selected.currentRuntimeProfileId ?? '未配置'}</code>
                                </dd>
                              </div>
                              {selected.description && (
                                <div>
                                  <dt>介绍</dt>
                                  <dd>{selected.description}</dd>
                                </div>
                              )}
                            </>
                          )}
                        </dl>
                      </details>
                    </div>
                  </details>
                </div>
              </header>
              {selected.status === 'ARCHIVED' && (
                <div className="notice">已归档的道友保留历史记录。</div>
              )}
              {selected.executorKind === 'USER_BRIDGE' ? (
                <HumanBridgeSummary />
              ) : (
                <DynamicCapabilityPanel
                  key={`${selected.id}:${selected.currentRuntimeProfileId}`}
                  teammateId={selected.id}
                />
              )}
              {selected.executorKind !== 'USER_BRIDGE' && (
                <details className="teammate-secondary-view">
                  <summary>Skills</summary>
                  <TeammateSkillsPanel teammate={selected} />
                </details>
              )}
              <details className="teammate-secondary-view">
                <summary>经历</summary>
                <TeammateExperiencePanel teammate={selected} />
              </details>
            </article>
          ) : loading ? (
            <div className="loading-card">正在读取道友…</div>
          ) : (
            <div className="empty-card teammate-detail-empty">
              <h2>选择或创建道友</h2>
              <button className="button primary" type="button" onClick={startCreate}>
                创建道友
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const humanCapabilityLabels: Record<string, string> = {
  GENERAL_REASONING: '通用推理',
  LONG_CONTEXT_REASONING: '长上下文',
  AGENTIC_EXECUTION: '任务执行',
  CODING: '编程',
  TOOL_USE: '工具使用',
  VISUAL_UNDERSTANDING: '视觉理解',
  IMAGE_GENERATION: '图像生成',
  IMAGE_EDITING: '图像编辑',
  VIDEO_GENERATION: '视频生成',
  VIDEO_EDITING: '视频编辑',
  SPEECH_UNDERSTANDING: '语音理解',
  SPEECH_GENERATION: '语音生成',
  SPEECH_TO_SPEECH: '语音转换',
  MUSIC_GENERATION: '音乐生成',
};

function HumanBridgeSummary() {
  const [enabledCapabilities, setEnabledCapabilities] = useState<string[]>([]);
  const [openTaskCount, setOpenTaskCount] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.cultivation.r2.bridgeProfile(), window.cultivation.r2.listRequests()])
      .then(([profile, requests]) => {
        if (cancelled) return;
        setEnabledCapabilities(
          profile.dimensions.filter((item) => item.enabled).map((item) => item.dimension),
        );
        const activeStates = new Set(['PENDING', 'IN_PROGRESS', 'SUBMITTED', 'REJECTED']);
        setOpenTaskCount(requests.filter((request) => activeStates.has(request.state)).length);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取本尊能力和任务失败。'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="human-bridge-summary" aria-label="Human Bridge 能力与任务">
      <div className="human-bridge-summary-heading">
        <h3>可接手能力</h3>
        <span>{openTaskCount === null ? '…' : `${openTaskCount} 项待处理任务`}</span>
      </div>
      {error ? (
        <p className="inline-message error" role="alert">
          {error}
        </p>
      ) : enabledCapabilities.length ? (
        <div className="human-capability-list">
          {enabledCapabilities.map((dimension) => (
            <span className="human-capability-chip" key={dimension}>
              {humanCapabilityLabels[dimension] ?? safeLabel(dimension)}
            </span>
          ))}
        </div>
      ) : (
        <p className="human-bridge-summary-empty">尚未启用能力</p>
      )}
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
