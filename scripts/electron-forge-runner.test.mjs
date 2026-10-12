import { describe, expect, it } from 'vitest';
import {
  isForgeTemporaryBinCleanupGlob,
  normalizeForgeFastGlobCall,
  copyContainedPackagerTemplate,
} from './electron-forge-runner.mjs';

const forgePackageFilename = 'E:/project/node_modules/@electron-forge/core/dist/api/package.js';
const buildPath = 'R:\\.tmp\\electron-forge-123';
const cleanupGlob = buildPath + '\\**\\.bin\\**\\*';

function normalize(patterns, overrides = {}) {
  return normalizeForgeFastGlobCall({
    request: 'fast-glob',
    parentFilename: forgePackageFilename,
    forgePackageFilename,
    patterns,
    platform: 'win32',
    ...overrides,
  });
}

describe('Electron Forge Windows cleanup glob compatibility', () => {
  it('recognizes and normalizes only the absolute temporary .bin cleanup glob', () => {
    expect(isForgeTemporaryBinCleanupGlob(cleanupGlob)).toBe(true);
    expect(normalize(cleanupGlob)).toBe('R:/.tmp/electron-forge-123/**/.bin/**/*');
  });

  it('normalizes matching members of an array while preserving other patterns', () => {
    expect(normalize([cleanupGlob, 'relative/**/*.js'])).toEqual([
      'R:/.tmp/electron-forge-123/**/.bin/**/*',
      'relative/**/*.js',
    ]);
  });

  it('does not alter unrelated Forge globs, modules, callers, or non-Windows calls', () => {
    const unrelated = buildPath + '\\**\\*.js';
    expect(normalize(unrelated)).toBe(unrelated);
    expect(normalize(cleanupGlob, { request: 'other-module' })).toBe(cleanupGlob);
    expect(normalize(cleanupGlob, { parentFilename: 'E:/other/package.js' })).toBe(cleanupGlob);
    expect(normalize(cleanupGlob, { platform: 'linux' })).toBe(cleanupGlob);
  });
});

describe('project-contained Packager staging', () => {
  const root = 'E:/project';
  const destination = 'E:/project/.tmp/package-temp/electron-packager/tmp-fixture/resources/app';
  it('copies only children accepted by the existing Packager filter', async () => {
    const copied = [];
    const io = {
      ensureDir: async () => {},
      readdir: async () => ['.vite', 'node_modules', '.tmp', 'private'],
      copy: async (source, target, options) => copied.push({ source, target, options }),
    };
    const options = {
      filter: (source) => !/[\\/](?:\.tmp|private)$/.test(source),
      dereference: true,
    };
    await copyContainedPackagerTemplate(io, root, destination, options, root);
    expect(copied.map((value) => value.source.replaceAll('\\', '/'))).toEqual([
      'E:/project/.vite',
      'E:/project/node_modules',
    ]);
    expect(copied.every((value) => value.options === options)).toBe(true);
  });
  it('fails closed if the filter includes its own staging tree', async () => {
    let copies = 0;
    const io = {
      ensureDir: async () => {},
      readdir: async () => ['.tmp'],
      copy: async () => copies++,
    };
    await expect(
      copyContainedPackagerTemplate(io, root, destination, { filter: () => true }, root),
    ).rejects.toThrow('exclude its contained staging');
    expect(copies).toBe(0);
  });
  it('leaves other destinations and sources on the original copy implementation', async () => {
    const calls = [];
    const io = { copy: async (...args) => calls.push(args) };
    const options = { filter: () => true };
    await copyContainedPackagerTemplate(io, root, 'E:/outside/app', options, root);
    await copyContainedPackagerTemplate(io, 'E:/other', destination, options, root);
    expect(calls).toHaveLength(2);
  });
});
