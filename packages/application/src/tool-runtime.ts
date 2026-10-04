import Ajv, { type ValidateFunction } from 'ajv';
import type { PermissionCapability, ToolDescriptor, ToolSource } from '@cultivation/domain';
import { PermissionEngine } from './permission-engine.js';

export interface ToolCall {
  id: string;
  toolId: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  toolId: string;
  ok: boolean;
  code: string;
  content: string;
}

export interface ToolRegistration {
  descriptor: ToolDescriptor & { capability: PermissionCapability };
  resource(input: Record<string, unknown>): string;
  execute(
    input: Record<string, unknown>,
  ): Promise<{ content: string; ok?: boolean; code?: string }>;
}

interface RegisteredTool extends ToolRegistration {
  validate: ValidateFunction;
}

export interface ToolContext {
  missionId: string;
  runId: string;
  teammateId: string;
}

export interface ToolTrace {
  toolId: string;
  source: ToolSource | 'UNKNOWN';
  capability: PermissionCapability | null;
  riskLevel: ToolDescriptor['riskLevel'] | null;
  sideEffect: ToolDescriptor['sideEffect'] | null;
  resource: string | null;
  inputSummary: { keys: string[]; bytes: number };
  outputSummary: { ok: boolean; code: string; bytes: number } | null;
}

export type ToolDispatch =
  | { kind: 'APPROVAL'; trace: ToolTrace; call: ToolCall }
  | { kind: 'RESULT'; trace: ToolTrace; result: ToolResult };

/** Optional Main-owned journal/policy hook. It runs only after Tool schema and Permission checks. */
export interface ToolExecutionGuard {
  before(
    call: ToolCall,
    context: ToolContext,
    descriptor: ToolDescriptor & { capability: PermissionCapability },
    input: Record<string, unknown>,
    resource: string,
  ): Promise<unknown>;
  after(
    token: unknown,
    context: ToolContext,
    outcome: Pick<ToolResult, 'ok' | 'code' | 'content'>,
  ): Promise<void>;
}

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;

function boundedResult(call: ToolCall, ok: boolean, code: string, content: string): ToolResult {
  return {
    toolCallId: call.id.slice(0, 128),
    toolId: call.toolId.slice(0, 128),
    ok,
    code,
    content: content.slice(0, MAX_OUTPUT_CHARS),
  };
}

function summary(input: unknown): ToolTrace['inputSummary'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { keys: [], bytes: 0 };
  try {
    return {
      keys: Object.keys(input).slice(0, 16),
      bytes: Buffer.byteLength(JSON.stringify(input)),
    };
  } catch {
    return { keys: [], bytes: 0 };
  }
}

/** Registry compiles schemas once; a malformed discovered MCP schema is rejected closed. */
export class ToolRegistry {
  private readonly ajv = new Ajv({ allErrors: false, coerceTypes: false, removeAdditional: false });
  private readonly tools = new Map<string, RegisteredTool>();

  register(registration: ToolRegistration): void {
    const { descriptor } = registration;
    if (!descriptor.id || descriptor.id.length > 128 || this.tools.has(descriptor.id)) {
      throw new Error('Invalid or duplicate tool descriptor');
    }
    const schemaText = JSON.stringify(descriptor.inputSchema);
    if (!schemaText || Buffer.byteLength(schemaText) > MAX_SCHEMA_BYTES) {
      throw new Error('Tool input schema is too large');
    }
    const validate = this.ajv.compile(descriptor.inputSchema);
    this.tools.set(descriptor.id, { ...registration, validate });
  }

  unregister(id: string): void {
    this.tools.delete(id);
  }

  get(id: string): RegisteredTool | null {
    return this.tools.get(id) ?? null;
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ descriptor }) => descriptor);
  }
}

/** All built-in and MCP calls enter this permission and validation boundary. */
export class ToolRuntime {
  constructor(
    readonly registry: ToolRegistry,
    private readonly permissions: PermissionEngine,
    private readonly executionGuard?: ToolExecutionGuard,
  ) {}

  async dispatch(
    call: ToolCall,
    context: ToolContext,
    approvalGranted = false,
  ): Promise<ToolDispatch> {
    return this.dispatchChecked(call, context, approvalGranted);
  }

  /** Main-only explicit user import. Never grants a Teammate or Mission permission. */
  async dispatchUserRead(
    call: ToolCall,
    userId: string,
    approvedByNativeDialog: boolean,
  ): Promise<ToolDispatch> {
    const tool = this.registry.get(call.toolId);
    if (
      call.toolId !== 'file.readText' ||
      !userId ||
      tool?.descriptor.source !== 'BUILTIN' ||
      tool.descriptor.capability !== 'FILE_READ' ||
      tool.descriptor.sideEffect !== 'NONE'
    )
      throw new Error('User import is restricted to the builtin text reader');
    return this.dispatchChecked(call, null, approvedByNativeDialog, userId);
  }

  private async dispatchChecked(
    call: ToolCall,
    context: ToolContext | null,
    approvalGranted: boolean,
    userId?: string,
  ): Promise<ToolDispatch> {
    const registered = this.registry.get(call.toolId);
    const trace: ToolTrace = {
      toolId: call.toolId.slice(0, 128),
      source: registered?.descriptor.source ?? 'UNKNOWN',
      capability: registered?.descriptor.capability ?? null,
      riskLevel: registered?.descriptor.riskLevel ?? null,
      sideEffect: registered?.descriptor.sideEffect ?? null,
      resource: null,
      inputSummary: summary(call.input),
      outputSummary: null,
    };
    const finished = (ok: boolean, code: string, content: string): ToolDispatch => {
      const result = boundedResult(call, ok, code, content);
      trace.outputSummary = { ok, code, bytes: Buffer.byteLength(result.content) };
      return { kind: 'RESULT', trace, result };
    };
    if (!registered) return finished(false, 'TOOL_NOT_FOUND', 'Tool is unavailable.');
    if (
      !call.input ||
      typeof call.input !== 'object' ||
      Array.isArray(call.input) ||
      trace.inputSummary.bytes > MAX_INPUT_BYTES ||
      !registered.validate(call.input)
    ) {
      return finished(false, 'INPUT_INVALID', 'Tool input did not match its schema.');
    }
    const input = call.input as Record<string, unknown>;
    let resource: string;
    try {
      resource = registered.resource(input);
      if (!resource || resource.length > 512) throw new Error('Invalid resource');
    } catch {
      return finished(false, 'RESOURCE_INVALID', 'Tool resource is invalid.');
    }
    trace.resource = resource;
    const decision = this.permissions.evaluate({
      subjectType: context ? 'TEAMMATE' : 'USER',
      subjectId: context?.teammateId ?? userId!,
      capability: registered.descriptor.capability,
      resource,
      teammateId: context?.teammateId ?? null,
      missionId: context?.missionId ?? null,
    }).decision;
    if (decision === 'DENY') return finished(false, 'PERMISSION_DENIED', 'Permission denied.');
    if (decision === 'ASK' && !approvalGranted) return { kind: 'APPROVAL', trace, call };
    let guardToken: unknown;
    let guardPrepared = false;
    try {
      if (this.executionGuard && context) {
        guardToken = await this.executionGuard.before(
          call,
          context,
          registered.descriptor,
          input,
          resource,
        );
        guardPrepared = true;
      }
      const output = await registered.execute(input);
      if (typeof output.content !== 'string') throw new Error('Malformed tool result');
      const ok = output.ok ?? true;
      const dispatch = finished(ok, output.code ?? (ok ? 'OK' : 'TOOL_FAILED'), output.content);
      if (guardPrepared && dispatch.kind === 'RESULT') {
        try {
          await this.executionGuard!.after(guardToken, context!, dispatch.result);
        } catch {
          // The effect may have happened. Keep the guard's PREPARED evidence for recovery and
          // prevent the caller from interpreting the operation as verified.
          return finished(
            false,
            'TOOL_EXECUTION_EVIDENCE_FAILED',
            'Tool execution could not be verified.',
          );
        }
      }
      return dispatch;
    } catch {
      const failed = finished(false, 'TOOL_FAILED', 'Tool failed safely.');
      if (guardPrepared && failed.kind === 'RESULT') {
        try {
          await this.executionGuard!.after(guardToken, context!, failed.result);
        } catch {
          // Leave the durable PREPARED intent for restart inspection.
        }
      }
      return failed;
    }
  }
}
