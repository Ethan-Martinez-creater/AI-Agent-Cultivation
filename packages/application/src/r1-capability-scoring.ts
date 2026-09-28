import type {
  CapabilityDimension,
  CapabilityEvidence,
  ModelCapabilityBenchmark,
  TeammateCapabilityState,
} from '@cultivation/domain';

/** Complete, stable display order for the R1 capability taxonomy. */
export const CAPABILITY_DIMENSIONS = [
  'GENERAL_REASONING',
  'LONG_CONTEXT_REASONING',
  'AGENTIC_EXECUTION',
  'CODING',
  'TOOL_USE',
  'VISUAL_UNDERSTANDING',
  'IMAGE_GENERATION',
  'IMAGE_EDITING',
  'VIDEO_GENERATION',
  'VIDEO_EDITING',
  'SPEECH_UNDERSTANDING',
  'SPEECH_GENERATION',
  'SPEECH_TO_SPEECH',
  'MUSIC_GENERATION',
] as const satisfies readonly CapabilityDimension[];

/** All R1 scoring knobs live here and are recorded on each derived state. */
export const CAPABILITY_SCORING_POLICY = Object.freeze({
  version: 'r1-progressive-v1',
  priorStrength: 8,
  transferWeight: 0.35,
  selectedDimensionDemandWeight: 1,
  dimensionEvidenceWeight: 1,
  overallProjectionEvidenceWeight: 0.4,
  starsToScore: Object.freeze({ 1: 0, 2: 25, 3: 50, 4: 75, 5: 100 }),
});

export interface CapabilityScoreProjection {
  currentScore: number;
  evidenceWeight: number;
  ratingCount: number;
  updatedAt: string;
  weightedUserScore: number | null;
  alpha: number;
}

/** Maps a user-visible 1–5 rating onto the fixed 0–100 capability scale. */
export function ratingStarsToScore(stars: number): number {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new Error('Rating must be an integer from 1 to 5.');
  }
  return CAPABILITY_SCORING_POLICY.starsToScore[
    stars as keyof typeof CAPABILITY_SCORING_POLICY.starsToScore
  ];
}

/**
 * Builds one capability projection from its selected supported Benchmark prior
 * and append-only user evidence. Missing or unsupported priors yield no state.
 */
export function projectCapabilityScore(input: {
  teammateId: string;
  dimension: CapabilityDimension;
  currentRuntimeProfileId: string;
  prior: ModelCapabilityBenchmark | null;
  evidence: readonly CapabilityEvidence[];
}): TeammateCapabilityState | null {
  const projection = calculateCapabilityScore(input);
  if (!projection) return null;

  return {
    teammateId: input.teammateId,
    dimension: input.dimension,
    currentScore: projection.currentScore,
    evidenceWeight: projection.evidenceWeight,
    ratingCount: projection.ratingCount,
    currentRuntimeProfileId: input.currentRuntimeProfileId,
    scoringPolicyVersion: CAPABILITY_SCORING_POLICY.version,
    updatedAt: projection.updatedAt,
  };
}

/** Calculates the persisted score and UI formula terms from durable facts. */
export function calculateCapabilityScore(input: {
  teammateId: string;
  dimension: CapabilityDimension;
  currentRuntimeProfileId: string;
  prior: ModelCapabilityBenchmark | null;
  evidence: readonly CapabilityEvidence[];
}): CapabilityScoreProjection | null {
  const { prior } = input;
  if (!prior?.supported || prior.normalizedScore === null) return null;
  if (
    prior.runtimeProfileId !== input.currentRuntimeProfileId ||
    prior.dimension !== input.dimension ||
    prior.modelAlias.length === 0
  ) {
    throw new Error('Benchmark prior does not match the current Runtime dimension.');
  }
  if (
    !Number.isFinite(prior.normalizedScore) ||
    prior.normalizedScore < 0 ||
    prior.normalizedScore > 100
  ) {
    throw new Error('Benchmark prior score must be between 0 and 100.');
  }
  if (!Number.isFinite(Date.parse(prior.createdAt))) {
    throw new Error('Benchmark creation date is invalid.');
  }

  let weightedScore = 0;
  let effectiveWeight = 0;
  let ratingCount = 0;
  const relevantEvidence = input.evidence.filter(
    (entry) =>
      entry.teammateId === input.teammateId &&
      entry.dimension === input.dimension &&
      entry.runtimeProfileId !== null,
  );

  for (const entry of relevantEvidence) {
    validateEvidence(entry);
    const transfer =
      entry.runtimeProfileId === input.currentRuntimeProfileId
        ? 1
        : CAPABILITY_SCORING_POLICY.transferWeight;
    const weight = entry.evidenceWeight * entry.demandWeight * transfer;
    if (weight <= 0) continue;
    effectiveWeight += weight;
    weightedScore += weight * entry.ratingValue;
    ratingCount += 1;
  }

  const weightedUserScore = effectiveWeight > 0 ? weightedScore / effectiveWeight : null;
  const alpha =
    effectiveWeight > 0
      ? effectiveWeight / (CAPABILITY_SCORING_POLICY.priorStrength + effectiveWeight)
      : 0;
  const currentScore = roundScore(
    (1 - alpha) * prior.normalizedScore + alpha * (weightedUserScore ?? prior.normalizedScore),
  );
  const updatedAt = maxTimestamp([prior.createdAt, ...relevantEvidence.map((e) => e.createdAt)]);

  return {
    currentScore,
    evidenceWeight: effectiveWeight,
    ratingCount,
    updatedAt,
    weightedUserScore,
    alpha,
  };
}

function validateEvidence(entry: CapabilityEvidence): void {
  if (!Number.isFinite(entry.ratingValue) || entry.ratingValue < 0 || entry.ratingValue > 100) {
    throw new Error('Capability evidence score must be between 0 and 100.');
  }
  if (
    !Number.isFinite(entry.demandWeight) ||
    entry.demandWeight <= 0 ||
    !Number.isFinite(entry.evidenceWeight) ||
    entry.evidenceWeight <= 0
  ) {
    throw new Error('Capability evidence weights must be positive finite numbers.');
  }
  if (!Number.isFinite(Date.parse(entry.createdAt))) {
    throw new Error('Capability evidence creation date is invalid.');
  }
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function maxTimestamp(values: readonly string[]): string {
  return [...values].sort((left, right) => {
    const leftDate = Date.parse(left);
    const rightDate = Date.parse(right);
    if (leftDate !== rightDate) return rightDate - leftDate;
    return right.localeCompare(left);
  })[0]!;
}
