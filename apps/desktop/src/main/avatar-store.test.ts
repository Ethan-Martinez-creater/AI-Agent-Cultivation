import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AvatarStore, AVATAR_MAX_BYTES, validateAvatarInput } from './avatar-store.js';

const preset = readFileSync(
  join(process.cwd(), 'apps/desktop/src/renderer/src/assets/avatars/01.png'),
);
const folder = () => {
  const root = join(process.cwd(), '.test-data', `avatars-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
};

describe('Main-only avatar import', () => {
  it('persists normalized pixels with an opaque reference and reloads after restart', () => {
    const root = folder();
    const selected = join(root, 'source.png');
    writeFileSync(selected, preset);
    let normalized = 0;
    const first = new AvatarStore(join(root, 'user-data'), (bytes) => {
      expect(bytes.equals(preset)).toBe(true);
      normalized++;
      return preset;
    });
    const ref = first.importSelectedFile(selected);
    expect(ref).toMatch(/^local:[0-9a-f-]+\.png$/);
    expect(ref).not.toContain(root);
    expect(normalized).toBe(1);
    const restarted = new AvatarStore(join(root, 'user-data'), () => preset);
    expect(restarted.read(ref)).toBe(`data:image/png;base64,${preset.toString('base64')}`);
  });
  it('rejects arbitrary renderer paths and URLs instead of resolving them', () => {
    const store = new AvatarStore(folder(), () => preset);
    for (const ref of [
      '../secret.png',
      'file:///C:/secret.png',
      'https://example.com/a.png',
      'local:../../secret.png',
      'preset:01',
    ]) {
      expect(() => store.read(ref)).toThrow('Invalid avatar reference');
    }
    expect(store.read('local:00000000-0000-4000-8000-000000000000.png')).toBeNull();
  });
  it('fails closed on invalid encoded input and invalid decoder output', () => {
    const root = folder();
    const source = join(root, 'fake.png');
    writeFileSync(source, '<html>not an image</html>');
    let decoded = false;
    const store = new AvatarStore(join(root, 'data'), () => {
      decoded = true;
      return preset;
    });
    expect(() => store.importSelectedFile(source)).toThrow();
    expect(decoded).toBe(false);
    writeFileSync(source, preset);
    const invalidDecoder = new AvatarStore(join(root, 'invalid-output'), () => Buffer.alloc(30));
    expect(() => invalidDecoder.importSelectedFile(source)).toThrow();
  });
  it('accepts PNG dimensions and rejects SVG, mismatched formats, excessive size and oversized dimensions', () => {
    expect(() => validateAvatarInput(preset, '.PNG')).not.toThrow();
    expect(() => validateAvatarInput(preset, '.jpeg')).toThrow();
    expect(() =>
      validateAvatarInput(Buffer.from('<svg width="256" height="256"></svg>'), '.svg'),
    ).toThrow();
    expect(() => validateAvatarInput(Buffer.alloc(AVATAR_MAX_BYTES + 1), '.png')).toThrow();
    const oversized = Buffer.from(preset);
    oversized.writeUInt32BE(2049, 16);
    expect(() => validateAvatarInput(oversized, '.png')).toThrow();
  });
  it('bounds JPEG frame parsing and recognizes supported WebP headers', () => {
    const jpeg = Buffer.alloc(32);
    jpeg.set([255, 216, 255, 192, 0, 17, 8, 0, 32, 0, 32]);
    expect(() => validateAvatarInput(jpeg, '.jpg')).not.toThrow();
    jpeg.writeUInt16BE(2, 4);
    expect(() => validateAvatarInput(jpeg, '.jpg')).toThrow('Invalid JPEG frame');
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.writeUInt32LE(22, 4);
    webp.write('WEBPVP8X', 8);
    webp.writeUIntLE(255, 24, 3);
    webp.writeUIntLE(255, 27, 3);
    expect(() => validateAvatarInput(webp, '.webp')).not.toThrow();
    webp.writeUIntLE(2048, 24, 3);
    expect(() => validateAvatarInput(webp, '.webp')).toThrow();
  });
});
