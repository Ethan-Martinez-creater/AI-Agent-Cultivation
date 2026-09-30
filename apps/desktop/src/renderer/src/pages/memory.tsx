import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { memoryTypes, blankMemoryForm, errorText, PageHeading, formatDate } from '../ui-shared.js';
import type {
  TeammateView,
  MemoryType,
  MemoryStatus,
  MemoryView,
  MemoryForm,
} from '../ui-shared.js';

export function MemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [selectedTeammateId, setSelectedTeammateId] = useState(
    () => searchParams.get('teammateId') ?? '',
  );
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [status, setStatus] = useState<MemoryStatus | 'ALL'>('ALL');
  const [form, setForm] = useState<MemoryForm>(blankMemoryForm);
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
    <section className="page wide-page">
      <PageHeading
        eyebrow="Memory · owner scoped review"
        title="记忆 Memory"
        description="每条记忆都绑定一个具体道友。模型提取的内容仅创建 PROPOSED 候选；你确认后才会进入 ACTIVE 检索。"
      />
      <div className="memory-toolbar">
        <label className="field">
          <span>当前道友（记忆归属）</span>
          <select
            value={selectedTeammateId}
            onChange={(event) => setSelectedTeammateId(event.target.value)}
          >
            <option value="">选择道友</option>
            {teammates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.status === 'ACTIVE' ? '活跃' : '归档'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>状态</span>
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
        <div className="empty-card">
          <h3>先创建一位道友</h3>
          <p>Memory 会按道友隔离保存和检索。</p>
        </div>
      ) : (
        <>
          <div className="memory-scope-note">
            <strong>{selectedTeammate?.name ?? '当前道友'}</strong>
            <span>仅显示此道友拥有的 Memory · {selectedTeammateId.slice(0, 12)}</span>
          </div>
          <form
            className="form-card memory-create-form"
            onSubmit={(event) => void createMemory(event)}
          >
            <div className="form-title-row">
              <div>
                <p className="eyebrow">MANUAL MEMORY</p>
                <h2>添加已确认记忆</h2>
              </div>
            </div>
            <div className="memory-form-grid">
              <label className="field">
                <span>类型</span>
                <select
                  value={form.memoryType}
                  onChange={(event) => updateForm({ memoryType: event.target.value as MemoryType })}
                >
                  {memoryTypes.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
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
                    <article className="memory-card" key={memory.id}>
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
                            {memoryTypes.find((item) => item.value === memory.memoryType)?.label ??
                              memory.memoryType}
                          </span>
                        </div>
                        <small>创建于 {formatDate(memory.createdAt)}</small>
                      </div>
                      {editing ? (
                        <MemoryEditFields form={form} onChange={updateForm} />
                      ) : (
                        <>
                          <h3>{memory.summary}</h3>
                          <p className="memory-content">{memory.content}</p>
                        </>
                      )}
                      <div className="memory-provenance">
                        <span>
                          来源：{memory.sourceType === 'MANUAL' ? '手动创建' : '对话提取'}
                        </span>
                        <span>重要度 {memory.importance.toFixed(2)}</span>
                        {memory.confidence !== null && (
                          <span>提取置信度 {memory.confidence.toFixed(2)}</span>
                        )}
                        {memory.confirmedAt && <span>确认于 {formatDate(memory.confirmedAt)}</span>}
                        {memory.sourceConversationId && (
                          <span>Conversation {memory.sourceConversationId.slice(0, 10)}</span>
                        )}
                        {memory.sourceMessageId && (
                          <span>Message {memory.sourceMessageId.slice(0, 10)}</span>
                        )}
                        {memory.sourceId && memory.sourceId !== memory.sourceMessageId && (
                          <span>Source {memory.sourceId.slice(0, 10)}</span>
                        )}
                      </div>
                      {reviewing && (
                        <div className="candidate-edit-panel">
                          <p>检查并修改候选内容，然后明确接受；保存后才会进入 ACTIVE。</p>
                          <MemoryEditFields form={reviewForm} onChange={updateReviewForm} />
                          <div className="button-row">
                            <button
                              className="button primary small"
                              disabled={busyId === memory.id}
                              onClick={() => void acceptCandidate(memory, true)}
                              type="button"
                            >
                              保存修改并接受
                            </button>
                            <button
                              className="button secondary small"
                              disabled={busyId === memory.id}
                              onClick={() => void saveCandidateEdit(memory)}
                              type="button"
                            >
                              保存修改，继续审核
                            </button>
                            <button
                              className="button ghost small"
                              onClick={() => setReviewId('')}
                              type="button"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
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
                        {editing && (
                          <>
                            <button
                              className="button primary small"
                              disabled={busyId === memory.id}
                              onClick={() => void saveEdit(memory)}
                              type="button"
                            >
                              保存编辑
                            </button>
                            <button
                              className="button ghost small"
                              onClick={() => setEditingId('')}
                              type="button"
                            >
                              取消
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
            </div>
          ) : (
            <div className="empty-card subdued">
              <h3>还没有符合筛选的记忆</h3>
              <p>你可以手动添加记忆，或从 Chat 消息提取待确认候选。</p>
            </div>
          )}
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
                {item.label}
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
