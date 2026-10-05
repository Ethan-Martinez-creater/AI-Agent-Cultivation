import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { GenerationArtifact, GenerationJob } from '@cultivation/domain/g1-generation';
import { Button } from '../components/Button.js';
import { StatusBadge } from '../components/StatusBadge.js';
const labels = {
  PENDING: '待提交',
  SUBMITTING: '提交中',
  QUEUED: '排队中',
  RUNNING: '生成中',
  COMPLETED: '已完成',
  FAILED: '未完成',
  CANCELLED: '已取消',
  UNKNOWN: '需要确认',
};
export function GenerationPage() {
  const [searchParams] = useSearchParams();
  const runtimeProfileId = searchParams.get('runtimeProfileId');
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [selected, setSelected] = useState<{
    job: GenerationJob;
    artifacts: GenerationArtifact[];
  } | null>(null);
  const [error, setError] = useState('');
  const refresh = async () => setJobs(await window.cultivation.generation.list());
  useEffect(() => {
    void refresh().catch(() => setError('无法加载生成任务'));
  }, []);
  const select = async (id: string) => setSelected(await window.cultivation.generation.detail(id));
  const advance = async () => {
    if (!selected) return;
    try {
      await window.cultivation.generation.advance(selected.job.id);
      await select(selected.job.id);
      await refresh();
    } catch {
      setError('生成任务未能安全完成，请检查模型或输出状态');
    }
  };
  return (
    <div className="page">
      <header className="page-heading">
        <h1>生成任务</h1>
        <Link to="/settings">返回设置</Link>
      </header>
      {error && <p role="alert">{error}</p>}
      {!jobs.filter((job) => !runtimeProfileId || job.runtimeProfileId === runtimeProfileId)
        .length ? (
        <p className="empty-state">暂无生成任务</p>
      ) : (
        <div className="product-split-view">
          <section className="split-view-list generation-jobs-list" aria-label="生成任务列表">
            {jobs
              .filter((job) => !runtimeProfileId || job.runtimeProfileId === runtimeProfileId)
              .map((job) => (
                <Button
                  className="generation-job-row"
                  aria-pressed={selected?.job.id === job.id}
                  key={job.id}
                  onClick={() => void select(job.id)}
                >
                  <span>{new Date(job.createdAt).toLocaleString()}</span>
                  <StatusBadge
                    tone={
                      job.state === 'COMPLETED'
                        ? 'success'
                        : job.state === 'FAILED'
                          ? 'danger'
                          : job.state === 'UNKNOWN'
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    {labels[job.state]}
                  </StatusBadge>
                </Button>
              ))}
          </section>
          {selected && (
            <section className="split-view-detail generation-job-detail" aria-label="生成任务详情">
              <h2>{labels[selected.job.state]}</h2>
              {selected.job.state === 'UNKNOWN' && (
                <p>提交结果无法确认，请先核对原任务。不会自动重新生成。</p>
              )}
              {['PENDING', 'QUEUED', 'RUNNING'].includes(selected.job.state) && (
                <Button onClick={() => void advance()}>检查进度</Button>
              )}
              <div className="generation-results">
                {selected.artifacts.map((a) => (
                  <article key={a.id} className="generation-result">
                    <h3>
                      {a.kind === 'IMAGE'
                        ? '图片结果'
                        : a.kind === 'VIDEO'
                          ? '视频结果'
                          : '音频结果'}
                    </h3>
                    <p>
                      {a.metadata.width && a.metadata.height
                        ? `${a.metadata.width} × ${a.metadata.height} · `
                        : ''}
                      {Math.ceil(a.sizeBytes / 1024)} KB
                    </p>
                    <span>
                      {a.storageScope === 'APP_ARTIFACT_STORE' ? '应用素材库' : '历练工作区'}
                    </span>
                  </article>
                ))}
              </div>
              <details>
                <summary>高级信息</summary>
                <dl>
                  <dt>任务</dt>
                  <dd>{selected.job.id}</dd>
                  <dt>错误代码</dt>
                  <dd>{selected.job.errorCode ?? '无'}</dd>
                  {selected.artifacts.map((a) => (
                    <React.Fragment key={a.id}>
                      <dt>Artifact</dt>
                      <dd>{a.id}</dd>
                      <dt>SHA-256</dt>
                      <dd>{a.contentHash}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </details>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
