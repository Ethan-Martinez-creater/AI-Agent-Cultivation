import type { ResolvedRuntime, ResolveRuntime } from './ai-sdk-model-gateway.js';
import {
  classifyHttpFailure,
  classifyProviderError,
  type AvailabilityFailureClassification,
} from './provider-availability.js';

export type ModelAvailabilityProbeKind = 'SUCCESS' | 'HARD_FAILURE' | 'TRANSIENT_FAILURE';

export interface ModelAvailabilityProbeResult {
  kind: ModelAvailabilityProbeKind;
  code: string;
}

export interface AiSdkModelAvailabilityProbeOptions {
  /** Injected in tests; production uses the Main process fetch implementation. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MODEL_LIST_BYTES = 128 * 1024;

const defaultBaseUrls = {
  OPENAI: 'https://api.openai.com/v1',
  ANTHROPIC: 'https://api.anthropic.com/v1',
  GOOGLE: 'https://generativelanguage.googleapis.com/v1beta',
  DEEPSEEK: 'https://api.deepseek.com',
  OPENAI_COMPATIBLE: '',
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeRuntimeFailure(error: unknown): AvailabilityFailureClassification {
  const classified = classifyProviderError(error);
  const code = classified.code;
  if (code === 'MODEL_NOT_FOUND') return { kind: 'HARD_FAILURE', code: 'RUNTIME_NOT_FOUND' };
  if (code === 'AUTHENTICATION_REJECTED' || code === 'PROVIDER_REJECTED_REQUEST') {
    return { kind: 'HARD_FAILURE', code: 'RUNTIME_INVALID' };
  }
  return { kind: 'TRANSIENT_FAILURE', code: 'RUNTIME_RESOLUTION_FAILED' };
}

function safeInvalidRuntime(): ModelAvailabilityProbeResult {
  return { kind: 'HARD_FAILURE', code: 'RUNTIME_INVALID' };
}

function baseUrlFor(runtime: ResolvedRuntime): string | null {
  const base = runtime.baseUrl ?? defaultBaseUrls[runtime.kind];
  if (!base || !base.trim()) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return base.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function modelPathId(runtime: ResolvedRuntime): string {
  const modelId = runtime.modelId.trim();
  return runtime.kind === 'GOOGLE' && modelId.startsWith('models/')
    ? modelId.slice('models/'.length)
    : modelId;
}

function headersFor(runtime: ResolvedRuntime): HeadersInit {
  if (runtime.kind === 'GOOGLE') return { 'x-goog-api-key': runtime.apiKey };
  if (runtime.kind === 'ANTHROPIC') {
    return { 'x-api-key': runtime.apiKey, 'anthropic-version': '2023-06-01' };
  }
  return runtime.apiKey ? { authorization: `Bearer ${runtime.apiKey}` } : {};
}

async function readJsonBounded(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODEL_LIST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

function listModelIds(payload: unknown): string[] | null {
  const record = asRecord(payload);
  const models = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : null;
  if (!models) return null;
  return models.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const model = asRecord(entry);
    const id = model?.id ?? model?.name ?? model?.model;
    return typeof id === 'string' ? [id] : [];
  });
}

function matchesModelId(modelIds: string[], expected: string): boolean {
  return modelIds.some((id) => id === expected || id === `models/${expected}`);
}

/**
 * Performs bounded, non-generating model metadata checks using the same resolved
 * credential source as real model calls. Provider error bodies and credentials
 * are never retained in the result.
 */
export class AiSdkModelAvailabilityProbe {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly resolveRuntime: ResolveRuntime,
    options: AiSdkModelAvailabilityProbeOptions = {},
  ) {
    const fetcher = options.fetch ?? globalThis.fetch;
    this.fetchImplementation = (input, init) => fetcher(input, { ...init, redirect: 'error' });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe(runtimeProfileId: string): Promise<ModelAvailabilityProbeResult> {
    let runtime: ResolvedRuntime | null;
    try {
      runtime = await this.resolveRuntime(runtimeProfileId);
    } catch (error) {
      return safeRuntimeFailure(error);
    }
    if (!runtime) return { kind: 'HARD_FAILURE', code: 'RUNTIME_NOT_FOUND' };

    const baseUrl = baseUrlFor(runtime);
    if (
      !baseUrl ||
      !runtime.modelId.trim() ||
      typeof runtime.apiKey !== 'string' ||
      (runtime.kind !== 'OPENAI_COMPATIBLE' && runtime.apiKey.trim().length === 0)
    ) {
      return safeInvalidRuntime();
    }

    try {
      const checkByList = runtime.kind === 'DEEPSEEK' || runtime.kind === 'OPENAI_COMPATIBLE';
      const modelId = modelPathId(runtime);
      const url = checkByList
        ? `${baseUrl}/models`
        : `${baseUrl}/models/${encodeURIComponent(modelId)}`;
      const response = await this.fetchImplementation(url, {
        method: 'GET',
        headers: headersFor(runtime),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        if (
          runtime.kind === 'OPENAI_COMPATIBLE' &&
          [400, 404, 405, 501].includes(response.status)
        ) {
          // Compatible servers are not required to expose the standard model
          // catalog endpoint. Its absence says nothing about whether a
          // configured model can accept generation requests.
          return { kind: 'TRANSIENT_FAILURE', code: 'MODEL_METADATA_UNAVAILABLE' };
        }
        if (checkByList && response.status === 404) {
          return { kind: 'TRANSIENT_FAILURE', code: 'MODEL_METADATA_UNAVAILABLE' };
        }
        const failure = classifyHttpFailure(response.status);
        return { kind: failure.kind, code: failure.code };
      }

      if (!checkByList) {
        const payload = asRecord(await readJsonBounded(response));
        const returnedId = payload?.id ?? payload?.name;
        if (typeof returnedId !== 'string') {
          return { kind: 'TRANSIENT_FAILURE', code: 'MODEL_METADATA_UNAVAILABLE' };
        }
        if (runtime.kind === 'ANTHROPIC' && payload?.type === 'model') {
          // Anthropic's Get-a-Model endpoint accepts aliases and returns the
          // canonical model id, so a different id is still a successful lookup.
          return { kind: 'SUCCESS', code: 'MODEL_AVAILABLE' };
        }
        if (returnedId === modelId || returnedId === `models/${modelId}`) {
          return { kind: 'SUCCESS', code: 'MODEL_AVAILABLE' };
        }
        return { kind: 'HARD_FAILURE', code: 'MODEL_ID_MISMATCH' };
      }

      const modelIds = listModelIds(await readJsonBounded(response));
      if (!modelIds) return { kind: 'TRANSIENT_FAILURE', code: 'MODEL_METADATA_UNAVAILABLE' };
      return matchesModelId(modelIds, runtime.modelId)
        ? { kind: 'SUCCESS', code: 'MODEL_AVAILABLE' }
        : { kind: 'HARD_FAILURE', code: 'MODEL_NOT_FOUND' };
    } catch (error) {
      const failure = classifyProviderError(error);
      return { kind: failure.kind, code: failure.code };
    }
  }
}
