import { DomainError } from '@cultivation/shared';
import type { ArtifactContract, WorkflowVersion } from '@cultivation/domain';
import { BuiltinWorkflowRegistry, validateBuiltinWorkflowRelease } from './w2-contracts.js';

export interface BuiltinReleaseFact {
  definitionId: string;
  version: number;
  manifestHash: string;
  releasedAt: string;
}

/** Trusted Main adapter must execute every operation on the same transaction/connection. */
export interface BuiltinWorkflowInstallationPort {
  transaction<T>(work: () => T): T;
  registerContract(contract: ArtifactContract): void;
  registerRelease(release: BuiltinReleaseFact): void;
  publishVersion(version: WorkflowVersion): void;
}

/** One install path for registry-verified immutable packages; intentionally has no IPC method. */
export class BuiltinWorkflowInstaller {
  constructor(
    private readonly registry: BuiltinWorkflowRegistry,
    private readonly persistence: BuiltinWorkflowInstallationPort,
    private readonly options: { testOnly?: boolean } = {},
  ) {}

  install(definitionId: string, versionNumber: number): WorkflowVersion {
    const workflowPackage = this.registry.getPackage(definitionId, versionNumber);
    if (!workflowPackage)
      throw new DomainError('NOT_FOUND', 'BUILTIN package is not in the trusted registry');
    if (workflowPackage.kind === 'TEST_ONLY' && this.options.testOnly !== true)
      throw new DomainError('INVALID_INPUT', 'TEST_ONLY install requires explicit test mode');
    const version = workflowPackage.version;
    const manifestHash = validateBuiltinWorkflowRelease(version);
    this.persistence.transaction(() => {
      for (const contract of version.contractManifest ?? [])
        this.persistence.registerContract(contract);
      this.persistence.registerRelease({
        definitionId: version.definition.id,
        version: version.version,
        manifestHash,
        releasedAt: version.createdAt,
      });
      this.persistence.publishVersion(version);
    });
    return version;
  }

  installAll(): WorkflowVersion[] {
    return this.registry
      .list()
      .map((version) => this.install(version.definition.id, version.version));
  }
}
