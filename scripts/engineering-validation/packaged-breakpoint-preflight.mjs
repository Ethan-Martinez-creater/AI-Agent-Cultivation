import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';

// Diagnostic-only E1 preflight. This helper deliberately never launches the app,
// evaluates application code, or issues SQL writes against the isolated source.
// SQLite may create WAL/SHM sidecars even when the connection is read-only.
const profileRoot = resolve(process.env.E1_PROFILE_ROOT || '');
const evidenceRoot = resolve(process.env.E1_EVIDENCE_ROOT || '');
if (
  !profileRoot ||
  !evidenceRoot ||
  profileRoot === process.cwd() ||
  evidenceRoot === process.cwd()
) {
  throw new Error('Set E1_PROFILE_ROOT and E1_EVIDENCE_ROOT to explicit isolated E: paths.');
}
if (!/^E:[\\/]/i.test(profileRoot) || !/^E:[\\/]/i.test(evidenceRoot)) {
  throw new Error('Refusing any non-E: profile/evidence path.');
}
if (![profileRoot, evidenceRoot].every((path) => /[\\/](?:\.tmp|\.test-data)[\\/]/i.test(path))) {
  throw new Error(
    'Keep profile and binary backup artifacts inside isolated .tmp/.test-data paths.',
  );
}
const sourcePath = join(profileRoot, 'UserData', 'data', 'cultivation.sqlite');
const backupPath = join(evidenceRoot, 'cr-a-online-backup.sqlite');
if (!existsSync(sourcePath)) throw new Error(`Isolated source DB missing: ${sourcePath}`);
if (existsSync(backupPath)) throw new Error(`Refusing to overwrite existing backup: ${backupPath}`);

const hashFile = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fileState = (file) =>
  existsSync(file)
    ? {
        exists: true,
        sizeBytes: statSync(file).size,
        sha256: hashFile(file),
        lastWriteTime: statSync(file).mtime.toISOString(),
      }
    : { exists: false };
const sidecars = (stage) => ({
  stage,
  wal: fileState(`${sourcePath}-wal`),
  shm: fileState(`${sourcePath}-shm`),
});

const sourceBefore = fileState(sourcePath);
const sidecarsBefore = sidecars('before-online-backup');
const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 5000 });
let backupProgress;
let sourceChecks;
try {
  sourceDb.pragma('query_only = ON');
  sourceChecks = {
    queryOnly: sourceDb.pragma('query_only', { simple: true }),
    journalMode: sourceDb.pragma('journal_mode', { simple: true }),
    integrityCheck: sourceDb.pragma('integrity_check').map((row) => Object.values(row)[0]),
    tableCount: sourceDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()
      .n,
  };
  backupProgress = await sourceDb.backup(backupPath);
} finally {
  sourceDb.close();
}
const sidecarsAfter = sidecars('after-online-backup');
const sourceAfter = fileState(sourcePath);
const backupBeforeVerify = fileState(backupPath);

const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true, timeout: 5000 });
let verification;
try {
  backupDb.pragma('query_only = ON');
  verification = {
    queryOnly: backupDb.pragma('query_only', { simple: true }),
    journalMode: backupDb.pragma('journal_mode', { simple: true }),
    integrityCheck: backupDb.pragma('integrity_check').map((row) => Object.values(row)[0]),
    foreignKeyViolations: backupDb.pragma('foreign_key_check').length,
    schemaVersion: backupDb.pragma('schema_version', { simple: true }),
  };
} finally {
  backupDb.close();
}
const backupAfterVerify = fileState(backupPath);
assert.equal(sourceBefore.sha256, sourceAfter.sha256);
assert.equal(backupBeforeVerify.sha256, backupAfterVerify.sha256);
assert.equal(verification.queryOnly, 1);
assert.deepEqual(verification.integrityCheck, ['ok']);
assert.equal(verification.foreignKeyViolations, 0);

const report = {
  purpose:
    'P6 read-only SQLite online-backup feasibility; no app launch/kill/restart or source SQL writes; WAL/SHM sidecars may be created',
  observedAt: new Date().toISOString(),
  sourcePath,
  sourceReadonly: true,
  sourceBefore,
  sourceAfter,
  sourceUnchangedDuringBackup: sourceBefore.sha256 === sourceAfter.sha256,
  sidecarsBefore,
  sidecarsAfter,
  sourceChecks,
  backupPath,
  backupPages: backupProgress,
  backupBeforeVerify,
  backupAfterVerify,
  backupHashFrozenDuringVerification: backupBeforeVerify.sha256 === backupAfterVerify.sha256,
  verification,
};
process.stdout.write(JSON.stringify(report, null, 2));
