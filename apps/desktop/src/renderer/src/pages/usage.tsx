import { useEffect, useMemo, useState } from 'react';
import { Section } from '../components/Section.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { errorText, EmptyList, formatDate } from '../ui-shared.js';
import type { ProviderView, TeammateView, UsageView } from '../ui-shared.js';

const numberFormat = new Intl.NumberFormat('zh-CN');

function formatUsageValue(value: number | null): string {
  return value === null ? '未知' : numberFormat.format(value);
}

export function UsagePage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [usage, setUsage] = useState<UsageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.cultivation.teammates.list(), window.cultivation.providers.list()])
      .then(([items, connections]) => {
        if (!cancelled) {
          setTeammates(items);
          setProviders(connections);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取道友列表失败。'));
      });
    return () => {
      cancelled = true;
    };
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

  const teammatesById = useMemo(
    () => new Map(teammates.map((teammate) => [teammate.id, teammate])),
    [teammates],
  );
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  const knownInput = usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
  const knownOutput = usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
  const unknownCount = usage.filter(
    (item) => item.inputTokens === null || item.outputTokens === null,
  ).length;
  const orderedUsage = [...usage].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <section className="page wide-page management-page usage-page">
      <header className="page-heading management-heading">
        <h1>用量</h1>
        <div className="management-toolbar">
          <label className="field">
            <span>道友</span>
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              <option value="">全部道友</option>
              {teammates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.status === 'ACTIVE' ? '启用' : '已归档'}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button secondary"
            type="button"
            disabled={loading}
            onClick={() => setRefreshKey((current) => current + 1)}
          >
            刷新
          </button>
        </div>
      </header>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <dl className="usage-summary setting-group">
        <div className="usage-summary-item">
          <dt>模型调用</dt>
          <dd>{numberFormat.format(usage.length)}</dd>
        </div>
        <div className="usage-summary-item">
          <dt>已知输入 Token</dt>
          <dd>{numberFormat.format(knownInput)}</dd>
        </div>
        <div className="usage-summary-item">
          <dt>已知输出 Token</dt>
          <dd>{numberFormat.format(knownOutput)}</dd>
        </div>
        <div className="usage-summary-item">
          <dt>未返回 Token 数据</dt>
          <dd>{numberFormat.format(unknownCount)}</dd>
        </div>
      </dl>

      <Section
        title="调用记录"
        icon="Usage"
        action={<span className="count-badge">{usage.length}</span>}
        className="setting-group"
      >
        {loading ? (
          <div className="loading-card">正在读取用量…</div>
        ) : orderedUsage.length ? (
          <div className="management-table-wrap">
            <table className="management-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>道友</th>
                  <th>Provider / Model</th>
                  <th>输入 Token</th>
                  <th>输出 Token</th>
                  <th>状态</th>
                  <th>高级记录</th>
                </tr>
              </thead>
              <tbody>
                {orderedUsage.map((item, index) => {
                  const owner = teammatesById.get(item.teammateId);
                  const partial = item.inputTokens === null || item.outputTokens === null;
                  const rowKey =
                    item.id ??
                    `${item.teammateId}-${item.runtimeProfileId}-${item.createdAt}-${index}`;
                  return (
                    <tr key={rowKey}>
                      <td>{formatDate(item.createdAt)}</td>
                      <td>
                        <strong>{owner?.name ?? '道友资料不可用'}</strong>
                        <div className="usage-owner-status">
                          {owner ? (
                            <StatusBadge tone={owner.status === 'ACTIVE' ? 'success' : 'neutral'}>
                              {owner.status === 'ACTIVE' ? '启用' : '已归档'}
                            </StatusBadge>
                          ) : (
                            <StatusBadge tone="warning">未找到</StatusBadge>
                          )}
                        </div>
                      </td>
                      <td>
                        <strong>{providerNames.get(item.provider) ?? '模型服务'}</strong>
                        <div>{item.model}</div>
                      </td>
                      <td>{formatUsageValue(item.inputTokens)}</td>
                      <td>{formatUsageValue(item.outputTokens)}</td>
                      <td>
                        <StatusBadge tone={partial ? 'warning' : 'success'}>
                          {partial ? '部分未知' : '已记录'}
                        </StatusBadge>
                      </td>
                      <td>
                        <details className="advanced-records">
                          <summary>查看</summary>
                          <dl>
                            <div>
                              <dt>Provider</dt>
                              <dd>
                                <code>{item.provider}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>用量记录</dt>
                              <dd>
                                <code>{item.id ?? '未提供'}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>道友 ID</dt>
                              <dd>
                                <code>{item.teammateId}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>Runtime Profile ID</dt>
                              <dd>
                                <code>{item.runtimeProfileId}</code>
                              </dd>
                            </div>
                            {item.missionId && (
                              <div>
                                <dt>Mission ID</dt>
                                <dd>
                                  <code>{item.missionId}</code>
                                </dd>
                              </div>
                            )}
                            {item.runId && (
                              <div>
                                <dt>Run ID</dt>
                                <dd>
                                  <code>{item.runId}</code>
                                </dd>
                              </div>
                            )}
                          </dl>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyList text="完成模型调用后，用量记录会显示在这里。" />
        )}
      </Section>
    </section>
  );
}
