import type {
  AvailabilityOutcomeKind,
  CapabilityDimension,
  CredentialSummary,
  ExecutionProtocol,
  ModelAvailabilityProjection,
  ModelAvailabilityStatus,
  ProviderConfig,
  RuntimeProfile,
  RoutingEligibility,
  Teammate,
  TeammateModelBinding,
} from '@cultivation/domain';
import { AVAILABILITY_POLICY_V1, applyAvailabilityOutcome } from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type {
  EmbeddingGateway,
  MemoryCandidateExtractor,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from './index.js';

export interface ModelAvailabilityProbe {
  probe(runtimeProfileId: string): Promise<{ kind: AvailabilityOutcomeKind; code: string }>;
}

export interface AvailabilityStore {
  getAvailability(teammateId: string): ModelAvailabilityProjection | null;
  saveAvailability(value: ModelAvailabilityProjection): void | Promise<void>;
}

/** Main-process read port. Credential values/ciphertext are never part of this contract. */
export interface AvailabilityIdentityStore {
  getTeammate(id: string): Teammate | null;
  getModelBinding(teammateId: string): TeammateModelBinding | null;
  getRuntimeProfile(id: string): RuntimeProfile | null;
  getProvider(id: string): ProviderConfig | null;
  getCredential(id: string): CredentialSummary | null;
  hasValidModelBinding(teammateId: string): boolean;
}

export interface AvailabilityServiceOptions {
  now?: () => string;
  onChanged?: (projection: ModelAvailabilityProjection) => void;
  /** Defaults to LANGUAGE to preserve existing R3.2 behavior. */
  executionProtocol?: ExecutionProtocol;
}

export interface PrepareModelResult {
  ok: true;
  availability: ModelAvailabilityProjection;
}

export interface ModelUnavailableResult {
  ok: false;
  code: 'MODEL_UNAVAILABLE';
  teammateId: string;
  runtimeProfileId: string;
  availability: ModelAvailabilityProjection;
  actions: ['RECHECK', 'SELECT_OTHER', 'CANCEL'];
}

export type PrepareModelOutcome = PrepareModelResult | ModelUnavailableResult;

/** Typed, secret-free failure for an explicitly selected unavailable model. */
export class ModelUnavailableError extends DomainError {
  readonly name = 'ModelUnavailableError';

  constructor(readonly result: ModelUnavailableResult) {
    super('MODEL_UNAVAILABLE', '所选道友当前无法调用该模型', { ...result });
  }
}

/** Stores only bounded, deterministic observations for the sealed model identity. */
export class AvailabilityService {
  private readonly now: () => string;
  private readonly onChanged?: (projection: ModelAvailabilityProjection) => void;
  private readonly executionProtocol: ExecutionProtocol;
  private readonly inFlightProbes = new Map<string, Promise<ModelAvailabilityProjection>>();

  constructor(
    private readonly store: AvailabilityStore,
    private readonly identities: AvailabilityIdentityStore,
    private readonly probe: ModelAvailabilityProbe,
    options: AvailabilityServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onChanged = options.onChanged;
    this.executionProtocol = options.executionProtocol ?? 'LANGUAGE';
  }

  /** Returns null for Human Bridge or an identity without a model binding. */
  get(teammateId: string): ModelAvailabilityProjection | null {
    const teammate = this.identities.getTeammate(teammateId);
    if (
      !teammate ||
      teammate.executorKind !== 'MODEL_RUNTIME' ||
      !teammate.currentRuntimeProfileId
    ) {
      return null;
    }
    const binding = this.identities.getModelBinding(teammateId);
    if (!binding || binding.runtimeProfileId !== teammate.currentRuntimeProfileId) return null;
    const stored = this.store.getAvailability(teammateId);
    if (
      stored &&
      stored.teammateId === teammateId &&
      stored.runtimeProfileId === binding.runtimeProfileId
    ) {
      return cloneProjection(stored);
    }
    return unknownProjection(teammateId, binding.runtimeProfileId);
  }

  /** Manual recheck. Concurrent checks for one Teammate share a single probe. */
  recheck(teammateId: string): Promise<ModelAvailabilityProjection> {
    const inFlight = this.inFlightProbes.get(teammateId);
    if (inFlight) return inFlight;
    const operation = Promise.resolve()
      .then(() => this.recheckOnce(teammateId))
      .finally(() => {
        if (this.inFlightProbes.get(teammateId) === operation) {
          this.inFlightProbes.delete(teammateId);
        }
      });
    this.inFlightProbes.set(teammateId, operation);
    return operation;
  }

  /** Called before a real model send. UNKNOWN probes once; UNAVAILABLE is not silently rerouted. */
  async prepare(input: {
    teammateId: string;
    runtimeProfileId: string;
    /** R4 checks only a shortlisted executor, never every candidate. */
    freshProbe?: boolean;
  }): Promise<PrepareModelOutcome> {
    const identity = this.inspectIdentity(input.teammateId, input.runtimeProfileId);
    if (identity.reason === 'EXECUTION_PROTOCOL_UNSUPPORTED') {
      throw new DomainError(
        'EXECUTION_PROTOCOL_UNSUPPORTED',
        '生成型道友必须通过生成任务执行，不能使用语言模型可用性探测',
      );
    }
    let availability = this.get(input.teammateId);
    if (!availability) availability = unknownProjection(input.teammateId, input.runtimeProfileId);
    if (identity.reason) {
      if (identity.binding && ['PROVIDER_DISABLED', 'PROVIDER_INVALID'].includes(identity.reason)) {
        availability = await this.recordOutcome({
          teammateId: input.teammateId,
          runtimeProfileId: input.runtimeProfileId,
          kind: 'HARD_FAILURE',
          code: identity.reason,
        });
      }
      return unavailable(input.teammateId, input.runtimeProfileId, availability);
    }
    if (
      availability.status === 'UNKNOWN' ||
      (input.freshProbe && availability.status !== 'UNAVAILABLE')
    )
      availability = await this.recheck(input.teammateId);
    const refreshed = this.inspectIdentity(input.teammateId, input.runtimeProfileId);
    availability = this.get(input.teammateId) ?? availability;
    if (refreshed.reason) {
      if (
        refreshed.binding &&
        ['PROVIDER_DISABLED', 'PROVIDER_INVALID'].includes(refreshed.reason)
      ) {
        availability = await this.recordOutcome({
          teammateId: input.teammateId,
          runtimeProfileId: input.runtimeProfileId,
          kind: 'HARD_FAILURE',
          code: refreshed.reason,
        });
      }
      return unavailable(input.teammateId, input.runtimeProfileId, availability);
    }
    if (availability.status === 'UNKNOWN' || availability.status === 'UNAVAILABLE') {
      return unavailable(input.teammateId, input.runtimeProfileId, availability);
    }
    return { ok: true, availability };
  }

  /** Records a real request result, discarding outcomes from an older credential revision. */
  async recordOutcome(input: {
    teammateId: string;
    runtimeProfileId: string;
    kind: AvailabilityOutcomeKind;
    code: string;
    identityRevision?: string | null;
  }): Promise<ModelAvailabilityProjection> {
    const identity = this.inspectIdentity(input.teammateId, input.runtimeProfileId, true);
    if (
      !identity.binding ||
      identity.reason === 'RUNTIME_MISMATCH' ||
      identity.reason === 'EXECUTION_PROTOCOL_UNSUPPORTED'
    ) {
      throw new DomainError('INVALID_MODEL_IDENTITY', '道友模型绑定已变化，无法记录可用性结果');
    }
    if (
      input.identityRevision !== undefined &&
      input.identityRevision !== this.identityRevision(input.teammateId, input.runtimeProfileId)
    ) {
      return (
        this.get(input.teammateId) ?? unknownProjection(input.teammateId, input.runtimeProfileId)
      );
    }
    if (identity.reason === 'PROVIDER_DISABLED' || identity.reason === 'PROVIDER_INVALID') {
      input = { ...input, kind: 'HARD_FAILURE', code: identity.reason };
    }
    const previous = this.store.getAvailability(input.teammateId);
    const projection = applyAvailabilityOutcome(
      previous,
      {
        teammateId: input.teammateId,
        runtimeProfileId: input.runtimeProfileId,
        outcome: { kind: input.kind, code: input.code, checkedAt: this.now() },
      },
      AVAILABILITY_POLICY_V1,
    );
    await this.store.saveAvailability(projection);
    try {
      this.onChanged?.(cloneProjection(projection));
    } catch {
      // Observers cannot change the persisted model-call outcome.
    }
    return projection;
  }

  /** A stable fingerprint that changes when Runtime, Provider, binding, or Credential changes. */
  identityRevision(teammateId: string, runtimeProfileId: string): string | null {
    const teammate = this.identities.getTeammate(teammateId);
    const binding = this.identities.getModelBinding(teammateId);
    const runtime = this.identities.getRuntimeProfile(runtimeProfileId);
    const provider = runtime ? this.identities.getProvider(runtime.providerId) : null;
    const credential = runtime?.credentialId
      ? this.identities.getCredential(runtime.credentialId)
      : null;
    if (
      !teammate ||
      !binding ||
      !runtime ||
      !provider ||
      binding.runtimeProfileId !== runtimeProfileId
    ) {
      return null;
    }
    return JSON.stringify({
      teammateId,
      executorKind: teammate.executorKind,
      teammateRuntime: teammate.currentRuntimeProfileId,
      bindingRuntime: binding.runtimeProfileId,
      bindingProvider: binding.providerKind,
      bindingEndpoint: binding.endpoint,
      bindingAdapter:
        (binding as TeammateModelBinding & { adapterId?: string | null }).adapterId ?? null,
      bindingModel: binding.modelId,
      bindingCredential: binding.credentialId,
      bindingSealedAt: binding.sealedAt,
      runtimeUpdatedAt: runtime.updatedAt,
      providerId: provider.id,
      providerKind: provider.kind,
      providerEndpoint: provider.baseUrl,
      providerAdapter:
        (provider as ProviderConfig & { adapterId?: string | null }).adapterId ?? null,
      providerEnabled: provider.enabled,
      providerUpdatedAt: provider.updatedAt,
      credentialId: credential?.id ?? null,
      credentialProviderId: credential?.providerId ?? null,
      credentialUpdatedAt: credential?.updatedAt ?? null,
    });
  }

  /** Whether this Teammate's fixed sealed binding owns this Runtime. */
  ownsRuntime(teammateId: string, runtimeProfileId: string): boolean {
    const teammate = this.identities.getTeammate(teammateId);
    const binding = this.identities.getModelBinding(teammateId);
    return !!(
      teammate?.executorKind === 'MODEL_RUNTIME' &&
      teammate.currentRuntimeProfileId === runtimeProfileId &&
      binding?.runtimeProfileId === runtimeProfileId &&
      (binding.executionProtocol ?? 'LANGUAGE') === this.executionProtocol &&
      (this.identities.getRuntimeProfile(runtimeProfileId)?.executionProtocol ?? 'LANGUAGE') ===
        this.executionProtocol &&
      ((this.executionProtocol !== 'GENERATION' ||
        ((binding as TeammateModelBinding & { adapterId?: string | null }).adapterId ?? null) ===
          (
            this.identities.getProvider(
              this.identities.getRuntimeProfile(runtimeProfileId)?.providerId ?? '',
            ) as (ProviderConfig & { adapterId?: string | null }) | null
          )?.adapterId) ??
        null)
    );
  }

  private async recheckOnce(teammateId: string): Promise<ModelAvailabilityProjection> {
    const teammate = this.identities.getTeammate(teammateId);
    if (
      !teammate ||
      teammate.executorKind !== 'MODEL_RUNTIME' ||
      !teammate.currentRuntimeProfileId
    ) {
      throw new DomainError('INVALID_MODEL_IDENTITY', '此道友没有模型执行身份');
    }
    const runtimeProfileId = teammate.currentRuntimeProfileId;
    if (teammate.status !== 'ACTIVE') {
      throw new DomainError('TEAMMATE_ARCHIVED', '已归档道友不能重新检测模型');
    }
    const identity = this.inspectIdentity(teammateId, runtimeProfileId);
    if (
      !identity.binding ||
      identity.reason === 'BINDING_INVALID' ||
      identity.reason === 'RUNTIME_MISMATCH'
    ) {
      throw new DomainError('INVALID_MODEL_IDENTITY', '道友模型绑定无效');
    }
    if (identity.reason === 'EXECUTION_PROTOCOL_UNSUPPORTED') {
      throw new DomainError(
        'EXECUTION_PROTOCOL_UNSUPPORTED',
        '生成模型需要专用 Provider 验证；语言模型可用性探测已跳过',
      );
    }
    const providerFailure = identity.reason ?? (!identity.provider ? 'PROVIDER_INVALID' : null);
    if (providerFailure) {
      return this.recordOutcome({
        teammateId,
        runtimeProfileId,
        kind: 'HARD_FAILURE',
        code: providerFailure,
      });
    }
    const revision = this.identityRevision(teammateId, runtimeProfileId);
    let probeResult: { kind: AvailabilityOutcomeKind; code: string };
    try {
      probeResult = await this.probe.probe(runtimeProfileId);
    } catch (error) {
      probeResult = classifyFailure(error, 'PROBE_FAILED');
    }
    if (this.identities.getTeammate(teammateId)?.status !== 'ACTIVE') {
      return this.get(teammateId) ?? unknownProjection(teammateId, runtimeProfileId);
    }
    if (revision !== this.identityRevision(teammateId, runtimeProfileId)) {
      return this.get(teammateId) ?? unknownProjection(teammateId, runtimeProfileId);
    }
    if (!isOutcomeKind(probeResult.kind))
      probeResult = { kind: 'TRANSIENT_FAILURE', code: 'PROBE_FAILED' };
    return this.recordOutcome({
      teammateId,
      runtimeProfileId,
      kind: probeResult.kind,
      code: probeResult.code,
      identityRevision: revision,
    });
  }

  private inspectIdentity(
    teammateId: string,
    runtimeProfileId: string,
    allowInactive = false,
  ): ModelIdentityInspection {
    const teammate = this.identities.getTeammate(teammateId);
    if (
      !teammate ||
      teammate.executorKind !== 'MODEL_RUNTIME' ||
      !teammate.currentRuntimeProfileId
    ) {
      return { binding: null, reason: 'BINDING_INVALID' };
    }
    if (teammate.systemKind !== null) return { binding: null, reason: 'BINDING_INVALID' };
    if (!allowInactive && teammate.status !== 'ACTIVE')
      return { binding: null, reason: 'TEAMMATE_INACTIVE' };
    const binding = this.identities.getModelBinding(teammateId);
    if (!binding || binding.runtimeProfileId !== teammate.currentRuntimeProfileId) {
      return { binding: binding ?? null, reason: 'BINDING_INVALID' };
    }
    if (binding.runtimeProfileId !== runtimeProfileId)
      return { binding, reason: 'RUNTIME_MISMATCH' };
    const runtime = this.identities.getRuntimeProfile(runtimeProfileId);
    const provider = runtime ? this.identities.getProvider(runtime.providerId) : null;
    const credential = runtime?.credentialId
      ? this.identities.getCredential(runtime.credentialId)
      : null;
    if (
      !runtime ||
      !provider ||
      binding.providerKind !== provider.kind ||
      binding.endpoint !== provider.baseUrl ||
      (this.executionProtocol === 'GENERATION' &&
        ((binding as TeammateModelBinding & { adapterId?: string | null }).adapterId ?? null) !==
          ((provider as ProviderConfig & { adapterId?: string | null }).adapterId ?? null)) ||
      binding.modelId !== runtime.modelId ||
      binding.credentialId !== runtime.credentialId ||
      (binding.executionProtocol ?? 'LANGUAGE') !== (runtime.executionProtocol ?? 'LANGUAGE') ||
      runtime.providerId !== provider.id
    ) {
      return { binding, reason: 'PROVIDER_INVALID' };
    }
    if ((runtime.executionProtocol ?? 'LANGUAGE') !== this.executionProtocol) {
      return { binding, reason: 'EXECUTION_PROTOCOL_UNSUPPORTED', teammate, runtime, provider };
    }
    if (!provider.enabled)
      return { binding, reason: 'PROVIDER_DISABLED', teammate, runtime, provider };
    const generationHttpAllowsNoCredential =
      this.executionProtocol === 'GENERATION' && String(provider.kind) === 'GENERATION_HTTP';
    const credentialRequired =
      runtime.credentialId !== null ||
      (provider.kind !== 'OPENAI_COMPATIBLE' && !generationHttpAllowsNoCredential);
    if (
      (credentialRequired && (!credential || credential.providerId !== provider.id)) ||
      !validProviderUrl(provider)
    ) {
      return { binding, reason: 'PROVIDER_INVALID', teammate, runtime, provider };
    }
    if (!this.identities.hasValidModelBinding(teammateId)) {
      return { binding, reason: 'BINDING_INVALID', teammate, runtime, provider };
    }
    return { binding, reason: null, teammate, runtime, provider };
  }
}

export interface RoutingEligibilityOptions {
  requiredCapabilities?: CapabilityDimension[];
  explicit?: boolean;
}

/** Shared, read-only eligibility foundation. It never probes or picks another Teammate. */
export class RoutingEligibilityService {
  constructor(
    private readonly identities: AvailabilityIdentityStore,
    private readonly availability: Pick<AvailabilityService, 'get'>,
    private readonly isCapabilitySupported?: (
      teammateId: string,
      dimension: CapabilityDimension,
    ) => boolean,
  ) {}

  evaluate(teammateId: string, options: RoutingEligibilityOptions = {}): RoutingEligibility {
    const teammate = this.identities.getTeammate(teammateId);
    const initialAvailability =
      teammate?.executorKind === 'MODEL_RUNTIME' && teammate.currentRuntimeProfileId
        ? this.currentAvailability(teammateId, teammate.currentRuntimeProfileId)
        : null;
    const result: RoutingEligibility = {
      teammateId,
      eligible: false,
      candidateEligible: false,
      explicitEligible: false,
      reason: 'TEAMMATE_NOT_FOUND',
      reasons: ['TEAMMATE_NOT_FOUND'],
      availability: initialAvailability,
      stabilityPenalty: initialAvailability === 'UNSTABLE' ? 'UNSTABLE' : null,
      executorKind: teammate?.executorKind ?? null,
      routingPolicy: teammate?.routingPolicy ?? null,
      runtimeProfileId: teammate?.currentRuntimeProfileId ?? null,
      providerKind: null,
      unsupportedCapabilities: [],
    };
    const failure = (
      reason: RoutingEligibility['reason'],
      extra: Partial<RoutingEligibility> = {},
    ): RoutingEligibility => ({ ...result, ...extra, reason, reasons: [reason] });
    if (!teammate) return result;
    if (teammate.status !== 'ACTIVE') return failure('TEAMMATE_INACTIVE');
    if (teammate.executorKind !== 'MODEL_RUNTIME') return failure('NOT_MODEL_RUNTIME');
    if (teammate.systemKind !== null) return failure('BINDING_INVALID');
    if (!teammate.currentRuntimeProfileId) return failure('BINDING_MISSING');
    const binding = this.identities.getModelBinding(teammateId);
    if (!binding || binding.runtimeProfileId !== teammate.currentRuntimeProfileId) {
      return failure('BINDING_MISSING');
    }
    const runtime = this.identities.getRuntimeProfile(binding.runtimeProfileId);
    const provider = runtime ? this.identities.getProvider(runtime.providerId) : null;
    const credential = runtime?.credentialId
      ? this.identities.getCredential(runtime.credentialId)
      : null;
    if (
      !runtime ||
      !provider ||
      runtime.providerId !== provider.id ||
      binding.providerKind !== provider.kind ||
      binding.endpoint !== provider.baseUrl ||
      binding.modelId !== runtime.modelId ||
      (binding.executionProtocol ?? 'LANGUAGE') !== (runtime.executionProtocol ?? 'LANGUAGE') ||
      binding.credentialId !== runtime.credentialId
    ) {
      return failure('BINDING_INVALID');
    }
    if ((runtime.executionProtocol ?? 'LANGUAGE') !== 'LANGUAGE') {
      return failure('EXECUTION_PROTOCOL_UNSUPPORTED', { providerKind: provider.kind });
    }
    if (!provider.enabled) {
      return failure('PROVIDER_DISABLED', {
        availability: this.currentAvailability(teammateId, binding.runtimeProfileId),
        providerKind: provider.kind,
      });
    }
    const credentialRequired =
      runtime.credentialId !== null || provider.kind !== 'OPENAI_COMPATIBLE';
    if (
      (credentialRequired && (!credential || credential.providerId !== provider.id)) ||
      !validProviderUrl(provider)
    ) {
      return failure('PROVIDER_INVALID', { providerKind: provider.kind });
    }
    if (!this.identities.hasValidModelBinding(teammateId)) return failure('BINDING_INVALID');
    const unsupportedCapabilities = (options.requiredCapabilities ?? []).filter(
      (dimension) => !this.isCapabilitySupported?.(teammateId, dimension),
    );
    if (unsupportedCapabilities.length) {
      return failure('CAPABILITY_UNSUPPORTED', {
        availability: this.currentAvailability(teammateId, binding.runtimeProfileId),
        unsupportedCapabilities,
        providerKind: provider.kind,
      });
    }
    const availability = this.currentAvailability(teammateId, binding.runtimeProfileId);
    if (availability === 'UNAVAILABLE') {
      return failure('MODEL_UNAVAILABLE', { availability, providerKind: provider.kind });
    }
    const explicitEligible = true;
    const candidateEligible = teammate.routingPolicy === 'NORMAL';
    const eligible = options.explicit ? explicitEligible : candidateEligible;
    const reason: RoutingEligibility['reason'] =
      !options.explicit && teammate.routingPolicy === 'FALLBACK_ONLY'
        ? 'FALLBACK_ONLY'
        : !options.explicit && teammate.routingPolicy === 'MANUAL_ONLY'
          ? 'MANUAL_ONLY'
          : 'ELIGIBLE';
    return {
      ...result,
      eligible,
      candidateEligible,
      explicitEligible,
      reason,
      reasons: reason === 'ELIGIBLE' ? [] : [reason],
      availability,
      stabilityPenalty: availability === 'UNSTABLE' ? 'UNSTABLE' : null,
      providerKind: provider.kind,
      unsupportedCapabilities,
    };
  }

  private currentAvailability(
    teammateId: string,
    runtimeProfileId: string,
  ): ModelAvailabilityStatus {
    const projection = this.availability.get(teammateId);
    return projection?.runtimeProfileId === runtimeProfileId ? projection.status : 'UNKNOWN';
  }
}

/**
 * Decorates each model request surface so availability is probed before use and
 * real success/failure updates the same sealed identity. An ancillary embedding
 * on another Runtime bypasses availability and does not contaminate that identity.
 */
export class AvailabilityAwareModelGateway implements ModelGateway {
  readonly handlesCallStart = true as const;
  readonly generateWithTools?: NonNullable<ModelGateway['generateWithTools']>;
  readonly proposeCollaboration?: NonNullable<ModelGateway['proposeCollaboration']>;
  readonly extractCandidates?: MemoryCandidateExtractor['extractCandidates'];
  readonly embed?: EmbeddingGateway['embed'];

  constructor(
    private readonly gateway: ModelGateway &
      Partial<MemoryCandidateExtractor> &
      Partial<EmbeddingGateway>,
    private readonly availability: AvailabilityService,
  ) {
    if (gateway.generateWithTools) {
      this.generateWithTools = (request) =>
        this.invoke(request, () => gateway.generateWithTools!(withoutCallStart(request)));
    }
    if (gateway.proposeCollaboration) {
      this.proposeCollaboration = (request) =>
        this.invoke(request, () => gateway.proposeCollaboration!(withoutCallStart(request)));
    }
    if (gateway.extractCandidates) {
      this.extractCandidates = (request) =>
        this.invoke(request, () => gateway.extractCandidates!(request));
    }
    if (gateway.embed) {
      this.embed = (request) => {
        if (!availability.ownsRuntime(request.teammateId, request.runtimeProfileId)) {
          return gateway.embed!(request);
        }
        return this.invoke(request, () => gateway.embed!(request));
      };
    }
  }

  prepare(request: { teammateId: string; runtimeProfileId: string }): Promise<void> {
    return this.prepareForSend(request);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    return this.invoke(request, () => this.gateway.generate(withoutCallStart(request)));
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    await this.prepareForSend(request);
    const revision = this.availability.identityRevision(
      request.teammateId,
      request.runtimeProfileId,
    );
    await request.onCallStarted?.();
    let finished = false;
    try {
      for await (const event of this.gateway.stream(withoutCallStart(request))) {
        if (event.type === 'finish') {
          await this.recordSuccess(request, revision);
          finished = true;
        }
        yield event;
      }
      if (!finished) {
        await this.recordFailure(
          request,
          { availabilityKind: 'TRANSIENT_FAILURE', availabilityCode: 'STREAM_INCOMPLETE' },
          revision,
        );
      }
    } catch (error) {
      if (!finished) await this.recordFailure(request, error, revision);
      throw error;
    }
  }

  testConnection(runtimeProfileId: string) {
    return this.gateway.testConnection(runtimeProfileId);
  }

  private async invoke<
    T extends {
      runtimeProfileId: string;
      teammateId: string;
      onCallStarted?: () => void | Promise<void>;
    },
    R,
  >(request: T, operation: () => Promise<R>): Promise<R> {
    await this.prepareForSend(request);
    const revision = this.availability.identityRevision(
      request.teammateId,
      request.runtimeProfileId,
    );
    await request.onCallStarted?.();
    let result: R;
    try {
      result = await operation();
    } catch (error) {
      await this.recordFailure(request, error, revision);
      throw error;
    }
    await this.recordSuccess(request, revision);
    return result;
  }

  private async prepareForSend(request: {
    teammateId: string;
    runtimeProfileId: string;
  }): Promise<void> {
    const outcome = await this.availability.prepare(request);
    if (!outcome.ok) throw new ModelUnavailableError(outcome);
  }

  private async recordSuccess(
    request: { teammateId: string; runtimeProfileId: string },
    identityRevision: string | null,
  ): Promise<void> {
    if (!this.availability.ownsRuntime(request.teammateId, request.runtimeProfileId)) return;
    await this.availability.recordOutcome({
      ...request,
      kind: 'SUCCESS',
      code: 'REQUEST_SUCCEEDED',
      identityRevision,
    });
  }

  private async recordFailure(
    request: { teammateId: string; runtimeProfileId: string },
    error: unknown,
    identityRevision: string | null,
  ): Promise<void> {
    if (!this.availability.ownsRuntime(request.teammateId, request.runtimeProfileId)) return;
    const classified = classifyFailure(error, 'PROVIDER_REQUEST_FAILED');
    await this.availability.recordOutcome({ ...request, ...classified, identityRevision });
  }
}

interface ModelIdentityInspection {
  binding: TeammateModelBinding | null;
  reason: string | null;
  teammate?: Teammate;
  runtime?: RuntimeProfile;
  provider?: ProviderConfig;
}

function unavailable(
  teammateId: string,
  runtimeProfileId: string,
  availability: ModelAvailabilityProjection,
): ModelUnavailableResult {
  return {
    ok: false,
    code: 'MODEL_UNAVAILABLE',
    teammateId,
    runtimeProfileId,
    availability,
    actions: ['RECHECK', 'SELECT_OTHER', 'CANCEL'],
  };
}

function unknownProjection(
  teammateId: string,
  runtimeProfileId: string,
): ModelAvailabilityProjection {
  return {
    teammateId,
    runtimeProfileId,
    status: 'UNKNOWN',
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    recentOutcomes: [],
    policyVersion: AVAILABILITY_POLICY_V1.version,
  };
}

function cloneProjection(value: ModelAvailabilityProjection): ModelAvailabilityProjection {
  return { ...value, recentOutcomes: value.recentOutcomes.map((entry) => ({ ...entry })) };
}

function validProviderUrl(provider: ProviderConfig): boolean {
  if (!provider.baseUrl)
    return provider.kind !== 'OPENAI_COMPATIBLE' && String(provider.kind) !== 'GENERATION_HTTP';
  try {
    const parsed = new URL(provider.baseUrl);
    return (
      (parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function classifyFailure(
  error: unknown,
  fallbackCode: string,
): { kind: AvailabilityOutcomeKind; code: string } {
  const candidate = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const kind = candidate.availabilityKind;
  const code = candidate.availabilityCode ?? candidate.code;
  const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallbackCode;
  if (kind === 'HARD_FAILURE' || kind === 'TRANSIENT_FAILURE') return { kind, code: safeCode };
  if (
    [
      'RUNTIME_NOT_FOUND',
      'RUNTIME_UNAVAILABLE',
      'INVALID_RUNTIME',
      'UNSUPPORTED_PROVIDER',
      'PROVIDER_DISABLED',
      'AUTHENTICATION_FAILED',
      'MODEL_NOT_FOUND',
      'CONNECTION_REFUSED',
    ].includes(safeCode)
  ) {
    return { kind: 'HARD_FAILURE', code: safeCode };
  }
  return { kind: 'TRANSIENT_FAILURE', code: safeCode };
}

function withoutCallStart<T extends { onCallStarted?: () => void | Promise<void> }>(
  request: T,
): Omit<T, 'onCallStarted'> {
  const providerRequest = { ...request };
  delete providerRequest.onCallStarted;
  return providerRequest;
}
function isOutcomeKind(value: string): value is AvailabilityOutcomeKind {
  return value === 'SUCCESS' || value === 'HARD_FAILURE' || value === 'TRANSIENT_FAILURE';
}
