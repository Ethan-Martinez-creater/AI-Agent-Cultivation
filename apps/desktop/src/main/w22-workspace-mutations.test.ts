import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, ToolRuntime } from '@cultivation/application/tool-runtime';
import { WorkflowToolGuard } from './w22-workspace-mutations.js';
import { WorkflowWorkspaceValidation } from './w2-workspace-validation.js';
import { FileWorkspace } from './file-workspace.js';
import { SOFTWARE_FEATURE_VERSION_1 } from '../../../../packages/application/src/builtin/software-feature/v1.js';
import type { WorkspaceMutationIntent } from '@cultivation/persistence';

async function fixture(decision = 'ALLOW', state = 'RUNNING') {
  const parent = join(process.cwd(), '.test-data', `w22-guard-${randomUUID()}`);
  const root = join(parent, 'workspace');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'feature.ts'), 'before', 'utf8');
  const workspace = await FileWorkspace.open(root);
  const tag = createHash('sha256')
    .update(workspace.getRoot().toLowerCase())
    .digest('hex')
    .slice(0, 16);
  const step = {
    id: 'step',
    workflowRunId: 'workflow',
    stepId: 'S05',
    missionId: 'mission',
    missionRunId: 'run',
    state,
    workspaceRoot: root,
    attempt: 1,
  };
  const rows: WorkspaceMutationIntent[] = [];
  const journal = {
    getOperation: () => ({
      id: 'operation',
      state: 'PREPARED',
      effectType: 'WORKSPACE_MUTATION',
      attempt: 1,
    }),
    prepareMutation: vi.fn((value: WorkspaceMutationIntent) => {
      rows.push(value);
      return { intent: value, created: true };
    }),
    transitionMutation: vi.fn((value: WorkspaceMutationIntent) => {
      rows[0] = value;
      return true;
    }),
    listMutations: () => rows,
    listRunMutations: () => rows,
  };
  const guard = new WorkflowToolGuard(
    {
      findStepByMissionId: () => step,
      bindMissionRun: () => step,
      detail: () => ({
        run: { id: 'workflow' },
        version: SOFTWARE_FEATURE_VERSION_1,
        steps: [step],
      }),
    } as never,
    journal as never,
    () => root,
    () => ({
      allowedToolIds: ['file.writeText'],
      allowedCommands: [],
      acceptanceIds: [],
      allowedPathPrefixes: ['src'],
      planFiles: ['src/feature.ts', 'src/escape/secret.txt'],
    }),
  );
  const registry = new ToolRegistry();
  registry.register({
    descriptor: {
      id: 'file.writeText',
      name: '写入文件',
      description: '',
      source: 'BUILTIN',
      capability: 'FILE_WRITE',
      riskLevel: 'HIGH',
      sideEffect: 'LOCAL_WRITE',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    resource: (input) => `file:${tag}:${String(input.path).toLowerCase()}`,
    execute: async (input) => {
      expect(rows.at(-1)?.state).toBe('PREPARED');
      await workspace.writeText(String(input.path), String(input.content));
      return { content: '{}' };
    },
  });
  const runtime = new ToolRuntime(registry, { evaluate: () => ({ decision }) } as never, guard);
  const call = {
    id: 'call',
    toolId: 'file.writeText',
    input: { path: 'src/feature.ts', content: 'after' },
  };
  const context = { missionId: 'mission', runId: 'run', teammateId: 'actor' };
  return { root, parent, runtime, call, context, rows, journal, tag };
}

describe('software ToolRuntime dynamic Workspace boundary', () => {
  it('persists PREPARED before actual writing and records exact before/after hashes', async () => {
    const f = await fixture();
    expect(await f.runtime.dispatch(f.call, f.context)).toMatchObject({
      kind: 'RESULT',
      result: { ok: true },
    });
    expect(f.rows[0]).toMatchObject({
      state: 'APPLIED',
      relativePath: 'src/feature.ts',
      beforeHash: createHash('sha256').update('before').digest('hex'),
      observedAfterHash: createHash('sha256').update('after').digest('hex'),
    });
    expect(await readFile(join(f.root, 'src/feature.ts'), 'utf8')).toBe('after');
  });
  it('DENY does not create mutation evidence or alter a file', async () => {
    const f = await fixture('DENY');
    expect(await f.runtime.dispatch(f.call, f.context)).toMatchObject({
      result: { code: 'PERMISSION_DENIED' },
    });
    expect(f.journal.prepareMutation).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, 'src/feature.ts'), 'utf8')).toBe('before');
  });
  it('ASK pauses without mutation and approved WAITING Step resumes the original Run', async () => {
    const f = await fixture('ASK', 'WAITING');
    expect(await f.runtime.dispatch(f.call, f.context)).toMatchObject({ kind: 'APPROVAL' });
    expect(f.rows).toEqual([]);
    expect(await f.runtime.dispatch(f.call, f.context, true)).toMatchObject({
      result: { ok: true },
    });
    expect(f.rows[0]!.missionRunId).toBe('run');
  });
  it.each(['../secret.txt', 'other/feature.ts', 'src/unplanned.ts'])(
    'rejects an unapproved/traversal path %s before execution',
    async (path) => {
      const f = await fixture();
      expect(
        await f.runtime.dispatch({ ...f.call, input: { path, content: 'malicious' } }, f.context),
      ).toMatchObject({ result: { ok: false } });
      expect(f.rows).toEqual([]);
      expect(await readFile(join(f.root, 'src/feature.ts'), 'utf8')).toBe('before');
    },
  );
  it('rejects a junction escape even when its relative path appears in the approved plan', async () => {
    const f = await fixture();
    const outside = join(f.parent, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'private', 'utf8');
    await symlink(outside, join(f.root, 'src', 'escape'), 'junction');
    expect(
      await f.runtime.dispatch(
        { ...f.call, input: { path: 'src/escape/secret.txt', content: 'malicious' } },
        f.context,
      ),
    ).toMatchObject({ result: { ok: false } });
    expect(f.rows).toEqual([]);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('private');
  });
  it('recovery checks the actual APPLIED file and never invokes the Tool again', async () => {
    const f = await fixture();
    await f.runtime.dispatch(f.call, f.context);
    const events = [
      {
        id: 'event',
        runId: 'run',
        eventType: 'tool.result',
        actorId: 'actor',
        payloadJson: {
          success: true,
          toolCallId: 'call',
          toolId: 'file.writeText',
          capability: 'FILE_WRITE',
          resource: `file:${f.tag}:src/feature.ts`,
        },
      },
    ];
    const validation = new WorkflowWorkspaceValidation(
      { listMissionEvents: () => events } as never,
      () => f.root,
      f.journal,
    );
    const receipt = { effectType: 'WORKSPACE_MUTATION', state: 'APPLIED', manifest: [] } as never;
    const snapshot = {
      mission: { id: 'mission' },
      run: { id: 'run', status: 'COMPLETED' },
      outputs: [],
    } as never;
    const definition = SOFTWARE_FEATURE_VERSION_1.steps.find((s) => s.id === 'S05')!;
    expect(
      await validation.verify(receipt, definition, snapshot, f.root, {
        workflowRunId: 'workflow',
        stepRunId: 'step',
      }),
    ).toMatchObject({ verified: true });
    await writeFile(join(f.root, 'src/feature.ts'), 'changed outside execution', 'utf8');
    expect(
      await validation.verify(receipt, definition, snapshot, f.root, {
        workflowRunId: 'workflow',
        stepRunId: 'step',
      }),
    ).toMatchObject({ verified: false });
    expect(f.journal.prepareMutation).toHaveBeenCalledTimes(1);
  });
});
