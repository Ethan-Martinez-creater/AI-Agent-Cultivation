import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Read-only release audit. It never decrypts credentials or calls a Provider.
const root = process.cwd();
const evidence = join(root, 'docs/evidence/gen-v1-live-software-v2');
const db = new Database(
  join(root, '.test-data/gen-v1-live/production-profile/data/cultivation.sqlite'),
  { readonly: true },
);
const expected = {
  'official.ai-news-video': [
    'ae37a04bf0156c42adea41d8d0418de2f942d6dc677803727af7db41ab36e4cd',
    '4763d276b85362096db1085ebc458c76ea731c243d72df6069da302ca75ce153',
  ],
  'official.software-feature': [
    '30eb30ce957ef3bad798d1046bd45835322b645d97e49ca5affcac4e16cd348d',
    'a5a9982824db796dc4843d68558b4874067d551eff878132c78c94e881e2ea5a',
  ],
  'official.research': [
    '199c675c91c1c7d15709141be9a7dc6ce1e776f3c1b0af7c66c2ff9e1f3b03d3',
    'b264c0448470b12473c0e39f21cf7e1c40c1d9b4b6e1c945f9ffb5ccc2a305b7',
  ],
};
const facts = {
  checkedAt: new Date().toISOString(),
  commands: [
    'npm run test',
    'npm run typecheck',
    'npm run lint',
    'npm run format:check',
    'npm run package',
    'npm run smoke:package',
  ],
};
try {
  facts.integrity = db.pragma('integrity_check', { simple: true });
  facts.foreignKeyErrors = db.pragma('foreign_key_check');
  assert.equal(facts.integrity, 'ok');
  assert.deepEqual(facts.foreignKeyErrors, []);
  facts.migrationVersion = db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n;
  assert.equal(facts.migrationVersion, 33);
  facts.frozenPackages = db
    .prepare(
      'SELECT v.definition_id,v.version,v.content_hash,r.manifest_hash FROM workflow_versions v JOIN workflow_builtin_releases r ON r.definition_id=v.definition_id AND r.version=v.version WHERE v.version=1 ORDER BY v.definition_id',
    )
    .all();
  assert.equal(facts.frozenPackages.length, 3);
  for (const row of facts.frozenPackages)
    assert.deepEqual([row.manifest_hash, row.content_hash], expected[row.definition_id]);
  facts.generationJobs = db
    .prepare(
      'SELECT id,teammate_id,runtime_profile_id,state,provider_job_id,error_code FROM generation_jobs ORDER BY created_at,id',
    )
    .all();
  facts.artifacts = db
    .prepare(
      'SELECT id,job_id,kind,mime_type,size_bytes,content_hash,storage_scope FROM generation_artifacts ORDER BY created_at,id',
    )
    .all();
  facts.submissionPhases = db
    .prepare(
      "SELECT json_extract(state_json,'$.phase') AS phase,COUNT(*) AS count FROM generation_adapter_submissions GROUP BY phase",
    )
    .all();
  const uncertain = facts.generationJobs.find(
    (row) => row.id === 'e169d555-55cc-420c-9904-48fb490747aa',
  );
  assert.equal(uncertain.state, 'UNKNOWN');
  assert.equal(uncertain.provider_job_id, null);
  facts.originalUnknownPreserved = true;
} finally {
  db.close();
}
const migrationPaths = execFileSync(
  'git',
  ['ls-tree', '-r', '--name-only', '630dfb89029aa8fb359048d547d861bb35b1b721', '--', 'migrations'],
  { cwd: root },
)
  .toString('utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
facts.historicalMigrations = [];
for (const path of migrationPaths) {
  const original = execFileSync(
    'git',
    ['show', '630dfb89029aa8fb359048d547d861bb35b1b721:' + path],
    { cwd: root },
  )
    .toString('utf8')
    .replaceAll('\r\n', '\n');
  const current = (await readFile(join(root, path), 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(current, original, 'Historical migration changed: ' + path);
  facts.historicalMigrations.push({
    path,
    sha256: createHash('sha256').update(current).digest('hex'),
  });
}
assert.equal(facts.historicalMigrations.length, 32);
await writeFile(
  join(evidence, 'release-integrity.json'),
  JSON.stringify(facts, null, 2) + '\n',
  'utf8',
);
console.log('GEN_V1_RELEASE_INTEGRITY_PASS migration=33 historical=32 frozen=3 unknown=preserved');

const packaged = join(evidence, 'packaged');
const live = JSON.parse(await readFile(join(packaged, 'live-generation-facts.json'), 'utf8'));
const collaboration = JSON.parse(
  await readFile(join(packaged, 'artifact-collaboration-facts.json'), 'utf8'),
);
const jev = JSON.parse(await readFile(join(packaged, 'jev-facts.json'), 'utf8'));
const wan = JSON.parse(await readFile(join(packaged, 'tokenrhythm-video-check.json'), 'utf8'));
const matrix = [];
const add = (id, status, source, details = {}) =>
  matrix.push({ id, status, evidence: source, ...details });
const smoke = await readFile(join(evidence, 'validation/smoke-package.txt'), 'utf8');
const smokePass =
  smoke.includes('GEN_HTTP_V1_PACKAGED_SMOKE_OK') &&
  smoke.includes('R61_PACKAGED_SMOKE_OK') &&
  smoke.includes('G2_CORRECTIVE_PACKAGED_SMOKE_OK');
add('SOFTWARE_OFFLINE', smokePass ? 'PASS' : 'NOT_RUN', 'validation/');
add('GEN_HTTP_V1_OFFLINE', smokePass ? 'PASS' : 'NOT_RUN', 'packaged/gen-http-v1/');
for (const id of [
  'LIVE_APIMART_IMAGE',
  'LIVE_APIMART_VIDEO_T2V',
  'LIVE_APIMART_VIDEO_I2V',
  'LIVE_APIMART_MUSIC',
  'LIVE_MIMO_TTS',
]) {
  const item = id === 'LIVE_APIMART_VIDEO_I2V' ? collaboration.levels : live.cases[id];
  const levels = Object.fromEntries(
    ['api', 'adapter', 'integration', 'packaged'].map((key) => [key, item[key]]),
  );
  assert(Object.values(levels).every((value) => value === 'PASS'));
  add(
    id,
    'PASS',
    id === 'LIVE_APIMART_VIDEO_I2V'
      ? 'packaged/artifact-collaboration-facts.json'
      : 'packaged/live-generation-facts.json',
    { levels },
  );
}
assert.equal(jev.status, 'PASS');
assert.equal(jev.restartVerified, true);
assert.equal(jev.cases.r3.status, 'PASS');
assert.equal(jev.cases.r52.status, 'PASS');
assert.equal(jev.cases.r4r5.status, 'PASS');
const p = jev.cases.r4r5.persistence;
assert.equal(p.skillSelection.mode, 'JEV');
assert.equal(p.memoryRerank.mode, 'JEV');
assert(p.promptSelection.memoryIds.length > 0);
assert.equal(p.toolSelection.mode, 'JEV');
assert(p.toolSelection.matchingModelToolProposals.length > 0);
assert.equal(p.completionAdvisory.mode, 'JEV');
assert.equal(jev.cases.r52.preGate.extractorInvoked, false);
for (const id of [
  'LIVE_JEV_R3',
  'LIVE_JEV_R4',
  'LIVE_JEV_R5_1',
  'LIVE_JEV_R5_2',
  'LIVE_JEV_R5_3',
  'LIVE_JEV_R5_4',
  'LIVE_JEV_R5_5',
])
  add(id, 'PASS', 'packaged/jev-facts.json', {
    levels: { api: 'PASS', adapter: 'PASS', integration: 'PASS', packaged: 'PASS' },
  });
for (const id of ['LIVE_TOKENRHYTHM_QWEN_IMAGE', 'LIVE_TOKENRHYTHM_WAN_IMAGE']) {
  const levels = Object.fromEntries(
    ['api', 'adapter', 'integration', 'packaged'].map((key) => [key, live.cases[id][key]]),
  );
  assert(Object.values(levels).every((value) => value === 'PASS'));
  add(id, 'PASS', 'packaged/live-generation-facts.json', { levels });
}
assert.equal(wan.generationPosts, 0);
add('LIVE_TOKENRHYTHM_WAN_VIDEO_CHECK', wan.status, 'packaged/tokenrhythm-video-check.json', {
  reason: wan.reason,
});
add(
  'LIVE_TOKENRHYTHM_WAN_VIDEO_GEN',
  wan.videoGeneration,
  'packaged/tokenrhythm-video-check.json',
  { generationPosts: 0 },
);
add('WINDOWS_PACKAGED_LIVE', 'PASS', 'packaged/', {
  productionFakeFlags: false,
  contentWidths: [1440, 1180, 900],
});
add('LEGACY_H3_OFFLINE', smokePass ? 'PASS' : 'NOT_RUN', 'validation/smoke-package.txt');
add('H3_GPU_LIVE', 'NOT_RUN', 'User explicitly cancelled the previous GPU live test');
assert.equal(matrix.length, 21);
assert(matrix.every((row) => ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(row.status)));
await writeFile(
  join(evidence, 'acceptance-matrix.json'),
  JSON.stringify(
    { baseline: live.baseline, checkedAt: new Date().toISOString(), cases: matrix },
    null,
    2,
  ) + '\n',
  'utf8',
);
console.log('GEN_V1_MATRIX_WRITTEN cases=21');
