import { Switch } from '../components/Switch.js';
import React, { useEffect, useState } from 'react';
import { Drawer } from '../components/Drawer.js';
import { Icon } from '../components/Icon.js';
import { Section } from '../components/Section.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { errorText } from '../ui-shared.js';
import type { McpServerConfigView, ToolDescriptorView } from '../ui-shared.js';

type McpServerForm = {
  name: string;
  command: string;
  argsText: string;
  envWhitelistText: string;
  cwd: string;
  enabled: boolean;
};

const blankMcpServerForm: McpServerForm = {
  name: '',
  command: '',
  argsText: '',
  envWhitelistText: '',
  cwd: '',
  enabled: true,
};

type McpConnectionState = {
  status: 'READY' | 'ERROR';
  tools: ToolDescriptorView[];
};

export function ToolsPage() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [builtins, setBuiltins] = useState<ToolDescriptorView[]>([]);
  const [servers, setServers] = useState<McpServerConfigView[]>([]);
  const [serverStatus, setServerStatus] = useState<Record<string, McpConnectionState>>({});
  const [form, setForm] = useState(blankMcpServerForm);
  const [editingId, setEditingId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    const [workspace, builtinRows, serverRows] = await Promise.all([
      window.cultivation.tools.getWorkspace(),
      window.cultivation.tools.listBuiltins(),
      window.cultivation.tools.listMcpServers(),
    ]);
    setWorkspaceRoot(workspace.rootPath);
    setBuiltins(builtinRows);
    setServers(serverRows);
    setServerStatus((current) => {
      const next: Record<string, McpConnectionState> = {};
      for (const server of serverRows) {
        const status = current[server.id];
        if (status) next[server.id] = status;
      }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void Promise.all([
      window.cultivation.tools.getWorkspace(),
      window.cultivation.tools.listBuiltins(),
      window.cultivation.tools.listMcpServers(),
    ])
      .then(([workspace, builtinRows, serverRows]) => {
        if (cancelled) return;
        setWorkspaceRoot(workspace.rootPath);
        setBuiltins(builtinRows);
        setServers(serverRows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, '读取工具配置失败。'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateForm = (patch: Partial<McpServerForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  const closeEditor = () => {
    setDrawerOpen(false);
    setEditingId('');
    setForm(blankMcpServerForm);
  };

  const openCreate = () => {
    setEditingId('');
    setForm(blankMcpServerForm);
    setError('');
    setNotice('');
    setDrawerOpen(true);
  };

  const chooseWorkspace = async () => {
    setError('');
    setNotice('');
    try {
      const selected = await window.cultivation.tools.chooseWorkspace();
      if (selected.rootPath) {
        setWorkspaceRoot(selected.rootPath);
        setNotice('工作区已更新。');
      }
    } catch (cause) {
      setError(errorText(cause, '选择工作区失败。'));
    }
  };

  const saveServer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const args = form.argsText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const envWhitelist = form.envWhitelistText
      .split(/[\r\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (envWhitelist.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
      setError('环境变量白名单只接受变量名称，每行一个。');
      setBusy(false);
      return;
    }
    try {
      const savedServer = await window.cultivation.tools.saveMcpServer({
        ...(editingId ? { id: editingId } : {}),
        name: form.name.trim(),
        command: form.command.trim(),
        args,
        envWhitelist: [...new Set(envWhitelist)],
        cwd: form.cwd.trim() || null,
        enabled: form.enabled,
      });
      setServerStatus((current) => {
        const next = { ...current };
        delete next[savedServer.id];
        return next;
      });
      await refresh();
      closeEditor();
      setNotice('MCP 服务配置已保存。');
    } catch (cause) {
      setError(errorText(cause, '保存 MCP 服务失败。'));
    } finally {
      setBusy(false);
    }
  };

  const editServer = (server: McpServerConfigView) => {
    setEditingId(server.id);
    setForm({
      name: server.name,
      command: server.command,
      argsText: server.args.join('\n'),
      envWhitelistText: server.envWhitelist.join('\n'),
      cwd: server.cwd ?? '',
      enabled: server.enabled,
    });
    setError('');
    setNotice('');
    setDrawerOpen(true);
  };

  const removeServer = async (server: McpServerConfigView) => {
    if (!window.confirm(`移除 MCP 服务「${server.name}」配置？`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await window.cultivation.tools.removeMcpServer(server.id);
      await refresh();
      if (editingId === server.id) closeEditor();
      setNotice('MCP 服务配置已移除。');
    } catch (cause) {
      setError(errorText(cause, '移除 MCP 服务失败。'));
    } finally {
      setBusy(false);
    }
  };

  const discoverTools = async (server: McpServerConfigView) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.cultivation.tools.refreshMcpServer(server.id);
      setServerStatus((current) => ({
        ...current,
        [server.id]: { status: result.status, tools: result.tools },
      }));
      setNotice(
        result.status === 'READY'
          ? `已连接 ${server.name}，发现 ${result.tools.length} 个工具。`
          : `${server.name} 连接失败；请检查配置后重试。`,
      );
    } catch (cause) {
      setServerStatus((current) => ({ ...current, [server.id]: { status: 'ERROR', tools: [] } }));
      setError(errorText(cause, '连接 MCP 服务失败，请检查本机配置。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page wide-page tools-page management-page">
      <header className="page-heading management-heading">
        <h1>工具</h1>
        <button className="button primary" type="button" onClick={openCreate}>
          <Icon name="Add" size={16} />
          添加 MCP 服务
        </button>
      </header>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}

      <Section title="文件工作区" icon="Folder" className="setting-group">
        <div className="setting-row workspace-setting-row">
          <div className="object-row-copy">
            <strong>{workspaceRoot ? '已选择工作区' : '尚未选择工作区'}</strong>
            {workspaceRoot && <span>{workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)}</span>}
          </div>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => void chooseWorkspace()}
          >
            选择工作区
          </button>
        </div>
        {workspaceRoot && (
          <details className="advanced-records">
            <summary>工作区路径</summary>
            <code className="workspace-path">{workspaceRoot}</code>
          </details>
        )}
      </Section>

      <Section
        title="内置工具"
        icon="Tool"
        action={<span className="count-badge">{builtins.length}</span>}
        className="setting-group"
      >
        {loading ? (
          <div className="loading-card">正在读取内置工具…</div>
        ) : builtins.length ? (
          <div className="management-list">
            {builtins.map((tool) => (
              <ToolDescriptorCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : (
          <div className="list-empty">当前没有已注册的内置工具。</div>
        )}
      </Section>

      <Section
        title="MCP 服务"
        icon="Mcp"
        action={<span className="count-badge">{servers.length}</span>}
        className="setting-group"
      >
        {loading ? (
          <div className="loading-card">正在读取 MCP 服务…</div>
        ) : servers.length ? (
          <div className="management-list">
            {servers.map((server) => {
              const state = serverStatus[server.id];
              const isConnected = state?.status === 'READY';
              const connectionTone = isConnected
                ? 'success'
                : state?.status === 'ERROR'
                  ? 'danger'
                  : 'neutral';
              return (
                <article className="object-row mcp-server-row" key={server.id}>
                  <div className="object-row-heading">
                    <div className="object-row-main">
                      <h3>{server.name}</h3>
                    </div>
                    <div className="object-row-statuses">
                      <StatusBadge tone={server.enabled ? 'success' : 'neutral'}>
                        {server.enabled ? '启用' : '停用'}
                      </StatusBadge>
                      <StatusBadge tone={connectionTone}>
                        {isConnected
                          ? `已连接 · ${state.tools.length} 个工具`
                          : state?.status === 'ERROR'
                            ? '连接失败'
                            : '尚未连接'}
                      </StatusBadge>
                    </div>
                  </div>
                  {isConnected && state.tools.length > 0 && (
                    <div className="mcp-discovered-tools">
                      <strong>已发现的工具</strong>
                      <div className="management-list">
                        {state.tools.map((tool) => (
                          <ToolDescriptorCard key={tool.id} tool={tool} compact />
                        ))}
                      </div>
                    </div>
                  )}
                  <details className="advanced-records">
                    <summary>配置详情</summary>
                    <dl>
                      <div>
                        <dt>命令</dt>
                        <dd>
                          <code>{server.command}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>启动参数</dt>
                        <dd>{server.args.length ? server.args.join(' · ') : '无'}</dd>
                      </div>
                      <div>
                        <dt>工作目录</dt>
                        <dd>{server.cwd ?? '未设置'}</dd>
                      </div>
                      <div>
                        <dt>环境变量白名单</dt>
                        <dd>{server.envWhitelist.length} 项</dd>
                      </div>
                      <div>
                        <dt>标识符</dt>
                        <dd>
                          <code>{server.id}</code>
                        </dd>
                      </div>
                    </dl>
                  </details>
                  <div className="button-row compact object-row-actions">
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={busy || !server.enabled}
                      onClick={() => void discoverTools(server)}
                    >
                      {state?.status === 'READY' ? '重新连接' : '连接并发现工具'}
                    </button>
                    <button
                      className="button ghost small"
                      type="button"
                      disabled={busy}
                      onClick={() => editServer(server)}
                    >
                      编辑
                    </button>
                    <button
                      className="button danger-ghost small"
                      type="button"
                      disabled={busy}
                      onClick={() => void removeServer(server)}
                    >
                      移除
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="list-empty">尚未配置 MCP 服务。</div>
        )}
      </Section>

      <Drawer
        title={editingId ? '编辑 MCP 服务' : '添加 MCP 服务'}
        open={drawerOpen}
        onClose={closeEditor}
        className="management-drawer"
      >
        <form className="management-form" onSubmit={(event) => void saveServer(event)}>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <label className="field">
            <span>名称</span>
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>本地命令</span>
            <input
              required
              maxLength={1000}
              value={form.command}
              onChange={(event) => updateForm({ command: event.target.value })}
            />
          </label>
          <label className="field">
            <span>参数（每行一个）</span>
            <textarea
              rows={4}
              maxLength={4000}
              value={form.argsText}
              onChange={(event) => updateForm({ argsText: event.target.value })}
            />
          </label>
          <label className="field">
            <span>环境变量名称白名单</span>
            <textarea
              rows={4}
              maxLength={2000}
              value={form.envWhitelistText}
              onChange={(event) => updateForm({ envWhitelistText: event.target.value })}
            />
          </label>
          <label className="field">
            <span>工作目录</span>
            <input
              maxLength={1000}
              value={form.cwd}
              onChange={(event) => updateForm({ cwd: event.target.value })}
            />
          </label>
          <Switch
            label="启用此 MCP 服务"
            checked={form.enabled}
            onChange={(enabled) => updateForm({ enabled })}
          />
          <div className="button-row drawer-actions">
            <button className="button primary" disabled={busy}>
              {busy ? '保存中…' : editingId ? '保存配置' : '添加服务'}
            </button>
            <button className="button ghost" type="button" onClick={closeEditor}>
              取消
            </button>
          </div>
        </form>
      </Drawer>
    </section>
  );
}

export function ToolDescriptorCard({
  tool,
  compact = false,
}: {
  tool: ToolDescriptorView;
  compact?: boolean;
}) {
  const builtinNames: Record<string, string> = {
    'file.list': '浏览文件夹',
    'file.readText': '读取文本文件',
    'file.writeText': '写入文本文件',
    'file.createDirectory': '创建文件夹',
  };
  return (
    <article className={`object-row tool-descriptor-row ${compact ? 'compact' : ''}`}>
      <div className="object-row-heading">
        <div className="object-row-main">
          <h3>{tool.source === 'BUILTIN' ? (builtinNames[tool.id] ?? tool.name) : tool.name}</h3>
        </div>
        <StatusBadge tone="neutral">{tool.source === 'BUILTIN' ? '内置' : 'MCP'}</StatusBadge>
      </div>
      <details className="advanced-records">
        <summary>工具详情</summary>
        {tool.description && <p>{tool.description}</p>}
        <dl>
          <div>
            <dt>标识符</dt>
            <dd>
              <code>{tool.id}</code>
            </dd>
          </div>
          <div>
            <dt>能力</dt>
            <dd>{tool.capability}</dd>
          </div>
          <div>
            <dt>风险级别</dt>
            <dd>{tool.riskLevel}</dd>
          </div>
          <div>
            <dt>副作用</dt>
            <dd>{tool.sideEffect ? '有' : '无'}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}
