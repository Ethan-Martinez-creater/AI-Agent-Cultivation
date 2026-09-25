import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HashRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom';
import './style.css';

type ProviderKind = 'OPENAI' | 'ANTHROPIC' | 'GOOGLE' | 'DEEPSEEK' | 'OPENAI_COMPATIBLE';
type TeammateStatus = 'ACTIVE' | 'ARCHIVED';
type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';

interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
}

interface CredentialView {
  id: string;
  providerId: string;
  label: string;
}

interface RuntimeProfileView {
  id: string;
  name: string;
  providerId: string;
  credentialId: string | null;
  modelId: string;
}

interface TeammateView {
  id: string;
  name: string;
  avatar: string | null;
  title: string | null;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
  currentRuntimeProfileId: string | null;
  status: TeammateStatus;
}

interface ConversationView {
  id: string;
  teammateId: string;
  createdAt: string;
  updatedAt: string;
}

interface MessageView {
  id: string;
  missionId: string | null;
  conversationId: string;
  actorType: 'USER' | 'TEAMMATE' | 'SYSTEM';
  actorId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

interface UsageView {
  teammateId: string;
  runtimeProfileId: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

interface ChatEvent {
  type: 'delta' | 'done' | 'error';
  requestId: string;
  teammateId: string;
  conversationId: string;
  text?: string;
  assistantMessage?: MessageView;
  message?: string;
}

interface CultivationBridge {
  app: { getVersion(): Promise<string> };
  health: { ping(): Promise<{ status: string; database: string }> };
  providers: {
    list(): Promise<ProviderView[]>;
    create(input: { name: string; kind: ProviderKind; baseUrl?: string }): Promise<ProviderView>;
  };
  credentials: {
    list(providerId?: string): Promise<CredentialView[]>;
    create(input: { providerId: string; label: string }): Promise<CredentialView>;
  };
  runtimes: {
    list(): Promise<RuntimeProfileView[]>;
    create(input: {
      name: string;
      providerId: string;
      credentialId: string | null;
      modelId: string;
    }): Promise<RuntimeProfileView>;
    update(input: {
      id: string;
      name: string;
      providerId: string;
      credentialId: string | null;
      modelId: string;
    }): Promise<RuntimeProfileView>;
    testConnection(runtimeProfileId: string): Promise<{ ok: boolean; message: string }>;
  };
  teammates: {
    list(): Promise<TeammateView[]>;
    create(input: Omit<TeammateView, 'id' | 'status'>): Promise<TeammateView>;
    update(input: Omit<TeammateView, 'status'>): Promise<TeammateView>;
    archive(id: string): Promise<TeammateView>;
    duplicate(id: string): Promise<TeammateView>;
    switchRuntime(input: { teammateId: string; runtimeProfileId: string }): Promise<TeammateView>;
  };
  chat: {
    listConversations(teammateId: string): Promise<ConversationView[]>;
    createConversation(teammateId: string): Promise<ConversationView>;
    listMessages(input: { teammateId: string; conversationId: string }): Promise<MessageView[]>;
    send(input: {
      requestId: string;
      teammateId: string;
      conversationId: string;
      text: string;
    }): Promise<{ requestId: string; conversationId: string }>;
    onEvent(callback: (event: ChatEvent) => void): () => void;
  };
  usage: { list(teammateId?: string): Promise<UsageView[]> };
}

declare global {
  interface Window {
    cultivation: CultivationBridge;
  }
}

const pages = [
  ['/', '洞府 Home', '你的本地工作台。管理长期道友并继续上次的对话。'],
  ['/teammates', '道友 Teammates', '创建道友身份，选择运行配置并开启持续对话。'],
  ['/parties', '队伍 Parties', '多道友协作将在后续阶段接入。'],
  ['/missions', '历练 Missions', 'Mission Runtime 将在后续阶段接入。'],
  ['/skills', '功法 Skills', 'Gate 2 · 技能管理将在后续阶段接入。'],
  ['/tools', '法宝 Tools', 'Tool 与 MCP 将在后续阶段接入。'],
  ['/memory', '记忆 Memory', 'Gate 2 · 长期记忆将在后续阶段接入。'],
  ['/usage', '灵石 Usage', '按道友和运行配置查看模型调用用量。'],
  ['/settings', '设置 Settings', '管理服务商、凭据和运行配置。'],
] as const;

const providerKinds: { value: ProviderKind; label: string }[] = [
  { value: 'OPENAI', label: 'OpenAI' },
  { value: 'ANTHROPIC', label: 'Anthropic' },
  { value: 'GOOGLE', label: 'Google' },
  { value: 'DEEPSEEK', label: 'DeepSeek' },
  { value: 'OPENAI_COMPATIBLE', label: 'OpenAI Compatible' },
];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function makeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function App() {
  const [version, setVersion] = useState('…');
  const [health, setHealth] = useState('检查中');
  const [bridgeReady, setBridgeReady] = useState(true);
  useEffect(() => {
    if (!window.cultivation?.app || !window.cultivation?.health) {
      setBridgeReady(false);
      setHealth('功能接口未连接');
      return;
    }
    void window.cultivation.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('未知'));
    void window.cultivation.health
      .ping()
      .then((result) => setHealth(result.status === 'ok' ? '本地数据库正常' : '数据库异常'))
      .catch(() => setHealth('数据库异常'));
  }, []);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">修</span>
          <div>
            <strong>AI Agent Cultivation</strong>
            <small>长期 AI 队友</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {pages.map(([path, label]) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={health === '本地数据库正常' ? 'status-dot' : 'status-dot muted'} />
          {health}
          <small>v{version}</small>
        </div>
      </aside>
      <main>
        {!bridgeReady && (
          <div className="notice error" role="status">
            Main Process 功能接口尚未连接。请重新启动应用后重试。
          </div>
        )}
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/teammates" element={<TeammatesPage />} />
          <Route path="/chat/:teammateId" element={<ChatPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route
            path="/parties"
            element={<PlaceholderPage title="队伍 Parties" description={pages[2][2]} />}
          />
          <Route
            path="/missions"
            element={<PlaceholderPage title="历练 Missions" description={pages[3][2]} />}
          />
          <Route
            path="/skills"
            element={<PlaceholderPage title="功法 Skills" description={pages[4][2]} />}
          />
          <Route
            path="/tools"
            element={<PlaceholderPage title="法宝 Tools" description={pages[5][2]} />}
          />
          <Route
            path="/memory"
            element={<PlaceholderPage title="记忆 Memory" description={pages[6][2]} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="page-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="page-description">{description}</p>
    </header>
  );
}

function HomePage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  useEffect(() => {
    void window.cultivation.teammates
      .list()
      .then((items) => setTeammates(items.filter((item) => item.status === 'ACTIVE')))
      .catch(() => setTeammates([]));
  }, []);
  const navigate = useNavigate();
  return (
    <section className="page wide-page">
      <PageHeading
        eyebrow="Gate 1 · 单道友对话"
        title="洞府 Home"
        description="你的道友保留稳定身份。模型和服务商通过运行配置切换。"
      />
      <div className="home-banner">
        <div>
          <span className="banner-kicker">当前阶段</span>
          <h2>和一位道友持续交流</h2>
          <p>创建道友、配置运行模型，然后从独立 Conversation 开始聊天。</p>
        </div>
        <button className="button primary" onClick={() => navigate('/teammates')}>
          管理道友
        </button>
      </div>
      <div className="section-heading">
        <div>
          <h2>我的道友</h2>
          <p>Conversation 属于道友身份，切换运行配置不会更改身份或历史。</p>
        </div>
        <span className="count-badge">{teammates.length}</span>
      </div>
      {teammates.length ? (
        <div className="teammate-grid">
          {teammates.map((teammate) => (
            <button
              key={teammate.id}
              className="teammate-card"
              onClick={() => navigate(`/chat/${encodeURIComponent(teammate.id)}`)}
            >
              <span className="avatar">{teammate.avatar || teammate.name.slice(0, 1)}</span>
              <span className="teammate-card-copy">
                <strong>{teammate.name}</strong>
                <small>{teammate.title || '道友'}</small>
              </span>
              <span className="card-arrow">›</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-card">
          <span className="empty-icon">◇</span>
          <h3>还没有道友</h3>
          <p>先添加服务商与凭据，再创建 Runtime Profile 和道友。</p>
          <div className="button-row centered">
            <button className="button secondary" onClick={() => navigate('/settings')}>
              配置模型
            </button>
            <button className="button primary" onClick={() => navigate('/teammates')}>
              创建道友
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <section className="page">
      <PageHeading eyebrow="后续阶段" title={title} description={description} />
      <div className="empty-card subdued">
        <span className="empty-icon">◇</span>
        <p>此功能不属于 Gate 1。</p>
      </div>
    </section>
  );
}

type SettingsTab = 'providers' | 'credentials' | 'runtimes';

function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('providers');
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [providerRows, credentialRows, runtimeRows] = await Promise.all([
        window.cultivation.providers.list(),
        window.cultivation.credentials.list(),
        window.cultivation.runtimes.list(),
      ]);
      setProviders(providerRows);
      setCredentials(credentialRows);
      setRuntimes(runtimeRows);
    } catch (cause) {
      setError(errorText(cause, '读取设置失败。'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <section className="page wide-page">
      <PageHeading
        eyebrow="Provider · Credential · RuntimeProfile"
        title="设置 Settings"
        description="Main Process 从剪贴板读取并加密密钥。Renderer 不接收明文或密文。"
      />
      <div className="settings-summary">
        <SummaryMetric label="服务商" value={providers.length} />
        <SummaryMetric label="凭据" value={credentials.length} />
        <SummaryMetric label="运行配置" value={runtimes.length} />
      </div>
      <div className="tab-list" role="tablist" aria-label="设置类别">
        {(
          [
            ['providers', '服务商'],
            ['credentials', '凭据'],
            ['runtimes', 'Runtime Profiles'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'tab active' : 'tab'}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="loading-card">正在读取设置…</div>
      ) : (
        <div className="settings-content">
          {tab === 'providers' && <ProvidersPanel providers={providers} onCreated={refresh} />}
          {tab === 'credentials' && (
            <CredentialsPanel providers={providers} credentials={credentials} onCreated={refresh} />
          )}
          {tab === 'runtimes' && (
            <RuntimesPanel
              providers={providers}
              credentials={credentials}
              runtimes={runtimes}
              onChanged={refresh}
            />
          )}
        </div>
      )}
    </section>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="summary-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProvidersPanel({
  providers,
  onCreated,
}: {
  providers: ProviderView[];
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProviderKind>('OPENAI');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await window.cultivation.providers.create({
        name: name.trim(),
        kind,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setName('');
      setBaseUrl('');
      setSuccess('服务商已添加。');
      await onCreated();
    } catch (cause) {
      setError(errorText(cause, '添加服务商失败。'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel-grid">
      <form className="form-card" onSubmit={(event) => void submit(event)}>
        <h2>添加服务商</h2>
        <p className="muted-copy">
          服务商定义 Provider 类型；实际模型 ID 在 Runtime Profile 中填写。
        </p>
        <label className="field">
          <span>显示名称</span>
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：个人 OpenAI"
          />
        </label>
        <label className="field">
          <span>Provider</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as ProviderKind)}>
            {providerKinds.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            Base URL <small>{kind === 'OPENAI_COMPATIBLE' ? '兼容服务必填' : '选填'}</small>
          </span>
          <input
            type="url"
            required={kind === 'OPENAI_COMPATIBLE'}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </label>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {success && <InlineMessage tone="success">{success}</InlineMessage>}
        <button className="button primary" disabled={busy}>
          {busy ? '保存中…' : '添加服务商'}
        </button>
      </form>
      <div className="list-card">
        <div className="list-heading">
          <h2>已配置服务商</h2>
          <span className="count-badge">{providers.length}</span>
        </div>
        {providers.length ? (
          providers.map((provider) => (
            <div className="data-row" key={provider.id}>
              <span className="provider-mark">{provider.kind.slice(0, 2)}</span>
              <span className="data-row-copy">
                <strong>{provider.name}</strong>
                <small>
                  {providerKinds.find((item) => item.value === provider.kind)?.label ??
                    provider.kind}
                  {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                </small>
              </span>
            </div>
          ))
        ) : (
          <EmptyList text="添加首个 Provider 后，可继续保存凭据。" />
        )}
      </div>
    </div>
  );
}

function CredentialsPanel({
  providers,
  credentials,
  onCreated,
}: {
  providers: ProviderView[];
  credentials: CredentialView[];
  onCreated: () => Promise<void>;
}) {
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useEffect(() => {
    if (!providerId && providers[0]) setProviderId(providers[0].id);
  }, [providerId, providers]);
  const visibleCredentials = credentials.filter(
    (item) => !providerId || item.providerId === providerId,
  );
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!providerId) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await window.cultivation.credentials.create({ providerId, label: label.trim() });
      setLabel('');
      setSuccess('凭据已加密保存，剪贴板已清空。');
      await onCreated();
    } catch {
      setError('保存凭据失败。请先复制 API Key，再检查服务商与系统加密服务。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel-grid">
      <form className="form-card" onSubmit={(event) => void submit(event)}>
        <h2>添加凭据</h2>
        <p className="muted-copy">
          先在其他应用复制 API Key，再点击保存。Main Process
          读取系统剪贴板并加密，随后清空剪贴板；密钥不会进入此页面。
        </p>
        <label className="field">
          <span>关联服务商</span>
          <select
            required
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          >
            <option value="">选择 Provider</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>凭据标签</span>
          <input
            required
            maxLength={80}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="例如：默认 API Key"
          />
        </label>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {success && <InlineMessage tone="success">{success}</InlineMessage>}
        <button className="button primary" disabled={busy || !providers.length}>
          {busy ? '加密保存中…' : '从剪贴板安全导入'}
        </button>
        {!providers.length && <p className="form-hint">请先添加服务商。</p>}
      </form>
      <div className="list-card">
        <div className="list-heading">
          <h2>已保存凭据</h2>
          <span className="count-badge">{visibleCredentials.length}</span>
        </div>
        <p className="muted-copy">此列表不包含密钥内容、密文或密钥预览。</p>
        {visibleCredentials.length ? (
          visibleCredentials.map((credential) => (
            <div className="data-row" key={credential.id}>
              <span className="secure-mark">✓</span>
              <span className="data-row-copy">
                <strong>{credential.label}</strong>
                <small>
                  {providers.find((item) => item.id === credential.providerId)?.name ?? 'Provider'}
                </small>
              </span>
              <span className="safe-tag">安全保存</span>
            </div>
          ))
        ) : (
          <EmptyList text="当前服务商尚未保存凭据。" />
        )}
      </div>
    </div>
  );
}

interface RuntimeForm {
  id: string;
  name: string;
  providerId: string;
  credentialId: string;
  modelId: string;
}

const blankRuntime: RuntimeForm = {
  id: '',
  name: '',
  providerId: '',
  credentialId: '',
  modelId: '',
};

function RuntimesPanel({
  providers,
  credentials,
  runtimes,
  onChanged,
}: {
  providers: ProviderView[];
  credentials: CredentialView[];
  runtimes: RuntimeProfileView[];
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState<RuntimeForm>(blankRuntime);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selectedCredentials = credentials.filter((item) => item.providerId === form.providerId);
  const update = (patch: Partial<RuntimeForm>) => setForm((current) => ({ ...current, ...patch }));
  const beginEdit = (runtime: RuntimeProfileView) => {
    setForm({ ...runtime, credentialId: runtime.credentialId ?? '' });
    setError('');
    setNotice('');
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const payload = {
      name: form.name.trim(),
      providerId: form.providerId,
      credentialId: form.credentialId || null,
      modelId: form.modelId.trim(),
    };
    try {
      if (form.id) await window.cultivation.runtimes.update({ id: form.id, ...payload });
      else await window.cultivation.runtimes.create(payload);
      setForm(blankRuntime);
      setNotice(form.id ? 'Runtime Profile 已更新。' : 'Runtime Profile 已创建。');
      await onChanged();
    } catch (cause) {
      setError(errorText(cause, '保存 Runtime Profile 失败。'));
    } finally {
      setBusy(false);
    }
  };
  const testConnection = async (id: string) => {
    setTestingId(id);
    setError('');
    setNotice('');
    try {
      const result = await window.cultivation.runtimes.testConnection(id);
      setNotice(`${result.ok ? '连接成功' : '连接失败'}：${result.message}`);
    } catch (cause) {
      setError(errorText(cause, '连接测试失败。'));
    } finally {
      setTestingId('');
    }
  };
  return (
    <div className="panel-grid">
      <form className="form-card" onSubmit={(event) => void submit(event)}>
        <div className="form-title-row">
          <div>
            <h2>{form.id ? '编辑 Runtime Profile' : '创建 Runtime Profile'}</h2>
            <p className="muted-copy">手工指定模型 ID；道友引用此配置而不持有 Provider 身份。</p>
          </div>
          {form.id && (
            <button type="button" className="text-button" onClick={() => setForm(blankRuntime)}>
              取消编辑
            </button>
          )}
        </div>
        <label className="field">
          <span>名称</span>
          <input
            required
            maxLength={80}
            value={form.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="例如：快速日常对话"
          />
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            required
            value={form.providerId}
            onChange={(event) => update({ providerId: event.target.value, credentialId: '' })}
          >
            <option value="">选择 Provider</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {provider.kind}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            凭据 <small>可选</small>
          </span>
          <select
            value={form.credentialId}
            onChange={(event) => update({ credentialId: event.target.value })}
          >
            <option value="">无需凭据</option>
            {selectedCredentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Model ID</span>
          <input
            required
            maxLength={160}
            value={form.modelId}
            onChange={(event) => update({ modelId: event.target.value })}
            placeholder="例如：gpt-4.1-mini"
          />
        </label>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        <button className="button primary" disabled={busy || providers.length === 0}>
          {busy ? '保存中…' : form.id ? '保存更改' : '创建运行配置'}
        </button>
        {providers.length === 0 && <p className="form-hint">请先配置 Provider 和凭据。</p>}
      </form>
      <div className="list-card">
        <div className="list-heading">
          <h2>运行配置</h2>
          <span className="count-badge">{runtimes.length}</span>
        </div>
        {runtimes.length ? (
          runtimes.map((runtime) => {
            const provider = providers.find((item) => item.id === runtime.providerId);
            const credential = credentials.find((item) => item.id === runtime.credentialId);
            return (
              <div className="runtime-item" key={runtime.id}>
                <div className="runtime-item-heading">
                  <span className="runtime-mark">R</span>
                  <div className="data-row-copy">
                    <strong>{runtime.name}</strong>
                    <small>
                      {provider?.name ?? 'Provider'} · {runtime.modelId}
                    </small>
                  </div>
                </div>
                <div className="runtime-meta">凭据：{credential?.label ?? '未找到'}</div>
                <div className="button-row compact">
                  <button className="button small secondary" onClick={() => beginEdit(runtime)}>
                    编辑
                  </button>
                  <button
                    className="button small ghost"
                    disabled={testingId === runtime.id}
                    onClick={() => void testConnection(runtime.id)}
                  >
                    {testingId === runtime.id ? '测试中…' : 'Test Connection'}
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <EmptyList text="创建 Provider、凭据后，添加首个 Runtime Profile。" />
        )}
      </div>
    </div>
  );
}

function InlineMessage({
  tone,
  children,
}: {
  tone: 'error' | 'success';
  children: React.ReactNode;
}) {
  return (
    <div className={`inline-message ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

function EmptyList({ text }: { text: string }) {
  return <div className="list-empty">{text}</div>;
}

interface TeammateForm {
  name: string;
  avatar: string;
  title: string;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
  currentRuntimeProfileId: string;
}

const blankTeammate: TeammateForm = {
  name: '',
  avatar: '友',
  title: '',
  description: '',
  identityPrompt: '',
  behaviorPrompt: '',
  currentRuntimeProfileId: '',
};

function TeammatesPage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState<TeammateForm>(blankTeammate);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();
  const refresh = async () => {
    setLoading(true);
    try {
      const [teammateRows, runtimeRows] = await Promise.all([
        window.cultivation.teammates.list(),
        window.cultivation.runtimes.list(),
      ]);
      setTeammates(teammateRows);
      setRuntimes(runtimeRows);
      setSelectedId(
        (current) => current || teammateRows.find((item) => item.status === 'ACTIVE')?.id || '',
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
  const selected = teammates.find((item) => item.id === selectedId);
  const startCreate = () => {
    setEditingId('');
    setForm({ ...blankTeammate, currentRuntimeProfileId: runtimes[0]?.id ?? '' });
    setError('');
    setNotice('');
  };
  const startEdit = (teammate: TeammateView) => {
    setSelectedId(teammate.id);
    setEditingId(teammate.id);
    setForm({
      name: teammate.name,
      avatar: teammate.avatar ?? '',
      title: teammate.title ?? '',
      description: teammate.description,
      identityPrompt: teammate.identityPrompt,
      behaviorPrompt: teammate.behaviorPrompt,
      currentRuntimeProfileId: teammate.currentRuntimeProfileId ?? '',
    });
    setError('');
    setNotice('');
  };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        avatar: form.avatar.trim() || null,
        title: form.title.trim() || null,
      };
      const saved = editingId
        ? await window.cultivation.teammates.update({ id: editingId, ...payload })
        : await window.cultivation.teammates.create(payload);
      setSelectedId(saved.id);
      setEditingId('');
      setForm(blankTeammate);
      setNotice(editingId ? '道友资料已保存。' : '道友已创建。');
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '保存道友失败。'));
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
      setNotice(`${teammate.name} 已归档；身份与历史记录仍保留。`);
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
      setNotice(`已复制为「${copy.name}」，新的道友 ID 与原道友不同。`);
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '复制道友失败。'));
    } finally {
      setBusy(false);
    }
  };
  const switchRuntime = async (runtimeProfileId: string) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    const stableId = selected.id;
    try {
      const updated = await window.cultivation.teammates.switchRuntime({
        teammateId: stableId,
        runtimeProfileId,
      });
      setSelectedId(updated.id);
      setNotice(
        updated.id === stableId
          ? '运行配置已切换，道友 ID 保持不变。'
          : '切换返回了不同的道友 ID。',
      );
      await refresh();
    } catch (cause) {
      setError(errorText(cause, '切换 Runtime Profile 失败。'));
    } finally {
      setBusy(false);
    }
  };
  const updateForm = (patch: Partial<TeammateForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <section className="page wide-page">
      <PageHeading
        eyebrow="Stable identity · Runtime independent"
        title="道友 Teammates"
        description="道友是持续对话的身份。Runtime Profile 可以更换，道友 ID 与其 Conversation 历史保持不变。"
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
      <div className="teammate-workspace">
        <aside className="teammate-list-card">
          <div className="list-heading">
            <div>
              <h2>道友</h2>
              <p>{teammates.filter((item) => item.status === 'ACTIVE').length} 位活跃</p>
            </div>
            <button className="icon-button" aria-label="创建道友" onClick={startCreate}>
              ＋
            </button>
          </div>
          {loading ? (
            <div className="list-empty">读取中…</div>
          ) : teammates.length ? (
            teammates.map((teammate) => (
              <button
                key={teammate.id}
                className={`teammate-list-item ${selectedId === teammate.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(teammate.id);
                  setEditingId('');
                  setForm(blankTeammate);
                }}
              >
                <span className="avatar small-avatar">
                  {teammate.avatar || teammate.name.slice(0, 1)}
                </span>
                <span className="data-row-copy">
                  <strong>{teammate.name}</strong>
                  <small>{teammate.title || '道友'}</small>
                </span>
                <span
                  className={`status-pill ${teammate.status === 'ACTIVE' ? 'active' : 'archived'}`}
                >
                  {teammate.status === 'ACTIVE' ? '活跃' : '归档'}
                </span>
              </button>
            ))
          ) : (
            <EmptyList text="尚无道友。" />
          )}
          <button className="button secondary full-width" onClick={startCreate}>
            ＋ 创建道友
          </button>
        </aside>
        <div className="teammate-detail">
          {editingId || (!selected && !loading) ? (
            <form className="form-card teammate-form" onSubmit={(event) => void save(event)}>
              <div className="form-title-row">
                <div>
                  <p className="eyebrow">{editingId ? 'EDIT TEAMMATE' : 'NEW TEAMMATE'}</p>
                  <h2>{editingId ? '编辑道友' : '创建道友'}</h2>
                </div>
                {editingId && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setEditingId('');
                      setForm(blankTeammate);
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>名称</span>
                  <input
                    required
                    maxLength={80}
                    value={form.name}
                    onChange={(event) => updateForm({ name: event.target.value })}
                    placeholder="例如：青岚"
                  />
                </label>
                <label className="field">
                  <span>头像标记</span>
                  <input
                    maxLength={8}
                    value={form.avatar}
                    onChange={(event) => updateForm({ avatar: event.target.value })}
                    placeholder="友"
                  />
                </label>
              </div>
              <label className="field">
                <span>称号</span>
                <input
                  maxLength={100}
                  value={form.title}
                  onChange={(event) => updateForm({ title: event.target.value })}
                  placeholder="例如：研究搭档"
                />
              </label>
              <label className="field">
                <span>介绍</span>
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={form.description}
                  onChange={(event) => updateForm({ description: event.target.value })}
                  placeholder="简单描述道友的定位"
                />
              </label>
              <label className="field">
                <span>Identity Prompt</span>
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={form.identityPrompt}
                  onChange={(event) => updateForm({ identityPrompt: event.target.value })}
                  placeholder="定义稳定的身份、背景与表达方式"
                />
              </label>
              <label className="field">
                <span>Behavior Prompt</span>
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={form.behaviorPrompt}
                  onChange={(event) => updateForm({ behaviorPrompt: event.target.value })}
                  placeholder="定义回答习惯与协作偏好"
                />
              </label>
              <label className="field">
                <span>Runtime Profile</span>
                <select
                  required
                  value={form.currentRuntimeProfileId}
                  onChange={(event) => updateForm({ currentRuntimeProfileId: event.target.value })}
                >
                  <option value="">选择运行配置</option>
                  {runtimes.map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.name} · {runtime.modelId}
                    </option>
                  ))}
                </select>
              </label>
              {!runtimes.length && (
                <p className="form-hint">需要先在 Settings 中创建 Runtime Profile。</p>
              )}
              <button className="button primary" disabled={busy || !runtimes.length}>
                {busy ? '保存中…' : editingId ? '保存道友' : '创建道友'}
              </button>
            </form>
          ) : selected ? (
            <div className="profile-card">
              <div className="profile-top">
                <span className="avatar profile-avatar">
                  {selected.avatar || selected.name.slice(0, 1)}
                </span>
                <div className="profile-main">
                  <div className="profile-name-row">
                    <h2>{selected.name}</h2>
                    <span
                      className={`status-pill ${selected.status === 'ACTIVE' ? 'active' : 'archived'}`}
                    >
                      {selected.status === 'ACTIVE' ? '活跃' : '归档'}
                    </span>
                  </div>
                  <p>
                    {selected.title || '道友'}
                    {selected.description ? ` · ${selected.description}` : ''}
                  </p>
                </div>
              </div>
              <div className="identity-panel">
                <span>稳定身份 ID</span>
                <code>{selected.id}</code>
                <small>Runtime 切换不会改变此 ID，也不会迁移或丢失 Conversation 历史。</small>
              </div>
              <div className="profile-section">
                <div className="section-heading">
                  <div>
                    <h3>当前 Runtime Profile</h3>
                    <p>Provider、Credential 和 Model 由运行配置管理。</p>
                  </div>
                </div>
                <select
                  aria-label="切换 Runtime Profile"
                  disabled={busy || selected.status !== 'ACTIVE'}
                  value={selected.currentRuntimeProfileId ?? ''}
                  onChange={(event) => void switchRuntime(event.target.value)}
                >
                  {runtimes.map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.name} · {runtime.modelId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="profile-actions">
                {selected.status === 'ACTIVE' && (
                  <button
                    className="button primary"
                    onClick={() => navigate(`/chat/${encodeURIComponent(selected.id)}`)}
                  >
                    打开对话
                  </button>
                )}
                <button className="button secondary" onClick={() => startEdit(selected)}>
                  编辑资料
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void duplicate(selected)}
                >
                  复制道友
                </button>
                {selected.status === 'ACTIVE' && (
                  <button
                    className="button danger-ghost"
                    disabled={busy}
                    onClick={() => void archive(selected)}
                  >
                    归档
                  </button>
                )}
              </div>
              {selected.status === 'ARCHIVED' && (
                <div className="notice">已归档的道友保留历史数据，不能继续发送新消息。</div>
              )}
            </div>
          ) : loading ? (
            <div className="loading-card">正在读取道友…</div>
          ) : (
            <div className="empty-card">
              <h3>选择或创建道友</h3>
              <p>道友身份和运行配置分别管理。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ChatPage() {
  const { teammateId = '' } = useParams();
  const [teammate, setTeammate] = useState<TeammateView | null>(null);
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
    ])
      .then(([teammates, rows]) => {
        if (cancelled) return;
        const found = teammates.find((item) => item.id === teammateId) ?? null;
        setTeammate(found);
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
        setError(event.message || '生成回复失败。');
        setStreaming(false);
        setPendingUserText('');
        setStreamText('');
        activeRequest.current = { ...active, requestId: null };
        return;
      }
      if (event.assistantMessage) {
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
    try {
      await refreshMessages(teammateId, id);
    } catch (cause) {
      setError(errorText(cause, '读取消息失败。'));
    }
  };
  const createConversation = async () => {
    setError('');
    setNotice('');
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

  if (!loading && !teammate) {
    return (
      <section className="page">
        <PageHeading
          eyebrow="单道友 Conversation"
          title="找不到道友"
          description="此道友可能已删除或 ID 不存在。"
        />
        <button className="button secondary" onClick={() => navigate('/teammates')}>
          返回道友列表
        </button>
      </section>
    );
  }
  const runtimeBadge =
    teammate && teammate.currentRuntimeProfileId
      ? `Runtime ${teammate.currentRuntimeProfileId.slice(0, 8)}`
      : '尚未配置 Runtime';
  return (
    <section className="page wide-page chat-page">
      <PageHeading
        eyebrow="持续对话 · Conversation"
        title={teammate?.name ?? '正在打开对话'}
        description="这是道友的独立 Conversation，不属于 Mission；Gate 1 不包含 Mission 执行。"
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
            <small>
              {runtimeBadge} · ID {teammate.id.slice(0, 12)}
            </small>
          </div>
          {teammate.status === 'ARCHIVED' && <span className="status-pill archived">已归档</span>}
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
                <p>此会话的消息会持续保存，切换 Runtime 后仍归属于同一道友。</p>
              </div>
            ) : (
              messages.map((message) => <MessageBubble key={message.id} message={message} />)
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
            </div>
          )}
          {notice && (
            <div className="chat-notice" role="status">
              {notice}
            </div>
          )}
          <form className="composer" onSubmit={(event) => void send(event)}>
            <textarea
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
              placeholder={
                teammate?.status === 'ARCHIVED'
                  ? '已归档道友无法发送消息'
                  : conversationId
                    ? '输入消息…（Enter 发送，Shift+Enter 换行）'
                    : '先创建一个 Conversation'
              }
            />
            <div className="composer-footer">
              <span>
                由 Main Process 调用模型 ·{' '}
                {streaming ? '正在接收流式回复' : '消息仅属于当前道友 Conversation'}
              </span>
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

function MessageBubble({ message }: { message: MessageView }) {
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
      </div>
      {message.missionId !== null && <span className="safe-tag">Mission</span>}
    </div>
  );
}

function UsagePage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [usage, setUsage] = useState<UsageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    void window.cultivation.teammates
      .list()
      .then((items) => setTeammates(items))
      .catch(() => setTeammates([]));
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.cultivation.usage
      .list(selectedId || undefined)
      .then((rows) => {
        if (!cancelled) setUsage(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取用量失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshKey]);
  const knownInput = usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
  const knownOutput = usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
  const unknownCount = usage.filter(
    (item) => item.inputTokens === null || item.outputTokens === null,
  ).length;
  return (
    <section className="page wide-page">
      <PageHeading
        eyebrow="UsageRecord · token metadata"
        title="灵石 Usage"
        description="每条记录关联具体道友、Runtime Profile、Provider 与模型。Provider 未返回的 token 字段保持未知。"
      />
      <div className="usage-toolbar">
        <label className="field">
          <span>按道友筛选</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">全部道友</option>
            {teammates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.status === 'ACTIVE' ? '活跃' : '归档'}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          onClick={() => setRefreshKey((current) => current + 1)}
        >
          刷新
        </button>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="usage-summary">
        <SummaryMetric label="模型调用" value={usage.length} />
        <SummaryMetric label="已知输入 Token" value={knownInput} />
        <SummaryMetric label="已知输出 Token" value={knownOutput} />
      </div>
      {unknownCount > 0 && (
        <p className="form-hint">
          {unknownCount} 条调用至少有一个 token 字段未由 Provider 返回；表格按“未知”显示。
        </p>
      )}
      <div className="table-card">
        <div className="list-heading">
          <div>
            <h2>调用记录</h2>
            <p>按时间倒序</p>
          </div>
        </div>
        {loading ? (
          <div className="loading-card">正在读取用量…</div>
        ) : usage.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>道友</th>
                  <th>Provider / Model</th>
                  <th>Runtime Profile</th>
                  <th>输入</th>
                  <th>输出</th>
                </tr>
              </thead>
              <tbody>
                {[...usage]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((item, index) => (
                    <tr
                      key={`${item.teammateId}-${item.runtimeProfileId}-${item.createdAt}-${index}`}
                    >
                      <td>{formatDate(item.createdAt)}</td>
                      <td>
                        <strong>
                          {teammates.find((teammate) => teammate.id === item.teammateId)?.name ??
                            item.teammateId.slice(0, 8)}
                        </strong>
                        <small className="cell-id">{item.teammateId.slice(0, 12)}</small>
                      </td>
                      <td>
                        <strong>{item.provider}</strong>
                        <small className="cell-id">{item.model}</small>
                      </td>
                      <td>
                        <code>{item.runtimeProfileId.slice(0, 12)}</code>
                      </td>
                      <td>{formatToken(item.inputTokens)}</td>
                      <td>{formatToken(item.outputTokens)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyList text="完成模型调用后，UsageRecord 会显示在这里。" />
        )}
      </div>
    </section>
  );
}

function formatToken(value: number | null): string {
  return value === null ? '未知' : new Intl.NumberFormat('zh-CN').format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
