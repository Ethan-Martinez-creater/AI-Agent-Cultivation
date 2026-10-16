import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { URL } from 'node:url';
import Database from 'better-sqlite3';
import { evaluateCorrective } from './recovery-adapter.mjs';

const root = process.cwd();
const evidence = join(root, 'docs/evidence/v1-engineering-validation/e3/cr-a-corrective');
/** @param {string} path @returns {any} */
const read = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
/** @param {string} path @param {any} value */
const write = (path, value) => {
  if (existsSync(path)) {
    const history = join(evidence, 'analysis-history');
    mkdirSync(history, { recursive: true });
    copyFileSync(path, join(history, basename(path) + '.' + randomUUID() + '.json'));
  }
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
};
/** @param {string | Buffer} value */
const hash = (value) => createHash('sha256').update(value).digest('hex');
/** @param {any} value @returns {any} */
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;
const caseToken = process.argv[2];
assert.ok(
  caseToken && /^CR_A_CORRECTIVE-[a-f0-9-]+$/i.test(caseToken),
  'Supply this new corrective CR_A case token explicitly',
);
const publication = join(evidence, caseToken);
const execution = read(join(publication, 'execution.json'));
assert.ok(execution.runRoot.replaceAll('\\', '/').includes('/.tmp/e3-corrective-runtime/'));
const offlineLog = readFileSync(join(evidence, 'recovery-targeted-results.txt'), 'utf8');
const offlineRetryTestPassed = /3 passed/.test(offlineLog) && /exitCode=0/.test(offlineLog);
/** @type {Record<string, any>} */
const stages = {};
for (const name of [
  'BeforeCrash',
  'AfterKill',
  'FirstRestartBeforeContinue',
  'ExplicitContinue',
  'SecondRestart',
]) {
  const path = join(publication, name + '.json');
  if (existsSync(path)) stages[name] = read(path);
}
const input = {
  beforeCrash: stages.BeforeCrash,
  afterKill: stages.AfterKill,
  firstRestart: stages.FirstRestartBeforeContinue,
  explicitContinue: stages.ExplicitContinue,
  secondRestart: stages.SecondRestart,
  offlineRetryTestPassed,
};
const invariants = evaluateCorrective(input);
write(join(publication, 'recovery-invariants-corrective.json'), invariants);
const historicalDirectory = join(
  root,
  'docs/evidence/v1-engineering-validation/e3/CR_B-219de96c-32de-4534-b909-7de476dcc490',
);
const historicalSummary = read(
  join(root, 'docs/evidence/v1-engineering-validation/e3/result-summary.json'),
);
assert.equal(historicalSummary.statuses.E3_CR_B_PACKAGED, 'PASS');
const legacyModule = await import(new URL('../e3-invariants.mjs', import.meta.url).href);
const historicalB = legacyModule.evaluateCase({
  scenario: 'CR_B',
  beforeCrash: read(join(historicalDirectory, 'BeforeCrash.json')),
  afterKill: read(join(historicalDirectory, 'AfterKill.json')),
  firstRestart: read(join(historicalDirectory, 'FirstRestart.json')),
  secondRestart: read(join(historicalDirectory, 'SecondRestart.json')),
  offlineRetryTestPassed,
});
write(join(evidence, 'historical-cr-b-reference.json'), {
  status: historicalB.status,
  execution: 'NOT_RERUN',
  originalCase: basename(historicalDirectory),
  originalCaseToken: historicalSummary.cases.CR_B,
  originalRunId: read(join(historicalDirectory, 'BeforeCrash.json')).facts.workflow.id,
  analysisCorrection:
    'CR-B REC-09 compares FirstRestart and SecondRestart confirmation wait. No explicit continuation occurred. The historical Final continuation wording and raw assertion output remain unchanged.',
  originalAssertionResult: historicalB,
});
/** @type {any[]} */
const factAudit = [];
for (const [scenario, selected] of Object.entries({
  CR_A_CORRECTIVE: stages,
  CR_B_HISTORICAL: {
    BeforeCrash: read(join(historicalDirectory, 'BeforeCrash.json')),
    AfterKill: read(join(historicalDirectory, 'AfterKill.json')),
    FirstRestart: read(join(historicalDirectory, 'FirstRestart.json')),
    SecondRestart: read(join(historicalDirectory, 'SecondRestart.json')),
  },
})) {
  for (const [stage, snapshot] of Object.entries(selected)) {
    const db = new Database(snapshot.consistentPath, { readonly: true, fileMustExist: true });
    let integrity;
    let foreignKeys;
    try {
      db.pragma('query_only = ON');
      integrity = db.pragma('integrity_check', { simple: true });
      foreignKeys = db.pragma('foreign_key_check');
    } finally {
      db.close();
    }
    assert.equal(integrity, 'ok');
    assert.deepEqual(foreignKeys, []);
    /** @type {any[]} */
    const rawHashes = [];
    for (const [suffix, fact] of Object.entries(
      /** @type {Record<string, any>} */ (snapshot.rawTriplet.sourceBefore),
    )) {
      if (!fact.exists) {
        rawHashes.push({ suffix, exists: false });
        continue;
      }
      const path = join(
        snapshot.rawTriplet.directory,
        'cultivation.sqlite' + (suffix === 'main' ? '' : suffix),
      );
      assert.equal(hash(readFileSync(path)), fact.sha256, 'Raw archive changed: ' + path);
      rawHashes.push({ suffix, exists: true, sha256: fact.sha256 });
    }
    /** @type {any[]} */
    const artifactHashes = [];
    for (const artifact of snapshot.facts.workflow_artifacts) {
      const computed = hash(
        JSON.stringify(
          stable({ content: artifact.content, metadata: JSON.parse(artifact.metadata_json) }),
        ),
      );
      assert.equal(
        computed,
        artifact.content_hash,
        'Canonical Artifact hash differs: ' + artifact.id,
      );
      artifactHashes.push({
        id: artifact.id,
        producerStepRunId: artifact.producer_step_run_id,
        sha256: computed,
      });
    }
    const targetStep = snapshot.facts.steps.find(
      /** @param {any} step */ (step) =>
        step.step_id === (scenario === 'CR_A_CORRECTIVE' ? 'S06' : 'S05'),
    );
    factAudit.push({
      scenario,
      stage,
      capturedAt: snapshot.capturedAt,
      processState: snapshot.processState,
      integrity,
      foreignKeys,
      rawHashes,
      artifactHashes,
      workflow: snapshot.facts.workflow,
      steps: snapshot.facts.steps,
      targetStep,
      counts: snapshot.facts.counts,
      artifactCount: snapshot.facts.workflow_artifacts.length,
      validationCount: snapshot.facts.workflow_validation_receipts.length,
      checkpointCount: snapshot.facts.workflow_checkpoints.length,
      checkpoints: snapshot.facts.workflow_checkpoints,
      verifierLedger: snapshot.verifierLedger,
      controllerLedger: snapshot.controllerLedger,
      workspaceFiles: snapshot.workspaceFiles,
    });
  }
}
write(join(evidence, 'sqlite-and-fact-audit.json'), {
  status: stages.SecondRestart ? 'PASS' : 'BLOCKED',
  caseToken,
  historicalBExecution: 'NOT_RERUN',
  factAudit,
});
for (const name of readdirSync(join(execution.runRoot, 'raw-controller'))) {
  if (
    name.startsWith('process-') ||
    ['independent-controller.ndjson', 'verification-events.ndjson'].includes(name)
  ) {
    const source = join(execution.runRoot, 'raw-controller', name);
    const destination = join(publication, name);
    if (existsSync(destination))
      assert.equal(
        hash(readFileSync(destination)),
        hash(readFileSync(source)),
        'Refuse raw evidence overwrite: ' + name,
      );
    else copyFileSync(source, destination);
  }
}
const complete =
  execution.status === 'EXECUTION_COMPLETE_PENDING_INVARIANTS' &&
  execution.killOrdinal === 1 &&
  execution.termination?.status === 'TERMINATED' &&
  execution.termination?.allOriginalIdentitiesAbsent === true &&
  execution.generations.length === 3 &&
  Object.keys(stages).length === 5;
const correctiveStatus =
  invariants.status === 'FAIL'
    ? 'FAIL'
    : complete && invariants.status === 'PASS'
      ? 'PASS'
      : 'BLOCKED';
const completeCoverage = correctiveStatus === 'PASS' && historicalB.status === 'PASS';
const overall =
  correctiveStatus === 'FAIL' || historicalB.status === 'FAIL'
    ? 'E3_FAIL'
    : completeCoverage
      ? 'E3_PASS'
      : 'E3_CONDITIONAL';
write(join(evidence, 'result-summary.json'), {
  generatedAt: new Date().toISOString(),
  overall,
  caseToken,
  runId: execution.runId,
  statuses: {
    E3_CR_A_CORRECTIVE: correctiveStatus,
    E3_CR_B_HISTORICAL: historicalB.status,
    E3_RECOVERY_INVARIANTS: completeCoverage
      ? 'PASS'
      : correctiveStatus === 'FAIL'
        ? 'FAIL'
        : 'BLOCKED',
    E3_REPRODUCIBILITY: completeCoverage ? 'PASS' : 'BLOCKED',
    E3_SQLITE_INTEGRITY: completeCoverage ? 'PASS' : 'BLOCKED',
    E3_BASELINE_PRESERVATION: 'PENDING_FINAL_AUDIT',
  },
  invariants,
  historicalBReferencedWithoutRerun: true,
  rawHistoricalEvidenceModified: false,
  offlineRetryTestPassed,
  noProductChanges: true,
  paidProviderCalls: 0,
  commitOrPush: false,
});
console.log(
  JSON.stringify(
    {
      overall,
      correctiveStatus,
      complete,
      checks: invariants.checks,
      historicalB: historicalB.status,
    },
    null,
    2,
  ),
);
