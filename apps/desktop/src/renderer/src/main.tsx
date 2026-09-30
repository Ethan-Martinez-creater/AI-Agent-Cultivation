import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HashRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useLocation,
} from 'react-router-dom';
import { HumanBridgePage } from './r2-human-bridge.js';
import { HomePage } from './pages/home.js';
import { ToolsPage } from './pages/tools.js';
import { PartiesPage } from './pages/parties.js';
import { MissionPage } from './pages/missions.js';
import { SettingsPage } from './pages/settings.js';
import { TeammatesPage } from './pages/teammates.js';
import { ChatPage } from './pages/chat.js';
import { MemoryPage } from './pages/memory.js';
import { SkillsPage } from './pages/skills.js';
import { UsagePage } from './pages/usage.js';
import './style.css';

const pages = [
  ['/', '首页'],
  ['/teammates', '道友'],
  ['/parties', '队伍'],
  ['/missions', '历练'],
  ['/memory', '记忆'],
  ['/settings', '设置'],
] as const;

function NavigationIcon({ index }: { index: number }) {
  const paths = [
    'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a4 4 0 0 0-3-3.87M16 3a4 4 0 0 1 0 8',
    'M3 21v-2a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M16 12h6M19 9v6M17 18h5v3',
    'm3 21 6-12 4 5 3-10 6 17ZM15 3h5l-2 4',
    'M12 5C8 2 5 2 2 3v17c4-1 7-1 10 1 3-2 6-2 10-1V3c-3-1-6-1-10 2v16',
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 2h6l1 4 4 1 2 5-3 3-1 4-6 3-3-3-4-1-3-6 3-3 1-4Z',
  ];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={paths[index]} />
    </svg>
  );
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const activePath = location.pathname.startsWith('/chat')
    ? '/teammates'
    : location.pathname === '/external-work'
      ? '/missions'
      : ['/tools', '/skills', '/usage'].includes(location.pathname)
        ? '/settings'
        : location.pathname;
  const [version, setVersion] = useState('…');
  const [health, setHealth] = useState('检查中');
  const [bridgeReady, setBridgeReady] = useState(true);
  useEffect(() => {
    return window.cultivation?.r2?.onNavigate((path) => navigate(path));
  }, [navigate]);
  useEffect(() => {
    if (!window.cultivation?.app || !window.cultivation?.health) {
      setBridgeReady(false);
      setHealth('功能接口未连接');
      return;
    }
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
    <div className={`layout ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <div>
            <strong>AI Agent Cultivation</strong>
            <small>Windows V1 Alpha</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {pages.map(([path, label], index) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              aria-label={label}
              title={collapsed ? label : undefined}
              className={activePath === path ? 'nav-link active' : 'nav-link'}
            >
              <NavigationIcon index={index} />
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={collapsed ? '展开导航' : '折叠导航'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? '›' : '‹'}
            <span>{collapsed ? '' : '收起导航'}</span>
          </button>
          <div className="sidebar-health">
            <span className={health === '本地数据库正常' ? 'status-dot' : 'status-dot muted'} />
            {health}
            <small>v{version}</small>
          </div>
        </div>
      </aside>
      <main>
        {['/skills', '/tools', '/usage'].includes(location.pathname) && (
          <nav className="settings-links advanced-page-navigation" aria-label="设置导航">
            <Link to="/settings">设置 Settings</Link>
            <Link to="/skills">功法 Skills</Link>
            <Link to="/tools">法宝 Tools</Link>
            <Link to="/usage">灵石 Usage</Link>
          </nav>
        )}
        {!bridgeReady && (
          <div className="notice error" role="status">
            Main Process 功能接口尚未连接。请重新启动应用后重试。
          </div>
        )}
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/teammates" element={<TeammatesPage />} />
          <Route path="/chat/:teammateId" element={<ChatPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/parties" element={<PartiesPage />} />
          <Route path="/missions" element={<MissionPage />} />
          <Route path="/external-work" element={<HumanBridgePage api={window.cultivation.r2} />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
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
