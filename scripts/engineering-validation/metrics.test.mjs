import assert from 'node:assert/strict';
import {
  MetricsContractError,
  deriveTopK,
  macroAveragePairedDifferences,
  pairedMetricDifferences,
  scoreNativeAndDerived,
  scoreRanking,
  summarizeCostEstimates,
  summarizeFixedLiveCases,
} from './metrics.mjs';

const testApi = process.env.VITEST ? await import('vitest') : await import('node:test');
const { describe, it } = testApi;

function matchesObject(actual, expected) {
  return Object.entries(expected).every(([key, value]) => {
    if (Array.isArray(value)) {
      try {
        assert.deepStrictEqual(actual?.[key], value);
        return true;
      } catch {
        return false;
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value))
      return actual?.[key] !== null && matchesObject(actual?.[key], value);
    return Object.is(actual?.[key], value);
  });
}

function expect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toBeNull() {
      assert.strictEqual(actual, null);
    },
    toBeCloseTo(expected, precision = 2) {
      assert.ok(
        Math.abs(actual - expected) < 0.5 * 10 ** -precision,
        `expected ${actual} to be close to ${expected} at precision ${precision}`,
      );
    },
    toBeLessThan(expected) {
      assert.ok(actual < expected, `expected ${actual} to be less than ${expected}`);
    },
    toBeGreaterThan(expected) {
      assert.ok(actual > expected, `expected ${actual} to be greater than ${expected}`);
    },
    toBeInstanceOf(expected) {
      assert.ok(actual instanceof expected, `expected value to be an instance of ${expected.name}`);
    },
    toEqual(expected) {
      assert.deepStrictEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.ok(matchesObject(actual, expected), 'expected object to contain the requested fields');
    },
    toHaveLength(expected) {
      assert.strictEqual(actual.length, expected);
    },
    not: {
      toContain(expected) {
        assert.ok(!actual.includes(expected), `expected ${actual} not to contain ${expected}`);
      },
    },
  };
}

function gradeRows(ids, grades) {
  return ids.map((candidateId, index) => ({ candidateId, grade: grades[index] }));
}

function score({
  caseId = 'SYNTHETIC',
  family = 'TOOL',
  ids,
  grades,
  output,
  k,
  source = 'NATIVE',
}) {
  return scoreRanking({
    caseId,
    family,
    candidateIds: ids,
    candidateGrades: gradeRows(ids, grades),
    outputIds: output,
    k,
    source,
  });
}

function expectMetricsError(callback, code) {
  let error;
  try {
    callback();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(MetricsContractError);
  expect(error.code).toBe(code);
}

describe('offline metric contract', () => {
  it('computes P@K, R@K, graded nDCG@K, Top1 Grade, and same-pool IDCG', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const result = score({
      ids,
      grades: [3, 2, 1, 0],
      output: ['b', 'a', 'd'],
      k: 8,
    });
    const expectedDcg = 3 + 7 / Math.log2(3);
    const expectedIdcg = 7 + 3 / Math.log2(3) + 1 / Math.log2(4);

    expect(result.metrics.precisionAtK).toBeCloseTo(2 / 3, 12);
    expect(result.metrics.precisionNumerator).toBe(2);
    expect(result.metrics.precisionDenominator).toBe(3);
    expect(result.metrics.recallAtK).toBe(1);
    expect(result.metrics.recallDenominator).toBe(2);
    expect(result.metrics.dcgAtK).toBeCloseTo(expectedDcg, 12);
    expect(result.metrics.idcgAtK).toBeCloseTo(expectedIdcg, 12);
    expect(result.metrics.ndcgAtK).toBeCloseTo(expectedDcg / expectedIdcg, 12);
    expect(result.metrics.top1Grade).toBe(2);
    expect(result.metrics.top3.ndcgAt3).toBe(result.metrics.ndcgAtK);
    expect(JSON.stringify(result)).not.toContain('referenceReason');
  });

  it('records empty output as P=0 and marks empty Recall and no-IDCG as N/A', () => {
    const emptyWithPositive = score({
      caseId: 'EMPTY-POSITIVE',
      family: 'MEMORY',
      ids: ['a', 'b'],
      grades: [3, 0],
      output: [],
      k: 6,
    });
    expect(emptyWithPositive.metrics.precisionAtK).toBe(0);
    expect(emptyWithPositive.metrics.precisionDenominator).toBe(0);
    expect(emptyWithPositive.metrics.recallAtK).toBe(0);
    expect(emptyWithPositive.metrics.ndcgAtK).toBe(0);
    expect(emptyWithPositive.metrics.top1Grade).toBeNull();
    expect(emptyWithPositive.emptyOutputReason).toBe('EMPTY_OUTPUT');

    const noPositive = score({
      caseId: 'NO-POSITIVE',
      family: 'SKILL',
      ids: ['x', 'y'],
      grades: [0, 0],
      output: ['x'],
      k: 3,
    });
    expect(noPositive.metrics.recallAtK).toBeNull();
    expect(noPositive.metrics.recallNAReason).toBe('NO_RELEVANT_CANDIDATES');
    expect(noPositive.metrics.ndcgAtK).toBeNull();
    expect(noPositive.metrics.ndcgNAReason).toBe('NO_IDCG');
  });

  it('preserves the Memory N=6, K=6 P/R degeneracy while exposing Top3 ranking diagnostics', () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const grades = [3, 2, 2, 1, 0, 0];
    const weakerTop3 = score({
      caseId: 'ME6K6',
      family: 'MEMORY',
      ids,
      grades,
      output: ['m6', 'm4', 'm1', 'm5', 'm2', 'm3'],
      k: 6,
    });
    const strongerTop3 = score({
      caseId: 'ME6K6',
      family: 'MEMORY',
      ids,
      grades,
      output: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
      k: 6,
    });

    expect(weakerTop3.metrics.precisionAtK).toBe(0.5);
    expect(strongerTop3.metrics.precisionAtK).toBe(0.5);
    expect(weakerTop3.metrics.recallAtK).toBe(1);
    expect(strongerTop3.metrics.recallAtK).toBe(1);
    expect(weakerTop3.metrics.top3.precisionAt3).toBeCloseTo(1 / 3, 12);
    expect(strongerTop3.metrics.top3.precisionAt3).toBe(1);
    expect(weakerTop3.metrics.top3.recallAt3).toBeCloseTo(1 / 3, 12);
    expect(strongerTop3.metrics.top3.recallAt3).toBe(1);
    expect(weakerTop3.metrics.top3.ndcgAt3).toBeLessThan(strongerTop3.metrics.top3.ndcgAt3);
  });

  it('shows Tool Live N<=8 can reorder all eligible candidates without proving filtering gain', () => {
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const grades = [3, 2, 2, 1, 1, 0, 0, 0];
    const ordered = score({
      caseId: 'TO-LIVE-SYN',
      family: 'TOOL',
      ids,
      grades,
      output: ids,
      k: 8,
    });
    const reversed = score({
      caseId: 'TO-LIVE-SYN',
      family: 'TOOL',
      ids,
      grades,
      output: [...ids].reverse(),
      k: 8,
    });

    expect(ordered.candidateCount).toBe(8);
    expect(ordered.outputCount).toBe(8);
    expect(ordered.metrics.precisionDenominator).toBe(8);
    expect(ordered.metrics.precisionAtK).toBe(3 / 8);
    expect(reversed.metrics.precisionAtK).toBe(3 / 8);
    expect(ordered.metrics.recallAtK).toBe(1);
    expect(reversed.metrics.recallAtK).toBe(1);
    expect(ordered.metrics.ndcgAtK).toBeGreaterThan(reversed.metrics.ndcgAtK);
  });

  it('keeps TO-09 native 12-offer and derived K=8 records separate', () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => 'to09-' + String(index + 1).padStart(2, '0'),
    );
    const grades = [3, 3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0];
    const nativeOutputIds = [...ids];
    const derivedOutputIds = deriveTopK(nativeOutputIds, 8);
    const result = scoreNativeAndDerived({
      caseId: 'TO-09-SYNTHETIC',
      family: 'TOOL',
      candidateIds: ids,
      candidateGrades: gradeRows(ids, grades),
      nativeOutputIds,
      derivedOutputIds,
      k: 8,
    });

    expect(result.native.source).toBe('NATIVE');
    expect(result.native.outputCount).toBe(12);
    expect(result.native.nativeOutputCount).toBe(12);
    expect(result.native.derivedOutputCount).toBeNull();
    expect(result.native.metrics.precisionDenominator).toBe(8);
    expect(result.native.metrics.precisionAtK).toBe(0.5);
    expect(result.native.metrics.recallAtK).toBe(1);
    expect(result.derived.source).toBe('DERIVED');
    expect(result.derived.outputCount).toBe(8);
    expect(result.derived.nativeOutputCount).toBeNull();
    expect(result.derived.derivedOutputCount).toBe(8);
    expect(result.derived.metrics.precisionDenominator).toBe(8);
    expect(result.derived.metrics.idcgAtK).toBe(result.native.metrics.idcgAtK);
    expect(result.derived.metrics.ndcgAtK).toBe(result.native.metrics.ndcgAtK);
  });

  it('computes paired differences as comparison minus baseline and family macro averages', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const grades = [3, 2, 1, 0];
    const makePair = (caseId, alternativeOutput) => ({
      deterministic: score({ caseId, family: 'TOOL', ids, grades, output: ids, k: 8 }),
      jevNative: score({ caseId, family: 'TOOL', ids, grades, output: alternativeOutput, k: 8 }),
    });
    const declined = pairedMetricDifferences(makePair('SYN-PAIR-1', ['b', 'a', 'c', 'd']));
    const flat = pairedMetricDifferences(makePair('SYN-PAIR-2', ids));
    const macro = macroAveragePairedDifferences(
      [makePair('SYN-PAIR-1', ['b', 'a', 'c', 'd']), makePair('SYN-PAIR-2', ids)],
      'TOOL',
    );

    expect(declined.metrics.ndcgAtK.delta).toBeLessThan(0);
    expect(declined.metrics.ndcgAtK.comparison).toBe('DECLINED');
    expect(flat.metrics.ndcgAtK.delta).toBe(0);
    expect(flat.metrics.ndcgAtK.comparison).toBe('FLAT');
    expect(macro.caseCount).toBe(2);
    expect(macro.metrics.ndcgAtK.sampleCount).toBe(2);
    expect(macro.metrics.ndcgAtK.improved).toBe(0);
    expect(macro.metrics.ndcgAtK.flat).toBe(1);
    expect(macro.metrics.ndcgAtK.declined).toBe(1);
    expect(macro.metrics.ndcgAtK.meanDelta).toBeLessThan(0);
  });

  it('keeps fallback out of native-success quality but includes it in system-effective quality', () => {
    const ids = ['tool-syn-good', 'tool-syn-bad'];
    const grades = [3, 0];
    const nativeSuccessHigh = score({
      caseId: 'TO-LIVE-01',
      family: 'TOOL',
      ids,
      grades,
      output: ids,
      k: 8,
    });
    const nativeSuccessLow = score({
      caseId: 'TO-LIVE-02',
      family: 'TOOL',
      ids,
      grades,
      output: [...ids].reverse(),
      k: 8,
    });
    const fallbackEffective = score({
      caseId: 'TO-LIVE-03',
      family: 'TOOL',
      ids,
      grades,
      output: ids,
      k: 8,
    });
    const registeredCaseIds = [
      'TO-LIVE-01',
      'TO-LIVE-02',
      'TO-LIVE-03',
      'TO-LIVE-04',
      'TO-LIVE-05',
    ];
    const statuses = [
      {
        caseId: 'TO-LIVE-01',
        family: 'TOOL',
        status: 'LIVE_SUCCESS',
        nativeOutputCount: nativeSuccessHigh.outputCount,
        nativeScore: nativeSuccessHigh,
        systemEffectiveScore: nativeSuccessHigh,
        costEstimateUsd: 0.01,
      },
      {
        caseId: 'TO-LIVE-02',
        family: 'TOOL',
        status: 'LIVE_SUCCESS',
        nativeOutputCount: nativeSuccessLow.outputCount,
        nativeScore: nativeSuccessLow,
        systemEffectiveScore: nativeSuccessLow,
        costEstimateUsd: null,
      },
      {
        caseId: 'TO-LIVE-03',
        family: 'TOOL',
        status: 'FALLBACK',
        effectiveOutputCount: fallbackEffective.outputCount,
        systemEffectiveScore: fallbackEffective,
        errorCode: 'GATEWAY_TIMEOUT',
        reason: 'timeout',
        costEstimateUsd: null,
      },
      {
        caseId: 'TO-LIVE-04',
        family: 'TOOL',
        status: 'NOT_RUN',
        reason: 'CREDENTIALS_UNAVAILABLE',
        costEstimateUsd: null,
      },
      {
        caseId: 'TO-LIVE-05',
        family: 'TOOL',
        status: 'NOT_RUN',
        reason: 'BUDGET_STOP',
        costEstimateUsd: null,
      },
    ];
    const summary = summarizeFixedLiveCases(statuses, registeredCaseIds);

    expect(summary.denominator).toBe(5);
    expect(summary.statusCounts).toEqual({ LIVE_SUCCESS: 2, FALLBACK: 1, NOT_RUN: 2 });
    expect(summary.statusRates).toEqual({ LIVE_SUCCESS: 0.4, FALLBACK: 0.2, NOT_RUN: 0.4 });
    expect(summary.cases).toHaveLength(5);
    expect(summary.cases[2]).toMatchObject({
      status: 'FALLBACK',
      reason: 'timeout',
      errorCode: 'GATEWAY_TIMEOUT',
      nativeScore: null,
      effectiveOutputCount: 2,
    });
    expect(summary.cases[3].reason).toBe('CREDENTIALS_UNAVAILABLE');
    expect(summary.cases[3].systemEffectiveScore).toBeNull();
    expect(summary.quality.nativeSuccessConditional.scoredCaseCount).toBe(2);
    expect(summary.quality.nativeSuccessConditional.scoredCoverage).toBe(0.4);
    expect(summary.quality.nativeSuccessConditional.metrics.top1Grade).toEqual({
      mean: 1.5,
      sampleCount: 2,
    });
    expect(summary.quality.systemEffective.scoredCaseCount).toBe(3);
    expect(summary.quality.systemEffective.scoredCoverage).toBe(0.6);
    expect(summary.quality.systemEffective.metrics.top1Grade).toEqual({
      mean: 2,
      sampleCount: 3,
    });
    expect(summary.quality.systemEffective.metrics.ndcgAtK.mean).toBeGreaterThan(
      summary.quality.nativeSuccessConditional.metrics.ndcgAtK.mean,
    );
    expect(summary.quality.systemEffective.fixedDenominatorObservedSums).toMatchObject({
      denominator: 5,
      scoredCaseCount: 3,
      scoredCoverage: 0.6,
      notRunCaseCount: 2,
      notRunCaseIds: ['TO-LIVE-04', 'TO-LIVE-05'],
      notRunScoreImputation: 'NONE',
    });
    expect(
      summary.quality.systemEffective.fixedDenominatorObservedSums.metrics.precisionAtK,
    ).toEqual({ observedSum: 1.5, scoredValueCount: 3 });
    expect(summary.quality.systemEffective.fixedDenominatorObservedSums.metrics.top1Grade).toEqual({
      observedSum: 6,
      scoredValueCount: 3,
    });
    expect(summary.cost).toEqual({
      observedCount: 5,
      knownCount: 1,
      unknownCount: 4,
      knownSubtotalUsd: 0.01,
      totalCostUsd: null,
    });
    expectMetricsError(
      () => summarizeFixedLiveCases(statuses, [...registeredCaseIds.slice(0, 4), 'TO-LIVE-X']),
      'UNREGISTERED_LIVE_CASE',
    );
    expectMetricsError(
      () => summarizeFixedLiveCases(statuses.slice(0, 4), registeredCaseIds),
      'FIXED_LIVE_DENOMINATOR_MISMATCH',
    );
  });

  it('keeps five NOT_RUN cases in the fixed denominator without zero-imputing quality', () => {
    const registeredCaseIds = [
      'NOT-RUN-01',
      'NOT-RUN-02',
      'NOT-RUN-03',
      'NOT-RUN-04',
      'NOT-RUN-05',
    ];
    const records = registeredCaseIds.map((caseId) => ({
      caseId,
      family: 'TOOL',
      status: 'NOT_RUN',
      reason: 'SYNTHETIC_BUDGET_STOP',
      costEstimateUsd: null,
    }));
    const summary = summarizeFixedLiveCases(records, registeredCaseIds);

    expect(summary.denominator).toBe(5);
    expect(summary.statusCounts).toEqual({ LIVE_SUCCESS: 0, FALLBACK: 0, NOT_RUN: 5 });
    expect(summary.quality.nativeSuccessConditional.metrics.precisionAtK).toEqual({
      mean: null,
      sampleCount: 0,
    });
    expect(summary.quality.systemEffective.scoredCaseCount).toBe(0);
    expect(summary.quality.systemEffective.scoredCoverage).toBe(0);
    expect(summary.quality.systemEffective.fixedDenominatorObservedSums).toMatchObject({
      denominator: 5,
      notRunCaseCount: 5,
      notRunCaseIds: registeredCaseIds,
      notRunScoreImputation: 'NONE',
    });
    expect(
      summary.quality.systemEffective.fixedDenominatorObservedSums.metrics.precisionAtK,
    ).toEqual({ observedSum: null, scoredValueCount: 0 });
    expect(summary.cost.totalCostUsd).toBeNull();
  });

  it('rejects illegal or duplicate candidates and never treats unknown cost as zero', () => {
    const valid = {
      caseId: 'SYN-INVALID',
      family: 'TOOL',
      candidateIds: ['a', 'b'],
      candidateGrades: gradeRows(['a', 'b'], [3, 0]),
      outputIds: ['a'],
      k: 8,
      source: 'NATIVE',
    };
    expectMetricsError(
      () => scoreRanking({ ...valid, candidateIds: ['a', 'a'] }),
      'DUPLICATE_CANDIDATE_ID',
    );
    expectMetricsError(
      () => scoreRanking({ ...valid, outputIds: ['a', 'unknown'] }),
      'ILLEGAL_OUTPUT_CANDIDATE',
    );
    expectMetricsError(
      () => scoreRanking({ ...valid, outputIds: ['a', 'a'] }),
      'DUPLICATE_CANDIDATE_ID',
    );
    expectMetricsError(
      () => scoreRanking({ ...valid, candidateGrades: gradeRows(['a', 'b'], [3, 4]) }),
      'INVALID_GRADE',
    );
    expectMetricsError(
      () =>
        scoreRanking({
          ...valid,
          candidateGrades: [
            { candidateId: 'a', grade: 3, referenceReason: 'synthetic-only should be rejected' },
            { candidateId: 'b', grade: 0 },
          ],
        }),
      'INVALID_GRADE_ROW_FIELDS',
    );
    expect(summarizeCostEstimates([0, 0])).toMatchObject({ totalCostUsd: 0, unknownCount: 0 });
    expect(summarizeCostEstimates([0.01, null])).toMatchObject({
      totalCostUsd: null,
      knownSubtotalUsd: 0.01,
      unknownCount: 1,
    });
  });

  it('requires family production K and validates derived output as a native-order truncation', () => {
    expectMetricsError(
      () =>
        score({
          family: 'TOOL',
          ids: ['a', 'b'],
          grades: [3, 0],
          output: ['a'],
          k: 3,
        }),
      'NON_PRODUCTION_K',
    );

    expectMetricsError(
      () =>
        scoreNativeAndDerived({
          caseId: 'SYN-DERIVED-MISMATCH',
          family: 'TOOL',
          candidateIds: ['a', 'b'],
          candidateGrades: gradeRows(['a', 'b'], [3, 0]),
          nativeOutputIds: ['a', 'b'],
          derivedOutputIds: ['b', 'a'],
          k: 8,
        }),
      'DERIVED_OUTPUT_MISMATCH',
    );
  });

  it('rejects a shortened fixed Live denominator and unusable paired source paths', () => {
    expectMetricsError(
      () =>
        summarizeFixedLiveCases(
          [{ caseId: 'one', family: 'TOOL', status: 'NOT_RUN', reason: 'STOPPED' }],
          ['one', 'two', 'three', 'four', 'five'],
        ),
      'FIXED_LIVE_DENOMINATOR_MISMATCH',
    );
    const ids = ['a', 'b'];
    const deterministic = score({
      caseId: 'SYN-SOURCE',
      family: 'TOOL',
      ids,
      grades: [3, 0],
      output: ids,
      k: 8,
    });
    const derived = score({
      caseId: 'SYN-SOURCE',
      family: 'TOOL',
      ids,
      grades: [3, 0],
      output: ids,
      k: 8,
      source: 'DERIVED',
    });
    expectMetricsError(
      () => pairedMetricDifferences({ deterministic, jevNative: derived }),
      'NON_NATIVE_PAIR',
    );

    const mismatchedPool = score({
      caseId: 'SYN-SOURCE',
      family: 'TOOL',
      ids,
      grades: [0, 3],
      output: ids,
      k: 8,
    });
    expectMetricsError(
      () => pairedMetricDifferences({ deterministic, jevNative: mismatchedPool }),
      'CANDIDATE_POOL_MISMATCH',
    );
  });
});
