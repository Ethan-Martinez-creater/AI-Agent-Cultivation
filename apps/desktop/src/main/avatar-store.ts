import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 2048;
const localRef =
  /^local:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.png$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readBoundedImage(filePath: string): Buffer {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > AVATAR_MAX_BYTES) throw new Error('Invalid avatar size');
    const result = Buffer.alloc(AVATAR_MAX_BYTES + 1);
    let read = 0;
    while (read < result.length) {
      const count = readSync(descriptor, result, read, result.length - read, null);
      if (!count) break;
      read += count;
    }
    if (read > AVATAR_MAX_BYTES) throw new Error('Invalid avatar size');
    return result.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function contained(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta !== '' && !isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`);
}

/** Validate encoded dimensions before asking the native decoder to allocate pixels. */
export function validateAvatarInput(bytes: Buffer, extension: string): void {
  if (bytes.length < 24 || bytes.length > AVATAR_MAX_BYTES) throw new Error('Invalid avatar size');
  let width = 0;
  let height = 0;
  const ext = extension.toLowerCase();
  if (
    ext === '.png' &&
    bytes.subarray(0, 8).equals(PNG) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (['.jpg', '.jpeg'].includes(ext) && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 8 < bytes.length) {
      if (bytes[cursor] !== 0xff) throw new Error('Invalid JPEG');
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(cursor);
      if (length < 2 || cursor + length > bytes.length) throw new Error('Invalid JPEG segment');
      if (marker !== undefined && [0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw new Error('Invalid JPEG frame');
        height = bytes.readUInt16BE(cursor + 3);
        width = bytes.readUInt16BE(cursor + 5);
        break;
      }
      cursor += length;
    }
  } else if (
    ext === '.webp' &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (
      chunk === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE)
    throw new Error('Unsupported avatar image');
}

/** Main-only asset store. Persist normalized PNG pixels, never source paths or metadata. */
export class AvatarStore {
  private readonly directory: string;
  constructor(
    userData: string,
    private readonly normalize: (bytes: Buffer) => Buffer,
  ) {
    mkdirSync(userData, { recursive: true });
    const userRoot = realpathSync(userData);
    const folder = join(userRoot, 'avatars');
    mkdirSync(folder, { recursive: true });
    if (lstatSync(folder).isSymbolicLink()) throw new Error('Invalid avatar directory');
    this.directory = realpathSync(folder);
    if (!contained(userRoot, this.directory)) throw new Error('Avatar directory escaped userData');
  }
  importSelectedFile(filePath: string): string {
    if (!isAbsolute(filePath) || !lstatSync(filePath).isFile())
      throw new Error('Invalid selected image');
    const bytes = readBoundedImage(filePath);
    validateAvatarInput(bytes, extname(filePath));
    const png = this.normalize(bytes);
    validateAvatarInput(png, '.png');
    const assetId = randomUUID();
    writeFileSync(join(this.directory, `${assetId}.png`), png, { flag: 'wx', mode: 0o600 });
    return `local:${assetId}.png`;
  }
  read(ref: string): string | null {
    const match = localRef.exec(ref);
    if (!match) throw new Error('Invalid avatar reference');
    const file = join(this.directory, `${match[1]}.png`);
    try {
      if (lstatSync(file).isSymbolicLink() || !contained(this.directory, realpathSync(file)))
        throw new Error('Invalid avatar path');
      const bytes = readBoundedImage(file);
      validateAvatarInput(bytes, '.png');
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
