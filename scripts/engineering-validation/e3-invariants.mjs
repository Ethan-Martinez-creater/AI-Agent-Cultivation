import { createHash } from 'node:crypto';

const CHECK_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => 'REC-' + String(index + 1).padStart(2, '0')),
);
const EXECUTION_EVENT_TYPES = new Set([
  'model.call_started',
  'tool.execution_started',
  'tool.call_started',
  'tool.proposed',
  'tool.result',
]);
const APPEND_ONLY_TABLES = Object.freeze([
  'workflow_artifacts',
  'workflow_validation_receipts',
  'workflow_checkpoints',
  'workflow_artifact_bindings',
  'workflow_decisions',
  'workflow_revision_traversals',
]);
const OPERATION_IDENTITY_COLUMNS = Object.freeze([
  'id',
  'workflow_run_id',
  'step_run_id',
  'attempt',
  'operation_key',
  'effect_type',
  'input_hash',
  'manifest_json',
  'output_artifact_ids_json',
  'external_reference',
  'created_at',
]);
const REQUIRED_SNAPSHOTS = Object.freeze({
  CR_A: ['beforeCrash', 'afterKill', 'firstRestart', 'explicitContinue', 'secondRestart'],
  CR_B: ['beforeCrash', 'afterKill', 'firstRestart', 'secondRestart'],
});
const RUN_TABLES = Object.freeze([
  'workflow_artifacts',
  'workflow_validation_receipts',
  'workflow_checkpoints',
  'workflow_artifact_bindings',
  'workflow_step_operation_receipts',
  'workflow_workspace_mutation_journal',
  'workflow_events',
  'workflow_decisions',
  'workflow_revision_traversals',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function rowHash(row, omit = []) {
  if (!isRecord(row)) return null;
  const omitted = new Set(omit);
  const projected = Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.has(key)));
  return createHash('sha256').update(canonicalJson(projected), 'utf8').digest('hex');
}

function hasOwn(object, key) {
  return isRecord(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizePath(value) {
  return typeof value === 'string'
    ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    : '';
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function addCheck(checks, id, status, evidence, details) {
  checks.push({ id, status, evidence, details });
}

function aggregateStatus(checks) {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASS';
}

function snapshotFor(input, phase) {
  const snapshot = input[phase];
  return isRecord(snapshot) ? snapshot : null;
}

function stageData(snapshot) {
  if (!snapshot || !isRecord(snapshot.facts)) return null;
  const workflow = snapshot.facts.workflow;
  const allSteps = snapshot.facts.steps;
  if (!isRecord(workflow) || typeof workflow.id !== 'string' || !Array.isArray(allSteps))
    return null;
  const steps = allSteps.filter(
    (row) =>
      isRecord(row) && (!hasOwn(row, 'workflow_run_id') || row.workflow_run_id === workflow.id),
  );
  return { workflow, steps };
}

function runRows(rows, runId) {
  if (!Array.isArray(rows)) return null;
  return rows.filter((row) => isRecord(row) && row.workflow_run_id === runId);
}

function relatedMissionIds(data) {
  return new Set(data.steps.map((row) => row.mission_id).filter((id) => typeof id === 'string'));
}

function relatedMissionRunIds(data) {
  return new Set(
    data.steps.map((row) => row.mission_run_id).filter((id) => typeof id === 'string'),
  );
}

function tableRows(snapshot, key, runId, data = stageData(snapshot)) {
  if (!snapshot || !isRecord(snapshot.facts) || !Array.isArray(snapshot.facts[key])) return null;
  const rows = snapshot.facts[key].filter(isRecord);
  if (key === 'missions') {
    const ids = relatedMissionIds(data ?? { steps: [] });
    return rows.filter((row) => ids.has(row.id));
  }
  if (key === 'missionRuns') {
    const ids = relatedMissionRunIds(data ?? { steps: [] });
    return rows.filter((row) => ids.has(row.id));
  }
  if (key === 'missionEvents') {
    const missionIds = relatedMissionIds(data ?? { steps: [] });
    const runIds = relatedMissionRunIds(data ?? { steps: [] });
    return rows.filter((row) => missionIds.has(row.mission_id) || runIds.has(row.run_id));
  }
  return runRows(rows, runId);
}

function uniqueIdMap(rows) {
  if (!Array.isArray(rows)) return null;
  const result = new Map();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || result.has(row.id)) return null;
    result.set(row.id, row);
  }
  return result;
}

function attemptKey(row) {
  if (!isRecord(row) || typeof row.step_id !== 'string' || !Number.isInteger(row.attempt))
    return null;
  return row.step_id + '#' + row.attempt;
}

function attemptsMap(rows) {
  if (!Array.isArray(rows)) return null;
  const result = new Map();
  for (const row of rows) {
    const key = attemptKey(row);
    if (key === null || result.has(key) || typeof row.id !== 'string') return null;
    result.set(key, row);
  }
  return result;
}

function runIdentity(workflow) {
  return {
    id: workflow.id,
    definition_id: workflow.definition_id,
    definition_version: workflow.definition_version,
    created_at: workflow.created_at,
  };
}

function identityProjection(row) {
  return {
    id: row.id,
    workflow_run_id: row.workflow_run_id,
    step_id: row.step_id,
    attempt: row.attempt,
    mission_id: row.mission_id ?? null,
    mission_run_id: row.mission_run_id ?? null,
    created_at: row.created_at,
  };
}

function stepById(data, id) {
  return data.steps.find((step) => step.id === id) ?? null;
}

function latestStep(data, stepId) {
  return (
    data.steps
      .filter((step) => step.step_id === stepId)
      .sort((left, right) => Number(right.attempt) - Number(left.attempt))[0] ?? null
  );
}

function completedSteps(data) {
  return data.steps.filter((step) => step.state === 'COMPLETED');
}

function rowMapsEqual(left, right, omit = []) {
  const leftMap = uniqueIdMap(left);
  const rightMap = uniqueIdMap(right);
  if (!leftMap || !rightMap || leftMap.size !== rightMap.size) return false;
  for (const [id, row] of leftMap) {
    const other = rightMap.get(id);
    if (!other || rowHash(row, omit) !== rowHash(other, omit)) return false;
  }
  return true;
}

function oldRowsPreserved(before, after) {
  const beforeMap = uniqueIdMap(before);
  const afterMap = uniqueIdMap(after);
  if (!beforeMap || !afterMap)
    return { status: 'BLOCKED', details: 'Missing or duplicate row IDs.' };
  for (const [id, row] of beforeMap) {
    const current = afterMap.get(id);
    if (!current) return { status: 'FAIL', details: 'Previously committed row disappeared: ' + id };
    if (rowHash(row) !== rowHash(current))
      return { status: 'FAIL', details: 'Previously committed row changed: ' + id };
  }
  return {
    status: 'PASS',
    details: 'Preserved ' + beforeMap.size + ' prior row(s); current total ' + afterMap.size + '.',
  };
}

function requiredSnapshotState(input, scenario) {
  const names = REQUIRED_SNAPSHOTS[scenario];
  const missing = names.filter((name) => !snapshotFor(input, name));
  return { names, missing, ready: missing.length === 0 };
}

function snapshotTables(snapshot, runId, data) {
  const result = {};
  for (const key of [...RUN_TABLES, 'missions', 'missionRuns', 'missionEvents']) {
    result[key] = tableRows(snapshot, key, runId, data);
  }
  return result;
}

function requiredTableFailures(tables) {
  return Object.entries(tables)
    .filter(([, rows]) => !Array.isArray(rows))
    .map(([key]) => key);
}

function phaseFacts(input, phase) {
  const snapshot = snapshotFor(input, phase);
  const data = stageData(snapshot);
  if (!data) return null;
  return { snapshot, data, tables: snapshotTables(snapshot, data.workflow.id, data) };
}

function factsForSnapshots(input, phaseNames) {
  const result = new Map();
  for (const phase of phaseNames) {
    const current = phaseFacts(input, phase);
    if (!current) return { result, missing: [phase + '.facts'] };
    const missing = requiredTableFailures(current.tables).map((name) => phase + '.facts.' + name);
    result.set(phase, current);
    if (missing.length) return { result, missing };
  }
  return { result, missing: [] };
}

function targetMutationRows(tables, data, scenario) {
  const journals = tables.workflow_workspace_mutation_journal;
  if (!Array.isArray(journals)) return null;
  if (scenario === 'CR_A') {
    const stepIds = new Set(data.steps.filter((row) => row.step_id === 'S05').map((row) => row.id));
    return journals.filter((row) => stepIds.has(row.step_run_id));
  }
  return journals.filter((row) => /(?:^|\/)renderer\.ts$/i.test(String(row.relative_path ?? '')));
}

function mutationPaths(journals) {
  if (!Array.isArray(journals)) return null;
  const paths = journals.map((row) => normalizePath(row.relative_path));
  if (paths.some((path) => !path) || new Set(paths).size !== paths.length) return null;
  return paths;
}

function controllerLedger(snapshot) {
  return snapshot && Array.isArray(snapshot.controllerLedger)
    ? snapshot.controllerLedger.filter(isRecord)
    : null;
}

function verifierLedger(snapshot) {
  return snapshot && Array.isArray(snapshot.verifierLedger)
    ? snapshot.verifierLedger.filter(isRecord)
    : null;
}

function controllerCounts(snapshot, paths, generation) {
  const ledger = controllerLedger(snapshot);
  if (!ledger) return null;
  const result = new Map(paths.map((path) => [path, { WRITE_ENTRY: 0, WRITE_RETURN: 0 }]));
  for (const event of ledger) {
    const path = normalizePath(event.path);
    if (!result.has(path) || event.generation !== generation) continue;
    if (event.event === 'WRITE_ENTRY' || event.event === 'WRITE_RETURN')
      result.get(path)[event.event] += 1;
  }
  return result;
}

function countEvents(ledger, event) {
  if (!Array.isArray(ledger)) return null;
  return ledger.filter((row) => row.event === event).length;
}

function missionEventType(row) {
  return typeof row.event_type === 'string' ? row.event_type : '';
}

function workflowStepEventRows(snapshot, runId) {
  return tableRows(snapshot, 'workflow_events', runId);
}

function eventIdsForMissionRuns(snapshot, runIds) {
  const rows = tableRows(snapshot, 'missionEvents', null);
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((row) => runIds.has(row.run_id))
    .map((row) => ({ id: row.id, event_type: row.event_type, run_id: row.run_id }));
}

function eventPayload(row) {
  return parseJson(row.payload_json) ?? {};
}

function toolCallIdFromEvent(row) {
  const payload = eventPayload(row);
  return payload.toolCallId ?? payload.tool_call_id ?? null;
}

function operationRowsForSteps(tables, stepIds) {
  return tables.workflow_step_operation_receipts.filter((row) => stepIds.has(row.step_run_id));
}

function journalRowsForSteps(tables, stepIds) {
  return tables.workflow_workspace_mutation_journal.filter((row) => stepIds.has(row.step_run_id));
}

function completedStepExecutionStable(before, after, completedStepIds) {
  const beforeData = stageData(before);
  const afterData = stageData(after);
  if (!beforeData || !afterData)
    return { status: 'BLOCKED', details: 'Workflow Step facts are unavailable.' };
  const runIds = new Set(
    beforeData.steps
      .filter((step) => completedStepIds.has(step.id) && typeof step.mission_run_id === 'string')
      .map((step) => step.mission_run_id),
  );
  const oldEvents = eventIdsForMissionRuns(before, runIds);
  const newEvents = eventIdsForMissionRuns(after, runIds);
  if (!oldEvents || !newEvents)
    return { status: 'BLOCKED', details: 'Mission event rows are unavailable.' };
  const oldMap = new Map(oldEvents.map((event) => [event.id, event]));
  const newMap = new Map(newEvents.map((event) => [event.id, event]));
  for (const [id, event] of oldMap) {
    if (canonicalJson(newMap.get(id)) !== canonicalJson(event))
      return { status: 'FAIL', details: 'Completed Mission event changed or disappeared: ' + id };
  }
  const additions = [...newMap.keys()].filter((id) => !oldMap.has(id));
  if (additions.length)
    return {
      status: 'FAIL',
      details: 'Completed MissionRun gained event(s): ' + additions.join(', '),
    };
  return {
    status: 'PASS',
    details: 'No new Mission events on previously completed Step MissionRuns.',
  };
}

function runEventRowsStable(before, after, runId, completedStepIds) {
  const oldRows = workflowStepEventRows(before, runId);
  const newRows = workflowStepEventRows(after, runId);
  if (!oldRows || !newRows)
    return { status: 'BLOCKED', details: 'Workflow event rows are unavailable.' };
  const oldMap = uniqueIdMap(oldRows);
  const newMap = uniqueIdMap(newRows);
  if (!oldMap || !newMap)
    return { status: 'BLOCKED', details: 'Workflow event IDs are missing or duplicated.' };
  for (const [id, row] of oldMap) {
    if (!newMap.has(id) || rowHash(row) !== rowHash(newMap.get(id)))
      return { status: 'FAIL', details: 'Workflow event changed or disappeared: ' + id };
  }
  const additions = newRows.filter((row) => !oldMap.has(row.id));
  const onCompletedStep = additions.find((row) => completedStepIds.has(row.step_run_id));
  if (onCompletedStep)
    return {
      status: 'FAIL',
      details: 'Completed Step gained Workflow event: ' + onCompletedStep.id,
    };
  return {
    status: 'PASS',
    details: 'Prior Workflow events preserved; no additions on completed Steps.',
  };
}

function namedStep(data, stepId) {
  return latestStep(data, stepId);
}

function matchingMissions(tables, step) {
  if (!step || !step.mission_id || !Array.isArray(tables.missions)) return [];
  return tables.missions.filter((row) => row.id === step.mission_id);
}

function matchingMissionRuns(tables, step) {
  if (!step || !step.mission_run_id || !Array.isArray(tables.missionRuns)) return [];
  return tables.missionRuns.filter((row) => row.id === step.mission_run_id);
}

function targetOperationRows(tables, data, targetJournals = null) {
  const allRows = tables.workflow_step_operation_receipts;
  if (!Array.isArray(allRows)) return null;
  if (!Array.isArray(targetJournals)) {
    const stepIds = new Set(data.steps.filter((row) => row.step_id === 'S05').map((row) => row.id));
    return allRows.filter((row) => stepIds.has(row.step_run_id));
  }
  const journalOperationIds = new Set(targetJournals.map((row) => row.operation_receipt_id));
  return allRows.filter((row) => journalOperationIds.has(row.id));
}

function targetJournalRows(tables, data, scenario) {
  if (scenario === 'CR_B') return targetMutationRows(tables, data, scenario);
  const stepIds = new Set(data.steps.filter((row) => row.step_id === 'S05').map((row) => row.id));
  const rows = journalRowsForSteps(tables, stepIds);
  return rows;
}

function targetStepFor(phase, scenario) {
  if (!phase) return null;
  const journals = targetJournalRows(phase.tables, phase.data, scenario);
  if (!Array.isArray(journals) || journals.length !== 1) return null;
  return stepById(phase.data, journals[0].step_run_id);
}

function operationIdentityEqual(left, right) {
  return OPERATION_IDENTITY_COLUMNS.every(
    (key) => canonicalJson(left[key] ?? null) === canonicalJson(right[key] ?? null),
  );
}

function compareOperationRows(before, after) {
  const beforeMap = uniqueIdMap(before);
  const afterMap = uniqueIdMap(after);
  if (!beforeMap || !afterMap)
    return { status: 'BLOCKED', details: 'Operation receipt IDs are missing or duplicated.' };
  for (const [id, row] of beforeMap) {
    const current = afterMap.get(id);
    if (!current) return { status: 'FAIL', details: 'Operation receipt disappeared: ' + id };
    if (!operationIdentityEqual(row, current))
      return { status: 'FAIL', details: 'Operation receipt identity changed: ' + id };
  }
  if (afterMap.size !== beforeMap.size)
    return { status: 'FAIL', details: 'Unexpected target Operation receipt was added.' };
  return {
    status: 'PASS',
    details: 'Target Operation receipt identities are stable; no new receipt was added.',
  };
}

function mutationJournalEqual(left, right) {
  return rowHash(left) === rowHash(right);
}

function compareJournalRows(before, after) {
  const beforeMap = uniqueIdMap(before);
  const afterMap = uniqueIdMap(after);
  if (!beforeMap || !afterMap)
    return { status: 'BLOCKED', details: 'Mutation Journal IDs are missing or duplicated.' };
  for (const [id, row] of beforeMap) {
    const current = afterMap.get(id);
    if (!current) return { status: 'FAIL', details: 'Mutation Journal row disappeared: ' + id };
    if (!mutationJournalEqual(row, current))
      return { status: 'FAIL', details: 'Mutation Journal row changed: ' + id };
  }
  if (afterMap.size !== beforeMap.size)
    return { status: 'FAIL', details: 'Unexpected target Mutation Journal row was added.' };
  return {
    status: 'PASS',
    details: 'Target Mutation Journal rows are byte-stable; no new row was added.',
  };
}

function stepIdentityComparison(before, after, allowNewAttempts) {
  const beforeMap = attemptsMap(before.steps);
  const afterMap = attemptsMap(after.steps);
  if (!beforeMap || !afterMap)
    return { status: 'BLOCKED', details: 'Step attempt identities are missing or duplicated.' };
  for (const [key, row] of beforeMap) {
    const current = afterMap.get(key);
    if (!current) return { status: 'FAIL', details: 'Prior Step attempt disappeared: ' + key };
    if (canonicalJson(identityProjection(row)) !== canonicalJson(identityProjection(current)))
      return { status: 'FAIL', details: 'Prior Step attempt identity changed: ' + key };
  }
  if (!allowNewAttempts && afterMap.size !== beforeMap.size)
    return {
      status: 'FAIL',
      details:
        'Step attempt was added without a user-authorized continuation: ' +
        (afterMap.size - beforeMap.size),
    };
  return {
    status: 'PASS',
    details:
      'Preserved ' +
      beforeMap.size +
      ' prior Step attempt(s)' +
      (allowNewAttempts ? '; continuation may add later attempts.' : '; no new attempt was added.'),
  };
}

function definitionsAndRunIdentities(phases) {
  const entries = [...phases.entries()];
  const first = entries[0]?.[1]?.data;
  if (!first) return { status: 'BLOCKED', details: 'Workflow Run identity is unavailable.' };
  const expected = runIdentity(first.workflow);
  if (
    first.workflow.definition_id !== 'official.software-feature' ||
    Number(first.workflow.definition_version) !== 1
  )
    return { status: 'FAIL', details: 'Run is not pinned to official.software-feature version 1.' };
  for (const [phase, current] of entries) {
    if (canonicalJson(runIdentity(current.data.workflow)) !== canonicalJson(expected))
      return { status: 'FAIL', details: 'Workflow Run identity changed at ' + phase + '.' };
  }
  return {
    status: 'PASS',
    details:
      'One official.software-feature@1 Run identity is preserved across ' +
      entries.length +
      ' snapshots.',
  };
}

function completedStepIdsFrom(phases) {
  const first = phases.get('beforeCrash');
  if (!first) return null;
  return new Set(completedSteps(first.data).map((row) => row.id));
}

function checkCompletedStepExecutions(phases, phaseNames, completedIds) {
  if (!(completedIds instanceof Set))
    return { status: 'BLOCKED', details: 'Pre-crash completed Step set is unavailable.' };
  const baseline = phases.get('beforeCrash');
  if (!baseline) return { status: 'BLOCKED', details: 'Pre-crash snapshot is unavailable.' };
  const all = [];
  for (const phase of phaseNames) {
    if (phase === 'beforeCrash') continue;
    const current = phases.get(phase);
    if (!current) return { status: 'BLOCKED', details: 'Snapshot is unavailable: ' + phase };
    const missionResult = completedStepExecutionStable(
      baseline.snapshot,
      current.snapshot,
      completedIds,
    );
    if (missionResult.status !== 'PASS')
      return { ...missionResult, details: phase + ': ' + missionResult.details };
    const workflowResult = runEventRowsStable(
      baseline.snapshot,
      current.snapshot,
      baseline.data.workflow.id,
      completedIds,
    );
    if (workflowResult.status !== 'PASS')
      return { ...workflowResult, details: phase + ': ' + workflowResult.details };
    const missionEvents = tableRows(current.snapshot, 'missionEvents', null);
    const relevantRunIds = new Set(
      baseline.data.steps
        .filter((step) => completedIds.has(step.id))
        .map((step) => step.mission_run_id)
        .filter(Boolean),
    );
    const executionCount = missionEvents?.filter(
      (event) =>
        relevantRunIds.has(event.run_id) && EXECUTION_EVENT_TYPES.has(missionEventType(event)),
    ).length;
    if (typeof executionCount !== 'number')
      return { status: 'BLOCKED', details: phase + ': execution-event facts are unavailable.' };
    all.push(phase + '=' + executionCount);
  }
  return {
    status: 'PASS',
    details: 'Completed Step execution events stayed stable: ' + all.join(', ') + '.',
  };
}

function appendOnlyComparison(before, after, allowAdditions, tableNames = APPEND_ONLY_TABLES) {
  for (const key of tableNames) {
    const oldRows = before.tables[key];
    const newRows = after.tables[key];
    if (!Array.isArray(oldRows) || !Array.isArray(newRows))
      return { status: 'BLOCKED', details: key + ' rows are unavailable.' };
    const preserved = oldRowsPreserved(oldRows, newRows);
    if (preserved.status !== 'PASS')
      return { ...preserved, details: key + ': ' + preserved.details };
    if (!allowAdditions && oldRows.length !== newRows.length)
      return { status: 'FAIL', details: key + ' gained rows during an unattended restart.' };
  }
  return {
    status: 'PASS',
    details:
      'Prior durable row IDs and hashes are preserved across ' +
      tableNames.length +
      ' table(s).' +
      (allowAdditions
        ? ' New rows are permitted only after explicit continuation.'
        : ' No rows were added.'),
  };
}

function workspaceHashes(snapshot) {
  if (!snapshot || !isRecord(snapshot.workspaceFiles)) return null;
  const result = {};
  for (const [name, value] of Object.entries(snapshot.workspaceFiles)) {
    if (!isRecord(value) || typeof value.sha256 !== 'string') return null;
    result[normalizePath(name)] = value.sha256.toLowerCase();
  }
  return result;
}

function workspaceHashFor(snapshot, relativePath) {
  const hashes = workspaceHashes(snapshot);
  if (!hashes) return null;
  const normalized = normalizePath(relativePath);
  if (hasOwn(hashes, normalized)) return hashes[normalized];
  const basename = normalized.split('/').at(-1);
  const matches = Object.entries(hashes).filter(([name]) => name.split('/').at(-1) === basename);
  return matches.length === 1 ? matches[0][1] : null;
}

function workspaceTag(snapshot) {
  const root = snapshot?.processState?.workspace;
  if (typeof root !== 'string' || !root) return null;
  return createHash('sha256').update(root.toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

function missionEventsForRun(snapshot, missionRunId) {
  const rows = tableRows(snapshot, 'missionEvents', null);
  return Array.isArray(rows) ? rows.filter((row) => row.run_id === missionRunId) : null;
}

function matchingToolResult(
  snapshot,
  missionRunId,
  toolCallId,
  journal = null,
  requireSuccess = false,
) {
  const rows = missionEventsForRun(snapshot, missionRunId);
  if (!rows) return false;
  return rows.some((row) => {
    const type = missionEventType(row).toLowerCase();
    const payload = eventPayload(row);
    return (
      type === 'tool.result' &&
      toolCallIdFromEvent(row) === toolCallId &&
      (!requireSuccess ||
        (payload.success === true &&
          payload.toolId === 'file.writeText' &&
          payload.resource === journal?.permission_resource))
    );
  });
}

function manifestMatchesJournals(operation, journals) {
  const manifest = parseJson(operation?.manifest_json);
  if (!Array.isArray(manifest) || manifest.length !== journals.length) return false;
  const byPath = new Map(manifest.map((entry) => [normalizePath(entry?.relativePath), entry]));
  if (byPath.size !== manifest.length) return false;
  return journals.every((journal) => {
    const entry = byPath.get(normalizePath(journal.relative_path));
    return (
      Boolean(entry) &&
      String(entry.afterHash ?? '').toLowerCase() ===
        String(journal.expected_after_hash ?? '').toLowerCase() &&
      String(journal.observed_after_hash ?? '').toLowerCase() ===
        String(journal.expected_after_hash ?? '').toLowerCase()
    );
  });
}

function crACompletionEvidence(phase) {
  const { snapshot, data, tables } = phase;
  const s05 = namedStep(data, 'S05');
  const s06 = namedStep(data, 'S06');
  if (!s05 || !s06) return { status: 'BLOCKED', details: 'S05/S06 Step facts are unavailable.' };
  if (s05.state !== 'COMPLETED' || s06.state !== 'COMPLETED')
    return { status: 'FAIL', details: 'S05 and S06 must be committed COMPLETED before recovery.' };
  const missions = matchingMissions(tables, s05);
  const missionRuns = matchingMissionRuns(tables, s05);
  if (missions.length !== 1 || missionRuns.length !== 1)
    return { status: 'BLOCKED', details: 'S05 Mission/MissionRun facts are missing or ambiguous.' };
  if (missions[0].state !== 'COMPLETED' || missionRuns[0].status !== 'COMPLETED')
    return {
      status: 'FAIL',
      details: 'Completed S05 Step is not backed by a COMPLETED Mission and MissionRun.',
    };
  const stepIds = new Set([s05.id]);
  const operations = operationRowsForSteps(tables, stepIds);
  const journals = journalRowsForSteps(tables, stepIds);
  if (operations.length !== 1 || journals.length !== 3)
    return {
      status: 'BLOCKED',
      details: 'Expected one S05 Operation receipt and three path-specific mutation journals.',
    };
  if (operations[0].state !== 'VERIFIED' || operations[0].effect_type !== 'WORKSPACE_MUTATION')
    return { status: 'FAIL', details: 'S05 mutation Operation is not VERIFIED.' };
  const paths = mutationPaths(journals);
  if (!paths || paths.length !== 3)
    return { status: 'FAIL', details: 'S05 mutation paths are missing or duplicated.' };
  for (const journal of journals) {
    if (journal.state !== 'APPLIED' || journal.observed_after_hash !== journal.expected_after_hash)
      return {
        status: 'FAIL',
        details:
          'S05 Journal is not APPLIED with the expected observed hash: ' + journal.relative_path,
      };
    if (!matchingToolResult(snapshot, s05.mission_run_id, journal.tool_call_id, journal, true))
      return {
        status: 'FAIL',
        details: 'Completed S05 lacks the matching tool.result fact: ' + journal.tool_call_id,
      };
    const actualHash = workspaceHashFor(snapshot, journal.relative_path);
    if (actualHash === null)
      return {
        status: 'BLOCKED',
        details: 'Workspace hash is unavailable for ' + journal.relative_path,
      };
    if (actualHash !== String(journal.expected_after_hash).toLowerCase())
      return {
        status: 'FAIL',
        details: 'Workspace file hash differs from the committed Journal: ' + journal.relative_path,
      };
  }
  return {
    status: 'PASS',
    details:
      'S05/S06, Mission/MissionRun, VERIFIED Operation, three APPLIED journals, matching tool.result facts, and workspace hashes agree.',
  };
}

function crBInterruptedEvidence(phase, scenario) {
  const { snapshot, data, tables } = phase;
  const journals = targetJournalRows(tables, data, scenario);
  if (!journals || journals.length !== 1)
    return { status: 'BLOCKED', details: 'One target renderer.ts Journal is required.' };
  const targetStep = stepById(data, journals[0].step_run_id);
  if (!targetStep)
    return { status: 'BLOCKED', details: 'Target mutation Step fact is unavailable.' };
  if (
    targetStep.state !== 'WAITING' ||
    targetStep.wait_reason !== 'USER_CONFIRMATION' ||
    targetStep.error_code !== 'EXECUTION_INTERRUPTED_RETRY_REQUIRED'
  )
    return {
      status: 'FAIL',
      details:
        targetStep.step_id +
        ' must remain WAITING/USER_CONFIRMATION with EXECUTION_INTERRUPTED_RETRY_REQUIRED.',
    };
  if (data.workflow.state !== 'WAITING' || data.workflow.wait_reason !== 'USER_CONFIRMATION')
    return { status: 'FAIL', details: 'Workflow Run must remain WAITING/USER_CONFIRMATION.' };
  const missions = matchingMissions(tables, targetStep);
  const missionRuns = matchingMissionRuns(tables, targetStep);
  if (missions.length !== 1 || missionRuns.length !== 1)
    return {
      status: 'BLOCKED',
      details: 'Target mutation Mission/MissionRun facts are missing or ambiguous.',
    };
  if (
    missions[0].state !== 'INTERRUPTED' ||
    missionRuns[0].status !== 'INTERRUPTED' ||
    missionRuns[0].error_code !== 'APP_RESTARTED'
  )
    return {
      status: 'FAIL',
      details: 'Mission/MissionRun must be INTERRUPTED with MissionRun error_code APP_RESTARTED.',
    };
  const operations = targetOperationRows(tables, data, journals);
  if (!operations || operations.length !== 1)
    return {
      status: 'BLOCKED',
      details: 'Expected one target Operation and one renderer.ts mutation Journal.',
    };
  if (operations[0].id !== journals[0].operation_receipt_id || operations[0].state !== 'UNKNOWN')
    return {
      status: 'FAIL',
      details: 'Interrupted Operation must be UNKNOWN and linked to the Journal.',
    };
  if (journals[0].state !== 'PREPARED')
    return { status: 'FAIL', details: 'Mutation Journal must remain PREPARED after the crash.' };
  const verifier = verifierLedger(snapshot);
  if (!verifier) return { status: 'BLOCKED', details: 'Verifier ledger is unavailable.' };
  if (verifier.length !== 0)
    return { status: 'FAIL', details: 'S06 verifier ran during CR-B recovery.' };
  if (matchingToolResult(snapshot, targetStep.mission_run_id, journals[0].tool_call_id))
    return {
      status: 'FAIL',
      details: 'CR-B has a tool.result despite the interrupted Tool Promise.',
    };
  return {
    status: 'PASS',
    details:
      'Mission/MissionRun interrupted; Operation UNKNOWN; Journal PREPARED; S05 and Workflow wait for confirmation; no verifier or tool.result.',
  };
}

function expectedControllerCounts(snapshot, paths, generation, expectedCount) {
  const counts = controllerCounts(snapshot, paths, generation);
  if (!counts)
    return { status: 'BLOCKED', details: 'Independent controller write ledger is unavailable.' };
  for (const path of paths) {
    const actual = counts.get(path);
    if (!actual)
      return { status: 'BLOCKED', details: 'Controller ledger omitted target path ' + path + '.' };
    const values = [actual.WRITE_ENTRY, actual.WRITE_RETURN];
    if (values.some((value) => value > expectedCount))
      return {
        status: 'FAIL',
        details:
          'Controller observed duplicate writes for ' + path + ' at generation ' + generation + '.',
      };
    if (values.some((value) => value !== expectedCount))
      return {
        status: expectedCount === 0 ? 'FAIL' : 'BLOCKED',
        details:
          'Controller counts for ' +
          path +
          ' at generation ' +
          generation +
          ' are incomplete: ' +
          actual.WRITE_ENTRY +
          '/' +
          actual.WRITE_RETURN +
          '.',
      };
  }
  return {
    status: 'PASS',
    details:
      'Independent WRITE_ENTRY/WRITE_RETURN counts match for ' +
      paths.length +
      ' path(s) at generation ' +
      generation +
      '.',
  };
}

function checkControllerNoReplay(phases, phaseNames, paths) {
  if (!Array.isArray(paths) || paths.length === 0)
    return { status: 'BLOCKED', details: 'Target mutation paths are unavailable.' };
  for (const phaseName of phaseNames) {
    const phase = phases.get(phaseName);
    if (!phase) return { status: 'BLOCKED', details: 'Snapshot is unavailable: ' + phaseName };
    const ledger = controllerLedger(phase.snapshot);
    if (!ledger)
      return {
        status: 'BLOCKED',
        details: phaseName + ': independent controller ledger is unavailable.',
      };
    const generation = phase.snapshot.processState?.generation;
    if (!Number.isInteger(generation))
      return { status: 'BLOCKED', details: phaseName + ': process generation is unavailable.' };
    const result = expectedControllerCounts(phase.snapshot, paths, 0, 1);
    if (result.status !== 'PASS') return { ...result, details: phaseName + ': ' + result.details };
    for (let replayGeneration = 1; replayGeneration <= generation; replayGeneration += 1) {
      const replay = expectedControllerCounts(phase.snapshot, paths, replayGeneration, 0);
      if (replay.status !== 'PASS')
        return { ...replay, details: phaseName + ': ' + replay.details };
    }
  }
  return {
    status: 'PASS',
    details:
      'Each target path has one independent generation-0 entry and return; unattended restart generations have zero writes.',
  };
}

function checkTargetFactsStable(phases, phaseNames, scenario) {
  const firstName = phaseNames[0];
  const first = phases.get(firstName);
  if (!first) return { status: 'BLOCKED', details: 'Baseline target facts are unavailable.' };
  const firstJournals = targetJournalRows(first.tables, first.data, scenario);
  if (!firstJournals || firstJournals.length === 0)
    return { status: 'BLOCKED', details: 'Baseline target mutation Journal is unavailable.' };
  const firstOperations = targetOperationRows(first.tables, first.data, firstJournals);
  for (const phaseName of phaseNames.slice(1)) {
    const phase = phases.get(phaseName);
    if (!phase) return { status: 'BLOCKED', details: 'Snapshot is unavailable: ' + phaseName };
    const journals = targetJournalRows(phase.tables, phase.data, scenario);
    const journalResult = compareJournalRows(firstJournals, journals);
    if (journalResult.status !== 'PASS')
      return { ...journalResult, details: phaseName + ': ' + journalResult.details };
    const operations = targetOperationRows(phase.tables, phase.data, journals);
    const operationResult = compareOperationRows(firstOperations, operations);
    if (operationResult.status !== 'PASS')
      return { ...operationResult, details: phaseName + ': ' + operationResult.details };
  }
  return {
    status: 'PASS',
    details:
      'Target operation and journal identities persist across phases without duplicate rows.',
  };
}

function checkNoUnexpectedExecutionEvents(phases, phaseNames, data, targetStepId) {
  const targetStep =
    data.steps.find((step) => step.step_id === targetStepId) ?? stepById(data, targetStepId);
  if (!targetStep || !targetStep.mission_run_id)
    return { status: 'BLOCKED', details: 'Target MissionRun identity is unavailable.' };
  const baseline = phases.get(phaseNames[0]);
  if (!baseline) return { status: 'BLOCKED', details: 'Baseline snapshot is unavailable.' };
  const baselineRows = missionEventsForRun(baseline.snapshot, targetStep.mission_run_id);
  if (!baselineRows)
    return { status: 'BLOCKED', details: 'Baseline Mission event rows are unavailable.' };
  const baselineExecution = baselineRows.filter((row) =>
    EXECUTION_EVENT_TYPES.has(missionEventType(row)),
  );
  const baselineIds = new Set(baselineExecution.map((row) => row.id));
  const baselineCounts = eventExecutionCounts(
    baseline.snapshot,
    new Set([targetStep.mission_run_id]),
  );
  if (!baselineCounts)
    return { status: 'BLOCKED', details: 'Baseline execution-event counts are unavailable.' };
  for (const phaseName of phaseNames.slice(1)) {
    const phase = phases.get(phaseName);
    if (!phase) return { status: 'BLOCKED', details: 'Snapshot is unavailable: ' + phaseName };
    const rows = missionEventsForRun(phase.snapshot, targetStep.mission_run_id);
    if (!rows)
      return { status: 'BLOCKED', details: phaseName + ': Mission event rows are unavailable.' };
    const execution = rows.filter((row) => EXECUTION_EVENT_TYPES.has(missionEventType(row)));
    const currentCounts = eventExecutionCounts(
      phase.snapshot,
      new Set([targetStep.mission_run_id]),
    );
    if (!currentCounts)
      return {
        status: 'BLOCKED',
        details: phaseName + ': execution-event counts are unavailable.',
      };
    if (canonicalJson(currentCounts) !== canonicalJson(baselineCounts))
      return {
        status: 'FAIL',
        details: phaseName + ': model/tool execution event counts changed.',
      };
    const idsAfter = new Set(execution.map((row) => row.id));
    const added = [...idsAfter].filter((id) => !baselineIds.has(id));
    const removed = [...baselineIds].filter((id) => !idsAfter.has(id));
    if (added.length || removed.length)
      return {
        status: 'FAIL',
        details:
          phaseName +
          ': target execution events changed; added=' +
          added.length +
          ', removed=' +
          removed.length +
          '.',
      };
  }
  return {
    status: 'PASS',
    details:
      'No additional model/tool execution events were recorded for the interrupted target MissionRun.',
  };
}

function snapshotAndProcessCheck(input, names) {
  const expectedGeneration = {
    beforeCrash: 0,
    afterKill: 0,
    firstRestart: 1,
    explicitContinue: 1,
    secondRestart: 2,
  };
  const expectedLifecycle = {
    beforeCrash: 'PAUSED',
    afterKill: 'TERMINATED',
    firstRestart: 'RUNNING',
    explicitContinue: 'RUNNING',
    secondRestart: 'RUNNING',
  };
  let profile = null;
  let workspace = null;
  const pids = new Map();
  for (const name of names) {
    const snapshot = snapshotFor(input, name);
    if (!snapshot) return { status: 'BLOCKED', details: 'Snapshot is missing: ' + name };
    if (
      !isRecord(snapshot.checks) ||
      typeof snapshot.checks.integrity !== 'string' ||
      !Array.isArray(snapshot.checks.foreignKeys)
    )
      return { status: 'BLOCKED', details: name + ': SQLite integrity/FK checks are unavailable.' };
    if (snapshot.checks.integrity !== 'ok')
      return {
        status: 'FAIL',
        details: name + ': integrity_check returned ' + snapshot.checks.integrity + '.',
      };
    if (snapshot.checks.foreignKeys.length !== 0)
      return {
        status: 'FAIL',
        details:
          name +
          ': foreign_key_check returned ' +
          snapshot.checks.foreignKeys.length +
          ' error(s).',
      };
    if (name === 'afterKill') {
      const triplet = snapshot.rawTriplet;
      if (
        !isRecord(triplet) ||
        triplet.copiedBeforeAnySQLiteOpen !== true ||
        !hasOwn(triplet, 'sourceBefore') ||
        !hasOwn(triplet, 'sourceAfter')
      )
        return {
          status: 'BLOCKED',
          details:
            'afterKill raw SQLite triplet lacks pre-open copy/sourceBefore/sourceAfter evidence.',
        };
    }
    const process = snapshot.processState;
    if (
      !isRecord(process) ||
      process.profileVerifiedFromRuntime !== true ||
      typeof process.isolatedProfile !== 'string' ||
      !process.isolatedProfile.trim() ||
      typeof process.workspace !== 'string' ||
      !process.workspace.trim() ||
      !Number.isInteger(process.generation) ||
      (typeof process.mainPid !== 'string' && typeof process.mainPid !== 'number')
    )
      return {
        status: 'BLOCKED',
        details: name + ': runtime-verified isolated process identity is incomplete.',
      };
    if (process.generation !== expectedGeneration[name])
      return {
        status: 'FAIL',
        details:
          name +
          ': expected generation ' +
          expectedGeneration[name] +
          ', saw ' +
          process.generation +
          '.',
      };
    if (process.lifecycle !== expectedLifecycle[name])
      return {
        status: 'FAIL',
        details:
          name +
          ': expected lifecycle ' +
          expectedLifecycle[name] +
          ', saw ' +
          String(process.lifecycle) +
          '.',
      };
    if (profile === null) {
      profile = process.isolatedProfile;
      workspace = process.workspace;
    } else if (profile !== process.isolatedProfile || workspace !== process.workspace) {
      return {
        status: 'FAIL',
        details: name + ': process switched away from the same isolated profile/workspace.',
      };
    }
    pids.set(name, String(process.mainPid));
  }
  if (normalizePath(profile) === normalizePath(workspace))
    return { status: 'FAIL', details: 'Isolated profile and workspace resolve to the same path.' };
  const mainPid = (name) => pids.get(name);
  if (mainPid('beforeCrash') !== mainPid('afterKill'))
    return {
      status: 'FAIL',
      details: 'The afterKill snapshot does not identify the terminated pre-crash main PID.',
    };
  if (
    mainPid('firstRestart') === mainPid('afterKill') ||
    mainPid('secondRestart') === mainPid('firstRestart')
  )
    return {
      status: 'FAIL',
      details: 'Restarted generations do not have distinct main process PIDs.',
    };
  if (names.includes('explicitContinue') && mainPid('explicitContinue') !== mainPid('firstRestart'))
    return {
      status: 'FAIL',
      details: 'Explicit continuation did not use the first restarted process.',
    };
  return {
    status: 'PASS',
    details:
      'SQLite checks passed; raw triplet was copied before SQLite open; runtime verified one isolated profile/workspace across generations 0, 1, and 2.',
  };
}

function rawRowSetsStable(before, after) {
  if (!before || !after)
    return { status: 'BLOCKED', details: 'Comparison snapshots are unavailable.' };
  const beforeWorkflow = before.data.workflow;
  const afterWorkflow = after.data.workflow;
  if (rowHash(beforeWorkflow, ['updated_at']) !== rowHash(afterWorkflow, ['updated_at']))
    return {
      status: 'FAIL',
      details: 'Workflow Run fields changed between final continuation and second restart.',
    };
  const beforeSteps = before.data.steps;
  const afterSteps = after.data.steps;
  if (!rowMapsEqual(beforeSteps, afterSteps))
    return {
      status: 'FAIL',
      details: 'Step rows changed between final continuation and second restart.',
    };
  for (const key of [...RUN_TABLES, 'missions', 'missionRuns', 'missionEvents']) {
    if (!rowMapsEqual(before.tables[key], after.tables[key]))
      return {
        status: 'FAIL',
        details: key + ' IDs/rows changed between final continuation and second restart.',
      };
  }
  const beforeHashes = workspaceHashes(before.snapshot);
  const afterHashes = workspaceHashes(after.snapshot);
  if (!beforeHashes || !afterHashes)
    return { status: 'BLOCKED', details: 'Workspace file hashes are unavailable.' };
  if (canonicalJson(beforeHashes) !== canonicalJson(afterHashes))
    return {
      status: 'FAIL',
      details: 'Workspace file hashes changed between final continuation and second restart.',
    };
  return {
    status: 'PASS',
    details:
      'Final continuation and second restart have stable Run identity/state, Step rows, durable IDs/hashes, events, and workspace hashes.',
  };
}

function checkVerifierLedger(phases, phaseNames, expected) {
  let baseline = null;
  for (const phaseName of phaseNames) {
    const phase = phases.get(phaseName);
    if (!phase) return { status: 'BLOCKED', details: 'Snapshot is unavailable: ' + phaseName };
    const ledger = verifierLedger(phase.snapshot);
    if (!ledger)
      return { status: 'BLOCKED', details: phaseName + ': verifier ledger is unavailable.' };
    if (baseline === null) baseline = ledger;
    if (canonicalJson(ledger) !== canonicalJson(baseline))
      return { status: 'FAIL', details: 'Verifier ledger changed at ' + phaseName + '.' };
    for (const [event, count] of Object.entries(expected)) {
      if (countEvents(ledger, event) !== count)
        return {
          status: 'FAIL',
          details: phaseName + ': expected ' + count + ' verifier ' + event + ' event(s).',
        };
    }
  }
  return {
    status: 'PASS',
    details:
      'Verifier execution ledger has the expected count and no replay across all compared phases.',
  };
}

function checkCRBNoManualAdvance(input, phases) {
  if (input.explicitContinue !== undefined && input.explicitContinue !== null)
    return {
      status: 'FAIL',
      details: 'CR-B must not include explicit continuation, advance, or retry.',
    };
  const phasesToCompare = ['firstRestart', 'secondRestart'];
  for (const phaseName of phasesToCompare) {
    const phase = phases.get(phaseName);
    if (!phase) return { status: 'BLOCKED', details: 'Snapshot is unavailable: ' + phaseName };
    const targetStep = targetStepFor(phase, 'CR_B');
    if (!targetStep)
      return { status: 'BLOCKED', details: phaseName + ': target mutation Step is unavailable.' };
    if (
      targetStep.state !== 'WAITING' ||
      targetStep.wait_reason !== 'USER_CONFIRMATION' ||
      targetStep.error_code !== 'EXECUTION_INTERRUPTED_RETRY_REQUIRED'
    )
      return {
        status: 'FAIL',
        details: phaseName + ': CR-B cannot be advanced or retried automatically.',
      };
  }
  return {
    status: 'PASS',
    details:
      'No explicitContinue snapshot or retry/advance evidence exists in CR-B; both restarts preserve the confirmation wait.',
  };
}

function eventExecutionCounts(snapshot, missionRunIds) {
  const rows = tableRows(snapshot, 'missionEvents', null);
  if (!Array.isArray(rows)) return null;
  const counts = {};
  for (const eventType of EXECUTION_EVENT_TYPES) counts[eventType] = 0;
  for (const row of rows) {
    const type = missionEventType(row);
    if (missionRunIds.has(row.run_id) && hasOwn(counts, type)) counts[type] += 1;
  }
  return counts;
}

function evaluateCRAChecks(input, checks, snapshotState) {
  const { names, missing } = snapshotState;
  const all = factsForSnapshots(input, names);
  const phaseNames = names;
  if (missing.length) {
    for (const id of CHECK_IDS) {
      if (id === 'REC-08') continue;
      addCheck(
        checks,
        id,
        'BLOCKED',
        'missing snapshots: ' + missing.join(', '),
        'Required CR-A phases are incomplete.',
      );
    }
    const offlineStatus =
      input.offlineRetryTestPassed === true
        ? 'PASS'
        : input.offlineRetryTestPassed === false
          ? 'FAIL'
          : 'BLOCKED';
    addCheck(
      checks,
      'REC-08',
      offlineStatus,
      'offlineRetryTestPassed',
      input.offlineRetryTestPassed === true
        ? 'Independent offline retry test passed; CR-A recovery snapshots are incomplete.'
        : input.offlineRetryTestPassed === false
          ? 'Independent offline retry test failed.'
          : 'Independent offline retry test result is missing.',
    );
    return;
  }
  if (all.missing.length) {
    for (const id of CHECK_IDS) {
      if (id === 'REC-08') continue;
      addCheck(
        checks,
        id,
        'BLOCKED',
        'missing facts: ' + all.missing.join(', '),
        'Required CR-A table facts are incomplete.',
      );
    }
    const offlineStatus =
      input.offlineRetryTestPassed === true
        ? 'PASS'
        : input.offlineRetryTestPassed === false
          ? 'FAIL'
          : 'BLOCKED';
    addCheck(
      checks,
      'REC-08',
      offlineStatus,
      'offlineRetryTestPassed',
      input.offlineRetryTestPassed === true
        ? 'Independent offline retry test passed; CR-A recovery facts are incomplete.'
        : input.offlineRetryTestPassed === false
          ? 'Independent offline retry test failed.'
          : 'Independent offline retry test result is missing.',
    );
    return;
  }
  const phases = all.result;
  const completedIds = completedStepIdsFrom(phases);
  const identities = definitionsAndRunIdentities(phases);
  const byPhase = (callback) => {
    for (const phaseName of phaseNames) {
      const result = callback(phases.get(phaseName));
      if (result.status !== 'PASS')
        return { ...result, details: phaseName + ': ' + result.details };
    }
    return { status: 'PASS', details: 'The invariant is true in every required phase.' };
  };
  const identityTransitions = [
    ['beforeCrash', 'afterKill', false],
    ['afterKill', 'firstRestart', false],
    ['firstRestart', 'explicitContinue', true],
    ['explicitContinue', 'secondRestart', false],
  ];
  let result = identities;
  if (result.status === 'PASS') {
    for (const [beforeName, afterName, allowNew] of identityTransitions) {
      result = stepIdentityComparison(
        phases.get(beforeName).data,
        phases.get(afterName).data,
        allowNew,
      );
      if (result.status !== 'PASS') {
        result = { ...result, details: beforeName + ' -> ' + afterName + ': ' + result.details };
        break;
      }
    }
  }
  addCheck(
    checks,
    'REC-01',
    result.status,
    result.evidence ?? 'definition, Run and Step attempt identity',
    result.details,
  );

  result = checkCompletedStepExecutions(phases, phaseNames, completedIds);
  addCheck(
    checks,
    'REC-02',
    result.status,
    'completed Step Mission and Workflow event chains',
    result.details,
  );

  const appendTransitions = [
    ['beforeCrash', 'afterKill', false],
    ['afterKill', 'firstRestart', false],
    ['firstRestart', 'explicitContinue', true],
    ['explicitContinue', 'secondRestart', false],
  ];
  result = {
    status: 'PASS',
    details: 'Prior IDs and hashes are preserved; additions are confined to explicit continuation.',
  };
  for (const [beforeName, afterName, allow] of appendTransitions) {
    result = appendOnlyComparison(phases.get(beforeName), phases.get(afterName), allow);
    if (result.status !== 'PASS') {
      result = { ...result, details: beforeName + ' -> ' + afterName + ': ' + result.details };
      break;
    }
  }
  addCheck(
    checks,
    'REC-03',
    result.status,
    'Artifact/Receipt/Checkpoint/Binding/Decision/Traversal/Workflow event rows',
    result.details,
  );

  const baselineData = phases.get('beforeCrash').data;
  const mutationRows = targetJournalRows(phases.get('beforeCrash').tables, baselineData, 'CR_A');
  const paths = mutationPaths(mutationRows);
  if (!paths || paths.length !== 3) {
    result = {
      status: 'BLOCKED',
      details:
        'S05 must expose exactly three distinct Journal paths to reconcile with the independent controller.',
    };
  } else {
    result = checkControllerNoReplay(phases, phaseNames, paths);
    if (result.status === 'PASS') result = checkTargetFactsStable(phases, phaseNames, 'CR_A');
  }
  const verifierResult = checkVerifierLedger(phases, phaseNames, {
    ENTRY: 1,
    COMPLETED: 1,
    FAILED: 0,
  });
  if (verifierResult.status !== 'PASS' && result.status === 'PASS') result = verifierResult;
  addCheck(
    checks,
    'REC-04',
    result.status,
    'independent WRITE_ENTRY/WRITE_RETURN ledger and verifier ledger',
    result.details,
  );

  result = checkTargetFactsStable(phases, phaseNames, 'CR_A');
  if (result.status === 'PASS') {
    for (const phaseName of phaseNames) {
      const phase = phases.get(phaseName);
      const s05 = namedStep(phase.data, 'S05');
      if (s05?.state !== 'COMPLETED') {
        result = { status: 'FAIL', details: phaseName + ': S05 is not COMPLETED.' };
        break;
      }
      const ops = operationRowsForSteps(phase.tables, new Set([s05.id]));
      if (ops.length !== 1 || ops[0].state !== 'VERIFIED') {
        result = {
          status: 'FAIL',
          details: phaseName + ': S05 Operation is not uniquely VERIFIED.',
        };
        break;
      }
    }
  }
  addCheck(
    checks,
    'REC-05',
    result.status,
    'automatic recovery has no new Operation/Journal or mutation attempt',
    result.details,
  );

  result = byPhase(crACompletionEvidence);
  addCheck(
    checks,
    'REC-06',
    result.status,
    'production completion facts and workspace hash agreement',
    result.details,
  );

  result = byPhase((phase) => {
    const s05 = namedStep(phase.data, 'S05');
    if (!s05) return { status: 'BLOCKED', details: 'S05 Step fact is unavailable.' };
    const journals = journalRowsForSteps(phase.tables, new Set([s05.id]));
    if (journals.length !== 3)
      return { status: 'BLOCKED', details: 'S05 mutation evidence is incomplete.' };
    for (const journal of journals) {
      if (
        journal.tool_id !== 'file.writeText' ||
        journal.permission_resource !==
          'file:' + journal.workspace_tag + ':' + String(journal.relative_path).toLowerCase()
      )
        return {
          status: 'FAIL',
          details:
            'Mutation Journal lacks a valid file.writeText permission resource for ' +
            journal.relative_path,
        };
      const expectedTag = workspaceTag(phase.snapshot);
      if (!expectedTag)
        return { status: 'BLOCKED', details: 'Runtime workspace identity is unavailable.' };
      if (journal.workspace_tag !== expectedTag)
        return {
          status: 'FAIL',
          details: 'Journal workspace_tag does not match the runtime workspace.',
        };
      if (
        journal.state !== 'APPLIED' ||
        journal.observed_after_hash !== journal.expected_after_hash
      )
        return {
          status: 'FAIL',
          details:
            'Completed S05 is missing its APPLIED hash evidence for ' + journal.relative_path,
        };
    }
    const ops = operationRowsForSteps(phase.tables, new Set([s05.id]));
    if (
      ops.length !== 1 ||
      ops[0].state !== 'VERIFIED' ||
      !Array.isArray(parseJson(ops[0].manifest_json))
    )
      return {
        status: 'FAIL',
        details: 'Completed S05 is missing its verified Operation manifest.',
      };
    if (!manifestMatchesJournals(ops[0], journals))
      return {
        status: 'FAIL',
        details:
          'Verified Operation manifest does not agree with the three Journal paths and hashes.',
      };
    return {
      status: 'PASS',
      details:
        'Permission resource, file.writeText identity, manifest, Operation, Journal, Tool fact and file hash are fail-closed and mutually consistent.',
    };
  });
  addCheck(
    checks,
    'REC-07',
    result.status,
    'permission/receipt/contract and evidence consistency',
    result.details,
  );

  const offlineStatus =
    input.offlineRetryTestPassed === true
      ? 'PASS'
      : input.offlineRetryTestPassed === false
        ? 'FAIL'
        : 'BLOCKED';
  const offlineDetails =
    input.offlineRetryTestPassed === true
      ? 'Independent offline retry test passed: creates a new Step attempt and preserves prior attempt artifacts on explicit retry.'
      : input.offlineRetryTestPassed === false
        ? 'Independent offline retry test failed.'
        : 'Independent offline retry test result is missing; CR-A recovery evidence cannot substitute for REC-08.';
  addCheck(checks, 'REC-08', offlineStatus, 'offlineRetryTestPassed', offlineDetails);

  result = rawRowSetsStable(phases.get('explicitContinue'), phases.get('secondRestart'));
  if (result.status === 'PASS') {
    const beforeLedgers = verifierLedger(phases.get('explicitContinue').snapshot);
    const afterLedgers = verifierLedger(phases.get('secondRestart').snapshot);
    if (!beforeLedgers || !afterLedgers)
      result = { status: 'BLOCKED', details: 'Verifier ledger is unavailable.' };
    else if (canonicalJson(beforeLedgers) !== canonicalJson(afterLedgers))
      result = { status: 'FAIL', details: 'Verifier ledger changed on second restart.' };
    else {
      const pathsForFinal = mutationPaths(
        targetJournalRows(
          phases.get('secondRestart').tables,
          phases.get('secondRestart').data,
          'CR_A',
        ),
      );
      if (!pathsForFinal)
        result = { status: 'BLOCKED', details: 'Final mutation paths are unavailable.' };
      else {
        const counts = checkControllerNoReplay(
          phases,
          ['explicitContinue', 'secondRestart'],
          pathsForFinal,
        );
        if (counts.status !== 'PASS') result = counts;
      }
    }
  }
  addCheck(
    checks,
    'REC-09',
    result.status,
    'explicitContinue versus secondRestart IDs/hashes/counts',
    result.details,
  );

  result = snapshotAndProcessCheck(input, names);
  addCheck(
    checks,
    'REC-10',
    result.status,
    'SQLite integrity/FK and isolated process/profile evidence',
    result.details,
  );
}

function evaluateCRBChecks(input, checks, snapshotState) {
  const { names, missing } = snapshotState;
  const all = factsForSnapshots(input, names);
  const phaseNames = names;
  if (missing.length || all.missing.length) {
    const missingFacts = missing.length
      ? 'missing snapshots: ' + missing.join(', ')
      : 'missing facts: ' + all.missing.join(', ');
    for (const id of CHECK_IDS) {
      if (id === 'REC-08') continue;
      addCheck(checks, id, 'BLOCKED', missingFacts, 'Required CR-B phases are incomplete.');
    }
    const offlineStatus =
      input.offlineRetryTestPassed === true
        ? 'PASS'
        : input.offlineRetryTestPassed === false
          ? 'FAIL'
          : 'BLOCKED';
    addCheck(
      checks,
      'REC-08',
      offlineStatus,
      'offlineRetryTestPassed',
      input.offlineRetryTestPassed === true
        ? 'Independent offline retry test passed; no retry is issued in CR-B.'
        : input.offlineRetryTestPassed === false
          ? 'Independent offline retry test failed.'
          : 'Independent offline retry test result is missing.',
    );
    return;
  }
  const phases = all.result;
  const identityResult = definitionsAndRunIdentities(phases);
  let result = identityResult;
  if (result.status === 'PASS') {
    for (const [beforeName, afterName] of [
      ['beforeCrash', 'afterKill'],
      ['afterKill', 'firstRestart'],
      ['firstRestart', 'secondRestart'],
    ]) {
      result = stepIdentityComparison(
        phases.get(beforeName).data,
        phases.get(afterName).data,
        false,
      );
      if (result.status !== 'PASS') {
        result = { ...result, details: beforeName + ' -> ' + afterName + ': ' + result.details };
        break;
      }
    }
  }
  addCheck(
    checks,
    'REC-01',
    result.status,
    'official definition, Run and Step attempt identities',
    result.details,
  );

  const completedIds = completedStepIdsFrom(phases);
  result = checkCompletedStepExecutions(phases, phaseNames, completedIds);
  if (result.status === 'PASS') {
    const targetStep = targetStepFor(phases.get('beforeCrash'), 'CR_B');
    if (targetStep)
      result = checkNoUnexpectedExecutionEvents(
        phases,
        phaseNames,
        phases.get('beforeCrash').data,
        targetStep.step_id,
      );
    else
      result = {
        status: 'BLOCKED',
        details: 'Pre-crash target mutation Step facts are unavailable.',
      };
  }
  addCheck(
    checks,
    'REC-02',
    result.status,
    'completed Step event chains and interrupted target MissionRun execution count',
    result.details,
  );

  result = {
    status: 'PASS',
    details:
      'Prior durable rows are preserved; unattended restart phases add no artifact/receipt/checkpoint rows.',
  };
  for (const [beforeName, afterName] of [
    ['beforeCrash', 'afterKill'],
    ['afterKill', 'firstRestart'],
    ['firstRestart', 'secondRestart'],
  ]) {
    result = appendOnlyComparison(phases.get(beforeName), phases.get(afterName), false);
    if (result.status !== 'PASS') {
      result = { ...result, details: beforeName + ' -> ' + afterName + ': ' + result.details };
      break;
    }
  }
  addCheck(
    checks,
    'REC-03',
    result.status,
    'artifact/receipt/checkpoint/binding/decision/traversal IDs and hashes',
    result.details,
  );

  const baseline = phases.get('beforeCrash');
  const targetJournals = targetJournalRows(baseline.tables, baseline.data, 'CR_B');
  const paths = mutationPaths(targetJournals);
  if (!paths || paths.length !== 1 || !/(?:^|\/)renderer\.ts$/i.test(paths[0])) {
    result = {
      status: 'BLOCKED',
      details: 'CR-B must expose exactly one renderer.ts mutation path.',
    };
  } else {
    result = checkControllerNoReplay(phases, phaseNames, paths);
    if (result.status === 'PASS') result = checkTargetFactsStable(phases, phaseNames, 'CR_B');
  }
  addCheck(
    checks,
    'REC-04',
    result.status,
    'independent controller WRITE_ENTRY/WRITE_RETURN ledger and journal reconciliation',
    result.details,
  );

  result = checkTargetFactsStable(phases, phaseNames, 'CR_B');
  const targetStep = targetStepFor(baseline, 'CR_B');
  if (result.status === 'PASS' && targetStep)
    result = checkNoUnexpectedExecutionEvents(
      phases,
      ['afterKill', 'firstRestart', 'secondRestart'],
      baseline.data,
      targetStep.step_id,
    );
  else if (result.status === 'PASS')
    result = { status: 'BLOCKED', details: 'Target mutation Step facts are unavailable.' };
  if (result.status === 'PASS') result = checkCRBNoManualAdvance(input, phases);
  addCheck(
    checks,
    'REC-05',
    result.status,
    'no startup retry, new POST/Tool execution, or target Operation/Journal',
    result.details,
  );

  result = byCRB(phases);
  addCheck(
    checks,
    'REC-06',
    result.status,
    'interrupted Mission/Operation/Journal remains unverified and waiting',
    result.details,
  );

  result = checkCRBFailClosed(phases, phaseNames);
  addCheck(
    checks,
    'REC-07',
    result.status,
    'uncertain file state cannot be treated as verified completion',
    result.details,
  );

  const offlineStatus =
    input.offlineRetryTestPassed === true
      ? 'PASS'
      : input.offlineRetryTestPassed === false
        ? 'FAIL'
        : 'BLOCKED';
  const offlineDetails =
    input.offlineRetryTestPassed === true
      ? 'Independent offline retry test passed; CR-B itself contains no retry or new Step attempt.'
      : input.offlineRetryTestPassed === false
        ? 'Independent offline retry test failed.'
        : 'Independent offline retry test result is missing; CR-B must not be retried to satisfy REC-08.';
  addCheck(checks, 'REC-08', offlineStatus, 'offlineRetryTestPassed', offlineDetails);

  result = rawRowSetsStable(phases.get('firstRestart'), phases.get('secondRestart'));
  if (result.status === 'PASS') {
    const counts = checkControllerNoReplay(phases, ['firstRestart', 'secondRestart'], paths);
    if (counts.status !== 'PASS') result = counts;
  }
  addCheck(
    checks,
    'REC-09',
    result.status,
    'firstRestart versus secondRestart IDs/hashes/counts',
    result.details,
  );

  result = snapshotAndProcessCheck(input, names);
  addCheck(
    checks,
    'REC-10',
    result.status,
    'SQLite integrity/FK and isolated process/profile evidence',
    result.details,
  );
}

function byCRB(phases) {
  for (const phaseName of ['firstRestart', 'secondRestart']) {
    const result = crBInterruptedEvidence(phases.get(phaseName), 'CR_B');
    if (result.status !== 'PASS') return { ...result, details: phaseName + ': ' + result.details };
  }
  return {
    status: 'PASS',
    details: 'Each restart preserves the exact interrupted UNKNOWN/PREPARED waiting contract.',
  };
}

function checkCRBFailClosed(phases, phaseNames) {
  for (const phaseName of phaseNames) {
    const phase = phases.get(phaseName);
    if (!phase) return { status: 'BLOCKED', details: 'Snapshot is unavailable: ' + phaseName };
    const journals = targetJournalRows(phase.tables, phase.data, 'CR_B');
    if (!journals || journals.length !== 1)
      return { status: 'BLOCKED', details: phaseName + ': target Journal is unavailable.' };
    const targetStep = stepById(phase.data, journals[0].step_run_id);
    if (!targetStep)
      return { status: 'BLOCKED', details: phaseName + ': target mutation Step is unavailable.' };
    const operations = targetOperationRows(phase.tables, phase.data, journals);
    if (!operations)
      return { status: 'BLOCKED', details: phaseName + ': target Operation rows are unavailable.' };
    if (operations.length !== 1)
      return {
        status: 'BLOCKED',
        details: phaseName + ': operation or journal evidence is missing.',
      };
    const beforeRecovery = phaseName === 'beforeCrash' || phaseName === 'afterKill';
    if (targetStep.step_id !== 'S05')
      return {
        status: 'FAIL',
        details: phaseName + ': CR-B target renderer.ts mutation is not on S05.',
      };
    if (
      operations[0].effect_type !== 'WORKSPACE_MUTATION' ||
      journals[0].tool_id !== 'file.writeText'
    )
      return {
        status: 'FAIL',
        details:
          phaseName + ': target operation/journal is not a file.writeText Workspace mutation.',
      };
    const tag = workspaceTag(phase.snapshot);
    if (!tag)
      return {
        status: 'BLOCKED',
        details: phaseName + ': runtime workspace identity is unavailable.',
      };
    if (
      journals[0].workspace_tag !== tag ||
      journals[0].permission_resource !==
        'file:' + tag + ':' + String(journals[0].relative_path).toLowerCase()
    )
      return {
        status: 'FAIL',
        details:
          phaseName + ': target Journal permission resource does not match the isolated workspace.',
      };
    if (!/^[0-9a-f]{64}$/i.test(String(journals[0].expected_after_hash ?? '')))
      return {
        status: 'FAIL',
        details: phaseName + ': target Journal expected_after_hash is invalid.',
      };
    if (journals[0].observed_after_hash !== null || journals[0].result_code !== null)
      return {
        status: 'FAIL',
        details: phaseName + ': PREPARED Journal unexpectedly contains an observed result.',
      };
    if (matchingToolResult(phase.snapshot, targetStep.mission_run_id, journals[0].tool_call_id))
      return {
        status: 'FAIL',
        details: phaseName + ': interrupted file.writeText has a tool.result fact.',
      };
    const verifier = verifierLedger(phase.snapshot);
    if (!verifier)
      return { status: 'BLOCKED', details: phaseName + ': verifier ledger is unavailable.' };
    if (verifier.length > 0)
      return {
        status: 'FAIL',
        details: phaseName + ': verifier ran before the mutation was verified.',
      };
    const s06 = namedStep(phase.data, 'S06');
    if (s06?.state === 'COMPLETED')
      return {
        status: 'FAIL',
        details: phaseName + ': S06 completed while the target mutation remained uncertain.',
      };
    if (
      operations[0].state === 'VERIFIED' ||
      operations[0].state === 'APPLIED' ||
      journals[0].state === 'APPLIED'
    )
      return {
        status: 'FAIL',
        details: phaseName + ': uncertain mutation was promoted to completed/applied.',
      };
    if (operations[0].state !== (beforeRecovery ? 'PREPARED' : 'UNKNOWN'))
      return {
        status: 'FAIL',
        details: phaseName + ': Operation state contradicts the interrupted evidence contract.',
      };
    if (journals[0].state !== 'PREPARED')
      return { status: 'FAIL', details: phaseName + ': Journal state is not PREPARED.' };
    if (beforeRecovery) {
      const missions = matchingMissions(phase.tables, targetStep);
      const missionRuns = matchingMissionRuns(phase.tables, targetStep);
      if (missions.length !== 1 || missionRuns.length !== 1)
        return {
          status: 'BLOCKED',
          details: phaseName + ': running Mission/MissionRun evidence is missing.',
        };
      if (missions[0].state !== 'RUNNING' || missionRuns[0].status !== 'RUNNING')
        return {
          status: 'FAIL',
          details:
            phaseName +
            ': target Mission and MissionRun must still be RUNNING before automatic recovery.',
        };
      const activeState = (row) =>
        (row.state === 'RUNNING' && (row.wait_reason === null || row.wait_reason === undefined)) ||
        (row.state === 'WAITING' && row.wait_reason === 'APPROVAL');
      if (!activeState(targetStep) || !activeState(phase.data.workflow))
        return {
          status: 'FAIL',
          details:
            phaseName +
            ': pre-recovery Workflow/Step must be RUNNING or WAITING/APPROVAL while Mission is running.',
        };
    } else {
      if (
        targetStep.state !== 'WAITING' ||
        targetStep.wait_reason !== 'USER_CONFIRMATION' ||
        targetStep.error_code !== 'EXECUTION_INTERRUPTED_RETRY_REQUIRED'
      )
        return {
          status: 'FAIL',
          details:
            phaseName +
            ': target mutation Step does not preserve the interrupted confirmation wait.',
        };
      if (
        phase.data.workflow.state !== 'WAITING' ||
        phase.data.workflow.wait_reason !== 'USER_CONFIRMATION'
      )
        return {
          status: 'FAIL',
          details:
            phaseName + ': Workflow Run does not preserve the interrupted confirmation wait.',
        };
    }
  }
  return {
    status: 'PASS',
    details:
      'Before recovery Mission/MissionRun remain RUNNING with PREPARED evidence; after recovery the uncertain mutation stays UNKNOWN/PREPARED and waits for confirmation.',
  };
}

export function evaluateCase(input) {
  const scenario = input?.scenario;
  const checks = [];
  if (scenario !== 'CR_A' && scenario !== 'CR_B') {
    for (const id of CHECK_IDS)
      addCheck(checks, id, 'BLOCKED', 'scenario', 'scenario must be CR_A or CR_B.');
    return { scenario, status: aggregateStatus(checks), checks };
  }
  const snapshotState = requiredSnapshotState(input, scenario);
  if (scenario === 'CR_A') evaluateCRAChecks(input, checks, snapshotState);
  else evaluateCRBChecks(input, checks, snapshotState);
  return { scenario, status: aggregateStatus(checks), checks };
}

export default evaluateCase;
