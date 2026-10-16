import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../packages/persistence/src/index.js';
import { W1WorkflowRepository } from '../../packages/persistence/src/w1-workflow.js';
import { W2WorkflowRepository } from '../../packages/persistence/src/w2-workflow.js';
import { installOfficialBuiltinWorkflows } from '../../apps/desktop/src/main/w2-builtin-installation.js';

const root = process.cwd();
const evidence = resolve(root, 'docs/evidence/v1-engineering-validation/preflight');
const scratch = resolve(
  root,
  '.test-data/e1-closure-integrity',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(evidence, { recursive: true });
mkdirSync(scratch, { recursive: true });
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
const gitText = (...args: string[]) =>
  git(...args)
    .toString('utf8')
    .trim();
const baseline = 'a2551bbc9dbd87ec4701183a53a2635966326df4';
const path = join(root, 'docs/AI_Agent_Cultivation_V1_E0_Evaluation_Design_v0.2.md');
const bytes = readFileSync(path);
const source = bytes.toString('utf8');
function block(language: string) {
  const blocks = [
    ...source.matchAll(new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)\\r?\\n```', 'g')),
  ];
  assert.equal(blocks.length, 1, `exactly one ${language} block`);
  return blocks[0]![1]!;
}
const json = block('json');
const raw = json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1);
const mapping = block('tsv');
const hashes = {
  document: {
    expected: '2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c',
    actual: sha(bytes),
  },
  dataset: {
    expected: 'ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602',
    actual: sha(raw),
  },
  mapping: {
    expected: '04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62',
    actual: sha(mapping),
  },
};
const trusted = Object.values(hashes).every((value) => value.actual === value.expected);
const statusBefore = git('status', '--porcelain=v1', '-z', '--untracked-files=all')
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
const migrations = readdirSync(join(root, 'migrations'))
  .filter((name) => /^\d{4}.*\.sql$/.test(name))
  .sort()
  .map((name) => {
    const path = 'migrations/' + name;
    const raw = readFileSync(join(root, path));
    const committed = git('show', baseline + ':' + path);
    const lf = raw.toString('utf8').replace(/\r\n/g, '\n');
    return {
      path,
      rawSha256: sha(raw),
      gitBlobObjectId: gitText('rev-parse', baseline + ':' + path),
      gitContentSha256: sha(committed),
      lfSha256: sha(lf),
      rawMatchesGit: raw.equals(committed),
      lfMatchesGit: lf === committed.toString('utf8').replace(/\r\n/g, '\n'),
    };
  });
assert.equal(migrations.length, 33);
assert.ok(migrations.every((migration) => migration.lfMatchesGit));
const head = gitText('rev-parse', 'HEAD');
assert.equal(head, baseline);
const trackedDiff = gitText('diff', baseline, '--name-only');
assert.equal(trackedDiff, '', 'frozen tracked source remains unchanged');
let datasetFacts: Record<string, unknown> = {
  status: 'BLOCKED',
  reason: 'untrusted document hash',
};
if (trusted) {
  const dataset = JSON.parse(raw);
  assert.equal(dataset.schema, 'AAC-E0-BENCH-v0.1');
  assert.equal(dataset.baseCommit, baseline);
  assert.equal(dataset.cases.length, 30);
  assert.equal(new Set(dataset.cases.map((item: { id: string }) => item.id)).size, 30);
  const families = ['SKILL', 'MEMORY', 'TOOL'].map((family) => {
    const cases = dataset.cases.filter((item: { family: string }) => item.family === family);
    assert.equal(cases.length, 10);
    assert.equal(cases.filter((item: { live: boolean }) => item.live).length, 5);
    return { family, cases: cases.length, live: 5 };
  });
  for (const item of dataset.cases) {
    const ids = item.candidateGrades.map((candidate: { id: string }) => candidate.id);
    assert.equal(new Set(ids).size, ids.length, item.id);
    for (const candidate of item.candidateGrades) {
      assert.ok(Object.hasOwn(dataset.catalogs[item.family], candidate.id));
      assert.ok(Number.isInteger(candidate.grade) && candidate.grade >= 0 && candidate.grade <= 3);
    }
  }
  const live = dataset.cases.filter((item: { live: boolean }) => item.live);
  assert.deepEqual(
    live.map((item: { id: string }) => item.id),
    dataset.liveSet,
  );
  const forbiddenKeys = ['grade', 'candidateGrades', 'referenceReason'];
  const projected = dataset.cases.map(
    (item: {
      id: string;
      family: string;
      task: string;
      candidateGrades: Array<{ id: string }>;
    }) => ({
      objective: item.task,
      candidates: item.candidateGrades.map(({ id }) => ({
        id,
        ...dataset.catalogs[item.family][id],
      })),
    }),
  );
  assert.ok(
    forbiddenKeys.every((key) => !new RegExp('"' + key + '"\\s*:').test(JSON.stringify(projected))),
  );
  datasetFacts = {
    status: 'PASS',
    families,
    liveIds: dataset.liveSet,
    questionCount: live.reduce(
      (sum: number, item: { candidateGrades: unknown[] }) => sum + item.candidateGrades.length,
      0,
    ),
    goldExcludedFromProjection: true,
  };
  const lines = [
    '# Gold 独立复核待办',
    '',
    '状态：**BLOCKED — 尚无用户或独立评审者签署确认。**',
    '',
    '此表从已验证的 E0 v0.2 原样提取 15 个 Live Case，仅供人工复核；Codex 未认可、修改或替换原 Gold。',
    '',
    `Dataset SHA-256：\`${hashes.dataset.actual}\``,
    '',
    '| Case | 当前确认状态 | 评审者 | 确认时间 | 差异建议 |',
    '|---|---|---|---|---|',
    ...live.map((item: { id: string }) => `| ${item.id} | PENDING | 待填写 | 待填写 | 待填写 |`),
    '',
  ];
  for (const item of live) {
    lines.push(
      `## ${item.id}`,
      '',
      `任务：${item.task}`,
      '',
      `原设计参考理由：${item.referenceReason}`,
      '',
      '| 候选 ID | 原始候选元数据 | 原 Gold | 独立评分建议 | 确认/分歧 |',
      '|---|---|---:|---|---|',
    );
    for (const candidate of item.candidateGrades) {
      const metadata = dataset.catalogs[item.family][candidate.id];
      lines.push(
        `| ${candidate.id} | ${JSON.stringify(metadata).replaceAll('|', '\\|')} | ${candidate.grade} | 待填写 | PENDING |`,
      );
    }
    lines.push('');
  }
  lines.push(
    '如有分歧，仅记录建议。Dataset、LiveSet、grade 与 referenceReason 的修改须由设计方另行决定版本与 hash。',
    '',
  );
  const goldReviewPath = join(evidence, 'gold-review-pending.md');
  // Re-running integrity must preserve any subsequent human review notes/signature.
  if (!existsSync(goldReviewPath)) writeFileSync(goldReviewPath, lines.join('\n'), 'utf8');
}
const database = openDatabase(join(scratch, 'data/cultivation.sqlite'));
let databaseFacts;
try {
  installOfficialBuiltinWorkflows(
    new W1WorkflowRepository(database),
    new W2WorkflowRepository(database),
  );
  const actual = database
    .prepare(
      'SELECT definition_id,version,content_hash FROM workflow_versions ORDER BY definition_id',
    )
    .all() as Array<{ definition_id: string; version: number; content_hash: string }>;
  const releases = database
    .prepare(
      'SELECT definition_id,version,manifest_hash FROM workflow_builtin_releases ORDER BY definition_id',
    )
    .all() as Array<{ definition_id: string; version: number; manifest_hash: string }>;
  const expected = JSON.parse(
    readFileSync(
      join(root, 'docs/evidence/gen-v1-live-software-v2/release-integrity.json'),
      'utf8',
    ),
  ).frozenPackages;
  assert.equal(actual.length, 3);
  for (const item of expected) {
    assert.equal(
      actual.find((row) => row.definition_id === item.definition_id)?.content_hash,
      item.content_hash,
    );
    assert.equal(
      releases.find((row) => row.definition_id === item.definition_id)?.manifest_hash,
      item.manifest_hash,
    );
  }
  const integrity = database.pragma('integrity_check', { simple: true });
  const foreignKeys = database.pragma('foreign_key_check');
  assert.equal(integrity, 'ok');
  assert.deepEqual(foreignKeys, []);
  const migrationCount = (
    database.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as { n: number }
  ).n;
  assert.equal(migrationCount, 33);
  databaseFacts = {
    status: 'PASS',
    isolated: true,
    path: join(scratch, 'data/cultivation.sqlite'),
    migrationCount,
    integrity,
    foreignKeys,
    versions: actual,
    releases,
  };
} finally {
  database.close();
}
const report = {
  stage: 'E1_CLOSURE_PREFLIGHT',
  source: 'PRODUCTION_OFFLINE',
  liveProviderCalls: 0,
  checkedAt: new Date().toISOString(),
  head,
  hashes,
  status: trusted ? 'PASS' : 'BLOCKED',
  datasetFacts,
  trackedDiff,
  workingTreeEntriesAtAudit: statusBefore,
  migrations,
  databaseFacts,
};
writeFileSync(
  join(evidence, 'dataset-integrity.json'),
  JSON.stringify(report, null, 2) + '\n',
  'utf8',
);
console.log(
  JSON.stringify({
    status: report.status,
    dataset: datasetFacts.status,
    migrations: migrations.length,
    database: databaseFacts.status,
    evidence,
  }),
);
if (!trusted) process.exitCode = 1;
