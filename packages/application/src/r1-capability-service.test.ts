import { describe, expect, it } from 'vitest';
import type {
  CapabilityDimension,
  CapabilityEvidence,
  ModelCapabilityBenchmark,
  TeammateCapabilityState,
} from '@cultivation/domain';
import { BENCHMARK_SOURCE_CATALOG } from './r1-benchmark-source-catalog.js';
import { BenchmarkPriorResolver } from './r1-benchmark-prior.js';
import {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_SCORING_POLICY,
  calculateCapabilityScore,
  ratingStarsToScore,
} from './r1-capability-scoring.js';
import {
  R1CapabilityService,
  type R1CapabilityStore,
  type R1MissionRunRatingTargetFact,
  type R1RuntimeTeammate,
  type R1RuntimeTeammateReference,
} from './r1-capability-service.js';

const RUN = { missionId: 'mission-1', runId: 'run-1' };

function benchmark(overrides: Partial<ModelCapabilityBenchmark> = {}): ModelCapabilityBenchmark {
  return {
    id: 'benchmark-1',
    runtimeProfileId: 'runtime-1',
    modelAlias: 'model-1',
    dimension: 'GENERAL_REASONING',
    supported: true,
    normalizedScore: 50,
    rawScore: 50,
    source: 'test-source',
    benchmark: 'test-benchmark',
    benchmarkVersion: 'v1',
    snapshotDate: '2026-08-01T00:00:00.000Z',
    sourceUrl: null,
    provenanceType: 'CATALOG',
    createdAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

function evidence(overrides: Partial<CapabilityEvidence> = {}): CapabilityEvidence {
  return {
    id: 'evidence-1',
    teammateId: 'teammate-1',
    runtimeProfileId: 'runtime-1',
    missionId: 'mission-old',
    runId: 'run-old',
    dimension: 'GENERAL_REASONING',
    sourceType: 'USER_DIMENSION_RATING',
    ratingValue: 100,
    demandWeight: 1,
    evidenceWeight: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

class MemoryCapabilityStore implements R1CapabilityStore {
  teammates = new Map<string, R1RuntimeTeammate>();
  aliases = new Map<string, string>();
  benchmarks: ModelCapabilityBenchmark[] = [];
  evidence: CapabilityEvidence[] = [];
  states = new Map<string, TeammateCapabilityState[]>();
  ratingTargets: R1MissionRunRatingTargetFact[] = [];
  appendedBatches: CapabilityEvidence[][] = [];

  getTeammate(teammateId: string): R1RuntimeTeammate | null {
    return this.teammates.get(teammateId) ?? null;
  }

  getRuntimeModelAlias(runtimeProfileId: string): string | null {
    return this.aliases.get(runtimeProfileId) ?? null;
  }

  listTeammatesUsingRuntime(runtimeProfileId: string): R1RuntimeTeammateReference[] {
    return [...this.teammates.values()]
      .filter((teammate) => teammate.currentRuntimeProfileId === runtimeProfileId)
      .map(({ id, currentRuntimeProfileId }) => ({ id, currentRuntimeProfileId }));
  }

  saveModelCapabilityBenchmark(value: ModelCapabilityBenchmark): void {
    this.benchmarks.push(value);
  }

  listModelCapabilityBenchmarks(
    runtimeProfileId: string,
    modelAlias?: string,
  ): ModelCapabilityBenchmark[] {
    return this.benchmarks.filter(
      (value) =>
        value.runtimeProfileId === runtimeProfileId &&
        (modelAlias === undefined || value.modelAlias === modelAlias),
    );
  }

  listCapabilityEvidence(
    teammateId: string,
    dimension?: CapabilityDimension,
  ): CapabilityEvidence[] {
    return this.evidence.filter(
      (value) =>
        value.teammateId === teammateId &&
        (dimension === undefined || value.dimension === dimension),
    );
  }

  listTeammateCapabilityStates(teammateId: string): TeammateCapabilityState[] {
    return this.states.get(teammateId) ?? [];
  }

  replaceTeammateCapabilityStates(
    teammateId: string,
    values: readonly TeammateCapabilityState[],
  ): void {
    this.states.set(teammateId, [...values]);
  }

  listMissionRunRatingTargets(missionId: string, runId: string): R1MissionRunRatingTargetFact[] {
    void missionId;
    void runId;
    return [...this.ratingTargets];
  }

  appendCapabilityEvidenceBatch(values: readonly CapabilityEvidence[]): void {
    if (values.length > 3) throw new Error('At most three dimensions can be rated at once.');
    this.appendedBatches.push([...values]);
    this.evidence.push(...values);
  }
}

function configuredStore(): MemoryCapabilityStore {
  const store = new MemoryCapabilityStore();
  store.aliases.set('runtime-1', 'model-1');
  store.aliases.set('runtime-2', 'model-2');
  store.teammates.set('teammate-1', {
    id: 'teammate-1',
    currentRuntimeProfileId: 'runtime-1',
    executorKind: 'MODEL_RUNTIME',
  });
  return store;
}

function addAllSupportedBenchmarks(
  store: MemoryCapabilityStore,
  runtimeProfileId = 'runtime-1',
  modelAlias = 'model-1',
) {
  for (const [index, dimension] of CAPABILITY_DIMENSIONS.entries()) {
    store.benchmarks.push(
      benchmark({
        id: `benchmark-${runtimeProfileId}-${dimension}`,
        runtimeProfileId,
        modelAlias,
        dimension,
        normalizedScore: index === 0 ? 0 : 50,
      }),
    );
  }
}

describe('R1 benchmark prior and dynamic capability scoring', () => {
  it('uses fixed provenance priority and lets an unsupported override mask lower priors', () => {
    const resolver = new BenchmarkPriorResolver();
    const selected = resolver.resolve({
      benchmarks: [
        benchmark({ id: 'catalog', normalizedScore: 90 }),
        benchmark({
          id: 'unsupported-override',
          supported: false,
          normalizedScore: null,
          rawScore: null,
          provenanceType: 'USER_OVERRIDE',
        }),
      ],
      runtimeProfileId: 'runtime-1',
      modelAlias: 'model-1',
      dimension: 'GENERAL_REASONING',
    });

    expect(selected?.id).toBe('unsupported-override');
    expect(selected?.normalizedScore).toBeNull();
  });

  it('prefers catalog over estimates and orders equal sources by snapshot then creation fact', () => {
    const resolver = new BenchmarkPriorResolver();
    const input = {
      runtimeProfileId: 'runtime-1',
      modelAlias: 'model-1',
      dimension: 'GENERAL_REASONING' as const,
    };
    const estimate = benchmark({
      id: 'new-estimate',
      provenanceType: 'USER_ESTIMATE',
      snapshotDate: '2026-09-01T00:00:00.000Z',
    });
    const olderCatalog = benchmark({ id: 'old-catalog', normalizedScore: 60 });
    const latestCatalog = benchmark({
      id: 'latest-catalog',
      normalizedScore: 70,
      snapshotDate: '2026-08-02T00:00:00.000Z',
      createdAt: '2026-08-03T00:00:00.000Z',
    });
    expect(
      resolver.resolve({ ...input, benchmarks: [estimate, olderCatalog, latestCatalog] })?.id,
    ).toBe('latest-catalog');
    const laterCreation = benchmark({
      id: 'later-creation',
      normalizedScore: 75,
      snapshotDate: latestCatalog.snapshotDate,
      createdAt: '2026-08-04T00:00:00.000Z',
    });
    expect(resolver.resolve({ ...input, benchmarks: [latestCatalog, laterCreation] })?.id).toBe(
      'later-creation',
    );
  });

  it('calculates a benchmark prior plus transfer-weighted evidence deterministically', () => {
    const projection = calculateCapabilityScore({
      teammateId: 'teammate-1',
      dimension: 'GENERAL_REASONING',
      currentRuntimeProfileId: 'runtime-2',
      prior: benchmark({
        runtimeProfileId: 'runtime-2',
        modelAlias: 'model-2',
        normalizedScore: 40,
        snapshotDate: '2030-01-01T00:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
      evidence: [
        evidence({ id: 'current', runtimeProfileId: 'runtime-2', ratingValue: 100 }),
        evidence({ id: 'transferred', runtimeProfileId: 'runtime-1', ratingValue: 0 }),
      ],
    });

    expect(projection).toMatchObject({
      currentScore: 44.92,
      evidenceWeight: 1 + CAPABILITY_SCORING_POLICY.transferWeight,
      ratingCount: 2,
      weightedUserScore: 100 / (1 + CAPABILITY_SCORING_POLICY.transferWeight),
      alpha:
        (1 + CAPABILITY_SCORING_POLICY.transferWeight) /
        (CAPABILITY_SCORING_POLICY.priorStrength + 1 + CAPABILITY_SCORING_POLICY.transferWeight),
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
  });

  it('limits one extreme rating and moves gradually with repeated consistent ratings', () => {
    const prior = benchmark({ normalizedScore: 80 });
    const userRatings = Array.from({ length: 6 }, (_, index) =>
      evidence({
        id: `low-${index}`,
        ratingValue: 0,
        evidenceWeight: CAPABILITY_SCORING_POLICY.overallProjectionEvidenceWeight,
        createdAt: `2026-08-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const scoreFor = (count: number) =>
      calculateCapabilityScore({
        teammateId: 'teammate-1',
        dimension: 'GENERAL_REASONING',
        currentRuntimeProfileId: 'runtime-1',
        prior,
        evidence: userRatings.slice(0, count),
      })?.currentScore;

    expect(scoreFor(0)).toBe(80);
    expect(scoreFor(1)).toBeGreaterThan(75);
    expect(scoreFor(6)).toBeLessThan(scoreFor(1)!);
    expect(scoreFor(6)).toBeGreaterThan(50);
  });

  it('weights an explicit dimension rating more than an overall projection', () => {
    const prior = benchmark({ normalizedScore: 80 });
    const scoreWith = (evidenceWeight: number) =>
      calculateCapabilityScore({
        teammateId: 'teammate-1',
        dimension: 'GENERAL_REASONING',
        currentRuntimeProfileId: 'runtime-1',
        prior,
        evidence: [evidence({ ratingValue: 0, evidenceWeight })],
      })?.currentScore;

    expect(scoreWith(CAPABILITY_SCORING_POLICY.dimensionEvidenceWeight)).toBeLessThan(
      scoreWith(CAPABILITY_SCORING_POLICY.overallProjectionEvidenceWeight)!,
    );
  });

  it('keeps a supported zero score distinct from an unsupported benchmark', () => {
    const zeroScore = calculateCapabilityScore({
      teammateId: 'teammate-1',
      dimension: 'GENERAL_REASONING',
      currentRuntimeProfileId: 'runtime-1',
      prior: benchmark({ normalizedScore: 0 }),
      evidence: [],
    });
    const unsupported = calculateCapabilityScore({
      teammateId: 'teammate-1',
      dimension: 'GENERAL_REASONING',
      currentRuntimeProfileId: 'runtime-1',
      prior: benchmark({ supported: false, normalizedScore: null, rawScore: null }),
      evidence: [],
    });

    expect(zeroScore?.currentScore).toBe(0);
    expect(unsupported).toBeNull();
    expect(ratingStarsToScore(1)).toBe(0);
  });

  it('offers 14 dimensions and reference-only source entries without embedded scores', () => {
    expect(CAPABILITY_DIMENSIONS).toHaveLength(14);
    expect(BENCHMARK_SOURCE_CATALOG.length).toBeGreaterThan(0);
    expect(BENCHMARK_SOURCE_CATALOG.every((entry) => /^https:\/\//.test(entry.url))).toBe(true);
    expect(BENCHMARK_SOURCE_CATALOG.every((entry) => !('score' in entry))).toBe(true);
    expect(new Set(BENCHMARK_SOURCE_CATALOG.flatMap((entry) => entry.dimensions))).toEqual(
      new Set(CAPABILITY_DIMENSIONS),
    );
  });
});

describe('R1 capability service', () => {
  it('requires a benchmark model alias to match the Runtime model ID', () => {
    const store = configuredStore();
    const service = new R1CapabilityService(store);

    expect(() =>
      service.saveBenchmark({
        ...benchmark(),
        id: undefined,
        createdAt: undefined,
        modelAlias: 'stale-alias',
      }),
    ).toThrow(/match the Runtime model ID/);
  });

  it('exposes resolver-selected priors for all dimensions and rebuilds after benchmark saves', () => {
    const store = configuredStore();
    const service = new R1CapabilityService(store, {
      newId: () => 'new-benchmark',
      now: () => '2026-08-04T00:00:00.000Z',
    });

    const saved = service.saveBenchmark({
      ...benchmark(),
      id: undefined,
      createdAt: undefined,
      dimension: 'GENERAL_REASONING',
      normalizedScore: 0,
    });
    const priors = service.listEffectivePriors('runtime-1');

    expect(saved.id).toBe('new-benchmark');
    expect(saved.modelAlias).toBe('model-1');
    expect(priors).toHaveLength(14);
    expect(priors[0]?.prior?.id).toBe('new-benchmark');
    expect(service.profile('teammate-1').dimensions[0]).toMatchObject({
      dimension: 'GENERAL_REASONING',
      currentScore: 0,
      source: 'BENCHMARK_ONLY',
    });
    expect(store.states.has('teammate-1')).toBe(false);
  });

  it('disables Mission ratings without writing legacy CapabilityEvidence', () => {
    const store = configuredStore();
    addAllSupportedBenchmarks(store);
    store.ratingTargets.push({
      teammateId: 'teammate-1',
      runtimeProfileId: 'runtime-1',
      modelAlias: 'model-1',
    });
    const service = new R1CapabilityService(store);

    const targets = service.getRatingTargets(RUN.missionId, RUN.runId);
    expect(targets).toEqual([
      expect.objectContaining({
        ...RUN,
        teammateId: 'teammate-1',
        runtimeProfileId: 'runtime-1',
        supportedDimensions: [...CAPABILITY_DIMENSIONS],
        alreadyRated: false,
      }),
    ]);
    expect(() =>
      service.submitRating({
        ...RUN,
        teammateId: 'teammate-1',
        runtimeProfileId: 'runtime-1',
        selectedDimensions: ['GENERAL_REASONING'],
        overallRating: 5,
      }),
    ).toThrow(/Mission ratings are disabled/);
    expect(store.appendedBatches).toHaveLength(0);
    expect(store.evidence).toHaveLength(0);
  });

  it('returns no target unless the persistence boundary reports actual run execution', () => {
    const store = configuredStore();
    addAllSupportedBenchmarks(store);
    const service = new R1CapabilityService(store);

    expect(service.getRatingTargets(RUN.missionId, RUN.runId)).toEqual([]);
    expect(() =>
      service.submitRating({
        ...RUN,
        teammateId: 'teammate-1',
        runtimeProfileId: 'runtime-1',
        selectedDimensions: ['GENERAL_REASONING'],
        overallRating: 5,
      }),
    ).toThrow(/Mission ratings are disabled/);
  });

  it('does not enable USER_BRIDGE rating even if a fixture supplies a model target', () => {
    const store = configuredStore();
    store.teammates.set('bridge', {
      id: 'bridge',
      currentRuntimeProfileId: null,
      executorKind: 'USER_BRIDGE',
    });
    store.ratingTargets.push({
      teammateId: 'bridge',
      runtimeProfileId: 'runtime-1',
      modelAlias: 'model-1',
    });
    addAllSupportedBenchmarks(store);

    const service = new R1CapabilityService(store);
    expect(service.getRatingTargets(RUN.missionId, RUN.runId)).toEqual([]);
    expect(() =>
      service.submitRating({
        ...RUN,
        teammateId: 'bridge',
        runtimeProfileId: 'runtime-1',
        selectedDimensions: ['GENERAL_REASONING'],
        overallRating: 5,
      }),
    ).toThrow(/Mission ratings are disabled/);
  });

  it('uses only the current Runtime Benchmark and does not write legacy state projections', () => {
    const store = configuredStore();
    store.teammates.set('teammate-1', {
      id: 'teammate-1',
      currentRuntimeProfileId: 'runtime-2',
      executorKind: 'MODEL_RUNTIME',
    });
    store.benchmarks.push(
      benchmark({
        id: 'prior-runtime-1',
        runtimeProfileId: 'runtime-1',
        modelAlias: 'model-1',
        normalizedScore: 90,
      }),
      benchmark({
        id: 'prior-runtime-2',
        runtimeProfileId: 'runtime-2',
        modelAlias: 'model-2',
        normalizedScore: 40,
      }),
    );
    store.evidence.push(evidence({ runtimeProfileId: 'runtime-1', ratingValue: 0 }));
    const staleState: TeammateCapabilityState = {
      teammateId: 'teammate-1',
      dimension: 'GENERAL_REASONING',
      currentScore: 99,
      evidenceWeight: 15,
      ratingCount: 8,
      currentRuntimeProfileId: 'runtime-1',
      scoringPolicyVersion: 'legacy-dynamic-v1',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
    store.states.set('teammate-1', [staleState]);
    const service = new R1CapabilityService(store);

    const first = service.profile('teammate-1');
    const second = service.profile('teammate-1');
    const rebuilt = service.rebuild('teammate-1');
    const general = first.dimensions.find((value) => value.dimension === 'GENERAL_REASONING');

    expect(first).toEqual(second);
    expect(general).toMatchObject({
      prior: { id: 'prior-runtime-2', normalizedScore: 40 },
      currentScore: 40,
      evidenceWeight: 0,
      ratingCount: 0,
      weightedUserScore: null,
      priorStrength: 0,
      transferWeight: 0,
      alpha: 0,
      currentRuntimeProfileId: 'runtime-2',
      source: 'BENCHMARK_ONLY',
      scoringPolicyVersion: 'r1-benchmark-only-v1',
    });
    expect(first.dimensions).toHaveLength(14);
    expect(rebuilt).toEqual([
      expect.objectContaining({
        dimension: 'GENERAL_REASONING',
        currentScore: 40,
        evidenceWeight: 0,
        ratingCount: 0,
        scoringPolicyVersion: 'r1-benchmark-only-v1',
      }),
    ]);
    expect(store.states.get('teammate-1')).toEqual([staleState]);
  });

  it('keeps zero-score, unsupported, and unconfigured Benchmark dimensions distinct', () => {
    const store = configuredStore();
    store.benchmarks.push(
      benchmark({
        id: 'zero-score',
        dimension: 'GENERAL_REASONING',
        normalizedScore: 0,
      }),
      benchmark({
        id: 'unsupported',
        dimension: 'LONG_CONTEXT_REASONING',
        supported: false,
        normalizedScore: null,
        rawScore: null,
      }),
    );
    store.evidence.push(evidence({ ratingValue: 100 }));
    store.states.set('teammate-1', [
      {
        teammateId: 'teammate-1',
        dimension: 'GENERAL_REASONING',
        currentScore: 100,
        evidenceWeight: 10,
        ratingCount: 20,
        currentRuntimeProfileId: 'runtime-1',
        scoringPolicyVersion: 'legacy-dynamic-v1',
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
    ]);
    const profile = new R1CapabilityService(store).profile('teammate-1');
    const zero = profile.dimensions.find((value) => value.dimension === 'GENERAL_REASONING');
    const unsupported = profile.dimensions.find(
      (value) => value.dimension === 'LONG_CONTEXT_REASONING',
    );
    const unconfigured = profile.dimensions.find(
      (value) => value.dimension === 'AGENTIC_EXECUTION',
    );

    expect(zero).toMatchObject({ currentScore: 0, source: 'BENCHMARK_ONLY', ratingCount: 0 });
    expect(unsupported).toMatchObject({ currentScore: null, source: 'UNSUPPORTED' });
    expect(unconfigured).toMatchObject({ prior: null, currentScore: null, source: 'NO_BENCHMARK' });
  });
});
