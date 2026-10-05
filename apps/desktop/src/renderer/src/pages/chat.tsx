import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { Icon } from '../components/Icon.js';
import { Drawer } from '../components/Drawer.js';
import { MessageContent } from '../components/MessageContent.js';
import { AvailabilityBadge } from '../r3-2-availability.js';
import { errorText, formatTime, makeId } from '../ui-shared.js';
import type {
  ConversationView,
  MessageView,
  RuntimeProfileView,
  TeammateView,
} from '../ui-shared.js';
import './chat.css';

type ActiveRequest = {
  requestId: string | null;
  teammateId: string;
  conversationId: string;
  pendingText: string;
};

export function ChatPage() {
  const { teammateId = '' } = useParams();
  const navigate = useNavigate();
  const [availabilityRefresh, setAvailabilityRefresh] = useState(0);
  const [modelUnavailable, setModelUnavailable] = useState(false);
  const [recheckingAvailability, setRecheckingAvailability] = useState(false);
  const [teammate, setTeammate] = useState<TeammateView | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [draft, setDraft] = useState('');
  const [streamText, setStreamText] = useState('');
  const [pendingUserText, setPendingUserText] = useState('');
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [extractingMessageId, setExtractingMessageId] = useState('');
  const [candidateReady, setCandidateReady] = useState(false);
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 980px)');
    const update = () => {
      setNarrow(media.matches);
      if (!media.matches) setConversationDrawerOpen(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const activeRequest = useRef<ActiveRequest>({
    requestId: null,
    teammateId,
    conversationId: '',
    pendingText: '',
  });

  const refreshConversations = async (forTeammateId: string) => {
    const rows = await window.cultivation.chat.listConversations(forTeammateId);
    if (activeRequest.current.teammateId === forTeammateId) setConversations(rows);
    return rows;
  };

  const refreshMessages = async (forTeammateId: string, forConversationId: string) => {
    const rows = await window.cultivation.chat.listMessages({
      teammateId: forTeammateId,
      conversationId: forConversationId,
    });
    const active = activeRequest.current;
    if (active.teammateId === forTeammateId && active.conversationId === forConversationId) {
      setMessages(rows);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setNotice('');
    setConversationId('');
    setConversations([]);
    setMessages([]);
    setDraft('');
    setStreaming(false);
    setStreamText('');
    setPendingUserText('');
    setModelUnavailable(false);
    activeRequest.current = { requestId: null, teammateId, conversationId: '', pendingText: '' };

    void Promise.all([
      window.cultivation.teammates.list(),
      window.cultivation.chat.listConversations(teammateId),
      window.cultivation.runtimes.list(),
      window.cultivation.providers.list().catch(() => []),
    ])
      .then(([teammates, rows, runtimeRows, providerRows]) => {
        if (cancelled) return;
        const found = teammates.find((item) => item.id === teammateId) ?? null;
        const runtime = found?.currentRuntimeProfileId
          ? runtimeRows.find((item) => item.id === found.currentRuntimeProfileId)
          : undefined;
        const provider = runtime
          ? providerRows.find((item) => item.id === runtime.providerId)
          : undefined;
        if (runtime?.executionProtocol === 'GENERATION' && provider?.kind === 'GENERATION_HTTP') {
          navigate(`/generation-chat/${encodeURIComponent(teammateId)}`, { replace: true });
          return;
        }
        setTeammate(found);
        setRuntimes(runtimeRows);
        setConversations(rows);
        const initialConversationId = rows[0]?.id ?? '';
        setConversationId(initialConversationId);
        activeRequest.current = {
          requestId: null,
          teammateId,
          conversationId: initialConversationId,
          pendingText: '',
        };
        if (initialConversationId) {
          void window.cultivation.chat
            .listMessages({ teammateId, conversationId: initialConversationId })
            .then((items) => {
              const active = activeRequest.current;
              if (
                !cancelled &&
                active.teammateId === teammateId &&
                active.conversationId === initialConversationId
              )
                setMessages(items);
            })
            .catch((cause: unknown) => {
              if (!cancelled) setError(errorText(cause, '读取消息失败。'));
            });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取对话失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [navigate, teammateId]);

  useEffect(() => {
    const unsubscribe = window.cultivation.chat.onEvent((event) => {
      const active = activeRequest.current;
      if (
        active.requestId !== event.requestId ||
        active.teammateId !== event.teammateId ||
        active.conversationId !== event.conversationId
      )
        return;

      if (event.type === 'delta') {
        setStreamText((current) => current + (event.text ?? ''));
        return;
      }

      if (event.type === 'error') {
        setModelUnavailable(event.code === 'MODEL_UNAVAILABLE');
        setAvailabilityRefresh((current) => current + 1);
        setError(event.message || '发送失败，请稍后重试。');
        setDraft((current) => current || active.pendingText);
        setStreaming(false);
        setPendingUserText('');
        setStreamText('');
        activeRequest.current = { ...active, requestId: null, pendingText: '' };
        return;
      }

      if (event.assistantMessage) {
        setModelUnavailable(false);
        setAvailabilityRefresh((current) => current + 1);
        setMessages((current) =>
          current.some((item) => item.id === event.assistantMessage?.id)
            ? current
            : [...current, event.assistantMessage!],
        );
      }
      setStreaming(false);
      setPendingUserText('');
      setStreamText('');
      activeRequest.current = { ...active, requestId: null, pendingText: '' };
      void refreshMessages(event.teammateId, event.conversationId).catch(() => undefined);
      void refreshConversations(event.teammateId).catch(() => undefined);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const stream = messageStreamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [messages, pendingUserText, streamText, conversationId]);

  const selectConversation = async (id: string) => {
    activeRequest.current = { requestId: null, teammateId, conversationId: id, pendingText: '' };
    setConversationId(id);
    setMessages([]);
    setDraft('');
    setStreaming(false);
    setError('');
    setNotice('');
    setStreamText('');
    setPendingUserText('');
    setModelUnavailable(false);
    setCandidateReady(false);
    setConversationDrawerOpen(false);
    try {
      await refreshMessages(teammateId, id);
    } catch (cause) {
      setError(errorText(cause, '读取消息失败。'));
    }
  };

  const createConversation = async () => {
    if (!teammate || teammate.status !== 'ACTIVE' || isHumanBridge(teammate)) return;
    setError('');
    setNotice('');
    setCandidateReady(false);
    try {
      const created = await window.cultivation.chat.createConversation(teammateId);
      const rows = await refreshConversations(teammateId);
      setConversationId(created.id);
      setMessages([]);
      setDraft('');
      setStreaming(false);
      setStreamText('');
      setPendingUserText('');
      activeRequest.current = {
        requestId: null,
        teammateId,
        conversationId: created.id,
        pendingText: '',
      };
      if (!rows.some((item) => item.id === created.id))
        setConversations((current) => [created, ...current]);
    } catch (cause) {
      setError(errorText(cause, '创建对话失败。'));
    }
  };

  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !conversationId || !teammate || !canChat(teammate) || streaming) return;

    const requestId = makeId();
    activeRequest.current = { requestId, teammateId, conversationId, pendingText: text };
    setDraft('');
    setError('');
    setNotice('');
    setCandidateReady(false);
    setModelUnavailable(false);
    setPendingUserText(text);
    setStreamText('');
    setStreaming(true);
    try {
      const accepted = await window.cultivation.chat.send({
        requestId,
        teammateId,
        conversationId,
        text,
      });
      if (accepted.requestId !== requestId || accepted.conversationId !== conversationId) {
        throw new Error('消息上下文校验失败，请重试。');
      }
    } catch (cause) {
      const active = activeRequest.current;
      if (active.requestId !== requestId) return;
      activeRequest.current = { ...active, requestId: null, pendingText: '' };
      setStreaming(false);
      setPendingUserText('');
      setStreamText('');
      setDraft((current) => current || text);
      setError(errorText(cause, '发送消息失败。'));
    }
  };

  const extractMemoryCandidate = async (message: MessageView) => {
    if (!teammate || !conversationId || message.conversationId !== conversationId) return;
    setExtractingMessageId(message.id);
    setError('');
    setNotice('');
    setCandidateReady(false);
    try {
      const candidates = await window.cultivation.memories.proposeFromMessage({
        teammateId: teammate.id,
        conversationId,
        messageId: message.id,
      });
      setCandidateReady(candidates.length > 0);
      setNotice(
        candidates.length > 0
          ? `已为${teammate.name}整理出 ${candidates.length} 条记忆候选，确认后才会保存。`
          : '这条消息里没有需要长期保存的内容。',
      );
    } catch (cause) {
      setError(errorText(cause, '提取记忆候选失败；当前对话不受影响。'));
    } finally {
      setExtractingMessageId('');
    }
  };

  const recheckAvailability = async () => {
    if (!teammate || !canRecheckAvailability(teammate)) return;
    setRecheckingAvailability(true);
    setError('');
    try {
      await window.cultivation.availability.recheck(teammate.id);
      setAvailabilityRefresh((current) => current + 1);
      setModelUnavailable(false);
    } catch (cause) {
      setError(errorText(cause, '检测失败，请稍后重试。'));
    } finally {
      setRecheckingAvailability(false);
    }
  };

  const currentRuntime = teammate?.currentRuntimeProfileId
    ? runtimes.find((item) => item.id === teammate.currentRuntimeProfileId)
    : undefined;
  const humanBridge = teammate ? isHumanBridge(teammate) : false;
  const activeSummary = summarizeMessages(messages);
  const noConversation = conversations.length === 0;

  if (!loading && !teammate) {
    return (
      <section className="r33-chat-page r33-chat-not-found" data-testid="chat-page">
        <div className="r33-not-found-panel">
          <Icon name="User" size={30} />
          <h1>找不到这位道友</h1>
          <p>此道友可能已删除，或暂时无法读取。</p>
          <button className="button secondary" onClick={() => navigate('/teammates')}>
            返回道友列表
          </button>
        </div>
      </section>
    );
  }

  const conversationList = (
    <aside
      className={`r33-conversation-list ${conversationDrawerOpen ? 'is-open' : ''}`}
      aria-label="对话列表"
      data-testid="conversation-list"
    >
      <div className="r33-list-heading">
        <div>
          <div className="r33-list-title">
            <Icon name="Chat" size={17} />
            <h2>对话</h2>
          </div>
          <p>{conversations.length} 段交流</p>
        </div>
        {conversations.length > 0 && (
          <button
            className="r33-icon-button"
            type="button"
            aria-label="开始新对话"
            title="开始新对话"
            disabled={!teammate || teammate.status !== 'ACTIVE' || streaming}
            onClick={() => void createConversation()}
          >
            <Icon name="Add" size={18} />
          </button>
        )}
      </div>
      {conversations.length > 0 ? (
        <div className="r33-conversation-items">
          {conversations.map((conversation, index) => {
            const selected = conversation.id === conversationId;
            const summary =
              selected && activeSummary ? activeSummary : `对话 ${conversations.length - index}`;
            return (
              <button
                key={conversation.id}
                type="button"
                className={`r33-conversation-item ${selected ? 'is-selected' : ''}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => void selectConversation(conversation.id)}
              >
                <span className="r33-conversation-copy">
                  <strong>{summary}</strong>
                  <time dateTime={conversation.updatedAt}>
                    {conversationTime(conversation.updatedAt)}
                  </time>
                </span>
                {selected && <span className="r33-selected-mark" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="r33-sidebar-empty">还没有对话</p>
      )}
    </aside>
  );

  return (
    <section className="r33-chat-page" data-testid="chat-page">
      <header className="r33-chat-header" data-testid="chat-header">
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
            kind={humanBridge ? 'HUMAN_BRIDGE' : 'TEAMMATE'}
            size={44}
            className="r33-header-avatar"
          />
        )}
        <div className="r33-chat-identity">
          <strong>{teammate?.name ?? '正在打开对话'}</strong>
          <div className="r33-chat-subtitle">
            {humanBridge ? (
              <span>本尊 · 外部工作待办</span>
            ) : teammate?.status === 'ARCHIVED' ? (
              <span className="r33-status-pill archived">已归档</span>
            ) : (
              <span className="r33-model-name">
                {currentRuntime?.modelId ??
                  (teammate?.currentRuntimeProfileId ? '模型不可读取' : '尚未配置模型')}
              </span>
            )}
          </div>
        </div>
        {teammate && canRecheckAvailability(teammate) && (
          <div className="r33-header-availability" key={`${teammate.id}:${availabilityRefresh}`}>
            <AvailabilityBadge
              teammateId={teammate.id}
              teammateStatus={teammate.status}
              executorKind={teammate.executorKind ?? 'MODEL_RUNTIME'}
              recheck={!modelUnavailable}
            />
          </div>
        )}
        {teammate && !humanBridge && (
          <button
            className="r33-header-action"
            type="button"
            onClick={() => navigate('/teammates')}
          >
            查看道友
          </button>
        )}
        {!humanBridge && (
          <button
            className="r33-mobile-list-toggle"
            type="button"
            aria-label={conversationDrawerOpen ? '收起对话列表' : '展开对话列表'}
            aria-expanded={conversationDrawerOpen}
            onClick={() => setConversationDrawerOpen((open) => !open)}
          >
            <Icon name="Panel" size={18} />
            <span>对话</span>
          </button>
        )}
      </header>

      {humanBridge ? (
        <div className="r33-human-bridge" data-testid="chat-human-bridge">
          {teammate && (
            <Avatar avatar={teammate.avatar} name={teammate.name} kind="HUMAN_BRIDGE" size={84} />
          )}
          <div className="r33-human-bridge-copy">
            <h1>本尊待办</h1>
            <p>查看委托并提交处理结果。</p>
            <button className="button primary" onClick={() => navigate('/external-work')}>
              查看本尊待办 <Icon name="ArrowUp" size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className="r33-chat-workspace">
          {!narrow && conversationList}
          {narrow && (
            <Drawer
              title="对话列表"
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
              aria-label="消息记录"
              aria-busy={streaming}
              ref={messageStreamRef}
              data-testid="message-stream"
            >
              {loading ? (
                <div className="r33-loading-state" role="status">
                  <span className="r33-loading-dot" /> 正在读取对话
                </div>
              ) : noConversation ? (
                <div className="r33-empty-state" data-testid="empty-chat">
                  {teammate && (
                    <Avatar
                      avatar={teammate.avatar}
                      name={teammate.name}
                      kind="TEAMMATE"
                      size={88}
                    />
                  )}
                  <h1>和{teammate?.name ?? '这位道友'}开始交流</h1>
                  {teammate?.status === 'ACTIVE' && (
                    <button className="button primary" onClick={() => void createConversation()}>
                      开始新对话 <Icon name="ArrowUp" size={16} />
                    </button>
                  )}
                  {teammate?.status === 'ARCHIVED' && (
                    <span className="r33-archived-hint">这位道友已归档，无法开始新对话。</span>
                  )}
                </div>
              ) : messages.length === 0 && !pendingUserText ? (
                <div className="r33-conversation-empty" data-testid="empty-conversation">
                  {teammate && (
                    <Avatar
                      avatar={teammate.avatar}
                      name={teammate.name}
                      kind="TEAMMATE"
                      size={54}
                    />
                  )}
                  <span>向{teammate?.name ?? '这位道友'}问好吧。</span>
                </div>
              ) : (
                <div className="r33-message-list">
                  {messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      teammate={teammate}
                      onExtract={extractMemoryCandidate}
                      extracting={extractingMessageId === message.id}
                    />
                  ))}
                  {pendingUserText && (
                    <MessageBubble
                      message={{
                        id: 'pending-user-message',
                        actorType: 'USER',
                        actorId: 'user',
                        role: 'USER',
                        missionId: null,
                        conversationId,
                        content: pendingUserText,
                        createdAt: new Date().toISOString(),
                      }}
                      teammate={teammate}
                      pending
                    />
                  )}
                  {streaming && <StreamingMessage teammate={teammate} content={streamText} />}
                </div>
              )}
            </div>

            {error && (
              <div
                className={`r33-inline-notice is-error ${modelUnavailable ? 'is-unavailable' : ''}`}
                role="alert"
                data-testid={modelUnavailable ? 'unavailable-notice' : 'chat-error'}
              >
                <Icon name="Alert" size={17} />
                <span className="r33-notice-copy">{error}</span>
                {modelUnavailable ? (
                  <div className="r33-notice-actions">
                    {canRecheckAvailability(teammate) && (
                      <button
                        type="button"
                        className="r33-inline-action"
                        disabled={recheckingAvailability}
                        onClick={() => void recheckAvailability()}
                      >
                        {recheckingAvailability ? '检测中…' : '重新检测'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="r33-inline-action"
                      onClick={() => navigate('/teammates')}
                    >
                      选择其他道友
                    </button>
                    <button
                      type="button"
                      className="r33-inline-action"
                      onClick={() => {
                        setError('');
                        setModelUnavailable(false);
                      }}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            )}

            {notice && (
              <div
                className="r33-inline-notice is-memory"
                role="status"
                data-testid="memory-notice"
              >
                <Icon name="Memory" size={17} />
                <span className="r33-notice-copy">{notice}</span>
                {candidateReady && (
                  <button
                    className="r33-inline-action"
                    type="button"
                    onClick={() => navigate(`/memory?teammateId=${encodeURIComponent(teammateId)}`)}
                  >
                    审核记忆
                  </button>
                )}
              </div>
            )}

            <form
              className="r33-composer"
              onSubmit={(event) => void send(event)}
              data-testid="chat-composer"
            >
              <label className="r33-visually-hidden" htmlFor="chat-message">
                写消息
              </label>
              <textarea
                id="chat-message"
                rows={3}
                value={draft}
                aria-label="写消息"
                disabled={!conversationId || !teammate || !canChat(teammate) || streaming}
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
                  {teammate?.status === 'ARCHIVED'
                    ? '此道友已归档，无法发送新消息'
                    : !conversationId
                      ? '开始新对话后即可发送消息'
                      : streaming
                        ? '正在生成回复…'
                        : 'Enter 发送 · Shift+Enter 换行'}
                </span>
                <button
                  className="button primary r33-send-button"
                  type="submit"
                  disabled={
                    !draft.trim() || !conversationId || !teammate || !canChat(teammate) || streaming
                  }
                >
                  {streaming ? '生成中' : '发送'}
                  <Icon name={streaming ? 'Refresh' : 'ArrowUp'} size={16} />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export function MessageBubble({
  message,
  teammate,
  onExtract,
  extracting = false,
  pending = false,
}: {
  message: MessageView;
  teammate: TeammateView | null;
  onExtract?: (message: MessageView) => void;
  extracting?: boolean;
  pending?: boolean;
}) {
  const isUser = message.role === 'USER';
  const isAssistant = message.role === 'ASSISTANT';
  if (!isUser && !isAssistant) {
    return (
      <div className="r33-event-row" data-testid="system-message">
        <Icon name={message.role === 'TOOL' ? 'Tool' : 'Alert'} size={16} />
        <span className="r33-event-label">{message.role === 'TOOL' ? '工具动态' : '系统提示'}</span>
        <MessageContent content={message.content} />
      </div>
    );
  }

  const speaker = isUser ? '你' : (teammate?.name ?? '道友');
  return (
    <article className={`r33-message-row ${isUser ? 'is-user' : 'is-assistant'}`}>
      {!isUser && teammate && (
        <Avatar
          avatar={teammate.avatar}
          name={teammate.name}
          kind="TEAMMATE"
          size={34}
          className="r33-message-avatar"
        />
      )}
      <div className="r33-message-body">
        <div className="r33-message-meta">
          <strong>{speaker}</strong>
          <time dateTime={message.createdAt}>
            {pending ? '发送中' : formatTime(message.createdAt)}
          </time>
        </div>
        <div className={`r33-message-surface ${isUser ? 'is-user' : 'is-assistant'}`}>
          <MessageContent content={message.content} />
        </div>
        {!pending && onExtract && message.missionId === null && (
          <button
            className="r33-memory-action"
            disabled={extracting}
            onClick={() => onExtract(message)}
            type="button"
          >
            <Icon name="Memory" size={14} />
            {extracting ? '整理中…' : '保存为记忆候选'}
          </button>
        )}
      </div>
      {isUser && (
        <Avatar kind="USER" name="你" size={34} className="r33-message-avatar r33-user-avatar" />
      )}
    </article>
  );
}

function StreamingMessage({
  teammate,
  content,
}: {
  teammate: TeammateView | null;
  content: string;
}) {
  return (
    <article className="r33-message-row is-assistant is-streaming" data-testid="streaming-message">
      {teammate && (
        <Avatar
          avatar={teammate.avatar}
          name={teammate.name}
          kind="TEAMMATE"
          size={34}
          className="r33-message-avatar"
        />
      )}
      <div className="r33-message-body">
        <div className="r33-message-meta">
          <strong>{teammate?.name ?? '道友'}</strong>
          <span className="r33-stream-status">
            <span className="r33-stream-dot" /> {content ? '正在回复…' : '正在生成…'}
          </span>
        </div>
        <div className="r33-message-surface is-assistant">
          {content ? (
            <MessageContent content={content} />
          ) : (
            <span className="r33-thinking">正在生成…</span>
          )}
        </div>
      </div>
    </article>
  );
}

function isHumanBridge(teammate: TeammateView): boolean {
  return teammate.executorKind === 'USER_BRIDGE' || teammate.systemKind === 'HUMAN_BRIDGE';
}

function canChat(teammate: TeammateView): boolean {
  return teammate.status === 'ACTIVE' && !isHumanBridge(teammate);
}

function canRecheckAvailability(teammate: TeammateView | null): teammate is TeammateView {
  return Boolean(
    teammate &&
      teammate.status === 'ACTIVE' &&
      teammate.executorKind !== 'USER_BRIDGE' &&
      teammate.systemKind !== 'HUMAN_BRIDGE' &&
      teammate.currentRuntimeProfileId,
  );
}

function summarizeMessages(messages: MessageView[]): string {
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === 'USER' || message.role === 'ASSISTANT');
  if (!latest) return '';
  const normalized = latest.content
    .replace(/```[\s\S]*?```/g, '代码片段')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized;
}

function conversationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}
