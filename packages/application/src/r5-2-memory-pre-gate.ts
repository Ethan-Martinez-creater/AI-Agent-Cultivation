import { createHash } from 'node:crypto';
import type { CapabilityDimension, MissionState } from '@cultivation/domain';
import type {
  DecisionErrorCode,
  DecisionGateway,
  DecisionRequest,
  DecisionResult,
} from './r0-decision.js';
import { canonicalDecisionJson } from './r3-decision-state.js';
import { CAPABILITY_DIMENSIONS } from './r1-capability-scoring.js';

export type MemoryPreGateSourceType = 'CHAT_MESSAGE' | 'MISSION_RESULT' | 'WORKFLOW_STEP_RESULT';
export type MemoryPreGateTrigger = 'USER_EXPLICIT' | 'HARNESS';
export type MemoryPreGateDecision = 'RUN_EXTRACTION' | 'SKIP_EXTRACTION';
export type MemoryPreGateStepType = 'TASK' | 'REVIEW' | 'DECISION';

export interface MemoryEvidenceFacts {
  evidenceCharacters: number;
  semanticSignals: {
    durableStatement: boolean;
    questionOnly: boolean;
    codeOrStructured: boolean;
  };
}

export interface MemoryPreGateArtifactSummary {
  id: string;
  kind: string;
  name: string;
}

export interface MemoryPreGateOutputContractSummary {
  key: string;
  kind: string;
  contractId?: string;
  contractVersion?: string;
}

/**
 * A bounded projection of the current mission or workflow step. It carries no
 * run history, instructions, outputs, prompts, or file contents.
 */
export interface MemoryPreGateExecutionContext {
  objectiveSummary: string;
  stepType?: MemoryPreGateStepType;
  requiredCapabilities?: CapabilityDimension[];
  inputArtifactSummaries?: MemoryPreGateArtifactSummary[];
  expectedOutputContract?: MemoryPreGateOutputContractSummary[];
  publicState?: MissionState;
}

/**
 * Trusted provenance plus non-content evidence facts. Chat content is reduced
 * locally with buildMemoryEvidenceFacts and is never accepted as a field here.
 */
export interface MemoryPreGateContext extends MemoryEvidenceFacts {
  ownerId: string;
  sourceId: string;
  sourceType: MemoryPreGateSourceType;
  trigger: MemoryPreGateTrigger;
  messageRole?: 'user' | 'assistant';
  execution?: MemoryPreGateExecutionContext;
}

export type MemoryPreGateMode = 'JEV' | 'DETERMINISTIC_FALLBACK';
export type MemoryPreGateReason =
  | 'JEV_DECISION'
  | 'GATEWAY_UNAVAILABLE'
  | 'GATEWAY_TIMEOUT'
  | 'GATEWAY_ERROR'
  | 'INVALID_RESPONSE';

export interface MemoryPreGateReceipt {
  sourceType: MemoryPreGateSourceType;
  ownerId: string;
  sourceId: string;
  trigger: MemoryPreGateTrigger;
  mode: MemoryPreGateMode;
  decision: MemoryPreGateDecision;
  confidence: number | null;
  stateHash: string;
  policyVersion: string;
  questionVersion: string;
  reason: MemoryPreGateReason;
  errorCode: DecisionErrorCode | null;
}

export type MemoryPreGateGatewayFactory = () => Promise<DecisionGateway | null>;

export const MEMORY_PRE_GATE_POLICY = Object.freeze({
  version: 'r5-2-memory-pre-gate-policy-v1',
  questionVersion: 'r5-2-memory-extraction-need-question-v1',
  gatewayTimeoutMs: 6_000,
  maxStateBytes: 4_096,
  maxRequestBytes: 8_192,
  maxResponseBytes: 2_048,
  maxOwnerIdCharacters: 128,
  maxSourceIdCharacters: 128,
  maxEvidenceCharacters: 10_000_000,
  maxObjectiveSummaryCharacters: 600,
  maxRequiredCapabilities: 8,
  maxArtifacts: 4,
  maxOutputContracts: 4,
  maxArtifactIdCharacters: 64,
  maxArtifactKindCharacters: 32,
  maxArtifactNameCharacters: 64,
  maxContractKeyCharacters: 40,
  maxContractKindCharacters: 32,
  maxContractIdCharacters: 48,
  maxContractVersionCharacters: 32,
} as const);

const DECISION_TYPE = 'MEMORY_EXTRACTION_NEED' as DecisionRequest['decisionType'];
const STATIC_CHAT_SUMMARY = 'Assess bounded evidence metadata for memory extraction.';
const INSTRUCTIONS =
  'Decide whether the bounded evidence facts merit candidate extraction. Return one listed choice only. Do not create memory content, summaries, types, importance, owners, or actions.';
const CHOICES = Object.freeze({
  RUN_EXTRACTION: 'Evidence may contain durable information worth candidate extraction.',
  SKIP_EXTRACTION: 'Evidence does not merit candidate extraction.',
});
const SOURCE_TYPES: readonly MemoryPreGateSourceType[] = [
  'CHAT_MESSAGE',
  'MISSION_RESULT',
  'WORKFLOW_STEP_RESULT',
];
const TRIGGERS: readonly MemoryPreGateTrigger[] = ['USER_EXPLICIT', 'HARNESS'];
const STEP_TYPES: readonly MemoryPreGateStepType[] = ['TASK', 'REVIEW', 'DECISION'];
const PUBLIC_STATES: readonly MissionState[] = [
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
];
const ERROR_CODES: readonly DecisionErrorCode[] = [
  'INVALID_REQUEST',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'SCHEMA_MISMATCH',
];
const REQUEST_KEYS = new Set([
  'decisionType',
  'questionVersion',
  'stateHash',
  'policyVersion',
  'state',
  'questions',
  'inputSummary',
]);
const STATE_KEYS = new Set(['sourceType', 'trigger', 'messageRole', 'evidence', 'execution']);
const EXECUTION_KEYS = new Set([
  'objectiveSummary',
  'stepType',
  'requiredCapabilities',
  'inputArtifactSummaries',
  'expectedOutputContract',
  'publicState',
]);
const ARTIFACT_KEYS = new Set(['id', 'kind', 'name']);
const CONTRACT_KEYS = new Set(['key', 'kind', 'contractId', 'contractVersion']);
const EVIDENCE_KEYS = new Set(['evidenceCharacters', 'semanticSignals']);
const SIGNAL_KEYS = new Set(['durableStatement', 'questionOnly', 'codeOrStructured']);
const TELEMETRY_KEYS = new Set(['provider', 'model', 'inputTokens', 'outputTokens', 'latencyMs']);
const RESULT_KEYS = new Set([
  'answers',
  'confidence',
  'selectedAction',
  'choiceProbabilities',
  'errorCode',
  ...TELEMETRY_KEYS,
]);
/**
 * Reduce raw evidence locally to a length and three booleans. The returned
 * object never contains, retains, or summarizes the supplied text.
 */
export function buildMemoryEvidenceFacts(raw: string): MemoryEvidenceFacts {
  if (typeof raw !== 'string') throw new TypeError('Evidence must be a string.');
  const normalized = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const questionOnly =
    normalized.length > 0 && /\?+$/u.test(normalized) && !hasDurableSignal(normalized);
  return {
    evidenceCharacters: raw.length,
    semanticSignals: {
      durableStatement: hasDurableSignal(normalized),
      questionOnly,
      codeOrStructured: looksStructured(raw),
    },
  };
}

/** Build the sole allowlisted provider request for R5.2. */
export function makeMemoryPreGateRequest(context: MemoryPreGateContext): DecisionRequest {
  const bounded = boundContext(context);
  const state = makeDecisionState(bounded);
  const stateHash = hashDecisionState(state);
  const request: DecisionRequest = {
    decisionType: DECISION_TYPE,
    questionVersion: MEMORY_PRE_GATE_POLICY.questionVersion,
    stateHash,
    policyVersion: MEMORY_PRE_GATE_POLICY.version,
    state: state as unknown as Record<string, unknown>,
    questions: {
      extraction: {
        type: 'choice',
        instructions: INSTRUCTIONS,
        criteria: CHOICES,
      },
    },
    inputSummary: {
      taskSummary: state.execution?.objectiveSummary ?? STATIC_CHAT_SUMMARY,
      candidateIds: [],
    },
  };
  if (!validateMemoryPreGateRequest(request)) {
    throw new MemoryPreGateContextError('Bounded request did not pass its machine boundary.');
  }
  return request;
}

/** Strict shared validation for both this policy and the TypeSafe adapter. */
export function validateMemoryPreGateRequest(request: DecisionRequest): boolean {
  try {
    if (!isPlainRecord(request) || !hasExactKeys(request, REQUEST_KEYS)) return false;
    if (
      request.decisionType !== DECISION_TYPE ||
      request.policyVersion !== MEMORY_PRE_GATE_POLICY.version ||
      request.questionVersion !== MEMORY_PRE_GATE_POLICY.questionVersion ||
      typeof request.stateHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(request.stateHash)
    ) {
      return false;
    }
    if (!isBoundedState(request.state)) return false;
    const expectedHash = hashDecisionState(request.state as unknown as DecisionState);
    if (request.stateHash !== expectedHash) return false;
    if (!isExactQuestionMap(request.questions)) return false;
    if (!isExactInputSummary(request.inputSummary, request.state as unknown as DecisionState)) {
      return false;
    }
    const serialized = canonicalDecisionJson(request);
    return Buffer.byteLength(serialized, 'utf8') <= MEMORY_PRE_GATE_POLICY.maxRequestBytes;
  } catch {
    return false;
  }
}

export class MemoryPreGateContextError extends Error {
  constructor(message = 'Memory Pre-Gate context is invalid.') {
    super(message);
    this.name = 'MemoryPreGateContextError';
  }
}

/** Advisory policy only. It has no Memory, runtime, permission, or tool ports. */
export class MemoryPreGateService {
  constructor(private readonly gatewayFactory: MemoryPreGateGatewayFactory) {}

  async evaluate(context: MemoryPreGateContext): Promise<MemoryPreGateReceipt> {
    const bounded = boundContext(context);
    const request = makeMemoryPreGateRequest(bounded);
    const fallbackDecision = fallbackFor(bounded.trigger);
    let result: DecisionResult | null;
    try {
      result = await withTimeout(
        Promise.resolve().then(async () => {
          const gateway = await this.gatewayFactory();
          return gateway ? gateway.evaluate(request) : null;
        }),
        MEMORY_PRE_GATE_POLICY.gatewayTimeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof MemoryPreGateTimeoutError;
      return makeFallbackReceipt(
        bounded,
        request.stateHash,
        fallbackDecision,
        timedOut ? 'GATEWAY_TIMEOUT' : 'GATEWAY_ERROR',
        timedOut ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      );
    }

    if (result === null) {
      return makeFallbackReceipt(
        bounded,
        request.stateHash,
        fallbackDecision,
        'GATEWAY_UNAVAILABLE',
        'PROVIDER_UNAVAILABLE',
      );
    }
    const validated = validateMemoryPreGateResult(result);
    if (validated.kind === 'error') {
      return makeFallbackReceipt(
        bounded,
        request.stateHash,
        fallbackDecision,
        validated.errorCode === 'TIMEOUT' ? 'GATEWAY_TIMEOUT' : 'GATEWAY_ERROR',
        validated.errorCode,
      );
    }
    if (validated.kind === 'invalid') {
      return makeFallbackReceipt(
        bounded,
        request.stateHash,
        fallbackDecision,
        'INVALID_RESPONSE',
        'SCHEMA_MISMATCH',
      );
    }
    return {
      sourceType: bounded.sourceType,
      ownerId: bounded.ownerId,
      sourceId: bounded.sourceId,
      trigger: bounded.trigger,
      mode: 'JEV',
      decision: validated.decision,
      confidence: validated.confidence,
      stateHash: request.stateHash,
      policyVersion: MEMORY_PRE_GATE_POLICY.version,
      questionVersion: MEMORY_PRE_GATE_POLICY.questionVersion,
      reason: 'JEV_DECISION',
      errorCode: null,
    };
  }
}

function boundContext(input: MemoryPreGateContext): MemoryPreGateContext {
  if (
    !isPlainRecord(input) ||
    !hasOnlyKeys(
      input,
      new Set([
        'ownerId',
        'sourceId',
        'sourceType',
        'trigger',
        'messageRole',
        'evidenceCharacters',
        'semanticSignals',
        'execution',
      ]),
    )
  ) {
    throw new MemoryPreGateContextError();
  }
  if (
    !isBoundedIdentifier(input.ownerId, MEMORY_PRE_GATE_POLICY.maxOwnerIdCharacters) ||
    !isBoundedIdentifier(input.sourceId, MEMORY_PRE_GATE_POLICY.maxSourceIdCharacters) ||
    !includes(SOURCE_TYPES, input.sourceType) ||
    !includes(TRIGGERS, input.trigger) ||
    !Number.isSafeInteger(input.evidenceCharacters) ||
    (input.evidenceCharacters as number) < 0 ||
    (input.evidenceCharacters as number) > MEMORY_PRE_GATE_POLICY.maxEvidenceCharacters ||
    !isExactSignalFacts(input.semanticSignals)
  ) {
    throw new MemoryPreGateContextError();
  }
  if (
    input.messageRole !== undefined &&
    input.messageRole !== 'user' &&
    input.messageRole !== 'assistant'
  ) {
    throw new MemoryPreGateContextError();
  }
  if (
    input.sourceType !== 'CHAT_MESSAGE' &&
    (input.messageRole !== undefined || input.execution === undefined)
  ) {
    throw new MemoryPreGateContextError();
  }

  const execution = input.execution === undefined ? undefined : boundExecution(input.execution);
  return fitContextToStateBudget({
    ownerId: input.ownerId,
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    trigger: input.trigger,
    ...(input.messageRole ? { messageRole: input.messageRole } : {}),
    evidenceCharacters: input.evidenceCharacters as number,
    semanticSignals: { ...input.semanticSignals },
    ...(execution ? { execution } : {}),
  });
}

function boundExecution(input: unknown): MemoryPreGateExecutionContext {
  if (!isPlainRecord(input) || !hasOnlyKeys(input, EXECUTION_KEYS)) {
    throw new MemoryPreGateContextError();
  }
  const objectiveSummary = sanitizeText(
    input.objectiveSummary,
    MEMORY_PRE_GATE_POLICY.maxObjectiveSummaryCharacters,
  );
  if (
    !objectiveSummary ||
    !isSanitizedText(objectiveSummary, MEMORY_PRE_GATE_POLICY.maxObjectiveSummaryCharacters)
  ) {
    throw new MemoryPreGateContextError();
  }
  const result: MemoryPreGateExecutionContext = { objectiveSummary };
  if (input.stepType !== undefined) {
    if (!includes(STEP_TYPES, input.stepType)) throw new MemoryPreGateContextError();
    result.stepType = input.stepType;
  }
  if (input.requiredCapabilities !== undefined) {
    const requiredCapabilities = Array.isArray(input.requiredCapabilities)
      ? input.requiredCapabilities.slice(0, MEMORY_PRE_GATE_POLICY.maxRequiredCapabilities)
      : null;
    if (
      !requiredCapabilities ||
      Array.from(requiredCapabilities).some((entry) => !includes(CAPABILITY_DIMENSIONS, entry)) ||
      new Set(requiredCapabilities).size !== requiredCapabilities.length
    ) {
      throw new MemoryPreGateContextError();
    }
    result.requiredCapabilities = requiredCapabilities as CapabilityDimension[];
  }
  if (input.inputArtifactSummaries !== undefined) {
    if (!Array.isArray(input.inputArtifactSummaries)) {
      throw new MemoryPreGateContextError();
    }
    result.inputArtifactSummaries = Array.from(
      input.inputArtifactSummaries.slice(0, MEMORY_PRE_GATE_POLICY.maxArtifacts),
      boundArtifact,
    );
  }
  if (input.expectedOutputContract !== undefined) {
    if (!Array.isArray(input.expectedOutputContract)) {
      throw new MemoryPreGateContextError();
    }
    result.expectedOutputContract = Array.from(
      input.expectedOutputContract.slice(0, MEMORY_PRE_GATE_POLICY.maxOutputContracts),
      boundContract,
    );
  }
  if (input.publicState !== undefined) {
    if (!includes(PUBLIC_STATES, input.publicState)) throw new MemoryPreGateContextError();
    result.publicState = input.publicState;
  }
  return result;
}

function fitContextToStateBudget(context: MemoryPreGateContext): MemoryPreGateContext {
  const bounded: MemoryPreGateContext = {
    ...context,
    semanticSignals: { ...context.semanticSignals },
    ...(context.execution ? { execution: cloneExecution(context.execution) } : {}),
  };
  const byteLength = () =>
    Buffer.byteLength(canonicalDecisionJson(makeDecisionState(bounded)), 'utf8');

  while (byteLength() > MEMORY_PRE_GATE_POLICY.maxStateBytes) {
    const step = bounded.execution;
    if (step?.inputArtifactSummaries?.length) {
      step.inputArtifactSummaries.pop();
      if (step.inputArtifactSummaries.length === 0) delete step.inputArtifactSummaries;
      continue;
    }
    if (step?.expectedOutputContract?.length) {
      step.expectedOutputContract.pop();
      if (step.expectedOutputContract.length === 0) delete step.expectedOutputContract;
      continue;
    }
    if (step && [...step.objectiveSummary].length > 80) {
      const nextLength = Math.max(80, [...step.objectiveSummary].length - 32);
      step.objectiveSummary = clipUtf8(step.objectiveSummary, nextLength, nextLength * 4);
      continue;
    }
    throw new MemoryPreGateContextError('Bounded execution state exceeds its UTF-8 byte budget.');
  }
  return bounded;
}

function boundArtifact(input: unknown): MemoryPreGateArtifactSummary {
  if (!isPlainRecord(input) || !hasExactKeys(input, ARTIFACT_KEYS)) {
    throw new MemoryPreGateContextError();
  }
  const id = input.id;
  if (!isBoundedIdentifier(id, MEMORY_PRE_GATE_POLICY.maxArtifactIdCharacters)) {
    throw new MemoryPreGateContextError();
  }
  const kind = sanitizeText(input.kind, MEMORY_PRE_GATE_POLICY.maxArtifactKindCharacters);
  const name = sanitizeText(input.name, MEMORY_PRE_GATE_POLICY.maxArtifactNameCharacters);
  if (
    !kind ||
    !name ||
    !isSanitizedText(kind, MEMORY_PRE_GATE_POLICY.maxArtifactKindCharacters) ||
    !isSanitizedText(name, MEMORY_PRE_GATE_POLICY.maxArtifactNameCharacters)
  ) {
    throw new MemoryPreGateContextError();
  }
  return { id, kind, name };
}

function boundContract(input: unknown): MemoryPreGateOutputContractSummary {
  if (!isPlainRecord(input) || !hasOnlyKeys(input, CONTRACT_KEYS)) {
    throw new MemoryPreGateContextError();
  }
  const key = sanitizeText(input.key, MEMORY_PRE_GATE_POLICY.maxContractKeyCharacters);
  const kind = sanitizeText(input.kind, MEMORY_PRE_GATE_POLICY.maxContractKindCharacters);
  const contractId =
    input.contractId === undefined
      ? undefined
      : sanitizeText(input.contractId, MEMORY_PRE_GATE_POLICY.maxContractIdCharacters);
  const contractVersion =
    input.contractVersion === undefined
      ? undefined
      : sanitizeText(input.contractVersion, MEMORY_PRE_GATE_POLICY.maxContractVersionCharacters);
  if (
    !key ||
    !kind ||
    !isSanitizedText(key, MEMORY_PRE_GATE_POLICY.maxContractKeyCharacters) ||
    !isSanitizedText(kind, MEMORY_PRE_GATE_POLICY.maxContractKindCharacters) ||
    (input.contractId !== undefined &&
      (!contractId ||
        !isSanitizedText(contractId, MEMORY_PRE_GATE_POLICY.maxContractIdCharacters))) ||
    (input.contractVersion !== undefined &&
      (!contractVersion ||
        !isSanitizedText(contractVersion, MEMORY_PRE_GATE_POLICY.maxContractVersionCharacters)))
  ) {
    throw new MemoryPreGateContextError();
  }
  return {
    key,
    kind,
    ...(contractId ? { contractId } : {}),
    ...(contractVersion ? { contractVersion } : {}),
  };
}

interface DecisionState {
  sourceType: MemoryPreGateSourceType;
  trigger: MemoryPreGateTrigger;
  messageRole?: 'user' | 'assistant';
  evidence: MemoryEvidenceFacts;
  execution?: MemoryPreGateExecutionContext;
}

function makeDecisionState(context: MemoryPreGateContext): DecisionState {
  return {
    sourceType: context.sourceType,
    trigger: context.trigger,
    ...(context.messageRole ? { messageRole: context.messageRole } : {}),
    evidence: {
      evidenceCharacters: context.evidenceCharacters,
      semanticSignals: { ...context.semanticSignals },
    },
    ...(context.execution ? { execution: cloneExecution(context.execution) } : {}),
  };
}

function cloneExecution(value: MemoryPreGateExecutionContext): MemoryPreGateExecutionContext {
  return {
    objectiveSummary: value.objectiveSummary,
    ...(value.stepType ? { stepType: value.stepType } : {}),
    ...(value.requiredCapabilities
      ? { requiredCapabilities: [...value.requiredCapabilities] }
      : {}),
    ...(value.inputArtifactSummaries
      ? { inputArtifactSummaries: value.inputArtifactSummaries.map((item) => ({ ...item })) }
      : {}),
    ...(value.expectedOutputContract
      ? { expectedOutputContract: value.expectedOutputContract.map((item) => ({ ...item })) }
      : {}),
    ...(value.publicState ? { publicState: value.publicState } : {}),
  };
}

function isBoundedState(value: unknown): value is Record<string, unknown> & DecisionState {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, STATE_KEYS)) return false;
  if (!includes(SOURCE_TYPES, value.sourceType) || !includes(TRIGGERS, value.trigger)) return false;
  if (
    Object.hasOwn(value, 'messageRole') &&
    value.messageRole !== 'user' &&
    value.messageRole !== 'assistant'
  ) {
    return false;
  }
  if (Object.hasOwn(value, 'execution') && value.execution === undefined) return false;
  if (
    value.sourceType !== 'CHAT_MESSAGE' &&
    (value.messageRole !== undefined || value.execution === undefined)
  )
    return false;
  if (!isExactEvidence(value.evidence)) return false;
  if (value.execution !== undefined && !isBoundedExecution(value.execution)) return false;
  return (
    Buffer.byteLength(canonicalDecisionJson(value), 'utf8') <= MEMORY_PRE_GATE_POLICY.maxStateBytes
  );
}

function isBoundedExecution(value: unknown): value is MemoryPreGateExecutionContext {
  try {
    const bounded = boundExecution(value);
    return canonicalDecisionJson(bounded) === canonicalDecisionJson(value);
  } catch {
    return false;
  }
}

function isExactEvidence(value: unknown): value is MemoryEvidenceFacts {
  if (!isPlainRecord(value) || !hasExactKeys(value, EVIDENCE_KEYS)) return false;
  if (
    !Number.isSafeInteger(value.evidenceCharacters) ||
    (value.evidenceCharacters as number) < 0 ||
    (value.evidenceCharacters as number) > MEMORY_PRE_GATE_POLICY.maxEvidenceCharacters ||
    !isExactSignalFacts(value.semanticSignals)
  ) {
    return false;
  }
  return true;
}

function isExactSignalFacts(value: unknown): value is MemoryEvidenceFacts['semanticSignals'] {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, SIGNAL_KEYS) &&
    typeof value.durableStatement === 'boolean' &&
    typeof value.questionOnly === 'boolean' &&
    typeof value.codeOrStructured === 'boolean'
  );
}

function isExactQuestionMap(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, new Set(['extraction']))) return false;
  const question = value.extraction;
  return (
    isPlainRecord(question) &&
    hasExactKeys(question, new Set(['type', 'instructions', 'criteria'])) &&
    question.type === 'choice' &&
    question.instructions === INSTRUCTIONS &&
    isPlainRecord(question.criteria) &&
    hasExactKeys(question.criteria, new Set(['RUN_EXTRACTION', 'SKIP_EXTRACTION'])) &&
    question.criteria.RUN_EXTRACTION === CHOICES.RUN_EXTRACTION &&
    question.criteria.SKIP_EXTRACTION === CHOICES.SKIP_EXTRACTION
  );
}

function isExactInputSummary(value: unknown, state: DecisionState): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, new Set(['taskSummary', 'candidateIds'])) &&
    value.taskSummary === (state.execution?.objectiveSummary ?? STATIC_CHAT_SUMMARY) &&
    Array.isArray(value.candidateIds) &&
    value.candidateIds.length === 0
  );
}

function hashDecisionState(state: DecisionState): string {
  return createHash('sha256')
    .update(
      canonicalDecisionJson({
        policyVersion: MEMORY_PRE_GATE_POLICY.version,
        questionVersion: MEMORY_PRE_GATE_POLICY.questionVersion,
        state,
      }),
      'utf8',
    )
    .digest('hex');
}

function validateMemoryPreGateResult(
  value: unknown,
):
  | { kind: 'valid'; decision: MemoryPreGateDecision; confidence: number }
  | { kind: 'error'; errorCode: DecisionErrorCode }
  | { kind: 'invalid' } {
  try {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, RESULT_KEYS)) return { kind: 'invalid' };
    const serialized = JSON.stringify(value);
    if (
      typeof serialized !== 'string' ||
      Buffer.byteLength(serialized, 'utf8') > MEMORY_PRE_GATE_POLICY.maxResponseBytes
    ) {
      return { kind: 'invalid' };
    }
    if (!validTelemetry(value)) return { kind: 'invalid' };
    if (value.errorCode !== undefined && value.errorCode !== null) {
      if (
        !includes(ERROR_CODES, value.errorCode) ||
        !isPlainRecord(value.answers) ||
        Object.keys(value.answers).length !== 0 ||
        !isPlainRecord(value.confidence) ||
        Object.keys(value.confidence).length !== 0 ||
        value.selectedAction !== null ||
        value.choiceProbabilities !== undefined
      ) {
        return { kind: 'invalid' };
      }
      return { kind: 'error', errorCode: value.errorCode };
    }
    if (
      !isPlainRecord(value.answers) ||
      !hasExactKeys(value.answers, new Set(['extraction'])) ||
      (value.answers.extraction !== 'RUN_EXTRACTION' &&
        value.answers.extraction !== 'SKIP_EXTRACTION') ||
      !isPlainRecord(value.confidence) ||
      !hasExactKeys(value.confidence, new Set(['extraction'])) ||
      !isConfidence(value.confidence.extraction) ||
      value.selectedAction !== null ||
      !validChoiceProbabilities(value.choiceProbabilities)
    ) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'valid',
      decision: value.answers.extraction,
      confidence: value.confidence.extraction,
    };
  } catch {
    return { kind: 'invalid' };
  }
}

function validChoiceProbabilities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainRecord(value) || !hasExactKeys(value, new Set(['RUN_EXTRACTION', 'SKIP_EXTRACTION'])))
    return false;
  return isConfidence(value.RUN_EXTRACTION) && isConfidence(value.SKIP_EXTRACTION);
}

function validTelemetry(value: Record<string, unknown>): boolean {
  if (value.provider !== undefined && value.provider !== 'TYPESAFE') return false;
  if (
    value.model !== undefined &&
    value.model !== null &&
    (typeof value.model !== 'string' ||
      value.model.length > 128 ||
      !/^jev-[0-9.]+$/u.test(value.model))
  ) {
    return false;
  }
  return (
    boundedTelemetryNumber(value.inputTokens, 1_000_000) &&
    boundedTelemetryNumber(value.outputTokens, 1_000_000) &&
    boundedTelemetryNumber(value.latencyMs, 60_000)
  );
}

function makeFallbackReceipt(
  context: MemoryPreGateContext,
  stateHash: string,
  decision: MemoryPreGateDecision,
  reason: MemoryPreGateReason,
  errorCode: DecisionErrorCode | null,
): MemoryPreGateReceipt {
  return {
    sourceType: context.sourceType,
    ownerId: context.ownerId,
    sourceId: context.sourceId,
    trigger: context.trigger,
    mode: 'DETERMINISTIC_FALLBACK',
    decision,
    confidence: null,
    stateHash,
    policyVersion: MEMORY_PRE_GATE_POLICY.version,
    questionVersion: MEMORY_PRE_GATE_POLICY.questionVersion,
    reason,
    errorCode,
  };
}

function fallbackFor(trigger: MemoryPreGateTrigger): MemoryPreGateDecision {
  return trigger === 'USER_EXPLICIT' ? 'RUN_EXTRACTION' : 'SKIP_EXTRACTION';
}

function sanitizeText(value: unknown, maxCharacters: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(
      /-----BEGIN [^-\r\n]{1,40}PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{1,40}PRIVATE KEY-----/giu,
      '[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, '[REDACTED]')
    .replace(/\b(?:sk|jev|api|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}\b/giu, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, '[REDACTED]')
    .replace(/\b(?:api[_ -]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return clipUtf8(normalized, maxCharacters, maxCharacters * 4);
}

function isSanitizedText(value: string, maxCharacters: number): boolean {
  return value === sanitizeText(value, maxCharacters);
}

function clipUtf8(value: string, maxCharacters: number, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  let characters = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (characters >= maxCharacters || bytes + size > maxBytes) break;
    result += character;
    bytes += size;
    characters += 1;
  }
  return result;
}

function hasDurableSignal(value: string): boolean {
  return (
    /\b(?:i am|i work|i live|i prefer|i always|i never|i usually|my \w+ is|our \w+ is|we use|we decided|remember that|from now on)\b/iu.test(
      value,
    ) || /(?:长期|以后|始终|偏好|我叫|我是|我住在|我们决定|请记住)/u.test(value)
  );
}

function looksStructured(value: string): boolean {
  return (
    /```|\b(?:function|const|let|var|class|import|export)\b|\{\s*["']?[^\s{}]+["']?\s*:|<\w+[^>]*>|(?:^|\n)\s*(?:[-*+]\s|\d+[.)]\s)/u.test(
      value,
    ) || /(?:=>|===|\w+\([^)]*\)\s*\{|\b[A-Z_]{3,}=[^\s]+)/u.test(value)
  );
}

function isBoundedIdentifier(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxCharacters &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value) &&
    isSanitizedText(value, maxCharacters)
  );
}

function boundedTelemetryNumber(value: unknown, max: number): boolean {
  return value === undefined || value === null || isBoundedNumber(value, max);
}

function isConfidence(value: unknown): value is number {
  return isBoundedNumber(value, 1);
}

function isBoundedNumber(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        expected.has(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'),
    )
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      allowed.has(key) &&
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'),
  );
}

class MemoryPreGateTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new MemoryPreGateTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
