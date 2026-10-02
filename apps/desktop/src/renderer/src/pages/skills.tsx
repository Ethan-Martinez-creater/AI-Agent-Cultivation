import React, { useEffect, useState } from 'react';
import { Drawer } from '../components/Drawer.js';
import { Icon } from '../components/Icon.js';
import { Section } from '../components/Section.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { blankSkillForm, errorText, formatDate } from '../ui-shared.js';
import type { SkillForm, SkillView } from '../ui-shared.js';

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [form, setForm] = useState<SkillForm>(blankSkillForm);
  const [editingId, setEditingId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.cultivation.skills
      .list()
      .then((rows) => {
        if (!cancelled) setSkills(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取功法失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const refresh = () => setRefreshKey((current) => current + 1);
  const updateForm = (patch: Partial<SkillForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  const closeEditor = () => {
    setDrawerOpen(false);
    setEditingId('');
    setForm(blankSkillForm);
  };

  const openCreate = () => {
    setForm(blankSkillForm);
    setEditingId('');
    setError('');
    setNotice('');
    setDrawerOpen(true);
  };

  const beginEdit = (skill: SkillView) => {
    setEditingId(skill.id);
    setForm({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      tagsText: skill.tags.join(', '),
    });
    setError('');
    setNotice('');
    setDrawerOpen(true);
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const input = {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      tags: form.tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    try {
      const skill = editingId
        ? await window.cultivation.skills.update({ id: editingId, ...input })
        : await window.cultivation.skills.create(input);
      const wasEditing = Boolean(editingId);
      closeEditor();
      setNotice(
        wasEditing ? `已保存为新版本 v${skill.version}。` : `功法已创建，版本 v${skill.version}。`,
      );
      refresh();
    } catch (cause) {
      setError(errorText(cause, '保存功法失败。'));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (skill: SkillView) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.cultivation.skills.archive(skill.id);
      setNotice(`功法「${skill.name}」已归档。`);
      refresh();
    } catch (cause) {
      setError(errorText(cause, '归档功法失败。'));
    } finally {
      setBusy(false);
    }
  };

  const orderedSkills = [...skills].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <section className="page wide-page management-page">
      <header className="page-heading management-heading">
        <h1>功法</h1>
        <button className="button primary" type="button" onClick={openCreate}>
          <Icon name="Add" size={16} />
          新建功法
        </button>
      </header>

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

      <Section
        title="功法列表"
        icon="Skill"
        action={<span className="count-badge">{skills.length}</span>}
        className="management-section"
      >
        {loading ? (
          <div className="loading-card">正在读取功法…</div>
        ) : orderedSkills.length ? (
          <div className="management-list">
            {orderedSkills.map((skill) => (
              <article className="object-row" key={skill.id}>
                <div className="object-row-heading">
                  <div className="object-row-main">
                    <h3>{skill.name}</h3>
                    {skill.description && <p>{skill.description}</p>}
                  </div>
                  <StatusBadge tone={skill.status === 'ACTIVE' ? 'success' : 'neutral'}>
                    {skill.status === 'ACTIVE' ? '启用' : '已归档'}
                  </StatusBadge>
                </div>
                <div className="object-row-meta">
                  <span>版本 v{skill.version}</span>
                  <span>更新于 {formatDate(skill.updatedAt)}</span>
                </div>
                {skill.tags.length > 0 && (
                  <ul className="object-tags" aria-label="标签">
                    {skill.tags.map((tag) => (
                      <li key={tag}>{tag}</li>
                    ))}
                  </ul>
                )}
                <details className="advanced-records">
                  <summary>查看指令</summary>
                  <pre>{skill.instructions}</pre>
                </details>
                {skill.status === 'ACTIVE' && (
                  <div className="button-row compact object-row-actions">
                    <button
                      className="button secondary small"
                      type="button"
                      onClick={() => beginEdit(skill)}
                    >
                      编辑
                    </button>
                    <button
                      className="button danger-ghost small"
                      type="button"
                      disabled={busy}
                      onClick={() => void archive(skill)}
                    >
                      归档
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="list-empty">还没有功法。</div>
        )}
      </Section>

      <Drawer
        title={editingId ? '编辑功法' : '新建功法'}
        open={drawerOpen}
        onClose={closeEditor}
        className="management-drawer"
      >
        <form className="management-form" onSubmit={(event) => void save(event)}>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {editingId && <p className="form-hint">保存后会生成下一个版本。</p>}
          <label className="field">
            <span>名称</span>
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>说明</span>
            <input
              maxLength={500}
              value={form.description}
              onChange={(event) => updateForm({ description: event.target.value })}
            />
          </label>
          <label className="field">
            <span>标签</span>
            <input
              maxLength={400}
              value={form.tagsText}
              onChange={(event) => updateForm({ tagsText: event.target.value })}
            />
          </label>
          <label className="field">
            <span>指令</span>
            <textarea
              required
              rows={10}
              maxLength={12000}
              value={form.instructions}
              onChange={(event) => updateForm({ instructions: event.target.value })}
            />
          </label>
          <div className="button-row drawer-actions">
            <button className="button primary" disabled={busy}>
              {busy ? '保存中…' : editingId ? '保存新版本' : '创建功法'}
            </button>
            <button className="button ghost" type="button" onClick={closeEditor}>
              取消
            </button>
          </div>
        </form>
      </Drawer>
    </section>
  );
}
