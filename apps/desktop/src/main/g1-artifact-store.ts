import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@cultivation/shared';
import { GenerationCrash } from '@cultivation/application/g1-generation';
import {
  getGenerationMediaCeilingBytes,
  GENERATION_MEDIA_POLICY as GENERATION_MEDIA_SAFETY_POLICY,
} from '@cultivation/application/g1-media-policy';
import { validateGenerationMedia, type GenerationMediaReader } from './g1-media-validator.js';
import type {
  GenerationArtifact,
  GenerationJob,
  GenerationModelDescriptor,
  GenerationOutputDescriptor,
  GenerationTask,
} from '@cultivation/domain/g1-generation';
import type {
  GenerationArtifactPort,
  GenerationRepository,
  GenerationResolvedInput,
  GenerationBinarySource,
} from '@cultivation/application/g1-generation';

type Format = { mimeType: string; extension: string; container: string };
const formats = new Map<string, Format>([
  ['image/png', { mimeType: 'image/png', extension: '.png', container: 'png' }],
  ['video/mp4', { mimeType: 'video/mp4', extension: '.mp4', container: 'mp4' }],
  ['audio/wav', { mimeType: 'audio/wav', extension: '.wav', container: 'wav' }],
  ['audio/wave', { mimeType: 'audio/wav', extension: '.wav', container: 'wav' }],
  ['audio/x-wav', { mimeType: 'audio/wav', extension: '.wav', container: 'wav' }],
]);

export interface GenerationArtifactStoreOptions {
  /** Electron app.getPath('userData'), supplied only by Main. */
  userData: string;
  repository: Pick<
    GenerationRepository,
    'getArtifact' | 'getJob' | 'getTask' | 'listJobs' | 'listArtifacts'
  >;
  /** Current task-bound Workspace from Main's controlled execution context. */
  workspaceRoot: () => string | null;
  authorize: (
    task: GenerationTask,
    capability: 'FILE_READ' | 'FILE_WRITE',
    resource: string,
  ) => Promise<void>;
  /** May lower the application media ceiling for a stricter installation/test. */
  maxBytes?: number;
  crash?: (point: 'DOWNLOADING' | 'STAGED' | 'COMMITTED', job: GenerationJob) => void;
}

type StorePaths = { root: string; staging: string; files: string; bindings: string };

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function hashName(value: string): string {
  return digest(Buffer.from(value, 'utf8'));
}

function artifactId(jobId: string, outputId: string): string {
  return createHash('sha256')
    .update(jobId, 'utf8')
    .update('\0')
    .update(outputId, 'utf8')
    .digest('hex');
}

function safeTaskId(value: string): string {
  if (!/^[a-z0-9_-]{1,128}$/iu.test(value)) fail('INVALID_INPUT', 'GenerationTask id 无效');
  return value;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fingerprint requires finite JSON numbers');
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) {
    return `{"$uint8ArraySha256":${JSON.stringify(digest(value))},"byteLength":${value.byteLength}}`;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Fingerprint cannot encode a cyclic value');
    ancestors.add(value);
    try {
      const items = Array.from({ length: value.length }, (_, index) => {
        if (!(index in value)) throw new TypeError('Fingerprint cannot encode sparse arrays');
        return canonicalJson(value[index], ancestors);
      });
      return `[${items.join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Fingerprint accepts only plain JSON objects');
    if (ancestors.has(object)) throw new TypeError('Fingerprint cannot encode a cyclic value');
    if (Reflect.ownKeys(object).some((key) => typeof key !== 'string'))
      throw new TypeError('Fingerprint cannot encode symbol keys');
    ancestors.add(object);
    try {
      const keys = Object.keys(object).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`).join(',')}}`;
    } finally {
      ancestors.delete(object);
    }
  }
  throw new TypeError('Fingerprint accepts JSON values or Uint8Array');
}

function safeRelativePath(value: string): string[] {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  )
    fail('INVALID_OUTPUT_PATH', '生成输出路径必须是安全的相对路径');
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        // eslint-disable-next-line no-control-regex -- Reject control bytes in filesystem names.
        /[\u0000-\u001f\u007f:*?"<>|:]/u.test(segment) ||
        /[ .]$/u.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
    )
  )
    fail('INVALID_OUTPUT_PATH', '生成输出路径包含不安全的路径组件');
  return segments;
}

function normalizedHint(task: GenerationTask, id: string, extension: string): string {
  const hint = task.outputDestination.logicalPathHint;
  if (hint == null || hint.trim() === '') return `artifacts/${id}${extension}`;
  const segments = safeRelativePath(hint);
  const current = segments.join('/');
  const hintExtension = path.posix.extname(current).toLowerCase();
  if (hintExtension && hintExtension !== extension)
    fail('UNSUPPORTED_MEDIA_TYPE', '输出路径扩展名与媒体类型不匹配');
  return hintExtension ? current : `${current}${extension}`;
}

function appStoreKey(id: string, extension: string): string {
  return `files/${id}${extension}`;
}

function outputStorageKey(task: GenerationTask, id: string, extension: string): string {
  return task.outputDestination.scope === 'APP_ARTIFACT_STORE'
    ? appStoreKey(id, extension)
    : normalizedHint(task, id, extension);
}

function matchesMime(value: string, format: Format): boolean {
  return formats.get(value.trim().toLowerCase())?.mimeType === format.mimeType;
}

function validateProviderClaims(
  claims: GenerationOutputDescriptor['metadata'],
  metadata: Record<string, number | string | boolean | null>,
): void {
  for (const key of ['width', 'height', 'channels', 'sampleRate', 'bitsPerSample']) {
    const claimed = claims?.[key];
    if (claimed !== undefined && metadata[key] !== claimed)
      fail('ARTIFACT_INTEGRITY', 'Provider 声明的媒体元数据与文件头不一致');
  }
  const duration = claims?.durationSeconds;
  if (
    duration !== undefined &&
    (typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      typeof metadata.durationSeconds !== 'number' ||
      Math.abs(duration - metadata.durationSeconds) > 0.000001)
  )
    fail('ARTIFACT_INTEGRITY', 'Provider 声明的媒体时长与文件不一致');
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatOrNull(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function walkAbsoluteDirectory(directory: string, create: boolean): Promise<string> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    fail('WORKSPACE_REQUIRED', '目录必须是 Main 提供的绝对路径');
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let details = await lstatOrNull(current);
    if (!details && create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      details = await lstat(current);
    }
    if (!details) fail('WORKSPACE_REQUIRED', 'Workspace 目录不存在');
    if (details.isSymbolicLink() || !details.isDirectory())
      fail('WORKSPACE_PATH_ESCAPE', '目录路径包含 symlink 或非目录组件');
    const canonical = await realpath(current);
    if (!samePath(canonical, current)) fail('WORKSPACE_PATH_ESCAPE', '目录路径 canonicalize 失败');
  }
  const canonical = await realpath(absolute);
  if (!samePath(canonical, absolute)) fail('WORKSPACE_PATH_ESCAPE', '目录路径 canonicalize 失败');
  return canonical;
}

async function ensureDirectoryUnderRoot(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let details = await lstatOrNull(current);
    if (!details) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      details = await lstat(current);
    }
    if (details.isSymbolicLink() || !details.isDirectory())
      fail('WORKSPACE_PATH_ESCAPE', '目录路径包含 symlink 或非目录组件');
    if (!samePath(await realpath(current), current) || !inside(root, current))
      fail('WORKSPACE_PATH_ESCAPE', '目录路径逃逸受控根目录');
  }
  return current;
}

async function resolveSafeFile(
  rootValue: string,
  relativeValue: string,
  createParents: boolean,
): Promise<{ target: string; exists: boolean }> {
  const root = await walkAbsoluteDirectory(rootValue, false);
  const segments = safeRelativePath(relativeValue);
  const parents = segments.slice(0, -1);
  let parent = root;
  for (const segment of parents) {
    if (createParents) {
      parent = await ensureDirectoryUnderRoot(
        root,
        path.relative(root, path.join(parent, segment)).split(path.sep),
      );
      continue;
    }
    parent = path.join(parent, segment);
    const details = await lstatOrNull(parent);
    if (!details) return { target: path.join(root, ...segments), exists: false };
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      !samePath(await realpath(parent), parent) ||
      !inside(root, parent)
    )
      fail('WORKSPACE_PATH_ESCAPE', '文件父目录包含 symlink 或逃逸受控根目录');
  }
  const target = path.join(root, ...segments);
  if (!inside(root, target)) fail('WORKSPACE_PATH_ESCAPE', '文件路径逃逸受控根目录');
  const details = await lstatOrNull(target);
  if (!details) return { target, exists: false };
  if (details.isSymbolicLink() || !details.isFile() || !samePath(await realpath(target), target))
    fail('WORKSPACE_PATH_ESCAPE', 'Artifact 路径不是受控普通文件');
  return { target, exists: true };
}

async function readSmallBindingJson(
  root: string,
  relativeValue: string,
  maxBytes: number,
): Promise<Buffer> {
  // Whole-file reads are confined to the small Main-owned Workspace binding JSON.
  if (maxBytes > 16 * 1024) fail('INPUT_TOO_LARGE', 'Binding JSON 超出读取限制');
  const resolved = await resolveSafeFile(root, relativeValue, false);
  if (!resolved.exists) fail('ARTIFACT_INTEGRITY', 'Artifact 文件不存在');
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(resolved.target, flags);
  try {
    const before = await handle.stat();
    const beforePath = await lstat(resolved.target);
    if (!before.isFile() || beforePath.isSymbolicLink() || !sameFile(before, beforePath))
      fail('WORKSPACE_PATH_ESCAPE', 'Artifact 文件身份发生变化');
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes)
      fail('INPUT_TOO_LARGE', 'Artifact 超出读取大小限制');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail('ARTIFACT_INTEGRITY', 'Artifact 读取期间发生变化');
      offset += bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await lstat(resolved.target);
    const current = await resolveSafeFile(root, relativeValue, false);
    if (
      !current.exists ||
      !samePath(current.target, resolved.target) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      !sameFile(after, afterPath)
    )
      fail('ARTIFACT_INTEGRITY', 'Artifact 读取期间发生变化');
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeHash(value: string): boolean {
  return /^[a-f0-9]{64}$/iu.test(value);
}

function sameMetadata(
  left: Record<string, number | string | boolean | null>,
  right: Record<string, number | string | boolean | null>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

type FileFacts = {
  sizeBytes: number;
  contentHash: string;
  metadata: Record<string, number | string | boolean | null>;
};
type SafeReader = GenerationMediaReader & {
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
};
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail('GENERATION_CANCELLED', '媒体传输已取消');
}
async function openReader(
  root: string,
  key: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SafeReader> {
  checkAbort(signal);
  const resolved = await resolveSafeFile(root, key, false);
  if (!resolved.exists) fail('ARTIFACT_INTEGRITY', 'Artifact 文件不存在');
  const handle = await open(resolved.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const identity = await lstat(resolved.target);
    if (!before.isFile() || identity.isSymbolicLink() || !sameFile(before, identity))
      fail('WORKSPACE_PATH_ESCAPE', 'Artifact 文件身份发生变化');
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > limit)
      fail('INPUT_TOO_LARGE', 'Artifact 超出媒体安全限制');
    let closed = false;
    const read = async (offset: number, length: number): Promise<Buffer> => {
      checkAbort(signal);
      if (
        closed ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        length > GENERATION_MEDIA_SAFETY_POLICY.ioChunkBytes ||
        offset + length > before.size
      )
        fail('ARTIFACT_INTEGRITY', '媒体读取范围无效');
      const bytes = Buffer.alloc(length);
      let cursor = 0;
      while (cursor < length) {
        checkAbort(signal);
        const result = await handle.read(bytes, cursor, length - cursor, offset + cursor);
        if (!result.bytesRead) fail('ARTIFACT_INTEGRITY', 'Artifact 读取期间发生变化');
        cursor += result.bytesRead;
      }
      return bytes;
    };
    return {
      sizeBytes: before.size,
      read,
      async *chunks(offset = 0, length = before.size - offset) {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          offset + length > before.size
        )
          fail('ARTIFACT_INTEGRITY', '媒体读取范围无效');
        const end = offset + length;
        for (
          let cursor = offset;
          cursor < end;
          cursor += GENERATION_MEDIA_SAFETY_POLICY.ioChunkBytes
        )
          yield await read(
            cursor,
            Math.min(GENERATION_MEDIA_SAFETY_POLICY.ioChunkBytes, end - cursor),
          );
      },
      async assertUnchanged() {
        const after = await handle.stat();
        const current = await resolveSafeFile(root, key, false);
        const afterPath = current.exists ? await lstat(current.target) : null;
        if (
          !current.exists ||
          !samePath(current.target, resolved.target) ||
          !afterPath ||
          !sameFile(before, after) ||
          !sameFile(after, afterPath) ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          fail('ARTIFACT_INTEGRITY', 'Artifact 读取期间发生变化');
      },
      async close() {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function fileFacts(reader: SafeReader, format: Format): Promise<FileFacts> {
  const hash = createHash('sha256');
  for await (const chunk of reader.chunks()) hash.update(chunk);
  const metadata = await validateGenerationMedia(format.mimeType, reader);
  await reader.assertUnchanged();
  return { sizeBytes: reader.sizeBytes, contentHash: hash.digest('hex'), metadata };
}
/** Main-owned sources expose readable capabilities, never filesystem paths. */
export class GenerationArtifactStore implements GenerationArtifactPort {
  constructor(private readonly options: GenerationArtifactStoreOptions) {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    )
      throw new RangeError('Generation artifact safety override must be positive');
    if (!options.userData || !path.isAbsolute(options.userData))
      throw new TypeError('Main userData required');
  }
  private limit(mime: string, direction: 'input' | 'output'): number {
    const ceiling = getGenerationMediaCeilingBytes('', mime, direction);
    if (ceiling === null) fail('UNSUPPORTED_MEDIA_TYPE', '媒体安全类别无效');
    return Math.min(ceiling, this.options.maxBytes ?? Number.MAX_SAFE_INTEGER);
  }
  fingerprint(value: unknown): string {
    if (value instanceof Uint8Array) return digest(value);
    return digest(Buffer.from(canonicalJson(value), 'utf8'));
  }
  /** Snapshot a Main-verified Mission Workspace once and reject later root changes. */
  async validateDestination(task: GenerationTask): Promise<void> {
    this.validateTaskDestination(task);
    if (task.outputDestination.scope === 'APP_ARTIFACT_STORE') return;
    if (!task.missionId?.trim() || !task.runId?.trim())
      fail('WORKSPACE_REQUIRED', 'Mission Workspace 输出必须绑定 Mission 与 Run');
    const supplied = this.options.workspaceRoot();
    if (!supplied) fail('WORKSPACE_REQUIRED', 'Mission Workspace 未绑定');
    const current = await walkAbsoluteDirectory(supplied, false);
    const paths = await this.storePaths();
    const bindingKey = `bindings/${safeTaskId(task.id)}.json`;
    const pathInfo = await resolveSafeFile(paths.root, bindingKey, false);
    const snapshot = JSON.stringify({ taskId: task.id, workspaceRoot: current });
    if (pathInfo.exists) {
      const existing = await readSmallBindingJson(paths.root, bindingKey, 16 * 1024);
      const record = this.parseBinding(existing, task.id);
      if (!samePath(record.workspaceRoot, current))
        fail('WORKSPACE_CHANGED', 'Mission Workspace 根目录自任务首次绑定后发生变化');
      return;
    }
    try {
      await writeExclusive(pathInfo.target, Buffer.from(snapshot, 'utf8'));
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const existing = await readSmallBindingJson(paths.root, bindingKey, 16 * 1024);
      const record = this.parseBinding(existing, task.id);
      if (!samePath(record.workspaceRoot, current))
        fail('WORKSPACE_CHANGED', 'Mission Workspace 根目录自任务首次绑定后发生变化');
    }
    const written = await readSmallBindingJson(paths.root, bindingKey, 16 * 1024);
    if (!samePath(this.parseBinding(written, task.id).workspaceRoot, current))
      fail('WORKSPACE_CHANGED', 'Mission Workspace 根目录绑定未能持久化');
  }

  async resolveInput(
    binding: GenerationTask['inputs'][number],
    task: GenerationTask,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationResolvedInput> {
    if (!binding || typeof binding.artifactId !== 'string')
      fail('ARTIFACT_INTEGRITY', '输入 Artifact identity 无效');
    const artifact = this.findArtifact(binding?.artifactId);
    if (!artifact || artifact.id !== binding.artifactId)
      fail('ARTIFACT_INTEGRITY', '生成输入必须引用已登记 Artifact');
    const sourceTask = this.sourceTask(artifact);
    const format = formats.get(artifact.mimeType.toLowerCase());
    if (!format || artifact.extension.toLowerCase() !== format.extension)
      fail('UNSUPPORTED_MEDIA_TYPE', '输入媒体类型无效');
    const key = safeRelativePath(artifact.storageKey).join('/');
    if (
      key !== outputStorageKey(sourceTask, artifact.id, format.extension) ||
      artifact.id !== artifactId(artifact.jobId, artifact.outputId)
    )
      fail('ARTIFACT_INTEGRITY', '输入 Artifact identity 无效');
    const prepare = async (signal?: AbortSignal) => {
      const root = await this.rootForArtifact(sourceTask);
      const resolved = await resolveSafeFile(root, key, false);
      if (artifact.storageScope === 'MISSION_WORKSPACE')
        await this.options.authorize(
          task,
          'FILE_READ',
          this.permissionResource(root, resolved.target),
        );
      const reader = await openReader(root, key, this.limit(format.mimeType, 'input'), signal);
      try {
        this.verifyArtifactFacts(artifact, sourceTask, await fileFacts(reader, format));
        return reader;
      } catch (error) {
        await reader.close();
        throw error;
      }
    };
    const checked = await prepare(options?.signal);
    await checked.close();
    const controller = new AbortController();
    return {
      artifactId: artifact.id,
      role: binding.role,
      kind: artifact.kind,
      mimeType: format.mimeType,
      contentHash: artifact.contentHash,
      sizeBytes: artifact.sizeBytes,
      source: {
        open: (signal?: AbortSignal) => {
          const active = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
          return (async function* () {
            const reader = await prepare(active);
            try {
              const hash = createHash('sha256');
              for await (const chunk of reader.chunks()) {
                hash.update(chunk);
                yield chunk;
              }
              await reader.assertUnchanged();
              if (hash.digest('hex') !== artifact.contentHash)
                fail('ARTIFACT_INTEGRITY', '上传输入内容发生变化');
            } finally {
              await reader.close();
            }
          })();
        },
        cancel: () => {
          controller.abort();
        },
      },
    };
  }
  async commit(
    job: GenerationJob,
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    download: (options?: { signal?: AbortSignal }) => Promise<GenerationBinarySource>,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationArtifact> {
    checkAbort(options?.signal);
    if (job.generationTaskId !== task.id) fail('ARTIFACT_INTEGRITY', 'Job 与任务不匹配');
    await this.validateDestination(task);
    const format = this.outputFormat(task, descriptor, output);
    const id = artifactId(job.id, output.id);
    const key = outputStorageKey(task, id, format.extension);
    const paths = await this.storePaths();
    const root =
      task.outputDestination.scope === 'APP_ARTIFACT_STORE'
        ? paths.root
        : await this.boundWorkspaceRoot(task, true);
    const target = await resolveSafeFile(root, key, false);
    if (task.outputDestination.scope === 'MISSION_WORKSPACE')
      await this.options.authorize(
        task,
        'FILE_WRITE',
        this.permissionResource(root, target.target),
      );
    if (target.exists) {
      const facts = await this.outputFacts(
        root,
        key,
        task,
        descriptor,
        output,
        format,
        options?.signal,
      );
      this.options.crash?.('COMMITTED', job);
      return this.makeArtifact(job, task, output, id, format, key, facts);
    }
    const stageKey =
      'staging/' + hashName(job.id) + '/' + hashName(output.id) + format.extension + '.stage';
    const stage = await this.writeOrReuseStage(
      paths.root,
      stageKey,
      descriptor,
      output,
      format,
      download,
      options?.signal,
      () => this.options.crash?.('DOWNLOADING', job),
    );
    await this.outputFacts(paths.root, stageKey, task, descriptor, output, format, options?.signal);
    this.options.crash?.('STAGED', job);
    const currentRoot =
      task.outputDestination.scope === 'APP_ARTIFACT_STORE'
        ? paths.root
        : await this.boundWorkspaceRoot(task, true);
    const final = await resolveSafeFile(currentRoot, key, true);
    if (task.outputDestination.scope === 'MISSION_WORKSPACE')
      await this.options.authorize(
        task,
        'FILE_WRITE',
        this.permissionResource(currentRoot, final.target),
      );
    let publishFrom = stage;
    if (task.outputDestination.scope === 'MISSION_WORKSPACE') {
      const stageLimit = this.limit(format.mimeType, 'output');
      const workspaceStageKey =
        '.generation-artifact-staging/' +
        hashName(task.id) +
        '/' +
        hashName(output.id) +
        format.extension +
        '.stage';
      publishFrom = await this.writeOrReuseStage(
        currentRoot,
        workspaceStageKey,
        descriptor,
        output,
        format,
        async () => ({
          open: (signal?: AbortSignal) =>
            (async function* () {
              const reader = await openReader(paths.root, stageKey, stageLimit, signal);
              try {
                for await (const chunk of reader.chunks()) yield chunk;
                await reader.assertUnchanged();
              } finally {
                await reader.close();
              }
            })(),
          cancel: () => undefined,
        }),
        options?.signal,
      );
      await this.outputFacts(
        currentRoot,
        workspaceStageKey,
        task,
        descriptor,
        output,
        format,
        options?.signal,
      );
    }
    try {
      await link(publishFrom, final.target);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') fail('ARTIFACT_COMMIT_FAILED', 'Artifact 无法原子提交');
    }
    const facts = await this.outputFacts(
      currentRoot,
      key,
      task,
      descriptor,
      output,
      format,
      options?.signal,
    );
    this.options.crash?.('COMMITTED', job);
    return this.makeArtifact(job, task, output, id, format, key, facts);
  }
  async verify(artifact: GenerationArtifact, task: GenerationTask): Promise<void> {
    const source = this.sourceTask(artifact);
    if (
      source.id !== task.id ||
      artifact.id !== artifactId(artifact.jobId, artifact.outputId) ||
      artifact.storageScope !== task.outputDestination.scope
    )
      fail('ARTIFACT_INTEGRITY', '已登记 Artifact identity 无效');
    await this.validateDestination(task);
    const format = formats.get(artifact.mimeType.toLowerCase());
    if (!format || artifact.extension !== format.extension)
      fail('UNSUPPORTED_MEDIA_TYPE', '已登记媒体类型无效');
    const key = safeRelativePath(artifact.storageKey).join('/');
    if (key !== outputStorageKey(task, artifact.id, format.extension))
      fail('ARTIFACT_INTEGRITY', 'Artifact 存储 identity 无效');
    const root = await this.rootForArtifact(task);
    const resolved = await resolveSafeFile(root, key, false);
    if (artifact.storageScope === 'MISSION_WORKSPACE')
      await this.options.authorize(
        task,
        'FILE_WRITE',
        this.permissionResource(root, resolved.target),
      );
    const reader = await openReader(root, key, this.limit(format.mimeType, 'output'));
    try {
      this.verifyArtifactFacts(artifact, task, await fileFacts(reader, format));
    } finally {
      await reader.close();
    }
  }
  private validateTaskDestination(task: GenerationTask): void {
    if (
      !task ||
      !task.id ||
      !task.outputDestination ||
      !['APP_ARTIFACT_STORE', 'MISSION_WORKSPACE'].includes(task.outputDestination.scope)
    )
      fail('INVALID_INPUT', 'GenerationTask outputDestination 无效');
    if (
      task.outputDestination.logicalPathHint != null &&
      task.outputDestination.logicalPathHint !== ''
    )
      safeRelativePath(task.outputDestination.logicalPathHint);
  }

  private async storePaths(): Promise<StorePaths> {
    const userData = await walkAbsoluteDirectory(this.options.userData, true);
    const root = await ensureDirectoryUnderRoot(userData, ['generation-artifacts']);
    const staging = await ensureDirectoryUnderRoot(root, ['staging']);
    const files = await ensureDirectoryUnderRoot(root, ['files']);
    const bindings = await ensureDirectoryUnderRoot(root, ['bindings']);
    return { root, staging, files, bindings };
  }

  private parseBinding(bytes: Buffer, taskId: string): { taskId: string; workspaceRoot: string } {
    try {
      const record = JSON.parse(bytes.toString('utf8')) as {
        taskId?: unknown;
        workspaceRoot?: unknown;
      };
      if (
        record.taskId !== taskId ||
        typeof record.workspaceRoot !== 'string' ||
        !path.isAbsolute(record.workspaceRoot)
      )
        fail('ARTIFACT_INTEGRITY', 'Workspace root binding 无效');
      return { taskId, workspaceRoot: record.workspaceRoot };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      fail('ARTIFACT_INTEGRITY', 'Workspace root binding 无效');
    }
  }

  private async boundWorkspaceRoot(task: GenerationTask, compareCurrent: boolean): Promise<string> {
    const paths = await this.storePaths();
    const key = `bindings/${safeTaskId(task.id)}.json`;
    const bytes = await readSmallBindingJson(paths.root, key, 16 * 1024);
    const record = this.parseBinding(bytes, task.id);
    const bound = await walkAbsoluteDirectory(record.workspaceRoot, false);
    if (!samePath(bound, record.workspaceRoot))
      fail('WORKSPACE_CHANGED', '绑定的 Workspace 根目录已改变');
    if (compareCurrent) {
      const supplied = this.options.workspaceRoot();
      if (!supplied) fail('WORKSPACE_REQUIRED', 'Mission Workspace 未绑定');
      const current = await walkAbsoluteDirectory(supplied, false);
      if (!samePath(current, record.workspaceRoot))
        fail('WORKSPACE_CHANGED', 'Mission Workspace 根目录自任务首次绑定后发生变化');
    }
    return bound;
  }

  private async rootForArtifact(task: GenerationTask): Promise<string> {
    if (task.outputDestination.scope === 'APP_ARTIFACT_STORE')
      return (await this.storePaths()).root;
    return this.boundWorkspaceRoot(task, false);
  }

  private permissionResource(root: string, target: string): string {
    if (!inside(root, target)) fail('WORKSPACE_PATH_ESCAPE', 'Permission resource 逃逸受控根目录');
    const relative = path.relative(root, target).split(path.sep).join('/');
    return `file:${root}:${relative}`;
  }

  private outputFormat(
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
  ): Format {
    if (
      !output ||
      typeof output.id !== 'string' ||
      !output.id ||
      output.id.length > 256 ||
      // eslint-disable-next-line no-control-regex -- reject untrusted output identity control bytes
      /[\u0000-\u001f\u007f]/u.test(output.id) ||
      typeof output.mimeType !== 'string' ||
      typeof output.extension !== 'string'
    )
      fail('OUTPUT_MISSING', 'Provider output identity 无效');
    const format = formats.get(output.mimeType.trim().toLowerCase());
    if (
      !format ||
      !descriptor.outputTypes.some((m) => matchesMime(m, format)) ||
      !task.expectedOutput.mimeTypes.some((m) => matchesMime(m, format)) ||
      output.extension.toLowerCase() !== format.extension
    )
      fail('UNSUPPORTED_MEDIA_TYPE', 'Provider 媒体类型与契约不一致');
    if (
      !Number.isSafeInteger(descriptor.limits.maxOutputBytes) ||
      descriptor.limits.maxOutputBytes < 1 ||
      !Number.isSafeInteger(output.sizeBytes) ||
      output.sizeBytes < 1 ||
      output.sizeBytes >
        Math.min(this.limit(format.mimeType, 'output'), descriptor.limits.maxOutputBytes)
    )
      fail('INPUT_TOO_LARGE', 'Provider 输出超过安全大小限制');
    if (!safeHash(output.contentHash)) fail('ARTIFACT_INTEGRITY', '输出 hash 无效');
    return format;
  }
  private async outputFacts(
    root: string,
    key: string,
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    format: Format,
    signal?: AbortSignal,
  ): Promise<FileFacts> {
    const reader = await openReader(
      root,
      key,
      Math.min(this.limit(format.mimeType, 'output'), descriptor.limits.maxOutputBytes),
      signal,
    );
    try {
      const facts = await fileFacts(reader, format);
      if (
        facts.sizeBytes !== output.sizeBytes ||
        facts.contentHash !== output.contentHash.toLowerCase()
      )
        fail('ARTIFACT_INTEGRITY', 'Provider 输出 size/hash 与文件不一致');
      validateProviderClaims(output.metadata, facts.metadata);
      if (!task.expectedOutput.mimeTypes.some((m) => matchesMime(m, format)))
        fail('UNSUPPORTED_MEDIA_TYPE', '输出 MIME 与任务不一致');
      return facts;
    } finally {
      await reader.close();
    }
  }
  private async writeOrReuseStage(
    root: string,
    key: string,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    format: Format,
    download: (options?: { signal?: AbortSignal }) => Promise<GenerationBinarySource>,
    signal?: AbortSignal,
    progress?: () => void,
  ): Promise<string> {
    const complete = await resolveSafeFile(root, key, true);
    if (complete.exists) return complete.target; // caller verifies before trusting/reusing it
    const partialKey = key + '.partial';
    const partial = await resolveSafeFile(root, partialKey, true);
    const handle = await open(
      partial.target,
      fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const controller = new AbortController();
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let source: GenerationBinarySource | undefined;
    let cancelled = false;
    const cancelSource = () => {
      if (cancelled || !source) return;
      cancelled = true;
      void Promise.resolve()
        .then(() => source?.cancel())
        .catch(() => undefined);
    };
    let count = 0;
    const hash = createHash('sha256');
    try {
      const identity = await handle.stat();
      const current = await lstat(partial.target);
      if (
        !identity.isFile() ||
        identity.nlink !== 1 ||
        current.isSymbolicLink() ||
        !sameFile(identity, current)
      )
        fail('WORKSPACE_PATH_ESCAPE', 'Partial staging identity 无效');
      await handle.truncate(0); // only Main-owned incomplete staging is reset; never a complete Artifact
      checkAbort(active);
      source = await download({ signal: active });
      if (!source || typeof source.open !== 'function' || typeof source.cancel !== 'function')
        fail('ARTIFACT_INTEGRITY', 'Provider 未返回受控 readable source');
      active.addEventListener('abort', cancelSource, { once: true });
      if (active.aborted) cancelSource();
      const limit = Math.min(
        this.limit(format.mimeType, 'output'),
        descriptor.limits.maxOutputBytes,
      );
      for await (const chunk of source.open(active)) {
        checkAbort(active);
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.byteLength < 1 ||
          chunk.byteLength > GENERATION_MEDIA_SAFETY_POLICY.maxSourceChunkBytes ||
          count + chunk.byteLength > limit
        )
          fail('INPUT_TOO_LARGE', '流式输出超过安全限制');
        if (count + chunk.byteLength > output.sizeBytes)
          fail('ARTIFACT_INTEGRITY', '流式输出超过声明大小');
        for (let offset = 0; offset < chunk.byteLength; ) {
          const bytes = chunk.subarray(
            offset,
            Math.min(chunk.byteLength, offset + GENERATION_MEDIA_SAFETY_POLICY.ioChunkBytes),
          );
          let written = 0;
          while (written < bytes.byteLength) {
            checkAbort(active);
            const result = await handle.write(
              bytes,
              written,
              bytes.byteLength - written,
              count + written,
            );
            if (!result.bytesWritten) fail('ARTIFACT_COMMIT_FAILED', 'Staging 写入失败');
            written += result.bytesWritten;
          }
          hash.update(bytes);
          count += bytes.byteLength;
          offset += bytes.byteLength;
          progress?.();
        }
      }
      checkAbort(active);
      if (count !== output.sizeBytes || hash.digest('hex') !== output.contentHash.toLowerCase())
        fail('ARTIFACT_INTEGRITY', '流式输出 size/hash 与声明不一致');
      await handle.sync();
      const afterPath = await resolveSafeFile(root, partialKey, false);
      if (!afterPath.exists || !sameFile(await handle.stat(), await lstat(afterPath.target)))
        fail('WORKSPACE_PATH_ESCAPE', 'Partial staging identity 发生变化');
    } catch (error) {
      controller.abort();
      cancelSource();
      if (signal?.aborted) fail('GENERATION_CANCELLED', '媒体传输已取消');
      if (error instanceof DomainError || error instanceof GenerationCrash) throw error;
      throw new GenerationCrash('媒体下载中断；保留原 Provider Job 与 partial staging');
    } finally {
      active.removeEventListener('abort', cancelSource);
      await handle.close();
    }
    // Only fully validated files obtain the complete staging identity.
    const reader = await openReader(
      root,
      partialKey,
      this.limit(format.mimeType, 'output'),
      signal,
    );
    try {
      const facts = await fileFacts(reader, format);
      validateProviderClaims(output.metadata, facts.metadata);
    } finally {
      await reader.close();
    }
    try {
      await link(partial.target, complete.target);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') fail('ARTIFACT_COMMIT_FAILED', '完整 staging 无法提交');
    }
    return complete.target;
  }
  private findArtifact(id: string): GenerationArtifact | null {
    const direct = this.options.repository.getArtifact(id);
    if (direct?.id === id) return direct;
    for (const job of this.options.repository.listJobs()) {
      const found = this.options.repository
        .listArtifacts(job.id)
        .find((artifact) => artifact.id === id);
      if (found) return found;
    }
    return null;
  }

  private sourceTask(artifact: GenerationArtifact): GenerationTask {
    const job = this.options.repository.getJob(artifact.jobId);
    const task = job ? this.options.repository.getTask(job.generationTaskId) : null;
    if (!job || job.id !== artifact.jobId || !task || task.id !== job.generationTaskId)
      fail('ARTIFACT_INTEGRITY', 'generation_artifacts 来源任务不存在');
    return task;
  }

  private verifyArtifactFacts(
    artifact: GenerationArtifact,
    source: GenerationTask,
    facts: FileFacts,
  ): void {
    if (
      artifact.kind !== source.expectedOutput.artifactKind ||
      artifact.storageScope !== source.outputDestination.scope ||
      artifact.sizeBytes !== facts.sizeBytes ||
      artifact.contentHash !== facts.contentHash ||
      !sameMetadata(artifact.metadata, facts.metadata)
    )
      fail('ARTIFACT_INTEGRITY', '登记的 Artifact 与文件内容不一致');
  }
  private makeArtifact(
    job: GenerationJob,
    task: GenerationTask,
    output: GenerationOutputDescriptor,
    id: string,
    format: Format,
    storageKey: string,
    facts: FileFacts,
  ): GenerationArtifact {
    return {
      id,
      jobId: job.id,
      outputId: output.id,
      kind: task.expectedOutput.artifactKind,
      mimeType: format.mimeType,
      extension: format.extension,
      sizeBytes: facts.sizeBytes,
      contentHash: facts.contentHash,
      metadata: facts.metadata,
      storageScope: task.outputDestination.scope,
      storageKey,
      createdAt: task.createdAt,
    };
  }
}
