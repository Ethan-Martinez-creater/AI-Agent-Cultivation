import { DomainError } from '@cultivation/shared';
import {
  EMPTY_WORKFLOW_INPUT_SCHEMA,
  validateWorkflowInputSchema,
} from './w1-workflow-contract.js';
import type {
  WorkflowFinalOutputSpec,
  WorkflowObjectSchema,
  WorkflowValueSchema,
} from './w1-workflow-contract.js';
import { validateWorkflowVersion, workflowOutputProjectionMatches } from './w1-workflow.js';
import type {
  WorkflowArtifactKind,
  WorkflowArtifactSpec,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowInputBinding,
  WorkflowStepDefinition,
  WorkflowStepType,
  WorkflowVersion,
} from './w1-workflow.js';
import { W2_ARTIFACT_VALIDATOR_VERSION } from './w2-workflow.js';
import type { ArtifactContract, ArtifactContractValidator } from './w2-workflow.js';
import type { CapabilityDimension } from './index.js';

/**
 * The user-owned editor surface is deliberately smaller than WorkflowVersion.
 * In particular, it has no source, validation policy, release, effect, tool,
 * generation, provider, or permission fields. Compiled Steps always declare
 * `effectType: 'NONE'`.
 */
export interface WorkflowDraftContent {
  name: string;
  description: string;
  category: string;
  inputSchema: WorkflowObjectSchema;
  finalOutputs: WorkflowDraftFinalOutput[];
  entryStepId: string;
  steps: WorkflowDraftStep[];
  edges: WorkflowDraftEdge[];
}

export interface WorkflowDraft {
  /** Persistence row identity. It is intentionally distinct from definitionId. */
  id: string;
  definitionId: string;
  baseVersion: number | null;
  revision: number;
  content: WorkflowDraftContent;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDraftFinalOutput {
  key: string;
  fromStepId: string;
  outputKey: string;
  required: boolean;
  description: string;
}

export interface WorkflowDraftRouting {
  requiredCapabilities?: CapabilityDimension[];
  executionConstraint?: 'AUTO' | 'SOLO' | 'PARTY' | 'HUMAN_BRIDGE';
}

export interface WorkflowDraftArtifactSpec extends Omit<WorkflowArtifactSpec, 'validator'> {
  /** W1 inline validators only; a USER draft cannot reference a trusted registry Contract. */
  validator:
    | { type: 'TEXT'; minLength: number; requiredSections: string[] }
    | { type: 'JSON'; requiredKeys: string[] }
    | { type: 'METADATA'; allowedExtensions: string[] };
}

export interface WorkflowDraftStep {
  id: string;
  type: WorkflowStepType;
  title: string;
  objective: string;
  routing: WorkflowDraftRouting;
  inputs: WorkflowInputBinding[];
  workflowInputKeys?: string[];
  outputs: WorkflowDraftArtifactSpec[];
  reviewOutputKey?: string;
  maxAttempts: number;
  exitCondition: 'VALID_OUTPUTS' | 'REVIEW_PASS';
}

export type WorkflowDraftEdgeCondition = WorkflowEdge['condition'];

export interface WorkflowDraftEdge {
  id: string;
  fromStepId: string;
  toStepId: string | null;
  branch: string;
  condition: WorkflowDraftEdgeCondition;
}

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

const stepTypes: readonly WorkflowStepType[] = ['TASK', 'REVIEW', 'DECISION'];
const artifactKinds: readonly WorkflowArtifactKind[] = [
  'TEXT',
  'JSON',
  'FILE',
  'DIRECTORY',
  'EXTERNAL_REFERENCE',
];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const artifactKeyPattern = /^[A-Za-z0-9._-]{1,128}$/;
const contractIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const contractVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const reviewRequiredKeys = [
  'verdict',
  'findings',
  'evidence',
  'summary',
  'reviewedArtifactIds',
] as const;
const maxEditorContentBytes = 120_000;

function invalid(message: string): never {
  throw new DomainError('INVALID_INPUT', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function safeArtifactKey(value: string): boolean {
  return (
    artifactKeyPattern.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

function stringList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => boundedString(item, maxLength))
  );
}

function jsonClone<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return invalid('Workflow content must be JSON data');
    return JSON.parse(serialized) as T;
  } catch {
    return invalid('Workflow content must be bounded JSON data');
  }
}

function parseSchema(value: unknown): WorkflowObjectSchema {
  if (!isRecord(value) || value.type !== 'object') invalid('Invalid Workflow input schema');
  try {
    validateWorkflowInputSchema(value as unknown as WorkflowObjectSchema);
  } catch {
    return invalid('Invalid Workflow input schema');
  }
  return jsonClone(value as unknown as WorkflowObjectSchema);
}

function parseValidator(value: unknown): WorkflowDraftArtifactSpec['validator'] {
  if (!isRecord(value) || typeof value.type !== 'string') invalid('Invalid Artifact validator');
  switch (value.type) {
    case 'TEXT':
      if (
        !exactKeys(value, ['type', 'minLength', 'requiredSections']) ||
        typeof value.minLength !== 'number' ||
        !stringList(value.requiredSections, 20, 256)
      )
        return invalid('Invalid TEXT Artifact validator');
      return {
        type: 'TEXT',
        minLength: value.minLength,
        requiredSections: [...value.requiredSections],
      };
    case 'JSON':
      if (!exactKeys(value, ['type', 'requiredKeys']) || !stringList(value.requiredKeys, 64, 128))
        return invalid('Invalid JSON Artifact validator');
      return { type: 'JSON', requiredKeys: [...value.requiredKeys] };
    case 'METADATA':
      if (
        !exactKeys(value, ['type', 'allowedExtensions']) ||
        !stringList(value.allowedExtensions, 16, 16)
      )
        return invalid('Invalid METADATA Artifact validator');
      return { type: 'METADATA', allowedExtensions: [...value.allowedExtensions] };
    default:
      return invalid('USER Workflows support only inline Artifact validators');
  }
}

function parseArtifact(value: unknown): WorkflowDraftArtifactSpec {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'key',
      'kind',
      'required',
      'contractId',
      'contractVersion',
      'maxSizeBytes',
      'description',
      'validator',
    ]) ||
    !boundedString(value.key, 128) ||
    !artifactKinds.includes(value.kind as WorkflowArtifactKind) ||
    typeof value.required !== 'boolean' ||
    !boundedString(value.contractId, 128) ||
    !boundedString(value.contractVersion, 64) ||
    typeof value.maxSizeBytes !== 'number' ||
    !Number.isFinite(value.maxSizeBytes) ||
    !boundedString(value.description, 2_000)
  )
    return invalid('Invalid Workflow Artifact');
  return {
    key: value.key,
    kind: value.kind as WorkflowArtifactKind,
    required: value.required,
    contractId: value.contractId,
    contractVersion: value.contractVersion,
    maxSizeBytes: value.maxSizeBytes,
    description: value.description,
    validator: parseValidator(value.validator),
  };
}

function parseInputBinding(value: unknown): WorkflowInputBinding {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['key', 'fromStepId', 'outputKey', 'required']) ||
    !boundedString(value.key, 128) ||
    !boundedString(value.fromStepId, 128) ||
    !boundedString(value.outputKey, 128) ||
    typeof value.required !== 'boolean'
  )
    return invalid('Invalid Workflow Artifact input');
  return {
    key: value.key,
    fromStepId: value.fromStepId,
    outputKey: value.outputKey,
    required: value.required,
  };
}

function parseRouting(value: unknown): WorkflowDraftRouting {
  if (!isRecord(value) || !exactKeys(value, [], ['requiredCapabilities', 'executionConstraint']))
    return invalid('Invalid Workflow routing declaration');
  const routing: WorkflowDraftRouting = {};
  if (Object.hasOwn(value, 'requiredCapabilities')) {
    if (
      !Array.isArray(value.requiredCapabilities) ||
      value.requiredCapabilities.length > capabilityDimensions.length ||
      value.requiredCapabilities.some(
        (capability) => !capabilityDimensions.includes(capability as CapabilityDimension),
      )
    )
      return invalid('Invalid required capability declaration');
    routing.requiredCapabilities = [...(value.requiredCapabilities as CapabilityDimension[])];
  }
  if (Object.hasOwn(value, 'executionConstraint')) {
    if (!['AUTO', 'SOLO', 'PARTY', 'HUMAN_BRIDGE'].includes(String(value.executionConstraint)))
      return invalid('Invalid execution constraint');
    routing.executionConstraint =
      value.executionConstraint as WorkflowDraftRouting['executionConstraint'];
  }
  return routing;
}

function parseStep(value: unknown): WorkflowDraftStep {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        'id',
        'type',
        'title',
        'objective',
        'routing',
        'inputs',
        'outputs',
        'maxAttempts',
        'exitCondition',
      ],
      ['workflowInputKeys', 'reviewOutputKey'],
    ) ||
    !boundedString(value.id, 128) ||
    !stepTypes.includes(value.type as WorkflowStepType) ||
    !boundedString(value.title, 256) ||
    !boundedString(value.objective, 6_000) ||
    !Array.isArray(value.inputs) ||
    value.inputs.length > 12 ||
    !Array.isArray(value.outputs) ||
    value.outputs.length > 12 ||
    typeof value.maxAttempts !== 'number' ||
    !Number.isFinite(value.maxAttempts) ||
    !['VALID_OUTPUTS', 'REVIEW_PASS'].includes(String(value.exitCondition)) ||
    (Object.hasOwn(value, 'workflowInputKeys') && !stringList(value.workflowInputKeys, 16, 128)) ||
    (Object.hasOwn(value, 'reviewOutputKey') && !boundedString(value.reviewOutputKey, 128))
  )
    return invalid('Invalid Workflow Step');
  return {
    id: value.id,
    type: value.type as WorkflowStepType,
    title: value.title,
    objective: value.objective,
    routing: parseRouting(value.routing),
    inputs: value.inputs.map(parseInputBinding),
    ...(Object.hasOwn(value, 'workflowInputKeys')
      ? { workflowInputKeys: [...(value.workflowInputKeys as string[])] }
      : {}),
    outputs: value.outputs.map(parseArtifact),
    ...(Object.hasOwn(value, 'reviewOutputKey')
      ? { reviewOutputKey: value.reviewOutputKey as string }
      : {}),
    maxAttempts: value.maxAttempts,
    exitCondition: value.exitCondition as WorkflowDraftStep['exitCondition'],
  };
}

function parseCondition(value: unknown): WorkflowDraftEdgeCondition {
  if (!isRecord(value) || typeof value.type !== 'string')
    invalid('Invalid Workflow branch condition');
  switch (value.type) {
    case 'ALWAYS':
      if (!exactKeys(value, ['type'])) return invalid('Invalid ALWAYS condition');
      return { type: 'ALWAYS' };
    case 'REVIEW_VERDICT':
      if (
        !exactKeys(value, ['type', 'verdict']) ||
        !['PASS', 'REVISE', 'FAIL'].includes(String(value.verdict))
      )
        return invalid('Invalid REVIEW_VERDICT condition');
      return { type: 'REVIEW_VERDICT', verdict: value.verdict as 'PASS' | 'REVISE' | 'FAIL' };
    case 'JSON_FIELD_EQUALS':
      if (
        !exactKeys(value, ['type', 'inputKey', 'field', 'equals']) ||
        !boundedString(value.inputKey, 128) ||
        !boundedString(value.field, 128) ||
        !['string', 'number', 'boolean'].includes(typeof value.equals) ||
        (typeof value.equals === 'number' && !Number.isFinite(value.equals)) ||
        (typeof value.equals === 'string' &&
          (value.equals.length > 256 || new TextEncoder().encode(value.equals).byteLength > 1_024))
      )
        return invalid('Invalid JSON_FIELD_EQUALS condition');
      const condition: WorkflowDraftEdgeCondition = {
        type: 'JSON_FIELD_EQUALS',
        inputKey: value.inputKey,
        field: value.field,
        equals: value.equals as string | number | boolean,
      };
      if (new TextEncoder().encode(JSON.stringify(condition)).byteLength > 2_048)
        return invalid('JSON_FIELD_EQUALS condition exceeds its storage limit');
      return condition;
    default:
      return invalid('Unsupported Workflow branch condition');
  }
}

function parseEdge(value: unknown): WorkflowDraftEdge {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['id', 'fromStepId', 'toStepId', 'branch', 'condition']) ||
    !boundedString(value.id, 128) ||
    !boundedString(value.fromStepId, 128) ||
    (value.toStepId !== null && !boundedString(value.toStepId, 128)) ||
    !boundedString(value.branch, 128)
  )
    return invalid('Invalid Workflow branch');
  return {
    id: value.id,
    fromStepId: value.fromStepId,
    toStepId: value.toStepId as string | null,
    branch: value.branch,
    condition: parseCondition(value.condition),
  };
}

function parseFinalOutput(value: unknown): WorkflowDraftFinalOutput {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['key', 'fromStepId', 'outputKey', 'required', 'description']) ||
    !boundedString(value.key, 128) ||
    !boundedString(value.fromStepId, 128) ||
    !boundedString(value.outputKey, 128) ||
    typeof value.required !== 'boolean' ||
    !boundedString(value.description, 2_000)
  )
    return invalid('Invalid Workflow final output');
  return {
    key: value.key,
    fromStepId: value.fromStepId,
    outputKey: value.outputKey,
    required: value.required,
    description: value.description,
  };
}

/** Strict bounded shape parser; graph/business completeness is left to publish validation. */
export function parseWorkflowDraftContent(value: unknown): WorkflowDraftContent {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'name',
      'description',
      'category',
      'inputSchema',
      'finalOutputs',
      'entryStepId',
      'steps',
      'edges',
    ]) ||
    !boundedString(value.name, 120) ||
    !boundedString(value.description, 2_000) ||
    !boundedString(value.category, 80) ||
    !boundedString(value.entryStepId, 128) ||
    !Array.isArray(value.finalOutputs) ||
    value.finalOutputs.length > 12 ||
    !Array.isArray(value.steps) ||
    value.steps.length > 32 ||
    !Array.isArray(value.edges) ||
    value.edges.length > 96
  )
    return invalid('Invalid or unbounded Workflow draft content');
  const content: WorkflowDraftContent = {
    name: value.name,
    description: value.description,
    category: value.category,
    inputSchema: parseSchema(value.inputSchema),
    finalOutputs: value.finalOutputs.map(parseFinalOutput),
    entryStepId: value.entryStepId,
    steps: value.steps.map(parseStep),
    edges: value.edges.map(parseEdge),
  };
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  } catch {
    return invalid('Workflow draft content must be JSON data');
  }
  if (bytes > maxEditorContentBytes) invalid('Workflow draft content exceeds its size limit');
  return content;
}

function copyStepForVersion(step: WorkflowDraftStep): WorkflowStepDefinition {
  return {
    id: step.id,
    type: step.type,
    title: step.title,
    objective: step.objective,
    routing: {
      ...(step.routing.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: [...step.routing.requiredCapabilities] }),
      ...(step.routing.executionConstraint === undefined
        ? {}
        : { executionConstraint: step.routing.executionConstraint }),
    },
    inputs: step.inputs.map((input) => ({ ...input })),
    ...(step.workflowInputKeys === undefined
      ? {}
      : { workflowInputKeys: [...step.workflowInputKeys] }),
    outputs: step.outputs.map((output) => jsonClone(output)),
    ...(step.reviewOutputKey === undefined ? {} : { reviewOutputKey: step.reviewOutputKey }),
    maxAttempts: step.maxAttempts,
    exitCondition: step.exitCondition,
    effectType: 'NONE',
  };
}

function buildOutputSchema(content: WorkflowDraftContent): WorkflowVersion['outputSchema'] {
  if (content.finalOutputs.length === 0) return undefined;
  const outputs: WorkflowFinalOutputSpec[] = content.finalOutputs.map((finalOutput) => {
    const producer = content.steps
      .find((step) => step.id === finalOutput.fromStepId)
      ?.outputs.find((output) => output.key === finalOutput.outputKey);
    if (!producer) return invalid('Final output must reference a declared Step output');
    return {
      ...jsonClone(producer),
      key: finalOutput.key,
      fromStepId: finalOutput.fromStepId,
      outputKey: finalOutput.outputKey,
      required: finalOutput.required,
      description: finalOutput.description,
    };
  });
  return { outputs };
}

function buildVersion(
  definitionId: string,
  content: WorkflowDraftContent,
  version: number,
  createdAt: string,
): WorkflowVersion {
  const definition: WorkflowDefinition = {
    id: definitionId,
    name: content.name,
    description: content.description,
    category: content.category,
    source: 'USER',
  };
  const workflow: WorkflowVersion = {
    definition,
    version,
    inputSchema: jsonClone(content.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA),
    ...(content.finalOutputs.length === 0 ? {} : { outputSchema: buildOutputSchema(content) }),
    entryStepId: content.entryStepId,
    steps: content.steps.map(copyStepForVersion),
    edges: content.edges.map((edge) => jsonClone(edge)),
    referenceBasis: [],
    createdAt,
  };
  return workflow;
}

function assertSafeUserRouting(step: WorkflowDraftStep): void {
  const capabilities = step.routing.requiredCapabilities ?? [];
  if (
    capabilities.length > capabilityDimensions.length ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((capability) => !capabilityDimensions.includes(capability))
  )
    invalid('Step routing may declare only unique supported capability dimensions');
  if (
    step.routing.executionConstraint !== undefined &&
    !['AUTO', 'SOLO', 'PARTY', 'HUMAN_BRIDGE'].includes(step.routing.executionConstraint)
  )
    invalid('Step routing has an unsupported execution constraint');
}

function assertReviewSemantics(step: WorkflowDraftStep): void {
  const jsonOutputs = step.outputs.filter(
    (output) => output.kind === 'JSON' && output.required && output.validator.type === 'JSON',
  );
  if (step.type !== 'REVIEW') {
    if (step.exitCondition === 'REVIEW_PASS' || step.reviewOutputKey !== undefined)
      invalid('REVIEW_PASS and reviewOutputKey are supported only by REVIEW Steps');
    return;
  }
  if (!step.inputs.some((input) => input.required))
    invalid('REVIEW must consume at least one required upstream Artifact');
  if (jsonOutputs.length !== 1) invalid('REVIEW requires one required JSON verdict output');
  const output =
    step.reviewOutputKey === undefined
      ? jsonOutputs[0]
      : jsonOutputs.find((candidate) => candidate.key === step.reviewOutputKey);
  if (!output || output.validator.type !== 'JSON')
    invalid('REVIEW output must identify its required JSON verdict Artifact');
  const required = new Set(output.validator.requiredKeys);
  if (reviewRequiredKeys.some((key) => !required.has(key)))
    invalid(
      'REVIEW JSON output must declare verdict, findings, evidence, summary, and reviewedArtifactIds',
    );
}

function checkGraphAndInputDominance(content: WorkflowDraftContent): void {
  if (
    content.steps.length < 1 ||
    content.steps.length > 32 ||
    content.edges.length > 96 ||
    content.finalOutputs.length > 12
  )
    invalid('User Workflow graph exceeds its bounded size');
  const stepIds = new Set<string>();
  for (const step of content.steps) {
    if (!idPattern.test(step.id) || stepIds.has(step.id))
      invalid('Workflow Step IDs must be unique');
    stepIds.add(step.id);
    if (!step.title.trim() || step.title.length > 256 || !step.objective.trim())
      invalid('Every published Step needs a title and objective');
    if (!stepTypes.includes(step.type)) invalid('Unsupported Workflow Step type');
    if (!Number.isSafeInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 5)
      invalid('Step retry count must be between one and five');
    if (step.outputs.length > 12 || step.inputs.length > 12)
      invalid('Step input/output count exceeds its limit');
    assertSafeUserRouting(step);
    assertReviewSemantics(step);
    if (
      step.type === 'DECISION' &&
      (step.outputs.length !== 0 || step.exitCondition !== 'VALID_OUTPUTS')
    )
      invalid('DECISION cannot produce Artifacts or use REVIEW_PASS');
    if (step.workflowInputKeys !== undefined) {
      if (
        step.workflowInputKeys.length > 16 ||
        new Set(step.workflowInputKeys).size !== step.workflowInputKeys.length ||
        step.workflowInputKeys.some((key) => !Object.hasOwn(content.inputSchema.properties, key))
      )
        invalid('Step references an undeclared Workflow input field');
    }
    for (const output of step.outputs) {
      if (
        !safeArtifactKey(output.key) ||
        !contractIdPattern.test(output.contractId) ||
        !contractVersionPattern.test(output.contractVersion) ||
        !Number.isSafeInteger(output.maxSizeBytes) ||
        output.maxSizeBytes < 1 ||
        output.maxSizeBytes > 1_000_000
      )
        invalid('Invalid bounded inline Artifact contract');
      if (
        output.validator.type === 'JSON' &&
        new Set(output.validator.requiredKeys).size !== output.validator.requiredKeys.length
      )
        invalid('JSON Artifact required keys must be unique');
      if (output.validator.type === 'TEXT' && !Number.isSafeInteger(output.validator.minLength))
        invalid('TEXT Artifact minimum length must be an integer');
      if (output.validator.type === 'METADATA') {
        if (
          output.validator.allowedExtensions.length < 1 ||
          output.validator.allowedExtensions.length > 16 ||
          new Set(output.validator.allowedExtensions).size !==
            output.validator.allowedExtensions.length ||
          output.validator.allowedExtensions.some(
            (extension) => !/^\.[a-z0-9]{1,12}$/.test(extension),
          )
        )
          invalid('METADATA Artifact extensions must be unique safe extensions');
      }
    }
  }
  if (!stepIds.has(content.entryStepId)) invalid('Workflow entry Step does not exist');

  const byId = new Map(content.steps.map((step) => [step.id, step]));
  const edgeIds = new Set<string>();
  const outgoing = new Map<string, WorkflowDraftEdge[]>();
  const adjacency = new Map<string, string[]>();
  for (const step of content.steps) {
    outgoing.set(step.id, []);
    adjacency.set(step.id, []);
  }
  for (const edge of content.edges) {
    if (
      !idPattern.test(edge.id) ||
      edgeIds.has(edge.id) ||
      !stepIds.has(edge.fromStepId) ||
      (edge.toStepId !== null && !stepIds.has(edge.toStepId)) ||
      edge.toStepId === edge.fromStepId ||
      !edge.branch.trim() ||
      edge.branch.length > 128
    )
      invalid('Workflow branch has a dangling, duplicate, or self-referential ID');
    edgeIds.add(edge.id);
    outgoing.get(edge.fromStepId)!.push(edge);
    if (edge.toStepId !== null) adjacency.get(edge.fromStepId)!.push(edge.toStepId);
    const source = byId.get(edge.fromStepId)!;
    if (edge.condition.type === 'REVIEW_VERDICT' && source.type !== 'REVIEW')
      invalid('REVIEW_VERDICT branches must originate at a REVIEW Step');
    if (edge.condition.type === 'JSON_FIELD_EQUALS' && source.type !== 'DECISION')
      invalid('JSON_FIELD_EQUALS branches must originate at a DECISION Step');
  }
  for (const step of content.steps) {
    const edges = outgoing.get(step.id)!;
    if (new Set(edges.map((edge) => edge.branch)).size !== edges.length)
      invalid('Outgoing Workflow branches must have unique names');
    if (step.type === 'TASK' && edges.some((edge) => edge.condition.type !== 'ALWAYS'))
      invalid('TASK supports only sequential ALWAYS branches');
    if (step.type === 'REVIEW') {
      const verdicts = edges
        .filter((edge) => edge.condition.type === 'REVIEW_VERDICT')
        .map((edge) => (edge.condition.type === 'REVIEW_VERDICT' ? edge.condition.verdict : ''));
      if (
        new Set(verdicts).size !== verdicts.length ||
        (edges.some((edge) => edge.condition.type === 'ALWAYS') && edges.length > 1)
      )
        invalid('REVIEW branches must be unambiguous');
      if (
        step.exitCondition === 'REVIEW_PASS' &&
        !edges.some(
          (edge) => edge.condition.type === 'REVIEW_VERDICT' && edge.condition.verdict === 'PASS',
        )
      )
        invalid('REVIEW_PASS requires a declared PASS route');
      if (
        step.exitCondition === 'REVIEW_PASS' &&
        edges.some(
          (edge) =>
            edge.condition.type === 'REVIEW_VERDICT' &&
            edge.condition.verdict !== 'PASS' &&
            edge.toStepId !== null,
        )
      )
        invalid('REVIEW_PASS may continue only on PASS; REVISE and FAIL must be terminal');
      if (edges.some((edge) => edge.condition.type === 'JSON_FIELD_EQUALS'))
        invalid('REVIEW branch decisions must use structured verdicts');
    }
    if (step.type === 'DECISION') {
      const signatures = new Set<string>();
      for (const edge of edges) {
        if (edge.condition.type === 'REVIEW_VERDICT')
          invalid('DECISION cannot use REVIEW_VERDICT branches');
        if (edge.condition.type === 'JSON_FIELD_EQUALS') {
          const signature = JSON.stringify([
            edge.condition.inputKey,
            edge.condition.field,
            typeof edge.condition.equals,
            edge.condition.equals,
          ]);
          if (signatures.has(signature))
            invalid('DECISION contains ambiguous equal-value branches');
          signatures.add(signature);
        }
        if (edge.condition.type === 'ALWAYS' && edges.length > 1)
          invalid('DECISION cannot combine an unconditional route with conditions');
      }
    }
  }

  for (const step of content.steps) {
    const inputKeys = new Set<string>();
    for (const input of step.inputs) {
      if (
        !safeArtifactKey(input.key) ||
        !safeArtifactKey(input.outputKey) ||
        inputKeys.has(input.key) ||
        input.fromStepId === step.id
      )
        invalid('Step Artifact inputs must use unique keys and cannot self-reference');
      inputKeys.add(input.key);
      const producer = byId.get(input.fromStepId);
      const output = producer?.outputs.find((candidate) => candidate.key === input.outputKey);
      if (!producer || !output) invalid('Step input must reference a declared upstream Artifact');
      if (input.required && !output.required)
        invalid('A required Step input must reference a required producer Artifact');
      if (
        step.type === 'REVIEW' &&
        !producer.outputs.some((candidate) => candidate.key === input.outputKey)
      )
        invalid('REVIEW must consume a real declared upstream Artifact');
    }
  }

  // Check that each producer lies on every entry-to-consumer path. Merely
  // finding one path from producer to consumer would allow branch bypasses.
  const reachableWithout = (targetId: string, omittedId: string): boolean => {
    if (content.entryStepId === omittedId) return false;
    const seen = new Set<string>();
    const pending = [content.entryStepId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === omittedId || seen.has(current)) continue;
      if (current === targetId) return true;
      seen.add(current);
      pending.push(...adjacency.get(current)!);
    }
    return false;
  };
  for (const step of content.steps) {
    for (const input of step.inputs) {
      const reachesConsumer = adjacency.get(input.fromStepId)!.some((next) => {
        const seen = new Set<string>();
        const pending = [next];
        while (pending.length > 0) {
          const current = pending.pop()!;
          if (current === step.id) return true;
          if (seen.has(current)) continue;
          seen.add(current);
          pending.push(...adjacency.get(current)!);
        }
        return false;
      });
      if (!reachesConsumer || reachableWithout(step.id, input.fromStepId))
        invalid('Every Step input producer must dominate its consumer on every route');
    }
  }

  for (const step of content.steps) {
    for (const edge of outgoing.get(step.id)!) {
      const condition = edge.condition;
      if (condition.type !== 'JSON_FIELD_EQUALS') continue;
      const input = step.inputs.find((candidate) => candidate.key === condition.inputKey);
      const producer = input && byId.get(input.fromStepId);
      const output = producer?.outputs.find((candidate) => candidate.key === input?.outputKey);
      if (
        !safeArtifactKey(condition.field) ||
        !input ||
        !input.required ||
        !producer ||
        !output ||
        output.kind !== 'JSON' ||
        output.validator.type !== 'JSON' ||
        !output.validator.requiredKeys.includes(condition.field)
      )
        invalid('DECISION conditions must read a required field of a declared JSON input');
    }
  }

  // The existing W1 validator remains the authority for the frozen-version
  // shape, acyclicity, reachability, contract bounds, and final projection.
  const version = buildVersion('user-draft-validation', content, 1, '2026-01-01T00:00:00.000Z');
  validateWorkflowVersion(version);
  for (const finalOutput of content.finalOutputs) {
    if (
      !safeArtifactKey(finalOutput.key) ||
      !safeArtifactKey(finalOutput.outputKey) ||
      !stepIds.has(finalOutput.fromStepId)
    )
      invalid('Final output must reference a valid Step and Artifact key');
  }
  if (
    content.finalOutputs.length > 12 ||
    new Set(content.finalOutputs.map((item) => item.key)).size !== content.finalOutputs.length
  )
    invalid('Final output keys must be unique and bounded');
  for (const finalOutput of content.finalOutputs) {
    const producer = byId
      .get(finalOutput.fromStepId)
      ?.outputs.find((item) => item.key === finalOutput.outputKey);
    const projection: WorkflowFinalOutputSpec | undefined = producer
      ? {
          ...producer,
          key: finalOutput.key,
          required: finalOutput.required,
          description: finalOutput.description,
          fromStepId: finalOutput.fromStepId,
          outputKey: finalOutput.outputKey,
        }
      : undefined;
    if (!producer || !projection || !workflowOutputProjectionMatches(projection, producer))
      invalid('Final output must project the exact producer contract');
    if (finalOutput.required) {
      const normalTerminalSources = new Set<string>();
      for (const step of content.steps) {
        const edges = outgoing.get(step.id)!;
        if (edges.length === 0) normalTerminalSources.add(step.id);
        for (const edge of edges) {
          if (edge.toStepId !== null) continue;
          const reviewWait =
            step.type === 'REVIEW' &&
            step.exitCondition === 'REVIEW_PASS' &&
            edge.condition.type === 'REVIEW_VERDICT' &&
            edge.condition.verdict !== 'PASS';
          if (!reviewWait) normalTerminalSources.add(step.id);
        }
      }
      if (
        [...normalTerminalSources].some((terminal) =>
          reachableWithout(terminal, finalOutput.fromStepId),
        )
      )
        invalid('Required final output producer must dominate every normal completion route');
    }
  }
}

/** Full deterministic publication validator. Draft saves may still be graph-incomplete. */
export function validateUserWorkflowDraft(content: WorkflowDraftContent): void {
  const parsed = parseWorkflowDraftContent(content);
  if (!parsed.name.trim() || !parsed.category.trim())
    invalid('Published Workflow requires a name and category');
  validateWorkflowInputSchema(parsed.inputSchema);
  checkGraphAndInputDominance(parsed);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** Compiles a validated USER draft into the existing immutable W1/W2 version contract. */
export function compileUserWorkflowVersion(
  draft: WorkflowDraft,
  version: number,
  createdAt: string,
): WorkflowVersion {
  if (
    !isRecord(draft) ||
    !boundedString(draft.id, 128) ||
    !idPattern.test(draft.id) ||
    !boundedString(draft.definitionId, 128) ||
    !idPattern.test(draft.definitionId) ||
    (draft.baseVersion !== null &&
      (!Number.isSafeInteger(draft.baseVersion) || (draft.baseVersion as number) < 1)) ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 1 ||
    !validTimestamp(draft.createdAt) ||
    !validTimestamp(draft.updatedAt) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !validTimestamp(createdAt)
  )
    invalid('Invalid Workflow Draft or version identity');
  const content = parseWorkflowDraftContent(draft.content);
  validateUserWorkflowDraft(content);
  const compiled = buildVersion(draft.definitionId, content, version, createdAt);
  validateWorkflowVersion(compiled);
  return compiled;
}

function isSequentialAlwaysGraph(content: WorkflowDraftContent): boolean {
  if (content.steps.some((step) => step.exitCondition === 'REVIEW_PASS')) return false;
  if (content.edges.some((edge) => edge.condition.type !== 'ALWAYS')) return false;
  if (content.steps.length === 0) return content.edges.length === 0;
  const expected = content.steps.map((step, index) => ({
    fromStepId: step.id,
    toStepId: content.steps[index + 1]?.id ?? null,
  }));
  const actual = content.edges.map((edge) => ({
    fromStepId: edge.fromStepId,
    toStepId: edge.toStepId,
  }));
  return (
    actual.length === expected.length &&
    expected.every((edge) =>
      actual.some(
        (candidate) =>
          candidate.fromStepId === edge.fromStepId && candidate.toStepId === edge.toStepId,
      ),
    )
  );
}

/**
 * Reorders only a plain sequential editor list. Conditional graphs are refused
 * so drag sorting cannot silently retarget or erase declared branch meaning.
 */
export function reorderWorkflowDraft(
  value: WorkflowDraftContent,
  stepIds: readonly string[],
): WorkflowDraftContent {
  const content = parseWorkflowDraftContent(value);
  if (!isSequentialAlwaysGraph(content))
    invalid('Reorder is available only for a sequential graph without conditional branches');
  if (
    !Array.isArray(stepIds) ||
    stepIds.length !== content.steps.length ||
    new Set(stepIds).size !== stepIds.length ||
    stepIds.some((id) => !content.steps.some((step) => step.id === id))
  )
    invalid('Reorder must contain every Step ID exactly once');
  const byId = new Map(content.steps.map((step) => [step.id, step]));
  const steps = stepIds.map((id) => jsonClone(byId.get(id)!));
  const order = new Map(steps.map((step, index) => [step.id, index]));
  const outputs = new Map(
    steps.map((step) => [step.id, new Map(step.outputs.map((output) => [output.key, output]))]),
  );
  for (const [consumerIndex, step] of steps.entries()) {
    for (const input of step.inputs) {
      const producerIndex = order.get(input.fromStepId);
      const producerOutput = outputs.get(input.fromStepId)?.get(input.outputKey);
      if (
        producerIndex === undefined ||
        producerIndex >= consumerIndex ||
        !producerOutput ||
        (input.required && !producerOutput.required)
      )
        invalid('Reorder must keep every Artifact producer before its consumer');
    }
  }
  const edges: WorkflowDraftEdge[] = steps.map((step, index) => ({
    id: `seq-${index + 1}`,
    fromStepId: step.id,
    toStepId: steps[index + 1]?.id ?? null,
    branch: 'continue',
    condition: { type: 'ALWAYS' },
  }));
  return { ...content, entryStepId: steps[0]?.id ?? '', steps, edges };
}

function contractIdentity(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

function inlineValidatorForContract(
  contract: ArtifactContract,
): WorkflowDraftArtifactSpec['validator'] {
  const validator: ArtifactContractValidator = contract.validator;
  switch (validator.type) {
    case 'TEXT_RULES':
      return {
        type: 'TEXT',
        minLength: validator.minLength,
        requiredSections: validator.requiredSections.slice(0, 20),
      };
    case 'JSON_SCHEMA':
      // W1 inline JSON contracts can freeze required keys, not the full JSON Schema.
      return { type: 'JSON', requiredKeys: [...validator.schema.required] };
    case 'FILE_METADATA':
      return {
        type: 'METADATA',
        allowedExtensions: validator.allowedExtensions
          .slice(0, 16)
          .map((extension) => extension.toLowerCase()),
      };
    case 'DIRECTORY_MANIFEST':
    case 'WORKSPACE_MANIFEST':
      // The W1 user surface cannot express per-entry path/hash checks. Keep the
      // manifest as a JSON Artifact and make this reduced validation explicit.
      return { type: 'METADATA', allowedExtensions: ['.json'] };
  }
}

function copiedArtifact(
  spec: WorkflowArtifactSpec,
  contracts: readonly ArtifactContract[],
  namespace: (id: string, version: string) => { id: string; version: string },
): WorkflowDraftArtifactSpec {
  let validator: WorkflowDraftArtifactSpec['validator'];
  const sourceValidator = spec.validator;
  if (sourceValidator.type === 'REGISTRY') {
    const contract = contracts.find(
      (candidate) =>
        candidate.contractId === sourceValidator.contractId &&
        candidate.contractVersion === sourceValidator.contractVersion,
    );
    if (!contract) invalid('Cannot copy an Artifact whose frozen Contract is missing');
    validator = inlineValidatorForContract(contract);
  } else {
    validator = jsonClone(sourceValidator);
  }
  const renamed = namespace(spec.contractId, spec.contractVersion);
  return {
    ...jsonClone(spec),
    contractId: renamed.id,
    contractVersion: renamed.version,
    maxSizeBytes: Math.min(spec.maxSizeBytes, 1_000_000),
    validator,
  };
}

function genericReviewOutputKey(
  step: WorkflowStepDefinition,
  contracts: readonly ArtifactContract[],
  steps: readonly WorkflowStepDefinition[],
): string | null {
  const requiredJsonOutputs = step.outputs.filter(
    (output) => output.kind === 'JSON' && output.required,
  );
  if (requiredJsonOutputs.length !== 1) return null;
  const output = requiredJsonOutputs[0]!;
  const validator = output.validator;
  let requiredKeys: readonly string[] = [];
  if (validator.type === 'JSON') {
    requiredKeys = validator.requiredKeys;
  } else if (validator.type === 'REGISTRY') {
    const contract = contracts.find(
      (candidate) =>
        candidate.contractId === validator.contractId &&
        candidate.contractVersion === validator.contractVersion,
    );
    if (contract?.validator.type === 'JSON_SCHEMA')
      requiredKeys = contract.validator.schema.required;
  }
  const hasRequiredInput = step.inputs.some((input) => {
    if (!input.required) return false;
    const producer = steps.find((candidate) => candidate.id === input.fromStepId);
    return producer?.outputs.some(
      (candidate) => candidate.key === input.outputKey && candidate.required,
    );
  });
  return hasRequiredInput && reviewRequiredKeys.every((key) => requiredKeys.includes(key))
    ? output.key
    : null;
}

function topologicalCopyOrder(version: WorkflowVersion): WorkflowStepDefinition[] {
  const remaining = [...version.steps];
  const ordered: WorkflowStepDefinition[] = [];
  const emitted = new Set<string>();
  while (remaining.length > 0) {
    const ready = (step: WorkflowStepDefinition): boolean =>
      step.inputs.every((input) => emitted.has(input.fromStepId));
    const entryIndex = remaining.findIndex(
      (step) => step.id === version.entryStepId && ready(step),
    );
    const index = entryIndex >= 0 ? entryIndex : remaining.findIndex(ready);
    if (index < 0) invalid('Cannot normalize a Workflow with cyclic Artifact input dependencies');
    const [step] = remaining.splice(index, 1);
    ordered.push(step!);
    emitted.add(step!.id);
  }
  return ordered;
}

/**
 * Copies a frozen BUILTIN or USER version into editable user content.
 * Normalization is explicit: official branch targets and all bounded revision
 * edges are replaced by a dependency-safe step-order sequence; a generic
 * REVIEW becomes REVIEW_PASS with only PASS-to-next (REVISE/FAIL wait for user
 * action), while a non-generic official REVIEW becomes a TASK. DECISION
 * branches become an unconditional sequential continuation. Trusted execution/effect/release/validation fields
 * are dropped, and registry contracts become W1 inline checks. W2 JSON Schema
 * types and directory/workspace manifest path/hash rules cannot be represented
 * in the W1 user editor; only required JSON keys or a JSON metadata extension
 * survives. The copied draft is a safe starting point, not a semantic clone.
 */
export function copyWorkflowVersionToDraftContent(version: WorkflowVersion): WorkflowDraftContent {
  validateWorkflowVersion(version);
  if (version.definition.source === 'IMPORTED')
    invalid('IMPORTED Workflow versions are reserved for W3.2');
  if (version.steps.length === 0) invalid('Cannot copy an empty Workflow');

  if (version.definition.source === 'USER') {
    if (
      version.validationPolicy !== undefined ||
      version.releaseMetadata !== undefined ||
      version.contractManifest !== undefined ||
      version.revisionGroups !== undefined ||
      version.edges.some(
        (edge) => edge.revision !== undefined || edge.revisionCode !== undefined,
      ) ||
      version.steps.some(
        (step) =>
          step.effectType !== 'NONE' ||
          step.effectPaths !== undefined ||
          step.effectPathMode !== undefined ||
          step.artifactPathScope !== undefined ||
          step.confirmationRequired !== undefined ||
          step.phase !== undefined ||
          step.executionRequirements !== undefined ||
          step.routing.requiredExecutionProtocol !== undefined,
      )
    )
      invalid('This USER version uses fields outside the W3.1 editor contract');
    const content: WorkflowDraftContent = {
      name: version.definition.name,
      description: version.definition.description,
      category: version.definition.category,
      inputSchema: jsonClone(version.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA),
      finalOutputs: (version.outputSchema?.outputs ?? []).map((output) => ({
        key: output.key,
        fromStepId: output.fromStepId,
        outputKey: output.outputKey,
        required: output.required,
        description: output.description,
      })),
      entryStepId: version.entryStepId,
      steps: version.steps.map((step) => ({
        id: step.id,
        type: step.type,
        title: step.title,
        objective: step.objective,
        routing: {
          ...(step.routing.requiredCapabilities === undefined
            ? {}
            : { requiredCapabilities: [...step.routing.requiredCapabilities] }),
          ...(step.routing.executionConstraint === undefined
            ? {}
            : { executionConstraint: step.routing.executionConstraint }),
        },
        inputs: step.inputs.map((input) => ({ ...input })),
        ...(step.workflowInputKeys === undefined
          ? {}
          : { workflowInputKeys: [...step.workflowInputKeys] }),
        outputs: step.outputs.map((output) => {
          if (output.validator.type === 'REGISTRY')
            return invalid('W3.1 USER versions cannot use registry Artifacts');
          return jsonClone(output) as WorkflowDraftArtifactSpec;
        }),
        ...(step.reviewOutputKey === undefined ? {} : { reviewOutputKey: step.reviewOutputKey }),
        maxAttempts: step.maxAttempts,
        exitCondition: step.exitCondition,
      })),
      edges: version.edges.map((edge) => {
        const { revision: _revision, revisionCode: _revisionCode, ...editable } = edge;
        if (_revision !== undefined || _revisionCode !== undefined)
          return invalid('W3.1 USER versions cannot use bounded revision edges');
        return jsonClone(editable);
      }),
    };
    const parsed = parseWorkflowDraftContent(content);
    validateUserWorkflowDraft(parsed);
    return parsed;
  }

  const contracts = version.contractManifest ?? [];
  const names = new Map<string, { id: string; version: string }>();
  let contractIndex = 0;
  const namespace = (id: string, contractVersion: string): { id: string; version: string } => {
    const identity = contractIdentity(id, contractVersion);
    let renamed = names.get(identity);
    if (!renamed) {
      contractIndex += 1;
      renamed = { id: `user-copy.${contractIndex}`, version: '1' };
      names.set(identity, renamed);
    }
    return renamed;
  };

  const orderedSteps = topologicalCopyOrder(version);
  const steps: WorkflowDraftStep[] = orderedSteps.map((step) => {
    const genericReviewKey =
      step.type === 'REVIEW' ? genericReviewOutputKey(step, contracts, version.steps) : null;
    const clonedType: WorkflowStepType =
      step.type === 'REVIEW' && genericReviewKey === null ? 'TASK' : step.type;
    const outputs = step.outputs.map((output) => copiedArtifact(output, contracts, namespace));
    const safe: WorkflowDraftStep = {
      id: step.id,
      type: clonedType,
      title: step.title,
      objective: step.objective,
      routing: {
        ...(step.routing.requiredCapabilities === undefined
          ? {}
          : { requiredCapabilities: [...step.routing.requiredCapabilities] }),
        ...(step.routing.executionConstraint === undefined
          ? {}
          : { executionConstraint: step.routing.executionConstraint }),
      },
      inputs: step.inputs.map((input) => {
        const producer = version.steps.find((candidate) => candidate.id === input.fromStepId);
        const producerOutput = producer?.outputs.find(
          (candidate) => candidate.key === input.outputKey,
        );
        return { ...input, required: input.required && producerOutput?.required === true };
      }),
      ...(step.workflowInputKeys === undefined
        ? {}
        : { workflowInputKeys: [...step.workflowInputKeys] }),
      outputs,
      ...(clonedType !== 'REVIEW'
        ? {}
        : { reviewOutputKey: genericReviewKey ?? step.reviewOutputKey ?? '' }),
      maxAttempts: step.maxAttempts,
      exitCondition: clonedType === 'REVIEW' ? 'REVIEW_PASS' : 'VALID_OUTPUTS',
    };
    return safe;
  });

  const edges: WorkflowDraftEdge[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const next = steps[index + 1]?.id ?? null;
    if (step.type === 'REVIEW') {
      edges.push({
        id: `copy-${index + 1}-pass`,
        fromStepId: step.id,
        toStepId: next,
        branch: 'PASS',
        condition: { type: 'REVIEW_VERDICT', verdict: 'PASS' },
      });
    } else {
      edges.push({
        id: `copy-${index + 1}-continue`,
        fromStepId: step.id,
        toStepId: next,
        branch: 'continue',
        condition: { type: 'ALWAYS' },
      });
    }
  }

  const finalOutputs: WorkflowDraftFinalOutput[] = (version.outputSchema?.outputs ?? []).map(
    (output) => ({
      key: output.key,
      fromStepId: output.fromStepId,
      outputKey: output.outputKey,
      required: output.required,
      description: output.description,
    }),
  );
  const content: WorkflowDraftContent = {
    name: `${version.definition.name} (copy)`.slice(0, 120),
    description: version.definition.description.slice(0, 2_000),
    category: version.definition.category.slice(0, 80),
    inputSchema: jsonClone(version.inputSchema ?? EMPTY_WORKFLOW_INPUT_SCHEMA),
    finalOutputs,
    entryStepId: steps[0]!.id,
    steps,
    edges,
  };
  const parsed = parseWorkflowDraftContent(content);
  validateUserWorkflowDraft(parsed);
  return parsed;
}
