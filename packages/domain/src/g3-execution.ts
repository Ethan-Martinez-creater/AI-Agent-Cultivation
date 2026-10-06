import type { CapabilityDimension } from './index.js';

/** The dispatch protocol is intentionally distinct from MODEL_RUNTIME identity. */
export type ExecutionDispatchProtocol = 'LANGUAGE' | 'GENERATION' | 'USER_BRIDGE';
export type ExecutionTaskSource = 'COLLABORATION' | 'WORKFLOW';

export type ExecutionAttemptState =
  | 'PREPARED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'WAITING_CAPABILITY'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN';

export const G3_EXECUTION_POLICY = Object.freeze({
  version: 'g3-execution-policy-v1',
  maxParticipantAttempts: 3,
  maxContinuationRounds: 3,
  maxRetryAttemptsPerParticipantTask: 1,
});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ArtifactRef {
  id: string;
  kind: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
}

export interface ArtifactInputRef extends ArtifactRef {
  role: string;
}

export interface ArtifactRequirement {
  role: string;
  artifactKinds?: string[];
  mimeTypes?: string[];
  required: boolean;
}

export interface G3GenerationRequirements {
  capability: CapabilityDimension;
  requiredFeatures: string[];
  prompt?: string;
  parameters: Record<string, JsonValue>;
  expectedOutput: { artifactKind: string; mimeTypes: string[] };
  outputDestination: {
    scope: 'APP_ARTIFACT_STORE' | 'MISSION_WORKSPACE';
    logicalPathHint?: string | null;
  };
  inputRequirements?: ArtifactRequirement[];
  reviewCapability?: CapabilityDimension;
}

/** Immutable, provider-neutral envelope persisted for one dispatch decision. */
export interface ExecutionTask {
  id: string;
  logicalKey: string;
  source: ExecutionTaskSource;
  missionId: string;
  runId: string;
  collaborationRequestId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
  requesterTeammateId: string | null;
  coordinatorTeammateId: string | null;
  targetTeammateId: string;
  requiredCapability: CapabilityDimension;
  executionProtocol: ExecutionDispatchProtocol;
  publicTask: string;
  publicContext: string;
  artifactInputs: ArtifactInputRef[];
  generationRequirements?: G3GenerationRequirements | null;
  acceptanceCriteria: string[];
  /** Optional shared input constraints for non-generation dispatchers and generation fallback. */
  inputRequirements?: ArtifactRequirement[];
  dependencyRole?: string | null;
  reviewOf?: ArtifactRef[];
  parentTaskId: string | null;
  retryNo: number;
  continuationRound: number;
  policyVersion: string;
  createdAt: string;
}

export interface ExecutionAttempt {
  id: string;
  taskId: string;
  attemptNo: number;
  runtimeProfileId: string | null;
  state: ExecutionAttemptState;
  generationJobId: string | null;
  externalWorkRequestId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CreateExecutionAttemptInput {
  id?: string;
  attemptNo?: number;
  runtimeProfileId?: string | null;
  createdAt?: string;
}
export interface ExecutionAttemptPatch {
  errorCode?: string | null;
  updatedAt?: string;
}

export type ParticipantOutcome =
  | { kind: 'RESULT'; publicResult?: string; artifactRefs: ArtifactRef[] }
  | { kind: 'NEEDS_INPUT'; requirements: ArtifactRequirement[]; reason: string }
  | {
      kind: 'NEEDS_CAPABILITY';
      capability: CapabilityDimension;
      requiredFeatures?: string[];
      requestedInputs?: ArtifactRequirement[];
      reason: string;
    }
  | { kind: 'FAILED_RETRYABLE'; errorCode: string; reason: string }
  | { kind: 'FAILED_TERMINAL'; errorCode: string; reason: string };

/** Identity is copied from the persisted attempt/task, never accepted from payload JSON. */
export interface ParticipantOutcomeFact {
  id: string;
  taskId: string;
  attemptId: string;
  missionId: string;
  runId: string;
  collaborationRequestId: string | null;
  participantTeammateId: string;
  executionProtocol: ExecutionDispatchProtocol;
  outcome: ParticipantOutcome;
  createdAt: string;
  consumedAt: string | null;
}

export type G3ContinuationAction =
  | 'RESUME'
  | 'WAIT_FOR_USER'
  | 'REQUEST_CAPABILITY'
  | 'REQUEST_INPUT'
  | 'RETRY'
  | 'REVIEW'
  | 'RESULT'
  | 'FAIL';
export interface G3ContinuationDecision {
  action: G3ContinuationAction;
  reason?: string;
  nextTaskId?: string | null;
  /** Trusted coordinator intent, bounded to 8 KiB before persistence. */
  data?: Record<string, JsonValue>;
}

export type ArtifactRefSourceType = 'GENERATION' | 'EXTERNAL_WORK' | 'APPROVED_IMPORT';
export interface ArtifactRefSource {
  type: ArtifactRefSourceType;
  id: string;
}

export function parseG3ContinuationDecision(value: unknown): G3ContinuationDecision {
  const object = asRecord(value, 'G3ContinuationDecision');
  assertKeys(object, ['action', 'reason', 'nextTaskId', 'data'], 'G3ContinuationDecision');
  const actions: readonly G3ContinuationAction[] = [
    'RESUME',
    'WAIT_FOR_USER',
    'REQUEST_CAPABILITY',
    'REQUEST_INPUT',
    'RETRY',
    'REVIEW',
    'RESULT',
    'FAIL',
  ];
  if (
    typeof object.action !== 'string' ||
    !actions.includes(object.action as G3ContinuationAction)
  ) {
    throw new Error('G3ContinuationDecision action is unsupported');
  }
  const reason =
    object.reason === undefined
      ? undefined
      : boundedString(object.reason, G3_OUTCOME_LIMITS.reasonChars, 'reason');
  const nextTaskId =
    object.nextTaskId === undefined
      ? undefined
      : object.nextTaskId === null
        ? null
        : boundedString(object.nextTaskId, 256, 'nextTaskId');
  const data = object.data === undefined ? undefined : parseBoundedJsonRecord(object.data, 'data');
  return {
    action: object.action as G3ContinuationAction,
    ...(reason === undefined ? {} : { reason }),
    ...(nextTaskId === undefined ? {} : { nextTaskId }),
    ...(data === undefined ? {} : { data }),
  };
}

export interface G3Continuation {
  id: string;
  outcomeId: string;
  taskId: string;
  attemptId: string;
  missionId: string;
  runId: string;
  collaborationRequestId: string | null;
  decision: G3ContinuationDecision;
  continuationRound: number;
  createdAt: string;
  consumedAt: string | null;
}

export const G3_EXECUTION_ATTEMPT_TRANSITIONS: Readonly<
  Record<ExecutionAttemptState, readonly ExecutionAttemptState[]>
> = Object.freeze({
  PREPARED: ['RUNNING', 'WAITING_INPUT', 'WAITING_CAPABILITY', 'WAITING_USER', 'FAILED', 'UNKNOWN'],
  RUNNING: [
    'WAITING_INPUT',
    'WAITING_CAPABILITY',
    'WAITING_USER',
    'COMPLETED',
    'FAILED',
    'UNKNOWN',
  ],
  WAITING_INPUT: ['RUNNING', 'WAITING_USER', 'FAILED', 'UNKNOWN'],
  WAITING_CAPABILITY: ['RUNNING', 'WAITING_USER', 'FAILED', 'UNKNOWN'],
  WAITING_USER: ['RUNNING', 'FAILED', 'UNKNOWN'],
  COMPLETED: [],
  FAILED: [],
  UNKNOWN: [],
});

export function transitionExecutionAttempt(
  from: ExecutionAttemptState,
  to: ExecutionAttemptState,
): ExecutionAttemptState {
  if (!G3_EXECUTION_ATTEMPT_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid ExecutionAttempt transition ${from} -> ${to}`);
  }
  return to;
}

export const G3_OUTCOME_LIMITS = Object.freeze({
  publicResultChars: 4000,
  reasonChars: 2000,
  maxArtifacts: 32,
  maxRequirements: 16,
  maxFeatures: 32,
  maxTextListItems: 32,
  maxJsonDepth: 8,
  maxJsonBytes: 32768,
  maxContinuationJsonBytes: 8192,
});

const capabilityDimensions: readonly CapabilityDimension[] = [
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
];

/** Parse at the trust boundary: only the documented variant keys are accepted. */
export function parseParticipantOutcome(value: unknown): ParticipantOutcome {
  const object = asRecord(value, 'ParticipantOutcome');
  const kind = requiredString(object.kind, 40, 'kind');
  switch (kind) {
    case 'RESULT': {
      assertKeys(object, ['kind', 'publicResult', 'artifactRefs'], kind);
      const publicResult = optionalBoundedString(
        object.publicResult,
        G3_OUTCOME_LIMITS.publicResultChars,
        'publicResult',
      );
      const refs = arrayValue(
        object.artifactRefs,
        G3_OUTCOME_LIMITS.maxArtifacts,
        'artifactRefs',
      ).map((entry, index) => parseArtifactRef(entry, `artifactRefs[${index}]`));
      return publicResult === undefined
        ? { kind, artifactRefs: refs }
        : { kind, publicResult, artifactRefs: refs };
    }
    case 'NEEDS_INPUT': {
      assertKeys(object, ['kind', 'requirements', 'reason'], kind);
      return {
        kind,
        requirements: parseRequirements(object.requirements, 'requirements'),
        reason: boundedString(object.reason, G3_OUTCOME_LIMITS.reasonChars, 'reason'),
      };
    }
    case 'NEEDS_CAPABILITY': {
      assertKeys(
        object,
        ['kind', 'capability', 'requiredFeatures', 'requestedInputs', 'reason'],
        kind,
      );
      const capability = parseCapability(object.capability, 'capability');
      const requiredFeatures =
        object.requiredFeatures === undefined
          ? undefined
          : parseTextList(
              object.requiredFeatures,
              G3_OUTCOME_LIMITS.maxFeatures,
              80,
              'requiredFeatures',
            );
      const requestedInputs =
        object.requestedInputs === undefined
          ? undefined
          : parseRequirements(object.requestedInputs, 'requestedInputs');
      return {
        kind,
        capability,
        ...(requiredFeatures === undefined ? {} : { requiredFeatures }),
        ...(requestedInputs === undefined ? {} : { requestedInputs }),
        reason: boundedString(object.reason, G3_OUTCOME_LIMITS.reasonChars, 'reason'),
      };
    }
    case 'FAILED_RETRYABLE':
    case 'FAILED_TERMINAL':
      assertKeys(object, ['kind', 'errorCode', 'reason'], kind);
      return {
        kind,
        errorCode: stableErrorCode(object.errorCode),
        reason: boundedString(object.reason, G3_OUTCOME_LIMITS.reasonChars, 'reason'),
      };
    default:
      throw new Error(`Unsupported ParticipantOutcome kind: ${kind}`);
  }
}

export function validateExecutionTask(task: ExecutionTask): ExecutionTask {
  const object = asRecord(task, 'ExecutionTask');
  assertKeys(
    object,
    [
      'id',
      'logicalKey',
      'source',
      'missionId',
      'runId',
      'collaborationRequestId',
      'workflowRunId',
      'workflowStepRunId',
      'requesterTeammateId',
      'coordinatorTeammateId',
      'targetTeammateId',
      'requiredCapability',
      'executionProtocol',
      'publicTask',
      'publicContext',
      'artifactInputs',
      'generationRequirements',
      'acceptanceCriteria',
      'inputRequirements',
      'dependencyRole',
      'reviewOf',
      'parentTaskId',
      'retryNo',
      'continuationRound',
      'policyVersion',
      'createdAt',
    ],
    'ExecutionTask',
  );
  boundedString(object.id, 256, 'id');
  boundedString(object.logicalKey, 256, 'logicalKey');
  if (object.source !== 'COLLABORATION' && object.source !== 'WORKFLOW')
    throw new Error('Invalid task source');
  boundedString(object.missionId, 256, 'missionId');
  boundedString(object.runId, 256, 'runId');
  nullableBoundedString(object.collaborationRequestId, 256, 'collaborationRequestId');
  nullableBoundedString(object.workflowRunId, 256, 'workflowRunId');
  nullableBoundedString(object.workflowStepRunId, 256, 'workflowStepRunId');
  nullableBoundedString(object.requesterTeammateId, 256, 'requesterTeammateId');
  nullableBoundedString(object.coordinatorTeammateId, 256, 'coordinatorTeammateId');
  boundedString(object.targetTeammateId, 256, 'targetTeammateId');
  if (object.source === 'COLLABORATION' && !isNonEmptyString(object.collaborationRequestId)) {
    throw new Error('Collaboration ExecutionTask requires collaborationRequestId');
  }
  if (
    object.source === 'COLLABORATION' &&
    (object.workflowRunId !== null || object.workflowStepRunId !== null)
  ) {
    throw new Error('Collaboration ExecutionTask cannot be bound to Workflow identities');
  }
  if (object.source === 'WORKFLOW' && object.collaborationRequestId !== null)
    throw new Error('Workflow ExecutionTask cannot be bound to a collaboration request');
  if (
    object.executionProtocol !== 'LANGUAGE' &&
    object.executionProtocol !== 'GENERATION' &&
    object.executionProtocol !== 'USER_BRIDGE'
  ) {
    throw new Error('Invalid ExecutionTask protocol');
  }
  parseCapability(object.requiredCapability, 'requiredCapability');
  boundedString(object.publicTask, 4000, 'publicTask');
  if (typeof object.publicContext !== 'string' || object.publicContext.length > 12000)
    throw new Error('publicContext must be text of at most 12000 characters');
  const artifactInputs = arrayValue(object.artifactInputs, 32, 'artifactInputs');
  for (const [index, entry] of artifactInputs.entries())
    parseArtifactInputRef(entry, `artifactInputs[${index}]`);
  const acceptanceCriteria = arrayValue(object.acceptanceCriteria, 16, 'acceptanceCriteria');
  acceptanceCriteria.forEach((item, index) =>
    boundedString(item, 1200, `acceptanceCriteria[${index}]`),
  );
  if (object.inputRequirements !== undefined)
    parseRequirements(object.inputRequirements, 'inputRequirements');
  if (object.dependencyRole !== undefined)
    nullableBoundedString(object.dependencyRole, 80, 'dependencyRole');
  if (object.reviewOf !== undefined) {
    arrayValue(object.reviewOf, 32, 'reviewOf').forEach((item, index) =>
      parseArtifactRef(item, `reviewOf[${index}]`),
    );
  }
  nullableBoundedString(object.parentTaskId, 256, 'parentTaskId');
  boundedString(object.policyVersion, 80, 'policyVersion');
  boundedString(object.createdAt, 64, 'createdAt');
  if (object.executionProtocol === 'GENERATION') {
    if (!object.generationRequirements)
      throw new Error('GENERATION task requires generationRequirements');
    validateGenerationRequirements(
      object.generationRequirements,
      object.requiredCapability as CapabilityDimension,
    );
  } else if (object.generationRequirements != null) {
    throw new Error('Only GENERATION tasks may include generationRequirements');
  }
  if (
    !Number.isInteger(object.retryNo) ||
    (object.retryNo as number) < 0 ||
    (object.retryNo as number) > G3_EXECUTION_POLICY.maxRetryAttemptsPerParticipantTask
  ) {
    throw new Error('ExecutionTask retryNo exceeds the versioned retry budget');
  }
  if (
    !Number.isInteger(object.continuationRound) ||
    (object.continuationRound as number) < 0 ||
    (object.continuationRound as number) > G3_EXECUTION_POLICY.maxContinuationRounds
  ) {
    throw new Error('ExecutionTask continuationRound exceeds the versioned continuation budget');
  }
  if (
    object.retryNo === 0 &&
    object.parentTaskId === null &&
    (object.continuationRound as number) > 0
  ) {
    throw new Error('Continuation tasks must retain parentTaskId provenance');
  }
  return task;
}

function parseArtifactRef(value: unknown, label: string): ArtifactRef {
  const object = asRecord(value, label);
  assertKeys(object, ['id', 'kind', 'mimeType', 'contentHash', 'sizeBytes'], label);
  return {
    id: boundedString(object.id, 256, `${label}.id`),
    kind: boundedString(object.kind, 80, `${label}.kind`),
    mimeType: boundedString(object.mimeType, 160, `${label}.mimeType`),
    contentHash: parseHash(object.contentHash, `${label}.contentHash`),
    sizeBytes: positiveInteger(object.sizeBytes, `${label}.sizeBytes`),
  };
}

function parseArtifactInputRef(value: unknown, label: string): ArtifactInputRef {
  const object = asRecord(value, label);
  assertKeys(object, ['id', 'kind', 'mimeType', 'contentHash', 'sizeBytes', 'role'], label);
  const ref = parseArtifactRef(
    {
      id: object.id,
      kind: object.kind,
      mimeType: object.mimeType,
      contentHash: object.contentHash,
      sizeBytes: object.sizeBytes,
    },
    label,
  );
  return { ...ref, role: boundedString(object.role, 80, `${label}.role`) };
}

function validateGenerationRequirements(
  value: unknown,
  requiredCapability: CapabilityDimension,
): void {
  const object = asRecord(value, 'generationRequirements');
  assertKeys(
    object,
    [
      'capability',
      'requiredFeatures',
      'prompt',
      'parameters',
      'expectedOutput',
      'outputDestination',
      'inputRequirements',
      'reviewCapability',
    ],
    'generationRequirements',
  );
  if (
    parseCapability(object.capability, 'generationRequirements.capability') !== requiredCapability
  ) {
    throw new Error('Generation capability must match requiredCapability');
  }
  parseTextList(
    object.requiredFeatures,
    G3_OUTCOME_LIMITS.maxFeatures,
    80,
    'generationRequirements.requiredFeatures',
  );
  if (object.prompt !== undefined)
    boundedString(object.prompt, 12000, 'generationRequirements.prompt');
  const parameters = asRecord(object.parameters, 'generationRequirements.parameters');
  assertBoundedJson(
    parameters,
    G3_OUTCOME_LIMITS.maxJsonBytes,
    'generationRequirements.parameters',
  );
  const expected = asRecord(object.expectedOutput, 'generationRequirements.expectedOutput');
  assertKeys(expected, ['artifactKind', 'mimeTypes'], 'generationRequirements.expectedOutput');
  boundedString(expected.artifactKind, 80, 'generationRequirements.expectedOutput.artifactKind');
  parseTextList(
    expected.mimeTypes,
    G3_OUTCOME_LIMITS.maxTextListItems,
    160,
    'generationRequirements.expectedOutput.mimeTypes',
  );
  const destination = asRecord(
    object.outputDestination,
    'generationRequirements.outputDestination',
  );
  assertKeys(destination, ['scope', 'logicalPathHint'], 'generationRequirements.outputDestination');
  if (destination.scope !== 'APP_ARTIFACT_STORE' && destination.scope !== 'MISSION_WORKSPACE') {
    throw new Error('generationRequirements.outputDestination.scope is unsupported');
  }
  if (destination.logicalPathHint !== undefined)
    nullableBoundedString(
      destination.logicalPathHint,
      1024,
      'generationRequirements.outputDestination.logicalPathHint',
    );
  if (object.inputRequirements !== undefined)
    parseRequirements(object.inputRequirements, 'generationRequirements.inputRequirements');
  if (object.reviewCapability !== undefined)
    parseCapability(object.reviewCapability, 'generationRequirements.reviewCapability');
}

function assertBoundedJson(value: unknown, maxBytes: number, label: string): void {
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > G3_OUTCOME_LIMITS.maxJsonDepth) return false;
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return true;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (Array.isArray(entry)) return entry.every((child) => visit(child, depth + 1));
    if (typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return Object.keys(record).every(
        (key) =>
          !['__proto__', 'constructor', 'prototype'].includes(key) && visit(record[key], depth + 1),
      );
    }
    return false;
  };
  if (!visit(value, 0)) throw new Error(`${label} contains non-JSON, unsafe, or over-deep values`);
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
}

function parseBoundedJsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  const object = asRecord(value, label);
  const visit = (entry: unknown, depth: number): entry is JsonValue => {
    if (depth > G3_OUTCOME_LIMITS.maxJsonDepth) return false;
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return true;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (Array.isArray(entry)) return entry.every((child) => visit(child, depth + 1));
    if (typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return Object.keys(record).every(
        (key) =>
          !['__proto__', 'constructor', 'prototype'].includes(key) && visit(record[key], depth + 1),
      );
    }
    return false;
  };
  if (!visit(object, 0)) throw new Error(`${label} contains non-JSON, unsafe, or over-deep values`);
  const serialized = JSON.stringify(object);
  if (new TextEncoder().encode(serialized).length > G3_OUTCOME_LIMITS.maxContinuationJsonBytes) {
    throw new Error(`${label} exceeds ${G3_OUTCOME_LIMITS.maxContinuationJsonBytes} UTF-8 bytes`);
  }
  return object as Record<string, JsonValue>;
}

function parseRequirements(value: unknown, label: string): ArtifactRequirement[] {
  return arrayValue(value, G3_OUTCOME_LIMITS.maxRequirements, label).map((entry, index) => {
    const requirementLabel = `${label}[${index}]`;
    const object = asRecord(entry, requirementLabel);
    assertKeys(object, ['role', 'artifactKinds', 'mimeTypes', 'required'], requirementLabel);
    if (typeof object.required !== 'boolean')
      throw new Error(`${requirementLabel}.required must be boolean`);
    const artifactKinds =
      object.artifactKinds === undefined
        ? undefined
        : parseTextList(
            object.artifactKinds,
            G3_OUTCOME_LIMITS.maxTextListItems,
            80,
            `${requirementLabel}.artifactKinds`,
          );
    const mimeTypes =
      object.mimeTypes === undefined
        ? undefined
        : parseTextList(
            object.mimeTypes,
            G3_OUTCOME_LIMITS.maxTextListItems,
            160,
            `${requirementLabel}.mimeTypes`,
          );
    return {
      role: boundedString(object.role, 80, `${requirementLabel}.role`),
      ...(artifactKinds === undefined ? {} : { artifactKinds }),
      ...(mimeTypes === undefined ? {} : { mimeTypes }),
      required: object.required,
    };
  });
}

function parseTextList(
  value: unknown,
  maxItems: number,
  maxLength: number,
  label: string,
): string[] {
  return arrayValue(value, maxItems, label).map((item, index) =>
    boundedString(item, maxLength, `${label}[${index}]`),
  );
}

function parseCapability(value: unknown, label: string): CapabilityDimension {
  if (typeof value !== 'string' || !capabilityDimensions.includes(value as CapabilityDimension)) {
    throw new Error(`${label} is not a supported CapabilityDimension`);
  }
  return value as CapabilityDimension;
}

function stableErrorCode(value: unknown): string {
  const code = boundedString(value, 80, 'errorCode');
  if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(code))
    throw new Error('errorCode must be a stable uppercase code');
  return code;
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error(`${label} must be a SHA-256 hash`);
  return value.toLowerCase();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function arrayValue(value: unknown, maxItems: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new Error(`${label} must be an array of at most ${maxItems} items`);
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length) throw new Error(`${label} contains unsupported field(s): ${extra.join(', ')}`);
}

function boundedString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be non-empty text of at most ${maxLength} characters`);
  }
  return value;
}

function nullableBoundedString(value: unknown, maxLength: number, label: string): string | null {
  return value === null ? null : boundedString(value, maxLength, label);
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
  label: string,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength, label);
}

function requiredString(value: unknown, maxLength: number, label: string): string {
  return boundedString(value, maxLength, label);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
