import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/Button.js';
import { Drawer } from '../components/Drawer.js';
import { Section } from '../components/Section.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { BenchmarkPanel } from '.././r1-capability.js';
import { R3ShadowPanel } from '.././r3-shadow-panel.js';
import { AvailabilityBadge } from '.././r3-2-availability.js';
import { RoutingConfigPanel } from '../r4-routing.js';
import './product-pages.css';
import { providerKinds, errorText, PageHeading, InlineMessage, EmptyList } from '../ui-shared.js';
import type {
  ProviderKind,
  ProviderView,
  CredentialView,
  RuntimeProfileView,
  TeammateView,
} from '../ui-shared.js';

type SettingsTab =
  | 'providers'
  | 'credentials'
  | 'runtimes'
  | 'benchmark'
  | 'embedding'
  | 'shadow'
  | 'routing';

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('providers');
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [credentials, setCredentials] = useState<CredentialView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeProfileView[]>([]);
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [routingConfig, setRoutingConfig] = useState<{
    cloudEnabled: boolean;
    policyVersion: string;
  }>({ cloudEnabled: false, policyVersion: '—' });
  const [embeddingConfig, setEmbeddingConfig] = useState<{
    available: boolean;
    runtimeProfileId: string | null;
  }>({ available: false, runtimeProfileId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rotationTarget, setRotationTarget] = useState<{
    credential: CredentialView;
    context: string;
  } | null>(null);
  const [rotationBusy, setRotationBusy] = useState(false);
  const [rotationDone, setRotationDone] = useState(false);
  const [rotationError, setRotationError] = useState('');
  const [rotationNotice, setRotationNotice] = useState('');

  const refresh = async () => {
    setError('');
    try {
      const [providerRows, credentialRows, runtimeRows, embedding, teammateRows, routing] =
        await Promise.all([
          window.cultivation.providers.list(),
          window.cultivation.credentials.list(),
          window.cultivation.runtimes.list(),
          window.cultivation.embedding.getConfig(),
          window.cultivation.teammates.list(),
          window.cultivation.routing.config(),
        ]);
      setProviders(providerRows);
      setCredentials(credentialRows);
      setRuntimes(runtimeRows);
      setEmbeddingConfig(embedding);
      setTeammates(teammateRows);
      setRoutingConfig(routing);
    } catch (cause) {
      setError(errorText(cause, '读取设置失败。'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const beginRotation = (credential: CredentialView, context = '') => {
    setRotationTarget({ credential, context });
    setRotationBusy(false);
    setRotationDone(false);
    setRotationError('');
    setRotationNotice('');
  };

  const closeRotation = () => {
    setRotationTarget(null);
    setRotationError('');
    setRotationNotice('');
  };

  const rotateCredential = async () => {
    if (!rotationTarget) return;
    setRotationBusy(true);
    setRotationError('');
    setRotationNotice('');
    try {
      await window.cultivation.credentials.rotate(rotationTarget.credential.id);
      setRotationDone(true);
      setRotationNotice(`「${rotationTarget.credential.label}」的密钥已安全轮换。`);
      await refresh();
    } catch {
      setRotationError('轮换失败。请先复制新 API Key，再检查系统加密服务。');
    } finally {
      setRotationBusy(false);
    }
  };

  return (
    <section className="page wide-page settings-page management-page">
      <div className="settings-layout">
        <aside className="settings-sidebar" aria-label="设置分类">
          <div className="settings-nav-group">
            <h2>模型与连接</h2>
            <div
              className="settings-section-nav settings-categories"
              role="tablist"
              aria-label="模型与连接"
            >
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
            <div
              className="settings-section-nav settings-categories"
              role="tablist"
              aria-label="AI 能力"
            >
              {(
                [
                  ['benchmark', '能力评测'],
                  ['routing', '智能分配'],
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
          </div>
        </aside>
        <div className="settings-main">
          <PageHeading
            eyebrow="应用设置"
            title="设置"
            description="模型连接、AI 能力与隐私控制。"
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
                  onRotate={(credential) => beginRotation(credential, '密钥凭据')}
                />
              )}
              {tab === 'runtimes' && (
                <RuntimesPanel
                  providers={providers}
                  credentials={credentials}
                  runtimes={runtimes}
                  teammates={teammates}
                  onChanged={refresh}
                  onRotateCredential={beginRotation}
                />
              )}
              {tab === 'benchmark' && <BenchmarkPanel runtimes={runtimes} />}
              {tab === 'shadow' && <R3ShadowPanel />}
              {tab === 'routing' && (
                <RoutingConfigPanel
                  config={routingConfig}
                  onChange={async (enabled) => {
                    const result = await window.cultivation.routing.setCloudEnabled(enabled);
                    setRoutingConfig(result);
                    if (result.cloudEnabled !== enabled) {
                      throw new Error(
                        enabled
                          ? 'Cloud 未启用。请先配置 Jev 凭据并检查连接状态。'
                          : '无法确认 Cloud 已关闭，请刷新设置后重试。',
                      );
                    }
                  }}
                  onOpenJevSettings={() => setTab('shadow')}
                />
              )}
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
        </div>
      </div>
      <Drawer
        title="安全轮换密钥"
        open={rotationTarget !== null}
        onClose={closeRotation}
        className="management-drawer"
      >
        {rotationTarget && (
          <div className="drawer-form">
            <div className="setting-row">
              <span>凭据</span>
              <strong>{rotationTarget.credential.label}</strong>
            </div>
            {rotationTarget.context && (
              <p className="form-hint">关联对象：{rotationTarget.context}</p>
            )}
            <p className="muted-copy">
              先在系统剪贴板复制新 API
              Key，再点击轮换。主进程会读取并加密保存，成功后清空剪贴板；密钥不会显示在页面中。
            </p>
            {rotationError && <InlineMessage tone="error">{rotationError}</InlineMessage>}
            {rotationNotice && <InlineMessage tone="success">{rotationNotice}</InlineMessage>}
            <div className="button-row">
              <Button variant="secondary" disabled={rotationBusy} onClick={closeRotation}>
                关闭
              </Button>
              <Button
                variant="primary"
                disabled={rotationBusy || rotationDone}
                onClick={() => void rotateCredential()}
              >
                {rotationBusy ? '安全轮换中…' : rotationDone ? '已完成' : '从剪贴板安全轮换'}
              </Button>
            </div>
          </div>
        )}
      </Drawer>
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
      setNotice(`已为 ${result.indexed}/${result.total} 条已确认且有效的记忆重建索引。`);
    } catch (cause) {
      setError(errorText(cause, '重建索引失败。'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting-groups">
      <Section
        title="向量检索"
        icon="Embedding"
        action={
          <StatusBadge tone={config.available ? 'success' : 'warning'}>
            {config.available ? '本机组件可用' : '使用全文检索'}
          </StatusBadge>
        }
      >
        <div className="setting-row">
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
          <Button
            variant="primary"
            disabled={busy || !config.available}
            onClick={() => void save()}
          >
            保存配置
          </Button>
        </div>
        <details className="advanced-records">
          <summary>存储与检索说明</summary>
          <p>向量索引只保存在本机 SQLite。运行组件不可用时，系统继续使用全文检索。</p>
        </details>
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
      </Section>
      <Section title="重建道友记忆索引" icon="Memory">
        <p className="muted-copy">
          只处理已确认且有效的记忆；会调用当前 Embedding 服务并计入用量。
        </p>
        <div className="setting-row">
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
          <Button
            variant="secondary"
            disabled={busy || !config.available || !config.runtimeProfileId || !teammateId}
            onClick={() => void reindex()}
          >
            重建索引
          </Button>
        </div>
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
      </Section>
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
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.cultivation.providers.create({
        name: name.trim(),
        kind,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setName('');
      setBaseUrl('');
      setNotice('服务商已添加。');
      setCreateOpen(false);
      await onCreated();
    } catch (cause) {
      setError(errorText(cause, '添加服务商失败。'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="management-page">
      <Section
        title="服务商"
        icon="Provider"
        action={
          <Button
            variant="primary"
            icon="Add"
            onClick={() => {
              setError('');
              setCreateOpen(true);
            }}
          >
            添加服务商
          </Button>
        }
      >
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {providers.length ? (
          <div className="management-list">
            {providers.map((provider) => (
              <article className="object-row" key={provider.id}>
                <div className="object-row-heading">
                  <span className="provider-mark">{provider.name.slice(0, 1)}</span>
                  <div className="object-row-copy">
                    <strong>{provider.name}</strong>
                    <small>
                      {providerKinds.find((item) => item.value === provider.kind)?.label ??
                        '自定义服务商'}
                    </small>
                  </div>
                </div>
                <details className="advanced-records">
                  <summary>连接详情</summary>
                  <dl>
                    <div>
                      <dt>服务地址</dt>
                      <dd>{provider.baseUrl || '使用服务商默认地址'}</dd>
                    </div>
                    <div>
                      <dt>协议类型</dt>
                      <dd>
                        <code>{provider.kind}</code>
                      </dd>
                    </div>
                  </dl>
                </details>
              </article>
            ))}
          </div>
        ) : (
          <EmptyList text="添加服务商后，可继续保存凭据和运行配置。" />
        )}
      </Section>
      <Drawer
        title="添加服务商"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        className="management-drawer"
      >
        <form className="drawer-form" onSubmit={(event) => void submit(event)}>
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
            <span>服务商类型</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as ProviderKind)}>
              {providerKinds.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>服务地址 {kind === 'OPENAI_COMPATIBLE' ? '（必填）' : '（选填）'}</span>
            <input
              type="url"
              required={kind === 'OPENAI_COMPATIBLE'}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          <div className="button-row">
            <Button variant="secondary" disabled={busy} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? '保存中…' : '添加服务商'}
            </Button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}

export function CredentialsPanel({
  providers,
  credentials,
  onCreated,
  onRotate,
}: {
  providers: ProviderView[];
  credentials: CredentialView[];
  onCreated: () => Promise<void>;
  onRotate: (credential: CredentialView) => void;
}) {
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!providers.some((provider) => provider.id === providerId)) {
      setProviderId(providers[0]?.id ?? '');
    }
  }, [providerId, providers]);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!providerId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.cultivation.credentials.create({ providerId, label: label.trim() });
      setLabel('');
      setNotice('凭据已安全保存。');
      setCreateOpen(false);
      await onCreated();
    } catch {
      setError('保存凭据失败。请先复制 API Key，再检查服务商与系统加密服务。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="management-page">
      <Section
        title="密钥凭据"
        icon="Credential"
        action={
          <Button
            variant="primary"
            icon="Add"
            disabled={!providers.length}
            onClick={() => {
              setError('');
              setNotice('');
              setCreateOpen(true);
            }}
          >
            添加凭据
          </Button>
        }
      >
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {credentials.length ? (
          <div className="management-list">
            {credentials.map((credential) => (
              <article className="object-row" key={credential.id}>
                <div className="object-row-heading">
                  <span className="secure-mark">✓</span>
                  <div className="object-row-copy">
                    <strong>{credential.label}</strong>
                    <small>
                      {providers.find((item) => item.id === credential.providerId)?.name ??
                        '服务商不可用'}
                    </small>
                  </div>
                  <StatusBadge tone="success">安全保存</StatusBadge>
                </div>
                <div className="button-row compact object-row-actions">
                  <Button variant="secondary" disabled={busy} onClick={() => onRotate(credential)}>
                    轮换密钥
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyList text="添加首个凭据后，可将其关联到运行配置。" />
        )}
      </Section>
      <Drawer
        title="添加密钥凭据"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        className="management-drawer"
      >
        <form className="drawer-form" onSubmit={(event) => void submit(event)}>
          <p className="muted-copy">
            先在系统剪贴板复制 API Key。主进程会读取并加密保存，成功后清空剪贴板；页面不会接触密钥。
          </p>
          <label className="field">
            <span>关联服务商</span>
            <select
              required
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
            >
              <option value="">选择服务商</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>凭据名称</span>
            <input
              required
              maxLength={80}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
          <div className="button-row">
            <Button variant="secondary" disabled={busy} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !providers.length}>
              {busy ? '安全保存中…' : '从剪贴板安全导入'}
            </Button>
          </div>
        </form>
      </Drawer>
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
  onRotateCredential,
}: {
  providers: ProviderView[];
  credentials: CredentialView[];
  runtimes: RuntimeProfileView[];
  teammates: TeammateView[];
  onChanged: () => Promise<void>;
  onRotateCredential: (credential: CredentialView, context?: string) => void;
}) {
  const [form, setForm] = useState<RuntimeForm>(blankRuntime);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selectedCredentials = credentials.filter((item) => item.providerId === form.providerId);
  const sealedTeammates = (runtimeProfileId: string) =>
    teammates.filter((teammate) => teammate.currentRuntimeProfileId === runtimeProfileId);
  const isSealed = (runtimeProfileId: string) => sealedTeammates(runtimeProfileId).length > 0;
  const update = (patch: Partial<RuntimeForm>) => setForm((current) => ({ ...current, ...patch }));
  const beginCreate = () => {
    setForm(blankRuntime);
    setError('');
    setNotice('');
    setFormOpen(true);
  };
  const beginEdit = (runtime: RuntimeProfileView) => {
    if (isSealed(runtime.id)) return;
    setForm({ ...runtime, credentialId: runtime.credentialId ?? '' });
    setError('');
    setNotice('');
    setFormOpen(true);
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
      setFormOpen(false);
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
    <div className="management-page">
      <Section
        title="运行配置"
        icon="Model"
        action={
          <Button variant="primary" disabled={!providers.length} onClick={beginCreate}>
            新建运行配置
          </Button>
        }
      >
        {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
        {error && <InlineMessage tone="error">{error}</InlineMessage>}
        {runtimes.length ? (
          <div className="management-list">
            {runtimes.map((runtime) => {
              const provider = providers.find((item) => item.id === runtime.providerId);
              const credential = credentials.find((item) => item.id === runtime.credentialId);
              const bindings = sealedTeammates(runtime.id);
              const archivedBindings = bindings.filter((teammate) => teammate.status !== 'ACTIVE');
              const activeBinding = bindings.find((teammate) => teammate.status === 'ACTIVE');
              const isRuntimeSealed = bindings.length > 0;
              return (
                <article
                  className={`object-row runtime-item ${isRuntimeSealed ? 'runtime-item-sealed' : ''}`}
                  key={runtime.id}
                >
                  <header className="object-row-heading">
                    <div className="object-row-copy">
                      <strong>{runtime.name}</strong>
                      <small>
                        {provider?.name ?? '服务商不可用'} · {runtime.modelId}
                      </small>
                    </div>
                    <div className="object-row-statuses">
                      <StatusBadge tone={isRuntimeSealed ? 'neutral' : 'warning'}>
                        {isRuntimeSealed ? '已封存' : '可编辑模板'}
                      </StatusBadge>
                      {isRuntimeSealed && activeBinding && (
                        <AvailabilityBadge
                          teammateId={activeBinding.id}
                          teammateStatus={activeBinding.status}
                          executorKind={activeBinding.executorKind}
                        />
                      )}
                      {isRuntimeSealed && !activeBinding && <StatusBadge>道友已归档</StatusBadge>}
                    </div>
                  </header>
                  {isRuntimeSealed ? (
                    <>
                      <p className="runtime-sealed-label object-row-meta">
                        {archivedBindings.length === bindings.length
                          ? `关联道友已归档 · ${archivedBindings.map((teammate) => teammate.name).join('、')}`
                          : `固定给 ${bindings.map((teammate) => teammate.name).join('、')}`}
                      </p>
                      <div className="object-row-meta">
                        <dl className="runtime-identity-details setting-group">
                          <div>
                            <dt>服务商</dt>
                            <dd>{provider?.name ?? '不可用'}</dd>
                          </div>
                          <div>
                            <dt>模型</dt>
                            <dd>{runtime.modelId}</dd>
                          </div>
                          <div>
                            <dt>凭据</dt>
                            <dd>{credential?.label ?? '未绑定凭据'}</dd>
                          </div>
                        </dl>
                      </div>
                      <details className="advanced-records">
                        <summary>连接详情</summary>
                        <dl>
                          <div>
                            <dt>服务地址</dt>
                            <dd>{provider?.baseUrl || '使用服务商默认地址'}</dd>
                          </div>
                        </dl>
                      </details>
                      {credential && (
                        <div className="button-row compact object-row-actions">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              onRotateCredential(credential, `运行配置「${runtime.name}」`)
                            }
                          >
                            安全轮换密钥
                          </Button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="runtime-meta object-row-meta">
                        凭据：{credential?.label ?? '未绑定凭据'}
                      </div>
                      <div className="button-row compact object-row-actions">
                        <Button variant="secondary" onClick={() => beginEdit(runtime)}>
                          编辑配置
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={testingId === runtime.id}
                          onClick={() => void testConnection(runtime.id)}
                        >
                          {testingId === runtime.id ? '测试中…' : '测试连接'}
                        </Button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyList text="添加服务商后，可创建运行配置。" />
        )}
      </Section>
      <Drawer
        title={form.id ? '编辑运行配置' : '新建运行配置'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        className="management-drawer"
      >
        <form className="drawer-form" onSubmit={(event) => void submit(event)}>
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
              <option value="">选择服务商</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ·{' '}
                  {providerKinds.find((item) => item.value === provider.kind)?.label ?? '自定义'}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>凭据（可选）</span>
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
          <div className="button-row">
            <Button variant="secondary" disabled={busy} onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !providers.length}>
              {busy ? '保存中…' : form.id ? '保存更改' : '创建运行配置'}
            </Button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
