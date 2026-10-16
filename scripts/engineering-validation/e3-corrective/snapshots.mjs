// @ts-check
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

/** @typedef {string | number | bigint | Uint8Array | null} DbScalar */
/** @typedef {Record<string, DbScalar>} DbRow */
/**
 * The frozen database schema is queried dynamically so every table can be
 * captured without baking a migration-specific row type into the evidence.
 * Validate the SQLite driver boundary before treating its rows as records.
 * @param {unknown} value
 * @returns {DbRow[]}
 */
function asRows(value) {
  if (!Array.isArray(value)) throw new TypeError('SQLite query did not return rows');
  return value.map((row) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      throw new TypeError('SQLite row is not an object');
    for (const item of Object.values(row)) {
      if (
        item !== null &&
        typeof item !== 'string' &&
        typeof item !== 'number' &&
        typeof item !== 'bigint' &&
        !(item instanceof Uint8Array)
      )
        throw new TypeError('Unsupported SQLite value in dynamic row');
    }
    return /** @type {DbRow} */ (row);
  });
}

/** @param {DbRow} row @param {string} column @returns {string | undefined} */
function textColumn(row, column) {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}
/** @param {string | Uint8Array} value */
export const digest = (value) => createHash('sha256').update(value).digest('hex');
/** @param {string} path */
export function fileFact(path) {
  return existsSync(path)
    ? { exists: true, bytes: statSync(path).size, sha256: digest(readFileSync(path)) }
    : { exists: false };
}
/**
 * @param {Database.Database} db
 * @param {string} table
 * @param {string} [condition]
 * @param {Array<string | number | null>} [params]
 * @returns {DbRow[]}
 */
function rows(db, table, condition = '', params = []) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    return [];
  return asRows(db.prepare(`SELECT * FROM ${table} ${condition} ORDER BY rowid`).all(...params));
}
/**
 * @param {string} database
 * @param {string} runId
 */
export function collectFacts(database, runId) {
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const workflow = rows(db, 'workflow_runs', 'WHERE id=?', [runId])[0];
    const steps = rows(db, 'workflow_step_runs', 'WHERE workflow_run_id=?', [runId]);
    const missionIds = [
      ...new Set(steps.map((step) => textColumn(step, 'mission_id')).filter((id) => id !== undefined)),
    ];
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
      [...new Set(missionEvents.map((event) => textColumn(event, 'event_type')).filter((type) => type !== undefined))]
        .sort()
        .map((type) => [type, missionEvents.filter((event) => textColumn(event, 'event_type') === type).length]),
    );
    return {
      workflow,
      steps,
      missions,
      missionRuns,
      missionEvents,
      ...related,
      counts,
      frozenVersions: asRows(
        db
          .prepare(
            'SELECT definition_id,version,content_hash FROM workflow_versions ORDER BY definition_id',
          )
          .all(),
      ),
      frozenReleases: asRows(
        db
          .prepare(
            'SELECT definition_id,version,manifest_hash FROM workflow_builtin_releases ORDER BY definition_id',
          )
          .all(),
      ),
      migrationCount: Number(
        textColumn(
          /** @type {DbRow} */ (
            asRows(db.prepare('SELECT count(*) n FROM schema_migrations').all())[0] ?? { n: 0 }
          ),
          'n',
        ),
      ),
    };
  } finally {
    db.close();
  }
}
/**
 * @param {{stageRoot:string,stage:string,databasePath:string,workspace:string,verifierLedger:string,controllerLedger:string,runId:string,processState:Record<string,unknown>}} options
 */
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
  assert.match(stageRoot, /^E:[\\/].*[\\/]\.tmp[\\/]e3-corrective-runtime[\\/]/i);
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
    const sourceFact = sourceBefore[suffix || 'main'];
    assert.ok(sourceFact, 'Triplet fact missing for copied database member');
    const destination = join(raw, basename(databasePath) + suffix);
    copyFileSync(databasePath + suffix, destination, constants.COPYFILE_EXCL);
    assert.equal(fileFact(destination).sha256, sourceFact.sha256);
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
  /** @param {string} path */
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
  for (const suffix of ['', '-wal', '-shm']) {
    const sourceFact = sourceBefore[suffix || 'main'];
    assert.ok(sourceFact, 'Triplet fact missing during archive verification');
    if (sourceFact.exists)
      assert.equal(
        fileFact(join(raw, basename(databasePath) + suffix)).sha256,
        sourceFact.sha256,
        'Raw archive was mutated',
      );
  }
  return snapshot;
}
/** @param {Awaited<ReturnType<typeof captureStage>>} snapshot */
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
/** @param {DbRow[]} before @param {DbRow[]} after */
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
/** @param {DbRow[]} before @param {DbRow[]} after */
export function stableRowsPreserved(before, after) {
  return before.every((row) => {
    const current = after.find((item) => item.id === row.id);
    return current && digest(JSON.stringify(current)) === digest(JSON.stringify(row));
  });
}
/** @param {string} root @param {string} path */
export function describeRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}
