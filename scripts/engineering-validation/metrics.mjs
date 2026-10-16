import { createHash } from 'node:crypto';

export const PRODUCTION_K = Object.freeze({ SKILL: 3, MEMORY: 6, TOOL: 8 });
export const FIXED_LIVE_CASE_COUNT = 5;
export const LIVE_STATUSES = Object.freeze(['LIVE_SUCCESS', 'FALLBACK', 'NOT_RUN']);

const FAMILIES = new Set(Object.keys(PRODUCTION_K));
const BASE_METRICS = ['precisionAtK', 'recallAtK', 'ndcgAtK', 'top1Grade'];

export class MetricsContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MetricsContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MetricsContractError(code, message);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail('INVALID_STRING', field + ' must be a non-empty string');
  return value;
}

function requireFamily(value) {
  if (typeof value !== 'string' || !FAMILIES.has(value))
    fail('INVALID_FAMILY', 'family must be SKILL, MEMORY, or TOOL');
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1)
    fail('INVALID_K', field + ' must be a positive integer');
  return value;
}

function requireIds(values, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(values)) fail('INVALID_CANDIDATE_LIST', field + ' must be an array');
  if (!allowEmpty && values.length === 0)
    fail('EMPTY_CANDIDATE_POOL', field + ' must contain at least one candidate');
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || value.trim().length === 0)
      fail('INVALID_CANDIDATE_ID', field + '[' + index + '] must be a non-empty string');
    if (seen.has(value)) fail('DUPLICATE_CANDIDATE_ID', field + ' contains duplicate ID ' + value);
    seen.add(value);
  }
  return [...values];
}

function validatePool(candidateIds, candidateGrades) {
  const ids = requireIds(candidateIds, 'candidateIds', { allowEmpty: false });
  if (!Array.isArray(candidateGrades))
    fail('INVALID_GRADES', 'candidateGrades must be an array of { candidateId, grade }');
  const pool = new Set(ids);
  const grades = new Map();
  for (const row of candidateGrades) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      fail('INVALID_GRADE_ROW', 'each candidate grade must be an object');
    if (Object.keys(row).some((key) => !['candidateId', 'grade'].includes(key)))
      fail(
        'INVALID_GRADE_ROW_FIELDS',
        'candidate grade rows may contain only candidateId and grade',
      );
    const { candidateId, grade } = row;
    if (typeof candidateId !== 'string' || !pool.has(candidateId))
      fail(
        'GRADE_FOR_UNKNOWN_CANDIDATE',
        'grade row references a candidate outside the legal pool',
      );
    if (grades.has(candidateId))
      fail('DUPLICATE_GRADE', 'candidateGrades contains duplicate ID ' + candidateId);
    if (!Number.isInteger(grade) || grade < 0 || grade > 3)
      fail('INVALID_GRADE', 'grade must be an integer from 0 through 3');
    grades.set(candidateId, grade);
  }
  if (grades.size !== pool.size)
    fail('MISSING_GRADE', 'candidateGrades must grade every legal candidate exactly once');
  return { candidateIds: ids, gradeById: grades };
}

function candidatePoolFingerprint(candidateIds, gradeById) {
  const canonicalPool = candidateIds
    .map((candidateId) => [candidateId, gradeById.get(candidateId)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonicalPool), 'utf8').digest('hex');
}

function scoreAtK(outputIds, gradeById, positiveCount, k) {
  const prefix = outputIds.slice(0, k);
  const relevantFound = prefix.reduce((count, id) => count + (gradeById.get(id) >= 2 ? 1 : 0), 0);
  const precisionDenominator = Math.min(k, outputIds.length);
  const precisionAtK = precisionDenominator === 0 ? 0 : relevantFound / precisionDenominator;
  const recallAtK = positiveCount === 0 ? null : relevantFound / positiveCount;
  const dcgAtK = prefix.reduce((sum, id, index) => {
    const rank = index + 1;
    return sum + (2 ** gradeById.get(id) - 1) / Math.log2(rank + 1);
  }, 0);
  const idealGrades = [...gradeById.values()].sort((left, right) => right - left).slice(0, k);
  const idcgAtK = idealGrades.reduce((sum, grade, index) => {
    const rank = index + 1;
    return sum + (2 ** grade - 1) / Math.log2(rank + 1);
  }, 0);
  return {
    precisionAtK,
    precisionNumerator: relevantFound,
    precisionDenominator: precisionDenominator,
    recallAtK,
    recallNumerator: relevantFound,
    recallDenominator: positiveCount,
    recallNAReason: positiveCount === 0 ? 'NO_RELEVANT_CANDIDATES' : null,
    ndcgAtK: idcgAtK === 0 ? null : dcgAtK / idcgAtK,
    dcgAtK,
    idcgAtK,
    ndcgNAReason: idcgAtK === 0 ? 'NO_IDCG' : null,
  };
}

export function scoreRanking({
  caseId,
  family,
  candidateIds,
  candidateGrades,
  outputIds,
  k,
  source,
}) {
  const validatedCaseId = requireNonEmptyString(caseId, 'caseId');
  const validatedFamily = requireFamily(family);
  const validatedK = requirePositiveInteger(k, 'k');
  if (validatedK !== PRODUCTION_K[validatedFamily])
    fail('NON_PRODUCTION_K', 'k must match the family production K');
  if (!['NATIVE', 'DERIVED'].includes(source))
    fail('INVALID_OUTPUT_SOURCE', 'source must be NATIVE or DERIVED');
  const { candidateIds: poolIds, gradeById } = validatePool(candidateIds, candidateGrades);
  const rankedIds = requireIds(outputIds, 'outputIds');
  const pool = new Set(poolIds);
  for (const id of rankedIds) {
    if (!pool.has(id))
      fail('ILLEGAL_OUTPUT_CANDIDATE', 'output ID is outside the legal candidate pool: ' + id);
  }

  const positiveCount = [...gradeById.values()].filter((grade) => grade >= 2).length;
  const metrics = scoreAtK(rankedIds, gradeById, positiveCount, validatedK);
  const top1Grade = rankedIds.length === 0 ? null : gradeById.get(rankedIds[0]);
  const diagnosticTop3 = ['MEMORY', 'TOOL'].includes(validatedFamily)
    ? scoreAtK(rankedIds, gradeById, positiveCount, 3)
    : null;

  return {
    caseId: validatedCaseId,
    family: validatedFamily,
    source,
    k: validatedK,
    candidateCount: poolIds.length,
    candidatePoolFingerprint: candidatePoolFingerprint(poolIds, gradeById),
    outputCount: rankedIds.length,
    nativeOutputCount: source === 'NATIVE' ? rankedIds.length : null,
    derivedOutputCount: source === 'DERIVED' ? rankedIds.length : null,
    outputIds: rankedIds,
    emptyOutputReason: rankedIds.length === 0 ? 'EMPTY_OUTPUT' : null,
    metrics: {
      ...metrics,
      top1Grade,
      ...(diagnosticTop3
        ? {
            top3: {
              precisionAt3: diagnosticTop3.precisionAtK,
              precisionNumerator: diagnosticTop3.precisionNumerator,
              precisionDenominator: diagnosticTop3.precisionDenominator,
              recallAt3: diagnosticTop3.recallAtK,
              recallNumerator: diagnosticTop3.recallNumerator,
              recallDenominator: diagnosticTop3.recallDenominator,
              recallNAReason: diagnosticTop3.recallNAReason,
              ndcgAt3: diagnosticTop3.ndcgAtK,
              dcgAt3: diagnosticTop3.dcgAtK,
              idcgAt3: diagnosticTop3.idcgAtK,
              ndcgNAReason: diagnosticTop3.ndcgNAReason,
            },
          }
        : {}),
    },
  };
}

export function deriveTopK(outputIds, k) {
  const rankedIds = requireIds(outputIds, 'outputIds');
  return rankedIds.slice(0, requirePositiveInteger(k, 'k'));
}

export function scoreNativeAndDerived(input) {
  const { nativeOutputIds, derivedOutputIds, ...shared } = input;
  const native = scoreRanking({ ...shared, outputIds: nativeOutputIds, source: 'NATIVE' });
  if (derivedOutputIds === undefined || derivedOutputIds === null) return { native, derived: null };
  const expectedDerivedOutputIds = deriveTopK(native.outputIds, native.k);
  const suppliedDerivedOutputIds = requireIds(derivedOutputIds, 'derivedOutputIds');
  if (JSON.stringify(suppliedDerivedOutputIds) !== JSON.stringify(expectedDerivedOutputIds))
    fail(
      'DERIVED_OUTPUT_MISMATCH',
      'derived output must be the observed native order truncated to production K',
    );
  const derived = scoreRanking({
    ...shared,
    outputIds: suppliedDerivedOutputIds,
    source: 'DERIVED',
  });
  return { native, derived };
}

function flattenedMetrics(score) {
  const values = { ...score.metrics };
  delete values.top3;
  if (score.metrics.top3) {
    values.precisionAt3 = score.metrics.top3.precisionAt3;
    values.recallAt3 = score.metrics.top3.recallAt3;
    values.ndcgAt3 = score.metrics.top3.ndcgAt3;
  }
  return values;
}

function familyMetricNames(family) {
  return [
    ...BASE_METRICS,
    ...(family === 'MEMORY' || family === 'TOOL' ? ['precisionAt3', 'recallAt3', 'ndcgAt3'] : []),
  ];
}

function validateLiveScore(score, caseId, family, source, field) {
  if (!score || typeof score !== 'object' || Array.isArray(score))
    fail('MISSING_LIVE_SCORE', field + ' must be a scored native or derived output');
  if (score.caseId !== caseId || score.family !== family)
    fail('LIVE_SCORE_CASE_MISMATCH', field + ' must match its registered case and family');
  if (score.k !== PRODUCTION_K[family])
    fail('LIVE_SCORE_K_MISMATCH', field + ' must use the family production K');
  if (!['NATIVE', 'DERIVED'].includes(score.source))
    fail('INVALID_LIVE_SCORE_SOURCE', field + ' source must be NATIVE or DERIVED');
  if (source && score.source !== source)
    fail('INVALID_LIVE_SCORE_SOURCE', field + ' source must be ' + source);
  if (
    !Array.isArray(score.outputIds) ||
    !Number.isInteger(score.outputCount) ||
    score.outputCount !== score.outputIds.length
  )
    fail('INVALID_LIVE_SCORE_OUTPUT', field + ' must retain its actual output IDs and count');
  if (
    typeof score.candidatePoolFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(score.candidatePoolFingerprint)
  )
    fail('INVALID_LIVE_SCORE_POOL', field + ' must retain a candidate-pool fingerprint');
  if (!score.metrics || typeof score.metrics !== 'object' || Array.isArray(score.metrics))
    fail('INVALID_LIVE_SCORE_METRICS', field + ' must retain its computed quality metrics');
  const values = flattenedMetrics(score);
  for (const name of familyMetricNames(family)) {
    if (!Object.hasOwn(values, name))
      fail('MISSING_LIVE_SCORE_METRIC', field + ' is missing ' + name);
    const value = values[name];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
      fail('INVALID_LIVE_SCORE_METRIC', field + '.' + name + ' must be finite or null');
  }
  return score;
}

function macroQualityMetrics(scores, family) {
  const byScore = scores.map(flattenedMetrics);
  return Object.fromEntries(
    familyMetricNames(family).map((name) => {
      const values = byScore
        .map((score) => score[name])
        .filter((value) => typeof value === 'number');
      return [
        name,
        {
          mean:
            values.length === 0
              ? null
              : values.reduce((sum, value) => sum + value, 0) / values.length,
          sampleCount: values.length,
        },
      ];
    }),
  );
}

function observedQualitySums(scores, family) {
  const byScore = scores.map(flattenedMetrics);
  return Object.fromEntries(
    familyMetricNames(family).map((name) => {
      const values = byScore
        .map((score) => score[name])
        .filter((value) => typeof value === 'number');
      return [
        name,
        {
          observedSum: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0),
          scoredValueCount: values.length,
        },
      ];
    }),
  );
}

export function pairedMetricDifferences({ deterministic, jevNative }) {
  if (!deterministic || !jevNative)
    fail('MISSING_PAIRED_SCORE', 'both deterministic and native comparison scores are required');
  if (
    deterministic.caseId !== jevNative.caseId ||
    deterministic.family !== jevNative.family ||
    deterministic.k !== jevNative.k
  )
    fail('PAIR_MISMATCH', 'paired scores must share caseId, family, and production K');
  if (deterministic.candidatePoolFingerprint !== jevNative.candidatePoolFingerprint)
    fail(
      'CANDIDATE_POOL_MISMATCH',
      'paired scores must use the same legal candidate IDs and grades',
    );
  if (deterministic.source !== 'NATIVE' || jevNative.source !== 'NATIVE')
    fail('NON_NATIVE_PAIR', 'paired quality deltas require two native outputs');

  const deterministicValues = flattenedMetrics(deterministic);
  const jevValues = flattenedMetrics(jevNative);
  const metrics = {};
  for (const key of familyMetricNames(deterministic.family)) {
    const left = deterministicValues[key];
    const right = jevValues[key];
    const delta = typeof left === 'number' && typeof right === 'number' ? right - left : null;
    metrics[key] = {
      deterministic: left ?? null,
      jev: right ?? null,
      delta,
      comparison:
        delta === null
          ? 'NOT_APPLICABLE'
          : delta > 0
            ? 'IMPROVED'
            : delta < 0
              ? 'DECLINED'
              : 'FLAT',
    };
  }
  return {
    caseId: deterministic.caseId,
    family: deterministic.family,
    k: deterministic.k,
    metrics,
  };
}

export function macroAveragePairedDifferences(pairs, family) {
  if (!Array.isArray(pairs)) fail('INVALID_PAIRS', 'pairs must be an array');
  const validatedFamily = requireFamily(family);
  const seenCases = new Set();
  const differences = pairs.map((pair) => {
    const difference = pairedMetricDifferences(pair);
    if (difference.family !== validatedFamily)
      fail('FAMILY_MISMATCH', 'all paired samples must belong to the requested family');
    if (seenCases.has(difference.caseId))
      fail('DUPLICATE_CASE_ID', 'paired case IDs must be unique');
    seenCases.add(difference.caseId);
    return difference;
  });
  const metrics = {};
  for (const key of familyMetricNames(validatedFamily)) {
    const values = differences
      .map((item) => item.metrics[key].delta)
      .filter((value) => typeof value === 'number');
    metrics[key] = {
      meanDelta:
        values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
      sampleCount: values.length,
      improved: values.filter((value) => value > 0).length,
      flat: values.filter((value) => value === 0).length,
      declined: values.filter((value) => value < 0).length,
    };
  }
  return { family: validatedFamily, caseCount: differences.length, metrics };
}

export function summarizeCostEstimates(values) {
  if (!Array.isArray(values)) fail('INVALID_COSTS', 'cost estimates must be an array');
  const normalized = values.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      fail('INVALID_COST', 'known cost estimates must be finite non-negative numbers');
    return value;
  });
  const known = normalized.filter((value) => value !== null);
  const unknownCount = normalized.length - known.length;
  const knownSubtotalUsd = known.reduce((sum, value) => sum + value, 0);
  return {
    observedCount: normalized.length,
    knownCount: known.length,
    unknownCount,
    knownSubtotalUsd,
    totalCostUsd: normalized.length > 0 && unknownCount === 0 ? knownSubtotalUsd : null,
  };
}

function requireCount(value, field) {
  if (!Number.isInteger(value) || value < 0)
    fail('INVALID_OUTPUT_COUNT', field + ' must be a non-negative integer');
  return value;
}

export function summarizeFixedLiveCases(records, registeredCaseIds) {
  const registeredIds = requireIds(registeredCaseIds, 'registeredCaseIds', { allowEmpty: false });
  if (registeredIds.length !== FIXED_LIVE_CASE_COUNT)
    fail('FIXED_LIVE_DENOMINATOR_MISMATCH', 'exactly five registered Live case IDs are required');
  if (!Array.isArray(records) || records.length !== FIXED_LIVE_CASE_COUNT)
    fail(
      'FIXED_LIVE_DENOMINATOR_MISMATCH',
      'each family must retain exactly five registered Live cases',
    );
  const registeredSet = new Set(registeredIds);
  const seenCases = new Set();
  let family = null;
  const casesById = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record))
      fail('INVALID_LIVE_CASE', 'each Live case must be an object');
    const caseId = requireNonEmptyString(record.caseId, 'caseId');
    const currentFamily = requireFamily(record.family);
    if (family !== null && family !== currentFamily)
      fail('MIXED_FAMILIES', 'summarizeFixedLiveCases accepts one family at a time');
    family = currentFamily;
    if (!registeredSet.has(caseId))
      fail('UNREGISTERED_LIVE_CASE', 'Live case ID is not in the explicit registered case list');
    if (seenCases.has(caseId)) fail('DUPLICATE_CASE_ID', 'fixed Live case IDs must be unique');
    seenCases.add(caseId);
    if (!LIVE_STATUSES.includes(record.status))
      fail('INVALID_LIVE_STATUS', 'status must be LIVE_SUCCESS, FALLBACK, or NOT_RUN');
    const reason = record.reason ?? null;
    const errorCode = record.errorCode ?? null;
    let nativeOutputCount = null;
    let derivedOutputCount = null;
    let effectiveOutputCount = null;
    let nativeScore = null;
    let systemEffectiveScore = null;
    if (record.status === 'LIVE_SUCCESS') {
      nativeOutputCount = requireCount(record.nativeOutputCount, 'nativeOutputCount');
      nativeScore = validateLiveScore(
        record.nativeScore,
        caseId,
        currentFamily,
        'NATIVE',
        'nativeScore',
      );
      systemEffectiveScore = validateLiveScore(
        record.systemEffectiveScore,
        caseId,
        currentFamily,
        null,
        'systemEffectiveScore',
      );
      if (nativeOutputCount !== nativeScore.outputCount)
        fail(
          'NATIVE_OUTPUT_COUNT_MISMATCH',
          'nativeOutputCount must match nativeScore.outputCount',
        );
      if (record.effectiveOutputCount !== undefined && record.effectiveOutputCount !== null)
        fail('LIVE_SUCCESS_HAS_FALLBACK_COUNT', 'effectiveOutputCount is reserved for FALLBACK');
      if (nativeScore.candidatePoolFingerprint !== systemEffectiveScore.candidatePoolFingerprint)
        fail(
          'LIVE_SCORE_POOL_MISMATCH',
          'native and effective scores must use the same candidate snapshot',
        );
      if (systemEffectiveScore.source === 'NATIVE') {
        if (
          JSON.stringify(systemEffectiveScore.outputIds) !== JSON.stringify(nativeScore.outputIds)
        )
          fail(
            'LIVE_SUCCESS_OUTPUT_MISMATCH',
            'LIVE_SUCCESS effective output must match its native output',
          );
        if (record.derivedOutputCount !== undefined && record.derivedOutputCount !== null)
          fail('NATIVE_HAS_DERIVED_COUNT', 'derivedOutputCount requires a DERIVED effective score');
      } else {
        const expectedDerived = deriveTopK(nativeScore.outputIds, nativeScore.k);
        if (JSON.stringify(systemEffectiveScore.outputIds) !== JSON.stringify(expectedDerived))
          fail(
            'DERIVED_OUTPUT_MISMATCH',
            'derived effective output must be the native order truncated to K',
          );
        derivedOutputCount = requireCount(record.derivedOutputCount, 'derivedOutputCount');
        if (derivedOutputCount !== systemEffectiveScore.outputCount)
          fail(
            'DERIVED_OUTPUT_COUNT_MISMATCH',
            'derivedOutputCount must match systemEffectiveScore.outputCount',
          );
      }
    } else if (record.status === 'FALLBACK') {
      if (!(reason || errorCode))
        fail('MISSING_FALLBACK_REASON', 'FALLBACK must retain a reason or errorCode');
      if (record.nativeOutputCount !== undefined && record.nativeOutputCount !== null)
        fail(
          'FALLBACK_HAS_NATIVE_COUNT',
          'fallback output must not be reported as a native Jev output',
        );
      if (record.nativeScore !== undefined && record.nativeScore !== null)
        fail(
          'FALLBACK_HAS_NATIVE_SCORE',
          'fallback quality must not enter the native-success path',
        );
      if (record.derivedOutputCount !== undefined && record.derivedOutputCount !== null)
        fail(
          'FALLBACK_HAS_DERIVED_COUNT',
          'fallback output is a system-effective score, not a Jev-derived output',
        );
      systemEffectiveScore = validateLiveScore(
        record.systemEffectiveScore,
        caseId,
        currentFamily,
        'NATIVE',
        'systemEffectiveScore',
      );
      effectiveOutputCount = requireCount(record.effectiveOutputCount, 'effectiveOutputCount');
      if (effectiveOutputCount !== systemEffectiveScore.outputCount)
        fail(
          'EFFECTIVE_OUTPUT_COUNT_MISMATCH',
          'effectiveOutputCount must match systemEffectiveScore.outputCount',
        );
    } else {
      if (!(reason || errorCode))
        fail('MISSING_NOT_RUN_REASON', 'NOT_RUN must retain a reason or errorCode');
      if (
        (record.nativeOutputCount !== undefined && record.nativeOutputCount !== null) ||
        (record.derivedOutputCount !== undefined && record.derivedOutputCount !== null) ||
        (record.effectiveOutputCount !== undefined && record.effectiveOutputCount !== null) ||
        (record.nativeScore !== undefined && record.nativeScore !== null) ||
        (record.systemEffectiveScore !== undefined && record.systemEffectiveScore !== null)
      )
        fail(
          'NOT_RUN_HAS_OUTPUT',
          'NOT_RUN cannot claim an observed quality score or output count',
        );
    }
    const costEstimateUsd = record.costEstimateUsd ?? null;
    summarizeCostEstimates([costEstimateUsd]);
    casesById.set(caseId, {
      caseId,
      family: currentFamily,
      status: record.status,
      reason,
      errorCode,
      nativeOutputCount,
      derivedOutputCount,
      effectiveOutputCount,
      costEstimateUsd,
      nativeScore,
      systemEffectiveScore,
    });
  }
  if (seenCases.size !== registeredIds.length)
    fail('MISSING_REGISTERED_LIVE_CASE', 'every explicitly registered Live case must appear once');
  const cases = registeredIds.map((caseId) => casesById.get(caseId));

  const statusCounts = Object.fromEntries(
    LIVE_STATUSES.map((status) => [
      status,
      cases.filter((record) => record.status === status).length,
    ]),
  );
  const statusRates = Object.fromEntries(
    LIVE_STATUSES.map((status) => [status, statusCounts[status] / FIXED_LIVE_CASE_COUNT]),
  );
  const nativeSuccessCases = cases.filter((record) => record.status === 'LIVE_SUCCESS');
  const systemEffectiveCases = cases.filter((record) =>
    ['LIVE_SUCCESS', 'FALLBACK'].includes(record.status),
  );
  const nativeSuccessScores = nativeSuccessCases.map((record) => record.nativeScore);
  const systemEffectiveScores = systemEffectiveCases.map((record) => record.systemEffectiveScore);
  const notRunCaseIds = cases
    .filter((record) => record.status === 'NOT_RUN')
    .map((record) => record.caseId);
  return {
    family,
    denominator: FIXED_LIVE_CASE_COUNT,
    statusCounts,
    statusRates,
    cases,
    quality: {
      fixedCaseDenominator: FIXED_LIVE_CASE_COUNT,
      nativeSuccessConditional: {
        includedStatuses: ['LIVE_SUCCESS'],
        scoredCaseCount: nativeSuccessScores.length,
        scoredCoverage: nativeSuccessScores.length / FIXED_LIVE_CASE_COUNT,
        metrics: macroQualityMetrics(nativeSuccessScores, family),
      },
      systemEffective: {
        includedStatuses: ['LIVE_SUCCESS', 'FALLBACK'],
        scoredCaseCount: systemEffectiveScores.length,
        scoredCoverage: systemEffectiveScores.length / FIXED_LIVE_CASE_COUNT,
        metrics: macroQualityMetrics(systemEffectiveScores, family),
        fixedDenominatorObservedSums: {
          denominator: FIXED_LIVE_CASE_COUNT,
          scoredCaseCount: systemEffectiveScores.length,
          scoredCoverage: systemEffectiveScores.length / FIXED_LIVE_CASE_COUNT,
          notRunCaseCount: notRunCaseIds.length,
          notRunCaseIds,
          notRunScoreImputation: 'NONE',
          metrics: observedQualitySums(systemEffectiveScores, family),
        },
      },
    },
    cost: summarizeCostEstimates(cases.map((record) => record.costEstimateUsd)),
  };
}
