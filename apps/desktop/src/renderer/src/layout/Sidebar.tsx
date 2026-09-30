import React from 'react';
import { NavLink } from 'react-router-dom';
import { Icon } from '../components/Icon.js';

const pages = [
  ['/', '首页', 'Home'],
  ['/teammates', '道友', 'Users'],
  ['/parties', '队伍', 'Users'],
  ['/missions', '历练', 'Mission'],
  ['/memory', '记忆', 'Memory'],
  ['/settings', '设置', 'Settings'],
] as const;

export function Sidebar({
  activePath,
  collapsed,
  onToggle,
  version,
  health,
}: {
  activePath: string;
  collapsed: boolean;
  onToggle: () => void;
  version: string;
  health: string;
}) {
  return (
    <aside className="sidebar">
      <nav aria-label="主导航">
        {pages.map(([path, label, icon]) => (
          <NavLink
            key={path}
            to={path}
            end={path === '/'}
            aria-label={label}
            title={collapsed ? label : undefined}
            className={activePath === path ? 'nav-link active' : 'nav-link'}
          >
            <Icon name={icon} size={20} />
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-health">
          <span className={health === '本地数据库正常' ? 'status-dot' : 'status-dot muted'} />
          {health}
          <small>v{version}</small>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={collapsed ? '展开导航' : '折叠导航'}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <Icon name={collapsed ? 'ChevronRight' : 'ChevronLeft'} size={18} />
          <span>{collapsed ? '' : '收起导航'}</span>
        </button>
      </div>
    </aside>
  );
}
