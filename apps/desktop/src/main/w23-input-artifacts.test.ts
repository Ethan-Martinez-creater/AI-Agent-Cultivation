import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  migrations,
  runMigrations,
  ResearchInputArtifactRepository,
  ResearchSourceRepository,
  Gate3SqliteRepository,
} from '@cultivation/persistence';
import { ToolRegistry, ToolRuntime } from '@cultivation/application/tool-runtime';
import { PermissionEngine } from '@cultivation/application/permission-engine';
import { ResearchInputArtifactService } from './w23-input-artifacts.js';
import { FileWorkspace } from './file-workspace.js';
import { registerBuiltins } from './gate4-builtins.js';
import { RESEARCH_VERSION_1 } from '../../../../packages/application/src/builtin/research/v1.js';
import { WorkflowService, WorkflowValidationPolicyRegistry } from '@cultivation/application';
import type { WorkflowMissionPort } from '@cultivation/application';
import { W1WorkflowRepository, W2WorkflowRepository } from '@cultivation/persistence';
import { installOfficialBuiltinWorkflows } from './w2-builtin-installation.js';
import { researchWorkflowValidationPolicy } from './w23-validation-policy.js';

async function fixture(deny = false) {
  const parent = path.join(process.cwd(), '.test-data', 'w23-input-unit');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'input-'));
  const file = path.join(root, 'dataset.csv');
  writeFileSync(file, 'x,y\n1,2\n', 'utf8');
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  runMigrations(db, migrations);
  const registry = new ToolRegistry();
  registerBuiltins(registry, await FileWorkspace.open(root));
  const checks: unknown[] = [];
  const rules = {
    listPermissionRules: (type: string, id: string, capability: string) => {
      checks.push({ type, id, capability });
      return deny
        ? [
            {
              id: 'deny',
              subjectType: 'USER' as const,
              subjectId: 'local-user',
              capability: 'FILE_READ' as const,
              scope: 'GLOBAL' as const,
              scopeId: null,
              resourcePattern: '*',
              decision: 'DENY' as const,
              createdAt: 'now',
            },
          ]
        : [];
    },
    savePermissionRule: () => {
      throw new Error('Import must not create grants');
    },
  };
  const runtime = new ToolRuntime(registry, new PermissionEngine(rules));
  const repository = new ResearchInputArtifactRepository(db);
  const audit = new Gate3SqliteRepository(db);
  const workflows = new W1WorkflowRepository(db);
  const service = new ResearchInputArtifactService(
    repository,
    new ResearchSourceRepository(db),
    workflows,
    runtime,
    () => root,
    (fact) => audit.appendAuditEvent(fact),
    (fn) => db.transaction(fn)(),
  );
  return { db, service, repository, root, file, checks, runtime, workflows };
}
describe('trusted research input Artifact provenance', () => {
  it('commits trusted input lineage with a frozen Run and restores exactly the same snapshot', async () => {
    const h = await fixture();
    try {
      const foundation = new W2WorkflowRepository(h.db);
      installOfficialBuiltinWorkflows(h.workflows, foundation);
      const policies = new WorkflowValidationPolicyRegistry();
      policies.register(
        'research-integrity-v1',
        researchWorkflowValidationPolicy({
          listSourceArtifactsForRun: () => [],
          listExperimentFactsForStep: () => [],
          validateInputReferences: (version, inputs) => h.service.validateInputs(version, inputs),
          bindInputReferences: (run) => h.service.bindRun(run),
        }),
      );
      const missions = {} as WorkflowMissionPort;
      const service = new WorkflowService(h.workflows, missions, undefined, foundation, policies);
      const ref = (await h.service.importFile('DATA', h.file, async () => true))!;
      const inputs = {
        researchQuestion: '对已有数据的数值分布进行描述性研究',
        field: '数据分析',
        scope: '仅分析给定样本',
        experimentMode: 'COMPUTATIONAL',
        maxExperimentCycles: 2,
        existingData: [{ ...ref, name: 'forged-path' }],
      };
      const run = service.createRun({ definitionId: 'official.research', version: 1, inputs });
      expect(run.run.inputSnapshot?.existingData).toEqual([{ ...ref }]);
      expect(
        h.db
          .prepare(
            'SELECT artifact_id,content_hash FROM workflow_research_input_bindings WHERE workflow_run_id=?',
          )
          .get(run.run.id),
      ).toEqual({ artifact_id: ref.id, content_hash: ref.contentHash });
      inputs.existingData[0]!.name = 'mutated';
      const restarted = new WorkflowService(h.workflows, missions, undefined, foundation, policies);
      expect(restarted.detail(run.run.id).run.inputSnapshot).toEqual(run.run.inputSnapshot);
      expect(() =>
        h.db
          .prepare("UPDATE workflow_runs SET input_snapshot_json='{}' WHERE id=?")
          .run(run.run.id),
      ).toThrow(/immutable/i);
      expect(() =>
        service.createRun({
          definitionId: 'official.research',
          version: 1,
          inputs: { ...inputs, existingData: [{ ...ref, id: 'missing' }] },
        }),
      ).toThrow();
      expect(h.workflows.listRuns()).toHaveLength(1);
      const step = {
        ...run.steps[0]!,
        id: 'r08-step',
        stepId: 'R08',
        state: 'RUNNING' as const,
        missionId: 'experiment-mission',
        missionRunId: 'experiment-run',
      };
      const experiment = {
        workflowRunId: run.run.id,
        stepRunId: step.id,
        missionId: step.missionId,
        missionRunId: step.missionRunId,
        inputArtifacts: [{ id: ref.id, kind: ref.kind, contentHash: ref.contentHash }],
      } as import('./w23-validation-policy.js').ResearchExperimentFact;
      expect(() => h.service.validateExperimentInputs(run, step, experiment)).not.toThrow();
      const otherRef = (await h.service.importFile('DATA', h.file, async () => true))!;
      const otherRun = service.createRun({
        definitionId: 'official.research',
        version: 1,
        inputs: { ...inputs, existingData: [{ ...otherRef }] },
      });
      expect(otherRun.run.id).not.toBe(run.run.id);
      expect(() =>
        h.service.validateExperimentInputs(run, step, {
          ...experiment,
          inputArtifacts: [
            { id: otherRef.id, kind: otherRef.kind, contentHash: otherRef.contentHash },
          ],
        }),
      ).toThrow();
      for (const inputArtifacts of [
        undefined,
        [],
        [{ ...ref, id: 'other-run-input' }],
        [{ ...ref, kind: 'JSON' }],
        [{ ...ref, contentHash: 'a'.repeat(64) }],
      ]) {
        expect(() =>
          h.service.validateExperimentInputs(run, step, { ...experiment, inputArtifacts }),
        ).toThrow();
      }
      expect(() =>
        h.service.validateExperimentInputs(run, step, {
          ...experiment,
          workflowRunId: 'other-run',
        }),
      ).toThrow();
      const unchanged = restarted.detail(run.run.id);
      expect(() => h.service.validateExperimentInputs(unchanged, step, experiment)).not.toThrow();
      const bytes = 'x,y\n1,2\n';
      writeFileSync(h.file, 'changed-after-run', 'utf8');
      expect(() => h.service.validateExperimentInputs(run, step, experiment)).toThrow();
      // Already validated historical attempts are not re-executed/reinterpreted from current files.
      expect(() =>
        h.service.validateExperimentInputs(run, { ...step, state: 'COMPLETED' }, experiment),
      ).not.toThrow();
      unlinkSync(h.file);
      expect(() => h.service.validateExperimentInputs(run, step, experiment)).toThrow();
      writeFileSync(h.file, bytes, 'utf8');
      expect(() => h.service.validateExperimentInputs(run, step, experiment)).not.toThrow();
      expect(h.db.prepare('SELECT COUNT(*) n FROM permission_rules').get()).toEqual({ n: 0 });
    } finally {
      h.db.close();
    }
  });
  it('imports actual Tool-read bytes and returns a stable Main-owned ref; name has no authority', async () => {
    const h = await fixture();
    try {
      const ref = await h.service.importFile('DATA', h.file, async () => true);
      expect(ref).toMatchObject({ kind: 'FILE', name: 'dataset.csv' });
      expect(ref!.contentHash).toMatch(/^[a-f0-9]{64}$/);
      const inputs = { existingData: [{ ...ref!, name: 'C:\\secret.txt' }] };
      h.service.validateInputs(RESEARCH_VERSION_1, inputs);
      expect(inputs.existingData[0]!.name).toBe('dataset.csv');
      expect(h.repository.get(ref!.id)!.content).toBe('x,y\n1,2\n');
      expect(h.checks).toContainEqual({ type: 'USER', id: 'local-user', capability: 'FILE_READ' });
      expect(h.db.prepare('SELECT COUNT(*) n FROM permission_rules').get()).toEqual({ n: 0 });
      expect(() =>
        h.db
          .prepare('UPDATE workflow_input_artifacts SET display_name=? WHERE id=?')
          .run('changed', ref!.id),
      ).toThrow(/immutable/);
      expect(() =>
        h.db.prepare('DELETE FROM workflow_input_artifacts WHERE id=?').run(ref!.id),
      ).toThrow(/immutable/);
    } finally {
      h.db.close();
    }
  });
  it.each(['id', 'kind', 'contentHash'] as const)(
    'rejects spoofed %s before Run creation',
    async (field) => {
      const h = await fixture();
      try {
        const ref = (await h.service.importFile('DATA', h.file, async () => true))!;
        expect(() =>
          h.service.validateInputs(RESEARCH_VERSION_1, {
            existingData: [{ ...ref, [field]: field === 'kind' ? 'JSON' : 'nonexistent' }],
          }),
        ).toThrow(/资料引用/);
      } finally {
        h.db.close();
      }
    },
  );
  it('rejects missing sources, missing data and wrong input category', async () => {
    const h = await fixture();
    try {
      expect(() =>
        h.service.validateInputs(RESEARCH_VERSION_1, {
          existingSources: [
            { id: 'source-unknown', kind: 'EXTERNAL_REFERENCE', contentHash: 'a'.repeat(64) },
          ],
        }),
      ).toThrow();
      const ref = (await h.service.importFile('DATA', h.file, async () => true))!;
      expect(() =>
        h.service.validateInputs(RESEARCH_VERSION_1, { existingCode: [{ ...ref }] }),
      ).toThrow();
    } finally {
      h.db.close();
    }
  });
  it('rejects files changed or missing between import and create', async () => {
    const h = await fixture();
    try {
      const ref = (await h.service.importFile('DATA', h.file, async () => true))!;
      writeFileSync(h.file, 'changed', 'utf8');
      expect(() =>
        h.service.validateInputs(RESEARCH_VERSION_1, { existingData: [{ ...ref }] }),
      ).toThrow();
      unlinkSync(h.file);
      expect(() =>
        h.service.validateInputs(RESEARCH_VERSION_1, { existingData: [{ ...ref }] }),
      ).toThrow();
    } finally {
      h.db.close();
    }
  });
  it('native user cancellation imports nothing', async () => {
    const h = await fixture();
    try {
      expect(await h.service.importFile('DATA', h.file, async () => false)).toBeNull();
      expect(h.repository.list('DATA')).toEqual([]);
      expect(h.checks).toEqual([]);
    } finally {
      h.db.close();
    }
  });
  it('explicit DENY wins over import confirmation and records no Artifact', async () => {
    const h = await fixture(true);
    try {
      await expect(h.service.importFile('DATA', h.file, async () => true)).rejects.toThrow();
      expect(h.repository.list('DATA')).toEqual([]);
    } finally {
      h.db.close();
    }
  });
  it('ToolRuntime user-read entry cannot write or invoke an MCP tool', async () => {
    const h = await fixture();
    try {
      await expect(
        h.runtime.dispatchUserRead(
          { id: 'write', toolId: 'file.writeText', input: { path: 'dataset.csv', content: 'bad' } },
          'local-user',
          true,
        ),
      ).rejects.toThrow(/restricted/);
    } finally {
      h.db.close();
    }
  });
  it('rejects files outside the selected Workspace', async () => {
    const h = await fixture();
    try {
      await expect(
        h.service.importFile('DATA', path.join(h.root, '..', 'outside.csv'), async () => true),
      ).rejects.toThrow();
      expect(h.repository.list('DATA')).toEqual([]);
    } finally {
      h.db.close();
    }
  });
});
