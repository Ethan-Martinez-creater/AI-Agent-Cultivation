import Database from 'better-sqlite3';
import { parseWorkflowDraftContent, type WorkflowDraft } from '@cultivation/domain';

interface DraftRow {
  id: string;
  definition_id: string;
  base_version: number | null;
  revision: number;
  content_json: string;
  created_at: string;
  updated_at: string;
}

const MAX_DRAFT_BYTES = 120_000;
const MAX_ID = 256;
const MAX_TIMESTAMP = 128;

/** Durable editable authoring state. Published Workflow facts remain in W1 tables. */
export class W31WorkflowDraftRepository {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insertDraft(value: WorkflowDraft): void {
    const draft = validateDraft(value);
    this.db
      .prepare(
        `INSERT INTO workflow_user_drafts
          (id, definition_id, base_version, revision, content_json, created_at, updated_at)
         VALUES (@id, @definitionId, @baseVersion, @revision, @contentJson, @createdAt, @updatedAt)`,
      )
      .run(draft);
  }

  saveDraft(value: WorkflowDraft, expectedRevision: number): boolean {
    const draft = validateDraft(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Invalid expected Workflow Draft revision');
    }
    if (value.revision !== expectedRevision + 1) {
      throw new Error('Workflow Draft revision must increment exactly once');
    }
    return this.transaction(() => {
      const current = this.db
        .prepare('SELECT * FROM workflow_user_drafts WHERE id = ?')
        .get(value.id) as DraftRow | undefined;
      if (!current || current.revision !== expectedRevision) return false;
      if (
        current.definition_id !== value.definitionId ||
        current.base_version !== value.baseVersion ||
        current.created_at !== value.createdAt
      ) {
        throw new Error('Workflow Draft identity and base version are immutable');
      }
      const result = this.db
        .prepare(
          `UPDATE workflow_user_drafts
           SET revision = @revision, content_json = @contentJson, updated_at = @updatedAt
           WHERE id = @id AND revision = @expectedRevision`,
        )
        .run({ ...draft, expectedRevision });
      return result.changes === 1;
    });
  }

  deleteDraft(id: string, expectedRevision: number): boolean {
    validateId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Invalid expected Workflow Draft revision');
    }
    const result = this.db
      .prepare('DELETE FROM workflow_user_drafts WHERE id = ? AND revision = ?')
      .run(id, expectedRevision);
    return result.changes === 1;
  }

  getDraft(id: string): WorkflowDraft | null {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM workflow_user_drafts WHERE id = ?').get(id) as
      | DraftRow
      | undefined;
    return row ? mapDraft(row) : null;
  }

  listDrafts(): WorkflowDraft[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_user_drafts
         ORDER BY updated_at DESC, definition_id COLLATE BINARY`,
      )
      .all() as DraftRow[];
    return rows.map(mapDraft);
  }
}

function validateDraft(value: WorkflowDraft): Record<string, unknown> {
  validateId(value.id);
  validateId(value.definitionId);
  if (
    value.baseVersion !== null &&
    (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 1)
  ) {
    throw new Error('Invalid Workflow Draft base version');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('Invalid Workflow Draft revision');
  }
  validateTimestamp(value.createdAt);
  validateTimestamp(value.updatedAt);
  const content = parseWorkflowDraftContent(value.content);
  const contentJson = canonicalJson(content);
  if (Buffer.byteLength(contentJson, 'utf8') > MAX_DRAFT_BYTES) {
    throw new Error('Workflow Draft is too large');
  }
  return {
    id: value.id,
    definitionId: value.definitionId,
    baseVersion: value.baseVersion,
    revision: value.revision,
    contentJson,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapDraft(row: DraftRow): WorkflowDraft {
  const draft: WorkflowDraft = {
    id: row.id,
    definitionId: row.definition_id,
    baseVersion: row.base_version,
    revision: row.revision,
    content: parseWorkflowDraftContent(JSON.parse(row.content_json) as unknown),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (canonicalJson(draft.content) !== row.content_json) {
    throw new Error('Persisted Workflow Draft integrity check failed');
  }
  return draft;
}

function validateId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > MAX_ID ||
    value.toLowerCase().startsWith('official.')
  ) {
    throw new Error('Workflow Draft identity is invalid');
  }
}

function validateTimestamp(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TIMESTAMP ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('Workflow Draft timestamp is invalid');
  }
}

function canonicalJson(value: unknown): string {
  const sort = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sort);
    if (current !== null && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return current;
  };
  return JSON.stringify(sort(value));
}
