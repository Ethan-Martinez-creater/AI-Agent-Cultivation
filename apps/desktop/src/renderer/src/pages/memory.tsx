import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Drawer } from '../components/Drawer.js';
import { EmptyState } from '../components/EmptyState.js';
import { Icon } from '../components/Icon.js';
import { Section } from '../components/Section.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { memoryTypes, blankMemoryForm, errorText, formatDate } from '../ui-shared.js';
import type {
  TeammateView,
  MemoryType,
  MemoryStatus,
  MemoryView,
  MemoryForm,
} from '../ui-shared.js';

type MemoryDrawerMode = 'create' | 'detail' | 'edit' | 'review' | null;

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

const memoryStatusNames: Record<MemoryStatus, string> = {
  PROPOSED: '待确认',
  ACTIVE: '已激活',
  REJECTED: '已拒绝',
  ARCHIVED: '已归档',
};

function memoryStatusTone(status: MemoryStatus): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'PROPOSED') return 'warning';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

export function MemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [selectedTeammateId, setSelectedTeammateId] = useState(
    () => searchParams.get('teammateId') ?? '',
  );
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [status, setStatus] = useState<MemoryStatus | 'ALL'>('ALL');
  const [form, setForm] = useState<MemoryForm>(blankMemoryForm);
  const [reviewForm, setReviewForm] = useState<MemoryForm>(blankMemoryForm);
  const [drawerMode, setDrawerMode] = useState<MemoryDrawerMode>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.cultivation.teammates
      .list()
      .then((rows) => {
        if (cancelled) return;
        setTeammates(rows);
        setSelectedTeammateId((current) => {
          if (rows.some((row) => row.id === current)) return current;
          const preferredId = searchParams.get('teammateId');
          if (preferredId && rows.some((row) => row.id === preferredId)) return preferredId;
          return rows.find((row) => row.status === 'ACTIVE')?.id ?? rows[0]?.id ?? '';
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取道友失败。'));
      });
    return () => {
      cancelled = true;
    };
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
    setDrawerMode(null);
    setSelectedMemoryId('');
    setError('');
    if (!selectedTeammateId) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
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
  const focusedMemory = memories.find(
    (memory) =>
      memory.id === selectedMemoryId &&
      memory.ownerType === 'TEAMMATE' &&
      memory.ownerId === selectedTeammateId,
  );
  const updateForm = (patch: Partial<MemoryForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const updateReviewForm = (patch: Partial<MemoryForm>) =>
    setReviewForm((current) => ({ ...current, ...patch }));
  const refresh = () => setRefreshKey((current) => current + 1);

  const closeDrawer = () => {
    setDrawerMode(null);
    setSelectedMemoryId('');
    setForm(blankMemoryForm);
    setReviewForm(blankMemoryForm);
  };

  const changeTeammate = (teammateId: string) => {
    closeDrawer();
    setError('');
    setNotice('');
    setSelectedTeammateId(teammateId);
  };

  const changeStatus = (nextStatus: MemoryStatus | 'ALL') => {
    closeDrawer();
    setError('');
    setNotice('');
    setStatus(nextStatus);
  };

  const openCreate = () => {
    setForm(blankMemoryForm);
    setSelectedMemoryId('');
    setError('');
    setNotice('');
    setDrawerMode('create');
  };

  const openDetail = (memory: MemoryView) => {
    setSelectedMemoryId(memory.id);
    setError('');
    setDrawerMode('detail');
  };

  const beginEdit = (memory: MemoryView) => {
    setSelectedMemoryId(memory.id);
    setForm({
      memoryType: memory.memoryType,
      content: memory.content,
      summary: memory.summary,
      importance: memory.importance,
    });
    setError('');
    setNotice('');
    setDrawerMode('edit');
  };

  const startReview = (memory: MemoryView) => {
    setSelectedMemoryId(memory.id);
    setReviewForm({
      memoryType: memory.memoryType,
      content: memory.content,
      summary: memory.summary,
      importance: memory.importance,
    });
    setError('');
    setNotice('');
    setDrawerMode('review');
  };

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
      closeDrawer();
      setNotice(`记忆已保存到 ${selectedTeammate?.name ?? '当前道友'} 的专属空间。`);
      refresh();
    } catch (cause) {
      setError(errorText(cause, '创建记忆失败。'));
    } finally {
      setBusyId('');
    }
  };

  const saveEdit = async (event: React.FormEvent<HTMLFormElement>, memory: MemoryView) => {
    event.preventDefault();
    setBusyId(memory.id);
    setError('');
    try {
      await window.cultivation.memories.update({
        teammateId: selectedTeammateId,
        id: memory.id,
        ...form,
      });
      closeDrawer();
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

  const acceptCandidate = async (memory: MemoryView, edited = false) => {
    setBusyId(memory.id);
    setError('');
    try {
      await window.cultivation.memories.accept({
        teammateId: selectedTeammateId,
        id: memory.id,
        ...(edited ? { edits: reviewForm } : {}),
      });
      closeDrawer();
      setNotice('候选已确认，现可参与此道友的记忆检索。');
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
      closeDrawer();
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
      closeDrawer();
      setNotice('候选已拒绝，不会参与检索。');
      refresh();
    } catch (cause) {
      setError(errorText(cause, '拒绝记忆候选失败。'));
    } finally {
      setBusyId('');
    }
  };

  const orderedMemories = [...memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const drawerTitle =
    drawerMode === 'create'
      ? '新增记忆'
      : drawerMode === 'edit'
        ? '编辑记忆'
        : drawerMode === 'review'
          ? '审核记忆候选'
          : (focusedMemory?.summary ?? '记忆详情');

  return (
    <section className="page wide-page memory-page management-page">
      <header className="page-heading management-heading">
        <div>
          <h1>记忆</h1>
          {selectedTeammate && <p>{selectedTeammate.name}</p>}
        </div>
        <button
          className="button primary"
          type="button"
          disabled={!selectedTeammateId}
          onClick={openCreate}
        >
          <Icon name="Add" size={16} />
          新增记忆
        </button>
      </header>

      <div className="memory-toolbar setting-group">
        <label className="field">
          <span>道友</span>
          <select
            value={selectedTeammateId}
            onChange={(event) => changeTeammate(event.target.value)}
          >
            <option value="">选择道友</option>
            {teammates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.status === 'ACTIVE' ? '启用' : '已归档'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>状态</span>
          <select
            value={status}
            onChange={(event) => changeStatus(event.target.value as MemoryStatus | 'ALL')}
          >
            <option value="ALL">全部</option>
            <option value="PROPOSED">待确认</option>
            <option value="ACTIVE">已激活</option>
            <option value="REJECTED">已拒绝</option>
            <option value="ARCHIVED">已归档</option>
          </select>
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={!selectedTeammateId || loading}
          onClick={refresh}
        >
          <Icon name="Refresh" size={16} />
          刷新
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
        <Section
          title="记忆记录"
          icon="Memory"
          action={<span className="count-badge">{memories.length}</span>}
          className="setting-group"
        >
          {loading ? (
            <div className="loading-card">正在读取记忆…</div>
          ) : orderedMemories.length ? (
            <>
              <details className="advanced-records memory-owner-record">
                <summary>归属高级记录</summary>
                <dl>
                  <div>
                    <dt>道友 ID</dt>
                    <dd>
                      <code>{selectedTeammateId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>归属类型</dt>
                    <dd>
                      <code>TEAMMATE</code>
                    </dd>
                  </div>
                </dl>
              </details>
              <div className="management-list memory-list">
                {orderedMemories.map((memory) => (
                  <article className="object-row memory-object-row" key={memory.id}>
                    <div className="object-row-heading">
                      <div className="object-row-main">
                        <h3>{memory.summary}</h3>
                        <p className="memory-content-preview">{memory.content}</p>
                      </div>
                      <StatusBadge tone={memoryStatusTone(memory.status)}>
                        {memoryStatusNames[memory.status]}
                      </StatusBadge>
                    </div>
                    <div className="object-row-meta">
                      <span>
                        <Icon name={memoryTypeIcons[memory.memoryType]} size={15} />
                        {memoryTypeNames[memory.memoryType]}
                      </span>
                      <span>{formatDate(memory.createdAt)}</span>
                    </div>
                    <div className="button-row compact object-row-actions">
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => openDetail(memory)}
                      >
                        详情
                      </button>
                      {memory.status === 'PROPOSED' && (
                        <>
                          <button
                            className="button primary small"
                            type="button"
                            disabled={busyId === memory.id}
                            onClick={() => void acceptCandidate(memory)}
                          >
                            接受
                          </button>
                          <button
                            className="button secondary small"
                            type="button"
                            onClick={() => startReview(memory)}
                          >
                            编辑候选
                          </button>
                          <button
                            className="button danger-ghost small"
                            type="button"
                            disabled={busyId === memory.id}
                            onClick={() => void rejectCandidate(memory)}
                          >
                            拒绝
                          </button>
                        </>
                      )}
                      {memory.status === 'ACTIVE' && (
                        <>
                          <button
                            className="button secondary small"
                            type="button"
                            onClick={() => beginEdit(memory)}
                          >
                            编辑
                          </button>
                          <button
                            className="button danger-ghost small"
                            type="button"
                            disabled={busyId === memory.id}
                            onClick={() => void archiveMemory(memory)}
                          >
                            归档
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              icon="Memory"
              title="还没有符合筛选的记忆"
              description="可以新增一条记忆，也可以从对话中整理待确认内容。"
              action={
                <button className="button primary" type="button" onClick={openCreate}>
                  新增记忆
                </button>
              }
            />
          )}
        </Section>
      )}

      <Drawer
        title={drawerTitle}
        open={drawerMode === 'create' || Boolean(focusedMemory)}
        onClose={closeDrawer}
        className="memory-editor-drawer management-drawer"
      >
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {drawerMode === 'create' && (
          <form className="management-form" onSubmit={(event) => void createMemory(event)}>
            <p className="form-hint">归属：{selectedTeammate?.name ?? '当前道友'}</p>
            <MemoryEditFields form={form} onChange={updateForm} />
            <div className="button-row drawer-actions">
              <button className="button primary" disabled={busyId === 'create'}>
                {busyId === 'create' ? '保存中…' : '保存记忆'}
              </button>
              <button className="button ghost" type="button" onClick={closeDrawer}>
                取消
              </button>
            </div>
          </form>
        )}
        {drawerMode === 'edit' && focusedMemory && (
          <form
            className="management-form"
            onSubmit={(event) => void saveEdit(event, focusedMemory)}
          >
            <MemoryEditFields form={form} onChange={updateForm} />
            <div className="button-row drawer-actions">
              <button className="button primary" disabled={busyId === focusedMemory.id}>
                {busyId === focusedMemory.id ? '保存中…' : '保存修改'}
              </button>
              <button className="button ghost" type="button" onClick={closeDrawer}>
                取消
              </button>
            </div>
          </form>
        )}
        {drawerMode === 'review' && focusedMemory && (
          <div className="management-form">
            <MemoryEditFields form={reviewForm} onChange={updateReviewForm} />
            <div className="button-row drawer-actions memory-review-actions">
              <button
                className="button primary"
                type="button"
                disabled={busyId === focusedMemory.id}
                onClick={() => void acceptCandidate(focusedMemory, true)}
              >
                保存并接受
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={busyId === focusedMemory.id}
                onClick={() => void saveCandidateEdit(focusedMemory)}
              >
                保存，稍后审核
              </button>
              <button
                className="button danger-ghost"
                type="button"
                disabled={busyId === focusedMemory.id}
                onClick={() => void rejectCandidate(focusedMemory)}
              >
                拒绝候选
              </button>
            </div>
          </div>
        )}
        {drawerMode === 'detail' && focusedMemory && (
          <div className="memory-detail">
            <div className="object-row-meta">
              <StatusBadge tone={memoryStatusTone(focusedMemory.status)}>
                {memoryStatusNames[focusedMemory.status]}
              </StatusBadge>
              <span>{memoryTypeNames[focusedMemory.memoryType]}</span>
              <span>{formatDate(focusedMemory.createdAt)}</span>
            </div>
            <h3>{focusedMemory.summary}</h3>
            <p className="memory-content-full">{focusedMemory.content}</p>
            <dl className="memory-metadata">
              <div>
                <dt>来源</dt>
                <dd>{focusedMemory.sourceType === 'MANUAL' ? '手动创建' : '对话提取'}</dd>
              </div>
              <div>
                <dt>重要度</dt>
                <dd>{focusedMemory.importance.toFixed(2)}</dd>
              </div>
            </dl>
            <details className="advanced-records">
              <summary>来源与标识</summary>
              <dl>
                <div>
                  <dt>记忆 ID</dt>
                  <dd>
                    <code>{focusedMemory.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>道友 ID</dt>
                  <dd>
                    <code>{focusedMemory.ownerId}</code>
                  </dd>
                </div>
                {focusedMemory.confidence !== null && (
                  <div>
                    <dt>提取置信度</dt>
                    <dd>{focusedMemory.confidence.toFixed(2)}</dd>
                  </div>
                )}
                {focusedMemory.confirmedAt && (
                  <div>
                    <dt>确认时间</dt>
                    <dd>{formatDate(focusedMemory.confirmedAt)}</dd>
                  </div>
                )}
                {focusedMemory.sourceConversationId && (
                  <div>
                    <dt>对话 ID</dt>
                    <dd>
                      <code>{focusedMemory.sourceConversationId}</code>
                    </dd>
                  </div>
                )}
                {focusedMemory.sourceMessageId && (
                  <div>
                    <dt>消息 ID</dt>
                    <dd>
                      <code>{focusedMemory.sourceMessageId}</code>
                    </dd>
                  </div>
                )}
                {focusedMemory.sourceId &&
                  focusedMemory.sourceId !== focusedMemory.sourceMessageId && (
                    <div>
                      <dt>来源 ID</dt>
                      <dd>
                        <code>{focusedMemory.sourceId}</code>
                      </dd>
                    </div>
                  )}
              </dl>
            </details>
          </div>
        )}
      </Drawer>
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
          <span>重要度</span>
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
          rows={5}
          maxLength={8000}
          value={form.content}
          onChange={(event) => onChange({ content: event.target.value })}
        />
      </label>
    </div>
  );
}
