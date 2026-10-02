import {
  BuiltinWorkflowInstaller,
  BuiltinWorkflowRegistry,
  type OfficialBuiltinWorkflowPackage,
} from '@cultivation/application';
import type { W1WorkflowRepository, W2WorkflowRepository } from '@cultivation/persistence';

/** Static application-owned packages only. No official templates ship in W2.0. */
export const OFFICIAL_BUILTIN_WORKFLOW_PACKAGES: readonly OfficialBuiltinWorkflowPackage[] =
  Object.freeze([]);

export function createBuiltinWorkflowInstaller(
  registry: BuiltinWorkflowRegistry,
  store: W1WorkflowRepository,
  foundation: W2WorkflowRepository,
  options: { testOnly?: boolean } = {},
): BuiltinWorkflowInstaller {
  // Main constructs both repositories from the same SQLite connection.
  return new BuiltinWorkflowInstaller(
    registry,
    {
      transaction: (work) => store.transaction(work),
      registerContract: (contract) => {
        foundation.registerContract(contract);
      },
      registerRelease: (release) => {
        foundation.registerRelease(release);
      },
      publishVersion: (version) => store.publishVersion(version),
    },
    options,
  );
}

export function installOfficialBuiltinWorkflows(
  store: W1WorkflowRepository,
  foundation: W2WorkflowRepository,
): void {
  const registry = new BuiltinWorkflowRegistry({ packages: OFFICIAL_BUILTIN_WORKFLOW_PACKAGES });
  createBuiltinWorkflowInstaller(registry, store, foundation).installAll();
}
