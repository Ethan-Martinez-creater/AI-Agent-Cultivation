import { describe, expect, it } from 'vitest';
import type { WorkflowDraft, WorkflowVersion } from '@cultivation/domain';
import type { WorkflowRepository } from './w1-workflow-ports.js';
import type { WorkflowService } from './w1-workflow-service.js';
import {
  WorkflowEditorService,
  type WorkflowDraftRepositoryPort,
  type WorkflowEditorClock,
} from './w3-1-workflow-editor-service.js';

class MemoryDraftRepository implements WorkflowDraftRepositoryPort {
  private readonly values = new Map<string, WorkflowDraft>();

  transaction<T>(fn: () => T): T {
    return fn();
  }

  insertDraft(value: WorkflowDraft): void {
    if (
      this.values.has(value.id) ||
      [...this.values.values()].some((draft) => draft.definitionId === value.definitionId)
    )
      throw new Error('Draft identity already exists');
    this.values.set(value.id, structuredClone(value));
  }

  saveDraft(value: WorkflowDraft, expectedRevision: number): boolean {
    const current = this.values.get(value.id);
    if (!current || current.revision !== expectedRevision) return false;
    this.values.set(value.id, structuredClone(value));
    return true;
  }

  deleteDraft(id: string, expectedRevision: number): boolean {
    const current = this.values.get(id);
    if (!current || current.revision !== expectedRevision) return false;
    return this.values.delete(id);
  }

  getDraft(id: string): WorkflowDraft | null {
    const value = this.values.get(id);
    return value ? structuredClone(value) : null;
  }

  listDrafts(): WorkflowDraft[] {
    return [...this.values.values()].map((value) => structuredClone(value));
  }
}

class MemoryWorkflowRepository {
  readonly versions: WorkflowVersion[] = [];

  transaction<T>(fn: () => T): T {
    const before = structuredClone(this.versions);
    try {
      return fn();
    } catch (error) {
      this.versions.splice(0, this.versions.length, ...before);
      throw error;
    }
  }

  getVersion(definitionId: string, version: number): WorkflowVersion | null {
    return (
      this.versions.find(
        (value) => value.definition.id === definitionId && value.version === version,
      ) ?? null
    );
  }

  listVersions(): WorkflowVersion[] {
    return this.versions.map((value) => structuredClone(value));
  }

  publishVersion(value: WorkflowVersion): void {
    const prior = this.getVersion(value.definition.id, value.version);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('Immutable version');
      return;
    }
    this.versions.push(structuredClone(value));
  }
}

function harness() {
  const drafts = new MemoryDraftRepository();
  const repo = new MemoryWorkflowRepository();
  let counter = 0;
  const clock: WorkflowEditorClock = {
    now: () => `2026-10-07T00:00:${String(counter++).padStart(2, '0')}.000Z`,
    id: () => `id-${counter++}`,
  };
  const editor = new WorkflowEditorService(
    drafts,
    repo as unknown as WorkflowRepository,
    { publish: (version) => repo.publishVersion(version) } as Pick<WorkflowService, 'publish'>,
    clock,
  );
  return { drafts, repo, editor };
}

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code} error`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function setObjective(
  editor: WorkflowEditorService,
  draft: WorkflowDraft,
  objective: string,
): WorkflowDraft {
  const content = structuredClone(draft.content);
  content.steps[0]!.objective = objective;
  return editor.saveDraft({ id: draft.id, expectedRevision: draft.revision, content });
}

describe('W3.1 Workflow Editor service', () => {
  it('keeps drafts separate, publishes USER v1, then creates immutable v2 from v1', () => {
    const { editor, drafts, repo } = harness();
    const draft = editor.createDraft({ name: 'My flow' });
    expect(draft.definitionId).toMatch(/^user\./);
    expect(draft.baseVersion).toBeNull();
    expect(repo.versions).toHaveLength(0);

    const firstSaved = setObjective(editor, draft, 'Prepare the requested result.');
    const v1 = editor.publishDraft({ id: firstSaved.id, expectedRevision: firstSaved.revision });
    expect(v1.definition.source).toBe('USER');
    expect(v1.version).toBe(1);
    expect(drafts.getDraft(draft.id)).toBeNull();
    const v1Objective = v1.steps[0]!.objective;

    const v2Draft = editor.editVersion({ definitionId: draft.definitionId, version: 1 });
    expect(v2Draft.baseVersion).toBe(1);
    const edited = structuredClone(v2Draft.content);
    edited.steps[0]!.objective = 'A new objective for v2';
    const saved = editor.saveDraft({
      id: v2Draft.id,
      expectedRevision: v2Draft.revision,
      content: edited,
    });
    const v2 = editor.publishDraft({ id: saved.id, expectedRevision: saved.revision });

    expect(v2.version).toBe(2);
    expect(v2.steps[0]!.objective).toBe('A new objective for v2');
    expect(repo.getVersion(draft.definitionId, 1)?.steps[0]!.objective).toBe(v1Objective);
    expect(repo.getVersion(draft.definitionId, 2)?.steps[0]!.objective).toBe(
      'A new objective for v2',
    );
  });

  it('rejects a stale Draft save and will not publish an older base over the current head', () => {
    const { editor, repo } = harness();
    const draft = editor.createDraft();
    const prepared = setObjective(editor, draft, 'Prepare the result.');
    const changed = structuredClone(prepared.content);
    changed.name = 'Saved once';
    const saved = editor.saveDraft({
      id: draft.id,
      expectedRevision: prepared.revision,
      content: changed,
    });

    expectErrorCode(
      () =>
        editor.saveDraft({ id: draft.id, expectedRevision: prepared.revision, content: changed }),
      'CONFLICT',
    );
    editor.publishDraft({ id: saved.id, expectedRevision: saved.revision });
    const v2Draft = editor.editVersion({ definitionId: draft.definitionId, version: 1 });
    const stale = editor.saveDraft({
      id: v2Draft.id,
      expectedRevision: v2Draft.revision,
      content: { ...v2Draft.content, name: 'Saved against v1' },
    });
    repo.publishVersion({
      ...structuredClone(repo.getVersion(draft.definitionId, 1)!),
      version: 2,
    });
    expectErrorCode(
      () => editor.publishDraft({ id: stale.id, expectedRevision: stale.revision }),
      'CONFLICT',
    );
  });

  it('copies a BUILTIN version into a new USER identity without editing the source', () => {
    const { editor, repo } = harness();
    const source = editor.createDraft({ name: 'Official copy source' });
    const prepared = setObjective(editor, source, 'Prepare the official workflow result.');
    const userVersion = editor.publishDraft({
      id: prepared.id,
      expectedRevision: prepared.revision,
    });
    const builtin: WorkflowVersion = {
      ...structuredClone(userVersion),
      definition: { ...userVersion.definition, id: 'official.audit-fixture', source: 'BUILTIN' },
    };
    repo.versions.push(builtin);

    const copy = editor.copyVersion({
      definitionId: builtin.definition.id,
      version: builtin.version,
      name: 'User copy',
    });
    expect(copy.definitionId).not.toBe(builtin.definition.id);
    expect(copy.definitionId).toMatch(/^user\./);
    const published = editor.publishDraft({ id: copy.id, expectedRevision: 1 });

    expect(published.definition.source).toBe('USER');
    expect(published.definition.id).not.toBe(builtin.definition.id);
    expect(repo.getVersion(builtin.definition.id, 1)).toEqual(builtin);
  });

  it('rejects editing BUILTIN and copying IMPORTED versions', () => {
    const { editor, repo } = harness();
    const seed = editor.createDraft();
    const prepared = setObjective(editor, seed, 'Prepare the result.');
    const version = editor.publishDraft({ id: prepared.id, expectedRevision: prepared.revision });
    repo.versions.push({
      ...structuredClone(version),
      definition: { ...version.definition, id: 'official.read-only', source: 'BUILTIN' },
    });
    repo.versions.push({
      ...structuredClone(version),
      definition: { ...version.definition, id: 'imported.pending', source: 'IMPORTED' },
    });

    expectErrorCode(
      () => editor.editVersion({ definitionId: 'official.read-only', version: 1 }),
      'INVALID_INPUT',
    );
    expectErrorCode(
      () => editor.copyVersion({ definitionId: 'imported.pending', version: 1 }),
      'INVALID_INPUT',
    );
  });
});
