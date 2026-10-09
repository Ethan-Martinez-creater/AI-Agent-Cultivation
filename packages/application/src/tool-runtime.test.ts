import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@cultivation/domain';
import { PermissionEngine, type PermissionRuleStore } from './permission-engine.js';
import { ToolRegistry, ToolRuntime, type ToolExecutionGuard } from './tool-runtime.js';

const context = { missionId: 'mission-a', runId: 'run-a', teammateId: 'teammate-a' };

function fixture(rules: PermissionRule[] = [], executionGuard?: ToolExecutionGuard) {
  let executions = 0;
  const store: PermissionRuleStore = {
    listPermissionRules: (subjectType, subjectId, capability) =>
      rules.filter(
        (rule) =>
          rule.subjectType === subjectType &&
          rule.subjectId === subjectId &&
          rule.capability === capability,
      ),
    savePermissionRule: (rule) => void rules.push(rule),
  };
  const registry = new ToolRegistry();
  registry.register({
    descriptor: {
      id: 'file.writeText',
      name: 'Write',
      description: 'Write a text file',
      source: 'BUILTIN',
      capability: 'FILE_WRITE',
      riskLevel: 'MEDIUM',
      sideEffect: 'LOCAL_WRITE',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    resource: (input) => `file:${input.path}`,
    execute: async () => {
      executions += 1;
      return { content: 'written' };
    },
  });
  return {
    runtime: new ToolRuntime(registry, new PermissionEngine(store), executionGuard),
    executions: () => executions,
    registry,
  };
}

function heldGuard() {
  let release!: () => void;
  let enter!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const outcomes: Array<{ ok: boolean; code: string; content: string }> = [];
  const guard: ToolExecutionGuard = {
    before: async () => {
      enter();
      await released;
      return 'held-token';
    },
    after: async (_token, _context, outcome) => {
      outcomes.push(outcome);
    },
  };
  return { guard, outcomes, entered, release: () => release() };
}

function permission(
  scope: PermissionRule['scope'],
  scopeId: string | null,
  decision: PermissionRule['decision'],
): PermissionRule {
  return {
    id: `${scope}-${decision}`,
    subjectType: 'TEAMMATE',
    subjectId: 'teammate-a',
    capability: 'FILE_WRITE',
    resourcePattern: 'file:a.txt',
    decision,
    scope,
    scopeId,
  } as PermissionRule;
}

describe('ToolRuntime boundary', () => {
  const call = {
    id: 'call-a',
    toolId: 'file.writeText',
    input: { path: 'a.txt', content: 'hello' },
  };

  it('validates input before permission and never executes invalid input', async () => {
    const { runtime, executions } = fixture([permission('GLOBAL', null, 'ALLOW')]);
    const result = await runtime.dispatch({ ...call, input: { path: 'a.txt' } }, context);
    expect(result.kind).toBe('RESULT');
    if (result.kind === 'RESULT') expect(result.result.code).toBe('INPUT_INVALID');
    expect(executions()).toBe(0);
  });

  it('defaults to approval, then executes only after explicit approval', async () => {
    const { runtime, executions } = fixture();
    expect((await runtime.dispatch(call, context)).kind).toBe('APPROVAL');
    expect(executions()).toBe(0);
    const approved = await runtime.dispatch(call, context, true);
    expect(approved.kind).toBe('RESULT');
    if (approved.kind === 'RESULT') expect(approved.result).toMatchObject({ ok: true, code: 'OK' });
    expect(executions()).toBe(1);
  });

  it('applies DENY even after an approval was granted', async () => {
    const { runtime, executions } = fixture([
      permission('GLOBAL', null, 'ASK'),
      permission('MISSION', 'mission-a', 'DENY'),
    ]);
    const result = await runtime.dispatch(call, context, true);
    expect(result.kind).toBe('RESULT');
    if (result.kind === 'RESULT') expect(result.result.code).toBe('PERMISSION_DENIED');
    expect(executions()).toBe(0);
  });

  it('uses Mission grants only for that Mission', async () => {
    const { runtime, executions } = fixture([
      permission('GLOBAL', null, 'ASK'),
      permission('MISSION', 'mission-a', 'ALLOW'),
    ]);
    expect((await runtime.dispatch(call, context)).kind).toBe('RESULT');
    expect((await runtime.dispatch(call, { ...context, missionId: 'mission-b' })).kind).toBe(
      'APPROVAL',
    );
    expect(executions()).toBe(1);
  });

  it('rechecks durable Permission after the execution guard and reports denial to the guard', async () => {
    const rules = [permission('GLOBAL', null, 'ALLOW')];
    const held = heldGuard();
    const { runtime, executions } = fixture(rules, held.guard);
    const pending = runtime.dispatch(call, context);

    await held.entered;
    rules.push(permission('GLOBAL', null, 'DENY'));
    held.release();

    const result = await pending;
    expect(result).toMatchObject({
      kind: 'RESULT',
      result: { ok: false, code: 'PERMISSION_DENIED' },
    });
    expect(executions()).toBe(0);
    expect(held.outcomes).toMatchObject([{ ok: false, code: 'PERMISSION_DENIED' }]);
  });

  it('requires approval when ALLOW is revoked to ASK while the execution guard is held', async () => {
    const rules = [permission('GLOBAL', null, 'ALLOW')];
    const held = heldGuard();
    const { runtime, executions } = fixture(rules, held.guard);
    const pending = runtime.dispatch(call, context);
    await held.entered;
    rules[0]!.decision = 'ASK';
    held.release();
    expect(await pending).toMatchObject({
      kind: 'RESULT',
      result: { ok: false, code: 'APPROVAL_REQUIRED' },
    });
    expect(executions()).toBe(0);
    expect(held.outcomes).toMatchObject([{ ok: false, code: 'APPROVAL_REQUIRED' }]);
  });

  it('rejects a registry replacement made while the execution guard is held', async () => {
    const held = heldGuard();
    const { runtime, executions, registry } = fixture(
      [permission('GLOBAL', null, 'ALLOW')],
      held.guard,
    );
    const original = registry.get(call.toolId)!;
    const pending = runtime.dispatch(call, context);

    await held.entered;
    registry.unregister(call.toolId);
    let replacementExecutions = 0;
    registry.register({
      descriptor: { ...original.descriptor },
      resource: original.resource,
      execute: async () => {
        replacementExecutions += 1;
        return { content: 'replacement executed' };
      },
    });
    held.release();

    const result = await pending;
    expect(result).toMatchObject({ kind: 'RESULT', result: { ok: false, code: 'TOOL_CHANGED' } });
    expect(executions()).toBe(0);
    expect(replacementExecutions).toBe(0);
    expect(held.outcomes).toMatchObject([{ ok: false, code: 'TOOL_CHANGED' }]);
  });

  it('rejects a descriptor mutation made while the execution guard is held', async () => {
    const held = heldGuard();
    const { runtime, executions, registry } = fixture(
      [permission('GLOBAL', null, 'ALLOW')],
      held.guard,
    );
    const descriptor = registry.get(call.toolId)!.descriptor;
    const pending = runtime.dispatch(call, context);

    await held.entered;
    descriptor.description = 'changed after guard preparation';
    held.release();

    const result = await pending;
    expect(result).toMatchObject({
      kind: 'RESULT',
      result: { ok: false, code: 'TOOL_DESCRIPTOR_CHANGED' },
    });
    expect(executions()).toBe(0);
    expect(held.outcomes).toMatchObject([{ ok: false, code: 'TOOL_DESCRIPTOR_CHANGED' }]);
  });

  it('rejects input mutation made while the execution guard is held', async () => {
    const held = heldGuard();
    const { runtime, executions } = fixture([permission('GLOBAL', null, 'ALLOW')], held.guard);
    const changedCall = { ...call, input: { ...call.input } };
    const pending = runtime.dispatch(changedCall, context);

    await held.entered;
    changedCall.input.content = 'changed after guard preparation';
    held.release();

    const result = await pending;
    expect(result).toMatchObject({ kind: 'RESULT', result: { ok: false, code: 'INPUT_CHANGED' } });
    expect(executions()).toBe(0);
    expect(held.outcomes).toMatchObject([{ ok: false, code: 'INPUT_CHANGED' }]);
  });

  it('rejects a resource mapping change made while the execution guard is held', async () => {
    const rules = [permission('GLOBAL', null, 'ALLOW')];
    const held = heldGuard();
    let resourcePrefix = 'file:';
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      descriptor: {
        id: 'file.writeText',
        name: 'Write',
        description: 'Write a text file',
        source: 'BUILTIN',
        capability: 'FILE_WRITE',
        riskLevel: 'MEDIUM',
        sideEffect: 'LOCAL_WRITE',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      resource: (input) => resourcePrefix + input.path,
      execute: async () => {
        executions += 1;
        return { content: 'written' };
      },
    });
    const store: PermissionRuleStore = {
      listPermissionRules: (subjectType, subjectId, capability) =>
        rules.filter(
          (rule) =>
            rule.subjectType === subjectType &&
            rule.subjectId === subjectId &&
            rule.capability === capability,
        ),
      savePermissionRule: (rule) => void rules.push(rule),
    };
    const runtime = new ToolRuntime(registry, new PermissionEngine(store), held.guard);
    const pending = runtime.dispatch(call, context);

    await held.entered;
    resourcePrefix = 'other:';
    held.release();

    const result = await pending;
    expect(result).toMatchObject({
      kind: 'RESULT',
      result: { ok: false, code: 'RESOURCE_CHANGED' },
    });
    expect(executions).toBe(0);
    expect(held.outcomes).toMatchObject([{ ok: false, code: 'RESOURCE_CHANGED' }]);
  });

  it('normalizes execution failures without exposing thrown text', async () => {
    const { runtime } = fixture([permission('GLOBAL', null, 'ALLOW')]);
    runtime.registry.unregister('file.writeText');
    runtime.registry.register({
      descriptor: {
        id: 'file.writeText',
        name: 'Write',
        description: '',
        source: 'BUILTIN',
        capability: 'FILE_WRITE',
        riskLevel: 'MEDIUM',
        sideEffect: 'LOCAL_WRITE',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      resource: () => 'file:a.txt',
      execute: async () => {
        throw new Error('secret-password');
      },
    });
    const result = await runtime.dispatch(call, context);
    expect(result.kind).toBe('RESULT');
    if (result.kind === 'RESULT') {
      expect(result.result.code).toBe('TOOL_FAILED');
      expect(JSON.stringify(result)).not.toContain('secret-password');
    }
  });
});
