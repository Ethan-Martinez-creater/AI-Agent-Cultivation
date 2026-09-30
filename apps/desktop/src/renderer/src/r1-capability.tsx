import React, { useEffect, useState } from 'react';
import type { CapabilityDimension, ModelCapabilityBenchmark } from '@cultivation/domain';
import type { BenchmarkInput } from '../../preload/preload.js';

const dimensionLabels: Array<[CapabilityDimension, string]> = [
  ['GENERAL_REASONING', '通用推理'],
  ['LONG_CONTEXT_REASONING', '长上下文推理'],
  ['AGENTIC_EXECUTION', 'Agent 任务执行'],
  ['CODING', '编码'],
  ['TOOL_USE', '工具使用'],
  ['VISUAL_UNDERSTANDING', '视觉理解'],
  ['IMAGE_GENERATION', '图像生成'],
  ['IMAGE_EDITING', '图像编辑'],
  ['VIDEO_GENERATION', '视频生成'],
  ['VIDEO_EDITING', '视频编辑'],
  ['SPEECH_UNDERSTANDING', '语音理解'],
  ['SPEECH_GENERATION', '语音生成'],
  ['SPEECH_TO_SPEECH', '语音到语音'],
  ['MUSIC_GENERATION', '音乐生成'],
];

const labelDimension = (dimension: CapabilityDimension): string =>
  dimensionLabels.find(([value]) => value === dimension)?.[1] ?? dimension;

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const dateOnly = (): string => new Date().toISOString().slice(0, 10);

type Runtime = { id: string; name: string; modelId: string };

export function BenchmarkPanel({ runtimes }: { runtimes: Runtime[] }) {
  const [runtimeId, setRuntimeId] = useState(runtimes[0]?.id ?? '');
  const [rows, setRows] = useState<ModelCapabilityBenchmark[]>([]);
  const [priors, setPriors] = useState<
    Array<{ dimension: CapabilityDimension; prior: ModelCapabilityBenchmark | null }>
  >([]);
  const [catalog, setCatalog] = useState<
    Array<{
      id: string;
      name: string;
      url: string;
      dimensions: CapabilityDimension[];
      description: string;
    }>
  >([]);
  const [dimension, setDimension] = useState<CapabilityDimension>('GENERAL_REASONING');
  const [supported, setSupported] = useState(true);
  const [score, setScore] = useState('');
  const [rawScore, setRawScore] = useState('');
  const [source, setSource] = useState('');
  const [benchmark, setBenchmark] = useState('');
  const [version, setVersion] = useState('1');
  const [snapshotDate, setSnapshotDate] = useState(dateOnly());
  const [sourceUrl, setSourceUrl] = useState('');
  const [provenance, setProvenance] = useState<BenchmarkInput['provenanceType']>('USER_ESTIMATE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const runtime = runtimes.find((item) => item.id === runtimeId);

  useEffect(() => {
    if (!runtimes.some((item) => item.id === runtimeId)) setRuntimeId(runtimes[0]?.id ?? '');
  }, [runtimes, runtimeId]);
  useEffect(() => {
    let cancelled = false;
    void window.cultivation.capability
      .catalog()
      .then((items) => {
        if (!cancelled) setCatalog(items);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const refresh = async (selectedId: string) => {
    if (!selectedId) {
      setRows([]);
      setPriors([]);
      return;
    }
    const [facts, effective] = await Promise.all([
      window.cultivation.capability.benchmarks(selectedId),
      window.cultivation.capability.priors(selectedId),
    ]);
    setRows(facts);
    setPriors(effective);
  };
  useEffect(() => {
    let cancelled = false;
    setRows([]);
    setPriors([]);
    setError('');
    if (runtimeId)
      void Promise.all([
        window.cultivation.capability.benchmarks(runtimeId),
        window.cultivation.capability.priors(runtimeId),
      ])
        .then(([facts, effective]) => {
          if (!cancelled) {
            setRows(facts);
            setPriors(effective);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorText(cause, '读取 Benchmark 失败。'));
        });
    return () => {
      cancelled = true;
    };
  }, [runtimeId]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!runtime) return;
    const numericScore = Number(score);
    if (
      supported &&
      (!score.trim() || !Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100)
    ) {
      setError('已支持的能力需要填写 0–100 分；0 分与不支持不同。');
      return;
    }
    const raw = rawScore.trim() ? Number(rawScore) : null;
    if (raw !== null && !Number.isFinite(raw)) {
      setError('原始分数必须为数字。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.cultivation.capability.saveBenchmark({
        runtimeProfileId: runtime.id,
        modelAlias: runtime.modelId,
        dimension,
        supported,
        normalizedScore: supported ? numericScore : null,
        rawScore: supported ? raw : null,
        source: source.trim(),
        benchmark: benchmark.trim(),
        benchmarkVersion: version.trim(),
        snapshotDate: new Date(`${snapshotDate}T00:00:00.000Z`).toISOString(),
        sourceUrl: sourceUrl.trim() || null,
        provenanceType: provenance,
      });
      await refresh(runtime.id);
      setNotice('Benchmark 事实已保存；当前使用此 Runtime 的道友能力投影已重建。');
    } catch (cause) {
      setError(errorText(cause, '保存 Benchmark 失败。'));
    } finally {
      setBusy(false);
    }
  };

  const effectiveFor = (entry: CapabilityDimension) =>
    priors.find((item) => item.dimension === entry)?.prior ?? null;

  return (
    <div className="r1-benchmark-layout">
      <div className="form-card">
        <h2>能力画像 / Benchmark</h2>
        <p className="muted-copy">
          每个维度独立记录在 Runtime 和 Model ID 上。道友创建后使用独立 Runtime，请按道友档案中的
          Runtime ID 选择；参考入口不自动填分。
        </p>
        <label className="field">
          <span>Runtime / Model</span>
          <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
            {runtimes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.modelId} · {item.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {runtime ? (
          <form onSubmit={(event) => void save(event)} className="r1-benchmark-form">
            <label className="field">
              <span>能力维度</span>
              <select
                value={dimension}
                onChange={(event) => setDimension(event.target.value as CapabilityDimension)}
              >
                {dimensionLabels.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field r1-checkbox-field">
              <input
                type="checkbox"
                checked={supported}
                onChange={(event) => setSupported(event.target.checked)}
              />
              <span>此模型支持该维度</span>
            </label>
            <div className="field-grid">
              <label className="field">
                <span>归一化分数 0–100</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  disabled={!supported}
                  required={supported}
                  value={score}
                  onChange={(event) => setScore(event.target.value)}
                />
              </label>
              <label className="field">
                <span>原始分数（可选）</span>
                <input
                  type="number"
                  step="any"
                  disabled={!supported}
                  value={rawScore}
                  onChange={(event) => setRawScore(event.target.value)}
                />
              </label>
            </div>
            <label className="field">
              <span>事实类型</span>
              <select
                value={provenance}
                onChange={(event) =>
                  setProvenance(event.target.value as BenchmarkInput['provenanceType'])
                }
              >
                <option value="USER_ESTIMATE">用户估计</option>
                <option value="CATALOG">用户参照公开榜单录入</option>
                <option value="USER_OVERRIDE">用户明确覆盖</option>
              </select>
            </label>
            <div className="field-grid">
              <label className="field">
                <span>来源</span>
                <input
                  required
                  maxLength={200}
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Benchmark 名称</span>
                <input
                  required
                  maxLength={200}
                  value={benchmark}
                  onChange={(event) => setBenchmark(event.target.value)}
                />
              </label>
            </div>
            <div className="field-grid">
              <label className="field">
                <span>版本</span>
                <input
                  required
                  maxLength={100}
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                />
              </label>
              <label className="field">
                <span>榜单快照日期</span>
                <input
                  required
                  type="date"
                  value={snapshotDate}
                  onChange={(event) => setSnapshotDate(event.target.value)}
                />
              </label>
            </div>
            <label className="field">
              <span>来源 URL（可选）</span>
              <input
                type="url"
                maxLength={2000}
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
              />
            </label>
            {error && (
              <div className="inline-message error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="inline-message success" role="status">
                {notice}
              </div>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? '保存中…' : '保存该维度事实'}
            </button>
          </form>
        ) : (
          <p>先创建 Runtime Profile，再录入能力基准。</p>
        )}
      </div>
      <div className="list-card">
        <h2>14 维配置状态</h2>
        <p className="muted-copy">「不支持」与「支持且 0 分」分别保存。保存新事实不会改写历史。</p>
        <div className="r1-dimension-list">
          {dimensionLabels.map(([value, label]) => {
            const latest = effectiveFor(value);
            return (
              <div className="data-row" key={value}>
                <span className="data-row-copy">
                  <strong>{label}</strong>
                  <small>{value}</small>
                </span>
                <span className="safe-tag">
                  {latest
                    ? latest.supported
                      ? `${latest.normalizedScore} / 100`
                      : '不支持'
                    : '未配置'}
                </span>
              </div>
            );
          })}
        </div>
        <h3>已录入事实 · {rows.length}</h3>
        <div className="r1-dimension-list">
          {rows
            .filter((row) => row.dimension === dimension)
            .map((row) => (
              <div className="data-row" key={row.id}>
                <span className="data-row-copy">
                  <strong>
                    {row.provenanceType} · {row.benchmark}
                  </strong>
                  <small>
                    {row.source} · v{row.benchmarkVersion} · {row.snapshotDate.slice(0, 10)}
                  </small>
                </span>
                <span className="safe-tag">
                  {row.supported ? `${row.normalizedScore} / 100` : '不支持'}
                </span>
              </div>
            ))}
        </div>
        <h3>Benchmark 参考入口</h3>
        <p className="muted-copy">链接仅供自行查阅。录入时请保留来源、版本和快照日期。</p>
        <ul className="r1-catalog-list">
          {catalog.map((item) => (
            <li key={item.id}>
              <strong>{item.name}</strong>
              <small>{item.description}</small>
              <code>{item.url}</code>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function DynamicCapabilityPanel({ teammateId }: { teammateId: string }) {
  const [profile, setProfile] = useState<Awaited<
    ReturnType<typeof window.cultivation.capability.profile>
  > | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setError('');
    void window.cultivation.capability
      .profile(teammateId)
      .then((value) => {
        if (!cancelled) setProfile(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取 Benchmark 能力失败。'));
      });
    return () => {
      cancelled = true;
    };
  }, [teammateId]);
  return (
    <section className="profile-section r1-profile-section teammate-benchmark-panel">
      <div className="section-heading">
        <div>
          <h3>Benchmark 能力</h3>
        </div>
      </div>
      {error && (
        <div className="inline-message error" role="alert">
          {error}
        </div>
      )}
      {!profile && !error && <div className="loading-card">正在读取 Benchmark…</div>}
      {profile && (
        <>
          <div className="teammate-benchmark-rows">
            {profile.dimensions.map((item) => {
              const benchmarkScore = item.prior?.supported
                ? item.prior.normalizedScore
                : null;
              const scoreLabel =
                typeof benchmarkScore === 'number' ? String(Math.round(benchmarkScore)) : null;
              const statusLabel = item.prior && !item.prior.supported ? '不支持' : '未配置';
              return (
                <div className="teammate-benchmark-row" key={item.dimension}>
                  <strong>{labelDimension(item.dimension)}</strong>
                  <progress
                    max={100}
                    value={benchmarkScore ?? 0}
                    aria-label={`${labelDimension(item.dimension)} Benchmark`}
                    aria-valuetext={scoreLabel ? `${scoreLabel} / 100` : statusLabel}
                  />
                  <span className="teammate-benchmark-score">
                    {scoreLabel ?? <small>{statusLabel}</small>}
                  </span>
                </div>
              );
            })}
          </div>
          <details className="teammate-benchmark-advanced">
            <summary>高级信息 · Benchmark 来源</summary>
            <dl>
              {profile.dimensions.filter((item) => item.prior).map((item) => (
                <div key={item.dimension}>
                  <dt>{labelDimension(item.dimension)}</dt>
                  <dd>
                    {item.prior?.source} · {item.prior?.benchmark} · v
                    {item.prior?.benchmarkVersion} · {item.prior?.snapshotDate.slice(0, 10)} ·{' '}
                    {item.prior?.provenanceType}
                  </dd>
                  {item.prior?.sourceUrl && (
                    <dd><code>{item.prior.sourceUrl}</code></dd>
                  )}
                </div>
              ))}
              {!profile.dimensions.some((item) => item.prior) && (
                <div>
                  <dt>来源</dt>
                  <dd>尚无 Benchmark 来源记录。</dd>
                </div>
              )}
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
