import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, McpServerConfig, Mission } from '@cultivation/domain';
import { Gate3SqliteRepository } from './gate3.js';
import { Gate4SqliteRepository } from './gate4.js';
import { migrations, runMigrations } from './index.js';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  db.exec(`
    INSERT INTO providers (id, name, kind, created_at, updated_at)
      VALUES ('provider-1', 'Fixture', 'OPENAI_COMPATIBLE', 'now', 'now');
    INSERT INTO runtime_profiles (id, name, provider_id, model_id, created_at, updated_at)
      VALUES ('runtime-1', 'Fixture', 'provider-1', 'fixture-model', 'now', 'now');
    INSERT INTO teammates (id, name, current_runtime_profile_id, created_at, updated_at)
      VALUES ('teammate-1', 'Fixture', 'runtime-1', 'now', 'now');
  `);
  return { db, gate3: new Gate3SqliteRepository(db), gate4: new Gate4SqliteRepository(db) };
}

function addMission(gate3: Gate3SqliteRepository, missionId: string, approvalId: string): void {
  const mission: Mission = {
    id: missionId,
    title: missionId,
    objective: 'Fixture objective',
    initiatorType: 'USER',
    initiatorId: 'user-1',
    coordinatorTeammateId: 'teammate-1',
    partyId: null,
    mode: 'SOLO',
    state: 'DRAFT',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    completedAt: null,
  };
  gate3.insertMission(mission);
  gate3.transitionMission({ ...mission, state: 'READY' }, 'DRAFT');
  gate3.transitionMission({ ...mission, state: 'RUNNING' }, 'READY');
  const run = gate3.createRun(missionId, '2026-09-26T00:01:00.000Z');
  gate3.insertApproval({
    id: approvalId,
    missionId,
    runId: run.id,
    requesterTeammateId: 'teammate-1',
    capability: 'FILE_WRITE',
    actionType: 'TOOL_CALL',
    actionPayload: { toolId: 'file.writeText' },
    riskLevel: 'MEDIUM',
    state: 'PENDING',
    createdAt: '2026-09-26T00:02:00.000Z',
    resolvedAt: null,
  } satisfies ApprovalRequest);
}

const mcpServer: McpServerConfig = {
  id: 'mcp-1',
  name: 'Local fixture',
  command: 'node',
  args: ['fixture-server.js'],
  envWhitelist: ['FIXTURE_TOKEN', 'PATH'],
  cwd: 'E:/workspace/mcp-fixture',
  enabled: false,
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
};

describe('Gate 4 persistence', () => {
  it('applies migration 0005 after the prior migrations and stores one explicit workspace root', () => {
    const { db, gate4 } = setup();
    expect(migrations.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(gate4.getWorkspaceRoot()).toBeNull();
    gate4.setWorkspaceRoot('E:/workspace/project');
    expect(gate4.getWorkspaceRoot()).toBe('E:/workspace/project');
    gate4.setWorkspaceRoot('E:/workspace/other');
    expect(gate4.getWorkspaceRoot()).toBe('E:/workspace/other');
    gate4.setWorkspaceRoot(null);
    expect(gate4.getWorkspaceRoot()).toBeNull();
    expect(() => gate4.setWorkspaceRoot('E:/bad\0path')).toThrow();
    db.close();
  });

  it('persists MCP stdio metadata and only environment variable names', () => {
    const { db, gate4 } = setup();
    gate4.saveMcpServer(mcpServer);
    expect(gate4.getMcpServer('mcp-1')).toEqual(mcpServer);
    expect(gate4.listMcpServers()).toEqual([mcpServer]);
    const persisted = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get('mcp-1') as {
      env_whitelist_json: string;
      created_at: string;
      updated_at: string;
    };
    expect(persisted.env_whitelist_json).toBe('["FIXTURE_TOKEN","PATH"]');
    expect(persisted.env_whitelist_json).not.toContain('secret-value');
    expect(persisted.created_at).toBe(mcpServer.createdAt);
    expect(persisted.updated_at).toBe(mcpServer.updatedAt);
    expect(() =>
      gate4.saveMcpServer({ ...mcpServer, id: 'bad', envWhitelist: ['KEY=secret'] }),
    ).toThrow();
    expect(() =>
      gate4.saveMcpServer({ ...mcpServer, id: 'bad', envWhitelist: ['DUP', 'DUP'] }),
    ).toThrow();
    expect(gate4.deleteMcpServer('mcp-1')).toBe(true);
    expect(gate4.deleteMcpServer('mcp-1')).toBe(false);
    db.close();
  });

  it('binds pending tool calls to the approval Mission and Run and resolves them once', () => {
    const { db, gate3, gate4 } = setup();
    addMission(gate3, 'mission-1', 'approval-1');
    addMission(gate3, 'mission-2', 'approval-2');
    const run1 = gate3.listRuns('mission-1')[0]!;
    const pending = {
      approvalId: 'approval-1',
      missionId: 'mission-1',
      runId: run1.id,
      toolId: 'file.writeText',
      source: 'BUILTIN' as const,
      capability: 'FILE_WRITE' as const,
      inputJson: JSON.stringify({ path: 'notes.txt', content: 'approved content' }),
      stepCount: 2,
      toolCallCount: 1,
      state: 'PENDING' as const,
      createdAt: '2026-09-26T00:03:00.000Z',
      resolvedAt: null,
    };
    gate4.savePendingToolCall(pending);
    expect(gate4.getPendingToolCall('approval-1')).toEqual(pending);

    const run2 = gate3.listRuns('mission-2')[0]!;
    expect(() =>
      gate4.savePendingToolCall({
        ...pending,
        approvalId: 'approval-2',
        missionId: 'mission-2',
        runId: run1.id,
      }),
    ).toThrow(/match its approval/);
    expect(() => gate4.savePendingToolCall({ ...pending, runId: run2.id })).toThrow(
      /match its approval/,
    );
    expect(() =>
      gate4.savePendingToolCall({
        ...pending,
        approvalId: 'approval-2',
        missionId: 'mission-2',
        runId: run2.id,
        capability: 'FILE_READ',
      }),
    ).toThrow(/match its approval/);

    const resolved = gate4.resolvePendingToolCall('approval-1', '2026-09-26T00:04:00.000Z');
    expect(resolved).toEqual({
      ...pending,
      state: 'RESOLVED',
      resolvedAt: '2026-09-26T00:04:00.000Z',
    });
    expect(gate4.resolvePendingToolCall('approval-1', '2026-09-26T00:05:00.000Z')).toBeNull();
    expect(() =>
      db
        .prepare("UPDATE pending_tool_calls SET input_json = '{}' WHERE approval_id = 'approval-1'")
        .run(),
    ).toThrow(/resolved once/);
    expect(() =>
      db.prepare("DELETE FROM pending_tool_calls WHERE approval_id = 'approval-1'").run(),
    ).toThrow(/retained/);
    db.close();
  });
});
