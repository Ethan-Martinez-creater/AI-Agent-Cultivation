import {
  BuiltinWorkflowInstaller,
  BuiltinWorkflowRegistry,
  type OfficialBuiltinWorkflowPackage,
} from '@cultivation/application';
import type { W1WorkflowRepository, W2WorkflowRepository } from '@cultivation/persistence';

import { AI_NEWS_VIDEO_PACKAGE } from '../../../../packages/application/src/builtin/ai-news-video/v1.js';

/** Static application-owned official packages; no Renderer registration path. */
export const OFFICIAL_BUILTIN_WORKFLOW_PACKAGES: readonly OfficialBuiltinWorkflowPackage[] =
  Object.freeze([AI_NEWS_VIDEO_PACKAGE]);

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
