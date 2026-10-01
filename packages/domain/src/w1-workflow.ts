import { DomainError } from '@cultivation/shared';
import type { RoutingTaskContext } from './r4-routing.js';

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
    | { type: 'METADATA'; allowedExtensions: string[] };
}
export interface WorkflowInputBinding {
  key: string;
  fromStepId: string;
  outputKey: string;
  required: boolean;
}
export interface WorkflowStepDefinition {
  id: string;
  type: WorkflowStepType;
  title: string;
  objective: string;
  routing: Omit<RoutingTaskContext, 'objective' | 'inputArtifactMetadata' | 'executionContext'>;
  inputs: WorkflowInputBinding[];
  outputs: WorkflowArtifactSpec[];
  maxAttempts: number;
  exitCondition: 'VALID_OUTPUTS' | 'REVIEW_PASS';
  /** Declaration only: uncertain interrupted execution always needs explicit user action. */
  effectType: 'NONE' | 'FILE_OUTPUT' | 'WORKSPACE_MUTATION' | 'EXTERNAL_ACTION';
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
  /** Reserved contract metadata; W1 rejects any actual revision traversal. */
  revisionCode?: string;
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
export function validateWorkflowVersion(value: WorkflowVersion): void {
  const invalid = (message: string): never => {
    throw new DomainError('INVALID_INPUT', message);
  };
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
  if (
    ids.size !== value.steps.length ||
    !ids.has(value.entryStepId) ||
    new Set(value.edges.map((e) => e.id)).size !== value.edges.length
  )
    invalid('Duplicate or missing Workflow identity');
  for (const s of value.steps) {
    if (
      !s.id ||
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
    if (s.type === 'DECISION' && (s.outputs.length > 0 || s.effectType !== 'NONE'))
      invalid('DECISION cannot execute or produce model artifacts');
    if (s.type === 'REVIEW' && !s.outputs.some((o) => o.kind === 'JSON' && o.required))
      invalid('REVIEW requires structured JSON output');
    if (
      new Set(s.outputs.map((o) => o.key)).size !== s.outputs.length ||
      new Set(s.inputs.map((o) => o.key)).size !== s.inputs.length
    )
      invalid('Duplicate Artifact key');
    for (const o of s.outputs) {
      if (
        !/^[A-Za-z0-9._-]{1,128}$/.test(o.key) ||
        !o.contractId ||
        !o.contractVersion ||
        o.maxSizeBytes < 1 ||
        o.maxSizeBytes > 1_000_000
      )
        invalid('Invalid Artifact specification');
      if (
        !['TEXT', 'JSON', 'FILE', 'DIRECTORY', 'EXTERNAL_REFERENCE'].includes(o.kind) ||
        typeof o.required !== 'boolean' ||
        !Number.isSafeInteger(o.maxSizeBytes)
      )
        invalid('Invalid Artifact kind or bounds');
      if (
        (o.kind === 'TEXT' && o.validator.type !== 'TEXT') ||
        (o.kind === 'JSON' && o.validator.type !== 'JSON') ||
        (!['TEXT', 'JSON'].includes(o.kind) && o.validator.type !== 'METADATA')
      )
        invalid('Artifact validator/kind mismatch');
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
      edge.revisionCode
    )
      invalid('Invalid edge or W2 revision code');
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
  const walk = (id: string): void => {
    if (visiting.has(id)) invalid('W1 does not allow loops');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const e of value.edges.filter((e) => e.fromStepId === id))
      if (e.toStepId) walk(e.toStepId);
    visiting.delete(id);
    visited.add(id);
  };
  walk(value.entryStepId);
  if (visited.size !== ids.size) invalid('Unreachable Workflow Step');
}
