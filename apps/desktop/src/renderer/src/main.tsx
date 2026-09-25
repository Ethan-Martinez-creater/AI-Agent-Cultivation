import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import './style.css';

declare global {
  interface Window {
    cultivation: {
      app: { getVersion(): Promise<string> };
      health: { ping(): Promise<{ status: string; database: string }> };
    };
  }
}

const pages = [
  ['/', '洞府 Home', '这是你的本地工作台。后续阶段会显示最近道友、历练和待审批事项。'],
  ['/teammates', '道友 Teammates', '道友身份独立于模型和服务商。'],
  ['/parties', '队伍 Parties', '管理协作成员和协调者。'],
  ['/missions', '历练 Missions', '历练将记录完整状态、执行和审计事件。'],
  ['/skills', '功法 Skills', '声明式技能将保存在本地。'],
  ['/tools', '法宝 Tools', '工具调用必须经过权限边界。'],
  ['/memory', '记忆 Memory', '每位道友的长期记忆单独隔离。'],
  ['/usage', '灵石 Usage', '查看模型调用的 Token 用量。'],
  ['/settings', '设置 Settings', '配置 Provider、运行模型与本地应用。'],
] as const;

function Page({ title, description }: { title: string; description: string }) {
  return (
    <section className="page">
      <p className="eyebrow">Gate 0 · 基础工程</p>
      <h1>{title}</h1>
      <p>{description}</p>
      <div className="empty">功能将在对应阶段接入。</div>
    </section>
  );
}

function App() {
  const [version, setVersion] = useState('…');
  const [health, setHealth] = useState('检查中');
  useEffect(() => {
    void window.cultivation.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('未知'));
    void window.cultivation.health
      .ping()
      .then((result) => setHealth(result.status === 'ok' ? '本地数据库正常' : '数据库异常'))
      .catch(() => setHealth('数据库异常'));
  }, []);
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">修</span>
          <div>
            <strong>AI Agent Cultivation</strong>
            <small>长期 AI 队友</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {pages.map(([path, label]) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" />
          {health}
          <small>v{version}</small>
        </div>
      </aside>
      <main>
        <Routes>
          {pages.map(([path, title, description]) => (
            <Route
              key={path}
              path={path}
              element={<Page title={title} description={description} />}
            />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
