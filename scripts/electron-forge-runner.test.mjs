import { describe, expect, it } from 'vitest';
import {
  isForgeTemporaryBinCleanupGlob,
  normalizeForgeFastGlobCall,
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
