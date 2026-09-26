import { mkdir, mkdtemp, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileWorkspace, FileWorkspaceError } from './file-workspace.js';

const testDataRoot = path.join(process.cwd(), '.test-data');
let testRoot = '';
let workspaceRoot = '';
let outsideRoot = '';
let directories: string[] = [];
let files: string[] = [];
let links: string[] = [];

async function createDirectory(target: string): Promise<void> {
  await mkdir(target);
  directories.push(target);
}

async function createFile(target: string, contents: string | Uint8Array): Promise<void> {
  await writeFile(target, contents);
  files.push(target);
}

beforeEach(async () => {
  await mkdir(testDataRoot, { recursive: true });
  testRoot = await mkdtemp(path.join(testDataRoot, 'file-workspace-'));
  directories = [testRoot];
  files = [];
  links = [];
  workspaceRoot = path.join(testRoot, 'workspace');
  outsideRoot = path.join(testRoot, 'outside');
  await createDirectory(workspaceRoot);
  await createDirectory(outsideRoot);
});

afterEach(async () => {
  for (const link of links.reverse()) {
    try {
      await unlink(link);
    } catch {
      try {
        await rmdir(link);
      } catch {
        // A failed test may already have removed the link.
      }
    }
  }
  for (const file of files.reverse()) {
    try {
      await unlink(file);
    } catch {
      // A failed test may already have removed the file.
    }
  }
  for (const directory of directories.reverse()) {
    try {
      await rmdir(directory);
    } catch {
      // Only individually tracked empty directories are removed here.
    }
  }
});

describe('FileWorkspace', () => {
  it('lists, reads, writes, and creates nested directories within its root', async () => {
    const workspace = await FileWorkspace.open(workspaceRoot);
    expect(workspace.getRoot()).toBe(await realRoot(workspaceRoot));

    await workspace.writeText('hello.txt', 'hello workspace');
    files.push(path.join(workspaceRoot, 'hello.txt'));
    await workspace.createDirectory('notes/drafts');
    await workspace.createDirectory('notes/drafts');
    directories.push(
      path.join(workspaceRoot, 'notes'),
      path.join(workspaceRoot, 'notes', 'drafts'),
    );
    await workspace.writeText('notes/drafts/todo.txt', 'first draft');
    files.push(path.join(workspaceRoot, 'notes', 'drafts', 'todo.txt'));

    await expect(workspace.readText('hello.txt')).resolves.toBe('hello workspace');
    await workspace.writeText('notes/drafts/todo.txt', 'updated draft');
    await expect(workspace.readText('notes/drafts/todo.txt')).resolves.toBe('updated draft');
    await expect(workspace.list('.')).resolves.toEqual([
      { name: 'hello.txt', type: 'FILE', size: Buffer.byteLength('hello workspace') },
      { name: 'notes', type: 'DIRECTORY', size: null },
    ]);
    await expect(workspace.list('notes/drafts')).resolves.toEqual([
      { name: 'todo.txt', type: 'FILE', size: Buffer.byteLength('updated draft') },
    ]);
  });

  it('rejects traversal, absolute, drive, UNC, and device paths', async () => {
    const workspace = await FileWorkspace.open(workspaceRoot);
    const invalidPaths = [
      '../outside/secret.txt',
      'nested/../../outside.txt',
      path.resolve(outsideRoot, 'secret.txt'),
      'C:\\Windows\\win.ini',
      '\\\\server\\share\\secret.txt',
      '\\\\?\\C:\\Windows\\win.ini',
      '/etc/passwd',
      'C:relative-drive-path.txt',
    ];

    for (const invalidPath of invalidPaths) {
      await expect(workspace.readText(invalidPath)).rejects.toBeInstanceOf(FileWorkspaceError);
    }
    await expect(workspace.readText('../outside/secret.txt')).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_PATH_ESCAPE',
    });
  });

  it('rejects symlink or junction paths that point outside the workspace', async (context) => {
    const workspace = await FileWorkspace.open(workspaceRoot);
    const secretPath = path.join(outsideRoot, 'secret.txt');
    const linkPath = path.join(workspaceRoot, 'escape');
    await createFile(secretPath, 'outside secret');

    try {
      await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      links.push(linkPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
        context.skip('Filesystem does not permit creating a symlink or junction');
      }
      throw error;
    }

    await expect(workspace.readText('escape/secret.txt')).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_SYMLINK',
    });
    await expect(workspace.list('')).rejects.toMatchObject({ code: 'FILE_WORKSPACE_SYMLINK' });
    await expect(readFile(secretPath, 'utf8')).resolves.toBe('outside secret');
  });

  it('rejects reads and writes above the 64 KiB text limit', async () => {
    const workspace = await FileWorkspace.open(workspaceRoot);
    const oversizedPath = path.join(workspaceRoot, 'oversized.txt');
    await createFile(oversizedPath, Buffer.alloc(64 * 1024 + 1, 0x61));

    await expect(workspace.readText('oversized.txt')).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_TOO_LARGE',
    });
    await expect(workspace.writeText('new.txt', 'a'.repeat(64 * 1024 + 1))).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_TOO_LARGE',
    });
  });

  it('rejects non-UTF-8 bytes as text', async () => {
    const workspace = await FileWorkspace.open(workspaceRoot);
    const binaryPath = path.join(workspaceRoot, 'binary.txt');
    await createFile(binaryPath, Buffer.from([0xff, 0xfe, 0x00]));
    await expect(workspace.readText('binary.txt')).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_INVALID_UTF8',
    });
  });
});

async function realRoot(root: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(root);
}
