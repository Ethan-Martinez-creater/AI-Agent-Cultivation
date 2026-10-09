import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, BrowserWindow } from 'electron';
import type { WorkflowImportService } from '@cultivation/application';
import type { WorkflowImportSources } from './w3-2-import-sources.js';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  open: vi.fn(),
  consent: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => mocks.handlers.delete(name),
    handle: (name: string, handle: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handle),
  },
  dialog: { showOpenDialog: mocks.open, showMessageBox: mocks.consent },
}));
import { registerWorkflowImportIpc } from './w3-2-ipc.js';

describe('W3.2 typed import intent boundary', () => {
  const sender = {} as IpcMainInvokeEvent;
  const service = {
    prepare: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    addSource: vi.fn(),
    revise: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
  };
  const sources = { readSelected: vi.fn() };
  const invoke = (name: string, input: unknown) =>
    mocks.handlers.get(`workflowImports:${name}`)!(sender, input);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerWorkflowImportIpc(
      {} as BrowserWindow,
      (event) => event === sender,
      service as unknown as WorkflowImportService,
      sources as unknown as WorkflowImportSources,
    );
  });
  it('rejects untrusted senders for every action and exposes no raw state/Artifact/Permission mutation', async () => {
    for (const handler of mocks.handlers.values())
      await expect(handler({}, {})).rejects.toThrow('IPC sender denied');
    expect([...mocks.handlers.keys()]).toEqual(
      ['prepare', 'get', 'list', 'selectSource', 'revise', 'confirm', 'cancel'].map(
        (name) => `workflowImports:${name}`,
      ),
    );
    expect(service.confirm).not.toHaveBeenCalled();
  });
  it('rejects arbitrary files, source content, runtime, tool, state and permission authority fields', async () => {
    for (const extra of [
      { filePath: 'C:/secret' },
      { state: 'COMPLETED' },
      { toolAction: {} },
      { permissions: [] },
      { runtimeProfileId: 'runtime' },
      { source: 'BUILTIN' },
    ]) {
      await expect(
        invoke('prepare', { definitionId: 'user.sample', version: 1, ...extra }),
      ).rejects.toThrow();
      await expect(
        invoke('confirm', { proposalId: 'proposal', revision: 1, ...extra }),
      ).rejects.toThrow();
    }
    await expect(
      invoke('selectSource', { proposalId: 'p', path: 'E:/arbitrary' }),
    ).rejects.toThrow();
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });
  it('requires optimistic revision and only known bounded mapping fields', async () => {
    await expect(
      invoke('revise', {
        proposalId: 'p',
        revision: 0,
        completedStepIds: [],
        currentStepId: 'b',
        bindings: [],
      }),
    ).rejects.toThrow();
    await expect(
      invoke('revise', {
        proposalId: 'p',
        revision: 1,
        completedStepIds: ['a'],
        currentStepId: 'b',
        bindings: [{ stepId: 'a', outputKey: 'o', sourceId: 's', command: 'hidden' }],
      }),
    ).rejects.toThrow();
    expect(service.revise).not.toHaveBeenCalled();
  });
  it('returns Renderer-safe source summaries without contents or absolute storage paths', async () => {
    const proposal = {
      id: 'p',
      status: 'DRAFT',
      sources: [
        {
          id: 's',
          name: 'result.txt',
          kind: 'TEXT',
          size: 4,
          contentHash: 'a'.repeat(64),
          content: 'secret-source',
          workspaceRoot: 'E:/private',
          relativePath: 'private.txt',
        },
      ],
    };
    service.get.mockReturnValue(proposal);
    const result = await invoke('get', 'p');
    expect(JSON.stringify(result)).not.toContain('secret-source');
    expect(JSON.stringify(result)).not.toContain('E:/private');
    expect(JSON.stringify(result)).not.toContain('private.txt');
    expect(result).toMatchObject({
      sources: [{ id: 's', name: 'result.txt', kind: 'TEXT', size: 4 }],
    });
  });
  it('cancelling native file selection does not create a snapshot or Run', async () => {
    service.get.mockReturnValue({ status: 'DRAFT' });
    mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invoke('selectSource', 'p')).toBeNull();
    expect(sources.readSelected).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });
});
