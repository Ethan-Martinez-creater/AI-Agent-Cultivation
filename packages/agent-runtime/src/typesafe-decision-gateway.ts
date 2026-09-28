import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeClient,
  TypeSafeError,
} from '@typesafe-ai/sdk';
import type {
  ChoiceQuestion,
  Fetch,
  ModelCard,
  NoulQuestion,
  Questions as SdkQuestions,
} from '@typesafe-ai/sdk';
import type {
  DecisionGateway,
  DecisionErrorCode,
  DecisionRequest,
  DecisionResult,
  DecisionType,
} from '@cultivation/application/r0-decision';
import { z } from 'zod';

/** The production shadow model is pinned so receipts remain comparable over time. */
export const TYPESAFE_DECISION_MODEL = 'jev-1.13.0';
export const TYPESAFE_DECISION_PROVIDER = 'TYPESAFE';
export const TYPESAFE_DECISION_PROVIDER_VERSION = 'typesafe-sdk@0.6.0';
export const DEFAULT_TYPESAFE_TIMEOUT_MS = 10_000;
export const MAX_TYPESAFE_TIMEOUT_MS = 30_000;
export const MAX_TYPESAFE_STATE_BYTES = 24_000;
export const MAX_TYPESAFE_QUESTIONS_BYTES = 24_000;
export const MAX_TYPESAFE_REQUEST_BYTES = 48_000;

type TypeSafeEntry =
  | string
  | number
  | boolean
  | null
  | TypeSafeEntry[]
  | { [key: string]: TypeSafeEntry };
type TypeSafeQuestion = NoulQuestion | ChoiceQuestion<Record<string, string | null>>;
type TypeSafeQuestionMap = Record<string, TypeSafeQuestion>;

/** R3-only fields are kept out of domain and SDK contracts. */
export type TypeSafeDecisionRequest = DecisionRequest & {
  state: Record<string, unknown>;
  questions: TypeSafeQuestionMap;
};

export type TypeSafeDecisionErrorCode = DecisionErrorCode;
export type TypeSafeConnectionErrorCode = TypeSafeDecisionErrorCode | 'MODEL_UNAVAILABLE';

export interface TypeSafeDecisionResult extends DecisionResult {
  provider: typeof TYPESAFE_DECISION_PROVIDER;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  errorCode: TypeSafeDecisionErrorCode | null;
}

export interface TypeSafeConnectionResult {
  ok: boolean;
  model: string;
  errorCode: TypeSafeConnectionErrorCode | null;
  latencyMs: number;
}

export interface TypeSafeDecisionGatewayOptions {
  /** Supply only from Main-process SecretStore after decrypting safeStorage data. */
  apiKey: string;
  timeoutMs?: number;
  /** Test seam for deterministic transport tests; production uses Node fetch. */
  fetch?: Fetch;
  /** Test or enterprise API endpoint override. Production defaults to api.typesafe.ai. */
  baseURL?: string;
}

const noopLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const boundedProbability = z.number().finite().min(0).max(1);
const safeAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: boundedProbability }).strict(),
  z
    .object({
      type: z.literal('choice'),
      choice: z.string().min(1).max(128),
      confidence: boundedProbability,
      probabilities: z.record(z.string(), boundedProbability),
    })
    .strict(),
]);
const responseSchema = z
  .object({
    model: z.string().min(1).max(128),
    answers: z.record(z.string(), safeAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const modelListSchema = z.array(
  z
    .object({
      name: z.string().min(1).max(128),
      description: z.string(),
      release_date: z.string().min(1).max(32),
    })
    .strict(),
);

const stateSchema = z.record(z.string(), z.unknown());
const instructionSchema = z.string().min(1).max(2_000);
const criteriaValueSchema = z.string().max(500).nullable();
const questionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('noul'),
      instructions: instructionSchema,
      criteria: z
        .object({
          true: criteriaValueSchema.optional(),
          false: criteriaValueSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('choice'),
      instructions: instructionSchema,
      criteria: z
        .record(z.string().min(1).max(128), criteriaValueSchema)
        .refine(
          (criteria) => Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 32,
          'choice questions require 2 to 32 named criteria',
        ),
    })
    .strict(),
]);
const questionMapSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/), questionSchema)
  .refine((questions) => Object.keys(questions).length > 0 && Object.keys(questions).length <= 32);

const unsafeStateKey =
  /(?:api.?key|credential|authorization|secret|memory|chat.?history|conversation.?history|messages|full.?history|file.?content|tool.?output|events?|audit)/i;

const capabilityDimensions = [
  'GENERAL_REASONING',
  'LONG_CONTEXT_REASONING',
  'AGENTIC_EXECUTION',
  'CODING',
  'TOOL_USE',
  'VISUAL_UNDERSTANDING',
  'IMAGE_GENERATION',
  'IMAGE_EDITING',
  'VIDEO_GENERATION',
  'VIDEO_EDITING',
  'SPEECH_UNDERSTANDING',
  'SPEECH_GENERATION',
  'SPEECH_TO_SPEECH',
  'MUSIC_GENERATION',
] as const;

const isPlainJsonTree = (value: unknown, depth = 0): value is TypeSafeEntry => {
  if (depth > 10) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 4_000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJsonTree(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(
    ([key, child]) =>
      key.length <= 128 && !unsafeStateKey.test(key) && isPlainJsonTree(child, depth + 1),
  );
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const failedResult = (errorCode: DecisionErrorCode, latencyMs = 0): TypeSafeDecisionResult => ({
  provider: TYPESAFE_DECISION_PROVIDER,
  model: null,
  inputTokens: null,
  outputTokens: null,
  latencyMs,
  errorCode,
  answers: {},
  confidence: {},
  selectedAction: null,
});

const errorCodeFor = (error: unknown): TypeSafeDecisionErrorCode => {
  if (error instanceof APITimeoutError) return 'TIMEOUT';
  if (
    error instanceof APIConnectionError ||
    error instanceof APIError ||
    error instanceof TypeSafeError
  ) {
    return 'PROVIDER_UNAVAILABLE';
  }
  return 'PROVIDER_UNAVAILABLE';
};

const validateNormalizedAnswers = (
  decisionType: DecisionType,
  questions: TypeSafeQuestionMap,
  answers: Record<string, z.infer<typeof safeAnswerSchema>>,
): {
  answers: Record<string, unknown>;
  confidence: Record<string, number>;
  selectedAction: string | null;
  choiceProbabilities?: Record<string, number>;
} | null => {
  if (Object.keys(answers).length !== Object.keys(questions).length) return null;
  for (const key of Object.keys(questions)) if (!(key in answers)) return null;

  const normalized: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  let choiceProbabilities: Record<string, number> | undefined;

  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key];
    if (question.type === 'choice') {
      if (!answer || answer.type !== 'choice') return null;
      const criteria = Object.keys(question.criteria);
      if (!criteria.includes(answer.choice)) return null;
      if (criteria.length !== Object.keys(answer.probabilities).length) return null;
      if (criteria.some((criterion) => !(criterion in answer.probabilities))) return null;
      confidence[key] = answer.confidence;
      if (decisionType === 'TEAMMATE_FIT') choiceProbabilities = answer.probabilities;
    } else if (!answer || answer.type !== 'noul') {
      return null;
    }
  }

  if (decisionType === 'TASK_CAPABILITY') {
    const demands: Array<{
      dimension: (typeof capabilityDimensions)[number];
      probability: number;
      required: boolean;
    }> = [];
    for (const dimension of capabilityDimensions) {
      const probabilityKey = `demand.${dimension}.probability`;
      const requiredKey = `demand.${dimension}.required`;
      const probabilityAnswer = answers[probabilityKey];
      const requiredAnswer = answers[requiredKey];
      if (!probabilityAnswer || probabilityAnswer.type !== 'noul') return null;
      if (!requiredAnswer || requiredAnswer.type !== 'choice') return null;
      if (requiredAnswer.choice !== 'YES' && requiredAnswer.choice !== 'NO') return null;
      demands.push({
        dimension,
        probability: probabilityAnswer.noul,
        required: requiredAnswer.choice === 'YES',
      });
    }
    if (Object.keys(questions).length !== capabilityDimensions.length * 2) return null;
    normalized.demands = demands;
  } else if (decisionType === 'TEAMMATE_FIT') {
    const answer = answers.teammate;
    const question = questions.teammate;
    if (!answer || answer.type !== 'choice' || !question || question.type !== 'choice') return null;
    normalized.teammate = answer.choice;
  } else if (decisionType === 'COLLABORATION_NEED') {
    const answer = answers.collaboration;
    if (!answer || answer.type !== 'choice' || !['YES', 'NO', 'UNCERTAIN'].includes(answer.choice))
      return null;
    normalized.collaboration = answer.choice;
  } else if (decisionType === 'REVIEW_NEED') {
    const answer = answers.review;
    if (!answer || answer.type !== 'choice' || !['YES', 'NO', 'UNCERTAIN'].includes(answer.choice))
      return null;
    normalized.review = answer.choice;
  }

  const selectedAction =
    decisionType === 'TEAMMATE_FIT'
      ? String(normalized.teammate)
      : decisionType === 'COLLABORATION_NEED'
        ? String(normalized.collaboration)
        : decisionType === 'REVIEW_NEED'
          ? String(normalized.review)
          : null;
  return {
    answers: normalized,
    confidence,
    selectedAction,
    ...(choiceProbabilities && { choiceProbabilities }),
  };
};

/**
 * Main-process-only TypeSafe adapter. Every error is converted to bounded metadata,
 * because SDK/network errors may contain request details and are never safe to log.
 */
export class TypeSafeDecisionGateway implements DecisionGateway {
  readonly #client: TypeSafeClient;
  readonly #timeoutMs: number;

  constructor(options: TypeSafeDecisionGatewayOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
      throw new Error('TypeSafe API key is not configured.');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TYPESAFE_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TYPESAFE_TIMEOUT_MS) {
      throw new Error(
        `TypeSafe timeout must be between 1 and ${MAX_TYPESAFE_TIMEOUT_MS} milliseconds.`,
      );
    }
    this.#timeoutMs = timeoutMs;
    this.#client = new TypeSafeClient({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultModel: TYPESAFE_DECISION_MODEL,
      logLevel: 'off',
      logger: noopLogger,
      retry: { maxRetries: 0 },
      timeout: timeoutMs,
      fetch: options.fetch,
    });
  }

  async evaluate(request: DecisionRequest): Promise<TypeSafeDecisionResult> {
    const startedAt = Date.now();
    const extended = request as TypeSafeDecisionRequest;
    const state = stateSchema.safeParse(extended.state);
    const questions = questionMapSchema.safeParse(extended.questions);
    if (!state.success || !questions.success || !isPlainJsonTree(state.data)) {
      return failedResult('INVALID_REQUEST');
    }

    const stateJson = JSON.stringify(state.data);
    const questionsJson = JSON.stringify(questions.data);
    if (stateJson === undefined || questionsJson === undefined)
      return failedResult('INVALID_REQUEST');
    const stateBytes = utf8Bytes(stateJson);
    const questionsBytes = utf8Bytes(questionsJson);
    if (
      stateBytes > MAX_TYPESAFE_STATE_BYTES ||
      questionsBytes > MAX_TYPESAFE_QUESTIONS_BYTES ||
      stateBytes + questionsBytes > MAX_TYPESAFE_REQUEST_BYTES
    ) {
      return failedResult('INVALID_REQUEST');
    }

    try {
      const response = await this.#client.systemOne(
        {
          model: TYPESAFE_DECISION_MODEL,
          state: state.data as Record<string, TypeSafeEntry>,
          questions: questions.data as SdkQuestions,
        },
        { timeout: this.#timeoutMs, retry: { maxRetries: 0 } },
      );
      const parsed = responseSchema.safeParse(response);
      if (!parsed.success) return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
      const normalized = validateNormalizedAnswers(
        request.decisionType,
        questions.data,
        parsed.data.answers,
      );
      if (!normalized) return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);

      return {
        provider: TYPESAFE_DECISION_PROVIDER,
        model: parsed.data.model,
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        answers: normalized.answers,
        confidence: normalized.confidence,
        selectedAction: normalized.selectedAction,
        ...(normalized.choiceProbabilities && {
          choiceProbabilities: normalized.choiceProbabilities,
        }),
      };
    } catch (error) {
      return failedResult(errorCodeFor(error), Date.now() - startedAt);
    }
  }

  /** Verifies authenticated access to the pinned model without exposing SDK errors. */
  async testConnection(): Promise<TypeSafeConnectionResult> {
    const startedAt = Date.now();
    try {
      const models: ModelCard[] = await this.#client.models.list({
        timeout: this.#timeoutMs,
        retry: { maxRetries: 0 },
      });
      const parsed = modelListSchema.safeParse(models);
      if (!parsed.success) {
        return {
          ok: false,
          model: TYPESAFE_DECISION_MODEL,
          errorCode: 'SCHEMA_MISMATCH',
          latencyMs: Date.now() - startedAt,
        };
      }
      const available = parsed.data.some((model) => model.name === TYPESAFE_DECISION_MODEL);
      return {
        ok: available,
        model: TYPESAFE_DECISION_MODEL,
        errorCode: available ? null : 'MODEL_UNAVAILABLE',
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        model: TYPESAFE_DECISION_MODEL,
        errorCode: errorCodeFor(error),
        latencyMs: Date.now() - startedAt,
      };
    }
  }
}

export type { TypeSafeQuestionMap, TypeSafeQuestion };
