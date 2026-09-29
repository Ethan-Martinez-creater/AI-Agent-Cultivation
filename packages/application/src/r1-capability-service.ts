import { randomUUID } from 'node:crypto';
import type {
  CapabilityDimension,
  CapabilityEvidence,
  ModelCapabilityBenchmark,
  TeammateCapabilityState,
} from '@cultivation/domain';
import { BenchmarkPriorResolver } from './r1-benchmark-prior.js';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';

const BENCHMARK_ONLY_SCORING_POLICY_VERSION = 'r1-benchmark-only-v1';

export interface R1RuntimeTeammate {
  id: string;
  currentRuntimeProfileId: string | null;
  executorKind: 'MODEL_RUNTIME' | 'USER_BRIDGE';
}

export interface R1RuntimeTeammateReference {
  id: string;
  currentRuntimeProfileId: string | null;
}

export interface R1MissionRunRatingTargetFact {
  teammateId: string;
  runtimeProfileId: string;
  modelAlias: string;
}

/** Persistence boundary; legacy evidence/state accessors remain for stored-data compatibility. */
export interface R1CapabilityStore {
  getTeammate(teammateId: string): R1RuntimeTeammate | null;
  getRuntimeModelAlias(runtimeProfileId: string): string | null;
  listTeammatesUsingRuntime(runtimeProfileId: string): R1RuntimeTeammateReference[];
  saveModelCapabilityBenchmark(value: ModelCapabilityBenchmark): void;
  listModelCapabilityBenchmarks(
    runtimeProfileId: string,
    modelAlias?: string,
  ): ModelCapabilityBenchmark[];
  listCapabilityEvidence(teammateId: string, dimension?: CapabilityDimension): CapabilityEvidence[];
  listTeammateCapabilityStates(teammateId: string): TeammateCapabilityState[];
  replaceTeammateCapabilityStates(
    teammateId: string,
    states: readonly TeammateCapabilityState[],
  ): void;
  listMissionRunRatingTargets(missionId: string, runId: string): R1MissionRunRatingTargetFact[];
  appendCapabilityEvidenceBatch(values: readonly CapabilityEvidence[]): void;
}

export interface R1RatingTarget extends R1MissionRunRatingTargetFact {
  missionId: string;
  runId: string;
  supportedDimensions: CapabilityDimension[];
  alreadyRated: boolean;
}

export type R1CapabilityProfileSource =
  | 'BENCHMARK_ONLY'
  | 'BENCHMARK_PLUS_USER_EVIDENCE'
  | 'UNSUPPORTED'
  | 'NO_BENCHMARK';

export interface R1CapabilityDimensionProfile {
  dimension: CapabilityDimension;
  prior: ModelCapabilityBenchmark | null;
  currentScore: number | null;
  ratingCount: number;
  evidenceWeight: number;
  weightedUserScore: number | null;
  priorStrength: number;
  transferWeight: number;
  alpha: number;
  currentRuntimeProfileId: string | null;
  scoringPolicyVersion: string;
  source: R1CapabilityProfileSource;
}

export interface R1EffectiveBenchmarkPrior {
  dimension: CapabilityDimension;
  prior: ModelCapabilityBenchmark | null;
}

export interface R1CapabilityProfile {
  teammateId: string;
  currentRuntimeProfileId: string | null;
  scoringPolicyVersion: string;
  dimensions: R1CapabilityDimensionProfile[];
}

export interface SubmitCapabilityRatingInput {
  missionId: string;
  runId: string;
  teammateId: string;
  runtimeProfileId: string;
  selectedDimensions: CapabilityDimension[];
  overallRating?: number;
  dimensionRatings?: Partial<Record<CapabilityDimension, number>>;
  skip?: boolean;
}

export interface SubmitCapabilityRatingResult {
  evidence: CapabilityEvidence[];
  skipped: boolean;
}

export interface R1CapabilityServiceOptions {
  newId?: () => string;
  now?: () => string;
  resolver?: BenchmarkPriorResolver;
}

/** Benchmark catalog and deterministic Benchmark-only capability projection. */
export class R1CapabilityService {
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly resolver: BenchmarkPriorResolver;

  constructor(
    private readonly store: R1CapabilityStore,
    options: R1CapabilityServiceOptions = {},
  ) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.resolver = options.resolver ?? new BenchmarkPriorResolver();
  }

  saveBenchmark(
    input: Omit<ModelCapabilityBenchmark, 'id' | 'createdAt'> & {
      id?: string;
      createdAt?: string;
    },
  ): ModelCapabilityBenchmark {
    const configuredModelAlias = this.store.getRuntimeModelAlias(input.runtimeProfileId);
    if (!configuredModelAlias) throw new Error('Runtime profile does not exist.');
    if (input.modelAlias.trim() !== configuredModelAlias) {
      throw new Error('Benchmark model alias must match the Runtime model ID.');
    }
    validateBenchmark(input);
    const benchmark: ModelCapabilityBenchmark = {
      ...input,
      id: input.id ?? this.newId(),
      modelAlias: configuredModelAlias,
      createdAt: input.createdAt ?? this.now(),
    };
    this.store.saveModelCapabilityBenchmark(benchmark);
    for (const teammate of this.store.listTeammatesUsingRuntime(benchmark.runtimeProfileId)) {
      this.rebuild(teammate.id);
    }
    return benchmark;
  }

  listBenchmarks(runtimeProfileId: string, modelAlias?: string): ModelCapabilityBenchmark[] {
    return this.store.listModelCapabilityBenchmarks(runtimeProfileId, modelAlias);
  }

  /** Effective per-dimension priors using the same resolver as scoring/profile. */
  listEffectivePriors(runtimeProfileId: string): R1EffectiveBenchmarkPrior[] {
    const modelAlias = this.store.getRuntimeModelAlias(runtimeProfileId);
    const benchmarks = modelAlias
      ? this.store.listModelCapabilityBenchmarks(runtimeProfileId, modelAlias)
      : [];
    return CAPABILITY_DIMENSIONS.map((dimension) => ({
      dimension,
      prior: modelAlias
        ? this.resolver.resolve({ benchmarks, runtimeProfileId, modelAlias, dimension })
        : null,
    }));
  }

  /** Targets are derived only from terminal-run execution facts supplied by persistence. */
  getRatingTargets(missionId: string, runId: string): R1RatingTarget[] {
    const facts = this.store.listMissionRunRatingTargets(missionId, runId);
    const targets = new Map<string, R1RatingTarget>();
    for (const fact of facts) {
      if (this.store.getTeammate(fact.teammateId)?.executorKind !== 'MODEL_RUNTIME') continue;
      const key = `${fact.teammateId}\u0000${fact.runtimeProfileId}`;
      const benchmarks = this.store.listModelCapabilityBenchmarks(
        fact.runtimeProfileId,
        fact.modelAlias,
      );
      const supportedDimensions = CAPABILITY_DIMENSIONS.filter((dimension) => {
        const prior = this.resolver.resolve({
          benchmarks,
          runtimeProfileId: fact.runtimeProfileId,
          modelAlias: fact.modelAlias,
          dimension,
        });
        return prior?.supported === true && prior.normalizedScore !== null;
      });
      targets.set(key, {
        ...fact,
        missionId,
        runId,
        supportedDimensions,
        alreadyRated: false,
      });
    }
    return [...targets.values()].sort(
      (left, right) =>
        left.teammateId.localeCompare(right.teammateId) ||
        left.runtimeProfileId.localeCompare(right.runtimeProfileId),
    );
  }

  submitRating(input: SubmitCapabilityRatingInput): SubmitCapabilityRatingResult {
    void input;
    throw new Error('Mission ratings are disabled; capability scores come from Benchmarks only.');
  }

  /** Returns legacy state-shaped values derived only from the current Runtime's Benchmarks. */
  rebuild(teammateId: string): TeammateCapabilityState[] {
    const teammate = this.store.getTeammate(teammateId);
    if (!teammate) throw new Error('Teammate does not exist.');
    if (teammate.executorKind !== 'MODEL_RUNTIME' || !teammate.currentRuntimeProfileId) {
      return [];
    }
    const runtimeProfileId = teammate.currentRuntimeProfileId;
    const modelAlias = this.store.getRuntimeModelAlias(runtimeProfileId);
    if (!modelAlias) {
      return [];
    }
    const benchmarks = this.store.listModelCapabilityBenchmarks(runtimeProfileId, modelAlias);
    const states = CAPABILITY_DIMENSIONS.flatMap((dimension) => {
      const prior = this.resolver.resolve({
        benchmarks,
        runtimeProfileId,
        modelAlias,
        dimension,
      });
      if (!hasNormalizedBenchmarkScore(prior)) return [];
      return [
        {
          teammateId,
          dimension,
          currentScore: prior.normalizedScore,
          evidenceWeight: 0,
          ratingCount: 0,
          currentRuntimeProfileId: runtimeProfileId,
          scoringPolicyVersion: BENCHMARK_ONLY_SCORING_POLICY_VERSION,
          updatedAt: prior.createdAt,
        },
      ];
    });
    return states;
  }

  /** Always resolves the Benchmark for the teammate's current fixed Runtime model. */
  profile(teammateId: string): R1CapabilityProfile {
    const teammate = this.store.getTeammate(teammateId);
    if (!teammate) throw new Error('Teammate does not exist.');
    const runtimeProfileId = teammate.currentRuntimeProfileId;
    const effectivePriors = runtimeProfileId
      ? this.listEffectivePriors(runtimeProfileId)
      : CAPABILITY_DIMENSIONS.map((dimension) => ({ dimension, prior: null }));
    const priorByDimension = new Map(
      effectivePriors.map(({ dimension, prior }) => [dimension, prior]),
    );
    const dimensions = CAPABILITY_DIMENSIONS.map((dimension): R1CapabilityDimensionProfile => {
      const prior = priorByDimension.get(dimension) ?? null;
      const hasBenchmarkScore = hasNormalizedBenchmarkScore(prior);
      return {
        dimension,
        prior,
        currentScore: hasBenchmarkScore ? prior.normalizedScore : null,
        ratingCount: 0,
        evidenceWeight: 0,
        weightedUserScore: null,
        priorStrength: 0,
        transferWeight: 0,
        alpha: 0,
        currentRuntimeProfileId: runtimeProfileId,
        scoringPolicyVersion: BENCHMARK_ONLY_SCORING_POLICY_VERSION,
        source: !prior ? 'NO_BENCHMARK' : hasBenchmarkScore ? 'BENCHMARK_ONLY' : 'UNSUPPORTED',
      };
    });
    return {
      teammateId,
      currentRuntimeProfileId: runtimeProfileId,
      scoringPolicyVersion: BENCHMARK_ONLY_SCORING_POLICY_VERSION,
      dimensions,
    };
  }
}

function validateBenchmark(
  input: Omit<ModelCapabilityBenchmark, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: string;
  },
): void {
  if (!input.modelAlias.trim()) throw new Error('Benchmark model alias is required.');
  if (!input.source.trim() || !input.benchmark.trim() || !input.benchmarkVersion.trim()) {
    throw new Error('Benchmark source, name, and version are required.');
  }
  if (input.supported) {
    if (
      input.normalizedScore === null ||
      !Number.isFinite(input.normalizedScore) ||
      input.normalizedScore < 0 ||
      input.normalizedScore > 100
    ) {
      throw new Error('Supported Benchmarks need a normalized score from 0 to 100.');
    }
  } else if (input.normalizedScore !== null || input.rawScore !== null) {
    throw new Error('Unsupported Benchmarks must not contain scores.');
  }
  if (input.rawScore !== null && !Number.isFinite(input.rawScore)) {
    throw new Error('Raw Benchmark score must be finite or null.');
  }
  if (!Number.isFinite(Date.parse(input.snapshotDate))) {
    throw new Error('Benchmark snapshot date is invalid.');
  }
  if (input.createdAt !== undefined && !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('Benchmark creation date is invalid.');
  }
}

function hasNormalizedBenchmarkScore(
  prior: ModelCapabilityBenchmark | null,
): prior is ModelCapabilityBenchmark & { supported: true; normalizedScore: number } {
  return (
    prior?.supported === true &&
    prior.normalizedScore !== null &&
    Number.isFinite(prior.normalizedScore) &&
    prior.normalizedScore >= 0 &&
    prior.normalizedScore <= 100
  );
}
