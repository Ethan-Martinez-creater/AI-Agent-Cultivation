import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import { BenchmarkPanel } from '.././r1-capability.js';
import { R3ShadowPanel } from '.././r3-shadow-panel.js';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import './product-pages.css';
import { providerKinds, errorText, PageHeading, InlineMessage, EmptyList } from '../ui-shared.js';
import type {
  ProviderKind,
  ProviderView,
  CredentialView,
  RuntimeProfileView,
  TeammateView,
} from '../ui-shared.js';

type SettingsTab = 'providers' | 'credentials' | 'runtimes' | 'benchmark' | 'embedding' | 'shadow';

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('providers');
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [embeddingConfig, setEmbeddingConfig] = useState<{
    available: boolean;
    runtimeProfileId: string | null;
  }>({ available: false, runtimeProfileId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [providerRows, credentialRows, runtimeRows, embedding, teammateRows] =
        await Promise.all([
          window.cultivation.providers.list(),
          window.cultivation.credentials.list(),
          window.cultivation.runtimes.list(),
          window.cultivation.embedding.getConfig(),
          window.cultivation.teammates.list(),
        ]);
      setProviders(providerRows);
      setCredentials(credentialRows);
      setRuntimes(runtimeRows);
      setEmbeddingConfig(embedding);
      setTeammates(teammateRows);
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
    <section className="page wide-page settings-page">
      <div className="settings-layout">
        <aside className="settings-sidebar" aria-label="设置分组">
          <div className="settings-nav-group">
            <h2>模型与连接</h2>
            <div className="settings-section-nav" role="tablist" aria-label="模型与连接">
              {(
                [
                  ['providers', '服务商'],
                  ['credentials', '密钥凭据'],
                  ['runtimes', '模型配置'],
                  ['embedding', '记忆检索'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? 'settings-tab active' : 'settings-tab'}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls="settings-tab-panel"
                  onClick={() => setTab(id)}
                >
                  <Icon
                    name={
                      id === 'providers'
                        ? 'Provider'
                        : id === 'credentials'
                          ? 'Credential'
                          : id === 'runtimes'
                            ? 'Model'
                            : 'Embedding'
                    }
                    size={17}
                  />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-nav-group">
            <h2>AI 能力</h2>
            <div className="settings-section-nav" role="tablist" aria-label="AI 能力">
              {(
                [
                  ['benchmark', '能力评测'],
                  ['shadow', 'Jev 观察'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? 'settings-tab active' : 'settings-tab'}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls="settings-tab-panel"
                  onClick={() => setTab(id)}
                >
                  <Icon name={id === 'benchmark' ? 'Benchmark' : 'Jev'} size={17} />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-nav-group">
            <h2>工具与集成</h2>
            <nav className="settings-route-links" aria-label="工具与集成">
              <Link to="/tools">
                <Icon name="Tool" size={17} />
                工具与 MCP
              </Link>
              <Link to="/skills">
                <Icon name="Skill" size={17} />
                功法管理
              </Link>
            </nav>
          </div>
          <div className="settings-nav-group">
            <h2>隐私与高级</h2>
            <nav className="settings-route-links" aria-label="隐私与高级">
              <Link to="/usage">
                <Icon name="Usage" size={17} />
                用量记录
              </Link>
              <Link to="/external-work">
                <Icon name="HumanBridge" size={17} />
                本尊待办
              </Link>
            </nav>
            <p className="settings-nav-note">历练审计与运行诊断可在对应历练记录中查看。</p>
          </div>
        </aside>
        <main className="settings-main">
          <PageHeading
            eyebrow="应用管理"
            title="设置"
            description="管理连接、能力与隐私相关功能。"
          />
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {loading ? (
            <div className="loading-card">正在读取设置…</div>
          ) : (
            <div className="settings-content" id="settings-tab-panel" role="tabpanel">
              {tab === 'providers' && <ProvidersPanel providers={providers} onCreated={refresh} />}
              {tab === 'credentials' && (
                <CredentialsPanel
                  providers={providers}
                  credentials={credentials}
                  onCreated={refresh}
                />
              )}
              {tab === 'runtimes' && (
                <RuntimesPanel
                  providers={providers}
                  credentials={credentials}
                  runtimes={runtimes}
                  teammates={teammates}
                  onChanged={refresh}
                />
              )}
              {tab === 'benchmark' && <BenchmarkPanel runtimes={runtimes} />}
              {tab === 'shadow' && <R3ShadowPanel />}
              {tab === 'embedding' && (
                <EmbeddingPanel
                  providers={providers}
                  runtimes={runtimes}
                  config={embeddingConfig}
                  onChanged={refresh}
                />
              )}
            </div>
          )}
        </main>
      </div>
    </section>
  );
}

export function EmbeddingPanel({
  providers,
  runtimes,
  config,
  onChanged,
}: {
  providers: ProviderView[];
  runtimes: RuntimeProfileView[];
  config: { available: boolean; runtimeProfileId: string | null };
  onChanged: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(config.runtimeProfileId ?? '');
  const [teammateId, setTeammateId] = useState('');
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setSelected(config.runtimeProfileId ?? ''), [config.runtimeProfileId]);
  useEffect(() => {
    void window.cultivation.teammates
      .list()
      .then(setTeammates)
      .catch(() => setTeammates([]));
  }, []);
  const eligible = runtimes.filter((runtime) =>
    ['OPENAI', 'GOOGLE', 'OPENAI_COMPATIBLE'].includes(
      providers.find((provider) => provider.id === runtime.providerId)?.kind ?? '',
    ),
  );
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.cultivation.embedding.setConfig(selected || null);
      await onChanged();
      setNotice(
        selected
          ? '已启用可选向量检索；现有记忆可按道友重建索引。'
          : '已关闭向量检索；FTS5 仍可使用。',
      );
    } catch (cause) {
      setError(errorText(cause, '保存 embedding 配置失败。'));
    } finally {
      setBusy(false);
    }
  };
  const reindex = async () => {
    if (!teammateId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.cultivation.embedding.reindex(teammateId);
      setNotice(`已索引 ${result.indexed}/${result.total} 条 ACTIVE 记忆。`);
    } catch (cause) {
      setError(errorText(cause, '重建索引失败。'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel-grid">
      <div className="form-card">
        <h2>可选 embedding Runtime</h2>
        <p className="muted-copy">
          未配置时完整使用 FTS5。这里的 Runtime 必须填 embedding 模型 ID；向量索引仅存于本机
          SQLite。
        </p>
        <p className="form-hint">
          sqlite-vec：{config.available ? '可用' : '未装载，当前使用 FTS5'}
        </p>
        <label className="field">
          <span>运行配置</span>
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={!config.available}
          >
            <option value="">关闭向量检索</option>
            {eligible.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.name} · {runtime.modelId}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          type="button"
          disabled={busy || !config.available}
          onClick={() => void save()}
        >
          保存配置
        </button>
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
      </div>
      <div className="form-card">
        <h2>重建道友记忆索引</h2>
        <p className="muted-copy">
          只读取所选道友已确认的 ACTIVE 记忆；会调用所选 embedding Provider 并记录 Usage。
        </p>
        <label className="field">
          <span>道友</span>
          <select value={teammateId} onChange={(event) => setTeammateId(event.target.value)}>
            <option value="">选择道友</option>
            {teammates.map((teammate) => (
              <option key={teammate.id} value={teammate.id}>
                {teammate.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={busy || !config.available || !config.runtimeProfileId || !teammateId}
          onClick={() => void reindex()}
        >
          重建索引
        </button>
      </div>
    </div>
  );
}

export function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="summary-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ProvidersPanel({
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

export function CredentialsPanel({
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
  const rotate = async (credential: CredentialView) => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await window.cultivation.credentials.rotate(credential.id);
      setSuccess(`「${credential.label}」的 API Key 已轮换；已绑定道友的模型身份保持不变。`);
      await onCreated();
    } catch {
      setError('轮换失败。请先复制新 API Key，再检查系统加密服务。');
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
        <p className="muted-copy">
          此列表不包含密钥内容、密文或密钥预览。轮换前请先复制新 API Key；Main Process
          读取并清空剪贴板。
        </p>
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
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => void rotate(credential)}
              >
                轮换 Key
              </button>
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

export function RuntimesPanel({
  providers,
  credentials,
  runtimes,
  teammates,
  onChanged,
}: {
  providers: ProviderView[];
  credentials: CredentialView[];
  runtimes: RuntimeProfileView[];
  teammates: TeammateView[];
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState<RuntimeForm>(blankRuntime);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selectedCredentials = credentials.filter((item) => item.providerId === form.providerId);
  const sealedTeammates = (runtimeProfileId: string) =>
    teammates.filter((teammate) => teammate.currentRuntimeProfileId === runtimeProfileId);
  const isSealed = (runtimeProfileId: string) => sealedTeammates(runtimeProfileId).length > 0;
  const update = (patch: Partial<RuntimeForm>) => setForm((current) => ({ ...current, ...patch }));
  const beginEdit = (runtime: RuntimeProfileView) => {
    if (isSealed(runtime.id)) return;
    setForm({ ...runtime, credentialId: runtime.credentialId ?? '' });
    setError('');
    setNotice('');
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.id && isSealed(form.id)) {
      setError('这项模型配置已固定给道友，无法修改。');
      return;
    }
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
    if (isSealed(id)) return;
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
            <h2>{form.id ? '编辑模型配置' : '新建模型配置'}</h2>
            <p className="muted-copy">为未绑定的模型模板设置服务商、凭据与模型编号。</p>
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
          />
        </label>
        <label className="field">
          <span>服务商</span>
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
          <span>模型编号</span>
          <input
            required
            maxLength={160}
            value={form.modelId}
            onChange={(event) => update({ modelId: event.target.value })}
          />
        </label>
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        <button className="button primary" disabled={busy || providers.length === 0}>
          {busy ? '保存中…' : form.id ? '保存更改' : '创建模型配置'}
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
            const bindings = sealedTeammates(runtime.id);
            const archivedBindings = bindings.filter((teammate) => teammate.status !== 'ACTIVE');
            const activeBinding = bindings.find((teammate) => teammate.status === 'ACTIVE');
            return (
              <div
                className={`runtime-item ${bindings.length ? 'runtime-item-sealed' : ''}`}
                key={runtime.id}
              >
                <div className="runtime-item-heading">
                  <span className="runtime-mark">
                    <Icon name="Model" size={17} />
                  </span>
                  <div className="data-row-copy">
                    <strong>{runtime.name}</strong>
                    <small>
                      {provider?.name ?? '服务商'} · {runtime.modelId}
                    </small>
                  </div>
                </div>
                {bindings.length > 0 ? (
                  <>
                    <div className="runtime-sealed-label">
                      <Icon name="Credential" size={15} />
                      {archivedBindings.length === bindings.length
                        ? `已归档 · ${archivedBindings.map((teammate) => teammate.name).join('、')}`
                        : `已固定给 ${bindings.map((teammate) => teammate.name).join('、')}`}
                    </div>
                    <dl className="runtime-identity-details">
                      <div>
                        <dt>服务商</dt>
                        <dd>{provider?.name ?? '不可用'}</dd>
                      </div>
                      <div>
                        <dt>连接地址</dt>
                        <dd>{provider?.baseUrl || '服务商默认地址'}</dd>
                      </div>
                      <div>
                        <dt>模型编号</dt>
                        <dd>
                          <code>{runtime.modelId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>凭据身份</dt>
                        <dd>{credential?.label ?? '未绑定凭据'}</dd>
                      </div>
                    </dl>
                    <p className="runtime-sealed-note">
                      道友创建后固定使用此模型身份。需要更新密钥时，请前往“密钥凭据”轮换。
                    </p>
                    {activeBinding ? (
                      <AvailabilityBadge
                        teammateId={activeBinding.id}
                        teammateStatus={activeBinding.status}
                        executorKind={activeBinding.executorKind}
                      />
                    ) : (
                      <span className="product-status muted">道友已归档</span>
                    )}
                  </>
                ) : (
                  <>
                    <div className="runtime-meta">凭据：{credential?.label ?? '未绑定凭据'}</div>
                    <div className="button-row compact">
                      <button
                        className="button small secondary"
                        type="button"
                        onClick={() => beginEdit(runtime)}
                      >
                        编辑模板
                      </button>
                      <button
                        className="button small ghost"
                        type="button"
                        disabled={testingId === runtime.id}
                        onClick={() => void testConnection(runtime.id)}
                      >
                        {testingId === runtime.id ? '测试中…' : '测试连接'}
                      </button>
                    </div>
                  </>
                )}
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
