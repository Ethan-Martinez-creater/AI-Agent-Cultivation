import React, { useEffect, useState } from 'react';
import { errorText, PageHeading } from '../ui-shared.js';
import type { ToolDescriptorView, McpServerConfigView } from '../ui-shared.js';

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

export function ToolsPage() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [builtins, setBuiltins] = useState<ToolDescriptorView[]>([]);
  const [servers, setServers] = useState<McpServerConfigView[]>([]);
  const [serverStatus, setServerStatus] = useState<
    Record<string, { status: 'READY' | 'ERROR'; tools: ToolDescriptorView[] }>
  >({});
  const [form, setForm] = useState(blankMcpServerForm);
  const [editingId, setEditingId] = useState('');
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
      const next: typeof current = {};
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

  const chooseWorkspace = async () => {
    setError('');
    setNotice('');
    try {
      const selected = await window.cultivation.tools.chooseWorkspace();
      if (selected.rootPath) {
        setWorkspaceRoot(selected.rootPath);
        setNotice('工作区已更新。文件工具会限制在此目录内。');
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
      setForm(blankMcpServerForm);
      setEditingId('');
      setNotice('MCP Server 配置已保存。');
    } catch (cause) {
      setError(errorText(cause, '保存 MCP Server 失败。'));
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
  };

  const removeServer = async (server: McpServerConfigView) => {
    if (!window.confirm(`移除 MCP Server「${server.name}」配置？`)) return;
    setBusy(true);
    setError('');
    try {
      await window.cultivation.tools.removeMcpServer(server.id);
      await refresh();
      if (editingId === server.id) {
        setEditingId('');
        setForm(blankMcpServerForm);
      }
      setNotice('MCP Server 配置已移除。');
    } catch (cause) {
      setError(errorText(cause, '移除 MCP Server 失败。'));
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
          : `${server.name} 连接失败；请检查本机配置。`,
      );
    } catch {
      setServerStatus((current) => ({ ...current, [server.id]: { status: 'ERROR', tools: [] } }));
      setError('MCP Server 连接失败；请检查本机配置。');
    } finally {
      setBusy(false);
    }
  };

  const updateForm = (patch: Partial<McpServerForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <section className="page wide-page tools-page">
      <PageHeading
        eyebrow="Gate 4 · Tool Runtime"
        title="法宝 Tools"
        description="选择文件工作区，查看可用内置工具，并手动配置受控的 MCP stdio Server。工具调用由 Mission Runtime 统一验证、授权和审计。"
      />
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

      <section className="tool-panel workspace-panel">
        <div className="section-heading">
          <div>
            <h2>文件工作区</h2>
            <p>文件工具只能读取或写入明确选择的目录。</p>
          </div>
          <button
            className="button primary small"
            type="button"
            onClick={() => void chooseWorkspace()}
          >
            选择工作区
          </button>
        </div>
        <div className={`workspace-path ${workspaceRoot ? '' : 'unselected'}`}>
          {workspaceRoot ?? '尚未选择工作区'}
        </div>
      </section>

      <section className="tool-panel">
        <div className="section-heading">
          <div>
            <h2>内置工具</h2>
            <p>每次调用都经过能力校验、Mission Permission 与审计记录。</p>
          </div>
          <span className="count-badge">{builtins.length}</span>
        </div>
        {loading ? (
          <div className="loading-card">正在读取内置工具…</div>
        ) : builtins.length ? (
          <div className="tool-descriptor-grid">
            {builtins.map((tool) => (
              <ToolDescriptorCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : (
          <div className="list-empty">当前没有已注册的内置工具。</div>
        )}
      </section>

      <div className="mcp-workspace">
        <form className="tool-panel mcp-form" onSubmit={(event) => void saveServer(event)}>
          <div className="form-title-row">
            <div>
              <p className="eyebrow">MANUAL STDIO CONFIG</p>
              <h2>{editingId ? '编辑 MCP Server' : '添加 MCP Server'}</h2>
            </div>
            {editingId && (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setEditingId('');
                  setForm(blankMcpServerForm);
                }}
              >
                取消
              </button>
            )}
          </div>
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
              placeholder="例如：node"
            />
          </label>
          <label className="field">
            <span>
              参数 <small>每行一个</small>
            </span>
            <textarea
              rows={3}
              maxLength={4000}
              value={form.argsText}
              onChange={(event) => updateForm({ argsText: event.target.value })}
              placeholder="例如：server.js"
            />
          </label>
          <label className="field">
            <span>
              环境变量名称白名单 <small>只填写变量名称，不填写变量值</small>
            </span>
            <textarea
              rows={3}
              maxLength={2000}
              value={form.envWhitelistText}
              onChange={(event) => updateForm({ envWhitelistText: event.target.value })}
              placeholder="每行一个，例如：MCP_DATA_DIR"
            />
          </label>
          <label className="field">
            <span>
              工作目录 <small>可选</small>
            </span>
            <input
              maxLength={1000}
              value={form.cwd}
              onChange={(event) => updateForm({ cwd: event.target.value })}
              placeholder="留空使用应用默认目录"
            />
          </label>
          <label className="tool-enabled-toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => updateForm({ enabled: event.target.checked })}
            />
            <span>启用此 MCP Server</span>
          </label>
          <p className="form-hint">
            仅保存你手动提供的 stdio 配置。应用不会替你安装 Server；连接与工具发现需由你明确点击。
          </p>
          <button className="button primary full-width" disabled={busy}>
            {busy ? '保存中…' : editingId ? '保存配置' : '添加 Server'}
          </button>
        </form>

        <section className="tool-panel mcp-server-list">
          <div className="section-heading">
            <div>
              <h2>MCP Servers</h2>
              <p>连接状态只在手动发现工具后更新。</p>
            </div>
            <span className="count-badge">{servers.length}</span>
          </div>
          {loading ? (
            <div className="loading-card">正在读取 Server…</div>
          ) : servers.length ? (
            <div className="mcp-server-stack">
              {servers.map((server) => {
                const state = serverStatus[server.id];
                return (
                  <article className="mcp-server-card" key={server.id}>
                    <div className="mcp-server-top">
                      <div>
                        <h3>{server.name}</h3>
                        <p className="mcp-server-command">{server.command}</p>
                      </div>
                      <span className={`status-pill ${server.enabled ? 'active' : 'archived'}`}>
                        {server.enabled ? '已启用' : '已停用'}
                      </span>
                    </div>
                    <div className="mcp-server-meta">
                      <span>参数 {server.args.length} 项</span>
                      <span>环境白名单 {server.envWhitelist.length} 项</span>
                      {server.cwd && <span>工作目录已设置</span>}
                    </div>
                    <div className="mcp-discovery-status">
                      <span className={`status-dot ${state?.status === 'READY' ? '' : 'muted'}`} />
                      {state?.status === 'READY'
                        ? `已连接 · ${state.tools.length} 个工具`
                        : state?.status === 'ERROR'
                          ? '连接失败'
                          : '尚未连接'}
                    </div>
                    {state?.status === 'READY' && state.tools.length > 0 && (
                      <div className="mcp-discovered-tools">
                        {state.tools.map((tool) => (
                          <ToolDescriptorCard key={tool.id} tool={tool} compact />
                        ))}
                      </div>
                    )}
                    <div className="button-row compact">
                      <button
                        className="button secondary small"
                        type="button"
                        disabled={busy || !server.enabled}
                        onClick={() => void discoverTools(server)}
                      >
                        连接并发现工具
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
            <div className="list-empty">尚未配置 MCP Server。</div>
          )}
        </section>
      </div>
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
  return (
    <article className={`tool-descriptor-card ${compact ? 'compact' : ''}`}>
      <div className="tool-descriptor-top">
        <div>
          <h3>{tool.name}</h3>
          <code>{tool.id}</code>
        </div>
        <span className="tool-source-pill">{tool.source}</span>
      </div>
      <p>{tool.description || '无说明'}</p>
      <div className="tool-descriptor-meta">
        <span>{tool.capability}</span>
        <span>风险 {tool.riskLevel}</span>
        <span>{tool.sideEffect ? '有副作用' : '只读'}</span>
      </div>
    </article>
  );
}
