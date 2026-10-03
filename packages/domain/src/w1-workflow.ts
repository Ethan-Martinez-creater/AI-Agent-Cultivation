import { DomainError } from '@cultivation/shared';
import type { RoutingTaskContext } from './r4-routing.js';
import {
  EMPTY_WORKFLOW_INPUT_SCHEMA,
  validateWorkflowInputSchema,
} from './w1-workflow-contract.js';
import type {
  WorkflowObjectSchema,
  WorkflowOutputSchema,
  WorkflowInputs,
  WorkflowFinalValidation,
} from './w1-workflow-contract.js';
import {
  validateW2WorkflowVersion,
  W2_CONTRACT_POLICY,
  type ArtifactContract,
  type BoundedRevisionGroup,
  type RevisionTraversal,
  type StepOperationReceipt,
  type WorkflowReleaseMetadata,
} from './w2-workflow.js';

export type WorkflowRunState =
  | 'DRAFT'
  | 'READY'
  | 'RUNNING'
  | 'WAITING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';
export type WorkflowStepState =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED';
export type WorkflowWaitReason =
  | 'APPROVAL'
  | 'EXTERNAL_WORK'
  | 'USER_CONFIRMATION'
  | 'MISSION'
  | 'DECISION';
export type WorkflowStepType = 'TASK' | 'REVIEW' | 'DECISION';
export type WorkflowArtifactKind = 'TEXT' | 'JSON' | 'FILE' | 'DIRECTORY' | 'EXTERNAL_REFERENCE';
/** Inline W1 validators, frozen in the Definition version. W2 may add registry-backed validators. */
export interface WorkflowArtifactSpec {
  key: string;
  kind: WorkflowArtifactKind;
  required: boolean;
  contractId: string;
  contractVersion: string;
  maxSizeBytes: number;
  description: string;
  validator:
    | { type: 'TEXT'; minLength: number; requiredSections: string[] }
    | { type: 'JSON'; requiredKeys: string[] }
    | { type: 'METADATA'; allowedExtensions: string[] }
    | { type: 'REGISTRY'; contractId: string; contractVersion: string };
}
export interface WorkflowInputBinding {
  key: string;
  fromStepId: string;
  outputKey: string;
  required: boolean;
}
export interface WorkflowStepDefinition {
  id: string;
  /** Optional frozen phase label, for example N01 or N02. */
  phase?: string;
  type: WorkflowStepType;
  title: string;
  objective: string;
  routing: Omit<RoutingTaskContext, 'objective' | 'inputArtifactMetadata' | 'executionContext'>;
  inputs: WorkflowInputBinding[];
  /** Selected frozen Workflow Input fields; absent means none. */
  workflowInputKeys?: string[];
  outputs: WorkflowArtifactSpec[];
  /** Selects the one required JSON output that carries a REVIEW decision. */
  reviewOutputKey?: string;
  /** DECISION-only durable final user confirmation gate. */
  confirmationRequired?: boolean;
  /** Purpose-specific execution routing requirement resolved by the Main adapter. */
  executionRequirements?: {
    toolPurpose: 'RESEARCH' | 'ASSET_COLLECTION' | 'VOICEOVER' | 'VIDEO_ASSEMBLY';
  };
  /** Main adapter scopes declared paths to this Workflow Step attempt. */
  artifactPathScope?: 'RUN_ATTEMPT';
  maxAttempts: number;
  exitCondition: 'VALID_OUTPUTS' | 'REVIEW_PASS';
  /** Declaration only: uncertain interrupted execution always needs explicit user action. */
  effectType: 'NONE' | 'FILE_OUTPUT' | 'WORKSPACE_MUTATION' | 'EXTERNAL_ACTION';
  /** Explicit relative paths the Main adapter may inspect for declared side effects. */
  effectPaths?: string[];
}
export interface WorkflowEdge {
  id: string;
  fromStepId: string;
  toStepId: string | null;
  branch: string;
  condition:
    | { type: 'ALWAYS' }
    | { type: 'REVIEW_VERDICT'; verdict: 'PASS' | 'REVISE' | 'FAIL' }
    | {
        type: 'JSON_FIELD_EQUALS';
        inputKey: string;
        field: string;
        equals: string | number | boolean;
      };
  /** Optional static selector for one of several bounded REVIEW REVISE edges. */
  revisionCode?: string;
  /** Static, bounded W2 traversal declaration. */
  revision?: { groupId: string; maxTraversals: number };
}
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  source: 'BUILTIN' | 'USER' | 'IMPORTED';
}
export interface WorkflowVersion {
  definition: WorkflowDefinition;
  version: number;
  /** Absent only on legacy no-input versions, equivalent to an empty closed object schema. */
  inputSchema?: WorkflowObjectSchema;
  outputSchema?: WorkflowOutputSchema;
  /** Exact immutable Contract definitions referenced by REGISTRY-backed outputs. */
  contractManifest?: ArtifactContract[];
  revisionGroups?: BoundedRevisionGroup[];
  releaseMetadata?: WorkflowReleaseMetadata;
  /** Trusted, versioned application policy. Only official builtins may declare one. */
  validationPolicy?: string;
  entryStepId: string;
  steps: WorkflowStepDefinition[];
  edges: WorkflowEdge[];
  referenceBasis: Array<{
    title: string;
    organizationOrCommunity?: string;
    referenceType?:
      | 'INDUSTRY_PRACTICE'
      | 'ACADEMIC_METHOD'
      | 'STANDARD_OR_GUIDE'
      | 'COMMUNITY_PRACTICE';
    uri?: string;
    retrievedAt?: string;
    adoptedPrinciples: string[];
    intentionallyExcludedMechanisms?: string[];
    notes?: string;
  }>;
  createdAt: string;
}
export interface WorkflowRun {
  id: string;
  definitionId: string;
  definitionVersion: number;
  /** Legacy absent snapshots are empty; all newly created Runs persist this immutable value. */
  inputSnapshot?: WorkflowInputs;
  state: WorkflowRunState;
  waitReason: WorkflowWaitReason | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowStepRun {
  id: string;
  workflowRunId: string;
  stepId: string;
  attempt: number;
  state: WorkflowStepState;
  missionId: string | null;
  missionRunId: string | null;
  workspaceRoot?: string | null;
  waitReason: WorkflowWaitReason | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowArtifact {
  id: string;
  workflowRunId: string;
  producerStepRunId: string;
  missionId: string;
  missionRunId: string;
  actorId: string;
  sourceId: string;
  source: 'MISSION' | 'HUMAN_BRIDGE';
  kind: WorkflowArtifactKind;
  content: string;
  contentHash: string;
  metadata: Record<string, string | number>;
  inputArtifactIds: string[];
  createdAt: string;
}
export interface WorkflowArtifactBinding {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  key: string;
  artifactId: string;
  role: 'INPUT' | 'OUTPUT';
  contractId: string;
  contractVersion: string;
  createdAt: string;
}
export interface WorkflowValidationReceipt {
  id: string;
  stepRunId: string;
  artifactId: string;
  contractId: string;
  contractVersion: string;
  validatorVersion: string;
  contentHash: string;
  valid: boolean;
  errors: string[];
  createdAt: string;
}
export interface WorkflowCheckpoint {
  id: string;
  workflowRunId: string;
  sequence: number;
  definitionVersion: number;
  completedStepRunIds: string[];
  activeStepRunIds: string[];
  artifactBindingHashes: string[];
  decisionHashes: string[];
  stateHash: string;
  createdAt: string;
}
export interface WorkflowEvent {
  id: string;
  workflowRunId: string;
  stepRunId: string | null;
  type: string;
  payload: Record<string, string | number | boolean | null>;
  createdAt: string;
}
export interface WorkflowDecisionFact {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  edgeId: string;
  branch: string;
  inputHash: string;
  createdAt: string;
}
export interface WorkflowDetail {
  run: WorkflowRun;
  version: WorkflowVersion;
  steps: WorkflowStepRun[];
  artifacts: WorkflowArtifact[];
  bindings: WorkflowArtifactBinding[];
  validations: WorkflowValidationReceipt[];
  decisions: WorkflowDecisionFact[];
  checkpoints: WorkflowCheckpoint[];
  events: WorkflowEvent[];
  finalValidations?: WorkflowFinalValidation[];
  operations?: StepOperationReceipt[];
  traversals?: RevisionTraversal[];
}

const runTransitions: Record<WorkflowRunState, WorkflowRunState[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['WAITING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING: ['RUNNING', 'FAILED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['RUNNING', 'CANCELLED'],
  CANCELLED: [],
};
const stepTransitions: Record<WorkflowStepState, WorkflowStepState[]> = {
  PENDING: ['READY', 'SKIPPED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING: ['RUNNING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['READY'],
  SKIPPED: [],
  CANCELLED: [],
};
export function canTransitionWorkflowRun(from: WorkflowRunState, to: WorkflowRunState): boolean {
  return runTransitions[from].includes(to);
}
export function canTransitionWorkflowStep(from: WorkflowStepState, to: WorkflowStepState): boolean {
  return stepTransitions[from].includes(to);
}
export function transitionWorkflowRun(
  run: WorkflowRun,
  state: WorkflowRunState,
  at: string,
  waitReason: WorkflowWaitReason | null = null,
): WorkflowRun {
  if (state !== run.state && !canTransitionWorkflowRun(run.state, state))
    throw new DomainError(
      'WORKFLOW_INVALID_STATE',
      `Illegal Workflow transition: ${run.state} → ${state}`,
    );
  return { ...run, state, waitReason, updatedAt: at };
}
export function transitionWorkflowStep(
  step: WorkflowStepRun,
  state: WorkflowStepState,
  at: string,
  waitReason: WorkflowWaitReason | null = null,
): WorkflowStepRun {
  if (state !== step.state && !canTransitionWorkflowStep(step.state, state))
    throw new DomainError(
      'WORKFLOW_INVALID_STATE',
      `Illegal Step transition: ${step.state} → ${state}`,
    );
  return { ...step, state, waitReason, updatedAt: at };
}

/** W1 has one active path, forward edges only. Model output never becomes a graph. */
export function workflowOutputProjectionMatches(
  output: WorkflowArtifactSpec,
  producer: WorkflowArtifactSpec,
): boolean {
  // Validator lists are conjunctions/sets, so their ordering is not semantic.
  const semantic = (value: unknown): unknown =>
    Array.isArray(value)
      ? [...new Set(value)].sort().map(semantic)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, semantic(child)]),
          )
        : value;
  return (
    output.kind === producer.kind &&
    output.contractId === producer.contractId &&
    output.contractVersion === producer.contractVersion &&
    output.maxSizeBytes === producer.maxSizeBytes &&
    (!output.required || producer.required) &&
    JSON.stringify(semantic(output.validator)) === JSON.stringify(semantic(producer.validator))
  );
}
export function validateWorkflowVersion(value: WorkflowVersion): void {
  const invalid = (message: string): never => {
    throw new DomainError('INVALID_INPUT', message);
  };
  if (
    value.validationPolicy !== undefined &&
    (!/^[a-z][a-z0-9.-]{0,79}$/.test(value.validationPolicy) ||
      value.definition.source !== 'BUILTIN')
  )
    invalid('Unknown or untrusted Workflow validation policy');
  validateWorkflowInputSchema(value.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA);
  if (
    !value.definition.id ||
    !value.definition.name.trim() ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    value.steps.length < 1 ||
    value.steps.length > 32 ||
    value.edges.length > 96 ||
    JSON.stringify(value).length > 120_000
  )
    invalid('Invalid bounded Workflow definition');
  const ids = new Set(value.steps.map((s) => s.id));
  if (value.outputSchema !== undefined) {
    const outputs = value.outputSchema.outputs;
    if (
      Object.keys(value.outputSchema).some((k) => k !== 'outputs') ||
      !Array.isArray(outputs) ||
      outputs.length > 12 ||
      new Set(outputs.map((o) => o.key)).size !== outputs.length
    )
      invalid('Invalid final output schema');
    for (const output of outputs) {
      const producer = value.steps
        .find((s) => s.id === output.fromStepId)
        ?.outputs.find((o) => o.key === output.outputKey);
      if (!producer || !workflowOutputProjectionMatches(output, producer))
        invalid('Final output must project the exact declared producer contract');
    }
  }
  if (
    ids.size !== value.steps.length ||
    !ids.has(value.entryStepId) ||
    new Set(value.edges.map((e) => e.id)).size !== value.edges.length
  )
    invalid('Duplicate or missing Workflow identity');
  for (const s of value.steps) {
    if (
      s.workflowInputKeys !== undefined &&
      (!Array.isArray(s.workflowInputKeys) ||
        s.workflowInputKeys.length > 16 ||
        new Set(s.workflowInputKeys).size !== s.workflowInputKeys.length ||
        s.workflowInputKeys.some((k) => !Object.hasOwn(value.inputSchema?.properties ?? {}, k)))
    )
      invalid('Step references undeclared Workflow Input');
    if (
      !s.id ||
      (s.phase !== undefined &&
        (typeof s.phase !== 'string' || !s.phase.trim() || s.phase.length > 128)) ||
      !s.title.trim() ||
      !s.objective.trim() ||
      s.objective.length > 6_000 ||
      !Number.isInteger(s.maxAttempts) ||
      s.maxAttempts < 1 ||
      s.maxAttempts > 5 ||
      s.outputs.length > 12 ||
      s.inputs.length > 12
    )
      invalid('Invalid Step');
    if (
      !['TASK', 'REVIEW', 'DECISION'].includes(s.type) ||
      !['VALID_OUTPUTS', 'REVIEW_PASS'].includes(s.exitCondition) ||
      !['NONE', 'FILE_OUTPUT', 'WORKSPACE_MUTATION', 'EXTERNAL_ACTION'].includes(s.effectType)
    )
      invalid('Invalid Step policy');
    if (
      s.reviewOutputKey !== undefined &&
      (typeof s.reviewOutputKey !== 'string' || !s.reviewOutputKey.trim() || s.type !== 'REVIEW')
    )
      invalid('reviewOutputKey is supported only by REVIEW Steps');
    if (s.type === 'REVIEW') {
      const requiredJsonOutputs = s.outputs.filter((o) => o.kind === 'JSON' && o.required);
      if (
        requiredJsonOutputs.length === 0 ||
        (s.reviewOutputKey === undefined && requiredJsonOutputs.length !== 1) ||
        (s.reviewOutputKey !== undefined &&
          !requiredJsonOutputs.some((o) => o.key === s.reviewOutputKey))
      )
        invalid('REVIEW requires exactly one declared required JSON decision output');
    }
    if (
      s.confirmationRequired !== undefined &&
      (typeof s.confirmationRequired !== 'boolean' || s.type !== 'DECISION')
    )
      invalid('confirmationRequired is supported only by DECISION Steps');
    if (
      s.executionRequirements !== undefined &&
      (!s.executionRequirements ||
        typeof s.executionRequirements !== 'object' ||
        Object.getPrototypeOf(s.executionRequirements) !== Object.prototype ||
        Object.keys(s.executionRequirements).some((key) => key !== 'toolPurpose') ||
        !['RESEARCH', 'ASSET_COLLECTION', 'VOICEOVER', 'VIDEO_ASSEMBLY'].includes(
          s.executionRequirements.toolPurpose,
        ))
    )
      invalid('Invalid Step execution requirement');
    if (
      s.artifactPathScope !== undefined &&
      (s.artifactPathScope !== 'RUN_ATTEMPT' ||
        !value.validationPolicy ||
        value.definition.source !== 'BUILTIN')
    )
      invalid('artifactPathScope requires a trusted validation policy');
    if (s.type === 'DECISION' && (s.outputs.length > 0 || s.effectType !== 'NONE'))
      invalid('DECISION cannot execute or produce model artifacts');
    if (s.type === 'REVIEW' && !s.outputs.some((o) => o.kind === 'JSON' && o.required))
      invalid('REVIEW requires structured JSON output');
    if (
      new Set(s.outputs.map((o) => o.key)).size !== s.outputs.length ||
      new Set(s.inputs.map((o) => o.key)).size !== s.inputs.length
    )
      invalid('Duplicate Artifact key');
    for (const o of [
      ...s.outputs,
      ...(value.outputSchema?.outputs ?? []).filter((o) => o.fromStepId === s.id),
    ]) {
      if (
        !/^[A-Za-z0-9._-]{1,128}$/.test(o.key) ||
        !o.contractId ||
        !o.contractVersion ||
        o.maxSizeBytes < 1 ||
        o.maxSizeBytes >
          (o.validator.type === 'REGISTRY' ? W2_CONTRACT_POLICY.maxSizeBytes : 1_000_000)
      )
        invalid('Invalid Artifact specification');
      if (
        !['TEXT', 'JSON', 'FILE', 'DIRECTORY', 'EXTERNAL_REFERENCE'].includes(o.kind) ||
        typeof o.required !== 'boolean' ||
        !Number.isSafeInteger(o.maxSizeBytes)
      )
        invalid('Invalid Artifact kind or bounds');
      if (
        (o.kind === 'TEXT' && !['TEXT', 'REGISTRY'].includes(o.validator.type)) ||
        (o.kind === 'JSON' && !['JSON', 'REGISTRY'].includes(o.validator.type)) ||
        (!['TEXT', 'JSON'].includes(o.kind) && !['METADATA', 'REGISTRY'].includes(o.validator.type))
      )
        invalid('Artifact validator/kind mismatch');
      if (
        o.validator.type === 'REGISTRY' &&
        (!o.validator.contractId ||
          !o.validator.contractVersion ||
          o.validator.contractId.length > 128 ||
          o.validator.contractVersion.length > 64)
      )
        invalid('Invalid frozen Artifact Contract reference');
      if (
        o.validator.type === 'TEXT' &&
        (!Number.isSafeInteger(o.validator.minLength) ||
          o.validator.minLength < 0 ||
          o.validator.minLength > 100_000 ||
          o.validator.requiredSections.length > 20 ||
          o.validator.requiredSections.some((x) => !x || x.length > 256))
      )
        invalid('Invalid text validator');
      if (
        o.validator.type === 'JSON' &&
        (o.validator.requiredKeys.length > 64 ||
          o.validator.requiredKeys.some((x) => !x || x.length > 128))
      )
        invalid('Invalid JSON validator');
      if (
        o.validator.type === 'METADATA' &&
        (o.validator.allowedExtensions.length < 1 ||
          o.validator.allowedExtensions.length > 16 ||
          o.validator.allowedExtensions.some((x) => !/^\.[a-z0-9]{1,12}$/.test(x)))
      )
        invalid('Invalid file validator');
    }
    for (const i of s.inputs) {
      const producer = value.steps.find((p) => p.id === i.fromStepId);
      if (!producer?.outputs.some((o) => o.key === i.outputKey) || i.fromStepId === s.id)
        invalid('Input must reference a declared output');
    }
    const outgoing = value.edges.filter((e) => e.fromStepId === s.id);
    if (
      s.confirmationRequired === true &&
      (outgoing.length !== 1 ||
        outgoing[0]?.toStepId !== null ||
        outgoing[0]?.condition.type !== 'ALWAYS')
    )
      invalid('Confirmation DECISION must have one terminal ALWAYS edge');
    if (
      s.type !== 'DECISION' &&
      s.type !== 'REVIEW' &&
      outgoing.some((e) => e.condition.type !== 'ALWAYS')
    )
      invalid('TASK only supports sequential edges');
    if (
      outgoing.filter((e) => e.condition.type === 'ALWAYS').length > 1 ||
      (outgoing.some((e) => e.condition.type === 'ALWAYS') && outgoing.length > 1)
    )
      invalid('Ambiguous branch');
    if (new Set(outgoing.map((e) => e.branch)).size !== outgoing.length)
      invalid('Duplicate branch');
  }
  for (const edge of value.edges) {
    if (
      !ids.has(edge.fromStepId) ||
      (edge.toStepId !== null && !ids.has(edge.toStepId)) ||
      !edge.branch ||
      (edge.revisionCode && !edge.revision)
    )
      invalid('Invalid edge or undeclared W2 revision code');
    if (!['ALWAYS', 'REVIEW_VERDICT', 'JSON_FIELD_EQUALS'].includes(edge.condition.type))
      invalid('Unknown branch condition');
    if (
      edge.condition.type === 'REVIEW_VERDICT' &&
      (!['PASS', 'REVISE', 'FAIL'].includes(edge.condition.verdict) ||
        value.steps.find((s) => s.id === edge.fromStepId)?.type !== 'REVIEW')
    )
      invalid('Review branch requires a Review Step');
    if (
      edge.condition.type === 'JSON_FIELD_EQUALS' &&
      (!edge.condition.field ||
        edge.condition.field.length > 128 ||
        !['string', 'number', 'boolean'].includes(typeof edge.condition.equals) ||
        !value.steps
          .find((s) => s.id === edge.fromStepId)
          ?.inputs.some((i) => i.key === (edge.condition as { inputKey: string }).inputKey))
    )
      invalid('Decision condition must read a declared input field');
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const checkAcyclic = (id: string): void => {
    if (visiting.has(id)) invalid('Unmarked Workflow cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of value.edges.filter((edge) => edge.fromStepId === id && !edge.revision))
      if (edge.toStepId) checkAcyclic(edge.toStepId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) checkAcyclic(id);
  const reachable = new Set<string>();
  const walkAllEdges = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const edge of value.edges.filter((edge) => edge.fromStepId === id))
      if (edge.toStepId) walkAllEdges(edge.toStepId);
  };
  walkAllEdges(value.entryStepId);
  if (reachable.size !== ids.size) invalid('Unreachable Workflow Step');
  validateW2WorkflowVersion(value);
}
