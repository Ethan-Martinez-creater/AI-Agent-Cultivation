import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const MAX_TEXT_BYTES = 64 * 1024;

export type FileWorkspaceEntry = {
  name: string;
  type: 'FILE' | 'DIRECTORY';
  size: number | null;
};

export type FileWorkspaceErrorCode =
  | 'FILE_WORKSPACE_INVALID_ROOT'
  | 'FILE_WORKSPACE_INVALID_PATH'
  | 'FILE_WORKSPACE_PATH_NOT_FOUND'
  | 'FILE_WORKSPACE_PATH_ESCAPE'
  | 'FILE_WORKSPACE_SYMLINK'
  | 'FILE_WORKSPACE_NOT_DIRECTORY'
  | 'FILE_WORKSPACE_NOT_FILE'
  | 'FILE_WORKSPACE_TOO_LARGE'
  | 'FILE_WORKSPACE_INVALID_UTF8'
  | 'FILE_WORKSPACE_IO';

export class FileWorkspaceError extends Error {
  constructor(
    readonly code: FileWorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileWorkspaceError';
  }
}

/**
 * Restricts file operations to one user-selected directory. The root and every
 * existing component are canonicalized and checked before an operation runs.
 */
export class FileWorkspace {
  private constructor(private readonly rootPath: string) {}

  static async open(rootPath: string): Promise<FileWorkspace> {
    if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
      throw new FileWorkspaceError(
        'FILE_WORKSPACE_INVALID_ROOT',
        'Workspace root must be an existing directory',
      );
    }
    try {
      const canonical = await realpath(path.resolve(rootPath));
      const rootStat = await stat(canonical);
      if (!rootStat.isDirectory()) {
        throw new FileWorkspaceError(
          'FILE_WORKSPACE_INVALID_ROOT',
          'Workspace root must be an existing directory',
        );
      }
      return new FileWorkspace(canonical);
    } catch (error) {
      if (error instanceof FileWorkspaceError) throw error;
      throw new FileWorkspaceError('FILE_WORKSPACE_INVALID_ROOT', 'Workspace root is unavailable');
    }
  }

  getRoot(): string {
    return this.rootPath;
  }

  async list(relativePath: string): Promise<FileWorkspaceEntry[]> {
    const target = this.resolveRelative(relativePath, true);
    await this.verifyPath(target, true);
    const entries = await this.withIo(() => readdir(target, { withFileTypes: true }));
    const result: FileWorkspaceEntry[] = [];

    for (const entry of entries) {
      const entryPath = path.join(target, entry.name);
      await this.verifyPath(entryPath, false, false, true);
      const details = await this.withIo(() => lstat(entryPath));
      if (details.isDirectory()) {
        result.push({ name: entry.name, type: 'DIRECTORY', size: null });
      } else if (details.isFile()) {
        result.push({ name: entry.name, type: 'FILE', size: details.size });
      } else {
        throw new FileWorkspaceError(
          'FILE_WORKSPACE_INVALID_PATH',
          'Workspace contains an unsupported file type',
        );
      }
    }

    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async readText(relativePath: string): Promise<string> {
    const target = this.resolveRelative(relativePath);
    await this.verifyPath(target, false);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await this.withIo(() => open(target, flags));

    try {
      await this.verifyPath(target, false);
      const info = await this.withIo(() => handle.stat());
      if (!info.isFile()) {
        throw new FileWorkspaceError('FILE_WORKSPACE_NOT_FILE', 'Path is not a file');
      }
      const pathInfo = await this.withIo(() => lstat(target));
      if (pathInfo.isSymbolicLink() || !this.sameFile(info, pathInfo)) {
        throw new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Symbolic links are not allowed');
      }
      if (info.size > MAX_TEXT_BYTES) {
        throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Text file exceeds 64 KiB');
      }

      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
      const { bytesRead } = await this.withIo(() => handle.read(buffer, 0, buffer.length, 0));
      if (
        bytesRead > MAX_TEXT_BYTES ||
        (await this.withIo(() => handle.stat())).size > MAX_TEXT_BYTES
      ) {
        throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Text file exceeds 64 KiB');
      }

      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        throw new FileWorkspaceError('FILE_WORKSPACE_INVALID_UTF8', 'File is not valid UTF-8 text');
      }
    } finally {
      await this.withIo(() => handle.close());
    }
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    if (content.length > MAX_TEXT_BYTES) {
      throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Text content exceeds 64 KiB');
    }
    const data = Buffer.from(content, 'utf8');
    if (data.byteLength > MAX_TEXT_BYTES) {
      throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Text content exceeds 64 KiB');
    }

    const target = this.resolveRelative(relativePath);
    const parentPath = path.dirname(target);
    await this.verifyPath(parentPath, true);
    await this.verifyPath(target, false, true);

    // Write to a fresh sibling and atomically replace the target. A racing final
    // symlink is replaced as a link rather than followed to an outside file.
    const temporaryPath = path.join(
      parentPath,
      `.cultivation-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await this.withIo(() => writeFile(temporaryPath, data, { flag: 'wx' }));
      await this.verifyPath(parentPath, true);
      await this.verifyPath(target, false, true);
      await this.withIo(() => rename(temporaryPath, target));
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already be gone.
      }
      throw error;
    }
  }

  async createDirectory(relativePath: string): Promise<void> {
    const target = this.resolveRelative(relativePath);
    const relative = path.relative(this.rootPath, target);
    const components = relative.split(path.sep).filter(Boolean);
    let current = this.rootPath;

    for (const component of components) {
      current = path.join(current, component);
      try {
        await mkdir(current);
      } catch (error) {
        if (!this.isCode(error, 'EEXIST')) throw this.ioError(error);
      }
      await this.verifyPath(current, true);
    }
  }

  private resolveRelative(relativePath: string, allowRoot = false): string {
    if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
      throw new FileWorkspaceError('FILE_WORKSPACE_INVALID_PATH', 'Invalid workspace path');
    }
    if (
      path.isAbsolute(relativePath) ||
      /^[a-zA-Z]:/.test(relativePath) ||
      /^[\\/]{2}/.test(relativePath) ||
      relativePath.startsWith('\\\\?\\') ||
      relativePath.startsWith('\\\\.\\')
    ) {
      throw new FileWorkspaceError(
        'FILE_WORKSPACE_INVALID_PATH',
        'Only relative paths are allowed',
      );
    }

    const rawComponents = relativePath.split(/[\\/]+/).filter(Boolean);
    if (rawComponents.some((component) => component === '..')) {
      throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Path escapes the workspace');
    }
    const components = rawComponents.filter((component) => component !== '.');
    if (
      components.some(
        (component) =>
          component.includes(':') ||
          /[. ]$/.test(component) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(component),
      )
    ) {
      throw new FileWorkspaceError('FILE_WORKSPACE_INVALID_PATH', 'Invalid workspace path');
    }

    if (components.length === 0 && allowRoot) return this.rootPath;
    if (components.length === 0) {
      throw new FileWorkspaceError('FILE_WORKSPACE_INVALID_PATH', 'A file path is required');
    }

    const target = path.resolve(this.rootPath, ...components);
    const relative = path.relative(this.rootPath, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Path escapes the workspace');
    }
    return target;
  }

  /** Walks every component and rejects links before touching the final path. */
  private async verifyPath(
    target: string,
    expectDirectory: boolean,
    allowMissingFinal = false,
    allowAnyFinal = false,
  ): Promise<void> {
    const relative = path.relative(this.rootPath, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Path escapes the workspace');
    }

    const rootInfo = await this.withIo(() => lstat(this.rootPath));
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Workspace root changed unexpectedly');
    }
    const canonicalRoot = await this.withIo(() => realpath(this.rootPath));
    if (path.resolve(canonicalRoot) !== path.resolve(this.rootPath)) {
      throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Path escapes the workspace');
    }

    const components = relative ? relative.split(path.sep) : [];
    let current = this.rootPath;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (this.isCode(error, 'ENOENT')) {
          if (allowMissingFinal && index === components.length - 1) return;
          throw new FileWorkspaceError(
            'FILE_WORKSPACE_PATH_NOT_FOUND',
            'Workspace path was not found',
          );
        }
        throw this.ioError(error);
      }

      if (info.isSymbolicLink()) {
        throw new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Symbolic links are not allowed');
      }
      if (index < components.length - 1 && !info.isDirectory()) {
        throw new FileWorkspaceError(
          'FILE_WORKSPACE_NOT_DIRECTORY',
          'Parent path is not a directory',
        );
      }
      if (index === components.length - 1 && expectDirectory && !info.isDirectory()) {
        throw new FileWorkspaceError('FILE_WORKSPACE_NOT_DIRECTORY', 'Path is not a directory');
      }
      if (index === components.length - 1 && !expectDirectory && !allowAnyFinal && !info.isFile()) {
        throw new FileWorkspaceError('FILE_WORKSPACE_NOT_FILE', 'Path is not a file');
      }

      const canonical = await this.withIo(() => realpath(current));
      const actualRelative = path.relative(this.rootPath, canonical);
      if (
        actualRelative === '..' ||
        actualRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(actualRelative)
      ) {
        throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Path escapes the workspace');
      }
    }

    if (components.length === 0 && !expectDirectory) {
      throw new FileWorkspaceError('FILE_WORKSPACE_INVALID_PATH', 'Workspace root is not a file');
    }
  }

  private async withIo<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FileWorkspaceError) throw error;
      throw this.ioError(error);
    }
  }

  private ioError(error: unknown): FileWorkspaceError {
    if (this.isCode(error, 'ENOENT')) {
      return new FileWorkspaceError(
        'FILE_WORKSPACE_PATH_NOT_FOUND',
        'Workspace path was not found',
      );
    }
    if (this.isCode(error, 'ELOOP')) {
      return new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Symbolic links are not allowed');
    }
    if (this.isCode(error, 'ENOTDIR')) {
      return new FileWorkspaceError(
        'FILE_WORKSPACE_NOT_DIRECTORY',
        'Parent path is not a directory',
      );
    }
    return new FileWorkspaceError('FILE_WORKSPACE_IO', 'Workspace operation failed');
  }

  private isCode(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === code
    );
  }

  private sameFile(
    left: { dev: number; ino: number },
    right: { dev: number; ino: number },
  ): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }
}
