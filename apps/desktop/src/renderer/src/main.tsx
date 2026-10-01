import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HashRouter,
  Link,
  Navigate,
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
import { WorkflowsPage } from './pages/workflows.js';
import { SettingsPage } from './pages/settings.js';
import { TeammatesPage } from './pages/teammates.js';
import { ChatPage } from './pages/chat.js';
import { MemoryPage } from './pages/memory.js';
import { SkillsPage } from './pages/skills.js';
import { UsagePage } from './pages/usage.js';
import { AppTitleBar } from './layout/AppTitleBar.js';
import { Sidebar } from './layout/Sidebar.js';
import { Icon } from './components/Icon.js';
import './style.css';
import './product.css';

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const activePath = location.pathname.startsWith('/chat')
    ? '/teammates'
    : ['/external-work', '/workflows'].includes(location.pathname)
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
    <div className="app-shell">
      <AppTitleBar />
      <div className={`layout ${collapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar
          activePath={activePath}
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
          version={version}
          health={health}
        />
        <main className={location.pathname.startsWith('/chat/') ? 'main-chat' : ''}>
          {['/skills', '/tools', '/usage'].includes(location.pathname) && (
            <nav className="context-navigation" aria-label="设置导航">
              <Link to="/settings">
                <Icon name="Settings" />
                设置
              </Link>
              <Link to="/skills">
                <Icon name="Skill" />
                功法
              </Link>
              <Link to="/tools">
                <Icon name="Tool" />
                法宝
              </Link>
              <Link to="/usage">
                <Icon name="Usage" />
                灵石
              </Link>
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
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route
              path="/external-work"
              element={<HumanBridgePage api={window.cultivation.r2} />}
            />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
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
