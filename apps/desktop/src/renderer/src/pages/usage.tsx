import { useEffect, useState } from 'react';
import { errorText, PageHeading, EmptyList, formatToken, formatDate } from '../ui-shared.js';
import type { TeammateView, UsageView } from '../ui-shared.js';

import { SummaryMetric } from './settings.js';

export function UsagePage() {
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
