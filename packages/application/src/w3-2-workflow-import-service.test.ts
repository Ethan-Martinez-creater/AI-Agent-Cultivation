import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  compileUserWorkflowVersion,
  type WorkflowDraft,
  type WorkflowDraftContent,
  type WorkflowImportSource,
} from '@cultivation/domain';
import {
  migrations,
  runMigrations,
  W1WorkflowRepository,
  W2WorkflowRepository,
  W31WorkflowDraftRepository,
  W32WorkflowImportRepository,
} from '@cultivation/persistence';
import { WorkflowService } from './w1-workflow-service.js';
import { WorkflowEditorService } from './w3-1-workflow-editor-service.js';
import { WorkflowImportService } from './w3-2-workflow-import-service.js';
import type { WorkflowMissionPort } from './w1-workflow-ports.js';

function setup(review = false) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  const workflows = new W1WorkflowRepository(db);
  const foundation = new W2WorkflowRepository(db);
  const engine = new WorkflowService(workflows, {} as WorkflowMissionPort, undefined, foundation);
  const editor = new WorkflowEditorService(new W31WorkflowDraftRepository(db), workflows, engine);
  const draft = editor.createDraft({ name: '已有成果续办' });
  const template = draft.content.steps[0]!;
  const content: WorkflowDraftContent = {
    ...draft.content,
    entryStepId: 'first',
    steps: ['first', 'second', 'last'].map((id, index) => ({
      ...structuredClone(template),
      id,
      title: `步骤${index + 1}`,
      objective: '处理声明输入并交付结果',
      inputs: index
        ? [
            {
              key: 'input',
              fromStepId: index === 1 ? 'first' : 'second',
              outputKey: index === 1 ? 'first' : 'second',
              required: true,
            },
          ]
        : [],
      outputs: [{ ...template.outputs[0]!, key: id }],
    })),
    finalOutputs: [
      {
        key: 'result',
        fromStepId: 'last',
        outputKey: 'last',
        required: true,
        description: '最终成果',
      },
    ],
    edges: ['first', 'second', 'last'].map((id, index) => ({
      id: `${id}-next`,
      fromStepId: id,
      toStepId: index === 2 ? null : index === 0 ? 'second' : 'last',
      branch: 'NEXT',
      condition: { type: 'ALWAYS' as const },
    })),
  };
  if (review) {
    content.steps[1] = {
      ...content.steps[1]!,
      type: 'REVIEW',
      exitCondition: 'REVIEW_PASS',
      outputs: [
        {
          ...template.outputs[0]!,
          key: 'second',
          kind: 'JSON',
          validator: {
            type: 'JSON',
            requiredKeys: ['verdict', 'findings', 'evidence', 'summary', 'reviewedArtifactIds'],
          },
        },
      ],
    };
    content.edges[1]!.condition = { type: 'REVIEW_VERDICT', verdict: 'PASS' };
  }
  const saved = editor.saveDraft({ id: draft.id, expectedRevision: draft.revision, content });
  const version = editor.publishDraft({ id: saved.id, expectedRevision: saved.revision });
  const repository = new W32WorkflowImportRepository(db);
  const recheck = vi.fn();
  const imports = new WorkflowImportService(repository, workflows, engine, { recheck });
  const prepare = () => imports.prepare({ definitionId: version.definition.id, version: 1 });
  return {
    db,
    workflows,
    engine,
    editor,
    version,
    repository,
    imports,
    prepare,
    recheck,
    originalDraft: saved,
  };
}
function source(
  name: string,
  content = '已有成果',
  kind: 'TEXT' | 'JSON' = 'TEXT',
): WorkflowImportSource {
  return {
    id: randomUUID(),
    name,
    content,
    kind,
    size: Buffer.byteLength(content),
    contentHash: createHash('sha256').update(content).digest('hex'),
    relativePath: name,
    workspaceRoot: 'E:\\sample',
    mtime: 1,
  };
}

describe('W3.2 offline state resolution and explicit confirmation', () => {
  it('confirmed import facts remain append-only and cannot be repackaged as execution provenance', () => {
    const f = setup();
    try {
      let p = f.imports.addSource(f.prepare().id, source('first.txt'));
      p = f.imports.addSource(p.id, source('second.txt'));
      const detail = f.imports.confirm({ proposalId: p.id, revision: p.revision });
      const first = detail.artifacts.find((a) => a.inputArtifactIds.length === 0)!;
      const tables: Array<[string, string]> = [
        ['workflow_import_confirmations', detail.importConfirmation!.id],
        ['workflow_import_artifacts', first.id],
        ['workflow_import_artifact_bindings', detail.bindings[0]!.id],
        ['workflow_import_validations', detail.validations[0]!.id],
      ];
      for (const [table, id] of tables) {
        expect(() => f.db.prepare(`UPDATE ${table} SET id = id WHERE id = ?`).run(id)).toThrow();
        expect(() => f.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)).toThrow();
      }
      const dependent = detail.artifacts.find((a) => a.inputArtifactIds.length > 0)!;
      expect(() =>
        f.db
          .prepare('DELETE FROM workflow_import_artifact_inputs WHERE artifact_id = ?')
          .run(dependent.id),
      ).toThrow();
      expect(() =>
        f.db
          .prepare(
            'UPDATE workflow_import_proposals SET revision = revision + 1, description = ? WHERE id = ?',
          )
          .run('rewritten', p.id),
      ).toThrow();
      expect(() => f.workflows.appendArtifact(first)).toThrow('Import repository');
      expect(f.workflows.verifyImportedArtifact({ ...first, actorId: 'invented-actor' })).toBe(
        false,
      );
      expect(f.workflows.verifyImportedArtifact({ ...first, sourceId: 'invented-source' })).toBe(
        false,
      );
      expect(f.workflows.verifyImportedArtifact({ ...first, contentHash: 'a'.repeat(64) })).toBe(
        false,
      );
      expect(f.workflows.verifyImportedArtifact(first)).toBe(true);
      expect(f.workflows.detail(detail.run.id)!.artifacts).toHaveLength(2);
      expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      f.db.close();
    }
  });
  it('a second opaque ID for the same canonical source cannot impersonate another step output', () => {
    const f = setup();
    try {
      const first = source('first.txt');
      const p = f.imports.addSource(f.prepare().id, first);
      expect(() => f.imports.addSource(p.id, { ...first, id: randomUUID() })).toThrow('重复');
      expect(f.workflows.listRuns()).toHaveLength(0);
    } finally {
      f.db.close();
    }
  });
  it('only proposes before confirmation, then imports two steps with null execution provenance and leaves the third READY', () => {
    const f = setup();
    try {
      let proposal = f.prepare();
      proposal = f.imports.addSource(proposal.id, source('first.txt'));
      proposal = f.imports.addSource(proposal.id, source('second.txt'));
      expect(proposal.resolution.suggestedCompletedSteps).toEqual(['first', 'second']);
      expect(proposal.validationStatus).toBe('VALID');
      expect(f.workflows.listRuns()).toEqual([]);
      const detail = f.imports.confirm({ proposalId: proposal.id, revision: proposal.revision });
      expect(
        ['first', 'second', 'last'].map((id) => {
          const s = detail.steps.find((step) => step.stepId === id)!;
          return [s.stepId, s.state, s.completionOrigin];
        }),
      ).toEqual([
        ['first', 'COMPLETED', 'IMPORTED_CONFIRMED'],
        ['second', 'COMPLETED', 'IMPORTED_CONFIRMED'],
        ['last', 'READY', 'EXECUTED'],
      ]);
      expect(detail.artifacts).toHaveLength(2);
      expect(
        detail.artifacts.every(
          (a) =>
            a.missionId === null &&
            a.missionRunId === null &&
            a.actorId === null &&
            a.source === 'IMPORTED_CONFIRMED',
        ),
      ).toBe(true);
      const firstArtifact = detail.artifacts.find(
        (a) => a.producerStepRunId === detail.steps.find((s) => s.stepId === 'first')!.id,
      )!;
      const secondArtifact = detail.artifacts.find(
        (a) => a.producerStepRunId === detail.steps.find((s) => s.stepId === 'second')!.id,
      )!;
      expect(secondArtifact.inputArtifactIds).toEqual([firstArtifact.id]);
      for (const table of [
        'missions',
        'mission_runs',
        'usage_records',
        'experience_events',
        'workflow_step_operation_receipts',
      ])
        expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(f.workflows.verifyImportedArtifact(detail.artifacts[0]!)).toBe(true);
      expect(f.recheck).toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('repeated confirm after service recreation returns one Run and no duplicate Artifact/checkpoint', () => {
    const f = setup();
    try {
      const p = f.imports.addSource(f.prepare().id, source('first.txt'));
      const first = f.imports.confirm({ proposalId: p.id, revision: p.revision });
      const restarted = new WorkflowImportService(
        new W32WorkflowImportRepository(f.db),
        f.workflows,
        f.engine,
        { recheck: f.recheck },
      );
      const second = restarted.confirm({ proposalId: p.id, revision: p.revision });
      expect(second.run.id).toBe(first.run.id);
      expect(second.artifacts).toEqual(first.artifacts);
      expect(second.checkpoints).toEqual(first.checkpoints);
      expect(f.workflows.listRuns()).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  it('cancel creates no formal Run, Mission, binding or usage and cannot later confirm', () => {
    const f = setup();
    try {
      const p = f.imports.addSource(f.prepare().id, source('first.txt'));
      f.imports.cancel({ proposalId: p.id, revision: p.revision });
      expect(() => f.imports.confirm({ proposalId: p.id, revision: p.revision })).toThrow();
      expect(f.workflows.listRuns()).toHaveLength(0);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM workflow_import_artifacts').get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.close();
    }
  });
  it('rejects non-contiguous jumps, unknown output mappings and weaker/missing required output evidence', () => {
    const f = setup();
    try {
      const p = f.imports.addSource(f.prepare().id, source('first.txt'));
      const invalid = f.imports.revise({
        proposalId: p.id,
        revision: p.revision,
        completedStepIds: ['second'],
        currentStepId: 'last',
        bindings: [{ stepId: 'second', outputKey: 'missing', sourceId: p.sources[0]!.id }],
      });
      expect(invalid.validationStatus).toBe('INVALID');
      expect(() =>
        f.imports.confirm({ proposalId: invalid.id, revision: invalid.revision }),
      ).toThrow();
      expect(f.workflows.listRuns()).toHaveLength(0);
    } finally {
      f.db.close();
    }
  });
  it('never accepts a source with wrong byte hash, size, kind or invalid JSON', () => {
    const f = setup();
    try {
      for (const bad of [
        { ...source('x.txt'), size: 4 },
        { ...source('x.txt'), contentHash: 'a'.repeat(64) },
        source('x.json', '{', 'JSON'),
      ])
        expect(() => f.imports.addSource(f.prepare().id, bad)).toThrow();
      const p = f.imports.addSource(f.prepare().id, source('x.json', '{"ok":true}', 'JSON'));
      const invalid = f.imports.revise({
        proposalId: p.id,
        revision: p.revision,
        completedStepIds: ['first'],
        currentStepId: 'second',
        bindings: [{ stepId: 'first', outputKey: 'first', sourceId: p.sources[0]!.id }],
      });
      expect(invalid.validationErrors.some((e) => e.includes('类型'))).toBe(true);
      expect(() =>
        f.imports.confirm({ proposalId: invalid.id, revision: invalid.revision }),
      ).toThrow();
    } finally {
      f.db.close();
    }
  });
  it('does not infer REVIEW completion from draft content or a claimed PASS; the review is the safe continuation', () => {
    const f = setup(true);
    try {
      let p = f.imports.addSource(f.prepare().id, source('first.txt'));
      expect(p.resolution.suggestedCurrentStep).toBe('second');
      expect(p.validationStatus).toBe('VALID');
      const review = source(
        'second.json',
        JSON.stringify({
          verdict: 'PASS',
          findings: [],
          evidence: [],
          summary: '外部声称通过',
          reviewedArtifactIds: [],
        }),
        'JSON',
      );
      p = f.imports.addSource(p.id, review);
      const invalid = f.imports.revise({
        proposalId: p.id,
        revision: p.revision,
        completedStepIds: ['first', 'second'],
        currentStepId: 'last',
        bindings: [
          { stepId: 'first', outputKey: 'first', sourceId: p.sources[0]!.id },
          { stepId: 'second', outputKey: 'second', sourceId: review.id },
        ],
      });
      expect(invalid.validationStatus).toBe('INVALID');
      expect(f.workflows.listRuns()).toHaveLength(0);
    } finally {
      f.db.close();
    }
  });
  it('source change before commit fails with zero formal facts', () => {
    const f = setup();
    try {
      const p = f.imports.addSource(f.prepare().id, source('first.txt'));
      f.recheck.mockImplementation(() => {
        throw new Error('FILE_CHANGED');
      });
      expect(() => f.imports.confirm({ proposalId: p.id, revision: p.revision })).toThrow();
      expect(f.workflows.listRuns()).toHaveLength(0);
      expect(f.repository.getConfirmationByProposal(p.id)).toBeNull();
    } finally {
      f.db.close();
    }
  });
  it('a failure halfway through the confirmation rolls back Run, steps, confirmation, artifacts and committed proposal', () => {
    const f = setup();
    try {
      const p = f.imports.addSource(f.prepare().id, source('first.txt'));
      vi.spyOn(f.repository, 'appendImportedValidation').mockImplementation(() => {
        throw new Error('SIMULATED_COMMIT_CRASH');
      });
      expect(() => f.imports.confirm({ proposalId: p.id, revision: p.revision })).toThrow();
      expect(f.workflows.listRuns()).toHaveLength(0);
      expect(f.repository.getConfirmationByProposal(p.id)).toBeNull();
      expect(f.imports.get(p.id).status).toBe('VALIDATED');
    } finally {
      f.db.close();
    }
  });
  it('a v1 proposal remains bound to v1 after a distinct v2 is published', () => {
    const f = setup();
    try {
      const p = f.imports.addSource(f.prepare().id, source('first.txt'));
      const nextDraft: WorkflowDraft = {
        ...f.originalDraft,
        content: { ...f.originalDraft.content, description: '新的第二版' },
      };
      f.engine.publish(compileUserWorkflowVersion(nextDraft, 2, new Date().toISOString()));
      const detail = f.imports.confirm({ proposalId: p.id, revision: p.revision });
      expect(detail.run.definitionVersion).toBe(1);
      expect(detail.version.definition.description).not.toBe('新的第二版');
    } finally {
      f.db.close();
    }
  });
  it('restart recovery before resume does not create any Mission or replay an imported completed step', async () => {
    const f = setup();
    try {
      const p = f.imports.addSource(f.prepare().id, source('first.txt'));
      const detail = f.imports.confirm({ proposalId: p.id, revision: p.revision });
      await f.engine.recover();
      const recovered = f.engine.detail(detail.run.id);
      expect(recovered.steps[0]!.state).toBe('COMPLETED');
      expect(recovered.artifacts).toHaveLength(1);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM missions').get()).toEqual({ n: 0 });
    } finally {
      f.db.close();
    }
  });
});
