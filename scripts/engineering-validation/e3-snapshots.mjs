import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import Database from 'better-sqlite3';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function fileFact(path) {
  return existsSync(path)
    ? { exists: true, bytes: statSync(path).size, sha256: digest(readFileSync(path)) }
    : { exists: false };
}
function rows(db, table, condition = '', params = []) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    return [];
  return db.prepare(`SELECT * FROM ${table} ${condition} ORDER BY rowid`).all(...params);
}
export function collectFacts(database, runId) {
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const workflow = rows(db, 'workflow_runs', 'WHERE id=?', [runId])[0];
    const steps = rows(db, 'workflow_step_runs', 'WHERE workflow_run_id=?', [runId]);
    const missionIds = [...new Set(steps.map((step) => step.mission_id).filter(Boolean))];
    const missions = missionIds.flatMap((id) => rows(db, 'missions', 'WHERE id=?', [id]));
    const missionRuns = missionIds.flatMap((id) =>
      rows(db, 'mission_runs', 'WHERE mission_id=?', [id]),
    );
    const missionEvents = missionIds.flatMap((id) =>
      rows(db, 'mission_events', 'WHERE mission_id=?', [id]),
    );
    const related = Object.fromEntries(
      [
        'workflow_artifacts',
        'workflow_validation_receipts',
        'workflow_checkpoints',
        'workflow_artifact_bindings',
        'workflow_step_operation_receipts',
        'workflow_workspace_mutation_journal',
        'workflow_events',
        'workflow_decisions',
        'workflow_revision_traversals',
        'workflow_run_output_validations',
      ].map((table) => [table, rows(db, table, 'WHERE workflow_run_id=?', [runId])]),
    );
    const counts = Object.fromEntries(
      [...new Set(missionEvents.map((event) => event.event_type))]
        .sort()
        .map((type) => [type, missionEvents.filter((event) => event.event_type === type).length]),
    );
    return {
      workflow,
      steps,
      missions,
      missionRuns,
      missionEvents,
      ...related,
      counts,
      frozenVersions: db
        .prepare(
          'SELECT definition_id,version,content_hash FROM workflow_versions ORDER BY definition_id',
        )
        .all(),
      frozenReleases: db
        .prepare(
          'SELECT definition_id,version,manifest_hash FROM workflow_builtin_releases ORDER BY definition_id',
        )
        .all(),
      migrationCount: db.prepare('SELECT count(*) n FROM schema_migrations').get().n,
    };
  } finally {
    db.close();
  }
}
export async function captureStage({
  stageRoot,
  stage,
  databasePath,
  workspace,
  verifierLedger,
  controllerLedger,
  runId,
  processState,
}) {
  assert.match(stageRoot, /^E:[\\/].*[\\/]\.tmp[\\/]e3-runtime[\\/]/i);
  const directory = join(stageRoot, stage);
  assert.ok(!existsSync(directory), 'Never overwrite a stage snapshot: ' + directory);
  const raw = join(directory, 'raw');
  const seed = join(directory, 'consistency-seed');
  mkdirSync(raw, { recursive: true });
  mkdirSync(seed, { recursive: true });
  const sourceBefore = Object.fromEntries(
    ['', '-wal', '-shm'].map((suffix) => [suffix || 'main', fileFact(databasePath + suffix)]),
  );
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(databasePath + suffix)) continue;
    const destination = join(raw, basename(databasePath) + suffix);
    copyFileSync(databasePath + suffix, destination, constants.COPYFILE_EXCL);
    assert.equal(fileFact(destination).sha256, sourceBefore[suffix || 'main'].sha256);
  }
  const sourceAfter = Object.fromEntries(
    ['', '-wal', '-shm'].map((suffix) => [suffix || 'main', fileFact(databasePath + suffix)]),
  );
  assert.deepEqual(
    sourceAfter,
    sourceBefore,
    'Original triplet changed during raw capture; refuse unstable evidence',
  );
  for (const entry of readdirSync(raw))
    copyFileSync(join(raw, entry), join(seed, entry), constants.COPYFILE_EXCL);
  const consistentPath = join(directory, 'consistent.sqlite');
  const seedDb = new Database(join(seed, basename(databasePath)), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    seedDb.pragma('query_only = ON');
    await seedDb.backup(consistentPath);
  } finally {
    seedDb.close();
  }
  const checkDb = new Database(consistentPath, { readonly: true, fileMustExist: true });
  let checks;
  try {
    checkDb.pragma('query_only = ON');
    checks = {
      integrity: checkDb.pragma('integrity_check', { simple: true }),
      foreignKeys: checkDb.pragma('foreign_key_check'),
    };
  } finally {
    checkDb.close();
  }
  assert.equal(checks.integrity, 'ok');
  assert.deepEqual(checks.foreignKeys, []);
  const facts = collectFacts(consistentPath, runId);
  const workspaceFiles = Object.fromEntries(
    readdirSync(workspace)
      .filter((name) => statSync(join(workspace, name)).isFile())
      .map((name) => [name, fileFact(join(workspace, name))]),
  );
  const readLedger = (path) =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const snapshot = {
    stage,
    capturedAt: new Date().toISOString(),
    processState,
    rawTriplet: { directory: raw, sourceBefore, sourceAfter, copiedBeforeAnySQLiteOpen: true },
    consistentPath,
    checks,
    workspaceFiles,
    verifierLedger: readLedger(verifierLedger),
    controllerLedger: readLedger(controllerLedger),
    facts,
  };
  writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  for (const suffix of ['', '-wal', '-shm'])
    if (sourceBefore[suffix || 'main'].exists)
      assert.equal(
        fileFact(join(raw, basename(databasePath) + suffix)).sha256,
        sourceBefore[suffix || 'main'].sha256,
        'Raw archive was mutated',
      );
  return snapshot;
}
export function snapshotSummary(snapshot) {
  return {
    stage: snapshot.stage,
    capturedAt: snapshot.capturedAt,
    checks: snapshot.checks,
    rawTriplet: snapshot.rawTriplet,
    workspaceFiles: snapshot.workspaceFiles,
    verifierLedger: snapshot.verifierLedger,
    controllerLedger: snapshot.controllerLedger,
    facts: snapshot.facts,
    consistentDatabasePath: snapshot.consistentPath,
    rawPublished: false,
  };
}
export function compareIdentityRows(before, after) {
  return before.every((item) => {
    const current = after.find((row) => row.id === item.id);
    return (
      current &&
      current.attempt === item.attempt &&
      current.step_id === item.step_id &&
      current.mission_id === item.mission_id &&
      current.mission_run_id === item.mission_run_id
    );
  });
}
export function stableRowsPreserved(before, after) {
  return before.every((row) => {
    const current = after.find((item) => item.id === row.id);
    return current && digest(JSON.stringify(current)) === digest(JSON.stringify(row));
  });
}
export function describeRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}
