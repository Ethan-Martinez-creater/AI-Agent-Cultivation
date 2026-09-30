import { describe, expect, it } from 'vitest';
import { RoutingEligibilityService } from '@cultivation/application';
import type { R1CapabilityProfile } from '@cultivation/application/r1-capability-service';
import type { DecisionCandidateInput } from '@cultivation/application/r3-decision-state';
import type { R1CapabilityService } from '@cultivation/application/r1-capability-service';
import { CAPABILITY_DIMENSIONS } from '@cultivation/application/r1-capability-scoring';
import type { CapabilityDimension, ModelCapabilityBenchmark } from '@cultivation/domain';
import type {
  Gate1SqliteRepository,
  Gate2SqliteRepository,
  Gate6SqliteRepository,
  TeammateRecord,
} from '@cultivation/persistence';
import {
  buildR3ShadowCandidates,
  type R3CandidateBindingEligibility,
} from './r3-candidate-context.js';

function benchmark(
  dimension: CapabilityDimension,
  overrides: Partial<ModelCapabilityBenchmark> = {},
): ModelCapabilityBenchmark {
  return {
    id: `benchmark-${dimension}`,
    runtimeProfileId: 'runtime-selected',
    modelAlias: 'fixed-model',
    dimension,
    supported: true,
    normalizedScore: 0,
    rawScore: 0,
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

function teammate(id: string, overrides: Partial<TeammateRecord> = {}): TeammateRecord {
  return {
    id,
    name: id,
    avatar: null,
    title: null,
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    status: 'ACTIVE',
    realm: 'QI_REFINING',
    currentRuntimeProfileId: `runtime-${id}`,
    executorKind: 'MODEL_RUNTIME',
    routingPolicy: 'NORMAL',
    systemKind: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function profile(teammateId: string): R1CapabilityProfile {
  const selectedModelBenchmark = benchmark('GENERAL_REASONING', {
    runtimeProfileId: `runtime-${teammateId}`,
    modelAlias: `model-${teammateId}`,
    normalizedScore: 0,
  });
  const unsupportedBenchmark = benchmark('CODING', {
    id: `unsupported-${teammateId}`,
    runtimeProfileId: `runtime-${teammateId}`,
    modelAlias: `model-${teammateId}`,
    supported: false,
    normalizedScore: null,
    rawScore: null,
  });
  return {
    teammateId,
    currentRuntimeProfileId: `runtime-${teammateId}`,
    scoringPolicyVersion: 'r1-benchmark-only-v1',
    dimensions: CAPABILITY_DIMENSIONS.map((dimension) => {
      const prior =
        dimension === 'GENERAL_REASONING'
          ? selectedModelBenchmark
          : dimension === 'CODING'
            ? unsupportedBenchmark
            : null;
      return {
        dimension,
        prior,
        currentScore: 99,
        ratingCount: 10,
        evidenceWeight: 10,
        weightedUserScore: 99,
        priorStrength: 8,
        transferWeight: 0.35,
        alpha: 0.5,
        currentRuntimeProfileId: `runtime-${teammateId}`,
        scoringPolicyVersion: 'legacy-dynamic-v1',
        source: 'BENCHMARK_PLUS_USER_EVIDENCE',
      };
    }),
  };
}

function stores(input: {
  teammates: TeammateRecord[];
  validBindings: ReadonlySet<string>;
  unavailable?: ReadonlySet<string>;
}): Parameters<typeof buildR3ShadowCandidates>[1] {
  const eligibility: R3CandidateBindingEligibility = new RoutingEligibilityService(
    {
      getTeammate: (id) => input.teammates.find((row) => row.id === id) ?? null,
      getModelBinding: (id) =>
        input.validBindings.has(id)
          ? {
              teammateId: id,
              runtimeProfileId: `runtime-${id}`,
              providerKind: 'OPENAI_COMPATIBLE',
              endpoint: 'http://localhost:1234/v1',
              modelId: 'fixed-model',
              credentialId: null,
              verifiedAt: null,
              verificationSource: 'LEGACY_STRUCTURAL',
              sealedAt: '2026-09-30T00:00:00Z',
            }
          : null,
      hasValidModelBinding: (id) => input.validBindings.has(id),
      getRuntimeProfile: (id) => ({
        id,
        name: id,
        providerId: 'provider',
        credentialId: null,
        modelId: 'fixed-model',
        parameters: {},
        capabilityOverrides: {},
        createdAt: '2026-09-30T00:00:00Z',
        updatedAt: '2026-09-30T00:00:00Z',
      }),
      getProvider: () => ({
        id: 'provider',
        name: 'fixture',
        kind: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://localhost:1234/v1',
        enabled: true,
        createdAt: '2026-09-30T00:00:00Z',
        updatedAt: '2026-09-30T00:00:00Z',
      }),
      getCredential: () => null,
    },
    {
      get: (id) => ({
        teammateId: id,
        runtimeProfileId: `runtime-${id}`,
        status: input.unavailable?.has(id) ? 'UNAVAILABLE' : 'UNKNOWN',
        lastCheckedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        recentOutcomes: [],
        policyVersion: 'r3-2-v1',
      }),
    },
  );
  return {
    teammates: {
      listTeammates: () => input.teammates,
    } as unknown as Gate1SqliteRepository,
    skills: {
      listSkills: () => [],
      listSkillAssignments: () => [],
    } as unknown as Gate2SqliteRepository,
    experiences: {
      listExperienceEvents: () => [],
    } as unknown as Gate6SqliteRepository,
    capabilities: {
      profile: (teammateId: string) => profile(teammateId),
    } as unknown as R1CapabilityService,
    eligibility,
  };
}

describe('R3 shadow candidate context', () => {
  it('excludes archived, fallback-only, bridge, unsealed, and structurally invalid candidates', () => {
    const candidates = buildR3ShadowCandidates(
      'selected',
      stores({
        teammates: [
          teammate('selected'),
          teammate('manual', { routingPolicy: 'MANUAL_ONLY' }),
          teammate('archived', { status: 'ARCHIVED' }),
          teammate('fallback-model', { routingPolicy: 'FALLBACK_ONLY' }),
          teammate('human-bridge', {
            executorKind: 'USER_BRIDGE',
            routingPolicy: 'FALLBACK_ONLY',
            systemKind: 'HUMAN_BRIDGE',
            currentRuntimeProfileId: null,
          }),
          teammate('misidentified-bridge', { systemKind: 'HUMAN_BRIDGE' }),
          teammate('unsealed'),
          teammate('invalid-provider'),
        ],
        validBindings: new Set([
          'selected',
          'manual',
          'archived',
          'fallback-model',
          'misidentified-bridge',
        ]),
      }),
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual(['selected']);
  });

  it('uses the current fixed model Benchmark score and preserves supported zero', () => {
    const candidates = buildR3ShadowCandidates(
      'selected',
      stores({
        teammates: [teammate('selected')],
        validBindings: new Set(['selected']),
      }),
    );
    const candidate = candidates[0] as DecisionCandidateInput;

    expect(candidate.capabilities.GENERAL_REASONING).toEqual({ status: 'SUPPORTED', score: 0 });
    expect(candidate.capabilities.CODING).toEqual({ status: 'UNSUPPORTED', score: null });
    expect(candidate.capabilities.AGENTIC_EXECUTION).toEqual({
      status: 'UNCONFIGURED',
      score: null,
    });
  });

  it('excludes UNAVAILABLE and reads UNKNOWN candidates without any probe surface', () => {
    const candidates = buildR3ShadowCandidates(
      'selected',
      stores({
        teammates: [teammate('selected'), teammate('unavailable'), teammate('unknown')],
        validBindings: new Set(['selected', 'unavailable', 'unknown']),
        unavailable: new Set(['unavailable']),
      }),
    );
    expect(candidates.map((row) => row.id)).toEqual(['selected', 'unknown']);
    expect(candidates.every((row) => row.modelAvailability === 'UNKNOWN')).toBe(true);
  });
});
