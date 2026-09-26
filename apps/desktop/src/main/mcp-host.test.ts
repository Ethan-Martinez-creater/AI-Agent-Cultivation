import { afterEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpHost, McpHostError, type McpServerConfig } from './mcp-host.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '../../../..');
const fixturePath = resolve(testDirectory, 'fixtures/gate4-mcp-fixture.mjs');
const originalEnvironment = new Map<string, string | undefined>();
const hosts: McpHost[] = [];

describe('McpHost', () => {
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.closeAll()));
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnvironment.clear();
  });

  it('discovers normalized tools and executes discovered tool calls', async () => {
    const host = makeHost();
    const config = serverConfig();
    const tools = await host.discover(config);

    expect(tools.map((tool) => tool.toolName)).toContain('echo');
    expect(tools.find((tool) => tool.toolName === 'echo')).toMatchObject({
      id: 'fixture-server:echo',
      source: 'MCP',
      capability: 'MCP_TOOL_EXECUTE',
      riskLevel: 'HIGH',
      sideEffect: 'PROCESS_EXECUTION',
    });

    const result = await host.execute(config.id, 'echo', { message: 'hello MCP' });
    expect(result).toMatchObject({
      toolId: 'fixture-server:echo',
      success: true,
      summary: 'echo:hello MCP',
    });
  });

  it('does not pass ambient environment values and redacts allowlisted values from results', async () => {
    setEnvironment('MCP_GATE4_ALLOWED', 'fixture-secret-value');
    setEnvironment('MCP_GATE4_BLOCKED', 'ambient-value-must-not-pass');
    setEnvironment('NODE_OPTIONS', '--require=ambient-must-not-pass');
    const host = makeHost();
    const config = serverConfig({ envWhitelist: ['MCP_GATE4_ALLOWED', 'NODE_OPTIONS'] });

    await host.discover(config);
    const result = await host.execute(config.id, 'env', { message: 'ignored by fixture' });

    expect(result.summary).toContain('"allowed":"[redacted]"');
    expect(result.summary).toContain('"blocked":null');
    expect(result.summary).toContain('"nodeOptions":null');
    expect(result.summary).not.toContain('fixture-secret-value');
    expect(result.summary).not.toContain('ambient-value-must-not-pass');
    expect(result.summary).not.toContain('ambient-must-not-pass');
  });

  it('rejects malformed discovered schemas and invalid input before execution', async () => {
    const malformedHost = makeHost();
    await expect(
      malformedHost.discover(serverConfig({ mode: 'bad-schema' })),
    ).rejects.toMatchObject({
      code: 'MCP_SCHEMA_INVALID',
    });

    const host = makeHost();
    const config = serverConfig();
    await host.discover(config);
    await expect(host.execute(config.id, 'echo', null)).rejects.toMatchObject({
      code: 'MCP_INPUT_INVALID',
    });
  });

  it('fails closed on server crash and bounded discovery/tool timeouts', async () => {
    const crashingHost = makeHost();
    await expect(
      crashingHost.discover(serverConfig({ mode: 'crash-discovery' })),
    ).rejects.toBeInstanceOf(McpHostError);

    const crashDuringCallHost = makeHost();
    const crashDuringCallConfig = serverConfig();
    await crashDuringCallHost.discover(crashDuringCallConfig);
    await expect(
      crashDuringCallHost.execute(crashDuringCallConfig.id, 'crash', { message: 'trigger crash' }),
    ).rejects.toMatchObject({ code: 'MCP_SERVER_CRASHED' });

    const timedConnectHost = makeHost({ connectTimeoutMs: 120 });
    await expect(
      timedConnectHost.discover(serverConfig({ mode: 'timeout-initialize' })),
    ).rejects.toMatchObject({ code: 'MCP_CONNECT_TIMEOUT' });

    const timedDiscoveryHost = makeHost({ requestTimeoutMs: 120 });
    await expect(
      timedDiscoveryHost.discover(serverConfig({ mode: 'timeout-discovery' })),
    ).rejects.toMatchObject({ code: 'MCP_REQUEST_TIMEOUT' });

    const timedCallHost = makeHost({ requestTimeoutMs: 120 });
    const config = serverConfig();
    await timedCallHost.discover(config);
    await expect(
      timedCallHost.execute(config.id, 'slow', { message: 'never returned' }),
    ).rejects.toMatchObject({ code: 'MCP_REQUEST_TIMEOUT' });
  });

  it('fails closed when structured tool output violates the discovered schema', async () => {
    const host = makeHost();
    const config = serverConfig({ mode: 'bad-output-schema' });
    await host.discover(config);

    await expect(
      host.execute(config.id, 'echo', { message: 'check schema' }),
    ).resolves.toMatchObject({
      success: false,
      errorCode: 'MCP_SCHEMA_INVALID',
    });
  });

  it('normalizes MCP-reported tool errors without throwing through the host', async () => {
    const host = makeHost();
    const config = serverConfig();
    await host.discover(config);

    await expect(host.execute(config.id, 'failure', { message: 'ignored' })).resolves.toMatchObject(
      {
        success: false,
        summary: 'fixture failure',
      },
    );
  });
});

function makeHost(options: ConstructorParameters<typeof McpHost>[0] = {}): McpHost {
  const host = new McpHost(options);
  hosts.push(host);
  return host;
}

function serverConfig(
  overrides: Partial<McpServerConfig> & { mode?: string } = {},
): McpServerConfig {
  const { mode = 'normal', ...config } = overrides;
  return {
    id: 'fixture-server',
    name: 'Deterministic MCP fixture',
    command: process.execPath,
    args: [fixturePath, mode],
    envWhitelist: [],
    cwd: projectDirectory,
    enabled: true,
    ...config,
  };
}

function setEnvironment(name: string, value: string): void {
  if (!originalEnvironment.has(name)) originalEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}
