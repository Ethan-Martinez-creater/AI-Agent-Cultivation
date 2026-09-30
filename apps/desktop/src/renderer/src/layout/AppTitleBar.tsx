import React, { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import logo from '../assets/logo-mark.svg';

export function AppTitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.cultivation.desktop.windowState().then(
      (state) => {
        if (active) setMaximized(state.maximized);
      },
      () => undefined,
    );
    const off = window.cultivation.desktop.onWindowStateChanged((state) =>
      setMaximized(state.maximized),
    );
    return () => {
      active = false;
      off();
    };
  }, []);
  const invoke = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      await window.cultivation.desktop[action]();
      setError('');
    } catch {
      setError('窗口操作失败');
    }
  };
  return (
    <header className="app-titlebar">
      <div className="titlebar-brand">
        <img src={logo} width="28" height="28" alt="AI Agent Cultivation Logo" />
        <span>AI Agent Cultivation</span>
      </div>
      {error && <small role="alert">{error}</small>}
      <div className="window-controls">
        <button aria-label="最小化窗口" onClick={() => void invoke('minimize')}>
          <Icon name="Minimize" size={16} />
        </button>
        <button
          aria-label={maximized ? '恢复窗口' : '最大化窗口'}
          onClick={() => void invoke('toggleMaximize')}
        >
          <Icon name={maximized ? 'Restore' : 'Maximize'} size={15} />
        </button>
        <button className="window-close" aria-label="关闭窗口" onClick={() => void invoke('close')}>
          <Icon name="Close" size={18} />
        </button>
      </div>
    </header>
  );
}
