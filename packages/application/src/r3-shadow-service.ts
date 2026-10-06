import { createHash, randomUUID } from 'node:crypto';
import type { DecisionReceipt } from '@cultivation/domain';
import type { DecisionReceiptRepository } from './r0-repositories.js';
import type {
  DecisionGateway,
  DecisionRequest,
  DecisionResult,
  ShadowDecisionType,
} from './r0-decision.js';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';
import {
  DECISION_STATE_BUDGET,
  R3_DECISION_QUESTION_VERSIONS,
  R3_DECISION_STATE_VERSION,
  R3_SHADOW_POLICY_VERSION,
  canonicalDecisionJson,
} from './r3-decision-state.js';

export type DecisionFallbackCode =
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'SCHEMA_MISMATCH'
  | 'RECEIPT_WRITE_FAILED';

export interface DecisionShadowObservation {
  decisionType: DecisionRequest['decisionType'];
  stateHash: string;
  status: 'RECORDED' | 'FALLBACK';
  provider: string;
  model: string;
  recommendation: string | null;
  receiptId: string | null;
  actualAction: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  fallbackCode: DecisionFallbackCode | null;
  createdAt: string;
}

export interface DecisionObservationPort {
  recordDecisionObservation(value: DecisionShadowObservation): void | Promise<void>;
}

export interface ShadowDecisionServiceOptions {
  gateway: DecisionGateway;
  receipts: Pick<DecisionReceiptRepository, 'appendDecisionReceipt'>;
  observations: DecisionObservationPort;
  provider: string;
  model: string;
  modelVersion: string;
  policyVersion: string;
  timeoutMs?: number;
  now?: () => string;
  idFactory?: () => string;
}

export interface ShadowDecisionContext {
  missionId?: string | null;
  runId?: string | null;
  /** User/application's real choice for observation; it is never changed here. */
  actualAction?: string | null;
}

export type ShadowDecisionOutcome =
  | {
      status: 'RECORDED';
      receipt: DecisionReceipt;
      recommendation: DecisionResult;
    }
  | {
      status: 'FALLBACK';
      receipt: null;
      recommendation: null;
      fallbackCode: DecisionFallbackCode;
    };

/**
 * Fail-open shadow evaluator. It exposes no Mission, Party, Permission, routing,
 * Runtime, or Human Bridge mutation ports, so a recommendation cannot execute.
 */
export class ShadowDecisionService {
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(private readonly options: ShadowDecisionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /** Always resolves with an observation or a sanitized fallback; it never throws. */
  async evaluate(
    request: DecisionRequest,
    context: ShadowDecisionContext = {},
  ): Promise<ShadowDecisionOutcome> {
    const started = Date.now();
    let fallbackCode: DecisionFallbackCode | null = null;
    try {
      assertSafeRequest(request);
    } catch {
      fallbackCode = 'INVALID_REQUEST';
    }
    if (fallbackCode) return this.fallback(request, context, fallbackCode, elapsed(started));

    let result: DecisionResult;
    try {
      const gatewayResult = await withTimeout(
        this.options.gateway.evaluate(request),
        this.options.timeoutMs ?? 6_000,
      );
      if (gatewayResult.errorCode) {
        return this.fallback(
          request,
          context,
          gatewayResult.errorCode,
          gatewayResult.latencyMs ?? elapsed(started),
        );
      }
      result = validateDecisionResult(gatewayResult, request);
    } catch (error) {
      fallbackCode =
        error instanceof DecisionSchemaError
          ? 'SCHEMA_MISMATCH'
          : error instanceof DecisionTimeoutError
            ? 'TIMEOUT'
            : 'PROVIDER_UNAVAILABLE';
      return this.fallback(request, context, fallbackCode, elapsed(started));
    }

    const latencyMs = result.latencyMs ?? elapsed(started);
    const inputTokens = result.inputTokens ?? null;
    const createdAt = this.now();
    const receiptValue = {
      id: this.idFactory(),
      missionId: context.missionId ?? null,
      runId: context.runId ?? null,
      decisionType: request.decisionType,
      provider: bounded(this.options.provider, 80),
      model: bounded(result.model ?? this.options.model, 120),
      modelVersion: bounded(this.options.modelVersion, 80),
      questionVersion: bounded(request.questionVersion, 100),
      stateHash: request.stateHash,
      inputSummary: bounded(
        canonicalDecisionJson(request.inputSummary),
        DECISION_STATE_BUDGET.receiptSummaryCharacters,
      ),
      answersJson: result.answers,
      confidenceJson: result.confidence,
      policyVersion: bounded(request.policyVersion || this.options.policyVersion, 100),
      selectedAction: result.selectedAction,
      mode: 'SHADOW' as const,
      createdAt,
      actualAction: boundedNullable(context.actualAction ?? null, 160),
      latencyMs,
      inputTokens,
    };
    let receipt: DecisionReceipt;
    try {
      // R3 persistence adds actualAction/latency/inputTokens to the R0 receipt contract.
      receipt = receiptValue as unknown as DecisionReceipt;
      this.options.receipts.appendDecisionReceipt(receipt);
    } catch {
      return this.fallback(request, context, 'RECEIPT_WRITE_FAILED', elapsed(started));
    }

    await this.recordObservation({
      decisionType: request.decisionType,
      stateHash: request.stateHash,
      status: 'RECORDED',
      provider: bounded(this.options.provider, 80),
      model: bounded(result.model ?? this.options.model, 120),
      recommendation: result.selectedAction,
      receiptId: receipt.id,
      actualAction: boundedNullable(context.actualAction ?? null, 160),
      latencyMs,
      inputTokens,
      fallbackCode: null,
      createdAt,
    });
    return { status: 'RECORDED', receipt, recommendation: result };
  }

  private async fallback(
    request: Partial<DecisionRequest>,
    context: ShadowDecisionContext,
    fallbackCode: DecisionFallbackCode,
    latencyMs: number,
  ): Promise<ShadowDecisionOutcome> {
    const createdAt = this.now();
    const decisionType = isDecisionType(request.decisionType)
      ? request.decisionType
      : 'TASK_CAPABILITY';
    const stateHash = typeof request.stateHash === 'string' ? request.stateHash.slice(0, 64) : '';
    await this.recordObservation({
      decisionType,
      stateHash,
      status: 'FALLBACK',
      provider: bounded(this.options.provider, 80),
      model: bounded(this.options.model, 120),
      recommendation: null,
      receiptId: null,
      actualAction: boundedNullable(context.actualAction ?? null, 160),
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      inputTokens: null,
      fallbackCode,
      createdAt,
    });
    return { status: 'FALLBACK', receipt: null, recommendation: null, fallbackCode };
  }

  private async recordObservation(value: DecisionShadowObservation): Promise<void> {
    try {
      await this.options.observations.recordDecisionObservation(value);
    } catch {
      // Observability storage must not change the caller's Mission result.
    }
  }
}

class DecisionSchemaError extends Error {}

export function validateDecisionResult(value: unknown, request: DecisionRequest): DecisionResult {
  if (!isRecord(value) || !isRecord(value.answers) || !isRecord(value.confidence)) {
    throw new DecisionSchemaError('Decision response schema mismatch.');
  }
  if (value.selectedAction !== null && typeof value.selectedAction !== 'string') {
    throw new DecisionSchemaError('Decision response schema mismatch.');
  }
  const confidence: Record<string, number> = {};
  for (const [key, score] of Object.entries(value.confidence)) {
    if (
      !Object.hasOwn(request.questions, key) ||
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new DecisionSchemaError('Decision response schema mismatch.');
    }
    confidence[bounded(key, 100)] = score;
  }
  const answers = validateNormalizedAnswers(request, sanitizeAnswerObject(value.answers));
  const expectedAction = recommendationFor(request.decisionType, answers);
  const suppliedAction = boundedNullable(value.selectedAction as string | null, 160);
  if (suppliedAction !== null && expectedAction !== suppliedAction) {
    throw new DecisionSchemaError('Decision response recommendation does not match its answer.');
  }
  const selectedAction = expectedAction;
  const model = typeof value.model === 'string' ? bounded(value.model, 120) : undefined;
  const inputTokens = optionalNonNegativeInteger(value.inputTokens);
  const latencyMs = optionalNonNegativeNumber(value.latencyMs);
  return {
    answers,
    confidence,
    selectedAction,
    ...(model ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

function validateNormalizedAnswers(
  request: DecisionRequest,
  answers: Record<string, unknown>,
): Record<string, unknown> {
  if (request.decisionType === 'TASK_CAPABILITY') {
    if (
      Object.keys(answers).length !== 1 ||
      !Array.isArray(answers.demands) ||
      answers.demands.length !== CAPABILITY_DIMENSIONS.length
    ) {
      throw new DecisionSchemaError('Decision response must include all capability demands.');
    }
    const demands = new Map<
      string,
      { dimension: string; probability: number; required: boolean }
    >();
    for (const item of answers.demands) {
      if (!isRecord(item)) throw new DecisionSchemaError('Capability demand schema mismatch.');
      const { dimension, probability, required } = item;
      if (
        typeof dimension !== 'string' ||
        !CAPABILITY_DIMENSIONS.includes(dimension as (typeof CAPABILITY_DIMENSIONS)[number]) ||
        typeof probability !== 'number' ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1 ||
        typeof required !== 'boolean' ||
        demands.has(dimension)
      ) {
        throw new DecisionSchemaError('Capability demand schema mismatch.');
      }
      demands.set(dimension, { dimension, probability, required });
    }
    if (CAPABILITY_DIMENSIONS.some((dimension) => !demands.has(dimension))) {
      throw new DecisionSchemaError('Decision response omits a capability dimension.');
    }
    return { demands: CAPABILITY_DIMENSIONS.map((dimension) => demands.get(dimension)!) };
  }
  if (request.decisionType === 'TEAMMATE_FIT') {
    if (Object.keys(answers).length !== 1 || typeof answers.teammate !== 'string') {
      throw new DecisionSchemaError('Teammate fit response schema mismatch.');
    }
    const allowed = new Set([
      ...((request.state.candidates as Array<{ id: string }> | undefined)?.map(
        (candidate) => candidate.id,
      ) ?? []),
      'NONE',
    ]);
    if (!allowed.has(answers.teammate))
      throw new DecisionSchemaError('Teammate fit selected an unknown candidate.');
    return { teammate: answers.teammate };
  }
  const key = request.decisionType === 'COLLABORATION_NEED' ? 'collaboration' : 'review';
  if (
    Object.keys(answers).length !== 1 ||
    !['YES', 'NO', 'UNCERTAIN'].includes(String(answers[key]))
  ) {
    throw new DecisionSchemaError('Decision choice response schema mismatch.');
  }
  return { [key]: answers[key] };
}

function recommendationFor(
  decisionType: DecisionRequest['decisionType'],
  answers: Record<string, unknown>,
): string | null {
  if (decisionType === 'TASK_CAPABILITY') return null;
  if (decisionType === 'TEAMMATE_FIT') return answers.teammate as string;
  return (
    (answers[decisionType === 'COLLABORATION_NEED' ? 'collaboration' : 'review'] as string) ?? null
  );
}

function sanitizeAnswerObject(value: Record<string, unknown>): Record<string, unknown> {
  const cleaned = sanitizeValue(value, 0);
  const json = canonicalDecisionJson(cleaned);
  if (Buffer.byteLength(json, 'utf8') > 6_000 || !isRecord(cleaned)) {
    throw new DecisionSchemaError('Decision response exceeds its bounded schema.');
  }
  return cleaned;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) throw new DecisionSchemaError('Decision response is too deeply nested.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new DecisionSchemaError('Decision response has an invalid number.');
    return value;
  }
  if (typeof value === 'string') {
    const text = bounded(value, 160);
    if (text !== value && value.length > 160)
      throw new DecisionSchemaError('Decision response contains oversized text.');
    return text;
  }
  if (Array.isArray(value)) {
    if (value.length > 24)
      throw new DecisionSchemaError('Decision response contains too many values.');
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (!isRecord(value))
    throw new DecisionSchemaError('Decision response contains a non-JSON value.');
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, 32);
  for (const [key, child] of entries) {
    if (/reason|rationale|chain.?of.?thought|hidden.?thought|analysis|explanation/i.test(key))
      continue;
    result[bounded(key, 80)] = sanitizeValue(child, depth + 1);
  }
  return result;
}

export function assertSafeRequest(request: DecisionRequest): void {
  if (!isDecisionType(request.decisionType)) throw new Error('Unsupported shadow decision type.');
  if (!isRecord(request) || !isRecord(request.state) || !isRecord(request.questions)) {
    throw new Error('Invalid decision request.');
  }
  const stateJson = canonicalDecisionJson(request.state);
  if (Buffer.byteLength(stateJson, 'utf8') > DECISION_STATE_BUDGET.stateBytes) {
    throw new Error('Decision state exceeds byte budget.');
  }
  if (
    Buffer.byteLength(canonicalDecisionJson(request), 'utf8') > DECISION_STATE_BUDGET.requestBytes
  ) {
    throw new Error('Decision request exceeds byte budget.');
  }
  if (request.state.decisionType !== request.decisionType)
    throw new Error('Decision type mismatch.');
  if (
    request.state.schemaVersion !== R3_DECISION_STATE_VERSION ||
    request.questionVersion !== R3_DECISION_QUESTION_VERSIONS[request.decisionType] ||
    request.policyVersion !== R3_SHADOW_POLICY_VERSION
  ) {
    throw new Error('Decision request versions are invalid.');
  }
  const allowedTopLevel = stateKeys(request.decisionType);
  for (const key of Object.keys(request.state)) {
    if (!allowedTopLevel.has(key))
      throw new Error('Decision state contains a non-allowlisted field.');
  }
  assertNoPrivateKeys(request.state);
  assertNoPrivateKeys(request.inputSummary);
  assertNoPrivateKeys(request.questions);
  assertNoSecretText(request);
  assertAllowlistedNestedState(request.decisionType, request.state);
  assertQuestions(request);
  if (
    typeof request.stateHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(request.stateHash) ||
    typeof request.questionVersion !== 'string' ||
    typeof request.policyVersion !== 'string' ||
    typeof request.inputSummary.taskSummary !== 'string' ||
    request.inputSummary.taskSummary.length > DECISION_STATE_BUDGET.taskSummaryCharacters ||
    !Array.isArray(request.inputSummary.candidateIds)
  ) {
    throw new Error('Decision request metadata is invalid.');
  }
  if (
    Object.keys(request.inputSummary).some(
      (key) => !['taskSummary', 'candidateIds', 'capabilityBands'].includes(key),
    ) ||
    request.inputSummary.candidateIds.length > DECISION_STATE_BUDGET.candidateCount ||
    request.inputSummary.candidateIds.some(
      (candidateId) => typeof candidateId !== 'string' || candidateId.length > 100,
    )
  ) {
    throw new Error('Decision input summary is invalid.');
  }
  if (request.inputSummary.taskSummary !== request.state.taskSummary) {
    throw new Error('Decision input summary does not match the bounded state.');
  }
  if (
    request.decisionType === 'TEAMMATE_FIT' &&
    JSON.stringify(request.inputSummary.candidateIds) !==
      JSON.stringify(
        (request.state.candidates as Array<{ id: string }>).map((candidate) => candidate.id),
      )
  ) {
    throw new Error('Decision candidate summary does not match the bounded state.');
  }
  const expectedStateHash = createHash('sha256')
    .update(
      canonicalDecisionJson({
        policyVersion: request.policyVersion,
        questionVersion: request.questionVersion,
        state: request.state,
      }),
      'utf8',
    )
    .digest('hex');
  if (request.stateHash !== expectedStateHash) throw new Error('Decision state hash mismatch.');
}

function assertQuestions(request: DecisionRequest): void {
  let expected: Array<[string, 'noul' | 'choice']>;
  if (request.decisionType === 'TASK_CAPABILITY') {
    expected = CAPABILITY_DIMENSIONS.flatMap((dimension) => [
      [`demand.${dimension}.probability`, 'noul'] as [string, 'noul'],
      [`demand.${dimension}.required`, 'choice'] as [string, 'choice'],
    ]);
  } else if (request.decisionType === 'TEAMMATE_FIT') expected = [['teammate', 'choice']];
  else if (request.decisionType === 'COLLABORATION_NEED') expected = [['collaboration', 'choice']];
  else expected = [['review', 'choice']];
  const questionKeys = Object.keys(request.questions).sort();
  if (
    questionKeys.join('\0') !==
    expected
      .map(([key]) => key)
      .sort()
      .join('\0')
  ) {
    throw new Error('Decision questions do not match the versioned template.');
  }
  for (const [key, type] of expected) {
    const question = request.questions[key];
    if (
      !isRecord(question) ||
      question.type !== type ||
      typeof question.instructions !== 'string' ||
      question.instructions.length > 2_000 ||
      (question.criteria !== undefined && !isRecord(question.criteria)) ||
      (isRecord(question.criteria) &&
        Object.values(question.criteria).some(
          (criterion) => criterion !== null && typeof criterion !== 'string',
        ))
    ) {
      throw new Error('Decision question schema is invalid.');
    }
  }
}

function assertAllowlistedNestedState(
  decisionType: DecisionRequest['decisionType'],
  state: Record<string, unknown>,
): void {
  if (state.schemaVersion !== R3_DECISION_STATE_VERSION)
    throw new Error('Unsupported decision state version.');
  if (typeof state.taskSummary !== 'string' || state.taskSummary.length > 1_200) {
    throw new Error('Invalid decision task summary.');
  }
  if (decisionType === 'TASK_CAPABILITY') {
    const dimensions = state.dimensions;
    if (
      !Array.isArray(dimensions) ||
      dimensions.length !== CAPABILITY_DIMENSIONS.length ||
      CAPABILITY_DIMENSIONS.some((dimension, index) => dimensions[index] !== dimension)
    ) {
      throw new Error('Invalid task capability dimension list.');
    }
  }
  if (decisionType === 'TEAMMATE_FIT') {
    if (!Array.isArray(state.candidates) || state.candidates.length > 8) {
      throw new Error('Invalid candidate list.');
    }
    const candidateKeys = new Set([
      'id',
      'roleTitle',
      'capabilities',
      'enabledSkills',
      'verifiedExperiences',
      'modelAvailability',
      'stabilityPenalty',
    ]);
    for (const candidate of state.candidates) {
      if (!isRecord(candidate) || Object.keys(candidate).some((key) => !candidateKeys.has(key))) {
        throw new Error('Candidate state contains non-allowlisted fields.');
      }
      if (
        typeof candidate.id !== 'string' ||
        candidate.id.length === 0 ||
        candidate.id.length > 100 ||
        typeof candidate.roleTitle !== 'string' ||
        candidate.roleTitle.length > 120 ||
        !isRecord(candidate.capabilities) ||
        !Array.isArray(candidate.enabledSkills) ||
        candidate.enabledSkills.length > 6 ||
        !Array.isArray(candidate.verifiedExperiences) ||
        candidate.verifiedExperiences.length > 6
      ) {
        throw new Error('Invalid candidate state.');
      }
      if (
        candidate.modelAvailability !== undefined &&
        !['UNKNOWN', 'AVAILABLE', 'UNSTABLE'].includes(String(candidate.modelAvailability))
      ) {
        throw new Error('Invalid candidate model availability.');
      }
      if (
        candidate.stabilityPenalty !== undefined &&
        candidate.stabilityPenalty !== null &&
        (candidate.stabilityPenalty !== 'UNSTABLE' || candidate.modelAvailability !== 'UNSTABLE')
      ) {
        throw new Error('Invalid candidate stability signal.');
      }
      if (
        Object.keys(candidate.capabilities).some(
          (dimension) => !CAPABILITY_DIMENSIONS.includes(dimension as never),
        )
      ) {
        throw new Error('Candidate state contains an unknown capability dimension.');
      }
      for (const capability of Object.values(candidate.capabilities)) {
        if (
          !isRecord(capability) ||
          !['SUPPORTED', 'UNSUPPORTED', 'UNCONFIGURED'].includes(String(capability.status))
        ) {
          throw new Error('Invalid capability state.');
        }
        const expected = capability.status === 'SUPPORTED' ? ['LOW', 'MEDIUM', 'HIGH'] : [null];
        if (!expected.includes((capability.band ?? null) as never))
          throw new Error('Invalid capability band.');
      }
      for (const skill of candidate.enabledSkills) {
        if (
          !isRecord(skill) ||
          Object.keys(skill).some((key) => !['id', 'name', 'category', 'summary'].includes(key)) ||
          typeof skill.id !== 'string' ||
          skill.id.length > 100 ||
          typeof skill.name !== 'string' ||
          skill.name.length > 80 ||
          (skill.category !== null && typeof skill.category !== 'string') ||
          (skill.summary !== null && typeof skill.summary !== 'string') ||
          (typeof skill.category === 'string' && skill.category.length > 50) ||
          (typeof skill.summary === 'string' && skill.summary.length > 160)
        ) {
          throw new Error('Invalid enabled Skill metadata.');
        }
      }
      for (const experience of candidate.verifiedExperiences) {
        if (
          !isRecord(experience) ||
          Object.keys(experience).some(
            (key) => !['type', 'mode', 'outcome', 'role', 'createdAt'].includes(key),
          ) ||
          typeof experience.role !== 'string' ||
          experience.role.length > 40 ||
          typeof experience.createdAt !== 'string' ||
          experience.createdAt.length > 32
        ) {
          throw new Error('Invalid verified Experience summary.');
        }
      }
    }
  }
}

function stateKeys(decisionType: DecisionRequest['decisionType']): Set<string> {
  const base = ['schemaVersion', 'decisionType', 'taskSummary'];
  if (decisionType === 'TASK_CAPABILITY') return new Set([...base, 'dimensions']);
  if (decisionType === 'TEAMMATE_FIT') {
    return new Set([...base, 'explicitTeammateId', 'candidates', 'candidatesTruncated']);
  }
  if (decisionType === 'COLLABORATION_NEED')
    return new Set([...base, 'eligibleCandidateCount', 'selectedMode']);
  return new Set([...base, 'selectedMode']);
}

function assertNoPrivateKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateKeys(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /memory|credential|api.?key|secret|file.?content|chat.?history|event.?payload|tool.?output|audit/i.test(
        key,
      )
    ) {
      throw new Error('Decision request contains a forbidden private field.');
    }
    assertNoPrivateKeys(child);
  }
}

function assertNoSecretText(value: unknown): void {
  if (typeof value === 'string') {
    if (
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:sk|jev|api)[-_][A-Za-z0-9_-]{12,}\b|\b(?:api[_ -]?key|secret|token)\s*[:=]/i.test(
        value,
      )
    ) {
      throw new Error('Decision request contains secret-like text.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretText(item);
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) assertNoSecretText(child);
  }
}

function isDecisionType(value: unknown): value is ShadowDecisionType {
  return ['TASK_CAPABILITY', 'TEAMMATE_FIT', 'COLLABORATION_NEED', 'REVIEW_NEED'].includes(
    String(value),
  );
}

function optionalNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DecisionSchemaError('Decision response token metadata is invalid.');
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DecisionSchemaError('Decision response latency metadata is invalid.');
  }
  return value;
}

function bounded(value: string, limit: number): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED]')
    .replace(/\b(?:sk|jev|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
    .replace(/\b(?:api[_ -]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function boundedNullable(value: string | null, limit: number): string | null {
  return value === null ? null : bounded(value, limit) || null;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class DecisionTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const boundedTimeout = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(timeoutMs, 60_000))
    : 6_000;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DecisionTimeoutError('Decision deadline exceeded.')),
      boundedTimeout,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
