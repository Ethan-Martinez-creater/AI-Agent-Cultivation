import { randomUUID } from 'node:crypto';
import type {
  CapabilityDimension,
  CapabilityEvidence,
  ModelCapabilityBenchmark,
  TeammateCapabilityState,
} from '@cultivation/domain';
import { BenchmarkPriorResolver } from './r1-benchmark-prior.js';
import {
  calculateCapabilityScore,
  CAPABILITY_DIMENSIONS,
  CAPABILITY_SCORING_POLICY,
  projectCapabilityScore,
  ratingStarsToScore,
} from './r1-capability-scoring.js';

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

/** Persistence boundary. Evidence remains append-only; states are replaceable projections. */
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

/** Benchmark entry, mission feedback, and deterministic capability projection. */
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
      const existingEvidence = this.store.listCapabilityEvidence(fact.teammateId);
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
        alreadyRated: existingEvidence.some(
          (entry) =>
            entry.teammateId === fact.teammateId &&
            entry.missionId === missionId &&
            entry.runId === runId &&
            entry.runtimeProfileId === fact.runtimeProfileId,
        ),
      });
    }
    return [...targets.values()].sort(
      (left, right) =>
        left.teammateId.localeCompare(right.teammateId) ||
        left.runtimeProfileId.localeCompare(right.runtimeProfileId),
    );
  }

  submitRating(input: SubmitCapabilityRatingInput): SubmitCapabilityRatingResult {
    const target = this.getRatingTargets(input.missionId, input.runId).find(
      (candidate) =>
        candidate.teammateId === input.teammateId &&
        candidate.runtimeProfileId === input.runtimeProfileId,
    );
    if (!target) throw new Error('This Teammate did not execute the selected Mission Run.');
    if (target.alreadyRated)
      throw new Error('This Teammate and Runtime have already been rated for this Run.');
    if (input.skip) return { evidence: [], skipped: true };
    if (target.supportedDimensions.length === 0) {
      throw new Error('No supported Benchmark dimensions are configured for this Runtime.');
    }
    validateSelectedDimensions(input.selectedDimensions, target.supportedDimensions);

    const dimensionRatings = input.dimensionRatings ?? {};
    for (const [dimension, rating] of Object.entries(dimensionRatings)) {
      if (!input.selectedDimensions.includes(dimension as CapabilityDimension)) {
        throw new Error('Per-dimension ratings must be within the selected dimensions.');
      }
      validateStars(rating);
    }
    if (input.overallRating !== undefined) validateStars(input.overallRating);
    if (
      input.overallRating === undefined &&
      input.selectedDimensions.some((dimension) => dimensionRatings[dimension] === undefined)
    ) {
      throw new Error(
        'Provide a per-dimension rating for every selected dimension, or an overall rating.',
      );
    }

    const evidence: CapabilityEvidence[] = [];
    const createdAt = this.now();
    for (const dimension of input.selectedDimensions) {
      const individualRating = dimensionRatings[dimension];
      const stars = individualRating ?? input.overallRating;
      if (stars === undefined) continue;
      const isIndividual = individualRating !== undefined;
      evidence.push({
        id: this.newId(),
        teammateId: input.teammateId,
        runtimeProfileId: input.runtimeProfileId,
        missionId: input.missionId,
        runId: input.runId,
        dimension,
        sourceType: isIndividual ? 'USER_DIMENSION_RATING' : 'USER_OVERALL_RATING',
        ratingValue: ratingStarsToScore(stars),
        demandWeight: CAPABILITY_SCORING_POLICY.selectedDimensionDemandWeight,
        evidenceWeight: isIndividual
          ? CAPABILITY_SCORING_POLICY.dimensionEvidenceWeight
          : CAPABILITY_SCORING_POLICY.overallProjectionEvidenceWeight,
        createdAt,
      });
    }
    if (evidence.length === 0) throw new Error('The selected dimensions have no ratings.');
    this.store.appendCapabilityEvidenceBatch(evidence);
    this.rebuild(input.teammateId);
    return { evidence, skipped: false };
  }

  /** Rebuilds from benchmark/evidence facts; safe to call after Runtime migration. */
  rebuild(teammateId: string): TeammateCapabilityState[] {
    const teammate = this.store.getTeammate(teammateId);
    if (!teammate) throw new Error('Teammate does not exist.');
    if (teammate.executorKind !== 'MODEL_RUNTIME' || !teammate.currentRuntimeProfileId) {
      this.store.replaceTeammateCapabilityStates(teammateId, []);
      return [];
    }
    const runtimeProfileId = teammate.currentRuntimeProfileId;
    const modelAlias = this.store.getRuntimeModelAlias(runtimeProfileId);
    if (!modelAlias) {
      this.store.replaceTeammateCapabilityStates(teammateId, []);
      return [];
    }
    const benchmarks = this.store.listModelCapabilityBenchmarks(runtimeProfileId, modelAlias);
    const evidence = this.store.listCapabilityEvidence(teammateId);
    const states = CAPABILITY_DIMENSIONS.flatMap((dimension) => {
      const prior = this.resolver.resolve({
        benchmarks,
        runtimeProfileId,
        modelAlias,
        dimension,
      });
      const state = projectCapabilityScore({
        teammateId,
        dimension,
        currentRuntimeProfileId: runtimeProfileId,
        prior,
        evidence,
      });
      return state ? [state] : [];
    });
    this.store.replaceTeammateCapabilityStates(teammateId, states);
    return states;
  }

  /** Always rebuilds so a model/runtime change cannot leave a stale display projection. */
  profile(teammateId: string): R1CapabilityProfile {
    const teammate = this.store.getTeammate(teammateId);
    if (!teammate) throw new Error('Teammate does not exist.');
    const states = this.rebuild(teammateId);
    const runtimeProfileId = teammate.currentRuntimeProfileId;
    const stateByDimension = new Map(states.map((state) => [state.dimension, state]));
    const evidence = this.store.listCapabilityEvidence(teammateId);
    const effectivePriors = runtimeProfileId
      ? this.listEffectivePriors(runtimeProfileId)
      : CAPABILITY_DIMENSIONS.map((dimension) => ({ dimension, prior: null }));
    const priorByDimension = new Map(
      effectivePriors.map(({ dimension, prior }) => [dimension, prior]),
    );
    const dimensions = CAPABILITY_DIMENSIONS.map((dimension): R1CapabilityDimensionProfile => {
      const prior = priorByDimension.get(dimension) ?? null;
      const state = stateByDimension.get(dimension);
      const projection = runtimeProfileId
        ? calculateCapabilityScore({
            teammateId,
            dimension,
            currentRuntimeProfileId: runtimeProfileId,
            prior,
            evidence,
          })
        : null;
      return {
        dimension,
        prior,
        currentScore: state?.currentScore ?? null,
        ratingCount: state?.ratingCount ?? 0,
        evidenceWeight: state?.evidenceWeight ?? 0,
        weightedUserScore: projection?.weightedUserScore ?? null,
        priorStrength: CAPABILITY_SCORING_POLICY.priorStrength,
        transferWeight: CAPABILITY_SCORING_POLICY.transferWeight,
        alpha: projection?.alpha ?? 0,
        currentRuntimeProfileId: runtimeProfileId,
        scoringPolicyVersion: CAPABILITY_SCORING_POLICY.version,
        source: state
          ? state.ratingCount > 0
            ? 'BENCHMARK_PLUS_USER_EVIDENCE'
            : 'BENCHMARK_ONLY'
          : prior?.supported
            ? 'NO_BENCHMARK'
            : prior
              ? 'UNSUPPORTED'
              : 'NO_BENCHMARK',
      };
    });
    return {
      teammateId,
      currentRuntimeProfileId: runtimeProfileId,
      scoringPolicyVersion: CAPABILITY_SCORING_POLICY.version,
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

function validateSelectedDimensions(
  selected: readonly CapabilityDimension[],
  supported: readonly CapabilityDimension[],
): void {
  if (selected.length < 1 || selected.length > 3) {
    throw new Error('Select between one and three capability dimensions.');
  }
  if (new Set(selected).size !== selected.length) {
    throw new Error('Capability dimensions must not be repeated.');
  }
  if (selected.some((dimension) => !supported.includes(dimension))) {
    throw new Error('A selected dimension is not supported by this Runtime Benchmark.');
  }
}

function validateStars(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error('Rating must be an integer from 1 to 5.');
  }
}
