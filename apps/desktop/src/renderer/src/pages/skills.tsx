import React, { useEffect, useState } from 'react';
import { blankSkillForm, errorText, PageHeading, EmptyList, formatDate } from '../ui-shared.js';
import type { SkillView, SkillForm } from '../ui-shared.js';

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [form, setForm] = useState<SkillForm>(blankSkillForm);
  const [editingId, setEditingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.cultivation.skills
      .list()
      .then((rows) => {
        if (!cancelled) setSkills(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取 Skill 失败。'));
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
      setForm(blankSkillForm);
      setEditingId('');
      setNotice(
        editingId ? `已保存为新版本 v${skill.version}。` : `Skill 已创建，版本 v${skill.version}。`,
      );
      refresh();
    } catch (cause) {
      setError(errorText(cause, '保存 Skill 失败。'));
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
      setNotice(`Skill「${skill.name}」已归档。`);
      refresh();
    } catch (cause) {
      setError(errorText(cause, '归档 Skill 失败。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page wide-page">
      <PageHeading
        eyebrow="Skill · declarative instructions"
        title="功法 Skills"
        description="Skill 只保存名称、标签与指令文本，不执行任意代码。只有分配给道友并启用的 Skill 才会加入该道友的对话提示。"
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
      <div className="panel-grid skill-workspace">
        <form className="form-card" onSubmit={(event) => void save(event)}>
          <div className="form-title-row">
            <div>
              <p className="eyebrow">{editingId ? 'NEW SKILL VERSION' : 'DECLARATIVE SKILL'}</p>
              <h2>{editingId ? '编辑 Skill' : '创建 Skill'}</h2>
              {editingId && <p className="muted-copy">保存会自动创建下一个 patch 版本。</p>}
            </div>
            {editingId && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setEditingId('');
                  setForm(blankSkillForm);
                }}
              >
                取消
              </button>
            )}
          </div>
          <label className="field">
            <span>名称</span>
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              placeholder="例如：代码审查习惯"
            />
          </label>
          <label className="field">
            <span>说明</span>
            <input
              maxLength={500}
              value={form.description}
              onChange={(event) => updateForm({ description: event.target.value })}
              placeholder="Skill 的用途"
            />
          </label>
          <label className="field">
            <span>
              标签 <small>用逗号分隔</small>
            </span>
            <input
              maxLength={400}
              value={form.tagsText}
              onChange={(event) => updateForm({ tagsText: event.target.value })}
              placeholder="coding, review"
            />
          </label>
          <label className="field">
            <span>指令</span>
            <textarea
              required
              rows={8}
              maxLength={12000}
              value={form.instructions}
              onChange={(event) => updateForm({ instructions: event.target.value })}
              placeholder="描述道友在指定任务中应遵循的做法"
            />
          </label>
          <p className="form-hint">此处文本作为提示内容使用，不会被当作脚本或命令执行。</p>
          <button className="button primary" disabled={busy}>
            {busy ? '保存中…' : editingId ? '保存新版本' : '创建 Skill'}
          </button>
        </form>
        <div className="list-card skill-list-card">
          <div className="list-heading">
            <div>
              <h2>已创建的 Skills</h2>
              <p>编辑会生成新的版本，现有分配仍引用同一个 Skill。</p>
            </div>
            <span className="count-badge">{skills.length}</span>
          </div>
          {loading ? (
            <div className="loading-card">正在读取 Skill…</div>
          ) : skills.length ? (
            [...skills]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((skill) => (
                <article className="skill-card" key={skill.id}>
                  <div className="skill-card-top">
                    <div>
                      <h3>{skill.name}</h3>
                      <p>{skill.description || '无说明'}</p>
                    </div>
                    <span
                      className={`status-pill ${skill.status === 'ACTIVE' ? 'active' : 'archived'}`}
                    >
                      {skill.status === 'ACTIVE' ? '启用' : '归档'}
                    </span>
                  </div>
                  <div className="skill-meta">
                    <span>v{skill.version}</span>
                    <span>更新于 {formatDate(skill.updatedAt)}</span>
                  </div>
                  {skill.tags.length > 0 && (
                    <div className="skill-tags">
                      {skill.tags.map((tag) => (
                        <span className="skill-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <details className="skill-instructions">
                    <summary>查看指令文本</summary>
                    <pre>{skill.instructions}</pre>
                  </details>
                  {skill.status === 'ACTIVE' && (
                    <div className="button-row compact">
                      <button className="button secondary small" onClick={() => beginEdit(skill)}>
                        编辑 / 新版本
                      </button>
                      <button
                        className="button danger-ghost small"
                        disabled={busy}
                        onClick={() => void archive(skill)}
                      >
                        归档
                      </button>
                    </div>
                  )}
                </article>
              ))
          ) : (
            <EmptyList text="还没有 Skill；先创建声明式指令，再到道友页面分配。" />
          )}
        </div>
      </div>
    </section>
  );
}
