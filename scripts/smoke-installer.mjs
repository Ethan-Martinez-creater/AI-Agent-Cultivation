import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const configuredRoot = process.env.CULTIVATION_INSTALLER_SMOKE_ROOT;
const scratchBase = configuredRoot ? resolve(configuredRoot) : join(parse(repoRoot).root, 'a6');
const scratchRoot = join(scratchBase, runId);
const localAppData = join(scratchRoot, 'local-app-data');
const userProfile = join(scratchRoot, 'user-profile');
const appData = join(userProfile, 'AppData', 'Roaming');
const startMenuPrograms = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const desktopDirectory = join(userProfile, 'Desktop');
const tempDirectory = join(scratchRoot, 'temp');
const launchWorkingDirectory = join(scratchRoot, 'launch-working-directory');
const setupOutput = join(repoRoot, 'out', 'make', 'squirrel.windows', 'x64');
const expectedExecutableName = 'AI-Agent-Cultivation.exe';
const startMenuShortcut = join(
  startMenuPrograms,
  'AI Agent Cultivation contributors',
  'AI Agent Cultivation.lnk',
);

assert.equal(
  parse(scratchRoot).root.toUpperCase(),
  'E:\\',
  'Installer smoke writes only to E:; set CULTIVATION_INSTALLER_SMOKE_ROOT to an E: temp folder.',
);
assert.equal(
  isPathWithin(repoRoot, scratchRoot),
  false,
  'Installer smoke temp must be outside the source checkout for Electron Packager.',
);

for (const directory of [
  localAppData,
  appData,
  userProfile,
  startMenuPrograms,
  desktopDirectory,
  tempDirectory,
  launchWorkingDirectory,
]) {
  mkdirSync(directory, { recursive: true });
}

const installerEnv = {
  ...process.env,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  USERPROFILE: userProfile,
  TEMP: tempDirectory,
  TMP: tempDirectory,
  SQUIRREL_TEMP: localAppData,
};
delete installerEnv.CULTIVATION_USER_DATA_DIR;
const buildEnv = {
  ...process.env,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  USERPROFILE: userProfile,
  TEMP: tempDirectory,
  TMP: tempDirectory,
  npm_config_cache: join(scratchRoot, 'npm-cache'),
  CULTIVATION_ELECTRON_ZIP_DIR:
    process.env.CULTIVATION_ELECTRON_ZIP_DIR ?? join(repoRoot, '.electron-dist'),
};

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this smoke through `npm run smoke:installer`.');
console.log(`Installer smoke scratch: ${scratchRoot}`);
await runProcess(process.execPath, [npmCli, 'run', 'make'], {
  cwd: repoRoot,
  env: buildEnv,
  timeoutMs: 15 * 60_000,
});

assert.ok(existsSync(setupOutput), `Squirrel output directory was not created: ${setupOutput}`);
const setupExecutables = readdirSync(setupOutput)
  .filter((name) => name.toLowerCase().endsWith('setup.exe'))
  .map((name) => join(setupOutput, name));
assert.equal(setupExecutables.length, 1, `Expected one Setup.exe in ${setupOutput}`);
const setupExecutable = setupExecutables[0];

await install(setupExecutable, installerEnv);
let installation = await waitForInstallation(localAppData);
await waitUntil(
  () => existsSync(startMenuShortcut),
  'Squirrel did not create the isolated Start menu shortcut.',
);
assert.ok(
  isPathWithin(localAppData, installation.root),
  `Squirrel install escaped the isolated LOCALAPPDATA target: ${installation.root}`,
);
await stopAppProcesses(installation.root);

const marker = `installer-smoke-${runId}`;
const createdTeammate = await withInstalledApp(
  installation.executable,
  installerEnv,
  async (page) => {
    await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 60_000 });
    return page.evaluate(async (name) => {
      const provider = await window.cultivation.providers.create({
        name: `${name} Provider`,
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:9/v1',
      });
      const runtime = await window.cultivation.runtimes.create({
        name: `${name} Runtime`,
        providerId: provider.id,
        credentialId: null,
        modelId: 'installer-smoke-only',
      });
      return window.cultivation.teammates.create({
        name,
        avatar: null,
        title: null,
        description: 'Windows installer smoke data',
        identityPrompt: 'Installer smoke only; no model request is made.',
        behaviorPrompt: '',
        currentRuntimeProfileId: runtime.id,
      });
    }, marker);
  },
);

const databasePath = await waitForDatabase(appData);
const userDataDirectory = dirname(dirname(databasePath));
assert.ok(
  isPathWithin(appData, userDataDirectory),
  `userData escaped isolated APPDATA: ${databasePath}`,
);
assert.equal(
  resolve(userDataDirectory),
  resolve(appData, 'AI Agent Cultivation'),
  "app.getPath('userData') should resolve to the product profile beneath isolated APPDATA.",
);
assert.equal(isPathWithin(installation.root, userDataDirectory), false);
assert.equal(isPathWithin(launchWorkingDirectory, userDataDirectory), false);
assert.notEqual(
  resolve(userDataDirectory),
  resolve(repoRoot),
  'userData must not be the source checkout.',
);
const sizeBeforeUninstall = statSync(databasePath).size;
assert.ok(sizeBeforeUninstall > 0, 'The app did not create its userData SQLite database.');

await withInstalledApp(installation.executable, installerEnv, async (page) => {
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 60_000 });
  const teammates = await page.evaluate(() => window.cultivation.teammates.list());
  assert.ok(
    teammates.some((teammate) => teammate.id === createdTeammate.id),
    'A second launch did not read the teammate saved in userData.',
  );
});

await stopAppProcesses(installation.root);
await runProcess(join(installation.root, 'Update.exe'), ['--uninstall'], {
  cwd: installation.root,
  env: installerEnv,
  timeoutMs: 120_000,
});
await stopAppProcesses(installation.root);
await waitUntil(
  () => !existsSync(installation.executable),
  'Squirrel uninstaller did not remove the installed application files.',
);
await waitUntil(
  () => !existsSync(startMenuShortcut),
  'Squirrel uninstaller did not remove the Start menu shortcut.',
);
assert.ok(existsSync(databasePath), 'Uninstall removed the app userData database.');
assert.equal(
  statSync(databasePath).size,
  sizeBeforeUninstall,
  'Uninstall changed the retained userData database.',
);

await install(setupExecutable, installerEnv);
installation = await waitForInstallation(localAppData);
await waitUntil(
  () => existsSync(startMenuShortcut),
  'Squirrel reinstall did not restore the Start menu shortcut.',
);
assert.ok(isPathWithin(localAppData, installation.root));
await stopAppProcesses(installation.root);
await withInstalledApp(installation.executable, installerEnv, async (page) => {
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 60_000 });
  const teammates = await page.evaluate(() => window.cultivation.teammates.list());
  assert.ok(
    teammates.some((teammate) => teammate.id === createdTeammate.id),
    'Reinstall did not recover user data retained by uninstall.',
  );
});

assert.ok(existsSync(databasePath), 'userData disappeared after reinstall.');
console.log(
  `WINDOWS_INSTALLER_SMOKE_OK install=ok launch_close_relaunch=ok uninstall=ok reinstall=ok shortcut=ok userData=${userDataDirectory}`,
);

async function install(setupPath, env) {
  await runProcess(setupPath, ['--silent'], {
    cwd: dirname(setupPath),
    env,
    timeoutMs: 120_000,
  });
}

async function withInstalledApp(executablePath, env, exercise) {
  const application = await electron.launch({
    executablePath,
    args: ['--installer-smoke', '--gate1-fake-model'],
    cwd: launchWorkingDirectory,
    env,
    timeout: 60_000,
  });
  try {
    const page = await application.firstWindow();
    return await exercise(page);
  } finally {
    await application.close();
  }
}

async function waitForInstallation(searchRoot) {
  let installation;
  await waitUntil(() => {
    installation = findInstallation(searchRoot);
    return installation !== null;
  }, `Squirrel did not install ${expectedExecutableName} beneath ${searchRoot}.`);
  return installation;
}

function findInstallation(searchRoot) {
  if (!existsSync(searchRoot)) return null;
  for (const entry of readdirSync(searchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(searchRoot, entry.name);
    const updater = join(root, 'Update.exe');
    if (!existsSync(updater)) continue;
    const appDirectories = readdirSync(root, { withFileTypes: true })
      .filter((child) => child.isDirectory() && child.name.toLowerCase().startsWith('app-'))
      .map((child) => child.name)
      .sort()
      .reverse();
    for (const appDirectory of appDirectories) {
      const executable = join(root, appDirectory, expectedExecutableName);
      if (existsSync(executable)) return { root, executable, updater };
    }
  }
  return null;
}

async function waitForDatabase(searchRoot) {
  let databasePath;
  await waitUntil(() => {
    databasePath = findFile(searchRoot, 'cultivation.sqlite', 6);
    return databasePath !== null;
  }, `The app did not create cultivation.sqlite beneath isolated APPDATA ${searchRoot}.`);
  return databasePath;
}

function findFile(directory, expectedName, maxDepth) {
  if (!existsSync(directory) || maxDepth < 0) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === expectedName.toLowerCase()) return entryPath;
    if (entry.isDirectory()) {
      const match = findFile(entryPath, expectedName, maxDepth - 1);
      if (match) return match;
    }
  }
  return null;
}

async function stopAppProcesses(installationRoot) {
  const { stdout } = await execFileAsync(
    'wmic.exe',
    ['process', 'get', 'ExecutablePath,ProcessId', '/format:csv'],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
  );
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex(
    (line) => /ExecutablePath/i.test(line) && /ProcessId/i.test(line),
  );
  if (headerIndex < 0)
    throw new Error('WMIC did not return an executable path and process ID table.');
  const headers = parseCsvRecord(lines[headerIndex]);
  const executableColumn = headers.findIndex((value) => value.toLowerCase() === 'executablepath');
  const pidColumn = headers.findIndex((value) => value.toLowerCase() === 'processid');
  const pids = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const columns = parseCsvRecord(line);
    const executable = columns[executableColumn];
    const pid = columns[pidColumn];
    if (
      executable?.toLowerCase().endsWith(`\\${expectedExecutableName.toLowerCase()}`) &&
      isPathWithin(installationRoot, executable) &&
      /^\d+$/.test(pid ?? '')
    ) {
      pids.push(pid);
    }
  }
  for (const pid of pids) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', pid, '/F'], {
        windowsHide: true,
        timeout: 10_000,
      });
    } catch {
      // The Squirrel event hook may have already exited this app process.
    }
  }
}

function parseCsvRecord(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  fields.push(value);
  return fields;
}

async function waitUntil(check, failureMessage, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(500);
  }
  assert.fail(failureMessage);
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      rejectPromise(new Error(`Timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code ?? signal}.`));
    });
  });
}

function isPathWithin(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !parse(pathFromParent).root)
  );
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
