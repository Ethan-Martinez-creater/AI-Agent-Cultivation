import type {
  WorkflowArtifact,
  WorkflowArtifactBinding,
  WorkflowValidationReceipt,
} from './w1-workflow.js';
import type { WorkflowInputs } from './w1-workflow-contract.js';
import { isSafeWorkflowRelativePath } from './w2-workflow.js';

export type WorkflowImportProposalStatus = 'DRAFT' | 'VALIDATED' | 'CANCELLED' | 'COMMITTED';
export type WorkflowImportValidationStatus = 'VALID' | 'INVALID';
export type WorkflowImportSourceKind = 'TEXT' | 'JSON';

/** Bounded text snapshot selected by the trusted Main file reader. */
export interface WorkflowImportSource {
  id: string;
  name: string;
  relativePath: string;
  workspaceRoot: string;
  kind: WorkflowImportSourceKind;
  size: number;
  content: string;
  /** SHA-256 of the exact UTF-8 source contents. */
  contentHash: string;
  /** Source modification time in Unix milliseconds. */
  mtime: number;
}

/** Renderer-safe source summary. It excludes source contents and filesystem locations. */
export interface WorkflowImportSourceSummary {
  id: string;
  name: string;
  kind: WorkflowImportSourceKind;
  size: number;
  contentHash: string;
}

export interface WorkflowImportArtifactMapping {
  stepId: string;
  outputKey: string;
  sourceId: string;
}

export interface WorkflowImportResolution {
  suggestedCompletedSteps: string[];
  suggestedCurrentStep: string;
  candidateArtifactBindings: WorkflowImportArtifactMapping[];
  missingRequirements: string[];
  confidence: number;
  explanationSummary: string;
}

/** Editable proposal. Full source snapshots stay in Main and never enter its safe DTO. */
export interface WorkflowImportProposal {
  id: string;
  revision: number;
  status: WorkflowImportProposalStatus;
  definitionId: string;
  version: number;
  versionHash: string;
  inputSnapshot: WorkflowInputs;
  description: string;
  sources: WorkflowImportSource[];
  resolution: WorkflowImportResolution;
  sourceMetadataHash: string;
  policyVersion: string;
  validationStatus: WorkflowImportValidationStatus;
  validationErrors: string[];
  createdAt: string;
  updatedAt: string;
  runId: string | null;
}

export type WorkflowImportProposalSafeDto = Omit<WorkflowImportProposal, 'sources'> & {
  sources: WorkflowImportSourceSummary[];
};

/** Immutable user-confirmed mapping snapshot attached to exactly one new Workflow Run. */
export interface WorkflowImportConfirmation {
  id: string;
  proposalId: string;
  runId: string;
  versionHash: string;
  sourceMetadataHash: string;
  completedStepIds: string[];
  currentStepId: string;
  bindings: WorkflowImportArtifactMapping[];
  mappingHash: string;
  createdAt: string;
}

export interface WorkflowImportedArtifact extends WorkflowArtifact {
  missionId: null;
  missionRunId: null;
  actorId: null;
  source: 'IMPORTED_CONFIRMED';
  importConfirmationId: string;
}

export interface WorkflowImportedBinding extends WorkflowArtifactBinding {
  importConfirmationId: string;
}

export type WorkflowImportedValidation = WorkflowValidationReceipt;

export const WORKFLOW_IMPORT_POLICY_VERSION = 'w3-2-text-prefix-v1';
export const WORKFLOW_IMPORT_MAX_SOURCE_BYTES = 65_536;
export const WORKFLOW_IMPORT_MAX_SOURCES = 16;
export const WORKFLOW_IMPORT_MAX_COMPLETED_STEPS = 32;
export const WORKFLOW_IMPORT_MAX_BINDINGS = 384;

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ID = 256;

export function canonicalWorkflowImportJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

/** Stable hash shared by the trusted import resolver and persistence adapter. */
export function workflowImportHash(value: unknown): string {
  return sha256Hex(canonicalWorkflowImportJson(value));
}

export function workflowImportSourceMetadataHash(sources: readonly WorkflowImportSource[]): string {
  return workflowImportHash(
    [...sources]
      .map(({ id, name, relativePath, workspaceRoot, kind, size, contentHash, mtime }) => ({
        id,
        name,
        relativePath,
        workspaceRoot,
        kind,
        size,
        contentHash,
        mtime,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function workflowImportMappingHash(
  completedStepIds: readonly string[],
  currentStepId: string,
  bindings: readonly WorkflowImportArtifactMapping[],
): string {
  return workflowImportHash({
    completedStepIds: [...completedStepIds],
    currentStepId,
    bindings: [...bindings].sort(compareMapping),
  });
}

export function toWorkflowImportProposalSafeDto(
  proposal: WorkflowImportProposal,
): WorkflowImportProposalSafeDto {
  return {
    ...proposal,
    sources: proposal.sources.map(({ id, name, kind, size, contentHash }) => ({
      id,
      name,
      kind,
      size,
      contentHash,
    })),
  };
}

export function validateWorkflowImportProposal(value: WorkflowImportProposal): void {
  if (!plain(value)) invalid('Workflow Import proposal must be a plain object');
  validateKeys(value, [
    'id', 'revision', 'status', 'definitionId', 'version', 'versionHash', 'inputSnapshot',
    'description', 'sources', 'resolution', 'sourceMetadataHash', 'policyVersion',
    'validationStatus', 'validationErrors', 'createdAt', 'updatedAt', 'runId',
  ], 'Workflow Import proposal');
  validateId(value.id, 'Workflow Import proposal');
  validateId(value.definitionId, 'Workflow definition');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) invalid('Invalid proposal revision');
  if (!Number.isSafeInteger(value.version) || value.version < 1) invalid('Invalid Workflow version');
  validateHash(value.versionHash, 'Workflow versionHash');
  if (!Array.isArray(value.sources) || value.sources.length > WORKFLOW_IMPORT_MAX_SOURCES)
    invalid('Workflow Import source count is outside its bounds');
  validateHash(value.sourceMetadataHash, 'Source metadata hash');
  if (value.sourceMetadataHash !== workflowImportSourceMetadataHash(value.sources))
    invalid('Source metadata hash does not match its source snapshot');
  if (!['DRAFT', 'VALIDATED', 'CANCELLED', 'COMMITTED'].includes(value.status))
    invalid('Invalid Workflow Import proposal status');
  if (!['VALID', 'INVALID'].includes(value.validationStatus))
    invalid('Invalid Workflow Import validation status');
  if (value.status === 'COMMITTED' ? value.runId === null : value.runId !== null)
    invalid('Only committed proposals may reference a Workflow Run');
  if (value.status === 'VALIDATED' && value.validationStatus !== 'VALID')
    invalid('Validated proposals require valid import validation');
  if (value.status === 'COMMITTED' && value.validationStatus !== 'VALID')
    invalid('Committed proposals require valid import validation');
  if (value.validationStatus === 'VALID' && value.validationErrors.length > 0)
    invalid('Valid import proposals cannot contain validation errors');
  validateInputSnapshot(value.inputSnapshot);
  validateText(value.description, 'Workflow Import description', 6_000, true);
  validateText(value.policyVersion, 'Workflow Import policy version', 128);
  const strict = value.validationStatus === 'VALID';
  if (strict && value.policyVersion !== WORKFLOW_IMPORT_POLICY_VERSION)
    invalid('Valid Workflow Import proposals must use the supported policy version');
  if (strict && value.sources.length < 1) invalid('Validated proposals require at least one source');
  const sourceIds = new Set<string>();
  const physicalSources = new Set<string>();
  for (const source of value.sources) {
    validateWorkflowImportSource(source, strict);
    if (sourceIds.has(source.id)) invalid('Duplicate Workflow Import source id');
    sourceIds.add(source.id);
    const physicalIdentity = `${normalizeSourceLocation(source.workspaceRoot)}\u0000${normalizeSourceLocation(source.relativePath)}`;
    if (strict && physicalSources.has(physicalIdentity))
      invalid('Duplicate Workflow Import source location');
    physicalSources.add(physicalIdentity);
  }
  validateWorkflowImportResolution(value.resolution, sourceIds, strict);
  if (!Array.isArray(value.validationErrors) || value.validationErrors.length > 64)
    invalid('Workflow Import validation errors exceed their bound');
  for (const error of value.validationErrors) validateText(error, 'Workflow Import validation error', 512, true);
  validateTimestamp(value.createdAt);
  validateTimestamp(value.updatedAt);
  if (value.runId !== null) validateId(value.runId, 'Workflow Run');
}

export function validateWorkflowImportConfirmation(value: WorkflowImportConfirmation): void {
  if (!plain(value)) invalid('Workflow Import confirmation must be a plain object');
  validateKeys(value, [
    'id', 'proposalId', 'runId', 'versionHash', 'sourceMetadataHash', 'completedStepIds',
    'currentStepId', 'bindings', 'mappingHash', 'createdAt',
  ], 'Workflow Import confirmation');
  validateId(value.id, 'Workflow Import confirmation');
  validateId(value.proposalId, 'Workflow Import proposal');
  validateId(value.runId, 'Workflow Run');
  validateHash(value.versionHash, 'Workflow Import versionHash');
  validateHash(value.sourceMetadataHash, 'Workflow Import sourceMetadataHash');
  if (!Array.isArray(value.completedStepIds) || value.completedStepIds.length < 1 || value.completedStepIds.length > WORKFLOW_IMPORT_MAX_COMPLETED_STEPS)
    invalid('Workflow Import completed Step list is outside its bounds');
  validateUniqueIds(value.completedStepIds, 'Workflow Import completed Step');
  validateId(value.currentStepId, 'Workflow Import current Step');
  if (value.completedStepIds.includes(value.currentStepId))
    invalid('The current Workflow Step cannot also be marked imported-completed');
  validateMappings(value.bindings, new Set(), false, true);
  validateHash(value.mappingHash, 'Workflow Import mappingHash');
  if (value.mappingHash !== workflowImportMappingHash(value.completedStepIds, value.currentStepId, value.bindings))
    invalid('Workflow Import mappingHash does not match its confirmation snapshot');
  validateTimestamp(value.createdAt);
}

export function validateWorkflowImportedArtifact(value: WorkflowImportedArtifact): void {
  if (!plain(value)) invalid('Imported Workflow Artifact must be a plain object');
  validateKeys(value, [
    'id', 'workflowRunId', 'producerStepRunId', 'missionId', 'missionRunId', 'actorId',
    'sourceId', 'source', 'importConfirmationId', 'kind', 'content', 'contentHash',
    'metadata', 'inputArtifactIds', 'createdAt',
  ], 'Imported Workflow Artifact');
  if (value.source !== 'IMPORTED_CONFIRMED' || value.missionId !== null || value.missionRunId !== null || value.actorId !== null)
    invalid('Imported Workflow Artifacts must have Import provenance and no Mission identity');
  validateId(value.importConfirmationId, 'Workflow Import confirmation');
  validateId(value.id, 'Workflow Artifact');
  validateId(value.workflowRunId, 'Workflow Run');
  validateId(value.producerStepRunId, 'Workflow StepRun');
  validateId(value.sourceId, 'Workflow Import source');
  if (!['TEXT', 'JSON'].includes(value.kind)) invalid('Workflow Import supports only text and JSON Artifacts');
  validateText(value.content, 'Workflow Imported Artifact content', WORKFLOW_IMPORT_MAX_SOURCE_BYTES, true);
  if (utf8ByteLength(value.content) > WORKFLOW_IMPORT_MAX_SOURCE_BYTES)
    invalid('Workflow Imported Artifact exceeds its byte bound');
  if (!Array.isArray(value.inputArtifactIds) || value.inputArtifactIds.length > WORKFLOW_IMPORT_MAX_BINDINGS)
    invalid('Workflow Imported Artifact lineage exceeds its bound');
  validateUniqueIds(value.inputArtifactIds, 'Workflow Imported input Artifact');
  for (const id of value.inputArtifactIds) validateId(id, 'Workflow Imported input Artifact');
  if (!plain(value.metadata)) invalid('Workflow Imported Artifact metadata must be an object');
  const metadataKeys = [
    'sourceContentHash',
    'sourceName',
    'snapshot',
    'sizeBytes',
    'importConfirmationId',
  ];
  if (Object.keys(value.metadata).some((key) => !metadataKeys.includes(key)))
    invalid('Workflow Imported Artifact metadata contains an unsupported field');
  if (
    value.metadata.sourceContentHash !== sha256Hex(value.content) ||
    typeof value.metadata.sourceName !== 'string' ||
    value.metadata.snapshot !== true ||
    value.metadata.sizeBytes !== utf8ByteLength(value.content) ||
    value.metadata.importConfirmationId !== value.importConfirmationId
  )
    invalid('Workflow Imported Artifact metadata does not match its confirmed snapshot');
  validateTimestamp(value.createdAt);
  validateHash(value.contentHash, 'Workflow Imported Artifact contentHash');
  if (workflowImportHash({ content: value.content, metadata: value.metadata }) !== value.contentHash)
    invalid('Workflow Imported Artifact contentHash must hash its canonical content and metadata');
}

function validateWorkflowImportSource(value: WorkflowImportSource, strict: boolean): void {
  if (!plain(value)) invalid('Workflow Import source must be a plain object');
  validateKeys(value, [
    'id', 'name', 'relativePath', 'workspaceRoot', 'kind', 'size', 'content', 'contentHash', 'mtime',
  ], 'Workflow Import source');
  validateId(value.id, 'Workflow Import source');
  validateText(value.name, 'Workflow Import source name', 256);
  if (!isSafeWorkflowRelativePath(value.relativePath)) invalid('Workflow Import source path is unsafe');
  validateText(value.workspaceRoot, 'Workflow Import workspace root', 4096);
  if (!['TEXT', 'JSON'].includes(value.kind)) invalid('Invalid Workflow Import source kind');
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > WORKFLOW_IMPORT_MAX_SOURCE_BYTES)
    invalid('Workflow Import source size is outside its bounds');
  if (typeof value.content !== 'string' || utf8ByteLength(value.content) !== value.size)
    invalid('Workflow Import source content does not match its byte size');
  validateHash(value.contentHash, 'Workflow Import source contentHash');
  if (sha256Hex(value.content) !== value.contentHash)
    invalid('Workflow Import source contentHash does not match its snapshot');
  if (!Number.isFinite(value.mtime) || value.mtime < 0) invalid('Invalid Workflow Import source mtime');
  if (strict && value.kind === 'JSON') {
    try {
      JSON.parse(value.content);
    } catch {
      invalid('JSON Workflow Import sources must contain valid JSON');
    }
  }
}

function validateWorkflowImportResolution(
  value: WorkflowImportResolution,
  sourceIds: Set<string>,
  strict: boolean,
): void {
  if (!plain(value)) invalid('Workflow Import resolution must be a plain object');
  validateKeys(value, [
    'suggestedCompletedSteps', 'suggestedCurrentStep', 'candidateArtifactBindings',
    'missingRequirements', 'confidence', 'explanationSummary',
  ], 'Workflow Import resolution');
  if (!Array.isArray(value.suggestedCompletedSteps) || value.suggestedCompletedSteps.length > WORKFLOW_IMPORT_MAX_COMPLETED_STEPS)
    invalid('Suggested completed Steps are outside their bounds');
  if (strict) validateUniqueIds(value.suggestedCompletedSteps, 'Suggested completed Step');
  else for (const id of value.suggestedCompletedSteps) validateId(id, 'Suggested completed Step');
  if (strict) validateId(value.suggestedCurrentStep, 'Suggested current Step');
  else validateText(value.suggestedCurrentStep, 'Suggested current Step', MAX_ID, true);
  if (strict && value.suggestedCompletedSteps.includes(value.suggestedCurrentStep))
    invalid('Suggested current Step cannot be in the completed prefix');
  validateMappings(value.candidateArtifactBindings, sourceIds, strict, strict);
  if (!Array.isArray(value.missingRequirements) || value.missingRequirements.length > WORKFLOW_IMPORT_MAX_BINDINGS)
    invalid('Missing Workflow Import requirements exceed their bound');
  for (const missing of value.missingRequirements)
    validateText(missing, 'Missing Workflow Import requirement', 256, true);
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)
    invalid('Workflow Import confidence must be between zero and one');
  validateText(value.explanationSummary, 'Workflow Import explanation', 2_000, true);
}

function validateMappings(
  mappings: WorkflowImportArtifactMapping[],
  sourceIds: Set<string>,
  requireKnownSources: boolean,
  requireUnique: boolean,
): void {
  if (!Array.isArray(mappings) || mappings.length > WORKFLOW_IMPORT_MAX_BINDINGS)
    invalid('Workflow Import artifact mappings exceed their bound');
  const identities = new Set<string>();
  for (const mapping of mappings) {
    if (!plain(mapping)) invalid('Invalid Workflow Import artifact mapping');
    validateKeys(mapping, ['stepId', 'outputKey', 'sourceId'], 'Workflow Import artifact mapping');
    validateId(mapping.stepId, 'Workflow Import Step');
    validateId(mapping.outputKey, 'Workflow Import output key');
    validateId(mapping.sourceId, 'Workflow Import source');
    if (requireKnownSources && !sourceIds.has(mapping.sourceId)) invalid('Workflow Import mapping references an unknown source');
    const identity = `${mapping.stepId}\u0000${mapping.outputKey}`;
    if (requireUnique && identities.has(identity)) invalid('Duplicate Workflow Import artifact mapping');
    identities.add(identity);
  }
}

function validateInputSnapshot(value: WorkflowInputs): void {
  if (!plain(value)) invalid('Workflow Import input snapshot must be an object');
  if (utf8ByteLength(canonicalWorkflowImportJson(value)) > 32_768)
    invalid('Workflow Import input snapshot is too large');
}

function validateUniqueIds(values: string[], name: string): void {
  if (new Set(values).size !== values.length) invalid(`Duplicate ${name}`);
  for (const value of values) validateId(value, name);
}

function validateHash(value: string, name: string): void {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(`${name} must be SHA-256 hex`);
}

function validateId(value: string, name: string): void {
  validateText(value, `${name} id`, MAX_ID);
}

function validateTimestamp(value: string): void {
  if (typeof value !== 'string' || value.length > 128 || !Number.isFinite(Date.parse(value)))
    invalid('Workflow Import timestamp is invalid');
}

function validateText(value: string, name: string, max: number, allowEmpty = false): void {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()))
    invalid(`${name} is invalid`);
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validateKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid(`${name} contains an unsupported field`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// Synchronous SHA-256 keeps domain validation usable from both Main and Renderer.
function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Int32Array(64);
  const rotateRight = (number: number, count: number): number =>
    (number >>> count) | (number << (32 - count));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getInt32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const bigSigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const first = (h! + bigSigma1 + choose + constants[index]! + words[index]!) | 0;
      const bigSigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (bigSigma0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }
    state[0] = (state[0]! + a!) | 0;
    state[1] = (state[1]! + b!) | 0;
    state[2] = (state[2]! + c!) | 0;
    state[3] = (state[3]! + d!) | 0;
    state[4] = (state[4]! + e!) | 0;
    state[5] = (state[5]! + f!) | 0;
    state[6] = (state[6]! + g!) | 0;
    state[7] = (state[7]! + h!) | 0;
  }
  return state.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

function compareMapping(left: WorkflowImportArtifactMapping, right: WorkflowImportArtifactMapping): number {
  return left.stepId.localeCompare(right.stepId) || left.outputKey.localeCompare(right.outputKey) || left.sourceId.localeCompare(right.sourceId);
}

function normalizeSourceLocation(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function invalid(message: string): never {
  throw new Error(message);
}
