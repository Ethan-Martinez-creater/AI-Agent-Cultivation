import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';

// No app launch: exercise SQLite's online-backup API against a disposable E: clone.
const profileRoot = resolve(process.env.E1_PROFILE_ROOT || '');
const evidenceRoot = resolve(process.env.E1_EVIDENCE_ROOT || '');
if (!/^E:[\\/]/i.test(profileRoot) || !/^E:[\\/]/i.test(evidenceRoot))
  throw new Error('Refusing non-E: source/evidence paths.');
if (![profileRoot, evidenceRoot].every((path) => /[\\/](?:\.tmp|\.test-data)[\\/]/i.test(path)))
  throw new Error('Keep binary backup artifacts inside isolated .tmp/.test-data paths.');
const originalDbPath = join(profileRoot, 'UserData', 'data', 'cultivation.sqlite');
const templatePath = join(evidenceRoot, 'cr-a-online-backup.sqlite');
const labDbPath = join(evidenceRoot, 'p6-live-wal-lab.sqlite');
const labBackupPath = join(evidenceRoot, 'p6-live-wal-consistent-backup.sqlite');
if (!existsSync(originalDbPath) || !existsSync(templatePath))
  throw new Error('Required isolated DB/template is missing.');
if (labDbPath === originalDbPath)
  throw new Error('Refusing to open the original profile DB as the lab DB.');
if (existsSync(labDbPath) || existsSync(labBackupPath))
  throw new Error('Refusing to overwrite an existing lab artifact.');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fileState = (path) =>
  existsSync(path)
    ? {
        exists: true,
        sizeBytes: statSync(path).size,
        sha256: sha256(path),
        lastWriteTime: statSync(path).mtime.toISOString(),
      }
    : { exists: false };
const trio = (stage) => ({
  stage,
  db: fileState(labDbPath),
  wal: fileState(`${labDbPath}-wal`),
  shm: fileState(`${labDbPath}-shm`),
});
const originalBefore = fileState(originalDbPath);
const templateHash = sha256(templatePath);
copyFileSync(templatePath, labDbPath);
const cloneBefore = fileState(labDbPath);
let writer;
let reader;
let verifier;
let report;
try {
  writer = new Database(labDbPath, { timeout: 5000 });
  const journalMode = writer.pragma('journal_mode = WAL', { simple: true });
  writer.pragma('wal_autocheckpoint = 0');
  writer.pragma('user_version = 4242'); // Lab marker only; no business schema or records.
  const writerMarker = writer.pragma('user_version', { simple: true });
  const afterMarker = trio('writer-open-after-marker');
  if (!afterMarker.wal.exists || afterMarker.wal.sizeBytes <= 32 || writerMarker !== 4242)
    throw new Error('Lab did not create a non-empty WAL with the committed marker.');

  reader = new Database(labDbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  reader.pragma('query_only = ON');
  const readerMarker = reader.pragma('user_version', { simple: true });
  const readonlyQueryOnly = reader.pragma('query_only', { simple: true });
  const beforeBackup = trio('writer-open-before-online-backup');
  const progress = await reader.backup(labBackupPath);
  const afterBackup = trio('writer-open-after-online-backup');

  const backupBeforeVerify = fileState(labBackupPath);
  verifier = new Database(labBackupPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  verifier.pragma('query_only = ON');
  const verification = {
    queryOnly: verifier.pragma('query_only', { simple: true }),
    userVersion: verifier.pragma('user_version', { simple: true }),
    integrityCheck: verifier.pragma('integrity_check').map((row) => Object.values(row)[0]),
    foreignKeyViolations: verifier.pragma('foreign_key_check').length,
  };
  verifier.close();
  verifier = undefined;
  const backupAfterVerify = fileState(labBackupPath);
  const beforeWriterClose = trio('before-normal-writer-close');
  if (
    readerMarker !== 4242 ||
    verification.userVersion !== 4242 ||
    readonlyQueryOnly !== 1 ||
    verification.queryOnly !== 1 ||
    verification.integrityCheck.length !== 1 ||
    verification.integrityCheck[0] !== 'ok' ||
    verification.foreignKeyViolations !== 0 ||
    backupBeforeVerify.sha256 !== backupAfterVerify.sha256
  )
    throw new Error('One or more read-only backup verification assertions failed.');
  report = {
    purpose:
      'Synthetic non-empty live-WAL online-backup method test; no app launch and no business-schema mutation',
    observedAt: new Date().toISOString(),
    status: 'PASS',
    originalProfileDb: {
      path: originalDbPath,
      sha256Before: originalBefore.sha256,
      sha256After: sha256(originalDbPath),
      unchanged: originalBefore.sha256 === sha256(originalDbPath),
    },
    template: { path: templatePath, sha256: templateHash },
    labClone: {
      path: labDbPath,
      initialCloneSha256: cloneBefore.sha256,
      derivedFromTemplate: true,
      differsFromOriginalPath: labDbPath !== originalDbPath,
    },
    writer: { journalMode, walAutoCheckpoint: 0, writerMarker, markerIsLabOnly: true, afterMarker },
    readonlyReader: {
      queryOnly: readonlyQueryOnly,
      visibleMarker: readerMarker,
      beforeBackup,
      afterBackup,
    },
    backup: {
      path: labBackupPath,
      pages: progress,
      beforeVerify: backupBeforeVerify,
      afterVerify: backupAfterVerify,
      hashFrozenDuringVerification: backupBeforeVerify.sha256 === backupAfterVerify.sha256,
      verification,
    },
    sourceTrioBeforeWriterClose: beforeWriterClose,
  };
} catch (error) {
  report = {
    purpose: 'Synthetic non-empty live-WAL online-backup method test',
    observedAt: new Date().toISOString(),
    status: 'FAIL',
    error: String(error),
    originalProfileDb: {
      path: originalDbPath,
      sha256Before: originalBefore.sha256,
      sha256After: existsSync(originalDbPath) ? sha256(originalDbPath) : null,
    },
  };
} finally {
  try {
    if (verifier && verifier.open) verifier.close();
  } catch {
    /* Preserve the diagnostic result on close failure. */
  }
  try {
    if (reader && reader.open) reader.close();
  } catch {
    /* Preserve the diagnostic result on close failure. */
  }
  try {
    if (writer && writer.open) writer.close();
  } catch {
    /* Preserve the diagnostic result on close failure. */
  }
  report = { ...report, sourceTrioAfterNormalLabClose: trio('after-normal-lab-writer-close') };
}
report.originalProfileDb.sha256After = existsSync(originalDbPath) ? sha256(originalDbPath) : null;
report.originalProfileDb.unchanged =
  report.originalProfileDb.sha256Before === report.originalProfileDb.sha256After;
process.stdout.write(JSON.stringify(report, null, 2));
if (report.status !== 'PASS' || !report.originalProfileDb.unchanged) process.exitCode = 1;
