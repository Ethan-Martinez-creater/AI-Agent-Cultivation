import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorText, PageHeading } from '../ui-shared.js';
import type { TeammateView } from '../ui-shared.js';

export function HomePage() {
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.cultivation.teammates
      .list()
      .then((items) => {
        if (!cancelled)
          setTeammates(
            items.filter((item) => item.status === 'ACTIVE' && item.executorKind !== 'USER_BRIDGE'),
          );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取道友失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);
  const navigate = useNavigate();
  return (
    <section className="page wide-page">
      <PageHeading
        eyebrow="初入洞府 · Home"
        title="洞府 Home"
        description="从模型配置开始，逐步建立道友、日常对话与可追溯的任务协作。"
      />
      <div className="home-banner">
        <div>
          <span className="banner-kicker">当前阶段</span>
          <h2>从配置 Provider 到开始协作</h2>
          <p>普通 Conversation 会持续保存；Mission 和队伍协作有各自独立的运行记录。</p>
        </div>
        <button className="button primary" onClick={() => navigate('/teammates')}>
          管理道友
        </button>
      </div>
      <HomeOnboardingGuide teammateId={teammates[0]?.id ?? ''} />
      <div className="section-heading">
        <div>
          <h2>我的道友</h2>
          <p>对话与经历记录都归属于道友身份；模型在创建时验证并固定。</p>
        </div>
        <span className="count-badge">{teammates.length}</span>
      </div>
      {loading ? (
        <div className="loading-card">正在读取道友…</div>
      ) : error ? (
        <div className="empty-card onboarding-empty">
          <h3>暂时无法读取道友</h3>
          <p>{error}</p>
          <button
            className="button secondary"
            type="button"
            onClick={() => setLoadAttempt((current) => current + 1)}
          >
            重新读取
          </button>
        </div>
      ) : teammates.length ? (
        <div className="teammate-grid">
          {teammates.map((teammate) => (
            <button
              key={teammate.id}
              className="teammate-card"
              onClick={() => navigate(`/chat/${encodeURIComponent(teammate.id)}`)}
            >
              <span className="avatar">{teammate.avatar || teammate.name.slice(0, 1)}</span>
              <span className="teammate-card-copy">
                <strong>{teammate.name}</strong>
                <small>{teammate.title || '道友'}</small>
              </span>
              <span className="card-arrow">›</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-card">
          <span className="empty-icon">◇</span>
          <h3>还没有可用道友</h3>
          <p>先在设置中添加 Provider、Credential 和 Runtime Profile，再创建第一位道友。</p>
          <div className="button-row centered">
            <button className="button secondary" onClick={() => navigate('/settings')}>
              配置模型
            </button>
            <button className="button primary" onClick={() => navigate('/teammates')}>
              创建道友
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function HomeOnboardingGuide({ teammateId }: { teammateId: string }) {
  const navigate = useNavigate();
  const steps = [
    {
      label: 'Provider 与 Runtime',
      detail: '添加服务商、凭据，并建立模型运行配置。',
      action: '打开设置',
      path: '/settings',
    },
    {
      label: 'Teammate 道友',
      detail: '用 Runtime 创建一个有稳定身份的道友。',
      action: '创建道友',
      path: '/teammates',
    },
    {
      label: 'Chat 对话',
      detail: '从独立 Conversation 开始交流。',
      action: teammateId ? '打开对话' : '先创建道友',
      path: teammateId ? `/chat/${encodeURIComponent(teammateId)}` : '/teammates',
    },
    {
      label: 'Memory / Skill',
      detail: '按需整理长期记忆，或给道友分配可复用的 Skill。',
      action: '记忆',
      path: '/memory',
      secondAction: 'Skills',
      secondPath: '/skills',
    },
    {
      label: 'SOLO Mission',
      detail: '先为一位道友设定目标，查看独立 Run 与审批记录。',
      action: '创建历练',
      path: '/missions',
    },
    {
      label: 'Party 队伍',
      detail: '准备至少两位可用道友，指定协调者。',
      action: '管理队伍',
      path: '/parties',
    },
    {
      label: 'Collaboration 协作',
      detail: '在 Party Mission 中选择咨询、审查或委托，并处理协作请求。',
      action: '查看历练',
      path: '/missions',
    },
  ];
  return (
    <section className="onboarding-guide" aria-labelledby="onboarding-title">
      <div className="onboarding-heading">
        <div>
          <p className="eyebrow">首次使用 · Getting started</p>
          <h2 id="onboarding-title">建议上手路径</h2>
        </div>
        <p>每一步都可稍后完成；对话、记忆、任务和队伍记录各自归属清晰。</p>
      </div>
      <ol className="onboarding-steps">
        {steps.map((step, index) => (
          <li className="onboarding-step" key={step.label}>
            <span className="onboarding-step-number">{index + 1}</span>
            <div className="onboarding-step-copy">
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </div>
            <div className="onboarding-step-actions">
              <button
                className="text-button onboarding-link"
                type="button"
                onClick={() => navigate(step.path)}
              >
                {step.action}
              </button>
              {step.secondAction && step.secondPath && (
                <button
                  className="text-button onboarding-link"
                  type="button"
                  onClick={() => navigate(step.secondPath)}
                >
                  {step.secondAction}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
