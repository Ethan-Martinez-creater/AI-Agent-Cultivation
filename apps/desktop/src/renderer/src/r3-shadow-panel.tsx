import { useEffect, useState } from 'react';
import { Button } from './components/Button.js';
import { Section } from './components/Section.js';
import { StatusBadge } from './components/StatusBadge.js';
import type { R3DecisionConfigView, R3ShadowObservationView } from '../../preload/preload.js';

function displayConfidence(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Advanced diagnostic surface. Shadow recommendations never become execution controls. */
export function R3ShadowPanel() {
  const [config, setConfig] = useState<R3DecisionConfigView | null>(null);
  const [observations, setObservations] = useState<R3ShadowObservationView[]>([]);
  const [busy, setBusy] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'untested' | 'connected' | 'failed'>(
    'untested',
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    const [nextConfig, nextObservations] = await Promise.all([
      window.cultivation.r3.getConfig(),
      window.cultivation.r3.listObservations(),
    ]);
    setConfig(nextConfig);
    setObservations(nextObservations);
  };

  useEffect(() => {
    void refresh().catch(() => setError('读取 Shadow Decision 配置失败。'));
  }, []);

  const execute = async (action: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const message = await action();
      await refresh();
      setNotice(message);
    } catch {
      setError('操作失败。请检查密钥、网络和系统加密服务。');
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.cultivation.r3.testConnection();
      setConnectionStatus(result.ok ? 'connected' : 'failed');
      setNotice(result.ok ? `连接正常 · ${result.model ?? 'Jev'}` : result.message);
    } catch {
      setConnectionStatus('failed');
      setError('连接失败。请检查密钥和网络后重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shadow-panel setting-groups">
      <Section
        title="Jev 观察"
        icon="Jev"
        action={
          <StatusBadge tone={!config ? 'neutral' : config.enabled ? 'success' : 'neutral'}>
            {!config ? '读取中' : config.enabled ? 'Cloud 已启用' : 'Cloud 已关闭'}
          </StatusBadge>
        }
      >
        <div className="setting-group">
          <div className="setting-row">
            <span>凭据</span>
            <div className="setting-row-actions">
              <StatusBadge tone={config?.configured ? 'success' : 'warning'}>
                {!config ? '读取中' : config.configured ? '已配置' : '未配置'}
              </StatusBadge>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    await window.cultivation.r3.saveKeyFromClipboard();
                    setConnectionStatus('untested');
                    return '密钥已安全保存，剪贴板已清空。';
                  })
                }
              >
                从剪贴板安全保存密钥
              </Button>
            </div>
          </div>
          <div className="setting-row">
            <span>连接</span>
            <div className="setting-row-actions">
              <StatusBadge
                tone={
                  connectionStatus === 'connected'
                    ? 'success'
                    : connectionStatus === 'failed'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {connectionStatus === 'connected'
                  ? '正常'
                  : connectionStatus === 'failed'
                    ? '失败'
                    : '尚未检测'}
              </StatusBadge>
              <Button
                variant="secondary"
                disabled={busy || !config?.configured}
                onClick={() => void testConnection()}
              >
                测试连接
              </Button>
            </div>
          </div>
          <div className="setting-row">
            <span>Cloud Shadow</span>
            <div className="setting-row-actions">
              <Button
                variant={config?.enabled ? 'secondary' : 'primary'}
                disabled={busy || !config?.configured || (!config.enabled && !privacyConsent)}
                onClick={() =>
                  void execute(async () => {
                    await window.cultivation.r3.setEnabled(!config?.enabled);
                    if (config?.enabled) setPrivacyConsent(false);
                    return config?.enabled ? 'Cloud Shadow 已停用。' : 'Cloud Shadow 已启用。';
                  })
                }
              >
                {config?.enabled ? '停用 Cloud Shadow' : '启用 Cloud Shadow'}
              </Button>
            </div>
          </div>
        </div>
        <details className="advanced-records shadow-privacy">
          <summary>隐私与数据发送范围</summary>
          <div className="shadow-privacy-copy" role="note" aria-label="Cloud Shadow 隐私说明">
            <p>
              启用后会向 TypeSafe 发送有界任务摘要、候选道友的 ID 与角色、模型可用状态、Benchmark
              能力档位、已启用 Skill 元数据及可核验 Experience 摘要。
            </p>
            <p>
              不发送 Credential 或 API Key、私有 Memory 原文、完整文件、完整聊天历史、Mission Event
              或 Audit 全文，也不发送 Tool secret 或 output 原文。Cloud Shadow
              默认关闭，仅在你主动启用后运行。
            </p>
            <label className="field shadow-consent">
              <input
                type="checkbox"
                checked={privacyConsent}
                onChange={(event) => setPrivacyConsent(event.target.checked)}
              />
              <span>我已阅读发送范围，并同意启用 Cloud Shadow。</span>
            </label>
          </div>
        </details>
      </Section>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <details className="advanced-records shadow-diagnostics">
        <summary>高级记录与观察（{observations.length}）</summary>
        <div className="shadow-diagnostics-content">
          <div className="shadow-heading">
            <div>
              <h3>运行信息</h3>
              <p>
                {config?.keySource === 'ENVIRONMENT'
                  ? '密钥来自 Main Process 环境变量'
                  : config?.configured
                    ? '密钥已由系统加密保存'
                    : '尚未配置密钥'}
                {' · '}模式 {config?.mode ?? 'SHADOW'} · 模型 jev-1.13.0
              </p>
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>
              刷新
            </Button>
          </div>
          {observations.length === 0 ? (
            <p className="muted">尚无观察记录。</p>
          ) : (
            <div className="shadow-observations">
              {observations.map((item) => (
                <article className="shadow-observation" key={item.id}>
                  <div className="shadow-observation-title">
                    <strong>{item.decisionType}</strong>
                    <span>{item.status}</span>
                    <time>{displayTime(item.createdAt)}</time>
                  </div>
                  <p>
                    Jev 建议：{item.recommendation ?? '—'} · 置信度：
                    {displayConfidence(item.confidence)} · 真实选择：{item.actualAction ?? '—'}
                  </p>
                  <small>
                    {item.provider}/{item.model} · question {item.questionVersion} · policy{' '}
                    {item.policyVersion} · {item.latencyMs ?? '—'} ms · input{' '}
                    {item.inputTokens ?? '—'} tokens
                    {item.errorCode ? ` · ${item.errorCode}` : ''}
                  </small>
                </article>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
