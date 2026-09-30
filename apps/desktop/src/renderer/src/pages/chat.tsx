import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import { errorText, makeId, PageHeading, formatDate, formatTime } from '../ui-shared.js';
import type {
  TeammateView,
  ConversationView,
  MessageView,
  RuntimeProfileView,
} from '../ui-shared.js';

export function ChatPage() {
  const [availabilityRefresh, setAvailabilityRefresh] = useState(0);
  const [modelUnavailable, setModelUnavailable] = useState(false);
  const { teammateId = '' } = useParams();
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
  const activeRequest = useRef<{
    requestId: string | null;
    teammateId: string;
    conversationId: string;
  }>({ requestId: null, teammateId, conversationId: '' });
  const navigate = useNavigate();

  const refreshConversations = async (forTeammateId: string) => {
    const rows = await window.cultivation.chat.listConversations(forTeammateId);
    setConversations(rows);
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
    setConversationId('');
    setMessages([]);
    setStreaming(false);
    setStreamText('');
    setPendingUserText('');
    activeRequest.current = { requestId: null, teammateId, conversationId: '' };
    void Promise.all([
      window.cultivation.teammates.list(),
      window.cultivation.chat.listConversations(teammateId),
      window.cultivation.runtimes.list(),
    ])
      .then(([teammates, rows, runtimeRows]) => {
        if (cancelled) return;
        const found = teammates.find((item) => item.id === teammateId) ?? null;
        setTeammate(found);
        setRuntimes(runtimeRows);
        setConversations(rows);
        const initialConversationId = rows[0]?.id ?? '';
        setConversationId(initialConversationId);
        activeRequest.current = {
          requestId: null,
          teammateId,
          conversationId: initialConversationId,
        };
        if (initialConversationId) {
          void window.cultivation.chat
            .listMessages({ teammateId, conversationId: initialConversationId })
            .then((items) => {
              if (!cancelled) setMessages(items);
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
  }, [teammateId]);

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
        setError(event.message || '生成回复失败。');
        setStreaming(false);
        setPendingUserText('');
        setStreamText('');
        activeRequest.current = { ...active, requestId: null };
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
      activeRequest.current = { ...active, requestId: null };
      void refreshMessages(event.teammateId, event.conversationId).catch(() => undefined);
    });
    return unsubscribe;
  }, []);

  const selectConversation = async (id: string) => {
    activeRequest.current = { requestId: null, teammateId, conversationId: id };
    setConversationId(id);
    setMessages([]);
    setStreaming(false);
    setError('');
    setStreamText('');
    setPendingUserText('');
    setCandidateReady(false);
    try {
      await refreshMessages(teammateId, id);
    } catch (cause) {
      setError(errorText(cause, '读取消息失败。'));
    }
  };
  const createConversation = async () => {
    setError('');
    setNotice('');
    setCandidateReady(false);
    try {
      const created = await window.cultivation.chat.createConversation(teammateId);
      const rows = await refreshConversations(teammateId);
      setConversationId(created.id);
      setMessages([]);
      setStreaming(false);
      activeRequest.current = { requestId: null, teammateId, conversationId: created.id };
      setNotice(`已创建 Conversation ${created.id.slice(0, 8)}。`);
      if (!rows.some((item) => item.id === created.id))
        setConversations((current) => [created, ...current]);
    } catch (cause) {
      setError(errorText(cause, '创建对话失败。'));
    }
  };
  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !conversationId || !teammate || streaming || teammate.status !== 'ACTIVE') return;
    const requestId = makeId();
    activeRequest.current = { requestId, teammateId, conversationId };
    setDraft('');
    setError('');
    setNotice('');
    setCandidateReady(false);
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
      if (activeRequest.current.requestId !== requestId) return;
      activeRequest.current = { requestId: null, teammateId, conversationId };
      setStreaming(false);
      setPendingUserText('');
      setStreamText('');
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
          ? `已为 ${teammate.name} 创建 ${candidates.length} 条待确认的记忆候选。`
          : '未发现值得保存的长期记忆。',
      );
    } catch (cause) {
      setError(errorText(cause, '提取记忆候选失败；当前对话不受影响。'));
    } finally {
      setExtractingMessageId('');
    }
  };

  if (!loading && !teammate) {
    return (
      <section className="page">
        <PageHeading
          eyebrow="单道友 Conversation"
          title="找不到道友"
          description="此道友可能已删除或 ID 不存在。"
        />
        <p role="alert">道友不存在或当前无法读取，请返回列表重试。</p>
        <button className="button secondary" onClick={() => navigate('/teammates')}>
          返回道友列表
        </button>
      </section>
    );
  }
  const runtimeBadge =
    teammate && teammate.currentRuntimeProfileId
      ? (runtimes.find((item) => item.id === teammate.currentRuntimeProfileId)?.modelId ??
        '模型不可读取')
      : '尚未配置 Runtime';
  return (
    <section className="page wide-page chat-page">
      <PageHeading
        eyebrow="持续对话 · Conversation"
        title={teammate?.name ?? '正在打开对话'}
        description="这是道友的独立 Conversation，不属于 Mission；日常交流与任务执行分别保存。"
      />
      {teammate && (
        <div className="chat-context">
          <button className="back-link" onClick={() => navigate('/teammates')}>
            ‹ 道友列表
          </button>
          <span className="chat-context-avatar">
            {teammate.avatar || teammate.name.slice(0, 1)}
          </span>
          <div className="chat-context-copy">
            <strong>{teammate.name}</strong>
            <small>{runtimeBadge}</small>
          </div>
          {teammate.status === 'ARCHIVED' && <span className="status-pill archived">已归档</span>}
          {teammate.executorKind !== 'USER_BRIDGE' && (
            <AvailabilityBadge
              key={`${teammate.id}:${availabilityRefresh}`}
              teammateId={teammate.id}
            />
          )}
        </div>
      )}
      <div className="chat-shell">
        <aside className="conversation-sidebar">
          <div className="list-heading">
            <div>
              <h2>Conversation</h2>
              <p>{conversations.length} 个会话</p>
            </div>
            <button
              className="icon-button"
              aria-label="新建 Conversation"
              disabled={!teammate || teammate.status !== 'ACTIVE'}
              onClick={() => void createConversation()}
            >
              ＋
            </button>
          </div>
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`conversation-item ${conversation.id === conversationId ? 'selected' : ''}`}
              onClick={() => void selectConversation(conversation.id)}
            >
              <strong>对话 {conversation.id.slice(0, 8)}</strong>
              <small>{formatDate(conversation.updatedAt)}</small>
            </button>
          ))}
          {!conversations.length && !loading && (
            <p className="sidebar-empty">创建一个 Conversation，开始持续交流。</p>
          )}
        </aside>
        <div className="chat-main">
          <div className="message-list" aria-live="polite">
            {loading ? (
              <div className="chat-empty">正在读取会话…</div>
            ) : !conversationId ? (
              <div className="chat-empty">
                <span className="empty-icon">◌</span>
                <h3>开始一段独立对话</h3>
                <p>
                  Conversation 会归属于 {teammate?.name ?? '此道友'}，和未来的 Mission 分开保存。
                </p>
                {teammate?.status === 'ACTIVE' && (
                  <button className="button primary" onClick={() => void createConversation()}>
                    新建 Conversation
                  </button>
                )}
              </div>
            ) : messages.length === 0 && !pendingUserText ? (
              <div className="chat-empty">
                <span className="empty-icon">✦</span>
                <h3>向 {teammate?.name ?? '道友'} 问好</h3>
                <p>此会话的消息会持续保存，并始终归属于当前道友。</p>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onExtract={extractMemoryCandidate}
                  extracting={extractingMessageId === message.id}
                />
              ))
            )}
            {pendingUserText && (
              <div className="message-row user-message">
                <div className="message-bubble">
                  <p>{pendingUserText}</p>
                  <small>发送中</small>
                </div>
              </div>
            )}
            {streaming && (
              <div className="message-row assistant-message">
                <span className="message-avatar">{teammate?.avatar || '友'}</span>
                <div className="message-bubble">
                  <p>{streamText || <span className="typing-indicator">正在思考…</span>}</p>
                  <small>流式回复</small>
                </div>
              </div>
            )}
            <div id="message-bottom" />
          </div>
          {error && (
            <div className="chat-error" role="alert">
              {error}
              {modelUnavailable && (
                <span className="button-row compact">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => navigate('/teammates')}
                  >
                    选择其他道友
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setError('');
                      setModelUnavailable(false);
                    }}
                  >
                    取消
                  </button>
                </span>
              )}
            </div>
          )}
          {notice && (
            <div className="chat-notice" role="status">
              {notice}
              {candidateReady && (
                <button
                  className="text-button"
                  onClick={() => navigate(`/memory?teammateId=${encodeURIComponent(teammateId)}`)}
                >
                  前往审核
                </button>
              )}
            </div>
          )}
          <form className="composer" onSubmit={(event) => void send(event)}>
            <label htmlFor="chat-message">消息</label>
            <textarea
              id="chat-message"
              rows={3}
              value={draft}
              disabled={!conversationId || !teammate || teammate.status !== 'ACTIVE' || streaming}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-footer">
              <span>{streaming ? '正在接收回复…' : 'Enter 发送 · Shift+Enter 换行'}</span>
              <button
                className="button primary send-button"
                disabled={
                  !draft.trim() ||
                  !conversationId ||
                  !teammate ||
                  teammate.status !== 'ACTIVE' ||
                  streaming
                }
              >
                {streaming ? '生成中…' : '发送'} <span aria-hidden="true">↗</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

export function MessageBubble({
  message,
  onExtract,
  extracting = false,
}: {
  message: MessageView;
  onExtract?: (message: MessageView) => void;
  extracting?: boolean;
}) {
  const isUser = message.role === 'USER';
  const isAssistant = message.role === 'ASSISTANT';
  return (
    <div className={`message-row ${isUser ? 'user-message' : 'assistant-message'}`}>
      {!isUser && <span className="message-avatar">{isAssistant ? '友' : '系'}</span>}
      <div className="message-bubble">
        <p>{message.content}</p>
        <small>
          {isUser ? '你' : isAssistant ? '道友' : message.role} · {formatTime(message.createdAt)}
        </small>
        {onExtract && (isUser || isAssistant) && message.missionId === null && (
          <button
            className="message-memory-action"
            disabled={extracting}
            onClick={() => onExtract(message)}
            type="button"
          >
            {extracting ? '正在生成候选…' : '提取为记忆候选'}
          </button>
        )}
      </div>
      {message.missionId !== null && <span className="safe-tag">Mission</span>}
    </div>
  );
}
