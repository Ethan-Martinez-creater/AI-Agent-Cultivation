import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExternalWorkRequest } from '@cultivation/domain';
import type { MissionView, TeammateView } from '../ui-shared.js';
import { errorText, formatDate, missionStateLabel, stateClass } from '../ui-shared.js';

export function HomePage() {
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [work, setWork] = useState<ExternalWorkRequest[]>([]);
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void Promise.allSettled([
      window.cultivation.missions.list(),
      window.cultivation.r2.listRequests(),
      window.cultivation.teammates.list(),
    ]).then(([tasks, external, people]) => {
      if (disposed) return;
      const failures: string[] = [];
      if (tasks.status === 'fulfilled') setMissions(tasks.value);
      else failures.push(errorText(tasks.reason, '历练读取失败'));
      if (external.status === 'fulfilled') setWork(external.value);
      else failures.push(errorText(external.reason, '本尊待办读取失败'));
      if (people.status === 'fulfilled') setTeammates(people.value);
      else failures.push(errorText(people.reason, '道友读取失败'));
      setErrors(failures);
      setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [refresh]);
  const active = missions.filter((item) =>
    [
      'RUNNING',
      'WAITING_APPROVAL',
      'WAITING_COLLABORATION',
      'WAITING_EXTERNAL_WORK',
      'PAUSED',
      'INTERRUPTED',
    ].includes(item.state),
  );
  const recent = [...missions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const pending = work.filter(
    (item) => !['ACCEPTED', 'REJECTED', 'CANCELLED'].includes(item.state),
  );
  const ordinary = teammates.filter(
    (item) => item.status === 'ACTIVE' && item.executorKind !== 'USER_BRIDGE',
  );
  const taskLink = (id: string) => '/missions?missionId=' + encodeURIComponent(id);
  return (
    <section className="page wide-page home-page">
      <header className="page-toolbar">
        <h1>洞府 Home</h1>
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            onClick={() => setRefresh((value) => value + 1)}
          >
            刷新
          </button>
          <Link className="button primary" to="/missions?create=1">
            ＋ 发起历练
          </Link>
        </div>
      </header>
      {errors.map((error, index) => (
        <div key={index} className="notice error" role="alert">
          {error}
        </div>
      ))}
      {loading ? (
        <div className="loading-card">正在读取工作台…</div>
      ) : (
        <>
          {!ordinary.length && !errors.length && (
            <section className="getting-started" aria-labelledby="first-use-title">
              <h2 id="first-use-title">开始使用</h2>
              <p>先配置模型，再创建第一位道友。</p>
              <div className="button-row">
                <Link className="button primary" to="/settings">
                  配置 Provider
                </Link>
                <Link className="button secondary" to="/teammates">
                  创建道友
                </Link>
              </div>
              <details>
                <summary>查看上手路径</summary>
                <ol className="first-use-steps">
                  <li>
                    <Link to="/settings">Provider 与固定模型配置</Link>
                  </li>
                  <li>
                    <Link to="/teammates">创建道友并开始对话</Link>
                  </li>
                  <li>
                    <Link to="/memory">整理记忆</Link> · <Link to="/skills">编写功法 Skill</Link>
                  </li>
                  <li>
                    <Link to="/missions?create=1">发起单人历练</Link>
                  </li>
                  <li>
                    <Link to="/parties">建立队伍并审批协作</Link>
                  </li>
                </ol>
              </details>
            </section>
          )}
          <section className="home-section">
            <div className="section-heading">
              <h2>进行中 / 等待用户动作</h2>
              <Link to="/missions">查看历练</Link>
            </div>
            {active.length ? (
              <div className="task-rows">
                {active.map((item) => (
                  <Link className="task-row" key={item.id} to={taskLink(item.id)}>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.objective.slice(0, 100)}</small>
                    </span>
                    <span className={'mission-state ' + stateClass(item.state)}>
                      {missionStateLabel(item.state)}
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="quiet-empty">当前没有进行中的历练。</p>
            )}
          </section>
          <section className="home-section">
            <div className="section-heading">
              <h2>本尊待办</h2>
              <Link to="/external-work">本尊待办 Human Bridge</Link>
            </div>
            {pending.length ? (
              <div className="task-rows">
                {pending.slice(0, 5).map((item) => (
                  <Link
                    className="task-row"
                    key={item.id}
                    to={'/external-work?requestId=' + encodeURIComponent(item.id)}
                  >
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.state === 'SUBMITTED' ? '已提交 · 等待验收' : '等待外部工作'}
                      </small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="quiet-empty">没有等待处理的外部工作。</p>
            )}
          </section>
          <section className="home-section">
            <div className="section-heading">
              <h2>最近历练</h2>
              <Link to="/missions">全部历练</Link>
            </div>
            {recent.length ? (
              <div className="task-rows">
                {recent.map((item) => (
                  <Link className="task-row" key={item.id} to={taskLink(item.id)}>
                    <strong>{item.title}</strong>
                    <span className={'mission-state ' + stateClass(item.state)}>
                      {missionStateLabel(item.state)}
                    </span>
                    <time>{formatDate(item.updatedAt)}</time>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="quiet-empty">
                还没有历练。<Link to="/missions?create=1">发起第一项历练</Link>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
