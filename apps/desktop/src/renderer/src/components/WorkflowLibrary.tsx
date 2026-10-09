import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkflowDraft, WorkflowVersion } from '@cultivation/domain';
import type { CultivationBridge } from '../../../preload/preload.js';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { EmptyState } from './EmptyState.js';
import { Section } from './Section.js';
import { StatusBadge } from './StatusBadge.js';
import { createDefaultWorkflowDraftContent, WorkflowEditor } from './WorkflowEditor.js';
import './WorkflowEditor.css';

type WorkflowLibraryView = 'official' | 'user';

type WorkflowLibraryApi = CultivationBridge['workflowEditor'];

function workflowEditorApi(): WorkflowLibraryApi {
  return window.cultivation.workflowEditor;
}

function versionTitle(version: WorkflowVersion): string {
  return version.definition.name.trim() || '未命名工作流';
}

function versionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }).format(date);
}

export function WorkflowLibrary({
  activeView,
  versions,
  onRunVersion,
  onPublished,
}: {
  activeView: WorkflowLibraryView;
  versions: WorkflowVersion[];
  onRunVersion: (version: WorkflowVersion) => void;
  onPublished: (version: WorkflowVersion) => void | Promise<void>;
}) {
  const [drafts, setDrafts] = useState<WorkflowDraft[]>([]);
  const [activeDraft, setActiveDraft] = useState<WorkflowDraft | null>(null);
  const [copyTarget, setCopyTarget] = useState<WorkflowVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const api = useMemo(() => workflowEditorApi(), []);

  const refreshDrafts = useCallback(async () => {
    const next = await api.listDrafts();
    setDrafts([...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }, [api]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void api
      .listDrafts()
      .then((next) => {
        if (active)
          setDrafts([...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const message =
          reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined;
        setError(
          typeof message === 'string' && message.trim()
            ? message.slice(0, 1_200)
            : '读取个人草稿失败，请稍后重试。',
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeView, api]);

  const visibleVersions = useMemo(
    () =>
      [...versions]
        .filter((version) =>
          activeView === 'official'
            ? version.definition.source === 'BUILTIN'
            : version.definition.source === 'USER',
        )
        .sort(
          (left, right) =>
            versionTitle(left).localeCompare(versionTitle(right), 'zh-Hans-CN') ||
            right.version - left.version,
        ),
    [activeView, versions],
  );

  const openDraft = async (draftId: string) => {
    setBusy(true);
    setError('');
    try {
      setActiveDraft(await api.getDraft(draftId));
    } catch (reason) {
      const message =
        reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined;
      setError(
        typeof message === 'string' && message.trim()
          ? message.slice(0, 1_200)
          : '打开草稿失败，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let draft = await api.createDraft({ name: '新建工作流' });
      if (draft.content.steps.length === 0) {
        draft = await api.saveDraft({
          id: draft.id,
          expectedRevision: draft.revision,
          content: createDefaultWorkflowDraftContent(),
        });
      }
      setActiveDraft(draft);
      await refreshDrafts();
    } catch (reason) {
      const message =
        reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined;
      setError(
        typeof message === 'string' && message.trim()
          ? message.slice(0, 1_200)
          : '新建草稿失败，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  const startVersionEdit = async (version: WorkflowVersion) => {
    setBusy(true);
    setError('');
    try {
      const draft = await api.editVersion({
        definitionId: version.definition.id,
        version: version.version,
      });
      setActiveDraft(draft);
      await refreshDrafts();
    } catch (reason) {
      const message =
        reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined;
      setError(
        typeof message === 'string' && message.trim()
          ? message.slice(0, 1_200)
          : '创建版本修订草稿失败，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmCopy = async () => {
    if (!copyTarget || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const draft = await api.copyVersion({
        definitionId: copyTarget.definition.id,
        version: copyTarget.version,
      });
      setCopyTarget(null);
      setActiveDraft(draft);
      await refreshDrafts();
      setNotice('已复制为个人草稿。');
    } catch (reason) {
      const message =
        reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined;
      setError(
        typeof message === 'string' && message.trim()
          ? message.slice(0, 1_200)
          : '复制工作流失败，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };

  const closeEditor = () => {
    setActiveDraft(null);
    setError('');
    setNotice('');
    void refreshDrafts().catch(() => setError('刷新个人草稿失败，请重试。'));
  };

  const editor = activeDraft ? (
    <WorkflowEditor
      draft={activeDraft}
      api={api}
      onCancel={closeEditor}
      onSaved={(saved) =>
        setDrafts((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      }
      onPublished={(version) => {
        setActiveDraft(null);
        setNotice(`已发布 v${version.version}。`);
        void refreshDrafts().catch(() => setError('刷新个人草稿失败，请重试。'));
        void onPublished(version);
      }}
    />
  ) : null;

  return (
    <div className="workflow-library" data-testid={`workflow-library-${activeView}`}>
      {error && (
        <div className="workflow-editor-feedback error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="workflow-editor-feedback success" role="status">
          {notice}
        </div>
      )}
      {editor ?? (
        <>
          <header className="workflow-library-heading">
            <div>
              <h2>{activeView === 'official' ? '官方工作流' : '我的工作流'}</h2>
            </div>
            {activeView === 'user' && (
              <Button
                variant="primary"
                disabled={busy}
                data-testid="workflow-create-draft"
                onClick={() => void createDraft()}
              >
                新建工作流
              </Button>
            )}
          </header>

          {activeView === 'user' && (
            <Section title={`个人草稿 · ${drafts.length}`} className="workflow-library-section">
              {loading ? (
                <p className="workflow-editor-empty">正在读取个人草稿…</p>
              ) : drafts.length ? (
                <div className="workflow-library-cards">
                  {drafts.map((draft) => (
                    <article
                      className="workflow-library-card"
                      key={draft.id}
                      data-testid="workflow-draft-card"
                    >
                      <div className="workflow-library-card-title">
                        <h3>{draft.content.name || '未命名工作流'}</h3>
                        <StatusBadge>
                          {draft.baseVersion ? `基于 v${draft.baseVersion}` : '新建草稿'}
                        </StatusBadge>
                      </div>
                      {draft.content.description && <p>{draft.content.description}</p>}
                      <small>
                        已编辑 {versionDate(draft.updatedAt)} · {draft.content.steps.length} 个步骤
                      </small>
                      <div className="workflow-library-card-actions">
                        <Button
                          variant="secondary"
                          disabled={busy}
                          data-testid="workflow-draft-open"
                          onClick={() => void openDraft(draft.id)}
                        >
                          继续编辑
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : visibleVersions.length ? (
                <p className="workflow-editor-empty">暂无待编辑草稿</p>
              ) : (
                <EmptyState
                  icon="Workflow"
                  title="还没有个人草稿"
                  description="新建工作流后即可添加输入、步骤和输出约定。"
                />
              )}
            </Section>
          )}

          <Section
            title={`${activeView === 'official' ? '官方版本' : '个人已发布版本'} · ${visibleVersions.length}`}
            className="workflow-library-section"
          >
            {visibleVersions.length ? (
              <div className="workflow-library-cards">
                {visibleVersions.map((version) => (
                  <article
                    className="workflow-library-card"
                    key={`${version.definition.id}-${version.version}`}
                    data-testid="workflow-version-card"
                  >
                    <div className="workflow-library-card-title">
                      <h3>{versionTitle(version)}</h3>
                      <StatusBadge tone={activeView === 'official' ? 'neutral' : 'success'}>
                        v{version.version}
                      </StatusBadge>
                    </div>
                    {version.definition.description && <p>{version.definition.description}</p>}
                    <small>
                      {version.definition.category || '未分类'} · 发布于{' '}
                      {versionDate(version.createdAt)}
                    </small>
                    <div className="workflow-library-card-actions">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => onRunVersion(version)}
                      >
                        运行此版本
                      </Button>
                      {activeView === 'user' && (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void startVersionEdit(version)}
                        >
                          编辑为新草稿
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        disabled={busy}
                        data-testid="workflow-copy-version"
                        onClick={() => setCopyTarget(version)}
                      >
                        复制为个人草稿
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                icon="Workflow"
                title={activeView === 'official' ? '暂无官方工作流' : '还没有已发布版本'}
                description={
                  activeView === 'official'
                    ? '官方工作流发布后会显示在这里。'
                    : '发布个人草稿后，冻结版本会显示在这里。'
                }
              />
            )}
          </Section>
        </>
      )}

      <Dialog
        title="复制工作流"
        open={Boolean(copyTarget)}
        onClose={() => {
          if (!busy) setCopyTarget(null);
        }}
        className="workflow-copy-dialog"
      >
        <div data-testid="workflow-copy-confirmation">
          <p>
            将复制「{copyTarget ? versionTitle(copyTarget) : ''}」v{copyTarget?.version ?? ''}。
          </p>
          <p>复制为个人草稿；官方专用校验和副作用规则不会复制。</p>
          <div className="workflow-library-card-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setCopyTarget(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              data-testid="workflow-copy-confirm"
              onClick={() => void confirmCopy()}
            >
              {busy ? '正在复制…' : '确认复制'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
