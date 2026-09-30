import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  dialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
  copy: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => mocks.handlers.delete(name),
    handle: (name: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, fn),
  },
  dialog: { showOpenDialog: mocks.dialog },
  clipboard: { writeText: mocks.copy },
  nativeImage: { createFromBuffer: vi.fn() },
}));
import { registerDesktopIpc } from './desktop-ipc.js';

describe('desktop typed IPC security', () => {
  const sender = {} as IpcMainInvokeEvent;
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.dialog.mockClear();
    mocks.copy.mockClear();
    const window = { on: vi.fn(), isMaximized: () => false } as unknown as BrowserWindow;
    registerDesktopIpc(
      window,
      (event) => event === sender,
      join(process.cwd(), '.test-data', `desktop-ipc-${randomUUID()}`),
    );
  });
  it('denies untrusted senders before opening a native file dialog', async () => {
    await expect(mocks.handlers.get('avatars:import')!({})).rejects.toThrow('IPC sender denied');
    expect(mocks.dialog).not.toHaveBeenCalled();
  });
  it('never accepts a renderer-supplied import path, and cancellation returns no asset', async () => {
    await expect(
      mocks.handlers.get('avatars:import')!(sender, 'C:/private/file.png'),
    ).rejects.toThrow('桌面操作失败');
    expect(mocks.dialog).not.toHaveBeenCalled();
    await expect(mocks.handlers.get('avatars:import')!(sender)).resolves.toBeNull();
    expect(mocks.dialog).toHaveBeenCalledOnce();
  });
  it('rejects path-like asset references without exposing filesystem details', async () => {
    await expect(mocks.handlers.get('avatars:read')!(sender, '../private.png')).rejects.toThrow(
      '桌面操作失败，请检查输入后重试',
    );
  });
  it('bounds Main clipboard writes used by the code-copy control', async () => {
    await mocks.handlers.get('desktop:copyText')!(sender, 'console.log("safe text")');
    expect(mocks.copy).toHaveBeenCalledWith('console.log("safe text")');
    await expect(
      mocks.handlers.get('desktop:copyText')!(sender, 'x'.repeat(65537)),
    ).rejects.toThrow('桌面操作失败');
    expect(mocks.copy).toHaveBeenCalledOnce();
  });
});
