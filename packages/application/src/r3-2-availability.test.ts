import { describe, expect, it, vi } from 'vitest';
import type {
  AvailabilityOutcome,
  CredentialSummary,
  ModelAvailabilityProjection,
  ProviderConfig,
  RuntimeProfile,
  Teammate,
  TeammateModelBinding,
} from '@cultivation/domain';
import { AVAILABILITY_POLICY_V1, applyAvailabilityOutcome } from '@cultivation/domain';
import type {
  AvailabilityIdentityStore,
  AvailabilityStore,
  EmbeddingRequest,
  MemoryCandidateRequest,
  ModelGateway,
  ModelRequest,
} from './index.js';
import {
  AvailabilityAwareModelGateway,
  AvailabilityService,
  ModelUnavailableError,
  RoutingEligibilityService,
} from './r3-2-availability.js';

const checkedAt = '2026-09-30T04:00:00.000Z';

function outcome(
  kind: AvailabilityOutcome['kind'],
  code: string = kind,
  minute = 0,
): AvailabilityOutcome {
  return {
    kind,
    code,
    checkedAt: `2026-09-30T04:${String(minute).padStart(2, '0')}:00.000Z`,
  };
}

function projection(
  status: ModelAvailabilityProjection['status'],
  outcomes: AvailabilityOutcome[] = [],
): ModelAvailabilityProjection {
  return {
    teammateId: 'teammate-a',
    runtimeProfileId: 'runtime-a',
    status,
    lastCheckedAt: outcomes.at(-1)?.checkedAt ?? null,
    lastSuccessAt:
      [...outcomes].reverse().find((entry) => entry.kind === 'SUCCESS')?.checkedAt ?? null,
    lastFailureAt:
      [...outcomes].reverse().find((entry) => entry.kind !== 'SUCCESS')?.checkedAt ?? null,
    recentOutcomes: outcomes,
    policyVersion: AVAILABILITY_POLICY_V1.version,
  };
}

function modelTeammate(overrides: Partial<Teammate> = {}): Teammate {
  return {
    id: 'teammate-a',
    name: 'A',
    avatar: null,
    title: 'analyst',
    description: '',
    identityPrompt: '',
    behaviorPrompt: '',
    executorKind: 'MODEL_RUNTIME',
    routingPolicy: 'NORMAL',
    systemKind: null,
    status: 'ACTIVE',
    realm: 'QI_REFINING',
    currentRuntimeProfileId: 'runtime-a',
    createdAt: checkedAt,
    updatedAt: checkedAt,
    ...overrides,
  };
}

function runtime(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'runtime-a',
    name: 'Runtime A',
    providerId: 'provider-a',
    credentialId: 'credential-a',
    modelId: 'model-a',
    parameters: {},
    capabilityOverrides: {},
    createdAt: checkedAt,
    updatedAt: checkedAt,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-a',
    name: 'Provider A',
    kind: 'OPENAI',
    baseUrl: null,
    enabled: true,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    ...overrides,
  };
}

function binding(overrides: Partial<TeammateModelBinding> = {}): TeammateModelBinding {
  return {
    teammateId: 'teammate-a',
    runtimeProfileId: 'runtime-a',
    providerKind: 'OPENAI',
    endpoint: null,
    modelId: 'model-a',
    credentialId: 'credential-a',
    verifiedAt: checkedAt,
    verificationSource: 'LIVE_TEST',
    sealedAt: checkedAt,
    ...overrides,
  };
}

function fixture(
  options: {
    probe?: (
      runtimeProfileId: string,
    ) => Promise<{ kind: AvailabilityOutcome['kind']; code: string }>;
  } = {},
) {
  let teammate = modelTeammate();
  let currentRuntime = runtime();
  let currentProvider = provider();
  let credential: CredentialSummary | null = {
    id: 'credential-a',
    providerId: 'provider-a',
    label: 'key',
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  let modelBinding: TeammateModelBinding | null = binding();
  let stored: ModelAvailabilityProjection | null = null;
  const identity: AvailabilityIdentityStore = {
    getTeammate: (id) => (id === teammate.id ? teammate : null),
    getModelBinding: (id) => (id === teammate.id ? modelBinding : null),
    getRuntimeProfile: (id) => (id === currentRuntime.id ? currentRuntime : null),
    getProvider: (id) => (id === currentProvider.id ? currentProvider : null),
    getCredential: (id) => (id === credential?.id ? credential : null),
    hasValidModelBinding: (id) =>
      id === teammate.id &&
      modelBinding !== null &&
      modelBinding.runtimeProfileId === teammate.currentRuntimeProfileId &&
      modelBinding.providerKind === currentProvider.kind &&
      modelBinding.endpoint === currentProvider.baseUrl &&
      modelBinding.modelId === currentRuntime.modelId &&
      modelBinding.credentialId === currentRuntime.credentialId,
  };
  const store: AvailabilityStore = {
    getAvailability: (id) => (id === teammate.id ? stored : null),
    saveAvailability: (value) => {
      stored = structuredClone(value);
    },
  };
  let probeCount = 0;
  const probe = {
    probe: async (id: string) => {
      probeCount += 1;
      if (id !== currentRuntime.id) throw new Error('unexpected runtime');
      return options.probe ? options.probe(id) : { kind: 'SUCCESS' as const, code: 'PROBE_OK' };
    },
  };
  let nowIndex = 0;
  const service = new AvailabilityService(store, identity, probe, {
    now: () => `2026-09-30T04:${String(nowIndex++).padStart(2, '0')}:00.000Z`,
  });
  return {
    service,
    identity,
    store,
    get teammate() {
      return teammate;
    },
    set teammate(value: Teammate) {
      teammate = value;
    },
    get currentRuntime() {
      return currentRuntime;
    },
    set currentRuntime(value: RuntimeProfile) {
      currentRuntime = value;
    },
    get currentProvider() {
      return currentProvider;
    },
    set currentProvider(value: ProviderConfig) {
      currentProvider = value;
    },
    get credential() {
      return credential;
    },
    set credential(value: CredentialSummary | null) {
      credential = value;
    },
    get modelBinding() {
      return modelBinding;
    },
    set modelBinding(value: TeammateModelBinding | null) {
      modelBinding = value;
    },
    get stored() {
      return stored;
    },
    set stored(value: ModelAvailabilityProjection | null) {
      stored = value;
    },
    get probeCount() {
      return probeCount;
    },
  };
}

function basicRequest(): ModelRequest {
  return {
    teammateId: 'teammate-a',
    runtimeProfileId: 'runtime-a',
    messages: [{ role: 'user', content: 'hello' }],
  };
}

function usage() {
  return { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null };
}

describe('R3.2 availability policy', () => {
  it('starts UNKNOWN, records ordinary success as AVAILABLE, and keeps only bounded recent outcomes', () => {
    const unknown = projection('UNKNOWN');
    expect(unknown.lastCheckedAt).toBeNull();
    let current = unknown;
    for (let index = 0; index < 10; index += 1) {
      current = applyAvailabilityOutcome(current, {
        teammateId: 'teammate-a',
        runtimeProfileId: 'runtime-a',
        outcome: outcome('SUCCESS', 'OK', index),
      });
    }
    expect(current.status).toBe('AVAILABLE');
    expect(current.recentOutcomes).toHaveLength(AVAILABILITY_POLICY_V1.recentOutcomeLimit);
    expect(current.lastSuccessAt).toBe(outcome('SUCCESS', 'OK', 9).checkedAt);
    expect(current.policyVersion).toBe(AVAILABILITY_POLICY_V1.version);
  });

  it('marks explicit hard failure unavailable and transient failures unstable then unavailable at policy threshold', () => {
    const hard = applyAvailabilityOutcome(null, {
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
      outcome: outcome('HARD_FAILURE', 'AUTHENTICATION_FAILED'),
    });
    expect(hard.status).toBe('UNAVAILABLE');
    let transient = projection('AVAILABLE');
    for (let index = 0; index < AVAILABILITY_POLICY_V1.transientFailureThreshold - 1; index += 1) {
      transient = applyAvailabilityOutcome(transient, {
        teammateId: 'teammate-a',
        runtimeProfileId: 'runtime-a',
        outcome: outcome('TRANSIENT_FAILURE', 'HTTP_5XX', index),
      });
    }
    expect(transient.status).toBe('UNSTABLE');
    transient = applyAvailabilityOutcome(transient, {
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
      outcome: outcome('TRANSIENT_FAILURE', 'TIMEOUT', 3),
    });
    expect(transient.status).toBe('UNAVAILABLE');
  });

  it('keeps mixed transient and success outcomes unstable until consecutive recovery completes', () => {
    let current = applyAvailabilityOutcome(projection('UNKNOWN'), {
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
      outcome: outcome('TRANSIENT_FAILURE', 'TIMEOUT'),
    });
    expect(current.status).toBe('UNSTABLE');
    current = applyAvailabilityOutcome(current, {
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
      outcome: outcome('SUCCESS', 'OK', 1),
    });
    expect(current.status).toBe('UNSTABLE');
    current = applyAvailabilityOutcome(current, {
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
      outcome: outcome('SUCCESS', 'OK', 2),
    });
    expect(current.status).toBe('AVAILABLE');
  });

  it('does not leak provider messages into durable outcome codes', () => {
    const current = applyAvailabilityOutcome(null, {
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
      outcome: outcome('TRANSIENT_FAILURE', 'token=secret-provider-message'),
    });
    expect(current.recentOutcomes[0]?.code).toBe('UNCLASSIFIED_FAILURE');
  });
});

describe('AvailabilityService and shared eligibility', () => {
  it('rejects archived recheck without probing or changing the historical availability projection', async () => {
    const context = fixture();
    await context.service.recheck('teammate-a');
    const before = structuredClone(context.stored);
    const calls = context.probeCount;
    context.teammate = { ...context.teammate, status: 'ARCHIVED' };
    await expect(context.service.recheck('teammate-a')).rejects.toThrow('已归档');
    expect(context.probeCount).toBe(calls);
    expect(context.stored).toEqual(before);
  });
  it('discards a manual probe result if the teammate was archived while the probe was pending', async () => {
    let finish!: (result: { kind: 'HARD_FAILURE'; code: string }) => void;
    const context = fixture({
      probe: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    context.stored = projection('AVAILABLE', [outcome('SUCCESS')]);
    const before = structuredClone(context.stored);
    const pending = context.service.recheck('teammate-a');
    await Promise.resolve();
    context.teammate = { ...context.teammate, status: 'ARCHIVED' };
    finish({ kind: 'HARD_FAILURE', code: 'PROBE_FAILED' });
    await pending;
    expect(context.stored).toEqual(before);
  });
  it('probes UNKNOWN on use and returns a typed unavailable result without changing the selected teammate', async () => {
    const fixtureUnavailable = fixture({
      probe: async () => ({ kind: 'HARD_FAILURE', code: 'MODEL_NOT_FOUND' }),
    });
    expect(fixtureUnavailable.service.get('teammate-a')?.status).toBe('UNKNOWN');
    const result = await fixtureUnavailable.service.prepare({
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'MODEL_UNAVAILABLE',
      teammateId: 'teammate-a',
    });
    if (result.ok) throw new Error('expected unavailable result');
    expect(result.actions).toEqual(['RECHECK', 'SELECT_OTHER', 'CANCEL']);
    expect(fixtureUnavailable.teammate.id).toBe('teammate-a');
    expect(fixtureUnavailable.service.get('teammate-a')?.status).toBe('UNAVAILABLE');
  });

  it('deduplicates concurrent UNKNOWN probes', async () => {
    let release!: (value: { kind: 'SUCCESS'; code: string }) => void;
    const fixtureProbe = fixture({ probe: () => new Promise((resolve) => (release = resolve)) });
    const first = fixtureProbe.service.prepare({
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
    });
    const second = fixtureProbe.service.prepare({
      teammateId: 'teammate-a',
      runtimeProfileId: 'runtime-a',
    });
    await vi.waitFor(() => expect(fixtureProbe.probeCount).toBe(1));
    release({ kind: 'SUCCESS', code: 'PROBE_OK' });
    const [left, right] = await Promise.all([first, second]);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    expect(fixtureProbe.probeCount).toBe(1);
  });

  it('discards a probe result after the bound credential revision rotates', async () => {
    let release!: (value: { kind: 'SUCCESS'; code: string }) => void;
    const fixtureProbe = fixture({ probe: () => new Promise((resolve) => (release = resolve)) });
    const recheck = fixtureProbe.service.recheck('teammate-a');
    await vi.waitFor(() => expect(fixtureProbe.probeCount).toBe(1));
    const oldRevision = fixtureProbe.service.identityRevision('teammate-a', 'runtime-a');
    fixtureProbe.credential = {
      ...fixtureProbe.credential!,
      updatedAt: '2026-09-30T05:00:00.000Z',
    };
    fixtureProbe.stored = projection('UNKNOWN');
    release({ kind: 'SUCCESS', code: 'PROBE_OK' });
    await recheck;
    expect(fixtureProbe.service.identityRevision('teammate-a', 'runtime-a')).not.toBe(oldRevision);
    expect(fixtureProbe.service.get('teammate-a')?.status).toBe('UNKNOWN');
  });

  it('returns no model availability for Human Bridge', async () => {
    const fixtureBridge = fixture();
    fixtureBridge.teammate = modelTeammate({
      executorKind: 'USER_BRIDGE',
      routingPolicy: 'FALLBACK_ONLY',
      systemKind: 'HUMAN_BRIDGE',
      currentRuntimeProfileId: null,
    });
    expect(fixtureBridge.service.get('teammate-a')).toBeNull();
    await expect(fixtureBridge.service.recheck('teammate-a')).rejects.toThrow('模型执行身份');
  });

  it('eligibility excludes disabled/unavailable/invalid and fallback candidates without probing', async () => {
    const state = fixture();
    const eligibility = new RoutingEligibilityService(
      state.identity,
      state.service,
      (_id, dimension) => dimension === 'CODING',
    );
    expect(eligibility.evaluate('teammate-a')).toMatchObject({
      eligible: true,
      availability: 'UNKNOWN',
    });
    expect(
      eligibility.evaluate('teammate-a', { requiredCapabilities: ['TOOL_USE'] }),
    ).toMatchObject({
      eligible: false,
      reasons: ['CAPABILITY_UNSUPPORTED'],
    });
    state.teammate = modelTeammate({ routingPolicy: 'MANUAL_ONLY' });
    expect(eligibility.evaluate('teammate-a')).toMatchObject({
      eligible: false,
      reason: 'MANUAL_ONLY',
    });
    expect(eligibility.evaluate('teammate-a', { explicit: true })).toMatchObject({
      eligible: true,
      explicitEligible: true,
    });
    state.teammate = modelTeammate({ routingPolicy: 'FALLBACK_ONLY' });
    expect(eligibility.evaluate('teammate-a')).toMatchObject({
      eligible: false,
      reason: 'FALLBACK_ONLY',
    });
    state.currentProvider = provider({ enabled: false });
    expect(eligibility.evaluate('teammate-a')).toMatchObject({
      eligible: false,
      reason: 'PROVIDER_DISABLED',
    });
    expect(state.probeCount).toBe(0);
    state.currentProvider = provider();
    state.stored = projection('UNAVAILABLE', [outcome('HARD_FAILURE', 'MODEL_NOT_FOUND')]);
    expect(eligibility.evaluate('teammate-a')).toMatchObject({
      eligible: false,
      reason: 'MODEL_UNAVAILABLE',
    });
    expect(state.probeCount).toBe(0);
    await expect(
      state.service.prepare({ teammateId: 'teammate-a', runtimeProfileId: 'runtime-a' }),
    ).resolves.toMatchObject({ ok: false, code: 'MODEL_UNAVAILABLE' });
  });

  it('allows keyless OpenAI-compatible runtimes only when endpoint identity is sealed and valid', () => {
    const state = fixture();
    state.currentProvider = provider({
      kind: 'OPENAI_COMPATIBLE',
      baseUrl: 'http://localhost:9900/v1',
    });
    state.currentRuntime = runtime({ credentialId: null });
    state.credential = null;
    state.modelBinding = binding({
      providerKind: 'OPENAI_COMPATIBLE',
      endpoint: 'http://localhost:9900/v1',
      credentialId: null,
    });
    const eligibility = new RoutingEligibilityService(state.identity, state.service);
    expect(eligibility.evaluate('teammate-a').eligible).toBe(true);
  });
});

describe('AvailabilityAwareModelGateway', () => {
  it('wraps every available model surface and preserves absent optional methods', async () => {
    const state = fixture();
    const calls: string[] = [];
    const raw: ModelGateway & {
      extractCandidates: (
        request: MemoryCandidateRequest,
      ) => Promise<{ candidates: []; usage: ReturnType<typeof usage> }>;
      embed: (
        request: EmbeddingRequest,
      ) => Promise<{ vector: number[]; usage: ReturnType<typeof usage> }>;
    } = {
      generate: async (request) => {
        expect(request.onCallStarted).toBeUndefined();
        calls.push('generate');
        return { text: 'answer', usage: usage() };
      },
      generateWithTools: async () => {
        calls.push('generateWithTools');
        return { text: 'tools', toolCalls: [], usage: usage() };
      },
      proposeCollaboration: async () => {
        calls.push('proposeCollaboration');
        return {
          proposal: {
            targetTeammateId: 'target',
            reason: 'reason',
            task: 'task',
            expectedBenefit: 'benefit',
          },
          usage: usage(),
        };
      },
      stream: async function* () {
        calls.push('stream');
        yield { type: 'text-delta', text: 'stream' };
        yield { type: 'finish', usage: usage() };
      },
      testConnection: async () => ({ ok: true, message: 'ok' }),
      extractCandidates: async () => {
        calls.push('extractCandidates');
        return { candidates: [], usage: usage() };
      },
      embed: async (request) => {
        calls.push(`embed:${request.runtimeProfileId}`);
        return { vector: [1], usage: usage() };
      },
    };
    const gateway = new AvailabilityAwareModelGateway(raw, state.service);
    expect(gateway.generateWithTools).toBeTypeOf('function');
    expect(gateway.proposeCollaboration).toBeTypeOf('function');
    expect(gateway.extractCandidates).toBeTypeOf('function');
    expect(gateway.embed).toBeTypeOf('function');
    const request = basicRequest();
    await gateway.generate({
      ...request,
      onCallStarted: () => {
        calls.push('call-started');
      },
    });
    await gateway.generateWithTools?.({ ...request, tools: [] });
    await gateway.proposeCollaboration?.({
      runtimeProfileId: 'runtime-a',
      teammateId: 'teammate-a',
      mode: 'CONSULTATION',
      objective: 'objective',
      eligibleTargetIds: ['target'],
      publicDraft: null,
      systemContext: 'context',
    });
    for await (const _event of gateway.stream(request)) void _event;
    await gateway.extractCandidates?.({
      runtimeProfileId: 'runtime-a',
      teammateId: 'teammate-a',
      evidence: 'evidence',
    });
    await gateway.embed?.({
      runtimeProfileId: 'runtime-a',
      teammateId: 'teammate-a',
      text: 'text',
    });
    await gateway.embed?.({
      runtimeProfileId: 'embedding-runtime',
      teammateId: 'teammate-a',
      text: 'text',
    });
    expect(calls).toEqual([
      'call-started',
      'generate',
      'generateWithTools',
      'proposeCollaboration',
      'stream',
      'extractCandidates',
      'embed:runtime-a',
      'embed:embedding-runtime',
    ]);
    expect(state.probeCount).toBe(1);
    expect(state.service.get('teammate-a')?.status).toBe('AVAILABLE');

    const minimal: ModelGateway = {
      generate: async () => ({ text: '', usage: usage() }),
      stream: async function* () {},
      testConnection: async () => ({ ok: true, message: 'ok' }),
    };
    const minimalWrapper = new AvailabilityAwareModelGateway(minimal, state.service);
    expect(minimalWrapper.generateWithTools).toBeUndefined();
    expect(minimalWrapper.proposeCollaboration).toBeUndefined();
    expect(minimalWrapper.extractCandidates).toBeUndefined();
    expect(minimalWrapper.embed).toBeUndefined();
  });

  it('does not write call-start evidence or invoke the provider when availability blocks the send', async () => {
    const state = fixture({
      probe: async () => ({ kind: 'HARD_FAILURE', code: 'PROVIDER_DISABLED' }),
    });
    const onCallStarted = vi.fn();
    const generate = vi.fn(async () => ({ text: 'should not run', usage: usage() }));
    const gateway = new AvailabilityAwareModelGateway(
      {
        generate,
        stream: async function* () {},
        testConnection: async () => ({ ok: true, message: 'ok' }),
      },
      state.service,
    );
    await expect(gateway.generate({ ...basicRequest(), onCallStarted })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(onCallStarted).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
  it('updates hard and transient call failures while preserving the original error', async () => {
    const state = fixture();
    const gateway = new AvailabilityAwareModelGateway(
      {
        generate: async () => {
          const error = new Error('provider secret details') as Error & {
            availabilityKind: 'HARD_FAILURE';
            availabilityCode: string;
          };
          error.availabilityKind = 'HARD_FAILURE';
          error.availabilityCode = 'AUTHENTICATION_FAILED';
          throw error;
        },
        stream: async function* () {},
        testConnection: async () => ({ ok: false, message: 'failed' }),
      },
      state.service,
    );
    await expect(gateway.generate(basicRequest())).rejects.toThrow('provider secret details');
    expect(state.service.get('teammate-a')?.status).toBe('UNAVAILABLE');
    expect(state.service.get('teammate-a')?.recentOutcomes.map(({ code }) => code)).not.toContain(
      'provider secret details',
    );
  });

  it('does not bypass availability for a bound embedding when its provider is disabled', async () => {
    const state = fixture();
    state.currentProvider = { ...state.currentProvider, enabled: false };
    let calls = 0;
    const gateway = new AvailabilityAwareModelGateway(
      {
        generate: async () => ({ text: 'unused', usage: usage() }),
        stream: async function* () {},
        testConnection: async () => ({ ok: true, message: 'unused' }),
        embed: async () => {
          calls += 1;
          return { vector: [1], usage: usage() };
        },
      },
      state.service,
    );
    await expect(
      gateway.embed!({ teammateId: 'teammate-a', runtimeProfileId: 'runtime-a', text: 'data' }),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(calls).toBe(0);
    expect(state.service.get('teammate-a')?.status).toBe('UNAVAILABLE');
  });

  it('records an in-flight result after archive while refusing new requests', async () => {
    const state = fixture();
    const gateway = new AvailabilityAwareModelGateway(
      {
        generate: async () => {
          state.teammate = { ...state.teammate, status: 'ARCHIVED' };
          return { text: 'completed request', usage: usage() };
        },
        stream: async function* () {},
        testConnection: async () => ({ ok: true, message: 'unused' }),
      },
      state.service,
    );
    await expect(gateway.generate(basicRequest())).resolves.toMatchObject({
      text: 'completed request',
    });
    expect(state.service.get('teammate-a')?.recentOutcomes.at(-1)?.code).toBe('REQUEST_SUCCEEDED');
    await expect(gateway.generate(basicRequest())).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    });
  });
});
