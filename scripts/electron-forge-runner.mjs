import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function isWindowsAbsoluteGlob(pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
}

function isForgeTemporaryBinCleanupGlob(pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  return isWindowsAbsoluteGlob(pattern) && normalized.endsWith('/**/.bin/**/*');
}

function normalizeForgeFastGlobCall({
  request,
  parentFilename,
  forgePackageFilename,
  patterns,
  platform,
}) {
  if (platform !== 'win32' || request !== 'fast-glob' || parentFilename !== forgePackageFilename) {
    return patterns;
  }

  const normalizeOne = (pattern) =>
    typeof pattern === 'string' && isForgeTemporaryBinCleanupGlob(pattern)
      ? pattern.replaceAll('\\', '/')
      : pattern;

  return Array.isArray(patterns) ? patterns.map(normalizeOne) : normalizeOne(patterns);
}

function installForgeGlobCompatibility() {
  const forgePackageFilename = require.resolve('@electron-forge/core/dist/api/package.js');
  const originalLoad = Module._load;
  Module._load = function loadWithForgeGlobCompatibility(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request !== 'fast-glob' || parent?.filename !== forgePackageFilename) return loaded;

    return new Proxy(loaded, {
      apply(target, thisArg, args) {
        const nextArgs = [...args];
        nextArgs[0] = normalizeForgeFastGlobCall({
          request,
          parentFilename: parent.filename,
          forgePackageFilename,
          patterns: nextArgs[0],
          platform: process.platform,
        });
        return Reflect.apply(target, thisArg, nextArgs);
      },
    });
  };
}

function runForgeCli(args) {
  const forgeEntry = require.resolve('@electron-forge/core');
  const forgePackageJson = path.resolve(path.dirname(forgeEntry), '../../package.json');
  const forgeVersion = JSON.parse(fs.readFileSync(forgePackageJson, 'utf8')).version;

  if (process.platform === 'win32' && forgeVersion !== '7.11.2') {
    throw new Error(
      'The Windows temporary-glob compatibility is verified for Electron Forge 7.11.2; found ' +
        forgeVersion +
        '. Update the scoped compatibility test before changing Forge versions.',
    );
  }

  if (process.platform === 'win32') {
    installForgeGlobCompatibility();
    console.log(
      '[build] Applying scoped Electron Forge 7.11.2 Windows temporary-path glob compatibility.',
    );
  }

  const cliPath = require.resolve('@electron-forge/cli/dist/electron-forge.js');
  process.argv = [process.execPath, cliPath, ...args];
  require(cliPath);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runForgeCli(process.argv.slice(2));
}

export { isForgeTemporaryBinCleanupGlob, normalizeForgeFastGlobCall };
