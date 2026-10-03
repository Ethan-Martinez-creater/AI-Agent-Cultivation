import { DomainError } from '@cultivation/shared';
import type {
  WorkflowArtifactKind,
  WorkflowArtifactSpec,
  WorkflowStepDefinition,
  WorkflowVersion,
} from './w1-workflow.js';
import { validateWorkflowInputSchema, validateWorkflowInputs } from './w1-workflow-contract.js';
import type { WorkflowObjectSchema } from './w1-workflow-contract.js';

export type ArtifactContractKind = 'TEXT' | 'JSON' | 'FILE' | 'DIRECTORY' | 'WORKSPACE';

export type ArtifactContractValidator =
  | { readonly type: 'JSON_SCHEMA'; readonly schema: WorkflowObjectSchema }
  | {
      readonly type: 'TEXT_RULES';
      readonly minLength: number;
      readonly requiredSections: readonly string[];
    }
  | {
      readonly type: 'FILE_METADATA';
      readonly allowedExtensions: readonly string[];
      readonly allowedMediaTypes: readonly string[];
      readonly requireContentHash: boolean;
    }
  | {
      readonly type: 'DIRECTORY_MANIFEST';
      readonly maxEntries: number;
      readonly allowedPaths?: readonly string[];
      readonly requireHashes: boolean;
    }
  | {
      readonly type: 'WORKSPACE_MANIFEST';
      readonly maxEntries: number;
      readonly allowedPaths: readonly string[];
      readonly dynamicPaths?: boolean;
      readonly requireBeforeHash: boolean;
    };

/** Immutable, closed, deterministic Artifact contract stored with a Workflow version. */
export interface ArtifactContract {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly kind: ArtifactContractKind;
  readonly validatorVersion: string;
  readonly maxSizeBytes: number;
  readonly validator: ArtifactContractValidator;
}

export interface BoundedRevisionGroup {
  id: string;
  maxTotalTraversals: number;
  onExhausted: 'WAITING_USER' | 'FAILED';
}

export interface StepOperationManifestEntry {
  relativePath: string;
  beforeHash?: string;
  afterHash?: string;
}

export interface StepOperationReceipt {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  attempt: number;
  operationKey: string;
  effectType: 'NONE' | 'FILE_OUTPUT' | 'WORKSPACE_MUTATION' | 'EXTERNAL_ACTION';
  state: 'PREPARED' | 'APPLIED' | 'VERIFIED' | 'UNKNOWN';
  inputHash: string;
  manifest?: StepOperationManifestEntry[];
  outputArtifactIds?: string[];
  externalReference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionTraversal {
  id: string;
  workflowRunId: string;
  stepRunId: string;
  edgeId: string;
  groupId: string;
  traversalIndex: number;
  reason: string;
  createdAt: string;
}

export interface WorkflowReferenceBasisEntry {
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
  intentionallyExcludedMechanisms: string[];
  rationale: string;
  notes?: string;
}

export interface WorkflowContractManifestEntry {
  contractId: string;
  contractVersion: string;
}

export interface WorkflowRevisionManifest {
  groups: BoundedRevisionGroup[];
  edges: Array<{
    edgeId: string;
    groupId: string;
    maxTraversals: number;
    revisionCode?: string;
  }>;
}

export interface WorkflowEffectManifestEntry {
  stepId: string;
  effectType: WorkflowStepDefinition['effectType'];
  paths: string[];
  pathMode?: 'DYNAMIC';
}

export interface WorkflowReleaseMetadata {
  referenceBasis: WorkflowReferenceBasisEntry[];
  contractManifest: WorkflowContractManifestEntry[];
  revisionManifest: WorkflowRevisionManifest;
  effectManifest: WorkflowEffectManifestEntry[];
  designRationale: string;
  /** SHA-256 of the canonical version with this field omitted; set by release registry. */
  manifestHash?: string;
}

export const W2_CONTRACT_POLICY = {
  maxContractCount: 128,
  maxSizeBytes: 10_000_000,
  maxValidatorVersionLength: 64,
  maxEntries: 256,
  maxRuleList: 32,
  maxPathLength: 512,
  maxEffectPaths: 32,
  maxRevisionTraversals: 20,
  maxValidationErrors: 20,
} as const;
export const W2_ARTIFACT_VALIDATOR_VERSION = 'w2-deterministic-v1';

const contractIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const contractVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const revisionCodePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): never {
  throw new DomainError('INVALID_INPUT', message);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Cross-platform relative path rule shared by effect declarations and manifests. */
export function isSafeWorkflowRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > W2_CONTRACT_POLICY.maxPathLength ||
    value.trim() !== value ||
    value.includes('\0')
  )
    return false;
  const path = normalizedPath(value);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('://')) return false;
  const segments = path.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[<>:"|?*]/.test(segment) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment),
    )
  )
    return false;
  return true;
}

function validatePaths(paths: unknown, max = W2_CONTRACT_POLICY.maxRuleList): paths is string[] {
  return (
    Array.isArray(paths) &&
    paths.length <= max &&
    paths.every(isSafeWorkflowRelativePath) &&
    new Set(paths.map((path) => normalizedPath(path).toLocaleLowerCase('en-US'))).size ===
      paths.length
  );
}

function stringList(value: unknown, max: number, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= maxLength,
    ) &&
    new Set(value).size === value.length
  );
}

function validMimeType(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value);
}

function validateArtifactContractValidator(
  kind: ArtifactContractKind,
  validator: unknown,
): asserts validator is ArtifactContractValidator {
  if (!plain(validator) || typeof validator.type !== 'string')
    invalid('Invalid Artifact Contract validator');
  switch (validator.type) {
    case 'JSON_SCHEMA':
      if (kind !== 'JSON' || !exactKeys(validator, ['type', 'schema']) || !plain(validator.schema))
        invalid('JSON contract requires a closed JSON schema');
      try {
        validateWorkflowInputSchema(validator.schema as unknown as WorkflowObjectSchema);
      } catch {
        invalid('Invalid bounded JSON contract schema');
      }
      return;
    case 'TEXT_RULES':
      if (
        kind !== 'TEXT' ||
        !exactKeys(validator, ['type', 'minLength', 'requiredSections']) ||
        !Number.isSafeInteger(validator.minLength) ||
        (validator.minLength as number) < 0 ||
        (validator.minLength as number) > 100_000 ||
        !stringList(validator.requiredSections, W2_CONTRACT_POLICY.maxRuleList, 256)
      )
        invalid('Invalid bounded text contract rules');
      return;
    case 'FILE_METADATA':
      if (
        kind !== 'FILE' ||
        !exactKeys(validator, [
          'type',
          'allowedExtensions',
          'allowedMediaTypes',
          'requireContentHash',
        ]) ||
        !Array.isArray(validator.allowedExtensions) ||
        validator.allowedExtensions.length < 1 ||
        validator.allowedExtensions.length > W2_CONTRACT_POLICY.maxRuleList ||
        validator.allowedExtensions.some(
          (extension) => typeof extension !== 'string' || !/^\.[a-z0-9]{1,12}$/.test(extension),
        ) ||
        new Set(validator.allowedExtensions).size !== validator.allowedExtensions.length ||
        !Array.isArray(validator.allowedMediaTypes) ||
        validator.allowedMediaTypes.length > W2_CONTRACT_POLICY.maxRuleList ||
        validator.allowedMediaTypes.some(
          (mediaType) => !validMimeType(mediaType) || mediaType !== mediaType.toLowerCase(),
        ) ||
        new Set(validator.allowedMediaTypes).size !== validator.allowedMediaTypes.length ||
        typeof validator.requireContentHash !== 'boolean'
      )
        invalid('Invalid bounded file contract rules');
      return;
    case 'DIRECTORY_MANIFEST':
      if (
        kind !== 'DIRECTORY' ||
        !exactKeys(validator, ['type', 'maxEntries', 'allowedPaths', 'requireHashes']) ||
        !Number.isSafeInteger(validator.maxEntries) ||
        (validator.maxEntries as number) < 1 ||
        (validator.maxEntries as number) > W2_CONTRACT_POLICY.maxEntries ||
        (validator.allowedPaths !== undefined && !validatePaths(validator.allowedPaths)) ||
        typeof validator.requireHashes !== 'boolean'
      )
        invalid('Invalid bounded directory manifest rules');
      return;
    case 'WORKSPACE_MANIFEST':
      if (
        kind !== 'WORKSPACE' ||
        !exactKeys(validator, [
          'type',
          'maxEntries',
          'allowedPaths',
          'requireBeforeHash',
          'dynamicPaths',
        ]) ||
        !Number.isSafeInteger(validator.maxEntries) ||
        (validator.maxEntries as number) < 1 ||
        (validator.maxEntries as number) > W2_CONTRACT_POLICY.maxEntries ||
        !validatePaths(validator.allowedPaths) ||
        (validator.allowedPaths.length < 1 && validator.dynamicPaths !== true) ||
        (validator.dynamicPaths !== undefined && validator.dynamicPaths !== true) ||
        typeof validator.requireBeforeHash !== 'boolean'
      )
        invalid('Invalid bounded workspace manifest rules');
      return;
    default:
      invalid('Unknown Artifact Contract validator');
  }
}

export function validateArtifactContractDefinition(value: ArtifactContract): void {
  if (
    !plain(value) ||
    !exactKeys(value, [
      'contractId',
      'contractVersion',
      'kind',
      'validatorVersion',
      'maxSizeBytes',
      'validator',
    ]) ||
    typeof value.contractId !== 'string' ||
    !contractIdPattern.test(value.contractId) ||
    typeof value.contractVersion !== 'string' ||
    !contractVersionPattern.test(value.contractVersion) ||
    !['TEXT', 'JSON', 'FILE', 'DIRECTORY', 'WORKSPACE'].includes(value.kind) ||
    typeof value.validatorVersion !== 'string' ||
    value.validatorVersion !== W2_ARTIFACT_VALIDATOR_VERSION ||
    !Number.isSafeInteger(value.maxSizeBytes) ||
    value.maxSizeBytes < 1 ||
    value.maxSizeBytes >
      (value.kind === 'FILE' || value.kind === 'DIRECTORY'
        ? W2_CONTRACT_POLICY.maxSizeBytes
        : 1_000_000)
  )
    invalid('Invalid bounded Artifact Contract');
  validateArtifactContractValidator(value.kind, value.validator);
}

export function freezeArtifactContract(value: ArtifactContract): ArtifactContract {
  validateArtifactContractDefinition(value);
  const copy = JSON.parse(JSON.stringify(value)) as ArtifactContract;
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(copy);
  return copy;
}

function contractArtifactKindMatches(
  contractKind: ArtifactContractKind,
  artifactKind: WorkflowArtifactKind,
): boolean {
  return (
    contractKind === artifactKind || (contractKind === 'WORKSPACE' && artifactKind === 'DIRECTORY')
  );
}

function validateRegistryArtifactSpec(
  spec: WorkflowArtifactSpec,
  manifest: readonly ArtifactContract[],
): void {
  const reference = spec.validator;
  if (reference.type !== 'REGISTRY') return;
  const contract = manifest.find(
    (item) =>
      item.contractId === reference.contractId &&
      item.contractVersion === reference.contractVersion,
  );
  if (
    !contract ||
    spec.contractId !== contract.contractId ||
    spec.contractVersion !== contract.contractVersion ||
    spec.maxSizeBytes !== contract.maxSizeBytes ||
    !contractArtifactKindMatches(contract.kind, spec.kind)
  )
    invalid('Registry Artifact reference must match the frozen Contract manifest');
}

function validateRevisionGroups(version: WorkflowVersion): void {
  const groups = version.revisionGroups ?? [];
  if (
    !Array.isArray(groups) ||
    groups.length > 32 ||
    groups.some(
      (group) =>
        !plain(group) ||
        !exactKeys(group, ['id', 'maxTotalTraversals', 'onExhausted']) ||
        typeof group.id !== 'string',
    ) ||
    new Set(groups.map((group) => group.id)).size !== groups.length
  )
    invalid('Invalid or duplicate Revision Group');
  for (const group of groups) {
    if (
      !contractIdPattern.test(group.id) ||
      !Number.isSafeInteger(group.maxTotalTraversals) ||
      group.maxTotalTraversals < 1 ||
      group.maxTotalTraversals > W2_CONTRACT_POLICY.maxRevisionTraversals ||
      !['WAITING_USER', 'FAILED'].includes(group.onExhausted)
    )
      invalid('Invalid bounded Revision Group');
  }

  const groupIds = new Set(groups.map((group) => group.id));
  for (const edge of version.edges) {
    if (edge.revisionCode !== undefined && edge.revision === undefined)
      invalid('revisionCode must be attached to a declared revision edge');
    if (
      edge.revisionCode !== undefined &&
      (typeof edge.revisionCode !== 'string' ||
        !revisionCodePattern.test(edge.revisionCode) ||
        version.steps.find((step) => step.id === edge.fromStepId)?.type !== 'REVIEW' ||
        edge.condition.type !== 'REVIEW_VERDICT' ||
        edge.condition.verdict !== 'REVISE')
    )
      invalid('revisionCode is a static code for a REVIEW REVISE edge');
    if (edge.revision === undefined) continue;
    if (
      !plain(edge.revision) ||
      !exactKeys(edge.revision, ['groupId', 'maxTraversals']) ||
      typeof edge.revision.groupId !== 'string'
    )
      invalid('Invalid bounded Revision edge');
    const from = version.steps.find((step) => step.id === edge.fromStepId);
    const reviewRevision =
      from?.type === 'REVIEW' &&
      edge.condition.type === 'REVIEW_VERDICT' &&
      edge.condition.verdict === 'REVISE';
    const condition = edge.condition;
    const decisionRevision =
      from?.type === 'DECISION' &&
      condition.type === 'JSON_FIELD_EQUALS' &&
      from.inputs.some((input) => input.key === condition.inputKey && input.required);
    if (
      !edge.toStepId ||
      !groupIds.has(edge.revision.groupId) ||
      !Number.isSafeInteger(edge.revision.maxTraversals) ||
      edge.revision.maxTraversals < 1 ||
      edge.revision.maxTraversals > W2_CONTRACT_POLICY.maxRevisionTraversals ||
      edge.revision.maxTraversals >
        (groups.find((group) => group.id === edge.revision!.groupId)?.maxTotalTraversals ?? 0) ||
      (!reviewRevision && !decisionRevision)
    )
      invalid('Revision edge must be a bounded REVIEW REVISE or DECISION condition edge');
    const reachable = new Set<string>();
    const pending = [edge.toStepId];
    let closesCycle = false;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === edge.fromStepId) {
        closesCycle = true;
        break;
      }
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const next of version.edges) {
        if (next.fromStepId === current && next.toStepId !== null && next.revision === undefined)
          pending.push(next.toStepId);
      }
    }
    if (!closesCycle) invalid('Revision edge target must be able to reach its source');
  }

  const reviewSources = new Set(
    version.edges
      .filter(
        (edge) => edge.condition.type === 'REVIEW_VERDICT' && edge.condition.verdict === 'REVISE',
      )
      .map((edge) => edge.fromStepId),
  );
  for (const source of reviewSources) {
    const outgoing = version.edges.filter(
      (edge) =>
        edge.fromStepId === source &&
        edge.condition.type === 'REVIEW_VERDICT' &&
        edge.condition.verdict === 'REVISE',
    );
    if (outgoing.length > 1) {
      const codes = outgoing.map((edge) => edge.revisionCode);
      if (
        outgoing.some((edge) => !edge.revision) ||
        codes.some((code) => typeof code !== 'string' || !revisionCodePattern.test(code)) ||
        new Set(codes).size !== codes.length
      )
        invalid('Multi-target REVISE requires one unique static revisionCode per edge');
    } else if (
      outgoing[0]?.revisionCode !== undefined &&
      !revisionCodePattern.test(outgoing[0].revisionCode)
    ) {
      invalid('Invalid static revisionCode');
    }
  }
}

function sortedJson(value: unknown): string {
  const canonical = (current: unknown): unknown =>
    Array.isArray(current)
      ? current.map(canonical)
      : current && typeof current === 'object'
        ? Object.fromEntries(
            Object.entries(current)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : current;
  return JSON.stringify(canonical(value));
}

function validateReleaseMetadata(version: WorkflowVersion): void {
  const metadata = version.releaseMetadata;
  if (metadata === undefined) return;
  if (version.definition.source !== 'BUILTIN')
    invalid('Only a BUILTIN Workflow version can carry release metadata');
  if (
    !plain(metadata) ||
    !exactKeys(metadata, [
      'referenceBasis',
      'contractManifest',
      'revisionManifest',
      'effectManifest',
      'designRationale',
      'manifestHash',
    ]) ||
    !Array.isArray(metadata.referenceBasis) ||
    metadata.referenceBasis.length < 1 ||
    metadata.referenceBasis.length > 32 ||
    !Array.isArray(metadata.contractManifest) ||
    !plain(metadata.revisionManifest) ||
    !exactKeys(metadata.revisionManifest, ['groups', 'edges']) ||
    !Array.isArray(metadata.revisionManifest.groups) ||
    !Array.isArray(metadata.revisionManifest.edges) ||
    !Array.isArray(metadata.effectManifest) ||
    typeof metadata.designRationale !== 'string' ||
    !metadata.designRationale.trim() ||
    metadata.designRationale.length > 4000 ||
    (metadata.manifestHash !== undefined && !hashPattern.test(metadata.manifestHash))
  )
    invalid('Invalid structured Workflow release metadata');
  for (const reference of metadata.referenceBasis) {
    if (
      !plain(reference) ||
      !exactKeys(reference, [
        'title',
        'organizationOrCommunity',
        'referenceType',
        'uri',
        'retrievedAt',
        'adoptedPrinciples',
        'intentionallyExcludedMechanisms',
        'rationale',
        'notes',
      ]) ||
      typeof reference.title !== 'string' ||
      !reference.title.trim() ||
      reference.title.length > 256 ||
      !Array.isArray(reference.adoptedPrinciples) ||
      reference.adoptedPrinciples.length < 1 ||
      !stringList(reference.adoptedPrinciples, 32, 500) ||
      !Array.isArray(reference.intentionallyExcludedMechanisms) ||
      !stringList(reference.intentionallyExcludedMechanisms, 32, 500) ||
      typeof reference.rationale !== 'string' ||
      !reference.rationale.trim() ||
      reference.rationale.length > 2000
    )
      invalid('Reference Basis requires adopted principles and rationale');
    if (
      reference.referenceType !== undefined &&
      !['INDUSTRY_PRACTICE', 'ACADEMIC_METHOD', 'STANDARD_OR_GUIDE', 'COMMUNITY_PRACTICE'].includes(
        reference.referenceType,
      )
    )
      invalid('Invalid Reference Basis type');
    if (
      reference.uri !== undefined &&
      (typeof reference.uri !== 'string' || reference.uri.length > 2048)
    )
      invalid('Invalid Reference Basis URI');
    if (
      reference.retrievedAt !== undefined &&
      (typeof reference.retrievedAt !== 'string' ||
        !Number.isFinite(Date.parse(reference.retrievedAt)))
    )
      invalid('Invalid Reference Basis retrieval time');
    if (
      reference.notes !== undefined &&
      (typeof reference.notes !== 'string' || reference.notes.length > 2000)
    )
      invalid('Invalid Reference Basis notes');
  }

  const contractManifest = version.contractManifest ?? [];
  const expectedContracts = contractManifest
    .map(({ contractId, contractVersion }) => ({ contractId, contractVersion }))
    .sort(
      (left, right) =>
        left.contractId.localeCompare(right.contractId) ||
        left.contractVersion.localeCompare(right.contractVersion),
    );
  const releaseContracts = metadata.contractManifest
    .map((entry) => {
      if (
        !plain(entry) ||
        !exactKeys(entry, ['contractId', 'contractVersion']) ||
        typeof entry.contractId !== 'string' ||
        typeof entry.contractVersion !== 'string'
      )
        invalid('Invalid released Contract manifest entry');
      return { contractId: entry.contractId, contractVersion: entry.contractVersion };
    })
    .sort(
      (left, right) =>
        left.contractId.localeCompare(right.contractId) ||
        left.contractVersion.localeCompare(right.contractVersion),
    );
  if (sortedJson(releaseContracts) !== sortedJson(expectedContracts))
    invalid('Release Contract manifest does not exactly match frozen Contracts');

  const revisionGroups = version.revisionGroups ?? [];
  const revisionEdges = version.edges
    .filter((edge) => edge.revision)
    .map((edge) => ({
      edgeId: edge.id,
      groupId: edge.revision!.groupId,
      maxTraversals: edge.revision!.maxTraversals,
      ...(edge.revisionCode === undefined ? {} : { revisionCode: edge.revisionCode }),
    }))
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const listedEdges = metadata.revisionManifest.edges
    .map((edge) => {
      if (
        !plain(edge) ||
        !exactKeys(edge, ['edgeId', 'groupId', 'maxTraversals', 'revisionCode']) ||
        typeof edge.edgeId !== 'string' ||
        typeof edge.groupId !== 'string' ||
        !Number.isSafeInteger(edge.maxTraversals) ||
        (edge.revisionCode !== undefined && typeof edge.revisionCode !== 'string')
      )
        invalid('Invalid released Revision edge manifest entry');
      return {
        edgeId: edge.edgeId,
        groupId: edge.groupId,
        maxTraversals: edge.maxTraversals,
        ...(edge.revisionCode === undefined ? {} : { revisionCode: edge.revisionCode }),
      };
    })
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  if (
    sortedJson(
      [...metadata.revisionManifest.groups].sort((left, right) => left.id.localeCompare(right.id)),
    ) !== sortedJson([...revisionGroups].sort((left, right) => left.id.localeCompare(right.id))) ||
    sortedJson(listedEdges) !== sortedJson(revisionEdges)
  )
    invalid('Release Revision manifest does not exactly match frozen groups and edges');

  const expectedEffects = version.steps
    .map((step) => ({
      stepId: step.id,
      effectType: step.effectType,
      paths: [...(step.effectPaths ?? [])].sort(),
      ...(step.effectPathMode ? { pathMode: step.effectPathMode } : {}),
    }))
    .sort((left, right) => left.stepId.localeCompare(right.stepId));
  const listedEffects = metadata.effectManifest
    .map((entry) => {
      if (
        !plain(entry) ||
        !exactKeys(entry, ['stepId', 'effectType', 'paths', 'pathMode']) ||
        (entry.pathMode !== undefined && entry.pathMode !== 'DYNAMIC') ||
        typeof entry.stepId !== 'string' ||
        !Array.isArray(entry.paths) ||
        entry.paths.some((path) => typeof path !== 'string')
      )
        invalid('Invalid released Effect manifest entry');
      return {
        stepId: entry.stepId,
        effectType: entry.effectType,
        paths: [...entry.paths].sort(),
        ...(entry.pathMode ? { pathMode: entry.pathMode } : {}),
      };
    })
    .sort((left, right) => left.stepId.localeCompare(right.stepId));
  if (sortedJson(listedEffects) !== sortedJson(expectedEffects))
    invalid('Release Effect manifest does not exactly match frozen Steps');
}

export function validateW2WorkflowVersion(version: WorkflowVersion): void {
  const manifest = version.contractManifest;
  const w2Signals =
    version.revisionGroups !== undefined ||
    version.releaseMetadata !== undefined ||
    version.steps.some((step) => step.effectPaths !== undefined);
  if (w2Signals && manifest === undefined)
    invalid('W2 Workflow fields require an explicit frozen contractManifest');
  if (manifest !== undefined) {
    if (!Array.isArray(manifest) || manifest.length > W2_CONTRACT_POLICY.maxContractCount)
      invalid('Invalid bounded Artifact Contract manifest');
    const identities = new Set<string>();
    for (const contract of manifest) {
      validateArtifactContractDefinition(contract);
      const identity = `${contract.contractId}\u0000${contract.contractVersion}`;
      if (identities.has(identity)) invalid('Duplicate Artifact Contract identity');
      identities.add(identity);
    }
  }
  const contracts = manifest ?? [];
  const specs = version.steps.flatMap((step) => step.outputs);
  if (version.outputSchema) specs.push(...version.outputSchema.outputs);
  const referencedContracts = new Set<string>();
  for (const spec of specs) {
    const reference = spec.validator;
    if (reference.type !== 'REGISTRY') continue;
    validateRegistryArtifactSpec(spec, contracts);
    referencedContracts.add(`${reference.contractId}\u0000${reference.contractVersion}`);
  }
  if (referencedContracts.size !== contracts.length)
    invalid('Every frozen Contract must be referenced by a registry-backed Artifact');

  for (const step of version.steps) {
    const paths = step.effectPaths;
    if (paths !== undefined && !validatePaths(paths, W2_CONTRACT_POLICY.maxEffectPaths))
      invalid('Step effectPaths must be unique safe relative paths');
    const pathCount = paths?.length ?? 0;
    if (
      manifest !== undefined &&
      (((step.effectType === 'FILE_OUTPUT' || step.effectType === 'WORKSPACE_MUTATION') &&
        pathCount === 0 &&
        step.effectPathMode !== 'DYNAMIC') ||
        ((step.effectType === 'NONE' || step.effectType === 'EXTERNAL_ACTION') && pathCount > 0))
    )
      invalid('Step effectPaths do not match its declared side effect');
  }
  validateRevisionGroups(version);
  validateReleaseMetadata(version);
}

export interface ArtifactContractValidationInput {
  kind: string;
  content: string;
  contentHash?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

function parseManifest(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && hashPattern.test(value);
}

function validateManifestEntries(
  entries: unknown,
  maxEntries: number,
  maxTotalSizeBytes: number,
  allowedPaths: readonly string[] | undefined,
  kind: 'DIRECTORY' | 'WORKSPACE',
  requireHashes: boolean,
  requireBeforeHash = false,
): string[] {
  if (!Array.isArray(entries) || entries.length > maxEntries) return ['INVALID_MANIFEST_ENTRIES'];
  const errors: string[] = [];
  const paths = new Set<string>();
  let totalSizeBytes = 0;
  const allowed = allowedPaths
    ? new Set(allowedPaths.map((path) => normalizedPath(path).toLocaleLowerCase('en-US')))
    : undefined;
  for (const entry of entries) {
    if (
      !plain(entry) ||
      typeof entry.relativePath !== 'string' ||
      !isSafeWorkflowRelativePath(entry.relativePath)
    ) {
      errors.push('INVALID_MANIFEST_PATH');
    } else {
      const path = normalizedPath(entry.relativePath).toLocaleLowerCase('en-US');
      if (paths.has(path)) errors.push('DUPLICATE_MANIFEST_PATH');
      paths.add(path);
      if (allowed && !allowed.has(path)) errors.push('UNDECLARED_MANIFEST_PATH');
    }
    if (kind === 'DIRECTORY') {
      if (!exactKeys(entry, ['relativePath', 'contentHash', 'sizeBytes']))
        errors.push('INVALID_MANIFEST_ENTRY');
      if (entry.contentHash !== undefined && !validSha256(entry.contentHash))
        errors.push('INVALID_MANIFEST_HASH');
      if (requireHashes && !validSha256(entry.contentHash)) errors.push('MISSING_MANIFEST_HASH');
      if (entry.sizeBytes === undefined) errors.push('MISSING_MANIFEST_SIZE');
      else if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0)
        errors.push('INVALID_MANIFEST_SIZE');
      else totalSizeBytes += entry.sizeBytes as number;
    } else {
      if (!exactKeys(entry, ['relativePath', 'beforeHash', 'afterHash']))
        errors.push('INVALID_MANIFEST_ENTRY');
      if (!validSha256(entry.afterHash)) errors.push('MISSING_AFTER_HASH');
      if (entry.beforeHash !== undefined && !validSha256(entry.beforeHash))
        errors.push('INVALID_BEFORE_HASH');
      if (requireBeforeHash && !validSha256(entry.beforeHash)) errors.push('MISSING_BEFORE_HASH');
    }
  }
  if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes > maxTotalSizeBytes)
    errors.push('MANIFEST_TOTAL_SIZE_LIMIT');
  return errors.slice(0, W2_CONTRACT_POLICY.maxValidationErrors);
}

/** Deterministic validation over artifact content and metadata; never coerces input values. */
export function validateArtifactContract(
  contract: ArtifactContract,
  artifact: ArtifactContractValidationInput,
): string[] {
  const errors: string[] = [];
  const add = (error: string): void => {
    if (errors.length < W2_CONTRACT_POLICY.maxValidationErrors && !errors.includes(error))
      errors.push(error);
  };
  try {
    validateArtifactContractDefinition(contract);
  } catch {
    return ['INVALID_CONTRACT'];
  }
  if (
    contract.kind !== artifact.kind &&
    !(contract.kind === 'WORKSPACE' && artifact.kind === 'DIRECTORY')
  )
    add('KIND_MISMATCH');
  if (typeof artifact.content !== 'string') {
    add('CONTENT_REQUIRED');
    return errors;
  }
  const metadata = plain(artifact.metadata) ? artifact.metadata : {};
  const contentBytes = new TextEncoder().encode(artifact.content).byteLength;
  const sizeBytes = contract.kind === 'FILE' ? (metadata.sizeBytes ?? contentBytes) : contentBytes;
  const contentLimit = contract.kind === 'DIRECTORY' ? 1_000_000 : contract.maxSizeBytes;
  if (
    !Number.isSafeInteger(sizeBytes) ||
    (sizeBytes as number) < 0 ||
    (sizeBytes as number) > contentLimit
  )
    add('SIZE_LIMIT');

  switch (contract.validator.type) {
    case 'JSON_SCHEMA': {
      const parsed = parseManifest(artifact.content);
      if (parsed === null) add('INVALID_JSON');
      else {
        try {
          validateWorkflowInputs(contract.validator.schema, parsed);
        } catch {
          add('JSON_SCHEMA_MISMATCH');
        }
      }
      break;
    }
    case 'TEXT_RULES':
      if ([...artifact.content.trim()].length < contract.validator.minLength) add('TEXT_TOO_SHORT');
      if (
        contract.validator.requiredSections.some((section) => !artifact.content.includes(section))
      )
        add('MISSING_REQUIRED_SECTION');
      break;
    case 'FILE_METADATA':
      if (
        !Number.isSafeInteger(metadata.sizeBytes) ||
        (metadata.sizeBytes as number) < 0 ||
        (metadata.sizeBytes as number) > contract.maxSizeBytes
      )
        add('INVALID_FILE_SIZE_METADATA');
      if (
        typeof metadata.extension !== 'string' ||
        !contract.validator.allowedExtensions.includes(metadata.extension.toLowerCase())
      )
        add('INVALID_FILE_EXTENSION');
      if (
        contract.validator.allowedMediaTypes.length > 0 &&
        (typeof metadata.mediaType !== 'string' ||
          !contract.validator.allowedMediaTypes.includes(metadata.mediaType.toLowerCase()))
      )
        add('INVALID_MEDIA_TYPE');
      if (
        (contract.validator.requireContentHash || metadata.contentHash !== undefined) &&
        !validSha256(metadata.contentHash)
      )
        add('INVALID_CONTENT_HASH');
      if (
        !isSafeWorkflowRelativePath(
          typeof metadata.relativePath === 'string' ? metadata.relativePath : metadata.path,
        )
      )
        add('INVALID_RELATIVE_PATH');
      break;
    case 'DIRECTORY_MANIFEST':
    case 'WORKSPACE_MANIFEST': {
      if (contentBytes > 1_000_000) add('MANIFEST_CONTENT_LIMIT');
      const manifest = parseManifest(artifact.content);
      if (
        !plain(manifest) ||
        !exactKeys(manifest, ['entries']) ||
        !Array.isArray(manifest.entries)
      ) {
        add('INVALID_MANIFEST');
        break;
      }
      for (const error of validateManifestEntries(
        manifest.entries,
        contract.validator.maxEntries,
        contract.maxSizeBytes,
        contract.validator.type === 'WORKSPACE_MANIFEST' && contract.validator.dynamicPaths === true
          ? undefined
          : contract.validator.allowedPaths,
        contract.validator.type === 'DIRECTORY_MANIFEST' ? 'DIRECTORY' : 'WORKSPACE',
        contract.validator.type === 'DIRECTORY_MANIFEST' ? contract.validator.requireHashes : false,
        contract.validator.type === 'WORKSPACE_MANIFEST'
          ? contract.validator.requireBeforeHash
          : false,
      ))
        add(error);
      break;
    }
  }
  return errors;
}

export function validateRevisionTraversal(value: RevisionTraversal): void {
  if (
    !plain(value) ||
    !value.id ||
    !value.workflowRunId ||
    !value.stepRunId ||
    !value.edgeId ||
    !value.groupId ||
    !Number.isSafeInteger(value.traversalIndex) ||
    value.traversalIndex < 1 ||
    value.traversalIndex > W2_CONTRACT_POLICY.maxRevisionTraversals ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 1000 ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    invalid('Invalid durable Revision Traversal');
}

export function validateStepOperationReceipt(value: StepOperationReceipt): void {
  if (
    !plain(value) ||
    !value.id ||
    !value.workflowRunId ||
    !value.stepRunId ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 5 ||
    !value.operationKey ||
    !['NONE', 'FILE_OUTPUT', 'WORKSPACE_MUTATION', 'EXTERNAL_ACTION'].includes(value.effectType) ||
    !['PREPARED', 'APPLIED', 'VERIFIED', 'UNKNOWN'].includes(value.state) ||
    !hashPattern.test(value.inputHash) ||
    (value.outputArtifactIds !== undefined &&
      (!Array.isArray(value.outputArtifactIds) ||
        value.outputArtifactIds.length > 64 ||
        value.outputArtifactIds.some((id) => typeof id !== 'string' || !id))) ||
    (value.externalReference !== undefined &&
      (typeof value.externalReference !== 'string' || value.externalReference.length > 1024)) ||
    (value.manifest !== undefined &&
      (!Array.isArray(value.manifest) ||
        value.manifest.length > W2_CONTRACT_POLICY.maxEffectPaths ||
        value.manifest.some(
          (entry) =>
            !plain(entry) ||
            !isSafeWorkflowRelativePath(entry.relativePath) ||
            (entry.beforeHash !== undefined && !hashPattern.test(entry.beforeHash)) ||
            (entry.afterHash !== undefined && !hashPattern.test(entry.afterHash)),
        ))) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    invalid('Invalid Step Operation Receipt');
}
