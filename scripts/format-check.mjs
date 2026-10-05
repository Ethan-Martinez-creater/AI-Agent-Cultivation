import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import prettier from 'prettier';

// Match Prettier's current-directory scope without recursively walking ignored
// build caches and worktrees. Git provides tracked files plus non-ignored local
// additions; .prettierignore remains the single formatting exclusion policy.
const root = process.cwd();
const ignorePath = path.join(root, '.prettierignore');
const listed = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root },
)
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const files = [...new Set(listed)].sort();
const failures = [];
let checked = 0;
let excluded = 0;

for (const filepath of files) {
  let source;
  try {
    source = await readFile(filepath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }

  const info = await prettier.getFileInfo(filepath, { ignorePath });
  if (info.ignored || !info.inferredParser) {
    excluded += 1;
    continue;
  }

  const config = await prettier.resolveConfig(filepath, { editorconfig: true });
  checked += 1;
  if (!(await prettier.check(source, { ...config, filepath }))) failures.push(filepath);
}

if (failures.length > 0) {
  console.error('Prettier found formatting issues in ' + failures.length + ' file(s):');
  for (const filepath of failures) console.error('  ' + filepath);
  process.exitCode = 1;
} else {
  console.log(
    'Prettier checked ' +
      checked +
      ' tracked or non-ignored files; skipped ' +
      excluded +
      ' ignored or unsupported files.',
  );
}
