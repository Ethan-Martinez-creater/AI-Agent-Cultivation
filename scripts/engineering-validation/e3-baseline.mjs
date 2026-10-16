import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as asar from '@electron/asar';
import { build } from 'esbuild';
const root = process.cwd();
assert.match(root, /^E:[\\/]/i);
const scratch = resolve(root, '.tmp/e3-runtime');
const evidence = resolve(root, 'docs/evidence/v1-engineering-validation/e3');
mkdirSync(scratch, { recursive: true });
mkdirSync(evidence, { recursive: true });
process.env.TEMP = scratch;
process.env.TMP = scratch;
process.env.GIT_OPTIONAL_LOCKS = '0';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, env: process.env });
const baseline = 'a2551bbc9dbd87ec4701183a53a2635966326df4';
assert.equal(git('rev-parse', 'HEAD').toString('utf8').trim(), baseline);
assert.equal(git('diff', baseline, '--name-only').toString('utf8').trim(), '');
const source = readFileSync('docs/AI_Agent_Cultivation_V1_E0_Evaluation_Design_v0.2.md', 'utf8');
const block = (language) => {
  const matches = [
    ...source.matchAll(new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)\\r?\\n```', 'g')),
  ];
  assert.equal(matches.length, 1);
  return matches[0][1];
};
const json = block('json');
const hashes = {
  document: sha(readFileSync('docs/AI_Agent_Cultivation_V1_E0_Evaluation_Design_v0.2.md')),
  dataset: sha(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1)),
  mapping: sha(block('tsv')),
};
assert.deepEqual(hashes, {
  document: '2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c',
  dataset: 'ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602',
  mapping: '04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62',
});
const migrations = readdirSync('migrations')
  .filter((name) => /^\d{4}.*\.sql$/.test(name))
  .sort()
  .map((name) => {
    const path = 'migrations/' + name;
    const bytes = readFileSync(path);
    const committed = git('show', baseline + ':' + path);
    const normalized = bytes.toString('utf8').replaceAll('\r\n', '\n');
    assert.equal(normalized, committed.toString('utf8').replaceAll('\r\n', '\n'), path);
    return {
      path,
      rawSha256: sha(bytes),
      gitContentSha256: sha(committed),
      lfSha256: sha(normalized),
      gitBlobObjectId: git('rev-parse', baseline + ':' + path)
        .toString('utf8')
        .trim(),
    };
  });
assert.equal(migrations.length, 33);
const priorManifest = JSON.parse(
  readFileSync('docs/evidence/v1-engineering-validation/preflight/evidence-manifest.json', 'utf8'),
);
for (const entry of priorManifest.entries)
  assert.equal(sha(readFileSync(entry.path)), entry.sha256, 'Preserve E1: ' + entry.path);
const priorArtifacts = JSON.parse(
  readFileSync(
    'docs/evidence/v1-engineering-validation/preflight/packaged-artifact-integrity-final.json',
    'utf8',
  ),
);
const exe = resolve('out/AI Agent Cultivation-win32-x64/AI-Agent-Cultivation.exe');
const archive = resolve('out/AI Agent Cultivation-win32-x64/resources/app.asar');
const bundlePath = asar.listPackage(archive).find((path) => path.endsWith('main-pyN31JHh.js'));
assert.ok(bundlePath);
const bundle = asar.extractFile(archive, bundlePath.replace(/^[\\/]/, ''));
const artifacts = [
  { path: relative(root, exe), sha256: sha(readFileSync(exe)) },
  { path: relative(root, archive), sha256: sha(readFileSync(archive)) },
  { path: bundlePath, sha256: sha(bundle) },
];
artifacts.forEach((item, index) =>
  assert.equal(item.sha256, priorArtifacts.facts[index].expectedSha256),
);
const outfile = join(scratch, 'baseline-db.bundle.mjs');
await build({
  stdin: {
    contents:
      "import {openDatabase} from './packages/persistence/src/index.ts'; import {W1WorkflowRepository} from './packages/persistence/src/w1-workflow.ts'; import {W2WorkflowRepository} from './packages/persistence/src/w2-workflow.ts'; import {installOfficialBuiltinWorkflows} from './apps/desktop/src/main/w2-builtin-installation.ts'; export function inspect(path){const db=openDatabase(path);try{installOfficialBuiltinWorkflows(new W1WorkflowRepository(db),new W2WorkflowRepository(db));return {versions:db.prepare('SELECT definition_id,version,content_hash FROM workflow_versions ORDER BY definition_id').all(),releases:db.prepare('SELECT definition_id,version,manifest_hash FROM workflow_builtin_releases ORDER BY definition_id').all(),migrationCount:db.prepare('SELECT count(*) n FROM schema_migrations').get().n,integrity:db.pragma('integrity_check',{simple:true}),foreignKeys:db.pragma('foreign_key_check')}}finally{db.close()}}",
    resolveDir: root,
    sourcefile: 'e3-baseline-inline.ts',
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['better-sqlite3'],
  loader: { '.sql': 'text' },
  logLevel: 'warning',
});
const module = await import(pathToFileURL(outfile).href);
const database = module.inspect(join(scratch, 'baseline-' + Date.now(), 'cultivation.sqlite'));
assert.equal(database.migrationCount, 33);
assert.equal(database.integrity, 'ok');
assert.deepEqual(database.foreignKeys, []);
const frozen = JSON.parse(
  readFileSync('docs/evidence/gen-v1-live-software-v2/release-integrity.json', 'utf8'),
).frozenPackages;
for (const item of frozen) {
  assert.equal(
    database.versions.find((row) => row.definition_id === item.definition_id).content_hash,
    item.content_hash,
  );
  assert.equal(
    database.releases.find((row) => row.definition_id === item.definition_id).manifest_hash,
    item.manifest_hash,
  );
}
const report = {
  stage: 'E3_P0',
  status: 'PASS',
  checkedAt: new Date().toISOString(),
  baseline,
  branch: git('branch', '--show-current').toString('utf8').trim(),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  hashes,
  migrations,
  database,
  artifacts,
  e1ManifestEntriesUnchanged: priorManifest.entries.length,
  buildProvenance:
    'Reused the E1-verified existing Windows x64 packaged output; no E3 rebuild performed',
  workingTreeAtStart: git('status', '--porcelain=v1', '-z', '--untracked-files=all')
    .toString('utf8')
    .split('\0')
    .filter(Boolean),
  realProviderCalls: 0,
};
const path = join(
  evidence,
  'baseline-' + new Date().toISOString().replaceAll(/[:.]/g, '-') + '.json',
);
writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(
  JSON.stringify({
    status: report.status,
    path,
    migrations: migrations.length,
    e1FilesPreserved: priorManifest.entries.length,
    mainBundleSha256: artifacts[2].sha256,
  }),
);
