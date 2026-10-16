import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCase } from './e3-invariants.mjs';
const { structuredClone } = globalThis;

// Negative controls alter in-memory evidence only; they never open or change a product database.
const directory = join(process.cwd(), 'docs/evidence/v1-engineering-validation/e3');
const caseDirectory = join(directory, 'CR_B-219de96c-32de-4534-b909-7de476dcc490');
const read = (stage) => JSON.parse(readFileSync(join(caseDirectory, stage + '.json'), 'utf8'));
const original = {
  scenario: 'CR_B',
  beforeCrash: read('BeforeCrash'),
  afterKill: read('AfterKill'),
  firstRestart: read('FirstRestart'),
  secondRestart: read('SecondRestart'),
  offlineRetryTestPassed: true,
};
assert.equal(evaluateCase(original).status, 'PASS');
const targetStep = (input) => input.firstRestart.facts.steps.find((step) => step.step_id === 'S05');
const targetJournal = (input) => input.firstRestart.facts.workflow_workspace_mutation_journal[0];
const controls = [
  [
    'REC-01',
    (input) => {
      targetStep(input).attempt++;
    },
  ],
  [
    'REC-02',
    (input) => {
      const event = input.firstRestart.facts.missionEvents.find(
        (item) =>
          item.event_type === 'model.call_started' &&
          item.mission_id === targetStep(input).mission_id,
      );
      input.firstRestart.facts.missionEvents.push({
        ...event,
        id: 'negative-control-extra-model-call',
      });
    },
  ],
  [
    'REC-03',
    (input) => {
      input.firstRestart.facts.workflow_artifacts[0].content_hash = 'negative-control-changed-hash';
    },
  ],
  [
    'REC-04',
    (input) => {
      input.firstRestart.controllerLedger.push({
        event: 'WRITE_ENTRY',
        generation: 1,
        path: 'renderer.ts',
        at: new Date().toISOString(),
      });
    },
  ],
  [
    'REC-05',
    (input) => {
      const event = input.firstRestart.facts.missionEvents.find(
        (item) =>
          item.event_type === 'model.call_started' &&
          item.mission_id === targetStep(input).mission_id,
      );
      input.firstRestart.facts.missionEvents.push({
        ...event,
        id: 'negative-control-automatic-resend',
      });
    },
  ],
  [
    'REC-06',
    (input) => {
      targetJournal(input).state = 'APPLIED';
    },
  ],
  [
    'REC-07',
    (input) => {
      targetStep(input).state = 'COMPLETED';
    },
  ],
  [
    'REC-08',
    (input) => {
      input.offlineRetryTestPassed = false;
    },
  ],
  [
    'REC-09',
    (input) => {
      input.secondRestart.facts.workflow_artifacts[0].content_hash =
        'negative-control-second-restart-change';
    },
  ],
  [
    'REC-10',
    (input) => {
      input.secondRestart.checks.integrity = 'negative-control-corruption';
    },
  ],
];
const results = [];
for (const [id, mutate] of controls) {
  const input = structuredClone(original);
  mutate(input);
  const result = evaluateCase(input).checks.find((item) => item.id === id);
  results.push({
    id,
    injectedViolationDetected: result.status === 'FAIL',
    actualStatus: result.status,
    details: result.details,
  });
}
const missing = structuredClone(original);
delete missing.firstRestart;
const missingResult = evaluateCase(missing);
assert.equal(missingResult.status, 'BLOCKED');
writeFileSync(
  join(directory, 'assertion-sensitivity.json'),
  JSON.stringify(
    {
      status: results.every((item) => item.injectedViolationDetected) ? 'PASS' : 'FAIL',
      realEvidenceStatus: 'PASS',
      missingPhaseStatus: missingResult.status,
      results,
      mutatedProductDatabase: false,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
for (const result of results)
  assert.ok(
    result.injectedViolationDetected,
    result.id + ' failed to reject injected evidence violation: ' + result.details,
  );
console.log(
  'PASS: actual CR-B evidence; missing-stage BLOCKED; ten in-memory negative controls rejected.',
);
