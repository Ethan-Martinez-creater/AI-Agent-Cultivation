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

function installContainedPackagerCompatibility() {
  const directory = path.dirname(require.resolve('@electron/packager'));
  const version = require(path.join(directory, '..', 'package.json')).version;
  if (version !== '18.4.4')
    throw new Error('Contained staging compatibility requires Packager 18.4.4');
  const platformFile = path.join(directory, 'platform.js');
  const localRequire = createRequire(platformFile);
  const { App } = require(platformFile);
  const io = localRequire('fs-extra');
  const { userPathFilter } = require(path.join(directory, 'copy-filter.js'));
  const { promisifyHooks } = require(path.join(directory, 'hooks.js'));
  const original = App.prototype.copyTemplate;
  App.prototype.copyTemplate = async function copyTemplateWithContainedStaging() {
    const rel = path
      .relative(path.resolve(this.opts.dir), this.originalResourcesAppDir)
      .replaceAll('\\', '/');
    if (!/^\.tmp\/[^/]+\/electron-packager\/tmp-[^/]+\/resources\/app$/.test(rel))
      return original.call(this);
    await promisifyHooks(this.opts.beforeCopy, this.hookArgsWithOriginalResourcesAppDir);
    await copyContainedPackagerTemplate(
      io,
      this.opts.dir,
      this.originalResourcesAppDir,
      {
        filter: userPathFilter(this.opts),
        dereference: this.opts.derefSymlinks,
      },
      process.cwd(),
    );
    await promisifyHooks(this.opts.afterCopy, this.hookArgsWithOriginalResourcesAppDir);
    if (this.opts.prune)
      await promisifyHooks(this.opts.afterPrune, this.hookArgsWithOriginalResourcesAppDir);
  };
}

// fs-extra rejects root → contained destination before consulting Packager's ignore filter.
// Copying allowed immediate children preserves that filter without recursing into staging.
// This wrapper is installed only for Packager's platform module; all other copies are untouched.
async function copyContainedPackagerTemplate(io, source, destination, options, root) {
  const from = path.resolve(source);
  const to = path.resolve(destination);
  const rel = path.relative(path.resolve(root), to).replaceAll('\\', '/');
  if (
    from !== path.resolve(root) ||
    !/^\.tmp\/[^/]+\/electron-packager\/tmp-[^/]+\/resources\/app$/.test(rel) ||
    typeof options?.filter !== 'function'
  )
    return io.copy(source, destination, options);
  if (!(await options.filter(from, to))) return;
  await io.ensureDir(to);
  for (const name of await io.readdir(from)) {
    const child = path.join(from, name);
    const target = path.join(to, name);
    if (!(await options.filter(child, target))) continue;
    const nested = path.relative(child, to);
    if (!nested.startsWith('..' + path.sep) && !path.isAbsolute(nested))
      throw new Error('Packager filter must exclude its contained staging directory');
    await io.copy(child, target, options);
  }
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
    installContainedPackagerCompatibility();
    console.log(
      '[build] Applying scoped Electron Forge 7.11.2 Windows temporary-path glob compatibility.',
    );
  }

  // The top-level Commander CLI spawns a subcommand process and loses scoped compatibility.
  // Invoke its official package subcommand in this process; flags and Forge package API stay intact.
  const directPackage = args[0] === 'package';
  const cliPath = require.resolve(
    directPackage
      ? '@electron-forge/cli/dist/electron-forge-package.js'
      : '@electron-forge/cli/dist/electron-forge.js',
  );
  process.argv = [process.execPath, cliPath, ...(directPackage ? args.slice(1) : args)];
  require(cliPath);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runForgeCli(process.argv.slice(2));
}

export {
  isForgeTemporaryBinCleanupGlob,
  normalizeForgeFastGlobCall,
  copyContainedPackagerTemplate,
};
