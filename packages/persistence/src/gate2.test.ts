import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { MemoryRecord, Skill } from '../../domain/src/index.js';
import {
  Gate2SqliteRepository,
  MEMORY_FTS_SEARCH_QUERY,
  MEMORY_SCOPE_QUERY,
  migrations,
  runMigrations,
} from './index.js';

function openTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function memory(
  overrides: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'ownerId'>,
): MemoryRecord {
  return {
    id: overrides.id,
    ownerType: overrides.ownerType ?? 'TEAMMATE',
    ownerId: overrides.ownerId,
    memoryType: overrides.memoryType ?? 'FACT',
    content: overrides.content ?? 'A useful memory about alpha OR beta.',
    summary: overrides.summary ?? 'short summary',
    sourceType: overrides.sourceType ?? 'CONVERSATION',
    sourceId: overrides.sourceId ?? null,
    sourceConversationId: overrides.sourceConversationId ?? null,
    sourceMessageId: overrides.sourceMessageId ?? null,
    importance: overrides.importance ?? 0.5,
    confidence: overrides.confidence ?? 0.9,
    status: overrides.status ?? 'ACTIVE',
    createdAt: overrides.createdAt ?? '2026-09-20T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-09-20T00:00:00.000Z',
    expiresAt: overrides.expiresAt ?? null,
    confirmedAt: overrides.confirmedAt ?? null,
  };
}

function skill(overrides: Partial<Skill> & Pick<Skill, 'id'>): Skill {
  return {
    id: overrides.id,
    name: overrides.name ?? 'Clear summaries',
    description: overrides.description ?? 'Write concise useful summaries.',
    instructions: overrides.instructions ?? 'Start with the main point.',
    version: overrides.version ?? '1.0.0',
    tags: overrides.tags ?? ['writing'],
    status: overrides.status ?? 'ACTIVE',
    createdAt: overrides.createdAt ?? '2026-09-20T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-09-20T00:00:00.000Z',
  };
}

function createTeammate(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO teammates (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    id,
    id,
    'now',
    'now',
  );
}

describe('Gate2SqliteRepository Memory', () => {
  it('stores complete provenance and round-trips all lifecycle fields', () => {
    const db = openTestDatabase();
    try {
      db.prepare(
        'INSERT INTO teammates (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run('teammate-1', 'One', 'now', 'now');
      db.prepare(
        'INSERT INTO conversations (id, teammate_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run('conversation-1', 'teammate-1', 'now', 'now');
      db.prepare(
        `INSERT INTO messages
          (id, mission_id, conversation_id, teammate_id, actor_type, actor_id, role, content, created_at)
         VALUES (?, NULL, ?, ?, 'USER', ?, 'USER', ?, ?)`,
      ).run('message-1', 'conversation-1', 'teammate-1', 'user-1', 'I prefer examples.', 'now');

      const repository = new Gate2SqliteRepository(db);
      const record = memory({
        id: 'memory-1',
        ownerId: 'teammate-1',
        memoryType: 'PREFERENCE',
        content: 'The user prefers examples.',
        summary: 'Prefers examples',
        sourceId: 'message-1',
        sourceConversationId: 'conversation-1',
        sourceMessageId: 'message-1',
        status: 'PROPOSED',
      });
      repository.saveMemory(record);
      expect(repository.getMemory(record.id)).toEqual(record);
      expect(repository.listMemories('TEAMMATE', 'teammate-1', 'PROPOSED')).toEqual([record]);

      const accepted = {
        ...record,
        status: 'ACTIVE' as const,
        confirmedAt: '2026-09-21T00:00:00.000Z',
      };
      repository.saveMemory(accepted);
      expect(repository.getMemory(record.id)).toEqual(accepted);
      expect(repository.listMemories('TEAMMATE', 'other-team')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('filters by owner/status before creating a scope-only FTS index and never leaks between Teammates', () => {
    const db = openTestDatabase();
    try {
      const repository = new Gate2SqliteRepository(db);
      repository.saveMemory(memory({ id: 'one-active', ownerId: 'teammate-one' }));
      repository.saveMemory(
        memory({ id: 'two-active', ownerId: 'teammate-two', content: 'A private beta secret.' }),
      );
      repository.saveMemory(
        memory({ id: 'one-proposed', ownerId: 'teammate-one', status: 'PROPOSED' }),
      );
      repository.saveMemory(
        memory({ id: 'one-rejected', ownerId: 'teammate-one', status: 'REJECTED' }),
      );
      repository.saveMemory(
        memory({
          id: 'one-expired',
          ownerId: 'teammate-one',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      );

      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${MEMORY_SCOPE_QUERY}`)
        .all('TEAMMATE', 'teammate-one', new Date().toISOString()) as Array<{ detail: string }>;
      expect(plan.map((item) => item.detail).join(' ')).toContain('memories_owner_scope_idx');
      expect(MEMORY_SCOPE_QUERY).not.toContain('memory_fts');
      expect(MEMORY_FTS_SEARCH_QUERY).toContain('JOIN temp.gate2_memory_candidates');
      expect(MEMORY_FTS_SEARCH_QUERY).not.toContain('FROM memory_fts');
      repository.searchActiveMemories('TEAMMATE', 'bootstrap', 'no match');
      db.exec(`
        CREATE TEMP TRIGGER gate2_scope_guard
        BEFORE INSERT ON gate2_memory_candidates
        WHEN NEW.owner_type <> 'TEAMMATE'
          OR NEW.owner_id <> 'teammate-one'
          OR NEW.status <> 'ACTIVE'
        BEGIN
          SELECT RAISE(ABORT, 'memory escaped owner/status scope');
        END;
      `);
      const firstTeammate = repository.searchActiveMemories(
        'TEAMMATE',
        'teammate-one',
        'alpha OR beta',
      );
      expect(firstTeammate.map((item) => item.id)).toEqual(['one-active']);
      db.exec('DROP TRIGGER gate2_scope_guard');
      const ftsPlan = db
        .prepare(`EXPLAIN QUERY PLAN ${MEMORY_FTS_SEARCH_QUERY}`)
        .all('"alpha OR beta"', 5) as Array<{ detail: string }>;
      expect(ftsPlan.map((item) => item.detail).join(' ')).toContain('VIRTUAL TABLE INDEX');

      const secondTeammate = repository.searchActiveMemories(
        'TEAMMATE',
        'teammate-two',
        'private beta',
      );
      expect(secondTeammate.map((item) => item.id)).toEqual(['two-active']);
      expect(repository.searchActiveMemories('TEAMMATE', 'teammate-one', 'private beta')).toEqual(
        [],
      );
      expect(
        repository.searchActiveMemories('TEAMMATE', 'teammate-one', 'alpha', 100, 20),
      ).toHaveLength(1);
      const bounded = repository.searchActiveMemories('TEAMMATE', 'teammate-one', 'alpha', 100, 20);
      expect(bounded.length).toBeLessThanOrEqual(20);
      expect(
        bounded.reduce((sum, item) => sum + item.content.length + item.summary.length, 0),
      ).toBe(20);
    } finally {
      db.close();
    }
  });

  it('matches Chinese substrings with the scoped trigram index', () => {
    const db = openTestDatabase();
    try {
      const repository = new Gate2SqliteRepository(db);
      repository.saveMemory(
        memory({
          id: 'han-memory',
          ownerId: 'teammate-han',
          content: '天气变化时，请优先提醒我带伞。',
          summary: '出门前提醒带伞',
        }),
      );
      expect(
        repository
          .searchActiveMemories('TEAMMATE', 'teammate-han', '天气变化')
          .map((item) => item.id),
      ).toEqual(['han-memory']);
    } finally {
      db.close();
    }
  });
});

describe('Gate2SqliteRepository Skill', () => {
  it('saves immutable version snapshots and manages per-Teammate assignment state', () => {
    const db = openTestDatabase();
    try {
      createTeammate(db, 'teammate-1');
      const repository = new Gate2SqliteRepository(db);
      repository.saveSkill(skill({ id: 'skill-1' }));
      expect(repository.listSkillRevisions('skill-1')).toHaveLength(1);

      const v101 = skill({
        id: 'skill-1',
        name: 'Clear summaries v1.0.1',
        version: '1.0.1',
        instructions: 'Start with the main point, then give one example.',
        updatedAt: '2026-09-21T00:00:00.000Z',
      });
      repository.saveSkill(v101);
      expect(repository.listSkillRevisions('skill-1')).toEqual([
        expect.objectContaining({
          revision: 1,
          version: '1.0.0',
          instructions: 'Start with the main point.',
        }),
        expect.objectContaining({ revision: 2, version: '1.0.1', instructions: v101.instructions }),
      ]);
      expect(() =>
        db
          .prepare("UPDATE skill_revisions SET instructions = 'tampered' WHERE skill_id = ?")
          .run('skill-1'),
      ).toThrow(/immutable/);
      expect(() =>
        db.prepare('DELETE FROM skill_revisions WHERE skill_id = ?').run('skill-1'),
      ).toThrow(/immutable/);
      expect(() =>
        repository.saveSkill({ ...v101, instructions: 'Edited without a version bump.' }),
      ).toThrow(/immutable revision/);

      repository.assignSkill('teammate-1', 'skill-1');
      repository.assignSkill('teammate-1', 'skill-1');
      expect(repository.listEnabledSkills('teammate-1')).toEqual([v101]);
      expect(repository.setSkillEnabled('teammate-1', 'skill-1', false)).toBe(true);
      expect(repository.listSkillAssignments('teammate-1')).toEqual([
        { teammateId: 'teammate-1', skillId: 'skill-1', enabled: false },
      ]);
      expect(repository.listEnabledSkills('teammate-1')).toEqual([]);
      expect(repository.setSkillEnabled('teammate-1', 'skill-1', true)).toBe(true);
      expect(repository.listEnabledSkills('teammate-1')).toEqual([v101]);
      expect(repository.unassignSkill('teammate-1', 'skill-1')).toBe(true);
      expect(repository.unassignSkill('teammate-1', 'skill-1')).toBe(false);
      expect(repository.listSkillAssignments('teammate-1')).toEqual([]);

      repository.saveSkill({ ...v101, status: 'ARCHIVED', updatedAt: '2026-09-22T00:00:00.000Z' });
      expect(repository.getSkill('skill-1')?.status).toBe('ARCHIVED');
      expect(repository.listSkillRevisions('skill-1')).toHaveLength(2);
      expect(() => repository.assignSkill('teammate-1', 'skill-1')).toThrow(/active Skill/);
    } finally {
      db.close();
    }
  });

  it('backfills a revision snapshot for Skills created before migration 0003', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, [migrations[0]!, migrations[1]!]);
      db.prepare(
        `INSERT INTO skills (id, name, description, instructions, version, created_at, updated_at)
         VALUES ('legacy-skill', 'Legacy', 'Imported', 'Use clear steps.', '1.0.0', 'created', 'updated')`,
      ).run();
      runMigrations(db, migrations);
      const repository = new Gate2SqliteRepository(db);
      expect(repository.listSkillRevisions('legacy-skill')).toEqual([
        expect.objectContaining({
          skillId: 'legacy-skill',
          revision: 1,
          version: '1.0.0',
          instructions: 'Use clear steps.',
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
