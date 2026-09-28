import { useEffect, useState } from 'react';
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

  return (
    <div className="shadow-panel">
      <div className="card">
        <h3>Jev Shadow Decision Plane</h3>
        <p>
          固定模型 <code>jev-1.13.0</code>。此处只记录建议，不改变历练、道友、队伍、本尊或权限。
        </p>
        <p>
          密钥状态：
          {config?.configured
            ? config.keySource === 'ENVIRONMENT'
              ? '来自 Main Process 环境变量'
              : '已由系统加密保存'
            : '未配置'}
          {' · '}
          模式：{config?.mode ?? 'SHADOW'}
        </p>
        <div className="shadow-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                await window.cultivation.r3.saveKeyFromClipboard();
                return '已从剪贴板读取并加密保存 Key；剪贴板已清空。';
              })
            }
          >
            从剪贴板安全保存 TypeSafe Key
          </button>
          <button
            className="button secondary"
            disabled={busy || !config?.configured}
            onClick={() =>
              void execute(async () => {
                const result = await window.cultivation.r3.testConnection();
                return result.ok ? `连接成功 · ${result.model ?? 'jev-1.13.0'}` : result.message;
              })
            }
          >
            Test Connection
          </button>
          <button
            className="button"
            disabled={busy || !config?.configured}
            onClick={() =>
              void execute(async () => {
                await window.cultivation.r3.setEnabled(!config?.enabled);
                return config?.enabled ? 'Cloud Shadow 已暂停。' : 'Cloud Shadow 已启用。';
              })
            }
          >
            {config?.enabled ? '停用 Cloud Shadow' : '启用 Cloud Shadow'}
          </button>
        </div>
        <p className="muted">
          先复制 TypeSafe API Key，再点击保存。Key 只由 Main Process 从剪贴板读取；Renderer
          不接收明文或密文。 未启用时，现有流程照常运行。
        </p>
      </div>
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
      <div className="card">
        <div className="shadow-heading">
          <div>
            <h3>Shadow Observability</h3>
            <p>仅显示有界建议、真实选择和安全错误码；不显示私有 Memory、完整任务文本或 Key。</p>
          </div>
          <button className="button secondary" disabled={busy} onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        {observations.length === 0 ? (
          <p className="muted">尚无 Shadow 观察。创建历练后可在这里查看异步结果。</p>
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
    </div>
  );
}
