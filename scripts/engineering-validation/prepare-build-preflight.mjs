import { execFileSync } from 'node:child_process';
import { cp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = process.cwd();
if (!/^E:[\\/]/i.test(root)) throw new Error('E: workspace required');
const destination = resolve(root, '.tmp', `e1-build-${Date.now()}`);
await mkdir(destination);
const files = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
})
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
for (const file of files) {
  await cp(join(root, file), join(destination, file), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}
// A physical copy keeps Electron native rebuilds out of the root Node test runtime.
await cp(join(root, 'node_modules'), join(destination, 'node_modules'), {
  recursive: true,
  dereference: true,
  errorOnExist: true,
  force: false,
});
// Restore workspace layout after the physical dependency copy. Persistence imports
// root migrations relative to packages/persistence, so materialized workspace
// packages inside node_modules are not equivalent to the original junctions.
const preserved = join(destination, '.tmp/materialized-workspaces-preserved');
await mkdir(preserved, { recursive: true });
for (const name of ['agent-runtime', 'application', 'domain', 'persistence', 'shared']) {
  const link = join(destination, 'node_modules/@cultivation', name);
  const target = join(destination, 'packages', name);
  if (![link, target, preserved].every((path) => resolve(path).startsWith(destination + '\\')))
    throw new Error('Workspace junction must stay inside the new build copy');
  await rename(link, join(preserved, name));
  await symlink(target, link, 'junction');
}
const report = {
  destination,
  source: root,
  trackedFiles: files.length,
  dependencyCopy: 'physical dependencies; workspace junctions point to copied packages',
  sourceModified: false,
  createdAt: new Date().toISOString(),
};
await writeFile(
  join(root, 'docs/evidence/v1-engineering-validation/preflight/build-isolation.json'),
  JSON.stringify(report, null, 2) + '\n',
  'utf8',
);
console.log(JSON.stringify(report));
