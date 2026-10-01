import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { RoutingMissionService } from '@cultivation/application';
import type { R4RoutingRepository } from '@cultivation/persistence';
import type { R3DecisionConfigController } from './r3-config.js';

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
import { registerRoutingIpc } from './r4-ipc.js';

describe('R4 typed routing IPC boundary', () => {
  const sender = {} as IpcMainInvokeEvent;
  const createMission = vi.fn(async () => ({
    status: 'USER_ACTION_REQUIRED',
    reason: 'TASK_CAPABILITY_UNAVAILABLE',
  }));
  const setCloudEnabled = vi.fn();
  let configured = false;
  beforeEach(() => {
    mocks.handlers.clear();
    createMission.mockClear();
    setCloudEnabled.mockClear();
    configured = false;
    registerRoutingIpc(
      (event) => event === sender,
      { createMission } as unknown as RoutingMissionService,
      {
        config: () => ({ cloudEnabled: false }),
        setCloudEnabled,
        listReceipts: () => [],
      } as unknown as R4RoutingRepository,
      { getConfigView: () => ({ configured }) } as unknown as R3DecisionConfigController,
    );
  });
  it('denies foreign senders before assignment and accepts only the bounded generic context', async () => {
    await expect(
      mocks.handlers.get('routing:createMission')!(
        {},
        { title: 'Task', context: { objective: 'Work' } },
      ),
    ).rejects.toThrow(/sender denied/);
    await expect(
      mocks.handlers.get('routing:createMission')!(sender, {
        title: 'Task',
        context: { objective: 'Work', rawMemory: 'private' },
      }),
    ).rejects.toThrow(/智能分配失败/);
    await expect(
      mocks.handlers.get('routing:createMission')!(sender, {
        title: 'Task',
        context: {
          objective: 'Work',
          expectedOutputContract: {
            name: '../secret',
            allowedExtensions: ['.txt'],
            maxSizeBytes: 10,
          },
        },
      }),
    ).rejects.toThrow(/智能分配失败/);
    expect(createMission).not.toHaveBeenCalled();
    await mocks.handlers.get('routing:createMission')!(sender, {
      title: 'Task',
      context: {
        objective: 'Work',
        executionContext: { origin: 'future-step', stepId: 'opaque' },
        inputArtifactMetadata: [{ id: 'a', name: 'public.txt', kind: 'TEXT' }],
      },
    });
    expect(createMission).toHaveBeenCalledOnce();
  });
  it('requires a configured Main-held key plus explicit independent ACTIVE consent', async () => {
    await expect(mocks.handlers.get('routing:setCloudEnabled')!(sender, true)).rejects.toThrow(
      /Jev API Key/,
    );
    expect(setCloudEnabled).not.toHaveBeenCalled();
    configured = true;
    await mocks.handlers.get('routing:setCloudEnabled')!(sender, true);
    expect(setCloudEnabled).toHaveBeenCalledWith(true);
    await expect(
      mocks.handlers.get('routing:setCloudEnabled')!(sender, { enabled: true, apiKey: 'secret' }),
    ).rejects.toThrow(/智能分配失败/);
  });
  it('does not expose SDK/SQLite/secret error messages', async () => {
    createMission.mockRejectedValueOnce(new Error('apiKey=secret internal database path'));
    await expect(
      mocks.handlers.get('routing:createMission')!(sender, {
        title: 'Task',
        context: { objective: 'Work' },
      }),
    ).rejects.toThrow('智能分配失败，请检查配置后重试');
  });
});
