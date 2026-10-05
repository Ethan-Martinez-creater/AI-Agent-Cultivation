import { describe, expect, it, vi } from 'vitest';
import type { AvailabilityIdentityStore, AvailabilityStore } from './r3-2-availability.js';
import type {
  CredentialSummary,
  ModelAvailabilityProjection,
  ProviderConfig,
  RuntimeProfile,
  Teammate,
  TeammateModelBinding,
} from '@cultivation/domain';
import type {
  GenerationArtifact as DomainGenerationArtifact,
  GenerationJob,
  GenerationJobState,
  GenerationModelDescriptor,
  GenerationSubmission,
  ProviderGenerationJob,
  GenerationTask,
} from '@cultivation/domain/g1-generation';
import { transitionGenerationJob } from '@cultivation/domain/g1-generation';
import { DomainError } from '@cultivation/shared';
import { GenerationCrash, GenerationService } from './g1-generation.js';
import type {
  GenerationIdentityPort,
  GenerationArtifactPort as AppGenerationArtifactPort,
  GenerationGateway,
  GenerationOperationOptions,
  GenerationRepository,
  GenerationResolvedInput,
  ProviderGenerationRequest,
} from './g1-generation.js';
import {
  AvailabilityService,
  ModelUnavailableError,
  RoutingEligibilityService,
} from './r3-2-availability.js';
import {
  createGenerationAvailabilityService,
  GenerationAvailabilityGateway,
  GenerationDescriptorAvailabilityProbe,
} from './g2-availability.js';

const checkedAt = '2026-10-05T00:00:00.000Z';
const adapterId = 'h3-compatible';

function generationDescriptor(
  overrides: Partial<GenerationModelDescriptor> = {},
): GenerationModelDescriptor {
  return {
    modelId: 'model-a',
    outputCapability: 'IMAGE_GENERATION',
    executionMode: 'ASYNC_JOB',
    featureTags: [],
    inputRoles: [],
    parameterSchema: { type: 'object', additionalProperties: true },
    outputTypes: ['image/png'],
    limits: {
      maxInputFiles: 0,
      maxInputBytes: 0,
      maxOutputBytes: 1024,
      maxOutputs: 1,
    },
    ...overrides,
  };
}

function makeFixture(
  options: {
    descriptor?: () => Promise<GenerationModelDescriptor>;
    submit?: (
      runtimeProfileId: string,
      request: ProviderGenerationRequest,
    ) => Promise<GenerationSubmission>;
    getJob?: (runtimeProfileId: string, providerJobId: string) => Promise<ProviderGenerationJob>;
    downloadOutput?: (
      runtimeProfileId: string,
      providerJobId: string,
      outputId: string,
      operation?: GenerationOperationOptions,
    ) => Promise<{ open(signal?: AbortSignal): AsyncIterable<Uint8Array>; cancel(): void }>;
    teammate?: Partial<Teammate>;
  } = {},
) {
  let teammate: Teammate = {
    id: 'teammate-a',
    name: 'A',
    avatar: null,
    title: 'maker',
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
    ...options.teammate,
  };
  const runtime: RuntimeProfile = {
    id: 'runtime-a',
    name: 'Generation Runtime',
    providerId: 'provider-a',
    credentialId: null,
    modelId: 'model-a',
    executionProtocol: 'GENERATION',
    parameters: {},
    capabilityOverrides: {},
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  let provider = {
    id: 'provider-a',
    name: 'H3 Adapter',
    kind: 'GENERATION_HTTP',
    baseUrl: 'http://127.0.0.1:8300',
    enabled: true,
    adapterId,
    createdAt: checkedAt,
    updatedAt: checkedAt,
  } as ProviderConfig & { adapterId: string };
  let binding = {
    teammateId: 'teammate-a',
    runtimeProfileId: 'runtime-a',
    providerKind: 'GENERATION_HTTP',
    endpoint: provider.baseUrl,
    adapterId,
    modelId: 'model-a',
    executionProtocol: 'GENERATION',
    credentialId: null,
    verifiedAt: checkedAt,
    verificationSource: 'LIVE_TEST',
    sealedAt: checkedAt,
  } as TeammateModelBinding & { adapterId: string };
  let credential: CredentialSummary | null = null;
  let projection: ModelAvailabilityProjection | null = null;
  let nowIndex = 0;

  const identityStore: AvailabilityIdentityStore = {
    getTeammate: (id) => (id === teammate.id ? teammate : null),
    getModelBinding: (id) =>
      id === teammate.id && teammate.executorKind === 'MODEL_RUNTIME' ? binding : null,
    getRuntimeProfile: (id) => (id === runtime.id ? runtime : null),
    getProvider: (id) => (id === provider.id ? provider : null),
    getCredential: (id) => (id === credential?.id ? credential : null),
    hasValidModelBinding: (id) =>
      id === teammate.id &&
      binding.runtimeProfileId === teammate.currentRuntimeProfileId &&
      binding.providerKind === provider.kind &&
      binding.endpoint === provider.baseUrl &&
      binding.adapterId === provider.adapterId &&
      binding.modelId === runtime.modelId &&
      binding.credentialId === runtime.credentialId &&
      (binding.executionProtocol ?? 'LANGUAGE') === (runtime.executionProtocol ?? 'LANGUAGE'),
  };
  const store: AvailabilityStore = {
    getAvailability: (id) => (id === teammate.id ? projection : null),
    saveAvailability: (value) => {
      projection = structuredClone(value);
    },
  };
  const resolver = {
    resolveRuntime: (runtimeProfileId: string) =>
      runtimeProfileId === runtime.id && teammate.executorKind === 'MODEL_RUNTIME'
        ? { teammateId: teammate.id, modelId: runtime.modelId }
        : null,
  };
  const descriptor = options.descriptor ?? (async () => generationDescriptor());
  const raw: GenerationGateway = {
    getDescriptor: vi.fn(async () => {
      return descriptor();
    }),
    submit: vi.fn(async (id, request) =>
      options.submit
        ? options.submit(id, request)
        : { providerJobId: 'provider-job-a', status: 'QUEUED' as const },
    ),
    getJob: vi.fn(async (id, jobId) =>
      options.getJob
        ? options.getJob(id, jobId)
        : {
            providerJobId: jobId,
            status: 'QUEUED' as const,
            outputs: [],
            errorCode: null,
          },
    ),
    downloadOutput: vi.fn(async (id, jobId, outputId, operation) =>
      options.downloadOutput
        ? options.downloadOutput(id, jobId, outputId, operation)
        : { open: async function* () {}, cancel: (): void => undefined },
    ),
  };
  const availability = createGenerationAvailabilityService(store, identityStore, raw, resolver, {
    now: () => `2026-10-05T00:00:${String(nowIndex++).padStart(2, '0')}.000Z`,
  });
  const gateway = new GenerationAvailabilityGateway(raw, availability, resolver);
  return {
    identityStore,
    store,
    raw,
    resolver,
    availability,
    gateway,
    get projection() {
      return projection;
    },
    set projection(value: ModelAvailabilityProjection | null) {
      projection = value;
    },
    set teammateStatus(value: Teammate['status']) {
      teammate = { ...teammate, status: value };
    },
    set bindingAdapterId(value: string | null) {
      binding = { ...binding, adapterId: value } as typeof binding;
    },
    set providerAdapterId(value: string | null) {
      provider = { ...provider, adapterId: value } as typeof provider;
    },
    get credential() {
      return credential;
    },
    set credential(value: CredentialSummary | null) {
      credential = value;
    },
  };
}

const generationRequest: ProviderGenerationRequest = {
  idempotencyKey: 'task-a',
  fingerprint: 'fingerprint-a',
  modelId: 'model-a',
  capability: 'IMAGE_GENERATION',
  requiredFeatures: [],
  prompt: 'create an image',
  inputs: [],
  parameters: {},
};

describe('G2 generation availability', () => {
  it('starts UNKNOWN, probes the generation descriptor without credentials, and becomes AVAILABLE', async () => {
    const context = makeFixture();
    expect(context.availability.get('teammate-a')?.status).toBe('UNKNOWN');
    const result = await context.availability.recheck('teammate-a');
    expect(result.status).toBe('AVAILABLE');
    expect(result.recentOutcomes.at(-1)).toMatchObject({
      kind: 'SUCCESS',
      code: 'GENERATION_DESCRIPTOR_OK',
    });
    expect(context.raw.getDescriptor).toHaveBeenCalledTimes(1);
    expect(context.credential).toBeNull();
  });

  it('classifies offline health as hard UNAVAILABLE and prevents submit without rerouting', async () => {
    const offline = Object.assign(new Error('private endpoint response'), {
      code: 'CONNECTION_REFUSED',
    });
    const context = makeFixture({ descriptor: async () => Promise.reject(offline) });
    const result = await context.availability.recheck('teammate-a');
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.recentOutcomes.at(-1)).toMatchObject({
      kind: 'HARD_FAILURE',
      code: 'CONNECTION_REFUSED',
    });
    await expect(context.gateway.submit('runtime-a', generationRequest)).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(context.raw.submit).not.toHaveBeenCalled();
    expect(context.resolver.resolveRuntime('runtime-a')).toEqual({
      teammateId: 'teammate-a',
      modelId: 'model-a',
    });
  });

  it('maps stable MODEL_UNAVAILABLE and AUTH_FAILED codes to hard failures', async () => {
    for (const code of ['MODEL_UNAVAILABLE', 'AUTH_FAILED', 'INVALID_MODEL_IDENTITY']) {
      const failure = Object.assign(new Error('private Provider response'), { code });
      const context = makeFixture({ descriptor: async () => Promise.reject(failure) });
      const result = await context.availability.recheck('teammate-a');
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.recentOutcomes.at(-1)).toMatchObject({
        kind: 'HARD_FAILURE',
        code,
      });
      expect(JSON.stringify(context.projection)).not.toContain('private Provider response');
    }
  });

  it('keeps mixed outcomes unstable until the configured consecutive recovery count', async () => {
    let failures = 1;
    const timeout = Object.assign(new Error('do not persist this message'), { code: 'TIMEOUT' });
    const context = makeFixture({
      descriptor: async () => {
        if (failures-- > 0) throw timeout;
        return generationDescriptor();
      },
    });
    expect((await context.availability.recheck('teammate-a')).status).toBe('UNSTABLE');
    expect((await context.availability.recheck('teammate-a')).status).toBe('UNSTABLE');
    expect((await context.availability.recheck('teammate-a')).status).toBe('AVAILABLE');
    expect(context.projection?.recentOutcomes.map((entry) => entry.kind)).toEqual([
      'TRANSIENT_FAILURE',
      'SUCCESS',
      'SUCCESS',
    ]);
    expect(JSON.stringify(context.projection)).not.toContain('do not persist');
  });

  it('does not let the default LANGUAGE service probe a generation Runtime or change R4 eligibility', async () => {
    const context = makeFixture();
    const languageAvailability = new AvailabilityService(
      context.store,
      context.identityStore,
      new GenerationDescriptorAvailabilityProbe(context.raw, context.resolver),
    );
    await expect(languageAvailability.recheck('teammate-a')).rejects.toThrow('专用 Provider 验证');
    expect(context.raw.getDescriptor).not.toHaveBeenCalled();
    expect(
      new RoutingEligibilityService(context.identityStore, languageAvailability).evaluate(
        'teammate-a',
      ).reason,
    ).toBe('EXECUTION_PROTOCOL_UNSUPPORTED');
  });

  it('rejects archived rechecks without probing or changing the sealed historical projection', async () => {
    const context = makeFixture();
    await context.availability.recheck('teammate-a');
    const before = structuredClone(context.projection);
    const calls = vi.mocked(context.raw.getDescriptor).mock.calls.length;
    context.teammateStatus = 'ARCHIVED';
    await expect(context.availability.recheck('teammate-a')).rejects.toThrow('已归档');
    expect(vi.mocked(context.raw.getDescriptor).mock.calls).toHaveLength(calls);
    expect(context.projection).toEqual(before);
  });

  it('leaves Human Bridge without a projection and lets unbound connection verification use the raw descriptor', async () => {
    const context = makeFixture({
      teammate: {
        id: 'human-bridge',
        executorKind: 'USER_BRIDGE',
        systemKind: 'HUMAN_BRIDGE',
        currentRuntimeProfileId: null,
      },
    });
    expect(context.availability.get('human-bridge')).toBeNull();
    await expect(context.gateway.getDescriptor('runtime-candidate')).resolves.toMatchObject({
      modelId: 'model-a',
    });
    expect(context.projection).toBeNull();
    await expect(
      context.gateway.submit('runtime-candidate', generationRequest),
    ).rejects.toMatchObject({
      code: 'INVALID_MODEL_IDENTITY',
    });
    expect(context.raw.submit).not.toHaveBeenCalled();
    expect(context.projection).toBeNull();
  });

  it('prepares the fixed identity before real submit and records adapter success', async () => {
    const context = makeFixture();
    await expect(context.gateway.submit('runtime-a', generationRequest)).resolves.toEqual({
      providerJobId: 'provider-job-a',
      status: 'QUEUED',
    });
    expect(context.raw.getDescriptor).toHaveBeenCalledTimes(1);
    expect(context.raw.submit).toHaveBeenCalledTimes(1);
    expect(context.raw.submit).toHaveBeenCalledWith('runtime-a', generationRequest);
    expect(context.availability.get('teammate-a')?.recentOutcomes.at(-1)).toMatchObject({
      kind: 'SUCCESS',
      code: 'GENERATION_SUBMIT_OK',
    });
  });

  it('does not change provider availability for deterministic request validation failures', async () => {
    const context = makeFixture({
      submit: async () => {
        throw new DomainError('UNSUPPORTED_FEATURE', 'requested feature is not supported');
      },
    });
    await expect(context.gateway.submit('runtime-a', generationRequest)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
    });
    expect(context.raw.submit).toHaveBeenCalledTimes(1);
    expect(context.availability.get('teammate-a')?.status).toBe('AVAILABLE');
    expect(context.availability.get('teammate-a')?.recentOutcomes.at(-1)?.code).toBe(
      'GENERATION_DESCRIPTOR_OK',
    );
  });

  it('records submit failure and leaves UNKNOWN submissions terminal instead of replaying them', async () => {
    const refused = Object.assign(new Error('secret response'), { code: 'CONNECTION_REFUSED' });
    const context = makeFixture({ submit: async () => Promise.reject(refused) });
    const runner = makeGenerationRunner(context);
    const job = await runner.create();
    await expect(runner.service.advance(job.id)).resolves.toMatchObject({
      state: 'UNKNOWN',
      errorCode: 'GENERATION_FAILED',
    });
    expect(context.availability.get('teammate-a')?.status).toBe('UNAVAILABLE');
    await runner.service.recover();
    expect(context.raw.submit).toHaveBeenCalledTimes(1);
  });

  it('does not expose a submit GenerationCrash that would replay a possibly sent request', async () => {
    const context = makeFixture({
      submit: async () => {
        throw new GenerationCrash('provider may have accepted the request');
      },
    });
    const runner = makeGenerationRunner(context);
    const job = await runner.create();
    await expect(runner.service.advance(job.id)).resolves.toMatchObject({
      state: 'UNKNOWN',
      errorCode: 'SUBMISSION_STATE_UNKNOWN',
    });
    await runner.service.recover();
    expect(context.raw.submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(context.projection)).not.toContain('provider may have accepted');
  });

  it('preserves a running G1 job on offline polling and recovers it without resubmitting', async () => {
    const refused = Object.assign(new Error('secret response'), { code: 'CONNECTION_REFUSED' });
    let pollFails = true;
    const context = makeFixture({
      getJob: async (_runtime, providerJobId) => {
        if (pollFails) throw refused;
        return { providerJobId, status: 'QUEUED', outputs: [], errorCode: null };
      },
    });
    const runner = makeGenerationRunner(context);
    const job = await runner.create();
    await expect(runner.service.advance(job.id)).rejects.toBeInstanceOf(GenerationCrash);
    expect(runner.repository.getJob(job.id)?.state).toBe('QUEUED');
    expect(context.availability.get('teammate-a')?.status).toBe('UNAVAILABLE');
    pollFails = false;
    await runner.service.recover();
    expect(runner.repository.getJob(job.id)?.state).toBe('QUEUED');
    expect(context.raw.submit).toHaveBeenCalledTimes(1);
    expect(context.availability.get('teammate-a')?.status).toBe('UNAVAILABLE');
    await runner.service.recover();
    expect(context.availability.get('teammate-a')?.status).toBe('AVAILABLE');
  });

  it('turns transient output download errors into recoverable GenerationCrash outcomes', async () => {
    const timeout = Object.assign(new Error('private download endpoint'), { code: 'TIMEOUT' });
    const context = makeFixture({
      downloadOutput: async () => Promise.reject(timeout),
    });
    await expect(
      context.gateway.downloadOutput('runtime-a', 'job-a', 'output-a'),
    ).rejects.toBeInstanceOf(GenerationCrash);
    expect(context.availability.get('teammate-a')?.status).toBe('UNSTABLE');
    expect(JSON.stringify(context.projection)).not.toContain('private download endpoint');
  });

  it('discards a delayed health result after the sealed adapter identity changes', async () => {
    let finish!: (descriptor: GenerationModelDescriptor) => void;
    const context = makeFixture({
      descriptor: () => new Promise((resolve) => (finish = resolve)),
    });
    const recheck = context.availability.recheck('teammate-a');
    await vi.waitFor(() => expect(context.raw.getDescriptor).toHaveBeenCalledTimes(1));
    context.bindingAdapterId = 'other-adapter';
    context.providerAdapterId = 'other-adapter';
    finish(generationDescriptor());
    await recheck;
    expect(context.projection).toBeNull();
  });
});

class MemoryGenerationRepository implements GenerationRepository {
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly tasks = new Map<string, GenerationTask>();
  private readonly descriptors = new Map<string, GenerationModelDescriptor>();
  private readonly artifacts = new Map<string, DomainGenerationArtifact>();

  create(task: GenerationTask, descriptor: GenerationModelDescriptor, job: GenerationJob): void {
    this.tasks.set(task.id, task);
    this.descriptors.set(task.id, descriptor);
    this.jobs.set(job.id, job);
  }
  getTask(id: string): GenerationTask | null {
    return this.tasks.get(id) ?? null;
  }
  getDescriptor(taskId: string): GenerationModelDescriptor | null {
    return this.descriptors.get(taskId) ?? null;
  }
  getJob(id: string): GenerationJob | null {
    return this.jobs.get(id) ?? null;
  }
  listJobs(): GenerationJob[] {
    return [...this.jobs.values()];
  }
  listRecoverableJobs(): GenerationJob[] {
    return this.listJobs().filter((job) =>
      ['PENDING', 'SUBMITTING', 'QUEUED', 'RUNNING'].includes(job.state),
    );
  }
  observeProviderStatus(
    id: string,
    expectedState: GenerationJobState,
    status: ProviderGenerationJob['status'],
  ): GenerationJob {
    const job = this.requireJob(id);
    if (job.state !== expectedState) throw new Error('Provider status state conflict');
    const updated = { ...job, providerStatus: status };
    this.jobs.set(id, updated);
    return updated;
  }
  transition(
    id: string,
    expectedState: GenerationJobState,
    nextState: GenerationJobState,
    patch: Parameters<GenerationRepository['transition']>[3] = {},
  ): GenerationJob {
    const job = this.requireJob(id);
    if (job.state !== expectedState) throw new Error('Generation state conflict');
    const updated: GenerationJob = {
      ...job,
      ...patch,
      state: transitionGenerationJob(expectedState, nextState),
      updatedAt: checkedAt,
    };
    this.jobs.set(id, updated);
    return updated;
  }
  registerOutput(jobId: string, artifact: DomainGenerationArtifact): DomainGenerationArtifact {
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }
  getArtifact(id: string): DomainGenerationArtifact | null {
    return this.artifacts.get(id) ?? null;
  }
  listArtifacts(jobId: string): DomainGenerationArtifact[] {
    return [...this.artifacts.values()].filter((artifact) => artifact.jobId === jobId);
  }
  complete(jobId: string, expectedState: GenerationJobState, outputIds: string[]): GenerationJob {
    const completed = this.transition(jobId, expectedState, 'COMPLETED');
    const updated = { ...completed, outputArtifactIds: outputIds };
    this.jobs.set(jobId, updated);
    return updated;
  }
  private requireJob(id: string): GenerationJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Generation job not found');
    return job;
  }
}

function makeGenerationRunner(context: ReturnType<typeof makeFixture>) {
  const repository = new MemoryGenerationRepository();
  const identities: GenerationIdentityPort = {
    requireGenerationIdentity: (teammateId) => {
      if (teammateId !== 'teammate-a') throw new DomainError('INVALID_MODEL_IDENTITY', 'invalid');
      return { runtimeProfileId: 'runtime-a', modelId: 'model-a' };
    },
    validateDestination: async () => undefined,
  };
  const artifacts: AppGenerationArtifactPort = {
    resolveInput: async (): Promise<GenerationResolvedInput> => {
      throw new Error('No inputs are expected by this fixture');
    },
    fingerprint: () => 'fingerprint-a',
    commit: async (): Promise<DomainGenerationArtifact> => {
      throw new Error('No outputs are expected by this fixture');
    },
    verify: async () => undefined,
  };
  const service = new GenerationService(repository, context.gateway, identities, artifacts, {
    id: (() => {
      let next = 0;
      return () => `generation-${next++}`;
    })(),
    now: () => checkedAt,
  });
  const input: Omit<GenerationTask, 'id' | 'createdAt'> = {
    targetTeammateId: 'teammate-a',
    capability: 'IMAGE_GENERATION',
    requiredFeatures: [],
    prompt: 'a small shape',
    inputs: [],
    parameters: {},
    expectedOutput: { artifactKind: 'IMAGE', mimeTypes: ['image/png'] },
    outputDestination: { scope: 'APP_ARTIFACT_STORE' },
    requester: { actorType: 'USER', actorId: null },
    missionId: null,
    runId: null,
    workflowRunId: null,
    workflowStepRunId: null,
  };
  return { repository, service, create: () => service.create(input) };
}
