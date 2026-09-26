import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@cultivation/domain';
import { PermissionEngine, type PermissionRuleStore } from './permission-engine.js';
import { ToolRegistry, ToolRuntime } from './tool-runtime.js';

const context = { missionId: 'mission-a', runId: 'run-a', teammateId: 'teammate-a' };

function fixture(rules: PermissionRule[] = []) {
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
    runtime: new ToolRuntime(registry, new PermissionEngine(store)),
    executions: () => executions,
  };
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
