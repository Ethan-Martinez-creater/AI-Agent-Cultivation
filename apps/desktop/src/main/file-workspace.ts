import { constants as fsConstants } from 'node:fs';
import { realpathSync, lstatSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
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
import { createHash } from 'node:crypto';

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ARTIFACT_READ_BYTES = 10 * 1024 * 1024;

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

  /** Synchronous bounded reinspection at Run creation; no await separates hash validation and snapshot commit. */
  static inspectRegisteredInput(
    root: string,
    relativePath: string,
  ): { contentHash: string; sizeBytes: number } {
    const canonicalRoot = realpathSync(root);
    if (canonicalRoot.toLowerCase() !== root.toLowerCase())
      throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Registered Workspace changed');
    const workspace = new FileWorkspace(canonicalRoot);
    const target = workspace.resolveRelative(relativePath);
    const verify = () => {
      let current = canonicalRoot;
      for (const segment of path.relative(canonicalRoot, target).split(path.sep)) {
        current = path.join(current, segment);
        if (lstatSync(current).isSymbolicLink())
          throw new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Symbolic links are not allowed');
      }
      if (realpathSync(target).toLowerCase() !== target.toLowerCase())
        throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Input path changed');
    };
    verify();
    const fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > MAX_TEXT_BYTES)
        throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Input must be a bounded file');
      verify();
      if (!workspace.sameFile(before, lstatSync(target)))
        throw new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Input identity changed');
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = readSync(fd, buffer, length, buffer.length - length, length);
        if (!n) break;
        length += n;
      }
      const bytes = buffer.subarray(0, length);
      const after = fstatSync(fd);
      verify();
      if (
        bytes.length > MAX_TEXT_BYTES ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        !workspace.sameFile(after, lstatSync(target))
      )
        throw new FileWorkspaceError('FILE_WORKSPACE_IO', 'Input changed while reading');
      return {
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      };
    } finally {
      closeSync(fd);
    }
  }

  /** Verify a submitted artifact against the same canonical Workspace boundary as file tools. */
  async inspectArtifact(
    relativePath: string,
    maxBytes: number,
    includeHash = false,
  ): Promise<{
    path: string;
    fileName: string;
    extension: string;
    sizeBytes: number;
    contentHash?: string;
  }> {
    const target = this.resolveRelative(relativePath);
    await this.verifyPath(target, false);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await this.withIo(() => open(target, flags));
    try {
      await this.verifyPath(target, false);
      const info = await this.withIo(() => handle.stat());
      const pathInfo = await this.withIo(() => lstat(target));
      if (!info.isFile() || !pathInfo.isFile()) {
        throw new FileWorkspaceError('FILE_WORKSPACE_NOT_FILE', 'Artifact is not a file');
      }
      if (pathInfo.isSymbolicLink() || !this.sameFile(info, pathInfo)) {
        throw new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Symbolic links are not allowed');
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || info.size > maxBytes) {
        throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Artifact exceeds its size limit');
      }
      const canonical = await this.withIo(() => realpath(target));
      const relative = path.relative(this.rootPath, canonical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Path escapes the workspace');
      }
      let contentHash: string | undefined;
      if (includeHash) {
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
          const { bytesRead } = await this.withIo(() =>
            handle.read(buffer, 0, buffer.length, total),
          );
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > maxBytes)
            throw new FileWorkspaceError(
              'FILE_WORKSPACE_TOO_LARGE',
              'Artifact exceeds its size limit',
            );
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await this.withIo(() => handle.stat());
        const current = await this.withIo(() => lstat(target));
        await this.verifyPath(target, false);
        if (
          total !== info.size ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          !this.sameFile(after, current)
        )
          throw new FileWorkspaceError('FILE_WORKSPACE_IO', 'Artifact changed during validation');
        contentHash = hash.digest('hex');
      }
      return {
        path: relative,
        fileName: path.basename(canonical),
        extension: path.extname(canonical).toLowerCase(),
        sizeBytes: info.size,
        ...(contentHash ? { contentHash } : {}),
      };
    } finally {
      await this.withIo(() => handle.close());
    }
  }

  /** Read bounded artifact bytes after enforcing the same canonical Workspace boundary. */
  async readArtifactBytes(relativePath: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_READ_BYTES) {
      throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Invalid artifact read limit');
    }
    const target = this.resolveRelative(relativePath);
    await this.verifyPath(target, false);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await this.withIo(() => open(target, flags));
    try {
      await this.verifyPath(target, false);
      const before = await this.withIo(() => handle.stat());
      const pathBefore = await this.withIo(() => lstat(target));
      if (!before.isFile() || !pathBefore.isFile()) {
        throw new FileWorkspaceError('FILE_WORKSPACE_NOT_FILE', 'Artifact is not a file');
      }
      if (pathBefore.isSymbolicLink() || !this.sameFile(before, pathBefore)) {
        throw new FileWorkspaceError('FILE_WORKSPACE_SYMLINK', 'Symbolic links are not allowed');
      }
      if (before.size > maxBytes) {
        throw new FileWorkspaceError('FILE_WORKSPACE_TOO_LARGE', 'Artifact exceeds its size limit');
      }
      const canonical = await this.withIo(() => realpath(target));
      const relative = path.relative(this.rootPath, canonical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new FileWorkspaceError('FILE_WORKSPACE_PATH_ESCAPE', 'Path escapes the workspace');
      }

      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await this.withIo(() =>
          handle.read(bytes, offset, bytes.byteLength - offset, offset),
        );
        if (bytesRead === 0) {
          throw new FileWorkspaceError('FILE_WORKSPACE_IO', 'Artifact changed during validation');
        }
        offset += bytesRead;
      }

      const after = await this.withIo(() => handle.stat());
      const pathAfter = await this.withIo(() => lstat(target));
      await this.verifyPath(target, false);
      if (
        offset !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        !this.sameFile(after, pathAfter)
      ) {
        throw new FileWorkspaceError('FILE_WORKSPACE_IO', 'Artifact changed during validation');
      }
      return bytes;
    } finally {
      await this.withIo(() => handle.close());
    }
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
