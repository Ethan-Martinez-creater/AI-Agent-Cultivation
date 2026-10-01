import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { WorkflowDetail } from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type { WorkflowServicePort } from './w1-ipc.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => mocks.handlers.delete(name),
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler),
  },
}));
import { registerWorkflowIpc } from './w1-ipc.js';

describe('W1 typed Workflow IPC boundary', () => {
  const sender = {} as IpcMainInvokeEvent;
  const detail = {} as WorkflowDetail;
  const serviceMocks = {
    listVersions: vi.fn(() => []),
    listRuns: vi.fn(() => []),
    detail: vi.fn(() => detail),
    createRun: vi.fn(() => detail),
    advance: vi.fn(async () => detail),
    retryMission: vi.fn(async () => detail),
    retryStep: vi.fn(() => detail),
    pause: vi.fn(() => detail),
    resume: vi.fn(async () => detail),
    cancel: vi.fn(() => detail),
  };
  const service = serviceMocks as unknown as WorkflowServicePort;

  beforeEach(() => {
    mocks.handlers.clear();
    for (const method of Object.values(serviceMocks)) method.mockClear();
    registerWorkflowIpc((event) => event === sender, service);
  });

  it('checks the sender and accepts only bounded, strict run inputs', async () => {
    await expect(mocks.handlers.get('workflows:versions')!({})).rejects.toThrow(/sender denied/);
    await expect(mocks.handlers.get('workflows:detail')!(sender, 'x'.repeat(129))).rejects.toThrow(
      '请求参数无效',
    );
    await expect(
      mocks.handlers.get('workflows:create')!(sender, { definitionId: 'draft', version: 0 }),
    ).rejects.toThrow('请求参数无效');
    await expect(
      mocks.handlers.get('workflows:create')!(sender, {
        definitionId: 'draft',
        version: 1,
        name: 'untrusted payload',
      }),
    ).rejects.toThrow('请求参数无效');
    expect(serviceMocks.createRun).not.toHaveBeenCalled();

    await mocks.handlers.get('workflows:create')!(sender, {
      definitionId: 'definition-1',
      version: 1,
    });
    expect(serviceMocks.createRun).toHaveBeenCalledWith({
      definitionId: 'definition-1',
      version: 1,
    });
  });

  it('accepts only bounded JSON input snapshots and preserves the legacy no-input call', async () => {
    const inputs = {
      topic: 'workflow inputs',
      count: 3,
      enabled: false,
      tags: ['a', 'b'],
      nested: { range: { start: '2026-01-01', end: '2026-01-02' } },
    };
    await mocks.handlers.get('workflows:create')!(sender, {
      definitionId: 'definition-1',
      version: 2,
      inputs,
    });
    expect(serviceMocks.createRun).toHaveBeenCalledWith({
      definitionId: 'definition-1',
      version: 2,
      inputs,
    });
    await mocks.handlers.get('workflows:create')!(sender, {
      definitionId: 'definition-1',
      version: 1,
    });

    await mocks.handlers.get('workflows:create')!(sender, {
      definitionId: 'definition-1',
      version: 1,
      inputs: { tooDeep: { one: { two: { three: { four: { five: 'value' } } } } } },
    }).then(
      () => {
        throw new Error('Expected over-deep JSON to be rejected');
      },
      (error) => expect(error).toHaveProperty('message', '请求参数无效'),
    );
    await mocks.handlers.get('workflows:create')!(sender, {
      definitionId: 'definition-1',
      version: 1,
      inputs: { secret: 'x'.repeat(4001) },
    }).then(
      () => {
        throw new Error('Expected oversized field to be rejected');
      },
      (error) => expect(error).toHaveProperty('message', '请求参数无效'),
    );
    expect(serviceMocks.createRun).toHaveBeenLastCalledWith({
      definitionId: 'definition-1',
      version: 1,
    });
  });

  it('keeps operational errors generic and registers the exposed workflow operations', async () => {
    expect([...mocks.handlers.keys()].sort()).toEqual(
      [
        'workflows:advance',
        'workflows:cancel',
        'workflows:create',
        'workflows:detail',
        'workflows:list',
        'workflows:pause',
        'workflows:resume',
        'workflows:retryMission',
        'workflows:retryStep',
        'workflows:versions',
      ].sort(),
    );
    serviceMocks.advance.mockRejectedValueOnce(new Error('secret=/private/database/credential'));
    await expect(mocks.handlers.get('workflows:advance')!(sender, 'run-1')).rejects.toThrow(
      '工作流操作失败，请检查运行状态后重试',
    );
    serviceMocks.advance.mockRejectedValueOnce(
      new DomainError('WORKFLOW_INTEGRITY_ERROR', 'private database detail'),
    );
    await expect(mocks.handlers.get('workflows:advance')!(sender, 'run-1')).rejects.toMatchObject({
      code: 'WORKFLOW_INTEGRITY_ERROR',
      message: '工作流持久化完整性异常，已停止；不会重放步骤',
    });

    serviceMocks.createRun.mockImplementationOnce(() => {
      throw new DomainError('WORKFLOW_INPUT_INVALID', '缺少必填输入 workflow.topic');
    });
    await expect(
      mocks.handlers.get('workflows:create')!(sender, {
        definitionId: 'definition-1',
        version: 1,
        inputs: { prompt: 'private-user-value' },
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_INPUT_INVALID',
      message: '工作流输入字段 workflow.topic 无效，请检查该字段后重试',
    });
  });
});
