import type { CapabilityDimension, ExecutorKind, ProviderKind, RoutingPolicy } from './index.js';

export type ModelAvailabilityStatus = 'UNKNOWN' | 'AVAILABLE' | 'UNSTABLE' | 'UNAVAILABLE';
export type AvailabilityOutcomeKind = 'SUCCESS' | 'HARD_FAILURE' | 'TRANSIENT_FAILURE';

/** Safe, bounded observation; `code` is a stable enum-like identifier, never a provider message. */
export interface AvailabilityOutcome {
  kind: AvailabilityOutcomeKind;
  code: string;
  checkedAt: string;
}

/** The latest availability projection for one sealed teammate/runtime identity. */
export interface ModelAvailabilityProjection {
  teammateId: string;
  runtimeProfileId: string;
  status: ModelAvailabilityStatus;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Oldest-to-newest, capped by AVAILABILITY_POLICY_V1.recentOutcomeLimit. */
  recentOutcomes: AvailabilityOutcome[];
  policyVersion: string;
}

export interface AvailabilityPolicy {
  version: string;
  recentOutcomeLimit: number;
  recoverySuccesses: number;
  transientFailureThreshold: number;
}

/** R3.2 policy; thresholds live here so future tuning is reviewable and versioned. */
export const AVAILABILITY_POLICY_V1: Readonly<AvailabilityPolicy> = Object.freeze({
  version: 'r3-2-availability-v1',
  recentOutcomeLimit: 8,
  recoverySuccesses: 2,
  transientFailureThreshold: 3,
});

export type RoutingEligibilityReason =
  | 'ELIGIBLE'
  | 'TEAMMATE_NOT_FOUND'
  | 'TEAMMATE_INACTIVE'
  | 'NOT_MODEL_RUNTIME'
  | 'EXECUTION_PROTOCOL_UNSUPPORTED'
  | 'BINDING_MISSING'
  | 'BINDING_INVALID'
  | 'PROVIDER_INVALID'
  | 'PROVIDER_DISABLED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'MODEL_UNAVAILABLE'
  | 'FALLBACK_ONLY'
  | 'MANUAL_ONLY';

/**
 * Reusable last-known decision input. An UNSTABLE model remains eligible and
 * carries a qualitative penalty signal; this contract does not select a model.
 */
export interface RoutingEligibility {
  teammateId: string;
  eligible: boolean;
  candidateEligible: boolean;
  explicitEligible: boolean;
  reason: RoutingEligibilityReason;
  reasons: RoutingEligibilityReason[];
  availability: ModelAvailabilityStatus | null;
  stabilityPenalty: 'UNSTABLE' | null;
  executorKind: ExecutorKind | null;
  routingPolicy: RoutingPolicy | null;
  runtimeProfileId: string | null;
  providerKind: ProviderKind | null;
  unsupportedCapabilities: CapabilityDimension[];
}

/** Deterministic projection from one durable outcome and the prior bounded state. */
export function applyAvailabilityOutcome(
  previous: ModelAvailabilityProjection | null,
  input: {
    teammateId: string;
    runtimeProfileId: string;
    outcome: AvailabilityOutcome;
  },
  policy: AvailabilityPolicy = AVAILABILITY_POLICY_V1,
): ModelAvailabilityProjection {
  const outcome: AvailabilityOutcome = {
    kind: input.outcome.kind,
    code: safeOutcomeCode(input.outcome.code),
    checkedAt: input.outcome.checkedAt,
  };
  const sameIdentity =
    previous?.teammateId === input.teammateId &&
    previous.runtimeProfileId === input.runtimeProfileId;
  const prior = sameIdentity ? previous : null;
  const recentOutcomes = [...(prior?.recentOutcomes ?? []), outcome].slice(
    -policy.recentOutcomeLimit,
  );
  let status: ModelAvailabilityStatus;
  if (outcome.kind === 'HARD_FAILURE') {
    status = 'UNAVAILABLE';
  } else if (outcome.kind === 'TRANSIENT_FAILURE') {
    status =
      countTrailingFailures(recentOutcomes, 'TRANSIENT_FAILURE') >= policy.transientFailureThreshold
        ? 'UNAVAILABLE'
        : 'UNSTABLE';
  } else if (prior?.status === 'UNSTABLE' || prior?.status === 'UNAVAILABLE') {
    const consecutiveSuccesses = countTrailingSuccesses(recentOutcomes);
    status = consecutiveSuccesses >= policy.recoverySuccesses ? 'AVAILABLE' : prior.status;
  } else {
    status = 'AVAILABLE';
  }

  return {
    teammateId: input.teammateId,
    runtimeProfileId: input.runtimeProfileId,
    status,
    lastCheckedAt: outcome.checkedAt,
    lastSuccessAt: outcome.kind === 'SUCCESS' ? outcome.checkedAt : (prior?.lastSuccessAt ?? null),
    lastFailureAt: outcome.kind === 'SUCCESS' ? (prior?.lastFailureAt ?? null) : outcome.checkedAt,
    recentOutcomes,
    policyVersion: policy.version,
  };
}

function countTrailingFailures(
  outcomes: readonly AvailabilityOutcome[],
  kind: AvailabilityOutcomeKind,
): number {
  let count = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    if (outcomes[index]?.kind !== kind) break;
    count += 1;
  }
  return count;
}
function countTrailingSuccesses(outcomes: readonly AvailabilityOutcome[]): number {
  let count = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    if (outcomes[index]?.kind !== 'SUCCESS') break;
    count += 1;
  }
  return count;
}

function safeOutcomeCode(value: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'UNCLASSIFIED_FAILURE';
}
