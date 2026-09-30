import React, { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../components/Avatar.js';
import { AvatarPicker } from '../components/AvatarPicker.js';
import { Drawer } from '../components/Drawer.js';
import { Icon } from '../components/Icon.js';
import { AvailabilityBadge } from '../r3-2-availability.js';
import { errorText, providerKinds, safeLabel } from '../ui-shared.js';
import type { ProviderKind, ProviderView, RuntimeProfileView, TeammateView } from '../ui-shared.js';
import './create-teammate.css';

type FlowStep = 'identity' | 'model' | 'confirm';
type ModelMode = 'existing' | 'new';

interface IdentityDraft {
  name: string;
  avatar: string | null;
  title: string;
  description: string;
  identityPrompt: string;
  behaviorPrompt: string;
}

interface CreateTeammatePanelProps {
  open: boolean;
  initialProviders: ProviderView[];
  initialRuntimes: RuntimeProfileView[];
  onClose: () => void;
  onCreated: (teammate: TeammateView) => void | Promise<void>;
}

const emptyIdentity: IdentityDraft = {
  name: '',
  avatar: 'preset:01',
  title: '',
  description: '',
  identityPrompt: '',
  behaviorPrompt: '',
};

const kindLabel = (kind: ProviderKind) =>
  providerKinds.find((item) => item.value === kind)?.label ?? safeLabel(kind);

export function CreateTeammatePanel({
  open,
  initialProviders,
  initialRuntimes,
  onClose,
  onCreated,
}: CreateTeammatePanelProps) {
  const [step, setStep] = useState<FlowStep>('identity');
  const [identity, setIdentity] = useState<IdentityDraft>(emptyIdentity);
  const [mode, setMode] = useState<ModelMode>(initialRuntimes.length ? 'existing' : 'new');
  const [providers, setProviders] = useState(initialProviders);
  const [runtimes, setRuntimes] = useState(initialRuntimes);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState(initialRuntimes[0]?.id ?? '');
  const [providerKind, setProviderKind] = useState<ProviderKind>('OPENAI');
  const [endpoint, setEndpoint] = useState('');
  const [modelId, setModelId] = useState('');
  const [createdProviderId, setCreatedProviderId] = useState('');
  const [createdProviderKey, setCreatedProviderKey] = useState('');
  const [createdCredentialId, setCreatedCredentialId] = useState('');
  const [createdCredentialKey, setCreatedCredentialKey] = useState('');
  const [draftRuntimeId, setDraftRuntimeId] = useState('');
  const [testedRuntimeId, setTestedRuntimeId] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'failure'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const providerKey = providerKind + '|' + endpoint.trim();
  const selectedRuntime = runtimes.find((item) => item.id === selectedRuntimeId);
  const draftRuntime = runtimes.find((item) => item.id === draftRuntimeId);
  const activeRuntimeId = mode === 'existing' ? selectedRuntimeId : draftRuntimeId;
  const isTested = Boolean(activeRuntimeId && testedRuntimeId === activeRuntimeId);
  const modelLabel = useMemo(() => {
    if (mode === 'existing' && selectedRuntime) {
      const provider = providers.find((item) => item.id === selectedRuntime.providerId);
      return [provider?.name, selectedRuntime.modelId].filter(Boolean).join(' · ');
    }
    if (draftRuntime) {
      const provider = providers.find((item) => item.id === draftRuntime.providerId);
      return [provider?.name, draftRuntime.modelId].filter(Boolean).join(' · ');
    }
    return '';
  }, [draftRuntime, mode, providers, selectedRuntime]);

  useEffect(() => {
    setProviders(initialProviders);
  }, [initialProviders]);
  useEffect(() => {
    setRuntimes(initialRuntimes);
  }, [initialRuntimes]);
  useEffect(() => {
    if (!open) return;
    setStep('identity');
    setIdentity(emptyIdentity);
    setMode('new');
    setSelectedRuntimeId('');
    setProviderKind('OPENAI');
    setEndpoint('');
    setModelId('');
    setCreatedProviderId('');
    setCreatedProviderKey('');
    setCreatedCredentialId('');
    setCreatedCredentialKey('');
    setDraftRuntimeId('');
    setTestedRuntimeId('');
    setTestStatus('idle');
    setTestMessage('');
    setError('');
    setNotice('');
    let cancelled = false;
    void Promise.all([window.cultivation.providers.list(), window.cultivation.runtimes.list()])
      .then(([providerRows, runtimeRows]) => {
        if (cancelled) return;
        setProviders(providerRows);
        setRuntimes(runtimeRows);
        setSelectedRuntimeId(runtimeRows[0]?.id ?? '');
        setMode(runtimeRows.length ? 'existing' : 'new');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const invalidateTest = () => {
    setTestedRuntimeId('');
    setTestStatus('idle');
    setTestMessage('');
    setError('');
    setNotice('');
  };

  const updateIdentity = (patch: Partial<IdentityDraft>) =>
    setIdentity((current) => ({ ...current, ...patch }));

  const ensureProvider = async () => {
    if (createdProviderId && createdProviderKey === providerKey) return createdProviderId;
    const knownProvider = providers.find(
      (item) => item.kind === providerKind && item.baseUrl === (endpoint.trim() || null),
    );
    if (knownProvider) {
      setCreatedProviderId(knownProvider.id);
      setCreatedProviderKey(providerKey);
      return knownProvider.id;
    }
    const created = await window.cultivation.providers.create({
      name: kindLabel(providerKind),
      kind: providerKind,
      baseUrl: endpoint.trim() || undefined,
    });
    setProviders((current) => [...current.filter((item) => item.id !== created.id), created]);
    setCreatedProviderId(created.id);
    setCreatedProviderKey(providerKey);
    setCreatedCredentialId('');
    setCreatedCredentialKey('');
    setDraftRuntimeId('');
    setTestedRuntimeId('');
    return created.id;
  };

  const importApiKey = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const providerId = await ensureProvider();
      const credential = await window.cultivation.credentials.create({
        providerId,
        label: (modelId.trim().slice(0, 80) || kindLabel(providerKind)) + ' API Key',
      });
      setCreatedCredentialId(credential.id);
      setCreatedCredentialKey(providerKey);
      setTestedRuntimeId('');
      setTestStatus('idle');
      setTestMessage('');
      setNotice('API Key 已安全导入，剪贴板已清空。');
    } catch (cause) {
      setError(errorText(cause, '导入 API Key 失败。请先复制 API Key 到剪贴板后重试。'));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    const runtimeId = mode === 'existing' ? selectedRuntimeId : draftRuntimeId;
    if (mode === 'existing' && !runtimeId) {
      setError('请选择一个已配置模型。');
      return;
    }
    if (
      mode === 'new' &&
      (!modelId.trim() || (!endpoint.trim() && providerKind === 'OPENAI_COMPATIBLE'))
    ) {
      setError(
        providerKind === 'OPENAI_COMPATIBLE'
          ? '请填写 Endpoint 和 Model ID。'
          : '请填写 Model ID。',
      );
      return;
    }
    if (mode === 'new' && (!createdCredentialId || createdCredentialKey !== providerKey)) {
      setError('请先复制 API Key，再通过安全导入完成凭据配置。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    setTestedRuntimeId('');
    setTestStatus('testing');
    setTestMessage('');
    try {
      let targetRuntimeId = runtimeId;
      if (mode === 'new') {
        const providerId = await ensureProvider();
        const credentialId = createdCredentialKey === providerKey ? createdCredentialId : '';
        if (!credentialId) {
          throw new Error('请先复制 API Key，再通过安全导入完成凭据配置。');
        }
        const runtimeInput = {
          name: modelId.trim().slice(0, 120),
          providerId,
          credentialId,
          modelId: modelId.trim(),
        };
        const saved = draftRuntimeId
          ? await window.cultivation.runtimes.update({ id: draftRuntimeId, ...runtimeInput })
          : await window.cultivation.runtimes.create(runtimeInput);
        setDraftRuntimeId(saved.id);
        targetRuntimeId = saved.id;
        setRuntimes((current) => [...current.filter((item) => item.id !== saved.id), saved]);
      }
      const result = await window.cultivation.runtimes.testConnection(targetRuntimeId);
      if (!result.ok) {
        setTestStatus('failure');
        setTestMessage(result.message || '连接测试失败，请检查模型配置。');
        return;
      }
      setTestedRuntimeId(targetRuntimeId);
      setTestStatus('success');
      setTestMessage(result.message || '连接成功，可以继续。');
    } catch (cause) {
      setTestStatus('failure');
      setTestMessage(errorText(cause, '连接测试失败，请检查模型配置。'));
    } finally {
      setBusy(false);
    }
  };

  const createTeammate = async () => {
    if (!activeRuntimeId || !isTested) return;
    setBusy(true);
    setError('');
    try {
      const created = await window.cultivation.teammates.create({
        name: identity.name.trim(),
        avatar: identity.avatar,
        title: identity.title.trim() || null,
        description: identity.description.trim(),
        identityPrompt: identity.identityPrompt.trim(),
        behaviorPrompt: identity.behaviorPrompt.trim(),
        currentRuntimeProfileId: activeRuntimeId,
        executorKind: 'MODEL_RUNTIME',
        routingPolicy: 'NORMAL',
        systemKind: null,
      });
      await onCreated(created);
    } catch (cause) {
      setError(errorText(cause, '创建道友失败。请重新检测连接后再试。'));
      setStep('model');
      setTestedRuntimeId('');
      setTestStatus('failure');
      setTestMessage('创建前的连接检测未通过，请检查连接并重新测试。');
    } finally {
      setBusy(false);
    }
  };

  const chooseExisting = (id: string) => {
    setSelectedRuntimeId(id);
    invalidateTest();
  };

  const chooseMode = (next: ModelMode) => {
    setMode(next);
    invalidateTest();
    setError('');
    setNotice('');
  };

  const continueToConfirm = () => {
    if (!isTested) {
      setError('连接测试成功后才能确认创建。');
      return;
    }
    setError('');
    setStep('confirm');
  };

  return (
    <Drawer
      title="创建道友"
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      className="teammate-create-drawer"
    >
      <div className="teammate-create-flow">
        <ol className="create-stepper" aria-label="创建流程">
          <li aria-current={step === 'identity' ? 'step' : undefined}>
            <span>1</span>身份
          </li>
          <li aria-current={step === 'model' ? 'step' : undefined}>
            <span>2</span>模型
          </li>
          <li aria-current={step === 'confirm' ? 'step' : undefined}>
            <span>3</span>确认
          </li>
        </ol>

        {step === 'identity' && (
          <section className="create-step-content" aria-labelledby="create-identity-title">
            <div className="create-step-intro">
              <h3 id="create-identity-title">先认识这位道友</h3>
              <p>选择头像并填写身份资料，之后可以在档案中继续编辑。</p>
            </div>
            <div className="create-avatar-row">
              <AvatarPicker
                value={identity.avatar}
                onChange={(ref) => updateIdentity({ avatar: ref })}
                kind="TEAMMATE"
              />
            </div>
            <label className="field">
              <span>名称</span>
              <input
                autoFocus
                required
                maxLength={80}
                value={identity.name}
                onChange={(event) => updateIdentity({ name: event.target.value })}
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>称号（可选）</span>
                <input
                  maxLength={100}
                  value={identity.title}
                  onChange={(event) => updateIdentity({ title: event.target.value })}
                />
              </label>
              <label className="field">
                <span>简介（可选）</span>
                <input
                  maxLength={1000}
                  value={identity.description}
                  onChange={(event) => updateIdentity({ description: event.target.value })}
                />
              </label>
            </div>
            <details className="create-advanced-identity">
              <summary>高级身份与行为设定</summary>
              <label className="field">
                <span>Identity Prompt</span>
                <textarea
                  rows={4}
                  maxLength={8000}
                  value={identity.identityPrompt}
                  onChange={(event) => updateIdentity({ identityPrompt: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Behavior Prompt</span>
                <textarea
                  rows={4}
                  maxLength={8000}
                  value={identity.behaviorPrompt}
                  onChange={(event) => updateIdentity({ behaviorPrompt: event.target.value })}
                />
              </label>
            </details>
            {error && (
              <p className="create-form-message error" role="alert">
                {error}
              </p>
            )}
            <div className="create-flow-actions">
              <button className="button secondary" type="button" onClick={onClose}>
                取消
              </button>
              <button
                className="button primary"
                type="button"
                disabled={!identity.name.trim()}
                onClick={() => {
                  setError('');
                  setStep('model');
                }}
              >
                继续选择模型 <Icon name="ChevronRight" size={16} />
              </button>
            </div>
          </section>
        )}

        {step === 'model' && (
          <section className="create-step-content" aria-labelledby="create-model-title">
            <div className="create-step-intro">
              <h3 id="create-model-title">为 {identity.name.trim() || '这位道友'} 选择模型</h3>
              <p>先测试连接，再确认固定模型。创建后可轮换密钥。</p>
            </div>
            <div className="create-model-mode" role="group" aria-label="模型配置方式">
              <button
                type="button"
                className={mode === 'existing' ? 'selected' : ''}
                aria-pressed={mode === 'existing'}
                onClick={() => chooseMode('existing')}
                disabled={busy || !runtimes.length}
              >
                使用已有模型
              </button>
              <button
                type="button"
                className={mode === 'new' ? 'selected' : ''}
                aria-pressed={mode === 'new'}
                disabled={busy}
                onClick={() => chooseMode('new')}
              >
                添加新模型
              </button>
            </div>

            {mode === 'existing' ? (
              <div className="create-existing-models" role="radiogroup" aria-label="已配置模型">
                {runtimes.map((runtime) => {
                  const provider = providers.find((item) => item.id === runtime.providerId);
                  return (
                    <label
                      className={
                        'create-runtime-option' +
                        (selectedRuntimeId === runtime.id ? ' selected' : '')
                      }
                      key={runtime.id}
                    >
                      <input
                        type="radio"
                        disabled={busy}
                        name="existing-runtime"
                        value={runtime.id}
                        checked={selectedRuntimeId === runtime.id}
                        onChange={() => chooseExisting(runtime.id)}
                      />
                      <span className="create-runtime-copy">
                        <strong>{provider?.name ?? '已配置服务商'}</strong>
                        <small>{runtime.modelId}</small>
                        {provider?.baseUrl && <small>{provider.baseUrl}</small>}
                      </span>
                      <AvailabilityBadge runtimeProfileId={runtime.id} recheck={false} compact />
                    </label>
                  );
                })}
                {!runtimes.length && (
                  <p className="create-empty-models">尚无可用配置，请添加新模型。</p>
                )}
              </div>
            ) : (
              <div className="create-new-model">
                <label className="field">
                  <span>Provider 类型</span>
                  <select
                    disabled={busy}
                    value={providerKind}
                    onChange={(event) => {
                      setProviderKind(event.target.value as ProviderKind);
                      setCreatedCredentialId('');
                      setCreatedCredentialKey('');
                      invalidateTest();
                    }}
                  >
                    {providerKinds.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Endpoint（兼容服务需要）</span>
                  <input
                    type="url"
                    disabled={busy}
                    maxLength={2048}
                    value={endpoint}
                    onChange={(event) => {
                      setEndpoint(event.target.value);
                      setCreatedCredentialId('');
                      setCreatedCredentialKey('');
                      invalidateTest();
                    }}
                  />
                </label>
                <label className="field">
                  <span>Model ID</span>
                  <input
                    required
                    maxLength={256}
                    disabled={busy}
                    value={modelId}
                    onChange={(event) => {
                      setModelId(event.target.value);
                      invalidateTest();
                    }}
                  />
                </label>
                <div className="create-key-import">
                  <div>
                    <strong>
                      <Icon name="Credential" size={16} /> API Key
                    </strong>
                    <p>先复制 API Key，再点击导入。密钥会加密保存在本机，导入后清空剪贴板。</p>
                    {createdCredentialId && createdCredentialKey === providerKey ? (
                      <span className="create-key-status" role="status">
                        <Icon name="Check" size={15} /> 凭据已安全导入
                      </span>
                    ) : (
                      <span className="create-key-status muted">尚未导入凭据</span>
                    )}
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={
                      busy ||
                      !modelId.trim() ||
                      (providerKind === 'OPENAI_COMPATIBLE' && !endpoint.trim())
                    }
                    onClick={() => void importApiKey()}
                  >
                    <Icon name="Credential" size={16} />
                    {busy ? '处理中…' : '从剪贴板安全导入'}
                  </button>
                </div>
                {testMessage && (
                  <p
                    className={
                      'create-test-message ' + (testStatus === 'success' ? 'success' : 'error')
                    }
                    role={testStatus === 'success' ? 'status' : 'alert'}
                  >
                    <Icon name={testStatus === 'success' ? 'Check' : 'Alert'} size={16} />
                    {testMessage}
                  </p>
                )}
              </div>
            )}

            {mode === 'existing' && testMessage && (
              <p
                className={
                  'create-test-message ' + (testStatus === 'success' ? 'success' : 'error')
                }
                role={testStatus === 'success' ? 'status' : 'alert'}
              >
                <Icon name={testStatus === 'success' ? 'Check' : 'Alert'} size={16} />
                {testMessage}
              </p>
            )}
            {notice && (
              <p className="create-form-message success" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="create-form-message error" role="alert">
                {error}
              </p>
            )}

            <div className="create-flow-actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setStep('identity');
                }}
              >
                <Icon name="ChevronLeft" size={16} /> 返回身份
              </button>
              <div className="create-flow-actions-right">
                <button
                  className="button secondary"
                  type="button"
                  disabled={
                    busy ||
                    (mode === 'existing' && !selectedRuntimeId) ||
                    (mode === 'new' && (!modelId.trim() || !createdCredentialId))
                  }
                  onClick={() => void testConnection()}
                >
                  <Icon name="Refresh" size={16} />
                  {busy || testStatus === 'testing' ? '测试中…' : '测试连接'}
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={!isTested || busy}
                  onClick={continueToConfirm}
                >
                  确认资料 <Icon name="ChevronRight" size={16} />
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 'confirm' && (
          <section className="create-step-content" aria-labelledby="create-confirm-title">
            <div className="create-step-intro">
              <h3 id="create-confirm-title">检查道友资料</h3>
              <p>检查无误后完成创建。创建成功后模型身份将固定绑定。</p>
            </div>
            <div className="create-confirm-card">
              <Avatar avatar={identity.avatar} name={identity.name} kind="TEAMMATE" size={64} />
              <div>
                <strong>{identity.name.trim()}</strong>
                {identity.title.trim() && <span>{identity.title.trim()}</span>}
                <small>{modelLabel || '已选择模型'}</small>
                <small>{isTested ? '连接已测试成功' : '需要重新测试连接'}</small>
              </div>
            </div>
            {identity.description.trim() && (
              <p className="create-confirm-description">{identity.description.trim()}</p>
            )}
            <div className="create-model-policy">
              <Icon name="Alert" size={17} />
              <p>
                Provider、Endpoint 与 Model ID 在创建后固定；API Key 可在设置中轮换。
                更换模型时请创建新的道友。
              </p>
            </div>
            {error && (
              <p className="create-form-message error" role="alert">
                {error}
              </p>
            )}
            <div className="create-flow-actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setStep('model');
                }}
              >
                <Icon name="ChevronLeft" size={16} /> 返回模型
              </button>
              <button
                className="button primary"
                type="button"
                disabled={busy || !isTested}
                onClick={() => void createTeammate()}
              >
                {busy ? '安全封存中…' : '确认并创建道友'}
              </button>
            </div>
          </section>
        )}
      </div>
    </Drawer>
  );
}
