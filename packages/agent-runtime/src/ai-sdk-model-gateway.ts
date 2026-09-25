import {
  generateText,
  streamText,
  type CallSettings,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelUsage,
} from '@cultivation/application';
import { createDeepSeek } from '@ai-sdk/deepseek';

export type RuntimeProviderKind =
  | 'OPENAI'
  | 'ANTHROPIC'
  | 'GOOGLE'
  | 'DEEPSEEK'
  | 'OPENAI_COMPATIBLE';

/** Resolved only in the Main process; apiKey is never part of renderer contracts. */
export interface ResolvedRuntime {
  kind: RuntimeProviderKind;
  baseUrl: string | null;
  modelId: string;
  apiKey: string;
  parameters?: Record<string, unknown>;
}

export type ResolveRuntime = (runtimeProfileId: string) => Promise<ResolvedRuntime | null>;

export interface AiSdkModelGatewayOptions {
  /** Allows deterministic adapter tests without making network requests. */
  fetch?: typeof globalThis.fetch;
}

export type ModelGatewayErrorCode =
  | 'RUNTIME_NOT_FOUND'
  | 'RUNTIME_UNAVAILABLE'
  | 'INVALID_RUNTIME'
  | 'UNSUPPORTED_PROVIDER'
  | 'PROVIDER_REQUEST_FAILED';

const safeErrorMessages: Record<ModelGatewayErrorCode, string> = {
  RUNTIME_NOT_FOUND: 'Runtime profile was not found.',
  RUNTIME_UNAVAILABLE: 'Runtime profile is unavailable.',
  INVALID_RUNTIME: 'Runtime profile settings are incomplete or invalid.',
  UNSUPPORTED_PROVIDER: 'This provider type is not supported.',
  PROVIDER_REQUEST_FAILED: 'Provider request failed. Check provider settings and connectivity.',
};

/** Safe to return across IPC: it never retains the provider error or its cause. */
export class ModelGatewayError extends Error {
  constructor(readonly code: ModelGatewayErrorCode) {
    super(safeErrorMessages[code]);
    this.name = 'ModelGatewayError';
  }
}

const generationSettingKeys = [
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'maxOutputTokens',
] as const satisfies ReadonlyArray<keyof CallSettings>;

function generationSettings(parameters: Record<string, unknown> | undefined): CallSettings {
  if (!parameters) return {};

  const settings: CallSettings = {};
  for (const key of generationSettingKeys) {
    const value = parameters[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      Object.assign(settings, { [key]: value });
    }
  }

  const stopSequences = parameters.stopSequences;
  if (
    Array.isArray(stopSequences) &&
    stopSequences.every((sequence): sequence is string => typeof sequence === 'string')
  ) {
    settings.stopSequences = stopSequences;
  }

  const seed = parameters.seed;
  if (typeof seed === 'number' && Number.isSafeInteger(seed)) settings.seed = seed;

  const maxRetries = parameters.maxRetries;
  if (typeof maxRetries === 'number' && Number.isInteger(maxRetries) && maxRetries >= 0) {
    settings.maxRetries = maxRetries;
  }

  return settings;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function hasNumericPath(value: unknown, ...path: string[]): boolean {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return false;
    current = record[segment];
  }
  return typeof current === 'number' && Number.isFinite(current);
}

function reportedDetail(
  raw: unknown,
  path: string[],
  normalizedValue: number | undefined,
): number | null {
  if (hasNumericPath(raw, ...path)) return normalizedValue ?? null;
  // AI SDK aggregates stream usage and drops provider raw payloads. Preserve a
  // non-zero normalized detail in that case, while treating adapter default 0s
  // as unknown because the provider may not have reported the field.
  return raw === undefined && normalizedValue !== undefined && normalizedValue !== 0
    ? normalizedValue
    : null;
}

function providerReportedUsage(kind: RuntimeProviderKind, usage: LanguageModelUsage): ModelUsage {
  const raw = usage.raw;
  const isChatCompletion = kind === 'OPENAI' || kind === 'DEEPSEEK' || kind === 'OPENAI_COMPATIBLE';
  const inputPath = isChatCompletion
    ? ['prompt_tokens']
    : kind === 'ANTHROPIC'
      ? ['input_tokens']
      : ['promptTokenCount'];
  const outputPath = isChatCompletion
    ? ['completion_tokens']
    : kind === 'ANTHROPIC'
      ? ['output_tokens']
      : ['candidatesTokenCount'];
  const cachedPath = isChatCompletion
    ? ['prompt_tokens_details', 'cached_tokens']
    : kind === 'ANTHROPIC'
      ? ['cache_read_input_tokens']
      : ['cachedContentTokenCount'];
  const reasoningPath = isChatCompletion
    ? ['completion_tokens_details', 'reasoning_tokens']
    : kind === 'ANTHROPIC'
      ? ['output_tokens_details', 'thinking_tokens']
      : ['thoughtsTokenCount'];

  return {
    inputTokens: reportedDetail(raw, inputPath, usage.inputTokens),
    outputTokens: reportedDetail(raw, outputPath, usage.outputTokens),
    cachedInputTokens: reportedDetail(
      raw,
      cachedPath,
      usage.inputTokenDetails.cacheReadTokens ?? usage.cachedInputTokens,
    ),
    reasoningTokens: reportedDetail(
      raw,
      reasoningPath,
      usage.outputTokenDetails.reasoningTokens ?? usage.reasoningTokens,
    ),
  };
}

function toSdkMessages(messages: ModelRequest['messages']) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  return {
    ...(system.length > 0 ? { system } : {}),
    messages: messages.filter((message) => message.role !== 'system'),
  };
}

function nonBlank(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

/** AI SDK Core-backed provider dispatch. This class does not implement domain agents. */
export class AiSdkModelGateway implements ModelGateway {
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(
    private readonly resolveRuntime: ResolveRuntime,
    options: AiSdkModelGatewayOptions = {},
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const runtime = await this.getRuntime(request.runtimeProfileId);
      const result = await generateText({
        model: this.createModel(runtime),
        ...toSdkMessages(request.messages),
        ...generationSettings(runtime.parameters),
      });

      return { text: result.text, usage: providerReportedUsage(runtime.kind, result.usage) };
    } catch (error) {
      throw this.toSafeError(error);
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    try {
      const runtime = await this.getRuntime(request.runtimeProfileId);
      let providerUsage: LanguageModelUsage | undefined;
      const result = streamText({
        model: this.createModel(runtime),
        ...toSdkMessages(request.messages),
        ...generationSettings(runtime.parameters),
        onStepFinish({ usage }) {
          providerUsage = usage;
        },
      });

      let didFinish = false;
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          yield { type: 'text-delta', text: part.text };
        } else if (part.type === 'finish') {
          didFinish = true;
          yield {
            type: 'finish',
            usage: providerReportedUsage(runtime.kind, providerUsage ?? part.totalUsage),
          };
        } else if (part.type === 'error') {
          throw new ModelGatewayError('PROVIDER_REQUEST_FAILED');
        }
      }

      if (!didFinish) throw new ModelGatewayError('PROVIDER_REQUEST_FAILED');
    } catch (error) {
      throw this.toSafeError(error);
    }
  }

  async testConnection(runtimeProfileId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const runtime = await this.getRuntime(runtimeProfileId);
      await generateText({
        model: this.createModel(runtime),
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        maxOutputTokens: 1,
        maxRetries: 0,
      });
      return { ok: true, message: `Connection succeeded for model ${runtime.modelId}.` };
    } catch (error) {
      return { ok: false, message: this.toSafeError(error).message };
    }
  }

  private async getRuntime(runtimeProfileId: string): Promise<ResolvedRuntime> {
    let runtime: ResolvedRuntime | null;
    try {
      runtime = await this.resolveRuntime(runtimeProfileId);
    } catch {
      throw new ModelGatewayError('RUNTIME_UNAVAILABLE');
    }

    if (!runtime) throw new ModelGatewayError('RUNTIME_NOT_FOUND');
    if (
      !runtime.modelId.trim() ||
      typeof runtime.apiKey !== 'string' ||
      runtime.apiKey.trim().length === 0
    ) {
      throw new ModelGatewayError('INVALID_RUNTIME');
    }
    if (runtime.baseUrl !== null && !nonBlank(runtime.baseUrl)) {
      throw new ModelGatewayError('INVALID_RUNTIME');
    }
    return runtime;
  }

  private createModel(runtime: ResolvedRuntime): LanguageModel {
    const baseURL = runtime.baseUrl ?? undefined;
    const common = { apiKey: runtime.apiKey, fetch: this.fetchImplementation };

    switch (runtime.kind) {
      case 'OPENAI':
        return createOpenAI({ ...common, baseURL }).chat(runtime.modelId);
      case 'ANTHROPIC':
        return createAnthropic({ ...common, baseURL }).messages(runtime.modelId);
      case 'GOOGLE':
        return createGoogleGenerativeAI({ ...common, baseURL })(runtime.modelId);
      case 'DEEPSEEK':
        return createDeepSeek({
          ...common,
          baseURL: runtime.baseUrl ?? 'https://api.deepseek.com',
        }).chat(runtime.modelId);
      case 'OPENAI_COMPATIBLE':
        if (!nonBlank(runtime.baseUrl)) throw new ModelGatewayError('INVALID_RUNTIME');
        return createOpenAICompatible({
          ...common,
          name: 'openai-compatible',
          baseURL: runtime.baseUrl,
          includeUsage: true,
        })(runtime.modelId);
      default:
        throw new ModelGatewayError('UNSUPPORTED_PROVIDER');
    }
  }

  private toSafeError(error: unknown): ModelGatewayError {
    if (error instanceof ModelGatewayError) return error;
    return new ModelGatewayError('PROVIDER_REQUEST_FAILED');
  }
}
