import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  type WorkflowDraftContent,
  type WorkflowInputs,
  type WorkflowObjectSchema,
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

const schema: WorkflowObjectSchema = {
  type: 'object',
  properties: {
    topic: { type: 'string', minLength: 1, maxLength: 40 },
    count: { type: 'number', minimum: 1, maximum: 3, integer: true },
    mode: { type: 'enum', values: ['A', 'B'] },
    consent: { type: 'boolean' },
    options: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'string', minLength: 1, maxLength: 8 },
        },
      },
      required: ['tags'],
    },
  },
  required: ['topic', 'count', 'mode', 'consent', 'options'],
};
const inputs: WorkflowInputs = {
  topic: '有界输入',
  count: 2,
  mode: 'A',
  consent: true,
  options: { tags: ['证据'] },
};

function services(db: Database.Database) {
  const workflows = new W1WorkflowRepository(db);
  const engine = new WorkflowService(
    workflows,
    {} as WorkflowMissionPort,
    undefined,
    new W2WorkflowRepository(db),
  );
  const editor = new WorkflowEditorService(new W31WorkflowDraftRepository(db), workflows, engine);
  const imports = new WorkflowImportService(
    new W32WorkflowImportRepository(db),
    workflows,
    engine,
    {
      recheck: () => {},
    },
  );
  return { workflows, engine, editor, imports };
}

function publish(
  f: ReturnType<typeof services>,
  stepCount: number,
  inputSchema: WorkflowObjectSchema = { type: 'object', properties: {}, required: [] },
) {
  const draft = f.editor.createDraft({ name: '容量与冻结输入' });
  const template = draft.content.steps[0]!;
  const ids = Array.from({ length: stepCount }, (_, i) => `s${i + 1}`);
  const content: WorkflowDraftContent = {
    ...draft.content,
    inputSchema,
    entryStepId: ids[0]!,
    steps: ids.map((id, i) => ({
      ...structuredClone(template),
      id,
      objective: '仅按已声明输入处理有界成果',
      workflowInputKeys: Object.keys(inputSchema.properties).slice(0, 1),
      inputs: i
        ? [{ key: 'previous', fromStepId: ids[i - 1]!, outputKey: ids[i - 1]!, required: true }]
        : [],
      outputs: [{ ...template.outputs[0]!, key: id }],
    })),
    edges: ids.map((id, i) => ({
      id: `${id}-next`,
      fromStepId: id,
      toStepId: ids[i + 1] ?? null,
      branch: 'NEXT',
      condition: { type: 'ALWAYS' },
    })),
    finalOutputs: [
      {
        key: 'result',
        fromStepId: ids.at(-1)!,
        outputKey: ids.at(-1)!,
        required: true,
        description: '最终成果',
      },
    ],
  };
  const saved = f.editor.saveDraft({ id: draft.id, expectedRevision: draft.revision, content });
  return f.editor.publishDraft({ id: saved.id, expectedRevision: saved.revision });
}

function source(index: number): WorkflowImportSource {
  const content = `第${index}份既有成果`;
  return {
    id: randomUUID(),
    name: `s${index}.txt`,
    relativePath: `s${index}.txt`,
    workspaceRoot: 'E:\\controlled-workspace',
    kind: 'TEXT',
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
    mtime: 1,
  };
}
function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('R6.1 W3.2 capacity and frozen USER input boundaries', () => {
  it('accepts 16 distinct sources on a 32-step graph; source 17 and reused identities cannot create partial formal facts', () => {
    const db = database();
    try {
      const f = services(db);
      const version = publish(f, 32);
      let p = f.imports.prepare({ definitionId: version.definition.id, version: 1 });
      for (let i = 1; i <= 16; i++) p = f.imports.addSource(p.id, source(i));
      expect(p.sources).toHaveLength(16);
      expect(p.resolution.suggestedCompletedSteps).toHaveLength(16);
      expect(p.resolution.suggestedCurrentStep).toBe('s17');
      expect(p.validationStatus).toBe('VALID');
      const snapshot = structuredClone(p);
      expect(() => f.imports.addSource(p.id, source(17))).toThrow('16');
      expect(f.imports.get(p.id)).toEqual(snapshot);
      expect(f.workflows.listRuns()).toHaveLength(0);
      const invalid = f.imports.revise({
        proposalId: p.id,
        revision: p.revision,
        completedStepIds: Array.from({ length: 17 }, (_, i) => `s${i + 1}`),
        currentStepId: 's18',
        bindings: [
          ...p.resolution.candidateArtifactBindings,
          { stepId: 's17', outputKey: 's17', sourceId: p.sources[0]!.id },
        ],
      });
      expect(invalid.validationStatus).toBe('INVALID');
      expect(() => f.imports.confirm({ proposalId: p.id, revision: invalid.revision })).toThrow();
      expect(db.prepare('SELECT COUNT(*) n FROM workflow_import_confirmations').get()).toEqual({
        n: 0,
      });
      expect(f.workflows.listRuns()).toHaveLength(0);
      const valid = f.imports.revise({
        proposalId: p.id,
        revision: invalid.revision,
        completedStepIds: snapshot.resolution.suggestedCompletedSteps,
        currentStepId: 's17',
        bindings: snapshot.resolution.candidateArtifactBindings,
      });
      const detail = f.imports.confirm({ proposalId: valid.id, revision: valid.revision });
      expect(detail.steps).toHaveLength(32);
      expect(detail.steps.filter((s) => s.completionOrigin === 'IMPORTED_CONFIRMED')).toHaveLength(
        16,
      );
      expect(detail.steps.find((s) => s.stepId === 's17')!.state).toBe('READY');
      expect(detail.artifacts).toHaveLength(16);
      expect(detail.checkpoints).toHaveLength(16);
      expect(detail.artifacts.every((a) => f.workflows.verifyImportedArtifact(a))).toBe(true);
      for (const table of [
        'missions',
        'usage_records',
        'experience_events',
        'workflow_step_operation_receipts',
      ])
        expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      db.close();
    }
  });

  it('rejects physical source aliases before the count limit and rejects importing the terminal or oversized graph', () => {
    const db = database();
    try {
      const f = services(db);
      const version = publish(f, 32);
      const original = source(1);
      let p = f.imports.addSource(
        f.imports.prepare({ definitionId: version.definition.id, version: 1 }).id,
        original,
      );
      expect(() =>
        f.imports.addSource(p.id, {
          ...original,
          id: randomUUID(),
          relativePath: 'S1.TXT',
          workspaceRoot: 'e:\\CONTROLLED-WORKSPACE',
        }),
      ).toThrow('重复');
      p = f.imports.revise({
        proposalId: p.id,
        revision: p.revision,
        completedStepIds: version.steps.map((s) => s.id),
        currentStepId: 's32',
        bindings: p.resolution.candidateArtifactBindings,
      });
      expect(p.validationStatus).toBe('INVALID');
      expect(() => f.imports.confirm({ proposalId: p.id, revision: p.revision })).toThrow();
      expect(() => publish(f, 33)).toThrow();
      expect(f.workflows.listRuns()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('rejects missing/unknown/type/enum/range/nested array inputs before persisting any proposal or Run', () => {
    const db = database();
    try {
      const f = services(db);
      const version = publish(f, 3, schema);
      for (const bad of [
        {},
        { ...inputs, topic: '' },
        { ...inputs, unknown: 'forged' },
        { ...inputs, mode: 'C' },
        { ...inputs, count: 4 },
        { ...inputs, count: 1.5 },
        { ...inputs, consent: 'true' },
        { ...inputs, options: { tags: [] } },
        { ...inputs, options: { tags: ['a', 'b', 'c'] } },
      ])
        expect(() =>
          f.imports.prepare({ definitionId: version.definition.id, version: 1, inputs: bad }),
        ).toThrow();
      expect(f.imports.list()).toHaveLength(0);
      expect(f.workflows.listRuns()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('keeps v1 input snapshot unchanged when caller mutates input and v2 publishes an incompatible schema; reopen and repeated confirm are identical', () => {
    const directory = join(process.cwd(), '.test-data/r61-boundary');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${randomUUID()}.sqlite`);
    let db = new Database(file);
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, migrations);
      let f = services(db);
      const version = publish(f, 3, schema);
      const caller = structuredClone(inputs);
      const p = f.imports.addSource(
        f.imports.prepare({ definitionId: version.definition.id, version: 1, inputs: caller }).id,
        source(1),
      );
      caller.topic = 'changed';
      caller.options = { tags: ['changed'] };
      const draft = f.editor.editVersion({ definitionId: version.definition.id, version: 1 });
      draft.content.inputSchema.properties.mode = { type: 'enum', values: ['NEW'] };
      const saved = f.editor.saveDraft({
        id: draft.id,
        expectedRevision: draft.revision,
        content: draft.content,
      });
      f.editor.publishDraft({ id: saved.id, expectedRevision: saved.revision });
      expect(() =>
        f.imports.prepare({ definitionId: version.definition.id, version: 2, inputs }),
      ).toThrow();
      const detail = f.imports.confirm({ proposalId: p.id, revision: p.revision });
      expect(detail.run.inputSnapshot).toEqual(inputs);
      expect(f.imports.get(p.id).inputSnapshot).toEqual(detail.run.inputSnapshot);
      expect(detail.run.definitionVersion).toBe(1);
      expect(() =>
        db
          .prepare('UPDATE workflow_runs SET input_snapshot_json = ? WHERE id = ?')
          .run('{}', detail.run.id),
      ).toThrow();
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      f = services(db);
      const restored = f.imports.confirm({ proposalId: p.id, revision: p.revision });
      expect(restored.run).toEqual(detail.run);
      expect(restored.artifacts).toEqual(detail.artifacts);
      expect(restored.checkpoints).toEqual(detail.checkpoints);
      expect(f.workflows.listRuns()).toHaveLength(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
