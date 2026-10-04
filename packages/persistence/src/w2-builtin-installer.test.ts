import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { WorkflowVersion } from '@cultivation/domain';
import {
  BuiltinWorkflowInstaller,
  BuiltinWorkflowRegistry,
  validateBuiltinWorkflowRelease,
} from '../../application/src/index.js';
import {
  createW2FixtureArtifactSpec,
  createW2FixtureContract,
  createW2FixtureStep,
  createW2FixtureVersion,
} from '../../application/src/testing/w2-workflow-harness.js';
import { migrations, runMigrations, W1WorkflowRepository, W2WorkflowRepository } from './index.js';
import {
  createBuiltinWorkflowInstaller,
  installOfficialBuiltinWorkflows,
  OFFICIAL_BUILTIN_WORKFLOW_PACKAGES,
} from '../../../apps/desktop/src/main/w2-builtin-installation.js';

/** Synthetic package for installer tests only; never part of the production catalog. */
function version(): WorkflowVersion {
  const contract = createW2FixtureContract();
  const value = createW2FixtureVersion({
    definitionId: 'test-official-installation',
    version: 1,
    contracts: [contract],
    steps: [createW2FixtureStep('task', { outputs: [createW2FixtureArtifactSpec(contract)] })],
    edges: [],
  });
  value.definition.source = 'BUILTIN';
  value.releaseMetadata = {
    referenceBasis: [
      {
        title: 'AP-007 installer test',
        adoptedPrinciples: ['Immutable version and atomic contract installation'],
        intentionallyExcludedMechanisms: ['Vendor execution and dynamic graph generation'],
        rationale: 'Exercise the official registration path without shipping an official template.',
      },
    ],
    contractManifest: [
      { contractId: contract.contractId, contractVersion: contract.contractVersion },
    ],
    revisionManifest: { groups: [], edges: [] },
    effectManifest: [{ stepId: 'task', effectType: 'NONE', paths: [] }],
    designRationale: 'Synthetic trusted installer fixture; not a W2.1 template.',
  };
  return value;
}

function database(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}
function installer(db: Database.Database, value = version()) {
  const registry = new BuiltinWorkflowRegistry({
    packages: [{ kind: 'OFFICIAL', version: value }],
  });
  const store = new W1WorkflowRepository(db);
  const foundation = new W2WorkflowRepository(db);
  return {
    registry,
    store,
    foundation,
    install: createBuiltinWorkflowInstaller(registry, store, foundation),
  };
}
function counts(db: Database.Database) {
  return [
    'workflow_artifact_contract_registry',
    'workflow_builtin_releases',
    'workflow_definitions',
    'workflow_versions',
    'workflow_steps',
  ].map((table) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
}

describe('W2 trusted Builtin installer', () => {
  it('installs contracts, release fact and frozen version through the single Main adapter', () => {
    const db = database();
    try {
      const { install, store, foundation } = installer(db);
      const frozen = install.install('test-official-installation', 1);
      expect(counts(db)).toEqual([1, 1, 1, 1, 1]);
      expect(store.getVersion(frozen.definition.id, 1)).toEqual(frozen);
      expect(foundation.getContract('test.output', '1')).toEqual(frozen.contractManifest![0]);
      expect(foundation.getRelease(frozen.definition.id, 1)?.manifestHash).toBe(
        validateBuiltinWorkflowRelease(frozen),
      );
    } finally {
      db.close();
    }
  });

  it.each(['workflow_builtin_releases', 'workflow_versions', 'workflow_steps'])(
    'rolls back all writes when %s insertion fails',
    (table) => {
      const db = database();
      try {
        db.exec(
          `CREATE TRIGGER inject_install_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture installation failure'); END`,
        );
        const { install } = installer(db);
        expect(() => install.installAll()).toThrow('fixture installation failure');
        expect(counts(db)).toEqual([0, 0, 0, 0, 0]);
        db.exec('DROP TRIGGER inject_install_failure');
        expect(install.installAll()).toHaveLength(1);
        expect(counts(db)).toEqual([1, 1, 1, 1, 1]);
      } finally {
        db.close();
      }
    },
  );

  it('rolls back earlier contracts on a later contract conflict', () => {
    const db = database();
    try {
      const initial = installer(db);
      initial.install.installAll();
      const changed = version();
      changed.definition.id = 'test-another-installation';
      const extra = {
        ...structuredClone(changed.contractManifest![0]!),
        contractId: 'test.additional',
      };
      changed.contractManifest!.unshift(extra);
      changed.steps[0]!.outputs.push({ ...createW2FixtureArtifactSpec(extra), key: 'extra' });
      changed.contractManifest![1] = {
        ...changed.contractManifest![1]!,
        maxSizeBytes: changed.contractManifest![1]!.maxSizeBytes + 1,
      };
      changed.steps[0]!.outputs[0]!.maxSizeBytes += 1;
      changed.releaseMetadata!.contractManifest.unshift({
        contractId: extra.contractId,
        contractVersion: extra.contractVersion,
      });
      const next = installer(db, changed);
      expect(() => next.install.installAll()).toThrow('immutable');
      expect(next.foundation.getContract('test.additional', '1')).toBeNull();
      expect(counts(db)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      db.close();
    }
  });

  it('reinstalls identical packages after a real database reopen without creating facts', () => {
    const root = join(process.cwd(), '.test-data');
    mkdirSync(root, { recursive: true });
    const path = join(root, `w2-install-${randomUUID()}.sqlite`);
    const first = database(path);
    let expected: WorkflowVersion;
    try {
      expected = installer(first).install.install('test-official-installation', 1);
    } finally {
      first.close();
    }
    const reopened = database(path);
    try {
      const next = installer(reopened);
      expect(next.install.install('test-official-installation', 1)).toEqual(expected);
      expect(next.store.getVersion(expected.definition.id, 1)).toEqual(expected);
      expect(counts(reopened)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      reopened.close();
    }
  }, 60_000);

  it('fails closed on a changed release/version and leaves the installed version intact', () => {
    const db = database();
    try {
      const first = installer(db);
      const original = first.install.install('test-official-installation', 1);
      const changed = version();
      changed.steps[0]!.objective = 'Changed same-version objective';
      expect(() => installer(db, changed).install.installAll()).toThrow('immutable');
      expect(first.store.getVersion(original.definition.id, 1)).toEqual(original);
      expect(counts(db)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      db.close();
    }
  });

  it('requires explicit test mode at both registry and installer boundaries', () => {
    const db = database();
    try {
      const registry = new BuiltinWorkflowRegistry({
        testOnly: true,
        packages: [{ kind: 'TEST_ONLY', version: version() }],
      });
      const store = new W1WorkflowRepository(db);
      const foundation = new W2WorkflowRepository(db);
      expect(() =>
        createBuiltinWorkflowInstaller(registry, store, foundation).installAll(),
      ).toThrow('explicit test mode');
      expect(counts(db)).toEqual([0, 0, 0, 0, 0]);
      createBuiltinWorkflowInstaller(registry, store, foundation, { testOnly: true }).installAll();
      expect(counts(db)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      db.close();
    }
  });

  it('never accepts arbitrary USER/IMPORTED versions or unregistered identities', () => {
    const registry = new BuiltinWorkflowRegistry();
    let writes = 0;
    const install = new BuiltinWorkflowInstaller(registry, {
      transaction: (work) => work(),
      registerContract: () => {
        writes += 1;
      },
      registerRelease: () => {
        writes += 1;
      },
      publishVersion: () => {
        writes += 1;
      },
    });
    for (const source of ['USER', 'IMPORTED'] as const) {
      const value = version();
      value.definition.source = source;
      expect(() => registry.register({ kind: 'OFFICIAL', version: value })).toThrow();
    }
    expect(() => install.install('arbitrary-user', 1)).toThrow('trusted registry');
    expect(writes).toBe(0);
  });

  it('installs only the static official packages in production, idempotently', () => {
    const db = database();
    try {
      expect(OFFICIAL_BUILTIN_WORKFLOW_PACKAGES).toHaveLength(3);
      expect(OFFICIAL_BUILTIN_WORKFLOW_PACKAGES[0]!.version.definition.id).toBe(
        'official.ai-news-video',
      );
      expect(Object.isFrozen(OFFICIAL_BUILTIN_WORKFLOW_PACKAGES)).toBe(true);
      installOfficialBuiltinWorkflows(new W1WorkflowRepository(db), new W2WorkflowRepository(db));
      expect(new W1WorkflowRepository(db).listVersions().map((item) => item.definition.id)).toEqual(
        ['official.ai-news-video', 'official.research', 'official.software-feature'],
      );
      const first = counts(db);
      installOfficialBuiltinWorkflows(new W1WorkflowRepository(db), new W2WorkflowRepository(db));
      expect(counts(db)).toEqual(first);
    } finally {
      db.close();
    }
  });
});
