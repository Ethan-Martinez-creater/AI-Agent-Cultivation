import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@cultivation/shared';
import { inflateSync } from 'node:zlib';
import { validateMp4 } from './g1-mp4-validator.js';
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
} from '@cultivation/application/g1-generation';

const MAX_STORE_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

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
  /** May lower the global 16 MiB cap for installations with tighter policies. */
  maxBytes?: number;
  crash?: (point: 'STAGED' | 'COMMITTED', job: GenerationJob) => void;
}

type ParsedContent = { format: Format; metadata: Record<string, number | string | boolean | null> };
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

function shaCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(bytes: Buffer, format: Format): ParsedContent {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 文件头无效');
  let cursor = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let channels = 0;
  const compressed: Buffer[] = [];
  while (cursor + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    const typeStart = cursor + 4;
    const dataStart = cursor + 8;
    if (length > bytes.length - cursor - 12) fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 数据块长度无效');
    const end = dataStart + length;
    const type = bytes.toString('ascii', typeStart, dataStart);
    const expectedCrc = bytes.readUInt32BE(end);
    if (shaCrc(bytes.subarray(typeStart, end)) !== expectedCrc)
      fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 校验值无效');
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) fail('UNSUPPORTED_MEDIA_TYPE', 'PNG IHDR 无效');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      if (!width || !height || width > 32768 || height > 32768 || width * height > 268_435_456)
        fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 尺寸无效');
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType!] ?? 0;
      if (
        bitDepth !== 8 ||
        !channels ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] !== 0
      )
        fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 使用尚未支持的像素格式');
      if (height * (width * channels + 1) > MAX_STORE_BYTES)
        fail('INPUT_TOO_LARGE', 'PNG 解码像素超出限制');
      sawHeader = true;
    } else if (type === 'IHDR') {
      fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 包含重复 IHDR');
    }
    if (type === 'IDAT') {
      sawData = true;
      compressed.push(bytes.subarray(dataStart, end));
    }
    cursor = end + 4;
    if (type === 'IEND') {
      if (length !== 0 || cursor !== bytes.length) fail('UNSUPPORTED_MEDIA_TYPE', 'PNG IEND 无效');
      sawEnd = true;
      break;
    }
  }
  if (!sawHeader || !sawData || !sawEnd) fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 结构不完整');
  const rowBytes = width * channels + 1;
  try {
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: height * rowBytes });
    if (
      pixels.length !== height * rowBytes ||
      Array.from({ length: height }, (_, row) => pixels[row * rowBytes]).some(
        (filter) => filter === undefined || filter > 4,
      )
    )
      fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 像素数据无效');
  } catch {
    fail('UNSUPPORTED_MEDIA_TYPE', 'PNG 压缩像素数据无效');
  }
  return { format, metadata: { container: 'png', width, height } };
}

function parseMp4(bytes: Buffer, format: Format): ParsedContent {
  return { format, metadata: validateMp4(bytes) };
}

function parseWav(bytes: Buffer, format: Format): ParsedContent {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    fail('UNSUPPORTED_MEDIA_TYPE', 'WAV 文件头无效');
  const riffEnd = bytes.readUInt32LE(4) + 8;
  if (riffEnd > bytes.length || riffEnd < 12) fail('UNSUPPORTED_MEDIA_TYPE', 'WAV 长度无效');
  let cursor = 12;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (cursor + 8 <= riffEnd) {
    const name = bytes.toString('ascii', cursor, cursor + 4);
    const size = bytes.readUInt32LE(cursor + 4);
    const dataStart = cursor + 8;
    if (size > riffEnd - dataStart) fail('UNSUPPORTED_MEDIA_TYPE', 'WAV 数据块长度无效');
    if (name === 'fmt ') {
      if (size < 16) fail('UNSUPPORTED_MEDIA_TYPE', 'WAV fmt 数据块无效');
      const audioFormat = bytes.readUInt16LE(dataStart);
      channels = bytes.readUInt16LE(dataStart + 2);
      sampleRate = bytes.readUInt32LE(dataStart + 4);
      byteRate = bytes.readUInt32LE(dataStart + 8);
      const blockAlign = bytes.readUInt16LE(dataStart + 12);
      bitsPerSample = bytes.readUInt16LE(dataStart + 14);
      if (
        ![1, 3].includes(audioFormat) ||
        !channels ||
        !sampleRate ||
        !byteRate ||
        !blockAlign ||
        !bitsPerSample
      )
        fail('UNSUPPORTED_MEDIA_TYPE', 'WAV 音频格式无效');
    } else if (name === 'data') {
      dataBytes = size;
    }
    cursor = dataStart + size + (size & 1);
  }
  if (!channels || !sampleRate || !byteRate || !bitsPerSample || !dataBytes)
    fail('UNSUPPORTED_MEDIA_TYPE', 'WAV 缺少可信音频元数据');
  return {
    format,
    metadata: {
      container: 'wav',
      channels,
      sampleRate,
      bitsPerSample,
      durationSeconds: Number((dataBytes / byteRate).toFixed(6)),
    },
  };
}

function parseContent(mimeType: string, bytes: Buffer): ParsedContent {
  const format = formats.get(mimeType.trim().toLowerCase());
  if (!format) fail('UNSUPPORTED_MEDIA_TYPE', '生成输出 MIME 类型不受支持');
  if (bytes.length < 1 || bytes.length > MAX_STORE_BYTES)
    fail('INPUT_TOO_LARGE', 'Artifact 超出 16 MiB 限制');
  switch (format.container) {
    case 'png':
      return parsePng(bytes, format);
    case 'mp4':
      return parseMp4(bytes, format);
    case 'wav':
      return parseWav(bytes, format);
    default:
      return fail('UNSUPPORTED_MEDIA_TYPE', '生成输出 MIME 类型不受支持');
  }
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

async function readSafeFile(
  root: string,
  relativeValue: string,
  maxBytes: number,
): Promise<Buffer> {
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

/** Main-only immutable generation output store. No absolute storage path leaves this class. */
export class GenerationArtifactStore implements GenerationArtifactPort {
  private readonly maxBytes: number;

  constructor(private readonly options: GenerationArtifactStoreOptions) {
    this.maxBytes = options.maxBytes ?? MAX_STORE_BYTES;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > MAX_STORE_BYTES
    )
      throw new RangeError('Generation artifact limit must be between 1 byte and 16 MiB');
    if (!options.userData || !path.isAbsolute(options.userData))
      throw new TypeError('GenerationArtifactStore requires Main userData');
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
      const existing = await readSafeFile(paths.root, bindingKey, 16 * 1024);
      const record = this.parseBinding(existing, task.id);
      if (!samePath(record.workspaceRoot, current))
        fail('WORKSPACE_CHANGED', 'Mission Workspace 根目录自任务首次绑定后发生变化');
      return;
    }
    try {
      await writeExclusive(pathInfo.target, Buffer.from(snapshot, 'utf8'));
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const existing = await readSafeFile(paths.root, bindingKey, 16 * 1024);
      const record = this.parseBinding(existing, task.id);
      if (!samePath(record.workspaceRoot, current))
        fail('WORKSPACE_CHANGED', 'Mission Workspace 根目录自任务首次绑定后发生变化');
    }
    const written = await readSafeFile(paths.root, bindingKey, 16 * 1024);
    if (!samePath(this.parseBinding(written, task.id).workspaceRoot, current))
      fail('WORKSPACE_CHANGED', 'Mission Workspace 根目录绑定未能持久化');
  }

  async resolveInput(
    binding: GenerationTask['inputs'][number],
    task: GenerationTask,
  ): Promise<GenerationResolvedInput> {
    if (!binding || typeof binding.artifactId !== 'string' || !binding.artifactId.trim())
      fail('ARTIFACT_INTEGRITY', '生成输入 Artifact identity 无效');
    const artifact = this.findArtifact(binding.artifactId);
    if (!artifact || artifact.id !== binding.artifactId)
      fail('ARTIFACT_INTEGRITY', '生成输入必须引用已登记的 generation_artifacts');
    const source = this.sourceTask(artifact);
    const format = formats.get(artifact.mimeType.toLowerCase());
    if (!format || artifact.extension.toLowerCase() !== format.extension)
      fail('UNSUPPORTED_MEDIA_TYPE', '输入 Artifact MIME 与扩展名不受支持');
    const key = safeRelativePath(artifact.storageKey).join('/');
    const expectedKey = outputStorageKey(source, artifact.id, format.extension);
    if (key !== expectedKey || artifact.id !== artifactId(artifact.jobId, artifact.outputId))
      fail('ARTIFACT_INTEGRITY', '输入 Artifact 存储 identity 无效');
    if (!['APP_ARTIFACT_STORE', 'MISSION_WORKSPACE'].includes(artifact.storageScope))
      fail('ARTIFACT_INTEGRITY', '输入 Artifact 存储域无效');
    const root = await this.rootForArtifact(source);
    const resolved = await resolveSafeFile(root, key, false);
    if (!resolved.exists) fail('ARTIFACT_INTEGRITY', '生成输入文件不存在');
    if (artifact.storageScope === 'MISSION_WORKSPACE')
      await this.options.authorize(
        task,
        'FILE_READ',
        this.permissionResource(root, resolved.target),
      );
    // Permission must be granted before opening or hashing Workspace content.
    const bytes = await readSafeFile(root, key, this.maxBytes);
    const parsed = parseContent(format.mimeType, bytes);
    this.verifyArtifactFacts(artifact, source, bytes, parsed);
    return {
      artifactId: artifact.id,
      role: binding.role,
      kind: artifact.kind,
      mimeType: format.mimeType,
      contentHash: artifact.contentHash,
      bytes: Uint8Array.from(bytes),
    };
  }

  async commit(
    job: GenerationJob,
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    download: () => Promise<Uint8Array>,
  ): Promise<GenerationArtifact> {
    if (job.generationTaskId !== task.id)
      fail('ARTIFACT_INTEGRITY', 'Job 与 GenerationTask 不匹配');
    this.validateTaskDestination(task);
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
      const existing = await readSafeFile(root, key, this.maxBytes);
      const parsed = this.validateOutputBytes(existing, task, descriptor, output, format);
      this.options.crash?.('COMMITTED', job);
      return this.makeArtifact(job, task, output, id, format, key, existing, parsed.metadata);
    }

    const privateStageKey = `staging/${hashName(job.id)}/${hashName(output.id)}${format.extension}.stage`;
    const privateStagePath = await this.writeOrReuseStage(
      paths,
      privateStageKey,
      task,
      descriptor,
      output,
      format,
      download,
    );
    const stageBytes = await readSafeFile(paths.root, privateStageKey, this.maxBytes);
    this.validateOutputBytes(stageBytes, task, descriptor, output, format);
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
    let publishFrom = privateStagePath;
    if (task.outputDestination.scope === 'MISSION_WORKSPACE') {
      const workspaceStageKey = `.generation-artifact-staging/${hashName(task.id)}/${hashName(output.id)}${format.extension}.stage`;
      publishFrom = await this.writeWorkspaceStage(
        currentRoot,
        workspaceStageKey,
        stageBytes,
        task,
        descriptor,
        output,
        format,
      );
    }
    try {
      await link(publishFrom, final.target);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST')
        fail('ARTIFACT_COMMIT_FAILED', 'Artifact 无法以原子 no-overwrite 方式提交');
    }
    const committed = await resolveSafeFile(currentRoot, key, false);
    if (!committed.exists) fail('ARTIFACT_COMMIT_FAILED', 'Artifact commit 未产生正式文件');
    const committedBytes = await readSafeFile(currentRoot, key, this.maxBytes);
    const committedFacts = this.validateOutputBytes(
      committedBytes,
      task,
      descriptor,
      output,
      format,
    );
    this.options.crash?.('COMMITTED', job);
    return this.makeArtifact(
      job,
      task,
      output,
      id,
      format,
      key,
      committedBytes,
      committedFacts.metadata,
    );
  }

  async verify(artifact: GenerationArtifact, task: GenerationTask): Promise<void> {
    if (!artifact || artifact.storageScope !== task.outputDestination.scope)
      fail('ARTIFACT_INTEGRITY', '已登记 Artifact 存储域与任务不一致');
    const source = this.sourceTask(artifact);
    if (source.id !== task.id || artifact.id !== artifactId(artifact.jobId, artifact.outputId))
      fail('ARTIFACT_INTEGRITY', '已登记 Artifact identity 与任务不一致');
    await this.validateDestination(task);
    const format = formats.get(artifact.mimeType.toLowerCase());
    if (!format || artifact.extension.toLowerCase() !== format.extension)
      fail('UNSUPPORTED_MEDIA_TYPE', '已登记 Artifact MIME 与扩展名无效');
    const expectedKey = outputStorageKey(task, artifact.id, format.extension);
    const key = safeRelativePath(artifact.storageKey).join('/');
    if (key !== expectedKey) fail('ARTIFACT_INTEGRITY', '已登记 Artifact storageKey 无效');
    const root = await this.rootForArtifact(task);
    const resolved = await resolveSafeFile(root, key, false);
    if (!resolved.exists) fail('ARTIFACT_INTEGRITY', '已登记 Artifact 文件不存在');
    if (artifact.storageScope === 'MISSION_WORKSPACE')
      // Same-task recovery verifies an output under its original FILE_WRITE grant.
      await this.options.authorize(
        task,
        'FILE_WRITE',
        this.permissionResource(root, resolved.target),
      );
    const bytes = await readSafeFile(root, key, this.maxBytes);
    const parsed = parseContent(format.mimeType, bytes);
    this.verifyArtifactFacts(artifact, task, bytes, parsed);
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
    const bytes = await readSafeFile(paths.root, key, 16 * 1024);
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
      // eslint-disable-next-line no-control-regex -- Provider IDs must contain no control bytes.
      /[\u0000-\u001f\u007f]/u.test(output.id) ||
      typeof output.mimeType !== 'string' ||
      typeof output.extension !== 'string'
    )
      fail('OUTPUT_MISSING', 'Provider output identity 无效');
    const mimeType = output.mimeType.trim().toLowerCase();
    const format = formats.get(mimeType);
    if (
      !format ||
      !descriptor.outputTypes.some((m) => matchesMime(m, format)) ||
      !task.expectedOutput.mimeTypes.some((m) => matchesMime(m, format))
    )
      fail('UNSUPPORTED_MEDIA_TYPE', 'Provider 输出 MIME 类型不符合模型与任务契约');
    if (output.extension.toLowerCase() !== format.extension)
      fail('UNSUPPORTED_MEDIA_TYPE', 'Provider 输出扩展名与 MIME 类型不一致');
    if (
      !Number.isSafeInteger(descriptor.limits.maxOutputBytes) ||
      descriptor.limits.maxOutputBytes < 1 ||
      !Number.isSafeInteger(output.sizeBytes) ||
      output.sizeBytes < 1 ||
      output.sizeBytes > Math.min(this.maxBytes, descriptor.limits.maxOutputBytes)
    )
      fail('INPUT_TOO_LARGE', 'Provider 输出超过安全大小限制');
    if (!safeHash(output.contentHash)) fail('ARTIFACT_INTEGRITY', 'Provider 输出 hash 格式无效');
    return format;
  }

  private validateOutputBytes(
    bytes: Buffer,
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    format: Format,
  ): ParsedContent {
    if (bytes.length !== output.sizeBytes || digest(bytes) !== output.contentHash.toLowerCase())
      fail('ARTIFACT_INTEGRITY', 'Provider 输出 size/hash 与下载内容不一致');
    const parsed = parseContent(format.mimeType, bytes);
    validateProviderClaims(output.metadata, parsed.metadata);
    if (
      !task.expectedOutput.mimeTypes.some((m) => matchesMime(m, parsed.format)) ||
      !descriptor.outputTypes.some((m) => matchesMime(m, parsed.format))
    )
      fail('UNSUPPORTED_MEDIA_TYPE', '文件内容 MIME 不符合生成输出契约');
    return parsed;
  }

  private async writeOrReuseStage(
    paths: StorePaths,
    key: string,
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    format: Format,
    download: () => Promise<Uint8Array>,
  ): Promise<string> {
    const existing = await resolveSafeFile(paths.root, key, true);
    if (existing.exists) {
      const bytes = await readSafeFile(paths.root, key, this.maxBytes);
      this.validateOutputBytes(bytes, task, descriptor, output, format);
      return existing.target;
    }
    const downloaded = await download();
    if (!(downloaded instanceof Uint8Array) || downloaded.byteLength > this.maxBytes)
      fail('INPUT_TOO_LARGE', 'Provider 下载内容超过安全大小限制');
    const bytes = Buffer.from(downloaded);
    this.validateOutputBytes(bytes, task, descriptor, output, format);
    try {
      await writeExclusive(existing.target, bytes);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const staged = await readSafeFile(paths.root, key, this.maxBytes);
    this.validateOutputBytes(staged, task, descriptor, output, format);
    return existing.target;
  }

  private async writeWorkspaceStage(
    root: string,
    key: string,
    bytes: Buffer,
    task: GenerationTask,
    descriptor: GenerationModelDescriptor,
    output: GenerationOutputDescriptor,
    format: Format,
  ): Promise<string> {
    const existing = await resolveSafeFile(root, key, true);
    if (existing.exists) {
      const current = await readSafeFile(root, key, this.maxBytes);
      this.validateOutputBytes(current, task, descriptor, output, format);
      return existing.target;
    }
    try {
      await writeExclusive(existing.target, bytes);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const staged = await readSafeFile(root, key, this.maxBytes);
    this.validateOutputBytes(staged, task, descriptor, output, format);
    return existing.target;
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
    bytes: Buffer,
    parsed: ParsedContent,
  ): void {
    if (
      artifact.kind !== source.expectedOutput.artifactKind ||
      artifact.storageScope !== source.outputDestination.scope ||
      artifact.mimeType.toLowerCase() !== parsed.format.mimeType ||
      artifact.extension.toLowerCase() !== parsed.format.extension ||
      artifact.sizeBytes !== bytes.length ||
      artifact.contentHash !== digest(bytes) ||
      !sameMetadata(artifact.metadata, parsed.metadata)
    )
      fail('ARTIFACT_INTEGRITY', '登记的 generation_artifacts 与文件内容不一致');
  }

  private makeArtifact(
    job: GenerationJob,
    task: GenerationTask,
    output: GenerationOutputDescriptor,
    id: string,
    format: Format,
    storageKey: string,
    bytes: Buffer,
    metadata: Record<string, number | string | boolean | null>,
  ): GenerationArtifact {
    return {
      id,
      jobId: job.id,
      outputId: output.id,
      kind: task.expectedOutput.artifactKind,
      mimeType: format.mimeType,
      extension: format.extension,
      sizeBytes: bytes.length,
      contentHash: digest(bytes),
      metadata,
      storageScope: task.outputDestination.scope,
      storageKey,
      createdAt: task.createdAt,
    };
  }
}
