import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/Avatar.js';
import { Icon } from '../components/Icon.js';
import { Tooltip } from '../components/Tooltip.js';
import type { ExternalWorkRequest } from '@cultivation/domain';
import type { MissionView, TeammateView } from '../ui-shared.js';
import { errorText, formatDate, missionStateLabel, stateClass } from '../ui-shared.js';
import './home.css';

export function HomePage() {
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [work, setWork] = useState<ExternalWorkRequest[]>([]);
  const [teammates, setTeammates] = useState<TeammateView[]>([]);
  const [teammatesLoaded, setTeammatesLoaded] = useState(false);
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
      if (people.status === 'fulfilled') {
        setTeammates(people.value);
        setTeammatesLoaded(true);
      } else {
        failures.push(errorText(people.reason, '道友读取失败'));
        setTeammatesLoaded(false);
      }
      setErrors(failures);
      setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [refresh]);

  const active = useMemo(
    () =>
      missions.filter((item) =>
        [
          'RUNNING',
          'WAITING_APPROVAL',
          'WAITING_COLLABORATION',
          'WAITING_EXTERNAL_WORK',
          'PAUSED',
          'INTERRUPTED',
        ].includes(item.state),
      ),
    [missions],
  );
  const recent = useMemo(
    () => [...missions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    [missions],
  );
  const pending = useMemo(
    () => work.filter((item) => !['ACCEPTED', 'REJECTED', 'CANCELLED'].includes(item.state)),
    [work],
  );
  const ordinary = teammates.filter(
    (item) => item.status === 'ACTIVE' && item.executorKind !== 'USER_BRIDGE',
  );
  const emptyStart = !loading && teammatesLoaded && ordinary.length === 0;
  const taskLink = (id: string) => '/missions?missionId=' + encodeURIComponent(id);
  const showSecondarySections =
    !emptyStart || active.length > 0 || recent.length > 0 || pending.length > 0;

  return (
    <section className="page wide-page home-page">
      <header className="page-toolbar home-toolbar">
        <h1>首页</h1>
        <div className="button-row">
          <Tooltip text="刷新">
            <button
              type="button"
              className="button ghost small"
              aria-label="刷新首页"
              onClick={() => setRefresh((value) => value + 1)}
            >
              <Icon name="Refresh" size={16} />
            </button>
          </Tooltip>
          {!emptyStart && (
            <Link className="button primary" to="/missions?create=1">
              <Icon name="Mission" size={16} /> 发起历练
            </Link>
          )}
        </div>
      </header>

      {errors.map((error, index) => (
        <div key={index} className="notice error" role="alert">
          {error}
        </div>
      ))}

      {loading ? (
        <div className="home-loading" role="status">
          正在读取工作台…
        </div>
      ) : (
        <>
          {emptyStart && (
            <section className="home-first-teammate" aria-labelledby="first-teammate-title">
              <div className="home-first-teammate-copy">
                <span className="home-first-teammate-icon">
                  <Icon name="Users" size={22} />
                </span>
                <h2 id="first-teammate-title">创建你的第一位道友</h2>
                <p>选择身份，连接模型，开始协作。</p>
                <Link className="button primary" to="/teammates?create=1">
                  <Icon name="Add" size={17} /> 创建第一位道友
                </Link>
                <Link className="home-settings-link" to="/settings">
                  高级设置
                </Link>
              </div>
              <div className="home-first-teammate-art" aria-hidden="true">
                <Avatar kind="TEAMMATE" name="新道友" avatar="preset:01" size={104} />
              </div>
            </section>
          )}

          {showSecondarySections && (
            <div className="home-sections">
              <section className="home-section" aria-labelledby="home-active-title">
                <div className="home-section-heading">
                  <div>
                    <h2 id="home-active-title">进行中与待处理</h2>
                  </div>
                  <Link to="/missions">全部历练</Link>
                </div>
                {active.length ? (
                  <div className="home-task-list">
                    {active.slice(0, 6).map((item) => (
                      <Link className="home-task-row" key={item.id} to={taskLink(item.id)}>
                        <span className="home-task-copy">
                          <strong>{item.title}</strong>
                          <small>{item.objective.slice(0, 110)}</small>
                        </span>
                        <span className={'mission-state ' + stateClass(item.state)}>
                          {missionStateLabel(item.state)}
                        </span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="home-quiet-empty">当前没有进行中的历练。</p>
                )}
              </section>

              <section className="home-section" aria-labelledby="home-recent-title">
                <div className="home-section-heading">
                  <div>
                    <h2 id="home-recent-title">最近历练</h2>
                  </div>
                  <Link to="/missions">查看历练</Link>
                </div>
                {recent.length ? (
                  <div className="home-task-list">
                    {recent.map((item) => (
                      <Link
                        className="home-task-row home-recent-row"
                        key={item.id}
                        to={taskLink(item.id)}
                      >
                        <span className="home-task-copy">
                          <strong>{item.title}</strong>
                          <small>{formatDate(item.updatedAt)}</small>
                        </span>
                        <span className={'mission-state ' + stateClass(item.state)}>
                          {missionStateLabel(item.state)}
                        </span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="home-quiet-empty">还没有历练记录。</p>
                )}
              </section>

              <section className="home-section home-self-section" aria-labelledby="home-self-title">
                <div className="home-section-heading">
                  <div className="home-self-heading">
                    <Avatar kind="HUMAN_BRIDGE" name="本尊" size={38} />
                    <div>
                      <h2 id="home-self-title">本尊待办</h2>
                    </div>
                  </div>
                  <Link to="/external-work">查看待办</Link>
                </div>
                {pending.length ? (
                  <div className="home-task-list">
                    {pending.slice(0, 5).map((item) => (
                      <Link
                        className="home-task-row"
                        key={item.id}
                        to={'/external-work?requestId=' + encodeURIComponent(item.id)}
                      >
                        <span className="home-task-copy">
                          <strong>{item.title}</strong>
                          <small>
                            {item.state === 'SUBMITTED' ? '已提交 · 等待验收' : '等待处理'}
                          </small>
                        </span>
                        <Icon name="ChevronRight" size={17} />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="home-quiet-empty">本尊暂无待办。</p>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}
