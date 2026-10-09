import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { navigateUi } from './ui-navigation.mjs';
import { attachAcceptanceVisuals, captureAcceptance } from './w24-shared-profile.mjs';
import { auditCrossWorkflow } from './w24-release-audit.mjs';

const root = process.cwd();
const profile = join(root, '.test-data', `w24-clean-packaged-${randomUUID()}`);
const evidence = join(profile, 'evidence');
const databasePath = join(profile, 'data', 'cultivation.sqlite');
assert.equal(existsSync(profile), false, 'each release acceptance starts with a new profile');
mkdirSync(evidence, { recursive: true });
const bundle = join(evidence, 'frozen-packages.mjs');
await build({
  entryPoints: [join(root, 'scripts', 'fixtures', 'w24-package-snapshot.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: bundle,
  tsconfig: join(root, 'tsconfig.base.json'),
  logLevel: 'silent',
});
const { officialPackages } = await import(pathToFileURL(bundle).href);
const read = (fn) => {
  const db = new Database(databasePath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const executablePath = join(
  root,
  'out',
  'AI Agent Cultivation-win32-x64',
  'AI-Agent-Cultivation.exe',
);
async function launch() {
  const app = await electron.launch({
    executablePath,
    env: { ...process.env, CULTIVATION_USER_DATA_DIR: profile },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  return { app, page };
}
const beforeDatabase = existsSync(databasePath);
assert.equal(beforeDatabase, false);
let live = await launch();
const initial = read((db) => ({
  migrations: db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version),
  releases: db.prepare('SELECT * FROM workflow_builtin_releases ORDER BY definition_id').all(),
  runs: db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get().n,
}));
assert.deepEqual(
  initial.migrations,
  Array.from({ length: 31 }, (_, index) => index + 1),
);
assert.equal(initial.runs, 0);
assert.equal(initial.releases.length, 3);
const installed = await live.page.evaluate(() => window.cultivation.workflows.versions());
assert.deepEqual(
  installed.map((item) => item.definition.id).sort(),
  officialPackages.map(({ version }) => version.definition.id).sort(),
);
await live.app.close();

// The SAME SQLite and Workspace survive each fixture stage, its crashes, and
// the final normal production restart. No database copying or reset is used.
process.env.CULTIVATION_W24_PROFILE = profile;
try {
  for (const stage of ['w21', 'w22', 'w23']) await import(`./${stage}-packaged-smoke.mjs`);
  const audited = read((db) => auditCrossWorkflow(db, officialPackages));
  const snapshot = () =>
    read((db) =>
      Object.fromEntries(
        [
          'mission_events',
          'workflow_artifacts',
          'workflow_checkpoints',
          'workflow_decisions',
          'workflow_revision_traversals',
          'workflow_step_operation_receipts',
          'workflow_step_operation_audit',
          'workflow_run_output_validations',
        ].map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]),
      ),
    );
  const before = snapshot();
  live = await launch();
  try {
    await attachAcceptanceVisuals(live, evidence);
    await navigateUi(live.page, '历练 Missions');
    await live.page.getByRole('link', { name: '工作流历练', exact: true }).click();
    for (const { version } of officialPackages) {
      const name = version.definition.name;
      await live.page
        .locator('.workflow-run-item')
        .filter({ hasText: name })
        .filter({ hasText: '已完成' })
        .first()
        .click();
      await live.page.locator('.workflow-results').waitFor();
      const primary = await live.page.locator('.workflow-workspace').evaluate((node) => {
        const copy = node.cloneNode(true);
        copy.querySelectorAll('details,pre,code').forEach((element) => element.remove());
        return copy.textContent;
      });
      assert.doesNotMatch(
        primary,
        /TEST_ONLY|FAKE:|fixture|YOUTUBE_SHORTS|MODEL_OR_TOOL|HUMAN_OR_EXTERNAL/i,
      );
      const detail = await live.page.evaluate(async (name) => {
        const versions = await window.cultivation.workflows.versions();
        const version = versions.find((item) => item.definition.name === name);
        const runs = await window.cultivation.workflows.list();
        const run = runs
          .filter(
            (item) => item.definitionId === version.definition.id && item.state === 'COMPLETED',
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        return window.cultivation.workflows.detail(run.id);
      }, name);
      assert.equal(detail.run.state, 'COMPLETED');
      await live.page.locator('.workflow-results').scrollIntoViewIfNeeded();
      await captureAcceptance(live, evidence, `${version.definition.id}-delivery-history`);
      await live.page.getByText('高级记录', { exact: true }).click();
      await captureAcceptance(live, evidence, `${version.definition.id}-advanced`);
      await live.page.getByText('高级记录', { exact: true }).click();
    }
    const after = snapshot();
    assert.deepEqual(
      after,
      before,
      'normal production restart and Renderer viewing must not replay any durable fact',
    );
    read((db) => auditCrossWorkflow(db, officialPackages));
    const facts = {
      profile,
      emptyDatabaseBeforeFirstLaunch: !beforeDatabase,
      initial,
      ...audited,
      finalProductionRestart: { before, after, noReplay: true },
      stageEvidence: {
        news: 'news/w21-facts.json',
        software: 'software/w22-facts.json',
        research: 'research/facts.json',
      },
    };
    for (const path of Object.values(facts.stageEvidence))
      assert.equal(JSON.parse(readFileSync(join(evidence, path), 'utf8')).profile, profile);
    writeFileSync(
      join(evidence, 'cross-workflow-facts.json'),
      JSON.stringify(facts, null, 2),
      'utf8',
    );
    console.log(
      `W24_PACKAGED_SMOKE_OK cleanProfile=${profile} migration=31 official=3 sharedDatabase=true frozenHashes=true finalProductionRestartZeroReplay=true evidence=${evidence}`,
    );
  } finally {
    await live.app.close();
  }
} finally {
  delete process.env.CULTIVATION_W24_PROFILE;
}
