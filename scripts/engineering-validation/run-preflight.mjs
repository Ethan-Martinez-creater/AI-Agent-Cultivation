import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

// Offline preflight only. This launcher has no Live / kill / restart mode.
const entries = {
  integrity: 'integrity-preflight.ts',
  inputs: 'input-preflight.ts',
  transport: 'jev-transport-preflight.ts',
};
const part = process.argv[2];
if (!Object.hasOwn(entries, part)) {
  throw new Error('Choose exactly one offline part: integrity, inputs, transport');
}
const root = process.cwd();
if (!/^E:[\\/]/i.test(root)) throw new Error('Run from the approved E: workspace');
const scratch = resolve(root, '.tmp/e1-main-preflight');
mkdirSync(scratch, { recursive: true });
const cache = resolve(root, '.npm-cache');
mkdirSync(cache, { recursive: true });
process.env.TEMP = scratch;
process.env.TMP = scratch;
process.env.npm_config_cache = cache;
process.env.GIT_OPTIONAL_LOCKS = '0';
const outfile = join(scratch, `${part}.bundle.mjs`);
await build({
  entryPoints: [join(root, 'scripts/engineering-validation', entries[part])],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['better-sqlite3', 'electron'],
  loader: { '.sql': 'text' },
  logLevel: 'warning',
});
const child = spawn(process.execPath, [outfile], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
