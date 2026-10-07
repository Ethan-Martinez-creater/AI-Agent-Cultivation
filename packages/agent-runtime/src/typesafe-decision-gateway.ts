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
import {
  MEMORY_PRE_GATE_POLICY,
  validateMemoryPreGateRequest,
} from '@cultivation/application/r5-2-memory-pre-gate';
import {
  MEMORY_RERANK_POLICY,
  validateMemoryRerankRequest,
} from '@cultivation/application/r5-3-memory-rerank';
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
export const MAX_TYPESAFE_SKILL_CANDIDATES = 24;
export const MAX_TYPESAFE_MEMORY_PRE_GATE_RESPONSE_BYTES = MEMORY_PRE_GATE_POLICY.maxResponseBytes;
export const MAX_TYPESAFE_MEMORY_RERANK_RESPONSE_BYTES = MEMORY_RERANK_POLICY.maxResponseBytes;

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
const memoryPreGateResponseSchema = z
  .object({
    model: z.string().min(1).max(128),
    answers: z
      .object({
        extraction: z
          .object({
            type: z.literal('choice'),
            choice: z.enum(['RUN_EXTRACTION', 'SKIP_EXTRACTION']),
            confidence: boundedProbability,
            probabilities: z
              .object({
                RUN_EXTRACTION: boundedProbability,
                SKIP_EXTRACTION: boundedProbability,
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
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

const skillIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,89}$/;
const skillCandidateKeys = new Set(['id', 'name', 'description', 'tags']);

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const skillContextSchema = z
  .object({
    objective: z.string().max(600),
    phase: z.string().max(48).optional(),
    stepType: z.enum(['TASK', 'REVIEW', 'DECISION']).optional(),
    requiredCapabilities: z.array(z.enum(capabilityDimensions)).max(8).optional(),
    inputArtifactSummaries: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            kind: z.string().min(1).max(32),
            name: z.string().min(1).max(64),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    expectedOutputContract: z
      .array(
        z
          .object({
            key: z.string().min(1).max(40),
            kind: z.string().min(1).max(32),
            contractId: z.string().max(48).optional(),
            contractVersion: z.string().max(32).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    publicState: z
      .enum([
        'DRAFT',
        'READY',
        'RUNNING',
        'WAITING_APPROVAL',
        'WAITING_COLLABORATION',
        'WAITING_EXTERNAL_WORK',
        'PAUSED',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'INTERRUPTED',
      ])
      .optional(),
  })
  .strict();

const containsInstructionKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsInstructionKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => /instruction/i.test(key) || containsInstructionKey(child),
  );
};

/**
 * Skill relevance is the only decision shape whose dynamic Noul keys encode
 * candidate IDs. Bind those keys to the bounded metadata and summary IDs before
 * sending the request so the provider cannot score an unlisted Skill.
 */
const skillCandidateIdsForRequest = (
  request: DecisionRequest,
  state: Record<string, unknown>,
  questions: TypeSafeQuestionMap,
): string[] | null => {
  if (request.decisionType !== 'SKILL_RELEVANCE') return null;
  if (
    Object.keys(state).length !== 2 ||
    !skillContextSchema.safeParse(state.context).success ||
    !Array.isArray(state.candidates) ||
    state.candidates.length < 1 ||
    state.candidates.length > MAX_TYPESAFE_SKILL_CANDIDATES ||
    containsInstructionKey(state)
  ) {
    return null;
  }

  const candidateIds: string[] = [];
  for (const candidate of state.candidates) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== skillCandidateKeys.size ||
      Object.keys(candidate).some((key) => !skillCandidateKeys.has(key)) ||
      typeof candidate.id !== 'string' ||
      !skillIdPattern.test(candidate.id) ||
      typeof candidate.name !== 'string' ||
      candidate.name.length < 1 ||
      candidate.name.length > 120 ||
      typeof candidate.description !== 'string' ||
      candidate.description.length > 1_000 ||
      !Array.isArray(candidate.tags) ||
      candidate.tags.length > 32 ||
      candidate.tags.some((tag) => typeof tag !== 'string' || tag.length > 64)
    ) {
      return null;
    }
    candidateIds.push(candidate.id);
  }
  if (new Set(candidateIds).size !== candidateIds.length) return null;

  const inputSummary = request.inputSummary as unknown;
  if (!isRecord(inputSummary) || !Array.isArray(inputSummary.candidateIds)) return null;
  if (
    inputSummary.candidateIds.length !== candidateIds.length ||
    inputSummary.candidateIds.some((id, index) => id !== candidateIds[index])
  ) {
    return null;
  }

  const expectedQuestionKeys = candidateIds.map((id) => `skill.${id}`).sort();
  const actualQuestionKeys = Object.keys(questions).sort();
  if (
    actualQuestionKeys.length !== expectedQuestionKeys.length ||
    actualQuestionKeys.some((key, index) => key !== expectedQuestionKeys[index])
  ) {
    return null;
  }
  for (const key of expectedQuestionKeys) {
    const question = questions[key];
    // Skill relevance uses numeric Noul questions only; named criteria would
    // create an unnecessary provider-controlled choice surface.
    if (!question || question.type !== 'noul' || Object.hasOwn(question, 'criteria')) return null;
  }
  return candidateIds;
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

const isMemoryPreGateDecision = (decisionType: DecisionType): boolean =>
  (decisionType as string) === 'MEMORY_EXTRACTION_NEED';

const hasValidMemoryPreGateRequest = (request: DecisionRequest): boolean => {
  try {
    return validateMemoryPreGateRequest(request);
  } catch {
    return false;
  }
};

const hasValidMemoryRerankRequest = (request: DecisionRequest): boolean => {
  try {
    return validateMemoryRerankRequest(request);
  } catch {
    return false;
  }
};

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

  if ((decisionType as string) === 'SKILL_RELEVANCE') {
    const skills = Object.keys(questions)
      .map((key) => {
        const answer = answers[key];
        if (!key.startsWith('skill.') || !answer || answer.type !== 'noul') return null;
        return { skillId: key.slice('skill.'.length), score: answer.noul };
      })
      .filter((skill): skill is { skillId: string; score: number } => skill !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0),
      )
      .slice(0, 3);
    if (skills.length === 0) return null;
    return {
      answers: { skills },
      confidence: {},
      selectedAction: null,
    };
  }

  if (decisionType === 'MEMORY_RELEVANCE') {
    const memories = Object.entries(questions)
      .map(([key]) => {
        const answer = answers[key];
        if (!key.startsWith('memory.') || !answer || answer.type !== 'noul') return null;
        return { memoryId: key.slice('memory.'.length), score: answer.noul };
      })
      .filter((memory): memory is { memoryId: string; score: number } => memory !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          (left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0),
      );
    if (memories.length === 0) return null;
    return { answers: { memories }, confidence: {}, selectedAction: null };
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
    const memoryPreGate = isMemoryPreGateDecision(request.decisionType);
    const memoryRerank = request.decisionType === 'MEMORY_RELEVANCE';
    const timeoutMs = memoryRerank ? MEMORY_RERANK_POLICY.gatewayTimeoutMs : this.#timeoutMs;
    const state = stateSchema.safeParse(extended.state);
    const questions = questionMapSchema.safeParse(extended.questions);
    if (!state.success || !questions.success) {
      return failedResult('INVALID_REQUEST');
    }
    // R5.3 has its own exact state validator because its allowlisted `memoryType`
    // key is intentionally forbidden by the generic unsafe-state guard.
    if (memoryRerank) {
      if (!hasValidMemoryRerankRequest(request)) return failedResult('INVALID_REQUEST');
    } else if (!isPlainJsonTree(state.data)) {
      return failedResult('INVALID_REQUEST');
    }
    if (memoryPreGate && !hasValidMemoryPreGateRequest(request)) {
      return failedResult('INVALID_REQUEST');
    }
    if (
      request.decisionType === 'SKILL_RELEVANCE' &&
      !skillCandidateIdsForRequest(request, state.data, questions.data)
    ) {
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
        { timeout: timeoutMs, retry: { maxRetries: 0 } },
      );
      if (memoryRerank) {
        let serializedResponse: string | undefined;
        try {
          serializedResponse = JSON.stringify(response);
        } catch {
          return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
        }
        if (
          serializedResponse === undefined ||
          utf8Bytes(serializedResponse) > MAX_TYPESAFE_MEMORY_RERANK_RESPONSE_BYTES
        ) {
          return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
        }

        const parsedMemoryResponse = responseSchema.safeParse(response);
        if (
          !parsedMemoryResponse.success ||
          parsedMemoryResponse.data.model !== TYPESAFE_DECISION_MODEL
        ) {
          return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
        }
        const normalized = validateNormalizedAnswers(
          request.decisionType,
          questions.data,
          parsedMemoryResponse.data.answers,
        );
        if (!normalized) return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
        return {
          provider: TYPESAFE_DECISION_PROVIDER,
          model: parsedMemoryResponse.data.model,
          inputTokens: parsedMemoryResponse.data.usage.input_tokens,
          outputTokens: parsedMemoryResponse.data.usage.output_tokens,
          latencyMs: Date.now() - startedAt,
          errorCode: null,
          answers: normalized.answers,
          confidence: {},
          selectedAction: null,
        };
      }
      if (memoryPreGate) {
        let serializedResponse: string | undefined;
        try {
          serializedResponse = JSON.stringify(response);
        } catch {
          return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
        }
        if (
          serializedResponse === undefined ||
          utf8Bytes(serializedResponse) > MAX_TYPESAFE_MEMORY_PRE_GATE_RESPONSE_BYTES
        ) {
          return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
        }

        const parsedMemoryResponse = memoryPreGateResponseSchema.safeParse(response);
        const extractionQuestion = questions.data.extraction;
        if (
          !parsedMemoryResponse.success ||
          parsedMemoryResponse.data.model !== TYPESAFE_DECISION_MODEL ||
          Object.keys(questions.data).length !== 1 ||
          !extractionQuestion ||
          extractionQuestion.type !== 'choice' ||
          Object.keys(extractionQuestion.criteria).length !== 2 ||
          !Object.hasOwn(extractionQuestion.criteria, 'RUN_EXTRACTION') ||
          !Object.hasOwn(extractionQuestion.criteria, 'SKIP_EXTRACTION')
        ) {
          return failedResult('SCHEMA_MISMATCH', Date.now() - startedAt);
        }
        const extraction = parsedMemoryResponse.data.answers.extraction;
        return {
          provider: TYPESAFE_DECISION_PROVIDER,
          model: parsedMemoryResponse.data.model,
          inputTokens: parsedMemoryResponse.data.usage.input_tokens,
          outputTokens: parsedMemoryResponse.data.usage.output_tokens,
          latencyMs: Date.now() - startedAt,
          errorCode: null,
          answers: { extraction: extraction.choice },
          confidence: { extraction: extraction.confidence },
          selectedAction: null,
        };
      }

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
