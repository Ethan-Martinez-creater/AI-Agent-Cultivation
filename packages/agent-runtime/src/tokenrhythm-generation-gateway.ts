import { GenerationCrash } from '@cultivation/application/g1-generation';
import type { GenerationProviderRuntime } from './generation-provider-ports.js';
import type { GenerationModelDescriptor } from '@cultivation/domain/g1-generation';
import type {
  GenerationProviderHttpOptions,
  GenerationProviderMediaCache,
  GenerationProviderStatePort,
  GenerationRuntimeResolver,
} from './generation-provider-ports.js';
import {
  boundedString,
  CommercialGenerationGateway,
  decisionFromHttpError,
  fail,
  isRecord,
  outputIdForUrl,
  providerStatus,
  safeProviderId,
  statusErrorCode,
  type CommercialGatewayConfig,
  type CommercialOutputSource,
  type CommercialSubmissionDecision,
} from './commercial-generation-http.js';

const MiB = 1024 * 1024;
const QWEN_IMAGE_MODEL = 'qwen-image-2.0';
const WAN_IMAGE_MODEL = 'wan2.7-image';
const WAN_VIDEO_MODEL = 'wan3.0-video';
const VIDEO_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const VIDEO_RESOLUTIONS = ['480P', '720P', '1080P'];

export class TokenRhythmGenerationGateway extends CommercialGenerationGateway {
  constructor(
    resolveRuntime: GenerationRuntimeResolver,
    states: GenerationProviderStatePort,
    cache: GenerationProviderMediaCache,
    options: GenerationProviderHttpOptions = {},
  ) {
    super(resolveRuntime, states, cache, tokenRhythmConfig(), options);
  }
}

function tokenRhythmConfig(): CommercialGatewayConfig {
  return {
    provider: 'TOKENRHYTHM',
    descriptor: descriptorFor,
    async verifyDescriptor(runtime, _descriptor, fetchJson) {
      const { response, payload } = await fetchJson(runtime, '/models');
      if (!response.ok) fail(statusErrorCode(response.status, 'MODEL_UNAVAILABLE'));
      if (!isRecord(payload) || !Array.isArray(payload.models) || payload.models.length > 4096)
        fail('MODEL_UNAVAILABLE');
      // TokenRhythm's discovery endpoint currently lists LLMs only. It confirms key and API
      // connectivity; media capabilities remain the fixed documented descriptors below.
    },
    endpoint(runtime) {
      if (isImageModel(runtime.modelId)) return '/images/generations';
      if (runtime.modelId === WAN_VIDEO_MODEL) return '/videos/generations';
      fail('MODEL_NOT_FOUND');
    },
    async prepare(runtime, request) {
      if (request.inputs.length) fail('UNSUPPORTED_INPUT_ROLE');
      if (isImageModel(runtime.modelId)) {
        return {
          body: {
            model: runtime.modelId,
            prompt: request.prompt,
            n: 1,
            size: '1024x1024',
          },
          uploadedFiles: [],
        };
      }
      if (runtime.modelId === WAN_VIDEO_MODEL) {
        return {
          body: {
            model: WAN_VIDEO_MODEL,
            content: [{ type: 'text', text: request.prompt }],
            resolution: request.parameters.resolution ?? '720P',
            duration: request.parameters.durationSeconds ?? 5,
            ratio: request.parameters.aspect ?? '16:9',
          },
          uploadedFiles: [],
        };
      }
      fail('MODEL_NOT_FOUND');
    },
    verifyPrepared(body, state, request) {
      if (state.uploadedFiles.length || request.inputs.length) return false;
      if (isImageModel(request.modelId)) {
        return (
          body.model === request.modelId &&
          body.prompt === request.prompt &&
          body.n === 1 &&
          body.size === '1024x1024' &&
          Object.keys(body).length === 4
        );
      }
      return (
        request.modelId === WAN_VIDEO_MODEL &&
        body.model === WAN_VIDEO_MODEL &&
        body.prompt === undefined &&
        Array.isArray(body.content) &&
        body.content.length === 1 &&
        isRecord(body.content[0]) &&
        body.content[0].type === 'text' &&
        body.content[0].text === request.prompt &&
        body.duration === (request.parameters.durationSeconds ?? 5) &&
        body.ratio === (request.parameters.aspect ?? '16:9') &&
        body.resolution === (request.parameters.resolution ?? '720P') &&
        Object.keys(body).length === 5
      );
    },
    submission(_runtime, request, response, payload): CommercialSubmissionDecision {
      if (!response.ok)
        return decisionFromHttpError(response.status, payload) ?? { kind: 'UNKNOWN' };
      if (!isRecord(payload)) return { kind: 'UNKNOWN' };
      if (isImageModel(request.modelId)) {
        const data = payload.data;
        if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0]))
          return { kind: 'UNKNOWN' };
        const rawUrl = data[0].url;
        if (!boundedString(rawUrl, 8192)) return { kind: 'UNKNOWN' };
        const providerJobId = request.idempotencyKey;
        const output: CommercialOutputSource = {
          id: outputIdForUrl(0, rawUrl),
          url: rawUrl,
          metadata: {},
        };
        const persistedBody = JSON.stringify({
          localSyncResult: true,
          outputs: [output],
        });
        return {
          kind: 'SUBMITTED',
          providerJobId,
          status: 'RUNNING',
          persistedBody,
        };
      }
      if (request.modelId !== WAN_VIDEO_MODEL) return { kind: 'UNKNOWN' };
      if (response.status !== 202 || !safeProviderId(payload.id) || payload.status !== 'queued')
        return { kind: 'UNKNOWN' };
      return { kind: 'SUBMITTED', providerJobId: payload.id, status: 'QUEUED' };
    },
    async query(runtime, providerJobId, state, fetchJson) {
      if (isImageModel(runtime.modelId)) {
        if (!state || state.phase !== 'SUBMITTED' || state.providerJobId !== providerJobId)
          return { status: 'UNKNOWN', outputs: [], errorCode: null };
        let stored: unknown;
        try {
          stored = JSON.parse(state.exactBody) as unknown;
        } catch {
          fail('INTERNAL_ERROR');
        }
        if (!isRecord(stored) || stored.localSyncResult !== true || !Array.isArray(stored.outputs))
          fail('INTERNAL_ERROR');
        const outputs = stored.outputs.map((entry, index) => {
          if (
            !isRecord(entry) ||
            !safeProviderId(entry.id) ||
            !boundedString(entry.url, 8192) ||
            entry.id !== outputIdForUrl(index, entry.url)
          )
            fail('INTERNAL_ERROR');
          return {
            id: entry.id,
            url: entry.url,
            metadata: isRecord(entry.metadata) ? entry.metadata : {},
          };
        });
        return { status: 'COMPLETED', outputs, errorCode: null };
      }

      if (runtime.modelId !== WAN_VIDEO_MODEL || !safeProviderId(providerJobId))
        return { status: 'UNKNOWN', outputs: [], errorCode: null };
      const { response, payload } = await fetchJson(
        runtime,
        '/videos/' + encodeURIComponent(providerJobId),
      );
      if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500)
          throw new GenerationCrash(
            'TokenRhythm status query was interrupted; the generation job is retained.',
          );
        fail(statusErrorCode(response.status, 'GENERATION_FAILED'));
      }
      if (!isRecord(payload) || payload.id !== providerJobId) fail('INTERNAL_ERROR');
      const status = providerStatus(payload.status);
      if (status === 'FAILED' || status === 'CANCELLED')
        return { status, outputs: [], errorCode: 'GENERATION_FAILED' };
      if (status !== 'COMPLETED') return { status, outputs: [], errorCode: null };
      const result = isRecord(payload.result) ? payload.result : null;
      const url = typeof result?.url === 'string' ? result.url : null;
      if (!url || !boundedString(url, 8192)) fail('OUTPUT_MISSING');
      return {
        status,
        outputs: [{ id: outputIdForUrl(0, url), url, metadata: result ?? {} }],
        errorCode: null,
      };
    },
  };
}

function isImageModel(modelId: string): boolean {
  return modelId === QWEN_IMAGE_MODEL || modelId === WAN_IMAGE_MODEL;
}

function descriptorFor(runtime: GenerationProviderRuntime): GenerationModelDescriptor {
  if (isImageModel(runtime.modelId)) {
    return {
      modelId: runtime.modelId,
      outputCapability: 'IMAGE_GENERATION',
      executionMode: 'SYNC',
      featureTags: ['TEXT_TO_IMAGE'],
      inputRoles: [],
      parameterSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputTypes: ['image/png'],
      limits: {
        maxInputFiles: 0,
        maxInputBytes: 0,
        maxOutputBytes: 64 * MiB,
        maxOutputs: 1,
      },
    };
  }
  if (runtime.modelId === WAN_VIDEO_MODEL) {
    return {
      modelId: WAN_VIDEO_MODEL,
      outputCapability: 'VIDEO_GENERATION',
      executionMode: 'ASYNC_JOB',
      featureTags: ['TEXT_TO_VIDEO'],
      // TokenRhythm accepts public HTTPS media URLs for conditioning, but this gateway owns only
      // trusted artifact streams. It intentionally advertises the verified text-only path.
      inputRoles: [],
      parameterSchema: {
        type: 'object',
        properties: {
          durationSeconds: { type: 'integer', minimum: 2, maximum: 30, default: 5 },
          aspect: { type: 'string', enum: VIDEO_ASPECTS, default: '16:9' },
          resolution: { type: 'string', enum: VIDEO_RESOLUTIONS, default: '720P' },
        },
        additionalProperties: false,
      },
      outputTypes: ['video/mp4'],
      limits: {
        minDurationSeconds: 2,
        maxDurationSeconds: 30,
        maxInputFiles: 0,
        maxInputBytes: 0,
        maxOutputBytes: 512 * MiB,
        maxOutputs: 1,
      },
    };
  }
  fail('MODEL_NOT_FOUND');
}
