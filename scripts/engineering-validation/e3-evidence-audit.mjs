import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { evaluateCase } from './e3-invariants.mjs';

const root = process.cwd();
const evidence = join(root, 'docs/evidence/v1-engineering-validation/e3');
const read = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
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
const aDirectory = join(evidence, 'CR_A-64e44b53-bcc2-44c9-8d07-352fade461ac');
const bDirectory = join(evidence, 'CR_B-219de96c-32de-4534-b909-7de476dcc490');
const a = read(join(aDirectory, 'execution.json'));
const b = read(join(bDirectory, 'execution.json'));
// Execution summaries omit processState; assertions consume the original full stage captures.
for (const [directory, execution] of [
  [aDirectory, a],
  [bDirectory, b],
]) {
  for (const name of Object.keys(execution.stages))
    execution.stages[name] = read(join(directory, name + '.json'));
}
const offlineLog = readFileSync(join(evidence, 'recovery-targeted-results.txt'), 'utf8');
const offlineRetryTestPassed = /3 passed/.test(offlineLog) && /exitCode=0/.test(offlineLog);
assert.ok(offlineRetryTestPassed, 'Keep independent REC-08 evidence separate from formal CR-B');
const evaluate = (scenario, execution, afterKill) =>
  evaluateCase({
    scenario,
    beforeCrash: execution.stages.BeforeCrash,
    afterKill: afterKill ?? execution.stages.AfterKill,
    firstRestart: execution.stages.FirstRestart,
    explicitContinue: execution.stages.ExplicitContinue,
    secondRestart: execution.stages.SecondRestart,
    offlineRetryTestPassed,
  });
const aAfterKill = read(join(aDirectory, 'AfterKillVerifiedLedger.json'));
const invariantResults = { CR_A: evaluate('CR_A', a, aAfterKill), CR_B: evaluate('CR_B', b) };
write(join(evidence, 'recovery-invariants.json'), invariantResults);

const snapshots = {
  CR_A: { BeforeCrash: a.stages.BeforeCrash, AfterKillVerifiedLedger: aAfterKill },
  CR_B: b.stages,
};
const audit = [];
for (const [scenario, stages] of Object.entries(snapshots)) {
  for (const [stage, snapshot] of Object.entries(stages)) {
    const consistentPath = snapshot.consistentPath ?? snapshot.consistentDatabasePath;
    const db = new Database(consistentPath, { readonly: true, fileMustExist: true });
    let integrity, foreignKeys;
    try {
      db.pragma('query_only = ON');
      integrity = db.pragma('integrity_check', { simple: true });
      foreignKeys = db.pragma('foreign_key_check');
    } finally {
      db.close();
    }
    assert.equal(integrity, 'ok');
    assert.deepEqual(foreignKeys, []);
    const rawTripletChecks = Object.entries(snapshot.rawTriplet.sourceBefore).map(
      ([suffix, fact]) => {
        if (!fact.exists) return { suffix, existed: false };
        const path = join(
          snapshot.rawTriplet.directory,
          'cultivation.sqlite' + (suffix === 'main' ? '' : suffix),
        );
        assert.equal(hash(readFileSync(path)), fact.sha256);
        return { suffix, existed: true, sha256: fact.sha256 };
      },
    );
    const artifactHashes = snapshot.facts.workflow_artifacts.map((artifact) => {
      const computed = hash(
        JSON.stringify(
          stable({ content: artifact.content, metadata: JSON.parse(artifact.metadata_json) }),
        ),
      );
      assert.equal(
        computed,
        artifact.content_hash,
        'Recompute production canonical artifact hash: ' + artifact.id,
      );
      return {
        id: artifact.id,
        producerStepRunId: artifact.producer_step_run_id,
        sha256: computed,
      };
    });
    const step = snapshot.facts.steps.find(
      (item) => item.step_id === (scenario === 'CR_A' ? 'S06' : 'S05'),
    );
    const missionRun = snapshot.facts.missionRuns.find((item) => item.id === step?.mission_run_id);
    audit.push({
      scenario,
      stage,
      integrity,
      foreignKeys,
      rawTripletChecks,
      rawTripletCapturedBeforeSQLiteOpen: snapshot.rawTriplet.copiedBeforeAnySQLiteOpen,
      artifactHashes,
      workflowRunId: snapshot.facts.workflow.id,
      workflowState: snapshot.facts.workflow.state,
      workflowWaitReason: snapshot.facts.workflow.wait_reason,
      step,
      missionRun,
      artifacts: snapshot.facts.workflow_artifacts.length,
      validations: snapshot.facts.workflow_validation_receipts.length,
      checkpoints: snapshot.facts.workflow_checkpoints.map((item) => item.id),
      modelCalls: snapshot.facts.counts['model.call_started'] ?? 0,
      toolResults: snapshot.facts.counts['tool.result'] ?? 0,
      independentWrites: snapshot.controllerLedger
        .filter((item) => ['WRITE_ENTRY', 'WRITE_RETURN'].includes(item.event))
        .map(({ event, generation, path, at }) => ({ event, generation, path, at })),
      observers: snapshot.controllerLedger.filter((item) => item.event === 'OBSERVER_ARMED'),
      verifierLedger: snapshot.verifierLedger,
    });
  }
}
write(join(evidence, 'sqlite-and-fact-audit.json'), {
  status: 'PASS_FOR_CAPTURED_STAGES',
  missingRequiredStages: ['CR_A.FirstRestart', 'CR_A.ExplicitContinue', 'CR_A.SecondRestart'],
  audit,
});

// Publish the unmodified independent ledgers. Original raw databases remain in ignored E-drive isolation.
for (const execution of [a, b]) {
  const destination = join(evidence, execution.token);
  for (const name of ['independent-controller.ndjson', 'verification-events.ndjson']) {
    const source = join(execution.runRoot, 'raw-controller', name);
    if (existsSync(source)) copyFileSync(source, join(destination, name));
  }
  const rawController = join(execution.runRoot, 'raw-controller');
  for (const name of readdirSync(rawController).filter((item) =>
    item.startsWith('process-Terminate-'),
  ))
    copyFileSync(join(rawController, name), join(destination, name));
}
const smokeAudit = {
  status: 'BLOCKED',
  execution: 'NOT_RUN',
  reason:
    'Full recursive smoke chain contains PID-only forced termination and application self-kill paths without the E3-required creation-time, executable and isolated-profile identity revalidation. This is a current audit result, not a carry-over of the E1 kill prohibition.',
  references: [
    { path: 'scripts/r3-1-crash-packaged-smoke.mjs', line: 45, mechanism: 'taskkill /PID /T /F' },
    { path: 'scripts/w1-packaged-smoke.mjs', line: 67, mechanism: 'taskkill /PID /T /F' },
    { path: 'scripts/w2-packaged-smoke.mjs', line: 61, mechanism: 'taskkill /PID /T /F' },
    { path: 'scripts/g1-packaged-smoke.mjs', line: 34, mechanism: 'process.kill SIGKILL' },
    { path: 'scripts/g2-packaged-smoke.mjs', line: 74, mechanism: 'process.kill SIGKILL' },
    {
      path: 'apps/desktop/src/main/main.ts',
      line: 1366,
      mechanism: 'test-flag-triggered self termination',
    },
  ],
  additionalIsolationGaps: [
    'Inherited system Profile and TEMP environment',
    'Some fixed docs/evidence outputs can replace historical evidence',
  ],
  paidLiveHarnesses: 'NOT_RUN; outside E3 scope; no keys read',
};
write(join(evidence, 'full-smoke-safety-audit.json'), smokeAudit);
const summary = {
  generatedAt: new Date().toISOString(),
  overall: Object.values(invariantResults).some((result) => result.status === 'FAIL')
    ? 'E3_FAIL'
    : 'E3_CONDITIONAL',
  statuses: {
    E3_CR_A_PACKAGED: 'BLOCKED',
    E3_CR_B_PACKAGED: invariantResults.CR_B.status,
    E3_RECOVERY_INVARIANTS:
      invariantResults.CR_A.status === 'PASS' && invariantResults.CR_B.status === 'PASS'
        ? 'PASS'
        : Object.values(invariantResults).some((result) => result.status === 'FAIL')
          ? 'FAIL'
          : 'BLOCKED',
    E3_REPRODUCIBILITY: 'BLOCKED',
    E3_SQLITE_INTEGRITY: 'BLOCKED',
    E3_BASELINE_PRESERVATION: 'PASS',
  },
  reasons: {
    CR_A: 'Formal breakpoint succeeded. Main and verified original children are absent, but child identity revalidation interrupted the termination controller. Case stopped, without another kill or recovery restart.',
    reproducibility:
      'CR-B completed the full process experiment; CR-A did not complete required recovery stages.',
    sqlite:
      'Every captured original triplet and derived consistency copy passed verification. Required CR-A restart stages were NOT_RUN, so complete two-case SQLite coverage is BLOCKED.',
  },
  cases: { CR_A: a.token, CR_B: b.token },
  offlineRetryTestPassed,
  invariantResults,
  productionChanges: 0,
  paidProviderCalls: 0,
  commitOrPush: false,
};
write(join(evidence, 'result-summary.json'), summary);
console.log(
  JSON.stringify(
    {
      overall: summary.overall,
      statuses: summary.statuses,
      checks: Object.fromEntries(
        Object.entries(invariantResults).map(([scenario, value]) => [
          scenario,
          value.checks.map(({ id, status, details }) => ({ id, status, details })),
        ]),
      ),
      capturedStages: audit.length,
      paths: { summary: relative(root, join(evidence, 'result-summary.json')) },
    },
    null,
    2,
  ),
);
