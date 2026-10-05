import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  GenerationInputRoleDescriptor,
  GenerationModelDescriptor,
} from '@cultivation/domain/g1-generation';
import { Avatar } from '../components/Avatar.js';
import { Drawer } from '../components/Drawer.js';
import { Icon } from '../components/Icon.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { AvailabilityBadge } from '../r3-2-availability.js';
import {
  formatTime,
  type GenerationAttachmentView,
  type GenerationChatDetailView,
  type GenerationChatEntryView,
  type RuntimeProfileView,
  type TeammateView,
  type ProviderView,
} from '../ui-shared.js';
import './generation-chat.css';

type SupportedParameterKey = 'duration' | 'aspect' | 'seed' | 'nativeAudio';
type ParameterSchema = Record<string, unknown>;

interface ParameterField {
  key: SupportedParameterKey;
  schema: ParameterSchema;
  required: boolean;
}

interface ActiveConversation {
  teammateId: string;
  conversationId: string;
}

const terminalJobStates = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN']);

export function GenerationChatPage() {
  const { teammateId = '' } = useParams();
  const navigate = useNavigate();
  const [teammate, setTeammate] = useState<TeammateView | null>(null);
  const [runtime, setRuntime] = useState<RuntimeProfileView | null>(null);
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [conversations, setConversations] = useState<GenerationChatDetailView['conversation'][]>(
    [],
  );
  const [conversationId, setConversationId] = useState('');
  const [detail, setDetail] = useState<GenerationChatDetailView | null>(null);
  const [descriptor, setDescriptor] = useState<GenerationModelDescriptor | null>(null);
  const [attachments, setAttachments] = useState<GenerationAttachmentView[]>([]);
  const [inputs, setInputs] = useState<Array<{ artifactId: string; role: string }>>([]);
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [notice, setNotice] = useState('');
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  const activeConversation = useRef<ActiveConversation>({ teammateId, conversationId: '' });
  const messageStreamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 980px)');
    const update = () => {
      setNarrow(media.matches);
      if (!media.matches) setConversationDrawerOpen(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const loadDetail = async (targetTeammateId: string, targetConversationId: string) => {
    activeConversation.current = {
      teammateId: targetTeammateId,
      conversationId: targetConversationId,
    };
    setConversationId(targetConversationId);
    setDetail(null);
    setLoadingDetail(true);
    setError('');
    setErrorCode('');
    try {
      const next = await window.cultivation.generationChat.detail({
        teammateId: targetTeammateId,
        conversationId: targetConversationId,
      });
      const active = activeConversation.current;
      if (active.teammateId !== targetTeammateId || active.conversationId !== targetConversationId)
        return;
      setDetail(next);
      if (next.descriptor) setDescriptor(next.descriptor);
    } catch (cause) {
      if (
        activeConversation.current.teammateId === targetTeammateId &&
        activeConversation.current.conversationId === targetConversationId
      ) {
        setError(generationErrorText(cause, '读取生成对话失败。'));
        setErrorCode(errorCodeOf(cause));
      }
    } finally {
      if (
        activeConversation.current.teammateId === targetTeammateId &&
        activeConversation.current.conversationId === targetConversationId
      )
        setLoadingDetail(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    activeConversation.current = { teammateId, conversationId: '' };
    setLoading(true);
    setTeammate(null);
    setRuntime(null);
    setProvider(null);
    setConversations([]);
    setConversationId('');
    setDetail(null);
    setDescriptor(null);
    setAttachments([]);
    setInputs([]);
    setParameters({});
    setDraft('');
    setError('');
    setErrorCode('');
    setNotice('');

    void Promise.all([
      window.cultivation.teammates.list(),
      window.cultivation.runtimes.list(),
      window.cultivation.providers.list(),
      window.cultivation.generationChat.listConversations(teammateId),
      window.cultivation.generationChat.listAttachments(),
    ])
      .then(async ([teammates, runtimes, providers, rows, attachmentRows]) => {
        if (cancelled) return;
        const found = teammates.find((item) => item.id === teammateId) ?? null;
        const currentRuntime = found?.currentRuntimeProfileId
          ? runtimes.find((item) => item.id === found.currentRuntimeProfileId)
          : undefined;
        const currentProvider = currentRuntime
          ? providers.find((item) => item.id === currentRuntime.providerId)
          : undefined;
        setTeammate(found);
        setRuntime(currentRuntime ?? null);
        setProvider(currentProvider ?? null);
        setConversations(rows);
        setAttachments(attachmentRows);
        if (!found) {
          setError('找不到这位道友。');
          return;
        }
        if (
          currentRuntime?.executionProtocol !== 'GENERATION' ||
          currentProvider?.kind !== 'GENERATION_HTTP'
        ) {
          setError('此页面仅适用于绑定生成服务的道友。');
          return;
        }
        if (rows[0]) await loadDetail(teammateId, rows[0].id);
        if (cancelled || found.status !== 'ACTIVE') return;
        try {
          const modelDescriptor = await window.cultivation.generationChat.descriptor(teammateId);
          if (cancelled) return;
          setDescriptor(modelDescriptor);
          setParameters(defaultParameters(modelDescriptor));
        } catch (cause) {
          if (cancelled) return;
          setError(generationErrorText(cause, '读取生成模型能力失败。'));
          setErrorCode(errorCodeOf(cause));
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(generationErrorText(cause, '读取生成对话失败。'));
          setErrorCode(errorCodeOf(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      activeConversation.current = { teammateId, conversationId: '' };
    };
  }, [teammateId]);

  const activeJobs = detail?.entries.some(
    (entry) => entry.job !== null && !terminalJobStates.has(entry.job.state),
  );
  useEffect(() => {
    if (!activeJobs || !conversationId) return;
    const timer = window.setInterval(() => {
      void window.cultivation.generationChat
        .refresh({ teammateId, conversationId })
        .then((next) => {
          const active = activeConversation.current;
          if (active.teammateId !== teammateId || active.conversationId !== conversationId) return;
          setDetail(next);
          if (next.descriptor) setDescriptor(next.descriptor);
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeJobs, conversationId, teammateId]);

  useEffect(() => {
    if (messageStreamRef.current)
      messageStreamRef.current.scrollTop = messageStreamRef.current.scrollHeight;
  }, [detail, loadingDetail, conversationId]);

  const parameterFields = useMemo(
    () => (descriptor ? supportedParameterFields(descriptor) : []),
    [descriptor],
  );
  const generationIdentityReady =
    teammate?.status === 'ACTIVE' &&
    runtime?.executionProtocol === 'GENERATION' &&
    provider?.kind === 'GENERATION_HTTP';
  const requiredParametersReady = parameterFields.every(
    (field) => !field.required || hasValidParameterValue(field, parameters[field.key]),
  );
  const inputRolesReady = inputs.every((input) =>
    descriptor?.inputRoles.some((role) => role.role === input.role),
  );

  const refreshConversations = async () => {
    const rows = await window.cultivation.generationChat.listConversations(teammateId);
    if (activeConversation.current.teammateId === teammateId) setConversations(rows);
  };

  const createConversation = async () => {
    if (!generationIdentityReady || !teammate || busy) return;
    setError('');
    setErrorCode('');
    setNotice('');
    try {
      const created = await window.cultivation.generationChat.createConversation({ teammateId });
      await refreshConversations();
      setInputs([]);
      setDraft('');
      setConversationDrawerOpen(false);
      await loadDetail(teammateId, created.id);
    } catch (cause) {
      setError(generationErrorText(cause, '创建生成对话失败。'));
      setErrorCode(errorCodeOf(cause));
    }
  };

  const selectConversation = async (id: string) => {
    setInputs([]);
    setDraft('');
    setNotice('');
    setConversationDrawerOpen(false);
    await loadDetail(teammateId, id);
  };

  const importAttachment = async () => {
    setImporting(true);
    setError('');
    setErrorCode('');
    try {
      const imported = await window.cultivation.generationChat.importAttachment();
      if (!imported) return;
      setAttachments((current) => [imported, ...current.filter((item) => item.id !== imported.id)]);
      addInput(imported.id);
    } catch (cause) {
      setError(generationErrorText(cause, '导入素材失败。'));
      setErrorCode(errorCodeOf(cause));
    } finally {
      setImporting(false);
    }
  };

  const addInput = (artifactId: string) => {
    const maximum = descriptor?.limits.maxInputFiles ?? 0;
    if (inputs.some((item) => item.artifactId === artifactId) || inputs.length >= maximum) return;
    setInputs((current) => [...current, { artifactId, role: '' }]);
  };

  const toggleInput = (artifactId: string, selected: boolean) => {
    if (selected) addInput(artifactId);
    else setInputs((current) => current.filter((item) => item.artifactId !== artifactId));
  };

  const setInputRole = (artifactId: string, role: string) => {
    setInputs((current) =>
      current.map((item) => (item.artifactId === artifactId ? { ...item, role } : item)),
    );
  };

  const updateParameter = (key: SupportedParameterKey, value: unknown) => {
    setParameters((current) => ({ ...current, [key]: value }));
  };

  const removeParameter = (key: SupportedParameterKey) => {
    setParameters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (
      !prompt ||
      !conversationId ||
      !teammate ||
      teammate.status !== 'ACTIVE' ||
      busy ||
      !descriptor ||
      !requiredParametersReady ||
      !inputRolesReady
    )
      return;
    setBusy(true);
    setDraft('');
    setError('');
    setErrorCode('');
    setNotice('');
    try {
      const next = await window.cultivation.generationChat.send({
        teammateId,
        conversationId,
        prompt,
        inputs: inputs.map(({ artifactId, role }) => ({ artifactId, role })),
        parameters,
      });
      if (
        activeConversation.current.teammateId === teammateId &&
        activeConversation.current.conversationId === conversationId
      ) {
        setDetail(next);
        if (next.descriptor) setDescriptor(next.descriptor);
        setInputs([]);
      }
      await refreshConversations();
    } catch (cause) {
      const code = errorCodeOf(cause);
      setError(generationErrorText(cause, '发送生成任务失败。'));
      setErrorCode(code);
      setDraft(prompt);
    } finally {
      setBusy(false);
    }
  };

  const recheckAvailability = async () => {
    if (!teammate || teammate.status !== 'ACTIVE') return;
    setRechecking(true);
    setError('');
    setErrorCode('');
    setNotice('');
    try {
      const projection = await window.cultivation.availability.recheck(teammate.id);
      if (projection.status === 'AVAILABLE') {
        const modelDescriptor = await window.cultivation.generationChat.descriptor(teammate.id);
        setDescriptor(modelDescriptor);
        setParameters((current) =>
          Object.keys(current).length ? current : defaultParameters(modelDescriptor),
        );
        setNotice('生成服务可用。请检查提示词和参数后手动重试。');
      } else {
        setError(`生成服务状态：${availabilityLabel(projection.status)}。`);
        setErrorCode('MODEL_UNAVAILABLE');
      }
    } catch (cause) {
      const code = errorCodeOf(cause);
      setError(generationErrorText(cause, '检测失败，请稍后重试。'));
      setErrorCode(code);
    } finally {
      setRechecking(false);
    }
  };

  const conversationList = (
    <aside
      className={`r33-conversation-list ${conversationDrawerOpen ? 'is-open' : ''}`}
      aria-label="生成对话列表"
    >
      <div className="r33-list-heading">
        <div>
          <div className="r33-list-title">
            <Icon name="Chat" size={17} />
            <h2>生成对话</h2>
          </div>
          <p>{conversations.length} 段交流</p>
        </div>
        <button
          className="r33-icon-button"
          type="button"
          aria-label="开始新对话"
          title="开始新对话"
          disabled={!generationIdentityReady || busy}
          onClick={() => void createConversation()}
        >
          <Icon name="Add" size={18} />
        </button>
      </div>
      {conversations.length ? (
        <div className="r33-conversation-items">
          {conversations.map((conversation, index) => {
            const selected = conversation.id === conversationId;
            const firstPrompt =
              selected &&
              detail?.entries.find((entry) => entry.message.role === 'USER')?.message.content;
            return (
              <button
                key={conversation.id}
                type="button"
                className={`r33-conversation-item ${selected ? 'is-selected' : ''}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => void selectConversation(conversation.id)}
              >
                <span className="r33-conversation-copy">
                  <strong>{firstPrompt || `生成对话 ${conversations.length - index}`}</strong>
                  <time dateTime={conversation.updatedAt}>
                    {formatTime(conversation.updatedAt)}
                  </time>
                </span>
                {selected && <span className="r33-selected-mark" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="r33-sidebar-empty">还没有生成对话</p>
      )}
    </aside>
  );

  if (!loading && !teammate) {
    return (
      <section
        className="g2-generation-chat r33-chat-page g2-generation-not-found"
        data-testid="generation-chat-page"
      >
        <div className="r33-not-found-panel">
          <Icon name="Model" size={30} />
          <h1>无法打开生成对话</h1>
          <p>{error || '此道友可能已删除，或暂时无法读取。'}</p>
          <button className="button secondary" type="button" onClick={() => navigate('/teammates')}>
            返回道友列表
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="g2-generation-chat r33-chat-page" data-testid="generation-chat-page">
      <header className="r33-chat-header" data-testid="generation-chat-header">
        <button
          className="r33-back-button"
          type="button"
          aria-label="返回道友列表"
          title="返回道友列表"
          onClick={() => navigate('/teammates')}
        >
          <Icon name="ChevronLeft" size={18} />
        </button>
        {teammate && (
          <Avatar
            avatar={teammate.avatar}
            name={teammate.name}
            kind="TEAMMATE"
            size={44}
            className="r33-header-avatar"
          />
        )}
        <div className="r33-chat-identity">
          <strong>{teammate?.name ?? '正在打开生成对话'}</strong>
          <div className="r33-chat-subtitle">
            <span className="r33-model-name">
              {provider?.name ?? 'Generation HTTP'} · {runtime?.modelId ?? '模型不可读取'}
            </span>
          </div>
        </div>
        {teammate && (
          <div className="r33-header-availability">
            <AvailabilityBadge
              teammateId={teammate.id}
              teammateStatus={teammate.status}
              executorKind={teammate.executorKind ?? 'MODEL_RUNTIME'}
            />
          </div>
        )}
        <button
          className="r33-mobile-list-toggle"
          type="button"
          aria-label={conversationDrawerOpen ? '收起生成对话列表' : '展开生成对话列表'}
          aria-expanded={conversationDrawerOpen}
          onClick={() => setConversationDrawerOpen((open) => !open)}
        >
          <Icon name="Panel" size={18} />
          <span>对话</span>
        </button>
      </header>

      <div className="r33-chat-workspace">
        {!narrow && conversationList}
        {narrow && (
          <Drawer
            title="生成对话列表"
            open={conversationDrawerOpen}
            onClose={() => setConversationDrawerOpen(false)}
            className="chat-list-drawer"
          >
            {conversationDrawerOpen && conversationList}
          </Drawer>
        )}
        <div className="r33-chat-main">
          <div
            className="r33-message-stream"
            aria-label="生成记录"
            aria-busy={loadingDetail || busy}
            ref={messageStreamRef}
          >
            {loading || loadingDetail ? (
              <div className="r33-loading-state" role="status">
                <span className="r33-loading-dot" /> 正在读取生成对话
              </div>
            ) : !conversationId ? (
              <div className="r33-empty-state" data-testid="empty-generation-chat">
                {teammate && (
                  <Avatar avatar={teammate.avatar} name={teammate.name} kind="TEAMMATE" size={88} />
                )}
                <h1>和{teammate?.name ?? '这位道友'}开始生成视频</h1>
                <p>发送提示词，可附加素材并选择素材用途。</p>
                {generationIdentityReady && (
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => void createConversation()}
                  >
                    开始新对话 <Icon name="ArrowUp" size={16} />
                  </button>
                )}
              </div>
            ) : detail?.entries.length ? (
              <div className="g2-generation-entry-list">
                {detail.entries.map((entry) => (
                  <GenerationEntry
                    key={entry.message.id}
                    entry={entry}
                    teammate={teammate}
                    attachments={attachments}
                    parameterSummary={entryParameterSummary(entry.parameters)}
                  />
                ))}
              </div>
            ) : (
              <div className="r33-conversation-empty" data-testid="empty-generation-conversation">
                {teammate && (
                  <Avatar avatar={teammate.avatar} name={teammate.name} kind="TEAMMATE" size={54} />
                )}
                <span>写下你想生成的视频内容。</span>
              </div>
            )}
          </div>

          {error && (
            <div
              className="r33-inline-notice is-error"
              role="alert"
              data-testid="generation-chat-error"
            >
              <Icon name="Alert" size={17} />
              <span className="r33-notice-copy">{error}</span>
              {errorCode === 'MODEL_UNAVAILABLE' && (
                <div className="r33-notice-actions">
                  <button
                    type="button"
                    className="r33-inline-action"
                    disabled={rechecking}
                    onClick={() => void recheckAvailability()}
                  >
                    {rechecking ? '检测中…' : '重新检测'}
                  </button>
                  <button
                    type="button"
                    className="r33-inline-action"
                    onClick={() => {
                      setError('');
                      setErrorCode('');
                    }}
                  >
                    取消
                  </button>
                </div>
              )}
              {errorCode && errorCode !== 'MODEL_UNAVAILABLE' && (
                <code>{safeErrorCode(errorCode)}</code>
              )}
            </div>
          )}
          {notice && (
            <div className="r33-inline-notice is-memory" role="status">
              {notice}
            </div>
          )}

          {generationIdentityReady && (
            <form
              className="r33-composer g2-generation-composer"
              onSubmit={(event) => void send(event)}
              data-testid="generation-chat-composer"
            >
              <div className="g2-generation-composer-tools">
                <details className="g2-generation-tool-panel">
                  <summary>
                    <Icon name="Attachment" size={16} /> 素材{' '}
                    {inputs.length ? `(${inputs.length})` : ''}
                  </summary>
                  <div className="g2-generation-panel-content">
                    <div className="g2-generation-attachment-actions">
                      <strong>可用素材</strong>
                      <button
                        className="text-button"
                        type="button"
                        disabled={importing || !descriptor?.inputRoles.length}
                        onClick={() => void importAttachment()}
                      >
                        {importing ? '导入中…' : '从文件导入'}
                      </button>
                    </div>
                    {!descriptor?.inputRoles.length ? (
                      <p className="muted-copy">此模型暂不接受输入素材。</p>
                    ) : attachments.length ? (
                      <div className="g2-generation-attachment-list">
                        {attachments.map((attachment) => {
                          const selected = inputs.some((item) => item.artifactId === attachment.id);
                          const binding = inputs.find((item) => item.artifactId === attachment.id);
                          const roles = allowedInputRoles(descriptor, attachment);
                          const limitReached = inputs.length >= descriptor.limits.maxInputFiles;
                          return (
                            <div className="g2-generation-attachment" key={attachment.id}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  disabled={!selected && (limitReached || roles.length === 0)}
                                  onChange={(event) =>
                                    toggleInput(attachment.id, event.target.checked)
                                  }
                                />
                                <span>
                                  <strong>{attachment.name}</strong>
                                  <small>{formatAttachment(attachment)}</small>
                                </span>
                              </label>
                              {selected && (
                                <select
                                  aria-label={`素材用途：${attachment.name}`}
                                  value={binding?.role ?? ''}
                                  onChange={(event) =>
                                    setInputRole(attachment.id, event.target.value)
                                  }
                                >
                                  <option value="">选择素材用途</option>
                                  {roles.map((role) => {
                                    const roleUseCount = inputs.filter(
                                      (item) =>
                                        item.role === role.role &&
                                        item.artifactId !== attachment.id,
                                    ).length;
                                    return (
                                      <option
                                        key={role.role}
                                        value={role.role}
                                        disabled={roleUseCount >= role.maxFiles}
                                      >
                                        {roleLabel(role.role)}
                                      </option>
                                    );
                                  })}
                                </select>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="muted-copy">尚无可用素材，可从本机导入。</p>
                    )}
                    {inputs.length > 0 && !inputRolesReady && (
                      <p className="g2-generation-field-hint">请为每个素材明确选择用途后发送。</p>
                    )}
                  </div>
                </details>
                {parameterFields.length > 0 && (
                  <details className="g2-generation-tool-panel">
                    <summary>
                      <Icon name="Settings" size={16} /> 生成参数
                    </summary>
                    <div className="g2-generation-panel-content g2-generation-parameter-grid">
                      {parameterFields.map((field) => (
                        <ParameterControl
                          key={field.key}
                          field={field}
                          value={parameters[field.key]}
                          descriptor={descriptor!}
                          onChange={updateParameter}
                          onRemove={removeParameter}
                        />
                      ))}
                    </div>
                  </details>
                )}
                {descriptor && (
                  <span className="g2-generation-descriptor">
                    {descriptor.outputCapability === 'VIDEO_GENERATION' ? '视频生成' : '生成模型'} ·{' '}
                    {descriptor.executionMode === 'ASYNC_JOB' ? '异步任务' : '即时生成'}
                  </span>
                )}
              </div>
              <label className="r33-visually-hidden" htmlFor="generation-chat-prompt">
                描述想生成的视频
              </label>
              <textarea
                id="generation-chat-prompt"
                rows={3}
                value={draft}
                aria-label="描述想生成的视频"
                disabled={!conversationId || busy || !descriptor}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="r33-composer-footer">
                <span>
                  {!conversationId
                    ? '开始新对话后即可生成'
                    : busy
                      ? '正在提交生成任务…'
                      : 'Enter 发送 · Shift+Enter 换行'}
                </span>
                <button
                  className="button primary r33-send-button"
                  type="submit"
                  disabled={
                    !draft.trim() ||
                    !conversationId ||
                    busy ||
                    !descriptor ||
                    !requiredParametersReady ||
                    !inputRolesReady
                  }
                >
                  {busy ? '提交中' : '生成视频'}
                  <Icon name={busy ? 'Refresh' : 'ArrowUp'} size={16} />
                </button>
              </div>
              {!conversationId && (
                <button
                  className="g2-generation-composer-start"
                  type="button"
                  onClick={() => void createConversation()}
                >
                  开始新对话
                </button>
              )}
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

function GenerationEntry({
  entry,
  teammate,
  attachments,
  parameterSummary,
}: {
  entry: GenerationChatEntryView;
  teammate: TeammateView | null;
  attachments: GenerationAttachmentView[];
  parameterSummary: string[];
}) {
  return (
    <div className="g2-generation-entry" data-testid="generation-entry">
      {entry.message.role === 'USER' && (
        <article className="r33-message-row is-user g2-generation-user-message">
          <div className="r33-message-body">
            <div className="r33-message-meta">
              <strong>你</strong>
              <time>{formatTime(entry.message.createdAt)}</time>
            </div>
            <div className="r33-message-surface">
              <p>{entry.message.content}</p>
            </div>
            {entry.inputs.length > 0 && (
              <div className="g2-generation-input-summary">
                {entry.inputs.map((input) => {
                  const attachment = attachments.find((item) => item.id === input.artifactId);
                  return (
                    <span key={`${input.artifactId}:${input.role}`}>
                      {attachment?.name ?? '已附加素材'} · {roleLabel(input.role)}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </article>
      )}
      {entry.preparationErrorCode && (
        <div className="g2-generation-job-card is-failed" role="status">
          <Icon name="Alert" size={18} />
          <span>
            <strong>任务准备失败</strong>
            <small>{safeErrorCode(entry.preparationErrorCode)}</small>
          </span>
        </div>
      )}
      {entry.job && (
        <div
          className={`g2-generation-job-card state-${entry.job.state.toLowerCase()}`}
          data-testid="generation-job-card"
        >
          <Icon
            name={
              entry.job.state === 'COMPLETED'
                ? 'Check'
                : entry.job.state === 'FAILED'
                  ? 'Alert'
                  : 'Refresh'
            }
            size={18}
          />
          <span className="g2-generation-job-copy">
            <strong>生成任务 · {jobStateLabel(entry.job.state)}</strong>
            <small>
              {parameterSummary.length
                ? parameterSummary.join(' · ')
                : '提示词与显式素材参数已保存'}
              {entry.job.errorCode ? ` · ${safeErrorCode(entry.job.errorCode)}` : ''}
            </small>
            {entry.job.state === 'UNKNOWN' && <small>状态待确认；此任务不会自动重新提交。</small>}
          </span>
          <StatusBadge
            tone={
              entry.job.state === 'COMPLETED'
                ? 'success'
                : entry.job.state === 'FAILED'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {jobStateLabel(entry.job.state)}
          </StatusBadge>
        </div>
      )}
      {entry.artifacts.map((artifact) => (
        <GenerationArtifactCard key={artifact.id} artifact={artifact} teammate={teammate} />
      ))}
    </div>
  );
}

function GenerationArtifactCard({
  artifact,
  teammate,
}: {
  artifact: GenerationChatEntryView['artifacts'][number];
  teammate: TeammateView | null;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const sourceRequest = useRef<{ artifactId: string; promise: Promise<string> } | null>(null);
  const duration = metadataNumber(artifact.metadata, 'durationSeconds', 'duration_seconds');
  const width = metadataNumber(artifact.metadata, 'width');
  const height = metadataNumber(artifact.metadata, 'height');
  const fps = metadataNumber(artifact.metadata, 'fps');
  const meta = [
    duration === null ? null : `${duration}s`,
    width !== null && height !== null ? `${width}×${height}` : null,
    fps === null ? null : `${fps}fps`,
    formatBytes(artifact.sizeBytes),
  ].filter((item): item is string => item !== null);
  const isVideo = artifact.mimeType.startsWith('video/');
  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setSourceError(false);
    if (!isVideo) {
      return () => {
        cancelled = true;
      };
    }
    const request =
      sourceRequest.current?.artifactId === artifact.id
        ? sourceRequest.current.promise
        : window.cultivation.generationChat.artifactUrl(artifact.id);
    sourceRequest.current = { artifactId: artifact.id, promise: request };
    void request.then(
      (url) => {
        if (!cancelled) setSource(url);
      },
      () => {
        if (!cancelled) setSourceError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifact.id, isVideo]);
  return (
    <article className="g2-generation-artifact-card" data-testid="generation-artifact-card">
      {isVideo ? (
        source ? (
          <video
            className="g2-generation-video"
            controls
            preload="metadata"
            src={source}
            aria-label={`${teammate?.name ?? '道友'}生成的视频`}
          />
        ) : (
          <div
            className="g2-generation-video g2-generation-video-pending"
            role={sourceError ? 'alert' : 'status'}
          >
            {sourceError ? '暂时无法加载视频预览。' : '正在准备视频预览…'}
          </div>
        )
      ) : (
        <div className="g2-generation-file-icon">
          <Icon name="Attachment" size={24} />
        </div>
      )}
      <div className="g2-generation-artifact-copy">
        <strong>{isVideo ? '生成视频' : '生成文件'}</strong>
        <span>{meta.join(' · ') || artifact.mimeType}</span>
        <small>{artifact.mimeType}</small>
      </div>
    </article>
  );
}

function ParameterControl({
  field,
  value,
  descriptor,
  onChange,
  onRemove,
}: {
  field: ParameterField;
  value: unknown;
  descriptor: GenerationModelDescriptor;
  onChange: (key: SupportedParameterKey, value: unknown) => void;
  onRemove: (key: SupportedParameterKey) => void;
}) {
  const label = parameterLabel(field.key);
  if (field.key === 'nativeAudio') {
    return (
      <label className="field">
        <span>
          {label}
          {field.required ? '（必选）' : '（可选）'}
        </span>
        <select
          required={field.required}
          value={typeof value === 'boolean' ? String(value) : ''}
          onChange={(event) => {
            if (event.target.value === '') onRemove(field.key);
            else onChange(field.key, event.target.value === 'true');
          }}
        >
          {!field.required && <option value="">使用服务默认值</option>}
          <option value="true">开启</option>
          <option value="false">关闭</option>
        </select>
      </label>
    );
  }
  if (field.key === 'aspect') {
    const options = stringOptions(field.schema.enum);
    return (
      <label className="field">
        <span>
          {label}
          {field.required ? '（必选）' : '（可选）'}
        </span>
        {options.length ? (
          <select
            value={typeof value === 'string' ? value : ''}
            required={field.required}
            onChange={(event) =>
              event.target.value ? onChange(field.key, event.target.value) : onRemove(field.key)
            }
          >
            {!field.required && <option value="">使用服务默认值</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            required={field.required}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) =>
              event.target.value ? onChange(field.key, event.target.value) : onRemove(field.key)
            }
          />
        )}
      </label>
    );
  }
  const isDuration = field.key === 'duration';
  const isSeed = field.key === 'seed';
  const min = isDuration
    ? boundedMinimum(field.schema.minimum, descriptor.limits.minDurationSeconds)
    : optionalNumber(field.schema.minimum);
  const max = isDuration
    ? boundedMaximum(field.schema.maximum, descriptor.limits.maxDurationSeconds)
    : optionalNumber(field.schema.maximum);
  return (
    <label className="field">
      <span>
        {label}
        {field.required ? '（必选）' : '（可选）'}
      </span>
      <input
        type="number"
        step={isSeed || field.schema.type === 'integer' ? 1 : 0.01}
        min={min ?? undefined}
        max={max ?? undefined}
        required={field.required}
        value={typeof value === 'number' ? value : ''}
        onChange={(event) => {
          if (!event.target.value) {
            onRemove(field.key);
            return;
          }
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(field.key, next);
        }}
      />
      {isDuration &&
        descriptor.limits.minDurationSeconds !== undefined &&
        descriptor.limits.maxDurationSeconds !== undefined && (
          <small>
            {descriptor.limits.minDurationSeconds}–{descriptor.limits.maxDurationSeconds} 秒
          </small>
        )}
    </label>
  );
}

function supportedParameterFields(descriptor: GenerationModelDescriptor): ParameterField[] {
  const schema = descriptor.parameterSchema;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = unknownArray(schema.required).filter(
    (item): item is string => typeof item === 'string',
  );
  const supported: SupportedParameterKey[] = ['duration', 'aspect', 'seed', 'nativeAudio'];
  return supported.flatMap((key) => {
    const candidate = properties[key];
    if (!isRecord(candidate)) return [];
    const propertyType = candidate.type;
    const supportedType =
      (key === 'duration' && (propertyType === 'number' || propertyType === 'integer')) ||
      (key === 'aspect' && propertyType === 'string') ||
      (key === 'seed' && (propertyType === 'number' || propertyType === 'integer')) ||
      (key === 'nativeAudio' &&
        propertyType === 'boolean' &&
        descriptor.featureTags.includes('NATIVE_AUDIO'));
    if (!supportedType) return [];
    const parameterSchema =
      key === 'duration'
        ? {
            ...candidate,
            ...(boundedMinimum(candidate.minimum, descriptor.limits.minDurationSeconds) !==
            undefined
              ? { minimum: boundedMinimum(candidate.minimum, descriptor.limits.minDurationSeconds) }
              : {}),
            ...(boundedMaximum(candidate.maximum, descriptor.limits.maxDurationSeconds) !==
            undefined
              ? { maximum: boundedMaximum(candidate.maximum, descriptor.limits.maxDurationSeconds) }
              : {}),
          }
        : candidate;
    return [{ key, schema: parameterSchema, required: required.includes(key) }];
  });
}

function defaultParameters(descriptor: GenerationModelDescriptor): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const field of supportedParameterFields(descriptor)) {
    if (!Object.hasOwn(field.schema, 'default')) continue;
    const value = field.schema.default;
    if (hasValidParameterValue(field, value)) defaults[field.key] = value;
  }
  return defaults;
}

function hasValidParameterValue(field: ParameterField, value: unknown): boolean {
  if (field.key === 'nativeAudio') return typeof value === 'boolean';
  if (field.key === 'aspect') {
    const options = stringOptions(field.schema.enum);
    return typeof value === 'string' && (!options.length || options.includes(value));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const minimum = optionalNumber(field.schema.minimum);
  const maximum = optionalNumber(field.schema.maximum);
  if (minimum !== null && value < minimum) return false;
  if (maximum !== null && value > maximum) return false;
  return (
    (field.key !== 'seed' || Number.isInteger(value)) &&
    (field.schema.type !== 'integer' || Number.isInteger(value))
  );
}

function entryParameterSummary(parameters: Record<string, unknown>): string[] {
  const supported: SupportedParameterKey[] = ['duration', 'aspect', 'seed', 'nativeAudio'];
  return supported.flatMap((key) => {
    const value = parameters[key];
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
      return [];
    return [`${parameterLabel(key)}：${String(value)}`];
  });
}

function allowedInputRoles(
  descriptor: GenerationModelDescriptor,
  attachment: GenerationAttachmentView,
): GenerationInputRoleDescriptor[] {
  return descriptor.inputRoles.filter((role) => {
    const kindAccepted = role.artifactKinds.some(
      (kind) => kind.toLocaleUpperCase() === attachment.kind.toLocaleUpperCase(),
    );
    const attachmentMime = attachment.mimeType.toLocaleLowerCase();
    const mimeAccepted = role.mimeTypes.some((mimeType) =>
      mimeType.endsWith('/*')
        ? attachmentMime.startsWith(mimeType.slice(0, -1).toLocaleLowerCase())
        : mimeType.toLocaleLowerCase() === attachmentMime,
    );
    return kindAccepted && mimeAccepted;
  });
}

export function errorCodeOf(cause: unknown): string {
  if (
    isRecord(cause) &&
    typeof cause.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,48}$/.test(cause.code)
  )
    return cause.code;
  const message =
    cause instanceof Error
      ? cause.message
      : isRecord(cause) && typeof cause.message === 'string'
        ? cause.message
        : '';
  const boundedMessage = message.replace(
    /^Error invoking remote method 'generationChat:[A-Za-z]+': (?:Error: )?/u,
    '',
  );
  return /^([A-Z][A-Z0-9_]{1,48}):(?:\s|$)/u.exec(boundedMessage)?.[1] ?? '';
}

export function generationErrorText(cause: unknown, fallback: string): string {
  const code = errorCodeOf(cause);
  if (code === 'MODEL_UNAVAILABLE') return '生成服务暂时不可用，请重新检测后再决定是否重试。';
  return code ? `${fallback}（${safeErrorCode(code)}）` : fallback;
}

function safeErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{1,48}$/.test(value) ? value : 'GENERATION_ERROR';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOptions(value: unknown): string[] {
  return unknownArray(value).filter((item): item is string => typeof item === 'string');
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedMinimum(
  schemaMinimum: unknown,
  descriptorMinimum: number | undefined,
): number | undefined {
  const values = [optionalNumber(schemaMinimum), descriptorMinimum].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  return values.length ? Math.max(...values) : undefined;
}

function boundedMaximum(
  schemaMaximum: unknown,
  descriptorMaximum: number | undefined,
): number | undefined {
  const values = [optionalNumber(schemaMaximum), descriptorMaximum].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  return values.length ? Math.min(...values) : undefined;
}

function parameterLabel(key: SupportedParameterKey): string {
  const labels: Record<SupportedParameterKey, string> = {
    duration: '时长',
    aspect: '画面比例',
    seed: '随机种子',
    nativeAudio: '要求原生音频',
  };
  return labels[key];
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    FIRST_FRAME: '首帧',
    LAST_FRAME: '尾帧',
    REFERENCE_IMAGE: '参考图片',
    REFERENCE_VIDEO: '参考视频',
    REFERENCE_AUDIO: '参考音频',
    SOURCE_VIDEO: '源视频',
  };
  return labels[role] ?? role.replaceAll('_', ' ').toLocaleLowerCase();
}

function jobStateLabel(state: string): string {
  const labels: Record<string, string> = {
    PENDING: '等待提交',
    SUBMITTING: '正在提交',
    QUEUED: '排队中',
    RUNNING: '生成中',
    COMPLETED: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
    UNKNOWN: '状态待确认',
  };
  return labels[state] ?? '处理中';
}

function availabilityLabel(status: string): string {
  const labels: Record<string, string> = {
    UNKNOWN: '尚未检测',
    AVAILABLE: '可用',
    UNSTABLE: '连接不稳定',
    UNAVAILABLE: '不可用',
  };
  return labels[status] ?? '未知';
}

function metadataNumber(
  metadata: Record<string, number | string | boolean | null>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
      return Number(value);
  }
  return null;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function formatAttachment(attachment: GenerationAttachmentView): string {
  return `${attachment.mimeType} · ${formatBytes(attachment.sizeBytes)}`;
}
