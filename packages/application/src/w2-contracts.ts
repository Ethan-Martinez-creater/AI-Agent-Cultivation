import { createHash } from 'node:crypto';
import { DomainError } from '@cultivation/shared';
import {
  freezeArtifactContract,
  validateArtifactContractDefinition,
  validateWorkflowVersion,
} from '@cultivation/domain';
import type { ArtifactContract, WorkflowVersion } from '@cultivation/domain';

export interface ArtifactContractRegistryPersistence {
  registerContract(value: ArtifactContract): void;
  getContract(contractId: string, contractVersion: string): ArtifactContract | null;
  listContracts(): ArtifactContract[];
}

/** Immutable id/version registry with an optional persistence adapter. */
export class ArtifactContractRegistry {
  private readonly contracts = new Map<string, ArtifactContract>();

  constructor(private readonly persistence?: ArtifactContractRegistryPersistence) {}

  register(value: ArtifactContract): ArtifactContract {
    validateArtifactContractDefinition(value);
    const contract = freezeArtifactContract(value);
    const key = `${contract.contractId}\u0000${contract.contractVersion}`;
    const existing = this.get(contract.contractId, contract.contractVersion);
    if (existing) {
      if (JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(contract)))
        throw new DomainError('CONFLICT', 'Artifact Contract version is immutable');
      return existing;
    }
    this.persistence?.registerContract(contract);
    this.contracts.set(key, contract);
    return contract;
  }

  registerContract(value: ArtifactContract): ArtifactContract {
    return this.register(value);
  }

  get(contractId: string, contractVersion: string): ArtifactContract | null {
    const key = `${contractId}\u0000${contractVersion}`;
    const cached = this.contracts.get(key);
    if (cached) return cached;
    const persisted = this.persistence?.getContract(contractId, contractVersion) ?? null;
    if (!persisted) return null;
    const frozen = freezeArtifactContract(persisted);
    if (frozen.contractId !== contractId || frozen.contractVersion !== contractVersion)
      throw new DomainError(
        'CONFLICT',
        'Artifact Contract persistence returned a different version',
      );
    this.contracts.set(key, frozen);
    return frozen;
  }

  getContract(contractId: string, contractVersion: string): ArtifactContract | null {
    return this.get(contractId, contractVersion);
  }

  list(): ArtifactContract[] {
    for (const contract of this.persistence?.listContracts() ?? []) {
      const frozen = freezeArtifactContract(contract);
      const key = `${frozen.contractId}\u0000${frozen.contractVersion}`;
      const existing = this.contracts.get(key);
      if (existing && JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(frozen)))
        throw new DomainError('CONFLICT', 'Artifact Contract version is immutable');
      this.contracts.set(key, existing ?? frozen);
    }
    return [...this.contracts.values()];
  }

  listContracts(): ArtifactContract[] {
    return this.list();
  }
}

export interface OfficialBuiltinWorkflowPackage {
  /** Trusted application code only; never accepted from Renderer/IPC. */
  kind: 'OFFICIAL';
  version: WorkflowVersion;
}

export interface TestBuiltinWorkflowPackage {
  kind: 'TEST_ONLY';
  version: WorkflowVersion;
}

export type BuiltinWorkflowPackage = OfficialBuiltinWorkflowPackage | TestBuiltinWorkflowPackage;

export interface BuiltinWorkflowRegistryOptions {
  /** Production defaults to false and an empty registry. */
  testOnly?: boolean;
  packages?: readonly BuiltinWorkflowPackage[];
}

export interface WorkflowReviewResult {
  verdict: 'PASS' | 'REVISE' | 'FAIL';
  findings: string[];
  evidence: string[];
  summary: string;
  reviewedArtifactIds: string[];
  revisionCode?: string;
}

const revisionCodePattern = /^[a-z][a-z0-9_.-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Common closed REVIEW result validation, including the statically declared revision targets. */
export function validateWorkflowReviewResult(
  value: unknown,
  version: WorkflowVersion,
  reviewStepId: string,
): WorkflowReviewResult {
  function fail(): never {
    throw new DomainError(
      'WORKFLOW_OUTPUT_INVALID',
      'REVIEW output does not match its frozen schema',
    );
  }
  if (!isRecord(value)) fail();
  const allowedKeys = [
    'verdict',
    'findings',
    'evidence',
    'summary',
    'reviewedArtifactIds',
    'revisionCode',
  ];
  if (
    Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
    !['PASS', 'REVISE', 'FAIL'].includes(String(value.verdict)) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 20 ||
    value.findings.some((item) => typeof item !== 'string' || item.length > 1000) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 20 ||
    value.evidence.some((item) => typeof item !== 'string' || item.length > 1000) ||
    typeof value.summary !== 'string' ||
    value.summary.length > 2000 ||
    !Array.isArray(value.reviewedArtifactIds) ||
    value.reviewedArtifactIds.length > 12 ||
    value.reviewedArtifactIds.some(
      (item) => typeof item !== 'string' || !item || item.length > 128,
    ) ||
    new Set(value.reviewedArtifactIds).size !== value.reviewedArtifactIds.length ||
    (value.revisionCode !== undefined && typeof value.revisionCode !== 'string')
  )
    fail();
  const reviewStep = version.steps.find((step) => step.id === reviewStepId);
  if (reviewStep?.type !== 'REVIEW') fail();
  const reviseEdges = version.edges.filter(
    (edge) =>
      edge.fromStepId === reviewStepId &&
      edge.condition.type === 'REVIEW_VERDICT' &&
      edge.condition.verdict === 'REVISE',
  );
  if (value.verdict === 'REVISE') {
    if (reviseEdges.length < 1) fail();
    if (reviseEdges.length > 1) {
      if (
        typeof value.revisionCode !== 'string' ||
        !revisionCodePattern.test(value.revisionCode) ||
        !reviseEdges.some((edge) => edge.revisionCode === value.revisionCode)
      )
        fail();
    } else if (
      value.revisionCode !== undefined &&
      (typeof value.revisionCode !== 'string' ||
        !revisionCodePattern.test(value.revisionCode) ||
        reviseEdges[0]?.revisionCode !== value.revisionCode)
    ) {
      fail();
    }
  } else if (value.revisionCode !== undefined) {
    fail();
  }
  return JSON.parse(JSON.stringify(value)) as WorkflowReviewResult;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

/** Hashes the exact immutable release payload, excluding only the hash field itself. */
export function builtinWorkflowManifestHash(version: WorkflowVersion): string {
  if (!version.releaseMetadata)
    throw new DomainError('INVALID_INPUT', 'BUILTIN Workflow 缺少 releaseMetadata');
  const payload = JSON.parse(JSON.stringify(version)) as WorkflowVersion;
  if (payload.releaseMetadata) delete payload.releaseMetadata.manifestHash;
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest('hex');
}

/** Checks the structured release manifests and verifies the canonical frozen-version hash. */
export function validateBuiltinWorkflowRelease(
  version: WorkflowVersion,
  options: { requireManifestHash?: boolean } = {},
): string {
  validateWorkflowVersion(version);
  if (version.definition.source !== 'BUILTIN' || !version.releaseMetadata)
    throw new DomainError(
      'INVALID_INPUT',
      'BUILTIN release must include structured release metadata',
    );
  const expectedHash = builtinWorkflowManifestHash(version);
  const actualHash = version.releaseMetadata.manifestHash;
  if (
    (options.requireManifestHash !== false && !actualHash) ||
    (actualHash !== undefined && actualHash !== expectedHash)
  )
    throw new DomainError('INVALID_INPUT', 'BUILTIN release manifest hash mismatch');
  return expectedHash;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Production accepts only static OFFICIAL packages. TEST_ONLY packages additionally require
 * explicit test mode. No packages are implicitly loaded by the registry.
 */
export class BuiltinWorkflowRegistry {
  private readonly versions = new Map<string, WorkflowVersion>();
  private readonly packages = new Map<string, BuiltinWorkflowPackage>();
  private readonly testOnly: boolean;

  constructor(options: BuiltinWorkflowRegistryOptions = {}) {
    this.testOnly = options.testOnly === true;
    for (const workflowPackage of options.packages ?? []) this.register(workflowPackage);
  }

  register(workflowPackage: BuiltinWorkflowPackage): WorkflowVersion {
    if (
      !['OFFICIAL', 'TEST_ONLY'].includes(workflowPackage.kind) ||
      (workflowPackage.kind === 'TEST_ONLY' && !this.testOnly)
    )
      throw new DomainError(
        'INVALID_INPUT',
        'TEST_ONLY Builtin packages require explicit test mode',
      );
    const original = workflowPackage.version;
    const manifestHash = validateBuiltinWorkflowRelease(original, { requireManifestHash: false });
    const version: WorkflowVersion = {
      ...JSON.parse(JSON.stringify(original)),
      releaseMetadata: {
        ...JSON.parse(JSON.stringify(original.releaseMetadata)),
        manifestHash,
      },
    };
    validateBuiltinWorkflowRelease(version);
    const key = `${version.definition.id}\u0000${version.version}`;
    if (this.versions.has(key))
      throw new DomainError('CONFLICT', 'BUILTIN version already registered');
    const frozen = deepFreeze(version);
    this.versions.set(key, frozen);
    this.packages.set(key, deepFreeze({ kind: workflowPackage.kind, version: frozen }));
    return frozen;
  }

  get(definitionId: string, version: number): WorkflowVersion | null {
    return this.versions.get(`${definitionId}\u0000${version}`) ?? null;
  }

  getPackage(definitionId: string, version: number): BuiltinWorkflowPackage | null {
    return this.packages.get(`${definitionId}\u0000${version}`) ?? null;
  }

  list(): WorkflowVersion[] {
    return [...this.versions.values()];
  }
}
