import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { WorkflowInputs } from '@cultivation/domain';
import { validateWorkflowInputs } from '@cultivation/domain';
import {
  validateBuiltinWorkflowRelease,
  validateWorkflowReviewResult,
} from '../../application/src/w2-contracts.js';
import {
  installOfficialBuiltinWorkflows,
  OFFICIAL_BUILTIN_WORKFLOW_PACKAGES,
} from '../../../apps/desktop/src/main/w2-builtin-installation.js';
import { migrations, runMigrations, W1WorkflowRepository, W2WorkflowRepository } from './index.js';

const inputs: Record<string, WorkflowInputs> = {
  'official.ai-news-video': {
    topicScope: '人工智能周报',
    timeRange: { from: '2026-09-01', to: '2026-10-01' },
    language: 'zh-CN',
    targetPlatform: 'GENERIC',
    targetDurationSeconds: 60,
    targetStoryCount: { min: 1, max: 1 },
    narrationMode: 'AUTO',
  },
  'official.software-feature': {
    objective: '修复显示问题',
    workspaceRoot: 'E:/workspace',
    targetArea: ['src'],
    allowedToolScope: ['file.readText'],
  },
  'official.research': {
    researchQuestion: '检索结果是否可复现？',
    field: '信息检索',
    experimentMode: 'COMPUTATIONAL',
    maxExperimentCycles: 2,
  },
};
const now = '2026-10-04T00:00:00.000Z';
function open(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const store = new W1WorkflowRepository(db);
  const foundation = new W2WorkflowRepository(db);
  installOfficialBuiltinWorkflows(store, foundation);
  return { db, store, foundation };
}

describe('W2.4 unified OFFICIAL release invariants', () => {
  it.each(OFFICIAL_BUILTIN_WORKFLOW_PACKAGES)(
    '$version.definition.id freezes release, Contracts and input snapshot through real reopen',
    ({ version }) => {
      const directory = join(process.cwd(), '.test-data', 'w24-unit');
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}.sqlite`);
      const first = open(path);
      const runId = randomUUID();
      const snapshot = structuredClone(inputs[version.definition.id]!);
      first.store.insertRun({
        id: runId,
        definitionId: version.definition.id,
        definitionVersion: 1,
        state: 'DRAFT',
        waitReason: null,
        inputSnapshot: snapshot,
        createdAt: now,
        updatedAt: now,
      });
      const expected = first.store.detail(runId)!;
      const hash = validateBuiltinWorkflowRelease(version);
      expect(first.foundation.getRelease(version.definition.id, 1)?.manifestHash).toBe(hash);
      expect(() =>
        first.db.prepare("UPDATE workflow_runs SET input_snapshot_json='{}' WHERE id=?").run(runId),
      ).toThrow();
      expect(() =>
        first.db
          .prepare("UPDATE workflow_versions SET version_json='{}' WHERE definition_id=?")
          .run(version.definition.id),
      ).toThrow();
      expect(() =>
        first.db
          .prepare('DELETE FROM workflow_versions WHERE definition_id=?')
          .run(version.definition.id),
      ).toThrow();
      for (const contract of version.contractManifest!) {
        expect(first.foundation.getContract(contract.contractId, contract.contractVersion)).toEqual(
          contract,
        );
        expect(() =>
          first.db
            .prepare(
              'UPDATE workflow_artifact_contract_registry SET contract_json=? WHERE contract_id=?',
            )
            .run('{}', contract.contractId),
        ).toThrow();
      }
      first.db.close();
      const reopened = open(path);
      expect(reopened.store.detail(runId)).toEqual(expected);
      expect(reopened.foundation.getRelease(version.definition.id, 1)?.manifestHash).toBe(hash);
      expect(
        reopened.db.prepare('SELECT COUNT(*) AS n FROM workflow_builtin_releases').get(),
      ).toEqual({ n: 3 });
      reopened.db.close();
    },
    60_000,
  );

  it.each(OFFICIAL_BUILTIN_WORKFLOW_PACKAGES)(
    '$version.definition.id rejects unknown inputs and undeclared REVIEW revision targets',
    ({ version }) => {
      expect(() =>
        validateWorkflowInputs(version.inputSchema!, {
          ...inputs[version.definition.id],
          injectedAuthority: 'FILE_READ',
        }),
      ).toThrow();
      const review = version.steps.find((step) => step.type === 'REVIEW')!;
      expect(() =>
        validateWorkflowReviewResult(
          {
            verdict: 'REVISE',
            findings: ['需要修订'],
            evidence: ['核验依据'],
            summary: '修订意见',
            reviewedArtifactIds: ['artifact'],
            revisionCode: 'undeclared-jump',
          },
          version,
          review.id,
        ),
      ).toThrow();
      const changed = structuredClone(version);
      changed.steps[0]!.objective += ' changed';
      expect(() => validateBuiltinWorkflowRelease(changed)).toThrow();
    },
  );

  it.each(OFFICIAL_BUILTIN_WORKFLOW_PACKAGES)(
    '$version.definition.id declares bounded groups, closed edges and required final producer Contracts',
    ({ version }) => {
      const groups = new Map(version.revisionGroups!.map((group) => [group.id, group]));
      for (const edge of version.edges.filter((edge) => edge.revision)) {
        expect(groups.has(edge.revision!.groupId)).toBe(true);
        expect(edge.revision!.maxTraversals).toBeGreaterThan(0);
        expect(edge.revision!.maxTraversals).toBeLessThanOrEqual(
          groups.get(edge.revision!.groupId)!.maxTotalTraversals,
        );
      }
      for (const final of version.outputSchema!.outputs) {
        const producer = version.steps
          .find((step) => step.id === final.fromStepId)!
          .outputs.find((output) => output.key === final.outputKey)!;
        expect([final.kind, final.contractId, final.contractVersion, final.validator]).toEqual([
          producer.kind,
          producer.contractId,
          producer.contractVersion,
          producer.validator,
        ]);
        if (final.required) expect(producer.required).toBe(true);
      }
    },
  );
});
