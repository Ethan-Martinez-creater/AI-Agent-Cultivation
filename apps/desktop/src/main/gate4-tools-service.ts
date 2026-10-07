import { dialog, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import type { McpServerConfig, ToolDescriptor } from '@cultivation/domain';
import { ToolRegistry } from '@cultivation/application/tool-runtime';
import { Gate4SqliteRepository } from '@cultivation/persistence';
import { FileWorkspace } from './file-workspace.js';
import { registerBuiltins, unregisterBuiltins } from './gate4-builtins.js';
import { McpHost } from './mcp-host.js';

export interface McpServerInput {
  id?: string;
  name: string;
  command: string;
  args: string[];
  envWhitelist: string[];
  cwd: string | null;
  enabled: boolean;
}

export interface McpServerStatus {
  status: 'READY' | 'ERROR';
  tools: ToolDescriptor[];
  message: string;
}

/** Main-only configuration service. MCP execute is exposed to ToolRuntime alone. */
export class Gate4ToolsService {
  private readonly registeredByServer = new Map<string, string[]>();

  constructor(
    private readonly store: Gate4SqliteRepository,
    readonly registry: ToolRegistry,
    private readonly mcp: McpHost,
  ) {}

  async initialize(): Promise<void> {
    const root = this.store.getWorkspaceRoot();
    if (root) {
      try {
        registerBuiltins(this.registry, await FileWorkspace.open(root));
        this.restoreBuiltinPurposes();
      } catch {
        unregisterBuiltins(this.registry);
      }
    }
    await Promise.allSettled(
      this.store
        .listMcpServers()
        .filter((server) => server.enabled)
        .map((server) => this.refreshMcpServer(server.id)),
    );
  }

  getWorkspace(): { rootPath: string | null } {
    return { rootPath: this.store.getWorkspaceRoot() };
  }

  async chooseWorkspace(window: BrowserWindow): Promise<{ rootPath: string | null }> {
    const chosen = await dialog.showOpenDialog(window, {
      title: '选择 Workspace Root',
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    if (chosen.canceled || chosen.filePaths.length !== 1) return this.getWorkspace();
    const workspace = await FileWorkspace.open(chosen.filePaths[0]!);
    this.store.setWorkspaceRoot(workspace.getRoot());
    registerBuiltins(this.registry, workspace);
    this.restoreBuiltinPurposes();
    return this.getWorkspace();
  }

  listBuiltins(): ToolDescriptor[] {
    return this.registry.list().filter((descriptor) => descriptor.source === 'BUILTIN');
  }

  /** Read-only readiness filter for model offerings; execution still enters ToolRuntime. */
  currentlyUsable(descriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
    return descriptors.filter(
      (descriptor) =>
        descriptor.source === 'BUILTIN' ||
        [...this.registeredByServer.entries()].some(
          ([serverId, ids]) =>
            ids.includes(descriptor.id) && this.mcp.isToolReady(serverId, descriptor.id),
        ),
    );
  }

  private restoreBuiltinPurposes(): void {
    for (const descriptor of this.registry.list().filter((tool) => tool.source === 'BUILTIN'))
      descriptor.workflowPurposes = this.store.getToolPurposes(descriptor.id);
  }

  setToolPurposes(
    toolId: string,
    purposes: import('@cultivation/domain').ToolPurpose[],
  ): ToolDescriptor {
    const tool = this.registry.get(toolId);
    if (!tool) throw new Error('Tool must be discovered before binding');
    this.store.setToolPurposes(toolId, purposes);
    tool.descriptor.workflowPurposes = this.store.getToolPurposes(toolId);
    return tool.descriptor;
  }

  listMcpServers(): McpServerConfig[] {
    return this.store.listMcpServers();
  }

  async saveMcpServer(input: McpServerInput): Promise<McpServerConfig> {
    const existing = input.id ? this.store.getMcpServer(input.id) : null;
    const now = new Date().toISOString();
    const config: McpServerConfig = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      command: input.command.trim(),
      args: input.args,
      envWhitelist: input.envWhitelist,
      cwd: input.cwd,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (input.id && !existing) throw new Error('MCP server was not found');
    this.store.saveMcpServer(config);
    await this.unloadMcp(config.id);
    return config;
  }

  async removeMcpServer(id: string): Promise<void> {
    await this.unloadMcp(id);
    if (!this.store.deleteMcpServer(id)) throw new Error('MCP server was not found');
  }

  async refreshMcpServer(id: string): Promise<McpServerStatus> {
    const config = this.store.getMcpServer(id);
    if (!config || !config.enabled)
      return { status: 'ERROR', tools: [], message: 'MCP server is disabled or missing.' };
    await this.unloadMcp(id);
    const ids: string[] = [];
    try {
      const descriptors = await this.mcp.discover(config);
      const configTag = createHash('sha256')
        .update(JSON.stringify(config))
        .digest('hex')
        .slice(0, 16);
      for (const descriptor of descriptors) {
        // Remote metadata cannot grant Workflow eligibility; the user owns this mapping.
        descriptor.workflowPurposes = this.store.getToolPurposes(descriptor.id);
        this.registry.register({
          descriptor,
          resource: () => `mcp:${config.id}:${configTag}:${descriptor.toolName}`,
          execute: async (input) => {
            const output = await this.mcp.execute(config.id, descriptor.toolName, input);
            return {
              ok: output.success,
              code: output.errorCode ?? (output.success ? 'OK' : 'MCP_TOOL_FAILED'),
              content: JSON.stringify({
                content: output.content,
                ...(output.structuredContent
                  ? { structuredContent: output.structuredContent }
                  : {}),
              }).slice(0, 64 * 1024),
            };
          },
        });
        ids.push(descriptor.id);
      }
      this.registeredByServer.set(id, ids);
      return {
        status: 'READY',
        tools: descriptors,
        message: `${descriptors.length} MCP tools discovered.`,
      };
    } catch {
      for (const toolId of ids) this.registry.unregister(toolId);
      await this.unloadMcp(id);
      return {
        status: 'ERROR',
        tools: [],
        message: 'MCP server failed to connect or expose valid tools.',
      };
    }
  }

  async close(): Promise<void> {
    await this.mcp.closeAll();
  }

  private async unloadMcp(id: string): Promise<void> {
    for (const toolId of this.registeredByServer.get(id) ?? []) this.registry.unregister(toolId);
    this.registeredByServer.delete(id);
    await this.mcp.close(id);
  }
}
