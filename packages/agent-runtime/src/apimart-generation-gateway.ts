import { GenerationCrash } from '@cultivation/application/g1-generation';
import type { ProviderGenerationRequest } from '@cultivation/application/g1-generation';
import type { GenerationModelDescriptor } from '@cultivation/domain/g1-generation';
import type {
  GenerationProviderHttpOptions,
  GenerationProviderMediaCache,
  GenerationProviderRuntime,
  GenerationProviderStatePort,
  GenerationRuntimeResolver,
  GenerationUploadedInput,
} from './generation-provider-ports.js';
import {
  boundedString,
  canonicalMime,
  CommercialGenerationGateway,
  decisionFromHttpError,
  fail,
  isAllowedProviderUrl,
  isRecord,
  outputIdForUrl,
  providerStatus,
  safeProviderId,
  sha256,
  statusErrorCode,
  type CommercialGatewayConfig,
  type CommercialOutputSource,
  type CommercialSubmissionDecision,
} from './commercial-generation-http.js';

const MiB = 1024 * 1024;
const IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
const VIDEO_MODEL = 'wan2.7';
const MUSIC_MODEL = 'suno';
const IMAGE_ASPECTS = [
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '5:4',
  '4:5',
  '21:9',
  'auto',
];
const VIDEO_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'];

export class ApiMartGenerationGateway extends CommercialGenerationGateway {
  constructor(
    resolveRuntime: GenerationRuntimeResolver,
    states: GenerationProviderStatePort,
    cache: GenerationProviderMediaCache,
    options: GenerationProviderHttpOptions = {},
  ) {
    super(resolveRuntime, states, cache, createApiMartConfig(options), options);
  }
}

function createApiMartConfig(options: GenerationProviderHttpOptions): CommercialGatewayConfig {
  return {
    provider: 'APIMART',
    descriptor: descriptorFor,
    async verifyDescriptor(runtime, descriptor, fetchJson) {
      const { response, payload } = await fetchJson(runtime, '/models?expand=parameters');
      if (!response.ok) fail(statusErrorCode(response.status, 'MODEL_UNAVAILABLE'));
      if (
        !isRecord(payload) ||
        payload.object !== 'list' ||
        (Object.hasOwn(payload, 'success') && payload.success !== true) ||
        !Array.isArray(payload.data) ||
        payload.data.length > 4096
      )
        fail('MODEL_UNAVAILABLE');
      if (!payload.data.some((model) => isRecord(model) && model.id === descriptor.modelId))
        fail('MODEL_NOT_FOUND');
    },
    endpoint(runtime) {
      switch (runtime.modelId) {
        case IMAGE_MODEL:
          return '/images/generations';
        case VIDEO_MODEL:
          return '/videos/generations';
        case MUSIC_MODEL:
          return '/music/generations';
        default:
          fail('MODEL_NOT_FOUND');
      }
    },
    async prepare(runtime, request, descriptor, uploadImage) {
      const orderedInputs = orderInputs(runtime.modelId, request);
      const uploadedFiles: GenerationUploadedInput[] = [];
      const uploadedUrls: string[] = [];
      for (const input of orderedInputs) {
        const uploaded = await uploadImage(runtime, input, 10 * MiB);
        uploadedFiles.push(uploaded.identity);
        uploadedUrls.push(uploaded.url);
      }
      return {
        body: buildRequestBody(runtime, request, descriptor, uploadedUrls),
        uploadedFiles,
      };
    },
    verifyPrepared(body, state, request) {
      return verifyPreparedBody(body, state.uploadedFiles, request, options.testOnly === true);
    },
    submission(_runtime, _request, response, payload): CommercialSubmissionDecision {
      if (!response.ok)
        return decisionFromHttpError(response.status, payload) ?? { kind: 'UNKNOWN' };
      if (!isRecord(payload)) return { kind: 'UNKNOWN' };
      const data = payload.data;
      const submitted =
        Array.isArray(data) && data.length === 1 && isRecord(data[0]) ? data[0] : null;
      if (submitted?.status !== 'submitted' || !safeProviderId(submitted.task_id))
        return { kind: 'UNKNOWN' };
      return { kind: 'SUBMITTED', providerJobId: submitted.task_id, status: 'QUEUED' };
    },
    async query(runtime, providerJobId, _state, fetchJson) {
      if (!safeProviderId(providerJobId))
        return { status: 'UNKNOWN', outputs: [], errorCode: null };
      const path =
        runtime.modelId === MUSIC_MODEL
          ? '/music/tasks/' + encodeURIComponent(providerJobId)
          : '/tasks/' + encodeURIComponent(providerJobId);
      const { response, payload } = await fetchJson(runtime, path);
      if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500)
          throw new GenerationCrash(
            'APIMart status query was interrupted; the generation job is retained.',
          );
        fail(statusErrorCode(response.status, 'GENERATION_FAILED'));
      }
      if (!isRecord(payload)) fail('INTERNAL_ERROR');
      const data = isRecord(payload.data) ? payload.data : null;
      if (!data || (data.id !== providerJobId && data.task_id !== providerJobId))
        fail('INTERNAL_ERROR');
      const status = providerStatus(data.status);
      if (status === 'FAILED') return { status, outputs: [], errorCode: 'GENERATION_FAILED' };
      if (status === 'CANCELLED') return { status, outputs: [], errorCode: 'GENERATION_FAILED' };
      if (status !== 'COMPLETED') return { status, outputs: [], errorCode: null };
      const result = isRecord(data.result) ? data.result : null;
      if (!result) fail('OUTPUT_MISSING');
      const rawOutputs =
        runtime.modelId === MUSIC_MODEL
          ? extractMusicOutputs(result)
          : runtime.modelId === IMAGE_MODEL
            ? extractMediaOutputs(result.images)
            : extractMediaOutputs(result.videos);
      if (!rawOutputs.length) fail('OUTPUT_MISSING');
      const outputs: CommercialOutputSource[] = rawOutputs.map((value, index) => ({
        id: outputIdForUrl(index, value.url),
        url: value.url,
        metadata: value.metadata,
      }));
      return { status, outputs, errorCode: null };
    },
  };
}

function descriptorFor(runtime: GenerationProviderRuntime): GenerationModelDescriptor {
  if (runtime.modelId === IMAGE_MODEL) {
    return {
      modelId: IMAGE_MODEL,
      outputCapability: 'IMAGE_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: ['TEXT_TO_IMAGE', 'REFERENCE_CONDITIONING'],
      inputRoles: [
        {
          role: 'REFERENCE_IMAGE',
          artifactKinds: ['IMAGE'],
          mimeTypes: ['image/png', 'image/jpeg'],
          maxFiles: 14,
        },
      ],
      parameterSchema: {
        type: 'object',
        properties: {
          aspect: { type: 'string', enum: IMAGE_ASPECTS, default: '1:1' },
        },
        additionalProperties: false,
      },
      outputTypes: ['image/png', 'image/jpeg'],
      limits: {
        maxInputFiles: 14,
        maxInputBytes: 128 * MiB,
        maxOutputBytes: 64 * MiB,
        maxOutputs: 1,
      },
    };
  }
  if (runtime.modelId === VIDEO_MODEL) {
    return {
      modelId: VIDEO_MODEL,
      outputCapability: 'VIDEO_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: ['TEXT_TO_VIDEO', 'FIRST_FRAME_CONDITIONING'],
      inputRoles: [
        {
          role: 'FIRST_FRAME',
          artifactKinds: ['IMAGE'],
          mimeTypes: ['image/png', 'image/jpeg'],
          maxFiles: 1,
        },
      ],
      parameterSchema: {
        type: 'object',
        properties: {
          durationSeconds: { type: 'integer', minimum: 2, maximum: 15, default: 5 },
          aspect: { type: 'string', enum: VIDEO_ASPECTS, default: '16:9' },
          resolution: { type: 'string', enum: ['720P', '1080P'], default: '1080P' },
        },
        additionalProperties: false,
      },
      outputTypes: ['video/mp4'],
      limits: {
        minDurationSeconds: 2,
        maxDurationSeconds: 15,
        maxInputFiles: 1,
        maxInputBytes: 20 * MiB,
        maxOutputBytes: 512 * MiB,
        maxOutputs: 1,
      },
    };
  }
  if (runtime.modelId === MUSIC_MODEL) {
    return {
      modelId: MUSIC_MODEL,
      outputCapability: 'MUSIC_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: ['TEXT_TO_MUSIC'],
      inputRoles: [],
      parameterSchema: {
        type: 'object',
        properties: {
          durationSeconds: { type: 'integer', minimum: 10, maximum: 360 },
          version: { type: 'string', enum: ['v6'], default: 'v6' },
          audioFormat: { type: 'string', enum: ['wav', 'mp3'], default: 'wav' },
        },
        additionalProperties: false,
      },
      outputTypes: ['audio/wav', 'audio/mpeg'],
      limits: {
        minDurationSeconds: 10,
        maxDurationSeconds: 360,
        maxInputFiles: 0,
        maxInputBytes: 0,
        maxOutputBytes: 256 * MiB,
        maxOutputs: 8,
      },
    };
  }
  fail('MODEL_NOT_FOUND');
}

function orderInputs(modelId: string, request: ProviderGenerationRequest) {
  if (modelId === IMAGE_MODEL) {
    if (request.inputs.some((input) => input.role !== 'REFERENCE_IMAGE'))
      fail('UNSUPPORTED_INPUT_ROLE');
    return request.inputs;
  }
  if (modelId === VIDEO_MODEL) {
    if (request.inputs.some((input) => input.role !== 'FIRST_FRAME'))
      fail('UNSUPPORTED_INPUT_ROLE');
    return request.inputs;
  }
  if (request.inputs.length) fail('UNSUPPORTED_INPUT_ROLE');
  return [];
}

function buildRequestBody(
  runtime: GenerationProviderRuntime,
  request: ProviderGenerationRequest,
  descriptor: GenerationModelDescriptor,
  uploadedUrls: string[],
): Record<string, unknown> {
  if (request.modelId === IMAGE_MODEL) {
    const body: Record<string, unknown> = {
      model: IMAGE_MODEL,
      prompt: request.prompt,
      size: request.parameters.aspect ?? '1:1',
      resolution: '1K',
      n: 1,
    };
    if (uploadedUrls.length) body.image_urls = uploadedUrls.map((url) => ({ url }));
    return body;
  }
  if (request.modelId === VIDEO_MODEL) {
    const body: Record<string, unknown> = {
      model: VIDEO_MODEL,
      prompt: request.prompt,
      duration: request.parameters.durationSeconds ?? 5,
      resolution: request.parameters.resolution ?? '1080P',
      size: request.parameters.aspect ?? '16:9',
    };
    if (uploadedUrls.length) body.image_urls = uploadedUrls;
    return body;
  }
  if (request.modelId === MUSIC_MODEL) {
    const body: Record<string, unknown> = {
      model: MUSIC_MODEL,
      custom: false,
      version: request.parameters.version ?? 'v6',
      prompt: request.prompt,
      audio_format: request.parameters.audioFormat ?? 'wav',
    };
    if (request.parameters.durationSeconds !== undefined)
      body.duration = request.parameters.durationSeconds;
    return body;
  }
  fail('MODEL_NOT_FOUND');
}

function verifyPreparedBody(
  body: Record<string, unknown>,
  uploadedFiles: GenerationUploadedInput[],
  request: ProviderGenerationRequest,
  testOnly: boolean,
): boolean {
  try {
    const orderedInputs = orderInputs(request.modelId, request);
    if (uploadedFiles.length !== orderedInputs.length) return false;
    for (let index = 0; index < uploadedFiles.length; index += 1) {
      const stored = uploadedFiles[index]!;
      const input = orderedInputs[index]!;
      if (
        stored.artifactId !== input.artifactId ||
        stored.role !== input.role ||
        stored.mimeType !== canonicalMime(input.mimeType) ||
        stored.sizeBytes !== input.sizeBytes ||
        stored.contentHash !== input.contentHash.toLowerCase() ||
        !/^[a-f0-9]{64}$/.test(stored.fileId)
      )
        return false;
    }
    const rawUrls = Array.isArray(body.image_urls) ? body.image_urls : [];
    const urls =
      request.modelId === IMAGE_MODEL
        ? rawUrls.map((value) => (isRecord(value) ? value.url : null))
        : rawUrls;
    if (urls.length !== orderedInputs.length) return false;
    for (let index = 0; index < urls.length; index += 1) {
      const value = urls[index];
      if (typeof value !== 'string' || sha256(value) !== uploadedFiles[index]?.fileId) return false;
      if (!isAllowedProviderUrl(value, 'APIMART', testOnly)) return false;
    }
    const descriptor = descriptorFor({ modelId: request.modelId } as GenerationProviderRuntime);
    const expected = buildRequestBody(
      { modelId: request.modelId } as GenerationProviderRuntime,
      request,
      descriptor,
      urls as string[],
    );
    return stableRecord(body) === stableRecord(expected);
  } catch {
    return false;
  }
}

function stableRecord(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

function extractMusicOutputs(
  result: Record<string, unknown>,
): Array<{ url: string; metadata: Record<string, unknown> }> {
  const music = result.music;
  if (!Array.isArray(music) || music.length > 8) fail('OUTPUT_MISSING');
  return music.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.audio_url !== 'string' ||
      !boundedString(value.audio_url, 8192)
    )
      fail('OUTPUT_MISSING');
    return { url: value.audio_url, metadata: value };
  });
}

function extractMediaOutputs(
  value: unknown,
): Array<{ url: string; metadata: Record<string, unknown> }> {
  if (!Array.isArray(value) || value.length > 8) fail('OUTPUT_MISSING');
  const result: Array<{ url: string; metadata: Record<string, unknown> }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) fail('OUTPUT_MISSING');
    const urls = entry.url;
    const list = typeof urls === 'string' ? [urls] : Array.isArray(urls) ? urls : [];
    if (!list.length || list.length > 8 || list.some((url) => !boundedString(url, 8192)))
      fail('OUTPUT_MISSING');
    for (const url of list as string[]) result.push({ url, metadata: entry });
    if (result.length > 8) fail('OUTPUT_MISSING');
  }
  return result;
}
