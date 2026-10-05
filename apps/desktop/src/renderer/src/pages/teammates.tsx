import { Switch } from '../components/Switch.js';
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { AvatarPicker } from '../components/AvatarPicker.js';
import { Drawer } from '../components/Drawer.js';
import { Icon } from '../components/Icon.js';
import { CreateTeammatePanel } from './create-teammate.js';
import { DynamicCapabilityPanel } from '../r1-capability.js';
import { AvailabilityBadge } from '../r3-2-availability.js';
import { errorText, formatDate, missionStateLabel, PageHeading, safeLabel } from '../ui-shared.js';
import type {
  ExperienceOutcome,
  ExperienceType,
  MissionMode,
  ProviderView,
  RuntimeProfileView,
  SkillAssignmentView,
  SkillView,
  TeammateExperienceView,
  TeammateView,
} from '../ui-shared.js';
import './teammates.css';

interface TeammateForm {
  name: string;
  avatar: string;
  title: string;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
}

const blankTeammate: TeammateForm = {
  name: '',
  avatar: 'preset:01',
  title: '',
  description: '',
  identityPrompt: '',
  behaviorPrompt: '',
};

export function TeammatesPage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState<TeammateForm>(blankTeammate);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
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
      setSelectedId((current) =>
        teammateRows.some((item) => item.id === current)
          ? current
          : (teammateRows.find((item) => item.status === 'ACTIVE')?.id ?? ''),
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

  useEffect(() => {
    if (searchParams.get('create') === '1') setCreating(true);
  }, [searchParams]);

  const selected = teammates.find((item) => item.id === selectedId);
  const isGeneration = (teammate: TeammateView) =>
    runtimes.some(
      (runtime) =>
        runtime.id === teammate.currentRuntimeProfileId &&
        runtime.executionProtocol === 'GENERATION',
    );
  const selectedRuntime = selected?.currentRuntimeProfileId
    ? runtimes.find((runtime) => runtime.id === selected.currentRuntimeProfileId)
    : undefined;
  const selectedProvider = selectedRuntime
    ? providers.find((provider) => provider.id === selectedRuntime.providerId)
    : undefined;

  const setCreateQuery = (enabled: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (enabled) next.set('create', '1');
    else next.delete('create');
    setSearchParams(next, { replace: true });
  };

  const startCreate = () => {
    setEditingId('');
    setCreating(true);
    setError('');
    setNotice('');
    setCreateQuery(true);
  };

  const closeCreate = () => {
    setCreating(false);
    setCreateQuery(false);
  };

  const startEdit = (teammate: TeammateView) => {
    setCreating(false);
    setSelectedId(teammate.id);
    setEditingId(teammate.id);
    setForm({
      name: teammate.name,
      avatar: teammate.avatar ?? 'preset:01',
      title: teammate.title ?? '',
      description: teammate.description,
      identityPrompt: teammate.identityPrompt,
      behaviorPrompt: teammate.behaviorPrompt,
    });
    setError('');
    setNotice('');
  };

  const updateForm = (patch: Partial<TeammateForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  const saveEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await window.cultivation.teammates.update({
        id: editingId,
        name: form.name.trim(),
        avatar: form.avatar.trim() || null,
        title: form.title.trim() || null,
        description: form.description.trim(),
        identityPrompt: form.identityPrompt.trim(),
        behaviorPrompt: form.behaviorPrompt.trim(),
        currentRuntimeProfileId:
          teammates.find((item) => item.id === editingId)?.currentRuntimeProfileId ?? null,
      });
      setSelectedId(saved.id);
      setEditingId('');
      setForm(blankTeammate);
      setNotice('道友资料已保存。');
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '保存道友资料失败。'));
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
      setNotice('道友已归档；身份与历史记录仍保留。');
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
      setNotice('已复制为「' + copy.name + '」，新的道友将重新完成连接检测。');
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '复制道友失败。'));
    } finally {
      setBusy(false);
    }
  };

  const completeCreate = async (teammate: TeammateView) => {
    setSelectedId(teammate.id);
    setNotice('道友已创建。');
    closeCreate();
    await refresh();
  };

  const modelSummary = (teammate: TeammateView) => {
    if (teammate.executorKind === 'USER_BRIDGE') return 'Human Bridge';
    const runtime = runtimes.find((item) => item.id === teammate.currentRuntimeProfileId);
    const provider = runtime ? providers.find((item) => item.id === runtime.providerId) : undefined;
    return [provider?.name, runtime?.modelId].filter(Boolean).join(' · ') || '模型未配置';
  };

  return (
    <section className="page wide-page teammates-page">
      <PageHeading eyebrow="" title="道友" description="" />
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

      <div className={`teammate-workspace ${mobileDetail ? 'detail-open' : ''}`}>
        <aside className="teammate-roster" aria-label="道友名单">
          <div className="teammate-roster-heading">
            <div>
              <h2>名单</h2>
              <span>{teammates.length} 位</span>
            </div>
            <button
              className="button secondary small"
              type="button"
              onClick={startCreate}
              aria-label="创建道友"
            >
              <Icon name="Add" size={16} /> 新建
            </button>
          </div>
          {loading ? (
            <div className="teammate-list-state">正在读取…</div>
          ) : error && teammates.length === 0 ? (
            <div className="teammate-list-state">名单暂时无法读取。</div>
          ) : teammates.length ? (
            <div className="teammate-roster-list">
              {teammates.map((teammate) => {
                const archived = teammate.status === 'ARCHIVED';
                const human = teammate.executorKind === 'USER_BRIDGE';
                return (
                  <div
                    className={
                      'teammate-roster-row' + (selectedId === teammate.id ? ' selected' : '')
                    }
                    key={teammate.id}
                  >
                    <button
                      className="teammate-roster-select"
                      type="button"
                      aria-pressed={selectedId === teammate.id}
                      onClick={() => {
                        setSelectedId(teammate.id);
                        setMobileDetail(true);
                        setCreating(false);
                        setEditingId('');
                        closeCreate();
                      }}
                    >
                      <Avatar
                        avatar={teammate.avatar}
                        name={teammate.name}
                        kind={human ? 'HUMAN_BRIDGE' : 'TEAMMATE'}
                        size={42}
                      />
                      <span className="teammate-roster-copy">
                        <strong>{teammate.name}</strong>
                        <small>{modelSummary(teammate)}</small>
                      </span>
                    </button>
                    {archived ? (
                      <span className="teammate-roster-archived">已归档</span>
                    ) : human ? (
                      <span className="teammate-roster-human" aria-label="本尊，可接收委托">
                        <Icon name="HumanBridge" size={15} />
                      </span>
                    ) : isGeneration(teammate) ? (
                      <span className="product-status neutral">生成模型</span>
                    ) : (
                      <AvailabilityBadge
                        teammateId={teammate.id}
                        teammateStatus={teammate.status}
                        executorKind={teammate.executorKind ?? 'MODEL_RUNTIME'}
                        recheck={false}
                        compact
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="teammate-list-state">
              <p>还没有道友。</p>
              <button className="button primary small" type="button" onClick={startCreate}>
                <Icon name="Add" size={16} /> 创建第一位道友
              </button>
            </div>
          )}
        </aside>

        <div className="teammate-detail">
          <button
            type="button"
            className="button ghost mobile-detail-back"
            onClick={() => setMobileDetail(false)}
          >
            <Icon name="ChevronLeft" /> 道友名单
          </button>
          {selected ? (
            <article className="teammate-profile">
              <header className="teammate-profile-header">
                <div className="teammate-profile-identity">
                  <Avatar
                    avatar={selected.avatar}
                    name={selected.name}
                    kind={selected.executorKind === 'USER_BRIDGE' ? 'HUMAN_BRIDGE' : 'TEAMMATE'}
                    size={68}
                  />
                  <div className="teammate-profile-copy">
                    <h2>{selected.name}</h2>
                    {selected.title && <p className="teammate-profile-title">{selected.title}</p>}
                    {selected.executorKind === 'USER_BRIDGE' ? (
                      <p>本尊 · Human Bridge</p>
                    ) : (
                      <p>{modelSummary(selected)}</p>
                    )}
                  </div>
                </div>
                <div className="teammate-profile-state">
                  {selected.executorKind === 'USER_BRIDGE' ? (
                    <span className="teammate-human-status">
                      <Icon name="HumanBridge" size={16} /> 可接收委托
                    </span>
                  ) : selected.status === 'ARCHIVED' ? (
                    <span className="teammate-archived-status">已归档</span>
                  ) : isGeneration(selected) ? (
                    <span className="product-status neutral">生成模型</span>
                  ) : (
                    <AvailabilityBadge
                      teammateId={selected.id}
                      teammateStatus={selected.status}
                      executorKind={selected.executorKind ?? 'MODEL_RUNTIME'}
                    />
                  )}
                </div>
                <div className="teammate-profile-actions">
                  {selected.executorKind === 'USER_BRIDGE' ? (
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => navigate('/external-work')}
                    >
                      <Icon name="HumanBridge" size={16} /> 查看本尊待办
                    </button>
                  ) : selected.status === 'ACTIVE' && isGeneration(selected) ? (
                    <button
                      className="button primary"
                      type="button"
                      onClick={() =>
                        navigate(
                          '/generation?runtimeProfileId=' +
                            encodeURIComponent(selected.currentRuntimeProfileId!),
                        )
                      }
                    >
                      <Icon name="Model" size={16} /> 查看生成任务
                    </button>
                  ) : selected.status === 'ACTIVE' ? (
                    <>
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => navigate('/chat/' + encodeURIComponent(selected.id))}
                      >
                        <Icon name="Chat" size={16} /> 开始对话
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() =>
                          navigate(
                            '/missions?teammateId=' + encodeURIComponent(selected.id) + '&create=1',
                          )
                        }
                      >
                        <Icon name="Mission" size={16} /> 发起历练
                      </button>
                    </>
                  ) : null}
                  <details className="teammate-more-menu">
                    <summary className="button secondary">
                      <Icon name="More" size={16} /> 更多
                    </summary>
                    <div className="teammate-more-content">
                      {selected.executorKind !== 'USER_BRIDGE' && (
                        <div className="teammate-more-actions">
                          <button
                            className="button secondary small"
                            type="button"
                            onClick={() => startEdit(selected)}
                          >
                            <Icon name="Edit" size={15} /> 编辑资料
                          </button>
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={busy}
                            onClick={() => void duplicate(selected)}
                          >
                            <Icon name="Copy" size={15} /> 复制道友
                          </button>
                          {selected.status === 'ACTIVE' && (
                            <button
                              className="button danger-ghost small"
                              type="button"
                              disabled={busy}
                              onClick={() => void archive(selected)}
                            >
                              <Icon name="Archive" size={15} /> 归档
                            </button>
                          )}
                        </div>
                      )}
                      <details className="teammate-advanced-details">
                        <summary>高级身份与模型信息</summary>
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
                                <dd>{selectedProvider?.name ?? '未配置'}</dd>
                              </div>
                              <div>
                                <dt>Endpoint</dt>
                                <dd>{selectedProvider?.baseUrl ?? '未配置'}</dd>
                              </div>
                              <div>
                                <dt>Runtime ID</dt>
                                <dd>
                                  <code>{selected.currentRuntimeProfileId ?? '未配置'}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>Identity Prompt</dt>
                                <dd>{selected.identityPrompt || '未设置'}</dd>
                              </div>
                              <div>
                                <dt>Behavior Prompt</dt>
                                <dd>{selected.behaviorPrompt || '未设置'}</dd>
                              </div>
                            </>
                          )}
                        </dl>
                      </details>
                    </div>
                  </details>
                </div>
              </header>

              {selected.description && (
                <p className="teammate-profile-description">{selected.description}</p>
              )}

              {selected.executorKind === 'USER_BRIDGE' ? (
                <HumanBridgeSummary />
              ) : (
                <>
                  <DynamicCapabilityPanel
                    key={selected.id + ':' + selected.currentRuntimeProfileId}
                    teammateId={selected.id}
                  />
                  <TeammateSkillSummary teammate={selected} />
                </>
              )}
              <TeammateRecentActivity teammate={selected} />
              <details className="teammate-secondary-view">
                <summary>经历档案</summary>
                <TeammateExperiencePanel teammate={selected} />
              </details>
            </article>
          ) : loading ? (
            <div className="teammate-detail-state">正在读取道友…</div>
          ) : (
            <div className="teammate-detail-state teammate-detail-empty">
              <Avatar kind="TEAMMATE" name="新道友" size={64} />
              <h2>选择一位道友</h2>
              <p>查看能力、功法与最近活动。</p>
              <button className="button primary" type="button" onClick={startCreate}>
                <Icon name="Add" size={16} /> 创建道友
              </button>
            </div>
          )}
        </div>
      </div>

      <CreateTeammatePanel
        open={creating}
        initialProviders={providers}
        initialRuntimes={runtimes}
        onClose={closeCreate}
        onCreated={(teammate) => void completeCreate(teammate)}
      />

      <Drawer
        title="编辑道友"
        open={Boolean(editingId)}
        onClose={() => setEditingId('')}
        className="teammate-edit-drawer"
      >
        <form className="teammate-edit-form" onSubmit={(event) => void saveEdit(event)}>
          <div className="edit-avatar-row">
            <AvatarPicker
              value={form.avatar || null}
              onChange={(ref) => updateForm({ avatar: ref })}
              kind="TEAMMATE"
            />
          </div>
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
            <span>称号（可选）</span>
            <input
              maxLength={100}
              value={form.title}
              onChange={(event) => updateForm({ title: event.target.value })}
            />
          </label>
          <label className="field">
            <span>简介（可选）</span>
            <textarea
              rows={3}
              maxLength={4096}
              value={form.description}
              onChange={(event) => updateForm({ description: event.target.value })}
            />
          </label>
          <details className="create-advanced-identity">
            <summary>高级身份与行为设定</summary>
            <label className="field">
              <span>Identity Prompt</span>
              <textarea
                rows={4}
                maxLength={8000}
                value={form.identityPrompt}
                onChange={(event) => updateForm({ identityPrompt: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Behavior Prompt</span>
              <textarea
                rows={4}
                maxLength={8000}
                value={form.behaviorPrompt}
                onChange={(event) => updateForm({ behaviorPrompt: event.target.value })}
              />
            </label>
          </details>
          {editingId && (
            <p className="teammate-edit-fixed-model">
              固定模型：{modelSummary(teammates.find((item) => item.id === editingId)!)}
            </p>
          )}
          {error && (
            <p className="create-form-message error" role="alert">
              {error}
            </p>
          )}
          <div className="create-flow-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => setEditingId('')}
            >
              取消
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存资料'}
            </button>
          </div>
        </form>
      </Drawer>
    </section>
  );
}

function TeammateSkillSummary({ teammate }: { teammate: TeammateView }) {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [assignments, setAssignments] = useState<SkillAssignmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void Promise.all([
      window.cultivation.skills.list(),
      window.cultivation.skills.listAssignments(teammate.id),
    ])
      .then(([skillRows, assignmentRows]) => {
        if (cancelled) return;
        setSkills(skillRows);
        setAssignments(assignmentRows.filter((item) => item.teammateId === teammate.id));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取已启用功法失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teammate.id]);

  const enabled = assignments
    .filter((item) => item.enabled)
    .map((item) => skills.find((skill) => skill.id === item.skillId))
    .filter((skill): skill is SkillView => Boolean(skill && skill.status === 'ACTIVE'));

  return (
    <section className="teammate-skill-summary" aria-labelledby="teammate-skills-title">
      <div className="teammate-section-heading">
        <div>
          <h3 id="teammate-skills-title">已启用功法</h3>
        </div>
        <span className="teammate-section-count">{loading ? '…' : enabled.length}</span>
      </div>
      {error ? (
        <p className="teammate-inline-error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <p className="teammate-muted">正在读取 Skill…</p>
      ) : enabled.length ? (
        <div className="teammate-skill-chips">
          {enabled.map((skill) => (
            <span className="teammate-skill-chip" key={skill.id}>
              {skill.name}
            </span>
          ))}
        </div>
      ) : (
        <p className="teammate-muted">尚未启用 Skill。</p>
      )}
      <details className="teammate-skill-management">
        <summary>管理 Skill 分配</summary>
        <TeammateSkillsPanel teammate={teammate} />
      </details>
    </section>
  );
}

interface RecentActivity {
  id: string;
  kind: 'MISSION' | 'CHAT' | 'EXPERIENCE';
  title: string;
  detail: string;
  at: string;
  href: string;
}

function TeammateRecentActivity({ teammate }: { teammate: TeammateView }) {
  const [items, setItems] = useState<RecentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setItems([]);
    void Promise.allSettled([
      window.cultivation.missions.list(),
      window.cultivation.experience.get(teammate.id),
      window.cultivation.chat.listConversations(teammate.id),
    ]).then(async ([missionResult, experienceResult, conversationResult]) => {
      if (cancelled) return;
      const result: RecentActivity[] = [];
      const failures: string[] = [];
      const missionRows =
        missionResult.status === 'fulfilled'
          ? missionResult.value.filter((item) => item.coordinatorTeammateId === teammate.id)
          : [];
      if (missionResult.status === 'rejected') failures.push('历练');

      if (experienceResult.status === 'fulfilled') {
        for (const event of experienceResult.value.events.slice(0, 8)) {
          result.push({
            id: 'experience:' + event.id,
            kind: 'EXPERIENCE',
            title: experienceTypeLabel(event.experienceType),
            detail: experienceOutcomeLabel(event.outcome) + ' · ' + experienceModeLabel(event.mode),
            at: event.createdAt,
            href: '/missions?missionId=' + encodeURIComponent(event.missionId),
          });
        }
      } else {
        failures.push('经历');
      }

      if (conversationResult.status === 'fulfilled') {
        const recentConversations = conversationResult.value
          .slice()
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 1);
        const previews = await Promise.allSettled(
          recentConversations.map((conversation) =>
            window.cultivation.chat.listMessages({
              teammateId: teammate.id,
              conversationId: conversation.id,
            }),
          ),
        );
        if (cancelled) return;
        recentConversations.forEach((conversation, index) => {
          const messageResult = previews[index];
          const messages = messageResult?.status === 'fulfilled' ? messageResult.value : [];
          const lastMessage = messages[messages.length - 1];
          result.push({
            id: 'chat:' + conversation.id,
            kind: 'CHAT',
            title: lastMessage?.content
              ? lastMessage.content.replace(/\s+/g, ' ').slice(0, 76)
              : '新对话',
            detail: lastMessage
              ? lastMessage.role === 'USER'
                ? '最近消息'
                : '道友回复'
              : '尚无消息',
            at: conversation.updatedAt,
            href: '/chat/' + encodeURIComponent(teammate.id),
          });
        });
      } else {
        failures.push('对话');
      }

      for (const mission of missionRows) {
        result.push({
          id: 'mission:' + mission.id,
          kind: 'MISSION',
          title: mission.title,
          detail:
            missionStateLabel(mission.state) +
            ' · ' +
            mission.objective.split('\n')[0]!.slice(0, 72),
          at: mission.updatedAt,
          href: '/missions?missionId=' + encodeURIComponent(mission.id),
        });
      }
      if (!cancelled) {
        setItems(result.sort((left, right) => right.at.localeCompare(left.at)).slice(0, 8));
        if (failures.length)
          setError('部分最近记录暂时无法读取：' + [...new Set(failures)].join('、') + '。');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [teammate.id]);

  return (
    <section className="teammate-recent-activity" aria-labelledby="teammate-recent-title">
      <div className="teammate-section-heading">
        <div>
          <h3 id="teammate-recent-title">最近活动</h3>
        </div>
        <Link to="/missions">查看历练</Link>
      </div>
      {error && (
        <p className="teammate-inline-error" role="status">
          {error}
        </p>
      )}
      {loading ? (
        <p className="teammate-muted">正在读取最近记录…</p>
      ) : items.length ? (
        <ol className="teammate-activity-list">
          {items.map((item) => (
            <li key={item.id}>
              <span className={'teammate-activity-mark ' + item.kind.toLowerCase()}>
                <Icon
                  name={
                    item.kind === 'MISSION' ? 'Mission' : item.kind === 'CHAT' ? 'Chat' : 'History'
                  }
                  size={15}
                />
              </span>
              <Link to={item.href} className="teammate-activity-copy">
                <span className="teammate-activity-top">
                  <strong>{item.title}</strong>
                  <time>{formatDate(item.at)}</time>
                </span>
                <small>{item.detail}</small>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="teammate-muted">还没有历练、对话或经历记录。</p>
      )}
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
                      <Switch
                        label={'启用功法：' + skill.name}
                        showLabel={false}
                        checked={assignment.enabled}
                        disabled={busySkillId === skill.id}
                        onChange={(enabled) => void setEnabled(skill.id, enabled)}
                      />
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
          <h3 id="experience-title">经历</h3>
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
                    </div>
                    <details className="advanced-records">
                      <summary>来源记录</summary>
                      <span>
                        来源：{safeLabel(event.source)} · <code>{event.sourceId || '—'}</code>
                      </span>
                      <span>
                        Mission <code>{event.missionId || '—'}</code> · Run{' '}
                        <code>{event.runId || '—'}</code>
                      </span>
                    </details>
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
    SOLO: '单人',
    CONSULTATION: '咨询',
    REVIEW: '审查',
    DELEGATION: '委托',
  };
  return labels[mode] ?? safeLabel(mode);
}
