import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_WORKFLOW_INPUT_SCHEMA,
  compileUserWorkflowVersion,
  parseWorkflowDraftContent,
  type WorkflowDraft,
  type WorkflowDraftContent,
} from '@cultivation/domain';
import { WorkflowEditorService, WorkflowService } from '@cultivation/application';
import type { WorkflowMissionPort } from '../../application/src/w1-workflow-ports.js';
import {
  installOfficialBuiltinWorkflows,
  OFFICIAL_BUILTIN_WORKFLOW_PACKAGES,
} from '../../../apps/desktop/src/main/w2-builtin-installation.js';
import {
  migrations,
  runMigrations,
  W1WorkflowRepository,
  W2WorkflowRepository,
  W31WorkflowDraftRepository,
} from './index.js';

const NOW = '2026-10-07T00:00:00.000Z';

function makeContent(objective: string): WorkflowDraftContent {
  return parseWorkflowDraftContent({
    name: 'W31 migration fixture',
    description: 'Workflow used to validate Draft persistence.',
    category: 'General',
    inputSchema: EMPTY_WORKFLOW_INPUT_SCHEMA,
    finalOutputs: [
      {
        key: 'result',
        fromStepId: 'task',
        outputKey: 'result',
        required: true,
        description: 'Final result',
      },
    ],
    entryStepId: 'task',
    steps: [
      {
        id: 'task',
        type: 'TASK',
        title: 'Prepare result',
        objective,
        routing: { requiredCapabilities: ['GENERAL_REASONING'], executionConstraint: 'SOLO' },
        inputs: [],
        outputs: [
          {
            key: 'result',
            kind: 'TEXT',
            required: true,
            contractId: 'user.text',
            contractVersion: '1',
            maxSizeBytes: 100_000,
            description: 'Final result',
            validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
          },
        ],
        maxAttempts: 1,
        exitCondition: 'VALID_OUTPUTS',
      },
    ],
    edges: [
      {
        id: 'finish',
        fromStepId: 'task',
        toStepId: null,
        branch: 'COMPLETE',
        condition: { type: 'ALWAYS' },
      },
    ],
  });
}

function makeDraft(): WorkflowDraft {
  const content = makeContent('Create a concise result.');
  return {
    id: 'fixture-draft-v1',
    definitionId: 'user.migration-fixture',
    baseVersion: null,
    revision: 1,
    content,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function openDatabase(path: string, throughVersion: number): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  runMigrations(
    db,
    migrations.filter((migration) => migration.version <= throughVersion),
  );
  return db;
}

function workflowServices(db: Database.Database) {
  const workflowStore = new W1WorkflowRepository(db);
  const foundation = new W2WorkflowRepository(db);
  const workflowService = new WorkflowService(
    workflowStore,
    {} as WorkflowMissionPort,
    undefined,
    foundation,
  );
  const draftStore = new W31WorkflowDraftRepository(db);
  return {
    workflowStore,
    foundation,
    workflowService,
    draftStore,
    editor: new WorkflowEditorService(draftStore, workflowStore, workflowService),
  };
}

describe('W3.1 Workflow Draft persistence', () => {
  it('safely copies and publishes each of the three official packages under new USER identities', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const services = workflowServices(db);
    try {
      installOfficialBuiltinWorkflows(services.workflowStore, services.foundation);
      expect(OFFICIAL_BUILTIN_WORKFLOW_PACKAGES).toHaveLength(3);

      for (const officialPackage of OFFICIAL_BUILTIN_WORKFLOW_PACKAGES) {
        const official = officialPackage.version;
        const original = services.workflowStore.getVersion(
          official.definition.id,
          official.version,
        );
        expect(original).toEqual(official);
        const originalContentHash = db
          .prepare(
            `SELECT content_hash FROM workflow_versions
             WHERE definition_id = ? AND version = ?`,
          )
          .get(official.definition.id, official.version);
        const originalReleaseHash = db
          .prepare(
            `SELECT manifest_hash FROM workflow_builtin_releases
             WHERE definition_id = ? AND version = ?`,
          )
          .get(official.definition.id, official.version);

        const draft = services.editor.copyVersion({
          definitionId: official.definition.id,
          version: official.version,
        });
        expect(draft.definitionId).not.toBe(official.definition.id);
        expect(draft.definitionId).toMatch(/^user\./);
        expect(draft.baseVersion).toBeNull();
        expect(draft.revision).toBe(1);

        const published = services.editor.publishDraft({
          id: draft.id,
          expectedRevision: draft.revision,
        });
        expect(published.definition).toMatchObject({
          id: draft.definitionId,
          source: 'USER',
        });
        expect(published.version).toBe(1);
        expect(published.steps.every((step) => step.effectType === 'NONE')).toBe(true);
        expect(published.validationPolicy).toBeUndefined();
        expect(published.releaseMetadata).toBeUndefined();

        expect(services.workflowStore.getVersion(official.definition.id, official.version)).toEqual(
          original,
        );
        expect(
          db
            .prepare(
              `SELECT content_hash FROM workflow_versions
               WHERE definition_id = ? AND version = ?`,
            )
            .get(official.definition.id, official.version),
        ).toEqual(originalContentHash);
        expect(
          db
            .prepare(
              `SELECT manifest_hash FROM workflow_builtin_releases
               WHERE definition_id = ? AND version = ?`,
            )
            .get(official.definition.id, official.version),
        ).toEqual(originalReleaseHash);
      }

      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('upgrades 0030 to 0031, preserves official hashes and existing Run pins, and restores Draft/version facts', () => {
    const path = join(process.cwd(), `.w31-draft-${randomUUID()}.sqlite`);
    let db: Database.Database | null = null;
    try {
      db = openDatabase(path, 30);
      const workflowStore = new W1WorkflowRepository(db);
      const version = compileUserWorkflowVersion(makeDraft(), 1, NOW);
      workflowStore.publishVersion(version);
      const workflows = new WorkflowService(workflowStore, {} as WorkflowMissionPort);
      const runA = workflows.createRun({ definitionId: version.definition.id, version: 1 });

      const foundation = new W2WorkflowRepository(db);
      installOfficialBuiltinWorkflows(workflowStore, foundation);
      const beforeVersions = db
        .prepare(
          `SELECT definition_id, version, content_hash FROM workflow_versions
           WHERE definition_id LIKE 'official.%' ORDER BY definition_id, version`,
        )
        .all();
      const beforeReleases = db
        .prepare(
          `SELECT definition_id, version, manifest_hash FROM workflow_builtin_releases
           ORDER BY definition_id, version`,
        )
        .all();

      runMigrations(db, migrations);
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
        version: 31,
      });
      expect(
        db
          .prepare(
            `SELECT definition_id, version, content_hash FROM workflow_versions
             WHERE definition_id LIKE 'official.%' ORDER BY definition_id, version`,
          )
          .all(),
      ).toEqual(beforeVersions);
      expect(
        db
          .prepare(
            `SELECT definition_id, version, manifest_hash FROM workflow_builtin_releases
             ORDER BY definition_id, version`,
          )
          .all(),
      ).toEqual(beforeReleases);

      let services = workflowServices(db);
      const editorDraft = services.editor.editVersion({
        definitionId: version.definition.id,
        version: 1,
      });
      const content = structuredClone(editorDraft.content);
      content.steps[0]!.objective = 'Revise the frozen objective for version two.';
      const saved = services.editor.saveDraft({
        id: editorDraft.id,
        expectedRevision: editorDraft.revision,
        content,
      });
      const version2 = services.editor.publishDraft({
        id: saved.id,
        expectedRevision: saved.revision,
      });
      const runB = services.workflowService.createRun({
        definitionId: version.definition.id,
        version: version2.version,
      });
      const pending = services.editor.createDraft({ name: 'Restored editable Draft' });

      expect(version2.version).toBe(2);
      expect(services.workflowService.detail(runA.run.id).version.version).toBe(1);
      expect(runB.version.version).toBe(2);
      expect(services.draftStore.getDraft(pending.id)).toEqual(pending);

      db.close();
      db = null;
      db = openDatabase(path, 31);
      services = workflowServices(db);

      expect(services.workflowStore.getVersion(version.definition.id, 1)?.steps[0]!.objective).toBe(
        'Create a concise result.',
      );
      expect(services.workflowStore.getVersion(version.definition.id, 2)?.steps[0]!.objective).toBe(
        'Revise the frozen objective for version two.',
      );
      expect(services.workflowService.detail(runA.run.id).version.version).toBe(1);
      expect(services.workflowService.detail(runB.run.id).version.version).toBe(2);
      expect(services.draftStore.getDraft(pending.id)).toEqual(pending);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db?.close();
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('keeps invalid or failed publications as Drafts and rolls back a partially published version', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const services = workflowServices(db);
    try {
      const invalid = services.editor.createDraft();
      expect(() =>
        services.editor.publishDraft({ id: invalid.id, expectedRevision: invalid.revision }),
      ).toThrow();
      expect(services.draftStore.getDraft(invalid.id)).not.toBeNull();
      expect(services.workflowStore.listVersions()).toHaveLength(0);

      const preparedContent = structuredClone(invalid.content);
      preparedContent.steps[0]!.objective = 'Create a valid result.';
      const prepared = services.editor.saveDraft({
        id: invalid.id,
        expectedRevision: invalid.revision,
        content: preparedContent,
      });
      db.exec(`
        CREATE TRIGGER w31_test_reject_draft_delete
        BEFORE DELETE ON workflow_user_drafts BEGIN
          SELECT RAISE(ABORT, 'forced test rollback');
        END;
      `);
      expect(() =>
        services.editor.publishDraft({ id: prepared.id, expectedRevision: prepared.revision }),
      ).toThrow();
      expect(services.workflowStore.listVersions()).toHaveLength(0);
      expect(services.draftStore.getDraft(prepared.id)).not.toBeNull();

      db.exec('DROP TRIGGER w31_test_reject_draft_delete');
      const published = services.editor.publishDraft({
        id: prepared.id,
        expectedRevision: prepared.revision,
      });
      expect(published.version).toBe(1);
      expect(services.draftStore.getDraft(prepared.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('applies source and optional-base-version guards in SQLite', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrations);
    const drafts = new W31WorkflowDraftRepository(db);
    const draft = makeDraft();
    try {
      expect(() =>
        drafts.insertDraft({
          ...draft,
          id: 'draft-no-base',
          definitionId: 'user.missing-base',
          baseVersion: 9,
        }),
      ).toThrow();

      db.prepare(
        `INSERT INTO workflow_definitions
          (id, name, description, category, source, created_at)
         VALUES ('private-built-in-id', 'Built in', '', 'General', 'BUILTIN', @createdAt)`,
      ).run({ createdAt: NOW });
      drafts.insertDraft({
        ...draft,
        id: 'draft-identity-guard',
        definitionId: 'user.identity-guard',
      });
      expect(() =>
        db
          .prepare(
            "UPDATE workflow_user_drafts SET id = 'draft-renamed' WHERE id = 'draft-identity-guard'",
          )
          .run(),
      ).toThrow(/identity\/base are immutable/);
      expect(() =>
        db
          .prepare(
            "UPDATE workflow_user_drafts SET definition_id = 'user.renamed' WHERE id = 'draft-identity-guard'",
          )
          .run(),
      ).toThrow(/identity\/base are immutable/);
      expect(() =>
        db
          .prepare(
            "UPDATE workflow_user_drafts SET base_version = 1 WHERE id = 'draft-identity-guard'",
          )
          .run(),
      ).toThrow(/identity\/base are immutable/);
      expect(() =>
        db
          .prepare(
            "UPDATE workflow_user_drafts SET created_at = '2026-10-08T00:00:00Z' WHERE id = 'draft-identity-guard'",
          )
          .run(),
      ).toThrow(/identity\/base are immutable/);
      expect(() =>
        db
          .prepare(
            "UPDATE workflow_user_drafts SET revision = revision + 2 WHERE id = 'draft-identity-guard'",
          )
          .run(),
      ).toThrow(/identity\/base are immutable/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_user_drafts
            (id, definition_id, base_version, revision, content_json, created_at, updated_at)
           VALUES ('forged-draft', 'private-built-in-id', NULL, 1, '{}', @createdAt, @createdAt)`,
          )
          .run({ createdAt: NOW }),
      ).toThrow(/Only USER Workflow definitions/);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
