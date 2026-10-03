import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, ToolRuntime } from '@cultivation/application/tool-runtime';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import type { ToolPurpose } from '@cultivation/domain';
vi.mock('electron', () => ({ dialog: {} }));
import { Gate4ToolsService } from './gate4-tools-service.js';

describe('trusted local purpose overlay', () => {
  it('requires discovery, ignores remote purpose hints and restores local bindings without permission bypass', async () => {
    const bindings = new Map<string, ToolPurpose[]>();
    const store = {
      getMcpServer: () => ({ id: 'plain', enabled: true }),
      getToolPurposes: (id: string) => bindings.get(id) ?? [],
      setToolPurposes: (id: string, value: ToolPurpose[]) => bindings.set(id, [...value]),
    };
    const execute = vi.fn(async () => ({ success: true, content: [] }));
    const mcp = {
      close: async () => undefined,
      discover: async () => [
        {
          id: 'plain:voice',
          toolName: 'voice',
          source: 'MCP',
          name: 'voice',
          description: '',
          capability: 'MCP_TOOL_EXECUTE',
          inputSchema: { type: 'object' },
          riskLevel: 'HIGH',
          sideEffect: 'EXTERNAL_WRITE',
          workflowPurposes: ['RESEARCH'],
        },
      ],
      execute,
    };
    const registry = new ToolRegistry();
    const service = new Gate4ToolsService(store as never, registry, mcp as never);
    expect(() => service.setToolPurposes('missing', ['VOICEOVER'])).toThrow();
    expect((await service.refreshMcpServer('plain')).tools[0]?.workflowPurposes).toEqual([]);
    service.setToolPurposes('plain:voice', ['VOICEOVER']);
    expect(registry.list()[0]?.workflowPurposes).toEqual(['VOICEOVER']);
    expect((await service.refreshMcpServer('plain')).tools[0]?.workflowPurposes).toEqual([
      'VOICEOVER',
    ]);
    const engine = new PermissionEngine({ listPermissionRules: () => [] } as never);
    const result = await new ToolRuntime(registry, engine).dispatch(
      { id: 'call', toolId: 'plain:voice', input: {} },
      { missionId: 'mission', runId: 'run', teammateId: 'actor' },
    );
    expect(result.kind).toBe('APPROVAL');
    expect(execute).not.toHaveBeenCalled();
  });
});
