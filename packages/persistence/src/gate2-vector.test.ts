import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  Gate2SqliteRepository,
  Gate2VectorRepository,
  migrations,
  runMigrations,
  SCOPED_VECTOR_QUERY,
} from './index.js';

describe('sqlite-vec scoped retrieval', () => {
  it('loads the local extension and scores only ACTIVE rows of the requested Teammate', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, migrations);
      db.loadExtension(join(process.cwd(), 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'));
      expect(
        (db.prepare('SELECT vec_version() AS version').get() as { version: string }).version,
      ).toBe('v0.1.9');
      db.prepare(
        "INSERT INTO providers (id, name, kind, created_at, updated_at) VALUES ('p', 'P', 'OPENAI', 'now', 'now')",
      ).run();
      db.prepare(
        "INSERT INTO runtime_profiles (id, name, provider_id, model_id, created_at, updated_at) VALUES ('embedding-runtime', 'Embeddings', 'p', 'embedding-model', 'now', 'now')",
      ).run();
      const memories = new Gate2SqliteRepository(db);
      const timestamp = '2026-09-20T00:00:00.000Z';
      for (const [id, ownerId, status] of [
        ['a-active', 'a', 'ACTIVE'],
        ['a-rejected', 'a', 'REJECTED'],
        ['b-active', 'b', 'ACTIVE'],
      ] as const) {
        memories.saveMemory({
          id,
          ownerType: 'TEAMMATE',
          ownerId,
          memoryType: 'FACT',
          content: `Private ${id}`,
          summary: id,
          sourceType: 'MANUAL',
          sourceId: null,
          sourceConversationId: null,
          sourceMessageId: null,
          importance: 0.8,
          confidence: 1,
          status,
          createdAt: timestamp,
          updatedAt: timestamp,
          confirmedAt: status === 'ACTIVE' ? timestamp : null,
          expiresAt: null,
        });
      }
      const vectors = new Gate2VectorRepository(db, true);
      for (const [memoryId, vector] of [
        ['a-active', [1, 0]],
        ['a-rejected', [1, 0]],
        ['b-active', [1, 0]],
      ] as const) {
        vectors.saveEmbedding({
          memoryId,
          runtimeProfileId: 'embedding-runtime',
          modelId: 'embedding-model',
          contentHash: 'hash',
          vector,
        });
      }
      expect(vectors.hasScopedEmbeddings('a', 'embedding-runtime', 'embedding-model')).toBe(true);
      expect(
        vectors.searchScoped({
          teammateId: 'a',
          runtimeProfileId: 'embedding-runtime',
          modelId: 'embedding-model',
          vector: [1, 0],
          limit: 20,
        }),
      ).toEqual([{ memoryId: 'a-active', distance: 0 }]);
      expect(
        vectors
          .searchScoped({
            teammateId: 'b',
            runtimeProfileId: 'embedding-runtime',
            modelId: 'embedding-model',
            vector: [1, 0],
            limit: 20,
          })
          .map((row) => row.memoryId),
      ).toEqual(['b-active']);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${SCOPED_VECTOR_QUERY}`)
        .all(
          'a',
          new Date().toISOString(),
          Buffer.from(new Float32Array([1, 0]).buffer),
          'embedding-runtime',
          'embedding-model',
          2,
          6,
        ) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(' ')).toContain('memories_owner_scope_idx');
      expect(SCOPED_VECTOR_QUERY.indexOf('WITH scoped AS MATERIALIZED')).toBeLessThan(
        SCOPED_VECTOR_QUERY.indexOf('vec_distance_cosine'),
      );
    } finally {
      db.close();
    }
  });
});
