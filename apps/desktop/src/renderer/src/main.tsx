import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
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
  ['/', '洞府 Home', '你的本地工作台。管理长期道友并继续上次的对话。'],
  ['/teammates', '道友 Teammates', '创建道友身份，选择运行配置并开启持续对话。'],
  ['/parties', '队伍 Parties', '管理固定与临时队伍，指定协调道友和成员。'],
  ['/missions', '历练 Missions', '以独立 Mission Run 跟踪目标、审批与执行事件。'],
  ['/external-work', '本尊待办 Human Bridge', '处理等待你在外部应用完成的 Mission 工作。'],
  ['/skills', '功法 Skills', '为道友编写可复用的声明式指引。'],
  ['/tools', '法宝 Tools', '设置文件工作区并管理内置工具与手动配置的 MCP stdio Server。'],
  ['/memory', '记忆 Memory', '查看、确认并管理专属于道友的长期记忆。'],
  ['/usage', '灵石 Usage', '按道友和运行配置查看模型调用用量。'],
  ['/settings', '设置 Settings', '管理服务商、凭据和运行配置。'],
] as const;

function App() {
  const navigate = useNavigate();
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
          <span className={health === '本地数据库正常' ? 'status-dot' : 'status-dot muted'} />
          {health}
          <small>v{version}</small>
        </div>
      </aside>
      <main>
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
