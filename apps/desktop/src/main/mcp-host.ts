import { Client } from '@modelcontextprotocol/client';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  envWhitelist: string[];
  cwd: string | null;
  enabled: boolean;
}

export type McpRiskLevel = 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH';
export type McpSideEffect = 'NONE' | 'LOCAL_WRITE' | 'EXTERNAL_WRITE' | 'PROCESS_EXECUTION';

/** MCP tools are treated as process-backed, high-risk tools until reviewed by the user. */
export interface McpToolDescriptor {
  id: string;
  serverId: string;
  toolName: string;
  source: 'MCP';
  capability: 'MCP_TOOL_EXECUTE';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: McpRiskLevel;
  sideEffect: McpSideEffect;
}

export interface McpExecutionResult {
  toolId: string;
  success: boolean;
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  summary: string;
  errorCode?: string;
}

export interface McpHostOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class McpHostError extends Error {
  constructor(
    readonly code:
      | 'MCP_CONFIG_INVALID'
      | 'MCP_SERVER_DISABLED'
      | 'MCP_CONNECT_FAILED'
      | 'MCP_CONNECT_TIMEOUT'
      | 'MCP_REQUEST_FAILED'
      | 'MCP_REQUEST_TIMEOUT'
      | 'MCP_SERVER_CRASHED'
      | 'MCP_SCHEMA_INVALID'
      | 'MCP_INPUT_INVALID'
      | 'MCP_TOOL_NOT_FOUND',
  ) {
    super(code);
    this.name = 'McpHostError';
  }
}

interface McpSession {
  readonly configFingerprint: string;
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly tools: Map<
    string,
    {
      descriptor: McpToolDescriptor;
      wireName: string;
      outputSchema?: Record<string, unknown>;
    }
  >;
  readonly sensitiveEnvironmentValues: string[];
  closed: boolean;
}

const MAX_SERVER_NAME_LENGTH = 160;
const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGS = 128;
const MAX_ARG_LENGTH = 8192;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_DISCOVERED_TOOLS = 256;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_ENTRIES = 256;
const MAX_RESULT_TEXT_LENGTH = 16_000;
const MAX_RESULT_STRUCTURED_LENGTH = 16_000;
const MAX_RESULT_BLOCKS = 100;

const BLOCKED_ENVIRONMENT_NAME = /^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|LD_.*|DYLD_.*)$/i;

/**
 * Owns stdio MCP clients for Main Process use. Discovery and execution must be
 * called by ToolRegistry/ToolRuntime after their common permission pipeline.
 */
export class McpHost {
  private readonly sessions = new Map<string, McpSession>();
  private readonly pending = new Map<string, Promise<McpSession>>();
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: McpHostOptions = {}) {
    this.connectTimeoutMs = clampTimeout(options.connectTimeoutMs ?? 10_000);
    this.requestTimeoutMs = clampTimeout(options.requestTimeoutMs ?? 30_000);
  }

  async discover(config: McpServerConfig): Promise<McpToolDescriptor[]> {
    validateConfig(config);
    if (!config.enabled) throw new McpHostError('MCP_SERVER_DISABLED');

    const session = await this.getOrConnect(config);
    try {
      return [...session.tools.values()].map(({ descriptor }) => {
        const inputSchema = cloneJsonObject(descriptor.inputSchema);
        if (!inputSchema) throw new McpHostError('MCP_SCHEMA_INVALID');
        return { ...descriptor, inputSchema };
      });
    } catch {
      await this.close(config.id);
      throw new McpHostError('MCP_SCHEMA_INVALID');
    }
  }

  async execute(serverId: string, toolName: string, input: unknown): Promise<McpExecutionResult> {
    const session = this.sessions.get(serverId);
    if (!session || session.closed) throw new McpHostError('MCP_SERVER_CRASHED');
    const discovered = session.tools.get(toolName);
    if (!discovered) throw new McpHostError('MCP_TOOL_NOT_FOUND');
    const { descriptor, wireName } = discovered;
    if (!isPlainObject(input)) {
      throw new McpHostError('MCP_INPUT_INVALID');
    }

    try {
      const call = session.client.callTool({
        name: wireName,
        arguments: input,
      });
      const raw = await withTimeout(call, this.requestTimeoutMs, 'MCP_REQUEST_TIMEOUT');
      if (discovered.outputSchema && !isValidToolOutput(raw, discovered.outputSchema)) {
        return schemaFailure(descriptor.id);
      }
      return normalizeToolResult(raw, descriptor.id, session.sensitiveEnvironmentValues);
    } catch (error) {
      if (error instanceof McpHostError) {
        if (error.code === 'MCP_REQUEST_TIMEOUT') await this.close(serverId);
        throw error;
      }
      if (session.closed) throw new McpHostError('MCP_SERVER_CRASHED');
      if (discovered.outputSchema) return schemaFailure(descriptor.id);
      throw new McpHostError('MCP_REQUEST_FAILED');
    }
  }

  async close(serverId: string): Promise<void> {
    const pending = this.pending.get(serverId);
    if (pending) {
      try {
        await pending;
      } catch {
        // A failed pending connection has already closed its child process.
      }
    }
    const session = this.sessions.get(serverId);
    if (!session) return;
    this.sessions.delete(serverId);
    session.closed = true;
    try {
      await session.client.close();
    } catch {
      try {
        await session.transport.close();
      } catch {
        // Closing an already-exited child is a normal failure path.
      }
    }
  }

  async closeAll(): Promise<void> {
    const pending = [...this.pending.entries()];
    await Promise.all(
      pending.map(async ([serverId, operation]) => {
        try {
          await operation;
          await this.close(serverId);
        } catch {
          // Failed startup sessions are already torn down by connect().
        }
      }),
    );
    await Promise.all([...this.sessions.keys()].map((serverId) => this.close(serverId)));
  }

  private async getOrConnect(config: McpServerConfig): Promise<McpSession> {
    const fingerprint = configFingerprint(config);
    const current = this.sessions.get(config.id);
    if (current && !current.closed && current.configFingerprint === fingerprint) return current;
    if (current) await this.close(config.id);

    const pending = this.pending.get(config.id);
    if (pending) {
      const session = await pending;
      if (session.configFingerprint === fingerprint && !session.closed) return session;
      await this.close(config.id);
    }

    const operation = this.connect(config, fingerprint);
    this.pending.set(config.id, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(config.id) === operation) this.pending.delete(config.id);
    }
  }

  private async connect(config: McpServerConfig, fingerprint: string): Promise<McpSession> {
    const { env, sensitiveValues } = buildWhitelistedEnvironment(config.envWhitelist);
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env,
      cwd: config.cwd ?? undefined,
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024,
    });
    const client = new Client({ name: 'ai-agent-cultivation', version: '1.0.0' });
    const session: McpSession = {
      configFingerprint: fingerprint,
      client,
      transport,
      tools: new Map(),
      sensitiveEnvironmentValues: sensitiveValues,
      closed: false,
    };
    let connected = false;
    try {
      await withTimeout(client.connect(transport), this.connectTimeoutMs, 'MCP_CONNECT_TIMEOUT');
      connected = true;
      const sdkOnClose = transport.onclose;
      transport.onclose = () => {
        session.closed = true;
        sdkOnClose?.();
      };
      const sdkOnError = transport.onerror;
      transport.onerror = () => {
        session.closed = true;
        sdkOnError?.(new Error('MCP transport failure'));
      };
      const discovery = await withTimeout(
        client.listTools(),
        this.requestTimeoutMs,
        'MCP_REQUEST_TIMEOUT',
      );
      if (!Array.isArray(discovery.tools)) throw new McpHostError('MCP_SCHEMA_INVALID');
      const tools = normalizeToolDescriptors(config.id, discovery.tools, sensitiveValues);
      for (const tool of tools) session.tools.set(tool.descriptor.toolName, tool);
      if (session.closed) throw new McpHostError('MCP_SERVER_CRASHED');
      this.sessions.set(config.id, session);
      return session;
    } catch (error) {
      const crashed = session.closed;
      session.closed = true;
      try {
        await client.close();
      } catch {
        try {
          await transport.close();
        } catch {
          // Keep startup errors sanitized and do not retain dead child processes.
        }
      }
      if (error instanceof McpHostError) throw error;
      if (connected) {
        throw new McpHostError(crashed ? 'MCP_SERVER_CRASHED' : 'MCP_SCHEMA_INVALID');
      }
      throw new McpHostError('MCP_CONNECT_FAILED');
    }
  }
}

function validateConfig(config: McpServerConfig): void {
  if (
    !isPlainObject(config) ||
    typeof config.id !== 'string' ||
    config.id.length < 1 ||
    config.id.length > 200 ||
    typeof config.name !== 'string' ||
    config.name.length < 1 ||
    config.name.length > MAX_SERVER_NAME_LENGTH ||
    typeof config.command !== 'string' ||
    config.command.trim().length === 0 ||
    config.command.length > MAX_COMMAND_LENGTH ||
    config.command.includes('\0') ||
    !Array.isArray(config.args) ||
    config.args.length > MAX_ARGS ||
    !config.args.every(
      (arg) => typeof arg === 'string' && arg.length <= MAX_ARG_LENGTH && !arg.includes('\0'),
    ) ||
    !Array.isArray(config.envWhitelist) ||
    config.envWhitelist.length > 128 ||
    !config.envWhitelist.every((name) => typeof name === 'string') ||
    (config.cwd !== null &&
      (typeof config.cwd !== 'string' || config.cwd.length === 0 || config.cwd.includes('\0'))) ||
    typeof config.enabled !== 'boolean'
  ) {
    throw new McpHostError('MCP_CONFIG_INVALID');
  }
}

function buildWhitelistedEnvironment(names: string[]): {
  env: Record<string, string>;
  sensitiveValues: string[];
} {
  // The SDK merges its curated defaults into env. Override every default key so
  // no ambient process value reaches a server unless the user whitelisted it.
  const env: Record<string, string> = Object.fromEntries(
    DEFAULT_INHERITED_ENV_VARS.map((name) => [name, '']),
  );
  // Windows Node needs these OS paths to initialize its cryptographic runtime.
  // They are fixed bootstrap entries, never the caller's ambient environment.
  if (process.platform === 'win32') {
    env.SYSTEMROOT = process.env.SYSTEMROOT ?? '';
    env.WINDIR = process.env.WINDIR ?? '';
  }
  const inheritedNames = new Map(
    DEFAULT_INHERITED_ENV_VARS.map((name) => [name.toLowerCase(), name]),
  );
  const sensitiveValues = new Set<string>();

  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || BLOCKED_ENVIRONMENT_NAME.test(name)) continue;
    const canonicalName = inheritedNames.get(name.toLowerCase()) ?? name;
    const value = readEnvironmentValue(name);
    if (value === undefined || value.startsWith('()')) continue;
    env[canonicalName] = value;
    if (value.length > 0) sensitiveValues.add(value);
  }

  return { env, sensitiveValues: [...sensitiveValues] };
}

function readEnvironmentValue(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined || process.platform !== 'win32') return direct;
  const key = Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? process.env[key] : undefined;
}

interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

function normalizeToolDescriptors(
  serverId: string,
  tools: DiscoveredTool[],
  sensitiveValues: string[],
): Array<{
  descriptor: McpToolDescriptor;
  wireName: string;
  outputSchema?: Record<string, unknown>;
}> {
  if (tools.length > MAX_DISCOVERED_TOOLS) throw new McpHostError('MCP_SCHEMA_INVALID');
  const names = new Set<string>();
  return tools.map((tool) => {
    if (
      !isPlainObject(tool) ||
      typeof tool.name !== 'string' ||
      tool.name.length < 1 ||
      tool.name.length > MAX_TOOL_NAME_LENGTH ||
      (typeof tool.description !== 'undefined' && typeof tool.description !== 'string') ||
      !isValidSchema(tool.inputSchema) ||
      (tool.outputSchema !== undefined && !isValidSchema(tool.outputSchema))
    ) {
      throw new McpHostError('MCP_SCHEMA_INVALID');
    }
    const publicToolName = redact(tool.name, sensitiveValues);
    if (names.has(publicToolName)) throw new McpHostError('MCP_SCHEMA_INVALID');
    names.add(publicToolName);
    const inputSchema = cloneJsonObject(redactJsonValue(tool.inputSchema, sensitiveValues));
    if (!inputSchema) throw new McpHostError('MCP_SCHEMA_INVALID');
    const outputSchema =
      tool.outputSchema === undefined
        ? undefined
        : cloneJsonObject(redactJsonValue(tool.outputSchema, sensitiveValues));
    if (tool.outputSchema !== undefined && !outputSchema)
      throw new McpHostError('MCP_SCHEMA_INVALID');
    return {
      descriptor: {
        id: `${serverId}:${publicToolName}`,
        serverId,
        toolName: publicToolName,
        source: 'MCP',
        capability: 'MCP_TOOL_EXECUTE',
        name: redact(`mcp.${serverId}.${publicToolName}`, sensitiveValues),
        description: redact(tool.description ?? '', sensitiveValues).slice(
          0,
          MAX_DESCRIPTION_LENGTH,
        ),
        inputSchema,
        riskLevel: 'HIGH',
        sideEffect: 'PROCESS_EXECUTION',
      },
      wireName: tool.name,
      ...(outputSchema ? { outputSchema } : {}),
    };
  });
}

function isValidToolOutput(raw: unknown, schema: Record<string, unknown>): boolean {
  if (!isPlainObject(raw) || raw.isError === true) return true;
  return (
    isPlainObject(raw.structuredContent) && validateAgainstSchema(raw.structuredContent, schema)
  );
}

function schemaFailure(toolId: string): McpExecutionResult {
  return {
    toolId,
    success: false,
    content: [{ type: 'text', text: 'MCP_SCHEMA_INVALID' }],
    summary: 'MCP_SCHEMA_INVALID',
    errorCode: 'MCP_SCHEMA_INVALID',
  };
}

function isValidSchema(value: unknown, depth = 0): value is Record<string, unknown> {
  if (!isPlainObject(value) || value.type !== 'object' || depth > MAX_SCHEMA_DEPTH) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SCHEMA_BYTES) return false;
  } catch {
    return false;
  }
  return isJsonSchemaValue(value, depth);
}

function isJsonSchemaValue(value: unknown, depth: number): boolean {
  if (!isPlainObject(value) || depth > MAX_SCHEMA_DEPTH) return false;
  const allowedTypes = new Set([
    'string',
    'number',
    'integer',
    'boolean',
    'object',
    'array',
    'null',
  ]);
  const allowedKeywords = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minProperties',
    'maxProperties',
    'title',
    'description',
    'default',
    'examples',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
  ]);
  if (Object.keys(value).length > MAX_SCHEMA_ENTRIES) return false;
  if (
    value.type !== undefined &&
    !(typeof value.type === 'string' && allowedTypes.has(value.type)) &&
    !(
      Array.isArray(value.type) &&
      value.type.length > 0 &&
      value.type.length <= 7 &&
      value.type.every((type) => typeof type === 'string' && allowedTypes.has(type))
    )
  )
    return false;
  if (value.properties !== undefined && !isPlainObject(value.properties)) return false;
  if (isPlainObject(value.properties)) {
    const propertyEntries = Object.entries(value.properties);
    if (
      propertyEntries.length > MAX_SCHEMA_ENTRIES ||
      propertyEntries.some(
        ([key, schema]) => isUnsafeSchemaKey(key) || !isJsonSchemaValue(schema, depth + 1),
      )
    )
      return false;
  }
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      value.required.length > MAX_SCHEMA_ENTRIES ||
      !value.required.every((entry) => typeof entry === 'string' && !isUnsafeSchemaKey(entry)) ||
      new Set(value.required).size !== value.required.length)
  )
    return false;
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== 'boolean' &&
    !isJsonSchemaValue(value.additionalProperties, depth + 1)
  )
    return false;
  if (
    value.items !== undefined &&
    !(Array.isArray(value.items)
      ? value.items.length <= MAX_SCHEMA_ENTRIES &&
        value.items.every((item) => isJsonSchemaValue(item, depth + 1))
      : isJsonSchemaValue(value.items, depth + 1))
  )
    return false;
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      value.enum.length > MAX_SCHEMA_ENTRIES ||
      !value.enum.every(isJsonValue))
  )
    return false;
  if (value.const !== undefined && !isJsonValue(value.const)) return false;
  if (
    ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== 'number' || !Number.isFinite(value[key] as number)),
    )
  )
    return false;
  if (
    ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].some(
      (key) =>
        value[key] !== undefined && (!Number.isInteger(value[key]) || (value[key] as number) < 0),
    )
  )
    return false;
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const schemas = value[keyword];
    if (
      schemas !== undefined &&
      (!Array.isArray(schemas) ||
        schemas.length === 0 ||
        schemas.length > 32 ||
        !schemas.every((schema) => isJsonSchemaValue(schema, depth + 1)))
    )
      return false;
  }
  if (value.not !== undefined && !isJsonSchemaValue(value.not, depth + 1)) return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (value.default !== undefined && !isJsonValue(value.default)) return false;
  if (
    value.examples !== undefined &&
    (!Array.isArray(value.examples) ||
      value.examples.length > 32 ||
      !value.examples.every(isJsonValue))
  )
    return false;
  return Object.keys(value).every((key) => allowedKeywords.has(key) && !isUnsafeSchemaKey(key));
}

function isUnsafeSchemaKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): boolean {
  if (schema.type !== 'object') return false;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = schema.required as string[] | undefined;
  if (required?.some((key) => !Object.hasOwn(value, key))) return false;
  for (const [key, entry] of Object.entries(value)) {
    const fieldSchema = properties?.[key];
    if (fieldSchema === undefined) {
      if (schema.additionalProperties === false) return false;
      continue;
    }
    if (!validateJsonValue(entry, fieldSchema as Record<string, unknown>)) return false;
  }
  return true;
}

function validateJsonValue(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  const types = Array.isArray(type) ? type : [type];
  const typeMatches =
    type === undefined ||
    types.some(
      (entry) =>
        (entry === 'string' && typeof value === 'string') ||
        (entry === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
        (entry === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
        (entry === 'boolean' && typeof value === 'boolean') ||
        (entry === 'null' && value === null) ||
        (entry === 'object' && isPlainObject(value)) ||
        (entry === 'array' && Array.isArray(value)),
    );
  if (!typeMatches) return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    return false;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value))
    return false;
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (
      schema.items &&
      !value.every((item) => validateJsonValue(item, schema.items as Record<string, unknown>))
    )
      return false;
  }
  if (isPlainObject(value) && type === 'object') {
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((key) => typeof key === 'string' && !Object.hasOwn(value, key))
    )
      return false;
    for (const [key, entry] of Object.entries(value)) {
      const field = properties?.[key];
      if (field === undefined) {
        if (schema.additionalProperties === false) return false;
      } else if (!validateJsonValue(entry, field as Record<string, unknown>)) return false;
    }
  }
  return true;
}

function normalizeToolResult(
  raw: unknown,
  toolId: string,
  sensitiveValues: string[],
): McpExecutionResult {
  if (!isPlainObject(raw) || !Array.isArray(raw.content)) {
    throw new McpHostError('MCP_REQUEST_FAILED');
  }
  const content: Array<Record<string, unknown>> = [];
  let remaining = MAX_RESULT_TEXT_LENGTH;
  for (const block of raw.content.slice(0, MAX_RESULT_BLOCKS)) {
    if (remaining <= 0) break;
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') {
      const text = redact(block.text, sensitiveValues).slice(0, remaining);
      remaining -= text.length;
      content.push({ type: 'text', text });
    } else if (isPlainObject(block) && typeof block.type === 'string') {
      content.push({ type: block.type });
    }
  }

  const structured = isPlainObject(raw.structuredContent)
    ? boundedRedactedObject(raw.structuredContent, sensitiveValues)
    : undefined;
  const summary = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .slice(0, 1200);
  return {
    toolId,
    success: raw.isError !== true,
    content,
    ...(structured ? { structuredContent: structured } : {}),
    summary,
  };
}

function boundedRedactedObject(
  value: Record<string, unknown>,
  sensitiveValues: string[],
): Record<string, unknown> | undefined {
  try {
    const encoded = JSON.stringify(redactJsonValue(value, sensitiveValues));
    if (encoded.length > MAX_RESULT_STRUCTURED_LENGTH) return undefined;
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function redactJsonValue(value: unknown, sensitiveValues: string[], depth = 0): unknown {
  if (depth > 64) return '[depth-limited]';
  if (typeof value === 'string') return redact(value, sensitiveValues);
  if (Array.isArray(value))
    return value.map((entry) => redactJsonValue(entry, sensitiveValues, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redact(key, sensitiveValues),
        redactJsonValue(entry, sensitiveValues, depth + 1),
      ]),
    );
  }
  return value;
}

function redact(value: string, sensitiveValues: string[]): string {
  return sensitiveValues.reduce((result, secret) => result.split(secret).join('[redacted]'), value);
}

function cloneJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  return (
    isPlainObject(value) && Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configFingerprint(config: McpServerConfig): string {
  return JSON.stringify({
    name: config.name,
    command: config.command,
    args: config.args,
    envWhitelist: config.envWhitelist,
    cwd: config.cwd,
    enabled: config.enabled,
  });
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return 30_000;
  return Math.max(100, Math.min(Math.floor(value), 120_000));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: 'MCP_CONNECT_TIMEOUT' | 'MCP_REQUEST_TIMEOUT',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new McpHostError(code)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
