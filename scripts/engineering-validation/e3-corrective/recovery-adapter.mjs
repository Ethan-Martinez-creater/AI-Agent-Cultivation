/**
 * CR-A corrective assertions layered over the sealed E3 invariant evaluator.
 * The legacy result is kept verbatim in `legacyDiagnostic`; this adapter adds
 * a StepRun-aware identity rule and scopes continuation rows to unfinished steps.
 *
 * @typedef {Record<string, any>} JsonObject
 * @typedef {{id:string,status:'PASS'|'FAIL'|'BLOCKED'|'NOT_RUN',evidence?:string,details?:string,[key:string]:any}} Check
 * @typedef {{status:'PASS'|'FAIL'|'BLOCKED'|'NOT_RUN',evidence:string,details:string,[key:string]:any}} AssertionResult
 * @typedef {{scenario:string,status:string,checks:Check[]}} Evaluation
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const adapterDirectory = dirname(fileURLToPath(import.meta.url));
const sealedEvaluatorCandidates = [
  join(adapterDirectory, '..', 'e3-invariants.mjs'),
  join(
    adapterDirectory,
    '..',
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'engineering-validation',
    'e3-invariants.mjs',
  ),
];
const sealedEvaluatorPath = sealedEvaluatorCandidates.find((candidate) => existsSync(candidate));
if (!sealedEvaluatorPath) {
  throw new Error(
    'The sealed scripts/engineering-validation/e3-invariants.mjs module is unavailable.',
  );
}
const sealedEvaluatorModule = await import(pathToFileURL(sealedEvaluatorPath).href);
const sealedEvaluateCase = sealedEvaluatorModule.evaluateCase ?? sealedEvaluatorModule.default;
if (typeof sealedEvaluateCase !== 'function') {
  throw new Error('The sealed E3 invariant module does not export evaluateCase.');
}

const PHASE_NAMES = Object.freeze([
  'beforeCrash',
  'afterKill',
  'firstRestart',
  'explicitContinue',
  'secondRestart',
]);
const APPEND_ONLY_TABLES = Object.freeze([
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
]);
const MISSION_TABLES = Object.freeze(['missions', 'missionRuns', 'missionEvents']);
const CHECK_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `REC-${String(index + 1).padStart(2, '0')}`),
);

/** @param {any} value @returns {value is JsonObject} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {any} value */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

/** @param {any} value */
function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

/** @param {any} snapshot */
function factsFor(snapshot) {
  return isRecord(snapshot) && isRecord(snapshot.facts) ? snapshot.facts : null;
}

/** @param {any} snapshot @param {string} key @returns {JsonObject[]|null} */
function rowsFor(snapshot, key) {
  const facts = factsFor(snapshot);
  if (!facts || !Array.isArray(facts[key])) return null;
  if (facts[key].some((row) => !isRecord(row))) return null;
  return facts[key];
}

/** @param {JsonObject[]} rows @param {(row:JsonObject)=>string|null} keyOf */
function uniqueMap(rows, keyOf) {
  const result = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key || result.has(key)) return null;
    result.set(key, row);
  }
  return result;
}

/** @param {JsonObject[]} rows */
function idMap(rows) {
  return uniqueMap(rows, (row) => (typeof row.id === 'string' && row.id ? row.id : null));
}

/** @param {JsonObject} row */
function stepAttemptKey(row) {
  if (typeof row.step_id !== 'string' || !Number.isInteger(row.attempt)) return null;
  return `${row.step_id}#${row.attempt}`;
}

/** @param {any} input */
function missingPhases(input) {
  return PHASE_NAMES.filter((name) => !isRecord(input) || !isRecord(input[name]));
}

/** @param {'PASS'|'FAIL'|'BLOCKED'|'NOT_RUN'} status @param {string} evidence @param {string} details @returns {AssertionResult} */
function result(status, evidence, details) {
  return { status, evidence, details };
}

/** @param {Check[]} checks */
function aggregateStatus(checks) {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASS';
}

/** @param {JsonObject} input */
function correctedStepIdentity(input) {
  const missing = missingPhases(input);
  if (missing.length)
    return result(
      'BLOCKED',
      'StepRun identities',
      `Missing required phases: ${missing.join(', ')}.`,
    );
  const workflow = factsFor(input.beforeCrash)?.workflow;
  const workflowId = isRecord(workflow) && typeof workflow.id === 'string' ? workflow.id : null;
  if (!workflowId)
    return result('BLOCKED', 'facts.workflow.id', 'BeforeCrash workflow Run ID is unavailable.');

  const snapshots = PHASE_NAMES.map((phase) => ({ phase, snapshot: input[phase] }));
  const maps = new Map();
  for (const { phase, snapshot } of snapshots) {
    const facts = factsFor(snapshot);
    const steps = facts?.steps;
    if (!Array.isArray(steps))
      return result('BLOCKED', `${phase}.facts.steps`, 'StepRun rows are unavailable.');
    if (facts.workflow?.id !== workflowId)
      return result(
        'FAIL',
        `${phase}.facts.workflow.id`,
        'Workflow Run identity changed across stages.',
      );
    const validRows = steps.filter(isRecord);
    const map = uniqueMap(validRows, stepAttemptKey);
    if (!map)
      return result(
        'BLOCKED',
        `${phase}.facts.steps`,
        'StepRun attempt identities are missing or duplicated.',
      );
    for (const [key, row] of map) {
      if (typeof row.id !== 'string' || !row.id)
        return result(
          'BLOCKED',
          `${phase}.facts.steps.${key}.id`,
          'StepRun row ID is unavailable.',
        );
      if (row.workflow_run_id !== undefined && row.workflow_run_id !== workflowId)
        return result(
          'FAIL',
          `${phase}.facts.steps.${key}.workflow_run_id`,
          'StepRun is associated with a different Workflow Run.',
        );
    }
    maps.set(phase, map);
  }

  const baseline = maps.get('beforeCrash');
  for (const phase of PHASE_NAMES.slice(1)) {
    const current = maps.get(phase);
    if (current.size !== baseline.size) {
      return result(
        'FAIL',
        `${phase}.facts.steps`,
        `${phase} changed StepRun attempt cardinality (${baseline.size} -> ${current.size}); this continuation authorizes no new attempt.`,
      );
    }
    for (const [key, prior] of baseline) {
      const row = current.get(key);
      if (!row)
        return result('FAIL', `${phase}.facts.steps`, `Prior StepRun attempt disappeared: ${key}.`);
      for (const field of ['id', 'workflow_run_id', 'step_id', 'attempt', 'created_at']) {
        if (canonicalJson(prior[field] ?? null) !== canonicalJson(row[field] ?? null)) {
          return result(
            'FAIL',
            `${phase}.facts.steps.${key}.${field}`,
            `Immutable StepRun identity field changed: ${key}.${field}.`,
          );
        }
      }
    }
  }

  const priorUnfinished = new Set(
    [...baseline.values()].filter((row) => row.state !== 'COMPLETED').map((row) => row.id),
  );
  const firstRestart = maps.get('firstRestart');
  const continued = maps.get('explicitContinue');
  const secondRestart = maps.get('secondRestart');
  const firstMissionRows = rowsFor(input.firstRestart, 'missions');
  const firstMissionRunRows = rowsFor(input.firstRestart, 'missionRuns');
  if (!firstMissionRows || !firstMissionRunRows) {
    return result(
      'BLOCKED',
      'firstRestart.facts.missions/missionRuns',
      'Mission rows are unavailable to distinguish new identities from existing Missions.',
    );
  }
  const priorMissionIds = new Set(
    firstMissionRows.map((row) => row.id).filter((id) => typeof id === 'string'),
  );
  const priorMissionRunIds = new Set(
    firstMissionRunRows.map((row) => row.id).filter((id) => typeof id === 'string'),
  );
  const assignedMissionIds = new Set();
  const assignedMissionRunIds = new Set();
  for (const [key, prior] of baseline) {
    const baseMissionId = prior.mission_id ?? null;
    const baseMissionRunId = prior.mission_run_id ?? null;
    const firstMissionId = firstRestart.get(key).mission_id ?? null;
    const firstMissionRunId = firstRestart.get(key).mission_run_id ?? null;
    const continuedMissionId = continued.get(key).mission_id ?? null;
    const continuedMissionRunId = continued.get(key).mission_run_id ?? null;
    const finalMissionId = secondRestart.get(key).mission_id ?? null;
    const finalMissionRunId = secondRestart.get(key).mission_run_id ?? null;
    const completedBeforeCrash = prior.state === 'COMPLETED';

    if (baseMissionId !== firstMissionId || baseMissionRunId !== firstMissionRunId) {
      return result(
        'FAIL',
        `firstRestart.facts.steps.${key}`,
        `Recovery assigned or changed Mission identity before explicit continuation: ${key}.`,
      );
    }
    if (completedBeforeCrash) {
      if (
        baseMissionId !== continuedMissionId ||
        baseMissionRunId !== continuedMissionRunId ||
        baseMissionId !== finalMissionId ||
        baseMissionRunId !== finalMissionRunId
      ) {
        return result(
          'FAIL',
          `facts.steps.${key}`,
          `Completed pre-crash StepRun Mission/MissionRun identity changed: ${key}.`,
        );
      }
      continue;
    }

    const changedAtContinue =
      firstMissionId !== continuedMissionId || firstMissionRunId !== continuedMissionRunId;
    if (changedAtContinue) {
      if (
        !priorUnfinished.has(prior.id) ||
        baseMissionId !== null ||
        baseMissionRunId !== null ||
        firstMissionId !== null ||
        firstMissionRunId !== null ||
        typeof continuedMissionId !== 'string' ||
        !continuedMissionId ||
        typeof continuedMissionRunId !== 'string' ||
        !continuedMissionRunId
      ) {
        return result(
          'FAIL',
          `explicitContinue.facts.steps.${key}`,
          `Mission identity assignment is outside the permitted null-to-new assignment on an unfinished StepRun: ${key}.`,
        );
      }
      if (
        priorMissionIds.has(continuedMissionId) ||
        priorMissionRunIds.has(continuedMissionRunId)
      ) {
        return result(
          'FAIL',
          `explicitContinue.facts.steps.${key}`,
          `Continuation reused an existing Mission/MissionRun identity instead of assigning new identities: ${key}.`,
        );
      }
      if (
        assignedMissionIds.has(continuedMissionId) ||
        assignedMissionRunIds.has(continuedMissionRunId)
      ) {
        return result(
          'FAIL',
          `explicitContinue.facts.steps.${key}`,
          `A new Mission/MissionRun was assigned to more than one StepRun: ${key}.`,
        );
      }
      assignedMissionIds.add(continuedMissionId);
      assignedMissionRunIds.add(continuedMissionRunId);
    } else if (baseMissionId !== continuedMissionId || baseMissionRunId !== continuedMissionRunId) {
      return result(
        'FAIL',
        `explicitContinue.facts.steps.${key}`,
        `Unfinished StepRun Mission identity changed without the permitted assignment: ${key}.`,
      );
    }
    if (continuedMissionId !== finalMissionId || continuedMissionRunId !== finalMissionRunId) {
      return result(
        'FAIL',
        `secondRestart.facts.steps.${key}`,
        `StepRun Mission/MissionRun identity changed after explicit continuation: ${key}.`,
      );
    }
    if (
      (baseMissionId !== null || baseMissionRunId !== null) &&
      (baseMissionId !== continuedMissionId || baseMissionRunId !== continuedMissionRunId)
    ) {
      return result(
        'FAIL',
        `explicitContinue.facts.steps.${key}`,
        `Previously assigned unfinished StepRun Mission identity was replaced: ${key}.`,
      );
    }
  }
  return result(
    'PASS',
    'StepRun IDs, attempt keys, workflow_run_id, created_at, and Mission assignment lineage',
    `No new attempts; all completed pre-crash StepRuns retained their identities. ${assignedMissionIds.size} new Mission/MissionRun assignment(s) occurred only after explicit continuation on pre-existing unfinished StepRuns and persisted through SecondRestart.`,
  );
}

/** @param {JsonObject} input */
function compareExactRows(input, beforeName, afterName, tableName, filter = () => true) {
  const beforeRows = rowsFor(input[beforeName], tableName);
  const afterRows = rowsFor(input[afterName], tableName);
  if (!beforeRows || !afterRows)
    return result(
      'BLOCKED',
      `${beforeName}/${afterName}.facts.${tableName}`,
      'Required durable rows are unavailable.',
    );
  const before = beforeRows.filter(filter);
  const after = afterRows.filter(filter);
  const beforeMap = idMap(before);
  const afterMap = idMap(after);
  if (!beforeMap || !afterMap)
    return result('BLOCKED', `${tableName}.id`, 'Rows have missing or duplicate IDs.');
  if (beforeMap.size !== afterMap.size)
    return result(
      'FAIL',
      `${tableName}.id`,
      `${tableName} row count changed between ${beforeName} and ${afterName}.`,
    );
  for (const [id, row] of beforeMap) {
    const current = afterMap.get(id);
    if (!current || canonicalJson(row) !== canonicalJson(current))
      return result(
        'FAIL',
        `${tableName}.${id}`,
        `${tableName} row changed or disappeared between ${beforeName} and ${afterName}.`,
      );
  }
  return result(
    'PASS',
    tableName,
    `All ${beforeMap.size} row(s) are unchanged between ${beforeName} and ${afterName}.`,
  );
}

/** @param {JsonObject} input */
function completedMissionFactsStable(input) {
  const missing = missingPhases(input);
  if (missing.length)
    return result(
      'BLOCKED',
      'completed MissionRun facts',
      `Missing required phases: ${missing.join(', ')}.`,
    );
  const beforeFacts = factsFor(input.beforeCrash);
  if (!beforeFacts || !Array.isArray(beforeFacts.steps))
    return result(
      'BLOCKED',
      'beforeCrash.facts.steps',
      'Pre-crash completed StepRun set is unavailable.',
    );
  const completed = beforeFacts.steps.filter((row) => isRecord(row) && row.state === 'COMPLETED');
  const completedStepIds = new Set(completed.map((row) => row.id));
  const missionIds = new Set(
    completed.map((row) => row.mission_id).filter((value) => typeof value === 'string'),
  );
  const runIds = new Set(
    completed.map((row) => row.mission_run_id).filter((value) => typeof value === 'string'),
  );

  for (const phase of PHASE_NAMES.slice(1)) {
    const stepRows = rowsFor(input[phase], 'steps');
    if (!stepRows)
      return result('BLOCKED', `${phase}.facts.steps`, 'StepRun rows are unavailable.');
    const stepMap = idMap(stepRows);
    if (!stepMap)
      return result('BLOCKED', `${phase}.facts.steps`, 'StepRun IDs are missing or duplicated.');
    for (const step of completed) {
      const current = stepMap.get(step.id);
      if (!current || canonicalJson(step) !== canonicalJson(current))
        return result(
          'FAIL',
          `${phase}.facts.steps.${step.id}`,
          `Completed pre-crash StepRun row changed: ${step.step_id} attempt ${step.attempt}.`,
        );
    }

    for (const tableName of ['missions', 'missionRuns']) {
      const stable = compareExactRows(input, 'beforeCrash', phase, tableName, (row) =>
        tableName === 'missions' ? missionIds.has(row.id) : runIds.has(row.id),
      );
      if (stable.status !== 'PASS') return stable;
    }
    const eventsStable = compareExactRows(input, 'beforeCrash', phase, 'missionEvents', (row) =>
      runIds.has(row.run_id),
    );
    if (eventsStable.status !== 'PASS') return eventsStable;
  }

  for (const [beforeName, afterName] of [
    ['afterKill', 'firstRestart'],
    ['explicitContinue', 'secondRestart'],
  ]) {
    for (const tableName of MISSION_TABLES) {
      const stable = compareExactRows(input, beforeName, afterName, tableName);
      if (stable.status !== 'PASS') return stable;
    }
  }
  return result(
    'PASS',
    'pre-crash completed StepRun/Mission/MissionRun IDs and MissionRun event IDs/content',
    `All ${completedStepIds.size} pre-crash completed StepRun(s), their Mission/MissionRun rows, and their complete event histories are unchanged. Startup windows afterKill→firstRestart and explicitContinue→secondRestart add no Mission, MissionRun, or MissionEvent rows.`,
  );
}

/** @param {JsonObject} row */
function checkpointStepIds(row) {
  const ids = new Set();
  for (const field of ['completed_step_run_ids_json', 'active_step_run_ids_json']) {
    const value = row[field];
    if (typeof value !== 'string') continue;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') ids.add(id);
    } catch {
      return null;
    }
  }
  return ids;
}

/** @param {string} tableName @param {JsonObject} row @param {Set<string>} allowedStepIds @param {Set<string>} newMissionIds @param {Set<string>} newMissionRunIds @param {Set<string>} allowedArtifactIds @param {JsonObject} snapshot */
function rowHasAllowedStepLink(
  tableName,
  row,
  allowedStepIds,
  newMissionIds,
  newMissionRunIds,
  allowedMissionIds,
  allowedMissionRunIds,
  allowedArtifactIds,
  snapshot,
) {
  const directStepFields = ['step_run_id', 'producer_step_run_id', 'target_step_run_id'];
  for (const field of directStepFields)
    if (typeof row[field] === 'string' && allowedStepIds.has(row[field])) return true;
  if (
    tableName === 'workflow_revision_traversals' &&
    typeof row.from_step_run_id === 'string' &&
    allowedStepIds.has(row.from_step_run_id)
  )
    return true;
  if (tableName === 'workflow_checkpoints') {
    const stepIds = checkpointStepIds(row);
    return stepIds !== null && [...stepIds].some((id) => allowedStepIds.has(id));
  }
  if (tableName === 'workflow_events') {
    const type = typeof row.type === 'string' ? row.type : '';
    if (type === 'workflow.completed' && factsFor(snapshot)?.workflow?.state === 'COMPLETED')
      return true;
    if (typeof row.payload_json === 'string') {
      try {
        const payload = JSON.parse(row.payload_json);
        if (typeof payload.stepRunId === 'string' && allowedStepIds.has(payload.stepRunId))
          return true;
        if (typeof payload.step_run_id === 'string' && allowedStepIds.has(payload.step_run_id))
          return true;
      } catch {
        return false;
      }
    }
  }
  if (tableName === 'workflow_run_output_validations') {
    // This is a Run-level aggregate, not a Step receipt (migration 0018 and
    // W1WorkflowRepository.appendFinalValidation). It legitimately binds
    // preserved earlier outputs together with outputs from explicit continuation.
    const facts = factsFor(snapshot);
    if (
      !facts ||
      row.workflow_run_id !== facts.workflow?.id ||
      row.definition_version !== facts.workflow?.definition_version ||
      facts.workflow.state !== 'COMPLETED' ||
      row.valid !== 1 ||
      typeof row.output_bindings_json !== 'string' ||
      typeof row.errors_json !== 'string'
    )
      return false;
    try {
      const bindings = JSON.parse(row.output_bindings_json);
      const errors = JSON.parse(row.errors_json);
      if (
        !Array.isArray(bindings) ||
        bindings.length === 0 ||
        !Array.isArray(errors) ||
        errors.length !== 0
      )
        return false;
      const artifacts = rowsFor(snapshot, 'workflow_artifacts');
      const artifactBindings = rowsFor(snapshot, 'workflow_artifact_bindings');
      if (!artifacts || !artifactBindings) return false;
      const keys = new Set();
      let referencesContinuedOutput = false;
      for (const binding of bindings) {
        if (
          !isRecord(binding) ||
          typeof binding.key !== 'string' ||
          binding.key.length === 0 ||
          keys.has(binding.key) ||
          typeof binding.artifactId !== 'string' ||
          typeof binding.contentHash !== 'string'
        )
          return false;
        keys.add(binding.key);
        const artifact = artifacts.find((item) => item.id === binding.artifactId);
        if (
          !artifact ||
          artifact.workflow_run_id !== row.workflow_run_id ||
          artifact.content_hash !== binding.contentHash ||
          !artifactBindings.some(
            (item) =>
              item.artifact_id === artifact.id &&
              item.workflow_run_id === row.workflow_run_id &&
              item.role === 'OUTPUT',
          )
        )
          return false;
        if (allowedArtifactIds.has(artifact.id)) referencesContinuedOutput = true;
      }
      return referencesContinuedOutput;
    } catch {
      return false;
    }
  }
  if (tableName === 'missions' && typeof row.id === 'string' && newMissionIds.has(row.id))
    return true;
  if (tableName === 'missionRuns' && typeof row.id === 'string' && newMissionRunIds.has(row.id))
    return true;
  if (tableName === 'missionEvents') {
    return (
      (typeof row.mission_id === 'string' && allowedMissionIds.has(row.mission_id)) ||
      (typeof row.run_id === 'string' && allowedMissionRunIds.has(row.run_id))
    );
  }
  return false;
}

/** @param {JsonObject} input */
function continuationRowsScoped(input) {
  const missing = missingPhases(input);
  if (missing.length)
    return result(
      'BLOCKED',
      'continuation row associations',
      `Missing required phases: ${missing.join(', ')}.`,
    );
  const beforeSteps = rowsFor(input.beforeCrash, 'steps');
  const firstSteps = rowsFor(input.firstRestart, 'steps');
  const continuedSteps = rowsFor(input.explicitContinue, 'steps');
  if (!beforeSteps || !firstSteps || !continuedSteps)
    return result(
      'BLOCKED',
      'facts.steps',
      'StepRun rows are unavailable for continuation association checks.',
    );
  const beforeMap = idMap(beforeSteps);
  const firstMap = idMap(firstSteps);
  const continuedMap = idMap(continuedSteps);
  if (!beforeMap || !firstMap || !continuedMap)
    return result('BLOCKED', 'facts.steps.id', 'StepRun IDs are missing or duplicated.');
  const firstMissionRows = rowsFor(input.firstRestart, 'missions');
  const firstMissionRunRows = rowsFor(input.firstRestart, 'missionRuns');
  const continuedMissionRows = rowsFor(input.explicitContinue, 'missions');
  const continuedMissionRunRows = rowsFor(input.explicitContinue, 'missionRuns');
  if (
    !firstMissionRows ||
    !firstMissionRunRows ||
    !continuedMissionRows ||
    !continuedMissionRunRows
  ) {
    return result(
      'BLOCKED',
      'facts.missions/missionRuns',
      'Mission lineage rows are unavailable for assignment identity checks.',
    );
  }
  const firstMissionMap = idMap(firstMissionRows);
  const firstMissionRunMap = idMap(firstMissionRunRows);
  if (!firstMissionMap || !firstMissionRunMap)
    return result(
      'BLOCKED',
      'firstRestart.facts.missions/missionRuns.id',
      'Mission or MissionRun IDs are missing or duplicated.',
    );

  const allowedStepIds = new Set(
    beforeSteps.filter((row) => row.state !== 'COMPLETED').map((row) => row.id),
  );
  const allowedMissionIds = new Set(
    beforeSteps
      .filter((row) => row.state !== 'COMPLETED' && typeof row.mission_id === 'string')
      .map((row) => row.mission_id),
  );
  const allowedMissionRunIds = new Set(
    beforeSteps
      .filter((row) => row.state !== 'COMPLETED' && typeof row.mission_run_id === 'string')
      .map((row) => row.mission_run_id),
  );
  const newMissionIds = new Set();
  const newMissionRunIds = new Set();
  for (const prior of beforeSteps) {
    const first = firstMap.get(prior.id);
    const continued = continuedMap.get(prior.id);
    if (!first || !continued)
      return result(
        'FAIL',
        'facts.steps',
        `Original StepRun is missing during continuation: ${prior.id}.`,
      );
    const firstMissionId = first.mission_id ?? null;
    const firstMissionRunId = first.mission_run_id ?? null;
    const continuedMissionId = continued.mission_id ?? null;
    const continuedMissionRunId = continued.mission_run_id ?? null;
    if (
      firstMissionId === null &&
      firstMissionRunId === null &&
      continuedMissionId !== null &&
      continuedMissionRunId !== null
    ) {
      if (prior.state === 'COMPLETED' || !allowedStepIds.has(prior.id))
        return result(
          'FAIL',
          `explicitContinue.facts.steps.${prior.id}`,
          'New Mission was assigned to a completed or unauthorized StepRun.',
        );
      if (
        prior.mission_id != null ||
        prior.mission_run_id != null ||
        firstMissionMap.has(continuedMissionId) ||
        firstMissionRunMap.has(continuedMissionRunId)
      )
        return result(
          'FAIL',
          `explicitContinue.facts.steps.${prior.id}`,
          'Assigned Mission/MissionRun was not a new identity on an originally empty StepRun.',
        );
      newMissionIds.add(continuedMissionId);
      newMissionRunIds.add(continuedMissionRunId);
      allowedMissionIds.add(continuedMissionId);
      allowedMissionRunIds.add(continuedMissionRunId);
    }
  }

  const missionRows = rowsFor(input.explicitContinue, 'missions');
  const missionRunRows = rowsFor(input.explicitContinue, 'missionRuns');
  if (!missionRows || !missionRunRows)
    return result('BLOCKED', 'facts.missions/missionRuns', 'Mission lineage rows are unavailable.');
  const missionMap = idMap(missionRows);
  const missionRunMap = idMap(missionRunRows);
  if (!missionMap || !missionRunMap)
    return result(
      'BLOCKED',
      'facts.missions/missionRuns.id',
      'Mission or MissionRun IDs are missing or duplicated.',
    );
  for (const id of newMissionIds)
    if (!missionMap.has(id))
      return result('FAIL', 'facts.missions', `Assigned new Mission row is absent: ${id}.`);
  for (const id of newMissionRunIds) {
    const row = missionRunMap.get(id);
    if (!row || !newMissionIds.has(row.mission_id))
      return result(
        'FAIL',
        'facts.missionRuns',
        `Assigned new MissionRun does not map to its new Mission: ${id}.`,
      );
  }
  const assignedSteps = new Map();
  for (const prior of beforeSteps) {
    const first = firstMap.get(prior.id);
    const continued = continuedMap.get(prior.id);
    if (
      (first.mission_id ?? null) === null &&
      (first.mission_run_id ?? null) === null &&
      typeof continued.mission_id === 'string' &&
      typeof continued.mission_run_id === 'string'
    ) {
      assignedSteps.set(prior.id, {
        missionId: continued.mission_id,
        missionRunId: continued.mission_run_id,
      });
    }
  }
  for (const missionId of newMissionIds) {
    if (![...assignedSteps.values()].some((assignment) => assignment.missionId === missionId))
      return result(
        'FAIL',
        'facts.missions',
        `New Mission is not attached to an allowed unfinished StepRun: ${missionId}.`,
      );
  }
  for (const runId of newMissionRunIds) {
    if (![...assignedSteps.values()].some((assignment) => assignment.missionRunId === runId))
      return result(
        'FAIL',
        'facts.missionRuns',
        `New MissionRun is not attached to an allowed unfinished StepRun: ${runId}.`,
      );
  }

  const allowedArtifactIds = new Set();
  /** @type {Array<[string, string, boolean]>} */
  const transitions = [
    ['beforeCrash', 'afterKill', false],
    ['afterKill', 'firstRestart', false],
    ['firstRestart', 'explicitContinue', true],
    ['explicitContinue', 'secondRestart', false],
  ];
  for (const tableName of [...APPEND_ONLY_TABLES, 'missions', 'missionRuns', 'missionEvents']) {
    for (const [beforeName, afterName, allowNew] of transitions) {
      const beforeRows = rowsFor(input[beforeName], tableName);
      const afterRows = rowsFor(input[afterName], tableName);
      if (!beforeRows || !afterRows)
        return result(
          'BLOCKED',
          `${beforeName}/${afterName}.facts.${tableName}`,
          'Rows required to prove append-only preservation are unavailable.',
        );
      const beforeMapRows = idMap(beforeRows);
      const afterMapRows = idMap(afterRows);
      if (!beforeMapRows || !afterMapRows)
        return result('BLOCKED', `${tableName}.id`, 'Rows have missing or duplicate IDs.');
      for (const [id, oldRow] of beforeMapRows) {
        const current = afterMapRows.get(id);
        if (!current || canonicalJson(oldRow) !== canonicalJson(current))
          return result(
            'FAIL',
            `${tableName}.${id}`,
            `Prior ${tableName} row changed or disappeared at ${afterName}.`,
          );
      }
      const additions = [...afterMapRows.entries()].filter(([id]) => !beforeMapRows.has(id));
      if (additions.length && !allowNew)
        return result(
          'FAIL',
          `${tableName}.id`,
          `${tableName} gained row(s) outside the explicit continuation window.`,
        );
      for (const [id, added] of additions) {
        if (
          !rowHasAllowedStepLink(
            tableName,
            added,
            allowedStepIds,
            newMissionIds,
            newMissionRunIds,
            allowedMissionIds,
            allowedMissionRunIds,
            allowedArtifactIds,
            input[afterName],
          )
        )
          return result(
            'FAIL',
            `${tableName}.${id}`,
            `New ${tableName} row cannot be tied to a pre-existing unfinished StepRun.`,
          );
        if (tableName === 'workflow_artifacts') allowedArtifactIds.add(id);
      }
    }
  }
  return result(
    'PASS',
    'append-only rows, Mission lineage, Artifact producer, binding/receipt step_run_id, and checkpoint step-set associations',
    `New continuation facts are confined to the explicitContinue window and linked to pre-existing unfinished StepRuns (${allowedStepIds.size} eligible StepRun IDs); prior rows remain byte-stable.`,
  );
}

/** @param {Evaluation|null} legacy @param {string} id */
function legacyCheck(legacy, id) {
  if (!legacy || !Array.isArray(legacy.checks)) return null;
  return legacy.checks.find((check) => isRecord(check) && check.id === id) ?? null;
}

/** @param {Check|null} legacy @param {AssertionResult} extra @returns {AssertionResult} */
function combineLegacyAndExtra(legacy, extra) {
  const legacyStatus = legacy?.status ?? 'BLOCKED';
  /** @type {Check['status']} */
  let status = 'PASS';
  if (legacyStatus === 'FAIL' || extra.status === 'FAIL') status = 'FAIL';
  else if (legacyStatus === 'BLOCKED' || extra.status === 'BLOCKED') status = 'BLOCKED';
  else if (legacyStatus === 'NOT_RUN' || extra.status === 'NOT_RUN') status = 'NOT_RUN';
  return {
    ...extra,
    status,
    legacyStatus,
    legacyDetails: legacy?.details ?? 'Legacy assertion is unavailable.',
    details: `${extra.details} Legacy REC status: ${legacyStatus}${legacy?.details ? ` (${legacy.details})` : ''}.`,
  };
}

/** @param {JsonObject} input @param {Check|null} legacy @returns {AssertionResult} */
function correctedRec01(input, legacy) {
  const extra = correctedStepIdentity(input);
  const legacyStatus = legacy?.status ?? 'BLOCKED';
  if (legacyStatus === 'BLOCKED' || legacyStatus === 'NOT_RUN')
    return combineLegacyAndExtra(legacy, extra);
  if (legacyStatus === 'FAIL' && extra.status === 'PASS') {
    const mismatch =
      typeof legacy.details === 'string'
        ? legacy.details.match(
            /firstRestart -> explicitContinue: Prior Step attempt identity changed: ([^#]+)#(\d+)/,
          )
        : null;
    const expectedKey = mismatch ? `${mismatch[1]}#${mismatch[2]}` : null;
    const before = rowsFor(input.firstRestart, 'steps');
    const after = rowsFor(input.explicitContinue, 'steps');
    const beforeMap = before ? uniqueMap(before, stepAttemptKey) : null;
    const afterMap = after ? uniqueMap(after, stepAttemptKey) : null;
    const prior = expectedKey && beforeMap?.get(expectedKey);
    const current = expectedKey && afterMap?.get(expectedKey);
    const knownAssignmentMismatch = Boolean(
      prior &&
        current &&
        (prior.mission_id ?? null) === null &&
        (prior.mission_run_id ?? null) === null &&
        typeof current.mission_id === 'string' &&
        typeof current.mission_run_id === 'string' &&
        prior.id === current.id &&
        prior.step_id === current.step_id &&
        prior.attempt === current.attempt &&
        prior.created_at === current.created_at &&
        prior.workflow_run_id === current.workflow_run_id,
    );
    if (!knownAssignmentMismatch) return combineLegacyAndExtra(legacy, extra);
    return {
      ...extra,
      status: extra.status,
      legacyStatus,
      legacyDetails: legacy.details,
      details: `${extra.details} The sealed REC-01 identity projection reports the expected unfinished-StepRun Mission assignment as a mismatch for ${expectedKey}; this is the sole compatibility delta accepted by the corrective rule.`,
    };
  }
  return combineLegacyAndExtra(legacy, extra);
}

/**
 * Pure core with an evaluator parameter so sensitivity fixtures can run without
 * modifying or projecting any real snapshot. Production callers use evaluateCorrective.
 *
 * @param {JsonObject} input
 * @param {(value:JsonObject)=>Evaluation} evaluateLegacy
 */
export function evaluateCorrectiveWithLegacy(input, evaluateLegacy) {
  if (typeof evaluateLegacy !== 'function')
    throw new TypeError('evaluateLegacy must be a function.');
  const legacyDiagnostic = evaluateLegacy({ ...input, scenario: 'CR_A' });
  const checksById = new Map();
  if (Array.isArray(legacyDiagnostic?.checks)) {
    for (const check of legacyDiagnostic.checks)
      if (isRecord(check) && typeof check.id === 'string') checksById.set(check.id, { ...check });
  }
  const corrected01 = correctedRec01(input, legacyCheck(legacyDiagnostic, 'REC-01'));
  const corrected02 = combineLegacyAndExtra(
    legacyCheck(legacyDiagnostic, 'REC-02'),
    completedMissionFactsStable(input),
  );
  const corrected03 = combineLegacyAndExtra(
    legacyCheck(legacyDiagnostic, 'REC-03'),
    continuationRowsScoped(input),
  );
  checksById.set('REC-01', { id: 'REC-01', evidence: corrected01.evidence, ...corrected01 });
  checksById.set('REC-02', { id: 'REC-02', evidence: corrected02.evidence, ...corrected02 });
  checksById.set('REC-03', { id: 'REC-03', evidence: corrected03.evidence, ...corrected03 });
  const checks = CHECK_IDS.map(
    (id) =>
      checksById.get(id) ?? {
        id,
        status: 'BLOCKED',
        evidence: 'legacy assertion result',
        details: 'The sealed evaluator did not return this required REC assertion.',
      },
  );
  return {
    scenario: 'CR_A_CORRECTIVE',
    status: aggregateStatus(checks),
    checks,
    legacyDiagnostic,
  };
}

/** @param {JsonObject} input @returns {Evaluation & {legacyDiagnostic:Evaluation}} */
export function evaluateCorrective(input) {
  return evaluateCorrectiveWithLegacy(input, sealedEvaluateCase);
}

export default evaluateCorrective;
