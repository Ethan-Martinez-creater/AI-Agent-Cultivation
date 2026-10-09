import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolRuntime } from '@cultivation/application/tool-runtime';
import { FileWorkspace } from './file-workspace.js';
import { WorkflowImportSources } from './w3-2-import-sources.js';

function setup() {
  const parent = path.join(process.cwd(), '.test-data', `w32-source-${randomUUID()}`);
  const root = path.join(parent, 'workspace');
  mkdirSync(root, { recursive: true });
  let selectedRoot: string | null = root;
  const userRead = vi.fn(async (call: { input: { path: string } }) => ({
    kind: 'RESULT',
    result: {
      ok: true,
      content: await (await FileWorkspace.open(root)).readText(call.input.path),
      code: 'OK',
    },
  }));
  const sources = new WorkflowImportSources(
    { dispatchUserRead: userRead } as unknown as ToolRuntime,
    () => selectedRoot,
  );
  return {
    parent,
    root,
    sources,
    userRead,
    changeRoot: (next: string | null) => {
      selectedRoot = next;
    },
  };
}

describe('W3.2 explicit user file snapshot boundary', () => {
  it('uses the existing user-read authority and verifies hash/size before retaining a bounded snapshot', async () => {
    const f = setup();
    const file = path.join(f.root, 'draft.txt');
    writeFileSync(file, '已有研究稿件', 'utf8');
    const source = await f.sources.readSelected(file, async () => true);
    expect(source?.content).toBe('已有研究稿件');
    expect(source?.kind).toBe('TEXT');
    expect(f.userRead).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'file.readText', input: { path: 'draft.txt' } }),
      'local-user',
      true,
    );
    expect(() => f.sources.recheck(source!)).not.toThrow();
    writeFileSync(file, '改变后的文件', 'utf8');
    expect(() => f.sources.recheck(source!)).toThrow();
  });
  it('cancelled native consent performs no user-read Tool call', async () => {
    const f = setup();
    const file = path.join(f.root, 'draft.txt');
    writeFileSync(file, '文件内容', 'utf8');
    expect(await f.sources.readSelected(file, async () => false)).toBeNull();
    expect(f.userRead).not.toHaveBeenCalled();
  });
  it('rejects outside Workspace, oversized, directory, invalid UTF-8 and malformed JSON', async () => {
    const f = setup();
    const outside = path.join(f.parent, 'outside.txt');
    writeFileSync(outside, '禁止读取', 'utf8');
    const big = path.join(f.root, 'big.txt');
    writeFileSync(big, 'x'.repeat(65537), 'utf8');
    const invalid = path.join(f.root, 'invalid.txt');
    writeFileSync(invalid, new Uint8Array([0xff, 0xfe]));
    const json = path.join(f.root, 'invalid.json');
    writeFileSync(json, '{"unfinished":', 'utf8');
    for (const target of [outside, big, f.root, invalid, json])
      await expect(f.sources.readSelected(target, async () => true)).rejects.toThrow();
  });
  it('rejects junction escape before consent or Tool dispatch', async () => {
    const f = setup();
    const outside = path.join(f.parent, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), '越界文件', 'utf8');
    symlinkSync(outside, path.join(f.root, 'linked'), 'junction');
    const consent = vi.fn(async () => true);
    await expect(
      f.sources.readSelected(path.join(f.root, 'linked', 'secret.txt'), consent),
    ).rejects.toThrow();
    expect(consent).not.toHaveBeenCalled();
    expect(f.userRead).not.toHaveBeenCalled();
  });
  it('refuses Workspace change during native consent and later confirmation', async () => {
    const f = setup();
    const file = path.join(f.root, 'draft.txt');
    writeFileSync(file, '快照', 'utf8');
    const source = await f.sources.readSelected(file, async () => true);
    f.changeRoot(null);
    expect(() => f.sources.recheck(source!)).toThrow();
    f.changeRoot(f.root);
    await expect(
      f.sources.readSelected(file, async () => {
        f.changeRoot(null);
        return true;
      }),
    ).rejects.toThrow();
  });
  it('a denied existing FILE_READ dispatch cannot be replaced by dialog consent', async () => {
    const f = setup();
    const file = path.join(f.root, 'draft.txt');
    writeFileSync(file, '无权读取', 'utf8');
    f.userRead.mockResolvedValueOnce({
      kind: 'RESULT',
      result: { ok: false, content: '', code: 'DENIED' },
    });
    await expect(f.sources.readSelected(file, async () => true)).rejects.toThrow();
  });
});
