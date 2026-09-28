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
  const [source, setSource] = useState('用户填写');
  const [benchmark, setBenchmark] = useState('手工评估');
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
          每个维度独立记录在 Runtime 和 Model ID
          上。成绩由你填写，参考入口只提供榜单名称与链接；不自动抓取或假定模型得分。
        </p>
        <label className="field">
          <span>Runtime / Model</span>
          <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
            {runtimes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.modelId}
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
                placeholder="https://…"
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
        if (!cancelled) setError(errorText(cause, '读取动态能力失败。'));
      });
    return () => {
      cancelled = true;
    };
  }, [teammateId]);
  return (
    <section className="profile-section r1-profile-section">
      <div className="section-heading">
        <div>
          <h3>动态能力 · Capability</h3>
          <p>
            由当前 Runtime Benchmark 与真实 Mission 用户评价重建；不会自动改变境界或选择执行者。
          </p>
        </div>
      </div>
      {error && (
        <div className="inline-message error" role="alert">
          {error}
        </div>
      )}
      {!profile && !error && <div className="loading-card">正在重建能力画像…</div>}
      {profile && (
        <>
          <p className="form-hint">
            当前 Runtime：{profile.currentRuntimeProfileId ?? '无'} · 评分策略：
            {profile.scoringPolicyVersion}
          </p>
          <div className="r1-capability-grid">
            {profile.dimensions.map((item) => (
              <article className="r1-capability-card" key={item.dimension}>
                <strong>{labelDimension(item.dimension)}</strong>
                {item.currentScore === null ? (
                  <p>{item.prior && !item.prior.supported ? '明确不支持' : '未配置能力基准'}</p>
                ) : (
                  <p className="r1-score">
                    {item.currentScore.toFixed(1)} <small>/ 100</small>
                  </p>
                )}
                <small>
                  Benchmark prior：
                  {item.prior?.supported
                    ? `${item.prior.normalizedScore} / 100`
                    : item.prior
                      ? '不支持'
                      : '未配置'}
                </small>
                <small>
                  评价数：{item.ratingCount} · Evidence weight：{item.evidenceWeight.toFixed(2)}
                </small>
                {item.currentScore !== null && item.weightedUserScore !== null && (
                  <small>
                    调整依据：用户加权均分 {item.weightedUserScore.toFixed(1)}；P=
                    {item.priorStrength}，E={item.evidenceWeight.toFixed(2)}，α=
                    {item.alpha.toFixed(3)}。历史 Runtime 权重 {item.transferWeight}。
                  </small>
                )}
                <small>
                  来源：
                  {item.prior
                    ? `${item.prior.source} / ${item.prior.benchmark} (${item.prior.benchmarkVersion})`
                    : '无'}
                </small>
                <small>
                  {item.source === 'BENCHMARK_PLUS_USER_EVIDENCE'
                    ? '按用户评价逐步调整，历史 Runtime 的证据以迁移权重参与。'
                    : item.source === 'BENCHMARK_ONLY'
                      ? '当前分数仅来自 Benchmark prior。'
                      : item.source === 'UNSUPPORTED'
                        ? '当前 Runtime 明确不支持，不能形成有效能力分数。'
                        : '没有可用于未来路由的能力分数。'}
                </small>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

type RatingTarget = Awaited<ReturnType<typeof window.cultivation.capability.ratingTargets>>[number];

export function MissionRatingCard({
  missionId,
  runId,
  teammateNames,
}: {
  missionId: string;
  runId: string;
  teammateNames: Record<string, string>;
}) {
  const [targets, setTargets] = useState<RatingTarget[]>([]);
  const [selectedTargetKey, setSelectedTargetKey] = useState('');
  const [selectedDimensions, setSelectedDimensions] = useState<CapabilityDimension[]>([]);
  const [overallRating, setOverallRating] = useState<1 | 2 | 3 | 4 | 5 | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [dimensionRatings, setDimensionRatings] = useState<
    Partial<Record<CapabilityDimension, 1 | 2 | 3 | 4 | 5>>
  >({});
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let cancelled = false;
    setTargets([]);
    setDismissed(false);
    void window.cultivation.capability
      .ratingTargets({ missionId, runId })
      .then((items) => {
        if (cancelled) return;
        setTargets(items);
        const first = items.find((item) => !item.alreadyRated);
        setSelectedTargetKey(first ? `${first.teammateId}:${first.runtimeProfileId}` : '');
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取可评价道友失败。'));
      });
    return () => {
      cancelled = true;
    };
  }, [missionId, runId]);
  const unrated = targets.filter((item) => !item.alreadyRated);
  const available = unrated.filter((item) => item.supportedDimensions.length > 0);
  const target =
    available.find((item) => `${item.teammateId}:${item.runtimeProfileId}` === selectedTargetKey) ??
    available[0];
  const toggleDimension = (dimension: CapabilityDimension) => {
    setSelectedDimensions((current) =>
      current.includes(dimension)
        ? current.filter((value) => value !== dimension)
        : current.length < 3
          ? [...current, dimension]
          : current,
    );
  };
  const save = async () => {
    if (!target) return;
    if (selectedDimensions.length < 1 || selectedDimensions.length > 3) {
      setError('请选 1–3 个本次实际涉及的能力维度。');
      return;
    }
    if (!overallRating && selectedDimensions.some((dimension) => !dimensionRatings[dimension])) {
      setError('请填写整体评分，或为每个所选维度分别评分。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await window.cultivation.capability.submitRating({
        missionId,
        runId,
        teammateId: target.teammateId,
        runtimeProfileId: target.runtimeProfileId,
        selectedDimensions,
        ...(overallRating ? { overallRating } : {}),
        ...(advanced ? { dimensionRatings } : {}),
      });
      const updated = await window.cultivation.capability.ratingTargets({ missionId, runId });
      setTargets(updated);
      const next = updated.find((item) => !item.alreadyRated);
      setSelectedTargetKey(next ? `${next.teammateId}:${next.runtimeProfileId}` : '');
      setSelectedDimensions([]);
      setOverallRating(null);
      setDimensionRatings({});
      setNotice('评价已保存为可追溯 Evidence；能力投影已更新。');
    } catch (cause) {
      setError(errorText(cause, '保存评价失败。'));
    } finally {
      setBusy(false);
    }
  };
  if (dismissed || (!unrated.length && !error && !notice)) return null;
  return (
    <section className="r1-rating-card" aria-label="本次历练评价">
      <div className="section-heading">
        <div>
          <h3>本次历练评价 · 可跳过</h3>
          <p>
            只评价本 Run 真正调用过模型的道友。从该 Runtime 已支持的维度选 1–3 项，评价不会阻塞
            Mission 完成。
          </p>
        </div>
      </div>
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
      {!target && unrated.length > 0 && (
        <p className="form-hint">
          本 Run 有实际执行记录，但对应 Runtime 尚未配置任何受支持能力维度。请先在 Settings
          的能力画像中录入 Benchmark；也可直接跳过。
        </p>
      )}
      {target && (
        <>
          <label className="field">
            <span>执行道友</span>
            <select
              value={`${target.teammateId}:${target.runtimeProfileId}`}
              onChange={(event) => {
                setSelectedTargetKey(event.target.value);
                setSelectedDimensions([]);
                setDimensionRatings({});
              }}
            >
              {available.map((item) => (
                <option
                  key={`${item.teammateId}:${item.runtimeProfileId}`}
                  value={`${item.teammateId}:${item.runtimeProfileId}`}
                >
                  {teammateNames[item.teammateId] ?? item.teammateId} · {item.modelAlias}
                </option>
              ))}
            </select>
          </label>
          <div className="r1-rating-dimensions">
            {target.supportedDimensions.map((dimension) => (
              <label key={dimension} className="r1-rating-dimension">
                <input
                  type="checkbox"
                  checked={selectedDimensions.includes(dimension)}
                  onChange={() => toggleDimension(dimension)}
                />
                <span>{labelDimension(dimension)}</span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>整体评分（快速模式）</span>
            <select
              value={overallRating ?? ''}
              onChange={(event) =>
                setOverallRating(
                  event.target.value ? (Number(event.target.value) as 1 | 2 | 3 | 4 | 5) : null,
                )
              }
            >
              <option value="">请选择，或在高级模式逐维评分</option>
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value} 星
                </option>
              ))}
            </select>
          </label>
          <label className="field r1-checkbox-field">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(event) => setAdvanced(event.target.checked)}
            />
            <span>高级模式：所选维度可单独评分，覆盖整体分数</span>
          </label>
          {advanced &&
            selectedDimensions.map((dimension) => (
              <label className="field" key={dimension}>
                <span>{labelDimension(dimension)}</span>
                <select
                  value={dimensionRatings[dimension] ?? ''}
                  onChange={(event) =>
                    setDimensionRatings((current) => ({
                      ...current,
                      [dimension]: event.target.value
                        ? (Number(event.target.value) as 1 | 2 | 3 | 4 | 5)
                        : undefined,
                    }))
                  }
                >
                  <option value="">使用整体评分</option>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {value} 星
                    </option>
                  ))}
                </select>
              </label>
            ))}
        </>
      )}
      <div className="button-row compact">
        <button
          className="button primary small"
          type="button"
          disabled={busy || !target}
          onClick={() => void save()}
        >
          {busy ? '保存中…' : '提交评价'}
        </button>
        <button className="button ghost small" type="button" onClick={() => setDismissed(true)}>
          跳过
        </button>
      </div>
    </section>
  );
}
