import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { Drawer } from '../components/Drawer.js';
import { EmptyState } from '../components/EmptyState.js';
import { Icon } from '../components/Icon.js';
import './product-pages.css';
import { memoryTypes, blankMemoryForm, errorText, PageHeading, formatDate } from '../ui-shared.js';
import type {
  TeammateView,
  MemoryType,
  MemoryStatus,
  MemoryView,
  MemoryForm,
} from '../ui-shared.js';

const memoryTypeNames: Record<MemoryType, string> = {
  IDENTITY: '身份',
  PREFERENCE: '偏好',
  FACT: '事实',
  EPISODE: '经历',
  PROCEDURE: '流程',
  OBSERVATION: '观察',
};

const memoryTypeIcons: Record<MemoryType, string> = {
  IDENTITY: 'User',
  PREFERENCE: 'Settings',
  FACT: 'Memory',
  EPISODE: 'History',
  PROCEDURE: 'Skill',
  OBSERVATION: 'Review',
};

export function MemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [selectedTeammateId, setSelectedTeammateId] = useState(
    () => searchParams.get('teammateId') ?? '',
  );
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [status, setStatus] = useState<MemoryStatus | 'ALL'>('ALL');
  const [form, setForm] = useState<MemoryForm>(blankMemoryForm);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [reviewId, setReviewId] = useState('');
  const [reviewForm, setReviewForm] = useState<MemoryForm>(blankMemoryForm);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void window.cultivation.teammates
      .list()
      .then((rows) => {
        setTeammates(rows);
        setSelectedTeammateId((current) => {
          if (rows.some((row) => row.id === current)) return current;
          const preferredId = searchParams.get('teammateId');
          if (preferredId && rows.some((row) => row.id === preferredId)) return preferredId;
          return rows.find((row) => row.status === 'ACTIVE')?.id ?? rows[0]?.id ?? '';
        });
      })
      .catch((cause: unknown) => setError(errorText(cause, '读取道友失败。')));
  }, [searchParams]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selectedTeammateId) next.set('teammateId', selectedTeammateId);
    if (searchParams.get('teammateId') !== selectedTeammateId) {
      setSearchParams(next, { replace: true });
    }
  }, [selectedTeammateId, searchParams, setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    setMemories([]);
    setEditingId('');
    setReviewId('');
    setCreateOpen(false);
    if (!selectedTeammateId) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError('');
    void window.cultivation.memories
      .list(selectedTeammateId, status === 'ALL' ? undefined : status)
      .then((rows) => {
        if (!cancelled) {
          setMemories(
            rows.filter(
              (row) => row.ownerType === 'TEAMMATE' && row.ownerId === selectedTeammateId,
            ),
          );
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取道友记忆失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTeammateId, status, refreshKey]);

  const selectedTeammate = teammates.find((item) => item.id === selectedTeammateId);
  const editingMemory = memories.find((memory) => memory.id === editingId);
  const reviewingMemory = memories.find((memory) => memory.id === reviewId);
  const updateForm = (patch: Partial<MemoryForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const updateReviewForm = (patch: Partial<MemoryForm>) =>
    setReviewForm((current) => ({ ...current, ...patch }));
  const refresh = () => setRefreshKey((current) => current + 1);

  const createMemory = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTeammateId) return;
    setBusyId('create');
    setError('');
    setNotice('');
    try {
      await window.cultivation.memories.create({
        teammateId: selectedTeammateId,
        ...form,
      });
      setForm(blankMemoryForm);
      setCreateOpen(false);
      setNotice(`记忆已保存到 ${selectedTeammate?.name ?? '当前道友'} 的专属空间。`);
      refresh();
    } catch (cause) {
      setError(errorText(cause, '创建记忆失败。'));
    } finally {
      setBusyId('');
    }
  };

  const beginEdit = (memory: MemoryView) => {
    setReviewId('');
    setEditingId(memory.id);
    setForm({
      memoryType: memory.memoryType,
      content: memory.content,
      summary: memory.summary,
      importance: memory.importance,
    });
  };

  const saveEdit = async (memory: MemoryView) => {
    setBusyId(memory.id);
    setError('');
    try {
      await window.cultivation.memories.update({
        teammateId: selectedTeammateId,
        id: memory.id,
        ...form,
      });
      setEditingId('');
      setNotice('记忆已更新。');
      refresh();
    } catch (cause) {
      setError(errorText(cause, '更新记忆失败。'));
    } finally {
      setBusyId('');
    }
  };

  const archiveMemory = async (memory: MemoryView) => {
    setBusyId(memory.id);
    setError('');
    try {
      await window.cultivation.memories.archive({ teammateId: selectedTeammateId, id: memory.id });
      setNotice('记忆已归档，不再参与检索。');
      refresh();
    } catch (cause) {
      setError(errorText(cause, '归档记忆失败。'));
    } finally {
      setBusyId('');
    }
  };

  const startReview = (memory: MemoryView) => {
    setEditingId('');
    setReviewId(memory.id);
    setReviewForm({
      memoryType: memory.memoryType,
      content: memory.content,
      summary: memory.summary,
      importance: memory.importance,
    });
  };

  const acceptCandidate = async (memory: MemoryView, edited: boolean) => {
    setBusyId(memory.id);
    setError('');
    try {
      await window.cultivation.memories.accept({
        teammateId: selectedTeammateId,
        id: memory.id,
        ...(edited ? { edits: reviewForm } : {}),
      });
      setReviewId('');
      setNotice('候选已由你确认，现可参与此道友的记忆检索。');
      refresh();
    } catch (cause) {
      setError(errorText(cause, '确认记忆候选失败。'));
    } finally {
      setBusyId('');
    }
  };

  const saveCandidateEdit = async (memory: MemoryView) => {
    setBusyId(memory.id);
    setError('');
    try {
      await window.cultivation.memories.update({
        teammateId: selectedTeammateId,
        id: memory.id,
        ...reviewForm,
      });
      setReviewId('');
      setNotice('候选修改已保存，仍保持待确认状态。');
      refresh();
    } catch (cause) {
      setError(errorText(cause, '保存候选修改失败。'));
    } finally {
      setBusyId('');
    }
  };

  const rejectCandidate = async (memory: MemoryView) => {
    setBusyId(memory.id);
    setError('');
    try {
      await window.cultivation.memories.reject({ teammateId: selectedTeammateId, id: memory.id });
      setReviewId('');
      setNotice('候选已拒绝，不会参与检索。');
      refresh();
    } catch (cause) {
      setError(errorText(cause, '拒绝记忆候选失败。'));
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="page wide-page memory-page">
      <PageHeading eyebrow="道友记忆" title="记忆" description="按道友查看、整理并审核记忆内容。" />
      <div className="memory-toolbar memory-product-toolbar">
        <label className="field">
          <span>记忆所属道友</span>
          <select
            value={selectedTeammateId}
            onChange={(event) => setSelectedTeammateId(event.target.value)}
          >
            <option value="">选择道友</option>
            {teammates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.status === 'ACTIVE' ? '可用' : '已归档'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>筛选状态</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as MemoryStatus | 'ALL')}
          >
            <option value="ALL">全部状态</option>
            <option value="PROPOSED">待确认</option>
            <option value="ACTIVE">已激活</option>
            <option value="REJECTED">已拒绝</option>
            <option value="ARCHIVED">已归档</option>
          </select>
        </label>
        <button className="button secondary" disabled={!selectedTeammateId} onClick={refresh}>
          <Icon name="Refresh" size={16} />
          刷新
        </button>
        <button
          className="button primary"
          type="button"
          disabled={!selectedTeammateId}
          onClick={() => {
            setForm(blankMemoryForm);
            setCreateOpen(true);
          }}
        >
          <Icon name="Add" size={16} />
          新增记忆
        </button>
      </div>
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
      {!selectedTeammateId ? (
        <EmptyState icon="Memory" title="先选择一位道友" description="记忆按道友分别保存和检索。" />
      ) : (
        <>
          <div className="memory-scope-note memory-owner-summary">
            <Avatar
              avatar={selectedTeammate?.avatar}
              name={selectedTeammate?.name ?? '当前道友'}
              kind={selectedTeammate?.executorKind === 'USER_BRIDGE' ? 'HUMAN_BRIDGE' : 'TEAMMATE'}
              size={38}
            />
            <div>
              <strong>{selectedTeammate?.name ?? '当前道友'}</strong>
              <span>仅显示这位道友的专属记忆</span>
            </div>
            <details className="memory-owner-advanced">
              <summary>归属详情</summary>
              <code>{selectedTeammateId}</code>
            </details>
          </div>
          <Drawer
            title="新增记忆"
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            className="memory-editor-drawer"
          >
            <form className="memory-create-form" onSubmit={(event) => void createMemory(event)}>
              <p className="product-drawer-intro">
                新增内容会直接保存为已确认记忆，并归属于当前道友。
              </p>
              <div className="memory-form-grid">
                <label className="field">
                  <span>类型</span>
                  <select
                    value={form.memoryType}
                    onChange={(event) =>
                      updateForm({ memoryType: event.target.value as MemoryType })
                    }
                  >
                    {memoryTypes.map((item) => (
                      <option key={item.value} value={item.value}>
                        {memoryTypeNames[item.value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>重要度 · 0–1</span>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={form.importance}
                    onChange={(event) => updateForm({ importance: Number(event.target.value) })}
                  />
                </label>
                <label className="field memory-summary-field">
                  <span>摘要</span>
                  <input
                    required
                    maxLength={240}
                    value={form.summary}
                    onChange={(event) => updateForm({ summary: event.target.value })}
                  />
                </label>
              </div>
              <label className="field">
                <span>内容</span>
                <textarea
                  required
                  rows={3}
                  maxLength={8000}
                  value={form.content}
                  onChange={(event) => updateForm({ content: event.target.value })}
                />
              </label>
              <button className="button primary" disabled={busyId === 'create'}>
                {busyId === 'create' ? '保存中…' : '保存记忆'}
              </button>
            </form>
          </Drawer>
          <div className="section-heading">
            <div>
              <h2>记忆记录</h2>
            </div>
            <span className="count-badge">{memories.length}</span>
          </div>
          {loading ? (
            <div className="loading-card">正在读取记忆…</div>
          ) : memories.length ? (
            <div className="memory-list">
              {[...memories]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((memory) => {
                  const editing = editingId === memory.id;
                  const reviewing = reviewId === memory.id;
                  return (
                    <article className="memory-card memory-product-row" key={memory.id}>
                      <div className="memory-card-heading">
                        <div>
                          <span
                            className={`status-pill memory-status ${memory.status.toLowerCase()}`}
                          >
                            {memory.status === 'PROPOSED'
                              ? '待你确认'
                              : memory.status === 'ACTIVE'
                                ? '已激活'
                                : memory.status === 'REJECTED'
                                  ? '已拒绝'
                                  : '已归档'}
                          </span>
                          <span className="memory-type-label">
                            <Icon name={memoryTypeIcons[memory.memoryType]} size={15} />
                            {memoryTypeNames[memory.memoryType]}
                          </span>
                        </div>
                        <small>{formatDate(memory.createdAt)}</small>
                      </div>
                      <h3>{memory.summary}</h3>
                      <p className="memory-content-preview">{memory.content}</p>
                      <details className="memory-advanced">
                        <summary>完整内容与来源</summary>
                        <p className="memory-content-full">{memory.content}</p>
                        <dl className="memory-metadata">
                          <div>
                            <dt>来源</dt>
                            <dd>{memory.sourceType === 'MANUAL' ? '手动创建' : '对话提取'}</dd>
                          </div>
                          <div>
                            <dt>重要度</dt>
                            <dd>{memory.importance.toFixed(2)}</dd>
                          </div>
                          {memory.confidence !== null && (
                            <div>
                              <dt>提取置信度</dt>
                              <dd>{memory.confidence.toFixed(2)}</dd>
                            </div>
                          )}
                          {memory.confirmedAt && (
                            <div>
                              <dt>确认时间</dt>
                              <dd>{formatDate(memory.confirmedAt)}</dd>
                            </div>
                          )}
                          {memory.sourceConversationId && (
                            <div>
                              <dt>对话编号</dt>
                              <dd>
                                <code>{memory.sourceConversationId.slice(0, 10)}</code>
                              </dd>
                            </div>
                          )}
                          {memory.sourceMessageId && (
                            <div>
                              <dt>消息编号</dt>
                              <dd>
                                <code>{memory.sourceMessageId.slice(0, 10)}</code>
                              </dd>
                            </div>
                          )}
                          {memory.sourceId && memory.sourceId !== memory.sourceMessageId && (
                            <div>
                              <dt>来源编号</dt>
                              <dd>
                                <code>{memory.sourceId.slice(0, 10)}</code>
                              </dd>
                            </div>
                          )}
                        </dl>
                      </details>
                      <div className="button-row compact memory-actions">
                        {memory.status === 'PROPOSED' && !reviewing && (
                          <>
                            <button
                              className="button primary small"
                              disabled={busyId === memory.id}
                              onClick={() => void acceptCandidate(memory, false)}
                            >
                              接受候选
                            </button>
                            <button
                              className="button secondary small"
                              onClick={() => startReview(memory)}
                            >
                              编辑后接受
                            </button>
                            <button
                              className="button danger-ghost small"
                              disabled={busyId === memory.id}
                              onClick={() => void rejectCandidate(memory)}
                            >
                              拒绝
                            </button>
                          </>
                        )}
                        {memory.status === 'ACTIVE' && !editing && (
                          <>
                            <button
                              className="button secondary small"
                              onClick={() => beginEdit(memory)}
                            >
                              编辑
                            </button>
                            <button
                              className="button danger-ghost small"
                              disabled={busyId === memory.id}
                              onClick={() => void archiveMemory(memory)}
                            >
                              归档
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
            </div>
          ) : (
            <EmptyState
              icon="Memory"
              title="还没有符合筛选的记忆"
              description="可以新增一条记忆，也可以从对话中整理待确认内容。"
              action={
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setCreateOpen(true)}
                >
                  新增记忆
                </button>
              }
            />
          )}
          <Drawer
            title="编辑记忆"
            open={Boolean(editingId && editingMemory)}
            onClose={() => setEditingId('')}
            className="memory-editor-drawer"
          >
            {editingMemory && (
              <form
                className="memory-create-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveEdit(editingMemory);
                }}
              >
                <p className="product-drawer-intro">修改后仍只保存在当前道友的记忆空间中。</p>
                <MemoryEditFields form={form} onChange={updateForm} />
                <div className="button-row drawer-actions">
                  <button className="button primary" disabled={busyId === editingMemory.id}>
                    {busyId === editingMemory.id ? '保存中…' : '保存修改'}
                  </button>
                  <button className="button ghost" type="button" onClick={() => setEditingId('')}>
                    取消
                  </button>
                </div>
              </form>
            )}
          </Drawer>
          <Drawer
            title="审核记忆候选"
            open={Boolean(reviewId && reviewingMemory)}
            onClose={() => setReviewId('')}
            className="memory-editor-drawer"
          >
            {reviewingMemory && (
              <div className="memory-create-form">
                <p className="product-drawer-intro">
                  检查内容后再决定接受、保存修改或拒绝。只有接受的内容会进入记忆检索。
                </p>
                <MemoryEditFields form={reviewForm} onChange={updateReviewForm} />
                <div className="button-row drawer-actions memory-review-actions">
                  <button
                    className="button primary"
                    disabled={busyId === reviewingMemory.id}
                    type="button"
                    onClick={() => void acceptCandidate(reviewingMemory, true)}
                  >
                    保存并接受
                  </button>
                  <button
                    className="button secondary"
                    disabled={busyId === reviewingMemory.id}
                    type="button"
                    onClick={() => void saveCandidateEdit(reviewingMemory)}
                  >
                    保存，稍后审核
                  </button>
                  <button
                    className="button danger-ghost"
                    disabled={busyId === reviewingMemory.id}
                    type="button"
                    onClick={() => void rejectCandidate(reviewingMemory)}
                  >
                    拒绝候选
                  </button>
                </div>
              </div>
            )}
          </Drawer>
        </>
      )}
    </section>
  );
}

export function MemoryEditFields({
  form,
  onChange,
}: {
  form: MemoryForm;
  onChange: (patch: Partial<MemoryForm>) => void;
}) {
  return (
    <div className="memory-edit-fields">
      <div className="memory-form-grid">
        <label className="field">
          <span>类型</span>
          <select
            value={form.memoryType}
            onChange={(event) => onChange({ memoryType: event.target.value as MemoryType })}
          >
            {memoryTypes.map((item) => (
              <option key={item.value} value={item.value}>
                {memoryTypeNames[item.value]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>重要度 · 0–1</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={form.importance}
            onChange={(event) => onChange({ importance: Number(event.target.value) })}
          />
        </label>
        <label className="field memory-summary-field">
          <span>摘要</span>
          <input
            required
            maxLength={240}
            value={form.summary}
            onChange={(event) => onChange({ summary: event.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span>内容</span>
        <textarea
          required
          rows={3}
          maxLength={8000}
          value={form.content}
          onChange={(event) => onChange({ content: event.target.value })}
        />
      </label>
    </div>
  );
}
