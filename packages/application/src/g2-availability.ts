import type { AvailabilityOutcomeKind, ModelAvailabilityProjection } from '@cultivation/domain';
import { DomainError } from '@cultivation/shared';
import type {
  AvailabilityIdentityStore,
  AvailabilityServiceOptions,
  AvailabilityStore,
  ModelAvailabilityProbe,
} from './r3-2-availability.js';
import { AvailabilityService, ModelUnavailableError } from './r3-2-availability.js';
import type {
  GenerationBinarySource,
  GenerationGateway,
  GenerationOperationOptions,
  ProviderGenerationRequest,
} from './g1-generation.js';
import { GenerationCrash } from './g1-generation.js';
import type {
  GenerationModelDescriptor,
  GenerationSubmission,
  ProviderGenerationJob,
} from '@cultivation/domain/g1-generation';

/** Runtime identity needed to bind a generation operation to its sealed Teammate. */
export interface GenerationAvailabilityIdentity {
  teammateId: string;
  modelId: string;
}

/** Resolves the fixed Generation Runtime identity; it never selects or reroutes a Teammate. */
export interface GenerationAvailabilityIdentityResolver {
  resolveRuntime(runtimeProfileId: string): GenerationAvailabilityIdentity | null;
}

/**
 * Provider-neutral probe seam. The adapter's descriptor request should include its health check
 * (for example, H3 GET /health followed by its descriptor response).
 */
export class GenerationDescriptorAvailabilityProbe implements ModelAvailabilityProbe {
  constructor(
    private readonly source: Pick<GenerationGateway, 'getDescriptor'>,
    private readonly identities: GenerationAvailabilityIdentityResolver,
  ) {}

  async probe(runtimeProfileId: string): Promise<{
    kind: AvailabilityOutcomeKind;
    code: string;
  }> {
    const identity = this.identities.resolveRuntime(runtimeProfileId);
    if (!identity) return { kind: 'HARD_FAILURE', code: 'RUNTIME_NOT_FOUND' };
    try {
      const descriptor = await this.source.getDescriptor(runtimeProfileId);
      if (!validDescriptorIdentity(descriptor, identity.modelId)) {
        return { kind: 'HARD_FAILURE', code: 'MODEL_ID_MISMATCH' };
      }
      return { kind: 'SUCCESS', code: 'GENERATION_DESCRIPTOR_OK' };
    } catch (error) {
      return (
        classifyGenerationFailure(error, 'GENERATION_PROBE_FAILED') ?? {
          kind: 'TRANSIENT_FAILURE',
          code: 'GENERATION_PROBE_FAILED',
        }
      );
    }
  }
}

/** Uses the shared availability store and R3.2 policy for GENERATION identities. */
export function createGenerationAvailabilityService(
  store: AvailabilityStore,
  identities: AvailabilityIdentityStore,
  descriptorSource: Pick<GenerationGateway, 'getDescriptor'>,
  identityResolver: GenerationAvailabilityIdentityResolver,
  options: Omit<AvailabilityServiceOptions, 'executionProtocol'> = {},
): AvailabilityService {
  return new AvailabilityService(
    store,
    identities,
    new GenerationDescriptorAvailabilityProbe(descriptorSource, identityResolver),
    { ...options, executionProtocol: 'GENERATION' },
  );
}

type GenerationCall = 'DESCRIPTOR' | 'SUBMIT' | 'JOB_STATUS' | 'DOWNLOAD';

/**
 * Adds request-before-send availability checks and shared projections around the frozen G1 port.
 * No operation searches for another Teammate or changes benchmark/evidence records.
 */
export class GenerationAvailabilityGateway implements GenerationGateway {
  constructor(
    private readonly delegate: GenerationGateway,
    private readonly availability: AvailabilityService,
    private readonly identities: GenerationAvailabilityIdentityResolver,
  ) {}

  getDescriptor(runtimeProfileId: string): Promise<GenerationModelDescriptor> {
    // Provider connection verification may target an unbound candidate Runtime. It is not a
    // Teammate availability observation and must use the raw adapter without creating a row.
    if (!this.identities.resolveRuntime(runtimeProfileId)) {
      return this.delegate.getDescriptor(runtimeProfileId);
    }
    return this.observe(runtimeProfileId, 'DESCRIPTOR', async (identity) => {
      const descriptor = await this.delegate.getDescriptor(runtimeProfileId);
      if (!validDescriptorIdentity(descriptor, identity.modelId)) {
        throw new DomainError('INVALID_MODEL_IDENTITY', '生成模型描述与固定模型身份不一致');
      }
      return descriptor;
    });
  }

  async submit(
    runtimeProfileId: string,
    request: ProviderGenerationRequest,
  ): Promise<GenerationSubmission> {
    const identity = this.requireIdentity(runtimeProfileId);
    if (request.modelId !== identity.modelId) {
      throw new DomainError('INVALID_MODEL_IDENTITY', '生成请求与固定模型身份不一致');
    }
    const revision = this.availability.identityRevision(identity.teammateId, runtimeProfileId);
    const prepared = await this.availability.prepare({
      teammateId: identity.teammateId,
      runtimeProfileId,
      freshProbe: true,
    });
    if (!prepared.ok) throw new ModelUnavailableError(prepared);
    if (
      revision !== this.availability.identityRevision(identity.teammateId, runtimeProfileId) ||
      this.identities.resolveRuntime(runtimeProfileId)?.modelId !== request.modelId
    ) {
      throw new DomainError('INVALID_MODEL_IDENTITY', '生成身份在提交前发生变化');
    }
    return this.observe(runtimeProfileId, 'SUBMIT', () =>
      this.delegate.submit(runtimeProfileId, request),
    );
  }

  getJob(runtimeProfileId: string, providerJobId: string): Promise<ProviderGenerationJob> {
    return this.observe(runtimeProfileId, 'JOB_STATUS', () =>
      this.delegate.getJob(runtimeProfileId, providerJobId),
    );
  }

  async downloadOutput(
    runtimeProfileId: string,
    providerJobId: string,
    outputId: string,
    options?: GenerationOperationOptions,
  ): Promise<GenerationBinarySource> {
    const source = await this.observe(runtimeProfileId, 'DOWNLOAD', () =>
      this.delegate.downloadOutput(runtimeProfileId, providerJobId, outputId, options),
    );
    return this.observeSource(runtimeProfileId, source);
  }

  private async observe<T>(
    runtimeProfileId: string,
    call: GenerationCall,
    operation: (identity: GenerationAvailabilityIdentity) => Promise<T>,
  ): Promise<T> {
    const identity = this.requireIdentity(runtimeProfileId);
    const revision = this.availability.identityRevision(identity.teammateId, runtimeProfileId);
    try {
      const result = await operation(identity);
      await this.record(identity, runtimeProfileId, 'SUCCESS', successCode(call), revision);
      return result;
    } catch (error) {
      if (error instanceof GenerationCrash) {
        const failure = {
          kind: 'TRANSIENT_FAILURE' as const,
          code: call === 'SUBMIT' ? 'SUBMISSION_STATE_UNKNOWN' : failureCode(call),
        };
        await this.record(identity, runtimeProfileId, failure.kind, failure.code, revision);
        if (call === 'SUBMIT') {
          // G1 treats GenerationCrash as a local crash and would retry a SUBMITTING job.
          throw new DomainError('SUBMISSION_STATE_UNKNOWN', '生成提交结果无法确认');
        }
        throw error;
      }
      const failure = classifyGenerationFailure(error, failureCode(call));
      if (failure)
        await this.record(identity, runtimeProfileId, failure.kind, failure.code, revision);
      if (failure && isRecoverableRemoteFailure(call, failure)) {
        throw new GenerationCrash('Temporary Provider failure; the GenerationJob is preserved');
      }
      throw error;
    }
  }

  private async observeSource(
    runtimeProfileId: string,
    source: GenerationBinarySource,
  ): Promise<GenerationBinarySource> {
    const identity = this.requireIdentity(runtimeProfileId);
    const revision = this.availability.identityRevision(identity.teammateId, runtimeProfileId);
    const recordFailure = (failure: {
      kind: AvailabilityOutcomeKind;
      code: string;
    }): Promise<ModelAvailabilityProjection | null> =>
      this.record(identity, runtimeProfileId, failure.kind, failure.code, revision);
    return {
      cancel: (reason) => source.cancel(reason),
      async *open(signal): AsyncGenerator<Uint8Array> {
        try {
          for await (const chunk of source.open(signal)) yield chunk;
        } catch (error) {
          if (signal?.aborted || isAbortError(error) || error instanceof GenerationCrash)
            throw error;
          const failure = classifyGenerationFailure(error, 'GENERATION_DOWNLOAD_FAILED');
          if (failure) await recordFailure(failure);
          if (failure && isRecoverableRemoteFailure('DOWNLOAD', failure)) {
            throw new GenerationCrash(
              'Temporary Provider download failure; the GenerationJob is preserved',
            );
          }
          throw error;
        }
      },
    };
  }

  private requireIdentity(runtimeProfileId: string): GenerationAvailabilityIdentity {
    const identity = this.identities.resolveRuntime(runtimeProfileId);
    if (
      !identity ||
      !identity.teammateId ||
      !identity.modelId ||
      !this.availability.ownsRuntime(identity.teammateId, runtimeProfileId)
    ) {
      throw new DomainError('INVALID_MODEL_IDENTITY', '生成 Runtime 没有有效的固定道友身份');
    }
    return identity;
  }

  private async record(
    identity: GenerationAvailabilityIdentity,
    runtimeProfileId: string,
    kind: AvailabilityOutcomeKind,
    code: string,
    identityRevision: string | null,
  ): Promise<ModelAvailabilityProjection | null> {
    if (!this.availability.ownsRuntime(identity.teammateId, runtimeProfileId)) return null;
    try {
      return await this.availability.recordOutcome({
        teammateId: identity.teammateId,
        runtimeProfileId,
        kind,
        code,
        identityRevision,
      });
    } catch {
      // Availability is observational; a projection write must not rewrite the G1 job outcome.
      return null;
    }
  }
}

function validDescriptorIdentity(
  descriptor: GenerationModelDescriptor | null | undefined,
  modelId: string,
): descriptor is GenerationModelDescriptor {
  return !!(
    descriptor &&
    typeof descriptor.modelId === 'string' &&
    descriptor.modelId.length > 0 &&
    descriptor.modelId === modelId
  );
}

type GenerationFailureClassification = {
  kind: AvailabilityOutcomeKind;
  code: string;
};

function classifyGenerationFailure(
  error: unknown,
  fallbackCode: string,
): GenerationFailureClassification | null {
  const candidate = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const availabilityKind = candidate.availabilityKind;
  const rawCode = candidate.availabilityCode ?? candidate.code;
  const code =
    typeof rawCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : fallbackCode;
  if (availabilityKind === 'HARD_FAILURE' || availabilityKind === 'TRANSIENT_FAILURE') {
    return { kind: availabilityKind, code };
  }
  if (
    [
      'RUNTIME_NOT_FOUND',
      'RUNTIME_UNAVAILABLE',
      'INVALID_RUNTIME',
      'UNSUPPORTED_PROVIDER',
      'PROVIDER_DISABLED',
      'MODEL_UNAVAILABLE',
      'INVALID_MODEL_IDENTITY',
      'AUTH_FAILED',
      'AUTHENTICATION_FAILED',
      'INVALID_API_KEY',
      'MODEL_NOT_FOUND',
      'MODEL_ID_MISMATCH',
      'CONNECTION_REFUSED',
      'HTTP_401',
      'HTTP_403',
      'HTTP_404',
    ].includes(code)
  ) {
    return { kind: 'HARD_FAILURE', code };
  }
  if (code === 'HTTP_429' || code === 'RATE_LIMITED' || code === 'HTTP_408') {
    return { kind: 'TRANSIENT_FAILURE', code };
  }
  if (
    [
      'UNSUPPORTED_FEATURE',
      'UNSUPPORTED_INPUT_ROLE',
      'UNSUPPORTED_CAPABILITY',
      'INVALID_INPUT',
      'INPUT_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'IDEMPOTENCY_CONFLICT',
    ].includes(code)
  ) {
    return null;
  }
  return { kind: 'TRANSIENT_FAILURE', code };
}

function successCode(call: GenerationCall): string {
  switch (call) {
    case 'DESCRIPTOR':
      return 'GENERATION_DESCRIPTOR_OK';
    case 'SUBMIT':
      return 'GENERATION_SUBMIT_OK';
    case 'JOB_STATUS':
      return 'GENERATION_STATUS_OK';
    case 'DOWNLOAD':
      return 'GENERATION_DOWNLOAD_OK';
  }
}

function failureCode(call: GenerationCall): string {
  switch (call) {
    case 'DESCRIPTOR':
      return 'GENERATION_PROBE_FAILED';
    case 'SUBMIT':
      return 'GENERATION_SUBMIT_FAILED';
    case 'JOB_STATUS':
      return 'GENERATION_STATUS_FAILED';
    case 'DOWNLOAD':
      return 'GENERATION_DOWNLOAD_FAILED';
  }
}

function isRecoverableRemoteFailure(
  call: GenerationCall,
  failure: GenerationFailureClassification,
): boolean {
  return (
    (call === 'JOB_STATUS' || call === 'DOWNLOAD') &&
    (failure.kind === 'TRANSIENT_FAILURE' ||
      [
        'CONNECTION_REFUSED',
        'RUNTIME_UNAVAILABLE',
        'MODEL_UNAVAILABLE',
        'PROVIDER_DISABLED',
      ].includes(failure.code))
  );
}

function isAbortError(error: unknown): boolean {
  return !!(
    error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
