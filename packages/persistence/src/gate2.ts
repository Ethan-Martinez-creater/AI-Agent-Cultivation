import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  MemoryOwnerType,
  MemoryRecord,
  MemoryStatus,
  Skill,
  SkillAssignment,
  SkillRevision,
} from '../../domain/src/index.js';

export interface MemorySearchResult extends MemoryRecord {
  /** Combined FTS relevance, recency, and importance score in the range [0, 1]. */
  score: number;
}

export const MEMORY_SCOPE_QUERY = `
  SELECT id, owner_type, owner_id, memory_type, content, summary, source_type, source_id,
         importance, confidence, status, created_at, updated_at, expires_at,
         source_conversation_id, source_message_id, confirmed_at
  FROM memories INDEXED BY memories_owner_scope_idx
  WHERE owner_type = ? AND owner_id = ? AND status = 'ACTIVE'
    AND (expires_at IS NULL OR expires_at > ?)
  ORDER BY importance DESC, created_at DESC, id
`;

export const MEMORY_FTS_SEARCH_QUERY = `
  SELECT c.*, (
    0.65 * (1.0 / (1.0 + abs(bm25(gate2_memory_fts, 0.0, 1.0, 2.0))))
    + 0.20 * (1.0 / (1.0 + max(0.0, julianday('now') - julianday(c.created_at)) / 30.0))
    + 0.15 * c.importance
  ) AS score
  FROM gate2_memory_fts
  JOIN temp.gate2_memory_candidates AS c
    ON c.id = gate2_memory_fts.memory_id
  WHERE gate2_memory_fts MATCH ?
  ORDER BY score DESC, c.created_at DESC, c.id
  LIMIT ?
`;

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const DEFAULT_INJECTION_CHAR_BUDGET = 6000;
const MAX_INJECTION_CHAR_BUDGET = 20000;
const SEARCH_INPUT_MAX_CODEPOINTS = 512;

interface MemoryRow {
  id: string;
  owner_type: MemoryOwnerType;
  owner_id: string;
  memory_type: MemoryRecord['memoryType'];
  content: string;
  summary: string;
  source_type: string;
  source_id: string | null;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  confirmed_at: string | null;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  version: string;
  tags_json: string;
  status: Skill['status'];
  created_at: string;
  updated_at: string;
}

interface SkillRevisionRow {
  id: string;
  skill_id: string;
  revision: number;
  version: string;
  name: string;
  description: string;
  instructions: string;
  tags_json: string;
  created_at: string;
}

interface SkillAssignmentRow {
  teammate_id: string;
  skill_id: string;
  enabled: number;
}

/**
 * Main-process SQLite APIs for Gate 2 Memory and declarative Skill data.
 * Each Memory search first loads owner/status-filtered rows through the
 * memories_owner_scope_idx index, then builds a transient FTS5 index containing
 * only those rows. No query is ever run against the global memory_fts table.
 */
export class Gate2SqliteRepository {
  private memoryFtsTokenizer: 'trigram' | 'unicode61' | null = null;

  constructor(private readonly db: Database.Database) {}

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | MemoryRow
      | undefined;
    return row ? mapMemory(row) : null;
  }

  listMemories(ownerType: MemoryOwnerType, ownerId: string, status?: MemoryStatus): MemoryRecord[] {
    const rows = status
      ? (this.db
          .prepare(
            `SELECT * FROM memories
             WHERE owner_type = ? AND owner_id = ? AND status = ?
             ORDER BY created_at DESC, id`,
          )
          .all(ownerType, ownerId, status) as MemoryRow[])
      : (this.db
          .prepare(
            `SELECT * FROM memories
             WHERE owner_type = ? AND owner_id = ?
             ORDER BY created_at DESC, id`,
          )
          .all(ownerType, ownerId) as MemoryRow[]);
    return rows.map(mapMemory);
  }

  saveMemory(value: MemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO memories
          (id, owner_type, owner_id, memory_type, content, summary, source_type, source_id,
           importance, confidence, status, created_at, updated_at, expires_at,
           source_conversation_id, source_message_id, confirmed_at)
         VALUES
          (@id, @ownerType, @ownerId, @memoryType, @content, @summary, @sourceType, @sourceId,
           @importance, @confidence, @status, @createdAt, @updatedAt, @expiresAt,
           @sourceConversationId, @sourceMessageId, @confirmedAt)
         ON CONFLICT(id) DO UPDATE SET
           owner_type=excluded.owner_type, owner_id=excluded.owner_id,
           memory_type=excluded.memory_type, content=excluded.content, summary=excluded.summary,
           source_type=excluded.source_type, source_id=excluded.source_id,
           importance=excluded.importance, confidence=excluded.confidence,
           status=excluded.status, updated_at=excluded.updated_at,
           expires_at=excluded.expires_at,
           source_conversation_id=excluded.source_conversation_id,
           source_message_id=excluded.source_message_id, confirmed_at=excluded.confirmed_at`,
      )
      .run({
        id: value.id,
        ownerType: value.ownerType,
        ownerId: value.ownerId,
        memoryType: value.memoryType,
        content: value.content,
        summary: value.summary,
        sourceType: value.sourceType,
        sourceId: value.sourceId,
        importance: value.importance,
        confidence: value.confidence,
        status: value.status,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        expiresAt: value.expiresAt,
        sourceConversationId: value.sourceConversationId,
        sourceMessageId: value.sourceMessageId,
        confirmedAt: value.confirmedAt,
      });
  }

  /**
   * Return only active, non-expired memories owned by exactly ownerType/ownerId.
   * top-K is hard-capped at 20 and combined summary/content output at 20,000 chars.
   */
  searchActiveMemories(
    ownerType: MemoryOwnerType,
    ownerId: string,
    query: string,
    limit = DEFAULT_TOP_K,
    maxChars = DEFAULT_INJECTION_CHAR_BUDGET,
  ): MemorySearchResult[] {
    const topK = Number.isFinite(limit)
      ? Math.max(0, Math.min(MAX_TOP_K, Math.floor(limit)))
      : DEFAULT_TOP_K;
    const charBudget = Number.isFinite(maxChars)
      ? Math.max(0, Math.min(MAX_INJECTION_CHAR_BUDGET, Math.floor(maxChars)))
      : DEFAULT_INJECTION_CHAR_BUDGET;
    if (topK === 0 || charBudget === 0) return [];

    this.ensureMemorySearchTables();
    const now = new Date().toISOString();
    const cleanQuery = normalizeSearchInput(query);

    const search = this.db.transaction(() => {
      // Reset on every invocation so a previous Teammate's transient index cannot persist.
      this.db.exec('DELETE FROM temp.gate2_memory_fts; DELETE FROM temp.gate2_memory_candidates;');
      const scopedRows = this.db
        .prepare(MEMORY_SCOPE_QUERY)
        .all(ownerType, ownerId, now) as MemoryRow[];
      if (scopedRows.length === 0 || cleanQuery.length === 0) return [];

      const insertCandidate = this.db.prepare(
        `INSERT INTO temp.gate2_memory_candidates
         (id, owner_type, owner_id, memory_type, content, summary, source_type, source_id,
          importance, confidence, status, created_at, updated_at, expires_at,
          source_conversation_id, source_message_id, confirmed_at)
         VALUES
         (@id, @owner_type, @owner_id, @memory_type, @content, @summary, @source_type, @source_id,
          @importance, @confidence, @status, @created_at, @updated_at, @expires_at,
          @source_conversation_id, @source_message_id, @confirmed_at)`,
      );
      const insertSearchText = this.db.prepare(
        'INSERT INTO temp.gate2_memory_fts (memory_id, content, summary) VALUES (?, ?, ?)',
      );
      for (const row of scopedRows) {
        insertCandidate.run(row);
        insertSearchText.run(row.id, row.content, row.summary);
      }

      const normalizedLength = Array.from(cleanQuery).length;
      let rankedRows: Array<MemoryRow & { score: number }>;
      if (normalizedLength >= 3) {
        const ftsQuery =
          this.memoryFtsTokenizer === 'trigram'
            ? quoteFtsPhrase(cleanQuery)
            : quoteUnicode61Query(cleanQuery);
        try {
          rankedRows = this.db.prepare(MEMORY_FTS_SEARCH_QUERY).all(ftsQuery, topK) as Array<
            MemoryRow & { score: number }
          >;
        } catch (error) {
          // A FTS parse/tokenizer failure never falls back to global memory_fts.
          if (this.memoryFtsTokenizer === 'trigram') throw error;
          rankedRows = searchLiteralCandidates(this.db, cleanQuery, topK);
        }
        // unicode61 treats a continuous Han run as one token. A literal scoped
        // substring fallback preserves useful Chinese substring retrieval.
        if (this.memoryFtsTokenizer === 'unicode61' && containsHan(cleanQuery)) {
          rankedRows = searchLiteralCandidates(this.db, cleanQuery, topK);
        }
      } else {
        rankedRows = searchLiteralCandidates(this.db, cleanQuery, topK);
      }
      return applyCharacterBudget(rankedRows, topK, charBudget);
    });
    return search();
  }

  getSkill(id: string): Skill | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
      | SkillRow
      | undefined;
    return row ? mapSkill(row) : null;
  }

  listSkills(status?: Skill['status']): Skill[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM skills WHERE status = ? ORDER BY name, id')
          .all(status) as SkillRow[])
      : (this.db.prepare('SELECT * FROM skills ORDER BY name, id').all() as SkillRow[]);
    return rows.map(mapSkill);
  }

  /** Save the current Skill and an immutable snapshot in one SQLite transaction. */
  saveSkill(value: Skill): void {
    const save = this.db.transaction(() => {
      const previous = this.getSkill(value.id);
      const currentContentChanged = previous !== null && !sameSkillContent(previous, value);
      const storedVersion = this.db
        .prepare('SELECT * FROM skill_revisions WHERE skill_id = ? AND version = ?')
        .get(value.id, value.version) as SkillRevisionRow | undefined;
      if (storedVersion && !sameRevisionContent(storedVersion, value)) {
        throw new Error(
          `Skill version ${value.version} already has a different immutable revision`,
        );
      }
      if (previous?.version === value.version && currentContentChanged && !storedVersion) {
        throw new Error('Skill content changed without a version update');
      }

      this.db
        .prepare(
          `INSERT INTO skills
            (id, name, description, instructions, version, tags_json, status, created_at, updated_at)
           VALUES (@id, @name, @description, @instructions, @version, @tagsJson,
                   @status, @createdAt, @updatedAt)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, description=excluded.description,
             instructions=excluded.instructions, version=excluded.version,
             tags_json=excluded.tags_json, status=excluded.status,
             updated_at=excluded.updated_at`,
        )
        .run({
          ...value,
          tagsJson: JSON.stringify(value.tags),
        });

      if (!storedVersion) {
        const revision = this.db
          .prepare(
            'SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision FROM skill_revisions WHERE skill_id = ?',
          )
          .get(value.id) as { next_revision: number };
        this.db
          .prepare(
            `INSERT INTO skill_revisions
              (id, skill_id, revision, version, name, description, instructions, tags_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `${value.id}:r${revision.next_revision}:${randomUUID()}`,
            value.id,
            revision.next_revision,
            value.version,
            value.name,
            value.description,
            value.instructions,
            JSON.stringify(value.tags),
            value.updatedAt,
          );
      }
    });
    save();
  }

  getSkillRevision(skillId: string, revision: number): SkillRevision | null {
    const row = this.db
      .prepare('SELECT * FROM skill_revisions WHERE skill_id = ? AND revision = ?')
      .get(skillId, revision) as SkillRevisionRow | undefined;
    return row ? mapSkillRevision(row) : null;
  }

  listSkillRevisions(skillId: string): SkillRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY revision')
      .all(skillId) as SkillRevisionRow[];
    return rows.map(mapSkillRevision);
  }

  assignSkill(teammateId: string, skillId: string): void {
    const skill = this.getSkill(skillId);
    if (!skill || skill.status !== 'ACTIVE') {
      throw new Error('Only an active Skill can be assigned');
    }
    this.db
      .prepare(
        `INSERT INTO teammate_skills (teammate_id, skill_id, enabled)
         VALUES (?, ?, 1) ON CONFLICT(teammate_id, skill_id) DO NOTHING`,
      )
      .run(teammateId, skillId);
  }

  unassignSkill(teammateId: string, skillId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM teammate_skills WHERE teammate_id = ? AND skill_id = ?')
        .run(teammateId, skillId).changes > 0
    );
  }

  setSkillEnabled(teammateId: string, skillId: string, enabled: boolean): boolean {
    return (
      this.db
        .prepare('UPDATE teammate_skills SET enabled = ? WHERE teammate_id = ? AND skill_id = ?')
        .run(enabled ? 1 : 0, teammateId, skillId).changes > 0
    );
  }

  listSkillAssignments(teammateId: string): SkillAssignment[] {
    const rows = this.db
      .prepare(
        `SELECT teammate_id, skill_id, enabled FROM teammate_skills
         WHERE teammate_id = ? ORDER BY skill_id`,
      )
      .all(teammateId) as SkillAssignmentRow[];
    return rows.map((row) => ({
      teammateId: row.teammate_id,
      skillId: row.skill_id,
      enabled: row.enabled === 1,
    }));
  }

  listEnabledSkills(teammateId: string): Skill[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM teammate_skills AS ts
         JOIN skills AS s ON s.id = ts.skill_id
         WHERE ts.teammate_id = ? AND ts.enabled = 1 AND s.status = 'ACTIVE'
         ORDER BY s.name, s.id`,
      )
      .all(teammateId) as SkillRow[];
    return rows.map(mapSkill);
  }

  private ensureMemorySearchTables(): void {
    if (this.memoryFtsTokenizer !== null) return;
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS gate2_memory_candidates (
        id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
        memory_type TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL,
        source_type TEXT NOT NULL, source_id TEXT, importance REAL NOT NULL,
        confidence REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, expires_at TEXT, source_conversation_id TEXT,
        source_message_id TEXT, confirmed_at TEXT
      );
    `);
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS temp.gate2_memory_fts
         USING fts5(memory_id UNINDEXED, content, summary, tokenize='trigram')`,
      );
      this.memoryFtsTokenizer = 'trigram';
    } catch {
      // Keep a scoped FTS5 index on older SQLite builds without the trigram tokenizer.
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS temp.gate2_memory_fts
         USING fts5(memory_id UNINDEXED, content, summary, tokenize='unicode61')`,
      );
      this.memoryFtsTokenizer = 'unicode61';
    }
  }
}

function searchLiteralCandidates(
  db: Database.Database,
  query: string,
  limit: number,
): Array<MemoryRow & { score: number }> {
  return db
    .prepare(
      `SELECT c.*,
        (0.65 + 0.20 * (1.0 / (1.0 + max(0.0, julianday('now') - julianday(c.created_at)) / 30.0))
         + 0.15 * c.importance) AS score
       FROM temp.gate2_memory_candidates AS c
       WHERE instr(lower(c.content || ' ' || c.summary), lower(?)) > 0
       ORDER BY score DESC, c.created_at DESC, c.id
       LIMIT ?`,
    )
    .all(query, limit) as Array<MemoryRow & { score: number }>;
}

function applyCharacterBudget(
  rows: Array<MemoryRow & { score: number }>,
  topK: number,
  maxChars: number,
): MemorySearchResult[] {
  const result: MemorySearchResult[] = [];
  let remaining = maxChars;
  for (const row of rows.slice(0, topK)) {
    if (remaining <= 0) break;
    const summary = row.summary.slice(0, remaining);
    remaining -= summary.length;
    const content = row.content.slice(0, remaining);
    remaining -= content.length;
    if (summary.length === 0 && content.length === 0) continue;
    result.push({ ...mapMemory(row), summary, content, score: row.score });
  }
  return result;
}

function normalizeSearchInput(query: string): string {
  return Array.from(
    query
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex -- Remove control characters before composing a literal FTS phrase.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, SEARCH_INPUT_MAX_CODEPOINTS)
    .join('');
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteUnicode61Query(value: string): string {
  const safeTokens = value.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (safeTokens.length === 0) return quoteFtsPhrase(value);
  return safeTokens
    .slice(0, 24)
    .map((token) => quoteFtsPhrase(token))
    .join(' AND ');
}

function containsHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    memoryType: row.memory_type,
    content: row.content,
    summary: row.summary,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceConversationId: row.source_conversation_id,
    sourceMessageId: row.source_message_id,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
  };
}

function mapSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    version: row.version,
    tags: JSON.parse(row.tags_json) as string[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSkillRevision(row: SkillRevisionRow): SkillRevision {
  return {
    id: row.id,
    skillId: row.skill_id,
    revision: row.revision,
    version: row.version,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    tags: JSON.parse(row.tags_json) as string[],
    createdAt: row.created_at,
  };
}

function sameSkillContent(left: Skill, right: Skill): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.instructions === right.instructions &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags)
  );
}

function sameRevisionContent(row: SkillRevisionRow, skill: Skill): boolean {
  return (
    row.name === skill.name &&
    row.description === skill.description &&
    row.instructions === skill.instructions &&
    JSON.stringify(JSON.parse(row.tags_json) as string[]) === JSON.stringify(skill.tags)
  );
}
