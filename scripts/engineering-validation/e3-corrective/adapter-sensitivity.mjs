/**
 * Pure in-memory sensitivity cases for the CR-A corrective assertion adapter.
 * No application, process, database, or filesystem evidence is created.
 */
import assert from 'node:assert/strict';
import { evaluateCorrectiveWithLegacy } from './recovery-adapter.mjs';
const { structuredClone } = globalThis;

const WORKFLOW_ID = 'workflow-test';
const COMPLETED_STEP_ID = 'step-s06';
const UNFINISHED_STEP_ID = 'step-s07';
const COMPLETED_MISSION_ID = 'mission-s06';
const COMPLETED_RUN_ID = 'mission-run-s06';
const NEW_MISSION_ID = 'mission-s07';
const NEW_RUN_ID = 'mission-run-s07';
const REQUIRED_TABLES = [
  'workflow_artifacts',
  'workflow_validation_receipts',
  'workflow_checkpoints',
  'workflow_artifact_bindings',
  'workflow_decisions',
  'workflow_revision_traversals',
  'workflow_events',
  'workflow_step_operation_receipts',
  'workflow_workspace_mutation_journal',
  'workflow_run_output_validations',
];
const REC_IDS = Array.from(
  { length: 10 },
  (_, index) => `REC-${String(index + 1).padStart(2, '0')}`,
);

/** @param {any} value */
function clone(value) {
  return structuredClone(value);
}

/** @returns {Record<string, any>} */
function baselineSnapshot() {
  /** @type {Record<string, any>} */
  const facts = {
    workflow: {
      id: WORKFLOW_ID,
      state: 'RUNNING',
      definition_id: 'official.software-feature',
      definition_version: 1,
    },
    steps: [
      {
        id: COMPLETED_STEP_ID,
        workflow_run_id: WORKFLOW_ID,
        step_id: 'S06',
        attempt: 1,
        state: 'COMPLETED',
        mission_id: COMPLETED_MISSION_ID,
        mission_run_id: COMPLETED_RUN_ID,
        created_at: '2026-10-16T00:00:00.000Z',
        updated_at: '2026-10-16T00:01:00.000Z',
      },
      {
        id: UNFINISHED_STEP_ID,
        workflow_run_id: WORKFLOW_ID,
        step_id: 'S07',
        attempt: 1,
        state: 'READY',
        mission_id: null,
        mission_run_id: null,
        created_at: '2026-10-16T00:02:00.000Z',
        updated_at: '2026-10-16T00:02:00.000Z',
      },
    ],
    missions: [
      {
        id: COMPLETED_MISSION_ID,
        title: 'Frozen S06 Mission',
        state: 'COMPLETED',
        created_at: '2026-10-16T00:00:01.000Z',
      },
    ],
    missionRuns: [
      {
        id: COMPLETED_RUN_ID,
        mission_id: COMPLETED_MISSION_ID,
        attempt: 1,
        status: 'COMPLETED',
        result_text: 'S06 result',
      },
    ],
    missionEvents: [
      {
        id: 'event-s06-created',
        mission_id: COMPLETED_MISSION_ID,
        run_id: null,
        event_type: 'mission.created',
        payload_json: '{}',
        created_at: '2026-10-16T00:00:01.000Z',
      },
    ],
    workflow_artifacts: [
      {
        id: 'artifact-s06',
        workflow_run_id: WORKFLOW_ID,
        producer_step_run_id: COMPLETED_STEP_ID,
        mission_id: COMPLETED_MISSION_ID,
        mission_run_id: COMPLETED_RUN_ID,
        content_hash: 'frozen-artifact-hash',
        content: 'S06 artifact',
      },
    ],
    workflow_validation_receipts: [
      {
        id: 'validation-s06',
        workflow_run_id: WORKFLOW_ID,
        step_run_id: COMPLETED_STEP_ID,
        artifact_id: 'artifact-s06',
        valid: 1,
        content_hash: 'frozen-artifact-hash',
      },
    ],
    workflow_checkpoints: [
      {
        id: 'checkpoint-s06',
        workflow_run_id: WORKFLOW_ID,
        sequence: 6,
        completed_step_run_ids_json: JSON.stringify([COMPLETED_STEP_ID]),
        active_step_run_ids_json: '[]',
        state_hash: 'frozen-checkpoint-hash',
      },
    ],
    workflow_artifact_bindings: [
      {
        id: 'binding-s06',
        workflow_run_id: WORKFLOW_ID,
        step_run_id: COMPLETED_STEP_ID,
        artifact_id: 'artifact-s06',
        key: 'software.test',
        role: 'OUTPUT',
      },
    ],
    workflow_decisions: [],
    workflow_revision_traversals: [],
    workflow_events: [
      {
        id: 'workflow-created',
        workflow_run_id: WORKFLOW_ID,
        step_run_id: COMPLETED_STEP_ID,
        type: 'workflow.created',
        payload_json: '{}',
      },
    ],
    workflow_step_operation_receipts: [
      {
        id: 'operation-s06',
        workflow_run_id: WORKFLOW_ID,
        step_run_id: COMPLETED_STEP_ID,
        attempt: 1,
        state: 'VERIFIED',
      },
    ],
    workflow_workspace_mutation_journal: [
      {
        id: 'journal-s06',
        workflow_run_id: WORKFLOW_ID,
        step_run_id: COMPLETED_STEP_ID,
        attempt: 1,
        state: 'APPLIED',
      },
    ],
    workflow_run_output_validations: [],
  };
  for (const table of REQUIRED_TABLES) if (!Array.isArray(facts[table])) facts[table] = [];
  return { stage: 'fixture', facts };
}

/** @returns {Record<string, any>} */
function validInput() {
  const beforeCrash = baselineSnapshot();
  const afterKill = clone(beforeCrash);
  const firstRestart = clone(beforeCrash);
  const explicitContinue = clone(beforeCrash);
  const secondRestart = clone(beforeCrash);

  const newMission = {
    id: NEW_MISSION_ID,
    title: 'S07 continuation',
    state: 'COMPLETED',
    created_at: '2026-10-16T00:03:00.000Z',
  };
  const newMissionRun = {
    id: NEW_RUN_ID,
    mission_id: NEW_MISSION_ID,
    attempt: 1,
    status: 'COMPLETED',
    started_at: '2026-10-16T00:03:01.000Z',
  };
  const continuedStep = explicitContinue.facts.steps.find((row) => row.id === UNFINISHED_STEP_ID);
  assert.ok(continuedStep);
  continuedStep.state = 'COMPLETED';
  explicitContinue.facts.workflow.state = 'COMPLETED';
  continuedStep.mission_id = NEW_MISSION_ID;
  continuedStep.mission_run_id = NEW_RUN_ID;
  continuedStep.updated_at = '2026-10-16T00:03:01.000Z';
  explicitContinue.facts.missions.push(newMission);
  explicitContinue.facts.missionRuns.push(newMissionRun);
  explicitContinue.facts.missionEvents.push(
    {
      id: 'event-s07-created',
      mission_id: NEW_MISSION_ID,
      run_id: null,
      event_type: 'mission.created',
      payload_json: '{}',
      created_at: '2026-10-16T00:03:00.000Z',
    },
    {
      id: 'event-s07-call',
      mission_id: NEW_MISSION_ID,
      run_id: NEW_RUN_ID,
      event_type: 'model.call_started',
      payload_json: '{}',
      created_at: '2026-10-16T00:03:01.000Z',
    },
  );
  explicitContinue.facts.workflow_artifacts.push({
    id: 'artifact-s07',
    workflow_run_id: WORKFLOW_ID,
    producer_step_run_id: UNFINISHED_STEP_ID,
    mission_id: NEW_MISSION_ID,
    mission_run_id: NEW_RUN_ID,
    content_hash: 's07-hash',
    content: 'S07 output',
  });
  explicitContinue.facts.workflow_validation_receipts.push({
    id: 'validation-s07',
    workflow_run_id: WORKFLOW_ID,
    step_run_id: UNFINISHED_STEP_ID,
    artifact_id: 'artifact-s07',
    valid: 1,
    content_hash: 's07-hash',
  });
  explicitContinue.facts.workflow_checkpoints.push({
    id: 'checkpoint-s07',
    workflow_run_id: WORKFLOW_ID,
    sequence: 7,
    completed_step_run_ids_json: JSON.stringify([COMPLETED_STEP_ID]),
    active_step_run_ids_json: JSON.stringify([UNFINISHED_STEP_ID]),
    state_hash: 's07-checkpoint-hash',
  });
  explicitContinue.facts.workflow_artifact_bindings.push({
    id: 'binding-s07',
    workflow_run_id: WORKFLOW_ID,
    step_run_id: UNFINISHED_STEP_ID,
    artifact_id: 'artifact-s07',
    key: 'software.review',
    role: 'OUTPUT',
  });
  explicitContinue.facts.workflow_decisions.push({
    id: 'decision-s07',
    workflow_run_id: WORKFLOW_ID,
    step_run_id: UNFINISHED_STEP_ID,
    edge_id: 's07_to_s08',
    branch: 'NEXT',
  });
  explicitContinue.facts.workflow_revision_traversals.push({
    id: 'revision-s07',
    workflow_run_id: WORKFLOW_ID,
    from_step_run_id: UNFINISHED_STEP_ID,
    to_step_run_id: UNFINISHED_STEP_ID,
  });
  explicitContinue.facts.workflow_events.push({
    id: 'event-workflow-s07',
    workflow_run_id: WORKFLOW_ID,
    step_run_id: UNFINISHED_STEP_ID,
    type: 'step.started',
    payload_json: JSON.stringify({ stepRunId: UNFINISHED_STEP_ID }),
  });
  explicitContinue.facts.workflow_step_operation_receipts.push({
    id: 'operation-s07',
    workflow_run_id: WORKFLOW_ID,
    step_run_id: UNFINISHED_STEP_ID,
    attempt: 1,
    state: 'VERIFIED',
  });
  explicitContinue.facts.workflow_workspace_mutation_journal.push({
    id: 'journal-s07',
    workflow_run_id: WORKFLOW_ID,
    step_run_id: UNFINISHED_STEP_ID,
    attempt: 1,
    state: 'APPLIED',
  });
  explicitContinue.facts.workflow_run_output_validations.push({
    id: 'run-validation-s07',
    workflow_run_id: WORKFLOW_ID,
    definition_version: 1,
    output_bindings_json: JSON.stringify([
      { key: 'test_report', artifactId: 'artifact-s06', contentHash: 'frozen-artifact-hash' },
      { key: 'code_review', artifactId: 'artifact-s07', contentHash: 's07-hash' },
    ]),
    errors_json: '[]',
    valid: 1,
  });
  secondRestart.facts = clone(explicitContinue.facts);

  return {
    scenario: 'CR_A',
    beforeCrash,
    afterKill,
    firstRestart,
    explicitContinue,
    secondRestart,
    offlineRetryTestPassed: true,
  };
}

/** @param {Record<string, any>} value @returns {{scenario:string,status:'PASS',checks:Array<{id:string,status:'PASS',evidence:string,details:string}>}} */
function mockLegacy(value) {
  assert.equal(value.scenario, 'CR_A');
  return {
    scenario: 'CR_A',
    status: 'PASS',
    checks: REC_IDS.map((id) => ({
      id,
      status: 'PASS',
      evidence: 'fixture',
      details: 'mock sealed result',
    })),
  };
}

/** @param {Record<string, any>} input */
function evaluate(input) {
  return evaluateCorrectiveWithLegacy(input, mockLegacy);
}

/** @param {Record<string, any>} report @param {string} checkId */
function check(report, checkId) {
  const found = report.checks.find((item) => item.id === checkId);
  assert.ok(found, `missing ${checkId}`);
  return found;
}

const legal = evaluate(validInput());
assert.equal(legal.status, 'PASS');
assert.equal(check(legal, 'REC-01').status, 'PASS');
assert.equal(check(legal, 'REC-03').status, 'PASS');
assert.equal(legal.legacyDiagnostic.scenario, 'CR_A');

/** @param {Record<string, any>} value @returns {any} */
function knownLegacyAssignmentMismatch(value) {
  const original = mockLegacy(value);
  return {
    ...original,
    status: 'FAIL',
    checks: original.checks.map((item) =>
      item.id === 'REC-01'
        ? {
            ...item,
            status: 'FAIL',
            details: 'firstRestart -> explicitContinue: Prior Step attempt identity changed: S07#1',
          }
        : item,
    ),
  };
}
const legitimateCompatibility = evaluateCorrectiveWithLegacy(
  validInput(),
  knownLegacyAssignmentMismatch,
);
assert.equal(legitimateCompatibility.status, 'PASS');
assert.equal(legitimateCompatibility.legacyDiagnostic.status, 'FAIL');
assert.equal(check(legitimateCompatibility, 'REC-01').legacyStatus, 'FAIL');
const unrelatedLegacyFailure = evaluateCorrectiveWithLegacy(validInput(), (value) => {
  const original = knownLegacyAssignmentMismatch(value);
  original.checks[0].details = 'A different unreviewed identity violation';
  return original;
});
assert.equal(unrelatedLegacyFailure.status, 'FAIL');

const completedMissionMutation = validInput();
completedMissionMutation.explicitContinue.facts.steps[0].mission_id = 'altered-completed-mission';
completedMissionMutation.secondRestart.facts.steps[0].mission_id = 'altered-completed-mission';
assert.equal(check(evaluate(completedMissionMutation), 'REC-01').status, 'FAIL');
assert.equal(
  evaluateCorrectiveWithLegacy(completedMissionMutation, knownLegacyAssignmentMismatch).status,
  'FAIL',
);

const completedAttemptMutation = validInput();
completedAttemptMutation.explicitContinue.facts.steps[0].attempt = 2;
completedAttemptMutation.secondRestart.facts.steps[0].attempt = 2;
assert.equal(check(evaluate(completedAttemptMutation), 'REC-01').status, 'FAIL');

const unauthorizedNewAttempt = validInput();
const newAttempt = {
  ...clone(unauthorizedNewAttempt.beforeCrash.facts.steps[0]),
  id: 'step-s06-attempt-2',
  attempt: 2,
  created_at: '2026-10-16T00:04:00.000Z',
};
unauthorizedNewAttempt.explicitContinue.facts.steps.push(newAttempt);
unauthorizedNewAttempt.secondRestart.facts.steps.push(clone(newAttempt));
assert.equal(check(evaluate(unauthorizedNewAttempt), 'REC-01').status, 'FAIL');

const automaticAssignment = validInput();
automaticAssignment.firstRestart.facts.steps[1].mission_id = NEW_MISSION_ID;
automaticAssignment.firstRestart.facts.steps[1].mission_run_id = NEW_RUN_ID;
automaticAssignment.firstRestart.facts.missions.push({
  id: NEW_MISSION_ID,
  title: 'early Mission',
});
automaticAssignment.firstRestart.facts.missionRuns.push({
  id: NEW_RUN_ID,
  mission_id: NEW_MISSION_ID,
  attempt: 1,
  status: 'RUNNING',
});
assert.equal(check(evaluate(automaticAssignment), 'REC-01').status, 'FAIL');
assert.equal(check(evaluate(automaticAssignment), 'REC-03').status, 'FAIL');

const startupModelCall = validInput();
startupModelCall.firstRestart.facts.missionEvents.push({
  id: 'startup-model-call',
  mission_id: COMPLETED_MISSION_ID,
  run_id: COMPLETED_RUN_ID,
  event_type: 'model.call_started',
  payload_json: '{}',
  created_at: '2026-10-16T00:02:30.000Z',
});
assert.equal(check(evaluate(startupModelCall), 'REC-02').status, 'FAIL');
assert.equal(check(evaluate(startupModelCall), 'REC-03').status, 'FAIL');

const reusedMission = validInput();
reusedMission.explicitContinue.facts.steps[1].mission_id = COMPLETED_MISSION_ID;
reusedMission.secondRestart.facts.steps[1].mission_id = COMPLETED_MISSION_ID;
assert.equal(check(evaluate(reusedMission), 'REC-01').status, 'FAIL');
assert.equal(check(evaluate(reusedMission), 'REC-03').status, 'FAIL');

const completedStepContinuationFact = validInput();
completedStepContinuationFact.explicitContinue.facts.workflow_artifacts.push({
  id: 'bad-artifact',
  workflow_run_id: WORKFLOW_ID,
  producer_step_run_id: COMPLETED_STEP_ID,
  content_hash: 'bad',
});
completedStepContinuationFact.secondRestart.facts.workflow_artifacts.push(
  clone(completedStepContinuationFact.explicitContinue.facts.workflow_artifacts.at(-1)),
);
assert.equal(check(evaluate(completedStepContinuationFact), 'REC-03').status, 'FAIL');

/** @type {Array<(row:Record<string, any>)=>void>} */
const invalidFinalAggregates = [
  (row) => {
    row.workflow_run_id = 'another-workflow';
  },
  (row) => {
    row.definition_version = 2;
  },
  (row) => {
    row.errors_json = '["unresolved validation error"]';
  },
  (row) => {
    row.output_bindings_json = JSON.stringify([
      { key: 'review', artifactId: 'missing-artifact', contentHash: 's07-hash' },
    ]);
  },
  (row) => {
    row.output_bindings_json = JSON.stringify([
      { key: 'review', artifactId: 'artifact-s07', contentHash: 'wrong-hash' },
    ]);
  },
  (row) => {
    row.output_bindings_json = JSON.stringify([
      { key: 'only-old-output', artifactId: 'artifact-s06', contentHash: 'frozen-artifact-hash' },
    ]);
  },
  (row) => {
    row.output_bindings_json = JSON.stringify([
      { key: 'duplicate', artifactId: 'artifact-s06', contentHash: 'frozen-artifact-hash' },
      { key: 'duplicate', artifactId: 'artifact-s07', contentHash: 's07-hash' },
    ]);
  },
];
for (const corrupt of invalidFinalAggregates) {
  const input = validInput();
  const row = input.explicitContinue.facts.workflow_run_output_validations[0];
  corrupt(row);
  input.secondRestart.facts.workflow_run_output_validations[0] = clone(row);
  assert.equal(check(evaluate(input), 'REC-03').status, 'FAIL');
}

const missingPhase = validInput();
delete missingPhase.explicitContinue;
const blocked = evaluate(missingPhase);
assert.equal(blocked.status, 'BLOCKED');
assert.equal(check(blocked, 'REC-01').status, 'BLOCKED');
assert.equal(check(blocked, 'REC-02').status, 'BLOCKED');
assert.equal(check(blocked, 'REC-03').status, 'BLOCKED');

console.log(
  'CR-A corrective adapter sensitivity checks passed: legal assignment, immutable completed identity, no new attempts, no startup assignment/call, scoped continuation facts, Mission identity freshness, and missing-phase blocking.',
);
