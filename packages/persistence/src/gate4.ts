import Database from 'better-sqlite3';
import type {
  McpServerConfig,
  PendingToolCall,
  PermissionCapability,
  ToolSource,
} from '@cultivation/domain';

const MAX_MCP_ID = 200;
const MAX_MCP_NAME = 200;
const MAX_MCP_COMMAND = 2048;
const MAX_MCP_ARGS = 128;
const MAX_MCP_ARG_LENGTH = 8192;
const MAX_MCP_CONFIG_BYTES = 65_536;
const MAX_WORKSPACE_PATH = 4096;
const MAX_PENDING_INPUT_BYTES = 4 * 1024 * 1024;

interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args_json: string;
  env_whitelist_json: string;
  working_directory: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface PendingToolCallRow {
  approval_id: string;
  mission_id: string;
  run_id: string;
  tool_id: string;
  source: ToolSource;
  capability: PermissionCapability;
  input_json: string;
  step_count: number;
  tool_call_count: number;
  state: PendingToolCall['state'];
  created_at: string;
  resolved_at: string | null;
}

/** Main-process persistence for the explicitly selected workspace and Gate 4 tool state. */
export class Gate4SqliteRepository {
  constructor(private readonly db: Database.Database) {}

  getWorkspaceRoot(): string | null {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'workspace_root'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Passing null clears the selected root; path canonicalization belongs to the filesystem service. */
  setWorkspaceRoot(path: string | null): void {
    if (path === null) {
      this.db.prepare("DELETE FROM app_meta WHERE key = 'workspace_root'").run();
      return;
    }
    if (
      typeof path !== 'string' ||
      path.trim().length === 0 ||
      path.length > MAX_WORKSPACE_PATH ||
      path.includes('\0')
    ) {
      throw new Error('Workspace Root must be a non-empty local path within the length limit');
    }
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES ('workspace_root', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(path);
  }

  listMcpServers(): McpServerConfig[] {
    return (
      this.db
        .prepare('SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE, id')
        .all() as McpServerRow[]
    ).map(mapMcpServer);
  }

  getMcpServer(id: string): McpServerConfig | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
      | McpServerRow
      | undefined;
    return row ? mapMcpServer(row) : null;
  }

  /** Saves command metadata and environment variable names only; environment values never enter SQLite. */
  saveMcpServer(value: McpServerConfig): void {
    validateMcpServer(value);
    this.db
      .prepare(
        `INSERT INTO mcp_servers
          (id, name, command, args_json, env_whitelist_json, working_directory,
           enabled, created_at, updated_at)
         VALUES (@id, @name, @command, @argsJson, @envWhitelistJson, @cwd,
           @enabled, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, command = excluded.command, args_json = excluded.args_json,
           env_whitelist_json = excluded.env_whitelist_json,
           working_directory = excluded.working_directory, enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: value.id,
        name: value.name,
        command: value.command,
        argsJson: JSON.stringify(value.args),
        envWhitelistJson: JSON.stringify(value.envWhitelist),
        cwd: value.cwd,
        enabled: value.enabled ? 1 : 0,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
  }

  deleteMcpServer(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
  }

  savePendingToolCall(value: PendingToolCall): void {
    validatePendingToolCall(value);
    this.db
      .prepare(
        `INSERT INTO pending_tool_calls
          (approval_id, mission_id, run_id, tool_id, source, capability, input_json,
           step_count, tool_call_count, state, created_at, resolved_at)
         VALUES (@approvalId, @missionId, @runId, @toolId, @source, @capability, @inputJson,
           @stepCount, @toolCallCount, @state, @createdAt, @resolvedAt)`,
      )
      .run(value);
  }

  getPendingToolCall(approvalId: string): PendingToolCall | null {
    const row = this.db
      .prepare('SELECT * FROM pending_tool_calls WHERE approval_id = ?')
      .get(approvalId) as PendingToolCallRow | undefined;
    return row ? mapPendingToolCall(row) : null;
  }

  /** Atomically resolves a pending tool request once and returns null after the first resolution. */
  resolvePendingToolCall(approvalId: string, resolvedAt: string): PendingToolCall | null {
    if (!isNonEmptyString(resolvedAt, 128)) throw new Error('Invalid pending tool resolution time');
    return this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE pending_tool_calls SET state = 'RESOLVED', resolved_at = ?
           WHERE approval_id = ? AND state = 'PENDING' AND resolved_at IS NULL`,
        )
        .run(resolvedAt, approvalId).changes;
      if (changed === 0) return null;
      return this.getPendingToolCall(approvalId);
    })();
  }
}

function mapMcpServer(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: parseStringArray(row.args_json, 'MCP arguments'),
    envWhitelist: parseStringArray(row.env_whitelist_json, 'MCP environment whitelist'),
    cwd: row.working_directory,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPendingToolCall(row: PendingToolCallRow): PendingToolCall {
  return {
    approvalId: row.approval_id,
    missionId: row.mission_id,
    runId: row.run_id,
    toolId: row.tool_id,
    source: row.source,
    capability: row.capability,
    inputJson: row.input_json,
    stepCount: row.step_count,
    toolCallCount: row.tool_call_count,
    state: row.state,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function parseStringArray(value: string, label: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`Invalid persisted ${label}`);
  }
  return parsed;
}

function validateMcpServer(value: McpServerConfig): void {
  if (!isNonEmptyString(value.id, MAX_MCP_ID)) throw new Error('Invalid MCP server id');
  if (!isNonEmptyString(value.name, MAX_MCP_NAME)) throw new Error('Invalid MCP server name');
  if (!isNonEmptyString(value.command, MAX_MCP_COMMAND)) throw new Error('Invalid MCP command');
  if (
    !Array.isArray(value.args) ||
    value.args.length > MAX_MCP_ARGS ||
    !value.args.every((arg) => isString(arg, MAX_MCP_ARG_LENGTH))
  ) {
    throw new Error('Invalid MCP arguments');
  }
  if (
    !Array.isArray(value.envWhitelist) ||
    value.envWhitelist.length > MAX_MCP_ARGS ||
    !value.envWhitelist.every((name) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) ||
    new Set(value.envWhitelist).size !== value.envWhitelist.length
  ) {
    throw new Error('MCP environment whitelist must contain unique variable names only');
  }
  if (value.cwd !== null && !isNonEmptyString(value.cwd, MAX_WORKSPACE_PATH)) {
    throw new Error('Invalid MCP working directory');
  }
  if (typeof value.enabled !== 'boolean') throw new Error('Invalid MCP enabled flag');
  if (!isNonEmptyString(value.createdAt, 128) || !isNonEmptyString(value.updatedAt, 128)) {
    throw new Error('Invalid MCP timestamps');
  }
  const configBytes =
    Buffer.byteLength(JSON.stringify(value.args), 'utf8') +
    Buffer.byteLength(JSON.stringify(value.envWhitelist), 'utf8');
  if (configBytes > MAX_MCP_CONFIG_BYTES) throw new Error('MCP configuration is too large');
}

function validatePendingToolCall(value: PendingToolCall): void {
  if (!isNonEmptyString(value.approvalId, MAX_MCP_ID)) throw new Error('Invalid approval id');
  if (!isNonEmptyString(value.missionId, MAX_MCP_ID)) throw new Error('Invalid Mission id');
  if (!isNonEmptyString(value.runId, MAX_MCP_ID)) throw new Error('Invalid Run id');
  if (!isNonEmptyString(value.toolId, 512)) throw new Error('Invalid tool id');
  if (value.source !== 'BUILTIN' && value.source !== 'MCP') throw new Error('Invalid tool source');
  if (!isPermissionCapability(value.capability)) throw new Error('Invalid tool capability');
  if (!isString(value.inputJson, MAX_PENDING_INPUT_BYTES))
    throw new Error('Tool input is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.inputJson);
  } catch {
    throw new Error('Tool input must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool input must be a JSON object');
  }
  if (!Number.isSafeInteger(value.stepCount) || value.stepCount < 0) {
    throw new Error('Invalid Mission step count');
  }
  if (!Number.isSafeInteger(value.toolCallCount) || value.toolCallCount < 0) {
    throw new Error('Invalid tool call count');
  }
  if (value.state !== 'PENDING' || value.resolvedAt !== null) {
    throw new Error('New pending tool calls must be unresolved');
  }
  if (!isNonEmptyString(value.createdAt, 128))
    throw new Error('Invalid pending tool creation time');
}

function isPermissionCapability(value: string): value is PermissionCapability {
  return [
    'MEMORY_READ',
    'MEMORY_WRITE',
    'FILE_READ',
    'FILE_WRITE',
    'MCP_TOOL_EXECUTE',
    'INVITE_TEAMMATE',
    'CREATE_MISSION',
    'SPEND_BUDGET',
    'WEB_ACCESS',
    'BROWSER_CONTROL',
    'EXECUTE_COMMAND',
    'EXTERNAL_MESSAGE',
    'INSTALL_TOOL',
  ].includes(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return isString(value, maxLength) && value.trim().length > 0;
}

function isString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0');
}
