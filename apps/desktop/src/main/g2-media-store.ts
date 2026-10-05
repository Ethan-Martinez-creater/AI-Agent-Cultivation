import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { DomainError } from '@cultivation/shared';
import type {
  GenerationBinarySource,
  GenerationResolvedInput,
} from '@cultivation/application/g1-generation';
import { GenerationCrash } from '@cultivation/application/g1-generation';
import {
  GENERATION_MEDIA_POLICY,
  getGenerationMediaCeilingBytes,
} from '@cultivation/application/g1-media-policy';
import { validateGenerationMedia, type GenerationMediaReader } from './g1-media-validator.js';

export interface GenerationAttachment {
  id: string;
  kind: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
  name: string;
}
type StoredInput = GenerationAttachment & {
  storageKey: string;
  metadata: Record<string, number | string | boolean | null>;
};
type CachedMedia = { sizeBytes: number; contentHash: string; source: GenerationBinarySource };
function fail(code: string): never {
  throw new DomainError(code, '媒体文件未通过安全校验');
}
const digestKey = (value: string) => createHash('sha256').update(value).digest('hex');
const formats: Record<string, { mime: string; kind: string }> = {
  '.png': { mime: 'image/png', kind: 'IMAGE' },
  '.mp4': { mime: 'video/mp4', kind: 'VIDEO' },
  '.wav': { mime: 'audio/wav', kind: 'AUDIO' },
};
function inside(root: string, value: string): boolean {
  const rel = path.relative(root, value);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}
async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Uint8Array) {
  let cursor = 0;
  while (cursor < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, cursor, chunk.byteLength - cursor);
    if (bytesWritten === 0) fail('ARTIFACT_COMMIT_FAILED');
    cursor += bytesWritten;
  }
}

/** Main-owned storage. Only opaque identity and a bounded readable capability leave this class. */
export class GenerationMediaStore {
  constructor(
    private readonly userData: string,
    private readonly db: Database.Database,
  ) {}
  private async directory(section: 'inputs' | 'cache'): Promise<string> {
    const root = await realpath(this.userData);
    let current = root;
    for (const component of ['generation-media', section]) {
      current = path.join(current, component);
      await mkdir(current, { recursive: false }).catch((e: unknown) => {
        if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e;
      });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await realpath(current)))
        fail('INVALID_OUTPUT_PATH');
    }
    return current;
  }
  private async reader(file: string): Promise<GenerationMediaReader> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_INPUT');
    const check = async (handle: Awaited<ReturnType<typeof open>>) => {
      const [current, opened] = await Promise.all([lstat(file), handle.stat()]);
      if (
        current.isSymbolicLink() ||
        [current, opened].some(
          (s) =>
            s.ino !== stat.ino ||
            s.dev !== stat.dev ||
            s.size !== stat.size ||
            s.mtimeMs !== stat.mtimeMs ||
            s.ctimeMs !== stat.ctimeMs,
        )
      )
        fail('INPUT_CHANGED');
    };
    return {
      sizeBytes: stat.size,
      read: async (offset, length) => {
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > GENERATION_MEDIA_POLICY.ioChunkBytes
        )
          fail('INVALID_INPUT');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await check(handle);
          const data = Buffer.alloc(length);
          const result = await handle.read(data, 0, length, offset);
          await check(handle);
          return data.subarray(0, result.bytesRead);
        } finally {
          await handle.close();
        }
      },
      chunks: async function* (offset = 0, length = stat.size - offset) {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await check(handle);
          let cursor = offset;
          while (cursor < offset + length) {
            const chunk = Buffer.alloc(
              Math.min(GENERATION_MEDIA_POLICY.ioChunkBytes, offset + length - cursor),
            );
            const result = await handle.read(chunk, 0, chunk.length, cursor);
            if (!result.bytesRead) fail('INPUT_CHANGED');
            cursor += result.bytesRead;
            yield chunk.subarray(0, result.bytesRead);
          }
          await check(handle);
        } finally {
          await handle.close();
        }
      },
    };
  }
  private source(
    file: string,
    expected: { sizeBytes: number; contentHash: string },
  ): GenerationBinarySource {
    const abort = new AbortController();
    const readMedia = (value: string) => this.reader(value);
    return {
      cancel: (reason) => abort.abort(reason),
      open: async function* (signal) {
        const reader = await readMedia(file);
        if (reader.sizeBytes !== expected.sizeBytes) fail('INPUT_CHANGED');
        const hash = createHash('sha256');
        let count = 0;
        for await (const chunk of reader.chunks()) {
          if (abort.signal.aborted || signal?.aborted) fail('GENERATION_CANCELLED');
          hash.update(chunk);
          count += chunk.byteLength;
          yield chunk;
        }
        if (count !== expected.sizeBytes || hash.digest('hex') !== expected.contentHash)
          fail('INPUT_CHANGED');
      },
    };
  }
  private async inspect(file: string, mime: string, direction: 'input' | 'output') {
    const reader = await this.reader(file);
    if (reader.sizeBytes > (getGenerationMediaCeilingBytes('', mime, direction) ?? 0))
      fail('INPUT_TOO_LARGE');
    const hash = createHash('sha256');
    for await (const chunk of reader.chunks()) hash.update(chunk);
    const metadata = await validateGenerationMedia(mime, reader);
    return { sizeBytes: reader.sizeBytes, contentHash: hash.digest('hex'), metadata };
  }
  list(): GenerationAttachment[] {
    return (
      this.db
        .prepare('SELECT * FROM generation_input_artifacts ORDER BY created_at DESC,id')
        .all() as Array<Record<string, unknown>>
    ).map((r) => this.map(r));
  }
  private map(r: Record<string, unknown>): GenerationAttachment {
    return {
      id: String(r.id),
      kind: String(r.kind),
      mimeType: String(r.mime_type),
      contentHash: String(r.content_hash),
      sizeBytes: Number(r.size_bytes),
      name: String(r.name),
    };
  }
  get(id: string): StoredInput | null {
    const r = this.db.prepare('SELECT * FROM generation_input_artifacts WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r
      ? {
          ...this.map(r),
          storageKey: String(r.storage_key),
          metadata: JSON.parse(String(r.metadata_json)),
        }
      : null;
  }
  async importSelectedFile(selected: string): Promise<GenerationAttachment> {
    // The caller obtains selected exclusively from Electron's explicit native picker.
    const stat = await lstat(selected);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_INPUT');
    const format = formats[path.extname(selected).toLowerCase()];
    if (!format) fail('UNSUPPORTED_MEDIA_TYPE');
    if (stat.size > (getGenerationMediaCeilingBytes('', format.mime, 'input') ?? 0))
      fail('INPUT_TOO_LARGE');
    const root = await this.directory('inputs');
    const id = randomUUID();
    const key = `${id}${path.extname(selected).toLowerCase()}`;
    const partial = path.join(root, `${id}.partial`);
    const target = path.join(root, key);
    const input = await this.reader(await realpath(selected));
    const output = await open(partial, 'wx');
    try {
      for await (const chunk of input.chunks()) await writeAll(output, chunk);
      await output.sync();
    } finally {
      await output.close();
    }
    const after = await lstat(selected);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino)
      fail('INPUT_CHANGED');
    const checked = await this.inspect(partial, format.mime, 'input');
    await link(partial, target);
    const name = path.basename(selected).slice(0, 200);
    this.db
      .prepare(
        'INSERT INTO generation_input_artifacts(id,kind,mime_type,content_hash,size_bytes,name,storage_key,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        format.kind,
        format.mime,
        checked.contentHash,
        checked.sizeBytes,
        name,
        key,
        JSON.stringify(checked.metadata),
        new Date().toISOString(),
      );
    return {
      id,
      kind: format.kind,
      mimeType: format.mime,
      contentHash: checked.contentHash,
      sizeBytes: checked.sizeBytes,
      name,
    };
  }
  async resolveInput(id: string, role: string): Promise<GenerationResolvedInput> {
    const input = this.get(id);
    if (!input) fail('NOT_FOUND');
    if (!/^[a-z0-9-]+\.(png|mp4|wav)$/i.test(input.storageKey)) fail('INVALID_INPUT');
    const root = await this.directory('inputs');
    const file = path.join(root, input.storageKey);
    const canonical = await realpath(file);
    if (!inside(root, canonical)) fail('INVALID_INPUT');
    const checked = await this.inspect(canonical, input.mimeType, 'input');
    if (checked.sizeBytes !== input.sizeBytes || checked.contentHash !== input.contentHash)
      fail('INPUT_CHANGED');
    return {
      artifactId: input.id,
      role,
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      contentHash: input.contentHash,
      source: this.source(canonical, input),
    };
  }
  private cacheKey(runtime: string, job: string, output: string) {
    return digestKey(`${runtime}\0${job}\0${output}`);
  }
  async lookup(runtime: string, job: string, output: string): Promise<CachedMedia | null> {
    const root = await this.directory('cache');
    const key = this.cacheKey(runtime, job, output);
    const file = path.join(root, `${key}.mp4`);
    let meta: { sizeBytes: number; contentHash: string };
    try {
      const metaFile = path.join(root, `${key}.json`);
      const stat = await lstat(metaFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) fail('INVALID_OUTPUT');
      const handle = await open(metaFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.ino !== stat.ino || opened.size !== stat.size) fail('INVALID_OUTPUT');
        meta = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
      } finally {
        await handle.close();
      }
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null;
      throw e;
    }
    if (
      !Number.isSafeInteger(meta.sizeBytes) ||
      meta.sizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(meta.contentHash)
    )
      fail('INVALID_OUTPUT');
    const checked = await this.inspect(file, 'video/mp4', 'output');
    if (checked.sizeBytes !== meta.sizeBytes || checked.contentHash !== meta.contentHash)
      fail('OUTPUT_HASH_MISMATCH');
    return { ...meta, source: this.source(file, meta) };
  }
  async capture(input: {
    runtimeProfileId: string;
    providerJobId: string;
    outputId: string;
    mimeType: string;
    advertisedSize: number | null;
    source: GenerationBinarySource;
    signal?: AbortSignal;
  }): Promise<CachedMedia> {
    const cached = await this.lookup(input.runtimeProfileId, input.providerJobId, input.outputId);
    if (cached) {
      await input.source.cancel();
      return cached;
    }
    if (input.mimeType !== 'video/mp4') fail('UNSUPPORTED_MEDIA_TYPE');
    const root = await this.directory('cache');
    const key = this.cacheKey(input.runtimeProfileId, input.providerJobId, input.outputId);
    const partial = path.join(root, `${key}-${randomUUID()}.partial`);
    const target = path.join(root, `${key}.mp4`);
    const handle = await open(partial, 'wx');
    let count = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of input.source.open(input.signal)) {
        count += chunk.byteLength;
        if (
          chunk.byteLength > GENERATION_MEDIA_POLICY.maxSourceChunkBytes ||
          count > (getGenerationMediaCeilingBytes('', input.mimeType, 'output') ?? 0) ||
          (input.advertisedSize !== null && count > input.advertisedSize)
        )
          fail('OUTPUT_TOO_LARGE');
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
    } catch (e) {
      await input.source.cancel(e);
      if (e instanceof DomainError) throw e;
      throw new GenerationCrash('原 Provider 输出下载中断，partial 不可注册');
    } finally {
      await handle.close();
    }
    if (input.advertisedSize !== null && count !== input.advertisedSize)
      fail('OUTPUT_SIZE_MISMATCH');
    const contentHash = hash.digest('hex');
    const reader = await this.reader(partial);
    await validateGenerationMedia(input.mimeType, reader);
    try {
      await link(partial, target);
    } catch (e) {
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e;
      const check = await this.inspect(target, input.mimeType, 'output');
      if (check.contentHash !== contentHash || check.sizeBytes !== count)
        fail('OUTPUT_HASH_MISMATCH');
    }
    const meta = { sizeBytes: count, contentHash };
    const metaPartial = path.join(root, `${key}-${randomUUID()}.json.partial`);
    const metaHandle = await open(metaPartial, 'wx');
    try {
      await metaHandle.writeFile(JSON.stringify(meta), 'utf8');
      await metaHandle.sync();
    } finally {
      await metaHandle.close();
    }
    try {
      await link(metaPartial, path.join(root, `${key}.json`));
    } catch (e) {
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST')) throw e;
    }
    return { sizeBytes: count, contentHash, source: this.source(target, meta) };
  }
}
