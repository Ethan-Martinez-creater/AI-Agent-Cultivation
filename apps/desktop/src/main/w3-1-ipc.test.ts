import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { DomainError } from '@cultivation/shared';
import type { WorkflowEditorPort } from './w3-1-ipc.js';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => mocks.handlers.delete(name),
    handle: (name: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));
import { registerWorkflowEditorIpc } from './w3-1-ipc.js';

describe('W3.1 typed editor intent boundary', () => {
  const sender = {} as IpcMainInvokeEvent;
  const methods = {
    listDrafts: vi.fn(() => []),
    getDraft: vi.fn(),
    createDraft: vi.fn(),
    saveDraft: vi.fn(),
    reorderDraft: vi.fn(),
    editVersion: vi.fn(),
    copyVersion: vi.fn(),
    publishDraft: vi.fn(),
  };
  const invoke = (name: string, ...args: unknown[]) =>
    mocks.handlers.get(`workflowEditor:${name}`)!(sender, ...args);
  beforeEach(() => {
    mocks.handlers.clear();
    for (const method of Object.values(methods)) method.mockReset();
    registerWorkflowEditorIpc(
      (event) => event === sender,
      methods as unknown as WorkflowEditorPort,
    );
  });
  it('checks sender before every editor action and exposes no arbitrary version publication', () => {
    for (const handler of mocks.handlers.values())
      expect(() => handler({}, {})).toThrow('IPC sender denied');
    expect(mocks.handlers.has('workflowEditor:publishVersion')).toBe(false);
    expect(mocks.handlers.has('workflowEditor:registerBuiltin')).toBe(false);
  });
  it('requires Main-owned identity and optimistic revision, rejecting state/source/version claims', () => {
    for (const extra of [
      { source: 'BUILTIN' },
      { version: 2 },
      { state: 'COMPLETED' },
      { manifestHash: 'a'.repeat(64) },
    ]) {
      expect(() => invoke('createDraft', { name: '我的工作流', ...extra })).toThrow();
      expect(() =>
        invoke('publishDraft', { id: 'draft', expectedRevision: 1, ...extra }),
      ).toThrow();
    }
    expect(() => invoke('publishDraft', { id: 'draft', expectedRevision: 0 })).toThrow();
    expect(methods.createDraft).not.toHaveBeenCalled();
    expect(methods.publishDraft).not.toHaveBeenCalled();
    invoke('publishDraft', { id: 'draft', expectedRevision: 1 });
    expect(methods.publishDraft).toHaveBeenCalledWith({ id: 'draft', expectedRevision: 1 });
  });
  it('does not accept official release/policy/runtime/permission authority in draft content', () => {
    for (const content of [
      { definition: { source: 'BUILTIN' } },
      { validationPolicy: 'research-integrity-v1' },
      { releaseMetadata: {} },
      { runtimeProfileId: 'other' },
      { permissions: [{ decision: 'ALLOW' }] },
    ])
      expect(() => invoke('saveDraft', { id: 'draft', expectedRevision: 1, content })).toThrow();
    expect(methods.saveDraft).not.toHaveBeenCalled();
  });
  it('validates copy/edit identities and bounded reorder intent', () => {
    invoke('copyVersion', { definitionId: 'official.research', version: 1, name: '我的科研流程' });
    expect(methods.copyVersion).toHaveBeenCalledWith({
      definitionId: 'official.research',
      version: 1,
      name: '我的科研流程',
    });
    expect(() =>
      invoke('editVersion', { definitionId: 'x', version: 1, source: 'USER' }),
    ).toThrow();
    expect(() =>
      invoke('reorderDraft', { id: 'draft', expectedRevision: 1, stepIds: Array(33).fill('s') }),
    ).toThrow();
    invoke('reorderDraft', { id: 'draft', expectedRevision: 1, stepIds: ['b', 'a'] });
    expect(methods.reorderDraft).toHaveBeenCalledWith({
      id: 'draft',
      expectedRevision: 1,
      stepIds: ['b', 'a'],
    });
  });
  it('returns bounded validator errors but hides persistence details', () => {
    methods.publishDraft.mockImplementationOnce(() => {
      throw new DomainError('INVALID_INPUT', '步骤存在未声明的条件分支');
    });
    expect(() => invoke('publishDraft', { id: 'draft', expectedRevision: 1 })).toThrow(
      '步骤存在未声明的条件分支',
    );
    methods.publishDraft.mockImplementationOnce(() => {
      throw new Error('sqlite path secret');
    });
    expect(() => invoke('publishDraft', { id: 'draft', expectedRevision: 1 })).toThrow(
      '工作流保存失败，已保留原版本',
    );
  });
});
